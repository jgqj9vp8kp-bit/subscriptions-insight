// Revenue Intelligence queries: warehouse-version-keyed, persisted through the
// shared AnalyticsCacheGate root ("revenue" in WAREHOUSE_DEPENDENT_ROOTS), so
// a transaction sync invalidates the calendar view exactly like Cohorts.
// A funnel-restricted member gets 409 scope_snapshot_not_ready while their
// scoped snapshot is being prepared: the hooks expose the typed error code and
// re-ask every SCOPE_PENDING_POLL_MS until it is ready.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GC_MS, STALE_MS, transientRetry, useCacheScope } from "@/hooks/useAnalyticsCache";
import { ClickHouseRequestError, runClickHouseRevenue } from "@/services/clickhouse";
import { revenueBundleKey, revenueDayKey } from "@/services/revenueCache";
import { SCOPE_PENDING_POLL_MS, SCOPE_SNAPSHOT_NOT_READY } from "@/components/access/ScopeDataPending";
import type {
  RevenueDayBreakdown,
  RevenueIntelligenceBundle,
  RevenueIntelligenceRequest,
} from "@/services/revenueIntelligence";

const typedError = (error: unknown): ClickHouseRequestError | null => (error instanceof ClickHouseRequestError ? error : null);
const scopePendingInterval = (query: { state: { error: unknown } }): number | false =>
  typedError(query.state.error)?.errorCode === SCOPE_SNAPSHOT_NOT_READY ? SCOPE_PENDING_POLL_MS : false;

export function useRevenueBundle(params: {
  request: RevenueIntelligenceRequest;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): {
  bundle: RevenueIntelligenceBundle | null;
  error: string | null;
  /** The gate's error_code of a failed request (ClickHouseRequestError). */
  errorCode: string | null;
  /** HTTP status of a failed request (ClickHouseRequestError). */
  errorStatus: number | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
} {
  const { request, warehouseVersion } = params;
  const userScopeHash = useCacheScope(params.userScopeHash);
  const enabled = params.enabled && userScopeHash !== "";
  const queryKey = useMemo(
    () => revenueBundleKey({ userScopeHash, warehouseVersion, request: { ...request, action: "bundle" } }),
    [userScopeHash, warehouseVersion, request],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => runClickHouseRevenue<RevenueIntelligenceBundle>({ ...request, action: "bundle" }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchInterval: scopePendingInterval,
  });
  const bundle = (query.data as RevenueIntelligenceBundle | undefined) ?? null;
  const failure = query.isError ? typedError(query.error) : null;
  return {
    bundle,
    // A restricted member's snapshot-not-ready 409 lands on the same "needs the
    // cohort snapshot" card as the embedded cohort_snapshot_not_ready (the
    // section renders the funnel-scoped pending copy from errorCode).
    error: failure?.errorCode === SCOPE_SNAPSHOT_NOT_READY
      ? "cohort_snapshot_not_ready"
      : query.isError
        ? (query.error instanceof Error ? query.error.message : "ClickHouse revenue request failed")
        : bundle && !bundle.ok
          ? bundle.error ?? "ClickHouse revenue request failed"
          : null,
    errorCode: failure?.errorCode ?? null,
    errorStatus: failure?.status ?? null,
    isInitialLoading: query.isPending && enabled,
    isRefreshing: query.isFetching && !query.isPending,
  };
}

/** Lazy one-day drilldown (opened row / clicked bar). */
export function useRevenueDayBreakdown(params: {
  date: string | null;
  request: RevenueIntelligenceRequest;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): { breakdown: RevenueDayBreakdown | null; loading: boolean; error: string | null; errorCode: string | null; errorStatus: number | null } {
  const { date, request, warehouseVersion } = params;
  const userScopeHash = useCacheScope(params.userScopeHash);
  const enabled = params.enabled && userScopeHash !== "";
  // Only the day and the member filters shape a day_breakdown response — the
  // server ignores bucket/date_from/date_to. Stripping them from the request
  // (and hence the key) keeps a cached drilldown valid across a range or
  // grain switch instead of refetching identical data.
  const dayRequest = useMemo<RevenueIntelligenceRequest>(
    () => ({ action: "day_breakdown", date: date ?? undefined, filters: request.filters }),
    [request.filters, date],
  );
  const queryKey = useMemo(
    () => revenueDayKey({ userScopeHash, warehouseVersion, request: dayRequest }),
    [userScopeHash, warehouseVersion, dayRequest],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => runClickHouseRevenue<RevenueDayBreakdown>(dayRequest),
    enabled: enabled && Boolean(date),
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchInterval: scopePendingInterval,
  });
  const breakdown = (query.data as RevenueDayBreakdown | undefined) ?? null;
  const failure = query.isError ? typedError(query.error) : null;
  return {
    breakdown,
    loading: query.isFetching,
    // An embedded ok:false (e.g. cohort_snapshot_not_ready) must surface the
    // same way a transport error does — otherwise the drilldown renders a
    // silently empty panel.
    error: failure?.errorCode === SCOPE_SNAPSHOT_NOT_READY
      ? "Funnel-scoped data is being prepared… The day opens as soon as it is ready."
      : query.isError
        ? (query.error instanceof Error ? query.error.message : "Day breakdown failed")
        : breakdown && !breakdown.ok
          ? breakdown.error ?? "Day breakdown failed"
          : null,
    errorCode: failure?.errorCode ?? null,
    errorStatus: failure?.status ?? null,
  };
}
