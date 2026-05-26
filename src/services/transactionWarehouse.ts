import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { supabase } from "@/services/supabaseClient";
import { addCohortFields } from "@/services/palmerTransform";
import type { TrafficSource, Transaction } from "@/services/types";

export const USE_TRANSACTION_WAREHOUSE = publicRuntimeConfig.useTransactionWarehouse;
export const TRANSACTION_WAREHOUSE_CHUNK_SIZE = 1000;
export const TRANSACTION_WAREHOUSE_SELECT_PAGE_SIZE = 1000;

export type ImportBatchStatus = "processing" | "completed" | "failed";

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

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function checksumRows(rows: Record<string, unknown>[]): Promise<string> {
  return sha256Hex(canonicalStringify(rows));
}

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
  return {
    async fetchExisting(transactionIds) {
      if (!transactionIds.length) return [];
      const { data, error } = await client
        .from("transactions")
        .select("transaction_id,event_time,normalized_payload")
        .in("transaction_id", transactionIds)
        .is("deleted_at", null);
      if (error) throw new Error(`Could not inspect existing transactions: ${error.message}`);
      return (data ?? []) as ExistingWarehouseRecord[];
    },
    async upsertTransactions(records) {
      if (!records.length) return;
      const authUserId = await currentUserId();
      const payload = records.map((record) => ({
        ...record,
        auth_user_id: authUserId,
      }));
      const { error } = await client
        .from("transactions")
        .upsert(payload, { onConflict: "transaction_id" });
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

export async function getWarehouseTransactionCount(): Promise<number> {
  const client = ensureSupabase();
  const { count, error } = await client
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null);
  if (error) throw new Error(`Could not count warehouse transactions: ${error.message}`);
  return count ?? 0;
}

export async function loadWarehouseTransactions(options: { limit?: number; offset?: number; pageSize?: number } = {}): Promise<Transaction[]> {
  const client = ensureSupabase();
  const pageSize = options.pageSize ?? TRANSACTION_WAREHOUSE_SELECT_PAGE_SIZE;
  const offset = options.offset ?? 0;
  const rows: Transaction[] = [];
  let pageOffset = offset;

  while (options.limit == null || rows.length < options.limit) {
    const remaining = options.limit == null ? pageSize : Math.min(pageSize, options.limit - rows.length);
    if (remaining <= 0) break;

    const { data, error } = await client
      .from("transactions")
      .select("normalized_payload")
      .is("deleted_at", null)
      .order("event_time", { ascending: false })
      .range(pageOffset, pageOffset + remaining - 1);
    if (error) throw new Error(`Could not load warehouse transactions: ${error.message}`);

    const pageRows = (data ?? [])
      .map((record) => record.normalized_payload)
      .filter((payload): payload is Transaction => Boolean(payload && typeof payload === "object"));

    rows.push(...pageRows);
    if (pageRows.length < remaining) break;
    pageOffset += remaining;
  }

  return addCohortFields(rows);
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
