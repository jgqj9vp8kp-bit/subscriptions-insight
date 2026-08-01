// Project spend ledger (P2, rev. 3 §8a) — resolution ladder, residual
// classification and the window identity holding BY CONSTRUCTION.
import { describe, expect, it } from "vitest";
import {
  assembleProjectSpendLedger,
  campaignPathEvidenceSql,
  dominantCampaignPaths,
  knownGapDaysInWindow,
  projectCampaignSpendSql,
  type RawCampaignSpendRow,
} from "@/services/projectSpendLedger";
import { verifyWindowSpendIdentity } from "@/services/funnelEconomics";

const JULY = { from: "2026-07-01", to: "2026-07-31" };

function spendRow(over: Partial<RawCampaignSpendRow> = {}): RawCampaignSpendRow {
  return {
    campaign_id: "c1",
    ad_account_id: "act_1",
    currency: "USD",
    campaign_name: "Campaign",
    spend: 1000,
    ...over,
  };
}

describe("SQL builders", () => {
  it("spend query: campaign grain, FINAL, bound params, and NO empty-campaign filter", () => {
    const sql = projectCampaignSpendSql();
    expect(sql).toContain("fact_facebook_stats FINAL");
    expect(sql).toContain("{auth_user_id:String}");
    expect(sql).toContain("level = 'campaign'");
    expect(sql).toContain("stat_date >= toDate({date_from:String})");
    // Spend with no campaign identity is REAL and must reach other_unallocated —
    // filtering it out here would silently shrink window_source_spend.
    expect(sql).not.toContain("campaign_id != ''");
    expect(sql).toContain("GROUP BY campaign_id, ad_account_id, currency");
  });

  it("path evidence: authoritative successful trials, windowed and historical variants", () => {
    const windowed = campaignPathEvidenceSql(true);
    const historical = campaignPathEvidenceSql(false);
    for (const sql of [windowed, historical]) {
      expect(sql).toContain("analytics_transactions FINAL");
      expect(sql).toContain("transaction_type = 'trial'");
      expect(sql).toContain("status = 'success'");
      expect(sql).toContain("campaign_id != ''");
      expect(sql).toContain("campaign_path != ''");
    }
    expect(windowed).toContain("toDate({date_from:String})");
    expect(historical).not.toContain("date_from");
  });
});

describe("dominantCampaignPaths", () => {
  it("most users wins; ties break on the lexicographically smallest path", () => {
    const dominant = dominantCampaignPaths([
      { campaign_id: "c1", campaign_path: "beta", users: 5 },
      { campaign_id: "c1", campaign_path: "alpha", users: 9 },
      { campaign_id: "c2", campaign_path: "zeta", users: 3 },
      { campaign_id: "c2", campaign_path: "aaa", users: 3 },
    ]);
    expect(dominant.get("c1")).toEqual({ path: "alpha", users: 14 });
    expect(dominant.get("c2")).toEqual({ path: "aaa", users: 6 });
  });

  it("string-typed counts (ClickHouse JSON) are accepted", () => {
    const dominant = dominantCampaignPaths([{ campaign_id: "c1", campaign_path: "p", users: "12" }]);
    expect(dominant.get("c1")).toEqual({ path: "p", users: 12 });
  });
});

describe("assembleProjectSpendLedger", () => {
  const windowPathRows = [{ campaign_id: "c-live", campaign_path: "soulmate-sketch", users: 40 }];
  const historicalPathRows = [
    { campaign_id: "c-live", campaign_path: "soulmate-sketch", users: 90 },
    { campaign_id: "c-june", campaign_path: "palm-reading", users: 25 },
  ];

  const spendRows = [
    spendRow({ campaign_id: "c-live", spend: 5_000 }),                                      // rung 1: window users
    spendRow({ campaign_id: "c-june", spend: 1_500, ad_account_id: "act_2" }),              // rung 2: historical only
    spendRow({ campaign_id: "c-ghost", spend: 800, currency: "EUR" }),                      // unknown funnel
    spendRow({ campaign_id: "", campaign_name: "(no id)", spend: 200, ad_account_id: "act_3" }), // unallocated
  ];

  it("classifies every spend row into exactly one bucket — the identity holds by construction", () => {
    const { windowLedger } = assembleProjectSpendLedger({
      spendRows, windowPathRows, historicalPathRows, knownGaps: [], window: JULY,
    });
    expect(windowLedger.windowSourceSpend).toBe(7_500);
    expect(windowLedger.userAttributed.spend).toBe(5_000);
    expect(windowLedger.noUser.spend).toBe(1_500);
    expect(windowLedger.unknownFunnel.spend).toBe(800);
    expect(windowLedger.otherUnallocated.spend).toBe(200);
    expect(verifyWindowSpendIdentity(windowLedger).ok).toBe(true);
  });

  it("rolls funnel ledgers up with basis, coverage and currency flags", () => {
    const { funnelLedgers } = assembleProjectSpendLedger({
      spendRows, windowPathRows, historicalPathRows, knownGaps: [], window: JULY,
    });
    const sketch = funnelLedgers["soulmate-sketch"];
    expect(sketch.funnelResolvedSpend).toBe(5_000);
    expect(sketch.userAttributedSpend).toBe(5_000);
    expect(sketch.noUserSpend).toBe(0);
    expect(sketch.spendCoverage).toBe(1);
    expect(sketch.resolutionBasis).toBe("user_attribution_only");
    expect(sketch.currencyMixed).toBe(false);

    const palm = funnelLedgers["palm-reading"];
    expect(palm.funnelResolvedSpend).toBe(1_500);
    expect(palm.userAttributedSpend).toBe(0);
    expect(palm.noUserSpend).toBe(1_500);
    expect(palm.spendCoverage).toBe(0);
    expect(palm.resolutionBasis).toBe("historical_campaign_path");
    // userAttributed + noUser === funnelResolved for every funnel (invariant 14).
    for (const ledger of Object.values(funnelLedgers)) {
      expect((ledger.userAttributedSpend ?? 0) + (ledger.noUserSpend ?? 0)).toBe(ledger.funnelResolvedSpend);
    }
  });

  it("window evidence outranks historical for the same campaign", () => {
    const conflicting = [{ campaign_id: "c-live", campaign_path: "some-old-path", users: 500 }];
    const { funnelLedgers, campaigns } = assembleProjectSpendLedger({
      spendRows: [spendRow({ campaign_id: "c-live", spend: 5_000 })],
      windowPathRows,
      historicalPathRows: conflicting,
      knownGaps: [],
      window: JULY,
    });
    expect(funnelLedgers["soulmate-sketch"]).toBeDefined();
    expect(funnelLedgers["some-old-path"]).toBeUndefined();
    expect(campaigns[0].resolution).toBe("window_users");
  });

  it("every group ships a NULL commission — nothing is guessed (correction 4)", () => {
    const { windowLedger, funnelLedgers } = assembleProjectSpendLedger({
      spendRows, windowPathRows, historicalPathRows, knownGaps: [], window: JULY,
    });
    const allGroups = [
      ...Object.values(funnelLedgers).flatMap((ledger) => ledger.groups),
      ...windowLedger.unknownFunnel.groups,
      ...windowLedger.otherUnallocated.groups,
    ];
    expect(allGroups.length).toBeGreaterThan(0);
    for (const group of allGroups) {
      expect(group.trafficCommission).toBeNull();
      expect(group.trafficCashOutflow).toBeNull();
    }
    for (const ledger of Object.values(funnelLedgers)) {
      expect(ledger.trafficCashOutflow).toBeNull();
    }
  });

  it("merges groups by (channel, account, currency) across campaigns of one funnel", () => {
    const { funnelLedgers } = assembleProjectSpendLedger({
      spendRows: [
        spendRow({ campaign_id: "c-live", spend: 3_000 }),
        spendRow({ campaign_id: "c-live2", spend: 2_000 }),           // same act_1/USD
        spendRow({ campaign_id: "c-live3", spend: 700, currency: "EUR" }),
      ],
      windowPathRows: [
        { campaign_id: "c-live", campaign_path: "soulmate-sketch", users: 10 },
        { campaign_id: "c-live2", campaign_path: "soulmate-sketch", users: 5 },
        { campaign_id: "c-live3", campaign_path: "soulmate-sketch", users: 2 },
      ],
      historicalPathRows: [],
      knownGaps: [],
      window: JULY,
    });
    const sketch = funnelLedgers["soulmate-sketch"];
    expect(sketch.groups).toHaveLength(2);
    const usd = sketch.groups.find((group) => group.currency === "USD")!;
    expect(usd.spend).toBe(5_000);
    expect(sketch.currencyMixed).toBe(true);
    expect(sketch.currency).toBeNull();
  });

  it("is deterministic under spend-row order", () => {
    const forward = assembleProjectSpendLedger({ spendRows, windowPathRows, historicalPathRows, knownGaps: [], window: JULY });
    const reversed = assembleProjectSpendLedger({
      spendRows: [...spendRows].reverse(), windowPathRows, historicalPathRows, knownGaps: [], window: JULY,
    });
    expect(reversed).toEqual(forward);
  });

  it("invariant 28: known gaps expand to per-day entries with evidence and set spendIncomplete", () => {
    const { windowLedger } = assembleProjectSpendLedger({
      spendRows, windowPathRows, historicalPathRows,
      knownGaps: [{ gap_id: "FB-GAP-114", gap_from: "2026-06-28", gap_to: "2026-07-03", reason: "source empty" }],
      window: JULY,
    });
    expect(windowLedger.spendIncomplete).toBe(true);
    // Only the overlap with the window: July 1–3, not the June days.
    expect(windowLedger.knownGapDays.map((day) => day.date)).toEqual(["2026-07-01", "2026-07-02", "2026-07-03"]);
    expect(windowLedger.knownGapDays[0].reference).toBe("FB-GAP-114");
  });

  it("a gap outside the window does not mark spend incomplete", () => {
    expect(knownGapDaysInWindow(
      [{ gap_id: "g", gap_from: "2026-05-08", gap_to: "2026-06-14", reason: "hole" }],
      JULY,
    )).toEqual([]);
  });
});
