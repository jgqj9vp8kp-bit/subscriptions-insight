import { describe, expect, it } from "vitest";
import { computeCohortReportTotals } from "@/services/cohortReporting";
import { filterCohorts, filterCohortsWithDiagnostics, normalizeCohortDateKey } from "@/services/cohortFiltering";
import type { CohortRow, PlanBreakdownRow } from "@/services/types";

function cohort(overrides: Partial<CohortRow>): CohortRow {
  return {
    cohort_id: "cohort",
    cohort_date: "2026-04-01",
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

describe("cohort filtering", () => {
  it("normalizes supported cohort date formats without timezone drift", () => {
    expect(normalizeCohortDateKey("01.04.2026")).toBe("2026-04-01");
    expect(normalizeCohortDateKey("2026-04-30")).toBe("2026-04-30");
    expect(normalizeCohortDateKey("2026-04-30T23:30:00-05:00")).toBe("2026-04-30");
    expect(normalizeCohortDateKey("2026-04-01T00:30:00+03:00")).toBe("2026-04-01");
    expect(normalizeCohortDateKey("31.04.2026")).toBeNull();
  });

  it("applies inclusive date ranges when no funnel is selected", () => {
    const rows = [
      cohort({ cohort_id: "before", cohort_date: "2026-03-31", funnel: "soulmate" }),
      cohort({ cohort_id: "start", cohort_date: "2026-04-01", funnel: "soulmate" }),
      cohort({ cohort_id: "middle", cohort_date: "2026-04-15", funnel: "past_life" }),
      cohort({ cohort_id: "end", cohort_date: "2026-04-30", funnel: "starseed" }),
      cohort({ cohort_id: "after", cohort_date: "2026-05-01", funnel: "soulmate" }),
    ];

    const result = filterCohorts(rows, {
      funnelFilter: "all",
      cohortDateFrom: "01.04.2026",
      cohortDateTo: "30.04.2026",
    });

    expect(result.map((row) => row.cohort_id)).toEqual(["start", "middle", "end"]);
  });

  it("narrows date-matching cohorts when a funnel is selected", () => {
    const rows = [
      cohort({ cohort_id: "soulmate-apr", cohort_date: "2026-04-10", funnel: "soulmate" }),
      cohort({ cohort_id: "past-apr", cohort_date: "2026-04-10", funnel: "past_life" }),
      cohort({ cohort_id: "soulmate-may", cohort_date: "2026-05-10", funnel: "soulmate" }),
    ];

    const result = filterCohorts(rows, {
      funnelFilter: "soulmate",
      cohortDateFrom: "2026-04-01",
      cohortDateTo: "2026-04-30",
    });

    expect(result.map((row) => row.cohort_id)).toEqual(["soulmate-apr"]);
  });

  it("handles empty, invalid, inverted, single-day, and missing date values", () => {
    const rows = [
      cohort({ cohort_id: "valid", cohort_date: "2026-04-15" }),
      cohort({ cohort_id: "missing", cohort_date: "" }),
      cohort({ cohort_id: "single", cohort_date: "15.04.2026" }),
    ];

    expect(filterCohorts(rows, { cohortDateFrom: "", cohortDateTo: "" }).map((row) => row.cohort_id)).toEqual([
      "valid",
      "missing",
      "single",
    ]);
    expect(filterCohorts(rows, { cohortDateFrom: "not-a-date", cohortDateTo: "" }).map((row) => row.cohort_id)).toEqual([
      "valid",
      "missing",
      "single",
    ]);
    expect(filterCohorts(rows, { cohortDateFrom: "2026-05-01", cohortDateTo: "2026-04-01" })).toEqual([]);
    expect(filterCohorts(rows, { cohortDateFrom: "2026-04-15", cohortDateTo: "2026-04-15" }).map((row) => row.cohort_id)).toEqual([
      "valid",
      "single",
    ]);
  });

  it("exposes development diagnostics for each filter stage", () => {
    const rows = [
      cohort({ cohort_id: "a", cohort_date: "2026-04-01", funnel: "soulmate", campaign_path: "alpha" }),
      cohort({ cohort_id: "b", cohort_date: "2026-04-02", funnel: "past_life", campaign_path: "alpha" }),
      cohort({ cohort_id: "c", cohort_date: "2026-05-01", funnel: "soulmate", campaign_path: "beta" }),
    ];

    const result = filterCohortsWithDiagnostics(rows, {
      funnelFilter: "soulmate",
      campaignPathFilter: "alpha",
      cohortDateFrom: "2026-04-01",
      cohortDateTo: "2026-04-30",
    });

    expect(result.diagnostics).toEqual({
      beforeFilters: 3,
      afterDateFilter: 2,
      afterFunnelFilter: 1,
      afterCampaignFilter: 1,
      afterRefundFilter: 1,
    });
  });

  it("lets totals recalculate from visible cohorts only", () => {
    const visible = filterCohorts(
      [
        cohort({ cohort_id: "included-a", cohort_date: "2026-04-01", trial_users: 2, net_revenue: 20 }),
        cohort({ cohort_id: "included-b", cohort_date: "2026-04-30", trial_users: 3, net_revenue: 30 }),
        cohort({ cohort_id: "excluded", cohort_date: "2026-05-01", trial_users: 10, net_revenue: 100 }),
      ],
      { cohortDateFrom: "2026-04-01", cohortDateTo: "2026-04-30" },
    );

    const totals = computeCohortReportTotals(visible);

    expect(visible.map((row) => row.cohort_id)).toEqual(["included-a", "included-b"]);
    expect(totals.totalTrialUsers).toBe(5);
    expect(totals.netRevenue).toBe(50);
  });

  it("keeps expanded child rows visible only through their parent cohort", () => {
    const includedPlan = { price: 9.99 } as PlanBreakdownRow;
    const excludedPlan = { price: 19.99 } as PlanBreakdownRow;
    const visible = filterCohorts(
      [
        cohort({ cohort_id: "included", cohort_date: "2026-04-15", plan_breakdown: [includedPlan] }),
        cohort({ cohort_id: "excluded", cohort_date: "2026-05-15", plan_breakdown: [excludedPlan] }),
      ],
      { cohortDateFrom: "2026-04-01", cohortDateTo: "2026-04-30" },
    );

    expect(visible).toHaveLength(1);
    expect(visible[0].cohort_id).toBe("included");
    expect(visible.flatMap((row) => row.plan_breakdown)).toEqual([includedPlan]);
  });
});
