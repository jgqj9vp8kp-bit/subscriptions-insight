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
//   * one run row per call in ai_assistant_runs, logging never throws.
//
// verify_jwt stays on: only a signed-in browser calls this.

import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import {
  jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser,
} from "../_shared/clickhouse/http.ts";
import {
  ASSISTANT_MAX_TOKENS,
  ASSISTANT_MODEL,
  ASSISTANT_PROMPT_VERSION,
  buildAssistantSchema,
  buildAssistantSystemPrompt,
  buildAssistantUserPrompt,
  estimateAssistantCostUsd,
  MAX_QUESTION_CHARS,
  validateAssistantAnswer,
  type AssistantAnswer,
  type AssistantInput,
} from "../_shared/clickhouse/aiAssistant.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

const CALL_TIMEOUT_MS = 90_000;

interface AssistantRequest {
  action?: "assistant_answer";
  input?: AssistantInput;
  model?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** Returns the run row's id so the client can key feedback to this exact
 * answer; null when logging fails (logging never breaks the response). */
async function logRun(supabase: SupabaseLikeClient, row: Record<string, unknown>): Promise<string | null> {
  try {
    const builder = supabase.from("ai_assistant_runs").insert?.(row);
    if (!builder) return null;
    const result = builder.select ? await builder.select("id").single() : await builder;
    return ((result.data ?? null) as { id?: string } | null)?.id ?? null;
  } catch (_error) {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  let request: AssistantRequest;
  try {
    request = await parseJsonBody<AssistantRequest>(req);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);
  const supabase = auth.supabase as unknown as SupabaseLikeClient;

  const apiKey = anthropicApiKey();
  if (!apiKey) {
    return jsonResponse({
      ok: false,
      unavailable: true,
      error: "ANTHROPIC_API_KEY is not configured — the assistant is unavailable; all deterministic AI features keep working.",
    }, 200);
  }

  const input = request.input;
  if (
    !input ||
    typeof input.question !== "string" || !input.question.trim() ||
    !input.contextPack || !Array.isArray(input.contextPack.items)
  ) {
    return jsonResponse({ ok: false, error: "Missing question or deterministic context." }, 400);
  }
  if (input.question.length > MAX_QUESTION_CHARS) {
    input.question = input.question.slice(0, MAX_QUESTION_CHARS);
  }

  const model = typeof request.model === "string" && request.model.trim() ? request.model.trim() : ASSISTANT_MODEL;
  const startedAt = Date.now();
  const baseRow = {
    auth_user_id: auth.id,
    surface: typeof input.surface === "string" ? input.surface : "global",
    provider: "anthropic",
    model,
    prompt_version: ASSISTANT_PROMPT_VERSION,
    question_chars: input.question.length,
  };

  try {
    const call = createAnthropicModelCaller(apiKey, model);
    const result = await withTimeout(
      call({
        system: buildAssistantSystemPrompt(),
        user: buildAssistantUserPrompt(input),
        schema: buildAssistantSchema(input),
        maxTokens: ASSISTANT_MAX_TOKENS,
      }),
      CALL_TIMEOUT_MS,
      "The model did not answer within 90 seconds.",
    );

    const validation = validateAssistantAnswer(result.payload as AssistantAnswer, input);
    const durationMs = Date.now() - startedAt;

    const runId = await logRun(supabase, {
      ...baseRow,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      estimated_cost_usd: estimateAssistantCostUsd(result.input_tokens, result.output_tokens),
      duration_ms: durationMs,
      status: validation.ok ? "ok" : "validation_failed",
      validation: { violations: validation.violations },
    });

    // Partial answers still return the surviving fragments (reportNarrative
    // discipline); `ok` reports whether anything was dropped.
    return jsonResponse({
      ok: validation.ok,
      promptVersion: ASSISTANT_PROMPT_VERSION,
      model,
      runId,
      answer: validation.accepted,
      validation: { ok: validation.ok, violations: validation.violations },
      usage: { inputTokens: result.input_tokens, outputTokens: result.output_tokens, durationMs },
    }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Assistant call failed.";
    const runId = await logRun(supabase, {
      ...baseRow,
      duration_ms: Date.now() - startedAt,
      status: "error",
      error: message,
    });
    // An empty Anthropic balance is an expected operational state, not a bug:
    // surface it like the missing-key case (calm), with the raw JSON kept out
    // of the UI.
    if (/credit balance is too low/i.test(message)) {
      return jsonResponse({
        ok: false,
        unavailable: true,
        error: "The Anthropic API balance is empty — top it up to enable assistant answers. All deterministic AI features keep working.",
      }, 200);
    }
    return jsonResponse({ ok: false, runId, error: message }, 200);
  }
});
