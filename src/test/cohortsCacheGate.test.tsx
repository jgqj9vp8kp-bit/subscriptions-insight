import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";

// Controllable auth user.
let currentUser: { id: string } | null = { id: "user-a" };
let authLoading = false;
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: currentUser, loading: authLoading }) }));

import { AnalyticsCacheGate as CohortsCacheGate } from "@/components/AnalyticsCacheGate";
import { persistAnalyticsCache as persistCohortsCache, ANALYTICS_PERSIST_KEY } from "@/services/analyticsCachePersistence";
import { cohortsListKey, hashUserScope, COHORTS_QUERY_ROOT } from "@/services/cohortsCache";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

const request: CohortRequest = {
  action: "list", date_from: null, date_to: null,
  filters: { funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
  max_renewal_depth: 6,
};
const keyFor = (scope: string) => cohortsListKey({ userScopeHash: scope, dataSource: "clickhouse", warehouseVersion: "whv_x", request });

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  sessionStorage.clear();
  client = new QueryClient();
  currentUser = { id: "user-a" };
  authLoading = false;
});
afterEach(() => cleanup());

describe("CohortsCacheGate", () => {
  it("restores the authenticated user's persisted cache on mount", async () => {
    // seed a persisted cache for user-a
    const seed = new QueryClient();
    seed.setQueryData(keyFor(hashUserScope("user-a")), { cohorts: [{ cohort_id: "z" }], source: "clickhouse", durationMs: 1 });
    persistCohortsCache(seed, hashUserScope("user-a"));

    render(createElement(CohortsCacheGate), { wrapper });
    await waitFor(() => expect(client.getQueryData(keyFor(hashUserScope("user-a")))).toBeTruthy());
  });

  it("hydrates before child route queries can read the QueryClient", () => {
    const scope = hashUserScope("user-a");
    const seed = new QueryClient();
    seed.setQueryData(keyFor(scope), { cohorts: [{ cohort_id: "instant" }], source: "clickhouse", durationMs: 1 });
    persistCohortsCache(seed, scope);

    let seenDuringRender: unknown;
    function Probe() {
      seenDuringRender = useQueryClient().getQueryData(keyFor(scope));
      return null;
    }

    render(createElement(CohortsCacheGate, null, createElement(Probe)), { wrapper });
    expect(seenDuringRender).toEqual({ cohorts: [{ cohort_id: "instant" }], source: "clickhouse", durationMs: 1 });
  });

  it("clears the previous user's cache on account change (no cross-user leakage)", async () => {
    const seed = new QueryClient();
    seed.setQueryData(keyFor(hashUserScope("user-a")), { cohorts: [{ cohort_id: "z" }], source: "clickhouse", durationMs: 1 });
    persistCohortsCache(seed, hashUserScope("user-a"));

    const { rerender } = render(createElement(CohortsCacheGate), { wrapper });
    await waitFor(() => expect(client.getQueryData(keyFor(hashUserScope("user-a")))).toBeTruthy());

    // account switch → user-b
    currentUser = { id: "user-b" };
    rerender(createElement(CohortsCacheGate));

    await waitFor(() => {
      // previous user's in-memory cohorts cleared and persisted storage purged
      expect(client.getQueryData(keyFor(hashUserScope("user-a")))).toBeUndefined();
      expect(sessionStorage.getItem(ANALYTICS_PERSIST_KEY)).toBeNull();
    });
    // no leftover cohorts queries for the old scope
    expect(client.getQueryCache().findAll({ queryKey: [COHORTS_QUERY_ROOT] })).toHaveLength(0);
  });
});
