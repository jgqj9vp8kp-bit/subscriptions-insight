import type { CohortRow } from "@/services/types";
import { normalizeCampaignPath, type TrafficMetric } from "@/services/trafficImport";

export type TrafficAggregate = TrafficMetric & {
  row_count: number;
};

export type CohortTraffic = {
  spend: number;
  cac: number;
  trial_count: number;
  clicks: number;
  cpc: number;
  cpm: number | null;
  ctr: number | null;
};

export interface CohortReportTotals {
  totalTrialUsers: number;
  totalUpsellUsers: number;
  totalFirstSubscriptionUsers: number;
  totalRenewal2Users: number;
  totalRenewal3Users: number;
  totalRenewalUsers: number;
  totalRefundUsers: number;
  totalActiveUsers: number;
  totalActiveSubscriptions: number;
  totalCancelledUsers: number;
  totalUserCancelledUsers: number;
  totalAutoCancelledUsers: number;
  totalCancelledActiveUsers: number;
  totalActiveRate: number;
  totalActiveSubscriptionsRate: number;
  totalCancellationRate: number;
  totalUserCancelRate: number;
  totalAutoCancelRate: number;
  trialRevenue: number;
  upsellRevenue: number;
  firstSubscriptionRevenue: number;
  renewalRevenue: number;
  amountRefunded: number;
  refundRate: number;
  grossRevenue: number;
  netRevenue: number;
  revenueD0: number;
  revenueD7: number;
  revenueD30: number;
  revenueD60: number;
  trafficSpend: number;
  hasTrafficSpend: boolean;
  hasCompleteTrafficSpend: boolean;
  profit: number;
  profitD7: number;
  profit1m: number;
  profit2m: number;
  trafficTrials: number;
  trafficClicks: number;
  trafficCac: number;
  trafficCpc: number;
  roasD7: number;
  roas1m: number;
  roas2m: number;
  trialToUpsellCr: number;
  trialToFirstSubscriptionCr: number;
  firstSubscriptionToRenewal2Cr: number;
  renewal2ToRenewal3Cr: number;
}

function normalizeCohortDate(date: string): string {
  const trimmed = String(date ?? "").trim();
  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return trimmed;
  const yyyy = parsed.getFullYear();
  const mm = String(parsed.getMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeCohortCampaignPath(campaignPath: string): string {
  return String(campaignPath ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}

export function trafficKey(date: string, campaignPath: string): string {
  return `${normalizeCohortDate(date)}__${normalizeCampaignPath(campaignPath)}`;
}

export function cohortTrafficKey(row: CohortRow): string {
  return `${normalizeCohortDate(row.cohort_date)}__${normalizeCohortCampaignPath(row.campaign_path)}`;
}

export function aggregateTrafficMetrics(rows: TrafficMetric[]): Map<string, TrafficAggregate> {
  const map = new Map<string, TrafficAggregate>();
  for (const row of rows) {
    const key = trafficKey(row.date, row.campaign_path);
    const current = map.get(key);
    if (!current) {
      map.set(key, { ...row, row_count: 1 });
      continue;
    }
    current.trial_count += row.trial_count;
    current.spend += row.spend;
    current.clicks += row.clicks;
    current.cac = current.trial_count ? current.spend / current.trial_count : 0;
    current.cpc = current.clicks ? current.spend / current.clicks : 0;
    current.cpm = 0;
    current.ctr = 0;
    current.row_count += 1;
  }
  return map;
}

export function trafficForCohort(row: CohortRow, trafficByKey: Map<string, TrafficAggregate>): CohortTraffic | null {
  const traffic = trafficByKey.get(cohortTrafficKey(row));
  if (!traffic) return null;
  return {
    spend: traffic.spend,
    cac: traffic.trial_count ? traffic.spend / traffic.trial_count : traffic.cac,
    trial_count: traffic.trial_count,
    clicks: traffic.clicks,
    cpc: traffic.clicks ? traffic.spend / traffic.clicks : traffic.cpc,
    cpm: traffic.row_count === 1 ? traffic.cpm : null,
    ctr: traffic.row_count === 1 ? traffic.ctr : null,
  };
}

export function computeCohortReportTotals(
  cohorts: CohortRow[],
  trafficByKey: Map<string, TrafficAggregate> = new Map(),
): CohortReportTotals {
  const sum = (pick: (c: CohortRow) => number) => cohorts.reduce((total, cohort) => total + pick(cohort), 0);
  const totalTrialUsers = sum((c) => c.trial_users);
  const totalUpsellUsers = sum((c) => c.upsell_users);
  const totalFirstSubscriptionUsers = sum((c) => c.first_subscription_users);
  const totalRenewal2Users = sum((c) => c.renewal_2_users);
  const totalRenewal3Users = sum((c) => c.renewal_3_users);
  const totalRenewalUsers = sum((c) => c.renewal_users);
  const totalRefundUsers = new Set(cohorts.flatMap((c) => c.refunded_user_ids)).size;
  const totalActiveUsers = new Set(cohorts.flatMap((c) => c.active_user_ids)).size;
  const totalActiveSubscriptions = new Set(cohorts.flatMap((c) => c.active_subscription_user_ids)).size;
  const totalCancelledUsers = new Set(cohorts.flatMap((c) => c.cancelled_user_ids)).size;
  const totalUserCancelledUsers = new Set(cohorts.flatMap((c) => c.user_cancelled_user_ids)).size;
  const totalAutoCancelledUsers = new Set(cohorts.flatMap((c) => c.auto_cancelled_user_ids)).size;
  const totalCancelledActiveUsers = new Set(cohorts.flatMap((c) => c.cancelled_active_user_ids)).size;
  const amountRefunded = sum((c) => c.amount_refunded);
  const grossRevenue = sum((c) => c.gross_revenue);
  const netRevenue = sum((c) => c.net_revenue);
  const trafficRows = cohorts.map((c) => trafficForCohort(c, trafficByKey)).filter(Boolean) as CohortTraffic[];
  const hasTrafficSpend = trafficRows.length > 0;
  const hasCompleteTrafficSpend = cohorts.length > 0 && trafficRows.length === cohorts.length;
  const totalTrafficSpend = trafficRows.reduce((total, traffic) => total + traffic.spend, 0);
  const totalTrafficTrials = trafficRows.reduce((total, traffic) => total + traffic.trial_count, 0);
  const totalTrafficClicks = trafficRows.reduce((total, traffic) => total + traffic.clicks, 0);
  const totalRevenueD7 = sum((c) => c.revenue_d7);
  const totalRevenueD30 = sum((c) => c.revenue_d30);
  const totalRevenueD60 = sum((c) => c.revenue_d60);

  return {
    totalTrialUsers,
    totalUpsellUsers,
    totalFirstSubscriptionUsers,
    totalRenewal2Users,
    totalRenewal3Users,
    totalRenewalUsers,
    totalRefundUsers,
    totalActiveUsers,
    totalActiveSubscriptions,
    totalCancelledUsers,
    totalUserCancelledUsers,
    totalAutoCancelledUsers,
    totalCancelledActiveUsers,
    totalActiveRate: totalTrialUsers ? (totalActiveUsers / totalTrialUsers) * 100 : 0,
    totalActiveSubscriptionsRate: totalTrialUsers ? (totalActiveSubscriptions / totalTrialUsers) * 100 : 0,
    totalCancellationRate: totalTrialUsers ? (totalCancelledUsers / totalTrialUsers) * 100 : 0,
    totalUserCancelRate: totalTrialUsers ? (totalUserCancelledUsers / totalTrialUsers) * 100 : 0,
    totalAutoCancelRate: totalTrialUsers ? (totalAutoCancelledUsers / totalTrialUsers) * 100 : 0,
    trialRevenue: sum((c) => c.trial_revenue),
    upsellRevenue: sum((c) => c.upsell_revenue),
    firstSubscriptionRevenue: sum((c) => c.first_subscription_revenue),
    renewalRevenue: sum((c) => c.renewal_revenue),
    amountRefunded,
    refundRate: totalTrialUsers ? (totalRefundUsers / totalTrialUsers) * 100 : 0,
    grossRevenue,
    netRevenue,
    revenueD0: sum((c) => c.revenue_d0),
    revenueD7: totalRevenueD7,
    revenueD30: totalRevenueD30,
    revenueD60: totalRevenueD60,
    trafficSpend: totalTrafficSpend,
    hasTrafficSpend,
    hasCompleteTrafficSpend,
    profit: netRevenue - totalTrafficSpend,
    profitD7: totalRevenueD7 - totalTrafficSpend,
    profit1m: totalRevenueD30 - totalTrafficSpend,
    profit2m: totalRevenueD60 - totalTrafficSpend,
    trafficTrials: totalTrafficTrials,
    trafficClicks: totalTrafficClicks,
    trafficCac: totalTrafficTrials ? totalTrafficSpend / totalTrafficTrials : 0,
    trafficCpc: totalTrafficClicks ? totalTrafficSpend / totalTrafficClicks : 0,
    roasD7: totalTrafficSpend ? totalRevenueD7 / totalTrafficSpend : 0,
    roas1m: totalTrafficSpend ? totalRevenueD30 / totalTrafficSpend : 0,
    roas2m: totalTrafficSpend ? totalRevenueD60 / totalTrafficSpend : 0,
    trialToUpsellCr: totalTrialUsers ? (totalUpsellUsers / totalTrialUsers) * 100 : 0,
    trialToFirstSubscriptionCr: totalTrialUsers ? (totalFirstSubscriptionUsers / totalTrialUsers) * 100 : 0,
    firstSubscriptionToRenewal2Cr: totalFirstSubscriptionUsers ? (totalRenewal2Users / totalFirstSubscriptionUsers) * 100 : 0,
    renewal2ToRenewal3Cr: totalRenewal2Users ? (totalRenewal3Users / totalRenewal2Users) * 100 : 0,
  };
}
