import { describe, expect, it } from "vitest";
import { shouldAutoLoadTransactionsForPath, shouldShowSampleDataBanner } from "@/services/transactionAutoLoadPolicy";

function storageWith(value: string | null): Storage {
  return {
    getItem: () => value,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
    key: () => null,
    length: value == null ? 0 : 1,
  };
}

describe("protected route transaction warehouse autoload policy", () => {
  it("does not autoload the full transaction warehouse on migrated aggregate routes", () => {
    expect(shouldAutoLoadTransactionsForPath("/cohorts", storageWith(null))).toBe(false);
    expect(shouldAutoLoadTransactionsForPath("/users", storageWith(null))).toBe(false);
  });

  it("keeps Payment Pass fast when the persisted Transactions tab is pass", () => {
    expect(shouldAutoLoadTransactionsForPath("/transactions", storageWith(JSON.stringify({ mode: "pass" })))).toBe(false);
  });

  it("loads lazily for the raw Transactions list and legacy routes", () => {
    expect(shouldAutoLoadTransactionsForPath("/transactions", storageWith(JSON.stringify({ mode: "list" })))).toBe(true);
    expect(shouldAutoLoadTransactionsForPath("/transactions", storageWith(null))).toBe(true);
    expect(shouldAutoLoadTransactionsForPath("/fb-analytics", storageWith(null))).toBe(true);
  });
});

describe("sample-data banner policy", () => {
  it("suppresses the banner on hydration-deferred routes — they render real ClickHouse data", () => {
    expect(shouldShowSampleDataBanner("mock", "/cohorts", storageWith(null))).toBe(false);
    expect(shouldShowSampleDataBanner("mock", "/users", storageWith(null))).toBe(false);
    expect(shouldShowSampleDataBanner("mock", "/transactions", storageWith(JSON.stringify({ mode: "pass" })))).toBe(false);
  });

  it("keeps the banner where hydration is attempted and the store is still mock", () => {
    expect(shouldShowSampleDataBanner("mock", "/", storageWith(null))).toBe(true);
    expect(shouldShowSampleDataBanner("mock", "/fb-analytics", storageWith(null))).toBe(true);
    expect(shouldShowSampleDataBanner("mock", "/transactions", storageWith(JSON.stringify({ mode: "list" })))).toBe(true);
  });

  it("never shows the banner once real data is loaded, on any route", () => {
    expect(shouldShowSampleDataBanner("transaction_warehouse", "/", storageWith(null))).toBe(false);
    expect(shouldShowSampleDataBanner("palmer_import", "/fb-analytics", storageWith(null))).toBe(false);
  });
});
