import { useEffect, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { recordDuration } from "@/services/analyticsProgress";
import { GC_MS, STALE_MS, transientRetry, useAnalyticsProgress } from "@/hooks/useAnalyticsCache";
import {
  loadSupportBundle,
  loadSupportPage,
  type SupportAnalyticsBundle,
  type SupportListResponse,
  type SupportQuery,
} from "@/services/supportDataSource";
import { normalizeSupportRequest, supportBundleKey, supportListKey } from "@/services/supportCache";
import { traceEvent, traceHash, traceRequest } from "@/services/performanceTrace";

const NS = "support";

export interface UseSupportDataResult {
  bundle: SupportAnalyticsBundle | null;
  page: SupportListResponse | null;
  status: { loading: boolean; error: string | null };
  isBackgroundRefreshing: boolean;
  isInitialLoading: boolean;
  progressPercent: number;
  dataUpdatedAt: number;
}

export function useSupportData(params: {
  query: SupportQuery;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): UseSupportDataResult {
  const { query, userScopeHash, warehouseVersion, enabled } = params;
  const bundleKey = useMemo(() => supportBundleKey({ userScopeHash, warehouseVersion, request: query }), [userScopeHash, warehouseVersion, query]);
  const listKey = useMemo(() => supportListKey({ userScopeHash, warehouseVersion, request: query }), [userScopeHash, warehouseVersion, query]);
  const bundleHash = useMemo(() => traceHash(bundleKey), [bundleKey]);
  const listHash = useMemo(() => traceHash(listKey), [listKey]);
  const requestHash = useMemo(() => traceHash(normalizeSupportRequest(query, { includePage: true })), [query]);
  const activeKey = useMemo(() => JSON.stringify(normalizeSupportRequest(query, { includePage: true })), [query]);
  const common = { enabled, staleTime: STALE_MS, gcTime: GC_MS, retry: transientRetry, refetchOnWindowFocus: false, refetchOnReconnect: true } as const;

  const bundleQ = useQuery({
    queryKey: bundleKey,
    queryFn: () => traceRequest(
      "support.bundle_request",
      `support:bundle:${bundleHash}`,
      () => loadSupportBundle(query),
      { query_hash: bundleHash, request_hash: requestHash, edge_function: "clickhouse-support" },
    ),
    placeholderData: keepPreviousData,
    ...common,
  });
  const listQ = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const started = Date.now();
      const result = await traceRequest(
        "support.list_request",
        `support:list:${listHash}`,
        () => loadSupportPage(query),
        { query_hash: listHash, request_hash: requestHash, edge_function: "clickhouse-support" },
      );
      recordDuration(Date.now() - started, NS);
      return result;
    },
    placeholderData: keepPreviousData,
    ...common,
  });

  const bundle = (bundleQ.data as SupportAnalyticsBundle | undefined) ?? null;
  const page = (listQ.data as SupportListResponse | undefined) ?? null;
  const erroring = [bundleQ, listQ].find((q) => q.isError);
  const error = erroring ? (erroring.error instanceof Error ? erroring.error.message : "ClickHouse support request failed") : null;
  const progress = useAnalyticsProgress({ isFetching: listQ.isFetching && enabled, status: listQ.status, activeKey, ns: NS });

  useEffect(() => {
    traceEvent("support.query_state", {
      enabled,
      bundle_hash: bundleHash,
      list_hash: listHash,
      request_hash: requestHash,
      warehouse_version_state: warehouseVersion === "whv_unknown" ? "unknown" : "known",
      has_bundle_data: bundle != null,
      has_list_data: page != null,
      list_status: listQ.status,
      list_fetch_status: listQ.fetchStatus,
      is_stale: listQ.isStale,
      data_updated_at: listQ.dataUpdatedAt ? "present" : "missing",
    });
  }, [enabled, bundleHash, listHash, requestHash, warehouseVersion, bundle, page, listQ.status, listQ.fetchStatus, listQ.isStale, listQ.dataUpdatedAt]);

  return {
    bundle,
    page,
    status: { loading: enabled && (bundleQ.isFetching || listQ.isFetching), error },
    isBackgroundRefreshing: listQ.isFetching && page != null,
    isInitialLoading: listQ.isFetching && page == null,
    progressPercent: progress.percent,
    dataUpdatedAt: Math.max(bundleQ.dataUpdatedAt, listQ.dataUpdatedAt),
  };
}
