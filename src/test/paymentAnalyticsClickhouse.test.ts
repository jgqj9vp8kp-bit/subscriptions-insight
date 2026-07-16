import { describe, expect, it } from "vitest";
import {
  PaymentAnalyticsRequestError,
  normalizePaymentAnalyticsRequest,
  stagedWith,
} from "../../supabase/functions/_shared/clickhouse/paymentAnalytics.ts";
import { buildPaymentAnalyticsRequest, type PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";

describe("clickhouse-payment-analytics request validation", () => {
  it("defaults + normalizes filters and dimensions", () => {
    const r = normalizePaymentAnalyticsRequest({});
    expect(r.action).toBe("analytics");
    expect(r.filters.date_basis).toBe("transaction");
    expect(r.filters.outcome).toBe("all");
    expect(r.groupBy).toBe("country");
  });

  it("rejects malformed dates and non-array filters", () => {
    expect(() => normalizePaymentAnalyticsRequest({ filters: { date_from: "2026/01/01" } })).toThrow(PaymentAnalyticsRequestError);
    expect(() => normalizePaymentAnalyticsRequest({ filters: { funnel: "soulmate" as never } })).toThrow(PaymentAnalyticsRequestError);
  });

  it("falls back invalid dimensions to a safe default (no arbitrary columns)", () => {
    expect(normalizePaymentAnalyticsRequest({ group_by: "DROP TABLE" as never }).groupBy).toBe("country");
    expect(normalizePaymentAnalyticsRequest({ group_by: "funnel" }).groupBy).toBe("funnel");
  });

  it("normalizes outcome + date_basis", () => {
    const r = normalizePaymentAnalyticsRequest({ filters: { outcome: "failed", date_basis: "cohort" } });
    expect(r.filters.outcome).toBe("failed");
    expect(r.filters.date_basis).toBe("cohort");
  });
});

describe("clickhouse-payment-analytics SQL safety", () => {
  it("scopes by auth_user_id via a bound parameter and never selects raw payloads", () => {
    const params: Record<string, unknown> = {};
    const sql = stagedWith("user-9", { date_basis: "transaction", date_from: null, date_to: null, funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], card_type: [], stage: [], decline_reason: [], transaction_type: [], outcome: "all" }, params);
    expect(sql).toContain("auth_user_id = {auth_user_id:String}");
    expect(params.auth_user_id).toBe("user-9");
    expect(sql).not.toMatch(/raw_payload/);
    expect(sql).not.toMatch(/normalized_payload/);
    // canonical warehouse decline_reason is used (not a client re-derivation)
    expect(sql).toContain("decline_reason");
  });
});

const baseQuery: PaymentAnalyticsQuery = {
  dateBasis: "transaction", dateFrom: null, dateTo: null,
  funnel: "all", campaignPath: "all", campaignId: "all", mediaBuyer: "all", country: "all", cardType: "all",
  stage: "all", declineReason: "all", transactionType: "all", outcome: "all",
  groupBy: "country", firstTxDimension: "funnel", renewalDimension: "funnel",
};

describe("buildPaymentAnalyticsRequest", () => {
  it("omits 'all' single-selects and forwards active filters + dimensions", () => {
    const req = buildPaymentAnalyticsRequest({ ...baseQuery, funnel: "soulmate", outcome: "failed", groupBy: "card_type" }) as never;
    const f = (req as Record<string, Record<string, unknown>>).filters;
    expect(f.funnel).toEqual(["soulmate"]);
    expect(f.country).toEqual([]);
    expect(f.outcome).toBe("failed");
    expect((req as Record<string, unknown>).group_by).toBe("card_type");
  });

  it("forwards the active campaign path exactly once", () => {
    const req = buildPaymentAnalyticsRequest({ ...baseQuery, campaignPath: "soulmate-1-week" }) as never;
    const f = (req as Record<string, Record<string, unknown>>).filters;
    expect(f.campaign_path).toEqual(["soulmate-1-week"]);
  });
});
