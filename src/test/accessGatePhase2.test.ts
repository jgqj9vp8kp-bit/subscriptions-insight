// The access gate, Phase 2 (spec §3.5): the per-request ScopeSql handle, the
// freshness gate (409 scope_snapshot_not_ready), restrictedAnyOf, and the
// mapping of scope refusals raised inside a handler.
//
// What must hold:
//   * scope all (owner, scope-all members) and the cron get ALL_SCOPE_SQL with
//     no snapshot I/O at all — their requests are unchanged;
//   * a restricted request on a scopeSnapshot action reaches its handler only
//     with a fresh, validated snapshot; any fault reading the state is 503,
//     any readiness failure is 409 with a fixed body (the reason is logged only);
//   * ScopeForbiddenError / ScopeSnapshotNotReadyError from a handler become
//     403 / 409 with their codes, before onError, and a recorded violation
//     still wins (500).
import { describe, expect, it, vi } from "vitest";
import {
  ActionNormalizeError,
  assertValidPolicy,
  handleWithAccess,
  type AccessGateDeps,
  type AccessRequest,
  type FunctionPolicy,
} from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES } from "../../supabase/functions/_shared/access/errors.ts";
import { authorizeAction, buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  ALL_SCOPE_SQL,
  ScopeForbiddenError,
  ScopeSnapshotNotReadyError,
  assertKeyPathInScope,
  cohortsFrom,
  scopePaths,
  txFrom,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  COHORT_SNAPSHOT_NAME,
  type CohortSnapshotState,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import { createRecordingClickHouse } from "./support/recordingClickHouse.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CRON_SECRET = "cron-secret-value";
const NOW = new Date("2026-10-06T12:00:00.000Z");

type Action = "cohort_read" | "fb_read" | "plain_read" | "buyer_read" | "cron_tick";

const POLICY: FunctionPolicy<Action> = {
  fn: "phase2-fn",
  normalizeAction: ({ body, cron }) => {
    if (cron && body.action === undefined) return "cron_tick";
    if (typeof body.action === "string" && ["cohort_read", "fb_read", "plain_read", "buyer_read", "cron_tick"].includes(body.action)) return body.action as Action;
    throw new ActionNormalizeError();
  },
  actions: {
    cohort_read: { anyOf: ["cohorts.view"], scopeReady: true, scopeSnapshot: "cohort" },
    fb_read: { anyOf: ["facebook_analytics.view", "cohorts.view"], scopeReady: true, scopeSnapshot: "campaign" },
    plain_read: { anyOf: ["dashboard.view"], scopeReady: true },
    buyer_read: { anyOf: ["dashboard.view", "cohorts.view"], restrictedAnyOf: ["cohorts.view"], scopeReady: true, scopeSnapshot: "cohort" },
    cron_tick: { anyOf: ["admin.sync.run"], scopeReady: true, scopeSnapshot: "cohort" },
  },
  cron: { header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["cron_tick", "cohort_read"] },
};

const PASS = { status: "PASS", duplicate_users: 0, dynamic_users: 5, materialized_users: 5 };

function snapshotState(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  return {
    auth_user_id: DATA_KEY,
    snapshot_name: COHORT_SNAPSHOT_NAME,
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
    diagnostics: { validation: PASS },
    active_validation: PASS,
    active_validated_at: "2026-10-06T09:00:00.000Z",
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
    fresh_verified_at: "2026-10-06T11:52:00.000Z",
    stale_since: null,
    ...overrides,
  };
}

function accessRow(options: { userId?: string; scope?: "all" | "selected" | "none"; permissions?: string[]; isOwner?: boolean } = {}) {
  const userId = options.userId ?? EMPLOYEE;
  const scope = options.scope ?? "selected";
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
    role: { id: "role-1", key: options.isOwner ? "owner" : "media_buyer", name: "Role", is_owner: options.isOwner ?? false, permissions: options.permissions ?? ["dashboard.view", "cohorts.view", "facebook_analytics.view"] },
    funnel_scope: { mode: scope, funnel_ids: scope === "selected" ? ["f1"] : [], paths: scope === "selected" ? ["soulmate-sketch", "past-life"] : [] },
    access_version: "3",
    partition: "partition-hash",
  };
}

const OWNER_ROW = () => accessRow({ userId: DATA_KEY, scope: "all", isOwner: true, permissions: [] });

function makeDeps(options: { row?: unknown; userId?: string; state?: CohortSnapshotState | null; env?: Record<string, string> } & Partial<AccessGateDeps> = {}) {
  const { row, userId, state, env, ...rest } = options;
  const clickhouse = createRecordingClickHouse();
  const deps = {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: vi.fn(async (token: string) => ({ data: { user: { id: token === "good-token" ? userId ?? EMPLOYEE : null, email: "member@example.com" } }, error: null })),
    loadAccess: vi.fn(async (_userId: string) => ({ data: row === undefined ? accessRow({ userId: userId ?? EMPLOYEE }) : row, error: null })),
    workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
    readEnv: vi.fn((name: string) => (name === "FB_CRON_SECRET" ? CRON_SECRET : env?.[name])),
    createClickHouse: vi.fn((ctx) => createScopedReader(ctx, clickhouse)),
    newRequestId: () => "req-p2",
    log: vi.fn(),
    recordDenial: vi.fn(async () => ({ data: 1, error: null })),
    loadCohortSnapshotState: vi.fn(async (_tenantKey: string) => (state === undefined ? snapshotState() : state)),
    now: () => NOW,
    ...rest,
  };
  return { deps: deps as AccessGateDeps & typeof deps, clickhouse };
}

function request(body: unknown, options: { token?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? "good-token"}`;
  return new Request("https://edge.test/functions/v1/phase2-fn", { method: "POST", headers, body: JSON.stringify(body) });
}

function capture() {
  const seen: Array<AccessRequest<Action>> = [];
  const handler = vi.fn(async (r: AccessRequest<Action>) => {
    seen.push(r);
    return { ok: true };
  });
  return { seen, handler };
}

async function body(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

const NOT_READY_BODY = { ok: false, error_code: ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY, error: ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready };

// =========================================================================================

describe("scope handle", () => {
  it("scope all (owner and member) gets ALL_SCOPE_SQL without reading the snapshot state", async () => {
    for (const row of [OWNER_ROW(), accessRow({ scope: "all" })]) {
      const userId = row.user_id;
      const { deps } = makeDeps({ row, userId });
      const { seen, handler } = capture();
      for (const action of ["cohort_read", "fb_read", "plain_read"] as const) {
        expect((await handleWithAccess(request({ action }), POLICY, handler, deps)).status, action).toBe(200);
      }
      expect(seen.map((r) => r.scope)).toEqual([ALL_SCOPE_SQL, ALL_SCOPE_SQL, ALL_SCOPE_SQL]);
      expect(seen.every((r) => r.scope === ALL_SCOPE_SQL)).toBe(true);
      expect(deps.loadCohortSnapshotState).not.toHaveBeenCalled();
    }
  });

  it("the cron gets ALL_SCOPE_SQL and no snapshot I/O, even on a scopeSnapshot action", async () => {
    const { deps } = makeDeps();
    const { seen, handler } = capture();
    const response = await handleWithAccess(request({}, { token: null, headers: { "x-cron-secret": CRON_SECRET } }), POLICY, handler, deps);
    expect(response.status).toBe(200);
    expect(seen[0].ctx.actor.kind).toBe("cron");
    expect(seen[0].scope).toBe(ALL_SCOPE_SQL);
    expect(deps.loadCohortSnapshotState).not.toHaveBeenCalled();
  });

  it("a restricted request without scopeSnapshot gets a restricted handle with no snapshot (and no I/O)", async () => {
    const { deps } = makeDeps();
    const { seen, handler } = capture();
    expect((await handleWithAccess(request({ action: "plain_read" }), POLICY, handler, deps)).status).toBe(200);
    expect(seen[0].scope).toMatchObject({ restricted: true, snapshot: null });
    expect(scopePaths(seen[0].scope)).toEqual(["past-life", "soulmate-sketch"]);
    expect(deps.loadCohortSnapshotState).not.toHaveBeenCalled();
    // Fact-reading helpers then refuse: the action never asked for a snapshot.
    expect(() => txFrom(seen[0].scope, "a")).toThrow(ScopeSnapshotNotReadyError);
  });

  it("a restricted request on a ready snapshot gets it, loaded once for the WORKSPACE tenant", async () => {
    const { deps } = makeDeps();
    const { seen, handler } = capture();
    expect((await handleWithAccess(request({ action: "fb_read" }), POLICY, handler, deps)).status).toBe(200);
    expect(deps.loadCohortSnapshotState).toHaveBeenCalledTimes(1);
    expect(deps.loadCohortSnapshotState).toHaveBeenCalledWith(DATA_KEY);
    expect(seen[0].scope.restricted).toBe(true);
    expect(seen[0].scope.snapshot).toMatchObject({ warehouseVersion: "wh_live", classificationVersion: COHORT_CLASSIFICATION_VERSION, campaignScopeReady: true });
  });

  it("end to end: fragments built from r.scope pass the request's reader, with restricted settings", async () => {
    const { deps, clickhouse } = makeDeps();
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, async (r) => {
      const rs = await r.clickhouse().query({
        query: `SELECT count() AS c FROM ${txFrom(r.scope, "a")} INNER JOIN ${cohortsFrom(r.scope, "fc")} ON fc.canonical_user_id = a.user_id`,
        format: "JSONEachRow",
      });
      return { ok: true, rows: await rs.json() };
    }, deps);
    expect(response.status).toBe(200);
    expect(clickhouse.statements).toHaveLength(1);
    expect(clickhouse.statements[0]).toMatchObject({ params: { auth_user_id: DATA_KEY }, query_id: "sub_req-p2_1" });
    expect(clickhouse.statements[0].settings).toMatchObject({ readonly: 2, max_execution_time: 20 });
    expect(clickhouse.boundTenants()).toEqual([DATA_KEY]);
  });

  it("the probe's unscoped read is still a 500 scope_violation for a restricted member", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, async (r) => {
      await r.clickhouse().query({ query: "SELECT count() FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}" }).catch(() => null);
      return { ok: true };
    }, deps);
    expect(response.status).toBe(500);
    expect((await body(response)).error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
  });
});

describe("freshness gate (409 scope_snapshot_not_ready)", () => {
  it.each([
    ["no snapshot row", null, "no_active_snapshot"],
    ["no active versions", snapshotState({ active_warehouse_version: null }), "no_active_snapshot"],
    ["an old classifier", snapshotState({ active_classification_version: "cohort_classifier_v2" }), "classification_mismatch"],
    ["an unvalidated active build", snapshotState({ active_validation: { status: "FAIL" } }), "not_validated"],
    ["duplicate users", snapshotState({ duplicate_users: 4 }), "not_validated"],
    ["a stale verification", snapshotState({ fresh_verified_at: "2026-10-06T05:00:00.000Z" }), "stale"],
    ["no verification", snapshotState({ fresh_verified_at: null }), "stale"],
  ] as const)("refuses %s with zero ClickHouse statements; the reason is only logged", async (_label, state, reason) => {
    const { deps, clickhouse } = makeDeps({ state: state as CohortSnapshotState | null });
    const { handler } = capture();
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, handler, deps);
    expect(response.status).toBe(409);
    expect(await body(response)).toEqual(NOT_READY_BODY);
    expect(response.headers.get("x-request-id")).toBe("req-p2");
    expect(handler).not.toHaveBeenCalled();
    expect(clickhouse.statements).toEqual([]);
    expect(deps.createClickHouse).not.toHaveBeenCalled();
    expect(deps.recordDenial).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith("warn", "access_denied", expect.objectContaining({ status: 409, error_code: ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY, reason }));
  });

  it("FB actions also need the campaign scope; cohort actions do not", async () => {
    const state = snapshotState({ active_campaign_scope_version: null });
    const fb = makeDeps({ state });
    const { handler } = capture();
    const refused = await handleWithAccess(request({ action: "fb_read" }), POLICY, handler, fb.deps);
    expect(refused.status).toBe(409);
    expect(fb.deps.log).toHaveBeenCalledWith("warn", "access_denied", expect.objectContaining({ reason: "campaign_scope_missing" }));

    const cohort = makeDeps({ state });
    const ok = capture();
    expect((await handleWithAccess(request({ action: "cohort_read" }), POLICY, ok.handler, cohort.deps)).status).toBe(200);
    expect(ok.seen[0].scope.snapshot?.campaignScopeReady).toBe(false);
  });

  it("a rebuild in progress or a failed rebuild does not 409 while the active snapshot is valid", async () => {
    for (const status of ["building", "failed"] as const) {
      const { deps } = makeDeps({ state: snapshotState({ status, diagnostics: {}, building_warehouse_version: "wh_next" }) });
      const { seen, handler } = capture();
      expect((await handleWithAccess(request({ action: "fb_read" }), POLICY, handler, deps)).status, status).toBe(200);
      expect(seen[0].scope.snapshot?.warehouseVersion).toBe("wh_live");
    }
  });

  it("SCOPE_SNAPSHOT_MAX_STALENESS_HOURS sets the bound; an invalid value falls back to 6 h", async () => {
    const twoHoursOld = snapshotState({ fresh_verified_at: "2026-10-06T10:00:00.000Z" });
    const cases: Array<[Record<string, string> | undefined, number]> = [
      [{ SCOPE_SNAPSHOT_MAX_STALENESS_HOURS: "1" }, 409],
      [{ SCOPE_SNAPSHOT_MAX_STALENESS_HOURS: "3" }, 200],
      [{ SCOPE_SNAPSHOT_MAX_STALENESS_HOURS: "not-a-number" }, 200],
      [{ SCOPE_SNAPSHOT_MAX_STALENESS_HOURS: "0" }, 200],
      [undefined, 200],
    ];
    for (const [env, status] of cases) {
      const { deps } = makeDeps({ state: twoHoursOld, env });
      expect((await handleWithAccess(request({ action: "cohort_read" }), POLICY, capture().handler, deps)).status, JSON.stringify(env)).toBe(status);
    }
    const sevenHoursOld = makeDeps({ state: snapshotState({ fresh_verified_at: "2026-10-06T05:00:00.000Z" }), env: { SCOPE_SNAPSHOT_MAX_STALENESS_HOURS: "bogus" } });
    expect((await handleWithAccess(request({ action: "cohort_read" }), POLICY, capture().handler, sevenHoursOld.deps)).status).toBe(409);
  });

  it("uses the injected clock", async () => {
    const { deps } = makeDeps({ now: () => new Date("2026-10-07T12:00:00.000Z") });
    expect((await handleWithAccess(request({ action: "cohort_read" }), POLICY, capture().handler, deps)).status).toBe(409);
  });

  it.each([
    ["a missing loader", { loadCohortSnapshotState: undefined }],
    ["a throwing loader", { loadCohortSnapshotState: vi.fn(async () => { throw new Error("pg down"); }) }],
    ["a loader returning {error}", { loadCohortSnapshotState: vi.fn(async () => ({ error: { message: "denied" } }) as unknown as CohortSnapshotState) }],
  ])("%s is 503 access_service_error (R2), never a pass", async (_label, override) => {
    const { deps, clickhouse } = makeDeps(override as Partial<AccessGateDeps>);
    const { handler } = capture();
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, handler, deps);
    expect(response.status).toBe(503);
    expect(await body(response)).toEqual({ ok: false, error_code: ACCESS_ERROR.ACCESS_SERVICE_ERROR, error: ACCESS_ERROR_MESSAGES.access_service_error });
    expect(handler).not.toHaveBeenCalled();
    expect(clickhouse.statements).toEqual([]);
  });
});

describe("restrictedAnyOf", () => {
  it("restricted members need one of its keys on top of anyOf", async () => {
    const without = makeDeps({ row: accessRow({ permissions: ["dashboard.view"] }) });
    const { handler } = capture();
    const refused = await handleWithAccess(request({ action: "buyer_read" }), POLICY, handler, without.deps);
    expect(refused.status).toBe(403);
    expect(await body(refused)).toEqual({ ok: false, error_code: ACCESS_ERROR.SCOPE_NOT_SUPPORTED, error: ACCESS_ERROR_MESSAGES.scope_not_supported });
    expect(without.deps.loadCohortSnapshotState).not.toHaveBeenCalled();
    expect(without.deps.recordDenial).toHaveBeenCalledWith(expect.objectContaining({ action: "buyer_read", errorCode: ACCESS_ERROR.SCOPE_NOT_SUPPORTED }));

    const withKey = makeDeps({ row: accessRow({ permissions: ["dashboard.view", "cohorts.view"] }) });
    expect((await handleWithAccess(request({ action: "buyer_read" }), POLICY, capture().handler, withKey.deps)).status).toBe(200);
  });

  it("does not apply to scope-all members", async () => {
    const { deps } = makeDeps({ row: accessRow({ scope: "all", permissions: ["dashboard.view"] }) });
    expect((await handleWithAccess(request({ action: "buyer_read" }), POLICY, capture().handler, deps)).status).toBe(200);
  });

  it("authorizeAction: permission first, then scope, then restrictedAnyOf", () => {
    const contextFor = (scope: "all" | "selected", permissions: string[]) =>
      buildAccessContext(parseResolveAccessRow(accessRow({ scope, permissions }))!, { kind: "user", userId: EMPLOYEE }, "r");
    const policy = POLICY.actions.buyer_read;
    expect(authorizeAction(contextFor("selected", ["facebook_analytics.view"]), policy)?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
    expect(authorizeAction(contextFor("selected", ["dashboard.view"]), policy)?.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(authorizeAction(contextFor("selected", ["cohorts.view"]), policy)).toBeNull();
    expect(authorizeAction(contextFor("all", ["dashboard.view"]), policy)).toBeNull();
    expect(authorizeAction(contextFor("selected", ["cohorts.view"]), { anyOf: ["cohorts.view"], restrictedAnyOf: [], scopeReady: true })?.error_code)
      .toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
  });
});

describe("scope refusals raised inside the handler", () => {
  it("an explicit out-of-scope key is 403 funnel_out_of_scope before any SQL, coded, not sanitized, onError not consulted", async () => {
    const { deps, clickhouse } = makeDeps();
    const onError = vi.fn(() => ({ status: 400, body: { ok: false, error: "mapped" } }));
    const response = await handleWithAccess(request({ action: "cohort_read", cohort_key: { campaign_path: "other-funnel" } }), POLICY, async (r) => {
      assertKeyPathInScope(r.scope, (r.body.cohort_key as { campaign_path: string }).campaign_path);
      await r.clickhouse().query({ query: "SELECT 1" });
      return { ok: true };
    }, deps, { onError });
    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({ ok: false, error_code: "funnel_out_of_scope", error: ACCESS_ERROR_MESSAGES.funnel_out_of_scope, request_id: "req-p2" });
    expect(clickhouse.statements).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("ScopeForbiddenError(scope_not_supported) is 403 and ScopeSnapshotNotReadyError is 409", async () => {
    const forbidden = makeDeps();
    const notSupported = await handleWithAccess(request({ action: "fb_read" }), POLICY, async () => { throw new ScopeForbiddenError("scope_not_supported"); }, forbidden.deps);
    expect(notSupported.status).toBe(403);
    expect(await body(notSupported)).toEqual({ ok: false, error_code: "scope_not_supported", error: ACCESS_ERROR_MESSAGES.scope_not_supported, request_id: "req-p2" });

    const pending = makeDeps();
    const notReady = await handleWithAccess(request({ action: "cohort_read" }), POLICY, async () => { throw new ScopeSnapshotNotReadyError("snapshot_missing"); }, pending.deps);
    expect(notReady.status).toBe(409);
    expect(await body(notReady)).toEqual({ ...NOT_READY_BODY, request_id: "req-p2" });
    expect(pending.deps.log).toHaveBeenCalledWith("warn", "access_denied", expect.objectContaining({ status: 409, reason: "snapshot_missing" }));
  });

  it("the data owner gets the same coded bodies (no raw message to fall back to)", async () => {
    const { deps } = makeDeps({ row: OWNER_ROW(), userId: DATA_KEY });
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, async () => { throw new ScopeSnapshotNotReadyError("stale"); }, deps);
    expect(response.status).toBe(409);
    expect((await body(response)).error_code).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
  });

  it("a recorded violation still wins over a scope refusal (500)", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, async (r) => {
      await r.clickhouse().query({ query: "SELECT * FROM fact_user_cohorts" }).catch(() => null);
      throw new ScopeForbiddenError("funnel_out_of_scope");
    }, deps);
    expect(response.status).toBe(500);
    expect((await body(response)).error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
  });

  it("other errors keep the Phase-1 mapping (502 generic for members)", async () => {
    const { deps } = makeDeps();
    const response = await handleWithAccess(request({ action: "cohort_read" }), POLICY, async () => { throw new Error("ClickHouse HTTP 500: secret detail"); }, deps);
    expect(response.status).toBe(502);
    expect(await body(response)).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-p2" });
  });
});

describe("policy validation", () => {
  const base = (actions: FunctionPolicy<string>["actions"]): FunctionPolicy<string> => ({ fn: "f", normalizeAction: () => "a", actions });

  it("rejects scopeSnapshot without scopeReady, an unknown snapshot kind and a malformed restrictedAnyOf", () => {
    expect(() => assertValidPolicy(base({ a: { anyOf: ["cohorts.view"], scopeSnapshot: "cohort" } }))).toThrow(/scopeSnapshot without scopeReady/);
    expect(() => assertValidPolicy(base({ a: { anyOf: ["cohorts.view"], scopeReady: false, scopeSnapshot: "campaign" } }))).toThrow(/scopeSnapshot without scopeReady/);
    expect(() => assertValidPolicy(base({ a: { scopeReady: true, scopeSnapshot: "users" as "cohort" } }))).toThrow(/unknown scopeSnapshot/);
    expect(() => assertValidPolicy(base({ a: { scopeReady: true, restrictedAnyOf: "cohorts.view" as unknown as string[] } }))).toThrow(/restrictedAnyOf/);
    expect(() => assertValidPolicy(base({ a: { scopeReady: true, restrictedAnyOf: [""] } }))).toThrow(/restrictedAnyOf/);
  });

  it("accepts the Phase-2 shapes", () => {
    expect(() => assertValidPolicy(POLICY)).not.toThrow();
    expect(() => assertValidPolicy(base({ a: { anyOf: ["cohorts.view"], scopeReady: true, scopeSnapshot: "campaign", restrictedAnyOf: ["cohorts.view"] } }))).not.toThrow();
  });
});

describe("error vocabulary", () => {
  it("adds the two Phase-2 codes with safe messages", () => {
    expect(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY).toBe("scope_snapshot_not_ready");
    expect(ACCESS_ERROR.FUNNEL_OUT_OF_SCOPE).toBe("funnel_out_of_scope");
    expect(ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready).toBe("Funnel-scoped data is being prepared. Please retry in a few minutes.");
    expect(ACCESS_ERROR_MESSAGES.funnel_out_of_scope).toBe("This funnel is outside your funnel access.");
    for (const text of [ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready, ACCESS_ERROR_MESSAGES.funnel_out_of_scope]) {
      expect(text).not.toMatch(/unavailable|timeout|timed out|network|connection/i);
    }
  });
});
