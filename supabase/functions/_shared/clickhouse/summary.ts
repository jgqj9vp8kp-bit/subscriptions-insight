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
