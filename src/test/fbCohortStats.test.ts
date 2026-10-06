import { describe, expect, it } from "vitest";
import {
  assembleFbUserCosts,
  fbAuthoritativeUsersSql,
  fbCampaignMetricsSql,
  fbCohortRowKey,
  fbReportingDateFromUtc,
  normalizeAuthoritativeCampaignId,
  type FbAuthoritativeUserRow,
  type FbCampaignMetricRow,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const CAMPAIGN = "120249115818080040";
const DATE = "2026-07-14";
const KEY = fbCohortRowKey(DATE, "soulmate", "path-a");
const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], platform: [], currency: [], transaction_type: [], refund_status: "all",
};

function user(id = "u1", overrides: Partial<FbAuthoritativeUserRow> = {}): FbAuthoritativeUserRow {
  return {
    canonical_user_id: id,
    cohort_date: DATE,
    trial_timestamp_utc: `${DATE}T12:00:00.000Z`,
    funnel: "soulmate",
    campaign_path: "path-a",
    campaign_id: CAMPAIGN,
    ...overrides,
  };
}

function metric(overrides: Partial<FbCampaignMetricRow> = {}): FbCampaignMetricRow {
  return {
    fb_reporting_date: DATE,
    campaign_id: CAMPAIGN,
    ad_account_id: "act-1",
    currency: "USD",
    spend: 100,
    purchases: 2,
    impressions: 1_000,
    clicks: 50,
    ...overrides,
  };
}

describe("FB Cohorts user-first smoke contract", () => {
  it("normalizes Campaign IDs as strings", () => expect(normalizeAuthoritativeCampaignId(` ${CAMPAIGN} `)).toBe(CAMPAIGN));
  it("rejects missing Campaign sentinels", () => expect(normalizeAuthoritativeCampaignId("unknown")).toBe(""));
  it("converts UTC timestamp to Meta UTC date", () => expect(fbReportingDateFromUtc(`${DATE}T12:00:00Z`, "UTC")).toBe(DATE));
  it("converts UTC timestamp to Meta Los Angeles date", () => expect(fbReportingDateFromUtc("2026-07-14T02:00:00Z", "America/Los_Angeles")).toBe("2026-07-13"));

  it("reads authoritative users without joining Campaign Spend", () => {
    const sql = fbAuthoritativeUsersSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params: {} });
    expect(sql).toContain("trial_timestamp_utc");
    expect(sql).not.toContain("fact_facebook_stats");
    expect(sql).not.toContain("NOT IN");
  });

  // The funnel exclusion switch reaches the FB allocation scope: excluded
  // paths drop out of the authoritative-user stage, so fb_totals (full-funnel
  // Spend (FB) / CPP (FB) / FB Purchases) recompute without them.
  it("excludes switched-off campaign paths from the authoritative user scope", () => {
    const params: Record<string, unknown> = {};
    const sql = fbAuthoritativeUsersSql({
      filters: { ...NO_FILTERS, campaign_path_exclude: ["soulmate-sketch-es"] },
      dateFrom: null, dateTo: null, params,
    });
    expect(sql).toContain("campaign_path NOT IN ({p_fbu_cpx_0:String})");
    expect(sql).not.toContain("soulmate-sketch-es");
    expect(params.p_fbu_cpx_0).toBe("soulmate-sketch-es");
  });

  it("builds Campaign Metrics at selected-period Campaign grain", () => {
    const sql = fbCampaignMetricsSql({ campaignIds: [CAMPAIGN], dateFrom: DATE, dateTo: DATE, params: {} });
    expect(sql).toContain("GROUP BY campaign_id");
    expect(sql).not.toContain("GROUP BY stat_date");
  });

  it("assigns Campaign CPP to each matched user", () => {
    const result = assembleFbUserCosts([user("u1"), user("u2")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.assignments.map((row) => row.fb_user_cpp)).toEqual([50, 50]);
  });

  it("calculates Cohort Spend as SUM(user_cpp)", () => {
    const result = assembleFbUserCosts([user("u1"), user("u2")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.perRow[KEY].fb_spend).toBe(100);
  });

  it("makes row sums equal totals", () => {
    const result = assembleFbUserCosts([user("u1"), user("u2")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.perRow[KEY].fb_spend).toBe(result.totals.fb_spend);
  });

  it("reports 100% user coverage", () => {
    const result = assembleFbUserCosts([user("u1"), user("u2")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.totals.coverage_rate).toBe(100);
  });

  it("reports underallocated campaign Spend", () => {
    const result = assembleFbUserCosts([user("u1")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.validation[0]).toMatchObject({ allocation_status: "underallocated", unallocated_spend: 50 });
  });

  it("applies Campaign CPP even when authoritative users are overallocated", () => {
    const result = assembleFbUserCosts([user("u1"), user("u2"), user("u3")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.validation[0].allocation_status).toBe("overallocated");
    expect(result.totals.fb_spend).toBe(150);
  });

  it("does not calculate CPP when FB Purchases are zero", () => {
    const result = assembleFbUserCosts([user()], [metric({ purchases: 0 })], new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.assignments[0].fb_user_cpp).toBeNull();
  });

  it("does not require Meta timezone for Campaign-level matching", () => {
    const result = assembleFbUserCosts([user()], [metric({ reporting_timezones: null })], new Set([KEY]), {});
    expect(result.assignments[0].allocation_status).toBe("underallocated");
  });

  it("does not let conflicting payload timezones block Campaign-level matching", () => {
    const rows = [
      metric({ reporting_timezones: "UTC" }),
      metric({ reporting_timezones: "America/Los_Angeles" }),
    ];
    const result = assembleFbUserCosts([user()], rows, new Set([KEY]), { defaultTimezone: "UTC" });
    expect(result.assignments[0].allocation_status).toBe("underallocated");
  });

  it("does not let an invalid payload timezone block Campaign-level matching", () => {
    const result = assembleFbUserCosts(
      [user()],
      [metric({ reporting_timezones: "UTC-7-hardcoded" })],
      new Set([KEY]),
      { defaultTimezone: "UTC" },
    );
    expect(result.assignments[0].allocation_status).toBe("underallocated");
  });

  it("rejects duplicate authoritative users before aggregation", () => {
    expect(() => assembleFbUserCosts([user("u1"), user("u1")], [metric()], new Set([KEY]), { defaultTimezone: "UTC" })).toThrow(/duplicate authoritative user/);
  });
});

// Access Phase 2: campaigns hidden from a funnel-restricted member.
describe("hidden campaigns (funnel-restricted Cohorts FB columns)", () => {
  const HIDDEN = "120249115818080099";
  const KEY_B = fbCohortRowKey(DATE, "soulmate", "path-b");

  it("never allocates a hidden campaign, even when its metrics are present", () => {
    const users = [user("u1", { campaign_id: HIDDEN }), user("u2", { campaign_id: HIDDEN })];
    const result = assembleFbUserCosts(users, [metric({ campaign_id: HIDDEN, spend: 987654.32 })], new Set([KEY]), { defaultTimezone: "UTC" }, new Set([HIDDEN]));
    expect(result.perRow[KEY]).toMatchObject({ fb_spend: null, fb_purchases: null, fb_cpp: null, fb_matched_users: 0, fb_unmatched_users: 2, fb_match_status: "campaign_not_visible" });
    expect(result.assignments.every((row) => row.allocation_status === "campaign_hidden" && row.fb_user_cpp === null && row.fb_campaign_cpp === null)).toBe(true);
    expect(result.validation).toEqual([expect.objectContaining({ campaign_id: HIDDEN, allocation_status: "campaign_hidden", fb_spend: 0, fb_purchases: 0, allocated_spend: 0, unallocated_spend: 0 })]);
    expect(result.totals).toMatchObject({ fb_spend: null, fb_purchases: null, fb_matched_users: 0, fb_unmatched_users: 2 });
    expect(JSON.stringify(result)).not.toContain("987654");
  });

  it("a row with visible and hidden users is partial; a row with hidden users only is campaign_not_visible", () => {
    const users = [
      user("u1"),
      user("u2"),
      user("u3", { campaign_id: HIDDEN }),
      user("u4", { campaign_id: HIDDEN, campaign_path: "path-b" }),
    ];
    const result = assembleFbUserCosts(users, [metric()], new Set([KEY, KEY_B]), { defaultTimezone: "UTC" }, new Set([HIDDEN]));
    expect(result.perRow[KEY]).toMatchObject({ fb_match_status: "partial_coverage", fb_spend: 100, fb_matched_users: 2, fb_unmatched_users: 1 });
    expect(result.perRow[KEY_B]).toMatchObject({ fb_match_status: "campaign_not_visible", fb_spend: null });
    expect(result.totals).toMatchObject({ fb_spend: 100, fb_matched_users: 2, fb_unmatched_users: 2 });
  });

  it("an empty hidden set changes nothing (everyone but restricted members)", () => {
    const users = [user("u1"), user("u2"), user("u3", { campaign_id: HIDDEN })];
    const metrics = [metric(), metric({ campaign_id: HIDDEN, spend: 30, purchases: 1 })];
    const visible = new Set([KEY]);
    expect(assembleFbUserCosts(users, metrics, visible, { defaultTimezone: "UTC" }, new Set())).toEqual(assembleFbUserCosts(users, metrics, visible, { defaultTimezone: "UTC" }));
    const plain = assembleFbUserCosts(users, metrics, visible, { defaultTimezone: "UTC" });
    expect(plain.perRow[KEY]).toMatchObject({ fb_match_status: "matched", fb_spend: 130 });
    expect(plain.assignments.some((row) => row.allocation_status === "campaign_hidden")).toBe(false);
  });
});
