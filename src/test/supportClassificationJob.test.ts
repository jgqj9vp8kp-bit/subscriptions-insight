// Resumable classification job. A 2 700-email backfill cannot run inside one
// Edge invocation, so what these tests pin down is the resume contract: the
// cursor only ever moves forward over rows that were actually handled, progress
// survives a mid-run failure, and a row the model could not classify keeps its
// previous category instead of being blanked.
import { describe, expect, it, vi } from "vitest";
import {
  SUPPORT_CLASSIFICATION_JOB,
  normalizeAction,
  runSupportClassificationJob,
} from "../../supabase/functions/_shared/clickhouse/supportClassificationJob.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import type { ModelCaller } from "../../supabase/functions/_shared/clickhouse/supportClassifier.ts";

interface Row {
  id: string;
  subject: string | null;
  message_body: string | null;
  received_at: string;
  classification_version: string;
}

function makeRows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index + 1).padStart(2, "0")}`,
    subject: `subject ${index + 1}`,
    message_body: "please cancel and refund",
    received_at: `2026-07-${String((index % 28) + 1).padStart(2, "0")}T10:00:00+00:00`,
    classification_version: "support_rules_v1",
  }));
}

/** Minimal in-memory stand-in for the two tables the job touches. Supports the
 * exact chain the job builds: select/eq/neq/or/order/limit, update, upsert,
 * delete, maybeSingle. */
function fakeSupabase(rows: Row[]) {
  const state = new Map<string, Record<string, unknown>>();
  const updates: Array<{ id: string; patch: Record<string, unknown> }> = [];

  function builder(tableName: string) {
    const filters: { neq?: string; after?: { received_at: string; id: string } } = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    let isDelete = false;
    let head = false;
    let targetId: string | null = null;
    let limitCount = 1000;

    const api: Record<string, unknown> = {
      select(_columns?: string, options?: Record<string, unknown>) {
        head = Boolean(options?.head);
        return api;
      },
      eq(column: string, value: unknown) {
        if (column === "id") targetId = String(value);
        return api;
      },
      neq(_column: string, value: unknown) {
        filters.neq = String(value);
        return api;
      },
      or(expression: string) {
        const gt = /received_at\.gt\.([^,]+)/.exec(expression);
        const eqId = /id\.gt\.([^)]+)\)/.exec(expression);
        if (gt && eqId) filters.after = { received_at: gt[1], id: eqId[1] };
        return api;
      },
      order() {
        return api;
      },
      limit(count: number) {
        limitCount = count;
        return api;
      },
      update(values: Record<string, unknown>) {
        pendingUpdate = values;
        return api;
      },
      delete() {
        isDelete = true;
        return api;
      },
      async upsert(values: Record<string, unknown>) {
        state.set(SUPPORT_CLASSIFICATION_JOB, { ...values });
        return { data: null, error: null };
      },
      async maybeSingle() {
        return { data: state.get(SUPPORT_CLASSIFICATION_JOB) ?? null, error: null };
      },
      then(resolve: (result: { data: unknown; error: unknown; count?: number }) => unknown) {
        if (tableName === "support_classification_state") {
          if (isDelete) state.delete(SUPPORT_CLASSIFICATION_JOB);
          return resolve({ data: null, error: null });
        }
        if (pendingUpdate && targetId) {
          updates.push({ id: targetId, patch: pendingUpdate });
          const row = rows.find((candidate) => candidate.id === targetId);
          if (row) row.classification_version = String(pendingUpdate.classification_version);
          return resolve({ data: null, error: null });
        }
        let selected = rows.filter((row) => (filters.neq ? row.classification_version !== filters.neq : true));
        if (filters.after) {
          const { received_at, id } = filters.after;
          selected = selected.filter((row) => row.received_at > received_at || (row.received_at === received_at && row.id > id));
        }
        selected = [...selected].sort((a, b) =>
          a.received_at === b.received_at ? a.id.localeCompare(b.id) : a.received_at.localeCompare(b.received_at),
        );
        if (head) return resolve({ data: null, error: null, count: selected.length });
        return resolve({ data: selected.slice(0, limitCount), error: null });
      },
    };
    return api;
  }

  const client = { from: (name: string) => builder(name) } as unknown as SupabaseLikeClient;
  return { client, updates, state };
}

const modelAnswer = (ids: string[]) => ({
  payload: {
    results: ids.map((id) => ({
      id,
      category: "Refund",
      secondary_categories: ["Cancellation"],
      language: "en",
      sentiment: "negative",
      urgency: "medium",
      confidence: 0.9,
      reason: "wants money back",
    })),
  },
  input_tokens: 200,
  output_tokens: 80,
});

const okModel: ModelCaller = vi.fn(async (request) => {
  const ids = [...request.user.matchAll(/^id: (\S+)$/gm)].map((match) => match[1]);
  return modelAnswer(ids);
});

const base = { authUserId: "user-1", model: "claude-opus-4-8" };

describe("normalizeAction", () => {
  it("accepts the four actions and rejects anything else", () => {
    expect(normalizeAction("start")).toBe("start");
    expect(normalizeAction(undefined)).toBe("status");
    expect(() => normalizeAction("delete-everything")).toThrow(/Unsupported/);
  });
});

describe("runSupportClassificationJob", () => {
  it("classifies a small mailbox in one run and reports completed", async () => {
    const rows = makeRows(5);
    const { client, updates } = fakeSupabase(rows);

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 10 },
      callModel: okModel,
    });

    expect(progress.status).toBe("completed");
    expect(progress.rows_classified).toBe(5);
    expect(progress.rows_failed).toBe(0);
    expect(progress.progress_percent).toBe(100);
    expect(updates).toHaveLength(5);
    expect(updates[0].patch).toMatchObject({
      category: "Refund",
      classification_source: "llm",
      classification_version: "support_llm_v2",
    });
  });

  it("stops at max_batches and the next call resumes after the cursor, never re-doing work", async () => {
    const rows = makeRows(10);
    const { client, updates } = fakeSupabase(rows);

    const first = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 3, max_batches: 2 },
      callModel: okModel,
    });
    expect(first.status).toBe("partial");
    expect(first.rows_classified).toBe(6);
    expect(first.stopped_reason).toBe("max_batches_reached");

    const second = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "continue", batch_size: 3, max_batches: 10 },
      callModel: okModel,
    });
    expect(second.status).toBe("completed");
    expect(second.rows_classified).toBe(10);
    // Every row updated exactly once across both runs.
    expect(updates).toHaveLength(10);
    expect(new Set(updates.map((update) => update.id)).size).toBe(10);
  });

  it("keeps the previous classification of a row the model could not resolve, and still advances", async () => {
    const rows = makeRows(3);
    const { client, updates } = fakeSupabase(rows);
    const partialModel: ModelCaller = vi.fn(async (request) => {
      const ids = [...request.user.matchAll(/^id: (\S+)$/gm)].map((match) => match[1]);
      return modelAnswer(ids.slice(0, 1)); // answers only the first email
    });

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 3 },
      callModel: partialModel,
    });

    expect(progress.rows_classified).toBe(1);
    expect(progress.rows_failed).toBe(2);
    // Unresolved rows are not written at all — they keep the rules result.
    expect(updates.map((update) => update.id)).toEqual(["row-01"]);
    expect(rows[1].classification_version).toBe("support_rules_v1");
  });

  it("keeps the work done before an API failure and leaves the failed rows for Continue", async () => {
    const rows = makeRows(6);
    const { client, state } = fakeSupabase(rows);
    let calls = 0;
    const flakyModel: ModelCaller = vi.fn(async (request) => {
      calls += 1;
      if (calls === 2) throw new Error("anthropic 529 overloaded");
      const ids = [...request.user.matchAll(/^id: (\S+)$/gm)].map((match) => match[1]);
      return modelAnswer(ids);
    });

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 2, max_batches: 3 },
      callModel: flakyModel,
    });

    // The first batch's work is kept and its cursor persisted; the batch that
    // failed is NOT counted as failed rows — the cursor never passed it, so
    // Continue re-reads exactly those emails once the API recovers.
    expect(progress.rows_classified).toBe(2);
    expect(progress.rows_failed).toBe(0);
    expect(progress.status).toBe("failed");
    expect(progress.last_error).toContain("529");
    expect(state.get(SUPPORT_CLASSIFICATION_JOB)?.cursor_request_id).toBe("row-02");
  });

  it("stops immediately on a rejected API key instead of grinding through the archive", async () => {
    // Regression: a wrong key fails every batch identically. The runner used to
    // keep calling Continue, so one bad key would burn ~120 doomed requests
    // across the whole mailbox before anyone noticed.
    const rows = makeRows(40);
    const { client, updates } = fakeSupabase(rows);
    const rejecting: ModelCaller = vi.fn(async () => {
      throw new Error('{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}');
    });

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 2, max_batches: 20 },
      callModel: rejecting,
    });

    expect(progress.status).toBe("failed");
    expect(progress.stopped_reason).toBe("api_error");
    expect(progress.last_error).toContain("authentication_error");
    expect(rejecting).toHaveBeenCalledTimes(1); // one probe, not twenty
    expect(updates).toHaveLength(0);
  });

  it("stops when every batch of a chunk failed, even on a retryable-looking error", async () => {
    const rows = makeRows(10);
    const { client } = fakeSupabase(rows);
    const overloaded: ModelCaller = vi.fn(async () => {
      throw new Error("529 overloaded");
    });

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 5, max_batches: 5 },
      callModel: overloaded,
    });

    expect(progress.status).toBe("failed");
    expect(progress.stopped_reason).toBe("api_error");
    expect(overloaded).toHaveBeenCalledTimes(1);
  });

  it("reports a missing API key instead of failing loudly, leaving rules classification in place", async () => {
    const rows = makeRows(3);
    const { client, updates } = fakeSupabase(rows);

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start" },
      callModel: null,
    });

    expect(progress.status).toBe("failed");
    expect(progress.stopped_reason).toBe("no_api_key");
    expect(progress.last_error).toContain("ANTHROPIC_API_KEY");
    expect(updates).toHaveLength(0);
  });

  it("leaves database-managed timestamps out of the write", async () => {
    // Regression: the state row's updated_at is NOT NULL with a default and a
    // trigger. Sending it explicitly as null overrode the default and the whole
    // run failed on the very first save.
    const { client, state } = fakeSupabase(makeRows(2));
    await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 2 },
      callModel: okModel,
    });
    const saved = state.get(SUPPORT_CLASSIFICATION_JOB)!;
    expect(saved).not.toHaveProperty("updated_at");
    expect(saved.status).toBe("completed");
  });

  it("status is read-only and never calls the model", async () => {
    const { client, updates } = fakeSupabase(makeRows(3));
    const spy = vi.fn();
    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "status" },
      callModel: spy as unknown as ModelCaller,
    });
    expect(progress.status).toBe("never_started");
    expect(spy).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it("reset clears the job state so a fresh start rescans from the beginning", async () => {
    const rows = makeRows(4);
    const { client, state } = fakeSupabase(rows);
    await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 2, max_batches: 1 },
      callModel: okModel,
    });
    expect(state.get(SUPPORT_CLASSIFICATION_JOB)).toBeTruthy();

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "reset" },
      callModel: okModel,
    });
    expect(progress.status).toBe("never_started");
    expect(state.get(SUPPORT_CLASSIFICATION_JOB)).toBeUndefined();
  });

  it("only scans rows that are not already on the current version", async () => {
    const rows = makeRows(4);
    rows[0].classification_version = "support_llm_v2";
    rows[1].classification_version = "support_llm_v2";
    const { client, updates } = fakeSupabase(rows);

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 10 },
      callModel: okModel,
    });

    expect(progress.rows_scanned).toBe(2);
    expect(updates.map((update) => update.id).sort()).toEqual(["row-03", "row-04"]);
  });

  it("reclassify_all re-reaches rows already on the current version", async () => {
    const rows = makeRows(3).map((row) => ({ ...row, classification_version: "support_llm_v2" }));
    const { client, updates } = fakeSupabase(rows);

    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 10, reclassify_all: true },
      callModel: okModel,
    });

    expect(progress.rows_classified).toBe(3);
    expect(updates).toHaveLength(3);
  });

  it("stops on the soft timeout with progress saved", async () => {
    const rows = makeRows(20);
    const { client } = fakeSupabase(rows);
    // Clock advances 1.5s per read, so the budget covers a couple of batches
    // and then runs out mid-run — the case the soft timeout exists for.
    let clock = 0;
    const progress = await runSupportClassificationJob({
      ...base,
      supabase: client,
      request: { action: "start", batch_size: 2, max_batches: 10, soft_timeout_ms: 5_000 },
      callModel: okModel,
      now: () => (clock += 1_500),
    });
    expect(progress.status).toBe("partial");
    expect(progress.stopped_reason).toBe("soft_timeout");
    // Work done before the budget ran out is kept, not rolled back.
    expect(progress.rows_classified).toBeGreaterThan(0);
    expect(progress.rows_classified).toBeLessThan(20);
  });
});
