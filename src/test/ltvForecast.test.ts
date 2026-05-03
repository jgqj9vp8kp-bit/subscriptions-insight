import { describe, expect, it } from "vitest";
import { forecastLtv } from "@/services/analytics";

describe("LTV forecast", () => {
  it("projects 3, 6, and 12 month LTV from cohort retention", () => {
    const forecast = forecastLtv({
      trialUsers: 100,
      firstSubscriptionUsers: 50,
      renewal2Users: 25,
      renewal3Users: 10,
      netRevenue: 1000,
      firstSubscriptionRevenue: 1500,
    });

    expect(forecast.ltv_actual).toBe(10);
    expect(forecast.ltv_3m).toBe(20.5);
    expect(forecast.ltv_6m).toBe(26.36);
    expect(forecast.ltv_12m).toBe(30.89);
  });

  it("uses fallback decay when renewal ratios are missing", () => {
    const forecast = forecastLtv({
      trialUsers: 10,
      firstSubscriptionUsers: 0,
      renewal2Users: 0,
      renewal3Users: 0,
      netRevenue: 25,
      firstSubscriptionRevenue: 0,
    });

    expect(forecast.ltv_actual).toBe(2.5);
    expect(forecast.ltv_3m).toBe(2.5);
    expect(forecast.ltv_6m).toBe(2.5);
    expect(forecast.ltv_12m).toBe(2.5);
  });
});
