// Golden decisions of the AI signal engine. Each case pins the ladder outcome
// end-to-end: action, ruleId, contradictions, data notes and the null
// discipline (spend=null is "unknown", never 0).
import { describe, expect, it } from "vitest";
import {
  AI_DEFAULT_THRESHOLDS,
  aiActionLabel,
  computeAiSignals,
  observedPayback,
  wilsonInterval95,
  type AiCohortRowInput,
  type AiEngineInput,
  type AiPassRateSlice,
} from "@/services/aiSignals";
import type { FbAnalyticsRow } from "@/services/fbAnalytics";

const AS_OF = "2026-08-20";

function cohort(over: Partial<AiCohortRowInput>): AiCohortRowInput {
  return {
    cohort_date: "2026-07-01",
    funnel: "soulmate",
    campaign_path: "soulmate-sketch-web-en",
    trial_users: 100,
    first_subscription_users: 45,
    renewal_2_users: 30,
    refund_users: 2,
    amount_refunded: 40,
    gross_revenue: 2000,
    upsell_revenue: 600,
    revenue_d0: 700,
    revenue_d7: 1000,
    revenue_d14: 1300,
    revenue_d30: 1700,
    revenue_d60: 2000,
    ltv_1m_per_user: 17,
    fb_spend: 1500,
    fb_match_status: "matched",
    coverage_rate: 95,
    ...over,
  };
}

/** N peer cohorts so path benchmarks qualify (>=4 peers, >=25 pooled trials). */
function peers(count: number, over: Partial<AiCohortRowInput> = {}): AiCohortRowInput[] {
  return Array.from({ length: count }, (_, i) =>
    cohort({ cohort_date: `2026-06-${String(i + 2).padStart(2, "0")}`, ...over }),
  );
}

function run(rows: AiCohortRowInput[], extra: Partial<AiEngineInput> = {}) {
  return computeAiSignals({
    surface: "cohort",
    cohortRows: rows,
    trialDurationDaysByPath: { "soulmate-sketch-web-en": 7 },
    asOfDate: AS_OF,
    ...extra,
  });
}

function recommendationFor(output: ReturnType<typeof computeAiSignals>, cohortDate: string) {
  const rec = output.recommendations.find(
    (r) => r.scope.kind === "cohort" && r.scope.cohortDate === cohortDate,
  );
  expect(rec).toBeTruthy();
  return rec!;
}

function campaign(over: Partial<FbAnalyticsRow>): FbAnalyticsRow {
  return {
    campaign_id: "120200000000000001",
    campaign_name: "Campaign A",
    campaign_path: "soulmate-sketch-web-en",
    ad_account_id: null,
    ad_account_name: null,
    trial_users: 120,
    upsell_users: 20,
    upsell_1_users: 20,
    upsell_2_users: 0,
    upsell_3_users: 0,
    token_buyers: 5,
    token_revenue: 100,
    upsell_cr: 16,
    first_subscription_users: 55,
    trial_to_sub_cr: 45.8,
    renewal_2_users: 30,
    renewal_3_users: 12,
    active_subscriptions: 40,
    gross_revenue: 2600,
    net_revenue: 2400,
    spend: 1800,
    spend_status: "available",
    fb_purchases: 118,
    cpp: 15.25,
    impressions: 100000,
    clicks: 2800,
    ctr: 2.8,
    cpc: 0.64,
    cpm: 18,
    outbound_clicks: 2500,
    outbound_ctr: 2.5,
    currency: "USD",
    cac: 15,
    cost_per_first_sub: 32.7,
    roas: 1.33,
    revenue_per_trial: 20,
    revenue_per_purchase: 22,
    profit: 600,
    refund_users: 3,
    refund_rate: 2.5,
    failed_payment_users: 10,
    main_decline_reason: null,
    ...over,
  } as FbAnalyticsRow;
}

// ---- Path-grain golden cases (v2) -------------------------------------------

function pathRecFor(output: ReturnType<typeof computeAiSignals>, path: string) {
  const rec = output.recommendations.find((r) => r.scope.kind === "path" && r.scope.campaignPath === path);
  expect(rec).toBeTruthy();
  return rec!;
}

describe("path-grain recommendations", () => {
  it("emits one path recommendation per campaign_path, pooled from the rows", () => {
    const out = run([cohort({ cohort_date: "2026-07-01" }), ...peers(5)]);
    const rec = pathRecFor(out, "soulmate-sketch-web-en");
    expect(rec.surface).toBe("cohort");
    // 6 mature rows x 100 trials, pooled CPA 1500x6/600 = $15 → scale_strong.
    expect(rec.action).toBe("SCALE");
    expect(rec.ruleId).toBe("scale_strong");
    const cpaEv = rec.because.find((ev) => ev.metric === "cpa")!;
    expect(cpaEv.value).toBe(15);
  });

  it("judges Trial → Paid on the mature subset with a partial_maturity note", () => {
    // One IMMATURE cohort (trial window 7d, cohort 2 days old) with terrible
    // conversion must not drag the path verdict.
    const young = cohort({ cohort_date: "2026-08-19", first_subscription_users: 0, revenue_d30: 0, revenue_d60: 0 });
    const out = run([young, ...peers(5)]);
    const rec = pathRecFor(out, "soulmate-sketch-web-en");
    const convEv = rec.because.find((ev) => ev.metric === "trial_to_paid")!;
    // Mature subset: 5 peers x 45/100 = 45%, the young row excluded.
    expect(convEv.value).toBe(45);
    expect(rec.dataNotes.some((n) => n.code === "partial_maturity")).toBe(true);
  });

  it("benchmarks a path against the OTHER paths", () => {
    const pathA = [cohort({}), ...peers(5)];
    const mkPath = (path: string, cpaSpend: number) =>
      peers(5, { campaign_path: path, fb_spend: cpaSpend }).map((row, i) =>
        ({ ...row, cohort_date: `2026-05-${String(i + 2).padStart(2, "0")}` }));
    const out = run(
      [...pathA, ...mkPath("path-b", 2500), ...mkPath("path-c", 2600), ...mkPath("path-d", 2700), ...mkPath("path-e", 2800)],
      { trialDurationDaysByPath: { "soulmate-sketch-web-en": 7, "path-b": 7, "path-c": 7, "path-d": 7, "path-e": 7 } },
    );
    const rec = pathRecFor(out, "soulmate-sketch-web-en");
    const cpaEv = rec.because.find((ev) => ev.metric === "cpa")!;
    expect(cpaEv.benchmark?.source).toBe("global_peers");
    expect(cpaEv.benchmark?.peers).toBe(4); // 5 paths − this one
    expect(cpaEv.verdict).toBe("good"); // $15 vs ~$26 peers
  });

  it("a real deteriorating path trend keeps REDUCE; an improving one rescues to HOLD", () => {
    // 6 mature cohorts, CPA over ceiling; oldest 3 cheap → recent 3 expensive =
    // deteriorating → REDUCE. Reversed order → improving → rung 6 HOLD.
    const mk = (dates: string[], spends: number[]) =>
      dates.map((date, i) => cohort({ cohort_date: date, fb_spend: spends[i], ltv_1m_per_user: 40 }));
    const dates = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05", "2026-06-06"];
    const deteriorating = run(mk(dates, [3200, 3200, 3200, 4700, 4700, 4700]));
    const recBad = pathRecFor(deteriorating, "soulmate-sketch-web-en");
    expect(recBad.action).toBe("REDUCE");
    expect(recBad.because.some((ev) => ev.metric === "cpa_trend")).toBe(true);

    const improving = run(mk(dates, [4700, 4700, 4700, 3200, 3200, 3200]));
    const recGood = pathRecFor(improving, "soulmate-sketch-web-en");
    expect(recGood.action).toBe("HOLD");
    expect(recGood.ruleId).toBe("expensive_but_converting");
  });

  it("caps path opportunities at one per path, alongside cohort opportunities", () => {
    const out = run([cohort({ fb_spend: 4700 }), ...peers(5, { fb_spend: 4700 })]); // REDUCE everywhere
    const pathOpps = out.opportunities.filter((o) => o.recommendation.scope.kind === "path");
    expect(pathOpps.length).toBe(1);
    const cohortOpps = out.opportunities.filter((o) => o.recommendation.scope.kind === "cohort");
    expect(cohortOpps.length).toBeLessThanOrEqual(3);
  });

  it("pathless refund definition is amount-based and can STOP the path", () => {
    const refundy = peers(5, { amount_refunded: 500 }); // 25% of gross each
    const out = run(refundy);
    const rec = pathRecFor(out, "soulmate-sketch-web-en");
    expect(rec.action).toBe("STOP");
    expect(rec.ruleId).toBe("refund_breach_stop");
    const refundEv = rec.because.find((ev) => ev.metric === "refund_rate")!;
    expect(refundEv.label).toBe("Refund rate ($)");
  });
});

// ---- Golden ladder cases ----------------------------------------------------

describe("cohort ladder golden cases", () => {
  it("scale_strong_mature: cheap CPA + strong conversion + confirmed economics", () => {
    // CPA 1500/100 = $15 = 0.5x ceiling; conv 45% >= 40; ltvRatio 17/15 > 1.
    const out = run([cohort({ cohort_date: "2026-07-01" }), ...peers(5)]);
    const rec = recommendationFor(out, "2026-07-01");
    expect(rec.action).toBe("SCALE");
    expect(rec.budgetDeltaPct).toBe(20);
    expect(rec.ruleId).toBe("scale_strong");
    expect(rec.monitorAfter).toEqual(["cpa", "pass_rate", "refund_rate"]);
    expect(rec.confidence).toBe("high");
    expect(aiActionLabel(rec.action, rec.budgetDeltaPct)).toBe("Scale +20%");
  });

  it("cheap_but_weak: good CPA + weak conversion contradicts — WATCH, never SCALE", () => {
    const weak = cohort({ cohort_date: "2026-07-01", first_subscription_users: 15, ltv_1m_per_user: 6 }); // conv 15%
    const out = run([weak, ...peers(5)]);
    const rec = recommendationFor(out, "2026-07-01");
    expect(rec.action).toBe("WATCH");
    expect(rec.ruleId).toBe("cheap_but_weak");
    expect(rec.primaryDomain).toBe("conversion");
    expect(rec.contradictions.map((c) => c.flag)).toContain("cheap_but_weak");
  });

  it("payment_investigate beats CPA/conversion rungs when the path is a payment anomaly", () => {
    // The bad path is Wilson-separated BELOW the pooled account norm (~54%):
    // a floor breach alone must not fire when the whole account is weak.
    const passRates: Record<string, AiPassRateSlice> = {
      "soulmate-sketch-web-en": {
        attempts: 500, successful: 205, pass_rate: 0.41, pass_rate_ex_if: 0.47,
        first_sub_attempts: 200, first_sub_pass_rate: 0.4,
        renewal_attempts: 100, renewal_pass_rate: 0.45,
      },
      "healthy-path": {
        attempts: 1000, successful: 600, pass_rate: 0.6, pass_rate_ex_if: 0.65,
        first_sub_attempts: 400, first_sub_pass_rate: 0.6,
        renewal_attempts: 200, renewal_pass_rate: 0.62,
      },
    };
    const bad = cohort({ cohort_date: "2026-07-01", first_subscription_users: 15, fb_spend: 4000 }); // CPA $40 over ceiling too
    const out = run([bad, ...peers(5)], { passRates: { level: "campaign_path", byKey: passRates } });
    const rec = recommendationFor(out, "2026-07-01");
    expect(rec.action).toBe("INVESTIGATE");
    expect(rec.ruleId).toBe("payment_investigate");
    expect(rec.primaryDomain).toBe("payment");
    expect(out.signals.some((s) => s.code === "PAYMENT_PASS_BAD")).toBe(true);
    expect(rec.dataNotes.some((n) => n.code === "path_level_pass_rate")).toBe(true);
  });

  it("account-wide weak pass rate does NOT flag every path as a payment issue", () => {
    // Both paths sit near the pooled norm (~41%): floor is breached everywhere,
    // but nothing is an anomaly — the ladder must fall through to economics.
    const passRates: Record<string, AiPassRateSlice> = {
      "soulmate-sketch-web-en": {
        attempts: 500, successful: 205, pass_rate: 0.41, pass_rate_ex_if: 0.47,
        first_sub_attempts: 200, first_sub_pass_rate: 0.4,
        renewal_attempts: 100, renewal_pass_rate: 0.45,
      },
      "other-path": {
        attempts: 800, successful: 330, pass_rate: 0.4125, pass_rate_ex_if: 0.46,
        first_sub_attempts: 300, first_sub_pass_rate: 0.41,
        renewal_attempts: 150, renewal_pass_rate: 0.43,
      },
    };
    const out = run([cohort({ cohort_date: "2026-07-01" }), ...peers(5)], { passRates: { level: "campaign_path", byKey: passRates } });
    const rec = recommendationFor(out, "2026-07-01");
    expect(rec.action).not.toBe("INVESTIGATE");
    expect(out.signals.some((s) => s.code === "PAYMENT_PASS_BAD")).toBe(false);
  });

  it("immature cohort: no Trial→Paid judgement, no payback penalty", () => {
    const young = cohort({
      cohort_date: "2026-08-18", // 2 days old, 7d trial
      trial_users: 40,
      first_subscription_users: 0,
      revenue_d7: null, revenue_d14: null, revenue_d30: null, revenue_d60: null,
      ltv_1m_per_user: null,
    });
    const out = run([young, ...peers(5)]);
    const rec = recommendationFor(out, "2026-08-18");
    expect(rec.dataNotes.some((n) => n.code === "immature_cohort")).toBe(true);
    const codes = out.signals.filter((s) => s.scope.kind === "cohort" && s.scope.cohortDate === "2026-08-18").map((s) => s.code);
    expect(codes).not.toContain("TRIAL_TO_PAID_BAD");
    expect(codes).not.toContain("PAYBACK_NOT_REACHED");
  });

  it("spend=null is unknown, not zero: economics absent, action capped", () => {
    const noSpend = cohort({ cohort_date: "2026-07-01", fb_spend: null, fb_match_status: "no_fb_campaign" });
    const out = run([noSpend, ...peers(5)]);
    const rec = recommendationFor(out, "2026-07-01");
    expect(["HOLD", "WATCH", "INVESTIGATE", "NOT_ENOUGH_DATA"]).toContain(rec.action);
    expect(rec.dataNotes.some((n) => n.code === "spend_unavailable")).toBe(true);
    const own = out.signals.filter((s) => s.scope.kind === "cohort" && s.scope.cohortDate === "2026-07-01");
    expect(own.map((s) => s.code)).not.toContain("CPA_GOOD");
    expect(own.map((s) => s.code)).not.toContain("CPA_BAD");
    const cpaEvidence = rec.because.find((ev) => ev.metric === "cpa");
    expect(cpaEvidence).toBeUndefined();
  });

  it("stop_on_refund_breach with good CPA -> contradiction attached", () => {
    const refundy = cohort({ cohort_date: "2026-07-01", amount_refunded: 460, gross_revenue: 2000 }); // 23%
    const out = run([refundy, ...peers(5)]);
    const rec = recommendationFor(out, "2026-07-01");
    expect(rec.action).toBe("STOP");
    expect(rec.ruleId).toBe("refund_breach_stop");
    expect(rec.primaryDomain).toBe("refund");
    expect(rec.contradictions.map((c) => c.flag)).toContain("good_cpa_bad_downstream");
    expect(out.signals.some((s) => s.code === "REFUND_RATE_HIGH")).toBe(true);
  });

  it("benchmark_empty: lone path still gets threshold-based verdicts", () => {
    const lonely = cohort({ cohort_date: "2026-07-01", campaign_path: "lonely-path" });
    const out = computeAiSignals({
      surface: "cohort",
      cohortRows: [lonely],
      trialDurationDaysByPath: { "lonely-path": 7 },
      asOfDate: AS_OF,
    });
    const rec = out.recommendations[0];
    expect(rec.action).toBe("SCALE"); // thresholds alone qualify it
    const cpaEv = rec.because.find((ev) => ev.metric === "cpa");
    expect(cpaEv?.benchmark?.source).toBe("threshold");
    expect(out.inputStatus.benchmark).toBe("missing");
  });

  it("not_enough_data below the verdict floor", () => {
    const tiny = cohort({ cohort_date: "2026-07-01", trial_users: 9, first_subscription_users: 3 });
    const out = run([tiny, ...peers(5)]);
    const rec = recommendationFor(out, "2026-07-01");
    expect(rec.action).toBe("NOT_ENOUGH_DATA");
    expect(rec.ruleId).toBe("sample_gate");
    expect(out.signals.some((s) => s.code === "LOW_SAMPLE_SIZE" && s.scope.kind === "cohort" && s.scope.cohortDate === "2026-07-01")).toBe(true);
  });

  it("trend_deteriorating_reduce: recent CPA jump turns breach into REDUCE −20", () => {
    // 8 cohorts on one path: older 5 at CPA $20, recent 3 at CPA $39 (1.3x ceiling).
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        cohort({ cohort_date: `2026-06-${String(i + 1).padStart(2, "0")}`, fb_spend: 2000, trial_users: 100 })),
      ...Array.from({ length: 3 }, (_, i) =>
        cohort({ cohort_date: `2026-07-${String(i + 1).padStart(2, "0")}`, fb_spend: 3900, trial_users: 100 })),
    ];
    const out = run(rows);
    expect(out.signals.some((s) => s.code === "CPA_DETERIORATING" && s.scope.kind === "path")).toBe(true);
    const rec = recommendationFor(out, "2026-07-03");
    expect(rec.action).toBe("REDUCE");
    expect(rec.budgetDeltaPct).toBe(-20);
    expect(rec.ruleId).toBe("cpa_breach_reduce");
  });
});

describe("campaign ladder golden cases", () => {
  it("campaign_shared_path: spend unattributable caps the action space", () => {
    const shared = campaign({ spend: null, spend_status: "unavailable_shared_path", cac: null, roas: null });
    const out = computeAiSignals({ surface: "campaign", campaignRows: [shared, campaign({ campaign_id: "2" }), campaign({ campaign_id: "3" })], asOfDate: AS_OF });
    const rec = out.recommendations.find((r) => r.scope.kind === "campaign" && r.scope.campaignId === shared.campaign_id)!;
    expect(["HOLD", "WATCH", "INVESTIGATE", "NOT_ENOUGH_DATA"]).toContain(rec.action);
    expect(rec.action).not.toBe("SCALE");
    expect(rec.dataNotes.some((n) => n.code === "spend_unavailable")).toBe(true);
    expect(out.inputStatus.trend).toBe("missing"); // campaigns have no time axis
  });

  it("good CPA + roas >= 1 -> SCALE +20 on campaigns", () => {
    const out = computeAiSignals({ surface: "campaign", campaignRows: [campaign({})], asOfDate: AS_OF });
    const rec = out.recommendations[0];
    expect(rec.action).toBe("SCALE");
    expect(rec.budgetDeltaPct).toBe(20);
    expect(rec.dataNotes.some((n) => n.code === "not_maturity_gated")).toBe(true);
  });

  it("over-ceiling CPA with strong conversion and roas >= 1 holds instead of reducing", () => {
    const expensive = campaign({ cac: 38, trial_to_sub_cr: 68, roas: 1.1 });
    const out = computeAiSignals({ surface: "campaign", campaignRows: [expensive], asOfDate: AS_OF });
    expect(out.recommendations[0].action).toBe("HOLD");
    expect(out.recommendations[0].ruleId).toBe("expensive_but_converting");
    // Negative unit economics keeps the REDUCE path.
    const losing = campaign({ cac: 38, trial_to_sub_cr: 68, roas: 0.5 });
    const out2 = computeAiSignals({ surface: "campaign", campaignRows: [losing], asOfDate: AS_OF });
    expect(out2.recommendations[0].action).toBe("REDUCE");
  });

  it("good CPA + weak trial_to_sub_cr -> WATCH with contradiction (brief §6)", () => {
    const cheapWeak = campaign({ trial_to_sub_cr: 19, first_subscription_users: 23, cac: 13.2 });
    const out = computeAiSignals({ surface: "campaign", campaignRows: [cheapWeak], asOfDate: AS_OF });
    const rec = out.recommendations[0];
    expect(rec.action).toBe("WATCH");
    expect(rec.ruleId).toBe("cheap_but_weak");
    expect(rec.contradictions.map((c) => c.flag)).toContain("cheap_but_weak");
  });
});

// ---- Campaign CPA_fb trends (wave-2 P3) -------------------------------------

/** 14 daily points; the last 7 use recentCpa, the previous 7 prevCpa. */
function dailySeries(campaignId: string, prevCpa: number, recentCpa: number, purchasesPerDay = 10) {
  const points = Array.from({ length: 14 }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    const cpa = i < 7 ? prevCpa : recentCpa;
    return { date: `2026-08-${day}`, spend: cpa * purchasesPerDay, purchases: purchasesPerDay };
  });
  return { [campaignId]: points };
}

describe("campaign CPA_fb trend", () => {
  const ID = "120200000000000001";

  it("a known deteriorating trend disqualifies the 5a excuse -> REDUCE despite roas >= 1", () => {
    const expensive = campaign({ cac: 38, trial_to_sub_cr: 68, roas: 1.1 });
    const out = computeAiSignals({
      surface: "campaign", campaignRows: [expensive],
      campaignDailySeries: dailySeries(ID, 20, 34), // +70% CPA_fb
      asOfDate: AS_OF,
    });
    const rec = out.recommendations[0];
    expect(rec.action).toBe("REDUCE");
    expect(rec.ruleId).toBe("cpa_breach_reduce");
    expect(rec.because.some((ev) => ev.metric === "cpa_trend")).toBe(true);
    expect(out.inputStatus.trend).toBe("ok");
    expect(out.signals.some((s) => s.code === "CPA_DETERIORATING" && s.scope.kind === "campaign")).toBe(true);
  });

  it("an improving trend keeps the 5a HOLD and emits CPA_IMPROVING", () => {
    const expensive = campaign({ cac: 38, trial_to_sub_cr: 68, roas: 1.1 });
    const out = computeAiSignals({
      surface: "campaign", campaignRows: [expensive],
      campaignDailySeries: dailySeries(ID, 34, 20),
      asOfDate: AS_OF,
    });
    expect(out.recommendations[0].action).toBe("HOLD");
    expect(out.recommendations[0].ruleId).toBe("expensive_but_converting");
    expect(out.signals.some((s) => s.code === "CPA_IMPROVING")).toBe(true);
  });

  it("thin or zero-purchase windows stay unknown — 5a keeps its excuse, no infinities", () => {
    const expensive = campaign({ cac: 38, trial_to_sub_cr: 68, roas: 1.1 });
    const thin = { [ID]: [
      { date: "2026-08-12", spend: 100, purchases: 5 },
      { date: "2026-08-13", spend: 100, purchases: 5 },
      { date: "2026-08-14", spend: 100, purchases: 5 },
    ] };
    const out = computeAiSignals({ surface: "campaign", campaignRows: [expensive], campaignDailySeries: thin, asOfDate: AS_OF });
    expect(out.recommendations[0].action).toBe("HOLD");
    expect(out.recommendations[0].dataNotes.some((n) => n.code === "no_time_axis")).toBe(true);
    expect(out.inputStatus.trend).toBe("missing");

    const zeroPurchases = { [ID]: Array.from({ length: 14 }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, "0")}`, spend: 100, purchases: 0,
    })) };
    const out2 = computeAiSignals({ surface: "campaign", campaignRows: [expensive], campaignDailySeries: zeroPurchases, asOfDate: AS_OF });
    expect(JSON.stringify(out2)).not.toContain("Infinity");
    expect(out2.inputStatus.trend).toBe("missing");
  });
});

// ---- Payback math -----------------------------------------------------------

describe("observedPayback", () => {
  it("interpolates between grid points and marks provenance", () => {
    const row = cohort({ revenue_d14: 900, revenue_d30: 1700, fb_spend: 1300 });
    const reading = observedPayback(row, 1300, AS_OF);
    expect(reading.status).toBe("reached");
    expect(reading.interpolated).toBe(true);
    // 14 + (1300-900)*(30-14)/(1700-900) = 14 + 8 = 22
    expect(reading.day).toBe(22);
  });

  it("not reached by D60 on a mature cohort is a bad signal; young cohort is silent", () => {
    const mature = observedPayback(
      cohort({ cohort_date: "2026-06-01", revenue_d60: 900, revenue_d30: 700, revenue_d14: 400, revenue_d7: 200, revenue_d0: 50 }),
      2000,
      AS_OF,
    );
    expect(mature.status).toBe("not_reached_mature");
    const young = observedPayback(
      cohort({ cohort_date: "2026-08-01", revenue_d14: 400, revenue_d7: 200, revenue_d0: 50, revenue_d30: null, revenue_d60: null }),
      2000,
      AS_OF,
    );
    expect(young.status).toBe("not_reached_yet");
  });

  it("no spend -> unavailable, never a division", () => {
    expect(observedPayback(cohort({}), null, AS_OF).status).toBe("unavailable");
  });
});

describe("wilsonInterval95", () => {
  it("matches the bankAnalytics twin on a reference value", () => {
    const { low, high } = wilsonInterval95(10, 40);
    expect(low).toBeCloseTo(0.1419, 3);
    expect(high).toBeCloseTo(0.4023, 3);
  });
});

// ---- Invariants -------------------------------------------------------------

describe("engine invariants", () => {
  const fixture = [cohort({ cohort_date: "2026-07-01" }), ...peers(6), cohort({ cohort_date: "2026-07-05", trial_users: 10 })];

  it("deterministic: same input -> deep-equal output", () => {
    expect(run([...fixture])).toEqual(run([...fixture]));
  });

  it("row order does not change decisions", () => {
    const shuffled = [...fixture].reverse();
    expect(run(shuffled)).toEqual(run([...fixture]));
  });

  it("exactly one recommendation per scope; no NaN/Infinity anywhere", () => {
    const out = run([...fixture]);
    const keys = out.recommendations.map((r) => JSON.stringify(r.scope));
    expect(new Set(keys).size).toBe(keys.length);
    // v2: one recommendation per cohort row PLUS one per campaign_path.
    const pathCount = new Set(fixture.map((row) => row.campaign_path)).size;
    expect(out.recommendations).toHaveLength(fixture.length + pathCount);
    expect(out.recommendations.filter((r) => r.scope.kind === "path")).toHaveLength(pathCount);
    const flat = JSON.stringify(out);
    expect(flat).not.toContain("NaN");
    expect(flat).not.toContain("Infinity");
  });

  it("null values render as dash, never as zero", () => {
    const out = run([cohort({ fb_spend: null, fb_match_status: "no_fb_campaign" }), ...peers(5)]);
    for (const rec of out.recommendations) {
      for (const ev of rec.because) {
        if (ev.value === null) expect(ev.valueRendered).toBe("—");
      }
    }
  });

  it("context pack lines carry rendered numbers of their evidence", () => {
    const out = run([...fixture]);
    for (const item of out.contextPack.items) {
      expect(item.evidenceLines.every((line) => line.includes("—") || /\d/.test(line))).toBe(true);
    }
  });
});
