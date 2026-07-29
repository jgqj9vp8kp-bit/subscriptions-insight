// One-off (idempotent) repair of legacy normalized_payload rows.
//
// Rows imported before the enrichment landed (March–early-April 2026) carry
// card-type and decline fields ONLY inside raw_payload; hydration recovered them
// at read time, which forced every app start to download raw_payload for all
// rows (~278 MB, 3× the bytes of normalized_payload alone — measured 7.3 MB vs
// 3.2 MB per 1000-row page). This repair replays the SAME per-row hydration
// stage (shared modules — one definition of every formula) and persists its
// output as the new normalized_payload, so the slim startup fetch reproduces
// today's analytics exactly.
//
// Persisted stage = the PRE-classification per-row transaction (merged raw +
// card-type backfill + decline fields). classifyUserTransactions/addCohortFields
// stay read-time: they operate on whole user timelines and always re-run.
// raw_payload is never modified. Running the repair twice changes nothing —
// the enriched payload is a fixed point of the per-row stage.
import { supabase } from "@/services/supabaseClient";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { declineDetailsForTransaction } from "@/services/paymentFailures";
import type { Transaction } from "@/services/types";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export interface RepairSourceRow {
  id: string;
  source: string | null;
  raw_payload: Record<string, unknown> | null;
  normalized_payload: Record<string, unknown> | null;
}

/** The per-row hydration stage, replayed for persistence (see module header).
 *
 * The raw merge is TRANSIENT — used only to extract the card-type and decline
 * fields, exactly as hydration does. The persisted payload keeps the row's
 * original `raw` untouched: embedding the merged raw_payload would copy its
 * bytes into normalized_payload and re-inflate the slim startup fetch, which is
 * the very thing this repair exists to shrink. The live full-vs-slim comparison
 * showed the ONLY analytic differences are card_type / normalized_decline_reason
 * / decline_message, so persisting those three fields closes the gap. */
export function computeEnrichedPayload(row: RepairSourceRow): Record<string, unknown> | null {
  const payload = row.normalized_payload;
  if (!payload || typeof payload !== "object") return null;
  const payloadTx = payload as unknown as Transaction;
  const txWithRaw = {
    ...payloadTx,
    raw: { ...(payloadTx.raw ?? {}), ...(row.raw_payload ?? {}) },
  };
  const enriched = backfillTransactionCardTypesFromRawRows(
    [txWithRaw],
    row.raw_payload ? [row.raw_payload] : [],
  )[0];
  const decline = declineDetailsForTransaction(enriched);
  const tx = decline
    ? { ...enriched, normalized_decline_reason: decline.reason, decline_message: decline.message }
    : enriched;
  const persisted = { ...tx, raw: payloadTx.raw } as unknown as Record<string, unknown>;
  if (payloadTx.raw === undefined) delete persisted.raw;
  return persisted;
}

/** True when persisting the enriched payload would change the stored row. */
export function payloadNeedsRepair(row: RepairSourceRow): boolean {
  const enriched = computeEnrichedPayload(row);
  if (!enriched) return false;
  return JSON.stringify(enriched) !== JSON.stringify(row.normalized_payload);
}

export interface RepairProgress {
  scanned: number;
  total: number;
  repaired: number;
}

export interface RepairSummary {
  scanned: number;
  repaired: number;
  batches: number;
  duration_ms: number;
}

const SCAN_PAGE = 1000;
const PATCH_BATCH = 400;

/** Scan the whole table oldest-first, patch every row whose enriched payload
 * differs. Safe to re-run any time; second run repairs 0 rows. */
export async function repairLegacyNormalizedPayloads(options: {
  onProgress?: (progress: RepairProgress) => void;
} = {}): Promise<RepairSummary> {
  const client = ensureSupabase();
  const startedAt = Date.now();

  const { count } = await client
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null);
  const total = count ?? 0;

  let scanned = 0;
  let repaired = 0;
  let batches = 0;
  let pending: Array<{ id: string; normalized_payload: Record<string, unknown> }> = [];

  const flush = async () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    const { data, error } = await client.rpc("repair_transactions_normalized_payload", {
      patches: batch,
    });
    if (error) throw new Error(`Repair batch failed: ${error.message}`);
    repaired += Number(data ?? 0);
    batches += 1;
  };

  for (let offset = 0; offset < total; offset += SCAN_PAGE) {
    const { data, error } = await client
      .from("transactions")
      .select("id,source,raw_payload,normalized_payload")
      .is("deleted_at", null)
      .order("event_time", { ascending: true })
      .range(offset, offset + SCAN_PAGE - 1);
    if (error) throw new Error(`Repair scan failed: ${error.message}`);
    for (const row of (data ?? []) as RepairSourceRow[]) {
      scanned += 1;
      const enriched = computeEnrichedPayload(row);
      if (!enriched) continue;
      if (JSON.stringify(enriched) === JSON.stringify(row.normalized_payload)) continue;
      pending.push({ id: row.id, normalized_payload: enriched });
      if (pending.length >= PATCH_BATCH) await flush();
    }
    options.onProgress?.({ scanned, total, repaired });
    if (!data || data.length < SCAN_PAGE) break;
  }
  await flush();

  return { scanned, repaired, batches, duration_ms: Date.now() - startedAt };
}
