import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_RENEWAL_COLUMNS,
  renewalColumnIds,
  sanitizeMaxRenewalColumns,
} from "@/services/dataSettings";

describe("data settings", () => {
  it("accepts configured max renewal column options", () => {
    expect(sanitizeMaxRenewalColumns("3")).toBe(3);
    expect(sanitizeMaxRenewalColumns(6)).toBe(6);
    expect(sanitizeMaxRenewalColumns("12")).toBe(12);
  });

  it("falls back to the default for invalid max renewal columns", () => {
    expect(sanitizeMaxRenewalColumns("10")).toBe(DEFAULT_MAX_RENEWAL_COLUMNS);
    expect(sanitizeMaxRenewalColumns(null)).toBe(DEFAULT_MAX_RENEWAL_COLUMNS);
  });

  it("builds dynamic Renewal column ids through the selected max renewal number", () => {
    expect(renewalColumnIds(3)).toEqual(["renewal_2_users", "renewal_3_users"]);
    expect(renewalColumnIds(6)).toEqual([
      "renewal_2_users",
      "renewal_3_users",
      "renewal_4_users",
      "renewal_5_users",
      "renewal_6_users",
    ]);
    expect(renewalColumnIds(12).at(-1)).toBe("renewal_12_users");
    expect(renewalColumnIds(12)).toHaveLength(11);
  });
});
