import { describe, expect, it } from "vitest";
import {
  buildCampaignPerformanceRows,
  collectPages,
  summarizeBatchLoad,
  type ComputeTxn,
} from "../../supabase/functions/export-campaign-performance/compute";

// Reproduces the "API uses only the latest CSV" bug: rows arrive across multiple import batches and
// the API must use ALL of them (full warehouse), classifying over each user's full history.

function wtx(o: {
  user: string;
  id: string;
  time: string;
  gross: number;
  batch: string;
  type?: string;
  campaignId?: string;
  path?: string;
}): ComputeTxn {
  return {
    user_id: o.user,
    transaction_id: o.id,
    event_time: o.time,
    status: "success",
    transaction_type: o.type ?? "trial",
    amount_usd: o.gross,
    gross_amount_usd: o.gross,
    net_amount_usd: o.gross,
    refund_amount_usd: 0,
    is_refunded: false,
    campaign_id: o.campaignId ?? "c1",
    campaign_path: o.path ?? "p1",
    funnel: "past_life",
    source: "palmer_csv",
    import_batch_id: o.batch,
  };
}

// CSV part 1: User A trial, User B trial.   CSV part 2: User A first subscription, User C trial.
// The later subscription was imported alone, so the warehouse stored it as "trial" (per-batch artifact).
const batch1And2: ComputeTxn[] = [
  wtx({ user: "A", id: "A-t", time: "2026-05-01T10:00:00Z", gross: 1, batch: "batch-1" }),
  wtx({ user: "B", id: "B-t", time: "2026-05-02T10:00:00Z", gross: 1, batch: "batch-1" }),
  wtx({ user: "A", id: "A-s", time: "2026-05-08T10:00:00Z", gross: 29, batch: "batch-2", type: "trial" }),
  wtx({ user: "C", id: "C-t", time: "2026-05-03T10:00:00Z", gross: 1, batch: "batch-2" }),
];

describe("export campaign performance — full warehouse across import batches", () => {
  it("1+3. loads multiple batches; a first subscription imported in a later file counts correctly", () => {
    const [row] = buildCampaignPerformanceRows({ txs: batch1And2 });
    expect(row.trial_users).toBe(3); // A, B, C — across both batches
    expect(row.first_sub_users).toBe(1); // A's later-batch payment re-classified as first_subscription
  });

  it("2. does not filter by latest import_batch_id (earlier-batch users still counted)", () => {
    const onlyLatest = batch1And2.filter((tx) => tx.import_batch_id === "batch-2");
    const latestRow = buildCampaignPerformanceRows({ txs: onlyLatest })[0];
    const fullRow = buildCampaignPerformanceRows({ txs: batch1And2 })[0];

    // If the API filtered to the latest batch it would see only A's payment + C's trial.
    expect(latestRow.trial_users).toBeLessThan(fullRow.trial_users);
    expect(fullRow.trial_users).toBe(3);
  });

  it("4. result is identical regardless of any frontend refresh/recalculate (pure + deterministic)", () => {
    const first = buildCampaignPerformanceRows({ txs: batch1And2 });
    const second = buildCampaignPerformanceRows({ txs: [...batch1And2].reverse() });
    expect(second).toEqual(first); // independent of row/load order and of any browser cache
  });

  it("5. pagination loads more than one Supabase page", async () => {
    const total = 2500;
    const allRows = Array.from({ length: total }, (_, i) => i);
    let calls = 0;
    const result = await collectPages(async (offset, limit) => {
      calls += 1;
      return allRows.slice(offset, offset + limit);
    }, 1000);

    expect(result).toHaveLength(total);
    expect(calls).toBe(3); // 1000 + 1000 + 500
  });

  it("summarizeBatchLoad reports rows outside the latest batch", () => {
    const summary = summarizeBatchLoad(batch1And2, "batch-2");
    expect(summary.transactions_loaded).toBe(4);
    expect(summary.import_batches_loaded).toBe(2);
    expect(summary.latest_batch_rows).toBe(2); // A-s, C-t
    expect(summary.rows_outside_latest_batch).toBe(2); // A-t, B-t (earlier CSV part)
  });
});
