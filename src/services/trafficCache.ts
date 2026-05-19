import type { TrafficMetric } from "@/services/trafficImport";

const DB_NAME = "subscriptions-insight-traffic-cache";
const DB_VERSION = 1;
const STORE_NAME = "facebook-traffic";
const CACHE_KEY = "latest";

export interface TrafficCacheMetadata {
  source: "facebook_traffic";
  google_sheet_url?: string;
  sheet_id?: string;
  gid?: string;
  tab_name?: string;
  imported_at: string;
  rows_count: number;
  matched_rows_count?: number;
  year?: number;
  date_range?: {
    from: string;
    to: string;
  };
}

export interface TrafficCachePayload {
  trafficMetrics: TrafficMetric[];
  metadata: TrafficCacheMetadata;
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
    request.onerror = () => reject(request.error ?? new Error("Could not open traffic data cache."));
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = run(tx.objectStore(STORE_NAME));

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Traffic cache operation failed."));
    tx.oncomplete = () => db.close();
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Traffic cache transaction failed."));
    };
  });
}

function dateRange(rows: TrafficMetric[]): TrafficCacheMetadata["date_range"] | undefined {
  const dates = rows.map((row) => row.date).filter(Boolean).sort();
  if (!dates.length) return undefined;
  return { from: dates[0], to: dates[dates.length - 1] };
}

function buildMetadata(
  trafficMetrics: TrafficMetric[],
  metadata: Partial<TrafficCacheMetadata> = {},
): TrafficCacheMetadata {
  return {
    source: "facebook_traffic",
    imported_at: metadata.imported_at ?? new Date().toISOString(),
    rows_count: metadata.rows_count ?? trafficMetrics.length,
    google_sheet_url: metadata.google_sheet_url,
    sheet_id: metadata.sheet_id,
    gid: metadata.gid,
    tab_name: metadata.tab_name,
    matched_rows_count: metadata.matched_rows_count,
    year: metadata.year,
    date_range: metadata.date_range ?? dateRange(trafficMetrics),
  };
}

export async function saveTrafficDataToCache(
  trafficMetrics: TrafficMetric[],
  metadata: Partial<TrafficCacheMetadata> = {},
): Promise<TrafficCacheMetadata> {
  const nextMetadata = buildMetadata(trafficMetrics, metadata);
  await withStore("readwrite", (store) =>
    store.put({ trafficMetrics, metadata: nextMetadata } satisfies TrafficCachePayload, CACHE_KEY),
  );
  return nextMetadata;
}

export async function loadLastTrafficDataFromCache(): Promise<TrafficCachePayload | null> {
  const payload = await withStore<TrafficCachePayload | undefined>("readonly", (store) => store.get(CACHE_KEY));
  return payload ?? null;
}

export async function clearTrafficDataCache(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(CACHE_KEY));
}

export async function getTrafficCacheInfo(): Promise<TrafficCacheMetadata | null> {
  const payload = await loadLastTrafficDataFromCache();
  return payload?.metadata ?? null;
}
