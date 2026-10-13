// Pure view-model helpers of the Alerts tab (no React): labels, value and
// change formatting by unit, scope labels, the flag list of a row, typed
// readers for the stored evidence JSON, the status buttons a transition table
// allows, and the error copy of the two mutations. Kept out of AlertsTab.tsx so
// fast refresh keeps working and the tests pin the rules without rendering.
//
// The rules held here (plan P, Q, X):
//   * a low-confidence alert is shown as info, whatever its stored severity
//     (the contract and a check constraint say so; the UI holds the line too);
//   * the evidence is read field by field through known keys and never dumped:
//     a field the renderer does not know never reaches the screen;
//   * issuer fraud-suspicion alerts are declines (the issuers' codes), never fraud;
//   * a recommendation text the plan Q ban flags is withheld, not shown (the
//     engine refuses such texts already; this is defence in depth).

import {
  ALERT_RULE_META,
  ALERT_STATUS_TRANSITIONS,
  type AlertHistoryEntry,
  type AlertRuleKey,
  type AlertRunSummary,
  type AlertScope,
  type AlertSeverity,
  type AlertStatus,
  type AlertUnit,
  type PaymentRiskAlert,
} from "../../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract";
import { forbiddenRecommendationHits } from "../../../supabase/functions/_shared/clickhouse/paymentRiskRecommendations";
import type { SignificanceReason } from "../../../supabase/functions/_shared/clickhouse/paymentHealthMetrics";
import type { PaymentHealthError } from "@/services/paymentHealthDataSource";
import { SIGNIFICANCE_LABELS, fmtCountDelta, fmtDateTime, fmtNum, fmtPct, fmtPoints, titleCase } from "./format";

/** The privileged key behind the status buttons and "Run checks now" (the policy's PAYMENT_HEALTH_MANAGE_ALERTS; a test pins the two). */
export const MANAGE_ALERTS_PERMISSION = "payment_health.manage_alerts";

export const SEVERITY_LABELS: Readonly<Record<AlertSeverity, string>> ={ critical: "Critical", warning: "Warning", info: "Info" };
export const STATUS_LABELS: Readonly<Record<AlertStatus, string>> = { new: "New", investigating: "Investigating", resolved: "Resolved", dismissed: "Dismissed" };

/** Low confidence is always info: a stored warning / critical with low confidence never renders as one. */
export function displaySeverity(alert: Pick<PaymentRiskAlert, "severity" | "data_confidence">): AlertSeverity {
  return alert.data_confidence === "low" ? "info" : alert.severity;
}

export function ruleTitle(ruleKey: string): string {
  return ALERT_RULE_META[ruleKey as AlertRuleKey]?.title ?? titleCase(ruleKey);
}

/** One line under the rule title where the rule's meaning is easy to misread. */
export const RULE_CAPTIONS: Readonly<Partial<Record<AlertRuleKey, string>>> = {
  issuer_fraud_rise: "issuer suspicion codes — declines, not confirmed fraud",
  post_ban_retries: "network re-attempt rules unverified (secondary sources)",
  excessive_reattempts: "network re-attempt rules unverified (secondary sources)",
};

const SUBJECT_LABELS: Readonly<Record<string, string>> = {
  unrouted_and_integration: "Integration + unrouted declines, all attempts",
  post_ban: "Re-attempts after a do-not-retry decline",
  rolling: "Card × merchant account pairs",
  data_through: "Newest attempt day",
  warehouse_sync: "ClickHouse sync",
  support_sync: "Support requests sync",
};

const INITIATION_LABELS: Readonly<Record<string, string>> = { cit: "CIT", mit: "MIT" };

/** What the alert is about, from registry labels only (the opaque keys stay out of the text). */
export function scopeLabels(scope: AlertScope | null | undefined): { primary: string; details: string[]; unlabelled: boolean } {
  const details: string[] = [];
  if (scope?.kind === "account") {
    const account = scope.merchant_account;
    if (scope.processor?.label) details.push(scope.processor.label);
    if (scope.initiation) details.push(INITIATION_LABELS[scope.initiation] ?? scope.initiation);
    // approval_drop's PSP-wide line names the processor only: every merchant account of it together.
    if (!account && scope.processor?.label) return { primary: "All merchant accounts", details, unlabelled: false };
    return { primary: account?.label || "Unknown account", details, unlabelled: account != null && account.labelled === false };
  }
  if (scope?.subject) details.push(SUBJECT_LABELS[scope.subject] ?? titleCase(scope.subject));
  if (scope?.initiation) details.push(INITIATION_LABELS[scope.initiation] ?? scope.initiation);
  return { primary: "Whole workspace", details, unlabelled: false };
}

/** A value in its unit: a rate is a fraction (two decimals: these rates are often a few percent). */
export function fmtAlertValue(unit: AlertUnit, value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (unit === "rate") return fmtPct(value, 2);
  if (unit === "days") return `${fmtNum(value)} d`;
  if (unit === "hours") return `${(Math.round(value * 10) / 10).toLocaleString("en-US")} h`;
  return fmtNum(value);
}

/** change_value: percentage points for a rate, the difference otherwise. */
export function fmtAlertChange(unit: AlertUnit, change: number | null | undefined): string {
  if (change == null || !Number.isFinite(change)) return "—";
  return unit === "rate" ? fmtPoints(change, 2) : fmtCountDelta(change);
}

// ---- evidence readers -------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const numberOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const textOf = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

/** The short flags of a row, in display order. */
export function alertFlags(alert: Pick<PaymentRiskAlert, "data_confidence" | "evidence">): string[] {
  const evidence = isRecord(alert.evidence) ? alert.evidence : {};
  const flags: string[] = [];
  if (alert.data_confidence === "low") flags.push("low confidence");
  if (evidence.significant === true) flags.push("significant");
  const small = isRecord(evidence.small_sample) ? evidence.small_sample : {};
  if (small.current === true || small.baseline === true) flags.push("small sample");
  if (evidence.immature_window === true) flags.push("incomplete window");
  if (evidence.incomplete === true || evidence.attempt_rows_capped === true) flags.push("partial read");
  return flags;
}

export interface RateSide {
  from: string | null;
  to: string | null;
  numerator: number | null;
  denominator: number | null;
  rate: number | null;
  interval: { low: number; high: number } | null;
}

export interface RateEvidence {
  current: RateSide;
  baseline: RateSide;
  deltaPoints: number | null;
  significant: boolean;
  significanceText: string;
  minSample: number | null;
  minSampleInfo: number | null;
  thresholds: { warning: number; critical: number } | null;
  dataThrough: string | null;
  maturityDays: number | null;
  maturityBasis: string | null;
  /** unauthorized_complaints_rise: the newest received day of the support data (the comparison is low confidence before it reaches the window's end). */
  supportThrough: string | null;
  /** psp_integration_rise, tenant line: the two parts of the numerator. */
  parts: { current: { integration: number; unverified: number }; baseline: { integration: number; unverified: number } } | null;
}

function sideOf(value: unknown): RateSide {
  const side = isRecord(value) ? value : {};
  const interval = isRecord(side.interval) && numberOf(side.interval.low) != null && numberOf(side.interval.high) != null
    ? { low: side.interval.low as number, high: side.interval.high as number }
    : null;
  return { from: textOf(side.from), to: textOf(side.to), numerator: numberOf(side.numerator), denominator: numberOf(side.denominator), rate: numberOf(side.rate), interval };
}

function thresholdsOf(value: unknown): { warning: number; critical: number } | null {
  if (!isRecord(value)) return null;
  const warning = numberOf(value.warning);
  const critical = numberOf(value.critical);
  return warning == null || critical == null ? null : { warning, critical };
}

/** The rate rules' evidence (current vs previous window), or null for a count rule. */
export function rateEvidence(evidence: unknown): RateEvidence | null {
  if (!isRecord(evidence) || !isRecord(evidence.current) || !isRecord(evidence.baseline)) return null;
  const reason = textOf(evidence.significance_reason) as SignificanceReason | null;
  const parts = isRecord(evidence.parts) && isRecord(evidence.parts.current) && isRecord(evidence.parts.baseline)
    ? {
      current: { integration: numberOf(evidence.parts.current.psp_integration) ?? 0, unverified: numberOf(evidence.parts.current.cause_unverified) ?? 0 },
      baseline: { integration: numberOf(evidence.parts.baseline.psp_integration) ?? 0, unverified: numberOf(evidence.parts.baseline.cause_unverified) ?? 0 },
    }
    : null;
  return {
    current: sideOf(evidence.current),
    baseline: sideOf(evidence.baseline),
    deltaPoints: numberOf(evidence.delta_points),
    significant: evidence.significant === true,
    significanceText: reason ? SIGNIFICANCE_LABELS[reason] ?? reason : "—",
    minSample: numberOf(evidence.min_sample),
    minSampleInfo: numberOf(evidence.min_sample_info),
    thresholds: thresholdsOf(evidence.thresholds),
    dataThrough: textOf(evidence.data_through),
    maturityDays: numberOf(evidence.maturity_days),
    maturityBasis: textOf(evidence.maturity_basis),
    supportThrough: textOf(evidence.support_through),
    parts,
  };
}

/** What the numerator and the denominator of a rate rule count. */
export function rateParts(ruleKey: AlertRuleKey, scope: AlertScope | null | undefined): { numerator: string; denominator: string } {
  switch (ruleKey) {
    case "approval_drop":
      return { numerator: "Settled", denominator: "Attempts" };
    case "issuer_fraud_rise":
      return { numerator: "Issuer suspicion declines", denominator: "Attempts" };
    case "psp_integration_rise":
      return scope?.kind === "tenant" ? { numerator: "Integration + unrouted declines", denominator: "All attempts" } : { numerator: "Integration declines", denominator: "Attempts" };
    case "unauthorized_complaints_rise":
      return { numerator: "Unauthorized-charge complaints", denominator: "Settled payments" };
    case "refund_rate_rise":
      return { numerator: "Refunded", denominator: "Settled payments" };
    default:
      return { numerator: "Count", denominator: "Base" };
  }
}

const yesNo = (value: unknown, no: string): string | null => (value === true ? "yes" : value === false ? no : null);

/** The count / freshness rules' evidence as label → value rows (known fields only, in a fixed order). */
export function countEvidenceRows(alert: Pick<PaymentRiskAlert, "rule_key" | "unit" | "evidence">): Array<{ label: string; value: string }> {
  const evidence = isRecord(alert.evidence) ? alert.evidence : {};
  const rows: Array<{ label: string; value: string | null }> = [];
  const num = (key: string) => (numberOf(evidence[key]) == null ? null : fmtNum(numberOf(evidence[key])));
  const window = isRecord(evidence.window) ? `${textOf(evidence.window.from) ?? "—"} – ${textOf(evidence.window.to) ?? "—"}` : null;
  if (alert.rule_key === "post_ban_retries") {
    rows.push(
      { label: "Re-attempts after a ban", value: num("count") },
      { label: "Window", value: window },
      { label: "Banned cards (both initiations)", value: num("banned_instruments") },
      { label: "Re-attempted cards (both initiations)", value: num("retried_instruments") },
      { label: "Settled (all re-attempts)", value: num("succeeded") },
      { label: "After a processor change (all re-attempts)", value: num("after_processor_change") },
      { label: "Rows listed", value: num("listed") },
      { label: "… of which settled", value: num("listed_succeeded") },
      { label: "… after a processor change", value: num("listed_after_processor_change") },
      { label: "… within one hour of the ban", value: num("listed_within_one_hour") },
      { label: "List complete", value: yesNo(evidence.list_complete, "no — the newest rows only") },
      { label: "Attempt rows capped", value: yesNo(evidence.attempt_rows_capped, "no") },
    );
  } else if (alert.rule_key === "excessive_reattempts") {
    const limit = numberOf(evidence.limit);
    const days = numberOf(evidence.rolling_window_days);
    rows.push(
      { label: "Pairs over the limit", value: num("violations") ?? num("count") },
      { label: "Window", value: window },
      { label: "Pairs checked", value: num("pairs") },
      { label: "Limit", value: limit == null ? null : `more than ${fmtNum(limit)} declines in ${days == null ? "a rolling window" : `${fmtNum(days)} rolling days`}` },
      { label: "Most declines on one pair", value: num("max_declines") },
      { label: "List complete", value: yesNo(evidence.list_complete, "no — the newest pairs only") },
      { label: "Attempt rows capped", value: yesNo(evidence.attempt_rows_capped, "no") },
    );
  } else if (alert.rule_key === "data_stale") {
    if (alert.unit === "hours") {
      const support = evidence.stream === "support";
      rows.push(
        { label: support ? "Last support requests sync" : "Last ClickHouse sync", value: textOf(evidence.last_synced_at) ? fmtDateTime(textOf(evidence.last_synced_at)) : null },
        { label: "Age", value: numberOf(evidence.age_hours) == null ? null : fmtAlertValue("hours", numberOf(evidence.age_hours)) },
        { label: "Support requests through", value: support ? textOf(evidence.support_through) : null },
      );
    } else {
      rows.push(
        { label: "Data through", value: textOf(evidence.data_through) ?? "never (no payment rows)" },
        { label: "Today (UTC)", value: textOf(evidence.today) },
        { label: "Lag", value: numberOf(evidence.lag_days) == null ? null : fmtAlertValue("days", numberOf(evidence.lag_days)) },
        { label: "Last import", value: textOf(evidence.last_import_at) ? fmtDateTime(textOf(evidence.last_import_at)) : null },
      );
    }
  }
  const thresholds = thresholdsOf(evidence.thresholds);
  if (thresholds) rows.push({ label: "Thresholds", value: `warning ≥ ${fmtAlertValue(alert.unit === "rate" ? "count" : alert.unit, thresholds.warning)} · critical ≥ ${fmtAlertValue(alert.unit === "rate" ? "count" : alert.unit, thresholds.critical)}` });
  return rows.filter((row): row is { label: string; value: string } => row.value != null);
}

/** evidence.by_account of the retry alerts (present only for a caller with the PSP key): labels and counts. */
export function accountCounts(evidence: unknown): Array<{ label: string; processor: string | null; count: number }> {
  if (!isRecord(evidence) || !Array.isArray(evidence.by_account)) return [];
  return evidence.by_account
    .filter(isRecord)
    .map((entry) => ({
      label: (isRecord(entry.merchant_account) && textOf(entry.merchant_account.label)) || "Unknown account",
      processor: isRecord(entry.processor) ? textOf(entry.processor.label) : null,
      count: numberOf(entry.count) ?? 0,
    }));
}

// ---- recommendations ---------------------------------------------------------------

/** A recommendation text the ban patterns flag is withheld (null). */
export function compliantText(text: string | null | undefined): string | null {
  if (!text) return null;
  return forbiddenRecommendationHits(text).length ? null : text;
}

export function compliantActions(actions: readonly string[] | null | undefined): { shown: string[]; withheld: number } {
  const list = Array.isArray(actions) ? actions.filter((entry) => typeof entry === "string" && entry.trim() !== "") : [];
  const shown = list.filter((entry) => compliantText(entry) != null);
  return { shown, withheld: list.length - shown.length };
}

// ---- statuses ----------------------------------------------------------------------

const ACTION_ORDER: readonly AlertStatus[] = ["investigating", "resolved", "dismissed"];

/** The buttons of an alert in a fixed order: exactly the transitions the contract allows from its status. */
export function statusActions(status: AlertStatus): Array<{ to: AlertStatus; label: string }> {
  const allowed = ALERT_STATUS_TRANSITIONS[status] ?? [];
  return ACTION_ORDER.filter((to) => allowed.includes(to)).map((to) => ({
    to,
    label: to === "investigating" ? (status === "new" ? "Investigating" : "Reopen") : to === "resolved" ? "Resolve" : "Dismiss",
  }));
}

/** Who did it, without an id on screen. */
export function actorText(by: string | null, currentUserId: string | null): string {
  if (by == null) return "the alert engine";
  return currentUserId && by.toLowerCase() === currentUserId.toLowerCase() ? "you" : "a teammate";
}

export function historyText(entry: AlertHistoryEntry, currentUserId: string | null): string {
  const who = actorText(entry.by, currentUserId);
  if (entry.event === "raised") return `Raised by ${who}`;
  if (entry.event === "reopened") return `Reopened by ${who}: the condition returned`;
  if (entry.event === "auto_resolved") return "Resolved automatically: a later check found the condition clear";
  return `${entry.from ? `${STATUS_LABELS[entry.from] ?? entry.from} → ` : ""}${STATUS_LABELS[entry.to] ?? entry.to} by ${who}`;
}

/** The copy of a refused status change or run (the codes of paymentHealthErrorResponse). */
export function alertActionErrorText(error: PaymentHealthError): string {
  switch (error.errorCode) {
    // payment_alerts_claim_run refuses both inside the interval and while another run is still going.
    case "rate_limited":
      return "A check started less than 5 minutes ago or is still running. Try again in a few minutes.";
    case "invalid_transition":
      return "The alert's status changed in the meantime; the list has been refreshed.";
    case "alert_not_found":
      return "This alert is no longer available to you; the list has been refreshed.";
    case "permission_denied":
      return "Changing alerts needs the Manage payment alerts permission.";
    default:
      return error.message;
  }
}

/** When "Run checks now" is allowed again (ms since epoch), or null: one run per interval per workspace, whatever started it. */
export function nextManualRunAt(lastRun: Pick<AlertRunSummary, "started_at"> | null | undefined, intervalSeconds: number): number | null {
  const started = lastRun ? Date.parse(lastRun.started_at) : NaN;
  if (!Number.isFinite(started) || !(intervalSeconds > 0)) return null;
  return started + intervalSeconds * 1000;
}

/** One line about a run: when, how it was started, what it found. */
export function runSummaryText(run: AlertRunSummary): string {
  const started = fmtDateTime(run.started_at);
  const how = run.trigger === "manual" ? "manual" : "scheduled";
  if (run.status === "running") return `A ${how} check is running (started ${started}).`;
  if (run.status === "failed") return `The last ${how} check failed (started ${started}); open alerts stay as they were.`;
  const finished = fmtDateTime(run.finished_at ?? run.started_at);
  const counts = run.counts;
  const found = counts
    ? ` ${fmtNum(counts.candidates)} condition(s) found: ${fmtNum(counts.inserted)} new, ${fmtNum(counts.updated + counts.carried)} refreshed, ${fmtNum(counts.reopened)} reopened, ${fmtNum(counts.auto_resolved)} resolved automatically.`
    : "";
  return `Last ${how} check ${finished}${run.data_through ? `, data through ${run.data_through}` : ""}.${found}`;
}
