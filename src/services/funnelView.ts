// Funnels view: one row per campaign_path, aggregated over the selected period.
//
// This is NOT a second analytics engine. Every number on a funnel row is a
// projection of `computeCohortReportTotals` — the exact function behind the
// Cohorts Total row — run over that path's already-filtered cohort rows. The
// invariants "Funnels TOTAL == Cohorts TOTAL" and "a single selected path's
// funnel row == the Cohorts Total for that path" are therefore true by
// construction, not by parallel bookkeeping.
//
// Client-side on purpose: the cohorts response is the FULL filtered row set
// (no pagination), so regrouping here is total; and the FB business ratios
// need `deriveFbBusinessMetrics`, which lives client-side.
import type { CohortRow, Funnel } from "@/services/types";
import {
  computeCohortReportTotals,
  funnelTrafficForGroup,
  type CohortTraffic,
  type TrafficAggregate,
} from "@/services/cohortReporting";
import { deriveFbBusinessMetrics } from "@/services/fbCohortFormatting";

/** Synthetic id prefix — cannot collide with real cohort ids, which are built
 * as `${funnel}_${path}_${date}` (cohortIdentity.buildCohortId). */
export const FUNNEL_ROW_ID_PREFIX = "funnelpath:";

export interface FunnelViewRow extends CohortRow {
  funnel_display_name: string;
  funnel_cohort_count: number;
  funnel_date_min: string;
  funnel_date_max: string;
  /** Distinct `funnel` values seen in the group (a path can feed several). */
  funnel_values: string[];
  /** Traffic joined per unique (date, path) key — never per cohort row. */
  funnel_traffic: CohortTraffic | null;
  funnel_has_traffic: boolean;
  funnel_has_complete_traffic: boolean;
}

export function isFunnelViewRow(row: CohortRow): row is FunnelViewRow {
  return row.cohort_id.startsWith(FUNNEL_ROW_ID_PREFIX);
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Sorted union — canonical output independent of input row order. */
const unionSorted = (rows: readonly CohortRow[], pick: (c: CohortRow) => string[] | undefined): string[] =>
  [...new Set(rows.flatMap((row) => pick(row) ?? []))].sort();

/** Aggregated fb_match_status, mirroring the per-row `rowStatus` priority in
 * fbCohortStats: a poisoned row poisons the group (conservative), then full
 * vs partial coverage, then the strongest "no spend" explanation present. */
function aggregateFbMatchStatus(rows: readonly CohortRow[], matched: number, unmatched: number): string {
  const statuses = new Set(rows.map((row) => row.fb_match_status).filter(Boolean));
  if (statuses.has("overallocated")) return "overallocated";
  if (statuses.has("invalid_campaign_metric")) return "invalid_campaign_metric";
  const currencies = new Set(rows.map((row) => row.fb_currency).filter((c): c is string => Boolean(c)));
  if (currencies.size > 1 || statuses.has("mixed_currency")) return "mixed_currency";
  if (matched > 0 && unmatched === 0) return "matched";
  if (matched > 0) return "partial_coverage";
  for (const status of ["no_fb_purchases", "no_fb_campaign", "missing_cohort_campaign_id"]) {
    if (statuses.has(status)) return status;
  }
  return rows[0]?.fb_match_status ?? "missing_cohort_campaign_id";
}

export function buildFunnelViewRows(input: {
  cohorts: readonly CohortRow[];
  trafficByKey: Map<string, TrafficAggregate>;
  displayNameByPath?: ReadonlyMap<string, string>;
}): FunnelViewRow[] {
  const groups = new Map<string, CohortRow[]>();
  for (const row of input.cohorts) {
    const path = row.campaign_path || "unknown";
    const list = groups.get(path);
    if (list) list.push(row);
    else groups.set(path, [row]);
  }

  const out: FunnelViewRow[] = [];
  for (const [path, rows] of groups) {
    // The single metric-definition path: identical to the Total row's engine.
    const t = computeCohortReportTotals(rows as CohortRow[]);
    const m = t.monetization;
    const traffic = funnelTrafficForGroup(rows, input.trafficByKey);

    const dates = rows.map((row) => String(row.cohort_date ?? "").slice(0, 10)).filter(Boolean).sort();
    const funnelValues = [...new Set(rows.map((row) => String(row.funnel)))].sort();

    // FB: per-user allocation partitions across rows, so summing the non-null
    // row spends reproduces the server bundle's totals for this subset.
    const fbSpendRows = rows.filter((row) => row.fb_spend != null);
    const fbSpend = fbSpendRows.length ? round2(fbSpendRows.reduce((sum, row) => sum + (row.fb_spend ?? 0), 0)) : null;
    const fbMatched = rows.reduce((sum, row) => sum + (row.fb_matched_users ?? 0), 0);
    const fbUnmatched = rows.reduce((sum, row) => sum + (row.fb_unmatched_users ?? 0), 0);
    const fbPurchasesRows = rows.filter((row) => row.fb_purchases != null);
    const fbPurchases = fbPurchasesRows.length
      ? fbPurchasesRows.reduce((sum, row) => sum + (row.fb_purchases ?? 0), 0)
      : null;
    const fbCurrencies = new Set(rows.map((row) => row.fb_currency).filter((c): c is string => Boolean(c)));
    const fbMatchStatus = aggregateFbMatchStatus(rows, fbMatched, fbUnmatched);

    const sum = (pick: (c: CohortRow) => number | undefined) =>
      rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
    const revenueD14 = sum((c) => c.revenue_d14);
    const trial = t.totalTrialUsers;

    const base: CohortRow = {
      cohort_id: FUNNEL_ROW_ID_PREFIX + path,
      // Youngest cohort date: consumed only by maturity displays, giving the
      // conservative "matured only when even the newest cohort matured".
      cohort_date: dates[dates.length - 1] ?? "",
      funnel: (funnelValues.length === 1 ? funnelValues[0] : "unknown") as Funnel,
      campaign_path: path,
      trial_users: trial,
      support_users: t.totalSupportUsers,
      support_rate: t.totalSupportRate,
      active_users: t.totalActiveUsers,
      active_rate: t.totalActiveRate,
      active_subscriptions: t.totalActiveSubscriptions,
      active_subscriptions_rate: t.totalActiveSubscriptionsRate,
      active_subscription_user_ids: unionSorted(rows, (c) => c.active_subscription_user_ids),
      active_subscription_ids: unionSorted(rows, (c) => c.active_subscription_ids),
      cancelled_users: t.totalCancelledUsers,
      cancellation_rate: t.totalCancellationRate,
      user_cancelled_users: t.totalUserCancelledUsers,
      user_cancel_rate: t.totalUserCancelRate,
      auto_cancelled_users: t.totalAutoCancelledUsers,
      auto_cancel_rate: t.totalAutoCancelRate,
      cancelled_active_users: t.totalCancelledActiveUsers,
      active_user_ids: unionSorted(rows, (c) => c.active_user_ids),
      cancelled_user_ids: unionSorted(rows, (c) => c.cancelled_user_ids),
      user_cancelled_user_ids: unionSorted(rows, (c) => c.user_cancelled_user_ids),
      auto_cancelled_user_ids: unionSorted(rows, (c) => c.auto_cancelled_user_ids),
      cancelled_active_user_ids: unionSorted(rows, (c) => c.cancelled_active_user_ids),
      upsell_users: t.totalUpsellUsers,
      first_subscription_users: t.totalFirstSubscriptionUsers,
      renewal_2_users: t.totalRenewal2Users,
      renewal_3_users: t.totalRenewal3Users,
      renewal_4_users: t.totalRenewal4Users,
      renewal_5_users: t.totalRenewal5Users,
      renewal_6_users: t.totalRenewal6Users,
      renewal_users_by_level: { ...t.renewalTotalsByLevel },
      renewal_users: t.totalRenewalUsers,
      refund_users: t.totalRefundUsers,
      refunded_user_ids: unionSorted(rows, (c) => c.refunded_user_ids),
      plan_breakdown: [],
      trial_revenue: t.trialRevenue,
      upsell_revenue: t.upsellRevenue,
      first_subscription_revenue: t.firstSubscriptionRevenue,
      renewal_revenue: t.renewalRevenue,
      amount_refunded: t.amountRefunded,
      refund_rate: t.refundRate,
      gross_revenue: t.grossRevenue,
      net_revenue: t.netRevenue,
      gross_ltv: trial ? round2(t.grossRevenue / trial) : 0,
      net_ltv: trial ? round2(t.netRevenue / trial) : 0,
      trial_to_upsell_cr: t.trialToUpsellCr,
      trial_to_first_subscription_cr: t.trialToFirstSubscriptionCr,
      first_subscription_to_renewal_2_cr: t.firstSubscriptionToRenewal2Cr,
      renewal_2_to_renewal_3_cr: t.renewal2ToRenewal3Cr,
      renewal_3_to_renewal_4_cr: t.renewal3ToRenewal4Cr ?? 0,
      renewal_4_to_renewal_5_cr: t.renewal4ToRenewal5Cr ?? 0,
      renewal_5_to_renewal_6_cr: t.renewal5ToRenewal6Cr ?? 0,
      revenue_d0: t.revenueD0,
      revenue_d7: t.revenueD7,
      revenue_d14: revenueD14,
      revenue_d30: t.revenueD30,
      revenue_d60: t.revenueD60,
      revenue_d37: 0,
      revenue_d67: 0,
      revenue_total: t.netRevenue,
      ltv_d7: trial ? round2(t.revenueD7 / trial) : 0,
      ltv_d14: trial ? round2(revenueD14 / trial) : 0,
      ltv_d30: trial ? round2(t.revenueD30 / trial) : 0,
      net_revenue_1m: sum((c) => c.net_revenue_1m),
      ltv_1m_per_user: t.ltv1mPerUser,
      // Monetization: user counts partition across cohorts; CRs from totals.
      upsell_1_users: m.upsell1Users,
      upsell_2_users: m.upsell2Users,
      upsell_3_users: m.upsell3Users,
      upsell_extra_users: m.upsellExtraUsers,
      upsell_1_revenue: m.upsell1Revenue,
      upsell_2_revenue: m.upsell2Revenue,
      upsell_3_revenue: m.upsell3Revenue,
      upsell_extra_revenue: m.upsellExtraRevenue,
      upsell_1_cr: m.upsell1Cr,
      upsell_2_cr: m.upsell2Cr,
      upsell_3_cr: m.upsell3Cr,
      funnel_upsell_users: m.funnelUpsellUsers,
      funnel_upsell_revenue: m.funnelUpsellRevenue,
      token_buyers: m.tokenBuyers,
      token_buyer_cr: m.tokenBuyerCr,
      token_purchases: m.tokenPurchases,
      token_gross_revenue: m.tokenGrossRevenue,
      token_net_revenue: m.tokenNetRevenue,
      avg_token_revenue_per_trial: m.avgTokenRevenuePerTrial,
      avg_token_revenue_per_buyer: m.avgTokenRevenuePerBuyer,
      addon_revenue: m.addonRevenue,
      token_buyer_user_ids: unionSorted(rows, (c) => c.token_buyer_user_ids),
      token_pack_breakdown: [],
      currency_breakdown: [],
      currency_mix: "",
      fx_missing_amount: 0,
      fx_missing_transactions: t.fxMissingTransactions,
      // FB block: sums are exact (per-user allocation partition); ratios and
      // the 7 business metrics re-derived on the aggregated inputs.
      fb_spend: fbSpend,
      fb_currency: fbCurrencies.size === 1 ? [...fbCurrencies][0] : null,
      fb_purchases: fbPurchases,
      fb_cpp: fbSpend != null && fbMatched > 0 ? round2(fbSpend / fbMatched) : null,
      fb_impressions: null,
      fb_reach: null,
      fb_clicks: null,
      fb_link_clicks: null,
      fb_ctr: null,
      fb_cpc: null,
      fb_cpm: null,
      fb_purchase_value: null,
      fb_roas: null,
      // fb_campaigns_matched is a distinct count — not additive, omitted.
      fb_match_status: fbMatchStatus,
      fb_reporting_date: null,
      fb_campaign_cpp: null,
      fb_user_cpp: null,
      fb_matched_users: fbMatched,
      fb_unmatched_users: fbUnmatched,
      fb_campaign_coverage: null,
      fb_cpp_source: "campaign_spend_div_fb_purchases",
      fb_timezone: null,
      coverage_rate: fbMatched + fbUnmatched > 0 ? round2((fbMatched / (fbMatched + fbUnmatched)) * 100) : null,
    };

    out.push({
      ...base,
      ...deriveFbBusinessMetrics({
        fb_spend: fbSpend,
        fb_match_status: fbMatchStatus,
        trial_users: trial,
        first_subscription_users: t.totalFirstSubscriptionUsers,
        upsell_users: t.totalUpsellUsers,
        gross_revenue: t.grossRevenue,
        net_revenue: t.netRevenue,
      }),
      funnel_display_name: input.displayNameByPath?.get(path) || path,
      funnel_cohort_count: rows.length,
      funnel_date_min: dates[0] ?? "",
      funnel_date_max: dates[dates.length - 1] ?? "",
      funnel_values: funnelValues,
      funnel_traffic: traffic.traffic,
      funnel_has_traffic: traffic.rowsWithTraffic > 0,
      funnel_has_complete_traffic: rows.length > 0 && traffic.rowsWithTraffic === rows.length,
    });
  }

  // Deterministic base order; the page re-sorts per the active sort state.
  return out.sort((a, b) => b.trial_users - a.trial_users || a.campaign_path.localeCompare(b.campaign_path));
}
