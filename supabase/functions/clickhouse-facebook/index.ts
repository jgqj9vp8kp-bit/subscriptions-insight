/* global Deno */

// clickhouse-facebook: the ONLY place that talks to the Capsuled fb-stats API
// and to the fact_facebook_stats warehouse. The Bearer token lives exclusively
// in Supabase Secrets (CAPSULED_API_TOKEN) — it never reaches the frontend,
// bundle, network tab, or any browser storage. Read actions return aggregates
// and diagnostics only.
//
// Actions: sync | status | summary | list | charts | filters | report
// (report = summary+list+charts+filters+diagnostics in ONE atomic response —
// the FB Analytics page consumes only this, so its numbers can never mix
// warehouse states).

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { ensureFactFacebookStatsSchema } from "../_shared/clickhouse/schema.ts";
import {
  buildFbDiagnostics,
  createCapsuledFetcher,
  FacebookStatsRequestError,
  getFbSyncState,
  normalizeFbFilters,
  normalizeFbLevel,
  runFacebookStatsSync,
  runFbCharts,
  runFbFilterOptions,
  runFbList,
  runFbReport,
  type FbReadRequest,
  type FbSyncRequest,
} from "../_shared/clickhouse/facebookStats.ts";

const SYNC_TIMEOUT_MS = 120_000;
const READ_TIMEOUT_MS = 25_000;

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms.`)), ms)),
  ]);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody<Record<string, unknown>>(req);
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }
  const action = typeof body.action === "string" ? body.action : "report";

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const ch = client;
    // Idempotent CREATE IF NOT EXISTS so read actions work before the first sync.
    await ensureFactFacebookStatsSchema(ch);

    if (action === "sync") {
      const token = Deno.env.get("CAPSULED_API_TOKEN");
      const baseUrl = Deno.env.get("CAPSULED_API_BASE_URL") || "https://capsuled.space";
      if (!token) return jsonResponse({ ok: false, error: "CAPSULED_API_TOKEN is not configured." }, 500);
      const result = await withTimeout(
        runFacebookStatsSync({
          authUserId: auth.id,
          supabase: auth.supabase,
          clickhouse: ch,
          fetcher: createCapsuledFetcher({ token, baseUrl }),
          request: body as FbSyncRequest,
        }),
        SYNC_TIMEOUT_MS,
        "Facebook stats sync",
      );
      return jsonResponse({ ok: true, action, ...result });
    }

    if (action === "status") {
      const request = body as FbReadRequest;
      const [state, diagnostics] = await Promise.all([
        getFbSyncState(auth.supabase, auth.id).catch(() => null),
        withTimeout(
          buildFbDiagnostics({
            clickhouse: ch,
            supabase: auth.supabase,
            authUserId: auth.id,
            level: normalizeFbLevel(request.level),
            filters: normalizeFbFilters(request),
          }),
          READ_TIMEOUT_MS,
          "Facebook status",
        ),
      ]);
      return jsonResponse({ ok: true, action, state, diagnostics });
    }

    if (action === "report" || action === "analytics") {
      const result = await withTimeout(
        runFbReport({ clickhouse: ch, supabase: auth.supabase, authUserId: auth.id, request: body as FbReadRequest }),
        READ_TIMEOUT_MS,
        "Facebook report",
      );
      return jsonResponse({ ...result, action: "report" });
    }

    if (action === "list") {
      const result = await withTimeout(runFbList(ch, auth.id, body as FbReadRequest), READ_TIMEOUT_MS, "Facebook list");
      return jsonResponse({ ok: true, action, ...result });
    }
    if (action === "charts") {
      const charts = await withTimeout(runFbCharts(ch, auth.id, body as FbReadRequest), READ_TIMEOUT_MS, "Facebook charts");
      return jsonResponse({ ok: true, action, charts });
    }
    if (action === "filters") {
      const options = await withTimeout(runFbFilterOptions(ch, auth.id, body as FbReadRequest), READ_TIMEOUT_MS, "Facebook filters");
      return jsonResponse({ ok: true, action, filter_options: options });
    }
    if (action === "summary") {
      const result = await withTimeout(
        runFbReport({ clickhouse: ch, supabase: auth.supabase, authUserId: auth.id, request: body as FbReadRequest }),
        READ_TIMEOUT_MS,
        "Facebook summary",
      );
      return jsonResponse({ ok: true, action, summary: result.summary, diagnostics: result.diagnostics });
    }

    return jsonResponse({ ok: false, error: `Unsupported action: ${action}` }, 400);
  } catch (error) {
    const status = error instanceof FacebookStatsRequestError ? 400 : 502;
    return jsonResponse(
      { ok: false, action, source: "clickhouse", error: error instanceof Error ? error.message : "Facebook warehouse action failed." },
      status,
    );
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
