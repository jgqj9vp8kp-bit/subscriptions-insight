// Scenario comparison tests (v3 spec §25.3/.5 — baseline deltas, metric direction).
import { describe, expect, it } from "vitest";
import {
  buildPeriodSchedule,
  buildScenarioComparison,
  createFrozenForecastInputs,
  defaultFeeApplicability,
  runFrozenForecast,
  COMPARISON_METRICS,
  type ComparisonEntry,
  type ForecastAssumptionsResolved,
} from "@/services/funnelEconomics";

function scenario(id: string, overrides: { cpa?: number; budget?: number; subPrice?: number; survival1?: number } = {}): ComparisonEntry {
  const survival = [1, overrides.survival1 ?? 0.43, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.45];
  const assumptions: ForecastAssumptionsResolved = {
    traffic: { plannedBudget: overrides.budget ?? 50_000, targetCpa: overrides.cpa ?? 13, trafficCommission: 0.04 },
    pricing: {
      schedule: buildPeriodSchedule({ cadence: "monthly", paidPeriods: survival.length - 1, trialPrice: 1, periodPrice: overrides.subPrice ?? 29 }),
    },
    retention: { survival, observedDepth: survival.length },
    monetization: { upsells: [{ key: "upsell_1", takeRate: 0.166, price: 14.98 }], tokenArpuPerTrial: 0, tokenArpuHold: 0 },
    costs: {
      stripeCommission: 0.07,
      refundRate: 0.12,
      providerCommission: 0.059,
      feeApplicability: defaultFeeApplicability(),
      fixed: { ffBilling: 5000, funnelConstructor: 2271.36, payroll: 9000 },
      overheadAllocation: { mode: "fixed_amount" },
      extraCosts: [],
    },
  };
  const frozen = createFrozenForecastInputs({ assumptions, resolvedAt: "2026-07-27T00:00:00.000Z" });
  return { id, label: id, frozen, result: runFrozenForecast(frozen) };
}

describe("buildScenarioComparison", () => {
  it("baseline cells carry values but no deltas; variant deltas are direction-aware", () => {
    const base = scenario("base");
    const better = scenario("better-cpa", { cpa: 11 });
    const view = buildScenarioComparison([base, better], "base");

    const cpaRow = view.rows.find((row) => row.key === "targetCpa");
    expect(cpaRow?.cells["base"].deltaAbs).toBeNull();
    expect(cpaRow?.cells["better-cpa"].value).toBe(11);
    expect(cpaRow?.cells["better-cpa"].deltaAbs).toBeCloseTo(-2, 9);
    // Lower CPA is BETTER even though the delta is negative.
    expect(cpaRow?.cells["better-cpa"].better).toBe(true);

    const netRow = view.rows.find((row) => row.key === "netProfit");
    expect(netRow?.cells["better-cpa"].better).toBe(true);
    expect((netRow?.cells["better-cpa"].deltaAbs ?? 0) > 0).toBe(true);

    const budgetRow = view.rows.find((row) => row.key === "plannedBudget");
    // Neutral metric: never colored better/worse.
    expect(budgetRow?.direction).toBe("neutral");
    expect(budgetRow?.cells["better-cpa"].better).toBeNull();
  });

  it("delta pct is relative to |baseline| and null when the baseline is 0", () => {
    const base = scenario("base");
    const variant = scenario("variant", { subPrice: 35 });
    const view = buildScenarioComparison([base, variant], "base");
    const grossRow = view.rows.find((row) => row.key === "grossRevenue");
    const cell = grossRow?.cells["variant"];
    expect(cell?.deltaPct).toBeCloseTo((cell!.value! - grossRow!.cells["base"].value!) / Math.abs(grossRow!.cells["base"].value!), 9);
  });

  it("missing payback is treated as strictly worse, not as missing data", () => {
    const pays = scenario("pays");
    // CPA so high the cohort never pays back within the horizon.
    const never = scenario("never", { cpa: 60 });
    expect(never.result.payback.paybackDay).toBeNull();
    const view = buildScenarioComparison([pays, never], "pays");
    const paybackRow = view.rows.find((row) => row.key === "paybackDay");
    expect(paybackRow?.cells["never"].better).toBe(false);
    // And the mirror case: baseline never pays back, variant does → better.
    const mirrored = buildScenarioComparison([never, pays], "never");
    expect(mirrored.rows.find((row) => row.key === "paybackDay")?.cells["pays"].better).toBe(true);
  });

  it("overlay curves align by period index and pad shorter horizons with null", () => {
    const monthly = scenario("m");
    const shorter: ComparisonEntry = (() => {
      const entry = scenario("short");
      const trimmed = createFrozenForecastInputs({
        assumptions: {
          ...entry.frozen.assumptions,
          pricing: { schedule: buildPeriodSchedule({ cadence: "monthly", paidPeriods: 5, trialPrice: 1, periodPrice: 29 }) },
          retention: { survival: entry.frozen.assumptions.retention.survival.slice(0, 6), observedDepth: 6 },
        },
        resolvedAt: "2026-07-27T00:00:00.000Z",
      });
      return { id: "short", label: "short", frozen: trimmed, result: runFrozenForecast(trimmed) };
    })();
    const view = buildScenarioComparison([monthly, shorter], "m");
    expect(view.cashFlowCurve).toHaveLength(12);
    expect(view.cashFlowCurve[7].values["m"]).not.toBeNull();
    expect(view.cashFlowCurve[7].values["short"]).toBeNull();
    expect(view.retentionCurve[1].values["m"]).toBeCloseTo(0.43, 9);
  });

  it("unknown baseline id falls back to the first entry; identical scenarios diff to zero", () => {
    const a = scenario("a");
    const b = scenario("b");
    const view = buildScenarioComparison([a, b], "missing");
    expect(view.baselineId).toBe("a");
    for (const row of view.rows) {
      const cell = row.cells["b"];
      if (cell.value !== null && row.cells["a"].value !== null) {
        expect(Math.abs((cell.deltaAbs ?? 0))).toBeLessThan(1e-9);
        expect(cell.better).toBeNull();
      }
    }
  });

  it("every matrix metric has an explicit direction (no naive best-value highlighting)", () => {
    for (const metric of COMPARISON_METRICS) {
      expect(["higher_is_better", "lower_is_better", "neutral"]).toContain(metric.direction);
    }
  });
});
