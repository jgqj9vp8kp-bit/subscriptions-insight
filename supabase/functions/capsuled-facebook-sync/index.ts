/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  capsuledTrafficMetric,
  enumerateDays,
  MAX_DAILY_SPLIT_DAYS,
  pathMappingStats,
  resolveCampaignPaths,
  supersededPeriodRowIds,
  type CampaignPathEvidenceRow,
} from "../_shared/clickhouse/capsuledTraffic.ts";
import { loadActiveCampaignAliasMap } from "../_shared/clickhouse/fbCampaignResolution.ts";
import { CONFIRMED_FB_CAMPAIGN_ALIASES } from "../_shared/clickhouse/fbSourceClassification.ts";

const LEVELS = new Set(["account", "campaign", "adset", "ad", "day"]);
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 3;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

type Level = "account" | "campaign" | "adset" | "ad" | "day";

type NormalizedRow = {
  date_from: string;
  date_to: string;
  level: Level;
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
};

type RequestParams = {
  dateFrom: string;
  dateTo: string;
  level: Level;
  force?: boolean;
};

class CapsuledApiError extends Error {
  status: number;
  contentType: string | null;
  bodyPreview: string;

  constructor(message: string, params: { status: number; contentType: string | null; bodyPreview: string }) {
    super(message);
    this.name = "CapsuledApiError";
    this.status = params.status;
    this.contentType = params.contentType;
    this.bodyPreview = params.bodyPreview;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueByAlias(source: unknown, aliases: readonly string[]): unknown {
  if (!isRecord(source)) return undefined;
  const normalizedAliases = aliases.map(normalizeKey);
  for (const alias of aliases) {
    if (source[alias] != null) return source[alias];
  }
  for (const [key, value] of Object.entries(source)) {
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

function num(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const numeric = raw.replace(/\s+/g, "").replace(/[%$€£]/g, "");
  const decimalNormalized = numeric.includes(",") && numeric.includes(".")
    ? numeric.replace(/,/g, "")
    : numeric.replace(",", ".");
  const parsed = Number(decimalNormalized.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNum(value: unknown): number | null {
  if (value == null || String(value).trim() === "") return null;
  return num(value);
}

function dateKey(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function payloadRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  for (const key of ["data", "rows", "stats", "items", "result"]) {
    if (Array.isArray(payload[key])) return payload[key] as unknown[];
  }
  return [];
}

function normalizeRows(payload: unknown, params: RequestParams, importedAt: string): NormalizedRow[] {
  const fallbackDateFrom = dateKey(params.dateFrom) ?? params.dateFrom;
  const fallbackDateTo = dateKey(params.dateTo) ?? params.dateTo;
  return payloadRows(payload)
    .filter(isRecord)
    .map((row) => {
      const spend = num(valueByAlias(row, ["spend", "amount_spent", "cost"]));
      const purchases = num(valueByAlias(row, ["fb_purchases", "purchases", "purchase", "actions_purchase"]));
      const clicks = num(valueByAlias(row, ["clicks", "link_clicks"]));
      const impressions = num(valueByAlias(row, ["impressions"]));
      const outboundClicks = num(valueByAlias(row, ["outbound_clicks", "outbound clicks"]));
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
        cpp: nullableNum(valueByAlias(row, ["cpp", "cost_per_purchase", "cost per purchase"])) ?? (purchases ? spend / purchases : null),
        impressions,
        clicks,
        ctr: nullableNum(valueByAlias(row, ["ctr"])) ?? (impressions ? (clicks / impressions) * 100 : null),
        cpc: nullableNum(valueByAlias(row, ["cpc"])) ?? (clicks ? spend / clicks : null),
        cpm: nullableNum(valueByAlias(row, ["cpm"])) ?? (impressions ? (spend / impressions) * 1000 : null),
        outbound_clicks: outboundClicks,
        outbound_ctr:
          nullableNum(valueByAlias(row, ["outbound_ctr", "outbound ctr"])) ?? (impressions ? (outboundClicks / impressions) * 100 : null),
        currency: stringValue(row, ["currency", "account_currency"]),
        last_import_at: importedAt,
        raw_payload: row,
      } satisfies NormalizedRow;
    });
}

function aggregateRows(rows: NormalizedRow[]): NormalizedRow[] {
  const byKey = new Map<string, NormalizedRow>();
  for (const row of rows) {
    const key = [row.level, row.campaign_id ?? "", row.date_from, row.date_to].join("__");
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...row });
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
    current.raw_payload = [current.raw_payload, row.raw_payload].flat();
    current.last_import_at = row.last_import_at > current.last_import_at ? row.last_import_at : current.last_import_at;
  }
  return Array.from(byKey.values());
}

function parseRequestFromUrl(req: Request): RequestParams {
  const url = new URL(req.url);
  const dateFrom = url.searchParams.get("dateFrom") ?? url.searchParams.get("date_from") ?? "";
  const dateTo = url.searchParams.get("dateTo") ?? url.searchParams.get("date_to") ?? "";
  const level = url.searchParams.get("level") ?? "campaign";
  if (!LEVELS.has(level)) throw new Error("Invalid level. Use account, campaign, adset, ad, or day.");
  if (!dateKey(dateFrom) || !dateKey(dateTo)) throw new Error("dateFrom and dateTo must be valid dates.");
  return { dateFrom: dateKey(dateFrom)!, dateTo: dateKey(dateTo)!, level: level as Level, force: url.searchParams.get("force") === "true" };
}

async function parseRequest(req: Request): Promise<RequestParams> {
  if (req.method === "GET") return parseRequestFromUrl(req);
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const dateFrom = dateKey(body.dateFrom ?? body.date_from);
  const dateTo = dateKey(body.dateTo ?? body.date_to);
  const level = String(body.level ?? "campaign");
  if (!LEVELS.has(level)) throw new Error("Invalid level. Use account, campaign, adset, ad, or day.");
  if (!dateFrom || !dateTo) throw new Error("dateFrom and dateTo must be valid dates.");
  return { dateFrom, dateTo, level: level as Level, force: Boolean(body.force) };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, token: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCapsuled(payload: RequestParams, failedRequests: string[]): Promise<{ payload: unknown; status: number; responseText: string }> {
  const token = Deno.env.get("CAPSULED_API_TOKEN");
  const baseUrl = Deno.env.get("CAPSULED_API_BASE_URL");
  if (!token) throw new Error("CAPSULED_API_TOKEN is not configured.");
  if (!baseUrl) throw new Error("CAPSULED_API_BASE_URL is not configured.");

  const url = new URL("/api/external/v1/fb-stats", baseUrl.replace(/\/+$/, ""));
  url.searchParams.set("dateFrom", payload.dateFrom);
  url.searchParams.set("dateTo", payload.dateTo);
  url.searchParams.set("level", payload.level);

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url.toString(), token, DEFAULT_TIMEOUT_MS);
      const responseText = await response.text();
      const contentType = response.headers.get("content-type");
      const bodyPreview = responseText.slice(0, 300);
      if (response.status === 401 || response.status === 403) {
        throw new CapsuledApiError("Capsuled token rejected or expired", {
          status: response.status,
          contentType,
          bodyPreview,
        });
      }
      if (response.status === 429 || response.status >= 500) {
        failedRequests.push(`Attempt ${attempt}: HTTP ${response.status}`);
        if (attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
      }
      if (!response.ok) {
        throw new Error(`Capsuled API error HTTP ${response.status}: ${responseText.slice(0, 500)}`);
      }
      if (!contentType?.toLowerCase().includes("application/json")) {
        throw new CapsuledApiError("Capsuled returned non-JSON response", {
          status: response.status,
          contentType,
          bodyPreview,
        });
      }
      return { payload: responseText ? JSON.parse(responseText) : null, status: response.status, responseText: responseText.slice(0, 1000) };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      failedRequests.push(`Attempt ${attempt}: ${message}`);
      if (error instanceof CapsuledApiError) throw error;
      if (attempt < MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Capsuled API request failed.");
}

function errorStatus(error: Error): number {
  if (error.message === "CAPSULED_API_TOKEN is not configured.") return 401;
  if (error.message === "Capsuled token rejected or expired") return 401;
  return 502;
}

function importKey(row: NormalizedRow): string {
  return [row.level, row.campaign_id ?? "missing", row.date_from, row.date_to].join("__");
}

/** campaign_id -> funnel path, from trial-transaction evidence (RPC) plus the
 * Layer A alias map. Any failure degrades to an empty map: the snapshot still
 * builds with the historical name fallback instead of blocking the sync. */
async function loadCampaignPathMap(
  client: ReturnType<typeof createClient>,
  userId: string,
): Promise<{ pathByCampaign: Map<string, string>; error: string | null }> {
  try {
    const [{ data: evidence, error: evidenceError }, aliases] = await Promise.all([
      client.rpc("capsuled_campaign_path_evidence", { p_auth_user_id: userId }),
      loadActiveCampaignAliasMap(client, userId).catch(() => ({ ...CONFIRMED_FB_CAMPAIGN_ALIASES })),
    ]);
    if (evidenceError) throw new Error(evidenceError.message);
    return { pathByCampaign: resolveCampaignPaths((evidence ?? []) as CampaignPathEvidenceRow[], aliases), error: null };
  } catch (error) {
    return { pathByCampaign: new Map(), error: error instanceof Error ? error.message : "Campaign path evidence failed." };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET" && req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Capsuled sync is not configured." }, 500);

  const authHeader = req.headers.get("authorization") ?? "";
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await client.auth.getUser(authHeader.replace(/^Bearer\s+/i, ""));
  if (userError || !userData.user?.id) return jsonResponse({ error: "Sign in before syncing Capsuled Facebook data." }, 401);

  const userId = userData.user.id;
  const startedAt = Date.now();
  let params: RequestParams;
  try {
    params = await parseRequest(req);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : "Invalid request." }, 400);
  }

  const failedRequests: string[] = [];
  let syncId: string | null = null;

  try {
    // Campaign-level multi-day windows are fetched DAY BY DAY: the API returns
    // one aggregated row per campaign for the whole window, which would date a
    // week of spend on its first day (see capsuledTraffic.ts).
    const splitDays = params.level === "campaign" && params.dateFrom !== params.dateTo
      ? enumerateDays(params.dateFrom, params.dateTo)
      : [];
    if (splitDays.length > MAX_DAILY_SPLIT_DAYS) {
      return jsonResponse(
        { error: `Campaign-level sync fetches per-day rows; the window is limited to ${MAX_DAILY_SPLIT_DAYS} days. Split the range into smaller windows.` },
        400,
      );
    }

    const importedAt = new Date().toISOString();
    const failedDays: string[] = [];
    let rows: NormalizedRow[];
    let responseText: string;
    let rawPayload: unknown;
    if (splitDays.length) {
      const collected: NormalizedRow[] = [];
      for (const day of splitDays) {
        const dayParams: RequestParams = { dateFrom: day, dateTo: day, level: params.level, force: params.force };
        try {
          const { payload } = await fetchCapsuled(dayParams, failedRequests);
          collected.push(...normalizeRows(payload, dayParams, importedAt));
        } catch (error) {
          failedDays.push(day);
          failedRequests.push(`Day ${day}: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof CapsuledApiError) throw error; // auth/format errors will not heal on the next day
        }
      }
      rows = aggregateRows(collected);
      rawPayload = { mode: "daily", days: splitDays.length, failed_days: failedDays, rows: rows.length };
      responseText = JSON.stringify(rawPayload);
    } else {
      const single = await fetchCapsuled(params, failedRequests);
      rows = aggregateRows(normalizeRows(single.payload, params, importedAt));
      rawPayload = single.payload;
      responseText = single.responseText;
    }
    const durationMs = Date.now() - startedAt;
    const facebookStatsDate = rows.map((row) => row.date_to).sort().at(-1) ?? params.dateTo;

    const { data: syncRow, error: syncError } = await client
      .from("capsuled_facebook_syncs")
      .insert({
        user_id: userId,
        date_from: params.dateFrom,
        date_to: params.dateTo,
        level: params.level,
        status: failedRequests.length ? "partial" : "success",
        raw_payload: rawPayload,
        rows_imported: rows.length,
        api_freshness: facebookStatsDate,
        facebook_stats_date: facebookStatsDate,
        duration_ms: durationMs,
        last_api_response: responseText,
        failed_requests: failedRequests,
        finished_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (syncError) throw syncError;
    syncId = (syncRow as { id: string }).id;

    if (rows.length) {
      const { error: upsertError } = await client.from("capsuled_facebook_stats").upsert(
        rows.map((row) => ({
          user_id: userId,
          sync_id: syncId,
          import_key: importKey(row),
          ...row,
          updated_at: new Date().toISOString(),
        })),
        { onConflict: "user_id,import_key" },
      );
      if (upsertError) throw upsertError;
    }

    // A fully successful daily window supersedes the multi-day period rows it
    // covers: keeping both would double-count the same spend (daily rows plus
    // the window aggregate). Any failed day keeps the period rows in place so
    // no spend disappears. PostgREST cannot compare two columns, so candidate
    // rows are picked in JS and deleted by id.
    if (splitDays.length && !failedDays.length) {
      const { data: windowRows, error: windowError } = await client
        .from("capsuled_facebook_stats")
        .select("id,date_from,date_to")
        .eq("user_id", userId)
        .eq("level", "campaign")
        .gte("date_from", params.dateFrom)
        .lte("date_to", params.dateTo);
      if (!windowError) {
        const staleIds = supersededPeriodRowIds(
          (windowRows ?? []) as Array<{ id: string; date_from: string; date_to: string }>,
          params.dateFrom,
          params.dateTo,
        );
        for (let i = 0; i < staleIds.length; i += 200) {
          const { error: deleteError } = await client
            .from("capsuled_facebook_stats")
            .delete()
            .eq("user_id", userId)
            .in("id", staleIds.slice(i, i + 200));
          if (deleteError) {
            failedRequests.push(`Superseded-row cleanup failed: ${deleteError.message}`);
            break;
          }
        }
      }
    }

    // PostgREST caps a single response at 1000 rows regardless of .limit();
    // with daily-split rows the campaign table is well past that, so the
    // snapshot source must be read in pages or it silently truncates.
    const statsRows: NormalizedRow[] = [];
    const SNAPSHOT_PAGE = 1000;
    for (let offset = 0; offset < 50000; offset += SNAPSHOT_PAGE) {
      const { data: page, error: pageError } = await client
        .from("capsuled_facebook_stats")
        .select("date_from,date_to,level,campaign_id,campaign_name,ad_account_id,ad_account_name,spend,fb_purchases,cpp,impressions,clicks,ctr,cpc,cpm,outbound_clicks,outbound_ctr,currency,last_import_at,raw_payload")
        .eq("user_id", userId)
        .eq("level", "campaign")
        .order("date_from", { ascending: false })
        .order("import_key", { ascending: true })
        .range(offset, offset + SNAPSHOT_PAGE - 1);
      if (pageError) throw pageError;
      const rowsPage = (page ?? []) as NormalizedRow[];
      statsRows.push(...rowsPage);
      if (rowsPage.length < SNAPSHOT_PAGE) break;
    }
    const { pathByCampaign, error: pathMapError } = await loadCampaignPathMap(client, userId);
    const trafficMetrics = statsRows.map((row) => capsuledTrafficMetric(row, pathByCampaign));
    await client.from("data_snapshots").upsert(
      {
        user_id: userId,
        dataset_type: "facebook_traffic",
        name: "Capsuled Facebook traffic",
        payload: { trafficMetrics },
        metadata: {
          source: "capsuled_facebook",
          rows_count: trafficMetrics.length,
          latest_sync_id: syncId,
          saved_at: new Date().toISOString(),
          date_range: { from: params.dateFrom, to: params.dateTo },
          path_mapping: { ...pathMappingStats(statsRows, pathByCampaign), ...(pathMapError ? { error: pathMapError } : {}) },
        },
      },
      { onConflict: "user_id,dataset_type" },
    );

    const spend = rows.reduce((total, row) => total + row.spend, 0);
    const fbPurchases = rows.reduce((total, row) => total + row.fb_purchases, 0);
    const campaignIds = Array.from(new Set(rows.map((row) => row.campaign_id).filter(Boolean)));
    return jsonResponse({
      rows,
      metadata: {
        syncId,
        status: failedRequests.length ? "partial" : "success",
        connected: true,
        startedAt: new Date(startedAt).toISOString(),
        lastSync: importedAt,
        level: params.level,
        dateFrom: params.dateFrom,
        dateTo: params.dateTo,
        rowsImported: rows.length,
        apiFreshness: facebookStatsDate,
        facebookStatsDate,
        syncDurationMs: durationMs,
        campaignsImported: campaignIds.length,
        spend,
        fbPurchases,
        lastApiResponse: responseText,
        failedRequests,
      },
      diagnostics: {
        importedCampaignIds: campaignIds.sort(),
        subengineCampaignIds: [],
        matchedCampaignIds: [],
        unmatchedCampaignIds: campaignIds.sort(),
        duplicateCampaignIds: [],
        missingCampaignIds: rows.filter((row) => !row.campaign_id).length,
        campaignsImported: campaignIds.length,
        matched: 0,
        unmatched: campaignIds.length,
        spend,
        fbPurchases,
        latestImport: importedAt,
        lastApiResponse: responseText,
        importDurationMs: durationMs,
        failedRequests,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Capsuled sync failed.";
    const durationMs = Date.now() - startedAt;
    await client.from("capsuled_facebook_syncs").insert({
      user_id: userId,
      date_from: params.dateFrom,
      date_to: params.dateTo,
      level: params.level,
      status: "failed",
      rows_imported: 0,
      duration_ms: durationMs,
      last_api_response: message,
      failed_requests: failedRequests,
      error_message: message,
      finished_at: new Date().toISOString(),
    });
    if (error instanceof CapsuledApiError) {
      return jsonResponse(
        {
          error: message,
          status: error.status,
          content_type: error.contentType,
          body_preview: error.bodyPreview,
          failedRequests,
          durationMs,
        },
        error.status === 401 || error.status === 403 ? 401 : 502,
      );
    }
    return jsonResponse({ error: message, failedRequests, durationMs }, error instanceof Error ? errorStatus(error) : 502);
  }
});
