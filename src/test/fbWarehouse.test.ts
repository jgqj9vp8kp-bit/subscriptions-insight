// FB Analytics warehouse pipeline tests: Capsuled API quirks (180-day range
// limit, silent 1000-row cap with NO pagination), row mapping fidelity, sync
// state lifecycle, parameter-bound SQL scope, and cache versioning.

import { describe, expect, it, vi } from "vitest";
import {
  addDays,
  buildFbDiagnostics,
  dayDiff,
  deriveMetricTotals,
  fbScopeWhere,
  fetchLevelRows,
  mapCapsuledRow,
  normalizeFbFilters,
  planDateChunks,
  resolveSyncRange,
  runFacebookStatsSync,
  runFbList,
  type CapsuledFetcher,
  type CapsuledFetchStats,
} from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { fbReportKey, fbWarehouseVersionFromStatus, isCompleteFbReport, normalizeFbReportQuery, type FbReportResponse } from "@/services/fbWarehouse";

// Real Capsuled API row (probed live 2026-07-15, level=campaign).
const SAMPLE_ROW = {
  dateFrom: "2026-07-14",
  dateTo: "2026-07-14",
  adAccountId: "act_2486811861722169",
  adAccountName: "2-Soulmate-Reading-Ivan",
  buyer: "Ivan",
  campaignId: "120249115818080040",
  campaignName: "02,1 - Video Soulmate",
  spend: 249.27,
  fbPurchases: 6,
  cpp: 41.545,
  impressions: 2823,
  clicks: 318,
  ctr: 11.264612,
  cpc: 0.783868,
  cpm: 88.299681,
  outboundClicks: 269,
  outboundCtr: 9.52887,
};
const ENVELOPE = {
  ok: true,
  currency: "USD",
  dataFreshness: { fbStatsTo: "2026-07-14", lastImportAt: "2026-07-15T09:38:45.048Z" },
};

function newStats(): CapsuledFetchStats {
  return { requests: 0, payload_bytes: 0, api_latency_ms: 0, splits: 0, failed_attempts: [] };
}

describe("Capsuled range planning", () => {
  it("splits long ranges into API-legal chunks of at most 180 days", () => {
    const chunks = planDateChunks("2025-01-01", "2026-07-15");
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(dayDiff(chunk.from, chunk.to)).toBeLessThan(180);
    }
    expect(chunks[0].from).toBe("2025-01-01");
    expect(chunks.at(-1)!.to).toBe("2026-07-15");
    // Chunks are contiguous, no gaps and no overlaps.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i].from).toBe(addDays(chunks[i - 1].to, 1));
    }
  });

  it("re-fetches capped (1000-row) windows in halves — truncated batches are discarded, not merged", async () => {
    // Fake API: 30 rows/day at the "ad" level, cap simulated at 100 rows.
    const perDay = 30;
    const cap = 100;
    const calls: string[] = [];
    const fetcher: CapsuledFetcher = async (from, to) => {
      calls.push(`${from}..${to}`);
      const days = dayDiff(from, to) + 1;
      const total = days * perDay;
      const rows = Array.from({ length: Math.min(total, cap) }, (_unused, i) => ({
        dateFrom: addDays(from, Math.floor(i / perDay) % days),
        adId: `ad_${i}`,
      }));
      return { envelope: { ok: true, rows }, bytes: rows.length * 50, latencyMs: 5 };
    };
    const stats = newStats();
    // 10 days * 30 rows = 300 total; single response would be capped at 100.
    const { rows } = await fetchLevelRows({ fetcher, level: "ad", dateFrom: "2026-07-01", dateTo: "2026-07-10", stats, rowCap: cap });
    expect(rows.length).toBe(300);
    expect(stats.splits).toBeGreaterThan(0);
    expect(stats.requests).toBe(calls.length);
    // The first (capped) response must NOT contribute rows — no duplicates.
    const ids = rows.map((r) => `${(r as { dateFrom: string }).dateFrom}:${(r as { adId: string }).adId}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Capsuled row mapping", () => {
  const base = {
    level: "campaign" as const,
    authUserId: "user-1",
    envelope: ENVELOPE,
    syncedAtIso: "2026-07-15T10:00:00.000Z",
    warehouseVersion: "fbwh_test",
    rowVersion: 1_752_570_000_000,
  };

  it("maps every API field and preserves the raw payload verbatim", () => {
    const row = mapCapsuledRow({ ...base, row: SAMPLE_ROW });
    expect(row).not.toBeNull();
    expect(row!.stat_date).toBe("2026-07-14");
    expect(row!.ad_account_id).toBe("act_2486811861722169");
    expect(row!.buyer).toBe("Ivan");
    expect(row!.campaign_id).toBe("120249115818080040");
    expect(row!.spend).toBe(249.27);
    expect(row!.fb_purchases).toBe(6);
    expect(row!.cpp).toBe(41.545);
    expect(row!.ctr).toBe(11.264612);
    expect(row!.outbound_clicks).toBe(269);
    expect(row!.currency).toBe("USD");
    expect(row!.fb_stats_to).toBe("2026-07-14");
    expect(row!.source_updated_at).toBe("2026-07-15 09:38:45.048");
    expect(JSON.parse(row!.raw_payload)).toEqual(SAMPLE_ROW);
    // Fields the v1 API does not provide stay explicit zero/null, never invented.
    expect(row!.reach).toBe(0);
    expect(row!.purchase_value).toBe(0);
    expect(row!.roas).toBeNull();
    expect(row!.frequency).toBeNull();
  });

  it("keeps API nulls as nulls (cpp with zero purchases) and drops undateable rows", () => {
    const row = mapCapsuledRow({ ...base, row: { ...SAMPLE_ROW, fbPurchases: 0, cpp: null } });
    expect(row!.cpp).toBeNull();
    expect(mapCapsuledRow({ ...base, row: { spend: 5 } })).toBeNull();
    expect(mapCapsuledRow({ ...base, row: "not a record" })).toBeNull();
  });

  it("maps the day level via the `date` field", () => {
    const row = mapCapsuledRow({ ...base, level: "day", row: { date: "2026-07-14", spend: 1997.75, fbPurchases: 92 } });
    expect(row!.stat_date).toBe("2026-07-14");
    expect(row!.level).toBe("day");
    expect(row!.ad_account_id).toBe("");
  });
});

describe("sync range resolution", () => {
  const today = "2026-07-15";

  it("incremental default re-pulls a trailing window (restated attribution)", () => {
    expect(resolveSyncRange({ mode: "incremental", today })).toEqual({ dateFrom: "2026-07-13", dateTo: today });
  });

  it("incremental honours last_days=1 (yesterday+today window)", () => {
    expect(resolveSyncRange({ mode: "incremental", today, lastDays: 1 })).toEqual({ dateFrom: today, dateTo: today });
  });

  it("never leaves a gap after an idle period — extends from the cursor", () => {
    expect(resolveSyncRange({ mode: "incremental", today, cursorDate: "2026-07-01" })).toEqual({ dateFrom: "2026-07-01", dateTo: today });
  });

  it("full sync covers the capped lookback horizon; explicit dates win", () => {
    const full = resolveSyncRange({ mode: "full", today });
    expect(dayDiff(full.dateFrom, full.dateTo)).toBe(539);
    expect(resolveSyncRange({ mode: "full", today, dateFrom: "2026-03-01", dateTo: "2026-03-31" }))
      .toEqual({ dateFrom: "2026-03-01", dateTo: "2026-03-31" });
  });
});

// ---- sync orchestration with fake clients ----------------------------------

function fakeSupabase(state: Record<string, unknown> | null, upserts: unknown[] = []): SupabaseLikeClient {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: state, error: null }),
        upsert: async (value: unknown) => {
          upserts.push(value);
          return { data: value, error: null };
        },
      };
      return builder as never;
    },
  };
}

function fakeFbClickHouse(options: { countSequence?: number[]; inserts?: unknown[] } = {}): ClickHouseClientLike {
  const counts = [...(options.countSequence ?? [0, 0])];
  return {
    command: async () => undefined,
    insert: async (input) => {
      options.inserts?.push(input);
    },
    query: async ({ query }) => ({
      json: async () => {
        if (query.includes("date_min")) {
          return [{ c: counts[0] ?? 0, date_min: "2026-03-23", date_max: "2026-07-14" }];
        }
        if (query.includes("count() c FROM")) {
          return [{ c: counts.length > 1 ? counts.shift() : counts[0] }];
        }
        return [];
      },
    }),
  };
}

describe("runFacebookStatsSync (per-day entity fetch — merge-proof)", () => {
  // Fake Capsuled that mimics the REAL behaviour proven live: entity levels
  // MERGE consecutive days into one dateFrom..dateTo row when the window is
  // wider than one day; single-day windows return honest per-day rows.
  function mergingFetcher(calls: Array<{ from: string; to: string; level: string }>): CapsuledFetcher {
    return async (from, to, level) => {
      calls.push({ from, to, level });
      if (level === "day") {
        const rows = [
          { date: "2026-07-14", spend: 100, fbPurchases: 5 },
          { date: "2026-07-15", spend: 50, fbPurchases: 2 },
        ].filter((r) => r.date >= from && r.date <= to);
        return { envelope: { ...ENVELOPE, rows }, bytes: 300, latencyMs: 5 };
      }
      if (from !== to) {
        // Merged row — must NEVER be persisted by the sync.
        return {
          envelope: { ...ENVELOPE, rows: [{ ...SAMPLE_ROW, dateFrom: from, dateTo: to, spend: 150 }] },
          bytes: 300,
          latencyMs: 5,
        };
      }
      const spend = from === "2026-07-14" ? 100 : 50;
      return { envelope: { ...ENVELOPE, rows: [{ ...SAMPLE_ROW, dateFrom: from, dateTo: from, spend }] }, bytes: 300, latencyMs: 5 };
    };
  }

  it("fetches entity levels ONE DAY per request over day-scan active dates — never a mergeable window", async () => {
    const calls: Array<{ from: string; to: string; level: string }> = [];
    const upserts: unknown[] = [];
    const inserts: Array<{ values: unknown[] }> = [];
    const result = await runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(null, upserts),
      clickhouse: fakeFbClickHouse({ countSequence: [0, 4], inserts: inserts as unknown[] }),
      fetcher: mergingFetcher(calls),
      request: { mode: "incremental", last_days: 2, levels: ["campaign", "day"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    // Every entity (campaign) request used a single-day window.
    const campaignCalls = calls.filter((c) => c.level === "campaign");
    expect(campaignCalls.length).toBe(2);
    expect(campaignCalls.every((c) => c.from === c.to)).toBe(true);
    // 2 day rows + 2 per-day campaign rows, spend parity with the day ground truth.
    expect(result.api_rows).toBe(4);
    expect(result.rows_skipped).toBe(0);
    const finalPatch = JSON.stringify(upserts.at(-1));
    expect(finalPatch).toContain('"merged_rows_detected":0');
    expect(finalPatch).toContain('"spend_mismatch":[]');
    expect(finalPatch).toContain('"strategy":"per_day_entity_fetch"');
  });

  it("reports a spend mismatch when an entity level disagrees with the day-level ground truth", async () => {
    const calls: Array<{ from: string; to: string; level: string }> = [];
    const lossyFetcher: CapsuledFetcher = async (from, to, level) => {
      const base = await mergingFetcher(calls)(from, to, level);
      if (level === "campaign" && from === "2026-07-15") return { ...base, envelope: { ...ENVELOPE, rows: [] } };
      return base;
    };
    const upserts: unknown[] = [];
    await runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(null, upserts),
      clickhouse: fakeFbClickHouse({ countSequence: [0, 3] }),
      fetcher: lossyFetcher,
      request: { mode: "incremental", last_days: 2, levels: ["campaign", "day"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    const finalPatch = JSON.stringify(upserts.at(-1));
    expect(finalPatch).toContain('"spend_mismatch":[{"level":"campaign"');
  });

  it("completed sync records cursor, counters and constraint-safe vocabulary", async () => {
    const calls: Array<{ from: string; to: string; level: string }> = [];
    const upserts: unknown[] = [];
    const result = await runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(null, upserts),
      clickhouse: fakeFbClickHouse({ countSequence: [10, 14] }),
      fetcher: mergingFetcher(calls),
      request: { mode: "incremental", last_days: 2, levels: ["campaign", "day"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    expect(result.status).toBe("completed");
    expect(result.rows_inserted).toBe(4); // 14 - 10
    const runningPatch = JSON.stringify(upserts[0]);
    expect(runningPatch).toContain('"status":"running"');
    const finalPatch = JSON.stringify(upserts.at(-1));
    expect(finalPatch).toContain('"status":"completed"');
    expect(finalPatch).toContain('"cursor_transaction_id":"2026-07-15"');
    expect(finalPatch).toContain('"fb_stats_to":"2026-07-14"');
    // Postgres CHECK constraint vocabulary: last_run_mode must map to the
    // transaction-backfill set; the honest FB mode lives in diagnostics.mode.
    expect(finalPatch).toContain('"last_run_mode":"continue"');
    expect(finalPatch).toContain('"mode":"incremental"');
  });

  it("full mode persists as last_run_mode=full_backfill (constraint vocabulary)", async () => {
    const calls: Array<{ from: string; to: string; level: string }> = [];
    const upserts: unknown[] = [];
    await runFacebookStatsSync({
      authUserId: "user-1",
      supabase: fakeSupabase(null, upserts),
      clickhouse: fakeFbClickHouse({ countSequence: [0, 1] }),
      fetcher: mergingFetcher(calls),
      request: { mode: "full", date_from: "2026-07-14", date_to: "2026-07-15", levels: ["campaign"] },
      now: new Date("2026-07-15T10:00:00.000Z"),
    });
    const finalPatch = JSON.stringify(upserts.at(-1));
    expect(finalPatch).toContain('"last_run_mode":"full_backfill"');
    expect(finalPatch).toContain('"mode":"full"');
  });

  it("failed fetch marks the sync state failed and rethrows", async () => {
    const upserts: unknown[] = [];
    const failing: CapsuledFetcher = async () => {
      throw new Error("Capsuled token rejected or expired.");
    };
    await expect(
      runFacebookStatsSync({
        authUserId: "user-1",
        supabase: fakeSupabase(null, upserts),
        clickhouse: fakeFbClickHouse(),
        fetcher: failing,
        request: { mode: "incremental", levels: ["campaign"] },
        now: new Date("2026-07-15T10:00:00.000Z"),
      }),
    ).rejects.toThrow("token rejected");
    const failedPatch = JSON.stringify(upserts.at(-1));
    expect(failedPatch).toContain('"status":"failed"');
    // stopped_reason must stay inside the table's CHECK vocabulary.
    expect(failedPatch).toContain('"stopped_reason":"unknown"');
  });
});

describe("read scope SQL", () => {
  it("binds every filter as a query parameter — never string interpolation", () => {
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const where = fbScopeWhere({
      level: "campaign",
      filters: normalizeFbFilters({
        filters: { date_from: "2026-07-01", date_to: "2026-07-15", buyer: ["Ivan"], ad_account_id: ["act_1"], campaign_id: ["c1", "c2"] },
      }),
      params,
    });
    expect(where).toContain("buyer IN ({p_buyer_0:String})");
    expect(where).toContain("campaign_id IN ({p_camp_0:String}, {p_camp_1:String})");
    expect(where).not.toContain("Ivan");
    expect(params.p_buyer_0).toBe("Ivan");
    expect(params.p_camp_1).toBe("c2");
    expect(params.date_from).toBe("2026-07-01");
  });

  it("derived totals are recomputed from sums, zero denominators stay null", () => {
    const totals = deriveMetricTotals({ spend: 100, impressions: 20000, clicks: 400, outbound_clicks: 300, fb_purchases: 4 });
    expect(totals.cpp).toBe(25);
    expect(totals.cpc).toBe(0.25);
    expect(totals.cpm).toBe(5);
    expect(totals.ctr).toBe(2);
    const empty = deriveMetricTotals({ spend: 50, impressions: 0, clicks: 0, outbound_clicks: 0, fb_purchases: 0 });
    expect(empty.cpp).toBeNull();
    expect(empty.cpc).toBeNull();
    expect(empty.cpm).toBeNull();
    expect(empty.ctr).toBeNull();
  });
});

describe("blended Subengine metrics — joined BY CAMPAIGN_ID", () => {
  function listClient(captured: { sql?: string; params?: Record<string, unknown> }): ClickHouseClientLike {
    return {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => {
        captured.sql = query;
        captured.params = query_params as Record<string, unknown>;
        return {
          json: async () => [{
            ad_account_id: "act_1", campaign_id: "120249115818080040",
            ad_account_name: "Acc", buyer: "Ivan", campaign_name: "Camp",
            adset_name: "", ad_name: "", first_date: "2026-07-01", last_date: "2026-07-14", days: 14,
            spend: 500, impressions: 10000, clicks: 200, outbound_clicks: 150, fb_purchases: 10,
            purchase_value: 0, reach: 0, link_clicks: 0,
            trial_users: 25, tx_gross: 1000, tx_refunds: 100,
          }],
        };
      },
    };
  }

  it("campaign level joins analytics_transactions ON campaign_id with the same date window", async () => {
    const captured: { sql?: string; params?: Record<string, unknown> } = {};
    const { rows } = await runFbList(listClient(captured), "user-1", {
      level: "campaign",
      filters: { date_from: "2026-07-01", date_to: "2026-07-14" },
    });
    expect(captured.sql).toContain("LEFT JOIN");
    expect(captured.sql).toContain("tx.campaign_id = fb.campaign_id");
    expect(captured.sql).toContain("analytics_transactions FINAL");
    // Same window on both sides of the join, bound as parameters.
    expect(captured.params?.date_from).toBe("2026-07-01");
    expect(captured.params?.tx_date_from).toBe("2026-07-01");
    expect(captured.params?.tx_date_to).toBe("2026-07-14");

    const row = rows[0];
    expect(row.blended).toBeDefined();
    expect(row.blended!.trial_users).toBe(25);
    expect(row.blended!.tx_gross_revenue).toBe(1000);
    expect(row.blended!.tx_net_revenue).toBe(900); // gross - refunds
    expect(row.blended!.cac).toBe(20); // 500 / 25
    expect(row.blended!.roas).toBe(1.8); // 900 / 500
    expect(row.blended!.revenue_per_trial).toBe(36); // 900 / 25
  });

  it("non-campaign levels never join transactions (no adset/ad ids in Subengine)", async () => {
    const captured: { sql?: string; params?: Record<string, unknown> } = {};
    const { rows } = await runFbList(listClient(captured), "user-1", { level: "adset", filters: {} });
    expect(captured.sql).not.toContain("LEFT JOIN");
    expect(rows[0].blended).toBeUndefined();
  });
});

describe("diagnostics / report completeness", () => {
  function diagClients(input: { state: Record<string, unknown> | null; rows: number; dateMax: string | null }) {
    const clickhouse: ClickHouseClientLike = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }) => ({
        json: async () => {
          // Real ClickHouse behaviour: min/max(Date) over zero rows = epoch.
          if (query.includes("date_min")) {
            return [{ c: input.rows, date_min: input.rows ? "2026-03-23" : "1970-01-01", date_max: input.dateMax ?? "1970-01-01" }];
          }
          return [{ c: input.rows }];
        },
      }),
    };
    return { clickhouse, supabase: fakeSupabase(input.state) };
  }
  const completedState = {
    status: "completed",
    finished_at: "2026-07-15T10:00:00Z",
    duration_ms: 4000,
    last_run_mode: "incremental",
    cursor_transaction_id: "2026-07-15",
    cursor_updated_at: "2026-07-15T09:38:45.048Z",
    diagnostics: { fb_stats_to: "2026-07-14" },
  };

  it("report_complete=true only when a completed sync covers through yesterday AND rows exist", async () => {
    const { clickhouse, supabase } = diagClients({ state: completedState, rows: 3000, dateMax: "2026-07-14" });
    const d = await buildFbDiagnostics({
      clickhouse, supabase, authUserId: "user-1",
      level: "campaign", filters: normalizeFbFilters({}), today: "2026-07-15",
    });
    expect(d.report_complete).toBe(true);
    expect(d.engine).toBe("clickhouse");
    expect(d.warehouse_rows).toBe(3000);
  });

  it("stale API freshness or an empty warehouse make the report incomplete — never silently complete", async () => {
    const stale = diagClients({
      state: { ...completedState, diagnostics: { fb_stats_to: "2026-07-10" } },
      rows: 3000,
      dateMax: "2026-07-10",
    });
    const dStale = await buildFbDiagnostics({
      clickhouse: stale.clickhouse, supabase: stale.supabase, authUserId: "user-1",
      level: "campaign", filters: normalizeFbFilters({}), today: "2026-07-15",
    });
    expect(dStale.report_complete).toBe(false);

    const empty = diagClients({ state: completedState, rows: 0, dateMax: null });
    const dEmpty = await buildFbDiagnostics({
      clickhouse: empty.clickhouse, supabase: empty.supabase, authUserId: "user-1",
      level: "campaign", filters: normalizeFbFilters({}), today: "2026-07-15",
    });
    expect(dEmpty.report_complete).toBe(false);
    // Epoch dates from an empty table must render as "no data", not 1970-01-01.
    expect(dEmpty.date_min).toBeNull();
    expect(dEmpty.date_max).toBeNull();
  });
});

describe("frontend cache versioning", () => {
  it("fb warehouse version changes after a sync and report keys re-key with it", () => {
    const before = fbWarehouseVersionFromStatus({
      ok: true,
      state: { cursor_transaction_id: "2026-07-14", finished_at: "2026-07-14T10:00:00Z" },
      diagnostics: { warehouse_rows: 2900 } as never,
    });
    const after = fbWarehouseVersionFromStatus({
      ok: true,
      state: { cursor_transaction_id: "2026-07-15", finished_at: "2026-07-15T10:00:00Z" },
      diagnostics: { warehouse_rows: 3000 } as never,
    });
    expect(before).not.toBe(after);
    expect(fbWarehouseVersionFromStatus(null)).toBe("fbwhv_unknown");

    const key = fbReportKey({
      userScopeHash: "u_1",
      warehouseVersion: after,
      query: { level: "campaign", date_from: "2026-06-16", date_to: "2026-07-15", buyer: ["Ivan", "Ivan"], ad_account_id: [], campaign_id: [] },
    });
    expect(key[0]).toBe("fb-analytics");
    expect(key[3]).toBe(after);
    // Filters are canonicalized: duplicates collapse, so logically-equal requests share a key.
    expect((key[4] as { buyer: string[] }).buyer).toEqual(["Ivan"]);
  });

  it("rejects schema-incompatible cached bundles (pre-blended contract) instead of rendering them", () => {
    const complete = {
      ok: true, source: "clickhouse", generated_at: "2026-07-15T12:00:00Z", query_duration_ms: 10,
      level: "campaign", rows: [], charts: [], filter_options: { buyers: [], accounts: [], campaigns: [], date_min: null, date_max: null },
      diagnostics: { engine: "clickhouse" },
      summary: { spend: 0, blended: { trial_users: 0, tx_gross_revenue: 0, tx_net_revenue: 0, cac: null, roas: null, revenue_per_trial: null } },
    } as unknown as FbReportResponse;
    expect(isCompleteFbReport(complete)).toBe(true);
    // A bundle persisted before summary.blended existed must be rejected, not crash the KPI cards.
    const legacy = { ...complete, summary: { spend: 0 } } as unknown as FbReportResponse;
    expect(isCompleteFbReport(legacy)).toBe(false);
    expect(isCompleteFbReport(null)).toBe(false);
  });

  it("normalizeFbReportQuery is order-insensitive for filter arrays", () => {
    const a = normalizeFbReportQuery({ level: "ad", date_from: null, date_to: null, buyer: ["B", "A"], ad_account_id: [], campaign_id: [] });
    const b = normalizeFbReportQuery({ level: "ad", date_from: null, date_to: null, buyer: ["A", "B"], ad_account_id: [], campaign_id: [] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
