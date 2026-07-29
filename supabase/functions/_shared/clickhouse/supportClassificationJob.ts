// Resumable support-classification job.
//
// Same shape as the ClickHouse validation pipeline already in this repo: one
// invocation processes a bounded chunk, persists its cursor, and returns
// "partial" so the client calls again. That is what lets a 2 700-email backfill
// survive the Edge Function time limit and a page reload.
//
// Ordering is oldest-first on (received_at, id). A partial run therefore always
// leaves a contiguous classified prefix — never a random half — so stopping and
// resuming later is always safe.
import {
  CLASSIFICATION_MODEL,
  buildSupportRequestPatch,
  classifyEmails,
  toClassifiableEmails,
  type ModelCaller,
} from "./supportClassifier.ts";
import { SUPPORT_CLASSIFICATION_VERSION_V2 } from "./supportTaxonomy.ts";
import type { SupabaseLikeClient, SupabaseQueryResult } from "./types.ts";

/** The chain this job builds. Declared standalone rather than as an
 * intersection with SupabaseQueryBuilder so every method keeps returning this
 * type — the shared interface declares neq/update/delete as optional (so older
 * test fakes stay valid) and its return types would widen the chain. The real
 * supabase-js client satisfies all of it. */
interface JobQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string, options?: Record<string, unknown>): JobQueryBuilder;
  eq(column: string, value: unknown): JobQueryBuilder;
  neq(column: string, value: unknown): JobQueryBuilder;
  or(filters: string): JobQueryBuilder;
  order(column: string, options?: Record<string, unknown>): JobQueryBuilder;
  limit(count: number): JobQueryBuilder;
  update(values: unknown): JobQueryBuilder;
  delete(): JobQueryBuilder;
  upsert(values: unknown, options?: Record<string, unknown>): Promise<SupabaseQueryResult>;
  maybeSingle(): Promise<SupabaseQueryResult>;
}

const table = (supabase: SupabaseLikeClient, name: string): JobQueryBuilder =>
  supabase.from(name) as unknown as JobQueryBuilder;

export const SUPPORT_CLASSIFICATION_JOB = "support_classification_v2";

const DEFAULT_BATCH_SIZE = 20;
const DEFAULT_MAX_BATCHES = 5;
const DEFAULT_SOFT_TIMEOUT_MS = 90_000;
const MAX_BATCH_SIZE = 40;
const MAX_MAX_BATCHES = 40;

export type ClassificationAction = "start" | "continue" | "status" | "reset";
export type ClassificationStatus = "never_started" | "running" | "partial" | "completed" | "failed";

export interface ClassificationJobRequest {
  action?: ClassificationAction | string;
  model?: string;
  batch_size?: number;
  max_batches?: number;
  soft_timeout_ms?: number;
  /** Re-classify rows already on the current version (a taxonomy or prompt
   * change). Off by default: normal runs only touch what is stale. */
  reclassify_all?: boolean;
}

export interface ClassificationProgress {
  ok: boolean;
  action: ClassificationAction;
  status: ClassificationStatus;
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

interface JobState {
  auth_user_id: string;
  job_name: string;
  status: ClassificationStatus;
  classification_version: string | null;
  model: string | null;
  cursor_received_at: string | null;
  cursor_request_id: string | null;
  rows_scanned: number;
  rows_classified: number;
  rows_failed: number;
  rows_expected: number | null;
  batches_processed: number;
  api_requests: number;
  input_tokens: number;
  output_tokens: number;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string | null;
  stopped_reason: string | null;
  last_error: string | null;
}

export interface ClassificationJobInput {
  supabase: SupabaseLikeClient;
  authUserId: string;
  request: ClassificationJobRequest;
  /** Null when ANTHROPIC_API_KEY is absent: the job then reports why instead of
   * failing, and rows keep their rule-based classification. */
  callModel: ModelCaller | null;
  model?: string;
  now?: () => number;
}

const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
};

export function normalizeAction(action: unknown): ClassificationAction {
  const value = String(action ?? "status").toLowerCase();
  if (value === "start" || value === "continue" || value === "status" || value === "reset") return value;
  throw new Error(`Unsupported classification action: ${value}`);
}

function emptyState(authUserId: string): JobState {
  return {
    auth_user_id: authUserId,
    job_name: SUPPORT_CLASSIFICATION_JOB,
    status: "never_started",
    classification_version: null,
    model: null,
    cursor_received_at: null,
    cursor_request_id: null,
    rows_scanned: 0,
    rows_classified: 0,
    rows_failed: 0,
    rows_expected: null,
    batches_processed: 0,
    api_requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    started_at: null,
    completed_at: null,
    updated_at: null,
    stopped_reason: null,
    last_error: null,
  };
}

async function loadState(supabase: SupabaseLikeClient, authUserId: string): Promise<JobState> {
  const { data, error } = await table(supabase, "support_classification_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("job_name", SUPPORT_CLASSIFICATION_JOB)
    .maybeSingle();
  if (error) throw new Error(`Could not read classification state: ${error.message}`);
  return data ? ({ ...emptyState(authUserId), ...(data as Partial<JobState>) } as JobState) : emptyState(authUserId);
}

async function saveState(supabase: SupabaseLikeClient, state: JobState): Promise<void> {
  // updated_at is owned by the table (NOT NULL default + trigger). Sending it
  // explicitly as null overrides the default and violates the constraint, so
  // the column is dropped from the payload rather than guessed at here.
  const { updated_at: _managed, ...payload } = state;
  const { error } = await table(supabase, "support_classification_state")
    .upsert(payload, { onConflict: "auth_user_id,job_name" });
  if (error) throw new Error(`Could not persist classification state: ${error.message}`);
}

/** Rows still to classify. `reclassify_all` widens it to the whole mailbox. */
function staleFilter(query: JobQueryBuilder, reclassifyAll: boolean): JobQueryBuilder {
  return reclassifyAll ? query : query.neq("classification_version", SUPPORT_CLASSIFICATION_VERSION_V2);
}

async function countPending(
  supabase: SupabaseLikeClient,
  authUserId: string,
  reclassifyAll: boolean,
): Promise<number | null> {
  const base = table(supabase, "support_requests")
    .select("id", { count: "exact", head: true })
    .eq("auth_user_id", authUserId);
  const { count, error } = await staleFilter(base, reclassifyAll);
  if (error) return null;
  return count ?? null;
}

function toProgress(state: JobState, action: ClassificationAction, durationMs: number): ClassificationProgress {
  const expected = state.rows_expected;
  const done = state.rows_classified + state.rows_failed;
  const percent = expected && expected > 0 ? Math.min(100, Math.floor((done / expected) * 100)) : state.status === "completed" ? 100 : 0;
  return {
    ok: state.status !== "failed",
    action,
    status: state.status,
    classification_version: state.classification_version,
    model: state.model,
    rows_scanned: state.rows_scanned,
    rows_classified: state.rows_classified,
    rows_failed: state.rows_failed,
    rows_expected: expected,
    rows_remaining: expected == null ? null : Math.max(0, expected - done),
    progress_percent: state.status === "completed" ? 100 : percent,
    batches_processed: state.batches_processed,
    api_requests: state.api_requests,
    input_tokens: state.input_tokens,
    output_tokens: state.output_tokens,
    started_at: state.started_at,
    completed_at: state.completed_at,
    updated_at: state.updated_at,
    stopped_reason: state.stopped_reason,
    last_error: state.last_error,
    duration_ms: durationMs,
  };
}

export async function runSupportClassificationJob(input: ClassificationJobInput): Promise<ClassificationProgress> {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();
  const action = normalizeAction(input.request.action);
  const model = input.model ?? CLASSIFICATION_MODEL;
  const reclassifyAll = input.request.reclassify_all === true;

  if (action === "status") {
    return toProgress(await loadState(input.supabase, input.authUserId), action, now() - startedAt);
  }

  if (action === "reset") {
    const { error } = await table(input.supabase, "support_classification_state")
      .delete()
      .eq("auth_user_id", input.authUserId)
      .eq("job_name", SUPPORT_CLASSIFICATION_JOB);
    if (error) throw new Error(`Could not reset classification state: ${error.message}`);
    return toProgress(emptyState(input.authUserId), action, now() - startedAt);
  }

  const batchSize = clampInt(input.request.batch_size, DEFAULT_BATCH_SIZE, 1, MAX_BATCH_SIZE);
  const maxBatches = clampInt(input.request.max_batches, DEFAULT_MAX_BATCHES, 1, MAX_MAX_BATCHES);
  const softTimeoutMs = clampInt(input.request.soft_timeout_ms, DEFAULT_SOFT_TIMEOUT_MS, 5_000, 120_000);

  let state = await loadState(input.supabase, input.authUserId);
  if (action === "start") {
    state = {
      ...emptyState(input.authUserId),
      classification_version: SUPPORT_CLASSIFICATION_VERSION_V2,
      model,
      rows_expected: await countPending(input.supabase, input.authUserId, reclassifyAll),
      started_at: new Date(now()).toISOString(),
      status: "running",
    };
    await saveState(input.supabase, state);
  }

  // Without a key the job reports why and stops. Rows keep the classification
  // the rules already gave them, so the Support page never goes blank.
  if (!input.callModel) {
    state.status = "failed";
    state.stopped_reason = "no_api_key";
    state.last_error = "ANTHROPIC_API_KEY is not configured for this project.";
    await saveState(input.supabase, state);
    return toProgress(state, action, now() - startedAt);
  }

  state.status = "running";
  state.model = model;
  state.classification_version = SUPPORT_CLASSIFICATION_VERSION_V2;

  let stopped: string = "chunk_complete";
  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (now() - startedAt > softTimeoutMs) {
        stopped = "soft_timeout";
        break;
      }

      let query = table(input.supabase, "support_requests")
        .select("id,subject,message_body,received_at")
        .eq("auth_user_id", input.authUserId);
      query = staleFilter(query, reclassifyAll);
      if (state.cursor_received_at && state.cursor_request_id) {
        // Keyset pagination: strictly after the last row of the previous chunk.
        query = query.or(
          `received_at.gt.${state.cursor_received_at},and(received_at.eq.${state.cursor_received_at},id.gt.${state.cursor_request_id})`,
        );
      }
      const { data, error } = await query
        .order("received_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(batchSize);
      if (error) throw new Error(`Could not read support rows: ${error.message}`);

      const rows = (data ?? []) as Array<{ id: string; subject: string | null; message_body: string | null; received_at: string | null }>;
      if (!rows.length) {
        stopped = "completed";
        break;
      }

      const outcome = await classifyEmails(toClassifiableEmails(rows), input.callModel, { batchSize });
      state.rows_scanned += rows.length;
      state.batches_processed += outcome.batches;
      state.api_requests += outcome.usage.api_requests;
      state.input_tokens += outcome.usage.input_tokens;
      state.output_tokens += outcome.usage.output_tokens;
      if (outcome.errors.length) state.last_error = outcome.errors[outcome.errors.length - 1];

      for (const row of rows) {
        const result = outcome.results.get(row.id);
        if (!result) {
          // Keeps its previous classification; the cursor still advances so one
          // stubborn row cannot wedge the run. `reclassify_all` re-reaches it.
          state.rows_failed += 1;
          continue;
        }
        const { error: updateError } = await table(input.supabase, "support_requests")
          .update(buildSupportRequestPatch(result, model))
          .eq("id", row.id)
          .eq("auth_user_id", input.authUserId);
        if (updateError) {
          state.rows_failed += 1;
          state.last_error = `Row ${row.id}: ${updateError.message}`.slice(0, 300);
          continue;
        }
        state.rows_classified += 1;
      }

      const last = rows[rows.length - 1];
      state.cursor_received_at = last.received_at;
      state.cursor_request_id = last.id;
      // Persist after every batch: a crash costs at most one batch of work.
      state.status = "partial";
      state.stopped_reason = "chunk_complete";
      await saveState(input.supabase, state);

      if (rows.length < batchSize) {
        stopped = "completed";
        break;
      }
      if (batch === maxBatches - 1) stopped = "max_batches_reached";
    }
  } catch (error) {
    state.status = "partial";
    state.stopped_reason = "source_error";
    state.last_error = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    await saveState(input.supabase, state);
    return toProgress(state, action, now() - startedAt);
  }

  if (stopped === "completed") {
    state.status = "completed";
    state.completed_at = new Date(now()).toISOString();
    state.rows_expected = state.rows_classified + state.rows_failed;
  } else {
    state.status = "partial";
  }
  state.stopped_reason = stopped;
  await saveState(input.supabase, state);
  return toProgress(state, action, now() - startedAt);
}
