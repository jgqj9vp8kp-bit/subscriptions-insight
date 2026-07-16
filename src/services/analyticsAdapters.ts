import { useDataStore } from "@/store/dataStore";
import {
  cleanupDuplicateImports,
  deleteImportBatch,
  getWarehouseTransactionCount,
  isTransactionWarehouseEnabled,
  loadWarehouseTransactions,
  rollbackImportBatch,
  type DuplicateCleanupResult,
  type ImportDeletionResult,
  type WarehouseTransactionsLoadProgress,
  type WarehouseManagementClient,
} from "@/services/transactionWarehouse";
import type { Transaction } from "@/services/types";
import { traceAsync, traceEvent, traceRequest } from "@/services/performanceTrace";

export type AnalyticsSource = "local_dataset" | "transaction_warehouse";

export interface AnalyticsDataset {
  source: AnalyticsSource;
  transactions: Transaction[];
}

export async function loadAnalyticsDataset(source: AnalyticsSource = "local_dataset"): Promise<AnalyticsDataset> {
  if (source === "transaction_warehouse") {
    if (!isTransactionWarehouseEnabled()) {
      throw new Error("Transaction warehouse is not available.");
    }
    return {
      source,
      transactions: await loadWarehouseTransactions(),
    };
  }

  return {
    source,
    transactions: useDataStore.getState().transactions,
  };
}

export async function refreshLocalAnalyticsCacheFromWarehouse(): Promise<Transaction[]> {
  const transactions = await traceAsync("warehouse.local_cache_refresh", async () => {
    const rows = await traceRequest(
      "warehouse.local_cache_refresh_query",
      "supabase:transactions:refresh_full_load",
      () => loadWarehouseTransactions(),
      { table: "transactions", source: "supabase" },
    );
    useDataStore.getState().setImported(rows, {
      source: "transaction_warehouse",
      importMode: "warehouse",
      fileName: "Supabase transaction warehouse",
    });
    return rows;
  });
  return transactions;
}

/**
 * Import-management orchestrators. Each performs the destructive warehouse operation and then
 * rebuilds the in-memory analytics store from the warehouse, so every page subscribed to the store
 * (Transactions / Users / Cohorts / Dashboard / FB / Payment) refreshes WITHOUT a page reload and
 * WITHOUT touching analytics calculations. `client` / `refresh` are injectable for tests.
 */
export interface ImportManagementOptions {
  client?: WarehouseManagementClient;
  refresh?: () => Promise<Transaction[]>;
}

export async function deleteImportBatchAndRefresh(
  batchId: string,
  options: ImportManagementOptions = {},
): Promise<{ result: ImportDeletionResult; transactions: number }> {
  const refresh = options.refresh ?? refreshLocalAnalyticsCacheFromWarehouse;
  const result = await deleteImportBatch(batchId, options.client);
  const transactions = await refresh();
  return { result, transactions: transactions.length };
}

export async function rollbackImportBatchAndRefresh(
  batchId: string,
  options: ImportManagementOptions = {},
): Promise<{ result: ImportDeletionResult; transactions: number }> {
  const refresh = options.refresh ?? refreshLocalAnalyticsCacheFromWarehouse;
  const result = await rollbackImportBatch(batchId, options.client);
  const transactions = await refresh();
  return { result, transactions: transactions.length };
}

export async function cleanupDuplicateImportsAndRefresh(
  options: ImportManagementOptions = {},
): Promise<{ result: DuplicateCleanupResult; transactions: number }> {
  const refresh = options.refresh ?? refreshLocalAnalyticsCacheFromWarehouse;
  const result = await cleanupDuplicateImports(options.client);
  const transactions = await refresh();
  return { result, transactions: transactions.length };
}

export type WarehouseAutoLoadStatus = "loaded" | "empty" | "disabled" | "skipped" | "error";

export interface WarehouseAutoLoadResult {
  status: WarehouseAutoLoadStatus;
  count: number;
  message: string;
  error?: string;
  progress?: LegacyWarehouseLoadProgress;
}

export interface WarehouseAutoLoadOptions {
  /**
   * Replace an already-loaded local/Palmer/CSV dataset with the warehouse.
   * Keep false for import flows that intentionally preview local files; use
   * true for production analytics pages where the warehouse is the source of truth.
   */
  replaceExisting?: boolean;
}

let warehouseAutoLoadInFlight: { promise: Promise<WarehouseAutoLoadResult>; replaceExisting: boolean } | null = null;

export type LegacyWarehouseLoadStatus = "idle" | "counting" | "loading" | "publishing" | "completed" | "failed" | "skipped" | "disabled" | "empty";

export interface LegacyWarehouseLoadProgress {
  status: LegacyWarehouseLoadStatus;
  total_rows_expected: number | null;
  rows_downloaded: number;
  rows_stored: number;
  pages_loaded: number;
  pages_expected: number | null;
  current_page: number;
  has_more: boolean;
  duration_ms: number;
  source_complete: boolean;
  stopped_reason: string | null;
  progress_percent: number | null;
  error?: string | null;
  updated_at: string;
}

const initialLegacyWarehouseLoadProgress: LegacyWarehouseLoadProgress = {
  status: "idle",
  total_rows_expected: null,
  rows_downloaded: 0,
  rows_stored: 0,
  pages_loaded: 0,
  pages_expected: null,
  current_page: 0,
  has_more: false,
  duration_ms: 0,
  source_complete: false,
  stopped_reason: null,
  progress_percent: null,
  error: null,
  updated_at: new Date(0).toISOString(),
};

let legacyWarehouseLoadProgress = initialLegacyWarehouseLoadProgress;
const legacyWarehouseProgressListeners = new Set<() => void>();

function setLegacyWarehouseLoadProgress(patch: Partial<LegacyWarehouseLoadProgress>): LegacyWarehouseLoadProgress {
  legacyWarehouseLoadProgress = {
    ...legacyWarehouseLoadProgress,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  legacyWarehouseProgressListeners.forEach((listener) => listener());
  return legacyWarehouseLoadProgress;
}

export function getLegacyWarehouseLoadProgress(): LegacyWarehouseLoadProgress {
  return legacyWarehouseLoadProgress;
}

export function subscribeLegacyWarehouseLoadProgress(listener: () => void): () => void {
  legacyWarehouseProgressListeners.add(listener);
  return () => legacyWarehouseProgressListeners.delete(listener);
}

function publishPageProgress(progress: WarehouseTransactionsLoadProgress): void {
  setLegacyWarehouseLoadProgress({
    status: progress.source_complete ? "publishing" : "loading",
    total_rows_expected: progress.total_rows_expected,
    rows_downloaded: progress.rows_downloaded,
    rows_stored: progress.rows_stored,
    pages_loaded: progress.pages_loaded,
    pages_expected: progress.pages_expected,
    current_page: progress.current_page,
    has_more: progress.has_more,
    duration_ms: progress.duration_ms,
    source_complete: false,
    stopped_reason: progress.stopped_reason,
    progress_percent: progress.progress_percent,
    error: null,
  });
}

/**
 * Auto-loads transactions from the Supabase transaction warehouse into the in-memory analytics
 * store on app startup (P0-2).
 *
 * Clean-template / Primer imports are persisted ONLY to the warehouse — they are not written to the
 * Palmer IndexedDB cache or the Palmer cloud snapshot, so without this the analytics store silently
 * reverts to MOCK_TRANSACTIONS after a refresh or on a new device. This hydrates the warehouse data
 * so real numbers survive a reload. By default it does not overwrite a dataset the user already
 * loaded; production analytics pages can opt into replacing stale local snapshots with the warehouse.
 *
 * Without that opt-in it is intentionally a no-op (status "skipped") when a non-mock dataset is
 * already present, so import flows do not clobber a freshly loaded local file.
 */
async function autoLoadWarehouseIntoStoreInner(options: WarehouseAutoLoadOptions = {}): Promise<WarehouseAutoLoadResult> {
  const startedAt = Date.now();
  if (!isTransactionWarehouseEnabled()) {
    const progress = setLegacyWarehouseLoadProgress({
      ...initialLegacyWarehouseLoadProgress,
      status: "disabled",
      stopped_reason: "warehouse_disabled",
      duration_ms: Date.now() - startedAt,
    });
    return { status: "disabled", count: 0, message: "Transaction warehouse is not configured.", progress };
  }
  const initialState = useDataStore.getState();
  const canReplaceExisting =
    options.replaceExisting === true && initialState.meta.source !== "transaction_warehouse";
  if (initialState.meta.source !== "mock" && !canReplaceExisting) {
    const progress = setLegacyWarehouseLoadProgress({
      status: "skipped",
      total_rows_expected: initialState.meta.source === "transaction_warehouse" ? initialState.meta.rowCount : null,
      rows_downloaded: initialState.meta.source === "transaction_warehouse" ? initialState.meta.rowCount : 0,
      rows_stored: initialState.meta.source === "transaction_warehouse" ? initialState.transactions.length : 0,
      pages_loaded: 0,
      pages_expected: null,
      current_page: 0,
      has_more: false,
      duration_ms: Date.now() - startedAt,
      source_complete: initialState.meta.source === "transaction_warehouse",
      stopped_reason: "dataset_already_loaded",
      progress_percent: initialState.meta.source === "transaction_warehouse" ? 100 : null,
      error: null,
    });
    return { status: "skipped", count: 0, message: "A dataset is already loaded.", progress };
  }

  try {
    setLegacyWarehouseLoadProgress({
      ...initialLegacyWarehouseLoadProgress,
      status: "counting",
      duration_ms: Date.now() - startedAt,
      stopped_reason: "counting",
      updated_at: new Date().toISOString(),
    });
    const count = await traceRequest(
      "warehouse.global_transaction_count",
      "supabase:transactions:count",
      () => getWarehouseTransactionCount(),
      { table: "transactions", blocks_render: false },
    );
    if (count <= 0) {
      const progress = setLegacyWarehouseLoadProgress({
        status: "empty",
        total_rows_expected: 0,
        rows_downloaded: 0,
        rows_stored: 0,
        pages_loaded: 0,
        pages_expected: 0,
        current_page: 0,
        has_more: false,
        duration_ms: Date.now() - startedAt,
        source_complete: true,
        stopped_reason: "empty_source",
        progress_percent: 100,
        error: null,
      });
      return { status: "empty", count: 0, message: "No warehouse data found", progress };
    }

    const transactions = await traceRequest(
      "warehouse.global_transactions_query",
      "supabase:transactions:full_load",
      () => loadWarehouseTransactions({ totalRowsExpected: count, onProgress: publishPageProgress }),
      { table: "transactions", blocks_render: false, source: "supabase" },
    );

    // Re-check after the (async) load so we never clobber a dataset that arrived in the meantime.
    const stateAfterFetch = useDataStore.getState();
    const canReplaceAfterFetch =
      options.replaceExisting === true && stateAfterFetch.meta.source !== "transaction_warehouse";
    if (stateAfterFetch.meta.source !== "mock" && !canReplaceAfterFetch) {
      const progress = setLegacyWarehouseLoadProgress({
        status: "skipped",
        total_rows_expected: count,
        rows_downloaded: count,
        rows_stored: 0,
        pages_loaded: legacyWarehouseLoadProgress.pages_loaded,
        pages_expected: legacyWarehouseLoadProgress.pages_expected,
        current_page: legacyWarehouseLoadProgress.current_page,
        has_more: false,
        duration_ms: Date.now() - startedAt,
        source_complete: false,
        stopped_reason: "dataset_loaded_during_fetch",
        progress_percent: null,
        error: null,
      });
      return { status: "skipped", count: transactions.length, message: "A dataset is already loaded.", progress };
    }
    if (!transactions.length) {
      const progress = setLegacyWarehouseLoadProgress({
        status: "empty",
        total_rows_expected: count,
        rows_downloaded: count,
        rows_stored: 0,
        pages_loaded: legacyWarehouseLoadProgress.pages_loaded,
        pages_expected: legacyWarehouseLoadProgress.pages_expected,
        current_page: legacyWarehouseLoadProgress.current_page,
        has_more: false,
        duration_ms: Date.now() - startedAt,
        source_complete: true,
        stopped_reason: "no_hydrated_rows",
        progress_percent: 100,
        error: null,
      });
      return { status: "empty", count: 0, message: "No warehouse data found", progress };
    }

    setLegacyWarehouseLoadProgress({
      status: "publishing",
      total_rows_expected: count,
      rows_downloaded: count,
      rows_stored: 0,
      has_more: false,
      duration_ms: Date.now() - startedAt,
      source_complete: false,
      stopped_reason: "publishing",
      progress_percent: Math.min(99, legacyWarehouseLoadProgress.progress_percent ?? 99),
      error: null,
    });
    useDataStore.getState().setImported(transactions, {
      source: "transaction_warehouse",
      importMode: "warehouse",
      fileName: "Supabase transaction warehouse",
    });
    const progress = setLegacyWarehouseLoadProgress({
      status: "completed",
      total_rows_expected: count,
      rows_downloaded: count,
      rows_stored: transactions.length,
      pages_loaded: legacyWarehouseLoadProgress.pages_loaded,
      pages_expected: legacyWarehouseLoadProgress.pages_expected,
      current_page: legacyWarehouseLoadProgress.current_page,
      has_more: false,
      duration_ms: Date.now() - startedAt,
      source_complete: transactions.length === count,
      stopped_reason: transactions.length === count ? "completed" : "hydrated_row_count_mismatch",
      progress_percent: transactions.length === count ? 100 : legacyWarehouseLoadProgress.progress_percent,
      error: null,
    });
    return {
      status: "loaded",
      count: transactions.length,
      message: `Loaded ${transactions.length} transactions from warehouse`,
      progress,
    };
  } catch (error) {
    // Surface the failure to the caller. Crucially we do NOT silently leave mock data looking real —
    // the store stays on source "mock", which keeps the "Sample data mode" banner visible.
    const message = error instanceof Error ? error.message : String(error);
    const progress = setLegacyWarehouseLoadProgress({
      status: "failed",
      has_more: false,
      duration_ms: Date.now() - startedAt,
      source_complete: false,
      stopped_reason: "failed",
      progress_percent: legacyWarehouseLoadProgress.progress_percent,
      error: message,
    });
    return {
      status: "error",
      count: 0,
      message: "Could not load transactions from warehouse",
      error: message,
      progress,
    };
  }
}

export async function autoLoadWarehouseIntoStore(): Promise<WarehouseAutoLoadResult> {
  return autoLoadWarehouseIntoStoreWithOptions();
}

export async function autoLoadWarehouseIntoStoreWithOptions(
  options: WarehouseAutoLoadOptions = {},
): Promise<WarehouseAutoLoadResult> {
  if (warehouseAutoLoadInFlight && (!options.replaceExisting || warehouseAutoLoadInFlight.replaceExisting)) {
    traceEvent("warehouse.global_hydration_deduped");
    return warehouseAutoLoadInFlight.promise;
  }
  if (warehouseAutoLoadInFlight && options.replaceExisting && !warehouseAutoLoadInFlight.replaceExisting) {
    await warehouseAutoLoadInFlight.promise.catch(() => undefined);
    if (useDataStore.getState().meta.source === "transaction_warehouse") {
      return {
        status: "skipped",
        count: useDataStore.getState().transactions.length,
        message: "Warehouse dataset is already loaded.",
        progress: getLegacyWarehouseLoadProgress(),
      };
    }
  }
  const promise = traceAsync(
    "warehouse.global_hydration",
    () => autoLoadWarehouseIntoStoreInner(options),
    { source: "supabase", replace_existing: options.replaceExisting === true },
  );
  warehouseAutoLoadInFlight = { promise, replaceExisting: options.replaceExisting === true };
  try {
    return await promise;
  } finally {
    if (warehouseAutoLoadInFlight?.promise === promise) {
      warehouseAutoLoadInFlight = null;
    }
  }
}
