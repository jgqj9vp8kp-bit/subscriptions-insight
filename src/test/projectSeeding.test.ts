// Project seeding (P3): cohort rows + spend ledger → entries → frozen → run.
//
// The ledger fixtures are built by the REAL P2 assembler, so window identity and
// funnel-ledger consistency hold by construction — the seeding tests then pin
// what P3 adds on top: §5a CPA re-basing, spend-only construction, the currency
// and cadence gates, per-entry failure isolation with share renormalization, and
// the end-to-end totals identities.
import { describe, expect, it } from "vitest";
import {
  buildProjectEntries,
  cadencePlausibilityWarnings,
  currencyGateWarnings,
  resolveProject,
  resolveProjectFromCohortRows,
  runResolvedProject,
  type CohortRowLike,
  type ProjectAggregationPolicy,
  type ResolvedProject,
  type SharedCostPool,
} from "@/services/funnelEconomics";
import { assembleProjectSpendLedger } from "@/services/projectSpendLedger";

const JULY = { from: "2026-07-01", to: "2026-07-31" };
const AS_OF = "2026-09-15T00:00:00.000Z";
const POOL_SUM = 16_271.36;

function policy(over: Partial<ProjectAggregationPolicy> = {}): ProjectAggregationPolicy {
  return {
    spendBasis: "full_funnel_spend",
    includeUnknownFunnelSpend: true,
    includeOtherUnallocatedSpend: true,
    allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true },
    dayGridStep: "period_end",
    headlinePayback: "fully_loaded",
    bonus: { kind: "per_funnel" },
    assumedCadence: "monthly",
    rounding: { mode: "full_precision" },
    ...over,
  };
}

function sharedCosts(over: Partial<SharedCostPool> = {}): SharedCostPool {
  return {
    monthly: { ffBilling: 5_000, funnelConstructor: 2_271.36, payroll: 9_000 },
    proration: { mode: "calendar_prorated" },
    extras: [],
    ...over,
  };
}

/** alpha: 100 trials, $5,000 resolved ($4,500 via users + $500 historical);
 *  ghost: $1,000 resolved, zero users (spend_only);
 *  c-x:   $200 unknown-funnel spend. Source = $6,200. */
function ledgers() {
  return assembleProjectSpendLedger({
    spendRows: [
      { campaign_id: "c-a1", ad_account_id: "act_1", currency: "USD", campaign_name: "A1", spend: 2_250 },
      { campaign_id: "c-a2", ad_account_id: "act_1", currency: "USD", campaign_name: "A2", spend: 2_250 },
      { campaign_id: "c-a3", ad_account_id: "act_1", currency: "USD", campaign_name: "A3", spend: 500 },
      { campaign_id: "c-g1", ad_account_id: "act_9", currency: "USD", campaign_name: "G1", spend: 1_000 },
      { campaign_id: "c-x", ad_account_id: "act_7", currency: "USD", campaign_name: "X", spend: 200 },
    ],
    windowPathRows: [
      { campaign_id: "c-a1", campaign_path: "alpha", users: 60 },
      { campaign_id: "c-a2", campaign_path: "alpha", users: 40 },
    ],
    historicalPathRows: [
      { campaign_id: "c-a3", campaign_path: "alpha", users: 10 },
      { campaign_id: "c-g1", campaign_path: "ghost", users: 5 },
    ],
    knownGaps: [],
    window: JULY,
  });
}

function alphaRows(): CohortRowLike[] {
  return [
    {
      cohort_date: "2026-07-05", campaign_path: "alpha", trial_users: 60,
      first_subscription_users: 24, renewal_users_by_level: { 2: 12 },
      trial_revenue: 60, first_subscription_revenue: 720, gross_revenue: 1_500,
      amount_refunded: 30, fb_spend: 2_700,
    },
    {
      cohort_date: "2026-07-20", campaign_path: "alpha", trial_users: 40,
      first_subscription_users: 16, renewal_users_by_level: { 2: 8 },
      trial_revenue: 40, first_subscription_revenue: 480, gross_revenue: 1_000,
      amount_refunded: 20, fb_spend: 1_800,
    },
  ];
}

function resolveHappy(policyOver: Partial<ProjectAggregationPolicy> = {}): ResolvedProject {
  const { windowLedger, funnelLedgers } = ledgers();
  return resolveProjectFromCohortRows({
    window: JULY,
    asOf: AS_OF,
    rows: alphaRows(),
    windowLedger,
    funnelLedgers,
    sharedCosts: sharedCosts(),
    policy: policy({
      manualCommissionByGroup: {
        "facebook:act_9:USD": 0.04,
        "facebook:act_7:USD": 0.04,
      },
      ...policyOver,
    }),
  });
}

describe("buildProjectEntries", () => {
  it("trials → forecast, spend-without-trials → spend_only, budget on the spend basis", () => {
    const { funnelLedgers } = ledgers();
    const entries = buildProjectEntries({
      rows: alphaRows(), funnelLedgers, policy: policy(),
    });
    expect(entries.map((entry) => [entry.funnelId, entry.kind, entry.plannedBudget])).toEqual([
      ["alpha", "forecast", 5_000],
      ["ghost", "spend_only", 1_000],
    ]);
    expect(entries.every((entry) => entry.cadenceConfirmed === false)).toBe(true);
  });

  it("attributed_only basis sets the attributed budget and drops user-less funnels", () => {
    const { funnelLedgers } = ledgers();
    const entries = buildProjectEntries({
      rows: alphaRows(), funnelLedgers, policy: policy({ spendBasis: "attributed_only" }),
    });
    // ghost has zero attributed spend — nothing to cost on this basis.
    expect(entries.map((entry) => [entry.funnelId, entry.plannedBudget])).toEqual([["alpha", 4_500]]);
  });
});

describe("§5a CPA re-basing through the seeder (invariant 18)", () => {
  it("full basis: CPA includes waste; trials reproduce the observed count", () => {
    const resolved = resolveHappy();
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alpha.status.kind).toBe("ok");
    // CPA = resolved $5,000 / 100 observed trials — waste included.
    expect(alpha.frozen!.assumptions.traffic.targetCpa).toBeCloseTo(50, 10);
    expect(alpha.result!.metrics.trials).toBeCloseTo(100, 10);
    expect(alpha.evidence.cpaBasis).toBe("full_resolved");
  });

  it("attributed basis: lower CPA, SAME projected trials — trials never inflate with budget", () => {
    const resolved = resolveHappy({ spendBasis: "attributed_only" });
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alpha.status.kind).toBe("ok");
    // CPA = attributed $4,500 / 100 attributed trials (spend coverage 100%).
    expect(alpha.frozen!.assumptions.traffic.targetCpa).toBeCloseTo(45, 10);
    expect(alpha.result!.metrics.trials).toBeCloseTo(100, 10);
  });

  it("manual CPA outranks the ledger and is recorded as the basis", () => {
    const { windowLedger, funnelLedgers } = ledgers();
    const entries = buildProjectEntries({ rows: alphaRows(), funnelLedgers, policy: policy() })
      .map((entry) => (entry.funnelId === "alpha" ? { ...entry, manualSeeds: { targetCpa: 62.5 } } : entry));
    const resolved = resolveProject({
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      entries, sharedCosts: sharedCosts(),
      policy: policy({ manualCommissionByGroup: { "facebook:act_9:USD": 0.04, "facebook:act_7:USD": 0.04 } }),
    });
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alpha.frozen!.assumptions.traffic.targetCpa).toBe(62.5);
    expect(alpha.evidence.cpaBasis).toBe("manual");
  });

  it("no resolvable spend on the basis → blocked, excluded from shares and scope (invariant 13)", () => {
    const { windowLedger, funnelLedgers } = ledgers();
    delete funnelLedgers.alpha;
    const resolved = resolveProjectFromCohortRows({
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      sharedCosts: sharedCosts(), policy: policy(),
    });
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    // Without a ledger the auto-entry seeds budget 0 on the spend basis, so the
    // budget gate fires first — blocked either way, and never a silent zero.
    expect(alpha.status).toMatchObject({ kind: "blocked", path: "traffic.plannedBudget" });
    expect(resolved.shares.alpha).toBeUndefined();
    // Only ghost remains allocable; it carries the whole pool.
    expect(resolved.shares.ghost).toBe(1);
  });
});

describe("currency and cadence gates", () => {
  it("mixed-currency spend blocks the seeded CPA; a manual CPA unblocks", () => {
    const mixed = {
      funnelResolvedSpend: 3_000, userAttributedSpend: 3_000, noUserSpend: 0, spendCoverage: 1,
      groups: [], trafficCashOutflow: null,
      resolutionBasis: "user_attribution_only" as const, currency: null, currencyMixed: true,
    };
    expect(currencyGateWarnings(mixed).cpaSeedBlocked).toBe(true);

    const { windowLedger, funnelLedgers } = ledgers();
    funnelLedgers.alpha = { ...funnelLedgers.alpha, currency: null, currencyMixed: true };
    const blocked = resolveProjectFromCohortRows({
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      sharedCosts: sharedCosts(), policy: policy(),
    });
    const alpha = blocked.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alpha.status.kind).toBe("blocked");
    expect(alpha.evidence.warnings.some((warning) => warning.code === "spend_currency_mixed")).toBe(true);

    const entries = buildProjectEntries({ rows: alphaRows(), funnelLedgers, policy: policy() })
      .map((entry) => (entry.funnelId === "alpha" ? { ...entry, manualSeeds: { targetCpa: 50 } } : entry));
    const unblocked = resolveProject({
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      entries, sharedCosts: sharedCosts(), policy: policy(),
    });
    expect(unblocked.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!.status.kind).toBe("ok");
  });

  it("single non-USD currency seeds with a provisional warning", () => {
    const { windowLedger, funnelLedgers } = ledgers();
    funnelLedgers.alpha = { ...funnelLedgers.alpha, currency: "EUR" };
    const resolved = resolveProjectFromCohortRows({
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      sharedCosts: sharedCosts(), policy: policy(),
    });
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alpha.status.kind).toBe("ok");
    expect(alpha.evidence.warnings.some((warning) => warning.code === "spend_currency_non_usd")).toBe(true);
  });

  it("cadence_too_short fires on a structural level-2 zero among mature cohorts", () => {
    const warnings = cadencePlausibilityWarnings({
      actuals: {
        funnelId: "x", window: JULY, maturityDays: 70, trials: 100, spend: null, cpaActual: null,
        trialPriceActual: 1, subPriceActual: 30, firstPaidConversion: 0.4,
        renewalConversions: [0], observedRetentionDepth: 3,
        upsellTiersActual: [], tokenArpuPerTrialActual: null, refundRateActual: null,
        realizedRevenueByDay: [], realizedPaybackDay: null,
      },
      maturityDays: 70,
      periodDays: 7,
    });
    expect(warnings.map((warning) => warning.code)).toContain("cadence_too_short");
  });

  it("cadence_unobservable fires when a monthly cadence hides plausible weekly cycles", () => {
    const warnings = cadencePlausibilityWarnings({
      actuals: {
        funnelId: "x", window: JULY, maturityDays: 40, trials: 100, spend: null, cpaActual: null,
        trialPriceActual: 1, subPriceActual: 30, firstPaidConversion: 0.4,
        renewalConversions: [], observedRetentionDepth: 2,
        upsellTiersActual: [], tokenArpuPerTrialActual: null, refundRateActual: null,
        realizedRevenueByDay: [], realizedPaybackDay: null,
      },
      maturityDays: 40,
      periodDays: 30,
    });
    expect(warnings.map((warning) => warning.code)).toContain("cadence_unobservable");
  });

  it("a healthy monthly funnel raises neither cadence warning", () => {
    const resolved = resolveHappy();
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    const codes = alpha.evidence.warnings.map((warning) => warning.code);
    expect(codes).not.toContain("cadence_too_short");
    expect(codes).not.toContain("cadence_unobservable");
  });
});

describe("spend-only rows through the full chain (invariants 17, 23, 25)", () => {
  it("ghost carries cost, overhead share and a zero bonus with the reason", () => {
    const resolved = resolveHappy();
    const { rows, totals } = runResolvedProject(resolved);
    const ghost = rows.find((row) => row.funnelId === "ghost")!;
    expect(ghost.kind).toBe("spend_only");
    expect(ghost.trials).toBe(0);
    expect(ghost.trafficCashOutflow).toBeCloseTo(1_000 / 0.96, 6);
    expect(ghost.contributionProfit).toBeCloseTo(-1_000 / 0.96, 6);
    expect(ghost.performanceBonus).toBe(0);
    expect(ghost.bonusIneligibleReason).toBe("ineligible_no_conversions");
    // Overhead proportional to resolved spend: 1,000 / 6,000.
    expect(ghost.overheadShare).toBeCloseTo(1_000 / 6_000, 10);
    expect(ghost.allocatedOverhead).toBeCloseTo(POOL_SUM * (1_000 / 6_000), 6);
    expect(ghost.netProfit).toBeCloseTo(ghost.contributionProfit! - ghost.allocatedOverhead, 6);
    // Total overhead still equals the pool across BOTH kinds (invariant 24).
    const overheadSum = rows.reduce((sum, row) => sum + row.allocatedOverhead, 0);
    expect(Math.abs(overheadSum - POOL_SUM)).toBeLessThan(0.01);
    expect(totals.gates.map((gate) => gate.code)).not.toContain("overhead_identity");
  });

  it("an unresolved spend-only commission nulls the project outflow and gates paybacks (invariant 27)", () => {
    const resolved = resolveHappy({ manualCommissionByGroup: { "facebook:act_7:USD": 0.04 } });
    const { rows, totals } = runResolvedProject(resolved);
    const ghost = rows.find((row) => row.funnelId === "ghost")!;
    expect(ghost.trafficCashOutflow).toBeNull();
    expect(totals.trafficCashOutflow).toBeNull();
    expect(totals.paybackFullyLoadedDay).toBeNull();
    expect(totals.gates.map((gate) => gate.code)).toContain("unresolved_commission");
  });
});

describe("failure isolation and the share fixpoint (invariants 7, 8 at seed level)", () => {
  it("an entry the engine rejects becomes blocked; survivors re-share to Σ = pool", () => {
    const { windowLedger, funnelLedgers } = ledgers();
    const entries = buildProjectEntries({ rows: alphaRows(), funnelLedgers, policy: policy() })
      .map((entry) => (entry.funnelId === "alpha"
        ? { ...entry, overrides: { costs: { stripeCommission: 1.5 } } }   // engine: must be < 1
        : entry));
    const resolved = resolveProject({
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      entries, sharedCosts: sharedCosts(),
      policy: policy({ manualCommissionByGroup: { "facebook:act_9:USD": 0.04, "facebook:act_7:USD": 0.04 } }),
    });
    const alpha = resolved.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alpha.status.kind).toBe("blocked");
    expect(resolved.shares.ghost).toBe(1);
    const { rows } = runResolvedProject(resolved);
    expect(rows.map((row) => row.funnelId)).toEqual(["ghost"]);
    expect(Math.abs(rows[0].allocatedOverhead - POOL_SUM)).toBeLessThan(0.01);
  });

  it("disabling a funnel renormalizes shares without mutating other resolutions (invariant 7)", () => {
    const { windowLedger, funnelLedgers } = ledgers();
    const baseEntries = buildProjectEntries({ rows: alphaRows(), funnelLedgers, policy: policy() });
    const withGhostDisabled = baseEntries.map((entry) =>
      entry.funnelId === "ghost" ? { ...entry, enabled: false } : entry);
    const common = {
      window: JULY, asOf: AS_OF, rows: alphaRows(), windowLedger, funnelLedgers,
      sharedCosts: sharedCosts(),
      policy: policy({ manualCommissionByGroup: { "facebook:act_9:USD": 0.04, "facebook:act_7:USD": 0.04 } }),
    };
    const both = resolveProject({ ...common, entries: baseEntries });
    const one = resolveProject({ ...common, entries: withGhostDisabled });

    expect(one.resolutions.find((resolution) => resolution.entry.funnelId === "ghost")!.status.kind).toBe("disabled");
    expect(one.shares.alpha).toBe(1);
    // Alpha's frozen inputs differ ONLY in the overhead share/fixed stamps —
    // the seeded assumptions themselves are untouched by ghost's exclusion.
    const alphaBoth = both.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    const alphaOne = one.resolutions.find((resolution) => resolution.entry.funnelId === "alpha")!;
    expect(alphaOne.frozen!.assumptions.traffic).toEqual(alphaBoth.frozen!.assumptions.traffic);
    expect(alphaOne.frozen!.assumptions.retention).toEqual(alphaBoth.frozen!.assumptions.retention);
    // Ghost's spend moves out of the project scope.
    expect(one.scope.inProjectResolvedSpend).toBeCloseTo(5_000, 6);
    expect(one.scope.outOfProjectSpend).toBeCloseTo(1_000, 6);
    expect(both.scope.inProjectResolvedSpend).toBeCloseTo(6_000, 6);
  });
});

describe("end-to-end totals (1-forecast + 1-spend-only project)", () => {
  it("identities hold and the headline payback is fully loaded", () => {
    const resolved = resolveHappy();
    const { rows, totals } = runResolvedProject(resolved);
    expect(rows).toHaveLength(2);
    const netFromRows = rows.reduce((sum, row) => sum + row.netProfit, 0);
    expect(totals.netProfit).toBeCloseTo(netFromRows, 6);
    expect(totals.allocatedOverhead).toBeCloseTo(POOL_SUM, 2);
    expect(totals.projectScopedSpend).toBeCloseTo(6_200, 6);
    expect(totals.spendCoverage).toBeCloseTo(1, 6);
    // Unknown $200 is included in the outflow but belongs to NO row (invariant 20).
    const rowOutflow = rows.reduce((sum, row) => sum + (row.trafficCashOutflow ?? 0), 0);
    expect(totals.trafficCashOutflow!).toBeCloseTo(rowOutflow + 200 / 0.96, 6);
    expect(totals.headlinePaybackDay).toBe(totals.paybackFullyLoadedDay);
  });

  it("resolution is deterministic under shuffled rows and entries", () => {
    const first = runResolvedProject(resolveHappy());
    const { windowLedger, funnelLedgers } = ledgers();
    const shuffledRows = [...alphaRows()].reverse();
    const entries = buildProjectEntries({ rows: shuffledRows, funnelLedgers, policy: policy() }).reverse();
    const second = runResolvedProject(resolveProject({
      window: JULY, asOf: AS_OF, rows: shuffledRows, windowLedger, funnelLedgers,
      entries, sharedCosts: sharedCosts(),
      policy: policy({ manualCommissionByGroup: { "facebook:act_9:USD": 0.04, "facebook:act_7:USD": 0.04 } }),
    }));
    expect(second.totals).toEqual(first.totals);
    expect(second.rows).toEqual(first.rows);
  });
});
