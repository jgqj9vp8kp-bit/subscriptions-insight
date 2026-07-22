import { describe, expect, it } from "vitest";
import {
  assembleFbUserCosts,
  fbAuthoritativeUserGroupsSql,
  fbCampaignMetricsSql,
  fbCohortRowKey,
  type FbAuthoritativeUserRow,
  type FbCampaignMetricRow,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const CAMPAIGN_A = "120248327446340073";
const CAMPAIGN_B = "120248327446340074";
const DATE_A = "2026-06-01";
const DATE_B = "2026-06-02";
const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

function user(id: string, overrides: Partial<FbAuthoritativeUserRow> = {}): FbAuthoritativeUserRow {
  return {
    canonical_user_id: id,
    cohort_date: DATE_A,
    trial_timestamp_utc: `${DATE_A}T23:59:59.000Z`,
    funnel: "soulmate",
    campaign_path: "path-a",
    campaign_id: CAMPAIGN_A,
    ...overrides,
  };
}

function metric(overrides: Partial<FbCampaignMetricRow> = {}): FbCampaignMetricRow {
  return {
    fb_reporting_date: DATE_A,
    campaign_id: CAMPAIGN_A,
    campaign_name: "Campaign A",
    ad_account_id: "act-1",
    currency: "USD",
    spend: 100,
    purchases: 4,
    ...overrides,
  };
}

function assemble(users: FbAuthoritativeUserRow[], metrics: FbCampaignMetricRow[]) {
  const visibleKeys = new Set(users.map((row) => fbCohortRowKey(row.cohort_date, row.funnel, row.campaign_path)));
  return assembleFbUserCosts(users, metrics, visibleKeys, {});
}

describe("Campaign-period SQL contract", () => {
  const params: Record<string, unknown> = {};
  const sql = fbCampaignMetricsSql({ campaignIds: null, dateFrom: DATE_A, dateTo: DATE_B, params });

  it("aggregates FB metrics only by Campaign ID", () => expect(sql).toContain("GROUP BY campaign_id"));
  it("does not group FB metrics by stat_date", () => expect(sql).not.toContain("GROUP BY stat_date"));
  it("does not emit fb_reporting_date as a join key", () => expect(sql).not.toContain("fb_reporting_date"));
  it("binds the selected period start", () => expect(params.fbu_metric_from).toBe(DATE_A));
  it("binds the selected period end", () => expect(params.fbu_metric_to).toBe(DATE_B));
  it("queries all FB Campaigns when diagnostics need FB-only campaigns", () => expect(sql).not.toContain("campaign_id) IN"));
  it("does not turn an all-Campaign query into an empty query", () => expect(sql).not.toContain("AND 0"));
  it("keeps an explicit Campaign filter in the POST SQL body", () => {
    const filtered = fbCampaignMetricsSql({ campaignIds: [CAMPAIGN_A], dateFrom: DATE_A, dateTo: DATE_B, params: {} });
    expect(filtered).toContain("campaign_id) IN (unhex(");
    expect(filtered).not.toContain(CAMPAIGN_A);
  });

  const groupSql = fbAuthoritativeUserGroupsSql({
    filters: NO_FILTERS,
    dateFrom: DATE_A,
    dateTo: DATE_B,
    visibleRows: [{ cohort_date: DATE_A, funnel: "soulmate", campaign_path: "path-a" }],
    params: {},
  });
  it("does not convert authoritative user dates through a Meta timezone", () => expect(groupSql).not.toContain("toTimeZone"));
  it("groups existing members by Cohort row and Campaign only", () => expect(groupSql).toContain("GROUP BY cohort_date, funnel, campaign_path, campaign_id"));
});

describe("Campaign-period allocation contract", () => {
  it("adds daily Spend before calculating Campaign CPP", () => {
    const result = assemble([user("u1")], [metric({ spend: 40, purchases: 2 }), metric({ fb_reporting_date: DATE_B, spend: 60, purchases: 3 })]);
    expect(result.validation[0].fb_spend).toBe(100);
  });

  it("adds daily Purchases before calculating Campaign CPP", () => {
    const result = assemble([user("u1")], [metric({ purchases: 2 }), metric({ fb_reporting_date: DATE_B, purchases: 3 })]);
    expect(result.validation[0].fb_purchases).toBe(5);
  });

  it("calculates one CPP from the whole selected Campaign period", () => {
    const result = assemble([user("u1")], [metric({ spend: 40, purchases: 2 }), metric({ fb_reporting_date: DATE_B, spend: 60, purchases: 3 })]);
    expect(result.validation[0].campaign_cpp).toBe(20);
  });

  it("assigns the same Campaign CPP across different Cohort dates", () => {
    const users = [user("u1"), user("u2", { cohort_date: DATE_B, trial_timestamp_utc: `${DATE_B}T00:00:01.000Z` })];
    expect(assemble(users, [metric()]).assignments.map((row) => row.fb_user_cpp)).toEqual([25, 25]);
  });

  it("sets row FB Purchases to authoritative Campaign users in that row", () => {
    const users = [user("u1"), user("u2")];
    const row = assemble(users, [metric()]).perRow[fbCohortRowKey(DATE_A, "soulmate", "path-a")];
    expect(row.fb_purchases).toBe(2);
  });

  it("allocates row Spend as Campaign CPP times row Campaign users", () => {
    const row = assemble([user("u1"), user("u2")], [metric()]).perRow[fbCohortRowKey(DATE_A, "soulmate", "path-a")];
    expect(row.fb_spend).toBe(50);
  });

  it("does not copy full Campaign Spend into each Cohort row", () => {
    const users = [user("u1"), user("u2", { cohort_date: DATE_B, campaign_path: "path-b" })];
    expect(Object.values(assemble(users, [metric()]).perRow).map((row) => row.fb_spend)).toEqual([25, 25]);
  });

  it("keeps row Spend sum equal to allocated total", () => {
    const users = [user("u1"), user("u2", { cohort_date: DATE_B, campaign_path: "path-b" })];
    const result = assemble(users, [metric()]);
    expect(Object.values(result.perRow).reduce((sum, row) => sum + (row.fb_spend ?? 0), 0)).toBe(result.totals.fb_spend);
  });

  it("does not round sub-cent shares before row aggregation", () => {
    const users = [user("u1"), user("u2", { campaign_path: "path-b" }), user("u3", { campaign_path: "path-c" })];
    const result = assemble(users, [metric({ spend: 1, purchases: 3 })]);
    expect(Object.values(result.perRow).map((row) => row.fb_spend)).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("reports a zero-purchase Campaign without division by zero", () => {
    const result = assemble([user("u1")], [metric({ purchases: 0 })]);
    expect(result.validation[0].campaign_cpp).toBeNull();
    expect(result.perRow[fbCohortRowKey(DATE_A, "soulmate", "path-a")].fb_spend).toBeNull();
  });

  it("does not require timezone evidence to allocate a Campaign", () => {
    expect(assemble([user("u1")], [metric({ reporting_timezones: null })]).totals.fb_spend).toBe(25);
  });

  it("keeps one assignment per authoritative user", () => {
    const users = [user("u1"), user("u2")];
    expect(assemble(users, [metric()]).assignments.map((row) => row.canonical_user_id)).toEqual(["u1", "u2"]);
  });

  it("rejects a duplicate authoritative user instead of double allocating", () => {
    expect(() => assemble([user("u1"), user("u1")], [metric()])).toThrow(/duplicate authoritative user/);
  });

  it("marks user Campaigns without selected-period FB metrics as unavailable", () => {
    const result = assemble([user("u1")], []);
    expect(result.validation[0].allocation_status).toBe("campaign_unmatched");
    expect(result.totals.fb_spend).toBeNull();
  });

  it("retains selected Campaign activity-period bounds in diagnostics", () => {
    const row = assemble([user("u1")], [metric(), metric({ fb_reporting_date: DATE_B })]).validation[0];
    expect(row).toMatchObject({ period_date_from: DATE_A, period_date_to: DATE_B, fb_reporting_date: null });
  });

  it("allocates overallocated Campaigns by the explicit CPP formula", () => {
    const result = assemble([user("u1"), user("u2")], [metric({ spend: 100, purchases: 1 })]);
    expect(result.totals.fb_spend).toBe(200);
  });

  it("exposes the overallocated reconciliation difference", () => {
    const row = assemble([user("u1"), user("u2")], [metric({ spend: 100, purchases: 1 })]).validation[0];
    expect(row).toMatchObject({ allocation_status: "overallocated", allocation_difference: 100, excess_authoritative_users: 1 });
  });
});

describe("FB-only and unallocated diagnostics", () => {
  const result = assemble(
    [user("u1")],
    [metric({ spend: 100, purchases: 2 }), metric({ campaign_id: CAMPAIGN_B, spend: 60, purchases: 3 })],
  );

  it("creates a validation row for an FB-only Campaign", () => expect(result.validation.some((row) => row.campaign_id === CAMPAIGN_B)).toBe(true));
  it("does not assign an FB-only Campaign to a random Cohort", () => expect(result.validation.find((row) => row.campaign_id === CAMPAIGN_B)?.allocated_spend).toBe(0));
  it("reports all FB-only Spend as unallocated", () => expect(result.validation.find((row) => row.campaign_id === CAMPAIGN_B)?.unallocated_spend).toBe(60));
  it("reports all FB-only Purchases as unallocated", () => expect(result.validation.find((row) => row.campaign_id === CAMPAIGN_B)?.unmatched_fb_purchases).toBe(3));
  it("reports total unallocated Spend across matched and FB-only Campaigns", () => expect(result.summary.fb_unallocated_spend).toBe(110));
  it("reports total unallocated Purchases across matched and FB-only Campaigns", () => expect(result.summary.fb_unallocated_purchases).toBe(4));
  it("keeps all Purchases unallocated when Campaign metrics are invalid", () => {
    const invalid = assemble([user("u1")], [metric(), metric({ ad_account_id: "act-2", clicks: 1 })]);
    expect(invalid.validation[0]).toMatchObject({ allocation_status: "invalid_metrics", unmatched_fb_purchases: 8 });
  });
  it("counts Campaign IDs without Cohorts users", () => expect(result.summary.fb_campaigns_without_cohort_users).toBe(1));
  it("reconciles allocated plus unallocated Spend to Facebook Analytics when not overallocated", () => {
    expect((result.totals.fb_spend ?? 0) + result.summary.fb_unallocated_spend).toBe(160);
  });
});
