import { describe, expect, it } from "vitest";
import { calculateManualLtvModel } from "@/services/analytics";

describe("manual LTV model", () => {
  it("uses direct absolute retention inputs without decay", () => {
    const rows = calculateManualLtvModel({
      trialUsers: 100,
      trialPrice: 1,
      subscriptionPrice: 30,
      upsellRatePct: 20,
      upsellValue: 15,
      retentionPctByMonth: [50, 25, 10],
      stripeCommissionPct: 3,
      fbCommissionPct: 7,
    });

    expect(rows[0]).toEqual({
      month: 1,
      users: 50,
      revenue: 1500,
      cumulative_revenue: 1710,
      ltv: 17.1,
    });
    expect(rows[1]).toEqual({
      month: 2,
      users: 25,
      revenue: 750,
      cumulative_revenue: 2385,
      ltv: 23.85,
    });
    expect(rows[2].users).toBe(10);
    expect(rows[2].ltv).toBe(26.55);
  });
});
