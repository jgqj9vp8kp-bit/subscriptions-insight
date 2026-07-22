// facebook_known_gaps: windows a human has declared unrecoverable from the source
// (Warehouse V2 Phase 2). Reconciliation treats a recorded gap as an EXPLAINED
// hole, never an unknown one. Append-only: rows are decisions with evidence —
// the table's trigger rejects UPDATE/DELETE for every role.

import { supabase } from "@/services/supabaseClient";
import type { FbSourceProbeResult } from "@/services/fbWarehouse";

export interface FacebookKnownGap {
  gap_id: string;
  gap_from: string;
  gap_to: string;
  level: string;
  reason: string;
  evidence: Record<string, unknown>;
  decided_by: string | null;
  decided_at: string;
}

/** Record a window as a known gap, attaching the probe result as evidence.
 * Call ONLY after a source probe returned verdict="empty" — a recoverable
 * window must be backfilled, not explained away. */
export async function recordFacebookKnownGap(input: {
  probe: Pick<FbSourceProbeResult, "date_from" | "date_to" | "verdict" | "rows_found" | "api_requests" | "fb_stats_to" | "api_last_import_at">;
  level?: string;
  reason?: string;
  decidedBy?: string;
}): Promise<FacebookKnownGap> {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (input.probe.verdict !== "empty") {
    throw new Error("Refusing to record a known gap: the source probe found data — backfill the window instead.");
  }
  const { data, error } = await supabase
    .from("facebook_known_gaps")
    .insert({
      gap_from: input.probe.date_from,
      gap_to: input.probe.date_to,
      level: input.level ?? "campaign",
      reason: input.reason ?? "Source probe returned no rows for the window.",
      evidence: {
        source: "clickhouse-facebook source_probe",
        probe: input.probe,
        recorded_from: "ui",
      },
      decided_by: input.decidedBy ?? null,
    })
    .select("gap_id,gap_from,gap_to,level,reason,evidence,decided_by,decided_at")
    .single();
  if (error) throw new Error(`Could not record the known gap: ${error.message}`);
  return data as FacebookKnownGap;
}

export async function listFacebookKnownGaps(): Promise<FacebookKnownGap[]> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase
    .from("facebook_known_gaps")
    .select("gap_id,gap_from,gap_to,level,reason,evidence,decided_by,decided_at")
    .order("gap_from", { ascending: true });
  if (error) throw new Error(`Could not load known gaps: ${error.message}`);
  return (data ?? []) as FacebookKnownGap[];
}
