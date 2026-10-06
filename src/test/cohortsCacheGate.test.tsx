import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";

import { AnalyticsCacheGate as CohortsCacheGate } from "@/components/AnalyticsCacheGate";
import { AccessContext, buildAccessValue } from "@/contexts/accessContext";
import { persistAnalyticsCache as persistCohortsCache, analyticsPersistKey } from "@/services/analyticsCachePersistence";
import { cohortsListKey, COHORTS_QUERY_ROOT } from "@/services/cohortsCache";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

// The gate keys persistence on the ACCESS partition (plan §20); legacy access
// (server not bootstrapped) partitions as "legacy:" + user id.
const PARTITION_A = "legacy:user-a";
const PARTITION_B = "legacy:user-b";

const request: CohortRequest = {
  action: "list", date_from: null, date_to: null,
  filters: { funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
  max_renewal_depth: 6,
};
const keyFor = (scope: string) => cohortsListKey({ userScopeHash: scope, dataSource: "clickhouse", warehouseVersion: "whv_x", request });

let client: QueryClient;
let currentUserId: string | null = "user-a";
let accessLoading = false;

function accessValue() {
  return buildAccessValue({
    status: accessLoading ? "loading" : currentUserId ? "legacy" : "signed_out",
    access: null,
    userId: currentUserId,
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client },
    createElement(AccessContext.Provider, { value: accessValue() }, children),
  );
}

function seedPersisted(partition: string, cohortId = "z") {
  const seed = new QueryClient();
  seed.setQueryData(keyFor(partition), { cohorts: [{ cohort_id: cohortId }], source: "clickhouse", durationMs: 1 });
  persistCohortsCache(seed, partition);
}

beforeEach(() => {
  sessionStorage.clear();
  client = new QueryClient();
  currentUserId = "user-a";
  accessLoading = false;
});
afterEach(() => cleanup());

describe("CohortsCacheGate", () => {
  it("restores the authenticated user's persisted cache on mount", async () => {
    seedPersisted(PARTITION_A);

    render(createElement(CohortsCacheGate), { wrapper });
    await waitFor(() => expect(client.getQueryData(keyFor(PARTITION_A))).toBeTruthy());
  });

  it("hydrates before child route queries can read the QueryClient", () => {
    seedPersisted(PARTITION_A, "instant");

    let seenDuringRender: unknown;
    function Probe() {
      seenDuringRender = useQueryClient().getQueryData(keyFor(PARTITION_A));
      return null;
    }

    render(createElement(CohortsCacheGate, null, createElement(Probe)), { wrapper });
    expect(seenDuringRender).toEqual({ cohorts: [{ cohort_id: "instant" }], source: "clickhouse", durationMs: 1 });
  });

  it("restores nothing while access is still resolving", () => {
    seedPersisted(PARTITION_A);
    accessLoading = true;

    render(createElement(CohortsCacheGate), { wrapper });
    expect(client.getQueryData(keyFor(PARTITION_A))).toBeUndefined();
    // the envelope stays for the moment access resolves
    expect(sessionStorage.getItem(analyticsPersistKey(PARTITION_A))).not.toBeNull();
  });

  it("never restores another principal's envelope (no cross-user leakage)", async () => {
    seedPersisted(PARTITION_A);
    currentUserId = "user-b";

    render(createElement(CohortsCacheGate), { wrapper });

    expect(client.getQueryData(keyFor(PARTITION_A))).toBeUndefined();
    // the foreign envelope is dropped unread
    expect(sessionStorage.getItem(analyticsPersistKey(PARTITION_A))).toBeNull();
    expect(client.getQueryCache().findAll({ queryKey: [COHORTS_QUERY_ROOT] })).toHaveLength(0);
    expect(sessionStorage.getItem(analyticsPersistKey(PARTITION_B))).toBeNull();
  });
});
