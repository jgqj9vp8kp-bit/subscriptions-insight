import { supabase } from "@/services/supabaseClient";
import { WAREHOUSE_ANALYTICS_INVALIDATED_EVENT } from "@/services/analyticsCache";
import type {
  CohortRequest,
  CohortResponse,
  CohortDetailsResponse,
} from "../../supabase/functions/_shared/clickhouse/cohortContract";
import type {
  UsersRequest,
  UsersResponse,
  UsersDeclineResponse,
  UsersDetailsResponse,
} from "../../supabase/functions/_shared/clickhouse/usersContract";
import type {
  SupportRequest,
  SupportResponse,
} from "../../supabase/functions/_shared/clickhouse/supportContract";
import { traceEvent, traceRequest } from "@/services/performanceTrace";

// Frontend bridge to Supabase Edge Functions. This module NEVER sees
// ClickHouse credentials — it only invokes authenticated Edge Functions.

const CLICKHOUSE_HEALTH_FUNCTION = "clickhouse-health";
const CLICKHOUSE_INIT_FUNCTION = "clickhouse-init";
const CLICKHOUSE_BACKFILL_FUNCTION = "clickhouse-backfill";
const CLICKHOUSE_VALIDATE_FUNCTION = "clickhouse-validate";
const CLICKHOUSE_SUMMARY_FUNCTION = "clickhouse-summary";
const CLICKHOUSE_COHORTS_FUNCTION = "clickhouse-cohorts";
const CLICKHOUSE_COHORT_MEMBERSHIP_FUNCTION = "clickhouse-cohort-membership";
const CLICKHOUSE_USERS_FUNCTION = "clickhouse-users";
const CLICKHOUSE_PAYMENT_ANALYTICS_FUNCTION = "clickhouse-payment-analytics";
const CLICKHOUSE_SUPPORT_FUNCTION = "clickhouse-support";
const CLICKHOUSE_FACEBOOK_FUNCTION = "clickhouse-facebook";

export interface ClickHouseHealth {
  connected: boolean;
  configured?: boolean;
  host_configured?: boolean;
  password_configured?: boolean;
  database?: string;
  username?: string;
  feature_flags?: {
    useClickHouseAnalytics: boolean;
    clickHouseDualWrite: boolean;
  };
  result?: number | null;
  latency_ms?: number;
  error?: string;
}

export interface ClickHouseInitResult {
  connected: boolean;
  database: string;
  table_created_or_exists: boolean;
  columns_count: number;
  engine: string;
  partition_key: string;
  order_key: string;
  current_row_count: number;
  duration_ms: number;
}

export interface ClickHouseBackfillRequest {
  mode?: "continue" | "full_backfill" | "validate_only";
  batch_size?: number;
  max_batches?: number;
  dry_run?: boolean;
  full_reset_cursor?: boolean;
}

export interface ClickHouseBackfillResult {
  mode: string;
  dry_run: boolean;
  status: string;
  stopped_reason: string;
  current_stage: string;
  batch_size: number;
  max_batches: number;
  rows_scanned: number;
  rows_mapped: number;
  rows_inserted: number;
  rows_skipped: number;
  batches_processed: number;
  cursor_updated_at: string | null;
  cursor_transaction_id: string | null;
  source_total: number;
  clickhouse_total: number;
  diagnostics?: Record<string, unknown>;
  duration_ms: number;
}

export interface ClickHouseSyncState {
  status?: string;
  current_stage?: string | null;
  stopped_reason?: string | null;
  cursor_updated_at?: string | null;
  cursor_transaction_id?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  rows_scanned?: number;
  rows_mapped?: number;
  rows_inserted?: number;
  rows_skipped?: number;
  batches_processed?: number;
  last_error?: string | null;
  last_run_mode?: string | null;
  source_total?: number | null;
  clickhouse_total?: number | null;
  parity_status?: string | null;
  diagnostics?: Record<string, unknown> | null;
  updated_at?: string | null;
}

export interface ClickHouseSummary {
  connected?: boolean;
  transaction_count?: number;
  unique_users?: number;
  successful_payments?: number;
  failed_payments?: number;
  trials?: number;
  first_subscriptions?: number;
  gross_revenue_usd?: number;
  net_revenue_usd?: number;
  refunds_usd?: number;
  date_range?: { from: string | null; to: string | null };
  query_duration_ms?: number;
  benchmark?: {
    source_duration_ms: number;
    clickhouse_duration_ms: number;
  };
  sync_state?: ClickHouseSyncState | null;
  cohort_snapshot_state?: ClickHouseCohortSnapshotState | null;
  support_sync_state?: ClickHouseSyncState | null;
  error?: string;
}

export interface ClickHouseValidationMetric {
  metric: string;
  source_value: unknown;
  clickhouse_value: unknown;
  absolute_difference: number;
  percentage_difference: number;
  status: "PASS" | "FAIL";
}

export interface ClickHouseValidationResult {
  status: "PASS" | "FAIL";
  validation_scope?: "full_dataset" | "imported_cursor_range";
  cursor_range?: {
    cursor_updated_at: string;
    cursor_transaction_id: string;
  } | null;
  revenue_tolerance_usd: number;
  source: Record<string, unknown>;
  clickhouse: Record<string, unknown>;
  metrics: ClickHouseValidationMetric[];
  reconciliation: {
    missing_in_clickhouse: string[];
    extra_in_clickhouse: string[];
    duplicate_transaction_ids: Array<{ transaction_id: string; count: number }>;
    checked_limit: number;
  };
  duration_ms: number;
}

export interface ClickHouseCohortSnapshotState {
  status?: "never_started" | "building" | "completed" | "failed";
  active_warehouse_version?: string | null;
  active_classification_version?: string | null;
  active_generated_at?: string | null;
  building_warehouse_version?: string | null;
  building_classification_version?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  duration_ms?: number | null;
  users_classified?: number;
  rows_inserted?: number;
  duplicate_users?: number;
  removed_or_invalidated?: number;
  source_transactions?: number | null;
  source_unique_users?: number | null;
  last_error?: string | null;
  diagnostics?: Record<string, unknown> | null;
}

export interface ClickHouseCohortMembershipResult {
  ok: boolean;
  action: "status" | "rebuild" | "validate";
  state?: ClickHouseCohortSnapshotState | null;
  status?: string;
  warehouse_version?: string | null;
  classification_version?: string | null;
  generated_at?: string;
  users_classified?: number;
  rows_inserted?: number;
  inserted_users?: number;
  updated_users?: number;
  unchanged_users?: number;
  removed_or_invalidated?: number;
  duplicate_users?: number;
  source_transactions?: number;
  source_unique_users?: number;
  dynamic_users?: number;
  materialized_users?: number;
  missing_users?: number;
  extra_users?: number;
  field_mismatches?: Record<string, number>;
  duration_ms?: number;
  error?: string;
}

/** Human-readable status label for the Integrations card. */
export function clickHouseStatusLabel(health: ClickHouseHealth | null): "Connected" | "Not connected" | "Not configured" | "Unknown" {
  if (!health) return "Unknown";
  if (health.connected) return "Connected";
  if (health.configured === false) return "Not configured";
  return "Not connected";
}

async function sessionToken(): Promise<string> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before using ClickHouse warehouse actions.");
  return token;
}

async function readStructuredText(text: string): Promise<string> {
  if (!text) return "Edge Function returned an empty error body.";
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown };
    return String(payload.error ?? payload.message ?? text);
  } catch {
    return text.slice(0, 500);
  }
}

async function readFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    const text = await context.clone().text().catch(() => "");
    return readStructuredText(text);
  }
  return error instanceof Error ? error.message : "ClickHouse Edge Function request failed.";
}

async function clickHouseRequest<T>(functionName: string, body: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const token = await sessionToken();
  const { data, error } = await traceRequest(`edge.${functionName}`, `edge:${functionName}:${JSON.stringify(body).length}`, () => supabase.functions.invoke(functionName, {
    body,
    headers: { Authorization: `Bearer ${token}` },
  }), {
    edge_function: functionName,
    request_bytes: JSON.stringify(body).length,
  });
  if (error) {
    const message = await readFunctionError(error);
    throw new Error(`ClickHouse Edge Function failed: ${message}`);
  }
  if (!data || typeof data !== "object") throw new Error("Invalid ClickHouse Edge Function response.");
  traceEvent(`edge.${functionName}.response`, {
    edge_function: functionName,
    response_bytes: JSON.stringify(data).length,
  });
  return data as T;
}

/**
 * Test the ClickHouse connection through the server. Requires an authenticated
 * Subengine session (the endpoint verifies the Supabase bearer token). Returns
 * a `connected` flag rather than throwing on a warehouse outage, so the UI can
 * render "Not connected" with the server-provided error message.
 */
export async function testClickHouseConnection(): Promise<ClickHouseHealth> {
  try {
    return await clickHouseRequest<ClickHouseHealth>(CLICKHOUSE_HEALTH_FUNCTION);
  } catch (error) {
    return { connected: false, error: error instanceof Error ? error.message : "Could not reach the ClickHouse health endpoint." };
  }
}

export async function initializeClickHouseSchema(): Promise<ClickHouseInitResult> {
  return clickHouseRequest<ClickHouseInitResult>(CLICKHOUSE_INIT_FUNCTION);
}

// Single-flight guard shared by the manual "Continue Backfill" button and the
// automatic post-import sync, so two incremental backfills never overlap in
// this browser tab. Manual runs always proceed (fallback); the auto sync defers
// to whatever is already running (see autoSyncClickHouseAfterImport).
let backfillInFlight: Promise<ClickHouseBackfillResult> | null = null;
let autoSyncActive = false;

/** True while any backfill (manual or automatic) is executing in this tab. */
export function isClickHouseBackfillInFlight(): boolean {
  return backfillInFlight !== null || autoSyncActive;
}

export async function runClickHouseBackfill(request: ClickHouseBackfillRequest): Promise<ClickHouseBackfillResult> {
  const promise = clickHouseRequest<ClickHouseBackfillResult>(CLICKHOUSE_BACKFILL_FUNCTION, request as Record<string, unknown>);
  backfillInFlight = promise;
  try {
    return await promise;
  } finally {
    if (backfillInFlight === promise) backfillInFlight = null;
  }
}

// --- Automatic post-import ClickHouse synchronization --------------------
// After a successful CSV import commits to Supabase, newly imported rows are
// synced into ClickHouse WITHOUT the user clicking "Continue Backfill". This
// reuses the EXACT same code path (runClickHouseBackfill with mode:"continue")
// — there is only one incremental-sync implementation. The pipeline is
// cursor-based and idempotent (ReplacingMergeTree), so re-running never
// duplicates rows or moves the cursor backwards.

export type AutoSyncSkipReason = "already_running_client" | "already_running_server";

export interface AutoSyncResult {
  triggered: boolean;
  skipped: boolean;
  skipReason?: AutoSyncSkipReason;
  status?: string;
  stopped_reason?: string;
  rows_inserted: number;
  rows_scanned: number;
  batches_processed: number;
  clickhouse_total?: number;
  cursor_transaction_id?: string | null;
  duration_ms: number;
  last?: ClickHouseBackfillResult;
}

// Same request the "Continue Backfill" button sends (Integrations.tsx).
const AUTO_SYNC_CONTINUE_REQUEST: ClickHouseBackfillRequest = {
  mode: "continue",
  batch_size: 2000,
  max_batches: 10,
  dry_run: false,
  full_reset_cursor: false,
};
// Safety ceiling on the catch-up loop (each pass covers up to
// max_batches * batch_size = 20k rows → up to 1M rows before yielding).
const AUTO_SYNC_MAX_LOOPS = 50;

function triggerCohortMembershipRebuildAfterSync(last: ClickHouseBackfillResult | undefined): void {
  if (!last) return;
  const completed =
    last.stopped_reason === "completed" ||
    last.status === "completed" ||
    last.status === "completed_with_inconsistencies";
  if (!completed) return;
  void rebuildClickHouseCohortMembership(false)
    .then((result) => {
      traceEvent("clickhouse.cohort_membership_rebuild_completed", {
        status: result.status ?? "unknown",
        users_classified: result.users_classified ?? 0,
        duration_ms: result.duration_ms ?? 0,
      });
    })
    .catch((error) => {
      traceEvent("clickhouse.cohort_membership_rebuild_failed", {
        error_class: error instanceof Error ? error.name : typeof error,
      });
    });
}

/**
 * Trigger the incremental ClickHouse sync after a committed CSV import.
 *
 * Concurrency (STEP 4): if a sync is already running — either in this tab
 * (single-flight guard) or server-side (sync_state.status === "running", read
 * from the existing warehouse state) — this SKIPS instead of starting a second
 * backfill. Otherwise it loops the same "continue" call until the source is
 * fully caught up (status "completed"), the run fails, or no progress is made.
 *
 * Never throws for a sync failure: the caller's import stays successful and the
 * manual "Continue Backfill" button remains available as a fallback.
 */
export async function autoSyncClickHouseAfterImport(): Promise<AutoSyncResult> {
  const startedAt = Date.now();
  const skipped = (skipReason: AutoSyncSkipReason): AutoSyncResult => ({
    triggered: false,
    skipped: true,
    skipReason,
    rows_inserted: 0,
    rows_scanned: 0,
    batches_processed: 0,
    duration_ms: Date.now() - startedAt,
  });

  if (isClickHouseBackfillInFlight()) return skipped("already_running_client");

  // Reuse the existing warehouse state: don't start a second sync while the
  // server reports one running (e.g. a manual backfill from another session).
  try {
    const summary = await getClickHouseSummary();
    if (summary?.sync_state?.status === "running") return skipped("already_running_server");
  } catch {
    // State unreadable — proceed. The import already committed and the pipeline
    // is idempotent; worst case the manual button is still available.
  }

  autoSyncActive = true;
  let rowsInserted = 0;
  let rowsScanned = 0;
  let batchesProcessed = 0;
  let last: ClickHouseBackfillResult | undefined;
  try {
    for (let loop = 0; loop < AUTO_SYNC_MAX_LOOPS; loop += 1) {
      const result = await runClickHouseBackfill(AUTO_SYNC_CONTINUE_REQUEST);
      last = result;
      rowsInserted += result.rows_inserted;
      rowsScanned += result.rows_scanned;
      batchesProcessed += result.batches_processed;
      // Fully caught up with the source.
      if (
        result.stopped_reason === "completed" ||
        result.status === "completed" ||
        result.status === "completed_with_inconsistencies"
      ) {
        break;
      }
      // Failed — stop and leave the manual Continue Backfill as the fallback.
      if (result.status === "failed") break;
      // No forward progress this pass — avoid an infinite loop.
      if (result.batches_processed === 0) break;
    }
    triggerCohortMembershipRebuildAfterSync(last);
    return {
      triggered: true,
      skipped: false,
      status: last?.status,
      stopped_reason: last?.stopped_reason,
      rows_inserted: rowsInserted,
      rows_scanned: rowsScanned,
      batches_processed: batchesProcessed,
      clickhouse_total: last?.clickhouse_total,
      cursor_transaction_id: last?.cursor_transaction_id ?? null,
      duration_ms: Date.now() - startedAt,
      last,
    };
  } finally {
    autoSyncActive = false;
  }
}

export async function validateClickHouseTransactions(validationScope: "full_dataset" | "imported_cursor_range" = "imported_cursor_range"): Promise<ClickHouseValidationResult> {
  return clickHouseRequest<ClickHouseValidationResult>(CLICKHOUSE_VALIDATE_FUNCTION, {
    batch_size: 2000,
    reconciliation_limit: 5000,
    validation_scope: validationScope,
  });
}

export async function getClickHouseSummary(): Promise<ClickHouseSummary> {
  return clickHouseRequest<ClickHouseSummary>(CLICKHOUSE_SUMMARY_FUNCTION);
}

// --- Cohorts read path (clickhouse-cohorts Edge Function) -----------------

export async function runClickHouseCohorts(request: CohortRequest): Promise<CohortResponse> {
  return clickHouseRequest<CohortResponse>(CLICKHOUSE_COHORTS_FUNCTION, request as Record<string, unknown>);
}

export async function runClickHouseCohortDetails(request: CohortRequest): Promise<CohortDetailsResponse> {
  return clickHouseRequest<CohortDetailsResponse>(CLICKHOUSE_COHORTS_FUNCTION, request as Record<string, unknown>);
}

export async function getClickHouseCohortMembershipStatus(): Promise<ClickHouseCohortMembershipResult> {
  return clickHouseRequest<ClickHouseCohortMembershipResult>(CLICKHOUSE_COHORT_MEMBERSHIP_FUNCTION, { action: "status" });
}

export async function rebuildClickHouseCohortMembership(force = false): Promise<ClickHouseCohortMembershipResult> {
  const result = await clickHouseRequest<ClickHouseCohortMembershipResult>(CLICKHOUSE_COHORT_MEMBERSHIP_FUNCTION, { action: "rebuild", force });
  if (result.status === "completed" && typeof window !== "undefined") {
    window.dispatchEvent(new Event(WAREHOUSE_ANALYTICS_INVALIDATED_EVENT));
  }
  return result;
}

export async function validateClickHouseCohortMembership(): Promise<ClickHouseCohortMembershipResult> {
  return clickHouseRequest<ClickHouseCohortMembershipResult>(CLICKHOUSE_COHORT_MEMBERSHIP_FUNCTION, { action: "validate" });
}

// --- Users / Payment Analytics read path (clickhouse-users) ---------------

export async function runClickHouseUsers(request: UsersRequest): Promise<UsersResponse> {
  return clickHouseRequest<UsersResponse>(CLICKHOUSE_USERS_FUNCTION, request as Record<string, unknown>);
}

export async function runClickHouseUserDetails(request: UsersRequest): Promise<UsersDetailsResponse> {
  return clickHouseRequest<UsersDetailsResponse>(CLICKHOUSE_USERS_FUNCTION, request as Record<string, unknown>);
}

export async function runClickHouseUsersDecline(request: UsersRequest): Promise<UsersDeclineResponse> {
  return clickHouseRequest<UsersDeclineResponse>(CLICKHOUSE_USERS_FUNCTION, request as Record<string, unknown>);
}

// --- Payment Pass Analytics read path (clickhouse-payment-analytics) -------

export async function runClickHousePaymentAnalytics<T = unknown>(request: Record<string, unknown>): Promise<T> {
  return clickHouseRequest<T>(CLICKHOUSE_PAYMENT_ANALYTICS_FUNCTION, request);
}

// --- Support Analytics read path + sync (clickhouse-support) --------------

// --- FB Analytics warehouse (clickhouse-facebook Edge Function) ------------
// Generic bridge: contract types live in fbWarehouse.ts (shared with the Edge
// module). The Capsuled token never appears here — sync runs server-side.

export async function runClickHouseFacebook<T>(request: Record<string, unknown>): Promise<T> {
  return clickHouseRequest<T>(CLICKHOUSE_FACEBOOK_FUNCTION, request);
}

export async function runClickHouseSupport<T extends SupportResponse = SupportResponse>(request: SupportRequest): Promise<T> {
  return clickHouseRequest<T>(CLICKHOUSE_SUPPORT_FUNCTION, request as Record<string, unknown>);
}

// --- Resumable, staged validation ---------------------------------------

export type ClickHouseValidationAction = "start" | "continue" | "status" | "reset";
export type ClickHouseValidationStage = "initialize" | "source_scan" | "finalize" | "done";
export type ClickHouseValidationRunStatus = "never_started" | "running" | "partial" | "completed" | "failed";

export interface ClickHouseValidationCursor {
  updated_at: string | null;
  transaction_id: string | null;
}

export interface ClickHouseValidationDiagnostics {
  rows_this_invocation: number;
  pages_this_invocation: number;
  estimated_payload_bytes: number;
  mapping_ms: number;
  db_read_ms: number;
  state_write_ms: number;
  peak_page_rows: number;
  peak_currency_keys: number;
  peak_funnel_keys: number;
  peak_transaction_type_keys: number;
}

export interface ClickHouseValidationProgress {
  action: ClickHouseValidationAction;
  validation_name: string;
  status: ClickHouseValidationRunStatus;
  stage: ClickHouseValidationStage | null;
  stopped_reason: string | null;
  validation_scope: "full_dataset" | "imported_cursor_range" | null;
  rows_processed: number;
  source_rows_expected: number | null;
  progress_percent: number;
  pages_processed: number;
  source_id_chunk_count: number;
  current_cursor: ClickHouseValidationCursor | null;
  upper_cursor: ClickHouseValidationCursor | null;
  source_rows: number | null;
  clickhouse_rows: number | null;
  missing_ids: number | null;
  extra_ids: number | null;
  duplicate_ids: number | null;
  gross_difference: number | null;
  net_difference: number | null;
  refund_difference: number | null;
  parity_status: string | null;
  source: AggregateLike | null;
  clickhouse: AggregateLike | null;
  duration_ms: number;
  completed: boolean;
  diagnostics: ClickHouseValidationDiagnostics | null;
}

type AggregateLike = Record<string, unknown>;

export interface ClickHouseValidationRequest {
  action: ClickHouseValidationAction;
  validation_scope?: "full_dataset" | "imported_cursor_range";
  page_size?: number;
  max_pages?: number;
}

export async function runClickHouseValidation(request: ClickHouseValidationRequest): Promise<ClickHouseValidationProgress> {
  return clickHouseRequest<ClickHouseValidationProgress>(CLICKHOUSE_VALIDATE_FUNCTION, request as Record<string, unknown>);
}
