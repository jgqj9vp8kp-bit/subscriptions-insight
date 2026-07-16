/* global Deno */

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import {
  getCohortSnapshotState,
  rebuildCohortMembership,
  validateCohortMembership,
} from "../_shared/clickhouse/cohortMembership.ts";

type Action = "status" | "rebuild" | "validate";

const QUERY_TIMEOUT_MS = 55_000;

function actionFromBody(body: Record<string, unknown>): Action {
  return body.action === "rebuild" || body.action === "validate" ? body.action : "status";
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse cohort membership action timed out after ${ms}ms.`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed("GET, POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      body = await parseJsonBody<Record<string, unknown>>(req);
    } catch {
      return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
    }
  }
  const action = actionFromBody(body);

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    if (action === "rebuild") {
      const result = await withTimeout(
        rebuildCohortMembership({
          authUserId: auth.id,
          supabase: auth.supabase,
          clickhouse: client,
          force: Boolean(body.force),
        }),
        QUERY_TIMEOUT_MS,
      );
      return jsonResponse({ ok: true, action, ...result });
    }
    if (action === "validate") {
      const result = await withTimeout(
        validateCohortMembership({ authUserId: auth.id, supabase: auth.supabase, clickhouse: client }),
        QUERY_TIMEOUT_MS,
      );
      return jsonResponse({ ok: true, action, ...result });
    }
    const state = await getCohortSnapshotState(auth.supabase, auth.id);
    return jsonResponse({ ok: true, action, state });
  } catch (error) {
    return jsonResponse({
      ok: false,
      action,
      error: error instanceof Error ? error.message : "ClickHouse cohort membership action failed.",
    }, 502);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
