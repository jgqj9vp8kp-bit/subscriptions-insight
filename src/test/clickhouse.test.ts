import { describe, expect, it } from "vitest";
import { clickHouseStatusLabel } from "@/services/clickhouse";

describe("clickHouseStatusLabel", () => {
  it("returns Unknown before any test has run", () => {
    expect(clickHouseStatusLabel(null)).toBe("Unknown");
  });

  it("returns Connected when SELECT 1 succeeded", () => {
    expect(clickHouseStatusLabel({ connected: true, configured: true, result: 1 })).toBe("Connected");
  });

  it("returns Not configured when the server has no ClickHouse env", () => {
    expect(clickHouseStatusLabel({ connected: false, configured: false })).toBe("Not configured");
  });

  it("returns Not connected when configured but the query failed", () => {
    expect(clickHouseStatusLabel({ connected: false, configured: true, error: "timeout" })).toBe("Not connected");
  });
});
