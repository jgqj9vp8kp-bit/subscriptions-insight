import type { DeclineReason, Transaction, UserAggregate } from "@/services/types";

export const DECLINE_REASON_VALUES: DeclineReason[] = [
  "insufficient_funds",
  "do_not_honor",
  "authentication_failed",
  "issuer_unavailable",
  "expired_card",
  "card_not_supported",
  "lost_card",
  "stolen_card",
  "fraud_suspected",
  "card_velocity_exceeded",
  "processing_error",
  "generic_decline",
  "unknown",
];

const FAILED_STATUS_TOKENS = [
  "DECLINED",
  "FAILED",
  "AUTHORIZATION_FAILED",
  "AUTHORIZATION_DECLINED",
  "ERROR",
];

const DECLINE_FIELDS = [
  "decline_reason",
  "message",
  "payment_method_result_code",
  "payment_method_result_message",
  "payment_method_advice_code",
  "payment_method_advice_message",
  "advised_action",
  "transaction_lifecycle_event",
  "transaction_type",
  "created_at",
] as const;

export type DeclineReasonRecord = Partial<Record<(typeof DECLINE_FIELDS)[number], string>>;

export interface FailedPaymentState {
  has_failed_payment: boolean;
  latest_decline_reason: DeclineReason | null;
  latest_decline_message: string | null;
  latest_decline_date: string | null;
  failed_payment_count: number;
}

export interface DeclineRateRow {
  key: string;
  users: number;
  failed_users: number;
  decline_rate: number;
}

function compact(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeToken(value: unknown): string {
  return compact(value).toLowerCase().replace(/[\s-]+/g, "_");
}

function upperToken(value: unknown): string {
  return compact(value).toUpperCase().replace(/[\s-]+/g, "_");
}

function textHaystack(record: DeclineReasonRecord): string {
  return [
    record.decline_reason,
    record.message,
    record.payment_method_result_code,
    record.payment_method_result_message,
    record.payment_method_advice_code,
    record.payment_method_advice_message,
    record.advised_action,
    record.transaction_lifecycle_event,
  ].map(compact).join(" ");
}

function valueFromObject(source: unknown, field: string): string | undefined {
  if (!source || typeof source !== "object" || Array.isArray(source)) return undefined;
  const object = source as Record<string, unknown>;
  const direct = object[field];
  if (direct != null && compact(direct)) return compact(direct);
  const normalizedField = field.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const matchingKey = Object.keys(object).find((key) => key.toLowerCase().replace(/[^a-z0-9]+/g, "") === normalizedField);
  const value = matchingKey ? object[matchingKey] : undefined;
  return value != null && compact(value) ? compact(value) : undefined;
}

function recordFromObject(source: unknown): DeclineReasonRecord {
  const record: DeclineReasonRecord = {};
  for (const field of DECLINE_FIELDS) {
    const value = valueFromObject(source, field);
    if (value) record[field] = value;
  }
  return record;
}

function extractStringField(text: string, field: string): string[] {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quotedPattern = new RegExp(`["']${escapedField}["']\\s*:\\s*(["'])([\\s\\S]*?)\\1`, "g");
  const result: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = quotedPattern.exec(text))) {
    const value = compact(match[2]);
    if (value && !["None", "null", "undefined"].includes(value)) result.push(value);
  }
  return result;
}

export function parseDeclineReasonRecords(source: unknown): DeclineReasonRecord[] {
  if (!source) return [];
  if (Array.isArray(source)) {
    return source
      .map(recordFromObject)
      .filter((record) => Object.keys(record).length > 0);
  }
  if (typeof source === "object") {
    const record = recordFromObject(source);
    return Object.keys(record).length ? [record] : [];
  }

  const text = compact(source);
  if (!text) return [];
  try {
    return parseDeclineReasonRecords(JSON.parse(text));
  } catch {
    const values = Object.fromEntries(DECLINE_FIELDS.map((field) => [field, extractStringField(text, field)])) as Record<
      (typeof DECLINE_FIELDS)[number],
      string[]
    >;
    const maxLength = Math.max(0, ...Object.values(values).map((fieldValues) => fieldValues.length));
    return Array.from({ length: maxLength }, (_, index) => {
      const record: DeclineReasonRecord = {};
      for (const field of DECLINE_FIELDS) {
        const value = values[field][index];
        if (value) record[field] = value;
      }
      return record;
    }).filter((record) => Object.keys(record).length > 0);
  }
}

function declineSourcesForTransaction(tx: Transaction): unknown[] {
  return [
    tx.raw?.declineReasons,
    tx.metadata?.declineReasons,
    tx.raw,
    tx.metadata,
    tx,
  ];
}

export function declineReasonRecordsFromTransaction(tx: Transaction): DeclineReasonRecord[] {
  const records = declineSourcesForTransaction(tx).flatMap(parseDeclineReasonRecords);
  return records.length ? records : [recordFromObject({ status: tx.raw?.status, message: tx.decline_message })];
}

export function isFailedPaymentTransaction(tx: Transaction): boolean {
  if (tx.status === "refunded" || tx.status === "chargeback") return false;
  if (tx.transaction_type === "refund" || tx.transaction_type === "chargeback") return false;

  const haystack = [
    tx.status,
    tx.transaction_type,
    tx.classification_reason,
    tx.billing_reason,
    tx.raw?.status,
  ].join(" ").toUpperCase();

  return (
    tx.status === "failed" ||
    tx.transaction_type === "failed_payment" ||
    FAILED_STATUS_TOKENS.some((token) => haystack.includes(token))
  );
}

export function normalizeDeclineReason(recordOrReason: DeclineReasonRecord | unknown): DeclineReason {
  const record = typeof recordOrReason === "object" && recordOrReason !== null
    ? recordFromObject(recordOrReason)
    : { message: compact(recordOrReason) };
  const code = upperToken(record.payment_method_result_code);
  const reason = upperToken(record.decline_reason);
  const message = normalizeToken(record.message);
  const resultMessage = normalizeToken(record.payment_method_result_message);
  const adviceMessage = normalizeToken(record.payment_method_advice_message);
  const haystack = normalizeToken(textHaystack(record));

  if (!haystack && !code && !reason) return "unknown";
  if (reason === "INSUFFICIENT_FUNDS" || code === "51" || haystack.includes("insufficient_funds") || haystack.includes("insufficient_funds_over_credit_limit") || haystack.includes("over_credit_limit")) {
    return "insufficient_funds";
  }
  if (reason === "AUTHENTICATION_REQUIRED" || haystack.includes("failed_authentication") || haystack.includes("authentication_required")) {
    return "authentication_failed";
  }
  if (reason === "ISSUER_TEMPORARILY_UNAVAILABLE" || message === "try_again_later" || haystack.includes("issuer_unavailable") || haystack.includes("switch_inoperative")) {
    return "issuer_unavailable";
  }
  if (reason === "EXPIRED_CARD" || message === "expired_card" || haystack.includes("card_has_expired")) {
    return "expired_card";
  }
  if (message === "lost_card" || haystack.includes("lost_card")) return "lost_card";
  if (reason === "LOST_OR_STOLEN_CARD" || message === "pickup_card" || message === "stolen_card" || haystack.includes("stolen_card") || haystack.includes("pick_up")) {
    return "stolen_card";
  }
  if (message === "card_velocity_exceeded" || haystack.includes("repeated_attempts") || haystack.includes("exceeding_its_amount_limit") || haystack.includes("exceeds_approval_amount_limit") || haystack.includes("exceeds_withdrawal_amount_limit")) {
    return "card_velocity_exceeded";
  }
  if (
    reason === "INVALID_CARD_NUMBER" ||
    message === "incorrect_number" ||
    message === "invalid_account" ||
    haystack.includes("invalid_account") ||
    haystack.includes("invalid_account_number") ||
    haystack.includes("invalid_number") ||
    message === "transaction_not_allowed" ||
    haystack.includes("restricted_card") ||
    haystack.includes("does_not_support_this_type_of_purchase") ||
    haystack.includes("transaction_not_supported") ||
    haystack.includes("transaction_not_permitted")
  ) {
    return "card_not_supported";
  }
  if (haystack.includes("fraud") || haystack.includes("security")) return "fraud_suspected";
  if (message === "processing_error" || haystack.includes("processing_error") || haystack.includes("system_malfunction") || haystack.includes("re_enter_transaction")) {
    return "processing_error";
  }
  if (reason === "DO_NOT_HONOR" || message === "do_not_honor" || resultMessage === "do_not_honor") return "do_not_honor";
  if (reason === "ERROR" || message === "generic_decline" || haystack.includes("your_card_was_declined")) return "generic_decline";
  return "generic_decline";
}

export function declineMessageFromRecord(record: DeclineReasonRecord): string | null {
  return (
    record.message ||
    record.payment_method_result_message ||
    record.decline_reason ||
    null
  );
}

export function declineDetailsForTransaction(tx: Transaction): { reason: DeclineReason; message: string | null; date: string } | null {
  if (!isFailedPaymentTransaction(tx)) return null;
  const records = declineReasonRecordsFromTransaction(tx).filter((record) => Object.keys(record).length > 0);
  const record = records[0] ?? {};
  return {
    reason: tx.normalized_decline_reason ?? normalizeDeclineReason(record),
    message: tx.decline_message ?? declineMessageFromRecord(record),
    date: tx.event_time,
  };
}

export function failedPaymentStateForUserTransactions(txs: Transaction[]): FailedPaymentState {
  const failed = txs
    .filter(isFailedPaymentTransaction)
    .sort((a, b) => (a.event_time < b.event_time ? 1 : a.event_time > b.event_time ? -1 : 0));
  const latest = failed[0] ? declineDetailsForTransaction(failed[0]) : null;
  return {
    has_failed_payment: failed.length > 0,
    latest_decline_reason: latest?.reason ?? null,
    latest_decline_message: latest?.message ?? null,
    latest_decline_date: latest?.date ?? null,
    failed_payment_count: failed.length,
  };
}

export function enrichTransactionDeclinesFromRawRows(
  transactions: Transaction[],
  rawRows: Record<string, unknown>[] = [],
): Transaction[] {
  if (!rawRows.length) return transactions;
  const byTransactionId = new Map<string, Record<string, unknown>>();
  rawRows.forEach((row, index) => {
    const id = compact(row.id) || compact(row.transaction_id) || compact(row.transactionId) || `palmer-row-${index + 1}`;
    if (id) byTransactionId.set(id, row);
  });

  return transactions.map((tx) => {
    const raw = byTransactionId.get(tx.transaction_id);
    if (!raw) return tx;
    const existingRaw = tx.raw ?? {};
    return {
      ...tx,
      raw: { ...existingRaw, ...raw },
    };
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function topDeclineReasons(users: UserAggregate[]): Array<{ reason: DeclineReason; users: number }> {
  const counts = new Map<DeclineReason, number>();
  for (const user of users) {
    if (!user.has_failed_payment || !user.latest_decline_reason) continue;
    counts.set(user.latest_decline_reason, (counts.get(user.latest_decline_reason) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([reason, users]) => ({ reason, users }))
    .sort((a, b) => b.users - a.users || a.reason.localeCompare(b.reason));
}

function declineRateBy<T extends UserAggregate>(users: T[], keyForUser: (user: T) => string | null | undefined): DeclineRateRow[] {
  const groups = new Map<string, { users: number; failed_users: number }>();
  for (const user of users) {
    const key = compact(keyForUser(user)) || "unknown";
    const group = groups.get(key) ?? { users: 0, failed_users: 0 };
    group.users += 1;
    if (user.has_failed_payment) group.failed_users += 1;
    groups.set(key, group);
  }
  return Array.from(groups.entries())
    .map(([key, value]) => ({
      key,
      users: value.users,
      failed_users: value.failed_users,
      decline_rate: value.users ? round2((value.failed_users / value.users) * 100) : 0,
    }))
    .sort((a, b) => b.failed_users - a.failed_users || a.key.localeCompare(b.key));
}

export function declineRateByGeo(users: UserAggregate[]): DeclineRateRow[] {
  return declineRateBy(users, (user) => user.country_code);
}

export function declineRateByCardType(users: UserAggregate[]): DeclineRateRow[] {
  return declineRateBy(users, (user) => user.card_type);
}

export function declineRateByFunnel(users: UserAggregate[]): DeclineRateRow[] {
  return declineRateBy(users, (user) => user.funnel);
}

export function declineRateByCampaign<T extends UserAggregate & { campaign_path?: string }>(users: T[]): DeclineRateRow[] {
  return declineRateBy(users, (user) => user.campaign_path);
}
