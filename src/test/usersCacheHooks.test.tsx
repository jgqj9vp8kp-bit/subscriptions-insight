import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/services/usersDataSource", async (importActual) => {
  const actual = await importActual<typeof import("@/services/usersDataSource")>();
  return {
    ...actual,
    loadUsersFromClickHouse: vi.fn(),
    loadUsersSummaryFromClickHouse: vi.fn(),
    loadUserOptionsFromClickHouse: vi.fn(),
  };
});

import { loadUsersFromClickHouse, loadUsersSummaryFromClickHouse, loadUserOptionsFromClickHouse } from "@/services/usersDataSource";
import { useUsersData } from "@/hooks/useUsersCache";
import { usersListKey, usersOptionsKey } from "@/services/usersCache";
import type { UsersQuery } from "@/services/usersDataSource";

const loadList = loadUsersFromClickHouse as unknown as ReturnType<typeof vi.fn>;
const loadSummary = loadUsersSummaryFromClickHouse as unknown as ReturnType<typeof vi.fn>;
const loadOptions = loadUserOptionsFromClickHouse as unknown as ReturnType<typeof vi.fn>;

const SCOPE = "u_test";
const WHV = "whv_test";
const q = (over: Partial<UsersQuery> = {}): UsersQuery => ({
  search: "", firstTrialFrom: null, firstTrialTo: null, firstSub: "all", refund: "all", paymentFailed: "all",
  failedAttempts: "all", campaignPath: "all", country: "all", cardTypes: [], declineReasons: [],
  sortField: "first_trial_date", sortDir: "desc", page: 1, pageSize: 50, ...over,
});
const listKey = (query: UsersQuery) => usersListKey({ userScopeHash: SCOPE, warehouseVersion: WHV, request: query });
const listResult = (rows: Array<{ user_id: string }>) => ({ rows, total: rows.length, page: 1, pageSize: 50, totalPages: 1, durationMs: 4 });

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
function mount(query: UsersQuery, enabled = true) {
  return renderHook(
    (props: { query: UsersQuery }) => useUsersData({ query: props.query, userScopeHash: SCOPE, warehouseVersion: WHV, enabled }),
    { wrapper, initialProps: { query } },
  );
}
function markStale(query: UsersQuery, ageMs: number) {
  const qu = client.getQueryCache().find({ queryKey: listKey(query) });
  if (qu) qu.state.dataUpdatedAt = Date.now() - ageMs;
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  loadList.mockReset(); loadSummary.mockReset(); loadOptions.mockReset();
  loadSummary.mockResolvedValue(null);
  loadOptions.mockResolvedValue(null);
});
afterEach(() => client.clear());

describe("useUsersData — SWR", () => {
  it("renders cached rows immediately + no refetch when fresh", async () => {
    client.setQueryData(listKey(q()), listResult([{ user_id: "u1" }]));
    const { result } = mount(q());
    expect(result.current.chUsers?.rows).toHaveLength(1);
    expect(result.current.isInitialLoading).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(loadList).not.toHaveBeenCalled();
  });

  it("stale cache keeps rows visible and refetches in the background", async () => {
    client.setQueryData(listKey(q()), listResult([{ user_id: "old" }]));
    markStale(q(), 10 * 60 * 1000);
    loadList.mockResolvedValueOnce(listResult([{ user_id: "fresh" }]));
    const { result } = mount(q());
    expect(result.current.chUsers?.rows[0].user_id).toBe("old");
    await waitFor(() => expect(loadList).toHaveBeenCalled());
    await waitFor(() => expect(result.current.chUsers?.rows[0].user_id).toBe("fresh"));
  });

  it("a failed refresh preserves cached rows (non-blocking error)", async () => {
    client.setQueryData(listKey(q()), listResult([{ user_id: "kept" }]));
    markStale(q(), 10 * 60 * 1000);
    loadList.mockRejectedValueOnce(new Error("invalid blip"));
    const { result } = mount(q());
    await waitFor(() => expect(result.current.chStatus.error).toBeTruthy());
    expect(result.current.chUsers?.rows[0].user_id).toBe("kept");
  });

  it("options ignore paging but refetch for any filter that narrows a dependent branch", async () => {
    loadList.mockResolvedValue(listResult([{ user_id: "x" }]));
    loadOptions.mockResolvedValue({ funnel: ["a"] });
    const { rerender } = mount(q());
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(1));

    rerender({ query: q({ page: 3 }) }); // paging → new list, SAME options
    await waitFor(() => expect(loadList).toHaveBeenCalledTimes(2));
    expect(loadOptions).toHaveBeenCalledTimes(1);

    // Country narrows the cohort branch of the options response, so it must
    // refetch — the panel would otherwise keep counts from every country.
    rerender({ query: q({ page: 3, country: "US" }) });
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(2));

    rerender({ query: q({ page: 3, country: "US", firstSub: "has" }) });
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(3));
  });

  it("disabled (legacy mode) never fetches and drives no rows", async () => {
    const { result } = mount(q(), false);
    await new Promise((r) => setTimeout(r, 20));
    expect(loadList).not.toHaveBeenCalled();
    expect(result.current.chUsers).toBeNull();
  });

  it("an optionsQuery drives the options request alone (the Users panel sends it without campaign paths)", async () => {
    loadList.mockResolvedValue(listResult([{ user_id: "x" }]));
    loadOptions.mockResolvedValue({ funnel: ["a"] });
    const { rerender } = renderHook(
      (props: { query: UsersQuery }) => useUsersData({
        query: props.query,
        optionsQuery: { ...props.query, campaignPath: [] },
        userScopeHash: SCOPE,
        warehouseVersion: WHV,
        enabled: true,
      }),
      { wrapper, initialProps: { query: q({ campaignPath: ["p1"] }) } },
    );
    await waitFor(() => expect(loadOptions).toHaveBeenCalledTimes(1));
    expect(loadList.mock.calls[0][0]).toMatchObject({ campaignPath: ["p1"] });
    expect(loadOptions.mock.calls[0][0]).toMatchObject({ campaignPath: [] });

    // A path change refetches the list but not the path-free options.
    rerender({ query: q({ campaignPath: ["p2"] }) });
    await waitFor(() => expect(loadList).toHaveBeenCalledTimes(2));
    expect(loadOptions).toHaveBeenCalledTimes(1);
  });

  it("a countryOptionsQuery adds a second options request whose country list replaces the main one", async () => {
    loadList.mockResolvedValue(listResult([{ user_id: "x" }]));
    loadOptions.mockImplementation(async (query: UsersQuery) => ({
      country: [{ country_code: Array.isArray(query.campaignPath) && query.campaignPath.length ? "DE" : "US", user_count: 1 }],
    }));
    const { result, rerender } = renderHook(
      (props: { query: UsersQuery; withCountry: boolean }) => useUsersData({
        query: props.query,
        optionsQuery: { ...props.query, campaignPath: [] },
        countryOptionsQuery: props.withCountry ? props.query : null,
        userScopeHash: SCOPE,
        warehouseVersion: WHV,
        enabled: true,
      }),
      { wrapper, initialProps: { query: q({ campaignPath: [] }), withCountry: false } },
    );
    // Without one: a single options request, and no separate country list.
    await waitFor(() => expect(result.current.chOptions?.country[0].country_code).toBe("US"));
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(result.current.chCountryOptions).toBeNull();

    rerender({ query: q({ campaignPath: ["p1"] }), withCountry: true });
    await waitFor(() => expect(result.current.chCountryOptions?.[0].country_code).toBe("DE"));
    expect(loadOptions).toHaveBeenCalledTimes(2);
    expect(loadOptions.mock.calls[1][0]).toMatchObject({ campaignPath: ["p1"] });
    // The path-free options are untouched (same key, no refetch).
    expect(result.current.chOptions?.country[0].country_code).toBe("US");
  });
});
