// Users read-path hooks: cached list + summary + options queries (stale-while-
// revalidate, keep-previous on filter/sort/page change). Mirrors useCohortsCache;
// generic building blocks come from useAnalyticsCache. Options are request-
// independent so they are cached once per (user, warehouse version) and never
// refetched on a filter/page change.

import { useEffect, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  loadUsersFromClickHouse,
  loadUsersSummaryFromClickHouse,
  loadUserOptionsFromClickHouse,
  type UsersQuery,
  type UsersSourceResult,
  type UsersSummary,
  type UsersFilterOptions,
} from "@/services/usersDataSource";
import { usersListKey, usersSummaryKey, usersOptionsKey, normalizeUsersRequest } from "@/services/usersCache";
import { recordDuration } from "@/services/analyticsProgress";
import { GC_MS, STALE_MS, transientRetry, useAnalyticsProgress } from "@/hooks/useAnalyticsCache";
import { traceEvent, traceHash, traceRequest } from "@/services/performanceTrace";

const NS = "users";

export interface UsersStatus {
  loading: boolean;
  error: string | null;
}

export interface UseUsersDataResult {
  chUsers: UsersSourceResult | null;
  chSummary: UsersSummary | null;
  chOptions: UsersFilterOptions | null;
  chStatus: UsersStatus;
  isBackgroundRefreshing: boolean;
  isInitialLoading: boolean;
  progressPercent: number;
  dataUpdatedAt: number;
}

export function useUsersData(params: {
  query: UsersQuery;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): UseUsersDataResult {
  const { query, userScopeHash, warehouseVersion, enabled } = params;

  const listKey = useMemo(() => usersListKey({ userScopeHash, warehouseVersion, request: query }), [userScopeHash, warehouseVersion, query]);
  const summaryKey = useMemo(() => usersSummaryKey({ userScopeHash, warehouseVersion, request: query }), [userScopeHash, warehouseVersion, query]);
  const optionsKey = useMemo(() => usersOptionsKey({ userScopeHash, warehouseVersion }), [userScopeHash, warehouseVersion]);
  const activeKey = useMemo(() => JSON.stringify(normalizeUsersRequest(query, { includePage: true })), [query]);
  const listHash = useMemo(() => traceHash(listKey), [listKey]);
  const summaryHash = useMemo(() => traceHash(summaryKey), [summaryKey]);
  const optionsHash = useMemo(() => traceHash(optionsKey), [optionsKey]);
  const requestHash = useMemo(() => traceHash(normalizeUsersRequest(query, { includePage: true })), [query]);

  const common = { enabled, staleTime: STALE_MS, gcTime: GC_MS, retry: transientRetry, refetchOnWindowFocus: false, refetchOnReconnect: true } as const;

  const listQ = useQuery({
    queryKey: listKey,
    queryFn: async () => {
      const started = Date.now();
      const res = await traceRequest(
        "users.list_request",
        `users:list:${listHash}`,
        () => loadUsersFromClickHouse(query),
        { query_hash: listHash, request_hash: requestHash, edge_function: "clickhouse-users" },
      );
      recordDuration(Date.now() - started, NS);
      return res;
    },
    placeholderData: keepPreviousData,
    ...common,
  });
  const summaryQ = useQuery({
    queryKey: summaryKey,
    queryFn: () => traceRequest(
      "users.summary_request",
      `users:summary:${summaryHash}`,
      () => loadUsersSummaryFromClickHouse(query),
      { query_hash: summaryHash, request_hash: requestHash, edge_function: "clickhouse-users" },
    ),
    placeholderData: keepPreviousData,
    ...common,
  });
  const optionsQ = useQuery({
    queryKey: optionsKey,
    queryFn: () => traceRequest(
      "users.options_request",
      `users:options:${optionsHash}`,
      () => loadUserOptionsFromClickHouse(),
      { query_hash: optionsHash, edge_function: "clickhouse-users" },
    ),
    ...common,
  });

  const chUsers = (listQ.data as UsersSourceResult | undefined) ?? null;
  const chSummary = (summaryQ.data as UsersSummary | null | undefined) ?? null;
  const chOptions = (optionsQ.data as UsersFilterOptions | null | undefined) ?? null;
  const anyFetching = enabled && (listQ.isFetching || summaryQ.isFetching || optionsQ.isFetching);

  const erroring = [listQ, summaryQ, optionsQ].find((q) => q.isError);
  const error = erroring
    ? (erroring.error instanceof Error ? erroring.error.message : "ClickHouse users request failed")
    : null;

  const progress = useAnalyticsProgress({ isFetching: listQ.isFetching && enabled, status: listQ.status, activeKey, ns: NS });

  useEffect(() => {
    traceEvent("users.query_state", {
      enabled,
      list_hash: listHash,
      summary_hash: summaryHash,
      options_hash: optionsHash,
      request_hash: requestHash,
      warehouse_version_state: warehouseVersion === "whv_unknown" ? "unknown" : "known",
      has_list_data: chUsers != null,
      has_summary_data: chSummary != null,
      has_options_data: chOptions != null,
      list_status: listQ.status,
      list_fetch_status: listQ.fetchStatus,
      is_stale: listQ.isStale,
      data_updated_at: listQ.dataUpdatedAt ? "present" : "missing",
    });
  }, [enabled, listHash, summaryHash, optionsHash, requestHash, warehouseVersion, chUsers, chSummary, chOptions, listQ.status, listQ.fetchStatus, listQ.isStale, listQ.dataUpdatedAt]);

  return {
    chUsers,
    chSummary,
    chOptions,
    chStatus: { loading: anyFetching, error },
    isBackgroundRefreshing: listQ.isFetching && chUsers != null,
    isInitialLoading: listQ.isFetching && chUsers == null,
    progressPercent: progress.percent,
    dataUpdatedAt: listQ.dataUpdatedAt,
  };
}
