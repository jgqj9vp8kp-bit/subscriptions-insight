// Types mirror the Google Sheets column schema exactly.
// When the real Sheets connection is added, the row shape stays identical.

export type TransactionType =
  | "trial"
  | "upsell"
  | "first_subscription"
  | "renewal_2"
  | "renewal_3"
  | "renewal"
  | "failed_payment"
  | "refund"
  | "chargeback"
  | "unknown";

export type TransactionStatus = "success" | "failed" | "refunded" | "chargeback";

export type Funnel = "past_life" | "soulmate" | "starseed" | "unknown";
export type TrafficSource = "facebook" | "tiktok" | "google" | "unknown";

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
  classification_reason: string;
  billing_reason?: string;
  cohort_date?: string;
  cohort_id?: string;
  transaction_day?: number | null;
}

export interface UserAggregate {
  user_id: string;
  email: string;
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
}

export interface PlanBreakdownRow {
  price: number;
  trial_users: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_2_users: number;
  renewal_3_users: number;
  renewal_users: number;
  refund_users: number;
  trial_to_upsell_cr: number;
  trial_to_first_subscription_cr: number;
  first_subscription_to_renewal_2_cr: number;
  renewal_2_to_renewal_3_cr: number;
  refund_rate: number;
  gross_revenue: number;
  amount_refunded: number;
  net_revenue: number;
  net_ltv: number;
}

export interface CohortRow {
  cohort_id: string;
  cohort_date: string;
  funnel: Funnel;
  campaign_path: string;
  trial_users: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_2_users: number;
  renewal_3_users: number;
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
  revenue_d0: number;
  revenue_d7: number;
  revenue_d14: number;
  revenue_d30: number;
  revenue_d37: number;
  revenue_d67: number;
  revenue_total: number;
  ltv_d7: number;
  ltv_d14: number;
  ltv_d30: number;
}
