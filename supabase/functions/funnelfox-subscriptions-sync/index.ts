/* global Deno */

// FunnelFox → Subscriptions sync — resumable, staged, diagnosable.
//
// A single Edge invocation has ~60s of wall clock, not enough to crawl every
// /subscriptions page, enrich each via /subscriptions/{id}, and recover emails
// via /profiles/{id} for large accounts. So the sync is split into four
// RESUMABLE stages, and one invocation runs ONE stage:
//
//   subscriptions_list   → crawl /public/v1/subscriptions, upsert basic rows
//   subscription_details → /subscriptions/{id} for rows missing detail (concurrency-limited)
//   profile_enrichment   → /profiles/{id} for rows still missing an email (deduped by profile_id)
//   finalize             → recompute coverage counters, mark completed
//
// Each stage persists its cursor + completion flag to
// public.funnelfox_subscriptions_sync_state, so the next call resumes where the
// last stopped. Per-row detail_checked / profile_checked markers make the
// cursor-less enrichment stages resumable. Pure logic mirrors
// src/services/funnelfoxSubscriptionsSyncCore.ts (kept in lockstep). Deploy WITH
// JWT verification. FUNNELFOX_SECRET stays server-side; emails are masked in logs.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  detectProfileEmail,
  fetchFunnelFox,
  getFunnelFoxSecret,
} from "../_shared/funnelfox.ts";

type JsonRecord = Record<string, unknown>;

const DETAIL_CONCURRENCY = 5;
const PROFILE_CONCURRENCY = 5;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MAX_PAGES = 50;
const DRY_RUN_MAX_PAGES = 2;
const ENRICH_CANDIDATE_BATCH = 2000;
const SOFT_TIME_BUDGET_MS = 50_000;
const UPSERT_BATCH = 500;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// ---- pure helpers (mirror funnelfoxSubscriptionsSyncCore.ts) ---------------------------------

type SyncStage = "subscriptions_list" | "subscription_details" | "profile_enrichment" | "finalize";
type SyncStoppedReason = "completed" | "soft_timeout" | "max_pages_reached" | "api_error" | "user_cancelled" | "unknown";

interface StageCompletion {
  list_completed: boolean;
  details_completed: boolean;
  profiles_completed: boolean;
  finalize_completed: boolean;
}

function readRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
}
function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}
function strOrNull(value: unknown): string | null {
  return str(value) || null;
}
function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().toLowerCase() || null;
}
function maskEmail(value: string | null): string | null {
  if (!value || !value.includes("@")) return value ? "***" : null;
  const [local, domain] = value.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}
function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) && String(value ?? "").trim() ? parsed : null;
}

function emailFromSubscriptionRaw(raw: JsonRecord): string | null {
  const profile = readRecord(raw.profile);
  const customer = readRecord(raw.customer);
  const user = readRecord(raw.user);
  const metadata = readRecord(raw.metadata);
  const profileMetadata = readRecord(profile.metadata);
  for (const value of [
    profile.email, raw.profile_email, raw.email, customer.email,
    raw.customerEmail, raw.customer_email, user.email, metadata.email, profileMetadata.email,
  ]) {
    const email = normalizeEmail(value);
    if (email) return email;
  }
  return null;
}
function profileIdFromSubscriptionRaw(raw: JsonRecord): string | null {
  const profile = readRecord(raw.profile);
  const rawId = str(raw.profile_id) || str(profile.id) || str(raw.profileId);
  if (!rawId) return null;
  return rawId.startsWith("pro_") ? rawId.slice(4) : rawId;
}

interface SubscriptionColumns {
  subscription_id: string;
  profile_id: string | null;
  customer_id: string | null;
  psp_id: string | null;
  email: string | null;
  normalized_email: string | null;
  status: string | null;
  renews: boolean | null;
  product_name: string | null;
  product_id: string | null;
  price: number | null;
  currency: string | null;
  created_at: string | null;
  updated_at: string | null;
  cancelled_at: string | null;
  period_ends_at: string | null;
}
function subscriptionColumns(raw: JsonRecord): SubscriptionColumns {
  const product = readRecord(raw.product);
  const email = emailFromSubscriptionRaw(raw);
  const renewsRaw = raw.renews;
  const priceCents = numberOrNull(raw.price_usd ?? raw.price);
  return {
    subscription_id: str(raw.id ?? raw.subscription_id),
    profile_id: profileIdFromSubscriptionRaw(raw),
    customer_id: strOrNull(readRecord(raw.customer).id ?? raw.customer_id),
    psp_id: strOrNull(raw.psp_id),
    email,
    normalized_email: email,
    status: strOrNull(raw.status)?.toLowerCase() ?? null,
    renews: typeof renewsRaw === "boolean" ? renewsRaw : renewsRaw == null ? null : Boolean(renewsRaw),
    product_name: strOrNull(product.name ?? raw.product_name),
    product_id: strOrNull(product.id ?? raw.product_id),
    price: priceCents == null ? null : Math.round((priceCents / 100) * 100) / 100,
    currency: strOrNull(raw.currency),
    created_at: strOrNull(raw.created_at),
    updated_at: strOrNull(raw.updated_at),
    cancelled_at: strOrNull(raw.cancelled_at),
    period_ends_at: strOrNull(raw.period_ends_at),
  };
}
function needsSubscriptionDetail(columns: SubscriptionColumns): boolean {
  return !columns.email || !columns.profile_id || !columns.product_name || !columns.period_ends_at;
}

function nextIncompleteStage(flags: StageCompletion): SyncStage | null {
  if (!flags.list_completed) return "subscriptions_list";
  if (!flags.details_completed) return "subscription_details";
  if (!flags.profiles_completed) return "profile_enrichment";
  if (!flags.finalize_completed) return "finalize";
  return null;
}
function determineStopReason(input: {
  pages: number; maxPages: number; hasMoreOnLastPage: boolean; timedOut: boolean; apiError: boolean;
}): SyncStoppedReason {
  if (input.apiError) return "api_error";
  if (input.timedOut) return "soft_timeout";
  if (!input.hasMoreOnLastPage) return "completed";
  if (input.pages >= input.maxPages) return "max_pages_reached";
  return "unknown";
}
function statusFromStopReason(reason: SyncStoppedReason): "ok" | "partial" | "error" {
  if (reason === "completed") return "ok";
  if (reason === "api_error") return "error";
  return "partial";
}
function enrichStopReason(timeoutSkipped: number, apiError = false): SyncStoppedReason {
  if (apiError) return "api_error";
  return timeoutSkipped > 0 ? "soft_timeout" : "completed";
}
function enrichStageComplete(timeoutSkipped: number, remainingUnchecked: number): boolean {
  return timeoutSkipped === 0 && remainingUnchecked === 0;
}
function resolveStartCursor(savedCursor: string | null | undefined, fullReset: boolean): string | undefined {
  if (fullReset) return undefined;
  return savedCursor ?? undefined;
}
function computeCoveragePercent(scannedTotal: number, totalReported: number | null): number | null {
  if (!totalReported || totalReported <= 0) return null;
  return Math.min(100, Math.round((scannedTotal / totalReported) * 10000) / 100);
}
function readReportedTotal(pagination: JsonRecord): number | null {
  for (const key of ["total", "total_count", "totalCount", "count"]) {
    const value = pagination[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}
type DetailOutcome = "checked" | "gone_checked" | "transient_unchecked";
function detailOutcome(ok: boolean, status: number): DetailOutcome {
  if (ok) return "checked";
  if (status === 404 || status === 410) return "gone_checked";
  return "transient_unchecked";
}

type ParityCheck = "pass" | "fail" | "unknown";
function parityCheck(storedTotal: number | null | undefined, reportedTotal: number | null | undefined, allStagesCompleted: boolean): ParityCheck {
  if (!allStagesCompleted) return "unknown";
  if (typeof storedTotal !== "number" || typeof reportedTotal !== "number") return "unknown";
  return storedTotal === reportedTotal ? "pass" : "fail";
}
function finalSyncStatus(allStagesCompleted: boolean, baseStatus: "ok" | "partial" | "error", parity: ParityCheck): string {
  if (baseStatus === "error") return "failed";
  if (!allStagesCompleted) return "partial";
  return parity === "fail" ? "completed_with_inconsistencies" : "completed";
}

// ---- crawling --------------------------------------------------------------------------------

interface CrawlPageResult { ok: boolean; rows: JsonRecord[]; hasMore: boolean; nextCursor: string | null; totalReported: number | null; }
interface CrawlOutcome {
  rows: JsonRecord[]; pages: number; lastCursor: string | null; hasMoreOnLastPage: boolean;
  stoppedReason: SyncStoppedReason; totalReported: number | null;
}

async function fetchListPage(base: string, cursor: string | undefined, limit: number, secret: string): Promise<CrawlPageResult> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const { ok, payload } = await fetchFunnelFox(`${base}${qs ? `?${qs}` : ""}`, secret);
  const root = readRecord(payload);
  const pagination = readRecord(root.pagination);
  const rows = (Array.isArray(root.data) ? root.data : Array.isArray(root.subscriptions) ? root.subscriptions : [])
    .filter((r): r is JsonRecord => Boolean(r && typeof r === "object"));
  return {
    ok,
    rows,
    hasMore: Boolean(pagination.has_more),
    nextCursor: typeof pagination.next_cursor === "string" ? pagination.next_cursor : null,
    totalReported: readReportedTotal(pagination),
  };
}

async function crawlList(
  base: string, startCursor: string | undefined, limit: number, maxPages: number,
  isExpired: () => boolean, secret: string,
): Promise<CrawlOutcome> {
  const rows: JsonRecord[] = [];
  let cursor = startCursor;
  let pages = 0;
  let lastCursor: string | null = startCursor ?? null;
  let hasMoreOnLastPage = false;
  let apiError = false;
  let timedOut = false;
  let totalReported: number | null = null;

  while (pages < maxPages) {
    if (isExpired()) { timedOut = true; break; }
    const page = await fetchListPage(base, cursor, limit, secret);
    if (!page.ok) { apiError = true; break; }
    pages += 1;
    rows.push(...page.rows);
    hasMoreOnLastPage = page.hasMore;
    totalReported = page.totalReported ?? totalReported;
    if (!page.hasMore || !page.nextCursor) {
      lastCursor = page.nextCursor ?? null;
      if (!page.nextCursor) hasMoreOnLastPage = false;
      break;
    }
    cursor = page.nextCursor;
    lastCursor = page.nextCursor;
  }

  return {
    rows, pages, lastCursor, hasMoreOnLastPage,
    stoppedReason: determineStopReason({ pages, maxPages, hasMoreOnLastPage, timedOut, apiError }),
    totalReported,
  };
}

// ---- HTTP entry ------------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") return jsonResponse({ error: "Method not allowed." }, 405);

  const startedAtMs = Date.now();
  const deadline = startedAtMs + SOFT_TIME_BUDGET_MS;
  const isExpired = () => Date.now() > deadline;

  const secret = getFunnelFoxSecret();
  if (!secret) return jsonResponse({ error: "FunnelFox is not configured." }, 500);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return jsonResponse({ error: "Server is not configured." }, 500);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return jsonResponse({ error: "Authentication required." }, 401);
  const authClient = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } });
  const { data: userData, error: userError } = await authClient.auth.getUser(token);
  const userId = userData?.user?.id;
  if (userError || !userId) return jsonResponse({ error: "Invalid or expired session." }, 401);

  const url = new URL(req.url);
  let body: JsonRecord = {};
  if (req.method === "POST") { try { body = readRecord(await req.json()); } catch { body = {}; } }
  const intParam = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
  };
  const boolParam = (a: unknown, b: unknown) => a === true || String(b ?? "").toLowerCase() === "true";

  const limit = intParam(body.limit ?? url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const dryRun = boolParam(body.dry_run, url.searchParams.get("dry_run"));
  const fullReset = boolParam(body.full_reset, url.searchParams.get("full_reset"));
  const maxPages = intParam(body.max_pages ?? url.searchParams.get("max_pages"), dryRun ? DRY_RUN_MAX_PAGES : DEFAULT_MAX_PAGES, 1, 1000);
  const stageParam = str(body.stage ?? url.searchParams.get("stage")).toLowerCase();
  const requestedStage: SyncStage | null =
    stageParam === "subscriptions_list" || stageParam === "subscription_details" ||
    stageParam === "profile_enrichment" || stageParam === "finalize"
      ? (stageParam as SyncStage)
      : null;

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ---- Dry run — diagnostics only, no writes -------------------------------------------------
  if (dryRun) {
    try {
      const probe = await crawlList("/subscriptions", undefined, limit, Math.min(maxPages, DRY_RUN_MAX_PAGES), isExpired, secret);
      const columns = probe.rows.map(subscriptionColumns);
      const withEmail = columns.filter((c) => c.email).length;
      const needDetail = columns.filter(needsSubscriptionDetail).length;
      return jsonResponse({
        status: "ok",
        dry_run: true,
        stage: "subscriptions_list",
        made_progress: false,
        all_stages_completed: false,
        diagnostics: {
          subscriptions_pages_probed: probe.pages,
          subscriptions_rows_probed: probe.rows.length,
          subscriptions_has_more_on_last_page: probe.hasMoreOnLastPage,
          subscriptions_total_reported_by_api: probe.totalReported,
          rows_with_email: withEmail,
          rows_missing_email: probe.rows.length - withEmail,
          rows_needing_detail: needDetail,
          sample_subscription_keys: Object.keys(probe.rows[0] ?? {}),
          note: "Dry run: no rows written, no raw payloads or emails returned.",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "dry run failed";
      return jsonResponse({ error: "FunnelFox subscriptions dry run failed.", detail: message }, 502);
    }
  }

  try {
    const { data: stateRow } = await db
      .from("funnelfox_subscriptions_sync_state").select("*").eq("auth_user_id", userId).maybeSingle();

    if (fullReset) {
      // Re-crawl from the beginning; upsert refreshes rows (no duplicates, nothing deleted).
      // Re-open enrichment: all rows for details, and only email-less rows for profiles (re-checking
      // resolved emails wastes calls and — since the profile candidate filters normalized_email null —
      // would strand them permanently unchecked, blocking stage completion).
      await db.from("funnelfox_subscriptions").update({ detail_checked: false }).eq("auth_user_id", userId);
      await db.from("funnelfox_subscriptions").update({ profile_checked: false }).eq("auth_user_id", userId).is("normalized_email", null);
    }

    const flags: StageCompletion = fullReset
      ? { list_completed: false, details_completed: false, profiles_completed: false, finalize_completed: false }
      : {
          list_completed: Boolean(stateRow?.list_completed),
          details_completed: Boolean(stateRow?.details_completed),
          profiles_completed: Boolean(stateRow?.profiles_completed),
          finalize_completed: Boolean(stateRow?.finalize_completed),
        };
    const listCursor = fullReset ? null : (stateRow?.last_list_cursor ?? null);
    let scannedTotal = fullReset ? 0 : Number(stateRow?.subscriptions_scanned_total ?? 0);
    let totalReportedByApi: number | null = fullReset ? null : (stateRow?.subscriptions_total_reported_by_api ?? null);
    const priorStats = readRecord(stateRow?.stats);

    const stage: SyncStage = requestedStage ?? nextIncompleteStage(flags) ?? "finalize";

    let stoppedReason: SyncStoppedReason = "completed";
    let madeProgress = true;
    const runStats: JsonRecord = {};
    const cursorUpdate: JsonRecord = {};
    const completionUpdate: JsonRecord = {};

    if (stage === "subscriptions_list") {
      // --- Stage 1: crawl subscription list, upsert basic rows ---------------------------------
      const start = resolveStartCursor(listCursor, fullReset);
      const crawl = await crawlList("/subscriptions", start, limit, maxPages, isExpired, secret);
      stoppedReason = crawl.stoppedReason;
      madeProgress = crawl.pages > 0;

      // Do NOT include detail_checked/profile_checked in the upsert — omitting them
      // preserves per-row enrichment progress on conflict (DB default false on first insert).
      const rows = crawl.rows
        .map((raw) => ({ columns: subscriptionColumns(raw), raw }))
        .filter((r) => r.columns.subscription_id)
        .map((r) => ({
          auth_user_id: userId,
          subscription_id: r.columns.subscription_id,
          profile_id: r.columns.profile_id,
          customer_id: r.columns.customer_id,
          psp_id: r.columns.psp_id,
          email: r.columns.email,
          normalized_email: r.columns.normalized_email,
          status: r.columns.status,
          renews: r.columns.renews,
          product_name: r.columns.product_name,
          product_id: r.columns.product_id,
          price: r.columns.price,
          currency: r.columns.currency,
          created_at: r.columns.created_at,
          updated_at: r.columns.updated_at,
          cancelled_at: r.columns.cancelled_at,
          period_ends_at: r.columns.period_ends_at,
          raw_list: r.raw,
          synced_at: new Date().toISOString(),
        }));
      const skippedNoId = crawl.rows.length - rows.length;

      let inserted = 0, updated = 0;
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const batch = rows.slice(i, i + UPSERT_BATCH);
        // Distinguish insert vs update by checking which ids already exist (Phase 5 report).
        const { data: existing } = await db.from("funnelfox_subscriptions")
          .select("subscription_id").eq("auth_user_id", userId).in("subscription_id", batch.map((b) => b.subscription_id));
        const existingIds = new Set((existing ?? []).map((e: { subscription_id: string }) => e.subscription_id));
        for (const b of batch) { if (existingIds.has(b.subscription_id)) updated += 1; else inserted += 1; }
        const { error } = await db.from("funnelfox_subscriptions").upsert(batch, { onConflict: "auth_user_id,subscription_id" });
        if (error) throw new Error(`subscriptions upsert failed: ${error.message}`);
      }

      scannedTotal += rows.length;
      totalReportedByApi = crawl.totalReported ?? totalReportedByApi;
      const completed = stoppedReason === "completed";
      cursorUpdate.last_list_cursor = completed ? null : crawl.lastCursor;
      completionUpdate.list_completed = completed;
      // Accumulate inserted/updated across resumable list runs (Phase 5 report).
      const priorInserted = Number(priorStats.subscriptions_inserted ?? 0);
      const priorUpdated = Number(priorStats.subscriptions_updated ?? 0);
      Object.assign(runStats, {
        list_pages_processed: crawl.pages,
        list_has_more_on_last_page: crawl.hasMoreOnLastPage,
        list_last_cursor: crawl.lastCursor,
        subscriptions_inserted: priorInserted + inserted,
        subscriptions_updated: priorUpdated + updated,
        subscriptions_scanned_this_run: rows.length,
        subscriptions_saved_this_run: inserted + updated,
        subscriptions_skipped_no_id: skippedNoId,
      });
    } else if (stage === "subscription_details") {
      // --- Stage 2: /subscriptions/{id} for rows missing detail (concurrency-limited) ----------
      const { data: candidates } = await db.from("funnelfox_subscriptions")
        .select("subscription_id, raw_list").eq("auth_user_id", userId).eq("detail_checked", false).limit(ENRICH_CANDIDATE_BATCH);
      const list = candidates ?? [];
      madeProgress = list.length > 0;

      let attempted = 0, fetched = 0, failed = 0, gone = 0, shortcut = 0;
      const apiError = false;
      let index = 0;
      const worker = async () => {
        while (index < list.length) {
          if (isExpired()) return;
          const row = list[index] as { subscription_id: string; raw_list: JsonRecord };
          index += 1;
          attempted += 1;
          const columns = subscriptionColumns(readRecord(row.raw_list));
          if (!needsSubscriptionDetail(columns)) {
            // List row already complete — mark checked without paying for a fetch.
            shortcut += 1;
            await db.from("funnelfox_subscriptions").update({ detail_checked: true }).eq("auth_user_id", userId).eq("subscription_id", row.subscription_id);
            continue;
          }
          const { ok, status, payload } = await fetchFunnelFox(`/subscriptions/${encodeURIComponent(row.subscription_id)}`, secret);
          const kind = detailOutcome(ok, status);
          if (kind === "transient_unchecked") { failed += 1; continue; }
          const detailRaw = readRecord(readRecord(payload).data ?? payload);
          const detailColumns = subscriptionColumns(detailRaw);
          if (kind === "checked") fetched += 1; else gone += 1;
          const patch: JsonRecord = { detail_checked: true, raw_detail: detailRaw, synced_at: new Date().toISOString() };
          if (detailColumns.email) { patch.email = detailColumns.email; patch.normalized_email = detailColumns.normalized_email; }
          if (detailColumns.profile_id) patch.profile_id = detailColumns.profile_id;
          if (detailColumns.product_name) patch.product_name = detailColumns.product_name;
          if (detailColumns.product_id) patch.product_id = detailColumns.product_id;
          if (detailColumns.period_ends_at) patch.period_ends_at = detailColumns.period_ends_at;
          if (detailColumns.price != null) patch.price = detailColumns.price;
          if (detailColumns.status) patch.status = detailColumns.status;
          await db.from("funnelfox_subscriptions").update(patch).eq("auth_user_id", userId).eq("subscription_id", row.subscription_id);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(DETAIL_CONCURRENCY, list.length)) }, () => worker()));
      const timeoutSkipped = Math.max(0, list.length - index);

      const { count: remainingUnchecked } = await db.from("funnelfox_subscriptions")
        .select("*", { count: "exact", head: true }).eq("auth_user_id", userId).eq("detail_checked", false);
      stoppedReason = enrichStopReason(timeoutSkipped, apiError);
      completionUpdate.details_completed = enrichStageComplete(timeoutSkipped, remainingUnchecked ?? 0);
      Object.assign(runStats, {
        details_attempted: attempted, details_fetched: fetched, details_failed: failed,
        details_gone: gone, details_shortcut_complete: shortcut, details_timeout_skipped: timeoutSkipped,
        remaining_detail_unchecked: remainingUnchecked ?? 0,
      });
    } else if (stage === "profile_enrichment") {
      // --- Stage 3: /profiles/{id} for rows still missing an email (deduped by profile_id) ------
      const { data: candidates } = await db.from("funnelfox_subscriptions")
        .select("subscription_id, profile_id")
        .eq("auth_user_id", userId).eq("profile_checked", false).is("normalized_email", null)
        .not("profile_id", "is", null).limit(ENRICH_CANDIDATE_BATCH);
      const list = (candidates ?? []) as Array<{ subscription_id: string; profile_id: string }>;

      // Dedupe: fetch each profile_id once, then fan the resolved email to all its subscriptions.
      const byProfile = new Map<string, string[]>();
      for (const row of list) {
        const arr = byProfile.get(row.profile_id) ?? [];
        arr.push(row.subscription_id);
        byProfile.set(row.profile_id, arr);
      }
      const profileIds = Array.from(byProfile.keys());
      madeProgress = profileIds.length > 0;

      let attempted = 0, fetched = 0, failed = 0, gone = 0, emailsFound = 0;
      const apiError = false;
      let index = 0;
      const worker = async () => {
        while (index < profileIds.length) {
          if (isExpired()) return;
          const profileId = profileIds[index];
          index += 1;
          attempted += 1;
          const subscriptionIds = byProfile.get(profileId) ?? [];
          const { ok, status, payload } = await fetchFunnelFox(`/profiles/${encodeURIComponent(profileId)}`, secret);
          const kind = detailOutcome(ok, status);
          if (kind === "transient_unchecked") { failed += 1; continue; }
          if (kind === "checked") fetched += 1; else gone += 1;
          const email = detectProfileEmail(payload);
          const profileRaw = readRecord(readRecord(payload).data ?? payload);
          const patch: JsonRecord = { profile_checked: true, raw_profile: profileRaw, synced_at: new Date().toISOString() };
          if (email) { patch.email = email; patch.normalized_email = email; emailsFound += 1; }
          for (const subscriptionId of subscriptionIds) {
            await db.from("funnelfox_subscriptions").update(patch).eq("auth_user_id", userId).eq("subscription_id", subscriptionId);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(PROFILE_CONCURRENCY, profileIds.length)) }, () => worker()));
      const timeoutSkipped = Math.max(0, profileIds.length - index);

      const { count: remainingUnchecked } = await db.from("funnelfox_subscriptions")
        .select("*", { count: "exact", head: true }).eq("auth_user_id", userId).eq("profile_checked", false).is("normalized_email", null).not("profile_id", "is", null);
      stoppedReason = enrichStopReason(timeoutSkipped, apiError);
      completionUpdate.profiles_completed = enrichStageComplete(timeoutSkipped, remainingUnchecked ?? 0);
      Object.assign(runStats, {
        profiles_attempted: attempted, profiles_fetched: fetched, profiles_failed: failed,
        profiles_gone: gone, profiles_emails_found: emailsFound, profiles_timeout_skipped: timeoutSkipped,
        remaining_profile_unchecked: remainingUnchecked ?? 0,
      });
    } else {
      // --- Stage 4: finalize — recompute coverage counters --------------------------------------
      stoppedReason = "completed";
      madeProgress = !flags.finalize_completed;
      completionUpdate.finalize_completed = true;
      cursorUpdate.last_full_sync_at = new Date().toISOString();
    }

    // ---- Coverage counts (recomputed every run) -----------------------------------------------
    const [{ count: savedTotal }, { count: withEmail }, { count: pendingDetails }, { count: pendingProfiles }] = await Promise.all([
      db.from("funnelfox_subscriptions").select("*", { count: "exact", head: true }).eq("auth_user_id", userId),
      db.from("funnelfox_subscriptions").select("*", { count: "exact", head: true }).eq("auth_user_id", userId).not("normalized_email", "is", null),
      db.from("funnelfox_subscriptions").select("*", { count: "exact", head: true }).eq("auth_user_id", userId).eq("detail_checked", false),
      db.from("funnelfox_subscriptions").select("*", { count: "exact", head: true }).eq("auth_user_id", userId).eq("profile_checked", false).is("normalized_email", null).not("profile_id", "is", null),
    ]);
    const missingEmail = (savedTotal ?? 0) - (withEmail ?? 0);
    const { count: missingProfileId } = await db.from("funnelfox_subscriptions")
      .select("*", { count: "exact", head: true }).eq("auth_user_id", userId).is("profile_id", null);

    const flagsAfter: StageCompletion = {
      list_completed: completionUpdate.list_completed as boolean ?? flags.list_completed,
      details_completed: completionUpdate.details_completed as boolean ?? flags.details_completed,
      profiles_completed: completionUpdate.profiles_completed as boolean ?? flags.profiles_completed,
      finalize_completed: completionUpdate.finalize_completed as boolean ?? flags.finalize_completed,
    };
    const remainingStage = nextIncompleteStage(flagsAfter);
    const allStagesCompleted = remainingStage === null;
    const status = statusFromStopReason(stoppedReason);
    const durationMs = Date.now() - startedAtMs;

    // Phase 4 integrity check: stored count must equal FunnelFox's reported total.
    const parity = parityCheck(savedTotal ?? 0, totalReportedByApi, allStagesCompleted);
    const persistedStatus = finalSyncStatus(allStagesCompleted, status, parity);
    const parityMismatch = parity === "fail";

    const coverageWarning =
      stoppedReason !== "completed" || (pendingDetails ?? 0) > 0 || (pendingProfiles ?? 0) > 0 || missingEmail > 0 || parityMismatch;
    const coverageWarningMessage = !coverageWarning
      ? ""
      : parityMismatch
        ? `Synchronization completed with inconsistencies: stored ${savedTotal ?? 0} but FunnelFox reports ${totalReportedByApi ?? "?"}.`
        : stoppedReason === "max_pages_reached"
          ? "Sync stopped because max_pages was reached. Click Continue Sync."
          : stoppedReason === "soft_timeout"
            ? "Sync stopped at the soft time budget. Click Continue Sync to resume from the last cursor."
            : stoppedReason === "api_error"
              ? "Sync stopped because the FunnelFox API returned an error before finishing."
              : (pendingDetails ?? 0) > 0
                ? "Subscription details are incomplete. Click Continue Sync."
                : (pendingProfiles ?? 0) > 0
                  ? "Email enrichment is incomplete. Click Continue Sync."
                  : `${missingEmail} subscriptions still have no email after enrichment.`;

    const stats: JsonRecord = {
      ...priorStats,
      ...runStats,
      stage,
      next_stage: remainingStage,
      all_stages_completed: allStagesCompleted,
      sync_stopped_reason: stoppedReason,
      subscriptions_scanned_total: scannedTotal,
      subscriptions_saved: savedTotal ?? 0,
      subscriptions_with_email: withEmail ?? 0,
      missing_email_after_enrichment: missingEmail,
      rows_missing_subscription_id: 0,
      rows_missing_profile_id: missingProfileId ?? 0,
      details_pending: pendingDetails ?? 0,
      profiles_pending: pendingProfiles ?? 0,
      subscriptions_total_reported_by_api: totalReportedByApi,
      subscriptions_coverage_percent: computeCoveragePercent(scannedTotal, totalReportedByApi),
      coverage_warning: coverageWarning,
      coverage_warning_message: coverageWarningMessage,
      duration_ms: durationMs,
      // ---- Phase 5 permanent sync report ----
      sync_report: {
        started_at: new Date(startedAtMs).toISOString(),
        completed_at: allStagesCompleted ? new Date().toISOString() : null,
        duration_ms: durationMs,
        downloaded: scannedTotal,
        inserted: Number((runStats.subscriptions_inserted ?? priorStats.subscriptions_inserted) ?? 0),
        updated: Number((runStats.subscriptions_updated ?? priorStats.subscriptions_updated) ?? 0),
        skipped: Number((runStats.subscriptions_skipped_no_id ?? priorStats.subscriptions_skipped_no_id) ?? 0),
        total_stored: savedTotal ?? 0,
        total_in_funnelfox: totalReportedByApi,
        parity_check: parity === "pass" ? "PASS" : parity === "fail" ? "FAIL" : "UNKNOWN",
      },
      parity_check: parity,
    };

    await db.from("funnelfox_subscriptions_sync_state").upsert({
      auth_user_id: userId,
      ...cursorUpdate,
      ...completionUpdate,
      current_stage: remainingStage ?? stage,
      subscriptions_scanned_total: scannedTotal,
      subscriptions_total_reported_by_api: totalReportedByApi,
      last_status: persistedStatus,
      last_error: null,
      stopped_reason: stoppedReason,
      started_at: new Date(startedAtMs).toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      stats,
    }, { onConflict: "auth_user_id" });

    console.info("funnelfox-subscriptions-sync", {
      user: userId.slice(0, 8), stage, stopped: stoppedReason, saved: savedTotal ?? 0,
      with_email: withEmail ?? 0, sample_email: maskEmail(null),
    });

    return jsonResponse({
      status,
      dry_run: false,
      stage,
      next_stage: remainingStage,
      all_stages_completed: allStagesCompleted,
      made_progress: madeProgress,
      stopped_reason: stoppedReason,
      persisted_status: persistedStatus,
      parity_check: parity,
      coverage_warning: coverageWarning,
      coverage_warning_message: coverageWarningMessage,
      summary: stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "FunnelFox subscriptions sync failed.";
    await db.from("funnelfox_subscriptions_sync_state").upsert({
      auth_user_id: userId, last_status: "failed", last_error: message, stopped_reason: "api_error",
      finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAtMs,
    }, { onConflict: "auth_user_id" });
    return jsonResponse({ status: "error", error: "FunnelFox subscriptions sync failed.", detail: message }, 502);
  }
});
