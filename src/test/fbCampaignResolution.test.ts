import { describe, expect, it } from "vitest";
import {
  buildCampaignFunnelSuggestions,
  computeFunnelSpend,
  loadActiveCampaignAliasMap,
  loadActiveCampaignFunnelMap,
  seedConfirmedCampaignAliases,
  type CampaignFunnelResolution,
} from "../../supabase/functions/_shared/clickhouse/fbCampaignResolution.ts";
import { CONFIRMED_FB_CAMPAIGN_ALIASES } from "../../supabase/functions/_shared/clickhouse/fbSourceClassification.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

function fakeMappingTable(rows: Array<Record<string, unknown>>, inserts: unknown[][] = []): SupabaseLikeClient {
  return {
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        then: (resolve: (value: { data: unknown; error: null }) => unknown) =>
          Promise.resolve({ data: rows, error: null }).then(resolve),
        insert: async (values: unknown) => {
          inserts.push(values as unknown[]);
          return { data: null, error: null };
        },
        maybeSingle: async () => ({ data: null, error: null }),
        upsert: async () => ({ data: null, error: null }),
      };
      return builder as never;
    },
  };
}

describe("Layer A: campaign alias mapping", () => {
  it("seeds only the missing audited pairs (idempotent)", async () => {
    const [firstObserved, firstFb] = Object.entries(CONFIRMED_FB_CAMPAIGN_ALIASES)[0];
    const inserts: unknown[][] = [];
    const result = await seedConfirmedCampaignAliases(
      fakeMappingTable([{ observed_campaign_id: firstObserved, fb_campaign_id: firstFb }], inserts),
      "owner-1",
    );
    const total = Object.keys(CONFIRMED_FB_CAMPAIGN_ALIASES).length;
    expect(result).toEqual({ inserted: total - 1, existing: 1 });
    expect(inserts).toHaveLength(1);
    const rows = inserts[0] as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(total - 1);
    expect(rows[0]).toMatchObject({
      auth_user_id: "owner-1",
      mapping_type: "confirmed_alias",
      confidence: 1,
      created_by: "seed:confirmed-alias-audit",
    });
    expect(rows.some((row) => row.observed_campaign_id === firstObserved)).toBe(false);
  });

  it("loads table rows over the hardcoded fallback", async () => {
    const [observed] = Object.keys(CONFIRMED_FB_CAMPAIGN_ALIASES);
    const map = await loadActiveCampaignAliasMap(
      fakeMappingTable([
        { observed_campaign_id: observed, fb_campaign_id: "999" },
        { observed_campaign_id: "111", fb_campaign_id: "222" },
      ]),
      "owner-1",
    );
    expect(map[observed]).toBe("999"); // table wins over the hardcode
    expect(map["111"]).toBe("222");
    expect(Object.keys(map).length).toBe(Object.keys(CONFIRMED_FB_CAMPAIGN_ALIASES).length + 1);
  });
});

describe("Layer B: funnel map loading", () => {
  it("confirmed wins; among suggested the highest confidence wins", async () => {
    const map = await loadActiveCampaignFunnelMap(
      fakeMappingTable([
        { fb_campaign_id: "c1", funnel: "soulmate", match_kind: "suggested", evidence_source: "name_rule", confidence: 0.5 },
        { fb_campaign_id: "c1", funnel: "past_life", match_kind: "confirmed", evidence_source: "manual", confidence: 1 },
        { fb_campaign_id: "c2", funnel: "soulmate", match_kind: "suggested", evidence_source: "name_rule", confidence: 0.4 },
        { fb_campaign_id: "c2", funnel: "starseed", match_kind: "suggested", evidence_source: "name_rule", confidence: 0.9 },
      ]),
      "owner-1",
    );
    expect(map.c1).toMatchObject({ funnel: "past_life", match_kind: "confirmed" });
    expect(map.c2).toMatchObject({ funnel: "starseed", match_kind: "suggested" });
  });
});

describe("buildCampaignFunnelSuggestions (rev.2 evidence ladder)", () => {
  const knownFunnels = ["past_life", "soulmate", "starseed"] as const;

  it("stable funnel across enough users -> confirmed via campaign_path", () => {
    const suggestions = buildCampaignFunnelSuggestions({
      authoritative: [
        { campaign_id: "c1", funnel: "soulmate", users: 5 },
        { campaign_id: "c1", funnel: "unknown", users: 2 },
        { campaign_id: "c2", funnel: "soulmate", users: 2 },
        { campaign_id: "c3", funnel: "soulmate", users: 4 },
        { campaign_id: "c3", funnel: "past_life", users: 4 },
      ],
      campaignNames: [],
      existing: {},
      knownFunnels,
    });
    expect(suggestions).toEqual([
      expect.objectContaining({ fb_campaign_id: "c1", funnel: "soulmate", match_kind: "confirmed", evidence_source: "campaign_path" }),
    ]);
    // c2 below the user threshold, c3 ambiguous — no evidence invented.
  });

  it("name token -> suggested ONLY; ambiguous names skipped; existing resolutions respected", () => {
    const existing: Record<string, CampaignFunnelResolution> = {
      c9: { funnel: "soulmate", match_kind: "confirmed", evidence_source: "manual", confidence: 1 },
      c8: { funnel: "soulmate", match_kind: "suggested", evidence_source: "name_rule", confidence: 0.5 },
    };
    const suggestions = buildCampaignFunnelSuggestions({
      authoritative: [{ campaign_id: "c9", funnel: "soulmate", users: 10 }],
      campaignNames: [
        { campaign_id: "c4", campaign_name: "US-soulmate-1-week - Copy" },
        { campaign_id: "c5", campaign_name: "soulmate past-life combo" },
        { campaign_id: "c6", campaign_name: "generic broad campaign" },
        { campaign_id: "c8", campaign_name: "soulmate again" },
        { campaign_id: "c9", campaign_name: "soulmate main" },
      ],
      existing,
      knownFunnels,
    });
    expect(suggestions).toEqual([
      expect.objectContaining({ fb_campaign_id: "c4", funnel: "soulmate", match_kind: "suggested", evidence_source: "name_rule" }),
    ]);
    expect(suggestions.every((s) => s.evidence_source !== "name_rule" || s.match_kind === "suggested")).toBe(true);
  });
});

describe("computeFunnelSpend (Model 2)", () => {
  const funnelMap: Record<string, CampaignFunnelResolution> = {
    c1: { funnel: "soulmate", match_kind: "confirmed", evidence_source: "campaign_path", confidence: 1 },
    c2: { funnel: "soulmate", match_kind: "suggested", evidence_source: "name_rule", confidence: 0.5 },
    c3: { funnel: "past_life", match_kind: "confirmed", evidence_source: "manual", confidence: 1 },
  };

  it("includes zero-user campaigns, keeps provenance split and the bucket identity", () => {
    const result = computeFunnelSpend({
      campaignSpend: [
        { campaign_id: "c1", campaign_name: "A", spend: 100, fb_purchases: 5 },
        { campaign_id: "c2", campaign_name: "B (zero users, real spend)", spend: 40, fb_purchases: 0 },
        { campaign_id: "c3", campaign_name: "C", spend: 60, fb_purchases: 3 },
        { campaign_id: "c4", campaign_name: "D (unmapped)", spend: 25, fb_purchases: 1 },
      ],
      funnelMap,
    });

    const soulmate = result.funnels.find((row) => row.funnel === "soulmate")!;
    expect(soulmate).toMatchObject({ spend: 140, campaigns: 2, confirmed_spend: 100, suggested_spend: 40 });
    expect(result.unknown_funnel).toEqual({ spend: 25, fb_purchases: 1, campaigns: 1 });
    // Bucket identity: source == funnel_resolved + unknown_funnel. ALWAYS.
    expect(result.totals.source_spend).toBe(225);
    expect(result.totals.funnel_resolved_spend + result.totals.unknown_funnel_spend).toBe(result.totals.source_spend);
    expect(result.totals.resolved_campaigns).toBe(3);
    expect(result.totals.unresolved_campaigns).toBe(1);
    // Zero-purchase campaign still contributes funnel spend (the rev.2 point).
    expect(soulmate.spend).toBeGreaterThan(soulmate.confirmed_spend);
  });

  it("handles an empty funnel map: everything lands in unknown_funnel", () => {
    const result = computeFunnelSpend({
      campaignSpend: [{ campaign_id: "x", campaign_name: "X", spend: 10, fb_purchases: 1 }],
      funnelMap: {},
    });
    expect(result.funnels).toEqual([]);
    expect(result.totals).toMatchObject({ source_spend: 10, funnel_resolved_spend: 0, unknown_funnel_spend: 10 });
  });
});
