// export-campaign-performance request handler — the Export API.
//
// API-key authenticated (verify_jwt = false; GET), so it cannot use the JWT
// access gate. The key path, in order (each step fails closed):
//   1. OPTIONS → 204; any method but GET → 405; missing Supabase config → 500.
//   2. Bearer API key → sha256 → api_keys row (active, not revoked, carrying the
//      campaign_performance:read scope) — else 401, exactly as before.
//   3. The key's CREATOR is resolved with resolve_access(key.user_id) and
//      decideApiKeyAccess requires an active member with funnel scope `all`
//      (else 403 scope_not_supported) and the effective permission
//      api_export.use (else 403). Resolver faults are 503, never "allow".
//   4. Every data read (ClickHouse through a ScopedReader bound to the api_key
//      context, and the latest import batch) uses ctx.tenantKey — the workspace
//      data key — never key.user_id.
//   5. A scope violation recorded by the reader fails the export (500), even if
//      something swallowed the throw (rule R7).
//
// The success body ({ data, meta }) and the legacy error bodies are unchanged;
// new access denials use the gate's { ok:false, error_code, error } shape. Every
// response is Cache-Control: no-store and carries x-build-id / x-request-id.
//
// Pure (no Deno globals, no esm.sh): index.ts injects the service-role client
// and the ScopedReader factory, vitest injects fakes.

import { buildCampaignGeoDailyRows, buildCampaignPerformanceRows, summarizeBatchLoad, type ComputeTxn } from "./compute.ts";
import { loadCampaignNames, loadExportTransactions } from "../_shared/clickhouse/exportCampaignSource.ts";
import { ScopeViolation } from "../_shared/clickhouse/scopedClient.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../_shared/clickhouse/types.ts";
import type { AccessContext } from "../_shared/access/accessContext.ts";
import type { RpcResult } from "../_shared/access/gate.ts";
import { buildCorsHeaders } from "../_shared/access/cors.ts";
import { BUILD_ID } from "../_shared/access/buildId.ts";
import {
  decideApiKeyAccess,
  EXPORT_API_KEY_SCOPE,
  EXPORT_CAMPAIGN_PERFORMANCE_POLICY,
  normalizeExportCampaignPerformanceAction,
} from "../_shared/access/policies/export-campaign-performance.ts";

type ApiKeyRecord = {
  id: string;
  user_id: string;
  prefix: string;
  is_active: boolean;
  revoked_at: string | null;
  allowed_scopes: string[] | null;
};

export type ExportLogLevel = "info" | "warn" | "error";

export interface ExportCampaignPerformanceDeps {
  /** Set when SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing → 500. */
  configError?: string | null;
  /** Service-role client (bypasses RLS — every read below is keyed explicitly). */
  pg(): SupabaseLikeClient;
  /** ScopedReader bound to the api_key context. */
  createClickHouse(ctx: AccessContext): ClickHouseClientLike;
  newRequestId?(): string;
  log?(level: ExportLogLevel, event: string, details: Record<string, unknown>): void;
}

const API_KEY_PREFIX = "subengine_live_";
const ENDPOINT = EXPORT_CAMPAIGN_PERFORMANCE_POLICY.fn;
const METHODS = EXPORT_CAMPAIGN_PERFORMANCE_POLICY.methods ?? ["GET"];
const corsHeaders = buildCorsHeaders({ methods: METHODS });

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

function defaultLog(level: ExportLogLevel, event: string, details: Record<string, unknown>): void {
  const line = JSON.stringify({ event, ...details });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

// Most recent import batch of the workspace — used only to report how many loaded rows fall outside
// it (diagnostics), never to filter the data the API computes on. Stays on Postgres: it is a single
// row, and import_batches is the source of truth for CSV ingestion.
async function loadLatestBatchId(client: SupabaseLikeClient, tenantKey: string): Promise<string | null> {
  const { data, error } = await client
    .from("import_batches")
    .select("id")
    .eq("user_id", tenantKey)
    .order("imported_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { id?: string }).id ?? null;
}

async function resolveCreator(client: SupabaseLikeClient, userId: string): Promise<RpcResult> {
  if (typeof client.rpc !== "function") return { data: null, error: { message: "rpc is not supported by this client" } };
  try {
    const result = await client.rpc("resolve_access", { p_user_id: userId });
    return { data: result?.data ?? null, error: result?.error ?? null };
  } catch (error) {
    return { data: null, error };
  }
}

export async function handleExportCampaignPerformance(req: Request, deps: ExportCampaignPerformanceDeps): Promise<Response> {
  const requestId = deps.newRequestId?.() ?? crypto.randomUUID();
  const log = deps.log ?? defaultLog;
  const stamp = { ...corsHeaders, "x-build-id": BUILD_ID, "x-request-id": requestId };
  const jsonResponse = (body: unknown, status = 200, extra: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...stamp, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
    });

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: stamp });
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405, { Allow: METHODS.join(", ") });

  if (deps.configError) return jsonResponse({ error: "API export is not configured." }, 500);

  const rawKey = bearerToken(req);
  if (!rawKey || !rawKey.startsWith(API_KEY_PREFIX)) return jsonResponse({ error: "Invalid API key." }, 401);

  const client = deps.pg();
  const keyHash = await sha256Hex(rawKey);
  const { data: apiKey, error: keyError } = await client
    .from("api_keys")
    .select("id,user_id,prefix,is_active,revoked_at,allowed_scopes")
    .eq("key_hash", keyHash)
    .maybeSingle();
  const key = apiKey as ApiKeyRecord | null;
  if (keyError || !key || !key.is_active || key.revoked_at || !key.allowed_scopes?.includes(EXPORT_API_KEY_SCOPE)) {
    return jsonResponse({ error: "Invalid API key." }, 401);
  }

  const url = new URL(req.url);
  const params = url.searchParams;
  // Until access is decided, the row is keyed by the key's creator (the actor),
  // as before. Once the export is authorized it reads the WORKSPACE's data, so
  // its log rows move under ctx.tenantKey (tenant data the data owner can read
  // through RLS) and actor_user_id keeps who ran it. For the data owner's own
  // keys both ids are the same, so their rows are unchanged.
  const logBase: Record<string, unknown> = {
    api_key_id: key.id,
    user_id: key.user_id,
    actor_user_id: key.user_id,
    endpoint: ENDPOINT,
    params: Object.fromEntries(params.entries()),
    key_prefix: key.prefix,
  };
  const writeLog = async (row: Record<string, unknown>) => {
    try {
      await client.from("api_export_logs").insert?.({ ...logBase, ...row });
    } catch (_error) {
      // The log is diagnostics; it never changes the response.
    }
  };

  // ---- access: the key's creator, resolved per request (revocation is immediate) ----
  const action = normalizeExportCampaignPerformanceAction({ method: req.method, url });
  const decision = decideApiKeyAccess({
    keyUserId: key.user_id,
    resolved: await resolveCreator(client, key.user_id),
    action,
    requestId,
  });
  // `=== false` (not `!decision.ok`) so the union narrows under the app tsconfig
  // too, which runs without strictNullChecks.
  if (decision.ok === false) {
    const { denial } = decision;
    log(denial.status >= 500 ? "error" : "warn", "access_denied", {
      fn: ENDPOINT,
      request_id: requestId,
      status: denial.status,
      error_code: denial.error_code,
      actor_kind: "api_key",
      user_id: key.user_id,
      api_key_id: key.id,
      action,
      reason: decision.reason,
    });
    await writeLog({ status_code: denial.status, rows_returned: 0, error_message: denial.error_code });
    return jsonResponse({ ok: false, error_code: denial.error_code, error: denial.error }, denial.status);
  }
  const ctx = decision.ctx;
  logBase.user_id = ctx.tenantKey;

  // The transaction history is read from the ClickHouse warehouse, not from the
  // Postgres JSON payloads. See _shared/clickhouse/exportCampaignSource.ts for the
  // measurements: the old Postgres read was ~401 MB / ~119 s for this account and
  // the runtime killed the invocation before the catch below could log anything.
  let clickhouse: ClickHouseClientLike | null = null;
  try {
    await client.from("api_keys").update?.({ last_used_at: new Date().toISOString() }).eq("id", key.id);
    clickhouse = deps.createClickHouse(ctx);
    const reader = clickhouse;
    const [txs, latestBatchId] = await Promise.all([
      loadExportTransactions(reader, ctx.tenantKey) as Promise<ComputeTxn[]>,
      loadLatestBatchId(client, ctx.tenantKey),
    ]);
    // Facebook spend is no longer exported, so spend / cac / roas stay null — the
    // same value the contract already returned whenever no traffic snapshot
    // existed (API_EXPORT.md documents them as nullable). The response shape is
    // unchanged so existing consumers keep parsing successfully.
    const traffic: [] = [];
    const computeParams = {
      date_from: params.get("date_from"),
      date_to: params.get("date_to"),
      campaign_path: params.get("campaign_path"),
      media_buyer: params.get("media_buyer"),
      campaign_id: params.get("campaign_id"),
    };
    // ?breakdown=country (alias: geo) switches the row shape to the daily
    // campaign×country partition; without it the legacy contract is untouched.
    const breakdown = normalize(params.get("breakdown")).toLowerCase();
    const geoMode = breakdown === "country" || breakdown === "geo";
    const rows = geoMode
      ? buildCampaignGeoDailyRows({
        txs,
        params: computeParams,
        campaignNames: await loadCampaignNames(reader, ctx.tenantKey).catch((error) => {
          if (error instanceof ScopeViolation) throw error;
          return new Map<string, string>();
        }),
      })
      : buildCampaignPerformanceRows({ txs, traffic, params: computeParams });
    // R7: a violation the reader recorded fails the export even if a catch above
    // swallowed the throw.
    if (ctx.violations.length) throw new Error(`Scope violation: ${ctx.violations.join(", ")}`);
    const batchLoad = summarizeBatchLoad(txs, latestBatchId);
    await client.from("api_export_logs").insert?.({ ...logBase, status_code: 200, rows_returned: rows.length });
    log("info", "api_export", {
      fn: ENDPOINT,
      request_id: requestId,
      action,
      actor_kind: ctx.actor.kind,
      user_id: ctx.actor.userId,
      member_id: ctx.actor.memberId,
      api_key_id: key.id,
      rows: rows.length,
    });
    return jsonResponse({
      data: rows,
      meta: {
        date_from: dateKey(params.get("date_from")),
        date_to: dateKey(params.get("date_to")),
        rows: rows.length,
        breakdown: geoMode ? "country" : null,
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
    await client.from("api_export_logs").insert?.({
      ...logBase,
      status_code: 500,
      rows_returned: 0,
      error_message: message,
    });
    return jsonResponse({ error: "Export failed." }, 500);
  } finally {
    await clickhouse?.close?.().catch(() => undefined);
  }
}
