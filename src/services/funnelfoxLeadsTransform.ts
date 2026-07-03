import { normalizeEmail, extractProfileEmail } from "@/services/subscriptionTransform";
import { mediaBuyerFromUtmSource, normalizeUtmSource } from "@/services/userMediaBuyer";
import { normalizeCountryCode } from "@/services/userCountry";

/**
 * Pure (no I/O) parsing + attribution + conversion logic for FunnelFox lead sync.
 *
 * This is the canonical, unit-tested implementation. The `funnelfox-leads-sync` Edge Function mirrors
 * the same logic in Deno (it cannot import this module — `@/` aliases + browser deps don't resolve in
 * the Edge runtime), so keep the two in lockstep when changing either. Nothing here reads the network,
 * Supabase, or the transaction warehouse; conversion state is derived from a context the caller passes.
 */

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
  profile_id: string;
  created_at: string | null;
  updated_at: string | null;
  funnel_id: string | null;
  /** Email if the list row already carries it (skips the /profiles/{id} detail call). */
  email_from_list: string | null;
}

export interface ParsedSession {
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

export interface OriginAttribution {
  campaign_path: string | null;
  campaign_id: string | null;
  utm_source: string | null;
}

export interface LeadConversionContext {
  paidEmails: Set<string>;
  activeSubEmails: Set<string>;
  trialDatesByEmail: Map<string, string>;
  firstSubDatesByEmail: Map<string, string>;
}

export interface LeadConversionState {
  has_successful_payment: boolean;
  has_active_subscription: boolean;
  first_trial_at: string | null;
  first_sub_at: string | null;
  is_lead: boolean;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value);
}

function strOrNull(value: unknown): string | null {
  const s = str(value);
  return s || null;
}

/** A list-row email may live directly on `email` or inside a `preview` string/object. */
export function emailFromListRow(row: FunnelFoxProfileListRow): string | null {
  const direct = normalizeEmail(row.email);
  if (direct) return direct;

  const preview = row.preview;
  if (typeof preview === "string") {
    const match = preview.match(/[^\s"']+@[^\s"']+\.[^\s"']+/);
    if (match) return normalizeEmail(match[0]);
  }
  if (preview && typeof preview === "object") {
    const record = preview as Record<string, unknown>;
    return normalizeEmail(record.email) ?? normalizeEmail(record.contact_email);
  }
  return null;
}

export function parseProfileListRow(row: FunnelFoxProfileListRow): ParsedProfile {
  return {
    profile_id: str(row.profile_id ?? row.id),
    created_at: strOrNull(row.created_at),
    updated_at: strOrNull(row.updated_at),
    funnel_id: strOrNull(row.funnel_id),
    email_from_list: emailFromListRow(row),
  };
}

/** Email from a /profiles/{id} detail payload (reuses the proven subscription profile extractor). */
export function emailFromProfileDetail(detail: unknown): string | null {
  return extractProfileEmail(detail);
}

export function parseSessionRow(row: FunnelFoxSessionRow): ParsedSession {
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

/**
 * Conversion state for a lead, matched by normalized email against a context the caller computes
 * from the warehouse + FunnelFox subscriptions. A lead requires an email, no successful payment, and
 * no active subscription.
 */
export function deriveConversionState(
  normalizedEmail: string | null,
  context: LeadConversionContext,
): LeadConversionState {
  const hasEmail = Boolean(normalizedEmail);
  const paid = hasEmail && context.paidEmails.has(normalizedEmail as string);
  const active = hasEmail && context.activeSubEmails.has(normalizedEmail as string);
  return {
    has_successful_payment: paid,
    has_active_subscription: active,
    first_trial_at: hasEmail ? context.trialDatesByEmail.get(normalizedEmail as string) ?? null : null,
    first_sub_at: hasEmail ? context.firstSubDatesByEmail.get(normalizedEmail as string) ?? null : null,
    is_lead: hasEmail && !paid && !active,
  };
}

export interface FunnelFoxLeadUpsertRow {
  profile_id: string;
  email: string | null;
  normalized_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  session_id: string | null;
  session_created_at: string | null;
  funnel_id: string | null;
  funnel_version: string | null;
  funnel: string | null;
  campaign_path: string | null;
  campaign_id: string | null;
  utm_source: string | null;
  media_buyer: string | null;
  country_code: string | null;
  city: string | null;
  postal: string | null;
  user_agent: string | null;
  origin: string | null;
  has_successful_payment: boolean;
  has_active_subscription: boolean;
  is_lead: boolean;
  first_trial_at: string | null;
  first_sub_at: string | null;
}

/** Assemble the upsert row from a parsed profile, its (optional) earliest session, email + conversion. */
export function buildLeadUpsertRow(
  profile: ParsedProfile,
  session: ParsedSession | undefined,
  email: string | null,
  conversion: LeadConversionState,
): FunnelFoxLeadUpsertRow {
  const normalized = normalizeEmail(email);
  const attribution = parseOriginUrl(session?.origin ?? null);
  const utmSource = attribution.utm_source;
  return {
    profile_id: profile.profile_id,
    email: email ?? null,
    normalized_email: normalized,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    session_id: session?.session_id ?? null,
    session_created_at: session?.created_at ?? null,
    funnel_id: profile.funnel_id ?? session?.funnel_id ?? null,
    funnel_version: session?.funnel_version ?? null,
    funnel: profile.funnel_id ?? session?.funnel_id ?? null,
    campaign_path: attribution.campaign_path,
    campaign_id: attribution.campaign_id,
    utm_source: utmSource,
    media_buyer: utmSource ? mediaBuyerFromUtmSource(utmSource) : null,
    country_code: session?.country_code ?? null,
    city: session?.city ?? null,
    postal: session?.postal ?? null,
    user_agent: session?.user_agent ?? null,
    origin: session?.origin ?? null,
    has_successful_payment: conversion.has_successful_payment,
    has_active_subscription: conversion.has_active_subscription,
    is_lead: conversion.is_lead,
    first_trial_at: conversion.first_trial_at,
    first_sub_at: conversion.first_sub_at,
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
// Resumable, staged sync orchestration (pure — no I/O). Mirrored byte-for-byte in the
// `funnelfox-leads-sync` Edge Function, which cannot import this module. Keep the two in lockstep.
//
// The sync is split into resumable stages so a single Edge invocation (≈60s wall clock) never has to
// do everything at once. Each call runs ONE stage, persists its cursor + completion flag, and reports
// whether more work remains. Re-invoking continues from the saved cursor.
// ============================================================================================

export type SyncStage = "profiles" | "profile_details" | "sessions" | "reconcile";

export const SYNC_STAGES: SyncStage[] = ["profiles", "profile_details", "sessions", "reconcile"];

export type SyncStoppedReason =
  | "completed"
  | "soft_timeout"
  | "max_pages_reached"
  | "api_error"
  | "unknown";

export interface StageCompletion {
  profiles_completed: boolean;
  details_completed: boolean;
  sessions_completed: boolean;
  reconcile_completed: boolean;
}

/** The next stage that still has work, or null when the whole pipeline is complete. */
export function nextIncompleteStage(flags: StageCompletion): SyncStage | null {
  if (!flags.profiles_completed) return "profiles";
  if (!flags.details_completed) return "profile_details";
  if (!flags.sessions_completed) return "sessions";
  if (!flags.reconcile_completed) return "reconcile";
  return null;
}

/**
 * Classify why a paginated crawl stopped. Order matters: an API error or timeout is reported even if
 * the page also signalled `has_more`. Reaching `max_pages` while `has_more` is still true is the bug
 * Phase 2 fixes — it must surface as `max_pages_reached` (→ partial), never as `completed` (→ ok).
 */
export function determineStopReason(input: {
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

/** Map a stop reason to the run-level status. Only a clean `completed` is `ok`. */
export function statusFromStopReason(reason: SyncStoppedReason): "ok" | "partial" | "error" {
  switch (reason) {
    case "completed":
      return "ok";
    case "api_error":
      return "error";
    default:
      return "partial"; // soft_timeout, max_pages_reached, unknown
  }
}

/** Detail enrichment has no pagination cursor — it is "complete" only when nothing was timed-out-skipped. */
export function detailsStopReason(timeoutSkipped: number, apiError = false): SyncStoppedReason {
  if (apiError) return "api_error";
  return timeoutSkipped > 0 ? "soft_timeout" : "completed";
}

export type DetailOutcome = "email_checked" | "gone_checked" | "transient_unchecked";

/**
 * Decide what a /profiles/{id} fetch result means for the row's `detail_checked` marker. Only 404/410
 * are terminal "no email" (mark checked). Every other failure (5xx, 429, auth, network) is transient:
 * the row stays `detail_checked=false` so a later run retries it — this is what stops emails being lost.
 */
export function detailOutcome(ok: boolean, status: number): DetailOutcome {
  if (ok) return "email_checked";
  if (status === 404 || status === 410) return "gone_checked";
  return "transient_unchecked";
}

/**
 * profile_details is complete only when nothing was timed-out-skipped AND no candidate rows remain.
 * Transient failures leave rows unchecked, so the stage stays incomplete and Continue Sync resumes it
 * (it never advances to sessions/reconcile over un-enriched profiles).
 */
export function detailsStageComplete(timeoutSkipped: number, remainingUnchecked: number): boolean {
  return timeoutSkipped === 0 && remainingUnchecked === 0;
}

/** A row needs detail enrichment when it has no email and has not been checked yet. */
export function isDetailCandidate(row: { normalized_email: string | null; detail_checked: boolean | null }): boolean {
  return !row.normalized_email && !row.detail_checked;
}

export function selectDetailCandidates<T extends { normalized_email: string | null; detail_checked: boolean | null }>(
  rows: T[],
): T[] {
  return rows.filter(isDetailCandidate);
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

/** Cursor + completion state to persist when a full reset is requested. Rows are NOT deleted. */
export function fullResetState(): StageCompletion & {
  last_profiles_cursor: null;
  last_sessions_cursor: null;
  current_stage: SyncStage;
} {
  return {
    last_profiles_cursor: null,
    last_sessions_cursor: null,
    profiles_completed: false,
    details_completed: false,
    sessions_completed: false,
    reconcile_completed: false,
    current_stage: "profiles",
  };
}

export interface CrawlPageResult {
  ok: boolean;
  rows: Record<string, unknown>[];
  hasMore: boolean;
  nextCursor: string | null;
  totalReported?: number | null;
}

export interface CrawlOutcome {
  rows: Record<string, unknown>[];
  pages: number;
  lastCursor: string | null;
  hasMoreOnLastPage: boolean;
  stoppedReason: SyncStoppedReason;
  totalReported: number | null;
}

/**
 * Paginate a FunnelFox listing endpoint via injected `fetchPage`. Pure w.r.t. I/O — the caller decides
 * how a page is fetched and when time is up (`isExpired`). Stops on: max_pages, soft timeout, API
 * error, or `has_more=false`. Reports `hasMoreOnLastPage` so the caller can detect a truncated crawl.
 */
export async function crawlList(
  fetchPage: (cursor: string | undefined) => Promise<CrawlPageResult>,
  opts: { startCursor?: string; maxPages: number; isExpired: () => boolean },
): Promise<CrawlOutcome> {
  const rows: Record<string, unknown>[] = [];
  let cursor = opts.startCursor;
  let pages = 0;
  let lastCursor: string | null = opts.startCursor ?? null;
  let hasMoreOnLastPage = false;
  let apiError = false;
  let timedOut = false;
  let totalReported: number | null = null;

  while (pages < opts.maxPages) {
    if (opts.isExpired()) {
      timedOut = true;
      break;
    }
    const page = await fetchPage(cursor);
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
    stoppedReason: determineStopReason({ pages, maxPages: opts.maxPages, hasMoreOnLastPage, timedOut, apiError }),
    totalReported,
  };
}

export interface DetailEnrichResult<T> {
  item: T;
  email: string | null;
  raw: unknown;
  ok: boolean;
}

export interface DetailEnrichOutcome<T> {
  results: DetailEnrichResult<T>[];
  attempted: number;
  fetched: number;
  failed: number;
  timeoutSkipped: number;
}

/**
 * Resolve emails for profiles missing one, with a bounded worker pool. `preResolve` lets a caller
 * supply a no-network email (e.g. from the list-row preview) before paying for a `/profiles/{id}`
 * fetch. Stops cleanly when `isExpired()` flips — un-processed candidates are reported as
 * `timeoutSkipped` so the next run can resume them.
 */
export async function enrichDetails<T>(
  candidates: T[],
  opts: {
    fetchDetail: (item: T) => Promise<{ ok: boolean; email: string | null; raw: unknown }>;
    isExpired: () => boolean;
    concurrency: number;
    preResolve?: (item: T) => string | null;
  },
): Promise<DetailEnrichOutcome<T>> {
  const results: DetailEnrichResult<T>[] = [];
  let attempted = 0;
  let fetched = 0;
  let failed = 0;
  let index = 0;

  async function worker() {
    while (index < candidates.length) {
      if (opts.isExpired()) return;
      const item = candidates[index];
      index += 1;
      const preEmail = opts.preResolve?.(item) ?? null;
      if (preEmail) {
        attempted += 1;
        fetched += 1;
        results.push({ item, email: preEmail, raw: null, ok: true });
        continue;
      }
      attempted += 1;
      try {
        const detail = await opts.fetchDetail(item);
        if (detail.ok) {
          fetched += 1;
          results.push({ item, email: detail.email, raw: detail.raw, ok: true });
        } else {
          failed += 1;
          results.push({ item, email: null, raw: detail.raw, ok: false });
        }
      } catch {
        failed += 1;
        results.push({ item, email: null, raw: null, ok: false });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency, candidates.length)) }, () => worker()));
  const timeoutSkipped = candidates.length - attempted;
  return { results, attempted, fetched, failed, timeoutSkipped };
}

/** Drop profile rows with no usable id (cannot be deduped / upserted) and count them. */
export function partitionByProfileId(parsed: ParsedProfile[]): { kept: ParsedProfile[]; skipped_no_profile_id: number } {
  const kept = parsed.filter((p) => p.profile_id);
  return { kept, skipped_no_profile_id: parsed.length - kept.length };
}

/** Email coverage over the saved population (a profile "without email" is one whose enrichment found none). */
export function countEmailCoverage(rows: Array<{ normalized_email: string | null }>): {
  profiles_with_email: number;
  profiles_without_email: number;
} {
  let withEmail = 0;
  for (const row of rows) if (row.normalized_email) withEmail += 1;
  return { profiles_with_email: withEmail, profiles_without_email: rows.length - withEmail };
}

/** % of FunnelFox profiles imported, when the API reports a grand total. Null when the total is unknown. */
export function computeCoveragePercent(scannedTotal: number, totalReported: number | null): number | null {
  if (!totalReported || totalReported <= 0) return null;
  return Math.min(100, Math.round((scannedTotal / totalReported) * 10000) / 100);
}

/** Human-readable coverage warning for the Leads UI, derived from how/where the run stopped. */
export function computeCoverageWarning(input: {
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

/** Look for a grand-total in a pagination object (cursor APIs usually omit it → null). */
export function readReportedTotal(pagination: Record<string, unknown>): number | null {
  for (const key of ["total", "total_count", "totalCount", "count"]) {
    const value = pagination[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}
