import { describe, expect, it } from "vitest";
import {
  convertAmountToUsd,
  normalizeTransactionsToUsd,
} from "@/services/currencyNormalization";
import { FX_RATES_TO_USD } from "@/services/fxRates";
import { computeCohorts, computeCohortsWithDiagnostics } from "@/services/analytics";
import type { Transaction, TransactionStatus, TransactionType } from "@/services/types";

function tx(
  userId: string,
  transactionType: TransactionType,
  eventTime: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  // Money fields are in the ORIGINAL charge currency, exactly like warehouse rows.
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 14.98);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${eventTime}-${amount}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount - (overrides.refund_amount_usd ?? 0),
    is_refunded: false,
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-1-sp",
    product: overrides.product ?? "Product",
    traffic_source: "facebook",
    campaign_id: "campaign",
    classification_reason: "",
    billing_reason: overrides.billing_reason,
    metadata: overrides.metadata,
  };
}

const MXN = FX_RATES_TO_USD.MXN;
const cohortFor = (rows: Transaction[]) => {
  const cohort = computeCohorts(rows)[0];
  if (!cohort) throw new Error("Expected a cohort");
  return cohort;
};

describe("convertAmountToUsd", () => {
  it("keeps native USD amounts as-is", () => {
    expect(convertAmountToUsd(10, "USD")).toMatchObject({
      original_amount: 10,
      original_currency: "USD",
      amount_usd: 10,
      fx_rate: 1,
      conversion_status: "native_usd",
    });
  });

  it("converts EUR to USD", () => {
    const result = convertAmountToUsd(10, "EUR");
    expect(result.conversion_status).toBe("converted");
    expect(result.amount_usd).toBeCloseTo(10 * FX_RATES_TO_USD.EUR, 2);
    expect(result.fx_rate).toBe(FX_RATES_TO_USD.EUR);
  });

  it("converts MXN to USD", () => {
    const result = convertAmountToUsd(279, "MXN");
    expect(result.conversion_status).toBe("converted");
    expect(result.amount_usd).toBeCloseTo(279 * MXN, 2);
  });

  it("converts COP to USD", () => {
    const result = convertAmountToUsd(60899, "COP");
    expect(result.conversion_status).toBe("converted");
    expect(result.amount_usd).toBeCloseTo(60899 * FX_RATES_TO_USD.COP, 2);
  });

  it("flags a missing currency instead of silently counting the amount", () => {
    expect(convertAmountToUsd(10, null)).toMatchObject({ amount_usd: null, conversion_status: "missing_currency" });
    expect(convertAmountToUsd(10, "  ")).toMatchObject({ conversion_status: "missing_currency" });
  });

  it("flags an unknown currency as missing_fx_rate", () => {
    expect(convertAmountToUsd(10, "XYZ")).toMatchObject({ amount_usd: null, fx_rate: null, conversion_status: "missing_fx_rate" });
  });

  it("flags invalid amounts", () => {
    expect(convertAmountToUsd(Number.NaN, "USD").conversion_status).toBe("invalid_amount");
    expect(convertAmountToUsd("not-a-number", "USD").conversion_status).toBe("invalid_amount");
  });
});

describe("normalizeTransactionsToUsd", () => {
  it("is idempotent and preserves originals", () => {
    const once = normalizeTransactionsToUsd([tx("u", "trial", "2026-07-01T00:00:00Z", { amount_usd: 17, currency: "MXN" })]);
    const twice = normalizeTransactionsToUsd(once.transactions);
    expect(once.transactions[0].gross_amount_usd).toBeCloseTo(17 * MXN, 2);
    expect(once.transactions[0].original_gross_amount).toBe(17);
    expect(once.transactions[0].original_currency).toBe("MXN");
    expect(twice.transactions[0].gross_amount_usd).toBeCloseTo(17 * MXN, 2); // not converted twice
    expect(twice.diagnostics.transactions_converted).toBe(1);
  });
});

describe("cohort revenue metrics use USD-normalized amounts", () => {
  it("gross and net revenue convert local currency (not raw local sums)", () => {
    const cohort = cohortFor([
      tx("mx", "trial", "2026-07-01T00:00:00Z", { amount_usd: 17, currency: "MXN" }),
      tx("us", "trial", "2026-07-01T01:00:00Z", { amount_usd: 1, currency: "USD" }),
    ]);
    const expected = 17 * MXN + 1; // ≈ 1.92 USD, NOT 18
    expect(cohort.gross_revenue).toBeCloseTo(expected, 2);
    expect(cohort.net_revenue).toBeCloseTo(expected, 2);
    expect(cohort.trial_users).toBe(2); // counts unchanged
  });

  it("upsell revenue converts to USD", () => {
    const cohort = cohortFor([
      tx("mx", "trial", "2026-07-05T00:00:00Z", { amount_usd: 17, currency: "MXN" }),
      tx("mx", "upsell", "2026-07-05T00:01:00Z", { amount_usd: 279, currency: "MXN", billing_reason: "upsell" }),
    ]);
    expect(cohort.upsell_1_revenue).toBeCloseTo(279 * MXN, 2);
    expect(cohort.funnel_upsell_revenue).toBeCloseTo(279 * MXN, 2);
  });

  it("token revenue converts to USD", () => {
    const cohort = cohortFor([
      tx("mx", "trial", "2026-07-05T00:00:00Z", { amount_usd: 17, currency: "MXN" }),
      tx("mx", "token_purchase", "2026-07-05T00:10:00Z", { product: "100 Tokens", amount_usd: 90, currency: "MXN" }),
    ]);
    expect(cohort.token_gross_revenue).toBeCloseTo(90 * MXN, 2);
    expect(cohort.token_net_revenue).toBeCloseTo(90 * MXN, 2);
  });

  it("refunds convert to USD", () => {
    const cohort = cohortFor([
      tx("mx", "trial", "2026-07-01T00:00:00Z", { amount_usd: 100, currency: "MXN", refund_amount_usd: 50 }),
    ]);
    expect(cohort.amount_refunded).toBeCloseTo(50 * MXN, 2);
    expect(cohort.net_revenue).toBeCloseTo(50 * MXN, 2);
  });
});

describe("currency breakdown", () => {
  const rows = [
    tx("mx1", "trial", "2026-07-01T00:00:00Z", { amount_usd: 17, currency: "MXN" }),
    tx("mx2", "trial", "2026-07-01T01:00:00Z", { amount_usd: 17, currency: "MXN" }),
    tx("us1", "trial", "2026-07-01T02:00:00Z", { amount_usd: 1, currency: "USD" }),
  ];

  it("groups trials, transactions and revenue by original currency", () => {
    const cohort = cohortFor(rows);
    const byCurrency = new Map((cohort.currency_breakdown ?? []).map((row) => [row.currency, row]));
    expect(byCurrency.get("MXN")).toMatchObject({
      trial_users: 2,
      transactions: 2,
      gross_original: 34,
      avg_trial_price_original: 17,
    });
    expect(byCurrency.get("MXN")?.gross_usd).toBeCloseTo(34 * MXN, 2);
    expect(byCurrency.get("MXN")?.avg_trial_price_usd).toBeCloseTo(17 * MXN, 2);
    expect(byCurrency.get("USD")).toMatchObject({ trial_users: 1, gross_original: 1, gross_usd: 1 });
    expect(cohort.currency_mix).toBe("MXN 2 · USD 1");
  });

  it("currency filter keeps only users whose trial charge is in the selected currency", () => {
    const cohorts = computeCohorts(rows, [], { selectedCurrencies: ["MXN"] });
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].trial_users).toBe(2);
    expect(cohorts[0].gross_revenue).toBeCloseTo(34 * MXN, 2);
    expect(computeCohorts(rows, [], { selectedCurrencies: ["USD"] })[0].trial_users).toBe(1);
  });
});

describe("missing FX policy", () => {
  it("excludes unconvertible revenue from USD metrics and flags it in diagnostics", () => {
    const { cohorts, fxDiagnostics } = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-07-01T00:00:00Z", { amount_usd: 1, currency: "USD" }),
      tx("u1", "first_subscription", "2026-07-08T00:00:00Z", { amount_usd: 100, currency: "XYZ" }),
    ]);
    // The XYZ charge is NOT silently added to USD revenue…
    expect(cohorts[0].gross_revenue).toBeCloseTo(1, 2);
    // …but the row/user is still counted and the exclusion is reported.
    expect(cohorts[0].first_subscription_users).toBe(1);
    expect(cohorts[0].fx_missing_transactions).toBe(1);
    expect(cohorts[0].fx_missing_amount).toBe(100);
    expect(fxDiagnostics.transactions_missing_fx_rate).toBe(1);
    expect(fxDiagnostics.excluded_transactions).toBe(1);
    expect(fxDiagnostics.excluded_amount_original).toBe(100);
    expect(fxDiagnostics.transactions_native_usd).toBe(1);
  });
});
