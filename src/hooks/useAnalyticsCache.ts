// Shared TanStack-Query building blocks for the warehouse-backed analytics pages
// (Cohorts, Users, Payment Pass Analytics): common cache defaults, transient-only
// retry, the cached warehouse-version query, the honest staged progress hook, and
// the post-import invalidation. Per-page hooks compose these — nothing page-
// specific lives here.

import { useEffect, useReducer, useRef } from "react";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { getClickHouseSummary } from "@/services/clickhouse";
import {
  warehouseVersionFromSummary,
  supportWarehouseVersionFromSummary,
  SUPPORT_WAREHOUSE_VERSION_KEY,
  WAREHOUSE_DEPENDENT_ROOTS,
  WAREHOUSE_VERSION_KEY,
} from "@/services/analyticsCache";
import {
  INITIAL_PROGRESS,
  medianDuration,
  progressReducer,
  type ProgressPhase,
} from "@/services/analyticsProgress";
import { traceEvent, traceRequest } from "@/services/performanceTrace";

export const STALE_MS = 5 * 60 * 1000;
export const GC_MS = 60 * 60 * 1000;

// Retry only transient failures: not validation (400) or auth ("Sign in").
export function transientRetry(failureCount: number, error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/Sign in|not configured|400|invalid|unauthor/i.test(msg)) return false;
  return failureCount < 2;
}

// A cached, hashed fingerprint of the warehouse state. `ready` is true once the
// query has settled (success/error) or a persisted value is present, so callers
// can gate the heavier list/bundle fetch on it and avoid a wasted double fetch on
// the first-ever visit (re-key once the version resolves).
export function useWarehouseVersion(enabled: boolean): { version: string; ready: boolean } {
  const query = useQuery({
    queryKey: WAREHOUSE_VERSION_KEY,
    queryFn: async () => {
      const summary = await traceRequest(
        "warehouse_version.query",
        "clickhouse-summary:warehouse-version",
        () => getClickHouseSummary(),
        { edge_function: "clickhouse-summary", blocks_render: true },
      );
      return warehouseVersionFromSummary(summary);
    },
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  useEffect(() => {
    if (!enabled) return;
    traceEvent("warehouse_version.state", {
      status: query.status,
      fetch_status: query.fetchStatus,
      has_data: query.data != null,
      is_stale: query.isStale,
    });
  }, [enabled, query.status, query.fetchStatus, query.data, query.isStale]);
  return {
    version: (query.data as string | undefined) ?? "whv_unknown",
    ready: !enabled || query.isSuccess || query.isError || query.data != null,
  };
}

export function useSupportWarehouseVersion(enabled: boolean): { version: string; ready: boolean } {
  const query = useQuery({
    queryKey: SUPPORT_WAREHOUSE_VERSION_KEY,
    queryFn: async () => supportWarehouseVersionFromSummary(await getClickHouseSummary()),
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  return {
    version: (query.data as string | undefined) ?? "swhv_unknown",
    ready: !enabled || query.isSuccess || query.isError || query.data != null,
  };
}

// Honest staged progress driven by a fetch lifecycle, per-page duration namespace.
export function useAnalyticsProgress(params: {
  isFetching: boolean;
  status: "pending" | "error" | "success";
  activeKey: string;
  ns: string;
}): { percent: number; phase: ProgressPhase } {
  const [state, dispatch] = useReducer(progressReducer, INITIAL_PROGRESS);
  const medianRef = useRef(medianDuration(params.ns));
  const wasFetching = useRef(false);

  useEffect(() => {
    if (!params.isFetching) return;
    medianRef.current = medianDuration(params.ns);
    dispatch({ type: "start", key: params.activeKey, now: Date.now() });
    const tick = setInterval(() => dispatch({ type: "tick", now: Date.now(), medianMs: medianRef.current }), 120);
    return () => clearInterval(tick);
  }, [params.isFetching, params.activeKey, params.ns]);

  useEffect(() => {
    if (wasFetching.current && !params.isFetching) {
      if (params.status === "success") {
        dispatch({ type: "success", key: params.activeKey });
        const reset = setTimeout(() => dispatch({ type: "reset" }), 600);
        wasFetching.current = params.isFetching;
        return () => clearTimeout(reset);
      }
      dispatch({ type: "settle" });
    }
    wasFetching.current = params.isFetching;
  }, [params.isFetching, params.status, params.activeKey]);

  return { percent: Math.round(state.percent), phase: state.phase };
}

// ---- invalidation after CSV import + ClickHouse auto-sync ------------------
// Refetch the warehouse version FIRST (so keys advance to the new warehouse
// state), THEN invalidate every warehouse-dependent root (Cohorts, Users, Payment
// Analytics) at once. Active pages refetch; inactive pages refresh on next visit.
// Cached data is never deleted — on sync failure the caller simply does not call
// this, so stale cache stays visible.
export async function invalidateWarehouseAnalyticsCache(client: QueryClient): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: WAREHOUSE_VERSION_KEY }),
    client.invalidateQueries({ queryKey: SUPPORT_WAREHOUSE_VERSION_KEY }),
  ]);
  await Promise.all(
    WAREHOUSE_DEPENDENT_ROOTS.map((root) => client.invalidateQueries({ queryKey: [root] })),
  );
}


export async function invalidateSupportAnalyticsCache(client: QueryClient): Promise<void> {
  await client.invalidateQueries({ queryKey: SUPPORT_WAREHOUSE_VERSION_KEY });
  await client.invalidateQueries({ queryKey: ["support"] });
}
