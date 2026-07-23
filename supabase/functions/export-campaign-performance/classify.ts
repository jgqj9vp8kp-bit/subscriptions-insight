// Thin adapter over the SHARED transaction classifier — one definition of the
// lifecycle rules for the browser, the summary functions and this Export API.
//
// History: this file used to be a "dependency-free port" of
// classifyUserTransactions + addCohortFields. Ports drift: it never learned
// token_purchase, so web-app token packs kept counting as renewals in exports
// (TODO_MONETIZATION item 4). The compute core now lives in
// supabase/functions/_shared/clickhouse/, so the port is gone and the export
// re-derives transaction_type with exactly the in-app rules over each user's
// FULL history (the warehouse stores per-import-batch classification, which is
// why re-deriving here is mandatory).

import { addCohortFields, classifyUserTransactions } from "../_shared/clickhouse/palmerTransform.ts";
import type { Transaction } from "../_shared/clickhouse/serviceTypes.ts";

export interface ClassifiableTxn {
  user_id: string;
  transaction_id: string;
  event_time: string;
  status: string;
  transaction_type: string;
  amount_usd?: number;
  gross_amount_usd?: number;
  billing_reason?: string;
  classification_reason?: string;
  campaign_path?: string;
  funnel?: string;
  cohort_date?: string;
  cohort_id?: string;
  transaction_day?: number | null;
  /** Token-pack detection signals (known ids / name patterns / audited prices). */
  product?: string;
  currency?: string;
}

export function classifyWarehouseTransactions<T extends ClassifiableTxn & { source?: string | null }>(
  rows: T[],
): T[] {
  const palmerRows = rows.filter((row) => row.source === "palmer_csv");
  const otherRows = rows.filter((row) => row.source !== "palmer_csv");
  return [
    ...(classifyUserTransactions(palmerRows as unknown as Transaction[]) as unknown as T[]),
    ...(addCohortFields(otherRows as unknown as Transaction[]) as unknown as T[]),
  ];
}
