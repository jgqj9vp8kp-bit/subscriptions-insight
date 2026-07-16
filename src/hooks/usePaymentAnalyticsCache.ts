// Payment Pass Analytics read-path hook: one cached bundle query (stale-while-
// revalidate, keep-previous on filter/selector change). Mirrors useCohortsCache;
// generic building blocks come from useAnalyticsCache.

import { useEffect, useMemo, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  isCompletePaymentAnalyticsBundle,
  loadPaymentAnalytics,
  type PaymentAnalyticsQuery,
  type PaymentAnalyticsBundle,
} from "@/services/paymentAnalyticsDataSource";
import { paymentAnalyticsBundleKey, normalizePaymentRequest } from "@/services/paymentAnalyticsCache";
import { recordDuration } from "@/services/analyticsProgress";
import { GC_MS, STALE_MS, transientRetry, useAnalyticsProgress } from "@/hooks/useAnalyticsCache";
import { traceEvent, traceHash, traceRequest } from "@/services/performanceTrace";

const NS = "payment";

export interface PaymentAnalyticsStatus {
  loading: boolean;
  error: string | null;
}

export interface UsePaymentAnalyticsResult {
  chBundle: PaymentAnalyticsBundle | null;
  chStatus: PaymentAnalyticsStatus;
  isBackgroundRefreshing: boolean;
  isInitialLoading: boolean;
  progressPercent: number;
  dataUpdatedAt: number;
}

export function usePaymentAnalyticsBundle(params: {
  query: PaymentAnalyticsQuery;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): UsePaymentAnalyticsResult {
  const { query, userScopeHash, warehouseVersion, enabled } = params;
  const queryKey = useMemo(
    () => paymentAnalyticsBundleKey({ userScopeHash, warehouseVersion, request: query }),
    [userScopeHash, warehouseVersion, query],
  );
  const activeKey = useMemo(() => JSON.stringify(normalizePaymentRequest(query)), [query]);
  const queryHash = useMemo(() => traceHash(queryKey), [queryKey]);
  const requestHash = useMemo(() => traceHash(normalizePaymentRequest(query)), [query]);
  const invalidRefetchKeyRef = useRef<string | null>(null);

  const q = useQuery({
    queryKey,
    queryFn: async () => {
      const started = Date.now();
      const res = await traceRequest(
        "payment_pass.bundle_request",
        `payment:bundle:${queryHash}`,
        () => loadPaymentAnalytics(query),
        { query_hash: queryHash, request_hash: requestHash, edge_function: "clickhouse-payment-analytics" },
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

  const rawBundle = (q.data as PaymentAnalyticsBundle | undefined) ?? null;
  const chBundle = isCompletePaymentAnalyticsBundle(rawBundle) ? rawBundle : null;
  const error = q.isError ? (q.error instanceof Error ? q.error.message : "ClickHouse request failed") : null;
  const isFetching = q.isFetching;
  const refetch = q.refetch;
  const progress = useAnalyticsProgress({ isFetching: isFetching && enabled, status: q.status, activeKey, ns: NS });

  useEffect(() => {
    traceEvent("payment_pass.query_state", {
      enabled,
      query_hash: queryHash,
      request_hash: requestHash,
      warehouse_version_state: warehouseVersion === "whv_unknown" ? "unknown" : "known",
      has_data: chBundle != null,
      invalid_cached_bundle: rawBundle != null && chBundle == null,
      status: q.status,
      fetch_status: q.fetchStatus,
      is_stale: q.isStale,
      data_updated_at: q.dataUpdatedAt ? "present" : "missing",
    });
  }, [enabled, queryHash, requestHash, warehouseVersion, rawBundle, chBundle, q.status, q.fetchStatus, q.isStale, q.dataUpdatedAt]);

  useEffect(() => {
    if (!enabled || rawBundle == null || chBundle != null || isFetching || invalidRefetchKeyRef.current === queryHash) return;
    invalidRefetchKeyRef.current = queryHash;
    void refetch();
  }, [enabled, rawBundle, chBundle, isFetching, refetch, queryHash]);

  return {
    chBundle,
    chStatus: { loading: isFetching && enabled, error },
    isBackgroundRefreshing: isFetching && chBundle != null,
    isInitialLoading: isFetching && chBundle == null,
    progressPercent: progress.percent,
    dataUpdatedAt: q.dataUpdatedAt,
  };
}
