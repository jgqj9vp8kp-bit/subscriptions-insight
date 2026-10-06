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
import { registerPurgeHandler } from "@/services/sessionPurge";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors";

// Frontend bridge to Supabase Edge Functions. This module NEVER sees
// ClickHouse credentials — it only invokes authenticated Edge Functions.

const CLICKHOUSE_HEALTH_FUNCTION = "clickhouse-health";
const CLICKHOUSE_INIT_FUNCTION = "clickhouse-init";
const CLICKHOUSE_BACKFILL_FUNCTION = "clickhouse-backfill";
const CLICKHOUSE_VALIDATE_FUNCTION = "clickhouse-validate";
const CLICKHOUSE_SUMMARY_FUNCTION = "clickhouse-summary";
const CLICKHOUSE_COHORTS_FUNCTION = "clickhouse-cohorts";
const CLICKHOUSE_REVENUE_FUNCTION = "clickhouse-revenue";
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
  /** stopped_reason "already_running": when the other run's lease turns stale. */
  lease_retry_after?: string | null;
}

/** Toast line for a backfill result. "already_running" means another run holds
 * the server-side lease — it is still running, or it was killed and the lease
 * frees itself once stale — so say that, and when a retry can succeed, instead
 * of "inserted 0 rows". */
export function describeClickHouseBackfillResult(result: ClickHouseBackfillResult, locale = "en-US"): string {
  if (result.stopped_reason === "already_running") {
    const retryAt = result.lease_retry_after ? new Date(result.lease_retry_after) : null;
    const when = retryAt && !Number.isNaN(retryAt.getTime())
      ? ` Retry after ${retryAt.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })} if it was interrupted.`
      : " Retry in a few minutes if it was interrupted.";
    return `Another backfill run holds the lease (still running, or interrupted).${when}`;
  }
  return `${result.status}: inserted ${result.rows_inserted.toLocaleString(locale)} rows, stopped: ${result.stopped_reason}.`;
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
  /** True for the member view of clickhouse-summary (no raw access and no
   * admin.diagnostics.view): only lifecycle status, timestamps and opaque
   * version tokens are present — no KPIs, counts or error text. */
  redacted?: boolean;
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

// --- Typed Edge errors (plan §14 "Typed errors", §27 R12) -------------------
// A non-2xx Edge response becomes a ClickHouseRequestError carrying the HTTP
// status and the gate's error_code / request_id, so callers branch on the code
// instead of parsing prose. The message stays the exact text it always was
// ("ClickHouse Edge Function failed: <server error>"), so existing UI and tests
// keep working. A failure with no HTTP response at all (network, CORS) stays a
// plain Error.

/** error_code values of an access DENIAL: the request was refused because of who
 * is asking (session, membership, role, funnel scope), never because the
 * warehouse failed. Phase 2 adds 409 scope_snapshot_not_ready (the
 * funnel-scoped snapshot is being prepared: the page polls, never a sign-out,
 * never the breaker) and 403 funnel_out_of_scope (an explicit funnel key
 * outside the member's scope, R11). "not_found" (R11: out-of-scope entity ids
 * answer 404) and "escalation_denied" (admin API) are the plan's codes beyond
 * the gate's own list. */
const ACCESS_DENIAL_CODES: ReadonlySet<string> = new Set<string>([
  ACCESS_ERROR.INVALID_SESSION,
  ACCESS_ERROR.NO_MEMBERSHIP,
  ACCESS_ERROR.MEMBERSHIP_DISABLED,
  ACCESS_ERROR.PERMISSION_DENIED,
  ACCESS_ERROR.RAW_ACCESS_REQUIRED,
  ACCESS_ERROR.OWNER_REQUIRED,
  ACCESS_ERROR.FULL_SCOPE_REQUIRED,
  ACCESS_ERROR.SCOPE_NOT_SUPPORTED,
  ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY,
  ACCESS_ERROR.FUNNEL_OUT_OF_SCOPE,
  ACCESS_ERROR.POLICY_MISSING,
  ACCESS_ERROR.INVALID_CRON_SECRET,
  ACCESS_ERROR.TENANT_MISMATCH,
  ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED,
  "not_found",
  "escalation_denied",
]);

/** 503 codes the gate answers while resolving WHO is asking (auth service,
 * access resolver, missing workspace, missing config). Retry later — never a
 * sign-out, never a warehouse outage. */
export const ACCESS_SERVICE_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ACCESS_ERROR.AUTH_SERVICE_ERROR,
  ACCESS_ERROR.ACCESS_SERVICE_ERROR,
  ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED,
  ACCESS_ERROR.SERVER_NOT_CONFIGURED,
  ACCESS_ERROR.CRON_NOT_CONFIGURED,
]);

const ACCESS_ERROR_STATUSES: ReadonlySet<number> = new Set([401, 403, 404, 409]);

/** True for any access-layer error_code (a denial or an access-service 503). */
export function isAccessErrorCode(code: string | null | undefined): boolean {
  return typeof code === "string" && (ACCESS_DENIAL_CODES.has(code) || ACCESS_SERVICE_ERROR_CODES.has(code));
}

export class ClickHouseRequestError extends Error {
  /** HTTP status of the Edge response (always a non-2xx status). */
  readonly status: number;
  /** The gate's error_code, when the body carried one. */
  readonly errorCode: string | null;
  /** body.request_id, else the x-request-id response header. */
  readonly requestId: string | null;

  constructor(message: string, details: { status: number; errorCode?: string | null; requestId?: string | null }) {
    super(message);
    this.name = "ClickHouseRequestError";
    this.status = details.status;
    this.errorCode = details.errorCode ?? null;
    this.requestId = details.requestId ?? null;
  }
}

/** 401/403/404/409 with an access error_code: the server refused this principal.
 * Never retried, never a legacy fallback, never opens the breaker (R12). */
export function isAccessError(error: unknown): error is ClickHouseRequestError {
  return (
    error instanceof ClickHouseRequestError &&
    ACCESS_ERROR_STATUSES.has(error.status) &&
    typeof error.errorCode === "string" &&
    ACCESS_DENIAL_CODES.has(error.errorCode)
  );
}

/** 503 from the access layer (auth/access service, workspace not bootstrapped):
 * retry later through the access refresh, not per query. */
export function isAccessServiceError(error: unknown): error is ClickHouseRequestError {
  return (
    error instanceof ClickHouseRequestError &&
    error.status === 503 &&
    typeof error.errorCode === "string" &&
    ACCESS_SERVICE_ERROR_CODES.has(error.errorCode)
  );
}

interface EdgeFailure {
  message: string;
  /** null when no HTTP response arrived (network / CORS / relay without context). */
  status: number | null;
  errorCode: string | null;
  requestId: string | null;
}

function nonEmptyText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readStructuredText(text: string): Pick<EdgeFailure, "message" | "errorCode" | "requestId"> {
  if (!text) return { message: "Edge Function returned an empty error body.", errorCode: null, requestId: null };
  try {
    const payload = JSON.parse(text) as { error?: unknown; message?: unknown; error_code?: unknown; request_id?: unknown };
    return {
      message: String(payload.error ?? payload.message ?? text),
      errorCode: nonEmptyText(payload.error_code),
      requestId: nonEmptyText(payload.request_id),
    };
  } catch {
    return { message: text.slice(0, 500), errorCode: null, requestId: null };
  }
}

async function readFunctionFailure(error: unknown): Promise<EdgeFailure> {
  const context = (error as { context?: unknown })?.context;
  if (context instanceof Response) {
    const text = await context.clone().text().catch(() => "");
    const parsed = readStructuredText(text);
    return {
      ...parsed,
      status: context.status,
      requestId: parsed.requestId ?? nonEmptyText(context.headers.get("x-request-id")),
    };
  }
  return {
    message: error instanceof Error ? error.message : "ClickHouse Edge Function request failed.",
    status: null,
    errorCode: null,
    requestId: null,
  };
}

// --- ClickHouse circuit breaker (client-side) ------------------------------
// While the warehouse itself is down (e.g. the Cloud instance is stopped: TCP
// connects, TLS resets), every report request still costs a full edge
// round-trip in which the edge function retries ClickHouse with backoff before
// failing. On filter-heavy pages each filter change re-keys a query into that
// doomed round-trip, so the table sat in "Loading…" for tens of seconds before
// the legacy in-browser engine took over. The breaker remembers the last
// warehouse-down failure and fails REPORT reads instantly for a cooldown
// window — the legacy fallback then renders immediately from in-memory data.
// Maintenance calls (health/init/backfill/validation) are never gated: they
// must be able to probe the real state. Any successful edge response closes
// the breaker, so recovery is automatic once the warehouse is back.
// Only transport failures (no HTTP response) and 502/504 can open it: an access
// refusal (401/403/404/409) or an access-service 503 says nothing about the
// warehouse, so it must never push the owner onto the legacy engine (R12).
const CLICKHOUSE_BREAKER_COOLDOWN_MS = 45_000;
const BREAKER_HTTP_STATUSES: ReadonlySet<number> = new Set([502, 504]);
let clickHouseBreakerOpenUntil = 0;

export const CLICKHOUSE_UNAVAILABLE_MESSAGE =
  "ClickHouse warehouse is unavailable right now; reports fall back to the in-browser engine and will retry automatically.";

export function isClickHouseCircuitOpen(): boolean {
  return Date.now() < clickHouseBreakerOpenUntil;
}

/** Close the breaker (a request reached the warehouse, or state is stale). */
export function noteClickHouseReachable(): void {
  clickHouseBreakerOpenUntil = 0;
}

/** True for error texts whose shape means "the warehouse itself is
 * unreachable" (stopped instance, TLS reset, gateway timeouts) rather than a
 * query/auth/validation problem. Only these open the breaker. */
export function isWarehouseDownError(message: string): boolean {
  return /connection reset|connection refused|connection closed|econnreset|econnrefused|etimedout|timed out|timeout|tls|handshake|socket hang|network error|failed to fetch|fetch failed|unavailable|bad gateway|status 50[234]|50[234] /i.test(message);
}

/** Whether one failed Edge call may open the breaker: never for an access
 * error_code, never for an HTTP status other than 502/504, and otherwise only
 * when the message has the warehouse-down shape. `status` null = no HTTP
 * response (transport failure). */
export function shouldOpenClickHouseCircuit(failure: { status: number | null; errorCode?: string | null; message: string }): boolean {
  if (isAccessErrorCode(failure.errorCode)) return false;
  if (failure.status !== null && !BREAKER_HTTP_STATUSES.has(failure.status)) return false;
  return isWarehouseDownError(failure.message);
}

function openClickHouseCircuit(functionName: string, message: string): void {
  clickHouseBreakerOpenUntil = Date.now() + CLICKHOUSE_BREAKER_COOLDOWN_MS;
  traceEvent("clickhouse.circuit_opened", { edge_function: functionName, cooldown_ms: CLICKHOUSE_BREAKER_COOLDOWN_MS, message: message.slice(0, 200) });
}

async function clickHouseRequest<T>(
  functionName: string,
  body: Record<string, unknown> = {},
  options: { breakerGated?: boolean } = {},
): Promise<T> {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (options.breakerGated && isClickHouseCircuitOpen()) {
    throw new Error(CLICKHOUSE_UNAVAILABLE_MESSAGE);
  }
  const token = await sessionToken();
  const { data, error } = await traceRequest(`edge.${functionName}`, `edge:${functionName}:${JSON.stringify(body).length}`, () => supabase.functions.invoke(functionName, {
    body,
    headers: { Authorization: `Bearer ${token}` },
  }), {
    edge_function: functionName,
    request_bytes: JSON.stringify(body).length,
  });
  if (error) {
    const failure = await readFunctionFailure(error);
    if (shouldOpenClickHouseCircuit(failure)) openClickHouseCircuit(functionName, failure.message);
    const message = `ClickHouse Edge Function failed: ${failure.message}`;
    if (failure.status === null) throw new Error(message);
    if (failure.errorCode) traceEvent("clickhouse.edge_error", { edge_function: functionName, status: failure.status, error_code: failure.errorCode });
    throw new ClickHouseRequestError(message, failure as EdgeFailure & { status: number });
  }
  if (!data || typeof data !== "object") throw new Error("Invalid ClickHouse Edge Function response.");
  // Some endpoints report failures as 200 + {ok:false,error}: never treat those
  // as proof the warehouse is reachable, and open the breaker on a down-shaped
  // embedded error. The health endpoint also answers 200 while disconnected —
  // testClickHouseConnection closes the breaker only on connected=true.
  const embedded = (data as { ok?: unknown; error?: unknown }).ok === false ? String((data as { error?: unknown }).error ?? "") : null;
  if (embedded != null) {
    const embeddedCode = nonEmptyText((data as { error_code?: unknown }).error_code);
    if (!isAccessErrorCode(embeddedCode) && isWarehouseDownError(embedded)) openClickHouseCircuit(functionName, embedded);
  } else if (functionName !== CLICKHOUSE_HEALTH_FUNCTION) {
    noteClickHouseReachable();
  }
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
    const health = await clickHouseRequest<ClickHouseHealth>(CLICKHOUSE_HEALTH_FUNCTION);
    // The health endpoint answers 200 even while disconnected, so the breaker
    // is closed only on a positive probe — this is also the manual recovery
    // path (Integrations → Test connection) right after the warehouse resumes.
    if (health.connected) noteClickHouseReachable();
    return health;
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
      // The server's run lease is held by another backfill (it read and wrote
      // nothing): the same outcome as the sync_state probe above.
      if (result.stopped_reason === "already_running" && loop === 0) return skipped("already_running_server");
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

// Three independent cache hooks (cohorts warehouse version, support warehouse
// version, generic summary) all call this on app start, which cost three
// identical edge-function round-trips (~4.1 s summed, measured). Coalesce
// concurrent calls into one request and reuse a fresh result for a short TTL —
// version fingerprints cannot change faster than a sync anyway. Errors are
// never cached, so a failed probe retries immediately.
const SUMMARY_TTL_MS = 30_000;
let summaryCache: { at: number; value: ClickHouseSummary } | null = null;
let summaryInFlight: Promise<ClickHouseSummary> | null = null;
/** Bumped by the session purge: a summary requested for the previous principal
 * may still resolve, but it is never memoized for whoever is signed in now. */
let summaryGeneration = 0;

export async function getClickHouseSummary(): Promise<ClickHouseSummary> {
  if (summaryCache && Date.now() - summaryCache.at < SUMMARY_TTL_MS) return summaryCache.value;
  if (summaryInFlight) return summaryInFlight;
  const generation = summaryGeneration;
  const pending: Promise<ClickHouseSummary> = clickHouseRequest<ClickHouseSummary>(CLICKHOUSE_SUMMARY_FUNCTION, {}, { breakerGated: true })
    .then((value) => {
      if (generation === summaryGeneration) summaryCache = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      if (summaryInFlight === pending) summaryInFlight = null;
    });
  summaryInFlight = pending;
  return pending;
}

/** Drop the memoized summary so the next call refetches (post-sync refresh). */
export function invalidateClickHouseSummaryCache(): void {
  summaryCache = null;
}

/** Forget every module memo of this bridge: the summary (memo + in-flight) and
 * the breaker state. Both were observed by the previous principal / access
 * partition, so the session purge resets them (plan §20). */
export function resetClickHouseClientState(): void {
  summaryGeneration += 1;
  summaryCache = null;
  summaryInFlight = null;
  clickHouseBreakerOpenUntil = 0;
}

registerPurgeHandler("clickhouse-client-memos", resetClickHouseClientState);

// --- Revenue Intelligence read path (clickhouse-revenue Edge Function) -----

export async function runClickHouseRevenue<T extends import("../../supabase/functions/_shared/clickhouse/revenueIntelligenceContract").RevenueIntelligenceResponse>(
  request: import("../../supabase/functions/_shared/clickhouse/revenueIntelligenceContract").RevenueIntelligenceRequest,
): Promise<T> {
  return clickHouseRequest<T>(CLICKHOUSE_REVENUE_FUNCTION, request as Record<string, unknown>, { breakerGated: true });
}

// --- Cohorts read path (clickhouse-cohorts Edge Function) -----------------

export async function runClickHouseCohorts(request: CohortRequest): Promise<CohortResponse> {
  return clickHouseRequest<CohortResponse>(CLICKHOUSE_COHORTS_FUNCTION, request as Record<string, unknown>, { breakerGated: true });
}

export async function runClickHouseCohortDetails(request: CohortRequest): Promise<CohortDetailsResponse> {
  return clickHouseRequest<CohortDetailsResponse>(CLICKHOUSE_COHORTS_FUNCTION, request as Record<string, unknown>, { breakerGated: true });
}

export async function getClickHouseCohortMembershipStatus(): Promise<ClickHouseCohortMembershipResult> {
  return clickHouseRequest<ClickHouseCohortMembershipResult>(CLICKHOUSE_COHORT_MEMBERSHIP_FUNCTION, { action: "status" }, { breakerGated: true });
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
  return clickHouseRequest<UsersResponse>(CLICKHOUSE_USERS_FUNCTION, request as Record<string, unknown>, { breakerGated: true });
}

export async function runClickHouseUserDetails(request: UsersRequest): Promise<UsersDetailsResponse> {
  return clickHouseRequest<UsersDetailsResponse>(CLICKHOUSE_USERS_FUNCTION, request as Record<string, unknown>, { breakerGated: true });
}

export async function runClickHouseUsersDecline(request: UsersRequest): Promise<UsersDeclineResponse> {
  return clickHouseRequest<UsersDeclineResponse>(CLICKHOUSE_USERS_FUNCTION, request as Record<string, unknown>, { breakerGated: true });
}

// --- Payment Pass Analytics read path (clickhouse-payment-analytics) -------

export async function runClickHousePaymentAnalytics<T = unknown>(request: Record<string, unknown>): Promise<T> {
  return clickHouseRequest<T>(CLICKHOUSE_PAYMENT_ANALYTICS_FUNCTION, request, { breakerGated: true });
}

// Banks tab: same edge function, its own action — and the same circuit breaker,
// so a downed warehouse fails the tab instantly instead of hanging it.
export async function runClickHouseBankAnalytics<T = unknown>(request: Record<string, unknown>): Promise<T> {
  return clickHouseRequest<T>(CLICKHOUSE_PAYMENT_ANALYTICS_FUNCTION, request, { breakerGated: true });
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
  /** When this run started / finished — a stale verdict must be recognisable. */
  started_at?: string | null;
  completed_at?: string | null;
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
