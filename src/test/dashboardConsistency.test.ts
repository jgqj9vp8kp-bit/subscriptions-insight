import { describe, expect, it } from "vitest";
import { aggregateTrafficMetrics, computeCohortReportTotals } from "@/services/cohortReporting";
import type { CohortRow } from "@/services/types";
import type { TrafficMetric } from "@/services/trafficImport";

function cohort(overrides: Partial<CohortRow>): CohortRow {
  return {
    cohort_id: "cohort",
    cohort_date: "2026-03-18",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
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

describe("dashboard cohort consistency", () => {
  it("uses the same total semantics as the Cohorts total row", () => {
    const cohorts = [
      cohort({
        cohort_id: "a",
        cohort_date: "2026-03-18",
        campaign_path: "soulmate-reading",
        trial_users: 10,
        user_cancelled_user_ids: ["u1"],
        auto_cancelled_user_ids: ["u2"],
        net_revenue: 100,
        revenue_d30: 80,
      }),
      cohort({
        cohort_id: "b",
        cohort_date: "2026-03-18",
        campaign_path: "past-life-read",
        trial_users: 5,
        user_cancelled_user_ids: ["u3"],
        auto_cancelled_user_ids: ["u4"],
        net_revenue: 50,
        revenue_d30: 20,
      }),
    ];
    const traffic: TrafficMetric[] = [
      {
        date: "2026-03-18",
        campaign_path: "/soulmate-reading",
        trial_count: 10,
        cac: 5,
        spend: 50,
        clicks: 100,
        cpc: 0.5,
        cpm: 0,
        ctr: 0,
        source: "facebook",
      },
      {
        date: "2026-03-18",
        campaign_path: '"/past-life-read"',
        trial_count: 5,
        cac: 10,
        spend: 50,
        clicks: 50,
        cpc: 1,
        cpm: 0,
        ctr: 0,
        source: "facebook",
      },
    ];

    const totals = computeCohortReportTotals(cohorts, aggregateTrafficMetrics(traffic));

    expect(totals.netRevenue).toBe(150);
    expect(totals.totalTrialUsers).toBe(15);
    expect(totals.trafficSpend).toBe(100);
    expect(totals.hasTrafficSpend).toBe(true);
    expect(totals.hasCompleteTrafficSpend).toBe(true);
    expect(totals.profit).toBe(50);
    expect(totals.profit1m).toBe(0);
    expect(totals.roas1m).toBe(1);
    expect(totals.totalUserCancelledUsers).toBe(2);
    expect(totals.totalAutoCancelledUsers).toBe(2);
  });

  it("distinguishes missing traffic spend from zero spend", () => {
    const cohorts = [
      cohort({
        cohort_id: "a",
        cohort_date: "2026-03-18",
        campaign_path: "soulmate-reading",
        net_revenue: 100,
        revenue_d7: 40,
        revenue_d30: 80,
        revenue_d60: 90,
      }),
    ];

    const withoutTraffic = computeCohortReportTotals(cohorts, aggregateTrafficMetrics([]));
    expect(withoutTraffic.hasTrafficSpend).toBe(false);
    expect(withoutTraffic.hasCompleteTrafficSpend).toBe(false);

    const withZeroSpend = computeCohortReportTotals(
      cohorts,
      aggregateTrafficMetrics([
        {
          date: "2026-03-18",
          campaign_path: "soulmate-reading",
          trial_count: 0,
          cac: 0,
          spend: 0,
          clicks: 0,
          cpc: 0,
          cpm: 0,
          ctr: 0,
          source: "facebook",
        },
      ]),
    );

    expect(withZeroSpend.hasTrafficSpend).toBe(true);
    expect(withZeroSpend.hasCompleteTrafficSpend).toBe(true);
    expect(withZeroSpend.profit).toBe(100);
    expect(withZeroSpend.profitD7).toBe(40);
    expect(withZeroSpend.profit1m).toBe(80);
    expect(withZeroSpend.profit2m).toBe(90);
    expect(withZeroSpend.roas1m).toBe(0);
  });

  it("marks total traffic coverage incomplete when a visible cohort has no spend row", () => {
    const cohorts = [
      cohort({
        cohort_id: "a",
        cohort_date: "2026-03-18",
        campaign_path: "soulmate-reading",
        net_revenue: 100,
      }),
      cohort({
        cohort_id: "b",
        cohort_date: "2026-03-18",
        campaign_path: "past-life-read",
        net_revenue: 50,
      }),
    ];
    const totals = computeCohortReportTotals(
      cohorts,
      aggregateTrafficMetrics([
        {
          date: "2026-03-18",
          campaign_path: "soulmate-reading",
          trial_count: 10,
          cac: 5,
          spend: 50,
          clicks: 100,
          cpc: 0.5,
          cpm: 0,
          ctr: 0,
          source: "facebook",
        },
      ]),
    );

    expect(totals.hasTrafficSpend).toBe(true);
    expect(totals.hasCompleteTrafficSpend).toBe(false);
    expect(totals.trafficSpend).toBe(50);
  });
});
