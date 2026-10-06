// clickhouse-facebook access policy (plan §7 rows "FB warehouse", "FB status",
// "FB history/recon", "FB writes", "FB cron", "Spend ledger", "Funnel spend").
//
// Canonical actions (body.action → policy key) and who may call them:
//   report / list / charts / filters / summary
//                    — facebook_analytics.view (the FB Analytics page). "analytics"
//                      is the old alias of report, and a body WITHOUT an action is
//                      a report — the one default the function always had.
//   status           — facebook_analytics.view or cohorts.view: the Cohorts page
//                      reads it too, to key its FB columns on the FB warehouse
//                      version. The stored sync state's spend totals are stripped
//                      unless the caller has raw access or admin.diagnostics.view.
//   v2_preview       — report / list / summary with v2_preview === true (forces the
//                      V2 read path; a cutover validation tool): admin.diagnostics.view.
//   funnel_spend     — facebook_analytics.view, funnel scope `all` only (brand-level
//                      buckets over every campaign of the tenant).
//   spend_ledger     — forecasting.view (Forecasting → Project mode seeding).
//   history_*, recon_history, v2_parity, source_probe
//                    — admin.diagnostics.view: read-only observability (raw
//                      payloads, run history, reconciliation). source_probe only
//                      READS the Capsuled API — it writes nothing.
//   v2_dims_status   — admin.warehouse.manage or admin.diagnostics.view (dim counts).
//   sync             — admin.sync.run.
//   recon_snapshot   — admin.warehouse.manage or admin.sync.run: the FB page stores
//                      one after every manual sync (as the cron does), so whoever
//                      may sync must be able to record the snapshot.
//   v2_dims_backfill, seed_campaign_aliases — admin.warehouse.manage.
//   funnel_suggestions       — funnels.manage (campaign → funnel evidence, read).
//   funnel_suggestions_apply — the same request with apply === true: it writes the
//                      campaign funnel map, so admin.warehouse.manage as well (its
//                      response carries the read, hence funnels.manage too).
//   cron_daily       — the pg_cron tick (x-cron-secret / FB_CRON_SECRET). Users can
//                      never name it; its policy entry denies everyone but the
//                      scheduler, which the gate authorizes by `cron.actions`.
//
// Funnel-restricted members (access Phase 2, spec §4): report / list / charts /
// filters / summary / status are scopeReady with scopeSnapshot "campaign" — the
// gate admits them only on a fresh, validated snapshot whose fact_campaign_scope
// is built (409 scope_snapshot_not_ready otherwise). Their reads see V1 rows of
// the member's visible campaigns at campaign / adset / ad level (the account and
// day levels are 403 scope_not_supported), and status gets the narrower
// projectFbSyncStateForRestricted. Every other action stays 403 for them.
// Pure module (no Deno, no remote imports): vitest imports it.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseFacebookAction =
  | "report"
  | "list"
  | "charts"
  | "filters"
  | "summary"
  | "status"
  | "v2_preview"
  | "funnel_spend"
  | "spend_ledger"
  | "history_runs"
  | "history_batches"
  | "history_versions"
  | "history_raw_payloads"
  | "history_dq"
  | "recon_history"
  | "v2_parity"
  | "v2_dims_status"
  | "source_probe"
  | "sync"
  | "recon_snapshot"
  | "v2_dims_backfill"
  | "seed_campaign_aliases"
  | "funnel_suggestions"
  | "funnel_suggestions_apply"
  | "cron_daily";

/** Body actions a user may name verbatim (v2_preview, funnel_suggestions_apply
 * and cron_daily are derived, never named). */
const USER_ACTIONS: ReadonlySet<string> = new Set([
  "report",
  "list",
  "charts",
  "filters",
  "summary",
  "status",
  "funnel_spend",
  "spend_ledger",
  "history_runs",
  "history_batches",
  "history_versions",
  "history_raw_payloads",
  "history_dq",
  "recon_history",
  "v2_parity",
  "v2_dims_status",
  "source_probe",
  "sync",
  "recon_snapshot",
  "v2_dims_backfill",
  "seed_campaign_aliases",
  "funnel_suggestions",
]);

/** Reads that honour `v2_preview` (runFbList is the only V2-aware reader; charts
 * and filters ignore the flag, so they keep their own action). */
export type FbV2PreviewRead = "report" | "list" | "summary";
const V2_PREVIEW_READS: ReadonlySet<string> = new Set<FbV2PreviewRead>(["report", "list", "summary"]);

export const FB_HISTORY_ACTIONS: ReadonlySet<ClickHouseFacebookAction> = new Set<ClickHouseFacebookAction>([
  "history_runs",
  "history_batches",
  "history_versions",
  "history_raw_payloads",
  "history_dq",
]);

/** Actions that may (re)create fact_facebook_stats before they run — the writers
 * only. Pure reads no longer run DDL: the table is created by clickhouse-init and
 * by every sync, and a reader must not need DDL rights (plan §13 "ensure* DDL
 * moves out of read paths"; Phase 8 read-only ClickHouse user). */
export const FB_SCHEMA_WRITE_ACTIONS: ReadonlySet<ClickHouseFacebookAction> = new Set<ClickHouseFacebookAction>([
  "sync",
  "recon_snapshot",
  "v2_dims_backfill",
  "seed_campaign_aliases",
  "funnel_suggestions_apply",
]);

/** The body's own action name — what every response has always echoed (a
 * missing action reads as "report"). */
export function fbResponseAction(body: Record<string, unknown>): string {
  return typeof body.action === "string" ? body.action : "report";
}

/** The read a v2_preview request runs ("analytics" / no action → report). */
export function fbV2PreviewRead(body: Record<string, unknown>): FbV2PreviewRead {
  const base = body.action === undefined || body.action === null || body.action === "analytics" ? "report" : body.action;
  if (typeof base === "string" && V2_PREVIEW_READS.has(base)) return base as FbV2PreviewRead;
  throw new ActionNormalizeError();
}

/** Canonical action. Sensitive flags become their own actions: v2_preview === true
 * on a V2-aware read, apply === true on funnel_suggestions (the exact truthiness
 * the handler uses). A missing / null action is a report on the user branch and
 * the daily tick on the cron branch; anything else unknown is a 400 (rule R3). */
export function normalizeClickHouseFacebookAction({ body, cron }: NormalizeActionInput): ClickHouseFacebookAction {
  if (cron) {
    if (body.action === undefined || body.action === null || body.action === "cron_daily") return "cron_daily";
    throw new ActionNormalizeError();
  }
  const named = body.action === undefined || body.action === null ? "report" : body.action;
  if (typeof named !== "string") throw new ActionNormalizeError();
  const base = named === "analytics" ? "report" : named;
  if (V2_PREVIEW_READS.has(base) && body.v2_preview === true) return "v2_preview";
  if (base === "funnel_suggestions") return body.apply === true ? "funnel_suggestions_apply" : "funnel_suggestions";
  if (USER_ACTIONS.has(base)) return base as ClickHouseFacebookAction;
  throw new ActionNormalizeError();
}

const FB_PAGE = ["facebook_analytics.view"];
const DIAGNOSTICS = ["admin.diagnostics.view"];

export const CLICKHOUSE_FACEBOOK_POLICY: FunctionPolicy<ClickHouseFacebookAction> = {
  fn: "clickhouse-facebook",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseFacebookAction,
  actions: {
    report: { anyOf: FB_PAGE, scopeReady: true, scopeSnapshot: "campaign" },
    list: { anyOf: FB_PAGE, scopeReady: true, scopeSnapshot: "campaign" },
    charts: { anyOf: FB_PAGE, scopeReady: true, scopeSnapshot: "campaign" },
    filters: { anyOf: FB_PAGE, scopeReady: true, scopeSnapshot: "campaign" },
    summary: { anyOf: FB_PAGE, scopeReady: true, scopeSnapshot: "campaign" },
    status: { anyOf: ["facebook_analytics.view", "cohorts.view"], scopeReady: true, scopeSnapshot: "campaign" },
    // A flag variant must never be weaker than the read it runs: the V2 preview
    // serves the same report/list/summary, so it needs the page permission too.
    v2_preview: { allOf: [...FB_PAGE, ...DIAGNOSTICS] },
    funnel_spend: { anyOf: FB_PAGE, fullScopeOnly: true },
    spend_ledger: { anyOf: ["forecasting.view"] },
    history_runs: { anyOf: DIAGNOSTICS },
    history_batches: { anyOf: DIAGNOSTICS },
    history_versions: { anyOf: DIAGNOSTICS },
    history_raw_payloads: { anyOf: DIAGNOSTICS },
    history_dq: { anyOf: DIAGNOSTICS },
    recon_history: { anyOf: DIAGNOSTICS },
    v2_parity: { anyOf: DIAGNOSTICS },
    v2_dims_status: { anyOf: ["admin.warehouse.manage", "admin.diagnostics.view"] },
    source_probe: { anyOf: DIAGNOSTICS },
    sync: { allOf: ["admin.sync.run"], write: true },
    recon_snapshot: { anyOf: ["admin.warehouse.manage", "admin.sync.run"], write: true },
    v2_dims_backfill: { allOf: ["admin.warehouse.manage"], write: true },
    seed_campaign_aliases: { allOf: ["admin.warehouse.manage"], write: true },
    funnel_suggestions: { allOf: ["funnels.manage"] },
    funnel_suggestions_apply: { allOf: ["funnels.manage", "admin.warehouse.manage"], write: true },
    // Scheduler only (see header): a user can never normalize to it, and this
    // entry would refuse one anyway.
    cron_daily: { ownerOnly: true, rawOnly: true, allOf: ["admin.sync.run", "admin.warehouse.manage"], write: true },
  },
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["cron_daily"] },
};

// ---- status redaction ----------------------------------------------------------

/** Full sync-state detail: the data owner and diagnostics viewers. */
export function fbStatusDetailVisible(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has("admin.diagnostics.view");
}

/** The stored sync-state fields every status reader gets: lifecycle, the cursor
 * (the browser keys its FB caches on cursor + finished_at) and row counts.
 * Dropped: auth_user_id (the data key), last_error (raw upstream / warehouse
 * text) and every field not listed here. */
const VIEWER_SYNC_STATE_FIELDS = [
  "sync_name",
  "status",
  "current_stage",
  "stopped_reason",
  "last_run_mode",
  "cursor_transaction_id",
  "cursor_updated_at",
  "started_at",
  "finished_at",
  "duration_ms",
  "updated_at",
  "rows_scanned",
  "rows_mapped",
  "rows_inserted",
  "rows_skipped",
  "batches_processed",
  "source_total",
  "clickhouse_total",
] as const;

/** sync_state.diagnostics fields kept for viewers. Dropped: the tenant-wide
 * spend totals spend_by_level / day_spend_total and spend_mismatch (the same
 * totals per level), whether from a completed run or a failed validation. */
const VIEWER_SYNC_DIAGNOSTICS_FIELDS = [
  "mode",
  "date_from",
  "date_to",
  "levels",
  "fb_stats_to",
  "api_last_import_at",
  "api_requests",
  "api_latency_ms",
  "api_payload_bytes",
  "range_splits",
  "rows_updated",
  "warehouse_version",
  "active_days",
  "strategy",
  "merged_rows_detected",
  "validation_status",
  "error_code",
  "error_message_safe",
] as const;

/** Funnel-restricted members (spec §4 status row): lifecycle and the cursor only
 * (the browser's version hash reads cursor + finished_at). Also dropped: the
 * tenant-wide row counters (rows_*, batches_processed, source_total,
 * clickhouse_total) — warehouse size is not the member's data. */
const RESTRICTED_SYNC_STATE_FIELDS = [
  "sync_name",
  "status",
  "current_stage",
  "stopped_reason",
  "last_run_mode",
  "cursor_transaction_id",
  "cursor_updated_at",
  "started_at",
  "finished_at",
  "duration_ms",
  "updated_at",
] as const;

/** sync_state.diagnostics fields kept for restricted members: the sync window
 * and freshness, without the API volume / row counters. */
const RESTRICTED_SYNC_DIAGNOSTICS_FIELDS = [
  "mode",
  "date_from",
  "date_to",
  "levels",
  "fb_stats_to",
  "api_last_import_at",
  "warehouse_version",
  "strategy",
  "validation_status",
  "error_code",
  "error_message_safe",
] as const;

function pick(source: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(source, field)) projected[field] = source[field];
  }
  return projected;
}

function projectSyncState(
  state: Record<string, unknown> | null | undefined,
  stateFields: readonly string[],
  diagnosticsFields: readonly string[],
): Record<string, unknown> | null {
  if (!state || typeof state !== "object") return null;
  const projected = pick(state, stateFields);
  if (Object.prototype.hasOwnProperty.call(state, "diagnostics")) {
    const diagnostics = state.diagnostics;
    projected.diagnostics = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
      ? pick(diagnostics as Record<string, unknown>, diagnosticsFields)
      : null;
  }
  return projected;
}

export function projectFbSyncStateForViewer(state: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return projectSyncState(state, VIEWER_SYNC_STATE_FIELDS, VIEWER_SYNC_DIAGNOSTICS_FIELDS);
}

/** The status state a funnel-restricted member gets (whatever else they hold). */
export function projectFbSyncStateForRestricted(state: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  return projectSyncState(state, RESTRICTED_SYNC_STATE_FIELDS, RESTRICTED_SYNC_DIAGNOSTICS_FIELDS);
}

// ---- errors ----------------------------------------------------------------------

/** A failed action carrying the status and body the function has always
 * returned for it, so onError reproduces the pre-access error response. The gate
 * still replaces the body with a generic one for anyone but the data owner. */
export class FbActionError extends Error {
  readonly status: number;
  readonly body: Record<string, unknown>;

  constructor(status: number, body: Record<string, unknown>) {
    super(typeof body.error === "string" && body.error ? body.error : "Facebook warehouse action failed.");
    this.name = "FbActionError";
    this.status = status;
    this.body = body;
  }
}

/** onError mapping. Null for anything that is not a wrapped action failure (the
 * gate's generic 502 — and a ScopeViolation still becomes 500). */
export function clickHouseFacebookErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (!(error instanceof FbActionError)) return null;
  return { status: error.status, body: { ...error.body } };
}
