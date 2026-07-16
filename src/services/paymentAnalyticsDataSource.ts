// Payment Pass Analytics data-source abstraction.
//
// Flag VITE_PAYMENT_ANALYTICS_DATA_SOURCE: "clickhouse" (default — the Edge
// Function is the single source of truth, including canonical warehouse decline
// metrics; the browser performs NO transaction scan) or "legacy" (client compute
// only). The two engines never run at once; legacy is the emergency fallback if
// the Edge fails. Legacy code is never removed.

import { runClickHousePaymentAnalytics } from "@/services/clickhouse";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import type {
  PassMetrics, SegmentRow, StageRow, RenewalStageRow, DeclineReasonRow, PassRatePoint, PaymentStage, SegmentDimension,
} from "@/services/paymentPassAnalytics";
import type { DeclineReason } from "@/services/types";

export type PaymentAnalyticsMode = "legacy" | "clickhouse";
export function paymentAnalyticsMode(): PaymentAnalyticsMode {
  return publicRuntimeConfig.paymentAnalyticsDataSource === "legacy" ? "legacy" : "clickhouse";
}

// Filter/dimension state the component holds, mapped to the Edge request.
export interface PaymentAnalyticsQuery {
  dateBasis: "transaction" | "cohort";
  dateFrom: string | null; dateTo: string | null;
  funnel: string; campaignPath: string; campaignId: string; mediaBuyer: string; country: string; cardType: string;
  stage: string; declineReason: string; transactionType: string; outcome: "all" | "success" | "failed";
  groupBy: SegmentDimension; firstTxDimension: SegmentDimension; renewalDimension: SegmentDimension;
}

export interface PaymentAnalyticsBundle {
  schemaVersion: number;
  summary: PassMetrics; firstSummary: PassMetrics;
  funnelRows: SegmentRow[]; stageRows: StageRow[]; segmentRows: SegmentRow[]; firstTxRows: SegmentRow[];
  renewalRows: RenewalStageRow[]; renewalSegmentRows: SegmentRow[]; declineRows: DeclineReasonRow[]; firstDeclineRows: DeclineReasonRow[];
  timePoints: PassRatePoint[]; trialByCountry: SegmentRow[];
  options: { funnels: string[]; campaignPaths: string[]; campaignIds: string[]; mediaBuyers: string[]; countries: string[]; cardTypes: string[]; transactionTypes: string[]; declineReasons: string[] };
  durationMs: number;
}

const one = (v: string): string[] => (v && v !== "all" ? [v] : []);

export function buildPaymentAnalyticsRequest(q: PaymentAnalyticsQuery): Record<string, unknown> {
  return {
    action: "analytics",
    filters: {
      date_basis: q.dateBasis,
      date_from: q.dateFrom || null, date_to: q.dateTo || null,
      funnel: one(q.funnel), campaign_path: one(q.campaignPath), campaign_id: one(q.campaignId),
      media_buyer: one(q.mediaBuyer), country: one(q.country), card_type: one(q.cardType),
      stage: one(q.stage), decline_reason: one(q.declineReason), transaction_type: one(q.transactionType),
      outcome: q.outcome,
    },
    group_by: q.groupBy, first_tx_dimension: q.firstTxDimension, renewal_dimension: q.renewalDimension,
  };
}

interface RawBundle {
  ok: boolean; error?: string; query_duration_ms?: number;
  summary?: PassMetrics; first_summary?: PassMetrics;
  funnel_rows?: SegmentRow[]; stage_rows?: StageRow[]; segment_rows?: SegmentRow[]; first_tx_rows?: SegmentRow[]; first_transaction_rows?: SegmentRow[];
  renewal_rows?: RenewalStageRow[]; renewal_segment_rows?: SegmentRow[]; decline_rows?: DeclineReasonRow[]; first_decline_rows?: DeclineReasonRow[];
  time_points?: PassRatePoint[]; time_series?: PassRatePoint[]; trial_by_country?: SegmentRow[]; filter_options?: Record<string, string[]>;
}

const PAYMENT_ANALYTICS_BUNDLE_SCHEMA_VERSION = 2;
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object");
const isMetrics = (value: unknown): value is PassMetrics => isObject(value) && typeof value.attempts === "number";
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

function validateRawBundle(bundle: RawBundle): void {
  const missing: string[] = [];
  if (!isMetrics(bundle.summary)) missing.push("summary");
  if (!isMetrics(bundle.first_summary)) missing.push("first_summary");
  if (!isArray(bundle.funnel_rows)) missing.push("funnel_rows");
  if (!isArray(bundle.stage_rows)) missing.push("stage_rows");
  if (!isArray(bundle.segment_rows)) missing.push("segment_rows");
  if (!isArray(bundle.first_tx_rows) && !isArray(bundle.first_transaction_rows)) missing.push("first_tx_rows");
  if (!isArray(bundle.renewal_rows)) missing.push("renewal_rows");
  if (!isArray(bundle.renewal_segment_rows)) missing.push("renewal_segment_rows");
  if (!isArray(bundle.decline_rows)) missing.push("decline_rows");
  if (!isArray(bundle.first_decline_rows)) missing.push("first_decline_rows");
  if (!isArray(bundle.time_points) && !isArray(bundle.time_series)) missing.push("time_points");
  if (!isArray(bundle.trial_by_country)) missing.push("trial_by_country");
  if (!isObject(bundle.filter_options)) missing.push("filter_options");
  if (missing.length) {
    throw new Error(`Incomplete ClickHouse payment analytics response: missing ${missing.join(", ")}.`);
  }
}

export function isCompletePaymentAnalyticsBundle(value: unknown): value is PaymentAnalyticsBundle {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === PAYMENT_ANALYTICS_BUNDLE_SCHEMA_VERSION &&
    isMetrics(value.summary) &&
    isMetrics(value.firstSummary) &&
    isArray(value.funnelRows) &&
    isArray(value.stageRows) &&
    isArray(value.segmentRows) &&
    isArray(value.firstTxRows) &&
    isArray(value.renewalRows) &&
    isArray(value.renewalSegmentRows) &&
    isArray(value.declineRows) &&
    isArray(value.firstDeclineRows) &&
    isArray(value.timePoints) &&
    isArray(value.trialByCountry) &&
    isObject(value.options)
  );
}

// The Edge already emits PassMetrics/SegmentRow/… field-for-field; stage/reason
// come back as plain strings (cast to the client union types for the JSX).
function castStage(rows: StageRow[]): StageRow[] {
  return rows.map((r) => ({ ...r, stage: r.stage as PaymentStage | "first_transaction" }));
}
function castDecline(rows: DeclineReasonRow[]): DeclineReasonRow[] {
  return rows.map((r) => ({ ...r, reason: r.reason as DeclineReason, label: r.label }));
}

export async function loadPaymentAnalytics(query: PaymentAnalyticsQuery): Promise<PaymentAnalyticsBundle> {
  const started = Date.now();
  const b = await runClickHousePaymentAnalytics<RawBundle>(buildPaymentAnalyticsRequest(query));
  if (!b || !b.ok) throw new Error(b?.error || "ClickHouse payment analytics request failed.");
  validateRawBundle(b);
  const fo = b.filter_options ?? {};
  return {
    schemaVersion: PAYMENT_ANALYTICS_BUNDLE_SCHEMA_VERSION,
    summary: b.summary as PassMetrics, firstSummary: b.first_summary as PassMetrics,
    funnelRows: b.funnel_rows ?? [], stageRows: castStage(b.stage_rows ?? []), segmentRows: b.segment_rows ?? [], firstTxRows: b.first_tx_rows ?? b.first_transaction_rows ?? [],
    renewalRows: b.renewal_rows ?? [], renewalSegmentRows: b.renewal_segment_rows ?? [],
    declineRows: castDecline(b.decline_rows ?? []), firstDeclineRows: castDecline(b.first_decline_rows ?? []),
    timePoints: b.time_points ?? b.time_series ?? [], trialByCountry: b.trial_by_country ?? [],
    options: {
      funnels: fo.funnel ?? [], campaignPaths: fo.campaign_path ?? [], campaignIds: fo.campaign_id ?? [],
      mediaBuyers: fo.media_buyer ?? [], countries: fo.country ?? [], cardTypes: fo.card_type ?? [],
      transactionTypes: fo.transaction_type ?? [], declineReasons: fo.decline_reason ?? [],
    },
    durationMs: b.query_duration_ms ?? Date.now() - started,
  };
}
