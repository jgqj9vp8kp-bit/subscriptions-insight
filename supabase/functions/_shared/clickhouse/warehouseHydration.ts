// Warehouse row -> analytics Transaction hydration, shared by the browser loader
// (src/services/transactionWarehouse.ts) and server-side summary Edge Functions.
// Both sides MUST map rows identically — this module is that single definition.

import { addCohortFields, backfillTransactionCardTypesFromRawRows, classifyUserTransactions } from "./palmerTransform.ts";
import { declineDetailsForTransaction } from "./paymentFailures.ts";
import type { Transaction } from "./serviceTypes.ts";

export type WarehouseLoadedRecord = {
  source: string | null;
  raw_payload?: Record<string, unknown> | null;
  normalized_payload: Record<string, unknown> | null;
};

export function hydrateWarehouseTransactionsForAnalytics(records: WarehouseLoadedRecord[]): Transaction[] {
  const palmerRows: Transaction[] = [];
  const otherRows: Transaction[] = [];

  for (const record of records) {
    const payload = record.normalized_payload;
    if (!payload || typeof payload !== "object") continue;
    const payloadTx = payload as unknown as Transaction;
    const txWithRaw = {
      ...payloadTx,
      raw: {
        ...(payloadTx.raw ?? {}),
        ...(record.raw_payload ?? {}),
      },
    };
    const enrichedCardTx = backfillTransactionCardTypesFromRawRows(
      [txWithRaw],
      record.raw_payload ? [record.raw_payload] : [],
    )[0];
    const decline = declineDetailsForTransaction(enrichedCardTx);
    const tx = decline
      ? {
          ...enrichedCardTx,
          normalized_decline_reason: decline.reason,
          decline_message: decline.message,
        }
      : enrichedCardTx;
    if (record.source === "palmer_csv") {
      palmerRows.push(tx);
    } else {
      otherRows.push(tx);
    }
  }

  return [
    ...classifyUserTransactions(palmerRows),
    ...addCohortFields(otherRows),
  ].sort((a, b) => (a.event_time < b.event_time ? 1 : a.event_time > b.event_time ? -1 : a.transaction_id.localeCompare(b.transaction_id)));
}
