/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type TransactionStatus = "success" | "failed" | "refunded" | "chargeback";
type TransactionType = "trial" | "upsell" | "first_subscription" | "failed_payment" | "refund" | "chargeback" | string;
type MediaBuyer = "Ivan" | "Artem A" | "Artem D" | "Unknown";

type Transaction = {
  transaction_id: string;
  user_id: string;
  email: string;
  event_time: string;
  amount_usd: number;
  gross_amount_usd: number;
  refund_amount_usd: number;
  net_amount_usd: number;
  is_refunded: boolean;
  currency: string;
  status: TransactionStatus;
  transaction_type: TransactionType;
  funnel: string;
  campaign_path: string;
  product: string;
  traffic_source: string;
  campaign_id: string;
  utm_source?: string | null;
  classification_reason: string;
  billing_reason?: string;
  metadata?: Record<string, unknown>;
  raw?: Record<string, unknown>;
};

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

function normalizePath(value: unknown): string {
  return normalize(value).replace(/^\/+/, "").toLowerCase();
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

function valueAtPath(source: unknown, path: string[]): unknown {
  let current: unknown = source;
  for (const segment of path) {
    const object = objectFrom(current);
    if (!object) return undefined;
    current = object[segment];
  }
  return current;
}

function firstString(source: unknown, paths: string[][]): string | null {
  for (const path of paths) {
    const value = valueAtPath(source, path);
    const normalized = normalize(value);
    if (normalized) return normalized;
  }
  return null;
}

function campaignIdFor(tx: Transaction): string {
  return normalize(
    tx.campaign_id ||
      firstString(tx, [["campaign_id"], ["campaign", "id"], ["raw_payload", "campaign_id"], ["normalized_payload", "campaign_id"]]) ||
      firstString(tx.metadata, [["campaign_id"], ["campaign", "id"]]) ||
      firstString(tx.raw, [["campaign_id"], ["campaign", "id"], ["raw_payload", "campaign_id"], ["normalized_payload", "campaign_id"]]) ||
      "Unknown",
  );
}

function utmSourceFrom(source: unknown): string | null {
  return firstString(source, [
    ["utm_source"],
    ["user", "utm_source"],
    ["transaction", "utm_source"],
    ["metadata", "utm_source"],
    ["raw_payload", "utm_source"],
    ["normalized_payload", "utm_source"],
    ["raw_payload", "metadata", "utm_source"],
    ["normalized_payload", "metadata", "utm_source"],
  ]);
}

function utmSourceFor(tx: Transaction): string | null {
  return utmSourceFrom(tx) ?? utmSourceFrom(tx.metadata) ?? utmSourceFrom(tx.raw) ?? utmSourceFrom(tx.raw?.metadata) ?? null;
}

function mediaBuyerFromUtmSource(value: unknown): MediaBuyer {
  const normalized = normalize(value);
  if (normalized === "4") return "Ivan";
  if (normalized === "22") return "Artem A";
  if (normalized === "19") return "Artem D";
  return "Unknown";
}

function attributionForUser(txs: Transaction[]): { utm_source: string | null; media_buyer: MediaBuyer } {
  const sorted = [...txs].sort((a, b) => a.event_time.localeCompare(b.event_time));
  const trial = sorted.find((tx) => tx.status === "success" && tx.transaction_type === "trial");
  const trialUtm = trial ? utmSourceFor(trial) : null;
  if (trialUtm) return { utm_source: trialUtm, media_buyer: mediaBuyerFromUtmSource(trialUtm) };
  const fallback = sorted.map(utmSourceFor).find(Boolean) ?? null;
  return { utm_source: fallback, media_buyer: mediaBuyerFromUtmSource(fallback) };
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function hydrateTransaction(record: Record<string, unknown>): Transaction | null {
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
    currency: normalize(payload.currency ?? record.currency ?? "USD"),
    status: normalize(payload.status ?? record.status) as TransactionStatus,
    transaction_type: normalize(payload.transaction_type ?? record.transaction_type) as TransactionType,
    funnel: normalize(payload.funnel ?? record.funnel ?? "unknown"),
    campaign_path: normalize(payload.campaign_path ?? record.campaign_path ?? "unknown"),
    product: normalize(payload.product),
    traffic_source: normalize(payload.traffic_source ?? record.source_name ?? "unknown"),
    campaign_id: normalize(payload.campaign_id),
    utm_source: normalize(payload.utm_source) || null,
    classification_reason: normalize(payload.classification_reason),
    billing_reason: normalize(payload.billing_reason) || undefined,
    metadata: objectFrom(payload.metadata) ?? undefined,
    raw: { ...raw, ...(objectFrom(payload.raw) ?? {}) },
  };
}

function groupTransactionsByUser(txs: Transaction[]): Map<string, Transaction[]> {
  const result = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const userKey = tx.user_id || tx.email || tx.transaction_id;
    result.set(userKey, [...(result.get(userKey) ?? []), tx]);
  }
  return result;
}

function firstTrial(txs: Transaction[]): Transaction | null {
  return [...txs]
    .filter((tx) => tx.status === "success" && tx.transaction_type === "trial")
    .sort((a, b) => a.event_time.localeCompare(b.event_time))[0] ?? null;
}

function roundRatio(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// Rows aggregate per (campaign_id, campaign_path, funnel). media_buyer still works as a request
// filter (it selects which users are included), but it is no longer a grouping dimension or a
// payload field — external consumers receive one row per campaign.
function buildRows(txs: Transaction[], params: URLSearchParams) {
  const from = dateKey(params.get("date_from"));
  const to = dateKey(params.get("date_to"));
  const pathFilter = normalizePath(params.get("campaign_path"));
  const buyerFilter = normalize(params.get("media_buyer"));
  const campaignIdFilter = normalize(params.get("campaign_id"));
  const grouped = new Map<string, Array<{ userId: string; txs: Transaction[]; campaignId: string; campaignPath: string; funnel: string }>>();

  groupTransactionsByUser(txs).forEach((list, userId) => {
    const trial = firstTrial(list);
    if (!trial) return;
    const trialDate = dateKey(trial.event_time);
    if (!trialDate) return;
    if (from && trialDate < from) return;
    if (to && trialDate > to) return;

    const campaignId = campaignIdFor(trial);
    if (campaignIdFilter && campaignId !== campaignIdFilter) return;
    const campaignPath = trial.campaign_path || "unknown";
    if (pathFilter && normalizePath(campaignPath) !== pathFilter) return;
    if (buyerFilter && attributionForUser(list).media_buyer !== buyerFilter) return;

    const entry = { userId, txs: list, campaignId, campaignPath, funnel: trial.funnel || "unknown" };
    const key = [campaignId, campaignPath, entry.funnel].join("||");
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  });

  return Array.from(grouped.values())
    .map((users) => {
      const first = users[0];
      const allTxs = users.flatMap((user) => user.txs);
      const trialUsers = users.length;
      const upsellUsers = new Set(allTxs.filter((tx) => tx.status === "success" && tx.transaction_type === "upsell").map((tx) => tx.user_id)).size;
      const firstSubUsers = new Set(allTxs.filter((tx) => tx.status === "success" && tx.transaction_type === "first_subscription").map((tx) => tx.user_id)).size;
      const refundUsers = new Set(allTxs.filter((tx) => tx.is_refunded || tx.transaction_type === "refund" || tx.refund_amount_usd > 0).map((tx) => tx.user_id)).size;
      return {
        campaign_id: first.campaignId,
        campaign_path: first.campaignPath,
        funnel: first.funnel,
        date_from: from,
        date_to: to,
        trial_users: trialUsers,
        upsell_users: upsellUsers,
        upsell_cr: trialUsers ? roundRatio(upsellUsers / trialUsers) : 0,
        first_sub_users: firstSubUsers,
        trial_to_first_sub_cr: trialUsers ? roundRatio(firstSubUsers / trialUsers) : 0,
        refund_users: refundUsers,
      };
    })
    .sort((a, b) => b.trial_users - a.trial_users || a.campaign_id.localeCompare(b.campaign_id));
}

async function loadTransactions(client: ReturnType<typeof createClient>, userId: string): Promise<Transaction[]> {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await client
      .from("transactions")
      .select("transaction_id,user_id,event_time,status,transaction_type,amount_gross,amount_net,amount_refunded,currency,email,campaign_path,funnel,source_name,raw_payload,normalized_payload")
      .eq("auth_user_id", userId)
      .is("deleted_at", null)
      .order("event_time", { ascending: true })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = (data ?? []) as Record<string, unknown>[];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows.map(hydrateTransaction).filter((tx): tx is Transaction => Boolean(tx));
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
    const txs = await loadTransactions(client, key.user_id);
    const rows = buildRows(txs, params);
    await client.from("api_export_logs").insert({ ...logBase, status_code: 200, rows_returned: rows.length });
    return jsonResponse({
      data: rows,
      meta: {
        date_from: dateKey(params.get("date_from")),
        date_to: dateKey(params.get("date_to")),
        rows: rows.length,
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
