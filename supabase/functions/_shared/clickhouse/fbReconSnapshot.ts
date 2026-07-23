// Persistent reconciliation snapshots (roadmap rev.2 Wave 4, design §8).
// One stored row per computation turns today's ephemeral, per-request diagnostics
// into a living health history: coverage degradation is caught by the NEXT
// snapshot, not by a retrospective audit five weeks later.
//
// The six spend buckets are a PARTITION of source spend by campaign state:
//   allocated_campaign + no_user + unknown_funnel + unknown_campaign == source
// user_allocated_spend (Model 1) is reported BESIDE the partition and is never
// forced to match anything — divergence is signal, not error.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { FB_RECON_SNAPSHOTS_TABLE, ensureFbWarehouseV2Schema } from "./fbWarehouseV2Schema.ts";
import {
  campaignPeriodSpendSql,
  loadActiveCampaignAliasMap,
  loadActiveCampaignFunnelMap,
  type CampaignFunnelResolution,
  type CampaignPeriodSpendRow,
} from "./fbCampaignResolution.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_FACEBOOK_STATS_TABLE } from "./schema.ts";
import { runFbV2Parity } from "./fbV2ParityHarness.ts";

export const RECON_COVERAGE_RED_THRESHOLD = 0.9;
export const RECON_UNKNOWN_CAMPAIGN_RED_SHARE = 0.25;
export const RECON_UNKNOWN_YELLOW_SHARE = 0.1;
export const RECON_SUGGESTED_YELLOW_SHARE = 0.5;

const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface FbReconV2ParitySummary {
  verdict: "parity" | "mismatch" | "no_overlap";
  overlap_days: number;
  matched_days: number;
  mismatched_count: number;
  overlap_spend_diff: number;
}

export interface FbReconComputeInput {
  windowFrom: string;
  windowTo: string;
  campaignSpend: readonly CampaignPeriodSpendRow[];
  funnelMap: Record<string, CampaignFunnelResolution>;
  /** Layer A: observed user-side campaign id -> source campaign id. */
  aliasMap: Record<string, string>;
  /** Authoritative trial users per OBSERVED campaign id. */
  authoritativeUsers: readonly Array<{ campaign_id: string; users: number }>;
  /** Distinct stat dates with spend rows inside the window. */
  coveredDays: number;
  /** Window days already explained by facebook_known_gaps records. */
  knownGapDays: number;
  dqWarnCount: number;
  dqFailCount: number;
  /** Wave 5 gate: daily V1<->V2 parity result, recorded with the snapshot so the
   * 7-consecutive-green-days cutover criterion has a stored history. */
  v2Parity?: FbReconV2ParitySummary | null;
}

export interface FbReconSnapshotRow {
  window_from: string;
  window_to: string;
  source_spend: number;
  funnel_resolved_spend: number;
  user_allocated_spend: number;
  allocated_campaign_spend: number;
  no_user_spend: number;
  unknown_funnel_spend: number;
  unknown_campaign_spend: number;
  allocation_basis: "period_cpp_estimate";
  campaigns_total: number;
  campaigns_allocated: number;
  campaigns_no_user: number;
  campaigns_unknown_funnel: number;
  campaigns_unknown: number;
  suggested_share_pct: number;
  coverage_pct: number;
  known_gap_days: number;
  dq_warn_count: number;
  dq_fail_count: number;
  health: "green" | "yellow" | "red";
  details: {
    top_unknown_campaigns: Array<{ campaign_id: string; campaign_name: string; spend: number }>;
    top_unknown_funnel_campaigns: Array<{ campaign_id: string; campaign_name: string; spend: number }>;
    expected_days: number;
    covered_days: number;
    v2_parity: FbReconV2ParitySummary | null;
  };
}

export function computeFbReconSnapshot(input: FbReconComputeInput): FbReconSnapshotRow {
  // Resolve user-side observed ids to source ids through Layer A.
  const usersByFbCampaign = new Map<string, number>();
  for (const row of input.authoritativeUsers) {
    const observed = row.campaign_id?.trim();
    if (!observed) continue;
    const fbId = input.aliasMap[observed] ?? observed;
    usersByFbCampaign.set(fbId, (usersByFbCampaign.get(fbId) ?? 0) + row.users);
  }

  let allocatedCampaign = 0;
  let noUser = 0;
  let unknownFunnel = 0;
  let unknownCampaign = 0;
  let userAllocated = 0;
  let suggestedResolved = 0;
  const counts = { allocated: 0, no_user: 0, unknown_funnel: 0, unknown: 0 };
  const topUnknown: Array<{ campaign_id: string; campaign_name: string; spend: number }> = [];
  const topUnknownFunnel: Array<{ campaign_id: string; campaign_name: string; spend: number }> = [];

  for (const row of input.campaignSpend) {
    const users = usersByFbCampaign.get(row.campaign_id) ?? 0;
    const resolution = input.funnelMap[row.campaign_id] ?? null;
    if (resolution && resolution.match_kind === "suggested") suggestedResolved += row.spend;
    if (resolution && users > 0) {
      allocatedCampaign += row.spend;
      counts.allocated += 1;
      if (row.fb_purchases > 0) {
        // Model 1 formula at period grain: user_cpp = Campaign CPP; deliberately
        // uncapped — overallocation must stay visible, exactly like the engine.
        userAllocated += (row.spend / row.fb_purchases) * users;
      }
    } else if (resolution) {
      noUser += row.spend;
      counts.no_user += 1;
    } else if (users > 0) {
      unknownFunnel += row.spend;
      counts.unknown_funnel += 1;
      topUnknownFunnel.push({ campaign_id: row.campaign_id, campaign_name: row.campaign_name, spend: row.spend });
    } else {
      unknownCampaign += row.spend;
      counts.unknown += 1;
      topUnknown.push({ campaign_id: row.campaign_id, campaign_name: row.campaign_name, spend: row.spend });
    }
  }

  const sourceSpend = round2(input.campaignSpend.reduce((total, row) => total + row.spend, 0));
  const funnelResolved = round2(allocatedCampaign + noUser);
  const expectedDays = Math.max(
    1,
    Math.round((Date.parse(`${input.windowTo}T00:00:00Z`) - Date.parse(`${input.windowFrom}T00:00:00Z`)) / 86_400_000) + 1 - input.knownGapDays,
  );
  const coveragePct = Math.min(1, input.coveredDays / expectedDays);
  const unknownShare = sourceSpend > 0 ? (unknownFunnel + unknownCampaign) / sourceSpend : 0;
  const unknownCampaignShare = sourceSpend > 0 ? unknownCampaign / sourceSpend : 0;
  const suggestedSharePct = funnelResolved > 0 ? round2((suggestedResolved / funnelResolved) * 100) : 0;

  let health: FbReconSnapshotRow["health"] = "green";
  if (
    input.dqWarnCount > 0 ||
    unknownShare > RECON_UNKNOWN_YELLOW_SHARE ||
    suggestedSharePct > RECON_SUGGESTED_YELLOW_SHARE * 100 ||
    coveragePct < 1 ||
    // Dual-write drift between V1 and V2 is a data-integrity warning (no_overlap
    // is fine — V2 simply has no published batches for the window yet).
    input.v2Parity?.verdict === "mismatch"
  ) {
    health = "yellow";
  }
  if (input.dqFailCount > 0 || coveragePct < RECON_COVERAGE_RED_THRESHOLD || unknownCampaignShare > RECON_UNKNOWN_CAMPAIGN_RED_SHARE) {
    health = "red";
  }

  const top = (rows: typeof topUnknown) => rows.sort((a, b) => b.spend - a.spend).slice(0, 10).map((row) => ({ ...row, spend: round2(row.spend) }));

  return {
    window_from: input.windowFrom,
    window_to: input.windowTo,
    source_spend: sourceSpend,
    funnel_resolved_spend: funnelResolved,
    user_allocated_spend: round2(userAllocated),
    allocated_campaign_spend: round2(allocatedCampaign),
    no_user_spend: round2(noUser),
    unknown_funnel_spend: round2(unknownFunnel),
    unknown_campaign_spend: round2(unknownCampaign),
    allocation_basis: "period_cpp_estimate",
    campaigns_total: input.campaignSpend.length,
    campaigns_allocated: counts.allocated,
    campaigns_no_user: counts.no_user,
    campaigns_unknown_funnel: counts.unknown_funnel,
    campaigns_unknown: counts.unknown,
    suggested_share_pct: suggestedSharePct,
    coverage_pct: round2(coveragePct * 100) / 100,
    known_gap_days: input.knownGapDays,
    dq_warn_count: input.dqWarnCount,
    dq_fail_count: input.dqFailCount,
    health,
    details: {
      top_unknown_campaigns: top(topUnknown),
      top_unknown_funnel_campaigns: top(topUnknownFunnel),
      expected_days: expectedDays,
      covered_days: input.coveredDays,
      v2_parity: input.v2Parity ?? null,
    },
  };
}

// ---- Orchestration ----------------------------------------------------------

async function jsonRows<T>(client: ClickHouseClientLike, query: string, params: Record<string, unknown>): Promise<T[]> {
  const rs = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}

export async function runFbReconSnapshot(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  dateFrom: string;
  dateTo: string;
}): Promise<FbReconSnapshotRow> {
  const params = { auth_user_id: input.authUserId, date_from: input.dateFrom, date_to: input.dateTo };

  const [spendRows, coveredRows, authoritative, funnelMap, aliasMap, gaps, dq, v2Parity] = await Promise.all([
    jsonRows<CampaignPeriodSpendRow>(input.clickhouse, campaignPeriodSpendSql({ hasFrom: true, hasTo: true }), params),
    jsonRows<{ covered_days: number }>(
      input.clickhouse,
      `SELECT uniqExact(stat_date) AS covered_days FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String} AND level = 'campaign'
         AND stat_date >= {date_from:String} AND stat_date <= {date_to:String}`,
      params,
    ),
    jsonRows<{ campaign_id: string; users: number }>(
      input.clickhouse,
      `SELECT campaign_id, uniqExact(user_id) AS users FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String} AND status = 'success' AND transaction_type = 'trial' AND campaign_id != ''
       GROUP BY campaign_id`,
      params,
    ),
    loadActiveCampaignFunnelMap(input.supabase, input.authUserId),
    loadActiveCampaignAliasMap(input.supabase, input.authUserId),
    input.supabase
      .from("facebook_known_gaps")
      .select("gap_from,gap_to")
      .eq("auth_user_id", input.authUserId)
      .then((result) => (result.error ? [] : ((result.data ?? []) as Array<{ gap_from: string; gap_to: string }>))),
    jsonRows<{ warn_count: number; fail_count: number }>(
      input.clickhouse,
      `SELECT countIf(status = 'warn') AS warn_count, countIf(status = 'fail') AS fail_count
       FROM facebook_dq_results
       WHERE auth_user_id = {auth_user_id:String}
         AND batch_id = (SELECT argMax(batch_id, computed_at) FROM facebook_dq_results WHERE auth_user_id = {auth_user_id:String})`,
      params,
    ).catch(() => [{ warn_count: 0, fail_count: 0 }]),
    // Wave 5 gate: record the daily V1<->V2 parity with the snapshot. Fail-safe —
    // a missing V2 schema must not break reconciliation.
    runFbV2Parity({ clickhouse: input.clickhouse, authUserId: input.authUserId, dateFrom: input.dateFrom, dateTo: input.dateTo })
      .then((report) => ({
        verdict: report.verdict,
        overlap_days: report.overlap_days,
        matched_days: report.matched_days,
        mismatched_count: report.mismatched_days.length,
        overlap_spend_diff: report.totals.overlap_spend_diff,
      }))
      .catch(() => null),
  ]);

  const knownGapDays = gaps.reduce((total, gap) => {
    const from = gap.gap_from > input.dateFrom ? gap.gap_from : input.dateFrom;
    const to = gap.gap_to < input.dateTo ? gap.gap_to : input.dateTo;
    const overlap = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    return total + Math.max(0, overlap);
  }, 0);

  const snapshot = computeFbReconSnapshot({
    windowFrom: input.dateFrom,
    windowTo: input.dateTo,
    campaignSpend: spendRows.map((row) => ({
      campaign_id: String(row.campaign_id),
      campaign_name: String(row.campaign_name ?? ""),
      spend: Number(row.spend) || 0,
      fb_purchases: Number(row.fb_purchases) || 0,
    })),
    funnelMap,
    aliasMap,
    authoritativeUsers: authoritative.map((row) => ({ campaign_id: String(row.campaign_id), users: Number(row.users) || 0 })),
    coveredDays: Number(coveredRows[0]?.covered_days) || 0,
    knownGapDays,
    dqWarnCount: Number(dq[0]?.warn_count) || 0,
    dqFailCount: Number(dq[0]?.fail_count) || 0,
    v2Parity,
  });

  // Store the snapshot (append-only history — this is the whole point).
  await ensureFbWarehouseV2Schema(input.clickhouse);
  await input.clickhouse.insert({
    table: FB_RECON_SNAPSHOTS_TABLE,
    values: [{
      auth_user_id: input.authUserId,
      snapshot_id: crypto.randomUUID(),
      computed_at: new Date().toISOString(),
      ...snapshot,
      details: JSON.stringify(snapshot.details),
    }],
    format: "JSONEachRow",
  });

  return snapshot;
}

export async function listFbReconSnapshots(
  clickhouse: ClickHouseClientLike,
  authUserId: string,
  limit = 30,
): Promise<Array<Record<string, unknown>>> {
  const capped = Math.max(1, Math.min(200, Math.floor(limit)));
  return jsonRows<Record<string, unknown>>(
    clickhouse,
    `SELECT * FROM ${FB_RECON_SNAPSHOTS_TABLE}
     WHERE auth_user_id = {auth_user_id:String}
     ORDER BY computed_at DESC
     LIMIT ${capped}`,
    { auth_user_id: authUserId },
  );
}
