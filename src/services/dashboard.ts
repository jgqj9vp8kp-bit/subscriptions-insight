import type { CohortRow, Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";

export type DashboardCohort = CohortRow & {
  traffic_spend?: number | null;
  spend?: number | null;
};

export type DashboardKpiType = "currency" | "number" | "percent" | "ratio";

export interface DashboardKpi {
  label: string;
  value: number | null;
  type: DashboardKpiType;
}

export interface DashboardRevenueTrendRow {
  date: string;
  gross_rev: number;
  net_rev: number;
  spend: number;
}

export interface DashboardRoasTrendRow {
  date: string;
  roas_d7: number | null;
  roas_1m: number | null;
  roas_2m: number | null;
}

export interface DashboardChartRow {
  label: string;
  value: number;
}

export interface DashboardRefundTrendRow {
  date: string;
  refund_amount: number;
  refund_rate: number;
}

export interface DailyTrialsRow {
  date: string;
  trial_users: number;
}

export interface DailyUpsellsRow {
  date: string;
  upsell_users: number;
  upsell_revenue: number;
}

export interface DailyTrialsUpsellsRow {
  date: string;
  trial_users: number;
  upsell_users: number;
  non_upsell_trial_users: number;
  upsell_rate: number;
}

export interface DailyRefundsRow {
  date: string;
  refund_count: number;
  refund_amount: number;
}

export interface DailyCancellationsRow {
  date: string;
  user_cancelled: number;
  auto_cancelled: number;
  total_cancelled: number;
}

type DashboardTotals = {
  grossRevenue: number;
  netRevenue: number;
  spend: number;
  revenueD7: number;
  revenueD30: number;
  revenueD60: number;
  trialUsers: number;
  upsellUsers: number;
  firstSubscriptionUsers: number;
  activeSubscriptions: number;
  cancelledUsers: number;
  userCancelledUsers: number;
  autoCancelledUsers: number;
  cancelledActiveUsers: number;
  amountRefunded: number;
  trialToSubCr: number;
  cancellationRate: number;
  refundRate: number;
  roasD7: number | null;
  roas1m: number | null;
  roas2m: number | null;
};

const round2 = (value: number) => Math.round(value * 100) / 100;

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function timeValue(value: string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

function userKey(transaction: Transaction): string {
  return transaction.user_id || transaction.email || transaction.transaction_id;
}

function grossTransactionAmount(transaction: Transaction): number {
  const gross = Number(transaction.gross_amount_usd);
  if (Number.isFinite(gross) && gross !== 0) return gross;
  const amount = Number(transaction.amount_usd);
  return Number.isFinite(amount) ? amount : 0;
}

function refundTransactionAmount(transaction: Transaction): number {
  const refundAmount = Number(transaction.refund_amount_usd);
  if (Number.isFinite(refundAmount) && refundAmount > 0) return refundAmount;
  if (transaction.transaction_type === "refund" || transaction.status === "refunded") {
    return Math.abs(grossTransactionAmount(transaction));
  }
  return 0;
}

function isSuccessfulTransaction(transaction: Transaction): boolean {
  return transaction.status === "success";
}

function sum(cohorts: DashboardCohort[], pick: (cohort: DashboardCohort) => number | null | undefined): number {
  return cohorts.reduce((total, cohort) => total + (pick(cohort) ?? 0), 0);
}

function ratio(numerator: number, denominator: number): number {
  return denominator ? (numerator / denominator) * 100 : 0;
}

function roas(revenue: number, spend: number): number | null {
  return spend ? revenue / spend : null;
}

function uniqueCount(cohorts: DashboardCohort[], idPick: (cohort: DashboardCohort) => string[] | undefined, fallbackPick: (cohort: DashboardCohort) => number): number {
  const ids = new Set<string>();
  let hasIds = false;
  for (const cohort of cohorts) {
    const rowIds = idPick(cohort) ?? [];
    if (rowIds.length) hasIds = true;
    rowIds.forEach((id) => ids.add(id));
  }
  return hasIds ? ids.size : sum(cohorts, fallbackPick);
}

function spendForCohort(cohort: DashboardCohort): number {
  return cohort.traffic_spend ?? cohort.spend ?? 0;
}

function summarizeDashboardCohorts(cohorts: DashboardCohort[]): DashboardTotals {
  const grossRevenue = sum(cohorts, (cohort) => cohort.gross_revenue);
  const netRevenue = sum(cohorts, (cohort) => cohort.net_revenue);
  const spend = sum(cohorts, spendForCohort);
  const revenueD7 = sum(cohorts, (cohort) => cohort.revenue_d7);
  const revenueD30 = sum(cohorts, (cohort) => cohort.revenue_d30);
  const revenueD60 = sum(cohorts, (cohort) => cohort.revenue_d60);
  const trialUsers = sum(cohorts, (cohort) => cohort.trial_users);
  const upsellUsers = sum(cohorts, (cohort) => cohort.upsell_users);
  const firstSubscriptionUsers = sum(cohorts, (cohort) => cohort.first_subscription_users);
  const activeSubscriptions = uniqueCount(cohorts, (cohort) => cohort.active_subscription_user_ids, (cohort) => cohort.active_subscriptions);
  const cancelledUsers = uniqueCount(cohorts, (cohort) => cohort.cancelled_user_ids, (cohort) => cohort.cancelled_users);
  const userCancelledUsers = uniqueCount(cohorts, (cohort) => cohort.user_cancelled_user_ids, (cohort) => cohort.user_cancelled_users);
  const autoCancelledUsers = uniqueCount(cohorts, (cohort) => cohort.auto_cancelled_user_ids, (cohort) => cohort.auto_cancelled_users);
  const cancelledActiveUsers = uniqueCount(cohorts, (cohort) => cohort.cancelled_active_user_ids, (cohort) => cohort.cancelled_active_users);
  const amountRefunded = sum(cohorts, (cohort) => cohort.amount_refunded);

  return {
    grossRevenue: round2(grossRevenue),
    netRevenue: round2(netRevenue),
    spend: round2(spend),
    revenueD7: round2(revenueD7),
    revenueD30: round2(revenueD30),
    revenueD60: round2(revenueD60),
    trialUsers,
    upsellUsers,
    firstSubscriptionUsers,
    activeSubscriptions,
    cancelledUsers,
    userCancelledUsers,
    autoCancelledUsers,
    cancelledActiveUsers,
    amountRefunded: round2(amountRefunded),
    trialToSubCr: round2(ratio(firstSubscriptionUsers, trialUsers)),
    cancellationRate: round2(ratio(cancelledUsers, firstSubscriptionUsers)),
    refundRate: round2(ratio(amountRefunded, grossRevenue)),
    roasD7: roas(revenueD7, spend),
    roas1m: roas(revenueD30, spend),
    roas2m: roas(revenueD60, spend),
  };
}

function groupByDate(cohorts: DashboardCohort[]): Map<string, DashboardCohort[]> {
  const map = new Map<string, DashboardCohort[]>();
  for (const cohort of cohorts) {
    const date = cohort.cohort_date || "unknown";
    const rows = map.get(date) ?? [];
    rows.push(cohort);
    map.set(date, rows);
  }
  return map;
}

export function buildDashboardKpis(cohorts: DashboardCohort[]): DashboardKpi[] {
  const totals = summarizeDashboardCohorts(cohorts);
  return [
    { label: "Gross Rev", value: totals.grossRevenue, type: "currency" },
    { label: "Net Rev", value: totals.netRevenue, type: "currency" },
    { label: "Spend", value: totals.spend, type: "currency" },
    { label: "ROAS 1M", value: totals.roas1m, type: "ratio" },
    { label: "Trial Users", value: totals.trialUsers, type: "number" },
    { label: "First Sub", value: totals.firstSubscriptionUsers, type: "number" },
    { label: "Trial → Sub CR", value: totals.trialToSubCr, type: "percent" },
    { label: "Active Subs", value: totals.activeSubscriptions, type: "number" },
    { label: "Cancellation Rate", value: totals.cancellationRate, type: "percent" },
    { label: "User Cancelled", value: totals.userCancelledUsers, type: "number" },
    { label: "Auto Cancelled", value: totals.autoCancelledUsers, type: "number" },
    { label: "Refund Rate", value: totals.refundRate, type: "percent" },
  ];
}

export function buildRevenueTrend(cohorts: DashboardCohort[]): DashboardRevenueTrendRow[] {
  return Array.from(groupByDate(cohorts).entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const totals = summarizeDashboardCohorts(rows);
      return {
        date,
        gross_rev: totals.grossRevenue,
        net_rev: totals.netRevenue,
        spend: totals.spend,
      };
    });
}

export function buildRoasTrend(cohorts: DashboardCohort[]): DashboardRoasTrendRow[] {
  return Array.from(groupByDate(cohorts).entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const totals = summarizeDashboardCohorts(rows);
      return {
        date,
        roas_d7: totals.roasD7,
        roas_1m: totals.roas1m,
        roas_2m: totals.roas2m,
      };
    });
}

export function buildFunnelChart(cohorts: DashboardCohort[]): DashboardChartRow[] {
  const totals = summarizeDashboardCohorts(cohorts);
  return [
    { label: "Trial Users", value: totals.trialUsers },
    { label: "Upsell Users", value: totals.upsellUsers },
    { label: "First Sub Users", value: totals.firstSubscriptionUsers },
    { label: "Active Subs", value: totals.activeSubscriptions },
  ];
}

export function buildCancellationBreakdown(cohorts: DashboardCohort[]): DashboardChartRow[] {
  const totals = summarizeDashboardCohorts(cohorts);
  return [
    { label: "User Cancelled", value: totals.userCancelledUsers },
    { label: "Auto Cancelled", value: totals.autoCancelledUsers },
    { label: "Active Subs", value: totals.activeSubscriptions },
    { label: "Cancelled Active", value: totals.cancelledActiveUsers },
  ];
}

export function buildRefundTrend(cohorts: DashboardCohort[]): DashboardRefundTrendRow[] {
  return Array.from(groupByDate(cohorts).entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, rows]) => {
      const totals = summarizeDashboardCohorts(rows);
      return {
        date,
        refund_amount: totals.amountRefunded,
        refund_rate: totals.refundRate,
      };
    });
}

export function buildTrialsByDay(transactions: Transaction[]): DailyTrialsRow[] {
  const firstTrialByUser = new Map<string, Transaction>();

  [...transactions]
    .filter((transaction) => isSuccessfulTransaction(transaction) && transaction.transaction_type !== "upsell" && dateKey(transaction.event_time))
    .sort((a, b) => timeValue(a.event_time) - timeValue(b.event_time))
    .forEach((transaction) => {
      const key = userKey(transaction);
      if (!firstTrialByUser.has(key)) firstTrialByUser.set(key, transaction);
    });

  const usersByDate = new Map<string, Set<string>>();
  for (const [key, transaction] of firstTrialByUser.entries()) {
    const date = dateKey(transaction.event_time);
    if (!date) continue;
    const users = usersByDate.get(date) ?? new Set<string>();
    users.add(key);
    usersByDate.set(date, users);
  }

  return Array.from(usersByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, users]) => ({ date, trial_users: users.size }));
}

export function buildUpsellsByDay(transactions: Transaction[]): DailyUpsellsRow[] {
  const rows = new Map<string, { users: Set<string>; revenue: number }>();

  for (const transaction of transactions) {
    if (!isSuccessfulTransaction(transaction) || transaction.transaction_type !== "upsell") continue;
    const date = dateKey(transaction.event_time);
    if (!date) continue;
    const row = rows.get(date) ?? { users: new Set<string>(), revenue: 0 };
    row.users.add(userKey(transaction));
    row.revenue += grossTransactionAmount(transaction);
    rows.set(date, row);
  }

  return Array.from(rows.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, row]) => ({
      date,
      upsell_users: row.users.size,
      upsell_revenue: round2(row.revenue),
    }));
}

export function buildTrialsUpsellsByDay(transactions: Transaction[]): DailyTrialsUpsellsRow[] {
  const firstTrialByUser = new Map<string, Transaction>();

  [...transactions]
    .filter((transaction) => isSuccessfulTransaction(transaction) && transaction.transaction_type !== "upsell" && dateKey(transaction.event_time))
    .sort((a, b) => timeValue(a.event_time) - timeValue(b.event_time))
    .forEach((transaction) => {
      const key = userKey(transaction);
      if (!firstTrialByUser.has(key)) firstTrialByUser.set(key, transaction);
    });

  const trialUsersByDate = new Map<string, Set<string>>();
  for (const [key, transaction] of firstTrialByUser.entries()) {
    const date = dateKey(transaction.event_time);
    if (!date) continue;
    const users = trialUsersByDate.get(date) ?? new Set<string>();
    users.add(key);
    trialUsersByDate.set(date, users);
  }

  const upsellUsersByDate = new Map<string, Set<string>>();
  for (const transaction of transactions) {
    if (!isSuccessfulTransaction(transaction) || transaction.transaction_type !== "upsell") continue;
    const date = dateKey(transaction.event_time);
    if (!date) continue;
    const trialUsers = trialUsersByDate.get(date);
    const key = userKey(transaction);
    if (!trialUsers?.has(key)) continue;
    const users = upsellUsersByDate.get(date) ?? new Set<string>();
    users.add(key);
    upsellUsersByDate.set(date, users);
  }

  return Array.from(trialUsersByDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, trialUsers]) => {
      const trialCount = trialUsers.size;
      const upsellCount = upsellUsersByDate.get(date)?.size ?? 0;
      return {
        date,
        trial_users: trialCount,
        upsell_users: upsellCount,
        non_upsell_trial_users: Math.max(0, trialCount - upsellCount),
        upsell_rate: round2(ratio(upsellCount, trialCount)),
      };
    });
}

export function buildRefundsByDay(transactions: Transaction[]): DailyRefundsRow[] {
  const rows = new Map<string, { count: number; amount: number }>();

  for (const transaction of transactions) {
    const refundAmount = refundTransactionAmount(transaction);
    if (refundAmount <= 0) continue;
    const date = dateKey(transaction.event_time);
    if (!date) continue;
    const row = rows.get(date) ?? { count: 0, amount: 0 };
    row.count += 1;
    row.amount += refundAmount;
    rows.set(date, row);
  }

  return Array.from(rows.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, row]) => ({
      date,
      refund_count: row.count,
      refund_amount: round2(row.amount),
    }));
}

function classifyCancellation(subscription: SubscriptionClean): "user_cancelled" | "auto_cancelled" | "unknown" {
  if (typeof subscription.hours_before_period_end === "number") {
    return subscription.hours_before_period_end > 0 ? "user_cancelled" : "auto_cancelled";
  }
  if (subscription.cancellation_type === "user_or_manual_cancelled") return "user_cancelled";
  if (subscription.cancellation_type === "auto_payment_related") return "auto_cancelled";
  return "unknown";
}

export function buildCancellationsByDay(subscriptions: SubscriptionClean[]): DailyCancellationsRow[] {
  const rows = new Map<string, DailyCancellationsRow>();

  for (const subscription of subscriptions) {
    if (!subscription.is_cancelled) continue;
    const date = dateKey(subscription.cancelled_at);
    if (!date) continue;
    const row = rows.get(date) ?? { date, user_cancelled: 0, auto_cancelled: 0, total_cancelled: 0 };
    const cancellationType = classifyCancellation(subscription);
    if (cancellationType === "user_cancelled") row.user_cancelled += 1;
    if (cancellationType === "auto_cancelled") row.auto_cancelled += 1;
    row.total_cancelled += 1;
    rows.set(date, row);
  }

  return Array.from(rows.values()).sort((a, b) => a.date.localeCompare(b.date));
}
