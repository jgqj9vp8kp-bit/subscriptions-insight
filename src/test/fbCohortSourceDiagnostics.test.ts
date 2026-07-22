import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildFbSourceReconciliation,
  classifyFbCohortSource,
  CONFIRMED_FB_CAMPAIGN_ALIAS_IDS,
  normalizeTrafficSource,
} from "../../supabase/functions/_shared/clickhouse/fbSourceClassification.ts";
import { fbSourceScopedDiagnosticsSql } from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import { normalizePalmerRows } from "@/services/palmerTransform";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

describe("FB Cohorts source classification", () => {
  it.each(["fb", " facebook ", "IG", "instagram", "meta"])("classifies explicit Meta source %s", (source) => {
    expect(classifyFbCohortSource({ sourceValues: [source] })).toBe("facebook");
  });

  it("classifies explicit TikTok separately", () => {
    expect(classifyFbCohortSource({ sourceValues: [" Tik_Tok "] })).toBe("tiktok");
  });

  it.each([
    [" Google Ads ", "google"],
    [" organic ", "organic"],
    [" DIRECT ", "direct"],
  ] as const)("normalizes %s to %s", (source, expected) => {
    expect(normalizeTrafficSource([source])).toBe(expected);
  });

  it("does not treat _fbp alone as Facebook evidence", () => {
    expect(classifyFbCohortSource({ fbp: "fb.1.123", sourceValues: ["4"] })).toBe("unknown");
  });

  it("classifies an exact Facebook Campaign ID as Facebook", () => {
    expect(classifyFbCohortSource({ campaignId: "cmp-meta", fbCampaignIds: ["cmp-meta"] })).toBe("facebook");
  });

  it("classifies a confirmed Campaign alias without rewriting it", () => {
    const alias = CONFIRMED_FB_CAMPAIGN_ALIAS_IDS[0];
    expect(classifyFbCohortSource({ campaignId: alias })).toBe("facebook");
    expect(alias).toBe(CONFIRMED_FB_CAMPAIGN_ALIAS_IDS[0]);
  });

  it("requires a paid Campaign ID before _fbc can qualify a user", () => {
    expect(classifyFbCohortSource({ campaignId: "cmp-paid", fbc: "fb.1.click" })).toBe("facebook");
    expect(classifyFbCohortSource({ campaignId: "", fbc: "fb.1.click" })).toBe("unknown");
  });

  it("fixes the Palmer leading-space fb bug without changing Campaign attribution", () => {
    const [row] = normalizePalmerRows([{
      id: "trial-source-normalization",
      user_id: "source-user",
      created_at: "2026-07-01T00:00:00Z",
      amount: "100",
      status: "SETTLED",
      campaign_id: "authoritative-campaign",
      metadata: JSON.stringify({ utm_source: " fb " }),
    }]);
    expect(row.traffic_source).toBe("facebook");
    expect(row.campaign_id).toBe("authoritative-campaign");
  });

  it("normalizes ig/meta/tiktok/google/organic/direct in Palmer classification only", () => {
    const sources = ["ig", "meta", "tiktok", "google", "organic", "direct"];
    const rows = normalizePalmerRows(sources.map((source, index) => ({
      id: `source-${index}`,
      user_id: `user-${index}`,
      created_at: `2026-07-0${index + 1}T00:00:00Z`,
      amount: "100",
      status: "SETTLED",
      campaign_id: `campaign-${index}`,
      metadata: JSON.stringify({ utm_source: source }),
    })));
    const byCampaign = new Map(rows.map((row) => [row.campaign_id, row.traffic_source]));
    expect(sources.map((_, index) => byCampaign.get(`campaign-${index}`))).toEqual([
      "facebook", "facebook", "tiktok", "google", "organic", "direct",
    ]);
  });
});

describe("FB source-scoped reconciliation", () => {
  const production = () => buildFbSourceReconciliation({
    counts: { all: 7_776, facebook: 6_675, tiktok: 176, unknown: 925 },
    fbAnalyticsPurchases: 5_386,
    allocatedFbPurchases: 4_961,
  });

  it("uses FB Analytics Purchases, never Trial Count, as allocation coverage denominator", () => {
    expect(production().allocationCoverage).toBe(92.11);
    expect(production().allocationCoverage).not.toBeCloseTo((4_961 / 7_776) * 100, 2);
  });

  it("calculates Allocation Gap as FB Purchases minus Allocated Purchases", () => {
    expect(production().allocationGap).toBe(425);
  });

  it("keeps source-mix and Meta-authoritative differences separate", () => {
    expect(production()).toMatchObject({ sourceMixDifference: 2_390, metaAuthoritativeDifference: 1_289 });
  });

  it("does not count Unknown users as Facebook allocation errors", () => {
    const baseline = production();
    const moreUnknown = buildFbSourceReconciliation({
      counts: { all: 8_776, facebook: 6_675, tiktok: 176, unknown: 1_925 },
      fbAnalyticsPurchases: 5_386,
      allocatedFbPurchases: 4_961,
    });
    expect(moreUnknown.allocationGap).toBe(baseline.allocationGap);
    expect(moreUnknown.metaAuthoritativeDifference).toBe(baseline.metaAuthoritativeDifference);
  });

  it("reconciles every production source-scoped value", () => {
    expect(production()).toEqual({
      all: 7_776,
      facebook: 6_675,
      tiktok: 176,
      google: 0,
      organic: 0,
      direct: 0,
      unknown: 925,
      other: 0,
      fbAnalyticsPurchases: 5_386,
      allocatedFbPurchases: 4_961,
      allocationGap: 425,
      allocationCoverage: 92.11,
      sourceMixDifference: 2_390,
      metaAuthoritativeDifference: 1_289,
    });
  });

  it("keeps source classification SQL out of membership and allocation materialization", () => {
    const params: Record<string, unknown> = {
      auth_user_id: "user-1",
      warehouse_version: "wh-1",
      classification_version: "classifier-1",
    };
    const sql = fbSourceScopedDiagnosticsSql({
      filters: NO_FILTERS,
      dateFrom: null,
      dateTo: null,
      visibleRows: [{ cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "path-a" }],
      params,
    });
    expect(sql).toContain("trial_transaction_id");
    expect(sql).toContain("facebook_qualified_users");
    expect(sql).toContain("_fbc");
    expect(sql).not.toContain("INSERT INTO");
    expect(sql).not.toContain("allocated_spend");
  });

  it("renders the two required explanations in the Cohorts UI source", () => {
    const source = readFileSync("src/pages/Cohorts.tsx", "utf8");
    expect(source).toContain("Trial Count includes users from all traffic sources. Facebook Purchases includes only Meta-attributed purchases. Therefore these values are not expected to match.");
    expect(source).toContain("Allocation Gap shows Facebook purchases that could not be assigned to an existing Cohort campaign.");
  });
});
