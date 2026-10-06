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
// so the registry sees it. The Cohorts page sends that block only when the
// viewer has raw access or admin.diagnostics.view (src/pages/Cohorts.tsx
// canViewFbAllocationDiagnostics); the action is still open to the list viewers
// and the payload is STRIPPED (not denied) for anyone else — see
// canServeFbAllocationDiagnostics. It must never become scopeReady (plan §7:
// "never R", spec R-7).
//
// Funnel-restricted members (access Phase 2, spec §4): list / details / options
// are scopeReady behind the cohort-snapshot freshness gate (scopeSnapshot
// "cohort" → 409 scope_snapshot_not_ready until it is fresh and validated);
// list additionally needs cohorts.view itself for them (restrictedAnyOf: the
// Reports / Forecasting pages are not open to restricted members). Their
// requests are shaped by restrictCohortRequest (explicit out-of-scope keys →
// 403 funnel_out_of_scope before any SQL; the campaign_path include list is
// intersected with their paths) and served by the materialized runners only;
// projectCohortsResponseForRestricted redacts the response and adds meta.access.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";
import { CohortRequestError, normalizeCohortRequest } from "../../clickhouse/cohorts.ts";
import type { CohortRequest } from "../../clickhouse/cohortContract.ts";
import { assertKeyPathInScope, intersectIncludePaths, type ScopeSql } from "../../clickhouse/scopeSql.ts";

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
    list: { anyOf: [...COHORT_LIST_VIEW_PERMISSIONS], restrictedAnyOf: ["cohorts.view"], scopeReady: true, scopeSnapshot: "cohort" },
    // Same audience as list on purpose: the diagnostics block itself is stripped
    // for callers without FB_ALLOCATION_DIAGNOSTICS_PERMISSION (see header).
    // Never scopeReady: the page is tenant-wide allocation diagnostics.
    list_fb_allocation_diagnostics: { anyOf: [...COHORT_LIST_VIEW_PERMISSIONS] },
    details: { anyOf: ["cohorts.view"], scopeReady: true, scopeSnapshot: "cohort" },
    options: { anyOf: ["cohorts.view"], scopeReady: true, scopeSnapshot: "cohort" },
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

// ---- funnel-restricted members (access Phase 2) -------------------------------------

/** meta.access of every restricted cohorts response (spec §6 contract 4). */
export interface RestrictedCohortsMeta {
  access: { scope: "restricted"; dropped_filter_values: number };
}

/** Shapes a restricted member's request BEFORE any SQL (R11):
 *   * an explicit cohort_key / funnel_key — whenever present, even the one
 *     details ignores — must name one of their paths, else 403
 *     funnel_out_of_scope (a key that is '', 'unknown' or not canonical too);
 *   * the campaign_path include list keeps only their paths; a non-empty list
 *     left empty becomes the sentinel that matches nothing (never "no filter");
 *     `dropped` counts the removed values (meta.access.dropped_filter_values);
 *   * campaign_path_exclude and every other filter pass through untouched.
 * A malformed request still fails in the runner (400), as for everyone. */
export function restrictCohortRequest(scope: ScopeSql, body: Record<string, unknown>): { request: CohortRequest; dropped: number } {
  const request = body as CohortRequest;
  const keyPath = (key: unknown) => (key && typeof key === "object" ? (key as { campaign_path?: unknown }).campaign_path : undefined);
  if (request.cohort_key !== undefined && request.cohort_key !== null) assertKeyPathInScope(scope, keyPath(request.cohort_key));
  if (request.funnel_key !== undefined && request.funnel_key !== null) assertKeyPathInScope(scope, keyPath(request.funnel_key));
  const { values, dropped } = intersectIncludePaths(scope, normalizeCohortRequest(request).filters.campaign_path);
  return { request: { ...request, filters: { ...(request.filters ?? {}), campaign_path: values } }, dropped };
}

/** Diagnostics keys a restricted response never carries a value for (the
 * runner already sets them — restrictedSnapshotDiagnostics; this is the last
 * line before the wire). */
const RESTRICTED_DIAGNOSTICS_REDACTION: Readonly<Record<string, unknown>> = Object.freeze({
  transactions_scanned: 0,
  users_scanned: 0,
  source_transactions: null,
  cohort_users: null,
  current_warehouse_version: null,
  current_warehouse_transactions: null,
  support_requests: null,
  support_unique_emails: null,
  counts_redacted: true,
});

/** A restricted member's list / options / details body (R-14): without the
 * tenant-wide fb_allocation_diagnostics page, with the diagnostics redaction
 * re-applied and meta.access added. Pure; returns a new object. */
export function projectCohortsResponseForRestricted<T extends object>(body: T, dropped: number): T & { meta: RestrictedCohortsMeta } {
  const projected: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete projected.fb_allocation_diagnostics;
  const diagnostics = projected.diagnostics;
  if (diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)) {
    projected.diagnostics = { ...(diagnostics as Record<string, unknown>), ...RESTRICTED_DIAGNOSTICS_REDACTION };
  }
  const count = Number(dropped);
  projected.meta = { access: { scope: "restricted", dropped_filter_values: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0 } };
  return projected as T & { meta: RestrictedCohortsMeta };
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
