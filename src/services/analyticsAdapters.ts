import { useDataStore } from "@/store/dataStore";
import {
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
