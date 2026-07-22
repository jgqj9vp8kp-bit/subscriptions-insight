// Pure Facebook traffic-sheet row contract + campaign-path normalization, shared by the
// browser app and Edge Functions. Google-Sheet fetching/parsing stays in src/services/trafficImport.ts.

export interface TrafficMetric {
  date: string;
  campaign_path: string;
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_account_id?: string | null;
  ad_account_name?: string | null;
  trial_count: number;
  cac: number;
  spend: number;
  fb_purchases?: number;
  cpp?: number | null;
  impressions?: number;
  clicks: number;
  outbound_clicks?: number;
  outbound_ctr?: number | null;
  cpc: number;
  cpm: number;
  ctr: number;
  currency?: string | null;
  last_import_at?: string;
  source: "facebook";
}

export const CAPSULED_FACEBOOK_LEVELS = ["account", "campaign", "adset", "ad", "day"] as const;

export type CapsuledFacebookLevel = (typeof CAPSULED_FACEBOOK_LEVELS)[number];

export interface CapsuledFacebookRow {
  date_from: string;
  date_to: string;
  level: CapsuledFacebookLevel;
  campaign_id: string | null;
  campaign_name: string | null;
  ad_account_id: string | null;
  ad_account_name: string | null;
  spend: number;
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
  last_import_at: string;
  raw_payload: unknown;
}

export function normalizeCampaignPath(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}
