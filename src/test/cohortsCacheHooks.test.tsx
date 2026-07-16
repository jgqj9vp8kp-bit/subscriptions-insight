import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Mock only the network loader; keep filtersFullyReproduced real.
vi.mock("@/services/cohortsDataSource", async (importActual) => {
  const actual = await importActual<typeof import("@/services/cohortsDataSource")>();
  return { ...actual, loadCohortsFromClickHouse: vi.fn() };
});

import { loadCohortsFromClickHouse } from "@/services/cohortsDataSource";
import { invalidateWarehouseAnalyticsCache, useCohortsListQuery } from "@/hooks/useCohortsCache";
import { cohortsListKey } from "@/services/cohortsCache";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

const load = loadCohortsFromClickHouse as unknown as ReturnType<typeof vi.fn>;

const SCOPE = "u_test";
const WHV = "whv_test";
const reqWith = (funnel: string[]): CohortRequest => ({
  action: "list",
  date_from: null,
  date_to: null,
  filters: { funnel, campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
  max_renewal_depth: 6,
});
const keyFor = (request: CohortRequest) => cohortsListKey({ userScopeHash: SCOPE, dataSource: "clickhouse", warehouseVersion: WHV, request });
const result = (cohorts: Array<{ cohort_id: string }>, extra: Record<string, unknown> = {}) => ({
  cohorts,
  source: "clickhouse" as const,
  durationMs: 5,
  diagnostics: {
    filters_applied: {
      date_range: false,
      funnel: false,
      campaign_path: false,
      refund_status: false,
      media_buyer: false,
      currency: false,
      country: true,
      card_type: true,
      campaign_id: true,
      traffic_source: true,
      price_plan: true,
    },
  },
  ...extra,
});

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
function mountList(request: CohortRequest, enabled = true) {
  return renderHook(
    (props: { request: CohortRequest }) =>
      useCohortsListQuery({ request: props.request, dataSource: "clickhouse", userScopeHash: SCOPE, warehouseVersion: WHV, enabled }),
    { wrapper, initialProps: { request } },
  );
}
function markStale(request: CohortRequest, ageMs: number) {
  const q = client.getQueryCache().find({ queryKey: keyFor(request) });
  if (q) q.state.dataUpdatedAt = Date.now() - ageMs;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  load.mockReset();
});
afterEach(() => client.clear());

describe("useCohortsListQuery — stale-while-revalidate", () => {
  it("#1 renders cached rows immediately on (re)mount", () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "a" }]));
    const { result: r } = mountList(reqWith([]));
    expect(r.current.chResult?.cohorts).toHaveLength(1);
    expect(r.current.isInitialLoading).toBe(false);
  });

  it("#2 does NOT refetch when the cache is fresh", async () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "a" }]));
    mountList(reqWith([]));
    await new Promise((res) => setTimeout(res, 20));
    expect(load).not.toHaveBeenCalled();
  });

  it("#3 stale cache renders rows AND triggers a background refetch", async () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "old" }]));
    markStale(reqWith([]), 10 * 60 * 1000);
    load.mockResolvedValueOnce(result([{ cohort_id: "fresh" }]));
    const { result: r } = mountList(reqWith([]));
    expect(r.current.chResult?.cohorts[0].cohort_id).toBe("old"); // rows visible immediately
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(r.current.chResult?.cohorts[0].cohort_id).toBe("fresh"));
  });

  it("#4 #21 keeps rows visible + flags background refresh while refetching", async () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "old" }]));
    markStale(reqWith([]), 10 * 60 * 1000);
    let resolve!: (v: unknown) => void;
    load.mockReturnValueOnce(new Promise((res) => { resolve = res; }));
    const { result: r } = mountList(reqWith([]));
    await waitFor(() => expect(r.current.isBackgroundRefreshing).toBe(true));
    expect(r.current.chResult?.cohorts[0].cohort_id).toBe("old"); // table NOT hidden
    resolve(result([{ cohort_id: "new" }]));
    await waitFor(() => expect(r.current.isBackgroundRefreshing).toBe(false));
  });

  it("#5 a failed refresh preserves the cached rows and surfaces a non-blocking error", async () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "kept" }]));
    markStale(reqWith([]), 10 * 60 * 1000);
    load.mockRejectedValueOnce(new Error("invalid transient blip")); // non-retryable → immediate
    const { result: r } = mountList(reqWith([]));
    await waitFor(() => expect(r.current.chStatus.error).toBeTruthy());
    expect(r.current.chResult?.cohorts[0].cohort_id).toBe("kept"); // rows still there
  });

  it("#8 #9 latest filter wins; a superseded result cannot overwrite the current view", async () => {
    load.mockImplementation((req: CohortRequest) => Promise.resolve(result([{ cohort_id: (req.filters?.funnel?.[0] ?? "none") }])));
    const { result: r, rerender } = mountList(reqWith(["A"]));
    await waitFor(() => expect(r.current.chResult?.cohorts[0].cohort_id).toBe("A"));
    rerender({ request: reqWith(["B"]) });
    await waitFor(() => expect(r.current.chResult?.cohorts[0].cohort_id).toBe("B"));
    // the observed data is always the latest requested filter's data
    expect(client.getQueryData(keyFor(reqWith(["B"])))).toBeTruthy();
  });

  it("#23 a successful empty response yields an empty (non-loading) result", async () => {
    load.mockResolvedValueOnce(result([]));
    const { result: r } = mountList(reqWith([]));
    await waitFor(() => expect(r.current.chResult).not.toBeNull());
    expect(r.current.chResult?.cohorts).toHaveLength(0);
    expect(r.current.isInitialLoading).toBe(false);
  });

  it("#24 data always comes from the Edge loader (no transaction scan reintroduced)", async () => {
    load.mockResolvedValueOnce(result([{ cohort_id: "x" }]));
    mountList(reqWith([]));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it("#25 legacy fallback: when disabled, the hook never fetches and drives no rows", async () => {
    const { result: r } = mountList(reqWith([]), false);
    await new Promise((res) => setTimeout(res, 20));
    expect(load).not.toHaveBeenCalled();
    expect(r.current.chResult).toBeNull();
  });
});

describe("invalidateWarehouseAnalyticsCache — after import auto-sync", () => {
  it("#14 invalidates a mounted Cohorts query so it refetches", async () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "old" }]));
    load.mockResolvedValue(result([{ cohort_id: "synced" }]));
    const { result: r } = mountList(reqWith([]));
    expect(load).not.toHaveBeenCalled(); // fresh → no fetch yet
    await invalidateWarehouseAnalyticsCache(client);
    await waitFor(() => expect(load).toHaveBeenCalled());
    await waitFor(() => expect(r.current.chResult?.cohorts[0].cohort_id).toBe("synced"));
  });

  it("#15 without invalidation (sync failure path) the cached data is preserved", async () => {
    client.setQueryData(keyFor(reqWith([])), result([{ cohort_id: "kept" }]));
    mountList(reqWith([]));
    // failure path: invalidate is NOT called
    await new Promise((res) => setTimeout(res, 20));
    expect(load).not.toHaveBeenCalled();
    expect((client.getQueryData(keyFor(reqWith([]))) as { cohorts: unknown[] }).cohorts).toHaveLength(1);
  });
});

// The cascading dropdowns are served by the LIST response's filter_options, so a
// filter change must not present the previous scope's (broader/global) option lists
// as if they described the new scope.
describe("useCohortsListQuery — filter-option scope freshness", () => {
  const withOptions = (countries: string[], cohorts: Array<{ cohort_id: string }> = [{ cohort_id: "a" }]) =>
    result(cohorts, {
      filterOptions: {
        funnel: [], campaign_path: [], traffic_source: [], price_plan: [], currency: [],
        campaign_id: [], card_type: [], media_buyer: [],
        country: countries.map((country_code) => ({ country_code, user_count: 1 })),
      },
    });

  it("#16 a fetched response for the current filters IS the current scope", async () => {
    load.mockResolvedValue(withOptions(["US", "CA"]));
    const { result: r } = mountList(reqWith([]));
    await waitFor(() => expect(r.current.chResult).not.toBeNull());
    expect(r.current.isFilterScopeCurrent).toBe(true);
  });

  it("#17 keepPreviousData across a filter change is NOT treated as the current scope", async () => {
    // Global scope cached (every GEO), then the user picks a funnel.
    client.setQueryData(keyFor(reqWith([])), withOptions(["US", "CA", "AE", "AR"]));
    let resolveFiltered: ((value: unknown) => void) | undefined;
    load.mockImplementation(() => new Promise((res) => { resolveFiltered = res; }));

    const { result: r, rerender } = renderHook(
      (props: { request: CohortRequest }) =>
        useCohortsListQuery({ request: props.request, dataSource: "clickhouse", userScopeHash: SCOPE, warehouseVersion: WHV, enabled: true }),
      { wrapper, initialProps: { request: reqWith([]) } },
    );
    expect(r.current.isFilterScopeCurrent).toBe(true);

    rerender({ request: reqWith(["soulmate"]) });
    // The previous (global) option lists are still on screen while the scoped ones
    // load — but they must not be mistaken for the new scope's options.
    await waitFor(() => expect(load).toHaveBeenCalled());
    expect(r.current.chResult?.filterOptions?.country).toHaveLength(4);
    expect(r.current.isFilterScopeCurrent).toBe(false);

    // Once the scoped response lands it atomically replaces the global list.
    resolveFiltered?.(withOptions(["US", "CA"]));
    await waitFor(() => expect(r.current.isFilterScopeCurrent).toBe(true));
    expect(r.current.chResult?.filterOptions?.country.map((c) => c.country_code)).toEqual(["US", "CA"]);
  });
});
