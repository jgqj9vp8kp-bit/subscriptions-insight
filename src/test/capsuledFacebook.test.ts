import { describe, expect, it } from "vitest";
import {
  aggregateCapsuledRowsByCampaign,
  buildCapsuledMatchingDiagnostics,
  normalizeCapsuledFacebookRows,
  parseCapsuledNumber,
  type CapsuledFacebookRow,
} from "@/services/capsuledFacebook";
import { buildFbAnalytics } from "@/services/fbAnalytics";
import type { Transaction, TransactionType } from "@/services/types";

function row(overrides: Partial<CapsuledFacebookRow> = {}): CapsuledFacebookRow {
  return {
    date_from: "2026-07-01",
    date_to: "2026-07-01",
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
    last_import_at: "2026-07-03T00:00:00.000Z",
    raw_payload: {},
    ...overrides,
  };
}

function tx(userId: string, transactionType: TransactionType, overrides: Partial<Transaction> = {}): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : transactionType === "upsell" ? 5 : 10);
  return {
    transaction_id: `${userId}-${transactionType}-${overrides.event_time ?? "2026-07-01T00:00:00Z"}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-07-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: amount,
    refund_amount_usd: 0,
    net_amount_usd: amount,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? "success",
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: overrides.campaign_path ?? "shared-path",
    product: "",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "cmp_1",
    classification_reason: "",
    ...overrides,
  };
}

describe("Capsuled Facebook normalization", () => {
  it("normalizes API aliases and derived metrics", () => {
    const rows = normalizeCapsuledFacebookRows({
      dateFrom: "2026-07-01",
      dateTo: "2026-07-02",
      level: "campaign",
      payload: {
        data: [
          {
            date_start: "2026-07-01T10:00:00Z",
            date_stop: "2026-07-02",
            campaignId: "cmp_1",
            campaignName: "Campaign One",
            account_id: "act_1",
            account_name: "Account One",
            spend: "$1,234.50",
            purchases: "12",
            impressions: "10000",
            clicks: "250",
            outbound_clicks: "100",
            currency: "USD",
          },
        ],
      },
      importedAt: "2026-07-03T00:00:00.000Z",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date_from: "2026-07-01",
      date_to: "2026-07-02",
      campaign_id: "cmp_1",
      campaign_name: "Campaign One",
      ad_account_id: "act_1",
      spend: 1234.5,
      fb_purchases: 12,
      clicks: 250,
      outbound_clicks: 100,
    });
    expect(rows[0].cpp).toBeCloseTo(102.875);
    expect(rows[0].ctr).toBeCloseTo(2.5);
    expect(parseCapsuledNumber("€42,7")).toBe(42.7);
  });

  it("aggregates duplicate import keys without duplicating rows", () => {
    const aggregated = aggregateCapsuledRowsByCampaign([
      row({ spend: 40, fb_purchases: 4, clicks: 20, impressions: 200 }),
      row({ spend: 60, fb_purchases: 6, clicks: 30, impressions: 300 }),
    ]);

    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]).toMatchObject({ spend: 100, fb_purchases: 10, clicks: 50, impressions: 500 });
    expect(aggregated[0].cpp).toBe(10);
  });
});

describe("Capsuled Facebook matching diagnostics", () => {
  it("matches only by campaign_id and reports unmatched, duplicate, and missing IDs", () => {
    const diagnostics = buildCapsuledMatchingDiagnostics({
      rows: [
        row({ campaign_id: "cmp_1", campaign_name: "Renamed Campaign" }),
        row({ campaign_id: "cmp_1", spend: 20 }),
        row({ campaign_id: "cmp_unmatched" }),
        row({ campaign_id: null }),
      ],
      txs: [tx("u1", "trial", { campaign_id: "cmp_1" })],
    });

    expect(diagnostics.matchedCampaignIds).toEqual(["cmp_1"]);
    expect(diagnostics.unmatchedCampaignIds).toEqual(["cmp_unmatched"]);
    expect(diagnostics.duplicateCampaignIds).toEqual(["cmp_1"]);
    expect(diagnostics.missingCampaignIds).toBe(1);
  });
});

describe("FB Analytics with Capsuled Facebook data", () => {
  it("uses Capsuled spend by campaign_id when campaign paths are shared", () => {
    const result = buildFbAnalytics({
      txs: [
        tx("u1", "trial", { campaign_id: "cmp_1", campaign_path: "shared-path" }),
        tx("u1", "first_subscription", { campaign_id: "cmp_1", campaign_path: "shared-path", event_time: "2026-07-08T00:00:00Z" }),
        tx("u2", "trial", { campaign_id: "cmp_2", campaign_path: "shared-path" }),
      ],
      capsuledRows: [row({ campaign_id: "cmp_1", spend: 80, fb_purchases: 8 })],
    });

    const byId = Object.fromEntries(result.rows.map((entry) => [entry.campaign_id, entry]));
    expect(byId.cmp_1.spend).toBe(80);
    expect(byId.cmp_1.spend_status).toBe("available");
    expect(byId.cmp_1.fb_purchases).toBe(8);
    expect(byId.cmp_1.cost_per_first_sub).toBe(80);
    expect(byId.cmp_2.spend_status).toBe("no_traffic_data");
  });
});
