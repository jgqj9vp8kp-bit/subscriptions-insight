// clickhouse-cohorts action "ltv" (Payback page, spec 2026-10-24 §3) and the
// spend ledger's spend_through (P0 facts §10).
//
// Parity with the Cohorts list is proven twice, without a warehouse:
//   * SQL level — the curve continues the list's materialized finx chain byte
//     for byte (same request, same snapshot), and rev_30 / rev_60 are the
//     list's d30_raw / d60_raw expressions verbatim;
//   * value level — both real runners answered by one fake warehouse that
//     evaluates the measure expressions and GROUP BY keys it finds in each
//     statement over the same synthetic finx rows: Σ revenue_d30 / d60 of the
//     list's (date, funnel, path) rows equals rev_30 / rev_60 of the curve's
//     (date, path) rows after both mappings' rounding.
import { describe, expect, it, vi } from "vitest";
import {
  LTV_CHECKPOINTS,
  LTV_MEASURES,
  LTV_REFERENCE_DAYS,
  LTV_SNAPSHOT_NOT_READY,
  addMonths,
  assertLtvDateOrder,
  buildCohortLtvQuery,
  buildLtvDataThroughSql,
  buildLtvMembersThroughSql,
  cohortLtvRequest,
  ltvRowsFromRaw,
  parseLtvDataThrough,
  resolveLtvRange,
  runCohortLtv,
} from "../../supabase/functions/_shared/clickhouse/cohortLtv.ts";
import {
  buildMaterializedCohortListQuery,
  materializedFinxCtes,
  runMaterializedCohortList,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { AGGREGATE_MEASURES, CohortRequestError, supportEmailsCTE } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import {
  ALL_SCOPE_SQL,
  ScopeSnapshotNotReadyError,
  cohortsFrom,
  createRestrictedScopeSql,
  txEmailMatchedFrom,
  txFrom,
} from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import { buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  COHORT_SNAPSHOT_NAME,
  type CohortSnapshotState,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import {
  CLICKHOUSE_COHORTS_POLICY,
  normalizeClickHouseCohortsAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import { lastSpendDaySql, parseSpendThrough, runProjectSpendLedger } from "../../supabase/functions/_shared/clickhouse/projectSpendLedger.ts";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { PAYBACK_CHECKPOINTS } from "@/services/ltvPayback";
import { createRecordingClickHouse, type RecordedStatement } from "./support/recordingClickHouse";
import { OWNER_SQL_CLASSIFICATION_VERSION, OWNER_SQL_TENANT, OWNER_SQL_WAREHOUSE_VERSION, createOwnerSqlSupabase } from "./support/ownerSqlCorpus";

const ACTIVE = { warehouse_version: OWNER_SQL_WAREHOUSE_VERSION, classification_version: OWNER_SQL_CLASSIFICATION_VERSION };
const DATA_THROUGH_TEXT = "2026-10-20 08:30:00.000";

const REQUESTS: ReadonlyArray<readonly [string, CohortRequest]> = [
  ["none", {}],
  ["window", { date_from: "2026-07-01", date_to: "2026-07-31" }],
  ["member filters", { date_from: "2026-07-01", date_to: "2026-07-31", filters: { country: ["US"], media_buyer: ["Ivan", "utm:int1"], platform: ["ios"] } }],
  ["funnel filters (dropped)", { filters: { campaign_path: ["soulmate-sketch"], campaign_path_exclude: ["palm-reading"], funnel: ["Soulmate"] } }],
];

// ---- SQL ------------------------------------------------------------------------------------

describe("ltv SQL", () => {
  it("measures: the list's trial_users and revenue_dN expressions, one per checkpoint", () => {
    expect(LTV_MEASURES.split(",\n  ")).toHaveLength(LTV_CHECKPOINTS.length + 1);
    expect(LTV_MEASURES).toContain("uniqExact(uid) trial_users");
    expect(AGGREGATE_MEASURES).toContain("uniqExact(uid) trial_users");
    for (const day of [30, 60]) {
      const expression = `sum(if(is_success = 1 AND d <= ${day}, nn, 0))`;
      expect(AGGREGATE_MEASURES).toContain(`${expression} d${day}_raw`);
      expect(LTV_MEASURES).toContain(`${expression} rev_${day}`);
    }
    for (const day of LTV_CHECKPOINTS) expect(LTV_MEASURES).toContain(`sum(if(is_success = 1 AND d <= ${day}, nn, 0)) rev_${day}`);
    // The browser model's copy of the checkpoints is the server's.
    expect([...PAYBACK_CHECKPOINTS]).toEqual([...LTV_CHECKPOINTS]);
  });

  it.each(REQUESTS)("parity (SQL level, %s): the curve continues the list's finx chain byte for byte", (_name, request) => {
    const params: Record<string, unknown> = { auth_user_id: "t" };
    const sql = buildCohortLtvQuery(request, ACTIVE, params, { from: "2026-01-01", to: "2026-07-31" });
    const finx = materializedFinxCtes(cohortLtvRequest(request), ACTIVE, {}, "unavailable");
    expect(sql.startsWith(`WITH\n${finx},\nltv AS (\nSELECT c_date cohort_date, c_camp campaign_path, ${LTV_MEASURES}\nFROM finx\n`)).toBe(true);
    expect(sql).toContain("WHERE c_date >= {ltv_from:String} AND c_date <= {ltv_to:String}\nGROUP BY c_date, c_camp)");
    expect(sql.endsWith("SELECT * FROM ltv ORDER BY cohort_date, campaign_path\nFORMAT JSONEachRow")).toBe(true);
    // The list of the same request (support CTE aside) is the same chain.
    const list = buildMaterializedCohortListQuery({ ...cohortLtvRequest(request), action: "list" }, ACTIVE, {}, "unavailable");
    expect(list.startsWith(`WITH\n${finx},\nagg AS (`)).toBe(true);
    // ...and the support CTE is the only part a "ready" probe would change.
    const ready = materializedFinxCtes(cohortLtvRequest(request), ACTIVE, {}, "ready");
    expect(ready.replace(supportEmailsCTE("ready"), supportEmailsCTE("unavailable"))).toBe(finx);
    expect(params).toMatchObject({ ltv_from: "2026-01-01", ltv_to: "2026-07-31", warehouse_version: ACTIVE.warehouse_version, classification_version: ACTIVE.classification_version });
  });

  it("drops the funnel filters (every path in scope is returned), keeps the member filters", () => {
    const [, request] = REQUESTS[3];
    const params: Record<string, unknown> = {};
    const sql = buildCohortLtvQuery({ ...request, filters: { ...request.filters, country: ["US"] } }, ACTIVE, params, { from: "2026-01-01", to: "2026-02-01" });
    expect(sql).not.toMatch(/fc\.campaign_path (NOT )?IN|fc\.funnel IN/);
    expect(Object.keys(params).filter((key) => /^p_m(cp|cpx|fn)_/.test(key))).toEqual([]);
    expect(sql).toContain("fc.country IN ({p_mcountry_0:String})");
    expect(params.p_mcountry_0).toBe("US");
    expect(cohortLtvRequest({ action: "ltv", date_from: "2026-01-01", filters: { campaign_path: ["a"] } } as never))
      .toEqual({ date_from: "2026-01-01", filters: { campaign_path: [], campaign_path_exclude: [], funnel: [] } });
  });

  it("data_through: the newest transaction of the caller's scope", () => {
    expect(buildLtvDataThroughSql()).toBe(`SELECT toString(max(a.event_time)) data_through, count() n
FROM analytics_transactions AS a FINAL
WHERE a.auth_user_id = {auth_user_id:String}
FORMAT JSONEachRow`);
    expect(parseLtvDataThrough({ data_through: DATA_THROUGH_TEXT, n: "12" })).toBe("2026-10-20T08:30:00.000Z");
    expect(parseLtvDataThrough({ data_through: "1970-01-01 00:00:00.000", n: 0 })).toBeNull();
    expect(parseLtvDataThrough({ data_through: "1970-01-01 00:00:00.000", n: 3 })).toBeNull();
    expect(parseLtvDataThrough({ data_through: "garbage", n: 3 })).toBeNull();
    expect(parseLtvDataThrough(undefined)).toBeNull();
  });

  it("members_through: the newest trial of the active snapshot's members (revenueTrials' cut-off read)", () => {
    expect(buildLtvMembersThroughSql()).toBe(`SELECT toString(max(fc.trial_event_time)) data_through, count() n
FROM fact_user_cohorts AS fc FINAL
WHERE fc.auth_user_id = {auth_user_id:String}
  AND fc.warehouse_version = {warehouse_version:String}
  AND fc.classification_version = {classification_version:String}
FORMAT JSONEachRow`);
  });

  it("maps rows: UInt64 arrives quoted, money rounds half-up per cell, rev aligned to the checkpoints", () => {
    const raw = { cohort_date: "2026-07-01", campaign_path: "p", trial_users: "7", ...Object.fromEntries(LTV_CHECKPOINTS.map((day, index) => [`rev_${day}`, index * 10 + 0.126])) };
    const [row] = ltvRowsFromRaw([raw]);
    expect(row.trial_users).toBe(7);
    expect(row.rev).toHaveLength(LTV_CHECKPOINTS.length);
    expect(row.rev[0]).toBe(0.13);
    expect(row.rev[5]).toBe(50.13);
  });
});

describe("ltv range", () => {
  it("widens the display window back to data_through − 271 days for the reference pools", () => {
    expect(LTV_REFERENCE_DAYS).toBe(271);
    const range = resolveLtvRange("2026-09-21", "2026-10-20", "2026-10-20T08:30:00.000Z");
    expect(range).toEqual({ from: "2026-01-22", to: "2026-10-20", requested_from: "2026-09-21", requested_to: "2026-10-20", capped: false });
  });

  it("keeps an older display window as it is, and caps at 13 months before `to`", () => {
    expect(resolveLtvRange("2025-12-01", "2026-06-30", "2026-10-20T08:30:00.000Z").from).toBe("2025-12-01");
    const capped = resolveLtvRange("2024-01-01", "2026-06-30", "2026-10-20T08:30:00.000Z");
    expect(capped).toMatchObject({ from: "2025-05-30", to: "2026-06-30", capped: true });
    // The reference part alone is never "capped": the display window is whole.
    expect(resolveLtvRange("2026-09-01", "2026-09-30", "2026-10-20T08:30:00.000Z").capped).toBe(false);
  });

  it("defaults: to = data_through's day, from = to; a reversed window is a 400", () => {
    expect(resolveLtvRange(null, null, "2026-10-20T08:30:00.000Z")).toMatchObject({ from: "2026-01-22", to: "2026-10-20", requested_from: null, requested_to: null });
    expect(() => resolveLtvRange("2026-10-02", "2026-10-01", "2026-10-20T08:30:00.000Z")).toThrow(CohortRequestError);
    expect(() => assertLtvDateOrder("2026-10-02", "2026-10-01")).toThrow("date_from must not be after date_to.");
    expect(() => assertLtvDateOrder("2026-10-02", null)).not.toThrow();
  });

  it("a lone date_from after data_through's day is nothing to read, not a 400", () => {
    expect(resolveLtvRange("2026-10-21", null, "2026-10-20T08:30:00.000Z")).toBeNull();
    expect(resolveLtvRange("2026-10-20", null, "2026-10-20T08:30:00.000Z")).toMatchObject({ from: "2026-01-22", to: "2026-10-20" });
  });

  it("calendar months clamp the day", () => {
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2026-06-30", -13)).toBe("2025-05-30");
    expect(addMonths("2024-03-31", -1)).toBe("2024-02-29");
  });
});

// ---- runner -----------------------------------------------------------------------------------

const MEMBERS_THROUGH_TEXT = "2026-10-19 21:10:00.000";
/** The live fingerprint's hash: "golden000000000001" is the snapshot's own version (current). */
let fingerprintHash = "golden000000000001";

function ownerWarehouse(statement: RecordedStatement): unknown[] {
  if (statement.query.includes("max(a.event_time)) data_through, count() n")) return [{ data_through: DATA_THROUGH_TEXT, n: 40 }];
  if (statement.query.includes("max(fc.trial_event_time)) data_through, count() n")) return [{ data_through: MEMBERS_THROUGH_TEXT, n: 9 }];
  if (statement.query.includes("AS warehouse_hash")) return [{ transaction_count: 40, unique_users: 9, warehouse_hash: fingerprintHash }];
  if (statement.query.includes("ltv AS (")) {
    return [{ cohort_date: "2026-07-01", campaign_path: "soulmate-sketch", trial_users: "3", rev_0: 3, rev_30: 30.004, rev_90: 90 }];
  }
  return [];
}

describe("runCohortLtv (data owner)", () => {
  it("reads data_through, members_through and the live fingerprint first, then the curve over the resolved range, every path", async () => {
    fingerprintHash = "golden000000000001";
    const recording = createRecordingClickHouse(ownerWarehouse);
    const response = await runCohortLtv({
      authUserId: OWNER_SQL_TENANT,
      supabase: createOwnerSqlSupabase(),
      clickhouse: recording,
      request: { action: "ltv", date_from: "2026-09-21", date_to: "2026-10-20", filters: { campaign_path: ["soulmate-sketch"] } } as never,
    });
    expect(recording.statements).toHaveLength(4);
    expect(recording.statements[0].query).toBe(buildLtvDataThroughSql());
    expect(recording.statements[0].params).toEqual({ auth_user_id: OWNER_SQL_TENANT });
    expect(recording.statements[1].query).toBe(buildLtvMembersThroughSql());
    expect(recording.statements[1].params).toEqual({ auth_user_id: OWNER_SQL_TENANT, ...ACTIVE });
    expect(recording.statements[2].query).toContain("AS warehouse_hash");
    expect(recording.statements[3].params).toMatchObject({ auth_user_id: OWNER_SQL_TENANT, ltv_from: "2026-01-22", ltv_to: "2026-10-20", ...ACTIVE });
    expect(recording.statements[3].params).not.toHaveProperty("p_mcp_0");
    expect(response).toMatchObject({
      ok: true, source: "clickhouse", action: "ltv",
      checkpoints: [...LTV_CHECKPOINTS],
      data_through: "2026-10-20T08:30:00.000Z",
      members_through: "2026-10-19T21:10:00.000Z",
      snapshot_stale: false,
      range: { from: "2026-01-22", to: "2026-10-20", capped: false },
      diagnostics: {
        active_snapshot_version: `${ACTIVE.warehouse_version}:${ACTIVE.classification_version}`,
        current_warehouse_version: ACTIVE.warehouse_version,
        rows: 1,
        trial_users: 3,
      },
    });
    expect(response.rows).toEqual([{ cohort_date: "2026-07-01", campaign_path: "soulmate-sketch", trial_users: 3, rev: [3, 0, 0, 0, 0, 30, 0, 0, 0, 0, 0, 90] }]);
    expect(response).not.toHaveProperty("error");
  });

  it("no transactions: no curve statement, no range", async () => {
    const recording = createRecordingClickHouse(() => []);
    const response = await runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: recording, request: { action: "ltv" } as never });
    expect(recording.statements).toHaveLength(3);
    expect(response).toMatchObject({ ok: true, data_through: null, members_through: null, range: null, rows: [] });
  });

  it("a stale snapshot: snapshot_stale and the members bound ride on the response, the curve is unchanged", async () => {
    fingerprintHash = "newerimport0000002";
    try {
      const recording = createRecordingClickHouse(ownerWarehouse);
      const response = await runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: recording, request: { action: "ltv", date_from: "2026-09-21", date_to: "2026-10-20" } as never });
      expect(response).toMatchObject({
        ok: true,
        snapshot_stale: true,
        data_through: "2026-10-20T08:30:00.000Z",
        members_through: "2026-10-19T21:10:00.000Z",
        diagnostics: { current_warehouse_version: "wh_newerimport0000002" },
      });
      expect(response.rows).toHaveLength(1);
    } finally {
      fingerprintHash = "golden000000000001";
    }
  });

  it("an unreadable fingerprint leaves freshness unknown (null), never claimed current", async () => {
    const recording = createRecordingClickHouse((statement) => {
      if (statement.query.includes("AS warehouse_hash")) throw new Error("fingerprint down");
      return ownerWarehouse(statement);
    });
    const response = await runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: recording, request: { action: "ltv" } as never });
    expect(response).toMatchObject({ ok: true, snapshot_stale: null, diagnostics: { current_warehouse_version: null } });
  });

  it("without a validated snapshot the owner gets ok: false and no SQL (the curve has no dynamic fallback)", async () => {
    const recording = createRecordingClickHouse(ownerWarehouse);
    const response = await runCohortLtv({ authUserId: "tenant-without-snapshot", supabase: createOwnerSqlSupabase(), clickhouse: recording, request: { action: "ltv" } as never });
    expect(recording.statements).toEqual([]);
    expect(response).toMatchObject({ ok: false, error: LTV_SNAPSHOT_NOT_READY, rows: [], data_through: null, members_through: null, snapshot_stale: null });
  });

  it("a failed snapshot-state read is an error (retried as a 5xx), never \"not ready\"", async () => {
    const recording = createRecordingClickHouse(ownerWarehouse);
    const failing = {
      from: () => {
        const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: null, error: { message: "connection reset" } }) };
        return builder;
      },
    } as unknown as SupabaseLikeClient;
    await expect(runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: failing, clickhouse: recording, request: { action: "ltv" } as never }))
      .rejects.toThrow(/cohort snapshot state: connection reset/);
    expect(recording.statements).toEqual([]);
  });

  it("validates dates and their order before any read (400)", async () => {
    const recording = createRecordingClickHouse(ownerWarehouse);
    await expect(runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: recording, request: { action: "ltv", date_from: "07/01/2026" } as never }))
      .rejects.toBeInstanceOf(CohortRequestError);
    const stateReads = vi.fn();
    const owner = createOwnerSqlSupabase();
    const watched = { from: (table: string) => { stateReads(table); return owner.from(table); } } as unknown as SupabaseLikeClient;
    await expect(runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: watched, clickhouse: recording, request: { action: "ltv", date_from: "2026-10-02", date_to: "2026-10-01" } as never }))
      .rejects.toThrow("date_from must not be after date_to.");
    expect(stateReads).not.toHaveBeenCalled();
    expect(recording.statements).toEqual([]);
  });

  it("a lone date_from after the newest payment: no curve statement, an empty answer", async () => {
    const recording = createRecordingClickHouse(ownerWarehouse);
    const response = await runCohortLtv({ authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: recording, request: { action: "ltv", date_from: "2026-10-25" } as never });
    expect(response).toMatchObject({ ok: true, data_through: "2026-10-20T08:30:00.000Z", range: null, rows: [] });
    expect(recording.statements.some((statement) => statement.query.includes("ltv AS ("))).toBe(false);
  });
});

// ---- restricted -----------------------------------------------------------------------------

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const PASS = { status: "PASS", duplicate_users: 0, dynamic_users: 9, materialized_users: 9 };

function restrictedContext(paths: string[]) {
  const row = parseResolveAccessRow({
    status: "ok", workspace_id: "33333333-3333-4333-8333-333333333333", data_key: DATA_KEY,
    member_id: "44444444-4444-4444-8444-444444444444", user_id: EMPLOYEE, email: "buyer@example.com", display_name: "Buyer",
    is_data_owner: false, raw_access: false,
    role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: ["forecasting.view"] },
    funnel_scope: { mode: "selected", funnel_ids: ["55555555-5555-4555-8555-555555555555"], paths },
    access_version: "3", partition: "partition-hash",
  });
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId: EMPLOYEE, email: "buyer@example.com" }, "req-ltv");
}

function readyState(): CohortSnapshotState {
  return {
    auth_user_id: DATA_KEY, snapshot_name: COHORT_SNAPSHOT_NAME, status: "completed",
    active_warehouse_version: "wh_ltv", active_classification_version: COHORT_CLASSIFICATION_VERSION, active_generated_at: "2026-10-20T07:00:00.000Z",
    building_warehouse_version: null, building_classification_version: null, started_at: null, finished_at: "2026-10-20T07:00:00.000Z",
    duration_ms: 1, users_classified: 9_999, rows_inserted: 9_999, duplicate_users: 0, removed_or_invalidated: 0,
    source_transactions: 77_777, source_unique_users: 8_888, last_error: null, diagnostics: { validation: PASS },
    active_validation: PASS, active_validated_at: "2026-10-20T07:00:00.000Z", active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
    fresh_verified_at: "2026-10-20T07:50:00.000Z", stale_since: null,
  };
}

function trackingPg() {
  const tables: string[] = [];
  const pg = { from: vi.fn((table: string) => { tables.push(table); throw new Error("no state read for a restricted member"); }), rpc: vi.fn() };
  return { pg: pg as unknown as SupabaseLikeClient, tables };
}

describe("runCohortLtv (funnel-restricted)", () => {
  it("reads only scoped fragments through the restricted reader, with the gate's snapshot", async () => {
    const ctx = restrictedContext(["palm-reading", "soulmate-sketch"]);
    const scope = createRestrictedScopeSql(ctx, {
      warehouseVersion: "wh_ltv", classificationVersion: COHORT_CLASSIFICATION_VERSION, campaignScopeReady: false,
      freshVerifiedAt: "2026-10-20T07:50:00.000Z", staleSince: null, state: readyState(),
    });
    const recording = createRecordingClickHouse(ownerWarehouse);
    const reader = createScopedReader(ctx, recording);
    const { pg, tables } = trackingPg();
    const response = await runCohortLtv({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: { action: "ltv", date_from: "2026-09-21" } as never, scope });

    expect(ctx.violations).toEqual([]);
    expect(tables).toEqual([]);
    // No tenant-wide fingerprint: data_through and members_through are scoped.
    expect(recording.statements).toHaveLength(3);
    expect(recording.statements[0].query).toBe(buildLtvDataThroughSql(scope));
    expect(recording.statements[0].query).toContain(txFrom(scope, "a"));
    expect(recording.statements[1].query).toBe(buildLtvMembersThroughSql(scope));
    expect(recording.statements[1].query).toContain(cohortsFrom(scope, "fc"));
    expect(recording.statements.some((statement) => statement.query.includes("warehouse_hash"))).toBe(false);
    const curve = recording.statements[2].query;
    expect(curve).toContain(cohortsFrom(scope, "fc"));
    expect(curve).toContain(txEmailMatchedFrom(scope, "a"));
    expect(curve).not.toMatch(/\bfcall\b|system\.tables|\belig AS \(|\buserdim AS \(/);
    expect(curve).toContain("support_emails AS (SELECT '' AS normalized_email WHERE 0)");
    for (const statement of recording.statements) expect(statement.settings?.readonly).toBe(2);
    expect(response.diagnostics.active_snapshot_version).toBe(`wh_ltv:${COHORT_CLASSIFICATION_VERSION}`);
    expect(response.rows).toHaveLength(1);
    // Freshness is the gate's verdict on this snapshot.
    expect(response).toMatchObject({ snapshot_stale: false, members_through: "2026-10-19T21:10:00.000Z", diagnostics: { current_warehouse_version: null } });
  });

  it("a snapshot the gate saw a newer warehouse for is stale", async () => {
    const ctx = restrictedContext(["soulmate-sketch"]);
    const scope = createRestrictedScopeSql(ctx, {
      warehouseVersion: "wh_ltv", classificationVersion: COHORT_CLASSIFICATION_VERSION, campaignScopeReady: false,
      freshVerifiedAt: "2026-10-20T07:50:00.000Z", staleSince: "2026-10-20T08:00:00.000Z", state: readyState(),
    });
    const response = await runCohortLtv({ authUserId: DATA_KEY, supabase: trackingPg().pg, clickhouse: createScopedReader(ctx, createRecordingClickHouse(ownerWarehouse)), request: { action: "ltv" } as never, scope });
    expect(response.snapshot_stale).toBe(true);
  });

  it("no snapshot on the handle: 409 before any SQL", async () => {
    const ctx = restrictedContext(["soulmate-sketch"]);
    const scope = createRestrictedScopeSql(ctx, null);
    const recording = createRecordingClickHouse(ownerWarehouse);
    await expect(runCohortLtv({ authUserId: DATA_KEY, supabase: trackingPg().pg, clickhouse: createScopedReader(ctx, recording), request: { action: "ltv" } as never, scope }))
      .rejects.toBeInstanceOf(ScopeSnapshotNotReadyError);
    expect(recording.statements).toEqual([]);
  });
});

// ---- value-level parity with the list ---------------------------------------------------------

interface FinxFixtureRow { uid: string; c_date: string; c_funnel: string; c_camp: string; d: number; nn: number; is_success: 0 | 1 }

/** Synthetic finx rows: three paths, one of them under two funnel names, money
 * that sums with float noise, failed rows, payments on and around every boundary. */
function finxFixture(): FinxFixtureRow[] {
  const rows: FinxFixtureRow[] = [];
  const prices = [0.99, 9.99, 29.99, 4.99, 14.98, 0.1, 0.2];
  const days = [0, 3, 7, 14, 29, 30, 31, 45, 59, 60, 61, 75, 89, 90];
  const keys: Array<[string, string]> = [["Soulmate", "soulmate-sketch"], ["Soulmate ES", "soulmate-sketch"], ["Palm", "palm-reading"], ["Past life", "past-life"]];
  for (let user = 0; user < 60; user += 1) {
    const [funnel, path] = keys[user % keys.length];
    const date = `2026-07-${String(1 + (user % 9)).padStart(2, "0")}`;
    for (let payment = 0; payment < 6; payment += 1) {
      rows.push({
        uid: `u${user}`, c_date: date, c_funnel: funnel, c_camp: path,
        d: days[(user * 7 + payment * 3) % days.length], nn: prices[(user + payment) % prices.length],
        is_success: (user + payment) % 5 === 0 ? 0 : 1,
      });
    }
  }
  return rows;
}

const SUM_MEASURE = /sum\(if\(is_success = 1 AND d (<=|=) (\d+), nn, 0\)\) (\w+)/g;
const KEY_COLUMNS: Record<string, string> = { c_date: "cohort_date", c_funnel: "funnel", c_camp: "campaign_path" };

/** Answers a grouped statement from the fixture by the measure expressions and
 * the GROUP BY keys written in ITS OWN text, with its own date bounds. */
function evaluate(statement: RecordedStatement, rows: readonly FinxFixtureRow[]): Array<Record<string, unknown>> {
  const keys = [...statement.query.matchAll(/GROUP BY (c_\w+(?:, c_\w+)*)\)/g)].pop()?.[1].split(", ") ?? [];
  const measures = [...statement.query.matchAll(SUM_MEASURE)].map(([, op, day, alias]) => ({ op, day: Number(day), alias }));
  const from = String(statement.params.ltv_from ?? statement.params.date_from ?? "0000-00-00");
  const to = String(statement.params.ltv_to ?? statement.params.date_to ?? "9999-99-99");
  const groups = new Map<string, FinxFixtureRow[]>();
  for (const row of rows) {
    if (row.c_date < from || row.c_date > to) continue;
    const key = keys.map((column) => row[column as keyof FinxFixtureRow]).join("|");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()].map((group) => {
    const out: Record<string, unknown> = { trial_users: String(new Set(group.map((row) => row.uid)).size) };
    for (const column of keys) out[KEY_COLUMNS[column]] = group[0][column as keyof FinxFixtureRow];
    for (const measure of measures) {
      out[measure.alias] = group.reduce((sum, row) => {
        const inside = measure.op === "<=" ? row.d <= measure.day : row.d === measure.day;
        return row.is_success === 1 && inside ? sum + row.nn : sum;
      }, 0);
    }
    return out;
  });
}

describe("parity (values): rev_30 / rev_60 equal the list's revenue_d30 / revenue_d60", () => {
  it.each([
    ["all time", { filters: {} }],
    ["a window", { date_from: "2026-07-03", date_to: "2026-07-07" }],
  ] as const)("%s", async (_name, request) => {
    const fixture = finxFixture();
    const responder = (statement: RecordedStatement) => {
      if (statement.query.includes(") data_through, count() n")) return [{ data_through: "2026-10-20 08:30:00.000", n: fixture.length }];
      if (statement.query.includes("SELECT * FROM ltv") || statement.query.includes("SELECT * FROM agg")) return evaluate(statement, fixture);
      return [];
    };
    const list = await runMaterializedCohortList({
      authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: createRecordingClickHouse(responder), request: { ...request, action: "list" },
    });
    // The curve is asked for the same display window; its range starts earlier,
    // so compare on the list's cohort days.
    const ltv = await runCohortLtv({
      authUserId: OWNER_SQL_TENANT, supabase: createOwnerSqlSupabase(), clickhouse: createRecordingClickHouse(responder), request: { ...request, action: "ltv" } as never,
    });
    expect(list).not.toBeNull();
    const d30 = LTV_CHECKPOINTS.indexOf(30);
    const d60 = LTV_CHECKPOINTS.indexOf(60);
    const fromList = new Map<string, { trials: number; d30: number; d60: number }>();
    for (const row of list!.rows) {
      const key = `${row.cohort_date}|${row.campaign_path}`;
      const entry = fromList.get(key) ?? { trials: 0, d30: 0, d60: 0 };
      fromList.set(key, { trials: entry.trials + row.trial_users, d30: entry.d30 + row.revenue_d30, d60: entry.d60 + row.revenue_d60 });
    }
    const fromCurve = new Map(ltv.rows.map((row) => [`${row.cohort_date}|${row.campaign_path}`, row]));
    expect(fromList.size).toBeGreaterThan(5);
    // Two funnel names share soulmate-sketch: the list has more rows than the curve.
    expect(list!.rows.length).toBeGreaterThan(fromList.size);
    for (const [key, expected] of fromList) {
      const row = fromCurve.get(key);
      expect(row, key).toBeDefined();
      expect(row!.trial_users, key).toBe(expected.trials);
      expect(row!.rev[d30], key).toBe(Math.round(expected.d30 * 100) / 100);
      expect(row!.rev[d60], key).toBe(Math.round(expected.d60 * 100) / 100);
    }
    // Same totals as the list's own totals row.
    const total = (index: number) => Math.round([...fromList.keys()].reduce((sum, key) => sum + fromCurve.get(key)!.rev[index], 0) * 100) / 100;
    expect(total(d30)).toBe(list!.totals.revenue_d30);
    expect(total(d60)).toBe(list!.totals.revenue_d60);
  });
});

// ---- policy -----------------------------------------------------------------------------------

describe("ltv access policy", () => {
  it("is its own action: forecasting.view, scopeReady behind the cohort snapshot", () => {
    expect(normalizeClickHouseCohortsAction({ body: { action: "ltv" } } as never)).toBe("ltv");
    expect(CLICKHOUSE_COHORTS_POLICY.actions.ltv).toEqual({ anyOf: ["forecasting.view"], restrictedAnyOf: ["forecasting.view"], scopeReady: true, scopeSnapshot: "cohort" });
  });
});

// ---- spend_through ----------------------------------------------------------------------------

describe("spend ledger: spend_through", () => {
  it("is the newest campaign-level day WITH spend over the whole history (not the window)", () => {
    const sql = lastSpendDaySql();
    expect(sql).toContain("FROM fact_facebook_stats FINAL");
    expect(sql).toContain("auth_user_id = {auth_user_id:String} AND level = 'campaign' AND spend > 0");
    expect(sql).toContain("toString(max(stat_date)) AS spend_through, count() AS spend_rows");
    expect(sql).not.toContain("date_from");
  });

  it("parses a day; nothing loaded (max of no rows is the Date zero value) is null", () => {
    expect(parseSpendThrough({ spend_through: "2026-09-14", spend_rows: "8123" })).toBe("2026-09-14");
    expect(parseSpendThrough({ spend_through: "1970-01-01", spend_rows: "0" })).toBeNull();
    expect(parseSpendThrough({ spend_through: "1970-01-01", spend_rows: "5" })).toBeNull();
    expect(parseSpendThrough({ spend_through: "", spend_rows: 1 })).toBeNull();
    expect(parseSpendThrough(undefined)).toBeNull();
  });

  it("rides on the spend_ledger response, bound to the tenant only", async () => {
    const recording = createRecordingClickHouse((statement) => (statement.query.includes("AS spend_through") ? [{ spend_through: "2026-09-14", spend_rows: "40" }] : []));
    const pg = {
      from: () => {
        const builder = { select: () => builder, eq: () => builder, lte: () => builder, gte: async () => ({ data: [], error: null }) };
        return builder;
      },
    } as unknown as SupabaseLikeClient;
    const result = await runProjectSpendLedger({ clickhouse: recording, supabase: pg, authUserId: "tenant-1", dateFrom: "2026-09-01", dateTo: "2026-10-20" });
    expect(result.spendThrough).toBe("2026-09-14");
    expect(result.window).toEqual({ from: "2026-09-01", to: "2026-10-20" });
    const statement = recording.statements.find((candidate) => candidate.query.includes("AS spend_through"));
    expect(statement?.params).toEqual({ auth_user_id: "tenant-1" });
    expect(recording.statements).toHaveLength(4);
  });
});
