// Shared, parity-proven lifecycle classifier CTE (extracted so both
// clickhouse-cohorts and clickhouse-users use the SAME authoritative logic —
// never two classifiers with different formulas).
//
// It reproduces the client `classifyUserTransactions` exactly (526/526 cohort
// parity): stored transaction_type is diagnostic only; the first eligible
// successful non-upsell/non-token payment is the trial; first-subscription and
// renewal levels are recomputed from the full per-user event sequence; failed
// transactions never occupy lifecycle slots; upsells are assigned in successful
// event-time order; token classification uses the production amount/window
// rules; net/refund use half-up 2-decimal normalization.
//
// `baseWhere` restricts the per-user scan (always includes the auth_user_id
// scope). `joinKeep` optionally semi-joins a keep-set (e.g. a currency filter).
// Output CTEs: base, elig, tr, cl, pretyped, lifeidx, upsidx, fin — where `fin`
// has, per POST-TRIAL transaction: uid, is_success, g (gross_usd), nn (net_usd,
// half-up), rr (refund_usd, half-up), d (day offset), cur, amt, pid, pname,
// c_date/c_funnel/c_camp (cohort attrs), lvl (subscription level), slot (upsell
// slot), lt (lifecycle_type).

import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";

export const CLASSIFIER_TABLE = ANALYTICS_TRANSACTIONS_TABLE;

export function classifierSQL(baseWhere: string, joinKeep: string): string {
  return `
base AS (
  SELECT a.user_id uid, a.transaction_id tid, a.event_time et, toUnixTimestamp64Milli(a.event_time) ets,
    a.funnel funnel, a.campaign_path campaign_path,
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
  FROM ${CLASSIFIER_TABLE} AS a FINAL ${joinKeep}
  WHERE ${baseWhere}
),
elig AS (SELECT *, (statusType = '' AND NOT upmark AND NOT tokenAmt) lifeelig FROM base),
tr AS (
  SELECT uid, argMin(ets, (ets, tprio, tid)) trial_ts, min((ets, tprio, tid)) trial_key,
    argMin(toString(toDate(et)), (ets, tprio, tid)) c_date,
    argMin(funnel, (ets, tprio, tid)) c_funnel,
    argMin(if(campaign_path = '', 'unknown', campaign_path), (ets, tprio, tid)) c_camp
  FROM elig WHERE lifeelig GROUP BY uid
),
cl AS (
  SELECT e.*, tr.trial_ts trial_ts, tr.trial_key trial_key, tr.c_date c_date, tr.c_funnel c_funnel, tr.c_camp c_camp
  FROM elig e INNER JOIN tr USING(uid)
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
  SELECT p.uid uid, p.tid tid, p.et et, p.trial_ts trial_ts, p.is_success is_success, p.g g, p.nn nn, p.rr rr, p.d d, p.statusType statusType, p.tokenAmt tokenAmt,
    p.cur cur, p.amt amt, p.pid pid, p.pname pname,
    p.c_date c_date, p.c_funnel c_funnel, p.c_camp c_camp, ifNull(li.lvl, 0) lvl, ifNull(ui.slot, 0) slot,
    multiIf(p.pretype != 'lifecycle', p.pretype, li.lvl = 1, 'first_subscription', li.lvl = 2, 'renewal_2', li.lvl = 3, 'renewal_3', 'renewal') lt
  FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid) LEFT JOIN upsidx ui USING(uid, tid)
)`;
}
