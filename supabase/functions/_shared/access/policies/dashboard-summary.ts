// Access policy of the dashboard-summary Edge function (plan §7 row "Dashboard
// server", D8). The function recomputes the Dashboard from the raw Postgres
// warehouse (transactions) and the cloud dataset snapshots of the workspace —
// whole-tenant inputs no funnel scope can be applied to — so it is data-owner
// only (rawOnly) on top of the page permission. Pure module.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type DashboardSummaryAction = "summary";

/** The browser posts only `{ filters }` (src/services/dashboardSummaryClient.ts),
 * so a body WITHOUT an action is the summary — the one default the frontend
 * relies on. Any other action value is rejected. */
export function normalizeDashboardSummaryAction(body: Record<string, unknown>): DashboardSummaryAction {
  if (body.action === undefined || body.action === null || body.action === "summary") return "summary";
  throw new ActionNormalizeError();
}

export const DASHBOARD_SUMMARY_POLICY: FunctionPolicy<DashboardSummaryAction> = {
  fn: "dashboard-summary",
  normalizeAction: ({ body }) => normalizeDashboardSummaryAction(body),
  actions: {
    summary: { rawOnly: true, anyOf: ["dashboard.view"] },
  },
};
