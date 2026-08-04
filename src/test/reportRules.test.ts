// Reports R3: the rule engine.
//
// Table-driven where the decision table is table-shaped. The point of these
// tests is that the engine refuses to have an opinion when the sample cannot
// support one, and that one loud funnel cannot take over the weekly summary.
import { describe, expect, it } from "vitest";
import {
  applyFunnelStatuses,
  classifyFunnel,
  DEFAULT_THRESHOLDS,
  evaluateRules,
  rankFindings,
  resolveThresholds,
  scoreFinding,
  type Finding,
  type ReportThresholds,
} from "@/services/reportRules";
import type {
  ReportDelta, ReportFunnelRow, ReportMetric, ReportSnapshot,
} from "@/services/reportContract";

const T = DEFAULT_THRESHOLDS;

function metric(over: Partial<ReportMetric> & { value?: number | null } = {}): ReportMetric {
  const value = over.value ?? null;
  return {
    key: over.key ?? "m",
    label: over.label ?? "M",
    current: {
      value,
      rendered: value === null ? "—" : String(value),
      unit: "percent",
      source: "computed",
      evidence: "kpi.m",
    },
    delta: over.delta ?? null,
    target: null,
    sampleSize: over.sampleSize ?? null,
  };
}

function delta(over: Partial<ReportDelta> = {}): ReportDelta {
  return {
    previous: 0, previousRendered: "0",
    absolute: 0, absoluteRendered: "0",
    percent: 0, percentRendered: "0%",
    direction: "flat", better: null, significant: false,
    ...over,
  };
}

function funnel(path: string, over: Partial<ReportFunnelRow> = {}): ReportFunnelRow {
  return {
    funnelPath: path,
    passport: {
      funnelPath: path, displayName: path,
      trialPrice: 1, trialCurrency: "USD", trialDurationDays: 7,
      subscriptionPrice: 29.99, subscriptionCurrency: "USD", billingPeriod: "monthly",
      upsells: [], defaultLanguage: "en", defaultCurrency: "USD",
      geoLocalization: [], destination: "web_app", product: null, trafficSources: [],
      incomplete: false,
    },
    metrics: {},
    status: { status: "insufficient_data", because: "pending", ruleId: "pending" },
    isNew: false,
    ...over,
  };
}

function snapshot(over: Partial<ReportSnapshot> = {}): ReportSnapshot {
  return {
    schemaVersion: 1,
    engineVersion: "report-v1",
    engineVersions: {
      report: "report-v1", cohortClassification: "c", funnelEconomics: "1.0.0",
      supportClassification: "s", fxRatesAsOf: "2026-07-01",
    },
    period: { from: "2026-07-21", to: "2026-07-27" },
    compare: { from: "2026-07-14", to: "2026-07-20" },
    collectedAt: "2026-08-04T09:00:00Z",
    warehouseVersionBefore: "w1", warehouseVersionAfter: "w1", consistent: true,
    kpi: {}, funnels: [], gaps: [], provenance: [], thresholds: {},
    dataIncomplete: false, provisionalReasons: [],
    ...over,
  };
}

describe("classifyFunnel — the decision ladder", () => {
  const base = {
    trials: 400, matureTrials: 400, cpa: 20, trialToSubCr: 50,
    supportRate: 5, refundRate: 5, cpaTrendImproving: true, thresholds: T,
  };

  it("gates on sample before anything else, however dramatic the numbers look", () => {
    const verdict = classifyFunnel({ ...base, matureTrials: 3, cpa: 500, trialToSubCr: 0 });
    expect(verdict.status).toBe("insufficient_data");
    expect(verdict.ruleId).toBe("sample_gate");
  });

  it("says so plainly when conversion is not measurable at all", () => {
    const verdict = classifyFunnel({ ...base, trialToSubCr: null });
    expect(verdict.status).toBe("insufficient_data");
    expect(verdict.because).toContain("не измерима");
  });

  it.each([
    ["quality breach outranks everything", { supportRate: 25 }, "pause", "quality_breach"],
    ["refund breach also pauses", { refundRate: 25 }, "pause", "quality_breach"],
    ["cpa far over + cr far under pauses", { cpa: 50, trialToSubCr: 20 }, "pause", "cpa_and_cr_breach"],
    ["cpa over with no trend reduces budget", { cpa: 35, cpaTrendImproving: false }, "reduce_budget", "cpa_over_ceiling_no_trend"],
    ["cpa over but improving needs optimization", { cpa: 35, cpaTrendImproving: true }, "needs_optimization", "one_side_off"],
    ["cr under target needs optimization", { trialToSubCr: 30 }, "needs_optimization", "one_side_off"],
    ["all green at scale", {}, "scale", "all_green"],
  ])("%s", (_name, patch, expectedStatus, expectedRule) => {
    const verdict = classifyFunnel({ ...base, ...patch });
    expect(verdict.status).toBe(expectedStatus);
    expect(verdict.ruleId).toBe(expectedRule);
  });

  it("holds a green-but-thin funnel at continue_testing rather than calling it Scale", () => {
    const verdict = classifyFunnel({ ...base, trials: 30, matureTrials: 30 });
    expect(verdict.status).toBe("continue_testing");
    expect(verdict.because).toContain("30");
  });

  it("always explains itself", () => {
    for (const patch of [{}, { cpa: 50, trialToSubCr: 10 }, { matureTrials: 2 }, { trialToSubCr: 30 }]) {
      expect(classifyFunnel({ ...base, ...patch }).because.length).toBeGreaterThan(10);
    }
  });
});

describe("resolveThresholds", () => {
  it("lets a funnel override the global ceiling", () => {
    const resolved = resolveThresholds(T, { "funnel:soulmate-sketch": { cpaCeiling: 16 } },
      { funnel: "soulmate-sketch" });
    expect(resolved.cpaCeiling).toBe(16);
    expect(resolved.trialToSubTarget).toBe(T.trialToSubTarget);
  });

  it("applies model then geo then funnel, most specific last", () => {
    const resolved = resolveThresholds(T, {
      "model:weekly": { cpaCeiling: 25, trialToSubTarget: 50 },
      "geo:CO": { cpaCeiling: 20 },
      "funnel:f": { cpaCeiling: 15 },
    }, { funnel: "f", geo: "CO", billingPeriod: "weekly" });
    expect(resolved.cpaCeiling).toBe(15);
    expect(resolved.trialToSubTarget).toBe(50);
  });

  it("returns the global set untouched when nothing overrides it", () => {
    expect(resolveThresholds(T, {}, {})).toEqual(T);
  });
});

describe("scoreFinding", () => {
  it("ranks a small move on most of the budget above a big move on a rounding error", () => {
    const bigBudget = scoreFinding({ severity: "medium", budgetShare: 0.8, sampleSize: 500, minSample: 50 });
    const tinyBudget = scoreFinding({ severity: "high", budgetShare: 0.01, sampleSize: 500, minSample: 50 });
    expect(bigBudget).toBeGreaterThan(tinyBudget);
  });

  it("damps a finding resting on a thin sample", () => {
    const thin = scoreFinding({ severity: "high", budgetShare: 1, sampleSize: 10, minSample: 50 });
    const solid = scoreFinding({ severity: "high", budgetShare: 1, sampleSize: 500, minSample: 50 });
    expect(thin).toBeLessThan(solid);
  });
});

describe("evaluateRules", () => {
  it("reports a significant CPA move and names the direction", () => {
    const found = evaluateRules(snapshot({
      kpi: {
        blended_cpa: metric({
          key: "blended_cpa", value: 12.5, sampleSize: 400,
          delta: delta({ direction: "down", better: true, significant: true, percentRendered: "−20,0%" }),
        }),
      },
    }));
    const cpa = found.find((f) => f.id === "project.blended_cpa");
    expect(cpa?.polarity).toBe("good");
    expect(cpa?.claim).toContain("снизился");
  });

  it("stays silent about a move that is not significant", () => {
    const found = evaluateRules(snapshot({
      kpi: { blended_cpa: metric({ key: "blended_cpa", value: 12.5, delta: delta({ direction: "down" }) }) },
    }));
    expect(found.find((f) => f.id === "project.blended_cpa")).toBeUndefined();
  });

  it("separates scaling that held from scaling that broke", () => {
    const grew = delta({ direction: "up", significant: true, percentRendered: "+60,0%" });
    const good = evaluateRules(snapshot({
      funnels: [funnel("winner", {
        metrics: {
          spend: metric({ key: "spend", value: 9000, delta: grew }),
          blended_cpa: metric({ key: "blended_cpa", value: 12, delta: delta({ direction: "down", better: true, significant: true, percentRendered: "−15,0%" }) }),
        },
      })],
    }));
    expect(good.some((f) => f.kind === "scaling_success")).toBe(true);

    const bad = evaluateRules(snapshot({
      funnels: [funnel("loser", {
        metrics: {
          spend: metric({ key: "spend", value: 9000, delta: grew }),
          blended_cpa: metric({ key: "blended_cpa", value: 45, delta: delta({ direction: "up", better: false, significant: true, percentRendered: "+40,0%" }) }),
        },
      })],
    }));
    expect(bad.some((f) => f.kind === "degrading_while_scaling")).toBe(true);
  });

  it("names the cheap-but-weak and expensive-but-converting cases the reports act on", () => {
    const cheap = evaluateRules(snapshot({
      funnels: [funnel("cheap", {
        metrics: {
          blended_cpa: metric({ key: "blended_cpa", value: 14 }),
          trial_to_sub_cr: metric({ key: "trial_to_sub_cr", value: 20, sampleSize: 200 }),
        },
      })],
    }));
    expect(cheap.some((f) => f.kind === "cheap_but_weak")).toBe(true);

    const pricey = evaluateRules(snapshot({
      funnels: [funnel("pricey", {
        metrics: {
          blended_cpa: metric({ key: "blended_cpa", value: 45 }),
          trial_to_sub_cr: metric({ key: "trial_to_sub_cr", value: 55, sampleSize: 200 }),
        },
      })],
    }));
    expect(pricey.some((f) => f.kind === "expensive_but_converting")).toBe(true);
  });

  it("surfaces every data-quality reason as its own finding", () => {
    const found = evaluateRules(snapshot({
      provisionalReasons: ["spend_unavailable", "warehouse_moved_during_collection"],
      gaps: [{ key: "email", label: "Email-метрики", reason: "нет интеграции", affectsSections: ["email"], manualEntryAvailable: true }],
    }));
    expect(found.filter((f) => f.kind === "data_quality")).toHaveLength(3);
    expect(found.find((f) => f.id === "data.warehouse_moved_during_collection")?.severity).toBe("high");
  });
});

describe("rankFindings", () => {
  function finding(id: string, score: number, scope: string | null): Finding {
    return {
      id, kind: "cpa_move", severity: "medium", polarity: "bad", scope,
      claim: id, evidence: [], sampleSize: 100, score,
    };
  }

  it("caps how much of the summary one funnel can occupy", () => {
    const picked = rankFindings([
      finding("a1", 100, "loud"), finding("a2", 99, "loud"),
      finding("a3", 98, "loud"), finding("a4", 97, "loud"),
      finding("b1", 50, "quiet"),
    ], { limit: 8, maxPerScope: 2 });
    expect(picked.filter((f) => f.scope === "loud")).toHaveLength(2);
    expect(picked.map((f) => f.id)).toContain("b1");
  });

  it("never caps project-level findings — they are the headline by nature", () => {
    const picked = rankFindings([
      finding("p1", 100, null), finding("p2", 99, null), finding("p3", 98, null),
    ], { maxPerScope: 2 });
    expect(picked).toHaveLength(3);
  });

  it("honours the limit and is stable on ties", () => {
    const items = [finding("z", 10, "a"), finding("y", 10, "b"), finding("x", 10, "c")];
    expect(rankFindings(items, { limit: 2 }).map((f) => f.id)).toEqual(["x", "y"]);
    expect(rankFindings(items, { limit: 2 }).map((f) => f.id)).toEqual(["x", "y"]);
  });
});

describe("applyFunnelStatuses", () => {
  it("replaces the placeholder verdict and never mutates the input snapshot", () => {
    const original = snapshot({
      funnels: [funnel("f", {
        metrics: {
          trials: metric({ key: "trials", value: 400 }),
          blended_cpa: metric({ key: "blended_cpa", value: 18, delta: delta({ direction: "down" }) }),
          trial_to_sub_cr: metric({ key: "trial_to_sub_cr", value: 52, sampleSize: 400 }),
          support_rate: metric({ key: "support_rate", value: 4 }),
          refund_rate: metric({ key: "refund_rate", value: 6 }),
        },
      })],
    });
    const scored = applyFunnelStatuses(original);
    expect(scored.funnels[0].status.status).toBe("scale");
    expect(original.funnels[0].status.status).toBe("insufficient_data");
  });

  it("applies a per-funnel ceiling override", () => {
    const base = snapshot({
      funnels: [funnel("tight", {
        metrics: {
          trials: metric({ key: "trials", value: 400 }),
          blended_cpa: metric({ key: "blended_cpa", value: 18, delta: delta({ direction: "up" }) }),
          trial_to_sub_cr: metric({ key: "trial_to_sub_cr", value: 52, sampleSize: 400 }),
          support_rate: metric({ key: "support_rate", value: 4 }),
          refund_rate: metric({ key: "refund_rate", value: 6 }),
        },
      })],
    });
    const overrides: Record<string, Partial<ReportThresholds>> = { "funnel:tight": { cpaCeiling: 15 } };
    expect(applyFunnelStatuses(base, DEFAULT_THRESHOLDS, overrides).funnels[0].status.status)
      .toBe("reduce_budget");
    expect(applyFunnelStatuses(base).funnels[0].status.status).toBe("scale");
  });
});
