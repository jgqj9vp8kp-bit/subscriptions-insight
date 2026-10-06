// Server-side model allowlist for every Edge function that calls Anthropic.
//
// ai-analytics, reports-generate and classify-support-requests used to accept a
// free-form `model` from the request body. The browser never sends one (it only
// reads `model` back from responses), so a body-supplied model is either a
// stale client or someone picking a more expensive model on the owner's API key.
// The model is now a server decision: a requested model is honoured only when it
// is one of the models this codebase already ships with; anything else silently
// falls back to the function's default (ignoring is safer than a 400 here — no
// legitimate caller sends it, and the default is always a valid choice).
import { ASSISTANT_MODEL } from "./clickhouse/aiAssistant.ts";
import { NARRATIVE_MODEL } from "./clickhouse/reportNarrative.ts";
import { CLASSIFICATION_MODEL } from "./clickhouse/supportClassifier.ts";

export const ALLOWED_AI_MODELS: ReadonlySet<string> = new Set([ASSISTANT_MODEL, NARRATIVE_MODEL, CLASSIFICATION_MODEL]);

export function resolveAllowedModel(requested: unknown, fallback: string): string {
  const candidate = typeof requested === "string" ? requested.trim() : "";
  return candidate && ALLOWED_AI_MODELS.has(candidate) ? candidate : fallback;
}
