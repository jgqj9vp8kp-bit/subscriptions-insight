/* global Deno */

// clickhouse-users: server-side Users / Payment Analytics read path. Runs the
// shared parity-proven classifier in ClickHouse over the workspace data
// (ctx.tenantKey, never the caller) and returns only user-level aggregates —
// never raw payloads, emails beyond the one the UI already shows, SQL, or
// credentials. Access is decided by CLICKHOUSE_USERS_POLICY before the handler
// runs (Phase 1: users.view + users.pii.view, details also users.details.view;
// funnel-restricted members are refused).
//
// The Leads tab rides the same function (its isolate is already warm on
// /users): leads_list / leads_overview merge the warehouse leads (ClickHouse)
// with the FunnelFox profile / subscription candidates (Postgres RPC, via the
// gate's service-role client, tenant = ctx.tenantKey) — see
// _shared/clickhouse/leads.ts. Data owner only (rawOnly + leads.view).

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
import { runLeadsList, runLeadsOverview } from "../_shared/clickhouse/leads.ts";
import { LeadsRequestError } from "../_shared/clickhouse/leadsContract.ts";
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
  async ({ ctx, action, body, clickhouse, pg }) => {
    // Leads first: the Users runners reject any action they do not know.
    if (action === "leads_list" || action === "leads_overview") {
      const leadsInput = { tenantKey: ctx.tenantKey, clickhouse: clickhouse(), pg, request: body };
      const work = action === "leads_list" ? runLeadsList(leadsInput) : runLeadsOverview(leadsInput);
      return await withTimeout<unknown>(work, QUERY_TIMEOUT_MS);
    }
    const input = { authUserId: ctx.tenantKey, clickhouse: clickhouse(), request: body as UsersRequest };
    if (action === "options") return await withTimeout(runUsersOptions(input), QUERY_TIMEOUT_MS);
    if (action === "summary") return await withTimeout(runUsersSummary(input), QUERY_TIMEOUT_MS);
    if (action === "details") return await withTimeout(runUsersDetails(input), QUERY_TIMEOUT_MS);
    if (action === "decline") return await withTimeout(runUsersDecline(input), QUERY_TIMEOUT_MS);
    return await withTimeout(runUsersList(input), QUERY_TIMEOUT_MS);
  },
  {
    // Same status / body as before access control; the gate sanitizes the
    // body for everyone but the data owner. A malformed leads request is a 400
    // like a malformed users request.
    onError: (error) => ({
      status: error instanceof UsersRequestError || error instanceof LeadsRequestError ? 400 : 502,
      body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse users query failed." },
    }),
  },
);
