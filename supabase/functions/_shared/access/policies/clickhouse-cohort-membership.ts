// clickhouse-cohort-membership access policy (plan §7 row "Snapshot admin").
//
//   status        — cohorts viewers (the snapshot state behind the Cohorts page).
//                   Tenant totals, error text, the CAS build token and the data
//                   key are stripped unless the caller has raw access,
//                   admin.warehouse.manage or admin.diagnostics.view.
//   rebuild       — admin.warehouse.manage (src: Cohorts auto-rebuild via
//                   cohortSnapshotHealth, post-import trigger in clickhouse.ts).
//   rebuild_force — the same request with a truthy `force` (a full re-classify
//                   even when the snapshot is current): admin.warehouse.manage.
//   validate      — admin.warehouse.manage.
//
// The legacy function mapped ANY other action — and GET — to status. Nothing in
// src/ relies on that (every call POSTs an explicit action), so unknown or
// missing actions are now rejected and only POST is served. No action is
// scopeReady (Milestone A): restricted members get 403 scope_not_supported, and
// none of these may ever be (whole-tenant artifacts, never R).

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseCohortMembershipAction = "status" | "rebuild" | "rebuild_force" | "validate";

/** The action name the response bodies have always carried. */
export type CohortMembershipLegacyAction = "status" | "rebuild" | "validate";

export function normalizeClickHouseCohortMembershipAction({ body }: NormalizeActionInput): ClickHouseCohortMembershipAction {
  switch (body.action) {
    case "status":
      return "status";
    case "validate":
      return "validate";
    case "rebuild":
      // Same truthiness the runner always used (Boolean(body.force)), so the
      // policy and the rebuild agree on what "force" means.
      return Boolean(body.force) ? "rebuild_force" : "rebuild";
    default:
      throw new ActionNormalizeError();
  }
}

export const CLICKHOUSE_COHORT_MEMBERSHIP_POLICY: FunctionPolicy<ClickHouseCohortMembershipAction> = {
  fn: "clickhouse-cohort-membership",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseCohortMembershipAction,
  actions: {
    status: { anyOf: ["cohorts.view"] },
    rebuild: { allOf: ["admin.warehouse.manage"], write: true },
    rebuild_force: { allOf: ["admin.warehouse.manage"], write: true },
    validate: { allOf: ["admin.warehouse.manage"] },
  },
};

export function legacyMembershipAction(action: ClickHouseCohortMembershipAction): CohortMembershipLegacyAction {
  return action === "rebuild_force" ? "rebuild" : action;
}

/** Full snapshot-state detail: the data owner and the warehouse operators. */
export function snapshotStateDetailVisible(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has("admin.warehouse.manage") || ctx.permissions.has("admin.diagnostics.view");
}

/** The snapshot-state fields a cohorts viewer gets: lifecycle and versions
 * only. Dropped: auth_user_id (the data key), tenant totals (users_classified,
 * rows_inserted, source_*), last_error (warehouse text), diagnostics (the
 * warehouse fingerprint counts and validation detail) and the CAS build token. */
const VIEWER_SNAPSHOT_STATE_FIELDS = [
  "snapshot_name",
  "status",
  "active_warehouse_version",
  "active_classification_version",
  "active_generated_at",
  "building_warehouse_version",
  "building_classification_version",
  "started_at",
  "finished_at",
  "duration_ms",
  "updated_at",
] as const;

export function projectSnapshotStateForViewer(state: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!state || typeof state !== "object") return null;
  const projected: Record<string, unknown> = {};
  for (const field of VIEWER_SNAPSHOT_STATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(state, field)) projected[field] = state[field];
  }
  return projected;
}

/** A failed action, carrying the legacy action name so onError can rebuild
 * today's 502 body ({ ok: false, action, error }). */
export class CohortMembershipActionError extends Error {
  readonly action: CohortMembershipLegacyAction;

  constructor(action: CohortMembershipLegacyAction, cause: unknown) {
    super(cause instanceof Error ? cause.message : "ClickHouse cohort membership action failed.");
    this.name = "CohortMembershipActionError";
    this.action = action;
  }
}

/** onError mapping. Returns null for anything that is not a wrapped action
 * failure (the gate's generic 502 — and a ScopeViolation still becomes 500). */
export function cohortMembershipErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof CohortMembershipActionError)) return null;
  return { status: 502, body: { ok: false, action: error.action, error: error.message } };
}
