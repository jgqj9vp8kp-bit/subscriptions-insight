// Persist the warehouse-backed analytics slice of the TanStack Query cache
// (Cohorts, Users, Payment Pass Analytics) to sessionStorage so it survives a
// page reload in the same browser session. This is NOT a second cache system — it
// dehydrates/rehydrates the SAME QueryClient using the library's own
// dehydrate()/hydrate(). Only aggregate responses (+ the tiny warehouse-version
// entry) are persisted; never tokens, emails, raw ids, or transactions.

import { dehydrate, hydrate, type QueryClient, type Query } from "@tanstack/react-query";
import { ANALYTICS_CACHE_SCHEMA_VERSION, WAREHOUSE_DEPENDENT_ROOTS, WAREHOUSE_VERSION_KEY } from "@/services/analyticsCache";
import { traceEvent, traceMark, traceMeasure } from "@/services/performanceTrace";

export const ANALYTICS_PERSIST_KEY = "analytics.qcache.v1";
const MAX_AGE_MS = 60 * 60 * 1000; // 60 min — matches gcTime
const MAX_QUERIES = 16; // bound the number of cached responses kept
const MAX_BYTES = 3_500_000; // stay well under the ~5MB sessionStorage ceiling

interface Envelope {
  schemaVersion: number;
  userScopeHash: string;
  savedAt: number;
  state: ReturnType<typeof dehydrate>;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    return null;
  }
}

function isPersistableRoot(key: unknown[]): boolean {
  if (key[0] === WAREHOUSE_VERSION_KEY[0] && key[1] === WAREHOUSE_VERSION_KEY[1]) return true;
  return typeof key[0] === "string" && WAREHOUSE_DEPENDENT_ROOTS.includes(key[0]);
}

function isWarehouseVersionKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === WAREHOUSE_VERSION_KEY[0] && key[1] === WAREHOUSE_VERSION_KEY[1];
}

// Which queries are safe + worth persisting: successful Cohorts / Users / Payment
// Analytics entries and the warehouse-version entry. Everything else is skipped.
export function shouldPersistAnalyticsQuery(query: Pick<Query, "queryKey" | "state">): boolean {
  if (!isPersistableRoot(query.queryKey as unknown[])) return false;
  return query.state.status === "success" && query.state.data != null;
}

export function persistAnalyticsCache(client: QueryClient, userScopeHash: string, now: number = Date.now()): void {
  const ss = safeSessionStorage();
  if (!ss) return;
  traceMark("analytics_cache.persist_started");
  const state = dehydrate(client, { shouldDehydrateQuery: shouldPersistAnalyticsQuery, shouldDehydrateMutation: () => false });

  const versionQueries = state.queries
    .filter((query) => isWarehouseVersionKey(query.queryKey))
    .sort((a, b) => (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0));
  const aggregateQueries = state.queries
    .filter((query) => !isWarehouseVersionKey(query.queryKey))
    .sort((a, b) => (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0));
  state.queries = [...versionQueries, ...aggregateQueries].slice(0, MAX_QUERIES);

  const envelope: Envelope = { schemaVersion: ANALYTICS_CACHE_SCHEMA_VERSION, userScopeHash, savedAt: now, state };
  let serialized = JSON.stringify(envelope);
  while (serialized.length > MAX_BYTES && envelope.state.queries.length > 0) {
    envelope.state.queries = envelope.state.queries.slice(0, -1);
    serialized = JSON.stringify(envelope);
  }
  try {
    ss.setItem(ANALYTICS_PERSIST_KEY, serialized);
    traceMark("analytics_cache.persist_completed", { query_count: envelope.state.queries.length, bytes: serialized.length });
    traceMeasure("analytics_cache.persist_duration", "analytics_cache.persist_started", "analytics_cache.persist_completed", { query_count: envelope.state.queries.length, bytes: serialized.length });
  } catch {
    try { ss.removeItem(ANALYTICS_PERSIST_KEY); } catch { /* ignore */ }
    traceEvent("analytics_cache.persist_failed", { query_count: envelope.state.queries.length, bytes: serialized.length });
  }
}

// Restore a previously-persisted slice, but ONLY when the schema version and user
// scope match and it has not expired. Otherwise discard (safe cleanup of
// incompatible / foreign / stale data).
export function restoreAnalyticsCache(client: QueryClient, userScopeHash: string, now: number = Date.now()): boolean {
  const ss = safeSessionStorage();
  if (!ss) return false;
  traceMark("analytics_cache.restore_started");
  const raw = ss.getItem(ANALYTICS_PERSIST_KEY);
  if (!raw) {
    traceMark("analytics_cache.restore_completed", { restored: false, reason: "empty" });
    traceMeasure("analytics_cache.restore_duration", "analytics_cache.restore_started", "analytics_cache.restore_completed", { restored: false });
    return false;
  }
  let envelope: Envelope | null = null;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    envelope = null;
  }
  const incompatible =
    !envelope ||
    envelope.schemaVersion !== ANALYTICS_CACHE_SCHEMA_VERSION ||
    envelope.userScopeHash !== userScopeHash ||
    typeof envelope.savedAt !== "number" ||
    now - envelope.savedAt > MAX_AGE_MS ||
    !envelope.state;
  if (incompatible) {
    try { ss.removeItem(ANALYTICS_PERSIST_KEY); } catch { /* ignore */ }
    traceMark("analytics_cache.restore_completed", { restored: false, reason: "incompatible", bytes: raw.length });
    traceMeasure("analytics_cache.restore_duration", "analytics_cache.restore_started", "analytics_cache.restore_completed", { restored: false, bytes: raw.length });
    return false;
  }
  hydrate(client, envelope.state);
  traceMark("analytics_cache.restore_completed", {
    restored: true,
    query_count: envelope.state.queries.length,
    bytes: raw.length,
    has_warehouse_version: envelope.state.queries.some((query) => isWarehouseVersionKey(query.queryKey)),
  });
  traceMeasure("analytics_cache.restore_duration", "analytics_cache.restore_started", "analytics_cache.restore_completed", { restored: true, bytes: raw.length });
  return true;
}

export function clearPersistedAnalyticsCache(): void {
  const ss = safeSessionStorage();
  if (!ss) return;
  try { ss.removeItem(ANALYTICS_PERSIST_KEY); } catch { /* ignore */ }
}

// Subscribe to cache changes and persist (throttled). Returns an unsubscribe fn.
export function startAnalyticsCachePersistence(
  client: QueryClient,
  getUserScopeHash: () => string,
  throttleMs = 1000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      persistAnalyticsCache(client, getUserScopeHash());
    }, throttleMs);
  };
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.query?.queryKey && isPersistableRoot(event.query.queryKey as unknown[])) schedule();
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
