// Access of the clickhouse-payment-health Edge function (Payment System Health
// P2, plan sections X and Z #17-18). The policy is driven through the pure
// gate core (handleWithAccess) with fake dependencies and the REAL runner
// behind it over a ScopedReader on the recording ClickHouse, so these tests
// prove: the policy table; the data owner and a payment_health.view holder are
// served; a viewer without the key gets 403 permission_denied; every
// funnel-restricted context gets 403 scope_not_supported even while holding
// the key; the PSP dimensions are stripped / refused without
// payment_health.psp_global.view; every statement binds the workspace tenant;
// a ScopeViolation is never swallowed; no write reaches the warehouse; no
// sentinel (e-mail, raw MID, descriptor, token, transaction id, Postgres error
// text) reaches any response.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertValidPolicy, type AccessHandler, type AccessRequest } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import { ENFORCED_PERMISSION_KEYS, PRIVILEGED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  CLICKHOUSE_PAYMENT_HEALTH_POLICY,
  alertsManageable,
  normalizeClickHousePaymentHealthAction,
  paymentHealthErrorResponse,
  pspDimensionsVisible,
} from "../../supabase/functions/_shared/access/policies/clickhouse-payment-health.ts";
import {
  DEFAULT_ALERT_RULES,
  PAYMENT_ALERT_USER_ACTIONS,
  PaymentAlertNotFoundError,
  PaymentAlertTransitionError,
  PaymentAlertsRateLimitedError,
  isPaymentAlertAction,
} from "../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract.ts";
import { runPaymentAlertsAction } from "../../supabase/functions/_shared/clickhouse/paymentRiskAlerts.ts";
import { buildAlertExplanation } from "../../supabase/functions/_shared/clickhouse/paymentRiskRecommendations.ts";
import { createStrictFakeSupabase, type StrictFakeSupabase } from "./support/strictFakeSupabase";
import { CLICKHOUSE_SUMMARY_POLICY, WAREHOUSE_PROBE_VIEW_PERMISSIONS } from "../../supabase/functions/_shared/access/policies/clickhouse-summary.ts";
import { ROUTE_ACCESS } from "../services/accessRoutes";
import { PAYMENT_HEALTH_ACTIONS, PaymentHealthPermissionError, PaymentHealthRequestError } from "../../supabase/functions/_shared/clickhouse/paymentHealthContract.ts";
import { resetPaymentHealthMemo, runPaymentHealth } from "../../supabase/functions/_shared/clickhouse/paymentHealth.ts";
import { CRON_SECRETS, DATA_KEY, PERSONAS, callGate, contextFor, edgeRequest, fakeGate, withGrant, withScope, type Persona } from "./support/accessFixtures";
import { createRecordingClickHouse } from "./support/recordingClickHouse";
import { SENTINEL_EMAILS, scanForLeaks } from "./support/leakScan";
import { PH_DATA_KEY, PH_SENTINELS, asPg, fixtureAccounts, fixturePg, fixtureRows, fixtureWarehouse } from "./support/paymentHealthFixtures";

const ACTIONS = [...PAYMENT_HEALTH_ACTIONS];
const RANGE = { date_from: "2026-09-01", date_to: "2026-09-30" };
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const SENTINELS = [...Object.values(PH_SENTINELS), SENTINEL_EMAILS[1], "secret-cursor"];
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

const ALERT_ACTIONS = [...PAYMENT_ALERT_USER_ACTIONS];

const viewHolder = withGrant(PERSONAS.viewer, ["payment_health.view"], { name: "ph-view" });
const pspHolder = withGrant(PERSONAS.viewer, ["payment_health.view", "payment_health.psp_global.view"], { name: "ph-psp" });
const manageHolder = withGrant(PERSONAS.viewer, ["payment_health.view", "payment_health.manage_alerts"], { name: "ph-manage" });
const fullAlertHolder = withGrant(PERSONAS.viewer, ["payment_health.view", "payment_health.manage_alerts", "payment_health.psp_global.view"], { name: "ph-manage-psp" });

/** The index.ts handler, verbatim in behaviour: the real runner over the request's ScopedReader and the strict pg fake. */
function runnerHandler(pg = fixturePg()): AccessHandler<string> {
  return (async ({ ctx, action, body, clickhouse }: AccessRequest<string>) =>
    runPaymentHealth({ tenantKey: ctx.tenantKey, clickhouse: clickhouse(), pg: asPg(pg), request: { ...RANGE, ...body, action }, pspVisible: pspDimensionsVisible(ctx), clock: () => NOW })) as AccessHandler<string>;
}

function gateFor(persona: Persona) {
  const warehouse = fixtureWarehouse({ rows: fixtureRows() });
  const clickhouse = createRecordingClickHouse(warehouse.respond);
  return { ...fakeGate({ persona, clickhouse }), warehouse };
}

async function call(persona: Persona, body: Record<string, unknown>, handler: AccessHandler<string> = runnerHandler()) {
  const gate = gateFor(persona);
  const result = await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, handler, edgeRequest({ fn: "clickhouse-payment-health", body }).req, gate.deps, { onError: paymentHealthErrorResponse });
  return { ...result, gate };
}

beforeEach(() => resetPaymentHealthMemo());

describe("policy table", () => {
  it("is valid, POST-only, with the alerts_tick cron branch; every page action needs payment_health.view and nothing else", () => {
    expect(() => assertValidPolicy(CLICKHOUSE_PAYMENT_HEALTH_POLICY)).not.toThrow();
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.fn).toBe("clickhouse-payment-health");
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.methods).toEqual(["POST"]);
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.cron).toEqual({ header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["alerts_tick"] });
    expect(Object.keys(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions).sort()).toEqual([...ACTIONS, ...ALERT_ACTIONS, "alerts_tick"].sort());
    for (const action of ACTIONS) expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions[action]).toEqual({ anyOf: ["payment_health.view"] });
    // P2.5: reading alerts is a view; changing them and running the engine need the privileged manage key (a write);
    // the tick is reachable only through the cron branch (its user-side entry is owner + raw + manage, never reachable).
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions.alerts_list).toEqual({ anyOf: ["payment_health.view"] });
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions.alert_update).toEqual({ allOf: ["payment_health.manage_alerts"], write: true });
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions.alerts_run).toEqual({ allOf: ["payment_health.manage_alerts"], write: true });
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions.alerts_tick).toEqual({ ownerOnly: true, rawOnly: true, allOf: ["payment_health.manage_alerts"], write: true });
    // Not scopeReady, not rawOnly: restricted members are refused like Payment Pass; the privileged keys gate dimensions, not actions.
    for (const [action, rule] of Object.entries(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions)) {
      expect(rule.scopeReady, action).toBeUndefined();
      if (action === "alerts_tick") continue;
      expect(rule.rawOnly, action).toBeUndefined();
      expect(rule.ownerOnly, action).toBeUndefined();
      if (!["alert_update", "alerts_run"].includes(action)) expect(rule.write, action).toBeUndefined();
    }
    expect(alertsManageable(contextFor(PERSONAS.owner))).toBe(true);
    expect(alertsManageable(contextFor(manageHolder))).toBe(true);
    expect(alertsManageable(contextFor(viewHolder))).toBe(false);
    // A narrowed member never holds the privileged manage key.
    expect(alertsManageable(contextFor(withScope(manageHolder, PERSONAS.buyerA.scope)))).toBe(false);
    expect(ENFORCED_PERMISSION_KEYS).toContain("payment_health.view");
    expect(PRIVILEGED_PERMISSION_KEYS.has("payment_health.psp_global.view")).toBe(true);
    expect(PRIVILEGED_PERMISSION_KEYS.has("payment_health.manage_alerts")).toBe(true);
    expect(PRIVILEGED_PERMISSION_KEYS.has("payment_health.view")).toBe(false);
  });

  it("normalizes exactly the six page actions and the three user alert actions and rejects everything else (no default); the cron branch runs the tick only", () => {
    for (const action of [...ACTIONS, ...ALERT_ACTIONS]) expect(normalizeClickHousePaymentHealthAction({ action })).toBe(action);
    for (const body of [{}, { action: "" }, { action: "analytics" }, { action: "OVERVIEW" }, { action: ["overview"] }, { action: "cron_tick" }, { action: "alerts_tick" }, { action: "ALERTS_LIST" }]) {
      expect(() => normalizeClickHousePaymentHealthAction(body)).toThrow(ActionNormalizeError);
    }
    for (const body of [{}, { action: null }, { action: "alerts_tick" }]) expect(normalizeClickHousePaymentHealthAction(body, true)).toBe("alerts_tick");
    for (const body of [{ action: "overview" }, { action: "alerts_run" }, { action: "alert_update" }, { action: "cron_tick" }]) {
      expect(() => normalizeClickHousePaymentHealthAction(body, true)).toThrow(ActionNormalizeError);
    }
  });

  it("maps the runner's errors: malformed request 400, PSP dimension without the key 403 permission_denied, anything else to the gate", () => {
    expect(paymentHealthErrorResponse(new PaymentHealthRequestError("bad"))).toEqual({ status: 400, body: { ok: false, error_code: "invalid_request", error: "bad" } });
    expect(paymentHealthErrorResponse(new PaymentHealthPermissionError("psp"))).toEqual({ status: 403, body: { ok: false, error_code: ACCESS_ERROR.PERMISSION_DENIED, error: "psp" } });
    expect(paymentHealthErrorResponse(new PaymentAlertNotFoundError())).toEqual({ status: 404, body: { ok: false, error_code: "alert_not_found", error: "Alert not found." } });
    expect(paymentHealthErrorResponse(new PaymentAlertTransitionError("dismissed", "resolved"))).toMatchObject({ status: 400, body: { ok: false, error_code: "invalid_transition", from: "dismissed", to: "resolved" } });
    expect(paymentHealthErrorResponse(new PaymentAlertsRateLimitedError(120))).toMatchObject({ status: 429, body: { ok: false, error_code: "rate_limited", retry_after_seconds: 120 } });
    expect(paymentHealthErrorResponse(new Error("boom"))).toBeNull();
    expect(paymentHealthErrorResponse(new ScopeViolation("tenant_param_mismatch"))).toBeNull();
  });

  it("the PSP dimensions are visible to the data owner and the privileged key only", () => {
    expect(pspDimensionsVisible(contextFor(PERSONAS.owner))).toBe(true);
    expect(pspDimensionsVisible(contextFor(pspHolder))).toBe(true);
    expect(pspDimensionsVisible(contextFor(viewHolder))).toBe(false);
    expect(pspDimensionsVisible(contextFor(withGrant(PERSONAS.viewer, ENFORCED_PERMISSION_KEYS.filter((key) => key !== "payment_health.psp_global.view"))))).toBe(false);
    // A narrowed member never holds the privileged key, whatever the role says.
    expect(pspDimensionsVisible(contextFor(withScope(pspHolder, PERSONAS.buyerA.scope)))).toBe(false);
    // No shipped template holds the module's keys: the owner adds them to Admin by hand (plan decision 3 / 10).
    for (const template of ROLE_TEMPLATES.filter((entry) => entry.key !== "admin")) {
      expect(template.permissions.filter((key) => key.startsWith("payment_health.")), template.key).toEqual([]);
    }
    expect(ROLE_TEMPLATES.find((entry) => entry.key === "admin")?.permissions).toContain("payment_health.psp_global.view");
  });
});

describe("gate decisions", () => {
  it.each(ACTIONS)("%s: the data owner and a payment_health.view holder are served from the data key; a viewer without the key is 403 before the handler", async (action) => {
    for (const persona of [PERSONAS.owner, viewHolder, pspHolder]) {
      const served = await call(persona, { action });
      expect(served.status, `${persona.name} ${action}: ${served.text.slice(0, 200)}`).toBe(200);
      expect(served.json).toMatchObject({ ok: true, action });
      expect(served.gate.clickhouse.statements.length).toBeGreaterThan(0);
      expect(served.gate.clickhouse.boundTenants()).toEqual([PH_DATA_KEY]);
      expect(served.gate.clickhouse.statements.every((statement) => statement.kind === "query")).toBe(true);
      expect(scanForLeaks(served.json, { extra: SENTINELS })).toEqual([]);
      expect(served.gate.clickhouse.closed).toBe(1);
    }
    for (const persona of [PERSONAS.viewer, withGrant(PERSONAS.admin, ENFORCED_PERMISSION_KEYS.filter((key) => key !== "payment_health.view"), { name: "admin-without-view" })]) {
      const denied = await call(persona, { action });
      expect(denied.status, persona.name).toBe(403);
      expect(denied.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
      expect(denied.gate.clickhouse.statements).toEqual([]);
    }
  });

  it.each(ACTIONS)("%s: every funnel-restricted context holding the key is 403 scope_not_supported with no query (the owner narrowed too)", async (action) => {
    const restricted = [
      withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS, { name: "buyer-{A}" }),
      withGrant(PERSONAS.emptyGrant, ENFORCED_PERMISSION_KEYS, { name: "empty-grant" }),
      withGrant(PERSONAS.noRule, ENFORCED_PERMISSION_KEYS, { name: "no-rule" }),
      withScope(PERSONAS.owner, PERSONAS.buyerA.scope, "data-owner@{A}"),
    ];
    for (const persona of restricted) {
      const denied = await call(persona, { action });
      expect(denied.status, persona.name).toBe(403);
      expect(denied.json?.error_code, persona.name).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
      expect(denied.gate.clickhouse.statements).toEqual([]);
    }
    const disabled = await call(PERSONAS.disabled, { action });
    expect(disabled.status).toBe(403);
    expect(disabled.json?.error_code).toBe(ACCESS_ERROR.MEMBERSHIP_DISABLED);
  });

  it("an unknown or missing action is 400 unknown_action, never a default tab", async () => {
    for (const body of [{}, { action: "analytics" }, { filters: { funnel: ["x"] } }]) {
      const denied = await call(PERSONAS.owner, body);
      expect(denied.status).toBe(400);
      expect(denied.json?.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });

  it("a malformed request is 400 invalid_request for everyone; the message is sanitized for employees", async () => {
    const owner = await call(PERSONAS.owner, { action: "overview", date_from: "2026/09/01" });
    expect(owner.status).toBe(400);
    expect(owner.json).toMatchObject({ ok: false, error_code: "invalid_request", error: expect.stringMatching(/Invalid date_from/) });
    const employee = await call(viewHolder, { action: "overview", date_from: "2026/09/01" });
    expect(employee.status).toBe(400);
    expect(employee.json?.error_code).toBe("invalid_request");
    expect(String(employee.json?.error)).not.toMatch(/date_from/);
  });
});

describe("PSP dimensions behind payment_health.psp_global.view", () => {
  it("a view-only member gets the tabs with the PSP × MID table, the registry options and the account references stripped", async () => {
    const overview = await call(viewHolder, { action: "overview" });
    expect(overview.json).toMatchObject({ ok: true, psp_mid_rows: [], meta: { psp_global_visible: false } });
    expect((overview.json?.totals as { current: { attempts: number } }).current.attempts).toBe(16);
    expect((overview.json?.what_changed as Array<{ dimension: string }>).map((row) => row.dimension)).not.toContain("merchant_account");
    const options = await call(viewHolder, { action: "options" });
    expect(options.json?.options).toMatchObject({ processor: [], merchant_account: [], descriptor: [] });
    expect((options.json?.options as { funnel: unknown[] }).funnel.length).toBeGreaterThan(0);
    const retries = await call(viewHolder, { action: "retries" });
    for (const row of retries.json?.post_ban_attempts as Array<{ processor: unknown; merchant_account: unknown }>) expect(row).toMatchObject({ processor: null, merchant_account: null });
    const refunds = await call(viewHolder, { action: "refunds_support" });
    expect((refunds.json?.complaints as { by_account: unknown[] }).by_account).toEqual([]);
    for (const result of [overview, options, retries, refunds]) expect(scanForLeaks(result.json, { extra: SENTINELS })).toEqual([]);

    // The privileged key (full scope) and the data owner see them.
    const full = await call(pspHolder, { action: "overview" });
    expect((full.json?.psp_mid_rows as unknown[]).length).toBe(4);
    expect(full.json?.meta).toMatchObject({ psp_global_visible: true });
    expect(scanForLeaks(full.json, { extra: SENTINELS })).toEqual([]);
  });

  it("naming a PSP filter or dimension without the key is 403 permission_denied after the gate, with no attempt read", async () => {
    for (const body of [
      { action: "declines", dimension: "processor" },
      { action: "declines", dimension: "merchant_account" },
      { action: "refunds_support", dimension: "descriptor" },
      { action: "overview", filters: { processor: ["STRIPE"] } },
      { action: "refunds_support", filters: { merchant_account: ["aaaa0000-0000-4000-8000-00000000a001"] } },
      { action: "retries", filters: { processor: ["ADYEN"] } },
    ]) {
      const denied = await call(viewHolder, body);
      expect(denied.status, JSON.stringify(body)).toBe(403);
      expect(denied.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
      expect(denied.gate.clickhouse.statements).toEqual([]);
      // The refusal is raised inside the handler, yet counted (§24) and logged as a denial, not a handler failure.
      expect(denied.gate.deps.recordDenial).toHaveBeenCalledWith(expect.objectContaining({ fn: "clickhouse-payment-health", action: body.action, errorCode: ACCESS_ERROR.PERMISSION_DENIED }));
      expect(denied.gate.deps.log).not.toHaveBeenCalledWith("error", "handler_failed", expect.anything());
      // ...while the same request is served to the key holder.
      const served = await call(pspHolder, body);
      expect(served.status, JSON.stringify(body)).toBe(200);
      expect(served.gate.deps.recordDenial).not.toHaveBeenCalled();
    }
    // An opaque id the registry does not know is refused before the key check matters: 400 for the key holder too.
    const unknown = await call(pspHolder, { action: "retries", filters: { descriptor: ["d:0123456789abcdef"] } });
    expect(unknown.status).toBe(400);
    expect(unknown.json?.error_code).toBe("invalid_request");
  });
});

describe("runner through the ScopedReader", () => {
  it("binds the workspace tenant; a runner handed another tenant is a violation and the gate answers 500 scope_violation", async () => {
    const ctx = contextFor(viewHolder);
    const warehouse = fixtureWarehouse({ rows: fixtureRows() });
    const recording = createRecordingClickHouse(warehouse.respond);
    await expect(runPaymentHealth({ tenantKey: EMPLOYEE, clickhouse: createScopedReader(ctx, recording), pg: asPg(fixturePg()), request: { ...RANGE, action: "overview" }, pspVisible: false, clock: () => NOW })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toContain("tenant_param_mismatch");
    expect(recording.statements).toEqual([]);

    const forwarding: AccessHandler<string> = (async ({ clickhouse, body }: AccessRequest<string>) =>
      runPaymentHealth({ tenantKey: String(body.auth_user_id ?? EMPLOYEE), clickhouse: clickhouse(), pg: asPg(fixturePg()), request: { ...RANGE, action: "overview" }, pspVisible: true, clock: () => NOW })) as AccessHandler<string>;
    const failed = await call(PERSONAS.owner, { action: "overview", auth_user_id: EMPLOYEE }, forwarding);
    expect(failed.status).toBe(500);
    expect(failed.json?.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
    expect(failed.gate.clickhouse.statements).toEqual([]);
  });

  it("a ScopeViolation from any statement is rethrown (never degraded) and the response is 500 scope_violation without a body leak", async () => {
    for (const marker of ["ph:registry", "ph:overview_groups", "ph:complaints", "ph:attempt_rows"]) {
      const warehouse = fixtureWarehouse({ rows: fixtureRows() });
      const clickhouse = createRecordingClickHouse((statement) => {
        if (statement.query.includes(marker)) throw new ScopeViolation("restricted_protected_table", "analytics_transactions");
        return warehouse.respond(statement);
      });
      const gate = fakeGate({ persona: PERSONAS.owner, clickhouse });
      const action = marker === "ph:attempt_rows" ? "retries" : marker === "ph:complaints" ? "refunds_support" : "overview";
      const result = await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, runnerHandler(), edgeRequest({ fn: "clickhouse-payment-health", body: { action } }).req, gate.deps, { onError: paymentHealthErrorResponse });
      expect(result.status, marker).toBe(500);
      expect(result.json?.error_code, marker).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
    }
  });

  it("a warehouse fault is 502 with a generic body for employees and the detailed one for the data owner; no SQL text reaches anyone", async () => {
    const failing = () => createRecordingClickHouse(() => { throw new Error("DB::Exception: Missing columns while processing query: SELECT leak_sentinel_column"); });
    const employee = fakeGate({ persona: viewHolder, clickhouse: failing() });
    const sanitized = await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, runnerHandler(), edgeRequest({ fn: "clickhouse-payment-health", body: { action: "overview" } }).req, employee.deps, { onError: paymentHealthErrorResponse });
    expect(sanitized.status).toBe(502);
    expect(sanitized.json?.error_code).toBe(ACCESS_ERROR.UPSTREAM_ERROR);
    expect(scanForLeaks(sanitized.json)).toEqual([]);
    const owner = fakeGate({ persona: PERSONAS.owner, clickhouse: failing() });
    const detailed = await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, runnerHandler(), edgeRequest({ fn: "clickhouse-payment-health", body: { action: "overview" } }).req, owner.deps, { onError: paymentHealthErrorResponse });
    expect(detailed.status).toBe(502);
    expect(String(detailed.json?.error)).toContain("Missing columns");
  });

  it("the Postgres registry read is filtered on the data key, and a missing registry fails the request instead of inventing labels", async () => {
    const served = await call(PERSONAS.owner, { action: "options" });
    const pg = fixturePg();
    const handler: AccessHandler<string> = runnerHandler(pg);
    await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, handler, edgeRequest({ fn: "clickhouse-payment-health", body: { action: "options" } }).req, gateFor(PERSONAS.owner).deps, { onError: paymentHealthErrorResponse });
    expect(pg.violations).toEqual([]);
    expect(pg.callsTo("psp_accounts").map((entry) => entry.filters)).toEqual([[["eq", "auth_user_id", PH_DATA_KEY]]]);
    expect(pg.callsTo("clickhouse_cohort_snapshot_state")[0].filters).toContainEqual(["eq", "auth_user_id", PH_DATA_KEY]);
    expect(served.status).toBe(200);
  });
});

// =====================================================================================
// P2.5 alerts: alerts_list, alert_update, alerts_run, the alerts_tick cron
// =====================================================================================

const ALERT_IDS = {
  psp: "aaaa0000-0000-4000-8000-0000000000a1",
  tenant: "aaaa0000-0000-4000-8000-0000000000a2",
  resolved: "aaaa0000-0000-4000-8000-0000000000a3",
} as const;

function alertRow(id: string, overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id, auth_user_id: PH_DATA_KEY, rule_key: "approval_drop", alert_key: `k-${id}`, scope_key: `s-${id}`, severity: "warning", status: "new",
    scope: {}, affected_funnels: [], metric: "attempt_approval_rate", unit: "rate", current_value: 0.5, baseline_value: 0.7, change_value: -20, sample_size: 400,
    data_confidence: "high", window_start: "2026-09-24", window_end: "2026-09-30", evidence: {}, explanation: buildAlertExplanation("approval_drop", { account: "x" }),
    first_seen_at: "2026-10-01T07:40:00.000Z", last_seen_at: "2026-10-05T07:40:00.000Z", resolved_at: null, auto_resolved: false, assignee: null,
    status_history: [{ at: "2026-10-01T07:40:00.000Z", event: "raised", from: null, to: "new", by: null, auto: true, note: null }], updated_by: null, updated_at: "2026-10-05T07:40:00.000Z",
    psp_scoped: false, ...overrides,
  };
}

/** Three alerts: a PSP-scoped approval drop, a tenant-wide post-ban line (with per-account evidence) and a resolved freshness one. */
function alertRows(): Array<Record<string, unknown>> {
  return [
    alertRow(ALERT_IDS.psp, {
      severity: "critical", psp_scoped: true,
      scope: { kind: "account", processor: { key: "STRIPE", label: "Stripe" }, merchant_account: { key: "aaaa0000-0000-4000-8000-00000000a001", label: "Stripe MID #1", processor: "STRIPE", labelled: true }, initiation: "cit" },
    }),
    alertRow(ALERT_IDS.tenant, {
      rule_key: "post_ban_retries", metric: "post_ban_attempts", unit: "count", current_value: 2, baseline_value: null, change_value: null,
      scope: { kind: "tenant", subject: "post_ban", initiation: "mit" },
      evidence: { count: 2, by_account: [{ processor: { key: "STRIPE", label: "Stripe" }, merchant_account: { key: "aaaa0000-0000-4000-8000-00000000a001", label: "Stripe MID #1" }, count: 2 }] },
      explanation: buildAlertExplanation("post_ban_retries", { count: 2 }, "mit"),
    }),
    alertRow(ALERT_IDS.resolved, { rule_key: "data_stale", metric: "data_lag_days", unit: "days", status: "resolved", resolved_at: "2026-10-04T07:40:00.000Z", auto_resolved: true, scope: { kind: "tenant", subject: "data_through" }, last_seen_at: "2026-10-04T07:40:00.000Z" }),
  ];
}

interface AlertPgOptions {
  claim?: Record<string, unknown>;
  updateError?: string;
  /**
   * More payment_risk_alerts rows, BEFORE the three of alertRows(): the fake ignores .order(), so table order is
   * the read order — these stand for rows a newest-first read returns first.
   */
  extraRows?: Array<Record<string, unknown>>;
}

/** The service-role Postgres of the alert actions: the alert tables, the runner's tables, the four SQL functions (recorded). */
function alertPg(options: AlertPgOptions = {}): StrictFakeSupabase {
  const rows = [...(options.extraRows ?? []), ...alertRows()];
  return createStrictFakeSupabase({
    tenantKey: PH_DATA_KEY,
    tables: {
      payment_risk_alerts: { scope: "tenant", owner: "auth_user_id", rows },
      payment_alert_runs: { scope: "tenant", owner: "auth_user_id", rows: [{ id: "run-1", auth_user_id: PH_DATA_KEY, trigger: "cron", status: "succeeded", started_at: "2026-10-05T07:40:00.000Z", finished_at: "2026-10-05T07:40:20.000Z", data_through: "2026-10-03", summary: { candidates: 2, by_severity: { info: 0, warning: 1, critical: 1 }, applied: { inserted: 2 }, windows: {}, rules: [] }, error: "DB::Exception: secret warehouse text" }] },
      payment_alert_rules: { scope: "global", rows: DEFAULT_ALERT_RULES.map((rule) => ({ ...rule })) },
      psp_accounts: { scope: "tenant", owner: "auth_user_id", rows: fixtureAccounts() },
      clickhouse_cohort_snapshot_state: { scope: "tenant", owner: "auth_user_id", rows: [] },
      import_batches: { scope: "tenant", owner: "user_id", rows: [] },
      clickhouse_transaction_sync_state: { scope: "tenant", owner: "auth_user_id", rows: [] },
    },
    rpc: {
      payment_alert_update_status: {
        tenantParam: "p_data_key",
        handler: (params) => {
          if (options.updateError) return { data: null, error: { message: options.updateError } };
          const row = rows.find((entry) => entry.id === params.p_alert_id)!;
          return { data: { ...row, status: params.p_status, assignee: params.p_status === "investigating" ? row.assignee ?? params.p_actor : row.assignee, updated_by: params.p_actor }, error: null };
        },
      },
      payment_alerts_claim_run: { tenantParam: "p_data_key", handler: () => ({ data: options.claim ?? { claimed: true, run_id: "run-2", started_at: "2026-10-06T12:00:00.000Z" }, error: null }) },
      payment_alerts_apply_run: { tenantParam: "p_data_key", handler: () => ({ data: { inserted: 3, updated: 0, carried: 0, reopened: 0, suppressed: 0, auto_resolved: 1 }, error: null }) },
      payment_alerts_fail_run: { tenantParam: "p_data_key" },
    },
  });
}

/** The index.ts handler, verbatim in behaviour: alert actions to runPaymentAlertsAction (the reader factory, not a reader), the rest to the runner. */
function indexHandler(pg: StrictFakeSupabase): AccessHandler<string> {
  return (async ({ ctx, action, body, clickhouse }: AccessRequest<string>) =>
    isPaymentAlertAction(action)
      ? runPaymentAlertsAction({ action, tenantKey: ctx.tenantKey, actorUserId: ctx.actor.userId, pspVisible: pspDimensionsVisible(ctx), canManage: alertsManageable(ctx), requestId: ctx.requestId, body, clickhouse, pg: asPg(pg), clock: () => NOW })
      : runPaymentHealth({ tenantKey: ctx.tenantKey, clickhouse: clickhouse(), pg: asPg(pg), request: { ...RANGE, ...body, action }, pspVisible: pspDimensionsVisible(ctx), clock: () => NOW })) as AccessHandler<string>;
}

async function alertCall(persona: Persona, body: Record<string, unknown>, options: AlertPgOptions = {}) {
  const pg = alertPg(options);
  const gate = gateFor(persona);
  const writeAudit = vi.fn(async () => ({ data: 1, error: null }));
  const deps = { ...gate.deps, writeAudit };
  const result = await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, indexHandler(pg), edgeRequest({ fn: "clickhouse-payment-health", body }).req, deps, { onError: paymentHealthErrorResponse });
  return { ...result, gate, pg, writeAudit };
}

const rpcCalls = (pg: StrictFakeSupabase, fn: string) => pg.rpcCalls.filter((call) => call.fn === fn);

describe("P2.5 alerts_list", () => {
  it("a payment_health.view holder lists the alerts without the PSP-scoped ones or the per-account evidence; no ClickHouse reader is opened", async () => {
    const listed = await alertCall(viewHolder, { action: "alerts_list" });
    expect(listed.status, listed.text.slice(0, 300)).toBe(200);
    const alerts = listed.json?.alerts as Array<Record<string, unknown>>;
    expect(alerts.map((alert) => alert.id)).toEqual([ALERT_IDS.tenant, ALERT_IDS.resolved]);
    expect(alerts.every((alert) => alert.psp_scoped === false)).toBe(true);
    expect((alerts[0].evidence as Record<string, unknown>).by_account).toBeUndefined();
    expect(listed.json).toMatchObject({
      ok: true, action: "alerts_list", hidden_psp_scoped: 1,
      counts: { total: 2, open: 1, by_status: { new: 1, investigating: 0, resolved: 1, dismissed: 0 }, open_by_severity: { info: 0, warning: 1, critical: 0 } },
      meta: { psp_global_visible: false, can_manage: false, limit: 100, limited: false, run_min_interval_seconds: 300 },
      last_run: { run_id: "run-1", status: "succeeded", trigger: "cron", data_through: "2026-10-03", counts: { candidates: 2, inserted: 2 } },
    });
    expect((listed.json?.rules as unknown[]).length).toBe(8);
    expect(listed.gate.deps.createClickHouse).not.toHaveBeenCalled();
    expect(listed.gate.clickhouse.statements).toEqual([]);
    // The read is filtered on the data key and on psp_scoped in SQL; the run's failure text never leaves the database.
    expect(listed.pg.violations).toEqual([]);
    expect(listed.pg.callsTo("payment_risk_alerts").every((call) => call.filters.some(([op, column, value]) => op === "eq" && column === "auth_user_id" && value === PH_DATA_KEY))).toBe(true);
    expect(listed.pg.callsTo("payment_risk_alerts").find((call) => call.columns !== "id")?.filters).toContainEqual(["eq", "psp_scoped", false]);
    expect(listed.text).not.toContain("DB::Exception");
    expect(scanForLeaks(listed.json, { extra: SENTINELS })).toEqual([]);
  });

  it("the PSP key (and the data owner) see every alert with its per-account evidence; filters narrow the read", async () => {
    for (const persona of [pspHolder, PERSONAS.owner]) {
      const listed = await alertCall(persona, { action: "alerts_list" });
      const alerts = listed.json?.alerts as Array<Record<string, unknown>>;
      // Open first, then severity: the critical PSP alert leads.
      expect(alerts.map((alert) => alert.id), persona.name).toEqual([ALERT_IDS.psp, ALERT_IDS.tenant, ALERT_IDS.resolved]);
      expect((alerts[1].evidence as Record<string, unknown>).by_account, persona.name).toEqual([{ processor: { key: "STRIPE", label: "Stripe" }, merchant_account: { key: "aaaa0000-0000-4000-8000-00000000a001", label: "Stripe MID #1" }, count: 2 }]);
      expect(listed.json, persona.name).toMatchObject({ hidden_psp_scoped: 0, meta: { psp_global_visible: true, can_manage: persona === PERSONAS.owner } });
      expect(scanForLeaks(listed.json, { extra: SENTINELS })).toEqual([]);
    }
    const filtered = await alertCall(pspHolder, { action: "alerts_list", status: ["new", "investigating"], severity: ["critical"] });
    expect((filtered.json?.alerts as Array<{ id: string }>).map((alert) => alert.id)).toEqual([ALERT_IDS.psp]);
    expect(filtered.pg.callsTo("payment_risk_alerts")[0].filters).toEqual(expect.arrayContaining([["in", "status", ["new", "investigating"]], ["in", "severity", ["critical"]]]));
    const bad = await alertCall(pspHolder, { action: "alerts_list", status: ["open"] });
    expect(bad.status).toBe(400);
    expect(bad.json?.error_code).toBe("invalid_request");
  });

  it("the limit never cuts an open alert in favour of a closed one, whatever their last_seen_at (open first is chosen in the read, not after it)", async () => {
    // Three dismissed alerts refreshed after the open ones were last seen (a re-run window refreshes a dismissed row;
    // an open alert whose scope stays inconclusive is not refreshed).
    const extraRows = ["b1", "b2", "b3"].map((suffix, index) => alertRow(`aaaa0000-0000-4000-8000-0000000000${suffix}`, {
      status: "dismissed", rule_key: "data_stale", metric: "data_lag_days", unit: "days", scope: { kind: "tenant", subject: "data_through" }, last_seen_at: `2026-10-06T0${index + 1}:00:00.000Z`,
    }));
    const listed = await alertCall(pspHolder, { action: "alerts_list", limit: 2 }, { extraRows });
    expect(listed.status, listed.text.slice(0, 300)).toBe(200);
    expect((listed.json?.alerts as Array<{ id: string }>).map((alert) => alert.id)).toEqual([ALERT_IDS.psp, ALERT_IDS.tenant]);
    expect(listed.json).toMatchObject({ counts: { total: 2, open: 2 }, meta: { limit: 2, limited: true } });
    // Open and closed are read separately, each with the caller's filters.
    const reads = listed.pg.callsTo("payment_risk_alerts").filter((call) => call.columns !== "id");
    expect(reads.map((call) => call.filters.find(([op, column]) => op === "in" && column === "status")?.[2])).toEqual([["new", "investigating"], ["resolved", "dismissed"]]);
    // A closed-only filter reads only the closed statuses.
    const closedOnly = await alertCall(pspHolder, { action: "alerts_list", status: ["dismissed"], limit: 2 }, { extraRows });
    expect((closedOnly.json?.alerts as Array<{ id: string }>).map((alert) => alert.id)).toEqual(["aaaa0000-0000-4000-8000-0000000000b3", "aaaa0000-0000-4000-8000-0000000000b2"]);
    expect(closedOnly.pg.callsTo("payment_risk_alerts").filter((call) => call.columns !== "id")).toHaveLength(1);
  });

  it("is refused without payment_health.view and to every funnel-restricted context", async () => {
    const denied = await alertCall(PERSONAS.viewer, { action: "alerts_list" });
    expect(denied.status).toBe(403);
    expect(denied.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
    for (const persona of [withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS, { name: "buyer-{A}" }), withScope(PERSONAS.owner, PERSONAS.buyerA.scope, "data-owner@{A}")]) {
      // The read is refused on scope. The writes: a narrowed MEMBER never holds the privileged payment_health.manage_alerts,
      // whatever the role lists (permission before scope, so nothing is revealed); the Owner role keeps its keys and is refused on scope.
      const writeCode = persona.role.isOwner ? ACCESS_ERROR.SCOPE_NOT_SUPPORTED : ACCESS_ERROR.PERMISSION_DENIED;
      for (const [body, code] of [
        [{ action: "alerts_list" }, ACCESS_ERROR.SCOPE_NOT_SUPPORTED],
        [{ action: "alert_update", alert_id: ALERT_IDS.tenant, status: "investigating" }, writeCode],
        [{ action: "alerts_run" }, writeCode],
      ] as const) {
        const restricted = await alertCall(persona, body);
        expect(restricted.status, `${persona.name} ${body.action}`).toBe(403);
        expect(restricted.json?.error_code, `${persona.name} ${body.action}`).toBe(code);
        expect(restricted.pg.calls).toEqual([]);
        expect(restricted.pg.rpcCalls).toEqual([]);
      }
    }
  });
});

describe("P2.5 alert_update", () => {
  const update = (persona: Persona, alertId: string, status: string, extra: Record<string, unknown> = {}, options: AlertPgOptions = {}) =>
    alertCall(persona, { action: "alert_update", alert_id: alertId, status, ...extra }, options);

  it("is 403 without payment_health.manage_alerts (the view key is not enough), before any read", async () => {
    for (const persona of [viewHolder, pspHolder]) {
      const denied = await update(persona, ALERT_IDS.tenant, "investigating");
      expect(denied.status, persona.name).toBe(403);
      expect(denied.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
      expect(denied.pg.calls).toEqual([]);
      expect(rpcCalls(denied.pg, "payment_alert_update_status")).toEqual([]);
    }
  });

  it("200 with manage_alerts: the SQL function changes the status (history + audit row in one transaction) for the data key and the actor; the gate audits the write", async () => {
    const done = await update(manageHolder, ALERT_IDS.tenant, "investigating", { note: "  checking the dunning schedule " });
    expect(done.status, done.text.slice(0, 300)).toBe(200);
    expect(rpcCalls(done.pg, "payment_alert_update_status")).toEqual([{
      fn: "payment_alert_update_status",
      params: { p_data_key: PH_DATA_KEY, p_actor: manageHolder.userId, p_alert_id: ALERT_IDS.tenant, p_status: "investigating", p_note: "checking the dunning schedule", p_request_id: "req-security" },
    }]);
    expect(done.json).toMatchObject({ ok: true, action: "alert_update", alert: { id: ALERT_IDS.tenant, status: "investigating", assignee: manageHolder.userId, updated_by: manageHolder.userId, psp_scoped: false } });
    // The caller has no PSP key: the per-account evidence is stripped from the answer too.
    expect(((done.json?.alert as Record<string, unknown>).evidence as Record<string, unknown>).by_account).toBeUndefined();
    expect(done.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ fn: "clickhouse-payment-health", action: "alert_update", outcome: "success", actorUserId: manageHolder.userId }));
    expect(done.gate.clickhouse.statements).toEqual([]);
    expect(done.pg.violations).toEqual([]);
  });

  it("a PSP-scoped alert is 404 for a manager without the PSP key (it cannot be listed either) and 200 with it", async () => {
    const hidden = await update(manageHolder, ALERT_IDS.psp, "dismissed");
    expect(hidden.status).toBe(404);
    expect(hidden.json?.error_code).toBe("alert_not_found");
    expect(rpcCalls(hidden.pg, "payment_alert_update_status")).toEqual([]);
    const done = await update(fullAlertHolder, ALERT_IDS.psp, "dismissed");
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ alert: { id: ALERT_IDS.psp, status: "dismissed", scope: { kind: "account", merchant_account: { label: "Stripe MID #1" } } } });
    expect(scanForLeaks(done.json, { extra: SENTINELS })).toEqual([]);
  });

  it("an invalid transition is 400 invalid_transition (checked before the write and again in SQL); an unknown id 404; a malformed body 400", async () => {
    const invalid = await update(fullAlertHolder, ALERT_IDS.resolved, "dismissed");
    expect(invalid.status).toBe(400);
    expect(invalid.json?.error_code).toBe("invalid_transition");
    expect(rpcCalls(invalid.pg, "payment_alert_update_status")).toEqual([]);
    // A race the pre-check could not see: the function's coded refusal maps the same way (and the error code survives the employee sanitizing).
    const raced = await update(fullAlertHolder, ALERT_IDS.tenant, "resolved", {}, { updateError: "invalid_transition: dismissed -> resolved" });
    expect(raced.status).toBe(400);
    expect(raced.json?.error_code).toBe("invalid_transition");
    const gone = await update(fullAlertHolder, ALERT_IDS.tenant, "resolved", {}, { updateError: "not_found: alert not found" });
    expect(gone.status).toBe(404);
    const unknown = await update(fullAlertHolder, "aaaa0000-0000-4000-8000-0000000000ff", "investigating");
    expect(unknown.status).toBe(404);
    expect(unknown.json?.error_code).toBe("alert_not_found");
    for (const body of [{ alert_id: "x", status: "investigating" }, { alert_id: ALERT_IDS.tenant, status: "open" }, { alert_id: ALERT_IDS.tenant, status: "resolved", note: 7 }]) {
      const bad = await alertCall(fullAlertHolder, { action: "alert_update", ...body });
      expect(bad.status, JSON.stringify(body)).toBe(400);
      expect(bad.json?.error_code).toBe("invalid_request");
    }
  });
});

describe("P2.5 alerts_run and the alerts_tick cron", () => {
  it("a manager runs the engine now: claim → the runner's own reads over the ScopedReader (tenant bound) → apply; the answer is the run summary", async () => {
    const run = await alertCall(manageHolder, { action: "alerts_run" });
    expect(run.status, run.text.slice(0, 400)).toBe(200);
    expect(run.json).toMatchObject({ ok: true, action: "alerts_run", skipped: null, run: { run_id: "run-2", trigger: "manual", status: "succeeded", data_through: "2026-10-03", counts: { inserted: 3, auto_resolved: 1 } } });
    expect(rpcCalls(run.pg, "payment_alerts_claim_run")[0].params).toEqual({ p_data_key: PH_DATA_KEY, p_trigger: "manual", p_actor: manageHolder.userId, p_min_interval_seconds: 300 });
    const applied = rpcCalls(run.pg, "payment_alerts_apply_run")[0].params;
    expect(applied).toMatchObject({ p_run_id: "run-2", p_data_key: PH_DATA_KEY, p_data_through: "2026-10-03" });
    expect(run.gate.clickhouse.statements.length).toBeGreaterThan(3);
    expect(run.gate.clickhouse.boundTenants()).toEqual([PH_DATA_KEY]);
    expect(run.gate.clickhouse.statements.every((statement) => statement.kind === "query")).toBe(true);
    // Nothing the engine writes carries a raw MID, descriptor, instrument key, e-mail or transaction id.
    expect(scanForLeaks(applied, { extra: SENTINELS })).toEqual([]);
    expect(scanForLeaks(run.json, { extra: SENTINELS })).toEqual([]);
    expect(run.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "alerts_run", outcome: "success" }));
  });

  it("inside the interval a person gets 429 rate_limited (retry_after for the data owner, the code for everyone); no read is made", async () => {
    const claim = { claimed: false, retry_after_seconds: 240, last_status: "succeeded" };
    const employee = await alertCall(manageHolder, { action: "alerts_run" }, { claim });
    expect(employee.status).toBe(429);
    expect(employee.json?.error_code).toBe("rate_limited");
    expect(employee.gate.clickhouse.statements).toEqual([]);
    expect(rpcCalls(employee.pg, "payment_alerts_apply_run")).toEqual([]);
    const owner = await alertCall(PERSONAS.owner, { action: "alerts_run" }, { claim });
    expect(owner.json).toMatchObject({ error_code: "rate_limited", retry_after_seconds: 240 });
  });

  it("alerts_run is 403 without manage_alerts", async () => {
    for (const persona of [viewHolder, pspHolder]) {
      const denied = await alertCall(persona, { action: "alerts_run" });
      expect(denied.status).toBe(403);
      expect(denied.pg.rpcCalls).toEqual([]);
    }
  });

  const cronCall = async (headers: Record<string, string>, body: unknown, options: AlertPgOptions = {}) => {
    const pg = alertPg(options);
    const gate = gateFor(PERSONAS.owner);
    const req = new Request("https://edge.test/functions/v1/clickhouse-payment-health", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    const result = await callGate(CLICKHOUSE_PAYMENT_HEALTH_POLICY, indexHandler(pg), req, gate.deps, { onError: paymentHealthErrorResponse });
    return { ...result, pg, gate };
  };

  it("the secret-authenticated tick runs the engine for the workspace tenant (cron trigger, 60 s guard); only alerts_tick is callable", async () => {
    for (const body of [{}, { action: "alerts_tick" }, { auth_user_id: DATA_KEY, action: "alerts_tick" }]) {
      const tick = await cronCall({ "x-cron-secret": CRON_SECRETS.FB_CRON_SECRET }, body);
      expect(tick.status, `${JSON.stringify(body)} ${tick.text.slice(0, 300)}`).toBe(200);
      expect(tick.json).toMatchObject({ ok: true, action: "alerts_tick", run: { trigger: "cron" } });
      expect(rpcCalls(tick.pg, "payment_alerts_claim_run")[0].params).toEqual({ p_data_key: PH_DATA_KEY, p_trigger: "cron", p_actor: null, p_min_interval_seconds: 60 });
      expect(tick.gate.clickhouse.boundTenants()).toEqual([PH_DATA_KEY]);
    }
    // A double fire is skipped, not run twice.
    const skipped = await cronCall({ "x-cron-secret": CRON_SECRETS.FB_CRON_SECRET }, { action: "alerts_tick" }, { claim: { claimed: false, retry_after_seconds: 30 } });
    expect(skipped.json).toEqual({ ok: true, action: "alerts_tick", run: null, skipped: "recent_run" });
    expect(skipped.gate.clickhouse.statements).toEqual([]);
  });

  it("a wrong or missing secret is refused; the cron names nothing else; another tenant is refused; a user can never name alerts_tick", async () => {
    const wrong = await cronCall({ "x-cron-secret": "wrong" }, { action: "alerts_tick" });
    expect(wrong.status).toBe(401);
    expect(wrong.json?.error_code).toBe(ACCESS_ERROR.INVALID_CRON_SECRET);
    expect(wrong.pg.rpcCalls).toEqual([]);
    for (const body of [{ action: "overview" }, { action: "alerts_run" }, { action: "alert_update", alert_id: ALERT_IDS.tenant, status: "dismissed" }]) {
      const other = await cronCall({ "x-cron-secret": CRON_SECRETS.FB_CRON_SECRET }, body);
      expect(other.status, JSON.stringify(body)).toBe(400);
      expect(other.json?.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
      expect(other.pg.rpcCalls).toEqual([]);
    }
    const foreign = await cronCall({ "x-cron-secret": CRON_SECRETS.FB_CRON_SECRET }, { auth_user_id: EMPLOYEE, action: "alerts_tick" });
    expect(foreign.status).toBe(400);
    expect(foreign.json?.error_code).toBe(ACCESS_ERROR.TENANT_MISMATCH);
    for (const persona of [PERSONAS.owner, fullAlertHolder]) {
      const user = await alertCall(persona, { action: "alerts_tick" });
      expect(user.status).toBe(400);
      expect(user.json?.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });
});

describe("warehouse probe (clickhouse-summary)", () => {
  // The page keys every react-query entry on the warehouse version from clickhouse-summary
  // (useWarehouseVersion), so a member holding only payment_health.view must be served by that probe.
  const PROBE_PAGES: ReadonlyArray<[string, string[]]> = [
    ["/", ["src/components/RevenueIntelligenceSection.tsx"]],
    ["/transactions", ["src/components/PaymentPassAnalytics.tsx", "src/components/BankAnalytics.tsx"]],
    ["/payment-health", ["src/pages/PaymentHealth.tsx"]],
    ["/users", ["src/pages/Users.tsx"]],
    ["/cohorts", ["src/pages/Cohorts.tsx"]],
    ["/fb-analytics", ["src/pages/FBAnalytics.tsx"]],
  ];

  it("payment_health.view is a probe key and a member holding only it gets the version-only summary", async () => {
    expect(WAREHOUSE_PROBE_VIEW_PERMISSIONS).toContain("payment_health.view");
    expect(CLICKHOUSE_SUMMARY_POLICY.actions.summary.anyOf).toContain("payment_health.view");
    const gate = fakeGate({ persona: viewHolder });
    const handler: AccessHandler<string> = async ({ action }) => ({ ok: true, action, member: true });
    const served = await callGate(CLICKHOUSE_SUMMARY_POLICY, handler, edgeRequest({ fn: "clickhouse-summary", body: {} }).req, gate.deps);
    expect(served.status).toBe(200);
    expect(served.json).toMatchObject({ ok: true, action: "summary" });
    expect(gate.deps.recordDenial).not.toHaveBeenCalled();
    // ...while a member holding no probe key at all (Reports only) is still refused.
    const reportsOnly = withGrant(PERSONAS.viewer, ["reports.view"], { name: "reports-only" });
    expect(WAREHOUSE_PROBE_VIEW_PERMISSIONS).not.toContain("reports.view");
    const refused = await callGate(CLICKHOUSE_SUMMARY_POLICY, handler, edgeRequest({ fn: "clickhouse-summary", body: {} }).req, fakeGate({ persona: reportsOnly }).deps);
    expect(refused.status).toBe(403);
    expect(refused.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
  });

  it("every page that runs the probe has at least one route key in the probe list (parity with ROUTE_ACCESS)", () => {
    for (const [path, sources] of PROBE_PAGES) {
      for (const source of sources) expect(readFileSync(resolve(process.cwd(), source), "utf8"), source).toContain("useWarehouseVersion(");
      const rule = ROUTE_ACCESS.find((entry) => entry.path === path);
      expect(rule, path).toBeDefined();
      expect(rule!.anyOf.some((key) => WAREHOUSE_PROBE_VIEW_PERMISSIONS.includes(key)), `${path}: ${rule!.anyOf.join(", ")}`).toBe(true);
    }
  });
});

describe("index.ts entrypoint", () => {
  it("serves through serveWithAccess(CLICKHOUSE_PAYMENT_HEALTH_POLICY) with the tenant key, the runner and the error mapping", () => {
    const source = readFileSync(resolve(process.cwd(), "supabase/functions/clickhouse-payment-health/index.ts"), "utf8");
    expect(source).toMatch(/serveWithAccess\(\s*CLICKHOUSE_PAYMENT_HEALTH_POLICY,/);
    expect(source).toContain('from "../_shared/access/policies/clickhouse-payment-health.ts"');
    expect(source).toContain("ctx.tenantKey");
    expect(source).toContain("pspVisible: pspDimensionsVisible(ctx)");
    expect(source).toContain("paymentHealthErrorResponse");
    expect(source).toContain("QUERY_TIMEOUT_MS = 55_000");
    // P2.5: the alert actions go to the alert router with the workspace tenant, the member, the two visibility flags
    // and the reader FACTORY (alerts_list / alert_update never open ClickHouse).
    expect(source).toMatch(/if \(isPaymentAlertAction\(action\)\)/);
    expect(source).toContain("runPaymentAlertsAction({");
    expect(source).toContain("actorUserId: ctx.actor.userId");
    expect(source).toContain("canManage: alertsManageable(ctx)");
    expect(source).toMatch(/\n\s+clickhouse,\n/);
    for (const banned of ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "clickhouse/client.ts", "Deno.serve(", "auth.id", "parseJsonBody", "body.auth_user_id"]) {
      expect(source).not.toContain(banned);
    }
  });
});
