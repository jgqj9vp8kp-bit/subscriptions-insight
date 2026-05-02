import type { CohortRow, PlanBreakdownRow, Transaction, UserAggregate } from "./types";
import type { SubscriptionClean } from "@/types/subscriptions";

const DAY = 24 * 60 * 60 * 1000;

/** Money sums should ignore failed_payment rows (they were never collected). */
const isMoneyMoving = (t: Transaction) => t.status !== "failed";
const isRenewalType = (t: Transaction) =>
  t.transaction_type === "renewal_2" || t.transaction_type === "renewal_3" || t.transaction_type === "renewal";
const grossAmount = (t: Transaction) => t.gross_amount_usd ?? (t.amount_usd > 0 ? t.amount_usd : 0);
const refundAmount = (t: Transaction) => t.refund_amount_usd ?? (t.amount_usd < 0 ? Math.abs(t.amount_usd) : 0);
const netAmount = (t: Transaction) => t.net_amount_usd ?? grossAmount(t) - refundAmount(t);
const dashboardRevenueAmount = (t: Transaction) => {
  if (typeof t.net_amount_usd === "number") return t.net_amount_usd;
  if (typeof t.refund_amount_usd === "number") return t.amount_usd - t.refund_amount_usd;
  return t.amount_usd;
};
const PLAN_ASSIGNMENT_REASON = "Plan assigned from first successful non-upsell transaction";
const initialPlanTransactionForUser = (txs: Transaction[]) =>
  [...txs]
    .sort((a, b) => (a.event_time < b.event_time ? -1 : 1))
    .find((t) => t.status === "success" && t.transaction_type !== "upsell");
const planNameFromPrice = (price: number | null) => (price == null ? "Unknown" : formatCurrency(price));
const normalizeEmailKey = (email: string | null | undefined) => email?.trim().toLowerCase() || "";

interface MutablePlanBreakdown {
  price: number;
  trial_users: number;
  active_users: number;
  active_subscriptions: number;
  cancelled_users: number;
  upsell_users: number;
  first_subscription_users: number;
  renewal_2_users: number;
  renewal_3_users: number;
  renewal_users: number;
  refund_users: number;
  gross_revenue: number;
  amount_refunded: number;
  net_revenue: number;
}

function createPlanBreakdown(price: number): MutablePlanBreakdown {
  return {
    price,
    trial_users: 0,
    active_users: 0,
    active_subscriptions: 0,
    cancelled_users: 0,
    upsell_users: 0,
    first_subscription_users: 0,
    renewal_2_users: 0,
    renewal_3_users: 0,
    renewal_users: 0,
    refund_users: 0,
    gross_revenue: 0,
    amount_refunded: 0,
    net_revenue: 0,
  };
}

function finalizePlanBreakdown(row: MutablePlanBreakdown): PlanBreakdownRow {
  return {
    price: row.price,
    trial_users: row.trial_users,
    active_users: row.active_users,
    active_rate: row.trial_users ? (row.active_users / row.trial_users) * 100 : 0,
    active_subscriptions: row.active_subscriptions,
    active_subscriptions_rate: row.trial_users ? (row.active_subscriptions / row.trial_users) * 100 : 0,
    cancelled_users: row.cancelled_users,
    cancellation_rate: row.trial_users ? (row.cancelled_users / row.trial_users) * 100 : 0,
    upsell_users: row.upsell_users,
    first_subscription_users: row.first_subscription_users,
    renewal_2_users: row.renewal_2_users,
    renewal_3_users: row.renewal_3_users,
    renewal_users: row.renewal_users,
    refund_users: row.refund_users,
    trial_to_upsell_cr: row.trial_users ? (row.upsell_users / row.trial_users) * 100 : 0,
    trial_to_first_subscription_cr: row.trial_users ? (row.first_subscription_users / row.trial_users) * 100 : 0,
    first_subscription_to_renewal_2_cr: row.first_subscription_users ? (row.renewal_2_users / row.first_subscription_users) * 100 : 0,
    renewal_2_to_renewal_3_cr: row.renewal_2_users ? (row.renewal_3_users / row.renewal_2_users) * 100 : 0,
    refund_rate: row.trial_users ? (row.refund_users / row.trial_users) * 100 : 0,
    gross_revenue: round2(row.gross_revenue),
    amount_refunded: round2(row.amount_refunded),
    net_revenue: round2(row.net_revenue),
    net_ltv: row.trial_users ? round2(row.net_revenue / row.trial_users) : 0,
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
      return {
        user_id,
        email: sorted.find((t) => t.email)?.email || "",
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
      } satisfies UserAggregate;
    })
    .sort((a, b) => b.total_revenue - a.total_revenue);
}

type SubscriptionFlags = {
  active: boolean;
  activeSubscription: boolean;
  cancelled: boolean;
  cancelledActive: boolean;
};

function subscriptionFlagsByEmail(subscriptions: SubscriptionClean[]): Map<string, SubscriptionFlags> {
  const result = new Map<string, SubscriptionFlags>();
  for (const sub of subscriptions) {
    const email = normalizeEmailKey(sub.email);
    if (!email) continue;
    const flags = result.get(email) ?? { active: false, activeSubscription: false, cancelled: false, cancelledActive: false };
    flags.active = flags.active || sub.is_active_now;
    flags.activeSubscription = flags.activeSubscription || (sub.status === "active" && sub.renews === true);
    flags.cancelled = flags.cancelled || sub.is_cancelled;
    flags.cancelledActive = flags.cancelledActive || (sub.is_cancelled && sub.is_active_now);
    result.set(email, flags);
  }
  return result;
}

export function computeCohorts(txs: Transaction[], subscriptions: SubscriptionClean[] = []): CohortRow[] {
  // Cohort membership is anchored to the exact trial timestamp; the displayed
  // date is only a label. This keeps D0/D7/D30 windows aligned per user.
  const trials = txs.filter((t) => t.transaction_type === "trial" && t.status === "success");
  const cohortByUser = new Map<string, { id: string; date: string; funnel: Transaction["funnel"]; campaignPath: string; ts: number }>();
  for (const t of [...trials].sort((a, b) => (a.event_time < b.event_time ? -1 : 1))) {
    if (cohortByUser.has(t.user_id)) continue;
    const date = t.cohort_date ?? t.event_time.slice(0, 10);
    const funnel = t.funnel;
    const campaignPath = t.campaign_path || "unknown";
    cohortByUser.set(t.user_id, {
      id: t.cohort_id ?? `${campaignPath}_${date}`,
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
  for (const t of txs) {
    const list = userTxs.get(t.user_id) ?? [];
    list.push(t);
    userTxs.set(t.user_id, list);
  }
  const subscriptionFlags = subscriptionFlagsByEmail(subscriptions);

  const rows: CohortRow[] = [];
  groups.forEach((group, cohort_id) => {
    const { date: cohort_date, funnel, campaignPath: campaign_path, userIds } = group;
    const trial_users = userIds.length;
    let upsell_users = 0;
    let first_subscription_users = 0;
    let renewal_2_users = 0;
    let renewal_3_users = 0;
    let renewal_users = 0;
    const refundedUserIds = new Set<string>();
    const activeUserIds = new Set<string>();
    const activeSubscriptionUserIds = new Set<string>();
    const cancelledUserIds = new Set<string>();
    const cancelledActiveUserIds = new Set<string>();
    const planBreakdown = new Map<number, MutablePlanBreakdown>();
    let trial_revenue = 0, upsell_revenue = 0, first_subscription_revenue = 0, renewal_revenue = 0;
    let amount_refunded = 0, gross_revenue = 0, net_revenue = 0;
    let revenue_d0 = 0, revenue_d7 = 0, revenue_d14 = 0, revenue_d30 = 0, revenue_d37 = 0, revenue_d67 = 0, revenue_total = 0;

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
      let hasUpsell = false, hasSub = false, hasRenewal2 = false, hasRenewal3 = false, hasRenewal = false;
      let userRefundAmount = 0;
      const userCohort = cohortByUser.get(uid);
      if (!userCohort) continue;
      for (const t of list) {
        const dt = (new Date(t.event_time).getTime() - userCohort.ts) / DAY;
        if (dt < 0) continue;
        const refunded = refundAmount(t);
        amount_refunded += refunded;
        userRefundAmount += refunded;
        if (plan) plan.amount_refunded += refunded;
        if (!isMoneyMoving(t)) continue;
        const gross = grossAmount(t);
        const net = netAmount(t);
        // D0/D7/D14/D30 are rolling windows from the user's trial timestamp.
        // D0 means first 24 hours, not same calendar date.
        if (dt < 1) revenue_d0 += net;
        if (dt < 7) revenue_d7 += net;
        if (dt < 14) revenue_d14 += net;
        if (dt < 30) revenue_d30 += net;
        if (dt < 37) revenue_d37 += net;
        if (dt < 67) revenue_d67 += net;
        revenue_total += net;
        gross_revenue += gross;
        net_revenue += net;
        if (plan) {
          plan.gross_revenue += gross;
          plan.net_revenue += net;
        }
        if (t.transaction_type === "trial") trial_revenue += net;
        if (t.transaction_type === "upsell") upsell_revenue += net;
        if (t.transaction_type === "first_subscription") first_subscription_revenue += net;
        if (isRenewalType(t)) renewal_revenue += net;
        if (t.transaction_type === "upsell" && t.status === "success") hasUpsell = true;
        if (t.transaction_type === "first_subscription" && t.status === "success") hasSub = true;
        if (t.transaction_type === "renewal_2" && t.status === "success") hasRenewal2 = true;
        if (t.transaction_type === "renewal_3" && t.status === "success") hasRenewal3 = true;
        if (isRenewalType(t) && t.status === "success") hasRenewal = true;
      }
      if (hasUpsell) upsell_users += 1;
      if (hasSub) first_subscription_users += 1;
      if (hasRenewal2) renewal_2_users += 1;
      if (hasRenewal3) renewal_3_users += 1;
      if (hasRenewal) renewal_users += 1;
      if (subFlags?.active) activeUserIds.add(uid);
      if (subFlags?.activeSubscription) activeSubscriptionUserIds.add(uid);
      if (subFlags?.cancelled) cancelledUserIds.add(uid);
      if (subFlags?.cancelledActive) cancelledActiveUserIds.add(uid);
      if (userRefundAmount > 0) refundedUserIds.add(uid);
      if (plan) {
        plan.trial_users += 1;
        if (subFlags?.active) plan.active_users += 1;
        if (subFlags?.activeSubscription) plan.active_subscriptions += 1;
        if (subFlags?.cancelled) plan.cancelled_users += 1;
        if (hasUpsell) plan.upsell_users += 1;
        if (hasSub) plan.first_subscription_users += 1;
        if (hasRenewal2) plan.renewal_2_users += 1;
        if (hasRenewal3) plan.renewal_3_users += 1;
        if (hasRenewal) plan.renewal_users += 1;
        if (userRefundAmount > 0) plan.refund_users += 1;
      }
    }
    const refund_users = refundedUserIds.size;
    const active_users = activeUserIds.size;
    const active_subscriptions = activeSubscriptionUserIds.size;
    const cancelled_users = cancelledUserIds.size;
    const cancelled_active_users = cancelledActiveUserIds.size;

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
      active_subscription_user_ids: Array.from(activeSubscriptionUserIds),
      cancelled_users,
      cancellation_rate: trial_users ? (cancelled_users / trial_users) * 100 : 0,
      cancelled_active_users,
      active_user_ids: Array.from(activeUserIds),
      cancelled_user_ids: Array.from(cancelledUserIds),
      cancelled_active_user_ids: Array.from(cancelledActiveUserIds),
      upsell_users,
      first_subscription_users,
      renewal_2_users,
      renewal_3_users,
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
      amount_refunded: round2(amount_refunded),
      refund_rate: trial_users ? (refund_users / trial_users) * 100 : 0,
      gross_revenue: round2(gross_revenue),
      net_revenue: round2(net_revenue),
      gross_ltv: round2(gross_revenue / trial_users),
      net_ltv: round2(net_revenue / trial_users),
      trial_to_upsell_cr: (upsell_users / trial_users) * 100,
      trial_to_first_subscription_cr: (first_subscription_users / trial_users) * 100,
      first_subscription_to_renewal_2_cr: first_subscription_users ? (renewal_2_users / first_subscription_users) * 100 : 0,
      renewal_2_to_renewal_3_cr: renewal_2_users ? (renewal_3_users / renewal_2_users) * 100 : 0,
      revenue_d0: round2(revenue_d0),
      revenue_d7: round2(revenue_d7),
      revenue_d14: round2(revenue_d14),
      revenue_d30: round2(revenue_d30),
      revenue_d37: round2(revenue_d37),
      revenue_d67: round2(revenue_d67),
      revenue_total: round2(revenue_total),
      ltv_d7: round2(revenue_d7 / trial_users),
      ltv_d14: round2(revenue_d14 / trial_users),
      ltv_d30: round2(revenue_d30 / trial_users),
    });
  });

  return rows.sort((a, b) => (a.cohort_date < b.cohort_date ? 1 : -1));
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
