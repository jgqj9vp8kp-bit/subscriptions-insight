import { computeCohorts, computeUsers } from "@/services/analytics";
import type { CohortRow, Transaction, UserAggregate } from "@/services/types";
import type { RawPalmerRow } from "@/services/palmerTransform";
import { deleteIndexedDbDatabase, rawCacheStamp, type CacheScopeOptions } from "@/services/analyticsCache";
import { registerPurgeHandler } from "@/services/sessionPurge";
import { traceEvent } from "@/services/performanceTrace";

// Raw Palmer dataset (transactions + customer rows) — data owner only (plan D8).
// Entries are stamped with the access partition they were written under: a
// read under any other partition deletes the entry instead of returning it, and
// nothing is read or written without raw access (see rawCacheStamp). The whole
// database is deleted by the session purge.

export const PALMER_CACHE_DB_NAME = "subscriptions-insight-palmer-cache";
const DB_NAME = PALMER_CACHE_DB_NAME;
const DB_VERSION = 1;
const STORE_NAME = "palmer-datasets";
const CACHE_KEY = "latest";

export interface PalmerCacheMetadata {
  file_name: string;
  imported_at: string;
  rows_count: number;
  transactions_count: number;
  cohorts_count: number;
  users_count: number;
  source: "palmer_import";
}

export interface PalmerDatasetCachePayload {
  transactions: Transaction[];
  users: UserAggregate[];
  cohorts: CohortRow[];
  rawPalmerRows?: RawPalmerRow[];
  metadata: PalmerCacheMetadata;
  /** Access partition the entry was written under. */
  partition?: string;
}

export interface PalmerDatasetCacheInput {
  transactions: Transaction[];
  users?: UserAggregate[];
  cohorts?: CohortRow[];
  rawPalmerRows?: RawPalmerRow[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open Palmer dataset cache."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Palmer dataset cache operation failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Palmer dataset cache transaction failed."));
    };
  });
}

function buildMetadata(data: PalmerDatasetCacheInput, metadata: Partial<PalmerCacheMetadata> = {}): PalmerCacheMetadata {
  const transactions = data.transactions;
  const users = data.users ?? computeUsers(transactions);
  const cohorts = data.cohorts ?? computeCohorts(transactions);
  const importedAt = metadata.imported_at ?? new Date().toISOString();

  return {
    file_name: metadata.file_name ?? "Palmer import",
    imported_at: importedAt,
    rows_count: metadata.rows_count ?? data.rawPalmerRows?.length ?? transactions.length,
    transactions_count: metadata.transactions_count ?? transactions.length,
    cohorts_count: metadata.cohorts_count ?? cohorts.length,
    users_count: metadata.users_count ?? users.length,
    source: "palmer_import",
  };
}

export async function savePalmerDatasetToCache(
  data: PalmerDatasetCacheInput,
  metadata: Partial<PalmerCacheMetadata> = {},
  options: CacheScopeOptions = {},
): Promise<PalmerCacheMetadata> {
  const users = data.users ?? computeUsers(data.transactions);
  const cohorts = data.cohorts ?? computeCohorts(data.transactions);
  const nextMetadata = buildMetadata({ ...data, users, cohorts }, metadata);
  const partition = rawCacheStamp(options);
  if (!partition) {
    traceEvent("palmer.cache_write_skipped", { reason: "no_raw_access" });
    return nextMetadata;
  }
  await withStore("readwrite", (store) =>
    store.put(
      {
        transactions: data.transactions,
        users,
        cohorts,
        rawPalmerRows: data.rawPalmerRows,
        metadata: nextMetadata,
        partition,
      } satisfies PalmerDatasetCachePayload,
      CACHE_KEY,
    ),
  );
  return nextMetadata;
}

export async function loadLastPalmerDatasetFromCache(options: CacheScopeOptions = {}): Promise<PalmerDatasetCachePayload | null> {
  const partition = rawCacheStamp(options);
  if (!partition) return null;
  const payload = await withStore<PalmerDatasetCachePayload | undefined>("readonly", (store) => store.get(CACHE_KEY));
  if (!payload) return null;
  if (payload.partition !== partition) {
    traceEvent("palmer.cache_partition_mismatch", {});
    await withStore("readwrite", (store) => store.delete(CACHE_KEY)).catch(() => undefined);
    return null;
  }
  return payload;
}

export async function clearPalmerDatasetCache(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(CACHE_KEY));
}

export async function getPalmerCacheInfo(): Promise<PalmerCacheMetadata | null> {
  const payload = await loadLastPalmerDatasetFromCache();
  return payload?.metadata ?? null;
}

registerPurgeHandler("palmer-indexeddb", () => deleteIndexedDbDatabase(DB_NAME));
