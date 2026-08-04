// Reports R2: the deterministic layer.
//
// The rules under test are the ones that decide whether the report tells the
// truth: an unmeasured value must never render as 0, a conversion over cohorts
// whose trial has not ended must not be reported at all, spend must disappear
// when the snapshot that carries it is missing, and a delta must not be called
// significant on a sample that cannot support it.
import { describe, expect, it } from "vitest";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import type { ReportFunnelPassport, ReportTarget } from "@/services/reportContract";
import {
  ageMatchedWindow,
  buildReportSnapshot,
  computeDelta,
  isCohortMature,
  percent,
  ratio,
  renderMoney,
  renderPercent,
  rollupCohorts,
  spendUnavailable,
  UNAVAILABLE_RENDER,
  type ReportBuilderInput,
} from "@/services/reportBuilder";

function row(over: Partial<CohortAggregateRow> = {}): CohortAggregateRow {
  return {
    cohort_date: "2026-07-21",
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    trial_users: 100,
    upsell_users: 12,
    first_subscription_users: 40,
    renewal_users: 10,
    renewal_users_by_level: { 2: 8, 3: 2 },
    refund_users: 5,
    support_users: 9,
    support_rate: 9,
    active_users: 0,
    active_subscriptions: 0,
    cancelled_users: 0,
    user_cancelled_users: 0,
    auto_cancelled_users: 0,
    cancelled_active_users: 0,
    trial_revenue: 100,
    upsell_revenue: 180,
    first_subscription_revenue: 1200,
    renewal_revenue: 300,
    gross_revenue: 1780,
    net_revenue: 1600,
    amount_refunded: 180,
    revenue_d0: 100,
    revenue_d7: 400,
    revenue_d14: 900,
    revenue_d30: 1500,
    revenue_d60: 1600,
    net_revenue_1m: 1500,
    ltv_1m_per_user: 15,
    upsell_1_users: 10,
    upsell_2_users: 2,
    upsell_3_users: 0,
    upsell_extra_users: 0,
    upsell_1_revenue: 150,
    upsell_2_revenue: 30,
    upsell_3_revenue: 0,
    upsell_extra_revenue: 0,
    funnel_upsell_users: 12,
    funnel_upsell_revenue: 180,
    token_buyers: 5,
    token_purchases: 6,
    token_gross_revenue: 50,
    token_net_revenue: 45,
    addon_revenue: 225,
    fx_missing_transactions: 0,
    fx_missing_amount: 0,
    fb_spend: 1500,
    dedup: {
      active_user_hashes: [],
      active_subscription_hashes: [],
      refunded_user_hashes: ["r1", "r2", "r3", "r4", "r5"],
      cancelled_user_hashes: [],
      user_cancelled_user_hashes: [],
      auto_cancelled_user_hashes: [],
      cancelled_active_user_hashes: [],
      token_buyer_hashes: ["t1", "t2", "t3", "t4", "t5"],
    },
    ...over,
  } as CohortAggregateRow;
}

function passport(over: Partial<ReportFunnelPassport> = {}): ReportFunnelPassport {
  return {
    funnelPath: "soulmate-sketch",
    displayName: "Soulmate Sketch",
    trialPrice: 1,
    trialCurrency: "USD",
    trialDurationDays: 7,
    subscriptionPrice: 29.99,
    subscriptionCurrency: "USD",
    billingPeriod: "monthly",
    upsells: [],
    defaultLanguage: "en",
    defaultCurrency: "USD",
    geoLocalization: ["US"],
    destination: "web_app",
    product: null,
    trafficSources: ["facebook"],
    incomplete: false,
    ...over,
  };
}

function input(over: Partial<ReportBuilderInput> = {}): ReportBuilderInput {
  return {
    period: { from: "2026-07-21", to: "2026-07-27" },
    compare: { from: "2026-07-14", to: "2026-07-20" },
    periodRows: [row()],
    compareRows: [row({ cohort_date: "2026-07-14", trial_users: 80, fb_spend: 1600, first_subscription_users: 28 })],
    passports: { "soulmate-sketch": passport() },
    targets: [],
    gaps: [],
    provenance: [],
    engineVersions: {
      report: "report-v1",
      cohortClassification: "cohort_classifier_v3_platform",
      funnelEconomics: "1.0.0",
      supportClassification: "support_llm_v2",
      fxRatesAsOf: "2026-07-01",
    },
    snapshotStatus: "current",
    warehouseVersionBefore: "whv_1",
    warehouseVersionAfter: "whv_1",
    collectedAt: "2026-08-04T09:00:00Z",
    ...over,
  };
}

describe("ratio and percent", () => {
  it("return null on a zero or negative denominator instead of 0", () => {
    expect(ratio(5, 0)).toBeNull();
    expect(percent(5, 0)).toBeNull();
    expect(percent(0, 100)).toBe(0); // a real measured zero still reads as 0
  });
});

describe("rollupCohorts", () => {
  it("sums trial-anchored counts and dedups the email-keyed ones", () => {
    // The same refund/token identities appear in both rows: summing would
    // double-count them, so the rollup must go through the hash sets.
    const rollup = rollupCohorts([row(), row({ cohort_date: "2026-07-22" })]);
    expect(rollup.trialUsers).toBe(200);
    expect(rollup.firstSubscriptionUsers).toBe(80);
    expect(rollup.refundUsers).toBe(5);
    expect(rollup.tokenBuyers).toBe(5);
    expect(rollup.renewalUsersByLevel[2]).toBe(16);
  });

  it("keeps spend null when no row carried it, rather than reporting 0", () => {
    const withSpend = rollupCohorts([row({ fb_spend: 500 })]);
    expect(withSpend.fbSpend).toBe(500);

    const noSpend = rollupCohorts([row({ fb_spend: null }), row({ fb_spend: undefined })]);
    expect(noSpend.fbSpend).toBeNull();
    expect(noSpend.rowsWithSpend).toBe(0);
  });
});

describe("isCohortMature", () => {
  it("requires the trial to have ended before the collection date", () => {
    expect(isCohortMature("2026-07-21", 7, "2026-07-28")).toBe(true);
    expect(isCohortMature("2026-07-21", 7, "2026-07-27")).toBe(false);
  });

  it("is never mature when the trial length is unknown — a guess is not a fact", () => {
    expect(isCohortMature("2026-01-01", null, "2026-08-04")).toBe(false);
  });
});

describe("spendUnavailable", () => {
  const rollup = rollupCohorts([row()]);

  it("blocks spend when the snapshot that carries it is missing", () => {
    const gap = spendUnavailable("missing", rollup);
    expect(gap?.reason).toBe("snapshot_stale");
    expect(gap?.detail).toContain("снапшот");
  });

  it("passes when the snapshot is current and rows carried spend", () => {
    expect(spendUnavailable("current", rollup)).toBeNull();
  });

  it("blocks when the rows themselves carried no spend at all", () => {
    expect(spendUnavailable("current", rollupCohorts([row({ fb_spend: null })]))?.reason).toBe("no_source");
  });
});

describe("computeDelta", () => {
  it("marks a fall in CPA as better and a fall in trials as worse", () => {
    const cpaDown = computeDelta(12, 20, "money", { polarity: "lower_better", sampleSize: 500 });
    expect(cpaDown?.better).toBe(true);
    expect(cpaDown?.direction).toBe("down");

    const trialsDown = computeDelta(80, 100, "count", { polarity: "higher_better", sampleSize: 500 });
    expect(trialsDown?.better).toBe(false);
  });

  it("refuses to call a move significant on a sample that cannot support it", () => {
    const tiny = computeDelta(50, 30, "percent", { polarity: "higher_better", sampleSize: 12, minSample: 50 });
    expect(tiny?.significant).toBe(false);
    const big = computeDelta(50, 30, "percent", { polarity: "higher_better", sampleSize: 400, minSample: 50 });
    expect(big?.significant).toBe(true);
  });

  it("ignores noise below the relative floor", () => {
    const noise = computeDelta(101, 100, "count", { polarity: "higher_better", sampleSize: 1000 });
    expect(noise?.significant).toBe(false);
  });

  it("returns null when either side is unavailable, instead of inventing a move", () => {
    expect(computeDelta(null, 10, "money", { polarity: "neutral" })).toBeNull();
    expect(computeDelta(10, null, "money", { polarity: "neutral" })).toBeNull();
  });
});

describe("buildReportSnapshot", () => {
  it("builds KPIs with deltas against the comparison period", () => {
    const snapshot = buildReportSnapshot(input());
    expect(snapshot.kpi.trials.current.value).toBe(100);
    expect(snapshot.kpi.trials.delta?.previous).toBe(80);
    expect(snapshot.kpi.trials.delta?.direction).toBe("up");
    expect(snapshot.kpi.gross_revenue.current.rendered).toBe(renderMoney(1780));
  });

  it("renders an unavailable metric as an em dash and never as 0", () => {
    const snapshot = buildReportSnapshot(input({ snapshotStatus: "missing" }));
    expect(snapshot.kpi.spend.current.value).toBeNull();
    expect(snapshot.kpi.spend.current.rendered).toBe(UNAVAILABLE_RENDER);
    expect(snapshot.kpi.blended_cpa.current.rendered).toBe(UNAVAILABLE_RENDER);
    expect(snapshot.provisionalReasons).toContain("spend_unavailable");
    expect(snapshot.dataIncomplete).toBe(true);
  });

  it("withholds conversion while the trial has not ended, and reports it once it has", () => {
    // Collected the day after a 7-day trial that started on the 21st: not yet.
    const early = buildReportSnapshot(input({ collectedAt: "2026-07-24T09:00:00Z" }));
    expect(early.kpi.trial_to_sub_cr.current.value).toBeNull();
    expect(early.kpi.trial_to_sub_cr.current.unavailable?.reason).toBe("not_mature");
    expect(early.provisionalReasons).toContain("conversion_immature");

    // Collected well after: 40 of 100 converted.
    const late = buildReportSnapshot(input());
    expect(late.kpi.trial_to_sub_cr.current.value).toBe(40);
    expect(late.kpi.trial_to_sub_cr.current.rendered).toBe(renderPercent(40));
  });

  it("treats a funnel with no trial duration as unmeasurable rather than guessing", () => {
    const snapshot = buildReportSnapshot(input({
      passports: { "soulmate-sketch": passport({ trialDurationDays: null, incomplete: true }) },
    }));
    expect(snapshot.kpi.trial_to_sub_cr.current.value).toBeNull();
    expect(snapshot.funnels[0].passport.incomplete).toBe(true);
  });

  it("flags a warehouse that moved mid-collection instead of pretending consistency", () => {
    const snapshot = buildReportSnapshot(input({
      warehouseVersionBefore: "whv_1", warehouseVersionAfter: "whv_2",
    }));
    expect(snapshot.consistent).toBe(false);
    expect(snapshot.provisionalReasons).toContain("warehouse_moved_during_collection");
  });

  it("scores targets against the goal that applied at period end", () => {
    const targets: ReportTarget[] = [{
      id: "t1", metricKey: "trial_to_sub_cr", scopeKind: "global", scopeValue: null,
      targetValue: 40, comparator: "gte", effectiveFrom: "2026-07-01",
      effectiveTo: null, note: null, createdAt: "2026-07-01T00:00:00Z",
    }];
    const snapshot = buildReportSnapshot(input({ targets }));
    expect(snapshot.kpi.trial_to_sub_cr.target?.met).toBe(true);
    expect(snapshot.thresholds.trial_to_sub_cr).toBe(40);
  });

  it("groups funnels, orders them by spend and marks a funnel with no history as new", () => {
    const snapshot = buildReportSnapshot(input({
      periodRows: [
        row({ campaign_path: "quiet-funnel", fb_spend: 100 }),
        row({ campaign_path: "big-funnel", fb_spend: 9000 }),
      ],
      compareRows: [row({ campaign_path: "quiet-funnel", fb_spend: 120 })],
      passports: {
        "quiet-funnel": passport({ funnelPath: "quiet-funnel" }),
        "big-funnel": passport({ funnelPath: "big-funnel" }),
      },
    }));
    expect(snapshot.funnels.map((f) => f.funnelPath)).toEqual(["big-funnel", "quiet-funnel"]);
    expect(snapshot.funnels.find((f) => f.funnelPath === "big-funnel")?.isNew).toBe(true);
    expect(snapshot.funnels.find((f) => f.funnelPath === "quiet-funnel")?.isNew).toBe(false);
    expect(snapshot.funnels[0].metrics.spend.current.evidence).toBe("funnels[big-funnel].spend");
  });

  it("is deterministic — the same input twice produces the same snapshot", () => {
    expect(JSON.stringify(buildReportSnapshot(input())))
      .toBe(JSON.stringify(buildReportSnapshot(input())));
  });
});

describe("age matching — the comparison correctness rule", () => {
  it("picks the largest window both periods have completed", () => {
    // Period ends 27.07, compare ends 20.07, collected 04.08:
    // the younger side has lived 8 days, so D7 is the widest fair window.
    expect(ageMatchedWindow(
      { from: "2026-07-21", to: "2026-07-27" },
      { from: "2026-07-14", to: "2026-07-20" },
      "2026-08-04",
    )).toBe(7);

    // A month later both sides are past 30.
    expect(ageMatchedWindow(
      { from: "2026-07-21", to: "2026-07-27" },
      { from: "2026-07-14", to: "2026-07-20" },
      "2026-09-01",
    )).toBe(30);
  });

  it("returns null when even D0 is not complete on both sides", () => {
    expect(ageMatchedWindow(
      { from: "2026-08-03", to: "2026-08-09" },
      { from: "2026-07-27", to: "2026-08-02" },
      "2026-08-04",
    )).toBeNull();
  });

  it("compares revenue at the same age instead of two different ages", () => {
    // Both weeks earn the same D7 revenue, but the older week has accumulated
    // far more lifetime. A lifetime comparison would report a collapse; the
    // age-matched one correctly reports no change.
    const snapshot = buildReportSnapshot(input({
      periodRows: [row({ revenue_d7: 400, gross_revenue: 500 })],
      compareRows: [row({ cohort_date: "2026-07-14", revenue_d7: 400, gross_revenue: 4000 })],
    }));
    const matched = snapshot.kpi.revenue_matched;
    expect(matched.label).toBe("Выручка когорт (D7)");
    expect(matched.current.value).toBe(400);
    expect(matched.delta?.absolute).toBe(0);
    expect(matched.delta?.direction).toBe("flat");
  });

  it("shows accumulated revenue but refuses to put a delta on it", () => {
    const snapshot = buildReportSnapshot(input());
    expect(snapshot.kpi.gross_revenue.current.value).toBe(1780);
    expect(snapshot.kpi.gross_revenue.delta).toBeNull();
    expect(snapshot.kpi.net_revenue.delta).toBeNull();
    expect(snapshot.kpi.refund_amount.delta).toBeNull();
  });

  it("withholds monthly LTV until the cohorts are actually a month old", () => {
    const early = buildReportSnapshot(input());
    expect(early.kpi.ltv_1m.current.value).toBeNull();
    expect(early.kpi.ltv_1m.current.unavailable?.reason).toBe("not_mature");

    const later = buildReportSnapshot(input({ collectedAt: "2026-09-01T09:00:00Z" }));
    expect(later.kpi.ltv_1m.current.value).not.toBeNull();
  });

  it("shows conversion as an early signal but withholds the comparison until both weeks are observed equally", () => {
    // Eight days after the period ended: the trial has finished, so the value
    // is real — but this week's cohorts have had one post-trial day to convert
    // against the comparison week's eight, so the delta would be an artefact.
    const early = buildReportSnapshot(input());
    expect(early.kpi.trial_to_sub_cr.current.value).toBe(40);
    expect(early.kpi.trial_to_sub_cr.delta).toBeNull();
    expect(early.kpi.first_subscriptions.delta).toBeNull();

    // Two weeks of observation on both sides: now the comparison is fair.
    const settled = buildReportSnapshot(input({ collectedAt: "2026-08-12T09:00:00Z" }));
    expect(settled.kpi.trial_to_sub_cr.delta).not.toBeNull();
  });

  it("keeps funnel-level evidence paths pointing at the funnel", () => {
    const snapshot = buildReportSnapshot(input());
    const funnel = snapshot.funnels[0];
    expect(funnel.metrics.trials.current.evidence).toBe("funnels[soulmate-sketch].trials");
    expect(funnel.metrics.revenue_matched.current.evidence).toBe("funnels[soulmate-sketch].revenue_matched");
  });
});
