// FB Analytics warehouse read-path: typed bridge to the clickhouse-facebook
// Edge Function plus cache keys. The page consumes ONE atomic report bundle
// (summary + rows + charts + filter options + diagnostics from a single
// response) — no browser analytics, no Capsuled access, no token.

import { runClickHouseFacebook } from "@/services/clickhouse";
import { sortUniq } from "@/services/analyticsCache";
import type {
  FbChartPoint,
  FbDiagnostics,
  FbFilterOptions,
  FbLevel,
  FbListRow,
  FbReportResponse,
  FbSourceProbeResult,
  FbSyncResult,
} from "../../supabase/functions/_shared/clickhouse/facebookStats";

export type {
  FbChartPoint,
  FbDiagnostics,
  FbFilterOptions,
  FbLevel,
  FbListRow,
  FbReportResponse,
  FbSyncResult,
};

export const FB_ANALYTICS_QUERY_ROOT = "fb-analytics" as const;
export const FB_WAREHOUSE_VERSION_KEY = ["clickhouse", "fb-warehouse-version"] as const;

export interface FbReportQuery {
  level: FbLevel;
  date_from: string | null;
  date_to: string | null;
  buyer: string[];
  ad_account_id: string[];
  campaign_id: string[];
}

export interface NormalizedFbReportQuery {
  level: FbLevel;
  date_from: string | null;
  date_to: string | null;
  buyer: string[];
  ad_account_id: string[];
  campaign_id: string[];
}

export function normalizeFbReportQuery(query: FbReportQuery): NormalizedFbReportQuery {
  return {
    level: query.level,
    date_from: query.date_from || null,
    date_to: query.date_to || null,
    buyer: sortUniq(query.buyer),
    ad_account_id: sortUniq(query.ad_account_id),
    campaign_id: sortUniq(query.campaign_id),
  };
}

export function fbReportKey(parts: {
  userScopeHash: string;
  warehouseVersion: string;
  query: FbReportQuery;
}): [string, "report", string, string, NormalizedFbReportQuery] {
  return [FB_ANALYTICS_QUERY_ROOT, "report", parts.userScopeHash, parts.warehouseVersion, normalizeFbReportQuery(parts.query)];
}

// Non-reversible fingerprint of the FB warehouse state — changes after every
// successful sync, so report queries re-key and refetch exactly like Cohorts.
export function fbWarehouseVersionFromStatus(status: FbStatusResponse | null | undefined): string {
  const state = status?.state ?? null;
  const d = status?.diagnostics ?? null;
  const src = [
    state?.cursor_transaction_id ?? "",
    state?.cursor_updated_at ?? "",
    state?.finished_at ?? "",
    d?.warehouse_rows ?? "",
  ].join(":");
  if (!src.replace(/:/g, "")) return "fbwhv_unknown";
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i += 1) {
    h ^= src.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fbwhv_${(h >>> 0).toString(36)}`;
}

export interface FbSyncStateRow {
  status?: string | null;
  current_stage?: string | null;
  cursor_transaction_id?: string | null;
  cursor_updated_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  rows_scanned?: number | null;
  rows_mapped?: number | null;
  rows_inserted?: number | null;
  rows_skipped?: number | null;
  batches_processed?: number | null;
  source_total?: number | null;
  clickhouse_total?: number | null;
  last_error?: string | null;
  last_run_mode?: string | null;
  diagnostics?: Record<string, unknown> | null;
}

export interface FbStatusResponse {
  ok: boolean;
  state: FbSyncStateRow | null;
  diagnostics: FbDiagnostics;
  error?: string;
}

/**
 * Schema guard for persisted/cached report bundles. The report contract grew
 * (summary.blended, diagnostics.mapping) — a bundle rehydrated from an older
 * session must be REJECTED and refetched, never rendered (missing fields would
 * crash the KPI cards with a white screen).
 */
export function isCompleteFbReport(report: FbReportResponse | null | undefined): report is FbReportResponse {
  return Boolean(
    report &&
      report.ok &&
      Array.isArray(report.rows) &&
      Array.isArray(report.charts) &&
      report.filter_options &&
      report.diagnostics &&
      report.summary &&
      typeof report.summary.blended === "object" &&
      report.summary.blended != null,
  );
}

export async function loadFbReport(query: FbReportQuery): Promise<FbReportResponse> {
  const response = await runClickHouseFacebook<FbReportResponse & { error?: string }>({
    action: "report",
    level: query.level,
    filters: {
      date_from: query.date_from,
      date_to: query.date_to,
      buyer: query.buyer,
      ad_account_id: query.ad_account_id,
      campaign_id: query.campaign_id,
    },
  });
  if (!response.ok) throw new Error(response.error || "FB Analytics report failed.");
  return response;
}

export async function loadFbStatus(): Promise<FbStatusResponse> {
  const response = await runClickHouseFacebook<FbStatusResponse>({ action: "status" });
  if (!response.ok) throw new Error(response.error || "FB warehouse status failed.");
  return response;
}

export async function runFbSync(mode: "incremental" | "full", lastDays?: number): Promise<FbSyncResult & { ok: boolean; error?: string }> {
  return runClickHouseFacebook<FbSyncResult & { ok: boolean; error?: string }>({
    action: "sync",
    mode,
    ...(lastDays ? { last_days: lastDays } : {}),
  });
}

/** READ-ONLY source probe (Warehouse V2 Phase 2): asks Capsuled whether it can
 * still serve a window (defaults server-side to the audited 2026-05-08..06-14
 * gap). data_available → backfill via runFbBackfillWindow; empty → record a
 * known gap with this result as evidence. */
export async function probeFbSource(dateFrom?: string, dateTo?: string): Promise<FbSourceProbeResult & { ok: boolean; error?: string }> {
  return runClickHouseFacebook<FbSourceProbeResult & { ok: boolean; error?: string }>({
    action: "source_probe",
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
  });
}

/** Backfill a specific window into BOTH warehouses (V1 + V2 dual-write): the
 * existing full-mode sync honours explicit dates; trigger_source marks the runs
 * as backfills in the append-only history. */
export async function runFbBackfillWindow(dateFrom: string, dateTo: string): Promise<FbSyncResult & { ok: boolean; error?: string }> {
  return runClickHouseFacebook<FbSyncResult & { ok: boolean; error?: string }>({
    action: "sync",
    mode: "full",
    date_from: dateFrom,
    date_to: dateTo,
    trigger_source: "backfill",
  });
}
