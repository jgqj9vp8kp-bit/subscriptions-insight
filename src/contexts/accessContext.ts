// Access state shared through React context (plan §14). The provider
// (src/components/AccessProvider.tsx) owns fetching; this module holds the
// types, the context object and the PURE derivation of the value from a
// MyAccess row, so tests and future consumers can build a value without
// mounting the provider.
//
// UX only — the Edge gate is authoritative. The derivation mirrors the server:
// effective permissions come from effectivePermissions() in the shared catalog
// (owner ⇒ every enforced key; planned keys never; requiresFullScope keys only
// with funnel scope "all"), and every non-ok, non-legacy state grants nothing.

import { createContext } from "react";
import type { MyAccess, MyAccessStatus } from "@/services/accessClient";
import { effectivePermissions } from "../../supabase/functions/_shared/access/permissions.ts";

/** MyAccessStatus plus two provider-only states: "loading" (first resolution
 * for the current user in flight) and "signed_out" (no auth user). Neither
 * grants anything. */
export type AccessStatus = MyAccessStatus | "loading" | "signed_out";

export type AccessContextValue = {
  /** True until the first resolution for the current user (or while auth loads). */
  loading: boolean;
  status: AccessStatus;
  access: MyAccess | null;
  /** Server not bootstrapped (or no Supabase): behave exactly as today. */
  legacy: boolean;
  /** Data owner (raw downloads / client-compute paths). Legacy ⇒ true. */
  rawAccess: boolean;
  /** Cache partition for query keys and persisted caches. Legacy ⇒
   * "legacy:" + user id; "" whenever no data may be loaded (loading, signed
   * out, no membership, disabled, error). */
  partition: string;
  /** Effective permissions (legacy ⇒ every enforced key). */
  permissions: Set<string>;
  /** Legacy ⇒ true for any key; otherwise only effective keys of an ok status. */
  can: (key: string) => boolean;
  /** True when at least one key passes can(); an empty list is false. */
  canAny: (keys: readonly string[]) => boolean;
  /** Refetch my_access(). From an "error" state this shows loading again. */
  refresh: () => Promise<void>;
};

export const AccessContext = createContext<AccessContextValue | null>(null);

/** Refetch cadence (§25: "on window focus and every 5 minutes"). */
export const ACCESS_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

/** Focus events can burst (devtools, alt-tab); one refetch per gap is enough. */
export const ACCESS_FOCUS_REFRESH_MIN_GAP_MS = 15 * 1000;

/** The FIRST my_access() resolution for a user is retried after these delays
 * before the app shows the full-page "could not resolve access" screen: a
 * network blip after sleep or a PostgREST hiccup should cost a second of
 * "Checking access...", not a Retry click. Background refetches never retry
 * (they keep the last resolved access instead). */
export const ACCESS_FIRST_RESOLVE_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 3_000]);

export const LEGACY_PARTITION_PREFIX = "legacy:";

const noopRefresh = async () => {};

function sameId(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();
}

/** Derives the context value from a status + MyAccess row for `userId` (the
 * signed-in auth user). Pure; the provider memoizes it. */
export function buildAccessValue(input: {
  status: AccessStatus;
  access: MyAccess | null;
  userId: string | null;
  loading?: boolean;
  refresh?: () => Promise<void>;
}): AccessContextValue {
  const { status, access, userId } = input;
  const legacy = status === "legacy";
  let permissions: Set<string>;
  let rawAccess = false;
  let partition = "";

  if (legacy) {
    permissions = effectivePermissions({ granted: [], isOwner: true, funnelScopeAll: true });
    rawAccess = true;
    partition = `${LEGACY_PARTITION_PREFIX}${userId ?? "anonymous"}`;
  } else if (status === "ok" && access?.status === "ok" && access.role) {
    permissions = effectivePermissions({
      granted: access.role.permissions,
      isOwner: access.role.is_owner,
      funnelScopeAll: access.funnel_scope?.mode === "all",
    });
    // Defence in depth: the server flag alone is not enough — the row must be
    // about the signed-in user (a stale row from a previous session never is).
    rawAccess = access.raw_access === true && sameId(access.user_id, userId);
    partition = access.partition;
  } else {
    permissions = new Set<string>();
  }

  const granted = status === "ok" && permissions.size > 0;
  const can = (key: string) => legacy || (granted && permissions.has(key));
  const canAny = (keys: readonly string[]) => Array.isArray(keys) && keys.some((key) => can(key));

  return {
    loading: input.loading ?? status === "loading",
    status,
    access,
    legacy,
    rawAccess,
    partition,
    permissions,
    can,
    canAny,
    refresh: input.refresh ?? noopRefresh,
  };
}
