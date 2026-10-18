// Postgres public.funnelfox_subscriptions -> ClickHouse fact_subscriptions
// (2026-10-18): the table's first writer. It feeds the Cohorts cancellation
// columns (cohortCancellations.ts) and the Users page subscription status
// (users.ts), both of which read fact_subscriptions FINAL by normalized_email.
//
// A full refresh of the tenant: every row of the run carries the run's version,
// so ReplacingMergeTree keeps it over any older copy, and rows older than the run
// (subscriptions gone from Postgres) are deleted at the end. Runs at the end of
// the FunnelFox subscriptions sync (finalize stage) — ~17k rows, a few seconds.

import {
  FACT_SUBSCRIPTIONS_TABLE,
  FUNNELFOX_SUBSCRIPTION_SYNC_SELECT,
  ensureFactSubscriptionsSchema,
  normalizeSubscriptionForClickHouse,
  type FactSubscriptionRow,
  type SupabaseSubscriptionSourceRow,
} from "./factSubscriptions.ts";
import type { ClickHouseClientLike } from "./types.ts";

const PAGE_SIZE = 1000;
const INSERT_BATCH = 5000;

/** The narrow PostgREST surface the sync reads through (service-role client). */
export interface SubscriptionSourceClient {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        order(column: string, options: { ascending: boolean }): {
          range(from: number, to: number): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
        };
      };
    };
  };
}

export interface FactSubscriptionsSyncResult {
  source_rows: number;
  inserted: number;
  skipped: number;
  cancelled: number;
  cancelled_with_date: number;
  run_version: number;
  duration_ms: number;
}

export async function syncFactSubscriptions(input: {
  pg: SubscriptionSourceClient;
  clickhouse: ClickHouseClientLike;
  authUserId: string;
  nowMs?: number;
}): Promise<FactSubscriptionsSyncResult> {
  const started = Date.now();
  const runVersion = Math.trunc(input.nowMs ?? started);
  if (!input.authUserId) throw new Error("syncFactSubscriptions requires the workspace tenant.");
  await ensureFactSubscriptionsSchema(input.clickhouse);

  let sourceRows = 0;
  let skipped = 0;
  let cancelled = 0;
  let cancelledWithDate = 0;
  let inserted = 0;
  let batch: FactSubscriptionRow[] = [];
  const flush = async () => {
    if (!batch.length) return;
    await input.clickhouse.insert({ table: FACT_SUBSCRIPTIONS_TABLE, values: batch as unknown as Record<string, unknown>[], format: "JSONEachRow" });
    inserted += batch.length;
    batch = [];
  };

  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await input.pg
      .from("funnelfox_subscriptions")
      .select(FUNNELFOX_SUBSCRIPTION_SYNC_SELECT)
      .eq("auth_user_id", input.authUserId)
      .order("subscription_id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`fact_subscriptions sync: could not read funnelfox_subscriptions (${error.message})`);
    const rows = (data ?? []) as SupabaseSubscriptionSourceRow[];
    sourceRows += rows.length;
    for (const row of rows) {
      const fact = normalizeSubscriptionForClickHouse(row, runVersion);
      if (!fact) {
        skipped += 1;
        continue;
      }
      if (fact.status.includes("cancel") || fact.renews === 0) {
        cancelled += 1;
        if (fact.cancelled_at) cancelledWithDate += 1;
      }
      batch.push(fact);
      if (batch.length >= INSERT_BATCH) await flush();
    }
    if (rows.length < PAGE_SIZE) break;
  }
  await flush();

  // Older runs' rows: subscriptions no longer in Postgres (and every superseded
  // copy, which FINAL would hide anyway). Lightweight DELETE, tenant-bounded —
  // and never after a run that wrote nothing (an empty read must not wipe it).
  if (inserted > 0) await input.clickhouse.command({
    query: `DELETE FROM ${FACT_SUBSCRIPTIONS_TABLE} WHERE auth_user_id = {auth_user_id:String} AND row_version < {run_version:UInt64}`,
    query_params: { auth_user_id: input.authUserId, run_version: runVersion },
  });

  return {
    source_rows: sourceRows,
    inserted,
    skipped,
    cancelled,
    cancelled_with_date: cancelledWithDate,
    run_version: runVersion,
    duration_ms: Date.now() - started,
  };
}
