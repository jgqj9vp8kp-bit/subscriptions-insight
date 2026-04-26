import { create } from "zustand";
import { persist } from "zustand/middleware";
import { MOCK_TRANSACTIONS } from "@/services/mockTransactions";
import type { Transaction } from "@/services/types";
import type { PalmerImportDiagnostics, RawPalmerRow } from "@/services/palmerTransform";

export type DataSource = "mock" | "csv" | "google_sheet" | "palmer_raw";
export type ImportMode = "clean_template" | "palmer_raw";

interface ImportMeta {
  source: DataSource;
  importMode?: ImportMode;
  importedAt: string | null;
  fileName?: string;
  sheetUrl?: string;
  rowCount: number;
  rawRowCount?: number;
  diagnostics?: PalmerImportDiagnostics;
}

interface DataState {
  transactions: Transaction[];
  rawPalmerRows: RawPalmerRow[];
  meta: ImportMeta;
  setImported: (
    rows: Transaction[],
    info: Omit<ImportMeta, "rowCount" | "importedAt" | "rawRowCount">,
    rawPalmerRows?: RawPalmerRow[]
  ) => void;
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
      rawPalmerRows: [],
      meta: initialMeta,
      setImported: (rows, info, rawPalmerRows = []) =>
        set({
          transactions: rows,
          rawPalmerRows,
          meta: {
            ...info,
            rowCount: rows.length,
            rawRowCount: rawPalmerRows.length || undefined,
            importedAt: new Date().toISOString(),
          },
        }),
      resetToMock: () =>
        set({
          transactions: MOCK_TRANSACTIONS,
          rawPalmerRows: [],
          meta: { ...initialMeta, importedAt: new Date().toISOString() },
        }),
    }),
    {
      name: "subs-analytics-data",
      version: 1,
    }
  )
);
