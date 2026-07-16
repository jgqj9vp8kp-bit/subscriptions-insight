import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateWarehouseAnalyticsCache } from "@/hooks/useAnalyticsCache";
import { cohortsListKey } from "@/services/cohortsCache";
import { usersListKey } from "@/services/usersCache";
import { paymentAnalyticsBundleKey } from "@/services/paymentAnalyticsCache";
import { WAREHOUSE_VERSION_KEY } from "@/services/analyticsCache";

const cohortReq = { action: "list" as const, date_from: null, date_to: null, filters: { funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" as const }, max_renewal_depth: 6 };
const userReq = { search: "", firstTrialFrom: null, firstTrialTo: null, firstSub: "all" as const, refund: "all" as const, paymentFailed: "all" as const, failedAttempts: "all" as const, campaignPath: "all", country: "all", cardTypes: [], declineReasons: [], sortField: "first_trial_date", sortDir: "desc" as const, page: 1, pageSize: 50 };
const payReq = { dateBasis: "transaction" as const, dateFrom: null, dateTo: null, funnel: "all", campaignPath: "all", campaignId: "all", mediaBuyer: "all", country: "all", cardType: "all", stage: "all", declineReason: "all", transactionType: "all", outcome: "all" as const, groupBy: "country" as const, firstTxDimension: "country" as const, renewalDimension: "country" as const };

describe("invalidateWarehouseAnalyticsCache — all three analytics roots at once", () => {
  let client: QueryClient;
  beforeEach(() => { client = new QueryClient(); });

  it("invalidates Cohorts, Users, Payment Analytics and the warehouse version together", async () => {
    const cKey = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: cohortReq });
    const uKey = usersListKey({ userScopeHash: "u_1", warehouseVersion: "whv_x", request: userReq });
    const pKey = paymentAnalyticsBundleKey({ userScopeHash: "u_1", warehouseVersion: "whv_x", request: payReq });
    client.setQueryData(cKey, { cohorts: [] });
    client.setQueryData(uKey, { rows: [] });
    client.setQueryData(pKey, { summary: {} });
    client.setQueryData([...WAREHOUSE_VERSION_KEY], "whv_x");

    const spy = vi.spyOn(client, "invalidateQueries");
    await invalidateWarehouseAnalyticsCache(client);

    // version refetch + one call per warehouse-dependent root
    const invalidatedRoots = spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey: unknown[] }).queryKey));
    expect(invalidatedRoots).toContain(JSON.stringify([...WAREHOUSE_VERSION_KEY]));
    expect(invalidatedRoots).toContain(JSON.stringify(["cohorts"]));
    expect(invalidatedRoots).toContain(JSON.stringify(["users"]));
    expect(invalidatedRoots).toContain(JSON.stringify(["payment-analytics"]));

    for (const key of [cKey, uKey, pKey]) {
      expect(client.getQueryCache().find({ queryKey: key })?.state.isInvalidated).toBe(true);
    }
  });
});
