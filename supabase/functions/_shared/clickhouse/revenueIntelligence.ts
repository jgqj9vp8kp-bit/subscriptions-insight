// Dashboard Revenue Intelligence: the calendar projection of the SAME
// cohort-revenue facts Cohorts reads.
//
// Correctness by construction, not by parallel formulas:
//  - cohort identity = the ACTIVE fact_user_cohorts snapshot (same versions
//    Cohorts serves) — never a second cohort engine;
//  - lifecycle taxonomy = a verbatim copy of the materialized classifier CTEs
//    (base/pretyped/lifeidx/fin from cohortMembership.ts) so trial/upsell/
//    token/first_subscription/renewal_N mean byte-for-byte the same thing;
//  - revenue formulas = the AGGREGATE_MEASURES canon: gross = sumIf(g,
//    is_success = 1), refunds = sum(rr), net = gross − refunds (refunds are
//    RESTATED onto the original payment row — the warehouse has no refund
//    date);
//  - attribution never drops rows: payments whose user_id has NO row in the
//    active snapshot flow into an explicit Unattributed stream (v1 does not
//    reproduce the Cohorts email-token re-key, so email-only token matches
//    land there too — reported in diagnostics, not hidden).
//
// New vs Existing is SAME-BUCKET (§29): one daily query carries the same-day,
// same-ISO-week and same-month pairs at once, so the Day/Week/Month switch
// changes semantics correctly instead of summing same-day splits.
//
// Pure module: no Deno, no fetch, no clock (now injected). Vitest imports the
// src/services stub.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { activeCohortSnapshotVersion, getCohortSnapshotState } from "./cohortMembership.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_FACEBOOK_STATS_TABLE, FACT_USER_COHORTS_TABLE } from "./schema.ts";
import {
  REVENUE_AGE_BUCKETS,
  type RevenueAgeRow,
  type RevenueBucket,
  type RevenueBucketRow,
  type RevenueByType,
  type RevenueDayBreakdown,
  type RevenueDayCohortRow,
  type RevenueIntelligenceBundle,
  type RevenueIntelligenceRequest,
  type RevenueSliceRow,
  type RevenueTotals,
} from "./revenueIntelligenceContract.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** day_breakdown lists this many most recent cohorts by exact date; older ones
 * roll up to months, then "older". */
export const DAY_BREAKDOWN_EXACT_DAYS = 7;
export const DAY_BREAKDOWN_MONTH_ROLLUPS = 3;

export class RevenueRequestError extends Error {}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function date(value: unknown, field: string): string | null {
  const text = s(value).trim();
  if (!text) return null;
  if (!DATE_RE.test(text)) throw new RevenueRequestError(`Invalid ${field}: expected YYYY-MM-DD.`);
  return text;
}

export function normalizeRevenueRequest(req: RevenueIntelligenceRequest): {
  action: "bundle" | "day_breakdown";
  dateFrom: string | null;
  dateTo: string | null;
  bucket: RevenueBucket;
  day: string | null;
} {
  const action = req.action === "day_breakdown" ? "day_breakdown" : "bundle";
  const bucket: RevenueBucket = req.bucket === "week" || req.bucket === "month" ? req.bucket : "day";
  const day = date(req.date, "date");
  if (action === "day_breakdown" && !day) throw new RevenueRequestError("date is required for day_breakdown.");
  return { action, dateFrom: date(req.date_from, "date_from"), dateTo: date(req.date_to, "date_to"), bucket, day };
}

// ---- Classified attributed stream (verbatim classifier CTEs) ---------------
//
// base/pretyped/lifeidx/upsidx/fin copied from buildMaterializedCohortListQuery
// (cohortMembership.ts:611-661) with two additions the calendar projection
// needs: the cohort DATE as a Date column (c_d) and the user's price_plan
// (c_plan). The typing runs over the user's FULL history (no date window) —
// windowing before typing would misnumber first_subscription/renewal levels.

function classifiedCTE(): string {
  return `
base AS (
  SELECT a.user_id uid, a.transaction_id tid, a.event_time et, toUnixTimestamp64Milli(a.event_time) ets,
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
    fc.cohort_date c_d, fc.campaign_path c_camp, fc.price_plan c_plan,
    fc.trial_transaction_id trial_transaction_id,
    toUnixTimestamp64Milli(fc.trial_event_time) trial_ts
  FROM ${ANALYTICS_TRANSACTIONS_TABLE} AS a FINAL
  INNER JOIN ${FACT_USER_COHORTS_TABLE} AS fc FINAL
    ON fc.auth_user_id = a.auth_user_id
   AND fc.canonical_user_id = a.user_id
  WHERE a.auth_user_id = {auth_user_id:String}
    AND fc.auth_user_id = {auth_user_id:String}
    AND fc.warehouse_version = {warehouse_version:String}
    AND fc.classification_version = {classification_version:String}
    AND floor((toUnixTimestamp64Milli(a.event_time) - toUnixTimestamp64Milli(fc.trial_event_time)) / 86400000) >= 0
),
pretyped AS (
  SELECT *, floor((ets - trial_ts) / 86400000) d,
    multiIf(statusType != '', statusType, upmark, 'upsell', (NOT upmark) AND tokenAmt, 'token_purchase',
      tid = trial_transaction_id, 'trial',
      (statusType = '' AND NOT upmark AND NOT tokenAmt) AND (ets - trial_ts) <= 3600000 AND commonUp, 'upsell',
      (statusType = '' AND NOT upmark AND NOT tokenAmt) AND (ets - trial_ts) <= 172800000, 'token_purchase',
      (statusType = '' AND NOT upmark AND NOT tokenAmt), 'lifecycle', 'upsell') pretype
  FROM base
),
lifeidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) lvl FROM pretyped WHERE pretype = 'lifecycle' AND is_success = 1),
fin AS (
  SELECT p.uid uid, p.tid tid, p.et et, p.is_success is_success,
    p.g g, p.rr rr, p.d d,
    p.c_d c_d, p.c_camp c_camp, p.c_plan c_plan,
    ifNull(li.lvl, 0) lvl,
    multiIf(p.pretype != 'lifecycle', p.pretype, li.lvl = 1, 'first_subscription', li.lvl = 2, 'renewal_2', li.lvl = 3, 'renewal_3', 'renewal') lt
  FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid)
)`;
}

const TYPE_SUMS = `
  sumIf(g, is_success = 1 AND lt = 'trial') type_trial,
  sumIf(g, is_success = 1 AND lt = 'first_subscription') type_first_sub,
  sumIf(g, is_success = 1 AND lt IN ('renewal_2','renewal_3','renewal')) type_renewals,
  sumIf(g, is_success = 1 AND lt = 'upsell') type_upsells,
  sumIf(g, is_success = 1 AND lt = 'token_purchase') type_tokens`;

/** Attributed daily series over the FULL account history (52k rows — cheap;
 * full history is required for the cumulative-profit line anyway). Carries the
 * same-day, same-week and same-month new/existing pairs simultaneously. */
export function buildAttributedDailySql(params: Record<string, unknown>, authUserId: string): string {
  params.auth_user_id = authUserId;
  return `WITH ${classifiedCTE()}
SELECT toString(toDate(et)) day,
  sumIf(g, is_success = 1) gross,
  sum(rr) refunds,
  sumIf(g, is_success = 1 AND toDate(et) = c_d) gross_new_day,
  sumIf(g, is_success = 1 AND toStartOfWeek(toDate(et), 1) = toStartOfWeek(c_d, 1)) gross_new_week,
  sumIf(g, is_success = 1 AND toStartOfMonth(toDate(et)) = toStartOfMonth(c_d)) gross_new_month,
  sumIf(rr, toDate(et) = c_d) refunds_new_day,
  sumIf(rr, toStartOfWeek(toDate(et), 1) = toStartOfWeek(c_d, 1)) refunds_new_week,
  sumIf(rr, toStartOfMonth(toDate(et)) = toStartOfMonth(c_d)) refunds_new_month,
  sumIf(g, is_success = 1 AND c_d > toDate(et)) future_cohort_gross,
  ${TYPE_SUMS},
  uniqExactIf(uid, is_success = 1) paying_users,
  uniqExactIf(uid, is_success = 1 AND toDate(et) = c_d) new_paying_users_day,
  uniqExactIf(uid, is_success = 1 AND toStartOfWeek(toDate(et), 1) = toStartOfWeek(c_d, 1)) new_paying_users_week,
  uniqExactIf(uid, is_success = 1 AND toStartOfMonth(toDate(et)) = toStartOfMonth(c_d)) new_paying_users_month,
  count() rows_scanned
FROM fin
GROUP BY day ORDER BY day
FORMAT JSONEachRow`;
}

/** Payments whose user has NO row in the active cohort snapshot — the honest
 * Unattributed stream (includes email-only token matches in v1). */
export function buildUnattributedDailySql(params: Record<string, unknown>, authUserId: string): string {
  params.auth_user_id = authUserId;
  return `WITH snapshot_users AS (
  SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
)
SELECT toString(toDate(event_time)) day,
  sumIf(gross_amount_usd, is_success = 1) gross,
  sum(floor(refund_amount_usd * 100 + 0.5) / 100) refunds,
  count() rows_scanned
FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
WHERE auth_user_id = {auth_user_id:String}
  AND user_id NOT IN (SELECT canonical_user_id FROM snapshot_users)
GROUP BY day ORDER BY day
FORMAT JSONEachRow`;
}

/** Facebook spend by day; level='campaign' is the established no-double-count
 * grain (fbCohortStats convention). The only spend ledger in the warehouse. */
export function buildSpendDailySql(params: Record<string, unknown>, authUserId: string): string {
  params.auth_user_id = authUserId;
  return `SELECT toString(stat_date) day, sum(spend) spend
FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign'
GROUP BY day ORDER BY day
FORMAT JSONEachRow`;
}

function windowWhere(params: Record<string, unknown>, dateFrom: string | null, dateTo: string | null): string {
  let where = "";
  if (dateFrom) { params.win_from = dateFrom; where += ` AND toDate(et) >= toDate({win_from:String})`; }
  if (dateTo) { params.win_to = dateTo; where += ` AND toDate(et) <= toDate({win_to:String})`; }
  return where;
}

/** Period slice by campaign_path ('' stays a distinct Unknown key). */
export function buildByFunnelSql(params: Record<string, unknown>, authUserId: string, dateFrom: string | null, dateTo: string | null): string {
  params.auth_user_id = authUserId;
  const win = windowWhere(params, dateFrom, dateTo);
  return `WITH ${classifiedCTE()}
SELECT c_camp key,
  sumIf(g, is_success = 1) gross,
  sumIf(g, is_success = 1) - sum(rr) net,
  sumIf(g, is_success = 1 AND toDate(et) = c_d) gross_new,
  sumIf(g, is_success = 1 AND toDate(et) > c_d) gross_existing
FROM fin
WHERE 1 = 1${win}
GROUP BY key ORDER BY gross DESC
FORMAT JSONEachRow`;
}

export function buildByPlanSql(params: Record<string, unknown>, authUserId: string, dateFrom: string | null, dateTo: string | null): string {
  params.auth_user_id = authUserId;
  const win = windowWhere(params, dateFrom, dateTo);
  return `WITH ${classifiedCTE()}
SELECT c_plan key,
  sumIf(g, is_success = 1) gross,
  sumIf(g, is_success = 1) - sum(rr) net,
  sumIf(g, is_success = 1 AND toDate(et) = c_d) gross_new,
  sumIf(g, is_success = 1 AND toDate(et) > c_d) gross_existing
FROM fin
WHERE 1 = 1${win}
GROUP BY key ORDER BY gross DESC
FORMAT JSONEachRow`;
}

/** Cohort-age buckets of the period's revenue: d = whole days between the
 * user's trial anchor and the payment (precomputed by the classifier). */
export function buildByAgeSql(params: Record<string, unknown>, authUserId: string, dateFrom: string | null, dateTo: string | null): string {
  params.auth_user_id = authUserId;
  const win = windowWhere(params, dateFrom, dateTo);
  return `WITH ${classifiedCTE()}
SELECT multiIf(d = 0, 'd0', d <= 7, 'd1_7', d <= 30, 'd8_30', d <= 60, 'd31_60', d <= 90, 'd61_90', 'd90_plus') bucket,
  sumIf(g, is_success = 1) gross,
  sumIf(g, is_success = 1) - sum(rr) net
FROM fin
WHERE 1 = 1${win}
GROUP BY bucket
FORMAT JSONEachRow`;
}

/** One revenue day explained: which cohorts (exact recent dates, month rollups
 * beyond DAY_BREAKDOWN_EXACT_DAYS, then "older") and funnels produced it. */
export function buildDayBreakdownSql(params: Record<string, unknown>, authUserId: string, day: string): string {
  params.auth_user_id = authUserId;
  params.break_day = day;
  return `WITH ${classifiedCTE()}
SELECT toString(c_d) cohort_date, c_camp campaign_path,
  sumIf(g, is_success = 1) gross,
  sumIf(g, is_success = 1) - sum(rr) net,
  ${TYPE_SUMS}
FROM fin
WHERE toDate(et) = toDate({break_day:String})
GROUP BY cohort_date, campaign_path
ORDER BY gross DESC
FORMAT JSONEachRow`;
}

export function buildDayUnattributedSql(params: Record<string, unknown>, authUserId: string, day: string): string {
  params.auth_user_id = authUserId;
  params.break_day = day;
  return `WITH snapshot_users AS (
  SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
)
SELECT sumIf(gross_amount_usd, is_success = 1) gross,
  sumIf(gross_amount_usd, is_success = 1) - sum(floor(refund_amount_usd * 100 + 0.5) / 100) net
FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
WHERE auth_user_id = {auth_user_id:String}
  AND toDate(event_time) = toDate({break_day:String})
  AND user_id NOT IN (SELECT canonical_user_id FROM snapshot_users)
FORMAT JSONEachRow`;
}

// ---- Pure assembly ----------------------------------------------------------

export interface AttributedDailyRow {
  day: string;
  gross: number; refunds: number;
  gross_new_day: number; gross_new_week: number; gross_new_month: number;
  refunds_new_day: number; refunds_new_week: number; refunds_new_month: number;
  future_cohort_gross: number;
  type_trial: number; type_first_sub: number; type_renewals: number; type_upsells: number; type_tokens: number;
  paying_users: number;
  new_paying_users_day: number; new_paying_users_week: number; new_paying_users_month: number;
  rows_scanned: number;
}

export interface UnattributedDailyRow { day: string; gross: number; refunds: number; rows_scanned: number }
export interface SpendDailyRow { day: string; spend: number }

/** UTC bucket start for a YYYY-MM-DD day. Week = ISO Monday (matches
 * toStartOfWeek(date, 1) in the SQL — the pairing must agree or invariant 15
 * silently breaks). */
export function bucketStart(day: string, bucket: RevenueBucket): string {
  if (bucket === "day") return day;
  const dateObj = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(dateObj.getTime())) return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  const weekday = (dateObj.getUTCDay() + 6) % 7; // Monday = 0
  dateObj.setUTCDate(dateObj.getUTCDate() - weekday);
  return dateObj.toISOString().slice(0, 10);
}

function emptyType(): RevenueByType {
  return { trial: 0, first_subscription: 0, renewals: 0, upsells: 0, tokens: 0 };
}

/** Assembles the bundle from the raw daily streams. Pure and fully covered by
 * the invariant tests: bucketing, same-bucket pairs, cumulative profit from
 * the TRUE history start, window slicing, totals, reconciliation. */
export function assembleRevenueBundle(input: {
  attributed: readonly AttributedDailyRow[];
  unattributed: readonly UnattributedDailyRow[];
  spend: readonly SpendDailyRow[];
  byFunnel: ReadonlyArray<{ key: string; gross: number; net: number; gross_new: number; gross_existing: number }>;
  byPlan: ReadonlyArray<{ key: string; gross: number; net: number; gross_new: number; gross_existing: number }>;
  byAge: ReadonlyArray<{ bucket: string; gross: number; net: number }>;
  bucket: RevenueBucket;
  dateFrom: string | null;
  dateTo: string | null;
  snapshot: { warehouse_version: string; classification_version: string };
  now: Date;
}): Omit<RevenueIntelligenceBundle, "ok" | "source" | "action" | "generated_at" | "query_duration_ms"> {
  const { bucket } = input;
  type Acc = {
    date: string;
    gross: number; refunds: number; spend: number;
    grossNew: number; refundsNew: number;
    grossUnatt: number; refundsUnatt: number;
    byType: RevenueByType;
    payingUsers: number; newPayingUsers: number;
    futureCohortGross: number; rows: number;
  };
  const byBucket = new Map<string, Acc>();
  const acc = (day: string): Acc => {
    const key = bucketStart(day, bucket);
    let entry = byBucket.get(key);
    if (!entry) {
      entry = {
        date: key, gross: 0, refunds: 0, spend: 0, grossNew: 0, refundsNew: 0,
        grossUnatt: 0, refundsUnatt: 0, byType: emptyType(), payingUsers: 0,
        newPayingUsers: 0, futureCohortGross: 0, rows: 0,
      };
      byBucket.set(key, entry);
    }
    return entry;
  };

  for (const row of input.attributed) {
    const entry = acc(row.day);
    entry.gross += row.gross;
    entry.refunds += row.refunds;
    entry.grossNew += bucket === "day" ? row.gross_new_day : bucket === "week" ? row.gross_new_week : row.gross_new_month;
    entry.refundsNew += bucket === "day" ? row.refunds_new_day : bucket === "week" ? row.refunds_new_week : row.refunds_new_month;
    // Payer uniqueness holds only at day grain; coarser buckets sum daily
    // uniques (a payer active on two days counts twice) — documented in the UI.
    entry.payingUsers += row.paying_users;
    entry.newPayingUsers += bucket === "day" ? row.new_paying_users_day : bucket === "week" ? row.new_paying_users_week : row.new_paying_users_month;
    entry.byType.trial += row.type_trial;
    entry.byType.first_subscription += row.type_first_sub;
    entry.byType.renewals += row.type_renewals;
    entry.byType.upsells += row.type_upsells;
    entry.byType.tokens += row.type_tokens;
    entry.futureCohortGross += row.future_cohort_gross;
    entry.rows += row.rows_scanned;
  }
  for (const row of input.unattributed) {
    const entry = acc(row.day);
    entry.gross += row.gross;
    entry.refunds += row.refunds;
    entry.grossUnatt += row.gross;
    entry.refundsUnatt += row.refunds;
    entry.rows += row.rows_scanned;
  }
  for (const row of input.spend) acc(row.day).spend += row.spend;

  const ordered = [...byBucket.values()].sort((a, b) => a.date.localeCompare(b.date));
  const todayBucket = bucketStart(input.now.toISOString().slice(0, 10), bucket);

  // Cumulative profit runs over the FULL history; the window is sliced after.
  let cumulative = 0;
  const fromBucket = input.dateFrom ? bucketStart(input.dateFrom, bucket) : null;
  const toBucket = input.dateTo ? bucketStart(input.dateTo, bucket) : null;
  const buckets: RevenueBucketRow[] = [];
  let rowsScanned = 0;
  let futureCohortGross = 0;
  for (const entry of ordered) {
    const net = entry.gross - entry.refunds;
    const profit = net - entry.spend;
    cumulative += profit;
    rowsScanned += entry.rows;
    futureCohortGross += entry.futureCohortGross;
    if (fromBucket && entry.date < fromBucket) continue;
    if (toBucket && entry.date > toBucket) continue;
    const grossExisting = entry.gross - entry.grossNew - entry.grossUnatt;
    const netNew = entry.grossNew - entry.refundsNew;
    const netUnatt = entry.grossUnatt - entry.refundsUnatt;
    buckets.push({
      date: entry.date,
      gross: round2(entry.gross),
      refunds: round2(entry.refunds),
      net: round2(net),
      spend: round2(entry.spend),
      gross_new: round2(entry.grossNew),
      gross_existing: round2(grossExisting),
      gross_unattributed: round2(entry.grossUnatt),
      net_new: round2(netNew),
      net_existing: round2(net - netNew - netUnatt),
      net_unattributed: round2(netUnatt),
      by_type: {
        trial: round2(entry.byType.trial),
        first_subscription: round2(entry.byType.first_subscription),
        renewals: round2(entry.byType.renewals),
        upsells: round2(entry.byType.upsells),
        tokens: round2(entry.byType.tokens),
      },
      paying_users: entry.payingUsers,
      new_paying_users: entry.newPayingUsers,
      profit: round2(profit),
      cumulative_profit: round2(cumulative),
      partial: entry.date === todayBucket,
    });
  }

  const totals: RevenueTotals = buckets.reduce<RevenueTotals>((sum, row) => ({
    gross: round2(sum.gross + row.gross),
    refunds: round2(sum.refunds + row.refunds),
    net: round2(sum.net + row.net),
    spend: round2(sum.spend + row.spend),
    gross_new: round2(sum.gross_new + row.gross_new),
    gross_existing: round2(sum.gross_existing + row.gross_existing),
    gross_unattributed: round2(sum.gross_unattributed + row.gross_unattributed),
    net_new: round2(sum.net_new + row.net_new),
    net_existing: round2(sum.net_existing + row.net_existing),
    net_unattributed: round2(sum.net_unattributed + row.net_unattributed),
    by_type: {
      trial: round2(sum.by_type.trial + row.by_type.trial),
      first_subscription: round2(sum.by_type.first_subscription + row.by_type.first_subscription),
      renewals: round2(sum.by_type.renewals + row.by_type.renewals),
      upsells: round2(sum.by_type.upsells + row.by_type.upsells),
      tokens: round2(sum.by_type.tokens + row.by_type.tokens),
    },
    profit: round2(sum.profit + row.profit),
  }), { gross: 0, refunds: 0, net: 0, spend: 0, gross_new: 0, gross_existing: 0, gross_unattributed: 0, net_new: 0, net_existing: 0, net_unattributed: 0, by_type: emptyType(), profit: 0 });

  // Slice rows: keep Unknown ('' from the snapshot) distinct from Unattributed
  // (no snapshot row) — two different populations, never merged.
  const unattTotalGross = totals.gross_unattributed;
  const unattTotalNet = totals.net_unattributed;
  const slice = (rows: ReadonlyArray<{ key: string; gross: number; net: number; gross_new: number; gross_existing: number }>): RevenueSliceRow[] => {
    const mapped = rows.map((row) => ({
      key: row.key === "" || row.key === "unknown" ? "Unknown" : row.key,
      gross: round2(row.gross),
      net: round2(row.net),
      gross_new: round2(row.gross_new),
      gross_existing: round2(row.gross_existing),
    }));
    if (unattTotalGross !== 0 || unattTotalNet !== 0) {
      mapped.push({ key: "Unattributed", gross: unattTotalGross, net: unattTotalNet, gross_new: 0, gross_existing: 0 });
    }
    return mapped;
  };

  const ageByBucket = new Map(input.byAge.map((row) => [row.bucket, row]));
  const by_age: RevenueAgeRow[] = REVENUE_AGE_BUCKETS.map((bucketName) => {
    if (bucketName === "unattributed") {
      return { bucket: bucketName, gross: unattTotalGross, net: unattTotalNet };
    }
    const row = ageByBucket.get(bucketName);
    return { bucket: bucketName, gross: round2(n(row?.gross)), net: round2(n(row?.net)) };
  });

  return {
    bucket,
    date_from: input.dateFrom,
    date_to: input.dateTo,
    buckets,
    totals,
    by_funnel: slice(input.byFunnel),
    by_plan: slice(input.byPlan),
    by_age,
    diagnostics: {
      attributed_pct: totals.gross > 0 ? round2(((totals.gross - totals.gross_unattributed) / totals.gross) * 100) : 100,
      future_cohort_gross: round2(futureCohortGross),
      snapshot_warehouse_version: input.snapshot.warehouse_version,
      snapshot_classification_version: input.snapshot.classification_version,
      rows_scanned: rowsScanned,
      note: "Unattributed includes email-only token matches (v1 does not reproduce the Cohorts email-token re-key).",
    },
  };
}

// ---- Runners ----------------------------------------------------------------

async function jsonRows<T>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return (await result.json()) as T[];
}

async function requireActiveSnapshot(supabase: SupabaseLikeClient, authUserId: string): Promise<{ warehouse_version: string; classification_version: string } | null> {
  const state = await getCohortSnapshotState(supabase, authUserId).catch(() => null);
  return activeCohortSnapshotVersion(state);
}

export async function runRevenueIntelligence(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: RevenueIntelligenceRequest;
  now?: Date;
}): Promise<RevenueIntelligenceBundle> {
  const started = Date.now();
  const req = normalizeRevenueRequest({ ...input.request, action: "bundle" });
  const active = await requireActiveSnapshot(input.supabase, input.authUserId);
  if (!active) {
    return {
      ok: false, source: "clickhouse", action: "bundle", generated_at: new Date().toISOString(),
      query_duration_ms: Date.now() - started, bucket: req.bucket, date_from: req.dateFrom, date_to: req.dateTo,
      buckets: [], totals: assembleRevenueBundle({ attributed: [], unattributed: [], spend: [], byFunnel: [], byPlan: [], byAge: [], bucket: req.bucket, dateFrom: null, dateTo: null, snapshot: { warehouse_version: "", classification_version: "" }, now: input.now ?? new Date() }).totals,
      by_funnel: [], by_plan: [], by_age: [],
      diagnostics: { attributed_pct: 0, future_cohort_gross: 0, snapshot_warehouse_version: "", snapshot_classification_version: "", rows_scanned: 0, note: "" },
      error: "cohort_snapshot_not_ready",
    };
  }
  const base = { auth_user_id: input.authUserId, warehouse_version: active.warehouse_version, classification_version: active.classification_version };
  const p = () => ({ ...base } as Record<string, unknown>);
  // SEQUENTIAL on purpose: four of these run the full classifier CTE chain
  // (JOIN + window functions), and firing them in parallel exhausted the
  // ClickHouse instance into a 25s timeout (measured live: one classifier
  // pass ≈ 330ms, six concurrent ≈ never finishes). Serialized, the whole
  // bundle lands in ~2s.
  const pA = p(), pU = p(), pS = p(), pF = p(), pP = p(), pG = p();
  const attributed = await jsonRows<AttributedDailyRow>(input.clickhouse, buildAttributedDailySql(pA, input.authUserId), pA);
  const unattributed = await jsonRows<UnattributedDailyRow>(input.clickhouse, buildUnattributedDailySql(pU, input.authUserId), pU);
  const spend = await jsonRows<SpendDailyRow>(input.clickhouse, buildSpendDailySql(pS, input.authUserId), pS);
  const byFunnel = await jsonRows<{ key: string; gross: number; net: number; gross_new: number; gross_existing: number }>(input.clickhouse, buildByFunnelSql(pF, input.authUserId, req.dateFrom, req.dateTo), pF);
  const byPlan = await jsonRows<{ key: string; gross: number; net: number; gross_new: number; gross_existing: number }>(input.clickhouse, buildByPlanSql(pP, input.authUserId, req.dateFrom, req.dateTo), pP);
  const byAge = await jsonRows<{ bucket: string; gross: number; net: number }>(input.clickhouse, buildByAgeSql(pG, input.authUserId, req.dateFrom, req.dateTo), pG);
  const numify = <T,>(rows: T[]): T[] => rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      out[key] = typeof value === "string" && key !== "day" && key !== "key" && key !== "bucket" ? Number(value) : value;
    }
    return out as T;
  });
  const assembled = assembleRevenueBundle({
    attributed: numify(attributed),
    unattributed: numify(unattributed),
    spend: numify(spend),
    byFunnel: numify(byFunnel),
    byPlan: numify(byPlan),
    byAge: numify(byAge),
    bucket: req.bucket,
    dateFrom: req.dateFrom,
    dateTo: req.dateTo,
    snapshot: active,
    now: input.now ?? new Date(),
  });
  return {
    ok: true, source: "clickhouse", action: "bundle",
    generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    ...assembled,
  };
}

/** Rolls exact cohort dates into the drilldown shape: last
 * DAY_BREAKDOWN_EXACT_DAYS days named, then month rollups, then "older". */
export function rollupDayCohorts(
  rows: ReadonlyArray<{ cohort_date: string; gross: number; net: number; by_type: RevenueByType }>,
  day: string,
): RevenueDayCohortRow[] {
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  const grouped = new Map<string, RevenueDayCohortRow>();
  for (const row of rows) {
    const ageDays = Math.floor((dayMs - Date.parse(`${row.cohort_date}T00:00:00Z`)) / 86_400_000);
    const monthsBack = (Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7))) - (Number(row.cohort_date.slice(0, 4)) * 12 + Number(row.cohort_date.slice(5, 7)));
    const key = ageDays <= DAY_BREAKDOWN_EXACT_DAYS
      ? row.cohort_date
      : monthsBack <= DAY_BREAKDOWN_MONTH_ROLLUPS
        ? row.cohort_date.slice(0, 7)
        : "older";
    const entry = grouped.get(key) ?? { cohort: key, gross: 0, net: 0, by_type: emptyType() };
    entry.gross = round2(entry.gross + row.gross);
    entry.net = round2(entry.net + row.net);
    entry.by_type.trial = round2(entry.by_type.trial + row.by_type.trial);
    entry.by_type.first_subscription = round2(entry.by_type.first_subscription + row.by_type.first_subscription);
    entry.by_type.renewals = round2(entry.by_type.renewals + row.by_type.renewals);
    entry.by_type.upsells = round2(entry.by_type.upsells + row.by_type.upsells);
    entry.by_type.tokens = round2(entry.by_type.tokens + row.by_type.tokens);
    grouped.set(key, entry);
  }
  return [...grouped.values()].sort((a, b) => b.gross - a.gross);
}

export async function runRevenueDayBreakdown(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: RevenueIntelligenceRequest;
}): Promise<RevenueDayBreakdown> {
  const started = Date.now();
  const req = normalizeRevenueRequest({ ...input.request, action: "day_breakdown" });
  const day = req.day as string;
  const active = await requireActiveSnapshot(input.supabase, input.authUserId);
  if (!active) {
    return { ok: false, source: "clickhouse", action: "day_breakdown", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started, date: day, gross: 0, by_cohort: [], by_funnel: [], error: "cohort_snapshot_not_ready" };
  }
  const base = { auth_user_id: input.authUserId, warehouse_version: active.warehouse_version, classification_version: active.classification_version };
  const pB = { ...base } as Record<string, unknown>;
  const pU = { ...base } as Record<string, unknown>;
  const [rows, [unatt]] = await Promise.all([
    jsonRows<Record<string, unknown>>(input.clickhouse, buildDayBreakdownSql(pB, input.authUserId, day), pB),
    jsonRows<{ gross?: unknown; net?: unknown }>(input.clickhouse, buildDayUnattributedSql(pU, input.authUserId, day), pU),
  ]);
  const detailed = rows.map((row) => ({
    cohort_date: s(row.cohort_date),
    campaign_path: s(row.campaign_path),
    gross: n(row.gross),
    net: n(row.net),
    by_type: {
      trial: n(row.type_trial), first_subscription: n(row.type_first_sub),
      renewals: n(row.type_renewals), upsells: n(row.type_upsells), tokens: n(row.type_tokens),
    },
  }));
  const by_cohort = rollupDayCohorts(detailed, day);
  const unattGross = round2(n(unatt?.gross));
  if (unattGross !== 0 || round2(n(unatt?.net)) !== 0) {
    by_cohort.push({ cohort: "unattributed", gross: unattGross, net: round2(n(unatt?.net)), by_type: emptyType() });
  }
  const byFunnelMap = new Map<string, RevenueSliceRow>();
  for (const row of detailed) {
    const key = row.campaign_path === "" ? "Unknown" : row.campaign_path;
    const entry = byFunnelMap.get(key) ?? { key, gross: 0, net: 0, gross_new: 0, gross_existing: 0 };
    entry.gross = round2(entry.gross + row.gross);
    entry.net = round2(entry.net + row.net);
    if (row.cohort_date === day) entry.gross_new = round2(entry.gross_new + row.gross);
    else entry.gross_existing = round2(entry.gross_existing + row.gross);
    byFunnelMap.set(key, entry);
  }
  const gross = round2(detailed.reduce((sum, row) => sum + row.gross, 0) + unattGross);
  return {
    ok: true, source: "clickhouse", action: "day_breakdown",
    generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started,
    date: day, gross,
    by_cohort,
    by_funnel: [...byFunnelMap.values()].sort((a, b) => b.gross - a.gross),
  };
}
