import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";
import {
  buildTransactionMappingContext,
  hydrateSupabaseTransactionRows,
  mapSupabaseTransactionsToClickHouse,
  type ClickHouseTransactionRow,
  type SupabaseTransactionRow,
} from "./transactionMapper.ts";

export const CLICKHOUSE_FINAL_QUERY_STRATEGY = `${ANALYTICS_TRANSACTIONS_TABLE} FINAL`;
export type ValidationScope = "full_dataset" | "imported_cursor_range";
// `raw_payload` is deliberately omitted here. It is the largest column (~4 KB/row,
// ~2x `normalized_payload`) and, unlike `normalized_payload`, it feeds NO metric the
// validation compares — none of total_rows/unique ids/users, event-time bounds,
// lifecycle flags, USD revenue, or the currency/funnel/transaction_type maps derive
// from it. Loading + JSON-re-serializing it for every source row was the dominant
// allocation once the scan covered the full range, exhausting the Edge isolate's
// memory. Dropping it from the source read is bounded-memory only and leaves the
// validation output byte-for-byte identical. The backfill still selects it (its own
// TRANSACTION_SELECT) so the stored ClickHouse rows are unchanged.
const TRANSACTION_SELECT =
  "id,auth_user_id,user_id,transaction_id,external_transaction_id,import_batch_id,source,event_time,status,transaction_type,amount_gross,amount_net,amount_refunded,currency,email,country_code,campaign_path,funnel,source_name,normalized_payload,created_at,updated_at,deleted_at";

export type ValidationStatus = "PASS" | "FAIL";

export interface AggregateSnapshot {
  total_rows: number;
  unique_transaction_ids: number;
  unique_users: number;
  min_event_time: string | null;
  max_event_time: string | null;
  successful_payments: number;
  failed_payments: number;
  trials: number;
  first_subscriptions: number;
  renewals: number;
  upsells: number;
  token_purchases: number;
  refunds: number;
  chargebacks: number;
  gross_revenue_usd: number;
  net_revenue_usd: number;
  refund_amount_usd: number;
  counts_by_currency: Record<string, number>;
  counts_by_funnel: Record<string, number>;
  counts_by_transaction_type: Record<string, number>;
}

export interface ValidationMetric {
  metric: string;
  source_value: number | string | null | Record<string, number>;
  clickhouse_value: number | string | null | Record<string, number>;
  absolute_difference: number;
  percentage_difference: number;
  status: ValidationStatus;
}

export interface IdReconciliation {
  missing_in_clickhouse: string[];
  extra_in_clickhouse: string[];
  duplicate_transaction_ids: Array<{ transaction_id: string; count: number }>;
  checked_limit: number;
}

export interface ValidationResult {
  status: ValidationStatus;
  validation_scope: ValidationScope;
  cursor_range: ValidationCursorRange | null;
  revenue_tolerance_usd: number;
  source: AggregateSnapshot;
  clickhouse: AggregateSnapshot;
  metrics: ValidationMetric[];
  reconciliation: IdReconciliation;
  duration_ms: number;
}

export interface ValidationCursorRange {
  cursor_updated_at: string;
  cursor_transaction_id: string;
}

export function emptySnapshot(): AggregateSnapshot {
  return {
    total_rows: 0,
    unique_transaction_ids: 0,
    unique_users: 0,
    min_event_time: null,
    max_event_time: null,
    successful_payments: 0,
    failed_payments: 0,
    trials: 0,
    first_subscriptions: 0,
    renewals: 0,
    upsells: 0,
    token_purchases: 0,
    refunds: 0,
    chargebacks: 0,
    gross_revenue_usd: 0,
    net_revenue_usd: 0,
    refund_amount_usd: 0,
    counts_by_currency: {},
    counts_by_funnel: {},
    counts_by_transaction_type: {},
  };
}

export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function increment(map: Record<string, number>, key: string): void {
  const normalized = key || "unknown";
  map[normalized] = (map[normalized] ?? 0) + 1;
}

export function addRow(snapshot: AggregateSnapshot, row: ClickHouseTransactionRow): void {
  snapshot.total_rows += 1;
  if (!snapshot.min_event_time || row.event_time < snapshot.min_event_time) snapshot.min_event_time = row.event_time;
  if (!snapshot.max_event_time || row.event_time > snapshot.max_event_time) snapshot.max_event_time = row.event_time;
  snapshot.successful_payments += row.is_success;
  snapshot.failed_payments += row.is_failed;
  snapshot.trials += row.is_trial;
  snapshot.first_subscriptions += row.is_first_subscription;
  snapshot.renewals += row.is_renewal;
  snapshot.upsells += row.is_upsell;
  snapshot.token_purchases += row.is_token_purchase;
  snapshot.refunds += row.is_refund;
  snapshot.chargebacks += row.is_chargeback;
  snapshot.gross_revenue_usd += Number(row.gross_amount_usd || 0);
  snapshot.net_revenue_usd += Number(row.net_amount_usd || 0);
  snapshot.refund_amount_usd += Number(row.refund_amount_usd || 0);
  increment(snapshot.counts_by_currency, row.currency);
  increment(snapshot.counts_by_funnel, row.funnel);
  increment(snapshot.counts_by_transaction_type, row.transaction_type);
}

function finalizeSnapshot(snapshot: AggregateSnapshot, ids: Set<string>, users: Set<string>): AggregateSnapshot {
  return {
    ...snapshot,
    unique_transaction_ids: ids.size,
    unique_users: users.size,
    gross_revenue_usd: round6(snapshot.gross_revenue_usd),
    net_revenue_usd: round6(snapshot.net_revenue_usd),
    refund_amount_usd: round6(snapshot.refund_amount_usd),
  };
}

export async function readSourceBatch(input: {
  supabase: SupabaseLikeClient;
  authUserId: string;
  batchSize: number;
  cursorUpdatedAt: string | null;
  cursorTransactionId: string | null;
  upperCursor?: ValidationCursorRange | null;
}): Promise<SupabaseTransactionRow[]> {
  let query = input.supabase
    .from("transactions")
    .select(TRANSACTION_SELECT)
    .eq("auth_user_id", input.authUserId)
    .is("deleted_at", null)
    .order("updated_at", { ascending: true })
    .order("transaction_id", { ascending: true })
    .limit(input.batchSize);
  // Lower bound (resume point): server-side compound predicate. Postgres applies
  // the transaction_id tie-breaker with the same en_US.UTF-8 collation as the
  // ORDER BY and the backfill cursor. (Already correct — kept unchanged.)
  if (input.cursorUpdatedAt && input.cursorTransactionId) {
    query = query.or(`updated_at.gt.${input.cursorUpdatedAt},and(updated_at.eq.${input.cursorUpdatedAt},transaction_id.gt.${input.cursorTransactionId})`);
  }
  // Upper bound (frozen cursor): ALSO a server-side compound predicate. This
  // previously used a coarse `updated_at <= upper` filter refined by a JavaScript
  // `transaction_id <=` comparison — but JS compares strings bytewise (UTF-16)
  // while Postgres/the backfill order by en_US.UTF-8 collation. At a timestamp
  // shared by many rows the two orderings disagree, so the JS filter admitted rows
  // that sort AFTER the cursor in the database (reported as false "missing").
  // Evaluating the whole bound in Postgres keeps the scan byte-for-byte identical
  // to `ORDER BY updated_at ASC, transaction_id ASC` and to the backfill's cursor.
  // transaction_id values are short alphanumerics; supabase-js URL-encodes the
  // predicate, so the timestamp (spaces/`+`) and id are transmitted safely.
  if (input.upperCursor) {
    query = query.or(`updated_at.lt.${input.upperCursor.cursor_updated_at},and(updated_at.eq.${input.upperCursor.cursor_updated_at},transaction_id.lte.${input.upperCursor.cursor_transaction_id})`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Could not read source transactions for validation: ${error.message}`);
  return (data ?? []) as SupabaseTransactionRow[];
}

async function sourceSnapshot(input: { supabase: SupabaseLikeClient; authUserId: string; batchSize: number; upperCursor?: ValidationCursorRange | null }): Promise<{ snapshot: AggregateSnapshot; ids: Set<string> }> {
  const snapshot = emptySnapshot();
  const ids = new Set<string>();
  const users = new Set<string>();
  let cursorUpdatedAt: string | null = null;
  let cursorTransactionId: string | null = null;

  while (true) {
    const batch = await readSourceBatch({
      supabase: input.supabase,
      authUserId: input.authUserId,
      batchSize: input.batchSize,
      cursorUpdatedAt,
      cursorTransactionId,
      upperCursor: input.upperCursor,
    });
    if (!batch.length) break;
    const context = buildTransactionMappingContext(hydrateSupabaseTransactionRows(batch));
    const mapped = mapSupabaseTransactionsToClickHouse({ authUserId: input.authUserId, rows: batch, context });
    for (const row of mapped.rows) {
      addRow(snapshot, row);
      ids.add(row.transaction_id);
      users.add(row.user_id);
    }
    const last = batch.at(-1);
    cursorUpdatedAt = last?.updated_at ?? null;
    cursorTransactionId = last?.transaction_id ?? null;
    // Do NOT terminate on a short page. PostgREST enforces a server-side
    // `max-rows` cap, so a page can come back smaller than `batchSize` while
    // rows still remain in the imported range. Treating a short page as "the
    // end" truncated the source scan to the first page (~1,000 rows), which
    // made every unread ClickHouse row look like extra_in_clickhouse and
    // inflated the revenue difference. Terminate only on an empty page (checked
    // at the top of the loop) to mirror the backfill's paging. The null-cursor
    // guard prevents a row with a missing updated_at/transaction_id from
    // re-reading the range from the start.
    if (!cursorUpdatedAt || !cursorTransactionId) break;
  }

  return { snapshot: finalizeSnapshot(snapshot, ids, users), ids };
}

type ClickHouseAggregateRow = Partial<Record<keyof AggregateSnapshot, string | number | null>>;
type GroupRow = { key?: string; value?: string | number };

async function queryJson<T>(client: ClickHouseClientLike, query: string, authUserId: string, extraParams: Record<string, unknown> = {}): Promise<T[]> {
  const resultSet = await client.query({
    query,
    query_params: { auth_user_id: authUserId, ...extraParams },
    format: "JSONEachRow",
  });
  return (await resultSet.json()) as T[];
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function clickHouseCursorWhereClause(cursor: ValidationCursorRange | null): string {
  if (!cursor) return "";
  return `
        AND source_updated_at IS NOT NULL
        AND (
          source_updated_at < parseDateTime64BestEffort({cursor_updated_at:String}, 3)
          OR (
            source_updated_at = parseDateTime64BestEffort({cursor_updated_at:String}, 3)
            AND transaction_id <= {cursor_transaction_id:String}
          )
        )
  `;
}

export async function clickHouseSnapshot(client: ClickHouseClientLike, authUserId: string, cursor: ValidationCursorRange | null): Promise<AggregateSnapshot> {
  const cursorClause = clickHouseCursorWhereClause(cursor);
  const cursorParams = cursor ? { cursor_updated_at: cursor.cursor_updated_at, cursor_transaction_id: cursor.cursor_transaction_id } : {};
  const [row] = await queryJson<ClickHouseAggregateRow>(
    client,
    `
      SELECT
        count() AS total_rows,
        uniqExact(transaction_id) AS unique_transaction_ids,
        uniqExact(user_id) AS unique_users,
        toString(min(event_time)) AS min_event_time,
        toString(max(event_time)) AS max_event_time,
        sum(is_success) AS successful_payments,
        sum(is_failed) AS failed_payments,
        sum(is_trial) AS trials,
        sum(is_first_subscription) AS first_subscriptions,
        sum(is_renewal) AS renewals,
        sum(is_upsell) AS upsells,
        sum(is_token_purchase) AS token_purchases,
        sum(is_refund) AS refunds,
        sum(is_chargeback) AS chargebacks,
        sum(gross_amount_usd) AS gross_revenue_usd,
        sum(net_amount_usd) AS net_revenue_usd,
        sum(refund_amount_usd) AS refund_amount_usd
      FROM ${CLICKHOUSE_FINAL_QUERY_STRATEGY}
      WHERE auth_user_id = {auth_user_id:String}
      ${cursorClause}
    `,
    authUserId,
    cursorParams,
  );
  const toMap = async (field: "currency" | "funnel" | "transaction_type") => {
    const rows = await queryJson<GroupRow>(
      client,
      `
        SELECT ${field} AS key, count() AS value
        FROM ${CLICKHOUSE_FINAL_QUERY_STRATEGY}
        WHERE auth_user_id = {auth_user_id:String}
        ${cursorClause}
        GROUP BY ${field}
      `,
      authUserId,
      cursorParams,
    );
    return Object.fromEntries(rows.map((entry) => [entry.key || "unknown", numberValue(entry.value)]));
  };

  return {
    total_rows: numberValue(row?.total_rows),
    unique_transaction_ids: numberValue(row?.unique_transaction_ids),
    unique_users: numberValue(row?.unique_users),
    min_event_time: row?.min_event_time ? String(row.min_event_time) : null,
    max_event_time: row?.max_event_time ? String(row.max_event_time) : null,
    successful_payments: numberValue(row?.successful_payments),
    failed_payments: numberValue(row?.failed_payments),
    trials: numberValue(row?.trials),
    first_subscriptions: numberValue(row?.first_subscriptions),
    renewals: numberValue(row?.renewals),
    upsells: numberValue(row?.upsells),
    token_purchases: numberValue(row?.token_purchases),
    refunds: numberValue(row?.refunds),
    chargebacks: numberValue(row?.chargebacks),
    gross_revenue_usd: round6(numberValue(row?.gross_revenue_usd)),
    net_revenue_usd: round6(numberValue(row?.net_revenue_usd)),
    refund_amount_usd: round6(numberValue(row?.refund_amount_usd)),
    counts_by_currency: await toMap("currency"),
    counts_by_funnel: await toMap("funnel"),
    counts_by_transaction_type: await toMap("transaction_type"),
  };
}

function toleranceFor(metric: string, sourceValue: number): number {
  if (!metric.includes("revenue") && !metric.includes("refund_amount")) return 0;
  return Math.max(0.01, Math.abs(sourceValue) * 0.0001);
}

export function compareMetric(metric: string, sourceValue: number, clickhouseValue: number): ValidationMetric {
  const diff = round6(Math.abs(sourceValue - clickhouseValue));
  const tolerance = toleranceFor(metric, sourceValue);
  return {
    metric,
    source_value: sourceValue,
    clickhouse_value: clickhouseValue,
    absolute_difference: diff,
    percentage_difference: sourceValue === 0 ? (clickhouseValue === 0 ? 0 : 100) : Math.abs(diff / sourceValue) * 100,
    status: diff <= tolerance ? "PASS" : "FAIL",
  };
}

function compareMap(metric: string, source: Record<string, number>, clickhouse: Record<string, number>): ValidationMetric {
  const keys = new Set([...Object.keys(source), ...Object.keys(clickhouse)]);
  let diff = 0;
  keys.forEach((key) => {
    diff += Math.abs((source[key] ?? 0) - (clickhouse[key] ?? 0));
  });
  return {
    metric,
    source_value: source,
    clickhouse_value: clickhouse,
    absolute_difference: diff,
    percentage_difference: 0,
    status: diff === 0 ? "PASS" : "FAIL",
  };
}

// min/max event_time denote the same instant on both sides, but the two snapshots
// stringify it differently: the mapper's dateTimeKey() emits an ISO 'T' separator
// (2026-03-11T14:51:11.694) while ClickHouse's toString(event_time) emits a space
// (2026-03-11 14:51:11.694). Strict string equality therefore always reported these
// two metrics as FAIL in production even when every value matched — flipping the
// whole validation to FAIL. Compare the instants separator-insensitively; genuinely
// different timestamps still differ after normalisation, so no check is weakened.
function eventTimesMatch(a: string | null, b: string | null): boolean {
  const normalize = (value: string | null): string | null => (value == null ? value : String(value).replace("T", " ").trim());
  return normalize(a) === normalize(b);
}

export function buildMetrics(source: AggregateSnapshot, clickhouse: AggregateSnapshot): ValidationMetric[] {
  const numericKeys: Array<keyof AggregateSnapshot> = [
    "total_rows",
    "unique_transaction_ids",
    "unique_users",
    "successful_payments",
    "failed_payments",
    "trials",
    "first_subscriptions",
    "renewals",
    "upsells",
    "token_purchases",
    "refunds",
    "chargebacks",
    "gross_revenue_usd",
    "net_revenue_usd",
    "refund_amount_usd",
  ];
  return [
    ...numericKeys.map((key) => compareMetric(key, source[key] as number, clickhouse[key] as number)),
    {
      metric: "min_event_time",
      source_value: source.min_event_time,
      clickhouse_value: clickhouse.min_event_time,
      absolute_difference: eventTimesMatch(source.min_event_time, clickhouse.min_event_time) ? 0 : 1,
      percentage_difference: 0,
      status: eventTimesMatch(source.min_event_time, clickhouse.min_event_time) ? "PASS" : "FAIL",
    },
    {
      metric: "max_event_time",
      source_value: source.max_event_time,
      clickhouse_value: clickhouse.max_event_time,
      absolute_difference: eventTimesMatch(source.max_event_time, clickhouse.max_event_time) ? 0 : 1,
      percentage_difference: 0,
      status: eventTimesMatch(source.max_event_time, clickhouse.max_event_time) ? "PASS" : "FAIL",
    },
    compareMap("counts_by_currency", source.counts_by_currency, clickhouse.counts_by_currency),
    compareMap("counts_by_funnel", source.counts_by_funnel, clickhouse.counts_by_funnel),
    compareMap("counts_by_transaction_type", source.counts_by_transaction_type, clickhouse.counts_by_transaction_type),
  ];
}

async function reconcileIds(input: {
  client: ClickHouseClientLike;
  authUserId: string;
  sourceIds: Set<string>;
  limit: number;
  cursor: ValidationCursorRange | null;
}): Promise<IdReconciliation> {
  const cursorClause = clickHouseCursorWhereClause(input.cursor);
  const cursorParams = input.cursor ? { cursor_updated_at: input.cursor.cursor_updated_at, cursor_transaction_id: input.cursor.cursor_transaction_id } : {};
  const clickhouseRows = await queryJson<{ transaction_id?: string; count?: number | string }>(
    input.client,
    `
      SELECT transaction_id, count() AS count
      FROM ${CLICKHOUSE_FINAL_QUERY_STRATEGY}
      WHERE auth_user_id = {auth_user_id:String}
      ${cursorClause}
      GROUP BY transaction_id
      ORDER BY transaction_id
      LIMIT ${input.limit}
    `,
    input.authUserId,
    cursorParams,
  );
  const clickhouseIds = new Set(clickhouseRows.map((row) => row.transaction_id).filter((id): id is string => Boolean(id)));
  const sourceSample = Array.from(input.sourceIds).sort().slice(0, input.limit);
  return {
    missing_in_clickhouse: sourceSample.filter((id) => !clickhouseIds.has(id)).slice(0, 100),
    extra_in_clickhouse: Array.from(clickhouseIds).filter((id) => !input.sourceIds.has(id)).slice(0, 100),
    duplicate_transaction_ids: clickhouseRows
      .filter((row) => numberValue(row.count) > 1)
      .map((row) => ({ transaction_id: row.transaction_id ?? "", count: numberValue(row.count) }))
      .slice(0, 100),
    checked_limit: input.limit,
  };
}

export async function importedCursorRange(supabase: SupabaseLikeClient, authUserId: string): Promise<ValidationCursorRange | null> {
  const { data, error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .select("cursor_updated_at,cursor_transaction_id")
    .eq("auth_user_id", authUserId)
    .eq("sync_name", "analytics_transactions_backfill")
    .maybeSingle();
  if (error) throw new Error(`Could not load ClickHouse validation cursor: ${error.message}`);
  const cursor = data as { cursor_updated_at?: string | null; cursor_transaction_id?: string | null } | null;
  if (!cursor?.cursor_updated_at || !cursor.cursor_transaction_id) return null;
  return {
    cursor_updated_at: cursor.cursor_updated_at,
    cursor_transaction_id: cursor.cursor_transaction_id,
  };
}

export async function validateTransactions(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  batchSize?: number;
  reconciliationLimit?: number;
  validationScope?: ValidationScope;
}): Promise<ValidationResult> {
  const startedAt = Date.now();
  const clickhouse = input.clickhouse;
  const validationScope = input.validationScope ?? "full_dataset";
  const cursor = validationScope === "imported_cursor_range"
    ? await importedCursorRange(input.supabase, input.authUserId)
    : null;
  if (validationScope === "imported_cursor_range" && !cursor) {
    throw new Error("Imported cursor range validation requires a saved ClickHouse backfill cursor.");
  }
  const source = await sourceSnapshot({ supabase: input.supabase, authUserId: input.authUserId, batchSize: input.batchSize ?? 2000, upperCursor: cursor });
  const ch = await clickHouseSnapshot(clickhouse, input.authUserId, cursor);
  const metrics = buildMetrics(source.snapshot, ch);
  const reconciliation = await reconcileIds({
    client: clickhouse,
    authUserId: input.authUserId,
    sourceIds: source.ids,
    limit: input.reconciliationLimit ?? 5000,
    cursor,
  });
  const status: ValidationStatus =
    metrics.every((metric) => metric.status === "PASS") &&
    reconciliation.missing_in_clickhouse.length === 0 &&
    reconciliation.extra_in_clickhouse.length === 0 &&
    reconciliation.duplicate_transaction_ids.length === 0
      ? "PASS"
      : "FAIL";

  await input.supabase
    .from("clickhouse_transaction_sync_state")
    .upsert(
      {
        auth_user_id: input.authUserId,
        sync_name: "analytics_transactions_backfill",
        parity_status: status,
        source_total: source.snapshot.total_rows,
        clickhouse_total: ch.total_rows,
        diagnostics: {
          validation_status: status,
          validation_scope: validationScope,
          cursor_range: cursor,
          revenue_tolerance: "max(0.01, 0.01%)",
          reconciliation,
          validated_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "auth_user_id,sync_name" },
    );

  return {
    status,
    validation_scope: validationScope,
    cursor_range: cursor,
    revenue_tolerance_usd: Math.max(0.01, Math.abs(source.snapshot.gross_revenue_usd) * 0.0001),
    source: source.snapshot,
    clickhouse: ch,
    metrics,
    reconciliation,
    duration_ms: Date.now() - startedAt,
  };
}
