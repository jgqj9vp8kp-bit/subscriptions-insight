/* global Deno */

// FunnelFox → Leads sync — resumable, staged, diagnosable.
//
// A single Edge invocation has ~60s of wall clock, which is not enough to crawl /profiles, enrich
// every email via /profiles/{id}, crawl /sessions, and reconcile conversion in one shot for large
// accounts. So the sync is split into four RESUMABLE stages, and one invocation runs ONE stage:
//
//   profiles         → crawl /public/v1/profiles, upsert basic rows (no email yet)
//   profile_details  → fetch /profiles/{id} for rows still missing an email (concurrency-limited)
//   sessions         → crawl /public/v1/sessions, join earliest session attribution per profile
//   reconcile        → recompute has_successful_payment / has_active_subscription / is_lead
//
// Each stage persists its cursor + completion flag to public.funnelfox_leads_sync_state, so the next
// call resumes from where the last one stopped. No stage param → run the next incomplete stage.
//
// Pure logic mirrors src/services/funnelfoxLeadsTransform.ts (kept in lockstep). Deploy WITH JWT
// verification. FUNNELFOX_SECRET stays server-side; emails are masked in any log line.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  corsHeaders,
  detectProfileEmail,
  fetchFunnelFox,
  getFunnelFoxSecret,
} from "../_shared/funnelfox.ts";

type JsonRecord = Record<string, unknown>;

const PROFILE_DETAIL_CONCURRENCY = 5;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MAX_PAGES = 50;
const DRY_RUN_MAX_PAGES = 2;
const DETAIL_CANDIDATE_BATCH = 2000; // email-less rows pulled per profile_details run
const SOFT_TIME_BUDGET_MS = 50_000; // stay under the ~60s Edge wall clock; resume next call if exceeded
const UPSERT_BATCH = 500;

// ---- pure helpers (mirror funnelfoxLeadsTransform.ts) ----------------------------------------

const MEDIA_BUYER_BY_UTM: Record<string, string> = { "4": "Ivan", "22": "Artem A", "19": "Artem D" };

type SyncStage = "profiles" | "profile_details" | "sessions" | "reconcile";
type SyncStoppedReason = "completed" | "soft_timeout" | "max_pages_reached" | "api_error" | "unknown";

interface StageCompletion {
  profiles_completed: boolean;
  details_completed: boolean;
  sessions_completed: boolean;
  reconcile_completed: boolean;
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
function normalizeCountryCode(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
}
function normalizeUtmSource(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
function mediaBuyerFromUtmSource(utm: string | null): string | null {
  if (!utm) return null;
  return MEDIA_BUYER_BY_UTM[utm] ?? "Unknown";
}
function maskEmail(value: string | null): string | null {
  if (!value || !value.includes("@")) return value ? "***" : null;
  const [local, domain] = value.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

function emailFromListRow(row: JsonRecord): string | null {
  const direct = normalizeEmail(row.email);
  if (direct) return direct;
  const preview = row.preview;
  if (typeof preview === "string") {
    const match = preview.match(/[^\s"']+@[^\s"']+\.[^\s"']+/);
    if (match) return normalizeEmail(match[0]);
  }
  if (preview && typeof preview === "object") {
    const record = preview as JsonRecord;
    return normalizeEmail(record.email) ?? normalizeEmail(record.contact_email);
  }
  return null;
}

function parseOriginUrl(origin: string | null): { campaign_path: string | null; campaign_id: string | null; utm_source: string | null } {
  if (!origin) return { campaign_path: null, campaign_id: null, utm_source: null };
  let params: URLSearchParams | null = null;
  let pathname = "";
  try {
    const url = new URL(origin);
    params = url.searchParams;
    pathname = url.pathname;
  } catch {
    const q = origin.indexOf("?");
    params = new URLSearchParams(q >= 0 ? origin.slice(q + 1) : origin);
  }
  const get = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = params?.get(key);
      if (value && value.trim()) return value.trim();
    }
    return null;
  };
  const firstSegment = pathname.split("/").filter(Boolean)[0] ?? null;
  return {
    campaign_path: get("utm_campaign", "campaign_path", "campaign") ?? firstSegment,
    campaign_id: get("campaign_id", "utm_content", "utm_term", "adset_id", "ad_id"),
    utm_source: normalizeUtmSource(get("utm_source", "source")),
  };
}

interface ParsedSession {
  session_id: string;
  profile_id: string;
  country_code: string | null;
  user_agent: string | null;
  funnel_id: string | null;
  funnel_version: string | null;
  origin: string | null;
  created_at: string | null;
  city: string | null;
  postal: string | null;
  raw: JsonRecord;
}

function parseSessionRow(row: JsonRecord): ParsedSession {
  return {
    session_id: str(row.session_id ?? row.id),
    profile_id: str(row.profile_id),
    country_code: normalizeCountryCode(row.country),
    user_agent: strOrNull(row.user_agent),
    funnel_id: strOrNull(row.funnel_id),
    funnel_version: strOrNull(row.funnel_version),
    origin: strOrNull(row.origin),
    created_at: strOrNull(row.created_at),
    city: strOrNull(row.city),
    postal: strOrNull(row.postal),
    raw: row,
  };
}

function dateMs(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function nextIncompleteStage(flags: StageCompletion): SyncStage | null {
  if (!flags.profiles_completed) return "profiles";
  if (!flags.details_completed) return "profile_details";
  if (!flags.sessions_completed) return "sessions";
  if (!flags.reconcile_completed) return "reconcile";
  return null;
}

function determineStopReason(input: {
  pages: number;
  maxPages: number;
  hasMoreOnLastPage: boolean;
  timedOut: boolean;
  apiError: boolean;
}): SyncStoppedReason {
  if (input.apiError) return "api_error";
  if (input.timedOut) return "soft_timeout";
  if (!input.hasMoreOnLastPage) return "completed";
  if (input.pages >= input.maxPages) return "max_pages_reached";
  return "unknown";
}

function statusFromStopReason(reason: SyncStoppedReason): "ok" | "partial" | "error" {
  switch (reason) {
    case "completed":
      return "ok";
    case "api_error":
      return "error";
    default:
      return "partial";
  }
}

function detailsStopReason(timeoutSkipped: number, apiError = false): SyncStoppedReason {
  if (apiError) return "api_error";
  return timeoutSkipped > 0 ? "soft_timeout" : "completed";
}

type DetailOutcome = "email_checked" | "gone_checked" | "transient_unchecked";

// Decide a profile-detail fetch result. Only 404/410 are terminal "no email" — every other failure is
// transient (the row stays detail_checked=false so a later run retries it).
function detailOutcome(ok: boolean, status: number): DetailOutcome {
  if (ok) return "email_checked";
  if (status === 404 || status === 410) return "gone_checked";
  return "transient_unchecked";
}

// profile_details is complete only when nothing was timed-out-skipped AND no candidate rows remain
// (transient failures leave rows unchecked → stage stays incomplete → Continue Sync resumes it).
function detailsStageComplete(timeoutSkipped: number, remainingUnchecked: number): boolean {
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

function computeCoverageWarning(input: {
  stoppedReason: SyncStoppedReason;
  stage: SyncStage;
  hasPendingDetails: boolean;
}): { coverage_warning: boolean; coverage_warning_message: string } {
  if (input.stoppedReason === "max_pages_reached") {
    return {
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because max_pages was reached while FunnelFox still had more profiles.",
    };
  }
  if (input.stoppedReason === "soft_timeout") {
    return {
      coverage_warning: true,
      coverage_warning_message:
        input.stage === "profile_details"
          ? "Sync stopped because soft timeout was reached during profile detail enrichment."
          : "Sync stopped because soft timeout was reached before pagination finished.",
    };
  }
  if (input.stoppedReason === "api_error") {
    return {
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because the FunnelFox API returned an error before pagination finished.",
    };
  }
  if (input.hasPendingDetails) {
    return {
      coverage_warning: true,
      coverage_warning_message: "Profiles without email may be incomplete because detail enrichment did not finish.",
    };
  }
  return { coverage_warning: false, coverage_warning_message: "" };
}

function readReportedTotal(pagination: JsonRecord): number | null {
  for (const key of ["total", "total_count", "totalCount", "count"]) {
    const value = pagination[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

// ---- FunnelFox crawling ----------------------------------------------------------------------

interface CrawlPageResult {
  ok: boolean;
  rows: JsonRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  totalReported: number | null;
}

async function fetchListPage(base: string, cursor: string | undefined, limit: number, secret: string): Promise<CrawlPageResult> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  const { ok, payload } = await fetchFunnelFox(`${base}${qs ? `?${qs}` : ""}`, secret);
  const root = readRecord(payload);
  const pagination = readRecord(root.pagination);
  return {
    ok,
    rows: (Array.isArray(root.data) ? root.data : []).filter((r): r is JsonRecord => Boolean(r && typeof r === "object")),
    hasMore: Boolean(pagination.has_more),
    nextCursor: typeof pagination.next_cursor === "string" ? pagination.next_cursor : null,
    totalReported: readReportedTotal(pagination),
  };
}

interface CrawlOutcome {
  rows: JsonRecord[];
  pages: number;
  lastCursor: string | null;
  hasMoreOnLastPage: boolean;
  stoppedReason: SyncStoppedReason;
  totalReported: number | null;
}

async function crawlList(
  base: string,
  startCursor: string | undefined,
  limit: number,
  maxPages: number,
  isExpired: () => boolean,
  secret: string,
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
    if (isExpired()) {
      timedOut = true;
      break;
    }
    const page = await fetchListPage(base, cursor, limit, secret);
    if (!page.ok) {
      apiError = true;
      break;
    }
    rows.push(...page.rows);
    pages += 1;
    if (page.totalReported != null) totalReported = page.totalReported;
    const more = page.hasMore && Boolean(page.nextCursor);
    hasMoreOnLastPage = more;
    lastCursor = page.nextCursor ?? lastCursor;
    if (!more) break;
    cursor = page.nextCursor ?? undefined;
  }

  return {
    rows,
    pages,
    lastCursor,
    hasMoreOnLastPage,
    stoppedReason: determineStopReason({ pages, maxPages, hasMoreOnLastPage, timedOut, apiError }),
    totalReported,
  };
}

// ---- conversion context (passed by the client from its warehouse) ----------------------------

interface ConversionContext {
  paidEmails: Set<string>;
  activeSubEmails: Set<string>;
  trialDates: Map<string, string>;
  firstSubDates: Map<string, string>;
}

function parseConversionContext(raw: unknown): ConversionContext {
  const record = readRecord(raw);
  const toSet = (value: unknown) =>
    new Set((Array.isArray(value) ? value : []).map((v) => normalizeEmail(v)).filter((v): v is string => Boolean(v)));
  const toMap = (value: unknown) => {
    const map = new Map<string, string>();
    for (const [key, val] of Object.entries(readRecord(value))) {
      const email = normalizeEmail(key);
      if (email && typeof val === "string") map.set(email, val);
    }
    return map;
  };
  return {
    paidEmails: toSet(record.paid_emails),
    activeSubEmails: toSet(record.active_sub_emails),
    trialDates: toMap(record.trial_dates),
    firstSubDates: toMap(record.first_sub_dates),
  };
}

// ---- email-extraction diagnostics (dry run only) ---------------------------------------------

function looksLikeEmailLoose(value: string): boolean {
  return /[^\s@]+@[^\s@]+\.[^\s@]+/.test(value);
}

// Collect the dot-paths of any "email"-named key holding an email-shaped value. Returns PATH NAMES
// only (e.g. "customer.email") — never the email itself — so we can report where FunnelFox hides it.
function collectEmailPaths(value: unknown, prefix: string, depth: number, out: string[]): void {
  if (value == null || depth < 0 || out.length >= 12) return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectEmailPaths(item, `${prefix}[${i}]`, depth - 1, out));
    return;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === "string" && key.toLowerCase().includes("email") && looksLikeEmailLoose(entry)) {
        if (!out.includes(path)) out.push(path);
      } else {
        collectEmailPaths(entry, path, depth - 1, out);
      }
    }
  }
}

// Fetch a few profile details and report, per profile, whether the extractor now finds an email and
// which paths actually carry one. No raw emails or payloads are returned.
async function probeEmailExtraction(rows: JsonRecord[], secret: string) {
  const sample = rows.slice(0, 5);
  const results: JsonRecord[] = [];
  for (const row of sample) {
    const id = str(row.profile_id ?? row.id);
    if (!id) continue;
    try {
      const { ok, status, payload } = await fetchFunnelFox(`/profiles/${encodeURIComponent(id)}`, secret);
      const paths: string[] = [];
      collectEmailPaths(payload, "", 5, paths);
      results.push({
        ok,
        status,
        extractor_found_email: Boolean(detectProfileEmail(payload)),
        email_paths_present: paths,
        email_in_payload: paths.length > 0,
        top_level_keys: Object.keys(readRecord(payload)),
      });
    } catch {
      results.push({ ok: false, status: 0, extractor_found_email: false, email_paths_present: [], email_in_payload: false, top_level_keys: [] });
    }
  }
  return results;
}

// ---- HTTP entry ------------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed." }, 405);
  }

  const startedAt = Date.now();
  const deadline = startedAt + SOFT_TIME_BUDGET_MS;
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

  // Params from query and/or JSON body.
  const url = new URL(req.url);
  let body: JsonRecord = {};
  if (req.method === "POST") {
    try { body = readRecord(await req.json()); } catch { body = {}; }
  }
  const intParam = (value: unknown, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
  };
  const boolParam = (a: unknown, b: unknown) =>
    a === true || String(b ?? "").toLowerCase() === "true";

  const limit = intParam(body.limit ?? url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const dryRun = boolParam(body.dry_run, url.searchParams.get("dry_run"));
  const fullReset = boolParam(body.full_reset, url.searchParams.get("full_reset"));
  const maxPages = intParam(
    body.max_pages ?? url.searchParams.get("max_pages"),
    dryRun ? DRY_RUN_MAX_PAGES : DEFAULT_MAX_PAGES,
    1,
    1000,
  );
  const stageParam = str(body.stage ?? url.searchParams.get("stage")).toLowerCase();
  const requestedStage: SyncStage | null =
    stageParam === "profiles" || stageParam === "profile_details" || stageParam === "sessions" || stageParam === "reconcile"
      ? stageParam
      : null;
  const conversion = parseConversionContext(body.conversion);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ---- Phase 6: dry run — diagnostics only, no writes ----------------------------------------
  if (dryRun) {
    try {
      const probePages = Math.min(maxPages, DRY_RUN_MAX_PAGES);
      const profileProbe = await crawlList("/profiles", undefined, limit, probePages, isExpired, secret);
      const sessionProbe = await crawlList("/sessions", undefined, limit, 1, isExpired, secret);
      const listEmails = profileProbe.rows.filter((r) => emailFromListRow(r)).length;
      return jsonResponse({
        status: "ok",
        dry_run: true,
        stage: "profiles",
        diagnostics: {
          profiles_pages_probed: profileProbe.pages,
          profiles_rows_probed: profileProbe.rows.length,
          profiles_has_more_on_last_page: profileProbe.hasMoreOnLastPage,
          profiles_total_reported_by_api: profileProbe.totalReported,
          list_row_contains_email: listEmails > 0,
          list_rows_with_email: listEmails,
          sample_profile_keys: Object.keys(profileProbe.rows[0] ?? {}),
          sample_session_keys: Object.keys(sessionProbe.rows[0] ?? {}),
          email_extraction: await probeEmailExtraction(profileProbe.rows, secret),
          note: "Dry run: no rows written, no raw payloads or emails returned.",
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "dry run failed";
      return jsonResponse({ error: "FunnelFox leads dry run failed.", detail: message }, 502);
    }
  }

  try {
    // ---- Load (and optionally reset) sync state --------------------------------------------
    const { data: stateRow } = await db
      .from("funnelfox_leads_sync_state")
      .select("*")
      .eq("auth_user_id", userId)
      .maybeSingle();

    if (fullReset) {
      // Restart from the beginning. Rows are NOT deleted (upsert refreshes them; nothing is lost).
      // Re-open enrichment only for rows that still have no email — re-checking already-resolved
      // emails would waste calls and (since the candidate query filters normalized_email is null)
      // would strand those rows as permanently "unchecked", blocking stage completion.
      await db
        .from("funnelfox_leads")
        .update({ detail_checked: false })
        .eq("auth_user_id", userId)
        .is("normalized_email", null);
    }

    const flags: StageCompletion = fullReset
      ? { profiles_completed: false, details_completed: false, sessions_completed: false, reconcile_completed: false }
      : {
          profiles_completed: Boolean(stateRow?.profiles_completed),
          details_completed: Boolean(stateRow?.details_completed),
          sessions_completed: Boolean(stateRow?.sessions_completed),
          reconcile_completed: Boolean(stateRow?.reconcile_completed),
        };

    const profilesCursor = fullReset ? null : (stateRow?.last_profiles_cursor ?? null);
    const sessionsCursor = fullReset ? null : (stateRow?.last_sessions_cursor ?? null);
    let scannedTotal = fullReset ? 0 : Number(stateRow?.profiles_scanned_total ?? 0);
    let sessionsTotal = fullReset ? 0 : Number(stateRow?.sessions_scanned_total ?? 0);
    let totalReportedByApi: number | null = fullReset ? null : (stateRow?.profiles_total_reported_by_api ?? null);
    const priorStats = readRecord(stateRow?.stats);

    const stage: SyncStage = requestedStage ?? nextIncompleteStage(flags) ?? "reconcile";

    let stoppedReason: SyncStoppedReason = "completed";
    let madeProgress = true; // false ⇒ this run advanced nothing (lets the driver stop hammering)
    const runStats: JsonRecord = {};
    const cursorUpdate: JsonRecord = {};
    const completionUpdate: JsonRecord = {};

    if (stage === "profiles") {
      // --- Stage 1: crawl profile list, upsert basic rows (email enriched later) -------------
      const start = resolveStartCursor(profilesCursor, fullReset);
      const crawl = await crawlList("/profiles", start, limit, maxPages, isExpired, secret);
      stoppedReason = crawl.stoppedReason;
      madeProgress = crawl.pages > 0;

      const parsed = crawl.rows.map((row) => ({
        profile_id: str(row.profile_id ?? row.id),
        created_at: strOrNull(row.created_at),
        updated_at: strOrNull(row.updated_at),
        funnel_id: strOrNull(row.funnel_id),
        raw: row,
      }));
      const kept = parsed.filter((p) => p.profile_id);
      const skippedNoProfileId = parsed.length - kept.length;

      const rows = kept.map((p) => ({
        auth_user_id: userId,
        profile_id: p.profile_id,
        created_at: p.created_at,
        updated_at: p.updated_at,
        funnel_id: p.funnel_id,
        // Email unknown until profile_details; mark as not-yet-a-lead so email-less profiles never
        // leak into the Leads list before reconcile runs.
        is_lead: false,
        has_successful_payment: false,
        has_active_subscription: false,
        synced_at: new Date().toISOString(),
        raw_profile_list: p.raw,
      }));
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const { error } = await db
          .from("funnelfox_leads")
          .upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict: "auth_user_id,profile_id" });
        if (error) throw new Error(`profiles upsert failed: ${error.message}`);
      }

      scannedTotal += kept.length;
      if (crawl.totalReported != null) totalReportedByApi = crawl.totalReported;
      const completed = stoppedReason === "completed";
      cursorUpdate.last_profiles_cursor = completed ? null : crawl.lastCursor;
      completionUpdate.profiles_completed = completed;

      Object.assign(runStats, {
        profiles_pages_processed: crawl.pages,
        profiles_has_more_on_last_page: crawl.hasMoreOnLastPage,
        profiles_last_cursor: crawl.lastCursor,
        profiles_total_scanned_this_run: kept.length,
        profiles_total_saved_this_run: rows.length,
        profiles_skipped_no_profile_id: skippedNoProfileId,
      });
    } else if (stage === "profile_details") {
      // --- Stage 2: enrich emails for rows that still have none ------------------------------
      const { data: candidateRows } = await db
        .from("funnelfox_leads")
        .select("profile_id, raw_profile_list")
        .eq("auth_user_id", userId)
        .is("normalized_email", null)
        .eq("detail_checked", false)
        .limit(DETAIL_CANDIDATE_BATCH);
      const candidates = (candidateRows ?? []) as Array<{ profile_id: string; raw_profile_list: JsonRecord | null }>;

      let attempted = 0;
      let fetched = 0;
      let failed = 0; // transient failures — row stays detail_checked=false for the next run to retry
      let gone = 0; // permanent (404/410/4xx) — row marked detail_checked=true with no email
      let index = 0;
      const updates: JsonRecord[] = [];
      const worker = async () => {
        while (index < candidates.length) {
          if (isExpired()) return;
          const current = candidates[index];
          index += 1;
          attempted += 1;
          // No-network shortcut: a list-row preview occasionally carries the email.
          const listEmail = emailFromListRow(readRecord(current.raw_profile_list));
          if (listEmail) {
            fetched += 1;
            updates.push({
              auth_user_id: userId,
              profile_id: current.profile_id,
              email: listEmail,
              normalized_email: listEmail,
              detail_checked: true,
              synced_at: new Date().toISOString(),
            });
            continue;
          }
          try {
            const { ok, status, payload } = await fetchFunnelFox(`/profiles/${encodeURIComponent(current.profile_id)}`, secret);
            const outcome = detailOutcome(ok, status);
            if (outcome === "email_checked") {
              fetched += 1;
              const email = detectProfileEmail(payload);
              updates.push({
                auth_user_id: userId,
                profile_id: current.profile_id,
                email,
                normalized_email: normalizeEmail(email),
                detail_checked: true, // checked: a successful fetch with or without an email is terminal
                raw_profile_detail: payload,
                synced_at: new Date().toISOString(),
              });
            } else if (outcome === "gone_checked") {
              // 404/410 — profile gone, won't change on retry. Mark checked, no email.
              gone += 1;
              updates.push({
                auth_user_id: userId,
                profile_id: current.profile_id,
                detail_checked: true,
                synced_at: new Date().toISOString(),
              });
            } else {
              // transient (5xx / 429 / auth / unknown) — leave detail_checked=false so a later run retries.
              failed += 1;
            }
          } catch {
            failed += 1; // network error — transient, retry next run
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(PROFILE_DETAIL_CONCURRENCY, candidates.length)) }, () => worker()),
      );
      const timeoutSkipped = candidates.length - attempted;

      for (let i = 0; i < updates.length; i += UPSERT_BATCH) {
        const { error } = await db
          .from("funnelfox_leads")
          .upsert(updates.slice(i, i + UPSERT_BATCH), { onConflict: "auth_user_id,profile_id" });
        if (error) throw new Error(`profile_details upsert failed: ${error.message}`);
      }

      // Authoritative completion: recount rows that still need enrichment AFTER this run's writes.
      // Transient failures (detail_checked still false) keep the stage incomplete so Continue Sync
      // resumes profile_details — it never advances past unenriched profiles.
      const { count: remainingUnchecked } = await db
        .from("funnelfox_leads")
        .select("*", { count: "exact", head: true })
        .eq("auth_user_id", userId)
        .is("normalized_email", null)
        .eq("detail_checked", false);
      const remaining = remainingUnchecked ?? 0;

      stoppedReason = detailsStopReason(timeoutSkipped);
      const completed = detailsStageComplete(timeoutSkipped, remaining);
      completionUpdate.details_completed = completed;
      madeProgress = candidates.length === 0 ? true : fetched > 0 || gone > 0;

      Object.assign(runStats, {
        profile_details_attempted: attempted,
        profile_details_fetched: fetched,
        profile_details_failed: failed,
        profile_details_gone: gone,
        profile_details_timeout_skipped: timeoutSkipped,
        remaining_detail_unchecked: remaining,
      });
    } else if (stage === "sessions") {
      // --- Stage 3: crawl sessions, attach earliest-session attribution ----------------------
      const start = resolveStartCursor(sessionsCursor, fullReset);
      const crawl = await crawlList("/sessions", start, limit, maxPages, isExpired, secret);
      stoppedReason = crawl.stoppedReason;
      madeProgress = crawl.pages > 0;

      const sessions = crawl.rows.map(parseSessionRow);
      const withoutProfileId = sessions.filter((s) => !s.profile_id).length;

      // Earliest session per profile in this batch.
      const earliest = new Map<string, ParsedSession>();
      for (const s of sessions) {
        if (!s.profile_id) continue;
        const cur = earliest.get(s.profile_id);
        if (!cur || dateMs(s.created_at) < dateMs(cur.created_at)) earliest.set(s.profile_id, s);
      }

      let joined = 0;
      if (earliest.size) {
        const ids = [...earliest.keys()];
        // Earliest-wins across runs: only attach if no session yet or this one is earlier.
        const existingByProfile = new Map<string, string | null>();
        for (let i = 0; i < ids.length; i += UPSERT_BATCH) {
          const slice = ids.slice(i, i + UPSERT_BATCH);
          const { data } = await db
            .from("funnelfox_leads")
            .select("profile_id, session_created_at")
            .eq("auth_user_id", userId)
            .in("profile_id", slice);
          for (const r of (data ?? []) as Array<{ profile_id: string; session_created_at: string | null }>) {
            existingByProfile.set(r.profile_id, r.session_created_at);
          }
        }

        const updates: JsonRecord[] = [];
        for (const [profileId, s] of earliest) {
          if (!existingByProfile.has(profileId)) continue; // session has no matching profile row → skip
          const existing = existingByProfile.get(profileId) ?? null;
          if (existing && dateMs(existing) <= dateMs(s.created_at)) continue; // keep the earlier session
          const attribution = parseOriginUrl(s.origin);
          joined += 1;
          updates.push({
            auth_user_id: userId,
            profile_id: profileId,
            session_id: s.session_id || null,
            session_created_at: s.created_at,
            funnel_version: s.funnel_version,
            funnel_id: s.funnel_id,
            campaign_path: attribution.campaign_path,
            campaign_id: attribution.campaign_id,
            utm_source: attribution.utm_source,
            media_buyer: attribution.utm_source ? mediaBuyerFromUtmSource(attribution.utm_source) : null,
            country_code: s.country_code,
            city: s.city,
            postal: s.postal,
            user_agent: s.user_agent,
            origin: s.origin,
            raw_session: s.raw,
            synced_at: new Date().toISOString(),
          });
        }
        for (let i = 0; i < updates.length; i += UPSERT_BATCH) {
          const { error } = await db
            .from("funnelfox_leads")
            .upsert(updates.slice(i, i + UPSERT_BATCH), { onConflict: "auth_user_id,profile_id" });
          if (error) throw new Error(`sessions upsert failed: ${error.message}`);
        }
      }

      sessionsTotal += sessions.length;
      const completed = stoppedReason === "completed";
      cursorUpdate.last_sessions_cursor = completed ? null : crawl.lastCursor;
      completionUpdate.sessions_completed = completed;

      Object.assign(runStats, {
        sessions_pages_processed: crawl.pages,
        sessions_has_more_on_last_page: crawl.hasMoreOnLastPage,
        sessions_last_cursor: crawl.lastCursor,
        sessions_total_scanned_this_run: sessions.length,
        sessions_joined: joined,
        sessions_without_profile_id: withoutProfileId,
      });
    } else {
      // --- Stage 4: reconcile conversion state for every row --------------------------------
      const all: Array<{ profile_id: string; normalized_email: string | null }> = [];
      const PAGE = 1000;
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await db
          .from("funnelfox_leads")
          .select("profile_id, normalized_email")
          .eq("auth_user_id", userId)
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`reconcile read failed: ${error.message}`);
        const chunk = (data ?? []) as Array<{ profile_id: string; normalized_email: string | null }>;
        all.push(...chunk);
        if (chunk.length < PAGE) break;
      }

      let leadsFound = 0;
      let convertedExcluded = 0;
      let activeSubExcluded = 0;
      const updates = all.map((row) => {
        const email = row.normalized_email;
        const paid = Boolean(email && conversion.paidEmails.has(email));
        const active = Boolean(email && conversion.activeSubEmails.has(email));
        const isLead = Boolean(email) && !paid && !active;
        if (paid) convertedExcluded += 1;
        if (active) activeSubExcluded += 1;
        if (isLead) leadsFound += 1;
        return {
          auth_user_id: userId,
          profile_id: row.profile_id,
          has_successful_payment: paid,
          has_active_subscription: active,
          is_lead: isLead,
          first_trial_at: email ? conversion.trialDates.get(email) ?? null : null,
          first_sub_at: email ? conversion.firstSubDates.get(email) ?? null : null,
        };
      });
      for (let i = 0; i < updates.length; i += UPSERT_BATCH) {
        const { error } = await db
          .from("funnelfox_leads")
          .upsert(updates.slice(i, i + UPSERT_BATCH), { onConflict: "auth_user_id,profile_id" });
        if (error) throw new Error(`reconcile upsert failed: ${error.message}`);
      }

      stoppedReason = "completed";
      completionUpdate.reconcile_completed = true;
      Object.assign(runStats, {
        reconcile_rows: all.length,
        leads_found: leadsFound,
        converted_excluded: convertedExcluded,
        active_sub_excluded: activeSubExcluded,
      });
    }

    // ---- Email coverage over the whole saved population ------------------------------------
    const { count: savedTotal } = await db
      .from("funnelfox_leads")
      .select("*", { count: "exact", head: true })
      .eq("auth_user_id", userId);
    const { count: withEmailTotal } = await db
      .from("funnelfox_leads")
      .select("*", { count: "exact", head: true })
      .eq("auth_user_id", userId)
      .not("normalized_email", "is", null);
    const { count: pendingDetails } = await db
      .from("funnelfox_leads")
      .select("*", { count: "exact", head: true })
      .eq("auth_user_id", userId)
      .is("normalized_email", null)
      .eq("detail_checked", false);

    const profilesSaved = savedTotal ?? 0;
    const profilesWithEmail = withEmailTotal ?? 0;
    const hasPendingDetails = (pendingDetails ?? 0) > 0;

    // ---- Merge + persist updated state -----------------------------------------------------
    const updatedFlags: StageCompletion = {
      profiles_completed: completionUpdate.profiles_completed ?? flags.profiles_completed,
      details_completed: completionUpdate.details_completed ?? flags.details_completed,
      sessions_completed: completionUpdate.sessions_completed ?? flags.sessions_completed,
      reconcile_completed: completionUpdate.reconcile_completed ?? flags.reconcile_completed,
    } as StageCompletion;
    const remainingStage = nextIncompleteStage(updatedFlags);
    const allCompleted = remainingStage === null;

    const runStatus = statusFromStopReason(stoppedReason);
    const overallStatus = runStatus !== "ok" ? runStatus : allCompleted ? "ok" : "partial";

    const warning = computeCoverageWarning({ stoppedReason, stage, hasPendingDetails });
    const coveragePercent = computeCoveragePercent(scannedTotal, totalReportedByApi);

    const stats: JsonRecord = {
      ...priorStats,
      ...runStats,
      stage,
      next_stage: remainingStage,
      all_stages_completed: allCompleted,
      sync_stopped_reason: stoppedReason,
      profiles_total_saved: profilesSaved,
      profiles_with_email: profilesWithEmail,
      profiles_without_email: profilesSaved - profilesWithEmail,
      profiles_pending_enrichment: pendingDetails ?? 0,
      // Enrichment progress (cross-cutting, always present so the UI can prompt Continue Sync).
      remaining_detail_unchecked: pendingDetails ?? 0,
      remaining_without_email_after_checked: Math.max(0, profilesSaved - profilesWithEmail - (pendingDetails ?? 0)),
      profiles_scanned_total: scannedTotal,
      sessions_scanned_total: sessionsTotal,
      profiles_total_reported_by_api: totalReportedByApi,
      profiles_coverage_percent: coveragePercent,
      coverage_warning: warning.coverage_warning,
      coverage_warning_message: warning.coverage_warning_message,
      duration_ms: Date.now() - startedAt,
      // Legacy aliases (kept so older UI references keep resolving).
      profiles_scanned: scannedTotal,
      sessions_scanned: sessionsTotal,
      emails_found: profilesWithEmail,
    };

    const nowIso = new Date().toISOString();
    await db.from("funnelfox_leads_sync_state").upsert(
      {
        auth_user_id: userId,
        ...cursorUpdate,
        ...completionUpdate,
        profiles_scanned_total: scannedTotal,
        sessions_scanned_total: sessionsTotal,
        profiles_total_reported_by_api: totalReportedByApi,
        current_stage: remainingStage ?? stage,
        last_status: overallStatus,
        last_error: null,
        last_full_sync_at: allCompleted ? nowIso : (stateRow?.last_full_sync_at ?? null),
        last_profiles_synced_at: stage === "profiles" ? nowIso : (stateRow?.last_profiles_synced_at ?? null),
        last_sessions_synced_at: stage === "sessions" ? nowIso : (stateRow?.last_sessions_synced_at ?? null),
        stats,
      },
      { onConflict: "auth_user_id" },
    );

    console.info("funnelfox-leads-sync", {
      userId_present: true,
      stage,
      status: overallStatus,
      stopped_reason: stoppedReason,
      next_stage: remainingStage,
      profiles_saved: profilesSaved,
      profiles_with_email: profilesWithEmail,
    });

    return jsonResponse({
      status: overallStatus,
      dry_run: false,
      stage,
      next_stage: remainingStage,
      all_stages_completed: allCompleted,
      made_progress: madeProgress,
      stopped_reason: stoppedReason,
      coverage_warning: warning.coverage_warning,
      coverage_warning_message: warning.coverage_warning_message,
      summary: stats,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync failed";
    await db.from("funnelfox_leads_sync_state").upsert(
      { auth_user_id: userId, last_status: "error", last_error: message },
      { onConflict: "auth_user_id" },
    );
    return jsonResponse({ error: "FunnelFox leads sync failed.", detail: message }, 502);
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
