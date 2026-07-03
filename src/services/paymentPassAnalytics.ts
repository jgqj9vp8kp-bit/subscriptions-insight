/**
 * Payment pass-rate analytics.
 *
 * A single source of truth for the "Payment Pass Analytics" mode on the Transactions page.
 * It turns the warehouse-hydrated, already-classified `Transaction[]` into a flat list of
 * PAYMENT ATTEMPTS and aggregates pass rate at both the transaction level and the user level.
 *
 * Design notes:
 *  - Stage is computed from the user's FULL timeline (warehouse history), never from a single CSV.
 *    Successful subscription depth reuses `subscriptionLevelByPaymentForUser` — the same canonical
 *    sequence the Cohorts page and Export API use — so renewal depth never disagrees with Cohorts.
 *  - Failed attempts are excluded from the success sequence, so a failed payment is staged by how
 *    many SUCCESSFUL subscription payments preceded it (the rebill it was attempting).
 *  - GEO / card type / media buyer are user-level derivations (same helpers as Cohorts), attached
 *    to every attempt of that user.
 *  - Refunds, chargebacks and unrecognised rows are NOT attempts.
 */
import type { CardType, DeclineReason, MediaBuyer, Transaction } from "@/services/types";
import { dedupeTransactionsForAnalytics, subscriptionLevelByPaymentForUser } from "@/services/analytics";
import { declineDetailsForTransaction, isFailedPaymentTransaction } from "@/services/paymentFailures";
import { countryCodeForUserTransactions } from "@/services/userCountry";
import { cardTypeForUserTransactions } from "@/services/userCardType";
import { mediaBuyerForUserTransactions } from "@/services/userMediaBuyer";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle stage of a single payment attempt (success OR failed). */
export type PaymentStage =
  | "trial_or_entry"
  | "first_subscription"
  | "renewal_2"
  | "renewal_3"
  | "renewal_n"
  | "upsell"
  | "unknown";

export type SegmentDimension =
  | "funnel"
  | "campaign_path"
  | "campaign_id"
  | "media_buyer"
  | "country"
  | "card_type"
  | "decline_reason"
  | "stage";

export interface PaymentAttempt {
  transaction_id: string;
  user_id: string;
  email: string;
  event_time: string;
  event_date: string; // YYYY-MM-DD of the attempt
  cohort_date: string | null; // user cohort date (first successful trial)
  amount_usd: number;
  is_success: boolean;
  is_failed: boolean;
  is_first_attempt: boolean; // the user's very first payment attempt (success or fail)
  stage: PaymentStage;
  subscription_level: number | null; // 1 = First Sub, 2 = Renewal 2, ... (null for trial/upsell)
  transaction_type: string;
  decline_reason: DeclineReason | null;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  country: string;
  card_type: CardType;
  media_buyer: MediaBuyer;
}

/** Aggregated pass-rate metrics for any slice of attempts. */
export interface PassMetrics {
  attempts: number;
  successful: number;
  failed: number;
  pass_rate: number;
  users_with_attempts: number;
  users_with_success: number;
  user_pass_rate: number;
  failed_users: number;
  first_attempts: number;
  first_success: number;
  first_attempt_pass_rate: number;
  first_sub_attempts: number;
  first_sub_success: number;
  first_sub_pass_rate: number;
  renewal_attempts: number;
  renewal_success: number;
  renewal_pass_rate: number;
  top_decline_reason: DeclineReason | null;
  top_decline_reason_users: number;
  /** Failed attempts declined for insufficient funds (excluded from the ex-IF pass rate). */
  insufficient_funds_failures: number;
  /** total_attempts minus insufficient-funds failures. */
  eligible_attempts_ex_if: number;
  /** successful_attempts / eligible_attempts_ex_if (0 when there are no eligible attempts). */
  pass_rate_ex_if: number;
}

export interface SegmentRow extends PassMetrics {
  key: string;
  label: string;
}

export interface DeclineReasonRow {
  reason: DeclineReason;
  label: string;
  failed_attempts: number;
  failed_users: number;
  share_of_failed: number;
  affected_funnels: string[];
  most_common_stage: PaymentStage | null;
  most_common_card_type: CardType | null;
  most_common_country: string | null;
}

export interface PassRatePoint {
  date: string;
  attempts: number;
  successful: number;
  failed: number;
  pass_rate: number;
}

// ---------------------------------------------------------------------------
// Labels & ordering
// ---------------------------------------------------------------------------

export const PAYMENT_STAGE_LABELS: Record<PaymentStage, string> = {
  trial_or_entry: "Trial / Entry",
  first_subscription: "First Subscription",
  renewal_2: "Renewal 2",
  renewal_3: "Renewal 3",
  renewal_n: "Renewal 4+",
  upsell: "Upsell",
  unknown: "Unknown",
};

/** Order used for the Stage breakdown table (includes the synthetic "first_transaction" lens). */
export const STAGE_BREAKDOWN_ORDER: PaymentStage[] = [
  "trial_or_entry",
  "first_subscription",
  "renewal_2",
  "renewal_3",
  "renewal_n",
  "upsell",
];

export const SEGMENT_DIMENSION_LABELS: Record<SegmentDimension, string> = {
  funnel: "Funnel / Campaign Path",
  campaign_path: "Campaign Path",
  campaign_id: "Campaign ID",
  media_buyer: "Media Buyer",
  country: "GEO / Country",
  card_type: "Card Type",
  decline_reason: "Decline Reason",
  stage: "Payment Stage",
};

export const DECLINE_REASON_LABELS: Record<DeclineReason, string> = {
  insufficient_funds: "Insufficient Funds",
  do_not_honor: "Do Not Honor",
  authentication_failed: "Authentication Failed",
  issuer_unavailable: "Issuer Unavailable",
  expired_card: "Expired Card",
  card_not_supported: "Card Not Supported",
  lost_card: "Lost Card",
  stolen_card: "Stolen Card",
  fraud_suspected: "Fraud Suspected",
  card_velocity_exceeded: "Card Velocity Exceeded",
  processing_error: "Processing Error",
  generic_decline: "Generic Decline",
  unknown: "Unknown",
};

export function declineReasonLabel(reason: DeclineReason | null): string {
  return reason ? DECLINE_REASON_LABELS[reason] : "—";
}

// ---------------------------------------------------------------------------
// Attempt detection
// ---------------------------------------------------------------------------

/**
 * A successful payment attempt: any settled charge (status === "success") that is not a refund or
 * chargeback row. Detection is intentionally symmetric with `isFailedAttempt` (which matches by
 * status AND tokens) — keying success off a fixed transaction_type whitelist would silently DROP
 * successful subscription charges whose type was never re-classified (non-palmer warehouse rows keep
 * raw / "unknown" types), while their failed siblings still count, craterng the pass rate.
 */
export function isSuccessfulAttempt(tx: Transaction): boolean {
  return (
    tx.status === "success" &&
    tx.transaction_type !== "refund" &&
    tx.transaction_type !== "chargeback"
  );
}

/** A failed/declined payment attempt. Reuses the canonical detector (refund/chargeback excluded). */
export function isFailedAttempt(tx: Transaction): boolean {
  return isFailedPaymentTransaction(tx);
}

/**
 * Any payment attempt: successful, failed or declined. Refunds, chargebacks, refund-only rows and
 * unrecognised/internal-adjustment rows are NOT attempts.
 */
export function isPaymentAttempt(tx: Transaction): boolean {
  return isSuccessfulAttempt(tx) || isFailedAttempt(tx);
}

// ---------------------------------------------------------------------------
// Stage classification (user-scoped, full history)
// ---------------------------------------------------------------------------

function stageFromLevel(level: number): PaymentStage {
  if (level <= 1) return "first_subscription";
  if (level === 2) return "renewal_2";
  if (level === 3) return "renewal_3";
  return "renewal_n";
}

function byTime(a: Transaction, b: Transaction): number {
  if (a.event_time < b.event_time) return -1;
  if (a.event_time > b.event_time) return 1;
  return a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : 0;
}

function cohortDateForUser(sorted: Transaction[]): string | null {
  const firstTrial = sorted.find((t) => t.transaction_type === "trial" && t.status === "success");
  if (firstTrial) return firstTrial.cohort_date ?? firstTrial.event_time.slice(0, 10);
  return sorted[0]?.event_time.slice(0, 10) ?? null;
}

function declineReasonForTx(tx: Transaction): DeclineReason {
  return tx.normalized_decline_reason ?? declineDetailsForTransaction(tx)?.reason ?? "unknown";
}

function classifyUserAttempts(userTxs: Transaction[]): PaymentAttempt[] {
  const sorted = [...userTxs].sort(byTime);
  // Canonical subscription levels — the SAME map Cohorts / Export use (subscription-sequence types
  // only, trial excluded, level = timestamp position). This guarantees the First Subscription /
  // Renewal buckets reconcile exactly with the Cohorts page.
  const levelByTx = subscriptionLevelByPaymentForUser(sorted);
  const country = countryCodeForUserTransactions(sorted) ?? "unknown";
  const cardType = cardTypeForUserTransactions(sorted);
  const { media_buyer } = mediaBuyerForUserTransactions(sorted);
  const cohort_date = cohortDateForUser(sorted);
  const userId = sorted.find((t) => t.user_id)?.user_id ?? "unknown";

  // Funnel / campaign are attributed at the USER (cohort) level — from the user's entry transaction
  // (first successful trial, falling back to first success, then first row) — EXACTLY like the
  // Cohorts page. Rebill / subscription rows frequently carry no funnel/campaign of their own, so
  // attributing per-transaction would drop them from a funnel filter (the First Sub undercount bug).
  const entryTx =
    sorted.find((t) => t.transaction_type === "trial" && t.status === "success") ??
    sorted.find((t) => t.status === "success") ??
    sorted[0];
  const funnel = entryTx?.funnel || "unknown";
  const campaignPath = entryTx?.campaign_path || "unknown";
  const campaignId = entryTx?.campaign_id || "unknown";

  const attempts: PaymentAttempt[] = [];
  let seqSuccessLevel = 0; // highest canonical subscription level reached by a SUCCESS so far
  let hasEntrySuccess = false; // a successful trial/entry payment was seen
  let firstAttemptSeen = false;

  for (const tx of sorted) {
    const success = isSuccessfulAttempt(tx);
    const failed = !success && isFailedAttempt(tx);
    if (!success && !failed) continue;

    const isUpsell = tx.transaction_type === "upsell";
    const canonicalLevel = levelByTx.get(tx); // defined only for successful sequence payments
    let stage: PaymentStage;
    let subscriptionLevel: number | null = null;

    if (isUpsell) {
      stage = "upsell";
    } else if (success) {
      if (tx.transaction_type === "trial") {
        stage = "trial_or_entry";
      } else if (canonicalLevel !== undefined) {
        subscriptionLevel = canonicalLevel;
        stage = stageFromLevel(canonicalLevel);
      } else {
        // Successful payment that isn't a recognised lifecycle type (rare on classified data).
        // It still counts toward the overall pass rate, but is not bucketed into a sub stage.
        stage = "unknown";
      }
    } else {
      // Failed attempt: staged by how far the user got in their SUCCESSFUL lifecycle, mirroring
      // classifyDeclineStagesForTransactions (after_trial → First Sub attempt, etc.).
      if (seqSuccessLevel >= 1) {
        subscriptionLevel = seqSuccessLevel + 1; // the rebill they were attempting
        stage = stageFromLevel(subscriptionLevel);
      } else if (hasEntrySuccess) {
        subscriptionLevel = 1; // failed first subscription after a successful trial/entry
        stage = "first_subscription";
      } else {
        stage = "trial_or_entry"; // failed entry charge (before any success)
      }
    }

    const isFirstAttempt = !firstAttemptSeen;
    firstAttemptSeen = true;

    attempts.push({
      transaction_id: tx.transaction_id,
      user_id: userId,
      email: tx.email,
      event_time: tx.event_time,
      event_date: tx.event_time.slice(0, 10),
      cohort_date,
      amount_usd: tx.amount_usd,
      is_success: success,
      is_failed: failed,
      is_first_attempt: isFirstAttempt,
      stage,
      subscription_level: subscriptionLevel,
      transaction_type: tx.transaction_type,
      decline_reason: failed ? declineReasonForTx(tx) : null,
      funnel,
      campaign_path: campaignPath,
      campaign_id: campaignId,
      country,
      card_type: cardType,
      media_buyer,
    });

    // Advance lifecycle counters AFTER classifying the current attempt.
    if (success) {
      if (tx.transaction_type === "trial") hasEntrySuccess = true;
      if (canonicalLevel !== undefined) seqSuccessLevel = canonicalLevel;
    }
  }

  return attempts;
}

/** Build the flat attempt list for the whole transaction set (deduped, user-scoped staging). */
export function buildPaymentAttempts(txs: Transaction[]): PaymentAttempt[] {
  const deduped = dedupeTransactionsForAnalytics(txs);
  const byUser = new Map<string, Transaction[]>();
  for (const tx of deduped) {
    const key = tx.user_id || tx.email || tx.transaction_id;
    const list = byUser.get(key) ?? [];
    list.push(tx);
    byUser.set(key, list);
  }
  const attempts: PaymentAttempt[] = [];
  byUser.forEach((list) => attempts.push(...classifyUserAttempts(list)));
  return attempts;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Canonical normalized decline reason for "not enough money on the card". Every raw variant
 * (INSUFFICIENT_FUNDS, code 51, over_credit_limit, not_enough_funds, card_insufficient_funds, …) is
 * already collapsed to this value by normalizeDeclineReason(), so matching on it is source-agnostic.
 */
export const INSUFFICIENT_FUNDS_REASON: DeclineReason = "insufficient_funds";

interface MutableAgg {
  attempts: number;
  successful: number;
  failed: number;
  userIds: Set<string>;
  successUserIds: Set<string>;
  failedUserIds: Set<string>;
  firstAttempts: number;
  firstSuccess: number;
  firstSubAttempts: number;
  firstSubSuccess: number;
  renewalAttempts: number;
  renewalSuccess: number;
  insufficientFundsFailures: number;
  declineUsers: Map<DeclineReason, Set<string>>;
}

function emptyAgg(): MutableAgg {
  return {
    attempts: 0,
    successful: 0,
    failed: 0,
    userIds: new Set(),
    successUserIds: new Set(),
    failedUserIds: new Set(),
    firstAttempts: 0,
    firstSuccess: 0,
    firstSubAttempts: 0,
    firstSubSuccess: 0,
    renewalAttempts: 0,
    renewalSuccess: 0,
    insufficientFundsFailures: 0,
    declineUsers: new Map(),
  };
}

function addToAgg(agg: MutableAgg, a: PaymentAttempt): void {
  agg.attempts += 1;
  agg.userIds.add(a.user_id);
  if (a.is_success) {
    agg.successful += 1;
    agg.successUserIds.add(a.user_id);
  }
  if (a.is_failed) {
    agg.failed += 1;
    agg.failedUserIds.add(a.user_id);
    if (a.decline_reason === INSUFFICIENT_FUNDS_REASON) agg.insufficientFundsFailures += 1;
    if (a.decline_reason) {
      const set = agg.declineUsers.get(a.decline_reason) ?? new Set<string>();
      set.add(a.user_id);
      agg.declineUsers.set(a.decline_reason, set);
    }
  }
  if (a.is_first_attempt) {
    agg.firstAttempts += 1;
    if (a.is_success) agg.firstSuccess += 1;
  }
  if (a.subscription_level === 1) {
    agg.firstSubAttempts += 1;
    if (a.is_success) agg.firstSubSuccess += 1;
  }
  if (a.subscription_level != null && a.subscription_level >= 2) {
    agg.renewalAttempts += 1;
    if (a.is_success) agg.renewalSuccess += 1;
  }
}

export function passRate(successful: number, attempts: number): number {
  return attempts > 0 ? successful / attempts : 0;
}

function topDecline(declineUsers: Map<DeclineReason, Set<string>>): { reason: DeclineReason | null; users: number } {
  let reason: DeclineReason | null = null;
  let users = 0;
  declineUsers.forEach((set, key) => {
    if (set.size > users) {
      users = set.size;
      reason = key;
    }
  });
  return { reason, users };
}

function finalizeAgg(agg: MutableAgg): PassMetrics {
  const top = topDecline(agg.declineUsers);
  return {
    attempts: agg.attempts,
    successful: agg.successful,
    failed: agg.failed,
    pass_rate: passRate(agg.successful, agg.attempts),
    users_with_attempts: agg.userIds.size,
    users_with_success: agg.successUserIds.size,
    user_pass_rate: passRate(agg.successUserIds.size, agg.userIds.size),
    failed_users: agg.failedUserIds.size,
    first_attempts: agg.firstAttempts,
    first_success: agg.firstSuccess,
    first_attempt_pass_rate: passRate(agg.firstSuccess, agg.firstAttempts),
    first_sub_attempts: agg.firstSubAttempts,
    first_sub_success: agg.firstSubSuccess,
    first_sub_pass_rate: passRate(agg.firstSubSuccess, agg.firstSubAttempts),
    renewal_attempts: agg.renewalAttempts,
    renewal_success: agg.renewalSuccess,
    renewal_pass_rate: passRate(agg.renewalSuccess, agg.renewalAttempts),
    top_decline_reason: top.reason,
    top_decline_reason_users: top.users,
    insufficient_funds_failures: agg.insufficientFundsFailures,
    eligible_attempts_ex_if: agg.attempts - agg.insufficientFundsFailures,
    pass_rate_ex_if: passRate(agg.successful, agg.attempts - agg.insufficientFundsFailures),
  };
}

/** Single roll-up across all attempts (Summary cards). */
export function summarizePaymentAttempts(attempts: PaymentAttempt[]): PassMetrics {
  const agg = emptyAgg();
  for (const a of attempts) addToAgg(agg, a);
  return finalizeAgg(agg);
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

function dimensionKeyLabel(a: PaymentAttempt, dim: SegmentDimension): { key: string; label: string } {
  switch (dim) {
    case "funnel":
      return { key: a.funnel, label: a.funnel };
    case "campaign_path":
      return { key: a.campaign_path, label: a.campaign_path };
    case "campaign_id":
      return { key: a.campaign_id, label: a.campaign_id };
    case "media_buyer":
      return { key: a.media_buyer, label: a.media_buyer };
    case "country":
      return { key: a.country, label: a.country };
    case "card_type":
      return { key: a.card_type, label: a.card_type };
    case "stage":
      return { key: a.stage, label: PAYMENT_STAGE_LABELS[a.stage] };
    case "decline_reason": {
      const key = a.decline_reason ?? "none";
      return { key, label: a.decline_reason ? DECLINE_REASON_LABELS[a.decline_reason] : "Successful / no decline" };
    }
    default:
      return { key: "unknown", label: "Unknown" };
  }
}

/** Group attempts by a dimension and finalize pass metrics per segment, sorted by attempts desc. */
export function groupPaymentAttempts(attempts: PaymentAttempt[], dim: SegmentDimension): SegmentRow[] {
  const groups = new Map<string, { label: string; agg: MutableAgg }>();
  for (const a of attempts) {
    const { key, label } = dimensionKeyLabel(a, dim);
    const entry = groups.get(key) ?? { label, agg: emptyAgg() };
    addToAgg(entry.agg, a);
    groups.set(key, entry);
  }
  return Array.from(groups.entries())
    .map(([key, { label, agg }]) => ({ key, label, ...finalizeAgg(agg) }))
    .sort((a, b) => b.attempts - a.attempts || a.label.localeCompare(b.label));
}

// ---------------------------------------------------------------------------
// Stage breakdown (Phase 4C) — includes synthetic "First Transaction" row
// ---------------------------------------------------------------------------

export interface StageRow extends PassMetrics {
  stage: PaymentStage | "first_transaction";
  label: string;
}

export function paymentStageBreakdown(attempts: PaymentAttempt[]): StageRow[] {
  const rows: StageRow[] = [];

  // Synthetic "First Transaction" lens: the user's very first attempt regardless of stage.
  const firstAgg = emptyAgg();
  for (const a of attempts) if (a.is_first_attempt) addToAgg(firstAgg, a);
  rows.push({ stage: "first_transaction", label: "First Transaction", ...finalizeAgg(firstAgg) });

  for (const stage of STAGE_BREAKDOWN_ORDER) {
    const agg = emptyAgg();
    for (const a of attempts) if (a.stage === stage) addToAgg(agg, a);
    rows.push({ stage, label: PAYMENT_STAGE_LABELS[stage], ...finalizeAgg(agg) });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// First Transaction analytics (Phase 6)
// ---------------------------------------------------------------------------

export function firstAttemptAttempts(attempts: PaymentAttempt[]): PaymentAttempt[] {
  return attempts.filter((a) => a.is_first_attempt);
}

export function firstTransactionBreakdown(attempts: PaymentAttempt[], dim: SegmentDimension): SegmentRow[] {
  return groupPaymentAttempts(firstAttemptAttempts(attempts), dim);
}

// ---------------------------------------------------------------------------
// Renewal / rebill analytics (Phase 7)
// ---------------------------------------------------------------------------

export interface RenewalStageRow extends PassMetrics {
  level: number; // 1 = First Subscription
  label: string;
}

const RENEWAL_LEVEL_LABELS: Record<number, string> = {
  1: "First Subscription",
  2: "Renewal 2",
  3: "Renewal 3",
  4: "Renewal 4",
  5: "Renewal 5",
};

function renewalLevelLabel(level: number): string {
  return RENEWAL_LEVEL_LABELS[level] ?? "Renewal 6+";
}

/** Bucket subscription attempts by canonical level (6+ collapsed). */
export function renewalBreakdown(attempts: PaymentAttempt[]): RenewalStageRow[] {
  const byBucket = new Map<number, MutableAgg>();
  for (const a of attempts) {
    if (a.subscription_level == null) continue;
    const bucket = a.subscription_level >= 6 ? 6 : a.subscription_level;
    const agg = byBucket.get(bucket) ?? emptyAgg();
    addToAgg(agg, a);
    byBucket.set(bucket, agg);
  }
  return Array.from(byBucket.entries())
    .map(([level, agg]) => ({ level, label: renewalLevelLabel(level), ...finalizeAgg(agg) }))
    .sort((a, b) => a.level - b.level);
}

/** Attempts that belong to the subscription/renewal lifecycle (for segment breakdowns). */
export function renewalAttempts(attempts: PaymentAttempt[]): PaymentAttempt[] {
  return attempts.filter((a) => a.subscription_level != null);
}

// ---------------------------------------------------------------------------
// Decline reason analytics (Phase 8)
// ---------------------------------------------------------------------------

function mode<T>(values: T[]): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) ?? 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

export function declineReasonAnalytics(attempts: PaymentAttempt[]): DeclineReasonRow[] {
  const failed = attempts.filter((a) => a.is_failed && a.decline_reason);
  const totalFailed = failed.length;
  const byReason = new Map<DeclineReason, PaymentAttempt[]>();
  for (const a of failed) {
    const reason = a.decline_reason as DeclineReason;
    const list = byReason.get(reason) ?? [];
    list.push(a);
    byReason.set(reason, list);
  }

  return Array.from(byReason.entries())
    .map(([reason, list]) => ({
      reason,
      label: DECLINE_REASON_LABELS[reason],
      failed_attempts: list.length,
      failed_users: new Set(list.map((a) => a.user_id)).size,
      share_of_failed: totalFailed > 0 ? list.length / totalFailed : 0,
      affected_funnels: Array.from(new Set(list.map((a) => a.funnel))).sort(),
      most_common_stage: mode(list.map((a) => a.stage)),
      most_common_card_type: mode(list.map((a) => a.card_type)),
      most_common_country: mode(list.map((a) => a.country)),
    }))
    .sort((a, b) => b.failed_attempts - a.failed_attempts);
}

// ---------------------------------------------------------------------------
// Pass rate over time (Phase 9)
// ---------------------------------------------------------------------------

export function passRateByDay(attempts: PaymentAttempt[]): PassRatePoint[] {
  const byDay = new Map<string, { attempts: number; successful: number; failed: number }>();
  for (const a of attempts) {
    const entry = byDay.get(a.event_date) ?? { attempts: 0, successful: 0, failed: 0 };
    entry.attempts += 1;
    if (a.is_success) entry.successful += 1;
    if (a.is_failed) entry.failed += 1;
    byDay.set(a.event_date, entry);
  }
  return Array.from(byDay.entries())
    .map(([date, v]) => ({ date, ...v, pass_rate: passRate(v.successful, v.attempts) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}
