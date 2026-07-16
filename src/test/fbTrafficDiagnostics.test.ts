import { describe, expect, it } from "vitest";
import {
  buildFbTrafficDiagnostics,
  exportMissingCampaignIdsCsv,
  type FbTrafficMatchStatus,
} from "@/services/fbTrafficDiagnostics";
import type { CapsuledFacebookRow, CapsuledFacebookSyncMetadata } from "@/services/capsuledFacebook";

const sync: CapsuledFacebookSyncMetadata = {
  status: "success",
  connected: true,
  lastSync: "2026-07-03T10:00:00.000Z",
  level: "campaign",
  dateFrom: "2026-07-01",
  dateTo: "2026-07-02",
  rowsImported: 1,
  apiFreshness: "2026-07-02",
  facebookStatsDate: "2026-07-02",
  syncDurationMs: 100,
  campaignsImported: 1,
  spend: 100,
  fbPurchases: 10,
  lastApiResponse: "{}",
  failedRequests: [],
};

function row(overrides: Partial<CapsuledFacebookRow> = {}): CapsuledFacebookRow {
  return {
    date_from: "2026-07-01",
    date_to: "2026-07-02",
    level: "campaign",
    campaign_id: "cmp_1",
    campaign_name: "Campaign One",
    ad_account_id: "act_1",
    ad_account_name: "Account One",
    spend: 100,
    fb_purchases: 10,
    cpp: 10,
    impressions: 1000,
    clicks: 100,
    ctr: 10,
    cpc: 1,
    cpm: 100,
    outbound_clicks: 50,
    outbound_ctr: 5,
    currency: "USD",
    last_import_at: "2026-07-03T10:00:00.000Z",
    raw_payload: {},
    ...overrides,
  };
}

function statusFor(campaignId: string, rows: CapsuledFacebookRow[], warehouseCampaignIds = ["cmp_1"]): FbTrafficMatchStatus | undefined {
  return buildFbTrafficDiagnostics({
    warehouseCampaignIds,
    capsuledRows: rows,
    dateFrom: "2026-07-01",
    dateTo: "2026-07-02",
    selectedLevel: "campaign",
    latestSyncMetadata: sync,
  }).campaigns.find((campaign) => campaign.campaign_id === campaignId)?.match_status;
}

describe("FB traffic diagnostics", () => {
  it("matches campaign ids", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1"],
      capsuledRows: [row()],
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.summary.matched_campaign_ids_count).toBe(1);
    expect(diagnostics.campaigns[0]).toMatchObject({ campaign_id: "cmp_1", match_status: "matched" });
  });

  it("reports warehouse id missing in Capsuled", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_missing"],
      capsuledRows: [row()],
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    const campaign = diagnostics.campaigns.find((entry) => entry.campaign_id === "cmp_missing");
    expect(campaign?.match_status).toBe("missing_in_capsuled");
    expect(campaign?.reason).toContain("not returned by Capsuled");
  });

  it("reports Capsuled id not in warehouse", () => {
    expect(statusFor("cmp_1", [row()], ["other"])).toBe("capsuled_only");
  });

  it("reports duplicate Capsuled campaign id", () => {
    expect(statusFor("cmp_1", [row({ spend: 10 }), row({ spend: 20 })])).toBe("duplicate_in_capsuled");
  });

  it("reports missing campaign id rows", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: [],
      capsuledRows: [row({ campaign_id: null })],
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.summary.missing_campaign_id_rows_count).toBe(1);
    expect(diagnostics.campaigns[0].match_status).toBe("missing_campaign_id");
  });

  it("reports no sync state", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1"],
      capsuledRows: [],
      selectedLevel: "campaign",
      latestSyncMetadata: null,
    });

    expect(diagnostics.summary.latest_sync_at).toBeNull();
    expect(diagnostics.campaigns[0]).toMatchObject({ match_status: "sync_not_run", reason: "Capsuled sync has not run yet." });
  });

  it("reports wrong level", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1"],
      capsuledRows: [row({ level: "account" })],
      selectedLevel: "campaign",
      latestSyncMetadata: { ...sync, level: "account" },
    });

    expect(diagnostics.summary.api_level).toBe("account");
    expect(diagnostics.campaigns[0].match_status).toBe("level_mismatch");
  });

  it("reports date range mismatch", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1"],
      capsuledRows: [row({ date_from: "2026-07-01", date_to: "2026-07-02" })],
      dateFrom: "2026-08-01",
      dateTo: "2026-08-02",
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.summary.selected_range_outside_synced_range).toBe(true);
    expect(diagnostics.campaigns[0].match_status).toBe("outside_date_range");
  });

  it("counts rows without spend", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1", "cmp_2"],
      capsuledRows: [row({ spend: 0, fb_purchases: 0 }), row({ campaign_id: "cmp_2", spend: 5, fb_purchases: 0 })],
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.summary.rows_without_spend_count).toBe(1);
  });

  it("counts rows without purchases", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1", "cmp_2"],
      capsuledRows: [row({ fb_purchases: 0 }), row({ campaign_id: "cmp_2", fb_purchases: 0 })],
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.summary.rows_without_purchases_count).toBe(2);
  });

  it("calculates total spend", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1", "cmp_2"],
      capsuledRows: [row({ spend: 15 }), row({ campaign_id: "cmp_2", spend: 20 })],
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.summary.total_spend).toBe(35);
  });

  it("exports missing campaign ids CSV", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_missing"],
      capsuledRows: [],
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(exportMissingCampaignIdsCsv(diagnostics)).toContain("cmp_missing");
    expect(exportMissingCampaignIdsCsv(diagnostics)).toContain("date_from,date_to");
  });

  it("includes row-level reason text for zero spend", () => {
    const diagnostics = buildFbTrafficDiagnostics({
      warehouseCampaignIds: ["cmp_1"],
      capsuledRows: [row({ spend: 0 })],
      selectedLevel: "campaign",
      latestSyncMetadata: sync,
    });

    expect(diagnostics.campaigns[0].reason).toBe("Campaign was returned by Capsuled but spend is zero.");
  });
});
