// Server-side Users / Payment Analytics computation for clickhouse-users.
//
// One canonical row per user_id. Lifecycle (trial / first_subscription /
// renewal levels / upsell slots / token) comes from the SHARED parity-proven
// classifier (classifier.ts) — stored transaction_type is diagnostic only.
// Revenue is aggregated over ALL of a user's transactions (net over non-failed),
// exactly like the legacy computeUsers money fields. Users WITHOUT a successful
// trial (failed-only) are still listed (LEFT JOIN), with null lifecycle.
//
// No raw_payload / normalized_payload / credentials are ever returned — only
// aggregates and the email the current table already displays.

import type { ClickHouseClientLike } from "./types.ts";
import { classifierSQL, CLASSIFIER_TABLE } from "./classifier.ts";
import { FACT_SUBSCRIPTIONS_TABLE } from "./factSubscriptions.ts";
import {
  activeSubscriptionWhereClause,
  cancelledSubscriptionExpr,
} from "./factSubscriptions.ts";
import type {
  UsersDetailsResponse,
  UsersFilters,
  UsersRequest,
  UsersResponse,
  UsersRow,
  UsersSummary,
  UsersTriState,
  SubscriptionDataStatus,
} from "./usersContract.ts";

const CH = CLASSIFIER_TABLE;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_IN_VALUES = 500;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Allowlisted sort fields — the frontend can NEVER pass an arbitrary SQL column.
const SORT_ALLOWLIST: Record<string, string> = {
  first_trial_date: "first_trial_date",
  country_code: "country_code",
  card_type: "card_type",
  has_failed_payment: "has_failed_payment",
  latest_decline_reason: "latest_decline_reason",
  latest_decline_stage: "latest_decline_stage",
  failed_payment_count: "failed_payment_count",
  latest_decline_date: "latest_decline_date",
  total_revenue: "total_revenue",
  has_refund: "has_refund",
  total_refund_usd: "total_refund_usd",
  renewal_count: "renewal_count",
  user_ltv: "user_ltv",
  gross_revenue: "gross_revenue_usd",
  net_revenue: "net_revenue_usd",
  first_subscription_date: "first_subscription_date",
  token_revenue: "token_net_revenue",
  upsell_revenue: "upsell_revenue",
};

export class UsersRequestError extends Error {}

function round2(x: number): number {
  return Math.floor(x * 100 + 0.5) / 100;
}
function n(v: unknown): number {
  const p = Number(v ?? 0);
  return Number.isFinite(p) ? p : 0;
}
function s(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}
function b(v: unknown): boolean {
  return v === 1 || v === true || v === "1" || v === "true";
}

export function normalizeUsersAction(action: unknown): "list" | "details" | "options" | "summary" {
  switch (action) {
    case "details": return "details";
    case "options": return "options";
    case "summary": return "summary";
    case "list":
    case undefined:
    case null: return "list";
    default: throw new UsersRequestError(`Unsupported action: ${String(action)}`);
  }
}

function validDate(v: unknown, field: string): string | null {
  if (v == null || v === "") return null;
  const raw = s(v).trim();
  if (!DATE_RE.test(raw)) throw new UsersRequestError(`Invalid ${field} (expected YYYY-MM-DD): ${raw}`);
  return raw;
}
function triState(v: unknown): UsersTriState {
  return v === "yes" || v === "no" ? v : "all";
}
function stringArray(v: unknown, field: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new UsersRequestError(`Filter ${field} must be an array.`);
  const out = Array.from(new Set(v.map((x) => s(x).trim()).filter(Boolean)));
  if (out.length > MAX_IN_VALUES) throw new UsersRequestError(`Filter ${field} too large (max ${MAX_IN_VALUES}).`);
  return out;
}

export interface NormalizedUsersRequest {
  action: "list" | "details" | "options" | "summary";
  dateFrom: string | null;
  dateTo: string | null;
  filters: UsersFilters;
  sortField: string; // already mapped to a safe SQL column
  sortDir: "asc" | "desc";
  page: number;
  pageSize: number;
  nowIso: string;
  userId: string | null;
}

export function normalizeUsersRequest(req: UsersRequest): NormalizedUsersRequest {
  const f = req.filters ?? {};
  const sortKey = s(req.sort?.field || "first_trial_date");
  const sortField = SORT_ALLOWLIST[sortKey];
  if (!sortField) throw new UsersRequestError(`Unsupported sort field: ${sortKey}`);
  const page = Math.max(1, Math.floor(n(req.pagination?.page) || 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n(req.pagination?.page_size) || DEFAULT_PAGE_SIZE)));
  const nowMs = req.now ? Date.parse(s(req.now)) : Date.now();
  // ClickHouse DateTime64 param format: "YYYY-MM-DD HH:MM:SS.mmm" (space, no Z).
  const nowIso = new Date(Number.isFinite(nowMs) ? nowMs : Date.now()).toISOString().replace("T", " ").replace("Z", "");
  return {
    action: normalizeUsersAction(req.action),
    dateFrom: validDate(req.date_from, "date_from"),
    dateTo: validDate(req.date_to, "date_to"),
    filters: {
      first_sub: triState(f.first_sub),
      refund: triState(f.refund),
      active_subscription: triState(f.active_subscription),
      payment_failed: triState(f.payment_failed),
      failed_attempts_min: Math.max(0, Math.floor(n(f.failed_attempts_min))),
      funnel: stringArray(f.funnel, "funnel"),
      campaign_path: stringArray(f.campaign_path, "campaign_path"),
      campaign_id: stringArray(f.campaign_id, "campaign_id"),
      media_buyer: stringArray(f.media_buyer, "media_buyer"),
      country: stringArray(f.country, "country"),
      card_type: stringArray(f.card_type, "card_type"),
      currency: stringArray(f.currency, "currency"),
      decline_reason: stringArray(f.decline_reason, "decline_reason"),
      search: s(f.search).trim().slice(0, 200),
    },
    sortField,
    sortDir: req.sort?.direction === "asc" ? "asc" : "desc",
    page,
    pageSize,
    nowIso,
    userId: req.user_id ? s(req.user_id) : null,
  };
}

// Parameter-safe IN clause: numbered {p_<prefix>_<i>:String} placeholders.
function inClause(column: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const ph = values.map((v, i) => {
    const key = `p_${prefix}_${i}`;
    params[key] = v;
    return `{${key}:String}`;
  });
  return `${column} IN (${ph.join(", ")})`;
}

// The per-user aggregate CTEs (classifier + lifecycle + all-rows + join).
// Produces one row per user_id in `useragg` with every UsersRow field.
function userAggCTE(authUserId: string, params: Record<string, unknown>, nowIso: string): string {
  params.auth_user_id = authUserId;
  params.now = nowIso; // bound for activeSubscriptionWhereClause()'s {now:DateTime64}
  return `WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")}
, life AS (
  SELECT uid,
    any(c_funnel) cohort_funnel, any(c_camp) cohort_campaign, any(c_date) cohort_date,
    anyIf(formatDateTime(et, '%Y-%m-%d'), lt = 'trial') first_trial_date,
    anyIf(amt, lt = 'trial') first_trial_amount_original,
    anyIf(cur, lt = 'trial') first_trial_currency,
    anyIf(g, lt = 'trial') first_trial_amount_usd,
    maxIf(1, is_success = 1 AND lvl = 1) has_first_sub,
    anyIf(formatDateTime(et, '%Y-%m-%d'), is_success = 1 AND lvl = 1) first_subscription_date,
    anyIf(g, is_success = 1 AND lvl = 1) first_subscription_amount_usd,
    countIf(is_success = 1 AND lvl >= 2) renewal_count,
    max(lvl) highest_subscription_level,
    argMax(lt, et) lifecycle_state,
    maxIf(1, is_success = 1 AND lt = 'upsell') has_upsell,
    countIf(is_success = 1 AND slot = 1) upsell_1_count,
    countIf(is_success = 1 AND slot = 2) upsell_2_count,
    countIf(is_success = 1 AND slot = 3) upsell_3_count,
    countIf(is_success = 1 AND slot >= 4) upsell_extra_count,
    round(sumIf(g, is_success = 1 AND lt = 'upsell'), 2) upsell_revenue,
    round(sumIf(g, is_success = 1 AND slot IN (1, 2, 3)), 2) upsell_slot_gross,
    countIf(is_success = 1 AND lt = 'token_purchase') token_purchase_count,
    round(sumIf(g, is_success = 1 AND lt = 'token_purchase'), 2) token_gross_revenue,
    round(sumIf(rr, lt = 'token_purchase' OR (statusType IN ('refund','chargeback') AND tokenAmt)), 2) token_refund
  FROM fin GROUP BY uid
),
allrows AS (
  SELECT user_id uid,
    argMin(normalized_email, if(normalized_email != '', event_time, toDateTime64('2999-12-31 00:00:00', 3, 'UTC'))) pemail,
    argMin(normalized_email, if(normalized_email != '', event_time, toDateTime64('2999-12-31 00:00:00', 3, 'UTC'))) nemail,
    argMin(funnel, event_time) pfunnel,
    any(media_buyer) pmedia_buyer,
    argMin(utm_source, event_time) putm,
    argMin(country_code, (multiIf(country_code = '', 2, is_success = 1, 0, 1), event_time)) pcountry,
    argMin(card_type, (multiIf(card_type = '', 2, is_success = 1, 0, 1), event_time)) pcard,
    round(sumIf(floor(net_amount_usd * 100 + 0.5) / 100, status != 'failed'), 2) net_rev,
    round(sumIf(gross_amount_usd, is_success = 1), 2) gross_rev,
    round(sum(floor(refund_amount_usd * 100 + 0.5) / 100), 2) refund_amt,
    countIf(is_success = 1) successful_payment_count,
    countIf(is_failed = 1) failed_payment_count,
    argMax(decline_reason, if(is_failed = 1, event_time, toDateTime64('1970-01-01 00:00:00', 3, 'UTC'))) latest_decline_reason,
    argMax(payment_stage, if(is_failed = 1, event_time, toDateTime64('1970-01-01 00:00:00', 3, 'UTC'))) latest_decline_stage,
    if(countIf(is_failed = 1) > 0, formatDateTime(maxIf(event_time, is_failed = 1), '%Y-%m-%d'), '') latest_decline_date,
    argMin(round(toFloat64(gross_amount_usd), 2), (multiIf(is_success = 1 AND transaction_type NOT IN ('upsell', 'token_purchase'), 0, 1), event_time)) plan_price,
    max(is_success = 1 AND transaction_type NOT IN ('upsell', 'token_purchase')) has_plan
  FROM ${CH} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY user_id
),
subs AS (
  SELECT normalized_email nemail,
    countIf(${activeSubscriptionWhereClause()}) active_count,
    maxIf(1, ${activeSubscriptionWhereClause()}) is_active,
    argMax(status, synced_at) sub_status,
    maxIf(1, ${cancelledSubscriptionExpr()}) is_cancelled,
    argMaxIf(toString(cancelled_at), synced_at, ${cancelledSubscriptionExpr()}) cancelled_at
  FROM ${FACT_SUBSCRIPTIONS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY normalized_email
),
useragg AS (
  SELECT
    ar.uid user_id,
    ar.pemail email,
    if(ar.pcountry = '', NULL, ar.pcountry) country_code,
    if(ar.pcard = '', 'unknown', ar.pcard) card_type,
    ar.pmedia_buyer media_buyer,
    ar.putm utm_source,
    ar.pfunnel funnel,
    ifNull(l.cohort_campaign, 'unknown') campaign_path,
    ifNull(l.cohort_funnel, ar.pfunnel) cohort_funnel,
    nullIf(l.cohort_date, '') cohort_date,
    nullIf(l.first_trial_date, '') first_trial_date,
    ifNull(l.first_trial_amount_original, 0) first_trial_amount_original,
    ifNull(l.first_trial_currency, '') first_trial_currency,
    ifNull(l.first_trial_amount_usd, 0) first_trial_amount_usd,
    if(ar.has_plan, ar.plan_price, NULL) plan_price,
    (ifNull(l.has_first_sub, 0) = 1) has_first_subscription,
    nullIf(l.first_subscription_date, '') first_subscription_date,
    ifNull(l.first_subscription_amount_usd, 0) first_subscription_amount_usd,
    ifNull(l.renewal_count, 0) renewal_count,
    ifNull(l.highest_subscription_level, 0) highest_subscription_level,
    ifNull(l.lifecycle_state, '') lifecycle_state,
    ar.net_rev total_revenue,
    ar.gross_rev gross_revenue_usd,
    ar.net_rev net_revenue_usd,
    (ar.refund_amt > 0) has_refund,
    ar.refund_amt total_refund_usd,
    ar.net_rev user_ltv,
    ar.successful_payment_count successful_payment_count,
    ar.failed_payment_count failed_payment_count,
    (ar.failed_payment_count > 0) has_failed_payment,
    ar.latest_decline_reason latest_decline_reason,
    ar.latest_decline_stage latest_decline_stage,
    ar.latest_decline_date latest_decline_date,
    (ifNull(l.has_upsell, 0) = 1) has_upsell,
    ifNull(l.upsell_1_count, 0) upsell_1_count,
    ifNull(l.upsell_2_count, 0) upsell_2_count,
    ifNull(l.upsell_3_count, 0) upsell_3_count,
    ifNull(l.upsell_extra_count, 0) upsell_extra_count,
    ifNull(l.upsell_revenue, 0) upsell_revenue,
    ifNull(l.token_purchase_count, 0) token_purchase_count,
    ifNull(l.token_gross_revenue, 0) token_gross_revenue,
    round(ifNull(l.token_gross_revenue, 0) - ifNull(l.token_refund, 0), 2) token_net_revenue,
    round(ifNull(l.upsell_slot_gross, 0) + (ifNull(l.token_gross_revenue, 0) - ifNull(l.token_refund, 0)), 2) addon_revenue,
    (ifNull(sb.is_active, 0) = 1) active_subscription,
    ifNull(sb.active_count, 0) active_subscription_count,
    sb.sub_status subscription_status,
    (ifNull(sb.is_cancelled, 0) = 1) cancelled,
    sb.cancelled_at cancelled_at
  FROM allrows ar
  LEFT JOIN life l ON l.uid = ar.uid
  LEFT JOIN subs sb ON sb.nemail = ar.nemail
)`;
}

// Build the WHERE clause from the normalized filters (parameter-safe).
function userWhere(nreq: NormalizedUsersRequest, params: Record<string, unknown>): string {
  const c: string[] = [];
  const f = nreq.filters;
  if (nreq.dateFrom) { params.date_from = nreq.dateFrom; c.push(`first_trial_date IS NOT NULL AND first_trial_date >= {date_from:String}`); }
  if (nreq.dateTo) { params.date_to = nreq.dateTo; c.push(`first_trial_date IS NOT NULL AND first_trial_date <= {date_to:String}`); }
  if (f.first_sub === "yes") c.push(`has_first_subscription`);
  if (f.first_sub === "no") c.push(`NOT has_first_subscription`);
  if (f.refund === "yes") c.push(`has_refund`);
  if (f.refund === "no") c.push(`NOT has_refund`);
  if (f.payment_failed === "yes") c.push(`has_failed_payment`);
  if (f.payment_failed === "no") c.push(`NOT has_failed_payment`);
  if (f.active_subscription === "yes") c.push(`active_subscription`);
  if (f.active_subscription === "no") c.push(`NOT active_subscription`);
  if (f.failed_attempts_min > 0) { params.fa_min = f.failed_attempts_min; c.push(`failed_payment_count >= {fa_min:UInt32}`); }
  const country = inClause("country_code", f.country, "co", params); if (country) c.push(country);
  const card = inClause("card_type", f.card_type, "ct", params); if (card) c.push(card);
  const cpath = inClause("campaign_path", f.campaign_path, "cp", params); if (cpath) c.push(cpath);
  const fun = inClause("cohort_funnel", f.funnel, "fn", params); if (fun) c.push(fun);
  const mb = inClause("media_buyer", f.media_buyer, "mb", params); if (mb) c.push(mb);
  const cur = inClause("first_trial_currency", f.currency, "cur", params); if (cur) c.push(cur);
  const dr = inClause("latest_decline_reason", f.decline_reason, "dr", params); if (dr) c.push(dr);
  if (f.search) {
    params.search = f.search;
    c.push(`(positionCaseInsensitive(email, {search:String}) > 0 OR positionCaseInsensitive(user_id, {search:String}) > 0)`);
  }
  return c.length ? `WHERE ${c.join(" AND ")}` : "";
}

function toRow(r: Record<string, unknown>): UsersRow {
  return {
    user_id: s(r.user_id),
    email: s(r.email),
    country_code: r.country_code == null ? null : s(r.country_code),
    card_type: s(r.card_type) || "unknown",
    media_buyer: s(r.media_buyer),
    utm_source: r.utm_source == null || r.utm_source === "" ? null : s(r.utm_source),
    funnel: s(r.funnel),
    campaign_path: s(r.campaign_path) || "unknown",
    cohort_id: `${s(r.cohort_funnel) || "unknown"}_${s(r.campaign_path) || "unknown"}_${s(r.cohort_date)}`,
    cohort_date: r.cohort_date ? s(r.cohort_date) : null,
    cohort_funnel: s(r.cohort_funnel),
    first_trial_date: r.first_trial_date ? s(r.first_trial_date) : null,
    first_trial_amount_original: n(r.first_trial_amount_original),
    first_trial_currency: s(r.first_trial_currency),
    first_trial_amount_usd: round2(n(r.first_trial_amount_usd)),
    plan_price: r.plan_price == null ? null : round2(n(r.plan_price)),
    plan_name: r.plan_price == null ? null : `$${round2(n(r.plan_price)).toFixed(2)}`,
    has_first_subscription: b(r.has_first_subscription),
    first_subscription_date: r.first_subscription_date ? s(r.first_subscription_date) : null,
    first_subscription_amount_usd: round2(n(r.first_subscription_amount_usd)),
    renewal_count: n(r.renewal_count),
    highest_subscription_level: n(r.highest_subscription_level),
    lifecycle_state: s(r.lifecycle_state),
    total_revenue: round2(n(r.total_revenue)),
    gross_revenue_usd: round2(n(r.gross_revenue_usd)),
    net_revenue_usd: round2(n(r.net_revenue_usd)),
    has_refund: b(r.has_refund),
    total_refund_usd: round2(n(r.total_refund_usd)),
    user_ltv: round2(n(r.user_ltv)),
    successful_payment_count: n(r.successful_payment_count),
    failed_payment_count: n(r.failed_payment_count),
    has_failed_payment: b(r.has_failed_payment),
    latest_decline_reason: r.latest_decline_reason ? s(r.latest_decline_reason) : null,
    latest_decline_stage: r.latest_decline_stage ? s(r.latest_decline_stage) : null,
    latest_decline_message: null,
    latest_decline_date: r.latest_decline_date ? s(r.latest_decline_date) : null,
    has_upsell: b(r.has_upsell),
    upsell_1_count: n(r.upsell_1_count),
    upsell_2_count: n(r.upsell_2_count),
    upsell_3_count: n(r.upsell_3_count),
    upsell_extra_count: n(r.upsell_extra_count),
    upsell_revenue: round2(n(r.upsell_revenue)),
    token_purchase_count: n(r.token_purchase_count),
    token_gross_revenue: round2(n(r.token_gross_revenue)),
    token_net_revenue: round2(n(r.token_net_revenue)),
    addon_revenue: round2(n(r.addon_revenue)),
    active_subscription: b(r.active_subscription),
    active_subscription_count: n(r.active_subscription_count),
    subscription_status: r.subscription_status ? s(r.subscription_status) : null,
    renews: null,
    period_ends_at: null,
    cancelled: b(r.cancelled),
    cancelled_at: r.cancelled_at ? s(r.cancelled_at) : null,
    cancellation_reason: null,
  };
}

async function subscriptionDataStatus(client: ClickHouseClientLike, authUserId: string): Promise<SubscriptionDataStatus> {
  try {
    const rs = await client.query({
      query: `SELECT count() AS c FROM ${FACT_SUBSCRIPTIONS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String}`,
      query_params: { auth_user_id: authUserId },
      format: "JSONEachRow",
    });
    const rows = (await rs.json()) as Array<{ c?: number | string }>;
    return n(rows[0]?.c) > 0 ? "ready" : "empty_source";
  } catch {
    return "failed";
  }
}

async function scanDiag(client: ClickHouseClientLike, authUserId: string): Promise<{ users_scanned: number; transactions_scanned: number; missing_fx: number }> {
  const rs = await client.query({
    query: `SELECT uniqExact(user_id) AS u, count() AS t, countIf(fx_status IN ('missing_currency','missing_fx_rate','invalid_amount')) AS fx
      FROM ${CH} FINAL WHERE auth_user_id = {auth_user_id:String}`,
    query_params: { auth_user_id: authUserId },
    format: "JSONEachRow",
  });
  const r = ((await rs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  return { users_scanned: n(r.u), transactions_scanned: n(r.t), missing_fx: n(r.fx) };
}

// ---- Entrypoints ---------------------------------------------------------

export async function runUsersList(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: UsersRequest }): Promise<UsersResponse> {
  const started = Date.now();
  const nreq = normalizeUsersRequest(input.request);
  const params: Record<string, unknown> = {};
  const cte = userAggCTE(input.authUserId, params, nreq.nowIso);
  const where = userWhere(nreq, params);
  const offset = (nreq.page - 1) * nreq.pageSize;
  params.limit = nreq.pageSize;
  params.offset = offset;
  const nullsLast = nreq.sortDir === "asc" ? "NULLS LAST" : "NULLS LAST";
  const sql = `${cte}
SELECT *, count() OVER () AS total_rows
FROM useragg
${where}
ORDER BY ${nreq.sortField} ${nreq.sortDir === "asc" ? "ASC" : "DESC"} ${nullsLast}, user_id ASC
LIMIT {limit:UInt32} OFFSET {offset:UInt32}
FORMAT JSONEachRow`;

  const [rs, subStatus, scan] = await Promise.all([
    input.clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow" }),
    subscriptionDataStatus(input.clickhouse, input.authUserId),
    scanDiag(input.clickhouse, input.authUserId).catch(() => ({ users_scanned: 0, transactions_scanned: 0, missing_fx: 0 })),
  ]);
  const raw = (await rs.json()) as Array<Record<string, unknown>>;
  const totalRows = raw.length ? n(raw[0].total_rows) : 0;
  const rows = raw.map(toRow);
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    pagination: { page: nreq.page, page_size: nreq.pageSize, total_rows: totalRows, total_pages: Math.max(1, Math.ceil(totalRows / nreq.pageSize)) },
    rows,
    summary: {},
    filter_options: {},
    diagnostics: {
      users_scanned: scan.users_scanned,
      transactions_scanned: scan.transactions_scanned,
      missing_identity: 0,
      missing_fx: scan.missing_fx,
      subscription_data_status: subStatus,
    },
  };
}

export async function runUsersSummary(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: UsersRequest }): Promise<UsersResponse> {
  const started = Date.now();
  const nreq = normalizeUsersRequest(input.request);
  const params: Record<string, unknown> = {};
  const cte = userAggCTE(input.authUserId, params, nreq.nowIso);
  const where = userWhere(nreq, params);
  const sql = `${cte}
SELECT
  count() AS total_users,
  countIf(first_trial_date IS NOT NULL) AS trial_users,
  countIf(has_upsell) AS upsell_users,
  countIf(has_first_subscription) AS first_subscription_users,
  countIf(active_subscription) AS active_subscription_users,
  countIf(cancelled) AS cancelled_users,
  countIf(has_refund) AS refund_users,
  countIf(has_failed_payment) AS failed_payment_users,
  round(sum(gross_revenue_usd), 2) AS gross_revenue_usd,
  round(sum(net_revenue_usd), 2) AS net_revenue_usd
FROM useragg ${where}
FORMAT JSONEachRow`;
  const rs = await input.clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow" });
  const r = ((await rs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  const summary: UsersSummary = {
    total_users: n(r.total_users),
    trial_users: n(r.trial_users),
    upsell_users: n(r.upsell_users),
    first_subscription_users: n(r.first_subscription_users),
    active_subscription_users: n(r.active_subscription_users),
    cancelled_users: n(r.cancelled_users),
    refund_users: n(r.refund_users),
    failed_payment_users: n(r.failed_payment_users),
    gross_revenue_usd: round2(n(r.gross_revenue_usd)),
    net_revenue_usd: round2(n(r.net_revenue_usd)),
  };
  return {
    ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    pagination: { page: 1, page_size: 0, total_rows: summary.total_users, total_pages: 1 },
    rows: [], summary, filter_options: {},
    diagnostics: { users_scanned: 0, transactions_scanned: 0, missing_identity: 0, missing_fx: 0, subscription_data_status: await subscriptionDataStatus(input.clickhouse, input.authUserId) },
  };
}

export async function runUsersOptions(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: UsersRequest }): Promise<UsersResponse> {
  const started = Date.now();
  const nreq = normalizeUsersRequest(input.request);
  const params: Record<string, unknown> = {};
  const cte = userAggCTE(input.authUserId, params, nreq.nowIso);
  const sql = `${cte}
SELECT 'funnel' dim, cohort_funnel value, '' label, count() cnt FROM useragg WHERE cohort_funnel != '' GROUP BY cohort_funnel
UNION ALL SELECT 'campaign_path' dim, campaign_path value, '' label, count() FROM useragg WHERE campaign_path != '' GROUP BY campaign_path
UNION ALL SELECT 'country' dim, ifNull(country_code, '') value, '' label, count() FROM useragg WHERE country_code IS NOT NULL GROUP BY country_code
UNION ALL SELECT 'card_type' dim, card_type value, '' label, count() FROM useragg WHERE card_type != '' GROUP BY card_type
UNION ALL SELECT 'media_buyer' dim, media_buyer value, '' label, count() FROM useragg WHERE media_buyer != '' GROUP BY media_buyer
UNION ALL SELECT 'currency' dim, first_trial_currency value, '' label, count() FROM useragg WHERE first_trial_currency != '' GROUP BY first_trial_currency
FORMAT JSONEachRow`;
  const rs = await input.clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow" });
  const rows = (await rs.json()) as Array<{ dim: string; value: string; cnt: number | string }>;
  const fo = { funnel: [] as string[], campaign_path: [] as string[], campaign_id: [] as Array<{ campaign_id: string; campaign_name: string | null; trial_count: number }>, media_buyer: [] as Array<{ media_buyer: string; user_count: number }>, country: [] as Array<{ country_code: string; user_count: number }>, card_type: [] as Array<{ card_type: string; user_count: number }>, currency: [] as string[] };
  for (const row of rows) {
    const v = s(row.value); const cnt = n(row.cnt);
    if (!v) continue;
    if (row.dim === "funnel") fo.funnel.push(v);
    else if (row.dim === "campaign_path") fo.campaign_path.push(v);
    else if (row.dim === "country") fo.country.push({ country_code: v, user_count: cnt });
    else if (row.dim === "card_type") fo.card_type.push({ card_type: v, user_count: cnt });
    else if (row.dim === "media_buyer") fo.media_buyer.push({ media_buyer: v, user_count: cnt });
    else if (row.dim === "currency") fo.currency.push(v);
  }
  fo.funnel.sort(); fo.campaign_path.sort(); fo.currency.sort();
  fo.country.sort((x, y) => x.country_code.localeCompare(y.country_code));
  return {
    ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    pagination: { page: 1, page_size: 0, total_rows: 0, total_pages: 1 },
    rows: [], summary: {}, filter_options: fo,
    diagnostics: { users_scanned: 0, transactions_scanned: 0, missing_identity: 0, missing_fx: 0, subscription_data_status: await subscriptionDataStatus(input.clickhouse, input.authUserId) },
  };
}

export async function runUsersDetails(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: UsersRequest }): Promise<UsersDetailsResponse> {
  const started = Date.now();
  const nreq = normalizeUsersRequest(input.request);
  if (!nreq.userId) throw new UsersRequestError("action=details requires user_id.");
  const params: Record<string, unknown> = { auth_user_id: input.authUserId, uid: nreq.userId };
  const sql = `WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String} AND a.user_id = {uid:String}`, "")}
SELECT toString(et) event_time, lower(hex(MD5(tid))) transaction_id_hash, lt lifecycle_type, statusType status, is_success,
  amt amount_original, cur currency, g gross_usd, nn net_usd, rr refund_usd, lvl subscription_level, slot upsell_slot
FROM fin ORDER BY et
FORMAT JSONEachRow`;
  const rs = await input.clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow" });
  const raw = (await rs.json()) as Array<Record<string, unknown>>;
  const timeline = raw.map((r) => ({
    event_time: s(r.event_time),
    transaction_id_hash: s(r.transaction_id_hash),
    lifecycle_type: s(r.lifecycle_type),
    status: s(r.status) || (b(r.is_success) ? "success" : "other"),
    is_success: b(r.is_success),
    amount_original: n(r.amount_original),
    currency: s(r.currency),
    gross_usd: round2(n(r.gross_usd)),
    net_usd: round2(n(r.net_usd)),
    refund_usd: round2(n(r.refund_usd)),
    subscription_level: n(r.subscription_level),
    upsell_slot: n(r.upsell_slot),
  }));
  return {
    ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    user_id: nreq.userId, timeline,
    subscription: { active_subscription: false, active_subscription_count: 0, subscription_status: null, cancelled: false, cancelled_at: null, subscription_data_status: await subscriptionDataStatus(input.clickhouse, input.authUserId) },
  };
}

export { userAggCTE, userWhere, normalizeUsersAction as _normalizeUsersAction, SORT_ALLOWLIST, toRow };
