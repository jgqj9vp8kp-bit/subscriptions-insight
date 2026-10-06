// Session purge registry (plan §20 "Cache isolation strategy", §25).
//
// Client-side caches live in many modules: React Query, sessionStorage
// snapshots, IndexedDB warehouses, zustand stores, module-level memos. Rather
// than one module knowing all of them, each cache owner registers a purge
// handler here, and the auth/access layer calls runPurge(reason) at the moments
// when previously cached data may no longer be visible to whoever is in front
// of the screen:
//   * "signed_out"        — the session ended (logout click OR any SIGNED_OUT,
//                           e.g. an expired refresh token or another tab);
//   * "principal_changed" — a different user is now signed in on this browser
//                           (account switch in-tab, or app start with another
//                           user's leftovers — see notePrincipal below);
//   * "access_changed"    — same user, but the server-issued partition or
//                           access_version changed (role / funnel scope edited).
//
// runPurge never throws: a failing or hanging handler is logged and skipped, so
// a broken cache can never block sign-out or an access refresh. Handlers run in
// parallel and each is bounded by a timeout (indexedDB.deleteDatabase can stay
// "blocked" indefinitely while another tab holds a connection).
//
// Registration is by NAME: registering the same name again replaces the earlier
// handler (safe under Vite HMR re-evaluating a module), and the returned
// unregister function only removes the handler it registered.

export type PurgeReason = "signed_out" | "principal_changed" | "access_changed";

export type PurgeHandler = (reason: PurgeReason) => void | Promise<void>;

/** Upper bound for one handler; a slower handler is abandoned (and logged). */
export const PURGE_HANDLER_TIMEOUT_MS = 5_000;

const handlers = new Map<string, PurgeHandler>();

export function registerPurgeHandler(name: string, fn: PurgeHandler): () => void {
  handlers.set(name, fn);
  return () => {
    if (handlers.get(name) === fn) handlers.delete(name);
  };
}

/** Names of the currently registered handlers (diagnostics and tests). */
export function registeredPurgeHandlers(): string[] {
  return [...handlers.keys()];
}

function withTimeout(promise: Promise<void>, timeoutMs: number, name: string): Promise<void> {
  if (!(timeoutMs > 0)) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`purge handler "${name}" exceeded ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

/** Runs every registered handler for `reason`. Resolves once all handlers have
 * settled (or timed out). Never rejects. */
export async function runPurge(reason: PurgeReason, options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? PURGE_HANDLER_TIMEOUT_MS;
  const entries = [...handlers.entries()];
  const results = await Promise.allSettled(
    entries.map(([name, fn]) => {
      let pending: Promise<void>;
      try {
        // Promise.resolve().then(...) would defer synchronous handlers; calling
        // directly keeps synchronous purges synchronous with the caller.
        pending = Promise.resolve(fn(reason));
      } catch (error) {
        pending = Promise.reject(error);
      }
      return withTimeout(pending, timeoutMs, name);
    }),
  );
  results.forEach((result, index) => {
    if (result.status === "rejected") {
      const name = entries[index][0];
      const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.warn(`[sessionPurge] handler "${name}" failed during ${reason} purge: ${message}`);
    }
  });
}

// ---- principal marker ---------------------------------------------------------
//
// "On app start when the stored partition owner ≠ session user" (§20): if the
// tab was closed while user A was signed in and user B signs in later, no
// SIGNED_OUT ever fired in a live tab, so A's persisted caches would still be on
// disk. The access provider calls notePrincipal(userId) when a user first
// becomes known; "changed" means another principal used this browser last and
// the caller must runPurge("principal_changed") before any cache is read.
//
// Only a hash of the user id is stored, so the marker does not reveal who last
// used a shared device.

export const PRINCIPAL_STORAGE_KEY = "subengine.access.principal.v1";

/** 53-bit string hash (cyrb53). Not cryptographic; collisions only skip a purge
 * that the regular signed_out purge already performed. */
export function principalHash(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** Records `userId` as the browser's current principal and reports how it
 * relates to the previous one. "first" when nothing was stored (or storage is
 * not usable); the caller treats that like "same". */
export function notePrincipal(userId: string): "first" | "same" | "changed" {
  const next = principalHash(userId.toLowerCase());
  try {
    const previous = localStorage.getItem(PRINCIPAL_STORAGE_KEY);
    if (previous !== next) localStorage.setItem(PRINCIPAL_STORAGE_KEY, next);
    if (previous === null) return "first";
    return previous === next ? "same" : "changed";
  } catch {
    return "first";
  }
}
