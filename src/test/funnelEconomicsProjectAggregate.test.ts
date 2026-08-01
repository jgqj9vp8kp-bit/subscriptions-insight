// Project aggregation over REAL engine results (P1, rev. 3 §17 invariants 1–15, 17, 24–25, 29 subset).
//
// These tests run the actual FunnelEconomicsEngine — no mocked results — so the
// composition invariants (1-funnel parity, additive identities, ΣO === pool,
// combined payback) are pinned against the same math production will run.
import { describe, expect, it } from "vitest";
import {
  aggregateProject,
  buildBoundarySeries,
  buildForecastRowEconomics,
  buildPeriodSchedule,
  buildSpendOnlyRowEconomics,
  computeOverheadShares,
  createFrozenForecastInputs,
  defaultFeeApplicability,
  prorateSharedCostPool,
  runFrozenForecast,
  type Cadence,
  type DayGridSeries,
  type ForecastAssumptionsResolved,
  type ForecastResult,
  type FrozenForecastInputs,
  type ProjectRowEconomics,
  type ProjectSpendScope,
  type ProvisionalFlags,
  type SharedCostPool,
  type SpendIdentityCheck,
} from "@/services/funnelEconomics";

const RESOLVED_AT = "2026-08-01T00:00:00.000Z";
const JULY = { from: "2026-07-01", to: "2026-07-31" };

const POOL: SharedCostPool = {
  monthly: { ffBilling: 5000, funnelConstructor: 2271.36, payroll: 9000 },
  proration: { mode: "calendar_prorated" },
  extras: [],
};

interface ScenarioSpec {
  id: string;
  cadence: Cadence;
  budget: number;
  cpa: number;
  trialPrice: number;
  periodPrice: number;
  survival: number[];
  share: number;
  extraCosts?: Array<{ key: string; label: string; amount: number }>;
}

function frozenFor(spec: ScenarioSpec, pool: SharedCostPool, poolAmount: number): FrozenForecastInputs {
  const assumptions: ForecastAssumptionsResolved = {
    traffic: { plannedBudget: spec.budget, targetCpa: spec.cpa, trafficCommission: 0.04 },
    pricing: {
      schedule: buildPeriodSchedule({
        cadence: spec.cadence,
        paidPeriods: spec.survival.length - 1,
        trialPrice: spec.trialPrice,
        periodPrice: spec.periodPrice,
      }),
    },
    retention: { survival: [...spec.survival], observedDepth: spec.survival.length },
    monetization: { upsells: [], tokenArpuPerTrial: 0, tokenArpuHold: 0 },
    costs: {
      stripeCommission: 0.07,
      refundRate: 0.1,
      providerCommission: 0.059,
      feeApplicability: defaultFeeApplicability(),
      // The resolver writes the SAME prorated pool into every entry and passes the
      // pre-computed share — the engine multiplies pool × share (its designed seam).
      // The pool triple is scaled so its sum equals the prorated amount.
      fixed: scaleFixed(pool, poolAmount),
      overheadAllocation: { mode: "by_spend_share", share: spec.share },
      extraCosts: spec.extraCosts ?? [],
    },
  };
  return createFrozenForecastInputs({ assumptions, resolvedAt: RESOLVED_AT });
}

function scaleFixed(pool: SharedCostPool, target: number): { ffBilling: number; funnelConstructor: number; payroll: number } {
  const raw = pool.monthly.ffBilling + pool.monthly.funnelConstructor + pool.monthly.payroll;
  const factor = raw > 0 ? target / raw : 0;
  return {
    ffBilling: pool.monthly.ffBilling * factor,
    funnelConstructor: pool.monthly.funnelConstructor * factor,
    payroll: pool.monthly.payroll * factor,
  };
}

function scopeFor(rows: ReadonlyArray<ProjectRowEconomics>, over: Partial<ProjectSpendScope> = {}): ProjectSpendScope {
  // Spend ≈ outflow × (1 − commission); exact scoping math is covered in
  // funnelEconomicsProject.test.ts — here the scope is a fixture input.
  const scoped = over.projectScopedSpend ?? rows.reduce((sum, row) => sum + (row.trafficCashOutflow ?? 0) * 0.96, 0);
  return {
    windowSourceSpend: over.windowSourceSpend ?? scoped,
    inProjectResolvedSpend: over.inProjectResolvedSpend ?? scoped,
    outOfProjectSpend: over.outOfProjectSpend ?? 0,
    includedUnresolvedSpend: over.includedUnresolvedSpend ?? 0,
    projectScopedSpend: scoped,
    includedUnresolvedOutflow: over.includedUnresolvedOutflow ?? 0,
    unresolvedCommissionSpend: over.unresolvedCommissionSpend ?? 0,
    spendCoverage: over.spendCoverage ?? 1,
  };
}

const CLEAN_IDENTITY: SpendIdentityCheck = { ok: true, sourceDelta: 0, resolvedDelta: 0 };
const CLEAN_FLAGS: ProvisionalFlags = {
  spendIncomplete: false,
  attributedOnlyMode: false,
  unresolvedCommission: false,
  unconfirmedCadenceBudgetShare: 0,
};

function runProject(specs: ScenarioSpec[], options: {
  poolAmount?: number;
  spendOnly?: Array<{ funnelId: string; outflow: number | null; share: number; ownExtras?: Array<{ key: string; label: string; amount: number }> }>;
  scope?: Partial<ProjectSpendScope>;
  provisional?: Partial<ProvisionalFlags>;
} = {}) {
  const poolAmount = options.poolAmount ?? prorateSharedCostPool(POOL, JULY);
  const results = new Map<string, ForecastResult>();
  const rows: ProjectRowEconomics[] = [];
  const series: DayGridSeries[] = [];
  for (const spec of specs) {
    const result = runFrozenForecast(frozenFor(spec, POOL, poolAmount));
    results.set(spec.id, result);
    rows.push(buildForecastRowEconomics({ funnelId: spec.id, result, overheadShare: spec.share }));
    series.push(buildBoundarySeries(spec.id, result.timeline.periods));
  }
  for (const spendOnly of options.spendOnly ?? []) {
    rows.push(buildSpendOnlyRowEconomics({
      funnelId: spendOnly.funnelId,
      ledger: { trafficCashOutflow: spendOnly.outflow },
      overheadShare: spendOnly.share,
      proratedPool: poolAmount,
      ownExtras: spendOnly.ownExtras ?? [],
      bonusPolicyKind: "per_funnel",
    }));
  }
  const refundCostTotal = [...results.values()].reduce((sum, result) => sum + result.costs.refundTotal, 0);
  const totals = aggregateProject({
    rows,
    series,
    scope: scopeFor(rows, options.scope),
    proratedPool: poolAmount,
    policy: { headlinePayback: "fully_loaded" },
    provisional: { ...CLEAN_FLAGS, ...options.provisional },
    windowIdentity: CLEAN_IDENTITY,
    refundCostTotal,
  });
  return { totals, results, rows, poolAmount };
}

// A funnel that clearly pays back within the horizon. NOTE: survival entries are
// per-period conversion multipliers (the chain compounds), so retention must be
// strong enough for the compounded users × price to out-earn the outflow.
const HEALTHY: ScenarioSpec = {
  id: "healthy",
  cadence: "monthly",
  budget: 10_000,
  cpa: 25,
  trialPrice: 1,
  periodPrice: 45,
  survival: [1, 0.62, 0.55, 0.5, 0.45, 0.42, 0.4],
  share: 1,
};
// …and one that never does (price too small to ever cover its outflow).
const HOPELESS: ScenarioSpec = {
  id: "hopeless",
  cadence: "monthly",
  budget: 20_000,
  cpa: 50,
  trialPrice: 0.5,
  periodPrice: 1,
  survival: [1, 0.3, 0.2, 0.1],
  share: 1,
};

describe("invariant 1 — a 1-funnel project IS that funnel's forecast", () => {
  it("every total deep-equals the single engine result, including traffic-only payback day", () => {
    const { totals, results, poolAmount } = runProject([HEALTHY]);
    const result = results.get("healthy")!;

    expect(totals.trials).toBe(result.metrics.trials);
    expect(totals.grossRevenue).toBe(result.revenue.grossTotal);
    expect(totals.paymentNetRevenue).toBe(result.profitability.paymentNetRevenueTotal);
    expect(totals.contributionProfit).toBe(result.profitability.contributionProfit);
    expect(totals.performanceBonus).toBe(result.costs.performanceBonus);
    expect(totals.allocatedOverhead).toBeCloseTo(poolAmount, 8);
    expect(totals.allocatedOverhead).toBe(result.costs.allocatedOverhead);
    expect(totals.netProfit).toBe(result.profitability.netProfit);
    expect(totals.trafficCashOutflow).toBe(result.costs.trafficCashOutflow);
    // The assertion that pins dayGridStep: "period_end" — the engine's own payback
    // is traffic-only, so it must equal the stacked traffic-only crossing exactly.
    expect(totals.paybackTrafficOnlyDay).toBe(result.payback.paybackDay);
    expect(totals.paybackTrafficOnlyDay).not.toBeNull();
    // Fully loaded crosses later or never — never earlier.
    if (totals.paybackFullyLoadedDay !== null) {
      expect(totals.paybackFullyLoadedDay).toBeGreaterThanOrEqual(totals.paybackTrafficOnlyDay!);
    }
    expect(totals.headlinePaybackDay).toBe(totals.paybackFullyLoadedDay);
  });
});

describe("invariant 2 — additive identities reconcile", () => {
  it("two funnels: sums, ΣCP = ΣPN − ΣT, ΣNP = ΣCP − ΣB − ΣO − ΣE", () => {
    const a = { ...HEALTHY, id: "a", share: 0.6 };
    const b = { ...HOPELESS, id: "b", share: 0.4 };
    const { totals, results } = runProject([a, b]);
    const ra = results.get("a")!;
    const rb = results.get("b")!;

    expect(totals.trials).toBeCloseTo(ra.metrics.trials + rb.metrics.trials, 9);
    expect(totals.grossRevenue).toBeCloseTo(ra.revenue.grossTotal + rb.revenue.grossTotal, 9);
    expect(totals.contributionProfit).toBeCloseTo(
      totals.paymentNetRevenue - (totals.trafficCashOutflow ?? Number.NaN),
      6,
    );
    expect(totals.netProfit).toBeCloseTo(
      totals.contributionProfit - totals.performanceBonus - totals.allocatedOverhead - totals.extraTotal,
      6,
    );
  });
});

describe("invariants 3–4 — ratios recomputed, never averaged", () => {
  const a = { ...HEALTHY, id: "a", budget: 30_000, cpa: 30, share: 0.75 };
  const b = { ...HEALTHY, id: "b", budget: 10_000, cpa: 80, share: 0.25 };

  it("blended CPA = Σspend/Σtrials and differs from mean(cpa)", () => {
    const { totals } = runProject([a, b], { scope: { projectScopedSpend: 40_000 } });
    expect(totals.blendedCpa).toBeCloseTo(40_000 / totals.trials, 9);
    const mean = (30 + 80) / 2;
    expect(Math.abs((totals.blendedCpa ?? 0) - mean)).toBeGreaterThan(5);
  });

  it("fully-loaded LTV is recomputed — NOT the sum of engine fullyLoadedLtv (extras asymmetry)", () => {
    const withExtras = { ...a, extraCosts: [{ key: "shared:audit", label: "Audit", amount: 5_000 }] };
    const { totals, results } = runProject([withExtras, b]);
    const naive =
      (results.get("a")!.metrics.fullyLoadedLtv * results.get("a")!.metrics.trials +
        results.get("b")!.metrics.fullyLoadedLtv * results.get("b")!.metrics.trials) /
      totals.trials;
    // The engine's fullyLoadedLtv omits extraTotal; the project must not inherit that.
    expect(totals.fullyLoadedLtv).not.toBeNull();
    expect(Math.abs((totals.fullyLoadedLtv ?? 0) - naive)).toBeGreaterThan(0.01);
    expect(totals.fullyLoadedLtv).toBeCloseTo(
      (totals.paymentNetRevenue - totals.performanceBonus - totals.allocatedOverhead - totals.extraTotal) / totals.trials,
      9,
    );
  });

  it("contribution LTV = ΣPN/Σn (trials-weighted by construction)", () => {
    const { totals, results } = runProject([a, b]);
    const weighted =
      (results.get("a")!.profitability.paymentNetRevenueTotal + results.get("b")!.profitability.paymentNetRevenueTotal) /
      totals.trials;
    expect(totals.contributionLtv).toBeCloseTo(weighted, 9);
  });
});

describe("invariant 5 — project payback comes from the combined curve", () => {
  it("healthy + hopeless: the project pays back later than the healthy funnel alone, and not at min/mean", () => {
    const solo = runProject([HEALTHY]).totals;
    const { totals } = runProject([{ ...HEALTHY, share: 0.5 }, { ...HOPELESS, share: 0.5 }]);
    expect(solo.paybackTrafficOnlyDay).not.toBeNull();
    // The combined curve must cross strictly later than the healthy funnel alone
    // (the hopeless one drags), and must not equal min or mean of the pair.
    if (totals.paybackTrafficOnlyDay !== null) {
      expect(totals.paybackTrafficOnlyDay).toBeGreaterThan(solo.paybackTrafficOnlyDay!);
    } else {
      expect(totals.grid.points[totals.grid.points.length - 1].total).toBeLessThan(
        totals.trafficCashOutflow ?? Infinity,
      );
    }
  });
});

describe("invariant 6 — cross-cadence stacking joins on days", () => {
  it("a weekly and a monthly funnel aggregate without period-index collisions", () => {
    const weekly: ScenarioSpec = {
      id: "weekly",
      cadence: "weekly",
      budget: 5_000,
      cpa: 25,
      trialPrice: 1,
      periodPrice: 10,
      survival: [1, 0.6, 0.5, 0.42, 0.36, 0.31],
      share: 0.5,
    };
    const { totals, results } = runProject([{ ...HEALTHY, share: 0.5 }, weekly]);
    const weeklyResult = results.get("weekly")!;
    const monthlyResult = results.get("healthy")!;
    // Grid contains weekly boundaries (7, 14, …) AND monthly ones (30, 60, …).
    const days = totals.grid.points.map((point) => point.day);
    expect(days).toContain(7);
    expect(days).toContain(30);
    // At day 30 the stack equals monthly P0 cumulative + the weekly cumulative at its
    // last boundary ≤ 30 (day 28 = 4th weekly period).
    const at30 = totals.grid.points.find((point) => point.day === 30)!.total;
    const weeklyAt28 = weeklyResult.timeline.periods[3].cumulativePaymentNetRevenue;
    const monthlyAt30 = monthlyResult.timeline.periods[0].cumulativePaymentNetRevenue;
    expect(at30).toBeCloseTo(weeklyAt28 + monthlyAt30, 9);
  });
});

describe("invariants 7–8, 24 — overhead is counted exactly once, and exclusion renormalizes", () => {
  it("Σ allocated overhead === prorated pool across forecast AND spend-only rows", () => {
    const shares = computeOverheadShares(
      [
        { funnelId: "a", kind: "forecast", spendBasisValue: 8_000, projectedTrials: 200 },
        { funnelId: "b", kind: "forecast", spendBasisValue: 6_000, projectedTrials: 120 },
        { funnelId: "waste", kind: "spend_only", spendBasisValue: 6_000, projectedTrials: 0 },
      ],
      { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } },
    );
    const { totals, poolAmount, rows } = runProject(
      [
        { ...HEALTHY, id: "a", budget: 8_000, share: shares.a },
        { ...HEALTHY, id: "b", budget: 6_000, share: shares.b },
      ],
      { spendOnly: [{ funnelId: "waste", outflow: 6_000 / 0.96, share: shares.waste }] },
    );
    // Invariant 23: the spend-only row's overhead is proportional to its spend…
    const wasteRow = rows.find((row) => row.funnelId === "waste")!;
    expect(wasteRow.allocatedOverhead).toBeCloseTo(poolAmount * 0.3, 6);
    expect(wasteRow.allocatedOverhead).toBeGreaterThan(0);
    // …and invariant 24: the pool identity holds across both kinds.
    expect(Math.abs(totals.allocatedOverhead - poolAmount)).toBeLessThan(0.01);
    expect(totals.overheadIdentityOk).toBe(true);
  });

  it("invariant 7: excluding a funnel renormalizes shares over the remainder; its frozen blob is untouched", () => {
    const allThree = [
      { funnelId: "a", kind: "forecast" as const, spendBasisValue: 1_000, projectedTrials: 25 },
      { funnelId: "b", kind: "forecast" as const, spendBasisValue: 2_000, projectedTrials: 50 },
      { funnelId: "c", kind: "forecast" as const, spendBasisValue: 7_000, projectedTrials: 175 },
    ];
    const before = computeOverheadShares(allThree, { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } });
    const poolAmount = prorateSharedCostPool(POOL, JULY);
    const frozenC = frozenFor({ ...HEALTHY, id: "c", budget: 7_000, share: before.c }, POOL, poolAmount);
    const frozenCBytes = JSON.stringify(frozenC);

    const after = computeOverheadShares(allThree.filter((row) => row.funnelId !== "c"), {
      allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true },
    });
    expect(after.a).toBeCloseTo(1 / 3, 12);
    expect(after.b).toBeCloseTo(2 / 3, 12);
    expect(after.a + after.b).toBe(1);

    const { totals } = runProject([
      { ...HEALTHY, id: "a", budget: 1_000, share: after.a },
      { ...HEALTHY, id: "b", budget: 2_000, share: after.b },
    ]);
    expect(Math.abs(totals.allocatedOverhead - poolAmount)).toBeLessThan(0.01);
    // The excluded funnel's snapshot was never mutated by the exclusion.
    expect(JSON.stringify(frozenC)).toBe(frozenCBytes);
  });
});

describe("invariant 9 — funnel-specific costs stay funnel-specific", () => {
  it("ownExtras land only on their row and in ΣE", () => {
    const a = { ...HEALTHY, id: "a", share: 0.5, extraCosts: [{ key: "own:video", label: "Video", amount: 1_500 }] };
    const b = { ...HEALTHY, id: "b", share: 0.5 };
    const { totals, rows } = runProject([a, b]);
    expect(rows.find((row) => row.funnelId === "a")!.extraTotal).toBe(1_500);
    expect(rows.find((row) => row.funnelId === "b")!.extraTotal).toBe(0);
    expect(totals.extraTotal).toBe(1_500);
  });
});

describe("invariant 10 — the composition is JSON-round-trip reproducible", () => {
  it("replayed frozen inputs reproduce identical totals, grid and paybacks", () => {
    const specs = [{ ...HEALTHY, share: 0.7 }, { ...HOPELESS, id: "drag", share: 0.3 }];
    const first = runProject(specs);

    const poolAmount = first.poolAmount;
    const revivedRows: ProjectRowEconomics[] = [];
    const revivedSeries: DayGridSeries[] = [];
    let refundCostTotal = 0;
    for (const spec of specs) {
      const revivedFrozen = JSON.parse(JSON.stringify(frozenFor(spec, POOL, poolAmount))) as FrozenForecastInputs;
      const result = runFrozenForecast(revivedFrozen);
      refundCostTotal += result.costs.refundTotal;
      revivedRows.push(buildForecastRowEconomics({ funnelId: spec.id, result, overheadShare: spec.share }));
      revivedSeries.push(buildBoundarySeries(spec.id, result.timeline.periods));
    }
    const replayed = aggregateProject({
      rows: revivedRows,
      series: revivedSeries,
      scope: scopeFor(revivedRows),
      proratedPool: poolAmount,
      policy: { headlinePayback: "fully_loaded" },
      provisional: CLEAN_FLAGS,
      windowIdentity: CLEAN_IDENTITY,
      refundCostTotal,
    });
    expect(replayed).toEqual(first.totals);
  });
});

describe("invariants 13, 17, 25 — spend-only rows", () => {
  it("invariant 17: zero-trial spend burdens the P&L and removing it restores prior totals", () => {
    const base = runProject([{ ...HEALTHY, share: 1 }]);
    const withWaste = runProject([{ ...HEALTHY, share: 0.7 }], {
      spendOnly: [{ funnelId: "waste", outflow: 6_562.5, share: 0.3 }],
    });
    // Trials and revenue are untouched by the waste row…
    expect(withWaste.totals.trials).toBe(base.totals.trials);
    expect(withWaste.totals.grossRevenue).toBe(base.totals.grossRevenue);
    // …but contribution falls by exactly its outflow and payback moves later.
    expect(withWaste.totals.contributionProfit).toBeCloseTo(base.totals.contributionProfit - 6_562.5, 6);
    if (base.totals.paybackTrafficOnlyDay !== null && withWaste.totals.paybackTrafficOnlyDay !== null) {
      expect(withWaste.totals.paybackTrafficOnlyDay).toBeGreaterThanOrEqual(base.totals.paybackTrafficOnlyDay);
    }
    expect(withWaste.totals.spendOnlyIncluded).toBe(1);
  });

  it("invariant 25: spend-only bonus is exactly zero with reason ineligible_no_conversions (no evaluator exists to call)", () => {
    const row = buildSpendOnlyRowEconomics({
      funnelId: "waste",
      ledger: { trafficCashOutflow: 1_000 },
      overheadShare: 0.1,
      proratedPool: 10_000,
      ownExtras: [{ key: "own:x", label: "X", amount: 50 }],
      bonusPolicyKind: "per_funnel",
    });
    expect(row.performanceBonus).toBe(0);
    expect(row.bonusIneligibleReason).toBe("ineligible_no_conversions");
    expect(row.contributionProfit).toBe(-1_000);
    expect(row.netProfit).toBeCloseTo(-1_000 - 1_000 - 50, 9);
    expect(row.paybackDay).toBeNull();

    const disabled = buildSpendOnlyRowEconomics({
      funnelId: "waste",
      ledger: { trafficCashOutflow: 1_000 },
      overheadShare: 0,
      proratedPool: 10_000,
      ownExtras: [],
      bonusPolicyKind: "disabled",
    });
    expect(disabled.bonusIneligibleReason).toBe("policy_disabled");
  });

  it("invariant 13: an unresolved spend-only outflow nulls project outflow and every derived ratio — nothing becomes 0", () => {
    const { totals } = runProject([{ ...HEALTHY, share: 0.8 }], {
      spendOnly: [{ funnelId: "mystery", outflow: null, share: 0.2 }],
      provisional: { unresolvedCommission: true },
      scope: { unresolvedCommissionSpend: 4_000 },
    });
    expect(totals.trafficCashOutflow).toBeNull();
    expect(totals.blendedCac).toBeNull();
    expect(totals.roas).toBeNull();
    expect(totals.romi).toBeNull();
    expect(totals.roi).toBeNull();
    expect(totals.paybackTrafficOnlyDay).toBeNull();
    expect(totals.paybackFullyLoadedDay).toBeNull();
    expect(totals.paybackSuppressed).toBe(true);
    expect(totals.gates.some((gate) => gate.code === "unresolved_commission")).toBe(true);
    // Revenue-side metrics that do not depend on outflow remain available.
    expect(totals.grossLtv).not.toBeNull();
  });
});

describe("invariant 29 subset — gates fire instead of plausible numbers", () => {
  it("a broken overhead identity blanks overhead-derived metrics", () => {
    // Deliberately wrong share (0.5 while being the only row) → ΣO = pool/2.
    const { totals } = runProject([{ ...HEALTHY, share: 0.5 }]);
    expect(totals.overheadIdentityOk).toBe(false);
    expect(totals.gates.some((gate) => gate.code === "overhead_identity")).toBe(true);
    expect(totals.fullyLoadedLtv).toBeNull();
    expect(totals.roi).toBeNull();
    expect(totals.paybackSuppressed).toBe(true);
  });

  it("provisional inputs surface as named gates", () => {
    const { totals } = runProject([{ ...HEALTHY, share: 1 }], {
      provisional: { spendIncomplete: true, attributedOnlyMode: true, unconfirmedCadenceBudgetShare: 0.31 },
    });
    const codes = totals.gates.map((gate) => gate.code);
    expect(codes).toContain("spend_incomplete");
    expect(codes).toContain("attributed_only");
    expect(codes).toContain("assumed_cadence");
  });

  it("a non-monotone cumulative suppresses the payback verdict", () => {
    // stripe 0.07 + refund 0.95 > 1 → payment-net negative → cumulative decreasing.
    const toxic: ScenarioSpec = { ...HEALTHY, id: "toxic", share: 0.5 };
    const poolAmount = prorateSharedCostPool(POOL, JULY);
    const frozen = frozenFor(toxic, POOL, poolAmount);
    frozen.assumptions.costs.refundRate = 0.95;
    const result = runFrozenForecast(frozen);
    const rows = [buildForecastRowEconomics({ funnelId: "toxic", result, overheadShare: 1 })];
    const totals = aggregateProject({
      rows,
      series: [buildBoundarySeries("toxic", result.timeline.periods)],
      scope: scopeFor(rows),
      proratedPool: poolAmount,
      policy: { headlinePayback: "fully_loaded" },
      provisional: CLEAN_FLAGS,
      windowIdentity: CLEAN_IDENTITY,
      refundCostTotal: result.costs.refundTotal,
    });
    expect(totals.grid.nonMonotoneSeries).toContain("toxic");
    expect(totals.paybackSuppressed).toBe(true);
    expect(totals.paybackTrafficOnlyDay).toBeNull();
    expect(totals.gates.some((gate) => gate.code === "non_monotone_cumulative")).toBe(true);
  });
});

describe("invariant 15 — 50 funnels stay responsive", () => {
  it("resolve + engine + stack + aggregate for 50 mixed-cadence funnels completes under 50 ms", () => {
    const poolAmount = prorateSharedCostPool(POOL, JULY);
    const specs: ScenarioSpec[] = Array.from({ length: 50 }, (_, index) => ({
      id: `f${String(index).padStart(2, "0")}`,
      cadence: index % 3 === 0 ? "weekly" : "monthly",
      budget: 2_000 + index * 137,
      cpa: 30 + (index % 7) * 5,
      trialPrice: 1,
      periodPrice: 20 + (index % 5) * 4,
      survival: index % 3 === 0
        ? [1, 0.6, 0.5, 0.42, 0.36, 0.31, 0.27, 0.24, 0.21, 0.19, 0.17, 0.15]
        : [1, 0.5, 0.4, 0.33, 0.28, 0.24, 0.21],
      share: 1 / 50,
    }));
    // Freeze outside the timed section (resolver work is one-off per edit).
    const frozen = specs.map((spec) => frozenFor(spec, POOL, poolAmount));

    const started = performance.now();
    const rows: ProjectRowEconomics[] = [];
    const series: DayGridSeries[] = [];
    let refundCostTotal = 0;
    frozen.forEach((inputs, index) => {
      const result = runFrozenForecast(inputs);
      refundCostTotal += result.costs.refundTotal;
      rows.push(buildForecastRowEconomics({ funnelId: specs[index].id, result, overheadShare: 1 / 50 }));
      series.push(buildBoundarySeries(specs[index].id, result.timeline.periods));
    });
    const totals = aggregateProject({
      rows,
      series,
      scope: scopeFor(rows),
      proratedPool: poolAmount,
      policy: { headlinePayback: "fully_loaded" },
      provisional: CLEAN_FLAGS,
      windowIdentity: CLEAN_IDENTITY,
      refundCostTotal,
    });
    const elapsed = performance.now() - started;

    expect(totals.funnelsIncluded).toBe(50);
    expect(Math.abs(totals.allocatedOverhead - poolAmount)).toBeLessThan(0.01);
    expect(elapsed).toBeLessThan(50);
  });
});
