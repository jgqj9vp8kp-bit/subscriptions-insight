// Transport for the AI Assistant (client -> ai-analytics edge function).
//
// Mirrors reportAi.ts, including the one distinction that file insists on:
// "unavailable" (no key / not signed in — expected, calm UI) is NOT "error"
// (deploy/transport failure — loud UI). The deterministic AI layer never
// touches this path; only free-form questions do.
import { supabase } from "@/services/supabaseClient";
import { MAX_CONTEXT_ITEMS, type AssistantAnswer, type AssistantInput, type AssistantViolation } from "@/services/aiAssistant";

export const AI_ANALYTICS_FUNCTION = "ai-analytics";

export type AssistantOutcome =
  | { kind: "ok" | "partial"; answer: AssistantAnswer; violations: AssistantViolation[]; model: string; runId: string | null; usage: { inputTokens: number; outputTokens: number; durationMs: number } }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

interface AssistantResponseBody {
  ok?: boolean;
  unavailable?: boolean;
  error?: string;
  model?: string;
  runId?: string | null;
  answer?: AssistantAnswer;
  validation?: { ok: boolean; violations: AssistantViolation[] };
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

export async function askAssistant(input: AssistantInput): Promise<AssistantOutcome> {
  if (!supabase) return { kind: "unavailable", reason: "Supabase is not configured." };
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { kind: "unavailable", reason: "Sign in to use the assistant." };

  // The prompt builder slices anyway; slicing here too keeps huge packs
  // (500+ cohort rows) off the wire entirely.
  const payload: AssistantInput =
    input.contextPack.items.length > MAX_CONTEXT_ITEMS
      ? { ...input, contextPack: { ...input.contextPack, items: input.contextPack.items.slice(0, MAX_CONTEXT_ITEMS) } }
      : input;

  const { data, error } = await supabase.functions.invoke(AI_ANALYTICS_FUNCTION, {
    body: { action: "assistant_answer", input: payload },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error) {
    // The function answers 200 with a reason for every expected outcome, so
    // reaching here means transport failed — most often not deployed yet.
    return { kind: "error", message: error.message };
  }

  const body = (data ?? {}) as AssistantResponseBody;
  if (body.unavailable) return { kind: "unavailable", reason: body.error ?? "The model is not configured." };
  if (!body.answer) return { kind: "error", message: body.error ?? "Empty assistant response." };

  return {
    kind: body.ok ? "ok" : "partial",
    answer: body.answer,
    violations: body.validation?.violations ?? [],
    model: body.model ?? "",
    runId: body.runId ?? null,
    usage: body.usage ?? { inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}
