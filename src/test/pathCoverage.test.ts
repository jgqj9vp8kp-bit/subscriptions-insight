// Funnel path coverage (access Phase 2, spec §6 contract 8; pathCoverage.ts):
//   * PATH_COVERAGE_SQL is the agreed statement (tenant-bound, active versions,
//     no settings), and only an all-scope ScopedReader lets it through;
//   * runPathCoverage binds the retired-path arrays in ClickHouse text form
//     (deduplicated, sorted, never empty) and parses JSONEachRow numbers;
//   * coverageSnapshot: no validated active snapshot → null (the API's 409),
//     else current / stale by the gate's own freshness rule;
//   * buildFunnelCoverage: the registry diff (granted, proposed, unregistered,
//     unscopable), totals, reuse alerts, per-funnel sums, funnels without data.
import { afterEach, describe, expect, it } from "vitest";
import { buildAccessContext, parseResolveAccessRow, type AccessContext } from "../../supabase/functions/_shared/access/accessContext.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  COHORT_CLASSIFICATION_VERSION,
  SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT,
  type CohortSnapshotState,
} from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import {
  PATH_COVERAGE_LIMIT,
  PATH_COVERAGE_SQL,
  buildFunnelCoverage,
  clickHouseArrayParam,
  coverageMaxStalenessMs,
  coverageSnapshot,
  isScopablePath,
  runPathCoverage,
  type CoverageRegistryPath,
  type PathCoverageRow,
} from "../../supabase/functions/_shared/clickhouse/pathCoverage.ts";
import { createRecordingClickHouse } from "./support/recordingClickHouse.ts";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const ADMIN_USER = "22222222-2222-4222-8222-222222222222";
const FUNNEL_A = "cccccccc-0000-4000-8000-00000000000a";
const FUNNEL_B = "cccccccc-0000-4000-8000-00000000000b";
const FUNNEL_C = "cccccccc-0000-4000-8000-00000000000c";
const ACTIVE = { warehouse_version: "wv-1", classification_version: COHORT_CLASSIFICATION_VERSION };
const NOW = new Date("2026-10-06T12:00:00.000Z");
const SIX_HOURS = 6 * 3_600_000;

/** The statement as agreed in the spec (whitespace aside). */
const SPEC_SQL = `
SELECT fc.campaign_path path, uniqExactIf(fc.canonical_user_id, NOT startsWith(fc.canonical_user_id,'unknown_user_')) users,
  uniqExactIf(fc.canonical_user_id, startsWith(fc.canonical_user_id,'unknown_user_')) synthetic_users,
  min(fc.cohort_date) first_cohort, max(fc.cohort_date) last_cohort,
  sum(t.net) net_revenue,
  uniqExactIf(fc.canonical_user_id, fc.cohort_date >= transform(fc.campaign_path,{retired_paths:Array(String)},{retired_since:Array(Date)},toDate('2149-06-06'))) users_since_retired
FROM (SELECT canonical_user_id, campaign_path, cohort_date FROM fact_user_cohorts FINAL WHERE auth_user_id={auth_user_id:String}
      AND warehouse_version={warehouse_version:String} AND classification_version={classification_version:String}) fc
LEFT JOIN (SELECT user_id, sumIf(gross_amount_usd, is_success=1) - sum(refund_amount_usd) net FROM analytics_transactions FINAL
      WHERE auth_user_id={auth_user_id:String} GROUP BY user_id) t ON t.user_id = fc.canonical_user_id
GROUP BY path ORDER BY users DESC LIMIT 5000 FORMAT JSONEachRow
`;

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

function contextFor(scope: "all" | "selected", dataKey = DATA_KEY): AccessContext {
  const row = parseResolveAccessRow({
    status: "ok",
    workspace_id: "33333333-3333-4333-8333-333333333333",
    data_key: dataKey,
    member_id: "bbbbbbbb-0000-4000-8000-000000000002",
    user_id: ADMIN_USER,
    email: "admin@example.com",
    display_name: "Admin",
    is_data_owner: false,
    raw_access: false,
    role: { id: "role-1", key: "custom", name: "Role", is_owner: false, permissions: ["admin.users.view", "cohorts.view"] },
    funnel_scope: { mode: scope, funnel_ids: scope === "selected" ? [FUNNEL_A] : [], paths: scope === "selected" ? ["soulmate-sketch"] : [] },
    access_version: "1",
    partition: "p",
  });
  if (!row) throw new Error("bad fixture row");
  return buildAccessContext(row, { kind: "user", userId: ADMIN_USER, email: "admin@example.com" }, "req-cov");
}

function state(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  return {
    auth_user_id: DATA_KEY,
    snapshot_name: "fact_user_cohorts",
    status: "completed",
    active_warehouse_version: "wv-1",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-06T10:00:00.000Z",
    building_warehouse_version: null,
    building_classification_version: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    users_classified: 10,
    rows_inserted: 10,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: null,
    source_unique_users: null,
    last_error: null,
    diagnostics: { validation: { status: "PASS" } },
    active_validation: { status: "PASS", duplicate_users: 0 },
    fresh_verified_at: "2026-10-06T11:00:00.000Z",
    stale_since: null,
    ...overrides,
  };
}

const reg = (id: string, funnelId: string, path: string, status: CoverageRegistryPath["status"], retiredAt: string | null = null): CoverageRegistryPath => ({
  id,
  funnel_id: funnelId,
  path,
  status,
  retired_at: retiredAt,
});

const row = (path: string, users: number, extra: Partial<PathCoverageRow> = {}): PathCoverageRow => ({
  path,
  users,
  synthetic_users: 0,
  net_revenue: 0,
  first_cohort_date: "2026-01-01",
  last_cohort_date: "2026-10-01",
  users_since_retired: 0,
  ...extra,
});

const SNAPSHOT = { status: "current" as const, warehouse_version: "wv-1", generated_at: null };

describe("PATH_COVERAGE_SQL", () => {
  it("is the agreed statement: tenant-bound, active versions, LIMIT, JSONEachRow", () => {
    expect(squash(PATH_COVERAGE_SQL)).toBe(squash(SPEC_SQL));
    expect(PATH_COVERAGE_LIMIT).toBe(5000);
    expect(PATH_COVERAGE_SQL.match(/auth_user_id\s*=\s*\{auth_user_id:String\}/g)).toHaveLength(2);
    expect(PATH_COVERAGE_SQL).not.toMatch(/\bSETTINGS\b|\bsystem\.|\$\{/i);
    // the two protected tables it reads, both under the tenant predicate
    expect([...PATH_COVERAGE_SQL.matchAll(/\b(fact_\w+|analytics_\w+)\b/g)].map((match) => match[1])).toEqual(["fact_user_cohorts", "analytics_transactions"]);
  });
});

describe("runPathCoverage", () => {
  it("binds the active versions and the retired paths (deduplicated, earliest date, sorted) through an all-scope reader", async () => {
    const recording = createRecordingClickHouse(() => [
      { path: "b-path", users: "12", synthetic_users: "1", first_cohort: "2026-01-02", last_cohort: "2026-09-30", net_revenue: "99.5", users_since_retired: "4" },
      { path: "", users: 0, synthetic_users: "3", first_cohort: "", last_cohort: null, net_revenue: null },
      "not a row",
      null,
    ]);
    const ctx = contextFor("all");
    const rows = await runPathCoverage({
      clickhouse: createScopedReader(ctx, recording),
      authUserId: DATA_KEY,
      active: ACTIVE,
      retired: [
        { path: "b-path", since: "2026-09-10T23:30:00-02:00" },
        { path: "a-path", since: "2026-08-01" },
        { path: "b-path", since: "2026-09-12T00:00:00Z" },
        { path: "c-path", since: "not a date" },
        { path: "", since: "2026-01-01" },
      ],
    });
    expect(recording.statements).toEqual([
      {
        kind: "query",
        query: PATH_COVERAGE_SQL,
        params: {
          auth_user_id: DATA_KEY,
          warehouse_version: "wv-1",
          classification_version: COHORT_CLASSIFICATION_VERSION,
          retired_paths: "['a-path','b-path']",
          retired_since: "['2026-08-01','2026-09-11']",
        },
        format: "JSONEachRow",
      },
    ]);
    expect(ctx.violations).toEqual([]);
    expect(rows).toEqual([
      { path: "b-path", users: 12, synthetic_users: 1, net_revenue: 99.5, first_cohort_date: "2026-01-02", last_cohort_date: "2026-09-30", users_since_retired: 4 },
      { path: "", users: 0, synthetic_users: 3, net_revenue: 0, first_cohort_date: null, last_cohort_date: null, users_since_retired: 0 },
    ]);
  });

  it("binds a pair transform() can never use when nothing is retired", async () => {
    const recording = createRecordingClickHouse();
    await runPathCoverage({ clickhouse: recording, authUserId: DATA_KEY, active: ACTIVE, retired: [] });
    expect(recording.statements[0].params).toMatchObject({ retired_paths: "['']", retired_since: "['2149-06-06']" });
  });

  it("is refused by a funnel-restricted reader (all-scope only): ScopeViolation, nothing reaches the warehouse", async () => {
    const recording = createRecordingClickHouse();
    const ctx = contextFor("selected");
    await expect(runPathCoverage({ clickhouse: createScopedReader(ctx, recording), authUserId: DATA_KEY, active: ACTIVE, retired: [] })).rejects.toBeInstanceOf(
      ScopeViolation,
    );
    expect(ctx.violations).toEqual(["restricted_protected_table:fact_user_cohorts"]);
    expect(recording.statements).toEqual([]);
  });

  it("propagates a warehouse fault", async () => {
    const recording = createRecordingClickHouse(() => {
      throw new Error("ClickHouse HTTP 500");
    });
    await expect(runPathCoverage({ clickhouse: recording, authUserId: DATA_KEY, active: ACTIVE, retired: [] })).rejects.toThrow("ClickHouse HTTP 500");
  });
});

describe("helpers", () => {
  it("isScopablePath mirrors the funnel_paths CHECK", () => {
    for (const path of ["a", "a-b-1", "2024", "a".repeat(200)]) expect(isScopablePath(path), path).toBe(true);
    for (const path of ["", "unknown", "Soulmate", "/x", "a--b", "-a", "a-", "a_b", "a b", "a".repeat(201), "тест"]) expect(isScopablePath(path), path).toBe(false);
  });

  it("clickHouseArrayParam renders quoted, escaped array literals", () => {
    expect(clickHouseArrayParam([])).toBe("[]");
    expect(clickHouseArrayParam(["a-b", "2026-01-01"])).toBe("['a-b','2026-01-01']");
    expect(clickHouseArrayParam(["it's", "back\\slash"])).toBe("['it\\'s','back\\\\slash']");
  });

  describe("coverageMaxStalenessMs", () => {
    const previous = process.env.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS;
    afterEach(() => {
      if (previous === undefined) delete process.env.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS;
      else process.env.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS = previous;
    });

    it("uses the gate's env bound, default 6 h, ignoring junk", () => {
      delete process.env.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS;
      expect(coverageMaxStalenessMs()).toBe(SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT * 3_600_000);
      process.env.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS = "12";
      expect(coverageMaxStalenessMs()).toBe(12 * 3_600_000);
      for (const junk of ["0", "-1", "abc"]) {
        process.env.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS = junk;
        expect(coverageMaxStalenessMs(), junk).toBe(SIX_HOURS);
      }
    });
  });
});

describe("coverageSnapshot", () => {
  const at = { now: NOW, maxStalenessMs: SIX_HOURS };

  it("current: validated, verified within the bound, no newer fingerprint seen", () => {
    expect(coverageSnapshot(state(), at)).toEqual({
      active: ACTIVE,
      snapshot: { status: "current", warehouse_version: "wv-1", generated_at: "2026-10-06T10:00:00.000Z" },
    });
    // A running rebuild overwrites status / diagnostics, never the active_* columns.
    expect(coverageSnapshot(state({ status: "building", diagnostics: {} }), at)?.snapshot.status).toBe("current");
  });

  it("stale: verified too long ago, never verified, a newer fingerprint seen, or an older classifier", () => {
    for (const overrides of [
      { fresh_verified_at: "2026-10-06T05:59:59.000Z" },
      { fresh_verified_at: null },
      { stale_since: "2026-10-06T11:30:00.000Z" },
      { active_classification_version: "cohort_classifier_v2" },
    ] as Array<Partial<CohortSnapshotState>>) {
      const result = coverageSnapshot(state(overrides), at);
      expect(result?.snapshot.status, JSON.stringify(overrides)).toBe("stale");
      expect(result?.active.warehouse_version).toBe("wv-1");
    }
  });

  it("null (409 upstream): no row, no active versions, active validation not PASS, duplicates", () => {
    expect(coverageSnapshot(null, at)).toBeNull();
    expect(coverageSnapshot(state({ active_warehouse_version: null }), at)).toBeNull();
    expect(coverageSnapshot(state({ active_classification_version: null }), at)).toBeNull();
    expect(coverageSnapshot(state({ active_validation: { status: "FAIL" } }), at)).toBeNull();
    expect(coverageSnapshot(state({ duplicate_users: 2 }), at)).toBeNull();
    // Pre-Phase-2 rows (no active_validation yet): diagnostics.validation counts
    // only while status is completed — served, but stale, since the gate would
    // still refuse a restricted read.
    expect(coverageSnapshot(state({ active_validation: undefined }), at)?.snapshot.status).toBe("stale");
    expect(coverageSnapshot(state({ active_validation: undefined, status: "failed" }), at)).toBeNull();
  });
});

describe("buildFunnelCoverage", () => {
  const funnels = [
    {
      id: FUNNEL_A,
      paths: [reg("1", FUNNEL_A, "soulmate-sketch", "active"), reg("2", FUNNEL_A, "soulmate-old", "retired", "2026-09-01T00:00:00Z"), reg("9", FUNNEL_A, "shared-path", "proposed")],
    },
    // funnel_id left empty in an embed row: the parent's id is used
    { id: FUNNEL_B, paths: [reg("3", "", "past-life", "active"), reg("8", FUNNEL_B, "shared-path", "proposed"), reg("5", FUNNEL_B, "gone", "revoked")] },
    { id: FUNNEL_C, paths: [] },
  ];

  it("classifies each anchor path against the registry", () => {
    const coverage = buildFunnelCoverage({
      rows: [
        row("gone", 1),
        row("soulmate-sketch", 50, { synthetic_users: 1, net_revenue: 100.006 }),
        row("soulmate-old", 7, { users_since_retired: 2, net_revenue: 10 }),
        row("shared-path", 6, { net_revenue: 1 }),
        row("unknown", 4, { synthetic_users: 3, net_revenue: 2 }),
        row("past-life", 0, { synthetic_users: 5 }),
      ],
      funnels,
      snapshot: SNAPSHOT,
    });
    expect(coverage.ok).toBe(true);
    expect(coverage.snapshot).toEqual(SNAPSHOT);
    expect(coverage.paths.map((entry) => [entry.path, entry.state, entry.path_status, entry.funnel_id, entry.path_id])).toEqual([
      ["soulmate-sketch", "granted", "active", FUNNEL_A, "1"],
      ["soulmate-old", "granted", "retired", FUNNEL_A, "2"],
      ["shared-path", "proposed", "proposed", null, null],
      ["unknown", "unscopable", null, null, null],
      ["gone", "unregistered", "revoked", null, null],
      ["past-life", "granted", "active", FUNNEL_B, "3"],
    ]);
    expect(coverage.paths[2].proposals).toEqual([
      { path_id: "8", funnel_id: FUNNEL_B },
      { path_id: "9", funnel_id: FUNNEL_A },
    ]);
    expect(coverage.paths[0]).toMatchObject({ net_revenue: 100.01, users_since_retired: null, proposals: [] });
    expect(coverage.paths[1].users_since_retired).toBe(2);
    expect(coverage.totals).toEqual({
      users: 68,
      synthetic_users: 9,
      registered_users: 57,
      registered_pct: 83.82,
      net_revenue: 113.01,
      registered_net_revenue: 110.01,
    });
    expect(coverage.reuse_alerts).toEqual([{ path: "soulmate-old", funnel_id: FUNNEL_A, path_id: "2", retired_at: "2026-09-01T00:00:00Z", users_since_retired: 2 }]);
    expect(coverage.funnels).toEqual([
      { funnel_id: FUNNEL_A, users: 57, net_revenue: 110.01, granted_paths: 2 },
      { funnel_id: FUNNEL_B, users: 0, net_revenue: 0, granted_paths: 1 },
      { funnel_id: FUNNEL_C, users: 0, net_revenue: 0, granted_paths: 0 },
    ]);
    expect(coverage.registry_without_data).toEqual([FUNNEL_B, FUNNEL_C]);
  });

  it("keeps proposals listed on a granted path, and never lists a registry row for an unscopable path", () => {
    const coverage = buildFunnelCoverage({
      rows: [row("soulmate-sketch", 3), row("Soulmate-Sketch", 2)],
      funnels: [{ id: FUNNEL_A, paths: [reg("1", FUNNEL_A, "soulmate-sketch", "active")] }, { id: FUNNEL_B, paths: [reg("7", FUNNEL_B, "soulmate-sketch", "proposed")] }],
      snapshot: SNAPSHOT,
    });
    expect(coverage.paths[0]).toMatchObject({ state: "granted", funnel_id: FUNNEL_A, proposals: [{ path_id: "7", funnel_id: FUNNEL_B }] });
    expect(coverage.paths[1]).toMatchObject({ path: "Soulmate-Sketch", state: "unscopable", proposals: [] });
  });

  it("raises no reuse alert without new users or without a retirement date", () => {
    const coverage = buildFunnelCoverage({
      rows: [row("old-a", 5, { users_since_retired: 0 }), row("old-b", 5, { users_since_retired: 3 })],
      funnels: [{ id: FUNNEL_A, paths: [reg("1", FUNNEL_A, "old-a", "retired", "2026-09-01T00:00:00Z"), reg("2", FUNNEL_A, "old-b", "retired", null)] }],
      snapshot: SNAPSHOT,
    });
    expect(coverage.reuse_alerts).toEqual([]);
    expect(coverage.paths.map((entry) => entry.users_since_retired)).toEqual([0, 3]);
  });

  it("never rounds partial coverage up to 100 %, and an empty snapshot counts as fully registered", () => {
    const rows = [row("a", 99_999), row("b", 1)];
    const partial = buildFunnelCoverage({ rows, funnels: [{ id: FUNNEL_A, paths: [reg("1", FUNNEL_A, "a", "active")] }], snapshot: SNAPSHOT });
    expect(partial.totals.registered_pct).toBe(99.99);
    const empty = buildFunnelCoverage({ rows: [], funnels: [], snapshot: SNAPSHOT });
    expect(empty.totals).toEqual({ users: 0, synthetic_users: 0, registered_users: 0, registered_pct: 100, net_revenue: 0, registered_net_revenue: 0 });
    expect(empty).toMatchObject({ paths: [], reuse_alerts: [], funnels: [], registry_without_data: [] });
  });
});
