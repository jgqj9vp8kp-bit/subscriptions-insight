// Server-side transaction source for summary Edge Functions, mirroring the client
// store policy: the Supabase transaction warehouse drives analytics when it has rows
// (Dashboard's autoLoadWarehouseIntoStore replaces the store with warehouse data),
// otherwise the palmer cloud snapshot chain is used, exactly like SavedDataAutoLoader
// + setImported (which backfills card types from raw Palmer rows).

import type { SupabaseLikeClient } from "./types.ts";
import type { Transaction } from "./serviceTypes.ts";
import { hydrateWarehouseTransactionsForAnalytics, type WarehouseLoadedRecord } from "./warehouseHydration.ts";
import { backfillTransactionCardTypesFromRawRows, type RawPalmerRow } from "./palmerTransform.ts";
import { normalizePalmerCloudPayload } from "./palmerCloudSnapshot.ts";

export const WAREHOUSE_SELECT_PAGE_SIZE = 1000;

export type ServerTransactionsSourceKind = "transaction_warehouse" | "palmer_snapshot" | "empty";

export interface ServerTransactionsResult {
  transactions: Transaction[];
  /** Raw Palmer rows from the palmer snapshot — the pages pass them to enrichment
   * regardless of which source drives the store, so both are always returned. */
  rawPalmerRows: RawPalmerRow[];
  source: ServerTransactionsSourceKind;
  warehouse_rows: number;
}

/** Mirrors loadWarehouseTransactions: same columns, same deleted_at filter, same
 * ordering, same page size — plus the explicit auth_user_id scope that RLS provides
 * implicitly for the browser client. */
export async function loadServerWarehouseTransactions(
  supabase: SupabaseLikeClient,
  authUserId: string,
  pageSize = WAREHOUSE_SELECT_PAGE_SIZE,
): Promise<Transaction[]> {
  const records: WarehouseLoadedRecord[] = [];
  let pageOffset = 0;
  for (;;) {
    const builder = supabase
      .from("transactions")
      .select("source,raw_payload,normalized_payload")
      .eq("auth_user_id", authUserId)
      .is("deleted_at", null)
      .order("event_time", { ascending: false });
    if (!builder.range) throw new Error("Supabase client does not support paged reads.");
    const { data, error } = await builder.range(pageOffset, pageOffset + pageSize - 1);
    if (error) throw new Error(`Could not load warehouse transactions: ${error.message}`);
    const sourceRows = (data ?? []) as WarehouseLoadedRecord[];
    records.push(...sourceRows.filter((record) => Boolean(record.normalized_payload && typeof record.normalized_payload === "object")));
    if (sourceRows.length < pageSize) break;
    pageOffset += pageSize;
  }
  return hydrateWarehouseTransactionsForAnalytics(records);
}

export async function resolveServerTransactions(input: {
  supabase: SupabaseLikeClient;
  authUserId: string;
  palmerPayload: unknown;
  pageSize?: number;
}): Promise<ServerTransactionsResult> {
  const palmer = normalizePalmerCloudPayload(input.palmerPayload);
  const rawPalmerRows: RawPalmerRow[] = palmer?.rawPalmerRows ?? [];

  const warehouseTxs = await loadServerWarehouseTransactions(input.supabase, input.authUserId, input.pageSize);
  if (warehouseTxs.length > 0) {
    return { transactions: warehouseTxs, rawPalmerRows, source: "transaction_warehouse", warehouse_rows: warehouseTxs.length };
  }

  const snapshotTxs = palmer?.transactions ?? [];
  if (snapshotTxs.length > 0) {
    // setImported applies the raw-row card-type backfill when the store is hydrated.
    return {
      transactions: backfillTransactionCardTypesFromRawRows(snapshotTxs, rawPalmerRows),
      rawPalmerRows,
      source: "palmer_snapshot",
      warehouse_rows: 0,
    };
  }

  return { transactions: [], rawPalmerRows, source: "empty", warehouse_rows: 0 };
}
