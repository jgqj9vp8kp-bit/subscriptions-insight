import { describe, expect, it } from "vitest";
import {
  computeFbReconSnapshot,
  type FbReconComputeInput,
} from "../../supabase/functions/_shared/clickhouse/fbReconSnapshot.ts";
import type { CampaignFunnelResolution } from "../../supabase/functions/_shared/clickhouse/fbCampaignResolution.ts";

const funnelMap: Record<string, CampaignFunnelResolution> = {
  fb1: { funnel: "soulmate", match_kind: "confirmed", evidence_source: "campaign_path", confidence: 1 },
  fb2: { funnel: "soulmate", match_kind: "suggested", evidence_source: "name_rule", confidence: 0.5 },
  fb3: { funnel: "past_life", match_kind: "confirmed", evidence_source: "manual", confidence: 1 },
};

function baseInput(overrides: Partial<FbReconComputeInput> = {}): FbReconComputeInput {
  return {
    windowFrom: "2026-07-01",
    windowTo: "2026-07-10",
    campaignSpend: [
      // known funnel + users (via alias: observed "obs1" -> "fb1") -> allocated
      { campaign_id: "fb1", campaign_name: "A", spend: 100, fb_purchases: 4 },
      // known funnel (suggested), zero users -> no_user
      { campaign_id: "fb2", campaign_name: "B", spend: 40, fb_purchases: 0 },
      // users but no funnel -> unknown_funnel
      { campaign_id: "fb4", campaign_name: "D", spend: 30, fb_purchases: 2 },
      // no users, no funnel -> unknown_campaign
      { campaign_id: "fb5", campaign_name: "E", spend: 10, fb_purchases: 0 },
    ],
    funnelMap,
    aliasMap: { obs1: "fb1" },
    authoritativeUsers: [
      { campaign_id: "obs1", users: 3 },
      { campaign_id: "fb4", users: 2 },
    ],
    coveredDays: 10,
    knownGapDays: 0,
    dqWarnCount: 0,
    dqFailCount: 0,
    ...overrides,
  };
}

describe("computeFbReconSnapshot (Wave 4, six buckets)", () => {
  it("partitions source spend by campaign state and never forces Model 1 to match", () => {
    const snapshot = computeFbReconSnapshot(baseInput());

    expect(snapshot.source_spend).toBe(180);
    expect(snapshot.allocated_campaign_spend).toBe(100);
    expect(snapshot.no_user_spend).toBe(40);
    expect(snapshot.unknown_funnel_spend).toBe(30);
    expect(snapshot.unknown_campaign_spend).toBe(10);
    // Partition identity — ALWAYS.
    expect(
      snapshot.allocated_campaign_spend + snapshot.no_user_spend + snapshot.unknown_funnel_spend + snapshot.unknown_campaign_spend,
    ).toBe(snapshot.source_spend);
    // Model 2: resolved = allocated + no_user.
    expect(snapshot.funnel_resolved_spend).toBe(140);
    // Model 1 beside the partition: cpp=100/4=25 × 3 alias-resolved users = 75 ≠ 100.
    expect(snapshot.user_allocated_spend).toBe(75);
    expect(snapshot.allocation_basis).toBe("period_cpp_estimate");
    expect(snapshot.campaigns_allocated).toBe(1);
    expect(snapshot.campaigns_no_user).toBe(1);
    expect(snapshot.campaigns_unknown_funnel).toBe(1);
    expect(snapshot.campaigns_unknown).toBe(1);
    expect(snapshot.details.top_unknown_campaigns[0]).toMatchObject({ campaign_id: "fb5" });
  });

  it("keeps overallocation visible (uncapped Model 1, like the engine)", () => {
    const snapshot = computeFbReconSnapshot(baseInput({
      authoritativeUsers: [{ campaign_id: "obs1", users: 10 }],
    }));
    // cpp=25 × 10 users = 250 > campaign spend 100 — reported, not clamped.
    expect(snapshot.user_allocated_spend).toBe(250);
  });

  it("health: green when clean, yellow on unknown share/suggested share/partial coverage, red on DQ fail or coverage collapse", () => {
    const clean = computeFbReconSnapshot(baseInput({
      campaignSpend: [
        { campaign_id: "fb1", campaign_name: "A", spend: 100, fb_purchases: 4 },
        { campaign_id: "fb3", campaign_name: "C", spend: 100, fb_purchases: 4 },
      ],
      authoritativeUsers: [
        { campaign_id: "obs1", users: 3 },
        { campaign_id: "fb3", users: 3 },
      ],
    }));
    expect(clean.health).toBe("green");

    const unknownHeavy = computeFbReconSnapshot(baseInput());
    // (30+10)/180 = 22% unknown > 10% -> yellow.
    expect(unknownHeavy.health).toBe("yellow");

    const partialCoverage = computeFbReconSnapshot(baseInput({ coveredDays: 9 }));
    expect(partialCoverage.health).toBe("yellow");

    const dqFail = computeFbReconSnapshot(baseInput({ dqFailCount: 1 }));
    expect(dqFail.health).toBe("red");

    const coverageCollapse = computeFbReconSnapshot(baseInput({ coveredDays: 5 }));
    expect(coverageCollapse.health).toBe("red");

    const unknownCampaignHeavy = computeFbReconSnapshot(baseInput({
      campaignSpend: [
        { campaign_id: "fb1", campaign_name: "A", spend: 50, fb_purchases: 2 },
        { campaign_id: "fb9", campaign_name: "X", spend: 50, fb_purchases: 0 },
      ],
    }));
    expect(unknownCampaignHeavy.health).toBe("red");
  });

  it("known gaps shrink the coverage denominator instead of poisoning it", () => {
    // 10-day window, 4 days recorded as a known gap, 6 covered -> full coverage.
    const snapshot = computeFbReconSnapshot(baseInput({ coveredDays: 6, knownGapDays: 4 }));
    expect(snapshot.details.expected_days).toBe(6);
    expect(snapshot.coverage_pct).toBe(1);
    expect(snapshot.known_gap_days).toBe(4);
  });

  it("records the V2 parity result and degrades health on dual-write drift only", () => {
    const clean = { verdict: "parity" as const, overlap_days: 118, matched_days: 118, mismatched_count: 0, overlap_spend_diff: 0 };
    const withParity = computeFbReconSnapshot(baseInput({
      campaignSpend: [{ campaign_id: "fb1", campaign_name: "A", spend: 100, fb_purchases: 4 }],
      authoritativeUsers: [{ campaign_id: "obs1", users: 3 }],
      v2Parity: clean,
    }));
    expect(withParity.details.v2_parity).toEqual(clean);
    expect(withParity.health).toBe("green");

    const noOverlap = computeFbReconSnapshot(baseInput({
      campaignSpend: [{ campaign_id: "fb1", campaign_name: "A", spend: 100, fb_purchases: 4 }],
      authoritativeUsers: [{ campaign_id: "obs1", users: 3 }],
      v2Parity: { ...clean, verdict: "no_overlap", overlap_days: 0, matched_days: 0 },
    }));
    expect(noOverlap.health).toBe("green"); // an empty V2 is not drift

    const drift = computeFbReconSnapshot(baseInput({
      campaignSpend: [{ campaign_id: "fb1", campaign_name: "A", spend: 100, fb_purchases: 4 }],
      authoritativeUsers: [{ campaign_id: "obs1", users: 3 }],
      v2Parity: { ...clean, verdict: "mismatch", matched_days: 117, mismatched_count: 1, overlap_spend_diff: 12.5 },
    }));
    expect(drift.health).toBe("yellow");
  });

  it("suggested provenance share is tracked against resolved spend", () => {
    const snapshot = computeFbReconSnapshot(baseInput());
    // suggested fb2 (40) / resolved (140) ≈ 28.57%.
    expect(snapshot.suggested_share_pct).toBeCloseTo(28.57, 1);
  });
});
