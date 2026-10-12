// Access policy of the clickhouse-payment-health Edge function (Payment System
// Health P2, plan sections R and X; access plan §7 / §28).
//
// Six canonical actions, named exactly in the body (`action`): overview,
// declines, retries, refunds_support, sources, options. Anything else is a
// 400 unknown_action — there is no default action (rule R3).
//
// Every action needs payment_health.view. The PSP dimensions — processor,
// merchant account (MID) and descriptor breakdowns, filters and options — are
// whole-tenant account figures behind the privileged key
// payment_health.psp_global.view (plan X). The choice (task: "gate the whole
// action or strip"): the actions stay reachable with payment_health.view and
// the runner STRIPS the PSP dimensions for a caller without the key
// (pspDimensionsVisible): the overview's PSP × MID table, the complaint
// attribution rows, the options' processor / MID / descriptor lists and the
// account references on retry rows come back empty / null, and a request that
// NAMES a PSP filter or dimension is refused with 403 permission_denied
// (PaymentHealthPermissionError) rather than answered with other numbers than
// it asked for. The data owner always sees them.
//
// No action is scopeReady and none is rawOnly: a funnel-restricted member gets
// 403 scope_not_supported (permission_denied without the key), exactly like
// Payment Pass. The restricted variant is plan phase P7. Pure module (vitest
// imports it directly).

import type { FunctionPolicy } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../errors.ts";
import {
  PAYMENT_HEALTH_ACTIONS,
  PaymentHealthPermissionError,
  PaymentHealthRequestError,
  type PaymentHealthAction,
} from "../../clickhouse/paymentHealthContract.ts";

export type ClickHousePaymentHealthAction = PaymentHealthAction;

export function normalizeClickHousePaymentHealthAction(body: Record<string, unknown>): ClickHousePaymentHealthAction {
  const action = body.action;
  if (typeof action === "string" && (PAYMENT_HEALTH_ACTIONS as readonly string[]).includes(action)) return action as ClickHousePaymentHealthAction;
  throw new ActionNormalizeError();
}

export const PAYMENT_HEALTH_VIEW = "payment_health.view";
export const PAYMENT_HEALTH_PSP_GLOBAL = "payment_health.psp_global.view";

export const CLICKHOUSE_PAYMENT_HEALTH_POLICY: FunctionPolicy<ClickHousePaymentHealthAction> = {
  fn: "clickhouse-payment-health",
  methods: ["POST"],
  normalizeAction: ({ body }) => normalizeClickHousePaymentHealthAction(body),
  actions: {
    overview: { anyOf: [PAYMENT_HEALTH_VIEW] },
    declines: { anyOf: [PAYMENT_HEALTH_VIEW] },
    retries: { anyOf: [PAYMENT_HEALTH_VIEW] },
    refunds_support: { anyOf: [PAYMENT_HEALTH_VIEW] },
    sources: { anyOf: [PAYMENT_HEALTH_VIEW] },
    options: { anyOf: [PAYMENT_HEALTH_VIEW] },
  },
};

/** Whether the caller may name and see PSP dimensions (processor, MID, descriptor): the data owner or the privileged key. */
export function pspDimensionsVisible(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has(PAYMENT_HEALTH_PSP_GLOBAL);
}

/** onError mapping: a malformed request is 400, a PSP dimension without the key
 * is 403 permission_denied (the gate keeps the error_code for employees), anything
 * else falls back to the gate's 502 (a ScopeViolation still becomes 500). */
export function paymentHealthErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } | null {
  if (error instanceof PaymentHealthRequestError) {
    return { status: 400, body: { ok: false, error_code: "invalid_request", error: error.message } };
  }
  if (error instanceof PaymentHealthPermissionError) {
    return { status: 403, body: { ok: false, error_code: ACCESS_ERROR.PERMISSION_DENIED, error: error.message } };
  }
  return null;
}
