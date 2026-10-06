/* global Deno */

// ai-analytics: the AI Assistant's only model endpoint.
//
// The browser sends the ALREADY COMPUTED deterministic context (the aiSignals
// engine's context pack — pre-rendered strings, never raw rows) plus the
// user's question, and gets back a schema-constrained, number-validated
// answer. Prompt construction, the response schema and every validation rule
// live in _shared/clickhouse/aiAssistant.ts, so a caller cannot widen what the
// model is allowed to say by changing what it posts.
//
// Mirrors reports-generate exactly:
//   * missing API key -> 200 {ok:false, unavailable:true} — the deterministic
//     AI layer (chips, panels, opportunities) is complete without the model;
//   * every failure -> 200 with the outcome in the body;
//   * one run row per call in ai_assistant_runs (keyed by the actor), logging
//     never throws.
//
// Access is decided by AI_ANALYTICS_POLICY before the handler runs (ai.use;
// funnel-restricted members are refused) and the session is verified before the
// body is parsed. The model comes from the server allowlist, never the body.
// The handler itself lives in ./handler.ts (pure, unit-tested).
//
// verify_jwt stays on: only a signed-in browser calls this.

import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { AI_ANALYTICS_POLICY } from "../_shared/access/policies/ai-analytics.ts";
import { createAiAnalyticsHandler } from "./handler.ts";

serveWithAccess(
  AI_ANALYTICS_POLICY,
  createAiAnalyticsHandler({ apiKey: anthropicApiKey, createModelCaller: createAnthropicModelCaller }),
);
