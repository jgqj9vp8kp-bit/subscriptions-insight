// Resolves the signed-in user's workspace access and shares it through
// AccessContext (plan §14, §20, §25). Mount it INSIDE AuthProvider (it reads
// useAuth) and above every consumer of useAccess().
//
// Lifecycle:
//   * auth user becomes known → (purge if another principal used this browser
//     last) → my_access() → status ok | legacy | no_membership | disabled |
//     error. `loading` stays true until that first answer; a failed first
//     answer is retried (ACCESS_FIRST_RESOLVE_RETRY_DELAYS_MS) before "error".
//   * a browser with NO principal marker (last used before this layer, or with
//     cleared storage): the first answer decides — the data owner keeps what
//     is on disk (it is theirs), anyone else is purged ("principal_changed")
//     before the first page renders.
//   * refetch on window focus (throttled) and every 5 minutes while visible.
//     A background refetch that fails keeps the last resolved access — the
//     server still checks every request — instead of bouncing the user to an
//     error screen; only a first resolution can end in "error" (UI: Retry).
//   * partition, access_version or status changes for the same user → the
//     purge registry runs with reason "access_changed" BEFORE the new value is
//     published, so caches of the old partition are gone first.
//   * user switches in-tab → "principal_changed"; user signs out (any
//     SIGNED_OUT, not just the logout button) → "signed_out".
//
// UX only: hiding a page here protects nothing by itself. The Edge gate
// re-resolves access on every request and is the authority.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/services/supabaseClient";
import { errorAccess, fetchMyAccess, legacyAccess, type MyAccess, type MyAccessRpcClient } from "@/services/accessClient";
import {
  AccessContext,
  ACCESS_FIRST_RESOLVE_RETRY_DELAYS_MS,
  ACCESS_FOCUS_REFRESH_MIN_GAP_MS,
  ACCESS_REFRESH_INTERVAL_MS,
  buildAccessValue,
  type AccessStatus,
} from "@/contexts/accessContext";
import { notePrincipal, runPurge } from "@/services/sessionPurge";
import { traceEvent } from "@/services/performanceTrace";

interface AccessState {
  /** The auth user this state belongs to (guards against one stale render). */
  userId: string | null;
  status: AccessStatus;
  access: MyAccess | null;
}

interface ResolvedFingerprint {
  userId: string;
  status: AccessStatus;
  partition: string;
  accessVersion: string;
}

/** Statuses that are a definitive server answer (as opposed to loading/error). */
const RESOLVED_STATUSES: ReadonlySet<AccessStatus> = new Set<AccessStatus>(["ok", "legacy", "no_membership", "disabled"]);

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

export interface AccessProviderProps {
  children: ReactNode;
  /** Test seam. Defaults to the app's Supabase client; null ⇒ legacy. */
  client?: MyAccessRpcClient | null;
  /** Background refetch cadence; 0 disables the timer. */
  refreshIntervalMs?: number;
  /** Minimum gap between a fetch and a focus-triggered refetch. */
  focusRefreshMinGapMs?: number;
  /** Delays of the automatic retries of a failed FIRST resolution ([] = none). */
  firstResolveRetryDelaysMs?: readonly number[];
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The data owner (or legacy mode) — the principal whose pre-access leftovers
 * on this browser are their own. */
function isRawPrincipal(next: MyAccess, userId: string): boolean {
  return next.status === "legacy" || (next.status === "ok" && next.raw_access === true && sameId(next.user_id, userId));
}

export function AccessProvider({
  children,
  client,
  refreshIntervalMs = ACCESS_REFRESH_INTERVAL_MS,
  focusRefreshMinGapMs = ACCESS_FOCUS_REFRESH_MIN_GAP_MS,
  firstResolveRetryDelaysMs = ACCESS_FIRST_RESOLVE_RETRY_DELAYS_MS,
}: AccessProviderProps) {
  const { loading: authLoading, user } = useAuth();
  const userId = user?.id ?? null;
  // Local dev auth (VITE_ENABLE_LOCAL_AUTH, never in production builds) has no
  // Supabase session to resolve: behave exactly as today.
  const localOnly = user?.provider === "local";
  const rpcClient: MyAccessRpcClient | null = client === undefined ? supabase : client;

  const [state, setState] = useState<AccessState>({ userId: null, status: "loading", access: null });
  const stateRef = useRef<AccessState>(state);
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;
  // Read through refs so `resolve` keeps a stable identity even if a caller
  // passes a new client object every render (that would re-run the effects).
  const rpcClientRef = useRef<MyAccessRpcClient | null>(rpcClient);
  rpcClientRef.current = rpcClient;
  const localOnlyRef = useRef(localOnly);
  localOnlyRef.current = localOnly;
  /** Bumped by every resolution and every user transition; a resolution whose
   * number is no longer current is discarded (superseded or stale user). */
  const seqRef = useRef(0);
  const lastResolvedRef = useRef<ResolvedFingerprint | null>(null);
  const lastFetchAtRef = useRef(0);
  const previousUserRef = useRef<string | null>(null);
  /** The latest principal/sign-out purge; resolutions wait for it so no data
   * is fetched into caches that are still being cleared. */
  const pendingPurgeRef = useRef<Promise<void>>(Promise.resolve());
  /** The user whose first sight on this browser found NO principal marker (a
   * browser last used before the access layer existed, or with cleared
   * storage). Their first definitive resolution decides: the data owner keeps
   * the unowned leftovers (they are theirs: behaviour unchanged); anyone else
   * gets a principal_changed purge before any page renders. */
  const unmarkedUserRef = useRef<string | null>(null);
  const retryDelaysRef = useRef(firstResolveRetryDelaysMs);
  retryDelaysRef.current = firstResolveRetryDelaysMs;

  const publish = useCallback((next: AccessState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const resolve = useCallback(async (): Promise<void> => {
    const forUser = userIdRef.current;
    if (!forUser) return;
    const seq = ++seqRef.current;
    lastFetchAtRef.current = Date.now();
    await pendingPurgeRef.current;
    const fetchOnce = () => (localOnlyRef.current ? Promise.resolve(legacyAccess()) : fetchMyAccess(rpcClientRef.current));
    let next = await fetchOnce();
    if (seq !== seqRef.current || userIdRef.current !== forUser) return;
    // A FIRST resolution that failed is retried (bounded) before the error
    // screen; once this user has a resolved access, a failure keeps it instead.
    const hasResolved = () => stateRef.current.userId === forUser && RESOLVED_STATUSES.has(stateRef.current.status);
    for (const delay of retryDelaysRef.current) {
      if (next.status !== "error" || hasResolved()) break;
      traceEvent("access.first_resolve_retry", { delay_ms: delay });
      await wait(delay);
      if (seq !== seqRef.current || userIdRef.current !== forUser) return;
      next = await fetchOnce();
      if (seq !== seqRef.current || userIdRef.current !== forUser) return;
    }

    // my_access() answers for auth.uid(); a row about someone else can only be
    // a session mix-up — never trust it.
    const foreignRow = next.status === "ok" && !sameId(next.user_id, forUser);
    if (next.status === "error" || foreignRow) {
      const current = stateRef.current;
      if (current.userId === forUser && RESOLVED_STATUSES.has(current.status)) {
        traceEvent("access.refresh_failed", { kept_status: current.status });
        return;
      }
      publish({
        userId: forUser,
        status: "error",
        access: foreignRow ? errorAccess("my_access answered for a different user") : next,
      });
      return;
    }

    const fingerprint: ResolvedFingerprint = {
      userId: forUser,
      status: next.status,
      partition: next.partition,
      accessVersion: next.access_version,
    };
    const previous = lastResolvedRef.current;
    if (
      previous &&
      previous.userId === forUser &&
      (previous.status !== fingerprint.status ||
        previous.partition !== fingerprint.partition ||
        previous.accessVersion !== fingerprint.accessVersion)
    ) {
      traceEvent("access.changed", { from: previous.status, to: fingerprint.status });
      await runPurge("access_changed");
      if (seq !== seqRef.current || userIdRef.current !== forUser) return;
    }
    if (unmarkedUserRef.current === forUser) {
      unmarkedUserRef.current = null;
      if (!isRawPrincipal(next, forUser)) {
        traceEvent("access.unmarked_browser_purge", { status: next.status });
        await runPurge("principal_changed");
        if (seq !== seqRef.current || userIdRef.current !== forUser) return;
      }
    }
    lastResolvedRef.current = fingerprint;
    traceEvent("access.resolved", { status: next.status });
    publish({ userId: forUser, status: next.status, access: next });
  }, [publish]);

  // User transitions: first sight, account switch, sign-out.
  useEffect(() => {
    if (authLoading) return;
    const previousUser = previousUserRef.current;
    previousUserRef.current = userId;
    seqRef.current += 1; // drop any in-flight resolution for the previous user

    if (!userId) {
      lastResolvedRef.current = null;
      unmarkedUserRef.current = null;
      publish({ userId: null, status: "signed_out", access: null });
      if (previousUser) pendingPurgeRef.current = runPurge("signed_out");
      return;
    }

    const switched = previousUser !== null && previousUser !== userId;
    if (switched) lastResolvedRef.current = null;
    const current = stateRef.current;
    if (!(current.userId === userId && RESOLVED_STATUSES.has(current.status))) {
      publish({ userId, status: "loading", access: null });
    }
    // Always record the principal; purge when this browser was last used by
    // someone else (in-tab switch, or leftovers from a closed tab).
    const marker = notePrincipal(userId);
    if (switched || marker === "changed") pendingPurgeRef.current = runPurge("principal_changed");
    // (A re-run of this effect for the same user sees "same": keep the flag.)
    if (!switched && marker === "first") unmarkedUserRef.current = userId;
    else if (unmarkedUserRef.current !== userId) unmarkedUserRef.current = null;
    void resolve();
  }, [authLoading, userId, publish, resolve]);

  // Background refetch: window focus (throttled) and a visible-tab interval.
  useEffect(() => {
    if (authLoading || !userId) return undefined;
    const onFocus = () => {
      if (Date.now() - lastFetchAtRef.current < focusRefreshMinGapMs) return;
      void resolve();
    };
    window.addEventListener("focus", onFocus);
    const timer =
      refreshIntervalMs > 0
        ? window.setInterval(() => {
          if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
          void resolve();
        }, refreshIntervalMs)
        : undefined;
    return () => {
      window.removeEventListener("focus", onFocus);
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [authLoading, userId, resolve, refreshIntervalMs, focusRefreshMinGapMs]);

  const refresh = useCallback(async () => {
    const current = stateRef.current;
    if (current.userId && current.status === "error") publish({ userId: current.userId, status: "loading", access: null });
    await resolve();
  }, [publish, resolve]);

  const value = useMemo(() => {
    // Until the effect has caught up with a user change, never expose the
    // previous user's access (one render can see the new user + old state).
    const current = state.userId === userId;
    const status: AccessStatus = authLoading ? "loading" : !userId ? "signed_out" : current ? state.status : "loading";
    return buildAccessValue({
      status,
      access: current && !authLoading ? state.access : null,
      userId,
      loading: status === "loading",
      refresh,
    });
  }, [authLoading, refresh, state, userId]);

  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}
