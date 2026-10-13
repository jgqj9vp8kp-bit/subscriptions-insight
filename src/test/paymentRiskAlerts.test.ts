// Payment System Health P2.5: the alert engine (paymentRiskAlerts.ts), its
// recommendation library (paymentRiskRecommendations.ts) and contract
// (paymentRiskAlertsContract.ts). Plan sections P, Q, X, N.
//
// Covers:
//   * the recommendation ban (plan Q "Никогда"): no template of any rule or
//     variant suggests rerouting / splitting / moving volume between MIDs,
//     descriptors or PSPs, evading monitoring or lowering authentication — and
//     the patterns themselves flag known-bad phrasings, so the ban cannot rot;
//   * each rule fires / does not fire on hand-built runner answers, with the
//     plan P rules: Wilson significance with the rule's min_sample, a sample
//     under min_sample_info is not looked at, a small sample or an immature
//     window gives `info` + data_confidence `low` (never warning / critical);
//   * the windows are whole days ending the day before data_through (7 vs 7
//     days, retries over 30 days, the newest MATURE window for refunds) and
//     the plan of runner requests;
//   * deterministic alert keys (dedup), cleared conditions (auto-resolve);
//   * the whole engine over the semantic fixture warehouse (the runner's real
//     SQL): what it raises, that every statement binds the workspace tenant and
//     that no sentinel (raw MID, descriptor, instrument, e-mail, transaction id)
//     reaches an alert;
//   * end to end with the 202610130001 SQL functions on PGlite: a re-run over
//     the same window deduplicates by alert_key, a later run whose condition no
//     longer holds auto-resolves the open alert (not while the support data
//     lags), a rate-limited run is refused; an above-threshold move that is not
//     significant leaves an investigating alert alone (hysteresis); a violator
//     cut from the rolling list is not suppressed by older dismissed evidence.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FORBIDDEN_RECOMMENDATION_PATTERNS,
  RECOMMENDATIONS,
  buildAlertExplanation,
  forbiddenRecommendationHits,
  recommendationTexts,
} from "../../supabase/functions/_shared/clickhouse/paymentRiskRecommendations.ts";
import {
  ALERT_RULE_KEYS,
  ALERT_STATUS_TRANSITIONS,
  ALERT_STATUSES,
  ALERT_WINDOW_END_LAG_DAYS,
  DEFAULT_ALERT_RULES,
  PaymentAlertsRateLimitedError,
  alertKeyOf,
  alertScopeKey,
  isAllowedAlertTransition,
  normalizeAlertUpdateRequest,
  normalizeAlertsListRequest,
  type AlertRuleConfig,
  type AlertRuleKey,
} from "../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract.ts";
import {
  affectedFunnels,
  aliasScopeKey,
  approvalProcessorRequestKey,
  approvalRequestKey,
  evaluateAlertRules,
  evaluateRate,
  evaluateWorkspaceAlerts,
  funnelLookupRequest,
  overviewRequestKey,
  planAlertRequests,
  registeredAccountAliases,
  retriesRequestKey,
  ruleWindow,
  runPaymentRiskAlerts,
  SOURCES_REQUEST_KEY,
  type AlertCandidate,
  type AlertDataSet,
  type AlertEvaluation,
} from "../../supabase/functions/_shared/clickhouse/paymentRiskAlerts.ts";
import { loadDimensionRegistry, resetPaymentHealthMemo } from "../../supabase/functions/_shared/clickhouse/paymentHealth.ts";
import { PaymentHealthRequestError, type BreakdownRow } from "../../supabase/functions/_shared/clickhouse/paymentHealthContract.ts";
import { createRecordingClickHouse } from "./support/recordingClickHouse";
import { createStrictFakeSupabase } from "./support/strictFakeSupabase";
import { scanForLeaks } from "./support/leakScan";
import { createSupabasePglite, listMigrations, readMigration, type SupabasePglite } from "./support/pgliteSupabase";
import { PH_DATA_KEY, PH_SENTINELS, T, asPg, fixtureAccounts, fixtureWarehouse, tx, type FixtureSupport, type FixtureTx } from "./support/paymentHealthFixtures";

const RULES: AlertRuleConfig[] = DEFAULT_ALERT_RULES.map((rule) => ({ ...rule, params: { ...rule.params } }));
const rule = (key: AlertRuleKey, overrides: Partial<AlertRuleConfig> = {}): AlertRuleConfig => ({ ...(RULES.find((entry) => entry.rule_key === key) as AlertRuleConfig), ...overrides });

// =====================================================================================
// 1. The recommendation ban
// =====================================================================================

describe("recommendation library: the plan Q ban", () => {
  it("covers every rule, and every template text of every variant is compliant", () => {
    expect(Object.keys(RECOMMENDATIONS).sort()).toEqual([...ALERT_RULE_KEYS].sort());
    const texts = recommendationTexts();
    expect(texts.length).toBeGreaterThan(50);
    const offenders = texts.map(({ where, text }) => ({ where, hits: forbiddenRecommendationHits(text) })).filter((entry) => entry.hits.length);
    expect(offenders).toEqual([]);
  });

  it("flags every known-bad phrasing: rerouting, splitting or moving volume across MIDs / descriptors / PSPs, evading monitoring, lowering authentication", () => {
    const bad = [
      "Route part of the volume to MID #2.",
      "Reroute the declined renewals through Adyen.",
      "Split the volume across two descriptors.",
      "Spread transactions over several merchant accounts to stay below the VAMP threshold.",
      "Distribute the traffic between PSPs.",
      "Use load balancing between the processors.",
      "Move traffic to Adyen until the ratio recovers.",
      "Shift the MIT volume to the other MID.",
      "Open a new merchant account for the risky funnel.",
      "Add a second descriptor for the upsell.",
      "Switch to another PSP.",
      "Cascade the declined attempts to a backup processor.",
      "Fall back to Stripe when Adyen declines.",
      "Keep each account under the threshold.",
      "Avoid the monitoring program by keeping counts low.",
      "Rotate descriptors every month.",
      "Disable 3DS to raise approval.",
      "Request SCA exemptions for renewals.",
      "Skip authentication on low-value payments.",
      "Use frictionless flows to reduce challenges.",
      "Add micro transactions to dilute the dispute ratio.",
      "Create artificial settled payments.",
      "Hide the merchant behind a generic descriptor.",
      "Change the MCC to a lower-risk category.",
      "Retry the card after the do-not-retry decline on another processor.",
    ];
    for (const phrase of bad) expect(forbiddenRecommendationHits(phrase), phrase).not.toEqual([]);
    // ...while the lawful actions of plan Q pass.
    for (const phrase of [
      "Make the billing descriptor clear and recognisable: one static prefix with the brand name.",
      "Apply 3DS where the issuer requires it.",
      "Stop every re-attempt on a card after a do-not-retry decline.",
      "Refund quickly on request, before the customer goes to the bank.",
      "Keep cancellation simple.",
      "Review traffic quality for the affected funnels.",
      "After a hard decline at checkout, ask the customer for another payment method instead of resubmitting the same card.",
    ]) {
      expect(forbiddenRecommendationHits(phrase), phrase).toEqual([]);
    }
    expect(FORBIDDEN_RECOMMENDATION_PATTERNS.length).toBeGreaterThan(20);
  });

  it("every explanation is fact → likely explanation → unverified hypothesis → compliant actions, and a filled one is compliant too", () => {
    const facts = {
      account: "Stripe MID #1 (Stripe)", initiation: "CIT (customer-initiated)", window: "2026-09-24 to 2026-09-30", baseline_window: "2026-09-17 to 2026-09-23",
      current: "50.0%", baseline: "70.0%", change: "-20.0", count: 12, attempts: 300, settled: 240, significance: "The change is outside both 95% Wilson intervals.",
      succeeded: 1, after_processor_change: 1, limit: 15, rolling_days: 30, max_declines: 17, maturity_days: 30, data_through: "2026-09-30", lag_days: 9, sync_hours: 80, last_synced_at: "2026-10-01T00:00:00.000Z",
    };
    for (const key of ALERT_RULE_KEYS) {
      const variants = [null, ...Object.keys(RECOMMENDATIONS[key].variants ?? {})];
      for (const variant of variants) {
        const explanation = buildAlertExplanation(key, facts, variant);
        expect(explanation.fact, `${key}.${variant}`).not.toMatch(/\{\w+\}/);
        expect(explanation.hypothesis.startsWith("Unverified"), `${key}.${variant}`).toBe(true);
        expect(explanation.action.length, `${key}.${variant}`).toBeGreaterThan(0);
        for (const text of [explanation.fact, explanation.likely_explanation, explanation.hypothesis, ...explanation.action]) {
          expect(forbiddenRecommendationHits(text), `${key}.${variant}: ${text}`).toEqual([]);
        }
      }
    }
    // Declines are never called fraud; the retry rules name the network codes and stay "unverified".
    expect(RECOMMENDATIONS.issuer_fraud_rise.default.fact).toContain("not confirmed fraud");
    expect(RECOMMENDATIONS.post_ban_retries.default.action.join(" ")).toMatch(/Visa category 1, Mastercard MAC 03 \/ 21/);
    expect(RECOMMENDATIONS.excessive_reattempts.default.action.join(" ")).toMatch(/at most 15 in 30 days/);
    expect(RECOMMENDATIONS.unauthorized_complaints_rise.default.action.join(" ")).toMatch(/static prefix[\s\S]*cancel[\s\S]*before the customer goes to the bank/);
    expect(RECOMMENDATIONS.approval_drop.default.action.join(" ")).toMatch(/3DS where the issuer requires it/);
  });
});

// =====================================================================================
// 2. Contract: transitions, keys, request normalizers
// =====================================================================================

describe("contract", () => {
  it("the transition table: acknowledge / resolve / dismiss from new, resolve / dismiss from investigating, reopen closed ones; no same-status move", () => {
    expect(ALERT_STATUS_TRANSITIONS).toEqual({
      new: ["investigating", "resolved", "dismissed"],
      investigating: ["resolved", "dismissed"],
      resolved: ["investigating"],
      dismissed: ["investigating"],
    });
    for (const status of ALERT_STATUSES) expect(isAllowedAlertTransition(status, status)).toBe(false);
    expect(isAllowedAlertTransition("dismissed", "resolved")).toBe(false);
  });

  it("the SQL function holds the same transition table", () => {
    const sql = readMigration("202610130001_payment_health_alerts.sql");
    const block = sql.slice(sql.indexOf("v_allowed := case v_alert.status"), sql.indexOf("else array[]::text[]"));
    for (const [from, targets] of Object.entries(ALERT_STATUS_TRANSITIONS)) {
      expect(block).toContain(`when '${from}' then array[${targets.map((target) => `'${target}'`).join(", ")}]`);
    }
  });

  it("alert keys are deterministic: rule | scope | window_end, opaque keys only", () => {
    const scope = { kind: "account" as const, processor: { key: "STRIPE", label: "Stripe" }, merchant_account: { key: "aaaa0000-0000-4000-8000-00000000a001", label: "Stripe MID #1", processor: "STRIPE", labelled: true }, initiation: "cit" as const };
    expect(alertScopeKey(scope)).toBe("account:STRIPE:aaaa0000-0000-4000-8000-00000000a001:cit");
    expect(alertScopeKey({ ...scope, merchant_account: { ...scope.merchant_account, label: "Renamed" } })).toBe(alertScopeKey(scope));
    expect(alertScopeKey({ kind: "tenant", subject: "post_ban", initiation: "mit" })).toBe("tenant:post_ban:mit");
    expect(alertKeyOf("approval_drop", alertScopeKey(scope), "2026-09-30")).toBe("approval_drop|account:STRIPE:aaaa0000-0000-4000-8000-00000000a001:cit|2026-09-30");
  });

  it("normalizes alerts_list and alert_update bodies; anything malformed is a 400", () => {
    expect(normalizeAlertsListRequest({})).toEqual({ status: [], severity: [], rule: [], limit: 100 });
    expect(normalizeAlertsListRequest({ status: ["new", "investigating", "new"], severity: "critical", rule: ["approval_drop"], limit: 20 })).toEqual({ status: ["new", "investigating"], severity: ["critical"], rule: ["approval_drop"], limit: 20 });
    expect(normalizeAlertsListRequest({ filters: { status: ["resolved"] } }).status).toEqual(["resolved"]);
    for (const body of [{ status: ["open"] }, { severity: ["high"] }, { rule: ["vamp"] }, { limit: 0 }, { limit: 501 }, { limit: "x" }]) {
      expect(() => normalizeAlertsListRequest(body), JSON.stringify(body)).toThrow(PaymentHealthRequestError);
    }
    expect(normalizeAlertUpdateRequest({ alert_id: "AAAA0000-0000-4000-8000-000000000001", status: "investigating", note: "  looking  " })).toEqual({ alert_id: "aaaa0000-0000-4000-8000-000000000001", status: "investigating", note: "looking" });
    for (const body of [{}, { alert_id: "x", status: "new" }, { alert_id: "aaaa0000-0000-4000-8000-000000000001", status: "open" }, { alert_id: "aaaa0000-0000-4000-8000-000000000001", status: "resolved", note: 5 }, { alert_id: "aaaa0000-0000-4000-8000-000000000001", status: "resolved", note: "x".repeat(1001) }]) {
      expect(() => normalizeAlertUpdateRequest(body), JSON.stringify(body)).toThrow(PaymentHealthRequestError);
    }
  });

  it("DEFAULT_ALERT_RULES is the SQL seed (values and params)", () => {
    const sql = readMigration("202610130001_payment_health_alerts.sql");
    const seed = sql.slice(sql.indexOf("insert into public.payment_alert_rules"), sql.indexOf("on conflict (rule_key) do nothing"));
    for (const entry of DEFAULT_ALERT_RULES) {
      const row = new RegExp(`\\('${entry.rule_key}', (true|false), ([\\d.]+), ([\\d.]+), (\\d+), (\\d+), '(\\w+)', '([^']*)'`).exec(seed);
      expect(row, entry.rule_key).not.toBeNull();
      expect([row![1] === "true", Number(row![2]), Number(row![3]), Number(row![4]), Number(row![5]), row![6], JSON.parse(row![7])], entry.rule_key).toEqual([
        entry.enabled, entry.severity_warning, entry.severity_critical, entry.min_sample, entry.window_days, entry.compare, entry.params,
      ]);
      expect(seed.replace(/''/g, "'"), entry.rule_key).toContain(entry.description);
    }
  });
});

// =====================================================================================
// 3. Pure evaluation on hand-built runner answers
// =====================================================================================

// The newest attempt day (partial: the CSV is exported during it); the rule windows end the day before, 2026-09-30.
const DATA_THROUGH = "2026-10-01";
const STRIPE = { key: "STRIPE", label: "Stripe" };
const ADYEN = { key: "ADYEN", label: "Adyen" };
const MID1 = { key: "aaaa0000-0000-4000-8000-00000000a001", label: "Stripe MID #1", processor: "STRIPE", labelled: true };
const MIDA = { key: "aaaa0000-0000-4000-8000-00000000a002", label: "Adyen MID #1", processor: "ADYEN", labelled: true };

interface Totals {
  attempts?: number;
  successes?: number;
  refunded?: number;
  issuer_fraud_declines?: number;
  psp_integration_declines?: number;
  cause_unverified_declines?: number;
}

const totals = (values: Totals) => ({
  attempts: 0, successes: 0, declines: 0, settled_amount_usd: 0, refunded: 0, refund_amount_usd: 0, issuer_fraud_declines: 0, lost_stolen_declines: 0,
  authentication_declines: 0, psp_integration_declines: 0, cause_unverified_declines: 0, cascade_rows: 0, three_ds_attempts: 0, ...values,
});

const rate = (numerator: number, denominator: number) => ({ numerator, denominator });

function pspRow(processor: typeof STRIPE, account: typeof MID1, current: Totals, baseline: Totals, complaints?: { current: [number, number]; baseline: [number, number] }) {
  const complaint = complaints ?? { current: [0, current.successes ?? 0], baseline: [0, baseline.successes ?? 0] };
  return {
    processor,
    merchant_account: account,
    current: totals(current),
    baseline: totals(baseline),
    complaint_rate: { current: rate(...complaint.current), baseline: rate(...complaint.baseline) },
    complaints_unauthorized: { current: complaint.current[0], baseline: complaint.baseline[0] },
  };
}

function overview(rows: ReturnType<typeof pspRow>[], tenant: { current: Totals; baseline: Totals } = { current: { attempts: 1000 }, baseline: { attempts: 1000 } }) {
  return { ok: true, action: "overview", psp_mid_rows: rows, totals: { current: totals(tenant.current), baseline: totals(tenant.baseline) } };
}

function declinesByAccount(rows: Array<{ account: typeof MID1; current: Totals; baseline: Totals }>) {
  return { ok: true, action: "declines", by_dimension: rows.map((row) => ({ dimension: "merchant_account", value: row.account, current: totals(row.current), baseline: totals(row.baseline) })) };
}

function declinesByProcessor(rows: Array<{ processor: typeof STRIPE; current: Totals; baseline: Totals }>) {
  return { ok: true, action: "declines", by_dimension: rows.map((row) => ({ dimension: "processor", value: row.processor, current: totals(row.current), baseline: totals(row.baseline) })) };
}

interface RetriesInput {
  cit?: number;
  mit?: number;
  violations?: number;
  capped?: boolean;
  rows?: Array<Record<string, unknown>>;
  windows?: Array<Record<string, unknown>>;
  /** post_ban.by_initiation (the runner's full split); omitted = an older runner answer. */
  byInitiation?: Record<string, { attempts: number; succeeded: number; switched_processor: number }>;
  postBanListCut?: boolean;
  rollingListCut?: boolean;
  newestViolationEnd?: string | null;
}

function retries(input: RetriesInput) {
  return {
    ok: true,
    action: "retries",
    meta: { limited: { attempt_rows: input.capped === true, post_ban_attempts: input.postBanListCut === true, rolling_windows: input.rollingListCut === true }, chain_options: { rolling_decline_limit: 15, rolling_window_days: 30 } },
    chains: { attempts: 900 },
    post_ban: { cit: input.cit ?? 0, mit: input.mit ?? 0, banned_instruments: 4, retried_instruments: 2, ...(input.byInitiation ? { by_initiation: input.byInitiation } : {}) },
    post_ban_attempts: input.rows ?? [],
    rolling: { pairs: 120, violations: input.violations ?? 0, windows: input.windows ?? [], ...(input.newestViolationEnd !== undefined ? { newest_violation_end: input.newestViolationEnd } : {}) },
  };
}

/** The sources answer: the payment rows' sync, and the support data (newest received day, newest sync). */
function sources(lastSyncedAt: string | null, support: { lastDay?: string | null; syncedAt?: string | null } = {}) {
  const supportSynced = support.syncedAt === undefined ? lastSyncedAt : support.syncedAt;
  return {
    ok: true,
    action: "sources",
    warehouse: { attempt_rows: 5000, last_synced_at: lastSyncedAt },
    last_import: { imported_at: "2026-10-01T07:00:00.000Z" },
    support: { by_month: [{ month: "2026-09-01", requests: 40, classification_versions: ["v2"], version_break: false }], last_day: support.lastDay === undefined ? DATA_THROUGH : support.lastDay, last_synced_at: supportSynced },
  };
}

function dataSet(responses: Record<string, unknown>, overrides: Partial<AlertDataSet> = {}): AlertDataSet {
  return { data_through: DATA_THROUGH, today: "2026-10-03", now_ms: Date.parse("2026-10-03T12:00:00.000Z"), responses: responses as AlertDataSet["responses"], ...overrides };
}

const W7 = { from: "2026-09-24", to: "2026-09-30" };
const W30 = { from: "2026-09-01", to: "2026-09-30" };
const WREFUND = { from: "2026-08-25", to: "2026-08-31" };

function only(evaluation: ReturnType<typeof evaluateAlertRules>, key: AlertRuleKey) {
  return {
    candidates: evaluation.candidates.filter((candidate) => candidate.rule_key === key),
    cleared: evaluation.cleared.filter((entry) => entry.rule_key === key),
    outcome: evaluation.rules.find((entry) => entry.rule_key === key)!,
  };
}

describe("windows and the request plan", () => {
  it("rate rules compare the 7 whole days before data_through (its own day is partial) with the 7 before; retry rules read 30 days; refunds the newest mature window", () => {
    expect(ALERT_WINDOW_END_LAG_DAYS).toBe(1);
    expect(ruleWindow(rule("approval_drop"), DATA_THROUGH)).toEqual({ from: "2026-09-24", to: "2026-09-30", baseline_from: "2026-09-17", baseline_to: "2026-09-23", days: 7 });
    // data_through itself (the day the CSV was exported during) is never inside a rule window.
    for (const entry of RULES.filter((candidate) => candidate.rule_key !== "data_stale")) expect(ruleWindow(entry, DATA_THROUGH).to < DATA_THROUGH, entry.rule_key).toBe(true);
    expect(ruleWindow(rule("post_ban_retries"), DATA_THROUGH)).toMatchObject({ from: "2026-09-01", to: "2026-09-30", days: 30 });
    expect(ruleWindow(rule("refund_rate_rise"), DATA_THROUGH)).toEqual({ from: "2026-08-25", to: "2026-08-31", baseline_from: "2026-08-18", baseline_to: "2026-08-24", days: 7 });
    expect(ruleWindow(rule("refund_rate_rise", { params: { maturity_days: 14 } }), DATA_THROUGH).to).toBe("2026-09-16");
  });

  it("plans one runner request per distinct read: declines by account and by processor for CIT and MIT, one overview per window, one retries, sources", () => {
    const plan = planAlertRequests(RULES, DATA_THROUGH);
    expect(plan.map((request) => request.key).sort()).toEqual([
      approvalRequestKey(W7, "cit"), approvalRequestKey(W7, "mit"), approvalProcessorRequestKey(W7, "cit"), approvalProcessorRequestKey(W7, "mit"),
      overviewRequestKey(WREFUND), overviewRequestKey(W7), retriesRequestKey(W30), SOURCES_REQUEST_KEY,
    ].sort());
    expect(plan.find((request) => request.key === approvalRequestKey(W7, "cit"))?.body).toEqual({ action: "declines", date_from: "2026-09-24", date_to: "2026-09-30", filters: { initiation: ["cit"] }, dimension: "merchant_account" });
    expect(plan.find((request) => request.key === approvalProcessorRequestKey(W7, "mit"))?.body).toEqual({ action: "declines", date_from: "2026-09-24", date_to: "2026-09-30", filters: { initiation: ["mit"] }, dimension: "processor" });
    // Without data only the freshness read remains; a disabled rule reads nothing.
    expect(planAlertRequests(RULES, null).map((request) => request.key)).toEqual([SOURCES_REQUEST_KEY]);
    expect(planAlertRequests(RULES.map((entry) => ({ ...entry, enabled: entry.rule_key !== "data_stale" ? entry.enabled : false })), null)).toEqual([]);
    // The complaint rule reads the support data's reach from sources even with data_stale disabled.
    expect(planAlertRequests([rule("unauthorized_complaints_rise")], DATA_THROUGH).map((request) => request.key).sort()).toEqual([overviewRequestKey(W7), SOURCES_REQUEST_KEY].sort());
  });
});

describe("approval_drop", () => {
  const evaluate = (cit: Array<{ account: typeof MID1; current: Totals; baseline: Totals }>, overrides: Partial<AlertRuleConfig> = {}) =>
    only(evaluateAlertRules([rule("approval_drop", overrides)], dataSet({ [approvalRequestKey(W7, "cit")]: declinesByAccount(cit), [approvalRequestKey(W7, "mit")]: declinesByAccount([]) })), "approval_drop");

  it("fires critical on a significant drop of at least the critical threshold, per account and initiation", () => {
    const { candidates } = evaluate([{ account: MID1, current: { attempts: 400, successes: 200 }, baseline: { attempts: 400, successes: 280 } }]);
    expect(candidates).toHaveLength(1);
    const [alert] = candidates;
    expect(alert).toMatchObject({
      severity: "critical", data_confidence: "high", unit: "rate", metric: "attempt_approval_rate", current_value: 0.5, baseline_value: 0.7, change_value: -20, sample_size: 400,
      window_start: "2026-09-24", window_end: "2026-09-30", scope_key: `account:STRIPE:${MID1.key}:cit`, alert_key: `approval_drop|account:STRIPE:${MID1.key}:cit|2026-09-30`,
      scope: { kind: "account", processor: STRIPE, merchant_account: MID1, initiation: "cit" },
    });
    expect(alert.evidence).toMatchObject({ significant: true, significance_reason: "intervals_do_not_overlap", reproduce: { action: "declines", filters: { initiation: ["cit"] }, dimension: "merchant_account" } });
    expect(alert.explanation.fact).toMatch(/Approval of CIT \(customer-initiated\) attempts on Stripe MID #1 \(Stripe\) fell from 70\.0% to 50\.0% \(-20\.0 pp\)/);
  });

  it("is a warning between the thresholds; cleared only under the warning threshold — a move at or above it with overlapping intervals is inconclusive", () => {
    expect(evaluate([{ account: MID1, current: { attempts: 2000, successes: 1260 }, baseline: { attempts: 2000, successes: 1400 } }]).candidates[0]?.severity).toBe("warning");
    const small = evaluate([{ account: MID1, current: { attempts: 400, successes: 272 }, baseline: { attempts: 400, successes: 280 } }]);
    expect(small.candidates).toEqual([]);
    expect(small.cleared).toEqual([{ rule_key: "approval_drop", scope_key: `account:STRIPE:${MID1.key}:cit` }]);
    // 7 pp on 210 attempts: above the warning threshold, but the intervals overlap — not significant: neither raised
    // nor cleared ("not proven" is not "conclusively clear": an open alert of the scope stays open).
    const overlap = evaluate([{ account: MID1, current: { attempts: 210, successes: 132 }, baseline: { attempts: 210, successes: 147 } }]);
    expect(overlap.candidates).toEqual([]);
    expect(overlap.cleared).toEqual([]);
    expect(overlap.outcome).toMatchObject({ status: "evaluated", inconclusive: 1, cleared: 0 });
    // Even a move past the critical threshold (10.7 pp on 300 attempts) is inconclusive while the intervals overlap.
    const big = evaluate([{ account: MID1, current: { attempts: 300, successes: 178 }, baseline: { attempts: 300, successes: 210 } }]);
    expect(big.candidates).toEqual([]);
    expect(big.cleared).toEqual([]);
  });

  it("also reads every MID of one PSP together (plan Q 'по PSP или MID'): a PSP-wide drop no single MID shows conclusively", () => {
    const MID2 = { key: "aaaa0000-0000-4000-8000-00000000a003", label: "Stripe MID #2", processor: "STRIPE", labelled: true };
    // 150 attempts per MID: each under min_sample (info / low at most); 300 on the PSP: a significant 20 pp drop.
    const accounts = [
      { account: MID1, current: { attempts: 150, successes: 75 }, baseline: { attempts: 150, successes: 105 } },
      { account: MID2, current: { attempts: 150, successes: 75 }, baseline: { attempts: 150, successes: 105 } },
      { account: MIDA, current: { attempts: 400, successes: 200 }, baseline: { attempts: 400, successes: 280 } },
    ];
    const processors = [
      { processor: STRIPE, current: { attempts: 300, successes: 150 }, baseline: { attempts: 300, successes: 210 } },
      // A PSP with a single MID: its MID line already says it — no second alert.
      { processor: ADYEN, current: { attempts: 400, successes: 200 }, baseline: { attempts: 400, successes: 280 } },
    ];
    const result = only(evaluateAlertRules([rule("approval_drop")], dataSet({
      [approvalRequestKey(W7, "cit")]: declinesByAccount(accounts),
      [approvalProcessorRequestKey(W7, "cit")]: declinesByProcessor(processors),
      [approvalRequestKey(W7, "mit")]: declinesByAccount([]),
      [approvalProcessorRequestKey(W7, "mit")]: declinesByProcessor([]),
    })), "approval_drop");
    expect(result.candidates.map((candidate) => [candidate.scope_key, candidate.severity, candidate.data_confidence]).sort()).toEqual([
      [`account:ADYEN:${MIDA.key}:cit`, "critical", "high"],
      [`account:STRIPE:${MID1.key}:cit`, "info", "low"],
      [`account:STRIPE:${MID2.key}:cit`, "info", "low"],
      ["account:STRIPE:all:cit", "critical", "high"],
    ].sort());
    const psp = result.candidates.find((candidate) => candidate.scope_key === "account:STRIPE:all:cit")!;
    expect(psp).toMatchObject({
      scope: { kind: "account", processor: STRIPE, initiation: "cit" }, current_value: 0.5, baseline_value: 0.7, sample_size: 300,
      alert_key: "approval_drop|account:STRIPE:all:cit|2026-09-30",
      evidence: { merchant_accounts: 2, reproduce: { action: "declines", dimension: "processor", filters: { initiation: ["cit"] }, read: "by_dimension[value.key=STRIPE].approval" } },
    });
    expect(psp.scope.merchant_account).toBeUndefined();
    expect(psp.explanation.fact).toMatch(/^Approval of CIT \(customer-initiated\) attempts on all Stripe merchant accounts fell from 70\.0% to 50\.0%/);
    expect(psp.explanation.likely_explanation).toMatch(/every merchant account of one PSP/);
    for (const text of [psp.explanation.fact, psp.explanation.likely_explanation, psp.explanation.hypothesis, ...psp.explanation.action]) expect(forbiddenRecommendationHits(text)).toEqual([]);
    // Its funnel split filters on the processor (no account to name).
    expect(funnelLookupRequest(psp)?.body).toMatchObject({ action: "declines", filters: { processor: ["STRIPE"], initiation: ["cit"] }, dimension: "funnel" });
  });

  it("a small sample gives info + low confidence, never warning; a tiny one is not looked at (neither raised nor cleared)", () => {
    const low = evaluate([{ account: MID1, current: { attempts: 80, successes: 30 }, baseline: { attempts: 80, successes: 60 } }]);
    expect(low.candidates).toHaveLength(1);
    expect(low.candidates[0]).toMatchObject({ severity: "info", data_confidence: "low", sample_size: 80 });
    expect(low.candidates[0].explanation.fact).toMatch(/Low confidence: fewer than 200 observations/);
    const tiny = evaluate([{ account: MID1, current: { attempts: 30, successes: 5 }, baseline: { attempts: 30, successes: 25 } }]);
    expect(tiny.candidates).toEqual([]);
    expect(tiny.cleared).toEqual([]);
    expect(tiny.outcome).toMatchObject({ status: "evaluated", inconclusive: 1 });
    // A small sample with a small move is inconclusive too: it never auto-resolves an open alert.
    expect(evaluate([{ account: MID1, current: { attempts: 80, successes: 55 }, baseline: { attempts: 80, successes: 56 } }]).cleared).toEqual([]);
  });

  it("reads the owner's thresholds and min_sample from the rule row", () => {
    const strict = evaluate([{ account: MID1, current: { attempts: 400, successes: 200 }, baseline: { attempts: 400, successes: 280 } }], { severity_warning: 25, severity_critical: 30 });
    expect(strict.candidates).toEqual([]);
    expect(strict.cleared).toHaveLength(1);
    const lowered = evaluate([{ account: MID1, current: { attempts: 80, successes: 30 }, baseline: { attempts: 80, successes: 60 } }], { min_sample: 50 });
    expect(lowered.candidates[0]).toMatchObject({ severity: "critical", data_confidence: "high" });
  });

  it("skips the unrouted line (no processor, no account) and an account without current attempts", () => {
    const unrouted = { key: "none:unrouted", label: "No MID", processor: "unrouted", labelled: false };
    const result = evaluate([
      { account: unrouted, current: { attempts: 400, successes: 0 }, baseline: { attempts: 400, successes: 100 } },
      { account: MID1, current: { attempts: 0, successes: 0 }, baseline: { attempts: 400, successes: 280 } },
    ]);
    expect(result.candidates).toEqual([]);
    expect(result.cleared).toEqual([]);
  });
});

describe("issuer_fraud_rise, psp_integration_rise, unauthorized_complaints_rise, refund_rate_rise", () => {
  it("issuer fraud-suspicion declines: a significant rise per account fires; the text never calls them fraud", () => {
    const evaluation = evaluateAlertRules([rule("issuer_fraud_rise")], dataSet({
      [overviewRequestKey(W7)]: overview([
        pspRow(STRIPE, MID1, { attempts: 600, successes: 300, issuer_fraud_declines: 30 }, { attempts: 600, successes: 320, issuer_fraud_declines: 1 }),
        pspRow(ADYEN, MIDA, { attempts: 600, successes: 300, issuer_fraud_declines: 6 }, { attempts: 600, successes: 300, issuer_fraud_declines: 5 }),
      ]),
    }));
    const { candidates, cleared } = only(evaluation, "issuer_fraud_rise");
    expect(candidates.map((candidate) => [candidate.scope.merchant_account?.label, candidate.severity])).toEqual([["Stripe MID #1", "critical"]]);
    expect(candidates[0].explanation.fact).toContain("not confirmed fraud");
    expect(cleared.map((entry) => entry.scope_key)).toEqual([`account:ADYEN:${MIDA.key}`]);
  });

  it("PSP / integration: per account, and one tenant line of integration + unrouted declines over all attempts (not PSP-scoped)", () => {
    const evaluation = evaluateAlertRules([rule("psp_integration_rise")], dataSet({
      [overviewRequestKey(W7)]: overview(
        [pspRow(STRIPE, MID1, { attempts: 600, psp_integration_declines: 40 }, { attempts: 600, psp_integration_declines: 2 })],
        { current: { attempts: 1200, psp_integration_declines: 40, cause_unverified_declines: 60 }, baseline: { attempts: 1200, psp_integration_declines: 2, cause_unverified_declines: 10 } },
      ),
    }));
    const { candidates } = only(evaluation, "psp_integration_rise");
    expect(candidates.map((candidate) => [candidate.scope_key, candidate.severity])).toEqual([[`account:STRIPE:${MID1.key}`, "critical"], ["tenant:unrouted_and_integration", "critical"]]);
    const tenant = candidates[1];
    expect(tenant.scope).toEqual({ kind: "tenant", subject: "unrouted_and_integration" });
    expect(tenant.evidence.parts).toEqual({ current: { psp_integration: 40, cause_unverified: 60 }, baseline: { psp_integration: 2, cause_unverified: 10 } });
    expect(tenant.explanation.fact).toMatch(/before routing \(cause not verified\)/);
  });

  it("unauthorized-charge complaints: per account over its settled payments, by received date, once the support data covers the window", () => {
    const evaluation = evaluateAlertRules([rule("unauthorized_complaints_rise")], dataSet({
      [overviewRequestKey(W7)]: overview([pspRow(STRIPE, MID1, { attempts: 600, successes: 300 }, { attempts: 600, successes: 300 }, { current: [24, 300], baseline: [3, 300] })]),
      [SOURCES_REQUEST_KEY]: sources("2026-10-01T08:00:00.000Z", { lastDay: "2026-09-30" }),
    }));
    const { candidates } = only(evaluation, "unauthorized_complaints_rise");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ severity: "critical", data_confidence: "high", current_value: 0.08, baseline_value: 0.01, metric: "support_unauthorized_rate" });
    expect(candidates[0].evidence).toMatchObject({ maturity_basis: "received_at", support_through: "2026-09-30", support_complete: true, immature_window: false });
    expect(candidates[0].explanation.action.join(" ")).toMatch(/refund/i);
  });

  describe("complaints while the support data lags the payment data (absence of data is not zero risk)", () => {
    const answers = (current: [number, number], supportLastDay: string | null) => ({
      [overviewRequestKey(W7)]: overview([pspRow(STRIPE, MID1, { attempts: 600, successes: 300 }, { attempts: 600, successes: 300 }, { current, baseline: [24, 300] })]),
      [SOURCES_REQUEST_KEY]: sources("2026-10-01T08:00:00.000Z", { lastDay: supportLastDay }),
    });

    it("payments current, support stopped 5 days before data_through: a 'no rise' is not a cleared condition (an open complaint alert is not auto-resolved)", () => {
      // The current window shows almost no complaints only because the support import stopped on 2026-09-26.
      const stopped = only(evaluateAlertRules([rule("unauthorized_complaints_rise")], dataSet(answers([2, 300], "2026-09-26"))), "unauthorized_complaints_rise");
      expect(stopped.candidates).toEqual([]);
      expect(stopped.cleared).toEqual([]);
      expect(stopped.outcome).toMatchObject({ status: "evaluated", inconclusive: 1, cleared: 0 });
      // The same figures with the support data through the window's end ARE conclusive.
      const covered = only(evaluateAlertRules([rule("unauthorized_complaints_rise")], dataSet(answers([2, 300], "2026-09-30"))), "unauthorized_complaints_rise");
      expect(covered.cleared).toEqual([{ rule_key: "unauthorized_complaints_rise", scope_key: `account:STRIPE:${MID1.key}` }]);
    });

    it("a rise on support data that does not reach the window's end is info / low confidence at most, and says why", () => {
      const rising = overview([pspRow(STRIPE, MID1, { attempts: 600, successes: 300 }, { attempts: 600, successes: 300 }, { current: [24, 300], baseline: [3, 300] })]);
      const lagging = only(evaluateAlertRules([rule("unauthorized_complaints_rise")], dataSet({
        [overviewRequestKey(W7)]: rising,
        [SOURCES_REQUEST_KEY]: sources("2026-10-01T08:00:00.000Z", { lastDay: "2026-09-26" }),
      })), "unauthorized_complaints_rise");
      expect(lagging.candidates[0]).toMatchObject({ severity: "info", data_confidence: "low", evidence: { immature_window: true, significant: false, support_through: "2026-09-26", support_complete: false } });
      expect(lagging.candidates[0].explanation.fact).toMatch(/Low confidence: the support data reaches only 2026-09-26/);
      // No support data at all, or no sources answer: the same.
      for (const responses of [{ [overviewRequestKey(W7)]: rising, [SOURCES_REQUEST_KEY]: sources("2026-10-01T08:00:00.000Z", { lastDay: null, syncedAt: null }) }, { [overviewRequestKey(W7)]: rising }]) {
        const none = only(evaluateAlertRules([rule("unauthorized_complaints_rise")], dataSet(responses)), "unauthorized_complaints_rise");
        expect(none.candidates.map((candidate) => [candidate.severity, candidate.data_confidence])).toEqual([["info", "low"]]);
        expect(none.candidates[0].explanation.fact).toMatch(/Low confidence: there is no support data in the warehouse/);
        expect(none.cleared).toEqual([]);
      }
    });
  });

  it("refunds: read on the newest MATURE window (maturity_days before data_through) by original payment date", () => {
    const answers = { [overviewRequestKey(WREFUND)]: overview([pspRow(STRIPE, MID1, { attempts: 500, successes: 300, refunded: 30 }, { attempts: 500, successes: 300, refunded: 3 })]) };
    const mature = only(evaluateAlertRules([rule("refund_rate_rise")], dataSet(answers)), "refund_rate_rise");
    expect(mature.candidates[0]).toMatchObject({ severity: "critical", data_confidence: "high", window_end: "2026-08-31", current_value: 0.1, baseline_value: 0.01 });
    expect(mature.candidates[0].evidence).toMatchObject({ maturity_days: 30, maturity_basis: "original_payment", immature_window: false });
    expect(mature.candidates[0].explanation.fact).toMatch(/30 refunds of 300 settled payments, by original payment date, read 30 days after the window/);
    // The window the latest overview reads (the newest whole week) is never used for refunds: no answer for it, no verdict.
    const latestOnly = only(evaluateAlertRules([rule("refund_rate_rise")], dataSet({ [overviewRequestKey(W7)]: answers[overviewRequestKey(WREFUND)] })), "refund_rate_rise");
    expect(latestOnly.outcome).toMatchObject({ status: "skipped", candidates: 0 });
  });

  it("an immature window (or a small sample) turns a would-be critical into info + low confidence", () => {
    const base = {
      rule: rule("refund_rate_rise"), window: ruleWindow(rule("refund_rate_rise"), DATA_THROUGH), dataThrough: DATA_THROUGH, direction: "rise" as const,
      current: { numerator: 30, denominator: 300 }, baseline: { numerator: 3, denominator: 300 },
      scope: { kind: "account" as const, processor: STRIPE, merchant_account: MID1 }, facts: { account: "Stripe MID #1 (Stripe)" }, reproduce: {},
    };
    const immature = evaluateRate({ ...base, immature: true });
    expect(immature.kind).toBe("candidate");
    expect(immature.kind === "candidate" && immature.candidate).toMatchObject({ severity: "info", data_confidence: "low", evidence: { immature_window: true, significant: false, significance_reason: "immature_period" } });
    expect(immature.kind === "candidate" && immature.candidate.explanation.fact).toMatch(/Low confidence: the window is still maturing/);
    expect(evaluateRate({ ...base, immature: false })).toMatchObject({ kind: "candidate", candidate: { severity: "critical", data_confidence: "high" } });
  });
});

describe("post_ban_retries and excessive_reattempts", () => {
  const banRows = [
    { initiation_type: "mit", event_time: "2026-09-20T10:00:00.000Z", succeeded: true, processor_relation: "switched", minutes_since_ban: 3000, processor: STRIPE, merchant_account: MID1 },
    { initiation_type: "mit", event_time: "2026-09-28T10:00:00.000Z", succeeded: false, processor_relation: "same", minutes_since_ban: 30, processor: STRIPE, merchant_account: MID1 },
  ];

  it("any post-ban re-attempt fires, CIT and MIT separately; none clears; the newest event day is kept for suppression", () => {
    const evaluation = evaluateAlertRules([rule("post_ban_retries")], dataSet({ [retriesRequestKey(W30)]: retries({ mit: 2, rows: banRows }) }));
    const { candidates, cleared } = only(evaluation, "post_ban_retries");
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ scope: { kind: "tenant", subject: "post_ban", initiation: "mit" }, severity: "warning", current_value: 2, unit: "count", newest_event_day: "2026-09-28", window_start: "2026-09-01", window_end: "2026-09-30" });
    expect(candidates[0].explanation.fact).toMatch(/^2 MIT \(merchant-initiated\) re-attempts .* 1 of them settled and 1 came after a processor change\./);
    expect(candidates[0].evidence.by_account).toEqual([{ processor: STRIPE, merchant_account: { key: MID1.key, label: MID1.label }, count: 2 }]);
    expect(cleared).toEqual([{ rule_key: "post_ban_retries", scope_key: "tenant:post_ban:cit" }]);
    expect(only(evaluateAlertRules([rule("post_ban_retries")], dataSet({ [retriesRequestKey(W30)]: retries({ cit: 12 }) })), "post_ban_retries").candidates[0].severity).toBe("critical");
  });

  it("the fact's settled / after-processor-change counts are the full per-initiation figures, not the capped list's", () => {
    // 250 MIT re-attempts; the list holds the newest 200 of both initiations (here only the two rows above).
    const capped = retries({ mit: 250, rows: banRows, postBanListCut: true, byInitiation: { cit: { attempts: 0, succeeded: 0, switched_processor: 0 }, mit: { attempts: 250, succeeded: 40, switched_processor: 31 } } });
    const [alert] = only(evaluateAlertRules([rule("post_ban_retries")], dataSet({ [retriesRequestKey(W30)]: capped })), "post_ban_retries").candidates;
    expect(alert.explanation.fact).toMatch(/^250 MIT \(merchant-initiated\) re-attempts .* 40 of them settled and 31 came after a processor change\./);
    expect(alert.evidence).toMatchObject({ succeeded: 40, after_processor_change: 31, listed: 2, list_complete: false });
    // An answer without the split and a cut list: the sub-counts are not guessed from the partial list.
    const older = retries({ mit: 250, rows: banRows, postBanListCut: true });
    const [fallback] = only(evaluateAlertRules([rule("post_ban_retries")], dataSet({ [retriesRequestKey(W30)]: older })), "post_ban_retries").candidates;
    expect(fallback.explanation.fact).toMatch(/n\/a \(list capped\) of them settled and n\/a \(list capped\) came after a processor change/);
  });

  it("a capped row read is a lower bound: info + low confidence, and never cleared", () => {
    const { candidates, cleared } = only(evaluateAlertRules([rule("post_ban_retries")], dataSet({ [retriesRequestKey(W30)]: retries({ mit: 30, capped: true }) })), "post_ban_retries");
    expect(candidates[0]).toMatchObject({ severity: "info", data_confidence: "low" });
    expect(cleared).toEqual([]);
  });

  it("more than 15 declines per card and MID in a rolling 30 days fires on the count of pairs", () => {
    const windows = [{ max_declines: 17, window_end: "2026-09-25T10:00:00.000Z", merchant_account: MID1 }, { max_declines: 22, window_end: "2026-09-29T10:00:00.000Z", merchant_account: null }];
    const { candidates } = only(evaluateAlertRules([rule("excessive_reattempts")], dataSet({ [retriesRequestKey(W30)]: retries({ violations: 2, windows }) })), "excessive_reattempts");
    expect(candidates[0]).toMatchObject({ severity: "warning", current_value: 2, newest_event_day: "2026-09-29", scope: { kind: "tenant", subject: "rolling" } });
    expect(candidates[0].explanation.fact).toMatch(/^2 card x merchant-account pairs had more than 15 declines in a rolling 30-day window .*\(largest: 22 declines\)/);
    expect(only(evaluateAlertRules([rule("excessive_reattempts")], dataSet({ [retriesRequestKey(W30)]: retries({ violations: 0 }) })), "excessive_reattempts").cleared).toHaveLength(1);
  });

  it("the suppression day is the newest violation of ALL pairs, never the newest entry of the cut list", () => {
    // 101 pairs over the limit: the list keeps the 100 with the most declines (all ending 2026-09-17); the newest
    // violator (16 declines, ending 2026-09-27) is the one cut.
    const windows = Array.from({ length: 100 }, (_, index) => ({ max_declines: 17 + (index % 3), window_end: "2026-09-17T06:00:00.000Z", merchant_account: MID1 }));
    const full = retries({ violations: 101, windows, rollingListCut: true, newestViolationEnd: "2026-09-27T06:30:00.000Z" });
    const [alert] = only(evaluateAlertRules([rule("excessive_reattempts")], dataSet({ [retriesRequestKey(W30)]: full })), "excessive_reattempts").candidates;
    expect(alert).toMatchObject({ newest_event_day: "2026-09-27", current_value: 101, severity: "critical", evidence: { newest_violation_day: "2026-09-27", list_complete: false } });
    // An answer without the full figure: a cut list gives no suppression day at all.
    const older = retries({ violations: 101, windows, rollingListCut: true });
    expect(only(evaluateAlertRules([rule("excessive_reattempts")], dataSet({ [retriesRequestKey(W30)]: older })), "excessive_reattempts").candidates[0].newest_event_day).toBeNull();
  });
});

describe("data_stale", () => {
  it("fires on data_through older than the thresholds and on a stale ClickHouse sync; fresh data clears both", () => {
    const fresh = only(evaluateAlertRules([rule("data_stale")], dataSet({ [SOURCES_REQUEST_KEY]: sources("2026-10-03T08:00:00.000Z") })), "data_stale");
    expect(fresh.candidates).toEqual([]);
    expect(fresh.cleared.map((entry) => entry.scope_key).sort()).toEqual(["tenant:data_through", "tenant:support_sync", "tenant:warehouse_sync"]);

    // The payment sync stopped; the support sync did not (each pipeline is its own line).
    const stale = only(evaluateAlertRules([rule("data_stale")], dataSet({ [SOURCES_REQUEST_KEY]: sources("2026-09-25T08:00:00.000Z", { syncedAt: "2026-10-16T08:00:00.000Z" }) }, { today: "2026-10-16", now_ms: Date.parse("2026-10-16T12:00:00.000Z") })), "data_stale");
    expect(stale.candidates.map((candidate) => [candidate.scope_key, candidate.severity, candidate.unit, candidate.current_value])).toEqual([
      ["tenant:data_through", "critical", "days", 15],
      ["tenant:warehouse_sync", "critical", "hours", 508],
    ]);
    expect(stale.cleared.map((entry) => entry.scope_key)).toEqual(["tenant:support_sync"]);
    // data_stale reads data_through itself, not the rule windows' end.
    expect(stale.candidates[0].alert_key).toBe("data_stale|tenant:data_through|2026-10-01");
    expect(stale.candidates[0].explanation.fact).toMatch(/newest payment in the warehouse is from 2026-10-01, 15 days ago/);

    const warning = only(evaluateAlertRules([rule("data_stale")], dataSet({ [SOURCES_REQUEST_KEY]: sources("2026-10-08T08:00:00.000Z") }, { today: "2026-10-08", now_ms: Date.parse("2026-10-08T12:00:00.000Z") })), "data_stale");
    expect(warning.candidates.map((candidate) => candidate.severity)).toEqual(["warning"]);
  });

  it("a stalled support pipeline raises its own line on the sync thresholds; a workspace without support data has none", () => {
    const now = { today: "2026-10-03", now_ms: Date.parse("2026-10-03T12:00:00.000Z") };
    const stalled = only(evaluateAlertRules([rule("data_stale")], dataSet({ [SOURCES_REQUEST_KEY]: sources("2026-10-03T08:00:00.000Z", { lastDay: "2026-09-29", syncedAt: "2026-09-29T09:00:00.000Z" }) }, now)), "data_stale");
    expect(stalled.candidates).toHaveLength(1);
    const [support] = stalled.candidates;
    expect(support).toMatchObject({
      scope_key: "tenant:support_sync", scope: { kind: "tenant", subject: "support_sync" }, severity: "warning", unit: "hours", metric: "sync_age_hours", current_value: 99, sample_size: 40,
      alert_key: "data_stale|tenant:support_sync|2026-09-29",
      evidence: { stream: "support", support_through: "2026-09-29", reproduce: { action: "sources", read: "support.last_synced_at" } },
    });
    expect(support.explanation.fact).toMatch(/^The last ClickHouse sync of support requests was 99 hours ago/);
    for (const text of [support.explanation.fact, support.explanation.likely_explanation, support.explanation.hypothesis, ...support.explanation.action]) expect(forbiddenRecommendationHits(text)).toEqual([]);
    expect(stalled.cleared.map((entry) => entry.scope_key).sort()).toEqual(["tenant:data_through", "tenant:warehouse_sync"]);
    // The owner's sync thresholds apply to both lines.
    const strict = only(evaluateAlertRules([rule("data_stale", { params: { sync_warning_hours: 24, sync_critical_hours: 48 } })], dataSet({ [SOURCES_REQUEST_KEY]: sources("2026-10-03T08:00:00.000Z", { lastDay: "2026-09-29", syncedAt: "2026-09-29T09:00:00.000Z" }) }, now)), "data_stale");
    expect(strict.candidates.map((candidate) => candidate.severity)).toEqual(["critical"]);
    // No support rows at all: nothing to judge (inconclusive), never an alert.
    const none = only(evaluateAlertRules([rule("data_stale")], dataSet({ [SOURCES_REQUEST_KEY]: sources("2026-10-03T08:00:00.000Z", { lastDay: null, syncedAt: null }) }, now)), "data_stale");
    expect(none.candidates).toEqual([]);
    expect(none.outcome).toMatchObject({ inconclusive: 1 });
  });

  it("no attempt data at all: critical freshness, every other rule skipped (their open alerts are not touched)", () => {
    const evaluation = evaluateAlertRules(RULES, dataSet({ [SOURCES_REQUEST_KEY]: sources(null) }, { data_through: null }));
    expect(evaluation.candidates.map((candidate) => [candidate.rule_key, candidate.severity, candidate.current_value])).toEqual([["data_stale", "critical", null]]);
    expect(evaluation.cleared).toEqual([]);
    for (const outcome of evaluation.rules.filter((entry) => entry.rule_key !== "data_stale")) expect(outcome).toMatchObject({ status: "skipped", reason: "no attempt data in the warehouse" });
  });

  it("a disabled rule is reported, not evaluated; a missing rule row is skipped", () => {
    const evaluation = evaluateAlertRules([rule("data_stale", { enabled: false })], dataSet({}));
    expect(evaluation.rules.find((entry) => entry.rule_key === "data_stale")).toMatchObject({ status: "disabled" });
    expect(evaluation.rules.find((entry) => entry.rule_key === "approval_drop")).toMatchObject({ status: "skipped", reason: "not configured in payment_alert_rules" });
    expect(evaluation.candidates).toEqual([]);
  });
});

describe("invariants over every candidate", () => {
  it("low confidence is only ever info; keys are deterministic; explanations are compliant", () => {
    const answers = {
      [approvalRequestKey(W7, "cit")]: declinesByAccount([{ account: MID1, current: { attempts: 80, successes: 30 }, baseline: { attempts: 80, successes: 60 } }, { account: MIDA, current: { attempts: 400, successes: 200 }, baseline: { attempts: 400, successes: 280 } }]),
      [approvalRequestKey(W7, "mit")]: declinesByAccount([]),
      [overviewRequestKey(W7)]: overview([pspRow(STRIPE, MID1, { attempts: 90, successes: 40, issuer_fraud_declines: 9 }, { attempts: 90, successes: 40, issuer_fraud_declines: 0 })]),
      [overviewRequestKey(WREFUND)]: overview([]),
      [retriesRequestKey(W30)]: retries({ mit: 3, cit: 30, capped: true }),
      [SOURCES_REQUEST_KEY]: sources("2026-10-03T08:00:00.000Z"),
    };
    const first = evaluateAlertRules(RULES, dataSet(answers));
    const second = evaluateAlertRules(RULES, dataSet(answers));
    expect(first.candidates.length).toBeGreaterThan(3);
    expect(second.candidates.map((candidate) => candidate.alert_key)).toEqual(first.candidates.map((candidate) => candidate.alert_key));
    expect(new Set(first.candidates.map((candidate) => candidate.alert_key)).size).toBe(first.candidates.length);
    for (const candidate of first.candidates) {
      if (candidate.data_confidence === "low") expect(candidate.severity, candidate.alert_key).toBe("info");
      for (const text of [candidate.explanation.fact, candidate.explanation.likely_explanation, candidate.explanation.hypothesis, ...candidate.explanation.action]) {
        expect(forbiddenRecommendationHits(text), candidate.alert_key).toEqual([]);
      }
    }
  });
});

describe("a MID registered by psp_accounts_sync keeps its alerts (scope aliases)", () => {
  const UNLABELLED = "unlabelled:0123456789abcdef";

  it("names the former unlabelled scope key on the candidates and clears the condition under both keys", () => {
    const answers = {
      [approvalRequestKey(W7, "cit")]: declinesByAccount([{ account: MID1, current: { attempts: 400, successes: 200 }, baseline: { attempts: 400, successes: 280 } }]),
      [approvalRequestKey(W7, "mit")]: declinesByAccount([{ account: MID1, current: { attempts: 400, successes: 120 }, baseline: { attempts: 400, successes: 120 } }]),
    };
    const evaluation = evaluateAlertRules([rule("approval_drop")], dataSet(answers, { account_aliases: { [MID1.key]: UNLABELLED } }));
    expect(evaluation.candidates.map((candidate) => [candidate.scope_key, candidate.scope_aliases])).toEqual([[`account:STRIPE:${MID1.key}:cit`, [`account:STRIPE:${UNLABELLED}:cit`]]]);
    expect(evaluation.cleared).toEqual([
      { rule_key: "approval_drop", scope_key: `account:STRIPE:${MID1.key}:mit` },
      { rule_key: "approval_drop", scope_key: `account:STRIPE:${UNLABELLED}:mit` },
    ]);
    // The outcome counts conditions, not keys.
    expect(evaluation.rules.find((entry) => entry.rule_key === "approval_drop")).toMatchObject({ candidates: 1, cleared: 1 });
    // Without aliases (or for a tenant line / a PSP-wide line) nothing changes.
    expect(evaluateAlertRules([rule("approval_drop")], dataSet(answers)).candidates[0].scope_aliases).toEqual([]);
    expect(aliasScopeKey("tenant:post_ban:mit", { [MID1.key]: UNLABELLED })).toBeNull();
    expect(aliasScopeKey("account:STRIPE:all:cit", { all: UNLABELLED })).toBeNull();
    expect(aliasScopeKey(`account:STRIPE:${MID1.key}`, { [MID1.key]: UNLABELLED })).toBe(`account:STRIPE:${UNLABELLED}`);
  });

  it("the alias of a registered account is exactly the key the same MID had while unregistered (opaque, no raw MID)", async () => {
    const rows = engineRows();
    const registry = (accounts: unknown[]) =>
      loadDimensionRegistry({ tenantKey: PH_DATA_KEY, clickhouse: createRecordingClickHouse(fixtureWarehouse({ rows }).respond), pg: asPg(enginePg({ accounts })) });
    const registered = await registry(fixtureAccounts());
    const unregistered = await registry([]);
    const aliases = await registeredAccountAliases(PH_DATA_KEY, registered);
    const labelled = [...registered.accounts.entries()].filter(([, ref]) => ref.labelled);
    expect(labelled.length).toBeGreaterThan(0);
    for (const [pair, ref] of labelled) {
      const before = unregistered.accounts.get(pair)!;
      expect(before.labelled).toBe(false);
      expect(aliases[ref.key]).toBe(before.key);
      expect(before.key).toMatch(/^unlabelled:[0-9a-f]{16}$/);
    }
    expect(scanForLeaks(aliases, { extra: Object.values(PH_SENTINELS) })).toEqual([]);
  });
});

describe("affected funnels", () => {
  const candidate = (key: AlertRuleKey) => ({ rule_key: key } as AlertCandidate);
  const funnelRow = (label: string, current: Totals, baseline: Totals): BreakdownRow =>
    ({ dimension: "funnel", value: { key: label, label }, current: totals(current), baseline: totals(baseline) } as unknown as BreakdownRow);

  it("names the funnels that moved the metric most in the alert's direction (labels only, at most five)", () => {
    const rows = [
      funnelRow("soulmate-sketch", { attempts: 200, successes: 80 }, { attempts: 200, successes: 140 }),
      funnelRow("past-life", { attempts: 100, successes: 60 }, { attempts: 100, successes: 62 }),
      funnelRow("palm-reading", { attempts: 100, successes: 70 }, { attempts: 100, successes: 50 }),
      funnelRow("Unattributed (no acquisition anchor)", { attempts: 50, successes: 10 }, { attempts: 0, successes: 0 }),
    ];
    expect(affectedFunnels(candidate("approval_drop"), rows)).toEqual(["soulmate-sketch", "past-life"]);
    const fraud = [funnelRow("soulmate-sketch", { attempts: 200, issuer_fraud_declines: 20 }, { attempts: 200, issuer_fraud_declines: 2 }), funnelRow("new-funnel", { attempts: 40, issuer_fraud_declines: 4 }, {})];
    expect(affectedFunnels(candidate("issuer_fraud_rise"), fraud)).toEqual(["soulmate-sketch", "new-funnel"]);
  });
});

// =====================================================================================
// 4. The whole engine over the semantic fixture warehouse (the runner's real SQL)
// =====================================================================================

const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const RULE_ROWS = DEFAULT_ALERT_RULES.map((entry) => ({ ...entry, updated_by: null }));

let uid = 0;
/** n attempts of one account / initiation on `day`, `approved` of them settled, the rest issuer-51 soft declines. */
function batch(day: string, n: number, approved: number, spec: Partial<FixtureTx> = {}, decline: Partial<FixtureTx> = {}): FixtureTx[] {
  const out: FixtureTx[] = [];
  for (let index = 0; index < n; index += 1) {
    uid += 1;
    const user = `gen-u${uid}`;
    const hhmm = `${String(8 + (index % 12)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}`;
    out.push(index < approved
      ? tx({ t: T(day, hhmm), status: "SETTLED", user_id: user, payment_instrument_key: `gen-pi-${uid}`, transaction_id: `gen-tx-${uid}`, ...spec })
      : tx({ t: T(day, hhmm), user_id: user, payment_instrument_key: `gen-pi-${uid}`, transaction_id: `gen-tx-${uid}`, ...spec, ...decline }));
  }
  return out;
}

const days = (from: string, count: number) => Array.from({ length: count }, (_, index) => new Date(Date.parse(`${from}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));

/** Two weeks to data_through = 2026-09-30 (+ the mature refund window in late August, + retry patterns in September). */
function engineRows(): FixtureTx[] {
  uid = 0;
  const rows: FixtureTx[] = [];
  // Stripe MID #1 CIT: 70% → 50% (critical drop); MIT flat 30%.
  for (const day of days("2026-09-17", 7)) rows.push(...batch(day, 50, 35), ...batch(day, 40, 12, { initiation_type: "mit", ff_billing_reason: "renewal" }));
  for (const day of days("2026-09-24", 7)) {
    rows.push(...batch(day, 50, 25), ...batch(day, 40, 12, { initiation_type: "mit", ff_billing_reason: "renewal" }));
    // ...with fraud-suspicion codes appearing in the current window (issuer code 59 is a fraud-suspicion decline, not fraud).
    rows.push(...batch(day, 5, 0, {}, { issuer_result_code: "59", primer_decline_code: "DO_NOT_HONOR", advised_action: "RETRY_LATER" }));
  }
  // Adyen MID #1 CIT, small: 70% → 40% on 10 a day (70 a window: low confidence).
  for (const day of days("2026-09-17", 7)) rows.push(...batch(day, 10, 7, { processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen }));
  for (const day of days("2026-09-24", 7)) rows.push(...batch(day, 10, 4, { processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen }));
  // The mature refund window (2026-08-25..31 vs 08-18..24): refunds 1% → 10% on Stripe MID #1.
  for (const day of days("2026-08-18", 7)) rows.push(...batch(day, 45, 45, { transaction_type: "renewal_2" }).map((row, index) => (index === 0 && day === "2026-08-20" ? { ...row, is_refund: 1 as const, refund_amount_usd: 19.99 } : row)));
  for (const day of days("2026-08-25", 7)) rows.push(...batch(day, 45, 45, { transaction_type: "renewal_2" }).map((row, index) => (index < 5 ? { ...row, is_refund: 1 as const, refund_amount_usd: 19.99 } : row)));
  // A banned card re-attempted twice by the dunning schedule (MIT), one success after a processor change.
  rows.push(tx({ t: T("2026-09-10", "09:00"), user_id: "ban-user", payment_instrument_key: PH_SENTINELS.instrument, transaction_id: PH_SENTINELS.transactionId, initiation_type: "mit", issuer_result_code: "05", advised_action: "DO_NOT_RETRY", primer_decline_code: "DO_NOT_HONOR", decline_type: "hard" }));
  rows.push(tx({ t: T("2026-09-13", "09:00"), user_id: "ban-user", payment_instrument_key: PH_SENTINELS.instrument, initiation_type: "mit", transaction_id: "ban-tx-2" }));
  rows.push(tx({ t: T("2026-09-16", "09:00"), status: "SETTLED", user_id: "ban-user", payment_instrument_key: PH_SENTINELS.instrument, initiation_type: "mit", processor: "ADYEN", processor_merchant_id: PH_SENTINELS.rawMidAdyen, transaction_id: "ban-tx-3" }));
  // 17 declines of one card on the unlabelled Stripe MID within 20 days (over the 15 limit).
  for (let index = 0; index < 17; index += 1) {
    rows.push(tx({ t: T(days("2026-09-05", 20)[index], "07:00"), user_id: PH_SENTINELS.userEmail, payment_instrument_key: "pi-hammered", processor_merchant_id: PH_SENTINELS.rawMidUnlabelled, initiation_type: "mit", transaction_id: `ham-${index}` }));
  }
  // The import day (data_through = 2026-10-01): exported in the morning, so a part-day — a poor one (30% approval)
  // that no rule may read: the windows end the day before.
  rows.push(...partialDay("2026-10-01"));
  return rows;
}

/** A few morning attempts on `day`: the newest, partial day of an import. */
function partialDay(day: string): FixtureTx[] {
  return batch(day, 10, 3).map((row, index) => ({ ...row, event_time: T(day, `0${index % 6}:1${index % 6}`) }));
}

/**
 * Support requests: unauthorized-charge complaints from customers whose last settled payment was on Stripe MID #1
 * (2 in the baseline week, 30 in the current one), plus one ordinary request per day of `throughDays` — how far the
 * support pipeline has delivered (by default through the import day).
 */
function engineSupport(rows: FixtureTx[], throughDays: string[] = ["2026-10-01"]): FixtureSupport[] {
  const settled = (from: string, to: string) => rows.filter((row) => row.is_success && row.processor === "STRIPE" && row.processor_merchant_id === PH_SENTINELS.rawMidRegistered && row.event_time.slice(0, 10) >= from && row.event_time.slice(0, 10) <= to);
  const complaint = (row: FixtureTx, index: number, prefix: string): FixtureSupport => ({
    request_id: `${prefix}-${index}`, received_at: row.event_time.replace("T", "T").replace(/T(\d\d)/, "T23"), matched_user_id: row.user_id,
    possible_unauthorized_charge: 1, requires_refund: 0, duplicate_charge: 0, category: "Unauthorized or unexpected charge", classification_version: "v2",
  });
  const ordinary = (day: string): FixtureSupport => ({
    request_id: `sr-q-${day}`, received_at: T(day, "05:00"), matched_user_id: "", possible_unauthorized_charge: 0, requires_refund: 0, duplicate_charge: 0, category: "Question", classification_version: "v2",
  });
  return [
    ...settled("2026-09-17", "2026-09-23").slice(0, 2).map((row, index) => complaint(row, index, "sr-b")),
    ...settled("2026-09-24", "2026-09-30").slice(0, 30).map((row, index) => complaint(row, index, "sr-c")),
    ...throughDays.map(ordinary),
  ];
}

function enginePg(options: { rules?: Array<Record<string, unknown>>; accounts?: unknown[]; rpc?: Record<string, (params: Record<string, unknown>) => unknown> } = {}) {
  const rpc = Object.fromEntries(Object.entries(options.rpc ?? {}).map(([fn, handler]) => [fn, { tenantParam: "p_data_key", handler: async (params: Record<string, unknown>) => ({ data: handler(params), error: null }) }]));
  return createStrictFakeSupabase({
    tenantKey: PH_DATA_KEY,
    tables: {
      payment_alert_rules: { scope: "global", rows: options.rules ?? RULE_ROWS },
      psp_accounts: { scope: "tenant", owner: "auth_user_id", rows: (options.accounts ?? fixtureAccounts()) as Array<Record<string, unknown>> },
      clickhouse_cohort_snapshot_state: { scope: "tenant", owner: "auth_user_id", rows: [] },
      import_batches: { scope: "tenant", owner: "user_id", rows: [{ user_id: PH_DATA_KEY, imported_at: "2026-10-01T07:00:00.000Z", status: "completed", rows_total: 10, rows_inserted: 10, rows_updated: 0, source: "primer_csv" }] },
      clickhouse_transaction_sync_state: { scope: "tenant", owner: "auth_user_id", rows: [] },
    },
    rpc,
  });
}

describe("the engine over the fixture warehouse", () => {
  let evaluation: Awaited<ReturnType<typeof evaluateWorkspaceAlerts>>;
  let recording: ReturnType<typeof createRecordingClickHouse>;
  let pg: ReturnType<typeof enginePg>;

  beforeAll(async () => {
    resetPaymentHealthMemo();
    const rows = engineRows();
    recording = createRecordingClickHouse(fixtureWarehouse({ rows, support: engineSupport(rows) }).respond);
    pg = enginePg();
    evaluation = await evaluateWorkspaceAlerts({ tenantKey: PH_DATA_KEY, clickhouse: () => recording, pg: asPg(pg), clock: () => NOW });
  });

  it("reads through the runner's own statements only, every one bound to the workspace tenant", () => {
    expect(recording.statements.length).toBeGreaterThan(8);
    expect(recording.statements.every((statement) => statement.kind === "query")).toBe(true);
    expect(recording.boundTenants()).toEqual([PH_DATA_KEY]);
    const markers = new Set(recording.statements.map((statement) => /\/\* ph:(\w+) \*\//.exec(statement.query)?.[1]));
    for (const marker of ["registry", "declines_groups", "overview_groups", "attempt_rows", "coverage", "complaints"]) expect(markers.has(marker), marker).toBe(true);
    // One registry scan for the whole run (preloaded into every runner call).
    expect(recording.statements.filter((statement) => statement.query.includes("/* ph:registry */"))).toHaveLength(1);
    expect(pg.violations).toEqual([]);
    expect(evaluation.data_through).toBe("2026-10-01");
  });

  it("raises what the data shows and nothing else", () => {
    const summary = evaluation.candidates.map((candidate) => `${candidate.rule_key} ${candidate.scope_key.replace(/[0-9a-f-]{36}/, "<id>")} ${candidate.severity}/${candidate.data_confidence}`).sort();
    expect(summary).toEqual([
      "approval_drop account:ADYEN:<id>:cit info/low",
      "approval_drop account:STRIPE:<id>:cit critical/high",
      "excessive_reattempts tenant:rolling warning/high",
      "issuer_fraud_rise account:STRIPE:<id> critical/high",
      "post_ban_retries tenant:post_ban:mit warning/high",
      "refund_rate_rise account:STRIPE:<id> critical/high",
      "unauthorized_complaints_rise account:STRIPE:<id> critical/high",
    ]);
    const cleared = new Set(evaluation.cleared.map((entry) => `${entry.rule_key} ${entry.scope_key.replace(/[0-9a-f-]{36}/, "<id>")}`));
    for (const key of [
      "approval_drop account:STRIPE:<id>:mit",
      // Stripe carries two MIDs on MIT (the registered one and the unlabelled one): its PSP-wide MIT line is read, and flat.
      "approval_drop account:STRIPE:all:mit",
      "post_ban_retries tenant:post_ban:cit",
      "data_stale tenant:data_through",
      "data_stale tenant:warehouse_sync",
      "data_stale tenant:support_sync",
      "psp_integration_rise tenant:unrouted_and_integration",
    ]) {
      expect(cleared.has(key), key).toBe(true);
    }
    // Stripe CIT has one MID only: no PSP-wide line repeats its alert.
    expect([...cleared].some((key) => key.includes("STRIPE:all:cit"))).toBe(false);
    expect(evaluation.rules.every((entry) => entry.status === "evaluated")).toBe(true);
    // The import day is partial and out of every window: data_through 2026-10-01, windows end 2026-09-30.
    expect(evaluation.data_through).toBe("2026-10-01");
    for (const [ruleKey, window] of Object.entries(evaluation.windows)) expect(window.to < "2026-10-01", ruleKey).toBe(true);
    // The registered MIDs come with the key they had while unlabelled (opaque).
    const complaint = evaluation.candidates.find((candidate) => candidate.rule_key === "unauthorized_complaints_rise")!;
    expect(complaint.scope_aliases).toEqual([expect.stringMatching(/^account:STRIPE:unlabelled:[0-9a-f]{16}$/)]);
    expect(complaint.evidence).toMatchObject({ support_through: "2026-10-01", support_complete: true });
  });

  it("names the affected funnels of the strong account alerts (labels only) and none for low-confidence ones", () => {
    const drop = evaluation.candidates.find((candidate) => candidate.rule_key === "approval_drop" && candidate.severity === "critical")!;
    expect(drop.affected_funnels).toEqual(["Unattributed (no acquisition anchor)"]);
    expect(evaluation.candidates.find((candidate) => candidate.data_confidence === "low")!.affected_funnels).toEqual([]);
    expect(recording.statements.filter((statement) => statement.query.includes("/* ph:declines_groups */") && statement.params.p_fn_0 === undefined && Object.keys(statement.params).some((key) => key.startsWith("p_ma_"))).length).toBeGreaterThan(0);
  });

  it("no sentinel (raw MID, descriptor, instrument, e-mail, transaction id) reaches any alert", () => {
    expect(scanForLeaks(evaluation, { extra: Object.values(PH_SENTINELS) })).toEqual([]);
    for (const candidate of evaluation.candidates) {
      expect(JSON.stringify(candidate)).not.toMatch(/gen-u\d|gen-pi-|gen-tx-|ban-tx|ham-\d|pi-hammered|@/);
    }
  });
});

// =====================================================================================
// 5. End to end with the SQL functions (PGlite): dedup, auto-resolve, rate limit
// =====================================================================================

describe("end to end with payment_alerts_* on PGlite", () => {
  let h: SupabasePglite;
  let owner: string;

  beforeAll(async () => {
    const base = await createSupabasePglite({ migrations: listMigrations({ before: "202610050003_access_rls_lockdown.sql" }), extensionStubs: true });
    owner = await base.createAuthUser("owner@example.com", { id: PH_DATA_KEY });
    await base.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [owner]);
    for (const name of listMigrations().filter((migration) => migration >= "202610050003_access_rls_lockdown.sql" && migration <= "202610130001_payment_health_alerts.sql")) {
      await base.applyMigration(name);
    }
    h = base;
  }, 300_000);

  afterAll(async () => {
    await h?.close();
  });

  /** The engine's pg: the reads from the strict fake, the payment_alerts_* RPCs from PGlite as service_role. */
  function hybridPg() {
    const rpc = async (fn: string, params: Record<string, unknown>) => {
      const names = Object.keys(params);
      const args = names.map((name, index) => `${name} => $${index + 1}`).join(", ");
      const values = names.map((name) => (params[name] !== null && typeof params[name] === "object" ? JSON.stringify(params[name]) : params[name]));
      try {
        const result = await h.asService((tx) => tx.query<{ value: unknown }>(`select public.${fn}(${args}) as value`, values));
        return { data: result.rows[0]?.value ?? null, error: null };
      } catch (error) {
        return { data: null, error: { message: error instanceof Error ? error.message : String(error) } };
      }
    };
    const fake = enginePg();
    return { from: fake.from.bind(fake), rpc } as unknown as Parameters<typeof runPaymentRiskAlerts>[0]["pg"];
  }

  const alerts = () => h.db.query<{ rule_key: string; scope_key: string; alert_key: string; status: string; severity: string; auto_resolved: boolean; window_end: string }>(
    "select rule_key, scope_key, alert_key, status, severity, auto_resolved, window_end::text from public.payment_risk_alerts order by alert_key",
  ).then((result) => result.rows);
  const ageRuns = () => h.db.query("update public.payment_alert_runs set started_at = started_at - interval '1 hour', finished_at = coalesce(finished_at, now())");

  it("a run writes the alerts; the same window again deduplicates by alert_key; a run within the interval is refused; a later run auto-resolves what cleared", async () => {
    resetPaymentHealthMemo();
    const rows = engineRows();
    const run = (data: FixtureTx[], trigger: "cron" | "manual" = "cron", support = engineSupport(data)) =>
      runPaymentRiskAlerts({ tenantKey: PH_DATA_KEY, clickhouse: () => createRecordingClickHouse(fixtureWarehouse({ rows: data, support }).respond), pg: hybridPg(), trigger, actorUserId: trigger === "manual" ? owner : null, clock: () => NOW });

    const first = await run(rows);
    expect(first.run).toMatchObject({ status: "succeeded", data_through: "2026-10-01", counts: { inserted: 7, updated: 0, carried: 0 } });
    const written = await alerts();
    expect(written).toHaveLength(7);
    expect(new Set(written.map((row) => row.status))).toEqual(new Set(["new"]));

    // A person inside 5 minutes: 429; the scheduler inside a minute: skipped.
    await expect(run(rows, "manual")).rejects.toBeInstanceOf(PaymentAlertsRateLimitedError);
    await expect(run(rows, "cron")).resolves.toMatchObject({ run: null, skipped: "recent_run" });

    // The same data window again: refreshed in place, no duplicate rows; an owner status is kept.
    await ageRuns();
    const dropKey = written.find((row) => row.rule_key === "approval_drop" && row.severity === "critical")!.alert_key;
    await h.db.query("update public.payment_risk_alerts set status = 'investigating' where alert_key = $1", [dropKey]);
    const again = await run(rows);
    expect(again.run?.counts).toMatchObject({ inserted: 0, updated: 7, auto_resolved: 0 });
    expect(await alerts()).toHaveLength(7);
    expect((await alerts()).find((row) => row.alert_key === dropKey)?.status).toBe("investigating");

    // A week later the CIT approval on Stripe MID #1 is back to 70%: the open drop (investigating) is auto-resolved,
    // the conditions that still hold on the new window are carried forward (the same rows, the new window).
    // The payments are imported through 2026-10-08 (a part-day again), but the support import stopped on 2026-10-03.
    await ageRuns();
    const later = [...rows];
    for (const day of days("2026-10-01", 7)) later.push(...batch(day, 50, 35), ...batch(day, 40, 12, { initiation_type: "mit", ff_billing_reason: "renewal" }));
    later.push(...partialDay("2026-10-08"));
    const third = await run(later, "cron", engineSupport(later, ["2026-10-01", "2026-10-02", "2026-10-03"]));
    expect(third.run?.data_through).toBe("2026-10-08");
    const after = await alerts();
    const drop = after.find((row) => row.rule_key === "approval_drop" && row.scope_key.startsWith("account:STRIPE"))!;
    expect(drop).toMatchObject({ status: "resolved", auto_resolved: true, window_end: "2026-09-30" });
    // Resolved: the CIT drop and the fraud-code rise (clear on the new week). NOT resolved: the complaint rise — the new
    // week shows no complaints only because the support data stops on 2026-10-03 (inconclusive, the alert stays open).
    // Carried: the two retry alerts (still true over the new 30 days). Untouched: the Adyen info alert and the refund
    // alert (no new data).
    expect(third.run?.counts).toMatchObject({ inserted: 0, carried: 2, auto_resolved: 2 });
    const complaintsOutcome = third.run?.rules.find((entry) => entry.rule_key === "unauthorized_complaints_rise");
    expect(complaintsOutcome).toMatchObject({ status: "evaluated", candidates: 0, cleared: 0 });
    expect(complaintsOutcome?.inconclusive).toBeGreaterThan(0);
    expect(after.filter((row) => row.rule_key === "post_ban_retries" || row.rule_key === "excessive_reattempts").map((row) => [row.status, row.window_end])).toEqual([["new", "2026-10-07"], ["new", "2026-10-07"]]);
    expect(after.filter((row) => row.status === "new").map((row) => row.rule_key).sort()).toEqual(["approval_drop", "excessive_reattempts", "post_ban_retries", "refund_rate_rise", "unauthorized_complaints_rise"]);
    expect(after.find((row) => row.rule_key === "unauthorized_complaints_rise")).toMatchObject({ status: "new", auto_resolved: false, window_end: "2026-09-30" });
    const history = await h.db.query<{ history: Array<{ event: string; from: string; to: string }> }>("select status_history as history from public.payment_risk_alerts where alert_key = $1", [dropKey]);
    expect(history.rows[0].history.map((entry) => entry.event)).toEqual(["raised", "auto_resolved"]);
    expect(history.rows[0].history[1]).toMatchObject({ from: "investigating", to: "resolved" });
    // Never more rows than conditions: carried alerts moved to the new window instead of duplicating.
    expect(after.length).toBeLessThanOrEqual(written.length + (third.run?.counts?.inserted ?? 0));

    // The support import catches up (through 2026-10-08): the same quiet week is now a conclusive "no rise".
    await ageRuns();
    const fourth = await run(later, "cron", engineSupport(later, days("2026-10-01", 8)));
    expect(fourth.run?.counts).toMatchObject({ inserted: 0, auto_resolved: 1 });
    expect((await alerts()).find((row) => row.rule_key === "unauthorized_complaints_rise")).toMatchObject({ status: "resolved", auto_resolved: true });
    const runs = await h.db.query<{ status: string; trigger: string }>("select status, trigger from public.payment_alert_runs order by started_at");
    expect(runs.rows.map((row) => row.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  }, 120_000);

  /** One run of the SQL functions over a pure evaluation (claim → apply), as runPaymentRiskAlerts sends it. */
  async function applyEvaluation(evaluation: AlertEvaluation): Promise<Record<string, number>> {
    await ageRuns();
    const claim = await h.asService((tx) => tx.query<{ value: Record<string, unknown> }>("select public.payment_alerts_claim_run($1, 'cron', null, 0) as value", [PH_DATA_KEY]));
    const runId = claim.rows[0].value.run_id;
    expect(runId).toBeTruthy();
    const applied = await h.asService((tx) => tx.query<{ value: Record<string, number> }>(
      "select public.payment_alerts_apply_run($1, $2, $3::jsonb, $4::jsonb, '{}'::jsonb, $5::date) as value",
      [runId, PH_DATA_KEY, JSON.stringify(evaluation.candidates), JSON.stringify(evaluation.cleared), evaluation.data_through],
    ));
    return applied.rows[0].value;
  }

  const alertsOfScope = (scopeKey: string) =>
    h.db.query<{ id: string; status: string; assignee: string | null; window_end: string; severity: string; auto_resolved: boolean }>(
      "select id, status, assignee, window_end::text, severity, auto_resolved from public.payment_risk_alerts where scope_key = $1 order by first_seen_at",
      [scopeKey],
    ).then((result) => result.rows);

  it("hysteresis: an investigating alert survives a later window whose move is above the threshold but not significant, and is carried on the next significant one", async () => {
    const MIDH = { key: "aaaa0000-0000-4000-8000-0000000000e1", label: "Stripe MID #9", processor: "STRIPE", labelled: true };
    const scopeKey = `account:STRIPE:${MIDH.key}:cit`;
    const evaluationOn = (dataThrough: string, current: Totals, baseline: Totals) => {
      const window = ruleWindow(rule("approval_drop"), dataThrough);
      return evaluateAlertRules([rule("approval_drop")], dataSet({
        [approvalRequestKey(window, "cit")]: declinesByAccount([{ account: MIDH, current, baseline }]),
        [approvalRequestKey(window, "mit")]: declinesByAccount([]),
      }, { data_through: dataThrough }));
    };
    // 1. 70% → 50% on 400 attempts: critical; the owner starts investigating.
    expect(await applyEvaluation(evaluationOn("2026-10-01", { attempts: 400, successes: 200 }, { attempts: 400, successes: 280 }))).toMatchObject({ inserted: 1 });
    const [raised] = await alertsOfScope(scopeKey);
    await h.db.query("update public.payment_risk_alerts set status = 'investigating', assignee = $1 where id = $2", [owner, raised.id]);
    // 2. The next window: 70% → 59.3% on 300 attempts — 10.7 pp, past the thresholds, but the intervals overlap.
    const overlapping = evaluationOn("2026-10-02", { attempts: 300, successes: 178 }, { attempts: 300, successes: 210 });
    expect(overlapping.candidates).toEqual([]);
    expect(overlapping.cleared.filter((entry) => entry.scope_key === scopeKey)).toEqual([]);
    expect(await applyEvaluation(overlapping)).toMatchObject({ inserted: 0, auto_resolved: 0 });
    expect(await alertsOfScope(scopeKey)).toEqual([{ ...raised, status: "investigating", assignee: owner }]);
    // 3. Significant again: the same row continues on the new window (carried, not a new alert), status and assignee kept.
    expect(await applyEvaluation(evaluationOn("2026-10-03", { attempts: 400, successes: 196 }, { attempts: 400, successes: 280 }))).toMatchObject({ inserted: 0, carried: 1 });
    expect(await alertsOfScope(scopeKey)).toEqual([{ id: raised.id, status: "investigating", assignee: owner, window_end: "2026-10-02", severity: "critical", auto_resolved: false }]);
  }, 60_000);

  it("excessive re-attempts: a new violator cut from the 100-pair list is not suppressed by an owner-dismissed alert of older evidence", async () => {
    await h.db.query("delete from public.payment_risk_alerts where rule_key = 'excessive_reattempts'");
    const windows = Array.from({ length: 100 }, (_, index) => ({ max_declines: 17 + (index % 3), window_end: "2026-09-17T06:00:00.000Z", merchant_account: MID1 }));
    const evaluationOf = (dataThrough: string, newest: string) => {
      const window = ruleWindow(rule("excessive_reattempts"), dataThrough);
      return evaluateAlertRules([rule("excessive_reattempts")], dataSet({ [retriesRequestKey(window)]: retries({ violations: 101, windows, rollingListCut: true, newestViolationEnd: newest }) }, { data_through: dataThrough }));
    };
    // The owner dismissed the alert on the window ending 2026-09-20 (its evidence: the 100 pairs, ending 2026-09-17).
    expect(await applyEvaluation(evaluationOf("2026-09-21", "2026-09-17T06:00:00.000Z"))).toMatchObject({ inserted: 1 });
    await h.db.query("update public.payment_risk_alerts set status = 'dismissed' where scope_key = 'tenant:rolling'");
    // Ten days later a 101st pair crossed the limit on 2026-09-27 — with the fewest declines, so outside the list.
    const fresh = evaluationOf("2026-10-01", "2026-09-27T06:30:00.000Z");
    expect(fresh.candidates[0].newest_event_day).toBe("2026-09-27");
    expect(await applyEvaluation(fresh)).toMatchObject({ suppressed: 0, inserted: 1 });
    expect((await alertsOfScope("tenant:rolling")).map((row) => [row.window_end, row.status])).toEqual([["2026-09-20", "dismissed"], ["2026-09-30", "new"]]);
  }, 60_000);
});
