import { describe, expect, it } from "vitest";
import { buildWarehouseHealthView } from "@/services/fbWarehouseHealth";

const snapshot = (computedAt: string, verdict: string | null, health = "green", overrides: Record<string, unknown> = {}) => ({
  computed_at: computedAt,
  window_from: "2026-05-01",
  window_to: "2026-07-23",
  health,
  source_spend: "100",
  allocated_campaign_spend: "60",
  no_user_spend: "20",
  unknown_funnel_spend: "15",
  unknown_campaign_spend: "5",
  funnel_resolved_spend: "80",
  user_allocated_spend: "70",
  coverage_pct: "0.98",
  suggested_share_pct: "21.2",
  known_gap_days: "0",
  dq_warn_count: "0",
  dq_fail_count: "0",
  campaigns_total: "10",
  campaigns_allocated: "4",
  campaigns_no_user: "3",
  campaigns_unknown_funnel: "2",
  campaigns_unknown: "1",
  details: JSON.stringify(verdict ? { v2_parity: { verdict, overlap_days: 118, matched_days: 118, mismatched_count: 0, overlap_spend_diff: 0 } } : {}),
  ...overrides,
});

describe("buildWarehouseHealthView", () => {
  it("parses numeric strings, picks the latest snapshot and exposes the buckets", () => {
    const view = buildWarehouseHealthView([
      snapshot("2026-07-22 10:00:00", "parity"),
      snapshot("2026-07-23 09:00:00", "parity", "yellow"),
    ]);
    expect(view.latest?.computed_at).toContain("2026-07-23");
    expect(view.latest?.health).toBe("yellow");
    expect(view.latest?.source_spend).toBe(100);
    expect(view.latest?.user_allocated_spend).toBe(70);
    expect(view.latest?.v2_parity?.verdict).toBe("parity");
  });

  it("counts consecutive green days from the tail; a mismatch day breaks the streak", () => {
    const view = buildWarehouseHealthView([
      snapshot("2026-07-20 10:00:00", "parity"),
      snapshot("2026-07-21 10:00:00", "mismatch"),
      snapshot("2026-07-22 10:00:00", "parity"),
      snapshot("2026-07-23 10:00:00", "parity"),
    ]);
    expect(view.consecutiveGreenDays).toBe(2);
    expect(view.gateSatisfied).toBe(false);
    expect(view.gateDays.map((day) => day.verdict)).toEqual(["parity", "mismatch", "parity", "parity"]);
  });

  it("the day's FINAL snapshot decides the day's verdict; 7 greens satisfy the gate", () => {
    const rows = [
      snapshot("2026-07-23 08:00:00", "mismatch"),
      snapshot("2026-07-23 18:00:00", "parity"), // later run supersedes
    ];
    for (let offset = 1; offset <= 6; offset += 1) {
      rows.push(snapshot(`2026-07-${String(23 - offset).padStart(2, "0")} 12:00:00`, "parity"));
    }
    const view = buildWarehouseHealthView(rows);
    expect(view.gateDays.at(-1)?.verdict).toBe("parity");
    expect(view.consecutiveGreenDays).toBe(7);
    expect(view.gateSatisfied).toBe(true);
  });

  it("handles missing parity details and empty input", () => {
    expect(buildWarehouseHealthView([]).latest).toBeNull();
    const view = buildWarehouseHealthView([snapshot("2026-07-23 10:00:00", null)]);
    expect(view.latest?.v2_parity).toBeNull();
    expect(view.gateDays.at(-1)?.verdict).toBe("none");
    expect(view.consecutiveGreenDays).toBe(0);
  });
});
