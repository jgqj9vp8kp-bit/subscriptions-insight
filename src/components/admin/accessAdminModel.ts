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
import { ROUTE_ACCESS, accessRuleDenial } from "@/services/accessRoutes";
import type {
  AdminFunnelOption,
  AdminFunnelPath,
  AdminFunnelScope,
  AdminMember,
  AdminRole,
  AuditEvent,
  EffectiveAccess,
  FunnelCoverage,
  FunnelCoveragePath,
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

/** Statuses that grant access (app.funnel_scope_paths): active ∪ retired. */
export function isGrantedPathStatus(status: AdminFunnelPath["status"] | null | undefined): boolean {
  return status === "active" || status === "retired";
}

/** The funnel's granted paths, active first then retired, by path. */
export function grantedPaths(funnel: Pick<AdminFunnelOption, "paths"> | undefined): AdminFunnelPath[] {
  return (funnel?.paths ?? [])
    .filter((entry) => isGrantedPathStatus(entry.status))
    .sort((a, b) => (a.status === b.status ? a.path.localeCompare(b.path) : a.status === "active" ? -1 : 1));
}

/** Browser mirror of app.canonical_campaign_path (rule A, non-URL branch plus
 * scheme/host strip): "/Soulmate-Sketch?x=1" → "soulmate-sketch"; null when
 * nothing canonical is left. UX only (which registry path is a funnel's own). */
export function canonicalCampaignPath(raw: string | null | undefined): string | null {
  const lowered = String(raw ?? "").replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase().replace(/^https?:\/\/[^/]+/, "");
  const bare = lowered.split("?", 1)[0].split("#", 1)[0].replace(/^\/+|\/+$/g, "");
  const path = bare.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return path === "" || path === "unknown" || path.length > 200 ? null : path;
}

/** The path that is the funnel's own funnel_path: the server refuses to retire
 * or revoke it ("edit the funnel's path instead"). */
export function isPrimaryFunnelPath(funnel: Pick<AdminFunnelOption, "funnel_path"> | undefined, path: string): boolean {
  return Boolean(funnel) && canonicalCampaignPath(funnel?.funnel_path) === path;
}

/** Active members whose selected scope holds `funnelId` (who start seeing a
 * path attached to that funnel). */
export function membersHoldingFunnel(members: readonly AdminMember[], funnelId: string): number {
  const key = funnelId.toLowerCase();
  return members.filter(
    (member) =>
      member.status === "active" &&
      member.funnel_scope.mode === "selected" &&
      member.funnel_scope.funnel_ids.some((id) => id.toLowerCase() === key),
  ).length;
}

// ---- coverage and scope impact ------------------------------------------------------------

/** "12,345". */
export function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

/** "$12,345" / "-$80" (whole dollars). */
export function formatUsd(value: number): string {
  const rounded = Math.round(value);
  return `${rounded < 0 ? "-" : ""}$${Math.abs(rounded).toLocaleString("en-US")}`;
}

/** Share in percent, floored to one decimal so a partial share never reads as
 * 100% ("<0.1%" for a tiny non-zero one); "—" without a denominator. */
export function formatPct(part: number, whole: number): string {
  if (!(whole > 0)) return "—";
  const pct = Math.floor((part / whole) * 1000) / 10;
  if (part > 0 && pct < 0.1) return "<0.1%";
  return `${Math.max(0, pct)}%`;
}

export interface ScopeImpact {
  /** Selected funnels (ids the registry may or may not know). */
  funnels: number;
  /** Distinct granted paths of the selected funnels, and how many are retired. */
  paths: number;
  retiredPaths: number;
  /** Null until coverage is loaded. */
  users: number | null;
  usersPct: string | null;
  netRevenue: number | null;
  netPct: string | null;
  /** Selected funnels whose granted paths hold no user of the snapshot. */
  funnelsWithoutData: Array<{ id: string; label: string }>;
  /** Snapshot paths no funnel holds (unregistered, proposed or unscopable):
   * invisible to every funnel-restricted member. */
  unregisteredPaths: number | null;
  unregisteredUsersPct: string | null;
}

/** What a selected-funnels scope would show the member (plan §17 "Impact
 * preview"): registry paths come from the funnel list, users and net revenue
 * from the coverage of the active snapshot. Pure. */
export function computeScopeImpact(
  scope: AdminFunnelScope,
  funnels: readonly AdminFunnelOption[],
  coverage: FunnelCoverage | null | undefined,
): ScopeImpact {
  const ids = scope.mode === "selected" ? [...new Set(scope.funnel_ids.map((id) => id.toLowerCase()))] : [];
  const byId = new Map(funnels.map((funnel) => [funnel.id.toLowerCase(), funnel]));
  const granted = new Map<string, AdminFunnelPath["status"]>();
  for (const id of ids) {
    for (const entry of grantedPaths(byId.get(id))) {
      if (granted.get(entry.path) !== "active") granted.set(entry.path, entry.status);
    }
  }
  const impact: ScopeImpact = {
    funnels: ids.length,
    paths: granted.size,
    retiredPaths: [...granted.values()].filter((status) => status === "retired").length,
    users: null,
    usersPct: null,
    netRevenue: null,
    netPct: null,
    funnelsWithoutData: [],
    unregisteredPaths: null,
    unregisteredUsersPct: null,
  };
  if (!coverage) return impact;

  const coverageByFunnel = new Map(coverage.funnels.map((entry) => [entry.funnel_id.toLowerCase(), entry]));
  let users = 0;
  let net = 0;
  for (const id of ids) {
    const entry = coverageByFunnel.get(id);
    users += entry?.users ?? 0;
    net += entry?.net_revenue ?? 0;
    if (!entry || entry.users <= 0) impact.funnelsWithoutData.push({ id, label: funnelOptionLabel(byId.get(id), id) });
  }
  const unregistered = coverage.paths.filter((row) => row.state !== "granted");
  const unregisteredUsers = unregistered.reduce((sum, row) => sum + row.users, 0);
  return {
    ...impact,
    users,
    usersPct: formatPct(users, coverage.totals.users),
    netRevenue: net,
    netPct: formatPct(net, coverage.totals.net_revenue),
    unregisteredPaths: unregistered.length,
    unregisteredUsersPct: formatPct(unregisteredUsers, coverage.totals.users),
  };
}

/** A selected-funnels scope none of whose funnels has a user in the snapshot:
 * the member sees no data at all (members table warning). False without
 * coverage or for any other mode. */
export function scopeWithoutData(scope: AdminFunnelScope, coverage: FunnelCoverage | null | undefined): boolean {
  if (!coverage || scope.mode !== "selected") return false;
  const users = new Map(coverage.funnels.map((entry) => [entry.funnel_id.toLowerCase(), entry.users]));
  return scope.funnel_ids.every((id) => (users.get(id.toLowerCase()) ?? 0) <= 0);
}

/** "3 funnels · 4 paths (1 retired) · 1,234 users (8.3%) · $56,789 net (9.1%)". */
export function scopeImpactSummary(impact: ScopeImpact): string {
  const parts = [
    `${impact.funnels} funnel${impact.funnels === 1 ? "" : "s"}`,
    `${impact.paths} path${impact.paths === 1 ? "" : "s"}${impact.retiredPaths ? ` (${impact.retiredPaths} retired)` : ""}`,
  ];
  if (impact.users !== null) parts.push(`${formatCount(impact.users)} user${impact.users === 1 ? "" : "s"} (${impact.usersPct})`);
  if (impact.netRevenue !== null) parts.push(`${formatUsd(impact.netRevenue)} net (${impact.netPct})`);
  return parts.join(" · ");
}

/** Confirmation line of a path grant change:
 *   add    → "+1,234 users / +$5,678 into Soulmate Sketch; 2 members holding it will see this data"
 *   remove → "−1,234 users / −$5,678 from Soulmate Sketch; 2 members holding it will lose this data"
 * `members` null (the admin cannot list members) leaves the count out. */
export function pathImpactText(
  direction: "add" | "remove",
  row: Pick<FunnelCoveragePath, "users" | "net_revenue">,
  funnelLabel: string,
  members: number | null,
): string {
  const users = `${direction === "add" ? "+" : "−"}${formatCount(row.users)} users`;
  // Net revenue can be negative (refunds): sign the change, not the label.
  const delta = direction === "add" ? row.net_revenue : -row.net_revenue;
  const money = delta < 0 || (delta === 0 && direction === "remove") ? `−${formatUsd(Math.abs(delta))}` : `+${formatUsd(delta)}`;
  const holders = members === null ? "members holding it" : `${members} member${members === 1 ? "" : "s"} holding it`;
  const verb = direction === "add" ? "will see this data" : "will lose this data";
  return `${users} / ${money} ${direction === "add" ? "into" : "from"} ${funnelLabel}; ${holders} ${verb}`;
}

export const COVERAGE_STATE_LABELS: Readonly<Record<FunnelCoveragePath["state"], string>> = Object.freeze({
  granted: "Granted",
  proposed: "Proposed",
  unregistered: "Unregistered",
  unscopable: "Unscopable",
});

/** The path-row write actions an admin with funnels.manage may take (the
 * server re-checks every transition, §2.1 §9):
 *   unregistered / proposed → attach to a funnel;
 *   each proposal           → confirm (active) unless another funnel holds
 *                             the path, reject (revoked) always;
 *   granted active          → retire, revoke; granted retired → reactivate,
 *                             revoke — never for the funnel's own path. */
export interface CoveragePathActions {
  attach: boolean;
  proposals: Array<{ path_id: string; funnel_id: string; canConfirm: boolean }>;
  retire: boolean;
  reactivate: boolean;
  revoke: boolean;
  /** Why retire / revoke are not offered on a granted path, else null. */
  lockedReason: string | null;
}

export function coveragePathActions(row: FunnelCoveragePath, funnels: readonly AdminFunnelOption[]): CoveragePathActions {
  const granted = row.state === "granted";
  const holder = granted && row.funnel_id ? funnels.find((funnel) => funnel.id.toLowerCase() === row.funnel_id?.toLowerCase()) : undefined;
  const primary = granted && isPrimaryFunnelPath(holder, row.path);
  const editable = granted && Boolean(row.path_id) && !primary;
  return {
    attach: row.state === "unregistered" || row.state === "proposed",
    proposals: row.state === "unscopable" ? [] : row.proposals.map((proposal) => ({ ...proposal, canConfirm: !granted })),
    retire: editable && row.path_status === "active",
    reactivate: editable && row.path_status === "retired",
    revoke: editable,
    lockedReason: primary ? "This is the funnel's own path: edit the funnel's path on the Funnels page instead." : null,
  };
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
  "/admin/funnels": "Funnel coverage",
});

export interface PagePreview {
  path: string;
  title: string;
  group: "workspace" | "admin";
  allowed: boolean;
  /** Why the page is hidden (accessRuleDenial), null when allowed: a missing
   * permission, data-owner only, or not open with funnel-restricted access. */
  denial: "permission" | "raw" | "scope" | null;
}

type EffectiveSubjectInput = Pick<EffectiveAccess, "status" | "permissions" | "raw_access"> & {
  funnel_scope: Pick<EffectiveAccess["funnel_scope"], "mode">;
};

/** An AccessSubject over a member's server-computed effective access, so the
 * preview runs the SAME route rules (ROUTE_ACCESS + accessRuleDenial) as the
 * member's own sidebar and route guards. Restricted = any scope but "all"
 * (selected funnels or no data access), as the member's own access value. */
export function effectiveAccessSubject(effective: EffectiveSubjectInput): AccessSubject {
  const permissions = new Set(effective.permissions);
  const active = effective.status === "active";
  const can = (key: string) => active && permissions.has(key);
  const subject: AccessSubject = {
    status: active ? "ok" : "disabled",
    legacy: false,
    rawAccess: active && effective.raw_access,
    restricted: effective.funnel_scope.mode !== "all",
    can,
    canAny: (keys: readonly string[]) => Array.isArray(keys) && keys.some((key) => can(key)),
  };
  return subject;
}

/** Every ROUTE_ACCESS page with whether the member may open it, and why not. */
export function previewPages(effective: EffectiveSubjectInput): PagePreview[] {
  const subject = effectiveAccessSubject(effective);
  return ROUTE_ACCESS.map((rule) => {
    const denial = accessRuleDenial(rule, subject);
    return {
      path: rule.path,
      title: PAGE_TITLES[rule.path] ?? rule.path,
      group: rule.path.startsWith("/admin/") ? "admin" : "workspace",
      allowed: denial === null,
      denial,
    };
  });
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
  "registry.path_registered": "Funnel path registered",
  "registry.path_repathed": "Funnel re-pathed",
  "registry.path_attached": "Funnel path attached",
  "registry.path_confirmed": "Funnel path confirmed",
  "registry.path_rejected": "Funnel path proposal rejected",
  "registry.path_retired": "Funnel path retired",
  "registry.path_reactivated": "Funnel path reactivated",
  "registry.path_revoked": "Funnel path revoked",
  "registry.paths_seeded": "Funnel paths seeded",
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
