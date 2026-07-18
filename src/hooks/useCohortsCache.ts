// Cohorts read-path hooks: the cached cohorts LIST query (stale-while-revalidate,
// keep-previous on filter change, latest-wins), plus a prefetch helper. Generic
// building blocks (warehouse version, progress, retry, invalidation) come from
// useAnalyticsCache and are re-exported for existing importers.

import { useEffect, useMemo } from "react";
import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { getClickHouseSummary } from "@/services/clickhouse";
import { loadCohortsFromClickHouse, cohortFilterReproductionStatus, type CohortsSourceResult } from "@/services/cohortsDataSource";
import { cohortsListKey, normalizeCohortRequest, warehouseVersionFromSummary, WAREHOUSE_VERSION_KEY } from "@/services/cohortsCache";
import { recordDuration, type ProgressPhase } from "@/services/analyticsProgress";
import {
  GC_MS,
  STALE_MS,
  transientRetry,
  useAnalyticsProgress,
  useWarehouseVersion,
} from "@/hooks/useAnalyticsCache";
import { traceEvent, traceHash, traceRequest } from "@/services/performanceTrace";
import type { CohortRequest, CohortResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract";

export { useWarehouseVersion, invalidateWarehouseAnalyticsCache } from "@/hooks/useAnalyticsCache";

const NS = "cohorts";

function activeFilterFlags(request: CohortRequest) {
  const f = request.filters ?? {};
  return {
    country: (f.country?.length ?? 0) > 0,
    card_type: (f.card_type?.length ?? 0) > 0,
    campaign_id: (f.campaign_id?.length ?? 0) > 0,
    traffic_source: (f.traffic_source?.length ?? 0) > 0,
    price_plan: (f.price_plan?.length ?? 0) > 0,
  };
}

export interface CohortsStatus {
  loading: boolean;
  error: string | null;
  durationMs: number | null;
  subStatus: string | null;
  applicable: boolean;
  unsupportedFilters: string[];
  fallbackReason: string | null;
  filtersApplied: CohortResponse["diagnostics"]["filters_applied"] | null;
}

export interface UseCohortsListResult {
  chResult: CohortsSourceResult | null;
  chStatus: CohortsStatus;
  isBackgroundRefreshing: boolean;
  isInitialLoading: boolean;
  progressPercent: number;
  dataUpdatedAt: number;
  isStale: boolean;
  /**
   * True when `chResult` was fetched for the CURRENT normalized request — i.e. its
   * cascading filter_options describe the active filter scope. False while
   * keepPreviousData is showing the previous scope's response (whose option lists
   * belong to the OLD filters). Downstream-selection pruning must only run when
   * this is true, or a stale global option list would clear valid selections.
   */
  isFilterScopeCurrent: boolean;
}

export function useCohortsListQuery(params: {
  request: CohortRequest;
  dataSource: "clickhouse" | "legacy";
  userScopeHash: string;
  warehouseVersion: string;
  /** FB warehouse fingerprint — re-keys the report after an FB sync (separate lifecycle). */
  fbWarehouseVersion?: string;
  enabled: boolean;
}): UseCohortsListResult {
  const { request, dataSource, userScopeHash, warehouseVersion, fbWarehouseVersion, enabled } = params;
  const queryKey = useMemo(
    () => cohortsListKey({ userScopeHash, dataSource, warehouseVersion, fbWarehouseVersion, request }),
    [userScopeHash, dataSource, warehouseVersion, fbWarehouseVersion, request],
  );
  const activeKey = useMemo(() => JSON.stringify(normalizeCohortRequest(request)), [request]);
  const queryHash = useMemo(() => traceHash(queryKey), [queryKey]);
  const requestHash = useMemo(() => traceHash(normalizeCohortRequest(request)), [request]);

  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const started = Date.now();
      const res = await traceRequest(
        "cohorts.list_request",
        `cohorts:list:${queryHash}`,
        () => loadCohortsFromClickHouse(request),
        { query_hash: queryHash, request_hash: requestHash, edge_function: "clickhouse-cohorts" },
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

  const data = (query.data as CohortsSourceResult | undefined) ?? null;
  const hasData = data != null;
  const errorMessage = query.isError ? (query.error instanceof Error ? query.error.message : "ClickHouse cohorts request failed") : null;
  const normalizedRequest = useMemo(() => normalizeCohortRequest(request), [request]);
  const activeFilters = useMemo(() => {
    const filters = normalizedRequest;
    return {
      date_range: Boolean(filters.date_from || filters.date_to),
      funnel: filters.funnel.length > 0,
      campaign_path: filters.campaign_path.length > 0,
      refund_status: filters.refund_status !== "all",
      media_buyer: filters.media_buyer.length > 0,
      currency: filters.currency.length > 0,
      country: filters.country.length > 0,
      card_type: filters.card_type.length > 0,
      campaign_id: filters.campaign_id.length > 0,
      traffic_source: filters.traffic_source.length > 0,
      price_plan: filters.price_plan.length > 0,
    };
  }, [normalizedRequest]);
  const reproduction = useMemo(
    () =>
      data
        ? cohortFilterReproductionStatus(data.diagnostics, activeFilterFlags(request))
        : { applicable: true, unsupportedFilters: [] as string[], reason: "No ClickHouse data yet.", filtersApplied: null },
    [data, request],
  );
  const applicable = reproduction.applicable;

  const progress = useAnalyticsProgress({ isFetching: query.isFetching && enabled, status: query.status, activeKey, ns: NS });

  useEffect(() => {
    traceEvent("cohorts.query_state", {
      enabled,
      query_hash: queryHash,
      request_hash: requestHash,
      warehouse_version_state: warehouseVersion === "whv_unknown" ? "unknown" : "known",
      has_data: hasData,
      status: query.status,
      fetch_status: query.fetchStatus,
      is_stale: query.isStale,
      data_updated_at: query.dataUpdatedAt ? "present" : "missing",
    });
    if (import.meta.env.DEV && !(typeof process !== "undefined" && process.env.VITEST)) {
      console.debug("[Cohorts ClickHouse decision]", {
        normalized_request: normalizedRequest,
        active_filters: activeFilters,
        filters_applied: reproduction.filtersApplied,
        unsupported_filters: reproduction.unsupportedFilters,
        applicable: reproduction.applicable,
        reason: reproduction.reason,
        query_key: queryKey,
        query_hash: queryHash,
        warehouseVersion,
        data_source_selection: dataSource,
      });
    }
  }, [activeFilters, dataSource, enabled, normalizedRequest, queryHash, queryKey, requestHash, reproduction, warehouseVersion, hasData, query.status, query.fetchStatus, query.isStale, query.dataUpdatedAt]);

  return {
    chResult: data,
    chStatus: {
      loading: query.isFetching && enabled,
      error: errorMessage,
      durationMs: data?.durationMs ?? null,
      subStatus: data?.subscriptionDataStatus ?? null,
      applicable,
      unsupportedFilters: reproduction.unsupportedFilters,
      fallbackReason: reproduction.applicable ? null : reproduction.reason,
      filtersApplied: reproduction.filtersApplied,
    },
    isBackgroundRefreshing: query.isFetching && hasData,
    isInitialLoading: query.isFetching && !hasData,
    progressPercent: progress.percent,
    dataUpdatedAt: query.dataUpdatedAt,
    isStale: query.isStale,
    // Placeholder data = the PREVIOUS filter scope's response (keepPreviousData).
    // Its option lists are scoped to the old filters, so they are not authoritative
    // for pruning now-invalid selections.
    isFilterScopeCurrent: hasData && !query.isPlaceholderData,
  };
}

// ---- prefetch (nav hover/focus) -------------------------------------------
export function prefetchCohortsList(
  client: QueryClient,
  params: { request: CohortRequest; dataSource: "clickhouse" | "legacy"; userScopeHash: string; warehouseVersion: string },
): void {
  void client.prefetchQuery({
    queryKey: cohortsListKey(params),
    queryFn: async () => {
      const started = Date.now();
      const key = cohortsListKey(params);
      const res = await traceRequest(
        "cohorts.prefetch_list_request",
        `cohorts:prefetch:${traceHash(key)}`,
        () => loadCohortsFromClickHouse(params.request),
        { query_hash: traceHash(key), edge_function: "clickhouse-cohorts" },
      );
      recordDuration(Date.now() - started, NS);
      return res;
    },
    staleTime: STALE_MS,
  });
}

export function prefetchCohortsNav(client: QueryClient, userScopeHash: string, maxRenewalDepth: number): void {
  void client.ensureQueryData({
    queryKey: WAREHOUSE_VERSION_KEY,
    queryFn: async () => warehouseVersionFromSummary(await getClickHouseSummary()),
    staleTime: STALE_MS,
  }).then((warehouseVersion) => {
    const request: CohortRequest = {
      action: "list",
      date_from: null,
      date_to: null,
      filters: { funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
      max_renewal_depth: maxRenewalDepth,
    };
    prefetchCohortsList(client, { request, dataSource: "clickhouse", userScopeHash, warehouseVersion });
  }).catch(() => {
    traceEvent("cohorts.prefetch_skipped", { reason: "warehouse_version_unavailable" });
  });
}

export function useCohortsQueryClient(): QueryClient {
  return useQueryClient();
}
