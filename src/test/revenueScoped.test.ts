// Funnel-restricted Dashboard Revenue Intelligence (access Phase 2, spec §4
// rows clickhouse-revenue bundle / day_breakdown, track D).
//
// A restricted member reads only the attributed stream of their scoped users
// (anchor attribution: every payment of a customer acquired through one of
// their funnels). filtersActive is forced, so the Unattributed and Facebook
// spend streams are never queried (Spend / Profit / Unattributed show "—"),
// the snapshot is the one the gate validated, and the response carries
// meta.access. The runners are driven through a real restricted ScopedReader
// over a recording transport; the policy through the real gate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleWithAccess, type AccessGateDeps, type AccessRequest } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  ALL_SCOPE_SQL,
  OUT_OF_SCOPE_SENTINEL,
  ScopeSnapshotNotReadyError,
  cohortsFrom,
  createRestrictedScopeSql,
  txFrom,
  type ScopeSql,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  COHORT_SNAPSHOT_NAME,
  type CohortSnapshotState,
  type ScopeSnapshot,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import {
  RESTRICTED_REVENUE_NOTE,
  buildAttributedDailySql,
  buildByAgeSql,
  buildByFunnelSql,
  buildByPlanSql,
  buildDayBreakdownSql,
  runRevenueDayBreakdown,
  runRevenueIntelligence,
} from "../../supabase/functions/_shared/clickhouse/revenueIntelligence.ts";
import { activeCohortMemberWhere } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import {
  CLICKHOUSE_REVENUE_POLICY,
  restrictRevenueRequest,
  withRestrictedMeta,
  type ClickHouseRevenueAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-revenue.ts";
import type { RevenueIntelligenceRequest } from "../../supabase/functions/_shared/clickhouse/revenueIntelligenceContract.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse, type RecordedStatement, type RecordingClickHouse } from "./support/recordingClickHouse";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WH = "wh_revenue_scoped";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const PASS = { status: "PASS", duplicate_users: 0 };

function accessRow(paths: string[] = ["palm-reading", "soulmate-sketch"]) {
  return {
    status: "ok",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444",
    user_id: EMPLOYEE,
    email: "buyer@example.com",
    display_name: "Buyer",
    is_data_owner: false,
    raw_access: false,
    role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: ["dashboard.view", "cohorts.view"] },
    funnel_scope: { mode: "selected", funnel_ids: ["55555555-5555-4555-8555-555555555555"], paths },
    access_version: "3",
    partition: "partition-hash",
  };
}

function readyState(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  return {
    auth_user_id: DATA_KEY,
    snapshot_name: COHORT_SNAPSHOT_NAME,
    status: "completed",
    active_warehouse_version: WH,
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-06T09:00:00.000Z",
    building_warehouse_version: null,
    building_classification_version: null,
    started_at: null,
    finished_at: "2026-10-06T09:00:00.000Z",
    duration_ms: 1,
    users_classified: 9,
    rows_inserted: 9,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: 90,
    source_unique_users: 9,
    last_error: null,
    diagnostics: { validation: PASS },
    active_validation: PASS,
    active_validated_at: "2026-10-06T09:00:00.000Z",
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
    fresh_verified_at: "2026-10-06T11:50:00.000Z",
    stale_since: null,
    ...overrides,
  };
}

function snapshotOf(): ScopeSnapshot {
  return {
    warehouseVersion: WH,
    classificationVersion: COHORT_CLASSIFICATION_VERSION,
    campaignScopeReady: true,
    freshVerifiedAt: "2026-10-06T11:50:00.000Z",
    staleSince: null,
    state: readyState(),
  };
}

/** Attributed rows by statement; anything unattributed / spend would be visible. */
function revenueWarehouse(statement: RecordedStatement): unknown[] {
  const sql = statement.query;
  if (sql.includes("GROUP BY day ORDER BY day") && sql.includes("FROM fin")) {
    return [
      { day: "2026-09-08", gross: "100", refunds: "10", gross_new_day: "60", gross_new_week: "60", gross_new_month: "60", refunds_new_day: "0", refunds_new_week: "0", refunds_new_month: "0", future_cohort_gross: "0", type_trial: "60", type_first_sub: "40", type_renewals: "0", type_upsells: "0", type_tokens: "0", paying_users: "2", new_paying_users_day: "1", new_paying_users_week: "1", new_paying_users_month: "1", rows_scanned: "3" },
    ];
  }
  if (sql.includes("SELECT c_camp key")) return [{ key: "soulmate-sketch", gross: "100", net: "90", gross_new: "60", gross_existing: "40" }];
  if (sql.includes("SELECT c_plan key")) return [{ key: "$4.99", gross: "100", net: "90", gross_new: "60", gross_existing: "40" }];
  if (sql.includes(") bucket,")) return [{ bucket: "d0", gross: "60", net: "60" }, { bucket: "d8_30", gross: "40", net: "30" }];
  if (sql.includes("toString(c_d) cohort_date")) return [{ cohort_date: "2026-09-08", campaign_path: "soulmate-sketch", gross: "60", net: "60", type_trial: "60", type_first_sub: "0", type_renewals: "0", type_upsells: "0", type_tokens: "0" }];
  // Sentinels: the unattributed / spend streams would leak these.
  if (sql.includes("snapshot_users AS")) return [{ day: "2026-09-08", gross: "987654.32", refunds: "0", net: "987654.32", rows_scanned: "1" }];
  if (sql.includes("sum(spend) spend")) return [{ day: "2026-09-08", spend: "987654.32" }];
  return [];
}

function restrictedRead(paths?: string[], snapshot: ScopeSnapshot | null = snapshotOf()) {
  const row = parseResolveAccessRow(accessRow(paths));
  if (!row) throw new Error("fixture row did not parse");
  const ctx = buildAccessContext(row, { kind: "user", userId: EMPLOYEE, email: "buyer@example.com" }, "req-revenue");
  const scope = createRestrictedScopeSql(ctx, snapshot);
  const recording = createRecordingClickHouse(revenueWarehouse);
  return { ctx, scope, recording, reader: createScopedReader(ctx, recording) };
}

function noPg(): SupabaseLikeClient & { from: ReturnType<typeof vi.fn> } {
  return { from: vi.fn(() => { throw new Error("restricted revenue must not read the snapshot state again"); }), rpc: vi.fn() } as unknown as SupabaseLikeClient & { from: ReturnType<typeof vi.fn> };
}

const ACTIVE_PARAMS = { warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION };
const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_path_exclude: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [],
  country: [], card_type: [], platform: [], currency: [], transaction_type: [], refund_status: "all",
};

function expectRestricted(recording: RecordingClickHouse, scope: ScopeSql): void {
  for (const statement of recording.statements) {
    expect(statement.settings?.readonly).toBe(2);
    expect(statement.query).toContain(`FROM ${txFrom(scope, "a")}\n  INNER JOIN ${cohortsFrom(scope, "fc")}`);
    expect(statement.query).not.toContain("snapshot_users");
    expect(statement.query).not.toContain("fact_facebook_stats");
    expect(statement.params).toMatchObject(ACTIVE_PARAMS);
  }
}

describe("restricted bundle", () => {
  it("queries only the attributed stream of the scoped users, with filtersActive forced", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    const pg = noPg();
    const bundle = await runRevenueIntelligence({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: { action: "bundle", date_from: "2026-09-01", date_to: "2026-09-30" }, now: NOW, scope });
    expect(bundle.ok).toBe(true);
    expect(ctx.violations).toEqual([]);
    expect(pg.from).not.toHaveBeenCalled();
    // attributed daily, by funnel, by plan, by age — and nothing else.
    expect(recording.statements).toHaveLength(4);
    expectRestricted(recording, scope);
    expect(bundle.diagnostics.filters_active).toBe(true);
    expect(bundle.diagnostics.note).toBe(RESTRICTED_REVENUE_NOTE);
    expect(bundle.diagnostics.snapshot_warehouse_version).toBe(WH);
    expect(bundle.totals.spend).toBe(0);
    expect(bundle.totals.gross_unattributed).toBe(0);
    expect(bundle.by_funnel.map((row) => row.key)).toEqual(["soulmate-sketch"]);
    // Σ by_funnel = totals (no Unattributed row exists to reconcile).
    expect(bundle.by_funnel.reduce((sum, row) => sum + row.gross, 0)).toBe(bundle.totals.gross);
    expect(JSON.stringify(bundle)).not.toContain("987654");
  });

  it("day_breakdown: one scoped statement, never the unattributed row", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    const day = await runRevenueDayBreakdown({ authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, request: { action: "day_breakdown", date: "2026-09-08" }, scope });
    expect(day.ok).toBe(true);
    expect(ctx.violations).toEqual([]);
    expect(recording.statements).toHaveLength(1);
    expectRestricted(recording, scope);
    expect(day.by_cohort.map((row) => row.cohort)).not.toContain("unattributed");
    expect(day.by_funnel.map((row) => row.key)).toEqual(["soulmate-sketch"]);
    expect(day.gross).toBe(60);
  });

  it("member filters still narrow within the scope (the utm lookup through txFrom too)", async () => {
    const { scope, recording, reader } = restrictedRead();
    await runRevenueIntelligence({
      authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, now: NOW, scope,
      request: { action: "bundle", filters: { country: ["US"], media_buyer: ["utm:facebook"], campaign_path: ["soulmate-sketch"] } },
    });
    for (const statement of recording.statements) {
      expect(statement.query).toContain("fc.country IN ({p_mcountry_0:String})");
      expect(statement.query).toContain(`fc.trial_transaction_id IN (SELECT transaction_id FROM ${txFrom(scope)} WHERE`);
      expect(statement.params).toMatchObject({ p_mcountry_0: "US", p_mmbutm_0: "facebook", p_mcp_0: "soulmate-sketch" });
    }
  });

  it("a handle without a snapshot is a 409, not the owner's 'not ready' body, before any SQL", async () => {
    const { scope, recording, reader } = restrictedRead(undefined, null);
    await expect(runRevenueIntelligence({ authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, request: { action: "bundle" }, scope }))
      .rejects.toBeInstanceOf(ScopeSnapshotNotReadyError);
    await expect(runRevenueDayBreakdown({ authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, request: { action: "day_breakdown", date: "2026-09-08" }, scope }))
      .rejects.toBeInstanceOf(ScopeSnapshotNotReadyError);
    expect(recording.statements).toEqual([]);
  });
});

describe("parity (SQL level): restricted = owner text with the two FROM fragments swapped", () => {
  const swap = (owner: string, scope: ScopeSql) => {
    const from = "  FROM analytics_transactions AS a FINAL\n  INNER JOIN fact_user_cohorts AS fc FINAL\n";
    expect(owner).toContain(from);
    return owner.split(from).join(`  FROM ${txFrom(scope, "a")}\n  INNER JOIN ${cohortsFrom(scope, "fc")}\n`);
  };

  it.each([
    ["attributed daily", (p: Record<string, unknown>, mw: string, s?: ScopeSql) => buildAttributedDailySql(p, DATA_KEY, mw, s)],
    ["by funnel", (p: Record<string, unknown>, mw: string, s?: ScopeSql) => buildByFunnelSql(p, DATA_KEY, "2026-09-01", "2026-09-30", mw, "week", s)],
    ["by plan", (p: Record<string, unknown>, mw: string, s?: ScopeSql) => buildByPlanSql(p, DATA_KEY, "2026-09-01", "2026-09-30", mw, "month", s)],
    ["by age", (p: Record<string, unknown>, mw: string, s?: ScopeSql) => buildByAgeSql(p, DATA_KEY, "2026-09-01", "2026-09-30", mw, s)],
    ["day breakdown", (p: Record<string, unknown>, mw: string, s?: ScopeSql) => buildDayBreakdownSql(p, DATA_KEY, "2026-09-08", mw, s)],
  ])("%s", (_label, build) => {
    const { scope } = restrictedRead();
    const filters = { ...NO_FILTERS, country: ["US"] };
    const ownerParams: Record<string, unknown> = {};
    const owner = build(ownerParams, activeCohortMemberWhere(filters, ownerParams));
    const restrictedParams: Record<string, unknown> = {};
    const restricted = build(restrictedParams, activeCohortMemberWhere(filters, restrictedParams, scope), scope);
    expect(restricted).toBe(swap(owner, scope));
    expect(restrictedParams).toEqual(ownerParams);
    const allParams: Record<string, unknown> = {};
    expect(build(allParams, activeCohortMemberWhere(filters, allParams, ALL_SCOPE_SQL), ALL_SCOPE_SQL)).toBe(owner);
  });
});

describe("restrictRevenueRequest / withRestrictedMeta", () => {
  it("intersects the include list ([A, B] → [A]; [B] → sentinel), leaves the rest", () => {
    const { scope } = restrictedRead();
    expect(restrictRevenueRequest(scope, { action: "bundle", filters: { campaign_path: ["soulmate-sketch", "past-life"], country: ["US"] } }))
      .toEqual({ request: { action: "bundle", filters: { campaign_path: ["soulmate-sketch"], country: ["US"] } }, dropped: 1 });
    expect(restrictRevenueRequest(scope, { action: "bundle", filters: { campaign_path: ["past-life"] } }))
      .toEqual({ request: { action: "bundle", filters: { campaign_path: [OUT_OF_SCOPE_SENTINEL] } }, dropped: 1 });
    expect(restrictRevenueRequest(scope, { action: "day_breakdown", date: "2026-09-08" }))
      .toEqual({ request: { action: "day_breakdown", date: "2026-09-08", filters: { campaign_path: [] } }, dropped: 0 });
    expect(restrictRevenueRequest(ALL_SCOPE_SQL, { action: "bundle", filters: { campaign_path: ["unknown"] } }).dropped).toBe(0);
  });

  it("adds meta.access without touching the body", () => {
    const body = { ok: true, totals: { gross: 1 } };
    expect(withRestrictedMeta(body, 3)).toEqual({ ok: true, totals: { gross: 1 }, meta: { access: { scope: "restricted", dropped_filter_values: 3 } } });
    expect(body).toEqual({ ok: true, totals: { gross: 1 } });
    expect(withRestrictedMeta({}, Number.NaN).meta.access.dropped_filter_values).toBe(0);
  });
});

// ---- through the real gate -------------------------------------------------------------------

async function gateCall(body: Record<string, unknown>, state: CohortSnapshotState | null) {
  const recording = createRecordingClickHouse(revenueWarehouse);
  /** The router minus Deno: shape, run with the scope, add meta. */
  const handler = vi.fn(async ({ ctx, action, body: requestBody, clickhouse, scope, pg }: AccessRequest<ClickHouseRevenueAction>) => {
    const shaped = ctx.restricted ? restrictRevenueRequest(scope, requestBody) : { request: requestBody as unknown as RevenueIntelligenceRequest, dropped: 0 };
    const common = { authUserId: ctx.tenantKey, supabase: pg, clickhouse: clickhouse(), request: shaped.request, scope, now: NOW };
    const result = action === "day_breakdown" ? await runRevenueDayBreakdown(common) : await runRevenueIntelligence(common);
    return ctx.restricted ? withRestrictedMeta(result, shaped.dropped) : result;
  });
  const deps: AccessGateDeps = {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: async () => ({ data: { user: { id: EMPLOYEE, email: "buyer@example.com" } }, error: null }),
    loadAccess: async () => ({ data: accessRow(), error: null }),
    workspaceDataKey: async () => ({ data: DATA_KEY, error: null }),
    readEnv: () => undefined,
    createClickHouse: (ctx) => createScopedReader(ctx, recording),
    newRequestId: () => "req-revenue",
    log: () => undefined,
    loadCohortSnapshotState: vi.fn(async () => state),
    now: () => NOW,
  };
  const req = new Request("https://edge.test/functions/v1/clickhouse-revenue", {
    method: "POST",
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await handleWithAccess(req, CLICKHOUSE_REVENUE_POLICY, handler, deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, recording, handler };
}

describe("restricted revenue through the real gate and policy", () => {
  it("bundle and day_breakdown: 200, filters_active, meta.access, no unattributed / spend SQL", async () => {
    const bundle = await gateCall({ action: "bundle", filters: { campaign_path: ["past-life", "palm-reading"] } }, readyState());
    expect(bundle.status).toBe(200);
    expect(bundle.body.meta).toEqual({ access: { scope: "restricted", dropped_filter_values: 1 } });
    expect((bundle.body.diagnostics as Record<string, unknown>).filters_active).toBe(true);
    expect(bundle.recording.statements).toHaveLength(4);
    expect(bundle.recording.statements.every((statement) => !/snapshot_users|fact_facebook_stats/.test(statement.query))).toBe(true);
    expect(JSON.stringify(bundle.body)).not.toContain("987654");

    const day = await gateCall({ action: "day_breakdown", date: "2026-09-08" }, readyState());
    expect(day.status).toBe(200);
    expect(day.body.meta).toEqual({ access: { scope: "restricted", dropped_filter_values: 0 } });
    expect(day.recording.statements).toHaveLength(1);
  });

  it("without a fresh validated snapshot: 409 before the handler, zero statements", async () => {
    for (const state of [null, readyState({ stale_since: null, fresh_verified_at: "2026-10-06T05:00:00.000Z" }), readyState({ active_classification_version: "cohort_classifier_v2" })]) {
      const result = await gateCall({ action: "bundle" }, state);
      expect(result.status).toBe(409);
      expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
      expect(result.handler).not.toHaveBeenCalled();
      expect(result.recording.statements).toEqual([]);
    }
  });
});

describe("clickhouse-revenue/index.ts (static: it imports esm.sh)", () => {
  const source = readFileSync(resolve(process.cwd(), "supabase/functions/clickhouse-revenue/index.ts"), "utf8");

  it("shapes a restricted request before running, passes the scope, and adds meta", () => {
    expect(source).toContain("ctx.restricted ? restrictRevenueRequest(scope, body)");
    expect(source).toMatch(/const common = \{[^}]*request: shaped\.request, scope \}/);
    expect(source).toContain("return ctx.restricted ? withRestrictedMeta(result, shaped.dropped) : result;");
  });
});
