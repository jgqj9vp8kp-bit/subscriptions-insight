import { campaignIdForTransaction } from "@/services/cohortFiltering";
import { mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import type { MediaBuyer, Transaction } from "@/services/types";

export interface CampaignPerformanceFilters {
  date_from?: string | null;
  date_to?: string | null;
  campaign_path?: string | null;
  media_buyer?: MediaBuyer | string | null;
  campaign_id?: string | null;
}

// The exact payload contract of the export-campaign-performance API: one row per
// (campaign_id, campaign_path, funnel) with conversion counts only. media_buyer remains a request
// filter but is neither a grouping dimension nor a payload field. Mirrors
// supabase/functions/export-campaign-performance/index.ts buildRows().
export interface CampaignPerformanceRow {
  campaign_id: string;
  campaign_path: string;
  funnel: string;
  date_from: string | null;
  date_to: string | null;
  trial_users: number;
  upsell_users: number;
  upsell_cr: number;
  first_sub_users: number;
  trial_to_first_sub_cr: number;
  refund_users: number;
}

interface AttributedUser {
  userId: string;
  transactions: Transaction[];
  campaignId: string;
  campaignPath: string;
  funnel: string;
}

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

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
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
  return [...txs]
    .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
    .sort((a, b) => a.event_time.localeCompare(b.event_time))[0] ?? null;
}

function attributedUsers(txs: Transaction[], filters: CampaignPerformanceFilters): AttributedUser[] {
  const from = dateKey(filters.date_from);
  const to = dateKey(filters.date_to);
  const campaignPathFilter = normalizePath(filters.campaign_path);
  const mediaBuyerFilter = normalizeFilter(filters.media_buyer);
  const campaignIdFilter = normalizeFilter(filters.campaign_id);
  const users: AttributedUser[] = [];

  transactionsByUser(txs).forEach((transactions, userId) => {
    const trial = firstSuccessfulTrial(transactions);
    if (!trial) return;

    const trialDate = dateKey(trial.cohort_date ?? trial.event_time);
    if (!trialDate) return;
    if (from && trialDate < from) return;
    if (to && trialDate > to) return;

    const campaignId = campaignIdForTransaction(trial);
    if (campaignIdFilter && campaignId !== campaignIdFilter) return;

    const campaignPath = trial.campaign_path || "unknown";
    if (campaignPathFilter && normalizePath(campaignPath) !== campaignPathFilter) return;

    if (mediaBuyerFilter && mediaBuyerForUserTransactions(transactions).media_buyer !== mediaBuyerFilter) return;

    users.push({
      userId,
      transactions,
      campaignId,
      campaignPath,
      funnel: trial.funnel || "unknown",
    });
  });

  return users;
}

function groupKey(user: AttributedUser): string {
  return [user.campaignId, user.campaignPath, user.funnel].join("||");
}

export function buildCampaignPerformanceExport(input: {
  txs: Transaction[];
  filters?: CampaignPerformanceFilters;
}): CampaignPerformanceRow[] {
  const filters = input.filters ?? {};
  const users = attributedUsers(input.txs, filters);
  const grouped = new Map<string, AttributedUser[]>();
  for (const user of users) {
    const key = groupKey(user);
    grouped.set(key, [...(grouped.get(key) ?? []), user]);
  }

  return Array.from(grouped.values())
    .map((groupUsers) => {
      const first = groupUsers[0];
      const groupTxs = groupUsers.flatMap((user) => user.transactions);
      const userIds = new Set(groupUsers.map((user) => user.userId));
      const upsellUsers = new Set(
        groupTxs
          .filter((tx) => tx.status === "success" && tx.transaction_type === "upsell")
          .map((tx) => tx.user_id || tx.email || tx.transaction_id),
      ).size;
      const firstSubUsers = new Set(
        groupTxs
          .filter((tx) => tx.status === "success" && tx.transaction_type === "first_subscription")
          .map((tx) => tx.user_id || tx.email || tx.transaction_id),
      ).size;
      const refundUsers = new Set(
        groupTxs
          .filter((tx) => tx.is_refunded || tx.transaction_type === "refund" || (tx.refund_amount_usd ?? 0) > 0)
          .map((tx) => tx.user_id || tx.email || tx.transaction_id),
      ).size;

      return {
        campaign_id: first.campaignId,
        campaign_path: first.campaignPath,
        funnel: first.funnel,
        date_from: dateKey(filters.date_from),
        date_to: dateKey(filters.date_to),
        trial_users: userIds.size,
        upsell_users: upsellUsers,
        upsell_cr: userIds.size ? roundRatio(upsellUsers / userIds.size) : 0,
        first_sub_users: firstSubUsers,
        trial_to_first_sub_cr: userIds.size ? roundRatio(firstSubUsers / userIds.size) : 0,
        refund_users: refundUsers,
      } satisfies CampaignPerformanceRow;
    })
    .sort((a, b) => b.trial_users - a.trial_users || a.campaign_id.localeCompare(b.campaign_id));
}
