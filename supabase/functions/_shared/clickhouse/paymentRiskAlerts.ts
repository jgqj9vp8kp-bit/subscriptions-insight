// Payment System Health P2.5: the alert engine and the alert actions of the
// clickhouse-payment-health Edge function (plan sections P, Q, X, N; phase
// P2.5 of plan AA).
//
// How a run works (alerts_tick from pg_cron daily, or alerts_run by a person):
//   1. claim  — payment_alerts_claim_run: one run at a time per workspace and
//               at most one per ALERTS_RUN_MIN_INTERVAL_SECONDS for a person
//               (the scheduler's double fire is skipped), the run row is the
//               rate limit's memory (an Edge isolate has none worth trusting);
//   2. read   — the rules (public.payment_alert_rules, owner-editable), the
//               registry and the anchor snapshot ONCE, then the runner's own
//               actions (runPaymentHealth: overview, declines, retries,
//               refunds_support, sources) over windows of WHOLE days that end
//               the day before data_through (the newest attempt day, partial by
//               construction: ALERT_WINDOW_END_LAG_DAYS): 7 days vs the previous
//               7 for the rate rules, the last 30 days for the retry rules, the
//               newest MATURE window for refunds. No SQL of its own: every figure
//               is one the page shows for the same request, and
//               evidence.reproduce names it;
//   3. decide — evaluateAlertRules (pure): Wilson intervals through
//               comparePeriods with the rule's min_sample; a sample under
//               params.min_sample_info is not looked at; a small sample or an
//               immature window (for complaints: support data that does not
//               reach the window's end) turns a would-be alert into `info` with
//               data_confidence `low` (never warning / critical); a CLEARED
//               condition is a conclusive "no" only: enough mature data AND a
//               move under the warning threshold. A move at or above it that is
//               not significant (overlapping intervals) is inconclusive: it
//               raises nothing and leaves an open alert as it is (hysteresis);
//   4. enrich — the funnels that moved the metric most (one declines /
//               refunds_support statement per warning / critical account
//               alert, at most FUNNEL_LOOKUP_LIMIT per run): labels only;
//   5. apply  — payment_alerts_apply_run, one transaction: an alert key that
//               exists is refreshed (owner statuses kept; an auto-resolved one
//               reopens), an open alert of the same rule + scope from an
//               earlier window is carried forward (status, assignee, history
//               kept; also from a scope alias: an "Unlabelled MID" registered
//               since), one that repeats the evidence of an owner-closed alert
//               (a count alert's newest event covered, a rate alert's window
//               overlapping) is suppressed unless more severe, anything else is
//               inserted `new`; open alerts of a cleared condition become
//               resolved + auto_resolved (dismissed and owner-resolved ones are
//               never touched).
//
// Explanations come only from paymentRiskRecommendations.ts (fact → likely
// explanation → unverified hypothesis → compliant actions; the ban on
// rerouting / splitting volume across MIDs, descriptors or PSPs and on lowering
// authentication is enforced there). Alerts carry labels and opaque keys only:
// no emails, card fragments, tokens, IPs, transaction ids, raw MIDs or
// descriptors. PSP-scoped alerts are returned only to callers who may see PSP
// dimensions (payment_health.psp_global.view or the data owner), like the page.
//
// Every ClickHouse statement is the runner's (tenant bound as
// {auth_user_id:String} through the request's ScopedReader); every
// best-effort catch rethrows ScopeViolation (R7).

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ScopeViolation } from "./scopedClient.ts";
import { comparePeriods, type Fraction } from "./paymentHealthMetrics.ts";
import { loadAnchorSnapshot, loadDimensionRegistry, processorLabel, runPaymentHealth, unlabelledAccountKey, type DimensionRegistry } from "./paymentHealth.ts";
import {
  PaymentHealthRequestError,
  REFUND_MATURITY_DAYS,
  UNROUTED_PROCESSOR_KEY,
  daysInclusive,
  shiftDay,
  windowsFor,
  type BreakdownRow,
  type DeclinesResponse,
  type DimensionValue,
  type MerchantAccountRef,
  type OverviewResponse,
  type PaymentHealthFilters,
  type PaymentHealthResponse,
  type RefundsSupportResponse,
  type RetriesResponse,
  type SourcesResponse,
} from "./paymentHealthContract.ts";
import {
  AFFECTED_FUNNELS_LIMIT,
  ALL_ACCOUNTS_SCOPE_SEGMENT,
  ALERT_RULE_KEYS,
  ALERT_RULE_META,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERT_WINDOW_END_LAG_DAYS,
  ALERTS_RUN_MIN_INTERVAL_SECONDS,
  ALERTS_TICK_MIN_INTERVAL_SECONDS,
  FUNNEL_LOOKUP_LIMIT,
  OPEN_ALERT_STATUSES,
  PaymentAlertNotFoundError,
  PaymentAlertTransitionError,
  PaymentAlertsRateLimitedError,
  SEVERITY_RANK,
  alertKeyOf,
  alertScopeKey,
  isAlertRuleKey,
  isAllowedAlertTransition,
  isPspScopedAlert,
  normalizeAlertUpdateRequest,
  normalizeAlertsListRequest,
  type AlertConfidence,
  type AlertExplanation,
  type AlertHistoryEntry,
  type AlertRuleConfig,
  type AlertRuleKey,
  type AlertRuleView,
  type AlertRunCounts,
  type AlertRunRuleOutcome,
  type AlertRunSummary,
  type AlertScope,
  type AlertSeverity,
  type AlertStatus,
  type AlertUnit,
  type AlertsListResponse,
  type AlertsRunResponse,
  type AlertUpdateResponse,
  type PaymentAlertAction,
  type PaymentAlertsResponse,
  type PaymentRiskAlert,
} from "./paymentRiskAlertsContract.ts";
import { buildAlertExplanation, type RecommendationFacts } from "./paymentRiskRecommendations.ts";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const num = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};
const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const round = (value: number | null, digits: number): number | null => (value == null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);

/** 0.1234 → "12.3%"; under 10% two decimals (fraud-code and refund rates live there). */
export function formatRate(rate: number | null): string {
  if (rate == null) return "n/a";
  const pct = rate * 100;
  return `${pct.toFixed(Math.abs(pct) < 10 ? 2 : 1)}%`;
}

function formatPoints(points: number | null): string {
  if (points == null) return "n/a";
  return `${points > 0 ? "+" : ""}${points.toFixed(Math.abs(points) < 10 ? 2 : 1)}`;
}

const windowText = (from: string, to: string) => `${from} to ${to}`;
const initiationText = (initiation: "cit" | "mit") => (initiation === "cit" ? "CIT (customer-initiated)" : "MIT (merchant-initiated)");
const accountText = (processor: DimensionValue, account: MerchantAccountRef) => `${account.label} (${processor.label})`;

function todayOf(clock: () => number): string {
  return new Date(clock()).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** A payment_alert_rules row → AlertRuleConfig (numeric columns arrive as numbers or text). null for an unknown rule key. */
export function parseAlertRuleRow(row: Record<string, unknown>): AlertRuleConfig | null {
  if (!isAlertRuleKey(row.rule_key)) return null;
  const params = row.params && typeof row.params === "object" && !Array.isArray(row.params) ? (row.params as Record<string, unknown>) : {};
  return {
    rule_key: row.rule_key,
    enabled: row.enabled === true,
    severity_warning: num(row.severity_warning),
    severity_critical: num(row.severity_critical),
    min_sample: Math.max(1, Math.trunc(num(row.min_sample, 1))),
    window_days: Math.min(90, Math.max(1, Math.trunc(num(row.window_days, 7)))),
    compare: "previous_window",
    params,
    description: text(row.description),
  };
}

const RULE_COLUMNS = "rule_key,enabled,severity_warning,severity_critical,min_sample,window_days,compare,params,description";

/** The rule table (global: the workspace is a singleton; the service role reads it). */
export async function loadAlertRules(pg: SupabaseLikeClient): Promise<AlertRuleConfig[]> {
  const { data, error } = await pg.from("payment_alert_rules").select(RULE_COLUMNS).order("rule_key", { ascending: true });
  if (error) throw new Error(`Could not read payment_alert_rules: ${error.message}`);
  return ((data ?? []) as Array<Record<string, unknown>>).map(parseAlertRuleRow).filter((rule): rule is AlertRuleConfig => rule !== null);
}

function minSampleInfo(rule: AlertRuleConfig): number {
  const configured = num(rule.params.min_sample_info, NaN);
  return Number.isFinite(configured) && configured >= 1 ? Math.min(configured, rule.min_sample) : Math.min(50, rule.min_sample);
}

function maturityDays(rule: AlertRuleConfig): number {
  const configured = num(rule.params.maturity_days, NaN);
  return Number.isFinite(configured) && configured >= 0 ? Math.trunc(configured) : REFUND_MATURITY_DAYS;
}

// ---------------------------------------------------------------------------
// Windows and the reads they need
// ---------------------------------------------------------------------------

export interface RuleWindow {
  from: string;
  to: string;
  baseline_from: string;
  baseline_to: string;
  days: number;
}

export const windowKey = (window: { from: string; to: string }) => `${window.from}|${window.to}`;

/**
 * The rule's window of whole days, ending ALERT_WINDOW_END_LAG_DAYS before data_through (and the refund
 * maturity before that for refund_rate_rise), and the previous one of equal length.
 */
export function ruleWindow(rule: AlertRuleConfig, dataThrough: string): RuleWindow {
  const offset = ALERT_WINDOW_END_LAG_DAYS + (rule.rule_key === "refund_rate_rise" ? maturityDays(rule) : 0);
  const to = shiftDay(dataThrough, -offset);
  const { range, compare } = windowsFor(shiftDay(to, -(rule.window_days - 1)), to);
  return { from: range.from, to: range.to, baseline_from: compare.from, baseline_to: compare.to, days: range.days };
}

/** One runner request the evaluation needs (deduplicated by `key`). */
export interface AlertDataRequest {
  key: string;
  body: { action: "overview" | "declines" | "retries" | "sources"; date_from?: string; date_to?: string; filters?: Partial<PaymentHealthFilters>; dimension?: string };
}

const RATE_RULES_ON_OVERVIEW: ReadonlySet<AlertRuleKey> = new Set(["issuer_fraud_rise", "psp_integration_rise", "unauthorized_complaints_rise", "refund_rate_rise"]);
const RETRY_RULES: ReadonlySet<AlertRuleKey> = new Set(["post_ban_retries", "excessive_reattempts"]);

export const approvalRequestKey = (window: { from: string; to: string }, initiation: "cit" | "mit") => `declines|${windowKey(window)}|${initiation}`;
export const approvalProcessorRequestKey = (window: { from: string; to: string }, initiation: "cit" | "mit") => `declines|${windowKey(window)}|${initiation}|processor`;
export const overviewRequestKey = (window: { from: string; to: string }) => `overview|${windowKey(window)}`;
export const retriesRequestKey = (window: { from: string; to: string }) => `retries|${windowKey(window)}`;
export const SOURCES_REQUEST_KEY = "sources";

/** Every runner request the enabled rules need for this data_through (pure; tests read the plan). */
export function planAlertRequests(rules: readonly AlertRuleConfig[], dataThrough: string | null): AlertDataRequest[] {
  const out = new Map<string, AlertDataRequest>();
  const add = (request: AlertDataRequest) => {
    if (!out.has(request.key)) out.set(request.key, request);
  };
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.rule_key === "data_stale") {
      add({ key: SOURCES_REQUEST_KEY, body: { action: "sources" } });
      continue;
    }
    if (!dataThrough) continue;
    const window = ruleWindow(rule, dataThrough);
    const dates = { date_from: window.from, date_to: window.to };
    if (rule.rule_key === "approval_drop") {
      // Per account AND initiation: CIT and MIT approval differ by ~30 pp (plan F), so a renewal wave would read as a drop on a mixed rate.
      // Per PSP too (plan Q "по PSP или MID"): a PSP-wide drop can be inconclusive on each of its MIDs alone.
      for (const initiation of ["cit", "mit"] as const) {
        add({ key: approvalRequestKey(window, initiation), body: { action: "declines", ...dates, filters: { initiation: [initiation] }, dimension: "merchant_account" } });
        add({ key: approvalProcessorRequestKey(window, initiation), body: { action: "declines", ...dates, filters: { initiation: [initiation] }, dimension: "processor" } });
      }
    } else if (RATE_RULES_ON_OVERVIEW.has(rule.rule_key)) {
      add({ key: overviewRequestKey(window), body: { action: "overview", ...dates } });
      // How far the support data reaches: complaint comparisons are judged only on windows it covers.
      if (rule.rule_key === "unauthorized_complaints_rise") add({ key: SOURCES_REQUEST_KEY, body: { action: "sources" } });
    } else if (RETRY_RULES.has(rule.rule_key)) {
      add({ key: retriesRequestKey(window), body: { action: "retries", ...dates } });
    }
  }
  return [...out.values()];
}

/** The runner's answers, keyed by AlertDataRequest.key. */
export interface AlertDataSet {
  data_through: string | null;
  today: string;
  now_ms: number;
  responses: Record<string, PaymentHealthResponse | undefined>;
  /**
   * Registry id of a registered account → the "unlabelled:<hash>" key the same (processor, MID) had before
   * psp_accounts_sync registered it (opaque, never a raw MID): its alerts are matched under both keys.
   */
  account_aliases?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface AlertCandidate {
  rule_key: AlertRuleKey;
  alert_key: string;
  scope_key: string;
  severity: AlertSeverity;
  scope: AlertScope;
  affected_funnels: string[];
  metric: string;
  unit: AlertUnit;
  current_value: number | null;
  baseline_value: number | null;
  change_value: number | null;
  sample_size: number;
  data_confidence: AlertConfidence;
  window_start: string | null;
  window_end: string;
  evidence: Record<string, unknown>;
  explanation: AlertExplanation;
  /**
   * The newest event day behind a count rule (post-ban attempts, rolling windows): an owner-closed alert whose
   * window_end reaches it suppresses this one. null for the rate rules: there the SQL compares the windows
   * (an owner-closed alert whose window overlaps this one's suppresses it), and never from a cut list.
   */
  newest_event_day: string | null;
  /** Former keys of this scope (an Unlabelled MID registered since): read by payment_alerts_apply_run for matching, never stored. */
  scope_aliases: string[];
}

export interface ClearedCondition {
  rule_key: AlertRuleKey;
  scope_key: string;
}

export interface AlertEvaluation {
  data_through: string | null;
  windows: Record<string, { from: string; to: string }>;
  candidates: AlertCandidate[];
  cleared: ClearedCondition[];
  rules: AlertRunRuleOutcome[];
}

type ScopeOutcome = { kind: "candidate"; candidate: AlertCandidate } | { kind: "cleared"; ref: ClearedCondition } | { kind: "inconclusive" };

interface RuleTally {
  candidates: AlertCandidate[];
  cleared: ClearedCondition[];
  inconclusive: number;
}

const emptyTally = (): RuleTally => ({ candidates: [], cleared: [], inconclusive: 0 });

function record(tally: RuleTally, outcome: ScopeOutcome): void {
  if (outcome.kind === "candidate") tally.candidates.push(outcome.candidate);
  else if (outcome.kind === "cleared") tally.cleared.push(outcome.ref);
  else tally.inconclusive += 1;
}

interface RateSpec {
  rule: AlertRuleConfig;
  window: RuleWindow;
  dataThrough: string;
  direction: "drop" | "rise";
  current: Fraction;
  baseline: Fraction;
  /** The window has not matured (import not covering it; for refunds: data_through not maturity_days past it; for complaints: support data not reaching its end). */
  immature: boolean;
  /** Why it is immature, for the low-confidence text (default: "the window is still maturing"). */
  immatureReason?: string;
  scope: AlertScope;
  facts: RecommendationFacts;
  variant?: string;
  reproduce: Record<string, unknown>;
  extraEvidence?: Record<string, unknown>;
}

/**
 * Plan P / Q for a rate rule. Inconclusive (neither raised nor resolved): a
 * side without data, or fewer than min_sample_info observations in a window.
 * CLEARED only on a conclusive "no": both windows ≥ min_sample, mature, and a
 * move under the warning threshold. A significant move ≥ warning → warning /
 * critical. A move ≥ warning whose intervals overlap (not significant) is
 * inconclusive, not clear: the two-interval test is conservative, so "not
 * proven" must not resolve an open alert while the move is still there — the
 * band between "significant" and "under warning" is the hysteresis. A move ≥
 * warning on a small sample or an immature window → info with data_confidence
 * low (and a small move there is inconclusive, not clear).
 */
export function evaluateRate(spec: RateSpec): ScopeOutcome {
  const { rule, window } = spec;
  const scopeKey = alertScopeKey(spec.scope);
  const comparison = comparePeriods(spec.current, spec.baseline, { minSample: rule.min_sample, immature: spec.immature });
  const sample = Math.min(comparison.current.sample_size, comparison.baseline.sample_size);
  if (comparison.delta_points == null || sample < minSampleInfo(rule)) return { kind: "inconclusive" };
  const move = spec.direction === "drop" ? -comparison.delta_points : comparison.delta_points;
  const confident = !comparison.immature_period && !comparison.current.small_sample && !comparison.baseline.small_sample;
  if (move < rule.severity_warning) return confident ? { kind: "cleared", ref: { rule_key: rule.rule_key, scope_key: scopeKey } } : { kind: "inconclusive" };
  if (confident && !comparison.significant) return { kind: "inconclusive" };
  const severity: AlertSeverity = !confident ? "info" : move >= rule.severity_critical ? "critical" : "warning";
  const confidence: AlertConfidence = confident ? "high" : "low";
  const lowReason = comparison.immature_period
    ? spec.immatureReason ?? "the window is still maturing"
    : `fewer than ${rule.min_sample} observations in a window`;
  const significance = confident
    ? "The change is outside both 95% Wilson intervals."
    : `Low confidence: ${lowReason}, so this is not a significant change yet.`;
  const meta = ALERT_RULE_META[rule.rule_key];
  const facts: RecommendationFacts = {
    window: windowText(window.from, window.to),
    baseline_window: windowText(window.baseline_from, window.baseline_to),
    current: formatRate(comparison.current.rate),
    baseline: formatRate(comparison.baseline.rate),
    change: formatPoints(comparison.delta_points),
    count: comparison.current.numerator,
    attempts: comparison.current.denominator,
    settled: comparison.current.denominator,
    significance,
    ...spec.facts,
  };
  const candidate: AlertCandidate = {
    rule_key: rule.rule_key,
    alert_key: alertKeyOf(rule.rule_key, scopeKey, window.to),
    scope_key: scopeKey,
    severity,
    scope: spec.scope,
    affected_funnels: [],
    metric: meta.metric,
    unit: "rate",
    current_value: round(comparison.current.rate, 6),
    baseline_value: round(comparison.baseline.rate, 6),
    change_value: round(comparison.delta_points, 4),
    sample_size: sample,
    data_confidence: confidence,
    window_start: window.from,
    window_end: window.to,
    evidence: {
      unit: "rate",
      direction: spec.direction,
      current: { from: window.from, to: window.to, numerator: comparison.current.numerator, denominator: comparison.current.denominator, rate: comparison.current.rate, interval: comparison.current.interval },
      baseline: { from: window.baseline_from, to: window.baseline_to, numerator: comparison.baseline.numerator, denominator: comparison.baseline.denominator, rate: comparison.baseline.rate, interval: comparison.baseline.interval },
      delta_points: comparison.delta_points,
      significant: comparison.significant,
      significance_reason: comparison.significance_reason,
      small_sample: { current: comparison.current.small_sample, baseline: comparison.baseline.small_sample },
      immature_window: comparison.immature_period,
      min_sample: rule.min_sample,
      min_sample_info: minSampleInfo(rule),
      thresholds: { warning: rule.severity_warning, critical: rule.severity_critical, unit: "pp" },
      data_through: spec.dataThrough,
      reproduce: spec.reproduce,
      ...(spec.extraEvidence ?? {}),
    },
    explanation: buildAlertExplanation(rule.rule_key, facts, spec.variant),
    newest_event_day: null,
    scope_aliases: [],
  };
  return { kind: "candidate", candidate };
}

interface CountSpec {
  rule: AlertRuleConfig;
  scope: AlertScope;
  windowStart: string | null;
  windowEnd: string;
  count: number | null;
  /** The reading is a lower bound or partial (a row cap was hit): never warning / critical, never cleared. */
  incomplete: boolean;
  sample: number;
  unit: AlertUnit;
  metric?: string;
  facts: RecommendationFacts;
  variant?: string;
  evidence: Record<string, unknown>;
  newestEventDay: string | null;
}

/** A count rule (retries, freshness): count ≥ critical → critical, ≥ warning → warning; under it → cleared (unless incomplete). */
export function evaluateCount(spec: CountSpec): ScopeOutcome {
  const { rule } = spec;
  const scopeKey = alertScopeKey(spec.scope);
  if (spec.count == null) return { kind: "inconclusive" };
  if (spec.count < rule.severity_warning) return spec.incomplete ? { kind: "inconclusive" } : { kind: "cleared", ref: { rule_key: rule.rule_key, scope_key: scopeKey } };
  const severity: AlertSeverity = spec.incomplete ? "info" : spec.count >= rule.severity_critical ? "critical" : "warning";
  const candidate: AlertCandidate = {
    rule_key: rule.rule_key,
    alert_key: alertKeyOf(rule.rule_key, scopeKey, spec.windowEnd),
    scope_key: scopeKey,
    severity,
    scope: spec.scope,
    affected_funnels: [],
    metric: spec.metric ?? ALERT_RULE_META[rule.rule_key].metric,
    unit: spec.unit,
    current_value: spec.count,
    baseline_value: null,
    change_value: null,
    sample_size: Math.max(0, Math.trunc(spec.sample)),
    data_confidence: spec.incomplete ? "low" : "high",
    window_start: spec.windowStart,
    window_end: spec.windowEnd,
    evidence: {
      unit: spec.unit,
      count: spec.count,
      incomplete: spec.incomplete,
      thresholds: { warning: rule.severity_warning, critical: rule.severity_critical, unit: spec.unit },
      ...spec.evidence,
    },
    explanation: buildAlertExplanation(rule.rule_key, spec.facts, spec.variant),
    newest_event_day: spec.newestEventDay,
    scope_aliases: [],
  };
  return { kind: "candidate", candidate };
}

// ---- per-rule evaluation ----------------------------------------------------------------

function isRouted(processorKey: string): boolean {
  return Boolean(processorKey) && processorKey !== UNROUTED_PROCESSOR_KEY;
}

function accountOfBreakdown(row: BreakdownRow): MerchantAccountRef | null {
  const value = row.value as Partial<MerchantAccountRef>;
  if (typeof value?.processor !== "string" || typeof value.key !== "string") return null;
  return { key: value.key, label: text(value.label), processor: value.processor, labelled: value.labelled === true };
}

const fraction = (numerator: number, denominator: number): Fraction => ({ numerator: num(numerator), denominator: num(denominator) });

function evaluateApprovalDrop(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  let seen = 0;
  for (const initiation of ["cit", "mit"] as const) {
    const response = data.responses[approvalRequestKey(window, initiation)] as DeclinesResponse | undefined;
    if (!response || response.action !== "declines") continue;
    seen += 1;
    // Routed accounts per processor in either window: the PSP-wide line is read only where it is not one account's line again.
    const accountsByProcessor = new Map<string, number>();
    for (const row of response.by_dimension) {
      const account = accountOfBreakdown(row);
      if (!account || !isRouted(account.processor)) continue;
      accountsByProcessor.set(account.processor, (accountsByProcessor.get(account.processor) ?? 0) + 1);
      const processor = { key: account.processor, label: processorLabel(account.processor) };
      record(tally, evaluateRate({
        rule,
        window,
        dataThrough,
        direction: "drop",
        current: fraction(row.current.successes, row.current.attempts),
        baseline: fraction(row.baseline.successes, row.baseline.attempts),
        immature: window.to > dataThrough,
        scope: { kind: "account", processor, merchant_account: account, initiation },
        facts: { account: accountText(processor, account), initiation: initiationText(initiation) },
        reproduce: { action: "declines", date_from: window.from, date_to: window.to, filters: { initiation: [initiation] }, dimension: "merchant_account", read: `by_dimension[value.key=${account.key}].approval` },
      }));
    }
    // Plan Q "по PSP или MID": every MID of one PSP together, so a PSP-wide drop is caught when each MID's own
    // sample is too small to be conclusive. A PSP with a single MID is that MID's line already: not repeated.
    const byProcessor = data.responses[approvalProcessorRequestKey(window, initiation)] as DeclinesResponse | undefined;
    if (!byProcessor || byProcessor.action !== "declines") continue;
    for (const row of byProcessor.by_dimension) {
      const key = text(row.value?.key);
      if (!isRouted(key) || (accountsByProcessor.get(key) ?? 0) < 2) continue;
      const processor = { key, label: text(row.value.label) || processorLabel(key) };
      record(tally, evaluateRate({
        rule,
        window,
        dataThrough,
        direction: "drop",
        current: fraction(row.current.successes, row.current.attempts),
        baseline: fraction(row.baseline.successes, row.baseline.attempts),
        immature: window.to > dataThrough,
        scope: { kind: "account", processor, initiation },
        facts: { account: `all ${processor.label} merchant accounts`, initiation: initiationText(initiation) },
        variant: "processor",
        reproduce: { action: "declines", date_from: window.from, date_to: window.to, filters: { initiation: [initiation] }, dimension: "processor", read: `by_dimension[value.key=${key}].approval` },
        extraEvidence: { merchant_accounts: accountsByProcessor.get(key) },
      }));
    }
  }
  return seen ? null : "no approval data for the window";
}

function overviewRows(response: OverviewResponse) {
  return response.psp_mid_rows.filter((row) => isRouted(row.processor.key));
}

function evaluateIssuerFraud(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  const response = data.responses[overviewRequestKey(window)] as OverviewResponse | undefined;
  if (!response || response.action !== "overview") return "no overview for the window";
  for (const row of overviewRows(response)) {
    record(tally, evaluateRate({
      rule,
      window,
      dataThrough,
      direction: "rise",
      current: fraction(row.current.issuer_fraud_declines, row.current.attempts),
      baseline: fraction(row.baseline.issuer_fraud_declines, row.baseline.attempts),
      immature: window.to > dataThrough,
      scope: { kind: "account", processor: row.processor, merchant_account: row.merchant_account },
      facts: { account: accountText(row.processor, row.merchant_account) },
      reproduce: { action: "overview", date_from: window.from, date_to: window.to, filters: {}, read: `psp_mid_rows[merchant_account.key=${row.merchant_account.key}].issuer_fraud_share` },
    }));
  }
  return null;
}

function evaluatePspIntegration(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  const response = data.responses[overviewRequestKey(window)] as OverviewResponse | undefined;
  if (!response || response.action !== "overview") return "no overview for the window";
  for (const row of overviewRows(response)) {
    record(tally, evaluateRate({
      rule,
      window,
      dataThrough,
      direction: "rise",
      current: fraction(row.current.psp_integration_declines, row.current.attempts),
      baseline: fraction(row.baseline.psp_integration_declines, row.baseline.attempts),
      immature: window.to > dataThrough,
      scope: { kind: "account", processor: row.processor, merchant_account: row.merchant_account },
      facts: { account: accountText(row.processor, row.merchant_account) },
      reproduce: { action: "overview", date_from: window.from, date_to: window.to, filters: {}, read: `psp_mid_rows[merchant_account.key=${row.merchant_account.key}].current.psp_integration_declines / current.attempts` },
    }));
  }
  // The tenant line: integration errors plus the declines that never reached a processor, over all attempts (no PSP named).
  const totals = response.totals;
  record(tally, evaluateRate({
    rule,
    window,
    dataThrough,
    direction: "rise",
    current: fraction(totals.current.psp_integration_declines + totals.current.cause_unverified_declines, totals.current.attempts),
    baseline: fraction(totals.baseline.psp_integration_declines + totals.baseline.cause_unverified_declines, totals.baseline.attempts),
    immature: window.to > dataThrough,
    scope: { kind: "tenant", subject: "unrouted_and_integration" },
    facts: {},
    variant: "tenant",
    reproduce: { action: "overview", date_from: window.from, date_to: window.to, filters: {}, read: "totals.current.psp_integration_declines + totals.current.cause_unverified_declines / totals.current.attempts" },
    extraEvidence: {
      parts: {
        current: { psp_integration: totals.current.psp_integration_declines, cause_unverified: totals.current.cause_unverified_declines },
        baseline: { psp_integration: totals.baseline.psp_integration_declines, cause_unverified: totals.baseline.cause_unverified_declines },
      },
    },
  }));
  return null;
}

/** The newest received day of the support data (sources: max request_date), or null when it is unknown or there is none. */
function supportThroughOf(data: AlertDataSet): string | null {
  const sources = data.responses[SOURCES_REQUEST_KEY] as SourcesResponse | undefined;
  if (!sources || sources.action !== "sources") return null;
  return dayOfIso(sources.support?.last_day ?? null);
}

function evaluateComplaints(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  const response = data.responses[overviewRequestKey(window)] as OverviewResponse | undefined;
  if (!response || response.action !== "overview") return "no overview for the window";
  // The numerator comes from fact_support_requests, which has its own pipeline (mail import, classification,
  // sync): data_through says nothing about it. A window the support data does not reach would read as a
  // complete "no rise" (absence of data is not zero risk), so it is immature: info / low at most, never cleared.
  const supportThrough = supportThroughOf(data);
  const supportShort = supportThrough == null || supportThrough < window.to;
  for (const row of overviewRows(response)) {
    const rate = row.complaint_rate;
    record(tally, evaluateRate({
      rule,
      window,
      dataThrough,
      direction: "rise",
      current: fraction(rate.current.numerator, rate.current.denominator),
      baseline: fraction(rate.baseline.numerator, rate.baseline.denominator),
      // By RECEIVED date: complaints received in the window over the window's settled payments are both complete
      // once the payments AND the support data cover the window (the page's 30-day maturity flag on this
      // comparison is display caution; the alert reads it on the received-date basis instead).
      immature: window.to > dataThrough || supportShort,
      immatureReason: supportThrough == null ? "there is no support data in the warehouse" : `the support data reaches only ${supportThrough}`,
      scope: { kind: "account", processor: row.processor, merchant_account: row.merchant_account },
      facts: { account: accountText(row.processor, row.merchant_account) },
      reproduce: { action: "overview", date_from: window.from, date_to: window.to, filters: {}, read: `psp_mid_rows[merchant_account.key=${row.merchant_account.key}].complaint_rate` },
      extraEvidence: { maturity_basis: "received_at", support_through: supportThrough, support_complete: !supportShort },
    }));
  }
  return null;
}

function evaluateRefunds(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  const response = data.responses[overviewRequestKey(window)] as OverviewResponse | undefined;
  if (!response || response.action !== "overview") return "no overview for the window";
  const maturity = maturityDays(rule);
  for (const row of overviewRows(response)) {
    record(tally, evaluateRate({
      rule,
      window,
      dataThrough,
      direction: "rise",
      current: fraction(row.current.refunded, row.current.successes),
      baseline: fraction(row.baseline.refunded, row.baseline.successes),
      // Only mature windows: a payment can be refunded for weeks, so a window is read maturity_days after it ends.
      immature: shiftDay(window.to, maturity) > dataThrough,
      scope: { kind: "account", processor: row.processor, merchant_account: row.merchant_account },
      facts: { account: accountText(row.processor, row.merchant_account), maturity_days: maturity },
      reproduce: { action: "overview", date_from: window.from, date_to: window.to, filters: {}, read: `psp_mid_rows[merchant_account.key=${row.merchant_account.key}].refund_rate` },
      extraEvidence: { maturity_days: maturity, maturity_basis: "original_payment" },
    }));
  }
  return null;
}

interface AccountCount {
  processor: DimensionValue | null;
  merchant_account: { key: string; label: string } | null;
  count: number;
}

function byAccount<T>(rows: readonly T[], pick: (row: T) => { processor: DimensionValue | null; merchant_account: MerchantAccountRef | null }): AccountCount[] {
  const out = new Map<string, AccountCount>();
  for (const row of rows) {
    const { processor, merchant_account } = pick(row);
    const key = merchant_account?.key ?? "unknown";
    const entry = out.get(key) ?? { processor, merchant_account: merchant_account ? { key: merchant_account.key, label: merchant_account.label } : null, count: 0 };
    entry.count += 1;
    out.set(key, entry);
  }
  return [...out.values()].sort((a, b) => b.count - a.count || (a.merchant_account?.label ?? "").localeCompare(b.merchant_account?.label ?? ""));
}

const dayOfIso = (iso: string | null | undefined): string | null => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null);

function newestDay(days: Array<string | null>): string | null {
  return days.filter((day): day is string => Boolean(day)).sort().at(-1) ?? null;
}

function evaluatePostBan(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  const response = data.responses[retriesRequestKey(window)] as RetriesResponse | undefined;
  if (!response || response.action !== "retries") return "no retries report for the window";
  const capped = response.meta.limited.attempt_rows === true;
  const listComplete = response.meta.limited.post_ban_attempts !== true;
  for (const initiation of ["cit", "mit"] as const) {
    const rows = response.post_ban_attempts.filter((row) => row.initiation_type === initiation);
    const count = num(response.post_ban[initiation]);
    // The fact pairs the full count with full sub-counts: post_ban_attempts is only the newest rows of BOTH initiations.
    const split = response.post_ban.by_initiation?.[initiation];
    const subCount = (full: number | undefined, listed: number) => (full != null ? num(full) : listComplete ? listed : "n/a (list capped)");
    record(tally, evaluateCount({
      rule,
      scope: { kind: "tenant", subject: "post_ban", initiation },
      windowStart: window.from,
      windowEnd: window.to,
      count,
      incomplete: capped,
      sample: response.chains.attempts,
      unit: "count",
      variant: initiation,
      facts: {
        count,
        initiation: initiationText(initiation),
        window: windowText(window.from, window.to),
        succeeded: subCount(split?.succeeded, rows.filter((row) => row.succeeded).length),
        after_processor_change: subCount(split?.switched_processor, rows.filter((row) => row.processor_relation === "switched").length),
      },
      newestEventDay: newestDay(rows.map((row) => dayOfIso(row.event_time))),
      evidence: {
        window: { from: window.from, to: window.to },
        initiation,
        banned_instruments: response.post_ban.banned_instruments,
        retried_instruments: response.post_ban.retried_instruments,
        succeeded: split ? num(split.succeeded) : null,
        after_processor_change: split ? num(split.switched_processor) : null,
        listed: rows.length,
        listed_succeeded: rows.filter((row) => row.succeeded).length,
        listed_after_processor_change: rows.filter((row) => row.processor_relation === "switched").length,
        listed_within_one_hour: rows.filter((row) => row.minutes_since_ban <= 60).length,
        list_complete: listComplete,
        attempt_rows_capped: capped,
        // PSP account labels: stripped from the response for a caller without payment_health.psp_global.view.
        by_account: byAccount(rows, (row) => ({ processor: row.processor, merchant_account: row.merchant_account })),
        data_through: dataThrough,
        reproduce: { action: "retries", date_from: window.from, date_to: window.to, filters: {}, read: `post_ban.${initiation}` },
      },
    }));
  }
  return null;
}

function evaluateExcessiveReattempts(rule: AlertRuleConfig, data: AlertDataSet, dataThrough: string, tally: RuleTally): string | null {
  const window = ruleWindow(rule, dataThrough);
  const response = data.responses[retriesRequestKey(window)] as RetriesResponse | undefined;
  if (!response || response.action !== "retries") return "no retries report for the window";
  const capped = response.meta.limited.attempt_rows === true;
  const windows = response.rolling.windows;
  const listCut = response.meta.limited.rolling_windows === true;
  const count = num(response.rolling.violations);
  const maxDeclines = windows.reduce((max, entry) => Math.max(max, num(entry.max_declines)), 0);
  // The suppression day must be the newest violation of ALL pairs: the list is cut at ROLLING_WINDOW_LIMIT in
  // max_declines order, so a new pair just over the limit can be missing from it. Without the full figure, a
  // cut list gives no day at all (nothing is suppressed on a partial view).
  const newestEventDay = dayOfIso(response.rolling.newest_violation_end)
    ?? (listCut ? null : newestDay(windows.map((entry) => dayOfIso(entry.window_end))));
  record(tally, evaluateCount({
    rule,
    scope: { kind: "tenant", subject: "rolling" },
    windowStart: window.from,
    windowEnd: window.to,
    count,
    incomplete: capped,
    sample: response.rolling.pairs,
    unit: "count",
    facts: {
      count,
      limit: response.meta.chain_options.rolling_decline_limit,
      rolling_days: response.meta.chain_options.rolling_window_days,
      max_declines: maxDeclines,
      window: windowText(window.from, window.to),
    },
    newestEventDay,
    evidence: {
      window: { from: window.from, to: window.to },
      pairs: response.rolling.pairs,
      violations: count,
      limit: response.meta.chain_options.rolling_decline_limit,
      rolling_window_days: response.meta.chain_options.rolling_window_days,
      max_declines: maxDeclines,
      newest_violation_day: newestEventDay,
      list_complete: !listCut,
      attempt_rows_capped: capped,
      by_account: byAccount(windows, (entry) => ({ processor: entry.merchant_account ? { key: entry.merchant_account.processor, label: processorLabel(entry.merchant_account.processor) } : null, merchant_account: entry.merchant_account })),
      data_through: dataThrough,
      reproduce: { action: "retries", date_from: window.from, date_to: window.to, filters: {}, read: "rolling.violations" },
    },
  }));
  return null;
}

function evaluateDataStale(rule: AlertRuleConfig, data: AlertDataSet, tally: RuleTally): string | null {
  const sources = data.responses[SOURCES_REQUEST_KEY] as SourcesResponse | undefined;
  const dataThrough = data.data_through;
  const lag = dataThrough ? Math.max(0, daysInclusive(dataThrough, data.today) - 1) : null;
  // With no attempt in the warehouse at all the lag is unbounded: critical (not "unknown"), with no value to show.
  const freshness = evaluateCount({
    rule,
    scope: { kind: "tenant", subject: "data_through" },
    windowStart: null,
    windowEnd: dataThrough ?? data.today,
    count: lag ?? rule.severity_critical,
    incomplete: false,
    sample: sources?.warehouse.attempt_rows ?? 0,
    unit: "days",
    metric: "data_lag_days",
    facts: { data_through: dataThrough ?? "never (no payment rows)", lag_days: lag ?? "n/a" },
    newestEventDay: null,
    evidence: {
      data_through: dataThrough,
      today: data.today,
      lag_days: lag,
      last_import_at: sources?.last_import?.imported_at ?? null,
      reproduce: { action: "sources", read: "meta.data_through, meta.lag_days" },
    },
  });
  if (lag == null && freshness.kind === "candidate") freshness.candidate.current_value = null;
  record(tally, freshness);
  if (!sources || sources.action !== "sources") return "no sources report";
  const warningHours = num(rule.params.sync_warning_hours, 72);
  const criticalHours = Math.max(warningHours, num(rule.params.sync_critical_hours, 168));
  const syncRule: AlertRuleConfig = { ...rule, severity_warning: warningHours, severity_critical: criticalHours };
  // One line per pipeline: the payment rows' ClickHouse sync, and the support requests' (complaints have
  // their own import + sync; a stalled one would otherwise only show as complaint alerts that never clear).
  const syncLine = (lastSynced: string | null, stream: "payments" | "support", sample: number) => {
    const syncedMs = lastSynced ? Date.parse(lastSynced) : NaN;
    if (!lastSynced || !Number.isFinite(syncedMs)) {
      // No sync time: nothing to judge (a workspace without support data has no support sync at all).
      tally.inconclusive += 1;
      return;
    }
    const hours = Math.max(0, (data.now_ms - syncedMs) / 3_600_000);
    const support = stream === "support";
    record(tally, evaluateCount({
      rule: syncRule,
      scope: { kind: "tenant", subject: support ? "support_sync" : "warehouse_sync" },
      windowStart: null,
      windowEnd: lastSynced.slice(0, 10),
      count: Math.floor(hours * 10) / 10,
      incomplete: false,
      sample,
      unit: "hours",
      metric: "sync_age_hours",
      variant: support ? "support_sync" : "warehouse_sync",
      facts: { sync_hours: Math.floor(hours), last_synced_at: lastSynced },
      newestEventDay: null,
      evidence: {
        stream,
        last_synced_at: lastSynced,
        age_hours: Math.round(hours * 10) / 10,
        ...(support ? { support_through: dayOfIso(sources.support?.last_day ?? null) } : {}),
        reproduce: { action: "sources", read: support ? "support.last_synced_at" : "warehouse.last_synced_at" },
      },
    }));
  };
  syncLine(sources.warehouse.last_synced_at, "payments", sources.warehouse.attempt_rows);
  syncLine(sources.support?.last_synced_at ?? null, "support", (sources.support?.by_month ?? []).reduce((sum, month) => sum + num(month.requests), 0));
  return null;
}

/**
 * The scope key with a registered account's former "unlabelled:<hash>" key in place of its registry id
 * (account:<proc>:<id>[:<initiation>] → account:<proc>:unlabelled:<hash>[:<initiation>]); null when the key
 * names no registered account with a former key. psp_accounts_sync changes an account's key from the hash
 * to the id, so without this an alert raised before the registration would never be carried or resolved.
 */
export function aliasScopeKey(scopeKey: string, aliases: Readonly<Record<string, string>> | undefined): string | null {
  if (!aliases) return null;
  const parts = scopeKey.split(":");
  if (parts[0] !== "account" || parts.length < 3 || parts[2] === ALL_ACCOUNTS_SCOPE_SEGMENT) return null;
  const alias = Object.prototype.hasOwnProperty.call(aliases, parts[2]) ? aliases[parts[2]] : null;
  return alias ? [parts[0], parts[1], alias, ...parts.slice(3)].join(":") : null;
}

/**
 * Evaluates every rule against the runner's answers (pure). A disabled rule is
 * reported, not evaluated; a rule whose data is missing is skipped (its open
 * alerts stay open: nothing proved them clear).
 */
export function evaluateAlertRules(rules: readonly AlertRuleConfig[], data: AlertDataSet): AlertEvaluation {
  const evaluation: AlertEvaluation = { data_through: data.data_through, windows: {}, candidates: [], cleared: [], rules: [] };
  const configured = new Map(rules.map((rule) => [rule.rule_key, rule]));
  for (const ruleKey of ALERT_RULE_KEYS) {
    const rule = configured.get(ruleKey);
    if (!rule) {
      evaluation.rules.push({ rule_key: ruleKey, status: "skipped", reason: "not configured in payment_alert_rules", candidates: 0, cleared: 0, inconclusive: 0 });
      continue;
    }
    if (!rule.enabled) {
      evaluation.rules.push({ rule_key: ruleKey, status: "disabled", reason: null, candidates: 0, cleared: 0, inconclusive: 0 });
      continue;
    }
    const tally = emptyTally();
    let skipped: string | null = null;
    if (ruleKey === "data_stale") {
      skipped = evaluateDataStale(rule, data, tally);
    } else if (!data.data_through) {
      skipped = "no attempt data in the warehouse";
    } else {
      const window = ruleWindow(rule, data.data_through);
      evaluation.windows[ruleKey] = { from: window.from, to: window.to };
      switch (ruleKey) {
        case "approval_drop":
          skipped = evaluateApprovalDrop(rule, data, data.data_through, tally);
          break;
        case "issuer_fraud_rise":
          skipped = evaluateIssuerFraud(rule, data, data.data_through, tally);
          break;
        case "psp_integration_rise":
          skipped = evaluatePspIntegration(rule, data, data.data_through, tally);
          break;
        case "post_ban_retries":
          skipped = evaluatePostBan(rule, data, data.data_through, tally);
          break;
        case "excessive_reattempts":
          skipped = evaluateExcessiveReattempts(rule, data, data.data_through, tally);
          break;
        case "unauthorized_complaints_rise":
          skipped = evaluateComplaints(rule, data, data.data_through, tally);
          break;
        case "refund_rate_rise":
          skipped = evaluateRefunds(rule, data, data.data_through, tally);
          break;
      }
    }
    // A rule that produced nothing because its data was missing is "skipped"; data_stale's
    // first line is always evaluated, so a missing sources report only skips the sync line.
    const evaluatedSomething = tally.candidates.length + tally.cleared.length + tally.inconclusive > 0;
    evaluation.rules.push({
      rule_key: ruleKey,
      status: skipped && !evaluatedSomething ? "skipped" : "evaluated",
      reason: skipped,
      candidates: tally.candidates.length,
      cleared: tally.cleared.length,
      inconclusive: tally.inconclusive,
    });
    // A registered account's alerts may still carry its former unlabelled key: the candidate names it for the
    // carry-forward / suppression match, and a cleared condition resolves the open alerts under both keys.
    for (const candidate of tally.candidates) {
      const alias = aliasScopeKey(candidate.scope_key, data.account_aliases);
      if (alias) candidate.scope_aliases = [alias];
    }
    const aliasCleared = tally.cleared
      .map((ref) => ({ rule_key: ref.rule_key, scope_key: aliasScopeKey(ref.scope_key, data.account_aliases) }))
      .filter((ref): ref is ClearedCondition => ref.scope_key !== null);
    evaluation.candidates.push(...tally.candidates);
    evaluation.cleared.push(...tally.cleared, ...aliasCleared);
  }
  return evaluation;
}

// ---------------------------------------------------------------------------
// Affected funnels
// ---------------------------------------------------------------------------

const FUNNEL_RULES: ReadonlySet<AlertRuleKey> = new Set(["approval_drop", "issuer_fraud_rise", "psp_integration_rise", "refund_rate_rise"]);

/** The runner request that splits a warning / critical account alert by funnel (null when the rule has no funnel split). */
export function funnelLookupRequest(candidate: AlertCandidate): AlertDataRequest | null {
  if (!FUNNEL_RULES.has(candidate.rule_key) || candidate.scope.kind !== "account" || candidate.severity === "info" || !candidate.window_start) return null;
  // One account, or (approval_drop's PSP-wide line) every account of the processor.
  const filters: Partial<PaymentHealthFilters> | null = candidate.scope.merchant_account
    ? { merchant_account: [candidate.scope.merchant_account.key] }
    : candidate.scope.processor
      ? { processor: [candidate.scope.processor.key] }
      : null;
  if (!filters) return null;
  if (candidate.scope.initiation) filters.initiation = [candidate.scope.initiation];
  const action = candidate.rule_key === "refund_rate_rise" ? "refunds_support" : "declines";
  return {
    key: `funnels|${candidate.alert_key}`,
    body: { action: action as AlertDataRequest["body"]["action"], date_from: candidate.window_start, date_to: candidate.window_end, filters, dimension: "funnel" },
  };
}

function metricOfRow(ruleKey: AlertRuleKey, row: BreakdownRow, period: "current" | "baseline"): Fraction {
  const totals = row[period];
  switch (ruleKey) {
    case "approval_drop":
      return fraction(totals.successes, totals.attempts);
    case "issuer_fraud_rise":
      return fraction(totals.issuer_fraud_declines, totals.attempts);
    case "psp_integration_rise":
      return fraction(totals.psp_integration_declines, totals.attempts);
    case "refund_rate_rise":
      return fraction(totals.refunded, totals.successes);
    default:
      return fraction(0, 0);
  }
}

/**
 * The funnel labels that moved the metric most in the alert's direction:
 * Δrate × the funnel's current volume (a funnel new in the window counts its
 * whole rate for a rise), positive contributions only, AFFECTED_FUNNELS_LIMIT
 * at most. Labels only (the anchor campaign path, or "Unattributed ...").
 */
export function affectedFunnels(candidate: AlertCandidate, rows: readonly BreakdownRow[]): string[] {
  const drop = candidate.rule_key === "approval_drop";
  return rows
    .map((row) => {
      const current = metricOfRow(candidate.rule_key, row, "current");
      const baseline = metricOfRow(candidate.rule_key, row, "baseline");
      if (!(current.denominator > 0)) return null;
      const currentRate = current.numerator / current.denominator;
      const baselineRate = baseline.denominator > 0 ? baseline.numerator / baseline.denominator : drop ? null : 0;
      if (baselineRate == null) return null;
      const contribution = (drop ? baselineRate - currentRate : currentRate - baselineRate) * current.denominator;
      return contribution > 0 ? { label: text(row.value.label) || text(row.value.key), contribution } : null;
    })
    .filter((entry): entry is { label: string; contribution: number } => entry !== null)
    .sort((a, b) => b.contribution - a.contribution || a.label.localeCompare(b.label))
    .slice(0, AFFECTED_FUNNELS_LIMIT)
    .map((entry) => entry.label);
}

function breakdownOf(response: PaymentHealthResponse | undefined): BreakdownRow[] {
  if (!response) return [];
  if (response.action === "declines") return (response as DeclinesResponse).by_dimension;
  if (response.action === "refunds_support") return (response as RefundsSupportResponse).refunds.by_dimension;
  return [];
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface PaymentRiskAlertsRunInput {
  tenantKey: string;
  clickhouse: () => ClickHouseClientLike;
  pg: SupabaseLikeClient;
  trigger: "cron" | "manual";
  /** The member who asked (manual); null for the scheduler. */
  actorUserId: string | null;
  clock?: () => number;
}

interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

async function callRpc(pg: SupabaseLikeClient, fn: string, params: Record<string, unknown>): Promise<RpcResult> {
  if (typeof pg.rpc !== "function") throw new Error(`The Postgres client cannot call ${fn}.`);
  const result = await pg.rpc(fn, params);
  return { data: result?.data ?? null, error: result?.error ?? null };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch (error) {
      if (error instanceof ScopeViolation) throw error;
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The table row the apply function writes for a candidate (newest_event_day and scope_aliases are read by the function, not stored as columns). */
function candidateRow(candidate: AlertCandidate): Record<string, unknown> {
  return { ...candidate };
}

function severityCounts(candidates: readonly AlertCandidate[]): Record<AlertSeverity, number> {
  const out = Object.fromEntries(ALERT_SEVERITIES.map((severity) => [severity, 0])) as Record<AlertSeverity, number>;
  for (const candidate of candidates) out[candidate.severity] += 1;
  return out;
}

/** Registry id → the "unlabelled:<hash>" key the account had before psp_accounts_sync registered it (opaque keys only). */
export async function registeredAccountAliases(tenantKey: string, registry: DimensionRegistry): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const ref of registry.accounts.values()) {
    if (!ref.labelled) continue;
    const pair = registry.accountsByKey.get(ref.key);
    if (!pair?.mid) continue;
    out[ref.key] = await unlabelledAccountKey(tenantKey, pair.processor, pair.mid);
  }
  return out;
}

/** Reads what the rules need, evaluates and enriches (no write). Exported for the tests. */
export async function evaluateWorkspaceAlerts(input: Omit<PaymentRiskAlertsRunInput, "trigger" | "actorUserId">): Promise<AlertEvaluation> {
  const clock = input.clock ?? Date.now;
  const rules = await loadAlertRules(input.pg);
  const reader = input.clickhouse();
  const [registry, snapshot] = await Promise.all([
    loadDimensionRegistry({ tenantKey: input.tenantKey, clickhouse: reader, pg: input.pg }),
    loadAnchorSnapshot(input.pg, input.tenantKey),
  ]);
  const preloaded = { registry, snapshot };
  const dataThrough = registry.last_day;
  const run = (body: AlertDataRequest["body"]) =>
    runPaymentHealth({ tenantKey: input.tenantKey, clickhouse: reader, pg: input.pg, request: body, pspVisible: true, clock, preloaded });

  const requests = planAlertRequests(rules, dataThrough);
  const [answers, accountAliases] = await Promise.all([
    Promise.all(requests.map(async (request) => [request.key, await run(request.body)] as const)),
    registeredAccountAliases(input.tenantKey, registry),
  ]);
  const data: AlertDataSet = { data_through: dataThrough, today: todayOf(clock), now_ms: clock(), responses: Object.fromEntries(answers), account_aliases: accountAliases };
  const evaluation = evaluateAlertRules(rules, data);

  // Funnels for the warning / critical account alerts, the strongest first, bounded per run.
  const lookups = evaluation.candidates
    .map((candidate) => ({ candidate, request: funnelLookupRequest(candidate) }))
    .filter((entry): entry is { candidate: AlertCandidate; request: AlertDataRequest } => entry.request !== null)
    .sort((a, b) => SEVERITY_RANK[b.candidate.severity] - SEVERITY_RANK[a.candidate.severity] || Math.abs(b.candidate.change_value ?? 0) - Math.abs(a.candidate.change_value ?? 0))
    .slice(0, FUNNEL_LOOKUP_LIMIT);
  for (const { candidate, request } of lookups) {
    candidate.affected_funnels = affectedFunnels(candidate, breakdownOf(await run(request.body)));
  }
  return evaluation;
}

/** One alert run: claim → evaluate → apply. The scheduler's double fire returns skipped; a person inside the interval gets 429. */
export async function runPaymentRiskAlerts(input: PaymentRiskAlertsRunInput): Promise<AlertsRunResponse> {
  const clock = input.clock ?? Date.now;
  const started = clock();
  const action = input.trigger === "cron" ? "alerts_tick" : "alerts_run";
  const claimed = await callRpc(input.pg, "payment_alerts_claim_run", {
    p_data_key: input.tenantKey,
    p_trigger: input.trigger,
    p_actor: input.actorUserId,
    p_min_interval_seconds: input.trigger === "cron" ? ALERTS_TICK_MIN_INTERVAL_SECONDS : ALERTS_RUN_MIN_INTERVAL_SECONDS,
  });
  if (claimed.error) throw new Error(`Could not start an alert run: ${claimed.error.message}`);
  const claim = asRecord(claimed.data);
  if (claim.claimed !== true) {
    if (input.trigger === "manual") throw new PaymentAlertsRateLimitedError(Math.max(1, Math.trunc(num(claim.retry_after_seconds, ALERTS_RUN_MIN_INTERVAL_SECONDS))));
    return { ok: true, action, run: null, skipped: "recent_run" };
  }
  const runId = text(claim.run_id);
  const startedAt = text(claim.started_at) || new Date(started).toISOString();

  let evaluation: AlertEvaluation;
  let applied: Record<string, unknown>;
  try {
    evaluation = await evaluateWorkspaceAlerts(input);
    const summary = {
      trigger: input.trigger,
      windows: evaluation.windows,
      rules: evaluation.rules,
      candidates: evaluation.candidates.length,
      by_severity: severityCounts(evaluation.candidates),
      duration_ms: clock() - started,
    };
    const result = await callRpc(input.pg, "payment_alerts_apply_run", {
      p_run_id: runId,
      p_data_key: input.tenantKey,
      p_alerts: evaluation.candidates.map(candidateRow),
      p_cleared: evaluation.cleared,
      p_summary: summary,
      p_data_through: evaluation.data_through,
    });
    if (result.error) throw new Error(`Could not write the alerts: ${result.error.message}`);
    applied = asRecord(result.data);
  } catch (error) {
    // Record the failure on the run row (best effort: the run's own error is what the caller must see).
    try {
      await callRpc(input.pg, "payment_alerts_fail_run", { p_run_id: runId, p_data_key: input.tenantKey, p_error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    } catch (failure) {
      if (failure instanceof ScopeViolation) throw failure;
    }
    throw error;
  }

  const counts: AlertRunCounts = {
    candidates: evaluation.candidates.length,
    by_severity: severityCounts(evaluation.candidates),
    inserted: num(applied.inserted),
    updated: num(applied.updated),
    carried: num(applied.carried),
    reopened: num(applied.reopened),
    suppressed: num(applied.suppressed),
    auto_resolved: num(applied.auto_resolved),
  };
  const run: AlertRunSummary = {
    run_id: runId,
    trigger: input.trigger,
    started_at: startedAt,
    finished_at: new Date(clock()).toISOString(),
    status: "succeeded",
    data_through: evaluation.data_through,
    windows: evaluation.windows,
    rules: evaluation.rules,
    counts,
  };
  return { ok: true, action, run, skipped: null };
}

// ---------------------------------------------------------------------------
// alerts_list / alert_update
// ---------------------------------------------------------------------------

export const ALERT_COLUMNS =
  "id,rule_key,alert_key,scope_key,severity,status,scope,affected_funnels,metric,unit,current_value,baseline_value,change_value,sample_size,data_confidence,window_start,window_end,evidence,explanation,first_seen_at,last_seen_at,resolved_at,auto_resolved,assignee,status_history,updated_by,updated_at,psp_scoped";

const nullableNumber = (value: unknown): number | null => (value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null);
const nullableText = (value: unknown): string | null => (value == null || value === "" ? null : String(value));
const dayText = (value: unknown): string | null => (value == null || value === "" ? null : String(value).slice(0, 10));

function historyOf(value: unknown): AlertHistoryEntry[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object").map((entry) => ({
      at: text(entry.at),
      event: (["raised", "reopened", "auto_resolved", "status"].includes(text(entry.event)) ? text(entry.event) : "status") as AlertHistoryEntry["event"],
      from: (ALERT_STATUSES as readonly string[]).includes(text(entry.from)) ? (text(entry.from) as AlertStatus) : null,
      to: ((ALERT_STATUSES as readonly string[]).includes(text(entry.to)) ? text(entry.to) : "new") as AlertStatus,
      by: nullableText(entry.by),
      auto: entry.auto === true,
      note: nullableText(entry.note),
    }))
    : [];
}

function explanationOf(value: unknown): AlertExplanation {
  const record = asRecord(value);
  return {
    fact: text(record.fact),
    likely_explanation: text(record.likely_explanation),
    hypothesis: text(record.hypothesis),
    action: Array.isArray(record.action) ? record.action.map(text) : record.action ? [text(record.action)] : [],
  };
}

/** A payment_risk_alerts row (PostgREST or the update function's to_jsonb) → the API shape, PSP detail stripped for a caller without the PSP key. */
export function projectAlert(row: Record<string, unknown>, pspVisible: boolean): PaymentRiskAlert {
  const scope = asRecord(row.scope) as unknown as AlertScope;
  const evidence = { ...asRecord(row.evidence) };
  // The tenant-wide retry alerts list the accounts the re-attempts were on: PSP detail, like the page's account references.
  if (!pspVisible) delete evidence.by_account;
  const ruleKey = (isAlertRuleKey(row.rule_key) ? row.rule_key : "data_stale") as AlertRuleKey;
  return {
    id: text(row.id),
    rule_key: ruleKey,
    alert_key: text(row.alert_key),
    scope_key: text(row.scope_key),
    severity: ((ALERT_SEVERITIES as readonly string[]).includes(text(row.severity)) ? text(row.severity) : "info") as AlertSeverity,
    status: ((ALERT_STATUSES as readonly string[]).includes(text(row.status)) ? text(row.status) : "new") as AlertStatus,
    scope,
    affected_funnels: Array.isArray(row.affected_funnels) ? row.affected_funnels.map(text) : [],
    metric: text(row.metric),
    unit: (text(row.unit) || "rate") as AlertUnit,
    current_value: nullableNumber(row.current_value),
    baseline_value: nullableNumber(row.baseline_value),
    change_value: nullableNumber(row.change_value),
    sample_size: num(row.sample_size),
    data_confidence: text(row.data_confidence) === "high" ? "high" : "low",
    window_start: dayText(row.window_start),
    window_end: dayText(row.window_end) ?? "",
    evidence,
    explanation: explanationOf(row.explanation),
    first_seen_at: text(row.first_seen_at),
    last_seen_at: text(row.last_seen_at),
    resolved_at: nullableText(row.resolved_at),
    auto_resolved: row.auto_resolved === true,
    assignee: nullableText(row.assignee),
    status_history: historyOf(row.status_history),
    updated_by: nullableText(row.updated_by),
    updated_at: text(row.updated_at),
    psp_scoped: row.psp_scoped === true || isPspScopedAlert(scope),
  };
}

function runSummaryOf(row: Record<string, unknown> | null): AlertRunSummary | null {
  if (!row) return null;
  const summary = asRecord(row.summary);
  const applied = asRecord(summary.applied);
  const bySeverity = asRecord(summary.by_severity);
  const status = text(row.status);
  return {
    run_id: text(row.id),
    trigger: text(row.trigger) === "manual" ? "manual" : "cron",
    started_at: text(row.started_at),
    finished_at: nullableText(row.finished_at),
    status: status === "succeeded" || status === "failed" ? status : "running",
    data_through: dayText(row.data_through),
    windows: asRecord(summary.windows) as AlertRunSummary["windows"],
    rules: (Array.isArray(summary.rules) ? summary.rules : []) as AlertRunRuleOutcome[],
    counts: status === "succeeded"
      ? {
        candidates: num(summary.candidates),
        by_severity: Object.fromEntries(ALERT_SEVERITIES.map((severity) => [severity, num(bySeverity[severity])])) as Record<AlertSeverity, number>,
        inserted: num(applied.inserted),
        updated: num(applied.updated),
        carried: num(applied.carried),
        reopened: num(applied.reopened),
        suppressed: num(applied.suppressed),
        auto_resolved: num(applied.auto_resolved),
      }
      : null,
  };
}

function ruleView(rule: AlertRuleConfig): AlertRuleView {
  const meta = ALERT_RULE_META[rule.rule_key];
  return {
    rule_key: rule.rule_key,
    title: meta.title,
    enabled: rule.enabled,
    severity_warning: rule.severity_warning,
    severity_critical: rule.severity_critical,
    min_sample: rule.min_sample,
    window_days: rule.window_days,
    metric: meta.metric,
    unit: meta.unit,
    psp_scoped: meta.psp_scoped,
    description: rule.description,
  };
}

export interface PaymentAlertsActionInput {
  action: PaymentAlertAction;
  /** ctx.tenantKey — the workspace data key, never the caller. */
  tenantKey: string;
  /** ctx.actor.userId: the member who changes a status (null for the scheduler). */
  actorUserId: string | null;
  /** payment_health.psp_global.view or the data owner (pspDimensionsVisible). */
  pspVisible: boolean;
  /** payment_health.manage_alerts or the data owner: the UI's buttons (meta.can_manage). */
  canManage: boolean;
  requestId: string;
  body: Record<string, unknown>;
  /** The request's lazily created ScopedReader (alerts_list / alert_update never open it). */
  clickhouse: () => ClickHouseClientLike;
  pg: SupabaseLikeClient;
  clock?: () => number;
}

export async function listPaymentRiskAlerts(input: PaymentAlertsActionInput): Promise<AlertsListResponse> {
  const clock = input.clock ?? Date.now;
  const req = normalizeAlertsListRequest(input.body);
  const filtered = (columns: string, statuses: readonly AlertStatus[] | null, options?: Record<string, unknown>) => {
    let query = input.pg.from("payment_risk_alerts").select(columns, options).eq("auth_user_id", input.tenantKey);
    if (statuses) query = query.in("status", [...statuses]);
    if (req.severity.length) query = query.in("severity", req.severity);
    if (req.rule.length) query = query.in("rule_key", req.rule);
    return query;
  };
  // The page is open alerts first, then closed ones, each newest first: two reads, so the limit can never
  // cut an open alert in favour of a closed one (an open alert whose scope stays inconclusive is not
  // refreshed, while a dismissed one on a re-run window is). A status filter narrows both.
  const wanted = req.status.length ? req.status : ALERT_STATUSES;
  const openStatuses = wanted.filter((status) => OPEN_ALERT_STATUSES.includes(status));
  const closedStatuses = wanted.filter((status) => !OPEN_ALERT_STATUSES.includes(status));
  // A caller without the PSP key never receives a PSP-scoped row (filtered in SQL, so the limit counts visible rows only).
  const page = (statuses: readonly AlertStatus[]) => {
    if (!statuses.length) return null;
    const query = input.pspVisible ? filtered(ALERT_COLUMNS, statuses) : filtered(ALERT_COLUMNS, statuses).eq("psp_scoped", false);
    return query.order("last_seen_at", { ascending: false }).limit(req.limit + 1);
  };
  const hidden = input.pspVisible ? null : filtered("id", req.status.length ? req.status : null, { count: "exact", head: true }).eq("psp_scoped", true);
  const lastRun = input.pg.from("payment_alert_runs").select("id,trigger,status,started_at,finished_at,data_through,summary").eq("auth_user_id", input.tenantKey).order("started_at", { ascending: false }).limit(1);
  const [openResult, closedResult, hiddenResult, runResult, rules] = await Promise.all([
    page(openStatuses),
    page(closedStatuses),
    hidden,
    lastRun,
    loadAlertRules(input.pg),
  ]);
  for (const result of [openResult, closedResult]) {
    if (result?.error) throw new Error(`Could not read payment_risk_alerts: ${result.error.message}`);
  }
  if (hiddenResult?.error) throw new Error(`Could not count payment_risk_alerts: ${hiddenResult.error.message}`);
  if (runResult.error) throw new Error(`Could not read payment_alert_runs: ${runResult.error.message}`);

  const rows = [openResult, closedResult]
    .flatMap((result) => ((result?.data ?? []) as Array<Record<string, unknown>>))
    .map((row) => projectAlert(row, input.pspVisible));
  // Defence in depth: whatever the query returned, a PSP-scoped alert never reaches a caller without the key.
  const shown = rows.filter((alert) => input.pspVisible || !alert.psp_scoped);
  const limited = shown.length > req.limit;
  const alerts = shown
    .sort((a, b) =>
      Number(OPEN_ALERT_STATUSES.includes(b.status)) - Number(OPEN_ALERT_STATUSES.includes(a.status))
      || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      || (a.last_seen_at < b.last_seen_at ? 1 : a.last_seen_at > b.last_seen_at ? -1 : 0)
      || a.alert_key.localeCompare(b.alert_key))
    .slice(0, req.limit);
  const byStatus = Object.fromEntries(ALERT_STATUSES.map((status) => [status, 0])) as Record<AlertStatus, number>;
  const openBySeverity = Object.fromEntries(ALERT_SEVERITIES.map((severity) => [severity, 0])) as Record<AlertSeverity, number>;
  for (const alert of alerts) {
    byStatus[alert.status] += 1;
    if (OPEN_ALERT_STATUSES.includes(alert.status)) openBySeverity[alert.severity] += 1;
  }
  const hiddenCount = hiddenResult ? num(hiddenResult.count ?? (Array.isArray(hiddenResult.data) ? hiddenResult.data.length : 0)) : 0;
  return {
    ok: true,
    action: "alerts_list",
    alerts,
    counts: { total: alerts.length, open: byStatus.new + byStatus.investigating, by_status: byStatus, open_by_severity: openBySeverity },
    hidden_psp_scoped: hiddenCount,
    last_run: runSummaryOf(((runResult.data ?? []) as Array<Record<string, unknown>>)[0] ?? null),
    rules: rules.map(ruleView),
    meta: {
      generated_at: new Date(clock()).toISOString(),
      psp_global_visible: input.pspVisible,
      can_manage: input.canManage,
      filters: { status: req.status, severity: req.severity, rule: req.rule },
      limit: req.limit,
      limited,
      run_min_interval_seconds: ALERTS_RUN_MIN_INTERVAL_SECONDS,
    },
  };
}

/** The coded refusals payment_alert_update_status raises ("<code>: <detail>", SQLSTATE P0001 / P0002). */
function updateError(message: string, from: string, to: string): Error {
  if (/^not_found\b/.test(message) || /\bnot_found:/.test(message)) return new PaymentAlertNotFoundError();
  if (/\binvalid_transition:/.test(message)) return new PaymentAlertTransitionError(from, to);
  if (/\binvalid:/.test(message)) return new PaymentHealthRequestError(message.replace(/^.*?\binvalid:\s*/, ""));
  return new Error(`Could not update the alert: ${message}`);
}

export async function updatePaymentRiskAlert(input: PaymentAlertsActionInput): Promise<AlertUpdateResponse> {
  const req = normalizeAlertUpdateRequest(input.body);
  if (!input.actorUserId) throw new PaymentHealthRequestError("alert_update needs a signed-in member.");
  const { data, error } = await input.pg.from("payment_risk_alerts").select("id,status,psp_scoped").eq("auth_user_id", input.tenantKey).eq("id", req.alert_id).maybeSingle();
  if (error) throw new Error(`Could not read the alert: ${error.message}`);
  const current = (data ?? null) as Record<string, unknown> | null;
  // An alert the caller may not see does not exist for them (no PSP detail through the update's answer).
  if (!current || (current.psp_scoped === true && !input.pspVisible)) throw new PaymentAlertNotFoundError();
  const from = text(current.status) as AlertStatus;
  if (!isAllowedAlertTransition(from, req.status)) throw new PaymentAlertTransitionError(from, req.status);
  // The function re-checks the transition under a row lock, writes the history entry and the
  // access_audit_log row (access_write_audit) in the same transaction.
  const result = await callRpc(input.pg, "payment_alert_update_status", {
    p_data_key: input.tenantKey,
    p_actor: input.actorUserId,
    p_alert_id: req.alert_id,
    p_status: req.status,
    p_note: req.note,
    p_request_id: input.requestId,
  });
  if (result.error) throw updateError(result.error.message, from, req.status);
  const row = asRecord(result.data);
  if (!row.id) throw new PaymentAlertNotFoundError();
  return { ok: true, action: "alert_update", alert: projectAlert(row, input.pspVisible) };
}

/** The router of the alert actions (index.ts calls it for every action isPaymentAlertAction accepts). */
export async function runPaymentAlertsAction(input: PaymentAlertsActionInput): Promise<PaymentAlertsResponse> {
  switch (input.action) {
    case "alerts_list":
      return listPaymentRiskAlerts(input);
    case "alert_update":
      return updatePaymentRiskAlert(input);
    case "alerts_run":
      return runPaymentRiskAlerts({ tenantKey: input.tenantKey, clickhouse: input.clickhouse, pg: input.pg, trigger: "manual", actorUserId: input.actorUserId, clock: input.clock });
    case "alerts_tick":
      return runPaymentRiskAlerts({ tenantKey: input.tenantKey, clickhouse: input.clickhouse, pg: input.pg, trigger: "cron", actorUserId: null, clock: input.clock });
  }
}
