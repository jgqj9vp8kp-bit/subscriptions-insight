// Cohort snapshot state (public.clickhouse_cohort_snapshot_state) and the
// access-Phase-2 freshness rules built on it. Pure apart from the one
// service-role read (getCohortSnapshotState): no ClickHouse, no Deno globals,
// so the gate, the rebuild and the admin coverage page share one definition.
//
// Two different questions are answered here:
//   * "is the ACTIVE materialization usable at all?" — the owner's materialized
//     Cohorts path (isCompleteValidatedCohortSnapshot / activeCohortSnapshotVersion,
//     moved unchanged from cohortMembership.ts, which re-exports them);
//   * "may a funnel-restricted request read it right now?" —
//     restrictedSnapshotReadiness, the gate's freshness check (spec §3.1). It
//     reads the active_* / fresh_verified_at columns and IGNORES `status`:
//     claiming and failing a build overwrite status and diagnostics
//     (202607180001), which would otherwise 409 every buyer during every rebuild.
//     The one exception is a build of the active versions THEMSELVES
//     (activePairBeingRebuilt): it rewrites the rows the active validation
//     certified, so those rows are not served until a build completes.

import type { SupabaseLikeClient } from "./types.ts";

export const COHORT_SNAPSHOT_NAME = "fact_user_cohorts";
// v2 makes the authoritative attribution columns explicit members of the
// per-user grain (no any(campaign_id) copy step). Bumping forces a validated
// snapshot rebuild on rollout instead of silently reusing the v1 materialization.
// v3: adds the user-level platform dimension (Cohorts Platform filter). The
// bump forces a snapshot rebuild so existing fact rows (platform = '') are
// replaced by classified ones — the filter must never run on a half-built dim.
export const COHORT_CLASSIFICATION_VERSION = "cohort_classifier_v3_platform";

/** Version of the fact_campaign_scope build (campaignScope.ts). Recorded in
 * active_campaign_scope_version once a build for the active snapshot PASSes. */
export const CAMPAIGN_SCOPE_VERSION = "campaign_scope_v1";
/** Restricted reads refuse a snapshot not verified current within this many
 * hours (env SCOPE_SNAPSHOT_MAX_STALENESS_HOURS overrides it in the gate). */
export const SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT = 6;

export type CohortSnapshotStatus = "never_started" | "building" | "completed" | "failed";

export interface CohortSnapshotState {
  auth_user_id: string;
  snapshot_name: string;
  status: CohortSnapshotStatus;
  active_warehouse_version: string | null;
  active_classification_version: string | null;
  active_generated_at: string | null;
  building_warehouse_version: string | null;
  building_classification_version: string | null;
  build_token?: string | null;
  lease_expires_at?: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  users_classified: number;
  rows_inserted: number;
  duplicate_users: number;
  removed_or_invalidated: number;
  source_transactions: number | null;
  source_unique_users: number | null;
  last_error: string | null;
  diagnostics: Record<string, unknown>;
  updated_at?: string | null;
  // Phase 2 (migration 202610060001 §10): written only by the complete /
  // observe / set-campaign-scope RPCs, never by claim or fail.
  /** diagnostics.validation of the build that produced the ACTIVE versions. */
  active_validation?: Record<string, unknown> | null;
  active_validated_at?: string | null;
  /** CAMPAIGN_SCOPE_VERSION once fact_campaign_scope PASSed for the active versions. */
  active_campaign_scope_version?: string | null;
  /** Last time the warehouse fingerprint was observed equal to the active versions. */
  fresh_verified_at?: string | null;
  /** First observation of a fingerprint that no longer matches (null while current). */
  stale_since?: string | null;
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** duplicate_users === 0, tolerating PostgREST's bigint-as-string; a missing
 * value is NOT zero (fail closed). */
function isZero(value: unknown): boolean {
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") return value.trim() !== "" && Number(value) === 0;
  return false;
}

export function validationPassed(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const validation = value as { status?: unknown; duplicate_users?: unknown; dynamic_users?: unknown; materialized_users?: unknown };
  if (validation.status !== "PASS") return false;
  if (validation.duplicate_users != null && n(validation.duplicate_users) !== 0) return false;
  if (validation.dynamic_users != null && validation.materialized_users != null
    && n(validation.dynamic_users) !== n(validation.materialized_users)) return false;
  return true;
}

export function isCompleteValidatedCohortSnapshot(state: CohortSnapshotState | null | undefined): state is CohortSnapshotState {
  return Boolean(
    state &&
      state.status === "completed" &&
      state.active_warehouse_version &&
      state.active_classification_version &&
      state.duplicate_users === 0 &&
      validationPassed(state.diagnostics?.validation),
  );
}

export function activeCohortSnapshotVersion(state: CohortSnapshotState | null | undefined): {
  warehouse_version: string;
  classification_version: string;
} | null {
  if (!isCompleteValidatedCohortSnapshot(state)) return null;
  return {
    warehouse_version: state.active_warehouse_version as string,
    classification_version: state.active_classification_version as string,
  };
}

export async function getCohortSnapshotState(supabase: SupabaseLikeClient, authUserId: string): Promise<CohortSnapshotState | null> {
  const { data, error } = await supabase
    .from("clickhouse_cohort_snapshot_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("snapshot_name", COHORT_SNAPSHOT_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not load ClickHouse cohort snapshot state: ${error.message}`);
  return (data as CohortSnapshotState | null) ?? null;
}

// ---- restricted-read freshness (spec §3.1) ------------------------------------------

/** What a funnel-restricted request reads against: the active versions, fixed
 * for the whole request (every scope fragment binds them as literals). */
export interface ScopeSnapshot {
  warehouseVersion: string;
  classificationVersion: string;
  /** fact_campaign_scope is built for these versions (FB visibility can be computed). */
  campaignScopeReady: boolean;
  freshVerifiedAt: string;
  /** Set when a newer warehouse fingerprint was observed (still within the bound). */
  staleSince: string | null;
  state: CohortSnapshotState;
}

export type ScopeReadinessFailure = "no_active_snapshot" | "classification_mismatch" | "not_validated" | "campaign_scope_missing" | "stale";

export type ScopeReadiness = { ok: true; snapshot: ScopeSnapshot } | { ok: false; reason: ScopeReadinessFailure };

/** A build of the ACTIVE (warehouse, classification) pair itself is running,
 * failed or was abandoned (rebuild_force, or a retry after a failed build of
 * the active fingerprint): it inserts into the very rows restricted reads bind,
 * and fact_user_cohorts / fact_campaign_scope keys let a re-classified user sit
 * under two paths at once. The active validation no longer certifies those rows
 * until a build completes again. A build of NEW versions does not touch them. */
export function activePairBeingRebuilt(state: CohortSnapshotState): boolean {
  return state.status !== "completed" &&
    state.building_warehouse_version != null &&
    state.building_warehouse_version === state.active_warehouse_version &&
    state.building_classification_version === state.active_classification_version;
}

/** Whether a restricted request may read the active snapshot. Checks, in order:
 * active versions set; classification = COHORT_CLASSIFICATION_VERSION; the
 * active build's own validation PASSed with no duplicate users, and the active
 * pair is not being rebuilt in place; (FB only) the campaign scope is built for
 * it; verified current within maxStalenessMs. Otherwise `status` is not
 * consulted (see the header): a build of new versions never 409s a buyer. */
export function restrictedSnapshotReadiness(
  state: CohortSnapshotState | null,
  o: { now: Date; maxStalenessMs: number; needsCampaignScope: boolean },
): ScopeReadiness {
  if (!state || !state.active_warehouse_version || !state.active_classification_version) return { ok: false, reason: "no_active_snapshot" };
  if (state.active_classification_version !== COHORT_CLASSIFICATION_VERSION) return { ok: false, reason: "classification_mismatch" };
  if (!validationPassed(state.active_validation) || !isZero(state.duplicate_users)) return { ok: false, reason: "not_validated" };
  if (activePairBeingRebuilt(state)) return { ok: false, reason: "not_validated" };
  const campaignScopeReady = state.active_campaign_scope_version === CAMPAIGN_SCOPE_VERSION;
  if (o.needsCampaignScope && !campaignScopeReady) return { ok: false, reason: "campaign_scope_missing" };
  const fresh = state.fresh_verified_at ? Date.parse(state.fresh_verified_at) : Number.NaN;
  const age = o.now.getTime() - fresh;
  if (!Number.isFinite(fresh) || !Number.isFinite(age) || !(age <= o.maxStalenessMs)) return { ok: false, reason: "stale" };
  return {
    ok: true,
    snapshot: Object.freeze({
      warehouseVersion: state.active_warehouse_version,
      classificationVersion: state.active_classification_version,
      campaignScopeReady,
      freshVerifiedAt: state.fresh_verified_at as string,
      staleSince: state.stale_since ?? null,
      state: Object.freeze({ ...state }),
    }),
  };
}

/** The rebuild short-circuit (spec §3.8): the ACTIVE snapshot already is the
 * fingerprinted warehouse version, validated, without duplicates. Falls back to
 * diagnostics.validation for rows completed before active_validation existed. */
export function activeSnapshotCurrent(
  state: CohortSnapshotState | null | undefined,
  fp: { warehouse_version: string; classification_version: string },
): state is CohortSnapshotState {
  if (!state || !state.active_warehouse_version || !state.active_classification_version) return false;
  if (state.active_warehouse_version !== fp.warehouse_version || state.active_classification_version !== fp.classification_version) return false;
  const validation = state.active_validation ?? (state.status === "completed" ? state.diagnostics?.validation : null);
  return validationPassed(validation) && isZero(state.duplicate_users);
}
