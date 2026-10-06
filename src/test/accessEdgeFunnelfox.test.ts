// Access migration of the funnelfox-* Edge functions and the local FunnelFox
// proxy (plan §7 rows "Capsuled / FunnelFox syncs", "FunnelFox proxies",
// "FunnelFox funnel list"; §12.7–12.8; §27; Phase 0 + Milestone A).
//
// The six policies are driven through the pure gate core (handleWithAccess) with
// fake dependencies, so these tests prove who may call which action (the raw
// proxies and the leads sync are data-owner only), that the flag-derived actions
// are exactly what the browser and pg_cron send, that every funnel-restricted
// context is refused, that the subscriptions cron is authenticated by the
// constant-time secret and bound to the workspace tenant (never the body uid),
// that error bodies stay the owner's (byte-identical) while employees get the
// gate's generic ones, and that the dev-only api/funnelfox proxy refuses to run
// without its explicit flag.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertValidPolicy,
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
  type ServeWithAccessOptions,
} from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import {
  authorizeAction,
  buildAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { buildCorsHeaders } from "../../supabase/functions/_shared/access/cors.ts";
import * as funnelFoxShared from "../../supabase/functions/_shared/funnelfox.ts";
import {
  FunnelFoxEdgeError,
  corsHeaders as funnelFoxCorsHeaders,
  funnelFoxDerivedAction,
  funnelFoxErrorResponse,
  funnelFoxFailure,
  funnelFoxRequestParams,
  funnelFoxSyncFlags,
} from "../../supabase/functions/_shared/funnelfox.ts";
import {
  FUNNELFOX_SUBSCRIPTIONS_SYNC_CRON_ACTIONS,
  FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY,
  normalizeFunnelFoxSubscriptionsSyncAction,
} from "../../supabase/functions/_shared/access/policies/funnelfox-subscriptions-sync.ts";
import { FUNNELFOX_LEADS_SYNC_POLICY, normalizeFunnelFoxLeadsSyncAction } from "../../supabase/functions/_shared/access/policies/funnelfox-leads-sync.ts";
import { FUNNELFOX_FUNNELS_POLICY, normalizeFunnelFoxFunnelsAction } from "../../supabase/functions/_shared/access/policies/funnelfox-funnels.ts";
import {
  FUNNELFOX_SUBSCRIPTIONS_POLICY,
  normalizeFunnelFoxSubscriptionsAction,
} from "../../supabase/functions/_shared/access/policies/funnelfox-subscriptions.ts";
import { FUNNELFOX_SUBSCRIPTION_POLICY, normalizeFunnelFoxSubscriptionAction } from "../../supabase/functions/_shared/access/policies/funnelfox-subscription.ts";
import { FUNNELFOX_PROFILE_POLICY, normalizeFunnelFoxProfileAction } from "../../supabase/functions/_shared/access/policies/funnelfox-profile.ts";
import {
  FUNNELFOX_LOCAL_PROXY_FLAG,
  handleFunnelFoxProfile,
  handleFunnelFoxProfileDebug,
  handleFunnelFoxSubscriptionDetails,
  handleFunnelFoxSubscriptions,
  isFunnelFoxLocalProxyEnabled,
} from "../../api/funnelfox/subscriptionsCore";
import subscriptionsRoute from "../../api/funnelfox/subscriptions";
import subscriptionRoute from "../../api/funnelfox/subscription";
import profileRoute from "../../api/funnelfox/profile";
import profileByIdRoute from "../../api/funnelfox/profiles/[id]";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CRON_SECRET = "fb-cron-secret-value";
const DB_TEXT = "subscriptions upsert failed: permission denied for table funnelfox_subscriptions";

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

function makeDeps(row: ReturnType<typeof accessRow>, env: Record<string, string> = { FB_CRON_SECRET: CRON_SECRET }): AccessGateDeps {
  return {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async () => ({ data: { user: { id: row.user_id, email: "member@example.com" } }, error: null })),
    loadAccess: vi.fn(async () => ({ data: row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn((name: string) => env[name]),
    // No funnelfox function reads the warehouse.
    createClickHouse: vi.fn(() => {
      throw new Error("funnelfox functions never open a ClickHouse reader");
    }),
    newRequestId: () => "req-test-1",
    log: vi.fn(),
  };
}

const echoHandler = () =>
  vi.fn(async ({ action, ctx }: { action: string; ctx: AccessContext }) => ({ ok: true, action, tenant: ctx.tenantKey, actor: ctx.actor.kind }));

interface CallOptions {
  method?: string;
  query?: string;
  body?: unknown;
  rawBody?: string;
  handler?: ReturnType<typeof vi.fn>;
  serve?: ServeWithAccessOptions;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

async function call<A extends string>(policy: FunctionPolicy<A>, row: ReturnType<typeof accessRow>, options: CallOptions = {}) {
  const handler = options.handler ?? echoHandler();
  const deps = makeDeps(row, options.env);
  const method = options.method ?? "POST";
  const hasBody = method !== "GET" && method !== "HEAD";
  const req = new Request(`https://edge.test/functions/v1/${policy.fn}${options.query ?? ""}`, {
    method,
    headers: options.headers ?? { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: hasBody ? options.rawBody ?? JSON.stringify(options.body ?? {}) : undefined,
  });
  const response = await handleWithAccess(req, policy, handler as unknown as AccessHandler<A>, deps, options.serve);
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : null) as Record<string, unknown>, response, handler, deps };
}

async function expectAllowed<A extends string>(policy: FunctionPolicy<A>, row: ReturnType<typeof accessRow>, action: A, options: CallOptions = {}) {
  const result = await call(policy, row, options);
  expect(result.status, `${policy.fn}:${String(action)} should be allowed`).toBe(200);
  // The handler always sees the workspace data key as tenant, never the caller.
  expect(result.body).toEqual({ ok: true, action, tenant: DATA_KEY, actor: "user" });
  return result;
}

async function expectDenied<A extends string>(policy: FunctionPolicy<A>, row: ReturnType<typeof accessRow>, status: number, code: string | string[] | null, options: CallOptions = {}) {
  const result = await call(policy, row, options);
  expect(result.status, `${policy.fn} ${JSON.stringify(options)}`).toBe(status);
  if (code) expect(Array.isArray(code) ? code : [code], `${policy.fn} ${JSON.stringify(options)}`).toContain(result.body.error_code);
  expect(result.handler).not.toHaveBeenCalled();
  return result;
}

function contextFor(row: ReturnType<typeof accessRow>): AccessContext {
  const parsed = parseResolveAccessRow(row);
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: row.user_id, email: "member@example.com" }, "req-test-1");
}

// What each page / scheduler really sends, per canonical action. The sync
// bodies mirror src/services/funnelfoxSubscriptionsSync.ts / funnelfoxLeads.ts
// (undefined keys dropped by JSON.stringify); the proxies are GET query strings
// (src/services/funnelfoxApi.ts).
const syncBody = (options: { dryRun?: boolean; fullReset?: boolean; stage?: string } = {}) =>
  JSON.parse(JSON.stringify({ dry_run: options.dryRun ?? false, full_reset: options.fullReset ?? false, stage: options.stage, limit: undefined, max_pages: undefined }));

const SYNC_REQUESTS: Record<"sync" | "sync_full_reset" | "dry_run", CallOptions> = {
  sync: { body: syncBody() },
  sync_full_reset: { body: syncBody({ fullReset: true }) },
  dry_run: { body: syncBody({ dryRun: true }) },
};

interface PolicyCase {
  policy: FunctionPolicy<string>;
  requests: Record<string, CallOptions>;
}

const CASES: PolicyCase[] = [
  { policy: FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY as FunctionPolicy<string>, requests: SYNC_REQUESTS },
  {
    policy: FUNNELFOX_LEADS_SYNC_POLICY as FunctionPolicy<string>,
    requests: {
      sync: { body: { ...syncBody(), conversion: { paid_emails: [], active_sub_emails: [], trial_dates: {}, first_sub_dates: {} } } },
      sync_full_reset: { body: { ...syncBody({ fullReset: true }), conversion: { paid_emails: [] } } },
      dry_run: { body: { ...syncBody({ dryRun: true }), conversion: {} } },
    },
  },
  {
    policy: FUNNELFOX_FUNNELS_POLICY as FunctionPolicy<string>,
    requests: { list: { body: {} }, inspect: { method: "GET", query: "?inspect=1" } },
  },
  {
    policy: FUNNELFOX_SUBSCRIPTIONS_POLICY as FunctionPolicy<string>,
    requests: { list: { method: "GET", query: "?cursor=abc" }, connection_test: { method: "GET", query: "?debug=1" } },
  },
  { policy: FUNNELFOX_SUBSCRIPTION_POLICY as FunctionPolicy<string>, requests: { details: { method: "GET", query: "?id=sub_1" } } },
  {
    policy: FUNNELFOX_PROFILE_POLICY as FunctionPolicy<string>,
    requests: { profile: { method: "GET", query: "?id=pro_1" }, profile_debug: { method: "GET", query: "?id=pro_1&debug=1" } },
  },
];

const FUNCTION_DIRS: Record<string, string> = {
  "funnelfox-subscriptions-sync": "FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY",
  "funnelfox-leads-sync": "FUNNELFOX_LEADS_SYNC_POLICY",
  "funnelfox-funnels": "FUNNELFOX_FUNNELS_POLICY",
  "funnelfox-subscriptions": "FUNNELFOX_SUBSCRIPTIONS_POLICY",
  "funnelfox-subscription": "FUNNELFOX_SUBSCRIPTION_POLICY",
  "funnelfox-profile": "FUNNELFOX_PROFILE_POLICY",
};

// ---- policy tables -----------------------------------------------------------------

describe("policy tables", () => {
  it("are valid, cover every action, keep GET + POST", () => {
    for (const { policy, requests } of CASES) {
      expect(() => assertValidPolicy(policy)).not.toThrow();
      expect(policy.methods).toEqual(["GET", "POST"]);
      expect(Object.keys(policy.actions).sort()).toEqual(Object.keys(requests).sort());
    }
    expect(CASES.map(({ policy }) => policy.fn).sort()).toEqual(Object.keys(FUNCTION_DIRS).sort());
  });

  it("match the Phase-1 permission table exactly", () => {
    const SYNC = ["admin.sync.run"];
    expect(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY.actions).toEqual({
      sync: { allOf: SYNC, write: true },
      sync_full_reset: { allOf: SYNC, write: true },
      dry_run: { allOf: SYNC },
    });
    expect(FUNNELFOX_LEADS_SYNC_POLICY.actions).toEqual({
      sync: { rawOnly: true, allOf: SYNC, write: true },
      sync_full_reset: { rawOnly: true, allOf: SYNC, write: true },
      dry_run: { rawOnly: true, allOf: SYNC },
    });
    expect(FUNNELFOX_FUNNELS_POLICY.actions).toEqual({
      list: { allOf: ["funnels.manage"] },
      inspect: { allOf: ["funnels.manage", "admin.diagnostics.view"] },
    });
    expect(FUNNELFOX_SUBSCRIPTIONS_POLICY.actions).toEqual({
      list: { rawOnly: true, allOf: SYNC },
      connection_test: { rawOnly: true, allOf: SYNC },
    });
    expect(FUNNELFOX_SUBSCRIPTION_POLICY.actions).toEqual({ details: { rawOnly: true, allOf: SYNC } });
    expect(FUNNELFOX_PROFILE_POLICY.actions).toEqual({
      profile: { rawOnly: true, allOf: SYNC },
      profile_debug: { rawOnly: true, allOf: ["admin.sync.run", "admin.diagnostics.view"] },
    });
  });

  it("no action is scopeReady, none is 'any active member', every key is an enforced permission", () => {
    for (const { policy } of CASES) {
      for (const entry of Object.values(policy.actions)) {
        expect(entry.scopeReady).toBeFalsy();
        const keys = [...(entry.anyOf ?? []), ...(entry.allOf ?? [])];
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
      }
    }
  });

  it("only the subscriptions sync has a cron branch, and it is exactly what migration 202607250001 sends", () => {
    expect(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY.cron).toEqual({ header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["sync", "sync_full_reset"] });
    expect([...FUNNELFOX_SUBSCRIPTIONS_SYNC_CRON_ACTIONS]).toEqual(["sync", "sync_full_reset"]);
    for (const { policy } of CASES.slice(1)) expect(policy.cron, policy.fn).toBeUndefined();
    const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/202607250001_funnelfox_subscriptions_cron.sql"), "utf8");
    expect(sql).toContain("'x-cron-secret', cfg.cron_secret");
    expect(sql).toContain("jsonb_build_object('auth_user_id', cfg.auth_user_id, 'full_reset', p_full_reset)");
    // Both ticks map onto the cron actions (and never onto the dry run).
    const tick = (fullReset: boolean) =>
      normalizeFunnelFoxSubscriptionsSyncAction({ method: "POST", body: { auth_user_id: DATA_KEY, full_reset: fullReset }, url: new URL("https://edge.test"), cron: true });
    expect(tick(true)).toBe("sync_full_reset");
    expect(tick(false)).toBe("sync");
  });
});

// ---- normalizers -------------------------------------------------------------------

describe("canonical action normalizers (rule R3, flags → actions)", () => {
  const at = (query = "") => new URL(`https://edge.test/fn${query}`);

  it.each([
    ["funnelfox-subscriptions-sync", normalizeFunnelFoxSubscriptionsSyncAction],
    ["funnelfox-leads-sync", normalizeFunnelFoxLeadsSyncAction],
  ] as const)("%s: the page's flag bodies and the GET query map to sync / sync_full_reset / dry_run", (_fn, normalize) => {
    const run = (body: Record<string, unknown>, query = "", method = "POST") => normalize({ method, body, url: at(query), cron: false });
    expect(run(syncBody())).toBe("sync");
    expect(run(syncBody({ stage: "profile_enrichment" }))).toBe("sync");
    expect(run(syncBody({ fullReset: true }))).toBe("sync_full_reset");
    expect(run(syncBody({ dryRun: true }))).toBe("dry_run");
    // dry_run wins over full_reset, as the function always did (it returns before any reset).
    expect(run(syncBody({ dryRun: true, fullReset: true }))).toBe("dry_run");
    expect(run({}, "?full_reset=TRUE", "GET")).toBe("sync_full_reset");
    expect(run({}, "?dry_run=true&full_reset=true", "GET")).toBe("dry_run");
    // Unchanged parse rule: only a JSON true in the body counts ("true" strings do not).
    expect(run({ full_reset: "true", dry_run: 1 })).toBe("sync");
    // An explicit action may only repeat what the flags say.
    expect(run({ action: "sync" })).toBe("sync");
    expect(run({ action: "dry_run", dry_run: true })).toBe("dry_run");
    for (const body of [{ action: "dry_run" }, { action: "sync", full_reset: true }, { action: "drop" }, { action: "SYNC" }, { action: 1 }]) {
      expect(() => run(body as Record<string, unknown>), JSON.stringify(body)).toThrow(ActionNormalizeError);
    }
  });

  it("funnelfox-funnels: {} is the list; `inspect` (query or body) is the diagnostic", () => {
    const run = (body: Record<string, unknown>, query = "") => normalizeFunnelFoxFunnelsAction({ method: "POST", body, url: at(query) });
    expect(run({})).toBe("list");
    expect(run({}, "?inspect=1")).toBe("inspect");
    expect(run({ inspect: true })).toBe("inspect");
    expect(run({ inspect: "1" })).toBe("inspect");
    expect(run({ inspect: "yes" })).toBe("list");
    // The query string wins over the body, as readRequestParams did.
    expect(run({ inspect: "true" }, "?inspect=0")).toBe("list");
    expect(run({ action: "list" })).toBe("list");
    for (const body of [{ action: "inspect" }, { action: "list", inspect: true }, { action: "import" }]) {
      expect(() => run(body as Record<string, unknown>), JSON.stringify(body)).toThrow(ActionNormalizeError);
    }
  });

  it("funnelfox-subscriptions: `debug` is the connection test, anything else the raw list", () => {
    const run = (query: string, body: Record<string, unknown> = {}, method = "GET") => normalizeFunnelFoxSubscriptionsAction({ method, body, url: at(query) });
    expect(run("")).toBe("list");
    expect(run("?cursor=abc")).toBe("list");
    expect(run("?debug=1")).toBe("connection_test");
    expect(run("?debug=true")).toBe("connection_test");
    // Case-sensitive, as before.
    expect(run("?debug=TRUE")).toBe("list");
    expect(run("", { debug: 1 }, "POST")).toBe("connection_test");
    expect(run("?debug=0", { debug: "1" }, "POST")).toBe("list");
    expect(() => run("", { action: "list", debug: true }, "POST")).toThrow(ActionNormalizeError);
  });

  it("funnelfox-subscription: one action; funnelfox-profile: `debug` (trimmed, any case) is the diagnostic", () => {
    expect(normalizeFunnelFoxSubscriptionAction({ method: "GET", body: {}, url: at("?id=sub_1") })).toBe("details");
    expect(() => normalizeFunnelFoxSubscriptionAction({ method: "POST", body: { action: "list" }, url: at() })).toThrow(ActionNormalizeError);
    const profile = (query: string) => normalizeFunnelFoxProfileAction({ method: "GET", body: {}, url: at(query) });
    expect(profile("?id=pro_1")).toBe("profile");
    expect(profile("?id=pro_1&debug=0")).toBe("profile");
    expect(profile("?id=pro_1&debug=TRUE")).toBe("profile_debug");
    expect(profile("?id=pro_1&debug=%201%20")).toBe("profile_debug");
  });

  it("the shared helpers read parameters exactly like the old readRequestParams / boolParam", () => {
    const params = funnelFoxRequestParams(new URL("https://edge.test/fn?id=q&debug=0"), { id: "body", cursor: "c1", empty: null, missing: undefined, flag: true });
    expect(params.get("id")).toBe("q");
    expect(params.get("debug")).toBe("0");
    expect(params.get("cursor")).toBe("c1");
    expect(params.get("flag")).toBe("true");
    expect(params.has("empty")).toBe(false);
    expect(params.has("missing")).toBe(false);
    expect(funnelFoxSyncFlags({ dry_run: true }, new URL("https://edge.test"))).toEqual({ dryRun: true, fullReset: false });
    expect(funnelFoxSyncFlags({}, new URL("https://edge.test/?full_reset=True"))).toEqual({ dryRun: false, fullReset: true });
    expect(funnelFoxDerivedAction({ action: null }, "list")).toBe("list");
    expect(() => funnelFoxDerivedAction({ action: "" }, "list")).toThrow(ActionNormalizeError);
  });
});

// ---- gate decisions ----------------------------------------------------------------

describe("gate decisions", () => {
  it("the data owner reaches every action of every function, with the workspace tenant", async () => {
    for (const { policy, requests } of CASES) {
      for (const [action, request] of Object.entries(requests)) await expectAllowed(policy, ownerRow(), action, request);
    }
  });

  it("an employee with admin.sync.run may drive the subscriptions sync — rows still land under the data key", async () => {
    for (const [action, request] of Object.entries(SYNC_REQUESTS)) {
      await expectAllowed(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, memberRow(["admin.sync.run"]), action as keyof typeof SYNC_REQUESTS, request);
    }
  });

  it("the raw proxies and the leads sync are data-owner only, whatever the employee's permissions", async () => {
    for (const { policy, requests } of CASES.filter(({ policy }) => Object.values(policy.actions).every((entry) => entry.rawOnly))) {
      for (const request of Object.values(requests)) {
        for (const permissions of [["admin.sync.run"], [...ENFORCED_PERMISSION_KEYS]]) {
          await expectDenied(policy, memberRow(permissions), 403, ACCESS_ERROR.RAW_ACCESS_REQUIRED, request);
        }
      }
    }
    // Four functions are raw-only; the subscriptions sync and the funnel list are not.
    expect(CASES.filter(({ policy }) => Object.values(policy.actions).every((entry) => entry.rawOnly)).map(({ policy }) => policy.fn).sort()).toEqual([
      "funnelfox-leads-sync",
      "funnelfox-profile",
      "funnelfox-subscription",
      "funnelfox-subscriptions",
    ]);
  });

  it("funnelfox-funnels: funnels.manage lists, the raw inspect also needs admin.diagnostics.view", async () => {
    const manager = memberRow(["funnels.view", "funnels.manage"]);
    await expectAllowed(FUNNELFOX_FUNNELS_POLICY, manager, "list", { body: {} });
    await expectDenied(FUNNELFOX_FUNNELS_POLICY, manager, 403, ACCESS_ERROR.PERMISSION_DENIED, { method: "GET", query: "?inspect=1" });
    await expectAllowed(FUNNELFOX_FUNNELS_POLICY, memberRow(["funnels.view", "funnels.manage", "admin.diagnostics.view"]), "inspect", { body: { inspect: true } });
    // funnels.view alone (the Viewer / Media Buyer templates) cannot list FunnelFox.
    await expectDenied(FUNNELFOX_FUNNELS_POLICY, memberRow(["funnels.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED, { body: {} });
    await expectDenied(FUNNELFOX_FUNNELS_POLICY, memberRow(["admin.sync.run"]), 403, ACCESS_ERROR.PERMISSION_DENIED, { body: {} });
  });

  it("page viewers and unrelated admins reach nothing", async () => {
    const roles = [
      ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"],
      ["subscriptions.view", "leads.view", "admin.integrations.view"],
      ["admin.diagnostics.view", "admin.warehouse.manage", "admin.data.import"],
    ];
    for (const permissions of roles) {
      for (const { policy, requests } of CASES) {
        for (const request of Object.values(requests)) {
          await expectDenied(policy, memberRow(permissions), 403, [ACCESS_ERROR.PERMISSION_DENIED, ACCESS_ERROR.RAW_ACCESS_REQUIRED], request);
        }
      }
    }
  });

  it("Milestone A: every funnel-restricted context gets 403 on every action", async () => {
    for (const scope of ["selected", "none"] as const) {
      for (const { policy, requests } of CASES) {
        for (const request of Object.values(requests)) {
          // The Owner role keeps its permissions and raw access: refused for scope.
          await expectDenied(policy, ownerRow(scope), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED, request);
          // An employee loses the full-scope keys first (admin.*, funnels.manage).
          await expectDenied(policy, memberRow([...ENFORCED_PERMISSION_KEYS], scope), 403, [ACCESS_ERROR.PERMISSION_DENIED, ACCESS_ERROR.RAW_ACCESS_REQUIRED], request);
        }
      }
    }
  });

  it("even holding every permission, a restricted context is refused for scope (no action is scopeReady)", () => {
    for (const { policy } of CASES) {
      for (const entry of Object.values(policy.actions)) {
        const ctx = { ...contextFor(ownerRow("selected")), permissions: new Set(ENFORCED_PERMISSION_KEYS) };
        expect(ctx.rawAccess).toBe(true);
        expect(authorizeAction(ctx, entry)?.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
      }
    }
  });

  it("authenticates before reading the body; no session is a 401 everywhere", async () => {
    for (const { policy, requests } of CASES) {
      for (const request of Object.values(requests)) {
        const result = await expectDenied(policy, ownerRow(), 401, ACCESS_ERROR.INVALID_SESSION, { ...request, headers: { "Content-Type": "application/json" } });
        expect(result.deps.loadAccess).not.toHaveBeenCalled();
      }
      const garbage = await expectDenied(policy, ownerRow(), 401, ACCESS_ERROR.INVALID_SESSION, { rawBody: "{not json", headers: {} });
      expect(garbage.deps.getUser).not.toHaveBeenCalled();
    }
  });

  it("CORS / methods come from the gate: OPTIONS 204 with GET, POST, OPTIONS; PUT is a 405", async () => {
    for (const { policy } of CASES) {
      const preflight = await call(policy, ownerRow(), { method: "OPTIONS" });
      expect(preflight.status).toBe(204);
      expect(preflight.response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
      expect(preflight.response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const put = await expectDenied(policy, ownerRow(), 405, ACCESS_ERROR.METHOD_NOT_ALLOWED, { method: "PUT" });
      expect(put.response.headers.get("Allow")).toBe("GET, POST");
    }
  });

  it("unknown actions are a 400 before access is resolved", async () => {
    for (const { policy } of CASES) {
      const result = await expectDenied(policy, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION, { body: { action: "drop_table" } });
      expect(result.deps.loadAccess).not.toHaveBeenCalled();
    }
  });
});

// ---- cron --------------------------------------------------------------------------

describe("funnelfox-subscriptions-sync cron (pg_cron → x-cron-secret)", () => {
  // pg_net sends the anon key as Bearer (for the platform gateway) plus the secret.
  const cronHeaders = (secret = CRON_SECRET) => ({ "Content-Type": "application/json", Authorization: "Bearer anon-key", apikey: "anon-key", "x-cron-secret": secret });

  it("both ticks run for the workspace data key with no session involved", async () => {
    for (const [fullReset, action] of [[true, "sync_full_reset"], [false, "sync"]] as const) {
      const result = await call(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), { headers: cronHeaders(), body: { auth_user_id: DATA_KEY, full_reset: fullReset } });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ ok: true, action, tenant: DATA_KEY, actor: "cron" });
      expect(result.deps.getUser).not.toHaveBeenCalled();
      expect(result.deps.loadAccess).not.toHaveBeenCalled();
      expect(result.deps.workspaceDataKey).toHaveBeenCalledTimes(1);
    }
    // The body uid is optional: the tenant never comes from it.
    const bare = await call(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), { headers: cronHeaders(), body: { full_reset: false } });
    expect(bare.body).toEqual({ ok: true, action: "sync", tenant: DATA_KEY, actor: "cron" });
  });

  it("a body auth_user_id other than the data key is refused (it used to BE the tenant)", async () => {
    const result = await expectDenied(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), 400, ACCESS_ERROR.TENANT_MISMATCH, {
      headers: cronHeaders(),
      body: { auth_user_id: EMPLOYEE, full_reset: false },
    });
    expect(result.deps.getUser).not.toHaveBeenCalled();
  });

  it("the secret is compared before the body is read; a wrong or unset secret opens nothing", async () => {
    const wrong = await expectDenied(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), 401, ACCESS_ERROR.INVALID_CRON_SECRET, { headers: cronHeaders("nope"), rawBody: "{not json" });
    expect(wrong.deps.workspaceDataKey).not.toHaveBeenCalled();
    await expectDenied(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), 401, ACCESS_ERROR.INVALID_CRON_SECRET, { headers: cronHeaders(""), body: { full_reset: false } });
    await expectDenied(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), 503, ACCESS_ERROR.CRON_NOT_CONFIGURED, { headers: cronHeaders(), body: { full_reset: false }, env: {} });
  });

  it("the scheduler cannot run the dry run", async () => {
    await expectDenied(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), 403, ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED, { headers: cronHeaders(), body: { dry_run: true } });
  });

  it("the cron header opens nothing on the other funnelfox functions (session branch → 401)", async () => {
    for (const { policy, requests } of CASES.slice(1)) {
      const request = Object.values(requests)[0];
      const result = await call(policy, ownerRow(), {
        ...request,
        headers: cronHeaders(),
      });
      // The fake getUser accepts any token, so prove the cron header is ignored by
      // making the session fail: without Authorization it is a plain 401.
      expect(result.deps.workspaceDataKey).not.toHaveBeenCalled();
      const noSession = await expectDenied(policy, ownerRow(), 401, ACCESS_ERROR.INVALID_SESSION, { ...request, headers: { "x-cron-secret": CRON_SECRET } });
      expect(noSession.deps.workspaceDataKey).not.toHaveBeenCalled();
    }
  });
});

// ---- error bodies ------------------------------------------------------------------

describe("error responses: today's exact body for the data owner, the gate's generic one for everyone else", () => {
  const failing = (status: number, body: Record<string, unknown>) =>
    vi.fn(async ({ ctx }: { ctx: AccessContext }) => funnelFoxFailure(ctx, status, body));
  const serve = { onError: funnelFoxErrorResponse };
  const SYNC_FAILURE = { status: "error", error: "FunnelFox subscriptions sync failed.", detail: DB_TEXT };

  it("funnelFoxFailure: a verbatim Response for the owner, a FunnelFoxEdgeError for anyone else", async () => {
    const response = funnelFoxFailure({ rawAccess: true }, 502, SYNC_FAILURE);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(JSON.stringify(SYNC_FAILURE));
    expect(response.headers.get("Content-Type")).toBe("application/json");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    let thrown: unknown = null;
    try {
      funnelFoxFailure({ rawAccess: false }, 502, SYNC_FAILURE);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(FunnelFoxEdgeError);
    expect(funnelFoxErrorResponse(thrown)).toEqual({ status: 502, body: SYNC_FAILURE });
    expect(funnelFoxErrorResponse(new Error("other"))).toBeNull();
  });

  it("through the gate: the owner's body is byte-identical (no added fields), the request id rides in a header", async () => {
    const owner = await call(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), { body: syncBody(), handler: failing(502, SYNC_FAILURE), serve });
    expect(owner.status).toBe(502);
    expect(owner.body).toEqual(SYNC_FAILURE);
    expect(owner.response.headers.get("x-request-id")).toBe("req-test-1");
    const proxy = await call(FUNNELFOX_SUBSCRIPTIONS_POLICY, ownerRow(), { method: "GET", query: "?cursor=x", handler: failing(429, { error: "FunnelFox API request failed." }), serve });
    expect(proxy.status).toBe(429);
    expect(proxy.body).toEqual({ error: "FunnelFox API request failed." });
  });

  it("an employee gets the same status with no upstream / database text; the scheduler keeps the detail", async () => {
    const admin = await call(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, memberRow(["admin.sync.run"]), { body: syncBody(), handler: failing(502, SYNC_FAILURE), serve });
    expect(admin.status).toBe(502);
    expect(admin.body).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-test-1" });
    expect(JSON.stringify(admin.body)).not.toContain("permission denied");
    const cron = await call(FUNNELFOX_SUBSCRIPTIONS_SYNC_POLICY, ownerRow(), {
      headers: { "Content-Type": "application/json", "x-cron-secret": CRON_SECRET },
      body: { auth_user_id: DATA_KEY, full_reset: false },
      handler: failing(500, { error: "FunnelFox is not configured." }),
      serve,
    });
    expect(cron.status).toBe(500);
    // The cron proved the shared secret and its body lands only in
    // net._http_response — the owner's way to see why a tick failed.
    expect(cron.body).toMatchObject({ error: "FunnelFox is not configured.", request_id: "req-test-1" });
    const manager = memberRow(["funnels.view", "funnels.manage"]);
    const notFound = await call(FUNNELFOX_FUNNELS_POLICY, manager, { body: {}, handler: failing(404, { error: "FunnelFox API request failed.", status: 404, page: 1 }), serve });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toEqual({ ok: false, error_code: ACCESS_ERROR.REQUEST_FAILED, error: "Request failed.", request_id: "req-test-1" });
  });
});

// ---- shared module -----------------------------------------------------------------

describe("_shared/funnelfox.ts", () => {
  it("CORS comes from the shared builder with the same origin / headers / methods as before", () => {
    expect(funnelFoxCorsHeaders).toEqual(buildCorsHeaders({ methods: ["GET", "POST"] }));
    expect(funnelFoxCorsHeaders["Access-Control-Allow-Origin"]).toBe("*");
    expect(funnelFoxCorsHeaders["Access-Control-Allow-Headers"]).toBe("authorization, x-client-info, apikey, content-type");
    expect(funnelFoxCorsHeaders["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
    const source = readFileSync(resolve(process.cwd(), "supabase/functions/_shared/funnelfox.ts"), "utf8");
    expect(source).toContain('from "./access/cors.ts"');
    expect(source).not.toContain('"Access-Control-Allow-Origin": "*"');
  });

  it("no longer offers the pre-gate plumbing (own preflight / method check / body reader)", () => {
    const exported = Object.keys(funnelFoxShared);
    for (const name of ["readRequestParams", "optionsResponse", "methodNotAllowed"]) expect(exported).not.toContain(name);
  });
});

// ---- entrypoints -------------------------------------------------------------------

describe("index.ts entrypoints are on the gate", () => {
  const source = (fn: string) => readFileSync(resolve(process.cwd(), `supabase/functions/${fn}/index.ts`), "utf8");

  it.each(Object.entries(FUNCTION_DIRS))("%s serves through serveWithAccess(%s) with the FunnelFox error mapping", (fn, policyName) => {
    const text = source(fn);
    expect(text).toMatch(new RegExp(`serveWithAccess\\(${policyName}, async \\(`));
    expect(text).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    expect(text).toContain("{ onError: funnelFoxErrorResponse });");
    for (const banned of [
      "Deno.serve(",
      "Deno.env",
      "createClient(",
      "auth.getUser",
      "req.json(",
      "req.text(",
      "readRequestParams",
      "optionsResponse",
      "methodNotAllowed",
      "jsonResponse(",
      "Access-Control-Allow-Origin",
      "requireSupabaseUser",
      "requireCronSecret",
      "createClickHouseClient",
      "SUPABASE_SERVICE_ROLE_KEY",
      "SUPABASE_ANON_KEY",
      "FB_CRON_SECRET",
      "body.auth_user_id",
      "userId",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it.each(["funnelfox-subscriptions-sync", "funnelfox-leads-sync"])("%s writes and reads only under ctx.tenantKey, with the policy's action", (fn) => {
    const text = source(fn);
    expect(text).toContain("const tenantKey = ctx.tenantKey;");
    expect(text).toContain('const dryRun = action === "dry_run";');
    expect(text).toContain('const fullReset = action === "sync_full_reset";');
    expect(text).not.toContain("boolParam");
    expect(text.match(/\.eq\("auth_user_id", tenantKey\)/g)?.length ?? 0).toBeGreaterThan(5);
    expect(text).not.toMatch(/\.eq\("auth_user_id", (?!tenantKey\))/);
    expect(text).not.toMatch(/auth_user_id: (?!tenantKey\b)/);
  });

  it("the endpoint probe (debug tool with free-form upstream paths) is gone", () => {
    expect(existsSync(resolve(process.cwd(), "supabase/functions/funnelfox-endpoint-probe"))).toBe(false);
  });
});

// ---- dev-only local proxy ----------------------------------------------------------

describe("api/funnelfox local proxy: refuses to run without FUNNELFOX_LOCAL_PROXY_ENABLED=true", () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));

  beforeEach(() => {
    vi.stubEnv(FUNNELFOX_LOCAL_PROXY_FLAG, undefined);
    vi.stubEnv("FUNNELFOX_SECRET", "fox-secret");
    vi.stubEnv("SUPABASE_URL", "https://project.supabase.test");
    vi.stubEnv("SUPABASE_ANON_KEY", "anon-key");
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const fakeRes = () => {
    const res = {
      statusCode: 0,
      headers: {} as Record<string, string>,
      payload: undefined as unknown,
      setHeader(name: string, value: string) {
        res.headers[name] = value;
      },
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.payload = body;
      },
    };
    return res;
  };

  it("the flag is an explicit, exact opt-in", () => {
    expect(FUNNELFOX_LOCAL_PROXY_FLAG).toBe("FUNNELFOX_LOCAL_PROXY_ENABLED");
    expect(isFunnelFoxLocalProxyEnabled({})).toBe(false);
    for (const value of ["", "1", "yes", "false", "on"]) expect(isFunnelFoxLocalProxyEnabled({ FUNNELFOX_LOCAL_PROXY_ENABLED: value }), value).toBe(false);
    for (const value of ["true", "TRUE", " true "]) expect(isFunnelFoxLocalProxyEnabled({ FUNNELFOX_LOCAL_PROXY_ENABLED: value }), value).toBe(true);
  });

  it("every core handler answers 404 without touching auth or FunnelFox", async () => {
    const auth = "Bearer some-session";
    for (const result of [
      await handleFunnelFoxSubscriptions({ authHeader: auth }),
      await handleFunnelFoxSubscriptions({ authHeader: auth, debug: true }),
      await handleFunnelFoxSubscriptionDetails({ subscriptionId: "sub_1", authHeader: auth }),
      await handleFunnelFoxProfile({ profileId: "pro_1", authHeader: auth }),
      await handleFunnelFoxProfileDebug({ profileId: "pro_1", authHeader: auth }),
    ]) {
      expect(result).toEqual({ status: 404, body: { error: "Not found." } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("every Vercel-style route answers 404 (before even the method check)", async () => {
    const routes = [subscriptionsRoute, subscriptionRoute, profileRoute, profileByIdRoute] as Array<(req: unknown, res: unknown) => Promise<unknown>>;
    for (const route of routes) {
      for (const method of ["GET", "POST"]) {
        const res = fakeRes();
        await route({ method, query: { id: "x" }, url: "/api/funnelfox/subscriptions?id=x", headers: { authorization: "Bearer s", host: "app.test" } }, res);
        expect(res.statusCode).toBe(404);
        expect(res.payload).toEqual({ error: "Not found." });
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("with the flag on, the handlers run as before (session check first)", async () => {
    vi.stubEnv(FUNNELFOX_LOCAL_PROXY_FLAG, "true");
    expect(await handleFunnelFoxSubscriptions({})).toEqual({ status: 401, body: { error: "Authentication required." } });
    expect(fetchMock).not.toHaveBeenCalled();
    await handleFunnelFoxSubscriptions({ authHeader: "Bearer s" });
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe("vite.config.ts: Lovable bind, proxy flag only for a loopback dev server", () => {
  const text = readFileSync(resolve(process.cwd(), "vite.config.ts"), "utf8");

  it('keeps the Lovable template bind "::" for the editor preview', () => {
    expect(text).toContain('host: "::"');
  });

  it("enables the proxy only inside the dev-only configureServer hook, only on loopback, never overriding an explicit value", () => {
    expect(text).toContain('apply: "serve"');
    expect(text).toContain('const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);');
    expect(text).not.toMatch(/LOOPBACK_HOSTS = new Set\([^)]*"::"[,\]]/);
    const hookAt = text.indexOf("configureServer(server: ViteDevServer) {");
    expect(hookAt).toBeGreaterThan(0);
    const enable = 'if (process.env[FUNNELFOX_LOCAL_PROXY_FLAG] === undefined && LOOPBACK_HOSTS.has(String(server.config.server.host))) process.env[FUNNELFOX_LOCAL_PROXY_FLAG] = "true";';
    // The one assignment, and it is the first statement of the dev-server hook.
    expect(text.match(/process\.env\[FUNNELFOX_LOCAL_PROXY_FLAG\] = "true"/g)?.length).toBe(1);
    expect(text.indexOf(enable)).toBeGreaterThan(hookAt);
    expect(text.slice(hookAt, text.indexOf(enable)).trim()).toBe("configureServer(server: ViteDevServer) {");
    // Nothing else (define / loadEnv defaults) turns it on for builds or previews.
    expect(text).not.toMatch(/define\s*:/);
  });
});
