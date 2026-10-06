// ScopedReader (plan §13 layer 2): the only ClickHouse client request code gets.
// Phase 1 guarantees pinned here:
//   * {auth_user_id:String} is always the workspace tenant, never the caller;
//   * a caller-supplied different auth_user_id is a recorded violation;
//   * restricted contexts cannot reference a protected table at all;
//   * inserts cannot carry another tenant's rows;
//   * violations are recorded on ctx BEFORE the throw, so a swallowed throw
//     still turns the response into a 500 (the gate test covers that part).
import { describe, expect, it, vi } from "vitest";
import {
  PROTECTED_TABLE_PATTERN,
  ScopeViolation,
  createScopedReader,
  isScopedReader,
} from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  buildAccessContext,
  buildCronAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../../supabase/functions/_shared/access/accessContext.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

function fakeRaw() {
  type Statement = { query: string; query_params?: Record<string, unknown>; format?: string };
  const raw = {
    query: vi.fn(async (_input: Statement) => ({ json: async () => [] as unknown })),
    command: vi.fn(async (_input: Statement) => undefined),
    insert: vi.fn(async (_input: { table: string; values: Record<string, unknown>[] }) => undefined),
    close: vi.fn(async () => undefined),
  };
  return raw;
}

function employeeContext(mode: "all" | "selected" | "none"): AccessContext {
  const row = parseResolveAccessRow({
    status: "ok",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: EMPLOYEE,
    email: "buyer@example.com",
    display_name: "Buyer",
    is_data_owner: false,
    raw_access: false,
    role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: ["cohorts.view"] },
    funnel_scope: { mode, funnel_ids: mode === "selected" ? ["f1"] : [], paths: mode === "selected" ? ["soulmate"] : [] },
    access_version: "1",
    partition: "p",
  });
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId: EMPLOYEE, email: "buyer@example.com" }, "req-1");
}

describe("tenant binding", () => {
  it("binds {auth_user_id:String} to the tenant key when the caller passes nothing", async () => {
    const raw = fakeRaw();
    const ctx = employeeContext("all");
    await createScopedReader(ctx, raw).query({ query: "SELECT count() FROM analytics_transactions WHERE auth_user_id = {auth_user_id:String}", format: "JSONEachRow" });
    expect(raw.query).toHaveBeenCalledWith(expect.objectContaining({ query_params: { auth_user_id: DATA_KEY }, format: "JSONEachRow" }));
    expect(ctx.tenantKey).toBe(DATA_KEY);
    expect(ctx.tenantKey).not.toBe(ctx.actor.userId);
  });

  it("keeps other params and accepts the tenant key when the caller passes it", async () => {
    const raw = fakeRaw();
    const ctx = employeeContext("all");
    await createScopedReader(ctx, raw).query({
      query: "SELECT 1 FROM fact_user_cohorts WHERE auth_user_id = {auth_user_id:String} AND d >= {from:Date}",
      query_params: { auth_user_id: DATA_KEY, from: "2026-01-01" },
    });
    expect(raw.query.mock.calls[0][0].query_params).toEqual({ auth_user_id: DATA_KEY, from: "2026-01-01" });
    expect(ctx.violations).toEqual([]);
  });

  it("records and throws when the caller binds a different tenant (e.g. its own id)", async () => {
    const raw = fakeRaw();
    const ctx = employeeContext("all");
    const reader = createScopedReader(ctx, raw);
    await expect(reader.query({ query: "SELECT 1 WHERE auth_user_id = {auth_user_id:String}", query_params: { auth_user_id: EMPLOYEE } }))
      .rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toEqual(["tenant_param_mismatch"]);
    expect(raw.query).not.toHaveBeenCalled();
  });

  it("applies the same tenant rule to commands", async () => {
    const raw = fakeRaw();
    const ctx = buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron-1" });
    const reader = createScopedReader(ctx, raw);
    await reader.command({ query: "ALTER TABLE x DELETE WHERE auth_user_id = {auth_user_id:String}" });
    expect(raw.command).toHaveBeenCalledWith(expect.objectContaining({ query_params: { auth_user_id: DATA_KEY } }));
    await expect(reader.command({ query: "OPTIMIZE TABLE x", query_params: { auth_user_id: EMPLOYEE } })).rejects.toThrow(ScopeViolation);
    expect(ctx.violations).toEqual(["tenant_param_mismatch"]);
  });

  it("passes queries without the placeholder through untouched", async () => {
    const raw = fakeRaw();
    await createScopedReader(employeeContext("all"), raw).query({ query: "SELECT 1" });
    expect(raw.query).toHaveBeenCalledWith({ query: "SELECT 1" });
  });
});

describe("restricted contexts and protected tables", () => {
  const protectedQueries = [
    "SELECT * FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}",
    "SELECT * FROM `analytics_transactions_rebuild`",
    "SELECT * FROM default.fact_user_cohorts",
    "SELECT * FROM fact_support_requests",
    "SELECT * FROM facebook_ads_insights_daily",
    "SELECT * FROM v_fb_campaign_daily",
    "SELECT * FROM v_channel_spend",
    "SELECT * FROM dim_facebook_campaigns",
    "SELECT * FROM raw_facebook_api_responses",
    "SELECT * FROM analytics_validation_source_ids",
    "select * from FACT_USER_COHORTS",
  ];

  it.each(protectedQueries)("a selected-scope member cannot read: %s", async (query) => {
    const raw = fakeRaw();
    const ctx = employeeContext("selected");
    await expect(createScopedReader(ctx, raw).query({ query })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toHaveLength(1);
    expect(ctx.violations[0]).toMatch(/^restricted_protected_table:/);
    expect(raw.query).not.toHaveBeenCalled();
  });

  it("a member with no funnel rule is restricted too", async () => {
    const ctx = employeeContext("none");
    expect(ctx.restricted).toBe(true);
    await expect(createScopedReader(ctx, fakeRaw()).query({ query: protectedQueries[0] })).rejects.toThrow(ScopeViolation);
  });

  it("restricted members may still run queries that touch no protected table", async () => {
    const raw = fakeRaw();
    const ctx = employeeContext("selected");
    await createScopedReader(ctx, raw).query({ query: "SELECT version()" });
    expect(raw.query).toHaveBeenCalledTimes(1);
    expect(ctx.violations).toEqual([]);
  });

  it("full-scope members read protected tables normally", async () => {
    const raw = fakeRaw();
    const ctx = employeeContext("all");
    for (const query of protectedQueries) await createScopedReader(ctx, raw).query({ query });
    expect(raw.query).toHaveBeenCalledTimes(protectedQueries.length);
    expect(ctx.violations).toEqual([]);
  });

  it("matches the plan's protected-table list", () => {
    for (const table of ["analytics_transactions", "fact_x", "facebook_x", "v_fb_x", "v_channel_x", "dim_facebook_x", "raw_facebook_api_responses", "analytics_validation_source_ids"]) {
      expect(PROTECTED_TABLE_PATTERN.test(`SELECT * FROM ${table}`), table).toBe(true);
    }
    for (const table of ["clickhouse_sync_state", "funnels", "transactions_staging"]) {
      expect(PROTECTED_TABLE_PATTERN.test(`SELECT * FROM ${table}`), table).toBe(false);
    }
  });
});

describe("inserts", () => {
  it("accepts rows of the tenant and rows without auth_user_id", async () => {
    const raw = fakeRaw();
    const ctx = buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron-1" });
    const input = { table: "fact_support_requests", values: [{ auth_user_id: DATA_KEY, id: 1 }, { id: 2 }] };
    await createScopedReader(ctx, raw).insert(input);
    expect(raw.insert).toHaveBeenCalledWith(input);
  });

  it("rejects a row of another tenant", async () => {
    const raw = fakeRaw();
    const ctx = buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron-1" });
    await expect(createScopedReader(ctx, raw).insert({ table: "fact_x", values: [{ auth_user_id: DATA_KEY }, { auth_user_id: EMPLOYEE }] }))
      .rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toEqual(["tenant_row_mismatch:fact_x"]);
    expect(raw.insert).not.toHaveBeenCalled();
  });

  it("rejects restricted writes into protected tables", async () => {
    const ctx = employeeContext("selected");
    await expect(createScopedReader(ctx, fakeRaw()).insert({ table: "fact_x", values: [{ auth_user_id: DATA_KEY }] })).rejects.toThrow(ScopeViolation);
    expect(ctx.violations[0]).toBe("restricted_protected_table:fact_x");
  });
});

describe("lifecycle", () => {
  it("is branded, lazily needs the transport, and forwards close", async () => {
    const ctx = employeeContext("all");
    // Building without a transport must not touch ClickHouse secrets.
    expect(() => createScopedReader(ctx)).not.toThrow();
    const raw = fakeRaw();
    const reader = createScopedReader(ctx, raw);
    expect(isScopedReader(reader)).toBe(true);
    expect(isScopedReader(raw as unknown as ClickHouseClientLike)).toBe(false);
    await reader.close?.();
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("the violation survives a swallowed throw", async () => {
    const ctx = employeeContext("selected");
    const reader = createScopedReader(ctx, fakeRaw());
    const rows = await reader.query({ query: "SELECT * FROM fact_user_cohorts" }).catch(() => []);
    expect(rows).toEqual([]);
    expect(ctx.violations).toHaveLength(1);
  });
});
