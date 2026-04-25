import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MOCK_TRANSACTIONS } from "@/services/mockTransactions";
import type { Transaction } from "@/services/types";

export type DataSource = "mock" | "csv" | "google_sheet";

interface ImportMeta {
  source: DataSource;
  importedAt: string | null;
  fileName?: string;
  sheetUrl?: string;
  rowCount: number;
}

interface DataState {
  transactions: Transaction[];
  meta: ImportMeta;
  setImported: (rows: Transaction[], info: Omit<ImportMeta, "rowCount" | "importedAt">) => void;
  resetToMock: () => void;
}

const initialMeta: ImportMeta = {
  source: "mock",
  importedAt: null,
  rowCount: MOCK_TRANSACTIONS.length,
};

export const useDataStore = create<DataState>()(
  persist(
    (set) => ({
      transactions: MOCK_TRANSACTIONS,
      meta: initialMeta,
      setImported: (rows, info) =>
        set({
          transactions: rows,
          meta: {
            ...info,
            rowCount: rows.length,
            importedAt: new Date().toISOString(),
          },
        }),
      resetToMock: () =>
        set({
          transactions: MOCK_TRANSACTIONS,
          meta: { ...initialMeta, importedAt: new Date().toISOString() },
        }),
    }),
    {
      name: "subs-analytics-data",
      version: 1,
    }
  )
);