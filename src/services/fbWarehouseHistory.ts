// Facebook Warehouse V2 — Phase 1: read-only bridge to the append-only import
// history (sync runs, import batches, warehouse versions, raw payloads, DQ).
// Observability ONLY: nothing in Cohorts / allocation / FB Analytics metrics
// consumes this module — it exists so the history can be inspected.

import { runClickHouseFacebook } from "@/services/clickhouse";

export interface FbSyncRunRecord {
  run_id: string;
  started_at: string;
  finished_at: string;
  status: "completed" | "failed";
  trigger_source: "manual" | "cron" | "backfill" | "migration";
  mode: "incremental" | "full";
  window_from: string | null;
  window_to: string | null;
  levels: string[];
  api_requests: number;
  api_failures: number;
  rows_received: number;
  rows_inserted: number;
  rows_updated: number;
  rows_skipped: number;
  duration_ms: number | null;
  error_message: string | null;
  raw_response_metadata: Record<string, unknown>;
  warehouse_version: string;
  batch_id: string | null;
  created_at: string;
}

export interface FbImportBatchRecord {
  batch_id: string;
  run_id: string;
  status: "staged" | "validated" | "published" | "rolled_back";
  source: string;
  notes: string | null;
  version: string;
  checksum: string | null;
  created_at: string;
  validated_at: string | null;
  published_at: string | null;
  rolled_back_at: string | null;
}

export type FbWarehouseVersionRecord = Pick<
  FbImportBatchRecord,
  "version" | "status" | "batch_id" | "run_id" | "checksum" | "created_at" | "validated_at" | "published_at" | "rolled_back_at"
>;

export interface FbRawPayloadMeta {
  payload_id: string;
  batch_id: string;
  entity_level: "account" | "campaign" | "adset" | "ad" | "day";
  page: number;
  request_date_from: string | null;
  request_date_to: string | null;
  http_ok: boolean;
  payload_bytes: number;
  api_latency_ms: number;
  received_at: string;
}

export interface FbRawPayloadFull extends FbRawPayloadMeta {
  payload_json: unknown;
}

export interface FbBatchDqRecord {
  dq_id: string;
  batch_id: string;
  run_id: string;
  campaign_count: number;
  account_count: number;
  expected_days: number;
  covered_days: number;
  coverage_pct: number | null;
  duplicate_keys: number;
  duplicate_key_samples: string[];
  missing_dates: string[];
  spend_total: number;
  purchases_total: number;
  spend_by_level: Record<string, number>;
  computed_at: string;
}

type HistoryResponse<K extends string, T> = { ok: boolean; error?: string } & { [key in K]: T };

async function history<K extends string, T>(key: K, request: Record<string, unknown>): Promise<T> {
  const response = await runClickHouseFacebook<HistoryResponse<K, T>>(request);
  if (!response.ok) throw new Error(response.error || "Facebook history read failed.");
  return response[key];
}

export function loadFbSyncRuns(opts: { limit?: number; status?: "completed" | "failed" } = {}): Promise<FbSyncRunRecord[]> {
  return history("runs", { action: "history_runs", ...opts });
}

export function loadFbImportBatches(
  opts: { limit?: number; run_id?: string; status?: FbImportBatchRecord["status"] } = {},
): Promise<FbImportBatchRecord[]> {
  return history("batches", { action: "history_batches", ...opts });
}

export function loadFbWarehouseVersions(opts: { limit?: number } = {}): Promise<FbWarehouseVersionRecord[]> {
  return history("versions", { action: "history_versions", ...opts });
}

/** Metadata list for a batch (payload bodies excluded — they can be megabytes). */
export function loadFbRawPayloadList(batchId: string, opts: { limit?: number } = {}): Promise<FbRawPayloadMeta[]> {
  return history("payloads", { action: "history_raw_payloads", batch_id: batchId, ...opts });
}

/** One verbatim Capsuled payload by id. */
export function loadFbRawPayload(payloadId: string): Promise<FbRawPayloadFull | null> {
  return history("payloads", { action: "history_raw_payloads", payload_id: payloadId });
}

export function loadFbBatchDq(batchId: string): Promise<FbBatchDqRecord | null> {
  return history("dq", { action: "history_dq", batch_id: batchId });
}
