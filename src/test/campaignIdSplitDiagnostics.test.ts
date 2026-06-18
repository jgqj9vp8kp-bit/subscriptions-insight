import { describe, expect, it } from "vitest";
import {
  analyzeCampaignIdSplits,
  RECOMMENDATION_GROUP_BY_ID,
  RECOMMENDATION_KEEP_CURRENT,
} from "@/services/campaignIdSplitDiagnostics";
import type { Transaction } from "@/services/types";

// One successful trial per user is all the diagnostic needs (it anchors on the first trial).
function trial(userId: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-trial`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-05-01T00:00:00Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: overrides.funnel ?? "past_life",
    campaign_path: overrides.campaign_path ?? "past-life-astrology",
    product: "",
    traffic_source: overrides.traffic_source ?? "unknown",
    campaign_id: overrides.campaign_id ?? "campaign-1",
    classification_reason: "",
    ...overrides,
  };
}

describe("analyzeCampaignIdSplits", () => {
  it("1. campaign_id used in one path is NOT split", () => {
    const result = analyzeCampaignIdSplits([
      trial("u1", { campaign_id: "c1", campaign_path: "p1", funnel: "past_life" }),
      trial("u2", { campaign_id: "c1", campaign_path: "p1", funnel: "past_life" }),
    ]);

    const row = result.rows.find((r) => r.campaign_id === "c1")!;
    expect(row.number_of_paths).toBe(1);
    expect(row.number_of_combinations).toBe(1);
    expect(row.is_split).toBe(false);
    expect(result.split_campaign_ids).toBe(0);
    expect(row.trial_users).toBe(2);
  });

  it("2. campaign_id used in two paths IS split", () => {
    const result = analyzeCampaignIdSplits([
      trial("u1", { campaign_id: "c1", campaign_path: "p1" }),
      trial("u2", { campaign_id: "c1", campaign_path: "p2" }),
    ]);

    const row = result.rows.find((r) => r.campaign_id === "c1")!;
    expect(row.number_of_paths).toBe(2);
    expect(row.number_of_combinations).toBe(2);
    expect(row.is_split).toBe(true);
    expect(row.paths).toEqual(["p1", "p2"]);
    expect(result.split_campaign_ids).toBe(1);
  });

  it("3. campaign_id used in one path but two funnels IS split", () => {
    const result = analyzeCampaignIdSplits([
      trial("u1", { campaign_id: "c1", campaign_path: "p1", funnel: "past_life" }),
      trial("u2", { campaign_id: "c1", campaign_path: "p1", funnel: "soulmate" }),
    ]);

    const row = result.rows.find((r) => r.campaign_id === "c1")!;
    expect(row.number_of_paths).toBe(1);
    expect(row.number_of_funnels).toBe(2);
    expect(row.number_of_combinations).toBe(2);
    expect(row.is_split).toBe(true);
    expect(result.split_campaign_ids).toBe(1);
  });

  it("4. Unknown is excluded from split share but reported separately", () => {
    const result = analyzeCampaignIdSplits([
      // Unknown bucket spans two paths but must NOT count as a split campaign.
      trial("u1", { campaign_id: "", campaign_path: "p1" }),
      trial("u2", { campaign_id: "", campaign_path: "p2" }),
      // A real, single-combination campaign alongside it.
      trial("u3", { campaign_id: "c1", campaign_path: "p1" }),
    ]);

    const unknownRow = result.rows.find((r) => r.is_unknown)!;
    expect(unknownRow.campaign_id_label).toBe("Unknown");
    expect(unknownRow.number_of_combinations).toBe(2);
    expect(unknownRow.is_split).toBe(false); // excluded from split despite spanning two paths
    expect(result.unknown_trial_users).toBe(2);
    expect(result.split_campaign_ids).toBe(0);
    expect(result.split_trial_users).toBe(0);
    expect(result.split_traffic_share).toBe(0);
  });

  it("5. computes split_traffic_share against total trial users", () => {
    const result = analyzeCampaignIdSplits([
      trial("u1", { campaign_id: "c1", campaign_path: "p1" }), // split campaign (2 paths)
      trial("u2", { campaign_id: "c1", campaign_path: "p2" }),
      trial("u3", { campaign_id: "c2", campaign_path: "p1" }), // non-split
      trial("u4", { campaign_id: "c2", campaign_path: "p1" }),
      trial("u5", { campaign_id: "c2", campaign_path: "p1" }),
      trial("u6", { campaign_id: "c2", campaign_path: "p1" }),
    ]);

    expect(result.total_trial_users).toBe(6);
    expect(result.split_trial_users).toBe(2);
    expect(result.split_traffic_share).toBe(33.33); // 2 / 6 * 100, rounded to 2dp
  });

  it("6. recommends grouping by campaign_id only when split share < 1%", () => {
    const result = analyzeCampaignIdSplits([
      trial("s1", { campaign_id: "c1", campaign_path: "p1" }),
      trial("s2", { campaign_id: "c1", campaign_path: "p2" }), // split campaign = 2 trial users
      ...Array.from({ length: 248 }, (_, i) => trial(`n${i}`, { campaign_id: "c2", campaign_path: "p1" })),
    ]);

    expect(result.total_trial_users).toBe(250);
    expect(result.split_traffic_share).toBeLessThan(1); // 2 / 250 * 100 = 0.8%
    expect(result.recommendation).toBe(RECOMMENDATION_GROUP_BY_ID);
  });

  it("7. recommends keeping the current grouping when split share >= 1%", () => {
    const result = analyzeCampaignIdSplits([
      trial("s1", { campaign_id: "c1", campaign_path: "p1" }),
      trial("s2", { campaign_id: "c1", campaign_path: "p2" }), // split campaign = 2 trial users
      ...Array.from({ length: 18 }, (_, i) => trial(`n${i}`, { campaign_id: "c2", campaign_path: "p1" })),
    ]);

    expect(result.total_trial_users).toBe(20);
    expect(result.split_traffic_share).toBeGreaterThanOrEqual(1); // 2 / 20 * 100 = 10%
    expect(result.recommendation).toBe(RECOMMENDATION_KEEP_CURRENT);
  });
});
