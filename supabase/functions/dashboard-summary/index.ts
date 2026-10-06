/* global Deno */

// dashboard-summary: server-side Dashboard compute. Transactions come from the
// Supabase warehouse (the same source the browser store uses in production),
// falling back to the palmer cloud snapshot exactly like the client store does;
// subscriptions and traffic come from the same cloud snapshots the browser
// restores. Runs the exact in-app dashboard chain from _shared. Returns
// aggregated KPIs/trends/series only — never raw payloads, emails or credentials.
// Parity-first: shipped behind the client flag VITE_DASHBOARD_SOURCE, default off.
//
// Access: DASHBOARD_SUMMARY_POLICY — data owner only (rawOnly + dashboard.view).
// The inputs are whole-tenant raw tables, read for ctx.tenantKey.

import { decompressFromEncodedURIComponent } from "https://esm.sh/lz-string@1.5.0";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { DASHBOARD_SUMMARY_POLICY } from "../_shared/access/policies/dashboard-summary.ts";
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

async function loadSnapshots(supabase: SupabaseLikeClient, tenantKey: string): Promise<Map<string, SnapshotRow>> {
  const { data, error } = await supabase
    .from("data_snapshots")
    .select("dataset_type,payload,updated_at")
    .eq("user_id", tenantKey)
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

serveWithAccess(
  DASHBOARD_SUMMARY_POLICY,
  async ({ ctx, body, pg }) => {
    const request = body as DashboardSummaryRequest;
    const snapshots = await loadSnapshots(pg, ctx.tenantKey);
    const source = await resolveServerTransactions({
      supabase: pg,
      authUserId: ctx.tenantKey,
      palmerPayload: resolvePayload(snapshots.get("palmer")),
    });
    return computeDashboardSummary({
      transactions: source.transactions,
      transactionsSource: source.source,
      subscriptions: subscriptionsFromPayload(resolvePayload(snapshots.get("funnelfox_subscriptions"))),
      trafficMetrics: trafficMetricsFromPayload(resolvePayload(snapshots.get("facebook_traffic"))),
      filters: request.filters,
    });
  },
  {
    // Same status / body as before access control.
    onError: (error) => ({
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : "Dashboard summary failed." },
    }),
  },
);
