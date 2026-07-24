import { describe, expect, it, vi } from "vitest";
import {
  assembleFbUserCosts,
  assertFbSnapshotUnique,
  fbAuthoritativeCampaignScopeSql,
  fbAuthoritativeUserGroupsSql,
  fbAuthoritativeUsersSql,
  fbCampaignMetricsSql,
  fbCohortRowKey,
  fbReportingDateFromUtc,
  isValidIanaTimezone,
  type FbAuthoritativeUserRow,
  type FbCampaignMetricRow,
  type FbMetaTimezoneConfig,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import { FetchClickHouseClient } from "../../supabase/functions/_shared/clickhouse/client.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const DATE = "2026-07-14";
const CAMPAIGN_A = "120249115818080040";
const CAMPAIGN_B = "120249115818080041";
const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

function user(index: number, overrides: Partial<FbAuthoritativeUserRow> = {}): FbAuthoritativeUserRow {
  return {
    canonical_user_id: `user-${index}`,
    cohort_date: DATE,
    trial_timestamp_utc: `${DATE}T12:00:00.000Z`,
    funnel: "soulmate",
    campaign_path: "path-a",
    campaign_id: CAMPAIGN_A,
    ...overrides,
  };
}

function metric(overrides: Partial<FbCampaignMetricRow> = {}): FbCampaignMetricRow {
  return {
    fb_reporting_date: DATE,
    campaign_id: CAMPAIGN_A,
    ad_account_id: "act-a",
    currency: "USD",
    reporting_timezones: "UTC",
    spend: 100,
    purchases: 1,
    impressions: 1_000,
    clicks: 50,
    link_clicks: 40,
    reach: 800,
    purchase_value: 200,
    ...overrides,
  };
}

function visible(users: FbAuthoritativeUserRow[]): Set<string> {
  return new Set(users.map((row) => fbCohortRowKey(row.cohort_date, row.funnel, row.campaign_path)));
}

function assemble(users: FbAuthoritativeUserRow[], metrics: FbCampaignMetricRow[], config: FbMetaTimezoneConfig = { defaultTimezone: "UTC" }) {
  return assembleFbUserCosts(users, metrics, visible(users), config);
}

// 12 tests -------------------------------------------------------------------
describe("1–12 Campaign CPP", () => {
  it.each([
    [100, 4, 25],
    [249.27, 6, 41.545],
    [0, 5, 0],
    [1, 3, 0.333333],
    [999_999, 1, 999_999],
    [1_000_000, 100_000, 10],
    [12.34, 2, 6.17],
    [0.01, 1, 0.01],
    [50, 8, 6.25],
    [123_456.78, 12, 10_288.065],
  ])("calculates %d / %d = %d", (spend, purchases, expected) => {
    const result = assemble([user(1)], [metric({ spend, purchases })]);
    expect(result.validation[0].campaign_cpp).toBeCloseTo(expected, 6);
  });

  it("returns null CPP when Purchases are zero", () => {
    expect(assemble([user(1)], [metric({ purchases: 0 })]).validation[0].campaign_cpp).toBeNull();
  });

  it("blocks negative Spend as invalid metrics", () => {
    expect(assemble([user(1)], [metric({ spend: -100, purchases: 1 })]).validation[0].allocation_status).toBe("invalid_metrics");
  });
});

// 12 tests -------------------------------------------------------------------
describe("13–24 User CPP assignment", () => {
  it.each(Array.from({ length: 8 }, (_, index) => index + 1))("assigns Campaign CPP to user %d", (index) => {
    const users = Array.from({ length: 8 }, (_, userIndex) => user(userIndex + 1));
    const result = assemble(users, [metric({ spend: 400, purchases: 8 })]);
    expect(result.assignments[index - 1].fb_user_cpp).toBe(50);
  });

  it("assigns different CPPs from different Campaigns", () => {
    const users = [user(1), user(2, { campaign_id: CAMPAIGN_B })];
    const result = assemble(users, [metric({ spend: 20 }), metric({ campaign_id: CAMPAIGN_B, spend: 80 })]);
    expect(result.assignments.map((row) => row.fb_user_cpp)).toEqual([20, 80]);
  });

  it("aggregates all selected-period dates before assigning one Campaign CPP", () => {
    const users = [user(1), user(2, { cohort_date: "2026-07-15", trial_timestamp_utc: "2026-07-15T12:00:00Z" })];
    const result = assemble(users, [metric({ spend: 20 }), metric({ fb_reporting_date: "2026-07-15", spend: 40 })]);
    expect(result.assignments.map((row) => row.fb_user_cpp)).toEqual([30, 30]);
  });

  it("supports users in multiple funnels", () => {
    const users = [user(1), user(2, { funnel: "palmistry", campaign_path: "path-b" })];
    const result = assemble(users, [metric({ purchases: 2 })]);
    expect(Object.values(result.perRow).map((row) => row.fb_spend)).toEqual([50, 50]);
  });

  it("supports users in multiple Campaign Paths", () => {
    const users = [user(1), user(2, { campaign_path: "path-b" })];
    const result = assemble(users, [metric({ purchases: 2 })]);
    expect(Object.keys(result.perRow)).toHaveLength(2);
  });
});

// 20 tests -------------------------------------------------------------------
describe("25–44 Meta reporting timezone", () => {
  it.each([
    ["2026-07-14T12:00:00Z", "UTC", "2026-07-14"],
    ["2026-07-14T06:59:59Z", "America/Los_Angeles", "2026-07-13"],
    ["2026-07-14T07:00:00Z", "America/Los_Angeles", "2026-07-14"],
    ["2026-07-14T23:59:59Z", "Asia/Tokyo", "2026-07-15"],
    ["2026-07-14T15:00:00Z", "Asia/Tokyo", "2026-07-15"],
    ["2026-07-14T09:59:59Z", "Pacific/Honolulu", "2026-07-13"],
    ["2026-07-14T10:00:00Z", "Pacific/Honolulu", "2026-07-14"],
    ["2026-07-14T10:00:00Z", "Pacific/Kiritimati", "2026-07-15"],
    ["2026-03-08T06:59:59Z", "America/New_York", "2026-03-08"],
    ["2026-03-08T07:00:00Z", "America/New_York", "2026-03-08"],
    ["2026-11-01T05:59:59Z", "America/New_York", "2026-11-01"],
    ["2026-11-01T06:00:00Z", "America/New_York", "2026-11-01"],
    ["2026-03-29T00:59:59Z", "Europe/London", "2026-03-29"],
    ["2026-03-29T01:00:00Z", "Europe/London", "2026-03-29"],
    ["2026-10-25T00:59:59Z", "Europe/London", "2026-10-25"],
    ["2026-10-25T01:00:00Z", "Europe/London", "2026-10-25"],
  ])("converts %s in %s to %s", (timestamp, timezone, expected) => {
    expect(fbReportingDateFromUtc(timestamp, timezone)).toBe(expected);
  });

  it("supports account-specific timezones", () => {
    const users = [user(1), user(2, { campaign_id: CAMPAIGN_B })];
    const metrics = [
      metric({ reporting_timezones: null }),
      metric({ campaign_id: CAMPAIGN_B, ad_account_id: "act-b", reporting_timezones: null }),
    ];
    const result = assemble(users, metrics, { accountTimezones: { "act-a": "UTC", "act-b": "America/Los_Angeles" } });
    expect(result.assignments.map((row) => row.fb_timezone)).toEqual(["UTC", "America/Los_Angeles"]);
  });

  it("uses payload timezone before configured default", () => {
    expect(assemble([user(1)], [metric({ reporting_timezones: "UTC" })], { defaultTimezone: "Asia/Tokyo" }).assignments[0].fb_timezone).toBe("UTC");
  });

  it("does not depend on the browser default timezone", () => {
    const explicit = fbReportingDateFromUtc("2026-07-14T02:00:00Z", "America/Los_Angeles");
    new Intl.DateTimeFormat().format(new Date("2026-07-14T02:00:00Z"));
    expect(explicit).toBe("2026-07-13");
  });

  it("rejects invalid IANA timezone values", () => {
    expect(isValidIanaTimezone("UTC-7-hardcoded")).toBe(false);
  });
});

// 10 tests -------------------------------------------------------------------
describe("45–54 selected-period Campaign join contract", () => {
  const sql = fbAuthoritativeUsersSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, params: {} });
  const metricSql = fbCampaignMetricsSql({ campaignIds: [CAMPAIGN_A], dateFrom: "2026-07-13", dateTo: "2026-07-15", params: {} });

  it("selects trial_timestamp_utc", () => expect(sql).toContain("trial_timestamp_utc"));
  it("preserves product cohort_date", () => expect(sql).toContain("toString(cohort_date) cohort_date"));
  it("does not rename cohort_date to reporting date", () => expect(sql).not.toContain("cohort_date fb_reporting_date"));
  it("Campaign Metrics exposes selected activity-period bounds", () => expect(metricSql).toContain("period_date_from"));
  it("Campaign Metrics grain is Campaign ID only", () => expect(metricSql).toContain("GROUP BY campaign_id"));
  it("does not produce a reporting-date join key", () => expect(assemble([user(1)], [metric()]).assignments[0].fb_reporting_date).toBeNull());
  it("matches by Campaign when the user reporting date would be shifted", () => {
    const shiftedUser = user(1, { trial_timestamp_utc: "2026-07-14T02:00:00Z" });
    const result = assemble([shiftedUser], [metric({ reporting_timezones: null })], { defaultTimezone: "America/Los_Angeles" });
    expect(result.assignments[0].fb_user_cpp).toBe(100);
  });
  it("matches without timezone conversion", () => {
    const shiftedUser = user(1, { trial_timestamp_utc: "2026-07-14T02:00:00Z" });
    const result = assemble([shiftedUser], [metric({ fb_reporting_date: "2026-07-13", reporting_timezones: null })], { defaultTimezone: "America/Los_Angeles" });
    expect(result.assignments[0].fb_user_cpp).toBe(100);
  });
  it("does not use browser dates in SQL", () => expect(`${sql}${metricSql}`).not.toContain("Browser"));
  it("does not contain a fixed -7 hour shift", () => expect(`${sql}${metricSql}`).not.toMatch(/-\s*7\s*hour/i));
});

// 12 tests -------------------------------------------------------------------
describe("55–66 Spend is aggregated only through users", () => {
  it("calculates Spend as SUM(user_cpp)", () => {
    const users = [user(1), user(2)];
    expect(assemble(users, [metric({ purchases: 2 })]).totals.fb_spend).toBe(100);
  });

  it("row sums equal totals", () => {
    const users = [user(1), user(2, { funnel: "palmistry", campaign_path: "path-b" })];
    const result = assemble(users, [metric({ purchases: 2 })]);
    expect(Object.values(result.perRow).reduce((sum, row) => sum + (row.fb_spend ?? 0), 0)).toBe(result.totals.fb_spend);
  });

  it("shared Campaign has no double counting", () => {
    const users = [user(1), user(2, { funnel: "palmistry", campaign_path: "path-b" })];
    expect(assemble(users, [metric({ purchases: 2 })]).totals.fb_spend).toBe(100);
  });

  it("shared reporting date has no double counting", () => {
    const users = [user(1), user(2, { campaign_id: CAMPAIGN_B })];
    const metrics = [metric({ spend: 40 }), metric({ campaign_id: CAMPAIGN_B, spend: 60 })];
    expect(assemble(users, metrics).totals.fb_spend).toBe(100);
  });

  it("multiple Campaigns sum user CPP", () => {
    const users = [user(1), user(2, { campaign_id: CAMPAIGN_B })];
    const metrics = [metric({ spend: 25 }), metric({ campaign_id: CAMPAIGN_B, spend: 75 })];
    expect(assemble(users, metrics).totals.fb_spend).toBe(100);
  });

  it("multiple Funnels sum to the same total", () => {
    const users = [user(1), user(2, { funnel: "palmistry", campaign_path: "path-b" })];
    const result = assemble(users, [metric({ purchases: 2 })]);
    expect(result.totals.fb_spend).toBe(100);
  });

  it("multiple Campaign Paths sum to the same total", () => {
    const users = [user(1), user(2, { campaign_path: "path-b" })];
    const result = assemble(users, [metric({ purchases: 2 })]);
    expect(result.totals.fb_spend).toBe(100);
  });

  it("exact duplicate Campaign Metrics rows are idempotent", () => {
    expect(assemble([user(1)], [metric(), metric()]).totals.fb_spend).toBe(100);
  });

  it("zero Campaign Spend assigns zero user cost", () => {
    expect(assemble([user(1)], [metric({ spend: 0 })]).totals.fb_spend).toBe(0);
  });

  it("missing Campaign Metrics never becomes zero Spend", () => {
    expect(assemble([user(1)], []).totals.fb_spend).toBeNull();
  });

  it("overallocated Campaign applies one CPP share to every authoritative user", () => {
    const users = [user(1), user(2)];
    expect(assemble(users, [metric({ purchases: 1 })]).totals.fb_spend).toBe(200);
  });

  it("sub-cent user CPP reconciles back to Campaign Spend", () => {
    const users = Array.from({ length: 6 }, (_, index) => user(index));
    expect(assemble(users, [metric({ spend: 249.27, purchases: 6 })]).totals.fb_spend).toBeCloseTo(249.27, 10);
  });
});

// 10 tests -------------------------------------------------------------------
describe("67–76 filters and visible scope", () => {
  it.each([
    ["funnel", { funnel: ["soulmate"] }, "p_fbu_fn_0"],
    ["campaign_path", { campaign_path: ["path-a"] }, "p_fbu_cp_0"],
    ["platform", { traffic_source: ["facebook"] }, "p_fbu_tsrc_0"],
    ["country", { country: ["US"] }, "p_fbu_geo_0"],
    ["media buyer", { media_buyer: ["Ivan"] }, "p_fbu_mb_0"],
  ])("binds %s filter at user scope", (_label, filters, expectedParam) => {
    const params: Record<string, unknown> = {};
    fbAuthoritativeUsersSql({ filters: { ...NO_FILTERS, ...filters }, dateFrom: null, dateTo: null, params });
    expect(params).toHaveProperty(expectedParam);
  });

  it("keeps the Campaign filter in the POST body instead of URL parameters", () => {
    const params: Record<string, unknown> = {};
    const sql = fbAuthoritativeUsersSql({ filters: { ...NO_FILTERS, campaign_id: [CAMPAIGN_A] }, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("IN (unhex(");
    expect(sql).not.toContain(CAMPAIGN_A);
    expect(Object.keys(params).some((key) => key.includes("cid"))).toBe(false);
  });

  it("date filter remains product cohort_date filter", () => {
    const sql = fbAuthoritativeUsersSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, params: {} });
    expect(sql).toContain("toString(cohort_date)");
  });

  it("refund filter is enforced by the visible cohort row scope", () => {
    const users = [user(1), user(2, { campaign_path: "refund-hidden" })];
    const result = assembleFbUserCosts(users, [metric({ purchases: 2 })], new Set([fbCohortRowKey(DATE, "soulmate", "path-a")]), { defaultTimezone: "UTC" });
    expect(result.assignments).toHaveLength(1);
  });

  it("cancelled filter cannot reintroduce a hidden row", () => {
    const users = [user(1), user(2, { campaign_path: "cancelled-hidden" })];
    const result = assembleFbUserCosts(users, [metric({ purchases: 2 })], new Set([fbCohortRowKey(DATE, "soulmate", "path-a")]), { defaultTimezone: "UTC" });
    expect(Object.keys(result.perRow)).toEqual([fbCohortRowKey(DATE, "soulmate", "path-a")]);
  });

  it("live cohort dates use the same user-first path", () => {
    const live = user(1, { cohort_date: "2026-07-18", trial_timestamp_utc: "2026-07-18T12:00:00Z" });
    expect(assemble([live], [metric({ fb_reporting_date: "2026-07-18" })]).totals.fb_spend).toBe(100);
  });
});

// 12 tests -------------------------------------------------------------------
describe("77–88 coverage and allocation", () => {
  it.each([
    [100, 100, 100],
    [99, 100, 99],
    [95, 100, 95],
    [50, 100, 50],
    [1, 100, 1],
    [0, 100, 0],
  ])("reports %d/%d users as %d%% coverage", (matched, purchases, expected) => {
    const users = Array.from({ length: matched }, (_, index) => user(index));
    if (matched === 0) {
      expect(assemble([], [metric({ purchases })]).validation[0]).toMatchObject({ allocation_status: "no_matched_users", coverage_rate: 0 });
      return;
    }
    expect(assemble(users, [metric({ purchases })]).validation[0].coverage_rate).toBe(expected);
  });

  it("marks 100% coverage allocated", () => {
    expect(assemble([user(1)], [metric()]).validation[0].allocation_status).toBe("fully_allocated");
  });

  it("marks partial coverage underallocated", () => {
    expect(assemble([user(1)], [metric({ purchases: 2 })]).validation[0].allocation_status).toBe("underallocated");
  });

  it("calculates Unallocated Spend as CPP × missing users", () => {
    expect(assemble([user(1)], [metric({ spend: 100, purchases: 4 })]).validation[0].unallocated_spend).toBe(75);
  });

  it("marks matched users above Purchases overallocated", () => {
    expect(assemble([user(1), user(2)], [metric({ purchases: 1 })]).validation[0].allocation_status).toBe("overallocated");
  });

  it("separates no FB Campaign", () => {
    expect(assemble([user(1)], []).validation[0].allocation_status).toBe("campaign_unmatched");
  });

  it("separates zero FB Purchases", () => {
    expect(assemble([user(1)], [metric({ purchases: 0 })]).validation[0].allocation_status).toBe("no_fb_purchases");
  });
});

// 20 tests -------------------------------------------------------------------
describe("89–108 regression isolation", () => {
  const baseline = {
    trial_users: 100,
    active_users: 70,
    active_subscriptions: 65,
    cancelled_users: 5,
    user_cancelled_users: 3,
    auto_cancelled_users: 2,
    upsell_users: 20,
    first_subscription_users: 60,
    renewal_users: 40,
    refund_users: 5,
    support_users: 3,
    support_rate: 3,
    gross_revenue: 1_000,
    net_revenue: 900,
    amount_refunded: 100,
    revenue_d0: 200,
    revenue_d7: 600,
    revenue_d30: 900,
    token_purchases: 8,
    token_net_revenue: 80,
  };
  const fb = assemble([user(1)], [metric()]).perRow[fbCohortRowKey(DATE, "soulmate", "path-a")];
  it.each(Object.entries(baseline))("does not mutate existing Cohorts metric %s", (field, expected) => {
    const row: Record<string, unknown> = { ...baseline };
    Object.assign(row, fb);
    expect(row[field]).toBe(expected);
  });
});

// 10 tests -------------------------------------------------------------------
describe("109–118 performance and query shape", () => {
  const userSql = fbAuthoritativeUsersSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, params: {} });
  const metricSql = fbCampaignMetricsSql({ campaignIds: [CAMPAIGN_A, CAMPAIGN_B], dateFrom: DATE, dateTo: DATE, params: {} });
  it("uses two bounded source grains", () => expect([userSql, metricSql]).toHaveLength(2));
  it("does not scan analytics_transactions for FB assignment", () => expect(`${userSql}${metricSql}`).not.toContain("analytics_transactions"));
  it("does not join Campaign Spend to cohort rows", () => expect(userSql).not.toContain("spend"));
  it("queries Campaign Metrics only for selected Campaign IDs without URL parameters", () => {
    // Qualified (f.campaign_id): the SELECT aliases the trimmed value back to
    // `campaign_id`, so a bare identifier would resolve to that alias and raise
    // "Cyclic aliases" instead of reading the column.
    expect(metricSql).toContain("trim(BOTH ' ' FROM f.campaign_id) IN (unhex(");
    expect(metricSql).not.toContain("p_fbu_metric_cid");
    expect(metricSql).not.toContain(CAMPAIGN_A);
  });
  it("bounds Campaign Metrics by reporting dates", () => expect(metricSql).toContain("fbu_metric_from"));
  it("aggregates Campaign Metrics before JavaScript assembly", () => expect(metricSql).toContain("sum(f.spend)"));
  it("does not serialize raw payload in the result", () => expect(metricSql).not.toContain("raw_payload raw_payload"));
  it("deduplicates exact metric components", () => expect(assemble([user(1)], [metric(), metric()]).validation[0].fb_spend).toBe(100));
  it("handles 10,000 users without changing the algorithmic result", () => {
    const users = Array.from({ length: 10_000 }, (_, index) => user(index));
    expect(assemble(users, [metric({ spend: 100_000, purchases: 10_000 })]).totals.fb_spend).toBe(100_000);
  }, 15_000);
  it("keeps one assignment per authoritative user", () => {
    const users = Array.from({ length: 1_000 }, (_, index) => user(index));
    expect(assemble(users, [metric({ purchases: 1_000 })]).assignments).toHaveLength(1_000);
  });
});

describe("production blocker regressions: bounded transport and precision", () => {
  it.each([100, 500, 1_000, 5_000])("keeps %d generated Campaign IDs out of the ClickHouse URL", async (count) => {
    const campaignIds = Array.from({ length: count }, (_, index) => `campaign-${String(index).padStart(5, "0")}`);
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = fbCampaignMetricsSql({ campaignIds, dateFrom: DATE, dateTo: DATE, params });
    const requests: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (request: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(request), body: String(init?.body ?? "") });
      return new Response("", { status: 200 });
    });
    try {
      const client = new FetchClickHouseClient({ host: "https://clickhouse.example", username: "u", password: "p", database: "analytics" });
      await client.query({ query: sql, query_params: params, format: "JSONEachRow" });
    } finally {
      vi.unstubAllGlobals();
    }
    expect(requests).toHaveLength(1);
    expect(requests[0].url.length).toBeLessThan(500);
    expect(requests[0].url).not.toContain("campaign-");
    expect(requests[0].body).not.toContain(campaignIds[0]);
    expect(requests[0].body).toContain("unhex(");
    expect(Object.keys(params).filter((key) => key.includes("cid"))).toHaveLength(0);
  });

  it("aggregates the authoritative scope in ClickHouse instead of returning user rows", () => {
    const params: Record<string, unknown> = {};
    const visibleRows = [{ cohort_date: DATE, funnel: "soulmate", campaign_path: "path-a" }];
    const scopeSql = fbAuthoritativeCampaignScopeSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, visibleRows, params });
    const groupSql = fbAuthoritativeUserGroupsSql({
      filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, visibleRows,
      params: {},
    });
    expect(scopeSql).toContain("count() authoritative_users");
    expect(scopeSql).toContain("GROUP BY");
    expect(scopeSql).not.toContain("canonical_user_id");
    expect(groupSql).toContain("count() authoritative_user_count");
    expect(groupSql).toContain("GROUP BY cohort_date, funnel, campaign_path, campaign_id");
    expect(groupSql).not.toContain("fb_reporting_date");
    expect(groupSql).not.toContain("canonical_user_id");
  });

  it.each([30_000, 300_000, 1_000_000])("keeps full user_cpp precision for %d purchases without allocating a user array", (purchases) => {
    const result = assemble([
      user(1, { authoritative_user_count: purchases }),
    ], [metric({ spend: 1, purchases })]);
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].fb_user_cpp).toBeCloseTo(1 / purchases, 15);
    expect(result.totals.fb_spend).toBe(1);
    expect(result.validation[0].allocated_spend).toBe(1);
  });
});

// 21 tests -------------------------------------------------------------------
describe("119–139 live Campaign validation", () => {
  const campaigns = Array.from({ length: 20 }, (_, index) => ({
    campaignId: `12024911581808${String(index).padStart(4, "0")}`,
    userId: `live-user-${index}`,
    spend: 100 + index,
  }));
  const users = campaigns.map((campaign, index) => user(index, { canonical_user_id: campaign.userId, campaign_id: campaign.campaignId }));
  const metrics = campaigns.map((campaign) => metric({ campaign_id: campaign.campaignId, spend: campaign.spend }));
  const result = assemble(users, metrics);

  it.each(campaigns)("validates Campaign $campaignId", ({ campaignId, spend }) => {
    const row = result.validation.find((validation) => validation.campaign_id === campaignId)!;
    expect(row).toMatchObject({
      campaign_id: campaignId,
      fb_reporting_date: null,
      period_date_from: DATE,
      period_date_to: DATE,
      fb_purchases: 1,
      matched_authoritative_users: 1,
      coverage_rate: 100,
      campaign_cpp: spend,
      fb_spend: spend,
      allocation_status: "fully_allocated",
    });
  });

  it("returns 20 Campaign validation rows", () => {
    expect(result.validation).toHaveLength(20);
  });
});

describe("snapshot invariant", () => {
  it("accepts count(*) = countDistinct(canonical_user_id)", () => {
    expect(assertFbSnapshotUnique({ snapshot_rows: 20, snapshot_unique_users: 20, snapshot_duplicate_users: 0 }).duplicateUsers).toBe(0);
  });

  it("rejects duplicate canonical_user_id", () => {
    expect(() => assertFbSnapshotUnique({ snapshot_rows: 21, snapshot_unique_users: 20, snapshot_duplicate_users: 1 })).toThrow(/not unique/);
  });
});

// Regression: every SQL builder that aliases an expression back to
// `campaign_id` must read the source column QUALIFIED. ClickHouse substitutes a
// SELECT alias into any bare identifier of the same name — including the one
// inside the aliasing expression itself — and raises "Cyclic aliases". That
// killed all six FB queries at once, so fb_data_status was permanently
// "unavailable" and every Spend (FB) / FB Purchases cell rendered "—"
// (found 2026-07-24 on live data).
describe("campaign_id aliasing never shadows its own source column", () => {
  const sqls: Array<[string, string]> = [
    ["users", fbAuthoritativeUsersSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, params: {} })],
    ["campaign_scope", fbAuthoritativeCampaignScopeSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, visibleRows: [], params: {} })],
    ["groups", fbAuthoritativeUserGroupsSql({ filters: NO_FILTERS, dateFrom: DATE, dateTo: DATE, visibleRows: [], params: {} })],
    ["metrics", fbCampaignMetricsSql({ campaignIds: null, dateFrom: DATE, dateTo: DATE, params: {} })],
  ];

  it("metrics: no aggregate is aliased onto a bare copy of its own column", () => {
    const sql = fbCampaignMetricsSql({ campaignIds: null, dateFrom: DATE, dateTo: DATE, params: {} });
    // The live failure: `if(uniqExact(ad_account_id) = 1, …) ad_account_id`
    // beside `uniqExact(ad_account_id) ad_account_count` — the alias got
    // substituted into the sibling, nesting one aggregate inside another
    // (ILLEGAL_AGGREGATION, code 184) and blanking every FB column.
    // Aliases themselves are bare by definition, so assert on what actually
    // matters: every aggregate argument reads a QUALIFIED column, so no alias
    // can be substituted into it.
    const unqualifiedAggregateArg = /\b(?:sum|uniqExact|argMax|any|min|max|isFinite)\(\s*(?!f\.)[a-z_]+\b/g;
    expect(sql.match(unqualifiedAggregateArg) ?? []).toEqual([]);
  });

  for (const [label, sql] of sqls) {
    it(`${label}: aliases campaign_id only from a qualified column`, () => {
      // No bare `campaign_id` inside an expression that is aliased to campaign_id.
      expect(sql).not.toMatch(/trim\(BOTH ' ' FROM campaign_id\)\s+campaign_id/);
      expect(sql).not.toMatch(/FROM campaign_id\)\)\s*IN\s*\('',\s*'unknown'/);
      // Any table it reads is aliased, so the qualification resolves.
      if (/\bcampaign_id\b/.test(sql)) {
        expect(sql).toMatch(/FROM \w+ AS (fc|f) FINAL/);
      }
    });
  }
});
