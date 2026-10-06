/* global Deno */

// fb-analytics-summary: server-side FB Analytics compute. Loads the SAME cloud
// snapshots the browser restores (palmer / funnelfox_subscriptions /
// facebook_traffic) plus the workspace's Capsuled rows, and runs the exact
// in-app buildFbAnalytics from _shared. Returns aggregated rows/summary/meta
// only — never raw payloads, emails or credentials. Parity-first: shipped
// behind the client flag VITE_FB_ANALYTICS_SOURCE, default off.
//
// Access: FB_ANALYTICS_SUMMARY_POLICY — data owner only (rawOnly +
// facebook_analytics.view). The inputs are whole-tenant raw tables, read for
// ctx.tenantKey.

import { decompressFromEncodedURIComponent } from "https://esm.sh/lz-string@1.5.0";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { FB_ANALYTICS_SUMMARY_POLICY } from "../_shared/access/policies/fb-analytics-summary.ts";
import { resolveSnapshotEnvelope } from "../_shared/clickhouse/snapshotEnvelope.ts";
import { resolveServerTransactions } from "../_shared/clickhouse/serverTransactionsSource.ts";
import {
  computeFbAnalyticsSummary,
  type FbAnalyticsSummaryRequest,
} from "../_shared/clickhouse/fbAnalyticsSummary.ts";
import type { CapsuledFacebookRow } from "../_shared/clickhouse/trafficMetric.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

const CAPSULED_ROWS_LIMIT = 5000;

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

async function loadCapsuledRows(supabase: SupabaseLikeClient, tenantKey: string): Promise<CapsuledFacebookRow[]> {
  // Mirrors the client's listCapsuledFacebookRows: same columns, same order, same limit —
  // capsuledRowsByCampaign merges rows in array order, so ordering is part of parity.
  const { data, error } = await supabase
    .from("capsuled_facebook_stats")
    .select(
      "date_from,date_to,level,campaign_id,campaign_name,ad_account_id,ad_account_name,spend,fb_purchases,cpp,impressions,clicks,ctr,cpc,cpm,outbound_clicks,outbound_ctr,currency,last_import_at,raw_payload",
    )
    .eq("user_id", tenantKey)
    .order("last_import_at", { ascending: false })
    .limit(CAPSULED_ROWS_LIMIT);
  if (error) throw new Error(`Could not load Capsuled Facebook rows: ${error.message}`);
  return (data ?? []) as CapsuledFacebookRow[];
}

function resolvePayload(row: SnapshotRow | undefined): unknown {
  if (!row) return null;
  return resolveSnapshotEnvelope<unknown>(row.payload, decompressFromEncodedURIComponent);
}

serveWithAccess(
  FB_ANALYTICS_SUMMARY_POLICY,
  async ({ ctx, body, pg }) => {
    const request = body as FbAnalyticsSummaryRequest;
    const [snapshots, capsuledRows] = await Promise.all([
      loadSnapshots(pg, ctx.tenantKey),
      loadCapsuledRows(pg, ctx.tenantKey),
    ]);
    const palmer = snapshots.get("palmer");
    const subscriptions = snapshots.get("funnelfox_subscriptions");
    const traffic = snapshots.get("facebook_traffic");

    const source = await resolveServerTransactions({
      supabase: pg,
      authUserId: ctx.tenantKey,
      palmerPayload: resolvePayload(palmer),
    });
    return computeFbAnalyticsSummary({
      transactions: source.transactions,
      transactionsSource: source.source,
      rawPalmerRows: source.rawPalmerRows,
      subscriptionsPayload: resolvePayload(subscriptions),
      trafficPayload: resolvePayload(traffic),
      capsuledRows,
      filters: request.filters,
      snapshotUpdatedAt: {
        palmer: palmer?.updated_at ?? null,
        subscriptions: subscriptions?.updated_at ?? null,
        traffic: traffic?.updated_at ?? null,
      },
    });
  },
  {
    // Same status / body as before access control.
    onError: (error) => ({
      status: 500,
      body: { ok: false, error: error instanceof Error ? error.message : "FB analytics summary failed." },
    }),
  },
);
