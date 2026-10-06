// Funnel-restricted Cohorts reads (access Phase 2, spec §4 rows list / options /
// details, track D).
//
// The runners are driven with a real restricted ScopeSql handle and a real
// restricted ScopedReader over a recording transport, so every assertion is on
// what would reach the warehouse:
//   * only materialized, scoped SQL runs — no fcall, no system.tables, no live
//     fingerprint, no dynamic classifier, no snapshot-state read — and the
//     reader records no violation;
//   * the restricted list SQL is the owner's SQL with exactly the documented
//     substitutions (parity contract 2, SQL level);
//   * explicit out-of-scope keys are 403 before any SQL, include lists are
//     intersected (sentinel when nothing is left), exclude lists untouched;
//   * diagnostics are redacted and meta.access is added;
//   * through the real gate: 409 without a ready snapshot, zero statements.
// index.ts imports esm.sh and cannot be loaded here, so its restricted branch
// is pinned by a static check of its source.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { handleWithAccess, type AccessGateDeps, type AccessRequest } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow, type AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import { createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  ALL_SCOPE_SQL,
  OUT_OF_SCOPE_SENTINEL,
  ScopeForbiddenError,
  ScopeSnapshotNotReadyError,
  cohortsFrom,
  createRestrictedScopeSql,
  sqlStringLiteral,
  txEmailMatchedFrom,
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
  activeCohortMemberWhere,
  buildMaterializedCohortListQuery,
  buildMaterializedFilterOptionsQuery,
  materializedFinxCtes,
  restrictedSnapshotDiagnostics,
  runMaterializedCohortDetails,
  runMaterializedCohortList,
  runMaterializedCohortOptions,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import {
  cohortDetailsSelects,
  fxDiagnostics,
  normalizeCohortRequest,
  subscriptionDataStatus,
  supportDataStatus,
  supportEmailsCTE,
} from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import {
  CLICKHOUSE_COHORTS_POLICY,
  projectCohortsResponseForRestricted,
  restrictCohortRequest,
  type ClickHouseCohortsAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import type { CohortFilters, CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse, type RecordedStatement, type RecordingClickHouse } from "./support/recordingClickHouse";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WH = "wh_scoped_reads";
const NOW = new Date("2026-10-06T12:00:00.000Z");
const PATHS_A = ["palm-reading", "soulmate-sketch"];
const PASS = { status: "PASS", duplicate_users: 0, dynamic_users: 9, materialized_users: 9 };

function accessRow(options: { paths?: string[]; mode?: "all" | "selected" | "none"; permissions?: string[] } = {}) {
  const mode = options.mode ?? "selected";
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
    role: { id: "r1", key: "media_buyer", name: "Media Buyer", is_owner: false, permissions: options.permissions ?? ["cohorts.view", "dashboard.view"] },
    funnel_scope: {
      mode,
      funnel_ids: mode === "selected" ? ["55555555-5555-4555-8555-555555555555"] : [],
      paths: mode === "selected" ? options.paths ?? PATHS_A : [],
    },
    access_version: "3",
    partition: "partition-hash",
  };
}

function restrictedContext(options: Parameters<typeof accessRow>[0] = {}): AccessContext {
  const row = parseResolveAccessRow(accessRow(options));
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId: EMPLOYEE, email: "buyer@example.com" }, "req-scoped");
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
    users_classified: 9_999,
    rows_inserted: 9_999,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: 77_777,
    source_unique_users: 8_888,
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

function snapshotOf(overrides: Partial<ScopeSnapshot> = {}): ScopeSnapshot {
  return {
    warehouseVersion: WH,
    classificationVersion: COHORT_CLASSIFICATION_VERSION,
    campaignScopeReady: false,
    freshVerifiedAt: "2026-10-06T11:50:00.000Z",
    staleSince: null,
    state: readyState(),
    ...overrides,
  };
}

/** A restricted context, its handle and a restricted reader over a recording. */
function restrictedRead(options: { paths?: string[]; snapshot?: Partial<ScopeSnapshot> | null; responder?: (statement: RecordedStatement) => unknown[] } = {}) {
  const ctx = restrictedContext({ paths: options.paths });
  const scope = createRestrictedScopeSql(ctx, options.snapshot === null ? null : snapshotOf(options.snapshot ?? {}));
  const recording = createRecordingClickHouse(options.responder ?? warehouse);
  const reader = createScopedReader(ctx, recording);
  return { ctx, scope, recording, reader };
}

/** Fake warehouse rows, routed by statement text. */
function warehouse(statement: RecordedStatement): unknown[] {
  const sql = statement.query;
  if (sql.includes("FROM agg")) {
    return [{ cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "soulmate-sketch", trial_users: 3, gross_raw: 30, refund_raw: 0, support_users: 1 }];
  }
  if (sql.includes("'price_plan' dim")) return [{ dim: "campaign_path", value: "soulmate-sketch", cnt: 3 }];
  if (sql.includes("SELECT 1 FROM fact_support_requests FINAL")) return [{ c: 1 }];
  if (sql.includes("SELECT 1 FROM fact_subscriptions FINAL")) return [{ c: 0 }];
  if (sql.includes("transactions_with_currency")) {
    return [{ transactions_total: 12, transactions_with_currency: 12, transactions_without_currency: 0, transactions_native_usd: 10, transactions_converted: 2, transactions_missing_fx_rate: 0, transactions_invalid_amount: 0, excluded_amount_original: 0, excluded_transactions: 0 }];
  }
  if (sql.includes("FROM normalized_email)) email")) return [{ email: "a@x.com", cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "soulmate-sketch" }];
  return [];
}

/** A Supabase double: records every table read; the only RPC is the active-subscription map. */
function fakePg() {
  const tables: string[] = [];
  const result = { data: null, error: null };
  const builder: Record<string, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === "then") return (resolveValue: (value: unknown) => void) => resolveValue(result);
      if (prop === "maybeSingle" || prop === "single") return async () => result;
      return () => builder;
    },
  });
  const pg = {
    from: vi.fn((table: string) => {
      tables.push(table);
      return builder;
    }),
    rpc: vi.fn(async (name: string) => ({ data: name === "active_funnelfox_subscription_emails" ? { "a@x.com": ["sub-1"] } : null, error: null })),
  };
  return { pg: pg as unknown as SupabaseLikeClient, tables, rpc: pg.rpc };
}

const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_path_exclude: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [],
  country: [], card_type: [], platform: [], currency: [], transaction_type: [], refund_status: "all",
};

const LIST_REQUEST: CohortRequest = {
  action: "list",
  date_from: "2026-06-01",
  date_to: "2026-07-31",
  filters: { campaign_path: ["soulmate-sketch"], country: ["US"], media_buyer: ["Ivan", "utm:facebook"] },
};

const ACTIVE = { warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION };

/** Owner text → restricted text, by the documented substitutions only. */
function expectedRestrictedFinx(ownerSql: string, scope: ScopeSql): string {
  const swap = (text: string, from: string, to: string) => {
    expect(text.includes(from), `owner SQL contains ${JSON.stringify(from.slice(0, 60))}`).toBe(true);
    return text.split(from).join(to);
  };
  let sql = swap(ownerSql, supportEmailsCTE("ready"), supportEmailsCTE("ready", scope));
  sql = swap(sql, "  FROM analytics_transactions AS a FINAL\n  INNER JOIN fact_user_cohorts AS fc FINAL\n", `  FROM ${txFrom(scope, "a")}\n  INNER JOIN ${cohortsFrom(scope, "fc")}\n`);
  const fcall = /-- TODO_MONETIZATION[\s\S]*?\nfcall AS \([\s\S]*?\n\),\n(?=fcm AS \()/;
  expect(sql).toMatch(fcall);
  sql = sql.replace(fcall, () => "");
  sql = swap(sql, "  FROM fact_user_cohorts AS fc FINAL\n  WHERE fc.auth_user_id", `  FROM ${cohortsFrom(scope, "fc")}\n  WHERE fc.auth_user_id`);
  sql = swap(sql, "    FROM analytics_transactions AS a FINAL\n    INNER JOIN fcm", `    FROM ${txFrom(scope, "a")}\n    INNER JOIN fcm`);
  sql = swap(sql, "  FROM analytics_transactions AS a FINAL\n  INNER JOIN cemail", `  FROM ${txEmailMatchedFrom(scope, "a")}\n  INNER JOIN cemail`);
  sql = swap(sql, "    AND a.user_id NOT IN (SELECT canonical_user_id FROM fcall)\n", "");
  // The utm member predicate reads its transactions through txFrom too.
  sql = sql.split("SELECT transaction_id FROM analytics_transactions FINAL WHERE").join(`SELECT transaction_id FROM ${txFrom(scope)} WHERE`);
  return sql;
}

function expectRestrictedTransport(recording: RecordingClickHouse): void {
  expect(recording.statements.length).toBeGreaterThan(0);
  for (const statement of recording.statements) {
    expect(statement.kind).toBe("query");
    // Every restricted read carries the capacity settings and a query id.
    expect(statement.settings?.readonly).toBe(2);
    expect(statement.query_id).toMatch(/^sub_req-scoped_\d+$/);
    expect(statement.query).not.toMatch(/\bfcall\b/);
    expect(statement.query).not.toContain("system.tables");
    expect(statement.query).not.toContain("warehouse_hash");
    // The dynamic classifier (cohorts.ts classifierSQL) never runs.
    expect(statement.query).not.toMatch(/\belig AS \(|\buserdim AS \(/);
    if (statement.query.includes("{auth_user_id:String}")) expect(statement.params.auth_user_id).toBe(DATA_KEY);
  }
}

// ---- list -------------------------------------------------------------------------------

describe("restricted materialized list", () => {
  it("runs only scoped, materialized SQL through the restricted reader", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    const { pg, tables } = fakePg();
    const response = await runMaterializedCohortList({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: LIST_REQUEST, scope, allocationDiagnosticsEnabled: true });

    expect(response).not.toBeNull();
    expect(ctx.violations).toEqual([]);
    expectRestrictedTransport(recording);
    // The snapshot is the gate's: no second state read.
    expect(tables).not.toContain("clickhouse_cohort_snapshot_state");

    const list = recording.statements.find((statement) => statement.query.includes("FROM agg"));
    expect(list).toBeDefined();
    expect(list!.query).toContain(txFrom(scope, "a"));
    expect(list!.query).toContain(cohortsFrom(scope, "fc"));
    expect(list!.query).toContain(txEmailMatchedFrom(scope, "a"));
    expect(list!.query).toContain(`campaign_path IN (${sqlStringLiteral("palm-reading")}, ${sqlStringLiteral("soulmate-sketch")})`);
    expect(list!.params).toMatchObject({ warehouse_version: WH, classification_version: COHORT_CLASSIFICATION_VERSION, p_mcp_0: "soulmate-sketch" });
    // Support emails come only from the scoped users' emails.
    expect(list!.query).toContain("SELECT normalized_email FROM fact_support_requests FINAL WHERE auth_user_id = {auth_user_id:String} AND lowerUTF8");

    // Statement inventory: support probe, list, subscription probe, options, FX, subscription overlay.
    expect(recording.statements.some((statement) => statement.query.startsWith("SELECT count() AS c FROM (SELECT 1 FROM fact_support_requests FINAL"))).toBe(true);
    expect(recording.statements.some((statement) => statement.query.startsWith("SELECT count() AS c FROM (SELECT 1 FROM fact_subscriptions FINAL"))).toBe(true);
    expect(recording.statements.some((statement) => statement.query.includes("'price_plan' dim"))).toBe(true);
    const fx = recording.statements.find((statement) => statement.query.includes("transactions_with_currency"));
    expect(fx?.query).toContain(`FROM ${txFrom(scope)} WHERE auth_user_id = {auth_user_id:String}`);
    expect(fx?.query).toContain(`user_id IN (SELECT user_id FROM (SELECT user_id, argMin(utm_source, (event_time, transaction_id)) first_trial_utm FROM ${txFrom(scope)} WHERE`);
    const overlay = recording.statements.find((statement) => statement.query.includes("FROM normalized_email)) email"));
    expect(overlay?.query).toContain(`FROM ${cohortsFrom(scope)}`);

    // Campaign scope not built: the FB columns degrade without a single FB query.
    expect(recording.statements.some((statement) => /fact_facebook_stats|fact_campaign_scope/.test(statement.query))).toBe(false);
    expect(response!.fb_diagnostics?.fb_data_status).toBe("unavailable");
    // Never the tenant-wide allocation page, whatever the caller asked for.
    expect(response!.fb_allocation_diagnostics).toBeUndefined();

    expect(response!.rows.map((row) => row.campaign_path)).toEqual(["soulmate-sketch"]);
    expect(response!.rows[0].active_users).toBe(1);
    expect(response!.fx_diagnostics?.transactions_total).toBe(12);
  });

  it("redacts every tenant-wide count in diagnostics, keeps versions / statuses / filters_applied", async () => {
    const { scope, reader } = restrictedRead();
    const { pg } = fakePg();
    const response = await runMaterializedCohortList({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: LIST_REQUEST, scope });
    const diagnostics = response!.diagnostics as unknown as Record<string, unknown>;
    expect(diagnostics).toMatchObject({
      transactions_scanned: 0,
      users_scanned: 0,
      source_transactions: null,
      cohort_users: null,
      current_warehouse_version: null,
      current_warehouse_transactions: null,
      support_requests: null,
      support_unique_emails: null,
      counts_redacted: true,
      snapshot_status: "current",
      snapshot_stale: false,
      snapshot_complete: true,
      report_complete: true,
      source_warehouse_version: WH,
      active_snapshot_version: `${WH}:${COHORT_CLASSIFICATION_VERSION}`,
      support_data_status: "ready",
      support_matched_cohort_users: 1,
    });
    expect((diagnostics.filters_applied as Record<string, boolean>).campaign_path).toBe(true);
    expect((diagnostics.filters_applied as Record<string, boolean>).country).toBe(true);
    const serialized = JSON.stringify(response);
    for (const tenantCount of ["77777", "8888", "9999"]) expect(serialized).not.toContain(tenantCount);
  });

  it("freshness is the gate's verdict on the snapshot (stale_since), not a live fingerprint", async () => {
    const { scope, reader, recording } = restrictedRead({ snapshot: { staleSince: "2026-10-06T10:00:00.000Z" } });
    const { pg } = fakePg();
    const response = await runMaterializedCohortList({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: { action: "list" }, scope });
    expect(response!.diagnostics).toMatchObject({ snapshot_stale: true, snapshot_status: "stale", snapshot_complete: false, report_complete: false });
    expect(recording.statements.some((statement) => statement.query.includes("warehouse_hash"))).toBe(false);
  });

  it("a handle without a snapshot returns null (the router answers 409) before any SQL", async () => {
    const { scope, reader, recording } = restrictedRead({ snapshot: null });
    const { pg, tables } = fakePg();
    await expect(runMaterializedCohortList({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: { action: "list" }, scope })).resolves.toBeNull();
    await expect(runMaterializedCohortOptions({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: { action: "options" }, scope })).resolves.toBeNull();
    expect(recording.statements).toEqual([]);
    expect(tables).toEqual([]);
  });

  it("with the campaign scope built, the FB columns read only registered fragments", async () => {
    const { ctx, scope, recording, reader } = restrictedRead({ snapshot: { campaignScopeReady: true } });
    const { pg } = fakePg();
    const response = await runMaterializedCohortList({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: LIST_REQUEST, scope });
    expect(response).not.toBeNull();
    expect(ctx.violations).toEqual([]);
    expectRestrictedTransport(recording);
    expect(recording.statements.some((statement) => statement.query.includes("fact_campaign_scope"))).toBe(true);
  });

  it("parity (SQL level): the restricted list is the owner's list with only the documented substitutions", () => {
    const { scope } = restrictedRead();
    const ownerParams: Record<string, unknown> = { auth_user_id: DATA_KEY };
    const restrictedParams: Record<string, unknown> = { auth_user_id: DATA_KEY };
    const owner = buildMaterializedCohortListQuery(LIST_REQUEST, ACTIVE, ownerParams, "ready");
    const restricted = buildMaterializedCohortListQuery(LIST_REQUEST, ACTIVE, restrictedParams, "ready", scope);
    expect(restricted).toBe(expectedRestrictedFinx(owner, scope));
    // Same bindings: the scope lives in the fragments, never in the params.
    expect(restrictedParams).toEqual(ownerParams);
    // All scope is exactly the owner's text.
    expect(buildMaterializedCohortListQuery(LIST_REQUEST, ACTIVE, {}, "ready", ALL_SCOPE_SQL)).toBe(owner);
  });

  it("an empty path set (scope none / no scopable path) renders `0`, never 'no predicate'", () => {
    const ctx = restrictedContext({ mode: "none" });
    const scope = createRestrictedScopeSql(ctx, snapshotOf());
    const sql = buildMaterializedCohortListQuery({ action: "list" }, ACTIVE, {}, "ready", scope);
    expect(sql).toContain("AND 0 AND NOT startsWith(canonical_user_id, 'unknown_user_')");
    expect(sql).not.toContain("campaign_path IN (");
  });

  it("unknown body keys (search oracles) change no recorded SQL", async () => {
    const plain = restrictedRead();
    const searched = restrictedRead();
    await runMaterializedCohortList({ authUserId: DATA_KEY, supabase: fakePg().pg, clickhouse: plain.reader, request: LIST_REQUEST, scope: plain.scope });
    await runMaterializedCohortList({
      authUserId: DATA_KEY,
      supabase: fakePg().pg,
      clickhouse: searched.reader,
      request: { ...LIST_REQUEST, search: "victim@example.com" } as CohortRequest,
      scope: searched.scope,
    });
    const strip = (recording: RecordingClickHouse) => recording.statements.map((statement) => [statement.query, statement.params]);
    expect(strip(searched.recording)).toEqual(strip(plain.recording));
  });
});

// ---- member predicates ----------------------------------------------------------------------

describe("restricted member predicates", () => {
  it("the utm media-buyer predicate reads the scoped users' transactions; buyer names stay a plain column filter", () => {
    const { scope } = restrictedRead();
    const params: Record<string, unknown> = {};
    const where = activeCohortMemberWhere({ ...NO_FILTERS, media_buyer: ["Ivan", "utm:facebook"] }, params, scope);
    expect(where).toBe(
      `AND (fc.media_buyer IN ({p_mmb_0:String}) OR fc.trial_transaction_id IN (SELECT transaction_id FROM ${txFrom(scope)} ` +
      "WHERE auth_user_id = {auth_user_id:String} AND utm_source IN ({p_mmbutm_0:String})))",
    );
    expect(params).toEqual({ p_mmb_0: "Ivan", p_mmbutm_0: "facebook" });
    // The funnel scope is never a member filter (no self-exclusion can drop it).
    expect(activeCohortMemberWhere(NO_FILTERS, {}, scope)).toBe("");
  });
});

// ---- options ----------------------------------------------------------------------------------

describe("restricted materialized options", () => {
  it("builds every option list from the scoped users only, through the reader", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    const { pg, tables } = fakePg();
    const response = await runMaterializedCohortOptions({ authUserId: DATA_KEY, supabase: pg, clickhouse: reader, request: { action: "options", filters: { country: ["US"] } }, scope });
    expect(ctx.violations).toEqual([]);
    expectRestrictedTransport(recording);
    expect(tables).toEqual([]);
    const options = recording.statements.find((statement) => statement.query.includes("'price_plan' dim"));
    expect(options?.query).toContain(`FROM ${cohortsFrom(scope)}\n  WHERE auth_user_id = {auth_user_id:String}`);
    expect(options?.query).toContain(`FROM ${txFrom(scope)}\n  WHERE auth_user_id = {auth_user_id:String} AND utm_source != ''`);
    expect(response!.filter_options).toMatchObject({ campaign_path: expect.any(Array) });
    expect(response!.diagnostics).toMatchObject({ counts_redacted: true, transactions_scanned: 0, support_requests: null });
  });

  it("the all-scope builder text is unchanged", () => {
    const nreq = normalizeCohortRequest({ action: "options", filters: { campaign_path: ["a"] } });
    expect(buildMaterializedFilterOptionsQuery(nreq, ACTIVE, {}, ALL_SCOPE_SQL)).toBe(buildMaterializedFilterOptionsQuery(nreq, ACTIVE, {}));
  });
});

// ---- details ------------------------------------------------------------------------------------

describe("restricted materialized details", () => {
  const COHORT_KEY = { cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "soulmate-sketch" };

  it("cuts the scoped finx chain to the cohort key and runs the four shared statements", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    const response = await runMaterializedCohortDetails({
      authUserId: DATA_KEY,
      clickhouse: reader,
      request: { action: "details", cohort_key: COHORT_KEY, filters: { country: ["US"] } },
      scope,
    });
    expect(response.ok).toBe(true);
    expect(response.cohort_key).toEqual(COHORT_KEY);
    expect(ctx.violations).toEqual([]);
    expectRestrictedTransport(recording);
    const details = recording.statements.filter((statement) => statement.query.includes("scoped AS (SELECT * FROM finx WHERE"));
    expect(details).toHaveLength(4);
    const selects = cohortDetailsSelects();
    for (const statement of details) {
      expect(statement.query).toContain("scoped AS (SELECT * FROM finx WHERE c_date = {ck_date:String} AND c_funnel = {ck_funnel:String} AND c_camp = {ck_camp:String})");
      expect(statement.params).toMatchObject({ ck_camp: "soulmate-sketch", p_mcountry_0: "US", warehouse_version: WH });
      expect([selects.summary, selects.currency, selects.token, selects.plan].some((body) => statement.query.includes(body))).toBe(true);
    }
    // Same chain as the restricted list (the expanded row reconciles with its parent).
    const params: Record<string, unknown> = { auth_user_id: DATA_KEY };
    expect(details[0].query.startsWith(`WITH\n${materializedFinxCtes({ action: "details", cohort_key: COHORT_KEY, filters: { country: ["US"] } }, ACTIVE, params, "ready", scope)},\nscoped AS`)).toBe(true);
  });

  it("funnel_key details scope one in-scope campaign_path over the window", async () => {
    const { scope, recording, reader } = restrictedRead();
    await runMaterializedCohortDetails({
      authUserId: DATA_KEY,
      clickhouse: reader,
      request: { action: "details", funnel_key: { campaign_path: "palm-reading" }, date_from: "2026-06-01", date_to: "2026-06-30" },
      scope,
    });
    const details = recording.statements.filter((statement) => statement.query.includes("scoped AS (SELECT * FROM finx WHERE"));
    expect(details).toHaveLength(4);
    expect(details[0].query).toContain("scoped AS (SELECT * FROM finx WHERE c_camp = {fk_camp:String} AND c_date >= {fk_from:String} AND c_date <= {fk_to:String})");
    expect(details[0].params).toMatchObject({ fk_camp: "palm-reading", fk_from: "2026-06-01", fk_to: "2026-06-30" });
  });

  it.each([
    ["another funnel's cohort", { cohort_key: { ...COHORT_KEY, campaign_path: "past-life" } }],
    ["another funnel's funnel_key", { funnel_key: { campaign_path: "past-life" } }],
    ["an empty key path", { cohort_key: { ...COHORT_KEY, campaign_path: "" } }],
    ["the unknown path", { funnel_key: { campaign_path: "unknown" } }],
    ["a non-canonical path", { funnel_key: { campaign_path: "Soulmate-Sketch" } }],
  ])("%s → 403 funnel_out_of_scope before any SQL", async (_label, keys) => {
    const { scope, recording, reader } = restrictedRead();
    const request = { action: "details", ...keys } as CohortRequest;
    await expect(runMaterializedCohortDetails({ authUserId: DATA_KEY, clickhouse: reader, request, scope })).rejects.toMatchObject({ code: "funnel_out_of_scope" });
    expect(() => restrictCohortRequest(scope, request as Record<string, unknown>)).toThrow(ScopeForbiddenError);
    expect(recording.statements).toEqual([]);
  });

  it("no snapshot on the handle → 409 before any SQL", async () => {
    const { scope, recording, reader } = restrictedRead({ snapshot: null });
    await expect(runMaterializedCohortDetails({ authUserId: DATA_KEY, clickhouse: reader, request: { action: "details", cohort_key: COHORT_KEY }, scope }))
      .rejects.toBeInstanceOf(ScopeSnapshotNotReadyError);
    expect(recording.statements).toEqual([]);
  });
});

// ---- shared probes --------------------------------------------------------------------------

describe("restricted data-status probes and FX", () => {
  it("support: one presence probe, counts 0, no system.tables", async () => {
    const { ctx, scope, recording, reader } = restrictedRead();
    await expect(supportDataStatus(reader, DATA_KEY, scope)).resolves.toEqual({ support_data_status: "ready", support_requests: 0, support_unique_emails: 0 });
    expect(recording.statements.map((statement) => statement.query)).toEqual([
      "SELECT count() AS c FROM (SELECT 1 FROM fact_support_requests FINAL WHERE auth_user_id = {auth_user_id:String} LIMIT 1) FORMAT JSONEachRow",
    ]);
    recording.respondWith(() => [{ c: 0 }]);
    await expect(supportDataStatus(reader, DATA_KEY, scope)).resolves.toMatchObject({ support_data_status: "empty_source" });
    recording.respondWith(() => { throw new Error("UNKNOWN_TABLE"); });
    await expect(supportDataStatus(reader, DATA_KEY, scope)).resolves.toMatchObject({ support_data_status: "unavailable" });
    expect(ctx.violations).toEqual([]);
  });

  it("subscriptions: a presence probe instead of the tenant count", async () => {
    const { scope, recording, reader } = restrictedRead();
    await expect(subscriptionDataStatus(reader, DATA_KEY, scope)).resolves.toBe("empty_source");
    expect(recording.statements[0].query).toContain("SELECT 1 FROM fact_subscriptions FINAL WHERE auth_user_id = {auth_user_id:String} LIMIT 1");
  });

  it("FX diagnostics are recomputed over the scoped users' transactions; all-scope text unchanged", async () => {
    const { scope, recording, reader } = restrictedRead();
    await fxDiagnostics(reader, DATA_KEY, [], scope);
    expect(recording.statements[0].query).toContain(`FROM ${txFrom(scope)} WHERE auth_user_id = {auth_user_id:String}`);
    const owner = createRecordingClickHouse(warehouse);
    await fxDiagnostics(owner, DATA_KEY, []);
    expect(owner.statements[0].query).toContain("FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}");
  });

  it("restrictedSnapshotDiagnostics is pure and never reads the state's tenant totals", () => {
    const nreq = normalizeCohortRequest({ action: "list" });
    const diagnostics = restrictedSnapshotDiagnostics(snapshotOf(), nreq, "ready", { support_data_status: "ready", support_requests: 5, support_unique_emails: 4 }, 2);
    expect(diagnostics.support_requests).toBeNull();
    expect(diagnostics.source_transactions).toBeNull();
    expect(diagnostics.support_matched_cohort_users).toBe(2);
  });
});

// ---- the router contract ------------------------------------------------------------------------

describe("restrictCohortRequest (keys and include lists, before any SQL)", () => {
  it("intersects the include list: [A, B] → [A]; [B] → sentinel; dropped counts the removed values", () => {
    const { scope } = restrictedRead();
    expect(restrictCohortRequest(scope, { action: "list", filters: { campaign_path: ["soulmate-sketch", "past-life"] } }))
      .toEqual({ request: { action: "list", filters: { campaign_path: ["soulmate-sketch"] } }, dropped: 1 });
    expect(restrictCohortRequest(scope, { action: "list", filters: { campaign_path: ["past-life"] } }))
      .toEqual({ request: { action: "list", filters: { campaign_path: [OUT_OF_SCOPE_SENTINEL] } }, dropped: 1 });
    expect(restrictCohortRequest(scope, { action: "list" })).toEqual({ request: { action: "list", filters: { campaign_path: [] } }, dropped: 0 });
    // Normalized like the runner (trim, dedupe) before intersecting.
    expect(restrictCohortRequest(scope, { action: "list", filters: { campaign_path: [" palm-reading ", "palm-reading"] } }).request.filters?.campaign_path).toEqual(["palm-reading"]);
  });

  it("leaves the exclude list and every other filter untouched", () => {
    const { scope } = restrictedRead();
    const filters = { campaign_path_exclude: ["past-life", "soulmate-sketch"], country: ["US"], media_buyer: ["utm:x"] };
    expect(restrictCohortRequest(scope, { action: "list", filters }).request.filters).toEqual({ ...filters, campaign_path: [] });
  });

  it("a sentinel include list binds a value that matches no path", () => {
    const { scope } = restrictedRead();
    const { request } = restrictCohortRequest(scope, { action: "list", filters: { campaign_path: ["past-life"] } });
    const params: Record<string, unknown> = {};
    buildMaterializedCohortListQuery(request, ACTIVE, params, "ready", scope);
    expect(params.p_mcp_0).toBe(OUT_OF_SCOPE_SENTINEL);
  });

  it("asserts every explicit key that is present (even the one details ignores)", () => {
    const { scope } = restrictedRead();
    const inScope = { cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "soulmate-sketch" };
    expect(() => restrictCohortRequest(scope, { action: "list", cohort_key: inScope })).not.toThrow();
    expect(() => restrictCohortRequest(scope, { action: "details", cohort_key: inScope, funnel_key: { campaign_path: "past-life" } })).toThrow(ScopeForbiddenError);
    expect(() => restrictCohortRequest(scope, { action: "list", funnel_key: "soulmate-sketch" })).toThrow(ScopeForbiddenError);
    expect(() => restrictCohortRequest(scope, { action: "options", funnel_key: {} })).toThrow(ScopeForbiddenError);
  });

  it("all scope: nothing is asserted or intersected", () => {
    const body = { action: "list", cohort_key: { cohort_date: "2026-07-01", funnel: "x", campaign_path: "anything" }, filters: { campaign_path: ["unknown"] } };
    expect(restrictCohortRequest(ALL_SCOPE_SQL, body)).toEqual({ request: body, dropped: 0 });
  });
});

describe("projectCohortsResponseForRestricted", () => {
  it("drops the allocation page, re-applies the redaction and adds meta.access", () => {
    const body = {
      ok: true,
      rows: [],
      fb_allocation_diagnostics: { page: 1 },
      diagnostics: { transactions_scanned: 28_885, source_transactions: 28_885, support_requests: 12, snapshot_status: "current", filters_applied: { campaign_path: true } },
    };
    const projected = projectCohortsResponseForRestricted(body, 2);
    expect(projected).not.toHaveProperty("fb_allocation_diagnostics");
    expect(projected.diagnostics).toEqual({
      transactions_scanned: 0,
      users_scanned: 0,
      source_transactions: null,
      cohort_users: null,
      current_warehouse_version: null,
      current_warehouse_transactions: null,
      support_requests: null,
      support_unique_emails: null,
      counts_redacted: true,
      snapshot_status: "current",
      filters_applied: { campaign_path: true },
    });
    expect(projected.meta).toEqual({ access: { scope: "restricted", dropped_filter_values: 2 } });
    // Pure: the input is untouched.
    expect(body.fb_allocation_diagnostics).toEqual({ page: 1 });
    // Details carry no diagnostics block; meta still lands.
    expect(projectCohortsResponseForRestricted({ ok: true, cohort_key: {} }, 0)).toEqual({ ok: true, cohort_key: {}, meta: { access: { scope: "restricted", dropped_filter_values: 0 } } });
  });
});

// ---- through the real gate -------------------------------------------------------------------

function gateDeps(state: CohortSnapshotState | null, recording: RecordingClickHouse, permissions?: string[]): AccessGateDeps {
  const row = accessRow({ permissions });
  return {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: async () => ({ data: { user: { id: EMPLOYEE, email: "buyer@example.com" } }, error: null }),
    loadAccess: async () => ({ data: row, error: null }),
    workspaceDataKey: async () => ({ data: DATA_KEY, error: null }),
    readEnv: () => undefined,
    createClickHouse: (ctx) => createScopedReader(ctx, recording),
    newRequestId: () => "req-scoped",
    log: () => undefined,
    loadCohortSnapshotState: vi.fn(async () => state),
    now: () => NOW,
  };
}

/** The router's restricted branch, minus Deno: shape, then the materialized runner. */
async function restrictedHandler({ action, body, clickhouse, scope, pg }: AccessRequest<ClickHouseCohortsAction>) {
  const { request, dropped } = restrictCohortRequest(scope, body);
  if (action === "details") return projectCohortsResponseForRestricted(await runMaterializedCohortDetails({ authUserId: DATA_KEY, clickhouse: clickhouse(), request, scope }), dropped);
  const result = action === "options"
    ? await runMaterializedCohortOptions({ authUserId: DATA_KEY, supabase: pg, clickhouse: clickhouse(), request, scope })
    : await runMaterializedCohortList({ authUserId: DATA_KEY, supabase: pg, clickhouse: clickhouse(), request, scope });
  if (!result) throw new ScopeSnapshotNotReadyError("snapshot_missing");
  return projectCohortsResponseForRestricted(result, dropped);
}

async function gateCall(body: Record<string, unknown>, state: CohortSnapshotState | null, permissions?: string[]) {
  const recording = createRecordingClickHouse(warehouse);
  const handler = vi.fn(restrictedHandler);
  const req = new Request("https://edge.test/functions/v1/clickhouse-cohorts", {
    method: "POST",
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const deps = gateDeps(state, recording, permissions);
  // The runners' Postgres reads (subscription overlay, FB aliases) get a double.
  (deps as { pg: unknown }).pg = { ...fakePg().pg, auth: { getUser: vi.fn() } };
  const response = await handleWithAccess(req, CLICKHOUSE_COHORTS_POLICY, handler, deps);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, recording, handler };
}

describe("restricted cohorts through the real gate and policy", () => {
  it("list: 200 with meta.access and redacted diagnostics", async () => {
    const result = await gateCall({ action: "list", filters: { campaign_path: ["soulmate-sketch", "past-life"] } }, readyState());
    expect(result.status).toBe(200);
    expect(result.body.meta).toEqual({ access: { scope: "restricted", dropped_filter_values: 1 } });
    expect(result.body.diagnostics).toMatchObject({ counts_redacted: true, source_transactions: null });
    expect(result.recording.statements.length).toBeGreaterThan(0);
  });

  it("an explicit out-of-scope key: 403 funnel_out_of_scope, zero statements", async () => {
    for (const body of [
      { action: "list", cohort_key: { cohort_date: "2026-07-01", funnel: "f", campaign_path: "past-life" } },
      { action: "details", funnel_key: { campaign_path: "past-life" } },
      { action: "options", funnel_key: { campaign_path: "unknown" } },
    ]) {
      const result = await gateCall(body, readyState());
      expect(result.status, JSON.stringify(body)).toBe(403);
      expect(result.body.error_code).toBe(ACCESS_ERROR.FUNNEL_OUT_OF_SCOPE);
      expect(result.recording.statements).toEqual([]);
    }
  });

  it("no fresh validated snapshot: 409 before the handler, zero statements", async () => {
    for (const state of [null, readyState({ fresh_verified_at: "2026-10-05T00:00:00.000Z" }), readyState({ active_validation: null })]) {
      const result = await gateCall({ action: "list" }, state);
      expect(result.status).toBe(409);
      expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
      expect(result.handler).not.toHaveBeenCalled();
      expect(result.recording.statements).toEqual([]);
    }
  });

  it("a building / failed status with valid active_* columns still serves (readiness ignores status)", async () => {
    const result = await gateCall({ action: "options" }, readyState({ status: "building", diagnostics: { warehouse: {} } }));
    expect(result.status).toBe(200);
  });

  it("list needs cohorts.view itself for a restricted member (reports.view alone is not enough)", async () => {
    const result = await gateCall({ action: "list" }, readyState(), ["reports.view"]);
    expect(result.status).toBe(403);
    expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(result.recording.statements).toEqual([]);
  });

  it("the allocation diagnostics action stays refused", async () => {
    const result = await gateCall({ action: "list", fb_allocation_diagnostics: { page: 1 } }, readyState());
    expect(result.status).toBe(403);
    expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
  });
});

// ---- index.ts (static: it imports esm.sh) ----------------------------------------------------------

describe("clickhouse-cohorts/index.ts restricted branch", () => {
  const source = readFileSync(resolve(process.cwd(), "supabase/functions/clickhouse-cohorts/index.ts"), "utf8");
  const branch = /async function restrictedCohorts\([\s\S]*?\r?\n}\r?\n/.exec(source)?.[0] ?? "";

  it("routes every restricted request to it before any owner code path", () => {
    expect(branch).not.toBe("");
    expect(source).toMatch(/const ch = clickhouse\(\);\s*\n\s*if \(ctx\.restricted\) return await restrictedCohorts\(\{ action, body, authUserId, pg, ch, scope \}\);/);
  });

  it("calls only the materialized runners, shapes the request first, projects the body, never falls back", () => {
    expect(branch).not.toMatch(/runCohort(List|Options|Details)\(/);
    expect(branch).toMatch(/restrictCohortRequest\(scope, input\.body\)/);
    expect(branch.indexOf("restrictCohortRequest(")).toBeLessThan(branch.indexOf("runMaterialized"));
    expect(branch).toMatch(/runMaterializedCohortDetails\(\{[^}]*scope[^}]*\}\)/);
    expect(branch).toMatch(/runMaterializedCohortOptions\(\{[^}]*scope[^}]*\}\)/);
    expect(branch).toMatch(/runMaterializedCohortList\(\{[^}]*scope[^}]*allocationDiagnosticsEnabled: false[^}]*\}\)/);
    expect(branch).toContain('if (!result) throw new ScopeSnapshotNotReadyError("snapshot_missing");');
    expect(branch).toContain("pseudonymizeActiveIdentities(result.rows, hasher)");
    expect(branch.match(/projectCohortsResponseForRestricted\(/g)).toHaveLength(2);
  });
});
