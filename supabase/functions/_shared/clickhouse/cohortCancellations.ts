// Cohorts cancellation columns on the ClickHouse path (2026-10-18): Cancelled /
// User Cancelled / Auto Cancelled / Cancelled (still active) — until now
// hard-coded to 0 there because fact_subscriptions had no writer
// (factSubscriptionsSync.ts fills it now).
//
// Based on the legacy client engine (cohortAnalytics.ts classifyCancellation
// + subscriptionFlagsByEmail), per FunnelFox subscription of the member's email:
//   cancelled      status contains "cancel" OR renews = 0 (cancelledSubscriptionExpr);
//   user (reason)  FunnelFox says "User requested cancellation" — always a user
//                  cancel, even after a declined charge (owner decision 2026-10-19);
//   auto (failed)  a failed transaction of the same email within 48 h before
//                  cancelled_at, outside the purchase session: at least 2 h
//                  after the subscription start (CANCELLATION_PURCHASE_WINDOW_MS).
//                  A decline at checkout (a first card declined before the
//                  purchase, an upsell declined right after it) no longer makes
//                  the cancel automatic — with a 3-day trial the 48 h window
//                  covered most of the trial (owner decision 2026-10-19). Data
//                  2026-07..10: checkout declines land before the start or in
//                  its first 2 h, period charges 60 h+ after it. period_ends_at
//                  cannot bound it: FunnelFox moves it past the first charge of
//                  a paid trial (7-day trial, period end at day 14);
//   auto (period)  cancelled at or after period_ends_at;
//   user           any other cancellation before the period end;
//   unknown        no cancelled_at / period_ends_at (counted as cancelled only).
// Per member: an explicit user reason first, then auto (failed), then user, then
// auto (period end). The legacy engine has neither the reason nor the checkout
// bound. "Cancelled (still active)" = cancelled while the paid period has not
// ended (status not expired / unpaid).
//
// The flags are keyed by normalized email (the overlay's join key) and read by
// IN-subqueries over finx.u_normalized_email, exactly like support_users, so the
// finx CTEs stay as they are.

import { subscriptionsFrom, txFrom, type ScopeSql } from "./scopeSql.ts";

export const CANCELLATION_FAILURE_WINDOW_MS = 48 * 60 * 60 * 1000;
/** Declines up to this long after the subscription start belong to the checkout. */
export const CANCELLATION_PURCHASE_WINDOW_MS = 2 * 60 * 60 * 1000;
export const USER_REQUESTED_CANCELLATION = "user requested cancellation";

/** csub / cauto / cflags CTEs, comma-separated (no leading WITH or trailing comma). */
export function cancellationFlagsCTE(scope: ScopeSql): string {
  return `csub AS (
  SELECT s.normalized_email sub_email, s.subscription_id sid, s.cancelled_at cancelled_at, s.period_ends_at period_ends_at,
    s.started_at started_at,
    lowerUTF8(trim(BOTH ' ' FROM s.cancellation_reason)) = '${USER_REQUESTED_CANCELLATION}' user_requested,
    (s.period_ends_at IS NOT NULL AND s.period_ends_at > now64(3, 'UTC')
      AND positionCaseInsensitive(s.status, 'expired') = 0 AND positionCaseInsensitive(s.status, 'unpaid') = 0) still_paid
  FROM ${subscriptionsFrom(scope, "s")}
  WHERE s.auth_user_id = {auth_user_id:String} AND s.normalized_email != ''
    AND (positionCaseInsensitive(s.status, 'cancel') > 0 OR s.renews = 0)
),
cauto AS (
  SELECT DISTINCT c.sid sid
  FROM csub AS c
  INNER JOIN (
    SELECT f.normalized_email fail_email, toUnixTimestamp64Milli(f.event_time) fts
    FROM ${txFrom(scope, "f")}
    WHERE f.auth_user_id = {auth_user_id:String} AND f.status = 'failed' AND f.normalized_email != ''
  ) AS ft ON ft.fail_email = c.sub_email
  WHERE c.cancelled_at IS NOT NULL AND NOT c.user_requested
    AND ft.fts <= toUnixTimestamp64Milli(c.cancelled_at)
    AND ft.fts >= toUnixTimestamp64Milli(c.cancelled_at) - ${CANCELLATION_FAILURE_WINDOW_MS}
    AND (c.started_at IS NULL OR ft.fts >= toUnixTimestamp64Milli(c.started_at) + ${CANCELLATION_PURCHASE_WINDOW_MS})
),
cflags AS (
  SELECT c.sub_email sub_email,
    max(c.user_requested) cf_user_requested,
    max(c.sid IN (SELECT sid FROM cauto)) cf_auto_failed,
    max(c.sid NOT IN (SELECT sid FROM cauto) AND (c.user_requested OR (c.cancelled_at IS NOT NULL
      AND c.period_ends_at IS NOT NULL AND c.cancelled_at < c.period_ends_at))) cf_user,
    max(c.sid NOT IN (SELECT sid FROM cauto) AND c.cancelled_at IS NOT NULL AND c.period_ends_at IS NOT NULL
      AND NOT c.user_requested AND c.cancelled_at >= c.period_ends_at) cf_auto_period,
    max(c.still_paid) cf_still_paid
  FROM csub AS c
  GROUP BY c.sub_email
)`;
}

const MEMBER_EMAIL = "lowerUTF8(trim(BOTH ' ' FROM u_normalized_email))";

function memberIn(where: string): string {
  return `${MEMBER_EMAIL} != '' AND ${MEMBER_EMAIL} IN (SELECT sub_email FROM cflags${where ? ` WHERE ${where}` : ""})`;
}

/** Measures appended to AGGREGATE_MEASURES (needs the cflags CTE in scope). */
export function cancellationMeasuresSQL(): string {
  return [
    `uniqExactIf(uid, ${memberIn("")}) cancelled_users`,
    `uniqExactIf(uid, ${memberIn("cf_user_requested = 1 OR (cf_auto_failed = 0 AND cf_user = 1)")}) user_cancelled_users`,
    `uniqExactIf(uid, ${memberIn("cf_user_requested = 0 AND (cf_auto_failed = 1 OR (cf_user = 0 AND cf_auto_period = 1))")}) auto_cancelled_users`,
    `uniqExactIf(uid, ${memberIn("cf_still_paid = 1")}) cancelled_active_users`,
  ].join(",\n  ");
}
