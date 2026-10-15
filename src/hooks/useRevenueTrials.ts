// Daily trials query (the Dashboard card below Revenue Intelligence): the
// clickhouse-revenue action trials_daily, keyed like the bundle — access
// partition, warehouse version (a sync re-keys it) and the canonical request —
// under the same persisted "revenue" root. A module of its own because the
// page tests replace @/hooks/useRevenueIntelligence with factories.
// A funnel-restricted member gets 409 scope_snapshot_not_ready while their
// scoped snapshot is being prepared: the hook exposes the typed error code and
// re-asks every SCOPE_PENDING_POLL_MS until it is ready.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GC_MS, STALE_MS, transientRetry, useCacheScope } from "@/hooks/useAnalyticsCache";
import { ClickHouseRequestError, runClickHouseRevenue } from "@/services/clickhouse";
import { revenueTrialsKey } from "@/services/revenueCache";
import { SCOPE_PENDING_POLL_MS, SCOPE_SNAPSHOT_NOT_READY } from "@/components/access/ScopeDataPending";
import type { RevenueIntelligenceRequest, RevenueTrialsDaily } from "@/services/revenueIntelligence";

const typedError = (error: unknown): ClickHouseRequestError | null => (error instanceof ClickHouseRequestError ? error : null);
const scopePendingInterval = (query: { state: { error: unknown } }): number | false =>
  typedError(query.state.error)?.errorCode === SCOPE_SNAPSHOT_NOT_READY ? SCOPE_PENDING_POLL_MS : false;

export function useRevenueTrials(params: {
  request: RevenueIntelligenceRequest;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): {
  data: RevenueTrialsDaily | null;
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
    () => revenueTrialsKey({ userScopeHash, warehouseVersion, request: { ...request, action: "trials_daily" } }),
    [userScopeHash, warehouseVersion, request],
  );
  const query = useQuery({
    queryKey,
    queryFn: () => runClickHouseRevenue<RevenueTrialsDaily>({ ...request, action: "trials_daily" }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
    refetchInterval: scopePendingInterval,
  });
  const data = (query.data as RevenueTrialsDaily | undefined) ?? null;
  const failure = query.isError ? typedError(query.error) : null;
  return {
    data,
    // Same mapping as useRevenueBundle: a restricted member's 409 lands on the
    // "needs the cohort snapshot" state (the card renders the funnel-scoped
    // pending line from errorCode).
    error: failure?.errorCode === SCOPE_SNAPSHOT_NOT_READY
      ? "cohort_snapshot_not_ready"
      : query.isError
        ? (query.error instanceof Error ? query.error.message : "ClickHouse revenue request failed")
        : data && !data.ok
          ? data.error ?? "ClickHouse revenue request failed"
          : null,
    errorCode: failure?.errorCode ?? null,
    errorStatus: failure?.status ?? null,
    isInitialLoading: query.isPending && enabled,
    isRefreshing: query.isFetching && !query.isPending,
  };
}
