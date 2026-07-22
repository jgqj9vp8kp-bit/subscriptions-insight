// Server-side FB Analytics summary: assembles the EXACT inputs the FBAnalytics page
// feeds into buildFbAnalytics — from the same cloud snapshots the client restores —
// and runs the same compute verbatim. Parity-first: no reinterpretation of formulas.
//
// Input chain reproduced from src/pages/FBAnalytics.tsx:
//   store.setImported: txs = backfillTransactionCardTypesFromRawRows(payload.transactions, rawRows)
//   page: enrichedTxs = enrichTransactionDeclinesFromRawRows(backfill(txs, rawRows), rawRows)
// backfill only fills rows whose card_type is missing/"unknown", so applying it once here
// is byte-equal to the store+page double application.

import type { SubscriptionClean } from "./subscriptionTypes.ts";
import type { CapsuledFacebookRow, TrafficMetric } from "./trafficMetric.ts";
import { backfillTransactionCardTypesFromRawRows, type RawPalmerRow } from "./palmerTransform.ts";
import { enrichTransactionDeclinesFromRawRows } from "./paymentFailures.ts";
import { aggregateTrafficMetrics } from "./cohortReporting.ts";
import {
  buildFbAnalytics,
  type FbAnalyticsFilters,
  type FbAnalyticsRow,
  type FbAnalyticsSummary,
} from "./fbAnalyticsCompute.ts";
import { normalizePalmerCloudPayload } from "./palmerCloudSnapshot.ts";

export const FB_ANALYTICS_SUMMARY_FUNCTION = "fb-analytics-summary";

export interface FbAnalyticsSummaryRequest {
  filters?: FbAnalyticsFilters;
}

/** Input fingerprints so a parity check can tell formula divergence from input skew. */
export interface FbAnalyticsSummaryMeta {
  transactions: number;
  raw_palmer_rows: number;
  subscriptions: number;
  traffic_rows: number;
  capsuled_rows: number;
  capsuled_campaign_rows: number;
  palmer_snapshot_updated_at: string | null;
  subscriptions_snapshot_updated_at: string | null;
  traffic_snapshot_updated_at: string | null;
}

export interface FbAnalyticsSummaryResponse {
  ok: true;
  rows: FbAnalyticsRow[];
  summary: FbAnalyticsSummary;
  meta: FbAnalyticsSummaryMeta;
}

export interface FbAnalyticsSummarySnapshotTimestamps {
  palmer?: string | null;
  subscriptions?: string | null;
  traffic?: string | null;
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

export function computeFbAnalyticsSummary(input: {
  palmerPayload: unknown;
  subscriptionsPayload: unknown;
  trafficPayload: unknown;
  capsuledRows: CapsuledFacebookRow[];
  filters?: FbAnalyticsFilters;
  snapshotUpdatedAt?: FbAnalyticsSummarySnapshotTimestamps;
}): FbAnalyticsSummaryResponse {
  const palmer = normalizePalmerCloudPayload(input.palmerPayload);
  const baseTxs = palmer?.transactions ?? [];
  const rawRows: RawPalmerRow[] = palmer?.rawPalmerRows ?? [];
  const txs = enrichTransactionDeclinesFromRawRows(
    backfillTransactionCardTypesFromRawRows(baseTxs, rawRows),
    rawRows,
  );

  const subscriptions = subscriptionsFromPayload(input.subscriptionsPayload);
  const trafficMetrics = trafficMetricsFromPayload(input.trafficPayload);
  const trafficByKey = aggregateTrafficMetrics(trafficMetrics);
  // The page passes only campaign-level Capsuled rows into buildFbAnalytics.
  const campaignRows = input.capsuledRows.filter((row) => row.level === "campaign");

  const { rows, summary } = buildFbAnalytics({
    txs,
    subscriptions,
    trafficByKey,
    capsuledRows: campaignRows,
    filters: input.filters,
  });

  return {
    ok: true,
    rows,
    summary,
    meta: {
      transactions: baseTxs.length,
      raw_palmer_rows: rawRows.length,
      subscriptions: subscriptions.length,
      traffic_rows: trafficMetrics.length,
      capsuled_rows: input.capsuledRows.length,
      capsuled_campaign_rows: campaignRows.length,
      palmer_snapshot_updated_at: input.snapshotUpdatedAt?.palmer ?? null,
      subscriptions_snapshot_updated_at: input.snapshotUpdatedAt?.subscriptions ?? null,
      traffic_snapshot_updated_at: input.snapshotUpdatedAt?.traffic ?? null,
    },
  };
}

// --- Parity guard --------------------------------------------------------------

export interface FbAnalyticsSummaryMismatch {
  metric: keyof FbAnalyticsSummary;
  server: number | null;
  client: number | null;
}

const SUMMARY_ABS_TOLERANCE = 0.01;

/** Compare server and client summaries. Money/ratio values tolerate $0.01 / 0.01
 * (round-trip serialization); counts must match exactly. */
export function reconcileFbAnalyticsSummaries(
  server: FbAnalyticsSummary,
  client: FbAnalyticsSummary,
): FbAnalyticsSummaryMismatch[] {
  const mismatches: FbAnalyticsSummaryMismatch[] = [];
  const keys = new Set([...Object.keys(server), ...Object.keys(client)]) as Set<keyof FbAnalyticsSummary>;
  for (const key of keys) {
    const a = server[key];
    const b = client[key];
    if (a == null || b == null) {
      if (a !== b) mismatches.push({ metric: key, server: a ?? null, client: b ?? null });
      continue;
    }
    if (Math.abs(a - b) > SUMMARY_ABS_TOLERANCE) {
      mismatches.push({ metric: key, server: a, client: b });
    }
  }
  return mismatches;
}
