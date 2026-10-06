/* global Deno */

// clickhouse-users: server-side Users / Payment Analytics read path. Runs the
// shared parity-proven classifier in ClickHouse over the workspace data
// (ctx.tenantKey, never the caller) and returns only user-level aggregates —
// never raw payloads, emails beyond the one the UI already shows, SQL, or
// credentials. Access is decided by CLICKHOUSE_USERS_POLICY before the handler
// runs (Phase 1: users.view + users.pii.view, details also users.details.view;
// funnel-restricted members are refused).

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { CLICKHOUSE_USERS_POLICY } from "../_shared/access/policies/clickhouse-users.ts";
import {
  runUsersDecline,
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

serveWithAccess(
  CLICKHOUSE_USERS_POLICY,
  async ({ ctx, action, body, clickhouse }) => {
    const input = { authUserId: ctx.tenantKey, clickhouse: clickhouse(), request: body as UsersRequest };
    if (action === "options") return await withTimeout(runUsersOptions(input), QUERY_TIMEOUT_MS);
    if (action === "summary") return await withTimeout(runUsersSummary(input), QUERY_TIMEOUT_MS);
    if (action === "details") return await withTimeout(runUsersDetails(input), QUERY_TIMEOUT_MS);
    if (action === "decline") return await withTimeout(runUsersDecline(input), QUERY_TIMEOUT_MS);
    return await withTimeout(runUsersList(input), QUERY_TIMEOUT_MS);
  },
  {
    // Same status / body as before access control; the gate sanitizes the
    // body for everyone but the data owner.
    onError: (error) => ({
      status: error instanceof UsersRequestError ? 400 : 502,
      body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse users query failed." },
    }),
  },
);
