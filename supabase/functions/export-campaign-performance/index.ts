/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { buildCampaignPerformanceRows, summarizeBatchLoad, type ComputeTxn } from "./compute.ts";
import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { loadExportTransactions } from "../_shared/clickhouse/exportCampaignSource.ts";

type ApiKeyRecord = {
  id: string;
  user_id: string;
  prefix: string;
  is_active: boolean;
  revoked_at: string | null;
  allowed_scopes: string[] | null;
};

const API_SCOPE = "campaign_performance:read";
const API_KEY_PREFIX = "subengine_live_";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

// Most recent import batch for the account — used only to report how many loaded rows fall outside
// it (diagnostics), never to filter the data the API computes on. Stays on Postgres: it is a single
// row, and import_batches is the source of truth for CSV ingestion.
async function loadLatestBatchId(client: ReturnType<typeof createClient>, userId: string): Promise<string | null> {
  const { data, error } = await client
    .from("import_batches")
    .select("id")
    .eq("user_id", userId)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id?: string }).id ?? null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "API export is not configured." }, 500);

  const rawKey = bearerToken(req);
  if (!rawKey || !rawKey.startsWith(API_KEY_PREFIX)) return jsonResponse({ error: "Invalid API key." }, 401);

  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });
  const keyHash = await sha256Hex(rawKey);
  const { data: apiKey, error: keyError } = await client
    .from("api_keys")
    .select("id,user_id,prefix,is_active,revoked_at,allowed_scopes")
    .eq("key_hash", keyHash)
    .maybeSingle();
  const key = apiKey as ApiKeyRecord | null;
  if (keyError || !key || !key.is_active || key.revoked_at || !key.allowed_scopes?.includes(API_SCOPE)) {
    return jsonResponse({ error: "Invalid API key." }, 401);
  }

  const url = new URL(req.url);
  const params = url.searchParams;
  const logBase = {
    api_key_id: key.id,
    user_id: key.user_id,
    endpoint: "export-campaign-performance",
    params: Object.fromEntries(params.entries()),
    key_prefix: key.prefix,
  };

  // The transaction history is read from the ClickHouse warehouse, not from the
  // Postgres JSON payloads. See _shared/clickhouse/exportCampaignSource.ts for the
  // measurements: the old Postgres read was ~401 MB / ~119 s for this account and
  // the runtime killed the invocation before the catch below could log anything.
  let clickhouse: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    await client.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id);
    clickhouse = createClickHouseClient();
    const [txs, latestBatchId] = await Promise.all([
      loadExportTransactions(clickhouse, key.user_id) as Promise<ComputeTxn[]>,
      loadLatestBatchId(client, key.user_id),
    ]);
    // Facebook spend is no longer exported, so spend / cac / roas stay null — the
    // same value the contract already returned whenever no traffic snapshot
    // existed (API_EXPORT.md documents them as nullable). The response shape is
    // unchanged so existing consumers keep parsing successfully.
    const traffic: [] = [];
    const rows = buildCampaignPerformanceRows({
      txs,
      traffic,
      params: {
        date_from: params.get("date_from"),
        date_to: params.get("date_to"),
        campaign_path: params.get("campaign_path"),
        media_buyer: params.get("media_buyer"),
        campaign_id: params.get("campaign_id"),
      },
    });
    const batchLoad = summarizeBatchLoad(txs, latestBatchId);
    await client.from("api_export_logs").insert({ ...logBase, status_code: 200, rows_returned: rows.length });
    return jsonResponse({
      data: rows,
      meta: {
        date_from: dateKey(params.get("date_from")),
        date_to: dateKey(params.get("date_to")),
        rows: rows.length,
        traffic_rows: traffic.length,
        transactions_loaded: batchLoad.transactions_loaded,
        import_batches_loaded: batchLoad.import_batches_loaded,
        latest_batch_rows: batchLoad.latest_batch_rows,
        rows_outside_latest_batch: batchLoad.rows_outside_latest_batch,
        generated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed.";
    await client.from("api_export_logs").insert({
      ...logBase,
      status_code: 500,
      rows_returned: 0,
      error_message: message,
    });
    return jsonResponse({ error: "Export failed." }, 500);
  } finally {
    await clickhouse?.close?.().catch(() => undefined);
  }
});
