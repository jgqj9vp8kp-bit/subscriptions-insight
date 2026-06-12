// Pure, dependency-free aggregation helpers for the campaign-performance export (P0-4).
//
// This module is imported by BOTH the Deno edge function (index.ts, via "./aggregate.ts") and the
// vitest unit tests (via a relative path). Keeping the revenue / failed-payment / traffic-snapshot
// logic here — with NO external imports — means the actually-served API exercises the same code the
// tests verify, instead of the edge function silently drifting from the in-app dashboard.

export interface AggregateTxn {
  status?: string;
  transaction_type?: string;
  amount_usd?: number;
  gross_amount_usd?: number;
  net_amount_usd?: number;
  refund_amount_usd?: number;
  is_refunded?: boolean;
  classification_reason?: string;
  billing_reason?: string;
  raw?: Record<string, unknown>;
}

export interface TrafficMetricLike {
  date: string;
  campaign_path: string;
  trial_count: number;
  spend: number;
  campaign_id: string | null;
  media_buyer: string | null;
  utm_source: string | null;
}

// Revenue is recognised only for successful sale events — mirrors the dashboard's
// CASH_REVENUE_TRANSACTION_TYPES / isCashRevenueTransaction (src/services/dashboard.ts).
const REVENUE_TRANSACTION_TYPES = new Set([
  "trial",
  "upsell",
  "first_subscription",
  "renewal_2",
  "renewal_3",
  "renewal",
]);

// Mirrors FAILED_STATUS_TOKENS in src/services/paymentFailures.ts.
const FAILED_STATUS_TOKENS = ["DECLINED", "FAILED", "AUTHORIZATION_FAILED", "AUTHORIZATION_DECLINED", "ERROR"];

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

export function grossAmount(tx: AggregateTxn): number {
  const gross = num(tx.gross_amount_usd);
  if (gross !== 0) return gross;
  return num(tx.amount_usd);
}

export function isRevenueTransaction(tx: AggregateTxn): boolean {
  return tx.status === "success" && REVENUE_TRANSACTION_TYPES.has(String(tx.transaction_type));
}

// Refund magnitude for a transaction, matching the dashboard's refundTransactionAmount but ALSO
// counting chargebacks (P0-4 requires chargebacks to reduce net revenue for external consumers).
export function refundAmount(tx: AggregateTxn): number {
  const refund = num(tx.refund_amount_usd);
  if (refund > 0) return refund;
  if (
    tx.transaction_type === "refund" ||
    tx.transaction_type === "chargeback" ||
    tx.status === "refunded" ||
    tx.status === "chargeback"
  ) {
    return Math.abs(grossAmount(tx));
  }
  return 0;
}

export function grossRevenue(txs: AggregateTxn[]): number {
  return round2(txs.reduce((total, tx) => total + (isRevenueTransaction(tx) ? grossAmount(tx) : 0), 0));
}

export function refundsTotal(txs: AggregateTxn[]): number {
  return round2(txs.reduce((total, tx) => total + refundAmount(tx), 0));
}

// Gross revenue minus all refunds and chargebacks — refunded/chargeback sales no longer inflate
// reported revenue or ROAS the way the previous `status !== "failed"` filter allowed.
export function netRevenue(txs: AggregateTxn[]): number {
  return round2(grossRevenue(txs) - refundsTotal(txs));
}

// Mirrors isFailedPaymentTransaction in src/services/paymentFailures.ts so the served
// failed_payment_users count matches the in-app dashboard (P0-4): excludes refund/chargeback rows
// and matches failure tokens in status / classification_reason / billing_reason / raw.status.
export function isFailedPaymentTransaction(tx: AggregateTxn): boolean {
  if (tx.status === "refunded" || tx.status === "chargeback") return false;
  if (tx.transaction_type === "refund" || tx.transaction_type === "chargeback") return false;

  const haystack = [
    tx.status,
    tx.transaction_type,
    tx.classification_reason,
    tx.billing_reason,
    tx.raw?.status,
  ]
    .join(" ")
    .toUpperCase();

  return (
    tx.status === "failed" ||
    tx.transaction_type === "failed_payment" ||
    FAILED_STATUS_TOKENS.some((token) => haystack.includes(token))
  );
}

// Extracts traffic metrics from a data_snapshots payload, transparently decompressing the
// lz-string-uri-v1 wrapper that dataSnapshots.ts writes for payloads over 256 KB. Without this the
// edge function silently returned [] for large accounts, dropping spend / CAC / ROAS (P0-4).
export function extractTrafficMetrics(
  payload: unknown,
  decompress?: (data: string) => string | null,
): TrafficMetricLike[] {
  let resolved: unknown = payload;
  const wrapper = objectFrom(payload);
  if (wrapper && wrapper.__subengine_compressed === true) {
    if (!decompress || typeof wrapper.data !== "string") return [];
    try {
      const json = decompress(wrapper.data);
      resolved = json ? JSON.parse(json) : null;
    } catch {
      return [];
    }
  }

  const resolvedObject = objectFrom(resolved);
  const rows = resolvedObject && Array.isArray(resolvedObject.trafficMetrics)
    ? resolvedObject.trafficMetrics
    : Array.isArray(resolved)
      ? resolved
      : [];

  return rows
    .map((row) => objectFrom(row))
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .map((row) => ({
      date: normalize(row.date),
      campaign_path: normalize(row.campaign_path),
      trial_count: num(row.trial_count),
      spend: num(row.spend),
      campaign_id: normalize(row.campaign_id) || null,
      media_buyer: normalize(row.media_buyer) || null,
      utm_source: normalize(row.utm_source) || null,
    }))
    .filter((row) => row.date && row.campaign_path);
}
