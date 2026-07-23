// Warehouse V2 read-cutover parity harness (design §9 Фаза 3, roadmap Wave 5).
// Compares V1 (fact_facebook_stats, campaign level) against the V2 published view
// (v_fb_campaign_daily_current) day by day. The cutover gate: spend/purchases agree
// within $0.01 on every overlapping day. Days present on one side only are reported
// separately — V2 coverage grows batch by batch and a coverage hole is not a parity
// mismatch.

import type { ClickHouseClientLike } from "./types.ts";
import { FACT_FACEBOOK_STATS_TABLE } from "./schema.ts";
import { V_FB_CAMPAIGN_DAILY_CURRENT } from "./fbWarehouseV2Schema.ts";

export const FB_V2_PARITY_MONEY_TOLERANCE = 0.01;

export interface FbV2ParityDaySide {
  stat_date: string;
  spend: number;
  fb_purchases: number;
  rows: number;
}

export interface FbV2ParityDayDiff {
  stat_date: string;
  v1_spend: number;
  v2_spend: number;
  spend_diff: number;
  v1_purchases: number;
  v2_purchases: number;
  purchases_diff: number;
  v1_rows: number;
  v2_rows: number;
}

export interface FbV2ParityReport {
  date_from: string;
  date_to: string;
  overlap_days: number;
  matched_days: number;
  mismatched_days: FbV2ParityDayDiff[];
  v1_only_days: string[];
  v2_only_days: string[];
  totals: {
    v1_spend: number;
    v2_spend: number;
    v1_purchases: number;
    v2_purchases: number;
    overlap_v1_spend: number;
    overlap_v2_spend: number;
    overlap_spend_diff: number;
  };
  verdict: "parity" | "mismatch" | "no_overlap";
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function compareFbV2Parity(input: {
  dateFrom: string;
  dateTo: string;
  v1: readonly FbV2ParityDaySide[];
  v2: readonly FbV2ParityDaySide[];
}): FbV2ParityReport {
  const v1ByDay = new Map(input.v1.map((row) => [row.stat_date, row]));
  const v2ByDay = new Map(input.v2.map((row) => [row.stat_date, row]));

  const mismatches: FbV2ParityDayDiff[] = [];
  let matched = 0;
  let overlapV1Spend = 0;
  let overlapV2Spend = 0;

  for (const [day, v1Row] of v1ByDay) {
    const v2Row = v2ByDay.get(day);
    if (!v2Row) continue;
    overlapV1Spend += v1Row.spend;
    overlapV2Spend += v2Row.spend;
    const spendDiff = round2(v1Row.spend - v2Row.spend);
    const purchasesDiff = v1Row.fb_purchases - v2Row.fb_purchases;
    if (Math.abs(spendDiff) <= FB_V2_PARITY_MONEY_TOLERANCE && purchasesDiff === 0) {
      matched += 1;
    } else {
      mismatches.push({
        stat_date: day,
        v1_spend: round2(v1Row.spend),
        v2_spend: round2(v2Row.spend),
        spend_diff: spendDiff,
        v1_purchases: v1Row.fb_purchases,
        v2_purchases: v2Row.fb_purchases,
        purchases_diff: purchasesDiff,
        v1_rows: v1Row.rows,
        v2_rows: v2Row.rows,
      });
    }
  }

  const v1Only = [...v1ByDay.keys()].filter((day) => !v2ByDay.has(day)).sort();
  const v2Only = [...v2ByDay.keys()].filter((day) => !v1ByDay.has(day)).sort();
  const overlap = matched + mismatches.length;

  return {
    date_from: input.dateFrom,
    date_to: input.dateTo,
    overlap_days: overlap,
    matched_days: matched,
    mismatched_days: mismatches.sort((a, b) => a.stat_date.localeCompare(b.stat_date)),
    v1_only_days: v1Only,
    v2_only_days: v2Only,
    totals: {
      v1_spend: round2(input.v1.reduce((total, row) => total + row.spend, 0)),
      v2_spend: round2(input.v2.reduce((total, row) => total + row.spend, 0)),
      v1_purchases: input.v1.reduce((total, row) => total + row.fb_purchases, 0),
      v2_purchases: input.v2.reduce((total, row) => total + row.fb_purchases, 0),
      overlap_v1_spend: round2(overlapV1Spend),
      overlap_v2_spend: round2(overlapV2Spend),
      overlap_spend_diff: round2(overlapV1Spend - overlapV2Spend),
    },
    verdict: overlap === 0 ? "no_overlap" : mismatches.length === 0 ? "parity" : "mismatch",
  };
}

function daySideSql(source: string, level: "v1" | "v2"): string {
  const levelFilter = level === "v1" ? "AND level = 'campaign'" : "";
  return `
    SELECT toString(stat_date) AS stat_date,
      round(sum(spend), 2) AS spend,
      sum(fb_purchases) AS fb_purchases,
      count() AS rows
    FROM ${source}
    WHERE auth_user_id = {auth_user_id:String}
      ${levelFilter}
      AND stat_date >= {date_from:String} AND stat_date <= {date_to:String}
    GROUP BY stat_date
  `;
}

export async function runFbV2Parity(input: {
  clickhouse: ClickHouseClientLike;
  authUserId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<FbV2ParityReport> {
  const params = { auth_user_id: input.authUserId, date_from: input.dateFrom, date_to: input.dateTo };
  const fetchSide = async (query: string): Promise<FbV2ParityDaySide[]> => {
    const rs = await input.clickhouse.query({ query, query_params: params, format: "JSONEachRow" });
    return ((await rs.json()) as FbV2ParityDaySide[]).map((row) => ({
      stat_date: String(row.stat_date),
      spend: Number(row.spend) || 0,
      fb_purchases: Number(row.fb_purchases) || 0,
      rows: Number(row.rows) || 0,
    }));
  };
  const [v1, v2] = await Promise.all([
    fetchSide(daySideSql(`${FACT_FACEBOOK_STATS_TABLE} FINAL`, "v1")),
    fetchSide(daySideSql(V_FB_CAMPAIGN_DAILY_CURRENT, "v2")),
  ]);
  return compareFbV2Parity({ dateFrom: input.dateFrom, dateTo: input.dateTo, v1, v2 });
}
