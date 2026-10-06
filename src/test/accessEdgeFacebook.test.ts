// Access migration of the Facebook Edge functions (plan §7 rows "FB warehouse",
// "FB status", "FB history/recon", "FB writes", "FB cron", "Spend ledger",
// "Funnel spend", "Capsuled syncs"; §10, §13, §27 — Milestone A).
//
// Both policies are driven through the pure gate core (handleWithAccess) with
// fake dependencies, so these tests prove who may call which action, that every
// funnel-restricted context is refused, that the cron tick is authenticated by
// the secret (before the body is read) and bound to the workspace tenant, that
// error bodies stay the owner's while employees get generic ones, that status /
// sync responses are redacted for non-owners, and that the FB runners no longer
// swallow a ScopeViolation or read known gaps across tenants.
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
  CLICKHOUSE_FACEBOOK_POLICY,
  FB_HISTORY_ACTIONS,
  FB_SCHEMA_WRITE_ACTIONS,
  FbActionError,
  clickHouseFacebookErrorResponse,
  fbResponseAction,
  fbStatusDetailVisible,
  fbV2PreviewRead,
  normalizeClickHouseFacebookAction,
  projectFbSyncStateForViewer,
  type ClickHouseFacebookAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-facebook.ts";
import {
  CAPSULED_FACEBOOK_SYNC_POLICY,
  CapsuledSyncError,
  capsuledFacebookSyncErrorResponse,
  capsuledRawPayloadsVisible,
  normalizeCapsuledFacebookSyncAction,
  stripCapsuledSyncRawPayloads,
} from "../../supabase/functions/_shared/access/policies/capsuled-facebook-sync.ts";
import {
  FacebookStatsRequestError,
  FacebookStatsValidationError,
  fbWarehouseErrorResponse,
  runFbReport,
} from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import { runFbReconSnapshot } from "../../supabase/functions/_shared/clickhouse/fbReconSnapshot.ts";
import { createFbWarehouseV2Writer } from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Writer.ts";
import { FB_BATCH_REGISTRY_TABLE } from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Schema.ts";
import { runProjectSpendLedger } from "../../supabase/functions/_shared/clickhouse/projectSpendLedger.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { fbWarehouseVersionFromStatus, type FbStatusResponse } from "@/services/fbWarehouse";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CRON_SECRET = "cron-secret-value";
const SENTINEL_SPEND = 987654.32;

type Scope = "all" | "selected" | "none";
type UserAction = Exclude<ClickHouseFacebookAction, "cron_daily">;

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
  options: { method?: string; url?: string; handler?: ReturnType<typeof echoHandler>; serve?: ServeWithAccessOptions } = {},
) {
  const handler = options.handler ?? echoHandler();
  const method = options.method ?? "POST";
  const req = new Request(options.url ?? "https://edge.test/functions/v1/fn", {
    method,
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
  });
  const response = await handleWithAccess(req, policy, handler as unknown as AccessHandler<A>, makeDeps(row), options.serve);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, handler };
}

async function expectAllowed<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: ReturnType<typeof accessRow>, action: A) {
  const result = await call(policy, body, row);
  expect(result.status, `${String(action)} should be allowed`).toBe(200);
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

// One body per user-callable canonical action.
const FB_BODIES: Record<UserAction, Record<string, unknown>> = {
  report: { action: "report", level: "campaign", filters: {} },
  list: { action: "list" },
  charts: { action: "charts" },
  filters: { action: "filters" },
  summary: { action: "summary" },
  status: { action: "status" },
  v2_preview: { action: "list", v2_preview: true },
  funnel_spend: { action: "funnel_spend" },
  spend_ledger: { action: "spend_ledger", date_from: "2026-01-01", date_to: "2026-01-31" },
  history_runs: { action: "history_runs" },
  history_batches: { action: "history_batches" },
  history_versions: { action: "history_versions" },
  history_raw_payloads: { action: "history_raw_payloads", batch_id: "66666666-6666-4666-8666-666666666666" },
  history_dq: { action: "history_dq", batch_id: "66666666-6666-4666-8666-666666666666" },
  recon_history: { action: "recon_history", limit: 60 },
  v2_parity: { action: "v2_parity" },
  v2_dims_status: { action: "v2_dims_status" },
  source_probe: { action: "source_probe" },
  sync: { action: "sync", mode: "incremental" },
  recon_snapshot: { action: "recon_snapshot" },
  v2_dims_backfill: { action: "v2_dims_backfill" },
  seed_campaign_aliases: { action: "seed_campaign_aliases" },
  funnel_suggestions: { action: "funnel_suggestions", apply: false },
  funnel_suggestions_apply: { action: "funnel_suggestions", apply: true },
};
const USER_ACTIONS = Object.keys(FB_BODIES) as UserAction[];

describe("policy tables", () => {
  it("are valid and cover every action (clickhouse-facebook: every user action has a body; cron owns cron_daily)", () => {
    expect(() => assertValidPolicy(CLICKHOUSE_FACEBOOK_POLICY)).not.toThrow();
    expect(() => assertValidPolicy(CAPSULED_FACEBOOK_SYNC_POLICY)).not.toThrow();
    expect(CLICKHOUSE_FACEBOOK_POLICY.fn).toBe("clickhouse-facebook");
    expect(CAPSULED_FACEBOOK_SYNC_POLICY.fn).toBe("capsuled-facebook-sync");
    expect([...USER_ACTIONS, "cron_daily"].sort()).toEqual(Object.keys(CLICKHOUSE_FACEBOOK_POLICY.actions).sort());
    expect(CLICKHOUSE_FACEBOOK_POLICY.methods).toEqual(["POST"]);
    expect(CLICKHOUSE_FACEBOOK_POLICY.cron).toEqual({ header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["cron_daily"] });
    expect(CAPSULED_FACEBOOK_SYNC_POLICY.methods).toEqual(["GET", "POST"]);
    expect(CAPSULED_FACEBOOK_SYNC_POLICY.cron).toBeUndefined();
  });

  it("match the Phase-1 permission table exactly (none is scopeReady)", () => {
    const FB = ["facebook_analytics.view"];
    const DIAG = ["admin.diagnostics.view"];
    expect(CLICKHOUSE_FACEBOOK_POLICY.actions).toEqual({
      report: { anyOf: FB },
      list: { anyOf: FB },
      charts: { anyOf: FB },
      filters: { anyOf: FB },
      summary: { anyOf: FB },
      status: { anyOf: ["facebook_analytics.view", "cohorts.view"] },
      v2_preview: { allOf: [...FB, ...DIAG] },
      funnel_spend: { anyOf: FB, fullScopeOnly: true },
      spend_ledger: { anyOf: ["forecasting.view"] },
      history_runs: { anyOf: DIAG },
      history_batches: { anyOf: DIAG },
      history_versions: { anyOf: DIAG },
      history_raw_payloads: { anyOf: DIAG },
      history_dq: { anyOf: DIAG },
      recon_history: { anyOf: DIAG },
      v2_parity: { anyOf: DIAG },
      v2_dims_status: { anyOf: ["admin.warehouse.manage", "admin.diagnostics.view"] },
      source_probe: { anyOf: DIAG },
      sync: { allOf: ["admin.sync.run"], write: true },
      recon_snapshot: { anyOf: ["admin.warehouse.manage", "admin.sync.run"], write: true },
      v2_dims_backfill: { allOf: ["admin.warehouse.manage"], write: true },
      seed_campaign_aliases: { allOf: ["admin.warehouse.manage"], write: true },
      funnel_suggestions: { allOf: ["funnels.manage"] },
      funnel_suggestions_apply: { allOf: ["funnels.manage", "admin.warehouse.manage"], write: true },
      cron_daily: { ownerOnly: true, rawOnly: true, allOf: ["admin.sync.run", "admin.warehouse.manage"], write: true },
    });
    expect(CAPSULED_FACEBOOK_SYNC_POLICY.actions).toEqual({ sync: { allOf: ["admin.sync.run"], write: true } });
    for (const policy of [CLICKHOUSE_FACEBOOK_POLICY, CAPSULED_FACEBOOK_SYNC_POLICY] as FunctionPolicy<string>[]) {
      for (const entry of Object.values(policy.actions)) {
        expect(entry.scopeReady).toBeFalsy();
        // Every policy names permissions (no "any active member" action).
        expect([...(entry.anyOf ?? []), ...(entry.allOf ?? [])].length).toBeGreaterThan(0);
        for (const key of [...(entry.anyOf ?? []), ...(entry.allOf ?? [])]) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
      }
    }
  });

  it("DDL runs only on the write actions, history never opens ClickHouse", () => {
    expect([...FB_SCHEMA_WRITE_ACTIONS].sort()).toEqual(["funnel_suggestions_apply", "recon_snapshot", "seed_campaign_aliases", "sync", "v2_dims_backfill"]);
    for (const action of FB_SCHEMA_WRITE_ACTIONS) expect(CLICKHOUSE_FACEBOOK_POLICY.actions[action].write).toBe(true);
    expect([...FB_HISTORY_ACTIONS].sort()).toEqual(["history_batches", "history_dq", "history_raw_payloads", "history_runs", "history_versions"]);
  });
});

describe("canonical action normalizers (rule R3)", () => {
  const user = (body: Record<string, unknown>) => normalizeClickHouseFacebookAction({ method: "POST", body, url: new URL("https://edge.test"), cron: false });
  const cron = (body: Record<string, unknown>) => normalizeClickHouseFacebookAction({ method: "POST", body, url: new URL("https://edge.test"), cron: true });

  it("maps every user action body to its policy key", () => {
    for (const action of USER_ACTIONS) expect(user(FB_BODIES[action])).toBe(action);
  });

  it("keeps the documented report default and the analytics alias", () => {
    expect(user({})).toBe("report");
    expect(user({ action: null, level: "campaign" })).toBe("report");
    expect(user({ action: "analytics" })).toBe("report");
    expect(fbResponseAction({})).toBe("report");
    expect(fbResponseAction({ action: "analytics" })).toBe("analytics");
  });

  it("turns the sensitive flags into their own actions with the handler's exact truthiness", () => {
    for (const action of ["report", "analytics", "list", "summary"]) expect(user({ action, v2_preview: true })).toBe("v2_preview");
    expect(user({ v2_preview: true })).toBe("v2_preview");
    // charts / filters ignore the flag (runFbList is the only V2-aware reader)
    expect(user({ action: "charts", v2_preview: true })).toBe("charts");
    expect(user({ action: "filters", v2_preview: true })).toBe("filters");
    for (const flag of ["true", 1, "yes"]) expect(user({ action: "list", v2_preview: flag })).toBe("list");
    expect(user({ action: "funnel_suggestions" })).toBe("funnel_suggestions");
    for (const flag of ["true", 1, false]) expect(user({ action: "funnel_suggestions", apply: flag })).toBe("funnel_suggestions");
    expect(user({ action: "funnel_suggestions", apply: true })).toBe("funnel_suggestions_apply");
    expect(fbV2PreviewRead({ action: "analytics", v2_preview: true })).toBe("report");
    expect(fbV2PreviewRead({ v2_preview: true })).toBe("report");
    expect(fbV2PreviewRead({ action: "summary", v2_preview: true })).toBe("summary");
    expect(() => fbV2PreviewRead({ action: "charts" })).toThrow(ActionNormalizeError);
  });

  it("rejects unknown, derived, cron-only and non-string actions on the user branch", () => {
    for (const body of [
      { action: "" },
      { action: "REPORT" },
      { action: "history_everything" },
      { action: "cron_daily" },
      { action: "v2_preview" },
      { action: "funnel_suggestions_apply" },
      { action: "delete" },
      { action: 5 },
      { action: ["report"] },
    ]) {
      expect(() => user(body as Record<string, unknown>), JSON.stringify(body)).toThrow(ActionNormalizeError);
    }
  });

  it("the cron branch only ever runs the daily tick", () => {
    expect(cron({ auth_user_id: DATA_KEY })).toBe("cron_daily");
    expect(cron({})).toBe("cron_daily");
    expect(cron({ action: "cron_daily" })).toBe("cron_daily");
    for (const action of ["sync", "report", "recon_snapshot"]) expect(() => cron({ action })).toThrow(ActionNormalizeError);
  });

  it("capsuled-facebook-sync: a body without an action IS the sync; GET too; anything else is 400", () => {
    const url = new URL("https://edge.test/functions/v1/capsuled-facebook-sync?dateFrom=2026-01-01&dateTo=2026-01-02");
    expect(normalizeCapsuledFacebookSyncAction({ method: "POST", body: { dateFrom: "2026-01-01", dateTo: "2026-01-02", level: "campaign" }, url })).toBe("sync");
    expect(normalizeCapsuledFacebookSyncAction({ method: "POST", body: { action: "sync" }, url })).toBe("sync");
    expect(normalizeCapsuledFacebookSyncAction({ method: "GET", body: {}, url })).toBe("sync");
    for (const body of [{ action: "status" }, { action: "" }, { action: 1 }]) {
      expect(() => normalizeCapsuledFacebookSyncAction({ method: "POST", body: body as Record<string, unknown>, url })).toThrow(ActionNormalizeError);
    }
  });
});

describe("gate decisions — clickhouse-facebook", () => {
  const ROLES: Array<{ name: string; permissions: string[]; allowed: UserAction[] }> = [
    { name: "FB viewer", permissions: ["facebook_analytics.view"], allowed: ["report", "list", "charts", "filters", "summary", "status", "funnel_spend"] },
    { name: "Cohorts viewer", permissions: ["cohorts.view"], allowed: ["status"] },
    { name: "Forecaster", permissions: ["forecasting.view"], allowed: ["spend_ledger"] },
    {
      name: "Diagnostics",
      permissions: ["admin.diagnostics.view"],
      allowed: ["history_runs", "history_batches", "history_versions", "history_raw_payloads", "history_dq", "recon_history", "v2_parity", "v2_dims_status", "source_probe"],
    },
    {
      // The V2 preview serves the same FB reads, so it needs the page permission as well.
      name: "FB viewer + diagnostics",
      permissions: ["facebook_analytics.view", "admin.diagnostics.view"],
      allowed: ["report", "list", "charts", "filters", "summary", "status", "funnel_spend", "v2_preview", "history_runs", "history_batches", "history_versions", "history_raw_payloads", "history_dq", "recon_history", "v2_parity", "v2_dims_status", "source_probe"],
    },
    { name: "Sync runner", permissions: ["admin.sync.run"], allowed: ["sync", "recon_snapshot"] },
    { name: "Warehouse", permissions: ["admin.warehouse.manage"], allowed: ["v2_dims_status", "recon_snapshot", "v2_dims_backfill", "seed_campaign_aliases"] },
    { name: "Funnel manager", permissions: ["funnels.view", "funnels.manage"], allowed: ["funnel_suggestions"] },
    {
      name: "Funnel + warehouse",
      permissions: ["funnels.view", "funnels.manage", "admin.warehouse.manage"],
      allowed: ["funnel_suggestions", "funnel_suggestions_apply", "v2_dims_status", "recon_snapshot", "v2_dims_backfill", "seed_campaign_aliases"],
    },
    { name: "Viewer template", permissions: ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"], allowed: ["status"] },
  ];

  it.each(ROLES)("$name reaches exactly its actions", async ({ permissions, allowed }) => {
    for (const action of USER_ACTIONS) {
      if (allowed.includes(action)) await expectAllowed(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES[action], memberRow(permissions), action);
      else await expectDenied(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES[action], memberRow(permissions), 403, ACCESS_ERROR.PERMISSION_DENIED);
    }
  });

  it("the data owner reaches every user action with the workspace tenant", async () => {
    for (const action of USER_ACTIONS) await expectAllowed(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES[action], ownerRow(), action);
    await expectAllowed(CLICKHOUSE_FACEBOOK_POLICY, {}, ownerRow(), "report");
  });

  it("a user can never run the cron tick, and unknown actions are 400 before access is resolved", async () => {
    for (const body of [{ action: "cron_daily" }, { action: "drop_table" }, { action: "" }]) {
      await expectDenied(CLICKHOUSE_FACEBOOK_POLICY, body, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });

  it("Milestone A: every funnel-restricted context gets 403 on every action", async () => {
    for (const scope of ["selected", "none"] as const) {
      for (const action of USER_ACTIONS) {
        // A (hypothetical) restricted Owner holds every permission, so this
        // proves the scope check itself: scope_not_supported, or
        // full_scope_required for the whole-tenant funnel_spend.
        const expected = CLICKHOUSE_FACEBOOK_POLICY.actions[action].fullScopeOnly ? ACCESS_ERROR.FULL_SCOPE_REQUIRED : ACCESS_ERROR.SCOPE_NOT_SUPPORTED;
        await expectDenied(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES[action], ownerRow(scope), 403, expected);
        // A restricted employee with every permission granted is refused too
        // (admin.* keys are not even effective without scope `all`).
        await expectDenied(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES[action], memberRow([...ENFORCED_PERMISSION_KEYS], scope), 403);
      }
    }
  });
});

describe("gate decisions — the cron tick", () => {
  async function cronCall(options: { secret?: string; body?: string; env?: Record<string, string> }) {
    const handler = echoHandler();
    const deps = makeDeps(ownerRow(), options.env ?? { FB_CRON_SECRET: CRON_SECRET });
    const req = new Request("https://edge.test/functions/v1/clickhouse-facebook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-cron-secret": options.secret ?? CRON_SECRET },
      body: options.body ?? JSON.stringify({ auth_user_id: DATA_KEY }),
    });
    const response = await handleWithAccess(req, CLICKHOUSE_FACEBOOK_POLICY, handler as unknown as AccessHandler<ClickHouseFacebookAction>, deps);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, handler, deps };
  }

  it("runs cron_daily for the workspace data key with the secret — no user session involved", async () => {
    const result = await cronCall({});
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, action: "cron_daily", tenant: DATA_KEY, actor: "cron" });
    expect(result.deps.getUser).not.toHaveBeenCalled();
    expect(result.deps.loadAccess).not.toHaveBeenCalled();
    const bodyless = await cronCall({ body: "" });
    expect(bodyless.status).toBe(200);
  });

  it("checks the secret before reading the body", async () => {
    const wrong = await cronCall({ secret: "nope", body: "{not json" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error_code).toBe(ACCESS_ERROR.INVALID_CRON_SECRET);
    expect(wrong.handler).not.toHaveBeenCalled();
    const badBody = await cronCall({ body: "{not json" });
    expect(badBody.status).toBe(400);
    expect(badBody.body.error_code).toBe(ACCESS_ERROR.INVALID_BODY);
  });

  it("never takes the tenant from the body, and only runs the daily tick", async () => {
    const foreign = await cronCall({ body: JSON.stringify({ auth_user_id: EMPLOYEE }) });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error_code).toBe(ACCESS_ERROR.TENANT_MISMATCH);
    expect(foreign.handler).not.toHaveBeenCalled();
    const other = await cronCall({ body: JSON.stringify({ auth_user_id: DATA_KEY, action: "sync" }) });
    expect(other.status).toBe(400);
    expect(other.handler).not.toHaveBeenCalled();
    const unconfigured = await cronCall({ env: {} });
    expect(unconfigured.status).toBe(503);
    expect(unconfigured.body.error_code).toBe(ACCESS_ERROR.CRON_NOT_CONFIGURED);
  });
});

describe("gate decisions — capsuled-facebook-sync", () => {
  const SYNC_BODY = { dateFrom: "2026-09-01", dateTo: "2026-09-07", level: "campaign" };

  it("admin.sync.run (or the data owner) may sync; page viewers and integration viewers may not", async () => {
    await expectAllowed(CAPSULED_FACEBOOK_SYNC_POLICY, SYNC_BODY, memberRow(["admin.sync.run"]), "sync");
    await expectAllowed(CAPSULED_FACEBOOK_SYNC_POLICY, SYNC_BODY, ownerRow(), "sync");
    for (const permissions of [["facebook_analytics.view"], ["admin.integrations.view"], ["admin.warehouse.manage", "admin.diagnostics.view"]]) {
      await expectDenied(CAPSULED_FACEBOOK_SYNC_POLICY, SYNC_BODY, memberRow(permissions), 403, ACCESS_ERROR.PERMISSION_DENIED);
    }
    await expectDenied(CAPSULED_FACEBOOK_SYNC_POLICY, { ...SYNC_BODY, action: "status" }, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("GET keeps working; other methods are 405", async () => {
    const get = await call(CAPSULED_FACEBOOK_SYNC_POLICY, null, memberRow(["admin.sync.run"]), {
      method: "GET",
      url: "https://edge.test/functions/v1/capsuled-facebook-sync?dateFrom=2026-09-01&dateTo=2026-09-01&level=campaign",
    });
    expect(get.status).toBe(200);
    expect(get.body.tenant).toBe(DATA_KEY);
    const put = await call(CAPSULED_FACEBOOK_SYNC_POLICY, SYNC_BODY, ownerRow(), { method: "PUT" });
    expect(put.status).toBe(405);
  });

  it("CORS comes from the shared builder (GET, POST, OPTIONS as before)", async () => {
    const req = new Request("https://edge.test/functions/v1/capsuled-facebook-sync", { method: "OPTIONS" });
    const response = await handleWithAccess(req, CAPSULED_FACEBOOK_SYNC_POLICY, echoHandler() as never, makeDeps(ownerRow()));
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(response.headers.get("Access-Control-Allow-Headers")).toBe("authorization, x-client-info, apikey, content-type");
  });

  it("Milestone A: funnel-restricted contexts are refused", async () => {
    for (const scope of ["selected", "none"] as const) {
      await expectDenied(CAPSULED_FACEBOOK_SYNC_POLICY, SYNC_BODY, ownerRow(scope), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
      await expectDenied(CAPSULED_FACEBOOK_SYNC_POLICY, SYNC_BODY, memberRow([...ENFORCED_PERMISSION_KEYS], scope), 403);
    }
  });
});

// ---- error bodies ------------------------------------------------------------------

describe("error responses: today's bodies for the owner, generic ones for everyone else", () => {
  it("fbWarehouseErrorResponse reproduces the pre-access status / body", () => {
    expect(fbWarehouseErrorResponse(new FacebookStatsRequestError("Invalid date_from (YYYY-MM-DD): x"), "list")).toEqual({
      status: 400,
      body: { ok: false, action: "list", source: "clickhouse", error: "Invalid date_from (YYYY-MM-DD): x" },
    });
    const validation = fbWarehouseErrorResponse(new FacebookStatsValidationError({ day_spend_total: SENTINEL_SPEND }), "sync");
    expect(validation.status).toBe(422);
    expect(validation.body).toMatchObject({ ok: false, action: "sync", source: "clickhouse", error_code: "FB_SPEND_MISMATCH" });
    expect(JSON.stringify(validation.body)).not.toContain(String(SENTINEL_SPEND));
    expect(fbWarehouseErrorResponse(new Error("Code: 60. DB::Exception: Table default.secret doesn't exist"), "analytics")).toEqual({
      status: 502,
      body: { ok: false, action: "analytics", source: "clickhouse", error: "Facebook warehouse action failed." },
    });
  });

  const throwing = (error: Error) => vi.fn(async () => {
    throw error;
  });

  it("clickhouse-facebook: the owner keeps the body (+ request_id), an employee gets the generic one", async () => {
    const failure = new FbActionError(502, { ok: false, action: "history_runs", error: "Could not list facebook sync runs: relation secret_table" });
    const serve = { onError: clickHouseFacebookErrorResponse };
    const owner = await call(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES.history_runs, ownerRow(), { handler: throwing(failure) as never, serve });
    expect(owner.status).toBe(502);
    expect(owner.body).toEqual({ ok: false, action: "history_runs", error: "Could not list facebook sync runs: relation secret_table", request_id: "req-test-1" });
    const employee = await call(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES.history_runs, memberRow(["admin.diagnostics.view"]), { handler: throwing(failure) as never, serve });
    expect(employee.status).toBe(502);
    expect(employee.body).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-test-1" });
    const badRequest = await call(CLICKHOUSE_FACEBOOK_POLICY, FB_BODIES.list, memberRow(["facebook_analytics.view"]), {
      handler: throwing(new FbActionError(400, { ok: false, action: "list", source: "clickhouse", error: "Filter buyer must be an array of strings." })) as never,
      serve,
    });
    expect(badRequest.status).toBe(400);
    expect(badRequest.body.error_code).toBe(ACCESS_ERROR.REQUEST_FAILED);
    expect(clickHouseFacebookErrorResponse(new Error("other"))).toBeNull();
  });

  it("capsuled-facebook-sync: upstream previews reach the owner only", async () => {
    const failure = new CapsuledSyncError(502, { error: "Capsuled returned non-JSON response", body_preview: "<html>upstream secret</html>", failedRequests: [], durationMs: 5 });
    const serve = { onError: capsuledFacebookSyncErrorResponse };
    const owner = await call(CAPSULED_FACEBOOK_SYNC_POLICY, {}, ownerRow(), { handler: throwing(failure) as never, serve });
    expect(owner.status).toBe(502);
    expect(owner.body.body_preview).toBe("<html>upstream secret</html>");
    const admin = await call(CAPSULED_FACEBOOK_SYNC_POLICY, {}, memberRow(["admin.sync.run"]), { handler: throwing(failure) as never, serve });
    expect(admin.status).toBe(502);
    expect(JSON.stringify(admin.body)).not.toContain("upstream secret");
    expect(capsuledFacebookSyncErrorResponse(new Error("x"))).toBeNull();
  });
});

// ---- redaction ---------------------------------------------------------------------

function contextFor(row: ReturnType<typeof accessRow>): AccessContext {
  const parsed = parseResolveAccessRow(row);
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: row.user_id, email: "member@example.com" }, "req-test-1");
}

describe("status: tenant-wide spend diagnostics are stripped for viewers", () => {
  const STATE = {
    auth_user_id: DATA_KEY,
    sync_name: "fact_facebook_stats_sync",
    status: "completed",
    current_stage: "idle",
    cursor_transaction_id: "2026-09-14",
    cursor_updated_at: "2026-09-14T09:38:45.048Z",
    finished_at: "2026-09-14T10:00:00Z",
    duration_ms: 4000,
    rows_inserted: 120,
    clickhouse_total: 3000,
    last_error: "Capsuled API error HTTP 500: upstream body",
    diagnostics: {
      mode: "incremental",
      fb_stats_to: "2026-09-13",
      warehouse_version: "fbwh_abc",
      spend_by_level: { campaign: SENTINEL_SPEND, day: SENTINEL_SPEND },
      day_spend_total: SENTINEL_SPEND,
      spend_mismatch: [{ level: "campaign", level_spend: SENTINEL_SPEND, day_spend: SENTINEL_SPEND }],
    },
  };

  it("drops the spend totals, the data key and the raw error, keeps lifecycle and cursor", () => {
    const projected = projectFbSyncStateForViewer(STATE)!;
    expect(JSON.stringify(projected)).not.toContain(String(SENTINEL_SPEND));
    expect(JSON.stringify(projected)).not.toContain(DATA_KEY);
    expect(projected.last_error).toBeUndefined();
    expect(projected).toMatchObject({
      status: "completed",
      cursor_transaction_id: "2026-09-14",
      cursor_updated_at: "2026-09-14T09:38:45.048Z",
      finished_at: "2026-09-14T10:00:00Z",
      rows_inserted: 120,
      clickhouse_total: 3000,
      diagnostics: { mode: "incremental", fb_stats_to: "2026-09-13", warehouse_version: "fbwh_abc" },
    });
    expect(projectFbSyncStateForViewer(null)).toBeNull();
    expect(projectFbSyncStateForViewer({ status: "running", diagnostics: "garbage" })).toEqual({ status: "running", diagnostics: null });
    expect(projectFbSyncStateForViewer({ status: "running" })).toEqual({ status: "running" });
  });

  it("the browser's FB warehouse version is unchanged by the projection (Cohorts / FB caches keep keying)", () => {
    const diagnostics = { warehouse_rows: 3000 } as FbStatusResponse["diagnostics"];
    const full = fbWarehouseVersionFromStatus({ ok: true, state: STATE, diagnostics });
    const projected = fbWarehouseVersionFromStatus({ ok: true, state: projectFbSyncStateForViewer(STATE), diagnostics });
    expect(projected).toBe(full);
    expect(full).not.toBe("fbwhv_unknown");
  });

  it("full detail only for the data owner and diagnostics viewers", () => {
    expect(fbStatusDetailVisible(contextFor(ownerRow()))).toBe(true);
    expect(fbStatusDetailVisible(contextFor(memberRow(["admin.diagnostics.view"])))).toBe(true);
    expect(fbStatusDetailVisible(contextFor(memberRow(["facebook_analytics.view", "admin.sync.run"])))).toBe(false);
    expect(fbStatusDetailVisible(contextFor(memberRow(["cohorts.view"])))).toBe(false);
  });
});

describe("capsuled sync response: upstream payloads stay with the data owner", () => {
  const RESULT = {
    rows: [
      { campaign_id: "c1", spend: 10, raw_payload: { secret: "upstream-row" } },
      { campaign_id: "c2", spend: 5, raw_payload: [{ secret: "upstream-row-2" }] },
    ],
    metadata: { syncId: "s1", status: "success", rowsImported: 2, lastApiResponse: "{\"rows\":[\"upstream\"]}", failedRequests: [] },
    diagnostics: { campaignsImported: 2, lastApiResponse: "{\"rows\":[\"upstream\"]}", failedRequests: [] },
  };

  it("nulls raw_payload and lastApiResponse without changing the shape or the input", () => {
    const stripped = stripCapsuledSyncRawPayloads(RESULT);
    expect(JSON.stringify(stripped)).not.toContain("upstream");
    expect(stripped.rows).toEqual([
      { campaign_id: "c1", spend: 10, raw_payload: null },
      { campaign_id: "c2", spend: 5, raw_payload: null },
    ]);
    expect(stripped.metadata).toEqual({ ...RESULT.metadata, lastApiResponse: null });
    expect(stripped.diagnostics).toEqual({ ...RESULT.diagnostics, lastApiResponse: null });
    expect(RESULT.rows[0].raw_payload).toEqual({ secret: "upstream-row" });
  });

  it("only raw access sees them", () => {
    expect(capsuledRawPayloadsVisible(contextFor(ownerRow()))).toBe(true);
    expect(capsuledRawPayloadsVisible(contextFor(memberRow(["admin.sync.run", "admin.diagnostics.view"])))).toBe(false);
  });
});

// ---- runners -----------------------------------------------------------------------

type Call = [string, string, ...unknown[]];

/** A PostgREST-shaped fake: every builder method is recorded and chainable, and
 * awaiting the builder resolves `{ data: [], error: null }`. */
function recordingPg(calls: Call[] = []): SupabaseLikeClient & { calls: Call[] } {
  return {
    calls,
    from(table: string) {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "lte", "gte", "order", "limit", "in", "is", "or", "neq", "range"]) {
        builder[method] = (...args: unknown[]) => {
          calls.push([table, method, ...args]);
          return builder;
        };
      }
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.upsert = async () => ({ data: null, error: null });
      builder.insert = async () => ({ data: null, error: null });
      builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject);
      return builder as never;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

function fakeClickHouse(failOn: (sql: string) => boolean, error: Error): ClickHouseClientLike {
  return {
    query: vi.fn(async (input: { query: string }) => {
      if (failOn(input.query)) throw error;
      return { json: async () => [] };
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  };
}

const violation = () => new ScopeViolation("restricted_protected_table", "fact_facebook_stats");

describe("FB runners: best-effort catches rethrow ScopeViolation", () => {
  const isMappingSummary = (sql: string) => sql.includes("fbc AS (SELECT DISTINCT campaign_id");

  it("report: the mapping block still degrades on a warehouse error...", async () => {
    const report = await runFbReport({ clickhouse: fakeClickHouse(isMappingSummary, new Error("boom")), supabase: recordingPg(), authUserId: DATA_KEY, request: { action: "report" } });
    expect(report.ok).toBe(true);
    expect(report.diagnostics.mapping).toBeUndefined();
  });

  it("report: ...but a ScopeViolation fails the request", async () => {
    await expect(
      runFbReport({ clickhouse: fakeClickHouse(isMappingSummary, violation()), supabase: recordingPg(), authUserId: DATA_KEY, request: { action: "report" } }),
    ).rejects.toBeInstanceOf(ScopeViolation);
  });

  it("recon snapshot: DQ and V2-parity lookups stay fail-safe, except for a ScopeViolation", async () => {
    const isDq = (sql: string) => sql.includes("facebook_dq_results");
    const isParity = (sql: string) => sql.includes("count() AS rows");
    const input = (clickhouse: ClickHouseClientLike) => ({ clickhouse, supabase: recordingPg(), authUserId: DATA_KEY, dateFrom: "2026-09-01", dateTo: "2026-09-07" });
    await expect(runFbReconSnapshot(input(fakeClickHouse(isDq, new Error("no table"))))).resolves.toMatchObject({ dq_warn_count: 0, dq_fail_count: 0 });
    await expect(runFbReconSnapshot(input(fakeClickHouse(isParity, new Error("no V2"))))).resolves.toMatchObject({ details: { v2_parity: null } });
    await expect(runFbReconSnapshot(input(fakeClickHouse(isDq, violation())))).rejects.toBeInstanceOf(ScopeViolation);
    await expect(runFbReconSnapshot(input(fakeClickHouse(isParity, violation())))).rejects.toBeInstanceOf(ScopeViolation);
  });

  it("V2 dual-writer: warehouse faults are recorded, a write under the wrong tenant fails the sync", async () => {
    const writer = (clickhouse: ClickHouseClientLike, authUserId: string) =>
      createFbWarehouseV2Writer({ clickhouse, supabase: recordingPg(), authUserId, batchId: "b1", runId: "r1", warehouseVersion: "fbwh_1", nowIso: "2026-09-14T00:00:00.000Z" });

    const down: ClickHouseClientLike = { ...fakeClickHouse(() => false, new Error("unused")), insert: vi.fn(async () => { throw new Error("v2 down"); }) };
    const degraded = writer(down, DATA_KEY);
    await expect(degraded.mirrorBatch("staged")).resolves.toBeUndefined();
    expect(degraded.errors.some((entry) => entry.startsWith("registry:staged"))).toBe(true);
    const violating: ClickHouseClientLike = { ...fakeClickHouse(() => false, new Error("unused")), insert: vi.fn(async () => { throw violation(); }) };
    await expect(writer(violating, DATA_KEY).mirrorBatch("staged")).rejects.toBeInstanceOf(ScopeViolation);

    // Through a real ScopedReader: the workspace tenant passes, the caller's own id is a violation.
    const ctx = contextFor(memberRow(["admin.sync.run"]));
    const raw = fakeClickHouse(() => false, new Error("unused"));
    await expect(writer(createScopedReader(ctx, raw), ctx.tenantKey).mirrorBatch("staged")).resolves.toBeUndefined();
    expect(raw.insert).toHaveBeenCalledWith(expect.objectContaining({ table: FB_BATCH_REGISTRY_TABLE }));
    expect(ctx.violations).toEqual([]);
    const legacy = writer(createScopedReader(ctx, raw), EMPLOYEE);
    await expect(legacy.mirrorBatch("staged")).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain(`tenant_row_mismatch:${FB_BATCH_REGISTRY_TABLE}`);
  });
});

describe("Phase 0: spend-ledger known gaps are read for the tenant only", () => {
  it("filters facebook_known_gaps by auth_user_id before the window overlap", async () => {
    const pg = recordingPg();
    const result = await runProjectSpendLedger({
      clickhouse: fakeClickHouse(() => false, new Error("unused")),
      supabase: pg as never,
      authUserId: DATA_KEY,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
    });
    expect(result.window).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    const gapCalls = pg.calls.filter(([table]) => table === "facebook_known_gaps").map(([, method, ...args]) => [method, ...args]);
    expect(gapCalls).toEqual([
      ["select", "gap_id,gap_from,gap_to,reason"],
      ["eq", "auth_user_id", DATA_KEY],
      ["lte", "gap_from", "2026-09-30"],
      ["gte", "gap_to", "2026-09-01"],
    ]);
  });
});

// ---- entrypoints -------------------------------------------------------------------

describe("index.ts entrypoints are on the gate", () => {
  const ENTRYPOINTS: Record<string, string> = {
    "clickhouse-facebook": "CLICKHOUSE_FACEBOOK_POLICY",
    "capsuled-facebook-sync": "CAPSULED_FACEBOOK_SYNC_POLICY",
  };
  const source = (fn: string) => readFileSync(resolve(process.cwd(), `supabase/functions/${fn}/index.ts`), "utf8");

  it.each(Object.entries(ENTRYPOINTS))("%s serves through serveWithAccess(%s) with the tenant key", (fn, policyName) => {
    const text = source(fn);
    expect(text).toMatch(new RegExp(`serveWithAccess\\(\\s*${policyName},`));
    expect(text).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    expect(text).toContain("ctx.tenantKey");
    for (const banned of [
      "requireSupabaseUser",
      "requireCronSecret",
      "createClickHouseClient",
      "clickhouse/client.ts",
      "Deno.serve(",
      "auth.id",
      "parseJsonBody",
      "Access-Control-Allow-Origin",
      "x-cron-secret",
      "auth.getUser",
      "req.json(",
    ]) {
      expect(text, banned).not.toContain(banned);
    }
  });

  it("clickhouse-facebook: DDL only behind the write-action set, every catch rethrows ScopeViolation", () => {
    const text = source("clickhouse-facebook");
    expect(text.match(/ensureFactFacebookStatsSchema\(/g)).toHaveLength(1);
    expect(text).toContain("if (FB_SCHEMA_WRITE_ACTIONS.has(action)) await ensureFactFacebookStatsSchema(ch);");
    const catches = text.match(/catch \(error\) \{/g) ?? [];
    const rethrows = text.match(/if \(error instanceof ScopeViolation( \|\| error instanceof FbActionError)?\) throw error;/g) ?? [];
    expect(catches.length).toBeGreaterThan(0);
    expect(rethrows.length).toBe(catches.length);
  });

  it("capsuled-facebook-sync writes every row under the tenant key, never the caller", () => {
    const text = source("capsuled-facebook-sync");
    expect(text).not.toMatch(/\buserId\b/);
    expect(text).not.toContain("corsHeaders");
    expect(text.match(/user_id: tenantKey/g)?.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain('.eq("user_id", tenantKey)');
    expect(text).toContain("p_auth_user_id: tenantKey");
  });
});
