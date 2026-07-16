import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { supabase } from "@/services/supabaseClient";
import { addCohortFields, backfillTransactionCardTypesFromRawRows, classifyUserTransactions } from "@/services/palmerTransform";
import { declineDetailsForTransaction } from "@/services/paymentFailures";
import { sha256Hex } from "@/services/sha256";
import { traceAsync, traceEvent, traceRequest } from "@/services/performanceTrace";
import type { TrafficSource, Transaction } from "@/services/types";

export const USE_TRANSACTION_WAREHOUSE = publicRuntimeConfig.useTransactionWarehouse;
export const TRANSACTION_WAREHOUSE_CHUNK_SIZE = 1000;
export const TRANSACTION_WAREHOUSE_SELECT_PAGE_SIZE = 1000;

export type ImportBatchStatus = "processing" | "completed" | "failed" | "cancelled" | "rolled_back";

export interface ImportBatchInfo {
  id: string;
  source: string;
  filename: string | null;
  checksum: string | null;
  rows_total: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  imported_at: string;
  status: ImportBatchStatus;
  notes: string | null;
  metadata: Record<string, unknown> | null;
}

export interface WarehouseImportSummary {
  batchId: string | null;
  checksum: string;
  totalRows: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  potentialDuplicates: number;
  dateRange: DateRangeSummary | null;
  overlapsExisting: boolean;
  duplicateFile: boolean;
  errors: string[];
}

export interface DateRangeSummary {
  from: string;
  to: string;
}

export interface WarehouseImportInput {
  rows: Transaction[];
  rawRows?: Record<string, unknown>[];
  filename?: string;
  fileSize?: number;
  source?: string;
  sourceKind?: "csv" | "google_sheet";
  importedFrom?: string;
  importMode?: string;
}

export interface WarehouseTransactionRecord {
  user_id: string | null;
  transaction_id: string;
  external_transaction_id: string | null;
  import_batch_id: string | null;
  source: string;
  event_time: string;
  status: string | null;
  transaction_type: string | null;
  amount_gross: number | null;
  amount_net: number | null;
  amount_refunded: number | null;
  currency: string | null;
  email: string | null;
  country_code: string | null;
  campaign_path: string | null;
  funnel: string | null;
  source_name: string | null;
  raw_payload: Record<string, unknown>;
  normalized_payload: Record<string, unknown>;
  deleted_at: string | null;
}

type ExistingWarehouseRecord = {
  transaction_id: string;
  event_time?: string | null;
  normalized_payload: Record<string, unknown> | null;
};

type WarehouseLoadedRecord = {
  source: string | null;
  raw_payload?: Record<string, unknown> | null;
  normalized_payload: Record<string, unknown> | null;
};

type UpsertClient = {
  fetchExisting: (transactionIds: string[]) => Promise<ExistingWarehouseRecord[]>;
  upsertTransactions: (records: WarehouseTransactionRecord[]) => Promise<void>;
};

type BatchClient = {
  findBatchByChecksum: (checksum: string) => Promise<ImportBatchInfo | null>;
  createBatch: (input: {
    source: string;
    filename?: string;
    checksum: string;
    rowsTotal: number;
    metadata: Record<string, unknown>;
  }) => Promise<string>;
  updateBatch: (batchId: string, patch: Partial<Pick<ImportBatchInfo, "rows_inserted" | "rows_updated" | "rows_skipped" | "status" | "notes">> & {
    metadata?: Record<string, unknown>;
  }) => Promise<void>;
  createBatchFile: (input: {
    batchId: string;
    filename: string;
    fileSize?: number;
  }) => Promise<void>;
};

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function summarizeDateRange(records: Pick<WarehouseTransactionRecord, "event_time">[]): DateRangeSummary | null {
  const dates = records
    .map((record) => dateKey(record.event_time))
    .filter((value): value is string => Boolean(value))
    .sort();
  if (!dates.length) return null;
  return {
    from: dates[0],
    to: dates[dates.length - 1],
  };
}

export function isTransactionWarehouseEnabled(): boolean {
  return USE_TRANSACTION_WAREHOUSE && Boolean(supabase);
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

async function currentUserId(): Promise<string> {
  const client = ensureSupabase();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) {
    throw new Error("Sign in with Supabase before importing to the transaction warehouse.");
  }
  return data.user.id;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function round2(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => [key, canonicalize(entryValue)]),
  );
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export async function checksumRows(rows: Record<string, unknown>[]): Promise<string> {
  return sha256Hex(canonicalStringify(rows));
}

// Deterministic id used when a provider transaction_id is missing. It is intentionally NOT scoped
// by auth_user_id: cross-tenant safety comes from the composite (auth_user_id, transaction_id)
// unique index (P0-3), so the same logical row imported by two accounts lands on each account's own
// row instead of colliding. Within one account, an identical fallback id still dedupes as intended.
export async function fallbackTransactionId(row: Transaction): Promise<string> {
  const basis = [
    normalizeText(row.email)?.toLowerCase() ?? "",
    round2(row.amount_usd) ?? round2(row.gross_amount_usd) ?? "",
    row.event_time,
  ].join("|");
  return `fallback:${await sha256Hex(basis)}`;
}

export async function normalizeForWarehouse(
  row: Transaction,
  rawRow: Record<string, unknown> | undefined,
  importBatchId: string | null,
  source: string,
): Promise<WarehouseTransactionRecord> {
  const declaredTransactionId = normalizeText(row.transaction_id);
  const transactionId = declaredTransactionId ?? await fallbackTransactionId(row);
  const rawPayload = rawRow ?? row.raw ?? {};
  const normalizedPayload: Record<string, unknown> = {
    ...row,
    transaction_id: transactionId,
  };
  const sourceName = row.traffic_source === "unknown" ? null : row.traffic_source;
  const countryCode =
    typeof row.raw?.ff_country_code === "string"
      ? row.raw.ff_country_code
      : typeof row.metadata?.ff_country_code === "string"
        ? row.metadata.ff_country_code
        : typeof row.metadata?.country_code === "string"
          ? row.metadata.country_code
          : null;

  return {
    user_id: normalizeText(row.user_id),
    transaction_id: transactionId,
    external_transaction_id: declaredTransactionId,
    import_batch_id: importBatchId,
    source,
    event_time: row.event_time,
    status: row.status,
    transaction_type: row.transaction_type,
    amount_gross: round2(row.gross_amount_usd ?? row.amount_usd),
    amount_net: round2(row.net_amount_usd ?? row.amount_usd),
    amount_refunded: round2(row.refund_amount_usd),
    currency: normalizeText(row.currency),
    email: normalizeText(row.email),
    country_code: normalizeText(countryCode),
    campaign_path: normalizeText(row.campaign_path),
    funnel: row.funnel,
    source_name: sourceName,
    raw_payload: rawPayload,
    normalized_payload: normalizedPayload,
    deleted_at: null,
  };
}

export async function prepareWarehouseRecords(input: {
  rows: Transaction[];
  rawRows?: Record<string, unknown>[];
  batchId: string | null;
  source: string;
}): Promise<{ records: WarehouseTransactionRecord[]; failed: number; errors: string[] }> {
  const records: WarehouseTransactionRecord[] = [];
  const seen = new Set<string>();
  let failed = 0;
  const errors: string[] = [];

  for (const [index, row] of input.rows.entries()) {
    try {
      if (!row.event_time || Number.isNaN(new Date(row.event_time).getTime())) {
        throw new Error("event_time is required");
      }
      const record = await normalizeForWarehouse(row, input.rawRows?.[index], input.batchId, input.source);
      if (seen.has(record.transaction_id)) continue;
      seen.add(record.transaction_id);
      records.push(record);
    } catch (error) {
      failed += 1;
      errors.push(`Row ${index + 1}: ${error instanceof Error ? error.message : "Invalid transaction"}`);
    }
  }

  return { records, failed, errors };
}

export async function summarizeWarehouseUpsert(
  records: WarehouseTransactionRecord[],
  client: UpsertClient,
): Promise<{ inserted: number; updated: number; skipped: number; potentialDuplicates: number; overlapsExisting: boolean }> {
  const existingRows = new Map<string, ExistingWarehouseRecord>();
  for (const idChunk of chunk(records.map((record) => record.transaction_id), TRANSACTION_WAREHOUSE_CHUNK_SIZE)) {
    const rows = await client.fetchExisting(idChunk);
    for (const row of rows) existingRows.set(row.transaction_id, row);
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let potentialDuplicates = 0;
  const changedRecords: WarehouseTransactionRecord[] = [];

  for (const record of records) {
    const existing = existingRows.get(record.transaction_id);
    if (!existing) {
      inserted += 1;
      changedRecords.push(record);
      continue;
    }
    potentialDuplicates += 1;
    if (canonicalStringify(existing.normalized_payload ?? {}) === canonicalStringify(record.normalized_payload)) {
      skipped += 1;
      continue;
    }
    updated += 1;
    changedRecords.push(record);
  }

  for (const recordChunk of chunk(changedRecords, TRANSACTION_WAREHOUSE_CHUNK_SIZE)) {
    await client.upsertTransactions(recordChunk);
  }

  return {
    inserted,
    updated,
    skipped,
    potentialDuplicates,
    overlapsExisting: potentialDuplicates > 0,
  };
}

function createSupabaseUpsertClient(): UpsertClient {
  const client = ensureSupabase();
  // P0-3: dedup is scoped per tenant. fetchExisting must only see THIS user's rows so a
  // transaction_id that exists for another account is correctly treated as a new insert, and the
  // upsert conflict target must be the composite (auth_user_id, transaction_id) unique index.
  let cachedAuthUserId: string | null = null;
  const authUserId = async () => {
    if (!cachedAuthUserId) cachedAuthUserId = await currentUserId();
    return cachedAuthUserId;
  };
  return {
    async fetchExisting(transactionIds) {
      if (!transactionIds.length) return [];
      const { data, error } = await client
        .from("transactions")
        .select("transaction_id,event_time,normalized_payload")
        .eq("auth_user_id", await authUserId())
        .in("transaction_id", transactionIds)
        .is("deleted_at", null);
      if (error) throw new Error(`Could not inspect existing transactions: ${error.message}`);
      return (data ?? []) as ExistingWarehouseRecord[];
    },
    async upsertTransactions(records) {
      if (!records.length) return;
      const userId = await authUserId();
      const payload = records.map((record) => ({
        ...record,
        auth_user_id: userId,
      }));
      const { error } = await client
        .from("transactions")
        .upsert(payload, { onConflict: "auth_user_id,transaction_id" });
      if (error) throw new Error(`Could not upsert transaction batch: ${error.message}`);
    },
  };
}

function createSupabaseBatchClient(): BatchClient {
  const client = ensureSupabase();
  return {
    async findBatchByChecksum(checksum) {
      const { data, error } = await client
        .from("import_batches")
        .select("id,source,filename,checksum,rows_total,rows_inserted,rows_updated,rows_skipped,imported_at,status,notes,metadata")
        .eq("checksum", checksum)
        .order("imported_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`Could not check import checksum: ${error.message}`);
      return data as ImportBatchInfo | null;
    },
    async createBatch(input) {
      const userId = await currentUserId();
      const { data, error } = await client
        .from("import_batches")
        .insert({
          user_id: userId,
          source: input.source,
          filename: input.filename ?? null,
          checksum: input.checksum,
          rows_total: input.rowsTotal,
          status: "processing",
          metadata: input.metadata,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Could not create import batch: ${error.message}`);
      return data.id as string;
    },
    async updateBatch(batchId, patch) {
      const { error } = await client
        .from("import_batches")
        .update(patch)
        .eq("id", batchId);
      if (error) throw new Error(`Could not update import batch: ${error.message}`);
    },
    async createBatchFile(input) {
      const { error } = await client
        .from("import_batch_files")
        .insert({
          import_batch_id: input.batchId,
          filename: input.filename,
          file_size: input.fileSize ?? null,
          uploaded_at: new Date().toISOString(),
        });
      if (error) throw new Error(`Could not store import file metadata: ${error.message}`);
    },
  };
}

export async function importTransactionsToWarehouse(input: WarehouseImportInput): Promise<WarehouseImportSummary> {
  if (!USE_TRANSACTION_WAREHOUSE) {
    throw new Error("Transaction warehouse is disabled by VITE_USE_TRANSACTION_WAREHOUSE=false.");
  }
  const source = input.source ?? "primer_csv";
  const checksum = await checksumRows(input.rawRows ?? input.rows.map((row) => row as unknown as Record<string, unknown>));
  const batchClient = createSupabaseBatchClient();
  const previousBatch = await batchClient.findBatchByChecksum(checksum);
  const importMetadata = {
    import_mode: input.importMode,
    source_kind: input.sourceKind,
    imported_from: input.importedFrom,
    chunk_size: TRANSACTION_WAREHOUSE_CHUNK_SIZE,
  };
  let batchId: string | null = null;

  try {
    batchId = await batchClient.createBatch({
      source,
      filename: input.filename,
      checksum,
      rowsTotal: input.rows.length,
      metadata: importMetadata,
    });

    if (input.filename) {
      await batchClient.createBatchFile({
        batchId,
        filename: input.filename,
        fileSize: input.fileSize,
      });
    }

    const prepared = await prepareWarehouseRecords({
      rows: input.rows,
      rawRows: input.rawRows,
      batchId,
      source,
    });
    const upsertSummary = await summarizeWarehouseUpsert(prepared.records, createSupabaseUpsertClient());
    const dateRange = summarizeDateRange(prepared.records);
    const summary: WarehouseImportSummary = {
      batchId,
      checksum,
      totalRows: input.rows.length,
      inserted: upsertSummary.inserted,
      updated: upsertSummary.updated,
      skipped: upsertSummary.skipped,
      failed: prepared.failed,
      potentialDuplicates: upsertSummary.potentialDuplicates,
      dateRange,
      overlapsExisting: upsertSummary.overlapsExisting,
      duplicateFile: Boolean(previousBatch),
      errors: prepared.errors,
    };

    await batchClient.updateBatch(batchId, {
      rows_inserted: summary.inserted,
      rows_updated: summary.updated,
      rows_skipped: summary.skipped,
      status: prepared.failed ? "failed" : "completed",
      notes: prepared.failed ? prepared.errors.slice(0, 5).join("\n") : null,
      metadata: {
        ...importMetadata,
        duplicate_checksum_batch_id: previousBatch?.id,
        date_range: dateRange,
        overlaps_existing_transactions: summary.overlapsExisting,
        potential_duplicate_rows: summary.potentialDuplicates,
        failed_rows: prepared.failed,
        errors: prepared.errors.slice(0, 25),
      },
    });

    return summary;
  } catch (error) {
    if (batchId) {
      await batchClient.updateBatch(batchId, {
        status: "failed",
        notes: error instanceof Error ? error.message : "Unknown import error",
      }).catch(() => undefined);
    }
    throw error;
  }
}

export async function listImportBatches(limit = 20): Promise<ImportBatchInfo[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("import_batches")
    .select("id,source,filename,checksum,rows_total,rows_inserted,rows_updated,rows_skipped,imported_at,status,notes,metadata")
    .order("imported_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Could not load import history: ${error.message}`);
  return (data ?? []) as ImportBatchInfo[];
}

// ---------------------------------------------------------------------------
// Import management: Delete / Rollback / Duplicate cleanup.
// ---------------------------------------------------------------------------

/** Statuses whose batches are always removed by Cleanup (never "completed"). */
export const CLEANUP_REMOVABLE_STATUSES: ImportBatchStatus[] = ["failed", "cancelled", "rolled_back"];

export interface DuplicateCleanupPlan {
  /** Batch ids that survive cleanup (newest completed per checksum). */
  keepIds: string[];
  /** Batch ids to remove (older completed duplicates + failed/cancelled/rolled_back). */
  deleteIds: string[];
  /** Older completed batches sharing a checksum with a newer completed batch. */
  duplicateImports: number;
  /** Failed + cancelled + rolled_back batches. */
  failedImports: number;
}

export interface ImportDeletionResult {
  batchId: string;
  deletedTransactions: number;
}

export interface DuplicateCleanupResult {
  duplicateImports: number;
  failedImports: number;
  transactionsRemoved: number;
}

/**
 * Pure planner mirroring the cleanup_duplicate_imports() SQL: for each checksum group of COMPLETED
 * batches keep the newest (by imported_at, id tie-break) and mark the rest as duplicates; every
 * failed / cancelled / rolled_back batch is removed regardless of checksum. Batches without a
 * checksum are their own group (never deduped against others), matching coalesce(checksum, id).
 */
export function planDuplicateCleanup(batches: ImportBatchInfo[]): DuplicateCleanupPlan {
  const removable = new Set<ImportBatchStatus>(CLEANUP_REMOVABLE_STATUSES);
  const deleteIds: string[] = [];

  const completedByChecksum = new Map<string, ImportBatchInfo[]>();
  for (const batch of batches) {
    if (batch.status !== "completed") continue;
    const key = batch.checksum ? `checksum:${batch.checksum}` : `id:${batch.id}`;
    const group = completedByChecksum.get(key) ?? [];
    group.push(batch);
    completedByChecksum.set(key, group);
  }

  let duplicateImports = 0;
  completedByChecksum.forEach((group) => {
    if (group.length < 2) return;
    const sorted = [...group].sort((a, b) =>
      a.imported_at < b.imported_at ? 1 : a.imported_at > b.imported_at ? -1 : a.id < b.id ? 1 : -1,
    );
    // Keep sorted[0] (newest); delete the rest.
    for (const batch of sorted.slice(1)) {
      deleteIds.push(batch.id);
      duplicateImports += 1;
    }
  });

  let failedImports = 0;
  for (const batch of batches) {
    if (!removable.has(batch.status)) continue;
    deleteIds.push(batch.id);
    failedImports += 1;
  }

  const deleteSet = new Set(deleteIds);
  const keepIds = batches.filter((batch) => !deleteSet.has(batch.id)).map((batch) => batch.id);
  return { keepIds, deleteIds, duplicateImports, failedImports };
}

/**
 * Abstraction over the destructive warehouse operations so the UI can run them against Supabase RPC
 * (atomic, hard delete, transactions removed before the batch) while tests inject an in-memory store.
 */
export interface WarehouseManagementClient {
  deleteBatch: (batchId: string) => Promise<ImportDeletionResult>;
  rollbackBatch: (batchId: string) => Promise<ImportDeletionResult>;
  cleanupDuplicates: (dryRun: boolean) => Promise<DuplicateCleanupResult>;
  batchTransactionCounts: () => Promise<Map<string, number>>;
}

function createSupabaseManagementClient(): WarehouseManagementClient {
  const client = ensureSupabase();
  return {
    async deleteBatch(batchId) {
      const { data, error } = await client.rpc("delete_import_batch", { p_batch_id: batchId });
      if (error) throw new Error(`Could not delete import: ${error.message}`);
      const result = (data ?? {}) as { deleted_transactions?: number };
      return { batchId, deletedTransactions: Number(result.deleted_transactions ?? 0) };
    },
    async rollbackBatch(batchId) {
      const { data, error } = await client.rpc("rollback_import_batch", { p_batch_id: batchId });
      if (error) throw new Error(`Could not roll back import: ${error.message}`);
      const result = (data ?? {}) as { deleted_transactions?: number };
      return { batchId, deletedTransactions: Number(result.deleted_transactions ?? 0) };
    },
    async cleanupDuplicates(dryRun) {
      const { data, error } = await client.rpc("cleanup_duplicate_imports", { p_dry_run: dryRun });
      if (error) throw new Error(`Could not clean up imports: ${error.message}`);
      const result = (data ?? {}) as {
        duplicate_imports?: number;
        failed_imports?: number;
        transactions_removed?: number;
      };
      return {
        duplicateImports: Number(result.duplicate_imports ?? 0),
        failedImports: Number(result.failed_imports ?? 0),
        transactionsRemoved: Number(result.transactions_removed ?? 0),
      };
    },
    async batchTransactionCounts() {
      const { data, error } = await client.rpc("import_batch_transaction_counts");
      if (error) throw new Error(`Could not load transaction counts: ${error.message}`);
      const counts = new Map<string, number>();
      for (const row of (data ?? []) as { import_batch_id: string; transaction_count: number }[]) {
        counts.set(row.import_batch_id, Number(row.transaction_count ?? 0));
      }
      return counts;
    },
  };
}

/** Delete an import and ALL transactions it owns (hard delete — no orphaned rows). */
export async function deleteImportBatch(
  batchId: string,
  client: WarehouseManagementClient = createSupabaseManagementClient(),
): Promise<ImportDeletionResult> {
  if (!batchId) throw new Error("An import batch id is required to delete an import.");
  return client.deleteBatch(batchId);
}

/** Roll back an import: remove only its transactions, keep the history row as an audit trail. */
export async function rollbackImportBatch(
  batchId: string,
  client: WarehouseManagementClient = createSupabaseManagementClient(),
): Promise<ImportDeletionResult> {
  if (!batchId) throw new Error("An import batch id is required to roll back an import.");
  return client.rollbackBatch(batchId);
}

/** Preview the duplicate-cleanup plan (no rows are removed). */
export async function previewDuplicateCleanup(
  client: WarehouseManagementClient = createSupabaseManagementClient(),
): Promise<DuplicateCleanupResult> {
  return client.cleanupDuplicates(true);
}

/** Remove duplicate / failed / cancelled imports and their transactions. */
export async function cleanupDuplicateImports(
  client: WarehouseManagementClient = createSupabaseManagementClient(),
): Promise<DuplicateCleanupResult> {
  return client.cleanupDuplicates(false);
}

/** Live transaction counts keyed by import_batch_id (for the details panel). */
export async function getImportBatchTransactionCounts(
  client: WarehouseManagementClient = createSupabaseManagementClient(),
): Promise<Map<string, number>> {
  return client.batchTransactionCounts();
}

export async function getWarehouseTransactionCount(): Promise<number> {
  const client = ensureSupabase();
  const { count, error } = await traceRequest(
    "supabase.transactions_count",
    "supabase:transactions:count_head",
    () => client
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null),
    { table: "transactions", operation: "count" },
  );
  if (error) throw new Error(`Could not count warehouse transactions: ${error.message}`);
  return count ?? 0;
}

export interface WarehouseTransactionsLoadProgress {
  total_rows_expected: number | null;
  rows_downloaded: number;
  rows_stored: number;
  pages_loaded: number;
  pages_expected: number | null;
  current_page: number;
  has_more: boolean;
  duration_ms: number;
  source_complete: boolean;
  stopped_reason: "loading" | "completed" | "limit_reached" | "empty_page";
  progress_percent: number | null;
}

function warehouseProgressPercent(rowsDownloaded: number, totalRowsExpected: number | null, sourceComplete: boolean): number | null {
  if (!totalRowsExpected || totalRowsExpected <= 0) return null;
  const percent = Math.floor((rowsDownloaded / totalRowsExpected) * 100);
  return sourceComplete ? Math.min(100, percent) : Math.min(99, percent);
}

export async function loadWarehouseTransactions(options: {
  limit?: number;
  offset?: number;
  pageSize?: number;
  totalRowsExpected?: number | null;
  onProgress?: (progress: WarehouseTransactionsLoadProgress) => void;
} = {}): Promise<Transaction[]> {
  return traceAsync("supabase.transactions_full_load", async () => {
    const client = ensureSupabase();
    const pageSize = options.pageSize ?? TRANSACTION_WAREHOUSE_SELECT_PAGE_SIZE;
    const offset = options.offset ?? 0;
    const startedAt = Date.now();
    const totalRowsExpected = options.totalRowsExpected ?? options.limit ?? null;
    const pagesExpected = totalRowsExpected ? Math.ceil(totalRowsExpected / pageSize) : null;
    const records: WarehouseLoadedRecord[] = [];
    let pageOffset = offset;
    let pages = 0;
    let rowsDownloaded = 0;
    let hasMore = true;
    const emit = (sourceComplete: boolean, stoppedReason: WarehouseTransactionsLoadProgress["stopped_reason"]) => {
      options.onProgress?.({
        total_rows_expected: totalRowsExpected,
        rows_downloaded: rowsDownloaded,
        rows_stored: sourceComplete ? records.length : 0,
        pages_loaded: pages,
        pages_expected: pagesExpected,
        current_page: pages,
        has_more: hasMore,
        duration_ms: Date.now() - startedAt,
        source_complete: sourceComplete,
        stopped_reason: stoppedReason,
        progress_percent: warehouseProgressPercent(rowsDownloaded, totalRowsExpected, sourceComplete),
      });
    };

    while (options.limit == null || records.length < options.limit) {
      const remaining = options.limit == null ? pageSize : Math.min(pageSize, options.limit - records.length);
      if (remaining <= 0) break;

      const { data, error } = await traceRequest(
        "supabase.transactions_page",
        `supabase:transactions:page:${pageOffset}:${remaining}`,
        () => client
          .from("transactions")
          .select("source,raw_payload,normalized_payload")
          .is("deleted_at", null)
          .order("event_time", { ascending: false })
          .range(pageOffset, pageOffset + remaining - 1),
        { table: "transactions", operation: "page", page_size: remaining },
      );
      if (error) throw new Error(`Could not load warehouse transactions: ${error.message}`);

      const sourceRows = (data ?? []) as WarehouseLoadedRecord[];
      const pageRows = ((data ?? []) as WarehouseLoadedRecord[])
        .filter((record) => Boolean(record.normalized_payload && typeof record.normalized_payload === "object"));

      records.push(...pageRows);
      pages += 1;
      rowsDownloaded += sourceRows.length;
      hasMore = sourceRows.length >= remaining;
      traceEvent("supabase.transactions_page_completed", { page_rows: pageRows.length, source_rows: sourceRows.length, pages, total_rows: records.length });
      emit(false, "loading");
      if (sourceRows.length < remaining) break;
      pageOffset += remaining;
    }

    hasMore = false;
    const hydrated = hydrateWarehouseTransactionsForAnalytics(records);
    traceEvent("warehouse.transactions_hydrated", { source_rows: records.length, hydrated_rows: hydrated.length });
    emit(true, options.limit != null && rowsDownloaded >= options.limit ? "limit_reached" : rowsDownloaded === 0 ? "empty_page" : "completed");
    return hydrated;
  }, { table: "transactions", limit: options.limit ?? "all", page_size: options.pageSize ?? TRANSACTION_WAREHOUSE_SELECT_PAGE_SIZE });
}

export function hydrateWarehouseTransactionsForAnalytics(records: WarehouseLoadedRecord[]): Transaction[] {
  const palmerRows: Transaction[] = [];
  const otherRows: Transaction[] = [];

  for (const record of records) {
    const payload = record.normalized_payload;
    if (!payload || typeof payload !== "object") continue;
    const payloadTx = payload as unknown as Transaction;
    const txWithRaw = {
      ...payloadTx,
      raw: {
        ...(payloadTx.raw ?? {}),
        ...(record.raw_payload ?? {}),
      },
    };
    const enrichedCardTx = backfillTransactionCardTypesFromRawRows(
      [txWithRaw],
      record.raw_payload ? [record.raw_payload] : [],
    )[0];
    const decline = declineDetailsForTransaction(enrichedCardTx);
    const tx = decline
      ? {
          ...enrichedCardTx,
          normalized_decline_reason: decline.reason,
          decline_message: decline.message,
        }
      : enrichedCardTx;
    if (record.source === "palmer_csv") {
      palmerRows.push(tx);
    } else {
      otherRows.push(tx);
    }
  }

  return [
    ...classifyUserTransactions(palmerRows),
    ...addCohortFields(otherRows),
  ].sort((a, b) => (a.event_time < b.event_time ? 1 : a.event_time > b.event_time ? -1 : a.transaction_id.localeCompare(b.transaction_id)));
}

export async function getWarehouseAggregationSummary(): Promise<{
  cashRevenue: number;
  cohortRevenue: number;
  activeSubscriptions: number;
  refunds: number;
}> {
  const txs = await loadWarehouseTransactions();
  const cashRevenue = txs
    .filter((tx) => tx.status !== "failed")
    .reduce((sum, tx) => sum + (tx.net_amount_usd ?? tx.amount_usd), 0);
  const cohortRevenue = txs
    .filter((tx) => Boolean(tx.cohort_id) && tx.status !== "failed")
    .reduce((sum, tx) => sum + (tx.net_amount_usd ?? tx.amount_usd), 0);
  const activeSubscriptions = new Set(
    txs
      .filter((tx) => tx.status === "success" && (tx.transaction_type === "first_subscription" || tx.transaction_type.startsWith("renewal")))
      .map((tx) => tx.user_id),
  ).size;
  const refunds = txs.reduce((sum, tx) => sum + (tx.refund_amount_usd ?? 0), 0);

  return {
    cashRevenue: Math.round(cashRevenue * 100) / 100,
    cohortRevenue: Math.round(cohortRevenue * 100) / 100,
    activeSubscriptions,
    refunds: Math.round(refunds * 100) / 100,
  };
}

export function sourceNameFromTrafficSource(source: TrafficSource): string | null {
  return source === "unknown" ? null : source;
}
