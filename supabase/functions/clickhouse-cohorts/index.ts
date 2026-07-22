/* global Deno */

// clickhouse-cohorts: server-side Cohorts read path. Runs the parity-proven
// cohort SQL in ClickHouse, scoped to the authenticated user, and returns only
// aggregated rows / totals / diagnostics — never raw payloads, emails,
// transaction ids, SQL, or credentials.

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import {
  CohortRequestError,
  normalizeAction,
  runCohortDetails,
  runCohortList,
  runCohortOptions,
} from "../_shared/clickhouse/cohorts.ts";
import {
  runMaterializedCohortList,
  runMaterializedCohortOptions,
} from "../_shared/clickhouse/cohortMembership.ts";
import type { CohortRequest } from "../_shared/clickhouse/cohortContract.ts";
import { fbAllocationDiagnosticsFeatureEnabled } from "../_shared/clickhouse/fbAllocationDiagnostics.ts";

const QUERY_TIMEOUT_MS = 25_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse cohort query timed out after ${ms}ms.`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: CohortRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as CohortRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  let action: ReturnType<typeof normalizeAction>;
  try {
    action = normalizeAction(request.action);
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "Unsupported action." }, 400);
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const ch = client;
    if (action === "options") {
      const materialized = await withTimeout(
        runMaterializedCohortOptions({ authUserId: auth.id, supabase: auth.supabase, clickhouse: ch, request }),
        QUERY_TIMEOUT_MS,
      );
      if (materialized) return jsonResponse(materialized);
      const result = await withTimeout(runCohortOptions({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS);
      return jsonResponse(result);
    }
    if (action === "details") {
      const result = await withTimeout(runCohortDetails({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS);
      return jsonResponse(result);
    }
    const materialized = await withTimeout(
      runMaterializedCohortList({
        authUserId: auth.id,
        supabase: auth.supabase,
        clickhouse: ch,
        request,
        allocationDiagnosticsEnabled: fbAllocationDiagnosticsFeatureEnabled(
          Deno.env.get("FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED"),
        ),
      }),
      QUERY_TIMEOUT_MS,
    );
    if (materialized) return jsonResponse(materialized);
    const result = await withTimeout(runCohortList({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS);
    return jsonResponse(result);
  } catch (error) {
    // Validation errors are client faults (400); everything else is a warehouse
    // fault (502). No SQL / credentials are ever included in the message.
    const status = error instanceof CohortRequestError ? 400 : 502;
    return jsonResponse(
      { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse cohort query failed." },
      status,
    );
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
