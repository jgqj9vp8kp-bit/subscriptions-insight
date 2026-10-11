// Payment health P0: the warehouse import pairs every transaction with its raw
// CSV row by Primer id, never by array index.
//
// transformPalmerRows re-sorts the transactions (classifyUserTransactions
// sorts newest-first), so output index N is not CSV row N; index pairing gave
// 32 live rows another customer's raw_payload (same event second, 5 s apart at
// most). Fixtures are synthetic.
import { describe, expect, it } from "vitest";
import { transformPalmerRows } from "@/services/palmerTransform";
import { indexRawRowsByTransactionId, prepareWarehouseRecords } from "@/services/transactionWarehouse";
import type { Transaction } from "@/services/types";

function rawRow(id: string, customer: string, eventTime: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    customerId: customer,
    customerEmailAddress: `${customer}@example.com`,
    createdAt: eventTime,
    amount: "2999",
    currency: "USD",
    status: "SETTLED",
    processor: "STRIPE",
    declineReasons: "[]",
    metadata: JSON.stringify({ ff_initiation_type: "cit", ff_country_code: "US" }),
    ...extra,
  };
}

describe("raw-row pairing by transaction id", () => {
  it("same-second rows of different customers each keep their own raw payload after the re-sort", async () => {
    // Three customers, three rows in one second plus an earlier row of the first
    // customer: the classifier output order differs from the CSV order.
    const rawRows = [
      rawRow("tx-a1", "cust-a", "2026-05-01T10:00:00.000Z"),
      rawRow("tx-b1", "cust-b", "2026-05-01T10:00:00.000Z", { status: "DECLINED", processor: "ADYEN" }),
      rawRow("tx-c1", "cust-c", "2026-05-01T10:00:00.000Z"),
      rawRow("tx-a0", "cust-a", "2026-04-01T10:00:00.000Z"),
    ];
    const rows = transformPalmerRows(rawRows);
    expect(rows.map((row) => row.transaction_id)).not.toEqual(rawRows.map((row) => row.id));

    const prepared = await prepareWarehouseRecords({ rows, rawRows, batchId: "batch_1", source: "palmer_csv" });
    expect(prepared.failed).toBe(0);
    expect(prepared.rawRowsUnpaired).toBe(0);
    for (const record of prepared.records) {
      expect(record.raw_payload.id).toBe(record.transaction_id);
      expect(record.raw_payload.customerId).toBe(record.user_id);
      // the row's own status, not a neighbour's
      expect((record.normalized_payload.raw as Record<string, unknown>).status).toBe(record.raw_payload.status);
    }
    expect(prepared.records.find((record) => record.transaction_id === "tx-b1")?.raw_payload.processor).toBe("ADYEN");
    // country_code now comes from metadata.ff_country_code (the CSV has no top-level column)
    expect(prepared.records.every((record) => record.country_code === "US")).toBe(true);
  });

  it("a transaction whose id has no raw row stores its own normalized subset (never the positional row) and is counted", async () => {
    const rawRows = [rawRow("tx-1", "cust-a", "2026-05-01T10:00:00.000Z"), rawRow("tx-2", "cust-b", "2026-05-02T10:00:00.000Z")];
    const rows = transformPalmerRows(rawRows).map((row) =>
      row.transaction_id === "tx-2" ? { ...row, transaction_id: "renamed-elsewhere" } : row,
    ) as Transaction[];
    const prepared = await prepareWarehouseRecords({ rows, rawRows, batchId: "batch_1", source: "palmer_csv" });
    expect(prepared.rawRowsUnpaired).toBe(1);
    expect(prepared.records.find((record) => record.transaction_id === "tx-1")?.raw_payload.id).toBe("tx-1");
    // The unmatched one gets row.raw (as the no-raw-rows path does), never
    // rawRows[index]: a positional fallback would store a neighbour's CSV row
    // and re-break raw_payload->>'id' = transaction_id (migration 202610110001).
    const renamedIndex = rows.findIndex((row) => row.transaction_id === "renamed-elsewhere");
    const renamed = prepared.records.find((record) => record.transaction_id === "renamed-elsewhere");
    expect(renamed?.raw_payload).toEqual(rows[renamedIndex].raw);
    expect(rawRows.some((raw) => raw === renamed?.raw_payload)).toBe(false);
  });

  it("a whitespace-padded id among same-second rows still finds its own raw row (index keys trim like the lookup)", async () => {
    // valueFrom returns the cell verbatim, so the transaction_id carries the
    // padding; the warehouse lookup trims it. Both sides must normalise alike.
    const rawRows = [
      rawRow(" tx-a1", "cust-a", "2026-05-01T10:00:00.000Z"),
      rawRow("tx-b1 ", "cust-b", "2026-05-01T10:00:00.000Z", { status: "DECLINED", processor: "ADYEN" }),
      rawRow("tx-c1", "cust-c", "2026-05-01T10:00:00.000Z"),
    ];
    const rows = transformPalmerRows(rawRows);
    const prepared = await prepareWarehouseRecords({ rows, rawRows, batchId: "batch_1", source: "palmer_csv" });
    expect(prepared.failed).toBe(0);
    expect(prepared.rawRowsUnpaired).toBe(0);
    expect(prepared.records).toHaveLength(3);
    for (const record of prepared.records) {
      expect(String(record.raw_payload.id).trim()).toBe(record.transaction_id);
      expect(record.raw_payload.customerId).toBe(record.user_id);
    }
    expect(prepared.records.find((record) => record.transaction_id === "tx-b1")?.raw_payload.processor).toBe("ADYEN");
  });

  it("clean-template imports opt into positional pairing explicitly (order preserved, never counted)", async () => {
    const rawRows = [{ "Transaction ID": "x", amount: "1" }, { "Transaction ID": "y", amount: "2" }];
    const rows = [
      { ...transformPalmerRows([rawRow("tx-1", "cust-a", "2026-05-01T10:00:00.000Z")])[0], transaction_id: "mapped-1" },
      { ...transformPalmerRows([rawRow("tx-2", "cust-b", "2026-05-02T10:00:00.000Z")])[0], transaction_id: "mapped-2" },
    ] as Transaction[];
    const prepared = await prepareWarehouseRecords({ rows, rawRows, rawRowPairing: "index", batchId: "batch_1", source: "primer_csv" });
    expect(prepared.rawRowsUnpaired).toBe(0);
    expect(prepared.records[0].raw_payload).toBe(rawRows[0]);
    expect(prepared.records[1].raw_payload).toBe(rawRows[1]);
  });

  it("no raw rows at all: nothing is unpaired and row.raw is stored, as before", async () => {
    const rows = transformPalmerRows([rawRow("tx-1", "cust-a", "2026-05-01T10:00:00.000Z")]);
    const prepared = await prepareWarehouseRecords({ rows, batchId: "batch_1", source: "palmer_csv" });
    expect(prepared.rawRowsUnpaired).toBe(0);
    expect(prepared.records[0].raw_payload).toEqual(rows[0].raw);
  });

  it("indexRawRowsByTransactionId uses the id aliases and the palmer-row-N fallback; first duplicate wins", () => {
    const first = { transaction_id: "dup", amount: "1" };
    const byId = indexRawRowsByTransactionId([
      first,
      { "Transaction ID": "aliased", amount: "2" },
      { amount: "3" },
      { transaction_id: "dup", amount: "4" },
    ]);
    expect(byId.get("dup")).toBe(first);
    expect(byId.get("aliased")?.amount).toBe("2");
    expect(byId.get("palmer-row-3")?.amount).toBe("3");
    expect(byId.size).toBe(3);
  });
});
