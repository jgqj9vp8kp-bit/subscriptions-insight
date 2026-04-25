// Types mirror the Google Sheets column schema exactly.
// When the real Sheets connection is added, the row shape stays identical.

export type TransactionType =
  | "trial"
  | "upsell"
  | "first_subscription"
  | "renewal"
  | "failed_payment"
  | "refund"
  | "chargeback"
  | "unknown";

export type TransactionStatus = "success" | "failed" | "refunded" | "chargeback";

export type Funnel = "past_life" | "soulmate" | "starseed";
export type TrafficSource = "facebook" | "tiktok" | "google";

export interface Transaction {
  transaction_id: string;
  user_id: string;
  email: string;
  event_time: string; // ISO timestamp
  amount_usd: number;
  currency: string;
  status: TransactionStatus;
  transaction_type: TransactionType;
  funnel: Funnel;
  product: string;
  traffic_source: TrafficSource;
  campaign_id: string;
  classification_reason: string;
}

export interface UserAggregate {
  user_id: string;
  email: string;
  funnel: Funnel;
  first_trial_date: string | null;
  total_revenue: number;
  has_upsell: boolean;
  has_first_subscription: boolean;
  renewal_count: number;
  user_ltv: number;
}

export interface CohortRow {
  cohort_date: string;
  trial_users: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_users: number;
  trial_to_upsell_cr: number;
  trial_to_first_subscription_cr: number;
  revenue_d0: number;
  revenue_d7: number;
  revenue_d14: number;
  revenue_d30: number;
  ltv_d7: number;
  ltv_d14: number;
  ltv_d30: number;
}