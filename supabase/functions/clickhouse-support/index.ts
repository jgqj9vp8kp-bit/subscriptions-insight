/* global Deno */

// clickhouse-support: server-side Support Analytics read path and Supabase-to-
// ClickHouse synchronization. The browser never runs analytics SQL,
// classification, grouping, or statistics; it only receives aggregate bundles,
// paged rows, and one opened request detail.

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import {
  normalizeSupportRequest,
  runSupportBundle,
  runSupportDetails,
  runSupportList,
  runSupportOptions,
  runSupportStatus,
  runSupportSync,
  SupportRequestError,
} from "../_shared/clickhouse/support.ts";
import type { SupportRequest } from "../_shared/clickhouse/supportContract.ts";

const QUERY_TIMEOUT_MS = 55_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse support request timed out after ${ms}ms.`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: SupportRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as SupportRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  let action: ReturnType<typeof normalizeSupportRequest>["action"];
  try {
    action = normalizeSupportRequest(request).action;
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "Unsupported support action." }, 400);
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const common = { authUserId: auth.id, clickhouse: client };
    if (action === "sync") return jsonResponse(await withTimeout(runSupportSync({ ...common, supabase: auth.supabase, request }), QUERY_TIMEOUT_MS));
    if (action === "status") return jsonResponse(await withTimeout(runSupportStatus({ ...common, supabase: auth.supabase }), QUERY_TIMEOUT_MS));
    if (action === "options") return jsonResponse(await withTimeout(runSupportOptions(common), QUERY_TIMEOUT_MS));
    if (action === "list") return jsonResponse(await withTimeout(runSupportList({ ...common, request }), QUERY_TIMEOUT_MS));
    if (action === "details") return jsonResponse(await withTimeout(runSupportDetails({ ...common, request }), QUERY_TIMEOUT_MS));
    return jsonResponse(await withTimeout(runSupportBundle({ ...common, supabase: auth.supabase, request }), QUERY_TIMEOUT_MS));
  } catch (error) {
    const status = error instanceof SupportRequestError ? 400 : 502;
    return jsonResponse({
      ok: false,
      source: "clickhouse",
      error: error instanceof Error ? error.message : "ClickHouse support request failed.",
    }, status);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
