// Server-side Dashboard summary: reproduces the exact compute chain of
// src/pages/Dashboard.tsx over the same inputs (see serverTransactionsSource for
// the warehouse-first transaction policy). Parity-first: every block below mirrors
// a specific page useMemo — do not "improve" formulas here.

import type { SubscriptionClean } from "./subscriptionTypes.ts";
import type { TrafficMetric } from "./trafficMetric.ts";
import type { Transaction } from "./serviceTypes.ts";
import { computeCohorts } from "./cohortAnalytics.ts";
import { aggregateTrafficMetrics, trafficForCohort } from "./cohortReporting.ts";
import {
  buildCancellationBreakdown,
  buildCancellationsByDay,
  buildDashboardFxSummary,
  buildDashboardKpis,
  buildFunnelChart,
  buildRefundTrend,
  buildRefundsByDay,
  buildRevenueTrend,
  buildRoasTrend,
  buildTrialsUpsellsByDay,
  getCashRevenueByDateRange,
  normalizeDashboardTransactions,
  type CashRevenueSummary,
  type DashboardChartRow,
  type DashboardFxSummary,
  type DashboardKpi,
  type DashboardRefundTrendRow,
  type DashboardRevenueTrendRow,
  type DashboardRoasTrendRow,
  type DailyCancellationsRow,
  type DailyRefundsRow,
  type DailyTrialsUpsellsRow,
} from "./dashboardCompute.ts";

export const DASHBOARD_SUMMARY_FUNCTION = "dashboard-summary";

export interface DashboardSummaryFilters {
  funnelFilter?: string;
  campaignPathFilter?: string;
  sourceFilter?: string;
  cohortDateFrom?: string;
  cohortDateTo?: string;
}

export interface DashboardSummaryRequest {
  filters?: DashboardSummaryFilters;
}

export interface DashboardSummaryTotals {
  trialUsers: number;
  upsellUsers: number;
  firstSubUsers: number;
  renewal2Users: number;
  renewal3Users: number;
  activeSubs: number;
  activeSubsRate: number;
  cancelledUsers: number;
  userCancelled: number;
  autoCancelled: number;
  cancelledActive: number;
  refundUsers: number;
  spend: number;
  fbTrialCount: number;
  clicks: number;
  cac: number | null;
  cpc: number | null;
  revenueD7: number;
  revenueD30: number;
  revenueD60: number;
  roasD7: number | null;
  roas1M: number | null;
  roas2M: number | null;
  amountRefunded: number;
  upsellCr: number;
  subCr: number;
  renewal2Cr: number;
  renewal3Cr: number;
}

export interface DashboardSummaryMeta {
  transactions: number;
  transactions_source: string;
  subscriptions: number;
  traffic_rows: number;
  cohorts: number;
  filtered_cohorts: number;
}

export interface DashboardSummaryResponse {
  ok: true;
  kpis: DashboardKpi[];
  totals: DashboardSummaryTotals;
  cashRevenueSummary: CashRevenueSummary;
  cohortGrossRevenue: number;
  cashCohortDifference: number;
  revenueTrend: DashboardRevenueTrendRow[];
  roasTrend: DashboardRoasTrendRow[];
  funnelChart: DashboardChartRow[];
  cancellationBreakdown: DashboardChartRow[];
  refundTrend: DashboardRefundTrendRow[];
  trialsUpsellsByDay: DailyTrialsUpsellsRow[];
  refundsByDay: DailyRefundsRow[];
  cancellationsByDay: DailyCancellationsRow[];
  fxSummary: DashboardFxSummary;
  meta: DashboardSummaryMeta;
}

// --- Parity guard --------------------------------------------------------------

export interface NumericRecordMismatch {
  scope: string;
  metric: string;
  server: number | null;
  client: number | null;
}

const NUMERIC_ABS_TOLERANCE = 0.01;

/** Compare two records metric-by-metric. Only numeric/null values participate
 * (non-numeric fields are skipped); numbers tolerate 0.01 for serialization
 * round-trips, null-vs-number is a mismatch. */
export function reconcileNumericRecords(
  scope: string,
  server: Record<string, unknown>,
  client: Record<string, unknown>,
): NumericRecordMismatch[] {
  const mismatches: NumericRecordMismatch[] = [];
  const keys = new Set([...Object.keys(server), ...Object.keys(client)]);
  for (const key of keys) {
    const a = server[key];
    const b = client[key];
    const aNumeric = typeof a === "number" || a === null;
    const bNumeric = typeof b === "number" || b === null;
    if (!aNumeric || !bNumeric) continue;
    if (a === null || b === null) {
      if (a !== b) mismatches.push({ scope, metric: key, server: a, client: b });
      continue;
    }
    if (Math.abs(a - b) > NUMERIC_ABS_TOLERANCE) {
      mismatches.push({ scope, metric: key, server: a, client: b });
    }
  }
  return mismatches;
}

function sum<T>(rows: T[], pick: (row: T) => number | null | undefined): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

function uniqueCount<T>(rows: T[], pick: (row: T) => string[] | undefined): number {
  return new Set(rows.flatMap((row) => pick(row) ?? [])).size;
}

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

export function computeDashboardSummary(input: {
  transactions: Transaction[];
  transactionsSource: string;
  subscriptions: SubscriptionClean[];
  trafficMetrics: TrafficMetric[];
  filters?: DashboardSummaryFilters;
}): DashboardSummaryResponse {
  const filters = input.filters ?? {};
  const funnelFilter = filters.funnelFilter ?? "all";
  const campaignPathFilter = filters.campaignPathFilter ?? "all";
  const sourceFilter = filters.sourceFilter ?? "all";
  const cohortDateFrom = filters.cohortDateFrom ?? "";
  const cohortDateTo = filters.cohortDateTo ?? "";

  const dashboardTransactions = normalizeDashboardTransactions(input.transactions).transactions;
  const allCohorts = computeCohorts(dashboardTransactions, input.subscriptions);
  const filteredTrafficMetrics = input.trafficMetrics.filter(
    (row) => sourceFilter === "all" || row.source === sourceFilter,
  );
  const trafficByKey = aggregateTrafficMetrics(filteredTrafficMetrics);

  const cohorts = allCohorts.filter((c) => {
    if (funnelFilter !== "all" && c.funnel !== funnelFilter) return false;
    if (campaignPathFilter !== "all" && c.campaign_path !== campaignPathFilter) return false;
    if (cohortDateFrom && c.cohort_date < cohortDateFrom) return false;
    if (cohortDateTo && c.cohort_date > cohortDateTo) return false;
    return true;
  });

  const dashboardCohorts = cohorts.map((cohort) => {
    const traffic = trafficForCohort(cohort, trafficByKey);
    return {
      ...cohort,
      traffic_spend: traffic?.spend ?? null,
      traffic_trial_count: traffic?.trial_count ?? 0,
      traffic_clicks: traffic?.clicks ?? 0,
    };
  });

  const cashRevenueSummary = getCashRevenueByDateRange(dashboardTransactions, {
    dateFrom: cohortDateFrom,
    dateTo: cohortDateTo,
    funnelFilter,
    campaignPathFilter,
    sourceFilter,
  });

  const kpis = buildDashboardKpis(dashboardCohorts);
  kpis.push({ label: "Cash Revenue", value: cashRevenueSummary.cashRevenue, type: "currency" });
  kpis.push({ label: "Cash Net Revenue", value: cashRevenueSummary.cashNetRevenue, type: "currency" });

  const dailyTransactions = dashboardTransactions.filter((transaction) => {
    const eventDate = dateKey(transaction.event_time);
    if (!eventDate) return false;
    if (cohortDateFrom && eventDate < cohortDateFrom) return false;
    if (cohortDateTo && eventDate > cohortDateTo) return false;
    if (funnelFilter !== "all" && transaction.funnel !== funnelFilter) return false;
    if (campaignPathFilter !== "all" && transaction.campaign_path !== campaignPathFilter) return false;
    if (sourceFilter !== "all" && transaction.traffic_source !== sourceFilter) return false;
    return true;
  });
  const dailySubscriptions = input.subscriptions.filter((subscription) => {
    const cancelledDate = dateKey(subscription.cancelled_at);
    if (!cancelledDate) return false;
    if (cohortDateFrom && cancelledDate < cohortDateFrom) return false;
    if (cohortDateTo && cancelledDate > cohortDateTo) return false;
    return true;
  });

  const trialUsers = sum(dashboardCohorts, (c) => c.trial_users);
  const upsellUsers = sum(dashboardCohorts, (c) => c.upsell_users);
  const firstSubUsers = sum(dashboardCohorts, (c) => c.first_subscription_users);
  const renewal2Users = sum(dashboardCohorts, (c) => c.renewal_2_users);
  const renewal3Users = sum(dashboardCohorts, (c) => c.renewal_3_users);
  const activeSubs = uniqueCount(dashboardCohorts, (c) => c.active_subscription_user_ids);
  const refundUsers = uniqueCount(dashboardCohorts, (c) => c.refunded_user_ids);
  const spend = sum(dashboardCohorts, (c) => c.traffic_spend);
  const fbTrialCount = sum(dashboardCohorts, (c) => c.traffic_trial_count);
  const clicks = sum(dashboardCohorts, (c) => c.traffic_clicks);
  const revenueD7 = sum(dashboardCohorts, (c) => c.revenue_d7);
  const revenueD30 = sum(dashboardCohorts, (c) => c.revenue_d30);
  const revenueD60 = sum(dashboardCohorts, (c) => c.revenue_d60);

  const totals: DashboardSummaryTotals = {
    trialUsers,
    upsellUsers,
    firstSubUsers,
    renewal2Users,
    renewal3Users,
    activeSubs,
    activeSubsRate: trialUsers ? (activeSubs / trialUsers) * 100 : 0,
    cancelledUsers: uniqueCount(dashboardCohorts, (c) => c.cancelled_user_ids),
    userCancelled: uniqueCount(dashboardCohorts, (c) => c.user_cancelled_user_ids),
    autoCancelled: uniqueCount(dashboardCohorts, (c) => c.auto_cancelled_user_ids),
    cancelledActive: uniqueCount(dashboardCohorts, (c) => c.cancelled_active_user_ids),
    refundUsers,
    spend,
    fbTrialCount,
    clicks,
    cac: fbTrialCount ? spend / fbTrialCount : null,
    cpc: clicks ? spend / clicks : null,
    revenueD7,
    revenueD30,
    revenueD60,
    roasD7: spend ? revenueD7 / spend : null,
    roas1M: spend ? revenueD30 / spend : null,
    roas2M: spend ? revenueD60 / spend : null,
    amountRefunded: sum(dashboardCohorts, (c) => c.amount_refunded),
    upsellCr: trialUsers ? (upsellUsers / trialUsers) * 100 : 0,
    subCr: trialUsers ? (firstSubUsers / trialUsers) * 100 : 0,
    renewal2Cr: firstSubUsers ? (renewal2Users / firstSubUsers) * 100 : 0,
    renewal3Cr: renewal2Users ? (renewal3Users / renewal2Users) * 100 : 0,
  };

  const cohortGrossRevenue = sum(dashboardCohorts, (cohort) => cohort.gross_revenue);

  return {
    ok: true,
    kpis,
    totals,
    cashRevenueSummary,
    cohortGrossRevenue,
    cashCohortDifference: cashRevenueSummary.cashRevenue - cohortGrossRevenue,
    revenueTrend: buildRevenueTrend(dashboardCohorts),
    roasTrend: buildRoasTrend(dashboardCohorts),
    funnelChart: buildFunnelChart(dashboardCohorts),
    cancellationBreakdown: buildCancellationBreakdown(dashboardCohorts),
    refundTrend: buildRefundTrend(dashboardCohorts),
    trialsUpsellsByDay: buildTrialsUpsellsByDay(dailyTransactions),
    refundsByDay: buildRefundsByDay(dailyTransactions),
    cancellationsByDay: buildCancellationsByDay(dailySubscriptions),
    fxSummary: buildDashboardFxSummary(normalizeDashboardTransactions(dailyTransactions).diagnostics),
    meta: {
      transactions: input.transactions.length,
      transactions_source: input.transactionsSource,
      subscriptions: input.subscriptions.length,
      traffic_rows: input.trafficMetrics.length,
      cohorts: allCohorts.length,
      filtered_cohorts: cohorts.length,
    },
  };
}
