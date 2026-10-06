// Shared fixtures of the security regression suite (plan §29 "New helpers":
// owner, admin-all, buyer-{A}, buyer-{A,B}, empty-grant, disabled, non-member,
// cron, api-key).
//
// Three layers, so every security test can pick the most real one it needs:
//   1. Personas → resolve_access rows → AccessContexts (pure, the gate's own
//      parser and builder).
//   2. A fake-dependency gate harness (handleWithAccess with injected getUser /
//      resolve_access / workspace_data_key / a ScopedReader over the recording
//      ClickHouse), plus the policy registry and ONE request fixture per
//      canonical action of every policy, so table-driven tests iterate every
//      policy × action and a new action without a fixture fails the suite.
//   3. A PGlite workspace (all migrations, bootstrap, real role templates, the
//      personas as real members, tenant rows, the RLS lockdown) and gate
//      dependencies backed by it: the REAL resolve_access feeds the REAL gate.
//
// Never touches production: no network, no Supabase project, no ClickHouse.

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { EXPORT_API_KEY_SCOPE } from "../../../supabase/functions/_shared/access/policies/export-campaign-performance.ts";
import {
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
  type ServeWithAccessOptions,
} from "../../../supabase/functions/_shared/access/gate.ts";
import {
  buildAccessContext,
  buildCronAccessContext,
  parseResolveAccessRow,
  type AccessContext,
  type ActionPolicy,
} from "../../../supabase/functions/_shared/access/accessContext.ts";
import {
  ENFORCED_PERMISSION_KEYS,
  closeUnderRequires,
  isPrivilegedPermission,
} from "../../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../../supabase/functions/_shared/access/roles.ts";
import { ACCESS_ERROR, type AccessErrorCode } from "../../../supabase/functions/_shared/access/errors.ts";
import { createScopedReader } from "../../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import type {
  AccessAdminStore,
  AuditRow,
  FunnelRow,
  MemberRow,
  RoleRow,
} from "../../../supabase/functions/_shared/access/adminApi.ts";
import { seedTemplatesPayload } from "../../../supabase/functions/_shared/access/adminApi.ts";
import { createRecordingClickHouse, type RecordingClickHouse } from "./recordingClickHouse";
import { createStrictFakeSupabase } from "./strictFakeSupabase";
import {
  createSupabasePglite,
  listMigrations,
  type SqlRunner,
  type SupabasePglite,
} from "./pgliteSupabase";
import { SENTINEL_EMAILS, SENTINEL_SPEND } from "./leakScan";

// =====================================================================================
// 1. identities
// =====================================================================================

/** The workspace data key U: the data owner's auth uuid and every query's tenant. */
export const DATA_KEY = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
/** A tenant that is NOT the workspace (another account's private copy, a forged key). */
export const FOREIGN_TENANT = "99999999-9999-4999-8999-999999999999";

export const USER_IDS = {
  owner: DATA_KEY,
  admin: "a1a1a1a1-0000-4000-8000-000000000001",
  viewer: "b2b2b2b2-0000-4000-8000-000000000002",
  buyerA: "c3c3c3c3-0000-4000-8000-000000000003",
  buyerAB: "c4c4c4c4-0000-4000-8000-000000000004",
  emptyGrant: "d5d5d5d5-0000-4000-8000-000000000005",
  noRule: "d6d6d6d6-0000-4000-8000-000000000006",
  disabled: "e7e7e7e7-0000-4000-8000-000000000007",
  nonMember: "f8f8f8f8-0000-4000-8000-000000000008",
  newbie: "f9f9f9f9-0000-4000-8000-000000000009",
} as const;

export const FUNNELS = {
  A: { id: "aaaaaaaa-0000-4000-8000-0000000000aa", path: "soulmate-sketch", rawPath: "/Soulmate-Sketch", name: "Soulmate" },
  B: { id: "bbbbbbbb-0000-4000-8000-0000000000bb", path: "past-life", rawPath: "past-life", name: "Past life" },
  C: { id: "cccccccc-0000-4000-8000-0000000000cc", path: "palm-reading", rawPath: "palm-reading", name: "Palm" },
} as const;

const TEMPLATE = Object.fromEntries(ROLE_TEMPLATES.map((template) => [template.key, template.permissions])) as Record<string, string[]>;

export const TEMPLATE_PERMISSIONS = {
  admin: TEMPLATE.admin,
  viewer: TEMPLATE.viewer,
  mediaBuyer: TEMPLATE.media_buyer,
  analyst: TEMPLATE.analyst,
  headOfMarketing: TEMPLATE.head_of_marketing,
  productManager: TEMPLATE.product_manager,
};

/** Every enforced key that does NOT need funnel scope `all`. */
export const NON_PRIVILEGED_KEYS: readonly string[] = ENFORCED_PERMISSION_KEYS.filter((key) => !isPrivilegedPermission(key));

// =====================================================================================
// 2. personas → resolve_access rows → contexts
// =====================================================================================

export type ScopeMode = "all" | "selected" | "none";

export interface PersonaScope {
  mode: ScopeMode;
  funnelIds: string[];
  paths: string[];
}

export interface Persona {
  name: string;
  userId: string;
  status: "ok" | "disabled" | "no_membership" | "no_workspace";
  role: { id: string; key: string; name: string; isOwner: boolean; permissions: string[] };
  /** null = no rule row (resolve_access reports mode "none"). */
  scope: PersonaScope | null;
  accessVersion: string;
}

const ALL: PersonaScope = { mode: "all", funnelIds: [], paths: [] };
const selected = (...funnels: Array<(typeof FUNNELS)[keyof typeof FUNNELS]>): PersonaScope => ({
  mode: "selected",
  funnelIds: funnels.map((funnel) => funnel.id),
  paths: funnels.map((funnel) => funnel.path).sort(),
});

function persona(name: string, userId: string, role: Persona["role"], scope: PersonaScope | null, status: Persona["status"] = "ok"): Persona {
  return { name, userId, status, role, scope, accessVersion: "1" };
}

const role = (key: string, permissions: readonly string[], isOwner = false) => ({
  id: `role-${key}`,
  key,
  name: key,
  isOwner,
  permissions: [...permissions],
});

export const PERSONAS = {
  owner: persona("owner", USER_IDS.owner, role("owner", [], true), ALL),
  admin: persona("admin", USER_IDS.admin, role("admin", TEMPLATE_PERMISSIONS.admin), ALL),
  viewer: persona("viewer", USER_IDS.viewer, role("viewer", TEMPLATE_PERMISSIONS.viewer), ALL),
  buyerA: persona("buyerA", USER_IDS.buyerA, role("media_buyer", TEMPLATE_PERMISSIONS.mediaBuyer), selected(FUNNELS.A)),
  buyerAB: persona("buyerAB", USER_IDS.buyerAB, role("media_buyer", TEMPLATE_PERMISSIONS.mediaBuyer), selected(FUNNELS.A, FUNNELS.B)),
  emptyGrant: persona("emptyGrant", USER_IDS.emptyGrant, role("viewer", TEMPLATE_PERMISSIONS.viewer), { mode: "selected", funnelIds: [], paths: [] }),
  noRule: persona("noRule", USER_IDS.noRule, role("viewer", TEMPLATE_PERMISSIONS.viewer), null),
  disabled: persona("disabled", USER_IDS.disabled, role("viewer", TEMPLATE_PERMISSIONS.viewer), ALL, "disabled"),
  nonMember: persona("nonMember", USER_IDS.nonMember, role("none", []), null, "no_membership"),
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

/** Same persona, another role grant (role key "custom"). */
export function withGrant(base: Persona, permissions: readonly string[], options: { isOwner?: boolean; name?: string } = {}): Persona {
  return {
    ...base,
    name: options.name ?? `${base.name}+grant`,
    role: { ...base.role, id: "role-custom", key: "custom", isOwner: options.isOwner ?? false, permissions: [...permissions] },
  };
}

/** Same persona, another funnel scope. */
export function withScope(base: Persona, scope: PersonaScope | null, name?: string): Persona {
  return { ...base, name: name ?? `${base.name}@${scope?.mode ?? "none"}`, scope };
}

export const memberIdOf = (userId: string) => `${userId.slice(0, 8)}-1111-4111-8111-${userId.slice(-12)}`;

/** The JSON public.resolve_access(user) returns for a persona (same shape as the SQL). */
export function accessRow(p: Persona, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  if (p.status !== "ok") return { status: p.status, user_id: p.userId, workspace_id: p.status === "no_workspace" ? null : WORKSPACE_ID, ...overrides };
  const scope = p.scope ?? { mode: "none" as const, funnelIds: [], paths: [] };
  return {
    status: "ok",
    workspace_id: WORKSPACE_ID,
    data_key: DATA_KEY,
    member_id: memberIdOf(p.userId),
    user_id: p.userId,
    email: `${p.name.toLowerCase()}@example.test`,
    display_name: p.name,
    is_data_owner: p.userId === DATA_KEY,
    raw_access: p.userId === DATA_KEY,
    role: { id: p.role.id, key: p.role.key, name: p.role.name, is_owner: p.role.isOwner, permissions: [...p.role.permissions] },
    funnel_scope: { mode: scope.mode, funnel_ids: [...scope.funnelIds], paths: [...scope.paths] },
    access_version: p.accessVersion,
    partition: `partition-${p.name}-${scope.mode}-${p.accessVersion}`,
    ...overrides,
  };
}

/** The AccessContext the gate would build for the persona (the gate's own parser). */
export function contextFor(p: Persona, requestId = "req-fixture"): AccessContext {
  const row = parseResolveAccessRow(accessRow(p));
  if (!row) throw new Error(`fixture row for ${p.name} did not parse`);
  return buildAccessContext(row, { kind: "user", userId: p.userId, email: `${p.name}@example.test` }, requestId);
}

export function cronContext(requestId = "req-cron"): AccessContext {
  return buildCronAccessContext({ tenantKey: DATA_KEY, requestId });
}

/** An Export API key (the "api-key" persona): the raw bearer value and the
 * api_keys row the handler finds by its sha256. The actor is `creator`; the
 * handler must still read the workspace data key. */
export function apiKeyFixture(name: string, creator: string, extra: Record<string, unknown> = {}) {
  const raw = `subengine_live_${name}_key`;
  return {
    raw,
    row: {
      id: `key-${name}`,
      key_hash: createHash("sha256").update(raw, "utf8").digest("hex"),
      user_id: creator,
      prefix: raw.slice(0, 18),
      is_active: true,
      revoked_at: null,
      allowed_scopes: [EXPORT_API_KEY_SCOPE],
      ...extra,
    } as Record<string, unknown>,
  };
}

// =====================================================================================
// 3. the fake-dependency gate harness
// =====================================================================================

export const GOOD_TOKEN = "good-token";

export const CRON_SECRETS: Readonly<Record<string, string>> = Object.freeze({
  FB_CRON_SECRET: "fb-cron-secret-value",
  SUPPORT_MAIL_SYNC_INTERNAL_SECRET: "support-mail-secret-value",
});

export interface FakeGateOptions {
  persona?: Persona;
  /** Override what resolve_access answers (data). */
  row?: unknown;
  loadAccess?: AccessGateDeps["loadAccess"];
  getUser?: AccessGateDeps["getUser"];
  workspaceDataKey?: AccessGateDeps["workspaceDataKey"];
  secrets?: Record<string, string | undefined>;
  clickhouse?: RecordingClickHouse;
  pg?: unknown;
  requestId?: string;
}

export interface FakeGate {
  deps: AccessGateDeps & {
    getUser: ReturnType<typeof vi.fn>;
    loadAccess: ReturnType<typeof vi.fn>;
    workspaceDataKey: ReturnType<typeof vi.fn>;
    createClickHouse: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
  clickhouse: RecordingClickHouse;
}

export function fakeGate(options: FakeGateOptions = {}): FakeGate {
  const p = options.persona ?? PERSONAS.viewer;
  const clickhouse = options.clickhouse ?? createRecordingClickHouse();
  const pg = options.pg ?? createStrictFakeSupabase({ tenantKey: DATA_KEY, actorKey: p.userId, tables: {} });
  const deps = {
    configError: null,
    pg: pg as AccessGateDeps["pg"],
    getUser: vi.fn(options.getUser ?? (async (token: string) =>
      token === GOOD_TOKEN
        ? { data: { user: { id: p.userId, email: `${p.name}@example.test` } }, error: null }
        : { data: { user: null }, error: { name: "AuthApiError", status: 401, message: "invalid JWT" } })),
    loadAccess: vi.fn(options.loadAccess ?? (async (_userId: string) => ({ data: options.row === undefined ? accessRow(p) : options.row, error: null }))),
    workspaceDataKey: vi.fn(options.workspaceDataKey ?? (async () => ({ data: DATA_KEY, error: null }))),
    readEnv: vi.fn((name: string) => (options.secrets ?? CRON_SECRETS)[name]),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, clickhouse)),
    newRequestId: () => options.requestId ?? "req-security",
    log: vi.fn(),
  };
  return { deps, clickhouse };
}

export interface EdgeRequestInput {
  fn?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  query?: string;
  /** null = no Authorization header. */
  token?: string | null;
  headers?: Record<string, string>;
}

export function edgeRequest(input: EdgeRequestInput = {}) {
  const method = (input.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(input.headers ?? {}) };
  if (input.token !== null) headers.Authorization = `Bearer ${input.token ?? GOOD_TOKEN}`;
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const req = new Request(`https://edge.test/functions/v1/${input.fn ?? "fn"}${input.query ?? ""}`, {
    method,
    headers,
    body: hasBody ? input.rawBody ?? JSON.stringify(input.body ?? {}) : undefined,
  });
  const textSpy = vi.spyOn(req, "text");
  return { req, textSpy };
}

export interface GateCallResult {
  response: Response;
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

export async function readResult(response: Response): Promise<GateCallResult> {
  const text = await response.clone().text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = text ? JSON.parse(text) : null;
    json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  return { response, status: response.status, text, json };
}

export async function callGate<A extends string>(
  policy: FunctionPolicy<A>,
  handler: AccessHandler<A>,
  req: Request,
  deps: AccessGateDeps,
  options?: ServeWithAccessOptions,
): Promise<GateCallResult> {
  return readResult(await handleWithAccess(req, policy, handler, deps, options));
}

/** A handler that records how it was called and proves which tenant the
 * reader binds by issuing one tenant-bound query (TENANT_PROBE_SQL). */
export function probeHandler(options: { query?: boolean } = {}) {
  const seen: Array<{ action: string; ctx: AccessContext; body: Record<string, unknown> }> = [];
  const handler = vi.fn(async (request: { action: string; ctx: AccessContext; body: Record<string, unknown>; clickhouse(): { query(input: { query: string; query_params?: Record<string, unknown> }): Promise<unknown> } }) => {
    seen.push({ action: request.action, ctx: request.ctx, body: request.body });
    if (options.query !== false) {
      await request.clickhouse().query({ query: "SELECT count() AS c FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}" });
    }
    return { ok: true, action: request.action };
  });
  return { handler: handler as unknown as AccessHandler<string>, spy: handler, seen };
}

// =====================================================================================
// 4. the policy registry and one request per canonical action
// =====================================================================================

const POLICY_MODULES = import.meta.glob<Record<string, unknown>>("../../../supabase/functions/_shared/access/policies/*.ts", { eager: true });

export function policyConstName(fn: string): string {
  return `${fn.replace(/-/g, "_").toUpperCase()}_POLICY`;
}

export const ALL_POLICIES: ReadonlyArray<FunctionPolicy<string>> = Object.entries(POLICY_MODULES)
  .map(([path, module]) => {
    const fn = path.split("/").pop()!.replace(/\.ts$/, "");
    const policy = module[policyConstName(fn)] as FunctionPolicy<string> | undefined;
    if (!policy) throw new Error(`policies/${fn}.ts does not export ${policyConstName(fn)}`);
    return policy;
  })
  .sort((a, b) => a.fn.localeCompare(b.fn));

export function policyFor(fn: string): FunctionPolicy<string> {
  const policy = ALL_POLICIES.find((entry) => entry.fn === fn);
  if (!policy) throw new Error(`no policy for ${fn}`);
  return policy;
}

/** Functions that do not use the JWT gate (their entry point is tested directly). */
export const NOT_GATED: Readonly<Record<string, string>> = Object.freeze({
  "export-campaign-performance": "API-key auth: handleExportCampaignPerformance + decideApiKeyAccess",
});

export const GATED_POLICIES = ALL_POLICIES.filter((policy) => !NOT_GATED[policy.fn]);

/** Actions only the scheduler can reach (no user request normalizes to them). */
export const CRON_ONLY_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "clickhouse-facebook": ["cron_daily"],
});

export interface ActionRequest {
  method?: "POST" | "GET";
  body?: Record<string, unknown>;
  query?: string;
}

const post = (body: Record<string, unknown>): ActionRequest => ({ method: "POST", body });
const named = (...actions: string[]) => Object.fromEntries(actions.map((action) => [action, post({ action })]));

/** One request per canonical USER action of every policy. The suite asserts
 * that each one normalizes to its action and that every non-cron-only action
 * has one — a new action without a fixture fails, never silently skipped. */
export const ACTION_REQUESTS: Readonly<Record<string, Readonly<Record<string, ActionRequest>>>> = Object.freeze({
  access: named(
    "catalog", "members.list", "members.add", "members.update", "members.set_scope", "members.effective",
    "roles.list", "roles.create", "roles.update", "roles.delete", "roles.seed_templates", "audit.list", "funnels.list",
  ),
  "ai-analytics": { assistant_answer: post({ action: "assistant_answer", input: { question: "What should I scale?" } }) },
  "capsuled-facebook-sync": { sync: post({ dateFrom: "2026-09-01", dateTo: "2026-09-02", level: "campaign" }) },
  "classify-support-requests": named("status", "start", "continue", "reset"),
  "clickhouse-backfill": {
    continue: post({ mode: "continue" }),
    full_backfill: post({ mode: "full_backfill" }),
    validate_only: post({ mode: "validate_only" }),
    dedup: post({ mode: "dedup" }),
  },
  "clickhouse-cohort-membership": {
    status: post({ action: "status" }),
    rebuild: post({ action: "rebuild" }),
    rebuild_force: post({ action: "rebuild", force: true }),
    validate: post({ action: "validate" }),
  },
  "clickhouse-cohorts": {
    list: post({ action: "list", filters: {} }),
    list_fb_allocation_diagnostics: post({ action: "list", filters: {}, fb_allocation_diagnostics: { enabled: true } }),
    details: post({ action: "details", cohort_key: `${FUNNELS.A.path}|2026-09-01` }),
    options: post({ action: "options" }),
  },
  "clickhouse-facebook": {
    ...named(
      "report", "list", "charts", "filters", "summary", "status", "funnel_spend", "spend_ledger",
      "history_runs", "history_batches", "history_versions", "history_raw_payloads", "history_dq", "recon_history",
      "v2_parity", "v2_dims_status", "source_probe", "sync", "recon_snapshot", "v2_dims_backfill", "seed_campaign_aliases",
      "funnel_suggestions",
    ),
    v2_preview: post({ action: "list", v2_preview: true }),
    funnel_suggestions_apply: post({ action: "funnel_suggestions", apply: true }),
  },
  "clickhouse-health": { health: post({}) },
  "clickhouse-init": { init: post({}) },
  "clickhouse-payment-analytics": {
    bundle: post({ action: "analytics" }),
    banks: post({ action: "banks" }),
    bank_detail: post({ action: "bank_detail", bank: "Sentinel Bank" }),
    ai_pass_rates: post({ action: "analytics", purpose: "ai_pass_rates" }),
  },
  "clickhouse-revenue": named("bundle", "day_breakdown"),
  "clickhouse-summary": { summary: post({}) },
  "clickhouse-support": {
    ...named("bundle", "options", "status", "list", "unanswered_contacts", "export", "sync"),
    details: post({ action: "details", request_id: "req-1" }),
    bundle_search: post({ action: "bundle", filters: { search: "refund" } }),
    list_search: post({ action: "list", filters: { search: "refund" } }),
    unanswered_contacts_search: post({ action: "unanswered_contacts", filters: { search: "refund" } }),
    export_search: post({ action: "export", filters: { search: "refund" } }),
  },
  "clickhouse-users": {
    ...named("list", "summary", "options", "decline"),
    details: post({ action: "details", user_id: "customer-1" }),
    leads_list: post({ action: "leads_list" }),
    leads_overview: post({ action: "leads_overview" }),
  },
  "clickhouse-validate": named("start", "continue", "status", "reset"),
  "dashboard-summary": { summary: post({ filters: {} }) },
  "export-campaign-performance": {
    campaign_performance: { method: "GET", query: "" },
    campaign_performance_geo: { method: "GET", query: "?breakdown=country" },
  },
  "fb-analytics-summary": { summary: post({ filters: {} }) },
  "funnelfox-funnels": { list: post({}), inspect: post({ inspect: "1" }) },
  "funnelfox-leads-sync": { sync: post({}), sync_full_reset: post({ full_reset: true }), dry_run: post({ dry_run: true }) },
  "funnelfox-profile": { profile: post({ id: "profile-1" }), profile_debug: post({ id: "profile-1", debug: "1" }) },
  "funnelfox-subscription": { details: post({ id: "subscription-1" }) },
  "funnelfox-subscriptions": { list: post({}), connection_test: post({ debug: "1" }) },
  "funnelfox-subscriptions-sync": { sync: post({}), sync_full_reset: post({ full_reset: true }), dry_run: post({ dry_run: true }) },
  "reports-generate": {
    generate: post({ action: "generate", report_id: null }),
    regenerate_block: post({ action: "regenerate_block", report_id: null, block_id: "b1" }),
  },
  "sync-support-mail": named(
    "test_connection", "status", "list_folders", "initial_sync", "continue_sync", "sync_new", "stop", "reset_cursor",
    "sent_initial_sync", "sent_continue_sync", "sent_sync_new", "rematch_replies",
  ),
});

export function isCronOnly(policy: FunctionPolicy<string>, action: string): boolean {
  return Boolean(CRON_ONLY_ACTIONS[policy.fn]?.includes(action));
}

/** Every action a user request can reach. */
export function userActions(policy: FunctionPolicy<string>): string[] {
  return Object.keys(policy.actions).filter((action) => !isCronOnly(policy, action));
}

export interface ActionCase {
  fn: string;
  action: string;
  policy: FunctionPolicy<string>;
  rule: ActionPolicy;
  request: ActionRequest;
}

/** [fn, action] rows for it.each — every user action of every gated policy. */
export function gatedActionCases(): ActionCase[] {
  const cases: ActionCase[] = [];
  for (const policy of GATED_POLICIES) {
    for (const action of userActions(policy)) {
      const request = ACTION_REQUESTS[policy.fn]?.[action];
      if (!request) throw new Error(`no request fixture for ${policy.fn}.${action} (add one to ACTION_REQUESTS)`);
      cases.push({ fn: policy.fn, action, policy, rule: policy.actions[action], request });
    }
  }
  return cases;
}

/** The canonical action a fixture request normalizes to (through the policy's own normalizer). */
export function normalizedAction(policy: FunctionPolicy<string>, request: ActionRequest, cron = false): string | null {
  const method = request.method ?? "POST";
  try {
    return policy.normalizeAction({
      method,
      body: method === "GET" ? {} : { ...(request.body ?? {}) },
      url: new URL(`https://edge.test/functions/v1/${policy.fn}${request.query ?? ""}`),
      cron,
    });
  } catch {
    return null;
  }
}

/** True when no grant without a privileged (full-scope) key can satisfy the rule. */
export function needsPrivileged(rule: ActionPolicy): boolean {
  const privileged = (key: string) => closeUnderRequires([key]).some((entry) => isPrivilegedPermission(entry)) || isPrivilegedPermission(key);
  if ((rule.allOf ?? []).some(privileged)) return true;
  if (rule.anyOf) return rule.anyOf.length === 0 || rule.anyOf.every(privileged);
  return false;
}

/** A Milestone-A "data action": reachable by a non-owner, non-raw member with
 * non-privileged permissions — so for a restricted member the ONLY reason left
 * to refuse it is the funnel scope (403 scope_not_supported). */
export function isDataAction(rule: ActionPolicy): boolean {
  return !rule.ownerOnly && !rule.rawOnly && !rule.fullScopeOnly && !needsPrivileged(rule);
}

/** The 403 codes a restricted member may legitimately get for a non-data action. */
export const NON_SCOPE_DENIALS: ReadonlySet<AccessErrorCode> = new Set<AccessErrorCode>([
  ACCESS_ERROR.OWNER_REQUIRED,
  ACCESS_ERROR.RAW_ACCESS_REQUIRED,
  ACCESS_ERROR.PERMISSION_DENIED,
  ACCESS_ERROR.FULL_SCOPE_REQUIRED,
]);

/** The smallest grant that satisfies the rule's permissions (closed under requires). */
export function minimalGrant(rule: ActionPolicy): string[] {
  const keys = [...(rule.allOf ?? [])];
  if (rule.anyOf?.length) keys.push(rule.anyOf.find((key) => !isPrivilegedPermission(key)) ?? rule.anyOf[0]);
  return closeUnderRequires(keys);
}

/** Body keys a malicious caller adds to name another tenant. */
export const TAMPERED_TENANT_FIELDS = Object.freeze({
  auth_user_id: FOREIGN_TENANT,
  authUserId: FOREIGN_TENANT,
  tenant_key: FOREIGN_TENANT,
  tenantKey: FOREIGN_TENANT,
  data_key: FOREIGN_TENANT,
  workspace_id: FOREIGN_TENANT,
});

/** Body keys a restricted caller adds to name funnel B explicitly (#2 / #3). */
export function withExplicitFunnelB(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = body ?? {};
  const filters = base.filters && typeof base.filters === "object" ? (base.filters as Record<string, unknown>) : {};
  return {
    funnel_key: FUNNELS.B.path,
    cohort_key: `${FUNNELS.B.path}|2026-09-01`,
    campaign_path: FUNNELS.B.path,
    funnel_id: FUNNELS.B.id,
    ...base,
    filters: { campaign_path: [FUNNELS.A.path, FUNNELS.B.path], funnel: [FUNNELS.B.path], ...filters },
  };
}

// =====================================================================================
// 5. PGlite workspace: real migrations, real resolve_access, real RLS
// =====================================================================================

export const LOCKDOWN_MIGRATION = "202610050003_access_rls_lockdown.sql";

export interface SeededWorkspace {
  h: SupabasePglite;
  roles: Record<string, string>;
  members: Record<string, string>;
  /** Report ids per author (actor-owned saved objects). */
  reports: { owner: string; viewer: string };
}

export async function one<T = Record<string, unknown>>(tx: SqlRunner, expression: string, params: unknown[] = []): Promise<T> {
  const result = await tx.query<{ value: T }>(`select ${expression} as value`, params);
  return result.rows[0].value;
}

/** Runs `select <expression>` as service_role (what the Edge service client is). */
export function svc<T = Record<string, unknown>>(h: SupabasePglite, expression: string, params: unknown[] = []): Promise<T> {
  return h.asService((tx) => one<T>(tx, expression, params));
}

export const ADD_MEMBER_SQL = "public.access_add_member($1, $2, $3, $4, $5::uuid[], $6)";
export const UPDATE_MEMBER_SQL = "public.access_update_member($1, $2, $3, $4, $5)";
export const SET_SCOPE_SQL = "public.access_set_member_scope($1, $2, $3, $4::uuid[])";
export const CREATE_ROLE_SQL = "public.access_create_role($1, $2, $3, $4, $5::text[])";
export const UPDATE_ROLE_SQL = "public.access_update_role($1, $2, $3, $4, $5::text[])";

/** Tenant rows (one per account) planted before the lockdown, sentinel-valued.
 * Same INSERT shapes as accessRlsLockdown.test.ts. */
const TENANT_ROW_INSERTS: Record<string, string> = {
  transactions: "insert into public.transactions (auth_user_id, transaction_id, event_time) values ($1, $2, now())",
  support_requests: "insert into public.support_requests (auth_user_id, source_row_number, source_hash) values ($1, 1, $2)",
  funnelfox_subscriptions: "insert into public.funnelfox_subscriptions (auth_user_id, subscription_id) values ($1, $2)",
  clickhouse_transaction_sync_state: "insert into public.clickhouse_transaction_sync_state (auth_user_id, sync_name) values ($1, $2)",
  facebook_known_gaps: `insert into public.facebook_known_gaps (auth_user_id, gap_from, gap_to, level, reason)
                        values ($1, current_date, current_date, 'campaign', $2)`,
};

export const TENANT_ROW_TABLES = Object.keys(TENANT_ROW_INSERTS);

const REPORT_INSERT = `insert into public.reports (auth_user_id, title, period_from, period_to, schema_version, engine_version, bindings, snapshot)
                       values ($1, $2, current_date, current_date, 1, 'v1', '{}', '{"kpi": {"net": 1}}') returning id`;

const FORECAST_INSERT = `insert into public.project_forecasts (auth_user_id, name, schema_version, engine_version, source_window_from,
                           source_window_to, source_as_of, bindings, window_ledger, resolved_at)
                         values ($1, $2, 1, 'v1', current_date, current_date, now(), '{}', '{}', now())`;

/** Seeds the workspace through the REAL RPCs: bootstrap (owner = DATA_KEY), the
 * real role templates, and every persona as a member added by the admin. */
export async function seedWorkspace(h: SupabasePglite): Promise<Omit<SeededWorkspace, "h" | "reports">> {
  for (const [name, id] of Object.entries(USER_IDS)) {
    await h.createAuthUser(`${name.toLowerCase()}@example.test`, { id });
  }
  for (const funnel of Object.values(FUNNELS)) {
    await h.db.query("insert into public.funnels (id, funnel_path, display_name) values ($1, $2, $3)", [funnel.id, funnel.rawPath, funnel.name]);
  }
  await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [DATA_KEY]);
  await svc(h, "public.access_seed_role_templates($1, $2::jsonb)", [DATA_KEY, JSON.stringify(seedTemplatesPayload())]);
  const roleRows = await h.db.query<{ id: string; key: string }>("select id::text, key from public.access_roles");
  const roles = Object.fromEntries(roleRows.rows.map((row) => [row.key, row.id]));

  const add = async (actor: string, user: string, roleKey: string, mode: ScopeMode, funnelIds: string[] = []) => {
    const email = `${Object.entries(USER_IDS).find(([, id]) => id === user)![0].toLowerCase()}@example.test`;
    const result = await svc<{ member_id: string }>(h, ADD_MEMBER_SQL, [actor, email, roles[roleKey], mode, funnelIds, null]);
    return result.member_id;
  };
  const ownerMember = (await h.db.query<{ id: string }>("select id::text from public.workspace_members where user_id = $1", [DATA_KEY])).rows[0].id;
  const members: Record<string, string> = { owner: ownerMember };
  members.admin = await add(DATA_KEY, USER_IDS.admin, "admin", "all");
  members.viewer = await add(USER_IDS.admin, USER_IDS.viewer, "viewer", "all");
  members.buyerA = await add(USER_IDS.admin, USER_IDS.buyerA, "media_buyer", "selected", [FUNNELS.A.id]);
  members.buyerAB = await add(USER_IDS.admin, USER_IDS.buyerAB, "media_buyer", "selected", [FUNNELS.A.id, FUNNELS.B.id]);
  members.emptyGrant = await add(USER_IDS.admin, USER_IDS.emptyGrant, "viewer", "selected", []);
  members.noRule = await add(USER_IDS.admin, USER_IDS.noRule, "viewer", "none");
  members.disabled = await add(USER_IDS.admin, USER_IDS.disabled, "viewer", "all");
  await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, members.disabled, null, "disabled", null]);
  return { roles, members };
}

/** Plants tenant rows under the data key AND under other accounts (the private
 * copies G1 produced), plus saved objects per author. Run as postgres BEFORE the
 * lockdown, like production data that already exists. */
export async function seedTenantRows(h: SupabasePglite): Promise<SeededWorkspace["reports"]> {
  const accounts = { owner: DATA_KEY, viewer: USER_IDS.viewer, disabled: USER_IDS.disabled, nonMember: USER_IDS.nonMember, buyerA: USER_IDS.buyerA };
  for (const [label, account] of Object.entries(accounts)) {
    for (const [table, insert] of Object.entries(TENANT_ROW_INSERTS)) {
      await h.db.query(insert, [account, `${table}-${label}-${SENTINEL_EMAILS[0]}-${SENTINEL_SPEND}`]);
    }
    await h.db.query(FORECAST_INSERT, [account, `forecast-${label}`]);
  }
  const ownerReport = await h.db.query<{ id: string }>(REPORT_INSERT, [DATA_KEY, "Owner weekly"]);
  const viewerReport = await h.db.query<{ id: string }>(REPORT_INSERT, [USER_IDS.viewer, "Viewer draft"]);
  return { owner: ownerReport.rows[0].id, viewer: viewerReport.rows[0].id };
}

/** The production end state: every migration before the lockdown, the
 * bootstrap + members + data the lockdown finds, the lockdown, and every
 * migration after it ("folded"). Slow (tens of seconds): build once per file. */
export async function createLockedWorkspace(): Promise<SeededWorkspace> {
  const h = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN_MIGRATION }), extensionStubs: true });
  const seeded = await seedWorkspace(h);
  const reports = await seedTenantRows(h);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN_MIGRATION)) {
    await h.applyMigration(name);
  }
  return { h, ...seeded, reports };
}

/** Bearer token understood by pgliteGateDeps: "user:<auth uuid>". */
export const userToken = (userId: string) => `user:${userId}`;

/** Gate dependencies backed by PGlite: getUser trusts "user:<id>" tokens, and
 * resolve_access / workspace_data_key are the REAL SQL functions, called as
 * service_role on every request (nothing is cached between requests). */
export function pgliteGateDeps(h: SupabasePglite, options: { clickhouse?: RecordingClickHouse; pg?: unknown; secrets?: Record<string, string | undefined> } = {}) {
  const clickhouse = options.clickhouse ?? createRecordingClickHouse();
  const rpc = async (expression: string, params: unknown[]) => {
    try {
      return { data: await svc<unknown>(h, expression, params), error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
  const deps = {
    configError: null,
    pg: (options.pg ?? createStrictFakeSupabase({ tenantKey: DATA_KEY, tables: {} })) as AccessGateDeps["pg"],
    getUser: vi.fn(async (token: string) =>
      token.startsWith("user:")
        ? { data: { user: { id: token.slice(5), email: null } }, error: null }
        : { data: { user: null }, error: { name: "AuthApiError", status: 401, message: "invalid JWT" } }),
    loadAccess: vi.fn((userId: string) => rpc("public.resolve_access($1)", [userId])),
    workspaceDataKey: vi.fn(() => rpc("public.workspace_data_key()", [])),
    readEnv: vi.fn((name: string) => (options.secrets ?? CRON_SECRETS)[name]),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, clickhouse)),
    newRequestId: () => "req-pglite",
    log: vi.fn(),
  };
  return { deps, clickhouse };
}

// ---- an AccessAdminStore over PGlite (the `access` handler end to end) --------------

const RPC_ARGS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = Object.freeze({
  access_add_member: [["p_actor", "uuid"], ["p_email", "text"], ["p_role_id", "uuid"], ["p_scope_mode", "text"], ["p_funnel_ids", "uuid[]"], ["p_display_name", "text"]],
  access_update_member: [["p_actor", "uuid"], ["p_member_id", "uuid"], ["p_role_id", "uuid"], ["p_status", "text"], ["p_display_name", "text"]],
  access_set_member_scope: [["p_actor", "uuid"], ["p_member_id", "uuid"], ["p_mode", "text"], ["p_funnel_ids", "uuid[]"]],
  access_create_role: [["p_actor", "uuid"], ["p_key", "text"], ["p_name", "text"], ["p_description", "text"], ["p_permissions", "text[]"]],
  access_update_role: [["p_actor", "uuid"], ["p_role_id", "uuid"], ["p_name", "text"], ["p_description", "text"], ["p_permissions", "text[]"]],
  access_delete_role: [["p_actor", "uuid"], ["p_role_id", "uuid"]],
  access_seed_role_templates: [["p_actor", "uuid"], ["p_templates", "jsonb"]],
  access_write_audit: [
    ["p_event", "text"], ["p_actor_kind", "text"], ["p_actor_user_id", "uuid"], ["p_target_type", "text"], ["p_target_id", "text"],
    ["p_outcome", "text"], ["p_reason_code", "text"], ["p_before", "jsonb"], ["p_after", "jsonb"], ["p_context", "jsonb"],
  ],
});

/** The production AccessAdminStore contract implemented with SQL as
 * service_role, so createAccessAdminHandler runs against the REAL mutation
 * RPCs (anti-escalation, self-edit, audit) instead of a mock. */
export function createPgliteAccessAdminStore(h: SupabasePglite): AccessAdminStore & { rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> } {
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.asService((tx) => tx.query<T>(sql, params))).rows;
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  return {
    rpcCalls,
    async listMembers(workspaceId, filter = {}) {
      return rows<MemberRow>(
        `select id::text, user_id::text, role_id::text, status, is_data_owner, email_snapshot, display_name,
                access_version::text, added_at::text, last_seen_at::text
         from public.workspace_members where workspace_id = $1 and ($2::uuid is null or id = $2::uuid) order by added_at, id`,
        [workspaceId, filter.memberId ?? null],
      );
    },
    async listRoles(workspaceId) {
      return rows<RoleRow>(
        `select id::text, key, name, description, is_owner, is_system, template_key, permissions
         from public.access_roles where workspace_id = $1 order by id`,
        [workspaceId],
      );
    },
    async listScopeRules(filter = {}) {
      return rows(`select member_id::text, mode from public.member_scope_rules where dimension = 'funnel' and ($1::uuid is null or member_id = $1::uuid)`, [filter.memberId ?? null]);
    },
    async listScopeValues(filter = {}) {
      return rows(
        `select member_id::text, funnel_id::text from public.member_scope_values
         where dimension = 'funnel' and funnel_id is not null and ($1::uuid is null or member_id = $1::uuid) order by id`,
        [filter.memberId ?? null],
      );
    },
    async listFunnels() {
      return rows<FunnelRow>(
        `select f.id::text, f.funnel_path, coalesce(f.display_name, '') as display_name, f.is_active,
                coalesce((select array_agg(t.name order by t.name) from public.funnel_tags ft join public.tags t on t.id = ft.tag_id where ft.funnel_id = f.id), '{}') as tags
         from public.funnels f order by f.funnel_path, f.id`,
      );
    },
    async listAuditEvents(query) {
      return rows<AuditRow>(
        `select id::int as id, occurred_at::text, actor_kind, actor_user_id::text, event, target_type, target_id, outcome,
                reason_code, before, after, context
         from public.access_audit_log
         where workspace_id = $1 and ($2::bigint is null or id < $2::bigint) and ($3::text is null or event = $3::text)
           and ($4::text is null or event like $4::text || '.%') and ($5::text is null or outcome = $5::text)
         order by id desc limit $6`,
        [query.workspaceId, query.beforeId, query.event, query.eventPrefix, query.outcome, query.limit + 1],
      );
    },
    async rpc(fn, params) {
      rpcCalls.push({ fn, params: { ...params } });
      const args = RPC_ARGS[fn];
      if (!args) return { data: null, error: { message: `unknown rpc ${fn}` } };
      const sql = `select public.${fn}(${args.map(([name, type], index) => `${name} => $${index + 1}::${type}`).join(", ")}) as value`;
      const values = args.map(([name, type]) => {
        const value = params[name];
        if (value === undefined || value === null) return null;
        return type === "jsonb" ? JSON.stringify(value) : value;
      });
      try {
        const result = await h.asService((tx) => tx.query<{ value: unknown }>(sql, values));
        return { data: result.rows[0]?.value ?? null, error: null };
      } catch (error) {
        const shaped = error as { code?: string; message?: string };
        return { data: null, error: { code: shaped.code ?? "", message: shaped.message ?? String(error) } };
      }
    },
    async setUserBan() {
      return { ok: true };
    },
  };
}
