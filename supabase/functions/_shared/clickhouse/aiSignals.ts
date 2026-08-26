// Deterministic AI-analytics signal engine (ai-signals-v2).
//
// Turns rows the pages ALREADY loaded (cohort rows, FB campaign rows, pass-rate
// slices) into signals (CPA_GOOD, TRIAL_TO_PAID_BAD, ...), one recommendation
// per scope (SCALE +20 ... STOP / INVESTIGATE / NOT_ENOUGH_DATA) with evidence,
// confidence, contradictions and data notes, plus a ranked opportunity list and
// a model-facing context pack of pre-rendered strings.
//
// v2 adds PATH-grain recommendations (one per campaign_path, derived from the
// SAME cohort-row run — pooled sums, mature-subset conversion, amount-based
// refunds, mature-subset payback, real trend clause) so the Cohorts page's
// Funnels view gets the AI column.
//
// Design contracts, in order of importance:
// - Pure: no Deno, no fetch, no clock — `asOfDate` is injected. Runs identically
//   in the browser, in vitest and in an edge function.
// - Deterministic-first: everything here is rules; a model may later REPHRASE
//   the output (reportNarrative discipline) but never computes it.
// - No second data path: benchmarks are pooled from the input rows themselves
//   (reportCollect warning: a second collection path is a second set of
//   formulas and silent drift).
// - null is never 0: fb_spend=null means "spend unknown" and suppresses the
//   whole economics family AND caps the action space — you cannot move a
//   budget you cannot price.
// - CPA here ALWAYS means cost per trial. FbAnalyticsRow.cac is spend/trials
//   (that is CPA in this vocabulary); CohortRow.fb_cac is spend/first_subs and
//   is deliberately NOT read by this engine.
//
// Wilson interval: a verbatim twin of wilsonInterval in
// src/services/bankAnalyticsDataSource.ts (client module — _shared cannot
// import it). Keep z in sync if that one ever changes.

import {
  computeDelta,
  isCohortMature,
  renderCount,
  renderMoney,
  renderPercent,
  renderRatio,
  type MetricPolarity,
} from "./reportBuilder.ts";
import {
  DEFAULT_THRESHOLDS,
  scoreFinding,
  type FindingSeverity,
  type ReportThresholds,
} from "./reportRules.ts";
import { round2 } from "./financialPrimitives.ts";
import type { FbAnalyticsRow } from "./fbAnalyticsCompute.ts";
import type { FbMatchStatus } from "./fbCohortStats.ts";
import type { AiCampaignDailyPoint } from "./aiCampaignSeries.ts";

export const AI_SIGNALS_ENGINE_VERSION = "ai-signals-v2";

// ---- Thresholds -------------------------------------------------------------

export interface AiThresholds extends ReportThresholds {
  /** Operator pass-rate goal (percent) quoted in the reportRules header. */
  passRateTarget: number;
  /** Below this pass rate the payment stack, not the budget, is the problem. */
  passRateFloor: number;
  /** first_sub -> renewal_2 conversion floor (percent). */
  retentionC2Floor: number;
  ltvCpaStrongRatio: number;
  ltvCpaWeakRatio: number;
  paybackFastDays: number;
  paybackSlowDays: number;
  /** SCALE +20 needs CPA <= headroom x ceiling so the post-scale marginal CPA
   * stays under the ceiling. This is the +10 vs +20 trigger. */
  scaleStrongHeadroom: number;
  /** Benchmark GOOD/BAD needs >= this relative separation from peers (on top
   * of Wilson separation for rates) so chips do not flap. */
  benchmarkRel: number;
  upsellRevenuePerTrialTarget: number;
  /** Min pooled FB purchases per 7d window for a campaign CPA_fb trend —
   * minTrialsForSignificance (50) would starve a week-sized window. */
  minFbPurchasesForTrend: number;
}

export const AI_DEFAULT_THRESHOLDS: AiThresholds = {
  ...DEFAULT_THRESHOLDS,
  passRateTarget: 60,
  passRateFloor: 45,
  retentionC2Floor: 50,
  ltvCpaStrongRatio: 1.0,
  ltvCpaWeakRatio: 0.5,
  paybackFastDays: 30,
  paybackSlowDays: 60,
  scaleStrongHeadroom: 0.8,
  benchmarkRel: 0.15,
  upsellRevenuePerTrialTarget: 5,
  minFbPurchasesForTrend: 20,
};

/** Minimum peer rows for a pooled benchmark to qualify. */
export const MIN_BENCHMARK_PEERS = 4;
/** Cohorts pooled per side of a path trend comparison. */
export const TREND_WINDOW_COHORTS = 3;
/** Minimum attempts for any pass-rate verdict (signalBadge floor). */
export const MIN_PASS_RATE_ATTEMPTS = 30;

// ---- Vocabulary -------------------------------------------------------------

export type AiSurface = "cohort" | "campaign";
export type AiConfidence = "high" | "medium" | "low";
export type AiProblemDomain = "traffic" | "payment" | "conversion" | "retention" | "refund" | "data";
export type AiMetricVerdict = "good" | "bad" | "neutral" | "inconclusive";
export type AiInputFamily = "spend" | "payment" | "maturity" | "benchmark" | "trend";

export type AiScope =
  | { kind: "cohort"; cohortDate: string; funnel: string; campaignPath: string }
  | { kind: "path"; campaignPath: string }
  | { kind: "campaign"; campaignId: string; campaignName: string | null };

export type AiSignalCode =
  | "CPA_GOOD" | "CPA_BAD" | "CPA_IMPROVING" | "CPA_DETERIORATING"
  | "TRIAL_TO_PAID_GOOD" | "TRIAL_TO_PAID_BAD" | "TRIAL_TO_PAID_IMPROVING" | "TRIAL_TO_PAID_DETERIORATING"
  | "PAYMENT_PASS_GOOD" | "PAYMENT_PASS_BAD"
  | "RETENTION_GOOD" | "RETENTION_BAD"
  | "REFUND_RATE_HIGH"
  | "LTV_CPA_STRONG" | "LTV_CPA_WEAK"
  | "PAYBACK_FAST" | "PAYBACK_SLOW" | "PAYBACK_NOT_REACHED"
  | "HIGH_UPSELL_REVENUE" | "LOW_UPSELL_REVENUE"
  | "LOW_SAMPLE_SIZE";

export type AiSignalFamily =
  | "cpa" | "conversion" | "payment" | "retention" | "refund" | "ltv" | "payback" | "upsell" | "sample";

export type AiUnit = "money" | "percent" | "count" | "ratio" | "days";

export interface AiEvidence {
  /** Stable metric key: "cpa" | "trial_to_paid" | "pass_rate" | ... */
  metric: string;
  label: string;
  value: number | null;
  /** Pre-rendered; "—" when value is null — NEVER "0". */
  valueRendered: string;
  unit: AiUnit;
  benchmark: {
    value: number;
    rendered: string;
    source: "path_peers" | "global_peers" | "threshold" | "trend_previous";
    peers: number | null;
  } | null;
  delta: {
    absolute: number;
    relative: number | null;
    rendered: string;
    direction: "up" | "down" | "flat";
  } | null;
  verdict: AiMetricVerdict;
  sampleSize: number | null;
  evidencePath: string;
}

export type AiDataNoteCode =
  | "spend_unavailable"
  | "spend_partial_coverage"
  | "immature_cohort"
  | "not_maturity_gated"
  | "maturity_unknown"
  | "mixed_currency"
  | "path_level_pass_rate"
  | "no_time_axis"
  | "interpolated_payback"
  /** Path grain: only part of the path's cohorts (and trials) are mature. */
  | "partial_maturity"
  /** Path grain: payback judged on the mature (age >= 60d) subset only. */
  | "payback_mature_subset"
  | "main_decline_reason"
  | "pass_rate_detail"
  | "low_sample";

export interface AiDataNote {
  code: AiDataNoteCode;
  detail: string;
}

export interface AiSignal {
  code: AiSignalCode;
  family: AiSignalFamily;
  polarity: "good" | "bad" | "neutral";
  severity: FindingSeverity;
  scope: AiScope;
  surface: AiSurface;
  /** Sentence with the numbers already rendered in. */
  claim: string;
  evidence: AiEvidence[];
  confidence: AiConfidence;
  confidenceScore: number;
  provenance: string[];
  ruleId: string;
}

export type AiAction = "SCALE" | "HOLD" | "WATCH" | "REDUCE" | "STOP" | "INVESTIGATE" | "NOT_ENOUGH_DATA";

export type AiBudgetDeltaPct = 10 | 20 | -10 | -20 | -30;

export type AiContradictionFlag =
  | "cheap_but_weak"
  | "expensive_but_converting"
  | "good_cpa_bad_downstream"
  | "good_economics_bad_payment";

export interface AiContradiction {
  flag: AiContradictionFlag;
  claim: string;
}

export interface AiRecommendation {
  action: AiAction;
  budgetDeltaPct: AiBudgetDeltaPct | null;
  scope: AiScope;
  surface: AiSurface;
  /** Ladder rung id — the decision is replayable from it. */
  ruleId: string;
  claim: string;
  /** Ordered; drives the expanded panel. */
  because: AiEvidence[];
  primaryDomain: AiProblemDomain;
  contradictions: AiContradiction[];
  /** Metric keys to re-check after acting. */
  monitorAfter: string[];
  dataNotes: AiDataNote[];
  signals: AiSignalCode[];
  confidence: AiConfidence;
  confidenceScore: number;
}

export interface AiOpportunity {
  /** `${surface}:${scopeKey}:${ruleId}` — stable across runs. */
  id: string;
  recommendation: AiRecommendation;
  budgetShare: number;
  score: number;
}

export interface AiPassRateSlice {
  attempts: number;
  successful: number;
  pass_rate: number;
  pass_rate_ex_if: number;
  first_sub_attempts: number;
  first_sub_pass_rate: number;
  renewal_attempts: number;
  renewal_pass_rate: number;
}

/** Structural slice of CohortRow / CohortAggregateRow the engine reads. */
export interface AiCohortRowInput {
  cohort_date: string;
  funnel: string;
  campaign_path: string;
  trial_users: number;
  first_subscription_users: number;
  renewal_2_users?: number | null;
  refund_users: number;
  amount_refunded: number;
  gross_revenue: number;
  upsell_revenue?: number | null;
  revenue_d0?: number | null;
  revenue_d7?: number | null;
  revenue_d14?: number | null;
  revenue_d30?: number | null;
  revenue_d60?: number | null;
  ltv_1m_per_user?: number | null;
  fb_spend?: number | null;
  fb_match_status?: FbMatchStatus | string | null;
  fb_currency?: string | null;
  coverage_rate?: number | null;
}

export interface AiContextPackItem {
  scopeLabel: string;
  scopeKind: AiScope["kind"];
  action: string;
  confidence: AiConfidence;
  claim: string;
  evidenceLines: string[];
  contradictionLines: string[];
  /** Joined monitorAfter metric keys; empty string when none. */
  monitorLine: string;
  dataNotes: string[];
}

export interface AiContextPack {
  engineVersion: string;
  asOfDate: string;
  items: AiContextPackItem[];
  inputStatusLines: string[];
}

export interface AiEngineInput {
  surface: AiSurface;
  cohortRows?: readonly AiCohortRowInput[];
  campaignRows?: readonly FbAnalyticsRow[];
  /** Daily spend/purchases per campaign_id (aiCampaignSeries) — gives the
   * campaign surface its trend axis; direction-only CPA_fb, never a level. */
  campaignDailySeries?: Readonly<Record<string, readonly AiCampaignDailyPoint[]>>;
  passRates?: {
    level: "funnel" | "campaign_path" | "campaign_id";
    byKey: Readonly<Record<string, AiPassRateSlice>>;
  } | null;
  trialDurationDaysByPath?: Readonly<Record<string, number | null>>;
  thresholds?: Partial<AiThresholds>;
  asOfDate: string;
  /** budgetShare denominator; derived from rows when omitted. */
  totalSpend?: number | null;
}

export interface AiEngineOutput {
  engineVersion: typeof AI_SIGNALS_ENGINE_VERSION;
  asOfDate: string;
  signals: AiSignal[];
  /** Exactly one per scope (cohort/campaign rows AND, on the cohort surface,
   * one per campaign_path — scope.kind === "path"). */
  recommendations: AiRecommendation[];
  /** Ranked desc by score, ties broken by id. */
  opportunities: AiOpportunity[];
  inputStatus: Record<AiInputFamily, "ok" | "partial" | "missing">;
  contextPack: AiContextPack;
  /** Effective merged thresholds — frozen alongside persisted snapshots. */
  thresholds: AiThresholds;
}

// ---- Stat + render helpers --------------------------------------------------

const WILSON_Z = 1.959963984540054;

export function wilsonInterval95(successes: number, attempts: number): { low: number; high: number } {
  if (attempts <= 0) return { low: 0, high: 1 };
  const p = successes / attempts;
  const z2 = WILSON_Z * WILSON_Z;
  const denom = 1 + z2 / attempts;
  const center = p + z2 / (2 * attempts);
  const spread = WILSON_Z * Math.sqrt((p * (1 - p) + z2 / (4 * attempts)) / attempts);
  return { low: (center - spread) / denom, high: (center + spread) / denom };
}

function renderUnit(value: number, unit: AiUnit): string {
  switch (unit) {
    case "money":
      return renderMoney(value);
    case "percent":
      return renderPercent(value);
    case "count":
      return renderCount(value);
    case "ratio":
      return renderRatio(value);
    case "days":
      return `D${Math.round(value)}`;
  }
}

const DASH = "—";

function evidence(params: {
  metric: string;
  label: string;
  value: number | null;
  unit: AiUnit;
  benchmark?: AiEvidence["benchmark"];
  delta?: AiEvidence["delta"];
  verdict?: AiMetricVerdict;
  sampleSize?: number | null;
  evidencePath: string;
}): AiEvidence {
  return {
    metric: params.metric,
    label: params.label,
    value: params.value === null ? null : round2(params.value),
    valueRendered: params.value === null ? DASH : renderUnit(params.value, params.unit),
    unit: params.unit,
    benchmark: params.benchmark ?? null,
    delta: params.delta ?? null,
    verdict: params.verdict ?? "neutral",
    sampleSize: params.sampleSize ?? null,
    evidencePath: params.evidencePath,
  };
}

function thresholdBenchmark(value: number, unit: AiUnit): AiEvidence["benchmark"] {
  return { value: round2(value), rendered: renderUnit(value, unit), source: "threshold", peers: null };
}

function safeDiv(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  const out = numerator / denominator;
  return Number.isFinite(out) ? out : null;
}

function cohortAgeDays(cohortDate: string, asOfDate: string): number {
  const from = Date.parse(`${cohortDate}T00:00:00Z`);
  const to = Date.parse(`${asOfDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, Math.floor((to - from) / 86_400_000));
}

function scopeKey(scope: AiScope): string {
  if (scope.kind === "cohort") return `cohort|${scope.cohortDate}|${scope.funnel}|${scope.campaignPath}`;
  if (scope.kind === "path") return `path|${scope.campaignPath}`;
  return `campaign|${scope.campaignId}`;
}

export function aiScopeLabel(scope: AiScope): string {
  if (scope.kind === "cohort") return `${scope.campaignPath} · ${scope.cohortDate}`;
  if (scope.kind === "path") return scope.campaignPath;
  return scope.campaignName ? `${scope.campaignName} (${scope.campaignId})` : scope.campaignId;
}

function confidenceBucket(score: number): AiConfidence {
  if (score >= 0.7) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function sampleFactor(sample: number, minSample: number): number {
  if (!Number.isFinite(sample) || sample <= 0) return 0.2;
  return Math.min(1, Math.max(0.2, sample / minSample));
}

// ---- Spend usability --------------------------------------------------------

const SPEND_USABLE_MATCH: ReadonlySet<string> = new Set(["matched", "partial_coverage"]);

interface SpendInfo {
  usable: boolean;
  spend: number | null;
  /** 1 full, 0.7 partial. */
  factor: number;
  partial: boolean;
}

function cohortSpendInfo(row: AiCohortRowInput): SpendInfo {
  const status = String(row.fb_match_status ?? "");
  const usable = row.fb_spend != null && Number.isFinite(row.fb_spend) && row.fb_spend > 0 && SPEND_USABLE_MATCH.has(status);
  if (!usable) return { usable: false, spend: null, factor: 0, partial: false };
  const coverage = typeof row.coverage_rate === "number" ? row.coverage_rate : null;
  const partial = status === "partial_coverage" || (coverage !== null && coverage < 80);
  return { usable: true, spend: row.fb_spend as number, factor: partial ? 0.7 : 1, partial };
}

function campaignSpendInfo(row: FbAnalyticsRow): SpendInfo {
  const usable = row.spend != null && Number.isFinite(row.spend) && row.spend > 0 && row.spend_status === "available";
  return usable
    ? { usable: true, spend: row.spend as number, factor: 1, partial: false }
    : { usable: false, spend: null, factor: 0, partial: false };
}

// ---- Pooled benchmarks ------------------------------------------------------

interface Pool {
  numerator: number;
  denominator: number;
  rows: number;
}

const EMPTY_POOL: Pool = { numerator: 0, denominator: 0, rows: 0 };

function addPool(a: Pool, numerator: number, denominator: number): Pool {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return a;
  return { numerator: a.numerator + numerator, denominator: a.denominator + denominator, rows: a.rows + 1 };
}

function subtractPool(a: Pool, numerator: number, denominator: number): Pool {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return a;
  return { numerator: a.numerator - numerator, denominator: a.denominator - denominator, rows: a.rows - 1 };
}

/** Leave-one-out pooled benchmark with the path -> global fallback and the
 * qualification gate (>= MIN_BENCHMARK_PEERS rows, pooled denominator >= minDenom). */
function resolveBenchmark(params: {
  pathPool: Pool;
  globalPool: Pool;
  ownNumerator: number | null;
  ownDenominator: number | null;
  minDenom: number;
  unit: AiUnit;
  /** Scale the pooled ratio into the metric's unit (e.g. x100 for percents). */
  scale?: number;
}): AiEvidence["benchmark"] {
  const scale = params.scale ?? 1;
  const candidates: Array<{ pool: Pool; source: "path_peers" | "global_peers" }> = [
    { pool: params.pathPool, source: "path_peers" },
    { pool: params.globalPool, source: "global_peers" },
  ];
  for (const { pool, source } of candidates) {
    const peers = params.ownNumerator !== null && params.ownDenominator !== null
      ? subtractPool(pool, params.ownNumerator, params.ownDenominator)
      : pool;
    if (peers.rows >= MIN_BENCHMARK_PEERS && peers.denominator >= params.minDenom) {
      const value = round2((peers.numerator / peers.denominator) * scale);
      return { value, rendered: renderUnit(value, params.unit), source, peers: peers.rows };
    }
  }
  return null;
}

/** Relative comparison against a benchmark with the anti-flap gate: needs
 * >= benchmarkRel separation, and for rates Wilson separation on n >= 30. */
function benchmarkVerdict(params: {
  value: number;
  benchmark: NonNullable<AiEvidence["benchmark"]>;
  polarity: MetricPolarity;
  thresholds: AiThresholds;
  rate?: { successes: number; attempts: number; benchmarkRate: number } | null;
}): AiMetricVerdict {
  const { value, benchmark, polarity, thresholds } = params;
  if (benchmark.value === 0) return "inconclusive";
  const rel = Math.abs(value - benchmark.value) / Math.abs(benchmark.value);
  if (rel < thresholds.benchmarkRel) return "neutral";
  if (params.rate) {
    if (params.rate.attempts < MIN_PASS_RATE_ATTEMPTS) return "inconclusive";
    const interval = wilsonInterval95(params.rate.successes, params.rate.attempts);
    const bench = params.rate.benchmarkRate;
    const separated = interval.low > bench || interval.high < bench;
    if (!separated) return "neutral";
  }
  const higherIsBetter = polarity === "higher_better";
  const above = value > benchmark.value;
  if (polarity === "neutral") return "neutral";
  return above === higherIsBetter ? "good" : "bad";
}

// ---- Pass-rate verdict ------------------------------------------------------
//
// A fixed floor alone is useless when the whole account sits below it (live
// account pass rate ≈ 40% vs the 45% floor): every row would scream
// "payment issue" and the column would carry no information. "Bad" therefore
// requires BOTH the absolute floor breach AND Wilson-95 separation BELOW the
// pooled account norm — a path must be a payment anomaly, not merely share the
// account's baseline weakness.

function pooledPassRate(passRates: AiEngineInput["passRates"]): number | null {
  if (!passRates) return null;
  let successful = 0;
  let attempts = 0;
  for (const slice of Object.values(passRates.byKey)) {
    successful += slice.successful;
    attempts += slice.attempts;
  }
  return attempts > 0 ? successful / attempts : null;
}

function passRateEvidence(
  slice: AiPassRateSlice,
  globalPassRate: number | null,
  thresholds: AiThresholds,
  evidencePath: string,
): AiEvidence {
  const pct = slice.pass_rate * 100;
  let verdict: AiMetricVerdict = "neutral";
  if (slice.attempts < MIN_PASS_RATE_ATTEMPTS) {
    verdict = "inconclusive";
  } else if (pct >= thresholds.passRateTarget) {
    verdict = "good";
  } else if (pct < thresholds.passRateFloor) {
    const interval = wilsonInterval95(slice.successful, slice.attempts);
    verdict = globalPassRate === null || interval.high < globalPassRate ? "bad" : "neutral";
  }
  const benchmark = globalPassRate !== null
    ? { value: round2(globalPassRate * 100), rendered: renderPercent(globalPassRate * 100), source: "global_peers" as const, peers: null }
    : thresholdBenchmark(thresholds.passRateTarget, "percent");
  return evidence({
    metric: "pass_rate", label: "Payment pass", value: pct, unit: "percent",
    benchmark, verdict, sampleSize: slice.attempts, evidencePath,
  });
}

/** The pass-rate sub-metrics the summary line drops: ex-IF, first-sub vs
 * renewal split. One rendered note so the panel and the assistant see them. */
function passRateDetailNote(slice: AiPassRateSlice): AiDataNote {
  return {
    code: "pass_rate_detail",
    detail: `Pass ex-IF ${renderPercent(slice.pass_rate_ex_if * 100)} · first-sub ${renderPercent(slice.first_sub_pass_rate * 100)} (${renderCount(slice.first_sub_attempts)} att.) · renewal ${renderPercent(slice.renewal_pass_rate * 100)} (${renderCount(slice.renewal_attempts)} att.).`,
  };
}

// ---- Payback (observed grid, v1 — no extrapolation) -------------------------

export interface PaybackReading {
  status: "reached" | "not_reached_mature" | "not_reached_yet" | "unavailable";
  /** Rounded day; interpolated between grid points when needed. */
  day: number | null;
  interpolated: boolean;
  ageDays: number;
}

const REVENUE_AT_DAY: ReadonlyArray<{ day: number; field: keyof AiCohortRowInput }> = [
  { day: 0, field: "revenue_d0" },
  { day: 7, field: "revenue_d7" },
  { day: 14, field: "revenue_d14" },
  { day: 30, field: "revenue_d30" },
  { day: 60, field: "revenue_d60" },
];

/** Walk an observed cumulative-revenue grid against spend. Shared by the
 * per-cohort reading and the path-grain mature-subset reading. */
function paybackFromGrid(grid: ReadonlyArray<{ day: number; revenue: number }>, spend: number, ageDays: number): PaybackReading {
  if (!grid.length) return { status: "unavailable", day: null, interpolated: false, ageDays };
  let prev: { day: number; revenue: number } | null = null;
  for (const point of grid) {
    if (point.revenue >= spend) {
      if (prev && point.revenue > prev.revenue && prev.revenue < spend) {
        const day = prev.day + ((spend - prev.revenue) * (point.day - prev.day)) / (point.revenue - prev.revenue);
        return { status: "reached", day: Math.round(day), interpolated: true, ageDays };
      }
      return { status: "reached", day: point.day, interpolated: false, ageDays };
    }
    prev = point;
  }
  const maxObserved = grid[grid.length - 1].day;
  if (maxObserved >= 60) return { status: "not_reached_mature", day: null, interpolated: false, ageDays };
  return { status: "not_reached_yet", day: null, interpolated: false, ageDays };
}

export function observedPayback(row: AiCohortRowInput, spend: number | null, asOfDate: string): PaybackReading {
  const ageDays = cohortAgeDays(row.cohort_date, asOfDate);
  if (spend === null || spend <= 0) return { status: "unavailable", day: null, interpolated: false, ageDays };
  const grid = REVENUE_AT_DAY
    .filter((g) => g.day <= ageDays)
    .map((g) => ({ day: g.day, revenue: typeof row[g.field] === "number" ? (row[g.field] as number) : null }))
    .filter((g): g is { day: number; revenue: number } => g.revenue !== null && Number.isFinite(g.revenue));
  return paybackFromGrid(grid, spend, ageDays);
}

// ---- The ladder result ------------------------------------------------------

interface LadderVerdict {
  action: AiAction;
  budgetDeltaPct: AiBudgetDeltaPct | null;
  ruleId: string;
  primaryDomain: AiProblemDomain;
  monitorAfter: string[];
  severity: FindingSeverity;
}

const ACTION_SEVERITY: Record<AiAction, FindingSeverity> = {
  STOP: "critical",
  REDUCE: "high",
  INVESTIGATE: "high",
  SCALE: "high",
  WATCH: "medium",
  HOLD: "low",
  NOT_ENOUGH_DATA: "info",
};

function reduceStep(cpa: number, ceiling: number): AiBudgetDeltaPct {
  const ratio = cpa / ceiling;
  if (ratio > 1.5) return -30;
  if (ratio > 1.25) return -20;
  return -10;
}

// ---- Row analysis (shared math per scope) -----------------------------------

interface RowAnalysis {
  scope: AiScope;
  surface: AiSurface;
  trials: number;
  spendInfo: SpendInfo;
  cpa: number | null;
  /** Trial -> paid CR in PERCENT; null when unknowable (immature / no gate proof). */
  conv: number | null;
  refundUserRate: number | null;
  refundAmountRate: number | null;
  passRate: AiPassRateSlice | null;
  c2: number | null;
  ltvRatio: number | null;
  payback: PaybackReading | null;
  upsellPerTrial: number | null;
  roas: number | null;
  mainDeclineReason: string | null;
  ageDays: number | null;
  dataNotes: AiDataNote[];
  evidences: Map<string, AiEvidence>;
  trendCpaDeteriorating: boolean | null;
  trendKnown: boolean;
  /** Extra multiplicative confidence factor (path grain: mature-trial share,
   * mixed-currency discount). 1 elsewhere. */
  confidenceExtraFactor: number;
}

// ---- Cohort surface ---------------------------------------------------------

/** Mature-subset (age >= 60d, spend-usable) revenue grid sums for the path
 * payback reading — a pooled twin of the per-row observed grid. */
interface PathPaybackAcc {
  spend: number;
  revenue: { d0: number; d7: number; d14: number; d30: number; d60: number };
  rows: number;
  trials: number;
  maxAgeDays: number;
}

interface CohortPools {
  cpaByPath: Map<string, Pool>;
  cpaGlobal: Pool;
  convByPath: Map<string, Pool>;
  convGlobal: Pool;
  /** Amount-based refunds (Σ amount_refunded / Σ gross_revenue) — the cohort
   * surface's refund definition, pooled per path. */
  refundAmountByPath: Map<string, Pool>;
  refundAmountGlobal: Pool;
  /** First sub -> Renewal 2 over rows old enough to observe it (age >= 60d). */
  c2ByPath: Map<string, Pool>;
  c2Global: Pool;
  d7RecoveryByPath: Map<string, Pool>;
  d7RecoveryGlobal: Pool;
  /** Σ revenue_d30 / Σ usable spend over rows age >= 30 — pooled LTV(1m)/CPA. */
  d30RecoveryByPath: Map<string, Pool>;
  d30RecoveryGlobal: Pool;
  upsellByPath: Map<string, Pool>;
  upsellGlobal: Pool;
  paybackByPath: Map<string, PathPaybackAcc>;
  /** Distinct fb currencies seen on spend-usable rows, per path. */
  currenciesByPath: Map<string, Set<string>>;
}

function buildCohortPools(
  rows: readonly AiCohortRowInput[],
  asOfDate: string,
  trialDurationFor: (path: string) => number | null,
): CohortPools {
  const pools: CohortPools = {
    cpaByPath: new Map(),
    cpaGlobal: EMPTY_POOL,
    convByPath: new Map(),
    convGlobal: EMPTY_POOL,
    refundAmountByPath: new Map(),
    refundAmountGlobal: EMPTY_POOL,
    c2ByPath: new Map(),
    c2Global: EMPTY_POOL,
    d7RecoveryByPath: new Map(),
    d7RecoveryGlobal: EMPTY_POOL,
    d30RecoveryByPath: new Map(),
    d30RecoveryGlobal: EMPTY_POOL,
    upsellByPath: new Map(),
    upsellGlobal: EMPTY_POOL,
    paybackByPath: new Map(),
    currenciesByPath: new Map(),
  };
  const bump = (map: Map<string, Pool>, key: string, num: number, den: number) => {
    map.set(key, addPool(map.get(key) ?? EMPTY_POOL, num, den));
  };
  for (const row of rows) {
    const path = row.campaign_path;
    const spend = cohortSpendInfo(row);
    const age = cohortAgeDays(row.cohort_date, asOfDate);
    if (spend.usable && row.trial_users > 0) {
      bump(pools.cpaByPath, path, spend.spend as number, row.trial_users);
      pools.cpaGlobal = addPool(pools.cpaGlobal, spend.spend as number, row.trial_users);
      if (age >= 7 && typeof row.revenue_d7 === "number") {
        bump(pools.d7RecoveryByPath, path, row.revenue_d7, spend.spend as number);
        pools.d7RecoveryGlobal = addPool(pools.d7RecoveryGlobal, row.revenue_d7, spend.spend as number);
      }
      if (age >= 30 && typeof row.revenue_d30 === "number") {
        bump(pools.d30RecoveryByPath, path, row.revenue_d30, spend.spend as number);
        pools.d30RecoveryGlobal = addPool(pools.d30RecoveryGlobal, row.revenue_d30, spend.spend as number);
      }
      if (row.fb_currency) {
        const set = pools.currenciesByPath.get(path) ?? new Set<string>();
        set.add(row.fb_currency);
        pools.currenciesByPath.set(path, set);
      }
      if (age >= 60) {
        const acc = pools.paybackByPath.get(path) ?? {
          spend: 0, revenue: { d0: 0, d7: 0, d14: 0, d30: 0, d60: 0 }, rows: 0, trials: 0, maxAgeDays: 0,
        };
        acc.spend += spend.spend as number;
        acc.revenue.d0 += typeof row.revenue_d0 === "number" ? row.revenue_d0 : 0;
        acc.revenue.d7 += typeof row.revenue_d7 === "number" ? row.revenue_d7 : 0;
        acc.revenue.d14 += typeof row.revenue_d14 === "number" ? row.revenue_d14 : 0;
        acc.revenue.d30 += typeof row.revenue_d30 === "number" ? row.revenue_d30 : 0;
        acc.revenue.d60 += typeof row.revenue_d60 === "number" ? row.revenue_d60 : 0;
        acc.rows += 1;
        acc.trials += row.trial_users;
        acc.maxAgeDays = Math.max(acc.maxAgeDays, age);
        pools.paybackByPath.set(path, acc);
      }
    }
    if (row.trial_users > 0 && isCohortMature(row.cohort_date, trialDurationFor(path), asOfDate)) {
      bump(pools.convByPath, path, row.first_subscription_users, row.trial_users);
      pools.convGlobal = addPool(pools.convGlobal, row.first_subscription_users, row.trial_users);
    }
    if (row.gross_revenue > 0) {
      bump(pools.refundAmountByPath, path, row.amount_refunded, row.gross_revenue);
      pools.refundAmountGlobal = addPool(pools.refundAmountGlobal, row.amount_refunded, row.gross_revenue);
    }
    if (age >= 60 && row.first_subscription_users > 0 && typeof row.renewal_2_users === "number") {
      bump(pools.c2ByPath, path, row.renewal_2_users, row.first_subscription_users);
      pools.c2Global = addPool(pools.c2Global, row.renewal_2_users, row.first_subscription_users);
    }
    if (row.trial_users > 0 && typeof row.upsell_revenue === "number") {
      bump(pools.upsellByPath, path, row.upsell_revenue, row.trial_users);
      pools.upsellGlobal = addPool(pools.upsellGlobal, row.upsell_revenue, row.trial_users);
    }
  }
  return pools;
}

/** All paths pooled together — the peer set for PATH-grain benchmarks. One
 * "row" per path, so leave-one-out yields (paths − 1) peers. */
function pathPeersPool(byPath: ReadonlyMap<string, Pool>): Pool {
  let numerator = 0;
  let denominator = 0;
  for (const pool of byPath.values()) {
    numerator += pool.numerator;
    denominator += pool.denominator;
  }
  return { numerator, denominator, rows: byPath.size };
}

interface PathTrend {
  cpaDeteriorating: boolean | null;
  known: boolean;
  signals: AiSignal[];
}

function buildPathTrends(
  rows: readonly AiCohortRowInput[],
  asOfDate: string,
  trialDurationFor: (path: string) => number | null,
  thresholds: AiThresholds,
): Map<string, PathTrend> {
  const byPath = new Map<string, AiCohortRowInput[]>();
  for (const row of rows) {
    const list = byPath.get(row.campaign_path) ?? [];
    list.push(row);
    byPath.set(row.campaign_path, list);
  }
  const out = new Map<string, PathTrend>();
  for (const [path, list] of byPath) {
    const sorted = [...list].sort((a, b) =>
      a.cohort_date === b.cohort_date ? a.funnel.localeCompare(b.funnel) : a.cohort_date.localeCompare(b.cohort_date),
    );
    const trend: PathTrend = { cpaDeteriorating: null, known: false, signals: [] };

    const emit = (params: {
      family: "cpa" | "conversion";
      metric: string; label: string; unit: AiUnit; polarity: MetricPolarity;
      recent: Pool; previous: Pool; scale: number;
      goodCode: AiSignalCode; badCode: AiSignalCode;
    }) => {
      if (params.recent.rows < TREND_WINDOW_COHORTS || params.previous.rows < TREND_WINDOW_COHORTS) return null;
      const recentValue = round2((params.recent.numerator / params.recent.denominator) * params.scale);
      const previousValue = round2((params.previous.numerator / params.previous.denominator) * params.scale);
      const delta = computeDelta(recentValue, previousValue, params.unit === "money" ? "money" : "percent", {
        polarity: params.polarity,
        sampleSize: Math.min(params.recent.denominator, params.previous.denominator),
        minSample: thresholds.minTrialsForSignificance,
        minRelative: thresholds.minRelativeMove,
      });
      if (!delta || !delta.significant || delta.better === null) return null;
      const code = delta.better ? params.goodCode : params.badCode;
      const scoreValue = round2(sampleFactor(Math.min(params.recent.denominator, params.previous.denominator), thresholds.minTrialsForSignificance));
      trend.signals.push({
        code,
        family: params.family,
        polarity: delta.better ? "good" : "bad",
        severity: delta.better ? "low" : "medium",
        scope: { kind: "path", campaignPath: path },
        surface: "cohort",
        claim: `${params.label} for ${path}: last ${TREND_WINDOW_COHORTS} cohorts ${renderUnit(recentValue, params.unit)} vs ${renderUnit(previousValue, params.unit)} before (${delta.percentRendered}).`,
        evidence: [
          evidence({
            metric: `${params.metric}_trend`, label: `${params.label} (trend)`, value: recentValue, unit: params.unit,
            benchmark: { value: previousValue, rendered: renderUnit(previousValue, params.unit), source: "trend_previous", peers: TREND_WINDOW_COHORTS },
            delta: { absolute: delta.absolute, relative: delta.percent, rendered: delta.percentRendered, direction: delta.direction },
            verdict: delta.better ? "good" : "bad",
            sampleSize: Math.min(params.recent.denominator, params.previous.denominator),
            evidencePath: `path[${path}].${params.metric}_trend`,
          }),
        ],
        confidence: confidenceBucket(scoreValue),
        confidenceScore: scoreValue,
        provenance: [`trend_${TREND_WINDOW_COHORTS}v${TREND_WINDOW_COHORTS}`],
        ruleId: `trend_${params.metric}`,
      });
      return delta.better;
    };

    const spendRows = sorted.filter((r) => cohortSpendInfo(r).usable && r.trial_users > 0);
    if (spendRows.length >= TREND_WINDOW_COHORTS * 2) {
      trend.known = true;
      const recent = spendRows.slice(-TREND_WINDOW_COHORTS);
      const previous = spendRows.slice(-TREND_WINDOW_COHORTS * 2, -TREND_WINDOW_COHORTS);
      const pool = (rs: AiCohortRowInput[]) =>
        rs.reduce((acc, r) => addPool(acc, cohortSpendInfo(r).spend as number, r.trial_users), EMPTY_POOL);
      const better = emit({
        family: "cpa", metric: "cpa", label: "CPA", unit: "money", polarity: "lower_better",
        recent: pool(recent), previous: pool(previous), scale: 1,
        goodCode: "CPA_IMPROVING", badCode: "CPA_DETERIORATING",
      });
      trend.cpaDeteriorating = better === null ? null : !better;
    }

    const matureRows = sorted.filter((r) => r.trial_users > 0 && isCohortMature(r.cohort_date, trialDurationFor(path), asOfDate));
    if (matureRows.length >= TREND_WINDOW_COHORTS * 2) {
      const recent = matureRows.slice(-TREND_WINDOW_COHORTS);
      const previous = matureRows.slice(-TREND_WINDOW_COHORTS * 2, -TREND_WINDOW_COHORTS);
      const pool = (rs: AiCohortRowInput[]) =>
        rs.reduce((acc, r) => addPool(acc, r.first_subscription_users, r.trial_users), EMPTY_POOL);
      emit({
        family: "conversion", metric: "trial_to_paid", label: "Trial → Paid", unit: "percent", polarity: "higher_better",
        recent: pool(recent), previous: pool(previous), scale: 100,
        goodCode: "TRIAL_TO_PAID_IMPROVING", badCode: "TRIAL_TO_PAID_DETERIORATING",
      });
    }

    out.set(path, trend);
  }
  return out;
}

// ---- Analysis builders ------------------------------------------------------

function analyzeCohortRow(
  row: AiCohortRowInput,
  pools: CohortPools,
  trends: Map<string, PathTrend>,
  passRates: AiEngineInput["passRates"],
  globalPassRate: number | null,
  trialDurationFor: (path: string) => number | null,
  thresholds: AiThresholds,
  asOfDate: string,
): RowAnalysis {
  const scope: AiScope = { kind: "cohort", cohortDate: row.cohort_date, funnel: row.funnel, campaignPath: row.campaign_path };
  const notes: AiDataNote[] = [];
  const evidences = new Map<string, AiEvidence>();
  const spendInfo = cohortSpendInfo(row);
  const ageDays = cohortAgeDays(row.cohort_date, asOfDate);
  const trials = row.trial_users;

  if (!spendInfo.usable) {
    notes.push({ code: "spend_unavailable", detail: `FB spend is not attributable to this cohort (${String(row.fb_match_status ?? "no fb data")}). Budget actions are unavailable.` });
  } else if (spendInfo.partial) {
    notes.push({ code: "spend_partial_coverage", detail: "FB spend covers this cohort only partially; economics read with reduced confidence." });
  }

  const cpa = spendInfo.usable ? safeDiv(spendInfo.spend as number, trials) : null;
  if (cpa !== null) {
    const benchmark = resolveBenchmark({
      pathPool: pools.cpaByPath.get(row.campaign_path) ?? EMPTY_POOL,
      globalPool: pools.cpaGlobal,
      ownNumerator: spendInfo.spend,
      ownDenominator: trials,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "money",
    });
    const verdict = benchmark
      ? benchmarkVerdict({ value: cpa, benchmark, polarity: "lower_better", thresholds })
      : (cpa <= thresholds.cpaCeiling ? "good" : "bad");
    evidences.set("cpa", evidence({
      metric: "cpa", label: "CPA", value: cpa, unit: "money",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.cpaCeiling, "money"),
      verdict, sampleSize: trials,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].cpa`,
    }));
  }

  const trialDuration = trialDurationFor(row.campaign_path);
  const mature = isCohortMature(row.cohort_date, trialDuration, asOfDate);
  let conv: number | null = null;
  if (trialDuration === null) {
    notes.push({ code: "maturity_unknown", detail: "Trial duration for this funnel path is not configured; conversion maturity cannot be proven." });
  } else if (!mature) {
    notes.push({ code: "immature_cohort", detail: `Cohort is ${ageDays}d old and still inside the ${Math.round(trialDuration)}d trial window; Trial → Paid is not judged yet.` });
  } else {
    conv = trials > 0 ? ((row.first_subscription_users / trials) * 100) : null;
    if (conv !== null) {
      const benchmark = resolveBenchmark({
        pathPool: pools.convByPath.get(row.campaign_path) ?? EMPTY_POOL,
        globalPool: pools.convGlobal,
        ownNumerator: row.first_subscription_users,
        ownDenominator: trials,
        minDenom: thresholds.minTrialsForVerdict,
        unit: "percent",
        scale: 100,
      });
      const verdict = benchmark
        ? benchmarkVerdict({
            value: conv, benchmark, polarity: "higher_better", thresholds,
            rate: { successes: row.first_subscription_users, attempts: trials, benchmarkRate: benchmark.value / 100 },
          })
        : (conv >= thresholds.trialToSubTarget ? "good" : "bad");
      evidences.set("trial_to_paid", evidence({
        metric: "trial_to_paid", label: "Trial → Paid", value: conv, unit: "percent",
        benchmark: benchmark ?? thresholdBenchmark(thresholds.trialToSubTarget, "percent"),
        verdict, sampleSize: trials,
        evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].trial_to_paid`,
      }));
    }
  }

  const refundAmountRate = row.gross_revenue > 0 ? (row.amount_refunded / row.gross_revenue) * 100 : null;
  const refundUserRate = trials > 0 ? (row.refund_users / trials) * 100 : null;
  if (refundAmountRate !== null) {
    evidences.set("refund_rate", evidence({
      metric: "refund_rate", label: "Refund rate ($)", value: refundAmountRate, unit: "percent",
      benchmark: thresholdBenchmark(thresholds.refundRateCeiling, "percent"),
      verdict: refundAmountRate > thresholds.refundRateCeiling ? "bad" : "good",
      sampleSize: trials,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].refund_rate_amount`,
    }));
  }

  let passRate: AiPassRateSlice | null = null;
  if (passRates && passRates.level !== "campaign_id") {
    const key = passRates.level === "funnel" ? row.funnel : row.campaign_path;
    passRate = passRates.byKey[key] ?? null;
    if (passRate) {
      notes.push({ code: "path_level_pass_rate", detail: "Payment pass rate is funnel-path level (per-cohort pass rate is not tracked)." });
      notes.push(passRateDetailNote(passRate));
      evidences.set("pass_rate", passRateEvidence(passRate, globalPassRate, thresholds, `path[${row.campaign_path}].pass_rate`));
    }
  }

  const c2Observable = ageDays >= 60 && row.first_subscription_users > 0 && typeof row.renewal_2_users === "number";
  const c2 = c2Observable ? ((row.renewal_2_users as number) / row.first_subscription_users) * 100 : null;
  if (c2 !== null) {
    evidences.set("retention_c2", evidence({
      metric: "retention_c2", label: "First sub → Renewal 2", value: c2, unit: "percent",
      benchmark: thresholdBenchmark(thresholds.retentionC2Floor, "percent"),
      verdict: c2 < thresholds.retentionC2Floor ? "bad" : "good",
      sampleSize: row.first_subscription_users,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].retention_c2`,
    }));
  }

  const ltv = typeof row.ltv_1m_per_user === "number"
    ? row.ltv_1m_per_user
    : (typeof row.revenue_d30 === "number" ? safeDiv(row.revenue_d30, trials) : null);
  const ltvRatio = ageDays >= 30 && cpa !== null && ltv !== null && cpa > 0 ? ltv / cpa : null;
  if (ltvRatio !== null) {
    evidences.set("ltv_cpa", evidence({
      metric: "ltv_cpa", label: "LTV(1m) / CPA", value: ltvRatio, unit: "ratio",
      benchmark: thresholdBenchmark(thresholds.ltvCpaStrongRatio, "ratio"),
      verdict: ltvRatio >= thresholds.ltvCpaStrongRatio ? "good" : ltvRatio < thresholds.ltvCpaWeakRatio ? "bad" : "neutral",
      sampleSize: trials,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].ltv_cpa`,
    }));
  }

  const payback = observedPayback(row, spendInfo.spend, asOfDate);
  if (payback.status === "reached" && payback.day !== null) {
    if (payback.interpolated) notes.push({ code: "interpolated_payback", detail: "Payback day interpolated between observed revenue grid points." });
    evidences.set("payback", evidence({
      metric: "payback", label: "Payback", value: payback.day, unit: "days",
      benchmark: thresholdBenchmark(thresholds.paybackFastDays, "days"),
      verdict: payback.day <= thresholds.paybackFastDays ? "good" : payback.day <= thresholds.paybackSlowDays ? "neutral" : "bad",
      sampleSize: trials,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].payback`,
    }));
  } else if (payback.status === "not_reached_mature") {
    evidences.set("payback", evidence({
      metric: "payback", label: "Payback", value: null, unit: "days",
      benchmark: thresholdBenchmark(thresholds.paybackSlowDays, "days"),
      verdict: "bad", sampleSize: trials,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].payback`,
    }));
  }

  const upsellPerTrial = typeof row.upsell_revenue === "number" ? safeDiv(row.upsell_revenue, trials) : null;
  if (upsellPerTrial !== null) {
    const benchmark = resolveBenchmark({
      pathPool: pools.upsellByPath.get(row.campaign_path) ?? EMPTY_POOL,
      globalPool: pools.upsellGlobal,
      ownNumerator: row.upsell_revenue as number,
      ownDenominator: trials,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "money",
    });
    evidences.set("upsell_per_trial", evidence({
      metric: "upsell_per_trial", label: "Upsell revenue / trial", value: upsellPerTrial, unit: "money",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.upsellRevenuePerTrialTarget, "money"),
      verdict: upsellPerTrial >= thresholds.upsellRevenuePerTrialTarget
        ? "good"
        : upsellPerTrial < thresholds.upsellRevenuePerTrialTarget / 2 ? "bad" : "neutral",
      sampleSize: trials,
      evidencePath: `cohort[${row.cohort_date}|${row.funnel}|${row.campaign_path}].upsell_per_trial`,
    }));
  }

  const trend = trends.get(row.campaign_path) ?? null;

  return {
    scope, surface: "cohort", trials, spendInfo, cpa,
    conv,
    refundUserRate, refundAmountRate, passRate, c2, ltvRatio, payback,
    upsellPerTrial, roas: null, mainDeclineReason: null, ageDays,
    dataNotes: notes, evidences,
    trendCpaDeteriorating: trend?.cpaDeteriorating ?? null,
    trendKnown: trend?.known ?? false,
    confidenceExtraFactor: 1,
  };
}

/** PATH-grain analysis: one recommendation per campaign_path, derived from the
 * SAME cohort-row run. Pooled sums (never averages of row rates), conversion
 * judged on the mature subset only, refunds amount-based (the cohort surface's
 * definition), payback on the age>=60 spend-usable subset, and the trend
 * clause is REAL — path trends are computed from the row series. Peers for
 * benchmarks are the OTHER paths. */
function analyzePathGroup(params: {
  path: string;
  rows: readonly AiCohortRowInput[];
  pools: CohortPools;
  trend: PathTrend | null;
  passRates: AiEngineInput["passRates"];
  globalPassRate: number | null;
  thresholds: AiThresholds;
  asOfDate: string;
}): RowAnalysis {
  const { path, rows, pools, trend, thresholds, asOfDate } = params;
  const scope: AiScope = { kind: "path", campaignPath: path };
  const notes: AiDataNote[] = [];
  const evidences = new Map<string, AiEvidence>();
  const ev = (metric: string) => `path[${path}].${metric}`;

  const trials = rows.reduce((sum, row) => sum + row.trial_users, 0);
  const maxAge = rows.reduce((max, row) => Math.max(max, cohortAgeDays(row.cohort_date, asOfDate)), 0);

  // Spend: pooled over usable rows; partial when any usable row is partial or
  // when some rows carry no usable spend at all.
  const usableRows = rows.filter((row) => cohortSpendInfo(row).usable);
  const anyPartial = usableRows.some((row) => cohortSpendInfo(row).partial);
  const spendSum = usableRows.reduce((sum, row) => sum + (cohortSpendInfo(row).spend as number), 0);
  const spendInfo: SpendInfo = usableRows.length
    ? { usable: true, spend: spendSum, factor: anyPartial || usableRows.length < rows.length ? 0.7 : 1, partial: anyPartial || usableRows.length < rows.length }
    : { usable: false, spend: null, factor: 0, partial: false };
  if (!spendInfo.usable) {
    notes.push({ code: "spend_unavailable", detail: "No cohort on this path carries attributable FB spend. Budget actions are unavailable." });
  } else if (spendInfo.partial) {
    notes.push({ code: "spend_partial_coverage", detail: `FB spend covers ${renderCount(usableRows.length)} of ${renderCount(rows.length)} cohorts on this path; economics read with reduced confidence.` });
  }

  let confidenceExtraFactor = 1;
  const currencies = pools.currenciesByPath.get(path);
  if (currencies && currencies.size > 1) {
    notes.push({ code: "mixed_currency", detail: `FB spend on this path mixes ${renderCount(currencies.size)} currencies; pooled sums read with reduced confidence.` });
    confidenceExtraFactor *= 0.7;
  }

  // CPA: the path pool itself; peers = other paths.
  const cpaPool = pools.cpaByPath.get(path) ?? EMPTY_POOL;
  const cpa = cpaPool.denominator > 0 ? cpaPool.numerator / cpaPool.denominator : null;
  if (cpa !== null) {
    const benchmark = resolveBenchmark({
      pathPool: EMPTY_POOL,
      globalPool: pathPeersPool(pools.cpaByPath),
      ownNumerator: cpaPool.numerator,
      ownDenominator: cpaPool.denominator,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "money",
    });
    const verdict = benchmark
      ? benchmarkVerdict({ value: cpa, benchmark, polarity: "lower_better", thresholds })
      : (cpa <= thresholds.cpaCeiling ? "good" : "bad");
    evidences.set("cpa", evidence({
      metric: "cpa", label: "CPA", value: cpa, unit: "money",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.cpaCeiling, "money"),
      verdict, sampleSize: cpaPool.denominator, evidencePath: ev("cpa"),
    }));
  }

  // Trial -> Paid: mature subset only. Empty subset = "too early", never 0.
  const convPool = pools.convByPath.get(path) ?? EMPTY_POOL;
  const matureTrials = convPool.denominator;
  const conv = matureTrials > 0 ? (convPool.numerator / convPool.denominator) * 100 : null;
  if (conv === null) {
    notes.push({ code: "partial_maturity", detail: "No cohort on this path has matured yet; Trial → Paid is not judged." });
  } else {
    if (convPool.rows < rows.length) {
      notes.push({ code: "partial_maturity", detail: `${renderCount(convPool.rows)} of ${renderCount(rows.length)} cohorts (${renderCount(matureTrials)} of ${renderCount(trials)} trials) are mature; Trial → Paid judged on that subset.` });
      confidenceExtraFactor *= Math.min(1, Math.max(0.5, trials > 0 ? matureTrials / trials : 0.5));
    }
    const benchmark = resolveBenchmark({
      pathPool: EMPTY_POOL,
      globalPool: pathPeersPool(pools.convByPath),
      ownNumerator: convPool.numerator,
      ownDenominator: convPool.denominator,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "percent",
      scale: 100,
    });
    const verdict = benchmark
      ? benchmarkVerdict({
          value: conv, benchmark, polarity: "higher_better", thresholds,
          rate: { successes: convPool.numerator, attempts: convPool.denominator, benchmarkRate: benchmark.value / 100 },
        })
      : (conv >= thresholds.trialToSubTarget ? "good" : "bad");
    evidences.set("trial_to_paid", evidence({
      metric: "trial_to_paid", label: "Trial → Paid", value: conv, unit: "percent",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.trialToSubTarget, "percent"),
      verdict, sampleSize: matureTrials, evidencePath: ev("trial_to_paid"),
    }));
  }

  // Refunds: amount-based (the cohort surface's definition, pooled).
  const refundPool = pools.refundAmountByPath.get(path) ?? EMPTY_POOL;
  const refundAmountRate = refundPool.denominator > 0 ? (refundPool.numerator / refundPool.denominator) * 100 : null;
  if (refundAmountRate !== null) {
    evidences.set("refund_rate", evidence({
      metric: "refund_rate", label: "Refund rate ($)", value: refundAmountRate, unit: "percent",
      benchmark: thresholdBenchmark(thresholds.refundRateCeiling, "percent"),
      verdict: refundAmountRate > thresholds.refundRateCeiling ? "bad" : "good",
      sampleSize: trials, evidencePath: ev("refund_rate_amount"),
    }));
  }

  // Pass rate: native at this grain when slices are path-keyed.
  let passRate: AiPassRateSlice | null = null;
  if (params.passRates?.level === "campaign_path") {
    passRate = params.passRates.byKey[path] ?? null;
    if (passRate) {
      notes.push(passRateDetailNote(passRate));
      evidences.set("pass_rate", passRateEvidence(passRate, params.globalPassRate, thresholds, ev("pass_rate")));
    }
  }

  // Retention c2: pooled over rows old enough to observe it.
  const c2Pool = pools.c2ByPath.get(path) ?? EMPTY_POOL;
  const c2 = c2Pool.denominator > 0 ? (c2Pool.numerator / c2Pool.denominator) * 100 : null;
  if (c2 !== null) {
    evidences.set("retention_c2", evidence({
      metric: "retention_c2", label: "First sub → Renewal 2", value: c2, unit: "percent",
      benchmark: thresholdBenchmark(thresholds.retentionC2Floor, "percent"),
      verdict: c2 < thresholds.retentionC2Floor ? "bad" : "good",
      sampleSize: c2Pool.denominator, evidencePath: ev("retention_c2"),
    }));
  }

  // LTV(1m)/CPA: pooled Σd30 / Σspend over age>=30 usable rows == LTV/CPA.
  const d30Pool = pools.d30RecoveryByPath.get(path) ?? EMPTY_POOL;
  const ltvRatio = d30Pool.denominator > 0 ? d30Pool.numerator / d30Pool.denominator : null;
  if (ltvRatio !== null) {
    evidences.set("ltv_cpa", evidence({
      metric: "ltv_cpa", label: "LTV(1m) / CPA", value: ltvRatio, unit: "ratio",
      benchmark: thresholdBenchmark(thresholds.ltvCpaStrongRatio, "ratio"),
      verdict: ltvRatio >= thresholds.ltvCpaStrongRatio ? "good" : ltvRatio < thresholds.ltvCpaWeakRatio ? "bad" : "neutral",
      sampleSize: trials, evidencePath: ev("ltv_cpa"),
    }));
  }

  // Payback: the mature (age>=60, spend-usable) subset, pooled grid.
  const paybackAcc = pools.paybackByPath.get(path) ?? null;
  let payback: PaybackReading | null = null;
  if (paybackAcc && paybackAcc.spend > 0) {
    const grid = [
      { day: 0, revenue: paybackAcc.revenue.d0 },
      { day: 7, revenue: paybackAcc.revenue.d7 },
      { day: 14, revenue: paybackAcc.revenue.d14 },
      { day: 30, revenue: paybackAcc.revenue.d30 },
      { day: 60, revenue: paybackAcc.revenue.d60 },
    ];
    payback = paybackFromGrid(grid, paybackAcc.spend, paybackAcc.maxAgeDays);
    if (paybackAcc.rows < rows.length) {
      notes.push({ code: "payback_mature_subset", detail: `Payback judged on the ${renderCount(paybackAcc.rows)} mature cohorts (${renderCount(paybackAcc.trials)} trials) old enough to observe D60.` });
    }
    if (payback.status === "reached" && payback.day !== null) {
      if (payback.interpolated) notes.push({ code: "interpolated_payback", detail: "Payback day interpolated between observed revenue grid points." });
      evidences.set("payback", evidence({
        metric: "payback", label: "Payback", value: payback.day, unit: "days",
        benchmark: thresholdBenchmark(thresholds.paybackFastDays, "days"),
        verdict: payback.day <= thresholds.paybackFastDays ? "good" : payback.day <= thresholds.paybackSlowDays ? "neutral" : "bad",
        sampleSize: paybackAcc.trials, evidencePath: ev("payback"),
      }));
    } else if (payback.status === "not_reached_mature") {
      evidences.set("payback", evidence({
        metric: "payback", label: "Payback", value: null, unit: "days",
        benchmark: thresholdBenchmark(thresholds.paybackSlowDays, "days"),
        verdict: "bad", sampleSize: paybackAcc.trials, evidencePath: ev("payback"),
      }));
    }
  } else if (spendInfo.usable) {
    // No mature spend-usable rows yet: show the early d7-recovery read instead.
    const d7Pool = pools.d7RecoveryByPath.get(path) ?? EMPTY_POOL;
    const d7Recovery = d7Pool.denominator > 0 ? d7Pool.numerator / d7Pool.denominator : null;
    if (d7Recovery !== null) {
      const benchmark = resolveBenchmark({
        pathPool: EMPTY_POOL,
        globalPool: pathPeersPool(pools.d7RecoveryByPath),
        ownNumerator: d7Pool.numerator,
        ownDenominator: d7Pool.denominator,
        minDenom: 1,
        unit: "ratio",
      });
      evidences.set("d7_recovery", evidence({
        metric: "d7_recovery", label: "D7 spend recovery", value: d7Recovery, unit: "ratio",
        benchmark, verdict: "neutral", sampleSize: trials, evidencePath: ev("d7_recovery"),
      }));
    }
  }

  // Upsell per trial with path peers.
  const upsellPool = pools.upsellByPath.get(path) ?? EMPTY_POOL;
  const upsellPerTrial = upsellPool.denominator > 0 ? upsellPool.numerator / upsellPool.denominator : null;
  if (upsellPerTrial !== null) {
    const benchmark = resolveBenchmark({
      pathPool: EMPTY_POOL,
      globalPool: pathPeersPool(pools.upsellByPath),
      ownNumerator: upsellPool.numerator,
      ownDenominator: upsellPool.denominator,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "money",
    });
    evidences.set("upsell_per_trial", evidence({
      metric: "upsell_per_trial", label: "Upsell revenue / trial", value: upsellPerTrial, unit: "money",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.upsellRevenuePerTrialTarget, "money"),
      verdict: upsellPerTrial >= thresholds.upsellRevenuePerTrialTarget
        ? "good"
        : upsellPerTrial < thresholds.upsellRevenuePerTrialTarget / 2 ? "bad" : "neutral",
      sampleSize: trials, evidencePath: ev("upsell_per_trial"),
    }));
  }

  // Trend evidence: copy the trend signals' evidences so the rung-5 decision
  // is replayable from the panel.
  if (trend) {
    for (const signal of trend.signals) {
      const first = signal.evidence[0];
      if (!first) continue;
      if (signal.family === "cpa") evidences.set("cpa_trend", first);
      if (signal.family === "conversion") evidences.set("trial_to_paid_trend", first);
    }
  }

  return {
    scope, surface: "cohort", trials, spendInfo, cpa,
    conv,
    refundUserRate: null, refundAmountRate, passRate, c2, ltvRatio, payback,
    upsellPerTrial, roas: null, mainDeclineReason: null, ageDays: maxAge,
    dataNotes: notes, evidences,
    trendCpaDeteriorating: trend?.cpaDeteriorating ?? null,
    trendKnown: trend?.known ?? false,
    confidenceExtraFactor,
  };
}

interface CampaignPools {
  cpaByPath: Map<string, Pool>;
  cpaGlobal: Pool;
  convByPath: Map<string, Pool>;
  convGlobal: Pool;
  refundUserByPath: Map<string, Pool>;
  refundUserGlobal: Pool;
}

function buildCampaignPools(rows: readonly FbAnalyticsRow[]): CampaignPools {
  const pools: CampaignPools = {
    cpaByPath: new Map(), cpaGlobal: EMPTY_POOL,
    convByPath: new Map(), convGlobal: EMPTY_POOL,
    refundUserByPath: new Map(), refundUserGlobal: EMPTY_POOL,
  };
  const bump = (map: Map<string, Pool>, key: string, num: number, den: number) => {
    map.set(key, addPool(map.get(key) ?? EMPTY_POOL, num, den));
  };
  for (const row of rows) {
    const spend = campaignSpendInfo(row);
    if (spend.usable && row.trial_users > 0) {
      bump(pools.cpaByPath, row.campaign_path, spend.spend as number, row.trial_users);
      pools.cpaGlobal = addPool(pools.cpaGlobal, spend.spend as number, row.trial_users);
    }
    if (row.trial_users > 0) {
      bump(pools.convByPath, row.campaign_path, row.first_subscription_users, row.trial_users);
      pools.convGlobal = addPool(pools.convGlobal, row.first_subscription_users, row.trial_users);
      bump(pools.refundUserByPath, row.campaign_path, row.refund_users, row.trial_users);
      pools.refundUserGlobal = addPool(pools.refundUserGlobal, row.refund_users, row.trial_users);
    }
  }
  return pools;
}

interface CampaignTrendReading {
  known: boolean;
  deteriorating: boolean | null;
  evidence: AiEvidence | null;
  signalCode: AiSignalCode | null;
  /** Pooled purchases of the thinner window — the trend's sample size. */
  sample: number;
}

/** 7d-vs-previous-7d pooled CPA_fb trend, anchored to the SERIES max date
 * (coverage depends on manual syncs; anchoring to "today" would empty the
 * recent window whenever the sync lags). Direction only: CPA_fb is
 * spend / FB purchases and is never compared against cpaCeiling. */
function campaignCpaTrend(
  series: readonly AiCampaignDailyPoint[] | undefined,
  campaignId: string,
  thresholds: AiThresholds,
): CampaignTrendReading {
  const none: CampaignTrendReading = { known: false, deteriorating: null, evidence: null, signalCode: null, sample: 0 };
  if (!series?.length) return none;
  const maxDate = series[series.length - 1].date;
  const maxMs = Date.parse(`${maxDate}T00:00:00Z`);
  if (!Number.isFinite(maxMs)) return none;
  const dayOffset = (date: string) => Math.round((maxMs - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
  const recent = series.filter((p) => dayOffset(p.date) >= 0 && dayOffset(p.date) < 7);
  const previous = series.filter((p) => dayOffset(p.date) >= 7 && dayOffset(p.date) < 14);
  const window = (points: AiCampaignDailyPoint[]) => ({
    spendDays: points.filter((p) => p.spend > 0).length,
    spend: points.reduce((sum, p) => sum + p.spend, 0),
    purchases: points.reduce((sum, p) => sum + p.purchases, 0),
  });
  const r = window(recent);
  const p = window(previous);
  // >=4 active days and >0 purchases per side; zero-purchase windows are
  // "unknown", never an infinite CPA.
  if (r.spendDays < 4 || p.spendDays < 4 || r.purchases <= 0 || p.purchases <= 0) return none;
  const recentCpa = round2(r.spend / r.purchases);
  const previousCpa = round2(p.spend / p.purchases);
  const sample = Math.min(r.purchases, p.purchases);
  const delta = computeDelta(recentCpa, previousCpa, "money", {
    polarity: "lower_better",
    sampleSize: sample,
    minSample: thresholds.minFbPurchasesForTrend,
    minRelative: thresholds.minRelativeMove,
  });
  if (!delta || !delta.significant || delta.better === null) {
    // The axis exists and both windows qualify — the trend is KNOWN, just flat.
    return { known: true, deteriorating: null, evidence: null, signalCode: null, sample };
  }
  return {
    known: true,
    deteriorating: !delta.better,
    signalCode: delta.better ? "CPA_IMPROVING" : "CPA_DETERIORATING",
    sample,
    evidence: evidence({
      metric: "cpa_trend", label: "CPA trend (FB, 7d vs prev 7d)", value: recentCpa, unit: "money",
      benchmark: { value: previousCpa, rendered: renderMoney(previousCpa), source: "trend_previous", peers: null },
      delta: { absolute: delta.absolute, relative: delta.percent, rendered: delta.percentRendered, direction: delta.direction },
      verdict: delta.better ? "good" : "bad",
      sampleSize: sample,
      evidencePath: `campaign[${campaignId}].cpa_fb_trend`,
    }),
  };
}

function analyzeCampaignRow(
  row: FbAnalyticsRow,
  pools: CampaignPools,
  dailySeries: AiEngineInput["campaignDailySeries"],
  passRates: AiEngineInput["passRates"],
  globalPassRate: number | null,
  thresholds: AiThresholds,
): RowAnalysis {
  const scope: AiScope = { kind: "campaign", campaignId: row.campaign_id, campaignName: row.campaign_name };
  const notes: AiDataNote[] = [];
  const evidences = new Map<string, AiEvidence>();
  const spendInfo = campaignSpendInfo(row);
  const trials = row.trial_users;

  const trend = campaignCpaTrend(dailySeries?.[row.campaign_id], row.campaign_id, thresholds);
  if (trend.known) {
    if (trend.evidence) evidences.set("cpa_trend", trend.evidence);
  } else {
    notes.push({ code: "no_time_axis", detail: "No usable daily series for this campaign (needs two 7-day windows with spend and purchases); trend unknown." });
  }

  if (!spendInfo.usable) {
    notes.push({
      code: "spend_unavailable",
      detail: row.spend_status === "unavailable_shared_path"
        ? "Spend is not attributable: several campaigns share this funnel path."
        : "No traffic spend data for this campaign.",
    });
  }

  const cpa = spendInfo.usable ? row.cac : null;
  if (cpa !== null) {
    const benchmark = resolveBenchmark({
      pathPool: pools.cpaByPath.get(row.campaign_path) ?? EMPTY_POOL,
      globalPool: pools.cpaGlobal,
      ownNumerator: spendInfo.spend,
      ownDenominator: trials,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "money",
    });
    const verdict = benchmark
      ? benchmarkVerdict({ value: cpa, benchmark, polarity: "lower_better", thresholds })
      : (cpa <= thresholds.cpaCeiling ? "good" : "bad");
    evidences.set("cpa", evidence({
      metric: "cpa", label: "CPA", value: cpa, unit: "money",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.cpaCeiling, "money"),
      verdict, sampleSize: trials,
      evidencePath: `campaign[${row.campaign_id}].cpa`,
    }));
  }

  const conv = trials > 0 ? row.trial_to_sub_cr : null;
  if (conv !== null) {
    notes.push({ code: "not_maturity_gated", detail: "Campaign Trial → Paid is not maturity-gated; young trials drag it down." });
    const benchmark = resolveBenchmark({
      pathPool: pools.convByPath.get(row.campaign_path) ?? EMPTY_POOL,
      globalPool: pools.convGlobal,
      ownNumerator: row.first_subscription_users,
      ownDenominator: trials,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "percent",
      scale: 100,
    });
    const verdict = benchmark
      ? benchmarkVerdict({
          value: conv, benchmark, polarity: "higher_better", thresholds,
          rate: { successes: row.first_subscription_users, attempts: trials, benchmarkRate: benchmark.value / 100 },
        })
      : (conv >= thresholds.trialToSubTarget ? "good" : "bad");
    evidences.set("trial_to_paid", evidence({
      metric: "trial_to_paid", label: "Trial → Paid", value: conv, unit: "percent",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.trialToSubTarget, "percent"),
      verdict, sampleSize: trials,
      evidencePath: `campaign[${row.campaign_id}].trial_to_paid`,
    }));
  }

  const refundUserRate = trials > 0 ? row.refund_rate : null;
  if (refundUserRate !== null) {
    // Peer benchmark from the user-rate pools (the campaign surface's native
    // refund metric); the fixed ceiling still decides the verdict — peers only
    // contextualize it.
    const benchmark = resolveBenchmark({
      pathPool: pools.refundUserByPath.get(row.campaign_path) ?? EMPTY_POOL,
      globalPool: pools.refundUserGlobal,
      ownNumerator: row.refund_users,
      ownDenominator: trials,
      minDenom: thresholds.minTrialsForVerdict,
      unit: "percent",
      scale: 100,
    });
    evidences.set("refund_rate", evidence({
      metric: "refund_rate", label: "Refund rate (users)", value: refundUserRate, unit: "percent",
      benchmark: benchmark ?? thresholdBenchmark(thresholds.refundRateCeiling, "percent"),
      verdict: refundUserRate > thresholds.refundRateCeiling ? "bad" : "good",
      sampleSize: trials,
      evidencePath: `campaign[${row.campaign_id}].refund_rate_users`,
    }));
  }

  let passRate: AiPassRateSlice | null = null;
  if (passRates?.level === "campaign_id") {
    passRate = passRates.byKey[row.campaign_id] ?? null;
    if (passRate) {
      notes.push(passRateDetailNote(passRate));
      evidences.set("pass_rate", passRateEvidence(passRate, globalPassRate, thresholds, `campaign[${row.campaign_id}].pass_rate`));
    }
  }
  if (row.main_decline_reason) {
    notes.push({ code: "main_decline_reason", detail: `Main decline reason: ${String(row.main_decline_reason)}.` });
  }

  const roas = spendInfo.usable ? row.roas : null;
  if (roas !== null) {
    evidences.set("roas", evidence({
      metric: "roas", label: "ROAS (net)", value: roas, unit: "ratio",
      benchmark: thresholdBenchmark(1, "ratio"),
      verdict: roas >= 1 ? "good" : "neutral",
      sampleSize: trials,
      evidencePath: `campaign[${row.campaign_id}].roas`,
    }));
  }

  return {
    scope, surface: "campaign", trials, spendInfo, cpa,
    conv,
    refundUserRate, refundAmountRate: null, passRate, c2: null, ltvRatio: null, payback: null,
    upsellPerTrial: null, roas, mainDeclineReason: row.main_decline_reason ? String(row.main_decline_reason) : null,
    ageDays: null,
    dataNotes: notes, evidences,
    trendCpaDeteriorating: trend.deteriorating, trendKnown: trend.known,
    confidenceExtraFactor: 1,
  };
}

// ---- The ladder -------------------------------------------------------------

function runLadder(a: RowAnalysis, thresholds: AiThresholds): LadderVerdict {
  const refundBreachRate = a.surface === "cohort" ? a.refundAmountRate : a.refundUserRate;
  const qualityOk = (a.surface === "cohort"
    ? (a.refundAmountRate === null || a.refundAmountRate <= thresholds.refundRateCeiling)
    : (a.refundUserRate === null || a.refundUserRate <= thresholds.refundRateCeiling));
  const economicsAllowed = a.spendInfo.usable;

  // 1. sample_gate
  if (a.trials < thresholds.minTrialsForVerdict) {
    return { action: "NOT_ENOUGH_DATA", budgetDeltaPct: null, ruleId: "sample_gate", primaryDomain: "data", monitorAfter: ["trial_users"], severity: ACTION_SEVERITY.NOT_ENOUGH_DATA };
  }
  // 2. refund_breach_stop
  if (economicsAllowed && refundBreachRate !== null && refundBreachRate > thresholds.refundRateCeiling * 2) {
    return { action: "STOP", budgetDeltaPct: null, ruleId: "refund_breach_stop", primaryDomain: "refund", monitorAfter: ["refund_rate"], severity: ACTION_SEVERITY.STOP };
  }
  // 3. payment_investigate — evidence verdict is already floor-AND-below-account
  // (a fixed floor alone would flag every row when the whole account is weak).
  if (a.evidences.get("pass_rate")?.verdict === "bad") {
    const monitor = ["pass_rate", "first_sub_pass_rate"];
    if (a.mainDeclineReason) monitor.push("main_decline_reason");
    return { action: "INVESTIGATE", budgetDeltaPct: null, ruleId: "payment_investigate", primaryDomain: "payment", monitorAfter: monitor, severity: ACTION_SEVERITY.INVESTIGATE };
  }
  // 4. cpa_and_conv_breach
  if (economicsAllowed && a.cpa !== null && a.conv !== null &&
      a.cpa > thresholds.cpaCeiling * 1.5 && a.conv < thresholds.trialToSubTarget * 0.6) {
    return { action: "STOP", budgetDeltaPct: null, ruleId: "cpa_and_conv_breach", primaryDomain: "traffic", monitorAfter: ["cpa", "trial_to_paid"], severity: ACTION_SEVERITY.STOP };
  }
  // 5a. expensive_but_converting (campaign surface): with no usable trend
  // axis, rung 5's "trend unknown" clause would swallow every converting
  // campaign; positive net economics (roas >= 1) earns a HOLD instead. A
  // KNOWN deteriorating CPA_fb trend disqualifies the excuse and falls
  // through to rung 5 REDUCE.
  if (economicsAllowed && a.surface === "campaign" && a.cpa !== null && a.cpa > thresholds.cpaCeiling &&
      a.conv !== null && a.conv >= thresholds.trialToSubTarget && a.roas !== null && a.roas >= 1 &&
      a.trendCpaDeteriorating !== true) {
    return { action: "HOLD", budgetDeltaPct: null, ruleId: "expensive_but_converting", primaryDomain: "traffic", monitorAfter: ["cpa", "roas"], severity: ACTION_SEVERITY.HOLD };
  }
  // 5. cpa_breach_reduce
  if (economicsAllowed && a.cpa !== null && a.cpa > thresholds.cpaCeiling && a.trendCpaDeteriorating !== false) {
    return { action: "REDUCE", budgetDeltaPct: reduceStep(a.cpa, thresholds.cpaCeiling), ruleId: "cpa_breach_reduce", primaryDomain: "traffic", monitorAfter: ["cpa", "trial_to_paid"], severity: ACTION_SEVERITY.REDUCE };
  }
  // 6. expensive_but_converting
  if (economicsAllowed && a.cpa !== null && a.cpa > thresholds.cpaCeiling && a.conv !== null && a.conv >= thresholds.trialToSubTarget) {
    return { action: "HOLD", budgetDeltaPct: null, ruleId: "expensive_but_converting", primaryDomain: "traffic", monitorAfter: ["cpa"], severity: ACTION_SEVERITY.HOLD };
  }
  // 7. cheap_but_weak
  if (a.cpa !== null && a.cpa <= thresholds.cpaCeiling && a.conv !== null && a.conv < thresholds.trialToSubTarget * 0.7) {
    return { action: "WATCH", budgetDeltaPct: null, ruleId: "cheap_but_weak", primaryDomain: "conversion", monitorAfter: ["trial_to_paid", "cpa"], severity: ACTION_SEVERITY.WATCH };
  }
  // 8. good_cpa_bad_downstream
  if (a.cpa !== null && a.cpa <= thresholds.cpaCeiling) {
    const refundBad = refundBreachRate !== null && refundBreachRate > thresholds.refundRateCeiling;
    const retentionBad = a.c2 !== null && a.c2 < thresholds.retentionC2Floor;
    const paybackBad = a.payback?.status === "not_reached_mature";
    if (refundBad || retentionBad || paybackBad) {
      const domain: AiProblemDomain = refundBad ? "refund" : retentionBad ? "retention" : "traffic";
      return { action: "HOLD", budgetDeltaPct: null, ruleId: "good_cpa_bad_downstream", primaryDomain: domain, monitorAfter: refundBad ? ["refund_rate"] : retentionBad ? ["retention_c2"] : ["payback"], severity: ACTION_SEVERITY.HOLD };
    }
  }
  // 9-10. scale
  if (economicsAllowed && a.cpa !== null && a.conv !== null && qualityOk &&
      a.conv >= thresholds.trialToSubTarget && a.trials >= thresholds.minTrialsForSignificance) {
    const downstreamStrong = a.surface === "cohort"
      ? ((a.ltvRatio !== null && a.ltvRatio >= thresholds.ltvCpaStrongRatio) ||
         (a.payback?.status === "reached" && (a.payback.day ?? Infinity) <= thresholds.paybackFastDays))
      : (a.roas !== null && a.roas >= 1);
    if (a.cpa <= thresholds.cpaCeiling * thresholds.scaleStrongHeadroom && downstreamStrong) {
      return { action: "SCALE", budgetDeltaPct: 20, ruleId: "scale_strong", primaryDomain: "traffic", monitorAfter: ["cpa", "pass_rate", "refund_rate"], severity: ACTION_SEVERITY.SCALE };
    }
    if (a.cpa <= thresholds.cpaCeiling) {
      return { action: "SCALE", budgetDeltaPct: 10, ruleId: "scale_moderate", primaryDomain: "traffic", monitorAfter: ["cpa", "pass_rate", "refund_rate"], severity: ACTION_SEVERITY.SCALE };
    }
  }
  // 11. green_but_thin
  if (a.cpa !== null && a.conv !== null && a.cpa <= thresholds.cpaCeiling && a.conv >= thresholds.trialToSubTarget) {
    return { action: "WATCH", budgetDeltaPct: null, ruleId: "green_but_thin", primaryDomain: "traffic", monitorAfter: ["trial_users"], severity: ACTION_SEVERITY.WATCH };
  }
  // 12. one_side_off
  if (a.cpa !== null || a.conv !== null) {
    const domain: AiProblemDomain = a.conv !== null && a.conv < thresholds.trialToSubTarget ? "conversion" : "traffic";
    return { action: "HOLD", budgetDeltaPct: null, ruleId: "one_side_off", primaryDomain: domain, monitorAfter: ["cpa", "trial_to_paid"], severity: ACTION_SEVERITY.HOLD };
  }
  // 13. hold_default
  return { action: "HOLD", budgetDeltaPct: null, ruleId: "hold_default", primaryDomain: "data", monitorAfter: [], severity: ACTION_SEVERITY.HOLD };
}

// ---- Signals from an analysis ----------------------------------------------

function signalsForAnalysis(a: RowAnalysis, thresholds: AiThresholds, confidence: { bucket: AiConfidence; score: number }): AiSignal[] {
  const out: AiSignal[] = [];
  const push = (code: AiSignalCode, family: AiSignalFamily, polarity: "good" | "bad", severity: FindingSeverity, metricKey: string, claim: string, provenance: string[] = []) => {
    const ev = a.evidences.get(metricKey);
    out.push({
      code, family, polarity, severity,
      scope: a.scope, surface: a.surface, claim,
      evidence: ev ? [ev] : [],
      confidence: confidence.bucket, confidenceScore: confidence.score,
      provenance, ruleId: `signal_${code.toLowerCase()}`,
    });
  };

  if (a.trials < thresholds.minTrialsForVerdict) {
    push("LOW_SAMPLE_SIZE", "sample", "bad", "info", "cpa", `Only ${renderCount(a.trials)} trials — below the ${renderCount(thresholds.minTrialsForVerdict)} verdict floor.`);
    return out;
  }

  const cpaEv = a.evidences.get("cpa");
  if (cpaEv?.verdict === "good") push("CPA_GOOD", "cpa", "good", "low", "cpa", `CPA ${cpaEv.valueRendered} vs ${cpaEv.benchmark?.rendered ?? DASH}.`);
  if (cpaEv?.verdict === "bad") push("CPA_BAD", "cpa", "bad", "medium", "cpa", `CPA ${cpaEv.valueRendered} vs ${cpaEv.benchmark?.rendered ?? DASH}.`);

  // Campaign CPA_fb trend (path trends are emitted by buildPathTrends at path
  // scope — re-emitting here would duplicate them).
  const trendEv = a.evidences.get("cpa_trend");
  if (a.surface === "campaign" && trendEv) {
    if (trendEv.verdict === "good") push("CPA_IMPROVING", "cpa", "good", "low", "cpa_trend", `CPA (FB) improving: ${trendEv.valueRendered} last 7d vs ${trendEv.benchmark?.rendered ?? DASH} before (${trendEv.delta?.rendered ?? DASH}).`, ["trend_7v7_fb_purchases"]);
    if (trendEv.verdict === "bad") push("CPA_DETERIORATING", "cpa", "bad", "medium", "cpa_trend", `CPA (FB) deteriorating: ${trendEv.valueRendered} last 7d vs ${trendEv.benchmark?.rendered ?? DASH} before (${trendEv.delta?.rendered ?? DASH}).`, ["trend_7v7_fb_purchases"]);
  }

  const convEv = a.evidences.get("trial_to_paid");
  if (convEv?.verdict === "good") push("TRIAL_TO_PAID_GOOD", "conversion", "good", "low", "trial_to_paid", `Trial → Paid ${convEv.valueRendered} vs ${convEv.benchmark?.rendered ?? DASH}.`);
  if (convEv?.verdict === "bad") push("TRIAL_TO_PAID_BAD", "conversion", "bad", "medium", "trial_to_paid", `Trial → Paid ${convEv.valueRendered} vs ${convEv.benchmark?.rendered ?? DASH}.`);

  const passEv = a.evidences.get("pass_rate");
  if (passEv?.verdict === "good") push("PAYMENT_PASS_GOOD", "payment", "good", "low", "pass_rate", `Payment pass ${passEv.valueRendered} on ${renderCount(passEv.sampleSize ?? 0)} attempts.`);
  if (passEv?.verdict === "bad") push("PAYMENT_PASS_BAD", "payment", "bad", "high", "pass_rate", `Payment pass ${passEv.valueRendered} on ${renderCount(passEv.sampleSize ?? 0)} attempts — below the ${renderPercent(thresholds.passRateFloor)} floor.`);

  const retEv = a.evidences.get("retention_c2");
  if (retEv?.verdict === "good") push("RETENTION_GOOD", "retention", "good", "low", "retention_c2", `First sub → Renewal 2 at ${retEv.valueRendered}.`);
  if (retEv?.verdict === "bad") push("RETENTION_BAD", "retention", "bad", "medium", "retention_c2", `First sub → Renewal 2 at ${retEv.valueRendered} — below the ${renderPercent(thresholds.retentionC2Floor)} floor.`);

  const refundEv = a.evidences.get("refund_rate");
  if (refundEv?.verdict === "bad") push("REFUND_RATE_HIGH", "refund", "bad", "high", "refund_rate", `Refund rate ${refundEv.valueRendered} vs ceiling ${renderPercent(thresholds.refundRateCeiling)}.`);

  const ltvEv = a.evidences.get("ltv_cpa");
  if (ltvEv?.verdict === "good") push("LTV_CPA_STRONG", "ltv", "good", "low", "ltv_cpa", `LTV(1m)/CPA at ${ltvEv.valueRendered}.`);
  if (ltvEv?.verdict === "bad") push("LTV_CPA_WEAK", "ltv", "bad", "medium", "ltv_cpa", `LTV(1m)/CPA at ${ltvEv.valueRendered} — below ${renderRatio(thresholds.ltvCpaWeakRatio)}.`);

  if (a.payback?.status === "reached" && a.payback.day !== null) {
    const provenance = a.payback.interpolated ? ["interpolated"] : [];
    if (a.payback.day <= thresholds.paybackFastDays) {
      push("PAYBACK_FAST", "payback", "good", "low", "payback", `Paid back ${a.payback.interpolated ? "≈" : ""}D${a.payback.day}.`, provenance);
    } else if (a.payback.day <= thresholds.paybackSlowDays) {
      push("PAYBACK_SLOW", "payback", "bad", "low", "payback", `Paid back only by ${a.payback.interpolated ? "≈" : ""}D${a.payback.day}.`, provenance);
    }
  }
  if (a.payback?.status === "not_reached_mature") {
    push("PAYBACK_NOT_REACHED", "payback", "bad", "high", "payback", `Not paid back by D60 (cohort age ${renderCount(a.payback.ageDays)}d).`);
  }

  if (a.upsellPerTrial !== null) {
    if (a.upsellPerTrial >= thresholds.upsellRevenuePerTrialTarget) {
      push("HIGH_UPSELL_REVENUE", "upsell", "good", "low", "upsell_per_trial", `Upsell revenue ${renderMoney(a.upsellPerTrial)} per trial.`);
    } else if (a.upsellPerTrial < thresholds.upsellRevenuePerTrialTarget / 2) {
      push("LOW_UPSELL_REVENUE", "upsell", "bad", "info", "upsell_per_trial", `Upsell revenue ${renderMoney(a.upsellPerTrial)} per trial vs ${renderMoney(thresholds.upsellRevenuePerTrialTarget)} target.`);
    }
  }

  return out;
}

// ---- Contradictions ---------------------------------------------------------

function contradictionsForAnalysis(a: RowAnalysis, thresholds: AiThresholds): AiContradiction[] {
  const out: AiContradiction[] = [];
  const cpaEv = a.evidences.get("cpa");
  const convEv = a.evidences.get("trial_to_paid");
  const passEv = a.evidences.get("pass_rate");
  const cpaGood = a.cpa !== null && a.cpa <= thresholds.cpaCeiling;
  const convBad = a.conv !== null && a.conv < thresholds.trialToSubTarget * 0.7;
  const convGood = a.conv !== null && a.conv >= thresholds.trialToSubTarget;
  const cpaBad = a.cpa !== null && a.cpa > thresholds.cpaCeiling;
  const refundBad = (a.surface === "cohort" ? a.refundAmountRate : a.refundUserRate);

  if (cpaGood && convBad && cpaEv && convEv) {
    out.push({ flag: "cheap_but_weak", claim: `Cheap traffic, weak monetization: CPA ${cpaEv.valueRendered} but Trial → Paid ${convEv.valueRendered}. Do not scale on CPA alone.` });
  }
  if (cpaBad && convGood && cpaEv && convEv) {
    out.push({ flag: "expensive_but_converting", claim: `Expensive but converting: CPA ${cpaEv.valueRendered} over ceiling while Trial → Paid ${convEv.valueRendered}.` });
  }
  if (cpaGood && refundBad !== null && refundBad > thresholds.refundRateCeiling && cpaEv) {
    out.push({ flag: "good_cpa_bad_downstream", claim: `Healthy CPA ${cpaEv.valueRendered} undermined by refunds at ${renderPercent(refundBad)}.` });
  }
  if (cpaGood && convGood && passEv?.verdict === "bad") {
    out.push({ flag: "good_economics_bad_payment", claim: `Economics look healthy but payment pass is ${passEv.valueRendered} — the constraint is payments, not acquisition.` });
  }
  return out;
}

// ---- Confidence per analysis ------------------------------------------------

function analysisConfidence(a: RowAnalysis, thresholds: AiThresholds): { bucket: AiConfidence; score: number } {
  const sf = sampleFactor(a.trials, thresholds.minTrialsForSignificance);
  const maturityFactor = a.surface === "campaign" ? 0.8 : (a.conv !== null ? 1 : (a.ageDays !== null && a.ageDays >= 7 ? 0.6 : 0.4));
  const spendFactor = a.spendInfo.usable ? a.spendInfo.factor : 0.7;
  const benchmarkFactor = a.evidences.get("cpa")?.benchmark?.source === "threshold" ? 0.9 : 1;
  const score = round2(Math.min(1, sf * maturityFactor * spendFactor * benchmarkFactor * a.confidenceExtraFactor));
  return { bucket: confidenceBucket(score), score };
}

// ---- Claims -----------------------------------------------------------------

const ACTION_TEXT: Record<AiAction, string> = {
  SCALE: "Scale",
  HOLD: "Hold",
  WATCH: "Watch",
  REDUCE: "Reduce",
  STOP: "Stop",
  INVESTIGATE: "Investigate",
  NOT_ENOUGH_DATA: "Collect data",
};

export function aiActionLabel(action: AiAction, budgetDeltaPct: AiBudgetDeltaPct | null): string {
  if (budgetDeltaPct === null) return ACTION_TEXT[action];
  const sign = budgetDeltaPct > 0 ? "+" : "−";
  return `${ACTION_TEXT[action]} ${sign}${Math.abs(budgetDeltaPct)}%`;
}

function recommendationClaim(verdict: LadderVerdict, a: RowAnalysis, thresholds: AiThresholds): string {
  const label = aiActionLabel(verdict.action, verdict.budgetDeltaPct);
  switch (verdict.ruleId) {
    case "sample_gate":
      return `${label}: only ${renderCount(a.trials)} trials — below the ${renderCount(thresholds.minTrialsForVerdict)} decision floor.`;
    case "refund_breach_stop":
      return `${label}: refunds at ${renderPercent((a.surface === "cohort" ? a.refundAmountRate : a.refundUserRate) ?? 0)} are more than twice the ${renderPercent(thresholds.refundRateCeiling)} ceiling.`;
    case "payment_investigate":
      return `${label}: payment pass ${renderPercent((a.passRate?.pass_rate ?? 0) * 100)} is below the ${renderPercent(thresholds.passRateFloor)} floor — budget moves will not fix payments.`;
    case "cpa_and_conv_breach":
      return `${label}: CPA ${a.cpa === null ? DASH : renderMoney(a.cpa)} and Trial → Paid ${a.conv === null ? DASH : renderPercent(a.conv)} are both far outside targets.`;
    case "cpa_breach_reduce":
      return `${label}: CPA ${a.cpa === null ? DASH : renderMoney(a.cpa)} is over the ${renderMoney(thresholds.cpaCeiling)} ceiling${a.trendKnown ? " and not improving" : " with no improving trend on record"}.`;
    case "expensive_but_converting":
      return `${label}: CPA ${a.cpa === null ? DASH : renderMoney(a.cpa)} is over ceiling, but conversion holds ${a.conv === null ? DASH : renderPercent(a.conv)} — watch cost, keep volume.`;
    case "cheap_but_weak":
      return `${label}: acquisition is cheap (${a.cpa === null ? DASH : renderMoney(a.cpa)}) but Trial → Paid ${a.conv === null ? DASH : renderPercent(a.conv)} is far below target — do not scale on CPA alone.`;
    case "good_cpa_bad_downstream":
      return `${label}: CPA is healthy but downstream ${verdict.primaryDomain} quality undermines the economics.`;
    case "scale_strong":
      return `${label}: CPA ${a.cpa === null ? DASH : renderMoney(a.cpa)} with headroom, conversion above target and confirmed downstream economics.`;
    case "scale_moderate":
      return `${label}: CPA under ceiling and conversion above target; downstream economics not yet strong enough for +20%.`;
    case "green_but_thin":
      return `${label}: metrics look green but ${renderCount(a.trials)} trials is below the ${renderCount(thresholds.minTrialsForSignificance)} significance floor.`;
    case "one_side_off":
      return `${label}: one side of the funnel is off target or not yet measurable.`;
    default:
      return `${label}: no decisive signal either way.`;
  }
}

// ---- Recommendation assembly ------------------------------------------------

const BECAUSE_ORDER = [
  "cpa",
  "cpa_trend",
  "trial_to_paid",
  "trial_to_paid_trend",
  "pass_rate",
  "ltv_cpa",
  "payback",
  "d7_recovery",
  "retention_c2",
  "refund_rate",
  "upsell_per_trial",
  "roas",
];

function buildRecommendation(a: RowAnalysis, thresholds: AiThresholds): AiRecommendation {
  const verdict = runLadder(a, thresholds);
  const confidence = analysisConfidence(a, thresholds);
  const because = BECAUSE_ORDER
    .map((key) => a.evidences.get(key))
    .filter((ev): ev is AiEvidence => Boolean(ev));
  const contradictions = contradictionsForAnalysis(a, thresholds);
  const signals = signalsForAnalysis(a, thresholds, confidence);
  const notes = [...a.dataNotes];
  if (a.trials < thresholds.minTrialsForVerdict) {
    notes.push({ code: "low_sample", detail: `Only ${renderCount(a.trials)} trials; decisions need at least ${renderCount(thresholds.minTrialsForVerdict)}.` });
  }
  return {
    action: verdict.action,
    budgetDeltaPct: verdict.budgetDeltaPct,
    scope: a.scope,
    surface: a.surface,
    ruleId: verdict.ruleId,
    claim: recommendationClaim(verdict, a, thresholds),
    because,
    primaryDomain: verdict.primaryDomain,
    contradictions,
    monitorAfter: verdict.monitorAfter,
    dataNotes: notes,
    signals: signals.map((s) => s.code),
    confidence: confidence.bucket,
    confidenceScore: confidence.score,
  };
}

// ---- Opportunities ----------------------------------------------------------

const OPPORTUNITY_PER_PATH_CAP = 3;

function buildOpportunities(
  recommendations: readonly AiRecommendation[],
  analyses: ReadonlyMap<string, RowAnalysis>,
  totalSpend: number,
  thresholds: AiThresholds,
): AiOpportunity[] {
  const perPath = new Map<string, number>();
  const scored = recommendations
    .filter((rec) => rec.action !== "HOLD")
    .map((rec) => {
      const a = analyses.get(scopeKey(rec.scope));
      const spend = a?.spendInfo.spend ?? null;
      const budgetShare = totalSpend > 0 && spend !== null ? Math.min(1, spend / totalSpend) : 0.25;
      const severity = ACTION_SEVERITY[rec.action];
      const base = scoreFinding({
        severity,
        budgetShare,
        sampleSize: a?.trials ?? null,
        minSample: thresholds.minTrialsForSignificance,
      });
      // NOT analysisConfidence: opportunities weigh maturity/spend without the
      // sample factor (scoreFinding already prices the sample in).
      const maturityFactor = !a ? 0.6 : a.surface === "campaign" ? 0.8 : a.conv !== null ? 1 : 0.6;
      const spendFactor = a?.spendInfo.usable ? a.spendInfo.factor : 0.7;
      return {
        id: `${rec.surface}:${scopeKey(rec.scope)}:${rec.ruleId}`,
        recommendation: rec,
        budgetShare: round2(budgetShare),
        score: round2(base * maturityFactor * spendFactor),
      };
    })
    .sort((x, y) => (y.score - x.score) || x.id.localeCompare(y.id));

  const out: AiOpportunity[] = [];
  for (const opp of scored) {
    // Family-aware cap: one PATH opportunity per path, and up to
    // OPPORTUNITY_PER_PATH_CAP cohort/campaign opportunities per path — the
    // two families never crowd each other out.
    const scope = opp.recommendation.scope;
    const capKey = scope.kind === "campaign"
      ? scope.campaignId
      : scope.kind === "path" ? `path:${scope.campaignPath}` : scope.campaignPath;
    const cap = scope.kind === "path" ? 1 : OPPORTUNITY_PER_PATH_CAP;
    const used = perPath.get(capKey) ?? 0;
    if (used >= cap) continue;
    perPath.set(capKey, used + 1);
    out.push(opp);
  }
  return out;
}

// ---- Context pack -----------------------------------------------------------

function buildContextPack(
  recommendations: readonly AiRecommendation[],
  inputStatus: Record<AiInputFamily, "ok" | "partial" | "missing">,
  asOfDate: string,
): AiContextPack {
  const items = recommendations.map((rec) => ({
    scopeLabel: aiScopeLabel(rec.scope),
    scopeKind: rec.scope.kind,
    action: aiActionLabel(rec.action, rec.budgetDeltaPct),
    confidence: rec.confidence,
    claim: rec.claim,
    evidenceLines: rec.because.map((ev) => {
      const bench = ev.benchmark ? ` (benchmark ${ev.benchmark.rendered}${ev.benchmark.peers ? `, ${ev.benchmark.peers} peers` : ""})` : "";
      return `${ev.label}: ${ev.valueRendered}${bench} — ${ev.verdict}`;
    }),
    contradictionLines: rec.contradictions.map((contradiction) => contradiction.claim),
    monitorLine: rec.monitorAfter.join(", "),
    dataNotes: rec.dataNotes.map((note) => note.detail),
  }));
  const inputStatusLines = (Object.entries(inputStatus) as Array<[AiInputFamily, string]>)
    .filter(([, status]) => status !== "ok")
    .map(([family, status]) => `Input "${family}" is ${status}.`);
  return { engineVersion: AI_SIGNALS_ENGINE_VERSION, asOfDate, items, inputStatusLines };
}

// ---- Main entry -------------------------------------------------------------

export function computeAiSignals(input: AiEngineInput): AiEngineOutput {
  const thresholds: AiThresholds = { ...AI_DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const asOfDate = input.asOfDate;
  const trialDurationFor = (path: string): number | null => {
    const value = input.trialDurationDaysByPath?.[path];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  const analyses = new Map<string, RowAnalysis>();
  const signals: AiSignal[] = [];
  const recommendations: AiRecommendation[] = [];

  let spendUsableRows = 0;
  let totalRows = 0;
  let derivedTotalSpend = 0;
  let trendKnownPaths = 0;
  let pathCount = 0;

  if (input.surface === "cohort") {
    const rows = [...(input.cohortRows ?? [])].sort((a, b) =>
      scopeKey({ kind: "cohort", cohortDate: a.cohort_date, funnel: a.funnel, campaignPath: a.campaign_path })
        .localeCompare(scopeKey({ kind: "cohort", cohortDate: b.cohort_date, funnel: b.funnel, campaignPath: b.campaign_path })),
    );
    totalRows = rows.length;
    const pools = buildCohortPools(rows, asOfDate, trialDurationFor);
    const trends = buildPathTrends(rows, asOfDate, trialDurationFor, thresholds);
    const globalPassRate = pooledPassRate(input.passRates ?? null);
    pathCount = trends.size;
    for (const trend of trends.values()) {
      if (trend.known) trendKnownPaths += 1;
      signals.push(...trend.signals);
    }
    for (const row of rows) {
      const analysis = analyzeCohortRow(row, pools, trends, input.passRates ?? null, globalPassRate, trialDurationFor, thresholds, asOfDate);
      analyses.set(scopeKey(analysis.scope), analysis);
      if (analysis.spendInfo.usable) {
        spendUsableRows += 1;
        derivedTotalSpend += analysis.spendInfo.spend as number;
      }
      const confidence = analysisConfidence(analysis, thresholds);
      signals.push(...signalsForAnalysis(analysis, thresholds, confidence));
      recommendations.push(buildRecommendation(analysis, thresholds));
    }
    // PATH grain: one recommendation per campaign_path from the same run.
    // Deliberately NOT counted into spendUsableRows/derivedTotalSpend — path
    // groups aggregate the very rows already counted above.
    const rowsByPath = new Map<string, AiCohortRowInput[]>();
    for (const row of rows) {
      const list = rowsByPath.get(row.campaign_path) ?? [];
      list.push(row);
      rowsByPath.set(row.campaign_path, list);
    }
    const sortedPaths = [...rowsByPath.keys()].sort();
    for (const path of sortedPaths) {
      const analysis = analyzePathGroup({
        path,
        rows: rowsByPath.get(path) as AiCohortRowInput[],
        pools,
        trend: trends.get(path) ?? null,
        passRates: input.passRates ?? null,
        globalPassRate,
        thresholds,
        asOfDate,
      });
      analyses.set(scopeKey(analysis.scope), analysis);
      const confidence = analysisConfidence(analysis, thresholds);
      signals.push(...signalsForAnalysis(analysis, thresholds, confidence));
      recommendations.push(buildRecommendation(analysis, thresholds));
    }
  } else {
    const rows = [...(input.campaignRows ?? [])].sort((a, b) => a.campaign_id.localeCompare(b.campaign_id));
    totalRows = rows.length;
    const pools = buildCampaignPools(rows);
    const globalPassRate = pooledPassRate(input.passRates ?? null);
    for (const row of rows) {
      const analysis = analyzeCampaignRow(row, pools, input.campaignDailySeries, input.passRates ?? null, globalPassRate, thresholds);
      analyses.set(scopeKey(analysis.scope), analysis);
      if (analysis.spendInfo.usable) {
        spendUsableRows += 1;
        derivedTotalSpend += analysis.spendInfo.spend as number;
      }
      if (analysis.trendKnown) trendKnownPaths += 1;
      pathCount += 1;
      const confidence = analysisConfidence(analysis, thresholds);
      signals.push(...signalsForAnalysis(analysis, thresholds, confidence));
      recommendations.push(buildRecommendation(analysis, thresholds));
    }
  }

  const inputStatus: AiEngineOutput["inputStatus"] = {
    spend: spendUsableRows === 0 ? "missing" : spendUsableRows < totalRows ? "partial" : "ok",
    payment: input.passRates && Object.keys(input.passRates.byKey).length ? "ok" : "missing",
    maturity: input.surface === "campaign"
      ? "partial"
      : (input.trialDurationDaysByPath && Object.keys(input.trialDurationDaysByPath).length ? "ok" : "missing"),
    benchmark: totalRows >= MIN_BENCHMARK_PEERS + 1 ? "ok" : totalRows > 1 ? "partial" : "missing",
    // Both surfaces now have a trend axis: paths from cohort series, campaigns
    // from the daily CPA_fb series (when supplied and thick enough).
    trend: trendKnownPaths === 0 ? "missing" : trendKnownPaths < pathCount ? "partial" : "ok",
  };

  const totalSpend = typeof input.totalSpend === "number" && input.totalSpend > 0 ? input.totalSpend : derivedTotalSpend;
  const opportunities = buildOpportunities(recommendations, analyses, totalSpend, thresholds);
  const contextPack = buildContextPack(recommendations, inputStatus, asOfDate);

  return {
    engineVersion: AI_SIGNALS_ENGINE_VERSION,
    asOfDate,
    signals,
    recommendations,
    opportunities,
    inputStatus,
    contextPack,
    thresholds,
  };
}
