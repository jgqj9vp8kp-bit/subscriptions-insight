import { campaignIdForTransaction, campaignIdLabel, UNKNOWN_CAMPAIGN_ID } from "@/services/cohortFiltering";
import { mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import type { MediaBuyer, Transaction } from "@/services/types";

// Internal, read-only diagnostic: how often a single campaign_id spans more than one
// (campaign_path, funnel) combination, and what share of trial traffic those campaigns carry.
//
// User attribution intentionally MIRRORS the export-campaign-performance grouping
// (supabase/functions/export-campaign-performance/index.ts buildRows + campaignPerformanceExport.ts):
// a user is anchored to their FIRST successful trial / entry transaction, and campaign_id /
// campaign_path / funnel are read from that trial. This diagnostic does NOT change any grouping;
// it only measures it. Output is aggregate-only — no emails, user ids, or raw payloads.

export interface CampaignIdSplitFilters {
  date_from?: string | null;
  date_to?: string | null;
  media_buyer?: MediaBuyer | string | null;
  campaign_path?: string | null;
}

export interface CampaignIdSplitRow {
  campaign_id: string;
  campaign_id_label: string;
  number_of_paths: number;
  number_of_funnels: number;
  number_of_combinations: number;
  trial_users: number;
  /** Share of total trial users, as a percentage (0–100), rounded to 2 dp. */
  traffic_share: number;
  /** number_of_combinations > 1 AND not the Unknown bucket. */
  is_split: boolean;
  is_unknown: boolean;
  paths: string[];
  funnels: string[];
}

export interface CampaignIdSplitAnalysis {
  total_campaign_ids: number;
  split_campaign_ids: number;
  total_trial_users: number;
  split_trial_users: number;
  /** split_trial_users / total_trial_users as a percentage (0–100), rounded to 2 dp. */
  split_traffic_share: number;
  unknown_trial_users: number;
  rows: CampaignIdSplitRow[];
  recommendation: string;
}

export const SPLIT_SHARE_THRESHOLD_PCT = 1;
export const RECOMMENDATION_GROUP_BY_ID = "Recommendation: group Export API by campaign_id only.";
export const RECOMMENDATION_KEEP_CURRENT =
  "Recommendation: keep Export API grouped by campaign_id + campaign_path + funnel.";

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function normalizeFilter(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

function normalizePath(value: string | null | undefined): string {
  return normalizeFilter(value).replace(/^\/+/, "").toLowerCase();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function transactionsByUser(txs: Transaction[]): Map<string, Transaction[]> {
  const byUser = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const userKey = tx.user_id || tx.email || tx.transaction_id;
    const list = byUser.get(userKey) ?? [];
    list.push(tx);
    byUser.set(userKey, list);
  }
  return byUser;
}

function firstSuccessfulTrial(txs: Transaction[]): Transaction | null {
  return (
    [...txs]
      .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
      .sort((a, b) => a.event_time.localeCompare(b.event_time))[0] ?? null
  );
}

interface AttributedTrial {
  campaignId: string;
  campaignPath: string;
  funnel: string;
}

function attributedTrials(txs: Transaction[], filters: CampaignIdSplitFilters): AttributedTrial[] {
  const from = dateKey(filters.date_from);
  const to = dateKey(filters.date_to);
  const campaignPathFilter = normalizePath(filters.campaign_path);
  const mediaBuyerFilter = normalizeFilter(filters.media_buyer);
  const trials: AttributedTrial[] = [];

  transactionsByUser(txs).forEach((transactions) => {
    const trial = firstSuccessfulTrial(transactions);
    if (!trial) return;

    const trialDate = dateKey(trial.cohort_date ?? trial.event_time);
    if (!trialDate) return;
    if (from && trialDate < from) return;
    if (to && trialDate > to) return;

    const campaignPath = trial.campaign_path || "unknown";
    if (campaignPathFilter && normalizePath(campaignPath) !== campaignPathFilter) return;

    if (mediaBuyerFilter && mediaBuyerForUserTransactions(transactions).media_buyer !== mediaBuyerFilter) return;

    trials.push({
      campaignId: campaignIdForTransaction(trial),
      campaignPath,
      funnel: trial.funnel || "unknown",
    });
  });

  return trials;
}

export function analyzeCampaignIdSplits(
  transactions: Transaction[],
  filters: CampaignIdSplitFilters = {},
): CampaignIdSplitAnalysis {
  const trials = attributedTrials(transactions, filters);
  const total_trial_users = trials.length;

  const byId = new Map<string, { paths: Set<string>; funnels: Set<string>; combos: Set<string>; trialUsers: number }>();
  for (const trial of trials) {
    const entry = byId.get(trial.campaignId) ?? { paths: new Set<string>(), funnels: new Set<string>(), combos: new Set<string>(), trialUsers: 0 };
    entry.paths.add(trial.campaignPath);
    entry.funnels.add(trial.funnel);
    entry.combos.add(`${trial.campaignPath}||${trial.funnel}`);
    entry.trialUsers += 1;
    byId.set(trial.campaignId, entry);
  }

  const sharePct = (count: number): number => (total_trial_users ? round2((count / total_trial_users) * 100) : 0);

  const rows: CampaignIdSplitRow[] = Array.from(byId.entries())
    .map(([campaign_id, entry]) => {
      const is_unknown = campaign_id === UNKNOWN_CAMPAIGN_ID;
      const number_of_combinations = entry.combos.size;
      return {
        campaign_id,
        campaign_id_label: campaignIdLabel(campaign_id),
        number_of_paths: entry.paths.size,
        number_of_funnels: entry.funnels.size,
        number_of_combinations,
        trial_users: entry.trialUsers,
        traffic_share: sharePct(entry.trialUsers),
        is_split: number_of_combinations > 1 && !is_unknown,
        is_unknown,
        paths: Array.from(entry.paths).sort(),
        funnels: Array.from(entry.funnels).sort(),
      } satisfies CampaignIdSplitRow;
    })
    .sort((a, b) => b.trial_users - a.trial_users || a.campaign_id.localeCompare(b.campaign_id));

  const splitRows = rows.filter((row) => row.is_split);
  const split_trial_users = splitRows.reduce((total, row) => total + row.trial_users, 0);
  const unknown_trial_users = rows.filter((row) => row.is_unknown).reduce((total, row) => total + row.trial_users, 0);
  const split_traffic_share = sharePct(split_trial_users);

  return {
    total_campaign_ids: rows.length,
    split_campaign_ids: splitRows.length,
    total_trial_users,
    split_trial_users,
    split_traffic_share,
    unknown_trial_users,
    rows,
    recommendation: split_traffic_share < SPLIT_SHARE_THRESHOLD_PCT ? RECOMMENDATION_GROUP_BY_ID : RECOMMENDATION_KEEP_CURRENT,
  };
}
