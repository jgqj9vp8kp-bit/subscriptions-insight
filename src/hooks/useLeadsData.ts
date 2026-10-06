// Leads read-path hooks (leads plan §3 "Frontend"). The lead set is merged on
// the server (clickhouse-users actions leads_list / leads_overview: warehouse
// leads + stored FunnelFox profiles + subscription-only emails, paid and active
// emails excluded), so the Leads tab never hydrates the raw warehouse. Modelled
// on useUsersData: keep-previous on filter/sort/page change, the shared 5-minute
// stale time, transient-only retry, keys partitioned by the access partition.
//
//   ["leads", "list", partition, NormalizedLeadsListQuery]  one server page
//   ["leads", "overview", partition]                         KPIs + filter options + sync state
//   ["leads", "sync_state", partition]                       the sync card's state row (polled)
//
// invalidateLeadsQueries() (after a sync) refetches all three and makes the next
// list / overview request bypass the server's 60 s per-workspace memo once.
// "leads" is deliberately NOT a WAREHOUSE_DEPENDENT_ROOT: those are persisted to
// IndexedDB, and lead rows carry customer emails.

import { useContext, useMemo } from "react";
import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { AuthContext } from "@/contexts/authContext";
import { runClickHouseLeads } from "@/services/clickhouse";
import { getFunnelFoxLeadsStats, isLeadsSyncActive, LEADS_SYNC_POLL_MS, type FunnelFoxLeadsSyncState } from "@/services/funnelfoxLeads";
import { sortUniq } from "@/services/analyticsCache";
import { recordDuration } from "@/services/analyticsProgress";
import { traceHash, traceRequest } from "@/services/performanceTrace";
import { GC_MS, STALE_MS, transientRetry, useCacheScope } from "@/hooks/useAnalyticsCache";
import type {
  LeadSource,
  LeadsDeclineFilter,
  LeadsFiltersInput,
  LeadsListResponse,
  LeadsOverviewResponse,
  LeadsRequest,
  LeadsSortDirection,
  LeadsSortKey,
} from "../../supabase/functions/_shared/clickhouse/leadsContract";

export const LEADS_QUERY_ROOT = "leads" as const;
const NS = "leads";

/** A leads_list request without the action (the hook adds it). */
export type LeadsListQuery = Omit<LeadsRequest, "action" | "refresh">;

/** The list key's request part: two logically identical requests share one key. */
export interface NormalizedLeadsListQuery {
  search: string;
  date_from: string | null;
  date_to: string | null;
  funnel: string[];
  campaign_path: string[];
  campaign_id: string[];
  media_buyer: string[];
  country: string[];
  source: LeadSource[];
  has_declines: LeadsDeclineFilter;
  sort: { key: LeadsSortKey; dir: LeadsSortDirection };
  page: number;
  page_size: number;
}

function sourceList(value: LeadsFiltersInput["source"]): LeadSource[] {
  if (value == null || value === "all") return [];
  return sortUniq(Array.isArray(value) ? value : [value]) as LeadSource[];
}

function declineFilter(value: LeadsFiltersInput["has_declines"]): LeadsDeclineFilter {
  if (value === true || value === "has" || value === "yes") return "has";
  if (value === false || value === "none" || value === "no") return "none";
  return "all";
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

export function normalizeLeadsListQuery(query: LeadsListQuery): NormalizedLeadsListQuery {
  const filters = query.filters ?? {};
  let dateFrom = (filters.date_from ?? "").trim() || null;
  let dateTo = (filters.date_to ?? "").trim() || null;
  // The server refuses date_from > date_to (400); a reversed range means the same days.
  if (dateFrom && dateTo && dateFrom > dateTo) [dateFrom, dateTo] = [dateTo, dateFrom];
  return {
    search: (filters.search ?? "").trim(),
    date_from: dateFrom,
    date_to: dateTo,
    funnel: sortUniq(filters.funnel),
    campaign_path: sortUniq(filters.campaign_path),
    campaign_id: sortUniq(filters.campaign_id),
    media_buyer: sortUniq(filters.media_buyer),
    country: sortUniq(filters.country),
    source: sourceList(filters.source),
    has_declines: declineFilter(filters.has_declines),
    sort: { key: query.sort?.key ?? "lead_date", dir: query.sort?.dir === "asc" ? "asc" : "desc" },
    page: positiveInt(query.page, 1),
    page_size: positiveInt(query.page_size, 50),
  };
}

/** The leads_list body for a normalized query. */
export function buildLeadsListRequest(norm: NormalizedLeadsListQuery, refresh = false): LeadsRequest & { action: "leads_list" } {
  return {
    action: "leads_list",
    filters: {
      search: norm.search || null,
      date_from: norm.date_from,
      date_to: norm.date_to,
      funnel: norm.funnel,
      campaign_path: norm.campaign_path,
      campaign_id: norm.campaign_id,
      media_buyer: norm.media_buyer,
      country: norm.country,
      source: norm.source.length ? norm.source : "all",
      has_declines: norm.has_declines,
    },
    sort: { key: norm.sort.key, dir: norm.sort.dir },
    page: norm.page,
    page_size: norm.page_size,
    ...(refresh ? { refresh: true } : {}),
  };
}

export function leadsListKey(partition: string, query: LeadsListQuery): [string, "list", string, NormalizedLeadsListQuery] {
  return [LEADS_QUERY_ROOT, "list", partition, normalizeLeadsListQuery(query)];
}

export function leadsOverviewKey(partition: string): [string, "overview", string] {
  return [LEADS_QUERY_ROOT, "overview", partition];
}

export function leadsSyncStateKey(partition: string): [string, "sync_state", string] {
  return [LEADS_QUERY_ROOT, "sync_state", partition];
}

// ---- one-shot server-memo bypass after a sync ---------------------------------
const pendingServerRefresh = new Set<"list" | "overview">();

function takeServerRefresh(kind: "list" | "overview"): boolean {
  const pending = pendingServerRefresh.has(kind);
  pendingServerRefresh.delete(kind);
  return pending;
}

/** After a sync (or the Refresh button): refetch every leads query, and let the
 * next list / overview request rebuild the server's merged set (refresh: true). */
export async function invalidateLeadsQueries(client: QueryClient): Promise<void> {
  pendingServerRefresh.add("list");
  pendingServerRefresh.add("overview");
  await client.invalidateQueries({ queryKey: [LEADS_QUERY_ROOT] });
}

/** Re-read only the sync card's state row (after each step of a manual sync). */
export async function invalidateLeadsSyncState(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: [LEADS_QUERY_ROOT, "sync_state"] });
}

/** Test hook. */
export function resetLeadsRefreshState(): void {
  pendingServerRefresh.clear();
}

// Inside the AccessProvider the access partition; outside (unit tests) the signed-in user id.
function useLeadsScope(): string {
  const userId = useContext(AuthContext)?.user?.id ?? "";
  return useCacheScope(userId);
}

function assertOk<T>(response: T, fallback: string): T {
  const embedded = response as { ok?: unknown; error?: unknown } | null;
  if (!embedded || embedded.ok === false) throw new Error(typeof embedded?.error === "string" && embedded.error ? embedded.error : fallback);
  return response;
}

const COMMON = {
  staleTime: STALE_MS,
  gcTime: GC_MS,
  retry: transientRetry,
  refetchOnWindowFocus: false,
  refetchOnReconnect: true,
} as const;

/** One server page of the merged lead set (filters, sort and pagination on the server). */
export function useLeadsList(request: LeadsListQuery, options: { enabled: boolean }) {
  const partition = useLeadsScope();
  const enabled = options.enabled && partition !== "";
  const queryKey = useMemo(() => leadsListKey(partition, request), [partition, request]);
  const keyHash = useMemo(() => traceHash(queryKey), [queryKey]);
  return useQuery({
    queryKey,
    queryFn: async (): Promise<LeadsListResponse> => {
      const started = Date.now();
      const body = buildLeadsListRequest(queryKey[3], takeServerRefresh("list"));
      const response = await traceRequest(
        "leads.list_request",
        `leads:list:${keyHash}`,
        () => runClickHouseLeads(body),
        { query_hash: keyHash, edge_function: "clickhouse-users" },
      );
      recordDuration(Date.now() - started, NS);
      return assertOk(response, "Leads request failed.");
    },
    placeholderData: keepPreviousData,
    enabled,
    ...COMMON,
  });
}

/** KPIs, filter options (with counts, over the unfiltered set) and the sanitized sync state. */
export function useLeadsOverview(options: { enabled: boolean }) {
  const partition = useLeadsScope();
  const enabled = options.enabled && partition !== "";
  const queryKey = useMemo(() => leadsOverviewKey(partition), [partition]);
  return useQuery({
    queryKey,
    queryFn: async (): Promise<LeadsOverviewResponse> => {
      const refresh = takeServerRefresh("overview");
      const response = await traceRequest(
        "leads.overview_request",
        "leads:overview",
        () => runClickHouseLeads({ action: "leads_overview", ...(refresh ? { refresh: true } : {}) }),
        { edge_function: "clickhouse-users" },
      );
      return assertOk(response, "Leads overview request failed.");
    },
    placeholderData: keepPreviousData,
    enabled,
    ...COMMON,
  });
}

/** The sync card's state row (a one-row PostgREST read, cheap). Re-read every
 * LEADS_SYNC_POLL_MS while the pipeline is partial, running or rate-limited. */
export function useLeadsSyncState(options: { enabled: boolean }) {
  const partition = useLeadsScope();
  const enabled = options.enabled && partition !== "";
  return useQuery({
    queryKey: leadsSyncStateKey(partition),
    queryFn: (): Promise<FunnelFoxLeadsSyncState | null> => getFunnelFoxLeadsStats(),
    enabled,
    staleTime: 0,
    gcTime: GC_MS,
    retry: false,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => (isLeadsSyncActive(query.state.data ?? null) ? LEADS_SYNC_POLL_MS : false),
    refetchIntervalInBackground: false,
  });
}
