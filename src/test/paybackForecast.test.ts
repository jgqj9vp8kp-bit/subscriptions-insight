import { describe, expect, it } from "vitest";
import {
  HORIZON_DAYS,
  buildCohortPaybackRows,
  buildSelectedCohortDataset,
  calculateActualRevenueByDay,
  calculateBreakEvenCAC,
  calculateMaxProfitableCAC,
  calculatePaybackDay,
  calculatePaybackSummary,
  calculateProjectedLTV,
  calculateScenario,
  deriveAssumptionsFromCohorts,
  estimateFutureRevenue,
  facebookSpendForCohorts,
  paybackStatus,
  projectMonthlyNetRevenue,
  resolveSpendAndCac,
  type ForecastAssumptions,
  type ForecastComputationInput,
} from "@/services/paybackForecast";
import { aggregateTrafficMetrics } from "@/services/cohortReporting";
import { buildCohortId } from "@/services/cohortIdentity";
import type { CohortRow, Transaction, TransactionStatus, TransactionType } from "@/services/types";
import type { TrafficMetric } from "@/services/trafficImport";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function cohort(overrides: Partial<CohortRow>): CohortRow {
  return {
    cohort_id: overrides.cohort_id ?? buildCohortId(overrides.funnel ?? "soulmate", overrides.campaign_path ?? "reading", overrides.cohort_date ?? "2026-01-01"),
    cohort_date: "2026-01-01",
    funnel: "soulmate",
    campaign_path: "reading",
    trial_users: 0,
    active_users: 0,
    active_rate: 0,
    active_subscriptions: 0,
    active_subscriptions_rate: 0,
    active_subscription_user_ids: [],
    cancelled_users: 0,
    cancellation_rate: 0,
    user_cancelled_users: 0,
    user_cancel_rate: 0,
    auto_cancelled_users: 0,
    auto_cancel_rate: 0,
    cancelled_active_users: 0,
    active_user_ids: [],
    cancelled_user_ids: [],
    user_cancelled_user_ids: [],
    auto_cancelled_user_ids: [],
    cancelled_active_user_ids: [],
    upsell_users: 0,
    first_subscription_users: 0,
    renewal_2_users: 0,
    renewal_3_users: 0,
    renewal_4_users: 0,
    renewal_5_users: 0,
    renewal_6_users: 0,
    renewal_users_by_level: {},
    renewal_users: 0,
    refund_users: 0,
    refunded_user_ids: [],
    plan_breakdown: [],
    trial_revenue: 0,
    upsell_revenue: 0,
    first_subscription_revenue: 0,
    renewal_revenue: 0,
    amount_refunded: 0,
    refund_rate: 0,
    gross_revenue: 0,
    net_revenue: 0,
    gross_ltv: 0,
    net_ltv: 0,
    trial_to_upsell_cr: 0,
    trial_to_first_subscription_cr: 0,
    first_subscription_to_renewal_2_cr: 0,
    renewal_2_to_renewal_3_cr: 0,
    revenue_d0: 0,
    revenue_d7: 0,
    revenue_d14: 0,
    revenue_d30: 0,
    revenue_d60: 0,
    revenue_d37: 0,
    revenue_d67: 0,
    revenue_total: 0,
    ltv_d7: 0,
    ltv_d14: 0,
    ltv_d30: 0,
    ...overrides,
  };
}

function tx(
  userId: string,
  transactionType: TransactionType,
  eventTime: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 30);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${eventTime}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? Math.max(0, amount),
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    is_refunded: overrides.is_refunded ?? false,
    currency: "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "reading",
    product: "Product",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "c1",
    classification_reason: "",
    cohort_date: overrides.cohort_date,
    cohort_id: overrides.cohort_id,
  } as Transaction;
}

function traffic(overrides: Partial<TrafficMetric>): TrafficMetric {
  return {
    date: "2026-01-01",
    campaign_path: "reading",
    trial_count: 0,
    cac: 0,
    spend: 0,
    clicks: 0,
    cpc: 0,
    cpm: 0,
    ctr: 0,
    source: "facebook",
    ...overrides,
  };
}

const baseAssumptions: ForecastAssumptions = {
  trialPrice: 1,
  subscriptionPrice: 30,
  upsellValue: 0,
  upsellRate: 0,
  firstRenewalRate: 0.5,
  monthlyRetention: 0.8,
  refundRate: 0,
  processingFeePct: 0,
  fixedProcessingFee: 0,
  cac: null,
};

const COHORT_DATE = "2026-01-01";
const dayN = (n: number) => new Date(new Date(`${COHORT_DATE}T00:00:00.000Z`).getTime() + n * 24 * 60 * 60 * 1000).toISOString();

// ---------------------------------------------------------------------------
// 1-2. Cohort selection by funnel / campaign_path (dataset aggregation)
// ---------------------------------------------------------------------------

describe("selected cohort dataset", () => {
  it("aggregates cohorts selected by funnel", () => {
    const cohorts = [
      cohort({ funnel: "soulmate", campaign_path: "reading", trial_users: 100, gross_revenue: 500, net_revenue: 480 }),
      cohort({ funnel: "soulmate", campaign_path: "sketch", trial_users: 50, gross_revenue: 200, net_revenue: 190 }),
    ];
    const dataset = buildSelectedCohortDataset(cohorts, aggregateTrafficMetrics([]));
    expect(dataset.trialUsers).toBe(150);
    expect(dataset.grossRevenue).toBe(700);
    expect(dataset.netRevenue).toBe(670);
    expect(dataset.cohortIds).toHaveLength(2);
  });

  it("aggregates a single campaign_path selection", () => {
    const cohorts = [cohort({ campaign_path: "reading", trial_users: 40, net_revenue: 100 })];
    const dataset = buildSelectedCohortDataset(cohorts, aggregateTrafficMetrics([]));
    expect(dataset.trialUsers).toBe(40);
    expect(dataset.netRevenue).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// 3-5, 20. Spend / CAC
// ---------------------------------------------------------------------------

describe("spend and CAC resolution", () => {
  it("uses Facebook spend matched by date + campaign_path", () => {
    const cohorts = [cohort({ campaign_path: "reading", cohort_date: "2026-01-01", trial_users: 100 })];
    const trafficByKey = aggregateTrafficMetrics([traffic({ date: "2026-01-01", campaign_path: "reading", spend: 2500 })]);
    const fb = facebookSpendForCohorts(cohorts, trafficByKey);
    expect(fb).toBe(2500);
    const resolution = resolveSpendAndCac({ trialUsers: 100, facebookSpend: fb });
    expect(resolution.spend).toBe(2500);
    expect(resolution.cac).toBe(25);
    expect(resolution.source).toBe("facebook");
  });

  it("applies a manual spend override", () => {
    const resolution = resolveSpendAndCac({ trialUsers: 100, facebookSpend: 2500, manualSpend: 4000 });
    expect(resolution.spend).toBe(4000);
    expect(resolution.cac).toBe(40);
    expect(resolution.source).toBe("manual_spend");
  });

  it("applies a manual CAC override (spend = cac * trial users)", () => {
    const resolution = resolveSpendAndCac({ trialUsers: 100, facebookSpend: 2500, manualCac: 32 });
    expect(resolution.spend).toBe(3200);
    expect(resolution.cac).toBe(32);
    expect(resolution.source).toBe("manual_cac");
  });

  it("reports spend unavailable rather than silently zero", () => {
    const resolution = resolveSpendAndCac({ trialUsers: 100, facebookSpend: null });
    expect(resolution.spend).toBeNull();
    expect(resolution.spendAvailable).toBe(false);
    expect(resolution.cac).toBeNull();
    expect(facebookSpendForCohorts([cohort({ trial_users: 10 })], aggregateTrafficMetrics([]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Actual revenue by day
// ---------------------------------------------------------------------------

describe("actual revenue by day", () => {
  it("accumulates net revenue by per-user day offset and subtracts refunds by their date", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const txs = [
      tx("u1", "trial", dayN(0), { net_amount_usd: 1 }),
      tx("u1", "first_subscription", dayN(30), { net_amount_usd: 30 }),
      tx("u1", "refund", dayN(35), { status: "refunded", amount_usd: -30, net_amount_usd: -30 }),
    ];
    const result = calculateActualRevenueByDay(txs, [cohortId]);
    expect(result.maxDay).toBe(35);
    expect(actualAt(result, 0)).toBe(1);
    expect(actualAt(result, 30)).toBe(31);
    expect(actualAt(result, 40)).toBe(1); // refund removed the sub revenue
    expect(result.totalNet).toBe(1);
  });

  it("ignores failed charges and cohorts that are not selected", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const txs = [
      tx("u1", "trial", dayN(0), { net_amount_usd: 1 }),
      tx("u1", "failed_payment", dayN(10), { status: "failed", amount_usd: 30, net_amount_usd: 30 }),
      tx("u2", "trial", dayN(0), { funnel: "starseed", campaign_path: "other", net_amount_usd: 1 }),
    ];
    const result = calculateActualRevenueByDay(txs, [cohortId]);
    expect(result.totalNet).toBe(1); // only u1 trial; failed ignored; u2 in a different cohort
  });
});

function actualAt(result: ReturnType<typeof calculateActualRevenueByDay>, day: number): number {
  let value = 0;
  for (const point of result.points) {
    if (point.day > day) break;
    value = point.cumulativeNet;
  }
  return value;
}

// ---------------------------------------------------------------------------
// 7. Projected revenue by horizon
// ---------------------------------------------------------------------------

describe("projected revenue", () => {
  it("projects monthly net revenue from assumptions", () => {
    // 100 trials, $1 trial, $30 sub, 50% first renewal, 80% monthly retention, no fees.
    const projection = projectMonthlyNetRevenue(100, baseAssumptions, 3);
    expect(projection[0].cumulativeNetRevenue).toBe(100); // entry: 100 * $1
    // month 1: 100 * 0.5 * $30 = 1500 -> cumulative 1600
    expect(projection[1].cumulativeNetRevenue).toBe(1600);
    // month 2: 100 * 0.5 * 0.8 * $30 = 1200 -> cumulative 2800
    expect(projection[2].cumulativeNetRevenue).toBe(2800);
  });

  it("blends realized actuals with projected future beyond cohort maturity", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const txs = [
      tx("u1", "trial", dayN(0), { net_amount_usd: 1 }),
      tx("u1", "first_subscription", dayN(30), { net_amount_usd: 30 }),
    ];
    const actual = calculateActualRevenueByDay(txs, [cohortId]); // maxDay = 30, totalNet = 31
    const projection = projectMonthlyNetRevenue(1, baseAssumptions, 6);
    // Day within actual data uses realized value.
    expect(estimateFutureRevenue(actual, projection, 30)).toBe(31);
    // Beyond maturity: realized + projected increment (projection month 2 - month 1).
    const beyond = estimateFutureRevenue(actual, projection, 60);
    expect(beyond).toBeGreaterThan(31);
  });
});

// ---------------------------------------------------------------------------
// 8-9. Payback day
// ---------------------------------------------------------------------------

describe("token ARPU uplift (TODO_MONETIZATION item 2)", () => {
  it("is an additive net stream: projection with uplift differs by the exact geometric series", () => {
    const months = 6;
    const base = projectMonthlyNetRevenue(100, baseAssumptions, months);
    const uplifted = projectMonthlyNetRevenue(100, { ...baseAssumptions, tokenArpuPerTrial: 2, tokenArpuDecay: 0.5 }, months);
    let expectedCumulative = 0;
    for (let month = 0; month <= months; month += 1) {
      expectedCumulative += 100 * 2 * Math.pow(0.5, month);
      expect(uplifted[month].cumulativeNetRevenue - base[month].cumulativeNetRevenue).toBeCloseTo(expectedCumulative, 1);
      // Retention math is untouched: paying users and gross are identical.
      expect(uplifted[month].payingUsers).toBe(base[month].payingUsers);
      expect(uplifted[month].grossRevenue).toBe(base[month].grossRevenue);
    }
  });

  it("hold mode (decay 0) adds a flat ARPU every month; absent assumption changes nothing", () => {
    const base = projectMonthlyNetRevenue(10, baseAssumptions, 3);
    const hold = projectMonthlyNetRevenue(10, { ...baseAssumptions, tokenArpuPerTrial: 1, tokenArpuDecay: 0 }, 3);
    expect(hold[3].cumulativeNetRevenue - base[3].cumulativeNetRevenue).toBeCloseTo(10 * 1 * 4, 2);
    const none = projectMonthlyNetRevenue(10, { ...baseAssumptions, tokenArpuPerTrial: 0 }, 3);
    expect(none.map((point) => point.cumulativeNetRevenue)).toEqual(base.map((point) => point.cumulativeNetRevenue));
  });

  it("derives the auto ARPU from cohort token net revenue per trial user", () => {
    const auto = deriveAssumptionsFromCohorts([
      { trial_users: 40, token_net_revenue: 100 } as never,
      { trial_users: 10, token_net_revenue: 25 } as never,
    ]);
    expect(auto.tokenArpuPerTrial).toBeCloseTo(2.5, 2);
  });
});

describe("payback day", () => {
  it("finds the first day cumulative net revenue >= spend", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const txs = [
      tx("u1", "trial", dayN(0), { net_amount_usd: 10 }),
      tx("u1", "first_subscription", dayN(30), { net_amount_usd: 100 }),
    ];
    const actual = calculateActualRevenueByDay(txs, [cohortId]);
    const projection = projectMonthlyNetRevenue(1, baseAssumptions, 12);
    expect(calculatePaybackDay(actual, projection, 50)).toBe(30); // 10 at d0 < 50, 110 at d30 >= 50
  });

  it("returns null when spend is never recovered or unavailable", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const txs = [tx("u1", "trial", dayN(0), { net_amount_usd: 1 })];
    const actual = calculateActualRevenueByDay(txs, [cohortId]);
    const projection = projectMonthlyNetRevenue(1, { ...baseAssumptions, firstRenewalRate: 0 }, 12);
    expect(calculatePaybackDay(actual, projection, 1_000_000)).toBeNull();
    expect(calculatePaybackDay(actual, projection, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10-12. Break-even CAC / projected LTV / profit per user
// ---------------------------------------------------------------------------

describe("break-even CAC, LTV and profit per user", () => {
  it("break-even CAC equals projected LTV at the horizon", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const actual = calculateActualRevenueByDay([tx("u1", "trial", dayN(0), { net_amount_usd: 100 })], [cohortId]);
    const projection = projectMonthlyNetRevenue(1, { ...baseAssumptions, firstRenewalRate: 0 }, 12);
    const ltv = calculateProjectedLTV(actual, projection, 1, HORIZON_DAYS.d30);
    expect(ltv).toBe(100);
    expect(calculateBreakEvenCAC(ltv)).toBe(100);
    expect(calculateMaxProfitableCAC(ltv, 0.2)).toBe(80); // 20% margin target
  });

  it("computes profit per user as projected LTV minus CAC", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const actual = calculateActualRevenueByDay([tx("u1", "trial", dayN(0), { net_amount_usd: 50 })], [cohortId]);
    const input: ForecastComputationInput = {
      actual,
      trialUsers: 1,
      spend: 30,
      spendAvailable: true,
      cac: 30,
      grossRevenue: 50,
      netRevenue: 50,
      assumptions: { ...baseAssumptions, firstRenewalRate: 0, cac: 30 },
    };
    const summary = calculatePaybackSummary(input);
    expect(summary.projectedLtv).toBe(50);
    expect(summary.profitPerUser).toBe(20);
    expect(summary.currentRoas).toBeCloseTo(50 / 30);
  });
});

// ---------------------------------------------------------------------------
// 13-15. Status
// ---------------------------------------------------------------------------

describe("status classification", () => {
  it("Scale when ROAS 1M >= 1.2 and payback <= 30", () => {
    expect(paybackStatus(1.3, 20, true)).toBe("scale");
  });
  it("Watch when ROAS 1M is between 0.8 and 1.2", () => {
    expect(paybackStatus(1.0, 45, true)).toBe("watch");
  });
  it("Stop when ROAS 1M < 0.8 or payback > 60 or never pays back", () => {
    expect(paybackStatus(0.5, 20, true)).toBe("stop");
    expect(paybackStatus(1.5, 90, true)).toBe("stop");
    expect(paybackStatus(1.5, null, true)).toBe("stop");
  });
  it("Unknown when there is not enough data", () => {
    expect(paybackStatus(null, null, false)).toBe("unknown");
    expect(paybackStatus(2, 10, false)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 16-18. Scenario planner + refund override
// ---------------------------------------------------------------------------

describe("scenario planner", () => {
  const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
  const actual = calculateActualRevenueByDay(
    [tx("u1", "trial", dayN(0), { net_amount_usd: 100 }), tx("u2", "trial", dayN(0), { net_amount_usd: 100 })],
    [cohortId],
  );
  const baseInput: ForecastComputationInput = {
    actual,
    trialUsers: 2,
    spend: 200,
    spendAvailable: true,
    cac: 100,
    grossRevenue: 200,
    netRevenue: 200,
    assumptions: { ...baseAssumptions, firstRenewalRate: 0, cac: 100 },
  };

  it("reflects a CAC change", () => {
    const scenario: ForecastComputationInput = { ...baseInput, spend: 128, cac: 64, assumptions: { ...baseInput.assumptions, cac: 64 } };
    const result = calculateScenario(baseInput, scenario);
    expect(result.base.profit).toBe(0); // 200 net - 200 spend
    expect(result.scenario.profit).toBe(72); // 200 net - 128 spend
    expect(result.deltaProfit).toBe(72);
    expect(result.scenario.roas1M).toBeGreaterThan(result.base.roas1M!);
  });

  it("reflects a retention change (higher first renewal -> higher projected LTV)", () => {
    const scenario: ForecastComputationInput = {
      ...baseInput,
      assumptions: { ...baseInput.assumptions, firstRenewalRate: 0.6 },
    };
    const result = calculateScenario(baseInput, scenario);
    expect(result.scenario.projectedLtv).toBeGreaterThan(result.base.projectedLtv);
  });

  it("reflects a refund-rate override (higher refunds -> lower projected net)", () => {
    const withRefunds = projectMonthlyNetRevenue(100, { ...baseAssumptions, refundRate: 0.25 }, 3);
    const noRefunds = projectMonthlyNetRevenue(100, { ...baseAssumptions, refundRate: 0 }, 3);
    expect(withRefunds[1].cumulativeNetRevenue).toBeLessThan(noRefunds[1].cumulativeNetRevenue);
    expect(withRefunds[1].cumulativeNetRevenue).toBeCloseTo(noRefunds[1].cumulativeNetRevenue * 0.75);
  });
});

// ---------------------------------------------------------------------------
// 19. Aggregate of selected cohorts + auto assumptions + per-cohort rows
// ---------------------------------------------------------------------------

describe("selected cohorts aggregate and rows", () => {
  it("derives auto assumptions from real cohort fields", () => {
    const auto = deriveAssumptionsFromCohorts([
      cohort({
        trial_users: 100,
        upsell_users: 20,
        first_subscription_users: 40,
        renewal_2_users: 24,
        trial_revenue: 100,
        upsell_revenue: 300,
        first_subscription_revenue: 1200,
        gross_revenue: 2000,
        amount_refunded: 100,
      }),
    ]);
    expect(auto.trialPrice).toBe(1); // 100/100
    expect(auto.subscriptionPrice).toBe(30); // 1200/40
    expect(auto.upsellValue).toBe(15); // 300/20
    expect(auto.upsellRate).toBe(0.2); // 20/100
    expect(auto.firstRenewalRate).toBe(0.4); // 40/100
    expect(auto.monthlyRetention).toBe(0.6); // 24/40
    expect(auto.refundRate).toBe(0.05); // 100/2000
  });

  it("builds one payback row per cohort with a status", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const cohorts = [
      cohort({ cohort_id: cohortId, campaign_path: "reading", cohort_date: COHORT_DATE, trial_users: 100, gross_revenue: 5000, net_revenue: 5000, trial_revenue: 100, first_subscription_users: 40, first_subscription_revenue: 1200 }),
    ];
    const txs = [
      tx("u1", "trial", dayN(0), { net_amount_usd: 5000 }),
    ];
    const trafficByKey = aggregateTrafficMetrics([traffic({ date: COHORT_DATE, campaign_path: "reading", spend: 2000 })]);
    const rows = buildCohortPaybackRows(cohorts, txs, trafficByKey, { ...baseAssumptions, cac: null });
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBe(2000);
    expect(rows[0].cac).toBe(20);
    expect(rows[0].currentRoas).toBeCloseTo(2.5);
    expect(["scale", "watch", "stop", "unknown"]).toContain(rows[0].status);
  });

  it("marks a cohort with no matched spend as unknown", () => {
    const cohortId = buildCohortId("soulmate", "reading", COHORT_DATE);
    const cohorts = [cohort({ cohort_id: cohortId, trial_users: 100, net_revenue: 100 })];
    const rows = buildCohortPaybackRows(cohorts, [tx("u1", "trial", dayN(0))], aggregateTrafficMetrics([]), { ...baseAssumptions, cac: null });
    expect(rows[0].spendAvailable).toBe(false);
    expect(rows[0].status).toBe("unknown");
  });
});
