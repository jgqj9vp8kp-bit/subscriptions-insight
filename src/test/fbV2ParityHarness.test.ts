import { describe, expect, it } from "vitest";
import { compareFbV2Parity } from "../../supabase/functions/_shared/clickhouse/fbV2ParityHarness.ts";

const day = (stat_date: string, spend: number, fb_purchases: number, rows = 10) => ({ stat_date, spend, fb_purchases, rows });

describe("compareFbV2Parity (Wave 5 cutover gate)", () => {
  it("reports parity when every overlapping day agrees within a cent", () => {
    const report = compareFbV2Parity({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-03",
      v1: [day("2026-07-01", 100.005, 5), day("2026-07-02", 50, 2)],
      v2: [day("2026-07-01", 100.01, 5), day("2026-07-02", 50, 2)],
    });
    expect(report.verdict).toBe("parity");
    expect(report.matched_days).toBe(2);
    expect(report.mismatched_days).toEqual([]);
    expect(report.totals.overlap_spend_diff).toBeCloseTo(0, 2);
  });

  it("coverage holes are NOT mismatches: one-sided days are reported separately", () => {
    const report = compareFbV2Parity({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-04",
      v1: [day("2026-07-01", 100, 5), day("2026-07-02", 60, 3), day("2026-07-03", 40, 1)],
      v2: [day("2026-07-02", 60, 3), day("2026-07-04", 9, 0)],
    });
    expect(report.verdict).toBe("parity");
    expect(report.overlap_days).toBe(1);
    expect(report.v1_only_days).toEqual(["2026-07-01", "2026-07-03"]);
    expect(report.v2_only_days).toEqual(["2026-07-04"]);
  });

  it("flags spend beyond tolerance and any purchase drift", () => {
    const report = compareFbV2Parity({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      v1: [day("2026-07-01", 100, 5), day("2026-07-02", 50, 2)],
      v2: [day("2026-07-01", 100.05, 5), day("2026-07-02", 50, 3)],
    });
    expect(report.verdict).toBe("mismatch");
    expect(report.matched_days).toBe(0);
    expect(report.mismatched_days.map((row) => row.stat_date)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(report.mismatched_days[0].spend_diff).toBeCloseTo(-0.05, 2);
    expect(report.mismatched_days[1].purchases_diff).toBe(-1);
  });

  it("empty overlap yields an explicit no_overlap verdict", () => {
    const report = compareFbV2Parity({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      v1: [day("2026-07-01", 100, 5)],
      v2: [],
    });
    expect(report.verdict).toBe("no_overlap");
    expect(report.overlap_days).toBe(0);
  });
});
