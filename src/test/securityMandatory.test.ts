// Security regression suite — the 20 mandatory tests of plan §29, in their
// Milestone-A form (plan D9 / §30 Phase 1: employees exist only with funnel scope
// `all`; every funnel-restricted context is refused everywhere), narrowed by
// access Phase 2: exactly the 12 media-buyer actions (SCOPE_READY_ACTIONS)
// serve a restricted context behind the snapshot freshness gate (409 until it
// is ready) and a restricted ScopedReader; every other action still refuses it.
//
// What runs for real here:
//   * the gate (handleWithAccess) with injected dependencies, and every REAL
//     policy table under supabase/functions/_shared/access/policies/*;
//   * the REAL ScopedReader over a recording ClickHouse, so "no query ran" and
//     "the query bound the data key" are observed at the transport;
//   * the REAL migrations in PGlite (all of them, bootstrap, the real role
//     templates, the RLS lockdown) for resolve_access, RLS and the version bumps,
//     and that SQL feeding the gate (pgliteGateDeps);
//   * the real AccessProvider / purge registry for the cache rules (#14).
//
// The semantic Phase-2 assertions (#1-#6: funnel A vs B rows, explicit keys,
// include lists, Revenue Intelligence, filter options, FB campaign visibility)
// run on the fixture warehouse of accessFixtures §6, through router replicas
// of the scopeReady functions. Phase 2.4+ assertions (AI, payments, users,
// support, saved objects, export contents) stay it.todo with the exact
// assertion they will make.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

vi.mock("@/services/supabaseClient", () => {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "in", "is", "gte", "lte", "range"]) chain[method] = () => chain;
  chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
  chain.maybeSingle = async () => ({ data: null, error: null });
  return {
    isSupabaseConfigured: true,
    supabase: {
      functions: { invoke: async () => ({ data: null, error: new Error("offline in tests") }) },
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        getUser: async () => ({ data: { user: null }, error: null }),
      },
      from: () => ({ ...chain, insert: async () => ({ error: null }), upsert: async () => ({ error: null }) }),
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "missing" }, status: 404 }),
    },
  };
});

import { handleWithAccess, type AccessRequest } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES, type AccessErrorCode } from "../../supabase/functions/_shared/access/errors.ts";
import { buildAccessContext, parseResolveAccessRow } from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS, isPrivilegedPermission } from "../../supabase/functions/_shared/access/permissions.ts";
import { accessPartitionInput, computeAccessPartition, sha256Hex, type FunnelScopeMode } from "../../supabase/functions/_shared/access/scope.ts";
import { ScopeViolation, createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import { ALL_SCOPE_SQL, OUT_OF_SCOPE_SENTINEL, cohortsFrom, fbFrom, txEmailMatchedFrom, txFrom } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { subscriptionDataStatus, supportDataStatus } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import { INIT_TENANT_ROW_COUNT_SQL, INIT_TENANT_COHORT_ROW_COUNT_SQL } from "../../supabase/functions/_shared/clickhouse/schema.ts";
import { REPORTS_GENERATE_POLICY } from "../../supabase/functions/_shared/access/policies/reports-generate.ts";
import { CLICKHOUSE_COHORTS_POLICY } from "../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import { CLICKHOUSE_COHORT_MEMBERSHIP_POLICY } from "../../supabase/functions/_shared/access/policies/clickhouse-cohort-membership.ts";
import { ACCESS_POLICY } from "../../supabase/functions/_shared/access/policies/access.ts";
import { handleExportCampaignPerformance } from "../../supabase/functions/export-campaign-performance/handler.ts";
import { createReportsGenerateHandler, REPORT_NOT_FOUND } from "../../supabase/functions/reports-generate/handler.ts";
import {
  ACTION_REQUESTS,
  ALL_POLICIES,
  CRON_ONLY_ACTIONS,
  DATA_KEY,
  FOREIGN_TENANT,
  FUNNELS,
  GATED_POLICIES,
  NON_SCOPE_DENIALS,
  PERSONAS,
  ROUTER_REPLICAS,
  SCOPE_CAMPAIGNS,
  SCOPE_CUSTOMERS,
  SCOPE_DAYS,
  SCOPE_READY_ACTIONS,
  SCOPE_READY_REQUESTS,
  SET_SCOPE_SQL,
  TEMPLATE_PERMISSIONS,
  TENANT_ROW_TABLES,
  UPDATE_MEMBER_SQL,
  UPDATE_ROLE_SQL,
  USER_IDS,
  WORKSPACE_ID,
  accessRow,
  apiKeyFixture,
  boundList,
  callGate,
  contextFor,
  createLockedWorkspace,
  edgeRequest,
  fakeGate,
  gatedActionCases,
  isDataAction,
  isSyntheticCustomer,
  minimalGrant,
  normalizedAction,
  pgliteGateDeps,
  probeHandler,
  readResult,
  readThroughRouter,
  readySnapshotState,
  restrictedStatementCorpus,
  scopeSnapshotState,
  scopedUserPathsOf,
  svc,
  userActions,
  userToken,
  visibleCampaignPathsOf,
  withExplicitFunnelB,
  withGrant,
  withScope,
  type ActionCase,
  type Persona,
  type RouterRead,
  type SeededWorkspace,
} from "./support/accessFixtures";
import { createRecordingClickHouse, type RecordedStatement } from "./support/recordingClickHouse";
import { createStrictFakeSupabase } from "./support/strictFakeSupabase";
import { SENTINEL_CLICKHOUSE_ERROR, SENTINEL_EMAILS, scanForLeaks, scanResponse, scanStatementsForLeaks, sentinelRow } from "./support/leakScan";
import type { SupabasePglite } from "./support/pgliteSupabase";

import { AccessProvider } from "@/components/AccessProvider";
import { AuthContext, type AuthContextValue } from "@/contexts/authContext";
import type { AccessContextValue } from "@/contexts/accessContext";
import { useAccess } from "@/hooks/useAccess";
import { notePrincipal, registerPurgeHandler, registeredPurgeHandlers, runPurge, type PurgeReason } from "@/services/sessionPurge";
import { setActiveCacheAccess } from "@/services/analyticsCache";
import { analyticsPersistKey } from "@/services/analyticsCachePersistence";
import { PALMER_CACHE_DB_NAME, loadLastPalmerDatasetFromCache } from "@/services/palmerCache";
import { SUBSCRIPTION_CACHE_DB_NAME } from "@/services/subscriptionCache";
import { TRAFFIC_CACHE_DB_NAME } from "@/services/trafficCache";
import { WAREHOUSE_TRANSACTIONS_CACHE_DB_NAME } from "@/services/transactionWarehouse";
import "@/services/clickhouse";
import "@/services/cohortSnapshotHealth";
import "@/hooks/usePersistedPageState";
import "@/store/dataStore";
import "@/store/aiAssistantStore";
import "@/services/aiRecommendationLog";

// ---- shared fixtures ------------------------------------------------------------------

const CASES = gatedActionCases();
const CASE_ROWS = CASES.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const);
/** Phase 2: the scopeReady actions serve restricted contexts; every other one still refuses them. */
const READY_ROWS = CASE_ROWS.filter(([, entry]) => entry.rule.scopeReady === true);
const NOT_READY_ROWS = CASE_ROWS.filter(([, entry]) => entry.rule.scopeReady !== true);

/** Restricted contexts that HOLD every enforced key (privileged ones are not
 * effective without scope all), so a data action can only be refused for its
 * funnel scope. */
const RESTRICTED: Persona[] = [
  withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS, { name: "buyer-{A}" }),
  withGrant(PERSONAS.buyerAB, ENFORCED_PERMISSION_KEYS, { name: "buyer-{A,B}" }),
  withGrant(PERSONAS.emptyGrant, ENFORCED_PERMISSION_KEYS, { name: "empty-grant" }),
  withGrant(PERSONAS.noRule, ENFORCED_PERMISSION_KEYS, { name: "no-rule" }),
];

/** Defense in depth: an Owner-role member or even the data owner narrowed to {A}
 * (both impossible by the SQL invariants) is refused too. */
const RESTRICTED_PRIVILEGED: Persona[] = [
  withGrant(withScope(PERSONAS.viewer, PERSONAS.buyerA.scope), [], { isOwner: true, name: "owner-role@{A}" }),
  withScope(PERSONAS.owner, PERSONAS.buyerA.scope, "data-owner@{A}"),
];

function requestFor(entry: ActionCase, body?: Record<string, unknown>) {
  return edgeRequest({ fn: entry.fn, method: entry.request.method, query: entry.request.query, body: body ?? entry.request.body });
}


let locked: SeededWorkspace;
const clones: SupabasePglite[] = [];
async function cloneLocked(): Promise<SupabasePglite> {
  const copy = await locked.h.clone();
  clones.push(copy);
  return copy;
}

beforeAll(async () => {
  locked = await createLockedWorkspace();
}, 300_000);

afterEach(async () => {
  while (clones.length) await clones.pop()!.close();
});

afterAll(async () => {
  await locked?.h.close();
});

// =========================================================================================
// #1-#9, #11-#13 — Milestone A: no data action serves a funnel-restricted context
// =========================================================================================

describe("#1-#9, #11-#13 (Milestone A): every data action of every policy refuses a funnel-restricted context", () => {
  it("covers every policy: one request fixture per user action, each normalizing to its own action", () => {
    expect(ALL_POLICIES.length).toBeGreaterThanOrEqual(27);
    for (const policy of ALL_POLICIES) {
      for (const action of Object.keys(policy.actions)) {
        if (CRON_ONLY_ACTIONS[policy.fn]?.includes(action)) {
          expect(policy.cron?.actions, `${policy.fn}.${action} is cron-only`).toContain(action);
          continue;
        }
        const request = ACTION_REQUESTS[policy.fn]?.[action];
        expect(request, `request fixture for ${policy.fn}.${action}`).toBeDefined();
        expect(normalizedAction(policy, request!), `${policy.fn}.${action}`).toBe(action);
      }
      for (const action of Object.keys(ACTION_REQUESTS[policy.fn] ?? {})) {
        expect(Object.keys(policy.actions), `stale fixture ${policy.fn}.${action}`).toContain(action);
      }
    }
    expect(CASES.length).toBeGreaterThanOrEqual(114);
  });

  it("exactly the 12 media-buyer actions are scopeReady (Phase 2 allowlist)", () => {
    const ready: string[] = [];
    for (const policy of ALL_POLICIES) {
      for (const [action, rule] of Object.entries(policy.actions)) if (rule.scopeReady === true) ready.push(`${policy.fn}.${action}`);
    }
    expect(ready.sort()).toEqual([...SCOPE_READY_ACTIONS].sort());
    expect(READY_ROWS).toHaveLength(12);
  });

  it("the data-action classification is not vacuous (reads of every analytics page are in it)", () => {
    const data = new Set(CASES.filter((entry) => isDataAction(entry.rule)).map((entry) => `${entry.fn}.${entry.action}`));
    for (const key of [
      "clickhouse-cohorts.list", "clickhouse-cohorts.details", "clickhouse-cohorts.options", "clickhouse-revenue.bundle",
      "clickhouse-facebook.report", "clickhouse-facebook.status", "clickhouse-facebook.spend_ledger", "clickhouse-payment-analytics.bundle",
      "clickhouse-payment-analytics.ai_pass_rates", "clickhouse-users.list", "clickhouse-users.details", "clickhouse-support.export",
      "clickhouse-summary.summary", "ai-analytics.assistant_answer", "reports-generate.generate",
    ]) {
      expect(data.has(key), key).toBe(true);
    }
    expect(data.size).toBeGreaterThanOrEqual(38);
  });

  it.each(NOT_READY_ROWS)("%s: buyer-{A}, buyer-{A,B}, empty-grant and no-rule get 403 before the handler, with no ClickHouse query", async (_label, entry) => {
    // #2 / #3: the request names funnel B explicitly and asks for [A, B].
    const body = entry.request.method === "GET" ? undefined : withExplicitFunnelB(entry.request.body);
    expect(normalizedAction(entry.policy, { ...entry.request, body })).toBe(entry.action);
    for (const persona of RESTRICTED) {
      const { deps, clickhouse } = fakeGate({ persona });
      const probe = probeHandler();
      const result = await callGate(entry.policy, probe.handler, requestFor(entry, body).req, deps);
      const code = result.json?.error_code as AccessErrorCode;
      expect(result.status, persona.name).toBe(403);
      if (isDataAction(entry.rule)) expect(code, persona.name).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
      else expect(NON_SCOPE_DENIALS.has(code), `${persona.name}: ${code}`).toBe(true);
      expect(result.json).toEqual({ ok: false, error_code: code, error: ACCESS_ERROR_MESSAGES[code] });
      expect(probe.spy).not.toHaveBeenCalled();
      expect(deps.createClickHouse).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
      expect(deps.loadAccess).toHaveBeenCalledTimes(1);
      expect(scanForLeaks(result.text, { funnelB: true })).toEqual([]);
    }
  });

  it.each(NOT_READY_ROWS)("%s: an Owner-role member or the data owner narrowed to {A} is refused too (raw access never bypasses R6)", async (_label, entry) => {
    for (const persona of RESTRICTED_PRIVILEGED) {
      const { deps, clickhouse } = fakeGate({ persona });
      const probe = probeHandler();
      const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
      expect(result.status, persona.name).toBe(403);
      expect(probe.spy).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it.each(READY_ROWS)("%s (scopeReady): every restricted context reaches the handler with a restricted scope, and an unscoped read is a 500 scope_violation", async (_label, entry) => {
    const body = entry.request.method === "GET" ? undefined : withExplicitFunnelB(entry.request.body);
    for (const persona of [...RESTRICTED, ...RESTRICTED_PRIVILEGED]) {
      const { deps, clickhouse } = fakeGate({ persona });
      const seen: Array<{ restricted: boolean; scopeRestricted: boolean; rawAccess: boolean }> = [];
      const handler = async (request: AccessRequest<string>) => {
        seen.push({ restricted: request.ctx.restricted, scopeRestricted: request.scope.restricted, rawAccess: request.ctx.rawAccess });
        // The probe's tenant query names analytics_transactions directly — the
        // restricted reader refuses it (only scopeSql fragments may).
        await request.clickhouse().query({ query: "SELECT count() AS c FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}" });
        return { ok: true };
      };
      const result = await callGate(entry.policy, handler as never, requestFor(entry, body).req, deps);
      expect(seen, persona.name).toHaveLength(1);
      expect(seen[0], persona.name).toMatchObject({ restricted: true, scopeRestricted: true });
      expect(result.status, persona.name).toBe(500);
      expect(result.json?.error_code, persona.name).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
      expect(clickhouse.statements, persona.name).toEqual([]);
      expect(scanForLeaks(result.text, { funnelB: true })).toEqual([]);
    }
  });

  it.each(READY_ROWS)("%s (scopeReady): without a ready cohort snapshot a restricted context gets 409 before the handler, with no query", async (_label, entry) => {
    const persona = RESTRICTED[0];
    for (const snapshotState of [null, readySnapshotState({ fresh_verified_at: "2026-01-01T00:00:00.000Z" }), readySnapshotState({ active_validation: { status: "FAIL" } })]) {
      const { deps, clickhouse } = fakeGate({ persona, snapshotState });
      const probe = probeHandler();
      const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
      if (!entry.rule.scopeSnapshot) {
        // clickhouse-summary.summary: no snapshot needed (its member branch reads no ClickHouse).
        expect(entry.fn).toBe("clickhouse-summary");
        expect(deps.loadCohortSnapshotState).not.toHaveBeenCalled();
        expect(probe.spy).toHaveBeenCalledTimes(1);
        continue;
      }
      expect(result.status).toBe(409);
      expect(result.json).toEqual({ ok: false, error_code: ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY, error: ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready });
      expect(probe.spy).not.toHaveBeenCalled();
      expect(deps.createClickHouse).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
    }
    if (entry.rule.scopeSnapshot === "campaign") {
      const { deps, clickhouse } = fakeGate({ persona, snapshotState: readySnapshotState({ active_campaign_scope_version: null }) });
      const probe = probeHandler();
      const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
      expect(result.status).toBe(409);
      expect(probe.spy).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it.each(CASE_ROWS)("%s: an all-scope member with exactly the required grant reaches the handler bound to the data key", async (_label, entry) => {
    if (entry.rule.ownerOnly || entry.rule.rawOnly) {
      // Owner / data-owner only: every other member is refused, the owner is served.
      const admin = fakeGate({ persona: withGrant(PERSONAS.admin, ENFORCED_PERMISSION_KEYS, { name: "admin-all" }) });
      const refused = await callGate(entry.policy, probeHandler().handler, requestFor(entry).req, admin.deps);
      expect(refused.status).toBe(403);
      expect([ACCESS_ERROR.OWNER_REQUIRED, ACCESS_ERROR.RAW_ACCESS_REQUIRED]).toContain(refused.json?.error_code);
      expect(admin.clickhouse.statements).toEqual([]);

      const owner = fakeGate({ persona: PERSONAS.owner });
      const probe = probeHandler();
      const served = await callGate(entry.policy, probe.handler, requestFor(entry).req, owner.deps);
      expect(served.status).toBe(200);
      expect(probe.seen[0].ctx).toMatchObject({ tenantKey: DATA_KEY, rawAccess: true, restricted: false });
      expect(owner.clickhouse.boundTenants()).toEqual([DATA_KEY]);
      return;
    }

    const member = withGrant(PERSONAS.viewer, minimalGrant(entry.rule), { name: "minimal-grant" });
    const { deps, clickhouse } = fakeGate({ persona: member });
    const probe = probeHandler();
    const served = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
    expect(served.status, JSON.stringify(served.json)).toBe(200);
    expect(probe.spy).toHaveBeenCalledTimes(1);
    expect(probe.seen[0].action).toBe(entry.action);
    expect(probe.seen[0].ctx.tenantKey).toBe(DATA_KEY);
    expect(probe.seen[0].ctx.actor).toMatchObject({ kind: "user", userId: USER_IDS.viewer });
    expect(probe.seen[0].ctx.tenantKey).not.toBe(probe.seen[0].ctx.actor.userId);
    expect(probe.seen[0].ctx.rawAccess).toBe(false);
    expect(clickhouse.statements).toHaveLength(1);
    expect(clickhouse.boundTenants()).toEqual([DATA_KEY]);

    // ...and without that grant the same request is permission_denied (the check is real).
    const removals = entry.rule.anyOf?.length ? [entry.rule.anyOf] : (entry.rule.allOf ?? []).map((key) => [key]);
    for (const removed of removals) {
      const drop = new Set(removed);
      const lacking = withGrant(PERSONAS.admin, ENFORCED_PERMISSION_KEYS.filter((key) => !drop.has(key)), { name: `without-${removed.join("+")}` });
      const denied = fakeGate({ persona: lacking });
      const result = await callGate(entry.policy, probeHandler().handler, requestFor(entry).req, denied.deps);
      expect(result.status, removed.join(",")).toBe(403);
      expect(result.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
      expect(denied.clickhouse.statements).toEqual([]);
    }
  });

  describe("#11 / #12 Export API (API-key entry point, not the JWT gate)", () => {
    let API_KEY = "";
    function exportDeps(creator: Persona) {
      const key = apiKeyFixture("security_suite", creator.userId);
      API_KEY = key.raw;
      const pg = createStrictFakeSupabase({
        tenantKey: DATA_KEY,
        actorKey: creator.userId,
        tables: {
          api_keys: { scope: "global", rows: [key.row] },
          // A refused request is logged under the key creator, an authorized
          // export under the workspace data key (actor_user_id = creator): both
          // owners are asserted explicitly below.
          api_export_logs: { scope: "global" },
          import_batches: { scope: "tenant", owner: "user_id", rows: [{ id: "batch-1", user_id: DATA_KEY }, { id: "batch-foreign", user_id: FOREIGN_TENANT }] },
        },
        rpc: { resolve_access: { actorParam: "p_user_id", handler: () => ({ data: accessRow(creator), error: null }) } },
      });
      const clickhouse = createRecordingClickHouse();
      const contexts: string[] = [];
      return {
        pg,
        clickhouse,
        contexts,
        deps: {
          configError: null,
          pg: () => pg as never,
          createClickHouse: (ctx: Parameters<typeof createScopedReader>[0]) => {
            contexts.push(ctx.tenantKey);
            return createScopedReader(ctx, clickhouse);
          },
          newRequestId: () => "req-export",
          log: vi.fn(),
        },
      };
    }
    const exportRequest = (query = "") =>
      new Request(`https://edge.test/functions/v1/export-campaign-performance${query}`, { method: "GET", headers: { Authorization: `Bearer ${API_KEY}` } });

    it.each(["", "?breakdown=country"])("a funnel-restricted key creator gets 403 scope_not_supported and nothing is read (%s)", async (query) => {
      for (const creator of RESTRICTED) {
        const env = exportDeps(creator);
        const result = await readResult(await handleExportCampaignPerformance(exportRequest(query), env.deps));
        expect(result.status, creator.name).toBe(403);
        expect(result.json).toEqual({ ok: false, error_code: ACCESS_ERROR.SCOPE_NOT_SUPPORTED, error: ACCESS_ERROR_MESSAGES.scope_not_supported });
        expect(env.clickhouse.statements).toEqual([]);
        expect(env.contexts).toEqual([]);
        expect(env.pg.callsTo("import_batches")).toEqual([]);
        expect(env.pg.inserted("api_export_logs")).toEqual([
          expect.objectContaining({ status_code: 403, error_message: "scope_not_supported", user_id: creator.userId, actor_user_id: creator.userId }),
        ]);
        expect(env.pg.violations).toEqual([]);
      }
    });

    it("an all-scope creator with api_export.use is served from the data key only", async () => {
      const env = exportDeps(withGrant(PERSONAS.admin, ["api_export.use"], { name: "exporter" }));
      const result = await readResult(await handleExportCampaignPerformance(exportRequest(), env.deps));
      expect(result.status).toBe(200);
      expect(env.contexts).toEqual([DATA_KEY]);
      expect(env.clickhouse.statements.length).toBeGreaterThan(0);
      expect(env.clickhouse.boundTenants()).toEqual([DATA_KEY]);
      expect(env.pg.violations).toEqual([]);
      // The data owner can read who exported (tenant row, actor kept).
      expect(env.pg.inserted("api_export_logs")).toEqual([
        expect.objectContaining({ status_code: 200, user_id: DATA_KEY, actor_user_id: PERSONAS.admin.userId }),
      ]);
    });

    it.todo("Phase 5: #11/#12 export CONTENT — a buyer-{A} key returns rows whose campaign_path ∈ paths(A) only, scanForLeaks(body, { funnelB: true }) is empty, and an export.performed audit row records count + scope_hash");
  });

  describe("#13 AI receives only authorized data", () => {
    const REPORT_EDITOR = ["reports.view", "reports.edit", "ai.use"];
    const OWNER_REPORT = "0dd0dd0d-0000-4000-8000-0000000000aa";
    const VIEWER_REPORT = "0dd0dd0d-0000-4000-8000-0000000000bb";
    const reportsPg = (actor: string) =>
      createStrictFakeSupabase({
        tenantKey: DATA_KEY,
        actorKey: actor,
        tables: {
          reports: { scope: "actor", owner: "auth_user_id", rows: [{ id: OWNER_REPORT, auth_user_id: DATA_KEY }, { id: VIEWER_REPORT, auth_user_id: USER_IDS.viewer }] },
          report_ai_runs: { scope: "actor", owner: "auth_user_id" },
        },
      });

    it("reports-generate: a foreign report_id is 404 report_not_found before any model call; the lookup is keyed by the actor", async () => {
      const model = vi.fn();
      const handler = createReportsGenerateHandler({ apiKey: () => "sk-test", createModelCaller: model });
      const persona = withGrant(PERSONAS.viewer, REPORT_EDITOR, { name: "report-editor" });
      const pg = reportsPg(USER_IDS.viewer);
      const { deps } = fakeGate({ persona, pg });
      const result = await callGate(REPORTS_GENERATE_POLICY, handler, edgeRequest({ body: { action: "generate", report_id: OWNER_REPORT, input: { kpi: [], funnels: [] } } }).req, deps);
      expect(result.status).toBe(404);
      expect(result.json).toEqual({ ok: false, error_code: REPORT_NOT_FOUND, error: "Report not found." });
      expect(model).not.toHaveBeenCalled();
      expect(pg.inserted("report_ai_runs")).toEqual([]);
      // The strict client would have rejected a lookup keyed by the tenant key.
      expect(pg.violations).toEqual([]);
      expect(pg.callsTo("reports")[0].filters).toEqual([["eq", "id", OWNER_REPORT], ["eq", "auth_user_id", USER_IDS.viewer]]);
    });

    it("reports-generate: the actor's own report passes the ownership check", async () => {
      const handler = createReportsGenerateHandler({ apiKey: () => null, createModelCaller: vi.fn() });
      const pg = reportsPg(USER_IDS.viewer);
      const { deps } = fakeGate({ persona: withGrant(PERSONAS.viewer, REPORT_EDITOR), pg });
      const result = await callGate(REPORTS_GENERATE_POLICY, handler, edgeRequest({ body: { action: "generate", report_id: VIEWER_REPORT } }).req, deps);
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ ok: false, unavailable: true });
      expect(pg.violations).toEqual([]);
    });

    it.todo("Phase 2.4: #13 T13 — a buyer-{A} ai-analytics call is admitted only with a context pack whose every source is a scoped Edge response; the pass-rate bundle comes from the scoped payments action and scanForLeaks(modelInput, { funnelB: true }) is empty");
  });

  // #1-#6 run for real in the access Phase 2 block below.
  it.todo("Phase 4: #7 T07 — buyer-{A} Payments staging tables are built by scratchFromScopedSelect and contain only users anchored to A");
  it.todo("Phase 4: #8 T08 — buyer-{A} Payment Pass bundle / options equal the owner's bundle filtered to paths(A)");
  it.todo("Phase 4: #9 T09 — buyer-{A} spend_ledger / project seeding contain only A's campaigns; residual buckets hidden");
  it.todo("Phase 4: #10 T10 — a saved forecast stamped {A,B} is invisible to buyer-{A} (stamp trigger + scope_paths <@ allowed_paths() truth table); {*} is visible only with scope all");
});

// =========================================================================================
// #1-#6 — access Phase 2: a funnel-restricted media buyer reads its own funnels only
// =========================================================================================
// Persona → REAL gate → router replica → REAL runners → REAL restricted ScopedReader →
// the fixture warehouse of accessFixtures §6, which answers every statement by the
// scope the statement carries (the unhex(...) literals of its fragments). Funnel A is
// soulmate-sketch, B past-life; buyer-{A} is the Media Buyer template narrowed to A.

describe("#1-#6 (access Phase 2): a funnel-restricted media buyer reads only its own funnels", () => {
  const A = FUNNELS.A.path;
  const B = FUNNELS.B.path;
  const [DAY_1, DAY_2] = SCOPE_DAYS;
  const BUYER_A = PERSONAS.buyerA;
  const BUYER_AB = PERSONAS.buyerAB;
  const A_EMAILS = SCOPE_CUSTOMERS.filter((entry) => entry.path === A).map((entry) => entry.email);
  const nonSyntheticOf = (path: string) => SCOPE_CUSTOMERS.filter((entry) => entry.path === path && !isSyntheticCustomer(entry));
  const rowsOf = (result: RouterRead) => (result.json?.rows ?? []) as Array<Record<string, unknown>>;
  const PRESENCE_PROBE = /^SELECT count\(\) AS c FROM \(SELECT 1 FROM fact_(support_requests|subscriptions) FINAL WHERE auth_user_id = \{auth_user_id:String\} LIMIT 1\) FORMAT JSONEachRow$/;

  /** Every warehouse read of the request goes through a fragment that admits exactly `paths`. */
  function expectScopedTo(statements: readonly RecordedStatement[], paths: readonly string[]) {
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.kind).toBe("query");
      expect(statement.params.auth_user_id ?? DATA_KEY).toBe(DATA_KEY);
      if (PRESENCE_PROBE.test(statement.query)) continue;
      const users = scopedUserPathsOf(statement.query);
      const campaigns = visibleCampaignPathsOf(statement.query);
      expect(users ?? campaigns, `unscoped read: ${statement.query.slice(0, 160)}`).not.toBeNull();
      for (const decoded of [users, campaigns]) {
        if (decoded) expect([...decoded].sort(), statement.query.slice(0, 160)).toEqual([...paths].sort());
      }
    }
  }

  /** `head` (e.g. "base AS (") up to its matching close paren. */
  function cteBody(sql: string, head: string): string {
    const start = sql.indexOf(head);
    expect(start, head).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let index = start + head.length - 1; index < sql.length; index += 1) {
      if (sql[index] === "(") depth += 1;
      else if (sql[index] === ")" && --depth === 0) return sql.slice(start, index + 1);
    }
    throw new Error(`unbalanced ${head}`);
  }

  /** Every string value of a filter_options block (arrays of strings or of option objects). */
  function optionValues(options: unknown): string[] {
    const values: string[] = [];
    for (const list of Object.values((options ?? {}) as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (typeof item === "string") values.push(item);
        else if (item && typeof item === "object") values.push(...Object.values(item).filter((value): value is string => typeof value === "string"));
      }
    }
    return values;
  }

  it("the fixture is not vacuous: the owner's unscoped reads serve B, 'unknown', synthetic ids and the tenant sentinels", async () => {
    const owner = await readThroughRouter(PERSONAS.owner, "clickhouse-cohorts", { action: "list", date_from: DAY_1, date_to: DAY_2 });
    expect(owner.status).toBe(200);
    expect(new Set(rowsOf(owner).map((row) => row.campaign_path))).toEqual(new Set([A, B, FUNNELS.C.path, "unknown"]));
    expect(scanForLeaks(owner.text, { funnelB: true }).length).toBeGreaterThan(0);
    for (const statement of owner.clickhouse.statements) {
      expect(scopedUserPathsOf(statement.query)).toBeNull();
      expect(statement.settings).toBeUndefined();
    }
  });

  it("T01 #1 — buyer-{A} cohorts list: only A's cohorts; every read (base and fcm included) admits paths(A) only; no fcall; equal to the owner's list filtered to A minus synthetic ids", async () => {
    const body = { action: "list", date_from: DAY_1, date_to: DAY_2 };
    const restricted = await readThroughRouter(BUYER_A, "clickhouse-cohorts", body);
    expect(restricted.status, restricted.text.slice(0, 300)).toBe(200);
    expect(rowsOf(restricted).map((row) => `${row.cohort_date}|${row.campaign_path}`).sort()).toEqual([`${DAY_1}|${A}`, `${DAY_2}|${A}`]);
    expectScopedTo(restricted.clickhouse.statements, [A]);
    const list = restricted.clickhouse.statements.find((statement) => statement.query.includes("FROM agg"))!;
    for (const head of ["base AS (", "fcm AS ("]) expect(scopedUserPathsOf(cteBody(list.query, head)), head).toEqual(new Set([A]));
    expect(restricted.clickhouse.statements.some((statement) => /\bfcall\b/.test(statement.query))).toBe(false);
    // The snapshot is the gate's (one state read, outside the runner).
    expect(restricted.deps.loadCohortSnapshotState).toHaveBeenCalledTimes(1);
    expect(restricted.pg.callsTo("clickhouse_cohort_snapshot_state")).toEqual([]);
    expect(restricted.pg.violations).toEqual([]);
    expect(scanForLeaks(restricted.text, { funnelB: true, extra: A_EMAILS })).toEqual([]);

    // Parity contract 2 (SQL level, on the fixture): the owner's list filtered to
    // campaign_path ∈ paths(A) has the same cohorts; it differs only by the
    // synthetic ids, which restricted scope never admits.
    const owner = await readThroughRouter(PERSONAS.owner, "clickhouse-cohorts", { ...body, filters: { campaign_path: [A] } });
    expect(owner.status).toBe(200);
    const ownerRows = new Map(rowsOf(owner).map((row) => [`${row.cohort_date}|${row.funnel}|${row.campaign_path}`, row]));
    expect([...ownerRows.keys()].sort()).toEqual(rowsOf(restricted).map((row) => `${row.cohort_date}|${row.funnel}|${row.campaign_path}`).sort());
    for (const row of rowsOf(restricted)) {
      const ownerRow = ownerRows.get(`${row.cohort_date}|${row.funnel}|${row.campaign_path}`)!;
      const synthetic = SCOPE_CUSTOMERS.filter((entry) => isSyntheticCustomer(entry) && entry.path === row.campaign_path && entry.cohortDate === row.cohort_date);
      expect(row.trial_users).toBe(Number(ownerRow.trial_users) - synthetic.length);
      expect(row.gross_revenue).toBe(Number(ownerRow.gross_revenue) - synthetic.reduce((total, entry) => total + entry.gross, 0));
    }
    const totals = restricted.json?.totals as Record<string, number>;
    expect(totals.trial_users).toBe(nonSyntheticOf(A).length);
    expect(totals.gross_revenue).toBe(nonSyntheticOf(A).reduce((total, entry) => total + entry.gross, 0));

    // Positive control: buyer-{A,B} gets both of its funnels through the same path.
    const both = await readThroughRouter(BUYER_AB, "clickhouse-cohorts", body);
    expect(new Set(rowsOf(both).map((row) => row.campaign_path))).toEqual(new Set([A, B]));
    expectScopedTo(both.clickhouse.statements, [A, B]);
  });

  it.each([
    ["list with a cohort_key of B", { action: "list", cohort_key: { cohort_date: DAY_1, funnel: "past_life", campaign_path: B } }],
    ["details with a cohort_key of B", { action: "details", cohort_key: { cohort_date: DAY_1, funnel: "past_life", campaign_path: B } }],
    ["details with a funnel_key of B", { action: "details", funnel_key: { campaign_path: B } }],
    ["details with A's cohort_key and B's funnel_key", { action: "details", cohort_key: { cohort_date: DAY_1, funnel: "soulmate", campaign_path: A }, funnel_key: { campaign_path: B } }],
    ["details with a string cohort_key of B", { action: "details", cohort_key: `${B}|${DAY_1}` }],
    ["options with an 'unknown' funnel_key", { action: "options", funnel_key: { campaign_path: "unknown" } }],
    ["details with a raw registry spelling of A", { action: "details", funnel_key: { campaign_path: FUNNELS.A.rawPath } }],
  ] as const)("T02 #2 — %s: 403 funnel_out_of_scope before any query (R11)", async (_label, body) => {
    for (const persona of [BUYER_A, BUYER_AB]) {
      const isAB = persona === BUYER_AB;
      // buyer-{A,B} may name B: give it C's path instead.
      const crafted = isAB ? JSON.parse(JSON.stringify(body).split(`"${B}`).join(`"${FUNNELS.C.path}`)) : body;
      const result = await readThroughRouter(persona, "clickhouse-cohorts", crafted);
      expect(result.status, `${persona.name}: ${result.text.slice(0, 200)}`).toBe(403);
      expect(result.json).toMatchObject({ ok: false, error_code: ACCESS_ERROR.FUNNEL_OUT_OF_SCOPE, error: ACCESS_ERROR_MESSAGES.funnel_out_of_scope });
      expect(result.clickhouse.statements).toEqual([]);
      expect(result.pg.calls).toEqual([]);
      expect(result.pg.rpcCalls).toEqual([]);
      expect(scanForLeaks(result.text, { funnelB: true })).toEqual([]);
    }
  });

  it("T02 #2 — positive control: the same drilldown of an A cohort is served", async () => {
    const result = await readThroughRouter(BUYER_A, "clickhouse-cohorts", { action: "details", cohort_key: { cohort_date: DAY_1, funnel: "soulmate", campaign_path: A } });
    expect(result.status, result.text.slice(0, 200)).toBe(200);
    expectScopedTo(result.clickhouse.statements, [A]);
  });

  it.todo("Phase 4/5: #2 T02 — a users.details / support.details id outside A answers 404 with a body byte-identical to the 404 of a missing id (no existence oracle); those actions are not scopeReady yet (403 above)");

  it("T03 #3 — include filters: [A, B] serves exactly [A]'s rows and B never reaches the warehouse; [B] serves nothing; meta.access counts the dropped value", async () => {
    const window = { date_from: DAY_1, date_to: DAY_2 };
    // One snapshot for the three reads, so their bodies may be compared byte for byte.
    const snapshotState = scopeSnapshotState();
    for (const [fn, action, rowsKey] of [["clickhouse-cohorts", "list", "rows"], ["clickhouse-revenue", "bundle", "by_funnel"]] as const) {
      const read = (campaign_path: string[]) => readThroughRouter(BUYER_A, fn, { action, ...window, filters: { campaign_path } }, { snapshotState });
      const [both, onlyA, onlyB] = await Promise.all([read([A, B]), read([A]), read([B])]);
      for (const result of [both, onlyA, onlyB]) expect(result.status, `${fn}: ${result.text.slice(0, 200)}`).toBe(200);
      // Timings and meta aside (meta.access differs by design), byte-identical bodies.
      const strip = (result: RouterRead) => JSON.parse(JSON.stringify({ ...result.json, meta: null }, (key, value) => (/(^|_)duration_ms$|^generated_at$/.test(key) ? null : value)));
      expect(strip(both), fn).toEqual(strip(onlyA));
      expect((both.json?.[rowsKey] as unknown[]).length, fn).toBeGreaterThan(0);
      expect(onlyB.json?.[rowsKey], fn).toEqual([]);
      expect([both, onlyA, onlyB].map((result) => (result.json?.meta as { access: { dropped_filter_values: number } }).access.dropped_filter_values)).toEqual([1, 0, 1]);
      // What the warehouse saw: the include list bound to A only, or to the sentinel.
      for (const statement of both.clickhouse.statements) expect(boundList(statement.params, "mcp") ?? [A]).toEqual([A]);
      for (const statement of onlyB.clickhouse.statements) expect(boundList(statement.params, "mcp") ?? [OUT_OF_SCOPE_SENTINEL]).toEqual([OUT_OF_SCOPE_SENTINEL]);
      expect(onlyB.clickhouse.statements.some((statement) => boundList(statement.params, "mcp") !== null), fn).toBe(true);
      for (const result of [both, onlyB]) {
        expectScopedTo(result.clickhouse.statements, [A]);
        expect(scanStatementsForLeaks(result.clickhouse.statements, { funnelB: true }), fn).toEqual([]);
        expect(scanForLeaks(result.text, { funnelB: true }), fn).toEqual([]);
      }
    }
    // Positive control: the statement scan does see B inside buyer-{A,B}'s hex-bound fragments.
    const ab = await readThroughRouter(BUYER_AB, "clickhouse-cohorts", { action: "list", ...window });
    expect(scanStatementsForLeaks(ab.clickhouse.statements, { funnelB: true })).toContain(B);
    expect(scanForLeaks(ab.clickhouse.statements.map((statement) => statement.query), { funnelB: true })).toEqual([]);
  });

  it("T04 #4 — buyer-{A} Revenue Intelligence: filtersActive forced, the unattributed / spend streams never queried, Σ by_funnel = totals, nothing of B", async () => {
    const bundle = await readThroughRouter(BUYER_A, "clickhouse-revenue", { action: "bundle", date_from: DAY_1, date_to: "2026-09-30" });
    expect(bundle.status, bundle.text.slice(0, 300)).toBe(200);
    const totals = bundle.json?.totals as Record<string, number>;
    const byFunnel = bundle.json?.by_funnel as Array<{ key: string; gross: number }>;
    expect((bundle.json?.diagnostics as Record<string, unknown>).filters_active).toBe(true);
    expect(bundle.clickhouse.statements.length).toBeGreaterThan(0);
    for (const statement of bundle.clickhouse.statements) expect(statement.query).not.toMatch(/snapshot_users AS|fact_facebook_stats/);
    expectScopedTo(bundle.clickhouse.statements, [A]);
    expect(byFunnel.map((row) => row.key)).toEqual([A]);
    expect(byFunnel.reduce((sum, row) => sum + row.gross, 0)).toBe(totals.gross);
    expect(totals.gross).toBe(nonSyntheticOf(A).reduce((sum, entry) => sum + entry.gross, 0));
    expect(totals).toMatchObject({ spend: 0, gross_unattributed: 0, net_unattributed: 0 });
    expect(scanForLeaks(bundle.text, { funnelB: true })).toEqual([]);

    const day = await readThroughRouter(BUYER_A, "clickhouse-revenue", { action: "day_breakdown", date: DAY_1 });
    expect(day.status, day.text.slice(0, 300)).toBe(200);
    expect((day.json?.by_cohort as Array<{ cohort: string }>).map((row) => row.cohort)).not.toContain("unattributed");
    expect((day.json?.by_funnel as Array<{ key: string }>).map((row) => row.key)).toEqual([A]);
    for (const statement of day.clickhouse.statements) expect(statement.query).not.toContain("snapshot_users AS");
    expectScopedTo(day.clickhouse.statements, [A]);
    expect(scanForLeaks(day.text, { funnelB: true })).toEqual([]);

    // Positive control: the owner's unfiltered bundle runs both streams and carries the sentinels.
    const owner = await readThroughRouter(PERSONAS.owner, "clickhouse-revenue", { action: "bundle", date_from: DAY_1, date_to: "2026-09-30" });
    expect(owner.status).toBe(200);
    expect(owner.clickhouse.statements.some((statement) => statement.query.includes("snapshot_users AS"))).toBe(true);
    expect(scanForLeaks(owner.text).length).toBeGreaterThan(0);
  });

  it("T05 #5 — cohorts and FB options list only A's values and never 'unknown', whatever is selected (the scope is a base predicate, not a filter)", async () => {
    const allowed = new Set([A, "soulmate", ...new Set(nonSyntheticOf(A).map((entry) => entry.campaignId))]);
    for (const filters of [{}, { campaign_path: [A] }, { campaign_path: [B] }, { funnel: ["past_life"] }]) {
      for (const action of ["options", "list"] as const) {
        const result = await readThroughRouter(BUYER_A, "clickhouse-cohorts", { action, date_from: DAY_1, date_to: DAY_2, filters });
        expect(result.status, `${action} ${JSON.stringify(filters)}: ${result.text.slice(0, 200)}`).toBe(200);
        const values = optionValues(result.json?.filter_options);
        expect(values.length, `${action} ${JSON.stringify(filters)}`).toBeGreaterThan(0);
        for (const value of values) {
          expect(value.toLowerCase(), `${action} ${JSON.stringify(filters)}`).not.toBe("unknown");
          expect(allowed.has(value) || !SCOPE_CUSTOMERS.some((entry) => [entry.path, entry.funnel, entry.campaignId].includes(value)), `${action}: ${value}`).toBe(true);
        }
        const options = result.clickhouse.statements.find((statement) => statement.query.includes("'price_plan' dim"))!;
        expect(scopedUserPathsOf(cteBody(options.query, "fcm AS ("))).toEqual(new Set([A]));
        expect(scanForLeaks(result.text, { funnelB: true })).toEqual([]);
      }
    }
    for (const filters of [{}, { buyer: ["Bob"] }, { campaign_id: ["fb_b"] }, { campaign_id: ["fb_mixed"] }]) {
      const result = await readThroughRouter(BUYER_A, "clickhouse-facebook", { action: "filters", filters });
      expect(result.status, result.text.slice(0, 200)).toBe(200);
      const options = result.json?.filter_options as { buyers: Array<{ value: string }>; campaigns: Array<{ value: string }> };
      for (const option of options.campaigns) expect(option.value, JSON.stringify(filters)).toBe("fb_a");
      for (const option of options.buyers) expect(option.value, JSON.stringify(filters)).toBe("Alice");
      expectScopedTo(result.clickhouse.statements, [A]);
      expect(scanForLeaks(result.text, { funnelB: true })).toEqual([]);
    }
  });

  it.todo("Phase 4/5: #5 T05b — a users / support search term without users.pii.view / support.messages.view is 403 (no Phase-2 surface searches on the server; their options producers are not scopeReady yet)");

  it("T06 #6 — the fixture's campaign scope comes from the REAL classifier (≥3 anchors on one canonical path)", () => {
    const statusOf = Object.fromEntries(SCOPE_CAMPAIGNS.map((campaign) => [campaign.id, `${campaign.scope.status}:${campaign.scope.campaign_path}`]));
    expect(statusOf).toEqual({
      fb_a: `resolved:${A}`, fb_b: `resolved:${B}`, fb_c: `resolved:${FUNNELS.C.path}`,
      fb_mixed: "mixed:", fb_thin: "unresolved:", fb_unknown: "unresolved:",
    });
  });

  it.each(["campaign", "adset", "ad"] as const)("T06 #6 — FB report at %s level: only resolved campaigns of the member's paths; a campaign shared by A and B is hidden from both buyers", async (level) => {
    const body = { action: "report", level, filters: { date_from: DAY_1, date_to: DAY_2 } };
    const idsOf = (result: RouterRead) => [...new Set((result.json?.rows as Array<{ campaign_id: string }>).map((row) => row.campaign_id))].sort();

    const onlyA = await readThroughRouter(BUYER_A, "clickhouse-facebook", body);
    expect(onlyA.status, onlyA.text.slice(0, 300)).toBe(200);
    expect(idsOf(onlyA)).toEqual(["fb_a"]);
    expect((onlyA.json?.filter_options as { campaigns: Array<{ value: string }> }).campaigns.map((option) => option.value)).toEqual(["fb_a"]);
    expect((onlyA.json?.summary as { campaigns: number; spend: number }).campaigns).toBe(1);
    expect((onlyA.json?.summary as { spend: number }).spend).toBe(200);
    expectScopedTo(onlyA.clickhouse.statements, [A]);
    for (const statement of onlyA.clickhouse.statements) expect(statement.query).not.toMatch(/\bv_fb_\w+/);
    expect(scanForLeaks(onlyA.text, { funnelB: true })).toEqual([]);
    if (level === "campaign") {
      // Blended metrics count the member's own (non-synthetic) customers of the campaign.
      const blended = (onlyA.json?.rows as Array<{ blended: { trial_users: number } }>)[0].blended;
      expect(blended.trial_users).toBe(nonSyntheticOf(A).filter((entry) => entry.campaignId === "fb_a").length);
    }

    const both = await readThroughRouter(BUYER_AB, "clickhouse-facebook", body);
    expect(both.status).toBe(200);
    expect(idsOf(both)).toEqual(["fb_a", "fb_b"]);
    expectScopedTo(both.clickhouse.statements, [A, B]);
    // fb_mixed (A and B anchors) is hidden even from the member holding both funnels.
    expect(scanForLeaks(both.text, { extra: ['"fb_mixed"', '"fb_thin"', '"fb_unknown"', '"fb_c"', "shared retargeting", "Palm prospecting"] })).toEqual([]);

    // Positive control: the owner sees the shared campaign and its spend sentinel.
    const owner = await readThroughRouter(PERSONAS.owner, "clickhouse-facebook", body);
    expect(owner.status).toBe(200);
    expect(idsOf(owner)).toEqual(SCOPE_CAMPAIGNS.map((campaign) => campaign.id).sort());
    expect(scanForLeaks(owner.text).length).toBeGreaterThan(0);
  });

  it("T06 #6 — the account and day levels are 403 scope_not_supported with zero SQL, for every FB read", async () => {
    for (const action of ["report", "list", "charts", "summary", "status"]) {
      for (const level of ["account", "day"]) {
        for (const persona of [BUYER_A, BUYER_AB]) {
          const result = await readThroughRouter(persona, "clickhouse-facebook", { action, level });
          expect(result.status, `${action} ${level}: ${result.text.slice(0, 200)}`).toBe(403);
          expect(result.json).toMatchObject({ ok: false, error_code: ACCESS_ERROR.SCOPE_NOT_SUPPORTED, error: ACCESS_ERROR_MESSAGES.scope_not_supported });
          expect(result.clickhouse.statements).toEqual([]);
        }
      }
    }
  });

  it("T06 #6 — FB status redacts the tenant counters and spend; the Cohorts FB columns never carry a hidden campaign's spend", async () => {
    const status = await readThroughRouter(BUYER_A, "clickhouse-facebook", { action: "status", level: "campaign" });
    expect(status.status, status.text.slice(0, 300)).toBe(200);
    const state = status.json?.state as Record<string, unknown>;
    expect(state).toMatchObject({ sync_name: "fact_facebook_stats_sync", status: "completed" });
    for (const field of ["clickhouse_total", "source_total", "last_error", "auth_user_id"]) expect(state, field).not.toHaveProperty(field);
    expect(state.diagnostics).not.toHaveProperty("day_spend_total");
    expect(state.diagnostics).not.toHaveProperty("spend_by_level");
    expect((status.json?.diagnostics as Record<string, unknown>).warehouse_rows).toBe(SCOPE_DAYS.length);
    expectScopedTo(status.clickhouse.statements, [A]);
    expect(scanForLeaks(status.text, { funnelB: true, extra: [DATA_KEY] })).toEqual([]);

    const cohorts = await readThroughRouter(BUYER_A, "clickhouse-cohorts", { action: "list", date_from: DAY_1, date_to: DAY_2 });
    expect(cohorts.status).toBe(200);
    expect(cohorts.clickhouse.statements.some((statement) => statement.query.includes("fact_campaign_scope"))).toBe(true);
    expect((cohorts.json?.fb_diagnostics as { fb_data_status: string }).fb_data_status).not.toBe("unavailable");
    expect(scanForLeaks(cohorts.text, { funnelB: true })).toEqual([]);
  });

  it("#1-#6 — every scopeReady action, for buyer-{A}: 200, every read scoped to paths(A), nothing of B in the request's warehouse traffic or body", async () => {
    expect(Object.keys(SCOPE_READY_REQUESTS).sort()).toEqual([...SCOPE_READY_ACTIONS].sort());
    for (const [key, body] of Object.entries(SCOPE_READY_REQUESTS)) {
      const fn = key.slice(0, key.lastIndexOf("."));
      const result = await readThroughRouter(BUYER_A, fn, body);
      expect(result.status, `${key}: ${result.text.slice(0, 300)}`).toBe(200);
      if (fn === "clickhouse-summary") expect(result.clickhouse.statements, key).toEqual([]);
      else expectScopedTo(result.clickhouse.statements, [A]);
      expect(scanStatementsForLeaks(result.clickhouse.statements, { funnelB: true }), key).toEqual([]);
      expect(scanForLeaks(result.text, { funnelB: true }), key).toEqual([]);
      expect(result.pg.violations, key).toEqual([]);
    }
  });

  it("never a silent fallback: restricted reads use no dynamic / legacy classifier and no V2 FB view, even with FB_WAREHOUSE_V2_READS on", async () => {
    vi.stubEnv("FB_WAREHOUSE_V2_READS", "true");
    try {
      const statements = await restrictedStatementCorpus(BUYER_A);
      expect(statements.length).toBeGreaterThan(20);
      for (const statement of statements) expect(statement.query, statement.query.slice(0, 160)).not.toMatch(/\bv_fb_\w+|\belig AS \(|\buserdim AS \(|\bwarehouse_hash\b|system\.tables/);
      // Positive control: the owner's FB reads DO switch under the same flag.
      const owner = await readThroughRouter(PERSONAS.owner, "clickhouse-facebook", { action: "list", level: "adset" });
      expect(owner.clickhouse.statements.some((statement) => /\bv_fb_\w+/.test(statement.query))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("the router replicas follow the routers' restricted lines (index.ts imports esm.sh and cannot run here)", () => {
    expect(Object.keys(ROUTER_REPLICAS).sort()).toEqual([...new Set(SCOPE_READY_ACTIONS.map((key) => key.slice(0, key.lastIndexOf("."))))].sort());
    const source = (fn: string) => readFileSync(resolve(process.cwd(), "supabase/functions", fn, "index.ts"), "utf8");
    const cohorts = source("clickhouse-cohorts");
    expect(cohorts).toMatch(/if \(ctx\.restricted\) return await restrictedCohorts\(/);
    expect(cohorts).toContain("const { request, dropped } = restrictCohortRequest(scope, input.body);");
    expect(cohorts).toContain('if (!result) throw new ScopeSnapshotNotReadyError("snapshot_missing");');
    const revenue = source("clickhouse-revenue");
    expect(revenue).toContain("const shaped = ctx.restricted ? restrictRevenueRequest(scope, body)");
    expect(revenue).toContain("return ctx.restricted ? withRestrictedMeta(result, shaped.dropped) : result;");
    const facebook = source("clickhouse-facebook");
    expect(facebook).toContain("if (ctx.restricted) assertFbLevelInScope(scope, level);");
    expect(facebook).toContain('if (ctx.restricted && read !== "filters") assertFbLevelInScope(scope, normalizeFbLevel((body as FbReadRequest).level));');
    expect(facebook).toMatch(/const visibleState = ctx\.restricted\s*\? projectFbSyncStateForRestricted\(state\)/);
    expect(facebook).toMatch(/if \(error instanceof ScopeViolation \|\| error instanceof FbActionError \|\| error instanceof ScopeForbiddenError \|\| error instanceof ScopeSnapshotNotReadyError\) throw error;/);
    for (const runner of ["runFbReport({ clickhouse: ch, supabase: pg, authUserId, request: body as FbReadRequest, scope })", "runFbList(ch, authUserId, body as FbReadRequest, scope)", "runFbCharts(ch, authUserId, body as FbReadRequest, scope)", "runFbFilterOptions(ch, authUserId, body as FbReadRequest, scope)"]) {
      expect(facebook, runner).toContain(runner);
    }
    const summary = source("clickhouse-summary");
    expect(summary).toMatch(/if \(!summaryKpisVisible\(ctx\)\) \{[\s\S]*?return memberWarehouseSummary\(/);
  });
});

describe("#7 Transactions cannot expose forbidden data (Milestone A: raw downloads are data-owner only)", () => {
  it("rawOnly actions refuse an all-scope admin holding every permission", async () => {
    const raw = CASES.filter((entry) => entry.rule.rawOnly);
    expect(raw.map((entry) => entry.fn)).toEqual(expect.arrayContaining(["dashboard-summary", "fb-analytics-summary", "funnelfox-leads-sync", "clickhouse-init"]));
    for (const entry of raw) {
      const { deps } = fakeGate({ persona: withGrant(PERSONAS.admin, ENFORCED_PERMISSION_KEYS) });
      const result = await callGate(entry.policy, probeHandler().handler, requestFor(entry).req, deps);
      expect(result.status, `${entry.fn}.${entry.action}`).toBe(403);
    }
  });

  it("PostgREST: no employee reads the transaction warehouse, not even its own private copy (RLS lockdown)", async () => {
    const { h } = locked;
    const count = (user: string) => h.asUser(user, async (tx) => (await tx.query<{ n: number }>("select count(*)::int as n from public.transactions")).rows[0].n);
    const planted = (await h.db.query<{ n: number }>("select count(*)::int as n from public.transactions where auth_user_id = $1", [USER_IDS.viewer])).rows[0].n;
    expect(planted).toBe(1);
    expect(await count(DATA_KEY)).toBe(1);
    for (const user of [USER_IDS.admin, USER_IDS.viewer, USER_IDS.buyerA, USER_IDS.emptyGrant]) expect(await count(user), user).toBe(0);
  });
});

// =========================================================================================
// #14 — Admin cache cannot leak to a restricted user
// =========================================================================================

describe("#14 cache partitions and purges", () => {
  it("resolve_access issues a different partition per principal and per scope, equal to the TS formula", async () => {
    const { h } = locked;
    const partitions = new Map<string, string>();
    for (const name of ["owner", "admin", "viewer", "buyerA", "buyerAB", "emptyGrant", "noRule"] as const) {
      const row = await svc(h, "public.resolve_access($1)", [USER_IDS[name]]);
      const scope = row.funnel_scope as { mode: FunnelScopeMode; funnel_ids: string[] };
      expect(row.partition, name).toBe(await computeAccessPartition({
        workspaceId: row.workspace_id as string,
        userId: USER_IDS[name],
        accessVersion: row.access_version as string,
        mode: scope.mode,
        funnelIds: scope.funnel_ids,
      }));
      partitions.set(name, row.partition as string);
    }
    expect(new Set(partitions.values()).size).toBe(partitions.size);
  });

  it("the partition formula separates principal, scope mode, funnel set and access version (and ignores id order / case)", async () => {
    const base = { workspaceId: WORKSPACE_ID, userId: USER_IDS.viewer, accessVersion: "4", mode: "selected" as FunnelScopeMode, funnelIds: [FUNNELS.A.id, FUNNELS.B.id] };
    const variants = [
      base,
      { ...base, userId: USER_IDS.admin },
      { ...base, mode: "all" as FunnelScopeMode, funnelIds: [] },
      { ...base, mode: "none" as FunnelScopeMode, funnelIds: [] },
      { ...base, funnelIds: [FUNNELS.A.id] },
      { ...base, accessVersion: "5" },
    ];
    const hashes = await Promise.all(variants.map((variant) => computeAccessPartition(variant)));
    expect(new Set(hashes).size).toBe(variants.length);
    expect(await computeAccessPartition({ ...base, funnelIds: [FUNNELS.B.id.toUpperCase(), FUNNELS.A.id] })).toBe(hashes[0]);
    expect(hashes[0]).toBe(await sha256Hex(accessPartitionInput(base)));
  });

  describe("AccessProvider runs the purge registry", () => {
    const purges: PurgeReason[] = [];
    let unregister: (() => void) | null = null;
    let latest: AccessContextValue | null = null;
    const box = { user: USER_IDS.viewer as string, partition: "p-viewer-1", version: "1" };
    const client = { rpc: vi.fn(async () => ({ data: myAccess(box.user, box.partition, box.version), error: null, status: 200 })) };

    function myAccess(userId: string, partition: string, version: string) {
      const { data_key: _omitted, ...row } = accessRow(PERSONAS.viewer, { user_id: userId, partition, access_version: version });
      return row;
    }
    function auth(userId: string | null): AuthContextValue {
      return {
        configured: true, supabaseConfigured: true, localAuthEnabled: false, mode: "supabase", loading: false, session: null,
        user: userId ? { id: userId, email: `${userId}@example.test`, provider: "supabase" } : null,
        signIn: async () => {}, signOut: async () => {},
      };
    }
    function Probe() {
      latest = useAccess();
      return null;
    }
    const tree = (userId: string | null) =>
      createElement(AuthContext.Provider, { value: auth(userId) },
        createElement(AccessProvider, { client, refreshIntervalMs: 0, focusRefreshMinGapMs: 0, children: createElement(Probe) }));

    beforeEach(() => {
      localStorage.clear();
      purges.length = 0;
      latest = null;
      Object.assign(box, { user: USER_IDS.viewer, partition: "p-viewer-1", version: "1" });
      unregister = registerPurgeHandler("security-suite-recorder", (reason) => {
        purges.push(reason);
      });
    });
    afterEach(() => {
      unregister?.();
      cleanup();
    });

    it("purges on SIGNED_OUT", async () => {
      const view = render(tree(USER_IDS.viewer));
      await waitFor(() => expect(latest?.status).toBe("ok"));
      view.rerender(tree(null));
      await waitFor(() => expect(purges).toContain("signed_out"));
      expect(latest?.partition).toBe("");
    });

    it("purges on an in-tab account switch, and never exposes the previous principal's partition", async () => {
      const view = render(tree(USER_IDS.viewer));
      await waitFor(() => expect(latest?.partition).toBe("p-viewer-1"));
      Object.assign(box, { user: USER_IDS.admin, partition: "p-admin-1" });
      view.rerender(tree(USER_IDS.admin));
      expect(latest?.partition).not.toBe("p-viewer-1");
      await waitFor(() => expect(purges).toContain("principal_changed"));
      await waitFor(() => expect(latest?.partition).toBe("p-admin-1"));
    });

    it("purges at start-up when another principal used this browser last", async () => {
      notePrincipal(USER_IDS.admin);
      render(tree(USER_IDS.viewer));
      await waitFor(() => expect(purges).toContain("principal_changed"));
    });

    it("purges when the server narrows the same user's access (partition change)", async () => {
      render(tree(USER_IDS.viewer));
      await waitFor(() => expect(latest?.partition).toBe("p-viewer-1"));
      Object.assign(box, { partition: "p-viewer-2", version: "2" });
      await act(async () => {
        await latest!.refresh();
      });
      expect(purges).toContain("access_changed");
      expect(latest?.partition).toBe("p-viewer-2");
    });
  });

  describe("cache owners", () => {
    const idb = { opens: 0, deletes: [] as string[] };
    beforeEach(() => {
      idb.opens = 0;
      idb.deletes.length = 0;
      vi.stubGlobal("indexedDB", {
        open: () => {
          idb.opens += 1;
          const request: Record<string, unknown> = {};
          setTimeout(() => (request.onerror as (() => void) | undefined)?.(), 0);
          return request;
        },
        deleteDatabase: (name: string) => {
          idb.deletes.push(name);
          const request: Record<string, unknown> = {};
          setTimeout(() => (request.onsuccess as (() => void) | undefined)?.(), 0);
          return request;
        },
      });
      sessionStorage.clear();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      setActiveCacheAccess(null);
    });

    it("every cache owner registered a purge handler", () => {
      expect(registeredPurgeHandlers()).toEqual(expect.arrayContaining([
        "clickhouse-client-memos", "analytics-session-cache", "data-store", "ai-assistant-store", "ai-recommendation-log",
        "cohort-snapshot-auto-rebuild", "palmer-indexeddb", "subscriptions-indexeddb", "traffic-indexeddb", "warehouse-indexeddb", "page-ui-state",
      ]));
    });

    it.each(["signed_out", "principal_changed"] as const)("a %s purge drops persisted analytics and every raw-dataset IndexedDB", async (reason) => {
      sessionStorage.setItem(analyticsPersistKey("p-admin"), JSON.stringify({ rows: [SENTINEL_EMAILS[0]] }));
      sessionStorage.setItem("analytics.qcache.v1", "{}");
      await runPurge(reason);
      expect(sessionStorage.getItem(analyticsPersistKey("p-admin"))).toBeNull();
      expect(sessionStorage.getItem("analytics.qcache.v1")).toBeNull();
      expect(idb.deletes).toEqual(expect.arrayContaining([PALMER_CACHE_DB_NAME, SUBSCRIPTION_CACHE_DB_NAME, TRAFFIC_CACHE_DB_NAME, WAREHOUSE_TRANSACTIONS_CACHE_DB_NAME]));
    });

    it("IndexedDB raw datasets are not even opened without raw access", async () => {
      setActiveCacheAccess({ partition: "p-member", rawAccess: false });
      expect(await loadLastPalmerDatasetFromCache()).toBeNull();
      expect(idb.opens).toBe(0);
    });
  });
});

// =========================================================================================
// #15 — Funnel removal (any access change) is effective on the next request
// =========================================================================================

describe("#15 access changes are effective on the next request", () => {
  it("access_version and the partition move on scope, role and role-permission changes, not on cosmetic edits", async () => {
    const h = await cloneLocked();
    const { members, roles } = locked;
    const version = async (user: string) => {
      const row = await svc(h, "public.resolve_access($1)", [user]);
      return { v: Number(row.access_version), partition: row.partition as string };
    };
    const buyer0 = await version(USER_IDS.buyerA);
    const viewer0 = await version(USER_IDS.viewer);
    const buyerAB0 = await version(USER_IDS.buyerAB);

    await svc(h, SET_SCOPE_SQL, [USER_IDS.admin, members.buyerA, "selected", [FUNNELS.A.id, FUNNELS.C.id]]);
    const buyer1 = await version(USER_IDS.buyerA);
    expect(buyer1.v).toBeGreaterThan(buyer0.v);
    expect(buyer1.partition).not.toBe(buyer0.partition);

    await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, members.buyerA, roles.analyst, null, null]);
    const buyer2 = await version(USER_IDS.buyerA);
    expect(buyer2.v).toBeGreaterThan(buyer1.v);

    await svc(h, UPDATE_ROLE_SQL, [USER_IDS.admin, roles.media_buyer, null, null, [...TEMPLATE_PERMISSIONS.mediaBuyer, "cohorts.export"]]);
    expect((await version(USER_IDS.buyerAB)).v).toBeGreaterThan(buyerAB0.v);
    expect((await version(USER_IDS.viewer)).v).toBe(viewer0.v);

    await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, members.buyerA, null, null, "Renamed buyer"]);
    expect((await version(USER_IDS.buyerA)).v).toBe(buyer2.v);
  });

  it("the gate resolves access on EVERY request: scope narrowing and disabling apply to the very next call", async () => {
    const h = await cloneLocked();
    const { members } = locked;
    const { deps, clickhouse } = pgliteGateDeps(h);
    const probe = probeHandler();
    // cohort-membership status: a cohorts.view read that is NOT scopeReady, so
    // the narrowed call is refused at the gate (Phase 2 serves cohorts list).
    const call = async () => callGate(CLICKHOUSE_COHORT_MEMBERSHIP_POLICY, probe.handler, edgeRequest({ token: userToken(USER_IDS.viewer), body: { action: "status" } }).req, deps);

    const first = await call();
    expect(first.status).toBe(200);
    const firstVersion = probe.seen[0].ctx.accessVersion;

    await svc(h, SET_SCOPE_SQL, [USER_IDS.admin, members.viewer, "selected", [FUNNELS.A.id]]);
    const narrowed = await call();
    expect(narrowed.status).toBe(403);
    expect(narrowed.json?.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);

    await svc(h, SET_SCOPE_SQL, [USER_IDS.admin, members.viewer, "all", []]);
    await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, members.viewer, null, "disabled", null]);
    const disabled = await call();
    expect(disabled.status).toBe(403);
    expect(disabled.json?.error_code).toBe(ACCESS_ERROR.MEMBERSHIP_DISABLED);

    await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, members.viewer, null, "active", null]);
    const restored = await call();
    expect(restored.status).toBe(200);
    expect(Number(probe.seen[1].ctx.accessVersion)).toBeGreaterThan(Number(firstVersion));

    expect(deps.loadAccess).toHaveBeenCalledTimes(4);
    for (const [userId] of deps.loadAccess.mock.calls) expect(userId).toBe(USER_IDS.viewer);
    expect(probe.spy).toHaveBeenCalledTimes(2);
    expect(clickhouse.boundTenants()).toEqual([DATA_KEY]);
  });

  it.todo("§25 (not in the Milestone-A brief): every Edge response carries meta.access = { v, partition, narrowed } and the browser purges + remounts when it differs from the AccessProvider partition (today only the focus / 5-minute my_access refetch detects a change)");
});

// =========================================================================================
// #16 — Disabled user cannot retrieve analytics
// =========================================================================================

describe("#16 a disabled member gets nothing", () => {
  it.each(CASE_ROWS)("%s: 403 membership_disabled before the handler", async (_label, entry) => {
    const { deps, clickhouse } = fakeGate({ persona: withGrant(PERSONAS.disabled, ENFORCED_PERMISSION_KEYS) });
    const probe = probeHandler();
    const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
    expect(result.status).toBe(403);
    expect(result.json).toEqual({ ok: false, error_code: ACCESS_ERROR.MEMBERSHIP_DISABLED, error: ACCESS_ERROR_MESSAGES.membership_disabled });
    expect(probe.spy).not.toHaveBeenCalled();
    expect(clickhouse.statements).toEqual([]);
  });

  it("the real resolver reports the seeded disabled member as disabled, and the gate refuses it", async () => {
    const { deps, clickhouse } = pgliteGateDeps(locked.h);
    const result = await callGate(CLICKHOUSE_COHORTS_POLICY, probeHandler().handler, edgeRequest({ token: userToken(USER_IDS.disabled), body: { action: "list" } }).req, deps);
    expect(result.status).toBe(403);
    expect(result.json?.error_code).toBe(ACCESS_ERROR.MEMBERSHIP_DISABLED);
    expect(clickhouse.statements).toEqual([]);
    const mine = await locked.h.asUser(USER_IDS.disabled, async (tx) => (await tx.query<{ v: { status: string } }>("select public.my_access() as v")).rows[0].v);
    expect(mine.status).toBe("disabled");
  });

  it("RLS returns zero rows to a disabled member (and to a non-member), even rows stored under its own id", async () => {
    const { h } = locked;
    const tables = [...TENANT_ROW_TABLES, "reports", "project_forecasts", "funnels"];
    const countAs = (user: string, table: string) =>
      h.asUser(user, async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n);
    for (const table of TENANT_ROW_TABLES) {
      const own = (await h.db.query<{ n: number }>(`select count(*)::int as n from public.${table} where auth_user_id = $1`, [USER_IDS.disabled])).rows[0].n;
      expect(own, `${table} seeded under the disabled id`).toBe(1);
      expect(await countAs(DATA_KEY, table), `${table} owner control`).toBeGreaterThan(0);
    }
    for (const user of [USER_IDS.disabled, USER_IDS.nonMember]) {
      for (const table of tables) expect(await countAs(user, table), `${user} ${table}`).toBe(0);
    }
  });
});

// =========================================================================================
// #17 / #18 — Non-admins cannot change or read others' access configuration
// =========================================================================================

describe("#17 a non-admin cannot change permissions", () => {
  const NON_ADMINS: Persona[] = [
    PERSONAS.viewer,
    withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.analyst, { name: "analyst" }),
    withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.headOfMarketing, { name: "head-of-marketing" }),
    withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.productManager, { name: "product-manager" }),
    withGrant(PERSONAS.viewer, ENFORCED_PERMISSION_KEYS.filter((key) => !isPrivilegedPermission(key)), { name: "every-non-admin-key" }),
    PERSONAS.buyerA,
    withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS, { name: "restricted-holding-admin-keys" }),
  ];

  it.each(userActions(ACCESS_POLICY as never).map((action) => [action]))("access.%s is refused to every non-admin before the handler", async (action) => {
    for (const persona of NON_ADMINS) {
      const { deps } = fakeGate({ persona });
      const probe = probeHandler({ query: false });
      const result = await callGate(ACCESS_POLICY, probe.handler, edgeRequest({ body: { action } }).req, deps);
      expect(result.status, persona.name).toBe(403);
      expect([ACCESS_ERROR.PERMISSION_DENIED, ACCESS_ERROR.OWNER_REQUIRED]).toContain(result.json?.error_code);
      expect(probe.spy).not.toHaveBeenCalled();
    }
  });

  it("positive control: an admin reaches the access API", async () => {
    const { deps } = fakeGate({ persona: PERSONAS.admin });
    const probe = probeHandler({ query: false });
    expect((await callGate(ACCESS_POLICY, probe.handler, edgeRequest({ body: { action: "members.list" } }).req, deps)).status).toBe(200);
  });

  it("no browser role can write an access table or call a mutation RPC (PGlite)", async () => {
    const h = await cloneLocked();
    const { members, roles } = locked;
    const writes = [
      ["insert into public.access_roles (workspace_id, key, name, permissions) select id, 'self_grant', 'x', '{admin.users.manage}' from public.workspaces", []],
      ["update public.workspace_members set role_id = $1 where user_id = $2", [roles.admin, USER_IDS.viewer]],
      ["update public.access_roles set permissions = '{admin.users.manage,admin.users.view}' where id = $1", [roles.viewer]],
      ["insert into public.member_scope_rules (member_id, dimension, mode) values ($1, 'funnel', 'all') on conflict do nothing", [members.buyerA]],
      ["insert into public.member_scope_values (member_id, dimension, funnel_id) values ($1, 'funnel', $2)", [members.buyerA, FUNNELS.B.id]],
      ["delete from public.member_scope_values where member_id = $1", [members.buyerAB]],
      ["insert into public.access_audit_log (workspace_id, actor_kind, event, outcome) select id, 'user', 'member.added', 'success' from public.workspaces", []],
    ] as const;
    for (const user of [USER_IDS.viewer, USER_IDS.buyerA, USER_IDS.admin, DATA_KEY]) {
      for (const [sql, params] of writes) {
        await expect(h.asUser(user, (tx) => tx.query(sql, [...params])), `${user}: ${sql}`).rejects.toThrow(/permission denied/);
      }
      await expect(
        h.asUser(user, (tx) => tx.query("select public.access_update_member($1, $2, $3, null, null)", [user, members.viewer, roles.admin])),
      ).rejects.toThrow(/permission denied for function access_update_member/);
      await expect(
        h.asUser(user, (tx) => tx.query("select public.access_create_role($1, 'x_role', 'X', '', '{admin.users.manage}'::text[])", [user])),
      ).rejects.toThrow(/permission denied for function access_create_role/);
    }
    const viewerRole = await svc<string>(h, "(select role_id::text from public.workspace_members where user_id = $1)", [USER_IDS.viewer]);
    expect(viewerRole).toBe(roles.viewer);
  });
});

describe("#18 a non-admin cannot read others' access configuration", () => {
  it("members see their own membership, role and scope rows only; no audit, no counters, no workspace", async () => {
    const { h, members, roles } = locked;
    const rowsAs = async <T>(user: string, sql: string) => (await h.asUser(user, (tx) => tx.query<T>(sql))).rows;
    const expectations: Array<[string, string, string]> = [
      [USER_IDS.viewer, members.viewer, roles.viewer],
      [USER_IDS.buyerA, members.buyerA, roles.media_buyer],
      [USER_IDS.buyerAB, members.buyerAB, roles.media_buyer],
      [USER_IDS.emptyGrant, members.emptyGrant, roles.viewer],
    ];
    for (const [user, member, role] of expectations) {
      expect(await rowsAs(user, "select id::text as id from public.workspace_members"), user).toEqual([{ id: member }]);
      expect(await rowsAs(user, "select id::text as id from public.access_roles"), user).toEqual([{ id: role }]);
      for (const row of await rowsAs<{ member_id: string }>(user, "select member_id::text as member_id from public.member_scope_rules")) expect(row.member_id).toBe(member);
      for (const row of await rowsAs<{ member_id: string }>(user, "select member_id::text as member_id from public.member_scope_values")) expect(row.member_id).toBe(member);
      expect(await rowsAs(user, "select id from public.access_audit_log"), user).toEqual([]);
      expect(await rowsAs(user, "select day from public.access_denial_counters"), user).toEqual([]);
      await expect(rowsAs(user, "select id from public.workspaces")).rejects.toThrow(/permission denied/);
    }
    expect(await rowsAs(USER_IDS.buyerAB, "select funnel_id::text as f from public.member_scope_values order by 1")).toEqual(
      [{ f: FUNNELS.A.id }, { f: FUNNELS.B.id }].sort((a, b) => a.f.localeCompare(b.f)),
    );
    // Positive control: the admin does see the member list and the audit log.
    expect((await rowsAs(USER_IDS.admin, "select id from public.workspace_members")).length).toBeGreaterThanOrEqual(8);
    expect((await rowsAs(USER_IDS.admin, "select id from public.access_audit_log")).length).toBeGreaterThan(0);
  });

  it("my_access never reveals the data key or another member", async () => {
    const { h } = locked;
    for (const user of [USER_IDS.viewer, USER_IDS.buyerA, USER_IDS.admin]) {
      const mine = await h.asUser(user, async (tx) => (await tx.query<{ v: Record<string, unknown> }>("select public.my_access() as v")).rows[0].v);
      expect(mine).not.toHaveProperty("data_key");
      expect(JSON.stringify(mine)).not.toContain(DATA_KEY);
      expect(mine.user_id).toBe(user);
    }
  });
});

// =========================================================================================
// #19 — Missing AccessContext fails closed
// =========================================================================================

describe("#19 a missing or broken AccessContext fails closed", () => {
  const entry = CASES.find((candidate) => candidate.fn === "clickhouse-cohorts" && candidate.action === "list")!;
  const okRow = accessRow(PERSONAS.viewer);

  it.each([
    ["resolve_access throws", { loadAccess: async () => { throw new Error(`pg down ${SENTINEL_EMAILS[0]}`); } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["resolve_access returns an error", { loadAccess: async () => ({ data: null, error: { message: SENTINEL_CLICKHOUSE_ERROR } }) }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["no row", { row: null }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["a non-JSON string", { row: "<html>gateway</html>" }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an unknown status", { row: { status: "maybe", user_id: USER_IDS.viewer } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an ok row without data_key", { row: { ...okRow, data_key: null } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an ok row with a malformed data_key", { row: { ...okRow, data_key: "not-a-uuid" } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an ok row without a role", { row: { ...okRow, role: null } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an ok row without partition", { row: { ...okRow, partition: "" } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an ok row without access_version", { row: { ...okRow, access_version: null } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["an ok row without workspace / member ids", { row: { ...okRow, workspace_id: null, member_id: null } }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["a row for another user", { row: accessRow(PERSONAS.admin) }, ACCESS_ERROR.ACCESS_SERVICE_ERROR],
    ["no workspace", { row: { status: "no_workspace", user_id: USER_IDS.viewer, workspace_id: null } }, ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED],
  ] as const)("%s → 503, never the handler", async (_label, override, code) => {
    const { deps, clickhouse } = fakeGate({ persona: PERSONAS.viewer, ...(override as object) });
    const probe = probeHandler();
    const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
    expect(result.status).toBe(503);
    expect(result.json).toEqual({ ok: false, error_code: code, error: ACCESS_ERROR_MESSAGES[code] });
    expect(probe.spy).not.toHaveBeenCalled();
    expect(clickhouse.statements).toEqual([]);
    expect(scanForLeaks(result.text)).toEqual([]);
  });

  it("an auth-service fault is 503 (not a sign-out) and the body is never read", async () => {
    const { deps } = fakeGate({ getUser: async () => ({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } }) });
    const { req, textSpy } = requestFor(entry);
    const result = await callGate(entry.policy, probeHandler().handler, req, deps);
    expect(result.status).toBe(503);
    expect(result.json?.error_code).toBe(ACCESS_ERROR.AUTH_SERVICE_ERROR);
    expect(textSpy).not.toHaveBeenCalled();
    expect(deps.loadAccess).not.toHaveBeenCalled();
  });

  it.each([PERSONAS.owner, PERSONAS.viewer])("a ScopeViolation the handler swallows still turns the response into 500 ($name)", async (persona) => {
    for (const variant of ["swallow", "wrap", "response"] as const) {
      const { deps, clickhouse } = fakeGate({ persona });
      const handler = async (request: AccessRequest<string>) => {
        const reader = request.clickhouse();
        const attempt = reader.query({ query: "SELECT email FROM fact_user_cohorts WHERE auth_user_id = {auth_user_id:String}", query_params: { auth_user_id: FOREIGN_TENANT } });
        if (variant === "swallow") return { ok: true, rows: await attempt.catch(() => [sentinelRow()]) };
        if (variant === "wrap") {
          try {
            await attempt;
          } catch (error) {
            throw new Error(`wrapped: ${(error as Error).message} ${SENTINEL_EMAILS[0]}`);
          }
        }
        await attempt.catch(() => null);
        return new Response(JSON.stringify(sentinelRow()), { status: 200 });
      };
      const result = await callGate(entry.policy, handler, requestFor(entry).req, deps);
      expect(result.status, variant).toBe(500);
      expect(result.json).toEqual({ ok: false, error_code: ACCESS_ERROR.SCOPE_VIOLATION, error: "Request failed.", request_id: "req-security" });
      expect((await scanResponse(result.response)).leaks).toEqual([]);
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it("a real runner's best-effort catch rethrows the violation: a tampered tenant fails the request instead of answering 'unavailable'", async () => {
    const respond = (statement: { query: string }) => (statement.query.includes("system.tables") ? [{ c: 1 }] : [{ support_requests: 3, support_unique_emails: 2 }]);
    const handler = async (request: AccessRequest<string>) => supportDataStatus(request.clickhouse(), String(request.body.auth_user_id ?? request.ctx.tenantKey));

    const honest = fakeGate({ persona: PERSONAS.viewer, clickhouse: createRecordingClickHouse(respond) });
    const ok = await callGate(entry.policy, handler, requestFor(entry).req, honest.deps);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ support_data_status: "ready", support_requests: 3, support_unique_emails: 2 });

    const tampered = fakeGate({ persona: PERSONAS.viewer, clickhouse: createRecordingClickHouse(respond) });
    const failed = await callGate(entry.policy, handler, requestFor(entry, { action: "list", auth_user_id: FOREIGN_TENANT }).req, tampered.deps);
    expect(failed.status).toBe(500);
    expect(failed.json?.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
    expect(tampered.clickhouse.boundTenants()).toEqual([]);

    // Directly: both cohort probes rethrow instead of mapping it to a status string.
    const ctx = contextFor(PERSONAS.viewer);
    await expect(subscriptionDataStatus(createScopedReader(ctx, createRecordingClickHouse()), FOREIGN_TENANT)).rejects.toBeInstanceOf(ScopeViolation);
  });

  it("no SQL or warehouse text reaches an employee; the data owner keeps the raw error (+ request_id only)", async () => {
    const thrower = async () => {
      throw new Error(SENTINEL_CLICKHOUSE_ERROR);
    };
    const employee = fakeGate({ persona: PERSONAS.viewer });
    const sanitized = await callGate(entry.policy, thrower, requestFor(entry).req, employee.deps);
    expect(sanitized.status).toBe(502);
    expect(sanitized.json).toEqual({ ok: false, error_code: ACCESS_ERROR.UPSTREAM_ERROR, error: "Request failed.", request_id: "req-security" });
    expect(scanForLeaks(sanitized.text)).toEqual([]);

    const owner = fakeGate({ persona: PERSONAS.owner });
    const raw = await callGate(entry.policy, thrower, requestFor(entry).req, owner.deps);
    expect(raw.status).toBe(502);
    expect(raw.json).toEqual({ ok: false, source: "clickhouse", error: SENTINEL_CLICKHOUSE_ERROR, request_id: "req-security" });
  });
});

// =========================================================================================
// #20 — The owner keeps unrestricted access after the migration
// =========================================================================================

describe("#20 bootstrap keeps the data owner unrestricted with raw access", () => {
  it("resolve_access / my_access after bootstrap: Owner, scope all, raw access, every enforced permission", async () => {
    const { h } = locked;
    const row = await svc(h, "public.resolve_access($1)", [DATA_KEY]);
    expect(row).toMatchObject({
      status: "ok", user_id: DATA_KEY, data_key: DATA_KEY, is_data_owner: true, raw_access: true,
      role: { key: "owner", is_owner: true }, funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    });
    const parsed = parseResolveAccessRow(row);
    expect(parsed).not.toBeNull();
    const ctx = buildAccessContext(parsed!, { kind: "user", userId: DATA_KEY }, "req-owner");
    expect(ctx).toMatchObject({ tenantKey: DATA_KEY, rawAccess: true, restricted: false, role: { isOwner: true } });
    expect([...ctx.permissions].sort()).toEqual([...ENFORCED_PERMISSION_KEYS].sort());
    const mine = await h.asUser(DATA_KEY, async (tx) => (await tx.query<{ v: Record<string, unknown> }>("select public.my_access() as v")).rows[0].v);
    expect(mine).toMatchObject({ status: "ok", raw_access: true, is_data_owner: true });
  });

  it("through the REAL resolver the owner reaches every user action of every gated policy, on its own key", async () => {
    const { deps, clickhouse } = pgliteGateDeps(locked.h);
    const probe = probeHandler();
    for (const entry of CASES) {
      const { req } = edgeRequest({ fn: entry.fn, method: entry.request.method, body: entry.request.body, query: entry.request.query, token: userToken(DATA_KEY) });
      const response = await handleWithAccess(req, entry.policy, probe.handler, deps);
      expect(response.status, `${entry.fn}.${entry.action}`).toBe(200);
    }
    expect(probe.spy).toHaveBeenCalledTimes(CASES.length);
    for (const seen of probe.seen) expect(seen.ctx).toMatchObject({ tenantKey: DATA_KEY, rawAccess: true, restricted: false, actor: { userId: DATA_KEY } });
    expect(clickhouse.boundTenants()).toEqual([DATA_KEY]);
    expect(GATED_POLICIES.length).toBe(ALL_POLICIES.length - 1);
  });

  it("the owner's SQL reaches the warehouse byte-identical (text, params, format, rows)", async () => {
    const ctx = contextFor(PERSONAS.owner);
    const raw = createRecordingClickHouse();
    const reader = createScopedReader(ctx, raw);
    const statements = [
      { query: INIT_TENANT_ROW_COUNT_SQL, query_params: { auth_user_id: DATA_KEY }, format: "JSONEachRow" },
      { query: INIT_TENANT_COHORT_ROW_COUNT_SQL, query_params: { auth_user_id: DATA_KEY, from: "2026-01-01" } },
      { query: "SELECT 1 AS ok", format: "JSONEachRow" },
    ];
    for (const statement of statements) await reader.query(statement);
    expect(raw.statements.map(({ query, params, format }) => ({ query, params, format }))).toEqual([
      { query: INIT_TENANT_ROW_COUNT_SQL, params: { auth_user_id: DATA_KEY }, format: "JSONEachRow" },
      { query: INIT_TENANT_COHORT_ROW_COUNT_SQL, params: { auth_user_id: DATA_KEY, from: "2026-01-01" }, format: undefined },
      { query: "SELECT 1 AS ok", params: {}, format: "JSONEachRow" },
    ]);
    // A placeholder without a caller-supplied value binds exactly what the
    // legacy owner path bound: the owner's own id.
    await reader.query({ query: INIT_TENANT_ROW_COUNT_SQL });
    expect(raw.statements[3].params).toEqual({ auth_user_id: DATA_KEY });
    const values = [{ auth_user_id: DATA_KEY, transaction_id: "t1", amount: 1 }];
    await reader.insert({ table: "analytics_transactions", values });
    expect(raw.statements[4].values).toEqual(values);
    expect(ctx.violations).toEqual([]);
  });

  it("the owner's success bodies are unchanged and error bodies only gain request_id", async () => {
    const entry = CASES.find((candidate) => candidate.fn === "clickhouse-cohorts" && candidate.action === "list")!;
    const body = { ok: true, cohorts: [{ cohort_key: FUNNELS.A.path, email: SENTINEL_EMAILS[0] }], diagnostics: { gross: 1 } };
    const { deps } = fakeGate({ persona: PERSONAS.owner });
    const success = await callGate(entry.policy, async () => body, requestFor(entry).req, deps);
    expect(success.status).toBe(200);
    expect(success.json).toEqual(body);

    const legacy = { ok: false, source: "clickhouse", error: "Unsupported filter: country" };
    const mapped = await callGate(entry.policy, async () => {
      throw new Error("bad filter");
    }, requestFor(entry).req, deps, { onError: () => ({ status: 400, body: legacy }) });
    expect(mapped.status).toBe(400);
    expect(mapped.json).toEqual({ ...legacy, request_id: "req-security" });
  });

  it("Phase 2: #20 T20 — every all-mode scopeSql helper renders exactly today's SQL for the owner (full corpus: ownerSqlGolden.test.ts; per helper: scopeSql.test.ts)", () => {
    expect(ALL_SCOPE_SQL.restricted).toBe(false);
    expect(txFrom(ALL_SCOPE_SQL, "a")).toBe("analytics_transactions AS a FINAL");
    expect(txFrom(ALL_SCOPE_SQL)).toBe("analytics_transactions FINAL");
    expect(cohortsFrom(ALL_SCOPE_SQL, "fc")).toBe("fact_user_cohorts AS fc FINAL");
    expect(cohortsFrom(ALL_SCOPE_SQL)).toBe("fact_user_cohorts FINAL");
    expect(txEmailMatchedFrom(ALL_SCOPE_SQL, "a")).toBe("analytics_transactions AS a FINAL");
    expect(fbFrom(ALL_SCOPE_SQL, "campaign")).toBe("fact_facebook_stats FINAL");
    expect(fbFrom(ALL_SCOPE_SQL, "account", "f", "fact_facebook_stats AS f FINAL")).toBe("fact_facebook_stats AS f FINAL");
    // The byte-for-byte owner corpus recorded from the unmodified base (4b4057e).
    expect(existsSync(resolve(process.cwd(), "src/test/fixtures/owner-sql-golden.json"))).toBe(true);
    expect(existsSync(resolve(process.cwd(), "src/test/ownerSqlGolden.test.ts"))).toBe(true);
  });
});
