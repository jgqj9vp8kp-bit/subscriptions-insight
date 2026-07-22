import { describe, expect, it } from "vitest";
import { runFacebookStatsSync, FacebookStatsValidationError, type CapsuledFetcher } from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import { buildFbV2DqChecks, fbV2RowHash, FB_SYNC_RUN_REQUESTS_TABLE } from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Writer.ts";
import {
  FACT_FB_CAMPAIGN_DAILY_TABLE,
  FB_BATCH_REGISTRY_TABLE,
  FB_DQ_RESULTS_TABLE,
  RAW_FACEBOOK_API_RESPONSES_TABLE,
} from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Schema.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

const ENVELOPE = {
  ok: true,
  currency: "USD",
  dataFreshness: { fbStatsTo: "2026-07-15", lastImportAt: "2026-07-15T09:38:45.048Z" },
};

const CAMPAIGN_ROW = {
  dateFrom: "2026-07-14",
  dateTo: "2026-07-14",
  adAccountId: "act_1",
  adAccountName: "Acc",
  campaignId: "120001",
  campaignName: "Alpha",
  spend: 100,
  fbPurchases: 5,
  impressions: 1000,
  clicks: 50,
  outboundClicks: 20,
};

function fetcher(calls: string[] = []): CapsuledFetcher {
  return async (from, to, level) => {
    calls.push(`${level}:${from}..${to}`);
    if (level === "day") {
      return {
        envelope: { ...ENVELOPE, rows: [{ date: "2026-07-14", spend: 100, fbPurchases: 5 }] },
        bytes: 200,
        latencyMs: 4,
      };
    }
    return {
      envelope: { ...ENVELOPE, rows: [{ ...CAMPAIGN_ROW, dateFrom: from, dateTo: to }] },
      bytes: 300,
      latencyMs: 6,
    };
  };
}

interface CapturedInsert {
  table: string;
  values: Record<string, unknown>[];
}

function fakeClickHouse(options: { inserts: CapturedInsert[]; failV2?: boolean; countSequence?: number[] }): ClickHouseClientLike {
  const counts = [...(options.countSequence ?? [0, 1])];
  return {
    command: async () => undefined,
    insert: async (input: { table: string; values: unknown[] }) => {
      if (options.failV2 && input.table !== "fact_facebook_stats") {
        throw new Error("v2 warehouse is down");
      }
      options.inserts.push({ table: input.table, values: input.values as Record<string, unknown>[] });
    },
    query: async ({ query }: { query: string }) => ({
      json: async () => {
        if (query.includes("date_min")) return [{ c: counts[0] ?? 0, date_min: "2026-07-01", date_max: "2026-07-15" }];
        if (query.includes("count() c FROM")) return [{ c: counts.length > 1 ? counts.shift() : counts[0] }];
        return [];
      },
    }),
  } as unknown as ClickHouseClientLike;
}

function fakeSupabase(pgInserts: Array<{ table: string; values: unknown }> = []): SupabaseLikeClient {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async (value: unknown) => ({ data: value, error: null }),
        insert: async (values: unknown) => {
          pgInserts.push({ table, values });
          return { data: null, error: null };
        },
        update: () => builder,
      };
      return builder as never;
    },
  };
}

describe("Warehouse V2 dual-write (Phase 1)", () => {
  it("writes raw responses, per-grain facts, registry transitions and DQ beside the V1 pipeline", async () => {
    const inserts: CapturedInsert[] = [];
    const pgInserts: Array<{ table: string; values: unknown }> = [];
    const result = await runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(pgInserts),
      clickhouse: fakeClickHouse({ inserts, countSequence: [0, 2] }),
      fetcher: fetcher(),
      request: { mode: "incremental", last_days: 2, levels: ["campaign", "day"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.v2_errors).toBe(0);

    // V1 warehouse write is untouched: one insert into fact_facebook_stats.
    expect(inserts.filter((entry) => entry.table === "fact_facebook_stats")).toHaveLength(1);

    // Campaign facts land in the daily grain table with shared lineage, no level
    // column and no stored ratios; day-level ground truth is NOT a fact.
    const factInserts = inserts.filter((entry) => entry.table === FACT_FB_CAMPAIGN_DAILY_TABLE);
    expect(factInserts).toHaveLength(1);
    const fact = factInserts[0].values[0];
    expect(fact.stat_date).toBe("2026-07-14");
    expect(fact.campaign_id).toBe("120001");
    expect(fact.import_batch_id).toBe(result.history_batch_id);
    expect(fact.sync_run_id).toBe(result.history_run_id);
    expect(fact.source_version).toBe("2026-07-15");
    expect(fact.spend).toBe(100);
    expect(fact.fb_purchases).toBe(5);
    expect(typeof fact.row_hash).toBe("string");
    expect(fact).not.toHaveProperty("level");
    expect(fact).not.toHaveProperty("cpp");
    expect(fact).not.toHaveProperty("ctr");
    expect(inserts.some((entry) => String(entry.table).endsWith("_daily") && entry.values.some((row) => row.stat_date === undefined))).toBe(false);
    expect(inserts.filter((entry) => entry.table.endsWith("_daily") && entry !== factInserts[0])).toHaveLength(0);

    // Raw layer: one verbatim row per API request (day scan + one campaign day).
    const raw = inserts.filter((entry) => entry.table === RAW_FACEBOOK_API_RESPONSES_TABLE);
    expect(raw).toHaveLength(1);
    expect(raw[0].values).toHaveLength(2);
    expect(raw[0].values.map((row) => row.level)).toEqual(["day", "campaign"]);
    expect(String(raw[0].values[1].response_body)).toContain('"campaignId":"120001"');
    expect(raw[0].values.every((row) => row.sync_run_id === result.history_run_id)).toBe(true);

    // Registry mirrors the batch lifecycle for view-side published filtering.
    const registry = inserts.filter((entry) => entry.table === FB_BATCH_REGISTRY_TABLE);
    expect(registry.map((entry) => entry.values[0].status)).toEqual(["staged", "validated", "published"]);
    expect(registry.every((entry) => entry.values[0].batch_id === result.history_batch_id)).toBe(true);

    // DQ checks stored per batch; all pass on this coherent sync.
    const dq = inserts.filter((entry) => entry.table === FB_DQ_RESULTS_TABLE);
    expect(dq).toHaveLength(1);
    expect(dq[0].values.map((row) => `${row.check_name}:${row.status}`).sort()).toEqual([
      "coverage:pass",
      "duplicate_keys:pass",
      "grain_single_day:pass",
      "spend_cross_level:pass",
    ]);

    // Control-plane request telemetry lands in Postgres, without response bodies.
    const telemetry = pgInserts.filter((entry) => entry.table === FB_SYNC_RUN_REQUESTS_TABLE);
    expect(telemetry).toHaveLength(1);
    const telemetryRows = telemetry[0].values as Array<Record<string, unknown>>;
    expect(telemetryRows).toHaveLength(2);
    expect(telemetryRows[0]).not.toHaveProperty("response_body");
    expect(telemetryRows.every((row) => row.run_id === result.history_run_id)).toBe(true);
  });

  it("V2 layer completely down → the sync completes identically (fail-safe contract)", async () => {
    const inserts: CapturedInsert[] = [];
    const result = await runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(),
      clickhouse: fakeClickHouse({ inserts, failV2: true, countSequence: [0, 2] }),
      fetcher: fetcher(),
      request: { mode: "incremental", last_days: 2, levels: ["campaign", "day"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    });

    expect(result.status).toBe("completed");
    expect(result.rows_inserted).toBe(2);
    expect(inserts.filter((entry) => entry.table === "fact_facebook_stats")).toHaveLength(1);
    expect(result.v2_errors).toBeGreaterThan(0);
  });

  it("validation failure → raw post-mortem kept, batch mirror rolled back, no facts anywhere", async () => {
    const inserts: CapturedInsert[] = [];
    const lossy: CapsuledFetcher = async (from, to, level) => {
      if (level === "day") {
        return { envelope: { ...ENVELOPE, rows: [{ date: "2026-07-14", spend: 100, fbPurchases: 5 }] }, bytes: 200, latencyMs: 4 };
      }
      // Entity level loses half the spend → the cross-level gate must fire.
      return { envelope: { ...ENVELOPE, rows: [{ ...CAMPAIGN_ROW, dateFrom: from, dateTo: to, spend: 50 }] }, bytes: 300, latencyMs: 6 };
    };
    await expect(runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(),
      clickhouse: fakeClickHouse({ inserts, countSequence: [0, 0] }),
      fetcher: lossy,
      request: { mode: "incremental", last_days: 2, levels: ["campaign", "day"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    })).rejects.toBeInstanceOf(FacebookStatsValidationError);

    expect(inserts.filter((entry) => entry.table === "fact_facebook_stats" || entry.table.endsWith("_daily"))).toHaveLength(0);
    const raw = inserts.filter((entry) => entry.table === RAW_FACEBOOK_API_RESPONSES_TABLE);
    expect(raw).toHaveLength(1);
    const registry = inserts.filter((entry) => entry.table === FB_BATCH_REGISTRY_TABLE);
    expect(registry.map((entry) => entry.values[0].status)).toEqual(["staged", "rolled_back"]);
  });
});

describe("V2 writer helpers", () => {
  it("fbV2RowHash is deterministic and key-sensitive", () => {
    const a = fbV2RowHash(["2026-07-14", "120001", 100, 5]);
    expect(fbV2RowHash(["2026-07-14", "120001", 100, 5])).toBe(a);
    expect(fbV2RowHash(["2026-07-14", "120001", 100, 6])).not.toBe(a);
    expect(a).toMatch(/^\d+$/);
  });

  it("buildFbV2DqChecks maps report values onto statuses", () => {
    const checks = buildFbV2DqChecks({
      dqReport: { coverage_pct: 50, duplicate_keys: 2, expected_days: 2, covered_days: 1 },
      mergedRowsDetected: 1,
      spendMismatchCount: 1,
    });
    expect(checks.map((check) => `${check.check_name}:${check.status}`)).toEqual([
      "coverage:warn",
      "duplicate_keys:fail",
      "grain_single_day:fail",
      "spend_cross_level:fail",
    ]);
  });
});
