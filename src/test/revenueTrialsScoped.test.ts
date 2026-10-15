// Funnel-restricted Daily trials (clickhouse-revenue trials_daily, access
// Phase 2). A restricted member reads only the snapshot rows of their scoped
// users through the registered cohortsFrom fragment, in ONE statement: the
// import cut-off is never read for them (a tenant-wide max would leak other
// funnels' activity, a scoped one would turn a stopped funnel's real zeros into
// "not imported"), so data_through is null and only today is partial. The
// snapshot is the one the gate validated (no second state read), and the
// response carries meta.access. Owner parity with the Cohorts "Trial" column is
// checked on the shared fixture warehouse.
import { describe, expect, it, vi } from "vitest";
import { handleWithAccess, type AccessGateDeps, type AccessRequest } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  OUT_OF_SCOPE_SENTINEL,
  ScopeSnapshotNotReadyError,
  cohortsFrom,
  createRestrictedScopeSql,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  COHORT_SNAPSHOT_NAME,
  type CohortSnapshotState,
  type ScopeSnapshot,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import { TRIALS_RESTRICTED_NOTE, runRevenueTrialsDaily } from "../../supabase/functions/_shared/clickhouse/revenueTrials.ts";
import {
  CLICKHOUSE_REVENUE_POLICY,
  restrictRevenueRequest,
  withRestrictedMeta,
  type ClickHouseRevenueAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-revenue.ts";
import type { RevenueIntelligenceRequest, RevenueTrialsDaily } from "../../supabase/functions/_shared/clickhouse/revenueIntelligenceContract.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse, type RecordedStatement } from "./support/recordingClickHouse";
import { PERSONAS, SCOPE_DAYS, readThroughRouter } from "./support/accessFixtures";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WH = "wh_trials_scoped";
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
    users_classified: 987654,
    rows_inserted: 987654,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: 987654,
    source_unique_users: 987654,
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

/** Trial groups for the scoped statement; the cut-off statement answers a
 * tenant-wide sentinel that must never reach a restricted body. */
function trialsWarehouse(statement: RecordedStatement): unknown[] {
  const sql = statement.query;
  if (sql.includes("data_through")) return [{ data_through: "2026-10-06 11:00:00.000", n: "987654" }];
  if (sql.includes("uniqExact(fc.canonical_user_id) trials")) {
    if (statement.params.p_mcp_0 === OUT_OF_SCOPE_SENTINEL) return [];
    return [
      { bkt: "2026-10-04", cpath: "soulmate-sketch", geo: "MX", trials: "3" },
      { bkt: "2026-10-05", cpath: "soulmate-sketch", geo: "", trials: "1" },
      { bkt: "2026-10-06", cpath: "palm-reading", geo: "CO", trials: "2" },
      { bkt: "prev", cpath: "soulmate-sketch", geo: "MX", trials: "5" },
    ];
  }
  return [];
}

function restrictedRead(paths?: string[], snapshot: ScopeSnapshot | null = snapshotOf()) {
  const row = parseResolveAccessRow(accessRow(paths));
  if (!row) throw new Error("fixture row did not parse");
  const ctx = buildAccessContext(row, { kind: "user", userId: EMPLOYEE, email: "buyer@example.com" }, "req-trials");
  const scope = createRestrictedScopeSql(ctx, snapshot);
  const recording = createRecordingClickHouse(trialsWarehouse);
  return { ctx, scope, recording, reader: createScopedReader(ctx, recording) };
}

function noPg(): SupabaseLikeClient & { from: ReturnType<typeof vi.fn> } {
  return { from: vi.fn(() => { throw new Error("restricted trials must not read the snapshot state again"); }), rpc: vi.fn() } as unknown as SupabaseLikeClient & { from: ReturnType<typeof vi.fn> };
}

const ACTIVE_PARAMS = { warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION };

describe("restricted trials_daily", () => {
  it("runs exactly one statement, through the registered cohortsFrom fragment, with no Postgres read", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    const pg = noPg();
    const result = await runRevenueTrialsDaily({
      authUserId: DATA_KEY, supabase: pg, clickhouse: reader, scope, now: NOW,
      request: { action: "trials_daily", date_from: "2026-10-04", date_to: "2026-10-06" },
    });
    expect(result.ok).toBe(true);
    expect(ctx.violations).toEqual([]);
    expect(pg.from).not.toHaveBeenCalled();
    expect(recording.statements).toHaveLength(1);
    const [statement] = recording.statements;
    expect(statement.settings?.readonly).toBe(2);
    expect(statement.query).toContain(`FROM ${cohortsFrom(scope, "fc")}`);
    expect(statement.query).toContain("uniqExact(fc.canonical_user_id) trials");
    // Never the import cut-off (max trial_event_time) for a restricted member.
    expect(statement.query).not.toContain("max(fc.trial_event_time)");
    expect(statement.query).not.toContain("data_through");
    expect(statement.query).not.toContain("analytics_transactions");
    expect(statement.params).toMatchObject({ ...ACTIVE_PARAMS, auth_user_id: DATA_KEY, tr_prev_from: "2026-10-01", tr_from: "2026-10-04", tr_to: "2026-10-06" });
  });

  it("answers data_through null, filters_active, the restricted note, today partial — and no tenant-wide counter", async () => {
    const { scope, reader } = restrictedRead();
    const result = await runRevenueTrialsDaily({
      authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, scope, now: NOW,
      request: { action: "trials_daily", date_from: "2026-10-04", date_to: "2026-10-06" },
    });
    expect(result.data_through).toBeNull();
    expect(result.diagnostics.filters_active).toBe(true);
    expect(result.diagnostics.note).toBe(TRIALS_RESTRICTED_NOTE);
    expect(result.diagnostics.snapshot_warehouse_version).toBe(WH);
    expect(result.axis_state).toEqual(["complete", "complete", "partial"]);
    expect(result.totals).toEqual({ trials: 6, prev_trials: 5, daily: [3, 1, 2], unknown_funnel: 0, unknown_geo: 1 });
    expect(result.by_funnel.map((row) => row.key)).toEqual(["soulmate-sketch", "palm-reading"]);
    expect(JSON.stringify(result)).not.toContain("987654");
  });

  it("an out-of-scope campaign_path becomes the sentinel (matches nothing) and meta counts it", async () => {
    const { scope, recording, reader } = restrictedRead(["soulmate-sketch"]);
    const shaped = restrictRevenueRequest(scope, { action: "trials_daily", filters: { campaign_path: ["past-life"], country: ["MX"] } });
    expect(shaped).toEqual({ request: { action: "trials_daily", filters: { campaign_path: [OUT_OF_SCOPE_SENTINEL], country: ["MX"] } }, dropped: 1 });
    const result = withRestrictedMeta(await runRevenueTrialsDaily({ authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, scope, now: NOW, request: shaped.request }), shaped.dropped);
    expect(recording.statements[0].params).toMatchObject({ p_mcp_0: OUT_OF_SCOPE_SENTINEL, p_mcountry_0: "MX" });
    expect(result.meta).toEqual({ access: { scope: "restricted", dropped_filter_values: 1 } });
    expect(result.totals.trials).toBe(0);
    expect(result.by_funnel).toEqual([]);
  });

  it("member filters still narrow within the scope (the utm lookup through the registered txFrom too)", async () => {
    const { ctx, recording, reader, scope } = restrictedRead();
    await runRevenueTrialsDaily({
      authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, scope, now: NOW,
      request: { action: "trials_daily", filters: { country: ["US"], media_buyer: ["utm:facebook"], campaign_path: ["soulmate-sketch"] } },
    });
    expect(ctx.violations).toEqual([]);
    expect(recording.statements[0].query).toContain("fc.country IN ({p_mcountry_0:String})");
    expect(recording.statements[0].query).toContain("fc.trial_transaction_id IN (SELECT transaction_id FROM (SELECT");
    expect(recording.statements[0].params).toMatchObject({ p_mcountry_0: "US", p_mmbutm_0: "facebook", p_mcp_0: "soulmate-sketch" });
  });

  it("a handle without a snapshot is a 409, not the owner's 'not ready' body, before any SQL", async () => {
    const { scope, recording, reader } = restrictedRead(undefined, null);
    await expect(runRevenueTrialsDaily({ authUserId: DATA_KEY, supabase: noPg(), clickhouse: reader, scope, request: { action: "trials_daily" }, now: NOW }))
      .rejects.toBeInstanceOf(ScopeSnapshotNotReadyError);
    expect(recording.statements).toEqual([]);
  });
});

// ---- through the real gate -------------------------------------------------------------------

async function gateCall(body: Record<string, unknown>, state: CohortSnapshotState | null) {
  const recording = createRecordingClickHouse(trialsWarehouse);
  /** The router minus Deno: shape, run with the scope, add meta. */
  const handler = vi.fn(async ({ ctx, body: requestBody, clickhouse, scope, pg }: AccessRequest<ClickHouseRevenueAction>) => {
    const shaped = ctx.restricted ? restrictRevenueRequest(scope, requestBody) : { request: requestBody as unknown as RevenueIntelligenceRequest, dropped: 0 };
    const result = await runRevenueTrialsDaily({ authUserId: ctx.tenantKey, supabase: pg, clickhouse: clickhouse(), request: shaped.request, scope, now: NOW });
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
    newRequestId: () => "req-trials",
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

describe("restricted trials_daily through the real gate and policy", () => {
  it("200 with a ready snapshot: one scoped statement, filters_active, meta.access", async () => {
    const result = await gateCall({ action: "trials_daily", filters: { campaign_path: ["past-life", "palm-reading"] } }, readyState());
    expect(result.status).toBe(200);
    expect(result.body.meta).toEqual({ access: { scope: "restricted", dropped_filter_values: 1 } });
    expect((result.body.diagnostics as Record<string, unknown>).filters_active).toBe(true);
    expect(result.body.data_through).toBeNull();
    expect(result.recording.statements).toHaveLength(1);
    expect(JSON.stringify(result.body)).not.toContain("987654");
  });

  it("409 without a fresh validated snapshot, before the handler, zero statements", async () => {
    for (const state of [null, readyState({ fresh_verified_at: "2026-10-06T05:00:00.000Z" }), readyState({ active_classification_version: "cohort_classifier_v2" })]) {
      const result = await gateCall({ action: "trials_daily" }, state);
      expect(result.status).toBe(409);
      expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
      expect(result.handler).not.toHaveBeenCalled();
      expect(result.recording.statements).toEqual([]);
    }
  });
});

// ---- owner parity on the fixture warehouse --------------------------------------------------

describe("owner parity with the Cohorts Trial column (fixture level)", () => {
  const [DAY_1, DAY_2] = SCOPE_DAYS;
  const funnelKey = (path: string) => (path === "" || path === "unknown" ? "Unknown" : path);

  it("Σ by_funnel cells per (day, path) = Cohorts trial_users summed per (cohort_date, campaign_path)", async () => {
    const trials = await readThroughRouter(PERSONAS.owner, "clickhouse-revenue", { action: "trials_daily", date_from: DAY_1, date_to: DAY_2 });
    expect(trials.status, trials.text.slice(0, 300)).toBe(200);
    const body = trials.json as unknown as RevenueTrialsDaily;
    expect(body.ok).toBe(true);
    // The owner reads the cut-off first, then the trials.
    expect(trials.clickhouse.statements.map((statement) => (statement.query.includes("data_through") ? "cut-off" : "trials"))).toEqual(["cut-off", "trials"]);
    expect(body.data_through).toBe("2026-09-02T12:00:00.000Z");
    const fromTrials = new Map<string, number>();
    for (const row of body.by_funnel) {
      row.cells.forEach((value, index) => {
        if (value) fromTrials.set(`${body.axis[index]}|${row.key}`, value);
      });
    }

    const cohorts = await readThroughRouter(PERSONAS.owner, "clickhouse-cohorts", { action: "list", date_from: DAY_1, date_to: DAY_2 });
    expect(cohorts.status, cohorts.text.slice(0, 300)).toBe(200);
    const fromCohorts = new Map<string, number>();
    for (const row of (cohorts.json?.rows ?? []) as Array<{ cohort_date: string; campaign_path: string; trial_users: number | string }>) {
      const key = `${row.cohort_date}|${funnelKey(row.campaign_path)}`;
      fromCohorts.set(key, (fromCohorts.get(key) ?? 0) + Number(row.trial_users));
    }
    expect(fromCohorts.size).toBeGreaterThan(3);
    expect(Object.fromEntries(fromTrials)).toEqual(Object.fromEntries(fromCohorts));
  });
});
