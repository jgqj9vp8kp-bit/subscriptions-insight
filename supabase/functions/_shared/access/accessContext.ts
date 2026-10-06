// AccessContext: the per-request answer to "who is calling, whose data, which
// permissions, which funnels" (plan §10, D7).
//
// It is built from ONE call to public.resolve_access(user_id) per request and is
// never cached across requests, so a revocation takes effect on the next call.
// Pure module (dependency-free, vitest-testable), following the SH/auth.ts
// precedent: the Deno wiring lives in SH/http.ts.
//
// The two invariants everything downstream relies on:
//   * tenantKey is the workspace data_key — the value bound to every
//     {auth_user_id:String} — and NEVER the caller, unless the caller IS the
//     data owner (D1). Runners receive it as `authUserId`.
//   * restricted = funnel scope is not `all`. Restricted contexts are denied on
//     every action not explicitly marked scopeReady (R6), and the ScopedReader
//     records a violation for any protected-table read (R7).

import { ENFORCED_PERMISSION_KEYS, effectivePermissions } from "./permissions.ts";
import { canonicalFunnelIds, canonicalScopePaths, type FunnelScope } from "./scope.ts";
import { ACCESS_ERROR, accessDenial, type AccessDenial } from "./errors.ts";

export type ActorKind = "user" | "cron" | "api_key";

export interface AccessActor {
  kind: ActorKind;
  userId: string | null;
  memberId: string | null;
  email: string | null;
}

export interface AccessRole {
  id: string;
  key: string;
  name: string;
  isOwner: boolean;
}

export interface AccessContext {
  requestId: string;
  actor: AccessActor;
  /** workspace data_key; bind to {auth_user_id:String}; NEVER the caller unless the caller is the data owner. */
  tenantKey: string;
  /** Empty string in cron contexts (workspace_data_key() returns only the key; the workspace is a singleton). */
  workspaceId: string;
  /** The data owner only (actor.userId === tenantKey): raw-download / client-compute paths (D8). */
  rawAccess: boolean;
  role: AccessRole | null;
  /** Effective permissions (§8): enforced, requires-satisfied, full-scope keys only with scope `all`. */
  permissions: ReadonlySet<string>;
  scope: { funnel: FunnelScope };
  /** funnel scope mode !== "all" */
  restricted: boolean;
  accessVersion: string;
  /** Server-issued client cache partition (§20). */
  partition: string;
  /** Recorded by the ScopedReader; the serve wrapper turns a non-empty list into a 500. */
  violations: string[];
}

/** Policy of one canonical action of one function (§10 step 4). */
export interface ActionPolicy {
  /** At least one of these must be effective. An empty list denies. */
  anyOf?: string[];
  /** All of these must be effective. */
  allOf?: string[];
  /** Data owner only (raw downloads, client-compute paths, D8). */
  rawOnly?: boolean;
  /** Workspace Owner role only. */
  ownerOnly?: boolean;
  /** Funnel scope `all` only (whole-tenant artifacts, writers). */
  fullScopeOnly?: boolean;
  /** The action's reads go through scope helpers; restricted contexts may call it (Milestone B). */
  scopeReady?: boolean;
  /** Mutates state (informational in Phase 1; audit / rate limits key on it later). */
  write?: boolean;
}

// ---- resolve_access row -------------------------------------------------------

export type ResolveAccessStatus = "ok" | "no_workspace" | "no_membership" | "disabled";

export interface ResolveAccessRow {
  status: ResolveAccessStatus;
  workspace_id: string | null;
  data_key: string | null;
  member_id: string | null;
  user_id: string;
  email: string | null;
  display_name: string | null;
  is_data_owner: boolean;
  raw_access: boolean;
  role: { id: string; key: string; name: string; is_owner: boolean; permissions: string[] } | null;
  funnel_scope: { mode: "all" | "selected" | "none"; funnel_ids: string[]; paths: string[] } | null;
  access_version: string;
  partition: string;
}

const STATUSES: ReadonlySet<string> = new Set(["ok", "no_workspace", "no_membership", "disabled"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Parses the resolve_access / my_access JSON. Returns null when the payload is
 * not a recognizable row, and — for status "ok" — when anything the gate relies
 * on is missing. The caller maps null to 503 access_service_error (R2: a
 * resolver fault is never "allow"). */
export function parseResolveAccessRow(raw: unknown): ResolveAccessRow | null {
  const row = record(raw);
  if (!row) return null;
  const status = text(row.status);
  if (!status || !STATUSES.has(status)) return null;
  const userId = text(row.user_id);
  if (!userId) return null;

  const roleRow = record(row.role);
  const scopeRow = record(row.funnel_scope);
  const scopeMode = text(scopeRow?.mode);
  const parsed: ResolveAccessRow = {
    status: status as ResolveAccessStatus,
    workspace_id: text(row.workspace_id),
    data_key: text(row.data_key),
    member_id: text(row.member_id),
    user_id: userId,
    email: text(row.email),
    display_name: text(row.display_name),
    is_data_owner: row.is_data_owner === true,
    raw_access: row.raw_access === true,
    role: roleRow
      ? {
        id: text(roleRow.id) ?? "",
        key: text(roleRow.key) ?? "",
        name: text(roleRow.name) ?? "",
        is_owner: roleRow.is_owner === true,
        permissions: stringArray(roleRow.permissions),
      }
      : null,
    funnel_scope: scopeRow
      ? {
        mode: scopeMode === "all" || scopeMode === "selected" ? scopeMode : "none",
        funnel_ids: stringArray(scopeRow.funnel_ids),
        paths: stringArray(scopeRow.paths),
      }
      : null,
    access_version: text(row.access_version) ?? "",
    partition: text(row.partition) ?? "",
  };

  if (parsed.status !== "ok") return parsed;
  if (!isUuid(parsed.data_key) || !parsed.workspace_id || !parsed.member_id) return null;
  if (!parsed.role || !parsed.role.id || !parsed.role.key) return null;
  if (!parsed.access_version || !parsed.partition) return null;
  return parsed;
}

function funnelScopeOf(row: ResolveAccessRow): FunnelScope {
  // No rule ⇒ no data (§9). Only an explicit `all` is unrestricted.
  const scope = row.funnel_scope;
  if (!scope) return { mode: "none" };
  if (scope.mode === "all") return { mode: "all" };
  if (scope.mode === "selected") {
    return { mode: "selected", funnelIds: canonicalFunnelIds(scope.funnel_ids), paths: canonicalScopePaths(scope.paths) };
  }
  return { mode: "none" };
}

const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

/** Builds the context of a USER (or API-key) request from an `ok` resolve_access
 * row. Throws on any other status — the gate maps those before calling. */
export function buildAccessContext(
  row: ResolveAccessRow,
  actor: { kind: ActorKind; userId: string | null; email?: string | null },
  requestId: string,
): AccessContext {
  if (row.status !== "ok" || !row.role || !isUuid(row.data_key) || !row.workspace_id) {
    throw new Error(`buildAccessContext requires an ok resolve_access row (got ${row.status}).`);
  }
  const funnel = funnelScopeOf(row);
  const tenantKey = row.data_key;
  // Defence in depth: the SQL flag alone does not grant raw access — the actor
  // must also BE the data key (D8). A mismatch fails closed to "not raw".
  const rawAccess = actor.kind === "user" && row.raw_access === true && sameId(actor.userId, tenantKey) && sameId(row.user_id, tenantKey);
  return {
    requestId,
    actor: { kind: actor.kind, userId: actor.userId, memberId: row.member_id, email: actor.email ?? row.email ?? null },
    tenantKey,
    workspaceId: row.workspace_id,
    rawAccess,
    role: { id: row.role.id, key: row.role.key, name: row.role.name, isOwner: row.role.is_owner },
    permissions: effectivePermissions({ granted: row.role.permissions, isOwner: row.role.is_owner, funnelScopeAll: funnel.mode === "all" }),
    scope: { funnel },
    restricted: funnel.mode !== "all",
    accessVersion: row.access_version,
    partition: row.partition,
    violations: [],
  };
}

/** Cron context (§10 "Other contexts"): tenant from the workspace, never from the
 * request; every enforced permission; scope all; not raw (no browser). */
export function buildCronAccessContext(input: { tenantKey: string; workspaceId?: string | null; requestId: string }): AccessContext {
  return {
    requestId: input.requestId,
    actor: { kind: "cron", userId: null, memberId: null, email: null },
    tenantKey: input.tenantKey,
    workspaceId: input.workspaceId ?? "",
    rawAccess: false,
    role: null,
    permissions: new Set(ENFORCED_PERMISSION_KEYS),
    scope: { funnel: { mode: "all" } },
    restricted: false,
    accessVersion: "cron",
    partition: `cron:${input.tenantKey}`,
    violations: [],
  };
}

/** Checks one action policy against a context. null = allowed. Order: identity
 * class (owner / raw), then permissions, then scope — so a member lacking the
 * permission learns "permission_denied", not that the action exists for others. */
export function authorizeAction(ctx: AccessContext, policy: ActionPolicy | null | undefined): AccessDenial | null {
  if (!policy) return accessDenial(403, ACCESS_ERROR.POLICY_MISSING);
  if (policy.ownerOnly && !ctx.role?.isOwner) return accessDenial(403, ACCESS_ERROR.OWNER_REQUIRED);
  if (policy.rawOnly && !ctx.rawAccess) return accessDenial(403, ACCESS_ERROR.RAW_ACCESS_REQUIRED);
  if (policy.allOf && !policy.allOf.every((key) => ctx.permissions.has(key))) return accessDenial(403, ACCESS_ERROR.PERMISSION_DENIED);
  if (policy.anyOf && !policy.anyOf.some((key) => ctx.permissions.has(key))) return accessDenial(403, ACCESS_ERROR.PERMISSION_DENIED);
  if (policy.fullScopeOnly && ctx.restricted) return accessDenial(403, ACCESS_ERROR.FULL_SCOPE_REQUIRED);
  if (ctx.restricted && !policy.scopeReady) return accessDenial(403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
  return null;
}
