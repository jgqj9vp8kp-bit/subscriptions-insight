// Access migration of the Support Edge functions (plan §7 rows "Support" and
// "Support admin"; §10, §12.7–12.8, §18 search oracle, §23, §27 — Milestone A).
//
// All three policies are driven through the pure gate core (handleWithAccess)
// with fake dependencies, so these tests prove who may call which action, that a
// free-text search is its own action needing support.messages.view, that every
// funnel-restricted context is refused, that the pg_cron / pg_net ticks are
// authenticated by the internal secret (before the body is read) and bound to
// the workspace tenant instead of a looked-up "mailbox owner", that error bodies
// stay the owner's while employees get generic ones, that the status diagnostics
// are redacted for page viewers, and that the support runners no longer swallow
// a ScopeViolation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertValidPolicy,
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
  type ServeWithAccessOptions,
} from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow, type AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  CLICKHOUSE_SUPPORT_POLICY,
  SUPPORT_SEARCH_ACTIONS,
  normalizeClickHouseSupportAction,
  projectSupportStatusForViewer,
  supportReadOf,
  supportStatusDetailVisible,
  type ClickHouseSupportAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-support.ts";
import {
  SUPPORT_MAIL_CRON_ACTIONS,
  SUPPORT_MAIL_INTERNAL_SECRET_ENV,
  SUPPORT_MAIL_INTERNAL_SECRET_HEADER,
  SYNC_SUPPORT_MAIL_POLICY,
  normalizeSyncSupportMailAction,
  type SyncSupportMailAction,
} from "../../supabase/functions/_shared/access/policies/sync-support-mail.ts";
import {
  CLASSIFY_SUPPORT_REQUESTS_POLICY,
  classifySupportRequestsErrorResponse,
  normalizeClassifySupportRequestsAction,
  type ClassifySupportRequestsAction,
} from "../../supabase/functions/_shared/access/policies/classify-support-requests.ts";
import {
  SupportRequestError,
  clickHouseSupportErrorResponse,
  normalizeSupportRequest,
  runSupportList,
  runSupportStatus,
} from "../../supabase/functions/_shared/clickhouse/support.ts";
import { supportSearchTerm } from "../../supabase/functions/_shared/clickhouse/supportContract.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { buildSupportRequest } from "@/services/supportDataSource";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const INTERNAL_SECRET = "support-mail-internal-secret-value";
const SECRET_HOST = "https://secret-warehouse.clickhouse.cloud:8443";

type Scope = "all" | "selected" | "none";

function accessRow(options: { userId?: string; permissions?: string[]; isOwner?: boolean; scope?: Scope } = {}) {
  const userId = options.userId ?? EMPLOYEE;
  const scope = options.scope ?? "all";
  return {
    status: "ok",
    workspace_id: WORKSPACE,
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: userId,
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: userId === DATA_KEY,
    raw_access: userId === DATA_KEY,
    role: { id: "role-1", key: options.isOwner ? "owner" : "custom", name: "Role", is_owner: options.isOwner ?? false, permissions: options.permissions ?? [] },
    funnel_scope: { mode: scope, funnel_ids: scope === "selected" ? ["55555555-5555-4555-8555-555555555555"] : [], paths: scope === "selected" ? ["soulmate"] : [] },
    access_version: "7",
    partition: "partition-hash",
  };
}

const ownerRow = (scope: Scope = "all") => accessRow({ userId: DATA_KEY, isOwner: true, scope });
const memberRow = (permissions: string[], scope: Scope = "all") => accessRow({ permissions, scope });

function makeDeps(row: ReturnType<typeof accessRow>, env: Record<string, string> = {}): AccessGateDeps {
  const raw: ClickHouseClientLike = {
    query: vi.fn(async () => ({ json: async () => [] as unknown })),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
  return {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async () => ({ data: { user: { id: row.user_id, email: "member@example.com" } }, error: null })),
    loadAccess: vi.fn(async () => ({ data: row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn((name: string) => env[name]),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, raw)),
    newRequestId: () => "req-test-1",
    log: vi.fn(),
  };
}

const echoHandler = () =>
  vi.fn(async ({ action, ctx }: { action: string; ctx: AccessContext }) => ({ ok: true, action, tenant: ctx.tenantKey, actor: ctx.actor.kind }));

async function call<A extends string>(
  policy: FunctionPolicy<A>,
  body: unknown,
  row: ReturnType<typeof accessRow>,
  options: { handler?: ReturnType<typeof echoHandler>; serve?: ServeWithAccessOptions; headers?: Record<string, string> } = {},
) {
  const handler = options.handler ?? echoHandler();
  const deps = makeDeps(row);
  const req = new Request(`https://edge.test/functions/v1/${policy.fn}`, {
    method: "POST",
    headers: options.headers ?? { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleWithAccess(req, policy, handler as unknown as AccessHandler<A>, deps, options.serve);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, handler, deps };
}

async function expectAllowed<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: ReturnType<typeof accessRow>, action: A) {
  const result = await call(policy, body, row);
  expect(result.status, `${String(action)} should be allowed: ${JSON.stringify(body)}`).toBe(200);
  // The handler always sees the workspace data key as tenant, never the caller.
  expect(result.body).toEqual({ ok: true, action, tenant: DATA_KEY, actor: "user" });
}

async function expectDenied<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: ReturnType<typeof accessRow>, status: number, code?: string) {
  const result = await call(policy, body, row);
  expect(result.status, JSON.stringify(body)).toBe(status);
  if (code) expect(result.body.error_code, JSON.stringify(body)).toBe(code);
  expect(result.handler).not.toHaveBeenCalled();
  return result;
}

// One body per canonical clickhouse-support action (the browser's own request
// builder for the filtered reads, so the tests see what the page really sends).
const PAGE_QUERY = { page: 1, pageSize: 50, sortBy: "received_at" as const, sortDir: "desc" as const, filters: { dateFrom: "2026-09-01" } };
const SEARCH_QUERY = { ...PAGE_QUERY, filters: { ...PAGE_QUERY.filters, search: "jane@" } };
const SUPPORT_BODIES: Record<ClickHouseSupportAction, Record<string, unknown>> = {
  bundle: buildSupportRequest(PAGE_QUERY, "bundle") as Record<string, unknown>,
  bundle_search: buildSupportRequest(SEARCH_QUERY, "bundle") as Record<string, unknown>,
  options: { action: "options" },
  status: { action: "status" },
  list: buildSupportRequest(PAGE_QUERY, "list") as Record<string, unknown>,
  list_search: buildSupportRequest(SEARCH_QUERY, "list") as Record<string, unknown>,
  details: { action: "details", request_id: "req-1" },
  unanswered_contacts: buildSupportRequest(PAGE_QUERY, "unanswered_contacts") as Record<string, unknown>,
  unanswered_contacts_search: buildSupportRequest(SEARCH_QUERY, "unanswered_contacts") as Record<string, unknown>,
  export: buildSupportRequest(PAGE_QUERY, "export") as Record<string, unknown>,
  export_search: buildSupportRequest(SEARCH_QUERY, "export") as Record<string, unknown>,
  sync: { action: "sync", sync: { batch_size: 2000, max_batches: 20, full_reset_cursor: false } },
};
const SUPPORT_ACTIONS = Object.keys(SUPPORT_BODIES) as ClickHouseSupportAction[];

const MAIL_ACTIONS: SyncSupportMailAction[] = [
  "test_connection",
  "status",
  "list_folders",
  "initial_sync",
  "continue_sync",
  "sync_new",
  "stop",
  "reset_cursor",
  "sent_initial_sync",
  "sent_continue_sync",
  "sent_sync_new",
  "rematch_replies",
];
const CLASSIFY_ACTIONS: ClassifySupportRequestsAction[] = ["start", "continue", "status", "reset"];

// ---- policy tables -----------------------------------------------------------------

describe("policy tables", () => {
  it("are valid and cover every action", () => {
    for (const policy of [CLICKHOUSE_SUPPORT_POLICY, SYNC_SUPPORT_MAIL_POLICY, CLASSIFY_SUPPORT_REQUESTS_POLICY] as FunctionPolicy<string>[]) {
      expect(() => assertValidPolicy(policy)).not.toThrow();
      expect(policy.methods).toEqual(["POST"]);
    }
    expect(CLICKHOUSE_SUPPORT_POLICY.fn).toBe("clickhouse-support");
    expect(SYNC_SUPPORT_MAIL_POLICY.fn).toBe("sync-support-mail");
    expect(CLASSIFY_SUPPORT_REQUESTS_POLICY.fn).toBe("classify-support-requests");
    expect(Object.keys(CLICKHOUSE_SUPPORT_POLICY.actions).sort()).toEqual([...SUPPORT_ACTIONS].sort());
    expect(Object.keys(SYNC_SUPPORT_MAIL_POLICY.actions).sort()).toEqual([...MAIL_ACTIONS].sort());
    expect(Object.keys(CLASSIFY_SUPPORT_REQUESTS_POLICY.actions).sort()).toEqual([...CLASSIFY_ACTIONS].sort());
  });

  it("clickhouse-support matches the Phase-1 permission table exactly", () => {
    const MESSAGES = ["support.messages.view"];
    expect(CLICKHOUSE_SUPPORT_POLICY.actions).toEqual({
      bundle: { anyOf: ["support.view"] },
      bundle_search: { allOf: MESSAGES },
      options: { anyOf: ["support.view"] },
      status: { anyOf: ["support.view"] },
      list: { allOf: MESSAGES },
      list_search: { allOf: MESSAGES },
      details: { allOf: MESSAGES },
      // A bulk contact-address export (plan §21): support.export, like export.
      unanswered_contacts: { allOf: ["support.export"] },
      unanswered_contacts_search: { allOf: ["support.export", "support.messages.view"] },
      export: { allOf: ["support.export"] },
      export_search: { allOf: ["support.export", "support.messages.view"] },
      sync: { allOf: ["admin.sync.run"], write: true },
    });
    expect(CLICKHOUSE_SUPPORT_POLICY.cron).toBeUndefined();
    // Every search variant names support.messages.view itself.
    expect([...SUPPORT_SEARCH_ACTIONS].sort()).toEqual(["bundle_search", "export_search", "list_search", "unanswered_contacts_search"]);
    for (const action of SUPPORT_SEARCH_ACTIONS) expect(CLICKHOUSE_SUPPORT_POLICY.actions[action].allOf).toContain("support.messages.view");
  });

  it("sync-support-mail and classify-support-requests: admin.sync.run on every user action; cron = the internal secret", () => {
    for (const action of MAIL_ACTIONS) {
      expect(SYNC_SUPPORT_MAIL_POLICY.actions[action]).toEqual(
        action === "status" || action === "list_folders" ? { allOf: ["admin.sync.run"] } : { allOf: ["admin.sync.run"], write: true },
      );
    }
    expect(CLASSIFY_SUPPORT_REQUESTS_POLICY.actions).toEqual({
      status: { allOf: ["admin.sync.run"] },
      start: { allOf: ["admin.sync.run"], write: true },
      continue: { allOf: ["admin.sync.run"], write: true },
      reset: { allOf: ["admin.sync.run"], write: true },
    });
    // The header / secret names the pg_net ticks already use.
    expect(SUPPORT_MAIL_INTERNAL_SECRET_HEADER).toBe("x-support-mail-internal-secret");
    expect(SUPPORT_MAIL_INTERNAL_SECRET_ENV).toBe("SUPPORT_MAIL_SYNC_INTERNAL_SECRET");
    expect(SYNC_SUPPORT_MAIL_POLICY.cron).toEqual({
      header: "x-support-mail-internal-secret",
      secretEnv: "SUPPORT_MAIL_SYNC_INTERNAL_SECRET",
      actions: ["sync_new", "sent_initial_sync", "sent_continue_sync", "rematch_replies"],
    });
    expect(CLASSIFY_SUPPORT_REQUESTS_POLICY.cron).toEqual({
      header: "x-support-mail-internal-secret",
      secretEnv: "SUPPORT_MAIL_SYNC_INTERNAL_SECRET",
      actions: ["continue"],
    });
  });

  it("the cron action lists are exactly what the migrations send", () => {
    const sql = ["202607290002_support_mail_cron.sql", "202609030002_support_sent_backfill_tick.sql", "202609030004_support_contact_rematch.sql"]
      .map((file) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8"))
      .join("\n");
    for (const action of SUPPORT_MAIL_CRON_ACTIONS) expect(sql).toContain(`'${action}'`);
    const classifySql = readFileSync(resolve(process.cwd(), "supabase/migrations/202607300002_support_classification_cron.sql"), "utf8");
    expect(classifySql).toContain("'action', 'continue'");
    expect(classifySql).toContain("'x-support-mail-internal-secret'");
  });

  it("no action is scopeReady, none is 'any active member', every key is an enforced permission", () => {
    for (const policy of [CLICKHOUSE_SUPPORT_POLICY, SYNC_SUPPORT_MAIL_POLICY, CLASSIFY_SUPPORT_REQUESTS_POLICY] as FunctionPolicy<string>[]) {
      for (const entry of Object.values(policy.actions)) {
        expect(entry.scopeReady).toBeFalsy();
        const keys = [...(entry.anyOf ?? []), ...(entry.allOf ?? [])];
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
      }
    }
  });
});

// ---- normalizers -------------------------------------------------------------------

describe("canonical action normalizers (rule R3)", () => {
  const url = new URL("https://edge.test");
  const support = (body: Record<string, unknown>) => normalizeClickHouseSupportAction({ method: "POST", body, url, cron: false });
  const mail = (body: Record<string, unknown>, cron = false) => normalizeSyncSupportMailAction({ method: "POST", body, url, cron });
  const classify = (body: Record<string, unknown>, cron = false) => normalizeClassifySupportRequestsAction({ method: "POST", body, url, cron });

  it("clickhouse-support maps every body to its policy key and back to its runner", () => {
    for (const action of SUPPORT_ACTIONS) expect(support(SUPPORT_BODIES[action])).toBe(action);
    expect(supportReadOf("bundle_search")).toBe("bundle");
    expect(supportReadOf("list_search")).toBe("list");
    expect(supportReadOf("unanswered_contacts_search")).toBe("unanswered_contacts");
    expect(supportReadOf("export_search")).toBe("export");
    for (const action of ["bundle", "options", "status", "list", "details", "unanswered_contacts", "export", "sync"] as const) {
      expect(supportReadOf(action)).toBe(action);
    }
  });

  it("a search is decided by the SQL builder's own term — blank is not a search, anything else is", () => {
    // The page always sends search: "" — that must stay a plain read.
    expect(SUPPORT_BODIES.bundle.filters).toMatchObject({ search: "" });
    for (const search of ["", "   ", "\n\t", null, undefined]) expect(support({ action: "bundle", filters: { search } })).toBe("bundle");
    for (const search of ["a", "  jane@  ", 0, false, { nested: true }, "x".repeat(400)]) {
      expect(support({ action: "bundle", filters: { search } }), JSON.stringify(search)).toBe("bundle_search");
      expect(support({ action: "list", filters: { search } })).toBe("list_search");
    }
    // Reads that never apply filters keep their action.
    for (const action of ["details", "options", "status", "sync"]) expect(support({ action, filters: { search: "jane" } })).toBe(action);
    expect(support({ action: "bundle" })).toBe("bundle");
    expect(support({ action: "bundle", filters: null })).toBe("bundle");
  });

  it("supportSearchTerm is exactly the term normalizeSupportRequest applies", () => {
    const cases: unknown[] = [
      undefined,
      null,
      {},
      [],
      "a string",
      { search: "" },
      { search: "  padded  " },
      { search: 42 },
      { search: false },
      { search: { nested: true } },
      { search: "y".repeat(500) },
    ];
    for (const filters of cases) {
      const applied = normalizeSupportRequest({ action: "bundle", filters: filters as never }).filters.search;
      expect(supportSearchTerm(filters), JSON.stringify(filters)).toBe(applied);
    }
    expect(supportSearchTerm({ search: "  padded  " })).toBe("padded");
    expect(supportSearchTerm({ search: "y".repeat(500) })).toHaveLength(300);
  });

  it("clickhouse-support rejects missing, unknown, derived, mis-cased and non-string actions (no bundle default)", () => {
    for (const body of [
      {},
      { action: null },
      { action: "" },
      { action: "BUNDLE" },
      { action: "bundle_search" },
      { action: "list_search" },
      { action: "drop_table" },
      { action: 5 },
      { action: ["bundle"] },
    ]) {
      expect(() => support(body as Record<string, unknown>), JSON.stringify(body)).toThrow(ActionNormalizeError);
    }
  });

  it("sync-support-mail: exact action names on both branches, no sync_new default", () => {
    for (const action of MAIL_ACTIONS) {
      expect(mail({ action })).toBe(action);
      expect(mail({ internal: true, action }, true)).toBe(action);
    }
    for (const body of [{}, { action: null }, { internal: true }, { action: "SYNC_NEW" }, { action: "sync" }, { action: "toString" }, { action: 1 }]) {
      expect(() => mail(body as Record<string, unknown>), JSON.stringify(body)).toThrow(ActionNormalizeError);
      expect(() => mail(body as Record<string, unknown>, true), JSON.stringify(body)).toThrow(ActionNormalizeError);
    }
  });

  it("classify-support-requests: exact action names, no status default, no case-folding", () => {
    for (const action of CLASSIFY_ACTIONS) {
      expect(classify({ action })).toBe(action);
      expect(classify({ internal: true, action }, true)).toBe(action);
    }
    for (const body of [{}, { action: null }, { action: "START" }, { action: "run" }, { action: "constructor" }, { action: 0 }]) {
      expect(() => classify(body as Record<string, unknown>), JSON.stringify(body)).toThrow(ActionNormalizeError);
    }
  });
});

// ---- gate decisions ----------------------------------------------------------------

describe("gate decisions — clickhouse-support", () => {
  const ROLES: Array<{ name: string; permissions: string[]; allowed: ClickHouseSupportAction[] }> = [
    { name: "Support viewer", permissions: ["support.view"], allowed: ["bundle", "options", "status"] },
    {
      name: "Messages viewer",
      permissions: ["support.view", "support.messages.view"],
      allowed: ["bundle", "bundle_search", "options", "status", "list", "list_search", "details"],
    },
    { name: "Exporter", permissions: ["support.view", "support.messages.view", "support.export"], allowed: SUPPORT_ACTIONS.filter((action) => action !== "sync") },
    // support.export without its requires is not effective (§8).
    { name: "Export key alone", permissions: ["support.export"], allowed: [] },
    { name: "Sync runner", permissions: ["admin.sync.run"], allowed: ["sync"] },
    { name: "Viewer template", permissions: ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"], allowed: [] },
  ];

  it.each(ROLES)("$name reaches exactly its actions", async ({ permissions, allowed }) => {
    for (const action of SUPPORT_ACTIONS) {
      if (allowed.includes(action)) await expectAllowed(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES[action], memberRow(permissions), action);
      else await expectDenied(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES[action], memberRow(permissions), 403, ACCESS_ERROR.PERMISSION_DENIED);
    }
  });

  it("a support.view reader cannot probe message content through the bundle's counts", async () => {
    const result = await expectDenied(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES.bundle_search, memberRow(["support.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    expect(result.deps.createClickHouse).not.toHaveBeenCalled();
  });

  it("the data owner reaches every action with the workspace tenant", async () => {
    for (const action of SUPPORT_ACTIONS) await expectAllowed(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES[action], ownerRow(), action);
  });

  it("unknown and missing actions are 400 before access is resolved", async () => {
    for (const body of [{}, { action: "drop_table" }, { action: "bundle_search" }]) {
      const result = await expectDenied(CLICKHOUSE_SUPPORT_POLICY, body, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
      expect(result.deps.loadAccess).not.toHaveBeenCalled();
    }
  });

  it("Milestone A: every funnel-restricted context gets 403 on every action", async () => {
    for (const scope of ["selected", "none"] as const) {
      for (const action of SUPPORT_ACTIONS) {
        await expectDenied(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES[action], ownerRow(scope), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
        await expectDenied(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES[action], memberRow([...ENFORCED_PERMISSION_KEYS], scope), 403);
      }
    }
  });
});

describe("gate decisions — sync-support-mail and classify-support-requests (user calls)", () => {
  const SUPPORT_EVERYTHING = ["support.view", "support.messages.view", "support.export", "support.classification.edit"];
  const cases: Array<{ policy: FunctionPolicy<string>; actions: string[] }> = [
    { policy: SYNC_SUPPORT_MAIL_POLICY as FunctionPolicy<string>, actions: MAIL_ACTIONS },
    { policy: CLASSIFY_SUPPORT_REQUESTS_POLICY as FunctionPolicy<string>, actions: CLASSIFY_ACTIONS },
  ];

  it.each(cases)("$policy.fn: admin.sync.run (or the data owner) only", async ({ policy, actions }) => {
    for (const action of actions) {
      await expectAllowed(policy, { action }, memberRow(["admin.sync.run"]), action);
      await expectAllowed(policy, { action }, ownerRow(), action);
      for (const permissions of [["support.view"], SUPPORT_EVERYTHING, ["admin.integrations.view", "admin.diagnostics.view", "admin.warehouse.manage"]]) {
        await expectDenied(policy, { action }, memberRow(permissions), 403, ACCESS_ERROR.PERMISSION_DENIED);
      }
    }
  });

  it.each(cases)("$policy.fn: Milestone A — funnel-restricted contexts are refused", async ({ policy, actions }) => {
    for (const scope of ["selected", "none"] as const) {
      for (const action of actions) {
        await expectDenied(policy, { action }, ownerRow(scope), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
        await expectDenied(policy, { action }, memberRow([...ENFORCED_PERMISSION_KEYS], scope), 403);
      }
    }
  });

  it.each(cases)("$policy.fn: a missing action is a 400 (no legacy default)", async ({ policy }) => {
    await expectDenied(policy, {}, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("the old `internal: true` flag grants nothing without the secret header", async () => {
    // Session branch: authorized by permissions, never by the body flag.
    await expectDenied(SYNC_SUPPORT_MAIL_POLICY, { internal: true, action: "sync_new" }, memberRow(["support.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    await expectDenied(CLASSIFY_SUPPORT_REQUESTS_POLICY, { internal: true, action: "continue" }, memberRow(["support.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    // No session at all → 401, not the old mailbox-owner lookup.
    const anonymous = await call(SYNC_SUPPORT_MAIL_POLICY, { internal: true, action: "sync_new" }, ownerRow(), { headers: { "Content-Type": "application/json" } });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error_code).toBe(ACCESS_ERROR.INVALID_SESSION);
    expect(anonymous.handler).not.toHaveBeenCalled();
  });
});

describe("gate decisions — the pg_cron / pg_net ticks", () => {
  async function cronCall<A extends string>(
    policy: FunctionPolicy<A>,
    options: { secret?: string; body?: string; env?: Record<string, string>; header?: string },
  ) {
    const handler = echoHandler();
    const deps = makeDeps(ownerRow(), options.env ?? { SUPPORT_MAIL_SYNC_INTERNAL_SECRET: INTERNAL_SECRET });
    const req = new Request(`https://edge.test/functions/v1/${policy.fn}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", [options.header ?? "x-support-mail-internal-secret"]: options.secret ?? INTERNAL_SECRET },
      body: options.body ?? JSON.stringify({ internal: true, action: "sync_new" }),
    });
    const response = await handleWithAccess(req, policy, handler as unknown as AccessHandler<A>, deps);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, handler, deps };
  }

  it("sync-support-mail: every migration-sent action runs for the workspace data key, no session involved", async () => {
    for (const action of SUPPORT_MAIL_CRON_ACTIONS) {
      const body = action === "rematch_replies" ? { internal: true, action, mode: "full" } : { internal: true, action };
      const result = await cronCall(SYNC_SUPPORT_MAIL_POLICY, { body: JSON.stringify(body) });
      expect(result.status, action).toBe(200);
      expect(result.body).toEqual({ ok: true, action, tenant: DATA_KEY, actor: "cron" });
      expect(result.deps.getUser).not.toHaveBeenCalled();
      expect(result.deps.loadAccess).not.toHaveBeenCalled();
      expect(result.deps.workspaceDataKey).toHaveBeenCalledTimes(1);
    }
  });

  it("sync-support-mail: anything else is refused on the cron branch", async () => {
    for (const action of ["status", "stop", "reset_cursor", "test_connection", "list_folders", "initial_sync", "continue_sync", "sent_sync_new"]) {
      const result = await cronCall(SYNC_SUPPORT_MAIL_POLICY, { body: JSON.stringify({ internal: true, action }) });
      expect(result.status, action).toBe(403);
      expect(result.body.error_code).toBe(ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED);
      expect(result.handler).not.toHaveBeenCalled();
    }
    const missing = await cronCall(SYNC_SUPPORT_MAIL_POLICY, { body: JSON.stringify({ internal: true }) });
    expect(missing.status).toBe(400);
    expect(missing.body.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("classify-support-requests: the hourly tick may only continue the job", async () => {
    const tick = await cronCall(CLASSIFY_SUPPORT_REQUESTS_POLICY, { body: JSON.stringify({ internal: true, action: "continue" }) });
    expect(tick.status).toBe(200);
    expect(tick.body).toEqual({ ok: true, action: "continue", tenant: DATA_KEY, actor: "cron" });
    for (const action of ["start", "reset", "status"]) {
      const result = await cronCall(CLASSIFY_SUPPORT_REQUESTS_POLICY, { body: JSON.stringify({ internal: true, action }) });
      expect(result.status, action).toBe(403);
      expect(result.body.error_code).toBe(ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED);
    }
  });

  it.each([SYNC_SUPPORT_MAIL_POLICY, CLASSIFY_SUPPORT_REQUESTS_POLICY] as FunctionPolicy<string>[])(
    "$fn: the secret is checked (constant-time, by the gate) before the body is read",
    async (policy) => {
      const wrong = await cronCall(policy, { secret: "nope", body: "{not json" });
      expect(wrong.status).toBe(401);
      expect(wrong.body.error_code).toBe(ACCESS_ERROR.INVALID_CRON_SECRET);
      expect(wrong.handler).not.toHaveBeenCalled();
      expect(wrong.deps.workspaceDataKey).not.toHaveBeenCalled();
      const badBody = await cronCall(policy, { body: "{not json" });
      expect(badBody.status).toBe(400);
      expect(badBody.body.error_code).toBe(ACCESS_ERROR.INVALID_BODY);
      const unconfigured = await cronCall(policy, { env: {} });
      expect(unconfigured.status).toBe(503);
      expect(unconfigured.body.error_code).toBe(ACCESS_ERROR.CRON_NOT_CONFIGURED);
    },
  );

  it.each([SYNC_SUPPORT_MAIL_POLICY, CLASSIFY_SUPPORT_REQUESTS_POLICY] as FunctionPolicy<string>[])(
    "$fn: never takes the tenant from the body; another function's cron header opens nothing",
    async (policy) => {
      const action = policy === (SYNC_SUPPORT_MAIL_POLICY as FunctionPolicy<string>) ? "sync_new" : "continue";
      const foreign = await cronCall(policy, { body: JSON.stringify({ internal: true, action, auth_user_id: EMPLOYEE }) });
      expect(foreign.status).toBe(400);
      expect(foreign.body.error_code).toBe(ACCESS_ERROR.TENANT_MISMATCH);
      expect(foreign.handler).not.toHaveBeenCalled();
      const same = await cronCall(policy, { body: JSON.stringify({ internal: true, action, auth_user_id: DATA_KEY }) });
      expect(same.status).toBe(200);
      // The FB scheduler's header is not this function's secret: session branch → 401.
      const fbHeader = await cronCall(policy, { header: "x-cron-secret", body: JSON.stringify({ internal: true, action }) });
      expect(fbHeader.status).toBe(401);
      expect(fbHeader.body.error_code).toBe(ACCESS_ERROR.INVALID_SESSION);
    },
  );
});

// ---- error bodies ------------------------------------------------------------------

describe("error responses: today's bodies for the owner, generic ones for everyone else", () => {
  const throwing = (error: unknown) => vi.fn(async () => {
    throw error;
  });

  it("clickHouseSupportErrorResponse reproduces the pre-access status / body", () => {
    expect(clickHouseSupportErrorResponse(new SupportRequestError("Invalid date_from (expected YYYY-MM-DD): x"))).toEqual({
      status: 400,
      body: { ok: false, source: "clickhouse", error: "Invalid date_from (expected YYYY-MM-DD): x" },
    });
    expect(clickHouseSupportErrorResponse(new Error(`fetch failed: ${SECRET_HOST}`))).toEqual({
      status: 502,
      body: { ok: false, source: "clickhouse", error: `fetch failed: ${SECRET_HOST}` },
    });
    expect(clickHouseSupportErrorResponse("weird")).toEqual({
      status: 502,
      body: { ok: false, source: "clickhouse", error: "ClickHouse support request failed." },
    });
  });

  it("clickhouse-support: the owner keeps the body (+ request_id), an employee gets the generic one", async () => {
    const serve = { onError: clickHouseSupportErrorResponse };
    const failure = new Error(`ClickHouse HTTP 500 from ${SECRET_HOST}: Code: 60. DB::Exception`);
    const owner = await call(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES.bundle, ownerRow(), { handler: throwing(failure) as never, serve });
    expect(owner.status).toBe(502);
    expect(owner.body).toEqual({ ok: false, source: "clickhouse", error: failure.message, request_id: "req-test-1" });
    const employee = await call(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES.bundle, memberRow(["support.view"]), { handler: throwing(failure) as never, serve });
    expect(employee.status).toBe(502);
    expect(employee.body).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-test-1" });
    const badRequest = await call(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES.list, memberRow(["support.view", "support.messages.view"]), {
      handler: throwing(new SupportRequestError("Unsupported support sort field: x")) as never,
      serve,
    });
    expect(badRequest.status).toBe(400);
    expect(badRequest.body.error_code).toBe(ACCESS_ERROR.REQUEST_FAILED);
  });

  it("classify-support-requests: every failure is the 400 it always was; employees get no model / key text", async () => {
    const failure = new Error("Could not read classification state: permission denied for table support_classification_state");
    expect(classifySupportRequestsErrorResponse(failure)).toEqual({ status: 400, body: { ok: false, error: failure.message } });
    expect(classifySupportRequestsErrorResponse(42)).toEqual({ status: 400, body: { ok: false, error: "Support classification failed." } });
    const serve = { onError: classifySupportRequestsErrorResponse };
    const owner = await call(CLASSIFY_SUPPORT_REQUESTS_POLICY, { action: "start" }, ownerRow(), { handler: throwing(failure) as never, serve });
    expect(owner.status).toBe(400);
    expect(owner.body).toEqual({ ok: false, error: failure.message, request_id: "req-test-1" });
    const admin = await call(CLASSIFY_SUPPORT_REQUESTS_POLICY, { action: "start" }, memberRow(["admin.sync.run"]), { handler: throwing(failure) as never, serve });
    expect(admin.status).toBe(400);
    expect(admin.body).toEqual({ ok: false, error_code: ACCESS_ERROR.REQUEST_FAILED, error: "Request failed.", request_id: "req-test-1" });
  });

  it("a ScopeViolation is a 500 whatever the error mapping says", async () => {
    const handler = vi.fn(async ({ clickhouse }: { clickhouse: () => ClickHouseClientLike }) => {
      // A runner still binding the caller's own id as tenant.
      await runSupportList({ authUserId: EMPLOYEE, clickhouse: clickhouse(), request: { action: "list" } });
      return { ok: true };
    });
    const result = await call(CLICKHOUSE_SUPPORT_POLICY, SUPPORT_BODIES.list, memberRow(["support.view", "support.messages.view"]), {
      handler: handler as never,
      serve: { onError: clickHouseSupportErrorResponse },
    });
    expect(result.status).toBe(500);
    expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
  });
});

// ---- status redaction --------------------------------------------------------------

function contextFor(row: ReturnType<typeof accessRow>): AccessContext {
  const parsed = parseResolveAccessRow(row);
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: row.user_id, email: "member@example.com" }, "req-test-1");
}

/** PostgREST-shaped fake: the sync-state row for maybeSingle, a count for the
 * awaited support_requests head query. */
function statusPg(state: Record<string, unknown> | null, sourceCount = 12): SupabaseLikeClient {
  return {
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "limit"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: table === "clickhouse_transaction_sync_state" ? state : null, error: null });
      builder.then = (resolveFn: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: null, count: sourceCount, error: null }).then(resolveFn, reject);
      return builder as never;
    },
  };
}

const FAILED_STATE = {
  auth_user_id: DATA_KEY,
  sync_name: "fact_support_requests_sync",
  status: "failed",
  stopped_reason: "support_sync_error",
  cursor_updated_at: "2026-09-14T09:38:45.048Z",
  cursor_transaction_id: "req-9",
  rows_scanned: 10,
  rows_inserted: 8,
  last_error: `fetch failed: ${SECRET_HOST} (user default)`,
  diagnostics: {
    failed_batches: [{ error: `fetch failed: ${SECRET_HOST}` }],
    attribution: { rows_scanned: 4, funnel_matched: 3, attribution_version: "wh|cv" },
    browser_classification: false,
    error: `fetch failed: ${SECRET_HOST} (user default)`,
  },
};

describe("clickhouse-support status: credential-adjacent diagnostics are stripped for page viewers", () => {
  const clickhouse = (count: number): ClickHouseClientLike => ({
    query: vi.fn(async () => ({ json: async () => [{ count }] })),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  });

  it("keeps lifecycle and the Postgres / ClickHouse totals the export quotes, drops the raw failure text", async () => {
    const status = await runSupportStatus({ authUserId: DATA_KEY, supabase: statusPg(FAILED_STATE), clickhouse: clickhouse(9) });
    expect(JSON.stringify(status)).toContain(SECRET_HOST);
    const projected = projectSupportStatusForViewer(status);
    expect(JSON.stringify(projected)).not.toContain("secret-warehouse");
    expect(JSON.stringify(projected)).not.toContain(DATA_KEY);
    expect(projected).toEqual({
      ok: true,
      source: "clickhouse",
      action: "status",
      status: "failed",
      stopped_reason: "support_sync_error",
      rows_scanned: 10,
      rows_mapped: 0,
      rows_inserted: 8,
      rows_skipped: 0,
      batches_processed: 0,
      cursor_updated_at: "2026-09-14T09:38:45.048Z",
      cursor_request_id: "req-9",
      source_total: 12,
      clickhouse_total: 9,
      duration_ms: status.duration_ms,
      diagnostics: { attribution: FAILED_STATE.diagnostics.attribution, browser_classification: false },
    });
    // The export's "pending sync" arithmetic is unchanged.
    expect(projected.source_total - projected.clickhouse_total).toBe(3);
  });

  it("keeps the shape for odd inputs and never mutates the source", () => {
    expect(projectSupportStatusForViewer({ ok: true, diagnostics: "garbage", error: SECRET_HOST } as never)).toEqual({ ok: true, diagnostics: {} });
    expect(projectSupportStatusForViewer({ ok: true } as never)).toEqual({ ok: true, diagnostics: {} });
    const source = { ok: true, diagnostics: { error: "x", attribution: { a: 1 } } };
    projectSupportStatusForViewer(source as never);
    expect(source.diagnostics.error).toBe("x");
  });

  it("full detail only for the data owner and whoever may run the sync", () => {
    expect(supportStatusDetailVisible(contextFor(ownerRow()))).toBe(true);
    expect(supportStatusDetailVisible(contextFor(memberRow(["support.view", "admin.sync.run"])))).toBe(true);
    expect(supportStatusDetailVisible(contextFor(memberRow(["support.view", "support.messages.view", "support.export"])))).toBe(false);
    expect(supportStatusDetailVisible(contextFor(memberRow(["support.view", "admin.diagnostics.view"])))).toBe(false);
  });
});

// ---- runners -----------------------------------------------------------------------

describe("support runners: ScopeViolation is never swallowed; the tenant is the reader's", () => {
  it("status: a warehouse hiccup still reads as 0, a scope violation fails the request", async () => {
    const failing = (error: Error): ClickHouseClientLike => ({
      query: vi.fn(async () => {
        throw error;
      }),
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
    });
    const degraded = await runSupportStatus({ authUserId: DATA_KEY, supabase: statusPg(null), clickhouse: failing(new Error("boom")) });
    expect(degraded.clickhouse_total).toBe(0);
    expect(degraded.status).toBe("never_started");
    await expect(
      runSupportStatus({ authUserId: DATA_KEY, supabase: statusPg(null), clickhouse: failing(new ScopeViolation("restricted_protected_table", "fact_support_requests")) }),
    ).rejects.toBeInstanceOf(ScopeViolation);
  });

  it("through a real ScopedReader: the workspace tenant passes, the caller's own id is a violation", async () => {
    const ctx = contextFor(memberRow(["support.view", "support.messages.view"]));
    const raw: ClickHouseClientLike = {
      query: vi.fn(async ({ query }: { query: string }) => ({ json: async () => (query.includes("count()") ? [{ count: 0 }] : []) })),
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
    };
    const reader = createScopedReader(ctx, raw);
    await expect(runSupportList({ authUserId: ctx.tenantKey, clickhouse: reader, request: { action: "list" } })).resolves.toMatchObject({ ok: true });
    expect(ctx.violations).toEqual([]);
    await expect(runSupportList({ authUserId: EMPLOYEE, clickhouse: reader, request: { action: "list" } })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
    // ...and the status catch cannot hide it either.
    const statusCtx = contextFor(memberRow(["support.view"]));
    await expect(
      runSupportStatus({ authUserId: EMPLOYEE, supabase: statusPg(null), clickhouse: createScopedReader(statusCtx, raw) }),
    ).rejects.toBeInstanceOf(ScopeViolation);
    expect(statusCtx.violations).toContain("tenant_param_mismatch");
  });
});

// ---- entrypoints -------------------------------------------------------------------

describe("index.ts entrypoints are on the gate", () => {
  const ENTRYPOINTS: Record<string, string> = {
    "clickhouse-support": "CLICKHOUSE_SUPPORT_POLICY",
    "sync-support-mail": "SYNC_SUPPORT_MAIL_POLICY",
    "classify-support-requests": "CLASSIFY_SUPPORT_REQUESTS_POLICY",
  };
  const source = (fn: string) => readFileSync(resolve(process.cwd(), `supabase/functions/${fn}/index.ts`), "utf8");

  it.each(Object.entries(ENTRYPOINTS))("%s serves through serveWithAccess(%s) with the tenant key", (fn, policyName) => {
    const text = source(fn);
    expect(text).toMatch(new RegExp(`serveWithAccess\\(\\s*${policyName},`));
    expect(text).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    expect(text).toMatch(/authUserId(:| =) ctx\.tenantKey/);
    for (const banned of [
      "requireSupabaseUser",
      "requireCronSecret",
      "createClickHouseClient",
      "clickhouse/client.ts",
      "Deno.serve(",
      "auth.id",
      "parseJsonBody",
      "Access-Control-Allow-Origin",
      "auth.getUser",
      "req.json(",
      "req.text(",
      "createClient(",
      // the secret names live in the policy; the gate compares them
      "SUPPORT_MAIL_SYNC_INTERNAL_SECRET",
      "\"x-support-mail-internal-secret\"",
      "body.internal",
      "request.internal",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it("the unordered mailbox-owner lookups are gone", () => {
    for (const fn of ["sync-support-mail", "classify-support-requests"]) {
      const text = source(fn);
      expect(text, fn).not.toContain('.select("auth_user_id")');
      expect(text, fn).not.toContain("no_mailbox_owner");
      expect(text, fn).not.toContain("No mailbox owner");
    }
  });

  it("clickhouse-support dispatches on the authorized action with no fallthrough to the bundle", () => {
    const text = source("clickhouse-support");
    expect(text).toContain("const read = supportReadOf(action);");
    expect(text).toContain('if (read === "bundle") return');
    expect(text).toContain("throw new Error(`Unhandled support action: ${action}`);");
    expect(text).toContain("supportStatusDetailVisible(ctx) ? status : projectSupportStatusForViewer(status)");
    expect(text).toContain("normalizeSupportRequest(request);");
  });

  it("classify-support-requests: server-side model allowlist, canonical action handed to the job", () => {
    const text = source("classify-support-requests");
    expect(text).toContain("resolveAllowedModel(request.model, CLASSIFICATION_MODEL)");
    expect(text).toContain("{ ...(body as ClassificationJobRequest), action }");
    expect(text).not.toContain("request.model.trim()");
  });

  it("sync-support-mail: shared CORS builder, one reader per request, every warehouse catch rethrows ScopeViolation", () => {
    const text = source("sync-support-mail");
    expect(text).toContain("buildCorsHeaders({ methods: [\"POST\"], extraAllowedHeaders: [SUPPORT_MAIL_INTERNAL_SECRET_HEADER] })");
    expect(text).not.toMatch(/const corsHeaders = \{/);
    expect(text).toContain("clickhouse: input.warehouse(),");
    const syncCalls = text.match(/syncClickHouse\(\{[^}]*\}\)/g) ?? [];
    expect(syncCalls.length).toBe(4);
    for (const entry of syncCalls) expect(entry).toContain("warehouse");
    expect(text.match(/if \(error instanceof ScopeViolation\) throw error;/g)?.length).toBe(3);
  });
});
