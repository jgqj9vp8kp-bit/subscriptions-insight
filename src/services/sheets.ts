/**
 * Sheets data service.
 *
 * The app reads transactions from the in-memory data store, which is hydrated
 * either from bundled mock data, an uploaded CSV file, or a public Google
 * Sheet imported by the user from the /import page.
 *
 * Components prefer the `useTransactions` hook (reactive). `getTransactions`
 * is kept as an async helper for non-component callers.
 */
import { useDataStore } from "@/store/dataStore";
import type { Transaction } from "./types";

export async function getTransactions(): Promise<Transaction[]> {
  return useDataStore.getState().transactions;
}

export function useTransactions(): Transaction[] {
  return useDataStore((s) => s.transactions);
}

export type { Transaction } from "./types";