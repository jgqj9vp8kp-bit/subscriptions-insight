import { computeCohorts } from "@/services/analytics";
import { buildCampaignIdOptions } from "@/services/cohortCampaignIds";
import {
  campaignIdForTransaction,
  campaignIdLabel,
  campaignNameForTransaction,
  filterCohorts,
  filterTransactionsByTrialAttribution,
  type CohortFilters,
} from "@/services/cohortFiltering";
import {
  computeCohortReportTotals,
  renewalUsersForLevel,
  trafficForCohort,
  type CohortReportTotals,
  type TrafficAggregate,
} from "@/services/cohortReporting";
import { normalizeCampaignPath } from "@/services/trafficImport";
import { CARD_TYPE_VALUES } from "@/services/userCardType";
import { mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import { isFailedPaymentTransaction, declineDetailsForTransaction } from "@/services/paymentFailures";
import type { CapsuledFacebookRow } from "@/services/capsuledFacebook";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { CardType, DeclineReason, MediaBuyer, Transaction } from "@/services/types";

// Spend attribution status for a Campaign ID. The Facebook traffic sheet is keyed by
// (date, campaign_path) and carries NO campaign_id, so per-campaign spend is exact only when a
// campaign_path is used by a single in-scope campaign. Otherwise we surface an explicit status
// instead of silently returning null (Phase 5).
export type FbSpendStatus = "available" | "unavailable_shared_path" | "no_traffic_data";

export function fbSpendStatusLabel(status: FbSpendStatus): string {
  if (status === "available") return "Available";
  if (status === "unavailable_shared_path") return "Spend unavailable (Campaign IDs share a path)";
  return "Spend unavailable (no traffic data)";
}

export interface FbAnalyticsFilters extends CohortFilters {
  campaignPathFilter?: string;
  selectedCountries?: string[];
  selectedCardTypes?: CardType[];
  campaignIdSearch?: string;
  campaignNameSearch?: string;
  adAccountFilter?: string;
  mediaBuyerFilter?: MediaBuyer | string;
}

export interface FbAnalyticsRow {
  campaign_id: string;
  campaign_name: string | null;
  campaign_path: string;
  ad_account_id: string | null;
  ad_account_name: string | null;
  trial_users: number;
  upsell_users: number;
  upsell_1_users: number;
  upsell_2_users: number;
  upsell_3_users: number;
  token_buyers: number;
  token_revenue: number;
  upsell_cr: number;
  first_subscription_users: number;
  trial_to_sub_cr: number;
  renewal_2_users: number;
  renewal_3_users: number;
  active_subscriptions: number;
  gross_revenue: number;
  net_revenue: number;
  spend: number | null;
  spend_status: FbSpendStatus;
  fb_purchases: number;
  cpp: number | null;
  impressions: number;
  clicks: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  outbound_clicks: number;
  outbound_ctr: number | null;
  currency: string | null;
  cac: number | null;
  cost_per_first_sub: number | null;
  roas: number | null;
  revenue_per_trial: number | null;
  revenue_per_purchase: number | null;
  profit: number | null;
  refund_users: number;
  refund_rate: number;
  failed_payment_users: number;
  main_decline_reason: DeclineReason | null;
}

export interface FbAnalyticsSummary {
  campaignIdsCount: number;
  trialUsers: number;
  upsellUsers: number;
  upsellCr: number;
  firstSubscriptionUsers: number;
  trialToSubCr: number;
  grossRevenue: number;
  netRevenue: number;
  spend: number | null;
  cac: number | null;
  roas: number | null;
  fbPurchases: number;
  profit: number | null;
}

export interface FbAnalyticsResult {
  rows: FbAnalyticsRow[];
  summary: FbAnalyticsSummary;
}

export type FbAnalyticsSortKey =
  | "trial_users"
  | "upsell_cr"
  | "trial_to_sub_cr"
  | "net_revenue"
  | "spend"
  | "cac"
  | "roas"
  | "refund_rate"
  | "failed_payment_users";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeCardTypes(cardTypes: readonly CardType[] = []): CardType[] {
  return cardTypes.filter((value): value is CardType => CARD_TYPE_VALUES.includes(value));
}

function firstSuccessfulTrialByUser(txs: Transaction[]): Map<string, Transaction> {
  const result = new Map<string, Transaction>();
  const trials = txs
    .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
    .sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));
  for (const trial of trials) {
    if (!result.has(trial.user_id)) result.set(trial.user_id, trial);
  }
  return result;
}

function hasSuccessfulFacebookTrial(txs: Transaction[]): boolean {
  return txs.some((tx) => tx.status === "success" && tx.transaction_type === "trial" && tx.traffic_source === "facebook");
}

function transactionsByUser(txs: Transaction[]): Map<string, Transaction[]> {
  const result = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const list = result.get(tx.user_id) ?? [];
    list.push(tx);
    result.set(tx.user_id, list);
  }
  return result;
}

function campaignPathSummary(paths: string[]): string {
  const unique = Array.from(new Set(paths.filter(Boolean))).sort();
  if (!unique.length) return "unknown";
  if (unique.length === 1) return unique[0];
  return `${unique[0]} +${unique.length - 1}`;
}

function topDeclineReason(txs: Transaction[], userIds: Set<string>): DeclineReason | null {
  const counts = new Map<DeclineReason, number>();
  for (const tx of txs) {
    if (!userIds.has(tx.user_id) || !isFailedPaymentTransaction(tx)) continue;
    const decline = declineDetailsForTransaction(tx);
    const reason = decline?.reason ?? "unknown";
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

function failedPaymentUsers(txs: Transaction[], userIds: Set<string>): number {
  return new Set(txs.filter((tx) => userIds.has(tx.user_id) && isFailedPaymentTransaction(tx)).map((tx) => tx.user_id)).size;
}

function searchMatches(row: FbAnalyticsRow, query: string): boolean {
  if (!query) return true;
  return `${row.campaign_id} ${row.campaign_name ?? ""}`.toLowerCase().includes(query);
}

function rowMatchesExtraFilters(row: FbAnalyticsRow, filters: FbAnalyticsFilters): boolean {
  const campaignNameQuery = String(filters.campaignNameSearch ?? "").trim().toLowerCase();
  if (campaignNameQuery && !String(row.campaign_name ?? "").toLowerCase().includes(campaignNameQuery)) return false;
  if (filters.adAccountFilter && filters.adAccountFilter !== "all" && row.ad_account_id !== filters.adAccountFilter) return false;
  return true;
}

function sum<T>(rows: T[], pick: (row: T) => number | null | undefined): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

function summarize(rows: FbAnalyticsRow[]): FbAnalyticsSummary {
  const trialUsers = sum(rows, (row) => row.trial_users);
  const upsellUsers = sum(rows, (row) => row.upsell_users);
  const firstSubscriptionUsers = sum(rows, (row) => row.first_subscription_users);
  const grossRevenue = sum(rows, (row) => row.gross_revenue);
  const netRevenue = sum(rows, (row) => row.net_revenue);
  // Spend / CAC / ROAS aggregate ONLY over campaigns whose spend is attributable, so they are not
  // distorted by campaigns whose spend is unavailable.
  const spendRows = rows.filter((row) => row.spend != null);
  const spend = spendRows.length ? sum(spendRows, (row) => row.spend) : null;
  const spendTrialUsers = sum(spendRows, (row) => row.trial_users);
  const spendNetRevenue = sum(spendRows, (row) => row.net_revenue);
  const fbPurchases = sum(rows, (row) => row.fb_purchases);
  const profit = spend != null ? netRevenue - spend : null;
  return {
    campaignIdsCount: rows.length,
    trialUsers,
    upsellUsers,
    upsellCr: trialUsers ? (upsellUsers / trialUsers) * 100 : 0,
    firstSubscriptionUsers,
    trialToSubCr: trialUsers ? (firstSubscriptionUsers / trialUsers) * 100 : 0,
    grossRevenue,
    netRevenue,
    spend,
    cac: spend != null && spendTrialUsers ? spend / spendTrialUsers : null,
    roas: spend ? spendNetRevenue / spend : null,
    fbPurchases,
    profit,
  };
}

function capsuledRowsByCampaign(rows: CapsuledFacebookRow[] = []): Map<string, CapsuledFacebookRow> {
  const byId = new Map<string, CapsuledFacebookRow>();
  for (const row of rows) {
    const campaignId = row.campaign_id?.trim();
    if (!campaignId) continue;
    const current = byId.get(campaignId);
    if (!current) {
      byId.set(campaignId, { ...row });
      continue;
    }
    current.campaign_name ||= row.campaign_name;
    current.ad_account_id ||= row.ad_account_id;
    current.ad_account_name ||= row.ad_account_name;
    current.currency ||= row.currency;
    current.spend += row.spend;
    current.fb_purchases += row.fb_purchases;
    current.impressions += row.impressions;
    current.clicks += row.clicks;
    current.outbound_clicks += row.outbound_clicks;
    current.cpp = current.fb_purchases ? current.spend / current.fb_purchases : null;
    current.ctr = current.impressions ? (current.clicks / current.impressions) * 100 : null;
    current.cpc = current.clicks ? current.spend / current.clicks : null;
    current.cpm = current.impressions ? (current.spend / current.impressions) * 1000 : null;
    current.outbound_ctr = current.impressions ? (current.outbound_clicks / current.impressions) * 100 : null;
    current.last_import_at = row.last_import_at > current.last_import_at ? row.last_import_at : current.last_import_at;
  }
  return byId;
}

export function sortFbAnalyticsRows(
  rows: FbAnalyticsRow[],
  sortKey: FbAnalyticsSortKey = "trial_users",
  sortDir: "asc" | "desc" = "desc",
): FbAnalyticsRow[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sortKey] ?? -Infinity;
    const bv = b[sortKey] ?? -Infinity;
    if (av !== bv) return av < bv ? -direction : direction;
    return a.campaign_id.localeCompare(b.campaign_id);
  });
}

export function buildFbAnalytics(params: {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  trafficByKey?: Map<string, TrafficAggregate>;
  capsuledRows?: CapsuledFacebookRow[];
  filters?: FbAnalyticsFilters;
}): FbAnalyticsResult {
  const filters = params.filters ?? {};
  const selectedCardTypes = normalizeCardTypes(filters.selectedCardTypes);
  const trafficSourceFilter = hasSuccessfulFacebookTrial(params.txs) ? "facebook" : "all";
  const parentTxs = filterTransactionsByTrialAttribution(params.txs, { trafficSourceFilter });
  const parentTxsByUser = transactionsByUser(parentTxs);
  const mediaBuyerFilter = String(filters.mediaBuyerFilter ?? "");
  const cohortFilters: CohortFilters = {
    funnelFilter: filters.funnelFilter,
    campaignPathFilter: filters.campaignPathFilter,
    refundFilter: filters.refundFilter,
    cohortDateFrom: filters.cohortDateFrom,
    cohortDateTo: filters.cohortDateTo,
  };
  const options = buildCampaignIdOptions({
    txs: params.txs,
    subscriptions: params.subscriptions,
    filters: cohortFilters,
    trafficSourceFilter,
    selectedCountries: filters.selectedCountries,
    selectedCardTypes,
  });
  const byUser = transactionsByUser(parentTxs);
  const trialByUser = firstSuccessfulTrialByUser(parentTxs);

  // Pass 1: per-campaign cohorts + attributed trial users, and the campaign paths each one spans.
  const capsuledByCampaign = capsuledRowsByCampaign(params.capsuledRows);
  const optionIds = new Set(options.map((option) => option.campaign_id));
  const importedOnlyOptions = Array.from(capsuledByCampaign.keys())
    .filter((campaignId) => !optionIds.has(campaignId))
    .map((campaign_id) => ({ campaign_id, campaign_name: capsuledByCampaign.get(campaign_id)?.campaign_name ?? null, trial_count: 0 }));

  const computed = [...options, ...importedOnlyOptions].map((option) => {
    const campaignTxs = filterTransactionsByTrialAttribution(parentTxs, {
      trafficSourceFilter,
      selectedCampaignIds: [option.campaign_id],
    });
    const mediaFilteredCampaignTxs =
      mediaBuyerFilter && mediaBuyerFilter !== "all"
        ? campaignTxs.filter((tx) => mediaBuyerForUserTransactions(parentTxsByUser.get(tx.user_id) ?? [tx]).media_buyer === mediaBuyerFilter)
        : campaignTxs;
    const cohorts = filterCohorts(
      computeCohorts(mediaFilteredCampaignTxs, params.subscriptions ?? [], {
        selectedCountries: filters.selectedCountries,
        selectedCardTypes,
      }),
      cohortFilters,
    );
    const trialUserIds = new Set<string>();
    for (const [userId, trial] of trialByUser) {
      if (campaignIdForTransaction(trial) !== option.campaign_id) continue;
      const list = byUser.get(userId) ?? [];
      if (mediaBuyerFilter && mediaBuyerFilter !== "all" && mediaBuyerForUserTransactions(list).media_buyer !== mediaBuyerFilter) continue;
      const userCohorts = computeCohorts(list, [], {
        selectedCountries: filters.selectedCountries,
        selectedCardTypes,
      });
      if (filterCohorts(userCohorts, cohortFilters).length) trialUserIds.add(userId);
    }
    const cohortPaths = Array.from(new Set(cohorts.map((cohort) => normalizeCampaignPath(cohort.campaign_path))));
    return { option, cohorts, trialUserIds, cohortPaths };
  });

  // The traffic sheet is path-keyed (no campaign_id). A path's spend can only be attributed to a
  // single campaign when no other in-scope campaign uses that path. Map path -> campaign ids.
  const campaignIdsByPath = new Map<string, Set<string>>();
  for (const entry of computed) {
    for (const path of entry.cohortPaths) {
      const set = campaignIdsByPath.get(path) ?? new Set<string>();
      set.add(entry.option.campaign_id);
      campaignIdsByPath.set(path, set);
    }
  }
  const pathIsExclusive = (path: string) => (campaignIdsByPath.get(path)?.size ?? 0) <= 1;

  // Pass 2: build rows, computing spend whenever every campaign path is exclusive to this campaign.
  const rows = computed.map(({ option, cohorts, trialUserIds, cohortPaths }) => {
    const capsuled = capsuledByCampaign.get(option.campaign_id);
    const paths = Array.from(trialUserIds)
      .map((userId) => trialByUser.get(userId)?.campaign_path || "unknown")
      .filter(Boolean);
    const grossRevenue = sum(cohorts, (cohort) => cohort.gross_revenue);
    const netRevenue = sum(cohorts, (cohort) => cohort.net_revenue);
    const trialUsers = sum(cohorts, (cohort) => cohort.trial_users);
    const refundUsers = new Set(cohorts.flatMap((cohort) => cohort.refunded_user_ids)).size;

    const spendRows = params.trafficByKey
      ? cohorts.map((cohort) => trafficForCohort(cohort, params.trafficByKey!)).filter(Boolean)
      : [];
    let spend: number | null = null;
    let spend_status: FbSpendStatus;
    if (capsuled) {
      spend = capsuled.spend;
      spend_status = "available";
    } else if (!params.trafficByKey || spendRows.length === 0) {
      spend_status = "no_traffic_data";
    } else if (!cohortPaths.every(pathIsExclusive)) {
      // Exact per-campaign spend is impossible because another campaign shares this path.
      spend_status = "unavailable_shared_path";
    } else {
      spend = sum(spendRows, (row) => row.spend);
      spend_status = "available";
    }

    const upsell1Users = sum(cohorts, (cohort) => cohort.upsell_1_users);
    const upsell2Users = sum(cohorts, (cohort) => cohort.upsell_2_users);
    const upsell3Users = sum(cohorts, (cohort) => cohort.upsell_3_users);
    const tokenBuyers = new Set(cohorts.flatMap((cohort) => cohort.token_buyer_user_ids ?? [])).size;
    const tokenRevenue = sum(cohorts, (cohort) => cohort.token_net_revenue);
    const firstSubscriptionUsers = sum(cohorts, (cohort) => cohort.first_subscription_users);
    const fbPurchases = capsuled?.fb_purchases ?? 0;

    return {
      campaign_id: option.campaign_id,
      campaign_name:
        capsuled?.campaign_name ??
        option.campaign_name ??
        Array.from(trialUserIds)
          .map((userId) => {
            const trial = trialByUser.get(userId);
            return trial ? campaignNameForTransaction(trial) : null;
          })
          .find(Boolean) ??
        null,
      campaign_path: campaignPathSummary(paths),
      ad_account_id: capsuled?.ad_account_id ?? null,
      ad_account_name: capsuled?.ad_account_name ?? null,
      trial_users: trialUsers,
      upsell_users: sum(cohorts, (cohort) => cohort.upsell_users),
      upsell_1_users: upsell1Users,
      upsell_2_users: upsell2Users,
      upsell_3_users: upsell3Users,
      token_buyers: tokenBuyers,
      token_revenue: round2(tokenRevenue),
      upsell_cr: trialUsers ? (sum(cohorts, (cohort) => cohort.upsell_users) / trialUsers) * 100 : 0,
      first_subscription_users: firstSubscriptionUsers,
      trial_to_sub_cr: trialUsers ? (firstSubscriptionUsers / trialUsers) * 100 : 0,
      renewal_2_users: sum(cohorts, (cohort) => renewalUsersForLevel(cohort, 2)),
      renewal_3_users: sum(cohorts, (cohort) => renewalUsersForLevel(cohort, 3)),
      active_subscriptions: new Set(cohorts.flatMap((cohort) => cohort.active_subscription_user_ids)).size,
      gross_revenue: round2(grossRevenue),
      net_revenue: round2(netRevenue),
      spend,
      spend_status,
      fb_purchases: fbPurchases,
      cpp: capsuled?.cpp ?? null,
      impressions: capsuled?.impressions ?? 0,
      clicks: capsuled?.clicks ?? 0,
      ctr: capsuled?.ctr ?? null,
      cpc: capsuled?.cpc ?? null,
      cpm: capsuled?.cpm ?? null,
      outbound_clicks: capsuled?.outbound_clicks ?? 0,
      outbound_ctr: capsuled?.outbound_ctr ?? null,
      currency: capsuled?.currency ?? null,
      cac: spend != null && trialUsers ? spend / trialUsers : null,
      cost_per_first_sub: spend != null && firstSubscriptionUsers ? spend / firstSubscriptionUsers : null,
      roas: spend ? netRevenue / spend : null,
      revenue_per_trial: trialUsers ? netRevenue / trialUsers : null,
      revenue_per_purchase: fbPurchases ? netRevenue / fbPurchases : null,
      profit: spend != null ? netRevenue - spend : null,
      refund_users: refundUsers,
      refund_rate: trialUsers ? (refundUsers / trialUsers) * 100 : 0,
      failed_payment_users: failedPaymentUsers(parentTxs, trialUserIds),
      main_decline_reason: topDeclineReason(parentTxs, trialUserIds),
    } satisfies FbAnalyticsRow;
  });

  const searchedRows = rows
    .filter((row) => searchMatches(row, String(filters.campaignIdSearch ?? "").trim().toLowerCase()))
    .filter((row) => rowMatchesExtraFilters(row, filters));
  return {
    rows: sortFbAnalyticsRows(searchedRows),
    summary: summarize(searchedRows),
  };
}

export function campaignDisplayName(row: Pick<FbAnalyticsRow, "campaign_id" | "campaign_name">): string {
  return row.campaign_name ? `${row.campaign_name} (${campaignIdLabel(row.campaign_id)})` : campaignIdLabel(row.campaign_id);
}

// ---------------------------------------------------------------------------
// Reconciliation: FB Analytics totals must agree with Cohorts for the same filters (Phase 6).
// ---------------------------------------------------------------------------

export const FB_RECONCILIATION_TOLERANCE_PCT = 0.1;

export type FbReconciliationMetric = "Trial Users" | "Upsell Users" | "First Sub Users" | "Gross Rev" | "Net Rev";

export interface FbReconciliationRow {
  metric: FbReconciliationMetric;
  fbValue: number;
  cohortValue: number;
  diff: number;
  diffPct: number;
  mismatch: boolean;
}

function relativeDiffPct(a: number, b: number): number {
  const denom = Math.max(Math.abs(a), Math.abs(b));
  if (denom === 0) return 0;
  return (Math.abs(a - b) / denom) * 100;
}

export function reconcileFbAnalyticsTotals(
  summary: Pick<FbAnalyticsSummary, "trialUsers" | "upsellUsers" | "firstSubscriptionUsers" | "grossRevenue" | "netRevenue">,
  cohortTotals: Pick<CohortReportTotals, "totalTrialUsers" | "totalUpsellUsers" | "totalFirstSubscriptionUsers" | "grossRevenue" | "netRevenue">,
  tolerancePct = FB_RECONCILIATION_TOLERANCE_PCT,
): FbReconciliationRow[] {
  const pairs: Array<[FbReconciliationMetric, number, number]> = [
    ["Trial Users", summary.trialUsers, cohortTotals.totalTrialUsers],
    ["Upsell Users", summary.upsellUsers, cohortTotals.totalUpsellUsers],
    ["First Sub Users", summary.firstSubscriptionUsers, cohortTotals.totalFirstSubscriptionUsers],
    ["Gross Rev", summary.grossRevenue, cohortTotals.grossRevenue],
    ["Net Rev", summary.netRevenue, cohortTotals.netRevenue],
  ];
  return pairs.map(([metric, fbValue, cohortValue]) => {
    const diffPct = relativeDiffPct(fbValue, cohortValue);
    return {
      metric,
      fbValue: round2(fbValue),
      cohortValue: round2(cohortValue),
      diff: round2(fbValue - cohortValue),
      diffPct: round2(diffPct),
      mismatch: diffPct > tolerancePct,
    };
  });
}

// Cohort baseline computed over the SAME Facebook-attributed universe + filters that FB Analytics
// uses, so the two are directly comparable.
export function fbAnalyticsCohortBaselineTotals(params: {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  filters?: FbAnalyticsFilters;
}): CohortReportTotals {
  const filters = params.filters ?? {};
  const selectedCardTypes = normalizeCardTypes(filters.selectedCardTypes);
  const trafficSourceFilter = hasSuccessfulFacebookTrial(params.txs) ? "facebook" : "all";
  const parentTxs = filterTransactionsByTrialAttribution(params.txs, { trafficSourceFilter });
  const cohortFilters: CohortFilters = {
    funnelFilter: filters.funnelFilter,
    campaignPathFilter: filters.campaignPathFilter,
    refundFilter: filters.refundFilter,
    cohortDateFrom: filters.cohortDateFrom,
    cohortDateTo: filters.cohortDateTo,
  };
  const cohorts = filterCohorts(
    computeCohorts(parentTxs, params.subscriptions ?? [], {
      selectedCountries: filters.selectedCountries,
      selectedCardTypes,
    }),
    cohortFilters,
  );
  return computeCohortReportTotals(cohorts);
}

export function fbAnalyticsReconciliation(params: {
  txs: Transaction[];
  subscriptions?: SubscriptionClean[];
  trafficByKey?: Map<string, TrafficAggregate>;
  filters?: FbAnalyticsFilters;
}): FbReconciliationRow[] {
  const { summary } = buildFbAnalytics(params);
  return reconcileFbAnalyticsTotals(summary, fbAnalyticsCohortBaselineTotals(params));
}

// Dev-only guardrail: warn when FB Analytics and Cohorts disagree by more than the tolerance.
export function logFbReconciliationInDev(comparisons: FbReconciliationRow[]): void {
  if (!import.meta.env?.DEV) return;
  const mismatches = comparisons.filter((row) => row.mismatch);
  if (!mismatches.length) return;
  console.warn(
    "[FB Analytics] Totals do not reconcile with Cohorts (>0.1% diff): " +
      mismatches.map((row) => `${row.metric}: FB ${row.fbValue} vs Cohorts ${row.cohortValue} (${row.diffPct}%)`).join("; "),
  );
}
