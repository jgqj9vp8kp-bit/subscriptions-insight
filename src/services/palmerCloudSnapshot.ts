import { computeCohorts, computeUsers } from "@/services/analytics";
import type { RawPalmerRow } from "@/services/palmerTransform";
import type { Transaction } from "@/services/types";

export type PalmerCloudPayload = {
  payload_version: 1;
  transactions: Transaction[];
  rawPalmerRows?: RawPalmerRow[];
};

export type PalmerCloudMetadata = {
  file_name: string;
  imported_at: string;
  rows_count: number;
  transactions_count: number;
  users_count: number;
  cohorts_count: number;
  source: "palmer_import";
};

export function buildPalmerCloudPayload(
  transactions: Transaction[],
  rawPalmerRows?: RawPalmerRow[],
): PalmerCloudPayload {
  return {
    payload_version: 1,
    transactions,
    rawPalmerRows,
  };
}

export function buildPalmerCloudMetadata({
  transactions,
  rawPalmerRows,
  fileName = "Palmer import",
  importedAt = new Date().toISOString(),
}: {
  transactions: Transaction[];
  rawPalmerRows?: RawPalmerRow[];
  fileName?: string;
  importedAt?: string;
}): PalmerCloudMetadata {
  return {
    file_name: fileName,
    imported_at: importedAt,
    rows_count: rawPalmerRows?.length ?? transactions.length,
    transactions_count: transactions.length,
    users_count: computeUsers(transactions).length,
    cohorts_count: computeCohorts(transactions).length,
    source: "palmer_import",
  };
}

export function normalizePalmerCloudPayload(value: unknown): PalmerCloudPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!Array.isArray(source.transactions)) return null;

  return {
    payload_version: 1,
    transactions: source.transactions as Transaction[],
    rawPalmerRows: Array.isArray(source.rawPalmerRows) ? (source.rawPalmerRows as RawPalmerRow[]) : undefined,
  };
}
