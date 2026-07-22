// Types mirror the Google Sheets column schema exactly.
// When the real Sheets connection is added, the row shape stays identical.

export type TransactionType =
  | "trial"
  | "upsell"
  | "first_subscription"
  | "renewal_2"
  | "renewal_3"
  | "renewal"
  | "token_purchase"
  | "failed_payment"
  | "refund"
  | "chargeback"
  | "unknown";

export type TransactionStatus = "success" | "failed" | "refunded" | "chargeback";

export type Funnel = "past_life" | "soulmate" | "starseed" | "unknown";
export type TrafficSource = "facebook" | "tiktok" | "google" | "organic" | "direct" | "unknown";
export type CardType = "prepaid" | "debit" | "credit" | "other" | "unknown";
export type MediaBuyer = "Ivan" | "Artem A" | "Artem D" | "Unknown";
export type DeclineReason =
  | "insufficient_funds"
  | "do_not_honor"
  | "authentication_failed"
  | "issuer_unavailable"
  | "expired_card"
  | "card_not_supported"
  | "lost_card"
  | "stolen_card"
  | "fraud_suspected"
  | "card_velocity_exceeded"
  | "processing_error"
  | "generic_decline"
  | "unknown";

export type DeclineStage =
  | "after_trial"
  | "after_first_subscription"
  | "after_renewal"
  | "unknown";

export interface Transaction {
  transaction_id: string;
  user_id: string;
  email: string;
  event_time: string; // ISO timestamp
  amount_usd: number;
  gross_amount_usd: number;
  refund_amount_usd: number;
  net_amount_usd: number;
  is_refunded: boolean;
  currency: string;
  status: TransactionStatus;
  transaction_type: TransactionType;
  funnel: Funnel;
  campaign_path: string;
  product: string;
  traffic_source: TrafficSource;
  campaign_id: string;
  utm_source?: string | null;
  classification_reason: string;
  billing_reason?: string;
  cohort_date?: string;
  cohort_id?: string;
  transaction_day?: number | null;
  card_type?: CardType;
  normalized_decline_reason?: DeclineReason;
  normalized_decline_stage?: DeclineStage;
  decline_message?: string | null;
  metadata?: Record<string, unknown>;
  raw?: Record<string, unknown>;
  // FX normalization (set by currencyNormalization.ts before analytics).
  // When fx_status is present, the money fields above are in USD and the
  // original charge is preserved here.
  fx_status?: "native_usd" | "converted" | "missing_currency" | "missing_fx_rate" | "invalid_amount";
  fx_rate?: number | null;
  original_currency?: string | null;
  original_gross_amount?: number;
}

export interface UserAggregate {
  user_id: string;
  email: string;
  country_code: string | null;
  card_type: CardType;
  utm_source: string | null;
  media_buyer: MediaBuyer;
  funnel: Funnel;
  first_trial_date: string | null;
  plan_price: number | null;
  plan_name?: string | null;
  plan_assignment_reason?: string | null;
  total_revenue: number;
  has_upsell: boolean;
  has_first_subscription: boolean;
  has_refund: boolean;
  total_refund_usd: number;
  renewal_count: number;
  user_ltv: number;
  has_failed_payment: boolean;
  latest_decline_reason: DeclineReason | null;
  latest_decline_stage: DeclineStage | null;
  latest_decline_message: string | null;
  latest_decline_date: string | null;
  failed_payment_count: number;
}

export interface PlanBreakdownRow {
  price: number;
  trial_users: number;
  support_users?: number;
  support_rate?: number;
  active_users: number;
  active_rate: number;
  active_subscriptions: number;
  active_subscriptions_rate: number;
  cancelled_users: number;
  cancellation_rate: number;
  user_cancelled_users: number;
  user_cancel_rate: number;
  auto_cancelled_users: number;
  auto_cancel_rate: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_2_users: number;
  renewal_3_users: number;
  renewal_4_users: number;
  renewal_5_users: number;
  renewal_6_users: number;
  renewal_users_by_level?: Record<number, number>;
  renewal_users: number;
  refund_users: number;
  trial_to_upsell_cr: number;
  trial_to_first_subscription_cr: number;
  first_subscription_to_renewal_2_cr: number;
  renewal_2_to_renewal_3_cr: number;
  renewal_3_to_renewal_4_cr: number;
  renewal_4_to_renewal_5_cr: number;
  renewal_5_to_renewal_6_cr: number;
  refund_rate: number;
  gross_revenue: number;
  amount_refunded: number;
  net_revenue: number;
  revenue_d0: number;
  revenue_d7: number;
  revenue_d30: number;
  revenue_d60: number;
  net_ltv: number;
}

// Per-cohort monetization metrics (multi-upsell funnel + web-app token packs).
// All fields are optional so hand-built CohortRow literals in existing tests
// stay valid; computeCohorts always fills them.
export interface CohortMonetizationFields {
  upsell_1_users?: number;
  upsell_2_users?: number;
  upsell_3_users?: number;
  /** Users whose 4th+ successful funnel upsell exists (order-based slots). */
  upsell_extra_users?: number;
  upsell_1_revenue?: number;
  upsell_2_revenue?: number;
  upsell_3_revenue?: number;
  upsell_extra_revenue?: number;
  upsell_1_cr?: number;
  upsell_2_cr?: number;
  upsell_3_cr?: number;
  /** Unique users with at least one successful funnel upsell of any slot. */
  funnel_upsell_users?: number;
  /** Gross revenue of all successful funnel upsells (slots 1-3 + extra). */
  funnel_upsell_revenue?: number;
  token_buyers?: number;
  token_buyer_cr?: number;
  token_purchases?: number;
  token_gross_revenue?: number;
  token_net_revenue?: number;
  avg_token_revenue_per_trial?: number;
  avg_token_revenue_per_buyer?: number;
  addon_revenue?: number;
  token_buyer_user_ids?: string[];
  token_pack_breakdown?: import("./monetization.ts").TokenPackRow[];
  /** Per-currency revenue mix of the cohort (original + USD-normalized). */
  currency_breakdown?: CohortCurrencyBreakdownRow[];
  /** e.g. "USD 50 · MXN 120" — trial users per original charge currency. */
  currency_mix?: string;
  /** Successful gross (original units) excluded from USD metrics in this cohort. */
  fx_missing_amount?: number;
  fx_missing_transactions?: number;
  /** Realized net revenue (USD) from the cohort within its first 30 days. Equals revenue_d30. */
  net_revenue_1m?: number;
  /** Realized 1-month LTV per trial user (USD): net_revenue_1m / trial_users. */
  ltv_1m_per_user?: number;
}

export interface CohortCurrencyBreakdownRow {
  currency: string;
  trial_users: number;
  transactions: number;
  gross_original: number;
  gross_usd: number;
  net_usd: number;
  refunds_usd: number;
  avg_trial_price_original: number | null;
  avg_trial_price_usd: number | null;
}

// FB Analytics metrics assigned server-side per authoritative user through
// selected-period Campaign CPP at campaign_id grain.
// All optional: absent on legacy-engine rows and pre-FB cached bundles — the
// UI renders "—" for absent values, never NaN/Infinity.
export interface CohortFbFields {
  fb_spend?: number | null;
  fb_currency?: string | null;
  fb_purchases?: number | null;
  fb_cpp?: number | null;
  fb_impressions?: number | null;
  fb_reach?: number | null;
  fb_clicks?: number | null;
  fb_link_clicks?: number | null;
  fb_ctr?: number | null;
  fb_cpc?: number | null;
  fb_cpm?: number | null;
  fb_purchase_value?: number | null;
  fb_roas?: number | null;
  fb_campaigns_matched?: number;
  fb_match_status?: string;
  fb_reporting_date?: string | null;
  fb_campaign_cpp?: number | null;
  fb_user_cpp?: number | null;
  fb_matched_users?: number;
  fb_unmatched_users?: number;
  fb_campaign_coverage?: number | null;
  fb_cpp_source?: string;
  fb_timezone?: string | null;
  coverage_rate?: number | null;
  /** Cohort-side business ratios derived from server row values (null when denominator is 0). */
  fb_cac?: number | null;
  fb_cost_per_trial?: number | null;
  fb_cost_per_upsell?: number | null;
  fb_gross_roas?: number | null;
  fb_net_roas?: number | null;
  fb_profit?: number | null;
  fb_margin?: number | null;
}

export interface CohortRow extends CohortMonetizationFields, CohortFbFields {
  cohort_id: string;
  cohort_date: string;
  funnel: Funnel;
  campaign_path: string;
  trial_users: number;
  active_users: number;
  active_rate: number;
  active_subscriptions: number;
  active_subscriptions_rate: number;
  active_subscription_user_ids: string[];
  /** Unique currently-active subscription_ids for the cohort (total-row dedup). */
  active_subscription_ids?: string[];
  cancelled_users: number;
  cancellation_rate: number;
  user_cancelled_users: number;
  user_cancel_rate: number;
  auto_cancelled_users: number;
  auto_cancel_rate: number;
  cancelled_active_users: number;
  active_user_ids: string[];
  cancelled_user_ids: string[];
  user_cancelled_user_ids: string[];
  auto_cancelled_user_ids: string[];
  cancelled_active_user_ids: string[];
  upsell_users: number;
  first_subscription_users: number;
  renewal_2_users: number;
  renewal_3_users: number;
  renewal_4_users: number;
  renewal_5_users: number;
  renewal_6_users: number;
  renewal_users_by_level?: Record<number, number>;
  renewal_users: number;
  refund_users: number;
  refunded_user_ids: string[];
  plan_breakdown: PlanBreakdownRow[];
  trial_revenue: number;
  upsell_revenue: number;
  first_subscription_revenue: number;
  renewal_revenue: number;
  amount_refunded: number;
  refund_rate: number;
  gross_revenue: number;
  net_revenue: number;
  gross_ltv: number;
  net_ltv: number;
  trial_to_upsell_cr: number;
  trial_to_first_subscription_cr: number;
  first_subscription_to_renewal_2_cr: number;
  renewal_2_to_renewal_3_cr: number;
  /** Renewal N → N+1 conversion: renewal_{N+1}_users / renewal_N_users × 100 (0 when the denominator is 0; the UI renders "—"). */
  renewal_3_to_renewal_4_cr: number;
  renewal_4_to_renewal_5_cr: number;
  renewal_5_to_renewal_6_cr: number;
  revenue_d0: number;
  revenue_d7: number;
  revenue_d14: number;
  revenue_d30: number;
  revenue_d60: number;
  revenue_d37: number;
  revenue_d67: number;
  revenue_total: number;
  ltv_d7: number;
  ltv_d14: number;
  ltv_d30: number;
}
