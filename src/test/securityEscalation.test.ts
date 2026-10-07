// Security regression suite — horizontal (H1-H8) and vertical (V1-V8)
// escalation of plan §29, in their Milestone-A form.
//
// Horizontal: one member reaching another member's / another tenant's data by
// crafting filters, ids, tenant parameters, PostgREST reads, sync calls, saved
// objects or API keys. Vertical: a member reaching an action or a grant above its
// role (admin / ops actions, self-grant, over-grant, a cloned Admin role,
// registry re-pathing, the cron tenant, bootstrap / recover RPCs, writes under a
// restricted scope), plus canonical-action fuzzing (unknown / missing /
// flag-variant actions → 400 or the MORE privileged policy).
//
// Real code under test: the gate, every policy, the ScopedReader, the access
// admin handler (createAccessAdminHandler) over the REAL SQL mutation RPCs in
// PGlite, the reports-generate and Export API handlers, the service-role read
// helpers (against strictFakeSupabase), and the migrations' RLS. Access Phase 2
// (H1 / H2 / H4 for the cohorts, revenue and FB surfaces) also runs the REAL
// runners through router replicas against the fixture warehouse of
// accessFixtures §6; the users / payments / support parts stay it.todo.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AccessRequest, FunctionPolicy } from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ACCESS_ERROR_MESSAGES } from "../../supabase/functions/_shared/access/errors.ts";
import { authorizeAction, type ActionPolicy } from "../../supabase/functions/_shared/access/accessContext.ts";
import { ENFORCED_PERMISSION_KEYS, closeUnderRequires, isPrivilegedPermission } from "../../supabase/functions/_shared/access/permissions.ts";
import { ScopeViolation, createScopedReader } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import { OUT_OF_SCOPE_SENTINEL } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { ACCESS_POLICY } from "../../supabase/functions/_shared/access/policies/access.ts";
import { REPORTS_GENERATE_POLICY } from "../../supabase/functions/_shared/access/policies/reports-generate.ts";
import { fbStatusDetailVisible, projectFbSyncStateForViewer } from "../../supabase/functions/_shared/access/policies/clickhouse-facebook.ts";
import { projectSnapshotStateForViewer, snapshotStateDetailVisible } from "../../supabase/functions/_shared/access/policies/clickhouse-cohort-membership.ts";
import { projectSupportStatusForViewer, supportStatusDetailVisible } from "../../supabase/functions/_shared/access/policies/clickhouse-support.ts";
import {
  CLICKHOUSE_HEALTH_FAILED_MESSAGE,
  healthDetailVisible,
  projectHealthForViewer,
} from "../../supabase/functions/_shared/access/policies/clickhouse-health.ts";
import { capsuledRawPayloadsVisible, stripCapsuledSyncRawPayloads } from "../../supabase/functions/_shared/access/policies/capsuled-facebook-sync.ts";
import { summaryKpisVisible } from "../../supabase/functions/_shared/access/policies/clickhouse-summary.ts";
import {
  canServeFbAllocationDiagnostics,
  cohortIdentitiesVisible,
  restrictCohortRequest,
} from "../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import { paymentPassFullBundleAllowed } from "../../supabase/functions/_shared/access/policies/clickhouse-payment-analytics.ts";
import { accessAdminOnError, createAccessAdminHandler } from "../../supabase/functions/_shared/access/adminApi.ts";
import { createReportsGenerateHandler, REPORT_NOT_FOUND } from "../../supabase/functions/reports-generate/handler.ts";
import { handleExportCampaignPerformance } from "../../supabase/functions/export-campaign-performance/handler.ts";
import {
  getFbBatchDq,
  listFbImportBatches,
  listFbRawPayloads,
  listFbSyncRuns,
  listFbWarehouseVersions,
} from "../../supabase/functions/_shared/clickhouse/fbSyncHistory.ts";
import { getFbSyncState } from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import { getCohortSnapshotState } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { getCohortSnapshotStateRow, getSupportSyncState, getTransactionSyncState } from "../../supabase/functions/_shared/clickhouse/summary.ts";
import { activeSubscriptionsByEmail } from "../../supabase/functions/_shared/clickhouse/cohortSubscriptions.ts";
import {
  ALL_POLICIES,
  CRON_ONLY_ACTIONS,
  CRON_SECRETS,
  DATA_KEY,
  FOREIGN_TENANT,
  FUNNELS,
  GATED_POLICIES,
  PERSONAS,
  SCOPE_CUSTOMERS,
  SCOPE_DAYS,
  SCOPE_READY_REQUESTS,
  TAMPERED_TENANT_FIELDS,
  TEMPLATE_PERMISSIONS,
  TENANT_COUNT_SENTINEL,
  TENANT_ROW_TABLES,
  UPDATE_MEMBER_SQL,
  USER_IDS,
  accessRow,
  apiKeyFixture,
  boundList,
  callGate,
  contextFor,
  createLockedWorkspace,
  createPgliteAccessAdminStore,
  edgeRequest,
  fakeGate,
  gatedActionCases,
  minimalGrant,
  needsPrivileged,
  normalizedAction,
  pgliteGateDeps,
  policyFor,
  probeHandler,
  readResult,
  readThroughRouter,
  scopedUserPathsOf,
  svc,
  userToken,
  visibleCampaignPathsOf,
  withGrant,
  type ActionCase,
  type Persona,
  type RouterRead,
  type SeededWorkspace,
} from "./support/accessFixtures";
import { TENANT_PROBE_SQL, createRecordingClickHouse } from "./support/recordingClickHouse";
import { createStrictFakeSupabase, StrictSupabaseViolation } from "./support/strictFakeSupabase";
import { SENTINEL_CLICKHOUSE_ERROR, SENTINEL_EMAILS, SENTINEL_SPEND, scanForLeaks } from "./support/leakScan";
import type { SupabasePglite } from "./support/pgliteSupabase";

const readSource = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const CASES = gatedActionCases();
const CASE_ROWS = CASES.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const);

function requestFor(entry: ActionCase, body?: Record<string, unknown>, token?: string) {
  return edgeRequest({ fn: entry.fn, method: entry.request.method, query: entry.request.query, body: body ?? entry.request.body, token });
}

/** Every template-role persona with funnel scope all (non-admin roles). */
const NON_ADMIN_TEMPLATES: Persona[] = [
  withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.viewer, { name: "viewer" }),
  withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.analyst, { name: "analyst" }),
  withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.headOfMarketing, { name: "head-of-marketing" }),
  withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.productManager, { name: "product-manager" }),
  withGrant(PERSONAS.viewer, TEMPLATE_PERMISSIONS.mediaBuyer, { name: "media-buyer@all" }),
  withGrant(PERSONAS.viewer, ENFORCED_PERMISSION_KEYS.filter((key) => !isPrivilegedPermission(key)), { name: "every-non-admin-key" }),
];

const ADMIN_ALL = withGrant(PERSONAS.admin, ENFORCED_PERMISSION_KEYS, { name: "admin-all" });

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
// Horizontal
// =========================================================================================

describe("H1 / H2 — crafted filters and options never reach a restricted member's data (403, or a scope the body cannot widen)", () => {
  const FILTER_READS = CASES.filter((entry) =>
    [
      "clickhouse-cohorts.list", "clickhouse-cohorts.options", "clickhouse-users.list", "clickhouse-users.options",
      "clickhouse-support.bundle", "clickhouse-support.options", "clickhouse-facebook.report", "clickhouse-facebook.filters",
      "clickhouse-payment-analytics.bundle", "clickhouse-payment-analytics.banks", "clickhouse-revenue.bundle", "clickhouse-revenue.day_breakdown",
    ].includes(`${entry.fn}.${entry.action}`),
  );
  const CRAFTED: Array<Record<string, unknown>> = [
    { filters: { campaign_path: [FUNNELS.B.path] } },
    { filters: { campaign_path: [] } },
    { filters: { funnel: [FUNNELS.B.path], exclude_campaign_path: [FUNNELS.A.path] } },
    { filters: { campaign_path: [FUNNELS.A.path, FUNNELS.B.path, "unknown", ""] } },
    { filters: JSON.parse('{"__proto__": {"campaign_path": ["past-life"]}, "constructor": {"prototype": {"scope": "all"}}}') },
    { scope: "all", funnel_scope: { mode: "all" }, restricted: false },
  ];

  const READY_FILTER_READS = FILTER_READS.filter((entry) => entry.rule.scopeReady === true);
  const REFUSED_FILTER_READS = FILTER_READS.filter((entry) => entry.rule.scopeReady !== true);

  it("has the filter-taking reads (sanity)", () => {
    expect(FILTER_READS).toHaveLength(12);
    // Phase 2: cohorts list/options, FB report/filters and RI bundle/day are scopeReady.
    expect(READY_FILTER_READS).toHaveLength(6);
  });

  it.each(READY_FILTER_READS.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const))("%s (scopeReady): every crafted body reaches the handler bound to paths(A) only", async (_label, entry) => {
    const persona = withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS, { name: "buyer-{A}" });
    for (const crafted of CRAFTED) {
      const body = { ...entry.request.body, ...crafted };
      expect(normalizedAction(entry.policy, { ...entry.request, body })).toBe(entry.action);
      const { deps, clickhouse } = fakeGate({ persona });
      const seen: Array<{ restricted: boolean; scopeRestricted: boolean; scopePaths: readonly string[] | null; ctxPaths: readonly string[] | null }> = [];
      const handler = async (request: AccessRequest<string>) => {
        const funnel = request.ctx.scope.funnel;
        seen.push({
          restricted: request.ctx.restricted,
          scopeRestricted: request.scope.restricted,
          scopePaths: request.scope.paths,
          ctxPaths: funnel.mode === "selected" ? funnel.paths : null,
        });
        return { ok: true };
      };
      const result = await callGate(entry.policy, handler as never, requestFor(entry, body).req, deps);
      expect(result.status, JSON.stringify(crafted)).toBe(200);
      expect(seen).toEqual([{ restricted: true, scopeRestricted: true, scopePaths: [FUNNELS.A.path], ctxPaths: [FUNNELS.A.path] }]);
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it.each(REFUSED_FILTER_READS.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const))("%s: every crafted body is refused for buyer-{A}", async (_label, entry) => {
    const persona = withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS, { name: "buyer-{A}" });
    for (const crafted of CRAFTED) {
      const body = { ...entry.request.body, ...crafted };
      expect(normalizedAction(entry.policy, { ...entry.request, body })).toBe(entry.action);
      const { deps, clickhouse } = fakeGate({ persona });
      const result = await callGate(entry.policy, probeHandler().handler, requestFor(entry, body).req, deps);
      expect(result.status).toBe(403);
      expect(result.json?.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
      expect(clickhouse.statements).toEqual([]);
    }
  });

  // Semantic part: through the router replicas, the REAL runners and the fixture
  // warehouse of accessFixtures §6 (answers each statement by the scope it carries).
  const A = FUNNELS.A.path;
  const B = FUNNELS.B.path;
  const C = FUNNELS.C.path;
  const [DAY_1, DAY_2] = SCOPE_DAYS;
  const pathsOfRows = (result: RouterRead, key: "rows" | "by_funnel") =>
    [...new Set(((result.json?.[key] ?? []) as Array<Record<string, unknown>>).map((row) => String(row.campaign_path ?? row.key)))].sort();
  const droppedOf = (result: RouterRead) => (result.json?.meta as { access: { dropped_filter_values: number } }).access.dropped_filter_values;

  it.each([
    ["clickhouse-cohorts", "list", "rows"],
    ["clickhouse-revenue", "bundle", "by_funnel"],
  ] as const)("Phase 2: H1 — %s.%s: include lists are intersected with paths(A) (B dropped and counted), an all-out list matches nothing, exclude lists apply as sent", async (fn, action, rowsKey) => {
    const cases: Array<{ filters: Record<string, string[]>; paths: string[]; dropped: number; include?: string[]; exclude?: string[] }> = [
      { filters: { campaign_path: [A, B] }, paths: [A], dropped: 1, include: [A] },
      { filters: { campaign_path: [B] }, paths: [], dropped: 1, include: [OUT_OF_SCOPE_SENTINEL] },
      { filters: { campaign_path: [B, C, "unknown"] }, paths: [], dropped: 3, include: [OUT_OF_SCOPE_SENTINEL] },
      ...(fn === "clickhouse-cohorts"
        ? [
          { filters: { campaign_path_exclude: [A] }, paths: [], dropped: 0, exclude: [A] },
          { filters: { campaign_path_exclude: [B] }, paths: [A], dropped: 0, exclude: [B] },
          { filters: { campaign_path: [A], campaign_path_exclude: [A] }, paths: [], dropped: 0, include: [A], exclude: [A] },
        ]
        // Revenue Intelligence has no exclude list (spec §4): the key is ignored, never a widening.
        : [{ filters: { campaign_path: [A], campaign_path_exclude: [A] }, paths: [A], dropped: 0, include: [A] }]),
    ];
    for (const entry of cases) {
      const label = JSON.stringify(entry.filters);
      const result = await readThroughRouter(PERSONAS.buyerA, fn, { action, date_from: DAY_1, date_to: DAY_2, filters: entry.filters });
      expect(result.status, `${label}: ${result.text.slice(0, 200)}`).toBe(200);
      expect(pathsOfRows(result, rowsKey), label).toEqual(entry.paths);
      expect(droppedOf(result), label).toBe(entry.dropped);
      // What reached the warehouse: the scope fragments admit A only, the include
      // list is A or the sentinel, the exclude list is exactly what was sent.
      for (const statement of result.clickhouse.statements) {
        const users = scopedUserPathsOf(statement.query);
        if (users) expect([...users], label).toEqual([A]);
        const include = boundList(statement.params, "mcp");
        if (include) expect(include, label).toEqual(entry.include);
        const exclude = boundList(statement.params, "mcpx");
        if (exclude) expect(exclude, label).toEqual(entry.exclude);
      }
      expect(result.clickhouse.statements.some((statement) => boundList(statement.params, entry.include ? "mcp" : "mcpx")), label).toBe(true);
      expect(scanForLeaks(result.text, { funnelB: true }), label).toEqual([]);
    }
  });

  it("Phase 2: H1 — FB filters (campaign / buyer / account) are ANDed with the visible campaigns: naming B's or the shared campaign returns nothing", async () => {
    for (const [filters, campaigns] of [
      [{ campaign_id: ["fb_a", "fb_b", "fb_mixed"] }, ["fb_a"]],
      [{ campaign_id: ["fb_b"] }, []],
      [{ campaign_id: ["fb_mixed"] }, []],
      [{ buyer: ["Bob", "Mallory"] }, []],
      [{ buyer: ["Alice"] }, ["fb_a"]],
      [{ ad_account_id: ["act_shared"] }, ["fb_a"]],
    ] as const) {
      const result = await readThroughRouter(PERSONAS.buyerA, "clickhouse-facebook", { action: "report", level: "campaign", filters });
      expect(result.status, result.text.slice(0, 200)).toBe(200);
      expect((result.json?.rows as Array<{ campaign_id: string }>).map((row) => row.campaign_id), JSON.stringify(filters)).toEqual(campaigns);
      for (const statement of result.clickhouse.statements) {
        const visible = visibleCampaignPathsOf(statement.query);
        if (visible) expect([...visible]).toEqual([A]);
      }
      expect(scanForLeaks(result.text, { funnelB: true }), JSON.stringify(filters)).toEqual([]);
    }
  });

  it("Phase 2: H2 — cohorts and FB options come from the scoped base: B, 'unknown' and hidden campaigns never appear for buyer-{A}, whatever dimension is selected", async () => {
    const own = new Set([A, "soulmate", "fb_a", "fb_mixed", "fb_thin"]);
    const foreign = new Set(SCOPE_CUSTOMERS.flatMap((entry) => [entry.path, entry.funnel, entry.campaignId]).filter((value) => !own.has(value)));
    const COHORT_SELECTIONS: Array<Record<string, string[]>> = [
      {}, { campaign_path: [A] }, { campaign_path: [B] }, { funnel: ["soulmate"] }, { funnel: ["past_life"] },
      { campaign_id: ["fb_b"] }, { media_buyer: ["utm:facebook"] }, { country: ["US"] },
    ];
    for (const filters of COHORT_SELECTIONS) {
      for (const action of ["options", "list"] as const) {
        const result = await readThroughRouter(PERSONAS.buyerA, "clickhouse-cohorts", { action, date_from: DAY_1, date_to: DAY_2, filters });
        expect(result.status, `${action} ${JSON.stringify(filters)}`).toBe(200);
        const values = JSON.stringify(result.json?.filter_options);
        for (const value of foreign) expect(values, `${action} ${JSON.stringify(filters)}: ${value}`).not.toContain(`"${value}"`);
        expect(values.toLowerCase()).not.toContain('"unknown"');
        const options = result.clickhouse.statements.find((statement) => statement.query.includes("'price_plan' dim"))!;
        expect([...(scopedUserPathsOf(options.query) ?? [])]).toEqual([A]);
      }
    }
    for (const filters of [{}, { buyer: ["Bob"] }, { campaign_id: ["fb_b"] }, { ad_account_id: ["act_shared"] }, { buyer: ["Alice"], campaign_id: ["fb_mixed"] }]) {
      const result = await readThroughRouter(PERSONAS.buyerA, "clickhouse-facebook", { action: "filters", filters });
      expect(result.status).toBe(200);
      const options = result.json?.filter_options as { buyers: Array<{ value: string }>; campaigns: Array<{ value: string }> };
      expect(options.campaigns.every((option) => option.value === "fb_a"), JSON.stringify(filters)).toBe(true);
      expect(options.buyers.every((option) => option.value === "Alice"), JSON.stringify(filters)).toBe(true);
      expect(scanForLeaks(result.text, { funnelB: true, extra: ['"fb_mixed"', '"fb_thin"', "Mallory"] }), JSON.stringify(filters)).toEqual([]);
    }
  });

  it.todo("Phase 4/5: H2 — the users, payments, banks and support options producers compute options over scopedBase ∩ userFilters (their actions are not scopeReady yet: 403 above)");
});

describe("H3 — ids of another member's or another funnel's objects", () => {
  const REPORT_EDITOR = ["reports.view", "reports.edit", "ai.use"];
  const OWNER_REPORT = "0dd0dd0d-0000-4000-8000-0000000000aa";
  const OTHER_MEMBER_REPORT = "0dd0dd0d-0000-4000-8000-0000000000cc";
  const MISSING_REPORT = "0dd0dd0d-0000-4000-8000-0000000000ff";

  it("reports-generate answers the SAME 404 for a foreign report and for a report that does not exist (no existence oracle)", async () => {
    const bodies: string[] = [];
    for (const reportId of [OWNER_REPORT, OTHER_MEMBER_REPORT, MISSING_REPORT, "not-a-uuid"]) {
      const pg = createStrictFakeSupabase({
        tenantKey: DATA_KEY,
        actorKey: USER_IDS.viewer,
        tables: {
          reports: {
            scope: "actor",
            owner: "auth_user_id",
            rows: [{ id: OWNER_REPORT, auth_user_id: DATA_KEY }, { id: OTHER_MEMBER_REPORT, auth_user_id: USER_IDS.buyerAB }],
          },
          report_ai_runs: { scope: "actor", owner: "auth_user_id" },
        },
      });
      const model = vi.fn();
      const { deps } = fakeGate({ persona: withGrant(PERSONAS.viewer, REPORT_EDITOR), pg });
      const handler = createReportsGenerateHandler({ apiKey: () => "sk-test", createModelCaller: model });
      const result = await callGate(REPORTS_GENERATE_POLICY, handler, edgeRequest({ body: { action: "regenerate_block", report_id: reportId, block_id: "b1" } }).req, deps);
      expect(result.status, reportId).toBe(404);
      expect(result.json).toEqual({ ok: false, error_code: REPORT_NOT_FOUND, error: "Report not found." });
      expect(model).not.toHaveBeenCalled();
      expect(pg.violations).toEqual([]);
      bodies.push(result.text);
    }
    expect(new Set(bodies).size).toBe(1);
  });

  it.each([
    ["clickhouse-users", { action: "details", user_id: SENTINEL_EMAILS[0] }],
    ["clickhouse-support", { action: "details", request_id: "req-of-funnel-b" }],
  ] as const)("%s drilldown by id is refused for a restricted member before any lookup (Milestone A)", async (fn, body) => {
    const { deps, clickhouse } = fakeGate({ persona: withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS) });
    const result = await callGate(policyFor(fn), probeHandler().handler, edgeRequest({ body }).req, deps);
    expect(result.status).toBe(403);
    expect(result.json?.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(clickhouse.statements).toEqual([]);
  });

  it.each([
    ["cohort_key of B", { cohort_key: { cohort_date: "2026-09-01", funnel: FUNNELS.B.path, campaign_path: FUNNELS.B.path } }],
    ["funnel_key of B", { funnel_key: { campaign_path: FUNNELS.B.path } }],
    ["A cohort_key with a funnel_key of B", { cohort_key: { cohort_date: "2026-09-01", funnel: FUNNELS.A.path, campaign_path: FUNNELS.A.path }, funnel_key: { campaign_path: FUNNELS.B.path } }],
    ["a string cohort_key", { cohort_key: `${FUNNELS.B.path}|2026-09-01` }],
    ["an 'unknown' key", { funnel_key: { campaign_path: "unknown" } }],
  ] as const)("clickhouse-cohorts details (scopeReady) with %s is 403 funnel_out_of_scope before any SQL (R11)", async (_label, keys) => {
    const { deps, clickhouse } = fakeGate({ persona: withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS) });
    const probe = probeHandler();
    // The router's first step for a restricted member (FN/clickhouse-cohorts/index.ts).
    const handler = async (request: AccessRequest<string>) => {
      restrictCohortRequest(request.scope, request.body);
      return (probe.handler as unknown as (input: AccessRequest<string>) => Promise<unknown>)(request);
    };
    const result = await callGate(policyFor("clickhouse-cohorts"), handler as never, edgeRequest({ body: { action: "details", ...keys } }).req, deps);
    expect(result.status).toBe(403);
    expect(result.json).toMatchObject({ ok: false, error_code: ACCESS_ERROR.FUNNEL_OUT_OF_SCOPE, error: ACCESS_ERROR_MESSAGES.funnel_out_of_scope });
    expect(probe.spy).not.toHaveBeenCalled();
    expect(clickhouse.statements).toEqual([]);
  });

  it.todo("Phase 4/5: H3 — a buyer-{A} users.details for a customer anchored to B and support.details for a request of B answer 404 with a body byte-identical to the 404 of an id that does not exist (cohorts keys are 403 funnel_out_of_scope by R11, above; users / support are not scopeReady yet)");
});

describe("H4 — side channels in the member views", () => {
  const viewer = contextFor(PERSONAS.viewer);
  const owner = contextFor(PERSONAS.owner);

  it("the visibility predicates give detail to the data owner and diagnostics roles only", () => {
    const predicates = [
      fbStatusDetailVisible, snapshotStateDetailVisible, supportStatusDetailVisible, healthDetailVisible,
      capsuledRawPayloadsVisible, summaryKpisVisible, canServeFbAllocationDiagnostics, cohortIdentitiesVisible,
    ];
    for (const predicate of predicates) {
      expect(predicate(owner), predicate.name).toBe(true);
      expect(predicate(viewer), predicate.name).toBe(false);
      expect(predicate(contextFor(withGrant(PERSONAS.viewer, NON_ADMIN_TEMPLATES[5].role.permissions))), predicate.name).toBe(false);
    }
    expect(paymentPassFullBundleAllowed(contextFor(withGrant(PERSONAS.viewer, ["ai.use", "cohorts.view"])))).toBe(false);
  });

  it("FB sync state: tenant spend totals, raw errors and the data key never reach a viewer", () => {
    const state = {
      sync_name: "facebook_stats", status: "completed", auth_user_id: DATA_KEY, last_error: SENTINEL_CLICKHOUSE_ERROR, private_note: SENTINEL_EMAILS[0],
      diagnostics: { mode: "full", spend_by_level: { campaign: SENTINEL_SPEND }, day_spend_total: SENTINEL_SPEND, spend_mismatch: { campaign: SENTINEL_SPEND }, validation_status: "PASSED" },
    };
    const projected = projectFbSyncStateForViewer(state);
    expect(projected).toMatchObject({ sync_name: "facebook_stats", status: "completed", diagnostics: { mode: "full", validation_status: "PASSED" } });
    expect(scanForLeaks(projected, { extra: [DATA_KEY] })).toEqual([]);
    expect(scanForLeaks(state, { extra: [DATA_KEY] }).length).toBeGreaterThan(0);
  });

  it("cohort snapshot state: totals, build token, warehouse text and the data key are dropped", () => {
    const state = {
      snapshot_name: "fact_user_cohorts", status: "active", active_warehouse_version: "w1", auth_user_id: DATA_KEY,
      users_classified: SENTINEL_SPEND, rows_inserted: SENTINEL_SPEND, source_transactions: SENTINEL_SPEND, build_token: "cas-token",
      last_error: SENTINEL_CLICKHOUSE_ERROR, diagnostics: { fingerprint: SENTINEL_SPEND },
    };
    const projected = projectSnapshotStateForViewer(state);
    expect(projected).toEqual({ snapshot_name: "fact_user_cohorts", status: "active", active_warehouse_version: "w1" });
    expect(scanForLeaks(projected, { extra: [DATA_KEY, "cas-token"] })).toEqual([]);
  });

  it("support status: raw failure text and failed batches are dropped", () => {
    const status = {
      ok: true, source: "clickhouse", action: "status", status: "failed", error: SENTINEL_CLICKHOUSE_ERROR, auth_user_id: DATA_KEY,
      diagnostics: { error: SENTINEL_CLICKHOUSE_ERROR, failed_batches: [SENTINEL_EMAILS[0]], attribution: { matched: 1 } },
    };
    const projected = projectSupportStatusForViewer(status) as Record<string, unknown>;
    expect(projected.diagnostics).toEqual({ attribution: { matched: 1 } });
    expect(scanForLeaks(projected, { extra: [DATA_KEY] })).toEqual([]);
  });

  it("health probe: the database name and ClickHouse error text are replaced", () => {
    const projected = projectHealthForViewer({ connected: false, configured: true, database: "sentinel_database", latency_ms: 4, error: SENTINEL_CLICKHOUSE_ERROR });
    expect(projected).toEqual({ connected: false, configured: true, latency_ms: 4, error: CLICKHOUSE_HEALTH_FAILED_MESSAGE });
    expect(scanForLeaks(projected, { extra: ["sentinel_database"] })).toEqual([]);
  });

  it("Capsuled sync echo: raw upstream payloads are stripped for non-owners", () => {
    const result = {
      rows: [{ campaign_id: "c1", spend: 1, raw_payload: { email: SENTINEL_EMAILS[0] } }],
      metadata: { lastApiResponse: JSON.stringify({ email: SENTINEL_EMAILS[1] }) },
      diagnostics: { lastApiResponse: SENTINEL_EMAILS[0] },
    };
    expect(scanForLeaks(stripCapsuledSyncRawPayloads(result))).toEqual([]);
  });

  // Phase 2: the fixture warehouse answers every UNSCOPED statement (and the stored
  // sync / snapshot states) with tenant-wide sentinels — TENANT_COUNT_SENTINEL,
  // the spend sentinel, raw error text, sentinel e-mails — so a restricted body
  // that echoed a tenant-wide value would carry one.
  const A_EMAILS = SCOPE_CUSTOMERS.filter((entry) => entry.path === FUNNELS.A.path).map((entry) => entry.email);

  it.each(Object.entries(SCOPE_READY_REQUESTS))("Phase 2: H4 — %s for buyer-{A}: no tenant-wide counter, spend, error text, raw e-mail, data key or funnel B in the body", async (key, body) => {
    const fn = key.slice(0, key.lastIndexOf("."));
    const result = await readThroughRouter(PERSONAS.buyerA, fn, body);
    expect(result.status, result.text.slice(0, 300)).toBe(200);
    expect(scanForLeaks(result.text, { funnelB: true, extra: [DATA_KEY, ...A_EMAILS, String(TENANT_COUNT_SENTINEL)] })).toEqual([]);
    expect(result.pg.violations).toEqual([]);
    // The stored state is read once, by the gate; no runner re-reads it for a restricted member.
    expect(result.pg.callsTo("clickhouse_cohort_snapshot_state")).toEqual(fn === "clickhouse-summary" ? [expect.anything()] : []);
  });

  it("Phase 2: H4 — cohorts: diagnostics redacted (counts_redacted), FX recomputed over the member's users, no allocation page; Revenue: no unattributed / spend stream", async () => {
    const list = await readThroughRouter(PERSONAS.buyerA, "clickhouse-cohorts", SCOPE_READY_REQUESTS["clickhouse-cohorts.list"]);
    expect(list.status).toBe(200);
    expect(list.json?.diagnostics).toMatchObject({
      counts_redacted: true, transactions_scanned: 0, users_scanned: 0, source_transactions: null, cohort_users: null,
      current_warehouse_version: null, current_warehouse_transactions: null, support_requests: null, support_unique_emails: null,
    });
    const nonSyntheticA = SCOPE_CUSTOMERS.filter((entry) => entry.path === FUNNELS.A.path && !entry.id.startsWith("unknown_user_"));
    expect((list.json?.fx_diagnostics as { transactions_total: number }).transactions_total).toBe(nonSyntheticA.length);
    expect(list.json).not.toHaveProperty("fb_allocation_diagnostics");
    // ...and the page that would carry it stays refused at the gate.
    const page = await readThroughRouter(PERSONAS.buyerA, "clickhouse-cohorts", { action: "list", fb_allocation_diagnostics: { enabled: true } });
    expect(page.status).toBe(403);
    expect(page.json?.error_code).toBe(ACCESS_ERROR.SCOPE_NOT_SUPPORTED);
    expect(page.clickhouse.statements).toEqual([]);

    for (const body of [SCOPE_READY_REQUESTS["clickhouse-revenue.bundle"], SCOPE_READY_REQUESTS["clickhouse-revenue.day_breakdown"]]) {
      const revenue = await readThroughRouter(PERSONAS.buyerA, "clickhouse-revenue", body);
      expect(revenue.status).toBe(200);
      expect(revenue.clickhouse.statements.length).toBeGreaterThan(0);
      for (const statement of revenue.clickhouse.statements) expect(statement.query).not.toMatch(/snapshot_users AS|fact_facebook_stats/);
    }
  });

  it("Phase 2: H4 — positive control: the owner's views of the same fixture DO carry the tenant sentinels (the scans above are not vacuous)", async () => {
    const owner = await readThroughRouter(PERSONAS.owner, "clickhouse-cohorts", { action: "list", date_from: SCOPE_DAYS[0], date_to: SCOPE_DAYS[1] });
    expect(owner.status).toBe(200);
    expect(scanForLeaks(owner.text, { funnelB: true, extra: [String(TENANT_COUNT_SENTINEL)] }).length).toBeGreaterThan(0);
    const fb = await readThroughRouter(PERSONAS.owner, "clickhouse-facebook", { action: "status", level: "campaign" });
    expect(fb.status).toBe(200);
    expect(scanForLeaks(fb.text, { extra: [String(TENANT_COUNT_SENTINEL)] }).length).toBeGreaterThan(0);
  });

  it.todo("Phase 4/5: H4 — support funnel denominators (SH/support.ts) and the spend-ledger residual buckets (SH/projectSpendLedger.ts) are dropped for buyer-{A}; those actions are not scopeReady yet (403)");
});

describe("H5 — PostgREST and service-role reads never cross the data key", () => {
  it("RLS: employees and restricted members read zero tenant rows, even the private copies under their own id", async () => {
    const { h } = locked;
    for (const table of TENANT_ROW_TABLES) {
      for (const user of [USER_IDS.admin, USER_IDS.viewer, USER_IDS.buyerA, USER_IDS.buyerAB, USER_IDS.emptyGrant, USER_IDS.noRule]) {
        const n = await h.asUser(user, async (tx) => (await tx.query<{ n: number }>(`select count(*)::int as n from public.${table}`)).rows[0].n);
        expect(n, `${user} ${table}`).toBe(0);
      }
    }
    const owner = await h.asUser(DATA_KEY, async (tx) => (await tx.query<{ n: number }>("select count(*)::int as n from public.transactions")).rows[0].n);
    expect(owner).toBe(1);
  });

  it("RLS: no member can write tenant rows under the data key or under its own id", async () => {
    const h = await cloneLocked();
    const insert = "insert into public.transactions (auth_user_id, transaction_id, event_time) values ($1, $2, now())";
    for (const user of [USER_IDS.viewer, USER_IDS.buyerA, USER_IDS.admin]) {
      for (const target of [DATA_KEY, user]) {
        await expect(h.asUser(user, (tx) => tx.query(insert, [target, `forged-${user}-${target}`])), `${user} → ${target}`).rejects.toThrow(/row-level security/);
      }
      const forged = await h.asUser(user, (tx) => tx.query("update public.transactions set status = 'forged'"));
      expect(forged.affectedRows).toBe(0);
    }
  });

  it("service-role helpers filter on the data key whatever the request body names", async () => {
    const tenantRows = (extra: Record<string, unknown>) => [{ auth_user_id: DATA_KEY, ...extra }, { auth_user_id: FOREIGN_TENANT, ...extra, leak: SENTINEL_EMAILS[0] }];
    const BATCH = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
    const PAYLOAD = "cccccccc-1111-4111-8111-cccccccccccc";
    const pg = createStrictFakeSupabase({
      tenantKey: DATA_KEY,
      tables: {
        facebook_sync_runs: { scope: "tenant", owner: "auth_user_id", rows: tenantRows({ status: "completed", started_at: "2026-09-01" }) },
        facebook_import_batches: { scope: "tenant", owner: "auth_user_id", rows: tenantRows({ run_id: BATCH, status: "published", created_at: "2026-09-01" }) },
        facebook_raw_payloads: { scope: "tenant", owner: "auth_user_id", rows: tenantRows({ payload_id: PAYLOAD, batch_id: BATCH }) },
        facebook_batch_dq: { scope: "tenant", owner: "auth_user_id", rows: tenantRows({ batch_id: BATCH, computed_at: "2026-09-01" }) },
        clickhouse_transaction_sync_state: {
          scope: "tenant",
          owner: "auth_user_id",
          rows: [
            ...tenantRows({ sync_name: "analytics_transactions_backfill" }),
            ...tenantRows({ sync_name: "fact_support_requests_sync" }),
            ...tenantRows({ sync_name: "facebook_stats" }),
          ],
        },
        clickhouse_cohort_snapshot_state: { scope: "tenant", owner: "auth_user_id", rows: tenantRows({ snapshot_name: "fact_user_cohorts" }) },
      },
      rpc: { active_funnelfox_subscription_emails: { tenantParam: "p_data_key", handler: () => ({ data: { [SENTINEL_EMAILS[1]]: ["sub-1"] }, error: null }) } },
    });
    const tampered = { ...TAMPERED_TENANT_FIELDS, run_id: BATCH, batch_id: BATCH, payload_id: PAYLOAD, limit: 5 };
    const results = [
      await listFbSyncRuns(pg as never, DATA_KEY, tampered),
      await listFbImportBatches(pg as never, DATA_KEY, tampered),
      await listFbWarehouseVersions(pg as never, DATA_KEY, tampered),
      await listFbRawPayloads(pg as never, DATA_KEY, tampered),
      await listFbRawPayloads(pg as never, DATA_KEY, { ...tampered, payload_id: undefined }),
      await getFbBatchDq(pg as never, DATA_KEY, tampered),
      await getFbSyncState(pg as never, DATA_KEY),
      await getCohortSnapshotState(pg as never, DATA_KEY),
      await getTransactionSyncState(pg as never, DATA_KEY),
      await getCohortSnapshotStateRow(pg as never, DATA_KEY),
      await getSupportSyncState(pg as never, DATA_KEY),
    ];
    expect(pg.violations).toEqual([]);
    expect(pg.calls.length).toBeGreaterThanOrEqual(11);
    expect(scanForLeaks(results, { extra: [FOREIGN_TENANT] })).toEqual([]);
    expect(await activeSubscriptionsByEmail(pg as never, DATA_KEY)).toEqual(new Map([[SENTINEL_EMAILS[1], ["sub-1"]]]));

    // The strict client is not vacuous: the same helpers keyed by the foreign tenant are rejected.
    await expect(listFbSyncRuns(pg as never, FOREIGN_TENANT, {})).rejects.toBeInstanceOf(StrictSupabaseViolation);
    await expect(activeSubscriptionsByEmail(pg as never, FOREIGN_TENANT)).rejects.toBeInstanceOf(StrictSupabaseViolation);
  });

  it("Phase 2: H5 — registry RLS: buyer-{A} selects only funnel A from funnels / funnel_tags / funnel_paths (granted paths only), and tags only through visible funnels", async () => {
    const h = await cloneLocked();
    const TAGS = { a: "7a7a7a7a-0000-4000-8000-00000000000a", b: "7a7a7a7a-0000-4000-8000-00000000000b", orphan: "7a7a7a7a-0000-4000-8000-00000000000c" };
    // Planted as postgres (the registry rows an all-scope manager would have made).
    await h.db.query("insert into public.tags (id, name) values ($1, 'Tag A'), ($2, 'Tag B'), ($3, 'Tag orphan')", [TAGS.a, TAGS.b, TAGS.orphan]);
    await h.db.query("insert into public.funnel_tags (funnel_id, tag_id) values ($1, $2), ($3, $4)", [FUNNELS.A.id, TAGS.a, FUNNELS.B.id, TAGS.b]);
    await h.db.query("insert into public.funnel_paths (funnel_id, path_canonical, status, source) values ($1, 'soulmate-proposal', 'proposed', 'admin_alias')", [FUNNELS.A.id]);

    const read = (user: string) =>
      h.asUser(user, async (tx) => ({
        funnels: (await tx.query<{ id: string }>("select id::text from public.funnels")).rows.map((row) => row.id).sort(),
        funnelTags: (await tx.query<{ funnel_id: string }>("select funnel_id::text from public.funnel_tags")).rows.map((row) => row.funnel_id).sort(),
        tags: (await tx.query<{ name: string }>("select name from public.tags")).rows.map((row) => row.name).sort(),
        paths: (await tx.query<{ path: string; status: string }>("select path_canonical as path, status from public.funnel_paths")).rows
          .map((row) => `${row.path}:${row.status}`).sort(),
      }));

    expect(await read(USER_IDS.buyerA)).toEqual({
      funnels: [FUNNELS.A.id],
      funnelTags: [FUNNELS.A.id],
      tags: ["Tag A"],
      paths: [`${FUNNELS.A.path}:active`],
    });
    expect(await read(USER_IDS.buyerAB)).toEqual({
      funnels: [FUNNELS.A.id, FUNNELS.B.id],
      funnelTags: [FUNNELS.A.id, FUNNELS.B.id],
      tags: ["Tag A", "Tag B"],
      paths: [`${FUNNELS.B.path}:active`, `${FUNNELS.A.path}:active`].sort(),
    });
    // Scope all reads the whole registry, proposals included.
    expect(await read(USER_IDS.viewer)).toEqual({
      funnels: [FUNNELS.A.id, FUNNELS.B.id, FUNNELS.C.id],
      funnelTags: [FUNNELS.A.id, FUNNELS.B.id],
      tags: ["Tag A", "Tag B", "Tag orphan"],
      paths: [`${FUNNELS.A.path}:active`, `${FUNNELS.B.path}:active`, `${FUNNELS.C.path}:active`, "soulmate-proposal:proposed"].sort(),
    });
    for (const user of [USER_IDS.emptyGrant, USER_IDS.noRule, USER_IDS.disabled, USER_IDS.nonMember]) {
      expect(await read(user), user).toEqual({ funnels: [], funnelTags: [], tags: [], paths: [] });
    }
    await expect(h.asAnon((tx) => tx.query("select 1 from public.funnel_paths"))).rejects.toThrow(/permission denied/);
  });
});

describe("H6 — sync and write actions", () => {
  const WRITES = CASES.filter((entry) => entry.rule.write);

  it("has the write actions (sanity)", () => {
    expect(WRITES.length).toBeGreaterThan(40);
  });

  it.each(WRITES.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const))("%s is refused to every non-admin template role", async (_label, entry) => {
    for (const persona of NON_ADMIN_TEMPLATES) {
      const { deps, clickhouse } = fakeGate({ persona });
      const probe = probeHandler();
      const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
      expect(result.status, persona.name).toBe(403);
      expect(probe.spy).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it("a writer cannot insert another tenant's rows: the reader refuses and the gate answers 500", async () => {
    const entry = CASES.find((candidate) => candidate.fn === "clickhouse-facebook" && candidate.action === "sync")!;
    for (const persona of [PERSONAS.owner, ADMIN_ALL]) {
      const { deps, clickhouse } = fakeGate({ persona });
      const handler = async (request: AccessRequest<string>) => {
        await request.clickhouse().insert({ table: "fact_facebook_stats", values: [{ auth_user_id: request.ctx.tenantKey }, { auth_user_id: FOREIGN_TENANT }] }).catch(() => null);
        return { ok: true };
      };
      const result = await callGate(entry.policy, handler, requestFor(entry).req, deps);
      expect(result.status, persona.name).toBe(500);
      expect(result.json?.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
      expect(clickhouse.statements).toEqual([]);
    }
  });
});

describe("H7 — saved objects of another member (RLS)", () => {
  it("a member cannot read, change or delete the owner's report or forecast by id", async () => {
    const h = await cloneLocked();
    const ownerReport = locked.reports.owner;
    const asViewer = <T>(sql: string, params: unknown[] = []) => h.asUser(USER_IDS.viewer, (tx) => tx.query<T>(sql, params));
    expect((await asViewer("select id from public.reports where id = $1", [ownerReport])).rows).toEqual([]);
    expect((await asViewer("update public.reports set title = 'forged' where id = $1", [ownerReport])).affectedRows).toBe(0);
    expect((await asViewer("delete from public.reports where id = $1", [ownerReport])).affectedRows).toBe(0);
    expect((await asViewer<{ n: number }>("select count(*)::int as n from public.project_forecasts where auth_user_id = $1", [DATA_KEY])).rows[0].n).toBe(0);
    // Its own saved objects stay visible (own-row RLS still applies).
    expect((await asViewer<{ id: string }>("select id from public.reports")).rows).toEqual([{ id: locked.reports.viewer }]);
    expect((await h.db.query<{ title: string }>("select title from public.reports where id = $1", [ownerReport])).rows[0].title).toBe("Owner weekly");
  });

  it("publish_report on someone else's report is 'not found' even for a member who may publish", async () => {
    const h = await cloneLocked();
    await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, locked.members.viewer, locked.roles.head_of_marketing, null, null]);
    await expect(
      h.asUser(USER_IDS.viewer, (tx) => tx.query("select public.publish_report($1)", [locked.reports.owner])),
    ).rejects.toThrow(/not found/);
    const versions = await h.db.query<{ n: number }>("select count(*)::int as n from public.report_versions where report_id = $1", [locked.reports.owner]);
    expect(versions.rows[0].n).toBe(0);
  });

  it.todo("Phase 4: H7 — scope stamps: a report saved by an all-scope member is invisible to buyer-{A} even when shared, and a buyer-{A} object stays invisible after narrowing to {C}");
});

describe("H8 — Export API keys", () => {
  const KEYS = {
    owner: apiKeyFixture("owner", DATA_KEY),
    admin: apiKeyFixture("admin", USER_IDS.admin),
    viewer: apiKeyFixture("viewer", USER_IDS.viewer),
    buyerA: apiKeyFixture("buyer", USER_IDS.buyerA),
    disabled: apiKeyFixture("disabled", USER_IDS.disabled),
    nonMember: apiKeyFixture("outsider", USER_IDS.nonMember),
    revoked: apiKeyFixture("revoked", USER_IDS.admin, { revoked_at: "2026-10-01T00:00:00Z" }),
    inactive: apiKeyFixture("inactive", USER_IDS.admin, { is_active: false }),
    wrongScope: apiKeyFixture("wrongscope", USER_IDS.admin, { allowed_scopes: ["something:else"] }),
  };
  type KeyName = keyof typeof KEYS;

  /** The export handler with the REAL resolver (PGlite resolve_access as service role). */
  function exportEnv(h: SupabasePglite) {
    const rpcActors: string[] = [];
    const pg = createStrictFakeSupabase({
      tenantKey: DATA_KEY,
      actorKey: null,
      tables: {
        api_keys: { scope: "global", rows: Object.values(KEYS).map((key) => key.row) },
        api_export_logs: { scope: "global" },
        import_batches: { scope: "tenant", owner: "user_id", rows: [{ id: "batch-1", user_id: DATA_KEY }, { id: "batch-x", user_id: FOREIGN_TENANT }] },
      },
      rpc: {
        resolve_access: {
          handler: async (params) => {
            rpcActors.push(String(params.p_user_id));
            try {
              return { data: await svc(h, "public.resolve_access($1)", [params.p_user_id]), error: null };
            } catch (error) {
              return { data: null, error: { message: (error as Error).message } };
            }
          },
        },
      },
    });
    const clickhouse = createRecordingClickHouse();
    const deps = {
      configError: null,
      pg: () => pg as never,
      createClickHouse: (ctx: Parameters<typeof createScopedReader>[0]) => createScopedReader(ctx, clickhouse),
      newRequestId: () => "req-export",
      log: vi.fn(),
    };
    const call = async (name: KeyName, query = "") =>
      readResult(await handleExportCampaignPerformance(new Request(`https://edge.test/functions/v1/export-campaign-performance${query}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${KEYS[name].raw}` },
      }), deps));
    return { pg, clickhouse, call, rpcActors };
  }

  it.each([
    ["nonMember", 403, ACCESS_ERROR.NO_MEMBERSHIP],
    ["disabled", 403, ACCESS_ERROR.MEMBERSHIP_DISABLED],
    ["viewer", 403, ACCESS_ERROR.PERMISSION_DENIED],
    ["buyerA", 403, ACCESS_ERROR.SCOPE_NOT_SUPPORTED],
  ] as const)("a key created by %s is refused with %s/%s by the real resolver, before any read", async (name, status, code) => {
    const env = exportEnv(locked.h);
    const result = await env.call(name);
    expect(result.status).toBe(status);
    expect(result.json).toEqual({ ok: false, error_code: code, error: ACCESS_ERROR_MESSAGES[code] });
    expect(env.clickhouse.statements).toEqual([]);
    expect(env.pg.callsTo("import_batches")).toEqual([]);
    expect(env.pg.violations).toEqual([]);
  });

  it.each(["revoked", "inactive", "wrongScope"] as const)("a %s key is 401 and resolves nobody", async (name) => {
    const env = exportEnv(locked.h);
    const result = await env.call(name);
    expect(result.status).toBe(401);
    expect(result.json).toEqual({ error: "Invalid API key." });
    expect(env.rpcActors).toEqual([]);
    expect(env.clickhouse.statements).toEqual([]);
  });

  it("an admin's key (api_export.use, scope all) reads the WORKSPACE data key, never the key creator's id", async () => {
    const env = exportEnv(locked.h);
    for (const query of ["", "?breakdown=country"]) {
      const result = await env.call("admin", query);
      expect(result.status, query).toBe(200);
    }
    expect(env.rpcActors).toEqual([USER_IDS.admin, USER_IDS.admin]);
    expect(env.clickhouse.boundTenants()).toEqual([DATA_KEY]);
    expect(env.pg.violations).toEqual([]);
    // Authorized exports are logged under the workspace data key (tenant data the
    // data owner can read after the lockdown); the key creator rides actor_user_id.
    expect(env.pg.inserted("api_export_logs").map((row) => [row.user_id, row.actor_user_id])).toEqual([
      [DATA_KEY, USER_IDS.admin],
      [DATA_KEY, USER_IDS.admin],
    ]);
  });

  it("disabling the creator kills the key on the next call", async () => {
    const h = await cloneLocked();
    const env = exportEnv(h);
    expect((await env.call("admin")).status).toBe(200);
    await svc(h, UPDATE_MEMBER_SQL, [DATA_KEY, locked.members.admin, null, "disabled", null]);
    const after = await env.call("admin");
    expect(after.status).toBe(403);
    expect(after.json?.error_code).toBe(ACCESS_ERROR.MEMBERSHIP_DISABLED);
  });

  it.todo("Phase 5: H8 — Edge-minted keys carry scope_funnel_ids ⊆ the creator's scope, every call re-resolves the creator's live scope, and a buyer-{A} key's rows all have campaign_path ∈ paths(A) (SQL scope inside loadExportTransactions)");
});

describe("tampered tenant parameters are ignored, and forwarding them fails closed", () => {
  it.each(CASE_ROWS)("%s", async (_label, entry) => {
    const body = entry.request.method === "GET" ? undefined : { ...entry.request.body, ...TAMPERED_TENANT_FIELDS };
    expect(normalizedAction(entry.policy, { ...entry.request, body })).toBe(entry.action);
    const persona = entry.rule.ownerOnly || entry.rule.rawOnly ? PERSONAS.owner : withGrant(PERSONAS.viewer, minimalGrant(entry.rule));

    const honest = fakeGate({ persona });
    const probe = probeHandler();
    const served = await callGate(entry.policy, probe.handler, requestFor(entry, body).req, honest.deps);
    expect(served.status).toBe(200);
    expect(probe.seen[0].ctx.tenantKey).toBe(DATA_KEY);
    expect(honest.clickhouse.boundTenants()).toEqual([DATA_KEY]);

    // A handler that (wrongly) forwards the body's tenant to the warehouse.
    const naive = fakeGate({ persona });
    const forwarding = async (request: AccessRequest<string>) => {
      await request.clickhouse().query({ query: TENANT_PROBE_SQL, query_params: { auth_user_id: request.body.auth_user_id ?? FOREIGN_TENANT } });
      return { ok: true };
    };
    const failed = await callGate(entry.policy, forwarding, requestFor(entry, body).req, naive.deps);
    expect(failed.status).toBe(500);
    expect(failed.json?.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
    expect(naive.clickhouse.statements).toEqual([]);
  });
});

// =========================================================================================
// Vertical
// =========================================================================================

describe("V1 — admin and ops actions are refused to non-admin roles", () => {
  const PRIVILEGED_CASES = CASES.filter((entry) => entry.rule.ownerOnly || entry.rule.rawOnly || needsPrivileged(entry.rule));

  it("includes init, backfill, syncs, rebuilds, diagnostics and every access.* action", () => {
    const keys = new Set(PRIVILEGED_CASES.map((entry) => `${entry.fn}.${entry.action}`));
    for (const key of [
      "clickhouse-init.init",
      "clickhouse-backfill.continue", "clickhouse-backfill.full_backfill", "clickhouse-backfill.validate_only", "clickhouse-backfill.dedup",
      "clickhouse-facebook.sync", "clickhouse-support.sync", "capsuled-facebook-sync.sync", "funnelfox-subscriptions-sync.sync",
      "funnelfox-leads-sync.sync", "sync-support-mail.sync_new", "classify-support-requests.start",
      "clickhouse-cohort-membership.rebuild", "clickhouse-cohort-membership.rebuild_force", "clickhouse-cohort-membership.validate",
      "clickhouse-validate.start", "clickhouse-health.health",
      "clickhouse-facebook.history_raw_payloads", "clickhouse-facebook.recon_history", "clickhouse-facebook.v2_parity", "clickhouse-facebook.source_probe",
      "clickhouse-facebook.v2_preview", "clickhouse-facebook.funnel_suggestions_apply",
      ...Object.keys(ACCESS_POLICY.actions).map((action) => `access.${action}`),
    ]) {
      expect(keys.has(key), key).toBe(true);
    }
  });

  it.each(PRIVILEGED_CASES.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const))("%s: every non-admin template role gets 403 before the handler", async (_label, entry) => {
    for (const persona of NON_ADMIN_TEMPLATES) {
      const { deps, clickhouse } = fakeGate({ persona });
      const probe = probeHandler();
      const result = await callGate(entry.policy, probe.handler, requestFor(entry).req, deps);
      expect(result.status, persona.name).toBe(403);
      expect([ACCESS_ERROR.PERMISSION_DENIED, ACCESS_ERROR.OWNER_REQUIRED, ACCESS_ERROR.RAW_ACCESS_REQUIRED]).toContain(result.json?.error_code);
      expect(probe.spy).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it("an Admin holding every permission is still refused the owner-only and data-owner-only actions", async () => {
    const ownerOnly = CASES.filter((entry) => entry.rule.ownerOnly || entry.rule.rawOnly);
    expect(ownerOnly.map((entry) => `${entry.fn}.${entry.action}`)).toEqual(expect.arrayContaining(["clickhouse-init.init", "access.roles.seed_templates"]));
    for (const entry of ownerOnly) {
      const { deps } = fakeGate({ persona: ADMIN_ALL });
      const result = await callGate(entry.policy, probeHandler().handler, requestFor(entry).req, deps);
      expect(result.status, `${entry.fn}.${entry.action}`).toBe(403);
    }
  });
});

describe("V2-V4 — self-grant, over-grant and the cloned Admin role (gate → access handler → real SQL)", () => {
  async function adminCall(h: SupabasePglite, actor: string, body: Record<string, unknown>) {
    const store = createPgliteAccessAdminStore(h);
    const handler = createAccessAdminHandler({ makeStore: () => store, log: () => undefined });
    const { deps } = pgliteGateDeps(h);
    const result = await callGate(ACCESS_POLICY, handler, edgeRequest({ fn: "access", token: userToken(actor), body }).req, deps, { onError: accessAdminOnError });
    return { ...result, store };
  }
  const roleCount = async (h: SupabasePglite) => (await h.db.query<{ n: number }>("select count(*)::int as n from public.access_roles")).rows[0].n;
  const memberRole = async (h: SupabasePglite, user: string) =>
    (await h.db.query<{ key: string }>("select r.key from public.workspace_members m join public.access_roles r on r.id = m.role_id where m.user_id = $1", [user])).rows[0].key;

  it("positive control: the store reaches the real RPCs (an admin can create a non-privileged role)", async () => {
    const h = await cloneLocked();
    const result = await adminCall(h, USER_IDS.admin, { action: "roles.create", name: "Reporter", permissions: ["dashboard.view", "reports.view"] });
    expect(result.status, result.text).toBe(200);
    expect(result.json).toMatchObject({ ok: true, role: { key: "reporter", permissions: ["dashboard.view", "reports.view"] } });
  });

  it("V2 self-grant: a viewer cannot reach the access API, nor write access tables, nor call the RPCs directly", async () => {
    const h = await cloneLocked();
    const { members, roles } = locked;
    for (const body of [
      { action: "members.update", member_id: members.viewer, role_id: roles.admin },
      { action: "members.set_scope", member_id: members.viewer, scope: { mode: "all", funnel_ids: [] } },
      { action: "roles.update", role_id: roles.viewer, permissions: [...TEMPLATE_PERMISSIONS.viewer, "admin.users.manage", "admin.users.view"] },
    ]) {
      const result = await adminCall(h, USER_IDS.viewer, body);
      expect(result.status).toBe(403);
      expect(result.json?.error_code).toBe(ACCESS_ERROR.PERMISSION_DENIED);
      expect(result.store.rpcCalls).toEqual([]);
    }
    await expect(h.asUser(USER_IDS.viewer, (tx) => tx.query("update public.access_roles set permissions = '{admin.users.manage,admin.users.view}' where id = $1", [roles.viewer]))).rejects.toThrow(/permission denied/);
    await expect(h.asUser(USER_IDS.buyerA, (tx) => tx.query("update public.member_scope_rules set mode = 'all' where member_id = $1", [members.buyerA]))).rejects.toThrow(/permission denied/);
    await expect(
      h.asUser(USER_IDS.buyerA, (tx) => tx.query("select public.access_set_member_scope($1, $2, 'all', '{}'::uuid[])", [USER_IDS.buyerA, members.buyerA])),
    ).rejects.toThrow(/permission denied for function/);
    const mine = await h.asUser(USER_IDS.buyerA, async (tx) => (await tx.query<{ v: { funnel_scope: { mode: string } } }>("select public.my_access() as v")).rows[0].v);
    expect(mine.funnel_scope.mode).toBe("selected");
    expect(await memberRole(h, USER_IDS.viewer)).toBe("viewer");
  });

  it("V3/V4 over-grant: an admin cannot create, clone, edit or assign a privileged role; nothing is written", async () => {
    const h = await cloneLocked();
    const { members, roles } = locked;
    const rolesBefore = await roleCount(h);
    const attempts: Array<Record<string, unknown>> = [
      { action: "roles.create", name: "Admin copy", permissions: [...ENFORCED_PERMISSION_KEYS] },
      { action: "roles.create", name: "Auditor", permissions: ["admin.audit.view"] },
      { action: "roles.create", name: "Exporter", permissions: ["api_export.use"] },
      { action: "roles.create", name: "Registry", permissions: ["funnels.view", "funnels.manage"] },
      { action: "roles.update", role_id: roles.viewer, permissions: [...TEMPLATE_PERMISSIONS.viewer, "admin.diagnostics.view"] },
      { action: "members.update", member_id: members.viewer, role_id: roles.admin },
      { action: "members.add", email: "newbie@example.test", role_id: roles.admin, scope: { mode: "all", funnel_ids: [] } },
      { action: "members.update", member_id: members.admin, status: "disabled" },
    ];
    for (const body of attempts) {
      const result = await adminCall(h, USER_IDS.admin, body);
      expect(result.status, JSON.stringify(body)).toBe(403);
      expect(result.json?.error_code, JSON.stringify(body)).toBe("escalation_denied");
    }
    expect(await roleCount(h)).toBe(rolesBefore);
    expect(await memberRole(h, USER_IDS.viewer)).toBe("viewer");
    const newbie = await h.db.query("select 1 from public.workspace_members where user_id = $1", [USER_IDS.newbie]);
    expect(newbie.rows).toEqual([]);
    const viewerRole = await h.db.query<{ permissions: string[] }>("select permissions from public.access_roles where id = $1", [roles.viewer]);
    expect(viewerRole.rows[0].permissions.some((key) => isPrivilegedPermission(key))).toBe(false);
  });

  it("V3 grantor ⊇ grantee: a role administrator cannot grant permissions it does not hold", async () => {
    const h = await cloneLocked();
    const created = await adminCall(h, DATA_KEY, { action: "roles.create", name: "Role admin", permissions: ["admin.roles.view", "admin.roles.manage", "admin.users.view", "admin.users.manage", "dashboard.view"] });
    expect(created.status, created.text).toBe(200);
    const roleId = (created.json?.role as { id: string }).id;
    const added = await adminCall(h, DATA_KEY, { action: "members.add", email: "newbie@example.test", role_id: roleId, scope: { mode: "all", funnel_ids: [] } });
    expect(added.status, added.text).toBe(200);
    for (const body of [
      { action: "roles.create", name: "Cohorts", permissions: ["cohorts.view"] },
      { action: "members.update", member_id: locked.members.viewer, role_id: locked.roles.analyst },
    ]) {
      const result = await adminCall(h, USER_IDS.newbie, body);
      expect(result.status, JSON.stringify(body)).toBe(403);
      expect(result.json?.error_code).toBe("escalation_denied");
    }
    // ...but it may grant what it holds.
    expect((await adminCall(h, USER_IDS.newbie, { action: "roles.create", name: "Dash", permissions: ["dashboard.view"] })).status).toBe(200);
  });

  it("self-edit is forbidden for admins and for the Owner", async () => {
    const h = await cloneLocked();
    const { members, roles } = locked;
    for (const [actor, body] of [
      [USER_IDS.admin, { action: "members.update", member_id: members.admin, display_name: "Me" }],
      [USER_IDS.admin, { action: "members.update", member_id: members.admin, role_id: roles.owner }],
      [USER_IDS.admin, { action: "members.set_scope", member_id: members.admin, scope: { mode: "all", funnel_ids: [] } }],
      [DATA_KEY, { action: "members.update", member_id: members.owner, display_name: "Boss" }],
    ] as const) {
      const result = await adminCall(h, actor, body);
      expect(result.status, JSON.stringify(body)).toBe(403);
      expect(result.json?.error_code).toBe("escalation_denied");
      expect(String(result.json?.error)).toMatch(/your own membership/);
    }
  });

  it("the Owner may do what admins may not (the denials are about the actor, not the request)", async () => {
    const h = await cloneLocked();
    const result = await adminCall(h, DATA_KEY, { action: "roles.create", name: "Auditor", permissions: ["admin.audit.view", "dashboard.view"] });
    expect(result.status, result.text).toBe(200);
  });
});

describe("V5 — registry re-pathing", () => {
  it("members without funnels.manage cannot re-path, add or re-tag funnels; a buyer's scope paths are unchanged", async () => {
    const h = await cloneLocked();
    for (const user of [USER_IDS.viewer, USER_IDS.buyerA, USER_IDS.emptyGrant]) {
      const updated = await h.asUser(user, (tx) => tx.query("update public.funnels set funnel_path = $2 where id = $1", [FUNNELS.B.id, FUNNELS.A.path]));
      expect(updated.affectedRows, user).toBe(0);
      await expect(h.asUser(user, (tx) => tx.query("insert into public.funnels (funnel_path) values ('forged-funnel')"))).rejects.toThrow(/row-level security/);
      await expect(h.asUser(user, (tx) => tx.query("select public.replace_funnel_tags($1, '{}'::uuid[])", [FUNNELS.A.id]))).rejects.toThrow(/permission_denied/);
    }
    const access = await svc(h, "public.resolve_access($1)", [USER_IDS.buyerA]);
    expect((access.funnel_scope as { paths: string[] }).paths).toEqual([FUNNELS.A.path]);
    // Positive control: the admin (funnels.manage, scope all) may.
    const renamed = await h.asUser(USER_IDS.admin, (tx) => tx.query("update public.funnels set display_name = 'Renamed' where id = $1", [FUNNELS.C.id]));
    expect(renamed.affectedRows).toBe(1);
  });
});

describe("V6 — the cron tenant comes from the workspace, never from the body", () => {
  const CRON_REQUESTS: Record<string, Record<string, Record<string, unknown>>> = {
    "clickhouse-cohort-membership": { cron_tick: { action: "cron_tick" } },
    "clickhouse-facebook": { cron_daily: {} },
    "funnelfox-subscriptions-sync": { sync: { full_reset: false }, sync_full_reset: { full_reset: true } },
    // The exact bodies public.invoke_funnelfox_leads_sync posts (migration 202610060011).
    "funnelfox-leads-sync": {
      sync: { full_reset: false, limit: 100, max_pages: 200 },
      sync_full_reset: { full_reset: true, limit: 100, max_pages: 200 },
    },
    "sync-support-mail": {
      sync_new: { internal: true, action: "sync_new" },
      sent_initial_sync: { internal: true, action: "sent_initial_sync" },
      sent_continue_sync: { internal: true, action: "sent_continue_sync" },
      rematch_replies: { internal: true, action: "rematch_replies", mode: "full" },
    },
    "classify-support-requests": { continue: { action: "continue" } },
  };
  const NOT_FOR_CRON: Record<string, Record<string, unknown>> = {
    "clickhouse-cohort-membership": { action: "rebuild", force: true },
    "clickhouse-facebook": { action: "report" },
    "funnelfox-subscriptions-sync": { dry_run: true },
    "funnelfox-leads-sync": { dry_run: true },
    "sync-support-mail": { internal: true, action: "reset_cursor" },
    "classify-support-requests": { action: "reset" },
  };
  const CRON_POLICIES = ALL_POLICIES.filter((policy) => policy.cron);
  const cronRows = CRON_POLICIES.flatMap((policy) => policy.cron!.actions.map((action) => [`${policy.fn}.${action}`, policy, action] as const));
  const secretOf = (policy: FunctionPolicy<string>) => CRON_SECRETS[policy.cron!.secretEnv];
  const cronRequest = (policy: FunctionPolicy<string>, body: Record<string, unknown>, secret = secretOf(policy)) =>
    edgeRequest({ fn: policy.fn, token: null, body, headers: { [policy.cron!.header]: secret } });

  it("covers every cron policy and action (sanity)", () => {
    expect(CRON_POLICIES.map((policy) => policy.fn).sort()).toEqual(Object.keys(CRON_REQUESTS).sort());
    for (const policy of CRON_POLICIES) expect(Object.keys(CRON_REQUESTS[policy.fn]).sort()).toEqual([...policy.cron!.actions].sort());
  });

  it.each(cronRows)("%s: a valid tick runs as cron on the data key; a foreign body uid is 400 tenant_mismatch", async (_label, policy, action) => {
    const base = CRON_REQUESTS[policy.fn][action];
    for (const auth of [undefined, DATA_KEY, DATA_KEY.toUpperCase()]) {
      const { deps, clickhouse } = fakeGate();
      const probe = probeHandler();
      const result = await callGate(policy, probe.handler, cronRequest(policy, auth === undefined ? base : { ...base, auth_user_id: auth }).req, deps);
      expect(result.status, String(auth)).toBe(200);
      expect(probe.seen[0].action).toBe(action);
      expect(probe.seen[0].ctx).toMatchObject({ tenantKey: DATA_KEY, rawAccess: false, restricted: false, actor: { kind: "cron", userId: null } });
      expect(clickhouse.boundTenants()).toEqual([DATA_KEY]);
      expect(deps.getUser).not.toHaveBeenCalled();
      expect(deps.loadAccess).not.toHaveBeenCalled();
    }
    for (const foreign of [FOREIGN_TENANT, USER_IDS.admin, "", "not-a-uuid", 42]) {
      const { deps, clickhouse } = fakeGate();
      const probe = probeHandler();
      const result = await callGate(policy, probe.handler, cronRequest(policy, { ...base, auth_user_id: foreign }).req, deps);
      expect(result.status, String(foreign)).toBe(400);
      expect(result.json).toEqual({ ok: false, error_code: ACCESS_ERROR.TENANT_MISMATCH, error: ACCESS_ERROR_MESSAGES.tenant_mismatch });
      expect(probe.spy).not.toHaveBeenCalled();
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it.each(CRON_POLICIES.map((policy) => [policy.fn, policy] as const))("%s: a wrong, foreign or missing secret is refused before the body or the workspace is read", async (_fn, policy) => {
    const otherSecret = Object.values(CRON_SECRETS).find((secret) => secret !== secretOf(policy))!;
    for (const secret of [`${secretOf(policy)}x`, otherSecret, "", " "]) {
      const { deps } = fakeGate();
      const { req, textSpy } = cronRequest(policy, { auth_user_id: DATA_KEY }, secret);
      const result = await callGate(policy, probeHandler().handler, req, deps);
      expect(result.status, JSON.stringify(secret)).toBe(401);
      expect(result.json?.error_code).toBe(ACCESS_ERROR.INVALID_CRON_SECRET);
      expect(textSpy).not.toHaveBeenCalled();
      expect(deps.workspaceDataKey).not.toHaveBeenCalled();
    }
    const unconfigured = fakeGate({ secrets: {} });
    const { req, textSpy } = cronRequest(policy, { auth_user_id: DATA_KEY });
    const result = await callGate(policy, probeHandler().handler, req, unconfigured.deps);
    expect(result.status).toBe(503);
    expect(result.json?.error_code).toBe(ACCESS_ERROR.CRON_NOT_CONFIGURED);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it.each(CRON_POLICIES.map((policy) => [policy.fn, policy] as const))("%s: the scheduler cannot run user-only actions, and fails closed without a workspace", async (_fn, policy) => {
    const { deps } = fakeGate();
    const result = await callGate(policy, probeHandler().handler, cronRequest(policy, NOT_FOR_CRON[policy.fn]).req, deps);
    expect([400, 403]).toContain(result.status);
    expect([ACCESS_ERROR.UNKNOWN_ACTION, ACCESS_ERROR.CRON_ACTION_NOT_ALLOWED]).toContain(result.json?.error_code);

    const action = policy.cron!.actions[0];
    const missing = fakeGate({ workspaceDataKey: async () => ({ data: null, error: null }) });
    const noWorkspace = await callGate(policy, probeHandler().handler, cronRequest(policy, CRON_REQUESTS[policy.fn][action]).req, missing.deps);
    expect(noWorkspace.status).toBe(503);
    expect(noWorkspace.json?.error_code).toBe(ACCESS_ERROR.WORKSPACE_NOT_BOOTSTRAPPED);
  });

  it("a cron header on a function without a cron policy opens nothing (user branch: 401 without a session)", async () => {
    for (const policy of GATED_POLICIES.filter((candidate) => !candidate.cron)) {
      const { deps } = fakeGate();
      const action = Object.keys(policy.actions)[0];
      const body = { ...(CASES.find((entry) => entry.fn === policy.fn && entry.action === action)?.request.body ?? {}), auth_user_id: DATA_KEY };
      const result = await callGate(policy, probeHandler().handler, edgeRequest({ fn: policy.fn, token: null, body, headers: { "x-cron-secret": CRON_SECRETS.FB_CRON_SECRET, "x-support-mail-internal-secret": CRON_SECRETS.SUPPORT_MAIL_SYNC_INTERNAL_SECRET } }).req, deps);
      expect(result.status, policy.fn).toBe(401);
      expect(deps.workspaceDataKey).not.toHaveBeenCalled();
    }
  });
});

describe("V7 — bootstrap / recover / resolver RPCs are service-role only", () => {
  it("authenticated and anon callers are denied every privileged RPC", async () => {
    const h = locked.h;
    const calls: Array<[string, unknown[]]> = [
      ["select public.bootstrap_workspace($1, 'Hijack')", [USER_IDS.viewer]],
      ["select public.recover_owner($1)", [USER_IDS.viewer]],
      ["select public.resolve_access($1)", [DATA_KEY]],
      ["select public.workspace_data_key()", []],
      ["select public.access_write_audit('member.added', 'user', $1, null, null, 'success', null, null, null, null)", [USER_IDS.viewer]],
      ["select public.access_record_denial($1, 'x', 'y', 'z', 'r')", [USER_IDS.viewer]],
      ["select public.access_seed_role_templates($1, '[]'::jsonb)", [USER_IDS.viewer]],
    ];
    for (const [sql, params] of calls) {
      for (const user of [USER_IDS.viewer, USER_IDS.admin, DATA_KEY]) {
        await expect(h.asUser(user, (tx) => tx.query(sql, params)), `${user}: ${sql}`).rejects.toThrow(/permission denied for function/);
      }
      await expect(h.asAnon((tx) => tx.query(sql, params)), `anon: ${sql}`).rejects.toThrow(/permission denied/);
    }
  });

  it("a second bootstrap is refused even for the service role, and the data key is unchanged", async () => {
    const h = await cloneLocked();
    await expect(svc(h, "public.bootstrap_workspace($1, 'Again')", [USER_IDS.admin])).rejects.toThrow(/conflict: the workspace is already bootstrapped/);
    expect(await svc(h, "public.workspace_data_key()")).toBe(DATA_KEY);
  });
});

describe("V8 — writes under a restricted scope", () => {
  const WRITES = CASES.filter((entry) => entry.rule.write);

  it.each(WRITES.map((entry) => [`${entry.fn}.${entry.action}`, entry] as const))("%s refuses buyer-{A} even with every permission granted", async (_label, entry) => {
    const { deps, clickhouse } = fakeGate({ persona: withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS) });
    const result = await callGate(entry.policy, probeHandler().handler, requestFor(entry).req, deps);
    expect(result.status).toBe(403);
    expect(clickhouse.statements).toEqual([]);
  });

  it("a restricted reader refuses every protected-table write, whatever the tenant column says", async () => {
    const ctx = contextFor(PERSONAS.buyerA);
    const reader = createScopedReader(ctx, createRecordingClickHouse());
    await expect(reader.insert({ table: "fact_user_cohorts", values: [{ auth_user_id: DATA_KEY }] })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(reader.command({ query: "ALTER TABLE analytics_transactions DELETE WHERE auth_user_id = {auth_user_id:String}" })).rejects.toBeInstanceOf(ScopeViolation);
    await expect(reader.command({ query: "INSERT INTO fact_support_requests SELECT * FROM fact_support_requests_rebuild" })).rejects.toBeInstanceOf(ScopeViolation);
    expect(ctx.violations).toHaveLength(3);
  });

  it("Phase 2: a scopeReady handler's command() / insert() under a restricted scope is restricted_write → 500, nothing sent", async () => {
    const entry = CASES.find((candidate) => candidate.fn === "clickhouse-cohorts" && candidate.action === "list")!;
    const writes: Array<(request: AccessRequest<string>) => Promise<unknown>> = [
      (request) => request.clickhouse().command({ query: "CREATE TABLE IF NOT EXISTS scratch_buyer (x UInt8) ENGINE = Memory" }),
      (request) => request.clickhouse().insert({ table: "scratch_buyer", values: [{ auth_user_id: request.ctx.tenantKey }] }),
    ];
    for (const write of writes) {
      const { deps, clickhouse } = fakeGate({ persona: withGrant(PERSONAS.buyerA, ENFORCED_PERMISSION_KEYS) });
      let violations: readonly string[] = [];
      const handler = async (request: AccessRequest<string>) => {
        await write(request).catch(() => null);
        violations = [...request.ctx.violations];
        return { ok: true };
      };
      const result = await callGate(entry.policy, handler as never, requestFor(entry).req, deps);
      expect(result.status).toBe(500);
      expect(result.json?.error_code).toBe(ACCESS_ERROR.SCOPE_VIOLATION);
      expect(violations.map((code) => code.split(":")[0])).toEqual(["restricted_write"]);
      expect(clickhouse.statements).toEqual([]);
    }
  });

  it.todo("Phase 4: V8 (scratch part; the restricted_write part runs above) — adminWriter(ctx) exists and is the only writer: it requires cron or full scope with admin.sync.run / admin.warehouse.manage, and scratchFromScopedSelect(ctx, prefix, select) is the only way a restricted request creates a scratch table (Payment Pass / Banks / Users decline, not scopeReady yet)");
});

// =========================================================================================
// canonical actions: unknown, missing and flag-variant
// =========================================================================================

describe("unknown, missing and flag-variant actions → 400 or the more privileged policy", () => {
  const DOCUMENTED_DEFAULTS: Record<string, string> = {
    "capsuled-facebook-sync": "sync",
    "clickhouse-facebook": "report",
    "clickhouse-health": "health",
    "clickhouse-init": "init",
    "clickhouse-summary": "summary",
    "clickhouse-validate": "start",
    "dashboard-summary": "summary",
    "fb-analytics-summary": "summary",
    "funnelfox-funnels": "list",
    "funnelfox-leads-sync": "sync",
    "funnelfox-profile": "profile",
    "funnelfox-subscription": "details",
    "funnelfox-subscriptions": "list",
    "funnelfox-subscriptions-sync": "sync",
  };

  it("a body without an action maps only to the documented defaults; every other policy answers 400", () => {
    for (const policy of GATED_POLICIES) {
      expect(normalizedAction(policy, { method: "POST", body: {} }), policy.fn).toBe(DOCUMENTED_DEFAULTS[policy.fn] ?? null);
    }
  });

  const FUZZ: Array<Record<string, unknown>> = [
    { action: null }, { action: "" }, { action: " " }, { action: "LIST" }, { action: "list " }, { action: "List" }, { action: ["list"] },
    { action: 1 }, { action: true }, { action: { name: "list" } }, { action: "constructor" }, { action: "__proto__" }, { action: "toString" },
    { action: "hasOwnProperty" }, { action: "valueOf" }, { action: "cron_daily" }, { action: "../access" }, { action: "members.list;drop" },
    { action: "bundle\u0000" }, { mode: "CONTINUE" }, { mode: "continue " }, { mode: "full-backfill" },
    { action: "analytics", purpose: "unknown_purpose" }, { action: "banks", purpose: "ai_pass_rates" },
    { action: "summary", inspect: "1", debug: "true", dry_run: "yes" },
  ];

  it.each(GATED_POLICIES.map((policy) => [policy.fn, policy] as const))("%s: fuzzed actions are 400 or a canonical action of the policy, never a crash or policy_missing", async (_fn, policy) => {
    for (const body of FUZZ) {
      const normalized = normalizedAction(policy, { method: "POST", body });
      if (normalized !== null) expect(Object.keys(policy.actions), `${policy.fn} ${JSON.stringify(body)}`).toContain(normalized);
      const { deps } = fakeGate({ persona: ADMIN_ALL });
      const probe = probeHandler();
      const result = await callGate(policy, probe.handler, edgeRequest({ fn: policy.fn, body }).req, deps);
      expect([200, 400, 403], `${policy.fn} ${JSON.stringify(body)}`).toContain(result.status);
      expect(result.json?.error_code).not.toBe(ACCESS_ERROR.POLICY_MISSING);
      if (result.status === 200) expect(probe.seen[0].action).toBe(normalized);
      if (normalized === null) expect(result.json?.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });

  // [fn, base body, flag-variant body]. The variant must normalize to its own
  // action, and anyone allowed the variant must be allowed the base.
  const VARIANTS: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["clickhouse-facebook", { action: "list" }, { action: "list", v2_preview: true }],
    ["clickhouse-facebook", { action: "report" }, { action: "report", v2_preview: true }],
    ["clickhouse-facebook", { action: "summary" }, { action: "summary", v2_preview: true }],
    ["clickhouse-facebook", {}, { v2_preview: true }],
    ["clickhouse-facebook", { action: "funnel_suggestions" }, { action: "funnel_suggestions", apply: true }],
    ["clickhouse-cohort-membership", { action: "rebuild" }, { action: "rebuild", force: true }],
    ["clickhouse-cohort-membership", { action: "rebuild" }, { action: "rebuild", force: "false" }],
    ["clickhouse-cohorts", { action: "list" }, { action: "list", fb_allocation_diagnostics: false }],
    ["clickhouse-support", { action: "bundle" }, { action: "bundle", filters: { search: "a" } }],
    ["clickhouse-support", { action: "list" }, { action: "list", filters: { search: 1 } }],
    ["clickhouse-support", { action: "export" }, { action: "export", filters: { search: "x@y" } }],
    ["clickhouse-support", { action: "unanswered_contacts" }, { action: "unanswered_contacts", filters: { search: "z" } }],
    ["clickhouse-backfill", { mode: "continue" }, { mode: "continue", full_reset_cursor: "false" }],
    ["funnelfox-funnels", {}, { inspect: "true" }],
    ["funnelfox-profile", { id: "p1" }, { id: "p1", debug: " TRUE " }],
    ["funnelfox-subscriptions", {}, { debug: "1" }],
    ["funnelfox-subscriptions-sync", {}, { full_reset: true }],
    ["funnelfox-subscriptions-sync", {}, { dry_run: true }],
    ["funnelfox-leads-sync", {}, { dry_run: true, full_reset: true }],
  ];

  const SAMPLE: Persona[] = [
    ...ENFORCED_PERMISSION_KEYS.map((key) => withGrant(PERSONAS.viewer, closeUnderRequires([key]), { name: key })),
    ...NON_ADMIN_TEMPLATES,
    ADMIN_ALL,
    PERSONAS.owner,
  ];

  const allowed = (persona: Persona, rule: ActionPolicy) => authorizeAction(contextFor(persona), rule) === null;

  it.each(VARIANTS.map((row) => [`${row[0]} ${JSON.stringify(row[2])}`, ...row] as const))("%s is at least as privileged as its base", (_label, fn, base, variant) => {
    const policy = policyFor(fn);
    const baseAction = normalizedAction(policy, { method: "POST", body: base });
    const variantAction = normalizedAction(policy, { method: "POST", body: variant });
    expect(baseAction).not.toBeNull();
    expect(variantAction).not.toBeNull();
    for (const persona of SAMPLE) {
      if (allowed(persona, policy.actions[variantAction!])) {
        expect(allowed(persona, policy.actions[baseAction!]), `${persona.name}: ${variantAction} ⇒ ${baseAction}`).toBe(true);
      }
    }
  });

  // DEFECT (Phase 1 policy table): CLICKHOUSE_FACEBOOK_POLICY.actions.v2_preview
  // is { anyOf: ["admin.diagnostics.view"] }, so the flag variant does NOT
  // include the base read's facebook_analytics.view: a diagnostics-only member
  // is refused { action: "report" } but served the same report through
  // { action: "report", v2_preview: true } (handler: runFbReport / runFbList).
  // Expected: allOf ["facebook_analytics.view", "admin.diagnostics.view"].
  it("a diagnostics-only member cannot read the FB report through the v2_preview flag when the base report is refused", async () => {
    const persona = withGrant(PERSONAS.admin, ["admin.diagnostics.view"], { name: "diagnostics-only" });
    const policy = policyFor("clickhouse-facebook");
    const base = fakeGate({ persona });
    const refused = await callGate(policy, probeHandler().handler, edgeRequest({ body: { action: "report" } }).req, base.deps);
    expect(refused.status).toBe(403);
    const variant = fakeGate({ persona });
    const probe = probeHandler();
    const viaFlag = await callGate(policy, probe.handler, edgeRequest({ body: { action: "report", v2_preview: true } }).req, variant.deps);
    expect(viaFlag.status, "v2_preview must not open a read the base action refuses").toBe(403);
    expect(probe.spy).not.toHaveBeenCalled();
  });

  it("flag spellings the handlers do not honour stay on the base action (no silent escalation either way)", () => {
    const fb = policyFor("clickhouse-facebook");
    for (const value of ["true", 1, "1", "yes"]) {
      expect(normalizedAction(fb, { body: { action: "list", v2_preview: value } })).toBe("list");
      expect(normalizedAction(fb, { body: { action: "funnel_suggestions", apply: value } })).toBe("funnel_suggestions");
    }
    // ...and the runner / handler use the very same strict test.
    const facebookStats = readSource("supabase/functions/_shared/clickhouse/facebookStats.ts");
    expect(facebookStats).toMatch(/req\.v2_preview === true/);
    const fbIndex = readSource("supabase/functions/clickhouse-facebook/index.ts");
    expect(fbIndex).toMatch(/action === "funnel_suggestions_apply"/);
    expect(fbIndex).not.toMatch(/body\.apply/);
  });

  it("the payment-analytics purpose flag lowers the requirement only to a reduced projection", () => {
    const policy = policyFor("clickhouse-payment-analytics");
    expect(normalizedAction(policy, { body: { action: "analytics", purpose: "ai_pass_rates" } })).toBe("ai_pass_rates");
    const aiOnly = contextFor(withGrant(PERSONAS.viewer, ["ai.use", "cohorts.view"]));
    expect(authorizeAction(aiOnly, policy.actions.ai_pass_rates)).toBeNull();
    expect(authorizeAction(aiOnly, policy.actions.bundle)).not.toBeNull();
    expect(paymentPassFullBundleAllowed(aiOnly)).toBe(false);
    const index = readSource("supabase/functions/clickhouse-payment-analytics/index.ts");
    expect(index).toMatch(/runAiPassRates\(\{[^}]*fullBundle: paymentPassFullBundleAllowed\(ctx\)/);
  });

  it("a user can never name a cron-only action", () => {
    for (const [fn, actions] of Object.entries(CRON_ONLY_ACTIONS)) {
      for (const action of actions) expect(normalizedAction(policyFor(fn), { body: { action } }), `${fn}.${action}`).toBeNull();
    }
  });
});

// Sanity: the fixtures this file relies on resolve as the real SQL does.
describe("fixture parity", () => {
  it("the fake resolve_access rows parse exactly like the PGlite ones for the same persona", async () => {
    for (const name of ["owner", "viewer", "buyerA", "emptyGrant", "noRule"] as const) {
      const real = await svc(locked.h, "public.resolve_access($1)", [USER_IDS[name]]);
      const fake = accessRow(PERSONAS[name]);
      expect((fake.funnel_scope as { mode: string }).mode, name).toBe((real.funnel_scope as { mode: string }).mode);
      expect((fake.role as { is_owner: boolean }).is_owner, name).toBe((real.role as { is_owner: boolean }).is_owner);
      expect(fake.raw_access, name).toBe(real.raw_access);
      expect(fake.data_key, name).toBe(real.data_key);
    }
  });
});
