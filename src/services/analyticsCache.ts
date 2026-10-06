// Shared analytics query-cache primitives, reused by Cohorts, Users, and Payment
// Pass Analytics: the cache partition, the hashed warehouse-version fingerprint,
// the warehouse-dependent query roots, and array normalization.
//
// Cache isolation (plan §20): the "userScopeHash" slot of every query key now
// carries the server-issued ACCESS PARTITION (useAccess().partition, an HMAC of
// workspace | principal | access version | scope; legacy ⇒ "legacy:" + user id),
// so an entry fetched under one principal, role or funnel scope can never be
// served under another. The hooks resolve it themselves (useCacheScope).
//
// No cursor ids ever appear in a key or persisted storage — only hashes.

import type { ClickHouseSummary } from "@/services/clickhouse";

// v3: CohortRow grew renewal_3_to_renewal_4_cr / 4→5 / 5→6.
// v4: CohortRow grew the FB Analytics block (fb_spend…fb_match_status).
// v5: FB Cohorts moved to the authoritative user → unique campaign/date
// architecture and added spend reconciliation diagnostics; discard v4 bundles
// so incorrect/stale row spend can never survive the rollout.
// v6: shared campaign/date rows and unverified timezone joins now carry null
// metrics; diagnostics split authoritative-unmatched from unrelated FB spend.
// v7: FB Cohorts uses Campaign CPP assigned per authoritative user at the Meta
// reporting date; discard every row-spend cache from the previous architecture.
// v8: authenticated allocation diagnostics add full-scope summary, filters and
// pagination; discard v7 Cohorts bundles that only contained a sliced row list.
// v9: Cohorts adds source-scoped FB reconciliation. Discard v8 bundles so the
// UI never renders missing source counts or the former all-user coverage label.
// v10: Cohorts filter options add the utm_source list (UTM entries of the Media
// Buyer dropdown). Discard v9 bundles so selection pruning never runs against a
// response that predates the list and silently drops a "utm:<value>" selection.
// v11: monetization rollout (Dashboard Token/Add-on KPI + token daily series,
// item 3 email-matched token revenue in cohort gross/net/revenue_dN). Discard
// v10 bundles: their KPI arrays lack the token entries (the card renders "—")
// and their cohort revenue predates the item 3 definition.
// v12: Cohorts active-subscription overlay — the server now joins FunnelFox
// subscriptions to the cohort snapshot and fills active_users /
// active_subscriptions. Discard v11 bundles whose rows carry the old hardcoded
// 0, so the Active Subscriptions column stops showing a stale 0.
// v13: exclude FunnelFox sandbox/test-mode subscriptions from the active-
// subscription overlay (a reused QA email carried dozens of sandbox subs, so a
// cohort showed more Active Subscriptions than trials), and carry the per-cohort
// subscription/user id arrays so the total row dedups instead of showing 0.
// Discard v12 bundles whose rows carry the inflated counts and empty id arrays.
// v14: two option lists gained a dimension — Cohorts filter_options.platform and
// Users filter_options.cohort. Both are keyed by scopes that do not include the
// new field, so a v13 bundle would keep serving a response that simply lacks it:
// an empty Platform dropdown and an empty Users cohort explorer, with no refetch
// to correct them. Discard v13 bundles so both lists populate on first load.
// v15 (2026-09): the Dashboard Revenue Intelligence root ("revenue") joins the
// warehouse-dependent set; older persisted caches know nothing about it.
// v16 (2026-10, access control): keys carry the access partition instead of the
// FNV user hash, the persisted envelope is stored per partition and no longer
// holds Users rows / Support messages. Discard every v15 envelope.
export const ANALYTICS_CACHE_SCHEMA_VERSION = 16;

// Prefixes: the hooks append the access partition (warehouseVersionKey), and
// invalidation / persistence match on these two leading segments.
export const WAREHOUSE_VERSION_KEY = ["clickhouse", "warehouse-version"] as const;
export const SUPPORT_WAREHOUSE_VERSION_KEY = ["clickhouse", "support-warehouse-version"] as const;
export const WAREHOUSE_ANALYTICS_INVALIDATED_EVENT = "warehouse-analytics-invalidated";

/** A version-key prefix scoped to one access partition. Without a partition
 * (no AccessProvider, e.g. unit tests) the bare prefix is the key, as before. */
export function partitionedVersionKey(prefix: readonly string[], partition?: string | null): string[] {
  return partition ? [...prefix, partition] : [...prefix];
}

export function warehouseVersionKey(partition?: string | null): string[] {
  return partitionedVersionKey(WAREHOUSE_VERSION_KEY, partition);
}

// Analytics query roots that depend on warehouse transaction data. Invalidated
// together after a successful CSV import + ClickHouse auto-sync, and persisted by
// the shared persistence layer. fb-analytics rides the same lifecycle (persist,
// logout clear, external invalidation) — its own re-keying comes from the FB
// warehouse version, so a transaction-sync invalidation is just a cheap refetch.
export const WAREHOUSE_DEPENDENT_ROOTS: readonly string[] = ["cohorts", "users", "payment-analytics", "support", "fb-analytics", "revenue"];

export function fnv(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** @deprecated A 32-bit hash of the user id is not a cache partition: it ignores
 * role and funnel scope. Inside the app the hooks key on useAccess().partition;
 * this stays only for callers not yet migrated (and their tests). */
export function hashUserScope(userId: string | null | undefined): string {
  const input = (userId ?? "anonymous").trim() || "anonymous";
  return `u_${fnv(input)}`;
}

// ---- Browser cache access (IndexedDB raw datasets) -------------------------
// The raw-dataset caches (Palmer, FunnelFox subscriptions, FB traffic, the
// transaction warehouse) are data-owner only (plan D8) and are read and written
// through plain service functions that many callers use without any React
// context. AnalyticsCacheGate publishes the resolved access here (during render,
// before any route child renders); until then — and for anyone without raw
// access — the caches neither read nor write.

export interface CacheAccess {
  /** Server-issued access partition; "" while access is unresolved or grants nothing. */
  partition: string;
  rawAccess: boolean;
}

const NO_CACHE_ACCESS: CacheAccess = Object.freeze({ partition: "", rawAccess: false });
let activeCacheAccess: CacheAccess = NO_CACHE_ACCESS;

export function setActiveCacheAccess(next: CacheAccess | null): void {
  const partition = next?.partition ?? "";
  const rawAccess = Boolean(partition) && next?.rawAccess === true;
  if (activeCacheAccess.partition === partition && activeCacheAccess.rawAccess === rawAccess) return;
  activeCacheAccess = partition ? { partition, rawAccess } : NO_CACHE_ACCESS;
}

export function getActiveCacheAccess(): CacheAccess {
  return activeCacheAccess;
}

export interface CacheScopeOptions {
  /** The partition the caller loaded its data under. A mismatch with the active
   * partition (the access changed meanwhile) turns the call into a no-op. */
  partition?: string;
}

/** The stamp a raw-dataset cache entry must carry right now, or null when the
 * cache must not be touched at all (no raw access, unresolved access, or the
 * caller's partition is no longer the active one). */
export function rawCacheStamp(options: CacheScopeOptions = {}): string | null {
  const { partition, rawAccess } = activeCacheAccess;
  if (!rawAccess || !partition) return null;
  if (options.partition !== undefined && options.partition !== partition) return null;
  return partition;
}

/** Deletes a whole IndexedDB database (session purge). Resolves once deleted;
 * a "blocked" delete completes when the last connection closes, and the purge
 * registry bounds the wait. No-op where IndexedDB does not exist. */
export function deleteIndexedDbDatabase(name: string): Promise<void> {
  if (typeof indexedDB === "undefined") return Promise.resolve();
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.deleteDatabase(name);
    } catch (error) {
      reject(error);
      return;
    }
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error(`Could not delete IndexedDB database ${name}.`));
  });
}

// Deterministic array normalization: dedupe + trim + sort, so two logically
// identical filter sets produce byte-identical keys.
export function sortUniq(v: readonly string[] | undefined | null): string[] {
  return Array.from(new Set((v ?? []).map((x) => String(x).trim()).filter(Boolean))).sort();
}

// A stable, HASHED fingerprint of the warehouse state that changes after a
// successful sync (new cursor / row count). No raw cursor id is exposed.
export function warehouseVersionFromSummary(summary: ClickHouseSummary | null | undefined): string {
  const st = summary?.sync_state;
  const cohortSnapshot = summary?.cohort_snapshot_state;
  const cursorId = st?.cursor_transaction_id ?? "";
  const cursorAt = st?.cursor_updated_at ?? "";
  const total = st?.clickhouse_total ?? summary?.transaction_count ?? "";
  const snapshotVersion = [
    cohortSnapshot?.status ?? "",
    cohortSnapshot?.active_warehouse_version ?? "",
    cohortSnapshot?.active_classification_version ?? "",
    cohortSnapshot?.active_generated_at ?? "",
    cohortSnapshot?.users_classified ?? "",
  ].join(":");
  if (!cursorId && !cursorAt && total === "" && !snapshotVersion.replace(/:/g, "")) return "whv_unknown";
  return `whv_${fnv(`${cursorId}:${cursorAt}:${total}:${snapshotVersion}`)}`;
}

export function supportWarehouseVersionFromSummary(summary: ClickHouseSummary | null | undefined): string {
  const supportSync = summary?.support_sync_state;
  const cohortSnapshot = summary?.cohort_snapshot_state;
  const supportAttribution = supportSync?.diagnostics?.attribution;
  const attribution = supportAttribution && typeof supportAttribution === "object"
    ? supportAttribution as Record<string, unknown>
    : {};
  const value = [
    supportSync?.cursor_transaction_id ?? "",
    supportSync?.cursor_updated_at ?? "",
    supportSync?.clickhouse_total ?? "",
    supportSync?.status ?? "",
    attribution.attribution_version ?? "",
    attribution.funnel_matched ?? "",
    attribution.unknown ?? "",
    cohortSnapshot?.active_warehouse_version ?? "",
    cohortSnapshot?.active_classification_version ?? "",
    cohortSnapshot?.active_generated_at ?? "",
  ].join(":");
  return value.replace(/:/g, "") ? `swhv_${fnv(value)}` : "swhv_unknown";
}

export function warehouseVersionFromSync(sync: { cursor_transaction_id?: string | null; clickhouse_total?: number | null } | null | undefined): string {
  if (!sync || (!sync.cursor_transaction_id && sync.clickhouse_total == null)) return "whv_unknown";
  return `whv_${fnv(`${sync.cursor_transaction_id ?? ""}::${sync.clickhouse_total ?? ""}`)}`;
}
