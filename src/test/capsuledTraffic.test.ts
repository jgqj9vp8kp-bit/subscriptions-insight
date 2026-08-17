// The campaign->path resolution that makes the Capsuled traffic snapshot
// joinable by (date, campaign_path) again — the Cohorts Spend/CAC defect.
import { describe, expect, it } from "vitest";
import {
  capsuledTrafficMetric,
  enumerateDays,
  MAX_DAILY_SPLIT_DAYS,
  PATH_EVIDENCE_MIN_USERS,
  pathMappingStats,
  resolveCampaignPaths,
  supersededPeriodRowIds,
  type CampaignPathEvidenceRow,
} from "../../supabase/functions/_shared/clickhouse/capsuledTraffic.ts";
import { normalizeCampaignPath, type CapsuledFacebookRow } from "../../supabase/functions/_shared/clickhouse/trafficMetric.ts";

function ev(campaign_id: string, campaign_path: string, trial_users: number): CampaignPathEvidenceRow {
  return { campaign_id, campaign_path, trial_users };
}

function statsRow(over: Partial<CapsuledFacebookRow>): CapsuledFacebookRow {
  return {
    date_from: "2026-08-01",
    date_to: "2026-08-01",
    level: "campaign",
    campaign_id: "111",
    campaign_name: "02,1 - Video Soulmate-cbo-static - Copy 2",
    ad_account_id: null,
    ad_account_name: null,
    spend: 120,
    fb_purchases: 4,
    cpp: 30,
    impressions: 1000,
    clicks: 50,
    ctr: 5,
    cpc: 2.4,
    cpm: 120,
    outbound_clicks: 40,
    outbound_ctr: 4,
    currency: "USD",
    last_import_at: "2026-08-01T10:00:00.000Z",
    raw_payload: null,
    ...over,
  };
}

describe("resolveCampaignPaths", () => {
  it("resolves a campaign whose trial users agree on exactly one path", () => {
    const map = resolveCampaignPaths([ev("111", "soulmate-sketch-web-en", 5)]);
    expect(map.get("111")).toBe("soulmate-sketch-web-en");
  });

  it("rejects ambiguous campaigns (users split across paths) even with volume", () => {
    const map = resolveCampaignPaths([
      ev("111", "soulmate-sketch-web-en", 40),
      ev("111", "soulmate-sketch-web-es", 3),
    ]);
    expect(map.has("111")).toBe(false);
  });

  it("rejects thin evidence below the user threshold", () => {
    const map = resolveCampaignPaths([ev("111", "soulmate-sketch-web-en", PATH_EVIDENCE_MIN_USERS - 1)]);
    expect(map.has("111")).toBe(false);
    expect(resolveCampaignPaths([ev("111", "soulmate-sketch-web-en", PATH_EVIDENCE_MIN_USERS)]).has("111")).toBe(true);
  });

  it("merges duplicate rows of the same path before applying the threshold", () => {
    // The RPC groups by (id, path), but a defensive re-merge keeps the rule
    // correct if the evidence ever arrives split (e.g. per-day rows).
    const map = resolveCampaignPaths([
      ev("111", "soulmate-sketch-web-en", 2),
      ev("111", "Soulmate-Sketch-Web-EN", 2), // same path modulo normalization
    ]);
    expect(map.get("111")).toBe("soulmate-sketch-web-en");
  });

  it("normalizes resolved paths exactly like the client traffic key does", () => {
    const raw = '  "/Soulmate-Sketch-Web-EN"  ';
    const map = resolveCampaignPaths([ev("111", raw, 5)]);
    expect(map.get("111")).toBe(normalizeCampaignPath(raw));
  });

  it("transfers evidence across a Layer A alias without overwriting own evidence", () => {
    const aliases = { "40": "50", "41": "51" };
    const map = resolveCampaignPaths(
      [
        ev("40", "soulmate-sketch-web-en", 5), // observed utm id, spend lives under 50
        ev("41", "astro-web-de", 5),
        ev("51", "astro-web-en", 5), // spend-side id with its OWN evidence wins
      ],
      aliases,
    );
    expect(map.get("50")).toBe("soulmate-sketch-web-en");
    expect(map.get("51")).toBe("astro-web-en");
  });

  it("ignores empty ids, empty paths and zero-user rows", () => {
    const map = resolveCampaignPaths([
      ev("", "soulmate-sketch-web-en", 9),
      ev("111", "", 9),
      ev("222", "soulmate-sketch-web-en", 0),
    ]);
    expect(map.size).toBe(0);
  });
});

describe("capsuledTrafficMetric", () => {
  const pathMap = new Map([["111", "soulmate-sketch-web-en"]]);

  it("uses the resolved funnel path when the campaign is mapped", () => {
    const metric = capsuledTrafficMetric(statsRow({}), pathMap);
    expect(metric.campaign_path).toBe("soulmate-sketch-web-en");
    expect(metric.date).toBe("2026-08-01");
    expect(metric.spend).toBe(120);
    expect(metric.trial_count).toBe(4);
    expect(metric.cac).toBe(30);
    expect(metric.source).toBe("facebook");
  });

  it("keeps the historical name -> id -> 'capsuled' fallback chain when unmapped", () => {
    expect(capsuledTrafficMetric(statsRow({ campaign_id: "999" }), pathMap).campaign_path).toBe(
      "02,1 - Video Soulmate-cbo-static - Copy 2",
    );
    expect(
      capsuledTrafficMetric(statsRow({ campaign_id: "999", campaign_name: null }), pathMap).campaign_path,
    ).toBe("999");
    expect(
      capsuledTrafficMetric(statsRow({ campaign_id: null, campaign_name: null }), pathMap).campaign_path,
    ).toBe("capsuled");
  });

  it("still carries campaign_id/campaign_name so id-level consumers keep working", () => {
    const metric = capsuledTrafficMetric(statsRow({}), pathMap);
    expect(metric.campaign_id).toBe("111");
    expect(metric.campaign_name).toBe("02,1 - Video Soulmate-cbo-static - Copy 2");
  });
});

describe("enumerateDays", () => {
  it("lists inclusive ISO days, spanning month boundaries", () => {
    expect(enumerateDays("2026-07-30", "2026-08-02")).toEqual([
      "2026-07-30",
      "2026-07-31",
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(enumerateDays("2026-08-17", "2026-08-17")).toEqual(["2026-08-17"]);
  });

  it("returns empty for inverted or invalid ranges", () => {
    expect(enumerateDays("2026-08-17", "2026-08-11")).toEqual([]);
    expect(enumerateDays("not-a-date", "2026-08-11")).toEqual([]);
  });

  it("keeps a two-month backfill window under the split cap", () => {
    expect(enumerateDays("2026-06-15", "2026-07-31").length).toBeLessThanOrEqual(MAX_DAILY_SPLIT_DAYS);
  });
});

describe("supersededPeriodRowIds", () => {
  const row = (id: string, date_from: string, date_to: string) => ({ id, date_from, date_to });

  it("selects only multi-day rows fully inside the window", () => {
    const ids = supersededPeriodRowIds(
      [
        row("inside", "2026-08-12", "2026-08-15"),
        row("daily", "2026-08-13", "2026-08-13"), // the rows we just wrote — never deleted
        row("crosses_start", "2026-08-10", "2026-08-12"),
        row("crosses_end", "2026-08-15", "2026-08-20"),
        row("outside", "2026-07-01", "2026-07-05"),
        row("exact_window", "2026-08-11", "2026-08-17"),
      ],
      "2026-08-11",
      "2026-08-17",
    );
    expect(ids).toEqual(["inside", "exact_window"]);
  });
});

describe("pathMappingStats", () => {
  it("reports mapped rows and spend against totals", () => {
    const rows = [
      statsRow({ campaign_id: "111", spend: 100 }),
      statsRow({ campaign_id: "999", spend: 50 }),
      statsRow({ campaign_id: null, spend: 25 }),
    ];
    const stats = pathMappingStats(rows, new Map([["111", "soulmate-sketch-web-en"]]));
    expect(stats).toEqual({
      resolved_campaigns: 1,
      mapped_rows: 1,
      total_rows: 3,
      mapped_spend: 100,
      total_spend: 175,
    });
  });
});
