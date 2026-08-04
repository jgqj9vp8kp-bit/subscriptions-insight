/* global Deno */

// reports-generate: the only place a model is asked to write report prose.
//
// The browser sends the ALREADY COMPUTED narrative input — the same snapshot
// and findings the page is showing — and gets back validated text. It does not
// send a prompt: prompt construction, the response schema and every validation
// rule live in _shared/clickhouse/reportNarrative.ts, so a caller cannot widen
// what the model is allowed to say by changing what it posts.
//
// Two consequences worth stating plainly:
//   * the API key never leaves this function;
//   * the function computes nothing. It receives numbers, hands them to the
//     model as strings, and checks that everything that comes back was already
//     in what it received.
//
// verify_jwt stays on: only a signed-in browser calls this.

import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import {
  jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser,
} from "../_shared/clickhouse/http.ts";
import {
  buildNarrativeSchema,
  buildNarrativeSystemPrompt,
  buildNarrativeUserPrompt,
  estimateCostUsd,
  NARRATIVE_MAX_TOKENS,
  NARRATIVE_MODEL,
  NARRATIVE_PROMPT_VERSION,
  parseNarrativeResponse,
  validateNarrative,
  type NarrativeInput,
} from "../_shared/clickhouse/reportNarrative.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

/** A single generation must not hold the connection open indefinitely: the
 * operator is watching a spinner, and a hung call is worse than a failed one
 * because nothing tells them to try again. */
const CALL_TIMEOUT_MS = 90_000;

interface GenerateRequest {
  action?: "generate" | "regenerate_block";
  report_id?: string;
  block_id?: string;
  input?: NarrativeInput;
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

async function logRun(
  supabase: SupabaseLikeClient,
  row: Record<string, unknown>,
): Promise<void> {
  // Never let logging fail a generation: the operator's text matters more than
  // the diagnostics row about it.
  try {
    await supabase.from("report_ai_runs").insert(row);
  } catch (_error) {
    // Intentionally swallowed; the response already carries the outcome.
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  let request: GenerateRequest;
  try {
    request = await parseJsonBody<GenerateRequest>(req);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);
  const supabase = auth.supabase as unknown as SupabaseLikeClient;

  const apiKey = anthropicApiKey();
  if (!apiKey) {
    // Not an error state for the page: the deterministic report is complete
    // without this. The UI says the button is unavailable and why.
    return jsonResponse({
      ok: false,
      unavailable: true,
      error: "ANTHROPIC_API_KEY не задан — формулировки недоступны, отчёт работает без них.",
    }, 200);
  }

  const input = request.input;
  if (!input || !Array.isArray(input.kpi) || !Array.isArray(input.funnels)) {
    return jsonResponse({ ok: false, error: "Не передан посчитанный вход отчёта." }, 400);
  }

  const model = typeof request.model === "string" && request.model.trim()
    ? request.model.trim()
    : NARRATIVE_MODEL;
  const action = request.action === "regenerate_block" ? "regenerate_block" : "generate";
  const startedAt = Date.now();

  const baseRow = {
    auth_user_id: auth.id,
    report_id: request.report_id ?? null,
    block_id: request.block_id ?? null,
    provider: "anthropic",
    model,
    prompt_version: NARRATIVE_PROMPT_VERSION,
    action,
  };

  try {
    const call = createAnthropicModelCaller(apiKey, model);
    const result = await withTimeout(
      call({
        system: buildNarrativeSystemPrompt(),
        user: buildNarrativeUserPrompt(input),
        schema: buildNarrativeSchema(input),
        maxTokens: NARRATIVE_MAX_TOKENS,
      }),
      CALL_TIMEOUT_MS,
      "Модель не ответила за 90 секунд.",
    );

    const parsed = parseNarrativeResponse(result.payload);
    const validation = validateNarrative(parsed, input);
    const durationMs = Date.now() - startedAt;

    await logRun(supabase, {
      ...baseRow,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      estimated_cost_usd: estimateCostUsd(result.input_tokens, result.output_tokens),
      duration_ms: durationMs,
      status: validation.ok ? "ok" : "validation_failed",
      validation: { violations: validation.violations },
    });

    // A partial pass still returns text: the fragments that survived are real,
    // and hiding them would punish the operator for the model's mistake. `ok`
    // reports whether anything was dropped.
    return jsonResponse({
      ok: validation.ok,
      promptVersion: NARRATIVE_PROMPT_VERSION,
      model,
      response: validation.accepted,
      validation: { ok: validation.ok, violations: validation.violations },
      usage: {
        inputTokens: result.input_tokens,
        outputTokens: result.output_tokens,
        durationMs,
      },
    }, 200);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка генерации.";
    await logRun(supabase, {
      ...baseRow,
      duration_ms: Date.now() - startedAt,
      status: "error",
      error: message,
    });
    return jsonResponse({ ok: false, error: message }, 200);
  }
});
