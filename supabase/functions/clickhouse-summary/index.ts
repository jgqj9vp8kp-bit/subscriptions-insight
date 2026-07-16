/* global Deno */

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { getClickHouseSummary } from "../_shared/clickhouse/summary.ts";

async function getSyncState(auth: Awaited<ReturnType<typeof requireSupabaseUser>>) {
  if ("status" in auth) return null;
  const { data } = await auth.supabase
    .from("clickhouse_transaction_sync_state")
    .select("*")
    .eq("auth_user_id", auth.id)
    .eq("sync_name", "analytics_transactions_backfill")
    .maybeSingle();
  return data ?? null;
}

async function getCohortSnapshotState(auth: Awaited<ReturnType<typeof requireSupabaseUser>>) {
  if ("status" in auth) return null;
  const { data } = await auth.supabase
    .from("clickhouse_cohort_snapshot_state")
    .select("*")
    .eq("auth_user_id", auth.id)
    .eq("snapshot_name", "fact_user_cohorts")
    .maybeSingle();
  return data ?? null;
}

async function getSupportSyncState(auth: Awaited<ReturnType<typeof requireSupabaseUser>>) {
  if ("status" in auth) return null;
  const { data } = await auth.supabase
    .from("clickhouse_transaction_sync_state")
    .select("*")
    .eq("auth_user_id", auth.id)
    .eq("sync_name", "fact_support_requests_sync")
    .maybeSingle();
  return data ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed("GET, POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const [summary, syncState, cohortSnapshotState, supportSyncState] = await Promise.all([
      getClickHouseSummary({ authUserId: auth.id, supabase: auth.supabase, clickhouse: client }),
      getSyncState(auth),
      getCohortSnapshotState(auth),
      getSupportSyncState(auth),
    ]);
    return jsonResponse({ ...summary, sync_state: syncState, cohort_snapshot_state: cohortSnapshotState, support_sync_state: supportSyncState });
  } catch (error) {
    return jsonResponse({
      connected: false,
      error: error instanceof Error ? error.message : "Could not load ClickHouse summary.",
      sync_state: await getSyncState(auth).catch(() => null),
      cohort_snapshot_state: await getCohortSnapshotState(auth).catch(() => null),
      support_sync_state: await getSupportSyncState(auth).catch(() => null),
    });
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
