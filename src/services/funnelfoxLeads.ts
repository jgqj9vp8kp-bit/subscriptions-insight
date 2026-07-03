import { supabase } from "@/services/supabaseClient";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { normalizeEmail } from "@/services/subscriptionTransform";
import { shouldContinueSync } from "@/services/funnelfoxLeadsTransform";
import type { Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";

/**
 * Frontend bridge for the `funnelfox-leads-sync` Edge Function + `funnelfox_leads` table.
 *
 * The Edge Function crawls FunnelFox server-side but cannot see the client-only transaction
 * warehouse, so the conversion context (which emails paid / have an active subscription / converted)
 * is computed here from already-loaded data and passed in the request. This reads the warehouse
 * read-only — it does not change any warehouse / Users / Cohorts logic.
 */

export interface FunnelFoxLeadRow {
  id: string;
  profile_id: string;
  email: string | null;
  normalized_email: string | null;
  created_at: string | null;
  updated_at: string | null;
  synced_at: string | null;
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

export type SyncStage = "profiles" | "profile_details" | "sessions" | "reconcile";
export type SyncStoppedReason = "completed" | "soft_timeout" | "max_pages_reached" | "api_error" | "unknown";

/**
 * Diagnostics written to `funnelfox_leads_sync_state.stats` by each staged run. Fields accumulate
 * across stages, so a fully-synced account has the complete picture. All optional — a given run only
 * populates the fields for the stage it executed plus the cross-cutting coverage counts.
 */
export interface FunnelFoxLeadsSyncSummary {
  stage?: SyncStage;
  next_stage?: SyncStage | null;
  all_stages_completed?: boolean;
  sync_stopped_reason?: SyncStoppedReason;

  // profiles stage
  profiles_pages_processed?: number;
  profiles_has_more_on_last_page?: boolean;
  profiles_last_cursor?: string | null;
  profiles_total_scanned_this_run?: number;
  profiles_total_saved_this_run?: number;
  profiles_skipped_no_profile_id?: number;

  // profile_details stage
  profile_details_attempted?: number;
  profile_details_fetched?: number;
  profile_details_failed?: number;
  profile_details_gone?: number;
  profile_details_timeout_skipped?: number;
  remaining_detail_unchecked?: number;
  remaining_without_email_after_checked?: number;

  // sessions stage
  sessions_pages_processed?: number;
  sessions_has_more_on_last_page?: boolean;
  sessions_last_cursor?: string | null;
  sessions_total_scanned_this_run?: number;
  sessions_joined?: number;
  sessions_without_profile_id?: number;

  // reconcile stage
  reconcile_rows?: number;
  leads_found?: number;
  converted_excluded?: number;
  active_sub_excluded?: number;

  // cross-cutting coverage
  profiles_total_saved?: number;
  profiles_with_email?: number;
  profiles_without_email?: number;
  profiles_pending_enrichment?: number;
  profiles_scanned_total?: number;
  sessions_scanned_total?: number;
  profiles_total_reported_by_api?: number | null;
  profiles_coverage_percent?: number | null;
  coverage_warning?: boolean;
  coverage_warning_message?: string;
  duration_ms?: number;

  // legacy aliases
  profiles_scanned?: number;
  sessions_scanned?: number;
  emails_found?: number;
}

export interface FunnelFoxLeadsSyncResponse {
  status: string;
  dry_run: boolean;
  stage?: SyncStage;
  next_stage?: SyncStage | null;
  all_stages_completed?: boolean;
  /** false ⇒ the run advanced nothing (e.g. all detail fetches failed transiently). */
  made_progress?: boolean;
  stopped_reason?: SyncStoppedReason;
  coverage_warning?: boolean;
  coverage_warning_message?: string;
  summary?: FunnelFoxLeadsSyncSummary;
  /** Present only for dry runs. */
  diagnostics?: Record<string, unknown>;
}

export interface FunnelFoxLeadsSyncState {
  auth_user_id: string;
  last_full_sync_at: string | null;
  last_profiles_synced_at: string | null;
  last_sessions_synced_at: string | null;
  last_status: string | null;
  last_error: string | null;
  current_stage: SyncStage | null;
  profiles_completed: boolean | null;
  details_completed: boolean | null;
  sessions_completed: boolean | null;
  reconcile_completed: boolean | null;
  last_profiles_cursor: string | null;
  last_sessions_cursor: string | null;
  stats: FunnelFoxLeadsSyncSummary | null;
  updated_at: string | null;
}

export interface ConversionContextPayload {
  paid_emails: string[];
  active_sub_emails: string[];
  trial_dates: Record<string, string>;
  first_sub_dates: Record<string, string>;
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function earliest(map: Record<string, string>, email: string, date: string) {
  const current = map[email];
  if (!current || date < current) map[email] = date;
}

/**
 * Build the conversion context the Edge Function needs to mark leads as converted, from the loaded
 * warehouse + FunnelFox subscriptions. Pure + exported for tests.
 */
export function buildConversionContext(
  transactions: Transaction[],
  subscriptions: SubscriptionClean[] = [],
): ConversionContextPayload {
  const paid = new Set<string>();
  const trialDates: Record<string, string> = {};
  const firstSubDates: Record<string, string> = {};

  for (const tx of transactions) {
    const email = normalizeEmail(tx.email);
    if (!email || tx.status !== "success") continue;
    paid.add(email);
    if (tx.transaction_type === "trial") earliest(trialDates, email, tx.event_time);
    if (tx.transaction_type === "first_subscription") earliest(firstSubDates, email, tx.event_time);
  }

  const active = new Set<string>();
  for (const sub of subscriptions) {
    const email = normalizeEmail(sub.email);
    if (email && sub.is_active_now) active.add(email);
  }

  return {
    paid_emails: [...paid],
    active_sub_emails: [...active],
    trial_dates: trialDates,
    first_sub_dates: firstSubDates,
  };
}

export interface SyncFunnelFoxLeadsOptions {
  transactions: Transaction[];
  subscriptions?: SubscriptionClean[];
  dryRun?: boolean;
  /** Clear cursors + completion flags and restart the pipeline from the first stage. */
  fullReset?: boolean;
  /** Force a specific stage; when omitted the Edge Function runs the next incomplete stage. */
  stage?: SyncStage;
  limit?: number;
  maxPages?: number;
}

export async function syncFunnelFoxLeads(options: SyncFunnelFoxLeadsOptions): Promise<FunnelFoxLeadsSyncResponse> {
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
    body: JSON.stringify({
      dry_run: options.dryRun ?? false,
      full_reset: options.fullReset ?? false,
      stage: options.stage,
      limit: options.limit,
      max_pages: options.maxPages,
      conversion: buildConversionContext(options.transactions, options.subscriptions ?? []),
    }),
  });

  const payload = await response.json().catch(() => ({ error: "Invalid sync response." }));
  if (!response.ok) throw new Error(payload.error ?? `FunnelFox leads sync failed with HTTP ${response.status}`);
  return payload as FunnelFoxLeadsSyncResponse;
}

/**
 * Drive the resumable sync to completion across multiple Edge calls. Each call runs one stage; we
 * loop until the pipeline reports it is fully complete, an error occurs, or a safety cap is hit.
 * `onProgress` lets the UI surface the stage/coverage after every step.
 */
export async function runFunnelFoxLeadsSync(
  options: SyncFunnelFoxLeadsOptions & { onProgress?: (res: FunnelFoxLeadsSyncResponse) => void; maxSteps?: number },
): Promise<FunnelFoxLeadsSyncResponse> {
  const maxSteps = options.maxSteps ?? 40;
  let last: FunnelFoxLeadsSyncResponse | null = null;
  for (let step = 0; step < maxSteps; step += 1) {
    last = await syncFunnelFoxLeads({
      ...options,
      // Only the first step may carry full_reset; subsequent steps resume from saved cursors.
      fullReset: step === 0 ? options.fullReset : false,
    });
    options.onProgress?.(last);
    // Stop when the pipeline completes, errors, or stalls (a run that advanced nothing — e.g. every
    // detail fetch failed transiently). The user can retry later once the upstream recovers.
    if (!shouldContinueSync(last)) break;
  }
  if (!last) throw new Error("FunnelFox leads sync did not run.");
  return last;
}

export async function loadFunnelFoxLeads(): Promise<FunnelFoxLeadRow[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnelfox_leads")
    .select("*")
    .eq("is_lead", true)
    .order("session_created_at", { ascending: false, nullsFirst: false })
    .limit(10000);
  if (error) throw new Error(`Could not load FunnelFox leads: ${error.message}`);
  return (data ?? []) as FunnelFoxLeadRow[];
}

export async function getFunnelFoxLeadsStats(): Promise<FunnelFoxLeadsSyncState | null> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnelfox_leads_sync_state")
    .select("*")
    .maybeSingle();
  if (error) throw new Error(`Could not load FunnelFox leads sync state: ${error.message}`);
  return (data ?? null) as FunnelFoxLeadsSyncState | null;
}
