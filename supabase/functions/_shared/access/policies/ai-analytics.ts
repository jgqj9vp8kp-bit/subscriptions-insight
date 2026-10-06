// Access policy of the ai-analytics Edge function (plan §7 row "AI assistant",
// §23). The function sees only the context pack the browser posts — it reads no
// tenant data itself — so the gate's job here is cost control and accounting:
// the AI drawer (and every free-form question) needs ai.use, the session is
// verified BEFORE the body is parsed (the gate's order), and the run row is
// keyed by the actor, not by the workspace tenant.
//
// Milestone A: not scopeReady. A funnel-restricted member gets 403
// scope_not_supported until the context pack is proven scoped (Phase 2.4).
//
// Pure module (no Deno, no remote imports): vitest imports it directly.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type AiAnalyticsAction = "assistant_answer";

/** The browser always names its action (src/services/aiAssistantClient.ts posts
 * `{ action: "assistant_answer", input }`), so a missing or unknown action is a
 * 400 — there is no implicit default (rule R3). */
export function normalizeAiAnalyticsAction(body: Record<string, unknown>): AiAnalyticsAction {
  if (body.action === "assistant_answer") return "assistant_answer";
  throw new ActionNormalizeError();
}

export const AI_ANALYTICS_POLICY: FunctionPolicy<AiAnalyticsAction> = {
  fn: "ai-analytics",
  normalizeAction: ({ body }) => normalizeAiAnalyticsAction(body),
  actions: {
    assistant_answer: { anyOf: ["ai.use"] },
  },
};
