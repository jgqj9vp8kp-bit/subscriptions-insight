/**
 * Traffic Payback Forecast — deterministic core.
 *
 * Turns selected cohorts (from computeCohorts), their raw transactions and Facebook spend into a
 * payback/ROAS forecast. It cleanly separates REALIZED data (actual cohort transactions) from
 * PROJECTED data (assumption-driven future revenue) and never mixes the two silently.
 *
 * It reuses the canonical lifecycle helpers (dedupeTransactionsForAnalytics, buildCohortId, the
 * CohortRow fields produced by computeCohorts) and adds no new lifecycle classification. Cohorts,
 * Dashboard, Export API and warehouse logic are untouched.
 *
 * Money model (per transaction): net contribution = net_amount_usd when present, else amount_usd;
 * failed charges never contribute; refund rows carry a negative amount so they subtract at their own
 * event date. Day offset is measured per user from that user's first successful trial timestamp
 * (day 0 = the user's cohort entry), matching computeCohorts' revenue_dN windows.
 */
import type { CohortRow, Transaction } from "@/services/types";
import { dedupeTransactionsForAnalytics } from "@/services/analytics";
import { buildCohortId } from "@/services/cohortIdentity";
import { cohortTrafficKey, type TrafficAggregate } from "@/services/cohortReporting";

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_DAYS = 30;

/** Forecast horizons expressed as day offsets from cohort entry. */
export const HORIZON_DAYS = {
  d0: 0,
  d3: 3,
  d7: 7,
  d14: 14,
  d30: 30,
  d60: 60,
  d90: 90,
  m6: 180,
  m12: 365,
} as const;
export type HorizonKey = keyof typeof HORIZON_DAYS;

export type PaybackStatus = "scale" | "watch" | "stop" | "unknown";

/**
 * Assumptions used for the PROJECTED portion of the forecast. Rates are fractions in [0, 1]
 * (0.3 = 30%), prices/fees are USD. `cac` is per trial user (null = spend unavailable).
 */
export interface ForecastAssumptions {
  trialPrice: number;
  subscriptionPrice: number;
  upsellValue: number;
  upsellRate: number; // fraction of trial users who take an upsell
  firstRenewalRate: number; // trial -> first paid subscription month
  monthlyRetention: number; // month-over-month retention after the first paid month
  refundRate: number; // fraction of gross lost to refunds
  processingFeePct: number; // fraction of gross taken by processor
  fixedProcessingFee: number; // USD per successful charge
  cac: number | null;
  marginTarget?: number; // desired profit margin for Max Profitable CAC (fraction)
  /** TODO_MONETIZATION item 2: additive token/add-on uplift, kept SEPARATE from
   * the retention math. Average token NET revenue per trial user in month 0. */
  tokenArpuPerTrial?: number;
  /** Month-over-month decay of the token ARPU (fraction 0..1; 0 = hold flat). */
  tokenArpuDecay?: number;
}

export interface RevenueByDayResult {
  /** Cumulative net revenue at each day that has activity (sorted ascending). */
  points: Array<{ day: number; cumulativeNet: number }>;
  /** Oldest cohort maturity in days (last day with actual data). */
  maxDay: number;
  /** Total realized net revenue across all days. */
  totalNet: number;
}

export interface MonthlyProjectionPoint {
  month: number;
  day: number;
  payingUsers: number;
  grossRevenue: number;
  cumulativeGrossRevenue: number;
  cumulativeNetRevenue: number;
}

export interface CohortPaybackRow {
  cohortId: string;
  cohortDate: string;
  funnel: string;
  campaignPath: string;
  mediaBuyer: string;
  geo: string;
  cardType: string;
  trialUsers: number;
  spend: number | null;
  spendAvailable: boolean;
  cac: number | null;
  grossRevenue: number;
  netRevenue: number; // realized net revenue to date
  currentRoas: number | null;
  roasD7: number | null;
  roas1M: number | null;
  roas2M: number | null;
  roas3M: number | null;
  paybackDay: number | null;
  projectedLtv: number;
  profitPerUser: number | null;
  status: PaybackStatus;
}

export interface PaybackSummary {
  trialUsers: number;
  spend: number | null;
  spendAvailable: boolean;
  cac: number | null;
  grossRevenue: number;
  netRevenue: number;
  profit: number | null;
  currentRoas: number | null;
  roasD7: number | null;
  roas1M: number | null;
  roas2M: number | null;
  roas3M: number | null;
  roas6M: number | null;
  paybackDay: number | null;
  breakEvenCac: number;
  maxProfitableCac: number;
  projectedLtv: number;
  profitPerUser: number | null;
}

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

function netContribution(tx: Transaction): number {
  if (tx.status === "failed") return 0;
  if (typeof tx.net_amount_usd === "number") return tx.net_amount_usd;
  return tx.amount_usd;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: number) => Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));

/** ROAS = net revenue / spend. Null when spend is unavailable or non-positive. */
export function roas(netRevenue: number, spend: number | null | undefined): number | null {
  if (spend == null || !Number.isFinite(spend) || spend <= 0) return null;
  return netRevenue / spend;
}

// ---------------------------------------------------------------------------
// Cohort <-> user attribution (mirrors computeCohorts anchoring: first successful trial)
// ---------------------------------------------------------------------------

function byTimeAsc(a: Transaction, b: Transaction): number {
  return a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0;
}

interface UserCohortInfo {
  cohortId: string;
  anchorTs: number;
}

function buildUserCohortIndex(txs: Transaction[]): Map<string, UserCohortInfo> {
  const index = new Map<string, UserCohortInfo>();
  const trials = txs.filter((t) => t.transaction_type === "trial" && t.status === "success").sort(byTimeAsc);
  for (const t of trials) {
    if (index.has(t.user_id)) continue;
    const date = t.cohort_date ?? t.event_time.slice(0, 10);
    const cohortId = t.cohort_id ?? buildCohortId(t.funnel, t.campaign_path || "unknown", date);
    const anchorTs = new Date(t.event_time).getTime();
    if (!Number.isFinite(anchorTs)) continue;
    index.set(t.user_id, { cohortId, anchorTs });
  }
  return index;
}

// ---------------------------------------------------------------------------
// Phase 8/9 — actual revenue by day
// ---------------------------------------------------------------------------

/**
 * Realized cumulative net revenue by day offset for the given cohorts, computed from actual
 * transactions (per-user anchored at the user's first successful trial). Deterministic.
 */
export function calculateActualRevenueByDay(txs: Transaction[], cohortIds: string[]): RevenueByDayResult {
  const selected = new Set(cohortIds);
  const deduped = dedupeTransactionsForAnalytics(txs);
  const index = buildUserCohortIndex(deduped);

  const byDay = new Map<number, number>();
  for (const tx of deduped) {
    const info = index.get(tx.user_id);
    if (!info || !selected.has(info.cohortId)) continue;
    const ts = new Date(tx.event_time).getTime();
    if (!Number.isFinite(ts)) continue;
    const day = Math.max(0, Math.floor((ts - info.anchorTs) / DAY_MS));
    const net = netContribution(tx);
    if (net === 0) continue;
    byDay.set(day, (byDay.get(day) ?? 0) + net);
  }

  const days = Array.from(byDay.keys()).sort((a, b) => a - b);
  const points: Array<{ day: number; cumulativeNet: number }> = [];
  let cumulative = 0;
  for (const day of days) {
    cumulative += byDay.get(day) ?? 0;
    points.push({ day, cumulativeNet: round2(cumulative) });
  }
  return {
    points,
    maxDay: days.length ? days[days.length - 1] : 0,
    totalNet: round2(cumulative),
  };
}

/**
 * Batched variant: realized revenue-by-day for MANY cohorts in a single pass (dedupe + user index
 * built once). Used by the per-cohort table so we never re-scan all transactions per row.
 */
export function calculateActualRevenueByDayByCohort(
  txs: Transaction[],
  cohortIds: string[],
): Map<string, RevenueByDayResult> {
  const selected = new Set(cohortIds);
  const deduped = dedupeTransactionsForAnalytics(txs);
  const index = buildUserCohortIndex(deduped);

  const byCohortDay = new Map<string, Map<number, number>>();
  for (const tx of deduped) {
    const info = index.get(tx.user_id);
    if (!info || !selected.has(info.cohortId)) continue;
    const ts = new Date(tx.event_time).getTime();
    if (!Number.isFinite(ts)) continue;
    const day = Math.max(0, Math.floor((ts - info.anchorTs) / DAY_MS));
    const net = netContribution(tx);
    if (net === 0) continue;
    let dayMap = byCohortDay.get(info.cohortId);
    if (!dayMap) {
      dayMap = new Map<number, number>();
      byCohortDay.set(info.cohortId, dayMap);
    }
    dayMap.set(day, (dayMap.get(day) ?? 0) + net);
  }

  const result = new Map<string, RevenueByDayResult>();
  for (const cohortId of cohortIds) {
    const dayMap = byCohortDay.get(cohortId);
    if (!dayMap) {
      result.set(cohortId, { points: [], maxDay: 0, totalNet: 0 });
      continue;
    }
    const days = Array.from(dayMap.keys()).sort((a, b) => a - b);
    const points: Array<{ day: number; cumulativeNet: number }> = [];
    let cumulative = 0;
    for (const day of days) {
      cumulative += dayMap.get(day) ?? 0;
      points.push({ day, cumulativeNet: round2(cumulative) });
    }
    result.set(cohortId, { points, maxDay: days[days.length - 1] ?? 0, totalNet: round2(cumulative) });
  }
  return result;
}

/** Realized cumulative net revenue at (or before) a given day offset. */
export function actualNetRevenueAtDay(result: RevenueByDayResult, day: number): number {
  let value = 0;
  for (const point of result.points) {
    if (point.day > day) break;
    value = point.cumulativeNet;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Phase 8 — projected (assumption-driven) revenue
// ---------------------------------------------------------------------------

function netFromGross(gross: number, charges: number, a: ForecastAssumptions): number {
  const afterVariable = gross * (1 - clamp01(a.refundRate)) * (1 - clamp01(a.processingFeePct));
  return afterVariable - Math.max(0, a.fixedProcessingFee) * charges;
}

/**
 * Monthly cumulative net-revenue schedule for a cohort of `trialUsers`, from assumptions only.
 * month 0 = entry (trial + upsell) at day 0; month m>=1 = one subscription charge at day m*30.
 */
export function projectMonthlyNetRevenue(
  trialUsers: number,
  a: ForecastAssumptions,
  months = 12,
): MonthlyProjectionPoint[] {
  const points: MonthlyProjectionPoint[] = [];
  let cumulativeGross = 0;
  let cumulativeCharges = 0;
  // Token/add-on uplift is an INDEPENDENT additive net stream: the ARPU is
  // derived from token NET revenue, so it never runs through gross/fee math
  // (that would double-count processing fees) and never touches retention.
  const tokenArpu = Math.max(0, a.tokenArpuPerTrial ?? 0);
  const tokenHold = 1 - clamp01(a.tokenArpuDecay ?? 0);
  let cumulativeTokenNet = 0;
  for (let month = 0; month <= months; month += 1) {
    let grossThisMonth: number;
    let payingUsers: number;
    let chargesThisMonth: number;
    if (month === 0) {
      const upsellUsers = trialUsers * clamp01(a.upsellRate);
      grossThisMonth = trialUsers * a.trialPrice + upsellUsers * a.upsellValue;
      chargesThisMonth = trialUsers + upsellUsers;
      payingUsers = trialUsers;
    } else {
      payingUsers = trialUsers * clamp01(a.firstRenewalRate) * Math.pow(clamp01(a.monthlyRetention), month - 1);
      grossThisMonth = payingUsers * a.subscriptionPrice;
      chargesThisMonth = payingUsers;
    }
    cumulativeGross += grossThisMonth;
    cumulativeCharges += chargesThisMonth;
    cumulativeTokenNet += trialUsers * tokenArpu * Math.pow(tokenHold, month);
    points.push({
      month,
      day: month * MONTH_DAYS,
      payingUsers,
      grossRevenue: round2(grossThisMonth),
      cumulativeGrossRevenue: round2(cumulativeGross),
      cumulativeNetRevenue: round2(netFromGross(cumulativeGross, cumulativeCharges, a) + cumulativeTokenNet),
    });
  }
  return points;
}

/** Projected cumulative net revenue at a day offset (step function over the monthly schedule). */
export function projectedNetRevenueAtDay(projection: MonthlyProjectionPoint[], day: number): number {
  let value = 0;
  for (const point of projection) {
    if (point.day > day) break;
    value = point.cumulativeNetRevenue;
  }
  return value;
}

/**
 * Blended cumulative net revenue at a day offset: realized actuals up to the cohort's maturity, then
 * projected increments beyond it. This keeps Current/short ROAS realized and future ROAS projected.
 */
export function estimateFutureRevenue(
  actual: RevenueByDayResult,
  projection: MonthlyProjectionPoint[],
  day: number,
): number {
  if (day <= actual.maxDay) return actualNetRevenueAtDay(actual, day);
  const projectedNow = projectedNetRevenueAtDay(projection, actual.maxDay);
  const projectedThen = projectedNetRevenueAtDay(projection, day);
  return round2(actual.totalNet + (projectedThen - projectedNow));
}

// ---------------------------------------------------------------------------
// Phase 8 — payback day, break-even CAC, projected LTV
// ---------------------------------------------------------------------------

/**
 * First whole day where blended cumulative net revenue >= spend. Null when spend is unavailable or
 * never recovered within `maxScanDay`.
 */
export function calculatePaybackDay(
  actual: RevenueByDayResult,
  projection: MonthlyProjectionPoint[],
  spend: number | null | undefined,
  maxScanDay = HORIZON_DAYS.m12,
): number | null {
  if (spend == null || !Number.isFinite(spend) || spend <= 0) return null;
  // Candidate days: every actual activity day plus each projected month boundary.
  const candidates = new Set<number>([0]);
  for (const point of actual.points) candidates.add(point.day);
  for (const point of projection) if (point.day <= maxScanDay) candidates.add(point.day);
  const ordered = Array.from(candidates).sort((x, y) => x - y);
  for (const day of ordered) {
    if (day > maxScanDay) break;
    if (estimateFutureRevenue(actual, projection, day) >= spend) return day;
  }
  return null;
}

/** Projected LTV per trial user at a horizon (blended net revenue at horizon / trial users). */
export function calculateProjectedLTV(
  actual: RevenueByDayResult,
  projection: MonthlyProjectionPoint[],
  trialUsers: number,
  horizonDay: number,
): number {
  if (trialUsers <= 0) return 0;
  return round2(estimateFutureRevenue(actual, projection, horizonDay) / trialUsers);
}

/**
 * Break-even CAC = projected LTV at the horizon (the CAC at which profit per user is zero).
 * Max profitable CAC = LTV * (1 - marginTarget) when a margin target is set, else break-even.
 */
export function calculateBreakEvenCAC(projectedLtv: number): number {
  return round2(Math.max(0, projectedLtv));
}

export function calculateMaxProfitableCAC(projectedLtv: number, marginTarget?: number): number {
  const margin = marginTarget != null && Number.isFinite(marginTarget) ? clamp01(marginTarget) : 0;
  return round2(Math.max(0, projectedLtv) * (1 - margin));
}

// ---------------------------------------------------------------------------
// Phase 10 — spend / CAC
// ---------------------------------------------------------------------------

export interface SpendResolution {
  spend: number | null;
  spendAvailable: boolean;
  cac: number | null;
  source: "facebook" | "manual_spend" | "manual_cac" | "unavailable";
}

/**
 * Resolve spend and CAC with the documented priority:
 *   1. manual CAC override -> spend = cac * trialUsers
 *   2. manual spend override
 *   3. matched Facebook spend
 *   4. unavailable (never silently 0)
 */
export function resolveSpendAndCac(input: {
  trialUsers: number;
  facebookSpend: number | null;
  manualSpend?: number | null;
  manualCac?: number | null;
}): SpendResolution {
  const { trialUsers, facebookSpend, manualSpend, manualCac } = input;
  if (manualCac != null && Number.isFinite(manualCac)) {
    const spend = manualCac * trialUsers;
    return { spend: round2(spend), spendAvailable: true, cac: round2(manualCac), source: "manual_cac" };
  }
  if (manualSpend != null && Number.isFinite(manualSpend)) {
    return {
      spend: round2(manualSpend),
      spendAvailable: true,
      cac: trialUsers > 0 ? round2(manualSpend / trialUsers) : null,
      source: "manual_spend",
    };
  }
  if (facebookSpend != null && Number.isFinite(facebookSpend)) {
    return {
      spend: round2(facebookSpend),
      spendAvailable: true,
      cac: trialUsers > 0 ? round2(facebookSpend / trialUsers) : null,
      source: "facebook",
    };
  }
  return { spend: null, spendAvailable: false, cac: null, source: "unavailable" };
}

/** Sum matched Facebook spend for the given cohorts. Returns null when no cohort has traffic. */
export function facebookSpendForCohorts(
  cohorts: CohortRow[],
  trafficByKey: Map<string, TrafficAggregate>,
): number | null {
  let spend = 0;
  let matched = false;
  for (const cohort of cohorts) {
    const traffic = trafficByKey.get(cohortTrafficKey(cohort));
    if (!traffic) continue;
    matched = true;
    spend += traffic.spend;
  }
  return matched ? round2(spend) : null;
}

// ---------------------------------------------------------------------------
// Phase 8 — auto assumptions from real cohorts (reuses CohortRow fields only)
// ---------------------------------------------------------------------------

export interface AutoAssumptionValues {
  tokenArpuPerTrial: number;
  trialPrice: number;
  subscriptionPrice: number;
  upsellValue: number;
  upsellRate: number;
  firstRenewalRate: number;
  monthlyRetention: number;
  refundRate: number;
}

function sumBy<T>(rows: T[], get: (row: T) => number): number {
  return rows.reduce((total, row) => total + (get(row) || 0), 0);
}

/** Derive auto assumption values from selected cohorts (all fields already produced by computeCohorts). */
export function deriveAssumptionsFromCohorts(cohorts: CohortRow[]): AutoAssumptionValues {
  const trialUsers = sumBy(cohorts, (c) => c.trial_users);
  const upsellUsers = sumBy(cohorts, (c) => c.upsell_users);
  const firstSubUsers = sumBy(cohorts, (c) => c.first_subscription_users);
  const renewal2Users = sumBy(cohorts, (c) => c.renewal_2_users);
  const trialRevenue = sumBy(cohorts, (c) => c.trial_revenue);
  const upsellRevenue = sumBy(cohorts, (c) => c.upsell_revenue);
  const firstSubRevenue = sumBy(cohorts, (c) => c.first_subscription_revenue);
  const grossRevenue = sumBy(cohorts, (c) => c.gross_revenue);
  const amountRefunded = sumBy(cohorts, (c) => c.amount_refunded);

  const tokenNetRevenue = sumBy(cohorts, (c) => c.token_net_revenue ?? 0);

  return {
    tokenArpuPerTrial: trialUsers > 0 ? round2(tokenNetRevenue / trialUsers) : 0,
    trialPrice: trialUsers > 0 ? round2(trialRevenue / trialUsers) : 0,
    subscriptionPrice: firstSubUsers > 0 ? round2(firstSubRevenue / firstSubUsers) : 0,
    upsellValue: upsellUsers > 0 ? round2(upsellRevenue / upsellUsers) : 0,
    upsellRate: trialUsers > 0 ? round2(upsellUsers / trialUsers) : 0,
    firstRenewalRate: trialUsers > 0 ? round2(firstSubUsers / trialUsers) : 0,
    monthlyRetention: firstSubUsers > 0 ? round2(renewal2Users / firstSubUsers) : 0,
    refundRate: grossRevenue > 0 ? round2(amountRefunded / grossRevenue) : 0,
  };
}

// ---------------------------------------------------------------------------
// Phase 4/11 — status
// ---------------------------------------------------------------------------

export function paybackStatus(
  roas1M: number | null,
  paybackDay: number | null,
  hasData: boolean,
): PaybackStatus {
  if (!hasData || roas1M == null) return "unknown";
  if (roas1M >= 1.2 && paybackDay != null && paybackDay <= 30) return "scale";
  if (roas1M < 0.8) return "stop";
  if (paybackDay == null || paybackDay > 60) return "stop";
  return "watch";
}

// ---------------------------------------------------------------------------
// Phase 8 — dataset + per-cohort rows + summary + scenario
// ---------------------------------------------------------------------------

export interface SelectedCohortDataset {
  cohorts: CohortRow[];
  cohortIds: string[];
  trialUsers: number;
  grossRevenue: number;
  netRevenue: number;
  facebookSpend: number | null;
}

/** Aggregate the selected cohorts into a single dataset (spend matched from Facebook traffic). */
export function buildSelectedCohortDataset(
  cohorts: CohortRow[],
  trafficByKey: Map<string, TrafficAggregate>,
): SelectedCohortDataset {
  return {
    cohorts,
    cohortIds: cohorts.map((c) => c.cohort_id),
    trialUsers: sumBy(cohorts, (c) => c.trial_users),
    grossRevenue: round2(sumBy(cohorts, (c) => c.gross_revenue)),
    netRevenue: round2(sumBy(cohorts, (c) => c.net_revenue)),
    facebookSpend: facebookSpendForCohorts(cohorts, trafficByKey),
  };
}

export interface ForecastComputationInput {
  actual: RevenueByDayResult;
  trialUsers: number;
  spend: number | null;
  spendAvailable: boolean;
  cac: number | null;
  grossRevenue: number;
  netRevenue: number;
  assumptions: ForecastAssumptions;
  statusHorizonDay?: number; // horizon whose ROAS drives status/LTV (default 30)
}

function projectionForInput(input: ForecastComputationInput): MonthlyProjectionPoint[] {
  return projectMonthlyNetRevenue(input.trialUsers, input.assumptions, 12);
}

/** Full aggregate payback summary (KPI cards). */
export function calculatePaybackSummary(input: ForecastComputationInput): PaybackSummary {
  const projection = projectionForInput(input);
  const { actual, spend, trialUsers } = input;
  const statusHorizon = input.statusHorizonDay ?? HORIZON_DAYS.d30;

  const currentRoas = roas(input.netRevenue, spend);
  const roasAt = (day: number) => roas(estimateFutureRevenue(actual, projection, day), spend);
  const projectedLtv = calculateProjectedLTV(actual, projection, trialUsers, statusHorizon);
  const paybackDay = calculatePaybackDay(actual, projection, spend);

  return {
    trialUsers,
    spend,
    spendAvailable: input.spendAvailable,
    cac: input.cac,
    grossRevenue: round2(input.grossRevenue),
    netRevenue: round2(input.netRevenue),
    profit: spend != null ? round2(input.netRevenue - spend) : null,
    currentRoas,
    roasD7: roasAt(HORIZON_DAYS.d7),
    roas1M: roasAt(HORIZON_DAYS.d30),
    roas2M: roasAt(HORIZON_DAYS.d60),
    roas3M: roasAt(HORIZON_DAYS.d90),
    roas6M: roasAt(HORIZON_DAYS.m6),
    paybackDay,
    breakEvenCac: calculateBreakEvenCAC(projectedLtv),
    maxProfitableCac: calculateMaxProfitableCAC(projectedLtv, input.assumptions.marginTarget),
    projectedLtv,
    profitPerUser: input.cac != null ? round2(projectedLtv - input.cac) : null,
  };
}

export interface ScenarioResult {
  base: PaybackSummary;
  scenario: PaybackSummary;
  deltaRoas1M: number | null;
  deltaPaybackDay: number | null;
  deltaProfit: number | null;
}

/** Compare a base computation against a scenario (different assumptions and/or CAC/spend). */
export function calculateScenario(
  base: ForecastComputationInput,
  scenario: ForecastComputationInput,
): ScenarioResult {
  const baseSummary = calculatePaybackSummary(base);
  const scenarioSummary = calculatePaybackSummary(scenario);
  const deltaRoas1M =
    baseSummary.roas1M != null && scenarioSummary.roas1M != null
      ? round2(scenarioSummary.roas1M - baseSummary.roas1M)
      : null;
  const deltaPaybackDay =
    baseSummary.paybackDay != null && scenarioSummary.paybackDay != null
      ? scenarioSummary.paybackDay - baseSummary.paybackDay
      : null;
  const deltaProfit =
    baseSummary.profit != null && scenarioSummary.profit != null
      ? round2(scenarioSummary.profit - baseSummary.profit)
      : null;
  return { base: baseSummary, scenario: scenarioSummary, deltaRoas1M, deltaPaybackDay, deltaProfit };
}

// ---------------------------------------------------------------------------
// Phase 4 — per-cohort rows
// ---------------------------------------------------------------------------

/** Segment descriptors for a cohort's rows (GEO/card/media-buyer come from the current filter). */
export interface CohortRowContext {
  mediaBuyer: string;
  geo: string;
  cardType: string;
}

/**
 * One payback row per cohort. `txs` are all analytics transactions (attribution is scoped to each
 * cohort internally). `assumptionsFor` supplies assumptions per cohort (usually the shared set).
 */
export function buildCohortPaybackRows(
  cohorts: CohortRow[],
  txs: Transaction[],
  trafficByKey: Map<string, TrafficAggregate>,
  assumptions: ForecastAssumptions,
  context: CohortRowContext = { mediaBuyer: "all", geo: "all", cardType: "all" },
): CohortPaybackRow[] {
  const actualByCohort = calculateActualRevenueByDayByCohort(txs, cohorts.map((c) => c.cohort_id));
  return cohorts.map((cohort) => {
    const actual = actualByCohort.get(cohort.cohort_id) ?? { points: [], maxDay: 0, totalNet: 0 };
    const facebookSpend = facebookSpendForCohorts([cohort], trafficByKey);
    const spendResolution = resolveSpendAndCac({
      trialUsers: cohort.trial_users,
      facebookSpend,
      manualCac: assumptions.cac,
    });
    const input: ForecastComputationInput = {
      actual,
      trialUsers: cohort.trial_users,
      spend: spendResolution.spend,
      spendAvailable: spendResolution.spendAvailable,
      cac: spendResolution.cac,
      grossRevenue: cohort.gross_revenue,
      netRevenue: cohort.net_revenue,
      assumptions: { ...assumptions, ...deriveAssumptionsFromCohorts([cohort]), cac: assumptions.cac },
    };
    const summary = calculatePaybackSummary(input);
    const hasData = cohort.trial_users > 0 && spendResolution.spendAvailable;
    return {
      cohortId: cohort.cohort_id,
      cohortDate: cohort.cohort_date,
      funnel: cohort.funnel,
      campaignPath: cohort.campaign_path,
      mediaBuyer: context.mediaBuyer,
      geo: context.geo,
      cardType: context.cardType,
      trialUsers: cohort.trial_users,
      spend: summary.spend,
      spendAvailable: summary.spendAvailable,
      cac: summary.cac,
      grossRevenue: summary.grossRevenue,
      netRevenue: summary.netRevenue,
      currentRoas: summary.currentRoas,
      roasD7: summary.roasD7,
      roas1M: summary.roas1M,
      roas2M: summary.roas2M,
      roas3M: summary.roas3M,
      paybackDay: summary.paybackDay,
      projectedLtv: summary.projectedLtv,
      profitPerUser: summary.profitPerUser,
      status: paybackStatus(summary.roas1M, summary.paybackDay, hasData),
    };
  });
}

// ---------------------------------------------------------------------------
// Phase 5 — payback curve (aggregate or single cohort)
// ---------------------------------------------------------------------------

export interface PaybackCurvePoint {
  day: number;
  cumulativeNet: number;
  projected: boolean;
}

/**
 * Cumulative net revenue vs a flat spend line, for the payback chart. Actual daily points up to the
 * cohort maturity, then projected month boundaries beyond it (flagged `projected: true`).
 */
export function buildPaybackCurve(
  actual: RevenueByDayResult,
  projection: MonthlyProjectionPoint[],
  maxDay = HORIZON_DAYS.m12,
): PaybackCurvePoint[] {
  const points: PaybackCurvePoint[] = [{ day: 0, cumulativeNet: 0, projected: false }];
  for (const point of actual.points) {
    if (point.day > maxDay) break;
    points.push({ day: point.day, cumulativeNet: point.cumulativeNet, projected: false });
  }
  for (const point of projection) {
    if (point.day <= actual.maxDay || point.day > maxDay) continue;
    points.push({
      day: point.day,
      cumulativeNet: estimateFutureRevenue(actual, projection, point.day),
      projected: true,
    });
  }
  return points.sort((a, b) => a.day - b.day);
}
