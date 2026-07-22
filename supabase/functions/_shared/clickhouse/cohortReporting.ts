import type { CohortRow } from "./serviceTypes.ts";
import { renewalLevelFromColumnId } from "./renewalColumns.ts";
import { normalizeCampaignPath, type TrafficMetric } from "./trafficMetric.ts";

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

export function trialCostFromSpend(spend: number | null | undefined, trialUsers: number): number | null {
  if (spend == null || !Number.isFinite(spend) || !Number.isFinite(trialUsers) || trialUsers <= 0) return null;
  const value = spend / trialUsers;
  return Number.isFinite(value) ? value : null;
}

export function trialCostForCohort(row: Pick<CohortRow, "trial_users">, traffic: Pick<CohortTraffic, "spend"> | null): number | null {
  return trialCostFromSpend(traffic?.spend, row.trial_users);
}

export function renewalUsersForLevel(
  row: Partial<Pick<CohortRow, "renewal_2_users" | "renewal_3_users" | "renewal_4_users" | "renewal_5_users" | "renewal_6_users" | "renewal_users_by_level">>,
  level: number,
): number {
  const fromMap = row.renewal_users_by_level?.[level];
  if (typeof fromMap === "number") return fromMap;
  const key = `renewal_${level}_users` as keyof typeof row;
  const value = row[key];
  return typeof value === "number" ? value : 0;
}

export function renewalUsersForColumn(row: Parameters<typeof renewalUsersForLevel>[0], columnId: string): number | null {
  const level = renewalLevelFromColumnId(columnId);
  return level == null ? null : renewalUsersForLevel(row, level);
}

export interface CohortReportTotals {
  totalTrialUsers: number;
  totalUpsellUsers: number;
  totalFirstSubscriptionUsers: number;
  totalRenewal2Users: number;
  totalRenewal3Users: number;
  totalRenewal4Users: number;
  totalRenewal5Users: number;
  totalRenewal6Users: number;
  renewalTotalsByLevel: Record<number, number>;
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
  /** Weighted realized 1-month LTV: sum(net_revenue_1m) / sum(trial_users). */
  ltv1mPerUser: number;
  trafficSpend: number;
  hasTrafficSpend: boolean;
  hasCompleteTrafficSpend: boolean;
  trialCost: number | null;
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
  monetization: CohortMonetizationTotals;
}

/** Monetization totals: user counts sum across cohorts (a user belongs to exactly
 * one cohort), CRs are always recomputed from the summed totals — never averaged. */
export interface CohortMonetizationTotals {
  upsell1Users: number;
  upsell2Users: number;
  upsell3Users: number;
  upsellExtraUsers: number;
  upsell1Revenue: number;
  upsell2Revenue: number;
  upsell3Revenue: number;
  upsellExtraRevenue: number;
  upsell1Cr: number;
  upsell2Cr: number;
  upsell3Cr: number;
  funnelUpsellUsers: number;
  funnelUpsellRevenue: number;
  tokenBuyers: number;
  tokenBuyerCr: number;
  tokenPurchases: number;
  tokenGrossRevenue: number;
  tokenNetRevenue: number;
  avgTokenRevenuePerTrial: number;
  avgTokenRevenuePerBuyer: number;
  addonRevenue: number;
}

export function computeCohortMonetizationTotals(cohorts: CohortRow[], totalTrialUsers: number): CohortMonetizationTotals {
  const sum = (pick: (c: CohortRow) => number | undefined) =>
    cohorts.reduce((total, cohort) => total + (pick(cohort) ?? 0), 0);
  const upsell1Users = sum((c) => c.upsell_1_users);
  const upsell2Users = sum((c) => c.upsell_2_users);
  const upsell3Users = sum((c) => c.upsell_3_users);
  // Token buyers are deduped by user id across cohorts, mirroring refund/active users.
  const tokenBuyers = new Set(cohorts.flatMap((c) => c.token_buyer_user_ids ?? [])).size;
  const tokenNetRevenue = sum((c) => c.token_net_revenue);
  return {
    upsell1Users,
    upsell2Users,
    upsell3Users,
    upsellExtraUsers: sum((c) => c.upsell_extra_users),
    upsell1Revenue: sum((c) => c.upsell_1_revenue),
    upsell2Revenue: sum((c) => c.upsell_2_revenue),
    upsell3Revenue: sum((c) => c.upsell_3_revenue),
    upsellExtraRevenue: sum((c) => c.upsell_extra_revenue),
    upsell1Cr: totalTrialUsers ? (upsell1Users / totalTrialUsers) * 100 : 0,
    upsell2Cr: totalTrialUsers ? (upsell2Users / totalTrialUsers) * 100 : 0,
    upsell3Cr: totalTrialUsers ? (upsell3Users / totalTrialUsers) * 100 : 0,
    funnelUpsellUsers: sum((c) => c.funnel_upsell_users),
    funnelUpsellRevenue: sum((c) => c.funnel_upsell_revenue),
    tokenBuyers,
    tokenBuyerCr: totalTrialUsers ? (tokenBuyers / totalTrialUsers) * 100 : 0,
    tokenPurchases: sum((c) => c.token_purchases),
    tokenGrossRevenue: sum((c) => c.token_gross_revenue),
    tokenNetRevenue,
    avgTokenRevenuePerTrial: totalTrialUsers ? tokenNetRevenue / totalTrialUsers : 0,
    avgTokenRevenuePerBuyer: tokenBuyers ? tokenNetRevenue / tokenBuyers : 0,
    addonRevenue: sum((c) => c.addon_revenue),
  };
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
  const totalRenewal4Users = sum((c) => c.renewal_4_users);
  const totalRenewal5Users = sum((c) => c.renewal_5_users);
  const totalRenewal6Users = sum((c) => c.renewal_6_users);
  const renewalTotalsByLevel: Record<number, number> = {};
  for (const cohort of cohorts) {
    const levels = new Set<number>([
      ...Object.keys(cohort.renewal_users_by_level ?? {}).map(Number),
      2,
      3,
      4,
      5,
      6,
    ]);
    levels.forEach((level) => {
      if (!Number.isFinite(level)) return;
      renewalTotalsByLevel[level] = (renewalTotalsByLevel[level] ?? 0) + renewalUsersForLevel(cohort, level);
    });
  }
  const totalRenewalUsers = sum((c) => c.renewal_users);
  const totalRefundUsers = new Set(cohorts.flatMap((c) => c.refunded_user_ids)).size;
  // Active Users = unique active cohort users; Active Subscriptions = unique
  // active subscription_ids — both deduped across all visible cohorts.
  const totalActiveUsers = new Set(cohorts.flatMap((c) => c.active_user_ids)).size;
  const totalActiveSubscriptions = new Set(cohorts.flatMap((c) => c.active_subscription_ids ?? [])).size;
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
    totalRenewal4Users,
    totalRenewal5Users,
    totalRenewal6Users,
    renewalTotalsByLevel,
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
    // Weighted, NOT the average of per-cohort ltv_1m_per_user.
    ltv1mPerUser: totalTrialUsers ? totalRevenueD30 / totalTrialUsers : 0,
    trafficSpend: totalTrafficSpend,
    hasTrafficSpend,
    hasCompleteTrafficSpend,
    trialCost: trialCostFromSpend(hasTrafficSpend ? totalTrafficSpend : null, totalTrialUsers),
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
    monetization: computeCohortMonetizationTotals(cohorts, totalTrialUsers),
  };
}

/** Number of realized-revenue days needed before a cohort's 1M LTV is complete. */
export const LTV_1M_MATURITY_DAYS = 30;

export interface CohortMaturity {
  /** Whole days between the cohort start date and `nowMs`. */
  age_days: number;
  /** True once the cohort has at least 30 days of realized revenue. */
  matured: boolean;
  /** Days of revenue actually available so far (capped at 30). */
  available_days: number;
}

/**
 * 1M-LTV maturity for a cohort. `nowMs` is injected (never read from the clock
 * here) so callers stay deterministic and analytics stays clock-free.
 */
export function cohortMaturity(cohortDate: string, nowMs: number): CohortMaturity {
  const startMs = Date.parse(`${String(cohortDate ?? "").slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs)) {
    return { age_days: 0, matured: false, available_days: 0 };
  }
  const ageDays = Math.max(0, Math.floor((nowMs - startMs) / (24 * 60 * 60 * 1000)));
  return {
    age_days: ageDays,
    matured: ageDays >= LTV_1M_MATURITY_DAYS,
    available_days: Math.min(ageDays, LTV_1M_MATURITY_DAYS),
  };
}
