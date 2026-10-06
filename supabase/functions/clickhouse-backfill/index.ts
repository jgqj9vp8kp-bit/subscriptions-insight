/* global Deno */

// clickhouse-backfill: Postgres transactions → ClickHouse analytics_transactions
// for the workspace tenant (ctx.tenantKey, never the caller). One run per
// tenant at a time: the runner claims a compare-and-set lease on its sync-state
// row and answers "already_running" instead of overlapping another run.
//
// Access (policies/clickhouse-backfill.ts): every mode — continue, full
// backfill, validate-only, dedup repair — needs admin.warehouse.manage.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { runTransactionsBackfill, type BackfillParams } from "../_shared/clickhouse/backfill.ts";
import { CLICKHOUSE_BACKFILL_POLICY, clickHouseBackfillErrorResponse } from "../_shared/access/policies/clickhouse-backfill.ts";

serveWithAccess(
  CLICKHOUSE_BACKFILL_POLICY,
  async ({ ctx, body, pg, clickhouse }) =>
    await runTransactionsBackfill({
      authUserId: ctx.tenantKey,
      supabase: pg,
      clickhouse: clickhouse(),
      params: body as BackfillParams,
    }),
  { onError: clickHouseBackfillErrorResponse },
);
