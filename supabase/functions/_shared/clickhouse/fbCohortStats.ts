// FB Analytics → Cohorts, user-first cost architecture.
//
// Source grains stay separate:
//   fact_user_cohorts: one authoritative row per canonical_user_id
//   fact_facebook_stats: Campaign ID aggregated over the selected report period
//
// A Campaign CPP (Spend / FB Purchases) is assigned to each authoritative user
// whose authoritative Campaign ID matches. Cohort rows and totals are calculated
// only from those users: allocated Spend = Campaign CPP * authoritative users.
// Cohort membership and first-touch attribution never change here.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_FACEBOOK_STATS_TABLE, FACT_USER_COHORTS_TABLE } from "./schema.ts";
import { getFbSyncState, fbWarehouseVersionFromState } from "./facebookStats.ts";
import type { CohortFilters } from "./cohortContract.ts";
import {
  buildFbSourceReconciliation,
  CONFIRMED_FB_CAMPAIGN_ALIAS_IDS,
  type FbSourceCounts,
} from "./fbSourceClassification.ts";
import {
  buildFbAllocationDiagnostics,
  type FbAllocationDiagnosticsPage,
  type FbAllocationDiagnosticsRequest,
} from "./fbAllocationDiagnostics.ts";

const FB = FACT_FACEBOOK_STATS_TABLE;
const FC = FACT_USER_COHORTS_TABLE;
const AT = ANALYTICS_TRANSACTIONS_TABLE;

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const s = (value: unknown): string => typeof value === "string" ? value : value == null ? "" : String(value);
const round2 = (value: number): number => Math.round(value * 100) / 100;

export function normalizeFbCampaignId(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

export function normalizeAuthoritativeCampaignId(value: unknown): string {
  const campaignId = normalizeFbCampaignId(value);
  return !campaignId || ["unknown", "null", "n/a", "none"].includes(campaignId.toLowerCase()) ? "" : campaignId;
}

export function fbCohortRowKey(cohortDate: string, funnel: string, campaignPath: string): string {
  return `${cohortDate}|${funnel}|${campaignPath}`;
}

export type FbDataStatus = "ready" | "empty_source" | "stale" | "unavailable" | "sync_pending";
export type FbCohortErrorCode = "FB_SNAPSHOT_NOT_UNIQUE" | "FB_ALLOCATION_UNAVAILABLE";
export type FbMatchStatus =
  | "matched"
  | "partial_coverage"
  | "missing_cohort_campaign_id"
  | "no_fb_campaign"
  | "no_fb_purchases"
  | "timezone_unverified"
  | "overallocated"
  | "mixed_currency"
  | "invalid_campaign_metric";
export type FbAllocationStatus =
  | "fully_allocated"
  | "underallocated"
  | "overallocated"
  | "no_fb_purchases"
  | "no_matched_users"
  | "campaign_unmatched"
  | "timezone_unverified"
  | "invalid_timezone"
  | "invalid_metrics";
export type FbTimezoneSource = "payload" | "account_config" | "default_config" | "unverified";

export interface FbAdditive {
  fb_spend: number;
  fb_purchases: number;
  fb_impressions: number;
  fb_reach: number;
  fb_clicks: number;
  fb_link_clicks: number;
  fb_purchase_value: number;
}

export interface FbDerived {
  fb_cpp: number | null;
  fb_cpc: number | null;
  fb_cpm: number | null;
  fb_ctr: number | null;
  fb_roas: number | null;
}

export function deriveFbRatios(additive: FbAdditive): FbDerived {
  return {
    fb_cpp: additive.fb_purchases > 0 ? round2(additive.fb_spend / additive.fb_purchases) : null,
    fb_cpc: additive.fb_clicks > 0 ? round2(additive.fb_spend / additive.fb_clicks) : null,
    fb_cpm: additive.fb_impressions > 0 ? round2((additive.fb_spend / additive.fb_impressions) * 1000) : null,
    fb_ctr: additive.fb_impressions > 0 ? round2((additive.fb_clicks / additive.fb_impressions) * 100) : null,
    fb_roas: additive.fb_spend > 0 && additive.fb_purchase_value > 0 ? round2(additive.fb_purchase_value / additive.fb_spend) : null,
  };
}

export interface FbMetaTimezoneConfig {
  defaultTimezone?: string | null;
  accountTimezones?: Record<string, string>;
}

const reportingDateFormatters = new Map<string, Intl.DateTimeFormat>();
const timezoneValidity = new Map<string, boolean>();

export function isValidIanaTimezone(timezone: string | null | undefined): boolean {
  if (!timezone) return false;
  const cached = timezoneValidity.get(timezone);
  if (cached != null) return cached;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
    timezoneValidity.set(timezone, true);
    return true;
  } catch {
    timezoneValidity.set(timezone, false);
    return false;
  }
}

/** Convert a UTC first-trial timestamp to the Meta ad-account reporting date. */
export function fbReportingDateFromUtc(timestampUtc: string, timezone: string): string | null {
  if (!isValidIanaTimezone(timezone)) return null;
  const timestamp = new Date(timestampUtc);
  if (!Number.isFinite(timestamp.getTime())) return null;
  let formatter = reportingDateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    reportingDateFormatters.set(timezone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return value.year && value.month && value.day ? `${value.year}-${value.month}-${value.day}` : null;
}

function runtimeTimezoneConfig(): FbMetaTimezoneConfig {
  const runtime = globalThis as typeof globalThis & {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  };
  const get = runtime.Deno?.env?.get;
  const defaultTimezone = get?.("FB_META_DEFAULT_TIMEZONE") ?? null;
  const rawAccounts = get?.("FB_META_ACCOUNT_TIMEZONES_JSON") ?? "";
  let accountTimezones: Record<string, string> = {};
  if (rawAccounts) {
    try {
      const parsed = JSON.parse(rawAccounts);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        accountTimezones = Object.fromEntries(
          Object.entries(parsed).filter(([accountId, timezone]) => accountId.trim() && typeof timezone === "string"),
        ) as Record<string, string>;
      }
    } catch {
      accountTimezones = {};
    }
  }
  return { defaultTimezone, accountTimezones };
}

export interface FbAuthoritativeUserRow {
  canonical_user_id: string;
  cohort_date: string;
  trial_timestamp_utc: string;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  /** Aggregated production rows carry a count; fixture/user rows default to 1. */
  authoritative_user_count?: number;
  /** Precomputed in ClickHouse for the resolved Meta timezone. */
  precomputed_fb_reporting_date?: string | null;
  precomputed_fb_timezone?: string | null;
  precomputed_fb_timezone_source?: FbTimezoneSource;
  precomputed_fb_timezone_invalid?: boolean;
}

export interface FbVisibleCohortRow {
  cohort_date: string;
  funnel: string;
  campaign_path: string;
}

export interface FbAuthoritativeCampaignScopeRow {
  campaign_id: string;
  authoritative_users: number;
  utc_date_from: string | null;
  utc_date_to: string | null;
}

export interface FbCampaignMetricRow {
  /** Optional on fixture/raw components; production SQL returns period bounds. */
  fb_reporting_date?: string | null;
  period_date_from?: string | null;
  period_date_to?: string | null;
  campaign_id: string;
  campaign_name?: string | null;
  ad_account_id?: string;
  currency?: string | null;
  reporting_timezones?: string | string[] | null;
  spend?: unknown;
  purchases?: unknown;
  impressions?: unknown;
  clicks?: unknown;
  link_clicks?: unknown;
  reach?: unknown;
  purchase_value?: unknown;
  invalid_metric_rows?: unknown;
  ad_account_count?: unknown;
  currency_count?: unknown;
}

export interface FbCampaignMetric extends FbAdditive, FbDerived {
  campaign_id: string;
  campaign_name: string | null;
  fb_reporting_date: null;
  period_date_from: string | null;
  period_date_to: string | null;
  ad_account_id: string | null;
  fb_timezone: string | null;
  fb_timezone_source: FbTimezoneSource;
  fb_timezone_invalid: boolean;
  fb_currency: string | null;
  valid: boolean;
  invalid_metrics: boolean;
}

export interface FbUserCostAssignment {
  canonical_user_id: string;
  cohort_date: string;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  trial_timestamp_utc: string;
  fb_reporting_date: string | null;
  fb_campaign_cpp: number | null;
  fb_user_cpp: number | null;
  fb_timezone: string | null;
  allocation_status: FbAllocationStatus;
  authoritative_user_count?: number;
}

export interface FbCampaignValidationRow {
  campaign_id: string;
  campaign_name: string | null;
  ad_account_id: string | null;
  fb_reporting_date: string | null;
  period_date_from: string | null;
  period_date_to: string | null;
  meta_timezone: string | null;
  timezone_source: FbTimezoneSource;
  fb_purchases: number;
  matched_authoritative_users: number;
  unmatched_authoritative_users: number;
  unmatched_fb_purchases: number;
  excess_authoritative_users: number;
  coverage_rate: number | null;
  campaign_cpp: number | null;
  fb_spend: number;
  allocated_spend: number;
  unallocated_spend: number;
  allocation_difference: number;
  allocation_difference_percent: number | null;
  allocation_status: FbAllocationStatus;
  visible_cohort_spend: number;
  affected_cohort_rows: number;
  affected_funnels: string[];
  affected_campaign_paths: string[];
}

export interface FbCohortRowStats {
  fb_spend: number | null;
  fb_currency: string | null;
  /** One FB Purchase per matched authoritative trial user. */
  fb_purchases: number | null;
  /** User-first row cost: SUM(user_cpp) / matched FB users in the row. */
  fb_cpp: number | null;
  fb_impressions: null;
  fb_reach: null;
  fb_clicks: null;
  fb_link_clicks: null;
  fb_ctr: null;
  fb_cpc: null;
  fb_cpm: null;
  fb_purchase_value: null;
  fb_roas: null;
  fb_campaigns_matched: number;
  fb_match_status: FbMatchStatus;
  fb_reporting_date: string | null;
  fb_campaign_cpp: number | null;
  fb_user_cpp: number | null;
  fb_matched_users: number;
  fb_unmatched_users: number;
  fb_campaign_coverage: number | null;
  fb_cpp_source: "campaign_spend_div_fb_purchases";
  fb_timezone: string | null;
  coverage_rate: number | null;
}

export interface FbCohortTotals extends Omit<FbCohortRowStats, "fb_match_status"> {
  fb_campaign_day_pairs: number;
  fb_reach_total_available: false;
}

export interface FbSnapshotUniqueness {
  rows: number;
  uniqueUsers: number;
  duplicateUsers: number;
}

export interface FbSourceScopedDiagnostics {
  fb_source_classification: "authoritative_trial_source_v1";
  fb_all_cohorts_users: number;
  fb_facebook_qualified_users: number;
  fb_tiktok_users: number;
  fb_google_users: number;
  fb_organic_users: number;
  fb_direct_users: number;
  fb_unknown_source_users: number;
  fb_other_source_users: number;
  fb_analytics_purchases: number;
  fb_allocated_purchases: number;
  /** FB Analytics Purchases - Allocated FB Purchases. */
  fb_allocation_gap_purchases: number;
  /** Allocated FB Purchases / FB Analytics Purchases, expressed as percent. */
  fb_allocation_coverage: number | null;
  /** All Cohorts Users - FB Analytics Purchases; source mix, not an allocation error. */
  fb_source_mix_difference: number;
  /** Facebook-qualified Users - FB Analytics Purchases. */
  fb_meta_authoritative_difference: number;
}

export interface FbCohortDiagnostics extends FbSourceScopedDiagnostics {
  fb_data_status: FbDataStatus;
  fb_error_code: FbCohortErrorCode | null;
  fb_error_message_safe: string | null;
  fb_source_rows: number;
  fb_campaign_day_rows: number;
  fb_last_sync_at: string | null;
  fb_warehouse_version: string | null;
  fb_attribution_source: "fact_user_cohorts";
  fb_join_key: "campaign_id";
  fb_cpp_source: "campaign_spend_div_fb_purchases";
  fb_reporting_date: string | null;
  fb_campaign_cpp: number | null;
  fb_user_cpp: number | null;
  fb_matched_users: number;
  fb_unmatched_users: number;
  fb_campaign_coverage: number | null;
  fb_timezone: string | null;
  coverage_rate: number | null;
  fb_users_in_cohorts: number;
  fb_campaigns_in_scope: number;
  fb_campaign_keys_in_scope: number;
  fb_allocated_spend: number;
  fb_unallocated_spend: number;
  /** Net period gap. Campaign-level gross unmatched Purchases stay separate. */
  fb_unallocated_purchases: number;
  fb_gross_unmatched_purchases: number;
  fb_campaigns_without_cohort_users: number;
  fb_period_date_from: string | null;
  fb_period_date_to: string | null;
  fb_overallocated_campaigns: number;
  fb_underallocated_campaigns: number;
  fb_zero_purchase_campaigns: number;
  fb_timezone_unverified_users: number;
  fb_snapshot_rows: number;
  fb_snapshot_unique_users: number;
  fb_snapshot_duplicate_users: number;
  fb_snapshot_unique: boolean;
  fb_validation_rows: number;
  fb_allocation_diagnostics_enabled: boolean;
}

export interface FbCohortStatsBundle {
  perRow: Record<string, FbCohortRowStats>;
  totals: FbCohortTotals;
  diagnostics: FbCohortDiagnostics;
  allocationDiagnostics: FbAllocationDiagnosticsPage | null;
}

export function unavailableFbCohortStats(error: unknown, allocationDiagnosticsEnabled = false): FbCohortStatsBundle {
  const snapshotNotUnique = error instanceof Error && /snapshot is not unique|duplicate authoritative user/i.test(error.message);
  const errorCode: FbCohortErrorCode = snapshotNotUnique ? "FB_SNAPSHOT_NOT_UNIQUE" : "FB_ALLOCATION_UNAVAILABLE";
  const totals: FbCohortTotals = {
    fb_spend: null, fb_currency: null, fb_purchases: null, fb_cpp: null,
    fb_impressions: null, fb_reach: null, fb_clicks: null, fb_link_clicks: null,
    fb_ctr: null, fb_cpc: null, fb_cpm: null, fb_purchase_value: null, fb_roas: null,
    fb_campaigns_matched: 0, fb_reporting_date: null, fb_campaign_cpp: null, fb_user_cpp: null,
    fb_matched_users: 0, fb_unmatched_users: 0, fb_campaign_coverage: null,
    fb_cpp_source: "campaign_spend_div_fb_purchases", fb_timezone: null, coverage_rate: null,
    fb_campaign_day_pairs: 0, fb_reach_total_available: false,
  };
  return {
    perRow: {},
    totals,
    allocationDiagnostics: null,
    diagnostics: {
      fb_data_status: "unavailable",
      fb_error_code: errorCode,
      fb_error_message_safe: snapshotNotUnique
        ? "FB allocation is unavailable because the active cohort snapshot is not unique by canonical user."
        : "FB allocation is temporarily unavailable. Cohorts data is still available; retry after checking the Facebook warehouse.",
      fb_source_rows: 0, fb_campaign_day_rows: 0, fb_last_sync_at: null, fb_warehouse_version: null,
      fb_attribution_source: "fact_user_cohorts", fb_join_key: "campaign_id",
      fb_cpp_source: "campaign_spend_div_fb_purchases", fb_reporting_date: null, fb_campaign_cpp: null,
      fb_user_cpp: null, fb_matched_users: 0, fb_unmatched_users: 0, fb_campaign_coverage: null,
      fb_timezone: null, coverage_rate: null, fb_users_in_cohorts: 0, fb_campaigns_in_scope: 0,
      fb_campaign_keys_in_scope: 0, fb_allocated_spend: 0, fb_unallocated_spend: 0,
      fb_unallocated_purchases: 0, fb_gross_unmatched_purchases: 0, fb_campaigns_without_cohort_users: 0,
      fb_period_date_from: null, fb_period_date_to: null,
      fb_overallocated_campaigns: 0, fb_underallocated_campaigns: 0, fb_zero_purchase_campaigns: 0,
      fb_timezone_unverified_users: 0, fb_snapshot_rows: 0, fb_snapshot_unique_users: 0,
      fb_snapshot_duplicate_users: 0, fb_snapshot_unique: false, fb_validation_rows: 0,
      fb_allocation_diagnostics_enabled: allocationDiagnosticsEnabled,
      fb_source_classification: "authoritative_trial_source_v1",
      fb_all_cohorts_users: 0, fb_facebook_qualified_users: 0, fb_tiktok_users: 0,
      fb_google_users: 0, fb_organic_users: 0, fb_direct_users: 0,
      fb_unknown_source_users: 0, fb_other_source_users: 0,
      fb_analytics_purchases: 0, fb_allocated_purchases: 0,
      fb_allocation_gap_purchases: 0, fb_allocation_coverage: null,
      fb_source_mix_difference: 0, fb_meta_authoritative_difference: 0,
    },
  };
}

function inClause(column: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const placeholders = values.map((value, index) => {
    const key = `p_fbu_${prefix}_${index}`;
    params[key] = value;
    return `{${key}:String}`;
  });
  return ` AND ${column} IN (${placeholders.join(", ")})`;
}

function clickHouseHexString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SQL-body literal: hex contains no executable characters and never enters the URL. */
export function clickHouseBodyString(value: string): string {
  return `unhex('${clickHouseHexString(value)}')`;
}

export function clickHouseBodyStringSet(values: string[]): string {
  const unique = [...new Set(values)].sort();
  return unique.length ? `(${unique.map(clickHouseBodyString).join(", ")})` : "(unhex(''))";
}

function visibleRowsClause(visibleRows: FbVisibleCohortRow[]): string {
  if (!visibleRows.length) return " AND 0";
  const tuples = visibleRows.map((row) => `(${clickHouseBodyString(row.cohort_date)}, ${clickHouseBodyString(row.funnel)}, ${clickHouseBodyString(row.campaign_path)})`);
  return ` AND (toString(cohort_date), funnel, campaign_path) IN (${tuples.join(", ")})`;
}

function authoritativeScopeWhere(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  visibleRows: FbVisibleCohortRow[];
  params: Record<string, unknown>;
  prefix: string;
}): string {
  const { filters, params, prefix } = input;
  let where = `auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}`;
  if (input.dateFrom) { const key = `${prefix}_date_from`; params[key] = input.dateFrom; where += ` AND toString(cohort_date) >= {${key}:String}`; }
  if (input.dateTo) { const key = `${prefix}_date_to`; params[key] = input.dateTo; where += ` AND toString(cohort_date) <= {${key}:String}`; }
  where += inClause("funnel", filters.funnel, `${prefix}_fn`, params);
  where += inClause("campaign_path", filters.campaign_path, `${prefix}_cp`, params);
  if (filters.campaign_id.length) {
    where += ` AND ${authoritativeCampaignExpr()} IN ${clickHouseBodyStringSet(filters.campaign_id)}`;
  }
  where += inClause("traffic_source", filters.traffic_source, `${prefix}_tsrc`, params);
  where += inClause("media_buyer", filters.media_buyer, `${prefix}_mb`, params);
  where += inClause("country", filters.country, `${prefix}_geo`, params);
  where += inClause("card_type", filters.card_type, `${prefix}_card`, params);
  where += inClause("currency", filters.currency, `${prefix}_cur`, params);
  where += inClause("price_plan", filters.price_plan, `${prefix}_plan`, params);
  return where + visibleRowsClause(input.visibleRows);
}

// The source column MUST stay qualified (fc.campaign_id / f.campaign_id).
// Every caller aliases the result back to `campaign_id`, and ClickHouse
// substitutes a SELECT alias into any bare identifier of the same name —
// including the one inside this very expression — which raises
// "Cyclic aliases" and killed the whole FB allocation bundle (found
// 2026-07-24: fb_data_status was permanently "unavailable"). Qualifying the
// reference resolves it to the column and breaks the cycle while keeping the
// output column name that every consumer reads.
function authoritativeCampaignExpr(column = "fc.campaign_id"): string {
  return `if(lowerUTF8(trim(BOTH ' ' FROM ${column})) IN ('', 'unknown', 'null', 'n/a', 'none'), '', trim(BOTH ' ' FROM ${column}))`;
}

/** Stage 1: authoritative user rows. No Campaign Spend join exists here. */
export function fbAuthoritativeUsersSql(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  params: Record<string, unknown>;
}): string {
  const { filters, params } = input;
  let where = `auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}`;
  if (input.dateFrom) { params.fbu_date_from = input.dateFrom; where += ` AND toString(cohort_date) >= {fbu_date_from:String}`; }
  if (input.dateTo) { params.fbu_date_to = input.dateTo; where += ` AND toString(cohort_date) <= {fbu_date_to:String}`; }
  where += inClause("funnel", filters.funnel, "fn", params);
  where += inClause("campaign_path", filters.campaign_path, "cp", params);
  if (filters.campaign_id.length) {
    where += ` AND ${authoritativeCampaignExpr()} IN ${clickHouseBodyStringSet(filters.campaign_id)}`;
  }
  where += inClause("traffic_source", filters.traffic_source, "tsrc", params);
  where += inClause("media_buyer", filters.media_buyer, "mb", params);
  where += inClause("country", filters.country, "geo", params);
  where += inClause("card_type", filters.card_type, "card", params);
  where += inClause("currency", filters.currency, "cur", params);
  where += inClause("price_plan", filters.price_plan, "plan", params);
  return `SELECT canonical_user_id,
    toString(cohort_date) cohort_date,
    concat(replaceOne(toString(trial_event_time), ' ', 'T'), 'Z') trial_timestamp_utc,
    funnel,
    campaign_path,
    ${authoritativeCampaignExpr()} campaign_id
  FROM ${FC} AS fc FINAL
  WHERE ${where}
  FORMAT JSONEachRow`;
}

/** Production stage 1: Campaign scope only; never returns one row per user. */
export function fbAuthoritativeCampaignScopeSql(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  visibleRows: FbVisibleCohortRow[];
  params: Record<string, unknown>;
}): string {
  const where = authoritativeScopeWhere({ ...input, prefix: "fbscope" });
  const campaign = authoritativeCampaignExpr();
  return `SELECT ${campaign} campaign_id,
    count() authoritative_users,
    toString(min(toDate(trial_event_time))) utc_date_from,
    toString(max(toDate(trial_event_time))) utc_date_to
  FROM ${FC} AS fc FINAL
  WHERE ${where}
  GROUP BY ${campaign}
  FORMAT JSONEachRow`;
}

/** Production stage 3: one count at the existing Cohort-row/Campaign grain. */
export function fbAuthoritativeUserGroupsSql(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  visibleRows: FbVisibleCohortRow[];
  params: Record<string, unknown>;
}): string {
  const where = authoritativeScopeWhere({ ...input, prefix: "fbgroup" });
  const campaign = authoritativeCampaignExpr();
  return `SELECT toString(cohort_date) cohort_date,
    funnel,
    campaign_path,
    ${campaign} campaign_id,
    count() authoritative_user_count
  FROM ${FC} AS fc FINAL
  WHERE ${where}
  GROUP BY cohort_date, funnel, campaign_path, campaign_id
  FORMAT JSONEachRow`;
}

function reportingTimezoneExpr(prefix = ""): string {
  return `coalesce(
    nullIf(JSONExtractString(${prefix}raw_payload, 'accountTimezone'), ''),
    nullIf(JSONExtractString(${prefix}raw_payload, 'account_timezone'), ''),
    nullIf(JSONExtractString(${prefix}raw_payload, 'adAccountTimezone'), ''),
    nullIf(JSONExtractString(${prefix}raw_payload, 'timezoneName'), ''),
    nullIf(JSONExtractString(${prefix}raw_payload, 'timezone'), ''),
    ''
  )`;
}

/** Stage 2: one Campaign Metrics row per Campaign ID for the selected period. */
export function fbCampaignMetricsSql(input: {
  /** null means all FB campaigns (needed to report FB-only/unallocated metrics). */
  campaignIds: string[] | null;
  dateFrom: string | null;
  dateTo: string | null;
  params: Record<string, unknown>;
}): string {
  const campaignIds = input.campaignIds == null
    ? null
    : [...new Set(input.campaignIds.map(normalizeAuthoritativeCampaignId).filter(Boolean))].sort();
  // f.campaign_id stays qualified everywhere: the SELECT below aliases the
  // trimmed value back to `campaign_id`, and a bare identifier would resolve to
  // that alias (Cyclic aliases) instead of the column.
  let where = `f.auth_user_id = {auth_user_id:String} AND f.level = 'campaign'
    AND trim(BOTH ' ' FROM f.campaign_id) != ''`;
  // Generated Campaign scope can contain thousands of IDs. Keep it in the POST
  // SQL body (hex literals), never as one URL query parameter per Campaign.
  if (campaignIds != null) {
    where += campaignIds.length ? ` AND trim(BOTH ' ' FROM f.campaign_id) IN ${clickHouseBodyStringSet(campaignIds)}` : " AND 0";
  }
  if (input.dateFrom) { input.params.fbu_metric_from = input.dateFrom; where += ` AND toString(f.stat_date) >= {fbu_metric_from:String}`; }
  if (input.dateTo) { input.params.fbu_metric_to = input.dateTo; where += ` AND toString(f.stat_date) <= {fbu_metric_to:String}`; }
  // EVERY source column here stays qualified with f. Each aggregate is aliased
  // back to its own column name (spend -> spend, ad_account_id -> ad_account_id,
  // …) and ClickHouse substitutes a SELECT alias into sibling expressions that
  // use the bare identifier. Unqualified, `uniqExact(ad_account_id)` became
  // uniqExact(if(uniqExact(...))) -> "Aggregate function ... is found inside
  // another aggregate function" (Code 184), which failed the whole FB bundle and
  // blanked every Spend (FB) cell. Same trap as cohorts' price_breakdown.
  return `SELECT trim(BOTH ' ' FROM f.campaign_id) campaign_id,
    argMax(f.campaign_name, f.source_updated_at) campaign_name,
    if(uniqExact(f.ad_account_id) = 1, any(f.ad_account_id), '') ad_account_id,
    if(uniqExact(f.currency) = 1, any(f.currency), '') currency,
    uniqExact(f.ad_account_id) ad_account_count,
    uniqExact(f.currency) currency_count,
    toString(min(f.stat_date)) period_date_from,
    toString(max(f.stat_date)) period_date_to,
    arrayStringConcat(arraySort(groupUniqArrayIf(${reportingTimezoneExpr("f.")}, ${reportingTimezoneExpr("f.")} != '')), ',') reporting_timezones,
    sum(f.spend) spend,
    sum(f.fb_purchases) purchases,
    sum(f.impressions) impressions,
    sum(f.clicks) clicks,
    sum(f.link_clicks) link_clicks,
    sum(f.reach) reach,
    sum(f.purchase_value) purchase_value,
    countIf(NOT isFinite(f.spend) OR f.spend < 0) invalid_metric_rows
  FROM ${FB} AS f FINAL
  WHERE ${where}
  GROUP BY campaign_id
  FORMAT JSONEachRow`;
}

export function fbSnapshotUniquenessSql(): string {
  return `SELECT count() snapshot_rows,
    uniqExact(canonical_user_id) snapshot_unique_users,
    count() - uniqExact(canonical_user_id) snapshot_duplicate_users
  FROM ${FC} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
  FORMAT JSONEachRow`;
}

export function assertFbSnapshotUnique(row: Record<string, unknown> | null | undefined): FbSnapshotUniqueness {
  const result = {
    rows: n(row?.snapshot_rows),
    uniqueUsers: n(row?.snapshot_unique_users),
    duplicateUsers: n(row?.snapshot_duplicate_users),
  };
  if (result.duplicateUsers > 0 || result.rows !== result.uniqueUsers) {
    throw new Error(`FB Cohorts blocked: active fact_user_cohorts snapshot is not unique by canonical_user_id (${result.rows} rows, ${result.uniqueUsers} users).`);
  }
  return result;
}

export function fbSourceStatsSql(): string {
  return `SELECT count() raw_rows,
    uniqExact(stat_date, campaign_id) campaign_day_rows,
    toString(max(stat_date)) last_stat_date
  FROM ${FB} FINAL
  WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign'
    AND trim(BOTH ' ' FROM campaign_id) != ''
  FORMAT JSONEachRow`;
}

function jsonSignal(column: string, ...path: string[]): string {
  return `JSONExtractString(${column}, ${path.map((part) => `'${part}'`).join(", ")})`;
}

/**
 * Diagnostics-only source classification at the authoritative first-trial
 * grain. This query never feeds Cohort membership or Campaign cost allocation.
 */
export function fbSourceScopedDiagnosticsSql(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  visibleRows: FbVisibleCohortRow[];
  params: Record<string, unknown>;
}): string {
  const where = authoritativeScopeWhere({ ...input, prefix: "fbsrc" });
  let fbWhere = `auth_user_id = {auth_user_id:String} AND level = 'campaign'
    AND trim(BOTH ' ' FROM f.campaign_id) != ''`;
  if (input.dateFrom) {
    input.params.fbsrc_metric_from = input.dateFrom;
    fbWhere += " AND toString(stat_date) >= {fbsrc_metric_from:String}";
  }
  if (input.dateTo) {
    input.params.fbsrc_metric_to = input.dateTo;
    fbWhere += " AND toString(stat_date) <= {fbsrc_metric_to:String}";
  }

  const sourceFields = [
    "m.traffic_source",
    "a.utm_source",
    jsonSignal("a.normalized_payload", "traffic_source"),
    jsonSignal("a.normalized_payload", "utm_source"),
    jsonSignal("a.normalized_payload", "metadata", "utm_source"),
    jsonSignal("a.normalized_payload", "raw", "utm_source"),
    jsonSignal("a.normalized_payload", "raw", "metadata", "utm_source"),
    jsonSignal("a.raw_payload", "traffic_source"),
    jsonSignal("a.raw_payload", "source_name"),
    jsonSignal("a.raw_payload", "utm_source"),
    jsonSignal("a.raw_payload", "metadata", "utm_source"),
  ];
  const cookieFields = (name: string) => [
    jsonSignal("a.normalized_payload", name),
    jsonSignal("a.normalized_payload", "metadata", name),
    jsonSignal("a.normalized_payload", "raw", name),
    jsonSignal("a.normalized_payload", "raw", "metadata", name),
    jsonSignal("a.raw_payload", name),
    jsonSignal("a.raw_payload", "metadata", name),
    // Palmer may preserve metadata as a JSON-encoded string in raw_payload.
    `JSONExtractString(${jsonSignal("a.raw_payload", "metadata")}, '${name}')`,
  ];
  const nonEmptySignal = (fields: string[]) => `arrayExists(value -> trim(BOTH ' ' FROM value) != '', [${fields.join(", ")}])`;
  const sourceSignal = `lowerUTF8(arrayStringConcat([${sourceFields.join(", ")}], '|'))`;
  const aliasIds = clickHouseBodyStringSet([...CONFIRMED_FB_CAMPAIGN_ALIAS_IDS]);

  return `WITH
members AS (
  SELECT canonical_user_id,
    trial_transaction_id,
    traffic_source,
    ${authoritativeCampaignExpr()} campaign_id
  FROM ${FC} AS fc FINAL
  WHERE ${where}
),
fb_campaigns AS (
  SELECT DISTINCT trim(BOTH ' ' FROM f.campaign_id) campaign_id
  FROM ${FB} AS f FINAL
  WHERE ${fbWhere}
),
trial_signals AS (
  SELECT m.canonical_user_id,
    m.campaign_id,
    ${sourceSignal} source_signal,
    ${nonEmptySignal(cookieFields("_fbc"))} has_fbc,
    ${nonEmptySignal(cookieFields("gclid"))} has_gclid,
    ${nonEmptySignal(cookieFields("ttclid"))} has_ttclid
  FROM members m
  ANY LEFT JOIN (
    SELECT transaction_id, user_id, utm_source, normalized_payload, raw_payload
    FROM ${AT} FINAL
    WHERE auth_user_id = {auth_user_id:String}
      AND transaction_id IN (SELECT trial_transaction_id FROM members)
  ) a ON a.transaction_id = m.trial_transaction_id AND a.user_id = m.canonical_user_id
),
classified AS (
  SELECT multiIf(
    match(source_signal, '(^|[^a-z0-9])(fb|facebook|ig|instagram|meta)([^a-z0-9]|$)'), 'facebook',
    campaign_id != '' AND campaign_id IN (SELECT campaign_id FROM fb_campaigns), 'facebook',
    campaign_id != '' AND campaign_id IN ${aliasIds}, 'facebook',
    campaign_id != '' AND has_fbc, 'facebook',
    match(source_signal, '(^|[^a-z0-9])(tiktok|tik[ _-]?tok)([^a-z0-9]|$)') OR has_ttclid, 'tiktok',
    match(source_signal, '(^|[^a-z0-9])(google|adwords|google[ _-]?ads)([^a-z0-9]|$)') OR has_gclid, 'google',
    match(source_signal, '(^|[^a-z0-9])(organic|seo)([^a-z0-9]|$)'), 'organic',
    match(source_signal, '(^|[^a-z0-9])(direct|none)([^a-z0-9]|$)'), 'direct',
    match(source_signal, '(^|[^a-z0-9])(bing|snapchat|pinterest|reddit|email|affiliate)([^a-z0-9]|$)'), 'other',
    'unknown'
  ) source_classification
  FROM trial_signals
)
SELECT count() all_cohorts_users,
  countIf(source_classification = 'facebook') facebook_qualified_users,
  countIf(source_classification = 'tiktok') tiktok_users,
  countIf(source_classification = 'google') google_users,
  countIf(source_classification = 'organic') organic_users,
  countIf(source_classification = 'direct') direct_users,
  countIf(source_classification = 'unknown') unknown_source_users,
  countIf(source_classification = 'other') other_source_users
FROM classified
FORMAT JSONEachRow`;
}

function rawTimezoneValues(value: unknown): string[] {
  const raw = Array.isArray(value) ? value.map(s) : s(value).split(",");
  return [...new Set(raw.map((timezone) => timezone.trim()).filter(Boolean))];
}

function timezoneValues(value: unknown): string[] {
  return rawTimezoneValues(value).filter(isValidIanaTimezone);
}

interface FbTimezoneResolution {
  timezone: string | null;
  source: FbTimezoneSource;
  invalid: boolean;
}

function resolveCampaignTimezone(rows: FbCampaignMetricRow[], config: FbMetaTimezoneConfig): FbTimezoneResolution {
  const payloadTimezones = [...new Set(rows.flatMap((row) => rawTimezoneValues(row.reporting_timezones)))];
  if (payloadTimezones.length > 0) {
    return payloadTimezones.length === 1 && isValidIanaTimezone(payloadTimezones[0])
      ? { timezone: payloadTimezones[0], source: "payload", invalid: false }
      : { timezone: null, source: "unverified", invalid: true };
  }
  const configured = [...new Set(rows
    .map((row) => config.accountTimezones?.[s(row.ad_account_id)] ?? "")
    .filter(Boolean))];
  if (configured.length > 0) {
    return configured.length === 1 && isValidIanaTimezone(configured[0])
      ? { timezone: configured[0], source: "account_config", invalid: false }
      : { timezone: null, source: "unverified", invalid: true };
  }
  if (config.defaultTimezone) {
    return isValidIanaTimezone(config.defaultTimezone)
      ? { timezone: config.defaultTimezone, source: "default_config", invalid: false }
      : { timezone: null, source: "unverified", invalid: true };
  }
  return { timezone: null, source: "unverified", invalid: false };
}

interface MetricAccumulator extends FbAdditive {
  campaignId: string;
  periodDates: Set<string>;
  names: Set<string>;
  accounts: Set<string>;
  currencies: Set<string>;
  timezones: Set<string>;
  components: Set<string>;
  invalidMetrics: boolean;
  multipleAccounts: boolean;
  multipleCurrencies: boolean;
}

function invalidMetricValue(value: unknown, integer = false): boolean {
  if (value == null || value === "") return false;
  const parsed = Number(value);
  return !Number.isFinite(parsed) || parsed < 0 || (integer && !Number.isInteger(parsed));
}

function campaignMetricMap(rows: FbCampaignMetricRow[], config: FbMetaTimezoneConfig): {
  metrics: Map<string, FbCampaignMetric>;
  timezoneByCampaign: Map<string, FbTimezoneResolution>;
} {
  const rowsByCampaign = new Map<string, FbCampaignMetricRow[]>();
  for (const row of rows) {
    const campaignId = normalizeAuthoritativeCampaignId(row.campaign_id);
    if (!campaignId) continue;
    const list = rowsByCampaign.get(campaignId) ?? [];
    list.push(row);
    rowsByCampaign.set(campaignId, list);
  }
  const timezoneByCampaign = new Map<string, FbTimezoneResolution>();
  for (const [campaignId, campaignRows] of rowsByCampaign) {
    timezoneByCampaign.set(campaignId, resolveCampaignTimezone(campaignRows, config));
  }

  const accumulators = new Map<string, MetricAccumulator>();
  for (const row of rows) {
    const campaignId = normalizeAuthoritativeCampaignId(row.campaign_id);
    if (!campaignId) continue;
    const acc = accumulators.get(campaignId) ?? {
      campaignId,
      periodDates: new Set<string>(),
      fb_spend: 0,
      fb_purchases: 0,
      fb_impressions: 0,
      fb_reach: 0,
      fb_clicks: 0,
      fb_link_clicks: 0,
      fb_purchase_value: 0,
      names: new Set<string>(),
      accounts: new Set<string>(),
      currencies: new Set<string>(),
      timezones: new Set<string>(),
      components: new Set<string>(),
      invalidMetrics: false,
      multipleAccounts: false,
      multipleCurrencies: false,
    };
    const account = s(row.ad_account_id);
    const currency = s(row.currency) || (n(row.currency_count) > 1 ? "" : "USD");
    const campaignName = s(row.campaign_name).trim();
    if (campaignName) acc.names.add(campaignName);
    const rowDate = s(row.fb_reporting_date).slice(0, 10);
    const periodFrom = s(row.period_date_from).slice(0, 10);
    const periodTo = s(row.period_date_to).slice(0, 10);
    for (const value of [rowDate, periodFrom, periodTo]) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) acc.periodDates.add(value);
    }
    const signature = [rowDate, periodFrom, periodTo, account, currency, n(row.spend), n(row.purchases), n(row.impressions), n(row.clicks), n(row.link_clicks), n(row.reach), n(row.purchase_value)].join("|");
    if (acc.components.has(signature)) continue;
    acc.components.add(signature);
    acc.multipleAccounts ||= n(row.ad_account_count) > 1;
    acc.multipleCurrencies ||= n(row.currency_count) > 1;
    acc.invalidMetrics ||= n(row.invalid_metric_rows) > 0
      || invalidMetricValue(row.spend)
      || invalidMetricValue(row.purchases, true)
      || invalidMetricValue(row.impressions, true)
      || invalidMetricValue(row.clicks, true)
      || invalidMetricValue(row.link_clicks, true)
      || invalidMetricValue(row.reach, true)
      || invalidMetricValue(row.purchase_value);
    if (account) acc.accounts.add(account);
    if (currency) acc.currencies.add(currency);
    for (const timezone of timezoneValues(row.reporting_timezones)) acc.timezones.add(timezone);
    acc.fb_spend += n(row.spend);
    acc.fb_purchases += Math.max(0, n(row.purchases));
    acc.fb_impressions += Math.max(0, n(row.impressions));
    acc.fb_clicks += Math.max(0, n(row.clicks));
    acc.fb_link_clicks += Math.max(0, n(row.link_clicks));
    acc.fb_reach += Math.max(0, n(row.reach));
    acc.fb_purchase_value += Math.max(0, n(row.purchase_value));
    accumulators.set(campaignId, acc);
  }

  const metrics = new Map<string, FbCampaignMetric>();
  for (const [campaignId, acc] of accumulators) {
    const additive: FbAdditive = {
      fb_spend: acc.fb_spend,
      fb_purchases: acc.fb_purchases,
      fb_impressions: acc.fb_impressions,
      fb_reach: acc.fb_reach,
      fb_clicks: acc.fb_clicks,
      fb_link_clicks: acc.fb_link_clicks,
      fb_purchase_value: acc.fb_purchase_value,
    };
    const timezoneResolution = timezoneByCampaign.get(acc.campaignId)
      ?? { timezone: null, source: "unverified" as const, invalid: false };
    const valid = !acc.multipleAccounts
      && !acc.multipleCurrencies
      && acc.accounts.size <= 1
      && acc.currencies.size === 1
      && !acc.invalidMetrics;
    const derived = deriveFbRatios(additive);
    const periodDates = [...acc.periodDates].sort();
    metrics.set(campaignId, {
      campaign_id: acc.campaignId,
      campaign_name: acc.names.size === 1 ? [...acc.names][0] : null,
      fb_reporting_date: null,
      period_date_from: periodDates[0] ?? null,
      period_date_to: periodDates.at(-1) ?? null,
      ad_account_id: acc.accounts.size === 1 ? [...acc.accounts][0] : null,
      fb_timezone: timezoneResolution.timezone,
      fb_timezone_source: timezoneResolution.source,
      fb_timezone_invalid: timezoneResolution.invalid,
      fb_currency: acc.currencies.size === 1 ? [...acc.currencies][0] : null,
      ...additive,
      ...derived,
      // Keep maximum Number precision internally. Money is rounded by the UI,
      // never in Campaign CPP or per-row allocation.
      fb_cpp: !acc.invalidMetrics && additive.fb_purchases > 0 ? additive.fb_spend / additive.fb_purchases : null,
      valid,
      invalid_metrics: acc.invalidMetrics || acc.multipleAccounts || acc.multipleCurrencies
        || acc.accounts.size > 1 || acc.currencies.size !== 1,
    });
  }
  return { metrics, timezoneByCampaign };
}

export interface FbUserCostAssembly {
  perRow: Record<string, FbCohortRowStats>;
  totals: FbCohortTotals;
  validation: FbCampaignValidationRow[];
  assignments: FbUserCostAssignment[];
  summary: Omit<FbCohortDiagnostics,
    | keyof FbSourceScopedDiagnostics
    | "fb_data_status" | "fb_error_code" | "fb_error_message_safe" | "fb_source_rows"
    | "fb_campaign_day_rows" | "fb_last_sync_at" | "fb_warehouse_version" | "fb_snapshot_rows"
    | "fb_snapshot_unique_users" | "fb_snapshot_duplicate_users" | "fb_snapshot_unique"
    | "fb_validation_rows" | "fb_allocation_diagnostics_enabled">;
}

export function assembleFbUserCosts(
  inputUsers: FbAuthoritativeUserRow[],
  metricRows: FbCampaignMetricRow[],
  visibleKeys: Set<string>,
  timezoneConfig: FbMetaTimezoneConfig,
): FbUserCostAssembly {
  const users: FbAuthoritativeUserRow[] = [];
  const seenUsers = new Set<string>();
  for (const raw of inputUsers) {
    const userId = s(raw.canonical_user_id);
    if (!userId) continue;
    if (seenUsers.has(userId)) throw new Error(`FB Cohorts blocked: duplicate authoritative user ${userId}.`);
    seenUsers.add(userId);
    const rowKey = fbCohortRowKey(s(raw.cohort_date), s(raw.funnel), s(raw.campaign_path));
    if (visibleKeys.has(rowKey)) users.push({ ...raw, campaign_id: normalizeAuthoritativeCampaignId(raw.campaign_id) });
  }

  const userCount = (row: FbAuthoritativeUserRow): number => {
    const count = Number(row.authoritative_user_count ?? 1);
    return Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0;
  };

  const { metrics, timezoneByCampaign } = campaignMetricMap(metricRows, timezoneConfig);
  const preliminary = users.map((user) => {
    const campaignId = normalizeAuthoritativeCampaignId(user.campaign_id);
    const timezoneResolution = campaignId
      ? timezoneByCampaign.get(campaignId) ?? { timezone: null, source: "unverified" as const, invalid: false }
      : { timezone: null, source: "unverified" as const, invalid: false };
    return {
      user,
      count: userCount(user),
      campaignId,
      timezone: timezoneResolution.timezone,
      timezoneSource: timezoneResolution.source,
      key: campaignId,
    };
  });
  const matchedUsersByKey = new Map<string, number>();
  for (const item of preliminary) {
    if (!item.campaignId) continue;
    matchedUsersByKey.set(item.key, (matchedUsersByKey.get(item.key) ?? 0) + item.count);
  }

  interface AffectedScope {
    users: number;
    cohortRows: Set<string>;
    funnels: Set<string>;
    campaignPaths: Set<string>;
    timezoneSource: FbTimezoneSource;
    timezone: string | null;
  }
  const affectedByKey = new Map<string, AffectedScope>();
  for (const item of preliminary) {
    if (!item.campaignId) continue;
    const affected = affectedByKey.get(item.key) ?? {
      users: 0,
      cohortRows: new Set<string>(),
      funnels: new Set<string>(),
      campaignPaths: new Set<string>(),
      timezoneSource: item.timezoneSource,
      timezone: item.timezone,
    };
    affected.users += item.count;
    affected.cohortRows.add(fbCohortRowKey(item.user.cohort_date, item.user.funnel, item.user.campaign_path));
    affected.funnels.add(item.user.funnel);
    affected.campaignPaths.add(item.user.campaign_path);
    affectedByKey.set(item.key, affected);
  }

  // Metric-only keys are diagnostics rows with no matched users. They never
  // receive user_cpp and therefore cannot alter Cohort Spend or report totals.
  const validationKeys = new Set<string>([
    ...preliminary.filter((item) => item.campaignId).map((item) => item.key),
    ...metrics.keys(),
  ]);
  const validationByKey = new Map<string, FbCampaignValidationRow>();
  for (const key of validationKeys) {
    const campaignId = key;
    const metric = metrics.get(key);
    const affected = affectedByKey.get(key);
    const matchedUsers = matchedUsersByKey.get(key) ?? 0;
    let allocationStatus: FbAllocationStatus;
    if (!metric) allocationStatus = "campaign_unmatched";
    else if (!metric.valid || metric.invalid_metrics) allocationStatus = "invalid_metrics";
    else if (metric.fb_purchases <= 0) allocationStatus = "no_fb_purchases";
    else if (matchedUsers > metric.fb_purchases) allocationStatus = "overallocated";
    else if (matchedUsers === 0) allocationStatus = "no_matched_users";
    else if (matchedUsers < metric.fb_purchases) allocationStatus = "underallocated";
    else allocationStatus = "fully_allocated";
    const cpp = metric?.fb_cpp ?? null;
    const allocatable = allocationStatus === "fully_allocated"
      || allocationStatus === "underallocated"
      || allocationStatus === "overallocated";
    const allocatedSpend = allocatable && cpp != null ? cpp * matchedUsers : 0;
    const unallocatedSpend = metric ? Math.max(metric.fb_spend - allocatedSpend, 0) : 0;
    const difference = allocatedSpend + unallocatedSpend - (metric?.fb_spend ?? 0);
    validationByKey.set(key, {
      campaign_id: campaignId,
      campaign_name: metric?.campaign_name ?? null,
      ad_account_id: metric?.ad_account_id ?? null,
      fb_reporting_date: null,
      period_date_from: metric?.period_date_from ?? null,
      period_date_to: metric?.period_date_to ?? null,
      meta_timezone: metric?.fb_timezone ?? affected?.timezone ?? null,
      timezone_source: metric?.fb_timezone_source ?? affected?.timezoneSource ?? "unverified",
      fb_purchases: metric?.fb_purchases ?? 0,
      matched_authoritative_users: matchedUsers,
      unmatched_authoritative_users: allocatable ? 0 : affected?.users ?? 0,
      unmatched_fb_purchases: allocatable
        ? Math.max((metric?.fb_purchases ?? 0) - matchedUsers, 0)
        : metric?.fb_purchases ?? 0,
      excess_authoritative_users: Math.max(matchedUsers - (metric?.fb_purchases ?? 0), 0),
      coverage_rate: metric && metric.fb_purchases > 0 ? round2((matchedUsers / metric.fb_purchases) * 100) : null,
      campaign_cpp: cpp,
      fb_spend: metric?.fb_spend ?? 0,
      allocated_spend: allocatedSpend,
      unallocated_spend: unallocatedSpend,
      allocation_difference: difference,
      allocation_difference_percent: metric && metric.fb_spend > 0 ? (difference / metric.fb_spend) * 100 : null,
      allocation_status: allocationStatus,
      visible_cohort_spend: allocatedSpend,
      affected_cohort_rows: affected?.cohortRows.size ?? 0,
      affected_funnels: [...(affected?.funnels ?? [])].sort(),
      affected_campaign_paths: [...(affected?.campaignPaths ?? [])].sort(),
    });
  }

  const assignments: FbUserCostAssignment[] = preliminary.map((item) => {
    const validation = validationByKey.get(item.key);
    const allocatable = validation?.allocation_status === "fully_allocated"
      || validation?.allocation_status === "underallocated"
      || validation?.allocation_status === "overallocated";
    const metric = metrics.get(item.key);
    let allocationStatus: FbAllocationStatus;
    if (!item.campaignId) allocationStatus = "campaign_unmatched";
    else allocationStatus = validation?.allocation_status ?? "campaign_unmatched";
    return {
      canonical_user_id: item.user.canonical_user_id,
      cohort_date: item.user.cohort_date,
      funnel: item.user.funnel,
      campaign_path: item.user.campaign_path,
      campaign_id: item.campaignId,
      trial_timestamp_utc: item.user.trial_timestamp_utc,
      fb_reporting_date: null,
      fb_campaign_cpp: metric?.fb_cpp ?? null,
      fb_user_cpp: allocatable ? metric?.fb_cpp ?? null : null,
      fb_timezone: item.timezone,
      allocation_status: allocationStatus,
      authoritative_user_count: item.count,
    };
  });

  interface RowAcc {
    users: number;
    matched: number;
    spend: number;
    campaignKeys: Set<string>;
    campaignCpps: Set<number>;
    timezones: Set<string>;
    currencies: Set<string>;
    statuses: Set<FbAllocationStatus>;
    fbPurchases: number;
    campaignSpend: Map<string, number>;
  }
  const rowAcc = new Map<string, RowAcc>();
  for (const assignment of assignments) {
    const key = fbCohortRowKey(assignment.cohort_date, assignment.funnel, assignment.campaign_path);
    const acc = rowAcc.get(key) ?? {
      users: 0, matched: 0, spend: 0, campaignKeys: new Set(), campaignCpps: new Set(),
      timezones: new Set(), currencies: new Set(), statuses: new Set(), fbPurchases: 0, campaignSpend: new Map(),
    };
    const count = assignment.authoritative_user_count ?? 1;
    acc.users += count;
    acc.statuses.add(assignment.allocation_status);
    if (assignment.fb_timezone) acc.timezones.add(assignment.fb_timezone);
    if (assignment.fb_user_cpp != null) {
      const allocated = assignment.fb_user_cpp * count;
      const assignmentCampaignKey = assignment.campaign_id;
      acc.matched += count;
      acc.fbPurchases += count;
      acc.spend += allocated;
      acc.campaignKeys.add(assignmentCampaignKey);
      acc.campaignSpend.set(assignmentCampaignKey, (acc.campaignSpend.get(assignmentCampaignKey) ?? 0) + allocated);
      acc.campaignCpps.add(assignment.fb_user_cpp);
      const currency = metrics.get(assignment.campaign_id)?.fb_currency;
      if (currency) acc.currencies.add(currency);
    }
    rowAcc.set(key, acc);
  }

  const rowStatus = (acc: RowAcc): FbMatchStatus => {
    if (acc.statuses.has("overallocated")) return "overallocated";
    if (acc.statuses.has("invalid_metrics")) return "invalid_campaign_metric";
    if (acc.currencies.size > 1) return "mixed_currency";
    if (acc.matched === acc.users && acc.users > 0) return "matched";
    if (acc.matched > 0) return "partial_coverage";
    if (acc.statuses.has("no_fb_purchases")) return "no_fb_purchases";
    if (acc.statuses.has("campaign_unmatched")) return "no_fb_campaign";
    return "missing_cohort_campaign_id";
  };
  const perRow: Record<string, FbCohortRowStats> = {};
  const visibleSpendByCampaignKey = new Map<string, number>();
  for (const [key, acc] of rowAcc) {
    const spend = acc.matched > 0 ? acc.spend : null;
    for (const [campaignId, campaignSpend] of acc.campaignSpend) {
      visibleSpendByCampaignKey.set(campaignId, (visibleSpendByCampaignKey.get(campaignId) ?? 0) + campaignSpend);
    }
    const matchedValidation = [...acc.campaignKeys].map((campaignKeyValue) => validationByKey.get(campaignKeyValue)).filter(Boolean) as FbCampaignValidationRow[];
    const campaignPurchases = matchedValidation.reduce((sum, row) => sum + row.fb_purchases, 0);
    perRow[key] = {
      fb_spend: spend,
      fb_currency: acc.currencies.size === 1 ? [...acc.currencies][0] : null,
      fb_purchases: acc.matched > 0 ? acc.fbPurchases : null,
      fb_cpp: spend != null && acc.matched > 0 ? spend / acc.matched : null,
      fb_impressions: null,
      fb_reach: null,
      fb_clicks: null,
      fb_link_clicks: null,
      fb_ctr: null,
      fb_cpc: null,
      fb_cpm: null,
      fb_purchase_value: null,
      fb_roas: null,
      fb_campaigns_matched: acc.campaignKeys.size,
      fb_match_status: rowStatus(acc),
      fb_reporting_date: null,
      fb_campaign_cpp: acc.campaignCpps.size === 1 ? [...acc.campaignCpps][0] : null,
      fb_user_cpp: acc.matched > 0 ? acc.spend / acc.matched : null,
      fb_matched_users: acc.matched,
      fb_unmatched_users: acc.users - acc.matched,
      fb_campaign_coverage: campaignPurchases > 0 ? round2((acc.matched / campaignPurchases) * 100) : null,
      fb_cpp_source: "campaign_spend_div_fb_purchases",
      fb_timezone: acc.timezones.size === 1 ? [...acc.timezones][0] : acc.timezones.size > 1 ? "mixed" : null,
      coverage_rate: acc.users > 0 ? round2((acc.matched / acc.users) * 100) : null,
    };
  }

  for (const [key, validationRow] of validationByKey) {
    validationRow.visible_cohort_spend = visibleSpendByCampaignKey.get(key) ?? 0;
  }

  const totalUsers = assignments.reduce((sum, assignment) => sum + (assignment.authoritative_user_count ?? 1), 0);
  const matchedAssignments = assignments.filter((assignment) => assignment.fb_user_cpp != null);
  const matchedUsers = matchedAssignments.reduce((sum, assignment) => sum + (assignment.authoritative_user_count ?? 1), 0);
  const totalSpend = matchedAssignments.reduce((sum, assignment) => sum + (assignment.fb_user_cpp ?? 0) * (assignment.authoritative_user_count ?? 1), 0);
  const totalCampaignKeys = new Set(matchedAssignments.map((assignment) => assignment.campaign_id));
  const totalCurrencies = new Set([...totalCampaignKeys].map((key) => metrics.get(key)?.fb_currency).filter(Boolean) as string[]);
  const totalTimezones = new Set(assignments.map((assignment) => assignment.fb_timezone).filter(Boolean) as string[]);
  const totalCampaignCpps = new Set(matchedAssignments.map((assignment) => assignment.fb_campaign_cpp).filter((value): value is number => value != null));
  const validValidation = [...validationByKey.values()].filter((row) => row.allocation_status === "fully_allocated"
    || row.allocation_status === "underallocated" || row.allocation_status === "overallocated");
  const totalFbPurchases = validValidation.reduce((sum, row) => sum + row.fb_purchases, 0);
  const totals: FbCohortTotals = {
    fb_spend: matchedAssignments.length > 0 ? totalSpend : null,
    fb_currency: totalCurrencies.size === 1 ? [...totalCurrencies][0] : null,
    fb_purchases: matchedUsers > 0 ? matchedUsers : null,
    fb_cpp: matchedUsers > 0 ? totalSpend / matchedUsers : null,
    fb_impressions: null,
    fb_reach: null,
    fb_clicks: null,
    fb_link_clicks: null,
    fb_ctr: null,
    fb_cpc: null,
    fb_cpm: null,
    fb_purchase_value: null,
    fb_roas: null,
    fb_campaigns_matched: totalCampaignKeys.size,
    fb_reporting_date: null,
    fb_campaign_cpp: totalCampaignCpps.size === 1 ? [...totalCampaignCpps][0] : null,
    fb_user_cpp: matchedUsers > 0 ? totalSpend / matchedUsers : null,
    fb_matched_users: matchedUsers,
    fb_unmatched_users: totalUsers - matchedUsers,
    fb_campaign_coverage: totalFbPurchases > 0 ? round2((matchedUsers / totalFbPurchases) * 100) : null,
    fb_cpp_source: "campaign_spend_div_fb_purchases",
    fb_timezone: totalTimezones.size === 1 ? [...totalTimezones][0] : totalTimezones.size > 1 ? "mixed" : null,
    coverage_rate: totalUsers > 0 ? round2((matchedUsers / totalUsers) * 100) : null,
    fb_campaign_day_pairs: totalCampaignKeys.size,
    fb_reach_total_available: false,
  };

  const validation = [...validationByKey.values()].sort((left, right) => {
    const priority = (status: FbAllocationStatus) => status === "overallocated" ? 0 : status === "underallocated" ? 1 : status === "fully_allocated" ? 2 : 3;
    return priority(left.allocation_status) - priority(right.allocation_status)
      || right.fb_spend - left.fb_spend
      || left.campaign_id.localeCompare(right.campaign_id);
  });
  const campaignIds = new Set(assignments.map((assignment) => assignment.campaign_id).filter(Boolean));
  const authoritativeKeys = new Set(preliminary.filter((item) => item.campaignId).map((item) => item.key));
  const matchedCampaignKeys = new Set(matchedAssignments.map((assignment) => assignment.campaign_id));
  const metricPeriodDates = [...metrics.values()]
    .flatMap((metric) => [metric.period_date_from, metric.period_date_to])
    .filter((value): value is string => Boolean(value))
    .sort();
  const summary: FbUserCostAssembly["summary"] = {
    fb_attribution_source: "fact_user_cohorts",
    fb_join_key: "campaign_id",
    fb_cpp_source: "campaign_spend_div_fb_purchases",
    fb_reporting_date: totals.fb_reporting_date,
    fb_campaign_cpp: totals.fb_campaign_cpp,
    fb_user_cpp: totals.fb_user_cpp,
    fb_matched_users: totals.fb_matched_users,
    fb_unmatched_users: totals.fb_unmatched_users,
    fb_campaign_coverage: authoritativeKeys.size > 0 ? round2((matchedCampaignKeys.size / authoritativeKeys.size) * 100) : null,
    fb_timezone: totals.fb_timezone,
    coverage_rate: totals.coverage_rate,
    fb_users_in_cohorts: totalUsers,
    fb_campaigns_in_scope: campaignIds.size,
    fb_campaign_keys_in_scope: authoritativeKeys.size,
    fb_allocated_spend: totalSpend,
    fb_unallocated_spend: validation.reduce((sum, row) => sum + row.unallocated_spend, 0),
    fb_unallocated_purchases: validation.reduce((sum, row) => sum + row.fb_purchases, 0) - matchedUsers,
    fb_gross_unmatched_purchases: validation.reduce((sum, row) => sum + row.unmatched_fb_purchases, 0),
    fb_campaigns_without_cohort_users: [...metrics.keys()].filter((key) => (matchedUsersByKey.get(key) ?? 0) === 0).length,
    fb_period_date_from: metricPeriodDates[0] ?? null,
    fb_period_date_to: metricPeriodDates.at(-1) ?? null,
    fb_overallocated_campaigns: validation.filter((row) => row.allocation_status === "overallocated").length,
    fb_underallocated_campaigns: validation.filter((row) => row.allocation_status === "underallocated").length,
    fb_zero_purchase_campaigns: validation.filter((row) => row.allocation_status === "no_fb_purchases").length,
    // Timezone is informational in campaign-period allocation and cannot block a match.
    fb_timezone_unverified_users: 0,
  };
  return { perRow, totals, validation, assignments, summary };
}

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export async function computeFbCohortStats(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  active: { warehouse_version: string; classification_version: string };
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  visibleKeys: Set<string>;
  visibleRows: FbVisibleCohortRow[];
  today?: string;
  timezoneConfig?: FbMetaTimezoneConfig;
  allocationDiagnosticsEnabled?: boolean;
  allocationDiagnosticsRequest?: FbAllocationDiagnosticsRequest | null;
}): Promise<FbCohortStatsBundle> {
  const params: Record<string, unknown> = {
    auth_user_id: input.authUserId,
    warehouse_version: input.active.warehouse_version,
    classification_version: input.active.classification_version,
  };
  const groupSql = fbAuthoritativeUserGroupsSql({
    filters: input.filters,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    visibleRows: input.visibleRows,
    params,
  });
  const metricParams: Record<string, unknown> = { auth_user_id: input.authUserId };
  const metricSql = fbCampaignMetricsSql({
    campaignIds: null,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    params: metricParams,
  });
  const sourceScopedSql = fbSourceScopedDiagnosticsSql({
    filters: input.filters,
    dateFrom: input.dateFrom,
    dateTo: input.dateTo,
    visibleRows: input.visibleRows,
    params,
  });
  const [groupRs, snapshotRs, metricRs, sourceRs, sourceScopedRs, syncState] = await Promise.all([
    input.clickhouse.query({ query: groupSql, query_params: params, format: "JSONEachRow" }),
    input.clickhouse.query({ query: fbSnapshotUniquenessSql(), query_params: params, format: "JSONEachRow" }),
    input.clickhouse.query({ query: metricSql, query_params: metricParams, format: "JSONEachRow" }),
    input.clickhouse.query({ query: fbSourceStatsSql(), query_params: { auth_user_id: input.authUserId }, format: "JSONEachRow" }),
    input.clickhouse.query({ query: sourceScopedSql, query_params: params, format: "JSONEachRow" }),
    getFbSyncState(input.supabase, input.authUserId).catch(() => null),
  ]);
  const snapshotRow = ((await snapshotRs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  const snapshot = assertFbSnapshotUnique(snapshotRow);
  const groupRows = (await groupRs.json()) as Array<Record<string, unknown>>;
  const metricRows = (await metricRs.json()) as FbCampaignMetricRow[];
  const source = ((await sourceRs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  const sourceScoped = ((await sourceScopedRs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  const timezoneConfig = input.timezoneConfig ?? runtimeTimezoneConfig();
  const userGroups = groupRows.map((row, index): FbAuthoritativeUserRow => ({
    canonical_user_id: `aggregate:${index}:${s(row.campaign_id)}`,
    cohort_date: s(row.cohort_date),
    trial_timestamp_utc: "1970-01-01T00:00:00.000Z",
    funnel: s(row.funnel),
    campaign_path: s(row.campaign_path),
    campaign_id: s(row.campaign_id),
    authoritative_user_count: n(row.authoritative_user_count),
  }));
  const assembly = assembleFbUserCosts(userGroups, metricRows, input.visibleKeys, timezoneConfig);
  const sourceCounts: FbSourceCounts = {
    all: n(sourceScoped.all_cohorts_users),
    facebook: n(sourceScoped.facebook_qualified_users),
    tiktok: n(sourceScoped.tiktok_users),
    google: n(sourceScoped.google_users),
    organic: n(sourceScoped.organic_users),
    direct: n(sourceScoped.direct_users),
    unknown: n(sourceScoped.unknown_source_users),
    other: n(sourceScoped.other_source_users),
  };
  const fullFbPurchases = assembly.validation.reduce((sum, row) => sum + row.fb_purchases, 0);
  const sourceReconciliation = buildFbSourceReconciliation({
    counts: sourceCounts,
    fbAnalyticsPurchases: fullFbPurchases,
    allocatedFbPurchases: assembly.totals.fb_purchases ?? 0,
  });
  const sourceRows = n(source.raw_rows);
  const lastStatDate = s(source.last_stat_date);
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const yesterday = addUtcDays(today, -1);
  const syncStatus = s(syncState?.status);
  let dataStatus: FbDataStatus;
  if (!syncState && sourceRows === 0) dataStatus = "unavailable";
  else if (syncStatus === "running") dataStatus = "sync_pending";
  else if (sourceRows === 0) dataStatus = "empty_source";
  else if (lastStatDate && lastStatDate >= yesterday && lastStatDate !== "1970-01-01") dataStatus = "ready";
  else dataStatus = "stale";
  const allocationDiagnostics = input.allocationDiagnosticsEnabled
    ? buildFbAllocationDiagnostics(assembly.validation, input.allocationDiagnosticsRequest)
    : null;
  return {
    perRow: assembly.perRow,
    totals: assembly.totals,
    allocationDiagnostics,
    diagnostics: {
      fb_data_status: dataStatus,
      fb_error_code: null,
      fb_error_message_safe: null,
      fb_source_rows: sourceRows,
      fb_campaign_day_rows: n(source.campaign_day_rows),
      fb_last_sync_at: s(syncState?.finished_at) || null,
      fb_warehouse_version: syncState ? fbWarehouseVersionFromState(syncState, sourceRows) : null,
      ...assembly.summary,
      fb_source_classification: "authoritative_trial_source_v1",
      fb_all_cohorts_users: sourceReconciliation.all,
      fb_facebook_qualified_users: sourceReconciliation.facebook,
      fb_tiktok_users: sourceReconciliation.tiktok,
      fb_google_users: sourceReconciliation.google,
      fb_organic_users: sourceReconciliation.organic,
      fb_direct_users: sourceReconciliation.direct,
      fb_unknown_source_users: sourceReconciliation.unknown,
      fb_other_source_users: sourceReconciliation.other,
      fb_analytics_purchases: sourceReconciliation.fbAnalyticsPurchases,
      fb_allocated_purchases: sourceReconciliation.allocatedFbPurchases,
      fb_unallocated_purchases: sourceReconciliation.allocationGap,
      fb_allocation_gap_purchases: sourceReconciliation.allocationGap,
      fb_allocation_coverage: sourceReconciliation.allocationCoverage,
      fb_source_mix_difference: sourceReconciliation.sourceMixDifference,
      fb_meta_authoritative_difference: sourceReconciliation.metaAuthoritativeDifference,
      fb_snapshot_rows: snapshot.rows,
      fb_snapshot_unique_users: snapshot.uniqueUsers,
      fb_snapshot_duplicate_users: snapshot.duplicateUsers,
      fb_snapshot_unique: snapshot.rows === snapshot.uniqueUsers && snapshot.duplicateUsers === 0,
      fb_validation_rows: assembly.validation.length,
      fb_allocation_diagnostics_enabled: Boolean(input.allocationDiagnosticsEnabled),
    },
  };
}
