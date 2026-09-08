// Revenue Intelligence queries: warehouse-version-keyed, persisted through the
// shared AnalyticsCacheGate root ("revenue" in WAREHOUSE_DEPENDENT_ROOTS), so
// a transaction sync invalidates the calendar view exactly like Cohorts.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GC_MS, STALE_MS, transientRetry } from "@/hooks/useAnalyticsCache";
import { runClickHouseRevenue } from "@/services/clickhouse";
import { revenueBundleKey, revenueDayKey } from "@/services/revenueCache";
import type {
  RevenueDayBreakdown,
  RevenueIntelligenceBundle,
  RevenueIntelligenceRequest,
} from "@/services/revenueIntelligence";

export function useRevenueBundle(params: {
  request: RevenueIntelligenceRequest;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): {
  bundle: RevenueIntelligenceBundle | null;
  error: string | null;
  isInitialLoading: boolean;
  isRefreshing: boolean;
} {
  const { request, userScopeHash, warehouseVersion, enabled } = params;
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
  });
  const bundle = (query.data as RevenueIntelligenceBundle | undefined) ?? null;
  return {
    bundle,
    error: query.isError
      ? (query.error instanceof Error ? query.error.message : "ClickHouse revenue request failed")
      : bundle && !bundle.ok
        ? bundle.error ?? "ClickHouse revenue request failed"
        : null,
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
}): { breakdown: RevenueDayBreakdown | null; loading: boolean; error: string | null } {
  const { date, request, userScopeHash, warehouseVersion, enabled } = params;
  const dayRequest = useMemo<RevenueIntelligenceRequest>(
    () => ({ ...request, action: "day_breakdown", date: date ?? undefined }),
    [request, date],
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
  });
  const breakdown = (query.data as RevenueDayBreakdown | undefined) ?? null;
  return {
    breakdown,
    loading: query.isFetching,
    error: query.isError ? (query.error instanceof Error ? query.error.message : "Day breakdown failed") : null,
  };
}
