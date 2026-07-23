/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { decompressFromEncodedURIComponent } from "https://esm.sh/lz-string@1.5.0";
import { buildCampaignPerformanceRows, collectPages, summarizeBatchLoad, type ComputeTxn } from "./compute.ts";
import { extractTrafficMetrics, type TrafficMetricLike } from "./aggregate.ts";

type TransactionStatus = "success" | "failed" | "refunded" | "chargeback";

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

function objectFrom(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Maps a stored warehouse row to the shape compute.ts expects. transaction_type is intentionally
// passed through unchanged — compute.ts re-derives it over the user's full history.
function hydrateTransaction(record: Record<string, unknown>): ComputeTxn | null {
  const payload = objectFrom(record.normalized_payload) ?? {};
  const raw = objectFrom(record.raw_payload) ?? {};
  const transactionId = normalize(payload.transaction_id ?? record.transaction_id);
  const eventTime = normalize(payload.event_time ?? record.event_time);
  if (!transactionId || !eventTime) return null;
  return {
    transaction_id: transactionId,
    user_id: normalize(payload.user_id ?? record.user_id ?? payload.email ?? transactionId),
    email: normalize(payload.email ?? record.email),
    event_time: eventTime,
    amount_usd: num(payload.amount_usd ?? record.amount_net ?? record.amount_gross),
    gross_amount_usd: num(payload.gross_amount_usd ?? record.amount_gross ?? payload.amount_usd),
    refund_amount_usd: num(payload.refund_amount_usd ?? record.amount_refunded),
    net_amount_usd: num(payload.net_amount_usd ?? record.amount_net ?? payload.amount_usd),
    is_refunded: Boolean(payload.is_refunded) || num(record.amount_refunded) > 0,
    status: normalize(payload.status ?? record.status) as TransactionStatus,
    transaction_type: normalize(payload.transaction_type ?? record.transaction_type),
    funnel: normalize(payload.funnel ?? record.funnel ?? "unknown"),
    campaign_path: normalize(payload.campaign_path ?? record.campaign_path ?? "unknown"),
    campaign_id: normalize(payload.campaign_id),
    utm_source: normalize(payload.utm_source) || null,
    classification_reason: normalize(payload.classification_reason),
    billing_reason: normalize(payload.billing_reason) || undefined,
    // Token-pack detection signals for the shared classifier.
    product: normalize(payload.product) || undefined,
    currency: normalize(payload.currency ?? record.currency) || undefined,
    source: normalize(record.source) || null,
    import_batch_id: normalize(record.import_batch_id) || null,
    metadata: objectFrom(payload.metadata) ?? undefined,
    raw: { ...raw, ...(objectFrom(payload.raw) ?? {}) },
  };
}

// Loads EVERY non-deleted warehouse row for the API key owner across all import batches — paged so
// it is never capped at Supabase's default single-response row limit. Ordered by (event_time,
// transaction_id) so range pagination is stable when event_time ties. No import_batch_id filter.
async function loadTransactions(client: ReturnType<typeof createClient>, userId: string): Promise<ComputeTxn[]> {
  const rows = await collectPages<Record<string, unknown>>(async (offset, limit) => {
    const { data, error } = await client
      .from("transactions")
      .select("transaction_id,user_id,event_time,status,transaction_type,amount_gross,amount_net,amount_refunded,currency,email,campaign_path,funnel,source,source_name,import_batch_id,raw_payload,normalized_payload")
      .eq("auth_user_id", userId)
      .is("deleted_at", null)
      .order("event_time", { ascending: true })
      .order("transaction_id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return (data ?? []) as Record<string, unknown>[];
  });
  return rows.map(hydrateTransaction).filter((tx): tx is ComputeTxn => Boolean(tx));
}

// Most recent import batch for the account — used only to report how many loaded rows fall outside
// it (diagnostics), never to filter the data the API computes on.
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

// Latest saved Facebook traffic snapshot for the account. Returns [] when none exists, so the API
// still returns conversion metrics (spend/cac/roas become null) instead of failing.
async function loadTrafficSnapshot(client: ReturnType<typeof createClient>, userId: string): Promise<TrafficMetricLike[]> {
  const { data, error } = await client
    .from("data_snapshots")
    .select("payload")
    .eq("user_id", userId)
    .eq("dataset_type", "facebook_traffic")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return [];
  return extractTrafficMetrics((data as { payload: unknown }).payload, decompressFromEncodedURIComponent);
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

  try {
    await client.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", key.id);
    const [txs, traffic, latestBatchId] = await Promise.all([
      loadTransactions(client, key.user_id),
      loadTrafficSnapshot(client, key.user_id),
      loadLatestBatchId(client, key.user_id),
    ]);
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
  }
});
