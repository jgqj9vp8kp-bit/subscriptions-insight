import { describe, expect, it } from "vitest";
import {
  compareCohortSortValues,
  getCohortSortValue,
  nextCohortSortState,
  sortCohortGroups,
  sortCohortRows,
} from "@/services/cohortSorting";
import type { CohortRow } from "@/services/types";

function cohort(overrides: Partial<CohortRow>): CohortRow {
  return {
    cohort_id: "cohort",
    cohort_date: "2026-03-01",
    funnel: "unknown",
    campaign_path: "default",
    trial_users: 0,
    active_users: 0,
    active_rate: 0,
    active_subscriptions: 0,
    active_subscriptions_rate: 0,
    active_subscription_user_ids: [],
    cancelled_users: 0,
    cancellation_rate: 0,
    user_cancelled_users: 0,
    user_cancel_rate: 0,
    auto_cancelled_users: 0,
    auto_cancel_rate: 0,
    cancelled_active_users: 0,
    active_user_ids: [],
    cancelled_user_ids: [],
    user_cancelled_user_ids: [],
    auto_cancelled_user_ids: [],
    cancelled_active_user_ids: [],
    upsell_users: 0,
    first_subscription_users: 0,
    renewal_2_users: 0,
    renewal_3_users: 0,
    renewal_4_users: 0,
    renewal_5_users: 0,
    renewal_6_users: 0,
    renewal_users_by_level: {},
    renewal_users: 0,
    refund_users: 0,
    refunded_user_ids: [],
    plan_breakdown: [],
    trial_revenue: 0,
    upsell_revenue: 0,
    first_subscription_revenue: 0,
    renewal_revenue: 0,
    amount_refunded: 0,
    refund_rate: 0,
    gross_revenue: 0,
    net_revenue: 0,
    gross_ltv: 0,
    net_ltv: 0,
    trial_to_upsell_cr: 0,
    trial_to_first_subscription_cr: 0,
    first_subscription_to_renewal_2_cr: 0,
    renewal_2_to_renewal_3_cr: 0,
    revenue_d0: 0,
    revenue_d7: 0,
    revenue_d14: 0,
    revenue_d30: 0,
    revenue_d60: 0,
    revenue_d37: 0,
    revenue_d67: 0,
    revenue_total: 0,
    ltv_d7: 0,
    ltv_d14: 0,
    ltv_d30: 0,
    ...overrides,
  };
}

describe("cohort sorting", () => {
  it("sorts numeric columns by raw numeric value", () => {
    const rows = [
      cohort({ cohort_id: "a", trial_users: 3 }),
      cohort({ cohort_id: "b", trial_users: 1 }),
      cohort({ cohort_id: "c", trial_users: 2 }),
    ];

    expect(sortCohortRows(rows, { sortColumn: "trial_users", sortDirection: "desc" }).map((row) => row.cohort_id))
      .toEqual(["a", "c", "b"]);
    expect(sortCohortRows(rows, { sortColumn: "trial_users", sortDirection: "asc" }).map((row) => row.cohort_id))
      .toEqual(["b", "c", "a"]);
  });

  it("calculates trial cost from traffic spend and cohort trial users", () => {
    expect(
      getCohortSortValue(
        cohort({ trial_users: 10 }),
        "trial_cost",
        { spend: 124.8, cac: 0, trial_count: 0, clicks: 0, cpc: 0, cpm: null, ctr: null },
      ),
    ).toBeCloseTo(12.48);
  });

  it("returns no trial cost when trial users are zero", () => {
    expect(
      getCohortSortValue(
        cohort({ trial_users: 0 }),
        "trial_cost",
        { spend: 100, cac: 0, trial_count: 0, clicks: 0, cpc: 0, cpm: null, ctr: null },
      ),
    ).toBeNull();
  });

  it("returns no trial cost when spend is missing", () => {
    expect(getCohortSortValue(cohort({ trial_users: 10 }), "trial_cost", null)).toBeNull();
  });

  it("sorts text columns alphabetically", () => {
    const rows = [
      cohort({ cohort_id: "a", campaign_path: "zebra" }),
      cohort({ cohort_id: "b", campaign_path: "Alpha" }),
      cohort({ cohort_id: "c", campaign_path: "beta" }),
    ];

    expect(sortCohortRows(rows, { sortColumn: "campaign_path", sortDirection: "asc" }).map((row) => row.cohort_id))
      .toEqual(["b", "c", "a"]);
  });

  it("sorts date columns by timestamp", () => {
    const rows = [
      cohort({ cohort_id: "a", cohort_date: "2026-03-18" }),
      cohort({ cohort_id: "b", cohort_date: "2026-03-20" }),
      cohort({ cohort_id: "c", cohort_date: "2026-03-19" }),
    ];

    expect(sortCohortRows(rows, { sortColumn: "cohort_date", sortDirection: "desc" }).map((row) => row.cohort_id))
      .toEqual(["b", "c", "a"]);
  });

  it("sorts normalized date formats without timezone drift", () => {
    const rows = [
      cohort({ cohort_id: "start", cohort_date: "01.04.2026" }),
      cohort({ cohort_id: "end", cohort_date: "2026-04-30T23:30:00-05:00" }),
      cohort({ cohort_id: "middle", cohort_date: "2026-04-15" }),
    ];

    expect(sortCohortRows(rows, { sortColumn: "cohort_date", sortDirection: "asc" }).map((row) => row.cohort_id))
      .toEqual(["start", "middle", "end"]);
  });

  it("keeps null and missing values at the bottom in either direction", () => {
    expect(compareCohortSortValues(null, 1, "desc")).toBe(1);
    expect(compareCohortSortValues(1, null, "asc")).toBe(-1);
  });

  it("keeps total rows at the bottom", () => {
    const groups = [
      { kind: "cohort", cohort: cohort({ cohort_id: "low", trial_users: 1 }) },
      { kind: "total" },
      { kind: "cohort", cohort: cohort({ cohort_id: "high", trial_users: 10 }) },
    ];

    const sorted = sortCohortGroups(
      groups,
      { sortColumn: "trial_users", sortDirection: "desc" },
      (group) => ("cohort" in group ? group.cohort : null),
    );

    expect(sorted.map((group) => ("cohort" in group ? group.cohort.cohort_id : "total"))).toEqual([
      "high",
      "low",
      "total",
    ]);
  });

  it("keeps expanded child rows attached to their parent group", () => {
    const groups = [
      { parent: cohort({ cohort_id: "a", trial_users: 2 }), children: ["a-7.49"] },
      { parent: cohort({ cohort_id: "b", trial_users: 5 }), children: ["b-29.99"] },
    ];

    const sorted = sortCohortGroups(
      groups,
      { sortColumn: "trial_users", sortDirection: "desc" },
      (group) => group.parent,
    );

    expect(sorted[0].parent.cohort_id).toBe("b");
    expect(sorted[0].children).toEqual(["b-29.99"]);
  });

  it("sorts by trial cost", () => {
    const rows = [
      cohort({ cohort_id: "high", trial_users: 4 }),
      cohort({ cohort_id: "missing", trial_users: 8 }),
      cohort({ cohort_id: "low", trial_users: 10 }),
    ];
    const traffic = new Map([
      ["high", { spend: 80, cac: 0, trial_count: 0, clicks: 0, cpc: 0, cpm: null, ctr: null }],
      ["low", { spend: 50, cac: 0, trial_count: 0, clicks: 0, cpc: 0, cpm: null, ctr: null }],
    ]);

    expect(
      sortCohortRows(
        rows,
        { sortColumn: "trial_cost", sortDirection: "desc" },
        (row) => traffic.get(row.cohort_id) ?? null,
      ).map((row) => row.cohort_id),
    ).toEqual(["high", "low", "missing"]);
  });

  it("sorts dynamic Renewal columns by renewal level counts", () => {
    const rows = [
      cohort({ cohort_id: "low", renewal_users_by_level: { 10: 1 } }),
      cohort({ cohort_id: "high", renewal_users_by_level: { 10: 4 } }),
      cohort({ cohort_id: "none", renewal_users_by_level: { 10: 0 } }),
    ];

    expect(sortCohortRows(rows, { sortColumn: "renewal_10_users", sortDirection: "desc" }).map((row) => row.cohort_id))
      .toEqual(["high", "low", "none"]);
  });

  it("cycles header clicks through default, reverse, and cleared sorting states", () => {
    const first = nextCohortSortState({ sortColumn: null, sortDirection: null }, "net_revenue");
    const second = nextCohortSortState(first, "net_revenue");
    const third = nextCohortSortState(second, "net_revenue");

    expect(first).toEqual({ sortColumn: "net_revenue", sortDirection: "desc" });
    expect(second).toEqual({ sortColumn: "net_revenue", sortDirection: "asc" });
    expect(third).toEqual({ sortColumn: null, sortDirection: null });
  });
});
