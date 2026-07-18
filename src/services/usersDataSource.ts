// Users / Payment Analytics data-source abstraction (Phase 9).
//
// Feature flag VITE_USERS_DATA_SOURCE: "clickhouse" (default — the Edge Function
// drives the table with server-side filtering, sorting and pagination; the
// browser performs NO transaction scan) or "legacy" (client compute only). The
// two engines never run at once. Legacy code is never removed.

import { computeUsers } from "@/services/analytics";
import { runClickHouseUsers, runClickHouseUserDetails, runClickHouseUsersDecline } from "@/services/clickhouse";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import type { CardType, DeclineReason, DeclineStage, Funnel, MediaBuyer, Transaction, UserAggregate } from "@/services/types";
import type {
  UsersRequest,
  UsersResponse,
  UsersRow,
  UsersSummary,
  UsersFilterOptions,
  UsersDeclineResponse,
  UsersDetailsResponse,
} from "../../supabase/functions/_shared/clickhouse/usersContract";
import { UNKNOWN_COUNTRY } from "../../supabase/functions/_shared/clickhouse/usersContract";

export { UNKNOWN_COUNTRY };

export type UsersDataSourceMode = "legacy" | "clickhouse";

export function usersDataSourceMode(): UsersDataSourceMode {
  return publicRuntimeConfig.usersDataSource === "legacy" ? "legacy" : "clickhouse";
}

// Same shape the Users page decorates onto UserAggregate.
export type UsersExplorerRow = UserAggregate & {
  campaign_path: string;
  cohort_id: string | null;
  cohort_date: string | null;
  cohort_funnel: string;
  active_subscription: boolean;
  cancelled: boolean;
};

export interface UsersSourceResult {
  rows: UsersExplorerRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  durationMs: number;
  subscriptionDataStatus?: string;
}

// The page's filter/sort/pagination state, mapped to a server request.
export interface UsersQuery {
  search?: string;
  firstTrialFrom?: string | null;
  firstTrialTo?: string | null;
  firstSub?: "all" | "has" | "none";
  refund?: "all" | "has" | "none";
  paymentFailed?: "all" | "has" | "none";
  failedAttempts?: "all" | "gte1" | "gte3" | "gte5";
  campaignPath?: string | null;
  country?: string | null;
  cardTypes?: string[];
  declineReasons?: string[];
  funnel?: string[];
  mediaBuyer?: string[];
  currency?: string[];
  activeSubscription?: "all" | "has" | "none";
  sortField: string;
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
}

const tri = (v: "all" | "has" | "none" | undefined): "all" | "yes" | "no" =>
  v === "has" ? "yes" : v === "none" ? "no" : "all";
const failedMin = (v: UsersQuery["failedAttempts"]): number => (v === "gte5" ? 5 : v === "gte3" ? 3 : v === "gte1" ? 1 : 0);

export function buildUsersRequest(q: UsersQuery): UsersRequest {
  return {
    action: "list",
    date_from: q.firstTrialFrom || null,
    date_to: q.firstTrialTo || null,
    filters: {
      first_sub: tri(q.firstSub),
      refund: tri(q.refund),
      payment_failed: tri(q.paymentFailed),
      active_subscription: tri(q.activeSubscription),
      failed_attempts_min: failedMin(q.failedAttempts),
      campaign_path: q.campaignPath && q.campaignPath !== "all" ? [q.campaignPath] : [],
      country: q.country && q.country !== "all" ? [q.country] : [],
      card_type: q.cardTypes ?? [],
      decline_reason: q.declineReasons ?? [],
      funnel: q.funnel ?? [],
      media_buyer: q.mediaBuyer ?? [],
      currency: q.currency ?? [],
      campaign_id: [],
      search: q.search?.trim() ?? "",
    },
    sort: { field: q.sortField, direction: q.sortDir },
    pagination: { page: q.page, page_size: q.pageSize },
  };
}

export function mapUsersRow(row: UsersRow): UsersExplorerRow {
  return {
    user_id: row.user_id,
    email: row.email,
    country_code: row.country_code,
    card_type: (row.card_type || "unknown") as CardType,
    utm_source: row.utm_source,
    media_buyer: (row.media_buyer || "Unknown") as MediaBuyer,
    funnel: (row.funnel || "unknown") as Funnel,
    first_trial_date: row.first_trial_date,
    plan_price: row.plan_price,
    plan_name: row.plan_name,
    plan_assignment_reason: null,
    total_revenue: row.total_revenue,
    has_upsell: row.has_upsell,
    has_first_subscription: row.has_first_subscription,
    has_refund: row.has_refund,
    total_refund_usd: row.total_refund_usd,
    renewal_count: row.renewal_count,
    user_ltv: row.user_ltv,
    has_failed_payment: row.has_failed_payment,
    latest_decline_reason: (row.latest_decline_reason as DeclineReason | null) ?? null,
    latest_decline_stage: (row.latest_decline_stage as DeclineStage | null) ?? null,
    latest_decline_message: row.latest_decline_message,
    latest_decline_date: row.latest_decline_date,
    failed_payment_count: row.failed_payment_count,
    campaign_path: row.campaign_path,
    cohort_id: row.cohort_id || null,
    cohort_date: row.cohort_date,
    cohort_funnel: row.cohort_funnel,
    active_subscription: row.active_subscription,
    cancelled: row.cancelled,
  };
}

export async function loadUsersFromClickHouse(query: UsersQuery): Promise<UsersSourceResult> {
  const started = Date.now();
  const response = await runClickHouseUsers(buildUsersRequest(query));
  if (!response.ok) throw new Error(response.error || "ClickHouse users request failed.");
  const rows = (response.rows ?? []).map(mapUsersRow);
  const pg = response.pagination ?? { page: query.page, page_size: query.pageSize, total_rows: rows.length, total_pages: 1 };
  return {
    rows,
    total: pg.total_rows,
    page: pg.page,
    pageSize: pg.page_size,
    totalPages: pg.total_pages,
    durationMs: response.query_duration_ms ?? Date.now() - started,
    subscriptionDataStatus: response.diagnostics?.subscription_data_status,
  };
}

export async function loadUsersSummaryFromClickHouse(query: UsersQuery): Promise<UsersSummary | null> {
  const response = await runClickHouseUsers({ ...buildUsersRequest(query), action: "summary" });
  if (!response.ok) throw new Error(response.error || "ClickHouse users summary failed.");
  return (response.summary && "total_users" in response.summary) ? (response.summary as UsersSummary) : null;
}

// Options carry the active filters so the server can scope the country list to
// the current selection (all filters except Country itself). Other dimensions
// stay global, as before.
export async function loadUserOptionsFromClickHouse(query?: UsersQuery): Promise<UsersFilterOptions | null> {
  const request: UsersRequest = query ? { ...buildUsersRequest(query), action: "options" } : { action: "options" };
  const response = await runClickHouseUsers(request);
  if (!response.ok) throw new Error(response.error || "ClickHouse users options failed.");
  return (response.filter_options && "funnel" in response.filter_options) ? (response.filter_options as UsersFilterOptions) : null;
}

// --- Decline Analytics (server bundle) -------------------------------------

// The decline tab's query: the same user-scope filters as the table (search,
// dates, tri-states, campaign, country, ...) plus the tab's reason/stage
// display filters and the server-side country-breakdown sort.
export interface UsersDeclineQuery extends Omit<UsersQuery, "sortField" | "sortDir" | "page" | "pageSize"> {
  analyticsReasons?: string[];
  analyticsStages?: string[];
  countrySortField: string;
  countrySortDir: "asc" | "desc";
}

export function buildUsersDeclineRequest(q: UsersDeclineQuery): UsersRequest {
  const base = buildUsersRequest({ ...q, sortField: "first_trial_date", sortDir: "desc", page: 1, pageSize: 1 });
  return {
    ...base,
    action: "decline",
    decline: {
      reasons: q.analyticsReasons ?? [],
      stages: q.analyticsStages ?? [],
      country_sort: { field: q.countrySortField, direction: q.countrySortDir },
    },
  };
}

export async function loadUsersDeclineFromClickHouse(query: UsersDeclineQuery): Promise<UsersDeclineResponse> {
  const response = await runClickHouseUsersDecline(buildUsersDeclineRequest(query));
  if (!response.ok) throw new Error(response.error || "ClickHouse users decline request failed.");
  return response;
}

export async function loadUserDetailsFromClickHouse(userId: string): Promise<UsersDetailsResponse> {
  const response = await runClickHouseUserDetails({ action: "details", user_id: userId });
  if (!response.ok) throw new Error(response.error || "ClickHouse user details failed.");
  return response;
}

// Legacy fallback — the existing client aggregation, unchanged.
export function loadUsersFromLegacy(txs: Transaction[]): UserAggregate[] {
  return computeUsers(txs);
}

export interface CountryOptionEntry {
  country_code: string;
  user_count: number;
}

// Legacy country filter options (mirrors the Cohorts page country filter):
// only the countries present among the CURRENTLY SCOPED users (every active
// filter except Country itself — including a cohort selection), counted by
// TRIAL users. A→Z with Unknown pinned last; countries whose scoped users have
// no trials stay listed (decline analytics also covers failed-only users) with
// a zero count.
export function buildLegacyCountryOptions(
  rows: Array<Pick<UserAggregate, "country_code" | "first_trial_date">>,
): CountryOptionEntry[] {
  const byCountry = new Map<string, number>();
  for (const row of rows) {
    const code = row.country_code || UNKNOWN_COUNTRY;
    byCountry.set(code, (byCountry.get(code) ?? 0) + (row.first_trial_date ? 1 : 0));
  }
  return Array.from(byCountry.entries())
    .map(([country_code, trials]) => ({ country_code, user_count: trials }))
    .sort((a, b) =>
      Number(a.country_code === UNKNOWN_COUNTRY) - Number(b.country_code === UNKNOWN_COUNTRY) ||
      a.country_code.localeCompare(b.country_code));
}

export type { UsersRow, UsersSummary, UsersFilterOptions, UsersResponse, UsersDeclineResponse };
