/* global Deno */

// clickhouse-revenue: the Dashboard Revenue Intelligence read path — the
// calendar projection ("when did the money arrive, which cohorts produced
// it") of the same cohort-revenue facts clickhouse-cohorts serves. Runs the
// parity-proven classifier SQL in ClickHouse over the workspace data
// (ctx.tenantKey, never the caller); returns aggregates and diagnostics only —
// never raw payloads, emails, transaction ids, SQL, or credentials. Access is
// decided by CLICKHOUSE_REVENUE_POLICY (dashboard.view; funnel-restricted
// members are refused until the scoped path ships).

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { CLICKHOUSE_REVENUE_POLICY } from "../_shared/access/policies/clickhouse-revenue.ts";
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

serveWithAccess(
  CLICKHOUSE_REVENUE_POLICY,
  async ({ ctx, action, body, pg, clickhouse }) => {
    // pg is the service-role client; the snapshot-state read inside the
    // runners is keyed by the tenant key passed here.
    const common = { authUserId: ctx.tenantKey, supabase: pg, clickhouse: clickhouse(), request: body as RevenueIntelligenceRequest };
    if (action === "day_breakdown") return await withTimeout(runRevenueDayBreakdown(common), QUERY_TIMEOUT_MS);
    return await withTimeout(runRevenueIntelligence(common), QUERY_TIMEOUT_MS);
  },
  {
    // Same status / body as before access control; the gate sanitizes the
    // body for everyone but the data owner.
    onError: (error) => ({
      status: error instanceof RevenueRequestError ? 400 : 502,
      body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse revenue query failed." },
    }),
  },
);
