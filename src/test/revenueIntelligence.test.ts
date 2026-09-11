// Revenue Intelligence: the calendar projection's SQL discipline and the
// reconciliation invariants (plan §H, brief §40). The assembly is pure — the
// invariants are tested on realistic daily streams, including the same-bucket
// week/month semantics that must NOT degenerate into same-day.
import { describe, expect, it } from "vitest";
import {
  assembleRevenueBundle,
  bucketStart,
  buildAttributedDailySql,
  buildByAgeSql,
  buildDayBreakdownSql,
  buildSpendDailySql,
  buildUnattributedDailySql,
  bucketEndDay,
  buildByFunnelSql,
  buildByPlanSql,
  normalizeRevenueFilters,
  normalizeRevenueRequest,
  rollupDayCohorts,
  runRevenueDayBreakdown,
  runRevenueIntelligence,
  type AttributedDailyRow,
} from "@/services/revenueIntelligence";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

function attributedDay(over: Partial<AttributedDailyRow> = {}): AttributedDailyRow {
  return {
    day: "2026-09-08",
    gross: 1000, refunds: 50,
    gross_new_day: 400, gross_new_week: 700, gross_new_month: 900,
    refunds_new_day: 10, refunds_new_week: 20, refunds_new_month: 40,
    future_cohort_gross: 0,
    type_trial: 300, type_first_sub: 250, type_renewals: 200, type_upsells: 150, type_tokens: 100,
    paying_users: 40, new_paying_users_day: 15, new_paying_users_week: 25, new_paying_users_month: 35,
    rows_scanned: 60,
    ...over,
  };
}

describe("SQL discipline", () => {
  it("scopes every query by auth user and the ACTIVE snapshot versions", () => {
    for (const build of [buildAttributedDailySql, buildUnattributedDailySql]) {
      const params: Record<string, unknown> = { warehouse_version: "wh", classification_version: "cv" };
      const sql = build(params, "owner-1");
      expect(sql).toContain("auth_user_id = {auth_user_id:String}");
      expect(sql).toContain("warehouse_version = {warehouse_version:String}");
      expect(sql).toContain("classification_version = {classification_version:String}");
      expect(params.auth_user_id).toBe("owner-1");
    }
  });

  it("carries all three same-bucket pairs in ONE daily scan (invariant 15's fuel)", () => {
    const sql = buildAttributedDailySql({}, "owner-1");
    expect(sql).toContain("toDate(et) = c_d) gross_new_day");
    expect(sql).toContain("toStartOfWeek(toDate(et), 1) = toStartOfWeek(c_d, 1)) gross_new_week");
    expect(sql).toContain("toStartOfMonth(toDate(et)) = toStartOfMonth(c_d)) gross_new_month");
    // Canonical revenue formulas — the Cohorts AGGREGATE_MEASURES canon.
    expect(sql).toContain("sumIf(g, is_success = 1) gross");
    expect(sql).toContain("sum(rr) refunds");
  });

  it("classifies over the FULL history (no date window inside the classifier CTEs)", () => {
    const sql = buildAttributedDailySql({}, "owner-1");
    expect(sql).not.toContain("win_from");
    // Windowed slices apply the window OUTSIDE the classified stream.
    const params: Record<string, unknown> = {};
    const age = buildByAgeSql(params, "owner-1", "2026-09-01", "2026-09-08");
    expect(age).toContain("WHERE 1 = 1 AND toDate(et) >= toDate({win_from:String})");
    expect(params.win_from).toBe("2026-09-01");
  });

  it("unattributed stream selects payments OUTSIDE the snapshot, never dropping them", () => {
    const sql = buildUnattributedDailySql({}, "owner-1");
    expect(sql).toContain("user_id NOT IN (SELECT canonical_user_id FROM snapshot_users)");
  });

  it("spend uses the campaign level only (no roll-up double counting)", () => {
    expect(buildSpendDailySql({}, "owner-1")).toContain("level = 'campaign'");
  });

  it("day_breakdown binds the day as a parameter", () => {
    const params: Record<string, unknown> = {};
    const sql = buildDayBreakdownSql(params, "owner-1", "2026-09-08");
    expect(sql).toContain("toDate(et) = toDate({break_day:String})");
    expect(params.break_day).toBe("2026-09-08");
  });

  it("rejects malformed dates and requires date for day_breakdown", () => {
    expect(() => normalizeRevenueRequest({ date_from: "08.09.2026" })).toThrow();
    expect(() => normalizeRevenueRequest({ action: "day_breakdown" })).toThrow();
  });

  it("slice queries pair New/Existing per the requested bucket — never same-day forever", () => {
    // Review finding: the by_funnel/by_plan panels rendered next to the KPI
    // cards must agree with them about what counts as New at every grain.
    const day = buildByFunnelSql({}, "owner-1", null, null, "", "day");
    expect(day).toContain("toDate(et) = c_d) gross_new");
    const week = buildByFunnelSql({}, "owner-1", null, null, "", "week");
    expect(week).toContain("toStartOfWeek(toDate(et), 1) = toStartOfWeek(c_d, 1)) gross_new");
    const month = buildByPlanSql({}, "owner-1", null, null, "", "month");
    expect(month).toContain("toStartOfMonth(toDate(et)) = toStartOfMonth(c_d)) gross_new");
    // existing = successful − new, so future-cohort rows fold into Existing
    // exactly as the bucket rows compute it (never dropped from both columns).
    for (const sql of [day, week, month]) expect(sql).not.toContain("toDate(et) > c_d");
  });

  it("attributed and unattributed streams count only SUCCESSFUL rows as rows_scanned", () => {
    for (const build of [buildAttributedDailySql, buildUnattributedDailySql]) {
      expect(build({}, "owner-1")).toContain("countIf(is_success = 1) rows_scanned");
    }
  });
});

describe("bucketStart", () => {
  it("maps a day to itself, its ISO Monday, and its month start", () => {
    expect(bucketStart("2026-09-08", "day")).toBe("2026-09-08");
    expect(bucketStart("2026-09-08", "week")).toBe("2026-09-07"); // Tue → Mon
    expect(bucketStart("2026-09-07", "week")).toBe("2026-09-07"); // Mon stays
    expect(bucketStart("2026-09-08", "month")).toBe("2026-09-01");
  });

  it("bucketEndDay closes the bucket: same day, ISO Sunday, month's last day", () => {
    expect(bucketEndDay("2026-09-08", "day")).toBe("2026-09-08");
    expect(bucketEndDay("2026-09-08", "week")).toBe("2026-09-13"); // Tue → Sun
    expect(bucketEndDay("2026-09-13", "week")).toBe("2026-09-13"); // Sun stays
    expect(bucketEndDay("2026-09-08", "month")).toBe("2026-09-30");
    expect(bucketEndDay("2026-02-10", "month")).toBe("2026-02-28");
    expect(bucketEndDay("2028-02-10", "month")).toBe("2028-02-29"); // leap year
    expect(bucketEndDay("2026-12-15", "month")).toBe("2026-12-31"); // year boundary
  });
});

describe("reconciliation invariants (assembly)", () => {
  const streams = {
    attributed: [
      attributedDay({ day: "2026-09-07", gross: 800, refunds: 20, gross_new_day: 500, gross_new_week: 600, gross_new_month: 700, refunds_new_day: 5, refunds_new_week: 10, refunds_new_month: 15, type_trial: 500, type_first_sub: 100, type_renewals: 100, type_upsells: 60, type_tokens: 40 }),
      attributedDay({ day: "2026-09-08" }),
    ],
    unattributed: [
      { day: "2026-09-08", gross: 90, refunds: 5, rows_scanned: 3 },
    ],
    spend: [
      { day: "2026-09-07", spend: 300 },
      { day: "2026-09-08", spend: 400 },
    ],
    byFunnel: [
      { key: "soulmate-web", gross: 1500, net: 1440, gross_new: 800, gross_existing: 700 },
      { key: "", gross: 300, net: 290, gross_new: 100, gross_existing: 200 },
    ],
    byPlan: [
      { key: "$9.99", gross: 1400, net: 1350, gross_new: 850, gross_existing: 550 },
      { key: "Unknown", gross: 400, net: 380, gross_new: 50, gross_existing: 350 },
    ],
    byAge: [
      { bucket: "d0", gross: 900, net: 885 },
      { bucket: "d8_30", gross: 900, net: 845 },
    ],
    bucket: "day" as const,
    dateFrom: null,
    dateTo: null,
    snapshot: { warehouse_version: "wh", classification_version: "cv" },
    now: new Date("2026-09-08T12:00:00Z"),
  };
  const bundle = assembleRevenueBundle(streams);

  it("invariant 1-2: gross = new + existing + unattributed = Σ by_type + unattributed, per bucket and totals", () => {
    for (const row of bundle.buckets) {
      expect(row.gross_new + row.gross_existing + row.gross_unattributed).toBeCloseTo(row.gross, 2);
      expect(row.net_new + row.net_existing + row.net_unattributed).toBeCloseTo(row.net, 2);
      const typeSum = row.by_type.trial + row.by_type.first_subscription + row.by_type.renewals + row.by_type.upsells + row.by_type.tokens;
      expect(typeSum + row.gross_unattributed).toBeCloseTo(row.gross, 2);
    }
    const t = bundle.totals;
    expect(t.gross_new + t.gross_existing + t.gross_unattributed).toBeCloseTo(t.gross, 2);
  });

  it("invariant 3-4: funnel and plan slices reconcile via explicit Unknown and Unattributed rows", () => {
    const funnelSum = bundle.by_funnel.reduce((sum, row) => sum + row.gross, 0);
    expect(funnelSum).toBeCloseTo(bundle.totals.gross, 2);
    expect(bundle.by_funnel.some((row) => row.key === "Unknown")).toBe(true);
    expect(bundle.by_funnel.some((row) => row.key === "Unattributed")).toBe(true);
    const planSum = bundle.by_plan.reduce((sum, row) => sum + row.gross, 0);
    expect(planSum).toBeCloseTo(bundle.totals.gross, 2);
    // Unknown (member without a plan) and Unattributed (no membership) stay distinct.
    expect(bundle.by_plan.filter((row) => row.key === "Unknown" || row.key === "Unattributed")).toHaveLength(2);
  });

  it("invariant 5: age buckets reconcile, d0 == same-day new, unattributed rides its own bucket", () => {
    const ageSum = bundle.by_age.reduce((sum, row) => sum + row.gross, 0);
    expect(ageSum).toBeCloseTo(bundle.totals.gross, 2);
    const d0 = bundle.by_age.find((row) => row.bucket === "d0");
    expect(d0?.gross).toBeCloseTo(bundle.totals.gross_new, 2);
  });

  it("invariant 7 + partial flag: cumulative profit chains and today is partial", () => {
    const [d7, d8] = bundle.buckets;
    expect(d7.cumulative_profit).toBeCloseTo(d7.profit, 2);
    expect(d8.cumulative_profit).toBeCloseTo(d7.profit + d8.profit, 2);
    expect(d7.partial).toBe(false);
    expect(d8.partial).toBe(true);
  });

  it("invariants 14-15: month bucketing preserves totals and switches to same-MONTH pairs", () => {
    const monthly = assembleRevenueBundle({ ...streams, bucket: "month" });
    expect(monthly.buckets).toHaveLength(1);
    const m = monthly.buckets[0];
    expect(m.gross).toBeCloseTo(bundle.totals.gross, 2);
    // Same-month new = 700 + 900, NOT the same-day 500 + 400.
    expect(m.gross_new).toBeCloseTo(1600, 2);
    expect(m.gross_new + m.gross_existing + m.gross_unattributed).toBeCloseTo(m.gross, 2);
  });

  it("cumulative profit accumulates from TRUE history start even when the window slices later days", () => {
    const windowed = assembleRevenueBundle({ ...streams, dateFrom: "2026-09-08", dateTo: "2026-09-08" });
    expect(windowed.buckets).toHaveLength(1);
    const fullD8 = bundle.buckets[1];
    expect(windowed.buckets[0].cumulative_profit).toBeCloseTo(fullD8.cumulative_profit, 2);
    // rows_scanned reports the WINDOW's rows (contract), not the full history:
    // d8 only = 60 attributed + 3 unattributed.
    expect(windowed.diagnostics.rows_scanned).toBe(63);
    expect(bundle.diagnostics.rows_scanned).toBe(123);
  });

  it("diagnostics report attribution coverage honestly", () => {
    expect(bundle.diagnostics.attributed_pct).toBeCloseTo(((1890 - 90) / 1890) * 100, 1);
    expect(bundle.diagnostics.snapshot_warehouse_version).toBe("wh");
  });
});

describe("day breakdown rollup", () => {
  it("names recent cohorts, rolls older into months, then 'older'", () => {
    const byType = { trial: 0, first_subscription: 0, renewals: 0, upsells: 0, tokens: 0 };
    const rows = [
      { cohort_date: "2026-09-08", gross: 500, net: 490, by_type: { ...byType, trial: 500 } },
      { cohort_date: "2026-09-03", gross: 200, net: 195, by_type: { ...byType, renewals: 200 } },
      { cohort_date: "2026-08-20", gross: 120, net: 118, by_type: { ...byType, renewals: 120 } },
      { cohort_date: "2026-08-05", gross: 80, net: 78, by_type: { ...byType, renewals: 80 } },
      { cohort_date: "2026-03-01", gross: 40, net: 40, by_type: { ...byType, renewals: 40 } },
    ];
    const rolled = rollupDayCohorts(rows, "2026-09-08");
    expect(rolled.map((row) => row.cohort)).toEqual(["2026-09-08", "2026-09-03", "2026-08", "older"]);
    expect(rolled.find((row) => row.cohort === "2026-08")?.gross).toBe(200);
    expect(rolled.reduce((sum, row) => sum + row.gross, 0)).toBeCloseTo(940, 2);
  });
});

describe("cohort-grain filters (P8)", () => {
  it("sanitizes filter arrays and reports whether any filter is active", () => {
    const none = normalizeRevenueFilters(undefined);
    expect(none.active).toBe(false);
    const some = normalizeRevenueFilters({ campaign_path: [" path-a ", "path-a", ""], price_plan: ["$9.99"] });
    expect(some.active).toBe(true);
    expect(some.filters.campaign_path).toEqual(["path-a"]);
    expect(some.filters.price_plan).toEqual(["$9.99"]);
    expect(some.filters.refund_status).toBe("all");
  });

  it("embeds the member WHERE inside the classifier's base CTE with bound params", () => {
    const params: Record<string, unknown> = {};
    const sql = buildAttributedDailySql(params, "owner-1", "AND fc.campaign_path IN ({p_mcp_0:String})");
    const baseCte = sql.slice(sql.indexOf("base AS ("), sql.indexOf("pretyped AS ("));
    expect(baseCte).toContain("fc.campaign_path IN ({p_mcp_0:String})");
  });

  const activeSnapshotSupabase = (): SupabaseLikeClient => ({
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({
          data: {
            status: "completed",
            active_warehouse_version: "wh",
            active_classification_version: "cv",
            duplicate_users: 0,
            diagnostics: { validation: { status: "PASS", duplicate_users: 0, dynamic_users: 10, materialized_users: 10 } },
          },
          error: null,
        }),
      };
      return builder as never;
    },
  });

  const recordingClickhouse = (log: Array<{ query: string; params: Record<string, unknown> }>): ClickHouseClientLike => ({
    command: async () => undefined,
    insert: async () => undefined,
    query: async (input: { query: string; query_params?: Record<string, unknown> }) => {
      log.push({ query: input.query, params: input.query_params ?? {} });
      return { json: async () => [] };
    },
  });

  it("an active filter narrows every classified query and EXCLUDES the user-less streams", async () => {
    const log: Array<{ query: string; params: Record<string, unknown> }> = [];
    const result = await runRevenueIntelligence({
      authUserId: "owner-1",
      supabase: activeSnapshotSupabase(),
      clickhouse: recordingClickhouse(log),
      request: { filters: { campaign_path: ["path-a"], price_plan: ["$9.99"] } },
    });
    // Attributed + funnel + plan + age only: no unattributed, no spend query.
    expect(log).toHaveLength(4);
    for (const entry of log) {
      expect(entry.query).toContain("fc.campaign_path IN ({p_mcp_0:String})");
      expect(entry.query).toContain("fc.price_plan IN ({p_mplan_0:String})");
      expect(entry.params.p_mcp_0).toBe("path-a");
      expect(entry.params.p_mplan_0).toBe("$9.99");
    }
    expect(result.ok).toBe(true);
    expect(result.diagnostics.filters_active).toBe(true);
    expect(result.totals.spend).toBe(0);
    expect(result.totals.gross_unattributed).toBe(0);
  });

  it("aligns the slice-query window to WHOLE buckets at week/month grain (invariant 3's fuel)", async () => {
    // 2026-09-02 is a Wednesday, 2026-09-03 a Thursday — both mid-bucket.
    // Before this alignment, live week totals were 54,920 while Σ by_funnel
    // was 46,277: the bucket rows covered full weeks, the slices only the raw
    // window. All windowed streams must see the same expanded span.
    const week: Array<{ query: string; params: Record<string, unknown> }> = [];
    const weekBundle = await runRevenueIntelligence({
      authUserId: "owner-1",
      supabase: activeSnapshotSupabase(),
      clickhouse: recordingClickhouse(week),
      request: { bucket: "week", date_from: "2026-09-02", date_to: "2026-09-03" },
    });
    const weekWindows = week.filter((entry) => "win_from" in entry.params);
    expect(weekWindows.length).toBeGreaterThan(0);
    for (const entry of weekWindows) {
      expect(entry.params.win_from).toBe("2026-08-31"); // ISO Monday
      expect(entry.params.win_to).toBe("2026-09-06"); // ISO Sunday
    }
    expect(weekBundle.date_from).toBe("2026-08-31");
    expect(weekBundle.date_to).toBe("2026-09-06");

    const month: Array<{ query: string; params: Record<string, unknown> }> = [];
    await runRevenueIntelligence({
      authUserId: "owner-1",
      supabase: activeSnapshotSupabase(),
      clickhouse: recordingClickhouse(month),
      request: { bucket: "month", date_from: "2026-09-02", date_to: "2026-09-03" },
    });
    for (const entry of month.filter((e) => "win_from" in e.params)) {
      expect(entry.params.win_from).toBe("2026-09-01");
      expect(entry.params.win_to).toBe("2026-09-30");
    }

    // Day grain stays byte-identical to the request.
    const day: Array<{ query: string; params: Record<string, unknown> }> = [];
    const dayBundle = await runRevenueIntelligence({
      authUserId: "owner-1",
      supabase: activeSnapshotSupabase(),
      clickhouse: recordingClickhouse(day),
      request: { bucket: "day", date_from: "2026-09-02", date_to: "2026-09-03" },
    });
    for (const entry of day.filter((e) => "win_from" in e.params)) {
      expect(entry.params.win_from).toBe("2026-09-02");
      expect(entry.params.win_to).toBe("2026-09-03");
    }
    expect(dayBundle.date_from).toBe("2026-09-02");
  });

  it("no filters → full six-query bundle with filters_active false", async () => {
    const log: Array<{ query: string; params: Record<string, unknown> }> = [];
    const result = await runRevenueIntelligence({
      authUserId: "owner-1",
      supabase: activeSnapshotSupabase(),
      clickhouse: recordingClickhouse(log),
      request: {},
    });
    expect(log).toHaveLength(6);
    expect(log.some((entry) => entry.query.includes("NOT IN (SELECT canonical_user_id"))).toBe(true);
    expect(log.some((entry) => entry.query.includes("level = 'campaign'"))).toBe(true);
    expect(result.diagnostics.filters_active).toBe(false);
  });
});

describe("day breakdown reconciliation", () => {
  it("carries the unattributed revenue in BOTH panels: by_cohort and by_funnel", async () => {
    const supabase: SupabaseLikeClient = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: {
              status: "completed",
              active_warehouse_version: "wh",
              active_classification_version: "cv",
              duplicate_users: 0,
              diagnostics: { validation: { status: "PASS", duplicate_users: 0, dynamic_users: 10, materialized_users: 10 } },
            },
            error: null,
          }),
        };
        return builder as never;
      },
    };
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async (input: { query: string }) => ({
        json: async () =>
          input.query.includes("NOT IN")
            ? [{ gross: "5.5", net: "5.5" }]
            : [{ cohort_date: "2026-09-08", campaign_path: "soulmate-web", gross: "100", net: "98", type_trial: "100", type_first_sub: "0", type_renewals: "0", type_upsells: "0", type_tokens: "0" }],
      }),
    };
    const result = await runRevenueDayBreakdown({
      authUserId: "owner-1", supabase, clickhouse,
      request: { action: "day_breakdown", date: "2026-09-08" },
    });
    expect(result.ok).toBe(true);
    const cohortSum = result.by_cohort.reduce((sum, row) => sum + row.gross, 0);
    const funnelSum = result.by_funnel.reduce((sum, row) => sum + row.gross, 0);
    expect(cohortSum).toBeCloseTo(result.gross, 2);
    // Review finding: by_funnel used to omit the unattributed 5.5, so the two
    // panels on one screen summed to different day grosses.
    expect(funnelSum).toBeCloseTo(result.gross, 2);
    expect(result.by_funnel.some((row) => row.key === "Unattributed")).toBe(true);
  });
});

describe("snapshot gate", () => {
  it("returns cohort_snapshot_not_ready instead of inventing a live fallback", async () => {
    const supabase: SupabaseLikeClient = {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder as never;
      },
    };
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async () => ({ json: async () => [] }),
    };
    const result = await runRevenueIntelligence({ authUserId: "u", supabase, clickhouse, request: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("cohort_snapshot_not_ready");
  });
});
