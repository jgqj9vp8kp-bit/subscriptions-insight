import { supabase } from "@/services/supabaseClient";
import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { normalizeSubscription } from "@/services/subscriptionTransform";
import type { FunnelFoxSubscriptionRaw, SubscriptionClean } from "@/types/subscriptions";
import {
  shouldContinueSubscriptionSync,
  type SubscriptionSyncStage,
  type SyncStoppedReason,
} from "@/services/funnelfoxSubscriptionsSyncCore";

const EDGE_FUNCTION = "funnelfox-subscriptions-sync";

/** Version tag of the staged/resumable subscriptions sync, shown in diagnostics. */
export const SUBSCRIPTION_SYNC_VERSION = "staged-v1";

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export interface FunnelFoxSubscriptionsSyncSummary {
  stage: SubscriptionSyncStage;
  next_stage: SubscriptionSyncStage | null;
  all_stages_completed: boolean;
  sync_stopped_reason: SyncStoppedReason;
  subscriptions_scanned_total: number;
  subscriptions_saved: number;
  subscriptions_with_email: number;
  missing_email_after_enrichment: number;
  rows_missing_profile_id: number;
  details_pending: number;
  profiles_pending: number;
  subscriptions_total_reported_by_api: number | null;
  subscriptions_coverage_percent: number | null;
  coverage_warning: boolean;
  coverage_warning_message: string;
  duration_ms: number;
  [key: string]: unknown;
}

export interface FunnelFoxSubscriptionsSyncResponse {
  status: "ok" | "partial" | "error";
  dry_run: boolean;
  stage: SubscriptionSyncStage;
  next_stage?: SubscriptionSyncStage | null;
  all_stages_completed: boolean;
  made_progress: boolean;
  stopped_reason?: SyncStoppedReason;
  coverage_warning?: boolean;
  coverage_warning_message?: string;
  summary?: FunnelFoxSubscriptionsSyncSummary;
  diagnostics?: Record<string, unknown>;
  error?: string;
}

export interface FunnelFoxSubscriptionsSyncState {
  auth_user_id: string;
  last_list_cursor: string | null;
  current_stage: string | null;
  list_completed: boolean;
  details_completed: boolean;
  profiles_completed: boolean;
  finalize_completed: boolean;
  subscriptions_scanned_total: number;
  subscriptions_total_reported_by_api: number | null;
  last_status: string | null;
  last_error: string | null;
  stopped_reason: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  last_full_sync_at: string | null;
  stats: FunnelFoxSubscriptionsSyncSummary | null;
  updated_at: string | null;
}

export interface SyncFunnelFoxSubscriptionsOptions {
  dryRun?: boolean;
  /** Clear cursors + completion flags and restart from the first stage. */
  fullReset?: boolean;
  /** Force a specific stage; omit to run the next incomplete stage. */
  stage?: SubscriptionSyncStage;
  limit?: number;
  maxPages?: number;
}

/** One Edge call = one stage (or a dry run). */
export async function syncFunnelFoxSubscriptions(
  options: SyncFunnelFoxSubscriptionsOptions = {},
): Promise<FunnelFoxSubscriptionsSyncResponse> {
  const client = ensureSupabase();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before syncing FunnelFox subscriptions.");

  const baseUrl = publicRuntimeConfig.supabaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/functions/v1/${EDGE_FUNCTION}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      dry_run: options.dryRun ?? false,
      full_reset: options.fullReset ?? false,
      stage: options.stage,
      limit: options.limit,
      max_pages: options.maxPages,
    }),
  });

  const payload = await response.json().catch(() => ({ error: "Invalid sync response." }));
  if (!response.ok) throw new Error(payload.error ?? `FunnelFox subscriptions sync failed with HTTP ${response.status}`);
  return payload as FunnelFoxSubscriptionsSyncResponse;
}

/**
 * Drive the resumable sync across multiple Edge calls (one stage each). Stops
 * when the pipeline completes, errors, stalls (no progress), or hits the cap.
 * `shouldCancel` lets the UI abort between steps. `onProgress` surfaces each step.
 */
export async function runFunnelFoxSubscriptionsSync(
  options: SyncFunnelFoxSubscriptionsOptions & {
    onProgress?: (res: FunnelFoxSubscriptionsSyncResponse) => void;
    shouldCancel?: () => boolean;
    maxSteps?: number;
  } = {},
): Promise<FunnelFoxSubscriptionsSyncResponse> {
  const maxSteps = options.maxSteps ?? 40;
  let last: FunnelFoxSubscriptionsSyncResponse | null = null;
  for (let step = 0; step < maxSteps; step += 1) {
    if (options.shouldCancel?.()) break;
    last = await syncFunnelFoxSubscriptions({
      ...options,
      // Only the first step may carry full_reset; later steps resume from saved cursors.
      fullReset: step === 0 ? options.fullReset : false,
    });
    options.onProgress?.(last);
    if (!shouldContinueSubscriptionSync(last)) break;
  }
  if (!last) throw new Error("FunnelFox subscriptions sync did not run.");
  return last;
}

export async function getFunnelFoxSubscriptionsSyncState(): Promise<FunnelFoxSubscriptionsSyncState | null> {
  const client = ensureSupabase();
  const { data, error } = await client.from("funnelfox_subscriptions_sync_state").select("*").maybeSingle();
  if (error) throw new Error(`Could not load FunnelFox subscriptions sync state: ${error.message}`);
  return (data ?? null) as FunnelFoxSubscriptionsSyncState | null;
}

export interface FunnelFoxSubscriptionRow {
  subscription_id: string;
  email: string | null;
  normalized_email: string | null;
  raw_list: FunnelFoxSubscriptionRaw | null;
  raw_detail: FunnelFoxSubscriptionRaw | null;
}

/**
 * Re-derive a full SubscriptionClean from a durable row. Detail payload wins over
 * list; a profile-recovered email is injected so normalizeSubscription (the single
 * normalization source) picks it up. Pure + exported for the restore-after-refresh test.
 */
export function subscriptionRowToClean(row: FunnelFoxSubscriptionRow): SubscriptionClean {
  const merged: FunnelFoxSubscriptionRaw = { ...(row.raw_list ?? {}), ...(row.raw_detail ?? {}) };
  const recoveredEmail = row.email ?? row.normalized_email;
  if (recoveredEmail && !merged.email) merged.email = recoveredEmail;
  return normalizeSubscription(merged);
}

/** Load durable synced subscriptions and re-derive SubscriptionClean[] for the store. */
export async function loadFunnelFoxSubscriptions(): Promise<SubscriptionClean[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("funnelfox_subscriptions")
    .select("subscription_id, email, normalized_email, raw_list, raw_detail")
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(100000);
  if (error) throw new Error(`Could not load FunnelFox subscriptions: ${error.message}`);
  return ((data ?? []) as FunnelFoxSubscriptionRow[]).map(subscriptionRowToClean);
}

// ---- UI status helpers (pure, tested) --------------------------------------------------------

export type SubscriptionSyncUiStatus =
  | "never_synced"
  | "syncing"
  | "partial"
  | "completed"
  | "inconsistent"
  | "failed";

export function subscriptionSyncUiStatus(
  state: FunnelFoxSubscriptionsSyncState | null,
  syncing: boolean,
): SubscriptionSyncUiStatus {
  if (syncing) return "syncing";
  if (!state || !state.last_status) return "never_synced";
  if (state.last_status === "failed") return "failed";
  if (state.last_status === "partial") return "partial";
  // A fully-finished sync whose stored count != FunnelFox total is NOT "completed".
  if (state.last_status === "completed_with_inconsistencies") return "inconsistent";
  if (state.last_status === "completed") return "completed";
  return "never_synced";
}

export interface SubscriptionSyncReport {
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  downloaded: number | null;
  inserted: number | null;
  updated: number | null;
  skipped: number | null;
  total_stored: number | null;
  total_in_funnelfox: number | null;
  parity_check: "PASS" | "FAIL" | "UNKNOWN" | null;
}

/** The permanent sync report block (Phase 5), if present in the sync-state stats. */
export function subscriptionSyncReport(state: FunnelFoxSubscriptionsSyncState | null): SubscriptionSyncReport | null {
  const report = state?.stats?.sync_report as SubscriptionSyncReport | undefined;
  return report ?? null;
}

/**
 * Warning to show near subscription-derived metrics ONLY when there is positive
 * evidence the FunnelFox sync did not finish (an explicit partial status or a
 * coverage warning). A null / unknown sync-state does not nag — the app may be
 * running on a complete legacy snapshot with no sync-state row.
 */
export function subscriptionSyncCompletenessWarning(state: FunnelFoxSubscriptionsSyncState | null): string | null {
  if (!state) return null;
  if (state.last_status === "partial") {
    return "Active subscription metrics may be incomplete because FunnelFox sync is partial.";
  }
  if (state.last_status === "completed_with_inconsistencies") {
    return "Active subscription metrics may be incomplete: the last sync stored fewer subscriptions than FunnelFox reports.";
  }
  if (state.last_status !== "completed" && state.stats?.coverage_warning) {
    return "Active subscription metrics may be incomplete because FunnelFox sync did not fully cover all subscriptions.";
  }
  return null;
}

export function shouldShowPartialWarning(state: FunnelFoxSubscriptionsSyncState | null): boolean {
  if (!state) return false;
  if (state.last_status === "partial") return true;
  const stats = state.stats;
  if (!stats) return false;
  return Boolean(stats.coverage_warning);
}
