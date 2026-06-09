import { describe, expect, it } from "vitest";
import {
  buildForecastPriceOptions,
  defaultPriceSelection,
  forecastProfit,
  forecastRoas,
  projectedSpendFromCac,
  priceSourceLabel,
  resolveForecastCac,
  reconcilePriceSelection,
  resolveSelectedPrice,
  weightedAveragePrice,
  type ForecastPriceOption,
} from "@/services/forecasting";
import type { Transaction } from "@/services/types";

function tx(partial: Partial<Transaction>): Transaction {
  return {
    transaction_id: partial.transaction_id ?? `${partial.user_id}_${partial.transaction_type}_${partial.event_time}`,
    user_id: partial.user_id ?? "user_1",
    email: partial.email ?? `${partial.user_id ?? "user_1"}@example.com`,
    event_time: partial.event_time ?? "2026-03-01T00:00:00Z",
    amount_usd: partial.amount_usd ?? partial.gross_amount_usd ?? 0,
    gross_amount_usd: partial.gross_amount_usd ?? partial.amount_usd ?? 0,
    refund_amount_usd: partial.refund_amount_usd ?? 0,
    net_amount_usd: partial.net_amount_usd ?? partial.gross_amount_usd ?? partial.amount_usd ?? 0,
    is_refunded: partial.is_refunded ?? false,
    currency: partial.currency ?? "USD",
    status: partial.status ?? "success",
    transaction_type: partial.transaction_type ?? "trial",
    funnel: partial.funnel ?? "unknown",
    campaign_path: partial.campaign_path ?? "soulmate-reading",
    product: partial.product ?? "",
    traffic_source: partial.traffic_source ?? "facebook",
    campaign_id: partial.campaign_id ?? "",
    classification_reason: partial.classification_reason ?? "",
    cohort_date: partial.cohort_date ?? "2026-03-01",
    cohort_id: partial.cohort_id ?? "unknown_soulmate-reading_2026-03-01",
    transaction_day: partial.transaction_day ?? 0,
  };
}

describe("Forecasting price options", () => {
  const selected = new Set(["unknown_soulmate-reading_2026-03-01"]);

  it("auto-selects a single trial price", () => {
    const options = buildForecastPriceOptions([
      tx({ user_id: "u1", transaction_type: "trial", gross_amount_usd: 1 }),
      tx({ user_id: "u2", transaction_type: "trial", gross_amount_usd: 1 }),
    ], selected);

    expect(options.trialOptions).toEqual([{ price: 1, users: 2, percentage: 100 }]);
    const selection = defaultPriceSelection(options.trialOptions);
    expect(selection).toBe("price:1");
    expect(priceSourceLabel(selection, options.trialOptions)).toBe("Auto selected");
  });

  it("builds multiple trial price options from selected users", () => {
    const options = buildForecastPriceOptions([
      tx({ user_id: "u1", transaction_type: "trial", gross_amount_usd: 1 }),
      tx({ user_id: "u2", transaction_type: "trial", gross_amount_usd: 7.49 }),
      tx({ user_id: "u3", transaction_type: "trial", gross_amount_usd: 7.49 }),
    ], selected);

    expect(options.trialOptions[0]).toMatchObject({ price: 1, users: 1 });
    expect(options.trialOptions[0].percentage).toBeCloseTo(100 / 3);
    expect(options.trialOptions[1]).toMatchObject({ price: 7.49, users: 2 });
    expect(options.trialOptions[1].percentage).toBeCloseTo(200 / 3);
    expect(defaultPriceSelection(options.trialOptions)).toBe("weighted_average");
  });

  it("calculates weighted average price from option user counts", () => {
    const options: ForecastPriceOption[] = [
      { price: 1, users: 80, percentage: 80 },
      { price: 7.49, users: 20, percentage: 20 },
    ];

    expect(weightedAveragePrice(options)).toBe(2.3);
  });

  it("uses custom price override when selected", () => {
    const options: ForecastPriceOption[] = [{ price: 1, users: 10, percentage: 100 }];

    expect(resolveSelectedPrice(options, "custom", 12.5, 1)).toBe(12.5);
    expect(priceSourceLabel("custom", options)).toBe("Manual custom");
  });

  it("counts only the first first_subscription transaction per user", () => {
    const options = buildForecastPriceOptions([
      tx({ user_id: "u1", transaction_type: "trial", gross_amount_usd: 1, event_time: "2026-03-01T00:00:00Z" }),
      tx({ user_id: "u1", transaction_type: "first_subscription", gross_amount_usd: 29.99, event_time: "2026-03-08T00:00:00Z" }),
      tx({ user_id: "u1", transaction_type: "first_subscription", gross_amount_usd: 59.99, event_time: "2026-04-08T00:00:00Z" }),
      tx({ user_id: "u2", transaction_type: "trial", gross_amount_usd: 1, event_time: "2026-03-01T00:00:00Z" }),
      tx({ user_id: "u2", transaction_type: "first_subscription", gross_amount_usd: 29.99, event_time: "2026-03-08T00:00:00Z" }),
    ], selected);

    expect(options.subscriptionOptions).toEqual([{ price: 29.99, users: 2, percentage: 100 }]);
    expect(options.firstSubscriptionUserCount).toBe(2);
  });

  it("keeps user price selection until selected cohorts change", () => {
    const oneOption: ForecastPriceOption[] = [{ price: 7.49, users: 1, percentage: 100 }];

    expect(reconcilePriceSelection("same", "same", "custom", oneOption)).toBe("custom");
    expect(reconcilePriceSelection("old", "new", "custom", oneOption)).toBe("price:7.49");
  });

  it("auto-selects a single upsell value", () => {
    const options = buildForecastPriceOptions([
      tx({ user_id: "u1", transaction_type: "trial", gross_amount_usd: 1 }),
      tx({ user_id: "u1", transaction_type: "upsell", gross_amount_usd: 14.98, event_time: "2026-03-01T01:00:00Z" }),
      tx({ user_id: "u2", transaction_type: "trial", gross_amount_usd: 1 }),
      tx({ user_id: "u2", transaction_type: "upsell", gross_amount_usd: 14.98, event_time: "2026-03-01T01:00:00Z" }),
    ], selected);

    expect(options.upsellOptions).toEqual([{ price: 14.98, users: 2, transactions: 2, percentage: 100 }]);
    const selection = defaultPriceSelection(options.upsellOptions);
    expect(selection).toBe("price:14.98");
    expect(priceSourceLabel(selection, options.upsellOptions)).toBe("Auto selected");
  });

  it("builds multiple upsell value options with users and transactions", () => {
    const options = buildForecastPriceOptions([
      tx({ user_id: "u1", transaction_type: "trial", gross_amount_usd: 1 }),
      tx({ user_id: "u1", transaction_type: "upsell", gross_amount_usd: 14.98, event_time: "2026-03-01T01:00:00Z" }),
      tx({ user_id: "u1", transaction_type: "upsell", gross_amount_usd: 14.98, event_time: "2026-03-01T02:00:00Z" }),
      tx({ user_id: "u2", transaction_type: "trial", gross_amount_usd: 1 }),
      tx({ user_id: "u2", transaction_type: "upsell", gross_amount_usd: 19.99, event_time: "2026-03-01T01:00:00Z" }),
    ], selected);

    expect(options.upsellOptions[0]).toMatchObject({ price: 14.98, users: 1, transactions: 2 });
    expect(options.upsellOptions[0].percentage).toBeCloseTo(50);
    expect(options.upsellOptions[1]).toMatchObject({ price: 19.99, users: 1, transactions: 1 });
    expect(options.upsellOptions[1].percentage).toBeCloseTo(50);
    expect(defaultPriceSelection(options.upsellOptions)).toBe("weighted_average");
  });

  it("calculates upsell weighted average by transaction count", () => {
    const options: ForecastPriceOption[] = [
      { price: 14.98, users: 80, transactions: 80, percentage: 90 },
      { price: 19.99, users: 9, transactions: 9, percentage: 10 },
    ];

    expect(weightedAveragePrice(options, "transactions")).toBe(15.49);
  });

  it("uses custom upsell value override when selected", () => {
    const options: ForecastPriceOption[] = [{ price: 14.98, users: 10, transactions: 12, percentage: 100 }];

    expect(resolveSelectedPrice(options, "custom", 17.5, 14.98, "transactions")).toBe(17.5);
    expect(priceSourceLabel("custom", options)).toBe("Manual custom");
  });

  it("falls back to default upsell value when no upsells exist", () => {
    const options = buildForecastPriceOptions([
      tx({ user_id: "u1", transaction_type: "trial", gross_amount_usd: 1 }),
    ], selected);

    expect(options.upsellOptions).toEqual([]);
    expect(defaultPriceSelection(options.upsellOptions)).toBe("default");
    expect(resolveSelectedPrice(options.upsellOptions, "default", 0, 14.98, "transactions")).toBe(14.98);
  });
});

describe("Forecasting CAC", () => {
  it("auto-fills CAC from spend divided by trial users", () => {
    expect(resolveForecastCac({
      actualSpend: 250,
      trialUsers: 20,
      manualCac: "",
      manualOverride: false,
    })).toEqual({
      actualCac: 12.5,
      cac: 12.5,
      source: "actual",
    });
  });

  it("uses manual CAC override", () => {
    expect(resolveForecastCac({
      actualSpend: 250,
      trialUsers: 20,
      manualCac: "9.75",
      manualOverride: true,
    })).toEqual({
      actualCac: 12.5,
      cac: 9.75,
      source: "manual",
    });
  });

  it("resets to actual CAC by disabling manual override", () => {
    expect(resolveForecastCac({
      actualSpend: 250,
      trialUsers: 20,
      manualCac: "9.75",
      manualOverride: false,
    })).toMatchObject({
      cac: 12.5,
      source: "actual",
    });
  });

  it("calculates projected spend from trial users and CAC", () => {
    expect(projectedSpendFromCac(20, 9.75)).toBe(195);
  });

  it("calculates profit and ROAS from projected spend", () => {
    const projectedSpend = projectedSpendFromCac(20, 10);

    expect(forecastProfit(500, projectedSpend)).toBe(300);
    expect(forecastRoas(500, projectedSpend)).toBe(2.5);
  });
});
