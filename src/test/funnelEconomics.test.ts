// Golden workbook-parity + contract tests for the FunnelEconomicsEngine (v3 spec §25).
//
// The six fixtures are the six scenario blocks of "Прогноз окупаемости для Дашборда.xlsx"
// (sheets "Расчеты" ×3 monthly, "Недельные подписки (копия)" ×3 weekly). Expected values
// are the workbook's own cached results (exporter keeps 10 significant digits — the
// comparison tolerance accounts for that). Note: the weekly sheet's B-column Stripe/refund
// TOTALS contain a workbook bug (SUM stops at column O), but its profit chain uses the
// full per-period range — golden totals below come from the correct chain.
import { describe, expect, it } from "vitest";
import {
  ForecastInputError,
  buildPeriodSchedule,
  createFrozenForecastInputs,
  defaultFeeApplicability,
  prepareRuntimeInputs,
  resolveBonusEvaluator,
  resolvePeriodRounder,
  resolveSurvivalExtrapolator,
  runFrozenForecast,
  workbookBonusPolicy,
  FORECAST_SCHEMA_VERSION,
  type Cadence,
  type ForecastAssumptionsResolved,
  type FrozenForecastInputs,
} from "@/services/funnelEconomics";

const STRIPE = 0.07;
const PROVIDER = 0.059;
const FB_COMMISSION = 0.04;
const CONSTRUCTOR = 2271.36;
const PAYROLL = 9000;
const RESOLVED_AT = "2026-07-27T00:00:00.000Z";

interface GoldenBlock {
  name: string;
  cadence: Cadence;
  trialPrice: number;
  subPrice: number;
  cpa: number;
  budget: number;
  refundRate: number;
  ffBilling: number;
  survival: number[];
  upsells: Array<[takeRate: number, price: number]>;
  expected: {
    trials: number;
    trafficCost: number;
    bonus: number;
    fixedTotal: number;
    users: number[];
    gross: number[];
    grossTotal: number;
    paymentNetTotal: number;
    netProfit: number;
  };
}

const GOLDEN: GoldenBlock[] = [
  {
    name: "m1 soulmate-1-sp (monthly, now)",
    cadence: "monthly", trialPrice: 1, subPrice: 29, cpa: 13, budget: 50_000, refundRate: 0.12, ffBilling: 5000,
    survival: [1, 0.43, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.6, 0.45],
    upsells: [[0.166, 14.98], [0, 9.99], [0, 9]],
    expected: {
      trials: 3846.153846, trafficCost: 52083.33333, bonus: 3453.488372, fixedTotal: 19724.84837,
      users: [3846.153846, 1653.846154, 826.9230769, 413.4615385, 206.7307692, 103.3653846, 51.68269231, 25.84134615, 12.92067308, 6.460336538, 3.876201923, 1.744290865],
      gross: [13410.30769, 47961.53846, 23980.76923, 11990.38462, 5995.192308, 2997.596154, 1498.798077, 749.3990385, 374.6995192, 187.3497596, 112.4098558, 50.5844351],
      grossTotal: 109309.0291, paymentNetTotal: 83316.43511, netProfit: 11508.2534,
    },
  },
  {
    name: "m2 soulmate-sketch (monthly, now)",
    cadence: "monthly", trialPrice: 1, subPrice: 29.99, cpa: 15, budget: 50_000, refundRate: 0.09, ffBilling: 5000,
    survival: [1, 0.3, 0.4, 0.4, 0.4, 0.4, 0.45, 0.45, 0.45, 0.45, 0.45, 0.45],
    upsells: [[0.12, 14.98], [0.027, 9.99], [0.047, 9]],
    expected: {
      trials: 3333.333333, trafficCost: 52083.33333, bonus: 0, fixedTotal: 16271.36,
      users: [3333.333333, 1000, 400, 160, 64, 25.6, 11.52, 5.184, 2.3328, 1.04976, 0.472392, 0.2125764],
      gross: [11634.43333, 29990, 11996, 4798.4, 1919.36, 767.744, 345.4848, 155.46816, 69.960672, 31.4823024, 14.16703608, 6.375166236],
      grossTotal: 61728.87547, paymentNetTotal: 48792.97233, netProfit: -19561.72101,
    },
  },
  {
    name: "m3 soulmate-sketch (monthly, target)",
    cadence: "monthly", trialPrice: 1, subPrice: 35, cpa: 18, budget: 250_000, refundRate: 0.1, ffBilling: 15_000,
    survival: [1, 0.39, 0.52, 0.7, 0.7, 0.7, 0.7, 0.5, 0.5, 0.5, 0.5, 0.5],
    upsells: [[0.147, 14.98], [0.08, 9.99], [0.08, 12]],
    expected: {
      trials: 13888.88889, trafficCost: 260416.6667, bonus: 1346.153846, fixedTotal: 27617.51385,
      users: [13888.88889, 5416.666667, 2816.666667, 1971.666667, 1380.166667, 966.1166667, 676.2816667, 338.1408333, 169.0704167, 84.53520833, 42.26760417, 21.13380208],
      gross: [68906.38889, 189583.3333, 98583.33333, 69008.33333, 48305.83333, 33814.08333, 23669.85833, 11834.92917, 5917.464583, 2958.732292, 1479.366146, 739.6830729],
      grossTotal: 554801.3391, paymentNetTotal: 433316.4899, netProfit: 145282.3094,
    },
  },
  {
    name: "w1 weekly block 1 ($11.99)",
    cadence: "weekly", trialPrice: 1, subPrice: 11.99, cpa: 18, budget: 250_000, refundRate: 0.1, ffBilling: 5000,
    survival: [1, 0.613, 0.6, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8],
    upsells: [[0.3, 14.98], [0.05, 9.99], [0.05, 9]],
    expected: {
      trials: 13888.88889, trafficCost: 260416.6667, bonus: 18136.21533, fixedTotal: 34407.57533,
      users: [13888.88889, 8513.888889, 5108.333333, 4086.666667, 3269.333333, 2615.466667, 2092.373333, 1673.898667, 1339.118933, 1071.295147, 857.0361173, 685.6288939, 548.5031151, 438.8024921, 351.0419937, 280.8335949, 224.6668759, 179.7335008, 143.7868006, 115.0294405, 92.02355239, 73.61884191, 58.89507353, 47.11605882],
      gross: [89493.05556, 102081.5278, 61248.91667, 48999.13333, 39199.30667, 31359.44533, 25087.55627, 20070.04501, 16056.03601, 12844.82881, 10275.86305, 8220.690437, 6576.55235, 5261.24188, 4208.993504, 3367.194803, 2693.755843, 2155.004674, 1724.003739, 1379.202991, 1103.362393, 882.6899145, 706.1519316, 564.9215453],
      grossTotal: 495559.4805, paymentNetTotal: 387046.821, netProfit: 92222.57904,
    },
  },
  {
    name: "w2 weekly block 2 ($14.98, paid trial $7.5)",
    cadence: "weekly", trialPrice: 7.5, subPrice: 14.98, cpa: 18, budget: 250_000, refundRate: 0.1, ffBilling: 5000,
    survival: [1, 0.39, 0.35, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.81, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75],
    upsells: [[0.373, 14.98], [0.08, 9.99], [0.08, 9]],
    expected: {
      trials: 13888.88889, trafficCost: 260416.6667, bonus: 1346.153846, fixedTotal: 17617.51385,
      users: [13888.88889, 5416.666667, 1895.833333, 1535.625, 1243.85625, 1007.523563, 816.0940856, 661.0362094, 535.4393296, 433.705857, 351.3017441, 284.5544128, 230.4890743, 186.6961502, 151.2238817, 122.4913441, 91.86850811, 68.90138108, 51.67603581, 38.75702686, 29.06777014, 21.80082761, 16.35062071, 12.26296553],
      gross: [202871.3889, 81141.66667, 28399.58333, 23003.6625, 18632.96663, 15092.70297, 12225.0894, 9902.322416, 8020.881157, 6496.913737, 5262.500127, 4262.625103, 3452.726333, 2796.70833, 2265.333747, 1834.920335, 1376.190252, 1032.142689, 774.1070165, 580.5802624, 435.4351968, 326.5763976, 244.9322982, 183.6992236],
      grossTotal: 430615.655, paymentNetTotal: 336323.745, netProfit: 58289.56452,
    },
  },
  {
    name: "w3 weekly block 3 ($19.98, 13-period horizon)",
    cadence: "weekly", trialPrice: 2, subPrice: 19.98, cpa: 18, budget: 50_000, refundRate: 0.1, ffBilling: 5000,
    survival: [1, 0.47, 0.66, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75, 0.75],
    upsells: [[0.15, 14.98], [0.08, 9.99], [0.08, 9]],
    expected: {
      trials: 2777.777778, trafficCost: 52083.33333, bonus: 1840.425532, fixedTotal: 18111.78553,
      users: [2777.777778, 1305.555556, 861.6666667, 646.25, 484.6875, 363.515625, 272.6367188, 204.4775391, 153.3581543, 115.0186157, 86.26396179, 64.69797134, 48.52347851],
      gross: [16017.22222, 26085, 17216.1, 12912.075, 9684.05625, 7263.042188, 5447.281641, 4085.46123, 3064.095923, 2298.071942, 1723.553957, 1292.665467, 969.4991006],
      grossTotal: 108058.1249, paymentNetTotal: 84396.63731, netProfit: 14201.51844,
    },
  },
];

// Workbook cached values keep 10 significant digits → compare with a relative
// tolerance well above the exporter rounding but far below any real defect.
function expectClose(actual: number, expected: number, label: string): void {
  const tolerance = Math.max(1e-6, Math.abs(expected) * 1e-8);
  expect(Math.abs(actual - expected), `${label}: got ${actual}, expected ${expected}`).toBeLessThanOrEqual(tolerance);
}

function fixtureAssumptions(block: GoldenBlock): ForecastAssumptionsResolved {
  return {
    traffic: { plannedBudget: block.budget, targetCpa: block.cpa, trafficCommission: FB_COMMISSION },
    pricing: {
      schedule: buildPeriodSchedule({
        cadence: block.cadence,
        paidPeriods: block.survival.length - 1,
        trialPrice: block.trialPrice,
        periodPrice: block.subPrice,
      }),
    },
    retention: { survival: [...block.survival], observedDepth: block.survival.length },
    monetization: {
      upsells: block.upsells.map(([takeRate, price], index) => ({ key: `upsell_${index + 1}`, takeRate, price })),
      tokenArpuPerTrial: 0,
      tokenArpuHold: 0,
    },
    costs: {
      stripeCommission: STRIPE,
      refundRate: block.refundRate,
      providerCommission: PROVIDER,
      feeApplicability: defaultFeeApplicability(),
      fixed: { ffBilling: block.ffBilling, funnelConstructor: CONSTRUCTOR, payroll: PAYROLL },
      overheadAllocation: { mode: "fixed_amount" },
      extraCosts: [],
    },
  };
}

function fixtureInputs(block: GoldenBlock, mutate?: (a: ForecastAssumptionsResolved) => void): FrozenForecastInputs {
  const assumptions = fixtureAssumptions(block);
  mutate?.(assumptions);
  return createFrozenForecastInputs({ assumptions, resolvedAt: RESOLVED_AT });
}

const M1 = GOLDEN[0];

describe("golden workbook parity (6 scenarios, one engine)", () => {
  for (const block of GOLDEN) {
    it(block.name, () => {
      const result = runFrozenForecast(fixtureInputs(block));
      expectClose(result.metrics.trials, block.expected.trials, "trials");
      expectClose(result.costs.trafficCashOutflow, block.expected.trafficCost, "traffic cash outflow");
      block.expected.users.forEach((expected, index) => {
        expectClose(result.timeline.periods[index].users, expected, `users[${index}]`);
      });
      block.expected.gross.forEach((expected, index) => {
        expectClose(result.revenue.grossByPeriod[index], expected, `gross[${index}]`);
      });
      expectClose(result.revenue.grossTotal, block.expected.grossTotal, "gross total");
      expectClose(result.profitability.paymentNetRevenueTotal, block.expected.paymentNetTotal, "payment-net total");
      expectClose(result.costs.performanceBonus, block.expected.bonus, "performance bonus");
      expectClose(
        result.costs.performanceBonus + result.costs.allocatedOverhead,
        block.expected.fixedTotal,
        "fixed costs total (bonus + overhead)",
      );
      expectClose(result.profitability.netProfit, block.expected.netProfit, "net profit");
    });
  }

  it("monthly and weekly run through the same engine entry (no cadence-specific math)", () => {
    const monthly = runFrozenForecast(fixtureInputs(M1));
    const weekly = runFrozenForecast(fixtureInputs(GOLDEN[3]));
    expect(monthly.timeline.periods).toHaveLength(12);
    expect(weekly.timeline.periods).toHaveLength(24);
    expect(monthly.timeline.periods[1].label).toBe("M1");
    expect(weekly.timeline.periods[1].label).toBe("W2");
    expect(monthly.timeline.periods[1].dayEnd).toBe(60);
    expect(weekly.timeline.periods[1].dayEnd).toBe(14);
  });
});

describe("payback", () => {
  it("m1 pays back in M2 (cumulative payment-net crosses traffic cost)", () => {
    const result = runFrozenForecast(fixtureInputs(M1));
    expect(result.payback.paybackPeriodIndex).toBe(2);
    expect(result.payback.paybackDay).toBe(90);
    expect(result.payback.noPaybackWithinHorizon).toBe(false);
  });

  it("w1 pays back in week period index 4 (day 35)", () => {
    const result = runFrozenForecast(fixtureInputs(GOLDEN[3]));
    expect(result.payback.paybackPeriodIndex).toBe(4);
    expect(result.payback.paybackDay).toBe(35);
  });

  it("m2 never pays back within the horizon → explicit null state, not zero", () => {
    const result = runFrozenForecast(fixtureInputs(GOLDEN[1]));
    expect(result.payback.paybackPeriodIndex).toBeNull();
    expect(result.payback.paybackDay).toBeNull();
    expect(result.payback.noPaybackWithinHorizon).toBe(true);
    expect(result.payback.finalCashFlowBalance).toBeLessThan(0);
  });
});

describe("reconciliation identities (spec §25)", () => {
  for (const block of GOLDEN) {
    it(`${block.name}: per-period and total identities hold`, () => {
      const result = runFrozenForecast(fixtureInputs(block));
      for (const row of result.timeline.periods) {
        const streamSum = row.revenue.trial + row.revenue.subscription + row.revenue.upsell + row.revenue.token;
        expect(row.revenue.gross).toBeCloseTo(streamSum, 6);
        expect(row.paymentNetRevenue).toBeCloseTo(row.revenue.gross - row.costs.paymentTotal, 6);
        expect(row.cashFlowBalance).toBeCloseTo(row.cumulativePaymentNetRevenue - result.costs.trafficCashOutflow, 6);
      }
      const r = result.revenue;
      expect(r.grossTotal).toBeCloseTo(r.trialTotal + r.subscriptionTotal + r.upsellTotal + r.tokenTotal, 6);
      expect(result.profitability.paymentNetRevenueTotal).toBeCloseTo(r.grossTotal - result.costs.paymentCostsTotal, 6);
      expect(result.profitability.contributionProfit).toBeCloseTo(
        result.profitability.paymentNetRevenueTotal - result.costs.trafficCashOutflow, 6,
      );
      expect(result.profitability.netProfit).toBeCloseTo(
        result.profitability.contributionProfit - result.costs.performanceBonus - result.costs.allocatedOverhead - result.costs.extraTotal, 6,
      );
      expectClose(result.metrics.contributionLtv, result.profitability.paymentNetRevenueTotal / result.metrics.trials, "contribution LTV");
      expectClose(result.metrics.cac, result.costs.trafficCashOutflow / result.metrics.trials, "CAC");
    });
  }
});

describe("determinism & serialization (spec §25.11/.13/.15)", () => {
  it("identical frozen inputs produce identical results", () => {
    const frozen = fixtureInputs(M1);
    expect(runFrozenForecast(frozen)).toEqual(runFrozenForecast(frozen));
  });

  it("frozen inputs survive a JSON round-trip and reproduce the same result", () => {
    const frozen = fixtureInputs(M1);
    const revived = JSON.parse(JSON.stringify(frozen)) as FrozenForecastInputs;
    expect(runFrozenForecast(revived)).toEqual(runFrozenForecast(frozen));
  });

  it("frozen inputs contain only plain serializable values (no functions/undefined/class instances)", () => {
    assertPlainSerializable(fixtureInputs(M1), "$");
  });

  it("results are serializable too", () => {
    assertPlainSerializable(runFrozenForecast(fixtureInputs(M1)), "$");
  });

  it("rejects snapshots from an unknown schema version", () => {
    const frozen = { ...fixtureInputs(M1), schemaVersion: FORECAST_SCHEMA_VERSION + 1 };
    expect(() => runFrozenForecast(frozen)).toThrowError(ForecastInputError);
  });
});

function assertPlainSerializable(value: unknown, path: string): void {
  if (value === null) return;
  if (value === undefined) throw new Error(`${path} is undefined`);
  const kind = typeof value;
  if (kind === "function") throw new Error(`${path} is a function`);
  if (kind === "number") {
    if (!Number.isFinite(value as number)) throw new Error(`${path} is a non-finite number`);
    return;
  }
  if (kind === "string" || kind === "boolean") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertPlainSerializable(item, `${path}[${index}]`));
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new Error(`${path} is not a plain object`);
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    assertPlainSerializable(item, `${path}.${key}`);
  }
}

describe("explicit input failures (spec §25.12 — no silent zeroes)", () => {
  const cases: Array<[string, (a: ForecastAssumptionsResolved) => void]> = [
    ["zero budget", (a) => { a.traffic.plannedBudget = 0; }],
    ["negative CPA", (a) => { a.traffic.targetCpa = -1; }],
    ["refund rate ≥ 1", (a) => { a.costs.refundRate = 1; }],
    ["survival[0] ≠ 1", (a) => { a.retention.survival[0] = 0.9; }],
    ["survival length mismatch", (a) => { a.retention.survival = a.retention.survival.slice(0, 5); }],
    ["survival value > 1", (a) => { a.retention.survival[3] = 1.2; }],
    ["percentage allocation without a fraction", (a) => { a.costs.overheadAllocation = { mode: "percentage" }; }],
    ["share-based allocation without a resolved share", (a) => { a.costs.overheadAllocation = { mode: "by_spend_share" }; }],
  ];
  for (const [name, mutate] of cases) {
    it(`throws ForecastInputError on ${name}`, () => {
      expect(() => runFrozenForecast(fixtureInputs(M1, mutate))).toThrowError(ForecastInputError);
    });
  }
});

describe("bonus policy (company policy, not engine math — spec §25.7)", () => {
  it("evaluator reproduces every workbook bonus from planned CPA and first-paid conversion", () => {
    const evaluate = resolveBonusEvaluator(workbookBonusPolicy());
    for (const block of GOLDEN) {
      const bonus = evaluate({
        plannedBudget: block.budget,
        trafficCashOutflow: block.budget / (1 - FB_COMMISSION),
        targetCpa: block.cpa,
        firstPaidConversion: block.survival[1],
      });
      expectClose(bonus, block.expected.bonus, `${block.name} bonus`);
    }
  });

  it("disabling the policy raises net profit by exactly the bonus amount", () => {
    const enabled = runFrozenForecast(fixtureInputs(M1));
    const disabledFrozen = fixtureInputs(M1);
    disabledFrozen.policyDescriptors.bonus = { ...workbookBonusPolicy(), enabled: false };
    const disabled = runFrozenForecast(disabledFrozen);
    expect(disabled.costs.performanceBonus).toBe(0);
    expect(disabled.profitability.netProfit).toBeCloseTo(
      enabled.profitability.netProfit + enabled.costs.performanceBonus, 6,
    );
  });

  it("kind 'none' yields zero bonus; unknown kinds fail loudly", () => {
    expect(resolveBonusEvaluator({ kind: "none", version: 1, enabled: true, params: { base: 0, target: 0, slope: 0 } })({
      plannedBudget: 1, trafficCashOutflow: 1, targetCpa: 1, firstPaidConversion: 1,
    })).toBe(0);
    expect(() => resolveBonusEvaluator({ kind: "unknown" as never, version: 1, enabled: true, params: { base: 0, target: 0, slope: 0 } }))
      .toThrowError(ForecastInputError);
  });

  it("zero first-paid conversion yields zero bonus (infinite effective cost), not NaN", () => {
    const bonus = resolveBonusEvaluator(workbookBonusPolicy())({
      plannedBudget: 50_000, trafficCashOutflow: 52_083, targetCpa: 13, firstPaidConversion: 0,
    });
    expect(bonus).toBe(0);
  });
});

describe("overhead allocation modes (spec §25.8)", () => {
  const rawFixed = 5000 + CONSTRUCTOR + PAYROLL;

  it("exclude → zero allocated overhead; net profit = contribution − bonus", () => {
    const result = runFrozenForecast(fixtureInputs(M1, (a) => { a.costs.overheadAllocation = { mode: "exclude" }; }));
    expect(result.costs.allocatedOverhead).toBe(0);
    expect(result.profitability.netProfit).toBeCloseTo(
      result.profitability.contributionProfit - result.costs.performanceBonus, 6,
    );
  });

  it("percentage → fraction of the raw fixed sum", () => {
    const result = runFrozenForecast(fixtureInputs(M1, (a) => { a.costs.overheadAllocation = { mode: "percentage", percentage: 0.5 }; }));
    expect(result.costs.allocatedOverhead).toBeCloseTo(rawFixed * 0.5, 6);
  });

  it("manual → the given amount verbatim", () => {
    const result = runFrozenForecast(fixtureInputs(M1, (a) => { a.costs.overheadAllocation = { mode: "manual", amount: 1234 }; }));
    expect(result.costs.allocatedOverhead).toBe(1234);
  });

  it("by_trial_share → pre-resolved share of the raw fixed sum", () => {
    const result = runFrozenForecast(fixtureInputs(M1, (a) => { a.costs.overheadAllocation = { mode: "by_trial_share", share: 0.25 }; }));
    expect(result.costs.allocatedOverhead).toBeCloseTo(rawFixed * 0.25, 6);
  });
});

describe("revenue streams (spec §25.9)", () => {
  it("upsell tiers break out separately and inactive tiers stay at zero", () => {
    const result = runFrozenForecast(fixtureInputs(M1));
    expectClose(result.revenue.upsellByTier[0].revenue, 9564.153846, "tier 1 revenue");
    expect(result.revenue.upsellByTier[1].revenue).toBe(0);
    expect(result.revenue.upsellByTier[2].revenue).toBe(0);
    expect(result.revenue.upsellTotal).toBeCloseTo(result.revenue.upsellByTier[0].revenue, 9);
  });

  it("token stream adds decaying revenue, flags the unresolved fee treatment, and keeps identities", () => {
    const frozen = fixtureInputs(M1, (a) => {
      a.monetization.tokenArpuPerTrial = 2;
      a.monetization.tokenArpuHold = 0.5;
    });
    const result = runFrozenForecast(frozen);
    const trials = result.metrics.trials;
    const expectedToken = trials * 2 * (1 - Math.pow(0.5, 12)) / (1 - 0.5);
    expectClose(result.revenue.tokenTotal, expectedToken, "token total (geometric series)");
    expect(result.warnings.some((warning) => warning.code === "token_fee_treatment_unresolved")).toBe(true);
    expect(result.revenue.grossTotal).toBeCloseTo(
      result.revenue.trialTotal + result.revenue.subscriptionTotal + result.revenue.upsellTotal + result.revenue.tokenTotal, 6,
    );
    const baseline = runFrozenForecast(fixtureInputs(M1));
    expect(result.profitability.netProfit).toBeGreaterThan(baseline.profitability.netProfit);
  });

  it("fee applicability matrix exempts a stream from selected fees", () => {
    const frozen = fixtureInputs(M1, (a) => {
      a.monetization.tokenArpuPerTrial = 2;
      a.monetization.tokenArpuHold = 0;
      a.costs.feeApplicability.token = { stripe: false, refund: false, provider: false };
    });
    const result = runFrozenForecast(frozen);
    const tokenRow = result.timeline.periods[0];
    // Token revenue passes through untouched; fees on the period only cover the other streams.
    const nonTokenGross = tokenRow.revenue.gross - tokenRow.revenue.token;
    const expectedStripe = nonTokenGross * STRIPE;
    expect(tokenRow.costs.stripe).toBeCloseTo(expectedStripe, 6);
  });
});

describe("rounding policy (spec §25 rounding rules)", () => {
  it("full precision is the default (no period-level rounding)", () => {
    const frozen = fixtureInputs(M1);
    expect(frozen.policyDescriptors.rounding.mode).toBe("full_precision");
  });

  it("period_2dp normalizes each period line to cents and stays within cents of full precision", () => {
    const frozen = fixtureInputs(M1);
    frozen.policyDescriptors.rounding = { mode: "period_2dp" };
    const rounded = runFrozenForecast(frozen);
    for (const row of rounded.timeline.periods) {
      for (const value of [row.revenue.trial, row.revenue.subscription, row.revenue.upsell, row.costs.stripe, row.costs.refund, row.costs.provider]) {
        expect(Math.abs(value * 100 - Math.round(value * 100))).toBeLessThan(1e-6);
      }
    }
    const full = runFrozenForecast(fixtureInputs(M1));
    expect(Math.abs(rounded.profitability.netProfit - full.profitability.netProfit)).toBeLessThan(1);
  });
});

describe("strategy registry (spec §25.22)", () => {
  it("geometric_last repeats the final observed multiplier to the horizon", () => {
    const extrapolate = resolveSurvivalExtrapolator({ method: "geometric_last" });
    expect(extrapolate([1, 0.43, 0.5], 5)).toEqual([1, 0.43, 0.5, 0.5, 0.5]);
  });

  it("geometric_avg repeats the geometric mean of the tail window", () => {
    const extrapolate = resolveSurvivalExtrapolator({ method: "geometric_avg", params: { window: 2 } });
    const extended = extrapolate([1, 0.43, 0.5], 4);
    expect(extended.slice(0, 3)).toEqual([1, 0.43, 0.5]);
    expect(extended[3]).toBeCloseTo(Math.sqrt(0.43 * 0.5), 12);
  });

  it("flat holds survival at 1 (documented optimistic bound)", () => {
    const extrapolate = resolveSurvivalExtrapolator({ method: "flat" });
    expect(extrapolate([1, 0.43], 4)).toEqual([1, 0.43, 1, 1]);
  });

  it("manual refuses to extrapolate and truncates an over-long curve", () => {
    const extrapolate = resolveSurvivalExtrapolator({ method: "manual" });
    expect(() => extrapolate([1, 0.43], 4)).toThrowError(ForecastInputError);
    expect(extrapolate([1, 0.43, 0.5, 0.4], 3)).toEqual([1, 0.43, 0.5]);
    expect(() => resolveSurvivalExtrapolator({ method: "spline" as never })).toThrowError(ForecastInputError);
  });

  it("rounding resolver rejects unknown modes", () => {
    expect(() => resolvePeriodRounder({ mode: "banker" as never })).toThrowError(ForecastInputError);
    // 0.125 is exactly representable → true half-up (banker's would give 0.12).
    expect(resolvePeriodRounder({ mode: "period_2dp" })(0.125)).toBeCloseTo(0.13, 9);
    expect(resolvePeriodRounder({ mode: "period_2dp" })(-0.125)).toBeCloseTo(-0.13, 9);
    expect(resolvePeriodRounder({ mode: "period_2dp" })(1.006)).toBeCloseTo(1.01, 9);
  });

  it("prepareRuntimeInputs is the only place descriptors become functions", () => {
    const runtime = prepareRuntimeInputs(fixtureInputs(M1));
    expect(typeof runtime.bonusEvaluator).toBe("function");
    expect(typeof runtime.roundPeriod).toBe("function");
    assertPlainSerializable(runtime.frozen, "$");
  });
});

describe("schedule builder", () => {
  it("labels and durations follow the workbook conventions", () => {
    const monthly = buildPeriodSchedule({ cadence: "monthly", paidPeriods: 2, trialPrice: 1, periodPrice: 29 });
    expect(monthly.periods.map((p) => p.label)).toEqual(["Trial", "M1", "M2"]);
    expect(monthly.periods.every((p) => p.durationDays === 30)).toBe(true);
    const weekly = buildPeriodSchedule({ cadence: "weekly", paidPeriods: 3, trialPrice: 1, periodPrice: 11.99 });
    expect(weekly.periods.map((p) => p.label)).toEqual(["Trial", "W2", "W3", "W4"]);
    expect(weekly.periods.every((p) => p.durationDays === 7)).toBe(true);
  });

  it("supports step pricing via a per-period price array", () => {
    const schedule = buildPeriodSchedule({ cadence: "monthly", paidPeriods: 3, trialPrice: 0, periodPrice: [9.99, 19.99, 29.99] });
    expect(schedule.periods.map((p) => p.price)).toEqual([0, 9.99, 19.99, 29.99]);
  });

  it("a trial-only horizon runs, produces no subscription revenue, and cannot pay back", () => {
    const frozen = fixtureInputs(M1, (a) => {
      a.pricing.schedule = buildPeriodSchedule({ cadence: "monthly", paidPeriods: 0, trialPrice: 1, periodPrice: 29 });
      a.retention.survival = [1];
    });
    const result = runFrozenForecast(frozen);
    expect(result.timeline.periods).toHaveLength(1);
    expect(result.revenue.subscriptionTotal).toBe(0);
    expect(result.payback.noPaybackWithinHorizon).toBe(true);
    expect(result.costs.performanceBonus).toBe(0); // no paid period → no first-paid conversion → no bonus
  });
});
