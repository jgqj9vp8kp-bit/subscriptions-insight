// The client-side statistics of the Banks tab: volume badges, the Wilson
// signal, and the cache keys that make a filter change actually refetch.
import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import {
  signalBadge,
  volumeBadge,
  wilsonInterval,
  buildBankAnalyticsRequest,
  EMPTY_BANK_QUERY,
} from "@/services/bankAnalyticsDataSource";
import { bankAnalyticsBundleKey, bankDetailKey, normalizeBankRequest } from "@/services/bankAnalyticsCache";

describe("volumeBadge boundaries", () => {
  it("switches exactly at 30, 100 and 300", () => {
    expect(volumeBadge(29)).toBe("too_few");
    expect(volumeBadge(30)).toBe("low_volume");
    expect(volumeBadge(99)).toBe("low_volume");
    expect(volumeBadge(100)).toBe("indicative");
    expect(volumeBadge(299)).toBe("indicative");
    expect(volumeBadge(300)).toBeNull();
  });
});

describe("wilsonInterval", () => {
  it("matches a known reference value", () => {
    // 10/40 = 25%: Wilson 95% ≈ [14.2%, 40.2%].
    const { low, high } = wilsonInterval(10, 40);
    expect(low).toBeCloseTo(0.1419, 3);
    expect(high).toBeCloseTo(0.4023, 3);
  });

  it("narrows with volume and stays inside [0,1] at the extremes", () => {
    const small = wilsonInterval(5, 10);
    const large = wilsonInterval(500, 1000);
    expect(large.high - large.low).toBeLessThan(small.high - small.low);
    // Floating point: the exact-zero case lands at ~6e-18, not literal 0.
    expect(wilsonInterval(0, 50).low).toBeCloseTo(0, 10);
    expect(wilsonInterval(50, 50).high).toBeCloseTo(1, 10);
  });

  it("degrades safely at zero attempts", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("signalBadge", () => {
  const ACCOUNT = 0.404; // the live account rate

  it("never fires below 30 attempts — the interval spans everything", () => {
    expect(signalBadge(0, 10, ACCOUNT)).toBeNull();
    expect(signalBadge(10, 10, ACCOUNT)).toBeNull();
  });

  it("flags the live extremes correctly", () => {
    // Sutton Bank: 774/3491 = 22.2% — far below the account's 40.4%.
    expect(signalBadge(774, 3491, ACCOUNT)).toBe("below_account");
    // Bank of America: 265/469 = 56.5% — clearly above.
    expect(signalBadge(265, 469, ACCOUNT)).toBe("above_account");
  });

  it("stays silent when the interval covers the account rate", () => {
    // 40% of 100 with a ±9.6pp interval covers 40.4%.
    expect(signalBadge(40, 100, ACCOUNT)).toBeNull();
  });
});

describe("cache keys", () => {
  const parts = { userScopeHash: "u_1", warehouseVersion: "whv_x" };

  it("every filter reaches the bundle key — an absent filter is a filter that does nothing", () => {
    const base = bankAnalyticsBundleKey({ ...parts, request: EMPTY_BANK_QUERY });
    for (const patch of [
      { issuer: ["sutton_bank"] }, { issuerGroup: ["bancolombia"] },
      { cardNetwork: ["visa"] }, { paymentMethod: ["apple_pay"] },
      { issuerCountry: ["US"] }, { funnel: ["soulmate"] },
      { dateFrom: "2026-07-01" }, { outcome: "failed" as const },
    ]) {
      const key = bankAnalyticsBundleKey({ ...parts, request: { ...EMPTY_BANK_QUERY, ...patch } });
      expect(hashKey(key)).not.toBe(hashKey(base));
    }
  });

  it("order and duplicates of a selection do not re-key", () => {
    const a = normalizeBankRequest({ ...EMPTY_BANK_QUERY, issuer: ["b", "a", "b"] });
    const b = normalizeBankRequest({ ...EMPTY_BANK_QUERY, issuer: ["a", "b"] });
    expect(a).toEqual(b);
  });

  it("detail keys are per issuer on top of the same scope", () => {
    const a = bankDetailKey({ ...parts, request: EMPTY_BANK_QUERY, issuerKey: "sutton_bank" });
    const b = bankDetailKey({ ...parts, request: EMPTY_BANK_QUERY, issuerKey: "green_dot_bank" });
    expect(hashKey(a)).not.toBe(hashKey(b));
  });

  it("keys rotate with the warehouse version", () => {
    const a = bankAnalyticsBundleKey({ ...parts, request: EMPTY_BANK_QUERY });
    const b = bankAnalyticsBundleKey({ userScopeHash: "u_1", warehouseVersion: "whv_y", request: EMPTY_BANK_QUERY });
    expect(hashKey(a)).not.toBe(hashKey(b));
  });
});

describe("buildBankAnalyticsRequest", () => {
  it("maps the query onto the server's snake_case filter contract", () => {
    const req = buildBankAnalyticsRequest({
      ...EMPTY_BANK_QUERY,
      issuer: ["sutton_bank"], cardNetwork: ["visa"], paymentMethod: ["apple_pay"],
      issuerCountry: ["US"], issuerGroup: ["bancolombia"],
    });
    expect(req.action).toBe("banks");
    const filters = req.filters as Record<string, unknown>;
    expect(filters.issuer).toEqual(["sutton_bank"]);
    expect(filters.card_network).toEqual(["visa"]);
    expect(filters.payment_method).toEqual(["apple_pay"]);
    expect(filters.issuer_country).toEqual(["US"]);
    expect(filters.issuer_group).toEqual(["bancolombia"]);
  });
});
