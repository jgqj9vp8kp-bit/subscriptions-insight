/* global Deno */

// clickhouse-revenue: the Dashboard Revenue Intelligence read path — the
// calendar projection ("when did the money arrive, which cohorts produced
// it") of the same cohort-revenue facts clickhouse-cohorts serves. Runs the
// parity-proven classifier SQL in ClickHouse over the workspace data
// (ctx.tenantKey, never the caller); returns aggregates and diagnostics only —
// never raw payloads, emails, transaction ids, SQL, or credentials. Access is
// decided by CLICKHOUSE_REVENUE_POLICY (dashboard.view). A funnel-restricted
// member's request is shaped first (campaign_path include list intersected
// with their paths), the runners read with the request's `scope` (their
// customers only, unattributed and spend streams never queried), and the body
// carries meta.access.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CLICKHOUSE_REVENUE_POLICY,
  restrictRevenueRequest,
  withRestrictedMeta,
} from "../_shared/access/policies/clickhouse-revenue.ts";
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
  async ({ ctx, action, body, pg, clickhouse, scope }) => {
    // Restricted: the include list is intersected before any SQL.
    const shaped = ctx.restricted ? restrictRevenueRequest(scope, body) : { request: body as RevenueIntelligenceRequest, dropped: 0 };
    // pg is the service-role client; the snapshot-state read inside the
    // runners is keyed by the tenant key passed here (restricted requests read
    // the snapshot the gate validated instead).
    const common = { authUserId: ctx.tenantKey, supabase: pg, clickhouse: clickhouse(), request: shaped.request, scope };
    const result = action === "day_breakdown"
      ? await withTimeout(runRevenueDayBreakdown(common), QUERY_TIMEOUT_MS)
      : await withTimeout(runRevenueIntelligence(common), QUERY_TIMEOUT_MS);
    return ctx.restricted ? withRestrictedMeta(result, shaped.dropped) : result;
  },
  {
    // Same status / body as before access control; the gate sanitizes the
    // body for everyone but the data owner, and maps scope refusals (403 /
    // 409) before this runs.
    onError: (error) => ({
      status: error instanceof RevenueRequestError ? 400 : 502,
      body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse revenue query failed." },
    }),
  },
);
