// Dashboard "Daily trials" (clickhouse-revenue action trials_daily): how many
// trials started per UTC day, by funnel and by GEO, read from the SAME active
// cohort snapshot Revenue Intelligence and Cohorts serve.
//
// Definitions (fixed — never re-derived here):
//  - trial  = one fact_user_cohorts row of the active snapshot (the user's
//    cohort anchor), counted uniqExact(canonical_user_id): the identity of the
//    Cohorts "Trial" column. analytics_transactions is never read, so
//    transaction_type = 'trial' plays no part;
//  - day    = fc.cohort_date, the UTC day of the anchor payment;
//  - funnel = fc.campaign_path ('' / 'unknown' → "Unknown", as RI's by_funnel);
//  - GEO    = the RAW fc.country (no upper() / trim in SQL, so a GEO row equals
//    Cohorts filtered to that country); '' → "Unknown". Never a billing / BIN
//    country.
//
// One grouped statement serves both dimensions and the previous window (bucket
// 'prev'); every user has exactly one row per snapshot version, so summing the
// (bucket, path, country) groups stays exact. A second statement, owner /
// all-scope only, reads the import cut-off (max trial_event_time over the
// snapshot, member filters ignored on purpose: it marks the import, not a
// slice). It never runs for a funnel-restricted member: a tenant-wide max would
// leak other funnels' activity, and a scoped one would make a stopped funnel's
// real zeros look like "not imported yet".
//
// Pure module: no Deno, no fetch, no clock (now injected). Vitest imports the
// src/services stub. Every export carries "Trials" / "trials" in its name so
// the stub's `export *` never collides with revenueIntelligence.ts.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { activeCohortMemberWhere } from "./cohortMembership.ts";
import type { CohortFilters } from "./cohortContract.ts";
import { ALL_SCOPE_SQL, cohortsFrom, type ScopeSql } from "./scopeSql.ts";
import { bucketEndDay, bucketStart, normalizeRevenueFilters, RevenueRequestError, revenueSnapshot } from "./revenueIntelligence.ts";
import type {
  RevenueIntelligenceRequest,
  RevenueTrialsDaily,
  RevenueTrialsRow,
  TrialsBucket,
  TrialsBucketState,
} from "./revenueIntelligenceContract.ts";

export const TRIALS_MAX_SPAN_DAYS = 180;
export const TRIALS_DEFAULT_SPAN_DAYS = 30;
/** A cut-off at or after this UTC hour completes its day. */
export const TRIALS_PARTIAL_CUTOFF_UTC_HOUR = 23;
export const TRIALS_MIX_TOP = 3;
export const TRIALS_RESTRICTED_NOTE = "Funnel-restricted view: trials of the customers acquired through your funnels.";

const TRIALS_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** toString(DateTime64) as ClickHouse prints it ("YYYY-MM-DD hh:mm:ss.sss"). */
const TRIALS_DATETIME_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)Z?$/;
const DAY_MS = 86_400_000;
const UNKNOWN = "Unknown";

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Code-unit order: the same on the server and in every browser locale. */
function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A YYYY-MM-DD that is a real calendar day (2026-02-30 is refused), or null. */
function trialsDay(value: unknown, field: string): string | null {
  const text = s(value).trim();
  if (!text) return null;
  if (!TRIALS_DATE_RE.test(text)) throw new RevenueRequestError(`Invalid ${field}: expected YYYY-MM-DD.`);
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    throw new RevenueRequestError(`Invalid ${field}: not a calendar day.`);
  }
  return text;
}

function addDays(day: string, days: number): string {
  const dateObj = new Date(`${day}T00:00:00Z`);
  dateObj.setUTCDate(dateObj.getUTCDate() + days);
  return dateObj.toISOString().slice(0, 10);
}

/** Inclusive number of days in from..to. */
function spanOf(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

// ---- Request ----------------------------------------------------------------

export interface TrialsRequest {
  action: "trials_daily";
  dateFrom: string;
  dateTo: string;
  bucket: TrialsBucket;
  filters: CohortFilters;
  filtersActive: boolean;
}

/** Validates before any I/O. Dates are optional (default: the last
 * TRIALS_DEFAULT_SPAN_DAYS days to today); a future date_to is clamped to
 * today, never refused. Everything else that is wrong is a 400. */
export function normalizeTrialsRequest(req: RevenueIntelligenceRequest, today: string): TrialsRequest {
  const requestedTo = trialsDay(req.date_to, "date_to") ?? today;
  const dateTo = requestedTo > today ? today : requestedTo;
  const dateFrom = trialsDay(req.date_from, "date_from") ?? addDays(dateTo, -(TRIALS_DEFAULT_SPAN_DAYS - 1));
  if (dateFrom > dateTo) throw new RevenueRequestError("date_from must not be after date_to.");
  if (spanOf(dateFrom, dateTo) > TRIALS_MAX_SPAN_DAYS) {
    throw new RevenueRequestError(`trials_daily window is limited to ${TRIALS_MAX_SPAN_DAYS} days.`);
  }
  const rawBucket: unknown = req.bucket;
  if (rawBucket === "month") throw new RevenueRequestError("trials_daily supports day and week buckets only.");
  const bucket: TrialsBucket = rawBucket === "week" ? "week" : "day";
  // Every Cohorts member filter works (the card sends campaign_path / country).
  const { filters, active } = normalizeRevenueFilters(req.filters);
  return { action: "trials_daily", dateFrom, dateTo, bucket, filters, filtersActive: active };
}

export interface TrialsWindow {
  /** Requested window aligned to whole buckets (ISO weeks at week grain). */
  effFrom: string;
  effTo: string;
  /** The previous window of the same length, ending the day before effFrom. */
  prevFrom: string;
  prevTo: string;
}

export function trialsWindow(dateFrom: string, dateTo: string, bucket: TrialsBucket): TrialsWindow {
  const effFrom = bucketStart(dateFrom, bucket);
  const effTo = bucketEndDay(dateTo, bucket);
  const span = spanOf(effFrom, effTo);
  return { effFrom, effTo, prevFrom: addDays(effFrom, -span), prevTo: addDays(effFrom, -1) };
}

// ---- SQL --------------------------------------------------------------------

/** S-A: trials per (bucket, campaign_path, country) over [prevFrom, to]; the
 * previous window collapses into the bucket 'prev'. A key-prefix range scan of
 * fact_user_cohorts (ORDER BY auth_user_id, warehouse_version,
 * classification_version, cohort_date) — no JOIN, no classifier pass. The
 * aliases bkt / cpath / geo shadow no fc column (aliases are visible in WHERE). */
export function buildTrialsDailySql(
  params: Record<string, unknown>,
  authUserId: string,
  win: { prevFrom: string; from: string; to: string },
  bucket: TrialsBucket,
  memberWhere = "",
  scope: ScopeSql = ALL_SCOPE_SQL,
): string {
  params.auth_user_id = authUserId; // the runner pre-binds warehouse_version / classification_version
  params.tr_prev_from = win.prevFrom;
  params.tr_from = win.from;
  params.tr_to = win.to;
  // Must agree with bucketStart (revenueIntelligence.ts): ISO Monday weeks.
  const b = bucket === "week" ? "toStartOfWeek(fc.cohort_date, 1)" : "fc.cohort_date";
  return `SELECT if(fc.cohort_date >= toDate({tr_from:String}), toString(${b}), 'prev') bkt,
  fc.campaign_path cpath,
  fc.country geo,
  uniqExact(fc.canonical_user_id) trials
FROM ${cohortsFrom(scope, "fc")}
WHERE fc.auth_user_id = {auth_user_id:String}
  AND fc.warehouse_version = {warehouse_version:String}
  AND fc.classification_version = {classification_version:String}
  AND fc.cohort_date >= toDate({tr_prev_from:String})
  AND fc.cohort_date <= toDate({tr_to:String})
  ${memberWhere}
GROUP BY bkt, cpath, geo
ORDER BY bkt, cpath, geo
FORMAT JSONEachRow`;
}

/** S-B (non-restricted callers only, see the header): the import cut-off. */
export function buildTrialsDataThroughSql(params: Record<string, unknown>, authUserId: string, scope: ScopeSql = ALL_SCOPE_SQL): string {
  params.auth_user_id = authUserId;
  return `SELECT toString(max(fc.trial_event_time)) data_through, count() n
FROM ${cohortsFrom(scope, "fc")}
WHERE fc.auth_user_id = {auth_user_id:String}
  AND fc.warehouse_version = {warehouse_version:String}
  AND fc.classification_version = {classification_version:String}
FORMAT JSONEachRow`;
}

/** The S-B row as ISO UTC ("YYYY-MM-DDThh:mm:ss.sssZ"); null for an empty
 * snapshot, the DateTime64 zero value, or anything unparseable. */
export function parseTrialsDataThrough(row: { data_through?: unknown; n?: unknown } | null | undefined): string | null {
  if (!row || n(row.n) === 0) return null;
  const text = s(row.data_through).trim();
  if (text.startsWith("1970-01-01")) return null;
  const match = TRIALS_DATETIME_RE.exec(text);
  if (!match) return null;
  const parsed = new Date(`${match[1]}T${match[2]}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

// ---- Pure assembly ----------------------------------------------------------

export interface TrialsGroupRow { bkt: string; cpath: string; geo: string; trials: number }

/** Bucket starts from effFrom to effTo, stepping one day or one week. */
export function trialsAxis(effFrom: string, effTo: string, bucket: TrialsBucket): string[] {
  const step = bucket === "week" ? 7 : 1;
  const axis: string[] = [];
  for (let day = effFrom; day <= effTo; day = addDays(day, step)) axis.push(day);
  return axis;
}

/** Completeness of each bucket.
 *  - Restricted: the bucket containing today is partial, earlier ones are
 *    complete (data_through is never read for them, so there is no no_data).
 *  - Otherwise, with no cut-off: everything is no_data.
 *  - Otherwise, L = day(data_through), F = min(L + 1 when the cut-off is at or
 *    after TRIALS_PARTIAL_CUTOFF_UTC_HOUR else L, today); a bucket [s, e] is
 *    complete when e < F, no_data when s > L, partial otherwise. */
export function trialsAxisState(
  axis: readonly string[],
  bucket: TrialsBucket,
  dataThrough: string | null,
  today: string,
  restricted: boolean,
): TrialsBucketState[] {
  const lastDay = (start: string) => (bucket === "week" ? addDays(start, 6) : start);
  if (restricted) return axis.map((start) => (lastDay(start) < today ? "complete" : "partial"));
  if (!dataThrough) return axis.map(() => "no_data");
  const cutDay = dataThrough.slice(0, 10);
  const firstOpen = Number(dataThrough.slice(11, 13)) >= TRIALS_PARTIAL_CUTOFF_UTC_HOUR ? addDays(cutDay, 1) : cutDay;
  const bound = firstOpen < today ? firstOpen : today;
  return axis.map((start) => (lastDay(start) < bound ? "complete" : start > cutDay ? "no_data" : "partial"));
}

const trialsFunnelKey = (cpath: string) => (cpath === "" || cpath === "unknown" ? UNKNOWN : cpath);
const trialsCountryKey = (geo: string) => (geo.trim() === "" ? UNKNOWN : geo);

/** Throws when the response would not reconcile (spec invariants; by
 * construction they hold — a failure is a bug, never shown as data). */
export function assertTrialsInvariants(result: Pick<RevenueTrialsDaily, "axis" | "totals" | "by_funnel" | "by_country">): void {
  const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
  const fail = (what: string) => { throw new Error(`trials_daily invariant violated: ${what}`); };
  const { totals } = result;
  if (totals.daily.length !== result.axis.length) fail("daily length");
  if (sum(totals.daily) !== totals.trials) fail("Σ daily");
  for (const [name, rows] of [["by_funnel", result.by_funnel], ["by_country", result.by_country]] as const) {
    if (sum(rows.map((row) => row.trials)) !== totals.trials) fail(`Σ ${name}.trials`);
    if (sum(rows.map((row) => row.prev_trials)) !== totals.prev_trials) fail(`Σ ${name}.prev_trials`);
    totals.daily.forEach((value, index) => {
      if (sum(rows.map((row) => row.cells[index] ?? 0)) !== value) fail(`Σ ${name}.cells[${index}]`);
    });
    for (const row of rows) {
      if (row.cells.length !== result.axis.length || sum(row.cells) !== row.trials) fail(`${name} ${row.key} cells`);
      if (sum(row.mix.map((entry) => entry.trials)) + row.mix_unknown > row.trials) fail(`${name} ${row.key} mix`);
    }
  }
}

/** Assembles the response from the S-A groups. Pure; the invariant tests pin
 * the reconciliation, the Unknown mapping and the previous-window accounting. */
export function assembleTrialsDaily(input: {
  rows: readonly TrialsGroupRow[];
  bucket: TrialsBucket;
  effFrom: string;
  effTo: string;
  prevFrom: string;
  prevTo: string;
  dataThrough: string | null;
  today: string;
  restricted: boolean;
  snapshot: { warehouse_version: string; classification_version: string };
  filtersActive: boolean;
}): Omit<RevenueTrialsDaily, "ok" | "source" | "action" | "generated_at" | "query_duration_ms"> {
  const axis = trialsAxis(input.effFrom, input.effTo, input.bucket);
  const axisIndex = new Map(axis.map((day, index) => [day, index]));
  type Acc = { key: string; trials: number; prev: number; cells: number[]; other: Map<string, number> };
  const funnels = new Map<string, Acc>();
  const countries = new Map<string, Acc>();
  const acc = (map: Map<string, Acc>, key: string): Acc => {
    let entry = map.get(key);
    if (!entry) {
      entry = { key, trials: 0, prev: 0, cells: axis.map(() => 0), other: new Map() };
      map.set(key, entry);
    }
    return entry;
  };
  const daily = axis.map(() => 0);
  let trials = 0;
  let prevTrials = 0;
  let scanned = 0;

  for (const row of input.rows) {
    const count = row.trials;
    if (!Number.isFinite(count) || count <= 0) continue;
    scanned += count;
    const funnel = trialsFunnelKey(row.cpath);
    const country = trialsCountryKey(row.geo);
    if (row.bkt === "prev") {
      acc(funnels, funnel).prev += count;
      acc(countries, country).prev += count;
      prevTrials += count;
      continue;
    }
    // A bucket off the axis would mean bucketStart and toStartOfWeek disagree
    // (pinned by a unit test): dropped from the cells, counted in trials_scanned.
    const index = axisIndex.get(row.bkt);
    if (index === undefined) continue;
    const byFunnel = acc(funnels, funnel);
    const byCountry = acc(countries, country);
    byFunnel.cells[index] += count;
    byFunnel.trials += count;
    byFunnel.other.set(country, (byFunnel.other.get(country) ?? 0) + count);
    byCountry.cells[index] += count;
    byCountry.trials += count;
    byCountry.other.set(funnel, (byCountry.other.get(funnel) ?? 0) + count);
    daily[index] += count;
    trials += count;
  }

  // Stopped keys (previous window only) are kept: they show as "stopped".
  const emit = (map: Map<string, Acc>): RevenueTrialsRow[] => [...map.values()]
    .filter((entry) => entry.trials > 0 || entry.prev > 0)
    .sort((a, b) => b.trials - a.trials || b.prev - a.prev || byKey(a.key, b.key))
    .map((entry) => {
      const ranked = [...entry.other].filter(([key]) => key !== UNKNOWN).sort((a, b) => b[1] - a[1] || byKey(a[0], b[0]));
      return {
        key: entry.key,
        trials: entry.trials,
        prev_trials: entry.prev,
        cells: entry.cells,
        mix: ranked.slice(0, TRIALS_MIX_TOP).map(([key, value]) => ({ key, trials: value })),
        mix_unknown: entry.other.get(UNKNOWN) ?? 0,
      };
    });

  const dataThrough = input.restricted ? null : input.dataThrough;
  const result = {
    bucket: input.bucket,
    date_from: input.effFrom,
    date_to: input.effTo,
    prev_from: input.prevFrom,
    prev_to: input.prevTo,
    axis,
    axis_state: trialsAxisState(axis, input.bucket, dataThrough, input.today, input.restricted),
    data_through: dataThrough,
    totals: {
      trials,
      prev_trials: prevTrials,
      daily,
      unknown_funnel: funnels.get(UNKNOWN)?.trials ?? 0,
      unknown_geo: countries.get(UNKNOWN)?.trials ?? 0,
    },
    by_funnel: emit(funnels),
    by_country: emit(countries),
    diagnostics: {
      snapshot_warehouse_version: input.snapshot.warehouse_version,
      snapshot_classification_version: input.snapshot.classification_version,
      trials_scanned: scanned,
      filters_active: input.filtersActive,
      note: "",
    },
  };
  assertTrialsInvariants(result);
  return result;
}

// ---- Runner -----------------------------------------------------------------

async function trialsJsonRows<T>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return (await result.json()) as T[];
}

export async function runRevenueTrialsDaily(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: RevenueIntelligenceRequest;
  /** ALL_SCOPE_SQL unless the caller is funnel-restricted (see the header). */
  scope?: ScopeSql;
  now?: Date;
}): Promise<RevenueTrialsDaily> {
  const started = Date.now();
  const scope = input.scope ?? ALL_SCOPE_SQL;
  const today = (input.now ?? new Date()).toISOString().slice(0, 10);
  const req = normalizeTrialsRequest({ ...input.request, action: "trials_daily" }, today);
  const win = trialsWindow(req.dateFrom, req.dateTo, req.bucket);
  // Restricted: the snapshot the gate validated (a missing one is a 409);
  // otherwise the active snapshot or the "not ready" body below.
  const active = await revenueSnapshot(input.supabase, input.authUserId, scope);
  if (!active) {
    return {
      ok: false, source: "clickhouse", action: "trials_daily", generated_at: new Date().toISOString(),
      query_duration_ms: Date.now() - started, bucket: req.bucket,
      date_from: win.effFrom, date_to: win.effTo, prev_from: win.prevFrom, prev_to: win.prevTo,
      axis: [], axis_state: [], data_through: null,
      totals: { trials: 0, prev_trials: 0, daily: [], unknown_funnel: 0, unknown_geo: 0 },
      by_funnel: [], by_country: [],
      diagnostics: { snapshot_warehouse_version: "", snapshot_classification_version: "", trials_scanned: 0, filters_active: false, note: "" },
      error: "cohort_snapshot_not_ready",
    };
  }
  const base = { auth_user_id: input.authUserId, warehouse_version: active.warehouse_version, classification_version: active.classification_version };
  // Sequential, like the bundle: both are cheap range scans, and the instance
  // serves every Dashboard section at once.
  let dataThrough: string | null = null;
  if (!scope.restricted) {
    const pD = { ...base } as Record<string, unknown>;
    const [row] = await trialsJsonRows<{ data_through?: unknown; n?: unknown }>(input.clickhouse, buildTrialsDataThroughSql(pD, input.authUserId, scope), pD);
    dataThrough = parseTrialsDataThrough(row);
  }
  const p = { ...base } as Record<string, unknown>;
  const memberWhere = activeCohortMemberWhere(req.filters, p, scope);
  const raw = await trialsJsonRows<Record<string, unknown>>(
    input.clickhouse,
    buildTrialsDailySql(p, input.authUserId, { prevFrom: win.prevFrom, from: win.effFrom, to: win.effTo }, req.bucket, memberWhere, scope),
    p,
  );
  // Only `trials` is numeric (UInt64 arrives quoted); the keys stay strings.
  const rows: TrialsGroupRow[] = raw.map((row) => ({ bkt: s(row.bkt), cpath: s(row.cpath), geo: s(row.geo), trials: n(row.trials) }));
  const assembled = assembleTrialsDaily({
    rows,
    bucket: req.bucket,
    effFrom: win.effFrom,
    effTo: win.effTo,
    prevFrom: win.prevFrom,
    prevTo: win.prevTo,
    dataThrough,
    today,
    restricted: scope.restricted,
    snapshot: active,
    filtersActive: req.filtersActive || scope.restricted,
  });
  if (scope.restricted) assembled.diagnostics.note = TRIALS_RESTRICTED_NOTE;
  // Never a tenant-wide counter (e.g. the snapshot's users_classified).
  return {
    ok: true, source: "clickhouse", action: "trials_daily",
    generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    ...assembled,
  };
}
