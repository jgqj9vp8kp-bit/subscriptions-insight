// FB Analytics warehouse hooks: the cached status/version query plus the ONE
// atomic report-bundle query (stale-while-revalidate, keep-previous on filter
// change). Mirrors useCohortsCache / usePaymentAnalyticsCache; shared building
// blocks (STALE_MS, retry, progress) come from useAnalyticsCache.

import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FB_WAREHOUSE_VERSION_KEY,
  fbReportKey,
  fbWarehouseVersionFromStatus,
  isCompleteFbReport,
  loadFbReport,
  loadFbStatus,
  normalizeFbReportQuery,
  type FbReportQuery,
  type FbReportResponse,
  type FbStatusResponse,
} from "@/services/fbWarehouse";
import { recordDuration } from "@/services/analyticsProgress";
import { GC_MS, STALE_MS, transientRetry, useAnalyticsProgress } from "@/hooks/useAnalyticsCache";
import { traceHash, traceRequest } from "@/services/performanceTrace";

const NS = "fb-analytics";

export function useFbWarehouseStatus(enabled: boolean): {
  status: FbStatusResponse | null;
  version: string;
  ready: boolean;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: [...FB_WAREHOUSE_VERSION_KEY],
    queryFn: async () =>
      traceRequest("fb_warehouse.status", "clickhouse-facebook:status", () => loadFbStatus(), {
        edge_function: "clickhouse-facebook",
      }),
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
  const status = (query.data as FbStatusResponse | undefined) ?? null;
  return {
    status,
    version: fbWarehouseVersionFromStatus(status),
    ready: !enabled || query.isSuccess || query.isError,
    refetch: () => void query.refetch(),
  };
}

export interface UseFbReportResult {
  report: FbReportResponse | null;
  loading: boolean;
  error: string | null;
  isBackgroundRefreshing: boolean;
  isInitialLoading: boolean;
  progressPercent: number;
  dataUpdatedAt: number;
}

export function useFbReportQuery(params: {
  query: FbReportQuery;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): UseFbReportResult {
  const { query, userScopeHash, warehouseVersion, enabled } = params;
  const queryKey = useMemo(
    () => fbReportKey({ userScopeHash, warehouseVersion, query }),
    [userScopeHash, warehouseVersion, query],
  );
  const activeKey = useMemo(() => JSON.stringify(normalizeFbReportQuery(query)), [query]);
  const queryHash = useMemo(() => traceHash(queryKey), [queryKey]);
  const invalidRefetchKeyRef = useRef<string | null>(null);

  const q = useQuery({
    queryKey,
    queryFn: async () => {
      const started = Date.now();
      const res = await traceRequest(
        "fb_warehouse.report",
        `fb:report:${queryHash}`,
        () => loadFbReport(query),
        { query_hash: queryHash, edge_function: "clickhouse-facebook" },
      );
      recordDuration(Date.now() - started, NS);
      return res;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  // Reject schema-incompatible bundles (rehydrated from an older session) —
  // render nothing rather than crash, and refetch once per key.
  const rawReport = (q.data as FbReportResponse | undefined) ?? null;
  const report = isCompleteFbReport(rawReport) ? rawReport : null;
  const isFetching = q.isFetching;
  const refetch = q.refetch;
  const progress = useAnalyticsProgress({ isFetching: isFetching && enabled, status: q.status, activeKey, ns: NS });

  useEffect(() => {
    if (!enabled || rawReport == null || report != null || isFetching || invalidRefetchKeyRef.current === queryHash) return;
    invalidRefetchKeyRef.current = queryHash;
    void refetch();
  }, [enabled, rawReport, report, isFetching, refetch, queryHash]);

  return {
    report,
    loading: isFetching && enabled,
    error: q.isError ? (q.error instanceof Error ? q.error.message : "FB Analytics request failed") : null,
    isBackgroundRefreshing: isFetching && report != null,
    isInitialLoading: isFetching && report == null,
    progressPercent: progress.percent,
    dataUpdatedAt: q.dataUpdatedAt,
  };
}

/** Invalidate the FB warehouse version + every fb-analytics query (after a sync). */
export function useInvalidateFbWarehouse(): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await client.invalidateQueries({ queryKey: [...FB_WAREHOUSE_VERSION_KEY] });
    await client.invalidateQueries({ queryKey: ["fb-analytics"] });
  };
}
