// FB Analytics → Cohorts join layer.
//
// Audited facts this module is built on (probed live 2026-07-16):
// - fact_facebook_stats grain: (auth_user_id, level, stat_date, ad_account_id,
//   campaign_id, adset_id, ad_id), ReplacingMergeTree(row_version). The
//   campaign level carries every dimension needed here; per-day sync guarantees
//   one logical row per campaign/day.
// - Meta campaign ids are GLOBALLY unique across ad accounts (823 sampled
//   campaign ids, zero shared across accounts) → ad_account_id is NOT part of
//   the join key; the campaign/day aggregate collapses accounts safely.
// - Currency is envelope-level "USD" today; rows still group by currency so a
//   future non-USD account surfaces as mixed_currency instead of silent USD sums.
// - Campaign ids are 18-digit strings — ALWAYS handled as String (never JS
//   Number / parseInt; ClickHouse side compares String columns).
// - Date semantics: fb stat_date is the ad-account-local calendar day as
//   reported by Capsuled; cohort_date is the trial-attribution day. They join
//   by literal date equality (no hidden timezone shift) — documented contract.
//
// Cohort grain is (cohort_date, funnel, campaign_path) and one row aggregates
// MANY campaign ids, so per-row FB metrics sum fb_campaign_daily over the
// row's DISTINCT member campaign ids at stat_date = cohort_date (STEP 8 B).
// Totals deduplicate (stat_date, campaign_id) pairs across visible rows so a
// campaign that feeds several funnels/paths on one day is counted once.
//
// This module NEVER touches the parity-proven cohort aggregate SQL — it is a
// separate query assembled into the same response bundle.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { FACT_FACEBOOK_STATS_TABLE, FACT_USER_COHORTS_TABLE } from "./schema.ts";
import { getFbSyncState, fbWarehouseVersionFromState } from "./facebookStats.ts";
import type { CohortFilters } from "./cohortContract.ts";

const FB = FACT_FACEBOOK_STATS_TABLE;
const FC = FACT_USER_COHORTS_TABLE;

const n = (v: unknown): number => {
  const p = Number(v ?? 0);
  return Number.isFinite(p) ? p : 0;
};
const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Canonical campaign-id normalization: String, trimmed, never through Number. */
export function normalizeFbCampaignId(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

// ---- Contract ---------------------------------------------------------------

export type FbMatchStatus = "matched" | "no_fb_stats" | "missing_cohort_campaign_id" | "mixed_currency";
export type FbDataStatus = "ready" | "empty_source" | "stale" | "unavailable" | "sync_pending";

/** Additive FB sums for one scope (row or totals) — ratios derived separately. */
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

export interface FbCohortRowStats extends FbAdditive, FbDerived {
  fb_currency: string | null;
  fb_campaigns_matched: number;
  fb_match_status: FbMatchStatus;
}

export interface FbCohortTotals extends FbAdditive, FbDerived {
  fb_currency: string | null;
  fb_campaign_day_pairs: number;
  /** Reach is NOT additive across campaigns/days — totals expose it as null (unavailable). */
  fb_reach_total_available: false;
}

export interface FbCohortDiagnostics {
  fb_data_status: FbDataStatus;
  fb_source_rows: number;
  fb_campaign_day_rows: number;
  fb_matched_cohort_rows: number;
  fb_unmatched_cohort_rows: number;
  fb_missing_campaign_id_rows: number;
  fb_mixed_currency_rows: number;
  fb_last_sync_at: string | null;
  fb_warehouse_version: string | null;
  fb_join_key: "campaign_id+cohort_date";
}

export interface FbCohortStatsBundle {
  perRow: Record<string, FbCohortRowStats>;
  totals: FbCohortTotals;
  diagnostics: FbCohortDiagnostics;
}

export function fbCohortRowKey(cohortDate: string, funnel: string, campaignPath: string): string {
  return `${cohortDate}|${funnel}|${campaignPath}`;
}

// ---- Derived metrics: computed ONLY from summed additive inputs --------------

export function deriveFbRatios(a: FbAdditive): FbDerived {
  return {
    fb_cpp: a.fb_purchases > 0 ? round2(a.fb_spend / a.fb_purchases) : null,
    fb_cpc: a.fb_clicks > 0 ? round2(a.fb_spend / a.fb_clicks) : null,
    fb_cpm: a.fb_impressions > 0 ? round2((a.fb_spend / a.fb_impressions) * 1000) : null,
    fb_ctr: a.fb_impressions > 0 ? round2((a.fb_clicks / a.fb_impressions) * 100) : null,
    fb_roas: a.fb_spend > 0 && a.fb_purchase_value > 0 ? round2(a.fb_purchase_value / a.fb_spend) : null,
  };
}

const EMPTY_ADDITIVE: FbAdditive = {
  fb_spend: 0, fb_purchases: 0, fb_impressions: 0, fb_reach: 0,
  fb_clicks: 0, fb_link_clicks: 0, fb_purchase_value: 0,
};

// ---- SQL --------------------------------------------------------------------

function inClause(column: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const ph = values.map((v, i) => {
    const key = `p_fbj_${prefix}_${i}`;
    params[key] = v;
    return `{${key}:String}`;
  });
  return ` AND ${column} IN (${ph.join(", ")})`;
}

/** campaign/day/currency aggregate of the FB warehouse — the canonical grain. */
export function fbCampaignDailySql(): string {
  return `
  SELECT toString(stat_date) stat_date, trim(BOTH ' ' FROM campaign_id) campaign_id, currency,
    sum(spend) spend, sum(fb_purchases) purchases, sum(impressions) impressions,
    sum(reach) reach, sum(clicks) clicks, sum(link_clicks) link_clicks,
    sum(purchase_value) purchase_value
  FROM ${FB} FINAL
  WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign'
    AND trim(BOTH ' ' FROM campaign_id) != ''
  GROUP BY stat_date, campaign_id, currency`;
}

/**
 * Distinct cohort (row-key, campaign_id) membership pairs from the ACTIVE
 * fact_user_cohorts snapshot, scoped by the SAME member-level filters and date
 * range as the cohort list. Pairs with empty campaign_id are excluded from the
 * join; rows whose members all lack campaign ids surface as
 * missing_cohort_campaign_id via absence.
 */
export function fbCohortMembersSql(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  params: Record<string, unknown>;
}): string {
  const { filters, params } = input;
  let where = `auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
    AND trim(BOTH ' ' FROM campaign_id) != ''`;
  if (input.dateFrom) { params.fbj_date_from = input.dateFrom; where += ` AND toString(cohort_date) >= {fbj_date_from:String}`; }
  if (input.dateTo) { params.fbj_date_to = input.dateTo; where += ` AND toString(cohort_date) <= {fbj_date_to:String}`; }
  where += inClause("funnel", filters.funnel, "fn", params);
  where += inClause("campaign_path", filters.campaign_path, "cp", params);
  where += inClause("campaign_id", filters.campaign_id, "cid", params);
  where += inClause("traffic_source", filters.traffic_source, "tsrc", params);
  where += inClause("media_buyer", filters.media_buyer, "mb", params);
  where += inClause("country", filters.country, "geo", params);
  where += inClause("card_type", filters.card_type, "card", params);
  where += inClause("currency", filters.currency, "cur", params);
  where += inClause("price_plan", filters.price_plan, "plan", params);
  return `
  SELECT DISTINCT toString(cohort_date) cohort_date, funnel, campaign_path,
    trim(BOTH ' ' FROM campaign_id) campaign_id
  FROM ${FC} FINAL
  WHERE ${where}`;
}

/** Pair-level LEFT JOIN: one output row per (cohort row key, campaign_id[, currency]). */
export function buildFbCohortJoinSql(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  params: Record<string, unknown>;
}): string {
  return `WITH members AS (${fbCohortMembersSql(input)}),
fb AS (${fbCampaignDailySql()})
SELECT m.cohort_date cohort_date, m.funnel funnel, m.campaign_path campaign_path,
  m.campaign_id campaign_id,
  f.currency currency,
  (f.campaign_id != '') matched,
  f.spend spend, f.purchases purchases, f.impressions impressions, f.reach reach,
  f.clicks clicks, f.link_clicks link_clicks, f.purchase_value purchase_value
FROM members m
LEFT JOIN fb f ON f.campaign_id = m.campaign_id AND f.stat_date = m.cohort_date
FORMAT JSONEachRow`;
}

/** Raw + campaign/day counts for diagnostics (one cheap query). */
export function fbSourceStatsSql(): string {
  return `SELECT count() raw_rows,
    uniqExact(stat_date, campaign_id) campaign_day_rows,
    uniqExact(currency) currencies,
    toString(max(stat_date)) last_stat_date
  FROM ${FB} FINAL
  WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign'
    AND trim(BOTH ' ' FROM campaign_id) != ''
  FORMAT JSONEachRow`;
}

// ---- Assembly (pure, unit-tested) -------------------------------------------

export interface FbJoinPairRow {
  cohort_date: string;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  currency?: string | null;
  matched?: number | boolean;
  spend?: unknown; purchases?: unknown; impressions?: unknown; reach?: unknown;
  clicks?: unknown; link_clicks?: unknown; purchase_value?: unknown;
}

/**
 * Fold pair-level join rows into per-cohort-row stats plus deduplicated totals.
 * `visibleKeys` — the row keys the main cohort report actually returned (post
 * HAVING filters like refund_status); totals count each (date, campaign) pair
 * once even when it feeds several visible rows.
 */
export function assembleFbCohortStats(
  pairs: FbJoinPairRow[],
  visibleKeys: Set<string>,
): { perRow: Record<string, FbCohortRowStats>; totals: FbCohortTotals; matchedPairs: number; unmatchedPairs: number; mixedCurrencyRows: number } {
  interface RowAcc extends FbAdditive { campaigns: Set<string>; currencies: Set<string>; hadAnyPair: boolean }
  const rows = new Map<string, RowAcc>();
  const totalsPairs = new Map<string, FbAdditive & { currency: string }>();
  let matchedPairs = 0;
  let unmatchedPairs = 0;

  for (const p of pairs) {
    const key = fbCohortRowKey(s(p.cohort_date), s(p.funnel), s(p.campaign_path));
    const matched = Boolean(Number(p.matched ?? 0)) || p.matched === true;
    let acc = rows.get(key);
    if (!acc) {
      acc = { ...EMPTY_ADDITIVE, campaigns: new Set(), currencies: new Set(), hadAnyPair: true };
      rows.set(key, acc);
    }
    if (!matched) {
      unmatchedPairs += 1;
      continue;
    }
    matchedPairs += 1;
    const add: FbAdditive = {
      fb_spend: n(p.spend), fb_purchases: n(p.purchases), fb_impressions: n(p.impressions),
      fb_reach: n(p.reach), fb_clicks: n(p.clicks), fb_link_clicks: n(p.link_clicks),
      fb_purchase_value: n(p.purchase_value),
    };
    // Negative spend is an upstream anomaly — excluded from sums, surfaced via diagnostics-by-absence.
    if (add.fb_spend < 0) continue;
    acc.fb_spend += add.fb_spend;
    acc.fb_purchases += add.fb_purchases;
    acc.fb_impressions += add.fb_impressions;
    acc.fb_reach += add.fb_reach;
    acc.fb_clicks += add.fb_clicks;
    acc.fb_link_clicks += add.fb_link_clicks;
    acc.fb_purchase_value += add.fb_purchase_value;
    acc.campaigns.add(p.campaign_id);
    acc.currencies.add(s(p.currency) || "USD");

    if (visibleKeys.has(key)) {
      const pairKey = `${p.cohort_date}|${p.campaign_id}|${s(p.currency) || "USD"}`;
      if (!totalsPairs.has(pairKey)) totalsPairs.set(pairKey, { ...add, currency: s(p.currency) || "USD" });
    }
  }

  const perRow: Record<string, FbCohortRowStats> = {};
  let mixedCurrencyRows = 0;
  for (const [key, acc] of rows) {
    const mixed = acc.currencies.size > 1;
    if (mixed) mixedCurrencyRows += 1;
    const additive: FbAdditive = {
      fb_spend: round2(acc.fb_spend), fb_purchases: acc.fb_purchases, fb_impressions: acc.fb_impressions,
      fb_reach: acc.fb_reach, fb_clicks: acc.fb_clicks, fb_link_clicks: acc.fb_link_clicks,
      fb_purchase_value: round2(acc.fb_purchase_value),
    };
    perRow[key] = {
      ...additive,
      // Mixed currencies must never render as a single $ figure.
      ...(mixed
        ? { fb_spend: 0, fb_purchase_value: 0, fb_cpp: null, fb_cpc: null, fb_cpm: null, fb_ctr: null, fb_roas: null }
        : deriveFbRatios(additive)),
      fb_currency: mixed ? null : (acc.currencies.values().next().value as string | undefined) ?? null,
      fb_campaigns_matched: acc.campaigns.size,
      fb_match_status: mixed ? "mixed_currency" : acc.campaigns.size > 0 ? "matched" : "no_fb_stats",
    };
  }

  const totalCurrencies = new Set<string>();
  const totalAdd: FbAdditive = { ...EMPTY_ADDITIVE };
  for (const pair of totalsPairs.values()) {
    totalCurrencies.add(pair.currency);
    totalAdd.fb_spend += pair.fb_spend;
    totalAdd.fb_purchases += pair.fb_purchases;
    totalAdd.fb_impressions += pair.fb_impressions;
    totalAdd.fb_reach += pair.fb_reach;
    totalAdd.fb_clicks += pair.fb_clicks;
    totalAdd.fb_link_clicks += pair.fb_link_clicks;
    totalAdd.fb_purchase_value += pair.fb_purchase_value;
  }
  const totalsMixed = totalCurrencies.size > 1;
  const totals: FbCohortTotals = {
    ...totalAdd,
    fb_spend: totalsMixed ? 0 : round2(totalAdd.fb_spend),
    fb_purchase_value: totalsMixed ? 0 : round2(totalAdd.fb_purchase_value),
    ...(totalsMixed
      ? { fb_cpp: null, fb_cpc: null, fb_cpm: null, fb_ctr: null, fb_roas: null }
      : deriveFbRatios(totalAdd)),
    fb_currency: totalsMixed ? null : (totalCurrencies.values().next().value as string | undefined) ?? null,
    fb_campaign_day_pairs: totalsPairs.size,
    fb_reach_total_available: false,
  };

  return { perRow, totals, matchedPairs, unmatchedPairs, mixedCurrencyRows };
}

// ---- Full server-side computation -------------------------------------------

export async function computeFbCohortStats(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  active: { warehouse_version: string; classification_version: string };
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  /** Row keys the cohort report returned (fbCohortRowKey format). */
  visibleKeys: Set<string>;
  today?: string;
}): Promise<FbCohortStatsBundle> {
  const params: Record<string, unknown> = {
    auth_user_id: input.authUserId,
    warehouse_version: input.active.warehouse_version,
    classification_version: input.active.classification_version,
  };
  const joinSql = buildFbCohortJoinSql({ filters: input.filters, dateFrom: input.dateFrom, dateTo: input.dateTo, params });

  const [pairsRs, statsRs, syncState] = await Promise.all([
    input.clickhouse.query({ query: joinSql, query_params: params, format: "JSONEachRow" }),
    input.clickhouse.query({ query: fbSourceStatsSql(), query_params: { auth_user_id: input.authUserId }, format: "JSONEachRow" }),
    getFbSyncState(input.supabase, input.authUserId).catch(() => null),
  ]);
  const pairs = (await pairsRs.json()) as FbJoinPairRow[];
  const src = ((await statsRs.json()) as Array<Record<string, unknown>>)[0] ?? {};
  const { perRow, totals, mixedCurrencyRows } = assembleFbCohortStats(pairs, input.visibleKeys);

  const sourceRows = n(src.raw_rows);
  const lastStatDate = s(src.last_stat_date);
  const syncStatus = s(syncState?.status);
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

  let dataStatus: FbDataStatus;
  if (!syncState && sourceRows === 0) dataStatus = "unavailable";
  else if (syncStatus === "running") dataStatus = "sync_pending";
  else if (sourceRows === 0) dataStatus = "empty_source";
  else if (lastStatDate && lastStatDate >= yesterday && lastStatDate !== "1970-01-01") dataStatus = "ready";
  else dataStatus = "stale";

  const matchedRows = Object.values(perRow).filter((r) => r.fb_match_status === "matched").length;
  const missingCampaignIdRows = [...input.visibleKeys].filter((k) => !(k in perRow)).length;

  return {
    perRow,
    totals,
    diagnostics: {
      fb_data_status: dataStatus,
      fb_source_rows: sourceRows,
      fb_campaign_day_rows: n(src.campaign_day_rows),
      fb_matched_cohort_rows: matchedRows,
      fb_unmatched_cohort_rows: Math.max(0, input.visibleKeys.size - matchedRows),
      fb_missing_campaign_id_rows: missingCampaignIdRows,
      fb_mixed_currency_rows: mixedCurrencyRows,
      fb_last_sync_at: s(syncState?.finished_at) || null,
      fb_warehouse_version: syncState ? fbWarehouseVersionFromState(syncState, sourceRows) : null,
      fb_join_key: "campaign_id+cohort_date",
    },
  };
}
