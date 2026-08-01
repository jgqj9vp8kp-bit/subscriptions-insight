// Project-level aggregation over per-funnel ForecastResults (P1, rev. 3 spec).
//
// Composes N engine results + spend-only cost rows + the scoped spend ledger into
// one ProjectTotals. It NEVER re-implements engine math — it sums engine outputs,
// recomputes ratios from those sums, and derives payback from the stacked day
// grid. The three disciplines that make a portfolio totals row honest:
//
//   - additive quantities are summed over enabled rows of BOTH kinds;
//   - ratios are recomputed from totals, never averaged (blended CPA is
//     Σspend/Σtrials, not mean(cpa_i)) — and fully-loaded LTV is RECOMPUTED
//     because the engine's metrics.fullyLoadedLtv omits extraTotal while
//     netProfit includes it (verified engine asymmetry; summing it would
//     silently understate cost the moment extras are non-empty);
//   - identities are ASSERTED and violations surface as gates that force "—",
//     never a plausible wrong number: Σ allocatedOverhead === prorated pool,
//     window spend reconciliation, unresolved commissions, non-monotone series.
//
// No user-id dedup happens here, unlike the Cohorts totals row: these are
// projected quantities from independent single-cohort models — no shared users.
import type { ExtraCostItem, ForecastResult } from "./funnelEconomicsTypes.ts";
import type {
  BonusIneligibilityReason,
  FunnelSpendLedger,
  ProjectAggregationPolicy,
  ProjectEntryKind,
  ProjectSpendScope,
  ProvisionalFlags,
  SpendIdentityCheck,
} from "./funnelEconomicsProject.ts";
import {
  type DayGridSeries,
  type StackedDayGrid,
  stackDayGrid,
  stackedCrossingDay,
} from "./funnelEconomicsDayGrid.ts";

export const OVERHEAD_IDENTITY_TOLERANCE = 0.01;

/** Uniform per-row economics so forecast and spend-only rows aggregate identically. */
export interface ProjectRowEconomics {
  funnelId: string;
  kind: ProjectEntryKind;
  trials: number;
  /** null only on spend_only rows whose group commissions are unresolved. */
  trafficCashOutflow: number | null;
  grossRevenue: number;
  paymentNetRevenue: number;
  contributionProfit: number;
  performanceBonus: number;
  bonusIneligibleReason: BonusIneligibilityReason | null;
  allocatedOverhead: number;
  extraTotal: number;
  netProfit: number;
  overheadShare: number;
  /** From the engine for forecast rows (traffic-only semantics); null for spend_only. */
  paybackDay: number | null;
}

/** Wrap one engine result as a project row. The overhead was computed by the
 * engine as pool × share (both baked into the frozen inputs by the resolver);
 * `expectedOverhead` lets the aggregator verify nothing drifted between the
 * resolve and the run. */
export function buildForecastRowEconomics(input: {
  funnelId: string;
  result: ForecastResult;
  overheadShare: number;
}): ProjectRowEconomics {
  const { result } = input;
  return {
    funnelId: input.funnelId,
    kind: "forecast",
    trials: result.metrics.trials,
    trafficCashOutflow: result.costs.trafficCashOutflow,
    grossRevenue: result.revenue.grossTotal,
    paymentNetRevenue: result.profitability.paymentNetRevenueTotal,
    contributionProfit: result.profitability.contributionProfit,
    performanceBonus: result.costs.performanceBonus,
    bonusIneligibleReason: null,
    allocatedOverhead: result.costs.allocatedOverhead,
    extraTotal: result.costs.extraTotal,
    netProfit: result.profitability.netProfit,
    overheadShare: input.overheadShare,
    paybackDay: result.payback.paybackDay,
  };
}

/** Spend-only row economics (rev. 3 corrections 2–3). The engine is never invoked:
 * there is no scenario to run. The row is pure cost —
 *   trafficCashOutflow  = resolved spend grossed up via its OWN ledger groups
 *   contributionProfit  = −trafficCashOutflow
 *   performanceBonus    = 0 with an explicit ineligibility reason (a CPA/conversion
 *                         bonus formula is never evaluated: denominators are missing)
 *   allocatedOverhead   = pool × share (the project layer's own multiplication)
 *   netProfit           = contribution − overhead − own extras
 * A null outflow (unresolved commission) propagates: the row still counts spend,
 * but every outflow-derived total goes null and gates fire. */
export function buildSpendOnlyRowEconomics(input: {
  funnelId: string;
  ledger: Pick<FunnelSpendLedger, "trafficCashOutflow">;
  overheadShare: number;
  proratedPool: number;
  ownExtras: ReadonlyArray<ExtraCostItem>;
  bonusPolicyKind: ProjectAggregationPolicy["bonus"]["kind"];
}): ProjectRowEconomics {
  const outflow = input.ledger.trafficCashOutflow;
  const allocatedOverhead = input.proratedPool * input.overheadShare;
  const extraTotal = input.ownExtras.reduce((sum, item) => sum + item.amount, 0);
  const contribution = outflow === null ? Number.NaN : -outflow;
  return {
    funnelId: input.funnelId,
    kind: "spend_only",
    trials: 0,
    trafficCashOutflow: outflow,
    grossRevenue: 0,
    paymentNetRevenue: 0,
    contributionProfit: outflow === null ? 0 : contribution,
    performanceBonus: 0,
    bonusIneligibleReason: input.bonusPolicyKind === "disabled" ? "policy_disabled" : "ineligible_no_conversions",
    allocatedOverhead,
    extraTotal,
    netProfit: outflow === null ? -allocatedOverhead - extraTotal : contribution - allocatedOverhead - extraTotal,
    overheadShare: input.overheadShare,
    paybackDay: null,
  };
}

export interface ProjectGate {
  code:
    | "overhead_identity"
    | "window_reconciliation"
    | "unresolved_commission"
    | "non_monotone_cumulative"
    | "spend_incomplete"
    | "attributed_only"
    | "assumed_cadence";
  message: string;
}

export interface ProjectTotals {
  funnelsIncluded: number;
  spendOnlyIncluded: number;
  trials: number;

  windowSourceSpend: number;
  projectScopedSpend: number;
  outOfProjectSpend: number;
  spendCoverage: number;

  /** Σ row outflows + included-unresolved outflow; null when any part is unresolved. */
  trafficCashOutflow: number | null;

  grossRevenue: number;
  paymentNetRevenue: number;
  contributionProfit: number;
  performanceBonus: number;
  allocatedOverhead: number;
  extraTotal: number;
  netProfit: number;

  blendedCpa: number | null;
  blendedCac: number | null;
  grossLtv: number | null;
  contributionLtv: number | null;
  /** Recomputed: (ΣPN − ΣB − ΣO − ΣE) / Σn — never Σ metrics.fullyLoadedLtv. */
  fullyLoadedLtv: number | null;
  roas: number | null;
  romi: number | null;
  roi: number | null;
  contributionMargin: number | null;
  effectiveRefundRate: number | null;

  paybackTrafficOnlyDay: number | null;
  paybackFullyLoadedDay: number | null;
  /** The policy-selected headline value. */
  headlinePaybackDay: number | null;
  paybackSuppressed: boolean;

  grid: StackedDayGrid;
  overheadIdentityOk: boolean;
  gates: ProjectGate[];
}

export function aggregateProject(input: {
  rows: ReadonlyArray<ProjectRowEconomics>;
  /** Boundary series of the enabled FORECAST rows (spend-only rows contribute a
   * flat zero cumulative by construction — they are represented only in the
   * thresholds, so they need no series). */
  series: ReadonlyArray<DayGridSeries>;
  scope: ProjectSpendScope;
  proratedPool: number;
  policy: Pick<ProjectAggregationPolicy, "headlinePayback">;
  provisional: ProvisionalFlags;
  windowIdentity: SpendIdentityCheck;
  /** Σ refund costs over forecast results (for the effective refund rate). */
  refundCostTotal: number;
}): ProjectTotals {
  const rows = input.rows;
  const gates: ProjectGate[] = [];

  const sum = (pick: (row: ProjectRowEconomics) => number) =>
    rows.reduce((total, row) => total + pick(row), 0);

  const trials = sum((row) => row.trials);
  const grossRevenue = sum((row) => row.grossRevenue);
  const paymentNetRevenue = sum((row) => row.paymentNetRevenue);
  const contributionProfit = sum((row) => row.contributionProfit);
  const performanceBonus = sum((row) => row.performanceBonus);
  const allocatedOverhead = sum((row) => row.allocatedOverhead);
  const extraTotal = sum((row) => row.extraTotal);
  const netProfit = sum((row) => row.netProfit);

  // Traffic outflow with null propagation: one unresolved commission anywhere
  // (a spend-only row's groups or an included unresolved bucket) makes the
  // project outflow — and everything derived from it — unavailable, never guessed.
  let trafficCashOutflow: number | null = 0;
  for (const row of rows) {
    if (row.trafficCashOutflow === null) { trafficCashOutflow = null; break; }
    trafficCashOutflow += row.trafficCashOutflow;
  }
  if (trafficCashOutflow !== null) {
    if (input.scope.includedUnresolvedOutflow === null && input.scope.includedUnresolvedSpend > 0) {
      trafficCashOutflow = null;
    } else {
      trafficCashOutflow += input.scope.includedUnresolvedOutflow ?? 0;
    }
  }

  const overheadDelta = Math.abs(allocatedOverhead - input.proratedPool);
  const overheadIdentityOk = rows.length === 0 || overheadDelta < OVERHEAD_IDENTITY_TOLERANCE;
  if (!overheadIdentityOk) {
    gates.push({
      code: "overhead_identity",
      message: `Σ allocated overhead differs from the prorated pool by ${overheadDelta.toFixed(2)} — allocation is broken; overhead-dependent metrics are unavailable.`,
    });
  }
  if (!input.windowIdentity.ok) {
    gates.push({
      code: "window_reconciliation",
      message: `Window spend does not reconcile (source Δ ${input.windowIdentity.sourceDelta.toFixed(2)}, resolved Δ ${input.windowIdentity.resolvedDelta.toFixed(2)}).`,
    });
  }
  if (input.provisional.unresolvedCommission || trafficCashOutflow === null) {
    gates.push({
      code: "unresolved_commission",
      message: `Spend groups worth ${input.scope.unresolvedCommissionSpend.toFixed(2)} need a traffic commission — outflow-derived metrics are unavailable until assigned.`,
    });
  }
  if (input.provisional.spendIncomplete) {
    gates.push({ code: "spend_incomplete", message: "The window overlaps known warehouse gaps — spend-derived metrics are provisional; missing spend is never counted as zero." });
  }
  if (input.provisional.attributedOnlyMode) {
    gates.push({ code: "attributed_only", message: "Attributed-only spend basis: costs cover only spend attributed through converting campaigns. Not complete project profitability." });
  }
  if (input.provisional.unconfirmedCadenceBudgetShare > 0) {
    gates.push({
      code: "assumed_cadence",
      message: `${Math.round(input.provisional.unconfirmedCadenceBudgetShare * 100)}% of budget runs on an assumed cadence.`,
    });
  }

  const grid = stackDayGrid(input.series);
  if (grid.nonMonotoneSeries.length > 0) {
    gates.push({
      code: "non_monotone_cumulative",
      message: `Cumulative payment-net decreases for: ${grid.nonMonotoneSeries.join(", ")} — payback semantics are meaningless (check stripe+refund rates).`,
    });
  }

  // Ratio discipline: recompute from totals; null when the denominator is
  // unavailable or zero — never a plausible number from a broken identity.
  const outflowUsable = trafficCashOutflow !== null && overheadIdentityOk;
  const blendedCpa = trials > 0 ? input.scope.projectScopedSpend / trials : null;
  const blendedCac = outflowUsable && trials > 0 ? (trafficCashOutflow as number) / trials : null;
  const grossLtv = trials > 0 ? grossRevenue / trials : null;
  const contributionLtv = trials > 0 ? paymentNetRevenue / trials : null;
  const fullyLoadedLtv = overheadIdentityOk && trials > 0
    ? (paymentNetRevenue - performanceBonus - allocatedOverhead - extraTotal) / trials
    : null;
  const roas = outflowUsable && (trafficCashOutflow as number) > 0 ? grossRevenue / (trafficCashOutflow as number) : null;
  const romi = outflowUsable && (trafficCashOutflow as number) > 0 ? contributionProfit / (trafficCashOutflow as number) : null;
  const totalInvestment = outflowUsable
    ? (trafficCashOutflow as number) + performanceBonus + allocatedOverhead + extraTotal
    : null;
  const roi = totalInvestment !== null && totalInvestment > 0 ? netProfit / totalInvestment : null;
  const contributionMargin = grossRevenue > 0 ? contributionProfit / grossRevenue : null;
  const effectiveRefundRate = grossRevenue > 0 ? input.refundCostTotal / grossRevenue : null;

  const paybackSuppressed = grid.nonMonotoneSeries.length > 0 || !outflowUsable;
  const paybackTrafficOnlyDay = paybackSuppressed
    ? null
    : stackedCrossingDay(grid, trafficCashOutflow);
  const paybackFullyLoadedDay = paybackSuppressed
    ? null
    : stackedCrossingDay(
        grid,
        (trafficCashOutflow as number) + performanceBonus + allocatedOverhead + extraTotal,
      );

  return {
    funnelsIncluded: rows.filter((row) => row.kind === "forecast").length,
    spendOnlyIncluded: rows.filter((row) => row.kind === "spend_only").length,
    trials,
    windowSourceSpend: input.scope.windowSourceSpend,
    projectScopedSpend: input.scope.projectScopedSpend,
    outOfProjectSpend: input.scope.outOfProjectSpend,
    spendCoverage: input.scope.spendCoverage,
    trafficCashOutflow,
    grossRevenue,
    paymentNetRevenue,
    contributionProfit,
    performanceBonus,
    allocatedOverhead,
    extraTotal,
    netProfit,
    blendedCpa,
    blendedCac,
    grossLtv,
    contributionLtv,
    fullyLoadedLtv,
    roas,
    romi,
    roi,
    contributionMargin,
    effectiveRefundRate,
    paybackTrafficOnlyDay,
    paybackFullyLoadedDay,
    headlinePaybackDay: input.policy.headlinePayback === "fully_loaded" ? paybackFullyLoadedDay : paybackTrafficOnlyDay,
    paybackSuppressed,
    grid,
    overheadIdentityOk,
    gates,
  };
}
