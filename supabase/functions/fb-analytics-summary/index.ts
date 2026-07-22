/* global Deno */

// fb-analytics-summary: server-side FB Analytics compute. Loads the SAME cloud
// snapshots the browser restores (palmer / funnelfox_subscriptions /
// facebook_traffic) plus the user's Capsuled rows, and runs the exact in-app
// buildFbAnalytics from _shared. Returns aggregated rows/summary/meta only —
// never raw payloads, emails or credentials. Parity-first: shipped behind the
// client flag VITE_FB_ANALYTICS_SOURCE, default off.

import { decompressFromEncodedURIComponent } from "https://esm.sh/lz-string@1.5.0";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { resolveSnapshotEnvelope } from "../_shared/clickhouse/snapshotEnvelope.ts";
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

async function loadCapsuledRows(supabase: SupabaseLikeClient, authUserId: string): Promise<CapsuledFacebookRow[]> {
  // Mirrors the client's listCapsuledFacebookRows: same columns, same order, same limit —
  // capsuledRowsByCampaign merges rows in array order, so ordering is part of parity.
  const { data, error } = await supabase
    .from("capsuled_facebook_stats")
    .select(
      "date_from,date_to,level,campaign_id,campaign_name,ad_account_id,ad_account_name,spend,fb_purchases,cpp,impressions,clicks,ctr,cpc,cpm,outbound_clicks,outbound_ctr,currency,last_import_at,raw_payload",
    )
    .eq("user_id", authUserId)
    .order("last_import_at", { ascending: false })
    .limit(CAPSULED_ROWS_LIMIT);
  if (error) throw new Error(`Could not load Capsuled Facebook rows: ${error.message}`);
  return (data ?? []) as CapsuledFacebookRow[];
}

function resolvePayload(row: SnapshotRow | undefined): unknown {
  if (!row) return null;
  return resolveSnapshotEnvelope<unknown>(row.payload, decompressFromEncodedURIComponent);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: FbAnalyticsSummaryRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as FbAnalyticsSummaryRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  try {
    const [snapshots, capsuledRows] = await Promise.all([
      loadSnapshots(auth.supabase, auth.id),
      loadCapsuledRows(auth.supabase, auth.id),
    ]);
    const palmer = snapshots.get("palmer");
    const subscriptions = snapshots.get("funnelfox_subscriptions");
    const traffic = snapshots.get("facebook_traffic");

    const response = computeFbAnalyticsSummary({
      palmerPayload: resolvePayload(palmer),
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
    return jsonResponse(response);
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : "FB analytics summary failed." },
      500,
    );
  }
});
