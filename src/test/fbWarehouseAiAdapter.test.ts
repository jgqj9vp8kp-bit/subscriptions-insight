// Warehouse campaign row → AI engine row (brief §6): the adapter must feed the
// campaign ladder exactly the blended economics the CTE computes, mark spend
// availability honestly, and never invent fields the warehouse cannot know.
import { describe, expect, it } from "vitest";
import { aiCampaignRowFromWarehouse } from "@/services/fbWarehouseAiAdapter";
import { computeAiSignals } from "@/services/aiSignals";
import type { FbListRow } from "@/services/fbWarehouse";

function warehouseRow(over: Partial<FbListRow> = {}): FbListRow {
  return {
    key: "acc|123",
    ad_account_id: "acc",
    ad_account_name: "Account",
    buyer: "Ivan",
    campaign_id: "123",
    campaign_name: "Campaign A",
    adset_id: "",
    adset_name: "",
    ad_id: "",
    ad_name: "",
    first_date: "2026-08-01",
    last_date: "2026-08-30",
    days: 30,
    spend: 4200,
    impressions: 100_000,
    clicks: 2000,
    outbound_clicks: 1500,
    fb_purchases: 296,
    cpp: 14.19,
    cpc: 2.1,
    cpm: 42,
    ctr: 2,
    outbound_ctr: 1.5,
    blended: {
      trial_users: 280,
      first_subscription_users: 140,
      refund_users: 6,
      campaign_path: "soulmate-web",
      tx_gross_revenue: 9000,
      tx_net_revenue: 8600,
      cac: 15,
      roas: 2.05,
      revenue_per_trial: 30.7,
    },
    ...over,
  } as FbListRow;
}

describe("aiCampaignRowFromWarehouse", () => {
  it("maps the blend onto the engine's campaign fields and derives the ratios", () => {
    const row = aiCampaignRowFromWarehouse(warehouseRow());
    expect(row).toMatchObject({
      campaign_id: "123",
      campaign_name: "Campaign A",
      campaign_path: "soulmate-web",
      trial_users: 280,
      first_subscription_users: 140,
      trial_to_sub_cr: 50,
      refund_users: 6,
      spend: 4200,
      spend_status: "available",
      cac: 15,
      roas: 2.05,
      gross_revenue: 9000,
      net_revenue: 8600,
      fb_purchases: 296,
      main_decline_reason: null,
    });
    expect(row?.refund_rate).toBeCloseTo((6 / 280) * 100, 5);
  });

  it("marks zero spend as unavailable and drops rows without a campaign id", () => {
    expect(aiCampaignRowFromWarehouse(warehouseRow({ spend: 0 }))?.spend_status).toBe("no_traffic_data");
    expect(aiCampaignRowFromWarehouse(warehouseRow({ campaign_id: "" }))).toBeNull();
  });

  it("survives a row without the blend (join miss) as an all-zero campaign", () => {
    const row = aiCampaignRowFromWarehouse(warehouseRow({ blended: undefined }));
    expect(row).toMatchObject({ trial_users: 0, first_subscription_users: 0, refund_rate: 0, campaign_path: "" });
  });

  it("feeds the campaign engine end-to-end: adapted rows produce verdicts", () => {
    const rows = [
      warehouseRow(),
      warehouseRow({ key: "acc|456", campaign_id: "456", campaign_name: "Campaign B", spend: 2800, blended: {
        trial_users: 110, first_subscription_users: 44, refund_users: 2, campaign_path: "palm-web",
        tx_gross_revenue: 3000, tx_net_revenue: 2900, cac: 25.45, roas: 1.04, revenue_per_trial: 26.4,
      } }),
    ].map(aiCampaignRowFromWarehouse).filter((row): row is NonNullable<typeof row> => row !== null);
    const output = computeAiSignals({ surface: "campaign", campaignRows: rows, passRates: null, asOfDate: "2026-09-08" });
    expect(output.recommendations).toHaveLength(2);
    expect(output.recommendations.every((rec) => rec.scope.kind === "campaign")).toBe(true);
  });
});
