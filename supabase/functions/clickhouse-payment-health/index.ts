/* global Deno */

// clickhouse-payment-health: the Payment System Health page (plan sections J,
// M, N, R, S, X) and its alerts (P2.5, plan Q). Attempt quality, decline
// classes, retry compliance, refunds and complaints, data sources and filter
// options, computed server-side from analytics_transactions /
// fact_user_cohorts / fact_support_requests with CTE-only SQL over the
// workspace tenant (ctx.tenantKey, never the caller) and the psp_accounts
// registry for MID labels. Aggregates only: no emails, user ids, transaction
// ids, card fragments, tokens, IPs, raw MIDs or descriptors.
//
// Alerts: alerts_list (payment_health.view), alert_update and alerts_run
// (payment_health.manage_alerts) and the daily alerts_tick (pg_cron with
// x-cron-secret) — paymentRiskAlerts.ts, which evaluates the rules from the
// page's own actions and writes payment_risk_alerts through service-role SQL
// functions only.
//
// Access is decided by CLICKHOUSE_PAYMENT_HEALTH_POLICY before the handler
// runs: every page action needs payment_health.view; the PSP × MID /
// descriptor dimensions (and the PSP-scoped alerts) are returned only to
// callers with payment_health.psp_global.view (or the data owner) and a
// request naming them without it is 403.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CLICKHOUSE_PAYMENT_HEALTH_POLICY,
  alertsManageable,
  paymentHealthErrorResponse,
  pspDimensionsVisible,
} from "../_shared/access/policies/clickhouse-payment-health.ts";
import { runPaymentHealth } from "../_shared/clickhouse/paymentHealth.ts";
import { runPaymentAlertsAction } from "../_shared/clickhouse/paymentRiskAlerts.ts";
import { isPaymentAlertAction } from "../_shared/clickhouse/paymentRiskAlertsContract.ts";

// Same budget as clickhouse-payment-analytics: a cold ClickHouse Cloud wake can
// add ~20 s to the first request; the retries action fetches up to 300k rows.
const QUERY_TIMEOUT_MS = 55_000;
// An alert run reads several of the page's actions in one request (overview x2,
// declines x2, retries, sources, the funnel splits): the Edge wall clock, not
// the page's budget, bounds it.
const ALERT_RUN_TIMEOUT_MS = 140_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`ClickHouse payment-health query timed out after ${ms}ms.`)), ms)),
  ]);
}

serveWithAccess(
  CLICKHOUSE_PAYMENT_HEALTH_POLICY,
  async ({ ctx, action, body, clickhouse, pg }) => {
    if (isPaymentAlertAction(action)) {
      const running = action === "alerts_run" || action === "alerts_tick";
      return await withTimeout(
        runPaymentAlertsAction({
          action,
          tenantKey: ctx.tenantKey,
          actorUserId: ctx.actor.userId,
          pspVisible: pspDimensionsVisible(ctx),
          canManage: alertsManageable(ctx),
          requestId: ctx.requestId,
          body,
          // The factory, not a reader: alerts_list / alert_update never open ClickHouse.
          clickhouse,
          pg,
        }),
        running ? ALERT_RUN_TIMEOUT_MS : QUERY_TIMEOUT_MS,
      );
    }
    return await withTimeout(
      runPaymentHealth({
        tenantKey: ctx.tenantKey,
        clickhouse: clickhouse(),
        pg,
        // The canonical action, never the body's spelling; the body's other fields are the request.
        request: { ...body, action },
        pspVisible: pspDimensionsVisible(ctx),
      }),
      QUERY_TIMEOUT_MS,
    );
  },
  { onError: (error) => paymentHealthErrorResponse(error) },
);
