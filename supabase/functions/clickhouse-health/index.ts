/* global Deno */

import { clickHouseEnv, createClickHouseClient, isClickHouseConfigured } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, requireSupabaseUser } from "../_shared/clickhouse/http.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed("GET, POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  const env = clickHouseEnv();
  if (!isClickHouseConfigured()) {
    return jsonResponse({
      connected: false,
      configured: false,
      host_configured: Boolean(env.host),
      password_configured: env.hasPassword,
      error: "ClickHouse is not configured in Supabase Secrets. Set CLICKHOUSE_HOST and CLICKHOUSE_PASSWORD.",
    });
  }

  const startedAt = Date.now();
  const client = createClickHouseClient();
  try {
    const resultSet = await client.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
    const rows = (await resultSet.json()) as Array<{ ok?: number }>;
    const ok = Number(rows[0]?.ok) === 1;
    return jsonResponse({
      connected: ok,
      configured: true,
      database: env.database,
      result: ok ? 1 : null,
      latency_ms: Date.now() - startedAt,
    });
  } catch (error) {
    return jsonResponse({
      connected: false,
      configured: true,
      database: env.database,
      latency_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "ClickHouse connection failed.",
    });
  } finally {
    await client.close?.().catch(() => undefined);
  }
});
