import { supabase } from "@/services/supabaseClient";
import { campaignIdForTransaction, UNKNOWN_CAMPAIGN_ID } from "@/services/cohortFiltering";
import type { Transaction } from "@/services/types";

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

export interface CapsuledFacebookSyncMetadata {
  syncId?: string;
  status: "success" | "failed" | "partial" | "unknown";
  connected: boolean;
  startedAt?: string | null;
  lastSync: string | null;
  level: CapsuledFacebookLevel | null;
  dateFrom: string | null;
  dateTo: string | null;
  rowsImported: number;
  apiFreshness: string | null;
  facebookStatsDate: string | null;
  syncDurationMs: number | null;
  campaignsImported: number;
  spend: number;
  fbPurchases: number;
  lastApiResponse: string | null;
  failedRequests: string[];
}

export interface CapsuledFacebookDiagnostics {
  importedCampaignIds: string[];
  subengineCampaignIds: string[];
  matchedCampaignIds: string[];
  unmatchedCampaignIds: string[];
  duplicateCampaignIds: string[];
  missingCampaignIds: number;
  campaignsImported: number;
  matched: number;
  unmatched: number;
  spend: number;
  fbPurchases: number;
  latestImport: string | null;
  lastApiResponse: string | null;
  importDurationMs: number | null;
  failedRequests: string[];
}

export interface CapsuledFacebookSyncRequest {
  dateFrom: string;
  dateTo: string;
  level: CapsuledFacebookLevel;
  force?: boolean;
}

export interface CapsuledFacebookSyncResult {
  rows: CapsuledFacebookRow[];
  metadata: CapsuledFacebookSyncMetadata;
  diagnostics: CapsuledFacebookDiagnostics;
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueByAlias(source: unknown, aliases: readonly string[]): unknown {
  if (!isRecord(source)) return undefined;
  const entries = Object.entries(source);
  const normalizedAliases = aliases.map(normalizeKey);
  for (const alias of aliases) {
    if (source[alias] != null) return source[alias];
  }
  for (const [key, value] of entries) {
    if (normalizedAliases.includes(normalizeKey(key))) return value;
  }
  return undefined;
}

function stringValue(source: unknown, aliases: readonly string[]): string | null {
  const value = valueByAlias(source, aliases);
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

export function parseCapsuledNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const numeric = raw.replace(/\s+/g, "").replace(/[%$€£]/g, "");
  const decimalNormalized = numeric.includes(",") && numeric.includes(".")
    ? numeric.replace(/,/g, "")
    : numeric.replace(",", ".");
  const cleaned = decimalNormalized.replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  return parseCapsuledNumber(value);
}

function dateKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function isCapsuledFacebookLevel(value: unknown): value is CapsuledFacebookLevel {
  return CAPSULED_FACEBOOK_LEVELS.includes(value as CapsuledFacebookLevel);
}

function rowsFromPayload(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["data", "rows", "stats", "items", "result"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function normalizeCapsuledFacebookRows(params: {
  payload: unknown;
  dateFrom: string;
  dateTo: string;
  level: CapsuledFacebookLevel;
  importedAt?: string;
}): CapsuledFacebookRow[] {
  const importedAt = params.importedAt ?? new Date().toISOString();
  const fallbackDateFrom = dateKey(params.dateFrom) ?? params.dateFrom;
  const fallbackDateTo = dateKey(params.dateTo) ?? params.dateTo;

  return rowsFromPayload(params.payload)
    .filter(isRecord)
    .map((row) => {
      const spend = parseCapsuledNumber(valueByAlias(row, ["spend", "amount_spent", "cost"]));
      const purchases = parseCapsuledNumber(valueByAlias(row, ["fb_purchases", "purchases", "purchase", "actions_purchase"]));
      const clicks = parseCapsuledNumber(valueByAlias(row, ["clicks", "link_clicks"]));
      const impressions = parseCapsuledNumber(valueByAlias(row, ["impressions"]));
      const outboundClicks = parseCapsuledNumber(valueByAlias(row, ["outbound_clicks", "outbound clicks"]));
      return {
        date_from: dateKey(valueByAlias(row, ["date_from", "date_start", "from", "date"])) ?? fallbackDateFrom,
        date_to: dateKey(valueByAlias(row, ["date_to", "date_stop", "to", "date"])) ?? fallbackDateTo,
        level: params.level,
        campaign_id: stringValue(row, ["campaign_id", "campaign id", "campaignId"]),
        campaign_name: stringValue(row, ["campaign_name", "campaign name", "campaignName"]),
        ad_account_id: stringValue(row, ["ad_account_id", "account_id", "account id", "adAccountId"]),
        ad_account_name: stringValue(row, ["ad_account_name", "account_name", "account name", "adAccountName"]),
        spend,
        fb_purchases: purchases,
        cpp: nullableNumber(valueByAlias(row, ["cpp", "cost_per_purchase", "cost per purchase"])) ?? (purchases ? spend / purchases : null),
        impressions,
        clicks,
        ctr: nullableNumber(valueByAlias(row, ["ctr"])) ?? (impressions ? (clicks / impressions) * 100 : null),
        cpc: nullableNumber(valueByAlias(row, ["cpc"])) ?? (clicks ? spend / clicks : null),
        cpm: nullableNumber(valueByAlias(row, ["cpm"])) ?? (impressions ? (spend / impressions) * 1000 : null),
        outbound_clicks: outboundClicks,
        outbound_ctr:
          nullableNumber(valueByAlias(row, ["outbound_ctr", "outbound ctr"])) ?? (impressions ? (outboundClicks / impressions) * 100 : null),
        currency: stringValue(row, ["currency", "account_currency"]),
        last_import_at: importedAt,
        raw_payload: row,
      } satisfies CapsuledFacebookRow;
    })
    .filter((row) => row.date_from && row.date_to);
}

export function aggregateCapsuledRowsByCampaign(rows: CapsuledFacebookRow[]): CapsuledFacebookRow[] {
  const byKey = new Map<string, CapsuledFacebookRow & { _rowCount?: number }>();
  for (const row of rows) {
    const key = [row.level, row.campaign_id ?? "", row.date_from, row.date_to].join("__");
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...row, _rowCount: 1 });
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
    current.raw_payload = [current.raw_payload, row.raw_payload].flat();
    current._rowCount = (current._rowCount ?? 1) + 1;
  }
  return Array.from(byKey.values()).map(({ _rowCount, ...row }) => row);
}

export function buildCapsuledMatchingDiagnostics(params: {
  rows: CapsuledFacebookRow[];
  txs: Transaction[];
  metadata?: Partial<CapsuledFacebookSyncMetadata> | null;
}): CapsuledFacebookDiagnostics {
  const importedIds = params.rows.map((row) => row.campaign_id?.trim() ?? "").filter(Boolean);
  const importedSet = new Set(importedIds);
  const counts = new Map<string, number>();
  importedIds.forEach((id) => counts.set(id, (counts.get(id) ?? 0) + 1));

  const subengineSet = new Set<string>();
  for (const tx of params.txs) {
    if (tx.status !== "success" || tx.transaction_type !== "trial") continue;
    const id = campaignIdForTransaction(tx);
    if (id && id !== UNKNOWN_CAMPAIGN_ID) subengineSet.add(id);
  }

  const matchedCampaignIds = Array.from(importedSet).filter((id) => subengineSet.has(id)).sort();
  const unmatchedCampaignIds = Array.from(importedSet).filter((id) => !subengineSet.has(id)).sort();
  const duplicateCampaignIds = Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort();

  return {
    importedCampaignIds: Array.from(importedSet).sort(),
    subengineCampaignIds: Array.from(subengineSet).sort(),
    matchedCampaignIds,
    unmatchedCampaignIds,
    duplicateCampaignIds,
    missingCampaignIds: params.rows.filter((row) => !row.campaign_id?.trim()).length,
    campaignsImported: importedSet.size,
    matched: matchedCampaignIds.length,
    unmatched: unmatchedCampaignIds.length,
    spend: params.rows.reduce((total, row) => total + row.spend, 0),
    fbPurchases: params.rows.reduce((total, row) => total + row.fb_purchases, 0),
    latestImport: params.rows.map((row) => row.last_import_at).sort().at(-1) ?? params.metadata?.lastSync ?? null,
    lastApiResponse: params.metadata?.lastApiResponse ?? null,
    importDurationMs: params.metadata?.syncDurationMs ?? null,
    failedRequests: params.metadata?.failedRequests ?? [],
  };
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function syncCapsuledFacebookStats(request: CapsuledFacebookSyncRequest): Promise<CapsuledFacebookSyncResult> {
  const client = ensureSupabase();
  const { data, error } = await client.functions.invoke("capsuled-facebook-sync", {
    body: request,
  });
  if (error) {
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      const bodyText = await context.text().catch(() => "");
      let bodyMessage = bodyText;
      try {
        const parsed = JSON.parse(bodyText) as { error?: unknown; message?: unknown };
        bodyMessage = String(parsed.error ?? parsed.message ?? bodyText);
      } catch {
        // Keep the raw body text when the Edge Function returns non-JSON.
      }
      throw new Error(`Capsuled Edge Function failed (HTTP ${context.status}): ${bodyMessage || context.statusText}`);
    }
    throw new Error(error.message);
  }
  if (!data || typeof data !== "object") throw new Error("Capsuled sync returned an invalid response.");
  return data as CapsuledFacebookSyncResult;
}

export async function listCapsuledFacebookRows(limit = 5000): Promise<CapsuledFacebookRow[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("capsuled_facebook_stats")
    .select(
      "date_from,date_to,level,campaign_id,campaign_name,ad_account_id,ad_account_name,spend,fb_purchases,cpp,impressions,clicks,ctr,cpc,cpm,outbound_clicks,outbound_ctr,currency,last_import_at,raw_payload",
    )
    .order("last_import_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load Capsuled Facebook rows: ${error.message}`);
  return (data ?? []) as CapsuledFacebookRow[];
}

export async function getCapsuledFacebookStatus(): Promise<CapsuledFacebookSyncMetadata> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("capsuled_facebook_syncs")
    .select("id,status,created_at,finished_at,date_from,date_to,level,duration_ms,rows_imported,api_freshness,facebook_stats_date,last_api_response,failed_requests")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Could not load Capsuled Facebook status: ${error.message}`);
  if (!data) {
    return {
      status: "unknown",
      connected: false,
      startedAt: null,
      lastSync: null,
      level: null,
      dateFrom: null,
      dateTo: null,
      rowsImported: 0,
      apiFreshness: null,
      facebookStatsDate: null,
      syncDurationMs: null,
      campaignsImported: 0,
      spend: 0,
      fbPurchases: 0,
      lastApiResponse: null,
      failedRequests: [],
    };
  }
  return {
    syncId: String(data.id),
    status: data.status as CapsuledFacebookSyncMetadata["status"],
    connected: data.status === "success",
    startedAt: (data.created_at as string | null) ?? null,
    lastSync: (data.finished_at as string | null) ?? (data.created_at as string | null),
    level: isCapsuledFacebookLevel(data.level) ? data.level : null,
    dateFrom: (data.date_from as string | null) ?? null,
    dateTo: (data.date_to as string | null) ?? null,
    rowsImported: Number(data.rows_imported ?? 0),
    apiFreshness: (data.api_freshness as string | null) ?? null,
    facebookStatsDate: (data.facebook_stats_date as string | null) ?? null,
    syncDurationMs: data.duration_ms == null ? null : Number(data.duration_ms),
    campaignsImported: 0,
    spend: 0,
    fbPurchases: 0,
    lastApiResponse: (data.last_api_response as string | null) ?? null,
    failedRequests: Array.isArray(data.failed_requests) ? data.failed_requests.map(String) : [],
  };
}
