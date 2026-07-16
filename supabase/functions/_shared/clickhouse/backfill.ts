import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";
import {
  buildTransactionMappingContext,
  hydrateSupabaseTransactionRows,
  mapSupabaseTransactionsToClickHouse,
  type MapperDiagnostics,
  type SupabaseTransactionRow,
} from "./transactionMapper.ts";

export type BackfillMode = "continue" | "full_backfill" | "validate_only";
export type SyncStatus = "never_started" | "running" | "partial" | "completed" | "completed_with_inconsistencies" | "failed";
export type StoppedReason = "completed" | "max_batches_reached" | "soft_timeout" | "source_error" | "clickhouse_error" | "mapping_error" | "unknown";

export interface BackfillParams {
  mode?: BackfillMode;
  batch_size?: number;
  max_batches?: number;
  dry_run?: boolean;
  full_reset_cursor?: boolean;
  soft_timeout_ms?: number;
}

export interface ClickHouseSyncState {
  auth_user_id: string;
  sync_name: string;
  status: SyncStatus;
  current_stage: string | null;
  stopped_reason: StoppedReason | null;
  cursor_updated_at: string | null;
  cursor_transaction_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  rows_scanned: number;
  rows_mapped: number;
  rows_inserted: number;
  rows_skipped: number;
  batches_processed: number;
  last_error: string | null;
  last_run_mode: BackfillMode | null;
  source_total: number | null;
  clickhouse_total: number | null;
  parity_status: string | null;
  diagnostics: unknown;
  updated_at?: string;
};

export interface BackfillResult {
  mode: BackfillMode;
  dry_run: boolean;
  status: SyncStatus;
  stopped_reason: StoppedReason;
  current_stage: string;
  batch_size: number;
  max_batches: number;
  rows_scanned: number;
  rows_mapped: number;
  rows_inserted: number;
  rows_skipped: number;
  batches_processed: number;
  cursor_updated_at: string | null;
  cursor_transaction_id: string | null;
  source_total: number;
  clickhouse_total: number;
  diagnostics: MapperDiagnostics & { failed_batches: string[] };
  duration_ms: number;
}

const SYNC_NAME = "analytics_transactions_backfill";
const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_MAX_BATCHES = 10;
const DEFAULT_SOFT_TIMEOUT_MS = 45_000;

const TRANSACTION_SELECT =
  "id,auth_user_id,user_id,transaction_id,external_transaction_id,import_batch_id,source,event_time,status,transaction_type,amount_gross,amount_net,amount_refunded,currency,email,country_code,campaign_path,funnel,source_name,raw_payload,normalized_payload,created_at,updated_at,deleted_at";

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function normalizeBackfillParams(params: BackfillParams = {}): Required<BackfillParams> & { mode: BackfillMode } {
  const mode = params.mode === "full_backfill" || params.mode === "validate_only" ? params.mode : "continue";
  return {
    mode,
    batch_size: clampInt(params.batch_size, DEFAULT_BATCH_SIZE, 1, 10_000),
    max_batches: clampInt(params.max_batches, DEFAULT_MAX_BATCHES, 1, 100),
    dry_run: Boolean(params.dry_run),
    full_reset_cursor: Boolean(params.full_reset_cursor),
    soft_timeout_ms: clampInt(params.soft_timeout_ms, DEFAULT_SOFT_TIMEOUT_MS, 1_000, 55_000),
  };
}

function mergeDiagnostics(base: MapperDiagnostics, next: MapperDiagnostics): MapperDiagnostics {
  base.mapped_rows += next.mapped_rows;
  base.malformed_rows += next.malformed_rows;
  base.missing_user_identity += next.missing_user_identity;
  base.missing_campaign_id += next.missing_campaign_id;
  base.missing_currency += next.missing_currency;
  base.missing_fx_rate += next.missing_fx_rate;
  base.unknown_transaction_type += next.unknown_transaction_type;
  base.unknown_monetization_product += next.unknown_monetization_product;
  base.skipped.push(...next.skipped.slice(0, 100));
  return base;
}

function emptyDiagnostics(): MapperDiagnostics & { failed_batches: string[] } {
  return {
    mapped_rows: 0,
    malformed_rows: 0,
    missing_user_identity: 0,
    missing_campaign_id: 0,
    missing_currency: 0,
    missing_fx_rate: 0,
    unknown_transaction_type: 0,
    unknown_monetization_product: 0,
    skipped: [],
    failed_batches: [],
  };
}

async function getSourceTotal(supabase: SupabaseLikeClient, authUserId: string): Promise<number> {
  const { count, error } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("auth_user_id", authUserId)
    .is("deleted_at", null);
  if (error) throw new Error(`Could not count source transactions: ${error.message}`);
  return count ?? 0;
}

async function getClickHouseTotal(client: ClickHouseClientLike, authUserId: string): Promise<number> {
  const resultSet = await client.query({
    query: `SELECT count() AS count FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String}`,
    query_params: { auth_user_id: authUserId },
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as Array<{ count?: number | string }>;
  return Number(rows[0]?.count ?? 0);
}

async function getSyncState(supabase: SupabaseLikeClient, authUserId: string): Promise<ClickHouseSyncState | null> {
  const { data, error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("sync_name", SYNC_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not load ClickHouse sync state: ${error.message}`);
  return data as ClickHouseSyncState | null;
}

async function upsertSyncState(supabase: SupabaseLikeClient, patch: Partial<ClickHouseSyncState> & { auth_user_id: string }): Promise<void> {
  const { error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .upsert(
      {
        sync_name: SYNC_NAME,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "auth_user_id,sync_name" },
    );
  if (error) throw new Error(`Could not update ClickHouse sync state: ${error.message}`);
}

async function readTransactionBatch(input: {
  supabase: SupabaseLikeClient;
  authUserId: string;
  batchSize: number;
  cursorUpdatedAt: string | null;
  cursorTransactionId: string | null;
}): Promise<SupabaseTransactionRow[]> {
  let query = input.supabase
    .from("transactions")
    .select(TRANSACTION_SELECT)
    .eq("auth_user_id", input.authUserId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: true })
    .order("transaction_id", { ascending: true })
    .limit(input.batchSize);

  if (input.cursorUpdatedAt && input.cursorTransactionId) {
    query = query.or(`updated_at.gt.${input.cursorUpdatedAt},and(updated_at.eq.${input.cursorUpdatedAt},transaction_id.gt.${input.cursorTransactionId})`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Could not read source transaction batch: ${error.message}`);
  return (data ?? []) as SupabaseTransactionRow[];
}

async function readContextRows(supabase: SupabaseLikeClient, authUserId: string, batchRows: SupabaseTransactionRow[]): Promise<SupabaseTransactionRow[]> {
  const userIds = Array.from(new Set(batchRows.map((row) => row.user_id).filter((value): value is string => Boolean(value))));
  if (!userIds.length) return batchRows;
  const chunks: SupabaseTransactionRow[][] = [];
  for (let index = 0; index < userIds.length; index += 200) {
    const ids = userIds.slice(index, index + 200);
    const { data, error } = await supabase
      .from("transactions")
      .select(TRANSACTION_SELECT)
      .eq("auth_user_id", authUserId)
      .is("deleted_at", null)
      .in("user_id", ids)
      .order("event_time", { ascending: true });
    if (error) throw new Error(`Could not read mapping context: ${error.message}`);
    chunks.push((data ?? []) as SupabaseTransactionRow[]);
  }
  return chunks.flat();
}

function lastCursor(rows: SupabaseTransactionRow[]): { cursor_updated_at: string | null; cursor_transaction_id: string | null } {
  const last = rows.at(-1);
  return {
    cursor_updated_at: last?.updated_at ?? null,
    cursor_transaction_id: last?.transaction_id ?? null,
  };
}

export async function runTransactionsBackfill(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  params?: BackfillParams;
  clickhouse: ClickHouseClientLike;
}): Promise<BackfillResult> {
  const params = normalizeBackfillParams(input.params);
  const startedAt = Date.now();
  const diagnostics = emptyDiagnostics();
  const clickhouse = input.clickhouse;
  let stoppedReason: StoppedReason = "unknown";
  let status: SyncStatus = "running";
  let cursorUpdatedAt: string | null = null;
  let cursorTransactionId: string | null = null;
  let rowsScanned = 0;
  let rowsMapped = 0;
  let rowsInserted = 0;
  let rowsSkipped = 0;
  let batchesProcessed = 0;
  let sourceTotal = 0;
  let clickHouseTotal = 0;

  try {
    sourceTotal = await getSourceTotal(input.supabase, input.authUserId);
    const previousState = await getSyncState(input.supabase, input.authUserId);
    const resetCursor = params.mode === "full_backfill" || params.full_reset_cursor;
    cursorUpdatedAt = resetCursor ? null : previousState?.cursor_updated_at ?? null;
    cursorTransactionId = resetCursor ? null : previousState?.cursor_transaction_id ?? null;

    await upsertSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "running",
      current_stage: params.mode === "validate_only" ? "validate_only" : params.dry_run ? "dry_run" : "backfilling",
      stopped_reason: null,
      started_at: new Date(startedAt).toISOString(),
      finished_at: null,
      last_error: null,
      last_run_mode: params.mode,
      source_total: sourceTotal,
      diagnostics,
    });

    if (params.mode === "validate_only") {
      stoppedReason = "completed";
      status = "completed";
    } else {
      for (let batchIndex = 0; batchIndex < params.max_batches; batchIndex += 1) {
        if (Date.now() - startedAt > params.soft_timeout_ms) {
          stoppedReason = "soft_timeout";
          status = "partial";
          break;
        }

        const batch = await readTransactionBatch({
          supabase: input.supabase,
          authUserId: input.authUserId,
          batchSize: params.batch_size,
          cursorUpdatedAt,
          cursorTransactionId,
        });
        if (!batch.length) {
          stoppedReason = "completed";
          status = diagnostics.malformed_rows || diagnostics.missing_fx_rate ? "completed_with_inconsistencies" : "completed";
          break;
        }

        rowsScanned += batch.length;
        const contextRows = await readContextRows(input.supabase, input.authUserId, batch);
        const context = buildTransactionMappingContext(hydrateSupabaseTransactionRows(contextRows));
        const mapped = mapSupabaseTransactionsToClickHouse({
          authUserId: input.authUserId,
          rows: batch,
          context,
          syncedAt: new Date().toISOString(),
        });
        mergeDiagnostics(diagnostics, mapped.diagnostics);
        rowsMapped += mapped.rows.length;
        rowsSkipped += batch.length - mapped.rows.length;

        if (!params.dry_run && mapped.rows.length) {
          await clickhouse.insert({
            table: ANALYTICS_TRANSACTIONS_TABLE,
            values: mapped.rows,
            format: "JSONEachRow",
          });
          rowsInserted += mapped.rows.length;
        }

        const cursor = lastCursor(batch);
        cursorUpdatedAt = cursor.cursor_updated_at;
        cursorTransactionId = cursor.cursor_transaction_id;
        batchesProcessed += 1;

        await upsertSyncState(input.supabase, {
          auth_user_id: input.authUserId,
          status: "partial",
          current_stage: params.dry_run ? "dry_run" : "backfilling",
          cursor_updated_at: cursorUpdatedAt,
          cursor_transaction_id: cursorTransactionId,
          rows_scanned: (previousState?.rows_scanned ?? 0) + rowsScanned,
          rows_mapped: (previousState?.rows_mapped ?? 0) + rowsMapped,
          rows_inserted: (previousState?.rows_inserted ?? 0) + rowsInserted,
          rows_skipped: (previousState?.rows_skipped ?? 0) + rowsSkipped,
          batches_processed: (previousState?.batches_processed ?? 0) + batchesProcessed,
          source_total: sourceTotal,
          diagnostics,
        });
      }

      if (stoppedReason === "unknown") {
        stoppedReason = "max_batches_reached";
        status = "partial";
      }
    }

    clickHouseTotal = params.dry_run ? 0 : await getClickHouseTotal(clickhouse, input.authUserId);
    const durationMs = Date.now() - startedAt;
    await upsertSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status,
      current_stage: "idle",
      stopped_reason: stoppedReason,
      cursor_updated_at: cursorUpdatedAt,
      cursor_transaction_id: cursorTransactionId,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      rows_scanned: (previousState?.rows_scanned ?? 0) + rowsScanned,
      rows_mapped: (previousState?.rows_mapped ?? 0) + rowsMapped,
      rows_inserted: (previousState?.rows_inserted ?? 0) + rowsInserted,
      rows_skipped: (previousState?.rows_skipped ?? 0) + rowsSkipped,
      batches_processed: (previousState?.batches_processed ?? 0) + batchesProcessed,
      last_run_mode: params.mode,
      source_total: sourceTotal,
      clickhouse_total: clickHouseTotal,
      parity_status: sourceTotal === clickHouseTotal ? "unknown_until_validation" : "needs_validation",
      diagnostics: { ...diagnostics, stopped_reason: stoppedReason, dry_run: params.dry_run },
    });

    return {
      mode: params.mode,
      dry_run: params.dry_run,
      status,
      stopped_reason: stoppedReason,
      current_stage: stoppedReason,
      batch_size: params.batch_size,
      max_batches: params.max_batches,
      rows_scanned: rowsScanned,
      rows_mapped: rowsMapped,
      rows_inserted: rowsInserted,
      rows_skipped: rowsSkipped,
      batches_processed: batchesProcessed,
      cursor_updated_at: cursorUpdatedAt,
      cursor_transaction_id: cursorTransactionId,
      source_total: sourceTotal,
      clickhouse_total: clickHouseTotal,
      diagnostics,
      duration_ms: durationMs,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown ClickHouse backfill error.";
    const durationMs = Date.now() - startedAt;
    diagnostics.failed_batches.push(message);
    const failedReason: StoppedReason = message.toLowerCase().includes("clickhouse") ? "clickhouse_error" : "source_error";
    await upsertSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "failed",
      current_stage: "failed",
      stopped_reason: failedReason,
      cursor_updated_at: cursorUpdatedAt,
      cursor_transaction_id: cursorTransactionId,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      rows_scanned: rowsScanned,
      rows_mapped: rowsMapped,
      rows_inserted: rowsInserted,
      rows_skipped: rowsSkipped,
      batches_processed: batchesProcessed,
      last_error: message,
      last_run_mode: params.mode,
      source_total: sourceTotal,
      clickhouse_total: clickHouseTotal,
      diagnostics,
    }).catch(() => undefined);
    throw error;
  }
}
