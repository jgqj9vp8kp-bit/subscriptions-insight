// The Funnels-view invariant suite: a funnel row is a projection of
// computeCohortReportTotals over that path's cohort rows — the same engine
// behind the Cohorts Total row — so the two views can never disagree.
import { describe, expect, it } from "vitest";
import type { CohortRow } from "@/services/types";
import {
  aggregateTrafficMetrics,
  computeCohortReportTotals,
  funnelTrafficForGroup,
} from "@/services/cohortReporting";
import { buildFunnelViewRows, isFunnelViewRow, FUNNEL_ROW_ID_PREFIX } from "@/services/funnelView";
import type { TrafficMetric } from "@/services/trafficImport";

let seq = 0;
function cohort(over: Partial<CohortRow>): CohortRow {
  seq += 1;
  const base: CohortRow = {
    cohort_id: `c${seq}`,
    cohort_date: "2026-08-01",
    funnel: "unknown" as CohortRow["funnel"],
    campaign_path: "path-a",
    trial_users: 0,
    active_users: 0,
    active_rate: 0,
    active_subscriptions: 0,
    active_subscriptions_rate: 0,
    active_subscription_user_ids: [],
    active_subscription_ids: [],
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
    renewal_3_to_renewal_4_cr: 0,
    renewal_4_to_renewal_5_cr: 0,
    renewal_5_to_renewal_6_cr: 0,
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
  };
  return { ...base, ...over };
}

function traffic(date: string, path: string, spend: number, trials = 10, clicks = 100): TrafficMetric {
  return {
    date,
    campaign_path: path,
    trial_count: trials,
    cac: trials ? spend / trials : 0,
    spend,
    clicks,
    cpc: clicks ? spend / clicks : 0,
    cpm: 5,
    ctr: 1.2,
    source: "facebook",
  };
}

/** Fixture: 2 paths; path-a spans TWO funnels sharing one (date, path) traffic
 * key; overlapping active ids across rows; one null-FB row; a zero-trial row. */
function fixture() {
  const rows: CohortRow[] = [
    cohort({
      cohort_date: "2026-08-01",
      funnel: "soulmate" as CohortRow["funnel"],
      campaign_path: "path-a",
      trial_users: 100,
      first_subscription_users: 40,
      upsell_users: 20,
      renewal_2_users: 20,
      renewal_3_users: 10,
      renewal_users: 30,
      support_users: 5,
      gross_revenue: 1000,
      net_revenue: 900,
      revenue_d0: 300,
      revenue_d7: 500,
      revenue_d14: 600,
      revenue_d30: 800,
      revenue_d60: 900,
      amount_refunded: 50,
      refunded_user_ids: ["r1", "r2"],
      active_user_ids: ["u1@x.com", "u2@x.com"],
      active_subscription_ids: ["s1", "s2"],
      active_users: 2,
      active_subscriptions: 2,
      ltv_1m_per_user: 8, // 800/100
      fb_spend: 400,
      fb_match_status: "matched",
      fb_matched_users: 100,
      fb_unmatched_users: 0,
      fb_purchases: 100,
      fb_currency: "USD",
      token_buyer_user_ids: ["t1"],
      token_net_revenue: 30,
      token_buyers: 1,
      fx_missing_transactions: 1,
    }),
    // Same (date, path) as the row above but a DIFFERENT funnel: shares the
    // traffic key, overlaps one active user and one subscription id.
    cohort({
      cohort_date: "2026-08-01",
      funnel: "past_life" as CohortRow["funnel"],
      campaign_path: "path-a",
      trial_users: 50,
      first_subscription_users: 10,
      renewal_2_users: 5,
      renewal_users: 5,
      support_users: 1,
      gross_revenue: 400,
      net_revenue: 350,
      revenue_d7: 100,
      revenue_d30: 200,
      revenue_d60: 250,
      amount_refunded: 10,
      refunded_user_ids: ["r3"],
      active_user_ids: ["u2@x.com", "u3@x.com"], // u2 overlaps
      active_subscription_ids: ["s2", "s3"],     // s2 overlaps
      active_users: 2,
      active_subscriptions: 2,
      ltv_1m_per_user: 4, // 200/50
      fb_spend: null,     // null ≠ 0: no FB data for this row
      fb_match_status: "no_fb_campaign",
      fb_matched_users: 0,
      fb_unmatched_users: 50,
      fb_purchases: null,
    }),
    cohort({
      cohort_date: "2026-08-02",
      funnel: "soulmate" as CohortRow["funnel"],
      campaign_path: "path-a",
      trial_users: 0, // zero-trial row must not divide by zero anywhere
      gross_revenue: 0,
      net_revenue: 0,
    }),
    cohort({
      cohort_date: "2026-08-01",
      funnel: "starseed" as CohortRow["funnel"],
      campaign_path: "path-b",
      trial_users: 60,
      first_subscription_users: 30,
      renewal_2_users: 15,
      renewal_users: 15,
      gross_revenue: 700,
      net_revenue: 650,
      revenue_d7: 250,
      revenue_d30: 500,
      revenue_d60: 600,
      active_user_ids: ["u9@x.com"],
      active_subscription_ids: ["s9"],
      active_users: 1,
      active_subscriptions: 1,
      fb_spend: 200,
      fb_match_status: "partial_coverage",
      fb_matched_users: 40,
      fb_unmatched_users: 20,
      fb_purchases: 40,
      fb_currency: "USD",
    }),
  ];
  const trafficByKey = aggregateTrafficMetrics([
    traffic("2026-08-01", "path-a", 300),
    traffic("2026-08-02", "path-a", 120),
    traffic("2026-08-01", "path-b", 210),
  ]);
  return { rows, trafficByKey };
}

describe("invariant A/B: funnel rows are projections of the Total engine", () => {
  it("a single-path funnel row equals computeCohortReportTotals over that path's rows", () => {
    const { rows, trafficByKey } = fixture();
    const pathARows = rows.filter((r) => r.campaign_path === "path-a");
    const t = computeCohortReportTotals(pathARows, trafficByKey);
    const funnelRow = buildFunnelViewRows({ cohorts: rows, trafficByKey }).find((r) => r.campaign_path === "path-a")!;

    expect(funnelRow.trial_users).toBe(t.totalTrialUsers);
    expect(funnelRow.support_users).toBe(t.totalSupportUsers);
    expect(funnelRow.first_subscription_users).toBe(t.totalFirstSubscriptionUsers);
    expect(funnelRow.renewal_2_users).toBe(t.totalRenewal2Users);
    expect(funnelRow.renewal_users).toBe(t.totalRenewalUsers);
    expect(funnelRow.refund_users).toBe(t.totalRefundUsers);
    expect(funnelRow.active_users).toBe(t.totalActiveUsers);
    expect(funnelRow.active_subscriptions).toBe(t.totalActiveSubscriptions);
    expect(funnelRow.gross_revenue).toBe(t.grossRevenue);
    expect(funnelRow.net_revenue).toBe(t.netRevenue);
    expect(funnelRow.amount_refunded).toBe(t.amountRefunded);
    expect(funnelRow.refund_rate).toBe(t.refundRate);
    expect(funnelRow.trial_to_first_subscription_cr).toBe(t.trialToFirstSubscriptionCr);
    expect(funnelRow.ltv_1m_per_user).toBe(t.ltv1mPerUser);
    expect(funnelRow.funnel_traffic?.spend).toBe(t.trafficSpend);
  });

  it("funnel rows partition the full set: sums/unions reproduce the global totals", () => {
    const { rows, trafficByKey } = fixture();
    const t = computeCohortReportTotals(rows, trafficByKey);
    const funnelRows = buildFunnelViewRows({ cohorts: rows, trafficByKey });

    const sum = (pick: (r: (typeof funnelRows)[number]) => number) => funnelRows.reduce((acc, r) => acc + pick(r), 0);
    expect(sum((r) => r.trial_users)).toBe(t.totalTrialUsers);
    expect(sum((r) => r.first_subscription_users)).toBe(t.totalFirstSubscriptionUsers);
    expect(sum((r) => r.gross_revenue)).toBe(t.grossRevenue);
    expect(sum((r) => r.amount_refunded)).toBe(t.amountRefunded);
    expect(sum((r) => r.revenue_d30)).toBe(t.revenueD30);
    // Active users/subs: union across funnel rows == global dedup (paths do
    // not share users; overlap exists only WITHIN path-a and is deduped there).
    expect(new Set(funnelRows.flatMap((r) => r.active_user_ids)).size).toBe(t.totalActiveUsers);
    expect(new Set(funnelRows.flatMap((r) => r.active_subscription_ids ?? [])).size).toBe(t.totalActiveSubscriptions);
    // Traffic: with per-(date,path) dedup in BOTH engines, funnel rows sum to the Total.
    expect(sum((r) => r.funnel_traffic?.spend ?? 0)).toBe(t.trafficSpend);
  });
});

describe("aggregation semantics", () => {
  it("dedups overlapping active users/subscriptions inside a path", () => {
    const { rows, trafficByKey } = fixture();
    const row = buildFunnelViewRows({ cohorts: rows, trafficByKey }).find((r) => r.campaign_path === "path-a")!;
    // u1,u2,u3 (u2 overlaps) and s1,s2,s3 (s2 overlaps) — NOT 2+2=4.
    expect(row.active_users).toBe(3);
    expect(row.active_subscriptions).toBe(3);
  });

  it("recomputes ratios from sums, never averages row rates", () => {
    const { rows, trafficByKey } = fixture();
    const row = buildFunnelViewRows({ cohorts: rows, trafficByKey }).find((r) => r.campaign_path === "path-a")!;
    // trials 150, first subs 50 → 33.33%, NOT mean(40%, 20%, 0%) = 20%.
    expect(row.trial_to_first_subscription_cr).toBeCloseTo((50 / 150) * 100, 6);
    // LTV-1M weighted: Σd30 1000 / 150 trials = 6.67, NOT mean(8, 4) = 6.
    expect(row.ltv_1m_per_user).toBeCloseTo(1000 / 150, 6);
    expect(row.ltv_1m_per_user).not.toBeCloseTo(6, 2);
  });

  it("counts a cross-funnel shared (date, path) traffic key ONCE", () => {
    const { rows, trafficByKey } = fixture();
    const pathARows = rows.filter((r) => r.campaign_path === "path-a");
    const group = funnelTrafficForGroup(pathARows, trafficByKey);
    // Two 2026-08-01 rows share one traffic key: 300 once + 120 = 420, not 720.
    expect(group.traffic?.spend).toBe(420);
    expect(group.rowsWithTraffic).toBe(3); // all three rows resolved a key
    expect(group.uniqueKeys).toBe(2);
    // And the Total engine agrees (the approved double-count fix).
    expect(computeCohortReportTotals(pathARows, trafficByKey).trafficSpend).toBe(420);
  });

  it("FB: sums non-null spend, recomputes cpp, derives status and business ratios", () => {
    const { rows, trafficByKey } = fixture();
    const rowsByPath = Object.fromEntries(
      buildFunnelViewRows({ cohorts: rows, trafficByKey }).map((r) => [r.campaign_path, r]),
    );
    const pathA = rowsByPath["path-a"];
    // 400 + null(+0 from the zero row's absent fb) = 400; null never reads as 0.
    expect(pathA.fb_spend).toBe(400);
    expect(pathA.fb_matched_users).toBe(100);
    expect(pathA.fb_unmatched_users).toBe(50);
    expect(pathA.fb_match_status).toBe("partial_coverage"); // some unmatched
    expect(pathA.fb_cpp).toBeCloseTo(400 / 100, 6);
    // Business ratios re-derived on aggregated inputs (gated on status).
    expect(pathA.fb_cost_per_trial).toBeCloseTo(400 / 150, 2);
    expect(pathA.fb_net_roas).toBeCloseTo(1250 / 400, 2);

    const pathB = rowsByPath["path-b"];
    expect(pathB.fb_match_status).toBe("partial_coverage");
    expect(pathB.fb_spend).toBe(200);
  });

  it("a zero-trial group yields zeros and nulls, never NaN or Infinity", () => {
    const rows = [cohort({ campaign_path: "empty-path", trial_users: 0 })];
    const [row] = buildFunnelViewRows({ cohorts: rows, trafficByKey: new Map() });
    expect(row.trial_to_first_subscription_cr).toBe(0);
    expect(row.ltv_1m_per_user).toBe(0);
    expect(row.fb_cpp).toBeNull();
    expect(Object.values(row).every((v) => typeof v !== "number" || Number.isFinite(v))).toBe(true);
  });
});

describe("identity and display", () => {
  it("synthetic ids cannot collide with real cohort ids and are detectable", () => {
    const { rows, trafficByKey } = fixture();
    const funnelRows = buildFunnelViewRows({ cohorts: rows, trafficByKey });
    for (const row of funnelRows) {
      expect(row.cohort_id.startsWith(FUNNEL_ROW_ID_PREFIX)).toBe(true);
      expect(isFunnelViewRow(row)).toBe(true);
    }
    expect(rows.some((r) => isFunnelViewRow(r))).toBe(false);
  });

  it("carries display metadata: registry name, cohort count, date range, funnel values", () => {
    const { rows, trafficByKey } = fixture();
    const row = buildFunnelViewRows({
      cohorts: rows,
      trafficByKey,
      displayNameByPath: new Map([["path-a", "Soulmate Sketch"]]),
    }).find((r) => r.campaign_path === "path-a")!;
    expect(row.funnel_display_name).toBe("Soulmate Sketch");
    expect(row.funnel_cohort_count).toBe(3);
    expect(row.funnel_date_min).toBe("2026-08-01");
    expect(row.funnel_date_max).toBe("2026-08-02");
    expect(row.cohort_date).toBe("2026-08-02"); // youngest — conservative maturity
    expect(row.funnel_values).toEqual(["past_life", "soulmate"]);
    expect(row.funnel).toBe("unknown"); // mixed funnels never invent a single value
  });

  it("is deterministic and stable under input row order", () => {
    const { rows, trafficByKey } = fixture();
    const a = buildFunnelViewRows({ cohorts: rows, trafficByKey });
    const b = buildFunnelViewRows({ cohorts: [...rows].reverse(), trafficByKey });
    expect(b.map((r) => r.cohort_id)).toEqual(a.map((r) => r.cohort_id));
    expect(b).toEqual(a);
  });
});
