// Facebook Warehouse V2 — Phase 1: append-only import history recorder.
//
// Observability SIDECAR for runFacebookStatsSync. It records what the existing
// pipeline did (runs, batches, verbatim raw payloads, per-batch DQ) into the
// facebook_* history tables and NEVER influences pipeline behaviour:
// - every write is fail-safe: errors are collected in `recorder.errors`,
//   never thrown, so the production sync works identically if this layer is
//   missing, misconfigured or down;
// - facebook_sync_runs / facebook_raw_payloads / facebook_batch_dq are strictly
//   INSERT-only; facebook_import_batches is INSERT plus status-machine UPDATEs
//   (staged → validated → published | rolled_back). No DELETE exists anywhere
//   in this module by construction (and DB triggers reject it anyway).
//
// Nothing here is read by Cohorts, allocation, reconciliation or mapping.

import type { SupabaseLikeClient, SupabaseQueryResult } from "./types.ts";
import type { CapsuledEnvelope, CapsuledFetcher, FbLevel, FbWarehouseRow } from "./facebookStats.ts";

export const FB_SYNC_RUNS_TABLE = "facebook_sync_runs";
export const FB_IMPORT_BATCHES_TABLE = "facebook_import_batches";
export const FB_RAW_PAYLOADS_TABLE = "facebook_raw_payloads";
export const FB_BATCH_DQ_TABLE = "facebook_batch_dq";

/** Raw payload rows are buffered and bulk-inserted to keep API fetch latency flat. */
export const FB_RAW_FLUSH_ROWS = 25;
export const FB_RAW_FLUSH_BYTES = 1_500_000;

export type FbSyncTrigger = "manual" | "cron" | "backfill" | "migration";
export type FbBatchStatus = "staged" | "validated" | "published" | "rolled_back";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function randomUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Non-crypto fallback (test environments only): RFC4122-shaped v4.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    return (ch === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---- Batch checksum + DQ (pure, unit-testable) --------------------------------

type FbDqRow = Pick<
  FbWarehouseRow,
  "level" | "stat_date" | "ad_account_id" | "campaign_id" | "adset_id" | "ad_id" | "spend" | "fb_purchases"
>;

function businessKey(row: FbDqRow): string {
  return [row.level, row.stat_date, row.ad_account_id, row.campaign_id, row.adset_id, row.ad_id].join("|");
}

/**
 * Deterministic, order-insensitive fingerprint of a batch's warehouse rows
 * (business key + additive metrics). FNV-1a over sorted lines — enough to
 * detect "same import key, different numbers" between two imports.
 */
export function computeFbBatchChecksum(rows: readonly FbDqRow[]): string {
  const lines = rows
    .map((r) => `${businessKey(r)}|${r.spend}|${r.fb_purchases}`)
    .sort();
  let h = 0x811c9dc5;
  for (const line of lines) {
    for (let i = 0; i < line.length; i += 1) {
      h ^= line.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x0a;
    h = Math.imul(h, 0x01000193);
  }
  return `fbck_${(h >>> 0).toString(36)}_${rows.length}`;
}

export interface FbBatchDqReport {
  campaign_count: number;
  account_count: number;
  expected_days: number;
  covered_days: number;
  coverage_pct: number | null;
  duplicate_keys: number;
  duplicate_key_samples: string[];
  missing_dates: string[];
  spend_total: number;
  purchases_total: number;
  spend_by_level: Record<string, number>;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * Automatic per-batch DQ (spec §8): campaign/account counts, date coverage vs
 * the day-level active-day scan, duplicate business keys, spend/purchases
 * totals. Pure function over the rows the sync already holds in memory.
 */
export function computeFbBatchDq(input: {
  rows: readonly FbDqRow[];
  /** Active dates discovered by the day-level scan (the coverage denominator). */
  activeDays: readonly string[];
  /** Day-level ground-truth spend total (validation gate input). */
  daySpendTotal: number;
}): FbBatchDqReport {
  const campaigns = new Set<string>();
  const accounts = new Set<string>();
  const seen = new Map<string, number>();
  const spendByLevel: Record<string, number> = {};
  const coverageLevel = input.rows.some((r) => r.level === "campaign") ? "campaign" : "day";
  const coveredDates = new Set<string>();
  let purchasesDay = 0;
  let purchasesCoverage = 0;
  let hasDayLevel = false;

  for (const row of input.rows) {
    if (row.level === "campaign" && row.campaign_id) campaigns.add(row.campaign_id);
    if (row.level !== "day" && row.ad_account_id) accounts.add(row.ad_account_id);
    spendByLevel[row.level] = round2((spendByLevel[row.level] ?? 0) + row.spend);
    const key = businessKey(row);
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (row.level === coverageLevel) {
      coveredDates.add(row.stat_date);
      purchasesCoverage += row.fb_purchases;
    }
    if (row.level === "day") {
      hasDayLevel = true;
      purchasesDay += row.fb_purchases;
    }
  }

  const duplicates = Array.from(seen.entries()).filter(([, count]) => count > 1);
  const activeDaySet = new Set(input.activeDays);
  const covered = Array.from(coveredDates).filter((d) => activeDaySet.has(d));
  const missing = input.activeDays.filter((d) => !coveredDates.has(d));

  return {
    campaign_count: campaigns.size,
    account_count: accounts.size,
    expected_days: input.activeDays.length,
    covered_days: covered.length,
    coverage_pct: input.activeDays.length
      ? round2((covered.length / input.activeDays.length) * 100)
      : null,
    duplicate_keys: duplicates.length,
    duplicate_key_samples: duplicates.slice(0, 10).map(([key]) => key),
    missing_dates: missing.slice(0, 100),
    spend_total: round2(input.daySpendTotal),
    purchases_total: hasDayLevel ? purchasesDay : purchasesCoverage,
    spend_by_level: spendByLevel,
  };
}

// ---- Recorder -----------------------------------------------------------------

export interface FbRunSummary {
  status: "completed" | "failed";
  windowFrom: string | null;
  windowTo: string | null;
  levels: readonly string[];
  apiRequests: number;
  rowsReceived: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsSkipped: number;
  durationMs: number;
  errorMessage: string | null;
  rawResponseMetadata: Record<string, unknown>;
  finishedAtIso: string;
}

export interface FbSyncHistoryRecorder {
  readonly runId: string;
  readonly batchId: string;
  /** History-layer failures (never thrown — the sync must not notice them). */
  readonly errors: string[];
  /** Insert the staged batch row. Call once, at sync start. */
  stageBatch(): Promise<void>;
  /** Wrap the Capsuled fetcher so every API response (and failure) is recorded verbatim. */
  wrapFetcher(fetcher: CapsuledFetcher): CapsuledFetcher;
  /** staged → validated (validation gate passed). Write-once checksum. */
  markValidated(checksum: string): Promise<void>;
  /** validated → published (warehouse insert succeeded). */
  markPublished(): Promise<void>;
  /** any → rolled_back (validation/fetch/insert failed; data stays, status changes). */
  markRolledBack(reason: string): Promise<void>;
  /** Insert the per-batch DQ report. */
  recordDq(report: FbBatchDqReport): Promise<void>;
  /** Flush remaining raw payloads and insert the immutable run row. Call last. */
  recordRun(summary: FbRunSummary): Promise<void>;
}

interface RawBufferEntry {
  batch_id: string;
  auth_user_id: string;
  entity_level: FbLevel;
  page: number;
  request_date_from: string;
  request_date_to: string;
  http_ok: boolean;
  payload_json: unknown;
  payload_bytes: number;
  api_latency_ms: number;
  received_at: string;
}

/**
 * Creates the append-only history recorder for one sync run. All UUIDs are
 * generated up front so lineage (run ↔ batch ↔ payloads ↔ dq) is consistent
 * even though the run row itself is only written at the very end.
 */
export function createFbSyncHistoryRecorder(input: {
  supabase: SupabaseLikeClient;
  authUserId: string;
  warehouseVersion: string;
  mode: "incremental" | "full";
  trigger?: FbSyncTrigger;
  startedAtIso: string;
  source?: string;
}): FbSyncHistoryRecorder {
  const runId = randomUuid();
  const batchId = randomUuid();
  const errors: string[] = [];
  const rawBuffer: RawBufferEntry[] = [];
  const pageByLevel: Partial<Record<FbLevel, number>> = {};
  let rawBufferBytes = 0;
  let batchStaged = false;
  let batchStatus: FbBatchStatus = "staged";
  let apiFailures = 0;

  // Every history write goes through `safe`: sync behaviour must be identical
  // whether these tables exist or not, so nothing may ever throw past here.
  async function safe(label: string, op: () => PromiseLike<SupabaseQueryResult | void> | SupabaseQueryResult | void): Promise<boolean> {
    try {
      const result = await op();
      const error = (result as SupabaseQueryResult | undefined)?.error;
      if (error) {
        errors.push(`${label}: ${error.message}`);
        return false;
      }
      return true;
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  function insertRows(table: string, rows: Record<string, unknown>[] | Record<string, unknown>): PromiseLike<SupabaseQueryResult> {
    const builder = input.supabase.from(table) as unknown as {
      insert?: (values: unknown) => PromiseLike<SupabaseQueryResult>;
    };
    if (typeof builder.insert !== "function") throw new Error(`supabase client has no insert() for ${table}`);
    return builder.insert(rows);
  }

  function updateBatch(patch: Record<string, unknown>): PromiseLike<SupabaseQueryResult> {
    const builder = input.supabase.from(FB_IMPORT_BATCHES_TABLE) as unknown as {
      update?: (values: unknown) => {
        eq: (col: string, v: unknown) => { eq: (col: string, v: unknown) => PromiseLike<SupabaseQueryResult> };
      };
    };
    if (typeof builder.update !== "function") throw new Error("supabase client has no update() for facebook_import_batches");
    return builder.update(patch).eq("batch_id", batchId).eq("auth_user_id", input.authUserId);
  }

  async function flushRaw(): Promise<void> {
    if (!rawBuffer.length) return;
    const chunk = rawBuffer.splice(0, rawBuffer.length);
    rawBufferBytes = 0;
    await safe("raw_payloads insert", () => insertRows(FB_RAW_PAYLOADS_TABLE, chunk));
  }

  async function transition(next: FbBatchStatus, patch: Record<string, unknown>): Promise<void> {
    if (!batchStaged) return; // Batch row never landed — nothing to transition.
    const legal =
      (batchStatus === "staged" && (next === "validated" || next === "rolled_back")) ||
      (batchStatus === "validated" && (next === "published" || next === "rolled_back")) ||
      (batchStatus === "published" && next === "rolled_back");
    if (!legal) {
      errors.push(`batch transition rejected: ${batchStatus} -> ${next}`);
      return;
    }
    const ok = await safe(`batch ${next}`, () => updateBatch({ status: next, ...patch }));
    if (ok) batchStatus = next;
  }

  return {
    runId,
    batchId,
    errors,

    async stageBatch(): Promise<void> {
      const ok = await safe("batch insert", () =>
        insertRows(FB_IMPORT_BATCHES_TABLE, {
          batch_id: batchId,
          run_id: runId,
          auth_user_id: input.authUserId,
          status: "staged",
          source: input.source ?? "capsuled_fb_stats",
          version: input.warehouseVersion,
        }));
      batchStaged = ok;
    },

    wrapFetcher(fetcher: CapsuledFetcher): CapsuledFetcher {
      return async (dateFrom, dateTo, level) => {
        const receivedAt = new Date().toISOString();
        let envelope: CapsuledEnvelope | null = null;
        let bytes = 0;
        let latencyMs = 0;
        let failure: string | null = null;
        try {
          const result = await fetcher(dateFrom, dateTo, level);
          envelope = result.envelope;
          bytes = result.bytes;
          latencyMs = result.latencyMs;
          return result;
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
          apiFailures += 1;
          throw e;
        } finally {
          try {
            const page = (pageByLevel[level] = (pageByLevel[level] ?? 0) + 1);
            rawBuffer.push({
              batch_id: batchId,
              auth_user_id: input.authUserId,
              entity_level: level,
              page,
              request_date_from: dateFrom,
              request_date_to: dateTo,
              http_ok: failure == null,
              payload_json: failure == null ? envelope : { error: failure },
              payload_bytes: bytes,
              api_latency_ms: latencyMs,
              received_at: receivedAt,
            });
            rawBufferBytes += bytes;
            if (rawBuffer.length >= FB_RAW_FLUSH_ROWS || rawBufferBytes >= FB_RAW_FLUSH_BYTES) {
              await flushRaw();
            }
          } catch (e) {
            errors.push(`raw payload buffer: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      };
    },

    async markValidated(checksum: string): Promise<void> {
      await transition("validated", { validated_at: new Date().toISOString(), checksum });
    },

    async markPublished(): Promise<void> {
      await transition("published", { published_at: new Date().toISOString() });
    },

    async markRolledBack(reason: string): Promise<void> {
      await transition("rolled_back", {
        rolled_back_at: new Date().toISOString(),
        notes: reason.slice(0, 2000),
      });
    },

    async recordDq(report: FbBatchDqReport): Promise<void> {
      await safe("batch dq insert", () =>
        insertRows(FB_BATCH_DQ_TABLE, {
          batch_id: batchId,
          run_id: runId,
          auth_user_id: input.authUserId,
          campaign_count: report.campaign_count,
          account_count: report.account_count,
          expected_days: report.expected_days,
          covered_days: report.covered_days,
          coverage_pct: report.coverage_pct,
          duplicate_keys: report.duplicate_keys,
          duplicate_key_samples: report.duplicate_key_samples,
          missing_dates: report.missing_dates,
          spend_total: report.spend_total,
          purchases_total: report.purchases_total,
          spend_by_level: report.spend_by_level,
        }));
    },

    async recordRun(summary: FbRunSummary): Promise<void> {
      await flushRaw();
      await safe("sync run insert", () =>
        insertRows(FB_SYNC_RUNS_TABLE, {
          run_id: runId,
          auth_user_id: input.authUserId,
          started_at: input.startedAtIso,
          finished_at: summary.finishedAtIso,
          status: summary.status,
          trigger_source: input.trigger ?? "manual",
          mode: input.mode,
          window_from: summary.windowFrom,
          window_to: summary.windowTo,
          levels: [...summary.levels],
          api_requests: summary.apiRequests,
          api_failures: apiFailures,
          rows_received: summary.rowsReceived,
          rows_inserted: summary.rowsInserted,
          rows_updated: summary.rowsUpdated,
          rows_skipped: summary.rowsSkipped,
          duration_ms: summary.durationMs,
          error_message: summary.errorMessage,
          raw_response_metadata: summary.rawResponseMetadata,
          warehouse_version: input.warehouseVersion,
          batch_id: batchId,
        }));
    },
  };
}

// ---- Read-only history API (spec §6) -------------------------------------------
// Pure query helpers consumed by the clickhouse-facebook Edge Function. They
// only SELECT from the history tables — Cohorts/allocation never touch these.

const clampLimit = (v: unknown, fallback: number, max: number): number => {
  const parsed = Math.floor(Number(v ?? fallback));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

export async function listFbSyncRuns(
  supabase: SupabaseLikeClient,
  authUserId: string,
  opts: { limit?: unknown; status?: unknown } = {},
): Promise<unknown[]> {
  let query = supabase
    .from(FB_SYNC_RUNS_TABLE)
    .select("*")
    .eq("auth_user_id", authUserId);
  if (opts.status === "completed" || opts.status === "failed") query = query.eq("status", opts.status);
  const { data, error } = await query
    .order("started_at", { ascending: false })
    .limit(clampLimit(opts.limit, 50, 200));
  if (error) throw new Error(`Could not list facebook sync runs: ${error.message}`);
  return (data as unknown[]) ?? [];
}

export async function listFbImportBatches(
  supabase: SupabaseLikeClient,
  authUserId: string,
  opts: { limit?: unknown; run_id?: unknown; status?: unknown } = {},
): Promise<unknown[]> {
  let query = supabase
    .from(FB_IMPORT_BATCHES_TABLE)
    .select("*")
    .eq("auth_user_id", authUserId);
  if (isUuid(opts.run_id)) query = query.eq("run_id", opts.run_id);
  if (opts.status === "staged" || opts.status === "validated" || opts.status === "published" || opts.status === "rolled_back") {
    query = query.eq("status", opts.status);
  }
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(clampLimit(opts.limit, 50, 200));
  if (error) throw new Error(`Could not list facebook import batches: ${error.message}`);
  return (data as unknown[]) ?? [];
}

/** Warehouse versions = the batch ledger keyed by version (one batch per version). */
export async function listFbWarehouseVersions(
  supabase: SupabaseLikeClient,
  authUserId: string,
  opts: { limit?: unknown } = {},
): Promise<unknown[]> {
  const { data, error } = await supabase
    .from(FB_IMPORT_BATCHES_TABLE)
    .select("version, status, batch_id, run_id, checksum, created_at, validated_at, published_at, rolled_back_at")
    .eq("auth_user_id", authUserId)
    .order("created_at", { ascending: false })
    .limit(clampLimit(opts.limit, 100, 500));
  if (error) throw new Error(`Could not list facebook warehouse versions: ${error.message}`);
  return (data as unknown[]) ?? [];
}

/**
 * Raw payload access: metadata list for a batch (payload_json excluded — it can
 * be megabytes), or one full payload by payload_id.
 */
export async function listFbRawPayloads(
  supabase: SupabaseLikeClient,
  authUserId: string,
  opts: { batch_id?: unknown; payload_id?: unknown; limit?: unknown } = {},
): Promise<unknown> {
  if (isUuid(opts.payload_id)) {
    const { data, error } = await supabase
      .from(FB_RAW_PAYLOADS_TABLE)
      .select("*")
      .eq("auth_user_id", authUserId)
      .eq("payload_id", opts.payload_id)
      .maybeSingle();
    if (error) throw new Error(`Could not load facebook raw payload: ${error.message}`);
    return data ?? null;
  }
  if (!isUuid(opts.batch_id)) throw new Error("batch_id (uuid) or payload_id (uuid) is required.");
  const { data, error } = await supabase
    .from(FB_RAW_PAYLOADS_TABLE)
    .select("payload_id, batch_id, entity_level, page, request_date_from, request_date_to, http_ok, payload_bytes, api_latency_ms, received_at")
    .eq("auth_user_id", authUserId)
    .eq("batch_id", opts.batch_id)
    .order("received_at", { ascending: true })
    .limit(clampLimit(opts.limit, 200, 1000));
  if (error) throw new Error(`Could not list facebook raw payloads: ${error.message}`);
  return (data as unknown[]) ?? [];
}

export async function getFbBatchDq(
  supabase: SupabaseLikeClient,
  authUserId: string,
  opts: { batch_id?: unknown } = {},
): Promise<unknown> {
  if (!isUuid(opts.batch_id)) throw new Error("batch_id (uuid) is required.");
  const { data, error } = await supabase
    .from(FB_BATCH_DQ_TABLE)
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("batch_id", opts.batch_id)
    .order("computed_at", { ascending: false })
    .limit(1);
  if (error) throw new Error(`Could not load facebook batch dq: ${error.message}`);
  const rows = (data as unknown[]) ?? [];
  return rows[0] ?? null;
}
