// Authenticated FB allocation diagnostics for the existing Cohorts response.
// This module is deliberately pure: it receives Campaign-period rows, applies
// allow-listed filters, computes summary before pagination,
// and never accepts SQL, credentials, environment objects, or raw payloads.

import type {
  FbAllocationStatus,
  FbCampaignValidationRow,
  FbTimezoneSource,
} from "./fbCohortStats.ts";

export const FB_ALLOCATION_DIAGNOSTICS_DEFAULT_PAGE_SIZE = 100;
export const FB_ALLOCATION_DIAGNOSTICS_MAX_PAGE_SIZE = 100;
export const FB_ALLOCATION_MONEY_TOLERANCE = 0.01;

export interface FbAllocationDiagnosticsFilters {
  /** Optional activity-period overlap filter; allocation is not recomputed. */
  date_from?: string | null;
  /** Optional activity-period overlap filter; allocation is not recomputed. */
  date_to?: string | null;
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_account_id?: string | null;
  allocation_status?: FbAllocationStatus | "all" | null;
  timezone_source?: FbTimezoneSource | "all" | null;
}

export interface FbAllocationDiagnosticsRequest {
  page?: number | null;
  page_size?: number | null;
  filters?: FbAllocationDiagnosticsFilters | null;
}

export interface NormalizedFbAllocationDiagnosticsRequest {
  page: number;
  page_size: number;
  filters: {
    date_from: string | null;
    date_to: string | null;
    campaign_id: string | null;
    campaign_name: string | null;
    ad_account_id: string | null;
    allocation_status: FbAllocationStatus | null;
    timezone_source: FbTimezoneSource | null;
  };
}

export interface FbAllocationDiagnosticsSummary {
  total_fb_spend: number;
  total_allocated_spend: number;
  total_unallocated_spend: number;
  total_unallocated_purchases: number;
  total_allocation_difference: number;
  total_fb_purchases: number;
  total_matched_users: number;
  overall_coverage_rate: number | null;
  fully_allocated_campaign_dates: number;
  underallocated_campaign_dates: number;
  overallocated_campaign_dates: number;
  timezone_unverified_campaign_dates: number;
  campaigns_without_matching_users: number;
  campaign_ids_without_cohort_users: number;
  users_without_matching_fb_metrics: number;
  sum_visible_cohort_spend: number;
  visible_allocated_difference: number;
  money_tolerance: number;
  reconciliation_ok: boolean;
  visible_spend_reconciles: boolean;
}

export interface FbAllocationDiagnosticsPage {
  enabled: true;
  date_filter_semantics: "campaign_activity_period_overlap";
  rows: FbCampaignValidationRow[];
  summary: FbAllocationDiagnosticsSummary;
  filters: NormalizedFbAllocationDiagnosticsRequest["filters"];
  page: number;
  page_size: number;
  total_rows: number;
  total_pages: number;
  has_previous_page: boolean;
  has_next_page: boolean;
  display_message: string | null;
  summary_computed_before_pagination: true;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOCATION_STATUSES = new Set<FbAllocationStatus>([
  "fully_allocated",
  "underallocated",
  "overallocated",
  "no_fb_purchases",
  "no_matched_users",
  "campaign_unmatched",
  "timezone_unverified",
  "invalid_timezone",
  "invalid_metrics",
]);
const TIMEZONE_SOURCES = new Set<FbTimezoneSource>(["payload", "account_config", "default_config", "unverified"]);

const round2 = (value: number): number => Math.round(value * 100) / 100;
const finiteInteger = (value: unknown, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};
const clean = (value: unknown): string | null => {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
};
const date = (value: unknown): string | null => {
  const normalized = clean(value);
  return normalized && DATE_RE.test(normalized) ? normalized : null;
};

export function fbAllocationDiagnosticsFeatureEnabled(value: string | null | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

export function normalizeFbAllocationDiagnosticsRequest(
  input: FbAllocationDiagnosticsRequest | null | undefined,
): NormalizedFbAllocationDiagnosticsRequest {
  const rawFilters = input?.filters ?? {};
  const rawStatus = clean(rawFilters.allocation_status);
  const rawTimezoneSource = clean(rawFilters.timezone_source);
  const page = Math.max(1, finiteInteger(input?.page, 1));
  const requestedPageSize = Math.max(1, finiteInteger(input?.page_size, FB_ALLOCATION_DIAGNOSTICS_DEFAULT_PAGE_SIZE));
  return {
    page,
    page_size: Math.min(requestedPageSize, FB_ALLOCATION_DIAGNOSTICS_MAX_PAGE_SIZE),
    filters: {
      date_from: date(rawFilters.date_from),
      date_to: date(rawFilters.date_to),
      campaign_id: clean(rawFilters.campaign_id),
      campaign_name: clean(rawFilters.campaign_name),
      ad_account_id: clean(rawFilters.ad_account_id),
      allocation_status: rawStatus && rawStatus !== "all" && ALLOCATION_STATUSES.has(rawStatus as FbAllocationStatus)
        ? rawStatus as FbAllocationStatus
        : null,
      timezone_source: rawTimezoneSource && rawTimezoneSource !== "all" && TIMEZONE_SOURCES.has(rawTimezoneSource as FbTimezoneSource)
        ? rawTimezoneSource as FbTimezoneSource
        : null,
    },
  };
}

function matches(row: FbCampaignValidationRow, filters: NormalizedFbAllocationDiagnosticsRequest["filters"]): boolean {
  if (filters.date_from && row.period_date_to && row.period_date_to < filters.date_from) return false;
  if (filters.date_to && row.period_date_from && row.period_date_from > filters.date_to) return false;
  if (filters.campaign_id && row.campaign_id !== filters.campaign_id) return false;
  if (filters.campaign_name && !(row.campaign_name ?? "").toLowerCase().includes(filters.campaign_name.toLowerCase())) return false;
  if (filters.ad_account_id && row.ad_account_id !== filters.ad_account_id) return false;
  if (filters.allocation_status && row.allocation_status !== filters.allocation_status) return false;
  if (filters.timezone_source && row.timezone_source !== filters.timezone_source) return false;
  return true;
}

function stableSort(rows: FbCampaignValidationRow[]): FbCampaignValidationRow[] {
  return [...rows].sort((left, right) =>
    (right.period_date_to ?? "").localeCompare(left.period_date_to ?? "")
    || left.campaign_id.localeCompare(right.campaign_id)
    || (left.ad_account_id ?? "").localeCompare(right.ad_account_id ?? "")
    || left.allocation_status.localeCompare(right.allocation_status));
}

function summary(rows: FbCampaignValidationRow[]): FbAllocationDiagnosticsSummary {
  const totalFbSpend = round2(rows.reduce((sum, row) => sum + row.fb_spend, 0));
  const totalAllocated = round2(rows.reduce((sum, row) => sum + row.allocated_spend, 0));
  const totalUnallocated = round2(rows.reduce((sum, row) => sum + row.unallocated_spend, 0));
  const totalUnallocatedPurchases = rows.reduce((sum, row) => sum + row.unmatched_fb_purchases, 0);
  const totalDifference = round2(totalAllocated + totalUnallocated - totalFbSpend);
  const totalPurchases = rows.reduce((sum, row) => sum + row.fb_purchases, 0);
  const totalMatchedUsers = rows
    .filter((row) => row.allocation_status === "fully_allocated" || row.allocation_status === "underallocated" || row.allocation_status === "overallocated")
    .reduce((sum, row) => sum + row.matched_authoritative_users, 0);
  const visibleSpend = round2(rows.reduce((sum, row) => sum + row.visible_cohort_spend, 0));
  const visibleDifference = round2(visibleSpend - totalAllocated);
  return {
    total_fb_spend: totalFbSpend,
    total_allocated_spend: totalAllocated,
    total_unallocated_spend: totalUnallocated,
    total_unallocated_purchases: totalUnallocatedPurchases,
    total_allocation_difference: totalDifference,
    total_fb_purchases: totalPurchases,
    total_matched_users: totalMatchedUsers,
    overall_coverage_rate: totalPurchases > 0 ? round2((totalMatchedUsers / totalPurchases) * 100) : null,
    fully_allocated_campaign_dates: rows.filter((row) => row.allocation_status === "fully_allocated").length,
    underallocated_campaign_dates: rows.filter((row) => row.allocation_status === "underallocated").length,
    overallocated_campaign_dates: rows.filter((row) => row.allocation_status === "overallocated").length,
    timezone_unverified_campaign_dates: rows.filter((row) => row.allocation_status === "timezone_unverified" || row.allocation_status === "invalid_timezone").length,
    campaigns_without_matching_users: rows.filter((row) => row.allocation_status === "no_matched_users").length,
    campaign_ids_without_cohort_users: rows.filter((row) => row.fb_spend >= 0 && row.matched_authoritative_users === 0 && row.allocation_status !== "campaign_unmatched").length,
    users_without_matching_fb_metrics: rows.reduce((sum, row) => sum + row.unmatched_authoritative_users, 0),
    sum_visible_cohort_spend: visibleSpend,
    visible_allocated_difference: visibleDifference,
    money_tolerance: FB_ALLOCATION_MONEY_TOLERANCE,
    reconciliation_ok: Math.abs(totalDifference) <= FB_ALLOCATION_MONEY_TOLERANCE,
    // Both values are already final two-decimal money values. A one-cent
    // difference is therefore visible to the user and must not be reported as
    // reconciled even though the broader allocation tolerance remains $0.01.
    visible_spend_reconciles: visibleDifference === 0,
  };
}

export function buildFbAllocationDiagnostics(
  rows: FbCampaignValidationRow[],
  request?: FbAllocationDiagnosticsRequest | null,
): FbAllocationDiagnosticsPage {
  const normalized = normalizeFbAllocationDiagnosticsRequest(request);
  const filtered = stableSort(rows.filter((row) => matches(row, normalized.filters)));
  const totalRows = filtered.length;
  const totalPages = totalRows === 0 ? 0 : Math.ceil(totalRows / normalized.page_size);
  const start = (normalized.page - 1) * normalized.page_size;
  const pageRows = filtered.slice(start, start + normalized.page_size);
  return {
    enabled: true,
    date_filter_semantics: "campaign_activity_period_overlap",
    rows: pageRows,
    summary: summary(filtered),
    filters: normalized.filters,
    page: normalized.page,
    page_size: normalized.page_size,
    total_rows: totalRows,
    total_pages: totalPages,
    has_previous_page: normalized.page > 1 && totalPages > 0,
    has_next_page: normalized.page < totalPages,
    display_message: totalRows > normalized.page_size
      ? normalized.page === 1
        ? `Показаны первые ${pageRows.length} из ${totalRows} Campaign rows`
        : `Показаны ${start + 1}–${Math.min(start + pageRows.length, totalRows)} из ${totalRows} Campaign rows`
      : null,
    summary_computed_before_pagination: true,
  };
}
