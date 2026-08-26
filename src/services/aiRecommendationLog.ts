// Append-only history of engine output per (surface, context): the writer half
// of ai_recommendations (202608200001). Client-side by design — the engine runs
// in the browser over rows the page already shows, so the browser is the only
// place the finished output exists.
//
// Discipline:
//  - best-effort: a failed write never surfaces to the page (chips/panels are
//    complete without history);
//  - dedup by content: a snapshot is inserted only when the recommendations
//    differ from the LAST stored row for the same (surface, context_hash) —
//    jsonb does not preserve key order, so the comparison canonicalizes both
//    sides instead of trusting raw JSON.stringify;
//  - auth_user_id is EXPLICIT: the column has no default (report_versions
//    precedent — a cascading default would fight the append-only guard).
import { supabase } from "@/services/supabaseClient";
import { fnv } from "@/services/analyticsCache";
import type { AiEngineOutput } from "@/services/aiSignals";

/** JSON with recursively sorted object keys — stable across the Postgres jsonb
 * round-trip, which normalizes key order. */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const body = keys
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`);
  return `{${body.join(",")}}`;
}

export interface AiContextHashParts {
  surface: "cohort" | "campaign";
  dateFrom: string | null;
  dateTo: string | null;
  /** Page-owned stable serialization of the applied filters (view mode and
   * other presentation state excluded — they don't change the engine input). */
  contextKey: string;
}

/** warehouseVersion deliberately NOT hashed: it rides its own column, and the
 * content dedup already ignores a version bump that changed nothing. */
export function computeAiContextHash(parts: AiContextHashParts): string {
  return `c_${fnv(stableJson([parts.surface, parts.dateFrom ?? "", parts.dateTo ?? "", parts.contextKey]))}`;
}

export function aiRecommendationsUnchanged(stored: unknown, current: AiEngineOutput["recommendations"]): boolean {
  return stableJson(stored ?? []) === stableJson(current);
}

export type AiRecommendationWriteResult = "written" | "unchanged" | "skipped";

/** How many recent snapshots the dedup compares against. More than 1 because a
 * cold page load emits the engine output in settling steps (e.g. maturity
 * "missing" until funnel passports arrive, then the full variant) — comparing
 * only the latest row would re-insert that A→B oscillation on every load. */
const DEDUP_LOOKBACK = 3;

/** Writes are serialized per tab: two settling steps can debounce-fire within
 * a second of each other, and concurrent read-then-insert sequences would both
 * read an empty history and both insert (observed live). The table is
 * append-only, so a raced duplicate cannot even be cleaned up afterwards. */
let writeChain: Promise<unknown> = Promise.resolve();

export function maybeWriteAiRecommendations(params: {
  contextHash: string;
  warehouseVersion: string | null;
  output: AiEngineOutput;
}): Promise<AiRecommendationWriteResult> {
  const run = writeChain.then(() => writeSnapshotOnce(params));
  writeChain = run.catch(() => undefined);
  return run;
}

async function writeSnapshotOnce(params: {
  contextHash: string;
  warehouseVersion: string | null;
  output: AiEngineOutput;
}): Promise<AiRecommendationWriteResult> {
  const { contextHash, warehouseVersion, output } = params;
  if (!supabase) return "skipped";
  if (output.recommendations.length === 0) return "skipped";
  // Path recommendations travel under surface='cohort' (the table CHECK knows
  // only cohort/campaign; the grain lives in scope.kind inside the jsonb).
  const surface = output.recommendations[0].surface;
  try {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) return "skipped";

    const { data: lastRows, error: readError } = await supabase
      .from("ai_recommendations")
      .select("recommendations")
      .eq("auth_user_id", userId)
      .eq("surface", surface)
      .eq("context_hash", contextHash)
      .order("created_at", { ascending: false })
      .limit(DEDUP_LOOKBACK);
    // An unreadable history must not turn into an insert storm.
    if (readError) return "skipped";
    const recent = (lastRows ?? []) as Array<{ recommendations?: unknown }>;
    if (recent.some((row) => aiRecommendationsUnchanged(row.recommendations, output.recommendations))) return "unchanged";

    const { error } = await supabase.from("ai_recommendations").insert({
      auth_user_id: userId,
      surface,
      context_hash: contextHash,
      engine_version: output.engineVersion,
      warehouse_version: warehouseVersion,
      thresholds: output.thresholds,
      recommendations: output.recommendations,
      opportunities: output.opportunities,
      input_status: output.inputStatus,
    });
    return error ? "skipped" : "written";
  } catch {
    return "skipped";
  }
}

export interface AiRecommendationSnapshot {
  id: string;
  surface: string;
  contextHash: string;
  engineVersion: string;
  warehouseVersion: string | null;
  thresholds: Record<string, unknown>;
  recommendations: unknown[];
  opportunities: unknown[];
  inputStatus: Record<string, string>;
  createdAt: string;
}

export async function listAiRecommendations(params: {
  surface: "cohort" | "campaign";
  contextHash?: string;
  limit?: number;
}): Promise<AiRecommendationSnapshot[]> {
  if (!supabase) throw new Error("Supabase is not configured.");
  let query = supabase
    .from("ai_recommendations")
    .select("id,surface,context_hash,engine_version,warehouse_version,thresholds,recommendations,opportunities,input_status,created_at")
    .eq("surface", params.surface)
    .order("created_at", { ascending: false })
    .limit(params.limit ?? 20);
  if (params.contextHash) query = query.eq("context_hash", params.contextHash);
  const { data, error } = await query;
  if (error) throw new Error(`Could not list AI recommendation history: ${error.message}`);

  // Cast through unknown: PostgREST widens a runtime column list to its
  // parse-error union.
  return ((data ?? []) as unknown as Array<{
    id: string; surface: string; context_hash: string; engine_version: string;
    warehouse_version: string | null; thresholds: Record<string, unknown>;
    recommendations: unknown[]; opportunities: unknown[];
    input_status: Record<string, string>; created_at: string;
  }>).map((row) => ({
    id: row.id,
    surface: row.surface,
    contextHash: row.context_hash,
    engineVersion: row.engine_version,
    warehouseVersion: row.warehouse_version,
    thresholds: row.thresholds ?? {},
    recommendations: row.recommendations ?? [],
    opportunities: row.opportunities ?? [],
    inputStatus: row.input_status ?? {},
    createdAt: row.created_at,
  }));
}
