/* global Deno */

// clickhouse-init: idempotent warehouse DDL (CREATE / ALTER of every table and
// the one-time whole-table rebuilds), then the analytics_transactions metadata
// and the workspace tenant's row counts (ctx.tenantKey, never the caller).
//
// Access (policies/clickhouse-init.ts): the workspace Owner who is also the
// data owner (ownerOnly + rawOnly) — platform DDL rewrites every tenant's rows.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { initializeClickHouseSchema } from "../_shared/clickhouse/schema.ts";
import { CLICKHOUSE_INIT_POLICY, clickHouseInitErrorResponse } from "../_shared/access/policies/clickhouse-init.ts";

serveWithAccess(
  CLICKHOUSE_INIT_POLICY,
  // The database name is read from the warehouse (currentDatabase()), so no
  // ClickHouse config is read here.
  async ({ ctx, clickhouse }) => await initializeClickHouseSchema({ client: clickhouse(), authUserId: ctx.tenantKey }),
  { onError: clickHouseInitErrorResponse },
);
