// Pure view-model helpers of the Admin → Access pages (plan §15-§17, §24).
// No React: the pages and the tests share these.
//
// Everything here is UX only. The `access` Edge function and the SQL mutation
// RPCs re-check permission and anti-escalation on every call; the "block
// reasons" below only mirror those rules (202610050002_access_core.sql:
// assert_can_assign_role / assert_can_manage_member / access_update_role) so
// an admin is told up front why a control is locked instead of receiving a 403.

import { formatDistanceStrict } from "date-fns";
import type { AccessContextValue } from "@/contexts/accessContext";
import type { AccessSubject } from "@/services/accessRoutes";
import { ROUTE_ACCESS, checkAccessRule } from "@/services/accessRoutes";
import type {
  AdminFunnelOption,
  AdminFunnelScope,
  AdminMember,
  AdminRole,
  AuditEvent,
  EffectiveAccess,
  FunnelScopeMode,
} from "@/services/accessAdminClient";
import {
  getPermission,
  isPrivilegedPermission,
  type PermissionDef,
} from "../../../supabase/functions/_shared/access/permissions.ts";

// ---- permission catalog -----------------------------------------------------------------

/** Matrix group order and labels (plan §16: Analytics · Exports · Row details &
 * PII · Forecasting · Reports · AI · Administration). */
export const PERMISSION_AREA_ORDER = ["pages", "exports", "details", "forecasting", "reports", "ai", "admin"] as const;

export const PERMISSION_AREA_LABELS: Readonly<Record<string, string>> = Object.freeze({
  pages: "Analytics pages",
  exports: "Exports",
  details: "Row details & PII",
  forecasting: "Forecasting",
  reports: "Reports",
  ai: "AI",
  admin: "Administration",
});

export interface PermissionGroup {
  area: string;
  label: string;
  permissions: PermissionDef[];
}

function humanize(value: string): string {
  const spaced = value.replace(/[._]+/g, " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** Catalog entries grouped by area, in PERMISSION_AREA_ORDER (unknown areas last). */
export function groupPermissions(catalog: readonly PermissionDef[]): PermissionGroup[] {
  const byArea = new Map<string, PermissionDef[]>();
  for (const def of catalog) {
    const list = byArea.get(def.area) ?? [];
    list.push(def);
    byArea.set(def.area, list);
  }
  const areas = [
    ...PERMISSION_AREA_ORDER.filter((area) => byArea.has(area)),
    ...[...byArea.keys()].filter((area) => !(PERMISSION_AREA_ORDER as readonly string[]).includes(area)),
  ];
  return areas.map((area) => ({ area, label: PERMISSION_AREA_LABELS[area] ?? humanize(area), permissions: byArea.get(area) ?? [] }));
}

function catalogIndex(catalog: readonly PermissionDef[]): Map<string, PermissionDef> {
  return new Map(catalog.map((def) => [def.key, def]));
}

/** Keys in catalog order; keys the catalog does not know are dropped. */
export function inCatalogOrder(catalog: readonly PermissionDef[], keys: Iterable<string>): string[] {
  const set = new Set(keys);
  return catalog.filter((def) => set.has(def.key)).map((def) => def.key);
}

/** `key` plus everything it transitively requires (within the catalog). */
export function requirementClosure(catalog: readonly PermissionDef[], keys: Iterable<string>): Set<string> {
  const index = catalogIndex(catalog);
  const closed = new Set<string>();
  const pending = [...keys];
  while (pending.length) {
    const key = pending.pop() as string;
    if (closed.has(key) || !index.has(key)) continue;
    closed.add(key);
    for (const required of index.get(key)?.requires ?? []) pending.push(required);
  }
  return closed;
}

/** Keys that (transitively) require `key`. */
export function dependantsOf(catalog: readonly PermissionDef[], key: string): Set<string> {
  const dependants = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const def of catalog) {
      if (dependants.has(def.key)) continue;
      if (def.requires.some((required) => required === key || dependants.has(required))) {
        dependants.add(def.key);
        changed = true;
      }
    }
  }
  return dependants;
}

/** The role's permission set after (un)checking `key` (plan §16): checking
 * auto-checks everything it requires; unchecking cascades to every key that
 * depends on it. Result in catalog order; unknown keys are dropped (the server
 * would reject them). */
export function togglePermission(catalog: readonly PermissionDef[], current: readonly string[], key: string, checked: boolean): string[] {
  const next = new Set(current);
  if (checked) {
    for (const required of requirementClosure(catalog, [key])) next.add(required);
  } else {
    next.delete(key);
    for (const dependant of dependantsOf(catalog, key)) next.delete(dependant);
  }
  return inCatalogOrder(catalog, next);
}

export function diffKeys(before: readonly string[], after: readonly string[]): { added: string[]; removed: string[] } {
  const was = new Set(before);
  const now = new Set(after);
  return {
    added: [...new Set(after)].filter((key) => !was.has(key)),
    removed: [...new Set(before)].filter((key) => !now.has(key)),
  };
}

export function sameKeySet(a: readonly string[], b: readonly string[]): boolean {
  const { added, removed } = diffKeys(a, b);
  return added.length === 0 && removed.length === 0;
}

export function permissionLabel(key: string, catalog?: readonly PermissionDef[]): string {
  return catalog?.find((def) => def.key === key)?.label ?? getPermission(key)?.label ?? key;
}

/** Owner, or any admin.* / funnels.manage / api_export.use key (D10). */
export function isPrivilegedRole(role: Pick<AdminRole, "is_owner" | "permissions"> | null | undefined): boolean {
  return Boolean(role && (role.is_owner || role.permissions.some((key) => isPrivilegedPermission(key))));
}

// ---- the acting admin ----------------------------------------------------------------------

export interface AdminActor {
  userId: string | null;
  memberId: string | null;
  roleId: string | null;
  isOwner: boolean;
  /** The actor's effective permissions. */
  permissions: ReadonlySet<string>;
}

export function actorFromAccess(access: Pick<AccessContextValue, "access" | "permissions">): AdminActor {
  return {
    userId: access.access?.user_id ?? null,
    memberId: access.access?.member_id ?? null,
    roleId: access.access?.role?.id ?? null,
    isOwner: access.access?.role?.is_owner === true,
    permissions: access.permissions,
  };
}

const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

function holdsAll(actor: AdminActor, keys: readonly string[]): boolean {
  return actor.isOwner || keys.every((key) => actor.permissions.has(key));
}

/** Why the actor may not give `role` to a member, or null (assert_can_assign_role). */
export function roleAssignBlockReason(role: AdminRole, actor: AdminActor): string | null {
  if (isPrivilegedRole(role) && !actor.isOwner) return "Only the Owner can assign roles with admin permissions.";
  if (!holdsAll(actor, role.permissions)) return "This role has permissions you do not hold.";
  return null;
}

export function isSelfMember(member: Pick<AdminMember, "id" | "user_id">, actor: AdminActor): boolean {
  return sameId(member.user_id, actor.userId) || sameId(member.id, actor.memberId);
}

/** Why the actor may not change this membership at all, or null (assert_can_manage_member). */
export function memberEditBlockReason(member: AdminMember, memberRole: AdminRole | null | undefined, actor: AdminActor): string | null {
  if (isSelfMember(member, actor)) return "You cannot change your own membership.";
  if (member.is_data_owner) return "The data owner's membership is fixed: Owner role, active, all funnels.";
  if ((member.role.is_owner || isPrivilegedRole(memberRole)) && !actor.isOwner) {
    return "Only the Owner can change members with admin permissions.";
  }
  if (memberRole && !holdsAll(actor, memberRole.permissions)) return "This member has permissions you do not hold.";
  return null;
}

/** Why the actor may not edit `role`, or null (access_update_role). */
export function roleEditBlockReason(role: AdminRole, actor: AdminActor): string | null {
  if (role.is_owner) return "The Owner role always has every permission and cannot be edited.";
  if (sameId(role.id, actor.roleId)) return "You cannot edit the role assigned to yourself.";
  if (isPrivilegedRole(role) && !actor.isOwner) return "Only the Owner can edit roles with admin permissions.";
  if (!holdsAll(actor, role.permissions)) return "This role has permissions you do not hold.";
  return null;
}

/** Why one catalog key cannot be granted by the actor, or null. */
export function permissionGrantBlockReason(def: PermissionDef, actor: AdminActor): string | null {
  if (def.status !== "enforced") return "Coming soon: not enforced yet.";
  if (def.requiresFullScope && !actor.isOwner) return "Only the Owner can grant admin permissions.";
  if (!actor.isOwner && !actor.permissions.has(def.key)) return "You cannot grant a permission you do not hold.";
  return null;
}

/** The part of `keys` the actor can put into a role: grantable keys whose
 * requirements are all kept too (a key losing a prerequisite is dropped, to a
 * fixed point). Used to seed "Duplicate" and template-based drafts. */
export function grantableSubset(catalog: readonly PermissionDef[], keys: readonly string[], actor: AdminActor): string[] {
  const index = catalogIndex(catalog);
  const kept = new Set(keys.filter((key) => {
    const def = index.get(key);
    return Boolean(def) && !permissionGrantBlockReason(def as PermissionDef, actor);
  }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...kept]) {
      if ((index.get(key)?.requires ?? []).some((required) => !kept.has(required))) {
        kept.delete(key);
        changed = true;
      }
    }
  }
  return inCatalogOrder(catalog, kept);
}

/** Why the role cannot be deleted, or null (access_delete_role). */
export function roleDeleteBlockReason(role: AdminRole, actor: AdminActor): string | null {
  if (role.is_owner || role.is_system) return "System roles cannot be deleted.";
  if (role.member_count === null) return "The member count is unknown; refresh and try again.";
  if (role.member_count > 0) {
    return `Assigned to ${role.member_count} member${role.member_count === 1 ? "" : "s"}. Move them to another role first.`;
  }
  if (isPrivilegedRole(role) && !actor.isOwner) return "Only the Owner can delete roles with admin permissions.";
  if (!holdsAll(actor, role.permissions)) return "This role has permissions you do not hold.";
  return null;
}

/** A sensible starting role for "Add member": Viewer when assignable, else the
 * first assignable non-admin role, else "" (the admin must pick). */
export function defaultRoleId(roles: readonly AdminRole[], actor: AdminActor): string {
  const assignable = roles.filter((role) => !role.is_owner && !roleAssignBlockReason(role, actor));
  const preferred = assignable.find((role) => role.key === "viewer") ?? assignable.find((role) => !isPrivilegedRole(role)) ?? null;
  return preferred?.id ?? "";
}

// ---- members --------------------------------------------------------------------------------

export function memberDisplayName(member: Pick<AdminMember, "display_name" | "email">): string {
  return member.display_name.trim() || member.email || "Unnamed member";
}

/** "5 minutes ago" / "Never". */
export function formatLastActive(value: string | null, now: Date = new Date()): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDistanceStrict(date, now, { addSuffix: true });
}

// ---- funnel scope ---------------------------------------------------------------------------

/** Members table "Funnels" column (plan §15). */
export function funnelScopeLabel(scope: AdminFunnelScope): string {
  if (scope.mode === "all") return "All funnels";
  if (scope.mode === "none") return "No data";
  const count = scope.funnel_ids.length;
  return `${count} funnel${count === 1 ? "" : "s"}`;
}

export function sameScope(a: AdminFunnelScope, b: AdminFunnelScope): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode !== "selected") return true;
  return sameKeySet(a.funnel_ids.map((id) => id.toLowerCase()), b.funnel_ids.map((id) => id.toLowerCase()));
}

/** Funnel ids carrying `tag` right now. "Select by tag" expands to these
 * explicit ids; tags are never dynamic grants (plan §17). */
export function funnelIdsWithTag(funnels: readonly AdminFunnelOption[], tag: string): string[] {
  return funnels.filter((funnel) => funnel.tags.includes(tag)).map((funnel) => funnel.id);
}

export function funnelTagCounts(funnels: readonly AdminFunnelOption[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const funnel of funnels) {
    for (const tag of new Set(funnel.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => a.tag.localeCompare(b.tag));
}

export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

export function funnelOptionLabel(funnel: AdminFunnelOption | undefined, id: string): string {
  if (!funnel) return `Unknown funnel ${shortId(id)}`;
  return funnel.display_name.trim() || funnel.funnel_path || shortId(id);
}

/** "/soulmate-sketch" → "soulmate-sketch" (the path form the audit lines use). */
export function funnelPathLabel(funnel: AdminFunnelOption | undefined, id: string): string {
  const path = funnel?.funnel_path.trim().replace(/^\/+/, "");
  return path || funnel?.display_name.trim() || shortId(id);
}

// ---- member save plan --------------------------------------------------------------------

export interface MemberDraft {
  roleId: string;
  displayName: string;
  scope: AdminFunnelScope;
}

export type MemberSaveStep =
  | { kind: "update"; role_id?: string; display_name?: string }
  | { kind: "scope"; mode: FunnelScopeMode; funnel_ids: string[] };

/** The calls that turn `member` into `draft`, in a server-acceptable order:
 * a role with admin permissions requires funnel scope "all" before it is
 * assigned, and a restricted scope is refused while such a role is held — so
 * when the draft scope is "all" the scope goes first, otherwise the role does. */
export function planMemberSave(member: AdminMember, draft: MemberDraft): MemberSaveStep[] {
  const update: { kind: "update"; role_id?: string; display_name?: string } = { kind: "update" };
  if (draft.roleId && !sameId(draft.roleId, member.role.id)) update.role_id = draft.roleId;
  const name = draft.displayName.trim();
  if (name !== member.display_name.trim()) update.display_name = name;
  const steps: MemberSaveStep[] = [];
  const hasUpdate = update.role_id !== undefined || update.display_name !== undefined;
  const scopeStep: MemberSaveStep | null = sameScope(member.funnel_scope, draft.scope)
    ? null
    : { kind: "scope", mode: draft.scope.mode, funnel_ids: draft.scope.mode === "selected" ? [...draft.scope.funnel_ids] : [] };
  if (scopeStep && draft.scope.mode === "all") steps.push(scopeStep);
  if (hasUpdate) steps.push(update);
  if (scopeStep && draft.scope.mode !== "all") steps.push(scopeStep);
  return steps;
}

// ---- effective access preview ---------------------------------------------------------------

export const PAGE_TITLES: Readonly<Record<string, string>> = Object.freeze({
  "/": "Dashboard",
  "/transactions": "Transactions",
  "/users": "Users",
  "/leads": "Leads",
  "/cohorts": "Cohorts",
  "/funnels": "Funnels",
  "/reports": "Reports",
  "/fb-analytics": "FB-Analytics",
  "/integrations": "Integrations",
  "/support": "Support",
  "/forecasting": "Forecasting",
  "/subscriptions": "Subscriptions",
  "/import": "Import data",
  "/admin/members": "Members",
  "/admin/roles": "Roles",
  "/admin/audit": "Audit log",
});

export interface PagePreview {
  path: string;
  title: string;
  group: "workspace" | "admin";
  allowed: boolean;
}

/** An AccessSubject over a member's server-computed effective access, so the
 * preview runs the SAME route rules (ROUTE_ACCESS + checkAccessRule) as the
 * member's own sidebar and route guards. */
export function effectiveAccessSubject(effective: Pick<EffectiveAccess, "status" | "permissions" | "raw_access">): AccessSubject {
  const permissions = new Set(effective.permissions);
  const active = effective.status === "active";
  const can = (key: string) => active && permissions.has(key);
  return {
    status: active ? "ok" : "disabled",
    legacy: false,
    rawAccess: active && effective.raw_access,
    can,
    canAny: (keys: readonly string[]) => Array.isArray(keys) && keys.some((key) => can(key)),
  };
}

/** Every ROUTE_ACCESS page with whether the member may open it. */
export function previewPages(effective: Pick<EffectiveAccess, "status" | "permissions" | "raw_access">): PagePreview[] {
  const subject = effectiveAccessSubject(effective);
  return ROUTE_ACCESS.map((rule) => ({
    path: rule.path,
    title: PAGE_TITLES[rule.path] ?? rule.path,
    group: rule.path.startsWith("/admin/") ? "admin" : "workspace",
    allowed: checkAccessRule(rule, subject),
  }));
}

export interface CapabilitySummary {
  exports: string[];
  pii: string[];
  ai: boolean;
  admin: string[];
}

/** Capability badges (plan §15: export / PII / AI / admin) from effective keys. */
export function capabilitySummary(permissions: readonly string[], catalog?: readonly PermissionDef[]): CapabilitySummary {
  const index = catalog ? catalogIndex(catalog) : null;
  const defOf = (key: string) => index?.get(key) ?? getPermission(key);
  const summary: CapabilitySummary = { exports: [], pii: [], ai: false, admin: [] };
  for (const key of permissions) {
    const def = defOf(key);
    if (!def) continue;
    if (def.sensitive === "export") summary.exports.push(key);
    if (def.sensitive === "pii") summary.pii.push(key);
    if (def.requiresFullScope || def.area === "admin") summary.admin.push(key);
  }
  summary.ai = permissions.includes("ai.use");
  return summary;
}

// ---- audit ------------------------------------------------------------------------------

export const AUDIT_EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "member.added": "Member added",
  "member.updated": "Member updated",
  "member.disabled": "Member disabled",
  "member.enabled": "Member enabled",
  "role.created": "Role created",
  "role.updated": "Role updated",
  "role.deleted": "Role deleted",
  "scope.updated": "Funnel access changed",
  "admin_access.granted": "Admin access granted",
  "admin_access.revoked": "Admin access revoked",
  "api_key.minted": "API key created",
  "api_key.revoked": "API key revoked",
  "export.performed": "Export",
  "sync.triggered": "Sync started",
  "warehouse.admin": "Warehouse operation",
  "registry.changed": "Funnel registry changed",
  "bootstrap.completed": "Workspace set up",
  "owner.recovered": "Owner recovered",
});

/** Event filter of the audit page: namespaces (the API matches `ns.%`). */
export const AUDIT_EVENT_FILTERS: ReadonlyArray<{ value: string; label: string }> = Object.freeze([
  { value: "member", label: "Members" },
  { value: "role", label: "Roles" },
  { value: "scope", label: "Funnel access" },
  { value: "admin_access", label: "Admin access" },
  { value: "api_key", label: "API keys" },
  { value: "export", label: "Exports" },
  { value: "sync", label: "Syncs" },
  { value: "warehouse", label: "Warehouse" },
  { value: "registry", label: "Funnel registry" },
  { value: "bootstrap", label: "Setup" },
]);

export function auditEventLabel(event: string): string {
  return AUDIT_EVENT_LABELS[event] ?? humanize(event);
}

export interface AuditLookups {
  funnelLabel: (id: string) => string;
  roleLabel: (id: string | null, key: string | null) => string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** "a, b, c +2 more". */
export function listText(items: readonly string[], max = 5): string {
  if (items.length <= max) return items.join(", ");
  return `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

function scopeFromSnapshot(snapshot: Record<string, unknown> | null): AdminFunnelScope | null {
  if (!snapshot) return null;
  // Member snapshots nest the scope; scope.updated rows carry it directly.
  const scope = record(snapshot.funnel_scope) ?? (typeof snapshot.mode === "string" ? snapshot : null);
  if (!scope) return null;
  const mode: FunnelScopeMode = scope.mode === "all" || scope.mode === "selected" ? scope.mode : "none";
  return { mode, funnel_ids: mode === "selected" ? strings(scope.funnel_ids) : [] };
}

function scopeText(scope: AdminFunnelScope, lookups: AuditLookups): string {
  if (scope.mode === "all") return "All funnels";
  if (scope.mode === "none") return "No data";
  if (!scope.funnel_ids.length) return "no funnels";
  return scope.funnel_ids.length <= 3
    ? scope.funnel_ids.map(lookups.funnelLabel).join(", ")
    : `${scope.funnel_ids.length} funnels`;
}

function signedList(added: string[], removed: string[]): string {
  const parts: string[] = [];
  if (added.length) parts.push(`+ ${listText(added, 6)}`);
  if (removed.length) parts.push(`− ${listText(removed, 6)}`);
  return parts.join(" ");
}

function describeScopeChange(before: AdminFunnelScope | null, after: AdminFunnelScope | null, lookups: AuditLookups): string | null {
  if (!after) return null;
  if (!before) return `Funnels: ${after.mode === "selected" ? listText(after.funnel_ids.map(lookups.funnelLabel)) || "no funnels" : scopeText(after, lookups)}`;
  if (before.mode === "selected" && after.mode === "selected") {
    const { added, removed } = diffKeys(before.funnel_ids, after.funnel_ids);
    if (!added.length && !removed.length) return null;
    return `Funnels: ${signedList(added.map(lookups.funnelLabel), removed.map(lookups.funnelLabel))}`;
  }
  if (before.mode === after.mode) return null;
  return `Funnels: ${scopeText(before, lookups)} → ${scopeText(after, lookups)}`;
}

/** Human-readable change lines of one audit row (plan §24), e.g.
 * "Funnels: + soulmate-sketch − past-life", "Permissions: + cohorts.export". */
export function describeAuditChanges(event: Pick<AuditEvent, "event" | "before" | "after" | "context">, lookups: AuditLookups): string[] {
  const before = record(event.before);
  const after = record(event.after);
  const context = record(event.context);
  const lines: string[] = [];
  const isRole = Array.isArray(before?.permissions) || Array.isArray(after?.permissions) || event.event.startsWith("role.");

  if (isRole) {
    if (before && after) {
      const nameBefore = str(before.name);
      const nameAfter = str(after.name);
      if (nameBefore && nameAfter && nameBefore !== nameAfter) lines.push(`Name: ${nameBefore} → ${nameAfter}`);
      if ((str(before.description) ?? "") !== (str(after.description) ?? "")) lines.push("Description updated");
      const added = context && Array.isArray(context.added_permissions)
        ? strings(context.added_permissions)
        : diffKeys(strings(before.permissions), strings(after.permissions)).added;
      const removed = context && Array.isArray(context.removed_permissions)
        ? strings(context.removed_permissions)
        : diffKeys(strings(before.permissions), strings(after.permissions)).removed;
      if (added.length || removed.length) lines.push(`Permissions: ${signedList(added, removed)}`);
    } else if (after) {
      const keys = strings(after.permissions);
      lines.push(keys.length ? `Permissions: ${listText(keys, 6)}` : "Permissions: none");
    } else if (before) {
      const keys = strings(before.permissions);
      lines.push(`Had ${keys.length} permission${keys.length === 1 ? "" : "s"}`);
    }
    return lines;
  }

  const scopeLine = describeScopeChange(scopeFromSnapshot(before), scopeFromSnapshot(after), lookups);

  // Member snapshots (member.* / admin_access.*): role, status, name.
  const isMember = Boolean(str(after?.member_id) || str(before?.member_id) || str(after?.role_id) || str(before?.role_id));
  if (isMember) {
    const roleBefore = before ? lookups.roleLabel(str(before.role_id), str(before.role_key)) : null;
    const roleAfter = after ? lookups.roleLabel(str(after.role_id), str(after.role_key)) : null;
    if (!before && roleAfter) lines.push(`Role: ${roleAfter}`);
    else if (before && after && (str(before.role_id) ?? str(before.role_key)) !== (str(after.role_id) ?? str(after.role_key))) {
      lines.push(`Role: ${roleBefore} → ${roleAfter}`);
    }
    const statusBefore = str(before?.status);
    const statusAfter = str(after?.status);
    if (statusBefore && statusAfter && statusBefore !== statusAfter) lines.push(`Status: ${statusBefore} → ${statusAfter}`);
    const nameBefore = typeof before?.display_name === "string" ? before.display_name : null;
    const nameAfter = typeof after?.display_name === "string" ? after.display_name : null;
    if (before && after && nameBefore !== null && nameAfter !== null && nameBefore !== nameAfter) {
      lines.push(`Name: ${nameBefore || "—"} → ${nameAfter || "—"}`);
    }
  }
  if (scopeLine) lines.push(scopeLine);
  if (lines.length) return lines;

  // Anything else (sync, warehouse, exports, ...): changed top-level scalars.
  if (before || after) {
    const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
    for (const key of keys) {
      const a = before?.[key];
      const b = after?.[key];
      const scalar = (value: unknown) => value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value);
      if (!scalar(a) || !scalar(b) || a === b) continue;
      if (a === undefined || a === null) lines.push(`${humanize(key)}: ${String(b)}`);
      else if (b === undefined || b === null) lines.push(`${humanize(key)}: ${String(a)} → —`);
      else lines.push(`${humanize(key)}: ${String(a)} → ${String(b)}`);
      if (lines.length >= 4) break;
    }
  }
  return lines;
}

export function auditActorLabel(event: Pick<AuditEvent, "actor_email" | "actor_kind" | "actor_user_id">): string {
  if (event.actor_email) return event.actor_email;
  if (event.actor_kind === "cron") return "Scheduled job";
  if (event.actor_kind === "api_key") return "API key";
  if (event.actor_kind === "system") return "System";
  if (event.actor_user_id) return `User ${shortId(event.actor_user_id)}`;
  return event.actor_kind ? humanize(event.actor_kind) : "—";
}

export function auditTargetLabel(event: Pick<AuditEvent, "target_label" | "target_type" | "target_id">): string {
  if (event.target_label) return event.target_label;
  if (event.target_type && event.target_id) return `${humanize(event.target_type)} ${shortId(event.target_id)}`;
  return event.target_type ? humanize(event.target_type) : "—";
}
