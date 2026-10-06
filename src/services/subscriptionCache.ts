import type { SubscriptionClean } from "@/types/subscriptions";
import { deleteIndexedDbDatabase, rawCacheStamp, type CacheScopeOptions } from "@/services/analyticsCache";
import { registerPurgeHandler } from "@/services/sessionPurge";
import { traceEvent } from "@/services/performanceTrace";

// Raw FunnelFox subscriptions (customer emails) — data owner only (plan D8).
// Partition-stamped and purged exactly like palmerCache.ts.

export const SUBSCRIPTION_CACHE_DB_NAME = "subscriptions-insight-cache";
const DB_NAME = SUBSCRIPTION_CACHE_DB_NAME;
const DB_VERSION = 1;
const STORE_NAME = "funnelfox-subscriptions";
const CACHE_KEY = "latest";

export interface SubscriptionCacheMetadata {
  saved_at: string;
  count: number;
  source: "funnelfox";
  email_coverage: number;
  last_sync_at: string;
}

export interface SubscriptionCachePayload {
  subscriptions: SubscriptionClean[];
  metadata: SubscriptionCacheMetadata;
  /** Access partition the entry was written under. */
  partition?: string;
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
    request.onerror = () => reject(request.error ?? new Error("Could not open subscription cache."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Subscription cache operation failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Subscription cache transaction failed."));
    };
  });
}

function buildMetadata(subscriptions: SubscriptionClean[], metadata?: Partial<SubscriptionCacheMetadata>): SubscriptionCacheMetadata {
  const count = subscriptions.length;
  const withEmail = subscriptions.filter((sub) => Boolean(sub.email)).length;
  const now = new Date().toISOString();
  return {
    saved_at: now,
    count,
    source: "funnelfox",
    email_coverage: count ? (withEmail / count) * 100 : 0,
    last_sync_at: metadata?.last_sync_at ?? now,
    ...metadata,
  };
}

export async function saveSubscriptionsToCache(
  subscriptions: SubscriptionClean[],
  metadata?: Partial<SubscriptionCacheMetadata>,
  options: CacheScopeOptions = {},
): Promise<SubscriptionCacheMetadata> {
  const nextMetadata = buildMetadata(subscriptions, metadata);
  const partition = rawCacheStamp(options);
  if (!partition) {
    traceEvent("subscriptions.cache_write_skipped", { reason: "no_raw_access" });
    return nextMetadata;
  }
  await withStore("readwrite", (store) =>
    store.put({ subscriptions, metadata: nextMetadata, partition } satisfies SubscriptionCachePayload, CACHE_KEY),
  );
  return nextMetadata;
}

export async function loadSubscriptionsFromCache(options: CacheScopeOptions = {}): Promise<SubscriptionCachePayload | null> {
  const partition = rawCacheStamp(options);
  if (!partition) return null;
  const payload = await withStore<SubscriptionCachePayload | undefined>("readonly", (store) => store.get(CACHE_KEY));
  if (!payload) return null;
  if (payload.partition !== partition) {
    traceEvent("subscriptions.cache_partition_mismatch", {});
    await withStore("readwrite", (store) => store.delete(CACHE_KEY)).catch(() => undefined);
    return null;
  }
  return payload;
}

export async function clearSubscriptionsCache(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(CACHE_KEY));
}

export async function getSubscriptionsCacheInfo(): Promise<SubscriptionCacheMetadata | null> {
  const payload = await loadSubscriptionsFromCache();
  return payload?.metadata ?? null;
}

registerPurgeHandler("subscriptions-indexeddb", () => deleteIndexedDbDatabase(DB_NAME));
