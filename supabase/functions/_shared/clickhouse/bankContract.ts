// Request/response contract for the Banks actions of clickhouse-payment-analytics.
//
// The metrics are the SAME PassMetrics the Payment Pass tab uses — computed by
// the same METRIC_COLS over the same scratch table — so "pass rate" can never
// mean two different things on two tabs of one page.
import type { PassMetrics, PaymentAnalyticsFilters } from "./paymentAnalytics.ts";

export interface BankAnalyticsRequest {
  action?: string;
  filters?: Partial<PaymentAnalyticsFilters>;
  /** For action=bank_detail: the issuer to expand. */
  issuer_key?: string;
  /** Trend series covers the top N issuers by attempts (server-capped). */
  trend_top_n?: number;
}

export interface IssuerRow extends PassMetrics {
  issuer_key: string;
  issuer_name: string;
  issuer_group: string;
}

export interface IssuerGroupRow extends PassMetrics {
  issuer_group: string;
  /** Number of distinct issuer_keys rolled into this group under the filter. */
  member_count: number;
}

export interface IssuerTrendPoint {
  date: string;
  issuer_key: string;
  attempts: number;
  successful: number;
}

/**
 * Coverage and reconciliation. The UI shows this above the fold: a bank table
 * whose rows quietly exclude 7.8% of attempts is a lie unless it says so.
 *
 * identified + reported_unknown + missing === total, always — a violation means
 * the aggregation and the coverage query disagree about the filter, and the
 * client refuses to render rather than showing numbers that don't add up.
 */
export interface IssuerCoverage {
  total_attempts: number;
  identified_attempts: number;
  /** The provider literally answered "UNKNOWN" — present but uninformative. */
  reported_unknown_attempts: number;
  /** The issuer field was absent from the payload. */
  missing_attempts: number;
  identified_success: number;
  identified_failed: number;
  unidentified_success: number;
  unidentified_failed: number;
  /** Rows that are neither success nor failure (refunds etc.). Zero today; the
   * UI warns if it ever becomes non-zero instead of silently diluting rates. */
  non_attempt_rows: number;
}

export interface BankAnalyticsBundle {
  ok: boolean;
  source: "clickhouse";
  action: "banks";
  generated_at: string;
  query_duration_ms: number;
  /** Same METRIC_COLS as the Payment Pass summary — must match it exactly. */
  totals: PassMetrics;
  coverage: IssuerCoverage;
  issuer_rows: IssuerRow[];
  issuer_group_rows: IssuerGroupRow[];
  trend_points: IssuerTrendPoint[];
  /** Issuer rows are capped at MAX_ISSUER_ROWS; true when the cap bit. */
  truncated: boolean;
  filter_options: {
    issuer: Array<{ issuer_key: string; issuer_name: string; attempts: number }>;
    issuer_group: Array<{ issuer_group: string; attempts: number }>;
    card_network: string[];
    payment_method: string[];
    issuer_country: string[];
  };
  error?: string;
}

export interface BankDetailBundle {
  ok: boolean;
  source: "clickhouse";
  action: "bank_detail";
  generated_at: string;
  query_duration_ms: number;
  issuer_key: string;
  issuer_name: string;
  stage_rows: Array<{ stage: string } & PassMetrics>;
  decline_rows: Array<{ reason: string; failed_attempts: number; failed_users: number; share_of_failed: number }>;
  country_rows: Array<{ country: string } & PassMetrics>;
  network_rows: Array<{ card_network: string } & PassMetrics>;
  method_rows: Array<{ payment_method: string } & PassMetrics>;
  card_type_rows: Array<{ card_type: string } & PassMetrics>;
  time_points: Array<{ date: string; attempts: number; successful: number }>;
  /** Sub-brand members of this issuer's group under the current filter. */
  group_members: Array<{ issuer_key: string; issuer_name: string; attempts: number }>;
  error?: string;
}

export const MAX_ISSUER_ROWS = 2000;
export const DEFAULT_TREND_TOP_N = 8;
export const MAX_TREND_TOP_N = 20;
