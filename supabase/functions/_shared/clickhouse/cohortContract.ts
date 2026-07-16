// Shared request/response contract for the clickhouse-cohorts Edge Function.
// Deliberately decoupled from any React component internals: the frontend maps
// these aggregate rows onto its existing CohortRow view model, and the Edge
// Function is the only place that talks to ClickHouse. No raw_payload /
// normalized_payload / raw emails are ever carried here — only aggregates,
// bounded id-hash sets where cross-cohort dedup is unavoidable, and diagnostics.

export type CohortGroupBy = "day" | "week" | "month";
export type CohortRefundStatus = "all" | "has" | "none";
export type CohortSortDirection = "asc" | "desc";
export type CohortSupportDataStatus = "ready" | "empty_source" | "unavailable" | "sync_pending";
// Canonical action names (spec). The Edge Function also accepts the legacy
// aliases "cohorts"/"cohort_details"/"filter_options" for backwards safety.
export type CohortAction = "list" | "details" | "options";

// Status of the fact_subscriptions-derived metrics (Active/Cancelled). While the
// subscription snapshot is empty these metrics are UNAVAILABLE, not zero-proven.
export type SubscriptionDataStatus = "empty_source" | "ready" | "partial" | "failed";

// Which server-side filters the Edge Function actually reproduced for a request.
// The frontend uses this so shadow parity is only asserted for reproduced
// filters — an un-reproduced filter marks the scenario "parity not applicable"
// instead of silently comparing mismatched populations.
export interface CohortFiltersApplied {
  date_range: boolean;
  funnel: boolean;
  campaign_path: boolean;
  refund_status: boolean;
  media_buyer: boolean;
  currency: boolean;
  country: boolean;
  card_type: boolean;
  campaign_id: boolean;
  traffic_source: boolean;
  price_plan: boolean;
}

export interface CohortFilters {
  funnel: string[];
  campaign_path: string[];
  campaign_id: string[];
  traffic_source: string[];
  price_plan: string[];
  media_buyer: string[];
  country: string[];
  card_type: string[];
  currency: string[];
  transaction_type: string[];
  refund_status: CohortRefundStatus;
}

export interface CohortSort {
  field: string;
  direction: CohortSortDirection;
}

export interface CohortInclude {
  price_breakdown: boolean;
  currency_breakdown: boolean;
  token_pack_breakdown: boolean;
  monetization_breakdown: boolean;
  ltv_details: boolean;
}

export interface CohortRequest {
  action?: CohortAction | "cohorts" | "cohort_details" | "filter_options";
  date_from?: string | null;
  date_to?: string | null;
  group_by?: CohortGroupBy;
  filters?: Partial<CohortFilters>;
  sort?: CohortSort;
  include?: Partial<CohortInclude>;
  /** For action=details: max renewal levels to expand (matches UI setting). */
  max_renewal_depth?: number;
  /** Injected once per request so `active`/`maturity` stay deterministic. */
  now?: string;
  /** For action=details: the exact cohort to expand. */
  cohort_key?: { cohort_date: string; funnel: string; campaign_path: string };
}

// One aggregated cohort. Mirrors the transaction-derived subset of the client
// CohortRow. User counts are ClickHouse uniqExact() results; the small id-hash
// arrays exist ONLY so the frontend/Edge can dedup counts ACROSS cohorts for the
// totals row without shipping raw user ids (values are non-reversible hashes).
export interface CohortAggregateRow {
  cohort_date: string;
  funnel: string;
  campaign_path: string;

  trial_users: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_users: number;
  renewal_users_by_level: Record<number, number>;
  refund_users: number;
  support_users: number;
  support_rate: number;

  // Subscription-derived (fact_subscriptions join), see Phase 4.
  active_users: number;
  active_subscriptions: number;
  cancelled_users: number;
  user_cancelled_users: number;
  auto_cancelled_users: number;
  cancelled_active_users: number;

  trial_revenue: number;
  upsell_revenue: number;
  first_subscription_revenue: number;
  renewal_revenue: number;
  gross_revenue: number;
  net_revenue: number;
  amount_refunded: number;

  revenue_d0: number;
  revenue_d7: number;
  revenue_d14: number;
  revenue_d30: number;
  revenue_d60: number;
  net_revenue_1m: number;
  ltv_1m_per_user: number;

  upsell_1_users: number;
  upsell_2_users: number;
  upsell_3_users: number;
  upsell_extra_users: number;
  upsell_1_revenue: number;
  upsell_2_revenue: number;
  upsell_3_revenue: number;
  upsell_extra_revenue: number;
  funnel_upsell_users: number;
  funnel_upsell_revenue: number;

  token_buyers: number;
  token_purchases: number;
  token_gross_revenue: number;
  token_net_revenue: number;
  addon_revenue: number;

  fx_missing_transactions: number;
  fx_missing_amount: number;

  // Non-reversible id-hash sets for cross-cohort dedup of the totals row only.
  dedup: {
    active_user_hashes: string[];
    active_subscription_hashes: string[];
    refunded_user_hashes: string[];
    cancelled_user_hashes: string[];
    user_cancelled_user_hashes: string[];
    auto_cancelled_user_hashes: string[];
    cancelled_active_user_hashes: string[];
    token_buyer_hashes: string[];
  };
}

export interface CohortTotals {
  trial_users: number;
  first_subscription_users: number;
  active_users: number;
  active_subscriptions: number;
  renewal_users_by_level: Record<number, number>;
  refund_users: number;
  support_users: number;
  support_rate: number;
  gross_revenue: number;
  net_revenue: number;
  amount_refunded: number;
  revenue_d0: number;
  revenue_d7: number;
  revenue_d30: number;
  revenue_d60: number;
  ltv_1m_per_user: number;
  upsell_1_users: number;
  upsell_2_users: number;
  upsell_3_users: number;
  token_buyers: number;
  token_purchases: number;
  token_net_revenue: number;
  addon_revenue: number;
}

// Filter-option lists built server-side, shaped EXACTLY like the client option
// builders so the frontend drops them straight into the existing dropdowns:
//   campaign_id -> CampaignIdOption, country -> CountryUserCount,
//   card_type -> CohortCardTypeOption, media_buyer -> MediaBuyerOption.
// funnel/campaign_path/traffic_source/currency are plain string lists.
//
// CASCADING: these lists are scoped to the request's ACTIVE filters, with each
// dimension's own predicate excluded from its own list (so the user can still
// switch values inside a dimension). Counts are distinct cohort users in that
// dimension's scope. See CohortFilterOptionsDiagnostics for exactly which
// filters were applied.
export interface CohortFilterOptions {
  funnel: string[];
  campaign_path: string[];
  traffic_source: string[];
  price_plan: string[];
  currency: string[];
  campaign_id: Array<{ campaign_id: string; campaign_name: string | null; trial_count: number }>;
  country: Array<{ country_code: string; user_count: number }>;
  card_type: Array<{ card_type: string; trial_count: number }>;
  media_buyer: Array<{ media_buyer: string; trial_count: number }>;
}

/** The dimensions that get a cascading, self-excluded option list. */
export type CohortOptionDimension =
  | "funnel"
  | "campaign_path"
  | "campaign_id"
  | "traffic_source"
  | "media_buyer"
  | "country"
  | "card_type"
  | "currency"
  | "price_plan";

export interface CohortFilterOptionDimensionDiagnostic {
  dimension: CohortOptionDimension;
  /** Always the dimension itself — its own predicate is excluded from its own scope. */
  excluded_dimension: CohortOptionDimension;
  /** Filters actually applied when scoping THIS dimension's list. */
  filters_applied: string[];
  option_count: number;
  /** Distinct cohort users in this dimension's (self-excluded) scope. */
  scope_user_count: number;
}

// How the option lists were scoped. `filters_ignored_for_options` is honest about
// what could NOT be applied: refund_status is a cohort-GROUP-level HAVING over
// transaction aggregates (not a user attribute in the snapshot), and
// transaction_type is not a cohort-membership dimension.
export interface CohortFilterOptionsDiagnostics {
  source: "fact_user_cohorts" | "dynamic_classifier";
  filters_applied_to_options: string[];
  filters_ignored_for_options: string[];
  /** Distinct cohort users under ALL active filters (the Cohorts result scope). */
  option_scope_user_count: number;
  query_duration_ms: number;
  dimensions: CohortFilterOptionDimensionDiagnostic[];
}

export interface CohortDiagnostics {
  transactions_scanned: number;
  users_scanned: number;
  missing_identity: number;
  missing_fx: number;
  unknown_products: number;
  subscription_data_status: SubscriptionDataStatus;
  /** Which requested filters were reproduced server-side (see CohortFiltersApplied). */
  filters_applied: CohortFiltersApplied;
  /** Materialized cohort-membership snapshot metadata, when list/options read from fact_user_cohorts. */
  active_snapshot_version?: string | null;
  source_warehouse_version?: string | null;
  snapshot_generated_at?: string | null;
  /** "current" | "stale" when the live warehouse fingerprint was compared; otherwise the raw build status. */
  snapshot_status?: string | null;
  /** True ONLY when the active snapshot was built on the warehouse version that is current NOW. */
  snapshot_complete?: boolean;
  source_transactions?: number | null;
  cohort_users?: number | null;
  /** Live warehouse fingerprint at response time — compare with source_warehouse_version. */
  current_warehouse_version?: string | null;
  /** Live warehouse transaction count at response time (same scope as fx_diagnostics.transactions_total). */
  current_warehouse_transactions?: number | null;
  /** True when the snapshot was built on an OLDER warehouse version than the current one. Absent when the live fingerprint could not be read. */
  snapshot_stale?: boolean;
  /** True only when rows, snapshot metadata and FX in THIS response all describe one warehouse version. Absent when freshness is unknown. */
  report_complete?: boolean;
  support_data_status?: CohortSupportDataStatus;
  support_requests?: number | null;
  support_unique_emails?: number | null;
  support_matched_cohort_users?: number | null;
}

// Dataset-level FX health for the Cohorts FX panel — mirrors the client
// FxNormalizationDiagnostics so the frontend can drop it in unchanged.
export interface CohortFxDiagnostics {
  transactions_total: number;
  transactions_with_currency: number;
  transactions_without_currency: number;
  transactions_native_usd: number;
  transactions_converted: number;
  transactions_missing_fx_rate: number;
  transactions_invalid_amount: number;
  excluded_amount_original: number;
  excluded_transactions: number;
}

// Dataset-level token attribution for the Cohorts token panel — mirrors the
// client MonetizationDiagnostics (token attribution + unmapped products).
export interface CohortTokenDiagnostics {
  token_purchases_total: number;
  token_purchases_matched: number;
  token_purchases_matched_by_email: number;
  token_purchases_unmatched: number;
  token_unmatched_amount: number;
  unknown_products: unknown[];
  unknown_addon_revenue: number;
}

export interface CohortResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  rows: CohortAggregateRow[];
  totals: CohortTotals | Record<string, never>;
  filter_options: CohortFilterOptions | Record<string, never>;
  filter_options_diagnostics?: CohortFilterOptionsDiagnostics;
  fx_diagnostics?: CohortFxDiagnostics;
  token_diagnostics?: CohortTokenDiagnostics;
  diagnostics: CohortDiagnostics;
  error?: string;
}

// Expanded (lazy) breakdown for one cohort — action=cohort_details.
export interface CohortDetailsResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  cohort_key: { cohort_date: string; funnel: string; campaign_path: string };
  price_breakdown: Array<{ price: number; plan_name: string; trial_users: number; gross_revenue: number; net_revenue: number }>;
  currency_breakdown: Array<{ currency: string; trial_users: number; transactions: number; gross_original: number; gross_usd: number; net_usd: number; refunds_usd: number }>;
  upsell: { upsell_1_users: number; upsell_2_users: number; upsell_3_users: number; upsell_extra_users: number; upsell_1_revenue: number; upsell_2_revenue: number; upsell_3_revenue: number; upsell_extra_revenue: number };
  token_pack_breakdown: Array<{ product_id: string; product: string; price: number; purchases: number; buyers: number; gross_revenue: number; revenue_share: number }>;
  ltv_1m: { trial_users: number; net_revenue_1m: number; ltv_1m_per_user: number; age_days: number; matured: boolean; available_days: number };
  fx: { missing_transactions: number; missing_amount: number };
  error?: string;
}
