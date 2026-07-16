/* global Deno */

// clickhouse-payment-analytics: server-side Payment Pass Analytics. ClickHouse is
// the single source of truth for ALL metrics (decline_reason is canonical). Runs
// the shared parity-proven classifier + sequential stage state machine, scoped to
// the authenticated user. Returns aggregate-only bundles — never raw payloads,
// emails, ids, SQL, or credentials.

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { PaymentAnalyticsRequestError, runPaymentAnalytics } from "../_shared/clickhouse/paymentAnalytics.ts";
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: PaymentAnalyticsRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as PaymentAnalyticsRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const result = await withTimeout(runPaymentAnalytics({ authUserId: auth.id, clickhouse: client, request }), QUERY_TIMEOUT_MS);
    return jsonResponse(result);
  } catch (error) {
    const status = error instanceof PaymentAnalyticsRequestError ? 400 : 502;
    return jsonResponse({ ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse payment-analytics query failed." }, status);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
