// ScopedReader, Phase 2 (spec §3.3, §3.6): restricted contexts may read a
// protected table only inside a scope fragment registered for THEIR context.
//
// Pinned here:
//   * masking: registered fragments pass, anything protected / forbidden /
//     quoted that is left over is a recorded violation, and a fragment from
//     another context is not masked;
//   * restricted contexts never write;
//   * capacity: fixed settings + query_id on restricted reads, at most 3 in
//     flight, close() aborts — and owner / cron transport input is unchanged;
//   * context hardening: only issued contexts get a reader; contexts are frozen
//     and their permissions are a read-only Set facade.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORBIDDEN_CONSTRUCTS,
  PROTECTED_TABLE_PATTERN,
  ScopeViolation,
  createScopedReader,
} from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  campaignScopeVisibleFrom,
  createRestrictedScopeSql,
  cohortsFrom,
  fbFrom,
  presenceProbeSql,
  txFrom,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  COHORT_CLASSIFICATION_VERSION,
  type CohortSnapshotState,
  type ScopeSnapshot,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import {
  buildAccessContext,
  buildCronAccessContext,
  isIssuedAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse } from "./support/recordingClickHouse.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

type QueryInput = Parameters<ClickHouseClientLike["query"]>[0];

function fakeRaw() {
  return {
    query: vi.fn(async (_input: QueryInput) => ({ json: async () => [] as unknown })),
    command: vi.fn(async (_input: { query: string; query_params?: Record<string, unknown> }) => undefined),
    insert: vi.fn(async (_input: { table: string; values: Record<string, unknown>[] }) => undefined),
    close: vi.fn(async () => undefined),
  };
}

function context(mode: "all" | "selected" | "none", options: { userId?: string; requestId?: string; permissions?: string[] } = {}): AccessContext {
  const userId = options.userId ?? EMPLOYEE;
  const row = parseResolveAccessRow({
    status: "ok",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: userId,
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: userId === DATA_KEY,
    raw_access: userId === DATA_KEY,
    role: { id: "r1", key: userId === DATA_KEY ? "owner" : "media_buyer", name: "Role", is_owner: userId === DATA_KEY, permissions: options.permissions ?? ["cohorts.view", "dashboard.view"] },
    funnel_scope: { mode, funnel_ids: mode === "selected" ? ["f1", "f2"] : [], paths: mode === "selected" ? ["soulmate-sketch", "past-life"] : [] },
    access_version: "1",
    partition: "p",
  });
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId, email: "member@example.com" }, options.requestId ?? "req-42");
}

const SNAPSHOT: ScopeSnapshot = {
  warehouseVersion: "wh_1",
  classificationVersion: COHORT_CLASSIFICATION_VERSION,
  campaignScopeReady: true,
  freshVerifiedAt: "2026-10-06T00:00:00.000Z",
  staleSince: null,
  state: {} as CohortSnapshotState,
};

const RESTRICTED_SETTINGS = {
  max_execution_time: 20,
  timeout_overflow_mode: "throw",
  max_memory_usage: 4e9,
  readonly: 2,
  cancel_http_readonly_queries_on_client_close: 1,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("issued, frozen contexts (spec §3.6)", () => {
  it("only contexts from the builders get a reader", () => {
    const ctx = context("all");
    expect(isIssuedAccessContext(ctx)).toBe(true);
    expect(isIssuedAccessContext(buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron" }))).toBe(true);
    for (const forged of [{ ...ctx }, Object.freeze({ ...ctx }), { ...ctx, restricted: false }, null, undefined, "ctx"]) {
      expect(isIssuedAccessContext(forged)).toBe(false);
      expect(() => createScopedReader(forged as AccessContext, fakeRaw())).toThrow(/issued by buildAccessContext/);
    }
  });

  it("freezes the context, its actor, role, scope and arrays; violations stays appendable", () => {
    const ctx = context("selected");
    for (const part of [ctx, ctx.actor, ctx.role, ctx.scope, ctx.scope.funnel, ctx.permissions]) expect(Object.isFrozen(part)).toBe(true);
    const funnel = ctx.scope.funnel as { mode: "selected"; funnelIds: string[]; paths: string[] };
    expect(Object.isFrozen(funnel.paths)).toBe(true);
    expect(Object.isFrozen(funnel.funnelIds)).toBe(true);
    const mutable = ctx as unknown as Record<string, unknown>;
    expect(() => { mutable.tenantKey = EMPLOYEE; }).toThrow(TypeError);
    expect(() => { mutable.restricted = false; }).toThrow(TypeError);
    expect(() => { (ctx.actor as unknown as Record<string, unknown>).userId = DATA_KEY; }).toThrow(TypeError);
    expect(() => { funnel.paths.push("other-funnel"); }).toThrow(TypeError);
    expect(ctx.tenantKey).toBe(DATA_KEY);
    expect(ctx.restricted).toBe(true);
    ctx.violations.push("x");
    expect(ctx.violations).toEqual(["x"]);
    const cron = buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron" });
    expect(Object.isFrozen(cron)).toBe(true);
    expect(Object.isFrozen(cron.scope.funnel)).toBe(true);
  });

  it("permissions is a read-only Set facade with the full read surface", () => {
    const ctx = context("all", { permissions: ["dashboard.view", "cohorts.view"] });
    const permissions = ctx.permissions;
    expect(permissions.has("cohorts.view")).toBe(true);
    expect(permissions.has("admin.users.manage")).toBe(false);
    expect(permissions.size).toBe(2);
    expect([...permissions].sort()).toEqual(["cohorts.view", "dashboard.view"]);
    expect([...permissions.keys()].sort()).toEqual(["cohorts.view", "dashboard.view"]);
    expect([...permissions.values()].sort()).toEqual(["cohorts.view", "dashboard.view"]);
    expect([...permissions.entries()].map(([a, b]) => `${a}=${b}`).sort()).toEqual(["cohorts.view=cohorts.view", "dashboard.view=dashboard.view"]);
    const seen: string[] = [];
    permissions.forEach(function (this: unknown, value, key, set) {
      expect(value).toBe(key);
      expect(set).toBe(permissions);
      expect(this).toBe(seen);
      seen.push(value);
    }, seen);
    expect(seen.sort()).toEqual(["cohorts.view", "dashboard.view"]);
    expect(new Set(permissions).size).toBe(2);
    const facade = permissions as unknown as Record<string, unknown>;
    for (const method of ["add", "delete", "clear"]) expect(facade[method], method).toBeUndefined();
    expect(() => { facade.has = () => true; }).toThrow(TypeError);
    expect(permissions.has("admin.users.manage")).toBe(false);
    const cron = buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron" });
    expect([...cron.permissions].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());
  });
});

describe("restricted masking", () => {
  it("passes a statement whose protected reads are all registered fragments, binding the tenant", async () => {
    const ctx = context("selected");
    const scope = createRestrictedScopeSql(ctx, SNAPSHOT);
    const raw = fakeRaw();
    const query = `SELECT count() AS c FROM ${txFrom(scope, "a")} INNER JOIN ${cohortsFrom(scope, "fc")} ON fc.canonical_user_id = a.user_id WHERE a.auth_user_id = {auth_user_id:String}`;
    await createScopedReader(ctx, raw).query({ query, format: "JSONEachRow" });
    expect(ctx.violations).toEqual([]);
    expect(raw.query).toHaveBeenCalledTimes(1);
    expect(raw.query.mock.calls[0][0]).toMatchObject({ query, format: "JSONEachRow", query_params: { auth_user_id: DATA_KEY } });
  });

  it("passes FB fragments (VIS nested inside) and the presence probe", async () => {
    const ctx = context("selected");
    const scope = createRestrictedScopeSql(ctx, SNAPSHOT);
    const raw = fakeRaw();
    const reader = createScopedReader(ctx, raw);
    await reader.query({ query: `SELECT sum(f.spend) FROM ${fbFrom(scope, "campaign", "f")} WHERE f.level = {level:String}`, query_params: { level: "campaign" } });
    await reader.query({ query: presenceProbeSql(scope, "fact_support_requests"), format: "JSONEachRow" });
    expect(ctx.violations).toEqual([]);
    expect(raw.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["an unscoped table next to a fragment", (frag: string) => `SELECT 1 FROM ${frag} JOIN fact_user_cohorts AS x FINAL ON 1`, "restricted_protected_table:fact_user_cohorts"],
    ["the raw table spelled in a comment-free subquery", (frag: string) => `SELECT 1 FROM ${frag} WHERE user_id IN (SELECT user_id FROM analytics_transactions)`, "restricted_protected_table:analytics_transactions"],
    ["a staged palmer table", () => "SELECT * FROM pp_staged_batch_1", "restricted_protected_table:pp_staged_batch_1"],
    ["a staged user-data table", () => "SELECT * FROM UD_STAGED_X", "restricted_protected_table:UD_STAGED_X"],
  ])("records %s", async (_label, build, violation) => {
    const ctx = context("selected");
    const scope = createRestrictedScopeSql(ctx, SNAPSHOT);
    const raw = fakeRaw();
    await expect(createScopedReader(ctx, raw).query({ query: build(txFrom(scope, "a")) })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toEqual([violation]);
    expect(raw.query).not.toHaveBeenCalled();
  });

  it("a fragment registered for ANOTHER context is not masked", async () => {
    const other = context("selected", { requestId: "req-other" });
    const foreign = txFrom(createRestrictedScopeSql(other, SNAPSHOT), "a");
    const ctx = context("selected");
    createRestrictedScopeSql(ctx, SNAPSHOT);
    const raw = fakeRaw();
    await expect(createScopedReader(ctx, raw).query({ query: `SELECT count() FROM ${foreign}` })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations[0]).toMatch(/^restricted_protected_table:/);
    expect(raw.query).not.toHaveBeenCalled();
  });

  it.each([
    "SELECT name FROM system.tables",
    "SELECT * FROM SYSTEM . query_log",
    "SELECT * FROM information_schema.columns",
    "SELECT * FROM remote('host', default, t)",
    "SELECT * FROM remoteSecure ('h', d, t)",
    "SELECT * FROM url('http://x', CSV)",
    "SELECT * FROM s3('https://bucket/x')",
    "SELECT * FROM file('x.csv')",
    "SELECT * FROM merge(currentDatabase(), '^t')",
    "SELECT * FROM input('a String')",
    "SELECT * FROM mysql('h', 'd', 't', 'u', 'p')",
    "SELECT * FROM numbers(10) WHERE dictGetString('d', 'a', toUInt64(1)) != ''",
    "SELECT joinGet('j', 'v', 1)",
    "SELECT 1 SETTINGS max_threads = 64",
    "SELECT 1 settings readonly = 0",
    "SELECT 1 INTO OUTFILE 'x'",
  ])("refuses the forbidden construct in: %s", async (query) => {
    const ctx = context("selected");
    const raw = fakeRaw();
    await expect(createScopedReader(ctx, raw).query({ query })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toHaveLength(1);
    expect(ctx.violations[0]).toMatch(/^restricted_forbidden_construct:/);
    expect(raw.query).not.toHaveBeenCalled();
  });

  it.each(["SELECT `x` FROM numbers(1)", "SELECT \"x\" FROM numbers(1)", "SELECT 'a\\'b'"])("refuses quoted identifiers / escapes: %s", async (query) => {
    const ctx = context("selected");
    await expect(createScopedReader(ctx, fakeRaw()).query({ query })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toEqual(["restricted_quoted_identifier"]);
  });

  it("lets plain table-free reads and lookalike words through", async () => {
    const ctx = context("selected");
    const raw = fakeRaw();
    const reader = createScopedReader(ctx, raw);
    for (const query of ["SELECT version()", "SELECT 1 AS settings_count", "SELECT domain('x') AS file_name, 'system' AS s"]) {
      await reader.query({ query });
    }
    expect(ctx.violations).toEqual([]);
    expect(raw.query).toHaveBeenCalledTimes(3);
  });

  // Security review (R7 is the backstop for a builder mistake): three statement
  // shapes the guard never inspected — text around a bare VIS fragment, an
  // {x:Identifier} placeholder whose VALUE names a table, and table functions
  // missing from the denylist.
  describe("R7 bypass shapes from the security review", () => {
    const refused = async (build: (scope: ReturnType<typeof createRestrictedScopeSql>) => string, params: Record<string, unknown> = {}) => {
      const ctx = context("selected");
      const scope = createRestrictedScopeSql(ctx, SNAPSHOT);
      const raw = fakeRaw();
      await expect(createScopedReader(ctx, raw).query({ query: build(scope), query_params: { auth_user_id: DATA_KEY, ...params } })).rejects.toBeInstanceOf(ScopeViolation);
      expect(raw.query).not.toHaveBeenCalled();
      expect(ctx.violations).toHaveLength(1);
      return ctx.violations[0];
    };

    it("VIS is closed: widening it means splicing into the fragment, which unmasks fact_campaign_scope", async () => {
      expect(await refused((scope) => `SELECT campaign_id FROM ${campaignScopeVisibleFrom(scope).slice(0, -1)} OR status = 'mixed') FORMAT JSONEachRow`))
        .toBe("restricted_protected_table:fact_campaign_scope");
      // The probe's own shape now wraps the closed unit (it can no longer reach the WHERE).
      const ctx = context("selected");
      const scope = createRestrictedScopeSql(ctx, SNAPSHOT);
      expect(campaignScopeVisibleFrom(scope)).toMatch(/^\(SELECT campaign_id FROM fact_campaign_scope FINAL WHERE .*\)$/);
    });

    it.each([
      ["SELECT sum(gross_amount_usd) s FROM {t:Identifier} WHERE auth_user_id = {auth_user_id:String} FORMAT JSONEachRow", "{t:Identifier}"],
      ["SELECT count() FROM { t : Identifier }", "{t:Identifier}"],
      ["SELECT {c:Identifier} FROM cte", "{c:Identifier}"],
      ["SELECT {m:Map(String, String)}", "{m:Map(String, String)}"],
      ["SELECT 1 WHERE 'a' = {x:LowCardinality(String)}", "{x:LowCardinality(String)}"],
    ])("refuses a placeholder that is not a plain value: %s (query_params values are never scanned)", async (query, placeholder) => {
      expect(await refused(() => query, { t: "analytics_transactions", c: "raw_payload" })).toBe(`restricted_forbidden_construct:${placeholder}`);
    });

    it.each([
      ["mergeTreeProjection(currentDatabase(), concat('analytics_', 'transactions'), 'p')", "mergeTreeProjection("],
      ["hdfsCluster('c', 'hdfs://x', 'CSV')", "hdfsCluster("],
      ["icebergS3('https://x')", "icebergS3("],
      ["deltaLakeCluster('c', 'https://x')", "deltaLakeCluster("],
      ["fileCluster('c', 'x.csv')", "fileCluster("],
      ["azureBlobStorageCluster('c', 'x')", "azureBlobStorageCluster("],
    ])("the denylist covers %s", async (source, construct) => {
      expect(await refused(() => `SELECT count() FROM ${source}`)).toBe(`restricted_forbidden_construct:${construct}`);
    });

    it.each([
      ["FROM a future table function", () => "SELECT count() FROM someNewTableFunction(currentDatabase(), 'analytics_' || 'transactions')", "FROM someNewTableFunction("],
      ["FROM a parenthesized one", () => "SELECT count() FROM ( someNewTableFunction('x') )", "FROM someNewTableFunction("],
      ["JOIN one", (scope: ReturnType<typeof createRestrictedScopeSql>) => `SELECT 1 FROM ${txFrom(scope, "a")} JOIN otherFn('x') AS o ON 1`, "JOIN otherFn("],
      ["a comma join after a fragment", (scope: ReturnType<typeof createRestrictedScopeSql>) => `SELECT 1 FROM ${txFrom(scope, "a")}, otherFn('x') AS o WHERE 1`, "FROM list with a comma join"],
      ["a comma join of names", () => "SELECT 1 FROM cte_a AS a, cte_b AS b", "FROM list with a comma join"],
    ])("refuses any function call as a FROM / JOIN source: %s", async (_label, build, detail) => {
      expect(await refused(build)).toBe(`restricted_forbidden_construct:${detail}`);
    });

    it("keeps the restricted builders' own shapes: value placeholders, trim(… FROM expr), subqueries, CTEs, ARRAY JOIN", async () => {
      const ctx = context("selected");
      const scope = createRestrictedScopeSql(ctx, SNAPSHOT);
      const raw = fakeRaw();
      const reader = createScopedReader(ctx, raw);
      const queries = [
        `SELECT count() FROM ${cohortsFrom(scope, "fc")} WHERE fc.cohort_date >= {date_from:String} AND fc.price_plan IN ({p_0:String}, {p_1:String})`,
        `SELECT 1 FROM ${txFrom(scope, "a")} WHERE a.event_time < {now:DateTime64(3, 'UTC')} AND a.transaction_date >= {d:Date} LIMIT {n:UInt32}`,
        "SELECT has({paths:Array(String)}, 'x'), lowerUTF8(trim(BOTH ' ' FROM toString(1))) FROM cte",
        `WITH base AS (SELECT a.user_id, a.gross_amount_usd FROM ${txFrom(scope, "a")}), agg AS (SELECT user_id, sum(gross_amount_usd) g FROM base GROUP BY user_id) ` +
          `SELECT u, g FROM agg LEFT JOIN (SELECT canonical_user_id u FROM ${cohortsFrom(scope)}) AS c ON c.u = agg.user_id ARRAY JOIN splitByChar(',', 'a,b') AS part ORDER BY g, u LIMIT 10`,
        `SELECT campaign_id FROM ${campaignScopeVisibleFrom(scope)} FORMAT JSONEachRow`,
      ];
      for (const query of queries) await reader.query({ query });
      expect(ctx.violations).toEqual([]);
      expect(raw.query).toHaveBeenCalledTimes(queries.length);
    });
  });

  it("scope-all readers are not masked or checked (the owner keeps every construct)", async () => {
    const ctx = context("all");
    const raw = fakeRaw();
    await createScopedReader(ctx, raw).query({ query: "SELECT name FROM system.tables WHERE database = currentDatabase() AND name = 'fact_user_cohorts'" });
    expect(ctx.violations).toEqual([]);
  });

  it("exposes the pattern lists", () => {
    expect(PROTECTED_TABLE_PATTERN.test("SELECT * FROM pp_staged_x")).toBe(true);
    expect(PROTECTED_TABLE_PATTERN.test("SELECT * FROM ud_staged_x")).toBe(true);
    expect(FORBIDDEN_CONSTRUCTS.length).toBe(5);
    expect(Object.isFrozen(FORBIDDEN_CONSTRUCTS)).toBe(true);
  });
});

describe("restricted contexts never write", () => {
  it("command() is restricted_write, whatever it touches", async () => {
    const ctx = context("selected");
    const raw = fakeRaw();
    const reader = createScopedReader(ctx, raw);
    await expect(reader.command({ query: "OPTIMIZE TABLE scratch_x" })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(reader.command({ query: "ALTER TABLE analytics_transactions DELETE WHERE auth_user_id = {auth_user_id:String}" })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toEqual(["restricted_write", "restricted_write"]);
    expect(raw.command).not.toHaveBeenCalled();
  });

  it("insert() is restricted_write (a protected target keeps its Phase-1 code)", async () => {
    const ctx = context("none");
    const raw = fakeRaw();
    const reader = createScopedReader(ctx, raw);
    await expect(reader.insert({ table: "scratch_rows", values: [{ a: 1 }] })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(reader.insert({ table: "fact_user_cohorts", values: [{ auth_user_id: DATA_KEY }] })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toEqual(["restricted_write:scratch_rows", "restricted_protected_table:fact_user_cohorts"]);
    expect(raw.insert).not.toHaveBeenCalled();
  });

  it("scope-all members and the cron still write as before", async () => {
    const raw = fakeRaw();
    const cron = buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron" });
    const reader = createScopedReader(cron, raw);
    await reader.command({ query: "OPTIMIZE TABLE fact_user_cohorts FINAL" });
    await reader.insert({ table: "fact_user_cohorts", values: [{ auth_user_id: DATA_KEY }] });
    expect(raw.command).toHaveBeenCalledWith({ query: "OPTIMIZE TABLE fact_user_cohorts FINAL" });
    expect(cron.violations).toEqual([]);
  });
});

describe("capacity (M14)", () => {
  it("owner, scope-all member and cron transport input is byte-identical to Phase 1", async () => {
    for (const ctx of [context("all", { userId: DATA_KEY }), context("all"), buildCronAccessContext({ tenantKey: DATA_KEY, requestId: "cron" })]) {
      const raw = fakeRaw();
      const reader = createScopedReader(ctx, raw);
      await reader.query({ query: "SELECT 1 FROM fact_x WHERE auth_user_id = {auth_user_id:String}", format: "JSONEachRow" });
      await reader.query({ query: "SELECT 1" });
      expect(raw.query.mock.calls[0][0]).toEqual({ query: "SELECT 1 FROM fact_x WHERE auth_user_id = {auth_user_id:String}", format: "JSONEachRow", query_params: { auth_user_id: DATA_KEY } });
      expect(Object.keys(raw.query.mock.calls[0][0]).sort()).toEqual(["format", "query", "query_params"]);
      expect(raw.query.mock.calls[1][0]).toEqual({ query: "SELECT 1" });
    }
  });

  it("the recording transport keeps owner statements free of settings / query_id", async () => {
    const recording = createRecordingClickHouse();
    await createScopedReader(context("all", { userId: DATA_KEY }), recording).query({ query: "SELECT 1" });
    expect(recording.statements[0]).not.toHaveProperty("settings");
    expect(recording.statements[0]).not.toHaveProperty("query_id");

    const restricted = createRecordingClickHouse();
    await createScopedReader(context("selected", { requestId: "req-rec" }), restricted).query({ query: "SELECT 1" });
    expect(restricted.statements[0]).toMatchObject({ settings: RESTRICTED_SETTINGS, query_id: "sub_req-rec_1" });
  });

  it("restricted reads carry the fixed settings and a numbered query_id; caller values cannot relax them", async () => {
    const ctx = context("selected", { requestId: "req-cap" });
    const raw = fakeRaw();
    const reader = createScopedReader(ctx, raw);
    await reader.query({ query: "SELECT 1" });
    await reader.query({ query: "SELECT 2", settings: { readonly: 0, max_execution_time: 600 }, query_id: "mine" });
    const [first, second] = raw.query.mock.calls.map(([input]) => input);
    expect(first.settings).toEqual(RESTRICTED_SETTINGS);
    expect(first.query_id).toBe("sub_req-cap_1");
    expect(first.signal).toBeInstanceOf(AbortSignal);
    expect(second.settings).toEqual(RESTRICTED_SETTINGS);
    expect(second.query_id).toBe("sub_req-cap_2");
  });

  it("max_memory_usage follows CLICKHOUSE_RESTRICTED_MAX_MEMORY_BYTES (invalid → default)", async () => {
    vi.stubEnv("CLICKHOUSE_RESTRICTED_MAX_MEMORY_BYTES", "2000000000");
    const raw = fakeRaw();
    await createScopedReader(context("selected"), raw).query({ query: "SELECT 1" });
    expect(raw.query.mock.calls[0][0].settings?.max_memory_usage).toBe(2_000_000_000);
    vi.stubEnv("CLICKHOUSE_RESTRICTED_MAX_MEMORY_BYTES", "lots");
    const fallback = fakeRaw();
    await createScopedReader(context("selected"), fallback).query({ query: "SELECT 1" });
    expect(fallback.query.mock.calls[0][0].settings?.max_memory_usage).toBe(4e9);
  });

  it("allows at most 3 restricted queries in flight per reader", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    const raw = fakeRaw();
    raw.query.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
      return { json: async () => [] as unknown };
    });
    const reader = createScopedReader(context("selected"), raw);
    const pending = Array.from({ length: 7 }, (_, index) => reader.query({ query: `SELECT ${index}` }));
    await vi.waitFor(() => expect(raw.query).toHaveBeenCalledTimes(3));
    expect(inFlight).toBe(3);
    while (raw.query.mock.calls.length < 7 || releases.length) {
      const release = releases.shift();
      if (release) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(inFlight).toBeLessThanOrEqual(3);
    }
    await Promise.all(pending);
    expect(raw.query).toHaveBeenCalledTimes(7);
    expect(peak).toBe(3);
  });

  it("does not limit owner readers", async () => {
    const raw = fakeRaw();
    const releases: Array<() => void> = [];
    raw.query.mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return { json: async () => [] as unknown };
    });
    const reader = createScopedReader(context("all", { userId: DATA_KEY }), raw);
    const pending = Array.from({ length: 6 }, (_, index) => reader.query({ query: `SELECT ${index}` }));
    await vi.waitFor(() => expect(raw.query).toHaveBeenCalledTimes(6));
    releases.forEach((release) => release());
    await Promise.all(pending);
  });

  it("close() aborts in-flight reads, rejects queued ones and refuses new ones", async () => {
    const signals: AbortSignal[] = [];
    const raw = fakeRaw();
    raw.query.mockImplementation(async (input: QueryInput) => {
      signals.push(input.signal as AbortSignal);
      await new Promise<void>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      return { json: async () => [] as unknown };
    });
    const reader = createScopedReader(context("selected"), raw);
    const pending = Array.from({ length: 4 }, (_, index) => reader.query({ query: `SELECT ${index}` }).then(() => "ok", (error: Error) => error.message));
    await vi.waitFor(() => expect(raw.query).toHaveBeenCalledTimes(3));
    await reader.close?.();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(await Promise.all(pending)).toEqual(["aborted", "aborted", "aborted", "ClickHouse reader is closed."]);
    await expect(reader.query({ query: "SELECT 9" })).rejects.toThrow(/closed/);
    expect(raw.query).toHaveBeenCalledTimes(3);
    expect(raw.close).toHaveBeenCalledTimes(1);
  });

  it("owner readers keep working after close (Phase-1 behaviour)", async () => {
    const raw = fakeRaw();
    const reader = createScopedReader(context("all", { userId: DATA_KEY }), raw);
    await reader.close?.();
    await reader.query({ query: "SELECT 1" });
    expect(raw.query).toHaveBeenCalledTimes(1);
  });
});
