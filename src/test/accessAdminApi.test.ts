// The access admin API (`access` Edge function, SHARED CONTRACT A; plan §15-§17,
// §24, §27). The index.ts imports esm.sh (via http.ts) and cannot be loaded
// here, so this drives:
//   * ACCESS_POLICY: the action normalizer and the fn × action → requirement
//     table (no open action, nothing scopeReady);
//   * the real gate core (handleWithAccess) with the real handler factory and a
//     fake store: who reaches which action, restricted contexts refused,
//     admin-facing SQL errors kept, service faults sanitized;
//   * the pure core: validation, SQL error mapping, members/roles/audit
//     shaping, effective access, auth bans, template seeding;
//   * the live store adapter over a recording PostgREST fake;
//   * parity of every RPC call with the migration's function signatures.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { assertValidPolicy, handleWithAccess, type AccessGateDeps } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow, type AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import {
  ENFORCED_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  isPrivilegedPermission,
} from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";
import {
  ACCESS_ADMIN_ACTIONS,
  ACCESS_POLICY,
  normalizeAccessAdminAction,
  type AccessAdminAction,
} from "../../supabase/functions/_shared/access/policies/access.ts";
import {
  AUDIT_PAGE_DEFAULT,
  AUDIT_PAGE_MAX,
  AccessAdminError,
  AccessAdminStoreError,
  DISABLED_MEMBER_BAN_DURATION,
  LIFTED_BAN_DURATION,
  accessAdminOnError,
  buildAuditPage,
  createAccessAdminHandler,
  createSupabaseAccessAdminStore,
  deriveRoleKey,
  mapRpcError,
  parseAuditQuery,
  readScopeInput,
  runAccessAdminAction,
  scrubDataKey,
  seedTemplatesPayload,
  type AccessAdminPgClient,
  type AccessAdminStore,
  type AuditQuery,
  type AuditRow,
  type FunnelRow,
  type MemberRow,
  type RoleRow,
  type ScopeRuleRow,
  type ScopeValueRow,
} from "../../supabase/functions/_shared/access/adminApi.ts";

// ---- fixtures ---------------------------------------------------------------------------

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const ADMIN_USER = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const VIEWER_USER = "44444444-4444-4444-8444-444444444444";
const BUYER_USER = "55555555-5555-4555-8555-555555555555";

const OWNER_ROLE = "aaaaaaaa-0000-4000-8000-000000000001";
const ADMIN_ROLE = "aaaaaaaa-0000-4000-8000-000000000002";
const VIEWER_ROLE = "aaaaaaaa-0000-4000-8000-000000000003";
const CUSTOM_ROLE = "aaaaaaaa-0000-4000-8000-000000000004";

const MEMBER_OWNER = "bbbbbbbb-0000-4000-8000-000000000001";
const MEMBER_ADMIN = "bbbbbbbb-0000-4000-8000-000000000002";
const MEMBER_VIEWER = "bbbbbbbb-0000-4000-8000-000000000003";
const MEMBER_BUYER = "bbbbbbbb-0000-4000-8000-000000000004";

const FUNNEL_A = "cccccccc-0000-4000-8000-00000000000a";
const FUNNEL_B = "cccccccc-0000-4000-8000-00000000000b";

const ADMIN_ROLE_PERMISSIONS = ENFORCED_PERMISSION_KEYS.filter((key) => key !== "admin.diagnostics.view");

const ROLES: RoleRow[] = [
  { id: VIEWER_ROLE, key: "viewer", name: "Viewer", description: "Read-only", is_owner: false, is_system: false, template_key: "viewer", permissions: ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"] },
  { id: ADMIN_ROLE, key: "admin", name: "Admin", description: "", is_owner: false, is_system: false, template_key: "admin", permissions: [...ADMIN_ROLE_PERMISSIONS] },
  { id: OWNER_ROLE, key: "owner", name: "Owner", description: "All", is_owner: true, is_system: true, template_key: null, permissions: [] },
  { id: CUSTOM_ROLE, key: "buyer_plus", name: "Buyer plus", description: "", is_owner: false, is_system: false, template_key: null, permissions: ["cohorts.view", "cohorts.export", "admin.users.view"] },
];

const MEMBERS: MemberRow[] = [
  { id: MEMBER_BUYER, user_id: BUYER_USER, role_id: CUSTOM_ROLE, status: "active", is_data_owner: false, email_snapshot: "buyer@example.com", display_name: "", access_version: "4", added_at: "2026-10-04T00:00:00Z", last_seen_at: "2026-10-05T09:00:00Z" },
  { id: MEMBER_OWNER, user_id: DATA_KEY, role_id: OWNER_ROLE, status: "active", is_data_owner: true, email_snapshot: "owner@example.com", display_name: "", access_version: "3", added_at: "2026-10-01T00:00:00Z", last_seen_at: null },
  { id: MEMBER_ADMIN, user_id: ADMIN_USER, role_id: ADMIN_ROLE, status: "active", is_data_owner: false, email_snapshot: "admin@example.com", display_name: "Dana Admin", access_version: "1", added_at: "2026-10-02T00:00:00Z", last_seen_at: null },
  { id: MEMBER_VIEWER, user_id: VIEWER_USER, role_id: VIEWER_ROLE, status: "disabled", is_data_owner: false, email_snapshot: "viewer@example.com", display_name: "", access_version: "9", added_at: "2026-10-03T00:00:00Z", last_seen_at: null },
];

const RULES: ScopeRuleRow[] = [
  { member_id: MEMBER_OWNER, mode: "all" },
  { member_id: MEMBER_ADMIN, mode: "all" },
  { member_id: MEMBER_BUYER, mode: "selected" },
];

const VALUES: ScopeValueRow[] = [
  { member_id: MEMBER_BUYER, funnel_id: FUNNEL_B.toUpperCase() },
  { member_id: MEMBER_BUYER, funnel_id: FUNNEL_A },
  // A stray value without a `selected` rule is ignored (app.member_funnel_ids joins on mode).
  { member_id: MEMBER_VIEWER, funnel_id: FUNNEL_A },
];

const FUNNELS: FunnelRow[] = [
  { id: FUNNEL_B, funnel_path: "past-life", display_name: "", is_active: false, tags: [] },
  { id: FUNNEL_A, funnel_path: "soulmate-sketch", display_name: "Soulmate Sketch", is_active: true, tags: ["WEB", "TikTok", "WEB"] },
];

const OK = (data: Record<string, unknown> = {}) => ({ data: { ok: true, ...data }, error: null });
const SQL_ERROR = (message: string, code = "P0001") => ({ data: null, error: { message, code, details: null, hint: null } });

type RpcImpl = (fn: string, params: Record<string, unknown>) => { data: unknown; error: unknown } | Promise<{ data: unknown; error: unknown }>;

function fakeStore(
  seed: { members?: MemberRow[]; roles?: RoleRow[]; rules?: ScopeRuleRow[]; values?: ScopeValueRow[]; funnels?: FunnelRow[]; audit?: AuditRow[] } = {},
  rpc: RpcImpl = () => OK(),
) {
  const members = seed.members ?? MEMBERS;
  const byMember = <T extends { member_id: string }>(rows: T[], filter: { memberId?: string } = {}) =>
    rows.filter((row) => !filter.memberId || row.member_id.toLowerCase() === filter.memberId.toLowerCase());
  return {
    listMembers: vi.fn(async (_workspaceId: string, filter: { memberId?: string } = {}) => members.filter((member) => !filter.memberId || member.id === filter.memberId)),
    listRoles: vi.fn(async (_workspaceId: string) => seed.roles ?? ROLES),
    listScopeRules: vi.fn(async (filter: { memberId?: string } = {}) => byMember(seed.rules ?? RULES, filter)),
    listScopeValues: vi.fn(async (filter: { memberId?: string } = {}) => byMember(seed.values ?? VALUES, filter)),
    listFunnels: vi.fn(async () => seed.funnels ?? FUNNELS),
    listAuditEvents: vi.fn(async (query: AuditQuery) => (seed.audit ?? []).slice(0, query.limit + 1)),
    rpc: vi.fn(async (fn: string, params: Record<string, unknown>) => rpc(fn, params)),
    setUserBan: vi.fn(async (_userId: string, _duration: string) => ({ ok: true }) as { ok: boolean; reason?: "not_supported" | "failed" }),
  } satisfies AccessAdminStore;
}

type Scope = "all" | "selected" | "none";

function accessRow(options: { userId?: string; permissions?: string[]; isOwner?: boolean; scope?: Scope } = {}) {
  const userId = options.userId ?? ADMIN_USER;
  const scope = options.scope ?? "all";
  return {
    status: "ok",
    workspace_id: WORKSPACE,
    data_key: DATA_KEY,
    member_id: MEMBER_ADMIN,
    user_id: userId,
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: userId === DATA_KEY,
    raw_access: userId === DATA_KEY,
    role: { id: "role-1", key: options.isOwner ? "owner" : "custom", name: "Role", is_owner: options.isOwner ?? false, permissions: options.permissions ?? [] },
    funnel_scope: { mode: scope, funnel_ids: scope === "selected" ? [FUNNEL_A] : [], paths: scope === "selected" ? ["soulmate-sketch"] : [] },
    access_version: "7",
    partition: "partition-hash",
  };
}

const ownerRow = () => accessRow({ userId: DATA_KEY, isOwner: true });
const adminRow = () => accessRow({ permissions: ADMIN_ROLE_PERMISSIONS });
const memberRow = (permissions: string[], scope: Scope = "all") => accessRow({ permissions, scope });

function ctxOf(row: ReturnType<typeof accessRow>): AccessContext {
  const parsed = parseResolveAccessRow(row);
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: row.user_id, email: row.email }, "req-1");
}

const adminCtx = () => ctxOf(adminRow());
const ownerCtx = () => ctxOf(ownerRow());

async function run(action: AccessAdminAction, body: Record<string, unknown>, store: AccessAdminStore, ctx: AccessContext = adminCtx(), log = vi.fn()) {
  return runAccessAdminAction({ ctx, action, body: { action, ...body }, store, log });
}

async function expectAdminError(promise: Promise<unknown>, code: string, status: number): Promise<AccessAdminError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AccessAdminError);
  expect((error as AccessAdminError).code).toBe(code);
  expect((error as AccessAdminError).status).toBe(status);
  return error as AccessAdminError;
}

/** Every RPC call recorded by the fakes, checked against the migration at the end. */
const RPC_CALLS: Array<{ fn: string; params: Record<string, unknown> }> = [];
function recordRpc(store: ReturnType<typeof fakeStore>) {
  for (const [fn, params] of store.rpc.mock.calls) RPC_CALLS.push({ fn, params });
}

// ---- policy -----------------------------------------------------------------------------

describe("ACCESS_POLICY", () => {
  it("is a valid POST-only policy covering exactly the contract actions", () => {
    expect(() => assertValidPolicy(ACCESS_POLICY)).not.toThrow();
    expect(ACCESS_POLICY.fn).toBe("access");
    expect(ACCESS_POLICY.methods).toEqual(["POST"]);
    expect(ACCESS_POLICY.cron).toBeUndefined();
    expect(Object.keys(ACCESS_POLICY.actions).sort()).toEqual([...ACCESS_ADMIN_ACTIONS].sort());
  });

  it("normalizes exactly the named actions and rejects everything else", () => {
    const url = new URL("https://edge.test/functions/v1/access");
    for (const action of ACCESS_ADMIN_ACTIONS) {
      expect(normalizeAccessAdminAction({ method: "POST", body: { action }, url })).toBe(action);
    }
    for (const body of [{}, { action: null }, { action: "" }, { action: "Members.List" }, { action: "members_list" }, { action: "members" }, { action: ["members.list"] }, { action: "__proto__" }]) {
      expect(() => normalizeAccessAdminAction({ method: "POST", body, url })).toThrow(ActionNormalizeError);
    }
  });

  it("maps every action to the agreed requirement", () => {
    expect(ACCESS_POLICY.actions).toEqual({
      catalog: { anyOf: ["admin.users.view", "admin.roles.view", "admin.audit.view"] },
      "members.list": { anyOf: ["admin.users.view"] },
      "members.effective": { anyOf: ["admin.users.view"] },
      "funnels.list": { anyOf: ["admin.users.view"] },
      "members.add": { allOf: ["admin.users.manage"], write: true },
      "members.update": { allOf: ["admin.users.manage"], write: true },
      "members.set_scope": { allOf: ["admin.users.manage"], write: true },
      "roles.list": { anyOf: ["admin.roles.view", "admin.users.view"] },
      "roles.create": { allOf: ["admin.roles.manage"], write: true },
      "roles.update": { allOf: ["admin.roles.manage"], write: true },
      "roles.delete": { allOf: ["admin.roles.manage"], write: true },
      "roles.seed_templates": { ownerOnly: true, allOf: ["admin.roles.manage"], write: true },
      "audit.list": { anyOf: ["admin.audit.view"] },
    });
  });

  it("has no open action, nothing scopeReady, and only privileged (full-scope) permissions", () => {
    for (const [action, policy] of Object.entries(ACCESS_POLICY.actions)) {
      expect(policy.scopeReady, action).toBeFalsy();
      expect(Boolean(policy.anyOf?.length || policy.allOf?.length || policy.ownerOnly || policy.rawOnly), action).toBe(true);
      for (const key of [...(policy.anyOf ?? []), ...(policy.allOf ?? [])]) expect(isPrivilegedPermission(key), `${action}: ${key}`).toBe(true);
      if (policy.write) expect(policy.allOf?.some((key) => key.endsWith(".manage")), action).toBe(true);
    }
  });
});

// ---- through the real gate --------------------------------------------------------------

function gateDeps(row: ReturnType<typeof accessRow>): AccessGateDeps {
  return {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async () => ({ data: { user: { id: row.user_id, email: row.email } }, error: null })),
    loadAccess: vi.fn(async () => ({ data: row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn(() => undefined),
    createClickHouse: vi.fn(() => {
      throw new Error("the access API never opens ClickHouse");
    }),
    newRequestId: () => "req-test-1",
    log: vi.fn(),
  };
}

async function callAccess(body: unknown, row: ReturnType<typeof accessRow>, store: AccessAdminStore = fakeStore(), method = "POST") {
  const req = new Request("https://edge.test/functions/v1/access", {
    method,
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const handler = createAccessAdminHandler({ makeStore: () => store, log: vi.fn() });
  const response = await handleWithAccess(req, ACCESS_POLICY, handler, gateDeps(row), { onError: accessAdminOnError });
  const textBody = await response.text();
  return { status: response.status, text: textBody, body: JSON.parse(textBody) as Record<string, unknown>, headers: response.headers };
}

describe("access function through the gate", () => {
  it("serves members.list to the data owner, emails from email_snapshot and no data_key", async () => {
    const store = fakeStore();
    const result = await callAccess({ action: "members.list" }, ownerRow(), store);
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const members = result.body.members as Array<Record<string, unknown>>;
    expect(members.map((member) => member.email)).toEqual(["owner@example.com", "admin@example.com", "viewer@example.com", "buyer@example.com"]);
    expect(result.text).not.toContain("data_key");
    expect(result.headers.get("x-request-id")).toBe("req-test-1");
    expect(result.headers.get("cache-control")).toBe("no-store");
  });

  it("lets admin.users.view read members, roles, funnels and the catalog, but not write or read the audit log", async () => {
    const row = memberRow(["admin.users.view"]);
    for (const action of ["members.list", "members.effective", "roles.list", "funnels.list", "catalog"]) {
      const result = await callAccess({ action, member_id: MEMBER_BUYER }, row);
      expect(result.status, action).toBe(200);
    }
    const store = fakeStore();
    for (const body of [
      { action: "members.add", email: "x@example.com", role_id: VIEWER_ROLE, scope: { mode: "all" } },
      { action: "members.update", member_id: MEMBER_VIEWER, status: "active" },
      { action: "members.set_scope", member_id: MEMBER_VIEWER, mode: "all" },
      { action: "roles.create", name: "X", permissions: [] },
      { action: "audit.list" },
    ]) {
      const result = await callAccess(body, row, store);
      expect(result.status, body.action).toBe(403);
      expect(result.body.error_code, body.action).toBe(ACCESS_ERROR.PERMISSION_DENIED);
    }
    expect(store.rpc).not.toHaveBeenCalled();
    expect(store.setUserBan).not.toHaveBeenCalled();
  });

  it("refuses members without any admin permission", async () => {
    const result = await callAccess({ action: "catalog" }, memberRow(["dashboard.view", "cohorts.view"]));
    expect(result.status).toBe(403);
    expect(result.body.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
  });

  it("refuses every action to funnel-restricted contexts before the handler runs", async () => {
    for (const scope of ["selected", "none"] as const) {
      const store = fakeStore();
      // admin.* keys are requiresFullScope: a restricted member never holds them.
      const restricted = await callAccess({ action: "members.list" }, memberRow([...ENFORCED_PERMISSION_KEYS], scope), store);
      expect(restricted.status).toBe(403);
      expect(restricted.body.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
      // A (theoretical) restricted Owner role still gets scope_not_supported (R6).
      for (const action of ACCESS_ADMIN_ACTIONS) {
        const owner = await callAccess({ action }, accessRow({ isOwner: true, scope }), store);
        expect(owner.status, action).toBe(403);
        expect(owner.body.error_code, action).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
      }
      expect(store.listMembers).not.toHaveBeenCalled();
      expect(store.rpc).not.toHaveBeenCalled();
    }
  });

  it("keeps template seeding Owner only", async () => {
    const store = fakeStore();
    const admin = await callAccess({ action: "roles.seed_templates" }, adminRow(), store);
    expect(admin.status).toBe(403);
    expect(admin.body.error_code).toBe(ACCESS_ERROR.OWNER_REQUIRED);
    expect(store.rpc).not.toHaveBeenCalled();

    const owner = await callAccess({ action: "roles.seed_templates" }, ownerRow(), fakeStore({}, () => OK({ created: ["viewer"], skipped: ["admin"] })));
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ ok: true, created: ["viewer"], skipped: ["admin"] });
  });

  it("rejects unknown actions and non-POST methods", async () => {
    const unknown = await callAccess({ action: "members.delete" }, ownerRow());
    expect(unknown.status).toBe(400);
    expect(unknown.body.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
    const missing = await callAccess({}, ownerRow());
    expect(missing.status).toBe(400);
    const get = await callAccess(null, ownerRow(), fakeStore(), "GET");
    expect(get.status).toBe(405);
  });

  it("returns admin-facing SQL refusals with their message to non-owner admins", async () => {
    const store = fakeStore({}, () => SQL_ERROR("escalation_denied: only the Owner may modify a member holding privileged permissions"));
    const result = await callAccess({ action: "members.update", member_id: MEMBER_OWNER, status: "disabled" }, adminRow(), store);
    expect(result.status).toBe(403);
    expect(result.body).toEqual({
      ok: false,
      error_code: "escalation_denied",
      error: "only the Owner may modify a member holding privileged permissions",
      request_id: "req-test-1",
    });
    expect(store.setUserBan).not.toHaveBeenCalled();
  });

  it("returns Edge validation errors (with per-key reasons) as 400 invalid", async () => {
    const store = fakeStore();
    const result = await callAccess({ action: "roles.create", name: "Buyer", permissions: ["cohorts.view", "nope.view"] }, adminRow(), store);
    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error_code: "invalid", errors: ["unknown_permission: nope.view"] });
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it("maps service faults to 503 access_service_error and sanitizes them for non-owners", async () => {
    const failing = () => {
      const store = fakeStore();
      store.listMembers.mockRejectedValue(new AccessAdminStoreError("workspace_members: permission denied for table workspace_members"));
      return store;
    };
    const admin = await callAccess({ action: "members.list" }, adminRow(), failing());
    expect(admin.status).toBe(503);
    expect(admin.body).toEqual({ ok: false, error_code: ACCESS_ERROR.ACCESS_SERVICE_ERROR, error: "Request failed.", request_id: "req-test-1" });

    const owner = await callAccess({ action: "members.list" }, ownerRow(), failing());
    expect(owner.status).toBe(503);
    expect(owner.body.error_code).toBe(ACCESS_ERROR.ACCESS_SERVICE_ERROR);
    expect(owner.text).not.toContain("permission denied for table");

    const unmappedRpc = await callAccess({ action: "roles.delete", role_id: CUSTOM_ROLE }, adminRow(), fakeStore({}, () => SQL_ERROR("could not find the function public.access_delete_role", "PGRST202")));
    expect(unmappedRpc.status).toBe(503);
    expect(unmappedRpc.body.error_code).toBe(ACCESS_ERROR.ACCESS_SERVICE_ERROR);

    const bug = fakeStore();
    bug.listRoles.mockRejectedValue(new TypeError("boom"));
    const crashed = await callAccess({ action: "roles.list" }, adminRow(), bug);
    expect(crashed.status).toBe(500);
    expect(crashed.body.error_code).toBe(ACCESS_ERROR.REQUEST_FAILED);
  });
});

// ---- SQL error mapping ------------------------------------------------------------------

describe("mapRpcError", () => {
  it.each([
    ["permission_denied: admin.users.manage is required", "permission_denied", 403, "admin.users.manage is required"],
    ["escalation_denied: cannot grant permissions you do not hold", "escalation_denied", 403, "cannot grant permissions you do not hold"],
    ["not_found: member not found", "not_found", 404, "member not found"],
    ["invalid: the last active Owner cannot be disabled, demoted or removed", "invalid", 400, "the last active Owner cannot be disabled, demoted or removed"],
    ["conflict: the role is assigned to 2 member(s)", "conflict", 409, "the role is assigned to 2 member(s)"],
  ])("maps %s", (message, code, status, detail) => {
    const mapped = mapRpcError({ message, code: "P0001" });
    expect(mapped).toBeInstanceOf(AccessAdminError);
    expect(mapped?.code).toBe(code);
    expect(mapped?.status).toBe(status);
    expect(mapped?.message).toBe(detail);
  });

  it("maps unique violations to 409 and other input faults to 400, with generic messages", () => {
    const unique = mapRpcError({ message: 'duplicate key value violates unique constraint "access_roles_workspace_id_key_key"', code: "23505" });
    expect(unique?.status).toBe(409);
    expect(unique?.code).toBe("conflict");
    expect(unique?.message).not.toContain("access_roles");
    expect(mapRpcError({ message: 'invalid input syntax for type uuid: "x"', code: "22P02" })?.status).toBe(400);
    expect(mapRpcError({ message: "new row violates check constraint", code: "23514" })?.status).toBe(400);
  });

  it("uses a default message when the detail is empty and ignores prefixes on other SQLSTATEs", () => {
    expect(mapRpcError({ message: "not_found:", code: "P0001" })?.message).toBe("Not found.");
    expect(mapRpcError({ message: "invalid: x" })?.code).toBe("invalid");
    expect(mapRpcError({ message: "permission denied for table workspace_members", code: "42501" })).toBeNull();
    expect(mapRpcError({ message: "invalid: looks like ours", code: "XX000" })).toBeNull();
    expect(mapRpcError({ message: "access role missing", code: "P0001" })).toBeNull();
    expect(mapRpcError(null)).toBeNull();
  });
});

// ---- members ----------------------------------------------------------------------------

describe("members.list", () => {
  it("shapes members (role, funnel scope, email_snapshot) in added order", async () => {
    const result = await run("members.list", {}, fakeStore());
    const members = result.members as Array<Record<string, unknown>>;
    expect(members.map((member) => member.id)).toEqual([MEMBER_OWNER, MEMBER_ADMIN, MEMBER_VIEWER, MEMBER_BUYER]);
    expect(members[0]).toEqual({
      id: MEMBER_OWNER,
      user_id: DATA_KEY,
      email: "owner@example.com",
      display_name: "",
      status: "active",
      is_data_owner: true,
      role: { id: OWNER_ROLE, key: "owner", name: "Owner", is_owner: true },
      funnel_scope: { mode: "all", funnel_ids: [] },
      last_seen_at: null,
      access_version: "3",
      added_at: "2026-10-01T00:00:00Z",
    });
    // No rule ⇒ none, even with a stray value row.
    expect(members[2].funnel_scope).toEqual({ mode: "none", funnel_ids: [] });
    // selected ⇒ canonical (lower-cased, sorted, de-duplicated) funnel ids.
    expect(members[3]).toMatchObject({
      email: "buyer@example.com",
      role: { id: CUSTOM_ROLE, key: "buyer_plus", name: "Buyer plus", is_owner: false },
      funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A, FUNNEL_B] },
      last_seen_at: "2026-10-05T09:00:00Z",
    });
  });

  it("reads only the caller's workspace", async () => {
    const store = fakeStore();
    await run("members.list", {}, store);
    expect(store.listMembers).toHaveBeenCalledWith(WORKSPACE, {});
    expect(store.listRoles).toHaveBeenCalledWith(WORKSPACE);
  });
});

describe("members.add", () => {
  const valid = { email: "  Buyer@Example.com ", role_id: CUSTOM_ROLE, scope: { mode: "selected", funnel_ids: [FUNNEL_B.toUpperCase(), FUNNEL_A, FUNNEL_A] }, display_name: " Bea " };

  it.each([
    ["missing email", { ...valid, email: undefined }],
    ["malformed email", { ...valid, email: "not-an-email" }],
    ["bad role id", { ...valid, role_id: "viewer" }],
    ["missing scope", { ...valid, scope: undefined }],
    ["unknown scope mode", { ...valid, scope: { mode: "some" } }],
    ["non-uuid funnel id", { ...valid, scope: { mode: "selected", funnel_ids: ["soulmate-sketch"] } }],
    ["funnel ids without selected", { ...valid, scope: { mode: "all", funnel_ids: [FUNNEL_A] } }],
    ["funnel_ids not an array", { ...valid, scope: { mode: "selected", funnel_ids: FUNNEL_A } }],
    ["display name too long", { ...valid, display_name: "x".repeat(121) }],
    ["display name not a string", { ...valid, display_name: 7 }],
  ])("rejects %s before any RPC", async (_label, body) => {
    const store = fakeStore();
    await expectAdminError(run("members.add", body as Record<string, unknown>, store), "invalid", 400);
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it("calls access_add_member as the caller and returns the member in the list shape", async () => {
    const store = fakeStore({}, () => OK({ member_id: MEMBER_BUYER, member: { member_id: MEMBER_BUYER } }));
    const result = await run("members.add", valid, store);
    expect(store.rpc).toHaveBeenCalledTimes(1);
    expect(store.rpc).toHaveBeenCalledWith("access_add_member", {
      p_actor: ADMIN_USER,
      p_email: "buyer@example.com",
      p_role_id: CUSTOM_ROLE,
      p_scope_mode: "selected",
      p_funnel_ids: [FUNNEL_A, FUNNEL_B],
      p_display_name: "Bea",
    });
    // p_actor is the caller, never the tenant key.
    expect(store.rpc.mock.calls[0][1].p_actor).not.toBe(DATA_KEY);
    expect(result).toMatchObject({ ok: true, member: { id: MEMBER_BUYER, email: "buyer@example.com", funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A, FUNNEL_B] } } });
    recordRpc(store);
  });

  it("falls back to the RPC snapshot when the re-read fails (the add is committed)", async () => {
    const snapshot = { member_id: MEMBER_BUYER, user_id: BUYER_USER, role_id: CUSTOM_ROLE, role_key: "buyer_plus", status: "active", is_data_owner: false, display_name: "Bea", funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A] } };
    const store = fakeStore({}, () => OK({ member_id: MEMBER_BUYER, member: snapshot }));
    store.listMembers.mockRejectedValue(new AccessAdminStoreError("read failed"));
    const result = await run("members.add", valid, store);
    expect(result.member).toEqual({
      id: MEMBER_BUYER,
      user_id: BUYER_USER,
      email: "buyer@example.com",
      display_name: "Bea",
      status: "active",
      is_data_owner: false,
      role: { id: CUSTOM_ROLE, key: "buyer_plus", name: "buyer_plus", is_owner: false },
      funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A] },
      last_seen_at: null,
      access_version: "",
      added_at: null,
    });
  });

  it.each([
    ["escalation_denied: only the Owner may assign a role with privileged permissions", "escalation_denied", 403],
    ["not_found: no user with that email", "not_found", 404],
    ["conflict: the user is already a member", "conflict", 409],
    ["invalid: the user has not confirmed their email", "invalid", 400],
  ])("maps %s", async (message, code, status) => {
    const error = await expectAdminError(run("members.add", valid, fakeStore({}, () => SQL_ERROR(message))), code, status);
    expect(error.message).toBe(message.slice(message.indexOf(":") + 1).trim());
  });

  it("treats a malformed RPC result as a service fault", async () => {
    await expect(run("members.add", valid, fakeStore({}, () => ({ data: null, error: null })))).rejects.toBeInstanceOf(AccessAdminStoreError);
    const store = fakeStore();
    store.rpc.mockRejectedValue(new Error("fetch failed"));
    await expect(run("members.add", valid, store)).rejects.toBeInstanceOf(AccessAdminStoreError);
  });
});

describe("members.update", () => {
  const snapshot = (status: string, userId = VIEWER_USER) => ({ member_id: MEMBER_VIEWER, user_id: userId, role_id: VIEWER_ROLE, role_key: "viewer", status, is_data_owner: false, display_name: "", funnel_scope: { mode: "none", funnel_ids: [] } });

  it("disables through access_update_member, then bans the auth user", async () => {
    const store = fakeStore({}, () => OK({ changed: true, member_id: MEMBER_VIEWER, member: snapshot("disabled") }));
    const result = await run("members.update", { member_id: MEMBER_VIEWER, status: "disabled" }, store);
    expect(store.rpc).toHaveBeenCalledWith("access_update_member", { p_actor: ADMIN_USER, p_member_id: MEMBER_VIEWER, p_role_id: null, p_status: "disabled", p_display_name: null });
    expect(store.setUserBan).toHaveBeenCalledWith(VIEWER_USER, DISABLED_MEMBER_BAN_DURATION);
    expect(DISABLED_MEMBER_BAN_DURATION).toBe("876000h");
    expect(result).toMatchObject({ ok: true, changed: true, member: { id: MEMBER_VIEWER, email: "viewer@example.com" } });
    expect(result.warnings).toBeUndefined();
    // the ban runs only after the RPC accepted the change
    expect(store.rpc.mock.invocationCallOrder[0]).toBeLessThan(store.setUserBan.mock.invocationCallOrder[0]);
    recordRpc(store);
  });

  it("lifts the ban when a member is enabled (idempotent re-send included)", async () => {
    for (const changed of [true, false]) {
      const store = fakeStore({}, () => OK({ changed, member_id: MEMBER_VIEWER, member: snapshot("active") }));
      await run("members.update", { member_id: MEMBER_VIEWER, status: "Active" }, store);
      expect(store.rpc.mock.calls[0][1].p_status).toBe("active");
      expect(store.setUserBan).toHaveBeenCalledWith(VIEWER_USER, LIFTED_BAN_DURATION);
    }
  });

  it("does not touch the auth user when no status is sent", async () => {
    const store = fakeStore({}, () => OK({ changed: true, member_id: MEMBER_VIEWER, member: snapshot("disabled") }));
    await run("members.update", { member_id: MEMBER_VIEWER, role_id: ADMIN_ROLE.toUpperCase(), display_name: "  Vic " }, store);
    expect(store.rpc).toHaveBeenCalledWith("access_update_member", { p_actor: ADMIN_USER, p_member_id: MEMBER_VIEWER, p_role_id: ADMIN_ROLE, p_status: null, p_display_name: "Vic" });
    expect(store.setUserBan).not.toHaveBeenCalled();
  });

  it("never bans when the RPC refuses", async () => {
    const store = fakeStore({}, () => SQL_ERROR("escalation_denied: you cannot modify your own membership"));
    await expectAdminError(run("members.update", { member_id: MEMBER_ADMIN, status: "disabled" }, store), "escalation_denied", 403);
    expect(store.setUserBan).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: "failed" }, "auth_ban_failed"],
    [{ ok: false, reason: "not_supported" }, "auth_ban_not_supported"],
  ] as const)("reports a ban failure (%o) as a warning and audits it", async (ban, warning) => {
    const store = fakeStore({}, (fn) => (fn === "access_write_audit" ? { data: 42, error: null } : OK({ changed: true, member: snapshot("disabled") })));
    store.setUserBan.mockResolvedValue(ban);
    const result = await run("members.update", { member_id: MEMBER_VIEWER, status: "disabled" }, store);
    expect(result.warnings).toEqual([warning]);
    expect(result.ok).toBe(true);
    expect(store.rpc).toHaveBeenCalledWith("access_write_audit", {
      p_event: "member.disabled",
      p_actor_kind: "user",
      p_actor_user_id: ADMIN_USER,
      p_target_type: "member",
      p_target_id: MEMBER_VIEWER,
      p_outcome: "error",
      p_reason_code: warning,
      p_before: null,
      p_after: null,
      p_context: { request_id: "req-1" },
    });
    recordRpc(store);
  });

  it("survives a throwing ban call and a failing audit write", async () => {
    const store = fakeStore({}, (fn) => (fn === "access_write_audit" ? SQL_ERROR("invalid: nope") : OK({ changed: true, member: snapshot("active") })));
    store.setUserBan.mockRejectedValue(new Error("gotrue down"));
    const result = await run("members.update", { member_id: MEMBER_VIEWER, status: "active" }, store);
    expect(result.warnings).toEqual(["auth_unban_failed"]);
  });

  it.each([
    ["missing member_id", { status: "disabled" }],
    ["bad status", { member_id: MEMBER_VIEWER, status: "deleted" }],
    ["bad role id", { member_id: MEMBER_VIEWER, role_id: "admin" }],
  ])("rejects %s", async (_label, body) => {
    const store = fakeStore();
    await expectAdminError(run("members.update", body, store), "invalid", 400);
    expect(store.rpc).not.toHaveBeenCalled();
  });
});

describe("members.set_scope", () => {
  it("calls access_set_member_scope with canonical funnel ids (top-level or nested scope)", async () => {
    for (const body of [
      { member_id: MEMBER_BUYER, mode: "selected", funnel_ids: [FUNNEL_B, FUNNEL_A.toUpperCase()] },
      { member_id: MEMBER_BUYER, scope: { mode: "selected", funnel_ids: [FUNNEL_B, FUNNEL_A] } },
    ]) {
      const store = fakeStore({}, () => OK({ changed: true, member_id: MEMBER_BUYER, funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A, FUNNEL_B] } }));
      const result = await run("members.set_scope", body, store);
      expect(store.rpc).toHaveBeenCalledWith("access_set_member_scope", { p_actor: ADMIN_USER, p_member_id: MEMBER_BUYER, p_mode: "selected", p_funnel_ids: [FUNNEL_A, FUNNEL_B] });
      expect(result).toMatchObject({ ok: true, changed: true, member: { id: MEMBER_BUYER, funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A, FUNNEL_B] } } });
      recordRpc(store);
    }
  });

  it("validates the scope like app.prepare_scope", () => {
    expect(readScopeInput(" ALL ", undefined)).toEqual({ mode: "all", funnelIds: [] });
    expect(readScopeInput("selected", [])).toEqual({ mode: "selected", funnelIds: [] });
    expect(() => readScopeInput("none", [FUNNEL_A])).toThrow(AccessAdminError);
    expect(() => readScopeInput(undefined, [])).toThrow(AccessAdminError);
    const many = Array.from({ length: 1001 }, (_, index) => `cccccccc-0000-4000-8000-${String(index).padStart(12, "0")}`);
    expect(() => readScopeInput("selected", many)).toThrow(/At most 1000/);
  });

  it("maps the privileged-role rule from SQL", async () => {
    const store = fakeStore({}, () => SQL_ERROR("escalation_denied: a member holding privileged permissions requires funnel scope all"));
    await expectAdminError(run("members.set_scope", { member_id: MEMBER_ADMIN, mode: "none" }, store), "escalation_denied", 403);
  });
});

describe("members.effective", () => {
  it("gives the Owner every enforced permission and raw access only to the data owner", async () => {
    const result = await run("members.effective", { member_id: MEMBER_OWNER }, fakeStore());
    expect(result.effective).toEqual({
      status: "active",
      role: { id: OWNER_ROLE, key: "owner", name: "Owner", is_owner: true },
      permissions: [...ENFORCED_PERMISSION_KEYS],
      raw_access: true,
      funnel_scope: { mode: "all", funnel_ids: [], names: [] },
    });
  });

  it("uses effectivePermissions(): privileged keys need scope all, planned/unknown keys never count", async () => {
    const roles = ROLES.map((role) => (role.id === CUSTOM_ROLE ? { ...role, permissions: [...role.permissions, "financials.revenue.view", "made.up"] } : role));
    const result = await run("members.effective", { member_id: MEMBER_BUYER }, fakeStore({ roles }));
    expect(result.effective).toEqual({
      status: "active",
      role: { id: CUSTOM_ROLE, key: "buyer_plus", name: "Buyer plus", is_owner: false },
      permissions: ["cohorts.view", "cohorts.export"],
      raw_access: false,
      funnel_scope: { mode: "selected", funnel_ids: [FUNNEL_A, FUNNEL_B], names: ["Soulmate Sketch", "past-life"] },
    });
  });

  it("drops a key whose prerequisite is missing", async () => {
    const roles = ROLES.map((role) => (role.id === CUSTOM_ROLE ? { ...role, permissions: ["cohorts.export"] } : role));
    const result = await run("members.effective", { member_id: MEMBER_BUYER }, fakeStore({ roles }));
    expect((result.effective as { permissions: string[] }).permissions).toEqual([]);
  });

  it("lists the admin's role permissions (scope all) without raw access", async () => {
    const result = await run("members.effective", { member_id: MEMBER_ADMIN }, fakeStore());
    expect(result.effective).toMatchObject({ permissions: ADMIN_ROLE_PERMISSIONS, raw_access: false, funnel_scope: { mode: "all" } });
  });

  it("gives a disabled member nothing", async () => {
    const result = await run("members.effective", { member_id: MEMBER_VIEWER }, fakeStore());
    expect(result.effective).toMatchObject({ status: "disabled", permissions: [], raw_access: false, funnel_scope: { mode: "none", funnel_ids: [], names: [] } });
  });

  it("never claims raw access for a data-owner flag that does not match the tenant key", async () => {
    const members = MEMBERS.map((member) => (member.id === MEMBER_ADMIN ? { ...member, is_data_owner: true } : member));
    const result = await run("members.effective", { member_id: MEMBER_ADMIN }, fakeStore({ members }));
    expect((result.effective as { raw_access: boolean }).raw_access).toBe(false);
  });

  it("is 404 for an unknown member and 400 for a malformed id", async () => {
    await expectAdminError(run("members.effective", { member_id: "bbbbbbbb-0000-4000-8000-0000000000ff" }, fakeStore()), "not_found", 404);
    await expectAdminError(run("members.effective", { member_id: "me" }, fakeStore()), "invalid", 400);
  });
});

// ---- roles ------------------------------------------------------------------------------

describe("roles", () => {
  it("roles.list: Owner first with every enforced key, member counts, template drift", async () => {
    const result = await run("roles.list", {}, fakeStore());
    const roles = result.roles as Array<Record<string, unknown>>;
    expect(roles.map((role) => role.key)).toEqual(["owner", "admin", "buyer_plus", "viewer"]);
    expect(roles[0]).toMatchObject({ is_owner: true, permissions: [...ENFORCED_PERMISSION_KEYS], member_count: 1, new_permissions_available: 0 });
    expect(roles[1]).toMatchObject({ key: "admin", member_count: 1, new_permissions_available: 1, new_permission_keys: ["admin.diagnostics.view"] });
    expect(roles[2]).toMatchObject({ key: "buyer_plus", member_count: 1, new_permissions_available: 0, new_permission_keys: [] });
    expect(roles[3]).toEqual({
      id: VIEWER_ROLE,
      key: "viewer",
      name: "Viewer",
      description: "Read-only",
      is_owner: false,
      is_system: false,
      template_key: "viewer",
      permissions: ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"],
      member_count: 1,
      new_permissions_available: 0,
      new_permission_keys: [],
    });
  });

  it.each([
    ["unknown permission", { name: "Buyer", permissions: ["cohorts.view", "nope.view"] }, ["unknown_permission: nope.view"]],
    ["planned permission", { name: "Buyer", permissions: ["financials.revenue.view"] }, ["planned_permission: financials.revenue.view"]],
    ["non-string permission", { name: "Buyer", permissions: [42] }, ["invalid_permission: 42"]],
  ])("roles.create rejects an %s with validateRolePermissions errors", async (_label, body, errors) => {
    const store = fakeStore();
    const error = await expectAdminError(run("roles.create", body, store), "invalid", 400);
    expect(error.details).toEqual(errors);
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["permissions not an array", { name: "Buyer", permissions: "cohorts.view" }],
    ["missing name", { permissions: [] }],
    ["blank name", { name: "   ", permissions: [] }],
    ["bad key", { name: "Buyer", key: "Buyer Key", permissions: [] }],
    ["reserved key", { name: "Buyer", key: "owner", permissions: [] }],
    ["long description", { name: "Buyer", description: "x".repeat(501), permissions: [] }],
  ])("roles.create rejects %s", async (_label, body) => {
    const store = fakeStore();
    await expectAdminError(run("roles.create", body, store), "invalid", 400);
    expect(store.rpc).not.toHaveBeenCalled();
  });

  it("roles.create stores the catalog-normalized (requires-closed) set under a derived key", async () => {
    const created = { role_id: "aaaaaaaa-0000-4000-8000-000000000009", key: "media_buyer_eu", name: "Media Buyer (EU)", description: "", is_owner: false, is_system: false, template_key: null, permissions: ["cohorts.view", "cohorts.export"] };
    const store = fakeStore({}, () => OK({ role_id: created.role_id, role: created }));
    const result = await run("roles.create", { name: " Media Buyer (EU) ", permissions: ["cohorts.export"] }, store);
    expect(store.rpc).toHaveBeenCalledWith("access_create_role", {
      p_actor: ADMIN_USER,
      p_key: "media_buyer_eu",
      p_name: "Media Buyer (EU)",
      p_description: "",
      p_permissions: ["cohorts.view", "cohorts.export"],
    });
    // the re-read does not list the new role in this fake: the snapshot is used, count 0
    expect(result.role).toMatchObject({ id: created.role_id, key: "media_buyer_eu", permissions: ["cohorts.view", "cohorts.export"], member_count: 0 });
    recordRpc(store);
  });

  it("roles.create maps a duplicate key to 409", async () => {
    await expectAdminError(run("roles.create", { name: "Viewer", permissions: [] }, fakeStore({}, () => SQL_ERROR("conflict: a role with that key already exists"))), "conflict", 409);
    await expectAdminError(run("roles.create", { name: "Viewer", permissions: [] }, fakeStore({}, () => SQL_ERROR("duplicate key", "23505"))), "conflict", 409);
  });

  it("roles.update sends null for unchanged fields and validates permissions when sent", async () => {
    const store = fakeStore({}, () => OK({ changed: true, role_id: VIEWER_ROLE, role: { role_id: VIEWER_ROLE } }));
    const result = await run("roles.update", { role_id: VIEWER_ROLE, description: "Updated" }, store);
    expect(store.rpc).toHaveBeenCalledWith("access_update_role", { p_actor: ADMIN_USER, p_role_id: VIEWER_ROLE, p_name: null, p_description: "Updated", p_permissions: null });
    expect(result).toMatchObject({ ok: true, changed: true, role: { id: VIEWER_ROLE, member_count: 1 } });
    recordRpc(store);

    const withPermissions = fakeStore({}, () => OK({ changed: true }));
    await run("roles.update", { role_id: VIEWER_ROLE, permissions: ["reports.publish"] }, withPermissions);
    expect(withPermissions.rpc.mock.calls[0][1].p_permissions).toEqual(["reports.view", "reports.edit", "reports.publish"]);

    await expectAdminError(run("roles.update", { role_id: VIEWER_ROLE, name: "" }, fakeStore()), "invalid", 400);
    await expectAdminError(run("roles.update", { role_id: VIEWER_ROLE, permissions: ["x.y"] }, fakeStore()), "invalid", 400);
    await expectAdminError(
      run("roles.update", { role_id: OWNER_ROLE, name: "Boss" }, fakeStore({}, () => SQL_ERROR("invalid: the Owner role is immutable"))),
      "invalid",
      400,
    );
  });

  it("roles.delete", async () => {
    const store = fakeStore({}, () => OK({ role_id: CUSTOM_ROLE }));
    expect(await run("roles.delete", { role_id: CUSTOM_ROLE }, store)).toEqual({ ok: true, role_id: CUSTOM_ROLE });
    expect(store.rpc).toHaveBeenCalledWith("access_delete_role", { p_actor: ADMIN_USER, p_role_id: CUSTOM_ROLE });
    recordRpc(store);
    await expectAdminError(run("roles.delete", { role_id: VIEWER_ROLE }, fakeStore({}, () => SQL_ERROR("conflict: the role is assigned to 1 member(s)"))), "conflict", 409);
  });

  it("roles.seed_templates sends ROLE_TEMPLATES, each validated against the catalog", async () => {
    const store = fakeStore({}, () => OK({ created: ["viewer", "analyst"], skipped: ["admin"] }));
    const result = await run("roles.seed_templates", {}, store, ownerCtx());
    expect(result).toEqual({ ok: true, created: ["viewer", "analyst"], skipped: ["admin"] });
    const [fn, params] = store.rpc.mock.calls[0];
    expect(fn).toBe("access_seed_role_templates");
    expect(params.p_actor).toBe(DATA_KEY); // the Owner caller (here also the data owner)
    expect(params.p_templates).toEqual(ROLE_TEMPLATES.map(({ key, name, description, permissions }) => ({ key, name, description, permissions })));
    for (const template of params.p_templates as Array<{ permissions: string[] }>) {
      for (const key of template.permissions) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
    }
    recordRpc(store);
    expect(() => seedTemplatesPayload([{ key: "bad", name: "Bad", description: "", permissions: ["nope.view"] }])).toThrow(/not valid/);
  });

  it("derives role keys that match the SQL key pattern", () => {
    expect(deriveRoleKey("Viewer")).toBe("viewer");
    expect(deriveRoleKey("Média Buyer — EU")).toBe("media_buyer_eu");
    expect(deriveRoleKey("2024 Buyers")).toBe("role_2024_buyers");
    expect(deriveRoleKey("Owner")).toBe("owner_role");
    expect(deriveRoleKey("X")).toBe("role_x");
    expect(deriveRoleKey("Ёлка")).toMatch(/^role_[0-9a-f]{8}$/);
    const long = deriveRoleKey("A very long role name that keeps going and going and going");
    expect(long.length).toBeLessThanOrEqual(41);
    for (const key of [long, deriveRoleKey("x"), deriveRoleKey("___")]) expect(key).toMatch(/^[a-z][a-z0-9_]{1,40}$/);
  });
});

// ---- audit ------------------------------------------------------------------------------

function auditRow(id: number, overrides: Partial<AuditRow> = {}): AuditRow {
  return {
    id,
    occurred_at: `2026-10-05T00:00:${String(id % 60).padStart(2, "0")}Z`,
    actor_kind: "user",
    actor_user_id: ADMIN_USER,
    event: "member.updated",
    target_type: "member",
    target_id: MEMBER_VIEWER,
    outcome: "success",
    reason_code: null,
    before: null,
    after: null,
    context: {},
    ...overrides,
  };
}

describe("audit.list", () => {
  it("parses filters and paging input", () => {
    expect(parseAuditQuery({}, WORKSPACE)).toEqual({ workspaceId: WORKSPACE, limit: AUDIT_PAGE_DEFAULT, beforeId: null, event: null, eventPrefix: null, outcome: null });
    expect(parseAuditQuery({ limit: 500 }, WORKSPACE).limit).toBe(AUDIT_PAGE_MAX);
    expect(parseAuditQuery({ limit: "25", before_id: "120" }, WORKSPACE)).toMatchObject({ limit: 25, beforeId: 120 });
    expect(parseAuditQuery({ event: "Member.Added" }, WORKSPACE)).toMatchObject({ event: "member.added", eventPrefix: null });
    expect(parseAuditQuery({ event: "api_key" }, WORKSPACE)).toMatchObject({ event: null, eventPrefix: "api_key" });
    expect(parseAuditQuery({ outcome: "denied" }, WORKSPACE).outcome).toBe("denied");
    for (const body of [{ limit: 0 }, { limit: 2.5 }, { limit: "ten" }, { before_id: -1 }, { before_id: "1e3" }, { event: "member added" }, { event: "member.%" }, { outcome: "maybe" }]) {
      expect(() => parseAuditQuery(body, WORKSPACE), JSON.stringify(body)).toThrow(AccessAdminError);
    }
  });

  it("pages newest first by keyset (next_before_id = last id served)", async () => {
    const audit = [auditRow(30), auditRow(29), auditRow(28), auditRow(27)];
    const store = fakeStore({ audit });
    const first = await run("audit.list", { limit: 2 }, store);
    expect(store.listAuditEvents).toHaveBeenCalledWith({ workspaceId: WORKSPACE, limit: 2, beforeId: null, event: null, eventPrefix: null, outcome: null });
    expect((first.events as AuditRow[]).map((event) => event.id)).toEqual([30, 29]);
    expect(first.next_before_id).toBe(29);

    const last = buildAuditPage([auditRow(28), auditRow(27)], 2, MEMBERS, ROLES);
    expect(last.events.map((event) => event.id)).toEqual([28, 27]);
    expect(last.next_before_id).toBeNull();
    expect(buildAuditPage([], 50, MEMBERS, ROLES)).toEqual({ events: [], next_before_id: null });
  });

  it("labels actors and targets from members/roles and scrubs data_key", async () => {
    const rows = [
      auditRow(5, { target_type: "role", target_id: "aaaaaaaa-0000-4000-8000-0000000000dd", event: "role.deleted", before: { role_id: "x", name: "Old role", data_key: DATA_KEY }, after: null }),
      auditRow(4, { target_type: "role", target_id: VIEWER_ROLE, event: "role.updated" }),
      auditRow(3, { target_id: MEMBER_ADMIN, actor_user_id: DATA_KEY, context: { request_id: "r", nested: [{ data_key: DATA_KEY, keep: 1 }] } }),
      auditRow(2, { target_id: MEMBER_VIEWER, actor_user_id: "99999999-9999-4999-8999-999999999999" }),
      auditRow(1, { event: "bootstrap.completed", actor_kind: "system", actor_user_id: null, target_type: "workspace", target_id: WORKSPACE, after: { workspace_id: WORKSPACE, data_key: DATA_KEY } }),
    ];
    const result = await run("audit.list", {}, fakeStore({ audit: rows }));
    const events = result.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.target_label)).toEqual(["Old role", "Viewer", "Dana Admin", "viewer@example.com", null]);
    expect(events.map((event) => event.actor_email)).toEqual(["admin@example.com", "admin@example.com", "owner@example.com", null, null]);
    expect(events[0].before).toEqual({ role_id: "x", name: "Old role" });
    expect(events[2].context).toEqual({ request_id: "r", nested: [{ keep: 1 }] });
    expect(events[4].after).toEqual({ workspace_id: WORKSPACE });
    expect(JSON.stringify(result)).not.toContain("data_key");
    expect(events[0]).toEqual(expect.objectContaining({ id: 5, event: "role.deleted", outcome: "success", reason_code: null, actor_kind: "user" }));
  });

  it("scrubDataKey leaves other values alone", () => {
    expect(scrubDataKey(null)).toBeNull();
    expect(scrubDataKey("data_key")).toBe("data_key");
    expect(scrubDataKey({ a: { data_key: 1, b: [1, { data_key: 2 }] } })).toEqual({ a: { b: [1, {}] } });
  });
});

// ---- catalog / funnels ------------------------------------------------------------------

describe("catalog and funnels.list", () => {
  it("catalog returns the code catalog (planned keys included) and the role templates", async () => {
    const result = await run("catalog", {}, fakeStore());
    expect((result.permissions as Array<{ key: string }>).map((entry) => entry.key)).toEqual(PERMISSION_CATALOG.map((entry) => entry.key));
    expect(result.templates).toEqual(ROLE_TEMPLATES);
  });

  it("funnels.list returns registry rows with sorted, de-duplicated tags", async () => {
    const result = await run("funnels.list", {}, fakeStore());
    expect(result.funnels).toEqual([
      { id: FUNNEL_B, funnel_path: "past-life", display_name: "", is_active: false, tags: [] },
      { id: FUNNEL_A, funnel_path: "soulmate-sketch", display_name: "Soulmate Sketch", is_active: true, tags: ["TikTok", "WEB"] },
    ]);
  });

  it("refuses non-user contexts outright", async () => {
    const cron = { ...adminCtx(), actor: { kind: "cron" as const, userId: null, memberId: null, email: null }, workspaceId: "" };
    await expectAdminError(run("members.list", {}, fakeStore(), cron), "permission_denied", 403);
  });
});

// ---- live store adapter -----------------------------------------------------------------

interface RecordedQuery {
  table: string;
  ops: Array<[string, ...unknown[]]>;
}

function fakePg(tables: Record<string, Array<Record<string, unknown>>>, options: { failTable?: string } = {}) {
  const queries: RecordedQuery[] = [];
  const rpcCalls: Array<{ fn: string; params: unknown; headers: Record<string, string> }> = [];
  const updateUserById = vi.fn(async function (this: unknown, _id: string, _attrs: Record<string, unknown>) {
    return { data: {}, error: null as unknown };
  });
  const admin = { updateUserById };
  const pg = {
    from(table: string) {
      const recorded: RecordedQuery = { table, ops: [] };
      queries.push(recorded);
      let range: [number, number] | null = null;
      const builder: Record<string, unknown> = {};
      for (const op of ["select", "eq", "lt", "like", "order", "limit"]) {
        builder[op] = (...args: unknown[]) => {
          recorded.ops.push([op, ...args]);
          return builder;
        };
      }
      builder.range = (from: number, to: number) => {
        recorded.ops.push(["range", from, to]);
        range = [from, to];
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
        if (options.failTable === table) return Promise.resolve({ data: null, error: { message: "relation does not exist" } }).then(resolve, reject);
        const rows = tables[table] ?? [];
        const data = range ? rows.slice(range[0], range[1] + 1) : rows;
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      };
      return builder;
    },
    rpc(fn: string, params: unknown) {
      const headers: Record<string, string> = {};
      const call = {
        setHeader(name: string, value: string) {
          headers[name] = value;
          return call;
        },
        then(resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) {
          rpcCalls.push({ fn, params, headers: { ...headers } });
          return Promise.resolve({ data: { ok: true }, error: null }).then(resolve, reject);
        },
      };
      return call;
    },
    auth: { admin },
  };
  return { pg: pg as unknown as AccessAdminPgClient, queries, rpcCalls, updateUserById, admin };
}

describe("createSupabaseAccessAdminStore", () => {
  it("reads members of the workspace with explicit columns (no data_key), paging past PostgREST max-rows", async () => {
    const many = Array.from({ length: 1500 }, (_, index) => ({ id: `m-${index}`, user_id: `u-${index}`, role_id: VIEWER_ROLE, status: "active", is_data_owner: false, email_snapshot: `e${index}@x.io`, display_name: null, access_version: 2, added_at: null, last_seen_at: null }));
    const { pg, queries } = fakePg({ workspace_members: many });
    const store = createSupabaseAccessAdminStore(pg, { requestId: "req-9" });
    const members = await store.listMembers(WORKSPACE);
    expect(members).toHaveLength(1500);
    expect(members[1]).toEqual({ id: "m-1", user_id: "u-1", role_id: VIEWER_ROLE, status: "active", is_data_owner: false, email_snapshot: "e1@x.io", display_name: "", access_version: "2", added_at: null, last_seen_at: null });
    expect(queries).toHaveLength(2);
    expect(queries[0].ops).toEqual([
      ["select", "id,user_id,role_id,status,is_data_owner,email_snapshot,display_name,access_version,added_at,last_seen_at"],
      ["eq", "workspace_id", WORKSPACE],
      ["order", "added_at", { ascending: true }],
      ["order", "id", { ascending: true }],
      ["range", 0, 999],
    ]);
    expect(queries[1].ops.at(-1)).toEqual(["range", 1000, 1999]);

    await store.listMembers(WORKSPACE, { memberId: MEMBER_ADMIN });
    expect(queries[2].ops).toContainEqual(["eq", "id", MEMBER_ADMIN]);
  });

  it("filters roles by workspace and scope rows by dimension / member", async () => {
    const { pg, queries } = fakePg({
      access_roles: [{ id: VIEWER_ROLE, key: "viewer", name: "Viewer", description: "", is_owner: false, is_system: false, template_key: "viewer", permissions: ["dashboard.view"] }, { id: null }],
      member_scope_rules: [{ member_id: MEMBER_BUYER, mode: "selected" }],
      member_scope_values: [{ member_id: MEMBER_BUYER, funnel_id: FUNNEL_A }, { member_id: MEMBER_BUYER, funnel_id: null }],
    });
    const store = createSupabaseAccessAdminStore(pg);
    expect(await store.listRoles(WORKSPACE)).toEqual([{ id: VIEWER_ROLE, key: "viewer", name: "Viewer", description: "", is_owner: false, is_system: false, template_key: "viewer", permissions: ["dashboard.view"] }]);
    expect(await store.listScopeRules({ memberId: MEMBER_BUYER })).toEqual([{ member_id: MEMBER_BUYER, mode: "selected" }]);
    expect(await store.listScopeValues()).toEqual([{ member_id: MEMBER_BUYER, funnel_id: FUNNEL_A }]);
    expect(queries[0].ops).toContainEqual(["eq", "workspace_id", WORKSPACE]);
    expect(queries[1].ops).toEqual(expect.arrayContaining([["eq", "dimension", "funnel"], ["eq", "member_id", MEMBER_BUYER]]));
    expect(queries[2].ops).toContainEqual(["eq", "dimension", "funnel"]);
    for (const query of queries) {
      const select = query.ops.find((op) => op[0] === "select");
      expect(String(select?.[1])).not.toContain("data_key");
    }
  });

  it("flattens funnel tags from funnel_tags(tags(name))", async () => {
    const { pg, queries } = fakePg({
      funnels: [{ id: FUNNEL_A, funnel_path: "soulmate-sketch", display_name: "Soulmate", is_active: true, funnel_tags: [{ tags: { name: " WEB " } }, { tags: null }, { tags: [{ name: "TikTok" }] }] }],
    });
    const store = createSupabaseAccessAdminStore(pg);
    expect(await store.listFunnels()).toEqual([{ id: FUNNEL_A, funnel_path: "soulmate-sketch", display_name: "Soulmate", is_active: true, tags: ["WEB", "TikTok"] }]);
    expect(queries[0].ops[0]).toEqual(["select", "id,funnel_path,display_name,is_active,funnel_tags(tags(name))"]);
  });

  it("builds the audit query: workspace, keyset, exact or escaped prefix event, outcome, limit + 1", async () => {
    const { pg, queries } = fakePg({ access_audit_log: [{ id: "7", event: "member.added", outcome: "success", actor_kind: "user" }, { id: "x", event: "bad" }] });
    const store = createSupabaseAccessAdminStore(pg);
    const rows = await store.listAuditEvents({ workspaceId: WORKSPACE, limit: 50, beforeId: 100, event: null, eventPrefix: "api_key", outcome: "denied" });
    expect(rows.map((row) => row.id)).toEqual([7]);
    expect(queries[0].ops).toEqual([
      ["select", "id,occurred_at,actor_kind,actor_user_id,event,target_type,target_id,outcome,reason_code,before,after,context"],
      ["eq", "workspace_id", WORKSPACE],
      ["lt", "id", 100],
      ["like", "event", "api\\_key.%"],
      ["eq", "outcome", "denied"],
      ["order", "id", { ascending: false }],
      ["limit", 51],
    ]);
    await store.listAuditEvents({ workspaceId: WORKSPACE, limit: 10, beforeId: null, event: "member.added", eventPrefix: null, outcome: null });
    expect(queries[1].ops).toContainEqual(["eq", "event", "member.added"]);
    expect(queries[1].ops.some((op) => op[0] === "lt" || op[0] === "like")).toBe(false);
  });

  it("turns read errors into AccessAdminStoreError", async () => {
    const { pg } = fakePg({}, { failTable: "access_roles" });
    await expect(createSupabaseAccessAdminStore(pg).listRoles(WORKSPACE)).rejects.toBeInstanceOf(AccessAdminStoreError);
  });

  it("stamps x-request-id on RPCs", async () => {
    const { pg, rpcCalls } = fakePg({});
    const store = createSupabaseAccessAdminStore(pg, { requestId: "req-42" });
    expect(await store.rpc("access_delete_role", { p_actor: ADMIN_USER, p_role_id: CUSTOM_ROLE })).toEqual({ data: { ok: true }, error: null });
    expect(rpcCalls).toEqual([{ fn: "access_delete_role", params: { p_actor: ADMIN_USER, p_role_id: CUSTOM_ROLE }, headers: { "x-request-id": "req-42" } }]);
    await expect(createSupabaseAccessAdminStore({ from: vi.fn() } as unknown as AccessAdminPgClient).rpc("x", {})).rejects.toBeInstanceOf(AccessAdminStoreError);
  });

  it("bans through auth.admin.updateUserById (method binding kept) and guards a missing admin API", async () => {
    const { pg, updateUserById, admin } = fakePg({});
    const store = createSupabaseAccessAdminStore(pg);
    expect(await store.setUserBan(VIEWER_USER, DISABLED_MEMBER_BAN_DURATION)).toEqual({ ok: true });
    expect(updateUserById).toHaveBeenCalledWith(VIEWER_USER, { ban_duration: "876000h" });
    expect(updateUserById.mock.contexts[0]).toBe(admin);

    updateUserById.mockResolvedValueOnce({ data: {}, error: { message: "User not found" } });
    expect(await store.setUserBan(VIEWER_USER, LIFTED_BAN_DURATION)).toEqual({ ok: false, reason: "failed" });
    updateUserById.mockRejectedValueOnce(new Error("network"));
    expect(await store.setUserBan(VIEWER_USER, LIFTED_BAN_DURATION)).toEqual({ ok: false, reason: "failed" });

    const bare = createSupabaseAccessAdminStore({ from: vi.fn(), auth: {} } as unknown as AccessAdminPgClient);
    expect(await bare.setUserBan(VIEWER_USER, DISABLED_MEMBER_BAN_DURATION)).toEqual({ ok: false, reason: "not_supported" });
  });
});

// ---- parity with the migration and the entrypoint ------------------------------------

describe("SQL and entrypoint parity", () => {
  const migration = readFileSync(resolve(process.cwd(), "supabase/migrations/202610050002_access_core.sql"), "utf8");

  function sqlParams(fn: string): string[] {
    const match = new RegExp(`create or replace function public\\.${fn}\\(([\\s\\S]*?)\\)\\s*returns`, "i").exec(migration);
    if (!match) throw new Error(`public.${fn} not found in the migration`);
    return [...match[1].matchAll(/\b(p_[a-z_]+)\b/g)].map((entry) => entry[1]);
  }

  it("every RPC this API calls exists with exactly the parameters it sends, and is granted to service_role", () => {
    const fns = new Set(RPC_CALLS.map((call) => call.fn));
    expect([...fns].sort()).toEqual([
      "access_add_member",
      "access_create_role",
      "access_delete_role",
      "access_seed_role_templates",
      "access_set_member_scope",
      "access_update_member",
      "access_update_role",
      "access_write_audit",
    ]);
    for (const call of RPC_CALLS) {
      expect(Object.keys(call.params).sort(), call.fn).toEqual(sqlParams(call.fn).sort());
      expect(migration).toMatch(new RegExp(`grant execute on function public\\.${call.fn}\\([^)]*\\) to service_role;`));
    }
  });

  it("index.ts is a thin serveWithAccess wrapper on ACCESS_POLICY", () => {
    const source = readFileSync(resolve(process.cwd(), "supabase/functions/access/index.ts"), "utf8");
    expect(source).toContain("serveWithAccess(ACCESS_POLICY");
    expect(source).toContain('from "../_shared/access/policies/access.ts"');
    expect(source).toContain('from "../_shared/access/adminApi.ts"');
    expect(source).toContain("onError: accessAdminOnError");
    for (const banned of ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "data_key", "auth.id"]) {
      expect(source, banned).not.toContain(banned);
    }
  });

  it("the policy and the core stay importable by vitest (no remote imports)", () => {
    for (const file of ["supabase/functions/_shared/access/policies/access.ts", "supabase/functions/_shared/access/adminApi.ts"]) {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(source, file).not.toMatch(/from\s+["']https?:/);
      expect(source, file).not.toContain("Deno.");
    }
  });

  it("no admin-facing message trips the frontend warehouse breaker words", () => {
    const source = readFileSync(resolve(process.cwd(), "supabase/functions/_shared/access/adminApi.ts"), "utf8");
    const messages = [...source.matchAll(/"([^"\n]{12,})"/g)].map((entry) => entry[1]).filter((message) => /[A-Z].* /.test(message));
    for (const message of messages) {
      expect(message).not.toMatch(/unavailable|timed out|timeout|network error|connection (reset|refused|closed)|bad gateway/i);
    }
  });
});
