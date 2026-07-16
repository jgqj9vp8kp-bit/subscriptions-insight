import { describe, expect, it } from "vitest";
import {
  aggregateTokenPackBreakdowns,
  buildTokenPackBreakdown,
  hasAddonMarker,
  hasUpsellMarker,
  isTokenPurchaseTransaction,
  monetizationCategoryForTransaction,
} from "@/services/monetization";
import { isKnownTokenAmount, knownTokenAmounts } from "@/services/monetizationProductMap";
import type { Transaction, TransactionStatus, TransactionType } from "@/services/types";

function tx(
  transactionType: TransactionType,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? 9.99;
  return {
    transaction_id: overrides.transaction_id ?? `tx-${transactionType}-${Math.abs(amount)}`,
    user_id: overrides.user_id ?? "u1",
    email: "u1@example.com",
    event_time: overrides.event_time ?? "2026-06-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    is_refunded: false,
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    product: overrides.product ?? "Product",
    traffic_source: "facebook",
    campaign_id: "campaign",
    classification_reason: "",
    billing_reason: overrides.billing_reason,
    metadata: overrides.metadata,
  };
}

describe("token purchase detection (config-driven)", () => {
  it("detects token packs by product name pattern", () => {
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "300 Tokens Pack", amount_usd: 3 }))).toBe(true);
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "20 Minutes Astrologer Chat", amount_usd: 3 }))).toBe(true);
    expect(isTokenPurchaseTransaction(tx("unknown", { metadata: { product_name: "Chat credits" }, amount_usd: 3 }))).toBe(true);
  });

  it("detects token packs by known pack price + currency (audited $4.99/$9.99 USD)", () => {
    expect(knownTokenAmounts.length).toBeGreaterThan(0);
    expect(isKnownTokenAmount(4.99, "USD")).toBe(true);
    expect(isKnownTokenAmount(9.99, "USD")).toBe(true);
    expect(isKnownTokenAmount(9.99, "MXN")).toBe(false);
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "Palmer transaction", amount_usd: 4.99 }))).toBe(true);
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "Palmer transaction", amount_usd: 9.99, currency: "USD" }))).toBe(true);
  });

  it("does not match subscription products or unrelated amounts", () => {
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "Monthly Subscription", amount_usd: 29.99 }))).toBe(false);
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "Trial 7-day", amount_usd: 1 }))).toBe(false);
    expect(isTokenPurchaseTransaction(tx("unknown", { product: "Palmer transaction", amount_usd: 14.99 }))).toBe(false);
  });

  it("lets an explicit upsell marker win over token-like signals", () => {
    expect(
      isTokenPurchaseTransaction(tx("unknown", { product: "Extra 20 minutes", billing_reason: "post_purchase_upsell" })),
    ).toBe(false);
    expect(
      isTokenPurchaseTransaction(tx("unknown", { amount_usd: 4.99, billing_reason: "upsell" })),
    ).toBe(false);
    expect(hasUpsellMarker(tx("unknown", { product: "Premium Reading Upsell" }))).toBe(true);
  });
});

describe("monetizationCategoryForTransaction", () => {
  it("maps lifecycle types to categories (slots are order-based, assigned in analytics)", () => {
    expect(monetizationCategoryForTransaction(tx("trial"))).toBe("trial");
    expect(monetizationCategoryForTransaction(tx("upsell", { billing_reason: "upsell" }))).toBe("funnel_upsell");
    expect(monetizationCategoryForTransaction(tx("first_subscription"))).toBe("first_subscription");
    expect(monetizationCategoryForTransaction(tx("renewal_2"))).toBe("renewal");
    expect(monetizationCategoryForTransaction(tx("token_purchase", { product: "100 Tokens" }))).toBe("token_purchase");
  });

  it("classifies explicit one-time/add-on markers without token signals as unknown_addon", () => {
    expect(monetizationCategoryForTransaction(tx("unknown", { billing_reason: "one_time", amount_usd: 3.33 }))).toBe("unknown_addon");
    expect(hasAddonMarker(tx("unknown", { billing_reason: "add-on purchase" }))).toBe(true);
    expect(monetizationCategoryForTransaction(tx("unknown", { amount_usd: 3.33 }))).toBeNull();
    expect(monetizationCategoryForTransaction(tx("refund"))).toBeNull();
  });
});

describe("token pack breakdown", () => {
  const packTxs = [
    tx("token_purchase", { transaction_id: "t1", user_id: "u1", product: "100 Tokens", amount_usd: 4.99 }),
    tx("token_purchase", { transaction_id: "t2", user_id: "u1", product: "100 Tokens", amount_usd: 4.99 }),
    tx("token_purchase", { transaction_id: "t3", user_id: "u2", product: "300 Tokens", amount_usd: 9.99 }),
    tx("token_purchase", { transaction_id: "t4", user_id: "u2", product: "100 Tokens", amount_usd: 4.99, status: "failed" }),
    tx("trial", { transaction_id: "t5", user_id: "u2", amount_usd: 1 }),
  ];

  it("groups successful token purchases by product and price", () => {
    const packs = buildTokenPackBreakdown(packTxs);
    // Sorted by gross revenue, highest first.
    expect(packs).toEqual([
      {
        product_id: null,
        product: "300 Tokens",
        price: 9.99,
        purchases: 1,
        buyers: 1,
        gross_revenue: 9.99,
        revenue_share: expect.closeTo((9.99 / 19.97) * 100, 5),
      },
      {
        product_id: null,
        product: "100 Tokens",
        price: 4.99,
        purchases: 2,
        buyers: 1,
        gross_revenue: 9.98,
        revenue_share: expect.closeTo((9.98 / 19.97) * 100, 5),
      },
    ]);
  });

  it("aggregates pack breakdowns across cohorts and recomputes shares", () => {
    const a = buildTokenPackBreakdown(packTxs);
    const b = buildTokenPackBreakdown([
      tx("token_purchase", { transaction_id: "t6", user_id: "u3", product: "300 Tokens", amount_usd: 9.99 }),
    ]);
    const merged = aggregateTokenPackBreakdowns([a, b]);
    const pack300 = merged.find((row) => row.product === "300 Tokens");
    expect(pack300).toMatchObject({ purchases: 2, buyers: 2, gross_revenue: 19.98 });
    expect(merged.reduce((sum, row) => sum + row.revenue_share, 0)).toBeCloseTo(100, 5);
  });
});
