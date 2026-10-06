// Access migration of the warehouse-operations Edge functions — clickhouse-init,
// clickhouse-backfill, clickhouse-validate, clickhouse-health (plan §7 row
// "Warehouse ops", §10, §13, §27 — Phase 0 + Milestone A). The four policies are
// driven through the pure gate core (handleWithAccess) with fake dependencies,
// and the runners through a real ScopedReader, so these tests prove: who may
// call which action (init: Owner ∧ data owner; backfill / validate:
// admin.warehouse.manage; health: integrations or diagnostics), that every
// funnel-restricted context is refused, that health strips config detail for
// employees, that init reports the TENANT's row counts (Phase 0), that the
// backfill runs under a compare-and-set lease, and that the validation
// pipeline no longer folds a ScopeViolation into a resumable answer.
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
  CLICKHOUSE_INIT_POLICY,
  clickHouseInitErrorResponse,
  normalizeClickHouseInitAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-init.ts";
import {
  CLICKHOUSE_BACKFILL_POLICY,
  clickHouseBackfillErrorResponse,
  normalizeClickHouseBackfillAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-backfill.ts";
import {
  CLICKHOUSE_VALIDATE_POLICY,
  clickHouseValidateErrorResponse,
  normalizeClickHouseValidateAction,
  validationFailureFallback,
  validationStateOnly,
} from "../../supabase/functions/_shared/access/policies/clickhouse-validate.ts";
import {
  CLICKHOUSE_HEALTH_FAILED_MESSAGE,
  CLICKHOUSE_HEALTH_POLICY,
  CLICKHOUSE_NOT_CONFIGURED_MESSAGE,
  healthDetailVisible,
  normalizeClickHouseHealthAction,
  projectHealthForViewer,
} from "../../supabase/functions/_shared/access/policies/clickhouse-health.ts";
import {
  INIT_TENANT_COHORT_ROW_COUNT_SQL,
  INIT_TENANT_ROW_COUNT_SQL,
  initializeClickHouseSchema,
} from "../../supabase/functions/_shared/clickhouse/schema.ts";
import {
  BACKFILL_LEASE_STALE_MS,
  BACKFILL_RUN_STAGES,
  backfillLeaseClaimFilter,
  backfillLeaseRetryAfter,
  runTransactionsBackfill,
  type BackfillParams,
} from "../../supabase/functions/_shared/clickhouse/backfill.ts";
import { runValidation } from "../../supabase/functions/_shared/clickhouse/validationPipeline.ts";
import { describeClickHouseBackfillResult } from "@/services/clickhouse";
import type { SupabaseTransactionRow } from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import type {
  ClickHouseClientLike,
  SupabaseLikeClient,
  SupabaseQueryBuilder,
  SupabaseQueryResult,
} from "../../supabase/functions/_shared/clickhouse/types.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";

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

type Row = ReturnType<typeof accessRow>;

const ownerRow = (scope: Scope = "all") => accessRow({ userId: DATA_KEY, isOwner: true, scope });
const memberRow = (permissions: string[], scope: Scope = "all") => accessRow({ permissions, scope });

function contextFor(row: Row): AccessContext {
  const parsed = parseResolveAccessRow(row);
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: row.user_id, email: "member@example.com" }, "req-test-1");
}

function fakeRaw(): ClickHouseClientLike {
  return {
    query: vi.fn(async () => ({ json: async () => [] as unknown })),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function makeDeps(row: Row): AccessGateDeps {
  const raw = fakeRaw();
  return {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async () => ({ data: { user: { id: row.user_id, email: "member@example.com" } }, error: null })),
    loadAccess: vi.fn(async () => ({ data: row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn(() => undefined),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, raw)),
    newRequestId: () => "req-test-1",
    log: vi.fn(),
  };
}

async function call<A extends string>(
  policy: FunctionPolicy<A>,
  body: unknown,
  row: Row,
  options: { method?: string; handler?: AccessHandler<A>; serve?: ServeWithAccessOptions } = {},
) {
  const handler = vi.fn(options.handler ?? (async ({ action, ctx }: Parameters<AccessHandler<A>>[0]) => ({ ok: true, action, tenant: ctx.tenantKey })));
  const method = options.method ?? "POST";
  const req = new Request("https://edge.test/functions/v1/fn", {
    method,
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const response = await handleWithAccess(req, policy, handler as unknown as AccessHandler<A>, makeDeps(row), options.serve);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, handler };
}

async function expectAllowed<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: Row, action: A) {
  const result = await call(policy, body, row);
  expect(result.status, `${policy.fn} ${JSON.stringify(body)}`).toBe(200);
  // The handler always sees the workspace data key as tenant, never the caller.
  expect(result.body).toEqual({ ok: true, action, tenant: DATA_KEY });
}

async function expectDenied<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: Row, status: number, code: string) {
  const result = await call(policy, body, row);
  expect(result.status, `${policy.fn} ${JSON.stringify(body)}`).toBe(status);
  expect(result.body.error_code, `${policy.fn} ${JSON.stringify(body)}`).toBe(code);
  expect(result.handler).not.toHaveBeenCalled();
}

// Every policy, every action, with a body that normalizes to it.
const MATRIX: Array<{ policy: FunctionPolicy<string>; bodies: Record<string, Record<string, unknown>> }> = [
  { policy: CLICKHOUSE_INIT_POLICY as FunctionPolicy<string>, bodies: { init: {} } },
  {
    policy: CLICKHOUSE_BACKFILL_POLICY as FunctionPolicy<string>,
    bodies: {
      continue: { mode: "continue", batch_size: 2000, max_batches: 10, dry_run: false, full_reset_cursor: false },
      full_backfill: { mode: "full_backfill", full_reset_cursor: true },
      validate_only: { mode: "validate_only" },
      dedup: { mode: "dedup" },
    },
  },
  {
    policy: CLICKHOUSE_VALIDATE_POLICY as FunctionPolicy<string>,
    bodies: {
      start: { action: "start", validation_scope: "imported_cursor_range", page_size: 500, max_pages: 3 },
      continue: { action: "continue" },
      status: { action: "status" },
      reset: { action: "reset", validation_scope: "imported_cursor_range" },
    },
  },
  { policy: CLICKHOUSE_HEALTH_POLICY as FunctionPolicy<string>, bodies: { health: {} } },
];

const WAREHOUSE_ACTIONS = MATRIX.filter(({ policy }) => policy.fn === "clickhouse-backfill" || policy.fn === "clickhouse-validate");

describe("policy tables", () => {
  it("are valid, named after their function, and cover every action with a body", () => {
    for (const { policy, bodies } of MATRIX) {
      expect(() => assertValidPolicy(policy)).not.toThrow();
      expect(Object.keys(bodies).sort()).toEqual(Object.keys(policy.actions).sort());
      expect(policy.cron).toBeUndefined();
    }
    expect(MATRIX.map(({ policy }) => policy.fn)).toEqual(["clickhouse-init", "clickhouse-backfill", "clickhouse-validate", "clickhouse-health"]);
    expect(CLICKHOUSE_INIT_POLICY.methods).toEqual(["POST"]);
    expect(CLICKHOUSE_BACKFILL_POLICY.methods).toEqual(["POST"]);
    expect(CLICKHOUSE_VALIDATE_POLICY.methods).toEqual(["POST"]);
    // Health answered GET and POST before access control and still does.
    expect(CLICKHOUSE_HEALTH_POLICY.methods).toEqual(["GET", "POST"]);
  });

  it("match the Phase-1 permission table exactly (none is scopeReady)", () => {
    expect(CLICKHOUSE_INIT_POLICY.actions).toEqual({ init: { ownerOnly: true, rawOnly: true, write: true } });
    const manage = { allOf: ["admin.warehouse.manage"], write: true };
    expect(CLICKHOUSE_BACKFILL_POLICY.actions).toEqual({ continue: manage, full_backfill: manage, validate_only: manage, dedup: manage });
    expect(CLICKHOUSE_VALIDATE_POLICY.actions).toEqual({
      start: manage,
      continue: manage,
      status: { allOf: ["admin.warehouse.manage"] },
      reset: manage,
    });
    expect(CLICKHOUSE_HEALTH_POLICY.actions).toEqual({ health: { anyOf: ["admin.integrations.view", "admin.diagnostics.view"] } });
    for (const { policy } of MATRIX) {
      for (const entry of Object.values(policy.actions)) {
        expect(entry.scopeReady).toBeFalsy();
        // never "any active member": every action names a requirement
        expect(Boolean(entry.anyOf?.length || entry.allOf?.length || entry.rawOnly || entry.ownerOnly)).toBe(true);
        for (const key of [...(entry.anyOf ?? []), ...(entry.allOf ?? [])]) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
      }
    }
  });
});

describe("canonical action normalizers (rule R3: no silent defaults beyond the documented ones)", () => {
  const input = (body: Record<string, unknown>) => ({ method: "POST", body, url: new URL("https://edge.test/") });

  it("clickhouse-init: the browser's empty body is init; nothing else is", () => {
    expect(normalizeClickHouseInitAction(input({}))).toBe("init");
    expect(normalizeClickHouseInitAction(input({ action: null }))).toBe("init");
    expect(normalizeClickHouseInitAction(input({ action: "init" }))).toBe("init");
    for (const body of [{ action: "drop" }, { action: "" }, { action: ["init"] }]) {
      expect(() => normalizeClickHouseInitAction(input(body))).toThrow(ActionNormalizeError);
    }
  });

  it("clickhouse-backfill: the mode is the action, a cursor reset is a full backfill, a missing mode is rejected", () => {
    expect(normalizeClickHouseBackfillAction(input({ mode: "continue" }))).toBe("continue");
    expect(normalizeClickHouseBackfillAction(input({ mode: "continue", full_reset_cursor: false }))).toBe("continue");
    expect(normalizeClickHouseBackfillAction(input({ mode: "continue", full_reset_cursor: true }))).toBe("full_backfill");
    expect(normalizeClickHouseBackfillAction(input({ mode: "full_backfill" }))).toBe("full_backfill");
    expect(normalizeClickHouseBackfillAction(input({ mode: "validate_only" }))).toBe("validate_only");
    expect(normalizeClickHouseBackfillAction(input({ mode: "dedup", dry_run: true }))).toBe("dedup");
    for (const body of [{}, { mode: null }, { mode: "nonsense" }, { mode: "CONTINUE" }, { action: "continue" }]) {
      expect(() => normalizeClickHouseBackfillAction(input(body))).toThrow(ActionNormalizeError);
    }
  });

  it("clickhouse-validate: a missing action is start (validateClickHouseTransactions); unknown actions are rejected", () => {
    expect(normalizeClickHouseValidateAction(input({ batch_size: 2000, validation_scope: "full_dataset" }))).toBe("start");
    expect(normalizeClickHouseValidateAction(input({ action: null }))).toBe("start");
    for (const action of ["start", "continue", "status", "reset"]) expect(normalizeClickHouseValidateAction(input({ action }))).toBe(action);
    for (const body of [{ action: "repair" }, { action: "" }, { action: "STATUS" }]) {
      expect(() => normalizeClickHouseValidateAction(input(body))).toThrow(ActionNormalizeError);
    }
    expect(validationStateOnly("status")).toBe(true);
    expect(validationStateOnly("reset")).toBe(true);
    expect(validationStateOnly("start")).toBe(false);
    expect(validationFailureFallback("reset")).toBe("ClickHouse validation state request failed.");
    expect(validationFailureFallback("continue")).toBe("ClickHouse transaction validation failed.");
  });

  it("clickhouse-health: GET / an empty body is the probe; nothing else is", () => {
    expect(normalizeClickHouseHealthAction({ method: "GET", body: {}, url: new URL("https://edge.test/") })).toBe("health");
    expect(normalizeClickHouseHealthAction(input({ action: "health" }))).toBe("health");
    expect(() => normalizeClickHouseHealthAction(input({ action: "credentials" }))).toThrow(ActionNormalizeError);
  });
});

describe("gate decisions per function", () => {
  const everything = [...ENFORCED_PERMISSION_KEYS];

  it("clickhouse-init: the Owner who is the data owner — nobody else, whatever their permissions", async () => {
    await expectAllowed(CLICKHOUSE_INIT_POLICY, {}, ownerRow(), "init");
    // A second Owner (every permission, not the data key) and an all-permission employee.
    await expectDenied(CLICKHOUSE_INIT_POLICY, {}, accessRow({ userId: EMPLOYEE, isOwner: true }), 403, ACCESS_ERROR.RAW_ACCESS_REQUIRED);
    await expectDenied(CLICKHOUSE_INIT_POLICY, {}, memberRow(everything), 403, ACCESS_ERROR.OWNER_REQUIRED);
    await expectDenied(CLICKHOUSE_INIT_POLICY, {}, memberRow(["admin.warehouse.manage"]), 403, ACCESS_ERROR.OWNER_REQUIRED);
    await expectDenied(CLICKHOUSE_INIT_POLICY, { action: "drop" }, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("clickhouse-backfill / clickhouse-validate: admin.warehouse.manage on every action", async () => {
    for (const { policy, bodies } of WAREHOUSE_ACTIONS) {
      for (const [action, body] of Object.entries(bodies)) {
        await expectAllowed(policy, body, memberRow(["admin.warehouse.manage"]), action);
        await expectAllowed(policy, body, accessRow({ userId: EMPLOYEE, isOwner: true }), action);
        for (const permissions of [["admin.integrations.view"], ["admin.diagnostics.view"], ["admin.sync.run", "admin.data.import"], ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"]]) {
          await expectDenied(policy, body, memberRow(permissions), 403, ACCESS_ERROR.PERMISSION_DENIED);
        }
      }
    }
    await expectDenied(CLICKHOUSE_BACKFILL_POLICY, {}, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    await expectDenied(CLICKHOUSE_BACKFILL_POLICY, { mode: "truncate" }, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    await expectDenied(CLICKHOUSE_VALIDATE_POLICY, { action: "repair" }, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
    // The frontend's action-less validation request still starts a run.
    await expectAllowed(CLICKHOUSE_VALIDATE_POLICY, { batch_size: 2000, reconciliation_limit: 5000, validation_scope: "imported_cursor_range" }, ownerRow(), "start");
  });

  it("clickhouse-health: Integrations or Diagnostics, over GET and POST", async () => {
    for (const permissions of [["admin.integrations.view"], ["admin.diagnostics.view"]]) {
      await expectAllowed(CLICKHOUSE_HEALTH_POLICY, {}, memberRow(permissions), "health");
      const viaGet = await call(CLICKHOUSE_HEALTH_POLICY, undefined, memberRow(permissions), { method: "GET" });
      expect(viaGet.status).toBe(200);
      expect(viaGet.body).toEqual({ ok: true, action: "health", tenant: DATA_KEY });
    }
    for (const permissions of [["admin.warehouse.manage"], ["admin.sync.run"], ["dashboard.view", "cohorts.view"]]) {
      await expectDenied(CLICKHOUSE_HEALTH_POLICY, {}, memberRow(permissions), 403, ACCESS_ERROR.PERMISSION_DENIED);
    }
  });

  it("only POST reaches init / backfill / validate", async () => {
    for (const policy of [CLICKHOUSE_INIT_POLICY, CLICKHOUSE_BACKFILL_POLICY, CLICKHOUSE_VALIDATE_POLICY] as FunctionPolicy<string>[]) {
      const result = await call(policy, undefined, ownerRow(), { method: "GET" });
      expect(result.status).toBe(405);
      expect(result.body.error_code).toBe(ACCESS_ERROR.METHOD_NOT_ALLOWED);
      expect(result.handler).not.toHaveBeenCalled();
    }
  });

  it("the data owner reaches every action with the workspace tenant", async () => {
    for (const { policy, bodies } of MATRIX) {
      for (const [action, body] of Object.entries(bodies)) await expectAllowed(policy, body, ownerRow(), action);
    }
  });

  it("Milestone A: no funnel-restricted context reaches any action", async () => {
    for (const scope of ["selected", "none"] as const) {
      for (const { policy, bodies } of MATRIX) {
        for (const body of Object.values(bodies)) {
          // A (hypothetical) restricted data owner proves the scope check itself …
          await expectDenied(policy, body, ownerRow(scope), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
          // … and a restricted employee never holds the full-scope admin.* keys at all.
          const employee = await call(policy, body, memberRow(everything, scope));
          expect(employee.status).toBe(403);
          expect([ACCESS_ERROR.PERMISSION_DENIED, ACCESS_ERROR.OWNER_REQUIRED, ACCESS_ERROR.SCOPE_NOT_SUPPORTED]).toContain(employee.body.error_code);
          expect(employee.handler).not.toHaveBeenCalled();
        }
      }
    }
  });
});

describe("error bodies", () => {
  const failing = (error: unknown) => async () => {
    throw error;
  };

  it("the data owner keeps today's 502 { error } text; an employee gets the generic body", async () => {
    const cases: Array<{ policy: FunctionPolicy<string>; body: Record<string, unknown>; onError: ServeWithAccessOptions["onError"]; fallback: string }> = [
      { policy: CLICKHOUSE_INIT_POLICY as FunctionPolicy<string>, body: {}, onError: clickHouseInitErrorResponse, fallback: "Could not initialize ClickHouse schema." },
      { policy: CLICKHOUSE_BACKFILL_POLICY as FunctionPolicy<string>, body: { mode: "continue" }, onError: clickHouseBackfillErrorResponse, fallback: "ClickHouse transaction backfill failed." },
      { policy: CLICKHOUSE_VALIDATE_POLICY as FunctionPolicy<string>, body: { action: "start" }, onError: clickHouseValidateErrorResponse, fallback: "ClickHouse transaction validation failed." },
    ];
    for (const { policy, body, onError, fallback } of cases) {
      const owner = await call(policy, body, ownerRow(), { handler: failing(new Error("ClickHouse HTTP 500: Code: 60. DB::Exception at host-x")), serve: { onError } });
      expect(owner.status).toBe(502);
      expect(owner.body).toEqual({ error: "ClickHouse HTTP 500: Code: 60. DB::Exception at host-x", request_id: "req-test-1" });

      const nonError = await call(policy, body, ownerRow(), { handler: failing("boom"), serve: { onError } });
      expect(nonError.body.error).toBe(fallback);

      if (policy.fn === "clickhouse-init") continue; // no employee reaches init
      const admin = await call(policy, body, memberRow(["admin.warehouse.manage"]), { handler: failing(new Error("DB::Exception at host-x")), serve: { onError } });
      expect(admin.status).toBe(502);
      expect(admin.body).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-test-1" });
    }
  });

  it("a ScopeViolation is a 500 whatever the error mapping says", async () => {
    const result = await call(CLICKHOUSE_BACKFILL_POLICY, { mode: "continue" }, ownerRow(), {
      handler: failing(new ScopeViolation("tenant_param_mismatch")),
      serve: { onError: clickHouseBackfillErrorResponse },
    });
    expect(result.status).toBe(500);
    expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
  });
});

describe("clickhouse-health: strip, don't deny", () => {
  it("only the data owner sees the probe detail", () => {
    expect(healthDetailVisible(contextFor(ownerRow()))).toBe(true);
    expect(healthDetailVisible(contextFor(accessRow({ userId: EMPLOYEE, isOwner: true })))).toBe(false);
    expect(healthDetailVisible(contextFor(memberRow(["admin.diagnostics.view", "admin.integrations.view"])))).toBe(false);
  });

  it("drops the database name and keeps the connectivity flags", () => {
    expect(projectHealthForViewer({ connected: true, configured: true, database: "analytics_prod", result: 1, latency_ms: 12 }))
      .toEqual({ connected: true, configured: true, result: 1, latency_ms: 12 });
  });

  it("replaces ClickHouse error text (which can echo the user name or host) with a generic message", () => {
    const failed = {
      connected: false,
      configured: true,
      database: "analytics_prod",
      latency_ms: 30,
      error: "ClickHouse HTTP 516: Code: 516. DB::Exception: svc_user: Authentication failed (abc.clickhouse.cloud)",
    };
    const projected = projectHealthForViewer(failed);
    expect(projected).toEqual({ connected: false, configured: true, latency_ms: 30, error: CLICKHOUSE_HEALTH_FAILED_MESSAGE });
    expect(JSON.stringify(projected)).not.toMatch(/svc_user|clickhouse\.cloud|analytics_prod|516/);
  });

  it("keeps the static not-configured answer (it names the secrets, never their values)", () => {
    const notConfigured = { connected: false, configured: false, host_configured: true, password_configured: false, error: CLICKHOUSE_NOT_CONFIGURED_MESSAGE };
    expect(projectHealthForViewer(notConfigured)).toEqual(notConfigured);
  });

  it("is an allowlist: an unknown probe field never reaches an employee", () => {
    expect(projectHealthForViewer({ connected: true, host: "https://abc.clickhouse.cloud", username: "svc_user" })).toEqual({ connected: true });
  });
});

// ---- runners through a ScopedReader -------------------------------------------------

interface Recorded {
  query: string;
  params: Record<string, unknown>;
}

function initWarehouse() {
  const queries: Recorded[] = [];
  const commands: string[] = [];
  const raw: ClickHouseClientLike = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params ?? {} });
      const sql = input.query;
      let rows: unknown[] = [];
      if (sql.includes("currentDatabase()") && !sql.includes("system.tables")) rows = [{ database: "analytics_prod" }];
      else if (sql.includes("max(row_version)")) rows = [{ max_version: 1_000 }];
      else if (sql.includes("SELECT sorting_key FROM system.tables")) rows = [{ sorting_key: "auth_user_id, request_date, request_id" }];
      else if (sql.includes("FROM system.tables")) rows = [{ engine: "ReplacingMergeTree", partition_key: "toYYYYMM(event_time)", sorting_key: "auth_user_id, cohort_date" }];
      else if (sql.includes("FROM system.columns")) rows = [{ columns_count: 58 }];
      else if (sql.includes("FROM analytics_transactions FINAL")) rows = [{ count: 42 }];
      else if (sql.includes("FROM fact_user_cohorts FINAL")) rows = [{ count: 7 }];
      return { json: async () => rows };
    }),
    command: vi.fn(async (input: { query: string }) => {
      commands.push(input.query);
    }),
    insert: vi.fn(async () => undefined),
  };
  return { raw, queries, commands };
}

describe("clickhouse-init: tenant row counts (Phase 0)", () => {
  it("counts only the workspace tenant's rows, bound through the ScopedReader", async () => {
    const ctx = contextFor(ownerRow());
    const { raw, queries, commands } = initWarehouse();
    const result = await initializeClickHouseSchema({ client: createScopedReader(ctx, raw), authUserId: ctx.tenantKey });

    expect(result).toMatchObject({
      connected: true,
      database: "analytics_prod",
      table_created_or_exists: true,
      columns_count: 58,
      engine: "ReplacingMergeTree",
      current_row_count: 42,
      fact_user_cohorts_row_count: 7,
    });
    const counts = queries.filter((entry) => entry.query.startsWith("SELECT count() AS count FROM"));
    expect(counts.map((entry) => entry.query)).toEqual([INIT_TENANT_ROW_COUNT_SQL, INIT_TENANT_COHORT_ROW_COUNT_SQL]);
    for (const entry of counts) {
      expect(entry.query).toContain("WHERE auth_user_id = {auth_user_id:String}");
      expect(entry.params).toEqual({ auth_user_id: DATA_KEY });
    }
    // The database comes from the warehouse, and the metadata lookups use it.
    expect(queries.some((entry) => entry.query.includes("database = 'analytics_prod'"))).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
    expect(ctx.violations).toEqual([]);
  });

  it("an explicit env still names the database (no currentDatabase() round-trip)", async () => {
    const ctx = contextFor(ownerRow());
    const { raw, queries } = initWarehouse();
    const result = await initializeClickHouseSchema({ client: createScopedReader(ctx, raw), authUserId: ctx.tenantKey, env: { database: "" } });
    expect(result.database).toBe("default");
    expect(queries.some((entry) => entry.query === "SELECT currentDatabase() AS database")).toBe(false);
  });

  it("binding the caller's own id instead of the tenant is a scope violation", async () => {
    const ctx = contextFor(ownerRow());
    const { raw } = initWarehouse();
    await expect(initializeClickHouseSchema({ client: createScopedReader(ctx, raw), authUserId: EMPLOYEE })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
    await expect(initializeClickHouseSchema({ client: createScopedReader(ctx, raw), authUserId: "" })).rejects.toThrow(/requires the workspace tenant/);
  });
});

// ---- backfill run lease ---------------------------------------------------------------

function sourceRows(count: number): SupabaseTransactionRow[] {
  return Array.from({ length: count }, (_, index) => {
    const seq = String(index).padStart(4, "0");
    const event = new Date(Date.UTC(2026, 3, 1) + index * 1000).toISOString();
    return {
      auth_user_id: DATA_KEY,
      user_id: `u_${seq}`,
      transaction_id: `tx_${seq}`,
      import_batch_id: "batch",
      source: "test",
      event_time: event,
      status: "success",
      transaction_type: "trial",
      amount_gross: 10,
      amount_net: 10,
      amount_refunded: 0,
      currency: "USD",
      email: `x${seq}@example.com`,
      country_code: null,
      campaign_path: "path",
      funnel: "soulmate",
      source_name: "facebook",
      raw_payload: {},
      normalized_payload: {
        transaction_id: `tx_${seq}`,
        user_id: `u_${seq}`,
        event_time: event,
        gross_amount_usd: 10,
        net_amount_usd: 10,
        refund_amount_usd: 0,
        amount_usd: 10,
        currency: "USD",
        status: "success",
        transaction_type: "trial",
        funnel: "soulmate",
        campaign_path: "path",
        campaign_id: "cmp",
      },
      created_at: event,
      updated_at: new Date(Date.UTC(2026, 4, 1) + index * 1000).toISOString(),
      deleted_at: null,
    };
  });
}

/** clickhouse_transaction_sync_state + transactions with PostgREST semantics the
 * lease relies on: upsert(ignoreDuplicates) = INSERT … ON CONFLICT DO NOTHING,
 * and update().or().select() = a conditional UPDATE returning matched rows.
 * updated_at is stamped on every write (the table's trigger). */
function backfillSupabase(options: { row?: Record<string, unknown> | null; rows?: SupabaseTransactionRow[]; failClaim?: boolean } = {}) {
  const store = {
    row: options.row ? { ...options.row } : (null as Record<string, unknown> | null),
    upserts: [] as Array<{ values: Record<string, unknown>; options?: Record<string, unknown> }>,
    claimFilters: [] as string[],
    transactionReads: 0,
    transactionUpdates: 0,
  };
  const rows = options.rows ?? [];
  const stamp = () => new Date().toISOString();
  const resolved = <T>(value: T) => ({
    then: <R1 = T, R2 = never>(ok?: ((v: T) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) => Promise.resolve(value).then(ok, bad),
  });

  const claimable = (row: Record<string, unknown>, filter: string): boolean => {
    const stages = (/current_stage\.not\.in\.\(([^)]*)\)/.exec(filter)?.[1] ?? "").split(",");
    const staleBefore = /updated_at\.lt\.(.+)$/.exec(filter)?.[1] ?? "";
    const stage = row.current_stage as string | null | undefined;
    return stage == null || !stages.includes(stage) || String(row.updated_at) < staleBefore;
  };

  function syncStateBuilder(): SupabaseQueryBuilder {
    let updateValues: Record<string, unknown> | null = null;
    let orFilter = "";
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      in: () => builder,
      limit: () => builder,
      lte: () => builder,
      or: (filter: string) => {
        orFilter = filter;
        return builder;
      },
      maybeSingle: async () => ({ data: store.row ? { ...store.row } : null, error: null }),
      upsert: async (values: Record<string, unknown>, upsertOptions?: Record<string, unknown>) => {
        store.upserts.push({ values, options: upsertOptions });
        if (upsertOptions?.ignoreDuplicates) {
          if (!store.row) store.row = { status: "never_started", current_stage: null, ...values, updated_at: stamp() };
        } else {
          store.row = { status: "never_started", current_stage: null, ...(store.row ?? {}), ...values, updated_at: stamp() };
        }
        return { data: null, error: null };
      },
      update: (values: Record<string, unknown>) => {
        updateValues = values;
        return builder;
      },
      then: <R1 = SupabaseQueryResult, R2 = never>(ok?: ((v: SupabaseQueryResult) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) => {
        let result: SupabaseQueryResult = { data: null, error: null };
        if (updateValues) {
          store.claimFilters.push(orFilter);
          if (options.failClaim) result = { data: null, error: { message: "permission denied" } };
          else if (store.row && claimable(store.row, orFilter)) {
            store.row = { ...store.row, ...updateValues, updated_at: stamp() };
            result = { data: [{ sync_name: store.row.sync_name }], error: null };
          } else result = { data: [], error: null };
        }
        return resolved(result).then(ok, bad);
      },
    };
    return builder as unknown as SupabaseQueryBuilder;
  }

  function transactionsBuilder(): SupabaseQueryBuilder {
    const state = { count: false, context: false, cursor: false, update: false };
    const builder = {
      select: (_columns?: string, selectOptions?: Record<string, unknown>) => {
        if (selectOptions?.head) state.count = true;
        return builder;
      },
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      limit: () => builder,
      lte: () => builder,
      in: () => {
        state.context = true;
        return builder;
      },
      or: () => {
        state.cursor = true;
        return builder;
      },
      update: () => {
        state.update = true;
        return builder;
      },
      maybeSingle: async () => ({ data: null, error: null }),
      upsert: async () => ({ data: null, error: null }),
      then: <R1 = SupabaseQueryResult, R2 = never>(ok?: ((v: SupabaseQueryResult) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) => {
        if (state.update) store.transactionUpdates += 1;
        else store.transactionReads += 1;
        const result: SupabaseQueryResult = state.count
          ? { data: null, count: rows.length, error: null }
          : { data: state.update || state.cursor ? [] : rows, error: null };
        return resolved(result).then(ok, bad);
      },
    };
    return builder as unknown as SupabaseQueryBuilder;
  }

  const supabase: SupabaseLikeClient = {
    from: (table: string) => (table === "transactions" ? transactionsBuilder() : syncStateBuilder()),
  };
  return { supabase, store };
}

function backfillWarehouse(options: { failInsert?: boolean } = {}) {
  const queries: Recorded[] = [];
  const commands: Recorded[] = [];
  const inserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
  const raw: ClickHouseClientLike = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params ?? {} });
      const rows = input.query.startsWith("SELECT count() AS count") ? [{ count: inserts.reduce((total, batch) => total + batch.values.length, 0) }] : [];
      return { json: async () => rows };
    }),
    command: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push({ query: input.query, params: input.query_params ?? {} });
    }),
    insert: vi.fn(async (input: { table: string; values: Record<string, unknown>[] }) => {
      if (options.failInsert) throw new Error("ClickHouse HTTP 500: insert failed");
      inserts.push({ table: input.table, values: input.values });
    }),
  };
  return { raw, queries, commands, inserts };
}

const CONTINUE: BackfillParams = { mode: "continue", batch_size: 2000, max_batches: 10, dry_run: false, full_reset_cursor: false };

describe("clickhouse-backfill: compare-and-set run lease", () => {
  it("the claim filter frees a row with no run stage or a stale heartbeat, and outlives the Edge wall clock", () => {
    expect([...BACKFILL_RUN_STAGES]).toEqual(["backfilling", "dry_run", "validate_only"]);
    expect(backfillLeaseClaimFilter("2026-10-05T00:00:00.000Z"))
      .toBe("current_stage.is.null,current_stage.not.in.(backfilling,dry_run,validate_only),updated_at.lt.2026-10-05T00:00:00.000Z");
    expect(BACKFILL_LEASE_STALE_MS).toBeGreaterThan(400_000);
  });

  it("a first run seeds the row, claims it, writes under the tenant and releases the lease", async () => {
    const ctx = contextFor(memberRow(["admin.warehouse.manage"]));
    const { supabase, store } = backfillSupabase({ rows: sourceRows(3) });
    const warehouse = backfillWarehouse();
    const result = await runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, warehouse.raw), params: CONTINUE });

    expect(store.upserts[0]).toEqual({
      values: { auth_user_id: DATA_KEY, sync_name: "analytics_transactions_backfill" },
      options: { onConflict: "auth_user_id,sync_name", ignoreDuplicates: true },
    });
    expect(store.claimFilters).toHaveLength(1);
    expect(store.claimFilters[0]).toMatch(/^current_stage\.is\.null,current_stage\.not\.in\.\(backfilling,dry_run,validate_only\),updated_at\.lt\./);
    expect(result).toMatchObject({ status: "completed", stopped_reason: "completed", rows_inserted: 3, batches_processed: 1 });
    // Every warehouse write is bound to the workspace tenant, never the caller.
    expect(warehouse.inserts.flatMap((batch) => batch.values).every((row) => row.auth_user_id === DATA_KEY)).toBe(true);
    expect(warehouse.commands.every((entry) => entry.params.auth_user_id === DATA_KEY)).toBe(true);
    expect(ctx.violations).toEqual([]);
    // Released: the final write leaves the row idle, so the next run claims it.
    expect(store.row).toMatchObject({ status: "completed", current_stage: "idle", auth_user_id: DATA_KEY });
    const again = await runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE });
    expect(again.stopped_reason).not.toBe("already_running");
  });

  it("a live run's lease turns a second run away before it reads, re-queues or writes anything", async () => {
    const ctx = contextFor(ownerRow());
    const live = {
      auth_user_id: DATA_KEY,
      sync_name: "analytics_transactions_backfill",
      status: "partial",
      current_stage: "backfilling",
      cursor_updated_at: "2026-05-01T00:00:00.000Z",
      cursor_transaction_id: "tx_0001",
      source_total: 66_370,
      clickhouse_total: 60_000,
      updated_at: new Date(Date.now() - 30_000).toISOString(),
    };
    for (const params of [CONTINUE, { mode: "dedup" } as BackfillParams, { mode: "full_backfill", full_reset_cursor: true } as BackfillParams]) {
      const { supabase, store } = backfillSupabase({ row: live, rows: sourceRows(3) });
      const warehouse = backfillWarehouse();
      const result = await runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, warehouse.raw), params });

      expect(result).toMatchObject({
        status: "running",
        stopped_reason: "already_running",
        current_stage: "already_running",
        rows_scanned: 0,
        rows_inserted: 0,
        batches_processed: 0,
        duplicates_requeued: 0,
        cursor_transaction_id: "tx_0001",
        source_total: 66_370,
        clickhouse_total: 60_000,
        // When the held lease turns stale: the UI tells the operator when a
        // retry can succeed if the holder was killed.
        lease_retry_after: new Date(Date.parse(live.updated_at) + BACKFILL_LEASE_STALE_MS).toISOString(),
      });
      expect(warehouse.raw.query).not.toHaveBeenCalled();
      expect(warehouse.raw.command).not.toHaveBeenCalled();
      expect(warehouse.raw.insert).not.toHaveBeenCalled();
      expect(store.transactionReads).toBe(0);
      expect(store.transactionUpdates).toBe(0);
      // Only the ON CONFLICT DO NOTHING seed was sent; the holder's row is untouched.
      expect(store.upserts).toHaveLength(1);
      expect(store.row).toEqual(live);
    }
  });

  it("already_running carries the lease's retry time, and the Integrations toast says so instead of 'inserted 0 rows'", () => {
    expect(backfillLeaseRetryAfter("2026-10-06T10:00:00.000Z")).toBe(new Date(Date.parse("2026-10-06T10:00:00.000Z") + BACKFILL_LEASE_STALE_MS).toISOString());
    expect(backfillLeaseRetryAfter(null)).toBeNull();
    expect(backfillLeaseRetryAfter("not a date")).toBeNull();

    const base = {
      mode: "continue", dry_run: false, status: "running", current_stage: "already_running", batch_size: 2000, max_batches: 10,
      rows_scanned: 0, rows_mapped: 0, rows_inserted: 0, rows_skipped: 0, batches_processed: 0,
      cursor_updated_at: null, cursor_transaction_id: null, source_total: 0, clickhouse_total: 0, duration_ms: 1,
    };
    const held = describeClickHouseBackfillResult({ ...base, stopped_reason: "already_running", lease_retry_after: "2026-10-06T10:10:00.000Z" });
    expect(held).toMatch(/^Another backfill run holds the lease \(still running, or interrupted\)\. Retry after .+ if it was interrupted\.$/);
    expect(held).not.toContain("inserted");
    expect(describeClickHouseBackfillResult({ ...base, stopped_reason: "already_running", lease_retry_after: null })).toContain("Retry in a few minutes");
    // Every other outcome keeps today's text.
    expect(describeClickHouseBackfillResult({ ...base, status: "completed", stopped_reason: "completed", rows_inserted: 1234 }))
      .toBe("completed: inserted 1,234 rows, stopped: completed.");
    expect(readFileSync(resolve(process.cwd(), "src/pages/Integrations.tsx"), "utf8")).toContain("(backfill) => describeClickHouseBackfillResult(backfill)");
  });

  it("a stale lease (a run killed mid-flight) is taken over", async () => {
    const ctx = contextFor(ownerRow());
    const { supabase, store } = backfillSupabase({
      row: {
        auth_user_id: DATA_KEY,
        sync_name: "analytics_transactions_backfill",
        status: "running",
        current_stage: "backfilling",
        updated_at: new Date(Date.now() - BACKFILL_LEASE_STALE_MS - 60_000).toISOString(),
      },
      rows: sourceRows(2),
    });
    const result = await runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE });
    expect(result).toMatchObject({ status: "completed", rows_inserted: 2 });
    expect(store.row?.current_stage).toBe("idle");
  });

  it("of two concurrent runs exactly one proceeds", async () => {
    const ctx = contextFor(ownerRow());
    const { supabase } = backfillSupabase({ rows: sourceRows(2) });
    const results = await Promise.all([
      runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE }),
      runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE }),
    ]);
    expect(results.map((result) => result.stopped_reason).sort()).toEqual(["already_running", "completed"]);
  });

  it("a failed run records the failure, which releases the lease", async () => {
    const ctx = contextFor(ownerRow());
    const { supabase, store } = backfillSupabase({ rows: sourceRows(2) });
    await expect(
      runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse({ failInsert: true }).raw), params: CONTINUE }),
    ).rejects.toThrow(/insert failed/);
    expect(store.row).toMatchObject({ status: "failed", current_stage: "failed", stopped_reason: "clickhouse_error" });
    const next = await runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE });
    expect(next.status).toBe("completed");
  });

  it("a claim that cannot be made fails the request without writing a 'failed' state over the row", async () => {
    const ctx = contextFor(ownerRow());
    const { supabase, store } = backfillSupabase({ failClaim: true, rows: sourceRows(1) });
    await expect(
      runTransactionsBackfill({ authUserId: ctx.tenantKey, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE }),
    ).rejects.toThrow(/Could not claim the ClickHouse backfill run/);
    expect(store.upserts).toHaveLength(1); // the seed only
    expect(store.transactionReads).toBe(0);
  });

  it("a runner still binding the caller's id fails loudly and records the failure", async () => {
    const ctx = contextFor(memberRow(["admin.warehouse.manage"]));
    const { supabase, store } = backfillSupabase({ rows: sourceRows(1) });
    await expect(
      runTransactionsBackfill({ authUserId: EMPLOYEE, supabase, clickhouse: createScopedReader(ctx, backfillWarehouse().raw), params: CONTINUE }),
    ).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
    expect(store.row?.current_stage).toBe("failed");
  });
});

// ---- validation pipeline -----------------------------------------------------------------

function validationSupabase(state: Record<string, unknown>): SupabaseLikeClient {
  let current: Record<string, unknown> | null = { ...state };
  const builder = {
    select: () => builder,
    eq: () => builder,
    is: () => builder,
    order: () => builder,
    in: () => builder,
    limit: () => builder,
    or: () => builder,
    lte: () => builder,
    maybeSingle: async () => ({ data: current ? { ...current } : null, error: null }),
    upsert: async (values: Record<string, unknown>) => {
      current = { ...values };
      return { data: null, error: null };
    },
    then: <R1 = SupabaseQueryResult, R2 = never>(ok?: ((v: SupabaseQueryResult) => R1 | PromiseLike<R1>) | null, bad?: ((e: unknown) => R2 | PromiseLike<R2>) | null) =>
      Promise.resolve({ data: null, count: 0, error: null } as SupabaseQueryResult).then(ok, bad),
  };
  return { from: () => builder as unknown as SupabaseQueryBuilder };
}

describe("clickhouse-validate: the resumable catch no longer swallows a ScopeViolation", () => {
  const existing = {
    auth_user_id: DATA_KEY,
    validation_name: "analytics_transactions_validation",
    status: "partial",
    stage: "source_scan",
    validation_scope: "full_dataset",
    rows_processed: 10,
    pages_processed: 1,
    source_aggregates: {},
    version: 1,
  };

  it("an ordinary warehouse error still pauses the run with a resumable answer", async () => {
    const ctx = contextFor(ownerRow());
    const raw = fakeRaw();
    raw.query = vi.fn(async () => {
      throw new Error("ClickHouse HTTP 500: boom");
    });
    const response = await runValidation({ action: "start", authUserId: ctx.tenantKey, supabase: validationSupabase(existing), clickhouse: createScopedReader(ctx, raw), validationScope: "full_dataset" });
    expect(response).toMatchObject({ status: "partial", stopped_reason: "clickhouse_error" });
  });

  it("a ScopeViolation fails the request instead", async () => {
    const ctx = contextFor(ownerRow());
    await expect(
      runValidation({ action: "start", authUserId: EMPLOYEE, supabase: validationSupabase(existing), clickhouse: createScopedReader(ctx, fakeRaw()), validationScope: "full_dataset" }),
    ).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
  });
});

// ---- entrypoints ------------------------------------------------------------------------

describe("index.ts entrypoints are on the gate", () => {
  const ENTRYPOINTS: Record<string, string> = {
    "clickhouse-init": "CLICKHOUSE_INIT_POLICY",
    "clickhouse-backfill": "CLICKHOUSE_BACKFILL_POLICY",
    "clickhouse-validate": "CLICKHOUSE_VALIDATE_POLICY",
    "clickhouse-health": "CLICKHOUSE_HEALTH_POLICY",
  };
  const source = (fn: string) => readFileSync(resolve(process.cwd(), `supabase/functions/${fn}/index.ts`), "utf8");

  it.each(Object.entries(ENTRYPOINTS))("%s serves through serveWithAccess(%s)", (fn, policyName) => {
    const text = source(fn);
    expect(text).toMatch(new RegExp(`serveWithAccess\\(\\s*${policyName},`));
    expect(text).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    for (const banned of ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "Deno.serve(", "auth.id", "parseJsonBody", "jsonResponse"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("the runners get the workspace tenant", () => {
    for (const fn of ["clickhouse-init", "clickhouse-backfill", "clickhouse-validate"]) {
      expect(source(fn)).toContain("authUserId: ctx.tenantKey");
      expect(source(fn)).not.toContain("clickhouse/client.ts");
    }
  });

  it("only the health probe reads ClickHouse config, and only the secret-free probes", () => {
    const text = source("clickhouse-health");
    const imports = text.match(/import \{([^}]*)\} from "\.\.\/_shared\/clickhouse\/client\.ts";/);
    expect(imports?.[1].split(",").map((name) => name.trim()).filter(Boolean).sort()).toEqual(["clickHouseEnv", "isClickHouseConfigured"]);
    expect(text).not.toContain("CLICKHOUSE_PASSWORD");
    // host / username are never response fields (host_configured is a boolean).
    expect(text).not.toMatch(/\b(host|username)\s*:/);
  });
});
