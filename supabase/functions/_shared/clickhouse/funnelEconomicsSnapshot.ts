// Dashboard "Forecast Snapshot" — a tiny pure consumer of the FunnelEconomics
// engine (v3 spec §2 consumer list, phase P7). Seeds assumptions from the visible
// cohort rows exactly like Plan mode and reads horizon values off one engine run.
//
// Per-trial LTVs are budget-invariant (users scale linearly with trials), and ROAS
// depends only on CPA and rates, so the snapshot seeds a nominal budget and never
// invents a CPA: without attributed spend it reports unavailable + the reason.
import { buildForecastAssumptions } from "./funnelEconomicsAssumptions.ts";
import { deriveFunnelActualsFromCohortRows, type CohortRowLike } from "./funnelEconomicsActuals.ts";
import { createFrozenForecastInputs } from "./funnelEconomicsStrategies.ts";
import { runFrozenForecast } from "./funnelEconomicsEngine.ts";
import { ForecastInputError, type DataWarning } from "./funnelEconomicsTypes.ts";

export interface ForecastSnapshot {
  available: boolean;
  /** Why the snapshot is unavailable (e.g. no CPA — spend not attributed). */
  reason: string | null;
  /** Contribution LTV (cumulative payment-net per trial) at period 3 / 6 / horizon end. */
  ltvP3: number | null;
  ltvP6: number | null;
  ltvP12: number | null;
  /** Cumulative gross revenue through period 6 / traffic cash outflow. */
  roasP6: number | null;
  trials: number;
  warnings: DataWarning[];
}

const UNAVAILABLE: Omit<ForecastSnapshot, "reason" | "warnings" | "trials"> = {
  available: false,
  ltvP3: null,
  ltvP6: null,
  ltvP12: null,
  roasP6: null,
};

/** A nominal budget only scales the cohort; per-trial and ratio outputs are invariant. */
const NOMINAL_BUDGET = 100_000;

export function buildForecastSnapshotFromCohortRows(input: {
  rows: CohortRowLike[];
  asOf: string;
  funnelId?: string;
}): ForecastSnapshot {
  const seed = deriveFunnelActualsFromCohortRows({
    funnelId: input.funnelId ?? "(dashboard blend)",
    rows: input.rows,
    asOf: input.asOf,
    periodDays: 30,
  });
  if (!seed.actuals) {
    return { ...UNAVAILABLE, reason: "No cohort data in the selected range.", trials: 0, warnings: seed.warnings };
  }
  try {
    const built = buildForecastAssumptions({
      cadence: "monthly",
      plannedBudget: NOMINAL_BUDGET,
      actuals: seed.actuals,
    });
    const result = runFrozenForecast(createFrozenForecastInputs({
      assumptions: built.assumptions,
      provenance: built.provenance,
      resolvedAt: input.asOf,
    }));
    const periods = result.timeline.periods;
    const trials = result.metrics.trials;
    const ltvAt = (index: number): number | null => {
      const row = periods[Math.min(index, periods.length - 1)];
      return row ? row.cumulativePaymentNetRevenue / trials : null;
    };
    const grossThrough = (index: number): number => periods
      .slice(0, Math.min(index, periods.length - 1) + 1)
      .reduce((sum, row) => sum + row.revenue.gross, 0);
    return {
      available: true,
      reason: null,
      ltvP3: ltvAt(3),
      ltvP6: ltvAt(6),
      ltvP12: ltvAt(periods.length - 1),
      roasP6: grossThrough(6) / result.costs.trafficCashOutflow,
      trials: seed.actuals.trials,
      warnings: [...seed.warnings, ...built.warnings],
    };
  } catch (error) {
    if (error instanceof ForecastInputError) {
      return { ...UNAVAILABLE, reason: error.message, trials: seed.actuals.trials, warnings: seed.warnings };
    }
    throw error;
  }
}
