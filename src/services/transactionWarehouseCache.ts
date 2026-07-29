// IndexedDB cache for the warehouse transactions startup load.
//
// The slim network load still costs ~11 s on a cold start (37k rows, ~120 MB of
// JSON over 39 concurrent pages). Almost none of those rows change between
// visits, so this module keeps the last fetched record set in IndexedDB and on
// the next start pulls only the rows whose `updated_at` moved past the stored
// cursor (imports, repairs, syncs and soft-deletes all bump `updated_at`).
//
// Correctness over speed:
// - The delta query does NOT filter `deleted_at`, so soft-deleted rows come
//   back with a tombstone and are purged from the cache.
// - After the merge the row count is compared against the server's exact count
//   (the auto-load adapter already has it); any mismatch — e.g. a hard delete,
//   which never appears in a delta — falls back to the full network load.
// - A huge delta (bulk re-import) also falls back: the concurrent cold path is
//   faster than paging a mega-delta sequentially.
// - Any IndexedDB or delta failure degrades to the plain network load; the
//   cache can make startup faster, never wronger.
import { supabase } from "@/services/supabaseClient";
import { traceEvent, traceRequest } from "@/services/performanceTrace";
import {
  hydrateWarehouseTransactionsForAnalytics,
  loadWarehouseRecords,
  type WarehouseRecord,
  type WarehouseTransactionsLoadProgress,
} from "@/services/transactionWarehouse";
import type { Transaction } from "@/services/types";

export const WAREHOUSE_CACHE_SCHEMA_VERSION = 1;

/** Above this many changed rows the delta path loses to the concurrent full
 * reload (deltas page sequentially); it also signals a bulk re-import. */
export const WAREHOUSE_CACHE_DELTA_RELOAD_THRESHOLD = 5000;

const DB_NAME = "subscriptions-insight-warehouse-cache";
const DB_VERSION = 1;
const STORE_NAME = "warehouse-transactions";
const CACHE_KEY = "latest";
const DELTA_PAGE_SIZE = 1000;

export interface WarehouseCachePayload {
  schema_version: number;
  auth_user_id: string;
  saved_at: string;
  max_updated_at: string;
  row_count: number;
  records: WarehouseRecord[];
}

/** A delta row: the slim record plus the soft-delete tombstone. */
export interface WarehouseDeltaRow extends WarehouseRecord {
  deleted_at: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Postgres timestamps arrive as ISO strings in a fixed +00:00 offset, so the
 * lexicographic max IS the chronological max. */
export function maxUpdatedAt(records: Array<{ updated_at: string }>): string | null {
  let max: string | null = null;
  for (const record of records) {
    if (typeof record.updated_at !== "string" || !record.updated_at) continue;
    if (max === null || record.updated_at > max) max = record.updated_at;
  }
  return max;
}

export function isWarehouseCachePayloadUsable(payload: unknown, authUserId: string): payload is WarehouseCachePayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as WarehouseCachePayload;
  return (
    p.schema_version === WAREHOUSE_CACHE_SCHEMA_VERSION &&
    p.auth_user_id === authUserId &&
    typeof p.max_updated_at === "string" &&
    p.max_updated_at.length > 0 &&
    Array.isArray(p.records) &&
    p.row_count === p.records.length &&
    p.records.length > 0
  );
}

export interface WarehouseDeltaApplication {
  records: WarehouseRecord[];
  upserts: number;
  deletes: number;
  changed: boolean;
}

/** Merge a delta into the cached record set. Soft-deleted rows and rows whose
 * normalized_payload vanished are removed (the cold loader would not fetch
 * them); everything else is upserted by id. The tombstone field is stripped so
 * cached records keep the exact shape the cold loader produces. */
export function applyWarehouseDelta(records: WarehouseRecord[], delta: WarehouseDeltaRow[]): WarehouseDeltaApplication {
  if (!delta.length) return { records, upserts: 0, deletes: 0, changed: false };
  const byId = new Map<string, WarehouseRecord>();
  for (const record of records) byId.set(record.id, record);
  let upserts = 0;
  let deletes = 0;
  for (const row of delta) {
    const gone = row.deleted_at != null || !row.normalized_payload || typeof row.normalized_payload !== "object";
    if (gone) {
      if (byId.delete(row.id)) deletes += 1;
      continue;
    }
    const existing = byId.get(row.id);
    if (existing && existing.updated_at === row.updated_at) continue; // gte cursor re-reads the boundary row — unchanged
    byId.set(row.id, {
      id: row.id,
      updated_at: row.updated_at,
      source: row.source,
      normalized_payload: row.normalized_payload,
    });
    upserts += 1;
  }
  return { records: [...byId.values()], upserts, deletes, changed: upserts > 0 || deletes > 0 };
}

// ---------------------------------------------------------------------------
// IndexedDB store (mirrors palmerCache.ts)
// ---------------------------------------------------------------------------

export interface WarehouseCacheStore {
  read(): Promise<unknown>;
  write(payload: WarehouseCachePayload): Promise<void>;
  clear(): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open warehouse transactions cache."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Warehouse transactions cache operation failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Warehouse transactions cache transaction failed."));
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error ?? new Error("Warehouse transactions cache transaction aborted."));
    };
  });
}

const idbAvailable = () => typeof indexedDB !== "undefined";

const idbStore: WarehouseCacheStore = {
  async read() {
    if (!idbAvailable()) return null;
    return withStore("readonly", (store) => store.get(CACHE_KEY));
  },
  async write(payload) {
    if (!idbAvailable()) return;
    await withStore("readwrite", (store) => store.put(payload, CACHE_KEY));
  },
  async clear() {
    if (!idbAvailable()) return;
    await withStore("readwrite", (store) => store.delete(CACHE_KEY));
  },
};

export async function clearWarehouseTransactionsCache(): Promise<void> {
  try {
    await idbStore.clear();
  } catch (error) {
    traceEvent("warehouse.cache_clear_failed", { message: error instanceof Error ? error.message : String(error) });
  }
}

// ---------------------------------------------------------------------------
// Network dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export interface WarehouseCacheDeps {
  store: WarehouseCacheStore;
  currentUserId(): Promise<string | null>;
  loadRecords: typeof loadWarehouseRecords;
  countDeltaRows(cursor: string): Promise<number | null>;
  fetchDeltaRows(cursor: string): Promise<WarehouseDeltaRow[]>;
  countServerRows(): Promise<number | null>;
  now(): string;
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

const defaultDeps: WarehouseCacheDeps = {
  store: idbStore,
  async currentUserId() {
    if (!supabase) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.user?.id ?? null;
  },
  loadRecords: loadWarehouseRecords,
  async countDeltaRows(cursor) {
    const client = ensureSupabase();
    // No deleted_at filter: tombstones count as changes too.
    const { count, error } = await client
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .gte("updated_at", cursor);
    if (error) throw new Error(`Could not count warehouse delta: ${error.message}`);
    return count;
  },
  async fetchDeltaRows(cursor) {
    const client = ensureSupabase();
    const rows: WarehouseDeltaRow[] = [];
    let from = 0;
    for (;;) {
      const { data, error } = await traceRequest(
        "supabase.transactions_delta_page",
        `supabase:transactions:delta:${from}`,
        // async+await turns the PostgREST thenable into a real Promise so
        // traceRequest's generic resolves to the response type.
        async () => await client
          .from("transactions")
          .select("id,updated_at,deleted_at,source,normalized_payload")
          .gte("updated_at", cursor)
          .order("updated_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, from + DELTA_PAGE_SIZE - 1),
        { table: "transactions", operation: "delta", page_size: DELTA_PAGE_SIZE },
      );
      if (error) throw new Error(`Could not load warehouse delta: ${error.message}`);
      const page = (data ?? []) as WarehouseDeltaRow[];
      rows.push(...page);
      if (page.length < DELTA_PAGE_SIZE) return rows;
      from += DELTA_PAGE_SIZE;
    }
  },
  async countServerRows() {
    const client = ensureSupabase();
    const { count, error } = await client
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null);
    if (error) throw new Error(`Could not count warehouse transactions: ${error.message}`);
    return count;
  },
  now: () => new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// Cached loader
// ---------------------------------------------------------------------------

export interface CachedWarehouseLoadOptions {
  totalRowsExpected?: number | null;
  onProgress?: (progress: WarehouseTransactionsLoadProgress) => void;
}

function persistInBackground(deps: WarehouseCacheDeps, records: WarehouseRecord[], authUserId: string): void {
  const cursor = maxUpdatedAt(records);
  const complete = records.every((r) => typeof r.id === "string" && r.id && typeof r.updated_at === "string" && r.updated_at);
  if (!cursor || !complete) {
    traceEvent("warehouse.cache_persist_skipped", { rows: records.length, reason: cursor ? "records_missing_identity" : "no_cursor" });
    return;
  }
  const payload: WarehouseCachePayload = {
    schema_version: WAREHOUSE_CACHE_SCHEMA_VERSION,
    auth_user_id: authUserId,
    saved_at: deps.now(),
    max_updated_at: cursor,
    row_count: records.length,
    records,
  };
  deps.store
    .write(payload)
    .then(() => traceEvent("warehouse.cache_saved", { rows: records.length, max_updated_at: cursor }))
    .catch((error) => traceEvent("warehouse.cache_write_failed", { message: error instanceof Error ? error.message : String(error) }));
}

function emitWarmProgress(options: CachedWarehouseLoadOptions, rows: number, deltaRows: number, startedAt: number): void {
  options.onProgress?.({
    total_rows_expected: rows,
    rows_downloaded: deltaRows,
    rows_stored: rows,
    pages_loaded: 1,
    pages_expected: 1,
    current_page: 1,
    has_more: false,
    duration_ms: Date.now() - startedAt,
    source_complete: true,
    stopped_reason: "completed",
    progress_percent: 100,
  });
}

/** Drop-in replacement for `loadWarehouseTransactions` on the auto-load path:
 * warm starts hydrate from IndexedDB + a delta fetch; cold starts (or any
 * cache problem) run the exact same record loader as before and seed the
 * cache in the background. */
export async function loadWarehouseTransactionsCached(
  options: CachedWarehouseLoadOptions = {},
  depsOverride: Partial<WarehouseCacheDeps> = {},
): Promise<Transaction[]> {
  const deps: WarehouseCacheDeps = { ...defaultDeps, ...depsOverride };
  const startedAt = Date.now();

  let authUserId: string | null = null;
  try {
    authUserId = await deps.currentUserId();
  } catch {
    authUserId = null;
  }

  const loadFullAndSeed = async (reason: string): Promise<Transaction[]> => {
    traceEvent("warehouse.cache_full_load", { reason });
    const records = await deps.loadRecords({
      totalRowsExpected: options.totalRowsExpected,
      onProgress: options.onProgress,
    });
    const hydrated = hydrateWarehouseTransactionsForAnalytics(records);
    traceEvent("warehouse.transactions_hydrated", { source_rows: records.length, hydrated_rows: hydrated.length });
    if (authUserId) persistInBackground(deps, records, authUserId);
    return hydrated;
  };

  // Without a session the cache cannot be scoped to a user — do not touch it.
  if (!authUserId) return loadFullAndSeed("no_session");

  let payload: WarehouseCachePayload | null = null;
  try {
    const raw = await deps.store.read();
    payload = isWarehouseCachePayloadUsable(raw, authUserId) ? raw : null;
    if (raw != null && !payload) traceEvent("warehouse.cache_unusable", {});
  } catch (error) {
    traceEvent("warehouse.cache_read_failed", { message: error instanceof Error ? error.message : String(error) });
    payload = null;
  }
  if (!payload) return loadFullAndSeed("cache_miss");

  try {
    const deltaCount = await deps.countDeltaRows(payload.max_updated_at);
    if (deltaCount != null && deltaCount > WAREHOUSE_CACHE_DELTA_RELOAD_THRESHOLD) {
      return await loadFullAndSeed("delta_too_large");
    }

    const delta = await deps.fetchDeltaRows(payload.max_updated_at);
    const applied = applyWarehouseDelta(payload.records, delta);

    // A hard delete never shows up in a delta — the exact server count is the
    // invariant that catches it (and any other drift). The adapter already
    // counted the table, so this is usually free.
    const serverCount = typeof options.totalRowsExpected === "number"
      ? options.totalRowsExpected
      : await deps.countServerRows();
    if (typeof serverCount === "number" && serverCount !== applied.records.length) {
      traceEvent("warehouse.cache_count_mismatch", { server: serverCount, cached: applied.records.length });
      return await loadFullAndSeed("count_mismatch");
    }

    if (applied.changed) persistInBackground(deps, applied.records, authUserId);
    emitWarmProgress(options, applied.records.length, delta.length, startedAt);
    const hydrated = hydrateWarehouseTransactionsForAnalytics(applied.records);
    traceEvent("warehouse.cache_warm_load", {
      rows: applied.records.length,
      delta_rows: delta.length,
      upserts: applied.upserts,
      deletes: applied.deletes,
      duration_ms: Date.now() - startedAt,
    });
    return hydrated;
  } catch (error) {
    traceEvent("warehouse.cache_delta_failed", { message: error instanceof Error ? error.message : String(error) });
    return loadFullAndSeed("delta_failed");
  }
}
