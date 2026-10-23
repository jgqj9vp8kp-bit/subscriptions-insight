// Shared lifecycle classifier CTE of the Users and Payment Analytics pages
// (clickhouse-users: users.ts, paymentAnalytics.ts).
//
// The anchor and lifecycle typing reproduce the client `classifyUserTransactions`
// (526/526 cohort parity): stored transaction_type is diagnostic only; the
// first eligible successful non-upsell/non-token payment is the trial;
// first-subscription and renewal levels are recomputed from the full per-user
// event sequence; failed transactions never occupy lifecycle slots; upsells are
// assigned in successful event-time order; net/refund use half-up 2-decimal
// normalization.
//
// One-off typing (since 2026-10-23) is the token / in-product / funnel upsell
// split of monetizationTyping.ts — the same rules as the Cohorts list and
// details (cohorts.ts classifierSQL "price_point"). The parity claim above
// holds for it only against the client READ-time typing
// (classifyUserTransactions typing "price_point", warehouseHydration), up to
// the divergences DEVELOPER_NOTES lists; the stored import-time type keeps the
// legacy one-off typing. Anchors and lifecycle levels are unchanged by it.
//
// `baseWhere` restricts the per-user scan (always includes the auth_user_id
// scope). `joinKeep` optionally semi-joins a keep-set (e.g. a currency filter).
// Output CTEs: upp, base, elig, tr, cl, pretyped, lifeidx, upsidx, fin — where
// `fin` has, per POST-TRIAL transaction: uid, is_success, g (gross_usd), nn
// (net_usd, half-up), rr (refund_usd, half-up), d (day offset), cur, amt, pid,
// pname, pp / psig (price id and its signal), ocat / orule (one-off category
// and rule), c_date/c_funnel/c_camp (cohort attrs), lvl (subscription level),
// slot (upsell slot), lt (lifecycle_type). `upp` reads the whole tenant, never
// the narrowed `base`: a one-user details scan types exactly like the list.

import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";
import { DYNAMIC_TRIAL_TEST, oneOffTypingSql, priceSignalSql, tokenAmountSql, upsellPricePointsCte } from "./monetizationTyping.ts";

export const CLASSIFIER_TABLE = ANALYTICS_TRANSACTIONS_TABLE;

export function classifierSQL(baseWhere: string, joinKeep: string): string {
  return `
${upsellPricePointsCte()},
base AS (
  SELECT a.user_id uid, a.transaction_id tid, a.event_time et, toUnixTimestamp64Milli(a.event_time) ets,
    a.funnel funnel, a.campaign_path campaign_path,
    multiIf(a.transaction_type = 'trial', 0, a.transaction_type = 'upsell', 1, a.transaction_type = 'first_subscription', 2,
      a.transaction_type IN ('renewal_2','renewal_3','renewal'), 3, 4) tprio,
    a.status status, a.is_success is_success,
    positionCaseInsensitive(a.billing_reason, 'upsell') > 0 upmark,
    ${tokenAmountSql("a")},
    abs(toFloat64(a.original_amount) - 14.98) < 0.01 commonUp,
    multiIf(a.status = 'failed', 'failed_payment', a.status = 'refunded', 'refund', a.status = 'chargeback', 'chargeback', '') statusType,
    a.gross_amount_usd g, floor(a.net_amount_usd * 100 + 0.5) / 100 nn, floor(a.refund_amount_usd * 100 + 0.5) / 100 rr,
    a.currency cur, toFloat64(a.original_amount) amt, a.product_id pid, a.product_name pname,
    ${priceSignalSql("a")}
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
    ${oneOffTypingSql(DYNAMIC_TRIAL_TEST)}
  FROM cl
),
lifeidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) lvl FROM pretyped WHERE pretype = 'lifecycle' AND is_success = 1),
upsidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) slot FROM pretyped WHERE pretype = 'upsell' AND is_success = 1),
fin AS (
  SELECT p.uid uid, p.tid tid, p.et et, p.trial_ts trial_ts, p.is_success is_success, p.g g, p.nn nn, p.rr rr, p.d d, p.statusType statusType, p.tokenAmt tokenAmt,
    p.cur cur, p.amt amt, p.pid pid, p.pname pname, p.pp pp, p.psig psig, p.ocat ocat, p.orule orule,
    p.c_date c_date, p.c_funnel c_funnel, p.c_camp c_camp, ifNull(li.lvl, 0) lvl, ifNull(ui.slot, 0) slot,
    multiIf(p.pretype != 'lifecycle', p.pretype, li.lvl = 1, 'first_subscription', li.lvl = 2, 'renewal_2', li.lvl = 3, 'renewal_3', 'renewal') lt
  FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid) LEFT JOIN upsidx ui USING(uid, tid)
)`;
}
