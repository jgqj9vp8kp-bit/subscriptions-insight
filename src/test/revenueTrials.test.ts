// Daily trials (clickhouse-revenue action trials_daily): the SQL discipline of
// the two statements, the request rules (400s, default window, clamp), the
// pure assembly's reconciliation invariants and the bucket completeness rule.
// A trial is one active-snapshot anchor (fact_user_cohorts), so the SQL must
// never touch analytics_transactions; the assembly must reconcile both
// dimensions with the totals on every day.
import { describe, expect, it, vi } from "vitest";
import {
  assembleTrialsDaily,
  assertTrialsInvariants,
  bucketStart,
  buildTrialsDailySql,
  buildTrialsDataThroughSql,
  normalizeTrialsRequest,
  parseTrialsDataThrough,
  RevenueRequestError,
  runRevenueTrialsDaily,
  trialsAxis,
  trialsAxisState,
  trialsWindow,
  TRIALS_DEFAULT_SPAN_DAYS,
  TRIALS_MAX_SPAN_DAYS,
  type RevenueTrialsDaily,
  type TrialsGroupRow,
} from "@/services/revenueIntelligence";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

const TODAY = "2026-10-15"; // a Thursday
const NOW = new Date(`${TODAY}T12:00:00.000Z`);
const SNAPSHOT = { warehouse_version: "wh", classification_version: "cv" };

function addDays(day: string, days: number): string {
  const dateObj = new Date(`${day}T00:00:00Z`);
  dateObj.setUTCDate(dateObj.getUTCDate() + days);
  return dateObj.toISOString().slice(0, 10);
}

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** The tenant-wide counters of the snapshot state carry this sentinel: it must
 * never reach a trials body. */
const TENANT_SENTINEL = 987654;

function activeSnapshotSupabase(): SupabaseLikeClient {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: {
            status: "completed",
            active_warehouse_version: "wh",
            active_classification_version: "cv",
            users_classified: TENANT_SENTINEL,
            rows_inserted: TENANT_SENTINEL,
            source_transactions: TENANT_SENTINEL,
            source_unique_users: TENANT_SENTINEL,
            duplicate_users: 0,
            diagnostics: { validation: { status: "PASS", duplicate_users: 0, dynamic_users: 10, materialized_users: 10 } },
          },
          error: null,
        }),
      };
      return builder as never;
    },
  };
}

function emptySnapshotSupabase(): SupabaseLikeClient {
  return {
    from() {
      const builder = { select: () => builder, eq: () => builder, maybeSingle: async () => ({ data: null, error: null }) };
      return builder as never;
    },
  };
}

type Logged = { query: string; params: Record<string, unknown> };

function recordingClickhouse(log: Logged[], respond: (query: string) => unknown[] = () => []): ClickHouseClientLike {
  return {
    command: async () => undefined,
    insert: async () => undefined,
    query: async (input: { query: string; query_params?: Record<string, unknown> }) => {
      log.push({ query: input.query, params: { ...(input.query_params ?? {}) } });
      const rows = respond(input.query);
      return { json: async () => rows };
    },
  };
}

// ---- SQL ------------------------------------------------------------------------

describe("SQL discipline", () => {
  it("S-A reads the active snapshot rows only: tenant + version placeholders, a range scan, no transactions, no JOIN", () => {
    const params: Record<string, unknown> = { warehouse_version: "wh", classification_version: "cv" };
    const sql = buildTrialsDailySql(params, "owner-1", { prevFrom: "2026-09-16", from: "2026-09-26", to: "2026-10-05" }, "day",
      "AND fc.campaign_path IN ({p_mcp_0:String}) AND fc.country IN ({p_mcountry_0:String})");
    expect(sql).toContain("FROM fact_user_cohorts AS fc FINAL");
    expect(sql).toContain("fc.auth_user_id = {auth_user_id:String}");
    expect(sql).toContain("fc.warehouse_version = {warehouse_version:String}");
    expect(sql).toContain("fc.classification_version = {classification_version:String}");
    expect(sql).toContain("fc.cohort_date >= toDate({tr_prev_from:String})");
    expect(sql).toContain("fc.cohort_date <= toDate({tr_to:String})");
    expect(sql).toContain("uniqExact(fc.canonical_user_id) trials");
    expect(sql).toContain("if(fc.cohort_date >= toDate({tr_from:String}), toString(fc.cohort_date), 'prev') bkt");
    expect(sql).toContain("fc.campaign_path IN ({p_mcp_0:String}) AND fc.country IN ({p_mcountry_0:String})");
    expect(sql).toContain("GROUP BY bkt, cpath, geo");
    expect(sql).not.toContain("analytics_transactions");
    expect(sql).not.toMatch(/\bJOIN\b/);
    // The raw country: no upper() / trim on the GEO key.
    expect(sql).toContain("fc.country geo");
    expect(sql).not.toMatch(/upper|trim/i);
    expect(params).toEqual({
      warehouse_version: "wh", classification_version: "cv", auth_user_id: "owner-1",
      tr_prev_from: "2026-09-16", tr_from: "2026-09-26", tr_to: "2026-10-05",
    });
  });

  it("S-A at week grain buckets by ISO Monday, the same rule as bucketStart", () => {
    const sql = buildTrialsDailySql({}, "owner-1", { prevFrom: "2026-08-31", from: "2026-09-28", to: "2026-10-25" }, "week");
    expect(sql).toContain("toString(toStartOfWeek(fc.cohort_date, 1))");
  });

  it("S-B reads the import cut-off of the snapshot, without member filters", () => {
    const params: Record<string, unknown> = {};
    const sql = buildTrialsDataThroughSql(params, "owner-1");
    expect(sql).toContain("SELECT toString(max(fc.trial_event_time)) data_through, count() n");
    expect(sql).toContain("FROM fact_user_cohorts AS fc FINAL");
    expect(sql).toContain("fc.auth_user_id = {auth_user_id:String}");
    expect(sql).toContain("{warehouse_version:String}");
    expect(sql).not.toContain("p_m");
    expect(params).toEqual({ auth_user_id: "owner-1" });
  });

  it("parses the cut-off: ISO UTC, null for an empty snapshot, the zero value or garbage", () => {
    expect(parseTrialsDataThrough({ data_through: "2026-10-13 14:20:05.123", n: "42" })).toBe("2026-10-13T14:20:05.123Z");
    expect(parseTrialsDataThrough({ data_through: "2026-10-13 14:20:05", n: 1 })).toBe("2026-10-13T14:20:05.000Z");
    expect(parseTrialsDataThrough({ data_through: "2026-10-13 14:20:05.123", n: "0" })).toBeNull();
    expect(parseTrialsDataThrough({ data_through: "1970-01-01 00:00:00.000", n: 3 })).toBeNull();
    expect(parseTrialsDataThrough({ data_through: "not a date", n: 3 })).toBeNull();
    expect(parseTrialsDataThrough(undefined)).toBeNull();
  });
});

// ---- request --------------------------------------------------------------------

describe("normalizeTrialsRequest", () => {
  it("defaults to the last TRIALS_DEFAULT_SPAN_DAYS days to today, day grain, no filters", () => {
    const req = normalizeTrialsRequest({ action: "trials_daily" }, TODAY);
    expect(req).toMatchObject({ action: "trials_daily", dateTo: TODAY, dateFrom: addDays(TODAY, -(TRIALS_DEFAULT_SPAN_DAYS - 1)), bucket: "day", filtersActive: false });
  });

  it("clamps a future date_to to today instead of refusing it", () => {
    expect(normalizeTrialsRequest({ date_from: "2026-10-01", date_to: "2026-12-31" }, TODAY)).toMatchObject({ dateFrom: "2026-10-01", dateTo: TODAY });
  });

  it("refuses a bad day, a reversed window, a window over the limit and the month bucket (400)", () => {
    for (const request of [
      { date_from: "2026/10/01" },
      { date_to: "2026-02-30" },
      { date_from: "2026-13-01" },
      { date_from: "2026-10-10", date_to: "2026-10-01" },
      { date_from: addDays(TODAY, -TRIALS_MAX_SPAN_DAYS), date_to: TODAY },
      { bucket: "month" as const },
    ]) {
      expect(() => normalizeTrialsRequest(request, TODAY), JSON.stringify(request)).toThrow(RevenueRequestError);
    }
    expect(() => normalizeTrialsRequest({ date_from: addDays(TODAY, -TRIALS_MAX_SPAN_DAYS), date_to: TODAY }, TODAY)).toThrow(/limited to 180 days/);
    expect(normalizeTrialsRequest({ date_from: addDays(TODAY, -(TRIALS_MAX_SPAN_DAYS - 1)), date_to: TODAY }, TODAY).dateFrom).toBe(addDays(TODAY, -179));
  });

  it("week stays week, anything else is day; member filters use the Cohorts semantics", () => {
    expect(normalizeTrialsRequest({ bucket: "week" }, TODAY).bucket).toBe("week");
    expect(normalizeTrialsRequest({ bucket: "day" }, TODAY).bucket).toBe("day");
    const req = normalizeTrialsRequest({ filters: { campaign_path: [" path-a ", "path-a", ""], country: ["MX"] } }, TODAY);
    expect(req.filters.campaign_path).toEqual(["path-a"]);
    expect(req.filters.country).toEqual(["MX"]);
    expect(req.filtersActive).toBe(true);
  });

  it("aligns the window to whole buckets and derives the previous equal-length window", () => {
    expect(trialsWindow("2026-10-01", "2026-10-15", "day")).toEqual({ effFrom: "2026-10-01", effTo: "2026-10-15", prevFrom: "2026-09-16", prevTo: "2026-09-30" });
    // Wed 2026-10-07 .. Thu 2026-10-15 → Mon 10-05 .. Sun 10-18 (14 days).
    expect(trialsWindow("2026-10-07", TODAY, "week")).toEqual({ effFrom: "2026-10-05", effTo: "2026-10-18", prevFrom: "2026-09-21", prevTo: "2026-10-04" });
  });
});

// ---- runner ---------------------------------------------------------------------

describe("runRevenueTrialsDaily", () => {
  it("owner: exactly two statements (cut-off, then trials) with the active versions; data_through parsed", async () => {
    const log: Logged[] = [];
    const clickhouse = recordingClickhouse(log, (query) => (query.includes("data_through")
      ? [{ data_through: "2026-10-14 09:30:00.000", n: "120" }]
      : [
        { bkt: "2026-10-13", cpath: "path-a", geo: "MX", trials: "4" },
        { bkt: "2026-10-14", cpath: "path-a", geo: "", trials: "1" },
        { bkt: "prev", cpath: "path-a", geo: "MX", trials: "2" },
      ]));
    const result = await runRevenueTrialsDaily({
      authUserId: "owner-1", supabase: activeSnapshotSupabase(), clickhouse, now: NOW,
      request: { action: "trials_daily", date_from: "2026-10-12", date_to: TODAY, filters: { campaign_path: ["path-a"], country: ["MX"] } },
    });
    expect(log).toHaveLength(2);
    expect(log[0].query).toContain("max(fc.trial_event_time)");
    expect(log[0].params).toEqual({ auth_user_id: "owner-1", warehouse_version: "wh", classification_version: "cv" });
    expect(log[1].query).toContain("uniqExact(fc.canonical_user_id) trials");
    expect(log[1].query).toContain("fc.campaign_path IN ({p_mcp_0:String})");
    expect(log[1].query).toContain("fc.country IN ({p_mcountry_0:String})");
    expect(log[1].params).toMatchObject({
      auth_user_id: "owner-1", warehouse_version: "wh", classification_version: "cv",
      tr_prev_from: "2026-10-08", tr_from: "2026-10-12", tr_to: TODAY, p_mcp_0: "path-a", p_mcountry_0: "MX",
    });
    expect(result).toMatchObject({
      ok: true, source: "clickhouse", action: "trials_daily", bucket: "day",
      date_from: "2026-10-12", date_to: TODAY, prev_from: "2026-10-08", prev_to: "2026-10-11",
      axis: ["2026-10-12", "2026-10-13", "2026-10-14", TODAY],
      axis_state: ["complete", "complete", "partial", "no_data"],
      data_through: "2026-10-14T09:30:00.000Z",
      totals: { trials: 5, prev_trials: 2, daily: [0, 4, 1, 0], unknown_funnel: 0, unknown_geo: 1 },
    });
    expect(result.diagnostics).toEqual({ snapshot_warehouse_version: "wh", snapshot_classification_version: "cv", trials_scanned: 7, filters_active: true, note: "" });
    // Never a tenant-wide counter of the snapshot state, nor S-B's row count.
    expect(JSON.stringify(result)).not.toMatch(/users_classified|rows_inserted|"120"/);
    expect(JSON.stringify(result)).not.toContain(String(TENANT_SENTINEL));
  });

  it("returns the not-ready body (HTTP 200, ok:false) without touching the warehouse", async () => {
    const log: Logged[] = [];
    const result = await runRevenueTrialsDaily({ authUserId: "u", supabase: emptySnapshotSupabase(), clickhouse: recordingClickhouse(log), request: { action: "trials_daily" }, now: NOW });
    expect(result).toMatchObject({
      ok: false, action: "trials_daily", error: "cohort_snapshot_not_ready", axis: [], by_funnel: [], by_country: [], data_through: null,
      totals: { trials: 0, prev_trials: 0, daily: [], unknown_funnel: 0, unknown_geo: 0 },
    });
    expect(log).toEqual([]);
  });

  it("validates before any I/O: no snapshot-state read, no ClickHouse statement", async () => {
    const log: Logged[] = [];
    const from = vi.fn(() => {
      throw new Error("no Postgres read before validation");
    });
    await expect(runRevenueTrialsDaily({ authUserId: "u", supabase: { from } as never, clickhouse: recordingClickhouse(log), request: { action: "trials_daily", bucket: "month" }, now: NOW }))
      .rejects.toBeInstanceOf(RevenueRequestError);
    expect(from).not.toHaveBeenCalled();
    expect(log).toEqual([]);
  });
});

// ---- assembly -------------------------------------------------------------------

const ROWS: TrialsGroupRow[] = [
  { bkt: "2026-10-01", cpath: "path-a", geo: "MX", trials: 5 },
  { bkt: "2026-10-01", cpath: "path-a", geo: "", trials: 2 },
  { bkt: "2026-10-01", cpath: "path-a", geo: "AR", trials: 1 },
  { bkt: "2026-10-02", cpath: "path-a", geo: "CO", trials: 3 },
  { bkt: "2026-10-03", cpath: "path-a", geo: "BR", trials: 1 },
  { bkt: "2026-10-02", cpath: "", geo: "MX", trials: 1 },
  { bkt: "2026-10-03", cpath: "unknown", geo: "PE", trials: 4 },
  { bkt: "2026-10-03", cpath: "path-b", geo: "mx", trials: 1 },
  { bkt: "2026-10-03", cpath: "path-b", geo: "  ", trials: 1 },
  { bkt: "prev", cpath: "path-a", geo: "MX", trials: 6 },
  { bkt: "prev", cpath: "path-stopped", geo: "US", trials: 9 },
  // Off the axis (would mean bucketStart / toStartOfWeek disagree): dropped from cells.
  { bkt: "2026-09-15", cpath: "path-a", geo: "MX", trials: 7 },
];

function assemble(rows: readonly TrialsGroupRow[] = ROWS, overrides: Partial<Parameters<typeof assembleTrialsDaily>[0]> = {}) {
  return assembleTrialsDaily({
    rows, bucket: "day", effFrom: "2026-10-01", effTo: "2026-10-03", prevFrom: "2026-09-28", prevTo: "2026-09-30",
    dataThrough: "2026-10-03T23:30:00.000Z", today: TODAY, restricted: false, snapshot: SNAPSHOT, filtersActive: false,
    ...overrides,
  });
}

function expectInvariants(result: Pick<RevenueTrialsDaily, "axis" | "totals" | "by_funnel" | "by_country">) {
  const { totals } = result;
  expect(sum(totals.daily)).toBe(totals.trials);
  for (const rows of [result.by_funnel, result.by_country]) {
    expect(sum(rows.map((row) => row.trials))).toBe(totals.trials);
    expect(sum(rows.map((row) => row.prev_trials))).toBe(totals.prev_trials);
    totals.daily.forEach((value, index) => expect(sum(rows.map((row) => row.cells[index]))).toBe(value));
    for (const row of rows) {
      expect(row.cells).toHaveLength(result.axis.length);
      expect(sum(row.mix.map((entry) => entry.trials)) + row.mix_unknown).toBeLessThanOrEqual(row.trials);
    }
  }
}

describe("assembleTrialsDaily", () => {
  it("reconciles both dimensions with the totals on every day and in the previous window", () => {
    const result = assemble();
    expectInvariants(result);
    expect(result.axis).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(result.totals).toEqual({ trials: 19, prev_trials: 15, daily: [8, 4, 7], unknown_funnel: 5, unknown_geo: 3 });
    // Off-axis rows count in trials_scanned only.
    expect(result.diagnostics.trials_scanned).toBe(19 + 15 + 7);
  });

  it("maps '' / 'unknown' paths and blank countries to Unknown, keeps raw country codes apart", () => {
    const result = assemble();
    expect(result.by_funnel.map((row) => row.key)).toEqual(["path-a", "Unknown", "path-b", "path-stopped"]);
    expect(result.by_funnel.find((row) => row.key === "Unknown")).toMatchObject({ trials: 5, cells: [0, 1, 4] });
    const countries = Object.fromEntries(result.by_country.map((row) => [row.key, row.trials]));
    expect(countries).toEqual({ MX: 6, PE: 4, CO: 3, Unknown: 3, AR: 1, BR: 1, mx: 1, US: 0 });
  });

  it("sorts trials desc, previous desc, key asc, and keeps a stopped key (previous window only)", () => {
    const result = assemble();
    expect(result.by_country.map((row) => row.key)).toEqual(["MX", "PE", "CO", "Unknown", "AR", "BR", "mx", "US"]);
    expect(result.by_funnel.find((row) => row.key === "path-stopped")).toEqual({
      key: "path-stopped", trials: 0, prev_trials: 9, cells: [0, 0, 0], mix: [], mix_unknown: 0,
    });
  });

  it("a tie on trials sorts by the previous window before the key (both dimensions)", () => {
    const result = assemble([
      { bkt: "2026-10-01", cpath: "path-a", geo: "AR", trials: 1 },
      { bkt: "2026-10-02", cpath: "path-b", geo: "BR", trials: 1 },
      // The alphabetically later key had more trials before.
      { bkt: "prev", cpath: "path-b", geo: "BR", trials: 2 },
    ]);
    expect(result.by_country.map((row) => [row.key, row.trials, row.prev_trials])).toEqual([["BR", 1, 2], ["AR", 1, 0]]);
    expect(result.by_funnel.map((row) => [row.key, row.trials, row.prev_trials])).toEqual([["path-b", 1, 2], ["path-a", 1, 0]]);
  });

  it("mix: top 3 of the other dimension in the current window, Unknown excluded and counted apart", () => {
    const result = assemble();
    const pathA = result.by_funnel.find((row) => row.key === "path-a")!;
    expect(pathA).toMatchObject({ trials: 12, prev_trials: 6, cells: [8, 3, 1] });
    expect(pathA.mix).toEqual([{ key: "MX", trials: 5 }, { key: "CO", trials: 3 }, { key: "AR", trials: 1 }]);
    expect(pathA.mix_unknown).toBe(2);
    const mx = result.by_country.find((row) => row.key === "MX")!;
    expect(mx.mix).toEqual([{ key: "path-a", trials: 5 }]);
    expect(mx.mix_unknown).toBe(1);
  });

  it("no data_through for a restricted member, whatever the input; the restricted axis has no no_data", () => {
    const result = assemble(ROWS, { restricted: true, dataThrough: "2026-10-02T10:00:00.000Z", effTo: TODAY, filtersActive: true });
    expect(result.data_through).toBeNull();
    expect(result.axis_state.every((state) => state !== "no_data")).toBe(true);
    expect(result.axis_state.at(-1)).toBe("partial");
    expect(result.diagnostics.filters_active).toBe(true);
  });

  it("an empty answer is all zeros, still aligned to the axis", () => {
    const result = assemble([]);
    expect(result.totals).toEqual({ trials: 0, prev_trials: 0, daily: [0, 0, 0], unknown_funnel: 0, unknown_geo: 0 });
    expect(result.by_funnel).toEqual([]);
    expect(result.by_country).toEqual([]);
  });

  it("assertTrialsInvariants refuses a response that does not reconcile", () => {
    const result = assemble();
    expect(() => assertTrialsInvariants(result)).not.toThrow();
    const broken = { ...result, by_country: result.by_country.slice(1) };
    expect(() => assertTrialsInvariants(broken)).toThrow(/invariant violated/);
    const shifted = { ...result, totals: { ...result.totals, daily: [result.totals.daily[0] + 1, result.totals.daily[1] - 1, result.totals.daily[2]] } };
    expect(() => assertTrialsInvariants(shifted)).toThrow(/invariant violated/);
  });
});

// ---- completeness ---------------------------------------------------------------

describe("trialsAxisState", () => {
  const days = ["2026-10-12", "2026-10-13", "2026-10-14", TODAY];

  it("before the 23:00 UTC cut-off the import day is partial; later days have no data yet", () => {
    expect(trialsAxisState(days, "day", "2026-10-13T14:20:00.000Z", TODAY, false)).toEqual(["complete", "partial", "no_data", "no_data"]);
  });

  it("at or after 23:00 UTC the import day counts as complete", () => {
    expect(trialsAxisState(days, "day", "2026-10-13T23:10:00.000Z", TODAY, false)).toEqual(["complete", "complete", "no_data", "no_data"]);
    // ... but today is never complete before it is over.
    expect(trialsAxisState(days, "day", `${TODAY}T23:30:00.000Z`, TODAY, false)).toEqual(["complete", "complete", "complete", "partial"]);
  });

  it("the week containing the cut-off is partial", () => {
    expect(trialsAxisState(["2026-09-28", "2026-10-05", "2026-10-12"], "week", "2026-10-13T14:20:00.000Z", TODAY, false))
      .toEqual(["complete", "complete", "partial"]);
    expect(trialsAxisState(["2026-10-05", "2026-10-12"], "week", "2026-10-11T23:30:00.000Z", TODAY, false)).toEqual(["complete", "no_data"]);
  });

  it("restricted: only the bucket containing today is partial, never no_data", () => {
    expect(trialsAxisState(days, "day", null, TODAY, true)).toEqual(["complete", "complete", "complete", "partial"]);
    expect(trialsAxisState(["2026-10-05", "2026-10-12"], "week", null, TODAY, true)).toEqual(["complete", "partial"]);
  });

  it("without a cut-off (empty snapshot) every bucket is no_data", () => {
    expect(trialsAxisState(days, "day", null, TODAY, false)).toEqual(["no_data", "no_data", "no_data", "no_data"]);
  });
});

describe("week buckets: bucketStart agrees with ClickHouse toStartOfWeek(d, 1)", () => {
  /** ClickHouse toStartOfWeek mode 1: Monday-first weeks (1970-01-01 was a Thursday). */
  const toStartOfWeekMonday = (day: string) => {
    const epochDay = Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
    return new Date((epochDay - ((epochDay + 3) % 7)) * 86_400_000).toISOString().slice(0, 10);
  };

  it("on all seven weekdays", () => {
    for (let offset = 0; offset < 7; offset += 1) {
      const day = addDays("2026-10-12", offset);
      expect(bucketStart(day, "week"), day).toBe(toStartOfWeekMonday(day));
      expect(bucketStart(day, "week"), day).toBe("2026-10-12");
    }
    // Across a month and a year boundary too.
    for (const day of ["2026-11-01", "2027-01-01", "2026-12-31", "2026-03-01"]) expect(bucketStart(day, "week"), day).toBe(toStartOfWeekMonday(day));
  });

  it("so week rows land on the axis (nothing dropped)", () => {
    const win = trialsWindow("2026-09-17", TODAY, "week");
    const axis = trialsAxis(win.effFrom, win.effTo, "week");
    const rows: TrialsGroupRow[] = [];
    for (let day = win.effFrom; day <= TODAY; day = addDays(day, 1)) rows.push({ bkt: toStartOfWeekMonday(day), cpath: "path-a", geo: "MX", trials: 1 });
    const merged = new Map<string, TrialsGroupRow>();
    for (const row of rows) merged.set(row.bkt, { ...row, trials: (merged.get(row.bkt)?.trials ?? 0) + 1 });
    const result = assembleTrialsDaily({
      rows: [...merged.values()], bucket: "week", effFrom: win.effFrom, effTo: win.effTo, prevFrom: win.prevFrom, prevTo: win.prevTo,
      dataThrough: `${TODAY}T10:00:00.000Z`, today: TODAY, restricted: false, snapshot: SNAPSHOT, filtersActive: false,
    });
    expect(result.axis).toEqual(axis);
    expect(result.totals.trials).toBe(rows.length);
    expect(result.diagnostics.trials_scanned).toBe(result.totals.trials);
  });
});
