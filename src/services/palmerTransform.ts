import type {
  Funnel,
  TrafficSource,
  Transaction,
  TransactionStatus,
  TransactionType,
} from "./types";

export type RawPalmerRow = Record<string, unknown>;

export interface PalmerMetadata {
  ff_funnel_id?: string;
  ff_campaign_path?: string;
  ff_billing_reason?: string;
  initialUrl?: string;
  email?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_source?: string;
  [key: string]: unknown;
}

export interface PalmerImportDiagnostics {
  totalRows: number;
  rowsWithAmountUsd: number;
  successRows: number;
  trialRows: number;
  upsellRows: number;
  firstSubscriptionRows: number;
  rowsWithCohortId: number;
  unknownFunnelRows: number;
  unclassifiedSuccessfulSubscriptionRows: number;
  uniqueUserIdCount: number;
  missingEmailCount: number;
  missingCustomerIdCount: number;
  fallbackUnknownUserCount: number;
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const COMMON_UPSELL_AMOUNTS = [14.98];
const AMOUNTS = {
  trial: 1,
  upsell: 14.98,
  subscription: 29.99,
};

// Palmer exports can use slightly different header names depending on source.
// These aliases keep import tolerant without changing the normalized schema.
const FIELD_ALIASES = {
  transaction_id: ["transaction_id", "transactionid", "transaction id", "id", "payment_id", "charge_id", "order_id"],
  user_id: ["customerId", "customer_id", "customerid", "user_id", "userid", "user id", "client_id", "member_id", "account_id"],
  email: ["customerEmailAddress", "customer_email_address", "email", "user_email", "customer_email", "customer email", "customer.email", "billing_email"],
  event_time: ["event_time", "event time", "created_at", "createdat", "created", "timestamp", "paid_at", "settled_at", "date"],
  amount: ["amount", "amount_usd", "amountusd", "amount_cents", "amount in cents", "amount_in_cents", "price", "total", "gross_amount"],
  amount_refunded: ["amountRefunded", "amount_refunded", "amountrefunded", "refunded_amount", "refund_amount", "amount refunded"],
  currency: ["currency", "ccy", "currency_code"],
  status: ["status", "state", "result", "payment_status", "transaction_status"],
  product: ["product", "product_name", "product name", "plan", "sku"],
  metadata: ["metadata", "meta", "custom_fields", "custom fields", "payload"],
  campaign_id: ["campaign_id", "campaignid", "campaign id", "utm_campaign"],
  traffic_source: ["traffic_source", "traffic source", "utm_source", "source", "channel"],
} as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueFrom(row: RawPalmerRow, aliases: readonly string[]): string {
  const byKey = new Map(Object.keys(row).map((key) => [normalizeKey(key), key]));
  for (const alias of aliases) {
    const actual = byKey.get(normalizeKey(alias));
    if (actual) {
      const value = row[actual];
      if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
    }
  }
  return "";
}

function parseEventTime(raw: string): string {
  if (!raw) return new Date(0).toISOString();
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric < 1e12 ? numeric * 1000 : numeric;
    return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

function near(amount: number, target: number): boolean {
  return Math.abs(amount - target) < 0.01;
}

function between(value: number, min: number, max: number): boolean {
  return value >= min && value <= max;
}

export function normalizeAmount(raw: unknown): number {
  const source = String(raw ?? "").trim();
  const cleaned = source.replace(/[^0-9.-]/g, "");
  const amount = Number(cleaned);
  if (!Number.isFinite(amount)) return 0;
  // Palmer commonly exports integer cents, but some exports already contain
  // decimal USD values. Decimal-looking values should not be divided again.
  const normalized = cleaned.includes(".") ? amount : amount / 100;
  return Math.round(normalized * 100) / 100;
}

function normalizeRefundAmount(raw: unknown): number {
  const source = String(raw ?? "").trim();
  const cleaned = source.replace(/[^0-9.-]/g, "");
  const amountInCents = Number(cleaned);
  if (!Number.isFinite(amountInCents)) return 0;
  // Palmer `amountRefunded` is exported in cents even when transaction status
  // remains SETTLED, so refund analytics must use this field directly.
  return Math.round((amountInCents / 100) * 100) / 100;
}

export function normalizeStatus(raw: unknown): TransactionStatus {
  const value = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  // Keep Palmer payment states explicit so failed/refund/chargeback analytics
  // do not get mixed into successful subscription revenue.
  if (["SETTLED", "SUCCEEDED", "PAID", "SUCCESS", "AUTHORIZED", "OK"].includes(value)) return "success";
  if (["AUTHORIZATION_FAILED", "AUTHORIZATION_DECLINED", "DECLINED", "FAILED", "FAILURE", "ERROR"].includes(value)) return "failed";
  if (value === "REFUNDED") return "refunded";
  if (["DISPUTE", "DISPUTED", "CHARGEBACK"].includes(value)) return "chargeback";
  return "failed";
}

export function parseMetadata(rowOrMetadata: RawPalmerRow | unknown): PalmerMetadata {
  const source =
    typeof rowOrMetadata === "object" && rowOrMetadata !== null && !Array.isArray(rowOrMetadata)
      ? (rowOrMetadata as RawPalmerRow)
      : {};
  const rawMetadata =
    typeof rowOrMetadata === "string"
      ? rowOrMetadata
      : valueFrom(source, FIELD_ALIASES.metadata);

  let parsed: PalmerMetadata = {};
  if (rawMetadata) {
    try {
      const json = JSON.parse(rawMetadata);
      if (json && typeof json === "object" && !Array.isArray(json)) parsed = json as PalmerMetadata;
    } catch {
      parsed = {};
    }
  }

  const merged: PalmerMetadata = { ...parsed };
  // Direct columns win alongside JSON metadata because Palmer exports may
  // flatten marketing fields instead of nesting them under `metadata`.
  for (const key of ["ff_funnel_id", "ff_campaign_path", "ff_billing_reason", "initialUrl", "email", "utm_campaign", "utm_content", "utm_source"]) {
    const direct = valueFrom(source, [key]);
    if (direct) merged[key] = direct;
  }
  return merged;
}

function metadataString(metadata: PalmerMetadata, key: string): string {
  const value = metadata[key];
  return value == null ? "" : String(value).trim();
}

function customerIdFrom(row: RawPalmerRow): string {
  return valueFrom(row, FIELD_ALIASES.user_id);
}

function emailFrom(row: RawPalmerRow, metadata: PalmerMetadata): string {
  return valueFrom(row, FIELD_ALIASES.email) || metadataString(metadata, "email");
}

function userIdFrom(row: RawPalmerRow, metadata: PalmerMetadata, index: number): string {
  const customerId = customerIdFrom(row);
  if (customerId) return customerId;
  const email = emailFrom(row, metadata);
  if (email) return email;
  return `unknown_user_${index + 1}`;
}

function detectFunnel(metadata: PalmerMetadata): Funnel {
  const haystack = [
    metadata.ff_funnel_id,
    metadata.ff_campaign_path,
    metadata.utm_campaign,
    metadata.utm_content,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (haystack.includes("soulmate") || haystack.includes("soul_mate")) return "soulmate";
  if (haystack.includes("past_life") || haystack.includes("past-life") || haystack.includes("pastlife")) return "past_life";
  if (haystack.includes("starseed") || haystack.includes("star_seed")) return "starseed";
  // Unknown is intentional. Do not default to past_life; that would pollute cohorts.
  return "unknown";
}

function normalizeCampaignPath(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  try {
    const parsed = value.startsWith("http://") || value.startsWith("https://") ? new URL(value).pathname : value;
    const cleaned = parsed
      .replace(/^https?:\/\/[^/]+/i, "")
      .split(/[?#]/)[0]
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned || "unknown";
  } catch {
    const cleaned = value.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || "unknown";
  }
}

function detectCampaignPath(metadata: PalmerMetadata): string {
  const path = normalizeCampaignPath(metadata.ff_campaign_path);
  if (path !== "unknown") return path;
  return normalizeCampaignPath(metadata.initialUrl);
}

function detectTrafficSource(row: RawPalmerRow, metadata: PalmerMetadata): TrafficSource {
  const raw = `${valueFrom(row, FIELD_ALIASES.traffic_source)} ${metadata.utm_source ?? ""}`.toLowerCase();
  if (raw.includes("facebook") || raw === "fb" || raw.includes("meta")) return "facebook";
  if (raw.includes("tiktok") || raw.includes("tik_tok")) return "tiktok";
  if (raw.includes("google") || raw.includes("adwords")) return "google";
  return "unknown";
}

function hasUpsellBillingReason(tx: Transaction): boolean {
  return String(tx.billing_reason ?? "").toLowerCase().includes("upsell");
}

function isCommonUpsellAmount(amount: number): boolean {
  return COMMON_UPSELL_AMOUNTS.some((upsellAmount) => near(amount, upsellAmount));
}

function failedType(status: TransactionStatus): TransactionType | null {
  if (status === "failed") return "failed_payment";
  if (status === "refunded") return "refund";
  if (status === "chargeback") return "chargeback";
  return null;
}

export function normalizePalmerRows(rows: RawPalmerRow[]): Transaction[] {
  return rows.map((row, index) => {
    const metadata = parseMetadata(row);
    const status = normalizeStatus(valueFrom(row, FIELD_ALIASES.status));
    const grossAmount = Math.abs(normalizeAmount(valueFrom(row, FIELD_ALIASES.amount)));
    const refundAmount = normalizeRefundAmount(valueFrom(row, FIELD_ALIASES.amount_refunded));
    const netAmount = grossAmount - refundAmount;
    const fallbackType = failedType(status);

    return {
      transaction_id: valueFrom(row, FIELD_ALIASES.transaction_id) || `palmer-row-${index + 1}`,
      user_id: userIdFrom(row, metadata, index),
      email: emailFrom(row, metadata),
      event_time: parseEventTime(valueFrom(row, FIELD_ALIASES.event_time)),
      amount_usd: grossAmount,
      gross_amount_usd: grossAmount,
      refund_amount_usd: refundAmount,
      net_amount_usd: netAmount,
      is_refunded: refundAmount > 0,
      currency: valueFrom(row, FIELD_ALIASES.currency) || "USD",
      status,
      transaction_type: fallbackType ?? "unknown",
      funnel: detectFunnel(metadata),
      campaign_path: detectCampaignPath(metadata),
      product: valueFrom(row, FIELD_ALIASES.product) || productFromAmount(grossAmount),
      traffic_source: detectTrafficSource(row, metadata),
      campaign_id: valueFrom(row, FIELD_ALIASES.campaign_id) || String(metadata.utm_campaign ?? ""),
      billing_reason: String(metadata.ff_billing_reason ?? ""),
      classification_reason: fallbackType ? `${status} Palmer status` : "awaiting user-level classification",
    };
  });
}

export function classifyUserTransactions(rows: Transaction[]): Transaction[] {
  // Classification is user-scoped: the same amount can mean different things
  // depending on whether the user already had a trial or first subscription.
  const byUser = new Map<string, Transaction[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }

  const classified: Transaction[] = [];
  byUser.forEach((list) => {
    const sorted = [...list].sort((a, b) => new Date(a.event_time).getTime() - new Date(b.event_time).getTime());
    let trialTs: number | null = null;
    let firstSubscriptionTs: number | null = null;

    for (const tx of sorted) {
      const eventTs = new Date(tx.event_time).getTime();
      const statusType = failedType(tx.status);
      const isUpsellByMetadata = hasUpsellBillingReason(tx);
      const isUpsellByAmount = isCommonUpsellAmount(tx.amount_usd);
      let transaction_type: TransactionType = tx.transaction_type;
      let classification_reason = tx.classification_reason;

      if (statusType) {
        transaction_type = statusType;
        classification_reason = `${tx.status} Palmer status`;
      } else if (trialTs === null && isUpsellByMetadata) {
        transaction_type = "upsell";
        classification_reason = "Metadata ff_billing_reason contains upsell";
      } else if (trialTs === null) {
        // Trial is based on the first successful non-upsell payment, not price.
        // Intro/trial offers can be high-priced packages.
        trialTs = eventTs;
        transaction_type = "trial";
        classification_reason = "First successful non-upsell payment → trial";
      } else if (
        trialTs !== null &&
        eventTs >= trialTs &&
        eventTs - trialTs <= HOUR &&
        (isUpsellByMetadata || isUpsellByAmount)
      ) {
        transaction_type = "upsell";
        classification_reason = isUpsellByMetadata
          ? "Metadata ff_billing_reason contains upsell"
          : "Common upsell amount within 0–60 minutes after trial";
      } else if (firstSubscriptionTs === null && !isUpsellByMetadata) {
        firstSubscriptionTs = eventTs;
        transaction_type = "first_subscription";
        classification_reason = "Next successful non-upsell payment after trial → first_subscription";
      } else if (!isUpsellByMetadata) {
        transaction_type = "renewal";
        classification_reason = "Later successful non-upsell payment → renewal";
      } else {
        transaction_type = "upsell";
        classification_reason = "Metadata ff_billing_reason contains upsell";
      }

      classified.push({
        ...tx,
        transaction_type,
        classification_reason,
      });
    }
  });

  return addCohortFields(classified).sort((a, b) => (a.event_time < b.event_time ? 1 : -1));
}

export function addCohortFields(rows: Transaction[]): Transaction[] {
  const trialByUser = new Map<string, Transaction>();
  // Cohorts must be anchored to the user's first successful trial timestamp,
  // not to each transaction's own calendar date.
  for (const tx of [...rows].sort((a, b) => (a.event_time < b.event_time ? -1 : 1))) {
    if (tx.transaction_type === "trial" && tx.status === "success" && !trialByUser.has(tx.user_id)) {
      trialByUser.set(tx.user_id, tx);
    }
  }

  return rows.map((tx) => {
    const trial = trialByUser.get(tx.user_id);
    if (!trial) return { ...tx, transaction_day: null };
    const trialTs = new Date(trial.event_time).getTime();
    const eventTs = new Date(tx.event_time).getTime();
    // Whole days since trial support lifecycle analysis and cohort windows.
    const transactionDay = Math.floor((eventTs - trialTs) / DAY);
    const cohortDate = trial.event_time.slice(0, 10);
    const campaignPath = trial.campaign_path || "unknown";
    return {
      ...tx,
      cohort_date: cohortDate,
      cohort_id: `${campaignPath}_${cohortDate}`,
      transaction_day: transactionDay,
    };
  });
}

export function transformPalmerRows(rows: RawPalmerRow[]): Transaction[] {
  return classifyUserTransactions(normalizePalmerRows(rows));
}

export function getPalmerImportDiagnostics(
  rows: Transaction[],
  totalRows = rows.length,
  rawRows: RawPalmerRow[] = []
): PalmerImportDiagnostics {
  const rowsMissingCustomerId = rawRows.length
    ? rawRows.filter((row) => !customerIdFrom(row)).length
    : rows.filter((row) => row.user_id.includes("@") || row.user_id.startsWith("unknown_user_")).length;

  return {
    totalRows,
    rowsWithAmountUsd: rows.filter((row) => Number.isFinite(row.amount_usd) && row.amount_usd !== 0).length,
    successRows: rows.filter((row) => row.status === "success").length,
    trialRows: rows.filter((row) => row.transaction_type === "trial").length,
    upsellRows: rows.filter((row) => row.transaction_type === "upsell").length,
    firstSubscriptionRows: rows.filter((row) => row.transaction_type === "first_subscription").length,
    rowsWithCohortId: rows.filter((row) => Boolean(row.cohort_id)).length,
    unknownFunnelRows: rows.filter((row) => row.funnel === "unknown").length,
    unclassifiedSuccessfulSubscriptionRows: rows.filter(
      (row) => row.status === "success" && near(row.amount_usd, AMOUNTS.subscription) && row.transaction_type === "unknown"
    ).length,
    uniqueUserIdCount: new Set(rows.map((row) => row.user_id)).size,
    missingEmailCount: rows.filter((row) => !row.email).length,
    missingCustomerIdCount: rowsMissingCustomerId,
    fallbackUnknownUserCount: rows.filter((row) => row.user_id.startsWith("unknown_user_")).length,
  };
}

function productFromAmount(amount: number): string {
  if (near(amount, AMOUNTS.trial)) return "Trial 7-day";
  if (near(amount, AMOUNTS.upsell)) return "Premium Reading Upsell";
  if (near(amount, AMOUNTS.subscription)) return "Monthly Subscription";
  return "Palmer transaction";
}
