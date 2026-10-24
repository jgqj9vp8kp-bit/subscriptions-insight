// Payback by funnel — the pure model behind /forecasting (spec 2026-10-24
// §1–§2, P0 facts §10). No I/O, no React: the page feeds it the
// clickhouse-cohorts "ltv" response (every path of the viewer's scope, the
// reference window included) and the clickhouse-facebook spend_ledger of the
// display window, and renders what comes back.
//
// Definitions (one meaning in every cell, tooltip, total and export):
//   * a funnel is a campaign_path; trials = Σ trial_users of its cohort days;
//   * rev_c = cumulative net USD (after refunds, before processor fees) of the
//     users' successful payments with d <= c (the Cohorts revenue_dN rule);
//   * LTV_k = Σ rev_{30k} / Σ trials (k = 1, 2, 3), always Σ/Σ, never an
//     average of per-day LTVs;
//   * spend = the ledger's funnel-resolved Facebook spend of the window (zero-
//     user campaigns included, unlinked spend never added to a funnel) times
//     (1 + agency fee); CPT = spend / trials; ROAS_k = Σ rev_{30k} / spend;
//     break-even CPT for month k = LTV_k.
//
// Maturity, day grain: a cohort day is observed at checkpoint c when
// data_through >= its UTC midnight + (c + 2) days (a user who trialled at 23:59
// needs trial + c + 1 days). What is not observed is projected by a chain
// ladder on real revenue, nothing typed in:
//   * the reference pool P(level, c) = the rows of the level's paths observed at
//     c, over the 180 most recent cohort days that are;
//   * factor F(b→c) = Σ_P rev_c / Σ_P rev_b, used only when Σ_P trials >= 50
//     and Σ_P rev_b > 0, clamped at >= 1;
//   * fallback ladder funnel → product (the paths of its FunnelFox project) →
//     all paths in scope; the level used is recorded per cell, and "all", or a
//     non-funnel level on a cell that is more than half projected, is "rough";
//   * a row not observed at c: rev_c = rev_b* × F(b*→c), b* its last observed
//     checkpoint; a row with none: rev_c = trials × the pool's LTV_c;
//   * a projected value never drops below the row's previous checkpoint
//     (cumulative revenue; pools differ per checkpoint, so two factors can);
//   * spend is never projected; nothing beyond d90.
//
// Spend coverage (P0 facts): the warehouse can stop having Facebook spend
// (spend_through) while payments keep arriving. Trials are paired with spend
// only up to min(to, data_through, spend_through); later trials are counted
// apart (trialsAfterSpendThrough), and a funnel with nothing but later trials
// is "No spend data" — a missing day is never read as $0 spend.
//
// Trial coverage: payments are live but the trials are the cohort snapshot's
// members. While the snapshot is stale (an import it does not hold yet), the
// newest trials are missing, so the trials — and the spend paired with them —
// end at the snapshot's newest trial (members_through), not at data_through
// (paybackTrialsThrough). Maturity always reads data_through.
//
// Status precedence: No spend data > Low volume (trials < 50) > Too early
// (< 50 % of trials observed at d30) > "Month k" (the first k with ROAS_k >=
// 100 %) > "Not within 3 months" (ROAS_3 shown). approx ("≈") when the
// deciding cell is less than 95 % observed.

import type { CohortLtvResponse, CohortLtvRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { FunnelSpendLedger, WindowSpendLedger } from "../../supabase/functions/_shared/clickhouse/funnelEconomicsProject.ts";

const DAY_MS = 86_400_000;

/** The server's LTV_CHECKPOINTS (cohortLtv.ts); the response carries its own copy. */
export const PAYBACK_CHECKPOINTS: readonly number[] = Object.freeze([0, 3, 7, 14, 21, 30, 37, 45, 60, 67, 75, 90]);
/** Month k ↔ day 30k. */
export const PAYBACK_MONTH_DAYS = [30, 60, 90] as const;
/** Low volume, small-funnel fold and pool minimum (= funnelEconomicsActuals LOW_VOLUME_TRIALS_THRESHOLD). */
export const PAYBACK_MIN_TRIALS = 50;
export const PAYBACK_POOL_DAYS = 180;
export const PAYBACK_MATURITY_EXTRA_DAYS = 2;
/** A cell is approximate ("≈") below this observed share. */
export const PAYBACK_APPROX_BELOW = 0.95;
/** "Too early" below this observed share at d30. */
export const PAYBACK_TOO_EARLY_BELOW = 0.5;
/** ROAS from which a month has paid back (green, and the verdict's month). */
export const PAYBACK_ROAS_PAID_BACK = 1;
/** ROAS from which a month cell is amber. */
export const PAYBACK_ROAS_WARN_FROM = 0.8;
/** A non-funnel source is rough above this projected share. */
export const PAYBACK_ROUGH_PROJECTED_SHARE = 0.5;
/** Spend one day behind the payments is the normal Facebook lag; from two days on the page says so. */
export const PAYBACK_SPEND_BANNER_LAG_DAYS = 2;
export const PAYBACK_AGENCY_FEE_DEFAULT: Readonly<PaybackAgencyFee> = Object.freeze({ enabled: true, rate: 0.04 });
export const PAYBACK_SMALL_FUNNELS_KEY = "__small_funnels__";
export const PAYBACK_TOTAL_KEY = "__total__";

// ---- types ----------------------------------------------------------------------------

export type PaybackMonthIndex = 1 | 2 | 3;
export type PaybackSource = "funnel" | "product" | "all";

/** YYYY-MM-DD, inclusive. */
export interface PaybackWindow {
  from: string;
  to: string;
}

export interface PaybackAgencyFee {
  enabled: boolean;
  /** 0.04 = 4 % on top of the Facebook spend. */
  rate: number;
}

export interface PaybackPathSpend {
  /** Funnel-resolved Facebook spend of the ledger window, before the agency fee. */
  spend: number | null;
  currency: string | null;
  currencyMixed: boolean;
}

/** The spend side, read from one spend_ledger call (paybackSpendFromLedger). */
export interface PaybackSpendInput {
  /** The window the ledger was read for (paybackLedgerWindow). */
  window: PaybackWindow;
  byPath: Readonly<Record<string, PaybackPathSpend>>;
  /** unknown_funnel + other_unallocated of the window: never added to a funnel. */
  unlinkedSpend: number;
  /** Recorded gap days (facebook_known_gaps) inside the ledger window. */
  knownGapDays: readonly string[];
  /** The last day with any Facebook spend in the warehouse; null when none is loaded. */
  spendThrough: string | null;
}

/** A FunnelFox project's paths (product fallback level; full scope only). */
export interface PaybackProductGroup {
  key: string;
  paths: readonly string[];
}

export type PaybackLtvInput = Pick<CohortLtvResponse, "checkpoints" | "data_through" | "rows">
  & Partial<Pick<CohortLtvResponse, "members_through" | "snapshot_stale">>;

export interface PaybackInput {
  ltv: PaybackLtvInput;
  /** The display window. */
  window: PaybackWindow;
  /** null while the ledger is missing or failed: every funnel is "No spend data". */
  spend: PaybackSpendInput | null;
  /** Selected campaign paths; null or omitted = all funnels. */
  funnels?: readonly string[] | null;
  /** null or omitted: no product level (funnel-restricted viewers). */
  products?: readonly PaybackProductGroup[] | null;
  agencyFee?: PaybackAgencyFee;
}

export type NoSpendReason =
  /** The spend ledger is not loaded or failed. */
  | "spend_unavailable"
  /** The warehouse has no Facebook spend at all. */
  | "no_spend_loaded"
  /** The funnel's trials in the window all fall after spend_through. */
  | "after_spend_through"
  /** facebook_known_gaps has a day inside the evaluated window. */
  | "known_gap"
  /** The ledger was read for another window than the evaluated one. */
  | "spend_window_mismatch"
  /** Trials but no resolved spend: unknown, never $0. */
  | "zero_spend"
  | "mixed_currency"
  | "non_usd_currency";

export type PaybackStatus =
  | { kind: "no_spend_data"; reasons: NoSpendReason[] }
  | { kind: "low_volume" }
  | { kind: "too_early"; observedShare: number | null }
  | { kind: "month"; month: PaybackMonthIndex; approx: boolean }
  | { kind: "not_within"; roas: number | null; approx: boolean };

/** One checkpoint of a row's curve. */
export interface PaybackPoint {
  day: number;
  /** Σ observed + projected rev; null when a row could not be projected (no pool anywhere). */
  revenue: number | null;
  /** revenue / trials; null without trials. */
  ltv: number | null;
  /** Σ trials observed at this checkpoint / Σ trials; null without trials. */
  observedShare: number | null;
  /** observedShare < 95 %: shown with "≈". */
  approx: boolean;
  /** The weakest pool level a projected value used; null when fully observed. */
  source: PaybackSource | null;
  /** Trials of that pool (single-funnel rows only). */
  poolTrials: number | null;
  rough: boolean;
}

export interface PaybackMonth extends PaybackPoint {
  month: PaybackMonthIndex;
  /** revenue / spend; null under "No spend data". */
  roas: number | null;
  /** = ltv: the most a trial may cost to pay back by this month. */
  breakEvenCpt: number | null;
}

export interface PaybackRow {
  /** The campaign_path, or PAYBACK_SMALL_FUNNELS_KEY / PAYBACK_TOTAL_KEY. */
  key: string;
  paths: string[];
  /** The trials the row's numbers are computed on. */
  trials: number;
  /** Trials of the display window dated after spend_through (never paired
   * with spend), each counted once. On an evaluated row they are not in
   * `trials` ("+N newer"); on a row that is not evaluated they ARE its trials
   * (all of them are later), or 0 when no spend window exists at all. */
  trialsAfterSpendThrough: number;
  /** false: the row shows trials no spend window covers. */
  evaluated: boolean;
  /** The ledger's funnel-resolved spend before the fee (diagnostic; null when not evaluated). */
  spendRaw: number | null;
  /** With the agency fee; null under "No spend data". */
  spend: number | null;
  cpt: number | null;
  months: [PaybackMonth, PaybackMonth, PaybackMonth];
  curve: PaybackPoint[];
  /** Revenue already received within 90 days of each trial (observed, no projection). */
  collected: number;
  /** "≈ day N": the curve against CPT, linearly interpolated; null when not within 90 days. */
  paybackDay: number | null;
  noSpendReasons: NoSpendReason[];
  status: PaybackStatus;
}

export interface PaybackAggregateRow extends PaybackRow {
  /** Funnels left out because they are "No spend data" (only while some funnel is not). */
  excludedFunnels: number;
  /** Their trials up to spend_through; their later ones are in trialsAfterSpendThrough. */
  excludedTrials: number;
}

export interface PaybackResult {
  checkpoints: number[];
  dataThrough: string | null;
  spendThrough: string | null;
  /** The day the trials are cut at because the cohort snapshot is behind the
   * payments (stale) and the window runs past it; null when they are not cut. */
  trialsCutAt: string | null;
  /** [from, min(to, the trials' last day)]: the trials the page can see; null without data. */
  revenueWindow: PaybackWindow | null;
  /** [from, min(revenue end, spend_through)]: trials paired with spend; null when none are. */
  evaluatedWindow: PaybackWindow | null;
  /** Reasons that hold for the whole window. */
  windowReasons: NoSpendReason[];
  /** Facebook spend ends before the payments do (by >= 2 days, or none is loaded). */
  spendBanner: { through: string | null; lagDays: number | null } | null;
  /** Funnels with >= 50 trials, spend descending. */
  rows: PaybackRow[];
  /** Funnels with < 50 trials, folded into one expandable row. */
  small: { aggregate: PaybackAggregateRow; rows: PaybackRow[] } | null;
  /** Every selected funnel, small ones included. */
  total: PaybackAggregateRow;
  /** Facebook spend not linked to any funnel (all funnels selected only), before the fee. */
  unlinkedSpend: number | null;
  agencyFee: PaybackAgencyFee;
}

// ---- dates ----------------------------------------------------------------------------

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function dayOf(ms: number): string {
  return new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return dayOf(dayMs(day) + days * DAY_MS);
}

const minDay = (a: string, b: string) => (a < b ? a : b);

function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
}

// ---- maturity -------------------------------------------------------------------------

/** Whether a cohort day is fully observed at `checkpoint` days (the +2 day rule). */
export function isCohortObserved(cohortDate: string, checkpoint: number, dataThroughMs: number): boolean {
  return dataThroughMs >= dayMs(cohortDate) + (checkpoint + PAYBACK_MATURITY_EXTRA_DAYS) * DAY_MS;
}

/** Index of the last observed checkpoint (-1: none, not even d0). */
export function lastObservedIndex(cohortDate: string, dataThroughMs: number, checkpoints: readonly number[] = PAYBACK_CHECKPOINTS): number {
  let last = -1;
  for (let index = 0; index < checkpoints.length; index += 1) {
    if (!isCohortObserved(cohortDate, checkpoints[index], dataThroughMs)) break;
    last = index;
  }
  return last;
}

/** The newest cohort day observed at `checkpoint`. */
function newestObservedDay(checkpoint: number, dataThroughMs: number): string {
  return dayOf(dataThroughMs - (checkpoint + PAYBACK_MATURITY_EXTRA_DAYS) * DAY_MS);
}

// ---- model: pools and projection ------------------------------------------------------

interface PoolSum {
  trials: number;
  rev: number[];
}

interface LadderStep {
  level: PaybackSource;
  id: string;
  paths: readonly string[];
}

interface Model {
  checkpoints: number[];
  dataThroughMs: number;
  allPaths: string[];
  /** path → one PoolSum per checkpoint (its rows observed there, newest 180 days). */
  pathPools: Map<string, PoolSum[]>;
  /** path → the union of its products' paths (only when wider than the path). */
  productPaths: Map<string, string[]>;
  poolCache: Map<string, PoolSum>;
  ladders: Map<string, LadderStep[]>;
}

interface ProjectedCohort {
  date: string;
  path: string;
  trials: number;
  /** Last observed checkpoint index (-1 none). */
  observed: number;
  rev: Array<number | null>;
  level: Array<PaybackSource | null>;
  /** Raw rev at the last checkpoint (received so far within 90 days). */
  collected: number;
}

function checkpointIndex(checkpoints: readonly number[], day: number): number {
  const index = checkpoints.indexOf(day);
  if (index < 0) throw new Error(`ltvPayback: checkpoint ${day} is missing from the ltv response.`);
  return index;
}

function validateLtv(ltv: Pick<PaybackLtvInput, "checkpoints" | "rows">): number[] {
  const checkpoints = [...ltv.checkpoints];
  for (let index = 1; index < checkpoints.length; index += 1) {
    if (!(checkpoints[index] > checkpoints[index - 1])) throw new Error("ltvPayback: checkpoints must ascend.");
  }
  for (const day of PAYBACK_MONTH_DAYS) checkpointIndex(checkpoints, day);
  for (const row of ltv.rows) {
    if (row.rev.length !== checkpoints.length) throw new Error(`ltvPayback: row ${row.cohort_date} ${row.campaign_path} has ${row.rev.length} values for ${checkpoints.length} checkpoints.`);
  }
  return checkpoints;
}

function emptyPool(size: number): PoolSum {
  return { trials: 0, rev: new Array<number>(size).fill(0) };
}

function buildModel(
  ltv: Pick<PaybackLtvInput, "checkpoints" | "rows">,
  dataThroughMs: number,
  products: readonly PaybackProductGroup[] | null | undefined,
): Model {
  const checkpoints = validateLtv(ltv);
  const size = checkpoints.length;
  const windows = checkpoints.map((day) => {
    const newest = newestObservedDay(day, dataThroughMs);
    return { oldest: addDays(newest, -(PAYBACK_POOL_DAYS - 1)), newest };
  });
  const pathPools = new Map<string, PoolSum[]>();
  for (const row of ltv.rows) {
    if (!(row.trial_users > 0)) continue;
    let pools = pathPools.get(row.campaign_path);
    if (!pools) {
      pools = checkpoints.map(() => emptyPool(size));
      pathPools.set(row.campaign_path, pools);
    }
    for (let index = 0; index < size; index += 1) {
      const { oldest, newest } = windows[index];
      if (row.cohort_date < oldest || row.cohort_date > newest) continue;
      const pool = pools[index];
      pool.trials += row.trial_users;
      for (let at = 0; at <= index; at += 1) pool.rev[at] += row.rev[at];
    }
  }
  const allPaths = [...new Set(ltv.rows.map((row) => row.campaign_path))].sort();
  const productPaths = new Map<string, string[]>();
  for (const path of allPaths) {
    const union = new Set<string>();
    for (const group of products ?? []) if (group.paths.includes(path)) for (const member of group.paths) union.add(member);
    if (union.size > 1) productPaths.set(path, [...union].sort());
  }
  return { checkpoints, dataThroughMs, allPaths, pathPools, productPaths, poolCache: new Map(), ladders: new Map() };
}

function ladderOf(model: Model, path: string): LadderStep[] {
  const cached = model.ladders.get(path);
  if (cached) return cached;
  const steps: LadderStep[] = [{ level: "funnel", id: `f\u0001${path}`, paths: [path] }];
  const product = model.productPaths.get(path);
  if (product) steps.push({ level: "product", id: `p\u0001${product.join("\u0001")}`, paths: product });
  steps.push({ level: "all", id: "a", paths: model.allPaths });
  model.ladders.set(path, steps);
  return steps;
}

function poolOf(model: Model, step: LadderStep, index: number): PoolSum {
  const key = `${step.id}#${index}`;
  const cached = model.poolCache.get(key);
  if (cached) return cached;
  const sum = emptyPool(model.checkpoints.length);
  for (const path of step.paths) {
    const pool = model.pathPools.get(path)?.[index];
    if (!pool) continue;
    sum.trials += pool.trials;
    for (let at = 0; at <= index; at += 1) sum.rev[at] += pool.rev[at];
  }
  model.poolCache.set(key, sum);
  return sum;
}

function projectCohort(model: Model, row: CohortLtvRow): ProjectedCohort {
  const size = model.checkpoints.length;
  const observed = lastObservedIndex(row.cohort_date, model.dataThroughMs, model.checkpoints);
  const ladder = ladderOf(model, row.campaign_path);
  const rev: Array<number | null> = [];
  const level: Array<PaybackSource | null> = [];
  for (let index = 0; index < size; index += 1) {
    if (index <= observed) {
      rev.push(row.rev[index]);
      level.push(null);
      continue;
    }
    let value: number | null = null;
    let source: PaybackSource | null = null;
    for (const step of ladder) {
      const pool = poolOf(model, step, index);
      if (pool.trials < PAYBACK_MIN_TRIALS) continue;
      if (observed >= 0) {
        if (!(pool.rev[observed] > 0)) continue;
        value = row.rev[observed] * Math.max(1, pool.rev[index] / pool.rev[observed]);
      } else {
        value = row.trial_users * (pool.rev[index] / pool.trials);
      }
      source = step.level;
      break;
    }
    const previous = index > 0 ? rev[index - 1] : null;
    if (value !== null && previous !== null) value = Math.max(value, previous);
    rev.push(value);
    level.push(source);
  }
  return { date: row.cohort_date, path: row.campaign_path, trials: row.trial_users, observed, rev, level, collected: row.rev[size - 1] };
}

const SOURCE_RANK: Readonly<Record<PaybackSource, number>> = { funnel: 0, product: 1, all: 2 };

function curveOf(
  checkpoints: readonly number[],
  cohorts: readonly ProjectedCohort[],
  poolTrials?: (source: PaybackSource, index: number) => number,
): { trials: number; curve: PaybackPoint[]; collected: number } {
  const trials = cohorts.reduce((sum, cohort) => sum + cohort.trials, 0);
  const collected = cohorts.reduce((sum, cohort) => sum + cohort.collected, 0);
  const curve = checkpoints.map((day, index): PaybackPoint => {
    let revenue: number | null = 0;
    let observedTrials = 0;
    let worst: PaybackSource | null = null;
    for (const cohort of cohorts) {
      const value = cohort.rev[index];
      revenue = value === null || revenue === null ? null : revenue + value;
      if (cohort.observed >= index) observedTrials += cohort.trials;
      const source = cohort.level[index];
      if (source && (worst === null || SOURCE_RANK[source] > SOURCE_RANK[worst])) worst = source;
    }
    const observedShare = trials > 0 ? observedTrials / trials : null;
    const projectedShare = observedShare === null ? 0 : 1 - observedShare;
    return {
      day,
      revenue,
      ltv: trials > 0 && revenue !== null ? revenue / trials : null,
      observedShare,
      approx: observedShare !== null && observedShare < PAYBACK_APPROX_BELOW,
      source: worst,
      poolTrials: worst && poolTrials ? poolTrials(worst, index) : null,
      rough: worst === "all" || (worst === "product" && projectedShare > PAYBACK_ROUGH_PROJECTED_SHARE),
    };
  });
  return { trials, curve, collected };
}

// ---- verdicts ---------------------------------------------------------------------------

/** Status precedence (spec §1): No spend data > Low volume > Too early > the month verdict. */
export function paybackStatusOf(input: {
  reasons: readonly NoSpendReason[];
  trials: number;
  months: ReadonlyArray<Pick<PaybackMonth, "roas" | "approx" | "observedShare" | "ltv">>;
}): PaybackStatus {
  if (input.reasons.length) return { kind: "no_spend_data", reasons: [...input.reasons] };
  if (input.trials < PAYBACK_MIN_TRIALS) return { kind: "low_volume" };
  const share = input.months[0]?.observedShare ?? null;
  if (share === null || share < PAYBACK_TOO_EARLY_BELOW || input.months.some((month) => month.ltv === null)) {
    return { kind: "too_early", observedShare: share };
  }
  for (let index = 0; index < input.months.length; index += 1) {
    const month = input.months[index];
    if (month.roas !== null && month.roas >= PAYBACK_ROAS_PAID_BACK) return { kind: "month", month: (index + 1) as PaybackMonthIndex, approx: month.approx };
  }
  const last = input.months[input.months.length - 1];
  return { kind: "not_within", roas: last?.roas ?? null, approx: last?.approx ?? false };
}

/** The day the curve reaches `cpt`, linearly interpolated between checkpoints
 * and rounded up ("≈ day N"); null when it never does by d90. */
export function paybackDayOf(curve: ReadonlyArray<Pick<PaybackPoint, "day" | "ltv">>, cpt: number | null): number | null {
  if (cpt === null || !(cpt > 0)) return null;
  const points = curve.filter((point): point is { day: number; ltv: number } => point.ltv !== null);
  if (!points.length) return null;
  if (points[0].ltv >= cpt) return points[0].day;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (next.ltv < cpt) continue;
    if (next.ltv === previous.ltv) return next.day;
    const day = previous.day + ((cpt - previous.ltv) / (next.ltv - previous.ltv)) * (next.day - previous.day);
    return Math.ceil(day - 1e-9);
  }
  return null;
}

/** Cell tint: ROAS >= 100 % good, 80–99 % warn, below none. */
export function paybackRoasTint(roas: number | null): "good" | "warn" | null {
  if (roas === null) return null;
  if (roas >= PAYBACK_ROAS_PAID_BACK) return "good";
  return roas >= PAYBACK_ROAS_WARN_FROM ? "warn" : null;
}

/** Verdict colour: Month 1 / 2 good, Month 3 warn, not within 3 months bad, the rest muted. */
export function paybackStatusTone(status: PaybackStatus): "good" | "warn" | "bad" | "muted" {
  if (status.kind === "month") return status.month === 3 ? "warn" : "good";
  return status.kind === "not_within" ? "bad" : "muted";
}

export interface PaybackWhatIf {
  cpt: number;
  months: Array<{ month: PaybackMonthIndex; ltv: number | null; roas: number | null; approx: boolean }>;
  status: PaybackStatus;
  paybackDay: number | null;
}

/** The drilldown's what-if: the same row against a typed cost per trial (never
 * saved). Spend coverage does not matter here — the cost is the viewer's. */
export function paybackWhatIf(row: Pick<PaybackRow, "trials" | "months" | "curve">, cpt: number): PaybackWhatIf | null {
  if (!Number.isFinite(cpt) || !(cpt > 0)) return null;
  const months = row.months.map((month) => ({
    month: month.month,
    ltv: month.ltv,
    observedShare: month.observedShare,
    roas: month.ltv === null ? null : month.ltv / cpt,
    approx: month.approx,
  }));
  return {
    cpt,
    months: months.map(({ month, ltv, roas, approx }) => ({ month, ltv, roas, approx })),
    status: paybackStatusOf({ reasons: [], trials: row.trials, months }),
    paybackDay: paybackDayOf(row.curve, cpt),
  };
}

// ---- assembly ---------------------------------------------------------------------------

interface FunnelCalc {
  path: string;
  cohorts: ProjectedCohort[];
  trialsAfterSpendThrough: number;
  evaluated: boolean;
  spendRaw: number | null;
  reasons: NoSpendReason[];
}

function feeFactor(fee: PaybackAgencyFee): number {
  return fee.enabled && Number.isFinite(fee.rate) && fee.rate > 0 ? 1 + fee.rate : 1;
}

function buildRow(
  checkpoints: readonly number[],
  input: { key: string; paths: string[]; cohorts: ProjectedCohort[]; trialsAfterSpendThrough: number; evaluated: boolean; spendRaw: number | null; reasons: NoSpendReason[] },
  fee: PaybackAgencyFee,
  poolTrials?: (source: PaybackSource, index: number) => number,
): PaybackRow {
  const { trials, curve, collected } = curveOf(checkpoints, input.cohorts, poolTrials);
  const spend = input.reasons.length === 0 && input.spendRaw !== null ? input.spendRaw * feeFactor(fee) : null;
  const cpt = spend !== null && trials > 0 ? spend / trials : null;
  const months = PAYBACK_MONTH_DAYS.map((day, index): PaybackMonth => {
    const point = curve[checkpointIndex(checkpoints, day)];
    return {
      ...point,
      month: (index + 1) as PaybackMonthIndex,
      roas: spend !== null && spend > 0 && point.revenue !== null ? point.revenue / spend : null,
      breakEvenCpt: point.ltv,
    };
  }) as [PaybackMonth, PaybackMonth, PaybackMonth];
  return {
    key: input.key,
    paths: input.paths,
    trials,
    trialsAfterSpendThrough: input.trialsAfterSpendThrough,
    evaluated: input.evaluated,
    spendRaw: input.spendRaw,
    spend,
    cpt,
    months,
    curve,
    collected,
    paybackDay: paybackDayOf(curve, cpt),
    noSpendReasons: [...input.reasons],
    status: paybackStatusOf({ reasons: input.reasons, trials, months }),
  };
}

const trialsOfCalc = (calc: FunnelCalc) => calc.cohorts.reduce((sum, cohort) => sum + cohort.trials, 0);

/** TOTAL / the small-funnel fold: Σ/Σ over the member funnels' own projections.
 * Funnels without spend data are left out (and counted) while any funnel has
 * it; when none has, the aggregate shows the funnels' trials as "No spend data".
 * Each count keeps one meaning (PaybackRow.trialsAfterSpendThrough): the later
 * trials of EVERY member funnel are summed once, and an evaluated aggregate
 * holds only trials a spend window covers — so with no usable funnel it shows
 * the evaluated funnels' trials, and only when none is evaluated (every trial
 * is later, or there is no spend window) all of them. */
function aggregateRow(checkpoints: readonly number[], key: string, calcs: readonly FunnelCalc[], fee: PaybackAgencyFee): PaybackAggregateRow {
  const usable = calcs.filter((calc) => calc.reasons.length === 0);
  const evaluated = calcs.filter((calc) => calc.evaluated);
  const part = usable.length ? usable : evaluated.length ? evaluated : calcs;
  const excluded = usable.length ? calcs.filter((calc) => calc.reasons.length > 0) : [];
  const reasons = usable.length ? [] : [...new Set(calcs.flatMap((calc) => calc.reasons))];
  const row = buildRow(checkpoints, {
    key,
    paths: (usable.length ? usable : calcs).map((calc) => calc.path),
    cohorts: part.flatMap((calc) => calc.cohorts),
    trialsAfterSpendThrough: calcs.reduce((sum, calc) => sum + calc.trialsAfterSpendThrough, 0),
    evaluated: part.some((calc) => calc.evaluated),
    spendRaw: usable.length ? usable.reduce((sum, calc) => sum + (calc.spendRaw ?? 0), 0) : null,
    reasons,
  }, fee);
  return {
    ...row,
    excludedFunnels: excluded.length,
    // An excluded funnel that is not evaluated has only later trials: those
    // are in trialsAfterSpendThrough already.
    excludedTrials: excluded.filter((calc) => calc.evaluated).reduce((sum, calc) => sum + trialsOfCalc(calc), 0),
  };
}

function bySpendThenTrials(a: PaybackRow, b: PaybackRow): number {
  const spendA = a.spend ?? -1;
  const spendB = b.spend ?? -1;
  return spendB - spendA || b.trials - a.trials || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function emptyAggregate(checkpoints: readonly number[], fee: PaybackAgencyFee, reasons: NoSpendReason[]): PaybackAggregateRow {
  const row = buildRow(checkpoints, { key: PAYBACK_TOTAL_KEY, paths: [], cohorts: [], trialsAfterSpendThrough: 0, evaluated: false, spendRaw: null, reasons }, fee);
  return { ...row, excludedFunnels: 0, excludedTrials: 0 };
}

/** How far the trials go (ISO): data_through, or — while the cohort snapshot
 * is stale — the snapshot's newest trial when that is earlier (the members
 * after it are not in the snapshot yet). null without data. */
export function paybackTrialsThrough(ltv: Pick<PaybackLtvInput, "data_through" | "members_through" | "snapshot_stale">): string | null {
  const dataThrough = ltv.data_through;
  if (!dataThrough) return null;
  const members = ltv.snapshot_stale === true ? ltv.members_through ?? null : null;
  return members && Date.parse(members) < Date.parse(dataThrough) ? members : dataThrough;
}

/** The spend_ledger window the page reads for a display window: clipped to the
 * day the trials go to (paybackTrialsThrough: data_through, or the stale
 * snapshot's newest trial), so Facebook days without imported payments or
 * trials never inflate cost per trial. null when the window has none yet. */
export function paybackLedgerWindow(window: PaybackWindow, trialsThrough: string | null): PaybackWindow | null {
  if (!trialsThrough) return null;
  const to = minDay(window.to, trialsThrough.slice(0, 10));
  return window.from <= to ? { from: window.from, to } : null;
}

/** spend_ledger response → PaybackSpendInput. */
export function paybackSpendFromLedger(ledger: {
  window: PaybackWindow;
  windowLedger: Pick<WindowSpendLedger, "unknownFunnel" | "otherUnallocated" | "knownGapDays">;
  funnelLedgers: Readonly<Record<string, Pick<FunnelSpendLedger, "funnelResolvedSpend" | "currency" | "currencyMixed">>>;
  spendThrough: string | null;
}): PaybackSpendInput {
  const byPath: Record<string, PaybackPathSpend> = {};
  for (const [path, funnel] of Object.entries(ledger.funnelLedgers)) {
    byPath[path] = { spend: funnel.funnelResolvedSpend, currency: funnel.currency, currencyMixed: funnel.currencyMixed };
  }
  return {
    window: { from: ledger.window.from, to: ledger.window.to },
    byPath,
    unlinkedSpend: ledger.windowLedger.unknownFunnel.spend + ledger.windowLedger.otherUnallocated.spend,
    knownGapDays: ledger.windowLedger.knownGapDays.map((gap) => gap.date),
    spendThrough: ledger.spendThrough ?? null,
  };
}

/** product_paths → product groups; the metadata-less bucket is not a product. */
export function paybackProductGroups(products: ReadonlyArray<{ project_id: string; campaign_paths: readonly string[] }> | null | undefined): PaybackProductGroup[] | null {
  if (!products) return null;
  return products.filter((product) => product.project_id !== "").map((product) => ({ key: product.project_id, paths: [...product.campaign_paths] }));
}

/** The whole page model for one display window. */
export function computePayback(input: PaybackInput): PaybackResult {
  const fee = input.agencyFee ?? PAYBACK_AGENCY_FEE_DEFAULT;
  const window = input.window;
  const dataThrough = input.ltv.data_through;
  const spendThrough = input.spend?.spendThrough ?? null;
  const dataThroughMs = dataThrough ? Date.parse(dataThrough) : Number.NaN;
  // The trials end at data_through, or earlier while the snapshot is stale;
  // maturity is data_through's either way.
  const trialsThroughMs = Date.parse(paybackTrialsThrough(input.ltv) ?? "");
  const trialsEnd = Number.isFinite(dataThroughMs) && Number.isFinite(trialsThroughMs) ? dayOf(Math.min(trialsThroughMs, dataThroughMs)) : null;
  const trialsCutAt = trialsEnd !== null && trialsEnd < dayOf(dataThroughMs) && window.to > trialsEnd ? trialsEnd : null;
  const base = { checkpoints: validateLtv(input.ltv), dataThrough, spendThrough, trialsCutAt, agencyFee: fee };
  const revenueEnd = trialsEnd === null ? null : minDay(window.to, trialsEnd);
  if (revenueEnd === null || window.from > revenueEnd) {
    return {
      ...base, revenueWindow: null, evaluatedWindow: null, windowReasons: [], spendBanner: null,
      rows: [], small: null, total: emptyAggregate(base.checkpoints, fee, []), unlinkedSpend: null,
    };
  }
  const model = buildModel(input.ltv, dataThroughMs, input.products);
  const spend = input.spend;

  // Which part of the window has spend to pair with its trials.
  const windowReasons: NoSpendReason[] = [];
  let spendEnd: string | null = null;
  if (!spend) windowReasons.push("spend_unavailable");
  else if (!spend.spendThrough) windowReasons.push("no_spend_loaded");
  else if (spend.spendThrough < window.from) windowReasons.push("after_spend_through");
  else {
    spendEnd = minDay(revenueEnd, spend.spendThrough);
    // The ledger must cover exactly [from, spendEnd], plus at most days after
    // spend_through (no spend there by definition) — never fewer days, and
    // never days after data_through that do carry spend.
    const extendsSafely = spend.window.to === spendEnd || (spend.window.to > spendEnd && spendEnd === spend.spendThrough);
    if (spend.window.from !== window.from || !extendsSafely) windowReasons.push("spend_window_mismatch");
    const end = spendEnd;
    if (spend.knownGapDays.some((day) => day >= window.from && day <= end)) windowReasons.push("known_gap");
  }

  const selected = input.funnels ? new Set(input.funnels) : null;
  const byPath = new Map<string, CohortLtvRow[]>();
  for (const row of input.ltv.rows) {
    if (row.cohort_date < window.from || row.cohort_date > revenueEnd || !(row.trial_users > 0)) continue;
    const list = byPath.get(row.campaign_path) ?? [];
    list.push(row);
    byPath.set(row.campaign_path, list);
  }
  const candidates = new Set(byPath.keys());
  if (spend && spendEnd) for (const [path, entry] of Object.entries(spend.byPath)) if ((entry.spend ?? 0) > 0) candidates.add(path);

  const calcs: FunnelCalc[] = [];
  for (const path of [...candidates].sort()) {
    if (selected && !selected.has(path)) continue;
    const cohorts = (byPath.get(path) ?? []).map((row) => projectCohort(model, row));
    const trialsOf = (list: readonly ProjectedCohort[]) => list.reduce((sum, cohort) => sum + cohort.trials, 0);
    if (!spend || !spendEnd) {
      // Not evaluated: the row shows the window's trials — all of them later
      // than spend_through, or (no spend window at all) none counted as later.
      calcs.push({
        path, cohorts, evaluated: false, spendRaw: null, reasons: [...windowReasons],
        trialsAfterSpendThrough: windowReasons.includes("after_spend_through") ? trialsOf(cohorts) : 0,
      });
      continue;
    }
    const end = spendEnd;
    const paired = cohorts.filter((cohort) => cohort.date <= end);
    const later = cohorts.filter((cohort) => cohort.date > end);
    const entry = spend.byPath[path];
    const spendRaw = entry?.spend ?? 0;
    if (trialsOf(paired) > 0 || spendRaw > 0) {
      const reasons = [...windowReasons];
      if (trialsOf(paired) > 0 && !(spendRaw > 0)) reasons.push("zero_spend");
      if (entry?.currencyMixed) reasons.push("mixed_currency");
      else if (entry?.currency && entry.currency !== "USD") reasons.push("non_usd_currency");
      calcs.push({ path, cohorts: paired, evaluated: true, spendRaw, reasons, trialsAfterSpendThrough: trialsOf(later) });
    } else {
      calcs.push({ path, cohorts: later, evaluated: false, spendRaw: null, reasons: ["after_spend_through"], trialsAfterSpendThrough: trialsOf(later) });
    }
  }

  const rowOf = (calc: FunnelCalc) => buildRow(model.checkpoints, { key: calc.path, paths: [calc.path], ...calc }, fee, (source, index) => {
    const step = ladderOf(model, calc.path).find((candidate) => candidate.level === source);
    return step ? poolOf(model, step, index).trials : 0;
  });
  const funnelRows = calcs.map((calc) => ({ calc, row: rowOf(calc) }));
  const big = funnelRows.filter(({ row }) => row.trials >= PAYBACK_MIN_TRIALS);
  const small = funnelRows.filter(({ row }) => row.trials < PAYBACK_MIN_TRIALS);

  let spendBanner: PaybackResult["spendBanner"] = null;
  if (spend && !spend.spendThrough) spendBanner = { through: null, lagDays: null };
  else if (spend?.spendThrough) {
    const lag = daysBetween(spend.spendThrough, revenueEnd);
    if (lag >= PAYBACK_SPEND_BANNER_LAG_DAYS) spendBanner = { through: spend.spendThrough, lagDays: lag };
  }

  return {
    ...base,
    revenueWindow: { from: window.from, to: revenueEnd },
    evaluatedWindow: spendEnd ? { from: window.from, to: spendEnd } : null,
    windowReasons,
    spendBanner,
    rows: big.map(({ row }) => row).sort(bySpendThenTrials),
    small: small.length
      ? { aggregate: aggregateRow(model.checkpoints, PAYBACK_SMALL_FUNNELS_KEY, small.map(({ calc }) => calc), fee), rows: small.map(({ row }) => row).sort(bySpendThenTrials) }
      : null,
    total: calcs.length ? aggregateRow(model.checkpoints, PAYBACK_TOTAL_KEY, calcs, fee) : emptyAggregate(model.checkpoints, fee, windowReasons),
    unlinkedSpend: !selected && spend && spendEnd ? spend.unlinkedSpend : null,
  };
}

// ---- trend by trial month -----------------------------------------------------------------

/** The `count` calendar months ending with the month of `to` (that one cut at
 * `to`), oldest first: the drilldown's trend windows. */
export function paybackTrendMonths(to: string, count = 6): PaybackWindow[] {
  const [year, month] = to.split("-").map(Number);
  const windows: PaybackWindow[] = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const first = new Date(Date.UTC(year, month - 1 - back, 1));
    const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
    const from = first.toISOString().slice(0, 10);
    const end = last.toISOString().slice(0, 10);
    windows.push({ from, to: end < to ? end : to });
  }
  return windows;
}

/** One funnel per trial month, each month paired with its own ledger (one
 * lazy spend_ledger call per month). The projection is the page's: same rows,
 * same pools. */
export function paybackTrend(
  base: Omit<PaybackInput, "window" | "spend" | "funnels">,
  path: string,
  months: ReadonlyArray<{ window: PaybackWindow; spend: PaybackSpendInput | null }>,
): Array<{ window: PaybackWindow; row: PaybackRow | null; spendBanner: PaybackResult["spendBanner"] }> {
  return months.map(({ window, spend }) => {
    const result = computePayback({ ...base, window, spend, funnels: [path] });
    const row = [...result.rows, ...(result.small?.rows ?? [])].find((candidate) => candidate.key === path) ?? null;
    return { window, row, spendBanner: result.spendBanner };
  });
}

// ---- backtest -----------------------------------------------------------------------------

export interface PaybackBacktestEntry {
  shiftDays: number;
  month: 2 | 3;
  path: string;
  /** Trials of the cohorts that were projected then and are observed now. */
  trials: number;
  projected: number;
  actual: number;
  /** |projected − actual| / actual. */
  ape: number;
}

export interface PaybackBacktestResult {
  dataThrough: string;
  entries: PaybackBacktestEntry[];
  bySlice: Array<{ shiftDays: number; month: 2 | 3; funnels: number; mape: number | null }>;
  byFunnel: Array<{ path: string; month: 2 | 3; slices: number; mape: number }>;
}

/** Projection accuracy (spec §2 backtest): data_through moved back by each
 * shift, LTV_2 / LTV_3 projected from what was known then, compared with today's
 * actuals per funnel over the cohorts that were not observed then and are now.
 * Known limitation: a checkpoint's revenue "as of then" is today's value (a
 * refund recorded after the cut-off lowers it retroactively). Needs rows back to
 * data_through − 271 − max(shift) days (request a wider date_from). */
export function backtestPayback(
  ltv: PaybackLtvInput,
  options: { shifts?: readonly number[]; months?: ReadonlyArray<2 | 3>; products?: readonly PaybackProductGroup[] | null; minTrials?: number } = {},
): PaybackBacktestResult | null {
  if (!ltv.data_through) return null;
  const nowMs = Date.parse(ltv.data_through);
  if (!Number.isFinite(nowMs)) return null;
  const checkpoints = validateLtv(ltv);
  const shifts = options.shifts ?? [30, 60, 90];
  const monthsWanted = options.months ?? [2, 3];
  const minTrials = options.minTrials ?? PAYBACK_MIN_TRIALS;
  const entries: PaybackBacktestEntry[] = [];
  for (const shiftDays of shifts) {
    const thenMs = nowMs - shiftDays * DAY_MS;
    const cutoff = dayOf(thenMs);
    const known = ltv.rows.filter((row) => row.cohort_date <= cutoff && row.trial_users > 0);
    const model = buildModel({ checkpoints, rows: known }, thenMs, options.products);
    for (const month of monthsWanted) {
      const index = checkpointIndex(checkpoints, month * 30);
      const byPath = new Map<string, CohortLtvRow[]>();
      for (const row of known) {
        if (lastObservedIndex(row.cohort_date, nowMs, checkpoints) < index) continue;
        if (lastObservedIndex(row.cohort_date, thenMs, checkpoints) >= index) continue;
        const list = byPath.get(row.campaign_path) ?? [];
        list.push(row);
        byPath.set(row.campaign_path, list);
      }
      for (const [path, rows] of [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const trials = rows.reduce((sum, row) => sum + row.trial_users, 0);
        if (trials < minTrials) continue;
        const actual = rows.reduce((sum, row) => sum + row.rev[index], 0);
        let projected: number | null = 0;
        for (const row of rows) {
          const value = projectCohort(model, row).rev[index];
          projected = value === null || projected === null ? null : projected + value;
        }
        if (projected === null || !(actual > 0)) continue;
        entries.push({ shiftDays, month, path, trials, projected, actual, ape: Math.abs(projected - actual) / actual });
      }
    }
  }
  const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const bySlice = shifts.flatMap((shiftDays) => monthsWanted.map((month) => {
    const slice = entries.filter((entry) => entry.shiftDays === shiftDays && entry.month === month);
    return { shiftDays, month, funnels: slice.length, mape: mean(slice.map((entry) => entry.ape)) };
  }));
  const funnelKeys = [...new Set(entries.map((entry) => `${entry.path}\u0001${entry.month}`))].sort();
  const byFunnel = funnelKeys.map((key) => {
    const [path, month] = key.split("\u0001");
    const slice = entries.filter((entry) => entry.path === path && entry.month === Number(month));
    return { path, month: Number(month) as 2 | 3, slices: slice.length, mape: mean(slice.map((entry) => entry.ape)) ?? 0 };
  });
  return { dataThrough: ltv.data_through, entries, bySlice, byFunnel };
}
