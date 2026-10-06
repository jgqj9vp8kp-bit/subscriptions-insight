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
//
// Access (policies/clickhouse-facebook.ts): FB reads for facebook_analytics.view,
// status also for cohorts.view (spend totals stripped), spend_ledger for
// forecasting.view, diagnostics / history for admin.diagnostics.view, sync for
// admin.sync.run, warehouse writes for admin.warehouse.manage, and the daily
// cron tick behind FB_CRON_SECRET. Everything runs for the workspace tenant
// (ctx.tenantKey), never for the caller. Only the write actions may create
// fact_facebook_stats; reads no longer run DDL.

import { jsonResponse, serveWithAccess, type AccessContext } from "../_shared/clickhouse/http.ts";
import { ensureFactFacebookStatsSchema } from "../_shared/clickhouse/schema.ts";
import { ScopeViolation } from "../_shared/clickhouse/scopedClient.ts";
import type { ClickHouseClientLike, SupabaseAuthClient } from "../_shared/clickhouse/types.ts";
import {
  CLICKHOUSE_FACEBOOK_POLICY,
  FB_HISTORY_ACTIONS,
  FB_SCHEMA_WRITE_ACTIONS,
  FbActionError,
  clickHouseFacebookErrorResponse,
  fbResponseAction,
  fbStatusDetailVisible,
  fbV2PreviewRead,
  projectFbSyncStateForViewer,
} from "../_shared/access/policies/clickhouse-facebook.ts";
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
import { listFbReconSnapshots, runFbReconSnapshot } from "../_shared/clickhouse/fbReconSnapshot.ts";
import { runProjectSpendLedger } from "../_shared/clickhouse/projectSpendLedger.ts";
import { runFbV2Parity } from "../_shared/clickhouse/fbV2ParityHarness.ts";
import { backfillFbV2DimsFromV1, fbV2DimsStatus } from "../_shared/clickhouse/fbWarehouseV2Dims.ts";
import {
  buildFbDiagnostics,
  createCapsuledFetcher,
  fbWarehouseErrorResponse,
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

function capsuledEnv(): { token: string | undefined; baseUrl: string } {
  return {
    token: Deno.env.get("CAPSULED_API_TOKEN"),
    baseUrl: Deno.env.get("CAPSULED_API_BASE_URL") || "https://capsuled.space",
  };
}

const TOKEN_MISSING = { ok: false, error: "CAPSULED_API_TOKEN is not configured." };

// Daily cron tick (design §8): incremental sync + a stored recon snapshot
// (the V2 parity verdict rides along), authenticated by FB_CRON_SECRET in the
// gate — pg_cron cannot mint user JWTs. Keeps the 7-green-days gate accruing
// even on days nobody opens the app. The tenant is the workspace data key; the
// body's auth_user_id may only repeat it. The caller holds the cron secret, so
// it keeps getting the detailed responses (they land in net._http_response).
async function runCronDaily(ctx: AccessContext, pg: SupabaseAuthClient, ch: ClickHouseClientLike): Promise<Response> {
  const { token, baseUrl } = capsuledEnv();
  if (!token) return jsonResponse(TOKEN_MISSING, 500);
  try {
    // A failed sync (fail-safe: source export inconsistent, batch withheld)
    // must NOT skip the recon snapshot — recon measures the last PUBLISHED
    // warehouse state, and the 7-green-days cutover gate has to keep
    // accruing even on days Capsuled's overnight export is mid-refresh.
    let syncSummary: Record<string, unknown>;
    let syncError: string | null = null;
    try {
      const sync = await withTimeout(
        runFacebookStatsSync({
          authUserId: ctx.tenantKey,
          supabase: pg,
          clickhouse: ch,
          fetcher: createCapsuledFetcher({ token, baseUrl }),
          request: { mode: "incremental", trigger_source: "cron" } as FbSyncRequest,
        }),
        SYNC_TIMEOUT_MS,
        "Cron Facebook sync",
      );
      syncSummary = { status: sync.status, rows_inserted: sync.rows_inserted, rows_updated: sync.rows_updated, v2_errors: sync.v2_errors ?? 0 };
    } catch (error) {
      if (error instanceof ScopeViolation) throw error;
      syncError = error instanceof Error ? error.message : "Cron Facebook sync failed.";
      syncSummary = { status: "failed", error: syncError };
    }
    const today = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
    const snapshot = await withTimeout(
      runFbReconSnapshot({ clickhouse: ch, supabase: pg, authUserId: ctx.tenantKey, dateFrom: from, dateTo: today }),
      READ_TIMEOUT_MS,
      "Cron recon snapshot",
    );
    return jsonResponse({
      ok: syncError == null,
      action: "cron_daily",
      sync: syncSummary,
      health: snapshot.health,
      v2_parity: snapshot.details.v2_parity,
      ...(syncError ? { error: syncError } : {}),
    }, syncError ? 502 : 200);
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    return jsonResponse({ ok: false, action: "cron_daily", error: error instanceof Error ? error.message : "Cron tick failed." }, 502);
  }
}

serveWithAccess(CLICKHOUSE_FACEBOOK_POLICY, async ({ ctx, action, body, pg, clickhouse }) => {
  if (action === "cron_daily") return await runCronDaily(ctx, pg, clickhouse());

  // Responses echo the body's own action name, as they always have.
  const responseAction = fbResponseAction(body);
  const authUserId = ctx.tenantKey;

  // Warehouse V2 Phase 1: append-only history reads. They only SELECT from the
  // facebook_* history tables, so they never open a ClickHouse client.
  if (FB_HISTORY_ACTIONS.has(action)) {
    try {
      if (action === "history_runs") return { ok: true, action: responseAction, runs: await listFbSyncRuns(pg, authUserId, body) };
      if (action === "history_batches") return { ok: true, action: responseAction, batches: await listFbImportBatches(pg, authUserId, body) };
      if (action === "history_versions") return { ok: true, action: responseAction, versions: await listFbWarehouseVersions(pg, authUserId, body) };
      if (action === "history_raw_payloads") return { ok: true, action: responseAction, payloads: await listFbRawPayloads(pg, authUserId, body) };
      return { ok: true, action: responseAction, dq: await getFbBatchDq(pg, authUserId, body) };
    } catch (error) {
      if (error instanceof ScopeViolation) throw error;
      const message = error instanceof Error ? error.message : "Facebook history read failed.";
      throw new FbActionError(/required/i.test(message) ? 400 : 502, { ok: false, action: responseAction, error: message });
    }
  }

  try {
    const ch = clickhouse();
    // Idempotent CREATE IF NOT EXISTS — writers only (see FB_SCHEMA_WRITE_ACTIONS).
    if (FB_SCHEMA_WRITE_ACTIONS.has(action)) await ensureFactFacebookStatsSchema(ch);

    if (action === "v2_dims_status") {
      const status = await withTimeout(fbV2DimsStatus(ch, authUserId), READ_TIMEOUT_MS, "V2 dims status");
      return { ok: true, action: responseAction, ...status };
    }

    if (action === "v2_dims_backfill") {
      // One-shot SCD2 seed from the V1 warehouse; idempotent (unchanged entities
      // skipped). Admin diagnostics: the first line of a failure is returned —
      // ClickHouse exception headers carry no credentials.
      try {
        const result = await withTimeout(
          backfillFbV2DimsFromV1({ clickhouse: ch, authUserId, nowIso: new Date().toISOString() }),
          READ_TIMEOUT_MS,
          "V2 dims backfill",
        );
        return { ok: true, action: responseAction, ...result };
      } catch (error) {
        if (error instanceof ScopeViolation) throw error;
        const message = (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300);
        throw new FbActionError(502, { ok: false, action: responseAction, error: message });
      }
    }

    if (action === "v2_parity") {
      // Wave 5 cutover gate: day-by-day V1 vs V2-published comparison. Read-only.
      const today = new Date().toISOString().slice(0, 10);
      const defaultFrom = new Date(Date.now() - 89 * 86_400_000).toISOString().slice(0, 10);
      const report = await withTimeout(
        runFbV2Parity({
          clickhouse: ch,
          authUserId,
          dateFrom: typeof body.date_from === "string" ? body.date_from : defaultFrom,
          dateTo: typeof body.date_to === "string" ? body.date_to : today,
        }),
        READ_TIMEOUT_MS,
        "V2 parity",
      );
      return { ok: true, action: responseAction, ...report };
    }

    if (action === "recon_snapshot") {
      // Wave 4: compute AND STORE a reconciliation health snapshot (six spend
      // buckets, campaign states, coverage, DQ). Defaults to a 30-day window.
      const today = new Date().toISOString().slice(0, 10);
      const defaultFrom = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
      const snapshot = await withTimeout(
        runFbReconSnapshot({
          clickhouse: ch,
          supabase: pg,
          authUserId,
          dateFrom: typeof body.date_from === "string" ? body.date_from : defaultFrom,
          dateTo: typeof body.date_to === "string" ? body.date_to : today,
        }),
        READ_TIMEOUT_MS,
        "Recon snapshot",
      );
      return { ok: true, action: responseAction, snapshot };
    }

    if (action === "recon_history") {
      const snapshots = await withTimeout(
        listFbReconSnapshots(ch, authUserId, typeof body.limit === "number" ? body.limit : 30),
        READ_TIMEOUT_MS,
        "Recon history",
      );
      return { ok: true, action: responseAction, snapshots };
    }

    if (action === "seed_campaign_aliases") {
      // Wave 3: migrate the audited confirmed alias pairs into the mapping table.
      const result = await seedConfirmedCampaignAliases(pg, authUserId);
      return { ok: true, action: responseAction, ...result };
    }

    if (action === "funnel_suggestions" || action === "funnel_suggestions_apply") {
      // Wave 3 Layer B collector: compute the automatable evidence rungs; insert
      // only when apply=true (and only rows that survive existing resolutions).
      const queries = funnelEvidenceQueries();
      const [authoritative, names, existing] = await Promise.all([
        ch.query({ query: queries.authoritativeSql, query_params: { auth_user_id: authUserId }, format: "JSONEachRow" })
          .then(async (rs) => (await rs.json()) as Array<{ campaign_id: string; funnel: string; users: number }>),
        ch.query({ query: queries.namesSql, query_params: { auth_user_id: authUserId }, format: "JSONEachRow" })
          .then(async (rs) => (await rs.json()) as Array<{ campaign_id: string; campaign_name: string }>),
        loadActiveCampaignFunnelMap(pg, authUserId),
      ]);
      const suggestions = buildCampaignFunnelSuggestions({
        authoritative: authoritative.map((row) => ({ ...row, users: Number(row.users) || 0 })),
        campaignNames: names,
        existing,
        knownFunnels: ["past_life", "soulmate", "starseed"],
      });
      let applied = 0;
      if (action === "funnel_suggestions_apply") {
        applied = await insertCampaignFunnelSuggestions(pg, authUserId, suggestions);
      }
      return { ok: true, action: responseAction, suggestions, applied };
    }

    if (action === "spend_ledger") {
      // Project Forecasting P2: window spend resolved to campaign_path via the
      // observed-in-window → historical-users ladder, residual classified as
      // unknown_funnel / other_unallocated (never redistributed), groups by
      // (channel × account × currency) with commissions deliberately null —
      // the client must assign them explicitly (rev. 3 correction 4).
      const result = await withTimeout(
        runProjectSpendLedger({
          clickhouse: ch,
          supabase: pg,
          authUserId,
          dateFrom: typeof body.date_from === "string" ? body.date_from : null,
          dateTo: typeof body.date_to === "string" ? body.date_to : null,
        }),
        READ_TIMEOUT_MS,
        "Project spend ledger",
      );
      return { ok: true, action: responseAction, ...result };
    }

    if (action === "funnel_spend") {
      // Model 2 (rev.2): full funnel spend — source campaign spend resolved via
      // Layer B, zero-user campaigns included, provenance-tagged. Never forced to
      // match the user-attributed allocation.
      const result = await withTimeout(
        runFunnelSpend({
          clickhouse: ch,
          supabase: pg,
          authUserId,
          dateFrom: typeof body.date_from === "string" ? body.date_from : null,
          dateTo: typeof body.date_to === "string" ? body.date_to : null,
        }),
        READ_TIMEOUT_MS,
        "Funnel spend",
      );
      return { ok: true, action: responseAction, ...result };
    }

    if (action === "source_probe") {
      // READ-ONLY: no ClickHouse/Postgres writes; drives the backfill-vs-known-gap
      // decision for missing windows (Warehouse V2 Phase 2).
      const { token, baseUrl } = capsuledEnv();
      if (!token) throw new FbActionError(500, TOKEN_MISSING);
      const probe = await withTimeout(
        runFacebookSourceProbe({
          fetcher: createCapsuledFetcher({ token, baseUrl }),
          dateFrom: typeof body.date_from === "string" ? body.date_from : null,
          dateTo: typeof body.date_to === "string" ? body.date_to : null,
        }),
        SYNC_TIMEOUT_MS,
        "Facebook source probe",
      );
      return { ok: true, action: responseAction, ...probe };
    }

    if (action === "sync") {
      const { token, baseUrl } = capsuledEnv();
      if (!token) throw new FbActionError(500, TOKEN_MISSING);
      const result = await withTimeout(
        runFacebookStatsSync({
          authUserId,
          supabase: pg,
          clickhouse: ch,
          fetcher: createCapsuledFetcher({ token, baseUrl }),
          request: body as FbSyncRequest,
        }),
        SYNC_TIMEOUT_MS,
        "Facebook stats sync",
      );
      return { ok: true, action: responseAction, ...result };
    }

    if (action === "status") {
      const request = body as FbReadRequest;
      const [state, diagnostics] = await Promise.all([
        getFbSyncState(pg, authUserId).catch(() => null),
        withTimeout(
          buildFbDiagnostics({
            clickhouse: ch,
            supabase: pg,
            authUserId,
            level: normalizeFbLevel(request.level),
            filters: normalizeFbFilters(request),
          }),
          READ_TIMEOUT_MS,
          "Facebook status",
        ),
      ]);
      // Tenant-wide spend totals of the stored sync state are diagnostics.
      return { ok: true, action: responseAction, state: fbStatusDetailVisible(ctx) ? state : projectFbSyncStateForViewer(state), diagnostics };
    }

    // report / list / summary, or one of them on the V2 read path (v2_preview).
    const read = action === "v2_preview" ? fbV2PreviewRead(body) : action;

    if (read === "report") {
      const result = await withTimeout(
        runFbReport({ clickhouse: ch, supabase: pg, authUserId, request: body as FbReadRequest }),
        READ_TIMEOUT_MS,
        "Facebook report",
      );
      return { ...result, action: "report" };
    }

    if (read === "list") {
      const result = await withTimeout(runFbList(ch, authUserId, body as FbReadRequest), READ_TIMEOUT_MS, "Facebook list");
      return { ok: true, action: responseAction, ...result };
    }
    if (read === "charts") {
      const charts = await withTimeout(runFbCharts(ch, authUserId, body as FbReadRequest), READ_TIMEOUT_MS, "Facebook charts");
      return { ok: true, action: responseAction, charts };
    }
    if (read === "filters") {
      const options = await withTimeout(runFbFilterOptions(ch, authUserId, body as FbReadRequest), READ_TIMEOUT_MS, "Facebook filters");
      return { ok: true, action: responseAction, filter_options: options };
    }
    if (read === "summary") {
      const result = await withTimeout(
        runFbReport({ clickhouse: ch, supabase: pg, authUserId, request: body as FbReadRequest }),
        READ_TIMEOUT_MS,
        "Facebook summary",
      );
      return { ok: true, action: responseAction, summary: result.summary, diagnostics: result.diagnostics };
    }

    // Unreachable: the policy maps every action above.
    throw new FbActionError(400, { ok: false, error: `Unsupported action: ${responseAction}` });
  } catch (error) {
    if (error instanceof ScopeViolation || error instanceof FbActionError) throw error;
    const mapped = fbWarehouseErrorResponse(error, responseAction);
    throw new FbActionError(mapped.status, mapped.body);
  }
}, { onError: clickHouseFacebookErrorResponse });
