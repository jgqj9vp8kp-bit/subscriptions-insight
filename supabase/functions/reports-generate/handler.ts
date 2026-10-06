// reports-generate request handler, behind REPORTS_GENERATE_POLICY
// (reports.edit + ai.use).
//
// Kept apart from index.ts so it stays pure (no Deno globals, no esm.sh SDK):
// the Anthropic transport and the API-key reader are injected, and vitest drives
// this handler through the gate core with fakes. index.ts only wires them.
//
// Access-control rules this handler adds on top of the gate:
//   * report_id must name a report OWNED BY THE ACTOR (reports are actor-owned
//     rows: reports.auth_user_id = the author). Anything else — another
//     member's report, a deleted one, a malformed id — is 404 report_not_found
//     before any model call (rule R11: no existence oracle). A lookup failure is
//     503, never "allow" (R2). A request without a report_id stays allowed: the
//     id only labels the run row, and no report data is read here;
//   * the model is a server decision (resolveAllowedModel), else NARRATIVE_MODEL;
//   * the run row is keyed by ctx.actor.userId, never ctx.tenantKey.
// Everything else — the 200-with-outcome contract, the response body, the
// timeout and the "logging never fails a generation" rule — is unchanged.

import type { AccessContext, AccessHandler } from "../_shared/access/gate.ts";
import { ACCESS_ERROR, accessDenial } from "../_shared/access/errors.ts";
import { isUuid } from "../_shared/access/accessContext.ts";
import type { ReportsGenerateAction } from "../_shared/access/policies/reports-generate.ts";
import { resolveAllowedModel } from "../_shared/aiModels.ts";
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
import type { ModelCaller } from "../_shared/clickhouse/supportClassifier.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

/** A single generation must not hold the connection open indefinitely: the
 * operator is watching a spinner, and a hung call is worse than a failed one
 * because nothing tells them to try again. */
const CALL_TIMEOUT_MS = 90_000;

/** What a member who is not the data owner sees when the model call fails. */
export const NARRATIVE_FAILED_MESSAGE = "Не удалось сгенерировать формулировки. Попробуйте ещё раз.";

/** 404 code for a report the actor cannot reach (not an ACCESS_ERROR: the
 * request is authorized, the object just does not exist for this actor). */
export const REPORT_NOT_FOUND = "report_not_found";

interface GenerateRequest {
  action?: "generate" | "regenerate_block";
  report_id?: string | null;
  block_id?: string;
  input?: NarrativeInput;
  model?: string;
}

export interface ReportsGenerateHandlerDeps {
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

async function logRun(
  supabase: SupabaseLikeClient,
  row: Record<string, unknown>,
): Promise<void> {
  // Never let logging fail a generation: the operator's text matters more than
  // the diagnostics row about it.
  try {
    await supabase.from("report_ai_runs").insert?.(row);
  } catch (_error) {
    // Intentionally swallowed; the response already carries the outcome.
  }
}

/** "owned" | "missing" (404) | "error" (503). Reads only the id column of a row
 * the actor authored — the service-role client bypasses RLS, so the author
 * predicate here IS the ownership check. */
export async function reportOwnership(
  supabase: SupabaseLikeClient,
  ctx: AccessContext,
  reportId: unknown,
): Promise<"owned" | "missing" | "error"> {
  const actor = ctx.actor.userId;
  if (!actor || !isUuid(reportId)) return "missing";
  try {
    const { data, error } = await supabase
      .from("reports")
      .select("id")
      .eq("id", reportId)
      .eq("auth_user_id", actor)
      .maybeSingle();
    if (error) return "error";
    return data ? "owned" : "missing";
  } catch (_error) {
    return "error";
  }
}

export function createReportsGenerateHandler(deps: ReportsGenerateHandlerDeps): AccessHandler<ReportsGenerateAction> {
  const timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;

  return async ({ ctx, action, body, pg }) => {
    const request = body as GenerateRequest;
    const supabase = pg as SupabaseLikeClient;

    // Ownership before anything else (including the "no API key" answer), so the
    // response never depends on whether someone else's report exists.
    const reportId = request.report_id ?? null;
    if (reportId !== null) {
      const ownership = await reportOwnership(supabase, ctx, reportId);
      if (ownership === "error") {
        const denial = accessDenial(503, ACCESS_ERROR.ACCESS_SERVICE_ERROR);
        return json({ ok: false, error_code: denial.error_code, error: denial.error }, denial.status);
      }
      if (ownership === "missing") return json({ ok: false, error_code: REPORT_NOT_FOUND, error: "Report not found." }, 404);
    }

    const apiKey = deps.apiKey();
    if (!apiKey) {
      // Not an error state for the page: the deterministic report is complete
      // without this. The UI says the button is unavailable and why.
      return {
        ok: false,
        unavailable: true,
        error: "ANTHROPIC_API_KEY не задан — формулировки недоступны, отчёт работает без них.",
      };
    }

    const input = request.input;
    if (!input || !Array.isArray(input.kpi) || !Array.isArray(input.funnels)) {
      return json({ ok: false, error: "Не передан посчитанный вход отчёта." }, 400);
    }

    const model = resolveAllowedModel(request.model, NARRATIVE_MODEL);
    const startedAt = Date.now();

    const baseRow = {
      // The actor (the report's author, who spent the budget), not the tenant.
      auth_user_id: ctx.actor.userId,
      report_id: reportId,
      block_id: request.block_id ?? null,
      provider: "anthropic",
      model,
      prompt_version: NARRATIVE_PROMPT_VERSION,
      action,
    };

    try {
      const call = deps.createModelCaller(apiKey, model);
      const result = await withTimeout(
        call({
          system: buildNarrativeSystemPrompt(),
          user: buildNarrativeUserPrompt(input),
          schema: buildNarrativeSchema(input),
          maxTokens: NARRATIVE_MAX_TOKENS,
        }),
        timeoutMs,
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
      return {
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
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Неизвестная ошибка генерации.";
      await logRun(supabase, {
        ...baseRow,
        duration_ms: Date.now() - startedAt,
        status: "error",
        error: message,
      });
      // Model / transport text: data owner and server log only (plan §12.7).
      if (!ctx.rawAccess) {
        console.error(JSON.stringify({ event: "report_narrative_failed", request_id: ctx.requestId, error: message }));
        return { ok: false, error: NARRATIVE_FAILED_MESSAGE };
      }
      return { ok: false, error: message };
    }
  };
}
