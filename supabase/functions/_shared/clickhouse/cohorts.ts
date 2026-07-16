// Server-side Cohorts computation for the clickhouse-cohorts Edge Function.
//
// The `list` SQL is the parity-proven cohort computation (526/526 cohort rows
// matched the real client oracle exactly: lifecycle, upsell, token, gross/net/
// refunds, D0..D60, FX). Stored transaction_type is NOT authoritative — the
// classifier recomputes lifecycle_type from each user's full history exactly as
// the client `classifyUserTransactions` does. Do not simplify this SQL.
//
// Money: gross uses raw gross_amount_usd; net/refund use per-row half-up
// 2-decimal normalization `floor(x*100+0.5)/100` (ClickHouse round() is banker's,
// the client uses Math.round half-up). Totals are recomputed from additive
// numerators/denominators in TS, never averaged from rows.
//
// Nothing here returns raw_payload / normalized_payload / raw emails / raw
// transaction ids / credentials — only aggregates and non-reversible id hashes.

import type { ClickHouseClientLike } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_SUPPORT_REQUESTS_TABLE } from "./schema.ts";
import { FACT_SUBSCRIPTIONS_TABLE } from "./factSubscriptions.ts";
import {
  emptyFilterOptions,
  filterOptionsFromRows,
  optionBranches,
  optionFiltersApplied,
  optionFlagColumns,
  optionsDiagnostics,
  type FilterOptionsResult,
} from "./cohortFilterOptions.ts";
import type {
  CohortAction,
  CohortAggregateRow,
  CohortDetailsResponse,
  CohortDiagnostics,
  CohortFxDiagnostics,
  CohortTokenDiagnostics,
  CohortFilters,
  CohortFiltersApplied,
  CohortRefundStatus,
  CohortRequest,
  CohortResponse,
  CohortTotals,
  CohortSupportDataStatus,
  SubscriptionDataStatus,
} from "./cohortContract.ts";

const CH = ANALYTICS_TRANSACTIONS_TABLE;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_MAX_RENEWAL_DEPTH = 6;
const MAX_IN_VALUES = 500;

/** Half-up to 2 decimals — mirrors the client round2 (Math.round based). */
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

// ---- Input validation -----------------------------------------------------

export class CohortRequestError extends Error {}

export function normalizeAction(action: unknown): CohortAction {
  switch (action) {
    case "list":
    case "cohorts":
    case undefined:
    case null:
      return "list";
    case "details":
    case "cohort_details":
      return "details";
    case "options":
    case "filter_options":
      return "options";
    default:
      throw new CohortRequestError(`Unsupported action: ${String(action)}`);
  }
}

function validDate(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  const raw = s(value).trim();
  if (!DATE_RE.test(raw)) throw new CohortRequestError(`Invalid ${field} (expected YYYY-MM-DD): ${raw}`);
  return raw;
}

function stringArray(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new CohortRequestError(`Filter ${field} must be an array of strings.`);
  const out = value.map((v) => s(v).trim()).filter(Boolean);
  if (out.length > MAX_IN_VALUES) throw new CohortRequestError(`Filter ${field} has too many values (max ${MAX_IN_VALUES}).`);
  return Array.from(new Set(out));
}

function normalizeRefundStatus(value: unknown): CohortRefundStatus {
  return value === "has" || value === "none" ? value : "all";
}

export interface NormalizedCohortRequest {
  action: CohortAction;
  dateFrom: string | null;
  dateTo: string | null;
  filters: CohortFilters;
  maxRenewalDepth: number;
  now: number;
  cohortKey: { cohort_date: string; funnel: string; campaign_path: string } | null;
}

export function normalizeCohortRequest(req: CohortRequest): NormalizedCohortRequest {
  const f = req.filters ?? {};
  const cohortKey = req.cohort_key
    ? {
        cohort_date: validDate(req.cohort_key.cohort_date, "cohort_key.cohort_date") ?? "",
        funnel: s(req.cohort_key.funnel),
        campaign_path: s(req.cohort_key.campaign_path),
      }
    : null;
  const depth = Number(req.max_renewal_depth);
  const nowMs = req.now ? Date.parse(s(req.now)) : Date.now();
  return {
    action: normalizeAction(req.action),
    dateFrom: validDate(req.date_from, "date_from"),
    dateTo: validDate(req.date_to, "date_to"),
    filters: {
      funnel: stringArray(f.funnel, "funnel"),
      campaign_path: stringArray(f.campaign_path, "campaign_path"),
      campaign_id: stringArray(f.campaign_id, "campaign_id"),
      traffic_source: stringArray(f.traffic_source, "traffic_source"),
      price_plan: stringArray(f.price_plan, "price_plan"),
      media_buyer: stringArray(f.media_buyer, "media_buyer"),
      country: stringArray(f.country, "country"),
      card_type: stringArray(f.card_type, "card_type"),
      currency: stringArray(f.currency, "currency"),
      transaction_type: stringArray(f.transaction_type, "transaction_type"),
      refund_status: normalizeRefundStatus(f.refund_status),
    },
    maxRenewalDepth: Number.isFinite(depth) ? Math.max(2, Math.min(12, Math.floor(depth))) : DEFAULT_MAX_RENEWAL_DEPTH,
    now: Number.isFinite(nowMs) ? nowMs : Date.now(),
    cohortKey,
  };
}

// ---- Parameter-safe IN clauses -------------------------------------------
// Each value becomes a numbered {p_<prefix>_<i>:String} placeholder bound via
// query_params — never string-interpolated. Injection-safe.

function inClause(column: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const ph = values.map((v, i) => {
    const key = `p_${prefix}_${i}`;
    params[key] = v;
    return `{${key}:String}`;
  });
  return `${column} IN (${ph.join(", ")})`;
}

// Which filters this Edge Function reproduced for the current request.
// campaign_id / traffic_source are attributed from the cohort-entry transaction;
// country / card_type / media_buyer / currency are user-level dimensions.
export function filtersApplied(filters: CohortFilters, dateFrom: string | null, dateTo: string | null): CohortFiltersApplied {
  return {
    date_range: Boolean(dateFrom || dateTo),
    funnel: filters.funnel.length > 0,
    campaign_path: filters.campaign_path.length > 0,
    refund_status: filters.refund_status !== "all",
    media_buyer: filters.media_buyer.length > 0,
    currency: filters.currency.length > 0,
    country: filters.country.length > 0,
    card_type: filters.card_type.length > 0,
    campaign_id: filters.campaign_id.length > 0,
    traffic_source: filters.traffic_source.length > 0,
    price_plan: false,
  };
}

// ---- The parity-proven classifier + aggregate ----------------------------

// User pre-filter for first-trial currency. Returns a keep-set semi-join, plus
// binds params. Selecting users this way keeps each matched user's FULL history
// (as the client does).
function userFilterCTE(filters: CohortFilters, params: Record<string, unknown>): { withKeep: string; joinKeep: string } {
  // Currency uses the user's first successful-trial currency (fallback first tx),
  // matching client currencyForUserTransactions.
  if (!filters.currency.length) return { withKeep: "", joinKeep: "" };
  const cur = inClause("cur", filters.currency, "cur", params);
  const keep = `
keep AS (
  SELECT uid FROM (
    SELECT user_id uid,
      argMin(currency, (multiIf(transaction_type = 'trial' AND is_success = 1, 0, 1), event_time)) cur
    FROM ${CH} FINAL
    WHERE auth_user_id = {auth_user_id:String}
    GROUP BY user_id
  ) WHERE ${cur}
),`;
  return { withKeep: keep, joinKeep: "INNER JOIN keep kp ON kp.uid = a.user_id" };
}

// The finalized classifier. `baseWhere` restricts the per-user scan (auth scope).
// `joinKeep` optionally semi-joins the currency keep-set.
export function classifierSQL(baseWhere: string, joinKeep: string): string {
  return `
base AS (
  SELECT a.user_id uid, a.transaction_id tid, a.event_time et, toUnixTimestamp64Milli(a.event_time) ets,
    a.normalized_email normalized_email, ifNull(a.source_updated_at, a.clickhouse_synced_at) source_updated_at,
    a.funnel funnel, a.campaign_path campaign_path,
    a.campaign_id campaign_id,
    ifNull(nullIf(JSONExtractString(a.normalized_payload, 'traffic_source'), ''), 'unknown') traffic_source,
    a.country_code country_code, a.card_type card_type, a.media_buyer media_buyer,
    multiIf(a.transaction_type = 'trial', 0, a.transaction_type = 'upsell', 1, a.transaction_type = 'first_subscription', 2,
      a.transaction_type IN ('renewal_2','renewal_3','renewal'), 3, 4) tprio,
    a.status status, a.is_success is_success,
    positionCaseInsensitive(a.billing_reason, 'upsell') > 0 upmark,
    ((a.currency = 'USD' AND (abs(toFloat64(a.original_amount) - 4.99) < 0.005 OR abs(toFloat64(a.original_amount) - 9.99) < 0.005 OR abs(toFloat64(a.original_amount) - 24.99) < 0.005))
      OR (a.currency = 'EUR' AND abs(toFloat64(a.original_amount) - 4.99) < 0.005)
      OR (a.currency = 'COP' AND abs(toFloat64(a.original_amount) - 17199) < 0.005)) tokenAmt,
    abs(toFloat64(a.original_amount) - 14.98) < 0.01 commonUp,
    multiIf(a.status = 'failed', 'failed_payment', a.status = 'refunded', 'refund', a.status = 'chargeback', 'chargeback', '') statusType,
    a.gross_amount_usd g, floor(a.net_amount_usd * 100 + 0.5) / 100 nn, floor(a.refund_amount_usd * 100 + 0.5) / 100 rr,
    a.currency cur, toFloat64(a.original_amount) amt, a.product_id pid, a.product_name pname
  FROM ${CH} AS a FINAL ${joinKeep}
  WHERE ${baseWhere}
),
elig AS (SELECT *, (statusType = '' AND NOT upmark AND NOT tokenAmt) lifeelig FROM base),
tr AS (
  SELECT uid, argMin(ets, (ets, tprio, tid)) trial_ts, min((ets, tprio, tid)) trial_key,
    argMin(toString(toDate(et)), (ets, tprio, tid)) c_date,
    argMin(funnel, (ets, tprio, tid)) c_funnel,
    argMin(if(campaign_path = '', 'unknown', campaign_path), (ets, tprio, tid)) c_camp,
    argMin(if(campaign_id = '', 'unknown', campaign_id), (ets, tprio, tid)) c_campaign_id,
    argMin(if(traffic_source = '', 'unknown', traffic_source), (ets, tprio, tid)) c_traffic_source
  FROM elig WHERE lifeelig GROUP BY uid
),
userdim AS (
  SELECT uid,
    argMin(country_code, (multiIf(country_code = '', 2, is_success = 1, 0, 1), ets, tid)) u_country,
    argMin(if(card_type = '', 'unknown', card_type), (multiIf(card_type = '', 2, is_success = 1, 0, 1), ets, tid)) u_card_type,
    argMin(if(media_buyer = '', 'Unknown', media_buyer), (ets, tid)) u_media_buyer,
    argMin(normalized_email, (multiIf(normalized_email = '', 2, is_success = 1, 0, 1), ets, tid)) u_normalized_email,
    max(source_updated_at) u_source_updated_at
  FROM base GROUP BY uid
),
cl AS (
  SELECT e.uid uid, e.tid tid, e.et et, e.ets ets,
    e.normalized_email normalized_email, e.source_updated_at source_updated_at,
    e.funnel funnel, e.campaign_path campaign_path, e.campaign_id campaign_id, e.traffic_source traffic_source,
    e.country_code country_code, e.card_type card_type, e.media_buyer media_buyer,
    e.tprio tprio, e.status status, e.is_success is_success, e.upmark upmark, e.tokenAmt tokenAmt,
    e.commonUp commonUp, e.statusType statusType, e.g g, e.nn nn, e.rr rr,
    e.cur cur, e.amt amt, e.pid pid, e.pname pname, e.lifeelig lifeelig,
    tr.trial_ts trial_ts, tr.trial_key trial_key, tr.c_date c_date, tr.c_funnel c_funnel, tr.c_camp c_camp,
	    tr.c_campaign_id c_campaign_id, tr.c_traffic_source c_traffic_source,
	    userdim.u_country u_country, userdim.u_card_type u_card_type, userdim.u_media_buyer u_media_buyer,
	    userdim.u_normalized_email u_normalized_email, userdim.u_source_updated_at u_source_updated_at
  FROM elig e INNER JOIN tr USING(uid)
  INNER JOIN userdim USING(uid)
  WHERE floor((e.ets - tr.trial_ts) / 86400000) >= 0
),
pretyped AS (
  SELECT *, floor((ets - trial_ts) / 86400000) d,
    multiIf(statusType != '', statusType, upmark, 'upsell', (NOT upmark) AND tokenAmt, 'token_purchase',
      lifeelig AND (ets, tprio, tid) = trial_key, 'trial',
      lifeelig AND (ets - trial_ts) <= 3600000 AND commonUp, 'upsell',
      lifeelig AND (ets - trial_ts) <= 172800000, 'token_purchase',
      lifeelig, 'lifecycle', 'upsell') pretype
  FROM cl
),
lifeidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) lvl FROM pretyped WHERE pretype = 'lifecycle' AND is_success = 1),
upsidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) slot FROM pretyped WHERE pretype = 'upsell' AND is_success = 1),
fin AS (
  SELECT p.uid uid, p.tid tid, p.et et, p.ets ets, p.tprio tprio, p.trial_ts trial_ts,
    p.is_success is_success, p.g g, p.nn nn, p.rr rr, p.d d, p.statusType statusType, p.tokenAmt tokenAmt,
    p.cur cur, p.amt amt, p.pid pid, p.pname pname,
    p.c_date c_date, p.c_funnel c_funnel, p.c_camp c_camp,
    p.c_campaign_id c_campaign_id, p.c_traffic_source c_traffic_source,
    p.u_country u_country, p.u_card_type u_card_type, p.u_media_buyer u_media_buyer,
    p.u_normalized_email u_normalized_email, p.u_source_updated_at u_source_updated_at,
    ifNull(li.lvl, 0) lvl, ifNull(ui.slot, 0) slot,
    multiIf(p.pretype != 'lifecycle', p.pretype, li.lvl = 1, 'first_subscription', li.lvl = 2, 'renewal_2', li.lvl = 3, 'renewal_3', 'renewal') lt
  FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid) LEFT JOIN upsidx ui USING(uid, tid)
)`;
}

// Raw per-cohort aggregate row from ClickHouse (money as raw sums; TS rounds).
export interface RawCohortRow {
  cohort_date: string; funnel: string; campaign_path: string;
  trial_users: number;
  gross_raw: number; refund_raw: number;
  d0_raw: number; d7_raw: number; d14_raw: number; d30_raw: number; d60_raw: number;
  trial_rev_raw: number; first_sub_rev_raw: number; renewal_rev_raw: number; upsell_rev_raw: number;
  first_subscription_users: number; renewal_users: number;
  r2: number; r3: number; r4: number; r5: number; r6: number;
  upsell_users: number; funnel_upsell_users: number; funnel_upsell_rev_raw: number;
  upsell_1_users: number; upsell_2_users: number; upsell_3_users: number; upsell_extra_users: number;
  u1_raw: number; u2_raw: number; u3_raw: number; uextra_raw: number;
  token_purchases: number; token_buyers: number; token_gross_raw: number; token_refund_raw: number;
  refund_users: number;
  support_users: number;
}

export function supportEmailsCTE(status: CohortSupportDataStatus = "ready"): string {
  if (status !== "ready") return `support_emails AS (SELECT '' AS normalized_email WHERE 0)`;
  return `support_emails AS (
  SELECT DISTINCT lowerUTF8(trim(BOTH ' ' FROM normalized_email)) AS normalized_email
  FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND lowerUTF8(trim(BOTH ' ' FROM normalized_email)) != ''
)`;
}

export function aggregateSelect(memberWhere = ""): string {
  return `
SELECT c_date cohort_date, c_funnel funnel, c_camp campaign_path, uniqExact(uid) trial_users,
  sum(if(is_success = 1, g, 0)) gross_raw, sum(rr) refund_raw,
  sum(if(is_success = 1 AND d = 0, nn, 0)) d0_raw, sum(if(is_success = 1 AND d <= 7, nn, 0)) d7_raw,
  sum(if(is_success = 1 AND d <= 14, nn, 0)) d14_raw, sum(if(is_success = 1 AND d <= 30, nn, 0)) d30_raw,
  sum(if(is_success = 1 AND d <= 60, nn, 0)) d60_raw,
  sumIf(nn, is_success = 1 AND lt = 'trial') trial_rev_raw,
  sumIf(nn, is_success = 1 AND lvl = 1) first_sub_rev_raw, sumIf(nn, is_success = 1 AND lvl >= 2) renewal_rev_raw,
  sumIf(nn, is_success = 1 AND lt = 'upsell') upsell_rev_raw,
  uniqExactIf(uid, lvl = 1) first_subscription_users, uniqExactIf(uid, lvl >= 2) renewal_users,
  uniqExactIf(uid, lvl = 2) r2, uniqExactIf(uid, lvl = 3) r3, uniqExactIf(uid, lvl = 4) r4, uniqExactIf(uid, lvl = 5) r5, uniqExactIf(uid, lvl = 6) r6,
  uniqExactIf(uid, is_success = 1 AND lt = 'upsell') upsell_users,
  uniqExactIf(uid, is_success = 1 AND lt = 'upsell') funnel_upsell_users, sumIf(g, is_success = 1 AND lt = 'upsell') funnel_upsell_rev_raw,
  uniqExactIf(uid, slot = 1) upsell_1_users, uniqExactIf(uid, slot = 2) upsell_2_users, uniqExactIf(uid, slot = 3) upsell_3_users, uniqExactIf(uid, slot >= 4) upsell_extra_users,
  sumIf(g, slot = 1) u1_raw, sumIf(g, slot = 2) u2_raw, sumIf(g, slot = 3) u3_raw, sumIf(g, slot >= 4) uextra_raw,
  countIf(is_success = 1 AND lt = 'token_purchase') token_purchases, uniqExactIf(uid, is_success = 1 AND lt = 'token_purchase') token_buyers,
  sumIf(g, is_success = 1 AND lt = 'token_purchase') token_gross_raw,
  sumIf(rr, lt = 'token_purchase' OR (statusType IN ('refund','chargeback') AND tokenAmt)) token_refund_raw,
  uniqExactIf(
    uid,
    lowerUTF8(trim(BOTH ' ' FROM u_normalized_email)) != ''
    AND lowerUTF8(trim(BOTH ' ' FROM u_normalized_email)) IN (SELECT normalized_email FROM support_emails)
  ) support_users
FROM fin
${memberWhere}
GROUP BY c_date, c_funnel, c_camp`;
}

// Member-level filters: every row in `fin` carries the same attributed
// campaign/traffic and user-level dimensions for its user, so this keeps full
// lifecycle/revenue rows for matching users and excludes whole non-matching users.
function memberFilterWhere(filters: CohortFilters, params: Record<string, unknown>): string {
  const conds: string[] = [];
  const campaign = inClause("c_campaign_id", filters.campaign_id, "cid", params);
  if (campaign) conds.push(campaign);
  const traffic = inClause("c_traffic_source", filters.traffic_source, "tsrc", params);
  if (traffic) conds.push(traffic);
  const country = inClause("u_country", filters.country, "country", params);
  if (country) conds.push(country);
  const card = inClause("u_card_type", filters.card_type, "card", params);
  if (card) conds.push(card);
  const media = inClause("u_media_buyer", filters.media_buyer, "mb", params);
  if (media) conds.push(media);
  return conds.length ? `WHERE ${conds.join(" AND ")}` : "";
}

// Cohort-level post-filters (date/funnel/campaign_path/refund) as a HAVING/WHERE
// wrapper on the aggregate — matches the client's filterCohortsWithDiagnostics.
function cohortPostFilter(nreq: NormalizedCohortRequest, params: Record<string, unknown>): string {
  const conds: string[] = [];
  if (nreq.dateFrom) { params.date_from = nreq.dateFrom; conds.push(`cohort_date >= {date_from:String}`); }
  if (nreq.dateTo) { params.date_to = nreq.dateTo; conds.push(`cohort_date <= {date_to:String}`); }
  const fn = inClause("funnel", nreq.filters.funnel, "fn", params);
  if (fn) conds.push(fn);
  const cp = inClause("campaign_path", nreq.filters.campaign_path, "cp", params);
  if (cp) conds.push(cp);
  if (nreq.filters.refund_status === "has") conds.push(`refund_raw > 0`);
  if (nreq.filters.refund_status === "none") conds.push(`refund_raw = 0`);
  return conds.length ? `HAVING ${conds.join(" AND ")}` : "";
}

function buildListQuery(nreq: NormalizedCohortRequest, params: Record<string, unknown>, supportStatus: CohortSupportDataStatus = "ready"): string {
  const { withKeep, joinKeep } = userFilterCTE(nreq.filters, params);
  const baseWhere = `a.auth_user_id = {auth_user_id:String}`;
  const memberWhere = memberFilterWhere(nreq.filters, params);
  const post = cohortPostFilter(nreq, params);
  return `WITH
${withKeep}
${supportEmailsCTE(supportStatus)},
${classifierSQL(baseWhere, joinKeep)}
, agg AS (${aggregateSelect(memberWhere)})
SELECT * FROM agg ${post}
FORMAT JSONEachRow`;
}

// ---- Map a raw aggregate row -> the frontend CohortAggregateRow -----------

function toAggregateRow(r: RawCohortRow): CohortAggregateRow {
  const gross = round2(n(r.gross_raw));
  const refunds = round2(n(r.refund_raw));
  const net = round2(n(r.gross_raw) - n(r.refund_raw));
  const d30 = round2(n(r.d30_raw));
  const trialUsers = n(r.trial_users);
  const tokenNet = round2(n(r.token_gross_raw) - n(r.token_refund_raw));
  const supportUsers = n(r.support_users);
  const u1 = n(r.u1_raw), u2 = n(r.u2_raw), u3 = n(r.u3_raw);
  const byLevel: Record<number, number> = {};
  for (const [lvl, v] of [[2, r.r2], [3, r.r3], [4, r.r4], [5, r.r5], [6, r.r6]] as const) {
    if (n(v) > 0) byLevel[lvl] = n(v);
  }
  return {
    cohort_date: s(r.cohort_date), funnel: s(r.funnel), campaign_path: s(r.campaign_path),
    trial_users: trialUsers,
    upsell_users: n(r.upsell_users),
    first_subscription_users: n(r.first_subscription_users),
    renewal_users: n(r.renewal_users),
    renewal_users_by_level: byLevel,
    refund_users: n(r.refund_users),
    support_users: supportUsers,
    support_rate: trialUsers ? (supportUsers / trialUsers) * 100 : 0,
    // Subscription metrics deferred (fact_subscriptions empty) — see Phase 4.
    active_users: 0, active_subscriptions: 0, cancelled_users: 0,
    user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
    trial_revenue: round2(n(r.trial_rev_raw)),
    upsell_revenue: round2(n(r.upsell_rev_raw)),
    first_subscription_revenue: round2(n(r.first_sub_rev_raw)),
    renewal_revenue: round2(n(r.renewal_rev_raw)),
    gross_revenue: gross, net_revenue: net, amount_refunded: refunds,
    revenue_d0: round2(n(r.d0_raw)), revenue_d7: round2(n(r.d7_raw)), revenue_d14: round2(n(r.d14_raw)),
    revenue_d30: d30, revenue_d60: round2(n(r.d60_raw)),
    net_revenue_1m: d30, ltv_1m_per_user: trialUsers ? round2(d30 / trialUsers) : 0,
    upsell_1_users: n(r.upsell_1_users), upsell_2_users: n(r.upsell_2_users), upsell_3_users: n(r.upsell_3_users), upsell_extra_users: n(r.upsell_extra_users),
    upsell_1_revenue: round2(u1), upsell_2_revenue: round2(u2), upsell_3_revenue: round2(u3), upsell_extra_revenue: round2(n(r.uextra_raw)),
    funnel_upsell_users: n(r.funnel_upsell_users), funnel_upsell_revenue: round2(n(r.funnel_upsell_rev_raw)),
    token_buyers: n(r.token_buyers), token_purchases: n(r.token_purchases),
    token_gross_revenue: round2(n(r.token_gross_raw)), token_net_revenue: tokenNet,
    addon_revenue: round2(u1 + u2 + u3 + tokenNet),
    fx_missing_transactions: 0, fx_missing_amount: 0,
    dedup: {
      active_user_hashes: [], active_subscription_hashes: [], refunded_user_hashes: [],
      cancelled_user_hashes: [], user_cancelled_user_hashes: [], auto_cancelled_user_hashes: [],
      cancelled_active_user_hashes: [], token_buyer_hashes: [],
    },
  };
}

function computeTotals(rows: CohortAggregateRow[]): CohortTotals {
  const sum = (f: (r: CohortAggregateRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const byLevel: Record<number, number> = {};
  for (const r of rows) for (const [lvl, v] of Object.entries(r.renewal_users_by_level)) byLevel[Number(lvl)] = (byLevel[Number(lvl)] ?? 0) + n(v);
  const trialUsers = sum((r) => r.trial_users);
  const supportUsers = sum((r) => r.support_users);
  const d30 = round2(sum((r) => r.revenue_d30));
  return {
    trial_users: trialUsers,
    first_subscription_users: sum((r) => r.first_subscription_users),
    active_users: 0, active_subscriptions: 0,
    renewal_users_by_level: byLevel,
    refund_users: sum((r) => r.refund_users),
    support_users: supportUsers,
    support_rate: trialUsers ? (supportUsers / trialUsers) * 100 : 0,
    gross_revenue: round2(sum((r) => r.gross_revenue)),
    net_revenue: round2(sum((r) => r.net_revenue)),
    amount_refunded: round2(sum((r) => r.amount_refunded)),
    revenue_d0: round2(sum((r) => r.revenue_d0)), revenue_d7: round2(sum((r) => r.revenue_d7)),
    revenue_d30: d30, revenue_d60: round2(sum((r) => r.revenue_d60)),
    ltv_1m_per_user: trialUsers ? round2(d30 / trialUsers) : 0,
    upsell_1_users: sum((r) => r.upsell_1_users), upsell_2_users: sum((r) => r.upsell_2_users), upsell_3_users: sum((r) => r.upsell_3_users),
    token_buyers: sum((r) => r.token_buyers), token_purchases: sum((r) => r.token_purchases),
    token_net_revenue: round2(sum((r) => r.token_net_revenue)),
    addon_revenue: round2(sum((r) => r.addon_revenue)),
  };
}

// ---- Subscription snapshot status (Phase 4) -------------------------------

export async function subscriptionDataStatus(client: ClickHouseClientLike, authUserId: string): Promise<SubscriptionDataStatus> {
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

export interface SupportDataProbe {
  support_data_status: CohortSupportDataStatus;
  support_requests: number;
  support_unique_emails: number;
}

export async function supportDataStatus(client: ClickHouseClientLike, authUserId: string): Promise<SupportDataProbe> {
  try {
    const exists = await client.query({
      query: `SELECT count() AS c FROM system.tables WHERE database = currentDatabase() AND name = {table:String}`,
      query_params: { table: FACT_SUPPORT_REQUESTS_TABLE },
      format: "JSONEachRow",
    });
    const existsRows = (await exists.json()) as Array<{ c?: number | string }>;
    if (n(existsRows[0]?.c) === 0) {
      return { support_data_status: "unavailable", support_requests: 0, support_unique_emails: 0 };
    }

    const current = await client.query({
      query: `SELECT
        count() AS support_requests,
        uniqExactIf(
          lowerUTF8(trim(BOTH ' ' FROM normalized_email)),
          lowerUTF8(trim(BOTH ' ' FROM normalized_email)) != ''
        ) AS support_unique_emails
        FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
        WHERE auth_user_id = {auth_user_id:String}`,
      query_params: { auth_user_id: authUserId },
      format: "JSONEachRow",
    });
    const currentRows = (await current.json()) as Array<Record<string, unknown>>;
    const supportRequests = n(currentRows[0]?.support_requests);
    const supportUniqueEmails = n(currentRows[0]?.support_unique_emails);
    if (supportRequests > 0) {
      return { support_data_status: "ready", support_requests: supportRequests, support_unique_emails: supportUniqueEmails };
    }

    const total = await client.query({
      query: `SELECT count() AS c FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL`,
      format: "JSONEachRow",
    });
    const totalRows = (await total.json()) as Array<{ c?: number | string }>;
    return {
      support_data_status: n(totalRows[0]?.c) > 0 ? "sync_pending" : "empty_source",
      support_requests: 0,
      support_unique_emails: 0,
    };
  } catch {
    return { support_data_status: "unavailable", support_requests: 0, support_unique_emails: 0 };
  }
}

// ---- Diagnostics (scan counts + FX) ---------------------------------------

interface ScanDiag { transactions_scanned: number; users_scanned: number; missing_fx: number; }

async function scanDiagnostics(client: ClickHouseClientLike, authUserId: string): Promise<ScanDiag> {
  const rs = await client.query({
    query: `SELECT count() AS transactions_scanned, uniqExact(user_id) AS users_scanned,
      countIf(fx_status IN ('missing_currency','missing_fx_rate','invalid_amount')) AS missing_fx
      FROM ${CH} FINAL WHERE auth_user_id = {auth_user_id:String}`,
    query_params: { auth_user_id: authUserId },
    format: "JSONEachRow",
  });
  const row = ((await rs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  return {
    transactions_scanned: n(row.transactions_scanned),
    users_scanned: n(row.users_scanned),
    missing_fx: n(row.missing_fx),
  };
}

// ---- FX + token diagnostics (Cohorts panels, Phase Task 1) ---------------
// FX health comes straight from the mapper-populated fx_status column. Token
// attribution total is derived from the already-classified cohort rows (in-cohort
// token purchases) — the panel's dataset-level unmatched/email split is not
// reproduced server-side (returned as 0 / empty), matching own-user attribution.

export async function fxDiagnostics(client: ClickHouseClientLike, authUserId: string, mediaBuyer: string[]): Promise<CohortFxDiagnostics> {
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  const mb = mediaBuyer.length ? ` AND ${inClause("media_buyer", mediaBuyer, "fxmb", params)}` : "";
  const rs = await client.query({
    query: `SELECT
      count() AS transactions_total,
      countIf(currency != '') AS transactions_with_currency,
      countIf(currency = '') AS transactions_without_currency,
      countIf(fx_status = 'native_usd') AS transactions_native_usd,
      countIf(fx_status = 'converted') AS transactions_converted,
      countIf(fx_status = 'missing_fx_rate') AS transactions_missing_fx_rate,
      countIf(fx_status = 'invalid_amount') AS transactions_invalid_amount,
      sumIf(toFloat64(original_amount), is_success = 1 AND fx_status IN ('missing_currency','missing_fx_rate','invalid_amount')) AS excluded_amount_original,
      countIf(is_success = 1 AND fx_status IN ('missing_currency','missing_fx_rate','invalid_amount')) AS excluded_transactions
      FROM ${CH} FINAL WHERE auth_user_id = {auth_user_id:String}${mb}`,
    query_params: params,
    format: "JSONEachRow",
  });
  const r = ((await rs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  return {
    transactions_total: n(r.transactions_total),
    transactions_with_currency: n(r.transactions_with_currency),
    transactions_without_currency: n(r.transactions_without_currency),
    transactions_native_usd: n(r.transactions_native_usd),
    transactions_converted: n(r.transactions_converted),
    transactions_missing_fx_rate: n(r.transactions_missing_fx_rate),
    transactions_invalid_amount: n(r.transactions_invalid_amount),
    excluded_amount_original: round2(n(r.excluded_amount_original)),
    excluded_transactions: n(r.excluded_transactions),
  };
}

export function tokenDiagnosticsFromRows(rows: CohortAggregateRow[]): CohortTokenDiagnostics {
  const total = rows.reduce((a, r) => a + r.token_purchases, 0);
  return {
    token_purchases_total: total,
    token_purchases_matched: total,
    token_purchases_matched_by_email: 0,
    token_purchases_unmatched: 0,
    token_unmatched_amount: 0,
    unknown_products: [],
    unknown_addon_revenue: 0,
  };
}

// ---- Public entrypoints ---------------------------------------------------

export async function runCohortList(input: {
  authUserId: string;
  clickhouse: ClickHouseClientLike;
  request: CohortRequest;
}): Promise<CohortResponse> {
  const started = Date.now();
  const nreq = normalizeCohortRequest(input.request);
  const params: Record<string, unknown> = { auth_user_id: input.authUserId };
  const support = await supportDataStatus(input.clickhouse, input.authUserId);
  const sql = buildListQuery(nreq, params, support.support_data_status);

  const optionsStarted = Date.now();
  const [rs, subStatus, scan, optionsResult, fx] = await Promise.all([
    input.clickhouse.query({ query: sql, query_params: params, format: "JSONEachRow" }),
    subscriptionDataStatus(input.clickhouse, input.authUserId),
    scanDiagnostics(input.clickhouse, input.authUserId).catch(() => ({ transactions_scanned: 0, users_scanned: 0, missing_fx: 0 })),
    // Options are scoped to the same active filters as the list (each dimension
    // minus its own predicate) — never a global list once filters are active.
    buildFilterOptions(input.clickhouse, input.authUserId, nreq).catch(
      () => ({ options: emptyFilterOptions(), scope_user_count: 0, dimensions: [] } as FilterOptionsResult),
    ),
    fxDiagnostics(input.clickhouse, input.authUserId, nreq.filters.media_buyer).catch(() => undefined),
  ]);
  const optionsDurationMs = Date.now() - optionsStarted;
  const rawRows = (await rs.json()) as RawCohortRow[];
  const rows = rawRows.map(toAggregateRow);
  const totals = computeTotals(rows);
  const diagnostics: CohortDiagnostics = {
    transactions_scanned: scan.transactions_scanned,
    users_scanned: scan.users_scanned,
    missing_identity: 0,
    missing_fx: scan.missing_fx,
    unknown_products: 0,
    subscription_data_status: subStatus,
    filters_applied: filtersApplied(nreq.filters, nreq.dateFrom, nreq.dateTo),
    support_data_status: support.support_data_status,
    support_requests: support.support_requests,
    support_unique_emails: support.support_unique_emails,
    support_matched_cohort_users: totals.support_users,
  };
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    rows,
    totals,
    filter_options: optionsResult.options,
    filter_options_diagnostics: optionsDiagnostics({
      filters: nreq.filters,
      dateFrom: nreq.dateFrom,
      dateTo: nreq.dateTo,
      result: optionsResult,
      queryDurationMs: optionsDurationMs,
      source: "dynamic_classifier",
    }),
    fx_diagnostics: fx,
    token_diagnostics: tokenDiagnosticsFromRows(rows),
    diagnostics,
  };
}

// Build every filter-option list server-side from each user's cohort-membership row
// (funnel/campaign_path/campaign_id/traffic_source attributed at the trial anchor,
// plus the user-level country/card_type/media_buyer/currency/price_plan), so the
// browser never scans transactions to populate dropdowns.
//
// CASCADING: each list is scoped to the request's active filters MINUS its own
// dimension — identical rules to the snapshot path (see cohortFilterOptions.ts),
// so the fallback engine cannot disagree with the materialized one. Counts are
// distinct cohort users (uniqExact). Shapes match the client option builders.
//
// The per-user CTE aliases its columns to the snapshot's names (country, card_type,
// canonical_user_id, …) so the shared branch builder works unchanged.
export function buildFilterOptionsQuery(nreq: NormalizedCohortRequest, params: Record<string, unknown>): string {
  const filters = nreq.filters;
  const dateConds: string[] = [];
  if (nreq.dateFrom) {
    params.o_date_from = nreq.dateFrom;
    dateConds.push(`cohort_date >= {o_date_from:String}`);
  }
  if (nreq.dateTo) {
    params.o_date_to = nreq.dateTo;
    dateConds.push(`cohort_date <= {o_date_to:String}`);
  }
  return `WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")}
, trialrow AS (
  SELECT uid canonical_user_id, any(c_date) cohort_date,
    any(c_funnel) funnel, any(c_camp) campaign_path,
    any(c_campaign_id) campaign_id, any(c_traffic_source) traffic_source,
    any(u_country) country, any(u_card_type) card_type, any(u_media_buyer) media_buyer,
    argMin(cur, (ets, tprio, tid)) currency,
    if(
      countIf(is_success = 1 AND lt NOT IN ('upsell','token_purchase')) = 0,
      'Unknown',
      concat('$', toString(argMinIf(round(g, 2), (ets, tprio, tid), is_success = 1 AND lt NOT IN ('upsell','token_purchase'))))
    ) price_plan
  FROM fin
  GROUP BY uid
),
members AS (
  SELECT canonical_user_id, funnel, campaign_path, campaign_id, traffic_source,
    media_buyer, country, card_type, currency, price_plan,
    ${optionFlagColumns(filters, params)}
  FROM trialrow${dateConds.length ? `\n  WHERE ${dateConds.join(" AND ")}` : ""}
)
${optionBranches(filters)}
FORMAT JSONEachRow`;
}

export async function buildFilterOptions(
  client: ClickHouseClientLike,
  authUserId: string,
  nreq: NormalizedCohortRequest,
): Promise<FilterOptionsResult> {
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  const sql = buildFilterOptionsQuery(nreq, params);
  const rs = await client.query({ query: sql, query_params: params, format: "JSONEachRow" });
  const rows = (await rs.json()) as Array<{ dim: string; value: string; cnt: number | string }>;
  return filterOptionsFromRows(rows, optionFiltersApplied(nreq.filters, nreq.dateFrom, nreq.dateTo));
}

export async function runCohortOptions(input: {
  authUserId: string;
  clickhouse: ClickHouseClientLike;
  request: CohortRequest;
}): Promise<CohortResponse> {
  const started = Date.now();
  const nreq = normalizeCohortRequest(input.request);
  const [optionsResult, subStatus, support] = await Promise.all([
    buildFilterOptions(input.clickhouse, input.authUserId, nreq),
    subscriptionDataStatus(input.clickhouse, input.authUserId),
    supportDataStatus(input.clickhouse, input.authUserId),
  ]);
  return {
    ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    rows: [], totals: {}, filter_options: optionsResult.options,
    filter_options_diagnostics: optionsDiagnostics({
      filters: nreq.filters,
      dateFrom: nreq.dateFrom,
      dateTo: nreq.dateTo,
      result: optionsResult,
      queryDurationMs: Date.now() - started,
      source: "dynamic_classifier",
    }),
    diagnostics: {
      transactions_scanned: 0, users_scanned: 0, missing_identity: 0, missing_fx: 0, unknown_products: 0,
      subscription_data_status: subStatus,
      filters_applied: filtersApplied(nreq.filters, nreq.dateFrom, nreq.dateTo),
      support_data_status: support.support_data_status,
      support_requests: support.support_requests,
      support_unique_emails: support.support_unique_emails,
      support_matched_cohort_users: 0,
    },
  };
}

// ---- Lazy per-cohort details (Phase 5) -----------------------------------

// Scope `fin` to a single cohort key. Binds ck_* params.
function cohortKeyWhere(key: { cohort_date: string; funnel: string; campaign_path: string }, params: Record<string, unknown>): string {
  params.ck_date = key.cohort_date;
  params.ck_funnel = key.funnel;
  params.ck_camp = key.campaign_path;
  return `c_date = {ck_date:String} AND c_funnel = {ck_funnel:String} AND c_camp = {ck_camp:String}`;
}

export async function runCohortDetails(input: {
  authUserId: string;
  clickhouse: ClickHouseClientLike;
  request: CohortRequest;
}): Promise<CohortDetailsResponse> {
  const started = Date.now();
  const nreq = normalizeCohortRequest(input.request);
  const key = nreq.cohortKey;
  if (!key || !key.cohort_date) throw new CohortRequestError("action=details requires cohort_key {cohort_date, funnel, campaign_path}.");

  const base = (extra: string, params: Record<string, unknown>) => `WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")}
, scoped AS (SELECT * FROM fin WHERE ${cohortKeyWhere(key, params)})
${extra}
FORMAT JSONEachRow`;

  const p1: Record<string, unknown> = { auth_user_id: input.authUserId };
  const summarySql = base(`SELECT
    uniqExact(uid) trial_users,
    sumIf(nn, is_success = 1 AND d <= 30) net_revenue_1m,
    uniqExactIf(uid, slot = 1) u1u, uniqExactIf(uid, slot = 2) u2u, uniqExactIf(uid, slot = 3) u3u, uniqExactIf(uid, slot >= 4) uxu,
    sumIf(g, slot = 1) u1r, sumIf(g, slot = 2) u2r, sumIf(g, slot = 3) u3r, sumIf(g, slot >= 4) uxr
    FROM scoped`, p1);

  const p2: Record<string, unknown> = { auth_user_id: input.authUserId };
  const currencySql = base(`SELECT cur currency,
    uniqExactIf(uid, is_success = 1 AND lt = 'trial') trial_users,
    countIf(is_success = 1) transactions,
    sumIf(amt, is_success = 1) gross_original,
    sumIf(g, is_success = 1) gross_usd,
    sumIf(nn, is_success = 1) net_usd,
    sum(rr) refunds_usd
    FROM scoped GROUP BY cur`, p2);

  const p3: Record<string, unknown> = { auth_user_id: input.authUserId };
  const tokenSql = base(`SELECT pid product_id, pname product, round(amt, 2) price,
    count() purchases, uniqExact(uid) buyers, sum(g) gross_revenue
    FROM scoped WHERE is_success = 1 AND lt = 'token_purchase' GROUP BY pid, pname, round(amt, 2)`, p3);

  const p4: Record<string, unknown> = { auth_user_id: input.authUserId };
  const planSql = base(`SELECT plan_price price,
    uniqExact(uid) trial_users, sum(g) gross_revenue, sum(nn) net_revenue FROM (
      SELECT uid, argMin(round(g, 2), (ets2, tprio2, tid2)) plan_price, sum(g) g, sum(nn) nn FROM (
        SELECT s.uid uid, s.g g, s.nn nn, p.ets ets2, p.tprio tprio2, p.tid tid2
        FROM scoped s INNER JOIN pretyped p ON p.uid = s.uid
        WHERE s.is_success = 1 AND s.lt NOT IN ('upsell','token_purchase')
      ) GROUP BY uid
    ) GROUP BY plan_price`, p4);

  const [sumRes, curRes, tokRes] = await Promise.all([
    input.clickhouse.query({ query: summarySql, query_params: p1, format: "JSONEachRow" }).then((r) => r.json()).catch(() => []),
    input.clickhouse.query({ query: currencySql, query_params: p2, format: "JSONEachRow" }).then((r) => r.json()).catch(() => []),
    input.clickhouse.query({ query: tokenSql, query_params: p3, format: "JSONEachRow" }).then((r) => r.json()).catch(() => []),
  ]);
  // plan breakdown is best-effort — never fail the whole details response on it.
  const planRes = await input.clickhouse.query({ query: planSql, query_params: p4, format: "JSONEachRow" }).then((r) => r.json()).catch(() => []);

  const sumRow = ((sumRes as Array<Record<string, unknown>>)[0]) ?? {};
  const trialUsers = n(sumRow.trial_users);
  const net1m = round2(n(sumRow.net_revenue_1m));
  const ageDays = Math.floor((nreq.now - Date.parse(`${key.cohort_date}T00:00:00.000Z`)) / 86400000);
  const tokenGross = (tokRes as Array<Record<string, unknown>>).reduce((a, r) => a + n(r.gross_revenue), 0);

  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    cohort_key: key,
    price_breakdown: (planRes as Array<Record<string, unknown>>).map((r) => ({
      price: round2(n(r.price)),
      plan_name: n(r.price) > 0 ? `$${round2(n(r.price)).toFixed(2)}` : "Unknown",
      trial_users: n(r.trial_users),
      gross_revenue: round2(n(r.gross_revenue)),
      net_revenue: round2(n(r.net_revenue)),
    })),
    currency_breakdown: (curRes as Array<Record<string, unknown>>).map((r) => ({
      currency: s(r.currency) || "UNKNOWN",
      trial_users: n(r.trial_users),
      transactions: n(r.transactions),
      gross_original: round2(n(r.gross_original)),
      gross_usd: round2(n(r.gross_usd)),
      net_usd: round2(n(r.net_usd)),
      refunds_usd: round2(n(r.refunds_usd)),
    })),
    upsell: {
      upsell_1_users: n(sumRow.u1u), upsell_2_users: n(sumRow.u2u), upsell_3_users: n(sumRow.u3u), upsell_extra_users: n(sumRow.uxu),
      upsell_1_revenue: round2(n(sumRow.u1r)), upsell_2_revenue: round2(n(sumRow.u2r)), upsell_3_revenue: round2(n(sumRow.u3r)), upsell_extra_revenue: round2(n(sumRow.uxr)),
    },
    token_pack_breakdown: (tokRes as Array<Record<string, unknown>>).map((r) => ({
      product_id: s(r.product_id),
      product: s(r.product) || (n(r.price) > 0 ? `Token $${round2(n(r.price)).toFixed(2)}` : "Token pack"),
      price: round2(n(r.price)),
      purchases: n(r.purchases),
      buyers: n(r.buyers),
      gross_revenue: round2(n(r.gross_revenue)),
      revenue_share: tokenGross > 0 ? round2((n(r.gross_revenue) / tokenGross) * 100) : 0,
    })),
    ltv_1m: {
      trial_users: trialUsers,
      net_revenue_1m: net1m,
      ltv_1m_per_user: trialUsers ? round2(net1m / trialUsers) : 0,
      age_days: ageDays,
      matured: ageDays >= 30,
      available_days: Math.max(0, Math.min(30, ageDays)),
    },
    fx: { missing_transactions: 0, missing_amount: 0 },
  };
}

export { round2 as cohortRound2, toAggregateRow, computeTotals, buildListQuery };
