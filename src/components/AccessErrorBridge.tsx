// Turns access errors from Edge calls made through React Query into session /
// access actions (plan §14 "Typed errors", §27 R12). Mount once inside
// QueryClientProvider, AuthProvider and AccessProvider; renders nothing.
//
//   401 invalid_session  → sign out THIS browser (scope "local"): the server no
//                          longer accepts this session; other devices keep theirs.
//   403 no_membership | membership_disabled | permission_denied |
//       scope_not_supported | raw_access_required | owner_required |
//       full_scope_required | funnel_out_of_scope
//                        → refresh my_access() (debounced): the role or funnel
//                          scope probably changed under this tab. If it did,
//                          the provider purges caches before publishing it.
//   409 scope_snapshot_not_ready
//                        → nothing: the funnel-scoped snapshot is being
//                          prepared; the page polls it (never sign out).
//   503 auth_service_error | access_service_error | workspace_not_bootstrapped
//                        → nothing: transient server trouble, never sign out.
//   anything else        → nothing (pages render their own errors).
//
// Only typed errors (isAccessError / ClickHouseRequestError) are considered,
// never message text. UX only: the Edge gate already refused the request.

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useAccess } from "@/hooks/useAccess";
import { isAccessError, type ClickHouseRequestError } from "@/services/clickhouse";
import { traceEvent } from "@/services/performanceTrace";

/** 403 codes that mean "your access is not what this tab thinks it is". */
const REFRESH_ON_403: ReadonlySet<string> = new Set([
  "no_membership",
  "membership_disabled",
  "permission_denied",
  "scope_not_supported",
  "raw_access_required",
  "owner_required",
  "full_scope_required",
  "funnel_out_of_scope",
]);

/** A page fires several queries at once; one refresh answers the burst. */
export const ACCESS_ERROR_REFRESH_DEBOUNCE_MS = 750;

/** A page that keeps calling a denied action must not hammer my_access(). */
export const ACCESS_ERROR_REFRESH_MIN_GAP_MS = 15_000;

type Reaction = "sign_out" | "refresh_access" | null;

function reactionFor(error: unknown): Reaction {
  if (!isAccessError(error)) return null;
  const { status, errorCode } = error as Partial<Pick<ClickHouseRequestError, "status" | "errorCode">>;
  if (status === 401 && errorCode === "invalid_session") return "sign_out";
  if (status === 403 && typeof errorCode === "string" && REFRESH_ON_403.has(errorCode)) return "refresh_access";
  return null;
}

export interface AccessErrorBridgeProps {
  /** Test seams. */
  refreshDebounceMs?: number;
  refreshMinGapMs?: number;
}

export function AccessErrorBridge({
  refreshDebounceMs = ACCESS_ERROR_REFRESH_DEBOUNCE_MS,
  refreshMinGapMs = ACCESS_ERROR_REFRESH_MIN_GAP_MS,
}: AccessErrorBridgeProps = {}) {
  const queryClient = useQueryClient();
  const { signOut, user } = useAuth();
  const { refresh } = useAccess();
  const userId = user?.id ?? null;
  // The cache subscriptions live as long as the client; read the latest
  // callbacks and user through refs instead of re-subscribing every render.
  const signOutRef = useRef(signOut);
  signOutRef.current = signOut;
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  /** The user a sign-out was already started for: a burst of 401s (every
   * query of the page) signs out once. Cleared when the user changes, and on
   * a failed sign-out so the next 401 tries again. */
  const signedOutForRef = useRef<string | null>(null);

  useEffect(() => {
    signedOutForRef.current = null;
  }, [userId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastRefreshAt = Number.NEGATIVE_INFINITY;

    const scheduleRefresh = () => {
      if (timer !== undefined) return; // the pending refresh covers this error too
      const wait = Math.max(refreshDebounceMs, lastRefreshAt + refreshMinGapMs - Date.now());
      timer = setTimeout(() => {
        timer = undefined;
        lastRefreshAt = Date.now();
        traceEvent("access.error_refresh");
        Promise.resolve()
          .then(() => refreshRef.current())
          .catch((error) => console.warn("[AccessErrorBridge] access refresh failed:", error instanceof Error ? error.message : error));
      }, wait);
    };

    const signOutOnce = () => {
      const forUser = userIdRef.current;
      if (!forUser || signedOutForRef.current === forUser) return;
      signedOutForRef.current = forUser;
      traceEvent("access.error_sign_out");
      // Local scope: this tab's session is the one the server rejected. A
      // global sign-out would revoke the user's sessions on every device
      // because of one 401 (e.g. a token that expired between the gateway and
      // getUser).
      Promise.resolve()
        .then(() => signOutRef.current({ scope: "local" }))
        .catch((error) => {
          if (signedOutForRef.current === forUser) signedOutForRef.current = null;
          console.warn("[AccessErrorBridge] sign-out failed:", error instanceof Error ? error.message : error);
        });
    };

    const handle = (error: unknown) => {
      const reaction = reactionFor(error);
      if (reaction === "sign_out") signOutOnce();
      else if (reaction === "refresh_access") scheduleRefresh();
    };

    // An entry the purge registry already dropped (sign-out, account switch,
    // access change) belongs to a previous principal: its late error must not
    // sign out or refresh whoever is signed in now.
    const queryCache = queryClient.getQueryCache();
    const unsubscribeQueries = queryCache.subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (queryCache.get(event.query.queryHash) !== event.query) return;
      handle(event.action.error);
    });
    const mutationCache = queryClient.getMutationCache();
    const unsubscribeMutations = mutationCache.subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      if (!mutationCache.getAll().includes(event.mutation)) return;
      handle(event.action.error);
    });

    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [queryClient, refreshDebounceMs, refreshMinGapMs]);

  return null;
}
