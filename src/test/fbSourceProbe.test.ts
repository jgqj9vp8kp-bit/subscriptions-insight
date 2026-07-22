import { describe, expect, it } from "vitest";
import {
  FB_KNOWN_GAP_WINDOW,
  FacebookStatsRequestError,
  runFacebookSourceProbe,
  type CapsuledFetcher,
} from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";

const ENVELOPE = {
  ok: true,
  currency: "USD",
  dataFreshness: { fbStatsTo: "2026-07-15", lastImportAt: "2026-07-15T09:00:00.000Z" },
};

function dayFetcher(rowsByCall: unknown[][], calls: Array<{ from: string; to: string; level: string }> = []): CapsuledFetcher {
  let call = 0;
  return async (from, to, level) => {
    calls.push({ from, to, level });
    const rows = rowsByCall[Math.min(call, rowsByCall.length - 1)] ?? [];
    call += 1;
    return { envelope: { ...ENVELOPE, rows }, bytes: 100, latencyMs: 3 };
  };
}

describe("runFacebookSourceProbe (read-only, Warehouse V2 Phase 2)", () => {
  it("defaults to the audited gap window and aggregates per-day evidence", async () => {
    const calls: Array<{ from: string; to: string; level: string }> = [];
    const probe = await runFacebookSourceProbe({
      fetcher: dayFetcher([[
        { date: "2026-05-10", spend: 100.005, fbPurchases: 3 },
        { date: "2026-05-11", spend: 50, fbPurchases: 1 },
        { date: "2026-07-01", spend: 999, fbPurchases: 9 }, // outside the window — ignored
      ]], calls),
      dateFrom: null,
      dateTo: null,
    });

    expect(calls.every((entry) => entry.level === "day")).toBe(true);
    expect(probe.date_from).toBe(FB_KNOWN_GAP_WINDOW.date_from);
    expect(probe.date_to).toBe(FB_KNOWN_GAP_WINDOW.date_to);
    expect(probe.expected_days).toBe(38);
    expect(probe.days_with_data).toBe(2);
    expect(probe.rows_found).toBe(2);
    expect(probe.spend_total).toBe(150.01);
    expect(probe.purchases_total).toBe(4);
    expect(probe.per_day.map((row) => row.date)).toEqual(["2026-05-10", "2026-05-11"]);
    expect(probe.verdict).toBe("data_available");
    expect(probe.fb_stats_to).toBe("2026-07-15");
    expect(probe.api_requests).toBeGreaterThan(0);
  });

  it("returns an explicit empty verdict when the source has nothing", async () => {
    const probe = await runFacebookSourceProbe({ fetcher: dayFetcher([[]]), dateFrom: "2026-05-08", dateTo: "2026-06-14" });
    expect(probe.verdict).toBe("empty");
    expect(probe.rows_found).toBe(0);
    expect(probe.days_with_data).toBe(0);
    expect(probe.per_day).toEqual([]);
  });

  it("rejects malformed or inverted windows", async () => {
    await expect(runFacebookSourceProbe({ fetcher: dayFetcher([[]]), dateFrom: "08.05.2026", dateTo: null }))
      .rejects.toBeInstanceOf(FacebookStatsRequestError);
    await expect(runFacebookSourceProbe({ fetcher: dayFetcher([[]]), dateFrom: "2026-06-14", dateTo: "2026-05-08" }))
      .rejects.toBeInstanceOf(FacebookStatsRequestError);
  });
});
