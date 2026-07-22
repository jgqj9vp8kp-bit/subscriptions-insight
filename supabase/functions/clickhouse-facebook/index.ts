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
//
// Warehouse V2 Phase 1 read-only history actions (Supabase tables only, no
// ClickHouse): history_runs | history_batches | history_versions |
// history_raw_payloads | history_dq. Pure observability — Cohorts, allocation,
// reconciliation and mapping never read them.

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { ensureFactFacebookStatsSchema } from "../_shared/clickhouse/schema.ts";
import {
  getFbBatchDq,
  listFbImportBatches,
  listFbRawPayloads,
  listFbSyncRuns,
  listFbWarehouseVersions,
} from "../_shared/clickhouse/fbSyncHistory.ts";
import {
  buildCampaignFunnelSuggestions,
  funnelEvidenceQueries,
  insertCampaignFunnelSuggestions,
  loadActiveCampaignFunnelMap,
  runFunnelSpend,
  seedConfirmedCampaignAliases,
} from "../_shared/clickhouse/fbCampaignResolution.ts";
import {
  buildFbDiagnostics,
  createCapsuledFetcher,
  FacebookStatsRequestError,
  FacebookStatsValidationError,
  getFbSyncState,
  normalizeFbFilters,
  normalizeFbLevel,
  runFacebookSourceProbe,
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

  // Warehouse V2 Phase 1: append-only history reads. They only SELECT from the
  // facebook_* history tables, so they run before any ClickHouse client exists.
  if (action.startsWith("history_")) {
    try {
      if (action === "history_runs") return jsonResponse({ ok: true, action, runs: await listFbSyncRuns(auth.supabase, auth.id, body) });
      if (action === "history_batches") return jsonResponse({ ok: true, action, batches: await listFbImportBatches(auth.supabase, auth.id, body) });
      if (action === "history_versions") return jsonResponse({ ok: true, action, versions: await listFbWarehouseVersions(auth.supabase, auth.id, body) });
      if (action === "history_raw_payloads") return jsonResponse({ ok: true, action, payloads: await listFbRawPayloads(auth.supabase, auth.id, body) });
      if (action === "history_dq") return jsonResponse({ ok: true, action, dq: await getFbBatchDq(auth.supabase, auth.id, body) });
      return jsonResponse({ ok: false, action, error: `Unsupported action: ${action}` }, 400);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Facebook history read failed.";
      return jsonResponse({ ok: false, action, error: message }, /required/i.test(message) ? 400 : 502);
    }
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const ch = client;
    // Idempotent CREATE IF NOT EXISTS so read actions work before the first sync.
    await ensureFactFacebookStatsSchema(ch);

    if (action === "seed_campaign_aliases") {
      // Wave 3: migrate the audited confirmed alias pairs into the mapping table.
      const result = await seedConfirmedCampaignAliases(auth.supabase, auth.id);
      return jsonResponse({ ok: true, action, ...result });
    }

    if (action === "funnel_suggestions") {
      // Wave 3 Layer B collector: compute the automatable evidence rungs; insert
      // only when apply=true (and only rows that survive existing resolutions).
      const queries = funnelEvidenceQueries();
      const [authoritative, names, existing] = await Promise.all([
        ch.query({ query: queries.authoritativeSql, query_params: { auth_user_id: auth.id }, format: "JSONEachRow" })
          .then(async (rs) => (await rs.json()) as Array<{ campaign_id: string; funnel: string; users: number }>),
        ch.query({ query: queries.namesSql, query_params: { auth_user_id: auth.id }, format: "JSONEachRow" })
          .then(async (rs) => (await rs.json()) as Array<{ campaign_id: string; campaign_name: string }>),
        loadActiveCampaignFunnelMap(auth.supabase, auth.id),
      ]);
      const suggestions = buildCampaignFunnelSuggestions({
        authoritative: authoritative.map((row) => ({ ...row, users: Number(row.users) || 0 })),
        campaignNames: names,
        existing,
        knownFunnels: ["past_life", "soulmate", "starseed"],
      });
      let applied = 0;
      if (body.apply === true) {
        applied = await insertCampaignFunnelSuggestions(auth.supabase, auth.id, suggestions);
      }
      return jsonResponse({ ok: true, action, suggestions, applied });
    }

    if (action === "funnel_spend") {
      // Model 2 (rev.2): full funnel spend — source campaign spend resolved via
      // Layer B, zero-user campaigns included, provenance-tagged. Never forced to
      // match the user-attributed allocation.
      const result = await withTimeout(
        runFunnelSpend({
          clickhouse: ch,
          supabase: auth.supabase,
          authUserId: auth.id,
          dateFrom: typeof body.date_from === "string" ? body.date_from : null,
          dateTo: typeof body.date_to === "string" ? body.date_to : null,
        }),
        READ_TIMEOUT_MS,
        "Funnel spend",
      );
      return jsonResponse({ ok: true, action, ...result });
    }

    if (action === "source_probe") {
      // READ-ONLY: no ClickHouse/Postgres writes; drives the backfill-vs-known-gap
      // decision for missing windows (Warehouse V2 Phase 2).
      const token = Deno.env.get("CAPSULED_API_TOKEN");
      const baseUrl = Deno.env.get("CAPSULED_API_BASE_URL") || "https://capsuled.space";
      if (!token) return jsonResponse({ ok: false, error: "CAPSULED_API_TOKEN is not configured." }, 500);
      const probe = await withTimeout(
        runFacebookSourceProbe({
          fetcher: createCapsuledFetcher({ token, baseUrl }),
          dateFrom: typeof body.date_from === "string" ? body.date_from : null,
          dateTo: typeof body.date_to === "string" ? body.date_to : null,
        }),
        SYNC_TIMEOUT_MS,
        "Facebook source probe",
      );
      return jsonResponse({ ok: true, action, ...probe });
    }

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
    const status = error instanceof FacebookStatsRequestError ? 400 : error instanceof FacebookStatsValidationError ? 422 : 502;
    const errorCode = error instanceof FacebookStatsValidationError ? error.code : undefined;
    const safeError = error instanceof FacebookStatsValidationError
      ? error.safeMessage
      : error instanceof FacebookStatsRequestError
        ? error.message
        : "Facebook warehouse action failed.";
    return jsonResponse(
      { ok: false, action, source: "clickhouse", ...(errorCode ? { error_code: errorCode } : {}), error: safeError },
      status,
    );
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
