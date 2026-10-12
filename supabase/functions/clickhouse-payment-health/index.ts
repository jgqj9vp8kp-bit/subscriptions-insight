/* global Deno */

// clickhouse-payment-health: the Payment System Health page (plan sections J,
// M, N, R, S, X). Attempt quality, decline classes, retry compliance, refunds
// and complaints, data sources and filter options, computed server-side from
// analytics_transactions / fact_user_cohorts / fact_support_requests with
// CTE-only SQL over the workspace tenant (ctx.tenantKey, never the caller) and
// the psp_accounts registry for MID labels. Aggregates only: no emails, user
// ids, transaction ids, card fragments, tokens, IPs, raw MIDs or descriptors.
//
// Access is decided by CLICKHOUSE_PAYMENT_HEALTH_POLICY before the handler
// runs: every action needs payment_health.view; the PSP × MID / descriptor
// dimensions are returned only to callers with payment_health.psp_global.view
// (or the data owner) and a request naming them without it is 403.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CLICKHOUSE_PAYMENT_HEALTH_POLICY,
  paymentHealthErrorResponse,
  pspDimensionsVisible,
} from "../_shared/access/policies/clickhouse-payment-health.ts";
import { runPaymentHealth } from "../_shared/clickhouse/paymentHealth.ts";

// Same budget as clickhouse-payment-analytics: a cold ClickHouse Cloud wake can
// add ~20 s to the first request; the retries action fetches up to 300k rows.
const QUERY_TIMEOUT_MS = 55_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse payment-health query timed out after ${ms}ms.`)), ms)),
  ]);
}

serveWithAccess(
  CLICKHOUSE_PAYMENT_HEALTH_POLICY,
  async ({ ctx, action, body, clickhouse, pg }) =>
    await withTimeout(
      runPaymentHealth({
        tenantKey: ctx.tenantKey,
        clickhouse: clickhouse(),
        pg,
        // The canonical action, never the body's spelling; the body's other fields are the request.
        request: { ...body, action },
        pspVisible: pspDimensionsVisible(ctx),
      }),
      QUERY_TIMEOUT_MS,
    ),
  { onError: (error) => paymentHealthErrorResponse(error) },
);
