// Persist the warehouse-backed analytics slice of the TanStack Query cache
// (Cohorts, Users, Payment Pass Analytics) to sessionStorage so it survives a
// page reload in the same browser session. This is NOT a second cache system — it
// dehydrates/rehydrates the SAME QueryClient using the library's own
// dehydrate()/hydrate(). Only aggregate responses (+ the tiny warehouse-version
// entry) are persisted; never tokens, emails, raw ids, or transactions.
//
// Isolation (plan §20): one envelope per access partition, stored under
// "analytics.qcache.v3:<partition>". A tab holds one live partition, so writing
// or restoring one partition drops every other envelope, and the session purge
// (sign-out, account switch, access change) removes every "analytics.*" key.
// PII-bearing bundles — Users rows (customer emails / ids), Support lists,
// details and replies (message bodies, sender addresses), and any entry keyed
// by a free-text search — are never written.

import { dehydrate, hydrate, type QueryClient, type Query } from "@tanstack/react-query";
import { ANALYTICS_CACHE_SCHEMA_VERSION, WAREHOUSE_DEPENDENT_ROOTS, WAREHOUSE_VERSION_KEY } from "@/services/analyticsCache";
import { registerPurgeHandler } from "@/services/sessionPurge";
import { traceEvent, traceMark, traceMeasure } from "@/services/performanceTrace";

export const ANALYTICS_PERSIST_KEY_PREFIX = "analytics.qcache.v3";
/** Every sessionStorage key this layer (or an older build of it) may own. */
const ANALYTICS_SESSION_KEY_PREFIX = "analytics.";
const MAX_AGE_MS = 60 * 60 * 1000; // 60 min — matches gcTime
const MAX_QUERIES = 16; // bound the number of cached responses kept
const MAX_BYTES = 3_500_000; // stay well under the ~5MB sessionStorage ceiling

export function analyticsPersistKey(partition: string): string {
  return `${ANALYTICS_PERSIST_KEY_PREFIX}:${partition}`;
}

/** @deprecated Use analyticsPersistKey(partition). Storage key of the partition
 * most recently persisted or restored in this tab (an ES live binding, kept for
 * callers that inspect the stored envelope directly). */
export let ANALYTICS_PERSIST_KEY = ANALYTICS_PERSIST_KEY_PREFIX;

interface Envelope {
  schemaVersion: number;
  partition: string;
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

function sessionKeys(ss: Storage): string[] {
  const keys: string[] = [];
  try {
    for (let index = 0; index < ss.length; index += 1) {
      const key = ss.key(index);
      if (key !== null) keys.push(key);
    }
  } catch {
    // storage became unusable mid-scan; nothing more to do
  }
  return keys;
}

/** Drops every persisted query-cache envelope except `keep` (other partitions,
 * older layouts such as "analytics.qcache.v1"). */
function removeOtherEnvelopes(ss: Storage, keep: string | null): void {
  for (const key of sessionKeys(ss)) {
    if (key !== keep && key.startsWith("analytics.qcache.")) {
      try { ss.removeItem(key); } catch { /* ignore */ }
    }
  }
}

function isPersistableRoot(key: unknown[]): boolean {
  if (key[0] === WAREHOUSE_VERSION_KEY[0] && key[1] === WAREHOUSE_VERSION_KEY[1]) return true;
  return typeof key[0] === "string" && WAREHOUSE_DEPENDENT_ROOTS.includes(key[0]);
}

function isWarehouseVersionKey(key: unknown): boolean {
  return Array.isArray(key) && key[0] === WAREHOUSE_VERSION_KEY[0] && key[1] === WAREHOUSE_VERSION_KEY[1];
}

/** Users rows carry customer emails / ids; Support lists, details and answered
 * replies carry message bodies and sender addresses. Only their aggregate
 * siblings (Users summary / options / decline, the Support bundle) persist. */
function isPiiBearingKey(key: unknown[]): boolean {
  if (key[0] === "users") return !(key[1] === "summary" || key[1] === "options" || key[1] === "decline");
  if (key[0] === "support") return key[1] !== "bundle";
  return false;
}

/** A free-text search lives in the key itself and may be an email address. */
function hasSearchText(key: unknown[]): boolean {
  return key.some((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return false;
    const search = (part as { search?: unknown }).search;
    return typeof search === "string" && search.trim().length > 0;
  });
}

// Which queries are safe + worth persisting: successful warehouse-dependent
// aggregate entries and the warehouse-version entry. Everything else is skipped.
export function shouldPersistAnalyticsQuery(query: Pick<Query, "queryKey" | "state">): boolean {
  const key = query.queryKey as unknown[];
  if (!isPersistableRoot(key)) return false;
  if (isPiiBearingKey(key) || hasSearchText(key)) return false;
  return query.state.status === "success" && query.state.data != null;
}

export function persistAnalyticsCache(client: QueryClient, partition: string, now: number = Date.now()): void {
  const ss = safeSessionStorage();
  if (!ss || !partition) return;
  const storageKey = analyticsPersistKey(partition);
  ANALYTICS_PERSIST_KEY = storageKey;
  traceMark("analytics_cache.persist_started");
  const state = dehydrate(client, { shouldDehydrateQuery: shouldPersistAnalyticsQuery, shouldDehydrateMutation: () => false });

  const versionQueries = state.queries
    .filter((query) => isWarehouseVersionKey(query.queryKey))
    .sort((a, b) => (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0));
  const aggregateQueries = state.queries
    .filter((query) => !isWarehouseVersionKey(query.queryKey))
    .sort((a, b) => (b.state.dataUpdatedAt ?? 0) - (a.state.dataUpdatedAt ?? 0));
  state.queries = [...versionQueries, ...aggregateQueries].slice(0, MAX_QUERIES);

  removeOtherEnvelopes(ss, storageKey);
  // Nothing worth keeping (e.g. right after a purge cleared the client).
  if (!state.queries.length) {
    try { ss.removeItem(storageKey); } catch { /* ignore */ }
    return;
  }

  const envelope: Envelope = { schemaVersion: ANALYTICS_CACHE_SCHEMA_VERSION, partition, savedAt: now, state };
  let serialized = JSON.stringify(envelope);
  while (serialized.length > MAX_BYTES && envelope.state.queries.length > 0) {
    envelope.state.queries = envelope.state.queries.slice(0, -1);
    serialized = JSON.stringify(envelope);
  }
  try {
    ss.setItem(storageKey, serialized);
    traceMark("analytics_cache.persist_completed", { query_count: envelope.state.queries.length, bytes: serialized.length });
    traceMeasure("analytics_cache.persist_duration", "analytics_cache.persist_started", "analytics_cache.persist_completed", { query_count: envelope.state.queries.length, bytes: serialized.length });
  } catch {
    try { ss.removeItem(storageKey); } catch { /* ignore */ }
    traceEvent("analytics_cache.persist_failed", { query_count: envelope.state.queries.length, bytes: serialized.length });
  }
}

// Restore a previously-persisted slice, but ONLY when the schema version and
// partition match and it has not expired. Otherwise discard (safe cleanup of
// incompatible / foreign / stale data). Envelopes of any other partition are
// dropped unread.
export function restoreAnalyticsCache(client: QueryClient, partition: string, now: number = Date.now()): boolean {
  const ss = safeSessionStorage();
  if (!ss || !partition) return false;
  const storageKey = analyticsPersistKey(partition);
  ANALYTICS_PERSIST_KEY = storageKey;
  traceMark("analytics_cache.restore_started");
  removeOtherEnvelopes(ss, storageKey);
  let raw: string | null = null;
  try {
    raw = ss.getItem(storageKey);
  } catch {
    raw = null;
  }
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
    envelope.partition !== partition ||
    typeof envelope.savedAt !== "number" ||
    now - envelope.savedAt > MAX_AGE_MS ||
    !envelope.state ||
    !Array.isArray(envelope.state.queries);
  if (incompatible) {
    try { ss.removeItem(storageKey); } catch { /* ignore */ }
    traceMark("analytics_cache.restore_completed", { restored: false, reason: "incompatible", bytes: raw.length });
    traceMeasure("analytics_cache.restore_duration", "analytics_cache.restore_started", "analytics_cache.restore_completed", { restored: false, bytes: raw.length });
    return false;
  }
  // Defence in depth: an entry this build would not persist is not restored
  // either (an envelope written by a looser build, or edited in devtools).
  const state = { ...envelope.state, queries: envelope.state.queries.filter((query) => shouldPersistAnalyticsQuery(query as never)) };
  hydrate(client, state);
  traceMark("analytics_cache.restore_completed", {
    restored: true,
    query_count: state.queries.length,
    bytes: raw.length,
    has_warehouse_version: state.queries.some((query) => isWarehouseVersionKey(query.queryKey)),
  });
  traceMeasure("analytics_cache.restore_duration", "analytics_cache.restore_started", "analytics_cache.restore_completed", { restored: true, bytes: raw.length });
  return true;
}

/** Removes every persisted query-cache envelope (all partitions, all layouts). */
export function clearPersistedAnalyticsCache(): void {
  const ss = safeSessionStorage();
  if (!ss) return;
  removeOtherEnvelopes(ss, null);
}

/** Removes every "analytics.*" sessionStorage key (the purge target). */
export function clearAnalyticsSessionStorage(): void {
  const ss = safeSessionStorage();
  if (!ss) return;
  for (const key of sessionKeys(ss)) {
    if (key.startsWith(ANALYTICS_SESSION_KEY_PREFIX)) {
      try { ss.removeItem(key); } catch { /* ignore */ }
    }
  }
}

/** Bumped by the purge: a throttled write scheduled before it is dropped, so a
 * pending timer can never write the previous partition's entries back. */
let persistEpoch = 0;

// Subscribe to cache changes and persist (throttled). Returns an unsubscribe fn.
export function startAnalyticsCachePersistence(
  client: QueryClient,
  getPartition: () => string,
  throttleMs = 1000,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer) return;
    const epoch = persistEpoch;
    timer = setTimeout(() => {
      timer = null;
      if (epoch !== persistEpoch) return;
      persistAnalyticsCache(client, getPartition());
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

// Sign-out, account switch and access change: the persisted envelopes belong to
// the previous principal / partition (the in-memory cache is cleared by the
// "react-query" handler in App.tsx).
registerPurgeHandler("analytics-session-cache", () => {
  persistEpoch += 1;
  clearAnalyticsSessionStorage();
});
