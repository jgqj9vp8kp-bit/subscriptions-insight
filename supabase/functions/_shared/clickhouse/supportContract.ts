// Shared request/response contract for clickhouse-support.
// The browser receives aggregate bundles, paged request rows, and one opened
// detail only. Filtering/search/sorting/pagination happen in ClickHouse.

export type SupportAction = "bundle" | "list" | "details" | "options" | "sync" | "status";
export type SupportSortDirection = "asc" | "desc";
export type SupportTriState = "all" | "yes" | "no";
export const EMPTY_CAMPAIGN_PATH = "—";

export interface SupportFilters {
  funnel: string[];
  campaign_path: string[];
  category: string[];
  subcategory: string[];
  language: string[];
  urgency: string[];
  matched: SupportTriState;
  requires_cancellation: SupportTriState;
  requires_refund: SupportTriState;
  payment_related: SupportTriState;
  delivery_related: SupportTriState;
  manual_status: "all" | "manual" | "automatic";
  import_batch_id: string[];
  search: string;
}

export interface SupportRequest {
  action?: SupportAction | string;
  date_from?: string | null;
  date_to?: string | null;
  filters?: Partial<SupportFilters>;
  sort?: { field: string; direction: SupportSortDirection };
  pagination?: { page: number; page_size: number };
  request_id?: string;
  sync?: {
    batch_size?: number;
    max_batches?: number;
    full_reset_cursor?: boolean;
    soft_timeout_ms?: number;
  };
}

export interface SupportKpis {
  totalRequests: number;
  uniqueSenders: number;
  matchedCustomers: number;
  unmatchedRequests: number;
  cancellationRequests: number;
  refundRequests: number;
  unauthorizedChargeRequests: number;
  productNotReceivedRequests: number;
  paymentIssues: number;
  highPriorityRequests: number;
  requestsPerDay: number;
  matchedPct: number;
  cancellationPct: number;
  refundPct: number;
  paymentRelatedPct: number;
}

export interface SupportRequestRow {
  id: string;
  import_batch_id: string | null;
  source_row_number: number;
  sender_name: string | null;
  subject: string | null;
  received_at: string | null;
  received_date_raw?: string | null;
  customer_email: string | null;
  normalized_email: string | null;
  matched_contact_name: string | null;
  funnel: string;
  campaign_path: string | null;
  cohort_date: string | null;
  attribution_status: "matched" | "unmatched_email" | "user_without_trial" | "ambiguous";
  category: string;
  subcategory: string;
  automatic_category: string;
  automatic_subcategory: string;
  language: string;
  sentiment: string;
  urgency: string;
  requires_refund: boolean;
  requires_cancellation: boolean;
  payment_related: boolean;
  delivery_related: boolean;
  possible_unauthorized_charge: boolean;
  duplicate_charge: boolean;
  urgent: boolean;
  matched_customer: boolean;
  classification_confidence: number;
  classification_reason: string | null;
  manual_category: string | null;
  manual_subcategory: string | null;
  manual_urgency: string | null;
  manual_changed_at?: string | null;
  imported_at: string;
}

export interface SupportRequestDetailRow extends SupportRequestRow {
  message_body: string | null;
}

export interface SupportFilterOptions {
  funnels: Array<{ funnel: string; requests: number }>;
  campaign_paths: Array<{ campaign_path: string; requests: number }>;
  categories: Array<{ category: string; requests: number }>;
  subcategories: Array<{ subcategory: string; requests: number }>;
  languages: Array<{ language: string; requests: number }>;
  urgencies: Array<{ urgency: string; requests: number }>;
  import_batches: Array<{ import_batch_id: string; requests: number }>;
}

export interface SupportSyncResult {
  ok: boolean;
  source: "clickhouse";
  action: "sync" | "status";
  status: string;
  stopped_reason: string | null;
  rows_scanned: number;
  rows_mapped: number;
  rows_inserted: number;
  rows_skipped: number;
  batches_processed: number;
  cursor_updated_at: string | null;
  cursor_request_id: string | null;
  source_total: number;
  clickhouse_total: number;
  duration_ms: number;
  diagnostics: Record<string, unknown>;
  error?: string;
}

export interface SupportAnalyticsBundle {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  summary: {
    rows: [];
    kpis: SupportKpis;
    byDay: Array<{ date: string; requests: number }>;
    categoryTrend: Array<{ date: string; category: string; requests: number }>;
    operationalTrend: Array<{ date: string; cancellation: number; refund: number; charge: number }>;
    languageDistribution: Array<{ language: string; requests: number }>;
    matchDistribution: Array<{ status: "matched" | "unmatched"; requests: number }>;
    priorityDistribution: Array<{ urgency: string; requests: number }>;
    categoryRanking: Array<{
      category: string;
      requests: number;
      share: number;
      uniqueSenders: number;
      matchedCustomers: number;
      highPriority: number;
      latestRequest: string | null;
      trendVsPrevious: number | null;
    }>;
    subcategoryRanking: Array<{ subcategory: string; requests: number; share: number }>;
    funnelRanking: Array<{
      funnel: string;
      requests: number;
      uniqueSupportUsers: number;
      share: number;
      cancellationRequests: number;
      refundRequests: number;
      unauthorizedChargeRequests: number;
      highPriority: number;
      matchedUsers: number;
      latestRequest: string | null;
      trialUsers: number | null;
      supportRate: number | null;
    }>;
    campaignPathRanking: Array<{
      campaignPath: string;
      requests: number;
      uniqueSupportUsers: number;
      cancellationRequests: number;
      refundRequests: number;
      highPriority: number;
      latestRequest: string | null;
      trialUsers: number | null;
      supportRate: number | null;
    }>;
    funnelTrend: Array<{ date: string; funnel: string; requests: number }>;
    matching: {
      matchedByEmail: number;
      matchedByName: number;
      unmatched: number;
      emailPresentNoMatchedContact: number;
      matchedContactNoEmail: number;
      duplicateNormalizedEmails: number;
      multipleSenderNamesForOneEmail: number;
    };
    insights: string[];
  };
  filter_options: SupportFilterOptions;
  diagnostics: {
    rows_scanned: number;
    payload_kind: "aggregate_only";
    browser_aggregation: false;
    requests_with_funnel: number;
    requests_without_funnel: number;
    unique_matched_support_users: number;
    unmatched_emails: number;
    users_without_trial: number;
    ambiguous: number;
    attribution_version: string | null;
    support_rate_denominator_available: boolean;
    support_rate_diagnostic: string | null;
  };
  error?: string;
}

export interface SupportListResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  pagination: { page: number; page_size: number; total_rows: number; total_pages: number };
  rows: SupportRequestRow[];
  error?: string;
}

export interface SupportDetailsResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  row: SupportRequestDetailRow | null;
  error?: string;
}

export interface SupportOptionsResponse {
  ok: boolean;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  filter_options: SupportFilterOptions;
  error?: string;
}

export type SupportResponse = SupportAnalyticsBundle | SupportListResponse | SupportDetailsResponse | SupportOptionsResponse | SupportSyncResult;
