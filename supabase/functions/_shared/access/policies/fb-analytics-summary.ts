// Access policy of the fb-analytics-summary Edge function (plan §7 row "FB
// server summary", D8). The function rebuilds FB Analytics from the raw
// Postgres warehouse, the cloud dataset snapshots and the Capsuled rows of the
// workspace (raw_payload included) — whole-tenant inputs no funnel scope can be
// applied to — so it is data-owner only (rawOnly) on top of the page
// permission. Pure module.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type FbAnalyticsSummaryAction = "summary";

/** The browser posts only `{ filters }` (src/services/fbAnalyticsSummaryClient.ts),
 * so a body WITHOUT an action is the summary — the one default the frontend
 * relies on. Any other action value is rejected. */
export function normalizeFbAnalyticsSummaryAction(body: Record<string, unknown>): FbAnalyticsSummaryAction {
  if (body.action === undefined || body.action === null || body.action === "summary") return "summary";
  throw new ActionNormalizeError();
}

export const FB_ANALYTICS_SUMMARY_POLICY: FunctionPolicy<FbAnalyticsSummaryAction> = {
  fn: "fb-analytics-summary",
  normalizeAction: ({ body }) => normalizeFbAnalyticsSummaryAction(body),
  actions: {
    summary: { rawOnly: true, anyOf: ["facebook_analytics.view"] },
  },
};
