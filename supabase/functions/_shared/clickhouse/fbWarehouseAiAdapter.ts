// Warehouse campaign row → AI engine campaign row (brief §6).
//
// The FB warehouse table (runFbList, campaign level) carries FB metrics plus
// the campaign_id-joined Subengine blend. The AI campaign engine consumes
// FbAnalyticsRow — this adapter maps the blend onto exactly the fields the
// campaign ladder reads (spend/cac, trials, conversion, user-based refunds,
// roas, campaign_path for peer pools) and zeroes the rest. Fields the
// warehouse cannot provide stay at their "unknown" values: no daily series
// (trend stays missing — rung 5a covers converting campaigns), no
// renewal/upsell splits, no decline reasons.
//
// Pure module: no Deno, no fetch, no clock.

import type { FbAnalyticsRow } from "./fbAnalyticsCompute.ts";
import type { FbListRow } from "./facebookStats.ts";

export function aiCampaignRowFromWarehouse(row: FbListRow): FbAnalyticsRow | null {
  if (!row.campaign_id) return null;
  const blended = row.blended;
  const trials = blended?.trial_users ?? 0;
  const firstSubs = blended?.first_subscription_users ?? 0;
  const refunds = blended?.refund_users ?? 0;
  const gross = blended?.tx_gross_revenue ?? 0;
  const net = blended?.tx_net_revenue ?? 0;
  const spend = Number.isFinite(row.spend) && row.spend > 0 ? row.spend : null;
  return {
    campaign_id: row.campaign_id,
    campaign_name: row.campaign_name || null,
    campaign_path: blended?.campaign_path ?? "",
    ad_account_id: row.ad_account_id || null,
    ad_account_name: row.ad_account_name || null,
    trial_users: trials,
    upsell_users: 0,
    upsell_1_users: 0,
    upsell_2_users: 0,
    upsell_3_users: 0,
    token_buyers: 0,
    token_revenue: 0,
    upsell_cr: 0,
    first_subscription_users: firstSubs,
    trial_to_sub_cr: trials > 0 ? (firstSubs / trials) * 100 : 0,
    renewal_2_users: 0,
    renewal_3_users: 0,
    active_subscriptions: 0,
    gross_revenue: gross,
    net_revenue: net,
    spend,
    spend_status: spend != null ? "available" : "no_traffic_data",
    fb_purchases: row.fb_purchases,
    cpp: row.cpp ?? null,
    impressions: row.impressions,
    clicks: row.clicks,
    ctr: row.ctr ?? null,
    cpc: row.cpc ?? null,
    cpm: row.cpm ?? null,
    outbound_clicks: row.outbound_clicks,
    outbound_ctr: row.outbound_ctr ?? null,
    currency: null,
    cac: blended?.cac ?? null,
    cost_per_first_sub: spend != null && firstSubs > 0 ? spend / firstSubs : null,
    roas: blended?.roas ?? null,
    revenue_per_trial: blended?.revenue_per_trial ?? null,
    revenue_per_purchase: null,
    profit: spend != null ? net - spend : null,
    refund_users: refunds,
    refund_rate: trials > 0 ? (refunds / trials) * 100 : 0,
    failed_payment_users: 0,
    main_decline_reason: null,
  };
}
