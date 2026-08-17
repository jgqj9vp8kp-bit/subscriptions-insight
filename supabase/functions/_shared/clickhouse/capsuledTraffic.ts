// Campaign-path resolution for the Capsuled traffic snapshot.
//
// The traffic-derived columns (Spend / CAC / profit / ROAS on Cohorts,
// FBAnalytics, Forecasting, PlanMode) join traffic rows to cohort rows by
// (date, campaign_path). In the Google-Sheet era the join was guaranteed by
// hand: media buyers filled an ff_campaign_path column with the funnel path.
// Capsuled rows only carry Meta campaign NAMES ("02,1 - Video Soulmate-cbo…"),
// which never equal funnel paths, so a snapshot built from names silently
// un-joins every traffic column into dashes.
//
// This module rebuilds the funnel path per campaign from authoritative
// evidence: the campaign_path observed on that campaign's successful trial
// transactions. The rule mirrors Layer B (fbCampaignResolution): a campaign
// resolves only when its trial users agree on exactly ONE path and there are
// at least PATH_EVIDENCE_MIN_USERS of them. Ambiguous or thin evidence keeps
// the old name fallback — the row simply stays un-joined instead of guessing.
// Measured live 2026-08-17: 242/443 campaigns resolve = 93.9% of all spend,
// and no campaign had a dominant-but-not-unique path (strict == dominant).

import { normalizeCampaignPath, type CapsuledFacebookRow, type TrafficMetric } from "./trafficMetric.ts";

export interface CampaignPathEvidenceRow {
  campaign_id: string;
  campaign_path: string;
  trial_users: number;
}

export const PATH_EVIDENCE_MIN_USERS = 3;

/** Evidence -> campaign_id -> funnel path. `aliases` is Layer A
 * (observed utm campaign id -> Meta spend-side id): evidence observed under a
 * duplicated campaign's utm id transfers to the id Capsuled reports spend
 * under, but never overwrites the spend-side id's own evidence. */
export function resolveCampaignPaths(
  evidence: readonly CampaignPathEvidenceRow[],
  aliases: Readonly<Record<string, string>> = {},
): Map<string, string> {
  const byCampaign = new Map<string, Map<string, number>>();
  for (const row of evidence) {
    const id = String(row.campaign_id ?? "").trim();
    const path = normalizeCampaignPath(row.campaign_path);
    const users = Number(row.trial_users) || 0;
    if (!id || !path || users <= 0) continue;
    const paths = byCampaign.get(id) ?? new Map<string, number>();
    paths.set(path, (paths.get(path) ?? 0) + users);
    byCampaign.set(id, paths);
  }

  const resolved = new Map<string, string>();
  for (const [id, paths] of byCampaign) {
    if (paths.size !== 1) continue; // ambiguous: users split across paths
    const [path, users] = [...paths.entries()][0];
    if (users < PATH_EVIDENCE_MIN_USERS) continue; // thin evidence
    resolved.set(id, path);
  }

  for (const [observed, fbId] of Object.entries(aliases)) {
    if (!resolved.has(fbId) && resolved.has(observed)) {
      resolved.set(fbId, resolved.get(observed)!);
    }
  }
  return resolved;
}

/** One Capsuled campaign-level stats row -> a TrafficMetric snapshot row.
 * campaign_path prefers the evidence-resolved funnel path; unresolved
 * campaigns keep the historical name fallback (un-joined but still counted in
 * date-level totals on Dashboard/Import). */
export function capsuledTrafficMetric(
  row: CapsuledFacebookRow,
  pathByCampaign: ReadonlyMap<string, string>,
): TrafficMetric {
  const resolvedPath = row.campaign_id ? pathByCampaign.get(row.campaign_id) : undefined;
  return {
    date: row.date_from,
    campaign_path: resolvedPath || row.campaign_name || row.campaign_id || "capsuled",
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name,
    ad_account_id: row.ad_account_id,
    ad_account_name: row.ad_account_name,
    trial_count: row.fb_purchases,
    cac: row.fb_purchases ? row.spend / row.fb_purchases : 0,
    spend: row.spend,
    fb_purchases: row.fb_purchases,
    cpp: row.cpp,
    impressions: row.impressions,
    clicks: row.clicks,
    cpc: row.cpc ?? 0,
    cpm: row.cpm ?? 0,
    ctr: row.ctr ?? 0,
    outbound_clicks: row.outbound_clicks,
    outbound_ctr: row.outbound_ctr,
    currency: row.currency,
    last_import_at: row.last_import_at,
    source: "facebook",
  };
}

// ---- Daily-split sync helpers -----------------------------------------------
//
// The Capsuled API aggregates a multi-day campaign-level window into ONE row
// per campaign (date_from..date_to). A snapshot dates each row by date_from,
// so a week of spend collapses onto its first day and the other days show
// dashes. The sync therefore fetches campaign-level windows DAY BY DAY; after
// a fully successful daily window, period rows the window supersedes are
// removed so daily and period aggregates of the same days never double-count.

/** Hard cap on the daily-split window (one API call per day; keeps the edge
 * invocation far below the wall-clock limit). */
export const MAX_DAILY_SPLIT_DAYS = 62;

/** Inclusive ISO day list for [from, to]. Empty when the range is invalid. */
export function enumerateDays(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return [];
  const days: string[] = [];
  for (let t = start; t <= end; t += 86_400_000) {
    days.push(new Date(t).toISOString().slice(0, 10));
  }
  return days;
}

/** Ids of multi-day period rows fully contained in [from, to] — superseded by
 * the daily rows just written for that window. Daily rows (date_from ==
 * date_to) and rows extending beyond the window are never selected. */
export function supersededPeriodRowIds(
  rows: ReadonlyArray<{ id: string; date_from: string; date_to: string }>,
  from: string,
  to: string,
): string[] {
  return rows
    .filter((row) => row.date_from !== row.date_to && row.date_from >= from && row.date_to <= to)
    .map((row) => row.id);
}

export interface CapsuledPathMappingStats {
  resolved_campaigns: number;
  mapped_rows: number;
  total_rows: number;
  mapped_spend: number;
  total_spend: number;
}

/** Snapshot-metadata observability: how much of the snapshot actually joins. */
export function pathMappingStats(
  rows: readonly CapsuledFacebookRow[],
  pathByCampaign: ReadonlyMap<string, string>,
): CapsuledPathMappingStats {
  let mappedRows = 0;
  let mappedSpend = 0;
  let totalSpend = 0;
  for (const row of rows) {
    totalSpend += row.spend;
    if (row.campaign_id && pathByCampaign.has(row.campaign_id)) {
      mappedRows += 1;
      mappedSpend += row.spend;
    }
  }
  return {
    resolved_campaigns: pathByCampaign.size,
    mapped_rows: mappedRows,
    total_rows: rows.length,
    mapped_spend: Math.round(mappedSpend * 100) / 100,
    total_spend: Math.round(totalSpend * 100) / 100,
  };
}
