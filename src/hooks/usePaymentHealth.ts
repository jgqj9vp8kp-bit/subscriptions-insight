// Payment System Health read-path hook: one cached query per action
// (stale-while-revalidate, keep-previous on filter change), keyed by the access
// partition and the warehouse version like usePaymentAnalyticsBundle. Generic
// building blocks come from useAnalyticsCache; the typed error classification
// comes from the data source, so the page branches on `error.kind` instead of
// parsing prose (a 403 renders NoAccess, a 4xx is never retried).

import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  describePaymentHealthError,
  isCompletePaymentHealthResponse,
  loadPaymentHealth,
  type PaymentHealthAction,
  type PaymentHealthError,
  type PaymentHealthQuery,
  type PaymentHealthResponseFor,
} from "@/services/paymentHealthDataSource";
import { normalizePaymentHealthRequest, paymentHealthQueryKey } from "@/services/paymentHealthCache";
import { recordDuration } from "@/services/analyticsProgress";
import { GC_MS, STALE_MS, transientRetry, useAnalyticsProgress, useCacheScope } from "@/hooks/useAnalyticsCache";
import { traceHash, traceRequest } from "@/services/performanceTrace";

const NS = "payment-health";

export interface UsePaymentHealthResult<A extends PaymentHealthAction> {
  /** The last complete response for this key (or the previous key's while the new one loads). */
  data: PaymentHealthResponseFor<A> | null;
  error: PaymentHealthError | null;
  /** Fetching with nothing to show yet. */
  isInitialLoading: boolean;
  /** Fetching while a (cached or previous) response stays visible. */
  isBackgroundRefreshing: boolean;
  isFetching: boolean;
  /** No request may be sent right now: access unresolved, the warehouse version pending, or the page's own guard (an invalid window, a remembered PSP selection waiting for the options answer). */
  isDisabled: boolean;
  progressPercent: number;
  dataUpdatedAt: number;
  refetch: () => void;
}

export function usePaymentHealthQuery<A extends PaymentHealthAction>(params: {
  action: A;
  query: PaymentHealthQuery;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): UsePaymentHealthResult<A> {
  const { action, query, warehouseVersion } = params;
  const userScopeHash = useCacheScope(params.userScopeHash);
  // "" ⇒ access unresolved or grants nothing: no request may be sent.
  const enabled = params.enabled && userScopeHash !== "";
  const queryKey = useMemo(
    () => paymentHealthQueryKey({ userScopeHash, warehouseVersion, action, request: query }),
    [userScopeHash, warehouseVersion, action, query],
  );
  const activeKey = useMemo(() => `${action}:${JSON.stringify(normalizePaymentHealthRequest(action, query))}`, [action, query]);
  const queryHash = useMemo(() => traceHash(queryKey), [queryKey]);

  const q = useQuery({
    queryKey,
    queryFn: async () => {
      const started = Date.now();
      const res = await traceRequest(
        `payment_health.${action}_request`,
        `payment-health:${action}:${queryHash}`,
        () => loadPaymentHealth(action, query),
        { query_hash: queryHash, edge_function: "clickhouse-payment-health", action },
      );
      recordDuration(Date.now() - started, NS);
      return res;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    // Transient failures only: a 4xx (the request or the caller's access) is
    // never asked again, an access-layer code is retried by the access refresh.
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  const raw = (q.data as unknown) ?? null;
  // A persisted entry of an older layout is ignored (the key's schema version
  // guards the common case; this guards a hand-edited or partial envelope).
  const data = raw != null && isCompletePaymentHealthResponse(action, raw) ? (raw as PaymentHealthResponseFor<A>) : null;
  const error = q.isError ? describePaymentHealthError(q.error) : null;
  const isFetching = q.isFetching && enabled;
  const progress = useAnalyticsProgress({ isFetching, status: q.status, activeKey, ns: NS });

  return {
    data,
    error,
    isInitialLoading: isFetching && data == null,
    isBackgroundRefreshing: isFetching && data != null,
    isFetching,
    isDisabled: !enabled,
    progressPercent: progress.percent,
    dataUpdatedAt: q.dataUpdatedAt,
    refetch: () => {
      void q.refetch();
    },
  };
}
