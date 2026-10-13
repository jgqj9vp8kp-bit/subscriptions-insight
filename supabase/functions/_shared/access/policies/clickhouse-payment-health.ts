// Access policy of the clickhouse-payment-health Edge function (Payment System
// Health P2 + P2.5, plan sections Q, R and X; access plan §7 / §28).
//
// Page actions, named exactly in the body (`action`): overview, declines,
// retries, refunds_support, sources, options. Alert actions (P2.5):
// alerts_list, alert_update, alerts_run — and alerts_tick, the scheduler's.
// Anything else is a 400 unknown_action — there is no default action (rule R3).
//
// Every page action and alerts_list need payment_health.view. The PSP
// dimensions — processor, merchant account (MID) and descriptor breakdowns,
// filters and options — are whole-tenant account figures behind the
// privileged key payment_health.psp_global.view (plan X). The choice (task:
// "gate the whole action or strip"): the actions stay reachable with
// payment_health.view and the runner STRIPS the PSP dimensions for a caller
// without the key (pspDimensionsVisible): the overview's PSP × MID table, the
// complaint attribution rows, the options' processor / MID / descriptor lists
// and the account references on retry rows come back empty / null, and a
// request that NAMES a PSP filter or dimension is refused with 403
// permission_denied (PaymentHealthPermissionError) rather than answered with
// other numbers than it asked for. The data owner always sees them. The same
// rule holds for alerts: alerts_list leaves out the PSP-scoped alerts (and the
// per-account evidence of the tenant-wide ones) for a caller without the key,
// and alert_update answers 404 for an alert the caller could not list.
//
// Alert writes (P2.5) need the privileged payment_health.manage_alerts
// (full funnel scope, Owner-granted; it requires payment_health.view):
//   alert_update — {alert_id, status, note}: the transition table of
//                  paymentRiskAlertsContract.ts, re-checked in SQL under a row
//                  lock, with the status history entry and an access_audit_log
//                  row (access_write_audit) in the same transaction;
//   alerts_run   — run the engine now; at most one run per 5 minutes per
//                  workspace (429 rate_limited), tracked in payment_alert_runs.
// alerts_tick is the daily pg_cron job (202610130002: pg_cron → pg_net →
// this function with x-cron-secret = FB_CRON_SECRET, like
// clickhouse-cohort-membership's cron_tick). The gate authorizes it by
// cron.actions alone; its user-side entry (owner + raw + manage_alerts) is
// never reachable, because a user request cannot even name it (the normalizer
// rejects it).
//
// No action is scopeReady and none but the tick is rawOnly: a funnel-restricted
// member gets 403 scope_not_supported (permission_denied without the key),
// exactly like Payment Pass. The restricted variant is plan phase P7. Pure
// module (vitest imports it directly).

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../errors.ts";
import {
  PAYMENT_HEALTH_ACTIONS,
  PaymentHealthPermissionError,
  PaymentHealthRequestError,
  type PaymentHealthAction,
} from "../../clickhouse/paymentHealthContract.ts";
import {
  PAYMENT_ALERT_CRON_ACTION,
  PAYMENT_ALERT_USER_ACTIONS,
  PaymentAlertNotFoundError,
  PaymentAlertTransitionError,
  PaymentAlertsRateLimitedError,
  type PaymentAlertAction,
} from "../../clickhouse/paymentRiskAlertsContract.ts";

export type ClickHousePaymentHealthAction = PaymentHealthAction | PaymentAlertAction;

/**
 * The canonical action of a request. A user request names a page action or a
 * user alert action; the cron branch (secret already verified) runs the tick
 * and nothing else, and a cron body without an action is the tick.
 */
export function normalizeClickHousePaymentHealthAction(body: Record<string, unknown>, cron = false): ClickHousePaymentHealthAction {
  const action = body.action;
  if (cron) {
    if (action === undefined || action === null || action === PAYMENT_ALERT_CRON_ACTION) return PAYMENT_ALERT_CRON_ACTION;
    throw new ActionNormalizeError();
  }
  if (typeof action === "string" && (PAYMENT_HEALTH_ACTIONS as readonly string[]).includes(action)) return action as PaymentHealthAction;
  if (typeof action === "string" && (PAYMENT_ALERT_USER_ACTIONS as readonly string[]).includes(action)) return action as PaymentAlertAction;
  throw new ActionNormalizeError();
}

export const PAYMENT_HEALTH_VIEW = "payment_health.view";
export const PAYMENT_HEALTH_PSP_GLOBAL = "payment_health.psp_global.view";
export const PAYMENT_HEALTH_MANAGE_ALERTS = "payment_health.manage_alerts";

export const CLICKHOUSE_PAYMENT_HEALTH_POLICY: FunctionPolicy<ClickHousePaymentHealthAction> = {
  fn: "clickhouse-payment-health",
  methods: ["POST"],
  normalizeAction: ({ body, cron }: NormalizeActionInput) => normalizeClickHousePaymentHealthAction(body, Boolean(cron)),
  actions: {
    overview: { anyOf: [PAYMENT_HEALTH_VIEW] },
    declines: { anyOf: [PAYMENT_HEALTH_VIEW] },
    retries: { anyOf: [PAYMENT_HEALTH_VIEW] },
    refunds_support: { anyOf: [PAYMENT_HEALTH_VIEW] },
    sources: { anyOf: [PAYMENT_HEALTH_VIEW] },
    options: { anyOf: [PAYMENT_HEALTH_VIEW] },
    alerts_list: { anyOf: [PAYMENT_HEALTH_VIEW] },
    alert_update: { allOf: [PAYMENT_HEALTH_MANAGE_ALERTS], write: true },
    alerts_run: { allOf: [PAYMENT_HEALTH_MANAGE_ALERTS], write: true },
    alerts_tick: { ownerOnly: true, rawOnly: true, allOf: [PAYMENT_HEALTH_MANAGE_ALERTS], write: true },
  },
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: [PAYMENT_ALERT_CRON_ACTION] },
};

/** Whether the caller may name and see PSP dimensions (processor, MID, descriptor): the data owner or the privileged key. */
export function pspDimensionsVisible(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has(PAYMENT_HEALTH_PSP_GLOBAL);
}

/** Whether the caller may change alert statuses and run the engine (the UI's buttons; the policy enforces it). */
export function alertsManageable(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has(PAYMENT_HEALTH_MANAGE_ALERTS);
}

/** onError mapping: a malformed request is 400, a PSP dimension without the key
 * is 403 permission_denied (the gate keeps the error_code for employees), an
 * unknown / invisible alert 404, a disallowed status change 400
 * invalid_transition, a run inside the interval 429 rate_limited; anything
 * else falls back to the gate's 502 (a ScopeViolation still becomes 500). */
export function paymentHealthErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (error instanceof PaymentHealthRequestError) {
    return { status: 400, body: { ok: false, error_code: "invalid_request", error: error.message } };
  }
  if (error instanceof PaymentHealthPermissionError) {
    return { status: 403, body: { ok: false, error_code: ACCESS_ERROR.PERMISSION_DENIED, error: error.message } };
  }
  if (error instanceof PaymentAlertNotFoundError) {
    return { status: 404, body: { ok: false, error_code: "alert_not_found", error: error.message } };
  }
  if (error instanceof PaymentAlertTransitionError) {
    return { status: 400, body: { ok: false, error_code: "invalid_transition", error: error.message, from: error.from, to: error.to } };
  }
  if (error instanceof PaymentAlertsRateLimitedError) {
    return { status: 429, body: { ok: false, error_code: "rate_limited", error: error.message, retry_after_seconds: error.retryAfterSeconds } };
  }
  return null;
}
