import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import {
  PAYMENT_ANALYTICS_RESPONSE_SCHEMA_VERSION,
  paymentAnalyticsBundleKey,
  normalizePaymentRequest,
} from "@/services/paymentAnalyticsCache";
import { hashUserScope } from "@/services/analyticsCache";
import type { PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";

const q = (over: Partial<PaymentAnalyticsQuery> = {}): PaymentAnalyticsQuery => ({
  dateBasis: "transaction",
  dateFrom: null,
  dateTo: null,
  funnel: "all",
  campaignPath: "all",
  campaignId: "all",
  mediaBuyer: "all",
  country: "all",
  cardType: "all",
  stage: "all",
  declineReason: "all",
  transactionType: "all",
  outcome: "all",
  groupBy: "country",
  firstTxDimension: "country",
  renewalDimension: "country",
  ...over,
});
const parts = (request: PaymentAnalyticsQuery) => ({ userScopeHash: "u_1", warehouseVersion: "whv_x", request });

describe("payment-analytics cache keys", () => {
  it("logically identical queries → identical key", () => {
    expect(normalizePaymentRequest(q())).toEqual(normalizePaymentRequest(q()));
    expect(hashKey(paymentAnalyticsBundleKey(parts(q())))).toBe(hashKey(paymentAnalyticsBundleKey(parts(q()))));
    expect(paymentAnalyticsBundleKey(parts(q()))[0]).toBe("payment-analytics");
    expect(paymentAnalyticsBundleKey(parts(q()))[1]).toBe("bundle");
    expect(paymentAnalyticsBundleKey(parts(q()))[2]).toBe(PAYMENT_ANALYTICS_RESPONSE_SCHEMA_VERSION);
  });

  it("different filters / selectors → different keys", () => {
    expect(hashKey(paymentAnalyticsBundleKey(parts(q())))).not.toBe(hashKey(paymentAnalyticsBundleKey(parts(q({ country: "US" })))));
    expect(hashKey(paymentAnalyticsBundleKey(parts(q())))).not.toBe(hashKey(paymentAnalyticsBundleKey(parts(q({ groupBy: "card_type" })))));
    expect(hashKey(paymentAnalyticsBundleKey(parts(q())))).not.toBe(hashKey(paymentAnalyticsBundleKey(parts(q({ dateBasis: "cohort" })))));
  });

  it("isolated by user; busted by warehouse version", () => {
    const a = { userScopeHash: hashUserScope("a"), warehouseVersion: "whv_x", request: q() };
    const b = { userScopeHash: hashUserScope("b"), warehouseVersion: "whv_x", request: q() };
    const c = { userScopeHash: hashUserScope("a"), warehouseVersion: "whv_y", request: q() };
    expect(hashKey(paymentAnalyticsBundleKey(a))).not.toBe(hashKey(paymentAnalyticsBundleKey(b)));
    expect(hashKey(paymentAnalyticsBundleKey(a))).not.toBe(hashKey(paymentAnalyticsBundleKey(c)));
  });
});
