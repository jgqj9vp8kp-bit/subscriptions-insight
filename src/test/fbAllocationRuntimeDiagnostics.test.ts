import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyEdgeBearerSession } from "../../supabase/functions/_shared/clickhouse/auth.ts";
import {
  FB_ALLOCATION_DIAGNOSTICS_MAX_PAGE_SIZE,
  buildFbAllocationDiagnostics,
  fbAllocationDiagnosticsFeatureEnabled,
  normalizeFbAllocationDiagnosticsRequest,
} from "../../supabase/functions/_shared/clickhouse/fbAllocationDiagnostics.ts";
import {
  assembleFbUserCosts,
  assertFbSnapshotUnique,
  fbAuthoritativeUsersSql,
  fbCohortRowKey,
  fbReportingDateFromUtc,
  type FbAuthoritativeUserRow,
  type FbCampaignMetricRow,
  type FbCampaignValidationRow,
  type FbMetaTimezoneConfig,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const DATE = "2026-07-14";
const CAMPAIGN = "120249115818080040";
const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

function user(index: number, overrides: Partial<FbAuthoritativeUserRow> = {}): FbAuthoritativeUserRow {
  return {
    canonical_user_id: `runtime-user-${index}`,
    cohort_date: DATE,
    trial_timestamp_utc: `${DATE}T12:00:00.000Z`,
    funnel: "soulmate",
    campaign_path: "runtime-path-a",
    campaign_id: CAMPAIGN,
    ...overrides,
  };
}

function metric(overrides: Partial<FbCampaignMetricRow> = {}): FbCampaignMetricRow {
  return {
    fb_reporting_date: DATE,
    campaign_id: CAMPAIGN,
    campaign_name: "Production-shaped Runtime Campaign",
    ad_account_id: "act-runtime",
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

function assemble(
  users: FbAuthoritativeUserRow[],
  metrics: FbCampaignMetricRow[],
  config: FbMetaTimezoneConfig = { defaultTimezone: "UTC" },
) {
  const visible = new Set(users.map((row) => fbCohortRowKey(row.cohort_date, row.funnel, row.campaign_path)));
  return assembleFbUserCosts(users, metrics, visible, config);
}

function diagnosticRow(index: number, overrides: Partial<FbCampaignValidationRow> = {}): FbCampaignValidationRow {
  const campaign = `120249115818${String(index).padStart(6, "0")}`;
  return {
    campaign_id: campaign,
    campaign_name: `Runtime Campaign ${String(index).padStart(3, "0")}`,
    ad_account_id: index % 2 ? "act-b" : "act-a",
    fb_reporting_date: null,
    period_date_from: DATE,
    period_date_to: DATE,
    meta_timezone: "UTC",
    timezone_source: "payload",
    fb_purchases: 1,
    matched_authoritative_users: 1,
    unmatched_authoritative_users: 0,
    unmatched_fb_purchases: 0,
    excess_authoritative_users: 0,
    coverage_rate: 100,
    campaign_cpp: 10,
    fb_spend: 10,
    allocated_spend: 10,
    unallocated_spend: 0,
    allocation_difference: 0,
    allocation_difference_percent: 0,
    allocation_status: "fully_allocated",
    visible_cohort_spend: 10,
    affected_cohort_rows: 1,
    affected_funnels: ["soulmate"],
    affected_campaign_paths: ["runtime-path-a"],
    ...overrides,
  };
}

describe("runtime diagnostics authentication and security", () => {
  const denied = async (authorization: string | null, message = "invalid") => verifyEdgeBearerSession({
    authorization,
    getUser: async () => ({ data: { user: null }, error: { message } }),
  });

  it("denies an anonymous request", async () => expect(await denied(null)).toMatchObject({ status: 401 }));
  it("denies a whitespace bearer token", async () => expect(await denied("Bearer   ")).toMatchObject({ status: 401 }));
  it("denies an invalid token", async () => expect(await denied("Bearer invalid-token")).toMatchObject({ status: 401 }));
  it("denies an expired token", async () => expect(await denied("Bearer expired-token", "JWT expired")).toMatchObject({ status: 401 }));
  it("does not treat the public anon key as a user session", async () => expect(await denied("Bearer public-anon-key")).toMatchObject({ status: 401 }));
  it("allows a valid authenticated user", async () => {
    const result = await verifyEdgeBearerSession({
      authorization: "Bearer user-jwt",
      getUser: async (token) => ({ data: { user: { id: token === "user-jwt" ? "user-1" : null, email: "owner@example.com" } }, error: null }),
    });
    expect(result).toMatchObject({ id: "user-1", email: "owner@example.com", token: "user-jwt" });
  });
  it.each(["true", "TRUE", "1", "yes", "on"])("enables diagnostics only for explicit flag %s", (value) => {
    expect(fbAllocationDiagnosticsFeatureEnabled(value)).toBe(true);
  });
  it.each([undefined, null, "", "false", "0", "off", "random"])("keeps diagnostics disabled for flag %s", (value) => {
    expect(fbAllocationDiagnosticsFeatureEnabled(value)).toBe(false);
  });
  it("drops arbitrary SQL from the allow-listed diagnostics request", () => {
    const normalized = normalizeFbAllocationDiagnosticsRequest({ filters: { campaign_name: "safe" }, sql: "DROP TABLE x" } as never);
    expect(normalized).not.toHaveProperty("sql");
    expect(normalized.filters.campaign_name).toBe("safe");
  });
  it("keeps malicious Campaign IDs out of SQL text", () => {
    const malicious = "x' OR 1=1 --";
    const params: Record<string, unknown> = {};
    const sql = fbAuthoritativeUsersSql({ filters: { ...NO_FILTERS, campaign_id: [malicious] }, dateFrom: null, dateTo: null, params });
    expect(sql).not.toContain(malicious);
    expect(Object.values(params)).not.toContain(malicious);
    expect(sql).toContain("unhex('7827204f5220313d31202d2d')");
  });
  it.each(["CLICKHOUSE_PASSWORD", "SUPABASE_SERVICE_ROLE_KEY", "CAPSULED_API_TOKEN", "FB_META_ACCOUNT_TIMEZONES_JSON"])("never serializes secret %s", (secret) => {
    const payload = JSON.stringify(buildFbAllocationDiagnostics([diagnosticRow(1)]));
    expect(payload).not.toContain(secret);
  });
  it("existing endpoint authenticates before reading diagnostics controls", () => {
    const source = readFileSync("supabase/functions/clickhouse-cohorts/index.ts", "utf8");
    expect(source.indexOf("const auth = await requireSupabaseUser(req)")).toBeLessThan(source.indexOf("request = (await parseJsonBody"));
    expect(source).toContain("FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED");
    expect(source).not.toMatch(/request\.(sql|query)/);
  });
});

describe("runtime allocation rows", () => {
  it("marks a fully allocated Campaign", () => expect(assemble([user(1)], [metric()]).validation[0].allocation_status).toBe("fully_allocated"));
  it("marks an underallocated Campaign", () => expect(assemble([user(1)], [metric({ purchases: 2 })]).validation[0].allocation_status).toBe("underallocated"));
  it("marks an overallocated Campaign", () => expect(assemble([user(1), user(2)], [metric()]).validation[0].allocation_status).toBe("overallocated"));
  it("marks a Campaign with no FB purchases", () => expect(assemble([user(1)], [metric({ purchases: 0 })]).validation[0].allocation_status).toBe("no_fb_purchases"));
  it("shows an FB Campaign with no matched users", () => expect(assemble([], [metric()]).validation[0].allocation_status).toBe("no_matched_users"));
  it("shows an authoritative Campaign key without FB metrics", () => expect(assemble([user(1)], []).validation[0].allocation_status).toBe("campaign_unmatched"));
  it.each([
    { spend: -1 },
    { spend: Number.NaN },
    { spend: Number.POSITIVE_INFINITY },
    { purchases: -1 },
    { purchases: 1.5 },
    { clicks: -1 },
  ])("marks impossible metric %# invalid", (overrides) => {
    expect(assemble([user(1)], [metric(overrides)]).validation[0].allocation_status).toBe("invalid_metrics");
  });
  it("allows zero Spend with a zero CPP", () => expect(assemble([user(1)], [metric({ spend: 0 })]).validation[0]).toMatchObject({ campaign_cpp: 0, allocated_spend: 0 }));
  it("handles very large Spend", () => expect(assemble([user(1)], [metric({ spend: 9_999_999.99 })]).validation[0].campaign_cpp).toBe(9_999_999.99));
  it("retains fractional Campaign CPP", () => expect(assemble([user(1)], [metric({ spend: 1, purchases: 3 })]).validation[0].campaign_cpp).toBeCloseTo(0.333333, 6));
  it("reports multiple affected Cohort rows", () => {
    const result = assemble([user(1), user(2, { funnel: "palmistry", campaign_path: "runtime-path-b" })], [metric({ purchases: 2 })]);
    expect(result.validation[0]).toMatchObject({ affected_cohort_rows: 2, affected_funnels: ["palmistry", "soulmate"] });
  });
  it("reports a shared Campaign across paths", () => {
    const result = assemble([user(1), user(2, { campaign_path: "runtime-path-b" })], [metric({ purchases: 2 })]);
    expect(result.validation[0].affected_campaign_paths).toEqual(["runtime-path-a", "runtime-path-b"]);
  });
  it("keeps row sums equal to allocated total", () => {
    const result = assemble([user(1), user(2, { campaign_path: "runtime-path-b" })], [metric({ purchases: 2 })]);
    expect(Object.values(result.perRow).reduce((sum, row) => sum + (row.fb_spend ?? 0), 0)).toBe(result.validation[0].allocated_spend);
  });
  it("reconciles allocated plus unallocated to FB Spend", () => {
    const row = assemble([user(1)], [metric({ spend: 100, purchases: 3 })]).validation[0];
    expect(row.allocated_spend + row.unallocated_spend).toBe(row.fb_spend);
    expect(row.allocation_difference).toBe(0);
  });
  it("allocates one Campaign CPP share to every overallocated authoritative user", () => {
    const result = assemble([user(1), user(2)], [metric()]);
    expect(result.validation[0]).toMatchObject({ allocation_status: "overallocated", allocated_spend: 200, visible_cohort_spend: 200, excess_authoritative_users: 1 });
    expect(result.totals.fb_spend).toBe(200);
  });
  it("calculates unmatched Facebook Purchases", () => expect(assemble([user(1)], [metric({ purchases: 4 })]).validation[0].unmatched_fb_purchases).toBe(3));
  it("exposes Campaign name and ad account", () => expect(assemble([user(1)], [metric()]).validation[0]).toMatchObject({ campaign_name: "Production-shaped Runtime Campaign", ad_account_id: "act-runtime" }));
  it("exposes all affected cohort dimensions without user IDs", () => {
    const row = assemble([user(1)], [metric()]).validation[0];
    expect(row).toMatchObject({ affected_cohort_rows: 1, affected_funnels: ["soulmate"], affected_campaign_paths: ["runtime-path-a"] });
    expect(JSON.stringify(row)).not.toContain("runtime-user-1");
  });
});

describe("runtime allocation timezone evidence", () => {
  it("labels payload timezone", () => expect(assemble([user(1)], [metric()]).validation[0].timezone_source).toBe("payload"));
  it("labels account-config timezone", () => {
    const row = assemble([user(1)], [metric({ reporting_timezones: null })], { accountTimezones: { "act-runtime": "UTC" } }).validation[0];
    expect(row).toMatchObject({ timezone_source: "account_config", meta_timezone: "UTC" });
  });
  it("labels default-config timezone", () => {
    const row = assemble([user(1)], [metric({ reporting_timezones: null })], { defaultTimezone: "UTC" }).validation[0];
    expect(row.timezone_source).toBe("default_config");
  });
  it("keeps missing timezone informational", () => expect(assemble([user(1)], [metric({ reporting_timezones: null })], {}).validation[0].allocation_status).toBe("fully_allocated"));
  it("keeps conflicting timezone informational", () => {
    const rows = [metric({ reporting_timezones: "UTC" }), metric({ reporting_timezones: "America/Los_Angeles" })];
    expect(assemble([user(1)], rows).validation[0].allocation_status).toBe("fully_allocated");
  });
  it("keeps invalid IANA timezone informational", () => expect(assemble([user(1)], [metric({ reporting_timezones: "UTC-7" })]).validation[0].allocation_status).toBe("fully_allocated"));
  it.each([
    ["2026-03-08T09:59:59Z", "America/Los_Angeles", "2026-03-08"],
    ["2026-03-08T10:00:00Z", "America/Los_Angeles", "2026-03-08"],
    ["2026-11-01T08:59:59Z", "America/Los_Angeles", "2026-11-01"],
    ["2026-11-01T09:00:00Z", "America/Los_Angeles", "2026-11-01"],
  ])("handles DST boundary %s", (timestamp, timezone, expected) => expect(fbReportingDateFromUtc(timestamp, timezone)).toBe(expected));
  it("moves a UTC date backward", () => expect(fbReportingDateFromUtc("2026-07-14T02:00:00Z", "America/Los_Angeles")).toBe("2026-07-13"));
  it("keeps the UTC date when appropriate", () => expect(fbReportingDateFromUtc("2026-07-14T12:00:00Z", "America/Los_Angeles")).toBe("2026-07-14"));
  it("does not consult browser timezone", () => {
    new Intl.DateTimeFormat().format(new Date("2026-07-14T02:00:00Z"));
    expect(fbReportingDateFromUtc("2026-07-14T02:00:00Z", "America/Los_Angeles")).toBe("2026-07-13");
  });
});

describe("runtime diagnostics limits and pagination", () => {
  it.each([0, 1, 37, 99])("returns all %d rows below the limit", (count) => expect(buildFbAllocationDiagnostics(Array.from({ length: count }, (_, i) => diagnosticRow(i))).rows).toHaveLength(count));
  it("returns exactly 100 rows at the limit", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 100 }, (_, i) => diagnosticRow(i))).rows).toHaveLength(100));
  it("returns only 100 display rows above the limit", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 150 }, (_, i) => diagnosticRow(i))).rows).toHaveLength(100));
  it("computes summary before the display limit", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 150 }, (_, i) => diagnosticRow(i))).summary.total_fb_spend).toBe(1_500));
  it("returns page 1", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 150 }, (_, i) => diagnosticRow(i)), { page: 1 }).rows[0].campaign_id).toBe(diagnosticRow(0).campaign_id));
  it("returns page 2", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 150 }, (_, i) => diagnosticRow(i)), { page: 2 }).rows).toHaveLength(50));
  it("sorts pages stably", () => {
    const page = buildFbAllocationDiagnostics([diagnosticRow(2), diagnosticRow(0), diagnosticRow(1)]);
    expect(page.rows.map((row) => row.campaign_id)).toEqual([diagnosticRow(0).campaign_id, diagnosticRow(1).campaign_id, diagnosticRow(2).campaign_id]);
  });
  it("does not duplicate rows across pages", () => {
    const rows = Array.from({ length: 150 }, (_, i) => diagnosticRow(i));
    const first = buildFbAllocationDiagnostics(rows, { page: 1 });
    const second = buildFbAllocationDiagnostics(rows, { page: 2 });
    expect(new Set([...first.rows, ...second.rows].map((row) => row.campaign_id)).size).toBe(150);
  });
  it("applies filters before pagination", () => {
    const rows = Array.from({ length: 150 }, (_, i) => diagnosticRow(i, { ad_account_id: i < 120 ? "act-a" : "act-b" }));
    const result = buildFbAllocationDiagnostics(rows, { page: 2, filters: { ad_account_id: "act-a" } });
    expect(result).toMatchObject({ total_rows: 120, page: 2 });
    expect(result.rows).toHaveLength(20);
  });
  it("reports the accurate total count", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 123 }, (_, i) => diagnosticRow(i))).total_rows).toBe(123));
  it("caps requested page size at 100", () => expect(normalizeFbAllocationDiagnosticsRequest({ page_size: 10_000 }).page_size).toBe(FB_ALLOCATION_DIAGNOSTICS_MAX_PAGE_SIZE));
  it("supports a smaller page size", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 20 }, (_, i) => diagnosticRow(i)), { page_size: 7 }).rows).toHaveLength(7));
  it("returns an empty page beyond the end without corrupting totals", () => {
    const result = buildFbAllocationDiagnostics(Array.from({ length: 20 }, (_, i) => diagnosticRow(i)), { page: 99 });
    expect(result.rows).toHaveLength(0);
    expect(result.summary.total_fb_spend).toBe(200);
  });
  it("shows the explicit first-100 completeness message", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 101 }, (_, i) => diagnosticRow(i))).display_message).toBe("Показаны первые 100 из 101 Campaign rows"));
  it("reports page navigation metadata", () => expect(buildFbAllocationDiagnostics(Array.from({ length: 250 }, (_, i) => diagnosticRow(i)), { page: 2 })).toMatchObject({ total_pages: 3, has_previous_page: true, has_next_page: true, summary_computed_before_pagination: true }));
});

describe("runtime diagnostics filters", () => {
  const rows = [
    diagnosticRow(1, { period_date_from: "2026-07-13", period_date_to: "2026-07-13", campaign_name: "Alpha Prospecting", ad_account_id: "act-a", allocation_status: "underallocated", timezone_source: "account_config" }),
    diagnosticRow(2, { period_date_from: "2026-07-14", period_date_to: "2026-07-14", campaign_name: "Beta Retargeting", ad_account_id: "act-b", allocation_status: "fully_allocated", timezone_source: "payload" }),
    diagnosticRow(3, { period_date_from: "2026-07-15", period_date_to: "2026-07-15", campaign_name: "Gamma Prospecting", ad_account_id: "act-a", allocation_status: "overallocated", timezone_source: "default_config" }),
  ];
  it("filters date from by Campaign activity overlap", () => expect(buildFbAllocationDiagnostics(rows, { filters: { date_from: "2026-07-14" } }).total_rows).toBe(2));
  it("filters date to by Campaign activity overlap", () => expect(buildFbAllocationDiagnostics(rows, { filters: { date_to: "2026-07-14" } }).total_rows).toBe(2));
  it("filters exact Campaign ID", () => expect(buildFbAllocationDiagnostics(rows, { filters: { campaign_id: rows[1].campaign_id } }).rows[0].campaign_id).toBe(rows[1].campaign_id));
  it("filters Campaign name case-insensitively", () => expect(buildFbAllocationDiagnostics(rows, { filters: { campaign_name: "PROSPECTING" } }).total_rows).toBe(2));
  it("filters ad account", () => expect(buildFbAllocationDiagnostics(rows, { filters: { ad_account_id: "act-b" } }).total_rows).toBe(1));
  it("filters allocation status", () => expect(buildFbAllocationDiagnostics(rows, { filters: { allocation_status: "overallocated" } }).rows[0].allocation_status).toBe("overallocated"));
  it("filters timezone source", () => expect(buildFbAllocationDiagnostics(rows, { filters: { timezone_source: "payload" } }).total_rows).toBe(1));
  it("combines filters", () => expect(buildFbAllocationDiagnostics(rows, { filters: { date_from: "2026-07-14", ad_account_id: "act-a", campaign_name: "gamma" } }).total_rows).toBe(1));
  it("returns an empty result", () => expect(buildFbAllocationDiagnostics(rows, { filters: { campaign_id: "missing" } })).toMatchObject({ total_rows: 0, rows: [] }));
  it("labels date semantics explicitly", () => expect(buildFbAllocationDiagnostics(rows).date_filter_semantics).toBe("campaign_activity_period_overlap"));
});

describe("runtime diagnostics regression invariants", () => {
  it("does not change existing user_cpp", () => expect(assemble([user(1)], [metric()]).assignments[0].fb_user_cpp).toBe(100));
  it("does not change existing Cohort Spend", () => expect(assemble([user(1)], [metric()]).totals.fb_spend).toBe(100));
  it("keeps shared Campaign Spend user-first", () => expect(assemble([user(1), user(2, { campaign_path: "runtime-path-b" })], [metric({ purchases: 2 })]).totals.fb_spend).toBe(100));
  it("keeps overallocated assignment explicit and allocated", () => expect(assemble([user(1), user(2)], [metric()]).assignments.every((row) => row.fb_user_cpp === 100)).toBe(true));
  it("keeps the snapshot uniqueness invariant", () => expect(() => assertFbSnapshotUnique({ snapshot_rows: 2, snapshot_unique_users: 1, snapshot_duplicate_users: 1 })).toThrow(/not unique/));
  it("keeps valid snapshots accepted", () => expect(assertFbSnapshotUnique({ snapshot_rows: 2, snapshot_unique_users: 2, snapshot_duplicate_users: 0 }).duplicateUsers).toBe(0));
  it("does not modify the FB Analytics page implementation", () => {
    const diff = readFileSync("src/pages/FBAnalytics.tsx", "utf8");
    expect(diff).not.toContain("fb_allocation_diagnostics");
  });
  it("reconciles visible Cohort Spend with allocated Spend", () => {
    const page = buildFbAllocationDiagnostics(assemble([user(1)], [metric()]).validation);
    expect(page.summary).toMatchObject({ visible_allocated_difference: 0, visible_spend_reconciles: true });
  });
  it("keeps sub-cent allocations unrounded until display", () => {
    const result = assemble([
      user(1),
      user(2, { campaign_path: "runtime-path-b" }),
      user(3, { campaign_path: "runtime-path-c" }),
    ], [metric({ spend: 1, purchases: 3 })]);
    expect(Object.values(result.perRow).map((row) => row.fb_spend)).toEqual([1 / 3, 1 / 3, 1 / 3]);
    const page = buildFbAllocationDiagnostics(result.validation);
    expect(page.summary).toMatchObject({
      total_allocated_spend: 1,
      sum_visible_cohort_spend: 1,
      visible_allocated_difference: 0,
      visible_spend_reconciles: true,
    });
  });
});
