// Access migration of the Users / Payments / Revenue / server-summary Edge
// functions (plan §7, §10, §13, §27 — Milestone A). The five policies are
// driven through the pure gate core (handleWithAccess) with fake dependencies,
// and the runners they dispatch to are driven through a real ScopedReader, so
// these tests prove: who may call which action, that every funnel-restricted
// context is refused (except the revenue reads, scopeReady behind the cohort
// snapshot freshness gate since Phase 2 — revenueScoped.test.ts covers their
// scoped SQL), that the payments router no longer falls back to the
// bundle, that the AI pass-rate call is reduced for non-Payment-Pass members,
// that runners bind the workspace tenant (scratch tables included), and that
// best-effort catches no longer swallow a ScopeViolation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertValidPolicy,
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
} from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow, type AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  CLICKHOUSE_USERS_POLICY,
  normalizeClickHouseUsersAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-users.ts";
import {
  CLICKHOUSE_PAYMENT_ANALYTICS_POLICY,
  PAYMENT_ANALYTICS_AI_PURPOSE,
  normalizeClickHousePaymentAnalyticsAction,
  paymentPassFullBundleAllowed,
} from "../../supabase/functions/_shared/access/policies/clickhouse-payment-analytics.ts";
import {
  CLICKHOUSE_REVENUE_POLICY,
  normalizeClickHouseRevenueAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-revenue.ts";
import {
  DASHBOARD_SUMMARY_POLICY,
  normalizeDashboardSummaryAction,
} from "../../supabase/functions/_shared/access/policies/dashboard-summary.ts";
import {
  FB_ANALYTICS_SUMMARY_POLICY,
  normalizeFbAnalyticsSummaryAction,
} from "../../supabase/functions/_shared/access/policies/fb-analytics-summary.ts";
import {
  PaymentAnalyticsRequestError,
  aiPassRatesRequest,
  runAiPassRates,
  runPaymentAnalytics,
  type PaymentAnalyticsRequest,
} from "../../supabase/functions/_shared/clickhouse/paymentAnalytics.ts";
import { runUsersList } from "../../supabase/functions/_shared/clickhouse/users.ts";
import { FACT_SUBSCRIPTIONS_TABLE } from "../../supabase/functions/_shared/clickhouse/factSubscriptions.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { COHORT_CLASSIFICATION_VERSION, type CohortSnapshotState } from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";

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

const ownerRow = (scope: Scope = "all") => accessRow({ userId: DATA_KEY, isOwner: true, scope });
const memberRow = (permissions: string[], scope: Scope = "all") => accessRow({ permissions, scope });

function fakeRaw() {
  return {
    query: vi.fn(async () => ({ json: async () => [] as unknown })),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

/** A fresh, validated cohort snapshot (the Phase 2 freshness gate admits it). */
const READY_SNAPSHOT_STATE = {
  auth_user_id: DATA_KEY,
  snapshot_name: "fact_user_cohorts",
  status: "completed",
  active_warehouse_version: "wh_live",
  active_classification_version: COHORT_CLASSIFICATION_VERSION,
  active_generated_at: "2026-10-06T09:00:00.000Z",
  building_warehouse_version: null,
  building_classification_version: null,
  started_at: null,
  finished_at: "2026-10-06T09:00:00.000Z",
  duration_ms: 1,
  users_classified: 5,
  rows_inserted: 5,
  duplicate_users: 0,
  removed_or_invalidated: 0,
  source_transactions: 50,
  source_unique_users: 5,
  last_error: null,
  diagnostics: { validation: { status: "PASS" } },
  active_validation: { status: "PASS" },
  active_campaign_scope_version: null,
  fresh_verified_at: "2026-10-06T11:52:00.000Z",
  stale_since: null,
} satisfies CohortSnapshotState;
const GATE_NOW = new Date("2026-10-06T12:00:00.000Z");

function makeDeps(row: ReturnType<typeof accessRow>, snapshotState: CohortSnapshotState | null = READY_SNAPSHOT_STATE): AccessGateDeps {
  const raw = fakeRaw();
  return {
    loadCohortSnapshotState: vi.fn(async () => snapshotState),
    now: () => GATE_NOW,
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

async function call<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: ReturnType<typeof accessRow>, snapshotState?: CohortSnapshotState | null) {
  const handler = vi.fn(async ({ action, ctx }: Parameters<AccessHandler<A>>[0]) => ({ ok: true, action, tenant: ctx.tenantKey }));
  const req = new Request("https://edge.test/functions/v1/fn", {
    method: "POST",
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleWithAccess(req, policy, handler as unknown as AccessHandler<A>, makeDeps(row, snapshotState));
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, handler };
}

async function expectAllowed<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: ReturnType<typeof accessRow>, action: A) {
  const result = await call(policy, body, row);
  expect(result.status).toBe(200);
  // The handler always sees the workspace data key as tenant, never the caller.
  expect(result.body).toEqual({ ok: true, action, tenant: DATA_KEY });
}

async function expectDenied<A extends string>(policy: FunctionPolicy<A>, body: unknown, row: ReturnType<typeof accessRow>, status: number, code: string) {
  const result = await call(policy, body, row);
  expect(result.status).toBe(status);
  expect(result.body.error_code).toBe(code);
  expect(result.handler).not.toHaveBeenCalled();
}

// Every policy, every action, with a body that normalizes to it.
const MATRIX: Array<{ policy: FunctionPolicy<string>; bodies: Record<string, unknown> }> = [
  {
    policy: CLICKHOUSE_USERS_POLICY as FunctionPolicy<string>,
    bodies: { list: { action: "list" }, summary: { action: "summary" }, options: { action: "options" }, decline: { action: "decline" }, details: { action: "details", user_id: "u1" } },
  },
  {
    policy: CLICKHOUSE_PAYMENT_ANALYTICS_POLICY as FunctionPolicy<string>,
    bodies: {
      bundle: { action: "analytics" },
      banks: { action: "banks" },
      bank_detail: { action: "bank_detail", issuer_key: "sutton_bank" },
      ai_pass_rates: { action: "analytics", purpose: "ai_pass_rates", group_by: "campaign_path" },
    },
  },
  {
    policy: CLICKHOUSE_REVENUE_POLICY as FunctionPolicy<string>,
    bodies: { bundle: { action: "bundle" }, day_breakdown: { action: "day_breakdown", date: "2026-01-01" } },
  },
  { policy: DASHBOARD_SUMMARY_POLICY as FunctionPolicy<string>, bodies: { summary: { filters: {} } } },
  { policy: FB_ANALYTICS_SUMMARY_POLICY as FunctionPolicy<string>, bodies: { summary: { filters: {} } } },
];

describe("policy tables", () => {
  it("are valid, named after their function, and cover every action with a body", () => {
    for (const { policy, bodies } of MATRIX) {
      expect(() => assertValidPolicy(policy)).not.toThrow();
      expect(Object.keys(bodies).sort()).toEqual(Object.keys(policy.actions).sort());
      expect(policy.methods ?? ["POST"]).toEqual(["POST"]);
      expect(policy.cron).toBeUndefined();
    }
    expect(MATRIX.map(({ policy }) => policy.fn)).toEqual([
      "clickhouse-users", "clickhouse-payment-analytics", "clickhouse-revenue", "dashboard-summary", "fb-analytics-summary",
    ]);
  });

  it("match the permission table exactly (Phase 2: only the revenue reads are scopeReady)", () => {
    expect(CLICKHOUSE_USERS_POLICY.actions).toEqual({
      list: { allOf: ["users.view", "users.pii.view"] },
      summary: { allOf: ["users.view", "users.pii.view"] },
      options: { allOf: ["users.view", "users.pii.view"] },
      decline: { allOf: ["users.view", "users.pii.view"] },
      details: { allOf: ["users.view", "users.pii.view", "users.details.view"] },
    });
    expect(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY.actions).toEqual({
      bundle: { anyOf: ["payment_pass.view"] },
      banks: { anyOf: ["payment_pass.banks.view"] },
      bank_detail: { anyOf: ["payment_pass.banks.view"] },
      ai_pass_rates: { allOf: ["ai.use"], anyOf: ["cohorts.view", "facebook_analytics.view"] },
    });
    expect(CLICKHOUSE_REVENUE_POLICY.actions).toEqual({
      bundle: { anyOf: ["dashboard.view"], scopeReady: true, scopeSnapshot: "cohort" },
      day_breakdown: { anyOf: ["dashboard.view"], scopeReady: true, scopeSnapshot: "cohort" },
    });
    expect(DASHBOARD_SUMMARY_POLICY.actions).toEqual({ summary: { rawOnly: true, anyOf: ["dashboard.view"] } });
    expect(FB_ANALYTICS_SUMMARY_POLICY.actions).toEqual({ summary: { rawOnly: true, anyOf: ["facebook_analytics.view"] } });
    for (const { policy } of MATRIX) {
      for (const entry of Object.values(policy.actions)) {
        if (policy.fn !== "clickhouse-revenue") expect(entry.scopeReady).toBeFalsy();
        // every key a policy names is a real, enforced permission
        for (const key of [...(entry.anyOf ?? []), ...(entry.allOf ?? [])]) expect(ENFORCED_PERMISSION_KEYS).toContain(key);
      }
    }
  });
});

describe("canonical action normalizers (rule R3: no silent defaults)", () => {
  it("clickhouse-users maps only the five named actions — a missing action is no longer 'list'", () => {
    for (const action of ["list", "summary", "options", "decline", "details"]) expect(normalizeClickHouseUsersAction({ action })).toBe(action);
    for (const body of [{}, { action: null }, { action: "delete_users" }, { action: ["list"] }]) {
      expect(() => normalizeClickHouseUsersAction(body)).toThrow(ActionNormalizeError);
    }
  });

  it("clickhouse-payment-analytics no longer answers unknown actions with the bundle", () => {
    expect(normalizeClickHousePaymentAnalyticsAction({ action: "analytics" })).toBe("bundle");
    expect(normalizeClickHousePaymentAnalyticsAction({ action: "bundle" })).toBe("bundle");
    expect(normalizeClickHousePaymentAnalyticsAction({ action: "banks" })).toBe("banks");
    expect(normalizeClickHousePaymentAnalyticsAction({ action: "bank_detail" })).toBe("bank_detail");
    for (const body of [{}, { action: "" }, { action: "export" }, { action: "BANKS" }]) {
      expect(() => normalizeClickHousePaymentAnalyticsAction(body)).toThrow(ActionNormalizeError);
    }
  });

  it("maps the AI pass-rate purpose to its own action, only on an analytics request", () => {
    expect(PAYMENT_ANALYTICS_AI_PURPOSE).toBe("ai_pass_rates");
    expect(normalizeClickHousePaymentAnalyticsAction({ action: "analytics", purpose: "ai_pass_rates" })).toBe("ai_pass_rates");
    expect(normalizeClickHousePaymentAnalyticsAction({ action: "bundle", purpose: "ai_pass_rates" })).toBe("ai_pass_rates");
    for (const body of [
      { action: "banks", purpose: "ai_pass_rates" },
      { action: "bank_detail", purpose: "ai_pass_rates" },
      { purpose: "ai_pass_rates" },
      { action: "analytics", purpose: "export" },
      { action: "analytics", purpose: "" },
    ]) {
      expect(() => normalizeClickHousePaymentAnalyticsAction(body)).toThrow(ActionNormalizeError);
    }
  });

  it("clickhouse-revenue maps bundle / day_breakdown only", () => {
    expect(normalizeClickHouseRevenueAction({ action: "bundle" })).toBe("bundle");
    expect(normalizeClickHouseRevenueAction({ action: "day_breakdown" })).toBe("day_breakdown");
    for (const body of [{}, { action: "rebuild" }]) expect(() => normalizeClickHouseRevenueAction(body)).toThrow(ActionNormalizeError);
  });

  it("the server summaries keep their one documented default (the browser posts only { filters })", () => {
    for (const normalize of [normalizeDashboardSummaryAction, normalizeFbAnalyticsSummaryAction]) {
      expect(normalize({ filters: {} })).toBe("summary");
      expect(normalize({ action: null })).toBe("summary");
      expect(normalize({ action: "summary" })).toBe("summary");
      expect(() => normalize({ action: "raw_rows" })).toThrow(ActionNormalizeError);
    }
  });
});

describe("gate decisions per function", () => {
  it("clickhouse-users: users.view + users.pii.view, details also users.details.view", async () => {
    const page = ["users.view", "users.pii.view"];
    for (const action of ["list", "summary", "options", "decline"] as const) {
      await expectDenied(CLICKHOUSE_USERS_POLICY, { action }, memberRow(["users.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
      await expectAllowed(CLICKHOUSE_USERS_POLICY, { action }, memberRow(page), action);
    }
    await expectDenied(CLICKHOUSE_USERS_POLICY, { action: "details", user_id: "u1" }, memberRow(page), 403, ACCESS_ERROR.PERMISSION_DENIED);
    await expectDenied(CLICKHOUSE_USERS_POLICY, { action: "details", user_id: "u1" }, memberRow(["users.view", "users.details.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    await expectAllowed(CLICKHOUSE_USERS_POLICY, { action: "details", user_id: "u1" }, memberRow([...page, "users.details.view"]), "details");
    await expectDenied(CLICKHOUSE_USERS_POLICY, {}, memberRow(page), 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("clickhouse-payment-analytics: bundle / banks / AI pass rates each need their own permission", async () => {
    await expectAllowed(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, { action: "analytics" }, memberRow(["payment_pass.view"]), "bundle");
    await expectDenied(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, { action: "analytics" }, memberRow(["cohorts.view", "ai.use"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    for (const body of [{ action: "banks" }, { action: "bank_detail", issuer_key: "x" }]) {
      await expectDenied(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, body, memberRow(["payment_pass.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
      await expectAllowed(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, body, memberRow(["payment_pass.view", "payment_pass.banks.view"]), body.action as "banks" | "bank_detail");
    }
    const ai = { action: "analytics", purpose: "ai_pass_rates", group_by: "campaign_path" };
    await expectAllowed(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, ai, memberRow(["cohorts.view", "ai.use"]), "ai_pass_rates");
    await expectAllowed(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, ai, memberRow(["facebook_analytics.view", "ai.use"]), "ai_pass_rates");
    await expectDenied(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, ai, memberRow(["cohorts.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    await expectDenied(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, ai, memberRow(["ai.use"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    await expectDenied(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, ai, memberRow(["payment_pass.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
  });

  it("clickhouse-payment-analytics: an unknown or missing action is 400, not the bundle", async () => {
    const all = memberRow(["payment_pass.view", "payment_pass.banks.view", "cohorts.view", "ai.use"]);
    for (const body of [{}, { action: "export" }, { filters: { funnel: ["soulmate"] } }]) {
      await expectDenied(CLICKHOUSE_PAYMENT_ANALYTICS_POLICY, body, all, 400, ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });

  it("clickhouse-revenue: dashboard.view", async () => {
    for (const body of [{ action: "bundle" }, { action: "day_breakdown", date: "2026-01-01" }]) {
      await expectAllowed(CLICKHOUSE_REVENUE_POLICY, body, memberRow(["dashboard.view"]), body.action as "bundle" | "day_breakdown");
      await expectDenied(CLICKHOUSE_REVENUE_POLICY, body, memberRow(["cohorts.view", "reports.view"]), 403, ACCESS_ERROR.PERMISSION_DENIED);
    }
    await expectDenied(CLICKHOUSE_REVENUE_POLICY, {}, memberRow(["dashboard.view"]), 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("dashboard-summary / fb-analytics-summary: data owner only, whatever the employee's role", async () => {
    const employee = memberRow([...ENFORCED_PERMISSION_KEYS]);
    await expectDenied(DASHBOARD_SUMMARY_POLICY, { filters: {} }, employee, 403, ACCESS_ERROR.RAW_ACCESS_REQUIRED);
    await expectDenied(FB_ANALYTICS_SUMMARY_POLICY, { filters: {} }, employee, 403, ACCESS_ERROR.RAW_ACCESS_REQUIRED);
    await expectAllowed(DASHBOARD_SUMMARY_POLICY, { filters: {} }, ownerRow(), "summary");
    await expectAllowed(FB_ANALYTICS_SUMMARY_POLICY, { filters: {} }, ownerRow(), "summary");
    await expectDenied(DASHBOARD_SUMMARY_POLICY, { action: "rows" }, ownerRow(), 400, ACCESS_ERROR.UNKNOWN_ACTION);
  });

  it("the data owner reaches every action with the same tenant", async () => {
    for (const { policy, bodies } of MATRIX) {
      for (const [action, body] of Object.entries(bodies)) await expectAllowed(policy, body, ownerRow(), action);
    }
  });

  it("Phase 2: restricted contexts reach the revenue reads behind the freshness gate (409 / 503 otherwise)", async () => {
    for (const scope of ["selected", "none"] as const) {
      for (const [action, body] of Object.entries(MATRIX[2].bodies)) {
        const restricted = memberRow(["dashboard.view"], scope);
        await expectAllowed(CLICKHOUSE_REVENUE_POLICY, body, restricted, action as "bundle" | "day_breakdown");
        const notReady = await call(CLICKHOUSE_REVENUE_POLICY, body, restricted, null);
        expect(notReady.status).toBe(409);
        expect(notReady.body.error_code).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
        expect(notReady.handler).not.toHaveBeenCalled();
        const stale = await call(CLICKHOUSE_REVENUE_POLICY, body, restricted, { ...READY_SNAPSHOT_STATE, fresh_verified_at: "2026-10-05T00:00:00.000Z" });
        expect(stale.status).toBe(409);
      }
    }
  });

  it("Milestone A: every funnel-restricted context gets 403 scope_not_supported on every other action", async () => {
    const employeeAll = (scope: Scope) => memberRow([...ENFORCED_PERMISSION_KEYS], scope);
    for (const scope of ["selected", "none"] as const) {
      for (const { policy, bodies } of MATRIX) {
        if (policy.fn === "clickhouse-revenue") continue;
        for (const [action, body] of Object.entries(bodies)) {
          // rawOnly actions are refused to employees before scope; a (hypothetical)
          // restricted data owner proves the scope check itself.
          const rawOnly = Boolean(policy.actions[action].rawOnly);
          await expectDenied(policy, body, rawOnly ? ownerRow(scope) : employeeAll(scope), 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
        }
      }
    }
  });
});

// ---- runners through a ScopedReader -----------------------------------------------

function contextFor(row: ReturnType<typeof accessRow>): AccessContext {
  const parsed = parseResolveAccessRow(row);
  if (!parsed) throw new Error("bad fixture row");
  return buildAccessContext(parsed, { kind: "user", userId: row.user_id, email: "member@example.com" }, "req-test-1");
}

interface Recorded {
  query: string;
  params: Record<string, unknown>;
}

/** A payments warehouse fake: every grouped panel, decline table, day series and
 * option list returns a recognizable row, so a projection that empties a panel
 * is visible and a request that keeps a filter shows up in the bound params. */
function paymentsWarehouse() {
  const queries: Recorded[] = [];
  const commands: Recorded[] = [];
  const rowsFor = (sql: string): unknown[] => {
    if (sql.includes("system.tables")) return [];
    if (sql.includes("UNION ALL")) return [{ d: "funnel", v: "secret-funnel" }, { d: "media_buyer", v: "secret-buyer" }];
    const grouped = /^SELECT (\w+) k,/.exec(sql);
    if (grouped) return [{ k: `${grouped[1]}-key`, attempts: 10, successful: 7, failed: 3, users_with_attempts: 4 }];
    if (sql.startsWith("SELECT decline_key reason")) return [{ reason: "insufficient_funds", failed_attempts: 3, failed_users: 2, affected_funnels: ["secret-funnel"] }];
    if (/^SELECT event_day_\w+ date/.test(sql)) return [{ date: "2026-01-02", attempts: 10, successful: 7, failed: 3 }];
    if (sql.includes("count() attempts")) return [{ attempts: 10, successful: 7, failed: 3 }];
    return [];
  };
  const raw: ClickHouseClientLike = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params ?? {} });
      const rows = rowsFor(input.query);
      return { json: async () => rows };
    }),
    command: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push({ query: input.query, params: input.query_params ?? {} });
    }),
    insert: vi.fn(async () => undefined),
  };
  return { raw, queries, commands };
}

const AI_REQUEST: PaymentAnalyticsRequest & { purpose: string } = {
  action: "analytics",
  purpose: "ai_pass_rates",
  filters: { date_basis: "cohort", date_from: "2026-01-01", date_to: "2026-01-31", funnel: ["soulmate"], decline_reason: ["do_not_honor"], outcome: "failed" },
  group_by: "campaign_path",
  first_tx_dimension: "country",
  renewal_dimension: "stage",
};

const stable = (bundle: Record<string, unknown>) => ({ ...bundle, generated_at: "-", query_duration_ms: 0 });

describe("AI pass-rate projection (clickhouse-payment-analytics ai_pass_rates)", () => {
  it("only payment_pass.view holders and the data owner see the full bundle", () => {
    expect(paymentPassFullBundleAllowed(contextFor(ownerRow()))).toBe(true);
    expect(paymentPassFullBundleAllowed(contextFor(memberRow(["payment_pass.view", "ai.use"])))).toBe(true);
    expect(paymentPassFullBundleAllowed(contextFor(memberRow(["cohorts.view", "ai.use"])))).toBe(false);
  });

  it("reduces the request to the date window + campaign grouping and empties every other panel", async () => {
    const ctx = contextFor(memberRow(["cohorts.view", "ai.use"]));
    const { raw, queries, commands } = paymentsWarehouse();
    const bundle = await runAiPassRates({ authUserId: ctx.tenantKey, clickhouse: createScopedReader(ctx, raw), request: AI_REQUEST, fullBundle: false });

    expect(bundle.ok).toBe(true);
    expect(bundle.segment_rows.map((row) => row.key)).toEqual(["campaign_path-key"]);
    expect(bundle.segment_rows[0].pass_rate).toBeCloseTo(0.7);
    for (const panel of ["funnel_rows", "stage_rows", "first_tx_rows", "first_transaction_rows", "renewal_rows", "renewal_segment_rows", "decline_rows", "first_decline_rows", "time_points", "trial_by_country"] as const) {
      expect(bundle[panel]).toEqual([]);
    }
    expect(bundle.filter_options).toEqual({});
    expect(JSON.stringify(bundle)).not.toContain("secret-");
    // Filters other than the date window never reach the warehouse.
    const bound = queries.flatMap((entry) => Object.keys(entry.params));
    expect(bound.some((key) => key.startsWith("p_fn_") || key.startsWith("p_dr_"))).toBe(false);
    expect(queries.some((entry) => entry.params.date_from === "2026-01-01" && entry.params.date_to === "2026-01-31")).toBe(true);
    expect(queries.some((entry) => entry.query.includes("event_day_cohort >= {date_from:String}"))).toBe(true);
    // The scratch table is still created, under the workspace tenant.
    expect(commands.some((entry) => /^CREATE TABLE pp_staged_[0-9a-f]{32} /.test(entry.query) && entry.params.auth_user_id === DATA_KEY)).toBe(true);
    expect(ctx.violations).toEqual([]);
  });

  it("serves payment_pass.view holders the unmodified bundle of their own request", async () => {
    const ctx = contextFor(memberRow(["payment_pass.view", "ai.use", "cohorts.view"]));
    const full = paymentsWarehouse();
    const viaAi = await runAiPassRates({ authUserId: ctx.tenantKey, clickhouse: createScopedReader(ctx, full.raw), request: AI_REQUEST, fullBundle: true });
    const plain = paymentsWarehouse();
    const viaBundle = await runPaymentAnalytics({ authUserId: ctx.tenantKey, clickhouse: createScopedReader(ctx, plain.raw), request: AI_REQUEST });

    expect(stable(viaAi as unknown as Record<string, unknown>)).toEqual(stable(viaBundle as unknown as Record<string, unknown>));
    expect(viaAi.funnel_rows.length).toBe(1);
    expect(viaAi.filter_options.funnel).toEqual(["secret-funnel"]);
    expect(full.queries.some((entry) => entry.params.p_fn_0 === "soulmate")).toBe(true);
  });

  it("rejects any grouping other than campaign_path / campaign_id", () => {
    expect(aiPassRatesRequest({ ...AI_REQUEST, group_by: "campaign_id" }).group_by).toBe("campaign_id");
    for (const group_by of ["country", "decline_reason", undefined]) {
      expect(() => aiPassRatesRequest({ ...AI_REQUEST, group_by: group_by as never })).toThrow(PaymentAnalyticsRequestError);
    }
  });
});

describe("runners bind the workspace tenant through the ScopedReader", () => {
  it("scratch-table creation passes through for the tenant and is a violation for the caller's own id", async () => {
    const ctx = contextFor(memberRow(["payment_pass.view"]));
    const ok = paymentsWarehouse();
    await runPaymentAnalytics({ authUserId: ctx.tenantKey, clickhouse: createScopedReader(ctx, ok.raw), request: { action: "analytics" } });
    expect(ok.commands[0].query).toMatch(/^CREATE TABLE pp_staged_/);
    expect(ctx.violations).toEqual([]);

    const legacy = paymentsWarehouse();
    await expect(
      runPaymentAnalytics({ authUserId: EMPLOYEE, clickhouse: createScopedReader(ctx, legacy.raw), request: { action: "analytics" } }),
    ).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
    expect(legacy.commands.filter((entry) => entry.query.startsWith("CREATE TABLE"))).toEqual([]);
  });
});

describe("best-effort catches rethrow ScopeViolation", () => {
  const usersClient = (failOn: (sql: string) => boolean, error: Error): ClickHouseClientLike => ({
    query: vi.fn(async (input: { query: string }) => {
      if (failOn(input.query)) throw error;
      return { json: async () => [] };
    }),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
  });
  const violation = () => new ScopeViolation("restricted_protected_table", FACT_SUBSCRIPTIONS_TABLE);
  const isSubscriptionCount = (sql: string) => sql.includes(FACT_SUBSCRIPTIONS_TABLE) && sql.startsWith("SELECT count() AS c");
  const isScanDiag = (sql: string) => sql.includes("uniqExact(user_id) AS u");

  it("users: the subscription-status probe still degrades to 'failed' on warehouse errors", async () => {
    const response = await runUsersList({ authUserId: DATA_KEY, clickhouse: usersClient(isSubscriptionCount, new Error("boom")), request: { action: "list" } });
    expect(response.diagnostics.subscription_data_status).toBe("failed");
  });

  it("users: ...but a ScopeViolation from the probe or the scan diagnostics fails the request", async () => {
    await expect(runUsersList({ authUserId: DATA_KEY, clickhouse: usersClient(isSubscriptionCount, violation()), request: { action: "list" } })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(runUsersList({ authUserId: DATA_KEY, clickhouse: usersClient(isScanDiag, violation()), request: { action: "list" } })).rejects.toBeInstanceOf(ScopeViolation);
    const degraded = await runUsersList({ authUserId: DATA_KEY, clickhouse: usersClient(isScanDiag, new Error("boom")), request: { action: "list" } });
    expect(degraded.diagnostics.users_scanned).toBe(0);
  });

  it("payments: the stale-table sweep stays best-effort, except for a ScopeViolation", async () => {
    const sweeper = (error: Error) => {
      const { raw } = paymentsWarehouse();
      const query = raw.query;
      raw.query = vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
        if (input.query.includes("system.tables")) throw error;
        return query(input);
      });
      return raw;
    };
    await expect(runPaymentAnalytics({ authUserId: DATA_KEY, clickhouse: sweeper(new Error("boom")), request: { action: "analytics" } })).resolves.toMatchObject({ ok: true });
    await expect(runPaymentAnalytics({ authUserId: DATA_KEY, clickhouse: sweeper(violation()), request: { action: "analytics" } })).rejects.toBeInstanceOf(ScopeViolation);
  });
});

describe("index.ts entrypoints are on the gate", () => {
  const ENTRYPOINTS: Record<string, string> = {
    "clickhouse-users": "CLICKHOUSE_USERS_POLICY",
    "clickhouse-payment-analytics": "CLICKHOUSE_PAYMENT_ANALYTICS_POLICY",
    "clickhouse-revenue": "CLICKHOUSE_REVENUE_POLICY",
    "dashboard-summary": "DASHBOARD_SUMMARY_POLICY",
    "fb-analytics-summary": "FB_ANALYTICS_SUMMARY_POLICY",
  };

  it.each(Object.entries(ENTRYPOINTS))("%s serves through serveWithAccess(%s) with the tenant key", (fn, policyName) => {
    const source = readFileSync(resolve(process.cwd(), `supabase/functions/${fn}/index.ts`), "utf8");
    expect(source).toMatch(new RegExp(`serveWithAccess\\(\\s*${policyName},`));
    expect(source).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    expect(source).toContain("ctx.tenantKey");
    for (const banned of ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "clickhouse/client.ts", "Deno.serve(", "auth.id", "parseJsonBody"]) {
      expect(source).not.toContain(banned);
    }
  });
});
