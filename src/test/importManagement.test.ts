import { describe, expect, it, vi } from "vitest";
import {
  CLEANUP_REMOVABLE_STATUSES,
  cleanupDuplicateImports,
  deleteImportBatch,
  getImportBatchTransactionCounts,
  planDuplicateCleanup,
  previewDuplicateCleanup,
  rollbackImportBatch,
  type ImportBatchInfo,
  type ImportBatchStatus,
  type WarehouseManagementClient,
} from "@/services/transactionWarehouse";
import {
  cleanupDuplicateImportsAndRefresh,
  deleteImportBatchAndRefresh,
  rollbackImportBatchAndRefresh,
} from "@/services/analyticsAdapters";

function batch(id: string, overrides: Partial<ImportBatchInfo> = {}): ImportBatchInfo {
  return {
    id,
    source: "primer_csv",
    filename: `${id}.csv`,
    checksum: overrides.checksum ?? `checksum-${id}`,
    rows_total: 0,
    rows_inserted: 0,
    rows_updated: 0,
    rows_skipped: 0,
    imported_at: overrides.imported_at ?? "2026-01-01T00:00:00.000Z",
    status: overrides.status ?? "completed",
    notes: null,
    metadata: null,
    ...overrides,
  };
}

interface Row {
  transaction_id: string;
  import_batch_id: string | null;
}

/**
 * In-memory client that mirrors the SQL contract: transactions are HARD-deleted BEFORE the batch
 * row (so the FK ON DELETE SET NULL can never orphan them), rollback keeps the batch row marked
 * 'rolled_back', and a missing batch aborts with an error.
 */
function makeStore(batches: ImportBatchInfo[], rows: Row[]) {
  const requireBatch = (id: string) => {
    const found = batches.find((b) => b.id === id);
    if (!found) throw new Error(`Import batch ${id} not found`);
    return found;
  };
  const removeRows = (ids: Set<string>) => {
    let removed = 0;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].import_batch_id && ids.has(rows[i].import_batch_id as string)) {
        rows.splice(i, 1);
        removed += 1;
      }
    }
    return removed;
  };
  const client: WarehouseManagementClient = {
    async deleteBatch(batchId) {
      requireBatch(batchId);
      const deleted = removeRows(new Set([batchId])); // transactions first
      batches.splice(batches.findIndex((b) => b.id === batchId), 1); // then batch
      return { batchId, deletedTransactions: deleted };
    },
    async rollbackBatch(batchId) {
      const found = requireBatch(batchId);
      const deleted = removeRows(new Set([batchId]));
      found.status = "rolled_back";
      return { batchId, deletedTransactions: deleted };
    },
    async cleanupDuplicates(dryRun) {
      const plan = planDuplicateCleanup(batches);
      const ids = new Set(plan.deleteIds);
      const transactionsRemoved = rows.filter((r) => r.import_batch_id && ids.has(r.import_batch_id)).length;
      if (!dryRun) {
        removeRows(ids);
        for (let i = batches.length - 1; i >= 0; i -= 1) {
          if (ids.has(batches[i].id)) batches.splice(i, 1);
        }
      }
      return { duplicateImports: plan.duplicateImports, failedImports: plan.failedImports, transactionsRemoved };
    },
    async batchTransactionCounts() {
      const counts = new Map<string, number>();
      for (const row of rows) {
        if (!row.import_batch_id) continue;
        counts.set(row.import_batch_id, (counts.get(row.import_batch_id) ?? 0) + 1);
      }
      return counts;
    },
  };
  return { batches, rows, client };
}

const noOrphans = (batches: ImportBatchInfo[], rows: Row[]) =>
  rows.every((r) => r.import_batch_id === null || batches.some((b) => b.id === r.import_batch_id));

describe("planDuplicateCleanup", () => {
  it("keeps the newest completed import per checksum and removes older completed duplicates", () => {
    const plan = planDuplicateCleanup([
      batch("a", { checksum: "x", imported_at: "2026-01-01T00:00:00Z" }),
      batch("b", { checksum: "x", imported_at: "2026-01-03T00:00:00Z" }), // newest -> keep
      batch("c", { checksum: "x", imported_at: "2026-01-02T00:00:00Z" }),
    ]);
    expect(plan.keepIds).toEqual(["b"]);
    expect(new Set(plan.deleteIds)).toEqual(new Set(["a", "c"]));
    expect(plan.duplicateImports).toBe(2);
    expect(plan.failedImports).toBe(0);
  });

  it("removes all failed / cancelled / rolled_back imports regardless of checksum", () => {
    const plan = planDuplicateCleanup([
      batch("ok", { checksum: "u" }),
      batch("f", { status: "failed", checksum: "f1" }),
      batch("c", { status: "cancelled", checksum: "c1" }),
      batch("r", { status: "rolled_back", checksum: "r1" }),
    ]);
    expect(plan.keepIds).toEqual(["ok"]);
    expect(new Set(plan.deleteIds)).toEqual(new Set(["f", "c", "r"]));
    expect(plan.failedImports).toBe(3);
    expect(CLEANUP_REMOVABLE_STATUSES).toContain<ImportBatchStatus>("cancelled");
  });

  it("never dedups imports without a checksum (each is its own group)", () => {
    const plan = planDuplicateCleanup([
      batch("a", { checksum: null }),
      batch("b", { checksum: null }),
    ]);
    expect(plan.deleteIds).toEqual([]);
    expect(plan.duplicateImports).toBe(0);
  });
});

describe("delete import", () => {
  it("deletes a failed import and its transactions, leaving no orphans", async () => {
    const { batches, rows, client } = makeStore(
      [batch("good"), batch("bad", { status: "failed" })],
      [
        { transaction_id: "t1", import_batch_id: "good" },
        { transaction_id: "t2", import_batch_id: "bad" },
        { transaction_id: "t3", import_batch_id: "bad" },
      ],
    );
    const result = await deleteImportBatch("bad", client);
    expect(result.deletedTransactions).toBe(2);
    expect(batches.map((b) => b.id)).toEqual(["good"]);
    expect(rows.map((r) => r.transaction_id)).toEqual(["t1"]); // good import untouched
    expect(noOrphans(batches, rows)).toBe(true);
  });

  it("deletes a completed import and removes the batch row entirely (hard delete)", async () => {
    const { batches, rows, client } = makeStore(
      [batch("a"), batch("b")],
      [
        { transaction_id: "t1", import_batch_id: "a" },
        { transaction_id: "t2", import_batch_id: "b" },
      ],
    );
    await deleteImportBatch("a", client);
    expect(batches.some((b) => b.id === "a")).toBe(false);
    expect(rows.some((r) => r.import_batch_id === "a")).toBe(false);
    expect(noOrphans(batches, rows)).toBe(true);
  });

  it("aborts when deleting a missing batch", async () => {
    const { client } = makeStore([batch("a")], []);
    await expect(deleteImportBatch("missing", client)).rejects.toThrow(/not found/i);
  });

  it("requires a batch id", async () => {
    await expect(deleteImportBatch("", {} as WarehouseManagementClient)).rejects.toThrow(/required/i);
  });
});

describe("rollback import", () => {
  it("removes only this import's transactions and keeps the history row as rolled_back", async () => {
    const { batches, rows, client } = makeStore(
      [batch("first", { imported_at: "2026-01-01T00:00:00Z" }), batch("second", { imported_at: "2026-01-02T00:00:00Z" })],
      [
        { transaction_id: "t1", import_batch_id: "first" },
        { transaction_id: "t2", import_batch_id: "second" },
        { transaction_id: "t3", import_batch_id: "second" },
      ],
    );
    const result = await rollbackImportBatch("second", client);
    expect(result.deletedTransactions).toBe(2);
    expect(batches.find((b) => b.id === "second")?.status).toBe("rolled_back");
    expect(rows.map((r) => r.transaction_id)).toEqual(["t1"]); // older import untouched
    expect(noOrphans(batches, rows)).toBe(true);
  });
});

describe("duplicate cleanup", () => {
  const seed = () =>
    makeStore(
      [
        batch("keep", { checksum: "x", imported_at: "2026-01-03T00:00:00Z" }),
        batch("dup", { checksum: "x", imported_at: "2026-01-01T00:00:00Z" }),
        batch("failed", { status: "failed", checksum: "y" }),
      ],
      [
        { transaction_id: "t1", import_batch_id: "keep" },
        { transaction_id: "t2", import_batch_id: "dup" },
        { transaction_id: "t3", import_batch_id: "failed" },
      ],
    );

  it("previews counts without deleting anything", async () => {
    const { batches, rows, client } = seed();
    const preview = await previewDuplicateCleanup(client);
    expect(preview).toEqual({ duplicateImports: 1, failedImports: 1, transactionsRemoved: 2 });
    expect(batches).toHaveLength(3); // nothing removed in dry run
    expect(rows).toHaveLength(3);
  });

  it("removes duplicate and failed imports plus their transactions", async () => {
    const { batches, rows, client } = seed();
    const result = await cleanupDuplicateImports(client);
    expect(result).toEqual({ duplicateImports: 1, failedImports: 1, transactionsRemoved: 2 });
    expect(batches.map((b) => b.id)).toEqual(["keep"]);
    expect(rows.map((r) => r.transaction_id)).toEqual(["t1"]);
    expect(noOrphans(batches, rows)).toBe(true);
  });
});

describe("transaction counts", () => {
  it("returns live counts keyed by import_batch_id", async () => {
    const { client } = makeStore(
      [batch("a"), batch("b")],
      [
        { transaction_id: "t1", import_batch_id: "a" },
        { transaction_id: "t2", import_batch_id: "a" },
        { transaction_id: "t3", import_batch_id: "b" },
      ],
    );
    const counts = await getImportBatchTransactionCounts(client);
    expect(counts.get("a")).toBe(2);
    expect(counts.get("b")).toBe(1);
  });
});

describe("analytics refresh after management actions", () => {
  it("delete refreshes the analytics store and reports the new transaction count", async () => {
    const { client } = makeStore([batch("a")], [{ transaction_id: "t1", import_batch_id: "a" }]);
    const refresh = vi.fn().mockResolvedValue([{} as never, {} as never]); // 2 remaining transactions
    const { result, transactions } = await deleteImportBatchAndRefresh("a", { client, refresh });
    expect(result.deletedTransactions).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(transactions).toBe(2);
  });

  it("rollback refreshes analytics", async () => {
    const { client } = makeStore([batch("a")], [{ transaction_id: "t1", import_batch_id: "a" }]);
    const refresh = vi.fn().mockResolvedValue([]);
    await rollbackImportBatchAndRefresh("a", { client, refresh });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("cleanup refreshes analytics", async () => {
    const { client } = makeStore(
      [batch("keep", { checksum: "x", imported_at: "2026-01-02T00:00:00Z" }), batch("dup", { checksum: "x", imported_at: "2026-01-01T00:00:00Z" })],
      [{ transaction_id: "t1", import_batch_id: "dup" }],
    );
    const refresh = vi.fn().mockResolvedValue([{} as never]);
    const { result, transactions } = await cleanupDuplicateImportsAndRefresh({ client, refresh });
    expect(result.duplicateImports).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(transactions).toBe(1);
  });
});
