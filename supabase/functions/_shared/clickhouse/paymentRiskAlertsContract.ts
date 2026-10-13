// Payment System Health P2.5: the alert contract (plan sections P, Q, X, N).
//
// Pure module (no Deno globals, no ClickHouse, no Postgres): the alert engine
// (paymentRiskAlerts.ts), the policy (access/policies/clickhouse-payment-health.ts),
// the browser data source and the tests read the same rule keys, statuses,
// transitions, request normalizers and response shapes, so a status the UI
// offers and a transition the SQL accepts (payment_alert_update_status in
// 202610130001) cannot drift apart — a parity test reads the SQL.
//
// Conventions (the P2 contract's, plus the alert ones):
//   * an alert names PSP accounts only by registry label and opaque key (the
//     MerchantAccountRef of the page), never a raw MID or descriptor; funnels
//     by their anchor label; no emails, card fragments, tokens, IPs or
//     transaction ids anywhere (evidence included);
//   * an alert from a low sample or an incomplete window is never warning /
//     critical: it is `info` with data_confidence `low` (the table enforces
//     it with a check constraint too);
//   * declines are never called fraud (issuer_fraud_rise is the issuers'
//     suspicion codes);
//   * every recommendation is fact → likely explanation → unverified
//     hypothesis → compliant actions (paymentRiskRecommendations.ts), and
//     none suggests moving or splitting volume between MIDs, descriptors or
//     PSPs, or lowering authentication.

import type { DimensionValue, MerchantAccountRef } from "./paymentHealthContract.ts";
import { PaymentHealthRequestError } from "./paymentHealthContract.ts";

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** The alert actions a user request may name (POST body `action`). */
export const PAYMENT_ALERT_USER_ACTIONS = ["alerts_list", "alert_update", "alerts_run"] as const;
export type PaymentAlertUserAction = (typeof PAYMENT_ALERT_USER_ACTIONS)[number];
/** The scheduler's action: reachable only through the policy's cron branch (x-cron-secret). */
export const PAYMENT_ALERT_CRON_ACTION = "alerts_tick" as const;
export type PaymentAlertAction = PaymentAlertUserAction | typeof PAYMENT_ALERT_CRON_ACTION;

export function isPaymentAlertAction(value: unknown): value is PaymentAlertAction {
  return value === PAYMENT_ALERT_CRON_ACTION || (typeof value === "string" && (PAYMENT_ALERT_USER_ACTIONS as readonly string[]).includes(value));
}

// ---------------------------------------------------------------------------
// Rules, severities, statuses
// ---------------------------------------------------------------------------

/** The MVP rules (plan Q, phase P2.5). Network-ratio rules (VAMP / ECP) are P4. */
export const ALERT_RULE_KEYS = [
  "approval_drop",
  "issuer_fraud_rise",
  "psp_integration_rise",
  "post_ban_retries",
  "excessive_reattempts",
  "unauthorized_complaints_rise",
  "refund_rate_rise",
  "data_stale",
] as const;
export type AlertRuleKey = (typeof ALERT_RULE_KEYS)[number];

export const ALERT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_STATUSES = ["new", "investigating", "resolved", "dismissed"] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];
/** Open = still to act on: the engine carries these forward to a newer window and auto-resolves them. */
export const OPEN_ALERT_STATUSES: readonly AlertStatus[] = ["new", "investigating"];

export const ALERT_CONFIDENCE = ["high", "low"] as const;
export type AlertConfidence = (typeof ALERT_CONFIDENCE)[number];

/** Unit of current_value / baseline_value: a rate is a fraction 0..1 (change_value is then in percentage points). */
export const ALERT_UNITS = ["rate", "count", "days", "hours"] as const;
export type AlertUnit = (typeof ALERT_UNITS)[number];

/**
 * Who may move an alert where (alert_update; the SQL function
 * payment_alert_update_status holds the same table and is the authority):
 *   new           → investigating (acknowledged; the actor becomes the assignee if none),
 *                   resolved, dismissed;
 *   investigating → resolved, dismissed;
 *   resolved / dismissed → investigating (reopen).
 * A same-status "transition" is invalid. The engine itself only ever writes
 * new (raise / reopen an auto-resolved alert) and resolved + auto_resolved.
 */
export const ALERT_STATUS_TRANSITIONS: Readonly<Record<AlertStatus, readonly AlertStatus[]>> = {
  new: ["investigating", "resolved", "dismissed"],
  investigating: ["resolved", "dismissed"],
  resolved: ["investigating"],
  dismissed: ["investigating"],
};

export function isAllowedAlertTransition(from: AlertStatus, to: AlertStatus): boolean {
  return (ALERT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = { info: 0, warning: 1, critical: 2 };

// ---------------------------------------------------------------------------
// Limits and parameters
// ---------------------------------------------------------------------------

/** alerts_run (a person): at most one run per this many seconds per workspace (any trigger counts). */
export const ALERTS_RUN_MIN_INTERVAL_SECONDS = 300;
/** alerts_tick (the scheduler): a double fire inside this window is skipped, not run twice. */
export const ALERTS_TICK_MIN_INTERVAL_SECONDS = 60;
export const ALERTS_LIST_DEFAULT_LIMIT = 100;
export const ALERTS_LIST_MAX_LIMIT = 500;
export const ALERT_NOTE_MAX_LENGTH = 1000;
/** Funnel labels an alert names at most (the funnels that moved the metric most). */
export const AFFECTED_FUNNELS_LIMIT = 5;
/** Funnel breakdown lookups one run makes at most (one ClickHouse statement each). */
export const FUNNEL_LOOKUP_LIMIT = 12;
/**
 * Windows end at data_through minus this many days. data_through is the
 * newest attempt day, and the Primer CSV is usually exported during that day,
 * so it is partial by construction (plan P: "the last days are incomplete").
 * A window holding it would compare a part-day against a whole baseline week
 * and could still read as complete (range.to <= data_through), so the rules
 * read whole days only: one day of latency. data_stale keeps data_through
 * itself (how old the newest payment is).
 */
export const ALERT_WINDOW_END_LAG_DAYS = 1;

/** One row of public.payment_alert_rules (owner-editable; the seed never resets edits). */
export interface AlertRuleConfig {
  rule_key: AlertRuleKey;
  enabled: boolean;
  /** The rule's main threshold in its unit: percentage points (rate rules), a count (retry rules), days (data_stale). */
  severity_warning: number;
  severity_critical: number;
  /** Observations per window (both windows of a comparison) needed for a high-confidence alert. */
  min_sample: number;
  window_days: number;
  compare: "previous_window";
  params: Record<string, unknown>;
  description: string;
}

/**
 * The seed of public.payment_alert_rules (202610130001), as data: the engine's
 * documentation, the tests' defaults and a parity test against the SQL seed.
 * The live values are the table's (the owner may edit them).
 */
export const DEFAULT_ALERT_RULES: readonly AlertRuleConfig[] = [
  {
    rule_key: "approval_drop",
    enabled: true,
    severity_warning: 5,
    severity_critical: 10,
    min_sample: 200,
    window_days: 7,
    compare: "previous_window",
    params: { min_sample_info: 50 },
    description:
      "Attempt approval per PSP x MID and initiation (CIT / MIT), and per PSP with more than one MID, fell by at least the threshold in percentage points against the previous window, outside both 95% Wilson intervals.",
  },
  {
    rule_key: "issuer_fraud_rise",
    enabled: true,
    severity_warning: 1,
    severity_critical: 2.5,
    min_sample: 200,
    window_days: 7,
    compare: "previous_window",
    params: { min_sample_info: 50 },
    description:
      "Issuer fraud-suspicion declines (codes 59 / 63 / 83, else Primer SUSPECTED_FRAUD) per PSP x MID rose by at least the threshold in percentage points of attempts, significant per Wilson. The issuers' suspicion, not confirmed fraud.",
  },
  {
    rule_key: "psp_integration_rise",
    enabled: true,
    severity_warning: 1,
    severity_critical: 3,
    min_sample: 200,
    window_days: 7,
    compare: "previous_window",
    params: { min_sample_info: 50 },
    description:
      "PSP / integration declines (AUTHORIZATION_FAILED without an issuer code) per PSP x MID, and those plus the unrouted declines (cause not verified) over all attempts, rose by at least the threshold in percentage points, significant per Wilson.",
  },
  {
    rule_key: "post_ban_retries",
    enabled: true,
    severity_warning: 1,
    severity_critical: 10,
    min_sample: 1,
    window_days: 30,
    compare: "previous_window",
    params: {},
    description:
      "Re-attempts on a card after a do-not-retry decline (DO_NOT_RETRY / STOP_ALL_PAYMENTS, Visa category 1, Mastercard MAC 03 / 21) in the last 30 days, CIT and MIT separately. The thresholds are counts. Network rules from secondary sources (unverified).",
  },
  {
    rule_key: "excessive_reattempts",
    enabled: true,
    severity_warning: 1,
    severity_critical: 5,
    min_sample: 1,
    window_days: 30,
    compare: "previous_window",
    params: {},
    description:
      "Card x merchant-account pairs with more than 15 declines in a rolling 30-day window ending in the last 30 days (attemptChains.ts; the Visa limit, unverified). The thresholds are counts of pairs.",
  },
  {
    rule_key: "unauthorized_complaints_rise",
    enabled: true,
    severity_warning: 1,
    severity_critical: 3,
    min_sample: 200,
    window_days: 7,
    compare: "previous_window",
    params: { min_sample_info: 50 },
    description:
      "Support requests flagged possible_unauthorized_charge per settled payment, attributed to the PSP x MID of the customer's last settled payment within 30 days, rose by at least the threshold in percentage points, significant per Wilson. By received date: low confidence only while the support data does not reach the window's end.",
  },
  {
    rule_key: "refund_rate_rise",
    enabled: true,
    severity_warning: 1,
    severity_critical: 2.5,
    min_sample: 200,
    window_days: 7,
    compare: "previous_window",
    params: { min_sample_info: 50, maturity_days: 30 },
    description:
      "Refund rate per PSP x MID by original payment date rose by at least the threshold in percentage points, significant per Wilson, on the newest MATURE window (ending maturity_days before data_through).",
  },
  {
    rule_key: "data_stale",
    enabled: true,
    severity_warning: 7,
    severity_critical: 14,
    min_sample: 1,
    window_days: 1,
    compare: "previous_window",
    params: { sync_warning_hours: 72, sync_critical_hours: 168 },
    description:
      "The newest attempt in the warehouse (data_through) is older than the thresholds in days, or the last ClickHouse sync of payment rows or of support requests is older than sync_warning_hours / sync_critical_hours.",
  },
];

export interface AlertRuleMeta {
  title: string;
  metric: string;
  unit: AlertUnit;
  /** Alerts of this rule name a PSP account (scope.kind = 'account'): shown only with payment_health.psp_global.view. */
  psp_scoped: boolean;
}

export const ALERT_RULE_META: Readonly<Record<AlertRuleKey, AlertRuleMeta>> = {
  approval_drop: { title: "Approval drop", metric: "attempt_approval_rate", unit: "rate", psp_scoped: true },
  issuer_fraud_rise: { title: "Issuer fraud-suspicion declines rise", metric: "issuer_fraud_declines", unit: "rate", psp_scoped: true },
  // Mixed: per account (PSP-scoped) and one tenant-wide line (unrouted + integration), which is not.
  psp_integration_rise: { title: "PSP / integration declines rise", metric: "psp_integration_decline_rate", unit: "rate", psp_scoped: false },
  post_ban_retries: { title: "Re-attempts after a do-not-retry decline", metric: "post_ban_attempts", unit: "count", psp_scoped: false },
  excessive_reattempts: { title: "More than 15 declines per card in 30 days", metric: "rolling_reattempt_violations", unit: "count", psp_scoped: false },
  unauthorized_complaints_rise: { title: "Unauthorized-charge complaints rise", metric: "support_unauthorized_rate", unit: "rate", psp_scoped: true },
  refund_rate_rise: { title: "Refund rate rise", metric: "refund_rate", unit: "rate", psp_scoped: true },
  data_stale: { title: "Payment data is stale", metric: "data_lag_days", unit: "days", psp_scoped: false },
};

export function isAlertRuleKey(value: unknown): value is AlertRuleKey {
  return typeof value === "string" && (ALERT_RULE_KEYS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Alert shape (what the table holds and alerts_list returns)
// ---------------------------------------------------------------------------

/** What an alert is about. Labels and opaque keys only. */
export interface AlertScope {
  /**
   * account: one PSP x MID, or (no merchant_account) every MID of one PSP — approval_drop's PSP-wide line;
   * PSP-scoped either way (needs payment_health.psp_global.view). tenant: the whole workspace.
   */
  kind: "account" | "tenant";
  processor?: DimensionValue;
  merchant_account?: MerchantAccountRef;
  /** approval_drop (per account) and post_ban_retries (tenant): one alert per initiation. */
  initiation?: "cit" | "mit";
  /** Tenant lines: 'unrouted_and_integration' (psp_integration_rise), 'post_ban', 'rolling', 'data_through', 'warehouse_sync', 'support_sync'. */
  subject?: string;
}

/** The account segment of a PSP-wide scope key (account:<proc>:all[:<initiation>]): never a registry id or an unlabelled hash. */
export const ALL_ACCOUNTS_SCOPE_SEGMENT = "all";

/** Plan Q: fact → likely explanation → unverified hypothesis → compliant actions. */
export interface AlertExplanation {
  fact: string;
  likely_explanation: string;
  hypothesis: string;
  action: string[];
}

export interface AlertHistoryEntry {
  at: string;
  /** raised (engine), reopened (engine: an auto-resolved alert fired again on the same window), auto_resolved (engine), status (a person). */
  event: "raised" | "reopened" | "auto_resolved" | "status";
  from: AlertStatus | null;
  to: AlertStatus;
  /** The member's auth user id for a person's change; null for the engine. */
  by: string | null;
  auto: boolean;
  note: string | null;
}

export interface PaymentRiskAlert {
  id: string;
  rule_key: AlertRuleKey;
  /** rule | scope_key | window_end: the same window re-evaluated updates this row instead of adding one. */
  alert_key: string;
  /** rule + scope (the condition's identity across windows). */
  scope_key: string;
  severity: AlertSeverity;
  status: AlertStatus;
  scope: AlertScope;
  /** Funnel labels (acquisition anchor) that moved the metric most; [] when not computed (complaints, retries, low confidence). */
  affected_funnels: string[];
  metric: string;
  unit: AlertUnit;
  current_value: number | null;
  baseline_value: number | null;
  /** Percentage points for a rate; the difference for a count / days / hours. */
  change_value: number | null;
  sample_size: number;
  data_confidence: AlertConfidence;
  /** YYYY-MM-DD, inclusive. */
  window_start: string | null;
  window_end: string;
  /** Numbers and the request that reproduces them on the page (evidence.reproduce). */
  evidence: Record<string, unknown>;
  explanation: AlertExplanation;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  auto_resolved: boolean;
  assignee: string | null;
  status_history: AlertHistoryEntry[];
  updated_by: string | null;
  updated_at: string;
  /** The alert names a PSP account (scope.kind = 'account'). */
  psp_scoped: boolean;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface AlertsListRequest {
  status: AlertStatus[];
  severity: AlertSeverity[];
  rule: AlertRuleKey[];
  limit: number;
}

export interface AlertUpdateRequest {
  alert_id: string;
  status: AlertStatus;
  note: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enumList<T extends string>(value: unknown, field: string, allowed: readonly T[]): T[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: T[] = [];
  for (const entry of raw) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!(allowed as readonly string[]).includes(text)) throw new PaymentHealthRequestError(`Filter ${field} accepts ${allowed.join(", ")}, not ${String(entry)}.`);
    if (!out.includes(text as T)) out.push(text as T);
  }
  return out;
}

/** alerts_list body: `status`, `severity`, `rule` (a value or a list each; empty = all) and `limit`. */
export function normalizeAlertsListRequest(body: unknown): AlertsListRequest {
  const req = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const filters = (req.filters && typeof req.filters === "object" && !Array.isArray(req.filters) ? req.filters : req) as Record<string, unknown>;
  let limit = ALERTS_LIST_DEFAULT_LIMIT;
  if (req.limit != null) {
    const parsed = Number(req.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > ALERTS_LIST_MAX_LIMIT) throw new PaymentHealthRequestError(`limit must be an integer between 1 and ${ALERTS_LIST_MAX_LIMIT}.`);
    limit = parsed;
  }
  return {
    status: enumList(filters.status, "status", ALERT_STATUSES),
    severity: enumList(filters.severity, "severity", ALERT_SEVERITIES),
    rule: enumList(filters.rule ?? filters.rule_key, "rule", ALERT_RULE_KEYS),
    limit,
  };
}

/** alert_update body: `alert_id` (uuid), `status` (the target), optional `note` (trimmed, at most ALERT_NOTE_MAX_LENGTH). */
export function normalizeAlertUpdateRequest(body: unknown): AlertUpdateRequest {
  const req = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const id = typeof req.alert_id === "string" ? req.alert_id.trim() : "";
  if (!UUID_RE.test(id)) throw new PaymentHealthRequestError("alert_id must be a uuid.");
  const status = typeof req.status === "string" ? req.status.trim() : "";
  if (!(ALERT_STATUSES as readonly string[]).includes(status)) throw new PaymentHealthRequestError(`status accepts ${ALERT_STATUSES.join(", ")}.`);
  let note: string | null = null;
  if (req.note != null) {
    if (typeof req.note !== "string") throw new PaymentHealthRequestError("note must be text.");
    note = req.note.trim() || null;
    if (note && note.length > ALERT_NOTE_MAX_LENGTH) throw new PaymentHealthRequestError(`note is longer than ${ALERT_NOTE_MAX_LENGTH} characters.`);
  }
  return { alert_id: id.toLowerCase(), status: status as AlertStatus, note };
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export interface AlertRuleView {
  rule_key: AlertRuleKey;
  title: string;
  enabled: boolean;
  severity_warning: number;
  severity_critical: number;
  min_sample: number;
  window_days: number;
  metric: string;
  unit: AlertUnit;
  psp_scoped: boolean;
  description: string;
}

export interface AlertRunRuleOutcome {
  rule_key: AlertRuleKey;
  /** evaluated: the rule ran; skipped: it could not (no data / no rows); disabled: enabled = false in payment_alert_rules. */
  status: "evaluated" | "skipped" | "disabled";
  reason: string | null;
  /** Conditions found (alerts written or refreshed) and conditions conclusively clear (open alerts auto-resolved). */
  candidates: number;
  cleared: number;
  /** Scopes the rule looked at but could not decide (sample too small): neither raised nor resolved. */
  inconclusive: number;
}

export interface AlertRunCounts {
  candidates: number;
  by_severity: Record<AlertSeverity, number>;
  inserted: number;
  updated: number;
  carried: number;
  reopened: number;
  suppressed: number;
  auto_resolved: number;
}

/** What alerts_run / alerts_tick return, and the summary payment_alert_runs keeps. */
export interface AlertRunSummary {
  run_id: string;
  trigger: "cron" | "manual";
  started_at: string;
  finished_at: string | null;
  status: "running" | "succeeded" | "failed";
  data_through: string | null;
  windows: Record<string, { from: string; to: string }>;
  rules: AlertRunRuleOutcome[];
  counts: AlertRunCounts | null;
}

export interface AlertsListResponse {
  ok: true;
  action: "alerts_list";
  alerts: PaymentRiskAlert[];
  /** Over the returned (visible) alerts. */
  counts: { total: number; open: number; by_status: Record<AlertStatus, number>; open_by_severity: Record<AlertSeverity, number> };
  /** PSP-scoped alerts left out for a caller without payment_health.psp_global.view (0 otherwise). */
  hidden_psp_scoped: number;
  last_run: AlertRunSummary | null;
  rules: AlertRuleView[];
  meta: {
    generated_at: string;
    psp_global_visible: boolean;
    can_manage: boolean;
    filters: { status: AlertStatus[]; severity: AlertSeverity[]; rule: AlertRuleKey[] };
    limit: number;
    /** More alerts matched than `limit`. */
    limited: boolean;
    run_min_interval_seconds: number;
  };
}

export interface AlertUpdateResponse {
  ok: true;
  action: "alert_update";
  alert: PaymentRiskAlert;
}

export interface AlertsRunResponse {
  ok: true;
  action: "alerts_run" | "alerts_tick";
  /** null when the scheduler's tick was skipped (another run started moments ago). */
  run: AlertRunSummary | null;
  skipped: "recent_run" | null;
}

export type PaymentAlertsResponse = AlertsListResponse | AlertUpdateResponse | AlertsRunResponse;

// ---------------------------------------------------------------------------
// Errors (mapped by paymentHealthErrorResponse)
// ---------------------------------------------------------------------------

/** alerts_run inside ALERTS_RUN_MIN_INTERVAL_SECONDS of the last run (429 rate_limited). */
export class PaymentAlertsRateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`An alert run started less than ${ALERTS_RUN_MIN_INTERVAL_SECONDS / 60} minutes ago; retry in ${retryAfterSeconds} s.`);
    this.name = "PaymentAlertsRateLimitedError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** An alert id that does not exist for the workspace — or that the caller may not see (404 alert_not_found). */
export class PaymentAlertNotFoundError extends Error {
  constructor() {
    super("Alert not found.");
    this.name = "PaymentAlertNotFoundError";
  }
}

/** A status change the transition table does not allow (400 invalid_transition). */
export class PaymentAlertTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`An alert cannot move from ${from} to ${to}.`);
    this.name = "PaymentAlertTransitionError";
    this.from = from;
    this.to = to;
  }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/** The condition's identity across windows: rule + scope (labels never enter it, only opaque keys). */
export function alertScopeKey(scope: AlertScope): string {
  if (scope.kind === "account") {
    const parts = ["account", scope.processor?.key ?? "", scope.merchant_account?.key ?? ALL_ACCOUNTS_SCOPE_SEGMENT];
    if (scope.initiation) parts.push(scope.initiation);
    return parts.join(":");
  }
  const parts = ["tenant", scope.subject ?? "all"];
  if (scope.initiation) parts.push(scope.initiation);
  return parts.join(":");
}

/** Deterministic: the same rule, scope and window end always give the same key (dedup of a daily re-run). */
export function alertKeyOf(ruleKey: AlertRuleKey, scopeKey: string, windowEnd: string): string {
  return `${ruleKey}|${scopeKey}|${windowEnd}`;
}

export function isPspScopedAlert(scope: AlertScope | null | undefined): boolean {
  return scope?.kind === "account";
}
