import type { SubscriptionClean } from "@/types/subscriptions";

const DB_NAME = "subscriptions-insight-cache";
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
): Promise<SubscriptionCacheMetadata> {
  const nextMetadata = buildMetadata(subscriptions, metadata);
  await withStore("readwrite", (store) => store.put({ subscriptions, metadata: nextMetadata }, CACHE_KEY));
  return nextMetadata;
}

export async function loadSubscriptionsFromCache(): Promise<SubscriptionCachePayload | null> {
  const payload = await withStore<SubscriptionCachePayload | undefined>("readonly", (store) => store.get(CACHE_KEY));
  return payload ?? null;
}

export async function clearSubscriptionsCache(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(CACHE_KEY));
}

export async function getSubscriptionsCacheInfo(): Promise<SubscriptionCacheMetadata | null> {
  const payload = await loadSubscriptionsFromCache();
  return payload?.metadata ?? null;
}
