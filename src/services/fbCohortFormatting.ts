// Formatting + presentation-level derivation for the FB Analytics columns on
// the Cohorts page. Pure functions only: every input is a server-computed
// value from ONE cohorts bundle; nothing here scans transactions or FB rows.
// Null/absent → "—" (never NaN, Infinity, or $0.00 masquerading as data).

import type { CohortFbFields, CohortRow } from "@/services/types";

const round2 = (x: number): number => Math.round(x * 100) / 100;

export const FB_DASH = "—";

export function formatFbUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return FB_DASH;
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatFbInt(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return FB_DASH;
  return Math.round(value).toLocaleString("en-US");
}

export function formatFbPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return FB_DASH;
  return `${value.toFixed(2)}%`;
}

export function formatFbRoas(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return FB_DASH;
  return `${value.toFixed(2)}×`;
}

/** Spend renders $0.00 only for a REAL matched zero; unmatched/unknown → "—". */
export function formatFbSpend(row: Pick<CohortRow, "fb_spend" | "fb_match_status">): string {
  if (row.fb_spend == null) return FB_DASH;
  if (row.fb_match_status === "mixed_currency") return FB_DASH;
  return formatFbUsd(row.fb_spend);
}

/**
 * Cohort-side business ratios (STEP 18): FB spend against cohort denominators.
 * Distinct from fb_cpp (FB-attributed purchases): CAC/Cost-per-Trial use the
 * cohort's OWN user counts. Null when the denominator or spend is missing.
 */
export function deriveFbBusinessMetrics(row: {
  fb_spend?: number;
  fb_match_status?: string;
  trial_users: number;
  first_subscription_users: number;
  upsell_users: number;
  gross_revenue: number;
  net_revenue: number;
}): Pick<CohortFbFields, "fb_cac" | "fb_cost_per_trial" | "fb_cost_per_upsell" | "fb_gross_roas" | "fb_net_roas" | "fb_profit" | "fb_margin"> {
  const spend = row.fb_match_status === "mixed_currency" ? null : row.fb_spend;
  if (spend == null) {
    return { fb_cac: null, fb_cost_per_trial: null, fb_cost_per_upsell: null, fb_gross_roas: null, fb_net_roas: null, fb_profit: null, fb_margin: null };
  }
  const profit = round2(row.net_revenue - spend);
  return {
    fb_cac: row.first_subscription_users > 0 ? round2(spend / row.first_subscription_users) : null,
    fb_cost_per_trial: row.trial_users > 0 ? round2(spend / row.trial_users) : null,
    fb_cost_per_upsell: row.upsell_users > 0 ? round2(spend / row.upsell_users) : null,
    fb_gross_roas: spend > 0 ? round2(row.gross_revenue / spend) : null,
    fb_net_roas: spend > 0 ? round2(row.net_revenue / spend) : null,
    fb_profit: profit,
    fb_margin: row.net_revenue > 0 ? round2((profit / row.net_revenue) * 100) : null,
  };
}

/** Column ids of every FB metric on the Cohorts table, in display order. */
export const FB_COHORT_DEFAULT_COLUMNS = ["fb_spend", "fb_purchases", "fb_cpp"] as const;
export const FB_COHORT_OPTIONAL_COLUMNS = [
  "fb_impressions",
  "fb_reach",
  "fb_clicks",
  "fb_link_clicks",
  "fb_ctr",
  "fb_cpc",
  "fb_cpm",
  "fb_purchase_value",
  "fb_roas",
  "fb_cac",
  "fb_cost_per_trial",
  "fb_cost_per_upsell",
  "fb_gross_roas",
  "fb_net_roas",
  "fb_profit",
  "fb_margin",
] as const;
export const FB_COHORT_COLUMNS = [...FB_COHORT_DEFAULT_COLUMNS, ...FB_COHORT_OPTIONAL_COLUMNS];

export const FB_COHORT_COLUMN_LABELS: Record<string, string> = {
  fb_spend: "Spend (FB)",
  fb_purchases: "FB Purchases",
  fb_cpp: "CPP (FB)",
  fb_impressions: "Impressions",
  fb_reach: "Reach",
  fb_clicks: "Clicks (FB)",
  fb_link_clicks: "Link Clicks",
  fb_ctr: "CTR (FB)",
  fb_cpc: "CPC (FB)",
  fb_cpm: "CPM (FB)",
  fb_purchase_value: "Purchase Value (FB)",
  fb_roas: "FB ROAS",
  fb_cac: "CAC (FB Spend)",
  fb_cost_per_trial: "Cost / Trial (FB)",
  fb_cost_per_upsell: "Cost / Upsell (FB)",
  fb_gross_roas: "Gross ROAS (FB)",
  fb_net_roas: "Net ROAS (FB)",
  fb_profit: "Profit (FB)",
  fb_margin: "Margin (FB)",
};

/** Render a cohort row's FB column to display text (used by table + export). */
export function fbCohortCellText(row: CohortRow, columnId: string): string {
  switch (columnId) {
    case "fb_spend": return formatFbSpend(row);
    case "fb_purchases": return row.fb_spend == null ? FB_DASH : formatFbInt(row.fb_purchases ?? 0);
    case "fb_cpp": return formatFbUsd(row.fb_cpp);
    case "fb_impressions": return row.fb_spend == null ? FB_DASH : formatFbInt(row.fb_impressions ?? 0);
    case "fb_reach": return row.fb_reach ? formatFbInt(row.fb_reach) : FB_DASH;
    case "fb_clicks": return row.fb_spend == null ? FB_DASH : formatFbInt(row.fb_clicks ?? 0);
    case "fb_link_clicks": return row.fb_link_clicks ? formatFbInt(row.fb_link_clicks) : FB_DASH;
    case "fb_ctr": return formatFbPct(row.fb_ctr);
    case "fb_cpc": return formatFbUsd(row.fb_cpc);
    case "fb_cpm": return formatFbUsd(row.fb_cpm);
    case "fb_purchase_value": return row.fb_purchase_value ? formatFbUsd(row.fb_purchase_value) : FB_DASH;
    case "fb_roas": return formatFbRoas(row.fb_roas);
    case "fb_cac": return formatFbUsd(row.fb_cac);
    case "fb_cost_per_trial": return formatFbUsd(row.fb_cost_per_trial);
    case "fb_cost_per_upsell": return formatFbUsd(row.fb_cost_per_upsell);
    case "fb_gross_roas": return formatFbRoas(row.fb_gross_roas);
    case "fb_net_roas": return formatFbRoas(row.fb_net_roas);
    case "fb_profit": return formatFbUsd(row.fb_profit);
    case "fb_margin": return formatFbPct(row.fb_margin);
    default: return FB_DASH;
  }
}
