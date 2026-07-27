// Scenario comparison for the FunnelEconomics module (v3 spec §12/§21).
//
// Simulation IS comparison: a what-if is a cloned scenario diffed against its
// baseline through the same engine. This module is pure — it takes already-run
// (frozen, result) pairs and produces the matrix + deltas + overlay series.
// Direction metadata drives coloring; "best value" highlighting is never naive.
import type {
  ForecastResult,
  FrozenForecastInputs,
  MetricDirection,
} from "./funnelEconomicsTypes.ts";

export interface ComparisonEntry {
  id: string;
  label: string;
  frozen: FrozenForecastInputs;
  result: ForecastResult;
}

export type ComparisonFormat = "currency" | "percent" | "number" | "days" | "ratio";

export interface ComparisonMetricSpec {
  key: string;
  label: string;
  direction: MetricDirection;
  format: ComparisonFormat;
  /** Extract the value for one scenario; null = not available (renders as —). */
  extract: (entry: ComparisonEntry) => number | null;
}

function retentionPoint(entry: ComparisonEntry, periodIndex: number): number | null {
  const row = entry.result.timeline.periods[periodIndex];
  return row ? row.cumulativeRetention : null;
}

/** The v1 comparison matrix (spec §21 minimum set, in presentation order). */
export const COMPARISON_METRICS: ComparisonMetricSpec[] = [
  { key: "plannedBudget", label: "Planned budget", direction: "neutral", format: "currency", extract: (entry) => entry.frozen.assumptions.traffic.plannedBudget },
  { key: "targetCpa", label: "Target CPA", direction: "lower_is_better", format: "currency", extract: (entry) => entry.frozen.assumptions.traffic.targetCpa },
  { key: "trials", label: "Trials", direction: "neutral", format: "number", extract: (entry) => entry.result.metrics.trials },
  { key: "firstPaidConversion", label: "Trial → first-paid", direction: "higher_is_better", format: "percent", extract: (entry) => entry.frozen.assumptions.retention.survival[1] ?? null },
  { key: "grossRevenue", label: "Gross revenue", direction: "higher_is_better", format: "currency", extract: (entry) => entry.result.revenue.grossTotal },
  { key: "paymentNetRevenue", label: "Payment-net revenue", direction: "higher_is_better", format: "currency", extract: (entry) => entry.result.profitability.paymentNetRevenueTotal },
  { key: "contributionProfit", label: "Contribution profit", direction: "higher_is_better", format: "currency", extract: (entry) => entry.result.profitability.contributionProfit },
  { key: "netProfit", label: "Net profit", direction: "higher_is_better", format: "currency", extract: (entry) => entry.result.profitability.netProfit },
  { key: "grossLtv", label: "Gross LTV", direction: "higher_is_better", format: "currency", extract: (entry) => entry.result.metrics.grossLtv },
  { key: "contributionLtv", label: "Contribution LTV", direction: "higher_is_better", format: "currency", extract: (entry) => entry.result.metrics.contributionLtv },
  { key: "cac", label: "CAC", direction: "lower_is_better", format: "currency", extract: (entry) => entry.result.metrics.cac },
  { key: "paybackDay", label: "Payback day", direction: "lower_is_better", format: "days", extract: (entry) => entry.result.payback.paybackDay },
  { key: "roas", label: "ROAS", direction: "higher_is_better", format: "ratio", extract: (entry) => entry.result.metrics.roas },
  { key: "romi", label: "ROMI", direction: "higher_is_better", format: "ratio", extract: (entry) => entry.result.metrics.romi },
  { key: "roi", label: "ROI", direction: "higher_is_better", format: "ratio", extract: (entry) => entry.result.metrics.roi },
  { key: "contributionMargin", label: "Contribution margin", direction: "higher_is_better", format: "percent", extract: (entry) => entry.result.metrics.contributionMargin },
  { key: "refundRate", label: "Refund rate", direction: "lower_is_better", format: "percent", extract: (entry) => entry.frozen.assumptions.costs.refundRate },
  { key: "retentionP1", label: "Retention @P1", direction: "higher_is_better", format: "percent", extract: (entry) => retentionPoint(entry, 1) },
  { key: "retentionP3", label: "Retention @P3", direction: "higher_is_better", format: "percent", extract: (entry) => retentionPoint(entry, 3) },
  { key: "retentionP6", label: "Retention @P6", direction: "higher_is_better", format: "percent", extract: (entry) => retentionPoint(entry, 6) },
];

export interface ComparisonCell {
  value: number | null;
  deltaAbs: number | null;
  deltaPct: number | null;
  /** Better/worse than baseline in this metric's direction (null for baseline, neutral or N/A). */
  better: boolean | null;
}

export interface ComparisonRow {
  key: string;
  label: string;
  direction: MetricDirection;
  format: ComparisonFormat;
  cells: Record<string, ComparisonCell>;
}

export interface ComparisonCurvePoint {
  periodIndex: number;
  label: string;
  /** Cumulative payment-net revenue per scenario id (null once past that scenario's horizon). */
  values: Record<string, number | null>;
}

export interface ScenarioComparisonView {
  baselineId: string;
  entryIds: string[];
  rows: ComparisonRow[];
  cashFlowCurve: ComparisonCurvePoint[];
  retentionCurve: ComparisonCurvePoint[];
}

function deltaFor(value: number | null, baseline: number | null, direction: MetricDirection, isBaseline: boolean): ComparisonCell {
  if (isBaseline || value === null || baseline === null) {
    return { value, deltaAbs: null, deltaPct: null, better: null };
  }
  const deltaAbs = value - baseline;
  const deltaPct = baseline !== 0 ? deltaAbs / Math.abs(baseline) : null;
  let better: boolean | null = null;
  if (direction === "higher_is_better") better = deltaAbs > 0 ? true : deltaAbs < 0 ? false : null;
  if (direction === "lower_is_better") better = deltaAbs < 0 ? true : deltaAbs > 0 ? false : null;
  return { value, deltaAbs, deltaPct, better };
}

/** Payback is "lower is better", but a MISSING payback (never within horizon) is
 * strictly worse than any day — encode that explicitly instead of treating null
 * as not-available. */
function paybackAwareCell(key: string, value: number | null, baseline: number | null, direction: MetricDirection, isBaseline: boolean): ComparisonCell {
  if (key === "paybackDay" && !isBaseline && (value === null) !== (baseline === null)) {
    return { value, deltaAbs: null, deltaPct: null, better: value !== null };
  }
  return deltaFor(value, baseline, direction, isBaseline);
}

export function buildScenarioComparison(entries: ComparisonEntry[], baselineId: string): ScenarioComparisonView {
  if (entries.length === 0) {
    return { baselineId, entryIds: [], rows: [], cashFlowCurve: [], retentionCurve: [] };
  }
  const baseline = entries.find((entry) => entry.id === baselineId) ?? entries[0];

  const rows: ComparisonRow[] = COMPARISON_METRICS.map((metric) => {
    const baselineValue = metric.extract(baseline);
    const cells: Record<string, ComparisonCell> = {};
    for (const entry of entries) {
      cells[entry.id] = paybackAwareCell(metric.key, metric.extract(entry), baselineValue, metric.direction, entry.id === baseline.id);
    }
    return { key: metric.key, label: metric.label, direction: metric.direction, format: metric.format, cells };
  });

  const horizon = Math.max(...entries.map((entry) => entry.result.timeline.periods.length));
  const curve = (pick: (entry: ComparisonEntry, index: number) => number | null): ComparisonCurvePoint[] =>
    Array.from({ length: horizon }, (_, index) => {
      const labelSource = entries.find((entry) => entry.result.timeline.periods[index]);
      const values: Record<string, number | null> = {};
      for (const entry of entries) values[entry.id] = pick(entry, index);
      return {
        periodIndex: index,
        label: labelSource?.result.timeline.periods[index]?.label ?? `P${index}`,
        values,
      };
    });

  return {
    baselineId: baseline.id,
    entryIds: entries.map((entry) => entry.id),
    rows,
    cashFlowCurve: curve((entry, index) => entry.result.timeline.periods[index]?.cumulativePaymentNetRevenue ?? null),
    retentionCurve: curve((entry, index) => entry.result.timeline.periods[index]?.cumulativeRetention ?? null),
  };
}
