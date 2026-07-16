// Shared request/response contract for the clickhouse-users Edge Function.
// One logical row per canonical user (user_id). Aggregates only — no
// raw_payload / normalized_payload / credentials. Email is returned because the
// current Users table displays it (single PII surface, column 1).

export type UsersAction = "list" | "details" | "options" | "summary";
export type UsersTriState = "all" | "yes" | "no";
export type UsersSortDirection = "asc" | "desc";
export type SubscriptionDataStatus = "empty_source" | "ready" | "partial" | "failed";

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
