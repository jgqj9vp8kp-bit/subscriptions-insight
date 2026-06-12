import { useDataStore } from "@/store/dataStore";
import {
  getWarehouseTransactionCount,
  isTransactionWarehouseEnabled,
  loadWarehouseTransactions,
} from "@/services/transactionWarehouse";
import type { Transaction } from "@/services/types";

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
  const transactions = await loadWarehouseTransactions();
  useDataStore.getState().setImported(transactions, {
    source: "transaction_warehouse",
    importMode: "warehouse",
    fileName: "Supabase transaction warehouse",
  });
  return transactions;
}

export type WarehouseAutoLoadStatus = "loaded" | "empty" | "disabled" | "skipped" | "error";

export interface WarehouseAutoLoadResult {
  status: WarehouseAutoLoadStatus;
  count: number;
  message: string;
  error?: string;
}

/**
 * Auto-loads transactions from the Supabase transaction warehouse into the in-memory analytics
 * store on app startup (P0-2).
 *
 * Clean-template / Primer imports are persisted ONLY to the warehouse — they are not written to the
 * Palmer IndexedDB cache or the Palmer cloud snapshot, so without this the analytics store silently
 * reverts to MOCK_TRANSACTIONS after a refresh or on a new device. This hydrates the warehouse data
 * so real numbers survive a reload, and it never overwrites a dataset the user already loaded.
 *
 * It is intentionally a no-op (status "skipped") when a non-mock dataset is already present, so it
 * does not clobber a freshly imported Palmer dataset or a still-loading restore.
 */
export async function autoLoadWarehouseIntoStore(): Promise<WarehouseAutoLoadResult> {
  if (!isTransactionWarehouseEnabled()) {
    return { status: "disabled", count: 0, message: "Transaction warehouse is not configured." };
  }
  if (useDataStore.getState().meta.source !== "mock") {
    return { status: "skipped", count: 0, message: "A dataset is already loaded." };
  }

  try {
    const count = await getWarehouseTransactionCount();
    if (count <= 0) {
      return { status: "empty", count: 0, message: "No warehouse data found" };
    }

    const transactions = await loadWarehouseTransactions();

    // Re-check after the (async) load so we never clobber a dataset that arrived in the meantime.
    if (useDataStore.getState().meta.source !== "mock") {
      return { status: "skipped", count: transactions.length, message: "A dataset is already loaded." };
    }
    if (!transactions.length) {
      return { status: "empty", count: 0, message: "No warehouse data found" };
    }

    useDataStore.getState().setImported(transactions, {
      source: "transaction_warehouse",
      importMode: "warehouse",
      fileName: "Supabase transaction warehouse",
    });
    return {
      status: "loaded",
      count: transactions.length,
      message: `Loaded ${transactions.length} transactions from warehouse`,
    };
  } catch (error) {
    // Surface the failure to the caller. Crucially we do NOT silently leave mock data looking real —
    // the store stays on source "mock", which keeps the "Sample data mode" banner visible.
    return {
      status: "error",
      count: 0,
      message: "Could not load transactions from warehouse",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
