// clickhouse-cohorts access policy (plan §7 rows "Cohorts table", "Cohort filter
// options", "Cohort drilldown", "FB allocation diagnostics").
//
// Callers in src/ (the anyOf lists below are exactly these pages, never broader):
//   * list    — Cohorts (cohortsDataSource / useCohortsListQuery + the sidebar
//               hover prefetch), Reports (reportCollect), Forecasting Plan and
//               Project (PlanMode, projectForecastSeeding);
//   * details — Cohorts expanded cohort / funnel rows;
//   * options — no current caller; kept for the Cohorts page it belongs to.
//
// The `fb_allocation_diagnostics` request block maps to its own canonical action
// so the registry sees it. The Cohorts page sends that block on EVERY list
// request, so the action is open to the same list viewers and the diagnostics
// payload is STRIPPED (not denied) unless the caller has raw access or
// admin.diagnostics.view — see canServeFbAllocationDiagnostics. It must never
// become scopeReady (plan §7: "never R").
//
// Milestone A: no action is scopeReady, so a restricted (selected / none) member
// gets 403 scope_not_supported from the gate on all of them.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";
import { CohortRequestError } from "../../clickhouse/cohorts.ts";

export type ClickHouseCohortsAction = "list" | "list_fb_allocation_diagnostics" | "details" | "options";

/** Every page that renders cohort rows from `list`. */
export const COHORT_LIST_VIEW_PERMISSIONS: readonly string[] = Object.freeze(["cohorts.view", "reports.view", "forecasting.view"]);

/** The permission that unlocks the FB allocation diagnostics payload. */
export const FB_ALLOCATION_DIAGNOSTICS_PERMISSION = "admin.diagnostics.view";

/** One canonical normalizer. Today's aliases (cohorts / cohort_details /
 * filter_options) keep working; a missing or unknown action is rejected (the
 * legacy "missing ⇒ list" default had no caller: every src/ request names it). */
export function normalizeClickHouseCohortsAction({ body }: NormalizeActionInput): ClickHouseCohortsAction {
  switch (body.action) {
    case "list":
    case "cohorts":
      return body.fb_allocation_diagnostics !== undefined && body.fb_allocation_diagnostics !== null
        ? "list_fb_allocation_diagnostics"
        : "list";
    case "details":
    case "cohort_details":
      return "details";
    case "options":
    case "filter_options":
      return "options";
    default:
      throw new ActionNormalizeError();
  }
}

export const CLICKHOUSE_COHORTS_POLICY: FunctionPolicy<ClickHouseCohortsAction> = {
  fn: "clickhouse-cohorts",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseCohortsAction,
  actions: {
    list: { anyOf: [...COHORT_LIST_VIEW_PERMISSIONS] },
    // Same audience as list on purpose: the diagnostics block itself is stripped
    // for callers without FB_ALLOCATION_DIAGNOSTICS_PERMISSION (see header).
    list_fb_allocation_diagnostics: { anyOf: [...COHORT_LIST_VIEW_PERMISSIONS] },
    details: { anyOf: ["cohorts.view"] },
    options: { anyOf: ["cohorts.view"] },
  },
};

type AccessSubject = Pick<AccessContext, "rawAccess" | "permissions">;

/** Whether the FB allocation diagnostics payload may be computed and returned
 * (the FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED flag still applies on top). */
export function canServeFbAllocationDiagnostics(ctx: AccessSubject): boolean {
  return ctx.rawAccess || ctx.permissions.has(FB_ALLOCATION_DIAGNOSTICS_PERMISSION);
}

/** active_user_ids are customer emails: raw for the data owner only, keyed
 * tokens for everyone else (pseudonymizeActiveIdentities). */
export function cohortIdentitiesVisible(ctx: Pick<AccessContext, "rawAccess">): boolean {
  return ctx.rawAccess;
}

/** Warehouse error text inside a 200 body (the details price_breakdown error):
 * the data owner keeps today's text; everyone else gets a fixed code (plan
 * §12.7 / T19 — the gate only sanitizes THROWN errors, not returned bodies). */
export function cohortDetailedErrorsVisible(ctx: Pick<AccessContext, "rawAccess">): boolean {
  return ctx.rawAccess;
}

/** HMAC label for the identity tokens (tenant-bound, one use per label). */
export function cohortIdentityHashLabel(tenantKey: string): string {
  return `clickhouse-cohorts:active-identities:${tenantKey}`;
}

/** onError mapping — today's status and body exactly: validation faults are
 * 400, anything else is a warehouse fault (502). The gate adds request_id and
 * replaces the body with a generic one for anyone but the data owner. */
export function cohortsErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  return {
    status: error instanceof CohortRequestError ? 400 : 502,
    body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse cohort query failed." },
  };
}
