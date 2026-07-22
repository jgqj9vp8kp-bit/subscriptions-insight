import type { CardType, CohortRow, MediaBuyer, PlanBreakdownRow, Transaction, UserAggregate } from "./serviceTypes.ts";
import type { SubscriptionClean } from "./subscriptionTypes.ts";
import { isSubscriptionActiveNow } from "./subscriptionTransform.ts";
import { countryCodeForUserTransactions, normalizeCountryCode } from "./userCountry.ts";
import { CARD_TYPE_VALUES, cardTypeForUserTransactions } from "./userCardType.ts";
import { mediaBuyerForUserTransactions } from "./userMediaBuyer.ts";
import { splitMediaBuyerSelections, userMatchesMediaBuyerSelection, type MediaBuyerSelectionSplit } from "./mediaBuyerSelection.ts";
import { failedPaymentStateForUserTransactions } from "./paymentFailures.ts";
import { buildCohortId } from "./cohortIdentity.ts";
import {
  DEFAULT_MAX_RENEWAL_COLUMNS,
  MAX_SUPPORTED_RENEWAL_COLUMNS,
  sanitizeMaxRenewalColumns,
} from "./renewalColumns.ts";
import {
  addTokenPurchaseToPacks,
  addUnknownProduct,
  createTokenPackAccumulator,
  createUnknownProductAccumulator,
  finalizeTokenPacks,
  finalizeUnknownProducts,
  hasAddonMarker,
  hasUpsellMarker,
  isTokenPurchaseTransaction,
  type UnknownProductRow,
} from "./monetization.ts";
import { APP_ADDON_WINDOW_HOURS } from "./monetizationProductMap.ts";
import {
  normalizeTransactionsToUsd,
  type FxNormalizationDiagnostics,
} from "./currencyNormalization.ts";
import type { CohortCurrencyBreakdownRow } from "./serviceTypes.ts";

const DAY = 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_RENEWAL_DEPTH = DEFAULT_MAX_RENEWAL_COLUMNS;
const STATIC_RENEWAL_LEVELS = [2, 3, 4, 5, 6] as const;
type StaticRenewalLevel = (typeof STATIC_RENEWAL_LEVELS)[number];
const RENEWAL_USER_FIELD_BY_LEVEL: Record<StaticRenewalLevel, "renewal_2_users" | "renewal_3_users" | "renewal_4_users" | "renewal_5_users" | "renewal_6_users"> = {
  2: "renewal_2_users",
  3: "renewal_3_users",
  4: "renewal_4_users",
  5: "renewal_5_users",
  6: "renewal_6_users",
};
type StaticRenewalCounts = Record<(typeof RENEWAL_USER_FIELD_BY_LEVEL)[StaticRenewalLevel], number>;

/** Money sums should ignore failed_payment rows (they were never collected). */
const isMoneyMoving = (t: Transaction) => t.status !== "failed";
const isRenewalType = (t: Transaction) =>
  t.transaction_type === "renewal_2" || t.transaction_type === "renewal_3" || t.transaction_type === "renewal";
const isSubscriptionSequencePayment = (t: Transaction) =>
  t.status === "success" && (t.transaction_type === "first_subscription" || isRenewalType(t));
const grossAmount = (t: Transaction) => t.gross_amount_usd ?? (t.amount_usd > 0 ? t.amount_usd : 0);
const refundAmount = (t: Transaction) => t.refund_amount_usd ?? (t.amount_usd < 0 ? Math.abs(t.amount_usd) : 0);
const netAmount = (t: Transaction) => t.net_amount_usd ?? grossAmount(t) - refundAmount(t);
const dashboardRevenueAmount = (t: Transaction) => {
  if (typeof t.net_amount_usd === "number") return t.net_amount_usd;
  if (typeof t.refund_amount_usd === "number") return t.amount_usd - t.refund_amount_usd;
  return t.amount_usd;
};
const PLAN_ASSIGNMENT_REASON = "Plan assigned from first successful non-upsell transaction";
const CANCELLATION_FAILURE_WINDOW_MS = 48 * 60 * 60 * 1000;
const FAILED_STATUS_TOKENS = [
  "DECLINED",
  "FAILED",
  "AUTHORIZATION_FAILED",
  "AUTHORIZATION_DECLINED",
  "ERROR",
];
const initialPlanTransactionForUser = (txs: Transaction[]) =>
  [...txs]
    .sort((a, b) => (a.event_time < b.event_time ? -1 : 1))
    // Token packs are add-on purchases, never a price plan.
    .find((t) => t.status === "success" && t.transaction_type !== "upsell" && t.transaction_type !== "token_purchase");
const planNameFromPrice = (price: number | null) => (price == null ? "Unknown" : formatCurrency(price));
const normalizeEmailKey = (email: string | null | undefined) => email?.trim().toLowerCase() || "";
const transactionDay = (t: Transaction, daysFromCohort: number) =>
  typeof t.transaction_day === "number" ? t.transaction_day : Math.floor(daysFromCohort);
const transactionTypePriority = (type: string) => {
  if (type === "trial") return 0;
  if (type === "upsell") return 1;
  if (type === "first_subscription") return 2;
  if (type === "renewal_2" || type === "renewal_3" || type === "renewal") return 3;
  return 4;
};
const transactionSortKey = (tx: Transaction) =>
  `${tx.event_time}|${String(transactionTypePriority(tx.transaction_type)).padStart(2, "0")}|${tx.transaction_id}`;
const transactionDedupeKey = (tx: Transaction) => {
  const id = tx.transaction_id?.trim();
  if (id) return `id:${id}`;
  const email = tx.email?.trim().toLowerCase() ?? "";
  const amount = grossAmount(tx).toFixed(2);
  return `fallback:${email}|${amount}|${tx.event_time}`;
};

export function dedupeTransactionsForAnalytics(txs: Transaction[]): Transaction[] {
  const byKey = new Map<string, Transaction>();
  for (const tx of txs) {
    byKey.set(transactionDedupeKey(tx), tx);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const aKey = transactionSortKey(a);
    const bKey = transactionSortKey(b);
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

interface MutablePlanBreakdown {
  price: number;
  trial_users: number;
  active_users: number;
  active_subscriptions: number;
  cancelled_users: number;
  user_cancelled_users: number;
  auto_cancelled_users: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_2_users: number;
  renewal_3_users: number;
  renewal_4_users: number;
  renewal_5_users: number;
  renewal_6_users: number;
  renewal_users_by_level: Record<number, number>;
  renewal_users: number;
  refund_users: number;
  gross_revenue: number;
  amount_refunded: number;
  net_revenue: number;
  revenue_d0: number;
  revenue_d7: number;
  revenue_d30: number;
  revenue_d60: number;
  first_subscription_revenue: number;
}

function createPlanBreakdown(price: number): MutablePlanBreakdown {
  return {
    price,
    trial_users: 0,
    active_users: 0,
    active_subscriptions: 0,
    cancelled_users: 0,
    user_cancelled_users: 0,
    auto_cancelled_users: 0,
    upsell_users: 0,
    first_subscription_users: 0,
    renewal_2_users: 0,
    renewal_3_users: 0,
    renewal_4_users: 0,
    renewal_5_users: 0,
    renewal_6_users: 0,
    renewal_users_by_level: {},
    renewal_users: 0,
    refund_users: 0,
    gross_revenue: 0,
    amount_refunded: 0,
    net_revenue: 0,
    revenue_d0: 0,
    revenue_d7: 0,
    revenue_d30: 0,
    revenue_d60: 0,
    first_subscription_revenue: 0,
  };
}

function finalizePlanBreakdown(row: MutablePlanBreakdown): PlanBreakdownRow {
  const netRevenue = row.gross_revenue - row.amount_refunded;

  return {
    price: row.price,
    trial_users: row.trial_users,
    active_users: row.active_users,
    active_rate: row.trial_users ? (row.active_users / row.trial_users) * 100 : 0,
    active_subscriptions: row.active_subscriptions,
    active_subscriptions_rate: row.trial_users ? (row.active_subscriptions / row.trial_users) * 100 : 0,
    cancelled_users: row.cancelled_users,
    cancellation_rate: row.trial_users ? (row.cancelled_users / row.trial_users) * 100 : 0,
    user_cancelled_users: row.user_cancelled_users,
    user_cancel_rate: row.trial_users ? (row.user_cancelled_users / row.trial_users) * 100 : 0,
    auto_cancelled_users: row.auto_cancelled_users,
    auto_cancel_rate: row.trial_users ? (row.auto_cancelled_users / row.trial_users) * 100 : 0,
    upsell_users: row.upsell_users,
    first_subscription_users: row.first_subscription_users,
    renewal_2_users: row.renewal_2_users,
    renewal_3_users: row.renewal_3_users,
    renewal_4_users: row.renewal_4_users,
    renewal_5_users: row.renewal_5_users,
    renewal_6_users: row.renewal_6_users,
    renewal_users_by_level: { ...row.renewal_users_by_level },
    renewal_users: row.renewal_users,
    refund_users: row.refund_users,
    trial_to_upsell_cr: row.trial_users ? (row.upsell_users / row.trial_users) * 100 : 0,
    trial_to_first_subscription_cr: row.trial_users ? (row.first_subscription_users / row.trial_users) * 100 : 0,
    first_subscription_to_renewal_2_cr: row.first_subscription_users ? (row.renewal_2_users / row.first_subscription_users) * 100 : 0,
    renewal_2_to_renewal_3_cr: row.renewal_2_users ? (row.renewal_3_users / row.renewal_2_users) * 100 : 0,
    renewal_3_to_renewal_4_cr: row.renewal_3_users ? (row.renewal_4_users / row.renewal_3_users) * 100 : 0,
    renewal_4_to_renewal_5_cr: row.renewal_4_users ? (row.renewal_5_users / row.renewal_4_users) * 100 : 0,
    renewal_5_to_renewal_6_cr: row.renewal_5_users ? (row.renewal_6_users / row.renewal_5_users) * 100 : 0,
    refund_rate: row.trial_users ? (row.refund_users / row.trial_users) * 100 : 0,
    gross_revenue: round2(row.gross_revenue),
    amount_refunded: round2(row.amount_refunded),
    net_revenue: round2(netRevenue),
    revenue_d0: round2(row.revenue_d0),
    revenue_d7: round2(row.revenue_d7),
    revenue_d30: round2(row.revenue_d30),
    revenue_d60: round2(row.revenue_d60),
    net_ltv: row.trial_users ? round2(netRevenue / row.trial_users) : 0,
  };
}

export interface Kpis {
  totalRevenue: number;
  trialPayments: number;
  upsellRevenue: number;
  firstSubscriptionRevenue: number;
  renewalRevenue: number;
  trialToUpsellCR: number;
  trialToFirstSubscriptionCR: number;
  averageLtv: number;
}

export interface ComputeCohortsOptions {
  maxRenewalDepth?: number;
  selectedCountries?: string[];
  selectedCardTypes?: CardType[];
  /** Media buyer names and/or "utm:<value>" selections (one dropdown, union). */
  selectedMediaBuyers?: Array<MediaBuyer | string>;
  /** Filter users by the ORIGINAL currency of their trial charge (e.g. ["MXN"]). */
  selectedCurrencies?: string[];
  /** Reference "now" (ms) for currently-active subscription metrics. Defaults to Date.now() once per call. */
  now?: number;
}

/**
 * Active subscription_ids grouped by normalized email, computed once against a
 * single `nowMs`. Active Users and Active Subscriptions are BOTH derived from
 * this one set: a user is active iff their email owns >=1 active subscription,
 * and Active Subscriptions counts the unique subscription_ids. Subscriptions
 * are deduped by subscription_id so a resynced duplicate cannot inflate.
 */
function activeSubscriptionIdsByEmail(
  subscriptions: SubscriptionClean[],
  nowMs: number,
): Map<string, Set<string>> {
  const byEmail = new Map<string, Set<string>>();
  const seenSubIds = new Set<string>();
  for (const sub of subscriptions) {
    if (!isSubscriptionActiveNow(sub, nowMs)) continue;
    const email = normalizeEmailKey(sub.email);
    if (!email) continue; // no email → cannot attribute to a warehouse cohort user
    const subId = sub.subscription_id?.trim();
    if (!subId || seenSubIds.has(subId)) continue; // dedup by subscription_id
    seenSubIds.add(subId);
    const set = byEmail.get(email) ?? new Set<string>();
    set.add(subId);
    byEmail.set(email, set);
  }
  return byEmail;
}

/** Original charge currency of the user's first successful trial (fallback: first transaction). */
export function currencyForUserTransactions(txs: Transaction[]): string | null {
  const sorted = [...txs].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
  const trial = sorted.find((t) => t.status === "success" && t.transaction_type === "trial");
  const source = trial ?? sorted[0];
  if (!source) return null;
  const currency = String(source.original_currency ?? source.currency ?? "").trim().toUpperCase();
  return currency || null;
}

function normalizeCountryFilter(countries: unknown): Set<string> {
  if (!Array.isArray(countries)) return new Set();
  return new Set(countries.flatMap((country) => {
    const normalized = normalizeCountryCode(country);
    return normalized ? [normalized] : [];
  }));
}

function normalizeCardTypeFilter(cardTypes: unknown): Set<CardType> {
  if (!Array.isArray(cardTypes)) return new Set();
  return new Set(cardTypes.filter((value): value is CardType => CARD_TYPE_VALUES.includes(value as CardType)));
}

function normalizeMediaBuyerFilter(mediaBuyers: unknown): MediaBuyerSelectionSplit {
  if (!Array.isArray(mediaBuyers)) return { buyers: [], utms: [] };
  return splitMediaBuyerSelections(mediaBuyers);
}

export function computeKpis(txs: Transaction[]): Kpis {
  // KPI revenue is calculated from normalized/classified transactions.
  // Failed payments are excluded because no money was collected.
  const money = txs.filter(isMoneyMoving);
  const sumByType = (type: string) =>
    money.filter((t) => t.transaction_type === type).reduce((s, t) => s + dashboardRevenueAmount(t), 0);

  const totalRevenue = money.reduce((s, t) => s + dashboardRevenueAmount(t), 0);
  const trialPayments = sumByType("trial");
  const upsellRevenue = sumByType("upsell");
  const firstSubscriptionRevenue = sumByType("first_subscription");
  const renewalRevenue = money.filter(isRenewalType).reduce((s, t) => s + dashboardRevenueAmount(t), 0);

  const trialUsers = new Set(txs.filter((t) => t.transaction_type === "trial" && t.status === "success").map((t) => t.user_id));
  const upsellUsers = new Set(txs.filter((t) => t.transaction_type === "upsell" && t.status === "success").map((t) => t.user_id));
  const firstSubUsers = new Set(txs.filter((t) => t.transaction_type === "first_subscription" && t.status === "success").map((t) => t.user_id));

  const trialCount = trialUsers.size || 1;
  const trialToUpsellCR = (countIntersection(trialUsers, upsellUsers) / trialCount) * 100;
  const trialToFirstSubscriptionCR = (countIntersection(trialUsers, firstSubUsers) / trialCount) * 100;

  const users = computeUsers(txs);
  const averageLtv = users.length ? users.reduce((s, u) => s + u.user_ltv, 0) / users.length : 0;

  return {
    totalRevenue,
    trialPayments,
    upsellRevenue,
    firstSubscriptionRevenue,
    renewalRevenue,
    trialToUpsellCR,
    trialToFirstSubscriptionCR,
    averageLtv,
  };
}

function countIntersection(a: Set<string>, b: Set<string>) {
  let n = 0;
  a.forEach((id) => {
    if (b.has(id)) n += 1;
  });
  return n;
}

export interface DailyRevenuePoint {
  date: string; // YYYY-MM-DD
  revenue: number;
}

export function revenueByDay(txs: Transaction[]): DailyRevenuePoint[] {
  // Calendar revenue chart still groups by transaction event date, unlike
  // cohorts which group by trial timestamp.
  const map = new Map<string, number>();
  for (const t of txs) {
    if (!isMoneyMoving(t)) continue;
    const date = t.event_time.slice(0, 10);
    map.set(date, (map.get(date) ?? 0) + dashboardRevenueAmount(t));
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, revenue]) => ({ date, revenue: Math.round(revenue * 100) / 100 }));
}

export interface RevenueByTypePoint {
  type: string;
  revenue: number;
}

export function revenueByType(txs: Transaction[]): RevenueByTypePoint[] {
  const map = new Map<string, number>();
  for (const t of txs) {
    if (!isMoneyMoving(t)) continue;
    map.set(t.transaction_type, (map.get(t.transaction_type) ?? 0) + dashboardRevenueAmount(t));
  }
  return Array.from(map.entries()).map(([type, revenue]) => ({
    type,
    revenue: Math.round(revenue * 100) / 100,
  }));
}

export interface FunnelRevenuePoint {
  funnel: string;
  trial: number;
  upsell: number;
  first_subscription: number;
  renewal_2: number;
  renewal_3: number;
  renewal: number;
}

export function revenueByFunnel(txs: Transaction[]): FunnelRevenuePoint[] {
  const funnels = new Map<string, FunnelRevenuePoint>();
  for (const t of txs) {
    if (!isMoneyMoving(t)) continue;
    const row = funnels.get(t.funnel) ?? {
      funnel: t.funnel,
      trial: 0,
      upsell: 0,
      first_subscription: 0,
      renewal_2: 0,
      renewal_3: 0,
      renewal: 0,
    };
    const revenue = dashboardRevenueAmount(t);
    if (t.transaction_type === "trial") row.trial += revenue;
    if (t.transaction_type === "upsell") row.upsell += revenue;
    if (t.transaction_type === "first_subscription") row.first_subscription += revenue;
    if (t.transaction_type === "renewal_2") row.renewal_2 += revenue;
    if (t.transaction_type === "renewal_3") row.renewal_3 += revenue;
    if (t.transaction_type === "renewal") row.renewal += revenue;
    funnels.set(t.funnel, row);
  }
  return Array.from(funnels.values());
}

export interface FunnelStep {
  step: string;
  users: number;
  conversion: number; // % of trial
}

export function trialFunnel(txs: Transaction[]): FunnelStep[] {
  const succ = txs.filter((t) => t.status === "success");
  const trial = new Set(succ.filter((t) => t.transaction_type === "trial").map((t) => t.user_id));
  const upsell = new Set(succ.filter((t) => t.transaction_type === "upsell").map((t) => t.user_id));
  const sub = new Set(succ.filter((t) => t.transaction_type === "first_subscription").map((t) => t.user_id));
  const trialN = trial.size || 1;
  return [
    { step: "Trial", users: trial.size, conversion: 100 },
    { step: "Upsell", users: countIntersection(trial, upsell), conversion: (countIntersection(trial, upsell) / trialN) * 100 },
    { step: "First Subscription", users: countIntersection(trial, sub), conversion: (countIntersection(trial, sub) / trialN) * 100 },
  ];
}

export function computeUsers(txs: Transaction[]): UserAggregate[] {
  // User aggregates are derived from the same transaction_type names used by
  // the classifier: trial, upsell, first_subscription, renewal_2, renewal_3, renewal.
  const byUser = new Map<string, Transaction[]>();
  for (const t of txs) {
    const list = byUser.get(t.user_id) ?? [];
    list.push(t);
    byUser.set(t.user_id, list);
  }

  return Array.from(byUser.entries())
    .map(([user_id, list]) => {
      const sorted = [...list].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
      const trial = sorted.find((t) => t.transaction_type === "trial");
      const initialPlanTransaction = initialPlanTransactionForUser(sorted);
      const planPrice = initialPlanTransaction ? round2(initialPlanTransaction.amount_usd) : null;
      const money = sorted.filter(isMoneyMoving);
      const total_revenue = money.reduce((s, t) => s + netAmount(t), 0);
      const total_refund_usd = sorted.reduce((s, t) => s + refundAmount(t), 0);
      const failedPaymentState = failedPaymentStateForUserTransactions(sorted);
      const mediaBuyer = mediaBuyerForUserTransactions(sorted);
      return {
        user_id,
        email: sorted.find((t) => t.email)?.email || "",
        country_code: countryCodeForUserTransactions(sorted),
        card_type: cardTypeForUserTransactions(sorted),
        utm_source: mediaBuyer.utm_source,
        media_buyer: mediaBuyer.media_buyer,
        funnel: sorted[0].funnel,
        first_trial_date: trial ? trial.event_time : null,
        plan_price: planPrice,
        plan_name: planNameFromPrice(planPrice),
        plan_assignment_reason: initialPlanTransaction ? PLAN_ASSIGNMENT_REASON : null,
        total_revenue: Math.round(total_revenue * 100) / 100,
        has_upsell: sorted.some((t) => t.transaction_type === "upsell" && t.status === "success"),
        has_first_subscription: sorted.some((t) => t.transaction_type === "first_subscription" && t.status === "success"),
        has_refund: total_refund_usd > 0,
        total_refund_usd: Math.round(total_refund_usd * 100) / 100,
        renewal_count: sorted.filter((t) => isRenewalType(t) && t.status === "success").length,
        user_ltv: Math.round(total_revenue * 100) / 100,
        ...failedPaymentState,
      } satisfies UserAggregate;
    })
    .sort((a, b) => b.total_revenue - a.total_revenue);
}

// Active Users / Active Subscriptions no longer live here — they are derived
// from the injected-now active-subscription set. These flags feed only the
// cancellation metrics (Cancelled / Cancelled Active), which are out of scope.
type SubscriptionFlags = {
  cancelled: boolean;
  cancelledActive: boolean;
  userCancel: boolean;
  autoCancel: boolean;
  autoCancelWithFailedTransaction: boolean;
};

type CrossSourceCancellation = {
  type: "user_cancelled" | "auto_cancelled" | "unknown";
  reason:
    | "Failed transaction within 48h before cancellation"
    | "Cancelled after or at period end"
    | "Cancelled before period end without failed transaction"
    | "Missing cancelled_at or period_ends_at";
};

function isFailedOrDeclinedTransaction(tx: Transaction): boolean {
  const haystack = [
    tx.status,
    tx.transaction_type,
    tx.classification_reason,
    tx.billing_reason,
  ].join(" ").toUpperCase();

  return (
    tx.status === "failed" ||
    tx.transaction_type === "failed_payment" ||
    FAILED_STATUS_TOKENS.some((token) => haystack.includes(token))
  );
}

function failedTransactionsByEmail(txs: Transaction[]): Map<string, Transaction[]> {
  const result = new Map<string, Transaction[]>();
  for (const tx of txs) {
    if (!isFailedOrDeclinedTransaction(tx)) continue;
    const email = normalizeEmailKey(tx.email);
    if (!email) continue;
    const list = result.get(email) ?? [];
    list.push(tx);
    result.set(email, list);
  }

  result.forEach((list) => list.sort((a, b) => (a.event_time < b.event_time ? -1 : 1)));
  return result;
}

/**
 * Canonical subscription-payment sequence for a user — the single source of truth for renewal depth.
 *
 * Returns the user's SUCCESSFUL subscription payments (first_subscription + any renewal type) that
 * occur at/after `fromTs` (the cohort trial timestamp), ordered by transaction TIMESTAMP with a
 * deterministic type/id tie-break. Position in this array is the canonical level:
 *   index 0 => First Sub, index 1 => Renewal 2, ..., index N-1 => Renewal N.
 *
 * Ordering is by event_time only — never CSV/import/row order. De-duplicate upstream with
 * dedupeTransactionsForAnalytics so duplicate rows do not inflate depth.
 */
export function subscriptionPaymentSequenceForUser(txs: Transaction[], fromTs = -Infinity): Transaction[] {
  return txs
    .filter((tx) => {
      if (!isSubscriptionSequencePayment(tx)) return false;
      const txMs = new Date(tx.event_time).getTime();
      return Number.isFinite(txMs) && txMs >= fromTs;
    })
    .sort((a, b) => {
      const aKey = transactionSortKey(a);
      const bKey = transactionSortKey(b);
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
}

/** Canonical 1-based subscription level (1 = First Sub, 2 = Renewal 2, ...) keyed by payment. */
export function subscriptionLevelByPaymentForUser(txs: Transaction[], fromTs = -Infinity): Map<Transaction, number> {
  const levels = new Map<Transaction, number>();
  subscriptionPaymentSequenceForUser(txs, fromTs).forEach((tx, index) => levels.set(tx, index + 1));
  return levels;
}

/** Set of canonical levels present for a user, capped at maxRenewalDepth (used for the *_users counts). */
function subscriptionSequenceLevelsForUser(
  list: Transaction[],
  cohortTs: number,
  maxRenewalDepth = DEFAULT_MAX_RENEWAL_DEPTH,
): Set<number> {
  const levels = new Set<number>();
  subscriptionLevelByPaymentForUser(list, cohortTs).forEach((level) => {
    if (level <= maxRenewalDepth) levels.add(level);
  });
  return levels;
}

function renewalLevelsThrough(maxRenewalDepth: number): number[] {
  const max = Math.min(MAX_SUPPORTED_RENEWAL_COLUMNS, Math.max(1, Math.floor(maxRenewalDepth)));
  return Array.from({ length: Math.max(0, max - 1) }, (_, index) => index + 2);
}

function incrementRenewalCountsByLevel(target: Record<number, number>, levels: Set<number>, maxRenewalDepth: number) {
  for (const level of renewalLevelsThrough(maxRenewalDepth)) {
    if (levels.has(level)) target[level] = (target[level] ?? 0) + 1;
  }
}

function createRenewalCountsByLevel(maxRenewalDepth: number): Record<number, number> {
  return Object.fromEntries(renewalLevelsThrough(maxRenewalDepth).map((level) => [level, 0]));
}

function createStaticRenewalCounts(): StaticRenewalCounts {
  return {
    renewal_2_users: 0,
    renewal_3_users: 0,
    renewal_4_users: 0,
    renewal_5_users: 0,
    renewal_6_users: 0,
  };
}

function staticRenewalCountsFromLevels(countsByLevel: Record<number, number>): StaticRenewalCounts {
  const counts = createStaticRenewalCounts();
  for (const level of STATIC_RENEWAL_LEVELS) {
    counts[RENEWAL_USER_FIELD_BY_LEVEL[level]] = countsByLevel[level] ?? 0;
  }
  return counts;
}

function hasFailedTransactionNearCancellation(failedTxs: Transaction[], cancelledAtMs: number): boolean {
  const windowStartMs = cancelledAtMs - CANCELLATION_FAILURE_WINDOW_MS;
  return failedTxs.some((tx) => {
    const txMs = new Date(tx.event_time).getTime();
    return Number.isFinite(txMs) && txMs <= cancelledAtMs && txMs >= windowStartMs;
  });
}

function classifyCancellation(
  sub: SubscriptionClean,
  failedTxs: Transaction[] = [],
): CrossSourceCancellation {
  if (!sub.is_cancelled) {
    return { type: "unknown", reason: "Missing cancelled_at or period_ends_at" };
  }

  const cancelledAtMs = new Date(sub.cancelled_at ?? "").getTime();
  const periodEndsAtMs = new Date(sub.period_ends_at ?? "").getTime();
  if (!Number.isFinite(cancelledAtMs) || !Number.isFinite(periodEndsAtMs)) {
    return { type: "unknown", reason: "Missing cancelled_at or period_ends_at" };
  }

  if (hasFailedTransactionNearCancellation(failedTxs, cancelledAtMs)) {
    return { type: "auto_cancelled", reason: "Failed transaction within 48h before cancellation" };
  }

  if (cancelledAtMs >= periodEndsAtMs) {
    return { type: "auto_cancelled", reason: "Cancelled after or at period end" };
  }

  return { type: "user_cancelled", reason: "Cancelled before period end without failed transaction" };
}

function subscriptionFlagsByEmail(txs: Transaction[], subscriptions: SubscriptionClean[]): Map<string, SubscriptionFlags> {
  const result = new Map<string, SubscriptionFlags>();
  const failuresByEmail = failedTransactionsByEmail(txs);
  for (const sub of subscriptions) {
    const email = normalizeEmailKey(sub.email);
    if (!email) continue;
    const flags = result.get(email) ?? {
      cancelled: false,
      cancelledActive: false,
      userCancel: false,
      autoCancel: false,
      autoCancelWithFailedTransaction: false,
    };
    flags.cancelled = flags.cancelled || sub.is_cancelled;
    flags.cancelledActive = flags.cancelledActive || (sub.is_cancelled && sub.is_active_now);
    const cancellation = classifyCancellation(sub, failuresByEmail.get(email));
    flags.userCancel = flags.userCancel || cancellation.type === "user_cancelled";
    flags.autoCancel = flags.autoCancel || cancellation.type === "auto_cancelled";
    flags.autoCancelWithFailedTransaction =
      flags.autoCancelWithFailedTransaction ||
      (cancellation.type === "auto_cancelled" && cancellation.reason === "Failed transaction within 48h before cancellation");
    result.set(email, flags);
  }
  return result;
}

/** Attribution health of web-app token purchases within the filtered dataset. */
export interface TokenAttributionDiagnostics {
  token_purchases_total: number;
  token_purchases_matched: number;
  token_purchases_matched_by_email: number;
  token_purchases_unmatched: number;
  token_unmatched_amount: number;
}

/** Dataset-level monetization diagnostics (token attribution + unmapped products). */
export interface MonetizationDiagnostics extends TokenAttributionDiagnostics {
  /** Products that need mapping in monetizationProductMap.ts (Phase 8 debug output). */
  unknown_products: UnknownProductRow[];
  /** Gross revenue of explicit one-time/add-on rows that could not be classified. */
  unknown_addon_revenue: number;
}

export interface CohortComputationResult {
  cohorts: CohortRow[];
  tokenDiagnostics: MonetizationDiagnostics;
  fxDiagnostics: FxNormalizationDiagnostics;
}

export function computeCohorts(
  txs: Transaction[],
  subscriptions: SubscriptionClean[] = [],
  options: ComputeCohortsOptions = {},
): CohortRow[] {
  return computeCohortsWithDiagnostics(txs, subscriptions, options).cohorts;
}

const isTokenRelatedTransaction = (t: Transaction) =>
  t.transaction_type === "token_purchase" ||
  ((t.status === "refunded" || t.status === "chargeback") && isTokenPurchaseTransaction(t));

export function computeCohortsWithDiagnostics(
  txs: Transaction[],
  subscriptions: SubscriptionClean[] = [],
  options: ComputeCohortsOptions = {},
): CohortComputationResult {
  // All money fields below this line are USD; original amounts/currencies are
  // preserved per transaction for the currency breakdown.
  const { transactions: usdTxs, diagnostics: fxDiagnostics } = normalizeTransactionsToUsd(txs);
  const analyticsTxs = dedupeTransactionsForAnalytics(usdTxs);
  const selectedCountries = normalizeCountryFilter(options.selectedCountries);
  const selectedCardTypes = normalizeCardTypeFilter(options.selectedCardTypes);
  const selectedMediaBuyers = normalizeMediaBuyerFilter(options.selectedMediaBuyers);
  const selectedCurrencies = new Set(
    (Array.isArray(options.selectedCurrencies) ? options.selectedCurrencies : [])
      .map((currency) => String(currency ?? "").trim().toUpperCase())
      .filter(Boolean),
  );
  const userFilteredIds = new Set<string>();
  const txsByUserForFilters = new Map<string, Transaction[]>();
  const hasUserFilters =
    selectedCountries.size > 0 || selectedCardTypes.size > 0 || selectedMediaBuyers.buyers.length > 0 || selectedMediaBuyers.utms.length > 0 || selectedCurrencies.size > 0;
  if (hasUserFilters) {
    for (const tx of analyticsTxs) {
      const list = txsByUserForFilters.get(tx.user_id) ?? [];
      list.push(tx);
      txsByUserForFilters.set(tx.user_id, list);
    }
    txsByUserForFilters.forEach((list, userId) => {
      const country = countryCodeForUserTransactions(list);
      if (selectedCountries.size > 0 && (!country || !selectedCountries.has(country))) return;
      if (selectedCardTypes.size > 0 && !selectedCardTypes.has(cardTypeForUserTransactions(list))) return;
      if (!userMatchesMediaBuyerSelection(list, selectedMediaBuyers)) return;
      if (selectedCurrencies.size > 0) {
        const currency = currencyForUserTransactions(list);
        if (!currency || !selectedCurrencies.has(currency)) return;
      }
      userFilteredIds.add(userId);
    });
  }
  // Cohort membership is anchored to the exact trial timestamp; the displayed
  // date is only a label. This keeps D0/D7/D30 windows aligned per user.
  const userFilteredTxs = hasUserFilters
    ? analyticsTxs.filter((tx) => userFilteredIds.has(tx.user_id))
    : analyticsTxs;
  const trials = userFilteredTxs.filter((t) => t.transaction_type === "trial" && t.status === "success");
  const cohortByUser = new Map<string, { id: string; date: string; funnel: Transaction["funnel"]; campaignPath: string; ts: number }>();
  for (const t of [...trials].sort((a, b) => (a.event_time < b.event_time ? -1 : 1))) {
    if (cohortByUser.has(t.user_id)) continue;
    const date = t.cohort_date ?? t.event_time.slice(0, 10);
    const funnel = t.funnel;
    const campaignPath = t.campaign_path || "unknown";
    cohortByUser.set(t.user_id, {
      id: buildCohortId(funnel, campaignPath, date),
      date,
      funnel,
      campaignPath,
      ts: new Date(t.event_time).getTime(),
    });
  }

  const groups = new Map<string, { date: string; funnel: Transaction["funnel"]; campaignPath: string; userIds: string[] }>();
  cohortByUser.forEach((c, user_id) => {
    const group = groups.get(c.id) ?? { date: c.date, funnel: c.funnel, campaignPath: c.campaignPath, userIds: [] };
    group.userIds.push(user_id);
    groups.set(c.id, group);
  });

  const userTxs = new Map<string, Transaction[]>();
  for (const t of userFilteredTxs) {
    const list = userTxs.get(t.user_id) ?? [];
    list.push(t);
    userTxs.set(t.user_id, list);
  }
  const subscriptionFlags = subscriptionFlagsByEmail(userFilteredTxs, subscriptions);
  // "Now" is stamped once per computation so active metrics are deterministic
  // within a call and reflect the current moment (not the last sync).
  const nowMs = typeof options.now === "number" ? options.now : Date.now();
  const activeSubsByEmail = activeSubscriptionIdsByEmail(subscriptions, nowMs);
  const maxRenewalDepth = sanitizeMaxRenewalColumns(options.maxRenewalDepth ?? DEFAULT_MAX_RENEWAL_DEPTH);

  // Web-app token purchases can arrive under a different customer id than the
  // funnel purchase. Attribute them to the buyer's cohort by user_id first,
  // then by normalized email; anything else is reported as unmatched token
  // revenue and excluded from cohort metrics.
  const cohortUidByEmail = new Map<string, string>();
  userTxs.forEach((list, uid) => {
    if (!cohortByUser.has(uid)) return;
    for (const t of list) {
      const email = normalizeEmailKey(t.email);
      if (email && !cohortUidByEmail.has(email)) cohortUidByEmail.set(email, uid);
    }
  });

  const extraTokenTxsByUid = new Map<string, Transaction[]>();
  const unknownProducts = createUnknownProductAccumulator();
  let unknown_addon_revenue = 0;
  const tokenDiagnostics: TokenAttributionDiagnostics = {
    token_purchases_total: 0,
    token_purchases_matched: 0,
    token_purchases_matched_by_email: 0,
    token_purchases_unmatched: 0,
    token_unmatched_amount: 0,
  };
  for (const t of userFilteredTxs) {
    if (!isTokenRelatedTransaction(t)) continue;
    const isSuccessfulTokenPurchase = t.status === "success" && t.transaction_type === "token_purchase";
    if (isSuccessfulTokenPurchase) tokenDiagnostics.token_purchases_total += 1;
    if (cohortByUser.has(t.user_id)) {
      // Already inside the cohort user's own transaction list.
      if (isSuccessfulTokenPurchase) tokenDiagnostics.token_purchases_matched += 1;
      continue;
    }
    const emailUid = cohortUidByEmail.get(normalizeEmailKey(t.email));
    if (emailUid) {
      const list = extraTokenTxsByUid.get(emailUid) ?? [];
      list.push(t);
      extraTokenTxsByUid.set(emailUid, list);
      if (isSuccessfulTokenPurchase) {
        tokenDiagnostics.token_purchases_matched += 1;
        tokenDiagnostics.token_purchases_matched_by_email += 1;
      }
    } else if (isSuccessfulTokenPurchase) {
      tokenDiagnostics.token_purchases_unmatched += 1;
      tokenDiagnostics.token_unmatched_amount += grossAmount(t);
    }
  }
  tokenDiagnostics.token_unmatched_amount = round2(tokenDiagnostics.token_unmatched_amount);

  const rows: CohortRow[] = [];
  groups.forEach((group, cohort_id) => {
    const { date: cohort_date, funnel, campaignPath: campaign_path, userIds } = group;
    const trial_users = userIds.length;
    let upsell_users = 0;
    let first_subscription_users = 0;
    const renewalUserCountsByLevel = createRenewalCountsByLevel(maxRenewalDepth);
    let renewal_users = 0;
    const refundedUserIds = new Set<string>();
    // Active Users = cohort uids with >=1 currently-active subscription.
    // Active Subscriptions = unique active subscription_ids across the cohort.
    // Both come from the SAME activeSubsByEmail set (never counted separately).
    const activeUserIds = new Set<string>();
    const activeSubscriptionIds = new Set<string>();
    const cancelledUserIds = new Set<string>();
    const userCancelledUserIds = new Set<string>();
    const autoCancelledUserIds = new Set<string>();
    const cancelledActiveUserIds = new Set<string>();
    const planBreakdown = new Map<number, MutablePlanBreakdown>();
    let trial_revenue = 0, upsell_revenue = 0, first_subscription_revenue = 0, renewal_revenue = 0;
    let amount_refunded = 0, gross_revenue = 0;
    let revenue_d0 = 0, revenue_d7 = 0, revenue_d14 = 0, revenue_d30 = 0, revenue_d60 = 0, revenue_d37 = 0, revenue_d67 = 0, revenue_total = 0;
    // Monetization: multi-upsell slots + token pack purchases. Slots are
    // assigned by the ORDER of the user's successful upsell purchases (the
    // audit showed no ordinal signal on the payments themselves).
    const upsellSlotUserIds = [new Set<string>(), new Set<string>(), new Set<string>()] as const;
    const upsellSlotRevenue = [0, 0, 0];
    const upsellExtraUserIds = new Set<string>();
    let upsell_extra_revenue = 0;
    const funnelUpsellUserIds = new Set<string>();
    let funnel_upsell_revenue = 0;
    const tokenBuyerIds = new Set<string>();
    let token_purchases = 0, token_gross_revenue = 0, token_refund_amount = 0;
    const tokenPacks = createTokenPackAccumulator();
    // Per-currency revenue mix (original charge currency vs USD-normalized).
    type MutableCurrencyRow = {
      trialUsers: number; transactions: number; grossOriginal: number;
      grossUsd: number; netUsd: number; refundsUsd: number;
      trialPriceOriginalSum: number; trialPriceUsdSum: number; trialPriceCount: number;
    };
    const currencyRows = new Map<string, MutableCurrencyRow>();
    const currencyRowFor = (currency: string): MutableCurrencyRow => {
      const row = currencyRows.get(currency) ?? {
        trialUsers: 0, transactions: 0, grossOriginal: 0,
        grossUsd: 0, netUsd: 0, refundsUsd: 0,
        trialPriceOriginalSum: 0, trialPriceUsdSum: 0, trialPriceCount: 0,
      };
      currencyRows.set(currency, row);
      return row;
    };
    const txCurrency = (t: Transaction) =>
      String(t.original_currency ?? t.currency ?? "").trim().toUpperCase() || "UNKNOWN";
    let fx_missing_amount = 0;
    let fx_missing_transactions = 0;

    for (const uid of userIds) {
      const list = userTxs.get(uid) ?? [];
      const initialPlanTransaction = initialPlanTransactionForUser(list);
      const userEmail = normalizeEmailKey(list.find((t) => t.email)?.email);
      const subFlags = userEmail ? subscriptionFlags.get(userEmail) : undefined;
      const planPrice = initialPlanTransaction ? round2(initialPlanTransaction.amount_usd) : null;
      const plan = planPrice == null
        ? null
        : planBreakdown.get(planPrice) ?? createPlanBreakdown(planPrice);
      if (initialPlanTransaction) {
        planBreakdown.set(planPrice, plan!);
      }
      let hasUpsell = false;
      let userRefundAmount = 0;
      const userCohort = cohortByUser.get(uid);
      if (!userCohort) continue;
      // Canonical renewal model: level = position of each successful subscription payment in the
      // user's timestamp-ordered sequence. The same map drives BOTH the *_users counts and the
      // first_subscription/renewal revenue split, so counts and revenue can never disagree.
      const subscriptionLevelByPayment = subscriptionLevelByPaymentForUser(list, userCohort.ts);
      const subscriptionLevels = new Set<number>();
      subscriptionLevelByPayment.forEach((level) => {
        if (level <= maxRenewalDepth) subscriptionLevels.add(level);
      });
      // Upsell slot = 1-based position of each successful upsell purchase in
      // the user's chronological order (list is time-ascending after dedupe).
      const upsellSlotByPayment = new Map<Transaction, number>();
      {
        let upsellPosition = 0;
        for (const t of list) {
          if (t.status !== "success" || t.transaction_type !== "upsell") continue;
          if (new Date(t.event_time).getTime() < userCohort.ts) continue;
          upsellPosition += 1;
          upsellSlotByPayment.set(t, upsellPosition);
        }
      }
      for (const t of list) {
        const dt = (new Date(t.event_time).getTime() - userCohort.ts) / DAY;
        if (dt < 0) continue;
        const refunded = refundAmount(t);
        amount_refunded += refunded;
        userRefundAmount += refunded;
        if (plan) plan.amount_refunded += refunded;
        // Token refunds: same-row amountRefunded on settled token rows plus
        // dedicated refund/chargeback rows whose product matches a token pack.
        if (isTokenRelatedTransaction(t)) token_refund_amount += refunded;
        // Currency mix: refunds are USD after normalization; missing-FX rows
        // are excluded from USD metrics and reported per cohort.
        currencyRowFor(txCurrency(t)).refundsUsd += refunded;
        if (t.fx_status === "missing_currency" || t.fx_status === "missing_fx_rate" || t.fx_status === "invalid_amount") {
          fx_missing_transactions += 1;
          if (t.status === "success") fx_missing_amount += t.original_gross_amount ?? 0;
        }
        if (t.status !== "success") continue;
        const gross = grossAmount(t);
        const net = netAmount(t);
        const day = transactionDay(t, dt);
        if (day === 0) revenue_d0 += net;
        if (day <= 7) revenue_d7 += net;
        if (day <= 14) revenue_d14 += net;
        if (day <= 30) revenue_d30 += net;
        if (day <= 60) revenue_d60 += net;
        if (day <= 37) revenue_d37 += net;
        if (day <= 67) revenue_d67 += net;
        revenue_total += net;
        gross_revenue += gross;
        if (plan) {
          plan.gross_revenue += gross;
          plan.net_revenue += net;
          if (day === 0) plan.revenue_d0 += net;
          if (day <= 7) plan.revenue_d7 += net;
          if (day <= 30) plan.revenue_d30 += net;
          if (day <= 60) plan.revenue_d60 += net;
        }
        {
          const currencyRow = currencyRowFor(txCurrency(t));
          currencyRow.transactions += 1;
          currencyRow.grossOriginal += t.original_gross_amount ?? gross;
          currencyRow.grossUsd += gross;
          currencyRow.netUsd += net;
          if (t.transaction_type === "trial") {
            currencyRow.trialUsers += 1;
            currencyRow.trialPriceOriginalSum += t.original_gross_amount ?? gross;
            currencyRow.trialPriceUsdSum += gross;
            currencyRow.trialPriceCount += 1;
          }
        }
        if (t.transaction_type === "trial") trial_revenue += net;
        if (t.transaction_type === "upsell") upsell_revenue += net;
        if (t.transaction_type === "token_purchase") {
          token_purchases += 1;
          token_gross_revenue += gross;
          tokenBuyerIds.add(uid);
          addTokenPurchaseToPacks(tokenPacks, t, gross);
          // Auto-classified by the trial-window rule but not (yet) present in
          // monetizationProductMap — surface it so the mapping gets confirmed.
          if (!isTokenPurchaseTransaction(t)) addUnknownProduct(unknownProducts, t, "token_candidate");
        } else if (t.transaction_type === "upsell") {
          // Upsell N Gross Rev is defined on gross amounts (spec), unlike the
          // net-based generic upsell_revenue above.
          const position = upsellSlotByPayment.get(t);
          funnelUpsellUserIds.add(uid);
          funnel_upsell_revenue += gross;
          if (position != null && position <= 3) {
            upsellSlotUserIds[position - 1].add(uid);
            upsellSlotRevenue[position - 1] += gross;
          } else {
            upsellExtraUserIds.add(uid);
            upsell_extra_revenue += gross;
          }
        } else if (t.transaction_type === "unknown" && hasAddonMarker(t)) {
          // Explicit one-time/add-on rows that no rule could classify.
          addUnknownProduct(unknownProducts, t, "addon_candidate");
          unknown_addon_revenue += gross;
        } else if (
          // Unmapped in-app purchase candidates: an unmarked successful charge
          // this soon after the trial cannot be a subscription payment — it
          // needs an entry in monetizationProductMap.ts (Phase 8 diagnostics).
          t.transaction_type !== "trial" &&
          dt * DAY < APP_ADDON_WINDOW_HOURS * 60 * 60 * 1000 &&
          !hasUpsellMarker(t)
        ) {
          addUnknownProduct(unknownProducts, t, "token_candidate");
        }
        // First-sub / renewal revenue follow the canonical sequence position (NOT transaction_type),
        // so the revenue split matches the renewal_*_users counts exactly. Level 1 = First Sub;
        // levels >= 2 = renewals (uncapped, so the renewal_revenue total stays complete).
        const subscriptionLevel = subscriptionLevelByPayment.get(t);
        if (subscriptionLevel === 1) {
          first_subscription_revenue += net;
          if (plan) plan.first_subscription_revenue += net;
        } else if (subscriptionLevel !== undefined && subscriptionLevel >= 2) {
          renewal_revenue += net;
        }
        if (t.transaction_type === "upsell" && t.status === "success") hasUpsell = true;
      }
      // Token purchases matched by email (different customer id, same person).
      // They count toward token/add-on metrics only — existing cohort revenue
      // definitions (gross/net/revenue_dN) intentionally stay unchanged.
      for (const t of extraTokenTxsByUid.get(uid) ?? []) {
        const dt = (new Date(t.event_time).getTime() - userCohort.ts) / DAY;
        if (dt < 0) continue;
        token_refund_amount += refundAmount(t);
        if (t.status !== "success" || t.transaction_type !== "token_purchase") continue;
        const gross = grossAmount(t);
        token_purchases += 1;
        token_gross_revenue += gross;
        tokenBuyerIds.add(uid);
        addTokenPurchaseToPacks(tokenPacks, { product: t.product, user_id: uid }, gross);
      }
      const hasRenewal = renewalLevelsThrough(maxRenewalDepth).some((level) => subscriptionLevels.has(level));
      if (hasUpsell) upsell_users += 1;
      if (subscriptionLevels.has(1)) first_subscription_users += 1;
      incrementRenewalCountsByLevel(renewalUserCountsByLevel, subscriptionLevels, maxRenewalDepth);
      if (hasRenewal) renewal_users += 1;
      const userActiveSubIds = userEmail ? activeSubsByEmail.get(userEmail) : undefined;
      if (userActiveSubIds && userActiveSubIds.size > 0) {
        activeUserIds.add(uid);
        for (const subId of userActiveSubIds) activeSubscriptionIds.add(subId);
      }
      if (subFlags?.cancelled) cancelledUserIds.add(uid);
      if (subFlags?.autoCancelWithFailedTransaction) autoCancelledUserIds.add(uid);
      else if (subFlags?.userCancel) userCancelledUserIds.add(uid);
      else if (subFlags?.autoCancel) autoCancelledUserIds.add(uid);
      if (subFlags?.cancelledActive) cancelledActiveUserIds.add(uid);
      if (userRefundAmount > 0) refundedUserIds.add(uid);
      if (plan) {
        plan.trial_users += 1;
        if (userActiveSubIds && userActiveSubIds.size > 0) {
          plan.active_users += 1;
          plan.active_subscriptions += userActiveSubIds.size;
        }
        if (subFlags?.cancelled) plan.cancelled_users += 1;
        if (subFlags?.autoCancelWithFailedTransaction) plan.auto_cancelled_users += 1;
        else if (subFlags?.userCancel) plan.user_cancelled_users += 1;
        else if (subFlags?.autoCancel) plan.auto_cancelled_users += 1;
        if (hasUpsell) plan.upsell_users += 1;
        if (subscriptionLevels.has(1)) plan.first_subscription_users += 1;
        incrementRenewalCountsByLevel(plan.renewal_users_by_level, subscriptionLevels, maxRenewalDepth);
        if (hasRenewal) plan.renewal_users += 1;
        if (userRefundAmount > 0) plan.refund_users += 1;
      }
    }
    const refund_users = refundedUserIds.size;
    const active_users = activeUserIds.size;
    const active_subscriptions = activeSubscriptionIds.size;
    const cancelled_users = cancelledUserIds.size;
    const user_cancelled_users = userCancelledUserIds.size;
    const auto_cancelled_users = autoCancelledUserIds.size;
    const cancelled_active_users = cancelledActiveUserIds.size;
    const netRevenue = gross_revenue - amount_refunded;
    const token_buyers = tokenBuyerIds.size;
    const token_net_revenue = round2(token_gross_revenue - token_refund_amount);
    const renewalUserCounts = staticRenewalCountsFromLevels(renewalUserCountsByLevel);
    planBreakdown.forEach((plan) => {
      Object.assign(plan, staticRenewalCountsFromLevels(plan.renewal_users_by_level));
    });

    rows.push({
      cohort_id,
      cohort_date,
      funnel,
      campaign_path,
      trial_users,
      active_users,
      active_rate: trial_users ? (active_users / trial_users) * 100 : 0,
      active_subscriptions,
      active_subscriptions_rate: trial_users ? (active_subscriptions / trial_users) * 100 : 0,
      // Active users and the unique active subscription_ids, for total-row dedup.
      active_subscription_user_ids: Array.from(activeUserIds),
      active_subscription_ids: Array.from(activeSubscriptionIds),
      cancelled_users,
      cancellation_rate: trial_users ? (cancelled_users / trial_users) * 100 : 0,
      user_cancelled_users,
      user_cancel_rate: trial_users ? (user_cancelled_users / trial_users) * 100 : 0,
      auto_cancelled_users,
      auto_cancel_rate: trial_users ? (auto_cancelled_users / trial_users) * 100 : 0,
      cancelled_active_users,
      active_user_ids: Array.from(activeUserIds),
      cancelled_user_ids: Array.from(cancelledUserIds),
      user_cancelled_user_ids: Array.from(userCancelledUserIds),
      auto_cancelled_user_ids: Array.from(autoCancelledUserIds),
      cancelled_active_user_ids: Array.from(cancelledActiveUserIds),
      upsell_users,
      first_subscription_users,
      ...renewalUserCounts,
      renewal_users_by_level: { ...renewalUserCountsByLevel },
      renewal_users,
      refund_users,
      refunded_user_ids: Array.from(refundedUserIds),
      plan_breakdown: Array.from(planBreakdown.values())
        .sort((a, b) => a.price - b.price)
        .map(finalizePlanBreakdown),
      trial_revenue: round2(trial_revenue),
      upsell_revenue: round2(upsell_revenue),
      first_subscription_revenue: round2(first_subscription_revenue),
      renewal_revenue: round2(renewal_revenue),
      upsell_1_users: upsellSlotUserIds[0].size,
      upsell_2_users: upsellSlotUserIds[1].size,
      upsell_3_users: upsellSlotUserIds[2].size,
      upsell_extra_users: upsellExtraUserIds.size,
      upsell_1_revenue: round2(upsellSlotRevenue[0]),
      upsell_2_revenue: round2(upsellSlotRevenue[1]),
      upsell_3_revenue: round2(upsellSlotRevenue[2]),
      upsell_extra_revenue: round2(upsell_extra_revenue),
      upsell_1_cr: trial_users ? (upsellSlotUserIds[0].size / trial_users) * 100 : 0,
      upsell_2_cr: trial_users ? (upsellSlotUserIds[1].size / trial_users) * 100 : 0,
      upsell_3_cr: trial_users ? (upsellSlotUserIds[2].size / trial_users) * 100 : 0,
      funnel_upsell_users: funnelUpsellUserIds.size,
      funnel_upsell_revenue: round2(funnel_upsell_revenue),
      token_buyers,
      token_buyer_cr: trial_users ? (token_buyers / trial_users) * 100 : 0,
      token_purchases,
      token_gross_revenue: round2(token_gross_revenue),
      token_net_revenue,
      avg_token_revenue_per_trial: trial_users ? round2(token_net_revenue / trial_users) : 0,
      avg_token_revenue_per_buyer: token_buyers ? round2(token_net_revenue / token_buyers) : 0,
      // Spec formula: Upsell 1 Rev + Upsell 2 Rev + Upsell 3 Rev + Token Net Rev
      // (gross upsell slots; extra/4th+ upsells are reported separately).
      addon_revenue: round2(upsellSlotRevenue[0] + upsellSlotRevenue[1] + upsellSlotRevenue[2] + token_net_revenue),
      token_buyer_user_ids: Array.from(tokenBuyerIds),
      token_pack_breakdown: finalizeTokenPacks(tokenPacks),
      currency_breakdown: Array.from(currencyRows.entries())
        .map(([currency, row]): CohortCurrencyBreakdownRow => ({
          currency,
          trial_users: row.trialUsers,
          transactions: row.transactions,
          gross_original: round2(row.grossOriginal),
          gross_usd: round2(row.grossUsd),
          net_usd: round2(row.netUsd),
          refunds_usd: round2(row.refundsUsd),
          avg_trial_price_original: row.trialPriceCount ? round2(row.trialPriceOriginalSum / row.trialPriceCount) : null,
          avg_trial_price_usd: row.trialPriceCount ? round2(row.trialPriceUsdSum / row.trialPriceCount) : null,
        }))
        .sort((a, b) => b.gross_usd - a.gross_usd || a.currency.localeCompare(b.currency)),
      currency_mix: Array.from(currencyRows.entries())
        .filter(([, row]) => row.trialUsers > 0)
        .sort((a, b) => b[1].trialUsers - a[1].trialUsers)
        .map(([currency, row]) => `${currency} ${row.trialUsers}`)
        .join(" · "),
      fx_missing_amount: round2(fx_missing_amount),
      fx_missing_transactions,
      amount_refunded: round2(amount_refunded),
      refund_rate: trial_users ? (refund_users / trial_users) * 100 : 0,
      gross_revenue: round2(gross_revenue),
      net_revenue: round2(netRevenue),
      gross_ltv: round2(gross_revenue / trial_users),
      net_ltv: round2(netRevenue / trial_users),
      trial_to_upsell_cr: (upsell_users / trial_users) * 100,
      trial_to_first_subscription_cr: (first_subscription_users / trial_users) * 100,
      first_subscription_to_renewal_2_cr: first_subscription_users ? ((renewalUserCountsByLevel[2] ?? 0) / first_subscription_users) * 100 : 0,
      renewal_2_to_renewal_3_cr: renewalUserCountsByLevel[2] ? ((renewalUserCountsByLevel[3] ?? 0) / renewalUserCountsByLevel[2]) * 100 : 0,
      renewal_3_to_renewal_4_cr: renewalUserCountsByLevel[3] ? ((renewalUserCountsByLevel[4] ?? 0) / renewalUserCountsByLevel[3]) * 100 : 0,
      renewal_4_to_renewal_5_cr: renewalUserCountsByLevel[4] ? ((renewalUserCountsByLevel[5] ?? 0) / renewalUserCountsByLevel[4]) * 100 : 0,
      renewal_5_to_renewal_6_cr: renewalUserCountsByLevel[5] ? ((renewalUserCountsByLevel[6] ?? 0) / renewalUserCountsByLevel[5]) * 100 : 0,
      revenue_d0: round2(revenue_d0),
      revenue_d7: round2(revenue_d7),
      revenue_d14: round2(revenue_d14),
      revenue_d30: round2(revenue_d30),
      revenue_d60: round2(revenue_d60),
      revenue_d37: round2(revenue_d37),
      revenue_d67: round2(revenue_d67),
      revenue_total: round2(revenue_total),
      ltv_d7: round2(revenue_d7 / trial_users),
      ltv_d14: round2(revenue_d14 / trial_users),
      ltv_d30: round2(revenue_d30 / trial_users),
      // Realized 1-month LTV. net = USD-normalized net (refunds already
      // subtracted); revenue_d30 sums only day<=30, so post-30d revenue is
      // excluded. Named field for the "LTV 1M / User" column.
      net_revenue_1m: round2(revenue_d30),
      ltv_1m_per_user: trial_users ? round2(revenue_d30 / trial_users) : 0,
    });
  });

  return {
    cohorts: rows.sort((a, b) => (a.cohort_date < b.cohort_date ? 1 : -1)),
    tokenDiagnostics: {
      ...tokenDiagnostics,
      unknown_products: finalizeUnknownProducts(unknownProducts),
      unknown_addon_revenue: round2(unknown_addon_revenue),
    },
    fxDiagnostics,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

export function formatCurrency(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

export function formatPct(n: number, digits = 1): string {
  return `${n.toFixed(digits)}%`;
}
