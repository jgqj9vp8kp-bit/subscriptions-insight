import { describe, expect, it, vi } from "vitest";
import {
  BACKFILL_PASS_BATCH_SIZE,
  BACKFILL_PASS_MAX_BATCHES,
  describeClickHouseBackfillLoop,
  runClickHouseBackfillToCompletion,
  type ClickHouseBackfillRequest,
  type ClickHouseBackfillResult,
} from "@/services/clickhouse";

// The manual Integrations buttons loop small passes until the source is caught
// up: a single Edge request must stay under the runtime's CPU budget (the
// 2,000 × 10 requests of October 2026 were killed mid-run and left the lease
// held), so the loop — not the request — covers the table.

function result(overrides: Partial<ClickHouseBackfillResult> = {}): ClickHouseBackfillResult {
  return {
    mode: "continue",
    dry_run: false,
    status: "partial",
    stopped_reason: "max_batches_reached",
    current_stage: "idle",
    batch_size: BACKFILL_PASS_BATCH_SIZE,
    max_batches: BACKFILL_PASS_MAX_BATCHES,
    rows_scanned: 500,
    rows_mapped: 500,
    rows_inserted: 500,
    rows_skipped: 0,
    batches_processed: 2,
    cursor_updated_at: "2026-10-01T00:00:00.000Z",
    cursor_transaction_id: "t-1",
    source_total: 70_000,
    clickhouse_total: 70_000,
    duration_ms: 1_000,
    ...overrides,
  };
}

function fakeRun(outcomes: ClickHouseBackfillResult[]) {
  const requests: ClickHouseBackfillRequest[] = [];
  const run = vi.fn(async (request: ClickHouseBackfillRequest) => {
    requests.push(request);
    return outcomes[Math.min(requests.length - 1, outcomes.length - 1)];
  });
  return { run, requests };
}

describe("runClickHouseBackfillToCompletion", () => {
  it("resets the cursor on the first full pass only, then continues in small passes until completed", async () => {
    const { run, requests } = fakeRun([result(), result(), result({ status: "completed", stopped_reason: "completed", batches_processed: 1, rows_inserted: 120, rows_scanned: 120 })]);
    const progress: number[] = [];
    const loop = await runClickHouseBackfillToCompletion({ mode: "full_backfill", run, onProgress: (p) => progress.push(p.rows_inserted) });

    expect(requests).toHaveLength(3);
    expect(requests[0]).toEqual({ mode: "full_backfill", batch_size: 250, max_batches: 2, dry_run: false, full_reset_cursor: true });
    expect(requests[1]).toEqual({ mode: "continue", batch_size: 250, max_batches: 2, dry_run: false, full_reset_cursor: false });
    expect(requests[2].full_reset_cursor).toBe(false);
    expect(loop.stopped).toBe("completed");
    expect(loop.passes).toBe(3);
    expect(loop.rows_inserted).toBe(1_120);
    expect(loop.batches_processed).toBe(5);
    expect(progress).toEqual([500, 1_000, 1_120]);
    expect(loop.last.status).toBe("completed");
  });

  it("a continue loop never resets the cursor", async () => {
    const { run, requests } = fakeRun([result({ status: "completed", stopped_reason: "completed" })]);
    const loop = await runClickHouseBackfillToCompletion({ mode: "continue", run });
    expect(requests).toEqual([{ mode: "continue", batch_size: 250, max_batches: 2, dry_run: false, full_reset_cursor: false }]);
    expect(loop.stopped).toBe("completed");
  });

  it("stops when another run holds the server lease, and says so", async () => {
    const held = result({ status: "running", stopped_reason: "already_running", batches_processed: 0, rows_inserted: 0, rows_scanned: 0, lease_retry_after: "2026-10-11T23:20:00.000Z" });
    const { run, requests } = fakeRun([result(), held, result()]);
    const loop = await runClickHouseBackfillToCompletion({ mode: "continue", run });
    expect(requests).toHaveLength(2);
    expect(loop.stopped).toBe("already_running");
    expect(loop.rows_inserted).toBe(500);
    expect(describeClickHouseBackfillLoop(loop)).toMatch(/^500 rows inserted in 1 pass\. Another backfill run holds the lease/);
  });

  it("stops on a failed run and on a pass that makes no progress", async () => {
    const failed = await runClickHouseBackfillToCompletion({ mode: "continue", run: fakeRun([result({ status: "failed", stopped_reason: "clickhouse_error" })]).run });
    expect(failed.stopped).toBe("failed");
    expect(describeClickHouseBackfillLoop(failed)).toBe("failed: 500 rows inserted in 1 pass.");

    const stuck = await runClickHouseBackfillToCompletion({ mode: "continue", run: fakeRun([result({ batches_processed: 0, rows_inserted: 0, rows_scanned: 0, stopped_reason: "soft_timeout" })]).run });
    expect(stuck.stopped).toBe("no_progress");
    expect(describeClickHouseBackfillLoop(stuck)).toContain("made no progress (stopped: soft_timeout)");
  });

  it("honours the pass ceiling and tells the operator to continue", async () => {
    const { run, requests } = fakeRun([result()]);
    const loop = await runClickHouseBackfillToCompletion({ mode: "continue", run, maxPasses: 3 });
    expect(requests).toHaveLength(3);
    expect(loop.stopped).toBe("max_passes");
    expect(loop.passes).toBe(3);
    expect(describeClickHouseBackfillLoop(loop)).toBe("1,500 rows inserted in 3 passes; pass ceiling reached — press Continue Backfill to go on.");
  });

  it("keeps every pass small: the request constants are the CPU-safe ones", () => {
    expect(BACKFILL_PASS_BATCH_SIZE * BACKFILL_PASS_MAX_BATCHES).toBeLessThanOrEqual(500);
  });
});
