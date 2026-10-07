import { supabase } from "@/services/supabaseClient";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { shouldContinueSync } from "@/services/funnelfoxLeadsTransform";

/**
 * Frontend bridge for the `funnelfox-leads-sync` Edge Function + its sync state.
 *
 * The Edge Function crawls FunnelFox server-side (profile list → sessions) and has conversion
 * reconciled server-side (SQL funnelfox_leads_reconcile over public.transactions + the
 * active-subscription RPC; the stage queues it and the pg_cron job funnelfox-leads-reconcile applies
 * it within a minute), so the browser sends nothing but flags and page sizes — no warehouse data, no
 * conversion context.
 * The pipeline also advances on its own: a pg_cron tick runs every minute (and a full refresh once a
 * day), so the Leads tab's Continue button only speeds things up. The lead list itself is read
 * through clickhouse-users (runClickHouseLeads / useLeadsData), never from these tables.
 */

/** Explicit page size + page budget for every user-triggered call. An omitted value used to collapse
 * to 1 profile per call on the server (Number(null) === 0, clamped up to 1). */
export const LEADS_SYNC_LIMIT = 100;
export const LEADS_SYNC_MAX_PAGES = 200;
/** The Diagnose dry run probes at most two list pages. */
export const LEADS_DIAGNOSE_MAX_PAGES = 2;
/** Cap of one Continue / Full Resync click; the minute cron carries on afterwards. */
export const MANUAL_SYNC_MAX_STEPS = 10;
/** How often the sync card re-reads the state while a sync is partial or running. */
export const LEADS_SYNC_POLL_MS = 30_000;

export type SyncStage = "profiles" | "sessions" | "reconcile";
export type SyncStoppedReason = "completed" | "soft_timeout" | "max_pages_reached" | "rate_limited" | "api_error" | "unknown";

/**
 * Diagnostics written to `funnelfox_leads_sync_state.stats` by each staged run. Fields accumulate
 * across stages, so a fully-synced account has the complete picture. All optional — a given run only
 * populates the fields for the stage it executed plus the cross-cutting coverage counts.
 */
export interface FunnelFoxLeadsSyncSummary {
  stage?: SyncStage | string;
  next_stage?: SyncStage | string | null;
  all_stages_completed?: boolean;
  sync_stopped_reason?: SyncStoppedReason | string;
  /** Set while FunnelFox throttles the crawl (HTTP 429 + Retry-After); every call waits until then. */
  rate_limited_until?: string | null;
  /** FunnelFox errors in a row (0 after any run that did not fail). */
  consecutive_api_errors?: number;
  /** After a FunnelFox error the background tick waits until then (exponential, at most an hour). */
  error_backoff_until?: string | null;
  /** The last run dropped a cursor FunnelFox kept refusing; the pass restarts from the newest page. */
  cursor_reset?: boolean;
  last_actor?: string;

  // profiles stage (scan counters of the current pass; only profiles with an email are stored)
  profiles_pages_processed?: number;
  profiles_checkpoints?: number;
  profiles_has_more_on_last_page?: boolean;
  profiles_total_scanned_this_run?: number;
  profiles_total_saved_this_run?: number;
  profiles_without_email_this_run?: number;
  preview_this_run?: number;
  profiles_scanned_total?: number;
  profiles_with_email?: number;
  profiles_without_email?: number;
  /** FunnelFox editor / preview runs: never a lead. */
  preview_excluded?: number;
  preview_with_email?: number;
  profiles_skipped_no_profile_id?: number;
  profiles_duplicates_skipped?: number;

  // sessions stage
  sessions_pages_processed?: number;
  sessions_checkpoints?: number;
  sessions_has_more_on_last_page?: boolean;
  sessions_total_scanned_this_run?: number;
  sessions_matched_stored_profiles?: number;
  sessions_joined?: number;
  sessions_without_profile_id?: number;

  // reconcile stage: the stage queues the reconcile (pg_cron applies it within a minute); the counts
  // are those of the last APPLIED run, as of the stage's call (the row's reconcile_summary is newer).
  reconcile_rows?: number;
  leads_found?: number;
  converted_excluded?: number;
  active_sub_excluded?: number;
  reconciled_at?: string;
  /** When the reconcile stage last queued a reconcile. */
  reconcile_queued_at?: string;

  // cross-cutting coverage
  profiles_total_saved?: number;
  emails_found?: number;
  sessions_scanned_total?: number;
  profiles_total_reported_by_api?: number | null;
  profiles_coverage_percent?: number | null;
  coverage_warning?: boolean;
  coverage_warning_message?: string;
  duration_ms?: number;

  // legacy aliases
  profiles_scanned?: number;
  sessions_scanned?: number;
}

export interface FunnelFoxLeadsSyncResponse {
  /** ok / partial / error, or busy (another call — usually the cron tick — holds the lease). */
  status: string;
  dry_run: boolean;
  stage?: SyncStage | null;
  next_stage?: SyncStage | null;
  all_stages_completed?: boolean;
  /** false ⇒ the run advanced nothing (idle, busy, rate-limited, or no page fetched). */
  made_progress?: boolean;
  /** Every stage was already complete: nothing ran, nothing was written. */
  idle?: boolean;
  busy?: boolean;
  rate_limited?: boolean;
  rate_limited_until?: string | null;
  /** The background tick backs off after FunnelFox errors until then (a click is not held back). */
  error_backoff?: boolean;
  error_backoff_until?: string | null;
  stopped_reason?: SyncStoppedReason;
  coverage_warning?: boolean;
  coverage_warning_message?: string;
  summary?: FunnelFoxLeadsSyncSummary;
  /** Present only for dry runs (Diagnose): key names and counts, never emails or cursor values. */
  diagnostics?: Record<string, unknown>;
}

export interface FunnelFoxLeadsSyncState {
  auth_user_id: string;
  last_full_sync_at: string | null;
  last_profiles_synced_at: string | null;
  last_sessions_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
  /** A SyncStage; older rows may still name the removed profile_details stage. */
  current_stage: string | null;
  profiles_completed: boolean | null;
  details_completed: boolean | null;
  sessions_completed: boolean | null;
  reconcile_completed: boolean | null;
  last_profiles_cursor: string | null;
  last_sessions_cursor: string | null;
  /** A sync call holds the lease until then (cron tick or a button click). */
  lease_until?: string | null;
  /** Migration 202610070001: the reconcile stage queues the reconcile here; pg_cron applies it. */
  reconcile_requested_at?: string | null;
  /** Start time of the last applied reconcile (older than reconcile_requested_at ⇒ one is queued). */
  reconcile_applied_at?: string | null;
  reconcile_summary?: FunnelFoxLeadsReconcileSummary | null;
  /** The current streak of failed reconcile runs (null after a successful one); pg_cron backs off. */
  reconcile_failure?: FunnelFoxLeadsReconcileFailure | null;
  stats: FunnelFoxLeadsSyncSummary | null;
  updated_at: string | null;
}

/** funnelfox_leads_sync_state.reconcile_summary: the counts of the last applied reconcile. */
export interface FunnelFoxLeadsReconcileSummary {
  checked?: number;
  leads?: number;
  paid_excluded?: number;
  active_excluded?: number;
  updated?: number;
  duration_ms?: number;
  applied_at?: string;
}

/** funnelfox_leads_sync_state.reconcile_failure: the last failed reconcile run (a timeout included)
 * and when pg_cron tries again (15 min after the first failure, doubling, at most 6 h). */
export interface FunnelFoxLeadsReconcileFailure {
  failed_at?: string;
  started_at?: string;
  duration_ms?: number;
  sqlstate?: string;
  error?: string;
  /** Consecutive failed runs. */
  failures?: number;
  retry_after?: string;
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export interface SyncFunnelFoxLeadsOptions {
  /** The PII-free Diagnose: probes FunnelFox (at most LEADS_DIAGNOSE_MAX_PAGES list pages), writes nothing. */
  dryRun?: boolean;
  /** Clear cursors + completion flags and restart the pipeline from the first stage. */
  fullReset?: boolean;
  /** Force a specific stage; when omitted the Edge Function runs the next incomplete stage. */
  stage?: SyncStage;
  /** Profiles per FunnelFox page. Default LEADS_SYNC_LIMIT — always sent explicitly. */
  limit?: number;
  /** Page budget of one call. Default LEADS_SYNC_MAX_PAGES (LEADS_DIAGNOSE_MAX_PAGES for a dry run). */
  maxPages?: number;
}

/** The JSON body of one call. Pure + exported for tests: limit / max_pages are never omitted. */
export function buildFunnelFoxLeadsSyncBody(options: SyncFunnelFoxLeadsOptions = {}): Record<string, unknown> {
  const dryRun = options.dryRun ?? false;
  return {
    dry_run: dryRun,
    full_reset: options.fullReset ?? false,
    stage: options.stage,
    limit: options.limit ?? LEADS_SYNC_LIMIT,
    max_pages: options.maxPages ?? (dryRun ? LEADS_DIAGNOSE_MAX_PAGES : LEADS_SYNC_MAX_PAGES),
  };
}

export async function syncFunnelFoxLeads(options: SyncFunnelFoxLeadsOptions = {}): Promise<FunnelFoxLeadsSyncResponse> {
  const client = ensureSupabase();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before syncing FunnelFox leads.");

  const baseUrl = publicRuntimeConfig.supabaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/functions/v1/funnelfox-leads-sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildFunnelFoxLeadsSyncBody(options)),
  });

  const payload = await response.json().catch(() => ({ error: "Invalid sync response." }));
  if (!response.ok) throw new Error(payload.error ?? `FunnelFox leads sync failed with HTTP ${response.status}`);
  return payload as FunnelFoxLeadsSyncResponse;
}

/** The Diagnose button: a dry run with an explicit limit 100 / max_pages 2. */
export function diagnoseFunnelFoxLeadsSync(): Promise<FunnelFoxLeadsSyncResponse> {
  return syncFunnelFoxLeads({ dryRun: true, limit: LEADS_SYNC_LIMIT, maxPages: LEADS_DIAGNOSE_MAX_PAGES });
}

/**
 * Drive the resumable sync across several Edge calls. Each call runs one stage; we loop until the
 * pipeline reports it is fully complete, an error occurs, a call advances nothing (busy / idle /
 * rate-limited), or the step cap is hit (MANUAL_SYNC_MAX_STEPS by default — the minute cron carries
 * on from the saved cursor). `onProgress` lets the UI surface the stage after every step (1-based).
 */
export async function runFunnelFoxLeadsSync(
  options: Omit<SyncFunnelFoxLeadsOptions, "dryRun"> & {
    onProgress?: (res: FunnelFoxLeadsSyncResponse, step: number) => void;
    maxSteps?: number;
  } = {},
): Promise<FunnelFoxLeadsSyncResponse> {
  const maxSteps = Math.max(1, options.maxSteps ?? MANUAL_SYNC_MAX_STEPS);
  let last: FunnelFoxLeadsSyncResponse | null = null;
  for (let step = 0; step < maxSteps; step += 1) {
    last = await syncFunnelFoxLeads({
      fullReset: step === 0 ? options.fullReset : false,
      // Only the first step may carry full_reset / a forced stage; later steps resume from the saved cursors.
      stage: step === 0 ? options.stage : undefined,
      limit: options.limit ?? LEADS_SYNC_LIMIT,
      maxPages: options.maxPages ?? LEADS_SYNC_MAX_PAGES,
    });
    options.onProgress?.(last, step + 1);
    if (!shouldContinueSync(last)) break;
  }
  if (!last) throw new Error("FunnelFox leads sync did not run.");
  return last;
}

/** The workspace's sync-state row (RLS: the data key's members may read it; only Edge writes it). */
export async function getFunnelFoxLeadsStats(): Promise<FunnelFoxLeadsSyncState | null> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnelfox_leads_sync_state")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not load FunnelFox leads sync state: ${error.message}`);
  return (data ?? null) as FunnelFoxLeadsSyncState | null;
}

/** Epoch ms of a future ISO timestamp, else null (past, missing or invalid). */
export function futureMs(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > now ? ms : null;
}

/** How long after a reconcile request the card keeps polling for pg_cron to apply it (it runs every
 * minute; a longer wait means the job is not running — the card then stops polling). */
export const RECONCILE_QUEUE_POLL_WINDOW_MS = 15 * 60_000;

/** The reconcile stage queued a reconcile that pg_cron has not applied yet (requested after the last
 * applied run started). Not a failure: the pg_cron job funnelfox-leads-reconcile applies it within
 * a minute. */
export function isReconcileQueued(state: FunnelFoxLeadsSyncState | null | undefined): boolean {
  const requested = state?.reconcile_requested_at ? Date.parse(state.reconcile_requested_at) : Number.NaN;
  if (!Number.isFinite(requested)) return false;
  const applied = state?.reconcile_applied_at ? Date.parse(state.reconcile_applied_at) : Number.NaN;
  return !Number.isFinite(applied) || applied < requested;
}

/** A queued reconcile pg_cron is NOT applying "within a minute": queued for at least
 * RECONCILE_QUEUE_POLL_WINDOW_MS (the card has stopped polling; the job is likely not running), or
 * its last run failed (pg_cron backs off before the next one). The card then warns instead of the
 * reassuring note. */
export function isReconcileOverdue(state: FunnelFoxLeadsSyncState | null | undefined, now: number = Date.now()): boolean {
  if (!isReconcileQueued(state)) return false;
  if (state?.reconcile_failure) return true;
  return Date.parse(state?.reconcile_requested_at as string) <= now - RECONCILE_QUEUE_POLL_WINDOW_MS;
}

/** True while the sync card should keep re-reading the state: the pipeline is partial (the cron is
 * advancing it), a call holds the lease, a FunnelFox rate-limit pause is running, or a reconcile
 * queued in the last RECONCILE_QUEUE_POLL_WINDOW_MS waits for pg_cron. */
export function isLeadsSyncActive(state: FunnelFoxLeadsSyncState | null | undefined, now: number = Date.now()): boolean {
  if (!state) return false;
  if (state.last_status === "partial" || state.last_status === "busy") return true;
  if (futureMs(state.lease_until ?? null, now) != null) return true;
  if (isReconcileQueued(state) && Date.parse(state.reconcile_requested_at as string) > now - RECONCILE_QUEUE_POLL_WINDOW_MS) return true;
  return futureMs(state.stats?.rate_limited_until ?? null, now) != null;
}
