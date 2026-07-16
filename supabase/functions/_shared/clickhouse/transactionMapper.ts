import { convertAmountToUsd } from "./currencyNormalization.ts";
import { declineDetailsForTransaction } from "./paymentFailures.ts";
import { cardTypeForUserTransactions, cardTypeFromTransaction } from "./userCardType.ts";
import { countryCodeForUserTransactions, countryCodeFromTransaction } from "./userCountry.ts";
import { mediaBuyerForUserTransactions, utmSourceFromTransaction } from "./userMediaBuyer.ts";
import { isTokenPurchaseTransaction, productIdForTransaction } from "./monetization.ts";
import type { CardType, MediaBuyer, Transaction } from "./serviceTypes.ts";

export type SupabaseTransactionRow = {
  id?: string | null;
  auth_user_id?: string | null;
  user_id?: string | null;
  transaction_id: string;
  external_transaction_id?: string | null;
  import_batch_id?: string | null;
  source?: string | null;
  event_time: string;
  status?: string | null;
  transaction_type?: string | null;
  amount_gross?: number | string | null;
  amount_net?: number | string | null;
  amount_refunded?: number | string | null;
  currency?: string | null;
  email?: string | null;
  country_code?: string | null;
  campaign_path?: string | null;
  funnel?: string | null;
  source_name?: string | null;
  raw_payload?: Record<string, unknown> | null;
  normalized_payload?: Record<string, unknown> | null;
  created_at?: string | null;
  updated_at?: string | null;
  deleted_at?: string | null;
};

export type ClickHouseTransactionRow = {
  auth_user_id: string;
  transaction_id: string;
  user_id: string;
  normalized_email: string;
  event_time: string;
  transaction_date: string;
  cohort_date: string;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  utm_source: string;
  media_buyer: MediaBuyer;
  country_code: string;
  card_type: CardType;
  status: string;
  transaction_type: string;
  payment_stage: string;
  subscription_level: number;
  currency: string;
  original_amount: number;
  gross_amount_usd: number;
  net_amount_usd: number;
  refund_amount_usd: number;
  is_success: 0 | 1;
  is_failed: 0 | 1;
  is_refund: 0 | 1;
  is_chargeback: 0 | 1;
  is_trial: 0 | 1;
  is_first_subscription: 0 | 1;
  is_renewal: 0 | 1;
  is_upsell: 0 | 1;
  is_token_purchase: 0 | 1;
  upsell_ordinal: number;
  decline_reason: string;
  processor: string;
  product_id: string;
  product_name: string;
  billing_reason: string;
  import_batch_id: string;
  source: string;
  raw_payload: string;
  normalized_payload: string;
  source_created_at: string | null;
  source_updated_at: string | null;
  clickhouse_synced_at: string;
  row_version: string;
  amount_usd: number;
  fx_status: string;
  classification_reason: string;
};

export interface MapperDiagnostics {
  mapped_rows: number;
  malformed_rows: number;
  missing_user_identity: number;
  missing_campaign_id: number;
  missing_currency: number;
  missing_fx_rate: number;
  unknown_transaction_type: number;
  unknown_monetization_product: number;
  skipped: Array<{ transaction_id_hash: string; reason: string }>;
}

export interface TransactionMappingContext {
  firstTrialByUser: Map<string, Transaction>;
  userTransactions: Map<string, Transaction[]>;
  upsellOrdinalByTransactionId: Map<string, number>;
}

const VALID_TYPES = new Set([
  "trial",
  "upsell",
  "first_subscription",
  "renewal_2",
  "renewal_3",
  "renewal",
  "token_purchase",
  "failed_payment",
  "refund",
  "chargeback",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateOrNull(value: unknown): Date | null {
  const date = new Date(String(value ?? ""));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKey(value: unknown): string {
  const date = dateOrNull(value);
  return date ? date.toISOString().slice(0, 10) : "1970-01-01";
}

function dateTimeKey(value: unknown): string {
  const date = dateOrNull(value);
  return date ? date.toISOString().replace("Z", "") : "1970-01-01T00:00:00.000";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function hash64(value: string): string {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString();
}

export function deterministicRowVersion(row: Pick<SupabaseTransactionRow, "transaction_id" | "updated_at" | "event_time">): string {
  return hash64(`${row.updated_at ?? ""}|${row.event_time ?? ""}|${row.transaction_id ?? ""}`);
}

function subscriptionLevel(type: string): number {
  if (type === "first_subscription") return 1;
  if (type === "renewal_2") return 2;
  if (type === "renewal_3") return 3;
  if (type === "renewal") return 4;
  return 0;
}

function paymentStage(type: string): string {
  if (type === "trial") return "trial";
  if (type === "first_subscription") return "first_subscription";
  if (type === "renewal_2" || type === "renewal_3" || type === "renewal") return "renewal";
  if (type === "upsell") return "upsell";
  if (type === "token_purchase") return "token_purchase";
  if (type === "failed_payment") return "failed_payment";
  if (type === "refund") return "refund";
  if (type === "chargeback") return "chargeback";
  return "unknown";
}

function normalizedEmail(value: unknown): string {
  return text(value).toLowerCase();
}

function processorFrom(tx: Transaction, row: SupabaseTransactionRow): string {
  return (
    text(tx.raw?.processor) ||
    text(tx.metadata?.processor) ||
    text(row.raw_payload?.processor) ||
    text(row.normalized_payload?.processor)
  );
}

function toTransaction(row: SupabaseTransactionRow): Transaction | null {
  const payload = isRecord(row.normalized_payload) ? row.normalized_payload : {};
  const transactionId = text(payload.transaction_id) || text(row.transaction_id);
  const eventTime = text(payload.event_time) || text(row.event_time);
  if (!transactionId || !dateOrNull(eventTime)) return null;

  const gross = num(payload.gross_amount_usd ?? payload.amount_usd ?? row.amount_gross);
  const refund = num(payload.refund_amount_usd ?? row.amount_refunded);
  const net = payload.net_amount_usd != null ? num(payload.net_amount_usd) : num(row.amount_net ?? gross - refund);
  return {
    transaction_id: transactionId,
    user_id: text(payload.user_id) || text(row.user_id) || normalizedEmail(payload.email ?? row.email) || transactionId,
    email: text(payload.email) || text(row.email),
    event_time: eventTime,
    amount_usd: num(payload.amount_usd ?? gross),
    gross_amount_usd: gross,
    refund_amount_usd: refund,
    net_amount_usd: net,
    is_refunded: Boolean(payload.is_refunded ?? refund > 0),
    currency: text(payload.currency) || text(row.currency),
    status: (text(payload.status) || text(row.status) || "failed") as Transaction["status"],
    transaction_type: (text(payload.transaction_type) || text(row.transaction_type) || "unknown") as Transaction["transaction_type"],
    funnel: (text(payload.funnel) || text(row.funnel) || "unknown") as Transaction["funnel"],
    campaign_path: text(payload.campaign_path) || text(row.campaign_path) || "unknown",
    product: text(payload.product),
    traffic_source: (text(payload.traffic_source) || text(row.source_name) || "unknown") as Transaction["traffic_source"],
    campaign_id: text(payload.campaign_id),
    utm_source: text(payload.utm_source) || null,
    classification_reason: text(payload.classification_reason),
    billing_reason: text(payload.billing_reason),
    cohort_date: text(payload.cohort_date) || undefined,
    cohort_id: text(payload.cohort_id) || undefined,
    transaction_day: typeof payload.transaction_day === "number" ? payload.transaction_day : null,
    card_type: payload.card_type as Transaction["card_type"],
    normalized_decline_reason: payload.normalized_decline_reason as Transaction["normalized_decline_reason"],
    decline_message: text(payload.decline_message) || null,
    metadata: isRecord(payload.metadata) ? payload.metadata : undefined,
    raw: {
      ...(isRecord(payload.raw) ? payload.raw : {}),
      ...(isRecord(row.raw_payload) ? row.raw_payload : {}),
    },
    fx_status: payload.fx_status as Transaction["fx_status"],
    fx_rate: typeof payload.fx_rate === "number" ? payload.fx_rate : null,
    original_currency: text(payload.original_currency) || null,
    original_gross_amount: typeof payload.original_gross_amount === "number" ? payload.original_gross_amount : undefined,
  };
}

export function createMapperDiagnostics(): MapperDiagnostics {
  return {
    mapped_rows: 0,
    malformed_rows: 0,
    missing_user_identity: 0,
    missing_campaign_id: 0,
    missing_currency: 0,
    missing_fx_rate: 0,
    unknown_transaction_type: 0,
    unknown_monetization_product: 0,
    skipped: [],
  };
}

export function buildTransactionMappingContext(txs: Transaction[]): TransactionMappingContext {
  const userTransactions = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const key = tx.user_id || normalizedEmail(tx.email) || tx.transaction_id;
    const list = userTransactions.get(key) ?? [];
    list.push(tx);
    userTransactions.set(key, list);
  }

  const firstTrialByUser = new Map<string, Transaction>();
  const upsellOrdinalByTransactionId = new Map<string, number>();
  userTransactions.forEach((list, userId) => {
    const sorted = [...list].sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : a.transaction_id.localeCompare(b.transaction_id)));
    const firstTrial = sorted.find((tx) => tx.status === "success" && tx.transaction_type === "trial");
    if (firstTrial) firstTrialByUser.set(userId, firstTrial);
    let upsellOrdinal = 0;
    for (const tx of sorted) {
      if (tx.status === "success" && tx.transaction_type === "upsell") {
        upsellOrdinal += 1;
        upsellOrdinalByTransactionId.set(tx.transaction_id, upsellOrdinal);
      }
    }
  });

  return { firstTrialByUser, userTransactions, upsellOrdinalByTransactionId };
}

export function hydrateSupabaseTransactionRows(rows: SupabaseTransactionRow[]): Transaction[] {
  return rows.map(toTransaction).filter((tx): tx is Transaction => Boolean(tx));
}

export function mapSupabaseTransactionToClickHouse(input: {
  authUserId: string;
  row: SupabaseTransactionRow;
  context?: TransactionMappingContext;
  syncedAt?: string;
  diagnostics?: MapperDiagnostics;
}): ClickHouseTransactionRow | null {
  const diagnostics = input.diagnostics ?? createMapperDiagnostics();
  const tx = toTransaction(input.row);
  if (!tx) {
    diagnostics.malformed_rows += 1;
    diagnostics.skipped.push({ transaction_id_hash: hash64(text(input.row.transaction_id)), reason: "Malformed transaction row" });
    return null;
  }

  const userKey = tx.user_id || normalizedEmail(tx.email) || tx.transaction_id;
  const userTxs = input.context?.userTransactions.get(userKey) ?? [tx];
  const firstTrial = input.context?.firstTrialByUser.get(userKey);
  const conversion = tx.fx_status
    ? {
        original_amount: tx.original_gross_amount ?? tx.gross_amount_usd ?? tx.amount_usd,
        original_currency: tx.original_currency ?? tx.currency ?? null,
        amount_usd: tx.gross_amount_usd ?? tx.amount_usd,
        conversion_status: tx.fx_status,
      }
    : convertAmountToUsd(tx.gross_amount_usd ?? tx.amount_usd, tx.currency);
  const grossUsd = conversion.amount_usd ?? 0;
  const rate = tx.fx_status ? tx.fx_rate ?? null : convertAmountToUsd(1, tx.currency).fx_rate;
  const convertMoney = (value: number) => conversion.amount_usd == null || rate == null ? 0 : Math.round(value * rate * 1000000) / 1000000;
  // amount_usd mirrors the client's post-FX `amount_usd` (plan-price bucketing):
  // native_usd → raw amount; converted → round2(amount * rate) with JS Math.round
  // (half-up), matching convertAmountToUsd. fx_status is the conversion status;
  // classification_reason is the source rule label (auto-cancel input). Additive
  // ClickHouse columns for cohort parity — no existing business field is changed.
  const amountUsdValue = conversion.conversion_status === "native_usd"
    ? Number(tx.amount_usd ?? tx.gross_amount_usd ?? 0)
    : rate == null ? 0 : Math.round(Number(tx.amount_usd ?? 0) * rate * 100) / 100;
  const transactionType = VALID_TYPES.has(tx.transaction_type) ? tx.transaction_type : "unknown";
  const decline = declineDetailsForTransaction(tx);
  const productId = productIdForTransaction(tx);
  const campaignId = tx.campaign_id || text(tx.metadata?.utm_campaign) || text(tx.raw?.utm_campaign);
  const country = input.row.country_code || countryCodeFromTransaction(tx) || countryCodeForUserTransactions(userTxs) || "";
  const cardType = cardTypeFromTransaction(tx) ?? cardTypeForUserTransactions(userTxs);
  const media = mediaBuyerForUserTransactions(userTxs);

  if (!tx.user_id && !tx.email) diagnostics.missing_user_identity += 1;
  if (!campaignId) diagnostics.missing_campaign_id += 1;
  if (!tx.currency) diagnostics.missing_currency += 1;
  if (conversion.conversion_status === "missing_fx_rate") diagnostics.missing_fx_rate += 1;
  if (transactionType === "unknown") diagnostics.unknown_transaction_type += 1;
  if (tx.status === "success" && tx.transaction_type === "unknown" && !isTokenPurchaseTransaction(tx) && !productId) {
    diagnostics.unknown_monetization_product += 1;
  }

  diagnostics.mapped_rows += 1;
  const sourceGross = tx.gross_amount_usd ?? tx.amount_usd;
  const refund = tx.refund_amount_usd ?? 0;
  const net = tx.net_amount_usd ?? sourceGross - refund;
  const cohortDate = tx.cohort_date || firstTrial?.event_time.slice(0, 10) || (tx.transaction_type === "trial" ? tx.event_time.slice(0, 10) : dateKey(tx.event_time));
  const rawPayload = input.row.raw_payload ?? tx.raw ?? {};
  const normalizedPayload = input.row.normalized_payload ?? tx;

  return {
    auth_user_id: input.authUserId,
    transaction_id: tx.transaction_id,
    user_id: tx.user_id || normalizedEmail(tx.email) || tx.transaction_id,
    normalized_email: normalizedEmail(tx.email),
    event_time: dateTimeKey(tx.event_time),
    transaction_date: dateKey(tx.event_time),
    cohort_date: cohortDate,
    funnel: tx.funnel || firstTrial?.funnel || "unknown",
    campaign_path: tx.campaign_path || firstTrial?.campaign_path || "unknown",
    campaign_id: campaignId,
    utm_source: tx.utm_source ?? utmSourceFromTransaction(tx) ?? media.utm_source ?? "",
    media_buyer: media.media_buyer,
    country_code: country,
    card_type: cardType,
    status: tx.status,
    transaction_type: transactionType,
    payment_stage: paymentStage(transactionType),
    subscription_level: subscriptionLevel(transactionType),
    currency: String(conversion.original_currency ?? tx.currency ?? "").toUpperCase(),
    original_amount: conversion.original_amount,
    gross_amount_usd: grossUsd,
    net_amount_usd: convertMoney(net),
    refund_amount_usd: convertMoney(refund),
    is_success: tx.status === "success" ? 1 : 0,
    is_failed: tx.status === "failed" || transactionType === "failed_payment" ? 1 : 0,
    is_refund: tx.status === "refunded" || transactionType === "refund" || refund > 0 ? 1 : 0,
    is_chargeback: tx.status === "chargeback" || transactionType === "chargeback" ? 1 : 0,
    is_trial: transactionType === "trial" && tx.status === "success" ? 1 : 0,
    is_first_subscription: transactionType === "first_subscription" && tx.status === "success" ? 1 : 0,
    is_renewal: ["renewal_2", "renewal_3", "renewal"].includes(transactionType) && tx.status === "success" ? 1 : 0,
    is_upsell: transactionType === "upsell" && tx.status === "success" ? 1 : 0,
    is_token_purchase: transactionType === "token_purchase" && tx.status === "success" ? 1 : 0,
    upsell_ordinal: input.context?.upsellOrdinalByTransactionId.get(tx.transaction_id) ?? 0,
    decline_reason: decline?.reason ?? tx.normalized_decline_reason ?? "",
    processor: processorFrom(tx, input.row),
    product_id: productId ?? "",
    product_name: tx.product ?? "",
    billing_reason: tx.billing_reason ?? "",
    import_batch_id: text(input.row.import_batch_id),
    source: text(input.row.source) || "transactions",
    raw_payload: safeJson(rawPayload),
    normalized_payload: safeJson(normalizedPayload),
    source_created_at: input.row.created_at ? dateTimeKey(input.row.created_at) : null,
    source_updated_at: input.row.updated_at ? dateTimeKey(input.row.updated_at) : null,
    clickhouse_synced_at: dateTimeKey(input.syncedAt ?? new Date().toISOString()),
    row_version: deterministicRowVersion(input.row),
    amount_usd: amountUsdValue,
    fx_status: conversion.conversion_status,
    classification_reason: tx.classification_reason ?? "",
  };
}

export function mapSupabaseTransactionsToClickHouse(input: {
  authUserId: string;
  rows: SupabaseTransactionRow[];
  context?: TransactionMappingContext;
  syncedAt?: string;
}): { rows: ClickHouseTransactionRow[]; diagnostics: MapperDiagnostics } {
  const diagnostics = createMapperDiagnostics();
  const txs = hydrateSupabaseTransactionRows(input.rows);
  const context = input.context ?? buildTransactionMappingContext(txs);
  const mapped = input.rows
    .map((row) => mapSupabaseTransactionToClickHouse({ ...input, row, context, diagnostics }))
    .filter((row): row is ClickHouseTransactionRow => Boolean(row));
  return { rows: mapped, diagnostics };
}
