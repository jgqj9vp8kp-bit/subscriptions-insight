// The Cohorts "Product" map (clickhouse-cohorts action product_paths: which
// campaign paths belong to which FunnelFox project), as a cached query so the
// Users cohort panel can filter by product too. Its policy is anyOf
// cohorts.view and the action is full-scope only, so it is never requested for
// a funnel-restricted member or without that permission — asking anyway is a
// guaranteed 403 that only raises the access-denial counters.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useOptionalAccess } from "@/hooks/useAccess";
import { GC_MS, STALE_MS, transientRetry, useCacheScope } from "@/hooks/useAnalyticsCache";
import { runClickHouseCohortProducts } from "@/services/clickhouse";
import { COHORTS_QUERY_ROOT } from "@/services/cohortsCache";
import type { CohortProductOption } from "@/services/cohortProductFilter";
import { traceRequest } from "@/services/performanceTrace";

// Under the warehouse-dependent "cohorts" root: invalidated with the other
// cohort entries after an import and persisted per partition (a non-PII
// aggregate).
export function cohortProductsKey(partition: string, warehouseVersion: string) {
  return [COHORTS_QUERY_ROOT, "products", partition, warehouseVersion] as const;
}

export function useCohortProducts(params: { userScopeHash: string; warehouseVersion: string; enabled: boolean }): {
  /** null = no product filter (not requested, failed, or still loading). */
  products: CohortProductOption[] | null;
  /** The map has answered, failed or is not requested at all. */
  settled: boolean;
} {
  const access = useOptionalAccess();
  const partition = useCacheScope(params.userScopeHash);
  const allowed = !access || (!access.restricted && access.can("cohorts.view"));
  const enabled = params.enabled && allowed && partition !== "";
  const query = useQuery({
    queryKey: cohortProductsKey(partition, params.warehouseVersion),
    queryFn: () => traceRequest(
      "cohorts.products_request",
      "cohorts:products",
      async () => {
        const response = await runClickHouseCohortProducts();
        return Array.isArray(response.products) ? response.products : [];
      },
      { edge_function: "clickhouse-cohorts" },
    ),
    enabled,
    staleTime: STALE_MS,
    gcTime: GC_MS,
    // No retry on a 403 or an open breaker: the row is simply hidden.
    retry: transientRetry,
    refetchOnWindowFocus: false,
    // A warehouse-version bump must not drop the map (and with it widen the
    // users query) while the new version loads.
    placeholderData: keepPreviousData,
  });
  return {
    products: enabled ? (query.data ?? null) : null,
    settled: !enabled || query.data !== undefined || query.isError,
  };
}
