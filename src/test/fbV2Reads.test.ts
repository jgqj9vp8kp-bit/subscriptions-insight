import { describe, expect, it } from "vitest";
import { fbReadFrom, fbV2ReadsEnabled, runFbList } from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import {
  V_FB_STATS_V2_ACCOUNT_COMPAT,
  V_FB_STATS_V2_AD_COMPAT,
  V_FB_STATS_V2_ADSET_COMPAT,
  V_FB_STATS_V2_CAMPAIGN_COMPAT,
  FB_WAREHOUSE_V2_DDL,
} from "../../supabase/functions/_shared/clickhouse/fbWarehouseV2Schema.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

describe("fbV2ReadsEnabled", () => {
  it("parses the usual truthy spellings and defaults to off", () => {
    expect(fbV2ReadsEnabled(undefined)).toBe(false);
    expect(fbV2ReadsEnabled("")).toBe(false);
    expect(fbV2ReadsEnabled("false")).toBe(false);
    expect(fbV2ReadsEnabled("1")).toBe(true);
    expect(fbV2ReadsEnabled("TRUE")).toBe(true);
    expect(fbV2ReadsEnabled("on")).toBe(true);
  });
});

describe("fbReadFrom", () => {
  it("keeps V1 (with FINAL) by default and for the day grain", () => {
    expect(fbReadFrom("campaign", "fb", false)).toBe("fact_facebook_stats AS fb FINAL");
    expect(fbReadFrom("campaign", undefined, false)).toBe("fact_facebook_stats FINAL");
    expect(fbReadFrom("day", undefined, true)).toBe("fact_facebook_stats FINAL");
  });

  it("switches every entity grain to its compat view when enabled (no FINAL on views)", () => {
    expect(fbReadFrom("campaign", "fb", true)).toBe(`${V_FB_STATS_V2_CAMPAIGN_COMPAT} AS fb`);
    expect(fbReadFrom("account", undefined, true)).toBe(V_FB_STATS_V2_ACCOUNT_COMPAT);
    expect(fbReadFrom("adset", undefined, true)).toBe(V_FB_STATS_V2_ADSET_COMPAT);
    expect(fbReadFrom("ad", "fb", true)).toBe(`${V_FB_STATS_V2_AD_COMPAT} AS fb`);
  });
});

describe("compat views DDL", () => {
  it("exposes the full V1 row shape with names joined from SCD2 dims", () => {
    const ddl = FB_WAREHOUSE_V2_DDL.join("\n");
    for (const view of [V_FB_STATS_V2_CAMPAIGN_COMPAT, V_FB_STATS_V2_ACCOUNT_COMPAT, V_FB_STATS_V2_ADSET_COMPAT, V_FB_STATS_V2_AD_COMPAT]) {
      expect(ddl).toContain(`CREATE VIEW IF NOT EXISTS ${view}`);
    }
    const adCompat = FB_WAREHOUSE_V2_DDL.find((query) => query.includes(V_FB_STATS_V2_AD_COMPAT))!;
    for (const dim of ["dim_facebook_ad FINAL", "dim_facebook_adset FINAL", "dim_facebook_campaign FINAL", "dim_facebook_account FINAL"]) {
      expect(adCompat).toContain(dim);
    }
    const campaignCompat = FB_WAREHOUSE_V2_DDL.find((query) => query.includes(V_FB_STATS_V2_CAMPAIGN_COMPAT))!;
    for (const column of ["'campaign' AS level", "ad_account_name", "buyer", "campaign_name", "adset_name", "ad_name", "purchase_value", "link_clicks"]) {
      expect(campaignCompat).toContain(column);
    }
    expect(campaignCompat).toContain("dim_facebook_campaign FINAL");
    expect(campaignCompat).toContain("dim_facebook_account FINAL");
    expect(campaignCompat).toContain("is_current = 1");
  });
});

describe("runFbList source selection", () => {
  function captureSql(): { client: ClickHouseClientLike; queries: string[] } {
    const queries: string[] = [];
    const client = {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query }: { query: string }) => {
        queries.push(query);
        return { json: async () => [] };
      },
    } as unknown as ClickHouseClientLike;
    return { client, queries };
  }

  it("reads V1 by default and the campaign compat view under v2_preview", async () => {
    const v1 = captureSql();
    await runFbList(v1.client, "u1", { level: "campaign" });
    expect(v1.queries.join("\n")).toContain("fact_facebook_stats AS fb FINAL");

    const v2 = captureSql();
    await runFbList(v2.client, "u1", { level: "campaign", v2_preview: true });
    const sql = v2.queries.join("\n");
    expect(sql).toContain(`${V_FB_STATS_V2_CAMPAIGN_COMPAT} AS fb`);
    expect(sql).not.toContain("fact_facebook_stats AS fb FINAL");
  });
});
