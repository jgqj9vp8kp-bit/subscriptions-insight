// Weekly report — the deterministic layer (R2).
//
// Turns already-fetched engine output into a ReportSnapshot: every number the
// report can show, its comparison against the previous period, and an evidence
// path back to the value that backs it. No AI, no network, no clock — the
// caller passes `collectedAt`, so the same inputs always produce the same
// snapshot and a saved report replays byte-identically.
//
// It does NOT fetch. Collection is the caller's job (the browser composes the
// existing cached queries, so the report's numbers are literally the objects
// the pages already show). This module owns only the arithmetic that turns
// them into a report, and the honesty rules around it.
//
// Pure module: no Deno APIs, no browser APIs.
import type { CohortAggregateRow } from "./cohortContract.ts";
import type {
  ReportDelta,
  ReportDirection,
  ReportEngineVersions,
  ReportFunnelPassport,
  ReportFunnelRow,
  ReportGap,
  ReportMetric,
  ReportProvenanceEntry,
  ReportSnapshot,
  ReportTarget,
  ReportTargetCheck,
  ReportUnavailable,
  ReportUnavailableReason,
  ReportValue,
  ReportWindow,
} from "./reportContract.ts";
import { REPORT_ENGINE_VERSION, REPORT_SCHEMA_VERSION, resolveTarget } from "./reportContract.ts";
import { round2 } from "./financialPrimitives.ts";

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Russian conventions, matching how the weekly reports already write numbers:
 * space for thousands, comma for decimals ("12 106,00 $", "53,8%"). Hand-rolled
 * rather than Intl so the string is identical in Deno, the browser and vitest —
 * a snapshot that renders differently per runtime is not replayable. */
function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

function fixed(value: number, decimals: number): string {
  const negative = value < 0;
  const [whole, fraction = ""] = Math.abs(value).toFixed(decimals).split(".");
  const body = fraction ? `${groupDigits(whole)},${fraction}` : groupDigits(whole);
  return negative ? `−${body}` : body;
}

export function renderMoney(value: number): string {
  return `${fixed(value, 2)} $`;
}

export function renderCount(value: number): string {
  return fixed(Math.round(value), 0);
}

export function renderPercent(value: number): string {
  return `${fixed(value, 1)}%`;
}

export function renderRatio(value: number): string {
  return fixed(value, 2);
}

function renderUnit(value: number, unit: ReportValue["unit"]): string {
  switch (unit) {
    case "money": return renderMoney(value);
    case "count": return renderCount(value);
    case "percent": return renderPercent(value);
    case "days": return `${renderCount(value)} дн.`;
    case "ratio": return renderRatio(value);
  }
}

/** The em dash every unavailable number renders as. Never "0". */
export const UNAVAILABLE_RENDER = "—";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function unavailable(
  reason: ReportUnavailableReason,
  detail: string,
  wouldNeed?: string,
): ReportUnavailable {
  return wouldNeed ? { status: "unavailable", reason, detail, wouldNeed } : { status: "unavailable", reason, detail };
}

export function value(
  raw: number | null,
  unit: ReportValue["unit"],
  evidence: string,
  gap?: ReportUnavailable,
): ReportValue {
  if (gap || raw === null || !Number.isFinite(raw)) {
    return {
      value: null,
      rendered: UNAVAILABLE_RENDER,
      unit,
      source: "computed",
      evidence,
      unavailable: gap ?? unavailable("no_source", "Значение недоступно."),
    };
  }
  return { value: raw, rendered: renderUnit(raw, unit), unit, source: "computed", evidence };
}

/**
 * A ratio, or `null` when the denominator cannot support one.
 *
 * Never returns 0 for "no data": a 0% conversion and an unmeasured conversion
 * read identically on the page but mean opposite things, and the weekly reports
 * are explicit about the difference ("рано делать выводы").
 */
export function ratio(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

export function percent(numerator: number, denominator: number): number | null {
  const r = ratio(numerator, denominator);
  return r === null ? null : round2(r * 100);
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

/** Which way is good news. Decided by code, never by the model: CPA falling is
 * good, trials falling is bad, refunds falling is good. */
export type MetricPolarity = "higher_better" | "lower_better" | "neutral";

export interface DeltaOptions {
  polarity: MetricPolarity;
  /** Below this denominator a move is reported but never called significant. */
  minSample?: number;
  sampleSize?: number | null;
  /** Relative move that counts as material, e.g. 0.05 for 5%. */
  minRelative?: number;
  /** Absolute move that counts as material, in the metric's own unit. */
  minAbsolute?: number;
}

export const DEFAULT_MIN_RELATIVE = 0.05;
/** Reused from the forecasting layer's own low-volume gate so the two features
 * call the same sample "too small". */
export const DEFAULT_MIN_SAMPLE = 50;

export function computeDelta(
  current: number | null,
  previous: number | null,
  unit: ReportValue["unit"],
  options: DeltaOptions,
): ReportDelta | null {
  if (current === null || previous === null) return null;

  const absolute = round2(current - previous);
  const pct = previous === 0 ? null : round2(((current - previous) / Math.abs(previous)) * 100);
  const direction: ReportDirection = absolute > 0 ? "up" : absolute < 0 ? "down" : "flat";

  let better: boolean | null = null;
  if (options.polarity !== "neutral" && direction !== "flat") {
    const wantsUp = options.polarity === "higher_better";
    better = wantsUp ? direction === "up" : direction === "down";
  }

  const minRelative = options.minRelative ?? DEFAULT_MIN_RELATIVE;
  const relativeOk = previous === 0
    ? Math.abs(absolute) > 0
    : Math.abs(current - previous) / Math.abs(previous) >= minRelative;
  const absoluteOk = options.minAbsolute === undefined
    ? true
    : Math.abs(absolute) >= options.minAbsolute;
  const sampleOk = options.sampleSize === null || options.sampleSize === undefined
    ? true
    : options.sampleSize >= (options.minSample ?? DEFAULT_MIN_SAMPLE);

  return {
    previous,
    previousRendered: renderUnit(previous, unit),
    absolute,
    absoluteRendered: `${absolute > 0 ? "+" : ""}${renderUnit(absolute, unit)}`,
    percent: pct,
    percentRendered: pct === null ? UNAVAILABLE_RENDER : `${pct > 0 ? "+" : ""}${renderPercent(pct)}`,
    direction,
    better,
    significant: direction !== "flat" && relativeOk && absoluteOk && sampleOk,
  };
}

export function checkTarget(
  current: number | null,
  target: ReportTarget | null,
  unit: ReportValue["unit"],
): ReportTargetCheck | null {
  if (!target) return null;
  const met = current === null
    ? null
    : target.comparator === "gte" ? current >= target.targetValue : current <= target.targetValue;
  return {
    target: target.targetValue,
    comparator: target.comparator,
    met,
    rendered: `${target.comparator === "gte" ? "≥" : "≤"} ${renderUnit(target.targetValue, unit)}`,
  };
}

// ---------------------------------------------------------------------------
// Cohort rollup
// ---------------------------------------------------------------------------

/**
 * Everything the report needs from a set of cohort rows.
 *
 * Deliberately NOT CohortTotals: that contract omits upsell_users,
 * renewal_users, the revenue split by type, revenue_d14, token_gross_revenue
 * and every fb_* field, so half of this would silently come back undefined.
 */
export interface CohortRollup {
  cohorts: number;
  trialUsers: number;
  upsellUsers: number;
  upsell1Users: number;
  upsell2Users: number;
  upsell3Users: number;
  firstSubscriptionUsers: number;
  renewalUsers: number;
  renewalUsersByLevel: Record<number, number>;
  refundUsers: number;
  supportUsers: number;
  tokenBuyers: number;
  tokenPurchases: number;
  activeUsers: number;
  activeSubscriptions: number;
  cancelledUsers: number;
  grossRevenue: number;
  netRevenue: number;
  amountRefunded: number;
  trialRevenue: number;
  upsellRevenue: number;
  firstSubscriptionRevenue: number;
  renewalRevenue: number;
  tokenNetRevenue: number;
  addonRevenue: number;
  revenueD0: number;
  revenueD7: number;
  revenueD14: number;
  revenueD30: number;
  revenueD60: number;
  /** null when no row carried spend at all — the difference between "no spend"
   * and "spend not measured" is exactly what the FB path can lose. */
  fbSpend: number | null;
  rowsWithSpend: number;
}

/** The observation windows AGGREGATE_MEASURES actually materialises. */
export const AGE_MATCH_DAYS = [0, 7, 14, 30, 60] as const;

export function revenueAtDay(rollup: CohortRollup, day: number): number | null {
  switch (day) {
    case 0: return rollup.revenueD0;
    case 7: return rollup.revenueD7;
    case 14: return rollup.revenueD14;
    case 30: return rollup.revenueD30;
    case 60: return rollup.revenueD60;
    default: return null;
  }
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.floor((b - a) / 86_400_000);
}

/**
 * The largest observation window BOTH periods have completed.
 *
 * This is the correctness centre of the whole comparison. Cohort revenue
 * accumulates with age, so last week's cohorts have had two to eight days to
 * earn while the comparison week's have had nine to fifteen. Putting those two
 * lifetime sums side by side manufactures a 60% collapse out of nothing but the
 * calendar — the single fastest way to destroy trust in the report.
 *
 * Comparing revenue_dN for the same N on both sides removes the age entirely:
 * every cohort in the frame is measured over the same number of days.
 */
export function ageMatchedWindow(
  period: ReportWindow,
  compare: ReportWindow | null,
  asOfDate: string,
): number | null {
  const youngestInPeriod = daysBetween(period.to, asOfDate);
  const youngestInCompare = compare ? daysBetween(compare.to, asOfDate) : youngestInPeriod;
  const usable = Math.min(youngestInPeriod, youngestInCompare);
  const fits = AGE_MATCH_DAYS.filter((day) => day <= usable);
  return fits.length ? Math.max(...fits) : null;
}

function addLevels(into: Record<number, number>, from: Record<number, number> | undefined): void {
  if (!from) return;
  for (const [level, count] of Object.entries(from)) {
    const key = Number(level);
    into[key] = (into[key] ?? 0) + Number(count ?? 0);
  }
}

const n = (v: number | null | undefined): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Sum cohort rows.
 *
 * Counts that come from the email-keyed subscription overlay (active users,
 * active subscriptions, refunds, token buyers, cancellations) are deduplicated
 * through the row's own hash sets, because one person can appear under more
 * than one cohort there. Trial-anchored counts need no dedup: every user has
 * exactly one trial cohort by construction.
 */
export function rollupCohorts(rows: readonly CohortAggregateRow[]): CohortRollup {
  const dedup = {
    activeUsers: new Set<string>(),
    activeSubscriptions: new Set<string>(),
    refundUsers: new Set<string>(),
    cancelledUsers: new Set<string>(),
    tokenBuyers: new Set<string>(),
  };
  const renewalUsersByLevel: Record<number, number> = {};

  let fbSpend = 0;
  let rowsWithSpend = 0;
  const acc = {
    trialUsers: 0, upsellUsers: 0, upsell1Users: 0, upsell2Users: 0, upsell3Users: 0,
    firstSubscriptionUsers: 0, renewalUsers: 0, supportUsers: 0, tokenPurchases: 0,
    grossRevenue: 0, netRevenue: 0, amountRefunded: 0, trialRevenue: 0, upsellRevenue: 0,
    firstSubscriptionRevenue: 0, renewalRevenue: 0, tokenNetRevenue: 0, addonRevenue: 0,
    revenueD0: 0, revenueD7: 0, revenueD14: 0, revenueD30: 0, revenueD60: 0,
  };

  for (const row of rows) {
    acc.trialUsers += n(row.trial_users);
    acc.upsellUsers += n(row.upsell_users);
    acc.upsell1Users += n(row.upsell_1_users);
    acc.upsell2Users += n(row.upsell_2_users);
    acc.upsell3Users += n(row.upsell_3_users);
    acc.firstSubscriptionUsers += n(row.first_subscription_users);
    acc.renewalUsers += n(row.renewal_users);
    acc.supportUsers += n(row.support_users);
    acc.tokenPurchases += n(row.token_purchases);
    acc.grossRevenue += n(row.gross_revenue);
    acc.netRevenue += n(row.net_revenue);
    acc.amountRefunded += n(row.amount_refunded);
    acc.trialRevenue += n(row.trial_revenue);
    acc.upsellRevenue += n(row.upsell_revenue);
    acc.firstSubscriptionRevenue += n(row.first_subscription_revenue);
    acc.renewalRevenue += n(row.renewal_revenue);
    acc.tokenNetRevenue += n(row.token_net_revenue);
    acc.addonRevenue += n(row.addon_revenue);
    acc.revenueD0 += n(row.revenue_d0);
    acc.revenueD7 += n(row.revenue_d7);
    acc.revenueD14 += n(row.revenue_d14);
    acc.revenueD30 += n(row.revenue_d30);
    acc.revenueD60 += n(row.revenue_d60);
    addLevels(renewalUsersByLevel, row.renewal_users_by_level);

    if (row.fb_spend !== null && row.fb_spend !== undefined) {
      fbSpend += n(row.fb_spend);
      rowsWithSpend += 1;
    }

    const d = row.dedup;
    if (d) {
      d.active_user_hashes?.forEach((h) => dedup.activeUsers.add(h));
      d.active_subscription_hashes?.forEach((h) => dedup.activeSubscriptions.add(h));
      d.refunded_user_hashes?.forEach((h) => dedup.refundUsers.add(h));
      d.cancelled_user_hashes?.forEach((h) => dedup.cancelledUsers.add(h));
      d.token_buyer_hashes?.forEach((h) => dedup.tokenBuyers.add(h));
    }
  }

  return {
    cohorts: rows.length,
    ...acc,
    grossRevenue: round2(acc.grossRevenue),
    netRevenue: round2(acc.netRevenue),
    amountRefunded: round2(acc.amountRefunded),
    trialRevenue: round2(acc.trialRevenue),
    upsellRevenue: round2(acc.upsellRevenue),
    firstSubscriptionRevenue: round2(acc.firstSubscriptionRevenue),
    renewalRevenue: round2(acc.renewalRevenue),
    tokenNetRevenue: round2(acc.tokenNetRevenue),
    addonRevenue: round2(acc.addonRevenue),
    revenueD0: round2(acc.revenueD0),
    revenueD7: round2(acc.revenueD7),
    revenueD14: round2(acc.revenueD14),
    revenueD30: round2(acc.revenueD30),
    revenueD60: round2(acc.revenueD60),
    renewalUsersByLevel,
    refundUsers: dedup.refundUsers.size,
    tokenBuyers: dedup.tokenBuyers.size,
    activeUsers: dedup.activeUsers.size,
    activeSubscriptions: dedup.activeSubscriptions.size,
    cancelledUsers: dedup.cancelledUsers.size,
    fbSpend: rowsWithSpend > 0 ? round2(fbSpend) : null,
    rowsWithSpend,
  };
}

// ---------------------------------------------------------------------------
// Maturity
// ---------------------------------------------------------------------------

function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

/**
 * Whether a cohort is old enough for its trial→subscription conversion to mean
 * anything.
 *
 * A trial started three days ago on a seven-day trial has not had the chance to
 * convert; counting it drags the rate toward zero and invents a decline. The
 * reports say this out loud every week ("только начали получать статистику"),
 * so the code has to model it rather than average it away.
 */
export function isCohortMature(
  cohortDate: string,
  trialDurationDays: number | null,
  asOfDate: string,
): boolean {
  if (trialDurationDays === null || !Number.isFinite(trialDurationDays)) return false;
  return addDays(cohortDate, Math.max(0, Math.round(trialDurationDays))) <= asOfDate;
}

export interface MaturitySplit {
  mature: CohortAggregateRow[];
  immature: CohortAggregateRow[];
}

export function splitByMaturity(
  rows: readonly CohortAggregateRow[],
  trialDurationFor: (funnelPath: string) => number | null,
  asOfDate: string,
): MaturitySplit {
  const mature: CohortAggregateRow[] = [];
  const immature: CohortAggregateRow[] = [];
  for (const row of rows) {
    (isCohortMature(row.cohort_date, trialDurationFor(row.campaign_path), asOfDate) ? mature : immature)
      .push(row);
  }
  return { mature, immature };
}

// ---------------------------------------------------------------------------
// Spend availability
// ---------------------------------------------------------------------------

/** Whether the materialized cohort snapshot — the only path that merges FB
 * spend onto cohort rows — is usable. */
export type SnapshotStatus = "current" | "stale" | "missing";

/**
 * Why spend is not usable, or null when it is.
 *
 * computeFbCohortStats runs in exactly one place (the materialized cohort
 * list), so on the dynamic fallback every fb_* field is absent. Spend, CPA and
 * everything derived from them must then say so rather than sum a column of
 * undefineds into a confident 0.
 */
export function spendUnavailable(
  status: SnapshotStatus,
  rollup: CohortRollup,
): ReportUnavailable | null {
  if (status === "missing") {
    return unavailable(
      "snapshot_stale",
      "Спенд не посчитан: активного снапшота когорт нет, а рекламные расходы приезжают только с него.",
      "Пересобрать снапшот когорт (Cohorts → обновление склада).",
    );
  }
  if (status === "stale") {
    return unavailable(
      "snapshot_stale",
      "Снапшот когорт устарел, спенд может не соответствовать периоду.",
      "Пересобрать снапшот когорт.",
    );
  }
  if (rollup.fbSpend === null) {
    return unavailable(
      "no_source",
      "Ни одна когорта периода не принесла рекламных расходов.",
      "Проверить синхронизацию Facebook и привязку кампаний к воронкам.",
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export interface ReportBuilderInput {
  period: ReportWindow;
  compare: ReportWindow | null;
  /** Cohort rows whose cohort_date falls inside each window. */
  periodRows: readonly CohortAggregateRow[];
  compareRows: readonly CohortAggregateRow[];
  passports: Readonly<Record<string, ReportFunnelPassport>>;
  targets: readonly ReportTarget[];
  gaps: readonly ReportGap[];
  provenance: readonly ReportProvenanceEntry[];
  engineVersions: ReportEngineVersions;
  snapshotStatus: SnapshotStatus;
  warehouseVersionBefore: string | null;
  warehouseVersionAfter: string | null;
  /** ISO timestamp, injected — the module never reads a clock. */
  collectedAt: string;
  /** Days of FB spend inside the window that are known to be missing. */
  knownGapDays?: readonly string[];
}

interface MetricSpec {
  key: string;
  label: string;
  unit: ReportValue["unit"];
  polarity: MetricPolarity;
  /** Pulled from a rollup; null means "not measurable from this rollup". */
  pick: (r: CohortRollup, mature: CohortRollup) => number | null;
  /** Denominator that decides whether a move is significant. */
  sample?: (r: CohortRollup, mature: CohortRollup) => number | null;
  /** True when the metric depends on advertising spend. */
  needsSpend?: boolean;
  /** True when the metric is only meaningful on matured cohorts. */
  needsMaturity?: boolean;
  /** Reads revenue at the age-matched day instead of a lifetime sum. */
  ageMatched?: (r: CohortRollup, day: number) => number | null;
  /** Suppress the period comparison: the value is real but not comparable
   * across periods whose cohorts differ in age. */
  noDelta?: boolean;
  /** Overrides the label once the matched window is known. */
  labelWithDay?: (day: number) => string;
  /** Needs a full 30-day observation window on both sides. */
  needsMonth?: boolean;
  /**
   * Suppress the comparison until both periods have been observed for at least
   * this many days. Conversion keeps arriving after the trial ends, so a cohort
   * observed for one post-trial day and one observed for eight are not
   * comparable even though both are "mature" — the value is an early signal,
   * the delta would be an artefact.
   */
  deltaNeedsDays?: number;
}

/** The MVP KPI table. Order is the order the report renders. */
export const KPI_SPECS: readonly MetricSpec[] = [
  { key: "revenue_matched", label: "Выручка когорт", unit: "money", polarity: "higher_better",
    pick: () => null, ageMatched: (r, day) => revenueAtDay(r, day),
    labelWithDay: (day) => `Выручка когорт (D${day})`, sample: (r) => r.trialUsers },
  { key: "gross_revenue", label: "Gross Revenue (накоплено)", unit: "money", polarity: "higher_better",
    pick: (r) => r.grossRevenue, noDelta: true },
  { key: "net_revenue", label: "Net Revenue (накоплено)", unit: "money", polarity: "higher_better",
    pick: (r) => r.netRevenue, noDelta: true },
  { key: "refund_amount", label: "Refunds", unit: "money", polarity: "lower_better",
    pick: (r) => r.amountRefunded, noDelta: true },
  { key: "refund_rate", label: "Refund rate", unit: "percent", polarity: "lower_better",
    pick: (r) => percent(r.amountRefunded, r.grossRevenue), sample: (r) => r.trialUsers },
  { key: "spend", label: "Spend", unit: "money", polarity: "neutral",
    pick: (r) => r.fbSpend, needsSpend: true },
  { key: "trials", label: "Триалы", unit: "count", polarity: "higher_better",
    pick: (r) => r.trialUsers },
  { key: "first_subscriptions", label: "Первые подписки", unit: "count", polarity: "higher_better",
    pick: (_r, m) => m.firstSubscriptionUsers, needsMaturity: true, deltaNeedsDays: 14 },
  { key: "blended_cpa", label: "Blended CPA", unit: "money", polarity: "lower_better",
    pick: (r) => (r.fbSpend === null ? null : ratio(r.fbSpend, r.trialUsers)),
    sample: (r) => r.trialUsers, needsSpend: true },
  { key: "trial_to_sub_cr", label: "Trial → Subscription CR", unit: "percent", polarity: "higher_better",
    pick: (_r, m) => percent(m.firstSubscriptionUsers, m.trialUsers),
    sample: (_r, m) => m.trialUsers, needsMaturity: true, deltaNeedsDays: 14 },
  { key: "upsell_cr", label: "Upsell CR", unit: "percent", polarity: "higher_better",
    pick: (r) => percent(r.upsellUsers, r.trialUsers), sample: (r) => r.trialUsers },
  { key: "token_cr", label: "Token purchase CR", unit: "percent", polarity: "higher_better",
    pick: (r) => percent(r.tokenBuyers, r.trialUsers), sample: (r) => r.trialUsers },
  { key: "support_rate", label: "Support rate", unit: "percent", polarity: "lower_better",
    pick: (r) => percent(r.supportUsers, r.trialUsers), sample: (r) => r.trialUsers },
  { key: "ltv_1m", label: "LTV 1 мес", unit: "money", polarity: "higher_better",
    pick: (r) => ratio(r.revenueD30, r.trialUsers), sample: (r) => r.trialUsers, needsMonth: true },
  { key: "active_subscriptions", label: "Активные подписки", unit: "count", polarity: "higher_better",
    pick: (r) => r.activeSubscriptions, noDelta: true },
];

function buildMetric(
  spec: MetricSpec,
  current: CohortRollup,
  currentMature: CohortRollup,
  previous: CohortRollup | null,
  previousMature: CohortRollup | null,
  targets: readonly ReportTarget[],
  periodEnd: string,
  spendGap: ReportUnavailable | null,
  maturityGap: ReportUnavailable | null,
  matchedDay: number | null,
  monthGap: ReportUnavailable | null,
  evidencePrefix = "kpi",
): ReportMetric {
  const evidence = `${evidencePrefix}.${spec.key}`;

  // An age-matched metric with no common window is not a zero — there is simply
  // no span over which both periods have been observed yet.
  const ageGap: ReportUnavailable | null = spec.ageMatched && matchedDay === null
    ? unavailable(
        "not_mature",
        "Нет общего окна наблюдения: когорты периода и периода сравнения прожили разное число дней.",
        "Дождаться, пока обе недели проживут хотя бы 7 дней.",
      )
    : null;

  const gap = (spec.needsSpend && spendGap)
    || (spec.needsMaturity && maturityGap)
    || (spec.needsMonth && monthGap)
    || ageGap
    || undefined;

  const read = (rollup: CohortRollup, mature: CohortRollup): number | null =>
    spec.ageMatched && matchedDay !== null ? spec.ageMatched(rollup, matchedDay) : spec.pick(rollup, mature);

  const raw = gap ? null : read(current, currentMature);
  const sampleSize = spec.sample ? spec.sample(current, currentMature) : null;
  const previousRaw = gap || !previous || !previousMature ? null : read(previous, previousMature);

  return {
    key: spec.key,
    label: spec.labelWithDay && matchedDay !== null ? spec.labelWithDay(matchedDay) : spec.label,
    current: value(raw, spec.unit, evidence, gap ?? undefined),
    // A suppressed delta is not an oversight: these values accumulate with
    // cohort age, so comparing last week's two-day-old sum with the previous
    // week's nine-day-old sum reports the calendar, not the business.
    delta: spec.noDelta || (spec.deltaNeedsDays !== undefined && (matchedDay ?? 0) < spec.deltaNeedsDays)
      ? null
      : computeDelta(raw, previousRaw, spec.unit, {
      polarity: spec.polarity,
      sampleSize,
      minSample: spec.sample ? DEFAULT_MIN_SAMPLE : undefined,
    }),
    target: checkTarget(raw, resolveTarget(targets, spec.key, periodEnd), spec.unit),
    sampleSize,
  };
}

function passportFor(
  funnelPath: string,
  passports: Readonly<Record<string, ReportFunnelPassport>>,
): ReportFunnelPassport {
  const known = passports[funnelPath];
  if (known) return known;
  return {
    funnelPath,
    displayName: funnelPath,
    trialPrice: null, trialCurrency: null, trialDurationDays: null,
    subscriptionPrice: null, subscriptionCurrency: null, billingPeriod: null,
    upsells: [], defaultLanguage: null, defaultCurrency: null,
    geoLocalization: [], destination: null, product: null, trafficSources: [],
    incomplete: true,
  };
}

function groupByFunnel(
  rows: readonly CohortAggregateRow[],
): Map<string, CohortAggregateRow[]> {
  const grouped = new Map<string, CohortAggregateRow[]>();
  for (const row of rows) {
    const key = row.campaign_path || "unknown";
    const bucket = grouped.get(key);
    if (bucket) bucket.push(row);
    else grouped.set(key, [row]);
  }
  return grouped;
}

/** Per-funnel metrics. A subset of the KPI list: the numbers the weekly report
 * actually prints under each funnel URL. */
export const FUNNEL_METRIC_KEYS: readonly string[] = [
  "spend", "trials", "blended_cpa", "trial_to_sub_cr", "revenue_matched",
  "upsell_cr", "token_cr", "support_rate", "refund_rate",
];

export function buildReportSnapshot(input: ReportBuilderInput): ReportSnapshot {
  const asOfDate = input.collectedAt.slice(0, 10);
  const trialDurationFor = (funnelPath: string): number | null =>
    input.passports[funnelPath]?.trialDurationDays ?? null;

  const periodRollup = rollupCohorts(input.periodRows);
  const compareRollup = input.compareRows.length || input.compare
    ? rollupCohorts(input.compareRows)
    : null;

  const periodMatureRows = splitByMaturity(input.periodRows, trialDurationFor, asOfDate);
  const periodMature = rollupCohorts(periodMatureRows.mature);
  const compareMature = input.compare
    ? rollupCohorts(splitByMaturity(input.compareRows, trialDurationFor, asOfDate).mature)
    : null;

  const spendGap = spendUnavailable(input.snapshotStatus, periodRollup);
  const matchedDay = ageMatchedWindow(input.period, input.compare, asOfDate);

  // LTV over 30 days needs 30 days of observation on BOTH sides. Dividing a
  // two-day-old cohort's revenue by its trials and calling it "LTV 1 месяц" is
  // arithmetic, not a measurement.
  const monthGap: ReportUnavailable | null = (matchedDay ?? 0) >= 30
    ? null
    : unavailable(
        "not_mature",
        "LTV за месяц не считается: когортам периода ещё нет 30 дней.",
        "Отчёт за неделю месячной давности покажет её.",
      );

  // A cohort with no known trial length can never be proved mature, so a
  // conversion rate over it would be a guess. Say so instead of guessing.
  const maturityGap: ReportUnavailable | null = periodMature.trialUsers > 0
    ? null
    : unavailable(
        "not_mature",
        periodRollup.trialUsers > 0
          ? "Конверсия не считается: ни одна когорта периода ещё не прошла триал (или не заполнена длительность триала в паспорте воронки)."
          : "В периоде нет триалов.",
        "Заполнить длительность триала на странице Funnels, либо дождаться окончания триалов.",
      );

  const provisionalReasons: string[] = [];
  if (spendGap) provisionalReasons.push("spend_unavailable");
  if (maturityGap) provisionalReasons.push("conversion_immature");
  if (input.knownGapDays?.length) provisionalReasons.push("spend_incomplete");
  if (input.warehouseVersionBefore && input.warehouseVersionAfter &&
      input.warehouseVersionBefore !== input.warehouseVersionAfter) {
    provisionalReasons.push("warehouse_moved_during_collection");
  }
  if (periodMatureRows.immature.length > 0) provisionalReasons.push("immature_cohorts_present");
  if (matchedDay === null) provisionalReasons.push("no_age_matched_window");

  const kpi: Record<string, ReportMetric> = {};
  for (const spec of KPI_SPECS) {
    kpi[spec.key] = buildMetric(
      spec, periodRollup, periodMature, compareRollup, compareMature,
      input.targets, input.period.to, spendGap, maturityGap, matchedDay, monthGap,
    );
  }

  const compareByFunnel = groupByFunnel(input.compareRows);
  const funnels: ReportFunnelRow[] = [];
  for (const [funnelPath, rows] of groupByFunnel(input.periodRows)) {
    const rollup = rollupCohorts(rows);
    const mature = rollupCohorts(
      splitByMaturity(rows, trialDurationFor, asOfDate).mature);
    const previousRows = compareByFunnel.get(funnelPath) ?? [];
    const previousRollup = previousRows.length ? rollupCohorts(previousRows) : null;
    const previousMature = previousRows.length
      ? rollupCohorts(splitByMaturity(previousRows, trialDurationFor, asOfDate).mature)
      : null;

    const funnelSpendGap = spendUnavailable(input.snapshotStatus, rollup);
    const funnelMaturityGap: ReportUnavailable | null = mature.trialUsers > 0
      ? null
      : unavailable("not_mature", "Триалы этой воронки ещё не закончились.");

    const metrics: Record<string, ReportMetric> = {};
    for (const key of FUNNEL_METRIC_KEYS) {
      const spec = KPI_SPECS.find((s) => s.key === key);
      if (!spec) continue;
      const metric = buildMetric(
        spec, rollup, mature, previousRollup, previousMature,
        input.targets, input.period.to, funnelSpendGap, funnelMaturityGap, matchedDay, monthGap,
        `funnels[${funnelPath}]`,
      );
      metrics[key] = metric;
    }

    funnels.push({
      funnelPath,
      passport: passportFor(funnelPath, input.passports),
      metrics,
      // R3 replaces this with the rule engine's verdict; until then every row
      // is honestly "not judged yet" rather than wearing a made-up status.
      status: { status: "insufficient_data", because: "Статусы появятся на шаге R3.", ruleId: "pending" },
      isNew: previousRows.length === 0,
    });
  }
  funnels.sort((a, b) => {
    const spendA = a.metrics.spend?.current.value ?? -1;
    const spendB = b.metrics.spend?.current.value ?? -1;
    if (spendA !== spendB) return spendB - spendA;
    return a.funnelPath.localeCompare(b.funnelPath);
  });

  const thresholds: Record<string, number> = {};
  for (const target of input.targets) {
    if (target.scopeKind !== "global") continue;
    if (target.effectiveFrom > input.period.to) continue;
    if (target.effectiveTo && target.effectiveTo < input.period.to) continue;
    thresholds[target.metricKey] = target.targetValue;
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    engineVersion: REPORT_ENGINE_VERSION,
    engineVersions: input.engineVersions,
    period: input.period,
    compare: input.compare,
    collectedAt: input.collectedAt,
    warehouseVersionBefore: input.warehouseVersionBefore,
    warehouseVersionAfter: input.warehouseVersionAfter,
    consistent: input.warehouseVersionBefore === input.warehouseVersionAfter,
    kpi,
    funnels,
    gaps: [...input.gaps],
    provenance: [...input.provenance],
    thresholds,
    dataIncomplete: provisionalReasons.length > 0,
    provisionalReasons,
  };
}
