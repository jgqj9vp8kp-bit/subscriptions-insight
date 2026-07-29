// Legacy normalized_payload repair — the enriched payload must be a fixed point
// of the per-row hydration stage, so the slim (no-raw) startup fetch reproduces
// the with-raw hydration exactly.
import { describe, expect, it } from "vitest";
import { computeEnrichedPayload, payloadNeedsRepair, type RepairSourceRow } from "@/services/normalizedPayloadRepair";
import { hydrateWarehouseTransactionsForAnalytics } from "../../supabase/functions/_shared/clickhouse/warehouseHydration.ts";
import type { Transaction } from "@/services/types";

// A March-era shaped row: normalized_payload lacks card_type and decline fields;
// raw_payload carries the card brand and a decline record — exactly the shape
// that made raw_payload load-bearing (1000/1000 card diffs in the oldest slice).
function legacyRow(): RepairSourceRow {
  return {
    id: "row-1",
    source: "palmer_csv",
    raw_payload: {
      // The backfill matches raw rows to transactions by the raw row's own
      // transaction id (FIELD_ALIASES.transaction_id) — align it as real rows do.
      id: "t1",
      "Card Type": "debit",
      status: "DECLINED",
      declineReasons: JSON.stringify([{ payment_method_result_message: "Insufficient funds", status: "DECLINED" }]),
    },
    normalized_payload: {
      transaction_id: "t1",
      user_id: "u1",
      email: "u1@example.com",
      event_time: "2026-03-15T10:00:00Z",
      amount_usd: 0,
      gross_amount_usd: 0,
      net_amount_usd: 0,
      refund_amount_usd: 0,
      is_refunded: false,
      currency: "USD",
      status: "failed",
      transaction_type: "failed_payment",
      funnel: "soulmate",
      campaign_path: "soulmate-1-sp",
      product: "Trial",
      traffic_source: "facebook",
      campaign_id: "c1",
      classification_reason: "test",
      raw: { some_original: true },
    },
  };
}

describe("computeEnrichedPayload", () => {
  it("recovers card_type and decline fields from raw_payload WITHOUT embedding raw", () => {
    const enriched = computeEnrichedPayload(legacyRow()) as unknown as Transaction;
    expect(enriched.card_type).toBe("debit");
    expect(enriched.normalized_decline_reason).toBeTruthy();
    expect(enriched.decline_message).toMatch(/Insufficient funds/);
    // The persisted raw is the ORIGINAL payload raw — merging raw_payload into it
    // would copy its bytes into normalized_payload and re-inflate the slim fetch.
    expect((enriched.raw as Record<string, unknown>).some_original).toBe(true);
    expect((enriched.raw as Record<string, unknown>)["Card Type"]).toBeUndefined();
  });

  it("is a fixed point: repairing a repaired row changes nothing", () => {
    const row = legacyRow();
    const once = computeEnrichedPayload(row)!;
    const repairedRow: RepairSourceRow = { ...row, normalized_payload: once };
    expect(payloadNeedsRepair(row)).toBe(true);
    expect(payloadNeedsRepair(repairedRow)).toBe(false);
    const twice = computeEnrichedPayload(repairedRow)!;
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("slim hydration of the repaired payload equals full hydration of the original row", () => {
    const row = legacyRow();
    const repaired = computeEnrichedPayload(row)!;
    const full = hydrateWarehouseTransactionsForAnalytics([
      { source: row.source, raw_payload: row.raw_payload, normalized_payload: row.normalized_payload },
    ]);
    const slim = hydrateWarehouseTransactionsForAnalytics([
      { source: row.source, normalized_payload: repaired },
    ]);
    // tx.raw itself intentionally differs (full carries the merged raw_payload;
    // slim carries the original payload raw) — nothing downstream reads the raw
    // keys once card/decline are persisted, so parity is over everything else.
    const strip = (txs: Transaction[]) => txs.map(({ raw: _raw, ...rest }) => rest);
    expect(JSON.stringify(strip(slim))).toBe(JSON.stringify(strip(full)));
    expect(slim[0].card_type).toBe(full[0].card_type);
    expect(slim[0].normalized_decline_reason).toBe(full[0].normalized_decline_reason);
    expect(slim[0].decline_message).toBe(full[0].decline_message);
  });

  it("modern rows that already carry the enrichment do not need repair", () => {
    const row = legacyRow();
    const modern: RepairSourceRow = { ...row, normalized_payload: computeEnrichedPayload(row)! };
    expect(payloadNeedsRepair(modern)).toBe(false);
  });

  it("rows without a normalized payload are skipped, never invented", () => {
    expect(computeEnrichedPayload({ id: "x", source: null, raw_payload: { a: 1 }, normalized_payload: null })).toBeNull();
  });
});
