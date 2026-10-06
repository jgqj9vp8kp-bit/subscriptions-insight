// Access policy of the clickhouse-payment-analytics Edge function (plan §7 row
// "Payment Pass / Banks", §23 "the pass-rate bundle", §28 "Via body flags or
// default actions").
//
// Before access control the function answered ANY unrecognized action with the
// full Payment Pass bundle. The normalizer below maps only the actions the
// browser sends and rejects everything else (400 unknown_action):
//   * "analytics" (src/services/paymentAnalyticsDataSource.ts) or "bundle" → bundle
//   * "banks" / "bank_detail" (src/services/bankAnalyticsDataSource.ts)
//   * purpose "ai_pass_rates" on an analytics request → ai_pass_rates: the AI
//     signal chips on Cohorts and FB Analytics (src/hooks/useAiCohortSignals.ts)
//     read only pass rates per campaign_path / campaign_id, so that call needs
//     ai.use plus the page that hosts the chips — not payment_pass.view. Members
//     without payment_pass.view get the reduced projection (runAiPassRates).
//
// No action is scopeReady: funnel-restricted members get 403
// scope_not_supported. Pure module (vitest imports it directly).

import type { FunctionPolicy } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHousePaymentAnalyticsAction = "bundle" | "banks" | "bank_detail" | "ai_pass_rates";

/** Body field value that marks the AI pass-rate call (`purpose: "ai_pass_rates"`). */
export const PAYMENT_ANALYTICS_AI_PURPOSE = "ai_pass_rates";

export function normalizeClickHousePaymentAnalyticsAction(body: Record<string, unknown>): ClickHousePaymentAnalyticsAction {
  const action = body.action;
  const isBundle = action === "analytics" || action === "bundle";
  if (body.purpose !== undefined && body.purpose !== null) {
    // A purpose flag is only meaningful on an analytics request; on anything
    // else (or with an unknown value) it is a malformed request, never ignored.
    if (body.purpose === PAYMENT_ANALYTICS_AI_PURPOSE && isBundle) return "ai_pass_rates";
    throw new ActionNormalizeError();
  }
  if (isBundle) return "bundle";
  if (action === "banks") return "banks";
  if (action === "bank_detail") return "bank_detail";
  throw new ActionNormalizeError();
}

/** Whether an ai_pass_rates caller may see the whole bundle of its request
 * (the data owner, or anyone who may open the Payment Pass tab anyway). */
export function paymentPassFullBundleAllowed(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has("payment_pass.view");
}

export const CLICKHOUSE_PAYMENT_ANALYTICS_POLICY: FunctionPolicy<ClickHousePaymentAnalyticsAction> = {
  fn: "clickhouse-payment-analytics",
  normalizeAction: ({ body }) => normalizeClickHousePaymentAnalyticsAction(body),
  actions: {
    bundle: { anyOf: ["payment_pass.view"] },
    banks: { anyOf: ["payment_pass.banks.view"] },
    bank_detail: { anyOf: ["payment_pass.banks.view"] },
    ai_pass_rates: { allOf: ["ai.use"], anyOf: ["cohorts.view", "facebook_analytics.view"] },
  },
};
