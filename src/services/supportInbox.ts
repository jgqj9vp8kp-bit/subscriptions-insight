import { publicRuntimeConfig } from "@/config/publicRuntimeConfig";
import { supabase } from "@/services/supabaseClient";
import { computeCohorts } from "@/services/analytics";
import { buildCohortId } from "@/services/cohortIdentity";
import { countryCodeForUserTransactions } from "@/services/userCountry";
import { cardTypeForUserTransactions } from "@/services/userCardType";
import { mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";
import type { CardType, MediaBuyer, Transaction } from "@/services/types";

export const SUPPORT_INTENTS = [
  "refund_request",
  "cancel_subscription",
  "payment_problem",
  "access_problem",
  "general_support",
  "unknown",
] as const;

export type SupportIntent = (typeof SUPPORT_INTENTS)[number];

export interface SupportMessage {
  id: string;
  auth_user_id: string;
  message_id: string;
  thread_id: string | null;
  mailbox: string;
  folder: string;
  from_email: string | null;
  from_name: string | null;
  to_email: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  synced_at: string;
  detected_intent: SupportIntent;
  matched_user_email: string | null;
  matched_user_id: string | null;
  cohort_id: string | null;
  cohort_date: string | null;
  campaign_path: string | null;
  campaign_id: string | null;
  media_buyer: MediaBuyer | string | null;
  country_code: string | null;
  card_type: CardType | string | null;
  subscription_status: string | null;
  refund_status: string | null;
  amount_paid: number | null;
  amount_refunded: number | null;
  raw_headers: Record<string, unknown> | null;
  raw_payload: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface SyncSupportMailSummary {
  ok?: boolean;
  action?: SupportMailSyncAction;
  provider?: string;
  mailbox?: string;
  folder?: string;
  status?: string;
  connection?: "connected" | "failed" | "unknown";
  config?: {
    host: boolean;
    port: boolean;
    secure: boolean;
    username: boolean;
    password: boolean;
  };
  state?: SupportMailSyncState | null;
  messages_discovered?: number;
  messages_processed?: number;
  messages_inserted?: number;
  messages_updated?: number;
  messages_skipped?: number;
  messages_failed?: number;
  last_seen_uid?: number | null;
  uid_validity?: string | null;
  highest_modseq?: string | null;
  mailbox_messages?: number | null;
  mailbox_uid_next?: number | null;
  history_first_uid?: number | null;
  history_last_uid?: number | null;
  history_total_messages?: number | null;
  history_imported_messages?: number | null;
  history_remaining_messages?: number | null;
  history_completed_at?: string | null;
  current_uid?: number | null;
  last_imported_uid?: number | null;
  current_batch_total?: number | null;
  current_batch_processed?: number | null;
  last_batch_duration_ms?: number | null;
  last_batch_messages_per_second?: number | null;
  last_sync_imported?: number | null;
  last_sync_new_messages?: number | null;
  duration_ms?: number;
  error_code?: string;
  error?: string;
  clickhouse?: unknown;
  // Backward-compatible aliases used by the current Support page tests.
  synced: number;
  inserted: number;
  updated: number;
  skipped: number;
  matched_users: number;
  unmatched: number;
  latest_received_at: string | null;
}

export type SupportMailSyncAction =
  | "test_connection"
  | "status"
  | "list_folders"
  | "initial_sync"
  | "continue_sync"
  | "sync_new"
  | "stop"
  | "reset_cursor";

export interface SupportMailSyncState {
  status?: string;
  sync_mode?: string | null;
  uid_validity?: string | null;
  last_seen_uid?: number | null;
  highest_modseq?: string | null;
  mailbox_messages?: number | null;
  mailbox_uid_next?: number | null;
  history_first_uid?: number | null;
  history_last_uid?: number | null;
  history_total_messages?: number | null;
  history_imported_messages?: number | null;
  history_remaining_messages?: number | null;
  history_completed_at?: string | null;
  current_uid?: number | null;
  last_imported_uid?: number | null;
  current_batch_total?: number | null;
  current_batch_processed?: number | null;
  current_batch_started_at?: string | null;
  last_batch_duration_ms?: number | null;
  last_batch_messages_per_second?: number | null;
  last_sync_imported?: number | null;
  last_sync_new_messages?: number | null;
  messages_discovered?: number | null;
  messages_processed?: number | null;
  messages_inserted?: number | null;
  messages_updated?: number | null;
  messages_skipped?: number | null;
  messages_failed?: number | null;
  current_batch?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  last_success_at?: string | null;
  last_error_code?: string | null;
  last_error_message_sanitized?: string | null;
  updated_at?: string | null;
}

export interface SupportMessageFilters {
  dateFrom?: string;
  dateTo?: string;
  intent?: SupportIntent | "all";
  campaignPath?: string;
  campaignId?: string;
  mediaBuyer?: string;
  country?: string;
  cardType?: string;
  matchStatus?: "all" | "matched" | "unmatched";
  search?: string;
}

export interface SupportSummary {
  totalMessages: number;
  refundRequests: number;
  cancelRequests: number;
  paymentProblems: number;
  matchedUsers: number;
  unmatchedMessages: number;
}

export interface SupportEnrichment {
  matched_user_email: string | null;
  matched_user_id: string | null;
  cohort_id: string | null;
  cohort_date: string | null;
  campaign_path: string | null;
  campaign_id: string | null;
  media_buyer: MediaBuyer | "Unknown" | null;
  country_code: string | null;
  card_type: CardType | null;
  subscription_status: string | null;
  refund_status: string | null;
  amount_paid: number | null;
  amount_refunded: number | null;
}

const INTENT_KEYWORDS: Array<{ intent: SupportIntent; keywords: string[] }> = [
  {
    intent: "refund_request",
    keywords: ["refund", "money back", "return my money", "chargeback", "refunded", "reimbursement"],
  },
  {
    intent: "cancel_subscription",
    keywords: ["cancel", "unsubscribe", "stop subscription", "cancel my plan", "end subscription"],
  },
  {
    intent: "payment_problem",
    keywords: ["charged", "billing", "payment", "card", "transaction", "declined", "invoice"],
  },
  {
    intent: "access_problem",
    keywords: ["login", "access", "account", "password", "app", "cannot open", "not received"],
  },
  {
    intent: "general_support",
    keywords: ["help", "question", "support"],
  },
];

export function normalizeSupportEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

export function classifySupportIntent(subject: string | null | undefined, body: string | null | undefined): SupportIntent {
  const haystack = `${subject ?? ""}\n${body ?? ""}`.toLowerCase();
  for (const rule of INTENT_KEYWORDS) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) return rule.intent;
  }
  return "unknown";
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function grossAmount(tx: Transaction): number {
  return tx.gross_amount_usd ?? (tx.amount_usd > 0 ? tx.amount_usd : 0);
}

function refundAmount(tx: Transaction): number {
  return tx.refund_amount_usd ?? (tx.amount_usd < 0 ? Math.abs(tx.amount_usd) : 0);
}

function netAmount(tx: Transaction): number {
  return tx.net_amount_usd ?? grossAmount(tx) - refundAmount(tx);
}

function isMoneyMoving(tx: Transaction): boolean {
  return tx.status !== "failed";
}

function isSubscriptionPayment(tx: Transaction): boolean {
  return tx.status === "success" && ["first_subscription", "renewal_2", "renewal_3", "renewal"].includes(tx.transaction_type);
}

function userKeyForTransaction(tx: Transaction): string {
  return tx.user_id || normalizeSupportEmail(tx.email) || tx.transaction_id;
}

export function enrichSupportMessageFromTransactions(fromEmail: string | null | undefined, txs: Transaction[]): SupportEnrichment {
  const normalizedEmail = normalizeSupportEmail(fromEmail);
  if (!normalizedEmail) return emptySupportEnrichment();

  const directMatches = txs.filter((tx) => normalizeSupportEmail(tx.email) === normalizedEmail);
  if (!directMatches.length) return emptySupportEnrichment();

  const matchedUserId = userKeyForTransaction(directMatches[0]);
  const userTxs = txs
    .filter((tx) => userKeyForTransaction(tx) === matchedUserId || normalizeSupportEmail(tx.email) === normalizedEmail)
    .sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));

  const trial = userTxs.find((tx) => tx.status === "success" && tx.transaction_type === "trial") ?? userTxs.find((tx) => tx.status === "success");
  const cohortDate = trial ? dateKey(trial.cohort_date ?? trial.event_time) : null;
  const campaignPath = trial?.campaign_path || userTxs.find((tx) => tx.campaign_path)?.campaign_path || null;
  const campaignId = trial?.campaign_id || userTxs.find((tx) => tx.campaign_id)?.campaign_id || null;
  const cohortId = trial?.cohort_id ?? (cohortDate ? buildCohortId(trial?.funnel, campaignPath, cohortDate) : null);
  const mediaBuyer = mediaBuyerForUserTransactions(userTxs).media_buyer;
  const amountPaid = userTxs.filter(isMoneyMoving).reduce((sum, tx) => sum + Math.max(0, netAmount(tx)), 0);
  const amountRefunded = userTxs.reduce((sum, tx) => sum + refundAmount(tx), 0);
  const hasSubscription = userTxs.some(isSubscriptionPayment);
  const hasRefund = amountRefunded > 0 || userTxs.some((tx) => tx.is_refunded || tx.status === "refunded" || tx.status === "chargeback");
  const cohorts = computeCohorts(userTxs);
  const cohort = cohortId ? cohorts.find((row) => row.cohort_id === cohortId) : cohorts[0];

  return {
    matched_user_email: normalizedEmail,
    matched_user_id: matchedUserId,
    cohort_id: cohort?.cohort_id ?? cohortId,
    cohort_date: cohort?.cohort_date ?? cohortDate,
    campaign_path: cohort?.campaign_path ?? campaignPath,
    campaign_id: campaignId,
    media_buyer: mediaBuyer,
    country_code: countryCodeForUserTransactions(userTxs),
    card_type: cardTypeForUserTransactions(userTxs),
    subscription_status: hasSubscription ? "has_subscription" : "no_subscription",
    refund_status: hasRefund ? "refunded" : "not_refunded",
    amount_paid: round2(amountPaid),
    amount_refunded: round2(amountRefunded),
  };
}

export function emptySupportEnrichment(): SupportEnrichment {
  return {
    matched_user_email: null,
    matched_user_id: null,
    cohort_id: null,
    cohort_date: null,
    campaign_path: null,
    campaign_id: null,
    media_buyer: null,
    country_code: null,
    card_type: null,
    subscription_status: null,
    refund_status: null,
    amount_paid: null,
    amount_refunded: null,
  };
}

export function filterSupportMessages(messages: SupportMessage[], filters: SupportMessageFilters): SupportMessage[] {
  const search = String(filters.search ?? "").trim().toLowerCase();
  const dateFrom = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00.000Z`).getTime() : null;
  const dateTo = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999Z`).getTime() : null;

  return messages.filter((message) => {
    const receivedMs = message.received_at ? new Date(message.received_at).getTime() : null;
    if (dateFrom != null && receivedMs != null && receivedMs < dateFrom) return false;
    if (dateTo != null && receivedMs != null && receivedMs > dateTo) return false;
    if (filters.intent && filters.intent !== "all" && message.detected_intent !== filters.intent) return false;
    if (filters.campaignPath && message.campaign_path !== filters.campaignPath) return false;
    if (filters.campaignId && message.campaign_id !== filters.campaignId) return false;
    if (filters.mediaBuyer && message.media_buyer !== filters.mediaBuyer) return false;
    if (filters.country && message.country_code !== filters.country) return false;
    if (filters.cardType && message.card_type !== filters.cardType) return false;
    if (filters.matchStatus === "matched" && !message.matched_user_id) return false;
    if (filters.matchStatus === "unmatched" && message.matched_user_id) return false;
    if (search) {
      const haystack = [
        message.from_email,
        message.from_name,
        message.subject,
        message.matched_user_email,
      ].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

export function summarizeSupportMessages(messages: SupportMessage[]): SupportSummary {
  return {
    totalMessages: messages.length,
    refundRequests: messages.filter((message) => message.detected_intent === "refund_request").length,
    cancelRequests: messages.filter((message) => message.detected_intent === "cancel_subscription").length,
    paymentProblems: messages.filter((message) => message.detected_intent === "payment_problem").length,
    matchedUsers: messages.filter((message) => Boolean(message.matched_user_id)).length,
    unmatchedMessages: messages.filter((message) => !message.matched_user_id).length,
  };
}

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function listSupportMessages(): Promise<SupportMessage[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("support_messages")
    .select("*")
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(1000);
  if (error) throw new Error(`Could not load support messages: ${error.message}`);
  return (data ?? []) as SupportMessage[];
}

function normalizeSyncSummary(payload: Partial<SyncSupportMailSummary>): SyncSupportMailSummary {
  const processed = payload.last_sync_imported ?? payload.messages_processed ?? payload.synced ?? 0;
  const inserted = payload.messages_inserted ?? payload.inserted ?? 0;
  const updated = payload.messages_updated ?? payload.updated ?? 0;
  const skipped = payload.messages_skipped ?? payload.skipped ?? 0;
  const latest =
    payload.latest_received_at ??
    payload.state?.last_success_at ??
    payload.state?.completed_at ??
    null;
  return {
    ...payload,
    synced: processed,
    inserted,
    updated,
    skipped,
    matched_users: payload.matched_users ?? inserted + updated,
    unmatched: payload.unmatched ?? 0,
    latest_received_at: latest,
  };
}

export async function syncSupportMail(
  action: SupportMailSyncAction = "sync_new",
  options: Record<string, unknown> = {},
): Promise<SyncSupportMailSummary> {
  const client = ensureSupabase();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  const token = sessionData.session?.access_token;
  if (sessionError || !token) throw new Error("Sign in before syncing support mail.");

  const baseUrl = publicRuntimeConfig.supabaseUrl.replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/functions/v1/sync-support-mail`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, ...options }),
  });
  const payload = await response.json().catch(() => ({ error: "Invalid sync response." }));
  if (!response.ok) throw new Error(payload.error ?? `Support mail sync failed with HTTP ${response.status}`);
  return normalizeSyncSummary(payload as Partial<SyncSupportMailSummary>);
}

export async function getSupportMailStatus(): Promise<SyncSupportMailSummary> {
  return syncSupportMail("status");
}

export function uniqueSupportValues(messages: SupportMessage[], key: keyof SupportMessage): string[] {
  return Array.from(new Set(messages.map((message) => message[key]).filter((value): value is string => typeof value === "string" && value.length > 0))).sort();
}
