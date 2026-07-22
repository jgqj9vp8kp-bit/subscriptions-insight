// FB Analytics warehouse pipeline for the clickhouse-facebook Edge Function.
//
// Source of truth: Capsuled fb-stats API → this module → fact_facebook_stats
// (ReplacingMergeTree) → aggregate-only read actions for the FB Analytics page.
// The browser never talks to Capsuled and never computes analytics.
//
// API facts (probed live, 2026-07-15 — do not "simplify" these away):
// - GET /api/external/v1/fb-stats?level=&dateFrom=&dateTo=  (all required;
//   `lastDays` is NOT accepted — the docs' mention of it is stale).
// - level ∈ account | campaign | adset | ad | day.
// - CRITICAL: windows wider than ONE DAY silently MERGE consecutive days of an
//   entity into a single dateFrom..dateTo row (spend totals stay correct, daily
//   granularity is destroyed). Proven live: a 180-day account request returned
//   24 multi-day rows covering 96 true entity-days; sums matched to the cent at
//   every window size. Entity levels are therefore fetched one day per request
//   over the day-level scan's active dates. The `day` level itself is immune
//   (one row per date, no entity dimensions) and doubles as the spend ground
//   truth for the per-level completeness check.
// - Range is capped at 180 days AND responses are additionally capped at
//   1000 rows with NO pagination — the day-level scan still splits adaptively.
// - Envelope: { ok, version, source, range, level, currency, dataFreshness:
//   { fbStatsTo, lastImportAt }, notes[], rows[] }. currency is response-level.
// - Stats restate retroactively (today/yesterday keep updating), so incremental
//   sync re-pulls a trailing window and relies on ReplacingMergeTree(row_version).

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE, FACT_FACEBOOK_STATS_TABLE, ensureFactFacebookStatsSchema } from "./schema.ts";
import {
  computeFbBatchChecksum,
  computeFbBatchDq,
  createFbSyncHistoryRecorder,
  type FbSyncTrigger,
} from "./fbSyncHistory.ts";
import { buildFbV2DqChecks, createFbWarehouseV2Writer } from "./fbWarehouseV2Writer.ts";

export const FB_SYNC_NAME = "fact_facebook_stats_sync";
export const FB_LEVELS = ["account", "campaign", "adset", "ad", "day"] as const;
export type FbLevel = (typeof FB_LEVELS)[number];

export const FB_API_MAX_RANGE_DAYS = 180;
export const FB_API_ROW_CAP = 1000;
/** Parallel single-day entity fetches per batch (keeps a full sync ~25s, well under the Edge timeout). */
export const FB_DAY_FETCH_CONCURRENCY = 6;
/** Trailing window re-pulled by every incremental sync (Meta restates recent days). */
export const FB_INCREMENTAL_DEFAULT_DAYS = 3;
/** Full sync horizon: capped lookback that comfortably covers the account history. */
export const FB_FULL_SYNC_LOOKBACK_DAYS = 540;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FB = FACT_FACEBOOK_STATS_TABLE;
const MAX_IN = 200;

export class FacebookStatsRequestError extends Error {}

export class FacebookStatsValidationError extends Error {
  readonly code = "FB_SPEND_MISMATCH";
  readonly safeMessage = "Facebook export validation failed: entity-level Spend does not match the day-level source of truth. Previous warehouse data remains active.";

  constructor(readonly validationDiagnostics: Record<string, unknown>) {
    super("Facebook export validation failed: Spend mismatch between entity and day levels.");
    this.name = "FacebookStatsValidationError";
  }
}

const n = (v: unknown): number => {
  const p = Number(v ?? 0);
  return Number.isFinite(p) ? p : 0;
};
const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const round2 = (x: number): number => Math.round(x * 100) / 100;

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

function validDate(v: unknown, field: string): string | null {
  if (v == null || v === "") return null;
  const raw = s(v).trim();
  if (!DATE_RE.test(raw)) throw new FacebookStatsRequestError(`Invalid ${field} (YYYY-MM-DD): ${raw}`);
  return raw;
}

function stringArray(v: unknown, field: string): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new FacebookStatsRequestError(`Filter ${field} must be an array of strings.`);
  const out = Array.from(new Set(v.map((x) => s(x).trim()).filter(Boolean)));
  if (out.length > MAX_IN) throw new FacebookStatsRequestError(`Filter ${field} has too many values (max ${MAX_IN}).`);
  return out;
}

export function normalizeFbLevel(v: unknown, fallback: FbLevel = "campaign"): FbLevel {
  return FB_LEVELS.includes(v as FbLevel) ? (v as FbLevel) : fallback;
}

// ---- Dates (UTC day keys) ---------------------------------------------------

export function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return utcDayKey(d);
}

export function dayDiff(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

// ---- Capsuled API row mapping ----------------------------------------------

export interface FbWarehouseRow {
  auth_user_id: string;
  stat_date: string;
  level: FbLevel;
  ad_account_id: string;
  ad_account_name: string;
  buyer: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
  geo: string;
  currency: string;
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  link_clicks: number;
  outbound_clicks: number;
  fb_purchases: number;
  purchase_value: number;
  cpp: number | null;
  cpc: number | null;
  cpm: number | null;
  ctr: number | null;
  outbound_ctr: number | null;
  frequency: number | null;
  roas: number | null;
  raw_payload: string;
  fb_stats_to: string;
  source_updated_at: string;
  clickhouse_synced_at: string;
  warehouse_version: string;
  row_version: number;
}

export interface CapsuledEnvelope {
  ok?: boolean;
  currency?: string;
  dataFreshness?: { fbStatsTo?: string; lastImportAt?: string };
  rows?: unknown[];
  error?: string;
  message?: string;
}

function chTime(value: string | null | undefined, fallback: string): string {
  const parsed = value ? new Date(value) : null;
  const date = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date(fallback);
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function nullableNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const p = Number(v);
  return Number.isFinite(p) ? p : null;
}

/** ClickHouse min/max(Date) over zero rows yields the epoch — treat it as "no data". */
function dateOrNull(v: unknown): string | null {
  const raw = s(v).slice(0, 10);
  return DATE_RE.test(raw) && raw !== "1970-01-01" ? raw : null;
}

/** Map one Capsuled API row into a warehouse row. Returns null for undateable rows. */
export function mapCapsuledRow(input: {
  row: unknown;
  level: FbLevel;
  authUserId: string;
  envelope: CapsuledEnvelope;
  syncedAtIso: string;
  warehouseVersion: string;
  rowVersion: number;
}): FbWarehouseRow | null {
  if (!isRecord(input.row)) return null;
  const r = input.row;
  const date = s(r.date || r.dateFrom).slice(0, 10);
  if (!DATE_RE.test(date)) return null;
  const freshness = input.envelope.dataFreshness ?? {};
  return {
    auth_user_id: input.authUserId,
    stat_date: date,
    level: input.level,
    ad_account_id: s(r.adAccountId),
    ad_account_name: s(r.adAccountName),
    buyer: s(r.buyer),
    campaign_id: s(r.campaignId),
    campaign_name: s(r.campaignName),
    adset_id: s(r.adsetId),
    adset_name: s(r.adsetName),
    ad_id: s(r.adId),
    ad_name: s(r.adName),
    geo: s(r.geo ?? r.country ?? ""),
    currency: s(input.envelope.currency || r.currency || "USD"),
    spend: n(r.spend),
    impressions: Math.round(n(r.impressions)),
    reach: Math.round(n(r.reach)),
    clicks: Math.round(n(r.clicks)),
    link_clicks: Math.round(n(r.linkClicks ?? r.link_clicks)),
    outbound_clicks: Math.round(n(r.outboundClicks)),
    fb_purchases: Math.round(n(r.fbPurchases ?? r.purchases)),
    purchase_value: n(r.purchaseValue ?? r.purchase_value),
    cpp: nullableNum(r.cpp),
    cpc: nullableNum(r.cpc),
    cpm: nullableNum(r.cpm),
    ctr: nullableNum(r.ctr),
    outbound_ctr: nullableNum(r.outboundCtr),
    frequency: nullableNum(r.frequency),
    roas: nullableNum(r.roas),
    raw_payload: JSON.stringify(r),
    fb_stats_to: DATE_RE.test(s(freshness.fbStatsTo)) ? s(freshness.fbStatsTo) : date,
    source_updated_at: chTime(freshness.lastImportAt, input.syncedAtIso),
    clickhouse_synced_at: chTime(input.syncedAtIso, input.syncedAtIso),
    warehouse_version: input.warehouseVersion,
    row_version: input.rowVersion,
  };
}

// ---- Capsuled fetching with adaptive range splitting -------------------------

export interface CapsuledFetchStats {
  requests: number;
  payload_bytes: number;
  api_latency_ms: number;
  splits: number;
  failed_attempts: string[];
}

export type CapsuledFetcher = (dateFrom: string, dateTo: string, level: FbLevel) => Promise<{ envelope: CapsuledEnvelope; bytes: number; latencyMs: number }>;

export function createCapsuledFetcher(env: { token: string; baseUrl: string }, fetchImpl: typeof fetch = fetch): CapsuledFetcher {
  return async (dateFrom, dateTo, level) => {
    const url = new URL("/api/external/v1/fb-stats", env.baseUrl.replace(/\/+$/, ""));
    url.searchParams.set("dateFrom", dateFrom);
    url.searchParams.set("dateTo", dateTo);
    url.searchParams.set("level", level);
    const started = Date.now();
    const response = await fetchImpl(url.toString(), {
      headers: { Authorization: `Bearer ${env.token}`, Accept: "application/json" },
    });
    const text = await response.text();
    const latencyMs = Date.now() - started;
    if (response.status === 401 || response.status === 403) {
      throw new Error("Capsuled token rejected or expired.");
    }
    if (!response.ok) {
      throw new Error(`Capsuled API HTTP ${response.status}: ${text.slice(0, 200)}`);
    }
    const envelope = JSON.parse(text) as CapsuledEnvelope;
    if (envelope.ok === false) throw new Error(`Capsuled API error: ${s(envelope.message || envelope.error)}`);
    return { envelope, bytes: text.length, latencyMs };
  };
}

/** Split [from..to] into API-legal chunks (≤ maxRangeDays each). */
export function planDateChunks(dateFrom: string, dateTo: string, maxRangeDays = FB_API_MAX_RANGE_DAYS): Array<{ from: string; to: string }> {
  const chunks: Array<{ from: string; to: string }> = [];
  let cursor = dateFrom;
  while (dayDiff(cursor, dateTo) >= 0) {
    const end = addDays(cursor, maxRangeDays - 1);
    // Chunk ends at whichever comes FIRST: the range end or the API limit.
    const to = dayDiff(end, dateTo) >= 0 ? end : dateTo;
    chunks.push({ from: cursor, to });
    cursor = addDays(to, 1);
  }
  return chunks;
}

/**
 * Fetch one level over a range, recursively halving any window whose response
 * hits the silent 1000-row cap (a capped response is TRUNCATED, not complete —
 * its rows must be discarded and re-fetched in halves down to single days).
 */
export async function fetchLevelRows(input: {
  fetcher: CapsuledFetcher;
  level: FbLevel;
  dateFrom: string;
  dateTo: string;
  stats: CapsuledFetchStats;
  rowCap?: number;
}): Promise<{ rows: unknown[]; envelope: CapsuledEnvelope }> {
  const cap = input.rowCap ?? FB_API_ROW_CAP;
  const { fetcher, level, stats } = input;

  async function walk(from: string, to: string): Promise<{ rows: unknown[]; envelope: CapsuledEnvelope }> {
    const { envelope, bytes, latencyMs } = await fetcher(from, to, level);
    stats.requests += 1;
    stats.payload_bytes += bytes;
    stats.api_latency_ms += latencyMs;
    const rows = Array.isArray(envelope.rows) ? envelope.rows : [];
    if (rows.length < cap || from === to) return { rows, envelope };
    // Capped: split the window and merge halves (discard the truncated batch).
    stats.splits += 1;
    const mid = addDays(from, Math.floor(dayDiff(from, to) / 2));
    const left = await walk(from, mid);
    const right = await walk(addDays(mid, 1), to);
    return { rows: [...left.rows, ...right.rows], envelope: right.envelope };
  }

  const chunks = planDateChunks(input.dateFrom, input.dateTo);
  const all: unknown[] = [];
  let lastEnvelope: CapsuledEnvelope = {};
  for (const chunk of chunks) {
    const result = await walk(chunk.from, chunk.to);
    all.push(...result.rows);
    lastEnvelope = result.envelope;
  }
  return { rows: all, envelope: lastEnvelope };
}

// ---- Sync state (Supabase clickhouse_transaction_sync_state) -----------------

export async function getFbSyncState(supabase: SupabaseLikeClient, authUserId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("sync_name", FB_SYNC_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not load FB sync state: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

async function upsertFbSyncState(supabase: SupabaseLikeClient, patch: Record<string, unknown> & { auth_user_id: string }): Promise<void> {
  const { error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .upsert({ sync_name: FB_SYNC_NAME, ...patch, updated_at: new Date().toISOString() }, { onConflict: "auth_user_id,sync_name" });
  if (error) throw new Error(`Could not persist FB sync state: ${error.message}`);
}

async function jsonRows<T>(client: ClickHouseClientLike, query: string, query_params: Record<string, unknown> = {}): Promise<T[]> {
  const rs = await client.query({ query, query_params, format: "JSONEachRow" });
  return (await rs.json()) as T[];
}

async function warehouseCount(client: ClickHouseClientLike, authUserId: string): Promise<number> {
  const rows = await jsonRows<{ c: number | string }>(
    client,
    `SELECT count() c FROM ${FB} FINAL WHERE auth_user_id = {auth_user_id:String}`,
    { auth_user_id: authUserId },
  );
  return n(rows[0]?.c);
}

// ---- Sync -------------------------------------------------------------------

export interface FbSyncRequest {
  action?: string;
  mode?: "incremental" | "full";
  last_days?: number;
  date_from?: string | null;
  date_to?: string | null;
  levels?: string[];
  /** History-only annotation (facebook_sync_runs.trigger_source). Does not affect the sync itself. */
  trigger_source?: FbSyncTrigger;
}

export interface FbSyncResult {
  status: "completed" | "failed";
  mode: "incremental" | "full";
  date_from: string;
  date_to: string;
  levels: FbLevel[];
  api_rows: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  warehouse_rows_before: number;
  warehouse_rows_after: number;
  warehouse_version: string;
  fb_stats_to: string | null;
  api_last_import_at: string | null;
  api_requests: number;
  api_latency_ms: number;
  api_payload_bytes: number;
  range_splits: number;
  duration_ms: number;
  error?: string;
  /** Append-only history lineage (Facebook Warehouse V2 Phase 1). Absent only if the history layer is unavailable. */
  history_run_id?: string;
  history_batch_id?: string;
  history_errors?: number;
  v2_errors?: number;
}

export function resolveSyncRange(input: {
  mode: "incremental" | "full";
  today: string;
  lastDays?: number | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  cursorDate?: string | null;
}): { dateFrom: string; dateTo: string } {
  if (input.dateFrom && input.dateTo) return { dateFrom: input.dateFrom, dateTo: input.dateTo };
  if (input.mode === "full") {
    return { dateFrom: addDays(input.today, -(FB_FULL_SYNC_LOOKBACK_DAYS - 1)), dateTo: input.today };
  }
  const lastDays = Math.max(1, Math.min(FB_API_MAX_RANGE_DAYS, Math.floor(n(input.lastDays) || FB_INCREMENTAL_DEFAULT_DAYS)));
  let from = addDays(input.today, -(lastDays - 1));
  // Never leave a gap between the cursor (last synced day) and this window.
  if (input.cursorDate && DATE_RE.test(input.cursorDate) && dayDiff(input.cursorDate, from) > 0) {
    from = input.cursorDate;
  }
  return { dateFrom: from, dateTo: input.today };
}

export async function runFacebookStatsSync(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  fetcher: CapsuledFetcher;
  request: FbSyncRequest;
  now?: Date;
}): Promise<FbSyncResult> {
  const started = Date.now();
  const now = input.now ?? new Date();
  const syncedAtIso = now.toISOString();
  const today = utcDayKey(now);
  const mode: "incremental" | "full" = input.request.mode === "full" ? "full" : "incremental";
  // clickhouse_transaction_sync_state CHECK-constrains last_run_mode to the
  // transaction-backfill vocabulary; the honest FB mode lives in diagnostics.mode.
  const lastRunMode = mode === "full" ? "full_backfill" : "continue";
  const warehouseVersion = `fbwh_${now.getTime().toString(36)}`;
  const rowVersion = now.getTime();

  const levels: FbLevel[] = (input.request.levels?.length
    ? input.request.levels.map((l) => normalizeFbLevel(l))
    : [...FB_LEVELS]) as FbLevel[];

  // Append-only history sidecar (Warehouse V2 Phase 1). Fail-safe by contract:
  // every history write swallows its own errors, so the sync below behaves
  // byte-for-byte identically whether the history tables exist or not.
  const history = createFbSyncHistoryRecorder({
    supabase: input.supabase,
    authUserId: input.authUserId,
    warehouseVersion,
    mode,
    trigger: input.request.trigger_source,
    startedAtIso: syncedAtIso,
  });
  // Warehouse V2 dual-writer (Phase 1): writes raw responses, per-grain daily
  // facts, the batch-registry mirror and DQ results BESIDE the V1 pipeline.
  // Same fail-safe contract as `history`; shares its batch/run lineage.
  const v2 = createFbWarehouseV2Writer({
    clickhouse: input.clickhouse,
    supabase: input.supabase,
    authUserId: input.authUserId,
    batchId: history.batchId,
    runId: history.runId,
    warehouseVersion,
    nowIso: syncedAtIso,
  });

  await ensureFactFacebookStatsSchema(input.clickhouse);
  const previousState = await getFbSyncState(input.supabase, input.authUserId).catch(() => null);
  const cursorDate = s(previousState?.cursor_transaction_id) || null;
  const { dateFrom, dateTo } = resolveSyncRange({
    mode,
    today,
    lastDays: input.request.last_days,
    dateFrom: validDate(input.request.date_from, "date_from"),
    dateTo: validDate(input.request.date_to, "date_to"),
    cursorDate,
  });
  if (dayDiff(dateFrom, dateTo) < 0) throw new FacebookStatsRequestError("date_from must be <= date_to.");

  await upsertFbSyncState(input.supabase, {
    auth_user_id: input.authUserId,
    status: "running",
    current_stage: `fetch:${mode}`,
    last_run_mode: lastRunMode,
    started_at: syncedAtIso,
    finished_at: null,
    last_error: null,
  });

  await history.stageBatch();
  await v2.mirrorBatch("staged");
  // Every Capsuled response (and failure) is recorded verbatim; both wrappers are
  // pass-through for the pipeline itself.
  const fetcher = v2.wrapFetcher(history.wrapFetcher(input.fetcher));

  const stats: CapsuledFetchStats = { requests: 0, payload_bytes: 0, api_latency_ms: 0, splits: 0, failed_attempts: [] };
  try {
    const before = await warehouseCount(input.clickhouse, input.authUserId);

    let apiRows = 0;
    let skipped = 0;
    let mergedRowsDetected = 0;
    let fbStatsTo: string | null = null;
    let apiLastImportAt: string | null = null;
    const mapped: FbWarehouseRow[] = [];
    const spendByLevel: Record<string, number> = {};
    const addMapped = (rows: unknown[], level: FbLevel, envelope: CapsuledEnvelope) => {
      apiRows += rows.length;
      fbStatsTo = s(envelope.dataFreshness?.fbStatsTo) || fbStatsTo;
      apiLastImportAt = s(envelope.dataFreshness?.lastImportAt) || apiLastImportAt;
      for (const row of rows) {
        if (isRecord(row) && row.dateFrom != null && row.dateTo != null && row.dateFrom !== row.dateTo) {
          // Single-day windows make merged rows impossible; count any leak honestly.
          mergedRowsDetected += 1;
        }
        const wh = mapCapsuledRow({ row, level, authUserId: input.authUserId, envelope, syncedAtIso, warehouseVersion, rowVersion });
        if (wh) {
          mapped.push(wh);
          spendByLevel[level] = (spendByLevel[level] ?? 0) + wh.spend;
        } else skipped += 1;
      }
    };

    // 1) Day-level scan over the whole range. The `day` level returns exactly
    //    one row per active date (no entity dimensions to merge), so it is both
    //    the list of days that need entity fetches and the spend ground truth.
    const dayScan = await fetchLevelRows({ fetcher, level: "day", dateFrom, dateTo, stats });
    if (levels.includes("day")) addMapped(dayScan.rows, "day", dayScan.envelope);
    const activeDays = Array.from(
      new Set(
        dayScan.rows
          .filter(isRecord)
          .map((r) => s(r.date || r.dateFrom).slice(0, 10))
          .filter((d) => DATE_RE.test(d) && d >= dateFrom && d <= dateTo),
      ),
    ).sort();

    // 2) Entity levels are fetched ONE DAY PER REQUEST — the only window size
    //    the API returns strictly per-day rows for (wider windows silently merge
    //    consecutive days of an entity into one dateFrom..dateTo row, destroying
    //    daily granularity). Requests run in small parallel batches.
    const entityLevels = levels.filter((l): l is FbLevel => l !== "day");
    const tasks: Array<{ day: string; level: FbLevel }> = [];
    for (const day of activeDays) for (const level of entityLevels) tasks.push({ day, level });
    for (let i = 0; i < tasks.length; i += FB_DAY_FETCH_CONCURRENCY) {
      const batch = tasks.slice(i, i + FB_DAY_FETCH_CONCURRENCY);
      const settled = await Promise.all(
        batch.map(async (task) => {
          const { envelope, bytes, latencyMs } = await fetcher(task.day, task.day, task.level);
          stats.requests += 1;
          stats.payload_bytes += bytes;
          stats.api_latency_ms += latencyMs;
          return { task, rows: Array.isArray(envelope.rows) ? envelope.rows : [], envelope };
        }),
      );
      for (const { task, rows, envelope } of settled) addMapped(rows, task.level, envelope);
    }

    // Completeness proof: every fully-synced entity level must carry the same
    // total spend as the day-level ground truth over the same range.
    const daySpend = dayScan.rows.filter(isRecord).reduce((a, r) => a + n(r.spend), 0);
    const spendMismatch = entityLevels
      .filter((level) => Math.abs((spendByLevel[level] ?? 0) - daySpend) > 0.05)
      .map((level) => ({ level, level_spend: round2(spendByLevel[level] ?? 0), day_spend: round2(daySpend) }));

    // The day level is the source-of-truth total. Never write a partial entity
    // export: fact_facebook_stats is a ReplacingMergeTree, so even a failed sync
    // would otherwise make its newer row_version visible through FINAL.
    if (spendMismatch.length > 0) {
      throw new FacebookStatsValidationError({
        mode,
        date_from: dateFrom,
        date_to: dateTo,
        levels,
        strategy: "per_day_entity_fetch",
        active_days: activeDays.length,
        merged_rows_detected: mergedRowsDetected,
        spend_by_level: Object.fromEntries(Object.entries(spendByLevel).map(([key, value]) => [key, round2(value)])),
        day_spend_total: round2(daySpend),
        spend_mismatch: spendMismatch,
      });
    }

    // Validation gate passed → the batch is coherent (staged → validated).
    await history.markValidated(computeFbBatchChecksum(mapped));
    await v2.mirrorBatch("validated");

    if (mapped.length) {
      await input.clickhouse.insert({ table: FB, values: mapped as unknown as Record<string, unknown>[], format: "JSONEachRow" });
    }
    const after = await warehouseCount(input.clickhouse, input.authUserId);
    const inserted = Math.max(0, after - before);
    const updated = Math.max(0, mapped.length - inserted);
    const durationMs = Date.now() - started;

    // Warehouse write succeeded → the batch is live (validated → published),
    // and its automatic DQ report is stored alongside.
    const dqReport = computeFbBatchDq({ rows: mapped, activeDays, daySpendTotal: daySpend });
    await history.recordDq(dqReport);
    await history.markPublished();
    await v2.publish({
      rows: mapped,
      sourceVersion: fbStatsTo,
      dqChecks: buildFbV2DqChecks({
        dqReport: dqReport as unknown as Record<string, unknown>,
        mergedRowsDetected,
        spendMismatchCount: spendMismatch.length,
      }),
      mergedRowsDetected,
    });

    await upsertFbSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "completed",
      current_stage: "idle",
      stopped_reason: "completed",
      last_run_mode: lastRunMode,
      cursor_transaction_id: dateTo,
      cursor_updated_at: apiLastImportAt,
      rows_scanned: apiRows,
      rows_mapped: mapped.length,
      rows_inserted: inserted,
      rows_skipped: skipped,
      batches_processed: stats.requests,
      source_total: apiRows,
      clickhouse_total: after,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      last_error: null,
      diagnostics: {
        mode,
        date_from: dateFrom,
        date_to: dateTo,
        levels,
        fb_stats_to: fbStatsTo,
        api_last_import_at: apiLastImportAt,
        api_requests: stats.requests,
        api_latency_ms: stats.api_latency_ms,
        api_payload_bytes: stats.payload_bytes,
        range_splits: stats.splits,
        rows_updated: updated,
        warehouse_version: warehouseVersion,
        active_days: activeDays.length,
        strategy: "per_day_entity_fetch",
        merged_rows_detected: mergedRowsDetected,
        spend_by_level: Object.fromEntries(Object.entries(spendByLevel).map(([k, v]) => [k, round2(v)])),
        day_spend_total: round2(daySpend),
        spend_mismatch: spendMismatch,
      },
    });

    await history.recordRun({
      status: "completed",
      windowFrom: dateFrom,
      windowTo: dateTo,
      levels,
      apiRequests: stats.requests,
      rowsReceived: apiRows,
      rowsInserted: inserted,
      rowsUpdated: updated,
      rowsSkipped: skipped,
      durationMs: Date.now() - started,
      errorMessage: null,
      rawResponseMetadata: {
        api_payload_bytes: stats.payload_bytes,
        api_latency_ms: stats.api_latency_ms,
        range_splits: stats.splits,
        fb_stats_to: fbStatsTo,
        api_last_import_at: apiLastImportAt,
        merged_rows_detected: mergedRowsDetected,
        day_spend_total: round2(daySpend),
        active_days: activeDays.length,
        strategy: "per_day_entity_fetch",
      },
      finishedAtIso: new Date().toISOString(),
    });
    await v2.recordRequestTelemetry();

    return {
      status: "completed", mode, date_from: dateFrom, date_to: dateTo, levels,
      api_rows: apiRows, rows_inserted: inserted, rows_updated: updated, rows_skipped: skipped,
      warehouse_rows_before: before, warehouse_rows_after: after,
      warehouse_version: warehouseVersion, fb_stats_to: fbStatsTo, api_last_import_at: apiLastImportAt,
      api_requests: stats.requests, api_latency_ms: stats.api_latency_ms, api_payload_bytes: stats.payload_bytes,
      range_splits: stats.splits, duration_ms: Date.now() - started,
      history_run_id: history.runId, history_batch_id: history.batchId, history_errors: history.errors.length,
      v2_errors: v2.errors.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Facebook stats sync failed.";
    const validationError = error instanceof FacebookStatsValidationError ? error : null;
    await upsertFbSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "failed",
      current_stage: "failed",
      stopped_reason: "unknown",
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      last_error: message,
      ...(validationError ? {
        diagnostics: {
          ...validationError.validationDiagnostics,
          validation_status: "FAILED",
          error_code: validationError.code,
          error_message_safe: validationError.safeMessage,
        },
      } : {}),
    }).catch(() => undefined);

    // History: nothing was activated, so the staged batch rolls back (status
    // change only — its raw payloads stay for post-mortem), and the failed run
    // becomes a permanent record. Both calls are fail-safe.
    await history.markRolledBack(message);
    await history.recordRun({
      status: "failed",
      windowFrom: dateFrom,
      windowTo: dateTo,
      levels,
      apiRequests: stats.requests,
      rowsReceived: 0,
      rowsInserted: 0,
      rowsUpdated: 0,
      rowsSkipped: 0,
      durationMs: Date.now() - started,
      errorMessage: message,
      rawResponseMetadata: {
        api_payload_bytes: stats.payload_bytes,
        api_latency_ms: stats.api_latency_ms,
        range_splits: stats.splits,
        ...(validationError ? { error_code: validationError.code, validation_diagnostics: validationError.validationDiagnostics } : {}),
      },
      finishedAtIso: new Date().toISOString(),
    });
    // V2 mirror: raw evidence is kept (post-mortem), the batch mirror rolls back.
    await v2.abort();
    await v2.recordRequestTelemetry();
    throw error;
  }
}

// ---- Source probe (Warehouse V2 Phase 2) ------------------------------------

/** The campaign-metrics window proven missing by the 2026-07-19 data quality
 * audit: 0 rows across 38 days, unrecoverable from any internal storage. */
export const FB_KNOWN_GAP_WINDOW = { date_from: "2026-05-08", date_to: "2026-06-14" } as const;

export interface FbSourceProbeResult {
  date_from: string;
  date_to: string;
  expected_days: number;
  days_with_data: number;
  rows_found: number;
  spend_total: number;
  purchases_total: number;
  per_day: Array<{ date: string; spend: number; fb_purchases: number }>;
  fb_stats_to: string | null;
  api_last_import_at: string | null;
  api_requests: number;
  api_payload_bytes: number;
  api_latency_ms: number;
  verdict: "data_available" | "empty";
}

/** READ-ONLY probe: asks the source whether it can still serve a window, using
 * the same day-level scan the sync trusts as ground truth. Writes NOTHING — the
 * outcome drives a human decision: backfill (full sync with explicit dates) when
 * data comes back, or a facebook_known_gaps record with this result as evidence
 * when it does not. */
export async function runFacebookSourceProbe(input: {
  fetcher: CapsuledFetcher;
  dateFrom?: string | null;
  dateTo?: string | null;
}): Promise<FbSourceProbeResult> {
  const dateFrom = validDate(input.dateFrom, "date_from") ?? FB_KNOWN_GAP_WINDOW.date_from;
  const dateTo = validDate(input.dateTo, "date_to") ?? FB_KNOWN_GAP_WINDOW.date_to;
  if (dayDiff(dateFrom, dateTo) < 0) throw new FacebookStatsRequestError("date_from must be <= date_to.");

  const stats: CapsuledFetchStats = { requests: 0, payload_bytes: 0, api_latency_ms: 0, splits: 0, failed_attempts: [] };
  const scan = await fetchLevelRows({ fetcher: input.fetcher, level: "day", dateFrom, dateTo, stats });

  const perDay = scan.rows
    .filter(isRecord)
    .map((row) => ({ date: s(row.date || row.dateFrom).slice(0, 10), spend: round2(n(row.spend)), fb_purchases: n(row.fbPurchases) }))
    .filter((row) => DATE_RE.test(row.date) && row.date >= dateFrom && row.date <= dateTo)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    date_from: dateFrom,
    date_to: dateTo,
    expected_days: dayDiff(dateFrom, dateTo) + 1,
    days_with_data: new Set(perDay.map((row) => row.date)).size,
    rows_found: perDay.length,
    spend_total: round2(perDay.reduce((total, row) => total + row.spend, 0)),
    purchases_total: perDay.reduce((total, row) => total + row.fb_purchases, 0),
    per_day: perDay,
    fb_stats_to: s(scan.envelope.dataFreshness?.fbStatsTo) || null,
    api_last_import_at: s(scan.envelope.dataFreshness?.lastImportAt) || null,
    api_requests: stats.requests,
    api_payload_bytes: stats.payload_bytes,
    api_latency_ms: stats.api_latency_ms,
    verdict: perDay.length > 0 ? "data_available" : "empty",
  };
}

// ---- Read actions -----------------------------------------------------------

export interface FbReadFilters {
  date_from: string | null;
  date_to: string | null;
  buyer: string[];
  ad_account_id: string[];
  campaign_id: string[];
}

export interface FbReadRequest {
  action?: string;
  level?: string;
  filters?: Partial<FbReadFilters>;
  sort?: { field?: string; direction?: string };
  limit?: number;
}

export function normalizeFbFilters(req: FbReadRequest): FbReadFilters {
  const f = req.filters ?? {};
  return {
    date_from: validDate(f.date_from, "date_from"),
    date_to: validDate(f.date_to, "date_to"),
    buyer: stringArray(f.buyer, "buyer"),
    ad_account_id: stringArray(f.ad_account_id, "ad_account_id"),
    campaign_id: stringArray(f.campaign_id, "campaign_id"),
  };
}

function inClause(column: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const ph = values.map((v, i) => {
    const key = `p_${prefix}_${i}`;
    params[key] = v;
    return `{${key}:String}`;
  });
  return ` AND ${column} IN (${ph.join(", ")})`;
}

/** Shared WHERE for a level-scoped, filtered scan. Binds params. `prefix` qualifies columns when the scan is joined. */
export function fbScopeWhere(input: {
  level: FbLevel;
  filters: FbReadFilters;
  params: Record<string, unknown>;
  prefix?: string;
}): string {
  const { filters, params } = input;
  const p = input.prefix ?? "";
  params.level = input.level;
  let where = `${p}auth_user_id = {auth_user_id:String} AND ${p}level = {level:String}`;
  if (filters.date_from) { params.date_from = filters.date_from; where += ` AND ${p}stat_date >= {date_from:String}`; }
  if (filters.date_to) { params.date_to = filters.date_to; where += ` AND ${p}stat_date <= {date_to:String}`; }
  where += inClause(`${p}buyer`, filters.buyer, "buyer", params);
  where += inClause(`${p}ad_account_id`, filters.ad_account_id, "acct", params);
  where += inClause(`${p}campaign_id`, filters.campaign_id, "camp", params);
  return where;
}

// Aggregate metric select shared by summary/list/charts: additive sums plus
// derived metrics recomputed FROM THE SUMS (never averaged from per-row rates).
const METRIC_SUMS = `
  sum(spend) spend,
  sum(impressions) impressions,
  sum(clicks) clicks,
  sum(outbound_clicks) outbound_clicks,
  sum(fb_purchases) fb_purchases,
  sum(purchase_value) purchase_value,
  sum(reach) reach,
  sum(link_clicks) link_clicks`;

export interface FbMetricTotals {
  spend: number; impressions: number; clicks: number; outbound_clicks: number;
  fb_purchases: number; purchase_value: number; reach: number; link_clicks: number;
  cpp: number | null; cpc: number | null; cpm: number | null;
  ctr: number | null; outbound_ctr: number | null; roas: number | null;
}

export function deriveMetricTotals(row: Record<string, unknown>): FbMetricTotals {
  const spend = n(row.spend);
  const impressions = n(row.impressions);
  const clicks = n(row.clicks);
  const outbound = n(row.outbound_clicks);
  const purchases = n(row.fb_purchases);
  const purchaseValue = n(row.purchase_value);
  return {
    spend: round2(spend),
    impressions,
    clicks,
    outbound_clicks: outbound,
    fb_purchases: purchases,
    purchase_value: round2(purchaseValue),
    reach: n(row.reach),
    link_clicks: n(row.link_clicks),
    cpp: purchases > 0 ? round2(spend / purchases) : null,
    cpc: clicks > 0 ? round2(spend / clicks) : null,
    cpm: impressions > 0 ? round2((spend / impressions) * 1000) : null,
    ctr: impressions > 0 ? round2((clicks / impressions) * 100) : null,
    outbound_ctr: impressions > 0 ? round2((outbound / impressions) * 100) : null,
    roas: spend > 0 && purchaseValue > 0 ? round2(purchaseValue / spend) : null,
  };
}

// Subengine metrics joined to FB stats BY CAMPAIGN_ID (the only join key both
// sources share — analytics_transactions carries no adset/ad ids). Present only
// on campaign-level rows; every value is computed server-side in ClickHouse.
export interface FbBlendedMetrics {
  trial_users: number;
  tx_gross_revenue: number;
  tx_net_revenue: number;
  cac: number | null;
  roas: number | null;
  revenue_per_trial: number | null;
}

export interface FbListRow extends FbMetricTotals {
  key: string;
  ad_account_id: string;
  ad_account_name: string;
  buyer: string;
  campaign_id: string;
  campaign_name: string;
  adset_id: string;
  adset_name: string;
  ad_id: string;
  ad_name: string;
  first_date: string;
  last_date: string;
  days: number;
  /** campaign_id-joined Subengine metrics (campaign level only). */
  blended?: FbBlendedMetrics;
}

const LEVEL_KEYS: Record<FbLevel, string[]> = {
  account: ["ad_account_id"],
  campaign: ["ad_account_id", "campaign_id"],
  adset: ["ad_account_id", "campaign_id", "adset_id"],
  ad: ["ad_account_id", "campaign_id", "adset_id", "ad_id"],
  day: ["stat_date"],
};

const SORTABLE = new Set(["spend", "impressions", "clicks", "outbound_clicks", "fb_purchases", "cpp", "cpc", "cpm", "ctr", "outbound_ctr", "last_date"]);

// Per-campaign Subengine aggregate over the SAME date window as the FB scan
// (transaction_date vs stat_date), joined by campaign_id. Simple warehouse flags
// only (is_trial / is_success / amounts) — no cohort formulas are reproduced here.
function txByCampaignCTE(filters: FbReadFilters, params: Record<string, unknown>): string {
  let where = `auth_user_id = {auth_user_id:String} AND campaign_id != ''`;
  if (filters.date_from) { params.tx_date_from = filters.date_from; where += ` AND transaction_date >= {tx_date_from:String}`; }
  if (filters.date_to) { params.tx_date_to = filters.date_to; where += ` AND transaction_date <= {tx_date_to:String}`; }
  return `
    SELECT campaign_id,
      uniqExactIf(user_id, is_trial = 1 AND is_success = 1) trial_users,
      sumIf(gross_amount_usd, is_success = 1) tx_gross,
      sum(refund_amount_usd) tx_refunds
    FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
    WHERE ${where}
    GROUP BY campaign_id`;
}

function blendedFromRow(r: Record<string, unknown>, spend: number): FbBlendedMetrics {
  const trials = n(r.trial_users);
  const gross = n(r.tx_gross);
  const net = gross - n(r.tx_refunds);
  return {
    trial_users: trials,
    tx_gross_revenue: round2(gross),
    tx_net_revenue: round2(net),
    cac: trials > 0 && spend > 0 ? round2(spend / trials) : null,
    roas: spend > 0 ? round2(net / spend) : null,
    revenue_per_trial: trials > 0 ? round2(net / trials) : null,
  };
}

export async function runFbList(client: ClickHouseClientLike, authUserId: string, req: FbReadRequest): Promise<{ rows: FbListRow[]; level: FbLevel }> {
  const level = normalizeFbLevel(req.level);
  const filters = normalizeFbFilters(req);
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  const keys = LEVEL_KEYS[level];
  const limit = Math.max(1, Math.min(5000, Math.floor(n(req.limit) || 1000)));
  // Blended Subengine metrics are joined BY CAMPAIGN_ID on the campaign level
  // only — transactions carry no adset/ad ids, and repeating campaign totals on
  // deeper levels would double-count.
  const blend = level === "campaign";
  const prefix = blend ? "fb." : "";
  const where = fbScopeWhere({ level, filters, params, prefix });
  const groupBy = keys.map((k) => `${prefix}${k}`).join(", ");
  const selectKeys = keys.map((k) => `${prefix}${k} AS ${k}`).join(", ");
  const blendJoin = blend ? `LEFT JOIN (${txByCampaignCTE(filters, params)}) AS tx ON tx.campaign_id = fb.campaign_id` : "";
  const blendCols = blend ? `, any(tx.trial_users) trial_users, any(tx.tx_gross) tx_gross, any(tx.tx_refunds) tx_refunds` : "";
  const sql = `
    SELECT ${selectKeys},
      argMax(ad_account_name, stat_date) ad_account_name,
      argMax(buyer, stat_date) buyer,
      argMax(campaign_name, stat_date) campaign_name,
      argMax(adset_name, stat_date) adset_name,
      argMax(ad_name, stat_date) ad_name,
      toString(min(stat_date)) first_date,
      toString(max(stat_date)) last_date,
      uniqExact(stat_date) days,
      ${METRIC_SUMS}${blendCols}
    FROM ${FB} AS fb FINAL
    ${blendJoin}
    WHERE ${where}
    GROUP BY ${groupBy}
    ORDER BY spend DESC
    LIMIT ${limit}
    FORMAT JSONEachRow`;
  const raw = await jsonRows<Record<string, unknown>>(client, sql, params);
  const rows = raw.map((r) => {
    const totals = deriveMetricTotals(r);
    return {
      key: keys.map((k) => s(r[k])).join("|"),
      ad_account_id: s(r.ad_account_id),
      ad_account_name: s(r.ad_account_name),
      buyer: s(r.buyer),
      campaign_id: s(r.campaign_id),
      campaign_name: s(r.campaign_name),
      adset_id: s(r.adset_id),
      adset_name: s(r.adset_name),
      ad_id: s(r.ad_id),
      ad_name: s(r.ad_name),
      first_date: s(r.first_date) || s(r.stat_date),
      last_date: s(r.last_date) || s(r.stat_date),
      days: n(r.days),
      ...totals,
      ...(blend ? { blended: blendedFromRow(r, totals.spend) } : {}),
    };
  });
  const sortField = SORTABLE.has(s(req.sort?.field)) ? s(req.sort?.field) : "spend";
  const dir = req.sort?.direction === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const av = (a as unknown as Record<string, number | string | null>)[sortField];
    const bv = (b as unknown as Record<string, number | string | null>)[sortField];
    const an = av == null ? -Infinity : typeof av === "string" ? av : Number(av);
    const bn = bv == null ? -Infinity : typeof bv === "string" ? bv : Number(bv);
    return an < bn ? -dir : an > bn ? dir : 0;
  });
  return { rows, level };
}

export interface FbChartPoint extends FbMetricTotals { date: string; }

export async function runFbCharts(client: ClickHouseClientLike, authUserId: string, req: FbReadRequest): Promise<FbChartPoint[]> {
  // Daily series aggregate the CAMPAIGN level (finest level that is complete and
  // compact); the API's own `day` level carries no filterable dimensions.
  const level = req.filters?.buyer?.length || req.filters?.ad_account_id?.length || req.filters?.campaign_id?.length
    ? "campaign"
    : normalizeFbLevel(req.level, "campaign");
  const filters = normalizeFbFilters(req);
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  const where = fbScopeWhere({ level, filters, params });
  const sql = `
    SELECT toString(stat_date) date, ${METRIC_SUMS}
    FROM ${FB} FINAL
    WHERE ${where}
    GROUP BY stat_date
    ORDER BY stat_date
    FORMAT JSONEachRow`;
  const raw = await jsonRows<Record<string, unknown>>(client, sql, params);
  return raw.map((r) => ({ date: s(r.date), ...deriveMetricTotals(r) }));
}

export interface FbFilterOptions {
  buyers: Array<{ value: string; spend: number; rows: number }>;
  accounts: Array<{ value: string; label: string; spend: number; rows: number }>;
  campaigns: Array<{ value: string; label: string; spend: number; rows: number }>;
  date_min: string | null;
  date_max: string | null;
}

export async function runFbFilterOptions(client: ClickHouseClientLike, authUserId: string, req: FbReadRequest): Promise<FbFilterOptions> {
  const filters = normalizeFbFilters(req);
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  // Options come from the campaign level (has every dimension); each dimension's
  // list is scoped by the OTHER dimensions plus the date range (cascading).
  const base = (exclude: "buyer" | "acct" | "camp" | null) => {
    const p: Record<string, unknown> = { auth_user_id: authUserId };
    const scoped: FbReadFilters = {
      ...filters,
      buyer: exclude === "buyer" ? [] : filters.buyer,
      ad_account_id: exclude === "acct" ? [] : filters.ad_account_id,
      campaign_id: exclude === "camp" ? [] : filters.campaign_id,
    };
    return { where: fbScopeWhere({ level: "campaign", filters: scoped, params: p }), params: p };
  };
  const buyerQ = base("buyer");
  const acctQ = base("acct");
  const campQ = base("camp");
  const [buyers, accounts, campaigns, range] = await Promise.all([
    jsonRows<Record<string, unknown>>(client, `SELECT buyer value, sum(spend) spend, count() rows FROM ${FB} FINAL WHERE ${buyerQ.where} AND buyer != '' GROUP BY buyer ORDER BY spend DESC FORMAT JSONEachRow`, buyerQ.params),
    jsonRows<Record<string, unknown>>(client, `SELECT ad_account_id value, argMax(ad_account_name, stat_date) label, sum(spend) spend, count() rows FROM ${FB} FINAL WHERE ${acctQ.where} AND ad_account_id != '' GROUP BY ad_account_id ORDER BY spend DESC FORMAT JSONEachRow`, acctQ.params),
    jsonRows<Record<string, unknown>>(client, `SELECT campaign_id value, argMax(campaign_name, stat_date) label, sum(spend) spend, count() rows FROM ${FB} FINAL WHERE ${campQ.where} AND campaign_id != '' GROUP BY campaign_id ORDER BY spend DESC FORMAT JSONEachRow`, campQ.params),
    jsonRows<Record<string, unknown>>(client, `SELECT toString(min(stat_date)) date_min, toString(max(stat_date)) date_max FROM ${FB} FINAL WHERE auth_user_id = {auth_user_id:String}`, { auth_user_id: authUserId }),
  ]);
  return {
    buyers: buyers.map((r) => ({ value: s(r.value), spend: round2(n(r.spend)), rows: n(r.rows) })),
    accounts: accounts.map((r) => ({ value: s(r.value), label: s(r.label) || s(r.value), spend: round2(n(r.spend)), rows: n(r.rows) })),
    campaigns: campaigns.map((r) => ({ value: s(r.value), label: s(r.label) || s(r.value), spend: round2(n(r.spend)), rows: n(r.rows) })),
    date_min: dateOrNull(range[0]?.date_min),
    date_max: dateOrNull(range[0]?.date_max),
  };
}

// ---- Diagnostics (one warehouse state per response) ---------------------------

export interface FbCampaignMappingDiagnostics {
  join_key: "campaign_id";
  fb_campaigns: number;
  tx_campaigns: number;
  matched_campaigns: number;
  fb_only_campaigns: number;
  tx_only_campaigns: number;
}

export interface FbDiagnostics {
  engine: "clickhouse";
  warehouse_rows: number;
  warehouse_rows_in_scope: number;
  date_min: string | null;
  date_max: string | null;
  last_sync_status: string | null;
  last_sync_finished_at: string | null;
  last_sync_duration_ms: number | null;
  last_sync_mode: string | null;
  api_fb_stats_to: string | null;
  api_last_import_at: string | null;
  warehouse_version: string;
  report_complete: boolean;
  filters_applied: { date_range: boolean; buyer: boolean; ad_account_id: boolean; campaign_id: boolean };
  /** FB↔Subengine join coverage in the report window (join key: campaign_id). */
  mapping?: FbCampaignMappingDiagnostics;
}

export function fbWarehouseVersionFromState(state: Record<string, unknown> | null, warehouseRows: number): string {
  const src = [
    s(state?.cursor_transaction_id),
    s(state?.cursor_updated_at),
    s(state?.finished_at),
    String(warehouseRows),
  ].join(":");
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fbwh_${(h >>> 0).toString(36)}`;
}

export async function buildFbDiagnostics(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  level: FbLevel;
  filters: FbReadFilters;
  today?: string;
}): Promise<FbDiagnostics> {
  const params: Record<string, unknown> = { auth_user_id: input.authUserId };
  const where = fbScopeWhere({ level: input.level, filters: input.filters, params });
  const [state, totals, scoped] = await Promise.all([
    getFbSyncState(input.supabase, input.authUserId).catch(() => null),
    jsonRows<Record<string, unknown>>(
      input.clickhouse,
      `SELECT count() c, toString(min(stat_date)) date_min, toString(max(stat_date)) date_max FROM ${FB} FINAL WHERE auth_user_id = {auth_user_id:String}`,
      { auth_user_id: input.authUserId },
    ),
    jsonRows<Record<string, unknown>>(input.clickhouse, `SELECT count() c FROM ${FB} FINAL WHERE ${where}`, params),
  ]);
  const warehouseRows = n(totals[0]?.c);
  const diagnostics = isRecord(state?.diagnostics) ? (state?.diagnostics as Record<string, unknown>) : {};
  const fbStatsTo = s(diagnostics.fb_stats_to) || null;
  const today = input.today ?? utcDayKey(new Date());
  const yesterday = addDays(today, -1);
  // Complete = a successful sync exists AND its API freshness covers yesterday
  // AND the warehouse actually contains rows through that freshness date.
  const dateMax = dateOrNull(totals[0]?.date_max);
  const reportComplete = Boolean(
    state && s(state.status) === "completed" && warehouseRows > 0 &&
    fbStatsTo && fbStatsTo >= yesterday && dateMax && dateMax >= yesterday,
  );
  return {
    engine: "clickhouse",
    warehouse_rows: warehouseRows,
    warehouse_rows_in_scope: n(scoped[0]?.c),
    date_min: dateOrNull(totals[0]?.date_min),
    date_max: dateMax,
    last_sync_status: state ? s(state.status) || null : null,
    last_sync_finished_at: state ? s(state.finished_at) || null : null,
    last_sync_duration_ms: state?.duration_ms == null ? null : n(state.duration_ms),
    // diagnostics.mode carries the honest FB mode ("incremental"/"full");
    // last_run_mode is constrained to the transaction-backfill vocabulary.
    last_sync_mode: s(diagnostics.mode) || (state ? s(state.last_run_mode) || null : null),
    api_fb_stats_to: fbStatsTo,
    api_last_import_at: state ? s(state.cursor_updated_at) || null : null,
    warehouse_version: fbWarehouseVersionFromState(state, warehouseRows),
    report_complete: reportComplete,
    filters_applied: {
      date_range: Boolean(input.filters.date_from || input.filters.date_to),
      buyer: input.filters.buyer.length > 0,
      ad_account_id: input.filters.ad_account_id.length > 0,
      campaign_id: input.filters.campaign_id.length > 0,
    },
  };
}

// ---- Composite report (atomic bundle for the page) ----------------------------

export interface FbReportResponse {
  ok: true;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  level: FbLevel;
  summary: FbMetricTotals & { accounts: number; campaigns: number; active_days: number; blended: FbBlendedMetrics };
  rows: FbListRow[];
  charts: FbChartPoint[];
  filter_options: FbFilterOptions;
  diagnostics: FbDiagnostics;
}

// Mapping coverage + blended totals over the report window, joined by
// campaign_id. Blended totals count ONLY campaigns present in the FB scope, so
// ROAS/CAC never mix in revenue from campaigns the FB report cannot see.
async function runFbMappingSummary(
  client: ClickHouseClientLike,
  authUserId: string,
  filters: FbReadFilters,
): Promise<{ mapping: FbCampaignMappingDiagnostics; blended: FbBlendedMetrics }> {
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  const fbWhere = fbScopeWhere({ level: "campaign", filters, params });
  let txWhere = `auth_user_id = {auth_user_id:String} AND campaign_id != ''`;
  if (filters.date_from) { params.tx_date_from = filters.date_from; txWhere += ` AND transaction_date >= {tx_date_from:String}`; }
  if (filters.date_to) { params.tx_date_to = filters.date_to; txWhere += ` AND transaction_date <= {tx_date_to:String}`; }
  const sql = `WITH
    fbc AS (SELECT DISTINCT campaign_id FROM ${FB} FINAL WHERE ${fbWhere} AND campaign_id != ''),
    txc AS (SELECT DISTINCT campaign_id FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE ${txWhere})
  SELECT
    (SELECT count() FROM fbc) fb_campaigns,
    (SELECT count() FROM txc) tx_campaigns,
    (SELECT count() FROM fbc WHERE campaign_id IN (SELECT campaign_id FROM txc)) matched_campaigns,
    (SELECT uniqExactIf(user_id, is_trial = 1 AND is_success = 1) FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE ${txWhere} AND campaign_id IN (SELECT campaign_id FROM fbc)) trial_users,
    (SELECT sumIf(gross_amount_usd, is_success = 1) FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE ${txWhere} AND campaign_id IN (SELECT campaign_id FROM fbc)) tx_gross,
    (SELECT sum(refund_amount_usd) FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE ${txWhere} AND campaign_id IN (SELECT campaign_id FROM fbc)) tx_refunds
  FORMAT JSONEachRow`;
  const [row] = await jsonRows<Record<string, unknown>>(client, sql, params);
  const fbCampaigns = n(row?.fb_campaigns);
  const txCampaigns = n(row?.tx_campaigns);
  const matched = n(row?.matched_campaigns);
  return {
    mapping: {
      join_key: "campaign_id",
      fb_campaigns: fbCampaigns,
      tx_campaigns: txCampaigns,
      matched_campaigns: matched,
      fb_only_campaigns: Math.max(0, fbCampaigns - matched),
      tx_only_campaigns: Math.max(0, txCampaigns - matched),
    },
    blended: blendedFromRow(row ?? {}, 0),
  };
}

export async function runFbReport(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  request: FbReadRequest;
}): Promise<FbReportResponse> {
  const started = Date.now();
  const level = normalizeFbLevel(input.request.level);
  const filters = normalizeFbFilters(input.request);
  const params: Record<string, unknown> = { auth_user_id: input.authUserId };
  const where = fbScopeWhere({ level: "campaign", filters, params });
  const [list, charts, options, summaryRows, diagnostics, mappingSummary] = await Promise.all([
    runFbList(input.clickhouse, input.authUserId, input.request),
    runFbCharts(input.clickhouse, input.authUserId, input.request),
    runFbFilterOptions(input.clickhouse, input.authUserId, input.request),
    jsonRows<Record<string, unknown>>(
      input.clickhouse,
      `SELECT ${METRIC_SUMS}, uniqExact(ad_account_id) accounts, uniqExact(campaign_id) campaigns, uniqExact(stat_date) active_days
       FROM ${FB} FINAL WHERE ${where} FORMAT JSONEachRow`,
      params,
    ),
    buildFbDiagnostics({ clickhouse: input.clickhouse, supabase: input.supabase, authUserId: input.authUserId, level, filters }),
    runFbMappingSummary(input.clickhouse, input.authUserId, filters).catch(() => null),
  ]);
  const sr = summaryRows[0] ?? {};
  const totals = deriveMetricTotals(sr);
  // Blended totals derive CAC/ROAS from the report's own spend total.
  const blendedTotals: FbBlendedMetrics = mappingSummary
    ? {
        ...mappingSummary.blended,
        cac: mappingSummary.blended.trial_users > 0 && totals.spend > 0 ? Math.round((totals.spend / mappingSummary.blended.trial_users) * 100) / 100 : null,
        roas: totals.spend > 0 ? Math.round((mappingSummary.blended.tx_net_revenue / totals.spend) * 100) / 100 : null,
      }
    : { trial_users: 0, tx_gross_revenue: 0, tx_net_revenue: 0, cac: null, roas: null, revenue_per_trial: null };
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    level,
    summary: { ...totals, accounts: n(sr.accounts), campaigns: n(sr.campaigns), active_days: n(sr.active_days), blended: blendedTotals },
    rows: list.rows,
    charts,
    filter_options: options,
    diagnostics: mappingSummary ? { ...diagnostics, mapping: mappingSummary.mapping } : diagnostics,
  };
}
