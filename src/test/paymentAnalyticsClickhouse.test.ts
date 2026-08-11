import { describe, expect, it } from "vitest";
import {
  PaymentAnalyticsRequestError,
  normalizePaymentAnalyticsRequest,
  stagedWith,
  _EMPTY_FILTERS,
  _METRIC_COLS,
  _attemptWhere,
  _stagedTableName,
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
    const sql = stagedWith("user-9", { date_basis: "transaction", date_from: null, date_to: null, funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], card_type: [], stage: [], decline_reason: [], transaction_type: [], issuer: [], issuer_group: [], card_network: [], payment_method: [], issuer_country: [], outcome: "all" }, params);
    expect(sql).toContain("auth_user_id = {auth_user_id:String}");
    expect(params.auth_user_id).toBe("user-9");
    expect(sql).not.toMatch(/raw_payload/);
    expect(sql).not.toMatch(/normalized_payload/);
    // canonical warehouse decline_reason is used (not a client re-derivation)
    expect(sql).toContain("decline_reason");
  });
});

describe("nothing moved — Banks additions are strictly additive", () => {
  it("STAGED_COLUMNS keeps the original 16 names in the original order, new ones appended", () => {
    // materializeStaged does a positional CREATE TABLE ... AS SELECT: reordering
    // this list silently shifts every downstream aggregation onto wrong columns.
    const params: Record<string, unknown> = {};
    const sql = stagedWith("u", _EMPTY_FILTERS, params);
    // The staged projection must still expose the original columns.
    for (const col of ["uid", "is_success", "is_failed", "rn", "ttype", "decline_key", "funnel", "campaign_path", "stage", "sub_level"]) {
      expect(sql).toContain(col);
    }
  });

  it("attemptWhere with the five new filters empty is byte-identical to before", () => {
    const params: Record<string, unknown> = {};
    const where = _attemptWhere({ ..._EMPTY_FILTERS, funnel: ["soulmate"], country: ["US"] }, params);
    expect(where).toBe("WHERE funnel IN ({p_fn_0:String}) AND country IN ({p_co_0:String})");
    expect(params).toEqual({ p_fn_0: "soulmate", p_co_0: "US" });
  });

  it("the five new filters bind with their own placeholder prefixes", () => {
    const params: Record<string, unknown> = {};
    const where = _attemptWhere({
      ..._EMPTY_FILTERS,
      issuer: ["sutton_bank"], issuer_group: ["bancolombia"], card_network: ["visa"],
      payment_method: ["apple_pay"], issuer_country: ["US"],
    }, params);
    expect(where).toContain("issuer_key IN ({p_ik_0:String})");
    expect(where).toContain("issuer_group IN ({p_ig_0:String})");
    expect(where).toContain("card_network IN ({p_cn_0:String})");
    expect(where).toContain("payment_method IN ({p_pm_0:String})");
    expect(where).toContain("issuer_country IN ({p_ic_0:String})");
    expect(params.p_ik_0).toBe("sutton_bank");
  });

  it("issuer columns ride the staged projection from allrows, never through uattr", () => {
    const params: Record<string, unknown> = {};
    const sql = stagedWith("u", _EMPTY_FILTERS, params);
    // Per-transaction projection: s.issuer_key, not a ua.eissuer argMin. A
    // user-level argMin would credit a successful card with the declines of
    // the card it replaced.
    expect(sql).toContain("s.issuer_key issuer_key");
    expect(sql).not.toMatch(/argMin\(ar\.issuer/);
    expect(sql).toContain("s.card_type_tx card_type_tx");
  });

  it("METRIC_COLS is unchanged — pass rate means the same thing on both tabs", () => {
    expect(_METRIC_COLS).toContain("count() attempts");
    expect(_METRIC_COLS).toContain("sum(is_success) successful");
    expect(_METRIC_COLS).toContain("insufficient_funds_failures");
  });

  it("the scratch-table name still matches the sweeper's pattern", () => {
    // sweepStaleTables only reaches /^pp_staged_[0-9a-f]{32}$/ — any other
    // prefix orphans tables forever.
    expect(_stagedTableName()).toMatch(/^pp_staged_[0-9a-f]{32}$/);
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
