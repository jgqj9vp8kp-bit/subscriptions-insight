import { normalizeEmail, normalizeProfileId } from "@/services/subscriptionTransform";
import { mediaBuyerFromUtmSource, normalizeUtmSource } from "@/services/userMediaBuyer";
import { normalizeCountryCode } from "@/services/userCountry";

/**
 * Pure (no I/O) parsing + attribution + orchestration logic for the FunnelFox Leads sync.
 *
 * This is the canonical, unit-tested implementation. The `funnelfox-leads-sync` Edge Function mirrors
 * the same logic in Deno (it cannot import this module — `@/` aliases + browser deps don't resolve in
 * the Edge runtime), so keep the two in lockstep when changing either. Nothing here reads the network,
 * Supabase, or the transaction warehouse.
 *
 * Where the emails are (live probe 2026-10-06, key names / counts only): a FunnelFox profile LIST row
 * is { id, created_at, funnel_id, preview, email? } — about a quarter of the rows carry `email` at the
 * root and nothing else in the row does; the /profiles/{id} detail payload carries no email at all.
 * So the sync stores ONLY list rows that carry an email (light columns + the `preview` flag), counts
 * the rest, and never calls /profiles/{id}. Conversion (paid / active subscription) is decided by the
 * SQL function public.funnelfox_leads_reconcile, not by a browser-computed context.
 */

/** Profile rows + cursor are checkpointed every this many list pages (a killed call loses at most that). */
export const FLUSH_EVERY_PAGES = 10;
/** Backoff when a FunnelFox 429 carries no (usable) Retry-After. */
export const DEFAULT_RETRY_AFTER_SECONDS = 60;
export const MAX_RETRY_AFTER_SECONDS = 3600;
/** After a FunnelFox error the cron backs off exponentially: 60s · 2^(N-1), at most an hour. */
export const ERROR_BACKOFF_BASE_SECONDS = 60;
export const ERROR_BACKOFF_MAX_SECONDS = 3600;
/** This many errors in a row on a cursor FunnelFox refuses drop that stage's cursor (the pass restarts). */
export const CURSOR_RESET_AFTER_ERRORS = 3;
/** HTTP statuses that mean "this cursor is not valid" (not auth, not throttling, not a server fault). */
export const CURSOR_REJECTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 410, 422]);
/** funnelfox_leads.email_source for an email read from the profile list row. */
export const EMAIL_SOURCE_LIST = "list";

export { normalizeProfileId };

export interface FunnelFoxProfileListRow {
  id?: string;
  profile_id?: string;
  created_at?: string;
  updated_at?: string;
  funnel_id?: string;
  preview?: unknown;
  email?: string;
  [key: string]: unknown;
}

export interface FunnelFoxSessionRow {
  id?: string;
  session_id?: string;
  profile_id?: string;
  country?: string;
  user_agent?: string;
  funnel_id?: string;
  funnel_version?: string;
  origin?: string;
  created_at?: string;
  city?: string;
  postal?: string;
  [key: string]: unknown;
}

export interface ParsedProfile {
  /** Bare id (a `pro_` prefix is stripped, like funnelfox_subscriptions.profile_id). */
  profile_id: string;
  /** created_at from the row, else the ULID timestamp of the id. */
  created_at: string | null;
  updated_at: string | null;
  funnel_id: string | null;
  /** Trimmed list-row email as FunnelFox sent it; null when the row carries none. */
  email: string | null;
  normalized_email: string | null;
  /** FunnelFox `preview` flag (editor / preview runs): stored, excluded from leads by the read RPC. */
  preview: boolean;
}

export interface ParsedSession {
  session_id: string;
  /** Bare id, joinable with funnelfox_leads.profile_id. */
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

export interface OriginAttribution {
  campaign_path: string | null;
  campaign_id: string | null;
  utm_source: string | null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  const s = str(value);
  return s || null;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Loose email shape check (the stored value must at least look like an address). */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// ---- request parameters ----------------------------------------------------------------------

/**
 * An integer request parameter. An ABSENT value (undefined / null / "") must use the fallback — NOT
 * collapse to Number(null) === 0, which is finite and clamped up to `min` (1). That bug made every
 * call that omitted limit / max_pages crawl one page of one profile (same fix as the subscriptions sync).
 */
export function resolveIntParam(value: unknown, fallback: number, min: number, max: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
}

// ---- pagination ------------------------------------------------------------------------------

export type CursorKey = "cursor" | "next_cursor";

/**
 * Next-page cursor of a FunnelFox list page. FunnelFox paginates with `{ cursor, has_more }`
 * (verified on /funnels and /subscriptions); `next_cursor` is accepted too. A candidate equal to the
 * cursor the page was requested with is skipped (it would re-read the same page forever); when that
 * leaves nothing, `stuck` is true.
 */
export function readNextCursor(
  pagination: Record<string, unknown>,
  requestCursor?: string | null,
): { cursor: string | null; key: CursorKey | null; stuck: boolean } {
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

/** Look for a grand-total in a pagination object (cursor APIs usually omit it → null). */
export function readReportedTotal(pagination: Record<string, unknown>): number | null {
  for (const key of ["total", "total_count", "totalCount", "count"]) {
    const value = pagination[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

// ---- ids + timestamps ------------------------------------------------------------------------

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_MIN_MS = Date.UTC(2015, 0, 1);
const ULID_MAX_MS = Date.UTC(2100, 0, 1);

/** Millisecond timestamp encoded in a ULID-shaped id (prefix stripped), or null when it is not one. */
export function ulidTimestampMs(id: unknown): number | null {
  const bare = normalizeProfileId(id).toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(bare)) return null;
  let ms = 0;
  for (let i = 0; i < 10; i += 1) ms = ms * 32 + CROCKFORD_BASE32.indexOf(bare[i]);
  return ms >= ULID_MIN_MS && ms <= ULID_MAX_MS ? ms : null;
}

export function ulidIso(id: unknown): string | null {
  const ms = ulidTimestampMs(id);
  return ms == null ? null : new Date(ms).toISOString();
}

// ---- profile list rows -----------------------------------------------------------------------

/** The list-row email (trimmed original + normalized). Root `email` first; a `preview` string/object as a fallback. */
export function listRowEmail(row: FunnelFoxProfileListRow): { email: string; normalized_email: string } | null {
  const candidates: unknown[] = [row.email];
  const preview = row.preview;
  if (typeof preview === "string") candidates.push(preview.match(/[^\s"']+@[^\s"']+\.[^\s"']+/)?.[0]);
  if (preview && typeof preview === "object") {
    const record = preview as Record<string, unknown>;
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

/** Normalized list-row email, or null. */
export function emailFromListRow(row: FunnelFoxProfileListRow): string | null {
  return listRowEmail(row)?.normalized_email ?? null;
}

export function parseProfileListRow(row: FunnelFoxProfileListRow): ParsedProfile {
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

export interface ProfileScan {
  /** Deduped profiles that carry an email — the only ones stored. */
  store: ParsedProfile[];
  /** Rows with a usable id, after de-duplication. */
  scanned: number;
  with_email: number;
  without_email: number;
  /** preview=true among the scanned rows (excluded from leads). */
  preview: number;
  preview_with_email: number;
  skipped_no_profile_id: number;
  duplicates: number;
}

/**
 * Classify one batch of list rows: keep the first row per profile id (a second one in the same upsert
 * statement would fail ON CONFLICT), store only those with an email, count everything.
 */
export function scanProfileRows(rows: FunnelFoxProfileListRow[]): ProfileScan {
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

/**
 * The columns the profile list owns (light row, no raw payload). Conversion columns (is_lead,
 * has_successful_payment, …) are NOT written — reconcile owns them — and funnel_id is written only when
 * the row carries one, so a null never overwrites a stored value.
 */
export function profileUpsertRow(profile: ParsedProfile, syncedAt: string): Record<string, unknown> {
  const row: Record<string, unknown> = {
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

/**
 * Split rows into batches whose rows share one key set. supabase-js fills a key missing from some
 * rows of a bulk upsert with NULL, which would overwrite stored values (DEVELOPER_NOTES incident).
 */
export function groupRowsByKeySet<T extends Record<string, unknown>>(rows: T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const signature = Object.keys(row).sort().join(",");
    const group = groups.get(signature);
    if (group) group.push(row);
    else groups.set(signature, [row]);
  }
  return [...groups.values()];
}

// ---- pass counters (sync_state.stats) --------------------------------------------------------

/** Scan counters of the current profile pass; zeroed by a full reset. */
export const PASS_COUNTER_KEYS = [
  "profiles_scanned_total",
  "profiles_with_email",
  "profiles_without_email",
  "preview_excluded",
  "preview_with_email",
  "profiles_skipped_no_profile_id",
  "profiles_duplicates_skipped",
] as const;

export type PassCounters = Record<(typeof PASS_COUNTER_KEYS)[number], number>;

export function readPassCounters(stats: Record<string, unknown> | null | undefined, reset: boolean): PassCounters {
  const counters = {} as PassCounters;
  for (const key of PASS_COUNTER_KEYS) {
    const value = Number(readRecord(stats)[key] ?? 0);
    counters[key] = reset || !Number.isFinite(value) ? 0 : value;
  }
  return counters;
}

export function addProfileScan(counters: PassCounters, scan: ProfileScan): void {
  counters.profiles_scanned_total += scan.scanned;
  counters.profiles_with_email += scan.with_email;
  counters.profiles_without_email += scan.without_email;
  counters.preview_excluded += scan.preview;
  counters.preview_with_email += scan.preview_with_email;
  counters.profiles_skipped_no_profile_id += scan.skipped_no_profile_id;
  counters.profiles_duplicates_skipped += scan.duplicates;
}

// ---- sessions + attribution ------------------------------------------------------------------

export function parseSessionRow(row: FunnelFoxSessionRow): ParsedSession {
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

/**
 * Pick the earliest (first-touch) session per profile_id for attribution. Returns a Map keyed by
 * profile_id. Sessions with no profile_id are dropped (cannot be joined to a lead).
 */
export function joinSessionsToProfiles(sessions: ParsedSession[]): Map<string, ParsedSession> {
  const byProfile = new Map<string, ParsedSession>();
  for (const session of sessions) {
    if (!session.profile_id) continue;
    const current = byProfile.get(session.profile_id);
    if (!current || dateMs(session.created_at) < dateMs(current.created_at)) {
      byProfile.set(session.profile_id, session);
    }
  }
  return byProfile;
}

/**
 * Best-effort attribution from a session origin URL. FunnelFox origins are landing URLs; campaign
 * data lives in UTM-style query params. Tolerant of bare query strings and missing fields.
 */
export function parseOriginUrl(origin: string | null): OriginAttribution {
  if (!origin) return { campaign_path: null, campaign_id: null, utm_source: null };

  let params: URLSearchParams | null = null;
  let pathname = "";
  try {
    const url = new URL(origin);
    params = url.searchParams;
    pathname = url.pathname;
  } catch {
    const queryIndex = origin.indexOf("?");
    params = new URLSearchParams(queryIndex >= 0 ? origin.slice(queryIndex + 1) : origin);
  }

  const get = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = params?.get(key);
      if (value && value.trim()) return value.trim();
    }
    return null;
  };

  const firstPathSegment = pathname.split("/").filter(Boolean)[0] ?? null;

  return {
    campaign_path: get("utm_campaign", "campaign_path", "campaign") ?? firstPathSegment,
    campaign_id: get("campaign_id", "utm_content", "utm_term", "adset_id", "ad_id"),
    utm_source: normalizeUtmSource(get("utm_source", "source")),
  };
}

export { mediaBuyerFromUtmSource };

/** What the sessions stage reads back for a stored profile before attaching a session. */
export interface StoredAttribution {
  session_created_at: string | null;
  funnel_id: string | null;
}

/**
 * Attribution update for one stored profile from its earliest session in this batch, or null when
 * nothing should be written: the profile is not stored (it has no email) or the stored session is
 * already as early. Light columns only (no raw_session); the stored funnel_id wins over the session's.
 */
export function sessionAttributionRow(
  profileId: string,
  session: ParsedSession,
  existing: StoredAttribution | undefined,
  syncedAt: string,
): Record<string, unknown> | null {
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

/**
 * Data-source priority for the Leads page: prefer synced FunnelFox leads, fall back to the
 * warehouse-derived leads only when no FunnelFox leads exist. Pure + exported for tests.
 */
export function selectLeadsSource<F, W>(
  funnelfoxLeads: F[],
  warehouseLeads: W[],
): { source: "funnelfox" | "warehouse"; funnelfox: F[]; warehouse: W[] } {
  return funnelfoxLeads.length > 0
    ? { source: "funnelfox", funnelfox: funnelfoxLeads, warehouse: [] }
    : { source: "warehouse", funnelfox: [], warehouse: warehouseLeads };
}

/** Mask an email for logs: jo***@example.com. Never log raw emails in production. */
export function maskEmail(value: string | null | undefined): string | null {
  if (!value || !value.includes("@")) return value ? "***" : null;
  const [local, domain] = value.split("@");
  return `${local.slice(0, 2)}***@${domain}`;
}

// ============================================================================================
// Resumable, staged sync orchestration (pure — no I/O). Mirrored in the `funnelfox-leads-sync`
// Edge Function, which cannot import this module. Keep the two in lockstep.
//
// Each call runs ONE stage, persists its cursor + completion flag, and reports whether more work
// remains. Re-invoking (the minute cron tick or the page's Continue) continues from the saved cursor.
// ============================================================================================

export type SyncStage = "profiles" | "sessions" | "reconcile";

/** The old `profile_details` stage is gone: the detail endpoint carries no email. */
export const SYNC_STAGES: SyncStage[] = ["profiles", "sessions", "reconcile"];

export function parseSyncStage(value: unknown): SyncStage | null {
  const stage = str(value).toLowerCase();
  return stage === "profiles" || stage === "sessions" || stage === "reconcile" ? stage : null;
}

export type SyncStoppedReason =
  | "completed"
  | "soft_timeout"
  | "max_pages_reached"
  | "rate_limited"
  | "api_error"
  | "unknown";

export interface StageCompletion {
  profiles_completed: boolean;
  sessions_completed: boolean;
  reconcile_completed: boolean;
}

/** The next stage that still has work, or null when the whole pipeline is complete. */
export function nextIncompleteStage(flags: StageCompletion): SyncStage | null {
  if (!flags.profiles_completed) return "profiles";
  if (!flags.sessions_completed) return "sessions";
  if (!flags.reconcile_completed) return "reconcile";
  return null;
}

/**
 * Classify why a paginated crawl stopped. Order matters: an API error, a 429 or a timeout is reported
 * even if the page also signalled `has_more`. Reaching `max_pages` while `has_more` is still true must
 * surface as `max_pages_reached` (→ partial), never as `completed` (→ ok).
 */
export function determineStopReason(input: {
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

/** Map a stop reason to the run-level status. Only a clean `completed` is `ok`. */
export function statusFromStopReason(reason: SyncStoppedReason): "ok" | "partial" | "error" {
  switch (reason) {
    case "completed":
      return "ok";
    case "api_error":
      return "error";
    default:
      return "partial"; // soft_timeout, max_pages_reached, rate_limited, unknown
  }
}

/** Driver decision: keep running stages until the pipeline completes, errors, or stalls (no progress). */
export function shouldContinueSync(response: {
  status?: string;
  all_stages_completed?: boolean;
  made_progress?: boolean;
}): boolean {
  if (response.status === "error") return false;
  if (response.all_stages_completed) return false;
  if (response.made_progress === false) return false;
  return true;
}

/** A normal sync resumes from the saved cursor; a full reset always restarts from the beginning. */
export function resolveStartCursor(savedCursor: string | null | undefined, fullReset: boolean): string | undefined {
  if (fullReset) return undefined;
  return savedCursor ?? undefined;
}

/**
 * Sync-state columns a full reset writes BEFORE it crawls (all stage flags false, both cursors null,
 * scan totals zeroed). Rows are NOT deleted. `details_completed` stays true: that stage no longer exists.
 */
export function fullResetState() {
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

/**
 * Seconds to back off after a FunnelFox 429: the Retry-After header (delta seconds or HTTP date),
 * clamped to [1, MAX_RETRY_AFTER_SECONDS]; DEFAULT_RETRY_AFTER_SECONDS when absent or unusable.
 */
export function parseRetryAfterSeconds(value: string | null | undefined, nowMs: number): number {
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

function readIsoMs(stats: Record<string, unknown> | null | undefined, key: string): number | null {
  const raw = readRecord(stats)[key];
  if (typeof raw !== "string" || !raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** stats.rate_limited_until as epoch ms, or null. */
export function readRateLimitedUntilMs(stats: Record<string, unknown> | null | undefined): number | null {
  return readIsoMs(stats, "rate_limited_until");
}

/** stats.error_backoff_until (the cron's backoff after FunnelFox errors) as epoch ms, or null. */
export function readErrorBackoffUntilMs(stats: Record<string, unknown> | null | undefined): number | null {
  return readIsoMs(stats, "error_backoff_until");
}

/** Backoff after the Nth consecutive FunnelFox error (N >= 1): 60s · 2^(N-1), at most an hour. */
export function errorBackoffSeconds(consecutiveErrors: number): number {
  const n = Math.max(1, Math.floor(Number.isFinite(consecutiveErrors) ? consecutiveErrors : 1));
  return Math.min(ERROR_BACKOFF_MAX_SECONDS, ERROR_BACKOFF_BASE_SECONDS * 2 ** Math.min(n - 1, 16));
}

export type RunPlan =
  | { kind: "idle" }
  | { kind: "rate_limited"; until: string; stage: SyncStage | null }
  | { kind: "error_backoff"; until: string; stage: SyncStage | null }
  | { kind: "run"; stage: SyncStage; reset: boolean };

/**
 * What one invocation does, from the persisted state:
 *  - idle: every stage complete, no stage requested, no (effective) reset → a no-op with no writes;
 *  - rate_limited: a FunnelFox 429 backoff is still running → return at once;
 *  - error_backoff: (cron only) the backoff after FunnelFox errors is still running → return at once;
 *  - run: the requested stage, the reset's first stage, or the next incomplete one.
 * A CRON full_reset that arrives while the pipeline is unfinished is a plain advance, so the daily
 * refresh never restarts a healthy running backfill — unless the last run ended in an error (a
 * persistent upstream error on the saved cursor must not stall the pipeline for good). A user's full
 * reset always restarts; a user click is never held back by the error backoff.
 */
export function planRun(input: {
  flags: StageCompletion;
  requestedStage: SyncStage | null;
  fullReset: boolean;
  cron: boolean;
  rateLimitedUntilMs: number | null;
  nowMs: number;
  /** funnelfox_leads_sync_state.last_status. */
  lastStatus?: string | null;
  /** stats.error_backoff_until as epoch ms. */
  errorBackoffUntilMs?: number | null;
}): RunPlan {
  const next = nextIncompleteStage(input.flags);
  const reset = input.fullReset && !(input.cron && next !== null && input.lastStatus !== "error");
  if (!reset && !input.requestedStage && next === null) return { kind: "idle" };
  if (input.rateLimitedUntilMs != null && input.rateLimitedUntilMs > input.nowMs) {
    return { kind: "rate_limited", until: new Date(input.rateLimitedUntilMs).toISOString(), stage: input.requestedStage ?? next };
  }
  if (input.cron && !reset && input.errorBackoffUntilMs != null && input.errorBackoffUntilMs > input.nowMs) {
    return { kind: "error_backoff", until: new Date(input.errorBackoffUntilMs).toISOString(), stage: input.requestedStage ?? next };
  }
  if (reset) return { kind: "run", stage: input.requestedStage ?? "profiles", reset: true };
  return { kind: "run", stage: (input.requestedStage ?? next) as SyncStage, reset: false };
}

export interface CrawlPageResult {
  ok: boolean;
  /** HTTP status (429 → rate_limited; any other failure → api_error). */
  status?: number;
  rows: Record<string, unknown>[];
  hasMore: boolean;
  nextCursor: string | null;
  cursorKey?: CursorKey | null;
  /** has_more, but the only cursor offered is the one this page was requested with. */
  cursorStuck?: boolean;
  totalReported?: number | null;
  retryAfterSeconds?: number | null;
  errorMessage?: string | null;
  paginationKeys?: string[];
  rateLimitHeaders?: string[];
}

export interface CrawlOutcome {
  /** Rows not yet handed to onCheckpoint (all rows when there is no checkpoint callback). */
  rows: Record<string, unknown>[];
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
   * that did not advance): retrying that cursor cannot succeed. */
  cursorRejected: boolean;
}

/**
 * Paginate a FunnelFox listing endpoint via injected `fetchPage`. Pure w.r.t. I/O — the caller decides
 * how a page is fetched and when time is up (`isExpired`). Stops on: max_pages, soft timeout, API
 * error, 429, or `has_more=false`. `has_more` without a usable next cursor (the same cursor again, or
 * none under a recognised key) is an api_error — never a silent `completed`. Every `flushEveryPages`
 * pages (when more pages follow) the rows so far are handed to `onCheckpoint` together with the cursor
 * to resume from, so the caller can persist rows + cursor and a killed call loses at most that many.
 */
export async function crawlList(
  fetchPage: (cursor: string | undefined) => Promise<CrawlPageResult>,
  opts: {
    startCursor?: string;
    maxPages: number;
    isExpired: () => boolean;
    flushEveryPages?: number;
    onCheckpoint?: (rows: Record<string, unknown>[], resumeCursor: string) => Promise<void>;
  },
): Promise<CrawlOutcome> {
  let rows: Record<string, unknown>[] = [];
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
      // Fail closed: re-requesting the same cursor would loop on one page, and a cursor under a key
      // this sync does not read would otherwise end the pass as "completed" after this page. The
      // page's rows are kept; the saved cursor stays on this page.
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

/** % of FunnelFox profiles scanned in this pass, when the API reports a grand total. Null when unknown. */
export function computeCoveragePercent(scannedTotal: number, totalReported: number | null): number | null {
  if (!totalReported || totalReported <= 0) return null;
  return Math.min(100, Math.round((scannedTotal / totalReported) * 10000) / 100);
}

/** Human-readable coverage warning for the Leads UI, derived from how/where the run stopped. */
export function computeCoverageWarning(input: {
  stoppedReason: SyncStoppedReason;
  stage: SyncStage;
}): { coverage_warning: boolean; coverage_warning_message: string } {
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

// ---- diagnose (dry_run): key names and counts only, never values -----------------------------

/** Response header NAMES that look rate-limit related (values are never reported). */
export function rateLimitHeaderNames(headers: { forEach(callback: (value: string, key: string) => void): void } | null | undefined): string[] {
  const names: string[] = [];
  if (!headers || typeof headers.forEach !== "function") return names;
  headers.forEach((_value, key) => {
    const name = key.toLowerCase();
    if (/rate|retry|limit/.test(name) && !names.includes(name)) names.push(name);
  });
  return names.sort();
}

export type ListOrder = "newest_first" | "oldest_first" | "mixed" | "unknown";

/** A row's timestamp: created_at, else the ULID time of its id. */
export function rowTimestampMs(row: Record<string, unknown>): number | null {
  const created = Date.parse(str(row.created_at));
  if (Number.isFinite(created)) return created;
  return ulidTimestampMs(row.id ?? row.profile_id);
}

/** Order of a listing page, judged from consecutive row timestamps. */
export function detectListOrder(rows: Record<string, unknown>[]): ListOrder {
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

/** How often each top-level key occurs (key names only). */
export function keyCounts(rows: Record<string, unknown>[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) for (const key of Object.keys(row)) counts[key] = (counts[key] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/** Count id forms: `pro_`-prefixed, bare, missing, and ULID-shaped. */
export function idForms(ids: unknown[]): { pro_prefixed: number; bare: number; missing: number; ulid: number } {
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

/** Dot-paths (arrays as `[]`) of string values that look like an email — PATH NAMES only, never values. */
export function collectEmailPaths(value: unknown, prefix = "", depth = 5, out: string[] = []): string[] {
  if (value == null || depth < 0 || out.length >= 12) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectEmailPaths(item, `${prefix}[]`, depth - 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
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

/** PII-free summary of a profile-list sample. */
export function summarizeProfileSample(rows: FunnelFoxProfileListRow[]) {
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

/** PII-free summary of a sessions sample; `profileIds` = bare ids of the profile sample (join check). */
export function summarizeSessionSample(rows: FunnelFoxSessionRow[], profileIds: Set<string>) {
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
