import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";
import { clickHouseBodyStringSet } from "./fbCohortStats.ts";
import {
  buildTransactionMappingContext,
  hydrateSupabaseTransactionRows,
  mapSupabaseTransactionsToClickHouse,
  type MapperDiagnostics,
  type SupabaseTransactionRow,
} from "./transactionMapper.ts";

export type BackfillMode = "continue" | "full_backfill" | "validate_only" | "dedup";
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
  /** mode=dedup: transaction_ids that had more than one physical copy in
   * ClickHouse (different sorting keys) and were re-queued for a clean rewrite. */
  duplicates_found?: number;
  duplicates_requeued?: number;
  status: SyncStatus;
  /** "already_running" is response-only (another run holds the lease) and is
   * never persisted — the sync-state CHECK constraint does not allow it. */
  stopped_reason: StoppedReason | "already_running";
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
  /** "already_running" only: when the held lease turns stale (the holder's
   * last write + BACKFILL_LEASE_STALE_MS), i.e. the latest time a retry can
   * succeed if the holder was killed. null when the holder's write time is
   * unknown. */
  lease_retry_after?: string | null;
}

const SYNC_NAME = "analytics_transactions_backfill";
const SYNC_STATE_TABLE = "clickhouse_transaction_sync_state";
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
  const mode = params.mode === "full_backfill" || params.mode === "validate_only" || params.mode === "dedup" ? params.mode : "continue";
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

// ---- run lease ----------------------------------------------------------------
//
// Two runs for one tenant (a manual Continue racing the post-import auto-sync,
// two admins, two tabs) used to interleave freely: each read the same cursor,
// re-wrote the same batches and overwrote the other's counters. The sync-state
// row doubles as the lease, compare-and-set through PostgREST (no migration):
//   * a run HOLDS the lease while current_stage is one of BACKFILL_RUN_STAGES —
//     every write of a live run keeps it there ("running" → "partial" status
//     changes are untouched), the final write sets "idle", a failure "failed";
//   * the claim is one conditional UPDATE … WHERE the row is free, so of two
//     concurrent claims Postgres lets exactly one match (the loser re-checks
//     the WHERE after the winner's row lock and matches nothing);
//   * a run killed mid-flight (isolate wall-clock limit) leaves its stage
//     behind; the lease is free again once the row's updated_at — refreshed by
//     the table trigger on every batch write — is older than
//     BACKFILL_LEASE_STALE_MS, which exceeds the Edge wall-clock limit (400 s)
//     so a live run is never taken over.

/** current_stage values written while a run is in progress. */
export const BACKFILL_RUN_STAGES = ["backfilling", "dry_run", "validate_only"] as const;
export const BACKFILL_LEASE_STALE_MS = 10 * 60_000;

/** PostgREST `or` filter of a claimable row: no run stage, or a stale one. */
export function backfillLeaseClaimFilter(staleBeforeIso: string): string {
  return `current_stage.is.null,current_stage.not.in.(${BACKFILL_RUN_STAGES.join(",")}),updated_at.lt.${staleBeforeIso}`;
}

/** Claims the run lease, writing `claim` (the run's "running" fields) in the
 * same statement. false = another live run holds it. */
async function claimBackfillLease(
  supabase: SupabaseLikeClient,
  authUserId: string,
  claim: Partial<ClickHouseSyncState>,
  nowMs: number,
): Promise<boolean> {
  // The first run of a tenant has no row to compare against: create the empty
  // row first without touching an existing one (INSERT … ON CONFLICT DO NOTHING).
  const seeded = await supabase
    .from(SYNC_STATE_TABLE)
    .upsert({ auth_user_id: authUserId, sync_name: SYNC_NAME }, { onConflict: "auth_user_id,sync_name", ignoreDuplicates: true });
  if (seeded.error) throw new Error(`Could not claim the ClickHouse backfill run: ${seeded.error.message}`);

  const builder = supabase.from(SYNC_STATE_TABLE);
  if (!builder.update) throw new Error("Supabase client cannot update the ClickHouse sync state (the backfill run lease needs .update).");
  const { data, error } = await builder
    .update({ ...claim, updated_at: new Date(nowMs).toISOString() })
    .eq("auth_user_id", authUserId)
    .eq("sync_name", SYNC_NAME)
    .or(backfillLeaseClaimFilter(new Date(nowMs - BACKFILL_LEASE_STALE_MS).toISOString()))
    .select("sync_name");
  if (error) throw new Error(`Could not claim the ClickHouse backfill run: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/** The answer to a run that found the lease held: nothing was read, written or
 * re-queued. batches_processed 0 ends the browser's auto-sync loop. */
async function alreadyRunningResult(
  supabase: SupabaseLikeClient,
  authUserId: string,
  params: ReturnType<typeof normalizeBackfillParams>,
  startedAt: number,
): Promise<BackfillResult> {
  const state = await getSyncState(supabase, authUserId).catch(() => null);
  return {
    mode: params.mode,
    dry_run: params.dry_run,
    duplicates_found: 0,
    duplicates_requeued: 0,
    status: "running",
    stopped_reason: "already_running",
    current_stage: "already_running",
    batch_size: params.batch_size,
    max_batches: params.max_batches,
    rows_scanned: 0,
    rows_mapped: 0,
    rows_inserted: 0,
    rows_skipped: 0,
    batches_processed: 0,
    cursor_updated_at: state?.cursor_updated_at ?? null,
    cursor_transaction_id: state?.cursor_transaction_id ?? null,
    source_total: Number(state?.source_total ?? 0),
    clickhouse_total: Number(state?.clickhouse_total ?? 0),
    diagnostics: emptyDiagnostics(),
    duration_ms: Date.now() - startedAt,
    lease_retry_after: backfillLeaseRetryAfter(state?.updated_at ?? null),
  };
}

/** When a lease last written at `updatedAt` becomes claimable again. */
export function backfillLeaseRetryAfter(updatedAt: string | null | undefined): string | null {
  const writtenAt = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  return Number.isFinite(writtenAt) ? new Date(writtenAt + BACKFILL_LEASE_STALE_MS).toISOString() : null;
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

/**
 * The sorting key of analytics_transactions carries DERIVED attribution
 * (cohort_date, funnel, campaign_path, campaign_id, user_id). When a
 * transaction is re-synced after its derivation changed — the incremental
 * Palmer import normalizes a day on its own, the next full pass re-derives
 * cohort_date — the fresh row lands under a NEW key and ReplacingMergeTree
 * keeps the old copy too. Found live 2026-09-29: the same 254.99 BRL first
 * subscription sat in the warehouse twice, the lifecycle classifier numbered
 * the copies lvl 1 and lvl 2 ("Sub → Renewal 2 CR" 100% three days after the
 * trial) and doubled its revenue. Every batch therefore evicts ALL existing
 * copies of the transaction_ids it is about to write, key-agnostic, before the
 * insert (a lightweight DELETE; a failed insert leaves the cursor behind, so
 * the next run rewrites the same rows).
 */
export function buildStaleCopiesDeleteSql(transactionIds: readonly string[]): string {
  return `DELETE FROM ${ANALYTICS_TRANSACTIONS_TABLE} WHERE auth_user_id = {auth_user_id:String} AND transaction_id IN ${clickHouseBodyStringSet([...transactionIds])}`;
}

/** transaction_ids with more than one physical copy (FINAL collapses only
 * same-key duplicates, so every survivor here is a key-drift copy). */
export function buildDuplicateTransactionIdsSql(): string {
  return `SELECT transaction_id, count() AS copies FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY transaction_id HAVING copies > 1 ORDER BY copies DESC, transaction_id LIMIT 5000 FORMAT JSONEachRow`;
}

/** mode=dedup: find key-drift copies, bump the source rows' updated_at so the
 * keyset sync re-reads them, and let the normal batch loop rewrite each one
 * cleanly (the eviction above removes every old copy first). */
async function requeueDuplicateTransactions(input: {
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  authUserId: string;
}): Promise<{ found: number; requeued: number }> {
  const resultSet = await input.clickhouse.query({
    query: buildDuplicateTransactionIdsSql(),
    query_params: { auth_user_id: input.authUserId },
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as Array<{ transaction_id?: string }>;
  const ids = rows.map((row) => String(row.transaction_id ?? "")).filter(Boolean);
  if (!ids.length) return { found: 0, requeued: 0 };
  const builder = input.supabase.from("transactions");
  if (!builder.update) throw new Error("Supabase client cannot update transactions (dedup needs .update).");
  let requeued = 0;
  for (let index = 0; index < ids.length; index += 200) {
    const chunk = ids.slice(index, index + 200);
    const { error } = await builder.update({ updated_at: new Date().toISOString() })
      .eq("auth_user_id", input.authUserId)
      .in("transaction_id", chunk);
    if (error) throw new Error(`Could not re-queue duplicate transactions: ${error.message}`);
    requeued += chunk.length;
  }
  return { found: ids.length, requeued };
}

export async function runTransactionsBackfill(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  params?: BackfillParams;
  clickhouse: ClickHouseClientLike;
}): Promise<BackfillResult> {
  const params = normalizeBackfillParams(input.params);
  // clickhouse_transaction_sync_state.last_run_mode has a CHECK constraint for
  // continue/full_backfill/validate_only; dedup is a continue run preceded by
  // the duplicate re-queue, and is recorded as such.
  const persistedRunMode: Exclude<BackfillMode, "dedup"> = params.mode === "dedup" ? "continue" : params.mode;
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
  let duplicatesFound = 0;
  let duplicatesRequeued = 0;

  // One run per tenant: claim the lease before anything is read, re-queued or
  // written. A claim failure is thrown as-is — this run never held the lease,
  // so it must not write the "failed" state over the holder's row.
  const claimed = await claimBackfillLease(input.supabase, input.authUserId, {
    status: "running",
    current_stage: params.mode === "validate_only" ? "validate_only" : params.dry_run ? "dry_run" : "backfilling",
    stopped_reason: null,
    started_at: new Date(startedAt).toISOString(),
    finished_at: null,
    last_error: null,
    last_run_mode: persistedRunMode,
  }, startedAt);
  if (!claimed) return alreadyRunningResult(input.supabase, input.authUserId, params, startedAt);

  try {
    if (params.mode === "dedup" && !params.dry_run) {
      const requeue = await requeueDuplicateTransactions({ supabase: input.supabase, clickhouse, authUserId: input.authUserId });
      duplicatesFound = requeue.found;
      duplicatesRequeued = requeue.requeued;
    }
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
      last_run_mode: persistedRunMode,
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
          // Evict every existing copy of these transaction_ids first — see
          // buildStaleCopiesDeleteSql for why the sorting key cannot do it.
          await clickhouse.command({
            query: buildStaleCopiesDeleteSql(mapped.rows.map((row) => String((row as { transaction_id?: unknown }).transaction_id ?? ""))),
            query_params: { auth_user_id: input.authUserId },
          });
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
      last_run_mode: persistedRunMode,
      source_total: sourceTotal,
      clickhouse_total: clickHouseTotal,
      parity_status: sourceTotal === clickHouseTotal ? "unknown_until_validation" : "needs_validation",
      diagnostics: { ...diagnostics, stopped_reason: stoppedReason, dry_run: params.dry_run },
    });

    return {

      mode: params.mode,

      dry_run: params.dry_run,

      duplicates_found: duplicatesFound,

      duplicates_requeued: duplicatesRequeued,
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
    // Every failure — a ScopeViolation included — records "failed", which also
    // releases the run lease, and is rethrown unchanged (never swallowed).
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
      last_run_mode: persistedRunMode,
      source_total: sourceTotal,
      clickhouse_total: clickHouseTotal,
      diagnostics,
    }).catch(() => undefined);
    throw error;
  }
}
