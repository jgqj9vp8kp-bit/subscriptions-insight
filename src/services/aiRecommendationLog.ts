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
import { registerPurgeHandler } from "@/services/sessionPurge";
import { aiScopeKey, type AiEngineOutput, type AiScope } from "@/services/aiSignals";

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
  /** The funnel data scope the engine input was served under (plan §23/§25
   * "scopeHash in context_hash"): AI_SCOPE_ALL, or aiAccessScopeKey() of a
   * restricted scope. Omitted ⇒ AI_SCOPE_ALL. Deliberately NOT the cache
   * partition: that also hashes the principal and access_version, so every role
   * edit (or the legacy → bootstrapped switch) would orphan the history. The
   * table is actor-owned (own-row RLS), so principals never share rows anyway. */
  accessScope?: string;
}

/** Funnel scope "all" — what every context hash meant before access control. */
export const AI_SCOPE_ALL = "all";

/** Stable scope component of the context hash: AI_SCOPE_ALL for scope all (and
 * legacy mode / no AccessProvider), else the mode plus the sorted funnel ids.
 * Independent of principal and access_version. */
export function aiAccessScopeKey(
  access: { legacy?: boolean; access?: { funnel_scope?: { mode?: string; funnel_ids?: readonly string[] } | null } | null } | null | undefined,
): string {
  if (!access || access.legacy) return AI_SCOPE_ALL;
  const scope = access.access?.funnel_scope;
  if (scope?.mode === "all") return AI_SCOPE_ALL;
  if (scope?.mode === "selected") {
    const ids = [...(scope.funnel_ids ?? [])].map((id) => id.toLowerCase()).sort();
    return `selected:${fnv(ids.join(","))}`;
  }
  return "none";
}

/** warehouseVersion deliberately NOT hashed: it rides its own column, and the
 * content dedup already ignores a version bump that changed nothing. For funnel
 * scope all the hash is exactly the pre-access-control one, so the data owner's
 * recommendation history (§18 verdict timeline) stays reachable; a restricted
 * scope adds its scope key, so recommendations never cross scopes. */
export function computeAiContextHash(parts: AiContextHashParts): string {
  const scope = parts.accessScope ?? AI_SCOPE_ALL;
  const key: unknown[] = [parts.surface, parts.dateFrom ?? "", parts.dateTo ?? "", parts.contextKey];
  if (scope !== AI_SCOPE_ALL) key.push(scope);
  return `c_${fnv(stableJson(key))}`;
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
/** Bumped by the session purge: a snapshot queued for the previous principal
 * must not be inserted under whoever signs in next (the insert reads the
 * session user at write time). */
let writeGeneration = 0;

export function maybeWriteAiRecommendations(params: {
  contextHash: string;
  warehouseVersion: string | null;
  output: AiEngineOutput;
}): Promise<AiRecommendationWriteResult> {
  const generation = writeGeneration;
  const run = writeChain.then(() => (generation === writeGeneration ? writeSnapshotOnce(params) : ("skipped" as const)));
  writeChain = run.catch(() => undefined);
  return run;
}

registerPurgeHandler("ai-recommendation-log", () => {
  writeGeneration += 1;
  writeChain = Promise.resolve();
});

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

// ---- Recommendation history (brief §18) -------------------------------------

export interface AiActionHistoryPoint {
  /** Snapshot time when this verdict FIRST appeared (consecutive identical
   * verdicts collapse, keeping the earliest date). */
  at: string;
  action: string;
  budgetDeltaPct: number | null;
  ruleId: string;
  confidence: string;
}

function historyScopeOf(value: unknown): AiScope | null {
  const scope = (value as { scope?: { kind?: string } } | null)?.scope;
  if (!scope || (scope.kind !== "cohort" && scope.kind !== "campaign" && scope.kind !== "path")) return null;
  return scope as AiScope;
}

/** The §18 timeline for one scope: "Jul 14 Scale +10% → Jul 17 Scale +20% →
 * Jul 21 Hold". Input snapshots may come newest-first (the reader's order);
 * output is oldest-first CHANGES only. Snapshots where the scope is absent
 * (filters changed what the engine saw) are skipped, not treated as verdicts. */
export function extractAiActionHistory(
  snapshots: ReadonlyArray<{ createdAt: string; recommendations: unknown[] }>,
  scopeKey: string,
  limit = 6,
): AiActionHistoryPoint[] {
  const ordered = [...snapshots].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const points: AiActionHistoryPoint[] = [];
  for (const snapshot of ordered) {
    for (const raw of snapshot.recommendations) {
      const scope = historyScopeOf(raw);
      if (!scope || aiScopeKey(scope) !== scopeKey) continue;
      const rec = raw as { action?: unknown; budgetDeltaPct?: unknown; ruleId?: unknown; confidence?: unknown };
      const point: AiActionHistoryPoint = {
        at: snapshot.createdAt,
        action: String(rec.action ?? ""),
        budgetDeltaPct: typeof rec.budgetDeltaPct === "number" ? rec.budgetDeltaPct : null,
        ruleId: String(rec.ruleId ?? ""),
        confidence: String(rec.confidence ?? ""),
      };
      const last = points[points.length - 1];
      if (!last || last.action !== point.action || last.budgetDeltaPct !== point.budgetDeltaPct) {
        points.push(point);
      }
      break;
    }
  }
  return points.slice(-limit);
}

/** History of the verdict for one scope within one filter context. Reads the
 * append-only snapshots the hooks write; contextHash scoping matters — the
 * same funnel under different filters faces different peers and thresholds,
 * so verdicts across contexts are not comparable. */
export async function loadAiActionHistory(params: {
  surface: "cohort" | "campaign";
  contextHash: string;
  scopeKey: string;
  limit?: number;
}): Promise<AiActionHistoryPoint[]> {
  const snapshots = await listAiRecommendations({
    surface: params.surface,
    contextHash: params.contextHash,
    limit: 20,
  });
  return extractAiActionHistory(snapshots, params.scopeKey, params.limit ?? 6);
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
