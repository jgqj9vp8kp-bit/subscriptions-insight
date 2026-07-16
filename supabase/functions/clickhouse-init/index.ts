/* global Deno */

import { clickHouseEnv, createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { initializeClickHouseSchema } from "../_shared/clickhouse/schema.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const result = await initializeClickHouseSchema({ client, env: clickHouseEnv() });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "Could not initialize ClickHouse schema.",
    }, 502);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
