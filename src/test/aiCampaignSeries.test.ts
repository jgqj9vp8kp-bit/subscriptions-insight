// The daily per-campaign series feeding the AI campaign trend: daily-split
// contract enforcement, freshest-import dedupe, window clipping, determinism.
import { describe, expect, it } from "vitest";
import { buildCampaignDailySeries } from "@/services/aiCampaignSeries";

function row(over: Partial<Parameters<typeof buildCampaignDailySeries>[0][number]> = {}) {
  return {
    level: "campaign" as const,
    campaign_id: "111",
    date_from: "2026-08-10",
    date_to: "2026-08-10",
    spend: 100,
    fb_purchases: 10,
    last_import_at: "2026-08-20T10:00:00.000Z",
    ...over,
  };
}

describe("buildCampaignDailySeries", () => {
  it("keeps only daily campaign-level rows and sorts by date", () => {
    const out = buildCampaignDailySeries([
      row({ date_from: "2026-08-12", date_to: "2026-08-12" }),
      row({ date_from: "2026-08-10", date_to: "2026-08-10" }),
      row({ date_from: "2026-08-01", date_to: "2026-08-07" }), // period straggler
      row({ level: "day" as never }),                            // wrong level
      row({ campaign_id: "" }),                                  // no id
    ], { dateFrom: null, dateTo: null });
    expect(out["111"].map((p) => p.date)).toEqual(["2026-08-10", "2026-08-12"]);
  });

  it("dedupes (campaign, date) keeping the freshest import", () => {
    const out = buildCampaignDailySeries([
      row({ spend: 100, last_import_at: "2026-08-19T00:00:00Z" }),
      row({ spend: 140, last_import_at: "2026-08-21T00:00:00Z" }),
      row({ spend: 120, last_import_at: "2026-08-20T00:00:00Z" }),
    ], { dateFrom: null, dateTo: null });
    expect(out["111"]).toHaveLength(1);
    expect(out["111"][0].spend).toBe(140);
  });

  it("clips to the requested window", () => {
    const out = buildCampaignDailySeries([
      row({ date_from: "2026-08-05", date_to: "2026-08-05" }),
      row({ date_from: "2026-08-10", date_to: "2026-08-10" }),
      row({ date_from: "2026-08-15", date_to: "2026-08-15" }),
    ], { dateFrom: "2026-08-08", dateTo: "2026-08-12" });
    expect(out["111"].map((p) => p.date)).toEqual(["2026-08-10"]);
  });

  it("is deterministic under input order and never emits negative purchases", () => {
    const rows = [
      row({ date_from: "2026-08-10", date_to: "2026-08-10", fb_purchases: -3 }),
      row({ campaign_id: "222", date_from: "2026-08-11", date_to: "2026-08-11" }),
    ];
    const a = buildCampaignDailySeries(rows, { dateFrom: null, dateTo: null });
    const b = buildCampaignDailySeries([...rows].reverse(), { dateFrom: null, dateTo: null });
    expect(b).toEqual(a);
    expect(a["111"][0].purchases).toBe(0);
  });
});
