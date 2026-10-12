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
import { beforeEach, describe, expect, it } from "vitest";
import { assertValidPolicy, type AccessHandler, type AccessRequest } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import { ENFORCED_PERMISSION_KEYS, PRIVILEGED_PERMISSION_KEYS } from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  CLICKHOUSE_PAYMENT_HEALTH_POLICY,
  normalizeClickHousePaymentHealthAction,
  paymentHealthErrorResponse,
  pspDimensionsVisible,
} from "../../supabase/functions/_shared/access/policies/clickhouse-payment-health.ts";
import { CLICKHOUSE_SUMMARY_POLICY, WAREHOUSE_PROBE_VIEW_PERMISSIONS } from "../../supabase/functions/_shared/access/policies/clickhouse-summary.ts";
import { ROUTE_ACCESS } from "../services/accessRoutes";
import { PAYMENT_HEALTH_ACTIONS, PaymentHealthPermissionError, PaymentHealthRequestError } from "../../supabase/functions/_shared/clickhouse/paymentHealthContract.ts";
import { resetPaymentHealthMemo, runPaymentHealth } from "../../supabase/functions/_shared/clickhouse/paymentHealth.ts";
import { PERSONAS, callGate, contextFor, edgeRequest, fakeGate, withGrant, withScope, type Persona } from "./support/accessFixtures";
import { createRecordingClickHouse } from "./support/recordingClickHouse";
import { SENTINEL_EMAILS, scanForLeaks } from "./support/leakScan";
import { PH_DATA_KEY, PH_SENTINELS, asPg, fixturePg, fixtureRows, fixtureWarehouse } from "./support/paymentHealthFixtures";

const ACTIONS = [...PAYMENT_HEALTH_ACTIONS];
const RANGE = { date_from: "2026-09-01", date_to: "2026-09-30" };
const NOW = Date.parse("2026-10-06T12:00:00.000Z");
const SENTINELS = [...Object.values(PH_SENTINELS), SENTINEL_EMAILS[1], "secret-cursor"];
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";

const viewHolder = withGrant(PERSONAS.viewer, ["payment_health.view"], { name: "ph-view" });
const pspHolder = withGrant(PERSONAS.viewer, ["payment_health.view", "payment_health.psp_global.view"], { name: "ph-psp" });

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
  it("is valid, POST-only, without cron, and every action needs payment_health.view and nothing else", () => {
    expect(() => assertValidPolicy(CLICKHOUSE_PAYMENT_HEALTH_POLICY)).not.toThrow();
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.fn).toBe("clickhouse-payment-health");
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.methods).toEqual(["POST"]);
    expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.cron).toBeUndefined();
    expect(Object.keys(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions).sort()).toEqual([...ACTIONS].sort());
    for (const action of ACTIONS) expect(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions[action]).toEqual({ anyOf: ["payment_health.view"] });
    // Not scopeReady, not rawOnly: restricted members are refused like Payment Pass; the privileged keys gate dimensions, not actions.
    for (const rule of Object.values(CLICKHOUSE_PAYMENT_HEALTH_POLICY.actions)) {
      expect(rule.scopeReady).toBeUndefined();
      expect(rule.rawOnly).toBeUndefined();
      expect(rule.ownerOnly).toBeUndefined();
      expect(rule.write).toBeUndefined();
    }
    expect(ENFORCED_PERMISSION_KEYS).toContain("payment_health.view");
    expect(PRIVILEGED_PERMISSION_KEYS.has("payment_health.psp_global.view")).toBe(true);
    expect(PRIVILEGED_PERMISSION_KEYS.has("payment_health.manage_alerts")).toBe(true);
    expect(PRIVILEGED_PERMISSION_KEYS.has("payment_health.view")).toBe(false);
  });

  it("normalizes exactly the six actions and rejects everything else (no default)", () => {
    for (const action of ACTIONS) expect(normalizeClickHousePaymentHealthAction({ action })).toBe(action);
    for (const body of [{}, { action: "" }, { action: "analytics" }, { action: "OVERVIEW" }, { action: ["overview"] }, { action: "cron_tick" }]) {
      expect(() => normalizeClickHousePaymentHealthAction(body)).toThrow(ActionNormalizeError);
    }
  });

  it("maps the runner's errors: malformed request 400, PSP dimension without the key 403 permission_denied, anything else to the gate", () => {
    expect(paymentHealthErrorResponse(new PaymentHealthRequestError("bad"))).toEqual({ status: 400, body: { ok: false, error_code: "invalid_request", error: "bad" } });
    expect(paymentHealthErrorResponse(new PaymentHealthPermissionError("psp"))).toEqual({ status: 403, body: { ok: false, error_code: ACCESS_ERROR.PERMISSION_DENIED, error: "psp" } });
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
    for (const banned of ["requireSupabaseUser", "requireCronSecret", "createClickHouseClient", "clickhouse/client.ts", "Deno.serve(", "auth.id", "parseJsonBody", "body.auth_user_id"]) {
      expect(source).not.toContain(banned);
    }
  });
});
