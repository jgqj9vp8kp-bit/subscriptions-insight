// Payment System Health read-path hook: one cached query per action
// (stale-while-revalidate, keep-previous on filter change), keyed by the access
// partition and the warehouse version like usePaymentAnalyticsBundle. Generic
// building blocks come from useAnalyticsCache; the typed error classification
// comes from the data source, so the page branches on `error.kind` instead of
// parsing prose (a 403 renders NoAccess, a 4xx is never retried). The alert
// list and its two mutations (P2.5) follow at the end.

import { useMemo } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  describePaymentHealthError,
  isCompleteAlertsListResponse,
  isCompletePaymentHealthResponse,
  loadPaymentAlerts,
  loadPaymentHealth,
  normalizeAlertsFilters,
  runPaymentAlerts,
  updatePaymentAlert,
  type AlertStatusChange,
  type AlertUpdateResponse,
  type AlertsListResponse,
  type AlertsRunResponse,
  type PaymentAlertsFilters,
  type PaymentHealthAction,
  type PaymentHealthError,
  type PaymentHealthQuery,
  type PaymentHealthResponseFor,
} from "@/services/paymentHealthDataSource";
import {
  PAYMENT_HEALTH_ALERTS_QUERY_PREFIX,
  normalizePaymentHealthRequest,
  paymentHealthAlertsQueryKey,
  paymentHealthQueryKey,
} from "@/services/paymentHealthCache";
import { recordDuration } from "@/services/analyticsProgress";
import { GC_MS, STALE_MS, transientRetry, useAnalyticsProgress, useCacheScope } from "@/hooks/useAnalyticsCache";
import { traceHash, traceRequest } from "@/services/performanceTrace";

const NS = "payment-health";

/** What a tab's QueryFrame reads from any of the page's queries (actions and the alert list). */
export interface PaymentHealthQueryState<T> {
  /** The last complete response for this key (or the previous key's while the new one loads). */
  data: T | null;
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

export type UsePaymentHealthResult<A extends PaymentHealthAction> = PaymentHealthQueryState<PaymentHealthResponseFor<A>>;

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

// ---- payment risk alerts (P2.5) ----------------------------------------------

const ALERTS_NS = "payment-health-alerts";
/** Alerts change by people and by the daily run, not by imports: a minute keeps
 * tab switches cheap while a teammate's change shows up on the next focus. */
export const ALERTS_STALE_MS = 60 * 1000;

/** The alert list for one filter set (alerts_list), keyed by the access
 * partition. The page mounts the open-alerts query for the tab badge; the tab
 * mounts the filtered one (the same cache entry for the default filter). */
export function usePaymentAlertsQuery(params: { filters: Partial<PaymentAlertsFilters>; userScopeHash: string; enabled: boolean }): PaymentHealthQueryState<AlertsListResponse> {
  const userScopeHash = useCacheScope(params.userScopeHash);
  const enabled = params.enabled && userScopeHash !== "";
  const filters = useMemo(() => normalizeAlertsFilters(params.filters), [params.filters]);
  const queryKey = useMemo(() => paymentHealthAlertsQueryKey({ userScopeHash, filters }), [userScopeHash, filters]);
  const activeKey = useMemo(() => `alerts_list:${JSON.stringify(filters)}`, [filters]);
  const queryHash = useMemo(() => traceHash(queryKey), [queryKey]);

  const q = useQuery({
    queryKey,
    queryFn: async () => {
      const started = Date.now();
      const res = await traceRequest(
        "payment_health.alerts_list_request",
        `payment-health:alerts_list:${queryHash}`,
        () => loadPaymentAlerts(filters),
        { query_hash: queryHash, edge_function: "clickhouse-payment-health", action: "alerts_list" },
      );
      recordDuration(Date.now() - started, ALERTS_NS);
      return res;
    },
    enabled,
    placeholderData: keepPreviousData,
    staleTime: ALERTS_STALE_MS,
    gcTime: GC_MS,
    // As for the page's actions: a 4xx is never asked again. The tab badge and
    // the tab observe the same key, so a refused list must not be re-asked when
    // the second observer mounts (retryOnMount) or the window regains focus —
    // the error card's Retry asks again. A list that loaded is refreshed on
    // focus: a teammate's status change or the morning run shows up.
    retry: transientRetry,
    retryOnMount: false,
    refetchOnWindowFocus: (query) => query.state.status === "success",
    refetchOnReconnect: true,
  });

  const raw = (q.data as unknown) ?? null;
  const data = raw != null && isCompleteAlertsListResponse(raw) ? raw : null;
  const error = q.isError ? describePaymentHealthError(q.error) : null;
  const isFetching = q.isFetching && enabled;
  const progress = useAnalyticsProgress({ isFetching, status: q.status, activeKey, ns: ALERTS_NS });

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

/** alert_update. Never retried (a mutation's default); success OR failure
 * refetches every alert list — a refused transition usually means someone else
 * moved the alert first, and the list should say so. */
export function useAlertStatusMutation() {
  const client = useQueryClient();
  return useMutation<AlertUpdateResponse, unknown, AlertStatusChange>({
    mutationFn: (change) => updatePaymentAlert(change),
    onSettled: () => client.invalidateQueries({ queryKey: PAYMENT_HEALTH_ALERTS_QUERY_PREFIX }),
  });
}

/** alerts_run ("Run checks now"). A 429 (another run started < 5 min ago) also
 * refetches: the list then shows that run. */
export function useRunAlertsMutation() {
  const client = useQueryClient();
  return useMutation<AlertsRunResponse, unknown, void>({
    mutationFn: () => runPaymentAlerts(),
    onSettled: () => client.invalidateQueries({ queryKey: PAYMENT_HEALTH_ALERTS_QUERY_PREFIX }),
  });
}
