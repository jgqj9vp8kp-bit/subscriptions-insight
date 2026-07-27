// FunnelEconomicsEngine — pure, deterministic funnel-level financial projection.
//
// One engine for every workflow (Planning, Simulation, Compare, future consumers):
// FrozenForecastInputs → prepareRuntimeInputs → runFunnelEconomics → ForecastResult.
//
// Formula source of truth: the payback workbook ("Прогноз окупаемости для Дашборда"),
// golden-tested per period against all six scenarios. The calculation chain:
//   trials = budget / cpa;   traffic cash outflow = budget / (1 − trafficCommission)
//   users[0] = trials;       users[t] = survival[t] · users[t−1]
//   period 0 revenue = trials·trialPrice + upsells;  period t = users[t]·price[t]
//   per stream: stripe = rev·stripe%;  refund = rev·refund%;
//               provider = (rev − stripe − refund)·provider%   (workbook order)
//   Payment-Net Revenue = gross − stripe − refund − provider   (workbook "Gross Profit")
//   Contribution Profit = Σ Payment-Net − traffic cash outflow
//   Net Profit = Contribution Profit − performance bonus − allocated overhead − extras
//   Payback = first period where cumulative Payment-Net ≥ traffic cash outflow
//
// The engine never fetches data, reads app state, persists, formats, or embeds
// company policy formulas (bonus/extrapolation/rounding arrive as resolved pure fns).
// Invalid input throws ForecastInputError — never a silent zero. Users are fractional
// (workbook behavior; spec Q9 default). Token fee treatment is provisional (Q12) and
// flagged with a warning whenever token revenue is present.
import {
  ForecastInputError,
  type EngineWarning,
  type FeeApplicability,
  type ForecastAssumptionsResolved,
  type ForecastPeriodRow,
  type ForecastResult,
  type FrozenForecastInputs,
  type OverheadAllocation,
  type RevenueStreamKey,
} from "./funnelEconomicsTypes.ts";
import { prepareRuntimeInputs, type RuntimeForecastInputs } from "./funnelEconomicsStrategies.ts";
import { firstCrossingIndex } from "./financialPrimitives.ts";

// ---- Validation ------------------------------------------------------------------

function assertFinite(path: string, value: number, opts: { min?: number; maxExclusive?: number; max?: number } = {}): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ForecastInputError(path, `expected a finite number, got ${String(value)}`);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new ForecastInputError(path, `must be ≥ ${opts.min}, got ${value}`);
  }
  if (opts.max !== undefined && value > opts.max) {
    throw new ForecastInputError(path, `must be ≤ ${opts.max}, got ${value}`);
  }
  if (opts.maxExclusive !== undefined && value >= opts.maxExclusive) {
    throw new ForecastInputError(path, `must be < ${opts.maxExclusive}, got ${value}`);
  }
}

function validateAssumptions(a: ForecastAssumptionsResolved): void {
  assertFinite("traffic.plannedBudget", a.traffic.plannedBudget, { min: 0 });
  if (a.traffic.plannedBudget <= 0) throw new ForecastInputError("traffic.plannedBudget", "must be > 0");
  assertFinite("traffic.targetCpa", a.traffic.targetCpa, { min: 0 });
  if (a.traffic.targetCpa <= 0) throw new ForecastInputError("traffic.targetCpa", "must be > 0");
  assertFinite("traffic.trafficCommission", a.traffic.trafficCommission, { min: 0, maxExclusive: 1 });

  const periods = a.pricing.schedule.periods;
  if (!Array.isArray(periods) || periods.length === 0) {
    throw new ForecastInputError("pricing.schedule.periods", "schedule must contain at least the trial period");
  }
  if (periods.length > 400) {
    throw new ForecastInputError("pricing.schedule.periods", `horizon of ${periods.length} periods exceeds the 400-period sanity cap`);
  }
  periods.forEach((period, index) => {
    if (period.index !== index) {
      throw new ForecastInputError(`pricing.schedule.periods[${index}].index`, `must equal its position (${index}), got ${period.index}`);
    }
    assertFinite(`pricing.schedule.periods[${index}].price`, period.price, { min: 0 });
    assertFinite(`pricing.schedule.periods[${index}].durationDays`, period.durationDays, { min: 0 });
  });

  const survival = a.retention.survival;
  if (survival.length !== periods.length) {
    throw new ForecastInputError(
      "retention.survival",
      `length ${survival.length} must match the schedule length ${periods.length}`,
    );
  }
  if (survival[0] !== 1) {
    throw new ForecastInputError("retention.survival[0]", `trial-period survival must be exactly 1, got ${survival[0]}`);
  }
  survival.forEach((value, index) => assertFinite(`retention.survival[${index}]`, value, { min: 0, max: 1 }));

  assertFinite("costs.stripeCommission", a.costs.stripeCommission, { min: 0, maxExclusive: 1 });
  assertFinite("costs.refundRate", a.costs.refundRate, { min: 0, maxExclusive: 1 });
  assertFinite("costs.providerCommission", a.costs.providerCommission, { min: 0, maxExclusive: 1 });
  assertFinite("costs.fixed.ffBilling", a.costs.fixed.ffBilling, { min: 0 });
  assertFinite("costs.fixed.funnelConstructor", a.costs.fixed.funnelConstructor, { min: 0 });
  assertFinite("costs.fixed.payroll", a.costs.fixed.payroll, { min: 0 });
  a.costs.extraCosts.forEach((item, index) => assertFinite(`costs.extraCosts[${index}].amount`, item.amount, { min: 0 }));

  a.monetization.upsells.forEach((tier, index) => {
    assertFinite(`monetization.upsells[${index}].takeRate`, tier.takeRate, { min: 0, max: 1 });
    assertFinite(`monetization.upsells[${index}].price`, tier.price, { min: 0 });
  });
  assertFinite("monetization.tokenArpuPerTrial", a.monetization.tokenArpuPerTrial, { min: 0 });
  assertFinite("monetization.tokenArpuHold", a.monetization.tokenArpuHold, { min: 0, max: 1 });

  validateOverheadAllocation(a.costs.overheadAllocation);
}

function validateOverheadAllocation(allocation: OverheadAllocation): void {
  const path = "costs.overheadAllocation";
  switch (allocation.mode) {
    case "exclude":
    case "fixed_amount":
      return;
    case "manual":
      if (allocation.amount === undefined) throw new ForecastInputError(`${path}.amount`, "manual allocation requires an amount");
      assertFinite(`${path}.amount`, allocation.amount, { min: 0 });
      return;
    case "percentage":
      if (allocation.percentage === undefined) throw new ForecastInputError(`${path}.percentage`, "percentage allocation requires a fraction");
      assertFinite(`${path}.percentage`, allocation.percentage, { min: 0, max: 1 });
      return;
    case "by_spend_share":
    case "by_trial_share":
      if (allocation.share === undefined) {
        throw new ForecastInputError(`${path}.share`, `${allocation.mode} requires a pre-resolved share (the pure engine has no portfolio context)`);
      }
      assertFinite(`${path}.share`, allocation.share, { min: 0, max: 1 });
      return;
    default:
      throw new ForecastInputError(`${path}.mode`, `unknown allocation mode: ${String((allocation as { mode: unknown }).mode)}`);
  }
}

function allocatedOverheadAmount(allocation: OverheadAllocation, rawFixedSum: number): number {
  switch (allocation.mode) {
    case "exclude": return 0;
    case "fixed_amount": return allocation.amount ?? rawFixedSum;
    case "manual": return allocation.amount ?? 0;
    case "percentage": return rawFixedSum * (allocation.percentage ?? 0);
    case "by_spend_share":
    case "by_trial_share": return rawFixedSum * (allocation.share ?? 0);
  }
}

// ---- Engine ----------------------------------------------------------------------

const STREAM_KEYS: RevenueStreamKey[] = ["trial", "subscription", "upsell", "token"];

export function runFunnelEconomics(runtime: RuntimeForecastInputs): ForecastResult {
  const { frozen, bonusEvaluator, roundPeriod } = runtime;
  const a = frozen.assumptions;
  validateAssumptions(a);

  const warnings: EngineWarning[] = [];
  const periods = a.pricing.schedule.periods;
  const n = periods.length;
  const survival = a.retention.survival;

  const trials = a.traffic.plannedBudget / a.traffic.targetCpa;
  const trafficCashOutflow = a.traffic.plannedBudget / (1 - a.traffic.trafficCommission);

  const users: number[] = new Array(n);
  users[0] = trials;
  for (let t = 1; t < n; t += 1) users[t] = survival[t] * users[t - 1];

  const upsellByTier = a.monetization.upsells.map((tier) => ({
    key: tier.key,
    revenue: roundPeriod(trials * tier.takeRate * tier.price),
  }));
  const upsellTotalAtTrial = upsellByTier.reduce((sum, tier) => sum + tier.revenue, 0);

  const tokenArpu = a.monetization.tokenArpuPerTrial;
  const tokenHold = a.monetization.tokenArpuHold;
  if (tokenArpu > 0) {
    warnings.push({
      code: "token_fee_treatment_unresolved",
      message: "Token revenue fee/refund treatment is a pending business decision (Q12); the provisional default mirrors the subscription stream.",
    });
  }

  const applicability = a.costs.feeApplicability;
  const feeFor = (stream: RevenueStreamKey): FeeApplicability => applicability[stream];

  const rows: ForecastPeriodRow[] = [];
  const grossByPeriod: number[] = new Array(n);
  const cashFlowBalanceByPeriod: number[] = new Array(n);
  let dayCursor = 0;
  let cumulativePaymentNet = 0;
  let stripeTotal = 0;
  let refundTotal = 0;
  let providerTotal = 0;
  let trialRevenueTotal = 0;
  let subscriptionRevenueTotal = 0;
  let tokenRevenueTotal = 0;
  for (let t = 0; t < n; t += 1) {
    const period = periods[t];
    const bills = period.billingEvent === "on_period_start";
    const streamRevenue: Record<RevenueStreamKey, number> = {
      trial: t === 0 && bills ? roundPeriod(trials * period.price) : 0,
      subscription: t > 0 && bills ? roundPeriod(users[t] * period.price) : 0,
      upsell: t === 0 ? upsellTotalAtTrial : 0,
      token: tokenArpu > 0 ? roundPeriod(trials * tokenArpu * Math.pow(tokenHold, t)) : 0,
    };

    let periodStripe = 0;
    let periodRefund = 0;
    let periodProvider = 0;
    let periodGross = 0;
    for (const stream of STREAM_KEYS) {
      const revenue = streamRevenue[stream];
      if (revenue === 0) continue;
      const fees = feeFor(stream);
      const stripe = roundPeriod(fees.stripe ? revenue * a.costs.stripeCommission : 0);
      const refund = roundPeriod(fees.refund ? revenue * a.costs.refundRate : 0);
      // Workbook order: the provider commission applies to the intermediate
      // (post-Stripe, post-refund) revenue, not to gross.
      const provider = roundPeriod(fees.provider ? (revenue - stripe - refund) * a.costs.providerCommission : 0);
      periodGross += revenue;
      periodStripe += stripe;
      periodRefund += refund;
      periodProvider += provider;
    }

    const paymentTotal = periodStripe + periodRefund + periodProvider;
    const paymentNet = periodGross - paymentTotal;
    cumulativePaymentNet += paymentNet;
    const cashFlowBalance = cumulativePaymentNet - trafficCashOutflow;

    trialRevenueTotal += streamRevenue.trial;
    subscriptionRevenueTotal += streamRevenue.subscription;
    tokenRevenueTotal += streamRevenue.token;
    stripeTotal += periodStripe;
    refundTotal += periodRefund;
    providerTotal += periodProvider;
    grossByPeriod[t] = periodGross;
    cashFlowBalanceByPeriod[t] = cashFlowBalance;

    const dayStart = dayCursor;
    dayCursor += period.durationDays;

    rows.push({
      index: t,
      label: period.label,
      dayStart,
      dayEnd: dayCursor,
      users: users[t],
      survival: survival[t],
      cumulativeRetention: trials > 0 ? users[t] / trials : 0,
      revenue: {
        trial: streamRevenue.trial,
        subscription: streamRevenue.subscription,
        upsell: streamRevenue.upsell,
        token: streamRevenue.token,
        gross: periodGross,
      },
      costs: { stripe: periodStripe, refund: periodRefund, provider: periodProvider, paymentTotal },
      paymentNetRevenue: paymentNet,
      cumulativePaymentNetRevenue: cumulativePaymentNet,
      cashFlowBalance,
    });
  }

  const grossTotal = grossByPeriod.reduce((sum, value) => sum + value, 0);
  const paymentCostsTotal = stripeTotal + refundTotal + providerTotal;
  const paymentNetRevenueTotal = cumulativePaymentNet;
  const contributionProfit = paymentNetRevenueTotal - trafficCashOutflow;

  // Payback = first period whose cumulative payment-net reaches the traffic cash
  // outflow (shared crossing primitive; the cumulative series is non-decreasing).
  const paybackPeriodIndex = firstCrossingIndex(
    rows.map((row) => row.cumulativePaymentNetRevenue),
    trafficCashOutflow,
  );
  const paybackDay = paybackPeriodIndex === null ? null : rows[paybackPeriodIndex].dayEnd;

  const performanceBonus = bonusEvaluator({
    plannedBudget: a.traffic.plannedBudget,
    trafficCashOutflow,
    targetCpa: a.traffic.targetCpa,
    firstPaidConversion: n > 1 ? survival[1] : 0,
  });

  const overheadRaw = a.costs.fixed;
  const rawFixedSum = overheadRaw.ffBilling + overheadRaw.funnelConstructor + overheadRaw.payroll;
  const allocatedOverhead = allocatedOverheadAmount(a.costs.overheadAllocation, rawFixedSum);
  const extraTotal = a.costs.extraCosts.reduce((sum, item) => sum + item.amount, 0);

  const netProfit = contributionProfit - performanceBonus - allocatedOverhead - extraTotal;
  const totalInvestment = trafficCashOutflow + performanceBonus + allocatedOverhead + extraTotal;

  return {
    timeline: { periods: rows },
    revenue: {
      trialTotal: trialRevenueTotal,
      subscriptionTotal: subscriptionRevenueTotal,
      upsellByTier,
      upsellTotal: upsellTotalAtTrial,
      tokenTotal: tokenRevenueTotal,
      grossByPeriod,
      grossTotal,
    },
    costs: {
      stripeTotal,
      refundTotal,
      providerTotal,
      paymentCostsTotal,
      trafficCashOutflow,
      performanceBonus,
      overheadRaw: { ...overheadRaw },
      allocatedOverhead,
      extraTotal,
    },
    profitability: {
      paymentNetRevenueTotal,
      contributionProfit,
      netProfit,
    },
    payback: {
      paybackPeriodIndex,
      paybackDay,
      noPaybackWithinHorizon: paybackPeriodIndex === null,
      cashFlowBalanceByPeriod,
      finalCashFlowBalance: cashFlowBalanceByPeriod[n - 1] ?? -trafficCashOutflow,
    },
    metrics: {
      trials,
      grossLtv: grossTotal / trials,
      contributionLtv: paymentNetRevenueTotal / trials,
      fullyLoadedLtv: (paymentNetRevenueTotal - performanceBonus - allocatedOverhead) / trials,
      roas: grossTotal / trafficCashOutflow,
      romi: contributionProfit / trafficCashOutflow,
      roi: totalInvestment > 0 ? netProfit / totalInvestment : 0,
      contributionMargin: grossTotal > 0 ? contributionProfit / grossTotal : null,
      cpa: a.traffic.targetCpa,
      cac: trafficCashOutflow / trials,
    },
    provenance: { ...frozen.provenance },
    warnings,
  };
}

/** Convenience: resolve descriptors and run in one call (typical consumer entry). */
export function runFrozenForecast(frozen: FrozenForecastInputs): ForecastResult {
  return runFunnelEconomics(prepareRuntimeInputs(frozen));
}
