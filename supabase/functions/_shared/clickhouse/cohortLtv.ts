// Payback page revenue curve (2026-10-24) — clickhouse-cohorts action "ltv".
//
// One row per (cohort_date, campaign_path) with the trial users and the
// cumulative net revenue through each day checkpoint of LTV_CHECKPOINTS. The
// browser (src/services/ltvPayback.ts) decides which checkpoints are mature
// against data_through and projects the rest; this module only measures.
//
// Same population and money as the Cohorts list, by construction: the statement
// continues the list's materialized finx chain (materializedFinxCtes) — snapshot
// membership, member filters, funnel scope, email-matched tokens and the token /
// in-product / funnel upsell typing — and rev_c is the list's revenue_dN
// expression for every checkpoint (rev_30 / rev_60 are d30_raw / d60_raw
// verbatim). Only the grain differs: (cohort_date, campaign_path), since the
// page keys funnels by path. support_emails is built empty (no measure here
// reads it), so no support probe runs.
//
// Range (spec §3): the display window widened back to data_through − 271 days,
// so the most recent 180 cohort days observed at d90 (+2 days maturity) are in
// the response for the reference pools; never more than 13 months before `to`.
// Every path in scope is returned: the funnel / campaign_path filters are
// dropped (the page filters funnels itself and needs the other paths for its
// product / all-paths fallback). refund_status is a list post-filter and does
// not apply.
//
// data_through is the newest event_time of the caller's transactions (the
// newest Primer import). For a funnel-restricted member it is computed over
// their scoped users only — never a tenant-wide value — which can only make
// their cohorts look younger, never older.
//
// Freshness: payments are live, members are the snapshot's. Every import makes
// the snapshot stale until a rebuild runs, and in that gap the newest trials
// are missing while data_through (and the spend paired with it) runs on. So
// the response also carries members_through (the snapshot's newest trial, as
// revenueTrials reads it) and snapshot_stale (all scope: the live warehouse
// fingerprint of this request, as the list compares it; restricted: the gate's
// verdict); the page cuts its trials at members_through while it is stale.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { CohortRequestError, normalizeCohortRequest } from "./cohorts.ts";
import { getWarehouseFingerprint, materializedFinxCtes } from "./cohortMembership.ts";
import { activeCohortSnapshotVersion, getCohortSnapshotState, type CohortSnapshotState } from "./cohortSnapshotState.ts";
import { ScopeViolation } from "./scopedClient.ts";
import { ALL_SCOPE_SQL, ScopeSnapshotNotReadyError, cohortsFrom, txFrom, type ScopeSql } from "./scopeSql.ts";
import type { CohortLtvRange, CohortLtvResponse, CohortLtvRow, CohortRequest } from "./cohortContract.ts";

/** Day checkpoints of the curve: d0, the 3-day trial, the weekly billing steps,
 * the month targets 30 / 60 / 90 and the billing steps 37 / 45 / 67 / 75. */
export const LTV_CHECKPOINTS: readonly number[] = Object.freeze([0, 3, 7, 14, 21, 30, 37, 45, 60, 67, 75, 90]);
/** data_through − 271 days = the oldest of the 180 newest cohort days observed at d90. */
export const LTV_REFERENCE_DAYS = 271;
export const LTV_MAX_RANGE_MONTHS = 13;
export const LTV_SNAPSHOT_NOT_READY = "cohort_snapshot_not_ready";

const DAY_MS = 86_400_000;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)Z?$/;

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

/** Half-up to 2 decimals, as the list's toAggregateRow. */
function round2(x: number): number {
  return Math.floor(x * 100 + 0.5) / 100;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Calendar months back, the day clamped to the target month's length. */
export function addMonths(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(date, last))).toISOString().slice(0, 10);
}

// ---- request ------------------------------------------------------------------------------

/** A CohortRequest that is also a plain request body (restrictCohortRequest's input). */
export type CohortLtvRequest = CohortRequest & Record<string, unknown>;

/** The request the statement is built from: action dropped (the list chain's
 * normalizer knows list / details / options only) and the funnel identity
 * filters emptied. Idempotent; every other filter is kept as the list applies it. */
export function cohortLtvRequest(body: CohortRequest | Record<string, unknown>): CohortLtvRequest {
  const request: CohortLtvRequest = { ...(body as CohortLtvRequest) };
  delete request.action;
  const filters = request.filters && typeof request.filters === "object" ? request.filters : {};
  return { ...request, filters: { ...filters, funnel: [], campaign_path: [], campaign_path_exclude: [] } };
}

/** A reversed window is a 400; checked on the request alone, before any read. */
export function assertLtvDateOrder(dateFrom: string | null, dateTo: string | null): void {
  if (dateFrom && dateTo && dateFrom > dateTo) throw new CohortRequestError("date_from must not be after date_to.");
}

/** Served range for a display window and data_through (ISO). A missing date_to
 * is data_through's day; a missing date_from is date_to. null: a lone date_from
 * after data_through's day — a window with no payments yet, nothing to read. */
export function resolveLtvRange(dateFrom: string | null, dateTo: string | null, dataThrough: string): CohortLtvRange | null {
  assertLtvDateOrder(dateFrom, dateTo);
  const lastDay = dataThrough.slice(0, 10);
  const to = dateTo ?? lastDay;
  const from = dateFrom ?? to;
  if (from > to) return null;
  const reference = addDays(lastDay, -LTV_REFERENCE_DAYS);
  const earliest = addMonths(to, -LTV_MAX_RANGE_MONTHS);
  const widened = from < reference ? from : reference;
  return {
    from: widened < earliest ? earliest : widened,
    to,
    requested_from: dateFrom,
    requested_to: dateTo,
    capped: from < earliest,
  };
}

// ---- SQL ----------------------------------------------------------------------------------

/** Per-group measures: trial_users exactly as AGGREGATE_MEASURES, rev_c as its
 * revenue_dN expression (d >= 0 holds for every finx row, so d <= 0 is d0). */
export const LTV_MEASURES = [
  "uniqExact(uid) trial_users",
  ...LTV_CHECKPOINTS.map((day) => `sum(if(is_success = 1 AND d <= ${day}, nn, 0)) rev_${day}`),
].join(",\n  ");

export function buildCohortLtvQuery(
  request: CohortRequest,
  active: { warehouse_version: string; classification_version: string },
  params: Record<string, unknown>,
  range: Pick<CohortLtvRange, "from" | "to">,
  scope: ScopeSql = ALL_SCOPE_SQL,
): string {
  params.ltv_from = range.from;
  params.ltv_to = range.to;
  return `WITH
${materializedFinxCtes(cohortLtvRequest(request), active, params, "unavailable", scope)},
ltv AS (
SELECT c_date cohort_date, c_camp campaign_path, ${LTV_MEASURES}
FROM finx
WHERE c_date >= {ltv_from:String} AND c_date <= {ltv_to:String}
GROUP BY c_date, c_camp)
SELECT * FROM ltv ORDER BY cohort_date, campaign_path
FORMAT JSONEachRow`;
}

/** The newest transaction of the caller's scope (restricted: their scoped users'). */
export function buildLtvDataThroughSql(scope: ScopeSql = ALL_SCOPE_SQL): string {
  return `SELECT toString(max(a.event_time)) data_through, count() n
FROM ${txFrom(scope, "a")}
WHERE a.auth_user_id = {auth_user_id:String}
FORMAT JSONEachRow`;
}

/** The newest trial of the active snapshot's members in scope — the same read
 * as revenueTrials' import cut-off (member filters ignored: it marks how far
 * the snapshot goes, not a slice). Binds the snapshot versions. */
export function buildLtvMembersThroughSql(scope: ScopeSql = ALL_SCOPE_SQL): string {
  return `SELECT toString(max(fc.trial_event_time)) data_through, count() n
FROM ${cohortsFrom(scope, "fc")}
WHERE fc.auth_user_id = {auth_user_id:String}
  AND fc.warehouse_version = {warehouse_version:String}
  AND fc.classification_version = {classification_version:String}
FORMAT JSONEachRow`;
}

/** ISO UTC; null for no rows, the DateTime64 zero value or anything unparseable
 * (both data_through and members_through rows). */
export function parseLtvDataThrough(row: { data_through?: unknown; n?: unknown } | null | undefined): string | null {
  if (!row || n(row.n) === 0) return null;
  const text = s(row.data_through).trim();
  if (text.startsWith("1970-01-01")) return null;
  const match = DATETIME_RE.exec(text);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function ltvRowsFromRaw(raw: ReadonlyArray<Record<string, unknown>>): CohortLtvRow[] {
  return raw.map((row) => ({
    cohort_date: s(row.cohort_date),
    campaign_path: s(row.campaign_path),
    trial_users: n(row.trial_users),
    rev: LTV_CHECKPOINTS.map((day) => round2(n(row[`rev_${day}`]))),
  }));
}

// ---- runner -------------------------------------------------------------------------------

async function jsonRows<T>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return (await result.json()) as T[];
}

/** The snapshot the curve reads. Restricted: the one the gate validated for this
 * request (no state read; stale = the gate's verdict), null when the handle
 * carries none. All scope: the state row read directly — unlike
 * materializedSnapshot, which turns a failed read into "none" for the list's
 * dynamic fallback, a failed read throws here (a 5xx the client retries); only
 * a missing or unvalidated snapshot is null ("not ready"). */
async function ltvSnapshot(
  supabase: SupabaseLikeClient,
  authUserId: string,
  scope: ScopeSql,
): Promise<{ state: CohortSnapshotState; active: { warehouse_version: string; classification_version: string }; gateStale: boolean | null } | null> {
  if (scope.restricted) {
    const snapshot = scope.snapshot;
    if (!snapshot) return null;
    return {
      state: snapshot.state,
      active: { warehouse_version: snapshot.warehouseVersion, classification_version: snapshot.classificationVersion },
      gateStale: snapshot.staleSince != null,
    };
  }
  const state = await getCohortSnapshotState(supabase, authUserId);
  const active = activeCohortSnapshotVersion(state);
  return state && active ? { state, active, gateStale: null } : null;
}

/** data_through, members_through and (all scope) the live warehouse
 * fingerprint together, then the curve over the resolved range (skipped
 * without data). Restricted: the gate's snapshot or a 409; the data owner
 * without a validated snapshot gets ok: false (no dynamic fallback — the curve
 * is defined on the snapshot only). */
export async function runCohortLtv(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: CohortRequest | Record<string, unknown>;
  scope?: ScopeSql;
}): Promise<CohortLtvResponse> {
  const started = Date.now();
  const scope = input.scope ?? ALL_SCOPE_SQL;
  const request = cohortLtvRequest(input.request);
  // Validates the dates, their order and the filters (CohortRequestError →
  // 400) before any read.
  const nreq = normalizeCohortRequest(request);
  assertLtvDateOrder(nreq.dateFrom, nreq.dateTo);
  const snapshot = await ltvSnapshot(input.supabase, input.authUserId, scope);
  const base = {
    ok: true,
    source: "clickhouse" as const,
    action: "ltv" as const,
    checkpoints: [...LTV_CHECKPOINTS],
  };
  if (!snapshot) {
    if (scope.restricted) throw new ScopeSnapshotNotReadyError("snapshot_missing");
    return {
      ...base,
      ok: false,
      generated_at: new Date().toISOString(),
      query_duration_ms: Date.now() - started,
      data_through: null,
      members_through: null,
      snapshot_stale: null,
      range: null,
      rows: [],
      diagnostics: { active_snapshot_version: "", snapshot_generated_at: null, current_warehouse_version: null, rows: 0, trial_users: 0 },
      error: LTV_SNAPSHOT_NOT_READY,
    };
  }
  const { state, active, gateStale } = snapshot;

  type ThroughRow = { data_through?: unknown; n?: unknown };
  const throughParams: Record<string, unknown> = { auth_user_id: input.authUserId };
  const membersParams: Record<string, unknown> = { auth_user_id: input.authUserId, ...active };
  const [[throughRow], [membersRow], fingerprint] = await Promise.all([
    jsonRows<ThroughRow>(input.clickhouse, buildLtvDataThroughSql(scope), throughParams),
    jsonRows<ThroughRow>(input.clickhouse, buildLtvMembersThroughSql(scope), membersParams),
    // Tenant-wide, so never for a restricted member (their freshness is the
    // gate's). Best effort: unread, freshness is unknown, never claimed current.
    scope.restricted
      ? Promise.resolve(null)
      : getWarehouseFingerprint(input.clickhouse, input.authUserId).catch((error) => {
        if (error instanceof ScopeViolation) throw error;
        return null;
      }),
  ]);
  const dataThrough = parseLtvDataThrough(throughRow);
  const membersThrough = parseLtvDataThrough(membersRow);
  const snapshotStale = scope.restricted ? gateStale : fingerprint ? fingerprint.warehouse_version !== active.warehouse_version : null;
  const range = dataThrough ? resolveLtvRange(nreq.dateFrom, nreq.dateTo, dataThrough) : null;

  let rows: CohortLtvRow[] = [];
  if (range) {
    const params: Record<string, unknown> = { auth_user_id: input.authUserId };
    const query = buildCohortLtvQuery(request, active, params, range, scope);
    rows = ltvRowsFromRaw(await jsonRows<Record<string, unknown>>(input.clickhouse, query, params));
  }
  return {
    ...base,
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    data_through: dataThrough,
    members_through: membersThrough,
    snapshot_stale: snapshotStale,
    range,
    rows,
    diagnostics: {
      active_snapshot_version: `${active.warehouse_version}:${active.classification_version}`,
      snapshot_generated_at: state.active_generated_at ?? null,
      current_warehouse_version: fingerprint?.warehouse_version ?? null,
      rows: rows.length,
      trial_users: rows.reduce((sum, row) => sum + row.trial_users, 0),
    },
  };
}
