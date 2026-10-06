// Funnel-restricted Facebook reads (access Phase 2, spec §4 rows
// "clickhouse-facebook *" and "Cohorts FB columns").
//
// Every runner is driven through a REAL ScopedReader bound to a restricted
// context, over a recording transport, so a statement that touched a protected
// table outside a registered scope fragment would be a ScopeViolation here
// exactly as in production. What must hold:
//   * restricted FB reads are V1 fact_facebook_stats of the member's visible
//     campaigns (fact_campaign_scope resolved ∩ their paths), campaign / adset /
//     ad level only — never the V2 views, whatever the flag says;
//   * the blended transaction metrics and the mapping block read the member's
//     users only (txFrom);
//   * account / day levels and a missing campaign scope are refused before ANY
//     statement; an empty scope renders the predicate `0`;
//   * the Cohorts FB columns degrade to "unavailable" without a single FB query
//     when no campaign scope is built, report campaign_not_visible for users of
//     hidden campaigns, and skip the raw-payload source classification.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../../supabase/functions/_shared/access/accessContext.ts";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors.ts";
import { handleWithAccess, type AccessGateDeps, type AccessHandler } from "../../supabase/functions/_shared/access/gate.ts";
import {
  CLICKHOUSE_FACEBOOK_POLICY,
  type ClickHouseFacebookAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-facebook.ts";
import {
  ALL_SCOPE_SQL,
  ScopeForbiddenError,
  ScopeSnapshotNotReadyError,
  createRestrictedScopeSql,
  maskScopeFragments,
  sqlStringLiteral,
  type ScopeSql,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  COHORT_SNAPSHOT_NAME,
  type CohortSnapshotState,
  type ScopeSnapshot,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import { PROTECTED_TABLE_PATTERN, ScopeViolation, createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  buildFbDiagnostics,
  normalizeFbFilters,
  runFbCharts,
  runFbFilterOptions,
  runFbList,
  runFbReport,
  type FbLevel,
  type FbReadRequest,
} from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import { computeFbCohortStats, fbCohortRowKey } from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse, type ClickHouseResponder, type RecordedStatement } from "./support/recordingClickHouse.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const BUYER = "22222222-2222-4222-8222-222222222222";
const WH = "wh_fb_scope";
const PATHS = ["past-life", "soulmate-sketch"];
const SENTINEL_SPEND = 987654.32;
const NOW = new Date("2026-10-06T12:00:00.000Z");

type Mode = "all" | "selected" | "none";

function accessRow(mode: Mode, paths: string[] = PATHS) {
  return {
    status: "ok",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: BUYER,
    email: "buyer@example.com",
    display_name: "Buyer",
    is_data_owner: false,
    raw_access: false,
    role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: ["dashboard.view", "cohorts.view", "facebook_analytics.view", "funnels.view"] },
    funnel_scope: { mode, funnel_ids: mode === "selected" ? ["f1"] : [], paths: mode === "selected" ? paths : [] },
    access_version: "4",
    partition: "partition-hash",
  };
}

function context(mode: Mode, paths: string[] = PATHS): AccessContext {
  const row = parseResolveAccessRow(accessRow(mode, paths));
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId: BUYER, email: "buyer@example.com" }, `req-fb-${mode}`);
}

function snapshot(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    warehouseVersion: WH,
    classificationVersion: COHORT_CLASSIFICATION_VERSION,
    campaignScopeReady: true,
    freshVerifiedAt: "2026-10-06T11:50:00.000Z",
    staleSince: null,
    state: {} as CohortSnapshotState,
    ...overrides,
  };
}

const SYNC_STATE = {
  sync_name: "fact_facebook_stats_sync",
  status: "completed",
  cursor_transaction_id: "2026-10-05",
  cursor_updated_at: "2026-10-05T09:00:00.000Z",
  finished_at: "2026-10-05T10:00:00.000Z",
  clickhouse_total: 123456,
  diagnostics: { mode: "incremental", fb_stats_to: "2026-10-05", day_spend_total: SENTINEL_SPEND },
};

function syncStateSupabase(state: Record<string, unknown> | null = SYNC_STATE): SupabaseLikeClient {
  return {
    from() {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) builder[method] = () => builder;
      builder.maybeSingle = async () => ({ data: state, error: null });
      return builder as never;
    },
  };
}

/** A restricted request's reader + handle, over a recording transport. */
function restricted(options: { mode?: Mode; paths?: string[]; snapshot?: ScopeSnapshot | null; responder?: ClickHouseResponder } = {}) {
  const ctx = context(options.mode ?? "selected", options.paths);
  const scope = createRestrictedScopeSql(ctx, options.snapshot === undefined ? snapshot() : options.snapshot);
  const recording = createRecordingClickHouse(options.responder);
  const reader = createScopedReader(ctx, recording);
  return { ctx, scope, recording, reader };
}

const L = sqlStringLiteral;
const PATHS_PREDICATE = `campaign_path IN (${L("past-life")}, ${L("soulmate-sketch")})`;
const VISIBLE = `SELECT campaign_id FROM fact_campaign_scope FINAL WHERE auth_user_id = {auth_user_id:String}` +
  ` AND warehouse_version = ${L(WH)} AND classification_version = ${L(COHORT_CLASSIFICATION_VERSION)}` +
  ` AND scope_version = ${L(CAMPAIGN_SCOPE_VERSION)} AND status = 'resolved' AND ${PATHS_PREDICATE}`;
const FB_FRAGMENT_HEAD = "(SELECT auth_user_id, stat_date, level, ";
const FB_FRAGMENT_TAIL = ` FROM fact_facebook_stats FINAL WHERE auth_user_id = {auth_user_id:String} AND level IN ('campaign','adset','ad') AND trim(BOTH ' ' FROM campaign_id) IN (${VISIBLE}))`;
const SCOPED_USERS = `SELECT canonical_user_id FROM fact_user_cohorts FINAL WHERE auth_user_id = {auth_user_id:String}` +
  ` AND warehouse_version = ${L(WH)} AND classification_version = ${L(COHORT_CLASSIFICATION_VERSION)}` +
  ` AND ${PATHS_PREDICATE} AND NOT startsWith(canonical_user_id, 'unknown_user_')`;
const TX_FRAGMENT_TAIL = ` FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String} AND user_id IN (${SCOPED_USERS}))`;

/** Nothing protected is left once THIS context's fragments are masked. */
function expectOnlyFragments(ctx: AccessContext, statements: readonly RecordedStatement[]) {
  expect(statements.length).toBeGreaterThan(0);
  for (const statement of statements) {
    const masked = maskScopeFragments(ctx, statement.query);
    expect(PROTECTED_TABLE_PATTERN.exec(masked)?.[0] ?? null, statement.query.slice(0, 200)).toBeNull();
    expect(masked, "every statement reads through a fragment").toContain("__sf__");
    expect(statement.query).not.toMatch(/\bv_fb_\w+/);
    // Restricted capacity settings ride on every read (ScopedReader).
    expect(statement.settings).toMatchObject({ readonly: 2, max_execution_time: 20 });
    expect(statement.query_id).toMatch(/^sub_req-fb-/);
    expect(statement.params.auth_user_id).toBe(DATA_KEY);
  }
  expect(ctx.violations).toEqual([]);
}

const REQUEST = (level: FbLevel, extra: Partial<FbReadRequest> = {}): FbReadRequest => ({
  action: "report",
  level,
  filters: { date_from: "2026-09-01", date_to: "2026-09-30", buyer: ["Alice"], ad_account_id: ["act_1"], campaign_id: ["c_1"] },
  ...extra,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restricted FB warehouse reads", () => {
  it.each(["campaign", "adset", "ad"] as const)("report at %s level reads only registered fragments (V1, visible campaigns)", async (level) => {
    const { ctx, scope, recording, reader } = restricted();
    const report = await runFbReport({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST(level), scope });
    expect(report.ok).toBe(true);
    expect(report.level).toBe(level);
    expectOnlyFragments(ctx, recording.statements);
    const fbReads = recording.statements.filter((statement) => statement.query.includes("FROM fact_facebook_stats FINAL"));
    // list, charts, three option lists, date range, summary, two diagnostics, mapping
    expect(fbReads.length).toBe(10);
    for (const statement of fbReads) {
      expect(statement.query).toContain(FB_FRAGMENT_HEAD);
      expect(statement.query).toContain(FB_FRAGMENT_TAIL);
    }
    // Buyer / account / campaign filters stay ANDed on top of the visible set.
    const list = recording.statements.find((statement) => statement.query.includes("argMax(adset_name, stat_date) adset_name"))!;
    expect(list.params).toMatchObject({ level, p_buyer_0: "Alice", p_acct_0: "act_1", p_camp_0: "c_1" });
  });

  it("the V2 flag and v2_preview never switch a restricted read to the V2 views", async () => {
    vi.stubEnv("FB_WAREHOUSE_V2_READS", "true");
    const { ctx, scope, recording, reader } = restricted();
    await runFbReport({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("adset", { v2_preview: true }), scope });
    await runFbList(reader, DATA_KEY, REQUEST("ad", { v2_preview: true }), scope);
    expectOnlyFragments(ctx, recording.statements);
    // Sanity: the owner's reads DO switch under the same flag.
    const owner = createRecordingClickHouse();
    await runFbList(owner, DATA_KEY, REQUEST("adset"), ALL_SCOPE_SQL);
    expect(owner.statements[0].query).toMatch(/\bv_fb_\w+/);
  });

  it("blended metrics and the mapping block count the member's users only", async () => {
    const { ctx, scope, recording, reader } = restricted();
    await runFbReport({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("campaign"), scope });
    expectOnlyFragments(ctx, recording.statements);
    const txReads = recording.statements.filter((statement) => statement.query.includes("FROM analytics_transactions FINAL"));
    expect(txReads.length).toBe(2); // the list's blend join + the mapping summary
    for (const statement of txReads) expect(statement.query).toContain(TX_FRAGMENT_TAIL);
    const mapping = recording.statements.find((statement) => statement.query.includes("fbc AS (SELECT DISTINCT campaign_id"))!;
    expect(mapping.query.split(TX_FRAGMENT_TAIL).length - 1).toBe(4);
    expect(mapping.query).not.toMatch(/analytics_transactions FINAL\s+WHERE auth_user_id = \{auth_user_id:String\} AND campaign_id/);
  });

  it("list / charts / filters / status run alone through fragments too", async () => {
    const { ctx, scope, recording, reader } = restricted();
    await runFbList(reader, DATA_KEY, REQUEST("campaign"), scope);
    await runFbCharts(reader, DATA_KEY, { action: "charts", level: "ad" }, scope);
    await runFbFilterOptions(reader, DATA_KEY, REQUEST("campaign"), scope);
    await buildFbDiagnostics({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, level: "adset", filters: normalizeFbFilters(REQUEST("adset")), scope });
    expectOnlyFragments(ctx, recording.statements);
    expect(recording.statements).toHaveLength(1 + 1 + 4 + 2);
  });

  it("status diagnostics describe the visible scope (rows, dates, completeness)", async () => {
    const { scope, reader } = restricted({
      responder: (statement) => {
        if (statement.query.startsWith("SELECT count() c, toString(min(stat_date))")) return [{ c: "42", date_min: "2026-09-01", date_max: "2026-10-05" }];
        if (statement.query.startsWith("SELECT count() c FROM")) return [{ c: "7" }];
        return [];
      },
    });
    const diagnostics = await buildFbDiagnostics({
      clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, level: "campaign", filters: normalizeFbFilters({}), today: "2026-10-06", scope,
    });
    expect(diagnostics).toMatchObject({ warehouse_rows: 42, warehouse_rows_in_scope: 7, date_min: "2026-09-01", date_max: "2026-10-05", report_complete: true });
    expect(JSON.stringify(diagnostics)).not.toContain("123456");
  });

  it.each(["account", "day"] as const)("level %s → scope_not_supported before any statement", async (level) => {
    const { scope, recording, reader } = restricted();
    const refusals = [
      runFbReport({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST(level), scope }),
      runFbList(reader, DATA_KEY, REQUEST(level), scope),
      // A filter would read the campaign level, but the REQUESTED level decides.
      runFbCharts(reader, DATA_KEY, REQUEST(level), scope),
      runFbCharts(reader, DATA_KEY, { action: "charts", level }, scope),
      buildFbDiagnostics({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, level, filters: normalizeFbFilters({}), scope }),
    ].map((refusal) => refusal.then(() => null, (caught: unknown) => caught));
    for (const error of await Promise.all(refusals)) {
      expect(error).toBeInstanceOf(ScopeForbiddenError);
      expect((error as ScopeForbiddenError).code).toBe("scope_not_supported");
    }
    expect(recording.statements).toEqual([]);
  });

  it("no campaign scope (or no snapshot) → ScopeSnapshotNotReadyError before any statement", async () => {
    for (const [handleSnapshot, reason] of [[snapshot({ campaignScopeReady: false }), "campaign_scope_missing"], [null, "snapshot_missing"]] as const) {
      const { scope, recording, reader } = restricted({ snapshot: handleSnapshot });
      const refusals = [
        runFbReport({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("campaign"), scope }),
        runFbList(reader, DATA_KEY, REQUEST("campaign"), scope),
        runFbCharts(reader, DATA_KEY, REQUEST("campaign"), scope),
        runFbFilterOptions(reader, DATA_KEY, REQUEST("campaign"), scope),
        buildFbDiagnostics({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, level: "campaign", filters: normalizeFbFilters({}), scope }),
      ].map((refusal) => refusal.then(() => null, (caught: unknown) => caught));
      for (const error of await Promise.all(refusals)) {
        expect(error).toBeInstanceOf(ScopeSnapshotNotReadyError);
        expect((error as ScopeSnapshotNotReadyError).reason).toBe(reason);
      }
      expect(recording.statements).toEqual([]);
    }
  });

  it.each([
    ["mode none", { mode: "none" as Mode }],
    ["no scopable path", { mode: "selected" as Mode, paths: ["Not_Canonical", "unknown"] }],
  ])("an empty scope (%s) renders the predicate 0 and returns no rows", async (_label, options) => {
    const { ctx, scope, recording, reader } = restricted(options);
    const report = await runFbReport({ clickhouse: reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("campaign"), scope });
    expectOnlyFragments(ctx, recording.statements);
    for (const statement of recording.statements.filter((candidate) => candidate.query.includes("fact_facebook_stats FINAL"))) {
      expect(statement.query).toContain("AND status = 'resolved' AND 0)");
      expect(statement.query).not.toContain("campaign_path IN (");
    }
    for (const statement of recording.statements.filter((candidate) => candidate.query.includes("analytics_transactions FINAL"))) {
      expect(statement.query).toContain("AND 0 AND NOT startsWith(canonical_user_id, 'unknown_user_')");
    }
    expect(report.rows).toEqual([]);
    expect(report.summary).toMatchObject({ spend: 0, campaigns: 0, blended: { trial_users: 0, tx_net_revenue: 0 } });
  });

  it("unknown body keys (search) change no recorded SQL", async () => {
    const plain = restricted();
    await runFbReport({ clickhouse: plain.reader, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("campaign"), scope: plain.scope });
    const searched = restricted();
    await runFbReport({
      clickhouse: searched.reader, supabase: syncStateSupabase(), authUserId: DATA_KEY,
      request: { ...REQUEST("campaign"), search: "soulmate%' OR 1=1", filters: { ...REQUEST("campaign").filters, search: "x" } } as FbReadRequest,
      scope: searched.scope,
    });
    const shape = (statements: readonly RecordedStatement[]) => statements.map((statement) => [statement.query, statement.params]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(shape(searched.recording.statements)).toEqual(shape(plain.recording.statements));
  });

  it("the owner's reads are identical with or without an explicit ALL_SCOPE_SQL", async () => {
    const implicit = createRecordingClickHouse();
    const explicit = createRecordingClickHouse();
    await runFbReport({ clickhouse: implicit, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("adset") });
    await runFbReport({ clickhouse: explicit, supabase: syncStateSupabase(), authUserId: DATA_KEY, request: REQUEST("adset"), scope: ALL_SCOPE_SQL });
    expect(explicit.statements).toEqual(implicit.statements);
    for (const level of ["account", "day"] as const) {
      await expect(runFbList(createRecordingClickHouse(), DATA_KEY, REQUEST(level), ALL_SCOPE_SQL)).resolves.toMatchObject({ level });
    }
  });
});

// ---- through the gate --------------------------------------------------------------

describe("restricted FB reads through the gate", () => {
  const PASS = { status: "PASS", duplicate_users: 0, dynamic_users: 5, materialized_users: 5 };
  const READY_STATE: CohortSnapshotState = {
    auth_user_id: DATA_KEY, snapshot_name: COHORT_SNAPSHOT_NAME, status: "building",
    active_warehouse_version: WH, active_classification_version: COHORT_CLASSIFICATION_VERSION, active_generated_at: "2026-10-06T09:00:00.000Z",
    building_warehouse_version: "wh_next", building_classification_version: COHORT_CLASSIFICATION_VERSION,
    started_at: "2026-10-06T11:59:00.000Z", finished_at: "2026-10-06T09:00:00.000Z", duration_ms: 1, users_classified: 5, rows_inserted: 5,
    duplicate_users: 0, removed_or_invalidated: 0, source_transactions: 50, source_unique_users: 5, last_error: null,
    diagnostics: {}, active_validation: PASS, active_validated_at: "2026-10-06T09:00:00.000Z",
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION, fresh_verified_at: "2026-10-06T11:52:00.000Z", stale_since: null,
  };

  function gate(options: { state?: CohortSnapshotState | null; mode?: Mode } = {}) {
    const recording = createRecordingClickHouse();
    const deps: AccessGateDeps = {
      configError: null,
      pg: { ...syncStateSupabase(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
      getUser: vi.fn(async () => ({ data: { user: { id: BUYER, email: "buyer@example.com" } }, error: null })),
      loadAccess: vi.fn(async () => ({ data: accessRow(options.mode ?? "selected"), error: null })),
      workspaceDataKey: vi.fn(async () => ({ data: DATA_KEY, error: null })),
      readEnv: () => undefined,
      createClickHouse: (ctx: AccessContext) => createScopedReader(ctx, recording),
      newRequestId: () => "req-gate-fb",
      log: vi.fn(),
      loadCohortSnapshotState: vi.fn(async () => (options.state === undefined ? READY_STATE : options.state)),
      now: () => NOW,
    };
    return { deps, recording };
  }

  // The router's read path for these actions (supabase/functions/clickhouse-facebook/index.ts).
  const handler: AccessHandler<ClickHouseFacebookAction> = async ({ ctx, body, pg, clickhouse, scope }) => {
    if (body.probe === "unscoped") {
      await clickhouse().query({ query: "SELECT sum(spend) FROM fact_facebook_stats FINAL WHERE auth_user_id = {auth_user_id:String}", format: "JSONEachRow" });
    }
    return runFbReport({ clickhouse: clickhouse(), supabase: pg, authUserId: ctx.tenantKey, request: body as FbReadRequest, scope: scope as ScopeSql });
  };

  async function call(body: Record<string, unknown>, options: { state?: CohortSnapshotState | null; mode?: Mode } = {}) {
    const { deps, recording } = gate(options);
    const req = new Request("https://edge.test/functions/v1/clickhouse-facebook", {
      method: "POST",
      headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const response = await handleWithAccess(req, CLICKHOUSE_FACEBOOK_POLICY, handler, deps);
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, recording };
  }

  it("a campaign-level report succeeds on the active snapshot (even while a rebuild is in progress)", async () => {
    const result = await call({ action: "report", level: "campaign" });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.recording.statements.length).toBeGreaterThan(0);
    for (const statement of result.recording.statements) {
      if (statement.query.includes("fact_facebook_stats")) expect(statement.query).toContain(`warehouse_version = ${L(WH)}`);
      expect(statement.query).not.toContain("wh_next");
    }
  });

  it.each(["account", "day"])("level %s → 403 scope_not_supported with zero statements", async (level) => {
    const result = await call({ action: "report", level });
    expect(result.status).toBe(403);
    expect(result.body).toMatchObject({ ok: false, error_code: ACCESS_ERROR.SCOPE_NOT_SUPPORTED });
    expect(result.recording.statements).toEqual([]);
  });

  it("no campaign scope for the active snapshot → 409 with zero statements", async () => {
    const result = await call({ action: "report", level: "campaign" }, { state: { ...READY_STATE, active_campaign_scope_version: null } });
    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({ ok: false, error_code: ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY });
    expect(result.recording.statements).toEqual([]);
  });

  it("an unscoped fact_facebook_stats read is a 500 scope_violation, never data", async () => {
    const result = await call({ action: "report", level: "campaign", probe: "unscoped" });
    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({ ok: false, error_code: ACCESS_ERROR.SCOPE_VIOLATION });
    expect(result.recording.statements).toEqual([]);
  });
});

// ---- Cohorts FB columns --------------------------------------------------------------

describe("Cohorts FB columns for a restricted member (computeFbCohortStats)", () => {
  const DATE = "2026-09-10";
  const NO_FILTERS: CohortFilters = {
    funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
    media_buyer: [], country: [], card_type: [], platform: [], currency: [], transaction_type: [], refund_status: "all",
  };
  const VISIBLE_ROWS = [
    { cohort_date: DATE, funnel: "soulmate", campaign_path: "soulmate-sketch" },
    { cohort_date: DATE, funnel: "past_life", campaign_path: "past-life" },
  ];
  const KEY_A = fbCohortRowKey(DATE, "soulmate", "soulmate-sketch");
  const KEY_B = fbCohortRowKey(DATE, "past_life", "past-life");

  /** A warehouse answering by statement shape: c_vis is visible, c_mixed is not. */
  const responder: ClickHouseResponder = (statement) => {
    const sql = statement.query;
    if (sql.includes("authoritative_user_count")) {
      return [
        { cohort_date: DATE, funnel: "soulmate", campaign_path: "soulmate-sketch", campaign_id: "c_vis", authoritative_user_count: "2" },
        { cohort_date: DATE, funnel: "soulmate", campaign_path: "soulmate-sketch", campaign_id: "c_mixed", authoritative_user_count: "1" },
        { cohort_date: DATE, funnel: "past_life", campaign_path: "past-life", campaign_id: "c_mixed", authoritative_user_count: "3" },
      ];
    }
    if (sql.includes("snapshot_rows")) return [{ snapshot_rows: "6", snapshot_unique_users: "6", snapshot_duplicate_users: "0" }];
    if (sql.includes("invalid_metric_rows")) {
      return [
        { campaign_id: "c_vis", ad_account_id: "act_1", currency: "USD", currency_count: 1, ad_account_count: 1, period_date_from: DATE, period_date_to: DATE, spend: 100, purchases: 2 },
        // A warehouse that leaked a hidden campaign anyway must still not allocate it.
        { campaign_id: "c_mixed", ad_account_id: "act_1", currency: "USD", currency_count: 1, ad_account_count: 1, period_date_from: DATE, period_date_to: DATE, spend: SENTINEL_SPEND, purchases: 4 },
      ];
    }
    if (sql.includes("raw_rows")) return [{ raw_rows: "30", campaign_day_rows: "30", last_stat_date: "2026-10-05" }];
    if (sql.startsWith("SELECT campaign_id FROM (SELECT campaign_id FROM fact_campaign_scope")) return [{ campaign_id: "c_vis" }];
    return [];
  };

  const run = (scope: ScopeSql, clickhouse: ReturnType<typeof createScopedReader>, extra: Record<string, unknown> = {}) =>
    computeFbCohortStats({
      clickhouse,
      supabase: syncStateSupabase(),
      authUserId: DATA_KEY,
      active: { warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION },
      filters: NO_FILTERS,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      visibleKeys: new Set([KEY_A, KEY_B]),
      visibleRows: VISIBLE_ROWS,
      today: "2026-10-06",
      timezoneConfig: { defaultTimezone: "UTC" },
      scope,
      ...extra,
    });

  it("without a built campaign scope: unavailable, and not a single statement", async () => {
    const { scope, recording, reader } = restricted({ snapshot: snapshot({ campaignScopeReady: false }), responder });
    const bundle = await run(scope, reader);
    expect(bundle.diagnostics).toMatchObject({ fb_data_status: "unavailable", fb_error_code: "FB_ALLOCATION_UNAVAILABLE", fb_allocation_diagnostics_enabled: false });
    expect(bundle.perRow).toEqual({});
    expect(bundle.allocationDiagnostics).toBeNull();
    expect(recording.statements).toEqual([]);
  });

  it("reads the member's users and visible campaigns only, and skips the raw-payload source classification", async () => {
    const { ctx, scope, recording, reader } = restricted({ responder });
    await run(scope, reader);
    expectOnlyFragments(ctx, recording.statements);
    const queries = recording.statements.map((statement) => statement.query);
    expect(queries).toHaveLength(5); // groups, uniqueness, metrics, source stats, visible ids
    expect(queries.join("\n")).not.toMatch(/trial_signals|normalized_payload|fb_campaigns AS/);
    const groups = queries.find((sql) => sql.includes("authoritative_user_count"))!;
    expect(groups).toContain(`FROM (SELECT auth_user_id, canonical_user_id, cohort_date`);
    expect(groups).toContain(` AS fc\n  WHERE`);
    expect(queries.find((sql) => sql.includes("snapshot_rows"))).toContain(`FROM (SELECT auth_user_id, canonical_user_id`);
    const metrics = queries.find((sql) => sql.includes("invalid_metric_rows"))!;
    expect(metrics).toContain(FB_FRAGMENT_TAIL + " AS f");
    expect(queries.find((sql) => sql.includes("raw_rows"))).toContain(FB_FRAGMENT_TAIL);
    expect(queries.find((sql) => sql.startsWith("SELECT campaign_id FROM ("))).toBe(`SELECT campaign_id FROM (${VISIBLE}) FORMAT JSONEachRow`);
  });

  it("users of a hidden (mixed) campaign get campaign_not_visible; its spend never appears", async () => {
    const { scope, reader } = restricted({ responder });
    const bundle = await run(scope, reader, { allocationDiagnosticsEnabled: true, allocationDiagnosticsRequest: {} });
    expect(bundle.perRow[KEY_A]).toMatchObject({ fb_match_status: "partial_coverage", fb_spend: 100, fb_matched_users: 2, fb_unmatched_users: 1 });
    expect(bundle.perRow[KEY_B]).toMatchObject({ fb_match_status: "campaign_not_visible", fb_spend: null, fb_purchases: null, fb_matched_users: 0, fb_unmatched_users: 3 });
    expect(bundle.totals).toMatchObject({ fb_spend: 100, fb_purchases: 2, fb_matched_users: 2, fb_unmatched_users: 4 });
    // Per-campaign allocation diagnostics are never built for a restricted member.
    expect(bundle.allocationDiagnostics).toBeNull();
    expect(bundle.diagnostics).toMatchObject({
      fb_data_status: "ready",
      fb_allocation_diagnostics_enabled: false,
      fb_all_cohorts_users: 0,
      fb_facebook_qualified_users: 0,
      fb_snapshot_unique: true,
    });
    expect(JSON.stringify(bundle)).not.toContain("987654");
  });

  it("scope all keeps the owner's path: source classification runs, nothing is hidden", async () => {
    const owner = createRecordingClickHouse(responder);
    const bundle = await computeFbCohortStats({
      clickhouse: owner,
      supabase: syncStateSupabase(),
      authUserId: DATA_KEY,
      active: { warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION },
      filters: NO_FILTERS,
      dateFrom: "2026-09-01",
      dateTo: "2026-09-30",
      visibleKeys: new Set([KEY_A, KEY_B]),
      visibleRows: VISIBLE_ROWS,
      today: "2026-10-06",
      timezoneConfig: { defaultTimezone: "UTC" },
    });
    expect(owner.statements).toHaveLength(5); // groups, uniqueness, metrics, source stats, source classification
    expect(owner.statements.some((statement) => statement.query.includes("trial_signals"))).toBe(true);
    expect(owner.statements.some((statement) => statement.query.includes("fact_campaign_scope"))).toBe(false);
    expect(bundle.perRow[KEY_B].fb_match_status).not.toBe("campaign_not_visible");
  });

  it("a ScopeViolation from the reader propagates (no silent 'unavailable')", async () => {
    const ctx = context("selected");
    const scope = createRestrictedScopeSql(ctx, snapshot());
    // A reader of ANOTHER context does not know this context's fragments.
    const other = context("selected");
    const reader = createScopedReader(other, createRecordingClickHouse(responder));
    await expect(run(scope, reader)).rejects.toBeInstanceOf(ScopeViolation);
    expect(other.violations.length).toBeGreaterThan(0);
  });
});
