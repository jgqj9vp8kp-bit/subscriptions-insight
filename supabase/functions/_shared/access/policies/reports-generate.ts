// Access policy of the reports-generate Edge function (plan §7 row "Report
// prose", §22, §23). Writing AI prose into a report is an edit of that report
// that also spends model budget, so both actions need reports.edit AND ai.use.
// The report itself is an actor-owned row: the handler additionally proves that
// report_id belongs to ctx.actor.userId and answers 404 otherwise (rule R11 —
// an out-of-reach entity id is "not found", never "forbidden").
//
// Milestone A: not scopeReady. A funnel-restricted member gets 403
// scope_not_supported until saved-object scope stamps ship (Phase 4).
//
// Pure module (no Deno, no remote imports): vitest imports it directly.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ReportsGenerateAction = "generate" | "regenerate_block";

const REPORT_PROSE = ["reports.edit", "ai.use"];

/** The browser always names its action (src/services/reportAi.ts posts
 * "regenerate_block" with a block id, "generate" otherwise). The legacy "anything
 * but regenerate_block ⇒ generate" fallback is not carried over (rule R3). */
export function normalizeReportsGenerateAction(body: Record<string, unknown>): ReportsGenerateAction {
  if (body.action === "generate" || body.action === "regenerate_block") return body.action;
  throw new ActionNormalizeError();
}

export const REPORTS_GENERATE_POLICY: FunctionPolicy<ReportsGenerateAction> = {
  fn: "reports-generate",
  normalizeAction: ({ body }) => normalizeReportsGenerateAction(body),
  actions: {
    generate: { allOf: REPORT_PROSE },
    regenerate_block: { allOf: REPORT_PROSE },
  },
};
