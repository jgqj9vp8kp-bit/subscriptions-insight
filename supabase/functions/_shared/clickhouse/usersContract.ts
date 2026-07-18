// Shared request/response contract for the clickhouse-users Edge Function.
// One logical row per canonical user (user_id). Aggregates only — no
// raw_payload / normalized_payload / credentials. Email is returned because the
// current Users table displays it (single PII surface, column 1).

export type UsersAction = "list" | "details" | "options" | "summary" | "decline";
export type UsersTriState = "all" | "yes" | "no";
export type UsersSortDirection = "asc" | "desc";
export type SubscriptionDataStatus = "empty_source" | "ready" | "partial" | "failed";

// Canonical sentinel for "no country attributed". Users whose authoritative
// country is empty/NULL are filterable and displayed under this value; it is
// never mixed with real ISO codes and always sorts last.
export const UNKNOWN_COUNTRY = "Unknown";

export interface UsersFilters {
  first_sub: UsersTriState;
  refund: UsersTriState;
  active_subscription: UsersTriState;
  payment_failed: UsersTriState;
  failed_attempts_min: number;
  funnel: string[];
  campaign_path: string[];
  campaign_id: string[];
  media_buyer: string[];
  country: string[];
  card_type: string[];
  currency: string[];
  decline_reason: string[];
  search: string;
}

export interface UsersSort {
  field: string;
  direction: UsersSortDirection;
}

export interface UsersPagination {
  page: number;
  page_size: number;
}

// action=decline extras: the Decline Analytics display filters (reason/stage
// narrow only the failed-transaction aggregations, exactly like the legacy tab)
// and the server-side sort of the country breakdown.
export interface UsersDeclineParams {
  reasons?: string[];
  stages?: string[];
  country_sort?: { field: string; direction: UsersSortDirection };
}

export interface UsersRequest {
  action?: UsersAction | string;
  date_from?: string | null;
  date_to?: string | null;
  filters?: Partial<UsersFilters>;
  sort?: UsersSort;
  pagination?: UsersPagination;
  now?: string;
  /** For action=details: the exact canonical user to expand. */
  user_id?: string;
  /** For action=decline: reason/stage display filters + country sort. */
  decline?: UsersDeclineParams;
}

// One canonical user. Lifecycle fields come from the authoritative classifier;
// revenue is aggregated over ALL the user's transactions (non-failed for net).
export interface UsersRow {
  user_id: string;
  email: string;
  country_code: string | null;
  card_type: string;
  media_buyer: string;
  utm_source: string | null;
  funnel: string;
  campaign_path: string;
  cohort_id: string;
  cohort_date: string | null;
  cohort_funnel: string;

  first_trial_date: string | null;
  first_trial_amount_original: number;
  first_trial_currency: string;
  first_trial_amount_usd: number;
  plan_price: number | null;
  plan_name: string | null;

  has_first_subscription: boolean;
  first_subscription_date: string | null;
  first_subscription_amount_usd: number;
  renewal_count: number;
  highest_subscription_level: number;
  lifecycle_state: string;

  total_revenue: number; // net (matches legacy UserAggregate.total_revenue)
  gross_revenue_usd: number;
  net_revenue_usd: number;
  has_refund: boolean;
  total_refund_usd: number;
  user_ltv: number;
  successful_payment_count: number;
  failed_payment_count: number;
  has_failed_payment: boolean;
  latest_decline_reason: string | null;
  latest_decline_stage: string | null;
  latest_decline_message: string | null;
  latest_decline_date: string | null;

  has_upsell: boolean;
  upsell_1_count: number;
  upsell_2_count: number;
  upsell_3_count: number;
  upsell_extra_count: number;
  upsell_revenue: number;
  token_purchase_count: number;
  token_gross_revenue: number;
  token_net_revenue: number;
  addon_revenue: number;

  active_subscription: boolean;
  active_subscription_count: number;
  subscription_status: string | null;
  renews: boolean | null;
  period_ends_at: string | null;
  cancelled: boolean;
  cancelled_at: string | null;
  cancellation_reason: string | null;
}

export interface UsersSummary {
  total_users: number;
  trial_users: number;
  upsell_users: number;
  first_subscription_users: number;
  active_subscription_users: number;
  cancelled_users: number;
  refund_users: number;
  failed_payment_users: number;
  gross_revenue_usd: number;
  net_revenue_usd: number;
}

export interface UsersFilterOptions {
  funnel: string[];
  campaign_path: string[];
  campaign_id: Array<{ campaign_id: string; campaign_name: string | null; trial_count: number }>;
  media_buyer: Array<{ media_buyer: string; user_count: number }>;
  country: Array<{ country_code: string; user_count: number }>;
  card_type: Array<{ card_type: string; user_count: number }>;
  currency: string[];
}

export interface UsersDiagnostics {
  users_scanned: number;
  transactions_scanned: number;
  missing_identity: number;
  missing_fx: number;
  subscription_data_status: SubscriptionDataStatus;
}

export interface UsersResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  pagination: { page: number; page_size: number; total_rows: number; total_pages: number };
  rows: UsersRow[];
  summary: UsersSummary | Record<string, never>;
  filter_options: UsersFilterOptions | Record<string, never>;
  diagnostics: UsersDiagnostics;
  error?: string;
}

// Lazy per-user detail (action=details): a bounded payment timeline + snapshot.
export interface UsersDetailsRow {
  event_time: string;
  transaction_id_hash: string;
  lifecycle_type: string;
  status: string;
  is_success: boolean;
  amount_original: number;
  currency: string;
  gross_usd: number;
  net_usd: number;
  refund_usd: number;
  subscription_level: number;
  upsell_slot: number;
}

export interface UsersDetailsResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  user_id: string;
  timeline: UsersDetailsRow[];
  subscription: {
    active_subscription: boolean;
    active_subscription_count: number;
    subscription_status: string | null;
    cancelled: boolean;
    cancelled_at: string | null;
    subscription_data_status: SubscriptionDataStatus;
  };
  error?: string;
}

// ---- action=decline (server-side Decline Analytics bundle) -----------------
// Aggregates only: no emails, no user ids, no transaction ids, no raw decline
// payloads. All rates are fractions (0..1) or null when the denominator is 0.

export interface UsersDeclineTotals {
  selected_users: number;
  failed_users: number;
  failed_transactions: number;
  /**
   * Successful transactions of the selected users. Unlike failed_transactions,
   * the reason/stage display filters never narrow this (they only apply to
   * failed rows).
   */
  successful_transactions: number;
  /**
   * successful + ALL failed transactions of the selected users — the
   * denominator for "share of all transactions" percentages.
   */
  total_transactions: number;
  /** failed_users / selected_users; null when selected_users = 0. */
  decline_rate: number | null;
  top_reason: string | null;
  /** failed_transactions / failed_users; null when failed_users = 0. */
  avg_attempts: number | null;
  stage_totals: Record<string, number>;
}

// Raw-processor-message drill-down of one decline reason (e.g. fraud_suspected
// splits into "Suspected fraud", "Fraud/Security (Mastercard use only)",
// "fraudulent", "Security violation", …). The label prefers the network result
// message over the normalized token; share is within the parent reason.
export interface UsersDeclineMessageRow {
  message: string;
  failed_users: number;
  failed_transactions: number;
  /** Share of the parent reason's failed transactions (0..1). */
  share: number;
}

export interface UsersDeclineReasonRow {
  reason: string;
  failed_users: number;
  failed_transactions: number;
  /** Share of all filtered failed transactions (0..1). */
  share: number;
  avg_attempts: number;
  latest_failed_date: string | null;
  stage_counts: Record<string, number>;
  top_stage: string;
  messages: UsersDeclineMessageRow[];
}

export interface UsersDeclineStageRow {
  stage: string;
  failed_users: number;
  failed_transactions: number;
  share: number;
  top_reason: string | null;
}

// One row per authoritative user-level country (same attribution as the User
// Table). "Attempts" are transaction rows of the selected users — identical to
// the proven payment-analytics attempt semantics.
export interface UsersDeclineCountryRow {
  country: string;
  total_attempts: number;
  successful: number;
  failed: number;
  pass_rate: number | null;
  insufficient_funds: number;
  /** successful / (total_attempts - insufficient_funds); null when denominator = 0. */
  pass_rate_ex_if: number | null;
  top_decline_reason: string | null;
  users_with_attempts: number;
  users_with_success: number;
  user_pass_rate: number | null;
  first_attempts: number;
  first_success: number;
  first_attempt_pass_rate: number | null;
  first_sub_attempts: number;
  first_sub_success: number;
  first_sub_pass_rate: number | null;
  renewal_attempts: number;
  renewal_success: number;
  renewal_pass_rate: number | null;
}

export interface UsersDeclineDiagnostics {
  users_with_country: number;
  users_without_country: number;
  attempts_with_country: number;
  attempts_without_country: number;
  unique_countries: number;
}

export interface UsersDeclineResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  totals: UsersDeclineTotals;
  reason_rows: UsersDeclineReasonRow[];
  stage_rows: UsersDeclineStageRow[];
  country_rows: UsersDeclineCountryRow[];
  /** Additive totals over country_rows (never an average of country rates). */
  country_totals: UsersDeclineCountryRow;
  country_sort: { field: string; direction: UsersSortDirection };
  applied_filters: {
    countries: string[];
    reasons: string[];
    stages: string[];
  };
  diagnostics: UsersDeclineDiagnostics;
  error?: string;
}
