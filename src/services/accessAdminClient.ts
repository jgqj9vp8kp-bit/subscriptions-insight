// Browser client of the access admin Edge API (plan §15-§17, §24; SHARED
// CONTRACT A): POST /functions/v1/access with JSON { action, ... }. Every
// answer is { ok: true, ... } or { ok: false, error_code, error }.
//
// The Admin → Access pages (src/pages/admin/*) are its only callers. The
// server is the authority on every rule (permission, anti-escalation, owner
// guards); this module only moves requests and turns failures into typed
// errors the pages can toast.
//
// Errors: AccessAdminRequestError extends the shared ClickHouseRequestError
// (SHARED CONTRACT B) on purpose, so isAccessError() and the AccessErrorBridge
// treat a refused admin call exactly like a refused analytics call (401
// invalid_session ⇒ sign out, 403 permission_denied ⇒ refresh access). The
// message is the server's admin-facing text; `details` carries per-item
// reasons (e.g. the unknown permission keys of a role save).
//
// Responses are parsed leniently into the typed shapes below (missing fields
// get safe defaults) so a partial answer never crashes a page.

import { supabase } from "@/services/supabaseClient";
import { ClickHouseRequestError } from "@/services/clickhouse";
import type { PermissionArea, PermissionDef } from "../../supabase/functions/_shared/access/permissions.ts";

export const ACCESS_ADMIN_FUNCTION = "access";

export type AccessAdminAction =
  | "catalog"
  | "members.list"
  | "members.add"
  | "members.update"
  | "members.set_scope"
  | "members.effective"
  | "roles.list"
  | "roles.create"
  | "roles.update"
  | "roles.delete"
  | "roles.seed_templates"
  | "audit.list"
  | "funnels.list";

export type FunnelScopeMode = "all" | "selected" | "none";

export interface AdminFunnelScope {
  mode: FunnelScopeMode;
  funnel_ids: string[];
}

export interface AdminRoleRef {
  id: string;
  key: string;
  name: string;
  is_owner: boolean;
}

export interface AdminMember {
  id: string;
  user_id: string;
  email: string;
  display_name: string;
  status: "active" | "disabled" | string;
  is_data_owner: boolean;
  role: AdminRoleRef;
  funnel_scope: AdminFunnelScope;
  last_seen_at: string | null;
  access_version: string;
  added_at: string | null;
}

export interface AdminRole {
  id: string;
  key: string;
  name: string;
  description: string;
  is_owner: boolean;
  is_system: boolean;
  template_key: string | null;
  /** The Owner role is listed with every enforced key. */
  permissions: string[];
  /** null when the server could not count (after a mutation re-read failed). */
  member_count: number | null;
  new_permissions_available: number;
  /** Template keys the role does not hold yet (§8: never auto-added). */
  new_permission_keys: string[];
}

export interface AccessRoleTemplate {
  key: string;
  name: string;
  description: string;
  permissions: string[];
}

export interface AccessCatalog {
  permissions: PermissionDef[];
  templates: AccessRoleTemplate[];
}

export interface EffectiveAccess {
  status: string;
  role: AdminRoleRef;
  /** Effective keys (server effectivePermissions()); [] while disabled. */
  permissions: string[];
  raw_access: boolean;
  funnel_scope: AdminFunnelScope & { names: string[] };
}

export interface AuditEvent {
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

export interface AuditPage {
  events: AuditEvent[];
  next_before_id: number | null;
}

export interface AdminFunnelOption {
  id: string;
  funnel_path: string;
  display_name: string;
  is_active: boolean;
  tags: string[];
}

export interface AuditQuery {
  limit?: number;
  before_id?: number | null;
  /** Full event ("member.added") or a namespace ("member"). */
  event?: string | null;
  outcome?: "success" | "denied" | "error" | null;
}

// ---- errors ---------------------------------------------------------------------------

/** A refused or failed access admin call. `status` is the HTTP status of a
 * non-2xx answer, or 0 when no usable answer arrived (network, not signed in,
 * a malformed body, or a 200 carrying ok:false). */
export class AccessAdminRequestError extends ClickHouseRequestError {
  /** Per-item reasons from the server (`errors`), e.g. rejected permission keys. */
  readonly details: string[];

  constructor(message: string, details: { status: number; errorCode?: string | null; requestId?: string | null; details?: string[] }) {
    super(message, details);
    this.name = "AccessAdminRequestError";
    this.details = details.details ?? [];
  }
}

/** Toast text for any error thrown by this module (or anything else). */
export function describeAccessAdminError(error: unknown): string {
  if (error instanceof AccessAdminRequestError) {
    const base = error.message || "Request failed.";
    return error.details.length ? `${base} (${error.details.join("; ")})` : base;
  }
  if (error instanceof Error && error.message) return error.message;
  return "Request failed.";
}

// ---- small parsers --------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
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

function nonEmpty(value: unknown): string | null {
  const parsed = text(value);
  return parsed && parsed.length > 0 ? parsed : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function integer(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function scopeMode(value: unknown): FunnelScopeMode {
  // Unknown modes fail closed to "none", like the server's scopeIndex().
  return value === "all" || value === "selected" ? value : "none";
}

function parseScope(value: unknown): AdminFunnelScope {
  const row = asRecord(value);
  const mode = scopeMode(row?.mode);
  return { mode, funnel_ids: mode === "selected" ? stringArray(row?.funnel_ids) : [] };
}

function parseRoleRef(value: unknown): AdminRoleRef {
  const row = asRecord(value) ?? {};
  return {
    id: text(row.id) ?? "",
    key: text(row.key) ?? "",
    name: text(row.name) || text(row.key) || "",
    is_owner: row.is_owner === true,
  };
}

export function parseAdminMember(value: unknown): AdminMember | null {
  const row = asRecord(value);
  const id = nonEmpty(row?.id);
  if (!row || !id) return null;
  return {
    id,
    user_id: text(row.user_id) ?? "",
    email: text(row.email) ?? "",
    display_name: text(row.display_name) ?? "",
    status: text(row.status) ?? "",
    is_data_owner: row.is_data_owner === true,
    role: parseRoleRef(row.role),
    funnel_scope: parseScope(row.funnel_scope),
    last_seen_at: nonEmpty(row.last_seen_at),
    access_version: text(row.access_version) ?? "",
    added_at: nonEmpty(row.added_at),
  };
}

export function parseAdminRole(value: unknown): AdminRole | null {
  const row = asRecord(value);
  const id = nonEmpty(row?.id);
  if (!row || !id) return null;
  const fresh = stringArray(row.new_permission_keys);
  return {
    id,
    key: text(row.key) ?? "",
    name: text(row.name) || text(row.key) || "",
    description: text(row.description) ?? "",
    is_owner: row.is_owner === true,
    is_system: row.is_system === true,
    template_key: nonEmpty(row.template_key),
    permissions: stringArray(row.permissions),
    member_count: integer(row.member_count),
    new_permissions_available: integer(row.new_permissions_available) ?? fresh.length,
    new_permission_keys: fresh,
  };
}

const PERMISSION_AREAS: ReadonlySet<string> = new Set(["pages", "exports", "details", "forecasting", "reports", "ai", "admin"]);
const SENSITIVE_KINDS: ReadonlySet<string> = new Set(["pii", "export", "admin", "cost"]);

function parsePermissionDef(value: unknown): PermissionDef | null {
  const row = asRecord(value);
  const key = nonEmpty(row?.key);
  if (!row || !key) return null;
  const area = text(row.area) ?? "";
  const sensitive = text(row.sensitive);
  return {
    key,
    area: (PERMISSION_AREAS.has(area) ? area : "pages") as PermissionArea,
    label: text(row.label) || key,
    description: text(row.description) ?? "",
    requires: stringArray(row.requires),
    requiresFullScope: row.requiresFullScope === true,
    sensitive: sensitive && SENSITIVE_KINDS.has(sensitive) ? (sensitive as PermissionDef["sensitive"]) : null,
    // Anything but "enforced" is shown as "coming" and never offered.
    status: row.status === "enforced" ? "enforced" : "planned",
  };
}

function parseTemplate(value: unknown): AccessRoleTemplate | null {
  const row = asRecord(value);
  const key = nonEmpty(row?.key);
  if (!row || !key) return null;
  return { key, name: text(row.name) || key, description: text(row.description) ?? "", permissions: stringArray(row.permissions) };
}

export function parseEffectiveAccess(value: unknown): EffectiveAccess | null {
  const row = asRecord(value);
  if (!row) return null;
  const scope = parseScope(row.funnel_scope);
  return {
    status: text(row.status) ?? "",
    role: parseRoleRef(row.role),
    permissions: stringArray(row.permissions),
    raw_access: row.raw_access === true,
    funnel_scope: { ...scope, names: stringArray(asRecord(row.funnel_scope)?.names) },
  };
}

function parseAuditEvent(value: unknown): AuditEvent | null {
  const row = asRecord(value);
  const id = integer(row?.id);
  const event = nonEmpty(row?.event);
  if (!row || id === null || !event) return null;
  return {
    id,
    occurred_at: nonEmpty(row.occurred_at),
    actor_kind: text(row.actor_kind) ?? "",
    actor_user_id: nonEmpty(row.actor_user_id),
    actor_email: nonEmpty(row.actor_email),
    event,
    target_type: nonEmpty(row.target_type),
    target_id: nonEmpty(row.target_id),
    target_label: nonEmpty(row.target_label),
    outcome: text(row.outcome) ?? "",
    reason_code: nonEmpty(row.reason_code),
    before: row.before ?? null,
    after: row.after ?? null,
    context: row.context ?? null,
  };
}

function parseFunnelOption(value: unknown): AdminFunnelOption | null {
  const row = asRecord(value);
  const id = nonEmpty(row?.id);
  if (!row || !id) return null;
  return {
    id,
    funnel_path: text(row.funnel_path) ?? "",
    display_name: text(row.display_name) ?? "",
    is_active: row.is_active === true,
    tags: stringArray(row.tags),
  };
}

const keep = <T>(value: T | null): value is T => value !== null;

function list<T>(value: unknown, parse: (entry: unknown) => T | null): T[] {
  return Array.isArray(value) ? value.map(parse).filter(keep) : [];
}

// ---- transport ------------------------------------------------------------------------

async function readHttpFailure(error: unknown): Promise<AccessAdminRequestError> {
  const context = (error as { context?: unknown })?.context;
  if (typeof Response !== "undefined" && context instanceof Response) {
    const raw = await context.clone().text().catch(() => "");
    const payload = asRecord(raw);
    const message = text(payload?.error) || text(payload?.message) || `Request failed (HTTP ${context.status}).`;
    return new AccessAdminRequestError(message, {
      status: context.status,
      errorCode: nonEmpty(payload?.error_code),
      requestId: nonEmpty(payload?.request_id) ?? nonEmpty(context.headers.get("x-request-id")),
      details: stringArray(payload?.errors),
    });
  }
  const message = error instanceof Error && error.message ? error.message : "Could not reach the access service.";
  return new AccessAdminRequestError(message, { status: 0 });
}

/** One access admin call. Resolves to the { ok: true, ... } body; throws
 * AccessAdminRequestError for everything else. */
export async function accessAdminRequest(action: AccessAdminAction, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  if (!supabase) throw new AccessAdminRequestError("Supabase is not configured.", { status: 0 });
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new AccessAdminRequestError("Sign in to manage workspace access.", { status: 0 });

  let result: { data: unknown; error: unknown };
  try {
    result = await supabase.functions.invoke(ACCESS_ADMIN_FUNCTION, {
      // The action always wins over a same-named param.
      body: { ...params, action },
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw await readHttpFailure(error);
  }
  if (result.error) throw await readHttpFailure(result.error);

  const body = asRecord(result.data);
  if (!body) throw new AccessAdminRequestError("The access service returned an invalid response.", { status: 0 });
  if (body.ok !== true) {
    throw new AccessAdminRequestError(text(body.error) || "Request failed.", {
      status: 0,
      errorCode: nonEmpty(body.error_code),
      requestId: nonEmpty(body.request_id),
      details: stringArray(body.errors),
    });
  }
  return body;
}

function requireMember(value: unknown): AdminMember {
  const member = parseAdminMember(value);
  if (!member) throw new AccessAdminRequestError("The access service returned no member.", { status: 0 });
  return member;
}

function requireRole(value: unknown): AdminRole {
  const role = parseAdminRole(value);
  if (!role) throw new AccessAdminRequestError("The access service returned no role.", { status: 0 });
  return role;
}

// ---- actions --------------------------------------------------------------------------

export async function fetchAccessCatalog(): Promise<AccessCatalog> {
  const body = await accessAdminRequest("catalog");
  return { permissions: list(body.permissions, parsePermissionDef), templates: list(body.templates, parseTemplate) };
}

export async function listAccessMembers(): Promise<AdminMember[]> {
  return list((await accessAdminRequest("members.list")).members, parseAdminMember);
}

export async function addAccessMember(input: {
  email: string;
  role_id: string;
  scope: AdminFunnelScope;
  display_name?: string;
}): Promise<AdminMember> {
  const body = await accessAdminRequest("members.add", {
    email: input.email,
    role_id: input.role_id,
    scope: { mode: input.scope.mode, funnel_ids: input.scope.mode === "selected" ? input.scope.funnel_ids : [] },
    ...(input.display_name ? { display_name: input.display_name } : {}),
  });
  return requireMember(body.member);
}

export interface MemberMutationResult {
  member: AdminMember;
  changed: boolean;
  /** e.g. "auth_ban_failed": the membership change is committed, the sign-out ban is not. */
  warnings: string[];
}

export async function updateAccessMember(input: {
  member_id: string;
  role_id?: string;
  status?: "active" | "disabled";
  display_name?: string;
}): Promise<MemberMutationResult> {
  const body = await accessAdminRequest("members.update", input);
  return { member: requireMember(body.member), changed: body.changed !== false, warnings: stringArray(body.warnings) };
}

export async function setAccessMemberScope(input: { member_id: string; mode: FunnelScopeMode; funnel_ids: string[] }): Promise<MemberMutationResult> {
  const body = await accessAdminRequest("members.set_scope", {
    member_id: input.member_id,
    mode: input.mode,
    funnel_ids: input.mode === "selected" ? input.funnel_ids : [],
  });
  return { member: requireMember(body.member), changed: body.changed !== false, warnings: stringArray(body.warnings) };
}

export async function fetchMemberEffectiveAccess(memberId: string): Promise<EffectiveAccess> {
  const effective = parseEffectiveAccess((await accessAdminRequest("members.effective", { member_id: memberId })).effective);
  if (!effective) throw new AccessAdminRequestError("The access service returned no effective access.", { status: 0 });
  return effective;
}

export async function listAccessRoles(): Promise<AdminRole[]> {
  return list((await accessAdminRequest("roles.list")).roles, parseAdminRole);
}

export async function createAccessRole(input: { name: string; description?: string; permissions: string[]; key?: string }): Promise<AdminRole> {
  return requireRole((await accessAdminRequest("roles.create", input)).role);
}

export async function updateAccessRole(input: {
  role_id: string;
  name?: string;
  description?: string;
  permissions?: string[];
}): Promise<{ role: AdminRole; changed: boolean }> {
  const body = await accessAdminRequest("roles.update", input);
  return { role: requireRole(body.role), changed: body.changed !== false };
}

export async function deleteAccessRole(roleId: string): Promise<void> {
  await accessAdminRequest("roles.delete", { role_id: roleId });
}

export async function seedAccessRoleTemplates(): Promise<{ created: string[]; skipped: string[] }> {
  const body = await accessAdminRequest("roles.seed_templates");
  return { created: stringArray(body.created), skipped: stringArray(body.skipped) };
}

export async function listAccessAudit(query: AuditQuery = {}): Promise<AuditPage> {
  const params: Record<string, unknown> = {};
  if (query.limit) params.limit = query.limit;
  if (query.before_id) params.before_id = query.before_id;
  if (query.event) params.event = query.event;
  if (query.outcome) params.outcome = query.outcome;
  const body = await accessAdminRequest("audit.list", params);
  return { events: list(body.events, parseAuditEvent), next_before_id: integer(body.next_before_id) };
}

export async function listAccessFunnels(): Promise<AdminFunnelOption[]> {
  return list((await accessAdminRequest("funnels.list")).funnels, parseFunnelOption);
}
