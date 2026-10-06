/* global Deno */

// clickhouse-payment-analytics: server-side Payment Pass Analytics. ClickHouse is
// the single source of truth for ALL metrics (decline_reason is canonical). Runs
// the shared parity-proven classifier + sequential stage state machine over the
// workspace data (ctx.tenantKey, never the caller). Returns aggregate-only
// bundles — never raw payloads, emails, ids, SQL, or credentials.
//
// Access is decided by CLICKHOUSE_PAYMENT_ANALYTICS_POLICY before the handler
// runs: the bundle needs payment_pass.view, the Banks actions
// payment_pass.banks.view, and the AI pass-rate call ai.use on Cohorts / FB
// Analytics. An unrecognized action is a 400 — it no longer falls back to the
// bundle.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CLICKHOUSE_PAYMENT_ANALYTICS_POLICY,
  paymentPassFullBundleAllowed,
} from "../_shared/access/policies/clickhouse-payment-analytics.ts";
import { PaymentAnalyticsRequestError, runAiPassRates, runPaymentAnalytics } from "../_shared/clickhouse/paymentAnalytics.ts";
import { runBankAnalytics, runBankDetail } from "../_shared/clickhouse/bankAnalytics.ts";
import type { PaymentAnalyticsRequest } from "../_shared/clickhouse/paymentAnalytics.ts";

// Generous timeout: the bundle fans out ~20 classifier aggregations; cold-start
// (ClickHouse Cloud idle wake) can add ~20s to the first request.
const QUERY_TIMEOUT_MS = 55_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_r, reject) => setTimeout(() => reject(new Error(`ClickHouse payment-analytics query timed out after ${ms}ms.`)), ms)),
  ]);
}

serveWithAccess(
  CLICKHOUSE_PAYMENT_ANALYTICS_POLICY,
  async ({ ctx, action, body, clickhouse }) => {
    const request = body as PaymentAnalyticsRequest;
    const common = { authUserId: ctx.tenantKey, clickhouse: clickhouse() };
    if (action === "banks") return await withTimeout(runBankAnalytics({ ...common, request }), QUERY_TIMEOUT_MS);
    if (action === "bank_detail") return await withTimeout(runBankDetail({ ...common, request }), QUERY_TIMEOUT_MS);
    if (action === "ai_pass_rates") {
      return await withTimeout(runAiPassRates({ ...common, request, fullBundle: paymentPassFullBundleAllowed(ctx) }), QUERY_TIMEOUT_MS);
    }
    return await withTimeout(runPaymentAnalytics({ ...common, request }), QUERY_TIMEOUT_MS);
  },
  {
    // Same status / body as before access control; the gate sanitizes the
    // body for everyone but the data owner.
    onError: (error) => ({
      status: error instanceof PaymentAnalyticsRequestError ? 400 : 502,
      body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse payment-analytics query failed." },
    }),
  },
);
