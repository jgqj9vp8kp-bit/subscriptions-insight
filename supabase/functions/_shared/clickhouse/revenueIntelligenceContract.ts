// Dashboard Revenue Intelligence contract: the calendar projection of the same
// cohort-revenue facts Cohorts reads ("when did the money arrive, and which
// cohorts produced it").
//
// Two ORTHOGONAL axes ride every number (never merged into exclusive buckets):
//   RevenueType      — the Cohorts classifier's lifecycle taxonomy;
//   CohortRelation   — new | existing | unattributed, relative to the BUCKET
//                      (same-day for day grain, same-week / same-month for the
//                      coarser grains — §29 semantics, not same-day forever).
// Reconciliation invariants the server must satisfy on every response:
//   gross = new + existing + unattributed          (per bucket and in totals)
//   gross = Σ by_type + unattributed               (types are attributed-only:
//            an unattributed payment has no trial anchor, hence no lifecycle)
//   Σ by_funnel = Σ by_plan = Σ by_age = totals    (each with explicit Unknown/
//                                                   Unattributed rows)
// Refund semantics are RESTATEMENT (data limitation, documented): the refund
// amount lives on the ORIGINAL payment row and has no date of its own, so Net
// of past days can restate after a sync; Gross per day is stable.

export type RevenueBucket = "day" | "week" | "month";

export interface RevenueIntelligenceRequest {
  action?: "bundle" | "day_breakdown";
  date_from?: string | null;
  date_to?: string | null;
  bucket?: RevenueBucket;
  /** For action=day_breakdown: the revenue date to explain. */
  date?: string;
  /** Cohort-grain filters (fact_user_cohorts member semantics — identical to
   * Cohorts). Wired in a later phase; the contract carries them from day one. */
  filters?: Partial<RevenueIntelligenceFilters>;
}

export interface RevenueIntelligenceFilters {
  funnel: string[];
  campaign_path: string[];
  campaign_id: string[];
  traffic_source: string[];
  media_buyer: string[];
  country: string[];
  card_type: string[];
  platform: string[];
  currency: string[];
  price_plan: string[];
}

/** One calendar bucket. All *_new/_existing pairs are SAME-BUCKET relative to
 * the requested grain; unattributed = the payer has no row in the active
 * cohort snapshot (never silently dropped, never counted as existing). */
export interface RevenueBucketRow {
  /** Bucket start date (YYYY-MM-DD). */
  date: string;
  gross: number;
  refunds: number;
  net: number;
  spend: number;
  gross_new: number;
  gross_existing: number;
  gross_unattributed: number;
  net_new: number;
  net_existing: number;
  net_unattributed: number;
  /** Attributed revenue by lifecycle type (gross). */
  by_type: RevenueByType;
  /** Unique attributed payers in the bucket. */
  paying_users: number;
  /** Unique payers whose cohort falls in the same bucket. */
  new_paying_users: number;
  /** Net − Spend of this bucket. */
  profit: number;
  /** Running Net − Spend from the TRUE start of account history (not the
   * visible window) through this bucket. */
  cumulative_profit: number;
  /** True while the bucket's calendar period has not finished yet. */
  partial: boolean;
}

export interface RevenueByType {
  trial: number;
  first_subscription: number;
  renewals: number;
  upsells: number;
  tokens: number;
}

export interface RevenueSliceRow {
  /** campaign_path / price_plan / age bucket label. Unknown-ish rows are kept
   * distinct: '' → "Unknown" (cohort member without the value) vs the
   * "Unattributed" row (no snapshot membership at all). */
  key: string;
  gross: number;
  net: number;
  gross_new: number;
  gross_existing: number;
}

export const REVENUE_AGE_BUCKETS = ["d0", "d1_7", "d8_30", "d31_60", "d61_90", "d90_plus", "unattributed"] as const;
export type RevenueAgeBucket = (typeof REVENUE_AGE_BUCKETS)[number];

export interface RevenueAgeRow {
  bucket: RevenueAgeBucket;
  gross: number;
  net: number;
}

export interface RevenueTotals {
  gross: number;
  refunds: number;
  net: number;
  spend: number;
  gross_new: number;
  gross_existing: number;
  gross_unattributed: number;
  net_new: number;
  net_existing: number;
  net_unattributed: number;
  by_type: RevenueByType;
  profit: number;
}

export interface RevenueDiagnostics {
  /** Share of gross revenue attributable to a cohort user, % of totals.gross. */
  attributed_pct: number;
  /** Rows whose cohort_date is LATER than the revenue date (expected ~0). */
  future_cohort_gross: number;
  snapshot_warehouse_version: string;
  snapshot_classification_version: string;
  /** Successful transactions scanned for the window. */
  rows_scanned: number;
  /** True when cohort-grain member filters narrowed the response. The
   * Unattributed and spend streams have no user grain, so under an active
   * filter they are EXCLUDED (zeros) rather than silently kept project-wide —
   * the UI must present spend/profit as not defined for the slice. */
  filters_active: boolean;
  /** v1 does not reproduce the Cohorts email-token re-key: token purchases
   * matched only by email land in Unattributed here. This reports their size
   * so the bias is visible, not hidden. */
  note: string;
}

export interface RevenueIntelligenceBundle {
  ok: boolean;
  source: "clickhouse";
  action: "bundle";
  generated_at: string;
  query_duration_ms: number;
  bucket: RevenueBucket;
  /** EFFECTIVE window, aligned to whole buckets (a mid-week date_from expands
   * to its ISO Monday, date_to to the bucket's last day) so bucket rows,
   * totals and the by_* slices all cover the same span — invariant 3 depends
   * on this. At day grain these equal the requested dates. */
  date_from: string | null;
  date_to: string | null;
  buckets: RevenueBucketRow[];
  totals: RevenueTotals;
  by_funnel: RevenueSliceRow[];
  by_plan: RevenueSliceRow[];
  by_age: RevenueAgeRow[];
  diagnostics: RevenueDiagnostics;
  error?: string;
}

export interface RevenueDayCohortRow {
  /** Exact cohort date for recent cohorts; "YYYY-MM" month rollup for older
   * ones; "older" beyond the rollup horizon; "unattributed". */
  cohort: string;
  gross: number;
  net: number;
  by_type: RevenueByType;
}

export interface RevenueDayBreakdown {
  ok: boolean;
  source: "clickhouse";
  action: "day_breakdown";
  generated_at: string;
  query_duration_ms: number;
  date: string;
  gross: number;
  by_cohort: RevenueDayCohortRow[];
  by_funnel: RevenueSliceRow[];
  error?: string;
}

export type RevenueIntelligenceResponse = RevenueIntelligenceBundle | RevenueDayBreakdown;
