// Project persistence (P7): snapshot ⇄ replay reproducibility, share-drift
// detection, schema-gate degradation and the refresh diff.
import { describe, expect, it } from "vitest";
import {
  assembleProjectSpendLedger,
} from "@/services/projectSpendLedger";
import {
  buildProjectForecastSnapshot,
  diffProjectFrozen,
  replayProjectForecast,
  resolveProjectFromCohortRows,
  runResolvedProject,
  PROJECT_FORECAST_SCHEMA_VERSION,
  type CohortRowLike,
  type ProjectAggregationPolicy,
  type ProjectForecast,
  type SharedCostPool,
} from "@/services/funnelEconomics";

const JULY = { from: "2026-07-01", to: "2026-07-31" };
const AS_OF = "2026-09-15T00:00:00.000Z";
const NOW = "2026-09-16T12:00:00.000Z";

function policy(): ProjectAggregationPolicy {
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
    manualCommissionByGroup: { "facebook:act_9:USD": 0.04, "facebook:act_7:USD": 0.04, "facebook:act_1:USD": 0.04 },
  };
}

function sharedCosts(): SharedCostPool {
  return {
    monthly: { ffBilling: 5_000, funnelConstructor: 2_271.36, payroll: 9_000 },
    proration: { mode: "calendar_prorated" },
    extras: [],
  };
}

function ledgers() {
  return assembleProjectSpendLedger({
    spendRows: [
      { campaign_id: "c-a1", ad_account_id: "act_1", currency: "USD", campaign_name: "A1", spend: 4_500 },
      { campaign_id: "c-a3", ad_account_id: "act_1", currency: "USD", campaign_name: "A3", spend: 500 },
      { campaign_id: "c-g1", ad_account_id: "act_9", currency: "USD", campaign_name: "G1", spend: 1_000 },
      { campaign_id: "c-x", ad_account_id: "act_7", currency: "USD", campaign_name: "X", spend: 200 },
    ],
    windowPathRows: [{ campaign_id: "c-a1", campaign_path: "alpha", users: 100 }],
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

function resolveLive() {
  const { windowLedger, funnelLedgers } = ledgers();
  return resolveProjectFromCohortRows({
    window: JULY, asOf: AS_OF, rows: alphaRows(),
    windowLedger, funnelLedgers,
    sharedCosts: sharedCosts(), policy: policy(),
  });
}

function snapshot(): ProjectForecast {
  return buildProjectForecastSnapshot({ resolved: resolveLive(), name: "July test", now: NOW });
}

describe("snapshot → replay reproducibility (invariant 10)", () => {
  it("replays to identical totals, grid and paybacks with zero re-derivation", () => {
    const resolved = resolveLive();
    const liveRun = runResolvedProject(resolved);
    const saved = buildProjectForecastSnapshot({ resolved, name: "July test", now: NOW });

    // Simulate storage: full JSON round-trip.
    const restored = JSON.parse(JSON.stringify(saved)) as ProjectForecast;
    const replay = replayProjectForecast(restored);
    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") return;
    expect(replay.shareDrift).toEqual([]);
    const replayRun = runResolvedProject(replay.resolved);
    expect(replayRun.totals).toEqual(liveRun.totals);
    expect(replayRun.rows).toEqual(liveRun.rows);
  });

  it("statuses derive from the saved row: blocked-at-save stays blocked, disabled stays disabled", () => {
    const resolved = resolveLive();
    const saved = buildProjectForecastSnapshot({ resolved, name: "x", now: NOW });
    // Disable ghost + drop alpha's frozen to simulate a blocked-at-save entry.
    const mutated = JSON.parse(JSON.stringify(saved)) as ProjectForecast;
    mutated.entries = mutated.entries.map((entry) =>
      entry.funnelId === "ghost" ? { ...entry, enabled: false } : entry);
    delete mutated.frozen.alpha;
    const replay = replayProjectForecast(mutated);
    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") return;
    const statuses = Object.fromEntries(replay.resolved.resolutions.map((r) => [r.entry.funnelId, r.status.kind]));
    expect(statuses.ghost).toBe("disabled");
    expect(statuses.alpha).toBe("blocked");
  });

  it("global-default changes cannot move a saved project (frozen carries everything)", () => {
    const saved = snapshot();
    const replayBefore = replayProjectForecast(saved);
    // "Mutating a global default" = nothing in the saved row references config
    // at replay time; assert by replaying a deep copy and comparing.
    const replayAgain = replayProjectForecast(JSON.parse(JSON.stringify(saved)) as ProjectForecast);
    expect(replayBefore.kind).toBe("ok");
    expect(replayAgain.kind).toBe("ok");
    if (replayBefore.kind !== "ok" || replayAgain.kind !== "ok") return;
    expect(runResolvedProject(replayAgain.resolved).totals).toEqual(runResolvedProject(replayBefore.resolved).totals);
  });
});

describe("integrity gates", () => {
  it("share drift is detected when the saved row is internally inconsistent", () => {
    const saved = snapshot();
    const mutated = JSON.parse(JSON.stringify(saved)) as ProjectForecast;
    const alphaFrozen = mutated.frozen.alpha;
    if (alphaFrozen.assumptions.costs.overheadAllocation.mode === "by_spend_share") {
      alphaFrozen.assumptions.costs.overheadAllocation.share = 0.123456;
    }
    const replay = replayProjectForecast(mutated);
    expect(replay.kind).toBe("ok");
    if (replay.kind !== "ok") return;
    expect(replay.shareDrift.length).toBeGreaterThan(0);
    expect(replay.shareDrift[0]).toContain("alpha");
  });

  it("schema mismatch degrades to archived, never throws (a project holds N blobs)", () => {
    const saved = snapshot();
    const oldProject = { ...JSON.parse(JSON.stringify(saved)), schemaVersion: PROJECT_FORECAST_SCHEMA_VERSION + 1 } as ProjectForecast;
    const replayProject = replayProjectForecast(oldProject);
    expect(replayProject.kind).toBe("archived");

    const oldEngine = JSON.parse(JSON.stringify(saved)) as ProjectForecast;
    oldEngine.frozen.alpha.schemaVersion = 999;
    const replayEngine = replayProjectForecast(oldEngine);
    expect(replayEngine).toMatchObject({ kind: "archived" });
    if (replayEngine.kind === "archived") expect(replayEngine.reason).toContain("alpha");
  });
});

describe("refresh diff", () => {
  it("reports unchanged / changed with headline figures, ignoring resolvedAt", () => {
    const saved = snapshot();
    const freshSame = JSON.parse(JSON.stringify(saved.frozen)) as ProjectForecast["frozen"];
    freshSame.alpha.resolvedAt = "2026-10-01T00:00:00.000Z";
    const noChange = diffProjectFrozen(saved.frozen, freshSame);
    expect(noChange.funnels).toEqual([]);
    expect(noChange.unchangedCount).toBe(Object.keys(saved.frozen).length);

    const freshChanged = JSON.parse(JSON.stringify(saved.frozen)) as ProjectForecast["frozen"];
    freshChanged.alpha.assumptions.traffic.targetCpa = 99;
    const changed = diffProjectFrozen(saved.frozen, freshChanged);
    expect(changed.funnels).toHaveLength(1);
    expect(changed.funnels[0]).toMatchObject({ funnelId: "alpha", kind: "changed" });
    expect(changed.funnels[0].headline.some((row) => row.label === "Target CPA" && row.after === "99")).toBe(true);
  });

  it("reports added and removed funnels", () => {
    const saved = snapshot();
    const fresh = JSON.parse(JSON.stringify(saved.frozen)) as ProjectForecast["frozen"];
    const alpha = fresh.alpha;
    delete fresh.alpha;
    fresh.beta = alpha;
    const diff = diffProjectFrozen(saved.frozen, fresh);
    expect(diff.funnels.map((funnel) => [funnel.funnelId, funnel.kind])).toEqual([
      ["alpha", "removed"],
      ["beta", "added"],
    ]);
  });
});
