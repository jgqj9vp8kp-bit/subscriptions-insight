/* global Deno */

// clickhouse-revenue: the Dashboard Revenue Intelligence read path — the
// calendar projection ("when did the money arrive, which cohorts produced
// it") of the same cohort-revenue facts clickhouse-cohorts serves. Runs the
// parity-proven classifier SQL in ClickHouse scoped to the authenticated
// user; returns aggregates and diagnostics only — never raw payloads, emails,
// transaction ids, SQL, or credentials.

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import {
  RevenueRequestError,
  runRevenueDayBreakdown,
  runRevenueIntelligence,
} from "../_shared/clickhouse/revenueIntelligence.ts";
import type { RevenueIntelligenceRequest } from "../_shared/clickhouse/revenueIntelligenceContract.ts";

const QUERY_TIMEOUT_MS = 25_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse revenue query timed out after ${ms}ms.`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: RevenueIntelligenceRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as RevenueIntelligenceRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const common = { authUserId: auth.id, supabase: auth.supabase, clickhouse: client, request };
    if (request.action === "day_breakdown") {
      return jsonResponse(await withTimeout(runRevenueDayBreakdown(common), QUERY_TIMEOUT_MS));
    }
    return jsonResponse(await withTimeout(runRevenueIntelligence(common), QUERY_TIMEOUT_MS));
  } catch (error) {
    const status = error instanceof RevenueRequestError ? 400 : 502;
    return jsonResponse(
      { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse revenue query failed." },
      status,
    );
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
