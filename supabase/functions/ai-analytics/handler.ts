// ai-analytics request handler, behind AI_ANALYTICS_POLICY (ai.use).
//
// Kept apart from index.ts so it stays pure (no Deno globals, no esm.sh SDK):
// the Anthropic transport and the API-key reader are injected, and vitest drives
// this handler through the gate core with fakes. index.ts only wires them.
//
// Access-control rules this handler adds on top of the gate:
//   * the model is a server decision (resolveAllowedModel): a body `model` is
//     honoured only when it is on the allowlist, else ASSISTANT_MODEL;
//   * the run row is keyed by ctx.actor.userId — the person who spent the model
//     budget — never by ctx.tenantKey (the workspace data owner).
// Everything else — the 200-with-outcome contract, the response body, the
// timeout and the "logging never throws" rule — is unchanged.

import type { AccessHandler } from "../_shared/access/gate.ts";
import type { AiAnalyticsAction } from "../_shared/access/policies/ai-analytics.ts";
import { resolveAllowedModel } from "../_shared/aiModels.ts";
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
import type { ModelCaller } from "../_shared/clickhouse/supportClassifier.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

const CALL_TIMEOUT_MS = 90_000;

/** What a member who is not the data owner sees when the model call fails. */
export const ASSISTANT_FAILED_MESSAGE = "The assistant could not answer this time. Please try again.";

interface AssistantRequest {
  action?: "assistant_answer";
  input?: AssistantInput;
  model?: string;
}

export interface AiAnalyticsHandlerDeps {
  /** ANTHROPIC_API_KEY, or null when it is not configured. */
  apiKey(): string | null;
  createModelCaller(apiKey: string, model: string): ModelCaller;
  /** Defaults to 90 s. */
  timeoutMs?: number;
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

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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

export function createAiAnalyticsHandler(deps: AiAnalyticsHandlerDeps): AccessHandler<AiAnalyticsAction> {
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;

  return async ({ ctx, body, pg }) => {
    const request = body as AssistantRequest;
    const supabase = pg as SupabaseLikeClient;

    const apiKey = deps.apiKey();
    if (!apiKey) {
      return {
        ok: false,
        unavailable: true,
        error: "ANTHROPIC_API_KEY is not configured — the assistant is unavailable; all deterministic AI features keep working.",
      };
    }

    const input = request.input;
    if (
      !input ||
      typeof input.question !== "string" || !input.question.trim() ||
      !input.contextPack || !Array.isArray(input.contextPack.items)
    ) {
      return json({ ok: false, error: "Missing question or deterministic context." }, 400);
    }
    if (input.question.length > MAX_QUESTION_CHARS) {
      input.question = input.question.slice(0, MAX_QUESTION_CHARS);
    }

    const model = resolveAllowedModel(request.model, ASSISTANT_MODEL);
    const startedAt = Date.now();
    const baseRow = {
      // The actor (who asked and spent the budget), not the workspace tenant.
      auth_user_id: ctx.actor.userId,
      surface: typeof input.surface === "string" ? input.surface : "global",
      provider: "anthropic",
      model,
      prompt_version: ASSISTANT_PROMPT_VERSION,
      question_chars: input.question.length,
    };

    try {
      const call = deps.createModelCaller(apiKey, model);
      const result = await withTimeout(
        call({
          system: buildAssistantSystemPrompt(),
          user: buildAssistantUserPrompt(input),
          schema: buildAssistantSchema(input),
          maxTokens: ASSISTANT_MAX_TOKENS,
        }),
        timeoutMs,
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
      return {
        ok: validation.ok,
        promptVersion: ASSISTANT_PROMPT_VERSION,
        model,
        runId,
        answer: validation.accepted,
        validation: { ok: validation.ok, violations: validation.violations },
        usage: { inputTokens: result.input_tokens, outputTokens: result.output_tokens, durationMs },
      };
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
        return {
          ok: false,
          unavailable: true,
          error: "The Anthropic API balance is empty — top it up to enable assistant answers. All deterministic AI features keep working.",
        };
      }
      // Model / transport text is for the data owner and the server log only
      // (plan §12.7: employees get a fixed message; the gate only sanitizes
      // thrown errors, and this outcome is a 200 body).
      if (!ctx.rawAccess) {
        console.error(JSON.stringify({ event: "ai_assistant_failed", request_id: ctx.requestId, run_id: runId, error: message }));
        return { ok: false, runId, error: ASSISTANT_FAILED_MESSAGE };
      }
      return { ok: false, runId, error: message };
    }
  };
}
