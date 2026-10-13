// Synthetic payment risk alerts (P2.5) for the frontend tests, and a small
// in-memory alerts server that answers alerts_list / alert_update / alerts_run
// with the contract's own normalizers, transition table and sort order — so a
// status change made in a test is what the next list shows.
//
// The explanations are the engine's real templates (buildAlertExplanation). The
// sentinels of paymentHealthResponses.ts (a raw MID, a raw descriptor, an
// instrument token, a transaction id, an e-mail) are planted in fields the tab
// must never read — unknown evidence keys, extra scope keys — and member ids /
// opaque account keys sit where the tab must say "you" / "a teammate" or nothing.

import { ClickHouseRequestError } from "@/services/clickhouse";
import {
  ALERT_RULE_META,
  ALERT_SEVERITIES,
  ALERT_STATUSES,
  ALERTS_RUN_MIN_INTERVAL_SECONDS,
  DEFAULT_ALERT_RULES,
  OPEN_ALERT_STATUSES,
  SEVERITY_RANK,
  isAllowedAlertTransition,
  normalizeAlertUpdateRequest,
  normalizeAlertsListRequest,
  type AlertRuleView,
  type AlertRunSummary,
  type AlertSeverity,
  type AlertStatus,
  type AlertsListResponse,
  type PaymentRiskAlert,
} from "../../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract";
import { buildAlertExplanation } from "../../../supabase/functions/_shared/clickhouse/paymentRiskRecommendations";
import { UI_SENTINELS } from "./paymentHealthResponses";

/** The signed-in test user (paymentHealthPage.test.tsx's USER.id) and a teammate. */
export const ME = "user-ph";
export const TEAMMATE = "f00dbabe-0000-4000-8000-00000000beef";
/** An opaque merchant account key: in keys and `read` paths only, never on screen. */
export const OPAQUE_ACCOUNT_KEY = "acct_opaque_key_7731";

export const ALERT_IDS = {
  approval: "aaaa0000-0000-4000-8000-0000000000a1",
  fraudLow: "aaaa0000-0000-4000-8000-0000000000a2",
  postBan: "aaaa0000-0000-4000-8000-0000000000a3",
  stale: "aaaa0000-0000-4000-8000-0000000000a4",
  refundResolved: "aaaa0000-0000-4000-8000-0000000000a5",
  integrationTenant: "aaaa0000-0000-4000-8000-0000000000a6",
} as const;

const STRIPE = { key: "STRIPE", label: "Stripe" };
const MID1 = { key: OPAQUE_ACCOUNT_KEY, label: "Stripe MID #1", processor: "STRIPE", labelled: true };

const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

function rateSide(from: string, to: string, numerator: number, denominator: number) {
  const rate = denominator > 0 ? numerator / denominator : null;
  return { from, to, numerator, denominator, rate, interval: rate == null ? null : { low: Math.max(0, rate - 0.03), high: Math.min(1, rate + 0.03) } };
}

function base(over: Partial<PaymentRiskAlert> & Pick<PaymentRiskAlert, "id" | "rule_key">): PaymentRiskAlert {
  const meta = ALERT_RULE_META[over.rule_key];
  return {
    alert_key: `${over.rule_key}|tenant:all|2026-10-10`,
    scope_key: "tenant:all",
    severity: "warning",
    status: "new",
    scope: { kind: "tenant" },
    affected_funnels: [],
    metric: meta.metric,
    unit: meta.unit,
    current_value: null,
    baseline_value: null,
    change_value: null,
    sample_size: 0,
    data_confidence: "high",
    window_start: "2026-10-04",
    window_end: "2026-10-10",
    evidence: {},
    explanation: { fact: "", likely_explanation: "", hypothesis: "Unverified: n/a", action: [] },
    first_seen_at: "2026-10-11T07:41:00.000Z",
    last_seen_at: "2026-10-12T07:41:00.000Z",
    resolved_at: null,
    auto_resolved: false,
    assignee: null,
    status_history: [{ at: "2026-10-11T07:41:00.000Z", event: "raised", from: null, to: "new", by: null, auto: true, note: null }],
    updated_by: null,
    updated_at: "2026-10-12T07:41:00.000Z",
    psp_scoped: false,
    ...over,
  };
}

/** Critical approval drop on Stripe MID #1, CIT, significant, with funnels and a reproduce of the declines tab. */
export function approvalAlert(over: Partial<PaymentRiskAlert> = {}): PaymentRiskAlert {
  return base({
    id: ALERT_IDS.approval,
    rule_key: "approval_drop",
    alert_key: `approval_drop|account:STRIPE:${OPAQUE_ACCOUNT_KEY}:cit|2026-10-10`,
    scope_key: `account:STRIPE:${OPAQUE_ACCOUNT_KEY}:cit`,
    severity: "critical",
    scope: { kind: "account", processor: STRIPE, merchant_account: { ...MID1, raw_mid: UI_SENTINELS.rawMid } as typeof MID1, initiation: "cit" },
    affected_funnels: ["Astro quiz", "Numerology quiz"],
    current_value: 0.62,
    baseline_value: 0.75,
    change_value: -13,
    sample_size: 1000,
    evidence: {
      unit: "rate",
      direction: "drop",
      current: rateSide("2026-10-04", "2026-10-10", 620, 1000),
      baseline: rateSide("2026-09-27", "2026-10-03", 780, 1040),
      delta_points: -13,
      significant: true,
      significance_reason: "intervals_do_not_overlap",
      small_sample: { current: false, baseline: false },
      immature_window: false,
      min_sample: 200,
      min_sample_info: 50,
      thresholds: { warning: 5, critical: 10, unit: "pp" },
      data_through: "2026-10-10",
      reproduce: {
        action: "declines",
        date_from: "2026-10-04",
        date_to: "2026-10-10",
        filters: { initiation: ["cit"] },
        dimension: "merchant_account",
        read: `by_dimension[value.key=${OPAQUE_ACCOUNT_KEY}].approval`,
      },
      // Fields no renderer knows: must never reach the screen.
      raw_mid: UI_SENTINELS.rawMid,
      descriptor_raw: UI_SENTINELS.rawDescriptor,
      sample_payment: { transaction_id: UI_SENTINELS.transactionId, instrument: UI_SENTINELS.instrumentToken, email: UI_SENTINELS.email },
    },
    explanation: buildAlertExplanation("approval_drop", {
      initiation: "CIT",
      account: "Stripe MID #1 (Stripe)",
      baseline: "75.00%",
      current: "62.00%",
      change: "-13.00",
      window: "2026-10-04 – 2026-10-10",
      baseline_window: "2026-09-27 – 2026-10-03",
      attempts: 1000,
      significance: "The change is outside both 95% Wilson intervals.",
    }),
    psp_scoped: true,
    ...over,
  });
}

/** Issuer fraud-suspicion rise on a small sample: info + low confidence, under investigation by the test user. */
export function fraudLowAlert(over: Partial<PaymentRiskAlert> = {}): PaymentRiskAlert {
  return base({
    id: ALERT_IDS.fraudLow,
    rule_key: "issuer_fraud_rise",
    alert_key: `issuer_fraud_rise|account:STRIPE:${OPAQUE_ACCOUNT_KEY}|2026-10-10`,
    scope_key: `account:STRIPE:${OPAQUE_ACCOUNT_KEY}`,
    severity: "info",
    status: "investigating",
    scope: { kind: "account", processor: STRIPE, merchant_account: MID1 },
    current_value: 0.05,
    baseline_value: 0.0125,
    change_value: 3.75,
    sample_size: 80,
    data_confidence: "low",
    evidence: {
      unit: "rate",
      direction: "rise",
      current: rateSide("2026-10-04", "2026-10-10", 4, 80),
      baseline: rateSide("2026-09-27", "2026-10-03", 1, 80),
      delta_points: 3.75,
      significant: false,
      significance_reason: "small_sample",
      small_sample: { current: true, baseline: true },
      immature_window: false,
      min_sample: 200,
      min_sample_info: 50,
      thresholds: { warning: 1, critical: 2.5, unit: "pp" },
      data_through: "2026-10-10",
      reproduce: { action: "overview", date_from: "2026-10-04", date_to: "2026-10-10", filters: {}, read: `psp_mid_rows[merchant_account.key=${OPAQUE_ACCOUNT_KEY}].issuer_fraud_share` },
    },
    explanation: buildAlertExplanation("issuer_fraud_rise", {
      account: "Stripe MID #1 (Stripe)",
      baseline: "1.25%",
      current: "5.00%",
      change: "+3.75",
      window: "2026-10-04 – 2026-10-10",
      count: 4,
      significance: "Low confidence: fewer than 200 observations in a window, so this is not a significant change yet.",
    }),
    assignee: ME,
    status_history: [
      { at: "2026-10-11T07:41:00.000Z", event: "raised", from: null, to: "new", by: null, auto: true, note: null },
      { at: "2026-10-11T09:00:00.000Z", event: "status", from: "new", to: "investigating", by: ME, auto: false, note: "Checking the funnel mix" },
    ],
    psp_scoped: true,
    ...over,
  });
}

/** MIT re-attempts after a ban (tenant-wide), with the per-account split a PSP-key holder sees. */
export function postBanAlert(over: Partial<PaymentRiskAlert> = {}): PaymentRiskAlert {
  return base({
    id: ALERT_IDS.postBan,
    rule_key: "post_ban_retries",
    alert_key: "post_ban_retries|tenant:post_ban:mit|2026-10-10",
    scope_key: "tenant:post_ban:mit",
    severity: "warning",
    scope: { kind: "tenant", subject: "post_ban", initiation: "mit" },
    unit: "count",
    current_value: 3,
    sample_size: 5000,
    window_start: "2026-09-11",
    window_end: "2026-10-10",
    evidence: {
      unit: "count",
      count: 3,
      incomplete: false,
      thresholds: { warning: 1, critical: 10, unit: "count" },
      window: { from: "2026-09-11", to: "2026-10-10" },
      initiation: "mit",
      banned_instruments: 40,
      retried_instruments: 7,
      listed: 3,
      listed_succeeded: 1,
      listed_after_processor_change: 2,
      listed_within_one_hour: 1,
      list_complete: true,
      attempt_rows_capped: false,
      by_account: [{ processor: STRIPE, merchant_account: { key: OPAQUE_ACCOUNT_KEY, label: "Stripe MID #1" }, count: 3 }],
      data_through: "2026-10-10",
      reproduce: { action: "retries", date_from: "2026-09-11", date_to: "2026-10-10", filters: {}, read: "post_ban.mit" },
      instruments: [UI_SENTINELS.instrumentToken],
    },
    explanation: buildAlertExplanation("post_ban_retries", { count: 3, initiation: "MIT", window: "2026-09-11 – 2026-10-10", succeeded: 1, after_processor_change: 2 }, "mit"),
    ...over,
  });
}

/** Payment data 15 days old: critical. */
export function staleAlert(over: Partial<PaymentRiskAlert> = {}): PaymentRiskAlert {
  return base({
    id: ALERT_IDS.stale,
    rule_key: "data_stale",
    alert_key: "data_stale|tenant:data_through|2026-09-28",
    scope_key: "tenant:data_through",
    severity: "critical",
    scope: { kind: "tenant", subject: "data_through" },
    metric: "data_lag_days",
    unit: "days",
    current_value: 15,
    sample_size: 48210,
    window_start: null,
    window_end: "2026-09-28",
    evidence: {
      unit: "days",
      count: 15,
      incomplete: false,
      thresholds: { warning: 7, critical: 14, unit: "days" },
      data_through: "2026-09-28",
      today: "2026-10-13",
      lag_days: 15,
      last_import_at: "2026-09-28T18:00:00.000Z",
      reproduce: { action: "sources", read: "meta.data_through, meta.lag_days" },
    },
    explanation: buildAlertExplanation("data_stale", { data_through: "2026-09-28", lag_days: 15 }),
    ...over,
  });
}

/** A refund alert the engine resolved by itself (closed: not in the open list). */
export function refundResolvedAlert(over: Partial<PaymentRiskAlert> = {}): PaymentRiskAlert {
  return base({
    id: ALERT_IDS.refundResolved,
    rule_key: "refund_rate_rise",
    alert_key: `refund_rate_rise|account:STRIPE:${OPAQUE_ACCOUNT_KEY}|2026-09-10`,
    scope_key: `account:STRIPE:${OPAQUE_ACCOUNT_KEY}`,
    severity: "warning",
    status: "resolved",
    scope: { kind: "account", processor: STRIPE, merchant_account: MID1 },
    current_value: 0.04,
    baseline_value: 0.02,
    change_value: 2,
    sample_size: 900,
    window_start: "2026-09-04",
    window_end: "2026-09-10",
    evidence: {
      unit: "rate",
      direction: "rise",
      current: rateSide("2026-09-04", "2026-09-10", 36, 900),
      baseline: rateSide("2026-08-28", "2026-09-03", 18, 900),
      delta_points: 2,
      significant: true,
      significance_reason: "intervals_do_not_overlap",
      small_sample: { current: false, baseline: false },
      immature_window: false,
      min_sample: 200,
      thresholds: { warning: 1, critical: 2.5, unit: "pp" },
      data_through: "2026-10-10",
      maturity_days: 30,
      maturity_basis: "original_payment",
      reproduce: { action: "overview", date_from: "2026-09-04", date_to: "2026-09-10", filters: {}, read: "psp_mid_rows[...].refund_rate" },
    },
    explanation: buildAlertExplanation("refund_rate_rise", { account: "Stripe MID #1 (Stripe)", baseline: "2.00%", current: "4.00%", change: "+2.00", window: "2026-09-04 – 2026-09-10", maturity_days: 30 }),
    resolved_at: "2026-10-12T07:41:00.000Z",
    auto_resolved: true,
    status_history: [
      { at: "2026-10-11T07:41:00.000Z", event: "raised", from: null, to: "new", by: null, auto: true, note: null },
      { at: "2026-10-11T08:00:00.000Z", event: "status", from: "new", to: "investigating", by: TEAMMATE, auto: false, note: null },
      { at: "2026-10-12T07:41:00.000Z", event: "auto_resolved", from: "investigating", to: "resolved", by: null, auto: true, note: null },
    ],
    assignee: TEAMMATE,
    psp_scoped: true,
    ...over,
  });
}

/** The tenant line of psp_integration_rise (not PSP-scoped). */
export function integrationTenantAlert(over: Partial<PaymentRiskAlert> = {}): PaymentRiskAlert {
  return base({
    id: ALERT_IDS.integrationTenant,
    rule_key: "psp_integration_rise",
    alert_key: "psp_integration_rise|tenant:unrouted_and_integration|2026-10-10",
    scope_key: "tenant:unrouted_and_integration",
    severity: "warning",
    scope: { kind: "tenant", subject: "unrouted_and_integration" },
    current_value: 0.03,
    baseline_value: 0.01,
    change_value: 2,
    sample_size: 4000,
    evidence: {
      unit: "rate",
      direction: "rise",
      current: rateSide("2026-10-04", "2026-10-10", 120, 4000),
      baseline: rateSide("2026-09-27", "2026-10-03", 40, 4000),
      delta_points: 2,
      significant: true,
      significance_reason: "intervals_do_not_overlap",
      small_sample: { current: false, baseline: false },
      immature_window: false,
      min_sample: 200,
      thresholds: { warning: 1, critical: 3, unit: "pp" },
      data_through: "2026-10-10",
      parts: { current: { psp_integration: 70, cause_unverified: 50 }, baseline: { psp_integration: 25, cause_unverified: 15 } },
      reproduce: { action: "overview", date_from: "2026-10-04", date_to: "2026-10-10", filters: {}, read: "totals.current.psp_integration_declines" },
    },
    explanation: buildAlertExplanation("psp_integration_rise", { baseline: "1.00%", current: "3.00%", change: "+2.00", window: "2026-10-04 – 2026-10-10", count: 120, significance: "The change is outside both 95% Wilson intervals." }, "tenant"),
    ...over,
  });
}

export function defaultAlerts(): PaymentRiskAlert[] {
  return [approvalAlert(), fraudLowAlert(), postBanAlert(), staleAlert(), refundResolvedAlert(), integrationTenantAlert()];
}

export function ruleViews(): AlertRuleView[] {
  return DEFAULT_ALERT_RULES.map((rule) => ({
    rule_key: rule.rule_key,
    title: ALERT_RULE_META[rule.rule_key].title,
    enabled: rule.enabled,
    severity_warning: rule.severity_warning,
    severity_critical: rule.severity_critical,
    min_sample: rule.min_sample,
    window_days: rule.window_days,
    metric: ALERT_RULE_META[rule.rule_key].metric,
    unit: ALERT_RULE_META[rule.rule_key].unit,
    psp_scoped: ALERT_RULE_META[rule.rule_key].psp_scoped,
    description: rule.description,
  }));
}

/** A succeeded scheduled run `daysAgo` days ago (outside the manual-run interval unless 0). */
export function runSummary(over: Partial<AlertRunSummary> & { startedAt?: string } = {}): AlertRunSummary {
  const started = over.startedAt ?? daysAgoIso(1);
  const { startedAt: _ignored, ...rest } = over;
  return {
    run_id: "run-0001",
    trigger: "cron",
    started_at: started,
    finished_at: new Date(Date.parse(started) + 90_000).toISOString(),
    status: "succeeded",
    data_through: "2026-10-10",
    windows: { approval_drop: { from: "2026-10-04", to: "2026-10-10" } },
    rules: DEFAULT_ALERT_RULES.map((rule) => ({ rule_key: rule.rule_key, status: "evaluated" as const, reason: null, candidates: 1, cleared: 2, inconclusive: 0 })),
    counts: { candidates: 5, by_severity: { info: 1, warning: 2, critical: 2 }, inserted: 2, updated: 2, carried: 1, reopened: 0, suppressed: 0, auto_resolved: 1 },
    ...rest,
  };
}

const sortAlerts = (alerts: PaymentRiskAlert[]) =>
  alerts.slice().sort((a, b) =>
    Number(OPEN_ALERT_STATUSES.includes(b.status)) - Number(OPEN_ALERT_STATUSES.includes(a.status))
    || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    || (a.last_seen_at < b.last_seen_at ? 1 : a.last_seen_at > b.last_seen_at ? -1 : 0)
    || a.alert_key.localeCompare(b.alert_key));

/** An alerts_list response over `alerts` (already filtered), with the counts the server computes. */
export function alertsListResponse(alerts: PaymentRiskAlert[], over: { pspVisible?: boolean; canManage?: boolean; lastRun?: AlertRunSummary | null; hidden?: number; limited?: boolean; filters?: AlertsListResponse["meta"]["filters"] } = {}): AlertsListResponse {
  const sorted = sortAlerts(alerts);
  const byStatus = Object.fromEntries(ALERT_STATUSES.map((status) => [status, 0])) as Record<AlertStatus, number>;
  const openBySeverity = Object.fromEntries(ALERT_SEVERITIES.map((severity) => [severity, 0])) as Record<AlertSeverity, number>;
  for (const alert of sorted) {
    byStatus[alert.status] += 1;
    if (OPEN_ALERT_STATUSES.includes(alert.status)) openBySeverity[alert.severity] += 1;
  }
  return {
    ok: true,
    action: "alerts_list",
    alerts: sorted,
    counts: { total: sorted.length, open: byStatus.new + byStatus.investigating, by_status: byStatus, open_by_severity: openBySeverity },
    hidden_psp_scoped: over.hidden ?? 0,
    last_run: over.lastRun === undefined ? runSummary() : over.lastRun,
    rules: ruleViews(),
    meta: {
      generated_at: "2026-10-13T08:00:00.000Z",
      psp_global_visible: over.pspVisible ?? true,
      can_manage: over.canManage ?? true,
      filters: over.filters ?? { status: [], severity: [], rule: [] },
      limit: 100,
      limited: over.limited ?? false,
      run_min_interval_seconds: ALERTS_RUN_MIN_INTERVAL_SECONDS,
    },
  };
}

const edgeError = (status: number, code: string, message: string) => new ClickHouseRequestError(`ClickHouse Edge Function failed: ${message}`, { status, errorCode: code, requestId: `req-${code}` });

export interface AlertsServer {
  handle: (body: Record<string, unknown>) => Promise<unknown>;
  store: PaymentRiskAlert[];
  calls: Array<Record<string, unknown>>;
  callsFor: (action: string) => Array<Record<string, unknown>>;
  /** The next alert_update / alerts_run answers with this error instead. */
  failNext: (action: "alert_update" | "alerts_run", error: Error) => void;
  lastRun: () => AlertRunSummary | null;
}

/**
 * The alert actions over an in-memory store, as the Edge function answers them:
 * the contract normalizers (a malformed body is a 400), the transition table
 * (400 invalid_transition), PSP-scoped alerts left out and counted without the
 * PSP key (and by_account stripped), the investigating → assignee rule, the
 * 5-minute run interval (429).
 */
export function createAlertsServer(initial: PaymentRiskAlert[] = defaultAlerts(), options: { pspVisible?: boolean; canManage?: boolean; lastRun?: AlertRunSummary | null; actor?: string } = {}): AlertsServer {
  const store = initial.map((alert) => structuredClone(alert));
  const calls: Array<Record<string, unknown>> = [];
  const failures = new Map<string, Error>();
  const pspVisible = options.pspVisible ?? true;
  const actor = options.actor ?? ME;
  let lastRun: AlertRunSummary | null = options.lastRun === undefined ? runSummary() : options.lastRun;

  const project = (alert: PaymentRiskAlert): PaymentRiskAlert => {
    const copy = structuredClone(alert);
    if (!pspVisible) delete (copy.evidence as Record<string, unknown>).by_account;
    return copy;
  };

  async function handle(body: Record<string, unknown>): Promise<unknown> {
    calls.push(structuredClone(body));
    const action = body.action;
    const failure = typeof action === "string" ? failures.get(action) : undefined;
    if (failure && typeof action === "string") {
      failures.delete(action);
      throw failure;
    }
    if (action === "alerts_list") {
      let req;
      try {
        req = normalizeAlertsListRequest(body);
      } catch (error) {
        throw edgeError(400, "invalid_request", (error as Error).message);
      }
      const matching = store.filter((alert) =>
        (!req.status.length || req.status.includes(alert.status))
        && (!req.severity.length || req.severity.includes(alert.severity))
        && (!req.rule.length || req.rule.includes(alert.rule_key)));
      const visible = matching.filter((alert) => pspVisible || !alert.psp_scoped);
      return alertsListResponse(visible.map(project), {
        pspVisible,
        canManage: options.canManage ?? true,
        lastRun,
        hidden: matching.length - visible.length,
        filters: { status: req.status, severity: req.severity, rule: req.rule },
      });
    }
    if (action === "alert_update") {
      let req;
      try {
        req = normalizeAlertUpdateRequest(body);
      } catch (error) {
        throw edgeError(400, "invalid_request", (error as Error).message);
      }
      const alert = store.find((entry) => entry.id === req.alert_id);
      if (!alert || (alert.psp_scoped && !pspVisible)) throw edgeError(404, "alert_not_found", "Alert not found.");
      if (!isAllowedAlertTransition(alert.status, req.status)) throw edgeError(400, "invalid_transition", `An alert cannot move from ${alert.status} to ${req.status}.`);
      const at = new Date().toISOString();
      alert.status_history = [...alert.status_history, { at, event: "status", from: alert.status, to: req.status, by: actor, auto: false, note: req.note }];
      if (req.status === "investigating" && !alert.assignee) alert.assignee = actor;
      alert.resolved_at = req.status === "resolved" ? at : null;
      alert.auto_resolved = false;
      alert.status = req.status;
      alert.updated_by = actor;
      alert.updated_at = at;
      return { ok: true, action: "alert_update", alert: project(alert) };
    }
    if (action === "alerts_run") {
      if (lastRun && Date.now() - Date.parse(lastRun.started_at) < ALERTS_RUN_MIN_INTERVAL_SECONDS * 1000) {
        throw edgeError(429, "rate_limited", "An alert run started less than 5 minutes ago.");
      }
      lastRun = runSummary({ run_id: `run-${calls.length}`, trigger: "manual", startedAt: new Date().toISOString() });
      return { ok: true, action: "alerts_run", run: lastRun, skipped: null };
    }
    throw edgeError(400, "unknown_action", "unknown_action");
  }

  return {
    handle,
    store,
    calls,
    callsFor: (action) => calls.filter((body) => body.action === action),
    failNext: (action, error) => failures.set(action, error),
    lastRun: () => lastRun,
  };
}

export { edgeError as alertsEdgeError };
