import { describe, expect, it } from "vitest";
import {
  buildForecastPriceOptions,
  cohortIdForTrial,
  defaultPriceSelection,
  fallbackRetentionForMonth,
  forecastProfit,
  forecastRoas,
  projectedSpendFromCac,
  priceSourceLabel,
  resolveForecastCac,
  reconcilePriceSelection,
  resolveSelectedPrice,
  retentionPercentagesForCohorts,
  weightedAveragePrice,
  type ForecastPriceOption,
} from "@/services/forecasting";
import type { CohortRow, Transaction } from "@/services/types";

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

describe("Forecasting retention (P0-1)", () => {
  // Build a transaction WITHOUT cohort_id / cohort_date so the retention path must re-derive the
  // cohort id from funnel + campaign_path + event_time (the bug being fixed).
  function rtx(partial: Partial<Transaction>): Transaction {
    return {
      transaction_id: partial.transaction_id ?? `${partial.user_id}_${partial.transaction_type}_${partial.event_time}`,
      user_id: partial.user_id ?? "user_1",
      email: partial.email ?? "u@example.com",
      event_time: partial.event_time ?? "2026-03-01T00:00:00Z",
      amount_usd: partial.amount_usd ?? 0,
      gross_amount_usd: partial.gross_amount_usd ?? 0,
      refund_amount_usd: partial.refund_amount_usd ?? 0,
      net_amount_usd: partial.net_amount_usd ?? 0,
      is_refunded: partial.is_refunded ?? false,
      currency: "USD",
      status: partial.status ?? "success",
      transaction_type: partial.transaction_type ?? "trial",
      funnel: partial.funnel ?? "soulmate",
      campaign_path: partial.campaign_path ?? "soulmate-reading",
      product: "",
      traffic_source: "facebook",
      campaign_id: "",
      classification_reason: "",
      cohort_date: partial.cohort_date,
      cohort_id: partial.cohort_id,
      transaction_day: partial.transaction_day ?? 0,
    };
  }

  // Cohort id that computeCohorts would assign to these trials: funnel_path_date.
  const SELECTED_ID = "soulmate_soulmate-reading_2026-03-01";

  it("re-derives cohort id from funnel + path + date (includes the funnel segment)", () => {
    const trial = rtx({ user_id: "u1", transaction_type: "trial", event_time: "2026-03-01T00:00:00Z" });
    // The fix: funnel is part of the key. The old buggy form was `${path}_${date}` (no funnel).
    expect(cohortIdForTrial(trial)).toBe(SELECTED_ID);
    expect(cohortIdForTrial(trial)).not.toBe("soulmate-reading_2026-03-01");
  });

  it("produces actual retention (non-null => source auto_actual) for cohort_id-less transactions", () => {
    const txs = [
      rtx({ user_id: "u1", transaction_type: "trial", event_time: "2026-03-01T00:00:00Z" }),
      rtx({ user_id: "u2", transaction_type: "trial", event_time: "2026-03-01T00:00:00Z" }),
      // u1 retains in month 1 (9 days after trial).
      rtx({ user_id: "u1", transaction_type: "first_subscription", event_time: "2026-03-10T00:00:00Z" }),
    ];

    const actual = retentionPercentagesForCohorts(txs, [SELECTED_ID]);

    // Month 1: 1 of 2 trial users retained => 50%. Critically NOT null => page renders source=auto_actual.
    expect(actual[0]).toBe(50);
    expect(actual[0]).not.toBeNull();

    // Sanity: the old key (no funnel) would have matched nothing => all null (the original bug).
    const buggy = retentionPercentagesForCohorts(txs, ["soulmate-reading_2026-03-01"]);
    expect(buggy.every((value) => value === null)).toBe(true);
  });

  it("keeps a genuine 0% retention month at 0 (does not fall back) when the cohort has trial users", () => {
    // One trial user, no subscriptions/renewals at all => every month is a real 0%, not "no data".
    const txs = [rtx({ user_id: "u1", transaction_type: "trial", event_time: "2026-03-01T00:00:00Z" })];

    const actual = retentionPercentagesForCohorts(txs, [SELECTED_ID]);

    expect(actual).toHaveLength(12);
    // Strictly 0 (number), never null — so the page uses source=auto_actual and does NOT substitute
    // the fallback curve for these months.
    expect(actual.every((value) => value === 0)).toBe(true);
  });

  it("returns all-null (=> fallback) only when the cohort set has no trial users", () => {
    const txs = [rtx({ user_id: "u1", transaction_type: "trial", event_time: "2026-03-01T00:00:00Z" })];

    // A cohort id that no trial matches => no trial users => all null => caller falls back.
    const noData = retentionPercentagesForCohorts(txs, ["soulmate_other-path_2026-03-01"]);
    expect(noData.every((value) => value === null)).toBe(true);
  });

  it("fallback uses same-path actual data when it exists, and the default curve only when no trial data exists", () => {
    const cohort = (id: string, path: string): CohortRow =>
      ({ cohort_id: id, campaign_path: path } as unknown as CohortRow);

    const defaultCurve = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0.5, 0.25];
    const selectedId = "soulmate_soulmate-reading_2026-03-01"; // no trials in Feb dataset below
    const otherSamePathId = "soulmate_soulmate-reading_2026-02-01";

    // Same-path cohort (Feb) DOES have trial data: 2 trials, 1 retained in month 1 => 50%.
    const txsWithSamePath = [
      rtx({ user_id: "f1", transaction_type: "trial", event_time: "2026-02-01T00:00:00Z" }),
      rtx({ user_id: "f2", transaction_type: "trial", event_time: "2026-02-01T00:00:00Z" }),
      rtx({ user_id: "f1", transaction_type: "first_subscription", event_time: "2026-02-06T00:00:00Z" }),
    ];
    const allCohorts = [cohort(selectedId, "soulmate-reading"), cohort(otherSamePathId, "soulmate-reading")];
    const selectedIds = new Set([selectedId]);
    const selectedPaths = new Set(["soulmate-reading"]);

    const samePathFallback = fallbackRetentionForMonth(0, txsWithSamePath, allCohorts, selectedIds, selectedPaths, defaultCurve);
    expect(samePathFallback).toBe(50); // same-path actual, NOT the default 10

    // No trial data anywhere => default curve is used.
    const defaultFallback = fallbackRetentionForMonth(0, [], allCohorts, selectedIds, selectedPaths, defaultCurve);
    expect(defaultFallback).toBe(10);
  });
});
