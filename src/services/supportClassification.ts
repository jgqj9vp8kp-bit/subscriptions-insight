// Browser bridge to the classify-support-requests Edge Function.
//
// The Edge call handles one bounded chunk and returns "partial"; the caller
// loops until "completed" (same shape as the ClickHouse validation runner on
// the Integrations page), so a long backfill survives the function time limit.
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { supabase } from "@/services/supabaseClient";

export type SupportClassificationAction = "start" | "continue" | "status" | "reset";

export interface SupportClassificationProgress {
  ok: boolean;
  action: SupportClassificationAction;
  status: "never_started" | "running" | "partial" | "completed" | "failed";
  classification_version: string | null;
  model: string | null;
  rows_scanned: number;
  rows_classified: number;
  rows_failed: number;
  rows_expected: number | null;
  rows_remaining: number | null;
  progress_percent: number;
  batches_processed: number;
  api_requests: number;
  input_tokens: number;
  output_tokens: number;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  stopped_reason: string | null;
  last_error: string | null;
  duration_ms: number;
}

export interface SupportClassificationOptions {
  /** "rules" runs the deterministic taxonomy-v2 patterns locally — no API key,
   * no cost. "model" reads each email with Claude. */
  engine?: "model" | "rules";
  batch_size?: number;
  max_batches?: number;
  reclassify_all?: boolean;
}

export async function runSupportClassification(
  action: SupportClassificationAction,
  options: SupportClassificationOptions = {},
): Promise<SupportClassificationProgress> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before classifying support requests.");

  const baseUrl = publicRuntimeConfig.supabaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/functions/v1/classify-support-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...options }),
  });
  const payload = await response.json().catch(() => ({ error: "Invalid classification response." }));
  if (!response.ok) {
    throw new Error((payload as { error?: string }).error ?? `Classification failed with HTTP ${response.status}`);
  }
  return payload as SupportClassificationProgress;
}

/** A missing API key is a configuration problem, not a failure to retry: the
 * runner surfaces it once and stops rather than looping. */
export function isTerminalClassificationState(progress: SupportClassificationProgress): boolean {
  return progress.status === "completed" || progress.status === "failed" || progress.status === "never_started";
}
