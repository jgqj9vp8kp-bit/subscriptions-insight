// SWR wiring for the Banks tab (mirrors usePaymentAnalyticsCache): stale data
// stays visible while refetching, a failed refresh keeps the cached bundle, and
// the key carries the warehouse version so a sync rotates it.
import { useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { GC_MS, STALE_MS, transientRetry } from "@/hooks/useAnalyticsCache";
import { bankAnalyticsBundleKey, bankDetailKey } from "@/services/bankAnalyticsCache";
import {
  loadBankAnalytics,
  loadBankDetail,
  type BankAnalyticsBundle,
  type BankAnalyticsQuery,
  type BankDetailBundle,
} from "@/services/bankAnalyticsDataSource";

export function useBankAnalyticsBundle(params: {
  query: BankAnalyticsQuery;
  userScopeHash: string;
  warehouseVersion: string;
  enabled: boolean;
}): {
  bundle: BankAnalyticsBundle | null;
  error: string | null;
  isFetching: boolean;
  isInitialLoading: boolean;
} {
  const { query, userScopeHash, warehouseVersion, enabled } = params;
  const queryKey = useMemo(
    () => bankAnalyticsBundleKey({ userScopeHash, warehouseVersion, request: query }),
    [userScopeHash, warehouseVersion, query],
  );

  const q = useQuery({
    queryKey,
    queryFn: () => loadBankAnalytics(query),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });

  return {
    bundle: (q.data as BankAnalyticsBundle | undefined) ?? null,
    error: q.isError ? (q.error instanceof Error ? q.error.message : "ClickHouse request failed") : null,
    isFetching: q.isFetching,
    isInitialLoading: q.isLoading,
  };
}

export function useBankDetail(params: {
  query: BankAnalyticsQuery;
  userScopeHash: string;
  warehouseVersion: string;
  issuerKey: string | null;
}): { detail: BankDetailBundle | null; error: string | null; isLoading: boolean } {
  const { query, userScopeHash, warehouseVersion, issuerKey } = params;
  const queryKey = useMemo(
    () => bankDetailKey({ userScopeHash, warehouseVersion, request: query, issuerKey: issuerKey ?? "none" }),
    [userScopeHash, warehouseVersion, query, issuerKey],
  );

  const q = useQuery({
    queryKey,
    queryFn: () => loadBankDetail(query, issuerKey ?? ""),
    // Lazy: fetched only once a row is expanded.
    enabled: issuerKey !== null,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    retry: transientRetry,
    refetchOnWindowFocus: false,
  });

  return {
    detail: (q.data as BankDetailBundle | undefined) ?? null,
    error: q.isError ? (q.error instanceof Error ? q.error.message : "ClickHouse request failed") : null,
    isLoading: q.isLoading && issuerKey !== null,
  };
}
