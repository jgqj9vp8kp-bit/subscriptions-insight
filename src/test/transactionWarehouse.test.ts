import { describe, expect, it } from "vitest";
import {
  TRANSACTION_WAREHOUSE_CHUNK_SIZE,
  checksumRows,
  fallbackTransactionId,
  normalizeForWarehouse,
  prepareWarehouseRecords,
  summarizeDateRange,
  summarizeWarehouseUpsert,
  type WarehouseTransactionRecord,
} from "@/services/transactionWarehouse";
import { computeKpis } from "@/services/analytics";
import type { Transaction } from "@/services/types";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "tx_1",
    user_id: "user_1",
    email: "one@example.com",
    event_time: "2026-01-01T10:00:00.000Z",
    amount_usd: 29.99,
    gross_amount_usd: 29.99,
    refund_amount_usd: 0,
    net_amount_usd: 29.99,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "past_life",
    campaign_path: "past-life-start",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: "campaign_1",
    classification_reason: "test",
    ...overrides,
  };
}

describe("transaction warehouse import logic", () => {
  it("generates stable checksums for repeated CSV imports", async () => {
    const rows = [
      { id: "tx_1", amount: "2999", email: "one@example.com" },
      { id: "tx_2", amount: "100", email: "two@example.com" },
    ];

    await expect(checksumRows(rows)).resolves.toBe(await checksumRows(rows));
    await expect(checksumRows([...rows].reverse())).resolves.not.toBe(await checksumRows(rows));
  });

  it("uses fallback transaction identity when provider transaction_id is missing", async () => {
    const input = tx({ transaction_id: "", email: "fallback@example.com", amount_usd: 1, event_time: "2026-02-01T00:00:00.000Z" });

    const first = await fallbackTransactionId(input);
    const second = await fallbackTransactionId(input);

    expect(first).toMatch(/^fallback:/);
    expect(second).toBe(first);
  });

  it("normalizes transactions with raw and normalized payloads", async () => {
    const raw = { id: "tx_1", amount: "2999" };

    const record = await normalizeForWarehouse(tx(), raw, "batch_1", "palmer_csv");

    expect(record.transaction_id).toBe("tx_1");
    expect(record.import_batch_id).toBe("batch_1");
    expect(record.amount_gross).toBe(29.99);
    expect(record.amount_net).toBe(29.99);
    expect(record.raw_payload).toEqual(raw);
    expect(record.normalized_payload.transaction_id).toBe("tx_1");
  });

  it("dedupes overlapping rows inside one import before upsert", async () => {
    const prepared = await prepareWarehouseRecords({
      rows: [tx({ transaction_id: "tx_1" }), tx({ transaction_id: "tx_1", amount_usd: 99 })],
      batchId: "batch_1",
      source: "palmer_csv",
    });

    expect(prepared.failed).toBe(0);
    expect(prepared.records).toHaveLength(1);
    expect(prepared.records[0].transaction_id).toBe("tx_1");
  });

  it("counts inserted, updated, and skipped rows for overlapping imports", async () => {
    const existingUnchanged = await normalizeForWarehouse(tx({ transaction_id: "tx_skip" }), undefined, "old_batch", "palmer_csv");
    const existingChanged = await normalizeForWarehouse(tx({ transaction_id: "tx_update", amount_usd: 29.99 }), undefined, "old_batch", "palmer_csv");
    const incomingChanged = await normalizeForWarehouse(tx({ transaction_id: "tx_update", amount_usd: 49.99, gross_amount_usd: 49.99, net_amount_usd: 49.99 }), undefined, "new_batch", "palmer_csv");
    const incomingInserted = await normalizeForWarehouse(tx({ transaction_id: "tx_new" }), undefined, "new_batch", "palmer_csv");
    const upserted: WarehouseTransactionRecord[] = [];

    const summary = await summarizeWarehouseUpsert(
      [existingUnchanged, incomingChanged, incomingInserted],
      {
        async fetchExisting(ids) {
          return [
            {
              transaction_id: "tx_skip",
              normalized_payload: existingUnchanged.normalized_payload,
            },
            {
              transaction_id: "tx_update",
              normalized_payload: existingChanged.normalized_payload,
            },
          ].filter((row) => ids.includes(row.transaction_id));
        },
        async upsertTransactions(records) {
          upserted.push(...records);
        },
      },
    );

    expect(summary).toEqual({
      inserted: 1,
      updated: 1,
      skipped: 1,
      potentialDuplicates: 2,
      overlapsExisting: true,
    });
    expect(upserted.map((record) => record.transaction_id).sort()).toEqual(["tx_new", "tx_update"]);
  });

  it("chunks large imports instead of upserting row by row", async () => {
    const rows = await Promise.all(
      Array.from({ length: TRANSACTION_WAREHOUSE_CHUNK_SIZE + 25 }, (_, index) =>
        normalizeForWarehouse(tx({ transaction_id: `tx_${index}` }), undefined, "batch_1", "palmer_csv"),
      ),
    );
    const upsertSizes: number[] = [];

    await summarizeWarehouseUpsert(rows, {
      async fetchExisting() {
        return [];
      },
      async upsertTransactions(records) {
        upsertSizes.push(records.length);
      },
    });

    expect(upsertSizes).toEqual([TRANSACTION_WAREHOUSE_CHUNK_SIZE, 25]);
  });

  it("tracks the imported event date range for partial CSV files", async () => {
    const records = await Promise.all([
      normalizeForWarehouse(tx({ transaction_id: "tx_1", event_time: "2026-05-15T12:00:00.000Z" }), undefined, "batch_1", "palmer_csv"),
      normalizeForWarehouse(tx({ transaction_id: "tx_2", event_time: "2026-05-01T12:00:00.000Z" }), undefined, "batch_1", "palmer_csv"),
    ]);

    expect(summarizeDateRange(records)).toEqual({
      from: "2026-05-01",
      to: "2026-05-15",
    });
  });

  it("merges three partial imports into one append-only warehouse without duplicate history loss", async () => {
    const warehouse = new Map<string, WarehouseTransactionRecord>();
    const runImport = async (rows: Transaction[], batchId: string) => {
      const records = await Promise.all(
        rows.map((row) => normalizeForWarehouse(row, undefined, batchId, "palmer_csv")),
      );
      return summarizeWarehouseUpsert(records, {
        async fetchExisting(ids) {
          return ids
            .map((id) => warehouse.get(id))
            .filter((record): record is WarehouseTransactionRecord => Boolean(record))
            .map((record) => ({
              transaction_id: record.transaction_id,
              normalized_payload: record.normalized_payload,
            }));
        },
        async upsertTransactions(upsertRecords) {
          for (const record of upsertRecords) warehouse.set(record.transaction_id, record);
        },
      });
    };

    await expect(runImport([
      tx({ transaction_id: "may_01", event_time: "2026-05-01T10:00:00.000Z", amount_usd: 1, gross_amount_usd: 1, net_amount_usd: 1 }),
      tx({ transaction_id: "may_10", event_time: "2026-05-10T10:00:00.000Z", amount_usd: 29.99, gross_amount_usd: 29.99, net_amount_usd: 29.99 }),
      tx({ transaction_id: "may_15", event_time: "2026-05-15T10:00:00.000Z", amount_usd: 29.99, gross_amount_usd: 29.99, net_amount_usd: 29.99 }),
    ], "batch_1")).resolves.toMatchObject({ inserted: 3, updated: 0, skipped: 0, overlapsExisting: false });

    await expect(runImport([
      tx({ transaction_id: "may_10", event_time: "2026-05-10T10:00:00.000Z", amount_usd: 29.99, gross_amount_usd: 29.99, net_amount_usd: 29.99 }),
      tx({ transaction_id: "may_15", event_time: "2026-05-15T10:00:00.000Z", amount_usd: 49.99, gross_amount_usd: 49.99, net_amount_usd: 49.99 }),
      tx({ transaction_id: "may_25", event_time: "2026-05-25T10:00:00.000Z", amount_usd: 29.99, gross_amount_usd: 29.99, net_amount_usd: 29.99 }),
    ], "batch_2")).resolves.toMatchObject({ inserted: 1, updated: 1, skipped: 1, potentialDuplicates: 2, overlapsExisting: true });

    await expect(runImport([
      tx({ transaction_id: "may_25", event_time: "2026-05-25T10:00:00.000Z", amount_usd: 29.99, gross_amount_usd: 29.99, net_amount_usd: 29.99 }),
      tx({ transaction_id: "jun_01", event_time: "2026-06-01T10:00:00.000Z", amount_usd: 29.99, gross_amount_usd: 29.99, net_amount_usd: 29.99 }),
    ], "batch_3")).resolves.toMatchObject({ inserted: 1, updated: 0, skipped: 1, potentialDuplicates: 1, overlapsExisting: true });

    expect(Array.from(warehouse.keys()).sort()).toEqual(["jun_01", "may_01", "may_10", "may_15", "may_25"]);
    expect((warehouse.get("may_15")?.normalized_payload as Transaction).amount_usd).toBe(49.99);

    const mergedTransactions = Array.from(warehouse.values()).map((record) => record.normalized_payload as Transaction);
    expect(computeKpis(mergedTransactions).totalRevenue).toBe(140.96);
  });
});
