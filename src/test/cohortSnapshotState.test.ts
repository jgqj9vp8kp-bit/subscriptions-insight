// Cohort snapshot state and the Phase-2 freshness rules (spec §3.1).
//
// restrictedSnapshotReadiness is what stands between a funnel-restricted
// member and a stale or half-validated materialization: every failure reason
// is pinned here, in the documented order, and so is the property that matters
// operationally — a rebuild in progress (status 'building' / 'failed', which
// overwrite status and diagnostics) does NOT 409 the buyers while the active
// versions are still valid.
import { describe, expect, it } from "vitest";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  COHORT_SNAPSHOT_NAME,
  SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT,
  activeCohortSnapshotVersion,
  activePairBeingRebuilt,
  activeSnapshotCurrent,
  getCohortSnapshotState,
  isCompleteValidatedCohortSnapshot,
  restrictedSnapshotReadiness,
  validationPassed,
  type CohortSnapshotState,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const HOUR = 3_600_000;
const MAX = SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT * HOUR;
const PASS = { status: "PASS", duplicate_users: 0, dynamic_users: 10, materialized_users: 10 };

function readyState(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  return {
    auth_user_id: "11111111-1111-4111-8111-111111111111",
    snapshot_name: COHORT_SNAPSHOT_NAME,
    status: "completed",
    active_warehouse_version: "wh_active",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-06T10:00:00.000Z",
    building_warehouse_version: null,
    building_classification_version: null,
    started_at: null,
    finished_at: "2026-10-06T10:00:00.000Z",
    duration_ms: 1000,
    users_classified: 10,
    rows_inserted: 10,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: 100,
    source_unique_users: 10,
    last_error: null,
    diagnostics: { validation: PASS },
    active_validation: PASS,
    active_validated_at: "2026-10-06T10:00:00.000Z",
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
    fresh_verified_at: "2026-10-06T11:45:00.000Z",
    stale_since: null,
    ...overrides,
  };
}

const check = (state: CohortSnapshotState | null, needsCampaignScope = false, maxStalenessMs = MAX) =>
  restrictedSnapshotReadiness(state, { now: NOW, maxStalenessMs, needsCampaignScope });

describe("constants", () => {
  it("pins the names the migration, the rebuild and the corpus rely on", () => {
    expect(COHORT_SNAPSHOT_NAME).toBe("fact_user_cohorts");
    expect(COHORT_CLASSIFICATION_VERSION).toBe("cohort_classifier_v3_platform");
    expect(CAMPAIGN_SCOPE_VERSION).toBe("campaign_scope_v1");
    expect(SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT).toBe(6);
  });
});

describe("restrictedSnapshotReadiness", () => {
  it("accepts a fresh, validated active snapshot and exposes its versions", () => {
    const result = check(readyState({ stale_since: "2026-10-06T11:50:00.000Z" }), true);
    expect(result.ok).toBe(true);
    if (result.ok !== true) return;
    expect(result.snapshot).toMatchObject({
      warehouseVersion: "wh_active",
      classificationVersion: COHORT_CLASSIFICATION_VERSION,
      campaignScopeReady: true,
      freshVerifiedAt: "2026-10-06T11:45:00.000Z",
      staleSince: "2026-10-06T11:50:00.000Z",
    });
    expect(Object.isFrozen(result.snapshot)).toBe(true);
    expect(Object.isFrozen(result.snapshot.state)).toBe(true);
  });

  it.each([
    ["no row", null, "no_active_snapshot"],
    ["no active warehouse version", readyState({ active_warehouse_version: null }), "no_active_snapshot"],
    ["no active classification", readyState({ active_classification_version: "" }), "no_active_snapshot"],
    ["an older classifier", readyState({ active_classification_version: "cohort_classifier_v2" }), "classification_mismatch"],
    ["no active validation (pre-backfill row)", readyState({ active_validation: null }), "not_validated"],
    ["a FAIL validation", readyState({ active_validation: { status: "FAIL" } }), "not_validated"],
    ["validation with duplicates", readyState({ active_validation: { status: "PASS", duplicate_users: 2 } }), "not_validated"],
    ["validation with a user-count mismatch", readyState({ active_validation: { status: "PASS", dynamic_users: 10, materialized_users: 9 } }), "not_validated"],
    ["duplicate users on the active build", readyState({ duplicate_users: 1 }), "not_validated"],
    ["duplicate users unknown", readyState({ duplicate_users: null as unknown as number }), "not_validated"],
    ["never verified fresh", readyState({ fresh_verified_at: null }), "stale"],
    ["verified 6h01m ago", readyState({ fresh_verified_at: "2026-10-06T05:59:00.000Z" }), "stale"],
    ["an unparseable timestamp", readyState({ fresh_verified_at: "yesterday-ish" }), "stale"],
  ] as const)("refuses %s → %s", (_label, state, reason) => {
    expect(check(state as CohortSnapshotState | null)).toEqual({ ok: false, reason });
  });

  it("checks in the documented order (first failing rule wins)", () => {
    const everything = readyState({
      active_classification_version: "old",
      active_validation: null,
      active_campaign_scope_version: null,
      fresh_verified_at: null,
    });
    expect(check(everything, true)).toEqual({ ok: false, reason: "classification_mismatch" });
    expect(check({ ...everything, active_classification_version: COHORT_CLASSIFICATION_VERSION }, true)).toEqual({ ok: false, reason: "not_validated" });
    expect(check({ ...everything, active_classification_version: COHORT_CLASSIFICATION_VERSION, active_validation: PASS }, true))
      .toEqual({ ok: false, reason: "campaign_scope_missing" });
    expect(check({ ...everything, active_classification_version: COHORT_CLASSIFICATION_VERSION, active_validation: PASS }, false))
      .toEqual({ ok: false, reason: "stale" });
  });

  it("requires the campaign scope only when asked, and reports it either way", () => {
    const noScope = readyState({ active_campaign_scope_version: null });
    expect(check(noScope, true)).toEqual({ ok: false, reason: "campaign_scope_missing" });
    expect(check(readyState({ active_campaign_scope_version: "campaign_scope_v0" }), true)).toEqual({ ok: false, reason: "campaign_scope_missing" });
    const cohortOnly = check(noScope, false);
    expect(cohortOnly.ok).toBe(true);
    if (cohortOnly.ok === true) expect(cohortOnly.snapshot.campaignScopeReady).toBe(false);
  });

  it("ignores status: a rebuild that is claiming or has failed keeps the active snapshot readable", () => {
    for (const status of ["building", "failed", "never_started"] as const) {
      const state = readyState({ status, diagnostics: { stage: "claim" }, building_warehouse_version: "wh_next", last_error: status === "failed" ? "boom" : null });
      const result = check(state, true);
      expect(result.ok, status).toBe(true);
      if (result.ok === true) expect(result.snapshot.warehouseVersion).toBe("wh_active");
    }
  });

  // Security review: rebuild_force, or a retry after a failed build of the
  // active fingerprint, inserts into the ACTIVE pair; a re-classified user can
  // then sit under two paths while the old validation still says PASS and the
  // observe RPC keeps fresh_verified_at current.
  it("refuses while the ACTIVE versions themselves are being rebuilt, failed or abandoned — until a build completes", () => {
    const samePair = { building_warehouse_version: "wh_active", building_classification_version: COHORT_CLASSIFICATION_VERSION };
    for (const status of ["building", "failed"] as const) {
      expect(check(readyState({ status, ...samePair }), false), status).toEqual({ ok: false, reason: "not_validated" });
      expect(check(readyState({ status, ...samePair }), true), status).toEqual({ ok: false, reason: "not_validated" });
    }
    // Completed again (the complete RPC clears building_*; a stale copy is harmless).
    expect(check(readyState({ status: "completed", ...samePair })).ok).toBe(true);
    // Another classification of the same warehouse version is a different pair.
    expect(check(readyState({ status: "building", ...samePair, building_classification_version: "cohort_classifier_v4" })).ok).toBe(true);
    expect(activePairBeingRebuilt(readyState({ status: "building", ...samePair }))).toBe(true);
    expect(activePairBeingRebuilt(readyState({ status: "building", building_warehouse_version: "wh_next" }))).toBe(false);
    expect(activePairBeingRebuilt(readyState({ status: "failed" }))).toBe(false);
  });

  it("accepts PostgREST bigint strings for duplicate_users but never an empty one", () => {
    expect(check(readyState({ duplicate_users: "0" as unknown as number })).ok).toBe(true);
    expect(check(readyState({ duplicate_users: "" as unknown as number }))).toEqual({ ok: false, reason: "not_validated" });
  });

  it("honours the staleness bound exactly and tolerates a verification stamped slightly ahead", () => {
    expect(check(readyState({ fresh_verified_at: "2026-10-06T06:00:00.000Z" })).ok).toBe(true);
    expect(check(readyState({ fresh_verified_at: "2026-10-06T05:59:59.999Z" }))).toEqual({ ok: false, reason: "stale" });
    expect(check(readyState({ fresh_verified_at: "2026-10-06T12:00:30.000Z" })).ok).toBe(true);
    expect(check(readyState(), false, HOUR / 60)).toEqual({ ok: false, reason: "stale" });
    expect(check(readyState(), false, Number.NaN)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("activeSnapshotCurrent (rebuild short-circuit)", () => {
  const fp = { warehouse_version: "wh_active", classification_version: COHORT_CLASSIFICATION_VERSION };

  it("is true only when the active versions equal the fingerprint and the active build validated", () => {
    expect(activeSnapshotCurrent(readyState(), fp)).toBe(true);
    expect(activeSnapshotCurrent(readyState(), { ...fp, warehouse_version: "wh_new" })).toBe(false);
    expect(activeSnapshotCurrent(readyState(), { ...fp, classification_version: "other" })).toBe(false);
    expect(activeSnapshotCurrent(readyState({ duplicate_users: 3 }), fp)).toBe(false);
    expect(activeSnapshotCurrent(readyState({ active_validation: { status: "FAIL" } }), fp)).toBe(false);
    expect(activeSnapshotCurrent(null, fp)).toBe(false);
    expect(activeSnapshotCurrent(undefined, fp)).toBe(false);
  });

  it("falls back to diagnostics.validation only for a completed row without active_validation", () => {
    expect(activeSnapshotCurrent(readyState({ active_validation: null }), fp)).toBe(true);
    expect(activeSnapshotCurrent(readyState({ active_validation: undefined }), fp)).toBe(true);
    // A claim overwrote status / diagnostics: without active_validation there is no proof.
    expect(activeSnapshotCurrent(readyState({ active_validation: null, status: "building" }), fp)).toBe(false);
    // ...but the active build's own validation survives the claim.
    expect(activeSnapshotCurrent(readyState({ status: "building", diagnostics: {} }), fp)).toBe(true);
  });

  it("ignores freshness and the campaign scope (they are the tick's job, not the short-circuit's)", () => {
    expect(activeSnapshotCurrent(readyState({ fresh_verified_at: null, active_campaign_scope_version: null }), fp)).toBe(true);
  });
});

describe("moved helpers keep their behaviour", () => {
  it("validationPassed", () => {
    expect(validationPassed(PASS)).toBe(true);
    expect(validationPassed({ status: "PASS" })).toBe(true);
    for (const bad of [null, undefined, "PASS", { status: "FAIL" }, { status: "PASS", duplicate_users: 1 }, { status: "PASS", dynamic_users: 2, materialized_users: 1 }]) {
      expect(validationPassed(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("isCompleteValidatedCohortSnapshot / activeCohortSnapshotVersion still require status completed (owner path)", () => {
    expect(isCompleteValidatedCohortSnapshot(readyState())).toBe(true);
    expect(activeCohortSnapshotVersion(readyState())).toEqual({ warehouse_version: "wh_active", classification_version: COHORT_CLASSIFICATION_VERSION });
    expect(isCompleteValidatedCohortSnapshot(readyState({ status: "building" }))).toBe(false);
    expect(activeCohortSnapshotVersion(readyState({ diagnostics: {} }))).toBeNull();
    expect(activeCohortSnapshotVersion(null)).toBeNull();
  });

  it("getCohortSnapshotState reads one row by tenant and snapshot name, and throws on an error", async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const fake = (result: { data: unknown; error: { message: string } | null }) => {
      const builder = {
        select: (columns: string) => { calls.push(["select", columns]); return builder; },
        eq: (column: string, value: unknown) => { calls.push(["eq", column, value]); return builder; },
        maybeSingle: async () => result,
      };
      return { from: (table: string) => { calls.push(["from", table]); return builder; } } as unknown as SupabaseLikeClient;
    };
    const row = readyState();
    expect(await getCohortSnapshotState(fake({ data: row, error: null }), "tenant-1")).toBe(row);
    expect(calls).toEqual([
      ["from", "clickhouse_cohort_snapshot_state"],
      ["select", "*"],
      ["eq", "auth_user_id", "tenant-1"],
      ["eq", "snapshot_name", "fact_user_cohorts"],
    ]);
    expect(await getCohortSnapshotState(fake({ data: null, error: null }), "tenant-1")).toBeNull();
    await expect(getCohortSnapshotState(fake({ data: null, error: { message: "denied" } }), "tenant-1")).rejects.toThrow(/denied/);
  });
});
