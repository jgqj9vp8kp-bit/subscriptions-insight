/* global Deno */

// dashboard-summary: server-side Dashboard compute. Transactions come from the
// Supabase warehouse (the same source the browser store uses in production),
// falling back to the palmer cloud snapshot exactly like the client store does;
// subscriptions and traffic come from the same cloud snapshots the browser
// restores. Runs the exact in-app dashboard chain from _shared. Returns
// aggregated KPIs/trends/series only — never raw payloads, emails or credentials.
// Parity-first: shipped behind the client flag VITE_DASHBOARD_SOURCE, default off.

import { decompressFromEncodedURIComponent } from "https://esm.sh/lz-string@1.5.0";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { resolveSnapshotEnvelope } from "../_shared/clickhouse/snapshotEnvelope.ts";
import { resolveServerTransactions } from "../_shared/clickhouse/serverTransactionsSource.ts";
import {
  computeDashboardSummary,
  type DashboardSummaryRequest,
} from "../_shared/clickhouse/dashboardSummary.ts";
import type { SubscriptionClean } from "../_shared/clickhouse/subscriptionTypes.ts";
import type { TrafficMetric } from "../_shared/clickhouse/trafficMetric.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

interface SnapshotRow {
  dataset_type: string;
  payload: unknown;
  updated_at: string | null;
}

async function loadSnapshots(supabase: SupabaseLikeClient, authUserId: string): Promise<Map<string, SnapshotRow>> {
  const { data, error } = await supabase
    .from("data_snapshots")
    .select("dataset_type,payload,updated_at")
    .eq("user_id", authUserId)
    .in("dataset_type", ["palmer", "funnelfox_subscriptions", "facebook_traffic"]);
  if (error) throw new Error(`Could not load data snapshots: ${error.message}`);
  const byType = new Map<string, SnapshotRow>();
  for (const row of (data ?? []) as SnapshotRow[]) byType.set(row.dataset_type, row);
  return byType;
}

function resolvePayload(row: SnapshotRow | undefined): unknown {
  if (!row) return null;
  return resolveSnapshotEnvelope<unknown>(row.payload, decompressFromEncodedURIComponent);
}

function subscriptionsFromPayload(payload: unknown): SubscriptionClean[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const subscriptions = (payload as Record<string, unknown>).subscriptions;
  return Array.isArray(subscriptions) ? (subscriptions as SubscriptionClean[]) : [];
}

function trafficMetricsFromPayload(payload: unknown): TrafficMetric[] {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const trafficMetrics = (payload as Record<string, unknown>).trafficMetrics;
  return Array.isArray(trafficMetrics) ? (trafficMetrics as TrafficMetric[]) : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: DashboardSummaryRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as DashboardSummaryRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  try {
    const snapshots = await loadSnapshots(auth.supabase, auth.id);
    const source = await resolveServerTransactions({
      supabase: auth.supabase,
      authUserId: auth.id,
      palmerPayload: resolvePayload(snapshots.get("palmer")),
    });
    const response = computeDashboardSummary({
      transactions: source.transactions,
      transactionsSource: source.source,
      subscriptions: subscriptionsFromPayload(resolvePayload(snapshots.get("funnelfox_subscriptions"))),
      trafficMetrics: trafficMetricsFromPayload(resolvePayload(snapshots.get("facebook_traffic"))),
      filters: request.filters,
    });
    return jsonResponse(response);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : "Dashboard summary failed." },
      500,
    );
  }
});
