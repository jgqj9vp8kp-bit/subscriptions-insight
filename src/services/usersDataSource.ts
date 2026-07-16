// Users / Payment Analytics data-source abstraction (Phase 9).
//
// Feature flag VITE_USERS_DATA_SOURCE: "clickhouse" (default — the Edge Function
// drives the table with server-side filtering, sorting and pagination; the
// browser performs NO transaction scan) or "legacy" (client compute only). The
// two engines never run at once. Legacy code is never removed.

import { computeUsers } from "@/services/analytics";
import { runClickHouseUsers, runClickHouseUserDetails } from "@/services/clickhouse";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import type { CardType, DeclineReason, DeclineStage, Funnel, MediaBuyer, Transaction, UserAggregate } from "@/services/types";
import type {
  UsersRequest,
  UsersResponse,
  UsersRow,
  UsersSummary,
  UsersFilterOptions,
  UsersDetailsResponse,
} from "../../supabase/functions/_shared/clickhouse/usersContract";

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

export async function loadUserOptionsFromClickHouse(): Promise<UsersFilterOptions | null> {
  const response = await runClickHouseUsers({ action: "options" });
  if (!response.ok) throw new Error(response.error || "ClickHouse users options failed.");
  return (response.filter_options && "funnel" in response.filter_options) ? (response.filter_options as UsersFilterOptions) : null;
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

export type { UsersRow, UsersSummary, UsersFilterOptions, UsersResponse };
