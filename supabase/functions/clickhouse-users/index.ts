/* global Deno */

// clickhouse-users: server-side Users / Payment Analytics read path. Runs the
// shared parity-proven classifier in ClickHouse, scoped to the authenticated
// user, and returns only user-level aggregates — never raw payloads, emails
// beyond the one the UI already shows, SQL, or credentials.

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import {
  normalizeUsersAction,
  runUsersDetails,
  runUsersList,
  runUsersOptions,
  runUsersSummary,
  UsersRequestError,
} from "../_shared/clickhouse/users.ts";
import type { UsersRequest } from "../_shared/clickhouse/usersContract.ts";

const QUERY_TIMEOUT_MS = 25_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse users query timed out after ${ms}ms.`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: UsersRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as UsersRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  let action: ReturnType<typeof normalizeUsersAction>;
  try {
    action = normalizeUsersAction(request.action);
  } catch (error) {
    return jsonResponse({ ok: false, error: error instanceof Error ? error.message : "Unsupported action." }, 400);
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const ch = client;
    if (action === "options") return jsonResponse(await withTimeout(runUsersOptions({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS));
    if (action === "summary") return jsonResponse(await withTimeout(runUsersSummary({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS));
    if (action === "details") return jsonResponse(await withTimeout(runUsersDetails({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS));
    return jsonResponse(await withTimeout(runUsersList({ authUserId: auth.id, clickhouse: ch, request }), QUERY_TIMEOUT_MS));
  } catch (error) {
    const status = error instanceof UsersRequestError ? 400 : 502;
    return jsonResponse({ ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse users query failed." }, status);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
