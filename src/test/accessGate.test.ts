// The Edge access gate (plan §10, §27). handleWithAccess is the pure core of
// serveWithAccess, driven here with fake dependencies. Each fail-closed rule
// gets a test, and the ORDER of the steps is asserted where it matters for
// security: the cron secret before the body, the session before the body, the
// membership before the handler, violations after it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../supabase/functions/_shared/access/timingSafe.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../supabase/functions/_shared/access/timingSafe.ts")>();
  return { timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

vi.mock("@/services/supabaseClient", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
}));

import {
  ActionNormalizeError,
  assertValidPolicy,
  auditEventFor,
  auditRpcParams,
  denialRpcParams,
  handleWithAccess,
  type AccessGateDeps,
  type AccessRequest,
  type FunctionPolicy,
  type GateAuditEntry,
  type GateDenialEntry,
} from "../../supabase/functions/_shared/access/gate.ts";
import { readFileSync } from "node:fs";
import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES } from "../../supabase/functions/_shared/access/errors.ts";
import { BUILD_ID } from "../../supabase/functions/_shared/access/buildId.ts";
import { timingSafeEqual } from "../../supabase/functions/_shared/access/timingSafe.ts";
import { unverifiedBearerSubject, verifyEdgeBearerSession } from "../../supabase/functions/_shared/clickhouse/auth.ts";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import { ENFORCED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { isWarehouseDownError } from "@/services/clickhouse";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const OTHER = "99999999-9999-4999-8999-999999999999";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CRON_SECRET = "cron-secret-value";

type Action = "read" | "scoped_read" | "raw_read" | "owner_op" | "full_scope_op" | "admin_op" | "member_any" | "cron_tick" | "orphan";

const POLICY: FunctionPolicy<Action> = {
  fn: "test-fn",
  normalizeAction: ({ body, cron }) => {
    if (cron && body.action === undefined) return "cron_tick";
    const action = body.action;
    if (action === "orphan") return "orphan" as Action; // normalizes, but has no policy entry
    if (typeof action === "string" && ["read", "scoped_read", "raw_read", "owner_op", "full_scope_op", "admin_op", "member_any", "cron_tick"].includes(action)) {
      return action as Action;
    }
    throw new ActionNormalizeError();
  },
  actions: {
    read: { anyOf: ["cohorts.view"] },
    scoped_read: { anyOf: ["cohorts.view"], scopeReady: true },
    raw_read: { anyOf: ["transactions.view"], rawOnly: true },
    owner_op: { ownerOnly: true },
    full_scope_op: { anyOf: ["cohorts.view"], fullScopeOnly: true, scopeReady: true },
    admin_op: { allOf: ["admin.users.view", "admin.users.manage"] },
    member_any: {},
    cron_tick: { anyOf: ["admin.sync.run"], write: true },
  } as FunctionPolicy<Action>["actions"],
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["cron_tick", "read"] },
};

interface RowOptions {
  userId?: string;
  status?: string;
  roleKey?: string;
  isOwner?: boolean;
  permissions?: string[];
  scope?: "all" | "selected" | "none" | null;
  rawAccess?: boolean;
}

function accessRow(options: RowOptions = {}) {
  const userId = options.userId ?? EMPLOYEE;
  if (options.status && options.status !== "ok") return { status: options.status, user_id: userId, workspace_id: WORKSPACE };
  const scope = options.scope === undefined ? "all" : options.scope;
  return {
    status: "ok",
    workspace_id: WORKSPACE,
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: userId,
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: userId === DATA_KEY,
    raw_access: options.rawAccess ?? userId === DATA_KEY,
    role: {
      id: "role-1",
      key: options.roleKey ?? "viewer",
      name: "Role",
      is_owner: options.isOwner ?? false,
      permissions: options.permissions ?? ["dashboard.view", "cohorts.view"],
    },
    funnel_scope: scope === null ? null : { mode: scope, funnel_ids: scope === "selected" ? ["f1"] : [], paths: scope === "selected" ? ["soulmate"] : [] },
    access_version: "7",
    partition: "partition-hash",
  };
}

const OWNER_ROW = () => accessRow({ userId: DATA_KEY, roleKey: "owner", isOwner: true, permissions: [] });

function fakeRaw() {
  return {
    query: vi.fn(async (_input: { query: string; query_params?: Record<string, unknown> }) => ({ json: async () => [] as unknown })),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function makeDeps(overrides: Partial<AccessGateDeps> & { row?: unknown; userId?: string } = {}) {
  const { row, userId, ...rest } = overrides;
  const raw = fakeRaw();
  const deps = {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async (token: string) => ({ data: { user: { id: token === "good-token" ? userId ?? EMPLOYEE : null, email: "member@example.com" } }, error: null })),
    loadAccess: vi.fn(async (_userId: string) => ({ data: row === undefined ? accessRow({ userId: userId ?? EMPLOYEE }) : row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn((name: string) => (name === "FB_CRON_SECRET" ? CRON_SECRET : undefined)),
    createClickHouse: vi.fn((ctx) => createScopedReader(ctx, raw)),
    newRequestId: () => "req-test-1",
    log: vi.fn(),
    ...rest,
  };
  return { deps: deps as AccessGateDeps & typeof deps, raw };
}

function request(options: { method?: string; token?: string | null; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? "good-token"}`;
  const method = options.method ?? "POST";
  const body = method === "GET" || method === "OPTIONS" ? undefined : options.rawBody ?? JSON.stringify(options.body ?? { action: "read" });
  const req = new Request("https://edge.test/functions/v1/test-fn?x=1", { method, headers, body });
  const textSpy = vi.spyOn(req, "text");
  return { req, textSpy };
}

const okHandler = vi.fn(async (r: AccessRequest<Action>) => ({ ok: true, action: r.action }));

async function json(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

function expectStamped(response: Response) {
  expect(response.headers.get("x-build-id")).toBe(BUILD_ID);
  expect(response.headers.get("x-request-id")).toBe("req-test-1");
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain("x-build-id");
  expect(response.headers.get("Access-Control-Expose-Headers")).toContain("x-request-id");
}

async function expectDenied(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  const body = await json(response);
  expect(body).toEqual({ ok: false, error_code: code, error: ACCESS_ERROR_MESSAGES[code as keyof typeof ACCESS_ERROR_MESSAGES] });
  expectStamped(response);
}

beforeEach(() => {
  okHandler.mockClear();
  vi.mocked(timingSafeEqual).mockClear();
});

describe("transport rules", () => {
  it("answers OPTIONS with 204 + CORS without touching auth", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request({ method: "OPTIONS" }).req, POLICY, okHandler, deps);
    expect(response.status).toBe(204);
    expectStamped(response);
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(deps.getUser).not.toHaveBeenCalled();
  });

  it("rejects a method outside the policy with 405 before auth", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request({ method: "GET" }).req, POLICY, okHandler, deps);
    expect(response.headers.get("Allow")).toBe("POST");
    await expectDenied(response, 405, ACCESS_ERROR.METHOD_NOT_ALLOWED);
    expect(deps.getUser).not.toHaveBeenCalled();
  });

  it("returns 503 server_not_configured when the live config is missing", async () => {
    const { deps } = makeDeps({ configError: "SUPABASE_URL missing", pg: null });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 503, ACCESS_ERROR.SERVER_NOT_CONFIGURED);
  });
});

describe("authentication", () => {
  it("requires a bearer token and never reads the body without one", async () => {
    const { deps } = makeDeps();
    const { req, textSpy } = request({ token: null });
    await expectDenied(await handleWithAccess(req, POLICY, okHandler, deps), 401, ACCESS_ERROR.INVALID_SESSION);
    expect(deps.getUser).not.toHaveBeenCalled();
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("maps a rejected token to 401 invalid_session (and reads no body)", async () => {
    const { deps } = makeDeps({
      getUser: vi.fn(async () => ({ data: { user: null }, error: { name: "AuthApiError", status: 403, message: "invalid JWT" } })),
    });
    const { req, textSpy } = request({ token: "expired" });
    await expectDenied(await handleWithAccess(req, POLICY, okHandler, deps), 401, ACCESS_ERROR.INVALID_SESSION);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["a retryable fetch error", { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } }],
    ["a 5xx", { data: { user: null }, error: { name: "AuthApiError", status: 500, message: "boom" } }],
    ["a 429", { data: { user: null }, error: { name: "AuthApiError", status: 429, message: "slow down" } }],
    ["a non-JSON gateway page", { data: { user: null }, error: { name: "AuthUnknownError", message: "Unexpected token <" } }],
  ])("maps %s from the auth service to 503 auth_service_error, never 401", async (_label, result) => {
    const { deps } = makeDeps({ getUser: vi.fn(async () => result) });
    const { req, textSpy } = request();
    await expectDenied(await handleWithAccess(req, POLICY, okHandler, deps), 503, ACCESS_ERROR.AUTH_SERVICE_ERROR);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("maps a throwing getUser to 503", async () => {
    const { deps } = makeDeps({ getUser: vi.fn(async () => { throw new TypeError("network down"); }) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 503, ACCESS_ERROR.AUTH_SERVICE_ERROR);
  });

  it("parses the body only after the session is verified", async () => {
    const order: string[] = [];
    const { deps } = makeDeps();
    vi.mocked(deps.getUser).mockImplementation(async () => {
      order.push("getUser");
      return { data: { user: { id: EMPLOYEE, email: null } }, error: null };
    });
    const { req, textSpy } = request();
    textSpy.mockImplementation(async () => {
      order.push("body");
      return JSON.stringify({ action: "read" });
    });
    vi.mocked(deps.loadAccess).mockImplementation(async () => {
      order.push("resolve_access");
      return { data: accessRow(), error: null };
    });
    const response = await handleWithAccess(req, POLICY, okHandler, deps);
    expect(response.status).toBe(200);
    expect(order).toEqual(["getUser", "body", "resolve_access"]);
  });

  it("keeps the legacy verifyEdgeBearerSession contract (401 vs 503)", async () => {
    expect(await verifyEdgeBearerSession({ authorization: null, getUser: async () => ({ data: { user: null } }) })).toMatchObject({ status: 401 });
    expect(await verifyEdgeBearerSession({
      authorization: "Bearer x",
      getUser: async () => ({ data: { user: null }, error: { message: "JWT expired" } }),
    })).toMatchObject({ status: 401, body: { error_code: "invalid_session" } });
    expect(await verifyEdgeBearerSession({
      authorization: "Bearer x",
      getUser: async () => ({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 502 } }),
    })).toMatchObject({ status: 503, body: { error_code: "auth_service_error" } });
  });
});

describe("request parsing and dispatch", () => {
  it("rejects a malformed body with 400 invalid_body", async () => {
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(request({ rawBody: "{not json" }).req, POLICY, okHandler, deps), 400, ACCESS_ERROR.INVALID_BODY);
    await expectDenied(await handleWithAccess(request({ rawBody: "[1,2]" }).req, POLICY, okHandler, deps), 400, ACCESS_ERROR.INVALID_BODY);
    expect(deps.loadAccess).not.toHaveBeenCalled();
  });

  it("rejects an unknown action with 400 before resolving access", async () => {
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(request({ body: { action: "bundle" } }).req, POLICY, okHandler, deps), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    await expectDenied(await handleWithAccess(request({ body: {} }).req, POLICY, okHandler, deps), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    expect(deps.loadAccess).not.toHaveBeenCalled();
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("denies a normalized action that has no policy entry (403)", async () => {
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(request({ body: { action: "orphan" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.POLICY_MISSING);
  });
});

describe("membership resolution", () => {
  it("returns 503 workspace_not_bootstrapped when there is no workspace", async () => {
    const { deps } = makeDeps({ row: accessRow({ status: "no_workspace" }) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 503, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("returns 403 no_membership for a signed-in non-member", async () => {
    const { deps } = makeDeps({ row: accessRow({ status: "no_membership" }) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 403, ACCESS_ERROR.NO_MEMBERSHIP);
  });

  it("returns 403 membership_disabled for a disabled member", async () => {
    const { deps } = makeDeps({ row: accessRow({ status: "disabled" }) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 403, ACCESS_ERROR.MEMBERSHIP_DISABLED);
  });

  it.each([
    ["an RPC error", { data: null, error: { message: "function resolve_access does not exist" } }],
    ["a missing row", { data: null, error: null }],
    ["an unknown status", { data: { status: "maybe", user_id: EMPLOYEE }, error: null }],
    ["an ok row without a data key", { data: { ...accessRow(), data_key: null }, error: null }],
    ["an ok row without a role", { data: { ...accessRow(), role: null }, error: null }],
    ["a row for another user", { data: accessRow({ userId: OTHER }), error: null }],
  ])("fails closed with 503 access_service_error on %s", async (_label, result) => {
    const { deps } = makeDeps({ loadAccess: vi.fn(async () => result) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 503, ACCESS_ERROR.ACCESS_SERVICE_ERROR);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when resolve_access throws", async () => {
    const { deps } = makeDeps({ loadAccess: vi.fn(async () => { throw new Error("pg down"); }) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 503, ACCESS_ERROR.ACCESS_SERVICE_ERROR);
  });

  it("builds the context with the WORKSPACE tenant, not the caller", async () => {
    const { deps } = makeDeps();
    let seen: AccessRequest<Action> | null = null;
    await handleWithAccess(request().req, POLICY, async (r) => { seen = r; return { ok: true }; }, deps);
    const ctx = (seen as unknown as AccessRequest<Action>).ctx;
    expect(deps.loadAccess).toHaveBeenCalledWith(EMPLOYEE);
    expect(ctx.tenantKey).toBe(DATA_KEY);
    expect(ctx.actor).toEqual({ kind: "user", userId: EMPLOYEE, memberId: "44444444-4444-4444-8444-444444444444", email: "member@example.com" });
    expect(ctx.rawAccess).toBe(false);
    expect(ctx.restricted).toBe(false);
    expect(ctx.accessVersion).toBe("7");
    expect(ctx.partition).toBe("partition-hash");
    expect([...ctx.permissions].sort()).toEqual(["cohorts.view", "dashboard.view"]);
  });

  it("grants raw access only to the data owner", async () => {
    const { deps } = makeDeps({ userId: DATA_KEY, row: OWNER_ROW() });
    let rawAccess: boolean | null = null;
    const response = await handleWithAccess(request({ body: { action: "raw_read" } }).req, POLICY, async (r) => {
      rawAccess = r.ctx.rawAccess;
      return { ok: true };
    }, deps);
    expect(response.status).toBe(200);
    expect(rawAccess).toBe(true);
  });

  it("does not grant raw access from the SQL flag alone", async () => {
    const { deps } = makeDeps({ row: accessRow({ isOwner: true, rawAccess: true }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "raw_read" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.RAW_ACCESS_REQUIRED);
  });
});

describe("authorization", () => {
  it("denies an action whose permission is not effective", async () => {
    const { deps } = makeDeps({ row: accessRow({ permissions: ["dashboard.view"] }) });
    await expectDenied(await handleWithAccess(request().req, POLICY, okHandler, deps), 403, ACCESS_ERROR.PERMISSION_DENIED);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("requires every allOf key", async () => {
    const { deps } = makeDeps({ row: accessRow({ permissions: ["admin.users.view"] }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "admin_op" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.PERMISSION_DENIED);
    const allowed = makeDeps({ row: accessRow({ permissions: ["admin.users.view", "admin.users.manage"] }) });
    expect((await handleWithAccess(request({ body: { action: "admin_op" } }).req, POLICY, okHandler, allowed.deps)).status).toBe(200);
  });

  it("does not let a restricted member use privileged keys even if granted", async () => {
    const { deps } = makeDeps({ row: accessRow({ permissions: ["admin.users.view", "admin.users.manage"], scope: "selected" }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "admin_op" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.PERMISSION_DENIED);
  });

  it("rawOnly denies an employee who holds the permission", async () => {
    const { deps } = makeDeps({ row: accessRow({ permissions: ["transactions.view"] }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "raw_read" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.RAW_ACCESS_REQUIRED);
  });

  it("ownerOnly denies a non-owner with every permission and allows the Owner", async () => {
    const { deps } = makeDeps({ row: accessRow({ roleKey: "admin", permissions: [...ENFORCED_PERMISSION_KEYS] }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "owner_op" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.OWNER_REQUIRED);
    const owner = makeDeps({ userId: DATA_KEY, row: OWNER_ROW() });
    expect((await handleWithAccess(request({ body: { action: "owner_op" } }).req, POLICY, okHandler, owner.deps)).status).toBe(200);
  });

  it("fullScopeOnly denies a restricted member even on a scope-ready action", async () => {
    const { deps } = makeDeps({ row: accessRow({ scope: "selected" }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "full_scope_op" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.FULL_SCOPE_REQUIRED);
  });

  it.each(["selected", "none", null] as const)("a restricted context (%s) gets scope_not_supported on non-scope-ready actions", async (scope) => {
    const { deps } = makeDeps({ row: accessRow({ scope }) });
    await expectDenied(await handleWithAccess(request({ body: { action: "read" } }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("a restricted context reaches a scope-ready action", async () => {
    const { deps } = makeDeps({ row: accessRow({ scope: "selected" }) });
    let restricted: boolean | null = null;
    const response = await handleWithAccess(request({ body: { action: "scoped_read" } }).req, POLICY, async (r) => {
      restricted = r.ctx.restricted;
      return { ok: true };
    }, deps);
    expect(response.status).toBe(200);
    expect(restricted).toBe(true);
  });

  it("an action with no permission requirement is open to any active member", async () => {
    const { deps } = makeDeps({ row: accessRow({ permissions: [] }) });
    expect((await handleWithAccess(request({ body: { action: "member_any" } }).req, POLICY, okHandler, deps)).status).toBe(200);
  });
});

describe("handler results and errors", () => {
  it("wraps a plain result as 200 JSON with the stamp headers", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request().req, POLICY, okHandler, deps);
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ ok: true, action: "read" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expectStamped(response);
  });

  it("passes a handler Response through, adding the stamp headers", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request().req, POLICY, async () => new Response("a,b\n1,2", {
      status: 201,
      headers: { "Content-Type": "text/csv", "Access-Control-Expose-Headers": "content-disposition" },
    }), deps);
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("a,b\n1,2");
    expect(response.headers.get("Content-Type")).toBe("text/csv");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("content-disposition");
    expectStamped(response);
  });

  it("shows the data owner the raw 502 warehouse error", async () => {
    const { deps } = makeDeps({ userId: DATA_KEY, row: OWNER_ROW() });
    const response = await handleWithAccess(request().req, POLICY, async () => { throw new Error("ClickHouse HTTP 400: syntax error near FROM"); }, deps);
    expect(response.status).toBe(502);
    expect(await json(response)).toMatchObject({ ok: false, source: "clickhouse", error: "ClickHouse HTTP 400: syntax error near FROM" });
    expectStamped(response);
  });

  it("sanitizes handler errors for everyone else, keeping the status", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request().req, POLICY, async () => { throw new Error("ClickHouse HTTP 400: SELECT secret FROM fact_x"); }, deps);
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-test-1" });
    expect(JSON.stringify(body)).not.toContain("fact_x");
  });

  it("applies onError mappings, sanitized for non-owners", async () => {
    const onError = () => ({ status: 400, body: { ok: false, error: "Unsupported filter: country" } });
    const thrower = async () => { throw new Error("bad filter"); };
    const employee = makeDeps();
    const sanitized = await handleWithAccess(request().req, POLICY, thrower, employee.deps, { onError });
    expect(sanitized.status).toBe(400);
    expect(await json(sanitized)).toEqual({ ok: false, error_code: ACCESS_ERROR.REQUEST_FAILED, error: "Request failed.", request_id: "req-test-1" });

    const owner = makeDeps({ userId: DATA_KEY, row: OWNER_ROW() });
    const raw = await handleWithAccess(request().req, POLICY, thrower, owner.deps, { onError });
    expect(raw.status).toBe(400);
    expect(await json(raw)).toMatchObject({ ok: false, error: "Unsupported filter: country" });
  });

  it("creates the ClickHouse reader lazily, once, and closes it", async () => {
    const { deps, raw } = makeDeps();
    await handleWithAccess(request().req, POLICY, okHandler, deps);
    expect(deps.createClickHouse).not.toHaveBeenCalled();
    await handleWithAccess(request().req, POLICY, async (r) => {
      await r.clickhouse().query({ query: "SELECT 1 FROM fact_x WHERE auth_user_id = {auth_user_id:String}" });
      await r.clickhouse().query({ query: "SELECT 2" });
      return { ok: true };
    }, deps);
    expect(deps.createClickHouse).toHaveBeenCalledTimes(1);
    expect(raw.query.mock.calls[0][0].query_params).toEqual({ auth_user_id: DATA_KEY });
    expect(raw.close).toHaveBeenCalledTimes(1);
  });
});

describe("scope violations", () => {
  it("turns a swallowed violation into 500 even though the handler returned ok", async () => {
    const { deps } = makeDeps({ row: accessRow({ scope: "selected" }) });
    const response = await handleWithAccess(request({ body: { action: "scoped_read" } }).req, POLICY, async (r) => {
      const rows = await r.clickhouse().query({ query: "SELECT * FROM analytics_transactions FINAL" }).catch(() => null);
      return { ok: true, rows };
    }, deps);
    expect(response.status).toBe(500);
    expect(await json(response)).toEqual({ ok: false, error_code: ACCESS_ERROR.SCOPE_VIOLATION, error: "Request failed.", request_id: "req-test-1" });
    expectStamped(response);
  });

  it("turns a tenant-mismatch violation into 500 for the owner too", async () => {
    const { deps } = makeDeps({ userId: DATA_KEY, row: OWNER_ROW() });
    const response = await handleWithAccess(request().req, POLICY, async (r) => {
      await r.clickhouse().query({ query: "SELECT 1 WHERE auth_user_id = {auth_user_id:String}", query_params: { auth_user_id: OTHER } });
      return { ok: true };
    }, deps);
    expect(response.status).toBe(500);
    expect((await json(response)).error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
  });

  it("honours violations recorded directly on the context", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request().req, POLICY, async (r) => {
      r.ctx.violations.push("manual");
      return new Response("fine");
    }, deps);
    expect(response.status).toBe(500);
  });
});

describe("cron branch", () => {
  const cronRequest = (body: unknown = {}, secret = CRON_SECRET, extra: Record<string, string> = {}) =>
    request({ token: null, body, headers: { "x-cron-secret": secret, ...extra } });

  it("authenticates by secret, takes the tenant from the workspace and never calls getUser", async () => {
    const { deps } = makeDeps();
    let seen: AccessRequest<Action> | null = null;
    const response = await handleWithAccess(cronRequest({ auth_user_id: DATA_KEY.toUpperCase() }).req, POLICY, async (r) => {
      seen = r;
      return { ok: true };
    }, deps);
    expect(response.status).toBe(200);
    const r = seen as unknown as AccessRequest<Action>;
    expect(r.action).toBe("cron_tick");
    expect(r.ctx.actor).toEqual({ kind: "cron", userId: null, memberId: null, email: null });
    expect(r.ctx.tenantKey).toBe(DATA_KEY);
    expect(r.ctx.rawAccess).toBe(false);
    expect(r.ctx.restricted).toBe(false);
    expect([...r.ctx.permissions].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());
    expect(deps.getUser).not.toHaveBeenCalled();
    expect(deps.loadAccess).not.toHaveBeenCalled();
  });

  it("compares the secret with timingSafeEqual", async () => {
    const { deps } = makeDeps();
    await handleWithAccess(cronRequest({}, "  cron-secret-value  ").req, POLICY, okHandler, deps);
    expect(timingSafeEqual).toHaveBeenCalledWith(CRON_SECRET, CRON_SECRET);
  });

  it("rejects a wrong secret with 401 before reading the body or the workspace", async () => {
    const { deps } = makeDeps();
    const { req, textSpy } = cronRequest({}, "cron-secret-valuX");
    await expectDenied(await handleWithAccess(req, POLICY, okHandler, deps), 401, ACCESS_ERROR.INVALID_CRON_SECRET);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
    expect(textSpy).not.toHaveBeenCalled();
    expect(deps.workspaceDataKey).not.toHaveBeenCalled();
  });

  it("rejects an empty secret header", async () => {
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(cronRequest({}, "").req, POLICY, okHandler, deps), 401, ACCESS_ERROR.INVALID_CRON_SECRET);
  });

  it("returns 503 cron_not_configured when the secret env is missing, before the body", async () => {
    const { deps } = makeDeps({ readEnv: vi.fn(() => undefined) });
    const { req, textSpy } = cronRequest();
    await expectDenied(await handleWithAccess(req, POLICY, okHandler, deps), 503, ACCESS_ERROR.CRON_NOT_CONFIGURED);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("rejects a body auth_user_id that is not the workspace tenant", async () => {
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(cronRequest({ auth_user_id: OTHER }).req, POLICY, okHandler, deps), 400, ACCESS_ERROR.TENANT_MISMATCH);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("returns 503 when the workspace is missing or the key lookup fails", async () => {
    const missing = makeDeps({ workspaceDataKey: vi.fn(async () => ({ data: null, error: null })) });
    await expectDenied(await handleWithAccess(cronRequest().req, POLICY, okHandler, missing.deps), 503, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED);
    const failing = makeDeps({ workspaceDataKey: vi.fn(async () => ({ data: null, error: { message: "permission denied" } })) });
    await expectDenied(await handleWithAccess(cronRequest().req, POLICY, okHandler, failing.deps), 503, ACCESS_ERROR.ACCESS_SERVICE_ERROR);
  });

  it("only allows the policy's cron actions", async () => {
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(cronRequest({ action: "owner_op" }).req, POLICY, okHandler, deps), 403, ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED);
    expect((await handleWithAccess(cronRequest({ action: "read" }).req, POLICY, okHandler, deps)).status).toBe(200);
  });

  it("ignores the cron header on a function without a cron policy", async () => {
    const { cron: _cron, ...noCron } = POLICY;
    const { deps } = makeDeps();
    await expectDenied(await handleWithAccess(cronRequest().req, noCron as FunctionPolicy<Action>, okHandler, deps), 401, ACCESS_ERROR.INVALID_SESSION);
    expect(deps.workspaceDataKey).not.toHaveBeenCalled();
  });

  it("keeps the cron's handler error text (it holds the secret; the body only lands in net._http_response)", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(cronRequest().req, POLICY, async () => { throw new Error("upstream detail"); }, deps);
    expect(response.status).toBe(502);
    const body = await json(response);
    expect(body.error).toBe("upstream detail");
    expect(body.request_id).toBeTruthy();
    // ...while an employee's body for the same failure stays generic.
    const employee = await handleWithAccess(request({ body: { action: "read" } }).req, POLICY, async () => { throw new Error("upstream detail"); }, deps);
    expect(employee.status).toBe(502);
    expect((await json(employee)).error).toBe("Request failed.");
  });
});

describe("policy validation", () => {
  it("rejects a cron action without an action policy", () => {
    expect(() => assertValidPolicy({ ...POLICY, cron: { header: "x-cron-secret", secretEnv: "S", actions: ["nope" as Action] } })).toThrow(/cron action/);
    expect(() => assertValidPolicy(POLICY)).not.toThrow();
  });
});

describe("error vocabulary", () => {
  const codes = Object.values(ACCESS_ERROR);
  const messages = Object.values(ACCESS_ERROR_MESSAGES);

  it("has a message for every code", () => {
    expect(Object.keys(ACCESS_ERROR_MESSAGES).sort()).toEqual([...codes].sort());
  });

  it("never says 'unavailable' (the frontend breaker matches it)", async () => {
    const authFailures = [
      await verifyEdgeBearerSession({ authorization: null, getUser: async () => ({ data: { user: null } }) }),
      await verifyEdgeBearerSession({ authorization: "Bearer x", getUser: async () => ({ data: { user: null }, error: { message: "bad" } }) }),
      await verifyEdgeBearerSession({ authorization: "Bearer x", getUser: async () => { throw new Error("x"); } }),
    ].map((decision) => JSON.stringify(decision));
    for (const text of [...codes, ...messages, ...authFailures]) {
      expect(text, text).not.toMatch(/unavailable/i);
    }
  });

  it("never trips the frontend warehouse-down breaker", () => {
    for (const text of [...codes, ...messages]) {
      expect(isWarehouseDownError(text), text).toBe(false);
    }
  });
});

// ---- resolve_access in parallel with getUser (plan §10 step 2) ------------------------------

function jwtFor(sub: unknown, extra: Record<string, unknown> = {}): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated", ...extra })}.c2lnbmF0dXJl`;
}

describe("unverifiedBearerSubject", () => {
  it("reads a uuid sub from a JWT-shaped token and nothing else", () => {
    expect(unverifiedBearerSubject(jwtFor(EMPLOYEE))).toBe(EMPLOYEE);
    expect(unverifiedBearerSubject(jwtFor(EMPLOYEE.toUpperCase()))).toBe(EMPLOYEE.toUpperCase());
    for (const token of ["good-token", "", "a.b", "a.b.c.d", jwtFor("not-a-uuid"), jwtFor(42), jwtFor(null), "x.%%%.y", "x.e30.y"]) {
      expect(unverifiedBearerSubject(token), token).toBeNull();
    }
    expect(unverifiedBearerSubject(null)).toBeNull();
    expect(unverifiedBearerSubject(undefined)).toBeNull();
  });
});

describe("resolve_access runs alongside getUser", () => {
  function deferredUser(id: string | null) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const getUser = vi.fn(async () => {
      await gate;
      return id
        ? { data: { user: { id, email: "member@example.com" } }, error: null }
        : { data: { user: null }, error: { name: "AuthApiError", status: 401, message: "invalid JWT" } };
    });
    return { getUser, release };
  }
  const rowFor = vi.fn(async (userId: string) => ({ data: accessRow({ userId }), error: null }));

  beforeEach(() => rowFor.mockClear());

  it("starts resolve_access for the token subject before getUser answers, and uses that row once verified", async () => {
    const user = deferredUser(EMPLOYEE);
    const { deps } = makeDeps({ getUser: user.getUser, loadAccess: rowFor });
    let seen: AccessRequest<Action> | null = null;
    const pending = handleWithAccess(request({ token: jwtFor(EMPLOYEE) }).req, POLICY, async (r) => { seen = r; return { ok: true }; }, deps);
    await vi.waitFor(() => expect(rowFor).toHaveBeenCalledWith(EMPLOYEE));
    expect(seen).toBeNull();
    user.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(rowFor).toHaveBeenCalledTimes(1);
    expect((seen as unknown as AccessRequest<Action>).ctx.actor.userId).toBe(EMPLOYEE);
  });

  it("discards a prefetched row whose subject is not the verified user and resolves the verified one", async () => {
    const user = deferredUser(EMPLOYEE);
    const { deps } = makeDeps({ getUser: user.getUser, loadAccess: rowFor });
    let seen: AccessRequest<Action> | null = null;
    const pending = handleWithAccess(request({ token: jwtFor(OTHER) }).req, POLICY, async (r) => { seen = r; return { ok: true }; }, deps);
    await vi.waitFor(() => expect(rowFor).toHaveBeenCalledWith(OTHER));
    user.release();
    const response = await pending;
    expect(response.status).toBe(200);
    expect(rowFor.mock.calls.map(([id]) => id)).toEqual([OTHER, EMPLOYEE]);
    expect((seen as unknown as AccessRequest<Action>).ctx.actor.userId).toBe(EMPLOYEE);
  });

  it("an invalid token is still 401 and never reaches the handler, whatever the prefetch returned", async () => {
    const user = deferredUser(null);
    const { deps } = makeDeps({ getUser: user.getUser, loadAccess: rowFor });
    const pending = handleWithAccess(request({ token: jwtFor(DATA_KEY) }).req, POLICY, okHandler, deps);
    user.release();
    await expectDenied(await pending, 401, ACCESS_ERROR.INVALID_SESSION);
    expect(okHandler).not.toHaveBeenCalled();
  });

  it("a prefetch that throws is a 503 for the verified user, and a later 400 never leaves it unhandled", async () => {
    const failing = vi.fn(async () => { throw new Error("db down"); });
    const user = deferredUser(EMPLOYEE);
    const { deps } = makeDeps({ getUser: user.getUser, loadAccess: failing });
    const pending = handleWithAccess(request({ token: jwtFor(EMPLOYEE) }).req, POLICY, okHandler, deps);
    user.release();
    await expectDenied(await pending, 503, ACCESS_ERROR.ACCESS_SERVICE_ERROR);
    const bad = deferredUser(EMPLOYEE);
    const second = makeDeps({ getUser: bad.getUser, loadAccess: failing });
    const unknown = handleWithAccess(request({ token: jwtFor(EMPLOYEE), body: { action: "drop" } }).req, POLICY, okHandler, second.deps);
    bad.release();
    await expectDenied(await unknown, 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });
});

// ---- §24 audit: write actions by members, denial counters ---------------------------------------

type AuditAction = "sync_now" | "rebuild" | "view";

const AUDIT_POLICY: FunctionPolicy<AuditAction> = {
  fn: "audit-fn",
  normalizeAction: ({ body }) => {
    if (body.action === "sync_now" || body.action === "rebuild" || body.action === "view") return body.action;
    throw new ActionNormalizeError();
  },
  actions: {
    sync_now: { allOf: ["admin.sync.run"], write: true },
    rebuild: { allOf: ["admin.warehouse.manage"], write: true },
    view: { anyOf: ["cohorts.view"] },
  },
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["sync_now"] },
};

describe("audit of write actions (sync.triggered / warehouse.admin) and denial counters", () => {
  const auditHandler = vi.fn(async (_request: AccessRequest<AuditAction>) => ({ ok: true }));
  const ADMIN = () => accessRow({ permissions: ["cohorts.view", "admin.sync.run", "admin.warehouse.manage"] });

  function auditDeps(row: unknown, extra: Partial<AccessGateDeps> = {}) {
    const writeAudit = vi.fn(async (_entry: GateAuditEntry) => ({ data: 1, error: null }));
    const recordDenial = vi.fn(async (_entry: GateDenialEntry) => ({ data: 1, error: null }));
    const { deps } = makeDeps({ row, writeAudit, recordDenial, ...extra });
    return { deps, writeAudit, recordDenial };
  }

  it("writes one row per write action a member runs, keyed by the actor, event by permission", async () => {
    const { deps, writeAudit } = auditDeps(ADMIN());
    expect((await handleWithAccess(request({ body: { action: "sync_now" } }).req, AUDIT_POLICY, async () => ({ ok: true }), deps)).status).toBe(200);
    expect((await handleWithAccess(request({ body: { action: "rebuild" } }).req, AUDIT_POLICY, async () => ({ ok: true }), deps)).status).toBe(200);
    expect(writeAudit.mock.calls.map(([entry]) => entry)).toEqual([
      { event: "sync.triggered", actorKind: "user", actorUserId: EMPLOYEE, fn: "audit-fn", action: "sync_now", outcome: "success", status: 200, errorCode: null, requestId: "req-test-1" },
      { event: "warehouse.admin", actorKind: "user", actorUserId: EMPLOYEE, fn: "audit-fn", action: "rebuild", outcome: "success", status: 200, errorCode: null, requestId: "req-test-1" },
    ]);
  });

  it("records a failed run as outcome error (the response is unchanged)", async () => {
    const { deps, writeAudit } = auditDeps(ADMIN());
    const response = await handleWithAccess(request({ body: { action: "sync_now" } }).req, AUDIT_POLICY, async () => { throw new Error("boom"); }, deps);
    expect(response.status).toBe(502);
    expect(await json(response)).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-test-1" });
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "sync_now", outcome: "error", status: 502, errorCode: "http_502" }));
  });

  it("does not audit reads, the data owner (behaviour unchanged), the cron, or the access function (audited in SQL)", async () => {
    const reader = auditDeps(ADMIN());
    await handleWithAccess(request({ body: { action: "view" } }).req, AUDIT_POLICY, async () => ({ ok: true }), reader.deps);
    expect(reader.writeAudit).not.toHaveBeenCalled();

    const owner = auditDeps(OWNER_ROW(), { getUser: vi.fn(async () => ({ data: { user: { id: DATA_KEY, email: null } }, error: null })) });
    expect((await handleWithAccess(request({ body: { action: "sync_now" } }).req, AUDIT_POLICY, async () => ({ ok: true }), owner.deps)).status).toBe(200);
    expect(owner.writeAudit).not.toHaveBeenCalled();

    const cron = auditDeps(ADMIN());
    const cronReq = new Request("https://edge.test/functions/v1/audit-fn", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET },
      body: JSON.stringify({ action: "sync_now" }),
    });
    expect((await handleWithAccess(cronReq, AUDIT_POLICY, async () => ({ ok: true }), cron.deps)).status).toBe(200);
    expect(cron.writeAudit).not.toHaveBeenCalled();

    const access = auditDeps(ADMIN());
    await handleWithAccess(request({ body: { action: "sync_now" } }).req, { ...AUDIT_POLICY, fn: "access" }, async () => ({ ok: true }), access.deps);
    expect(access.writeAudit).not.toHaveBeenCalled();
  });

  it("a failing or erroring audit write never changes the response", async () => {
    for (const writeAudit of [
      vi.fn(async () => { throw new Error("audit down"); }),
      vi.fn(async () => ({ data: null, error: { message: "permission denied" } })),
    ]) {
      const { deps } = makeDeps({ row: ADMIN(), writeAudit });
      const response = await handleWithAccess(request({ body: { action: "sync_now" } }).req, AUDIT_POLICY, async () => ({ ok: true, done: 1 }), deps);
      expect(response.status).toBe(200);
      expect(await json(response)).toEqual({ ok: true, done: 1 });
      expect(writeAudit).toHaveBeenCalledTimes(1);
      expect(deps.log).toHaveBeenCalledWith("warn", "access_audit_not_written", expect.objectContaining({ fn: "audit-fn" }));
    }
  });

  it("counts a 403 for an authenticated user, never a 401 / 400 / 5xx", async () => {
    const viewer = auditDeps(accessRow({ permissions: ["cohorts.view"] }));
    await expectDenied(await handleWithAccess(request({ body: { action: "rebuild" } }).req, AUDIT_POLICY, auditHandler, viewer.deps), 403, ACCESS_ERROR.PERMISSION_DENIED);
    expect(viewer.recordDenial.mock.calls.map(([entry]) => entry)).toEqual([
      { actorUserId: EMPLOYEE, fn: "audit-fn", action: "rebuild", errorCode: ACCESS_ERROR.PERMISSION_DENIED, requestId: "req-test-1" },
    ]);

    const restricted = auditDeps(accessRow({ permissions: ["cohorts.view"], scope: "selected" }));
    await expectDenied(await handleWithAccess(request({ body: { action: "view" } }).req, AUDIT_POLICY, auditHandler, restricted.deps), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(restricted.recordDenial).toHaveBeenCalledWith(expect.objectContaining({ action: "view", errorCode: ACCESS_ERROR.SCOPE_NOT_SUPPORTED }));

    const disabled = auditDeps({ status: "disabled", user_id: EMPLOYEE, workspace_id: WORKSPACE });
    await expectDenied(await handleWithAccess(request({ body: { action: "view" } }).req, AUDIT_POLICY, auditHandler, disabled.deps), 403, ACCESS_ERROR.MEMBERSHIP_DISABLED);
    expect(disabled.recordDenial).toHaveBeenCalledWith(expect.objectContaining({ actorUserId: EMPLOYEE, errorCode: ACCESS_ERROR.MEMBERSHIP_DISABLED }));

    const quiet = auditDeps(ADMIN());
    await expectDenied(await handleWithAccess(request({ token: null }).req, AUDIT_POLICY, auditHandler, quiet.deps), 401, ACCESS_ERROR.INVALID_SESSION);
    await expectDenied(await handleWithAccess(request({ body: { action: "nope" } }).req, AUDIT_POLICY, auditHandler, quiet.deps), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    const down = auditDeps(ADMIN(), { loadAccess: vi.fn(async () => ({ data: null, error: { message: "down" } })) });
    await expectDenied(await handleWithAccess(request({ body: { action: "view" } }).req, AUDIT_POLICY, auditHandler, down.deps), 503, ACCESS_ERROR.ACCESS_SERVICE_ERROR);
    expect(quiet.recordDenial).not.toHaveBeenCalled();
    expect(down.recordDenial).not.toHaveBeenCalled();
  });

  it("a failing denial counter never changes the 403", async () => {
    const recordDenial = vi.fn(async () => { throw new Error("counter down"); });
    const { deps } = makeDeps({ row: accessRow({ permissions: ["cohorts.view"] }), recordDenial });
    await expectDenied(await handleWithAccess(request({ body: { action: "rebuild" } }).req, AUDIT_POLICY, auditHandler, deps), 403, ACCESS_ERROR.PERMISSION_DENIED);
    expect(recordDenial).toHaveBeenCalledTimes(1);
  });

  it("maps entries onto the exact SQL parameter names of access_write_audit / access_record_denial", () => {
    const migration = readFileSync("supabase/migrations/202610050002_access_core.sql", "utf8");
    const sqlParams = (fn: string) => {
      const match = new RegExp(`create or replace function public\\.${fn}\\(([\\s\\S]*?)\\)\\s*returns`, "i").exec(migration);
      if (!match) throw new Error(fn);
      return [...match[1].matchAll(/\b(p_[a-z_]+)\b/g)].map((entry) => entry[1]).sort();
    };
    const audit = auditRpcParams({ event: "sync.triggered", actorKind: "user", actorUserId: EMPLOYEE, fn: "f", action: "a", outcome: "success", status: 200, errorCode: null, requestId: "r" });
    expect(Object.keys(audit).sort()).toEqual(sqlParams("access_write_audit"));
    expect(audit).toMatchObject({ p_event: "sync.triggered", p_actor_kind: "user", p_actor_user_id: EMPLOYEE, p_target_type: "edge_function", p_target_id: "f:a", p_outcome: "success" });
    const denial = denialRpcParams({ actorUserId: EMPLOYEE, fn: "f", action: null, errorCode: "permission_denied", requestId: "r" });
    expect(Object.keys(denial).sort()).toEqual(sqlParams("access_record_denial"));
    // The live wiring uses them.
    const http = readFileSync("supabase/functions/_shared/clickhouse/http.ts", "utf8");
    expect(http).toMatch(/callRpc\(client, "access_write_audit", auditRpcParams\(entry\)\)/);
    expect(http).toMatch(/callRpc\(client, "access_record_denial", denialRpcParams\(entry\)\)/);
  });

  it("classifies the event by the action's permissions", () => {
    expect(auditEventFor({ allOf: ["admin.warehouse.manage"], write: true })).toBe("warehouse.admin");
    expect(auditEventFor({ anyOf: ["admin.warehouse.manage", "admin.sync.run"], write: true })).toBe("warehouse.admin");
    expect(auditEventFor({ allOf: ["admin.sync.run"], write: true })).toBe("sync.triggered");
    expect(auditEventFor({ ownerOnly: true, rawOnly: true, write: true })).toBe("sync.triggered");
  });
});
