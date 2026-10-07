/* global Deno */

// FunnelFox → Leads sync — resumable, staged, cron-driven, diagnosable.
//
// Where the emails are (live probe 2026-10-06, key names / counts only): a FunnelFox profile LIST row
// is { id, created_at, funnel_id, preview, email? } — about a quarter of the rows carry `email` at the
// root and nothing else in the row does. The /profiles/{id} detail payload carries NO email, so the
// old per-profile detail stage is gone: this function never calls /profiles/{id}. Only profiles that
// carry an email are stored (light columns + the `preview` flag, no raw payloads); the rest are only
// counted in sync_state.stats.
//
// A single Edge invocation has ~60s of wall clock, so the work is split into three RESUMABLE stages
// and one invocation runs ONE stage:
//
//   profiles   → crawl /public/v1/profiles (FunnelFox order, newest first) and upsert the rows that
//                carry an email. Rows + cursor are checkpointed every FLUSH_EVERY_PAGES pages, so a
//                killed call loses at most that many pages.
//   sessions   → crawl /public/v1/sessions and attach the earliest session's attribution to STORED
//                profiles only (light columns; no raw_session).
//   reconcile  → QUEUES the conversion reconcile: public.funnelfox_leads_reconcile_request(p_data_key)
//                stamps sync_state.reconcile_requested_at (one row update) and the stage completes;
//                the pg_cron job funnelfox-leads-reconcile (migration 202610070001) then runs
//                public.funnelfox_leads_reconcile as postgres within a minute (paid emails from
//                public.transactions, active ones from the Cohorts RPC) under the job's own
//                15 min statement_timeout and records reconcile_applied_at / reconcile_summary (a
//                failed run: reconcile_failure, then a 15 min → 6 h backoff — never this function's
//                concern: the stage only queues). Its first pass over the export rewrites
//                almost every row and outlived PostgREST's 8 s statement_timeout (incident
//                2026-10-07), so it no longer runs through PostgREST — except as the fallback while
//                that migration is not applied (PGRST202). stats carry the last APPLIED run's counts
//                plus reconcile_queued_at. Server-side only — a `conversion` key in the body (the old
//                browser context) is ignored.
//
// Each stage persists its cursor + completion flag to public.funnelfox_leads_sync_state, so the next
// call resumes where the last one stopped. No stage param → the next incomplete stage; with every
// stage complete a plain sync is an idle no-op with no writes, so the minute cron tick costs one read.
// A lease (funnelfox_leads_acquire_lease returns a token; only that token releases it) keeps the cron
// tick and the page's button from crawling the same cursor at once (the loser answers status "busy");
// every FunnelFox page has a timeout, so no call outlives its lease. A FunnelFox 429 parks the pipeline
// until stats.rate_limited_until (Retry-After, default 60s). Any other FunnelFox error backs the cron
// off exponentially (stats.error_backoff_until, at most an hour); a cursor FunnelFox keeps refusing is
// dropped after CURSOR_RESET_AFTER_ERRORS errors in a row (the pass restarts), and the daily refresh
// restarts a pipeline left in an error. has_more without a recognised next cursor, or a 2xx without a
// data array, is an error — never a silent "completed".
//
// Pure logic mirrors src/services/funnelfoxLeadsTransform.ts (kept in lockstep). FUNNELFOX_SECRET
// stays server-side; no email, raw payload or cursor value is logged, and the diagnose (dry_run)
// returns key names and counts only.
//
// Access (policies/funnelfox-leads-sync.ts): a session needs raw access + admin.sync.run (sync /
// sync_full_reset / dry_run, derived from the flags); the pg_cron ticks (migration 202610060011: the
// minute advance tick and the daily refresh) authenticate with x-cron-secret through the gate's cron
// branch and may run sync / sync_full_reset only. Either way rows are written for the workspace data
// key (ctx.tenantKey). A cron full_reset that arrives while the pipeline is still unfinished runs as a
// plain advance, so the daily refresh never restarts a healthy running backfill (one whose last run
// ended in an error is restarted).

import type { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { FUNNELFOX_LEADS_SYNC_POLICY } from "../_shared/access/policies/funnelfox-leads-sync.ts";
import { fetchFunnelFox, funnelFoxErrorResponse, funnelFoxFailure, getFunnelFoxSecret } from "../_shared/funnelfox.ts";

type JsonRecord = Record<string, unknown>;
/** The gate's service-role client (a supabase-js client; typed narrowly there). */
type ServiceClient = ReturnType<typeof createClient>;

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const DEFAULT_MAX_PAGES = 200;
const MAX_PAGES_CAP = 1000;
const DRY_RUN_MAX_PAGES = 2;
const SOFT_TIME_BUDGET_MS = 50_000; // stay under the ~60s Edge wall clock; resume next call if exceeded
const UPSERT_BATCH = 500;
const LOOKUP_BATCH = 200; // profile ids per `.in()` lookup (keeps the PostgREST URL short)
const FLUSH_EVERY_PAGES = 10;
const LEASE_SECONDS = 120; // > budget + one page timeout + final writes; an orphaned lease (killed call) expires on its own
// One FunnelFox list page: a hung request is abandoned (an api_error of that page) long before the
// lease runs out, so a call can never outlive its lease and overlap the next tick.
const FUNNELFOX_PAGE_TIMEOUT_MS = 20_000;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 3600;
// After a FunnelFox error the cron backs off exponentially (60s, 120s, 240s, … at most an hour).
const ERROR_BACKOFF_BASE_SECONDS = 60;
const ERROR_BACKOFF_MAX_SECONDS = 3600;
// This many consecutive errors on a cursor FunnelFox refuses (4xx, or one that does not advance)
// drop that stage's cursor, so the next run restarts the pass instead of retrying it forever.
const CURSOR_RESET_AFTER_ERRORS = 3;
const CURSOR_REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);
const EMAIL_SOURCE_LIST = "list";

// ---- pure helpers (mirror funnelfoxLeadsTransform.ts) ----------------------------------------

// Must match MEDIA_BUYER_BY_UTM_SOURCE in src/services/userMediaBuyer.ts.
const MEDIA_BUYER_BY_UTM: Record<string, string> = { "4": "Ivan", "19": "Artem A", "22": "Artem D" };

type SyncStage = "profiles" | "sessions" | "reconcile";
type SyncStoppedReason = "completed" | "soft_timeout" | "max_pages_reached" | "rate_limited" | "api_error" | "unknown";
type CursorKey = "cursor" | "next_cursor";

interface StageCompletion {
  profiles_completed: boolean;
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
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
function normalizeProfileId(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().replace(/^pro_/i, "");
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
function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveIntParam(value: unknown, fallback: number, min: number, max: number): number {
  // An absent param (undefined/null/"") must use the fallback — NOT collapse to Number(null)===0,
  // which is finite and clamped up to `min` (1): every call that omitted limit / max_pages crawled
  // one page of one profile.
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

function readNextCursor(pagination: JsonRecord, requestCursor?: string | null): { cursor: string | null; key: CursorKey | null; stuck: boolean } {
  // FunnelFox paginates with { cursor, has_more } (verified on /funnels and /subscriptions); accept
  // next_cursor too. A cursor equal to the one the page was requested with would loop forever.
  let stuck = false;
  for (const key of ["cursor", "next_cursor"] as const) {
    const raw = pagination[key];
    if (typeof raw !== "string" || raw === "") continue;
    if (requestCursor && raw === requestCursor) {
      stuck = true;
      continue;
    }
    return { cursor: raw, key, stuck: false };
  }
  return { cursor: null, key: null, stuck };
}

function readReportedTotal(pagination: JsonRecord): number | null {
  for (const key of ["total", "total_count", "totalCount", "count"]) {
    const value = pagination[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_MIN_MS = Date.UTC(2015, 0, 1);
const ULID_MAX_MS = Date.UTC(2100, 0, 1);

function ulidTimestampMs(id: unknown): number | null {
  const bare = normalizeProfileId(id).toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(bare)) return null;
  let ms = 0;
  for (let i = 0; i < 10; i += 1) ms = ms * 32 + CROCKFORD_BASE32.indexOf(bare[i]);
  return ms >= ULID_MIN_MS && ms <= ULID_MAX_MS ? ms : null;
}
function ulidIso(id: unknown): string | null {
  const ms = ulidTimestampMs(id);
  return ms == null ? null : new Date(ms).toISOString();
}

function listRowEmail(row: JsonRecord): { email: string; normalized_email: string } | null {
  const candidates: unknown[] = [row.email];
  const preview = row.preview;
  if (typeof preview === "string") candidates.push(preview.match(/[^\s"']+@[^\s"']+\.[^\s"']+/)?.[0]);
  if (preview && typeof preview === "object") {
    const record = preview as JsonRecord;
    candidates.push(record.email, record.contact_email);
  }
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const email = candidate.trim();
    const normalized = normalizeEmail(email);
    if (normalized && looksLikeEmail(normalized)) return { email, normalized_email: normalized };
  }
  return null;
}
function emailFromListRow(row: JsonRecord): string | null {
  return listRowEmail(row)?.normalized_email ?? null;
}

interface ParsedProfile {
  profile_id: string;
  created_at: string | null;
  updated_at: string | null;
  funnel_id: string | null;
  email: string | null;
  normalized_email: string | null;
  preview: boolean;
}

function parseProfileListRow(row: JsonRecord): ParsedProfile {
  const profileId = normalizeProfileId(row.profile_id ?? row.id);
  const email = listRowEmail(row);
  return {
    profile_id: profileId,
    created_at: strOrNull(row.created_at) ?? ulidIso(profileId),
    updated_at: strOrNull(row.updated_at),
    funnel_id: strOrNull(row.funnel_id),
    email: email?.email ?? null,
    normalized_email: email?.normalized_email ?? null,
    preview: row.preview === true,
  };
}

interface ProfileScan {
  store: ParsedProfile[];
  scanned: number;
  with_email: number;
  without_email: number;
  preview: number;
  preview_with_email: number;
  skipped_no_profile_id: number;
  duplicates: number;
}

function scanProfileRows(rows: JsonRecord[]): ProfileScan {
  const seen = new Set<string>();
  const scan: ProfileScan = {
    store: [],
    scanned: 0,
    with_email: 0,
    without_email: 0,
    preview: 0,
    preview_with_email: 0,
    skipped_no_profile_id: 0,
    duplicates: 0,
  };
  for (const row of rows) {
    const profile = parseProfileListRow(row);
    if (!profile.profile_id) {
      scan.skipped_no_profile_id += 1;
      continue;
    }
    if (seen.has(profile.profile_id)) {
      scan.duplicates += 1;
      continue;
    }
    seen.add(profile.profile_id);
    scan.scanned += 1;
    if (profile.preview) scan.preview += 1;
    if (profile.normalized_email) {
      scan.with_email += 1;
      if (profile.preview) scan.preview_with_email += 1;
      scan.store.push(profile);
    } else {
      scan.without_email += 1;
    }
  }
  return scan;
}

// The columns the profile list owns. Conversion columns are reconcile's; funnel_id only when present.
function profileUpsertRow(profile: ParsedProfile, syncedAt: string): JsonRecord {
  const row: JsonRecord = {
    profile_id: profile.profile_id,
    email: profile.email,
    normalized_email: profile.normalized_email,
    email_source: EMAIL_SOURCE_LIST,
    detail_checked: true,
    preview: profile.preview,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    synced_at: syncedAt,
  };
  if (profile.funnel_id) row.funnel_id = profile.funnel_id;
  return row;
}

// supabase-js fills a key missing from some rows of a bulk upsert with NULL: batch by key set.
function groupRowsByKeySet<T extends JsonRecord>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const signature = Object.keys(row).sort().join(",");
    const group = groups.get(signature);
    if (group) group.push(row);
    else groups.set(signature, [row]);
  }
  return [...groups.values()];
}

const PASS_COUNTER_KEYS = [
  "profiles_scanned_total",
  "profiles_with_email",
  "profiles_without_email",
  "preview_excluded",
  "preview_with_email",
  "profiles_skipped_no_profile_id",
  "profiles_duplicates_skipped",
] as const;
type PassCounters = Record<(typeof PASS_COUNTER_KEYS)[number], number>;

function readPassCounters(stats: JsonRecord | null | undefined, reset: boolean): PassCounters {
  const counters = {} as PassCounters;
  for (const key of PASS_COUNTER_KEYS) {
    const value = Number(readRecord(stats)[key] ?? 0);
    counters[key] = reset || !Number.isFinite(value) ? 0 : value;
  }
  return counters;
}
function addProfileScan(counters: PassCounters, scan: ProfileScan): void {
  counters.profiles_scanned_total += scan.scanned;
  counters.profiles_with_email += scan.with_email;
  counters.profiles_without_email += scan.without_email;
  counters.preview_excluded += scan.preview;
  counters.preview_with_email += scan.preview_with_email;
  counters.profiles_skipped_no_profile_id += scan.skipped_no_profile_id;
  counters.profiles_duplicates_skipped += scan.duplicates;
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
}

function parseSessionRow(row: JsonRecord): ParsedSession {
  return {
    session_id: str(row.session_id ?? row.id),
    profile_id: normalizeProfileId(row.profile_id),
    country_code: normalizeCountryCode(row.country),
    user_agent: strOrNull(row.user_agent),
    funnel_id: strOrNull(row.funnel_id),
    funnel_version: strOrNull(row.funnel_version),
    origin: strOrNull(row.origin),
    created_at: strOrNull(row.created_at),
    city: strOrNull(row.city),
    postal: strOrNull(row.postal),
  };
}

function dateMs(value: string | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

function joinSessionsToProfiles(sessions: ParsedSession[]): Map<string, ParsedSession> {
  const byProfile = new Map<string, ParsedSession>();
  for (const session of sessions) {
    if (!session.profile_id) continue;
    const current = byProfile.get(session.profile_id);
    if (!current || dateMs(session.created_at) < dateMs(current.created_at)) byProfile.set(session.profile_id, session);
  }
  return byProfile;
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

interface StoredAttribution {
  session_created_at: string | null;
  funnel_id: string | null;
}

// Earliest-wins attribution for a STORED profile; null when not stored or already as early.
function sessionAttributionRow(profileId: string, session: ParsedSession, existing: StoredAttribution | undefined, syncedAt: string): JsonRecord | null {
  if (!existing) return null;
  if (existing.session_created_at && dateMs(existing.session_created_at) <= dateMs(session.created_at)) return null;
  const attribution = parseOriginUrl(session.origin);
  return {
    profile_id: profileId,
    session_id: session.session_id || null,
    session_created_at: session.created_at,
    funnel_version: session.funnel_version,
    funnel_id: existing.funnel_id ?? session.funnel_id,
    campaign_path: attribution.campaign_path,
    campaign_id: attribution.campaign_id,
    utm_source: attribution.utm_source,
    media_buyer: attribution.utm_source ? mediaBuyerFromUtmSource(attribution.utm_source) : null,
    country_code: session.country_code,
    city: session.city,
    postal: session.postal,
    user_agent: session.user_agent,
    origin: session.origin,
    synced_at: syncedAt,
  };
}

function parseSyncStage(value: unknown): SyncStage | null {
  const stage = str(value).toLowerCase();
  return stage === "profiles" || stage === "sessions" || stage === "reconcile" ? stage : null;
}

function nextIncompleteStage(flags: StageCompletion): SyncStage | null {
  if (!flags.profiles_completed) return "profiles";
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
  rateLimited?: boolean;
}): SyncStoppedReason {
  if (input.apiError) return "api_error";
  if (input.rateLimited) return "rate_limited";
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

function resolveStartCursor(savedCursor: string | null | undefined, fullReset: boolean): string | undefined {
  if (fullReset) return undefined;
  return savedCursor ?? undefined;
}

// Written BEFORE a reset crawls: all stage flags false, both cursors null (details stage is gone → true).
function fullResetState() {
  return {
    profiles_completed: false,
    details_completed: true,
    sessions_completed: false,
    reconcile_completed: false,
    last_profiles_cursor: null,
    last_sessions_cursor: null,
    profiles_scanned_total: 0,
    sessions_scanned_total: 0,
    profiles_total_reported_by_api: null,
    current_stage: "profiles" as SyncStage,
  };
}

function parseRetryAfterSeconds(value: string | null | undefined, nowMs: number): number {
  const raw = (value ?? "").trim();
  let seconds = Number.NaN;
  if (/^\d+(\.\d+)?$/.test(raw)) seconds = Math.ceil(Number(raw));
  else if (raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) seconds = Math.ceil((at - nowMs) / 1000);
  }
  if (!Number.isFinite(seconds)) return DEFAULT_RETRY_AFTER_SECONDS;
  return Math.max(1, Math.min(MAX_RETRY_AFTER_SECONDS, seconds));
}

function readIsoMs(stats: JsonRecord | null | undefined, key: string): number | null {
  const raw = readRecord(stats)[key];
  if (typeof raw !== "string" || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}
function readRateLimitedUntilMs(stats: JsonRecord | null | undefined): number | null {
  return readIsoMs(stats, "rate_limited_until");
}
function readErrorBackoffUntilMs(stats: JsonRecord | null | undefined): number | null {
  return readIsoMs(stats, "error_backoff_until");
}

// Backoff after the Nth consecutive FunnelFox error (N >= 1): 60s · 2^(N-1), at most an hour.
function errorBackoffSeconds(consecutiveErrors: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(consecutiveErrors) ? consecutiveErrors : 1));
  return Math.min(ERROR_BACKOFF_MAX_SECONDS, ERROR_BACKOFF_BASE_SECONDS * 2 ** Math.min(n - 1, 16));
}

type RunPlan =
  | { kind: "idle" }
  | { kind: "rate_limited"; until: string; stage: SyncStage | null }
  | { kind: "error_backoff"; until: string; stage: SyncStage | null }
  | { kind: "run"; stage: SyncStage; reset: boolean };

function planRun(input: {
  flags: StageCompletion;
  requestedStage: SyncStage | null;
  fullReset: boolean;
  cron: boolean;
  rateLimitedUntilMs: number | null;
  nowMs: number;
  lastStatus?: string | null;
  errorBackoffUntilMs?: number | null;
}): RunPlan {
  const next = nextIncompleteStage(input.flags);
  // A cron full_reset restarts a complete pipeline (the daily refresh) or one stuck in an error; a
  // healthy unfinished backfill is only advanced.
  const reset = input.fullReset && !(input.cron && next !== null && input.lastStatus !== "error");
  if (!reset && !input.requestedStage && next === null) return { kind: "idle" };
  if (input.rateLimitedUntilMs != null && input.rateLimitedUntilMs > input.nowMs) {
    return { kind: "rate_limited", until: new Date(input.rateLimitedUntilMs).toISOString(), stage: input.requestedStage ?? next };
  }
  // The error backoff spaces the cron's retries only: a user click and a reset run at once.
  if (input.cron && !reset && input.errorBackoffUntilMs != null && input.errorBackoffUntilMs > input.nowMs) {
    return { kind: "error_backoff", until: new Date(input.errorBackoffUntilMs).toISOString(), stage: input.requestedStage ?? next };
  }
  if (reset) return { kind: "run", stage: input.requestedStage ?? "profiles", reset: true };
  return { kind: "run", stage: (input.requestedStage ?? next) as SyncStage, reset: false };
}

function computeCoveragePercent(scannedTotal: number, totalReported: number | null): number | null {
  if (!totalReported || totalReported <= 0) return null;
  return Math.min(100, Math.round((scannedTotal / totalReported) * 10000) / 100);
}

function computeCoverageWarning(input: { stoppedReason: SyncStoppedReason; stage: SyncStage }): {
  coverage_warning: boolean;
  coverage_warning_message: string;
} {
  switch (input.stoppedReason) {
    case "max_pages_reached":
      return {
        coverage_warning: true,
        coverage_warning_message: `Sync stopped because max_pages was reached while FunnelFox still had more ${input.stage === "sessions" ? "sessions" : "profiles"}.`,
      };
    case "soft_timeout":
      return {
        coverage_warning: true,
        coverage_warning_message: "Sync stopped because soft timeout was reached before pagination finished.",
      };
    case "rate_limited":
      return {
        coverage_warning: true,
        coverage_warning_message: "FunnelFox rate-limited the sync (HTTP 429); it resumes automatically after the backoff.",
      };
    case "api_error":
      return {
        coverage_warning: true,
        coverage_warning_message: "Sync stopped because the FunnelFox API returned an error before pagination finished.",
      };
    default:
      return { coverage_warning: false, coverage_warning_message: "" };
  }
}

// ---- diagnose helpers (key names and counts only, never values) ------------------------------

function rateLimitHeaderNames(headers: { forEach(callback: (value: string, key: string) => void): void } | null | undefined): string[] {
  const names: string[] = [];
  if (!headers || typeof headers.forEach !== "function") return names;
  headers.forEach((_value, key) => {
    const name = key.toLowerCase();
    if (/rate|retry|limit/.test(name) && !names.includes(name)) names.push(name);
  });
  return names.sort();
}

function rowTimestampMs(row: JsonRecord): number | null {
  const created = Date.parse(str(row.created_at));
  if (Number.isFinite(created)) return created;
  return ulidTimestampMs(row.id ?? row.profile_id);
}

function detectListOrder(rows: JsonRecord[]): "newest_first" | "oldest_first" | "mixed" | "unknown" {
  const times = rows.map(rowTimestampMs).filter((value): value is number => value != null);
  if (times.length < 2) return "unknown";
  let descending = 0;
  let ascending = 0;
  for (let i = 1; i < times.length; i += 1) {
    if (times[i] < times[i - 1]) descending += 1;
    else if (times[i] > times[i - 1]) ascending += 1;
  }
  if (descending > 0 && ascending === 0) return "newest_first";
  if (ascending > 0 && descending === 0) return "oldest_first";
  return descending === 0 && ascending === 0 ? "unknown" : "mixed";
}

function keyCounts(rows: JsonRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) for (const key of Object.keys(row)) counts[key] = (counts[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

function idForms(ids: unknown[]): { pro_prefixed: number; bare: number; missing: number; ulid: number } {
  const forms = { pro_prefixed: 0, bare: 0, missing: 0, ulid: 0 };
  for (const value of ids) {
    const id = str(value);
    if (!id) forms.missing += 1;
    else if (/^pro_/i.test(id)) forms.pro_prefixed += 1;
    else forms.bare += 1;
    if (id && ulidTimestampMs(id) != null) forms.ulid += 1;
  }
  return forms;
}

// Dot-paths (arrays as `[]`) of string values that look like an email — PATH NAMES only.
function collectEmailPaths(value: unknown, prefix = "", depth = 5, out: string[] = []): string[] {
  if (value == null || depth < 0 || out.length >= 12) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEmailPaths(item, `${prefix}[]`, depth - 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as JsonRecord)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (typeof entry === "string") {
        if (looksLikeEmail(entry) && !out.includes(path) && out.length < 12) out.push(path);
      } else {
        collectEmailPaths(entry, path, depth - 1, out);
      }
    }
  }
  return out;
}

function summarizeProfileSample(rows: JsonRecord[]) {
  let withEmail = 0;
  let rootEmail = 0;
  let previewTrue = 0;
  let previewWithEmail = 0;
  let createdAtPresent = 0;
  const previewTypes: Record<string, number> = {};
  const emailPaths: string[] = [];
  for (const row of rows) {
    const hasEmail = Boolean(emailFromListRow(row));
    if (hasEmail) withEmail += 1;
    if (typeof row.email === "string" && looksLikeEmail(row.email)) rootEmail += 1;
    if (row.preview === true) {
      previewTrue += 1;
      if (hasEmail) previewWithEmail += 1;
    }
    const previewType = row.preview === undefined ? "missing" : row.preview === null ? "null" : typeof row.preview;
    previewTypes[previewType] = (previewTypes[previewType] ?? 0) + 1;
    if (strOrNull(row.created_at)) createdAtPresent += 1;
    for (const path of collectEmailPaths(row)) if (!emailPaths.includes(path)) emailPaths.push(path);
  }
  return {
    rows: rows.length,
    key_counts: keyCounts(rows),
    with_email: withEmail,
    root_email: rootEmail,
    without_email: rows.length - withEmail,
    preview_true: previewTrue,
    preview_with_email: previewWithEmail,
    preview_types: previewTypes,
    id_forms: idForms(rows.map((row) => row.profile_id ?? row.id)),
    created_at_present: createdAtPresent,
    order: detectListOrder(rows),
    email_paths: emailPaths.sort(),
  };
}

function summarizeSessionSample(rows: JsonRecord[], profileIds: Set<string>) {
  const parsed = rows.map(parseSessionRow);
  return {
    rows: rows.length,
    key_counts: keyCounts(rows),
    with_profile_id: parsed.filter((session) => session.profile_id).length,
    profile_id_forms: idForms(rows.map((row) => row.profile_id)),
    matching_profile_sample: parsed.filter((session) => session.profile_id && profileIds.has(session.profile_id)).length,
    order: detectListOrder(rows),
  };
}

// ---- FunnelFox crawling ----------------------------------------------------------------------

interface CrawlPageResult {
  ok: boolean;
  status?: number;
  rows: JsonRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  cursorKey?: CursorKey | null;
  cursorStuck?: boolean;
  totalReported?: number | null;
  retryAfterSeconds?: number | null;
  errorMessage?: string | null;
  paginationKeys?: string[];
  rateLimitHeaders?: string[];
}

interface CrawlOutcome {
  rows: JsonRecord[];
  pages: number;
  scannedRows: number;
  checkpoints: number;
  lastCursor: string | null;
  hasMoreOnLastPage: boolean;
  stoppedReason: SyncStoppedReason;
  totalReported: number | null;
  errorMessage: string | null;
  retryAfterSeconds: number | null;
  paginationKeys: string[];
  cursorKey: CursorKey | null;
  rateLimitHeaders: string[];
  /** The crawl stopped on a cursor FunnelFox refused (a 4xx in CURSOR_REJECTED_STATUSES, or a cursor
   * that did not advance) — retrying that cursor cannot succeed. */
  cursorRejected: boolean;
}

async function fetchListPage(base: string, cursor: string | undefined, limit: number, secret: string): Promise<CrawlPageResult> {
  const params = new URLSearchParams();
  if (limit) params.set("limit", String(limit));
  if (cursor) params.set("cursor", cursor);
  const qs = params.toString();
  let response: Awaited<ReturnType<typeof fetchFunnelFox>>;
  try {
    response = await fetchFunnelFox(`${base}${qs ? `?${qs}` : ""}`, secret, { timeoutMs: FUNNELFOX_PAGE_TIMEOUT_MS });
  } catch (error) {
    // A network failure or a timeout is an api_error of this page: the crawl keeps what it already has.
    const message = error instanceof Error ? error.message : "network error";
    return { ok: false, status: 0, rows: [], hasMore: false, nextCursor: null, errorMessage: `FunnelFox ${base} request failed: ${message}`.slice(0, 300) };
  }
  const { ok, status, payload, headers } = response;
  const root = readRecord(payload);
  const pagination = readRecord(root.pagination);
  const next = readNextCursor(pagination, cursor);
  const upstreamMessage = str(root.message ?? root.error ?? root.detail).slice(0, 200);
  // A 2xx without a `data` array (an HTML maintenance page, an unparsable body) is not "an empty last
  // page": counting it as one would mark the pass complete and silently cut the export short.
  const shapeOk = !ok || Array.isArray(root.data);
  return {
    ok: ok && shapeOk,
    status,
    rows: (Array.isArray(root.data) ? root.data : []).filter((r): r is JsonRecord => Boolean(r && typeof r === "object")),
    hasMore: Boolean(pagination.has_more),
    nextCursor: next.cursor,
    cursorKey: next.key,
    cursorStuck: next.stuck,
    totalReported: readReportedTotal(pagination),
    retryAfterSeconds: status === 429 ? parseRetryAfterSeconds(headers?.get?.("retry-after") ?? null, Date.now()) : null,
    errorMessage: !ok
      ? `FunnelFox ${base} HTTP ${status}${upstreamMessage ? `: ${upstreamMessage}` : ""}`
      : shapeOk
        ? null
        : `FunnelFox ${base} HTTP ${status} returned no data array (body keys: ${Object.keys(root).sort().join(", ").slice(0, 120) || "none"}).`,
    paginationKeys: Object.keys(pagination).sort(),
    rateLimitHeaders: rateLimitHeaderNames(headers),
  };
}

async function crawlList(
  fetchPage: (cursor: string | undefined) => Promise<CrawlPageResult>,
  opts: {
    startCursor?: string;
    maxPages: number;
    isExpired: () => boolean;
    flushEveryPages?: number;
    onCheckpoint?: (rows: JsonRecord[], resumeCursor: string) => Promise<void>;
  },
): Promise<CrawlOutcome> {
  let rows: JsonRecord[] = [];
  let cursor = opts.startCursor;
  let pages = 0;
  let pagesSinceCheckpoint = 0;
  let checkpoints = 0;
  let scannedRows = 0;
  let lastCursor: string | null = opts.startCursor ?? null;
  let hasMoreOnLastPage = false;
  let apiError = false;
  let rateLimited = false;
  let timedOut = false;
  let totalReported: number | null = null;
  let errorMessage: string | null = null;
  let retryAfterSeconds: number | null = null;
  let cursorKey: CursorKey | null = null;
  let cursorRejected = false;
  const paginationKeys = new Set<string>();
  const rateLimitHeaders = new Set<string>();

  while (pages < opts.maxPages) {
    if (opts.isExpired()) {
      timedOut = true;
      break;
    }
    const page = await fetchPage(cursor);
    for (const key of page.paginationKeys ?? []) paginationKeys.add(key);
    for (const name of page.rateLimitHeaders ?? []) rateLimitHeaders.add(name);
    if (!page.ok) {
      if (page.status === 429) {
        rateLimited = true;
        retryAfterSeconds = page.retryAfterSeconds ?? null;
      } else {
        apiError = true;
        cursorRejected = Boolean(cursor) && CURSOR_REJECTED_STATUSES.has(page.status ?? 0);
      }
      errorMessage = page.errorMessage ?? null;
      break;
    }
    rows.push(...page.rows);
    scannedRows += page.rows.length;
    pages += 1;
    pagesSinceCheckpoint += 1;
    if (page.totalReported != null) totalReported = page.totalReported;
    if (page.cursorKey) cursorKey ??= page.cursorKey;
    if (page.hasMore && !page.nextCursor) {
      // has_more without a usable next cursor fails closed: either the only cursor offered is the
      // one this page was requested with (re-requesting it would loop), or the cursor sits under a key
      // this sync does not read — "completed" would silently cut the export short. The page's rows
      // are kept; the saved cursor stays on this page.
      apiError = true;
      hasMoreOnLastPage = true;
      if (page.cursorStuck) {
        cursorRejected = Boolean(cursor);
        errorMessage = "FunnelFox pagination cursor did not advance.";
      } else {
        const keys = (page.paginationKeys ?? []).join(", ").slice(0, 200) || "none";
        errorMessage = `FunnelFox pagination has has_more=true but no recognised next cursor (pagination keys: ${keys}).`;
      }
      break;
    }
    const more = page.hasMore && Boolean(page.nextCursor);
    hasMoreOnLastPage = more;
    lastCursor = page.nextCursor ?? lastCursor;
    if (!more) break;
    cursor = page.nextCursor ?? undefined;
    if (
      opts.onCheckpoint &&
      opts.flushEveryPages &&
      pagesSinceCheckpoint >= opts.flushEveryPages &&
      pages < opts.maxPages &&
      cursor
    ) {
      await opts.onCheckpoint(rows, cursor);
      rows = [];
      pagesSinceCheckpoint = 0;
      checkpoints += 1;
    }
  }

  return {
    rows,
    pages,
    scannedRows,
    checkpoints,
    lastCursor,
    hasMoreOnLastPage,
    stoppedReason: determineStopReason({ pages, maxPages: opts.maxPages, hasMoreOnLastPage, timedOut, apiError, rateLimited }),
    totalReported,
    errorMessage,
    retryAfterSeconds,
    paginationKeys: [...paginationKeys].sort(),
    cursorKey,
    rateLimitHeaders: [...rateLimitHeaders].sort(),
    cursorRejected,
  };
}

// Stats keys of the removed profile_details stage (dropped from sync_state.stats on the next write).
const LEGACY_STAT_KEYS = [
  "profile_details_attempted",
  "profile_details_fetched",
  "profile_details_failed",
  "profile_details_gone",
  "profile_details_timeout_skipped",
  "remaining_without_email_after_checked",
];

// ---- Stage 3: reconcile ----------------------------------------------------------------------

/** PostgREST's answer for an RPC that is not in its schema cache (the migration that adds it is not
 * applied yet): PGRST202, HTTP 404. Mirrors isMissingRpcError in _shared/clickhouse/leads.ts (not
 * imported: that module is the ClickHouse Leads runner, which this function never loads). */
function isMissingRpcError(error: unknown, status?: unknown): boolean {
  if (status === 404) return true;
  const record = readRecord(error);
  return record.code === "PGRST202" || /could not find the function/i.test(str(record.message));
}

function isoOrNull(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Stage 3 → the stats keys it sets. Queues the reconcile (funnelfox_leads_reconcile_request: one
 * row update stamping sync_state.reconcile_requested_at); the pg_cron job funnelfox-leads-reconcile
 * (migration 202610070001) runs funnelfox_leads_reconcile as postgres within a minute. The counts
 * are those of the last APPLIED run (the request answers its summary); before the first applied run
 * there is none and the previous stats values stay. While that migration is not applied
 * (PGRST202 / 404) the reconcile runs inline through PostgREST, exactly as before. Any other error
 * throws (the run ends in last_status "error").
 */
async function runReconcileStage(db: ServiceClient, tenantKey: string): Promise<JsonRecord> {
  const request = await db.rpc("funnelfox_leads_reconcile_request", { p_data_key: tenantKey });
  if (request.error && isMissingRpcError(request.error, request.status)) {
    console.warn("funnelfox-leads-sync: funnelfox_leads_reconcile_request is missing (migration 202610070001 not applied) — reconciling inline");
    const { data, error } = await db.rpc("funnelfox_leads_reconcile", { p_data_key: tenantKey });
    if (error) throw new Error(`reconcile failed: ${error.message}`);
    const result = readRecord(data);
    return {
      reconcile_rows: numberOr(result.checked, 0),
      leads_found: numberOr(result.leads, 0),
      converted_excluded: numberOr(result.paid_excluded, 0),
      active_sub_excluded: numberOr(result.active_excluded, 0),
      reconciled_at: new Date().toISOString(),
    };
  }
  if (request.error) throw new Error(`reconcile request failed: ${request.error.message}`);
  const queued = readRecord(request.data);
  // The run upserted the sync-state row before this stage, so "not queued" means nothing was stamped.
  if (queued.queued !== true) throw new Error("reconcile request failed: the sync state row to queue it on is missing.");

  const stats: JsonRecord = { reconcile_queued_at: isoOrNull(queued.requested_at) ?? new Date().toISOString() };
  const last = readRecord(queued.last_summary);
  if (Object.keys(last).length > 0) {
    stats.reconcile_rows = numberOr(last.checked, 0);
    stats.leads_found = numberOr(last.leads, 0);
    stats.converted_excluded = numberOr(last.paid_excluded, 0);
    stats.active_sub_excluded = numberOr(last.active_excluded, 0);
    const appliedAt = isoOrNull(last.applied_at) ?? isoOrNull(queued.last_applied_at);
    if (appliedAt) stats.reconciled_at = appliedAt;
  }
  return stats;
}

// ---- HTTP entry ------------------------------------------------------------------------------

serveWithAccess(FUNNELFOX_LEADS_SYNC_POLICY, async ({ ctx, action, body, url, pg }) => {
  const startedAt = Date.now();
  const deadline = startedAt + SOFT_TIME_BUDGET_MS;
  const isExpired = () => Date.now() > deadline;

  const secret = getFunnelFoxSecret();
  if (!secret) return funnelFoxFailure(ctx, 500, { error: "FunnelFox is not configured." });

  // Who may call was decided by the gate: the data owner with admin.sync.run, or the pg_cron tick
  // (x-cron-secret). Rows are written for the workspace data key, never for "the caller" as such.
  const tenantKey = ctx.tenantKey;
  const db = pg as unknown as ServiceClient;
  const isCron = ctx.actor.kind === "cron";

  // Params from query and/or JSON body (the gate parsed the body after authenticating).
  const limit = resolveIntParam(body.limit ?? url.searchParams.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  // The dry_run / full_reset flags were parsed into the authorized action by the policy
  // (funnelFoxSyncFlags — the same rules as before; dry_run wins).
  const dryRun = action === "dry_run";
  const fullReset = action === "sync_full_reset";
  const maxPages = resolveIntParam(
    body.max_pages ?? url.searchParams.get("max_pages"),
    dryRun ? DRY_RUN_MAX_PAGES : DEFAULT_MAX_PAGES,
    1,
    MAX_PAGES_CAP,
  );
  const requestedStage = parseSyncStage(body.stage ?? url.searchParams.get("stage"));
  // A `conversion` key in the body (the browser-computed context of the old reconcile) is never read.

  const fetchPage = (base: string) => (cursor: string | undefined) => fetchListPage(base, cursor, limit, secret);

  // ---- Diagnose (dry run): key names + counts only, no writes, never /profiles/{id} -----------
  if (dryRun) {
    try {
      const profileProbe = await crawlList(fetchPage("/profiles"), { maxPages: Math.min(maxPages, DRY_RUN_MAX_PAGES), isExpired });
      const sessionProbe = await crawlList(fetchPage("/sessions"), { maxPages: 1, isExpired });
      const profiles = summarizeProfileSample(profileProbe.rows);
      const profileIds = new Set(profileProbe.rows.map((row) => normalizeProfileId(row.profile_id ?? row.id)).filter(Boolean));
      const sessions = summarizeSessionSample(sessionProbe.rows, profileIds);
      return {
        status: "ok",
        dry_run: true,
        stage: "profiles",
        made_progress: false,
        all_stages_completed: false,
        diagnostics: {
          profiles_pages_probed: profileProbe.pages,
          profiles_rows_probed: profileProbe.rows.length,
          profiles_has_more_on_last_page: profileProbe.hasMoreOnLastPage,
          profiles_total_reported_by_api: profileProbe.totalReported,
          list_row_contains_email: profiles.with_email > 0,
          list_rows_with_email: profiles.with_email,
          sample_profile_keys: Object.keys(profileProbe.rows[0] ?? {}),
          sample_session_keys: Object.keys(sessionProbe.rows[0] ?? {}),
          sample_size: { profiles: profileProbe.rows.length, sessions: sessionProbe.rows.length },
          profiles: {
            pages: profileProbe.pages,
            stopped_reason: profileProbe.stoppedReason,
            pagination_keys: profileProbe.paginationKeys,
            cursor_key: profileProbe.cursorKey,
            has_more: profileProbe.hasMoreOnLastPage,
            total_reported: profileProbe.totalReported,
            ...profiles,
          },
          sessions: {
            pages: sessionProbe.pages,
            stopped_reason: sessionProbe.stoppedReason,
            pagination_keys: sessionProbe.paginationKeys,
            cursor_key: sessionProbe.cursorKey,
            has_more: sessionProbe.hasMoreOnLastPage,
            ...sessions,
          },
          rate_limit_headers: [...new Set([...profileProbe.rateLimitHeaders, ...sessionProbe.rateLimitHeaders])].sort(),
          profile_detail_endpoint: "not_called",
          note: "Diagnose: no rows written; no emails, raw payloads or cursor values returned.",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "dry run failed";
      return funnelFoxFailure(ctx, 502, { error: "FunnelFox leads dry run failed.", detail: message });
    }
  }

  const readState = async (): Promise<JsonRecord | null> => {
    const { data, error } = await db.from("funnelfox_leads_sync_state").select("*").eq("auth_user_id", tenantKey).maybeSingle();
    if (error) throw new Error(`sync state read failed: ${error.message}`);
    return (data ?? null) as JsonRecord | null;
  };
  const flagsOf = (state: JsonRecord | null): StageCompletion => ({
    profiles_completed: Boolean(state?.profiles_completed),
    sessions_completed: Boolean(state?.sessions_completed),
    reconcile_completed: Boolean(state?.reconcile_completed),
  });
  const planFor = (state: JsonRecord | null) =>
    planRun({
      flags: flagsOf(state),
      requestedStage,
      fullReset,
      cron: isCron,
      rateLimitedUntilMs: readRateLimitedUntilMs(readRecord(state?.stats)),
      nowMs: Date.now(),
      lastStatus: strOrNull(state?.last_status),
      errorBackoffUntilMs: readErrorBackoffUntilMs(readRecord(state?.stats)),
    });
  // Idle / rate-limited / backing-off / busy answers: nothing ran, nothing was written.
  const quietResponse = (plan: RunPlan, state: JsonRecord | null) => {
    const summary = readRecord(state?.stats);
    if (plan.kind === "idle") {
      return {
        status: "ok",
        dry_run: false,
        stage: null,
        next_stage: null,
        all_stages_completed: true,
        made_progress: false,
        idle: true,
        stopped_reason: "completed",
        coverage_warning: false,
        coverage_warning_message: "",
        summary,
      };
    }
    if (plan.kind === "rate_limited") {
      return {
        status: "partial",
        dry_run: false,
        stage: plan.stage,
        next_stage: plan.stage,
        all_stages_completed: false,
        made_progress: false,
        rate_limited: true,
        rate_limited_until: plan.until,
        stopped_reason: "rate_limited",
        ...computeCoverageWarning({ stoppedReason: "rate_limited", stage: plan.stage ?? "profiles" }),
        summary,
      };
    }
    if (plan.kind === "error_backoff") {
      // Only the cron gets this (planRun): the last runs failed, the next retry waits until `until`.
      return {
        status: "error",
        dry_run: false,
        stage: plan.stage,
        next_stage: plan.stage,
        all_stages_completed: false,
        made_progress: false,
        error_backoff: true,
        error_backoff_until: plan.until,
        stopped_reason: "api_error",
        ...computeCoverageWarning({ stoppedReason: "api_error", stage: plan.stage ?? "profiles" }),
        summary,
      };
    }
    return {
      status: "busy",
      dry_run: false,
      stage: plan.stage,
      next_stage: plan.stage,
      all_stages_completed: false,
      made_progress: false,
      busy: true,
      coverage_warning: false,
      coverage_warning_message: "",
      summary,
    };
  };

  // One stage, run while holding the lease.
  const runLeased = async () => {
    try {
      // Re-read under the lease: another call may have advanced the state since the first read.
      const stateRow = await readState();
      const plan = planFor(stateRow);
      if (plan.kind !== "run") return quietResponse(plan, stateRow);
      const { stage, reset } = plan;

      const oldStats = readRecord(stateRow?.stats);
      const priorStats: JsonRecord = { ...oldStats };
      for (const key of LEGACY_STAT_KEYS) delete priorStats[key];
      const counters = readPassCounters(oldStats, reset);
      const flags: StageCompletion = reset
        ? { profiles_completed: false, sessions_completed: false, reconcile_completed: false }
        : flagsOf(stateRow);
      const profilesCursor = reset ? null : ((stateRow?.last_profiles_cursor as string | null | undefined) ?? null);
      const sessionsCursor = reset ? null : ((stateRow?.last_sessions_cursor as string | null | undefined) ?? null);
      let sessionsTotal = reset ? 0 : numberOr(stateRow?.sessions_scanned_total, 0);
      let totalReportedByApi: number | null = reset ? null : ((stateRow?.profiles_total_reported_by_api as number | null | undefined) ?? null);

      // Record the stage being worked on (and, for a reset, every flag false + both cursors null)
      // BEFORE crawling: checkpoints below then always land on a consistent row.
      const { error: startError } = await db.from("funnelfox_leads_sync_state").upsert(
        { auth_user_id: tenantKey, ...(reset ? fullResetState() : {}), current_stage: stage },
        { onConflict: "auth_user_id" },
      );
      if (startError) throw new Error(`sync state write failed: ${startError.message}`);

      const upsertLeadRows = async (rows: JsonRecord[]) => {
        for (const group of groupRowsByKeySet(rows)) {
          for (let i = 0; i < group.length; i += UPSERT_BATCH) {
            const { error } = await db.from("funnelfox_leads").upsert(group.slice(i, i + UPSERT_BATCH), { onConflict: "auth_user_id,profile_id" });
            if (error) throw new Error(`${stage} upsert failed: ${error.message}`);
          }
        }
      };
      // Mid-stage checkpoint: rows were written first, so the saved cursor never skips unsaved pages.
      const checkpointState = async (patch: JsonRecord) => {
        const stats = { ...priorStats, ...counters, stage, all_stages_completed: false, checkpoint_at: new Date().toISOString() };
        const { error } = await db
          .from("funnelfox_leads_sync_state")
          .update({ ...patch, stats })
          .eq("auth_user_id", tenantKey);
        if (error) throw new Error(`sync state checkpoint failed: ${error.message}`);
      };

      const syncedAt = new Date().toISOString();
      let stoppedReason: SyncStoppedReason = "completed";
      let madeProgress = true; // false ⇒ this run advanced nothing (lets the driver stop hammering)
      let crawlError: string | null = null;
      let retryAfterSeconds: number | null = null;
      const runStats: JsonRecord = {};
      const cursorUpdate: JsonRecord = {};
      const completionUpdate: Partial<StageCompletion> = {};
      const passSnapshot: JsonRecord = {};
      // FunnelFox errors in a row before this run (any run that does not end in api_error resets it).
      const priorApiErrors = Math.max(0, numberOr(oldStats.consecutive_api_errors, 0));
      // The crawl stopped on a cursor FunnelFox keeps refusing: drop it, so the next run restarts the
      // pass from the newest page instead of failing on the same cursor forever.
      let cursorReset = false;
      const shouldResetCursor = (crawl: CrawlOutcome) =>
        crawl.stoppedReason === "api_error" && crawl.cursorRejected && priorApiErrors + 1 >= CURSOR_RESET_AFTER_ERRORS;

      if (stage === "profiles") {
        // --- Stage 1: crawl the profile list, store the rows that carry an email ----------------
        let savedThisRun = 0;
        let scannedThisRun = 0;
        let withoutEmailThisRun = 0;
        let previewThisRun = 0;
        let skippedThisRun = 0;
        const storeProfiles = async (rawRows: JsonRecord[]) => {
          const scan = scanProfileRows(rawRows);
          await upsertLeadRows(scan.store.map((profile) => ({ auth_user_id: tenantKey, ...profileUpsertRow(profile, syncedAt) })));
          addProfileScan(counters, scan);
          savedThisRun += scan.store.length;
          scannedThisRun += scan.scanned;
          withoutEmailThisRun += scan.without_email;
          previewThisRun += scan.preview;
          skippedThisRun += scan.skipped_no_profile_id;
        };
        const crawl = await crawlList(fetchPage("/profiles"), {
          startCursor: resolveStartCursor(profilesCursor, reset),
          maxPages,
          isExpired,
          flushEveryPages: FLUSH_EVERY_PAGES,
          onCheckpoint: async (rawRows, resumeCursor) => {
            await storeProfiles(rawRows);
            await checkpointState({ last_profiles_cursor: resumeCursor, profiles_scanned_total: counters.profiles_scanned_total });
          },
        });
        await storeProfiles(crawl.rows);

        stoppedReason = crawl.stoppedReason;
        crawlError = crawl.errorMessage;
        retryAfterSeconds = crawl.retryAfterSeconds;
        madeProgress = crawl.pages > 0;
        if (crawl.totalReported != null) totalReportedByApi = crawl.totalReported;
        const completed = stoppedReason === "completed";
        cursorReset = shouldResetCursor(crawl);
        // A dropped cursor restarts the pass: its scan counters restart with it.
        if (cursorReset) for (const key of PASS_COUNTER_KEYS) counters[key] = 0;
        cursorUpdate.last_profiles_cursor = completed || cursorReset ? null : crawl.lastCursor;
        completionUpdate.profiles_completed = completed;
        if (completed) passSnapshot.profiles_last_pass = { ...counters, completed_at: new Date().toISOString() };

        Object.assign(runStats, {
          profiles_pages_processed: crawl.pages,
          profiles_checkpoints: crawl.checkpoints,
          profiles_has_more_on_last_page: crawl.hasMoreOnLastPage,
          profiles_total_scanned_this_run: scannedThisRun,
          profiles_total_saved_this_run: savedThisRun,
          profiles_without_email_this_run: withoutEmailThisRun,
          preview_this_run: previewThisRun,
          profiles_skipped_no_profile_id_this_run: skippedThisRun,
        });
      } else if (stage === "sessions") {
        // --- Stage 2: crawl sessions, attach earliest-session attribution to stored profiles ---
        let scannedThisRun = 0;
        let withoutProfileId = 0;
        let matched = 0;
        let joined = 0;
        const attachSessions = async (rawRows: JsonRecord[]) => {
          const sessions = rawRows.map(parseSessionRow);
          scannedThisRun += sessions.length;
          withoutProfileId += sessions.filter((s) => !s.profile_id).length;
          const earliest = joinSessionsToProfiles(sessions);
          if (!earliest.size) return;
          const ids = [...earliest.keys()];
          const existing = new Map<string, StoredAttribution>();
          for (let i = 0; i < ids.length; i += LOOKUP_BATCH) {
            const { data, error } = await db
              .from("funnelfox_leads")
              .select("profile_id, session_created_at, funnel_id")
              .eq("auth_user_id", tenantKey)
              .in("profile_id", ids.slice(i, i + LOOKUP_BATCH));
            if (error) throw new Error(`sessions lookup failed: ${error.message}`);
            for (const r of (data ?? []) as Array<{ profile_id: string; session_created_at: string | null; funnel_id: string | null }>) {
              existing.set(r.profile_id, { session_created_at: r.session_created_at, funnel_id: r.funnel_id });
            }
          }
          const updates: JsonRecord[] = [];
          for (const [profileId, session] of earliest) {
            if (existing.has(profileId)) matched += 1;
            const row = sessionAttributionRow(profileId, session, existing.get(profileId), syncedAt);
            if (row) updates.push({ auth_user_id: tenantKey, ...row });
          }
          joined += updates.length;
          await upsertLeadRows(updates);
        };
        const crawl = await crawlList(fetchPage("/sessions"), {
          startCursor: resolveStartCursor(sessionsCursor, reset),
          maxPages,
          isExpired,
          flushEveryPages: FLUSH_EVERY_PAGES,
          onCheckpoint: async (rawRows, resumeCursor) => {
            await attachSessions(rawRows);
            await checkpointState({ last_sessions_cursor: resumeCursor, sessions_scanned_total: sessionsTotal + scannedThisRun });
          },
        });
        await attachSessions(crawl.rows);

        stoppedReason = crawl.stoppedReason;
        crawlError = crawl.errorMessage;
        retryAfterSeconds = crawl.retryAfterSeconds;
        madeProgress = crawl.pages > 0;
        sessionsTotal += scannedThisRun;
        const completed = stoppedReason === "completed";
        cursorReset = shouldResetCursor(crawl);
        if (cursorReset) sessionsTotal = 0;
        cursorUpdate.last_sessions_cursor = completed || cursorReset ? null : crawl.lastCursor;
        completionUpdate.sessions_completed = completed;

        Object.assign(runStats, {
          sessions_pages_processed: crawl.pages,
          sessions_checkpoints: crawl.checkpoints,
          sessions_has_more_on_last_page: crawl.hasMoreOnLastPage,
          sessions_total_scanned_this_run: scannedThisRun,
          sessions_matched_stored_profiles: matched,
          sessions_joined: joined,
          sessions_without_profile_id: withoutProfileId,
        });
      } else {
        // --- Stage 3: reconcile conversion server-side (queued; pg_cron applies it) --------------
        Object.assign(runStats, await runReconcileStage(db, tenantKey));
        stoppedReason = "completed";
        completionUpdate.reconcile_completed = true;
      }

      // ---- Stored population (whole tenant) ----------------------------------------------------
      const [{ count: savedTotal }, { count: withEmailTotal }] = await Promise.all([
        db.from("funnelfox_leads").select("*", { count: "exact", head: true }).eq("auth_user_id", tenantKey),
        db.from("funnelfox_leads").select("*", { count: "exact", head: true }).eq("auth_user_id", tenantKey).not("normalized_email", "is", null),
      ]);

      // ---- Merge + persist updated state -------------------------------------------------------
      const updatedFlags: StageCompletion = {
        profiles_completed: completionUpdate.profiles_completed ?? flags.profiles_completed,
        sessions_completed: completionUpdate.sessions_completed ?? flags.sessions_completed,
        reconcile_completed: completionUpdate.reconcile_completed ?? flags.reconcile_completed,
      };
      const remainingStage = nextIncompleteStage(updatedFlags);
      const allCompleted = remainingStage === null;
      const runStatus = statusFromStopReason(stoppedReason);
      const overallStatus = runStatus !== "ok" ? runStatus : allCompleted ? "ok" : "partial";
      const warning = computeCoverageWarning({ stoppedReason, stage });
      const nowMs = Date.now();
      const rateLimitedUntil =
        stoppedReason === "rate_limited"
          ? new Date(nowMs + (retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS) * 1000).toISOString()
          : null;
      // A FunnelFox error backs the cron off exponentially (the button and resets are not held back).
      const consecutiveApiErrors = stoppedReason === "api_error" ? priorApiErrors + 1 : 0;
      const errorBackoffUntil =
        consecutiveApiErrors > 0 ? new Date(nowMs + errorBackoffSeconds(consecutiveApiErrors) * 1000).toISOString() : null;
      if (crawlError && cursorReset) {
        crawlError = `${crawlError} The saved ${stage} cursor was dropped after ${consecutiveApiErrors} errors in a row; the next run restarts the pass.`;
      }

      const stats: JsonRecord = {
        ...priorStats,
        ...runStats,
        ...counters,
        ...passSnapshot,
        stage,
        next_stage: remainingStage,
        all_stages_completed: allCompleted,
        sync_stopped_reason: stoppedReason,
        rate_limited_until: rateLimitedUntil,
        consecutive_api_errors: consecutiveApiErrors,
        error_backoff_until: errorBackoffUntil,
        cursor_reset: cursorReset,
        profiles_total_saved: savedTotal ?? 0,
        emails_found: withEmailTotal ?? 0,
        sessions_scanned_total: sessionsTotal,
        profiles_total_reported_by_api: totalReportedByApi,
        profiles_coverage_percent: computeCoveragePercent(counters.profiles_scanned_total, totalReportedByApi),
        coverage_warning: warning.coverage_warning,
        coverage_warning_message: warning.coverage_warning_message,
        // The detail stage is gone; kept at 0 so older UI references resolve to "nothing pending".
        remaining_detail_unchecked: 0,
        profiles_pending_enrichment: 0,
        last_actor: ctx.actor.kind,
        duration_ms: Date.now() - startedAt,
        // Legacy aliases (kept so older UI references keep resolving).
        profiles_scanned: counters.profiles_scanned_total,
        sessions_scanned: sessionsTotal,
      };
      delete stats.checkpoint_at;

      const nowIso = new Date(nowMs).toISOString();
      const { error: stateError } = await db.from("funnelfox_leads_sync_state").upsert(
        {
          auth_user_id: tenantKey,
          ...(reset ? fullResetState() : {}),
          details_completed: true,
          ...cursorUpdate,
          ...completionUpdate,
          profiles_scanned_total: counters.profiles_scanned_total,
          sessions_scanned_total: sessionsTotal,
          profiles_total_reported_by_api: totalReportedByApi,
          current_stage: remainingStage ?? stage,
          last_status: overallStatus,
          last_error: stoppedReason === "api_error" || stoppedReason === "rate_limited" ? (crawlError ?? "FunnelFox API returned an error.") : null,
          last_full_sync_at: allCompleted ? nowIso : ((stateRow?.last_full_sync_at as string | null | undefined) ?? null),
          last_profiles_synced_at: stage === "profiles" ? nowIso : ((stateRow?.last_profiles_synced_at as string | null | undefined) ?? null),
          last_sessions_synced_at: stage === "sessions" ? nowIso : ((stateRow?.last_sessions_synced_at as string | null | undefined) ?? null),
          stats,
        },
        { onConflict: "auth_user_id" },
      );
      if (stateError) throw new Error(`sync state write failed: ${stateError.message}`);

      console.info("funnelfox-leads-sync", {
        actor: ctx.actor.kind,
        stage,
        reset,
        status: overallStatus,
        stopped_reason: stoppedReason,
        next_stage: remainingStage,
        profiles_saved: savedTotal ?? 0,
        emails_stored: withEmailTotal ?? 0,
      });

      return {
        status: overallStatus,
        dry_run: false,
        stage,
        next_stage: remainingStage,
        all_stages_completed: allCompleted,
        made_progress: madeProgress,
        stopped_reason: stoppedReason,
        rate_limited: stoppedReason === "rate_limited",
        rate_limited_until: rateLimitedUntil,
        error_backoff_until: errorBackoffUntil,
        coverage_warning: warning.coverage_warning,
        coverage_warning_message: warning.coverage_warning_message,
        summary: stats,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "sync failed";
      await db
        .from("funnelfox_leads_sync_state")
        .update({ last_status: "error", last_error: message })
        .eq("auth_user_id", tenantKey);
      return funnelFoxFailure(ctx, 502, { error: "FunnelFox leads sync failed.", detail: message });
    }
  };

  // ---- Decide before taking the lease (an idle or parked tick costs one read, no writes) -------
  let initialState: JsonRecord | null;
  try {
    initialState = await readState();
  } catch (error) {
    const message = error instanceof Error ? error.message : "sync state read failed";
    return funnelFoxFailure(ctx, 502, { error: "FunnelFox leads sync failed.", detail: message });
  }
  const firstPlan = planFor(initialState);
  if (firstPlan.kind !== "run") return quietResponse(firstPlan, initialState);

  // The RPC answers this call's lease token, or null while another call holds the lease.
  const { data: leaseToken, error: leaseError } = await db.rpc("funnelfox_leads_acquire_lease", { p_data_key: tenantKey, p_seconds: LEASE_SECONDS });
  if (leaseError) {
    return funnelFoxFailure(ctx, 502, { error: "FunnelFox leads sync failed.", detail: `lease unavailable: ${leaseError.message}` });
  }
  // Another call (the cron tick or the page's button) holds the lease: answer "busy", touch nothing.
  if (typeof leaseToken !== "string" || !leaseToken) return quietResponse(firstPlan, initialState);

  try {
    return await runLeased();
  } finally {
    // Best effort: an unreleased lease expires after LEASE_SECONDS. Only this call's token releases
    // it, so a call that outlived its lease never frees the next holder's.
    try {
      await db.rpc("funnelfox_leads_release_lease", { p_data_key: tenantKey, p_token: leaseToken });
    } catch {
      // ignore
    }
  }
}, { onError: funnelFoxErrorResponse });
