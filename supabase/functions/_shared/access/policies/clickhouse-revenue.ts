// Access policy of the clickhouse-revenue Edge function (plan §7 row "Revenue
// Intelligence"). Its only caller is the Dashboard's Revenue Intelligence
// section (src/hooks/useRevenueIntelligence.ts → RevenueIntelligenceSection on
// "/"), so both actions need dashboard.view.
//
// Not scopeReady: the restricted path (memberWhere scope, forced filtersActive,
// unattributed / spend streams dropped) is Milestone B. Until then a
// funnel-restricted member gets 403 scope_not_supported. Pure module.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseRevenueAction = "bundle" | "day_breakdown";

/** The browser always names its action ("bundle" / "day_breakdown"), so the
 * legacy "anything else ⇒ bundle" fallback is not carried over (rule R3). */
export function normalizeClickHouseRevenueAction(body: Record<string, unknown>): ClickHouseRevenueAction {
  if (body.action === "bundle") return "bundle";
  if (body.action === "day_breakdown") return "day_breakdown";
  throw new ActionNormalizeError();
}

export const CLICKHOUSE_REVENUE_POLICY: FunctionPolicy<ClickHouseRevenueAction> = {
  fn: "clickhouse-revenue",
  normalizeAction: ({ body }) => normalizeClickHouseRevenueAction(body),
  actions: {
    bundle: { anyOf: ["dashboard.view"] },
    day_breakdown: { anyOf: ["dashboard.view"] },
  },
};
