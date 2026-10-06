// Access admin API (plan §15-§17, §24; SHARED CONTRACT A): the pure core of the
// `access` Edge function. By the time anything here runs, the gate
// (policies/access.ts) has authenticated the caller, resolved their membership
// and checked the action's admin.* permission. This module validates input,
// calls the SECURITY DEFINER mutation RPCs of 202610050002_access_core.sql
// (they re-resolve the actor inside the transaction under the workspace lock,
// enforce permission + anti-escalation, and write the audit row), and shapes
// the reads.
//
// Rules this module keeps:
//   * p_actor is ctx.actor.userId (the caller), never ctx.tenantKey.
//   * Role permission arrays are validated against the code catalog
//     (validateRolePermissions) BEFORE any RPC; SQL only checks their shape.
//     The stored set is the catalog-normalized one (closed under `requires`).
//   * SQL errors "<code>: <detail>" map to HTTP: permission_denied /
//     escalation_denied → 403, not_found → 404, invalid → 400, conflict and
//     SQLSTATE 23505 → 409. Those messages are written for admins and are
//     returned as is (a Response, so the gate does not replace them). Any other
//     failure is thrown: the gate logs it and sanitizes the body for everyone
//     but the data owner.
//   * Reads use the service-role client (RLS bypassed) and are always filtered
//     to ctx.workspaceId. workspaces.data_key is never selected, and audit JSON
//     is scrubbed of any `data_key` property.
//   * Disabling a member also bans the auth user (refresh tokens stop working);
//     enabling lifts the ban. Both run only AFTER the RPC accepted the change,
//     so the SQL anti-escalation rules decide who can be banned.
//
// Dependency-injected (AccessAdminStore) so vitest drives it without Supabase;
// createSupabaseAccessAdminStore adapts the live service-role client. No Deno
// globals and no remote imports.

import type { AccessHandler } from "./gate.ts";
import { isUuid, type AccessContext } from "./accessContext.ts";
import { ACCESS_ERROR } from "./errors.ts";
import {
  ENFORCED_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  effectivePermissions,
  validateRolePermissions,
  type PermissionDef,
} from "./permissions.ts";
import { ROLE_TEMPLATES, type RoleTemplate } from "./roles.ts";
import { canonicalFunnelIds } from "./scope.ts";
import type { AccessAdminAction } from "./policies/access.ts";
import type { SupabaseAuthClient } from "../clickhouse/types.ts";

/** GoTrue ban while a member is disabled (~100 years); "none" lifts it. */
export const DISABLED_MEMBER_BAN_DURATION = "876000h";
export const LIFTED_BAN_DURATION = "none";

export const AUDIT_PAGE_DEFAULT = 50;
export const AUDIT_PAGE_MAX = 200;

const MAX_FUNNEL_IDS = 1000;
const MAX_EMAIL_LENGTH = 320;
const MAX_DISPLAY_NAME = 120;
const MAX_ROLE_NAME = 80;
const MAX_ROLE_DESCRIPTION = 500;
const ROLE_KEY_RE = /^[a-z][a-z0-9_]{1,40}$/;
/** A full dotted event ("member.added") or a namespace ("member" ⇒ "member.*"). */
const AUDIT_EVENT_FILTER_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const AUDIT_OUTCOMES = ["success", "denied", "error"] as const;

// ---- errors ---------------------------------------------------------------------------

export type AccessAdminErrorCode = "invalid" | "permission_denied" | "escalation_denied" | "not_found" | "conflict";

const ERROR_STATUS: Readonly<Record<AccessAdminErrorCode, number>> = Object.freeze({
  invalid: 400,
  permission_denied: 403,
  escalation_denied: 403,
  not_found: 404,
  conflict: 409,
});

const ERROR_DEFAULT_MESSAGE: Readonly<Record<AccessAdminErrorCode, string>> = Object.freeze({
  invalid: "The request is invalid.",
  permission_denied: "You do not have permission for this action.",
  escalation_denied: "This change would grant access beyond your own.",
  not_found: "Not found.",
  conflict: "The change conflicts with the current state.",
});

/** An expected, admin-facing refusal: Edge input validation or a mapped SQL
 * error. Rendered as { ok: false, error_code, error, request_id, errors? }. */
export class AccessAdminError extends Error {
  readonly code: AccessAdminErrorCode;
  readonly status: number;
  /** Per-item reasons (e.g. validateRolePermissions errors). */
  readonly details: string[];

  constructor(code: AccessAdminErrorCode, message: string = ERROR_DEFAULT_MESSAGE[code], details: string[] = []) {
    super(message);
    this.name = "AccessAdminError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

/** A read or RPC transport fault (PostgREST error, network, malformed result):
 * 503 access_service_error, retry later. */
export class AccessAdminStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessAdminStoreError";
  }
}

const invalid = (message: string, details?: string[]) => new AccessAdminError("invalid", message, details);

const SQL_PREFIX_RE = /^(permission_denied|escalation_denied|not_found|invalid|conflict):\s*([\s\S]*)$/;

/** Postgres errors that are not raised by app.deny but are still the caller's
 * input (unique / FK / check violations, malformed values). Generic messages:
 * the raw text names constraints. */
const SQLSTATE_ERRORS: Readonly<Record<string, { code: AccessAdminErrorCode; message: string }>> = Object.freeze({
  "23505": { code: "conflict", message: "A record with the same key already exists." },
  "23503": { code: "conflict", message: "The record is still referenced by another record." },
  "23514": { code: "invalid", message: "A value is outside the allowed range." },
  "22P02": { code: "invalid", message: "A value has an invalid format." },
  "22001": { code: "invalid", message: "A value is too long." },
});

/** Maps an RPC error to an admin-facing error, or null when it is not one
 * (then the caller treats it as a service fault). */
export function mapRpcError(error: unknown): AccessAdminError | null {
  const row = isRecord(error) ? error : null;
  const sqlState = typeof row?.code === "string" ? row.code : "";
  const message = (typeof row?.message === "string" ? row.message : "").trim();
  if (!sqlState || sqlState === "P0001") {
    const match = SQL_PREFIX_RE.exec(message);
    if (match) {
      const code = match[1] as AccessAdminErrorCode;
      return new AccessAdminError(code, match[2].trim() || ERROR_DEFAULT_MESSAGE[code]);
    }
  }
  const known = SQLSTATE_ERRORS[sqlState];
  return known ? new AccessAdminError(known.code, known.message) : null;
}

// ---- small helpers -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return isRecord(value) ? value : null;
}

function text(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === "string" && error.message) return error.message;
  return "unknown error";
}

const sameId = (a: string | null | undefined, b: string | null | undefined) =>
  typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

const CATALOG_KEYS: readonly string[] = PERMISSION_CATALOG.map((entry) => entry.key);

function inCatalogOrder(keys: ReadonlySet<string>): string[] {
  return CATALOG_KEYS.filter((key) => keys.has(key));
}

// ---- rows (store output) and views (API output) -----------------------------------

export type ScopeMode = "all" | "selected" | "none";

export interface MemberRow {
  id: string;
  user_id: string;
  role_id: string;
  status: string;
  is_data_owner: boolean;
  email_snapshot: string;
  display_name: string;
  access_version: string;
  added_at: string | null;
  last_seen_at: string | null;
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  is_owner: boolean;
  is_system: boolean;
  template_key: string | null;
  permissions: string[];
}

export interface ScopeRuleRow {
  member_id: string;
  mode: string;
}

export interface ScopeValueRow {
  member_id: string;
  funnel_id: string;
}

export interface FunnelRow {
  id: string;
  funnel_path: string;
  display_name: string;
  is_active: boolean;
  tags: string[];
}

export interface AuditRow {
  id: number;
  occurred_at: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  event: string;
  target_type: string | null;
  target_id: string | null;
  outcome: string;
  reason_code: string | null;
  before: unknown;
  after: unknown;
  context: unknown;
}

export interface MemberRoleView {
  id: string;
  key: string;
  name: string;
  is_owner: boolean;
}

export interface FunnelScopeView {
  mode: ScopeMode;
  funnel_ids: string[];
}

export interface MemberView {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  status: string;
  is_data_owner: boolean;
  role: MemberRoleView;
  funnel_scope: FunnelScopeView;
  last_seen_at: string | null;
  access_version: string;
  added_at: string | null;
}

export interface RoleView {
  id: string;
  key: string;
  name: string;
  description: string;
  is_owner: boolean;
  is_system: boolean;
  template_key: string | null;
  /** The Owner role stores none and implicitly holds every enforced key: listed as such. */
  permissions: string[];
  /** null only when a post-mutation re-read failed. */
  member_count: number | null;
  /** Keys of the role's template (current catalog) the role does not hold yet (§8: never auto-added). */
  new_permissions_available: number;
  new_permission_keys: string[];
}

export interface EffectiveAccessView {
  status: string;
  role: MemberRoleView;
  /** Effective (§8): enforced, requires-satisfied, full-scope keys only with scope all; [] while disabled. */
  permissions: string[];
  raw_access: boolean;
  funnel_scope: FunnelScopeView & { names: string[] };
}

export interface AuditEventView {
  id: number;
  occurred_at: string | null;
  actor_kind: string;
  actor_user_id: string | null;
  actor_email: string | null;
  event: string;
  target_type: string | null;
  target_id: string | null;
  target_label: string | null;
  outcome: string;
  reason_code: string | null;
  before: unknown;
  after: unknown;
  context: unknown;
}

export interface FunnelOptionView {
  id: string;
  funnel_path: string;
  display_name: string;
  is_active: boolean;
  tags: string[];
}

// ---- store ----------------------------------------------------------------------------

export interface AuditQuery {
  workspaceId: string;
  /** Page size; the store reads limit + 1 rows to detect a next page. */
  limit: number;
  /** Only rows with id < beforeId (keyset paging, newest first). */
  beforeId: number | null;
  /** Exact event name. */
  event: string | null;
  /** Event namespace: matches `${eventPrefix}.%`. */
  eventPrefix: string | null;
  outcome: (typeof AUDIT_OUTCOMES)[number] | null;
}

export interface BanResult {
  ok: boolean;
  reason?: "not_supported" | "failed";
}

export interface AccessAdminStore {
  listMembers(workspaceId: string, filter?: { memberId?: string }): Promise<MemberRow[]>;
  listRoles(workspaceId: string): Promise<RoleRow[]>;
  listScopeRules(filter?: { memberId?: string }): Promise<ScopeRuleRow[]>;
  listScopeValues(filter?: { memberId?: string }): Promise<ScopeValueRow[]>;
  listFunnels(): Promise<FunnelRow[]>;
  /** Newest first, at most query.limit + 1 rows. */
  listAuditEvents(query: AuditQuery): Promise<AuditRow[]>;
  rpc(fn: string, params: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>;
  setUserBan(userId: string, banDuration: string): Promise<BanResult>;
}

export type AccessAdminLog = (level: "info" | "warn" | "error", event: string, details: Record<string, unknown>) => void;

// ---- input readers --------------------------------------------------------------------

function requireUuidField(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  if (!isUuid(value)) throw invalid(`${name} must be a uuid.`);
  return value.toLowerCase();
}

function optionalUuidField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (!isUuid(value)) throw invalid(`${name} must be a uuid.`);
  return value.toLowerCase();
}

/** Trimmed string, or null when absent (null / undefined = "unchanged"). */
function optionalTextField(body: Record<string, unknown>, name: string, max: number): string | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw invalid(`${name} must be a string.`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw invalid(`${name} must be at most ${max} characters.`);
  return trimmed;
}

function readEmail(body: Record<string, unknown>): string {
  const value = body.email;
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL_LENGTH || !/^[^\s@]+@[^\s@]+$/.test(email)) throw invalid("email must be an email address.");
  return email;
}

function readStatus(body: Record<string, unknown>): "active" | "disabled" | null {
  const value = body.status;
  if (value === undefined || value === null) return null;
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (status !== "active" && status !== "disabled") throw invalid("status must be active or disabled.");
  return status;
}

export interface ScopeInput {
  mode: ScopeMode;
  funnelIds: string[];
}

/** { mode, funnel_ids } of members.add (`scope`) and members.set_scope. Same
 * rules as app.prepare_scope, checked here first so a typo never reaches SQL. */
export function readScopeInput(mode: unknown, funnelIds: unknown): ScopeInput {
  const normalizedMode = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  if (normalizedMode !== "all" && normalizedMode !== "selected" && normalizedMode !== "none") {
    throw invalid("scope mode must be all, selected or none.");
  }
  if (funnelIds !== undefined && funnelIds !== null && !Array.isArray(funnelIds)) throw invalid("funnel_ids must be an array of funnel ids.");
  const list: unknown[] = Array.isArray(funnelIds) ? funnelIds : [];
  if (list.some((id) => !isUuid(id))) throw invalid("funnel_ids must contain funnel uuids only.");
  const ids = canonicalFunnelIds(list);
  if (ids.length > MAX_FUNNEL_IDS) throw invalid(`At most ${MAX_FUNNEL_IDS} funnels can be selected.`);
  if (normalizedMode !== "selected" && ids.length) throw invalid("funnel ids are only accepted with scope mode selected.");
  return { mode: normalizedMode, funnelIds: ids };
}

/** validateRolePermissions + its normalized (catalog-ordered, requires-closed) set. */
export function readRolePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) throw invalid("permissions must be an array of permission keys.");
  const validation = validateRolePermissions(value);
  if (!validation.ok) throw invalid("The role contains unknown or not yet enforced permissions.", validation.errors);
  return validation.normalized;
}

function randomSuffix(): string {
  const id = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now().toString(16)}0000`;
  return id.replace(/-/g, "").slice(0, 8);
}

/** A role key from its name: lower-case ASCII slug, `[a-z][a-z0-9_]{1,40}`. */
export function deriveRoleKey(name: string): string {
  let slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!slug) return `role_${randomSuffix()}`;
  if (!/^[a-z]/.test(slug) || slug.length < 2) slug = `role_${slug}`;
  slug = slug.slice(0, 41).replace(/_+$/g, "");
  if (slug === "owner") slug = "owner_role";
  return ROLE_KEY_RE.test(slug) ? slug : `role_${randomSuffix()}`;
}

function readRoleKey(value: unknown, name: string): string {
  if (value === undefined || value === null || value === "") return deriveRoleKey(name);
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ROLE_KEY_RE.test(key)) throw invalid("key must match ^[a-z][a-z0-9_]{1,40}$.");
  if (key === "owner") throw invalid("the role key owner is reserved.");
  return key;
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function parseAuditQuery(body: Record<string, unknown>, workspaceId: string): AuditQuery {
  let limit = AUDIT_PAGE_DEFAULT;
  if (body.limit !== undefined && body.limit !== null) {
    const parsed = positiveInteger(body.limit);
    if (parsed === null) throw invalid("limit must be a positive integer.");
    limit = Math.min(parsed, AUDIT_PAGE_MAX);
  }

  let beforeId: number | null = null;
  if (body.before_id !== undefined && body.before_id !== null && body.before_id !== "") {
    beforeId = positiveInteger(body.before_id);
    if (beforeId === null) throw invalid("before_id must be a positive integer.");
  }

  let event: string | null = null;
  let eventPrefix: string | null = null;
  if (body.event !== undefined && body.event !== null && body.event !== "") {
    const value = typeof body.event === "string" ? body.event.trim().toLowerCase() : "";
    if (!AUDIT_EVENT_FILTER_RE.test(value) || value.length > 100) throw invalid("event must be an event name such as member.added, or a namespace such as member.");
    if (value.includes(".")) event = value;
    else eventPrefix = value;
  }

  let outcome: AuditQuery["outcome"] = null;
  if (body.outcome !== undefined && body.outcome !== null && body.outcome !== "") {
    const value = typeof body.outcome === "string" ? body.outcome.trim().toLowerCase() : "";
    if (!(AUDIT_OUTCOMES as readonly string[]).includes(value)) throw invalid("outcome must be success, denied or error.");
    outcome = value as AuditQuery["outcome"];
  }

  return { workspaceId, limit, beforeId, event, eventPrefix, outcome };
}

// ---- view builders (pure) -----------------------------------------------------------

export function catalogView(): { permissions: PermissionDef[]; templates: RoleTemplate[] } {
  return {
    permissions: PERMISSION_CATALOG.map((entry) => ({ ...entry, requires: [...entry.requires] })),
    templates: ROLE_TEMPLATES.map((template) => ({ ...template, permissions: [...template.permissions] })),
  };
}

/** Funnel scope per member, as app.member_scope_mode / app.member_funnel_ids
 * read it: no rule ⇒ none; ids only count under `selected`. An unknown mode
 * fails closed to none. */
export function scopeIndex(rules: readonly ScopeRuleRow[], values: readonly ScopeValueRow[]): (memberId: string) => FunnelScopeView {
  const modes = new Map<string, string>();
  for (const rule of rules) modes.set(rule.member_id.toLowerCase(), rule.mode);
  const ids = new Map<string, string[]>();
  for (const value of values) {
    const key = value.member_id.toLowerCase();
    const list = ids.get(key) ?? [];
    list.push(value.funnel_id);
    ids.set(key, list);
  }
  return (memberId) => {
    const key = memberId.toLowerCase();
    const mode = modes.get(key);
    if (mode === "all") return { mode: "all", funnel_ids: [] };
    if (mode === "selected") return { mode: "selected", funnel_ids: canonicalFunnelIds(ids.get(key) ?? []) };
    return { mode: "none", funnel_ids: [] };
  };
}

function roleRefOf(role: RoleRow | null | undefined, roleId: string): MemberRoleView {
  return role
    ? { id: role.id, key: role.key, name: role.name, is_owner: role.is_owner }
    : { id: roleId, key: "", name: "", is_owner: false };
}

/** members.list rows. Emails come from email_snapshot (taken when the member was
 * added), never from auth.users. */
export function buildMemberViews(
  members: readonly MemberRow[],
  roles: readonly RoleRow[],
  rules: readonly ScopeRuleRow[],
  values: readonly ScopeValueRow[],
): MemberView[] {
  const rolesById = new Map(roles.map((role) => [role.id.toLowerCase(), role]));
  const scopeOf = scopeIndex(rules, values);
  return [...members]
    .sort((a, b) => (a.added_at ?? "").localeCompare(b.added_at ?? "") || a.id.localeCompare(b.id))
    .map((member) => ({
      id: member.id,
      user_id: member.user_id,
      email: member.email_snapshot,
      display_name: member.display_name,
      status: member.status,
      is_data_owner: member.is_data_owner,
      role: roleRefOf(rolesById.get(member.role_id.toLowerCase()), member.role_id),
      funnel_scope: scopeOf(member.id),
      last_seen_at: member.last_seen_at,
      access_version: member.access_version,
      added_at: member.added_at,
    }));
}

/** The member returned by a mutation when the follow-up read failed: built from
 * the RPC's app.member_snapshot (ids only, so the email may be unknown). */
export function memberViewFromSnapshot(snapshot: unknown, emailHint = ""): MemberView {
  const row = asRecord(snapshot) ?? {};
  const scope = asRecord(row.funnel_scope);
  const mode = text(scope?.mode);
  const roleKey = text(row.role_key) ?? "";
  return {
    id: text(row.member_id) ?? "",
    user_id: text(row.user_id) ?? "",
    email: emailHint,
    display_name: text(row.display_name) ?? "",
    status: text(row.status) ?? "",
    is_data_owner: row.is_data_owner === true,
    role: { id: text(row.role_id) ?? "", key: roleKey, name: roleKey, is_owner: roleKey === "owner" },
    funnel_scope:
      mode === "all"
        ? { mode: "all", funnel_ids: [] }
        : mode === "selected"
          ? { mode: "selected", funnel_ids: canonicalFunnelIds(stringArray(scope?.funnel_ids)) }
          : { mode: "none", funnel_ids: [] },
    last_seen_at: null,
    access_version: "",
    added_at: null,
  };
}

/** Template keys (current catalog) that a template-derived role does not hold.
 * Custom roles and the Owner have no template to compare with. */
export function newTemplatePermissions(role: RoleRow): string[] {
  if (role.is_owner || !role.template_key) return [];
  const template = ROLE_TEMPLATES.find((entry) => entry.key === role.template_key);
  if (!template) return [];
  const held = new Set(role.permissions);
  return template.permissions.filter((key) => !held.has(key));
}

export function roleView(role: RoleRow, memberCount: number | null): RoleView {
  const fresh = newTemplatePermissions(role);
  return {
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    is_owner: role.is_owner,
    is_system: role.is_system,
    template_key: role.template_key,
    permissions: role.is_owner ? [...ENFORCED_PERMISSION_KEYS] : [...role.permissions],
    member_count: memberCount,
    new_permissions_available: fresh.length,
    new_permission_keys: fresh,
  };
}

/** roles.list: the Owner first, then by name. member_count counts every member
 * holding the role (a role with any member, active or disabled, cannot be deleted). */
export function buildRoleViews(roles: readonly RoleRow[], members: readonly Pick<MemberRow, "role_id">[]): RoleView[] {
  const counts = new Map<string, number>();
  for (const member of members) {
    const key = member.role_id.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...roles]
    .sort((a, b) => Number(b.is_owner) - Number(a.is_owner) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
    .map((role) => roleView(role, counts.get(role.id.toLowerCase()) ?? 0));
}

/** members.effective — the same rules as the gate's AccessContext: effective
 * permissions via effectivePermissions(), raw access only for the active data
 * owner whose user id IS the workspace data key. A disabled member holds nothing. */
export function buildEffectiveAccess(input: {
  member: MemberRow;
  role: RoleRow | null;
  scope: FunnelScopeView;
  funnels: readonly FunnelRow[];
  tenantKey: string;
}): EffectiveAccessView {
  const { member, role, scope } = input;
  const active = member.status === "active";
  const permissions =
    active && role
      ? inCatalogOrder(effectivePermissions({ granted: role.permissions, isOwner: role.is_owner, funnelScopeAll: scope.mode === "all" }))
      : [];
  const funnelsById = new Map(input.funnels.map((funnel) => [funnel.id.toLowerCase(), funnel]));
  const names =
    scope.mode === "selected"
      ? scope.funnel_ids.map((id) => {
        const funnel = funnelsById.get(id.toLowerCase());
        return funnel ? funnel.display_name.trim() || funnel.funnel_path : id;
      })
      : [];
  return {
    status: member.status,
    role: roleRefOf(role, member.role_id),
    permissions,
    raw_access: active && member.is_data_owner && sameId(member.user_id, input.tenantKey),
    funnel_scope: { mode: scope.mode, funnel_ids: [...scope.funnel_ids], names },
  };
}

export function funnelOptionView(funnel: FunnelRow): FunnelOptionView {
  return {
    id: funnel.id,
    funnel_path: funnel.funnel_path,
    display_name: funnel.display_name,
    is_active: funnel.is_active,
    tags: [...new Set(funnel.tags)].sort((a, b) => a.localeCompare(b)),
  };
}

/** Drops every `data_key` property, at any depth (audit JSON is written by
 * several Edge functions; the workspace data key is never served by this API). */
export function scrubDataKey(value: unknown, depth = 0): unknown {
  if (depth > 32) return null;
  if (Array.isArray(value)) return value.map((entry) => scrubDataKey(entry, depth + 1));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "data_key") continue;
    out[key] = scrubDataKey(entry, depth + 1);
  }
  return out;
}

function snapshotLabel(row: AuditRow, field: string): string | null {
  for (const snapshot of [asRecord(row.after), asRecord(row.before)]) {
    const value = text(snapshot?.[field])?.trim();
    if (value) return value;
  }
  return null;
}

/** audit.list page: rows newest first; `rows` may hold limit + 1 entries, the
 * extra one only signals that a next page exists (next_before_id = last id served). */
export function buildAuditPage(
  rows: readonly AuditRow[],
  limit: number,
  members: readonly MemberRow[],
  roles: readonly RoleRow[],
): { events: AuditEventView[]; next_before_id: number | null } {
  const sorted = [...rows].sort((a, b) => b.id - a.id);
  const page = sorted.slice(0, limit);
  const membersById = new Map(members.map((member) => [member.id.toLowerCase(), member]));
  const membersByUser = new Map(members.map((member) => [member.user_id.toLowerCase(), member]));
  const rolesById = new Map(roles.map((role) => [role.id.toLowerCase(), role]));

  const targetLabel = (row: AuditRow): string | null => {
    const targetId = row.target_id?.toLowerCase() ?? "";
    if (row.target_type === "member") {
      const member = membersById.get(targetId);
      if (member) return member.display_name.trim() || member.email_snapshot || null;
      return snapshotLabel(row, "display_name");
    }
    if (row.target_type === "role") return rolesById.get(targetId)?.name ?? snapshotLabel(row, "name");
    return null;
  };

  const events = page.map((row) => ({
    id: row.id,
    occurred_at: row.occurred_at,
    actor_kind: row.actor_kind,
    actor_user_id: row.actor_user_id,
    actor_email: (row.actor_user_id && membersByUser.get(row.actor_user_id.toLowerCase())?.email_snapshot) || null,
    event: row.event,
    target_type: row.target_type,
    target_id: row.target_id,
    target_label: targetLabel(row),
    outcome: row.outcome,
    reason_code: row.reason_code,
    before: scrubDataKey(row.before),
    after: scrubDataKey(row.after),
    context: scrubDataKey(row.context),
  }));
  return { events, next_before_id: sorted.length > limit && page.length ? page[page.length - 1].id : null };
}

// ---- actions --------------------------------------------------------------------------

export interface AccessAdminRunInput {
  ctx: AccessContext;
  action: AccessAdminAction;
  body: Record<string, unknown>;
  store: AccessAdminStore;
  log?: AccessAdminLog;
}

/** The mutation actor: the signed-in caller (never the tenant key). */
function actorUserId(ctx: AccessContext): string {
  const userId = ctx.actor.userId;
  if (ctx.actor.kind !== "user" || !isUuid(userId)) throw new AccessAdminError("permission_denied", "A signed-in member is required.");
  return userId.toLowerCase();
}

async function callRpc(store: AccessAdminStore, fn: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  let result: { data: unknown; error: unknown };
  try {
    result = await store.rpc(fn, params);
  } catch (error) {
    throw new AccessAdminStoreError(`${fn}: ${errorText(error)}`);
  }
  if (result?.error) {
    const mapped = mapRpcError(result.error);
    if (mapped) throw mapped;
    throw new AccessAdminStoreError(`${fn}: ${errorText(result.error)}`);
  }
  const data = asRecord(result?.data);
  if (!data || data.ok !== true) throw new AccessAdminStoreError(`${fn} returned an unexpected result.`);
  return data;
}

async function loadMemberViews(store: AccessAdminStore, workspaceId: string, memberId?: string): Promise<MemberView[]> {
  const filter = memberId ? { memberId } : {};
  const [members, roles, rules, values] = await Promise.all([
    store.listMembers(workspaceId, filter),
    store.listRoles(workspaceId),
    store.listScopeRules(filter),
    store.listScopeValues(filter),
  ]);
  const known = new Set(members.map((member) => member.id.toLowerCase()));
  return buildMemberViews(
    members,
    roles,
    rules.filter((rule) => known.has(rule.member_id.toLowerCase())),
    values.filter((value) => known.has(value.member_id.toLowerCase())),
  );
}

async function loadRoleViews(store: AccessAdminStore, workspaceId: string): Promise<RoleView[]> {
  const [roles, members] = await Promise.all([store.listRoles(workspaceId), store.listMembers(workspaceId)]);
  return buildRoleViews(roles, members);
}

/** The member after a mutation, in the members.list shape. The change is already
 * committed, so a failed re-read falls back to the RPC snapshot instead of failing. */
async function reloadMember(store: AccessAdminStore, workspaceId: string, memberId: string | null, snapshot: unknown, emailHint = ""): Promise<MemberView> {
  if (memberId) {
    try {
      const [view] = await loadMemberViews(store, workspaceId, memberId);
      if (view && sameId(view.id, memberId)) return view;
    } catch (error) {
      if (!(error instanceof AccessAdminStoreError)) throw error;
    }
  }
  return memberViewFromSnapshot(snapshot, emailHint);
}

async function reloadRole(store: AccessAdminStore, workspaceId: string, roleId: string | null, snapshot: unknown, fallbackCount: number | null): Promise<RoleView> {
  if (roleId) {
    try {
      const view = (await loadRoleViews(store, workspaceId)).find((role) => sameId(role.id, roleId));
      if (view) return view;
    } catch (error) {
      if (!(error instanceof AccessAdminStoreError)) throw error;
    }
  }
  const row = asRecord(snapshot) ?? {};
  return roleView(
    {
      id: text(row.role_id) ?? roleId ?? "",
      key: text(row.key) ?? "",
      name: text(row.name) ?? "",
      description: text(row.description) ?? "",
      is_owner: row.is_owner === true,
      is_system: row.is_system === true,
      template_key: text(row.template_key),
      permissions: stringArray(row.permissions),
    },
    fallbackCount,
  );
}

function idOf(...candidates: unknown[]): string | null {
  for (const candidate of candidates) {
    if (isUuid(candidate)) return candidate.toLowerCase();
  }
  return null;
}

async function addMember({ ctx, body, store }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const email = readEmail(body);
  const roleId = requireUuidField(body, "role_id");
  if (!isRecord(body.scope)) throw invalid("scope is required: { mode, funnel_ids }.");
  const scope = readScopeInput(body.scope.mode, body.scope.funnel_ids);
  const displayName = optionalTextField(body, "display_name", MAX_DISPLAY_NAME) ?? "";

  const result = await callRpc(store, "access_add_member", {
    p_actor: actor,
    p_email: email,
    p_role_id: roleId,
    p_scope_mode: scope.mode,
    p_funnel_ids: scope.funnelIds,
    p_display_name: displayName,
  });
  const memberId = idOf(result.member_id, asRecord(result.member)?.member_id);
  return { ok: true, member: await reloadMember(store, ctx.workspaceId, memberId, result.member, email) };
}

/** Bans (disabled) or un-bans (active) the member's auth user. Best effort:
 * the membership row already denies every request (resolver + RLS); the ban
 * additionally stops refresh tokens. A failure is returned as a warning and
 * audited, never thrown (the membership change is committed). */
async function syncAuthBan(input: {
  ctx: AccessContext;
  store: AccessAdminStore;
  log: AccessAdminLog;
  actor: string;
  memberId: string;
  userId: string | null;
  disabled: boolean;
}): Promise<string | null> {
  const { ctx, store, log, actor, memberId, userId, disabled } = input;
  let outcome: BanResult;
  if (!isUuid(userId)) {
    outcome = { ok: false, reason: "failed" };
  } else {
    try {
      outcome = await store.setUserBan(userId, disabled ? DISABLED_MEMBER_BAN_DURATION : LIFTED_BAN_DURATION);
    } catch {
      outcome = { ok: false, reason: "failed" };
    }
  }
  if (outcome.ok) return null;

  const warning = `${disabled ? "auth_ban" : "auth_unban"}_${outcome.reason ?? "failed"}`;
  log("error", "access_admin_auth_ban_failed", { fn: "access", request_id: ctx.requestId, member_id: memberId, warning });
  try {
    await store.rpc("access_write_audit", {
      p_event: disabled ? "member.disabled" : "member.enabled",
      p_actor_kind: "user",
      p_actor_user_id: actor,
      p_target_type: "member",
      p_target_id: memberId,
      p_outcome: "error",
      p_reason_code: warning,
      p_before: null,
      p_after: null,
      p_context: { request_id: ctx.requestId },
    });
  } catch {
    // the warning in the response is the signal; the audit row is best effort
  }
  return warning;
}

async function updateMember({ ctx, body, store, log = defaultLog }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const memberId = requireUuidField(body, "member_id");
  const roleId = optionalUuidField(body, "role_id");
  const status = readStatus(body);
  const displayName = optionalTextField(body, "display_name", MAX_DISPLAY_NAME);

  const result = await callRpc(store, "access_update_member", {
    p_actor: actor,
    p_member_id: memberId,
    p_role_id: roleId,
    p_status: status,
    p_display_name: displayName,
  });
  const snapshot = asRecord(result.member) ?? {};

  // Re-applied whenever a status is sent (idempotent), so re-sending
  // "disabled" heals a ban that failed earlier.
  const warnings: string[] = [];
  const finalStatus = text(snapshot.status);
  if (status && (finalStatus === "disabled" || finalStatus === "active")) {
    const warning = await syncAuthBan({ ctx, store, log, actor, memberId, userId: text(snapshot.user_id), disabled: finalStatus === "disabled" });
    if (warning) warnings.push(warning);
  }

  const member = await reloadMember(store, ctx.workspaceId, memberId, snapshot);
  return { ok: true, changed: result.changed === true, member, ...(warnings.length ? { warnings } : {}) };
}

async function setMemberScope({ ctx, body, store }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const memberId = requireUuidField(body, "member_id");
  const source = isRecord(body.scope) ? body.scope : body;
  const scope = readScopeInput(source.mode, source.funnel_ids);

  const result = await callRpc(store, "access_set_member_scope", {
    p_actor: actor,
    p_member_id: memberId,
    p_mode: scope.mode,
    p_funnel_ids: scope.funnelIds,
  });
  const member = await reloadMember(store, ctx.workspaceId, memberId, { member_id: memberId, funnel_scope: result.funnel_scope });
  return { ok: true, changed: result.changed === true, member };
}

async function effectiveAccess({ ctx, body, store }: AccessAdminRunInput) {
  const memberId = requireUuidField(body, "member_id");
  const filter = { memberId };
  const [members, roles, rules, values] = await Promise.all([
    store.listMembers(ctx.workspaceId, filter),
    store.listRoles(ctx.workspaceId),
    store.listScopeRules(filter),
    store.listScopeValues(filter),
  ]);
  const member = members.find((row) => sameId(row.id, memberId));
  if (!member) throw new AccessAdminError("not_found", "member not found");
  const role = roles.find((row) => sameId(row.id, member.role_id)) ?? null;
  const scope = scopeIndex(
    rules.filter((rule) => sameId(rule.member_id, memberId)),
    values.filter((value) => sameId(value.member_id, memberId)),
  )(member.id);
  // The registry is small; reading it whole avoids a 1000-id `in` filter.
  const funnels = scope.mode === "selected" && scope.funnel_ids.length ? await store.listFunnels() : [];
  return { ok: true, effective: buildEffectiveAccess({ member, role, scope, funnels, tenantKey: ctx.tenantKey }) };
}

async function createRole({ ctx, body, store }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const name = optionalTextField(body, "name", MAX_ROLE_NAME);
  if (!name) throw invalid("name is required.");
  const key = readRoleKey(body.key, name);
  const description = optionalTextField(body, "description", MAX_ROLE_DESCRIPTION) ?? "";
  const permissions = body.permissions === undefined || body.permissions === null ? [] : readRolePermissions(body.permissions);

  const result = await callRpc(store, "access_create_role", {
    p_actor: actor,
    p_key: key,
    p_name: name,
    p_description: description,
    p_permissions: permissions,
  });
  const roleId = idOf(result.role_id, asRecord(result.role)?.role_id);
  return { ok: true, role: await reloadRole(store, ctx.workspaceId, roleId, result.role, 0) };
}

async function updateRole({ ctx, body, store }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const roleId = requireUuidField(body, "role_id");
  const name = optionalTextField(body, "name", MAX_ROLE_NAME);
  if (name === "") throw invalid("name must not be empty.");
  const description = optionalTextField(body, "description", MAX_ROLE_DESCRIPTION);
  const permissions = body.permissions === undefined || body.permissions === null ? null : readRolePermissions(body.permissions);

  const result = await callRpc(store, "access_update_role", {
    p_actor: actor,
    p_role_id: roleId,
    p_name: name,
    p_description: description,
    p_permissions: permissions,
  });
  return { ok: true, changed: result.changed === true, role: await reloadRole(store, ctx.workspaceId, roleId, result.role, null) };
}

async function deleteRole({ ctx, body, store }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const roleId = requireUuidField(body, "role_id");
  await callRpc(store, "access_delete_role", { p_actor: actor, p_role_id: roleId });
  return { ok: true, role_id: roleId };
}

/** ROLE_TEMPLATES as the p_templates JSON of access_seed_role_templates, each
 * permission set re-validated against the catalog (a broken template is a code
 * bug: 500, nothing seeded). */
export function seedTemplatesPayload(templates: readonly RoleTemplate[] = ROLE_TEMPLATES): RoleTemplate[] {
  return templates.map((template) => {
    const validation = validateRolePermissions(template.permissions);
    if (!validation.ok) throw new Error(`Role template ${template.key} is not valid: ${validation.errors.join(", ")}`);
    return { key: template.key, name: template.name, description: template.description, permissions: validation.normalized };
  });
}

async function seedTemplates({ ctx, store }: AccessAdminRunInput) {
  const actor = actorUserId(ctx);
  const result = await callRpc(store, "access_seed_role_templates", { p_actor: actor, p_templates: seedTemplatesPayload() });
  return { ok: true, created: stringArray(result.created), skipped: stringArray(result.skipped) };
}

async function listAudit({ ctx, body, store }: AccessAdminRunInput) {
  const query = parseAuditQuery(body, ctx.workspaceId);
  const [rows, members, roles] = await Promise.all([
    store.listAuditEvents(query),
    store.listMembers(ctx.workspaceId),
    store.listRoles(ctx.workspaceId),
  ]);
  return { ok: true, ...buildAuditPage(rows, query.limit, members, roles) };
}

async function listFunnelOptions({ store }: AccessAdminRunInput) {
  const funnels = (await store.listFunnels())
    .map(funnelOptionView)
    .sort((a, b) => a.funnel_path.localeCompare(b.funnel_path) || a.id.localeCompare(b.id));
  return { ok: true, funnels };
}

/** Runs one authorized action. Returns the 200 body; throws AccessAdminError
 * (admin-facing refusal), AccessAdminStoreError (503) or anything else (500). */
export async function runAccessAdminAction(input: AccessAdminRunInput): Promise<Record<string, unknown>> {
  const { ctx, action, store } = input;
  // Only user contexts reach this API (the policy has no cron branch); the
  // workspace id scopes every read.
  if (ctx.actor.kind !== "user" || !ctx.workspaceId) throw new AccessAdminError("permission_denied", "A signed-in member is required.");
  switch (action) {
    case "catalog":
      return { ok: true, ...catalogView() };
    case "members.list":
      return { ok: true, members: await loadMemberViews(store, ctx.workspaceId) };
    case "members.effective":
      return effectiveAccess(input);
    case "members.add":
      return addMember(input);
    case "members.update":
      return updateMember(input);
    case "members.set_scope":
      return setMemberScope(input);
    case "roles.list":
      return { ok: true, roles: await loadRoleViews(store, ctx.workspaceId) };
    case "roles.create":
      return createRole(input);
    case "roles.update":
      return updateRole(input);
    case "roles.delete":
      return deleteRole(input);
    case "roles.seed_templates":
      return seedTemplates(input);
    case "audit.list":
      return listAudit(input);
    case "funnels.list":
      return listFunnelOptions(input);
    default:
      throw invalid("Unsupported action.");
  }
}

// ---- HTTP glue (still pure: Response is a web standard) ------------------------------

export function accessAdminErrorBody(error: AccessAdminError, requestId?: string | null): Record<string, unknown> {
  return {
    ok: false,
    error_code: error.code,
    error: error.message,
    ...(error.details.length ? { errors: [...error.details] } : {}),
    ...(requestId ? { request_id: requestId } : {}),
  };
}

export function accessAdminErrorResponse(error: AccessAdminError, requestId?: string | null): Response {
  return new Response(JSON.stringify(accessAdminErrorBody(error, requestId)), {
    status: error.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

const SERVICE_ERROR_MESSAGE = "Could not read or update access settings. Please retry.";

/** serveWithAccess onError for what the handler throws. Fixed messages: the raw
 * text (PostgREST / network) goes to the gate's handler_failed log only. The gate
 * still replaces `error` with its generic text for anyone but the data owner. */
export function accessAdminOnError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AccessAdminError) return { status: error.status, body: accessAdminErrorBody(error) };
  if (error instanceof AccessAdminStoreError) {
    return { status: 503, body: { ok: false, error_code: ACCESS_ERROR.ACCESS_SERVICE_ERROR, error: SERVICE_ERROR_MESSAGE } };
  }
  return { status: 500, body: { ok: false, error_code: ACCESS_ERROR.REQUEST_FAILED, error: "Request failed." } };
}

function defaultLog(level: "info" | "warn" | "error", event: string, details: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...details });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/** The `access` function handler. Admin-facing refusals become a Response here
 * (status + message kept); everything else is thrown to the gate. */
export function createAccessAdminHandler(
  options: {
    makeStore?: (input: { pg: SupabaseAuthClient; ctx: AccessContext }) => AccessAdminStore;
    log?: AccessAdminLog;
  } = {},
): AccessHandler<AccessAdminAction> {
  const makeStore =
    options.makeStore ?? (({ pg, ctx }) => createSupabaseAccessAdminStore(pg as unknown as AccessAdminPgClient, { requestId: ctx.requestId }));
  const log = options.log ?? defaultLog;
  return async ({ ctx, action, body, pg }) => {
    try {
      return await runAccessAdminAction({ ctx, action, body, store: makeStore({ pg, ctx }), log });
    } catch (error) {
      if (!(error instanceof AccessAdminError)) throw error;
      log("warn", "access_admin_rejected", {
        fn: "access",
        request_id: ctx.requestId,
        action,
        user_id: ctx.actor.userId,
        status: error.status,
        error_code: error.code,
      });
      return accessAdminErrorResponse(error, ctx.requestId);
    }
  };
}

// ---- live store (service-role supabase-js client) -----------------------------------

export interface PgResult {
  data?: unknown;
  error?: unknown;
}

/** The slice of a supabase-js query builder this module uses. */
export interface PgQuery extends PromiseLike<PgResult> {
  select(columns: string): PgQuery;
  eq(column: string, value: unknown): PgQuery;
  lt(column: string, value: unknown): PgQuery;
  like(column: string, pattern: string): PgQuery;
  order(column: string, options?: { ascending?: boolean }): PgQuery;
  limit(count: number): PgQuery;
  range?(from: number, to: number): PgQuery;
}

export interface PgRpcCall extends PromiseLike<PgResult> {
  /** postgrest-js builders; stamps x-request-id so app.request_id() can read it. */
  setHeader?(name: string, value: string): unknown;
}

export interface AccessAdminPgClient {
  from(table: string): PgQuery;
  rpc?(fn: string, params?: Record<string, unknown>): PgRpcCall;
  auth?: {
    admin?: {
      updateUserById?(userId: string, attributes: Record<string, unknown>): Promise<{ error?: unknown } | null | undefined>;
    };
  };
}

const READ_PAGE_SIZE = 1000;
const READ_MAX_ROWS = 50_000;

const MEMBER_COLUMNS = "id,user_id,role_id,status,is_data_owner,email_snapshot,display_name,access_version,added_at,last_seen_at";
const ROLE_COLUMNS = "id,key,name,description,is_owner,is_system,template_key,permissions";
const SCOPE_RULE_COLUMNS = "member_id,mode";
const SCOPE_VALUE_COLUMNS = "member_id,funnel_id";
const FUNNEL_COLUMNS = "id,funnel_path,display_name,is_active,funnel_tags(tags(name))";
const AUDIT_COLUMNS = "id,occurred_at,actor_kind,actor_user_id,event,target_type,target_id,outcome,reason_code,before,after,context";

async function runQuery(label: string, query: PromiseLike<PgResult>): Promise<Record<string, unknown>[]> {
  let result: PgResult;
  try {
    result = await query;
  } catch (error) {
    throw new AccessAdminStoreError(`${label}: ${errorText(error)}`);
  }
  if (result?.error) throw new AccessAdminStoreError(`${label}: ${errorText(result.error)}`);
  return Array.isArray(result?.data) ? result.data.filter(isRecord) : [];
}

/** Every row, paged with range() (PostgREST caps a response at max-rows). The
 * builder must order by a unique key so pages do not overlap. */
async function readAll(label: string, build: () => PgQuery): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < READ_MAX_ROWS; offset += READ_PAGE_SIZE) {
    const base = build();
    const paged = typeof base.range === "function";
    const page = await runQuery(label, paged ? (base.range as NonNullable<PgQuery["range"]>).call(base, offset, offset + READ_PAGE_SIZE - 1) : base);
    rows.push(...page);
    if (!paged || page.length < READ_PAGE_SIZE) return rows;
  }
  throw new AccessAdminStoreError(`${label}: more than ${READ_MAX_ROWS} rows`);
}

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (match) => `\\${match}`);

function parseMemberRow(raw: Record<string, unknown>): MemberRow | null {
  const id = text(raw.id);
  const userId = text(raw.user_id);
  const roleId = text(raw.role_id);
  if (!id || !userId || !roleId) return null;
  return {
    id,
    user_id: userId,
    role_id: roleId,
    status: text(raw.status) ?? "",
    is_data_owner: raw.is_data_owner === true,
    email_snapshot: text(raw.email_snapshot) ?? "",
    display_name: text(raw.display_name) ?? "",
    access_version: text(raw.access_version) ?? "",
    added_at: text(raw.added_at),
    last_seen_at: text(raw.last_seen_at),
  };
}

function parseRoleRow(raw: Record<string, unknown>): RoleRow | null {
  const id = text(raw.id);
  const key = text(raw.key);
  if (!id || !key) return null;
  return {
    id,
    key,
    name: text(raw.name) ?? key,
    description: text(raw.description) ?? "",
    is_owner: raw.is_owner === true,
    is_system: raw.is_system === true,
    template_key: text(raw.template_key),
    permissions: stringArray(raw.permissions),
  };
}

function parseFunnelRow(raw: Record<string, unknown>): FunnelRow | null {
  const id = text(raw.id);
  if (!id) return null;
  const tags: string[] = [];
  for (const link of Array.isArray(raw.funnel_tags) ? raw.funnel_tags : []) {
    const tag = isRecord(link) ? (Array.isArray(link.tags) ? link.tags[0] : link.tags) : null;
    const name = isRecord(tag) ? text(tag.name)?.trim() : null;
    if (name) tags.push(name);
  }
  return {
    id,
    funnel_path: text(raw.funnel_path) ?? "",
    display_name: text(raw.display_name) ?? "",
    is_active: raw.is_active === true,
    tags,
  };
}

function parseAuditRow(raw: Record<string, unknown>): AuditRow | null {
  const id = typeof raw.id === "number" ? raw.id : Number(text(raw.id) ?? NaN);
  const event = text(raw.event);
  if (!Number.isSafeInteger(id) || !event) return null;
  return {
    id,
    occurred_at: text(raw.occurred_at),
    actor_kind: text(raw.actor_kind) ?? "",
    actor_user_id: text(raw.actor_user_id),
    event,
    target_type: text(raw.target_type),
    target_id: text(raw.target_id),
    outcome: text(raw.outcome) ?? "",
    reason_code: text(raw.reason_code),
    before: raw.before ?? null,
    after: raw.after ?? null,
    context: raw.context ?? null,
  };
}

const keep = <T>(value: T | null): value is T => value !== null;

/** The AccessAdminStore over the gate's service-role client. Reads are
 * workspace-filtered where the table has a workspace column; scope rows have
 * none and are joined to the workspace's members by the caller. */
export function createSupabaseAccessAdminStore(pg: AccessAdminPgClient, options: { requestId?: string | null } = {}): AccessAdminStore {
  const requestId = options.requestId ?? null;
  return {
    async listMembers(workspaceId, filter = {}) {
      const rows = await readAll("workspace_members", () => {
        let query = pg.from("workspace_members").select(MEMBER_COLUMNS).eq("workspace_id", workspaceId);
        if (filter.memberId) query = query.eq("id", filter.memberId);
        return query.order("added_at", { ascending: true }).order("id", { ascending: true });
      });
      return rows.map(parseMemberRow).filter(keep);
    },
    async listRoles(workspaceId) {
      const rows = await readAll("access_roles", () =>
        pg.from("access_roles").select(ROLE_COLUMNS).eq("workspace_id", workspaceId).order("id", { ascending: true }));
      return rows.map(parseRoleRow).filter(keep);
    },
    async listScopeRules(filter = {}) {
      const rows = await readAll("member_scope_rules", () => {
        let query = pg.from("member_scope_rules").select(SCOPE_RULE_COLUMNS).eq("dimension", "funnel");
        if (filter.memberId) query = query.eq("member_id", filter.memberId);
        return query.order("member_id", { ascending: true });
      });
      return rows
        .map((row) => (text(row.member_id) && text(row.mode) ? { member_id: text(row.member_id) as string, mode: text(row.mode) as string } : null))
        .filter(keep);
    },
    async listScopeValues(filter = {}) {
      const rows = await readAll("member_scope_values", () => {
        let query = pg.from("member_scope_values").select(SCOPE_VALUE_COLUMNS).eq("dimension", "funnel");
        if (filter.memberId) query = query.eq("member_id", filter.memberId);
        return query.order("id", { ascending: true });
      });
      return rows
        .map((row) => (text(row.member_id) && text(row.funnel_id) ? { member_id: text(row.member_id) as string, funnel_id: text(row.funnel_id) as string } : null))
        .filter(keep);
    },
    async listFunnels() {
      const rows = await readAll("funnels", () =>
        pg.from("funnels").select(FUNNEL_COLUMNS).order("funnel_path", { ascending: true }).order("id", { ascending: true }));
      return rows.map(parseFunnelRow).filter(keep);
    },
    async listAuditEvents(query) {
      let builder = pg.from("access_audit_log").select(AUDIT_COLUMNS).eq("workspace_id", query.workspaceId);
      if (query.beforeId !== null) builder = builder.lt("id", query.beforeId);
      if (query.event) builder = builder.eq("event", query.event);
      if (query.eventPrefix) builder = builder.like("event", `${escapeLike(query.eventPrefix)}.%`);
      if (query.outcome) builder = builder.eq("outcome", query.outcome);
      const rows = await runQuery("access_audit_log", builder.order("id", { ascending: false }).limit(query.limit + 1));
      return rows.map(parseAuditRow).filter(keep);
    },
    async rpc(fn, params) {
      if (typeof pg.rpc !== "function") throw new AccessAdminStoreError("rpc is not supported by this client");
      const call = pg.rpc(fn, params);
      if (requestId && call && typeof call.setHeader === "function") call.setHeader("x-request-id", requestId);
      const result = await call;
      return { data: result?.data ?? null, error: result?.error ?? null };
    },
    async setUserBan(userId, banDuration) {
      const admin = pg.auth?.admin;
      // Guarded: test fakes (and a misconfigured client) have no admin API.
      if (!admin || typeof admin.updateUserById !== "function") return { ok: false, reason: "not_supported" };
      try {
        const result = await admin.updateUserById(userId, { ban_duration: banDuration });
        return result?.error ? { ok: false, reason: "failed" } : { ok: true };
      } catch {
        return { ok: false, reason: "failed" };
      }
    },
  };
}
