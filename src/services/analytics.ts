import type { CohortRow, Transaction, UserAggregate } from "./types";

const DAY = 24 * 60 * 60 * 1000;

/** Money sums should ignore failed_payment rows (they were never collected). */
const isMoneyMoving = (t: Transaction) => t.status !== "failed";
const isRenewalType = (t: Transaction) =>
  t.transaction_type === "renewal_2" || t.transaction_type === "renewal_3" || t.transaction_type === "renewal";

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
    money.filter((t) => t.transaction_type === type).reduce((s, t) => s + t.amount_usd, 0);

  const totalRevenue = money.reduce((s, t) => s + t.amount_usd, 0);
  const trialPayments = sumByType("trial");
  const upsellRevenue = sumByType("upsell");
  const firstSubscriptionRevenue = sumByType("first_subscription");
  const renewalRevenue = money.filter(isRenewalType).reduce((s, t) => s + t.amount_usd, 0);

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
    map.set(date, (map.get(date) ?? 0) + t.amount_usd);
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
    map.set(t.transaction_type, (map.get(t.transaction_type) ?? 0) + t.amount_usd);
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
    if (t.transaction_type === "trial") row.trial += t.amount_usd;
    if (t.transaction_type === "upsell") row.upsell += t.amount_usd;
    if (t.transaction_type === "first_subscription") row.first_subscription += t.amount_usd;
    if (t.transaction_type === "renewal_2") row.renewal_2 += t.amount_usd;
    if (t.transaction_type === "renewal_3") row.renewal_3 += t.amount_usd;
    if (t.transaction_type === "renewal") row.renewal += t.amount_usd;
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
      const money = sorted.filter(isMoneyMoving);
      const total_revenue = money.reduce((s, t) => s + t.amount_usd, 0);
      return {
        user_id,
        email: sorted[0].email,
        funnel: sorted[0].funnel,
        first_trial_date: trial ? trial.event_time : null,
        total_revenue: Math.round(total_revenue * 100) / 100,
        has_upsell: sorted.some((t) => t.transaction_type === "upsell" && t.status === "success"),
        has_first_subscription: sorted.some((t) => t.transaction_type === "first_subscription" && t.status === "success"),
        renewal_count: sorted.filter((t) => isRenewalType(t) && t.status === "success").length,
        user_ltv: Math.round(total_revenue * 100) / 100,
      } satisfies UserAggregate;
    })
    .sort((a, b) => b.total_revenue - a.total_revenue);
}

export function computeCohorts(txs: Transaction[]): CohortRow[] {
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

  const rows: CohortRow[] = [];
  groups.forEach((group, cohort_id) => {
    const { date: cohort_date, funnel, campaignPath: campaign_path, userIds } = group;
    const trial_users = userIds.length;
    let upsell_users = 0;
    let first_subscription_users = 0;
    let renewal_2_users = 0;
    let renewal_3_users = 0;
    let renewal_users = 0;
    let trial_revenue = 0, upsell_revenue = 0, first_subscription_revenue = 0, renewal_revenue = 0;
    let revenue_d0 = 0, revenue_d7 = 0, revenue_d14 = 0, revenue_d30 = 0, revenue_d37 = 0, revenue_d67 = 0, revenue_total = 0;

    for (const uid of userIds) {
      const list = userTxs.get(uid) ?? [];
      let hasUpsell = false, hasSub = false, hasRenewal2 = false, hasRenewal3 = false, hasRenewal = false;
      const userCohort = cohortByUser.get(uid);
      if (!userCohort) continue;
      for (const t of list) {
        if (!isMoneyMoving(t)) continue;
        const dt = (new Date(t.event_time).getTime() - userCohort.ts) / DAY;
        // D0/D7/D14/D30 are rolling windows from the user's trial timestamp.
        // D0 means first 24 hours, not same calendar date.
        if (dt >= 0 && dt < 1) revenue_d0 += t.amount_usd;
        if (dt >= 0 && dt < 7) revenue_d7 += t.amount_usd;
        if (dt >= 0 && dt < 14) revenue_d14 += t.amount_usd;
        if (dt >= 0 && dt < 30) revenue_d30 += t.amount_usd;
        if (dt >= 0 && dt < 37) revenue_d37 += t.amount_usd;
        if (dt >= 0 && dt < 67) revenue_d67 += t.amount_usd;
        if (dt >= 0) revenue_total += t.amount_usd;
        if (t.transaction_type === "trial") trial_revenue += t.amount_usd;
        if (t.transaction_type === "upsell") upsell_revenue += t.amount_usd;
        if (t.transaction_type === "first_subscription") first_subscription_revenue += t.amount_usd;
        if (isRenewalType(t)) renewal_revenue += t.amount_usd;
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
    }

    rows.push({
      cohort_id,
      cohort_date,
      funnel,
      campaign_path,
      trial_users,
      upsell_users,
      first_subscription_users,
      renewal_2_users,
      renewal_3_users,
      renewal_users,
      trial_revenue: round2(trial_revenue),
      upsell_revenue: round2(upsell_revenue),
      first_subscription_revenue: round2(first_subscription_revenue),
      renewal_revenue: round2(renewal_revenue),
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
