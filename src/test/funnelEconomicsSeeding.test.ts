// FunnelActualsProvider + AssumptionBuilder tests (v3 spec §25.16–.19).
import { describe, expect, it } from "vitest";
import {
  ForecastInputError,
  buildForecastAssumptions,
  createCohortRowActualsProvider,
  createFrozenForecastInputs,
  deriveFunnelActualsFromCohortRows,
  resolveHistoricalWindow,
  runFrozenForecast,
  type CohortRowLike,
  type FunnelActuals,
} from "@/services/funnelEconomics";

const AS_OF = "2026-07-27T00:00:00.000Z";

const ROW_A: CohortRowLike = {
  cohort_date: "2026-05-01",
  funnel: "soulmate",
  campaign_path: "soulmate-1-sp",
  trial_users: 100,
  first_subscription_users: 40,
  renewal_users_by_level: { 2: 20, 3: 10 },
  trial_revenue: 100,
  first_subscription_revenue: 1160,
  upsell_1_users: 20,
  upsell_1_revenue: 299.6,
  token_net_revenue: 50,
  amount_refunded: 120,
  gross_revenue: 1200,
  fb_spend: 1300,
};

const ROW_B: CohortRowLike = {
  cohort_date: "2026-05-08",
  funnel: "soulmate",
  campaign_path: "soulmate-1-sp",
  trial_users: 100,
  first_subscription_users: 46,
  renewal_users_by_level: { 2: 23, 3: 12 },
  trial_revenue: 100,
  first_subscription_revenue: 1334,
  upsell_1_users: 30,
  upsell_1_revenue: 449.4,
  token_net_revenue: 30,
  amount_refunded: 80,
  gross_revenue: 800,
  fb_spend: 1300,
};

function derive(rows: CohortRowLike[]) {
  return deriveFunnelActualsFromCohortRows({ funnelId: "soulmate-1-sp", rows, asOf: AS_OF });
}

describe("deriveFunnelActualsFromCohortRows", () => {
  it("rolls two cohorts into one immutable fact set (rates, prices, tiers, chain)", () => {
    const { actuals, coverage, warnings } = derive([ROW_A, ROW_B]);
    expect(actuals).not.toBeNull();
    const facts = actuals as FunnelActuals;
    expect(facts.trials).toBe(200);
    expect(facts.spend).toBe(2600);
    expect(facts.cpaActual).toBeCloseTo(13, 9);
    expect(facts.firstPaidConversion).toBeCloseTo(0.43, 9);
    // Chain: c1→2 = 43/86, c2→3 = 22/43; level 4 fields absent → chain stops (not zero).
    expect(facts.renewalConversions).toHaveLength(2);
    expect(facts.renewalConversions[0]).toBeCloseTo(0.5, 9);
    expect(facts.renewalConversions[1]).toBeCloseTo(22 / 43, 9);
    expect(facts.observedRetentionDepth).toBe(4);
    expect(facts.trialPriceActual).toBeCloseTo(1, 9);
    expect(facts.subPriceActual).toBeCloseTo(29, 6);
    expect(facts.upsellTiersActual).toHaveLength(1);
    expect(facts.upsellTiersActual[0].takeRate).toBeCloseTo(0.25, 9);
    expect(facts.upsellTiersActual[0].price).toBeCloseTo(14.98, 6);
    expect(facts.tokenArpuPerTrialActual).toBeCloseTo(0.4, 9);
    expect(facts.refundRateActual).toBeCloseTo(0.1, 9);
    expect(facts.maturityDays).toBe(87);
    expect(coverage.spendCoverage).toBe(1);
    expect(warnings.map((warning) => warning.code)).not.toContain("spend_unavailable");
  });

  it("no rows → actuals null with a warning (never zeroed facts)", () => {
    const { actuals, warnings } = derive([]);
    expect(actuals).toBeNull();
    expect(warnings.some((warning) => warning.code === "no_data")).toBe(true);
  });

  it("missing spend → spend/cpa null + warning, other facts still derived", () => {
    const { actuals, warnings } = derive([
      { ...ROW_A, fb_spend: undefined },
      { ...ROW_B, fb_spend: undefined },
    ]);
    const facts = actuals as FunnelActuals;
    expect(facts.spend).toBeNull();
    expect(facts.cpaActual).toBeNull();
    expect(facts.firstPaidConversion).toBeCloseTo(0.43, 9);
    expect(warnings.some((warning) => warning.code === "spend_unavailable")).toBe(true);
  });

  it("an observed zero renewal level records conversion 0 and stops the chain", () => {
    const { actuals } = derive([
      { ...ROW_A, renewal_users_by_level: { 2: 0 } },
      { ...ROW_B, renewal_users_by_level: { 2: 0 } },
    ]);
    const facts = actuals as FunnelActuals;
    expect(facts.renewalConversions).toEqual([0]);
  });

  it("flags low volume and shallow retention", () => {
    const { warnings } = derive([{ ...ROW_A, trial_users: 20, renewal_users_by_level: {} }]);
    const codes = warnings.map((warning) => warning.code);
    expect(codes).toContain("low_volume");
    expect(codes).toContain("shallow_retention");
  });
});

describe("resolveHistoricalWindow", () => {
  it("last_days counts back from asOf", () => {
    expect(resolveHistoricalWindow({ kind: "last_days", days: 90 }, AS_OF)).toEqual({ from: "2026-04-28", to: "2026-07-27" });
  });

  it("maturity_filtered ends minMaturityDays before asOf", () => {
    expect(resolveHistoricalWindow({ kind: "maturity_filtered", minMaturityDays: 30 }, AS_OF)).toEqual({ from: "1970-01-01", to: "2026-06-27" });
  });

  it("fixed passes through", () => {
    const window = { from: "2026-01-01", to: "2026-02-01" };
    expect(resolveHistoricalWindow({ kind: "fixed", window }, AS_OF)).toEqual(window);
  });
});

describe("createCohortRowActualsProvider", () => {
  it("resolves the window, loads rows through the injected loader, and stamps source metadata", async () => {
    const seenWindows: unknown[] = [];
    const provider = createCohortRowActualsProvider({
      source: "test-cohort-rows",
      asOf: AS_OF,
      loadCohortRows: async (window) => {
        seenWindows.push(window);
        return [ROW_A, ROW_B];
      },
    });
    const result = await provider.getFunnelActuals({
      funnelId: "soulmate-1-sp",
      windowPolicy: { kind: "last_days", days: 90 },
    });
    expect(seenWindows[0]).toEqual({ from: "2026-04-28", to: "2026-07-27" });
    expect(result.actuals?.trials).toBe(200);
    expect(result.sourceMetadata.source).toBe("test-cohort-rows");
    expect(result.sourceMetadata.windowResolved).toEqual({ from: "2026-04-28", to: "2026-07-27" });
  });
});

describe("buildForecastAssumptions (precedence + provenance, spec §8)", () => {
  const actuals = derive([ROW_A, ROW_B]).actuals as FunnelActuals;

  it("auto-seeds CPA, prices, curve, upsells, refund from actuals with auto_derived provenance", () => {
    const built = buildForecastAssumptions({
      cadence: "monthly",
      plannedBudget: 50_000,
      actuals,
    });
    expect(built.assumptions.traffic.targetCpa).toBeCloseTo(13, 9);
    expect(built.provenance["traffic.targetCpa"]).toBe("auto_derived");
    expect(built.assumptions.pricing.schedule.periods[0].price).toBeCloseTo(1, 9);
    expect(built.assumptions.pricing.schedule.periods[1].price).toBeCloseTo(29, 6);
    expect(built.provenance["pricing.periodPrice"]).toBe("auto_derived");
    expect(built.assumptions.retention.survival).toHaveLength(12);
    expect(built.assumptions.retention.survival[1]).toBeCloseTo(0.43, 9);
    expect(built.assumptions.retention.survival[2]).toBeCloseTo(0.5, 9);
    // Tail extrapolated with geometric_last (= last observed conversion 22/43).
    expect(built.assumptions.retention.survival[6]).toBeCloseTo(22 / 43, 9);
    expect(built.assumptions.retention.observedDepth).toBe(4);
    expect(built.provenance["retention.survival[3]"]).toBe("auto_derived");
    expect(built.provenance["retention.survival[4]"]).toBe("extrapolated");
    expect(built.warnings.some((warning) => warning.code === "retention_tail_extrapolated")).toBe(true);
    expect(built.assumptions.monetization.upsells[0].takeRate).toBeCloseTo(0.25, 9);
    expect(built.assumptions.costs.refundRate).toBeCloseTo(0.1, 9);
    expect(built.provenance["costs.refundRate"]).toBe("auto_derived");
  });

  it("profile defaults fill gaps when actuals are absent (config provenance)", () => {
    const built = buildForecastAssumptions({
      cadence: "monthly",
      plannedBudget: 50_000,
      actuals: null,
      profile: { trialPrice: 1, periodPrice: 29, survival: [1, 0.43, 0.5] },
      manual: { targetCpa: 13 },
    });
    expect(built.provenance["pricing.trialPrice"]).toBe("config");
    expect(built.provenance["pricing.periodPrice"]).toBe("config");
    expect(built.provenance["retention.survival"]).toBe("config");
    expect(built.provenance["traffic.targetCpa"]).toBe("manual_override");
    expect(built.assumptions.retention.survival[2]).toBeCloseTo(0.5, 9);
  });

  it("auto-derived actuals beat profile defaults for autoSeed fields", () => {
    const built = buildForecastAssumptions({
      cadence: "monthly",
      plannedBudget: 50_000,
      actuals,
      profile: { trialPrice: 9, periodPrice: 99, survival: [1, 0.9] },
    });
    expect(built.assumptions.pricing.schedule.periods[1].price).toBeCloseTo(29, 6);
    expect(built.assumptions.retention.survival[1]).toBeCloseTo(0.43, 9);
  });

  it("manual scalar seeds beat auto; tree patch beats everything", () => {
    const built = buildForecastAssumptions({
      cadence: "monthly",
      plannedBudget: 50_000,
      actuals,
      manual: { targetCpa: 15, periodPrice: 35 },
      overrides: { costs: { refundRate: 0.2 } },
    });
    expect(built.assumptions.traffic.targetCpa).toBe(15);
    expect(built.provenance["traffic.targetCpa"]).toBe("manual_override");
    expect(built.assumptions.pricing.schedule.periods[1].price).toBe(35);
    expect(built.assumptions.costs.refundRate).toBe(0.2);
    expect(built.provenance["costs.refundRate"]).toBe("manual_override");
  });

  it("fails loudly when no CPA is available anywhere", () => {
    const spendless = derive([{ ...ROW_A, fb_spend: undefined }]).actuals as FunnelActuals;
    expect(() => buildForecastAssumptions({ cadence: "monthly", plannedBudget: 50_000, actuals: spendless }))
      .toThrowError(ForecastInputError);
  });

  it("fails loudly when no retention curve is available anywhere", () => {
    expect(() => buildForecastAssumptions({
      cadence: "monthly",
      plannedBudget: 50_000,
      actuals: null,
      profile: { trialPrice: 1, periodPrice: 29 },
      manual: { targetCpa: 13 },
    })).toThrowError(ForecastInputError);
  });

  it("seeded assumptions run end-to-end through the engine with identities intact", () => {
    const built = buildForecastAssumptions({ cadence: "monthly", plannedBudget: 50_000, actuals });
    const result = runFrozenForecast(createFrozenForecastInputs({
      assumptions: built.assumptions,
      provenance: built.provenance,
      resolvedAt: AS_OF,
    }));
    expect(result.metrics.trials).toBeCloseTo(50_000 / 13, 6);
    expect(result.revenue.grossTotal).toBeGreaterThan(0);
    expect(result.revenue.grossTotal).toBeCloseTo(
      result.revenue.trialTotal + result.revenue.subscriptionTotal + result.revenue.upsellTotal + result.revenue.tokenTotal,
      6,
    );
    expect(result.profitability.netProfit).toBeCloseTo(
      result.profitability.contributionProfit - result.costs.performanceBonus - result.costs.allocatedOverhead,
      6,
    );
    // Provenance flows through to the result untouched.
    expect(result.provenance["traffic.targetCpa"]).toBe("auto_derived");
  });
});
