// Server-side Payment Pass Analytics. ClickHouse is the single source of truth
// for ALL metrics, including decline-derived ones (decline_reason is canonical —
// the legacy lossy client derivation is intentionally retired).
//
// Non-decline metrics reproduce the client EXACTLY (shadow-proven): the per-user
// sequential stage/level state machine reuses the shared classifier (lt/lvl) +
// ClickHouse window functions. Decline metrics (pass_rate_ex_if,
// insufficient_funds, top_decline_reason, decline table/charts) come straight
// from the warehouse decline_reason column.
//
// Aggregate-only responses: no raw_payload / normalized_payload / emails / ids.

import type { ClickHouseClientLike } from "./types.ts";
import { classifierSQL, CLASSIFIER_TABLE } from "./classifier.ts";

const CH = CLASSIFIER_TABLE;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IN = 500;
const LIFE = "lt IN ('first_subscription','renewal_2','renewal_3','renewal')";
const IF_REASON = "insufficient_funds";

export type SegmentDimension = "funnel" | "campaign_path" | "campaign_id" | "media_buyer" | "country" | "card_type" | "stage" | "decline_reason";
const DIM_COLUMN: Record<SegmentDimension, string> = {
  funnel: "funnel", campaign_path: "campaign_path", campaign_id: "campaign_id",
  media_buyer: "media_buyer", country: "country", card_type: "card_type",
  stage: "stage", decline_reason: "decline_key",
};

export interface PassMetrics {
  attempts: number; successful: number; failed: number; pass_rate: number;
  users_with_attempts: number; users_with_success: number; user_pass_rate: number; failed_users: number;
  first_attempts: number; first_success: number; first_attempt_pass_rate: number;
  first_sub_attempts: number; first_sub_success: number; first_sub_pass_rate: number;
  renewal_attempts: number; renewal_success: number; renewal_pass_rate: number;
  top_decline_reason: string | null; top_decline_reason_users: number;
  insufficient_funds_failures: number; eligible_attempts_ex_if: number; pass_rate_ex_if: number;
}
export interface SegmentRow extends PassMetrics { key: string; label: string; }
export interface StageRow extends PassMetrics { stage: string; label: string; }
export interface RenewalStageRow extends PassMetrics { level: number; label: string; }
export interface DeclineReasonRow {
  reason: string; label: string; failed_attempts: number; failed_users: number; share_of_failed: number;
  affected_funnels: string[]; most_common_stage: string | null; most_common_card_type: string | null; most_common_country: string | null;
}
export interface PassRatePoint { date: string; attempts: number; successful: number; failed: number; pass_rate: number; }

export interface PaymentAnalyticsFilters {
  date_basis: "transaction" | "cohort";
  date_from: string | null; date_to: string | null;
  funnel: string[]; campaign_path: string[]; campaign_id: string[]; media_buyer: string[];
  country: string[]; card_type: string[]; stage: string[]; decline_reason: string[]; transaction_type: string[];
  outcome: "all" | "success" | "failed";
}
export interface PaymentAnalyticsRequest {
  action?: string;
  filters?: Partial<PaymentAnalyticsFilters>;
  group_by?: SegmentDimension;
  first_tx_dimension?: SegmentDimension;
  renewal_dimension?: SegmentDimension;
}

export class PaymentAnalyticsRequestError extends Error {}

const n = (v: unknown): number => { const p = Number(v ?? 0); return Number.isFinite(p) ? p : 0; };
const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const pr = (a: number, b: number): number => (b > 0 ? a / b : 0);

function validDate(v: unknown, f: string): string | null {
  if (v == null || v === "") return null;
  const raw = s(v).trim();
  if (!DATE_RE.test(raw)) throw new PaymentAnalyticsRequestError(`Invalid ${f} (YYYY-MM-DD): ${raw}`);
  return raw;
}
function arr(v: unknown, f: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new PaymentAnalyticsRequestError(`Filter ${f} must be an array.`);
  const out = Array.from(new Set(v.map((x) => s(x).trim()).filter(Boolean)));
  if (out.length > MAX_IN) throw new PaymentAnalyticsRequestError(`Filter ${f} too large.`);
  return out;
}
const DIMS: SegmentDimension[] = ["funnel", "campaign_path", "campaign_id", "media_buyer", "country", "card_type", "stage", "decline_reason"];
function dim(v: unknown, fallback: SegmentDimension): SegmentDimension {
  return DIMS.includes(v as SegmentDimension) ? (v as SegmentDimension) : fallback;
}

export function normalizePaymentAnalyticsRequest(req: PaymentAnalyticsRequest): {
  action: string; filters: PaymentAnalyticsFilters; groupBy: SegmentDimension; firstTxDimension: SegmentDimension; renewalDimension: SegmentDimension;
} {
  const f = req.filters ?? {};
  return {
    action: s(req.action) || "analytics",
    filters: {
      date_basis: f.date_basis === "cohort" ? "cohort" : "transaction",
      date_from: validDate(f.date_from, "date_from"), date_to: validDate(f.date_to, "date_to"),
      funnel: arr(f.funnel, "funnel"), campaign_path: arr(f.campaign_path, "campaign_path"), campaign_id: arr(f.campaign_id, "campaign_id"),
      media_buyer: arr(f.media_buyer, "media_buyer"), country: arr(f.country, "country"), card_type: arr(f.card_type, "card_type"),
      stage: arr(f.stage, "stage"), decline_reason: arr(f.decline_reason, "decline_reason"), transaction_type: arr(f.transaction_type, "transaction_type"),
      outcome: f.outcome === "success" || f.outcome === "failed" ? f.outcome : "all",
    },
    groupBy: dim(req.group_by, "country"),
    firstTxDimension: dim(req.first_tx_dimension, "country"),
    renewalDimension: dim(req.renewal_dimension, "country"),
  };
}

function inClause(col: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const ph = values.map((v, i) => { const k = `p_${prefix}_${i}`; params[k] = v; return `{${k}:String}`; });
  return `${col} IN (${ph.join(", ")})`;
}

// The staged attempt list: every payment attempt (all rows), classified with the
// per-user sequential stage/level state machine, plus user-level attribution and
// the canonical warehouse decline_reason. `staged` exposes: uid, is_success,
// is_failed, rn, stage, sub_level, decline_key (failed only), funnel, campaign_path,
// campaign_id, media_buyer, country, card_type, event_day_tx, event_day_cohort, ttype.
//
// This dataset is UNFILTERED and date-basis-independent: it is materialized ONCE
// per request into a Memory table (see materializeStaged) so the expensive
// classifier scan runs a single time; every aggregation then filters that table.
export function stagedWith(authUserId: string, _filters: PaymentAnalyticsFilters, params: Record<string, unknown>): string {
  params.auth_user_id = authUserId;
  const stageFrom = (lv: string) => `multiIf(${lv}<=1,'first_subscription',${lv}=2,'renewal_2',${lv}=3,'renewal_3','renewal_n')`;
  // Both date-basis day columns are materialized so the shared dataset is filter-
  // and date-basis-independent (the aggregations pick the right one).
  return `WITH ${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")},
allrows AS (
  SELECT user_id uid, transaction_id tid, event_time et, toUnixTimestamp64Milli(event_time) ets,
    is_success, is_failed, status, decline_reason, funnel, campaign_path, campaign_id, media_buyer, country_code, card_type,
    toString(toDate(event_time)) event_day_tx, toString(cohort_date) event_day_cohort
  FROM ${CH} FINAL WHERE auth_user_id = {auth_user_id:String}
),
uattr AS (
  SELECT ar.uid uid,
    argMin(ar.funnel, (multiIf(ar.is_success=1 AND ar.lt_hint='trial',0, ar.is_success=1,1, 2), ar.ets)) efunnel,
    argMin(if(ar.campaign_path='','unknown',ar.campaign_path), (multiIf(ar.is_success=1 AND ar.lt_hint='trial',0, ar.is_success=1,1, 2), ar.ets)) ecampaign,
    argMin(if(ar.campaign_id='','unknown',ar.campaign_id), (multiIf(ar.is_success=1 AND ar.lt_hint='trial',0, ar.is_success=1,1, 2), ar.ets)) ecampaign_id,
    any(ar.media_buyer) emedia,
    argMin(ar.country_code, (multiIf(ar.country_code='',2, ar.is_success=1,0,1), ar.ets)) ecountry,
    argMin(ar.card_type, (multiIf(ar.card_type='',2, ar.is_success=1,0,1), ar.ets)) ecard
  FROM (SELECT a.*, ifNull(f.lt,'') lt_hint FROM allrows a LEFT JOIN fin f ON f.uid=a.uid AND f.tid=a.tid) ar
  GROUP BY ar.uid
),
joined AS (
  SELECT a.uid uid, a.tid tid, a.ets ets, a.is_success is_success, a.is_failed is_failed, a.decline_reason draw,
    a.event_day_tx event_day_tx, a.event_day_cohort event_day_cohort,
    f.lt lt, ifNull(f.lvl,0) lvl
  FROM allrows a LEFT JOIN fin f ON f.uid=a.uid AND f.tid=a.tid
),
seq AS (
  SELECT *,
    max(if(is_success=1 AND ${LIFE}, lvl, 0)) OVER (PARTITION BY uid ORDER BY ets, tid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) seq_before,
    max(if(is_success=1 AND lt='trial',1,0)) OVER (PARTITION BY uid ORDER BY ets, tid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) entry_before,
    row_number() OVER (PARTITION BY uid ORDER BY ets, tid) rn
  FROM joined
),
staged AS (
  SELECT s.uid uid, s.is_success is_success, s.is_failed is_failed, s.rn rn,
    s.event_day_tx event_day_tx, s.event_day_cohort event_day_cohort,
    ifNull(s.lt,'') ttype,
    if(s.is_failed=1, s.draw, '') decline_key,
    ua.efunnel funnel, ua.ecampaign campaign_path, ua.ecampaign_id campaign_id, ua.emedia media_buyer, ua.ecountry country, ua.ecard card_type,
    multiIf(is_success=1 AND lt='upsell','upsell', is_success=1 AND lt='trial','trial_or_entry',
      is_success=1 AND ${LIFE}, ${stageFrom("lvl")}, is_success=1,'unknown',
      seq_before>=1, ${stageFrom("(seq_before+1)")}, entry_before>=1,'first_subscription','trial_or_entry') stage,
    multiIf(is_success=1 AND lt IN ('upsell','trial'), CAST(NULL AS Nullable(Int32)), is_success=1 AND ${LIFE}, CAST(lvl AS Nullable(Int32)),
      is_success=1, CAST(NULL AS Nullable(Int32)), seq_before>=1, CAST(seq_before+1 AS Nullable(Int32)), entry_before>=1, CAST(1 AS Nullable(Int32)), CAST(NULL AS Nullable(Int32))) sub_level
  FROM seq s LEFT JOIN uattr ua ON ua.uid=s.uid
)`;
}

// The fixed projection materialized into the per-request Memory table — every
// column any aggregation needs, so no query has to re-run the classifier.
const STAGED_COLUMNS =
  "uid, is_success, is_failed, rn, event_day_tx, event_day_cohort, ttype, decline_key, " +
  "funnel, campaign_path, campaign_id, media_buyer, country, card_type, stage, sub_level";

// Date-basis picks which materialized day column the filters/day-series read.
function dayCol(filters: PaymentAnalyticsFilters): string {
  return filters.date_basis === "cohort" ? "event_day_cohort" : "event_day_tx";
}

// Server-generated (never user input) Memory-table name — SQL-safe identifier.
function stagedTableName(): string {
  return `pp_staged_${crypto.randomUUID().replace(/-/g, "")}`;
}

// Run the classifier ONCE and materialize the full staged attempt list into a
// per-request scratch table. All downstream aggregations read this table.
//
// The engine MUST be MergeTree (ClickHouse Cloud substitutes SharedMergeTree):
// its data lives in shared object storage and is therefore visible from every
// replica the load balancer may route a query to. A Memory / TEMPORARY table is
// node-local and would be invisible to the concurrent reads that land on other
// replicas — verified empirically on this Cloud endpoint.
async function materializeStaged(client: ClickHouseClientLike, authUserId: string, table: string): Promise<void> {
  const params: Record<string, unknown> = {};
  const staged = stagedWith(authUserId, EMPTY_FILTERS, params);
  await client.command({
    query: `CREATE TABLE ${table} ENGINE = MergeTree ORDER BY tuple() AS ${staged}\nSELECT ${STAGED_COLUMNS} FROM staged`,
    query_params: params,
  });
}

async function dropStagedTable(client: ClickHouseClientLike, table: string): Promise<void> {
  try { await client.command({ query: `DROP TABLE IF EXISTS ${table}` }); } catch { /* best-effort cleanup */ }
}

// Self-heal: drop scratch tables orphaned by an isolate that was torn down before
// its own DROP ran (only possible when a cold start exceeds the request timeout).
// Bounded by age > the max request lifetime, so it never touches a live table of a
// concurrent request; the name pattern is validated before dropping. Best-effort.
async function sweepStaleTables(client: ClickHouseClientLike): Promise<void> {
  try {
    const rs = await client.query({
      query: `SELECT name FROM system.tables WHERE database = currentDatabase() AND name LIKE 'pp_staged_%' AND metadata_modification_time < now() - INTERVAL 10 MINUTE\nFORMAT JSONEachRow`,
      format: "JSONEachRow",
    });
    for (const r of (await rs.json()) as Array<{ name?: string }>) {
      const name = String(r.name ?? "");
      if (/^pp_staged_[0-9a-f]{32}$/.test(name)) await client.command({ query: `DROP TABLE IF EXISTS ${name}` });
    }
  } catch { /* best-effort */ }
}

const EMPTY_FILTERS: PaymentAnalyticsFilters = {
  date_basis: "transaction", date_from: null, date_to: null,
  funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], card_type: [],
  stage: [], decline_reason: [], transaction_type: [], outcome: "all",
};

function attemptWhere(filters: PaymentAnalyticsFilters, params: Record<string, unknown>): string {
  const c: string[] = [];
  const dc = dayCol(filters);
  if (filters.date_from) { params.date_from = filters.date_from; c.push(`${dc} >= {date_from:String}`); }
  if (filters.date_to) { params.date_to = filters.date_to; c.push(`${dc} <= {date_to:String}`); }
  const add = (col: string, vals: string[], p: string) => { const cl = inClause(col, vals, p, params); if (cl) c.push(cl); };
  add("funnel", filters.funnel, "fn"); add("campaign_path", filters.campaign_path, "cp"); add("campaign_id", filters.campaign_id, "ci");
  add("media_buyer", filters.media_buyer, "mb"); add("country", filters.country, "co"); add("card_type", filters.card_type, "ct");
  add("stage", filters.stage, "st"); add("ttype", filters.transaction_type, "tt");
  if (filters.decline_reason.length) c.push(inClause("decline_key", filters.decline_reason, "dr", params));
  if (filters.outcome === "success") c.push(`is_success = 1`);
  if (filters.outcome === "failed") c.push(`is_failed = 1`);
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
}

// Aggregate columns for a PassMetrics group (raw counts; rates derived in TS).
const METRIC_COLS = `
  count() attempts, sum(is_success) successful, sum(is_failed) failed,
  uniqExact(uid) users_with_attempts, uniqExactIf(uid, is_success=1) users_with_success, uniqExactIf(uid, is_failed=1) failed_users,
  countIf(rn=1) first_attempts, countIf(rn=1 AND is_success=1) first_success,
  countIf(sub_level=1) first_sub_attempts, countIf(sub_level=1 AND is_success=1) first_sub_success,
  countIf(sub_level>=2) renewal_attempts, countIf(sub_level>=2 AND is_success=1) renewal_success,
  countIf(is_failed=1 AND decline_key='${IF_REASON}') insufficient_funds_failures`;

function toMetrics(r: Record<string, unknown>): PassMetrics {
  const attempts = n(r.attempts), successful = n(r.successful);
  const ifF = n(r.insufficient_funds_failures), eligible = attempts - ifF;
  const users = n(r.users_with_attempts), fa = n(r.first_attempts), fsa = n(r.first_sub_attempts), ra = n(r.renewal_attempts);
  return {
    attempts, successful, failed: n(r.failed), pass_rate: pr(successful, attempts),
    users_with_attempts: users, users_with_success: n(r.users_with_success), user_pass_rate: pr(n(r.users_with_success), users), failed_users: n(r.failed_users),
    first_attempts: fa, first_success: n(r.first_success), first_attempt_pass_rate: pr(n(r.first_success), fa),
    first_sub_attempts: fsa, first_sub_success: n(r.first_sub_success), first_sub_pass_rate: pr(n(r.first_sub_success), fsa),
    renewal_attempts: ra, renewal_success: n(r.renewal_success), renewal_pass_rate: pr(n(r.renewal_success), ra),
    top_decline_reason: null, top_decline_reason_users: 0,
    insufficient_funds_failures: ifF, eligible_attempts_ex_if: eligible, pass_rate_ex_if: pr(successful, eligible),
  };
}

async function json<T = Record<string, unknown>>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await client.query({ query: `${query}\nFORMAT JSONEachRow`, query_params: params, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}

// Attach top_decline_reason (by DISTINCT users, matching the client) to grouped rows.
async function attachTopDecline(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters, groupCol: string, rows: Array<{ key: string } & PassMetrics>): Promise<void> {
  if (!rows.length) return;
  const params: Record<string, unknown> = {};
  const where = attemptWhere(filters, params);
  const sql = `SELECT ${groupCol} gk, decline_key dr, uniqExact(uid) u FROM ${table} ${where ? where + " AND" : "WHERE"} is_failed=1 AND decline_key != '' GROUP BY ${groupCol}, decline_key`;
  const res = await json(client, sql, params);
  const best = new Map<string, { reason: string; users: number }>();
  for (const r of res) {
    const gk = s(r.gk), reason = s(r.dr), u = n(r.u);
    const cur = best.get(gk);
    // max distinct users; ties broken alphabetically so the pick is deterministic
    // regardless of ClickHouse's GROUP BY row order.
    if (!cur || u > cur.users || (u === cur.users && reason < cur.reason)) best.set(gk, { reason, users: u });
  }
  for (const row of rows) {
    const b = best.get(row.key);
    if (b) { row.top_decline_reason = b.reason; row.top_decline_reason_users = b.users; }
  }
}

async function groupBy(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters, dimension: SegmentDimension, sourceFilter = ""): Promise<SegmentRow[]> {
  const col = DIM_COLUMN[dimension];
  const params: Record<string, unknown> = {};
  const where = attemptWhere(filters, params);
  const extra = sourceFilter ? (where ? `${where} AND ${sourceFilter}` : `WHERE ${sourceFilter}`) : where;
  const sql = `SELECT ${col} k, ${METRIC_COLS} FROM ${table} ${extra} GROUP BY ${col}`;
  const res = await json(client, sql, params);
  const rows: SegmentRow[] = res.map((r) => ({ key: s(r.k) || (dimension === "decline_reason" ? "none" : "unknown"), label: s(r.k) || (dimension === "decline_reason" ? "Successful / no decline" : "unknown"), ...toMetrics(r) }));
  await attachTopDecline(client, table, filters, col, rows);
  return rows.sort((a, b) => b.attempts - a.attempts || a.label.localeCompare(b.label));
}

const STAGE_ORDER = ["trial_or_entry", "upsell", "first_subscription", "renewal_2", "renewal_3", "renewal_n"];
const STAGE_LABELS: Record<string, string> = {
  trial_or_entry: "Trial / Entry", upsell: "Upsell", first_subscription: "First Subscription",
  renewal_2: "Renewal 2", renewal_3: "Renewal 3", renewal_n: "Renewal 4+", unknown: "Unknown", first_transaction: "First Transaction",
};
const RENEWAL_LABELS: Record<number, string> = { 1: "First Subscription", 2: "Renewal 2", 3: "Renewal 3", 4: "Renewal 4", 5: "Renewal 5", 6: "Renewal 6+" };

async function ungrouped(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters, rowFilter: string): Promise<PassMetrics> {
  const params: Record<string, unknown> = {};
  const where = attemptWhere(filters, params);
  const extra = rowFilter ? (where ? `${where} AND ${rowFilter}` : `WHERE ${rowFilter}`) : where;
  const res = await json(client, `SELECT ${METRIC_COLS} FROM ${table} ${extra}`, params);
  const m = toMetrics(res[0] ?? {});
  // global top decline (by distinct users)
  const dp: Record<string, unknown> = {};
  const dw = attemptWhere(filters, dp);
  const dres = await json(client, `SELECT decline_key dr, uniqExact(uid) u FROM ${table} ${dw ? dw + " AND" : "WHERE"} is_failed=1 AND decline_key != ''${rowFilter ? " AND " + rowFilter : ""} GROUP BY decline_key ORDER BY u DESC, decline_key ASC LIMIT 1`, dp);
  if (dres[0]) { m.top_decline_reason = s(dres[0].dr); m.top_decline_reason_users = n(dres[0].u); }
  return m;
}

async function stageBreakdown(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters): Promise<StageRow[]> {
  const perStage = await groupBy(client, table, filters, "stage");
  const byKey = new Map(perStage.map((r) => [r.key, r]));
  const firstTx = await ungrouped(client, table, filters, "rn=1");
  const rows: StageRow[] = [{ stage: "first_transaction", label: STAGE_LABELS.first_transaction, ...firstTx }];
  for (const st of STAGE_ORDER) {
    const r = byKey.get(st);
    rows.push(r ? { stage: st, label: STAGE_LABELS[st] ?? st, ...r } : { stage: st, label: STAGE_LABELS[st] ?? st, ...emptyMetrics() });
  }
  return rows;
}

function emptyMetrics(): PassMetrics {
  return toMetrics({});
}

async function renewalBreakdown(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters): Promise<RenewalStageRow[]> {
  const params: Record<string, unknown> = {};
  const where = attemptWhere(filters, params);
  const sql = `SELECT least(sub_level, 6) lvl, ${METRIC_COLS} FROM ${table} ${where ? where + " AND" : "WHERE"} sub_level IS NOT NULL GROUP BY least(sub_level, 6)`;
  const res = await json(client, sql, params);
  const rows: RenewalStageRow[] = res.map((r) => ({ level: n(r.lvl), label: RENEWAL_LABELS[n(r.lvl)] ?? "Renewal 6+", key: String(n(r.lvl)), ...toMetrics(r) }));
  // top decline per level bucket
  const dp: Record<string, unknown> = {}; const dw = attemptWhere(filters, dp);
  const dres = await json(client, `SELECT least(sub_level,6) gk, decline_key dr, uniqExact(uid) u FROM ${table} ${dw ? dw + " AND" : "WHERE"} sub_level IS NOT NULL AND is_failed=1 AND decline_key!='' GROUP BY least(sub_level,6), decline_key`, dp);
  const best = new Map<string, { reason: string; users: number }>();
  for (const r of dres) { const gk = String(n(r.gk)); const cur = best.get(gk); const u = n(r.u), reason = s(r.dr); if (!cur || u > cur.users || (u === cur.users && reason < cur.reason)) best.set(gk, { reason, users: u }); }
  for (const row of rows) { const b = best.get(String(row.level)); if (b) { row.top_decline_reason = b.reason; row.top_decline_reason_users = b.users; } }
  return rows.sort((a, b) => a.level - b.level);
}

// Deterministic exact "most common value" within a group: the value with the
// highest count, ties broken alphabetically. Replaces ClickHouse topK(1) (which
// is approximate and resolves count-ties by nondeterministic scan order) so the
// same request always yields the same label. Proven == topK(1) on every clear
// winner; it only differs on ties, where it is now stable.
const modeOf = (col: string) =>
  `arraySort(t -> (-t.2, t.1), arrayMap(v -> (v, toInt32(countEqual(groupArray(${col}), v))), arrayDistinct(groupArray(${col}))))[1].1`;

async function declineAnalytics(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters, rowFilter = ""): Promise<DeclineReasonRow[]> {
  const params: Record<string, unknown> = {};
  const where = attemptWhere(filters, params);
  const extra = `${where ? where + " AND" : "WHERE"} is_failed=1 AND decline_key != ''${rowFilter ? " AND " + rowFilter : ""}`;
  const sql = `SELECT decline_key reason, count() failed_attempts, uniqExact(uid) failed_users,
    arraySort(groupUniqArray(funnel)) affected_funnels, ${modeOf("stage")} mc_stage, ${modeOf("card_type")} mc_card, ${modeOf("country")} mc_country
    FROM ${table} ${extra} GROUP BY decline_key`;
  const res = await json(client, sql, params);
  const totalFailed = res.reduce((a, r) => a + n(r.failed_attempts), 0);
  return res
    .map((r) => ({
      reason: s(r.reason), label: s(r.reason), failed_attempts: n(r.failed_attempts), failed_users: n(r.failed_users),
      share_of_failed: totalFailed > 0 ? n(r.failed_attempts) / totalFailed : 0,
      affected_funnels: (Array.isArray(r.affected_funnels) ? r.affected_funnels : []).map(s),
      most_common_stage: r.mc_stage != null ? s(r.mc_stage) : null,
      most_common_card_type: r.mc_card != null ? s(r.mc_card) : null,
      most_common_country: r.mc_country != null ? s(r.mc_country) : null,
    }))
    .sort((a, b) => b.failed_attempts - a.failed_attempts || a.reason.localeCompare(b.reason));
}

async function byDay(client: ClickHouseClientLike, table: string, filters: PaymentAnalyticsFilters): Promise<PassRatePoint[]> {
  const params: Record<string, unknown> = {};
  const where = attemptWhere(filters, params);
  const dc = dayCol(filters);
  const res = await json(client, `SELECT ${dc} date, count() attempts, sum(is_success) successful, sum(is_failed) failed FROM ${table} ${where} GROUP BY ${dc}`, params);
  return res
    .map((r) => ({ date: s(r.date), attempts: n(r.attempts), successful: n(r.successful), failed: n(r.failed), pass_rate: pr(n(r.successful), n(r.attempts)) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// Filter dropdown options are the DISTINCT values over the full unfiltered
// dataset — exactly what the Memory table holds (materialized with no filters).
async function filterOptions(client: ClickHouseClientLike, table: string): Promise<Record<string, string[]>> {
  const res = await json(client, `SELECT 'funnel' d, funnel v FROM ${table} GROUP BY funnel
UNION ALL SELECT 'campaign_path' d, campaign_path v FROM ${table} GROUP BY campaign_path
UNION ALL SELECT 'campaign_id' d, campaign_id v FROM ${table} GROUP BY campaign_id
UNION ALL SELECT 'media_buyer' d, media_buyer v FROM ${table} GROUP BY media_buyer
UNION ALL SELECT 'country' d, country v FROM ${table} GROUP BY country
UNION ALL SELECT 'card_type' d, card_type v FROM ${table} GROUP BY card_type
UNION ALL SELECT 'transaction_type' d, ttype v FROM ${table} GROUP BY ttype
UNION ALL SELECT 'decline_reason' d, decline_key v FROM ${table} WHERE decline_key != '' GROUP BY decline_key`, {});
  const out: Record<string, string[]> = { funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], card_type: [], transaction_type: [], decline_reason: [] };
  for (const r of res) { const d = s(r.d), v = s(r.v); if (v && out[d]) out[d].push(v); }
  for (const k of Object.keys(out)) out[k].sort();
  return out;
}

export interface PaymentAnalyticsBundle {
  ok: true; source: "clickhouse"; generated_at: string; query_duration_ms: number;
  summary: PassMetrics; first_summary: PassMetrics;
  funnel_rows: SegmentRow[]; stage_rows: StageRow[]; segment_rows: SegmentRow[]; first_tx_rows: SegmentRow[]; first_transaction_rows: SegmentRow[];
  renewal_rows: RenewalStageRow[]; renewal_segment_rows: SegmentRow[]; decline_rows: DeclineReasonRow[]; first_decline_rows: DeclineReasonRow[];
  time_points: PassRatePoint[]; trial_by_country: SegmentRow[]; filter_options: Record<string, string[]>;
  diagnostics: { attempts_scanned: number };
}

export async function runPaymentAnalytics(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: PaymentAnalyticsRequest }): Promise<PaymentAnalyticsBundle> {
  const started = Date.now();
  const { filters, groupBy: gb, firstTxDimension, renewalDimension } = normalizePaymentAnalyticsRequest(input.request);
  const c = input.clickhouse, a = input.authUserId;
  // Run the classifier ONCE: materialize the full staged attempt list into a
  // per-request Memory table, then run every aggregation against that table.
  const table = stagedTableName();
  // Materialize the shared dataset once; concurrently self-heal any orphaned
  // scratch tables (overlaps the CREATE, so it adds no latency).
  await Promise.all([materializeStaged(c, a, table), sweepStaleTables(c)]);
  try {
    const [summary, first_summary, funnel_rows, stage_rows, segment_rows, first_tx_rows, renewal_rows, renewal_segment_rows, decline_rows, first_decline_rows, time_points, trial_by_country, filter_options] = await Promise.all([
      ungrouped(c, table, filters, ""),
      ungrouped(c, table, filters, "rn=1"),
      groupBy(c, table, filters, "funnel"),
      stageBreakdown(c, table, filters),
      groupBy(c, table, filters, gb),
      groupBy(c, table, filters, firstTxDimension, "rn=1"),
      renewalBreakdown(c, table, filters),
      groupBy(c, table, filters, renewalDimension, "sub_level IS NOT NULL"),
      declineAnalytics(c, table, filters),
      declineAnalytics(c, table, filters, "rn=1"),
      byDay(c, table, filters),
      groupBy(c, table, filters, "country", "stage='trial_or_entry'"),
      filterOptions(c, table),
    ]);
    return {
      ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
      summary, first_summary, funnel_rows, stage_rows, segment_rows, first_tx_rows, first_transaction_rows: first_tx_rows,
      renewal_rows, renewal_segment_rows, decline_rows, first_decline_rows, time_points, trial_by_country, filter_options,
      diagnostics: { attempts_scanned: summary.attempts },
    };
  } finally {
    await dropStagedTable(c, table);
  }
}

export { groupBy as _groupBy, ungrouped as _ungrouped, toMetrics as _toMetrics };
