// clickhouse-summary runner: the tenant KPI aggregate, the warehouse state rows
// the browser fingerprints into its cache versions, and the redacted "member
// view" of those states for callers who may run the version probe but not see
// tenant totals (policies/clickhouse-summary.ts decides which view applies).
import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";

export interface ClickHouseSummary {
  transaction_count: number;
  unique_users: number;
  successful_payments: number;
  failed_payments: number;
  trials: number;
  first_subscriptions: number;
  gross_revenue_usd: number;
  net_revenue_usd: number;
  refunds_usd: number;
  date_range: { from: string | null; to: string | null };
  query_duration_ms: number;
  benchmark: {
    source_duration_ms: number;
    clickhouse_duration_ms: number;
  };
}

type SummaryRow = {
  transaction_count?: number | string;
  unique_users?: number | string;
  successful_payments?: number | string;
  failed_payments?: number | string;
  trials?: number | string;
  first_subscriptions?: number | string;
  gross_revenue_usd?: number | string;
  net_revenue_usd?: number | string;
  refunds_usd?: number | string;
  date_from?: string | null;
  date_to?: string | null;
};

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function clickHouseAggregate(client: ClickHouseClientLike, authUserId: string): Promise<{ row: SummaryRow; duration: number }> {
  const started = Date.now();
  const resultSet = await client.query({
    query: `
      SELECT
        count() AS transaction_count,
        uniqExact(user_id) AS unique_users,
        sum(is_success) AS successful_payments,
        sum(is_failed) AS failed_payments,
        sum(is_trial) AS trials,
        sum(is_first_subscription) AS first_subscriptions,
        sum(gross_amount_usd) AS gross_revenue_usd,
        sum(net_amount_usd) AS net_revenue_usd,
        sum(refund_amount_usd) AS refunds_usd,
        toString(min(transaction_date)) AS date_from,
        toString(max(transaction_date)) AS date_to
      FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String}
    `,
    query_params: { auth_user_id: authUserId },
    format: "JSONEachRow",
  });
  const rows = (await resultSet.json()) as SummaryRow[];
  return { row: rows[0] ?? {}, duration: Date.now() - started };
}

async function sourceBenchmark(supabase: SupabaseLikeClient, authUserId: string): Promise<number> {
  const started = Date.now();
  const { error } = await supabase
    .from("transactions")
    .select("id", { count: "exact", head: true })
    .eq("auth_user_id", authUserId)
    .is("deleted_at", null);
  if (error) throw new Error(`Could not benchmark Supabase source: ${error.message}`);
  return Date.now() - started;
}

export async function getClickHouseSummary(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
}): Promise<ClickHouseSummary> {
  const [sourceDuration, ch] = await Promise.all([
    sourceBenchmark(input.supabase, input.authUserId),
    clickHouseAggregate(input.clickhouse, input.authUserId),
  ]);
  return {
    transaction_count: n(ch.row.transaction_count),
    unique_users: n(ch.row.unique_users),
    successful_payments: n(ch.row.successful_payments),
    failed_payments: n(ch.row.failed_payments),
    trials: n(ch.row.trials),
    first_subscriptions: n(ch.row.first_subscriptions),
    gross_revenue_usd: n(ch.row.gross_revenue_usd),
    net_revenue_usd: n(ch.row.net_revenue_usd),
    refunds_usd: n(ch.row.refunds_usd),
    date_range: {
      from: ch.row.date_from ?? null,
      to: ch.row.date_to ?? null,
    },
    query_duration_ms: ch.duration,
    benchmark: {
      source_duration_ms: sourceDuration,
      clickhouse_duration_ms: ch.duration,
    },
  };
}

// ---- Warehouse state rows (Postgres, service role → always tenant-filtered) ---

export type WarehouseStateRow = Record<string, unknown> | null;

async function stateRow(
  supabase: SupabaseLikeClient,
  table: string,
  nameColumn: string,
  name: string,
  tenantKey: string,
): Promise<WarehouseStateRow> {
  const { data } = await supabase
    .from(table)
    .select("*")
    .eq("auth_user_id", tenantKey)
    .eq(nameColumn, name)
    .maybeSingle();
  return (data as WarehouseStateRow) ?? null;
}

/** The analytics_transactions backfill state (cursor + counters). */
export function getTransactionSyncState(supabase: SupabaseLikeClient, tenantKey: string): Promise<WarehouseStateRow> {
  return stateRow(supabase, "clickhouse_transaction_sync_state", "sync_name", "analytics_transactions_backfill", tenantKey);
}

/** The fact_user_cohorts snapshot state. */
export function getCohortSnapshotStateRow(supabase: SupabaseLikeClient, tenantKey: string): Promise<WarehouseStateRow> {
  return stateRow(supabase, "clickhouse_cohort_snapshot_state", "snapshot_name", "fact_user_cohorts", tenantKey);
}

/** The fact_support_requests sync state. */
export function getSupportSyncState(supabase: SupabaseLikeClient, tenantKey: string): Promise<WarehouseStateRow> {
  return stateRow(supabase, "clickhouse_transaction_sync_state", "sync_name", "fact_support_requests_sync", tenantKey);
}

// ---- Member view ----------------------------------------------------------------
// Everything the browser's version fingerprints read (analyticsCache.ts
// warehouseVersionFromSummary / supportWarehouseVersionFromSummary), and nothing
// else: lifecycle status, timestamps and opaque versions. The raw cursor id and
// every count that feeds a fingerprint (transaction / support totals, support
// attribution counts) are folded into ONE keyed token per state, placed where
// the browser already reads the cursor id — so a sync still changes the version,
// but no tenant total, cursor id, error text or data key reaches the caller.
// No KPI aggregate runs for this view at all.

export interface MemberWarehouseSummary {
  redacted: true;
  sync_state: Record<string, unknown> | null;
  cohort_snapshot_state: Record<string, unknown> | null;
  support_sync_state: Record<string, unknown> | null;
}

type Hasher = (value: string) => Promise<string>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function versionToken(hasher: Hasher, kind: string, parts: unknown[]): Promise<string | null> {
  if (parts.every((part) => part === null || part === undefined || part === "")) return null;
  return `v_${(await hasher(JSON.stringify([kind, ...parts.map((part) => part ?? null)]))).slice(0, 32)}`;
}

async function memberSyncState(row: WarehouseStateRow, hasher: Hasher, kind: string, extra: unknown[] = []): Promise<Record<string, unknown> | null> {
  if (!row) return null;
  return {
    status: row.status ?? null,
    cursor_updated_at: row.cursor_updated_at ?? null,
    cursor_transaction_id: await versionToken(hasher, kind, [row.cursor_transaction_id, row.cursor_updated_at, row.clickhouse_total, ...extra]),
  };
}

export async function memberWarehouseSummary(input: {
  hasher: Hasher;
  syncState: WarehouseStateRow;
  cohortSnapshotState: WarehouseStateRow;
  supportSyncState: WarehouseStateRow;
}): Promise<MemberWarehouseSummary> {
  const snapshot = input.cohortSnapshotState;
  const attribution = record(record(input.supportSyncState?.diagnostics).attribution);
  return {
    redacted: true,
    sync_state: await memberSyncState(input.syncState, input.hasher, "sync"),
    // A rebuild always moves active_generated_at, so users_classified (a tenant
    // user total) is not needed for the cohort part of the fingerprint.
    cohort_snapshot_state: snapshot
      ? {
        status: snapshot.status ?? null,
        active_warehouse_version: snapshot.active_warehouse_version ?? null,
        active_classification_version: snapshot.active_classification_version ?? null,
        active_generated_at: snapshot.active_generated_at ?? null,
      }
      : null,
    support_sync_state: await memberSyncState(input.supportSyncState, input.hasher, "support", [
      attribution.attribution_version,
      attribution.funnel_matched,
      attribution.unknown,
    ]),
  };
}
