// Project contracts and resolver math (P1, rev. 3 spec §17 invariants 8, 16, 18–28 subset).
//
// Everything here is pure-data math: spend groups, ledgers, scoping, proration,
// shares, CPA re-basing, bonus policy, provisional flags. Engine-composition
// invariants live in funnelEconomicsProjectAggregate.test.ts.
import { describe, expect, it } from "vitest";
import {
  ForecastInputError,
  applyManualCommissions,
  assertBonusPolicySupported,
  buildSpendBucket,
  calendarProrationMonths,
  computeOverheadShares,
  deriveProvisionalFlags,
  groupTrafficCashOutflow,
  prorateSharedCostPool,
  rebaseCpaSeed,
  scopeProjectSpend,
  spendGroupKey,
  verifyWindowSpendIdentity,
  type FunnelSpendLedger,
  type SharedCostPool,
  type SpendGroup,
  type WindowSpendLedger,
} from "@/services/funnelEconomics";

function group(over: Partial<SpendGroup> = {}): SpendGroup {
  const spend = over.spend ?? 1000;
  const commission = over.trafficCommission === undefined ? 0.04 : over.trafficCommission;
  return {
    trafficChannel: "facebook",
    adAccountId: "act_1",
    currency: "USD",
    spend,
    trafficCommission: commission,
    trafficCashOutflow: commission === null ? null : spend / (1 - commission),
    ...over,
  };
}

function bucketOf(...groups: SpendGroup[]) {
  return buildSpendBucket(groups);
}

function windowLedger(over: Partial<WindowSpendLedger> = {}): WindowSpendLedger {
  // Balanced by construction: 10,000 = 7,000 attributed + 1,500 noUser + 1,200 unknown + 300 other.
  return {
    windowSourceSpend: 10_000,
    funnelResolved: bucketOf(group({ spend: 8_500 })),
    userAttributed: bucketOf(group({ spend: 7_000 })),
    noUser: bucketOf(group({ spend: 1_500 })),
    unknownFunnel: bucketOf(group({ spend: 1_200, adAccountId: "act_2" })),
    otherUnallocated: bucketOf(group({ spend: 300, adAccountId: "act_3" })),
    knownGapDays: [],
    spendIncomplete: false,
    ...over,
  };
}

function funnelLedger(resolved: number, attributed: number, over: Partial<FunnelSpendLedger> = {}): FunnelSpendLedger {
  return {
    funnelResolvedSpend: resolved,
    userAttributedSpend: attributed,
    noUserSpend: resolved - attributed,
    spendCoverage: resolved > 0 ? attributed / resolved : null,
    groups: [group({ spend: resolved })],
    trafficCashOutflow: resolved / (1 - 0.04),
    resolutionBasis: "historical_campaign_path",
    currency: "USD",
    currencyMixed: false,
    ...over,
  };
}

describe("spend groups (rev. 3 correction 4)", () => {
  it("invariant 26: multi-group unresolved spend sums per-group outflows, never one global rate", () => {
    const bucket = bucketOf(
      group({ spend: 1000, trafficCommission: 0.04 }),
      group({ spend: 2000, trafficCommission: 0.06, currency: "EUR" }),
      group({ spend: 500, trafficCommission: 0.04, adAccountId: "act_9" }),
    );
    const expected = 1000 / 0.96 + 2000 / 0.94 + 500 / 0.96;
    expect(bucket.trafficCashOutflow).toBeCloseTo(expected, 6);
    // The single-rate shortcut would be wrong by a real margin:
    expect(Math.abs((bucket.trafficCashOutflow ?? 0) - 3500 / 0.96)).toBeGreaterThan(0.4);
  });

  it("invariant 27: an unresolved commission propagates null — no silent fallback", () => {
    const bucket = bucketOf(
      group({ spend: 1000, trafficCommission: 0.04 }),
      group({ spend: 700, trafficCommission: null, adAccountId: "act_7" }),
    );
    expect(bucket.trafficCashOutflow).toBeNull();
    expect(bucket.unresolvedCommissionSpend).toBe(700);
    expect(bucket.spend).toBe(1700);
  });

  it("invariant 27 (resolution): a manual per-group commission resolves it; keys are stable", () => {
    const unresolved = group({ spend: 700, trafficCommission: null, trafficCashOutflow: null, adAccountId: "act_7" });
    expect(spendGroupKey(unresolved)).toBe("facebook:act_7:USD");
    const patched = applyManualCommissions([unresolved], { "facebook:act_7:USD": 0.05 });
    expect(patched[0].trafficCommission).toBe(0.05);
    expect(patched[0].trafficCashOutflow).toBeCloseTo(700 / 0.95, 6);
    // Absent key stays unresolved; input is not mutated.
    const untouched = applyManualCommissions([unresolved], {});
    expect(untouched[0].trafficCommission).toBeNull();
    expect(unresolved.trafficCommission).toBeNull();
  });

  it("rejects a commission outside [0, 1)", () => {
    expect(() => groupTrafficCashOutflow(100, 1)).toThrow(ForecastInputError);
    expect(() => groupTrafficCashOutflow(100, -0.1)).toThrow(ForecastInputError);
  });
});

describe("window reconciliation (invariant 16)", () => {
  it("the balanced ledger passes both identities", () => {
    const check = verifyWindowSpendIdentity(windowLedger());
    expect(check.ok).toBe(true);
    expect(Math.abs(check.sourceDelta)).toBeLessThan(0.01);
    expect(Math.abs(check.resolvedDelta)).toBeLessThan(0.01);
  });

  it("an unbalanced ledger is reported with the exact deltas — never smoothed over", () => {
    const check = verifyWindowSpendIdentity(windowLedger({ windowSourceSpend: 10_500 }));
    expect(check.ok).toBe(false);
    expect(check.sourceDelta).toBeCloseTo(500, 6);
  });
});

describe("project scoping (invariants 21–22)", () => {
  const ledgers = {
    a: funnelLedger(5_000, 4_200),
    b: funnelLedger(3_500, 2_800),
  };

  it("invariant 21: deselecting a funnel moves its spend to out_of_project; the window still balances", () => {
    const both = scopeProjectSpend({
      windowLedger: windowLedger(),
      funnelLedgers: ledgers,
      enabledFunnelIds: ["a", "b"],
      includeUnknownFunnelSpend: true,
      includeOtherUnallocatedSpend: true,
    });
    expect(both.inProjectResolvedSpend).toBe(8_500);
    expect(both.outOfProjectSpend).toBe(0);
    expect(both.projectScopedSpend).toBe(8_500 + 1_200 + 300);

    const onlyA = scopeProjectSpend({
      windowLedger: windowLedger(),
      funnelLedgers: ledgers,
      enabledFunnelIds: ["a"],
      includeUnknownFunnelSpend: true,
      includeOtherUnallocatedSpend: true,
    });
    expect(onlyA.inProjectResolvedSpend).toBe(5_000);
    expect(onlyA.outOfProjectSpend).toBe(3_500);
    expect(onlyA.projectScopedSpend).toBe(both.projectScopedSpend - 3_500);
    // The window itself is untouched by selection — reconciliation still balances.
    expect(onlyA.windowSourceSpend).toBe(both.windowSourceSpend);
    expect(verifyWindowSpendIdentity(windowLedger()).ok).toBe(true);
  });

  it("unresolved-spend policy flags include or exclude the unknown buckets", () => {
    const excluded = scopeProjectSpend({
      windowLedger: windowLedger(),
      funnelLedgers: ledgers,
      enabledFunnelIds: ["a", "b"],
      includeUnknownFunnelSpend: false,
      includeOtherUnallocatedSpend: false,
    });
    expect(excluded.includedUnresolvedSpend).toBe(0);
    expect(excluded.projectScopedSpend).toBe(8_500);
    expect(excluded.includedUnresolvedOutflow).toBe(0);
  });

  it("an unresolved commission inside an INCLUDED bucket nulls the unresolved outflow", () => {
    const ledger = windowLedger({
      unknownFunnel: bucketOf(group({ spend: 1_200, trafficCommission: null, trafficCashOutflow: null, adAccountId: "act_x" })),
    });
    const scope = scopeProjectSpend({
      windowLedger: ledger,
      funnelLedgers: ledgers,
      enabledFunnelIds: ["a", "b"],
      includeUnknownFunnelSpend: true,
      includeOtherUnallocatedSpend: true,
    });
    expect(scope.includedUnresolvedOutflow).toBeNull();
    expect(scope.unresolvedCommissionSpend).toBe(1_200);
  });
});

describe("overhead pool proration (invariant 19)", () => {
  const pool: SharedCostPool = {
    monthly: { ffBilling: 5000, funnelConstructor: 2271.36, payroll: 9000 },
    proration: { mode: "calendar_prorated" },
    extras: [],
  };

  it("a full calendar month charges exactly one pool", () => {
    expect(calendarProrationMonths({ from: "2026-07-01", to: "2026-07-31" })).toBeCloseTo(1, 12);
    expect(prorateSharedCostPool(pool, { from: "2026-07-01", to: "2026-07-31" })).toBeCloseTo(16_271.36, 6);
  });

  it("a half window prorates by days", () => {
    expect(calendarProrationMonths({ from: "2026-07-01", to: "2026-07-15" })).toBeCloseTo(15 / 31, 12);
  });

  it("a 45-day window spanning two months sums per-month fractions", () => {
    expect(calendarProrationMonths({ from: "2026-07-01", to: "2026-08-14" })).toBeCloseTo(31 / 31 + 14 / 31, 12);
  });

  it("February is not a 30-day month", () => {
    expect(calendarProrationMonths({ from: "2026-02-01", to: "2026-02-28" })).toBeCloseTo(1, 12);
  });

  it("manual and excluded modes override the calendar", () => {
    expect(prorateSharedCostPool({ ...pool, proration: { mode: "excluded" } }, { from: "2026-07-01", to: "2026-07-31" })).toBe(0);
    expect(prorateSharedCostPool({ ...pool, proration: { mode: "manual", manualAmount: 1234 } }, { from: "2026-07-01", to: "2026-07-31" })).toBe(1234);
    expect(prorateSharedCostPool({ ...pool, proration: { mode: "full_month" } }, { from: "2026-07-10", to: "2026-07-12" })).toBeCloseTo(16_271.36, 6);
  });

  it("rejects an inverted window", () => {
    expect(() => calendarProrationMonths({ from: "2026-07-31", to: "2026-07-01" })).toThrow(ForecastInputError);
  });
});

describe("overhead shares (invariants 8, 23, 24 groundwork)", () => {
  it("shares are exact fractions summing to 1 to the last ulp", () => {
    const shares = computeOverheadShares(
      [
        { funnelId: "a", kind: "forecast", spendBasisValue: 1000, projectedTrials: 20 },
        { funnelId: "b", kind: "forecast", spendBasisValue: 2000, projectedTrials: 40 },
        { funnelId: "c", kind: "forecast", spendBasisValue: 7000, projectedTrials: 140 },
      ],
      { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } },
    );
    expect(shares.a).toBeCloseTo(0.1, 12);
    expect(shares.b).toBeCloseTo(0.2, 12);
    expect(shares.c).toBeCloseTo(0.7, 12);
    expect(shares.a + shares.b + shares.c).toBe(1);
  });

  it("invariant 23 groundwork: spend_only rows participate in the spend-share basis", () => {
    const shares = computeOverheadShares(
      [
        { funnelId: "forecast-a", kind: "forecast", spendBasisValue: 8000, projectedTrials: 160 },
        { funnelId: "spendonly-b", kind: "spend_only", spendBasisValue: 2000, projectedTrials: 0 },
      ],
      { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } },
    );
    expect(shares["spendonly-b"]).toBeCloseTo(0.2, 12);
    expect(shares["spendonly-b"]).toBeGreaterThan(0);
  });

  it("largest-remainder keeps Σ === 1 for irrational splits across 7 rows", () => {
    const rows = Array.from({ length: 7 }, (_, index) => ({
      funnelId: `f${index}`,
      kind: "forecast" as const,
      spendBasisValue: Math.SQRT2 * (index + 1) * 997.13,
      projectedTrials: 10,
    }));
    const shares = computeOverheadShares(rows, {
      allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true },
    });
    const sum = Object.values(shares).reduce((total, value) => total + value, 0);
    expect(sum).toBe(1);
    for (const value of Object.values(shares)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("trial_share ignores spend_only rows (they have no projected trials)", () => {
    const shares = computeOverheadShares(
      [
        { funnelId: "a", kind: "forecast", spendBasisValue: 100, projectedTrials: 30 },
        { funnelId: "b", kind: "forecast", spendBasisValue: 100, projectedTrials: 10 },
        { funnelId: "s", kind: "spend_only", spendBasisValue: 500, projectedTrials: 0 },
      ],
      { allocation: { basis: "trial_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } },
    );
    expect(shares.a).toBeCloseTo(0.75, 12);
    expect(shares.b).toBeCloseTo(0.25, 12);
    expect(shares.s).toBe(0);
  });

  it("a zero denominator throws loudly instead of silently allocating nothing", () => {
    expect(() =>
      computeOverheadShares(
        [{ funnelId: "a", kind: "forecast", spendBasisValue: 0, projectedTrials: 0 }],
        { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } },
      ),
    ).toThrow(ForecastInputError);
  });

  it("is deterministic under input order", () => {
    const rows = [
      { funnelId: "b", kind: "forecast" as const, spendBasisValue: 2000, projectedTrials: 40 },
      { funnelId: "a", kind: "forecast" as const, spendBasisValue: 1000, projectedTrials: 20 },
    ];
    const forward = computeOverheadShares(rows, { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } });
    const reversed = computeOverheadShares([...rows].reverse(), { allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true } });
    expect(forward).toEqual(reversed);
  });
});

describe("CPA re-basing (invariant 18 — the §5a trap)", () => {
  const ledger = { funnelResolvedSpend: 10_000, userAttributedSpend: 7_600 };

  it("budget and CPA share one basis, so projected trials reproduce observed trials", () => {
    const full = rebaseCpaSeed({ mode: "full_funnel_spend", ledger, observedTrials: 200, attributedTrials: 190 })!;
    const attributed = rebaseCpaSeed({ mode: "attributed_only", ledger, observedTrials: 200, attributedTrials: 190 })!;
    // trials = budget / cpa reproduces the observed count in BOTH modes…
    expect(full.plannedBudget / full.targetCpaSeed).toBeCloseTo(200, 9);
    expect(attributed.plannedBudget / attributed.targetCpaSeed).toBeCloseTo(190, 9);
    // …and the full basis carries the honest, higher CPA (waste included).
    expect(full.targetCpaSeed).toBeCloseTo(50, 9);
    expect(attributed.targetCpaSeed).toBeCloseTo(40, 9);
    expect(full.targetCpaSeed).toBeGreaterThan(attributed.targetCpaSeed);
  });

  it("missing spend or trials yields null — never a zero seed", () => {
    expect(rebaseCpaSeed({ mode: "full_funnel_spend", ledger: { funnelResolvedSpend: null, userAttributedSpend: null }, observedTrials: 10, attributedTrials: 10 })).toBeNull();
    expect(rebaseCpaSeed({ mode: "full_funnel_spend", ledger, observedTrials: 0, attributedTrials: 0 })).toBeNull();
  });
});

describe("bonus policy contract (invariant 20)", () => {
  it("v1 kinds pass; unimplemented kinds throw explicitly, never a silent 0", () => {
    expect(() => assertBonusPolicySupported({ kind: "per_funnel" })).not.toThrow();
    expect(() => assertBonusPolicySupported({ kind: "disabled" })).not.toThrow();
    expect(() => assertBonusPolicySupported({ kind: "per_buyer" })).toThrow(/not implemented in v1/);
    expect(() => assertBonusPolicySupported({ kind: "portfolio_wide" })).toThrow(/not implemented in v1/);
  });
});

describe("provisional flags (invariant 28 groundwork)", () => {
  it("known gaps, attributed-only mode, unresolved commissions and assumed cadences are all carried", () => {
    const ledger = windowLedger({
      knownGapDays: [{ date: "2026-07-03", reference: "FB-GAP-114", note: "no warehouse rows" }],
      spendIncomplete: true,
      unknownFunnel: bucketOf(group({ spend: 1_200, trafficCommission: null, trafficCashOutflow: null, adAccountId: "act_x" })),
    });
    const scope = scopeProjectSpend({
      windowLedger: ledger,
      funnelLedgers: { a: funnelLedger(5_000, 4_200) },
      enabledFunnelIds: ["a"],
      includeUnknownFunnelSpend: true,
      includeOtherUnallocatedSpend: true,
    });
    const flags = deriveProvisionalFlags({
      windowLedger: ledger,
      scope,
      policy: { spendBasis: "attributed_only" },
      entries: [
        { enabled: true, cadenceConfirmed: false, plannedBudget: 3_000 },
        { enabled: true, cadenceConfirmed: true, plannedBudget: 7_000 },
        { enabled: false, cadenceConfirmed: false, plannedBudget: 99_000 },
      ],
    });
    expect(flags.spendIncomplete).toBe(true);
    expect(flags.attributedOnlyMode).toBe(true);
    expect(flags.unresolvedCommission).toBe(true);
    expect(flags.unconfirmedCadenceBudgetShare).toBeCloseTo(0.3, 12);

    // Invariant 28: the whole ledger survives a JSON round-trip with nulls intact —
    // missing spend is never coerced to zero by (de)serialization.
    const revived = JSON.parse(JSON.stringify(ledger)) as WindowSpendLedger;
    expect(revived.unknownFunnel.trafficCashOutflow).toBeNull();
    expect(revived.knownGapDays[0].reference).toBe("FB-GAP-114");
    expect(revived.spendIncomplete).toBe(true);
  });
});
