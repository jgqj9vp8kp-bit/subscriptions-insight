import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { MOCK_TRANSACTIONS } from "@/services/mockTransactions";
import type { Transaction } from "@/services/types";
import type { PalmerImportDiagnostics, RawPalmerRow } from "@/services/palmerTransform";
import type { SubscriptionClean } from "@/types/subscriptions";
import type { TrafficMetric } from "@/services/trafficImport";

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
  trafficMetrics: TrafficMetric[];
  trafficMeta: { importedAt: string | null; rowCount: number; source?: "facebook" };
  subscriptions: SubscriptionClean[];
  lastSubscriptionSyncAt: string | null;
  meta: ImportMeta;
  setImported: (
    rows: Transaction[],
    info: Omit<ImportMeta, "rowCount" | "importedAt" | "rawRowCount">,
    rawPalmerRows?: RawPalmerRow[]
  ) => void;
  setTrafficMetrics: (rows: TrafficMetric[]) => void;
  setSubscriptions: (rows: SubscriptionClean[]) => void;
  resetToMock: () => void;
}

const initialMeta: ImportMeta = {
  source: "mock",
  importedAt: null,
  rowCount: MOCK_TRANSACTIONS.length,
};

const safeLocalStorage = {
  getItem: (name: string) => localStorage.getItem(name),
  removeItem: (name: string) => localStorage.removeItem(name),
  setItem: (name: string, value: string) => {
    try {
      localStorage.setItem(name, value);
    } catch (error) {
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        console.warn("Could not persist analytics data because browser storage quota was exceeded.");
        return;
      }
      throw error;
    }
  },
};

export const useDataStore = create<DataState>()(
  persist(
    (set) => ({
      transactions: MOCK_TRANSACTIONS,
      rawPalmerRows: [],
      trafficMetrics: [],
      trafficMeta: { importedAt: null, rowCount: 0 },
      subscriptions: [],
      lastSubscriptionSyncAt: null,
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
      setTrafficMetrics: (rows) =>
        set({
          trafficMetrics: rows,
          trafficMeta: { importedAt: new Date().toISOString(), rowCount: rows.length, source: "facebook" },
        }),
      setSubscriptions: (rows) =>
        set({
          subscriptions: rows,
          lastSubscriptionSyncAt: new Date().toISOString(),
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
      storage: createJSONStorage(() => safeLocalStorage),
      partialize: (state) => ({
        lastSubscriptionSyncAt: state.lastSubscriptionSyncAt,
        trafficMeta: state.trafficMeta,
      }),
    }
  )
);
