import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import {
  ANALYTICS_TRANSACTIONS_TABLE,
  ANALYTICS_VALIDATION_SOURCE_IDS_TABLE,
  CREATE_VALIDATION_SOURCE_IDS_SQL,
} from "./schema.ts";
import {
  buildTransactionMappingContext,
  hydrateSupabaseTransactionRows,
  mapSupabaseTransactionsToClickHouse,
} from "./transactionMapper.ts";
import {
  addRow,
  buildMetrics,
  clickHouseCursorWhereClause,
  clickHouseSnapshot,
  emptySnapshot,
  importedCursorRange,
  readSourceBatch,
  round6,
  type AggregateSnapshot,
  type ValidationCursorRange,
  type ValidationScope,
} from "./validation.ts";

// ---------------------------------------------------------------------------
// Resumable, staged, bounded-memory ClickHouse validation.
//
// One Edge invocation processes only a few small source pages, streams their
// transaction ids into a temporary ClickHouse table, folds their mapped rows
// into a persisted running aggregate, and saves the compound cursor. Repeated
// invocations resume from that cursor until the frozen upper bound is reached,
// then a cheap finalize stage compares aggregates and reconciles id sets with
// server-side SQL. Nothing here changes the mapper, backfill, schema of
// analytics_transactions, or any analytics — it only reorganises *when* the
// existing validation work runs so it fits inside the Edge compute budget.
// ---------------------------------------------------------------------------

export type ValidationAction = "start" | "continue" | "status" | "reset";
export type ValidationStageName = "initialize" | "source_scan" | "finalize" | "done";
export type ValidationRunStatus = "never_started" | "running" | "partial" | "completed" | "failed";
export type ValidationStoppedReason =
  | "chunk_complete"
  | "soft_timeout"
  | "max_pages_reached"
  | "source_error"
  | "clickhouse_error"
  | "completed"
  | "unknown";

export const VALIDATION_NAME = "analytics_transactions_validation";
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 500;
const MIN_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 3;
const MAX_MAX_PAGES = 20;
const DEFAULT_SOFT_TIMEOUT_MS = 10_000;
const VALIDATION_VERSION = 1;

export interface ValidationCursor {
  updated_at: string | null;
  transaction_id: string | null;
}

export interface ValidationChunkDiagnostics {
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

export interface ValidationResponse {
  action: ValidationAction;
  validation_name: string;
  status: ValidationRunStatus;
  stage: ValidationStageName | null;
  stopped_reason: ValidationStoppedReason | null;
  validation_scope: ValidationScope | null;
  rows_processed: number;
  source_rows_expected: number | null;
  progress_percent: number;
  pages_processed: number;
  source_id_chunk_count: number;
  current_cursor: ValidationCursor | null;
  upper_cursor: ValidationCursor | null;
  source_rows: number | null;
  clickhouse_rows: number | null;
  missing_ids: number | null;
  extra_ids: number | null;
  duplicate_ids: number | null;
  gross_difference: number | null;
  net_difference: number | null;
  refund_difference: number | null;
  parity_status: string | null;
  source: AggregateSnapshot | null;
  clickhouse: AggregateSnapshot | null;
  duration_ms: number;
  completed: boolean;
  diagnostics: ValidationChunkDiagnostics | null;
}

interface ValidationStateRow {
  auth_user_id: string;
  validation_name: string;
  status: ValidationRunStatus;
  stage: ValidationStageName | null;
  validation_scope: ValidationScope | null;
  validation_run: string | null;
  lower_cursor_updated_at: string | null;
  lower_cursor_transaction_id: string | null;
  upper_cursor_updated_at: string | null;
  upper_cursor_transaction_id: string | null;
  current_cursor_updated_at: string | null;
  current_cursor_transaction_id: string | null;
  rows_processed: number;
  pages_processed: number;
  source_rows_expected: number | null;
  source_aggregates: AggregateSnapshot;
  source_id_chunk_count: number;
  clickhouse_aggregates: AggregateSnapshot | null;
  missing_ids_count: number | null;
  extra_ids_count: number | null;
  duplicate_ids_count: number | null;
  gross_difference: number | null;
  net_difference: number | null;
  refund_difference: number | null;
  parity_status: string | null;
  started_at: string | null;
  completed_at: string | null;
  stopped_reason: ValidationStoppedReason | null;
  last_error: string | null;
  version: number;
}

export interface RunValidationInput {
  action: ValidationAction;
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  validationScope?: ValidationScope;
  pageSize?: number;
  maxPages?: number;
  softTimeoutMs?: number;
  now?: () => number;
  makeRunId?: () => string;
  nowIso?: () => string;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cursorOrNull(updatedAt: string | null, transactionId: string | null): ValidationCursor | null {
  if (!updatedAt && !transactionId) return null;
  return { updated_at: updatedAt, transaction_id: transactionId };
}

function rangeFromState(state: ValidationStateRow): ValidationCursorRange | null {
  if (state.validation_scope !== "imported_cursor_range") return null;
  if (!state.upper_cursor_updated_at || !state.upper_cursor_transaction_id) return null;
  return {
    cursor_updated_at: state.upper_cursor_updated_at,
    cursor_transaction_id: state.upper_cursor_transaction_id,
  };
}

async function loadState(supabase: SupabaseLikeClient, authUserId: string): Promise<ValidationStateRow | null> {
  const { data, error } = await supabase
    .from("clickhouse_validation_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("validation_name", VALIDATION_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not load ClickHouse validation state: ${error.message}`);
  if (!data) return null;
  const row = data as Record<string, unknown>;
  return {
    auth_user_id: authUserId,
    validation_name: VALIDATION_NAME,
    status: (row.status as ValidationRunStatus) ?? "never_started",
    stage: (row.stage as ValidationStageName | null) ?? null,
    validation_scope: (row.validation_scope as ValidationScope | null) ?? null,
    validation_run: (row.validation_run as string | null) ?? null,
    lower_cursor_updated_at: (row.lower_cursor_updated_at as string | null) ?? null,
    lower_cursor_transaction_id: (row.lower_cursor_transaction_id as string | null) ?? null,
    upper_cursor_updated_at: (row.upper_cursor_updated_at as string | null) ?? null,
    upper_cursor_transaction_id: (row.upper_cursor_transaction_id as string | null) ?? null,
    current_cursor_updated_at: (row.current_cursor_updated_at as string | null) ?? null,
    current_cursor_transaction_id: (row.current_cursor_transaction_id as string | null) ?? null,
    rows_processed: num(row.rows_processed),
    pages_processed: num(row.pages_processed),
    source_rows_expected: numOrNull(row.source_rows_expected),
    source_aggregates: (row.source_aggregates as AggregateSnapshot) ?? emptySnapshot(),
    source_id_chunk_count: num(row.source_id_chunk_count),
    clickhouse_aggregates: (row.clickhouse_aggregates as AggregateSnapshot | null) ?? null,
    missing_ids_count: numOrNull(row.missing_ids_count),
    extra_ids_count: numOrNull(row.extra_ids_count),
    duplicate_ids_count: numOrNull(row.duplicate_ids_count),
    gross_difference: numOrNull(row.gross_difference),
    net_difference: numOrNull(row.net_difference),
    refund_difference: numOrNull(row.refund_difference),
    parity_status: (row.parity_status as string | null) ?? null,
    started_at: (row.started_at as string | null) ?? null,
    completed_at: (row.completed_at as string | null) ?? null,
    stopped_reason: (row.stopped_reason as ValidationStoppedReason | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    version: num(row.version) || VALIDATION_VERSION,
  };
}

async function saveState(supabase: SupabaseLikeClient, state: ValidationStateRow): Promise<void> {
  const { error } = await supabase
    .from("clickhouse_validation_state")
    .upsert(
      {
        auth_user_id: state.auth_user_id,
        validation_name: state.validation_name,
        status: state.status,
        stage: state.stage,
        validation_scope: state.validation_scope,
        validation_run: state.validation_run,
        lower_cursor_updated_at: state.lower_cursor_updated_at,
        lower_cursor_transaction_id: state.lower_cursor_transaction_id,
        upper_cursor_updated_at: state.upper_cursor_updated_at,
        upper_cursor_transaction_id: state.upper_cursor_transaction_id,
        current_cursor_updated_at: state.current_cursor_updated_at,
        current_cursor_transaction_id: state.current_cursor_transaction_id,
        rows_processed: state.rows_processed,
        pages_processed: state.pages_processed,
        source_rows_expected: state.source_rows_expected,
        source_aggregates: state.source_aggregates,
        source_id_chunk_count: state.source_id_chunk_count,
        clickhouse_aggregates: state.clickhouse_aggregates,
        missing_ids_count: state.missing_ids_count,
        extra_ids_count: state.extra_ids_count,
        duplicate_ids_count: state.duplicate_ids_count,
        gross_difference: state.gross_difference,
        net_difference: state.net_difference,
        refund_difference: state.refund_difference,
        parity_status: state.parity_status,
        started_at: state.started_at,
        completed_at: state.completed_at,
        stopped_reason: state.stopped_reason,
        last_error: state.last_error,
        version: state.version,
      },
      { onConflict: "auth_user_id,validation_name" },
    );
  if (error) throw new Error(`Could not persist ClickHouse validation state: ${error.message}`);
}

async function deleteState(supabase: SupabaseLikeClient, authUserId: string): Promise<void> {
  const builder = supabase.from("clickhouse_validation_state") as unknown as {
    delete?: () => { eq: (c: string, v: unknown) => { eq: (c: string, v: unknown) => Promise<{ error?: { message: string } | null }> } };
  };
  if (typeof builder.delete === "function") {
    const { error } = await builder.delete().eq("auth_user_id", authUserId).eq("validation_name", VALIDATION_NAME);
    if (error) throw new Error(`Could not reset ClickHouse validation state: ${error.message}`);
    return;
  }
  // Fallback: neutralise the row in place when a delete builder is unavailable.
  await saveState(supabase, freshState(authUserId, "full_dataset", null));
}

async function chScalar(
  client: ClickHouseClientLike,
  query: string,
  params: Record<string, unknown>,
): Promise<number> {
  const resultSet = await client.query({ query, query_params: params, format: "JSONEachRow" });
  const rows = (await resultSet.json()) as Array<Record<string, unknown>>;
  const first = rows[0];
  if (!first) return 0;
  const value = Object.values(first)[0];
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function clickHouseDuplicateCount(
  client: ClickHouseClientLike,
  authUserId: string,
  cursor: ValidationCursorRange | null,
): Promise<number> {
  const cursorClause = clickHouseCursorWhereClause(cursor);
  const params: Record<string, unknown> = { auth_user_id: authUserId };
  if (cursor) {
    params.cursor_updated_at = cursor.cursor_updated_at;
    params.cursor_transaction_id = cursor.cursor_transaction_id;
  }
  return chScalar(
    client,
    `
      SELECT count() AS c FROM (
        SELECT transaction_id
        FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
        WHERE auth_user_id = {auth_user_id:String}
        ${cursorClause}
        GROUP BY transaction_id
        HAVING count() > 1
      )
    `,
    params,
  );
}

async function sourceRowsExpected(
  supabase: SupabaseLikeClient,
  authUserId: string,
  cursor: ValidationCursorRange | null,
): Promise<number | null> {
  let query = supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("auth_user_id", authUserId)
    .is("deleted_at", null);
  if (cursor) {
    query = query.or(
      `updated_at.lt.${cursor.cursor_updated_at},and(updated_at.eq.${cursor.cursor_updated_at},transaction_id.lte.${cursor.cursor_transaction_id})`,
    );
  }
  const { count, error } = await query;
  if (error) throw new Error(`Could not count source transactions: ${error.message}`);
  return count ?? null;
}

function freshState(authUserId: string, scope: ValidationScope, cursor: ValidationCursorRange | null): ValidationStateRow {
  return {
    auth_user_id: authUserId,
    validation_name: VALIDATION_NAME,
    status: "never_started",
    stage: null,
    validation_scope: scope,
    validation_run: null,
    lower_cursor_updated_at: null,
    lower_cursor_transaction_id: null,
    upper_cursor_updated_at: cursor?.cursor_updated_at ?? null,
    upper_cursor_transaction_id: cursor?.cursor_transaction_id ?? null,
    current_cursor_updated_at: null,
    current_cursor_transaction_id: null,
    rows_processed: 0,
    pages_processed: 0,
    source_rows_expected: null,
    source_aggregates: emptySnapshot(),
    source_id_chunk_count: 0,
    clickhouse_aggregates: null,
    missing_ids_count: null,
    extra_ids_count: null,
    duplicate_ids_count: null,
    gross_difference: null,
    net_difference: null,
    refund_difference: null,
    parity_status: null,
    started_at: null,
    completed_at: null,
    stopped_reason: null,
    last_error: null,
    version: VALIDATION_VERSION,
  };
}

// Stage 1: initialize — freeze bounds, query ClickHouse aggregates once, reset progress.
async function initialize(input: RunValidationInput, scope: ValidationScope, nowIso: () => string, makeRunId: () => string): Promise<ValidationStateRow> {
  const cursor = scope === "imported_cursor_range"
    ? await importedCursorRange(input.supabase, input.authUserId)
    : null;
  if (scope === "imported_cursor_range" && !cursor) {
    throw new Error("Imported cursor range validation requires a saved ClickHouse backfill cursor.");
  }
  await input.clickhouse.command({ query: CREATE_VALIDATION_SOURCE_IDS_SQL });
  const clickhouse = await clickHouseSnapshot(input.clickhouse, input.authUserId, cursor);
  const duplicates = await clickHouseDuplicateCount(input.clickhouse, input.authUserId, cursor);
  const expected = await sourceRowsExpected(input.supabase, input.authUserId, cursor);

  const state: ValidationStateRow = {
    ...freshState(input.authUserId, scope, cursor),
    status: "partial",
    stage: "source_scan",
    validation_run: makeRunId(),
    source_rows_expected: expected,
    source_aggregates: emptySnapshot(),
    clickhouse_aggregates: clickhouse,
    duplicate_ids_count: duplicates,
    started_at: nowIso(),
    stopped_reason: "chunk_complete",
  };
  await saveState(input.supabase, state);
  return state;
}

// Stage 2: source_scan — process a bounded number of small pages this invocation.
async function processChunk(
  input: RunValidationInput,
  state: ValidationStateRow,
  pageSize: number,
  maxPages: number,
  softTimeoutMs: number,
  now: () => number,
): Promise<{ state: ValidationStateRow; reachedEnd: boolean; diagnostics: ValidationChunkDiagnostics }> {
  const upper = rangeFromState(state);
  let currentUpdatedAt = state.current_cursor_updated_at;
  let currentTransactionId = state.current_cursor_transaction_id;
  const snapshot: AggregateSnapshot = state.source_aggregates;

  let pagesThis = 0;
  let rowsThis = 0;
  let payloadBytes = 0;
  let mappingMs = 0;
  let dbReadMs = 0;
  let peakPageRows = 0;
  let reachedEnd = false;
  let stopped: ValidationStoppedReason = "chunk_complete";

  const startedAt = now();
  for (let page = 0; page < maxPages; page += 1) {
    if (now() - startedAt > softTimeoutMs) {
      stopped = "soft_timeout";
      break;
    }
    const readStart = now();
    const rows = await readSourceBatch({
      supabase: input.supabase,
      authUserId: input.authUserId,
      batchSize: pageSize,
      cursorUpdatedAt: currentUpdatedAt,
      cursorTransactionId: currentTransactionId,
      upperCursor: upper,
    });
    dbReadMs += now() - readStart;

    if (!rows.length) {
      reachedEnd = true;
      stopped = "completed";
      break;
    }
    peakPageRows = Math.max(peakPageRows, rows.length);

    const mapStart = now();
    const context = buildTransactionMappingContext(hydrateSupabaseTransactionRows(rows));
    const mapped = mapSupabaseTransactionsToClickHouse({ authUserId: input.authUserId, rows, context });
    for (const row of mapped.rows) addRow(snapshot, row);
    mappingMs += now() - mapStart;

    const idRows = mapped.rows.map((row) => ({
      auth_user_id: input.authUserId,
      validation_run: state.validation_run ?? "",
      transaction_id: row.transaction_id,
      user_id: row.user_id,
    }));
    if (idRows.length) {
      await input.clickhouse.insert({
        table: ANALYTICS_VALIDATION_SOURCE_IDS_TABLE,
        values: idRows,
        format: "JSONEachRow",
      });
    }

    for (const row of rows) {
      payloadBytes += typeof row.normalized_payload === "object" && row.normalized_payload
        ? JSON.stringify(row.normalized_payload).length
        : 0;
    }

    const last = rows[rows.length - 1];
    currentUpdatedAt = last?.updated_at ?? null;
    currentTransactionId = last?.transaction_id ?? null;
    rowsThis += rows.length;
    pagesThis += 1;

    if (!currentUpdatedAt || !currentTransactionId) {
      reachedEnd = true;
      stopped = "completed";
      break;
    }
    // page smaller than the requested size means the range is exhausted (page
    // size is kept below the PostgREST max-rows cap, so a short page is real).
    if (rows.length < pageSize) {
      reachedEnd = true;
      stopped = "completed";
      break;
    }
  }

  if (!reachedEnd && stopped === "chunk_complete" && pagesThis >= maxPages) {
    stopped = "max_pages_reached";
  }

  const nextState: ValidationStateRow = {
    ...state,
    status: "partial",
    stage: reachedEnd ? "finalize" : "source_scan",
    current_cursor_updated_at: currentUpdatedAt,
    current_cursor_transaction_id: currentTransactionId,
    rows_processed: state.rows_processed + rowsThis,
    pages_processed: state.pages_processed + pagesThis,
    source_id_chunk_count: state.source_id_chunk_count + pagesThis,
    source_aggregates: snapshot,
    stopped_reason: stopped,
  };
  const writeStart = now();
  await saveState(input.supabase, nextState);
  const stateWriteMs = now() - writeStart;

  const diagnostics: ValidationChunkDiagnostics = {
    rows_this_invocation: rowsThis,
    pages_this_invocation: pagesThis,
    estimated_payload_bytes: payloadBytes,
    mapping_ms: Math.round(mappingMs),
    db_read_ms: Math.round(dbReadMs),
    state_write_ms: Math.round(stateWriteMs),
    peak_page_rows: peakPageRows,
    peak_currency_keys: Object.keys(snapshot.counts_by_currency).length,
    peak_funnel_keys: Object.keys(snapshot.counts_by_funnel).length,
    peak_transaction_type_keys: Object.keys(snapshot.counts_by_transaction_type).length,
  };
  return { state: nextState, reachedEnd, diagnostics };
}

// Stage 4: finalize — server-side id reconciliation + aggregate comparison.
async function finalize(input: RunValidationInput, state: ValidationStateRow, nowIso: () => string): Promise<ValidationStateRow> {
  const cursor = rangeFromState(state);
  const run = state.validation_run ?? "";
  const idParams: Record<string, unknown> = { auth_user_id: input.authUserId, validation_run: run };
  const cursorClause = clickHouseCursorWhereClause(cursor);
  const chParams: Record<string, unknown> = { auth_user_id: input.authUserId };
  if (cursor) {
    chParams.cursor_updated_at = cursor.cursor_updated_at;
    chParams.cursor_transaction_id = cursor.cursor_transaction_id;
  }
  const bothParams = { ...idParams, ...chParams };

  const uniqTransactions = await chScalar(
    input.clickhouse,
    `SELECT uniqExact(transaction_id) AS c FROM ${ANALYTICS_VALIDATION_SOURCE_IDS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} AND validation_run = {validation_run:String}`,
    idParams,
  );
  const uniqUsers = await chScalar(
    input.clickhouse,
    `SELECT uniqExact(user_id) AS c FROM ${ANALYTICS_VALIDATION_SOURCE_IDS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} AND validation_run = {validation_run:String}`,
    idParams,
  );
  const sourceIdsSql = `SELECT transaction_id FROM ${ANALYTICS_VALIDATION_SOURCE_IDS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} AND validation_run = {validation_run:String}`;
  const clickhouseIdsSql = `SELECT transaction_id FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} ${cursorClause}`;
  const missing = await chScalar(
    input.clickhouse,
    `SELECT count() AS c FROM (${sourceIdsSql}) s LEFT ANTI JOIN (${clickhouseIdsSql}) c ON s.transaction_id = c.transaction_id`,
    bothParams,
  );
  const extra = await chScalar(
    input.clickhouse,
    `SELECT count() AS c FROM (${clickhouseIdsSql}) c LEFT ANTI JOIN (${sourceIdsSql}) s ON c.transaction_id = s.transaction_id`,
    bothParams,
  );
  const duplicates = state.duplicate_ids_count ?? await clickHouseDuplicateCount(input.clickhouse, input.authUserId, cursor);

  const source: AggregateSnapshot = {
    ...state.source_aggregates,
    unique_transaction_ids: uniqTransactions,
    unique_users: uniqUsers,
    gross_revenue_usd: round6(state.source_aggregates.gross_revenue_usd),
    net_revenue_usd: round6(state.source_aggregates.net_revenue_usd),
    refund_amount_usd: round6(state.source_aggregates.refund_amount_usd),
  };
  const clickhouse = state.clickhouse_aggregates ?? emptySnapshot();

  const metrics = buildMetrics(source, clickhouse);
  const metricsPass = metrics.every((metric) => metric.status === "PASS");
  const idsPass = missing === 0 && extra === 0 && duplicates === 0;
  const parity = metricsPass && idsPass ? "PASS" : "FAIL";

  const grossDiff = round6(Math.abs(source.gross_revenue_usd - clickhouse.gross_revenue_usd));
  const netDiff = round6(Math.abs(source.net_revenue_usd - clickhouse.net_revenue_usd));
  const refundDiff = round6(Math.abs(source.refund_amount_usd - clickhouse.refund_amount_usd));

  const finalState: ValidationStateRow = {
    ...state,
    status: "completed",
    stage: "done",
    stopped_reason: "completed",
    source_aggregates: source,
    missing_ids_count: missing,
    extra_ids_count: extra,
    duplicate_ids_count: duplicates,
    gross_difference: grossDiff,
    net_difference: netDiff,
    refund_difference: refundDiff,
    parity_status: parity,
    completed_at: nowIso(),
  };
  await saveState(input.supabase, finalState);

  // Mirror the parity result onto the existing sync-state row (best effort) so
  // the Integrations summary stays consistent. Never throws the validation.
  try {
    await input.supabase.from("clickhouse_transaction_sync_state").upsert(
      {
        auth_user_id: input.authUserId,
        sync_name: "analytics_transactions_backfill",
        parity_status: parity,
        source_total: source.total_rows,
        clickhouse_total: clickhouse.total_rows,
      },
      { onConflict: "auth_user_id,sync_name" },
    );
  } catch {
    // ignore — the validation result is already persisted in validation state.
  }
  return finalState;
}

function toResponse(
  action: ValidationAction,
  state: ValidationStateRow | null,
  durationMs: number,
  diagnostics: ValidationChunkDiagnostics | null,
): ValidationResponse {
  if (!state) {
    return {
      action,
      validation_name: VALIDATION_NAME,
      status: "never_started",
      stage: null,
      stopped_reason: null,
      validation_scope: null,
      rows_processed: 0,
      source_rows_expected: null,
      progress_percent: 0,
      pages_processed: 0,
      source_id_chunk_count: 0,
      current_cursor: null,
      upper_cursor: null,
      source_rows: null,
      clickhouse_rows: null,
      missing_ids: null,
      extra_ids: null,
      duplicate_ids: null,
      gross_difference: null,
      net_difference: null,
      refund_difference: null,
      parity_status: null,
      source: null,
      clickhouse: null,
      duration_ms: durationMs,
      completed: false,
      diagnostics,
    };
  }
  const completed = state.status === "completed";
  const expected = state.source_rows_expected;
  const progress = completed
    ? 100
    : expected && expected > 0
      ? Math.min(100, Math.round((state.rows_processed / expected) * 100))
      : 0;
  return {
    action,
    validation_name: VALIDATION_NAME,
    status: state.status,
    stage: state.stage,
    stopped_reason: state.stopped_reason,
    validation_scope: state.validation_scope,
    rows_processed: state.rows_processed,
    source_rows_expected: expected,
    progress_percent: progress,
    pages_processed: state.pages_processed,
    source_id_chunk_count: state.source_id_chunk_count,
    current_cursor: cursorOrNull(state.current_cursor_updated_at, state.current_cursor_transaction_id),
    upper_cursor: cursorOrNull(state.upper_cursor_updated_at, state.upper_cursor_transaction_id),
    source_rows: completed ? state.source_aggregates.total_rows : state.rows_processed,
    clickhouse_rows: state.clickhouse_aggregates?.total_rows ?? null,
    missing_ids: state.missing_ids_count,
    extra_ids: state.extra_ids_count,
    duplicate_ids: state.duplicate_ids_count,
    gross_difference: state.gross_difference,
    net_difference: state.net_difference,
    refund_difference: state.refund_difference,
    parity_status: state.parity_status,
    source: completed ? state.source_aggregates : null,
    clickhouse: completed ? state.clickhouse_aggregates : null,
    duration_ms: durationMs,
    completed,
    diagnostics,
  };
}

export async function runValidation(input: RunValidationInput): Promise<ValidationResponse> {
  const now = input.now ?? (() => Date.now());
  const nowIso = input.nowIso ?? (() => new Date().toISOString());
  const makeRunId = input.makeRunId ?? (() => `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 10)}`);
  const scope: ValidationScope = input.validationScope ?? "imported_cursor_range";
  const pageSize = clampInt(input.pageSize, DEFAULT_PAGE_SIZE, MIN_PAGE_SIZE, MAX_PAGE_SIZE);
  const maxPages = clampInt(input.maxPages, DEFAULT_MAX_PAGES, 1, MAX_MAX_PAGES);
  const softTimeoutMs = clampInt(input.softTimeoutMs, DEFAULT_SOFT_TIMEOUT_MS, 1_000, 25_000);
  const startedAt = now();

  if (input.action === "status") {
    const state = await loadState(input.supabase, input.authUserId);
    return toResponse("status", state, now() - startedAt, null);
  }

  if (input.action === "reset") {
    await deleteState(input.supabase, input.authUserId);
    return toResponse("reset", null, now() - startedAt, null);
  }

  try {
    let state: ValidationStateRow;
    if (input.action === "start") {
      state = await initialize(input, scope, nowIso, makeRunId);
    } else {
      const existing = await loadState(input.supabase, input.authUserId);
      if (!existing || existing.status === "never_started") {
        return toResponse("continue", existing, now() - startedAt, null);
      }
      if (existing.status === "completed") {
        return toResponse("continue", existing, now() - startedAt, null);
      }
      state = existing;
    }

    let diagnostics: ValidationChunkDiagnostics | null = null;
    if (state.stage === "source_scan") {
      const chunk = await processChunk(input, state, pageSize, maxPages, softTimeoutMs, now);
      state = chunk.state;
      diagnostics = chunk.diagnostics;
      if (chunk.reachedEnd) {
        state = await finalize(input, state, nowIso);
      }
    } else if (state.stage === "finalize") {
      state = await finalize(input, state, nowIso);
    }

    return toResponse(input.action, state, now() - startedAt, diagnostics);
  } catch (error) {
    const message = error instanceof Error ? error.message : "ClickHouse validation chunk failed.";
    const isClickHouse = message.toLowerCase().includes("clickhouse");
    // Preserve progress: mark stopped_reason, keep cursor/aggregates for resume.
    const existing = await loadState(input.supabase, input.authUserId).catch(() => null);
    if (existing) {
      existing.stopped_reason = isClickHouse ? "clickhouse_error" : "source_error";
      existing.last_error = message.slice(0, 500);
      // status stays 'partial' so the client can Continue.
      await saveState(input.supabase, existing).catch(() => undefined);
      return toResponse(input.action, existing, now() - startedAt, null);
    }
    throw error;
  }
}
