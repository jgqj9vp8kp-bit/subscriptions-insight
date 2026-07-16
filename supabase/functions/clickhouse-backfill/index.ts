/* global Deno */

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { runTransactionsBackfill, type BackfillParams } from "../_shared/clickhouse/backfill.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let params: BackfillParams;
  try {
    params = await parseJsonBody<Record<string, unknown>>(req) as BackfillParams;
  } catch {
    return jsonResponse({ error: "Invalid JSON request body." }, 400);
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const result = await runTransactionsBackfill({
      authUserId: auth.id,
      supabase: auth.supabase,
      clickhouse: client,
      params,
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "ClickHouse transaction backfill failed.",
    }, 502);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
