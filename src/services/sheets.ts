/**
 * Sheets data service.
 *
 * This is the single seam between the app and the Google Sheets data source.
 * Today it returns mock rows. To switch to a live Google Sheet later, replace
 * the body of these functions with a `fetch` against the Sheets API and map
 * the returned rows to the same `Transaction` shape — every caller stays the same.
 */
import { MOCK_TRANSACTIONS } from "./mockTransactions";
import type { Transaction } from "./types";

function delay<T>(value: T, ms = 0): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

export async function getTransactions(): Promise<Transaction[]> {
  return delay(MOCK_TRANSACTIONS);
}

export type { Transaction } from "./types";