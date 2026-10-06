/* global Deno */

// clickhouse-health: the `SELECT 1` warehouse connectivity probe (Integrations
// → ClickHouse → Test connection). Answers 200 with `connected: false` on any
// warehouse failure, as before.
//
// Access (policies/clickhouse-health.ts): admin.integrations.view or
// admin.diagnostics.view. The data owner gets today's body; everyone else the
// connectivity flags only (no database name, no ClickHouse error text).

import { clickHouseEnv, isClickHouseConfigured } from "../_shared/clickhouse/client.ts";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { ScopeViolation } from "../_shared/clickhouse/scopedClient.ts";
import type { ClickHouseClientLike } from "../_shared/clickhouse/types.ts";
import {
  CLICKHOUSE_HEALTH_POLICY,
  CLICKHOUSE_NOT_CONFIGURED_MESSAGE,
  healthDetailVisible,
  projectHealthForViewer,
} from "../_shared/access/policies/clickhouse-health.ts";

async function probeClickHouse(clickhouse: () => ClickHouseClientLike): Promise<Record<string, unknown>> {
  // Config probe only: host / username / password never leave this function.
  const env = clickHouseEnv();
  if (!isClickHouseConfigured()) {
    return {
      connected: false,
      configured: false,
      host_configured: Boolean(env.host),
      password_configured: env.hasPassword,
      error: CLICKHOUSE_NOT_CONFIGURED_MESSAGE,
    };
  }

  const startedAt = Date.now();
  try {
    const resultSet = await clickhouse().query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
    const rows = (await resultSet.json()) as Array<{ ok?: number }>;
    const ok = Number(rows[0]?.ok) === 1;
    return {
      connected: ok,
      configured: true,
      database: env.database,
      result: ok ? 1 : null,
      latency_ms: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    return {
      connected: false,
      configured: true,
      database: env.database,
      latency_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "ClickHouse connection failed.",
    };
  }
}

serveWithAccess(CLICKHOUSE_HEALTH_POLICY, async ({ ctx, clickhouse }) => {
  const health = await probeClickHouse(clickhouse);
  return healthDetailVisible(ctx) ? health : projectHealthForViewer(health);
});
