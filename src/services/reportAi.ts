// Browser side of the report narrative (R9).
//
// The page hands over the already-computed narrative input and receives text
// that has already been checked against it. Nothing here decides what the model
// may say; that lives in reportNarrative.ts, which both this file and the edge
// function import from the same source.
//
// The one thing this file must get right is the difference between "the model
// is not configured" and "the generation failed". The first is an ordinary
// state of the page — the report is complete without prose — and must never be
// shown as an error.
import { supabase } from "@/services/supabaseClient";
import type {
  NarrativeInput, NarrativeResponse, NarrativeViolation,
} from "@/services/reportNarrative";

export const REPORTS_GENERATE_FUNCTION = "reports-generate";

export type NarrativeOutcome =
  | { kind: "ok"; response: NarrativeResponse; violations: NarrativeViolation[]; model: string; usage: { inputTokens: number; outputTokens: number; durationMs: number } }
  | { kind: "partial"; response: NarrativeResponse; violations: NarrativeViolation[]; model: string; usage: { inputTokens: number; outputTokens: number; durationMs: number } }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

interface GenerateResponseBody {
  ok?: boolean;
  unavailable?: boolean;
  error?: string;
  model?: string;
  response?: NarrativeResponse;
  validation?: { ok: boolean; violations: NarrativeViolation[] };
  usage?: { inputTokens: number; outputTokens: number; durationMs: number };
}

export async function generateNarrative(options: {
  input: NarrativeInput;
  reportId: string | null;
  blockId?: string | null;
}): Promise<NarrativeOutcome> {
  if (!supabase) return { kind: "unavailable", reason: "Supabase не настроен." };
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) return { kind: "unavailable", reason: "Нужно войти в аккаунт." };

  const { data, error } = await supabase.functions.invoke(REPORTS_GENERATE_FUNCTION, {
    body: {
      action: options.blockId ? "regenerate_block" : "generate",
      report_id: options.reportId,
      block_id: options.blockId ?? null,
      input: options.input,
    },
    headers: { Authorization: `Bearer ${token}` },
  });

  if (error) {
    // The function is deployed to answer 200 with a reason, so reaching here
    // means the call itself failed — most often the function is not deployed.
    return { kind: "error", message: error.message };
  }

  const body = (data ?? {}) as GenerateResponseBody;
  if (body.unavailable) {
    return { kind: "unavailable", reason: body.error ?? "Модель не настроена." };
  }
  if (!body.response) {
    return { kind: "error", message: body.error ?? "Пустой ответ функции генерации." };
  }

  const violations = body.validation?.violations ?? [];
  return {
    kind: body.ok ? "ok" : "partial",
    response: body.response,
    violations,
    model: body.model ?? "",
    usage: body.usage ?? { inputTokens: 0, outputTokens: 0, durationMs: 0 },
  };
}

export interface ReportAiRun {
  id: string;
  reportId: string | null;
  model: string;
  promptVersion: string;
  action: string;
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  durationMs: number | null;
  violations: NarrativeViolation[];
  error: string | null;
  createdAt: string;
}

export async function listReportAiRuns(reportId: string, limit = 20): Promise<ReportAiRun[]> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("report_ai_runs")
    .select("id,report_id,model,prompt_version,action,status,input_tokens,output_tokens,estimated_cost_usd,duration_ms,validation,error,created_at")
    .eq("report_id", reportId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not list AI runs: ${error.message}`);

  // Cast through unknown: PostgREST widens a runtime column list to its
  // parse-error union.
  return ((data ?? []) as unknown as Array<{
    id: string; report_id: string | null; model: string; prompt_version: string;
    action: string; status: string; input_tokens: number | null; output_tokens: number | null;
    estimated_cost_usd: number | null; duration_ms: number | null;
    validation: { violations?: NarrativeViolation[] } | null; error: string | null; created_at: string;
  }>).map((row) => ({
    id: row.id,
    reportId: row.report_id,
    model: row.model,
    promptVersion: row.prompt_version,
    action: row.action,
    status: row.status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    durationMs: row.duration_ms,
    violations: row.validation?.violations ?? [],
    error: row.error,
    createdAt: row.created_at,
  }));
}
