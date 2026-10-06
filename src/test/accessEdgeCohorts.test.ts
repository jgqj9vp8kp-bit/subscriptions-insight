// Access control for clickhouse-cohorts, clickhouse-cohort-membership and
// clickhouse-summary (plan §7, §13, §19, §27; Milestone A; Phase 2 spec §4:
// the scopeReady allowlist, the freshness gate, the cron tick). The restricted
// runners themselves are covered by cohortsScopedReads.test.ts.
//
// The index.ts files import esm.sh (via http.ts) and cannot be loaded here, so
// the coverage is layered like the rest of the access suite:
//   * the policies run through the REAL gate (handleWithAccess) with fake
//     dependencies — fn × action × persona → status / error_code;
//   * the strip helpers (FB allocation diagnostics, identity tokens, snapshot
//     state projection, summary member view) are tested directly;
//   * the Phase 0 runner fixes (tenant-scoped RPC, no cross-tenant support
//     count, ScopeViolation rethrow at the best-effort catch sites);
//   * static checks that every index.ts is a thin serveWithAccess wrapper.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  assertValidPolicy,
  handleWithAccess,
  type AccessGateDeps,
  type AccessRequest,
  type FunctionPolicy,
} from "../../supabase/functions/_shared/access/gate.ts";
import { ACCESS_ERROR, ActionNormalizeError } from "../../supabase/functions/_shared/access/errors.ts";
import {
  buildAccessContext,
  parseResolveAccessRow,
  type AccessContext,
} from "../../supabase/functions/_shared/access/accessContext.ts";
import { isKnownPermission } from "../../supabase/functions/_shared/access/permissions.ts";
import { createScopedReader, ScopeViolation } from "../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import type { ScopeSql } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { CAMPAIGN_SCOPE_VERSION, type CohortSnapshotState } from "../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import {
  CLICKHOUSE_COHORTS_POLICY,
  COHORT_LIST_VIEW_PERMISSIONS,
  canServeFbAllocationDiagnostics,
  cohortDetailedErrorsVisible,
  cohortIdentitiesVisible,
  cohortIdentityHashLabel,
  cohortsErrorResponse,
  normalizeClickHouseCohortsAction,
} from "../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import {
  CLICKHOUSE_COHORT_MEMBERSHIP_POLICY,
  CohortMembershipActionError,
  cohortMembershipErrorResponse,
  legacyMembershipAction,
  normalizeClickHouseCohortMembershipAction,
  projectSnapshotStateForViewer,
  snapshotStateDetailVisible,
} from "../../supabase/functions/_shared/access/policies/clickhouse-cohort-membership.ts";
import {
  CLICKHOUSE_SUMMARY_POLICY,
  WAREHOUSE_PROBE_VIEW_PERMISSIONS,
  normalizeClickHouseSummaryAction,
  summaryKpisVisible,
  summaryVersionHashLabel,
} from "../../supabase/functions/_shared/access/policies/clickhouse-summary.ts";
import {
  activeSubscriptionsByEmail,
  createKeyedHasher,
  pseudonymizeActiveIdentities,
} from "../../supabase/functions/_shared/clickhouse/cohortSubscriptions.ts";
import {
  CohortRequestError,
  PRICE_BREAKDOWN_FAILED,
  runCohortDetails,
  runCohortList,
  subscriptionDataStatus,
  supportDataStatus,
} from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import {
  COHORT_CLASSIFICATION_VERSION,
  runMaterializedCohortList,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import {
  getCohortSnapshotStateRow,
  getSupportSyncState,
  getTransactionSyncState,
  memberWarehouseSummary,
} from "../../supabase/functions/_shared/clickhouse/summary.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import { ROUTE_ACCESS } from "@/services/accessRoutes";

const DATA_KEY = "11111111-1111-4111-8111-111111111111";
const EMPLOYEE = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const MEMBER = "44444444-4444-4444-8444-444444444444";

// ---- personas ------------------------------------------------------------------

type Scope = "all" | "selected" | "none";

interface Persona {
  userId: string;
  permissions: string[];
  scope: Scope;
  isOwner?: boolean;
}

const VIEWER_PERMS = ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"];

const PERSONAS = {
  owner: { userId: DATA_KEY, permissions: [], scope: "all", isOwner: true },
  viewer: { userId: EMPLOYEE, permissions: VIEWER_PERMS, scope: "all" },
  reportsOnly: { userId: EMPLOYEE, permissions: ["reports.view"], scope: "all" },
  forecastOnly: { userId: EMPLOYEE, permissions: ["forecasting.view"], scope: "all" },
  dashboardOnly: { userId: EMPLOYEE, permissions: ["dashboard.view"], scope: "all" },
  warehouseAdmin: { userId: EMPLOYEE, permissions: ["admin.warehouse.manage"], scope: "all" },
  diagnosticsAdmin: { userId: EMPLOYEE, permissions: ["cohorts.view", "admin.diagnostics.view"], scope: "all" },
  restrictedViewer: { userId: EMPLOYEE, permissions: VIEWER_PERMS, scope: "selected" },
  noScopeViewer: { userId: EMPLOYEE, permissions: VIEWER_PERMS, scope: "none" },
  restrictedAdmin: {
    userId: EMPLOYEE,
    permissions: [...VIEWER_PERMS, "forecasting.view", "admin.warehouse.manage", "admin.diagnostics.view"],
    scope: "selected",
  },
} satisfies Record<string, Persona>;

type PersonaName = keyof typeof PERSONAS;

function accessRow(persona: Persona) {
  return {
    status: "ok",
    workspace_id: WORKSPACE,
    data_key: DATA_KEY,
    member_id: MEMBER,
    user_id: persona.userId,
    email: "member@example.com",
    display_name: "Member",
    is_data_owner: persona.userId === DATA_KEY,
    raw_access: persona.userId === DATA_KEY,
    role: { id: "role-1", key: persona.isOwner ? "owner" : "custom", name: "Role", is_owner: Boolean(persona.isOwner), permissions: persona.permissions },
    funnel_scope: {
      mode: persona.scope,
      funnel_ids: persona.scope === "selected" ? ["f1"] : [],
      paths: persona.scope === "selected" ? ["soulmate"] : [],
    },
    access_version: "3",
    partition: "partition-hash",
  };
}

function contextFor(name: PersonaName): AccessContext {
  const persona = PERSONAS[name];
  const row = parseResolveAccessRow(accessRow(persona));
  if (!row) throw new Error("fixture row did not parse");
  return buildAccessContext(row, { kind: "user", userId: persona.userId, email: "member@example.com" }, "req-test");
}

const NOW = new Date("2026-10-06T12:00:00.000Z");
const CRON_SECRET = "cron-secret-value";
const PASS = { status: "PASS", duplicate_users: 0 };

/** A fresh, validated cohort snapshot (the Phase 2 freshness gate admits it). */
function readySnapshotState(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  return {
    auth_user_id: DATA_KEY,
    snapshot_name: "fact_user_cohorts",
    status: "completed",
    active_warehouse_version: "wh_live",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-06T09:00:00.000Z",
    building_warehouse_version: null,
    building_classification_version: null,
    started_at: null,
    finished_at: "2026-10-06T09:00:00.000Z",
    duration_ms: 1,
    users_classified: 5,
    rows_inserted: 5,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: 50,
    source_unique_users: 5,
    last_error: null,
    diagnostics: { validation: PASS },
    active_validation: PASS,
    active_validated_at: "2026-10-06T09:00:00.000Z",
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
    fresh_verified_at: "2026-10-06T11:52:00.000Z",
    stale_since: null,
    ...overrides,
  };
}

function gateDeps(name: PersonaName, snapshotState: CohortSnapshotState | null = readySnapshotState()): AccessGateDeps {
  const persona = PERSONAS[name];
  const raw: ClickHouseClientLike = {
    query: async () => ({ json: async () => [] }),
    command: async () => undefined,
    insert: async () => undefined,
  };
  return {
    configError: null,
    pg: { from: vi.fn(), rpc: vi.fn(), auth: { getUser: vi.fn() } } as unknown as AccessGateDeps["pg"],
    getUser: async () => ({ data: { user: { id: persona.userId, email: "member@example.com" } }, error: null }),
    loadAccess: async () => ({ data: accessRow(persona), error: null }),
    workspaceDataKey: async () => ({ data: DATA_KEY, error: null }),
    readEnv: (envName) => (envName === "FB_CRON_SECRET" ? CRON_SECRET : undefined),
    createClickHouse: (ctx) => createScopedReader(ctx, raw),
    newRequestId: () => "req-test",
    log: () => undefined,
    loadCohortSnapshotState: vi.fn(async () => snapshotState),
    now: () => NOW,
  };
}

async function call<A extends string>(
  policy: FunctionPolicy<A>,
  persona: PersonaName,
  body: unknown,
  method = "POST",
  snapshotState?: CohortSnapshotState | null,
): Promise<{ status: number; body: Record<string, unknown>; action: string | null; scope: ScopeSql | null }> {
  let seen: string | null = null;
  let scope: ScopeSql | null = null;
  const handler = async (request: AccessRequest<A>) => {
    seen = request.action;
    scope = request.scope;
    return { ok: true, action: request.action };
  };
  const req = new Request(`https://edge.test/functions/v1/${policy.fn}`, {
    method,
    headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(body),
  });
  const response = await handleWithAccess(req, policy, handler, gateDeps(persona, snapshotState));
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, action: seen, scope };
}

// ---- policies ------------------------------------------------------------------------

const POLICIES = [CLICKHOUSE_COHORTS_POLICY, CLICKHOUSE_COHORT_MEMBERSHIP_POLICY, CLICKHOUSE_SUMMARY_POLICY] as Array<FunctionPolicy<string>>;

/** Phase 2 (spec §6 contract 2): the scopeReady actions of these three functions
 * and the snapshot each needs (null = scopeReady without a snapshot). */
const SCOPE_READY: Record<string, Record<string, "cohort" | "campaign" | null>> = {
  "clickhouse-cohorts": { list: "cohort", details: "cohort", options: "cohort" },
  "clickhouse-cohort-membership": {},
  "clickhouse-summary": { summary: null },
};

describe("policy tables", () => {
  it.each(POLICIES.map((policy) => [policy.fn, policy] as const))("%s is a valid, closed policy", (_fn, policy) => {
    expect(() => assertValidPolicy(policy)).not.toThrow();
    const ready: Record<string, "cohort" | "campaign" | null> = {};
    for (const [action, rule] of Object.entries(policy.actions)) {
      if (rule.scopeReady) ready[action] = rule.scopeSnapshot ?? null;
      // No action is open to "any active member".
      const keys = [...(rule.anyOf ?? []), ...(rule.allOf ?? []), ...(rule.restrictedAnyOf ?? [])];
      expect(keys.length || rule.rawOnly || rule.ownerOnly, `${policy.fn}.${action}`).toBeTruthy();
      for (const key of keys) expect(isKnownPermission(key), key).toBe(true);
    }
    // Exactly the allowlist — list_fb_allocation_diagnostics and every
    // membership action (cron_tick included) are never scopeReady.
    expect(ready).toEqual(SCOPE_READY[policy.fn]);
    if (policy.fn === "clickhouse-cohort-membership") {
      expect(policy.cron).toEqual({ header: "x-cron-secret", secretEnv: "FB_CRON_SECRET", actions: ["cron_tick"] });
    } else {
      expect(policy.cron).toBeUndefined();
    }
  });

  it("restricted members need cohorts.view itself for list; cron_tick is the scheduler's only", () => {
    expect(CLICKHOUSE_COHORTS_POLICY.actions.list.restrictedAnyOf).toEqual(["cohorts.view"]);
    expect(CLICKHOUSE_COHORT_MEMBERSHIP_POLICY.actions.cron_tick).toEqual({ ownerOnly: true, rawOnly: true, allOf: ["admin.warehouse.manage"], write: true });
  });

  it("list is open to exactly the pages that render cohort rows (agrees with ROUTE_ACCESS)", () => {
    const pageKeys = ["/cohorts", "/reports", "/forecasting"].flatMap((path) => ROUTE_ACCESS.find((rule) => rule.path === path)?.anyOf ?? []);
    expect([...COHORT_LIST_VIEW_PERMISSIONS].sort()).toEqual([...new Set(pageKeys)].sort());
    expect(CLICKHOUSE_COHORTS_POLICY.actions.list.anyOf).toEqual([...COHORT_LIST_VIEW_PERMISSIONS]);
  });

  it("the warehouse probe is open to the pages that run it, never to Reports / Forecasting only", () => {
    expect(WAREHOUSE_PROBE_VIEW_PERMISSIONS).toEqual(expect.arrayContaining([
      "dashboard.view", "cohorts.view", "users.view", "payment_pass.view", "payment_pass.banks.view",
      "facebook_analytics.view", "support.view", "admin.integrations.view", "admin.data.import",
    ]));
    expect(WAREHOUSE_PROBE_VIEW_PERMISSIONS).not.toContain("reports.view");
    expect(WAREHOUSE_PROBE_VIEW_PERMISSIONS).not.toContain("admin.diagnostics.view");
  });
});

describe("canonical action normalizers", () => {
  const input = (body: Record<string, unknown>) => ({ method: "POST", body, url: new URL("https://edge.test/fn") });

  it("clickhouse-cohorts: aliases, the diagnostics flag, and no silent default", () => {
    expect(normalizeClickHouseCohortsAction(input({ action: "list" }))).toBe("list");
    expect(normalizeClickHouseCohortsAction(input({ action: "cohorts" }))).toBe("list");
    expect(normalizeClickHouseCohortsAction(input({ action: "list", fb_allocation_diagnostics: { page: 1 } }))).toBe("list_fb_allocation_diagnostics");
    expect(normalizeClickHouseCohortsAction(input({ action: "cohorts", fb_allocation_diagnostics: {} }))).toBe("list_fb_allocation_diagnostics");
    expect(normalizeClickHouseCohortsAction(input({ action: "list", fb_allocation_diagnostics: null }))).toBe("list");
    expect(normalizeClickHouseCohortsAction(input({ action: "details" }))).toBe("details");
    expect(normalizeClickHouseCohortsAction(input({ action: "cohort_details", fb_allocation_diagnostics: {} }))).toBe("details");
    expect(normalizeClickHouseCohortsAction(input({ action: "options" }))).toBe("options");
    expect(normalizeClickHouseCohortsAction(input({ action: "filter_options" }))).toBe("options");
    for (const body of [{}, { action: null }, { action: "drop_table" }, { action: ["list"] }, { action: "LIST" }]) {
      expect(() => normalizeClickHouseCohortsAction(input(body))).toThrow(ActionNormalizeError);
    }
  });

  it("clickhouse-cohort-membership: force is its own action; the legacy status fall-through is gone", () => {
    expect(normalizeClickHouseCohortMembershipAction(input({ action: "status" }))).toBe("status");
    expect(normalizeClickHouseCohortMembershipAction(input({ action: "validate" }))).toBe("validate");
    expect(normalizeClickHouseCohortMembershipAction(input({ action: "rebuild" }))).toBe("rebuild");
    expect(normalizeClickHouseCohortMembershipAction(input({ action: "rebuild", force: false }))).toBe("rebuild");
    expect(normalizeClickHouseCohortMembershipAction(input({ action: "rebuild", force: true }))).toBe("rebuild_force");
    expect(normalizeClickHouseCohortMembershipAction(input({ action: "rebuild", force: "yes" }))).toBe("rebuild_force");
    for (const body of [{}, { action: "rebuild_force" }, { action: "drop" }, { force: true }, { action: "cron_tick" }]) {
      expect(() => normalizeClickHouseCohortMembershipAction(input(body))).toThrow(ActionNormalizeError);
    }
  });

  it("clickhouse-cohort-membership: the cron branch runs the tick and nothing else", () => {
    const cron = (body: Record<string, unknown>) => ({ ...input(body), cron: true });
    expect(normalizeClickHouseCohortMembershipAction(cron({}))).toBe("cron_tick");
    expect(normalizeClickHouseCohortMembershipAction(cron({ action: null }))).toBe("cron_tick");
    expect(normalizeClickHouseCohortMembershipAction(cron({ action: "cron_tick", auth_user_id: DATA_KEY }))).toBe("cron_tick");
    for (const body of [{ action: "rebuild" }, { action: "rebuild", force: true }, { action: "status" }, { action: "validate" }, { action: "tick" }]) {
      expect(() => normalizeClickHouseCohortMembershipAction(cron(body))).toThrow(ActionNormalizeError);
    }
    expect(legacyMembershipAction("cron_tick")).toBe("cron_tick");
  });

  it("clickhouse-summary: the frontend's empty body maps explicitly to summary", () => {
    expect(normalizeClickHouseSummaryAction(input({}))).toBe("summary");
    expect(normalizeClickHouseSummaryAction(input({ action: null }))).toBe("summary");
    expect(normalizeClickHouseSummaryAction(input({ action: "summary" }))).toBe("summary");
    for (const body of [{ action: "kpis" }, { action: "" }, { action: 1 }]) {
      expect(() => normalizeClickHouseSummaryAction(input(body))).toThrow(ActionNormalizeError);
    }
  });
});

// fn × request × persona → [status, error_code | canonical action]
type Expect = [number, string];
const OK = (action: string): Expect => [200, action];
const DENY = (code: string): Expect => [403, code];

const MATRIX: Array<{ policy: FunctionPolicy<string>; label: string; body: Record<string, unknown>; expect: Partial<Record<PersonaName, Expect>> }> = [
  {
    policy: CLICKHOUSE_COHORTS_POLICY as FunctionPolicy<string>,
    label: "cohorts list",
    body: { action: "list" },
    expect: {
      owner: OK("list"), viewer: OK("list"), reportsOnly: OK("list"), forecastOnly: OK("list"),
      dashboardOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED), warehouseAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      // Phase 2: scopeReady behind the freshness gate (a ready snapshot here).
      restrictedViewer: OK("list"), noScopeViewer: OK("list"), restrictedAdmin: OK("list"),
    },
  },
  {
    policy: CLICKHOUSE_COHORTS_POLICY as FunctionPolicy<string>,
    label: "cohorts list + fb_allocation_diagnostics",
    body: { action: "list", fb_allocation_diagnostics: { page: 1 } },
    expect: {
      owner: OK("list_fb_allocation_diagnostics"), viewer: OK("list_fb_allocation_diagnostics"),
      diagnosticsAdmin: OK("list_fb_allocation_diagnostics"),
      dashboardOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      restrictedViewer: DENY(ACCESS_ERROR.SCOPE_NOT_SUPPORTED), noScopeViewer: DENY(ACCESS_ERROR.SCOPE_NOT_SUPPORTED),
    },
  },
  {
    policy: CLICKHOUSE_COHORTS_POLICY as FunctionPolicy<string>,
    label: "cohorts details",
    body: { action: "details", cohort_key: { cohort_date: "2026-07-01", funnel: "f", campaign_path: "p" } },
    expect: {
      owner: OK("details"), viewer: OK("details"),
      reportsOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED), forecastOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      restrictedViewer: OK("details"), noScopeViewer: OK("details"),
    },
  },
  {
    policy: CLICKHOUSE_COHORTS_POLICY as FunctionPolicy<string>,
    label: "cohorts options",
    body: { action: "filter_options" },
    expect: {
      owner: OK("options"), viewer: OK("options"), forecastOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      restrictedViewer: OK("options"),
    },
  },
  {
    policy: CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>,
    label: "membership status",
    body: { action: "status" },
    expect: {
      owner: OK("status"), viewer: OK("status"), diagnosticsAdmin: OK("status"),
      dashboardOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED), warehouseAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      restrictedViewer: DENY(ACCESS_ERROR.SCOPE_NOT_SUPPORTED), noScopeViewer: DENY(ACCESS_ERROR.SCOPE_NOT_SUPPORTED),
    },
  },
  {
    policy: CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>,
    label: "membership rebuild",
    body: { action: "rebuild" },
    expect: {
      owner: OK("rebuild"), warehouseAdmin: OK("rebuild"),
      viewer: DENY(ACCESS_ERROR.PERMISSION_DENIED), diagnosticsAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      restrictedViewer: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      // admin.* is never effective under a restricted scope, so it fails on the permission first.
      restrictedAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
    },
  },
  {
    policy: CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>,
    label: "membership forced rebuild",
    body: { action: "rebuild", force: true },
    expect: {
      owner: OK("rebuild_force"), warehouseAdmin: OK("rebuild_force"),
      viewer: DENY(ACCESS_ERROR.PERMISSION_DENIED), restrictedAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
    },
  },
  {
    policy: CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>,
    label: "membership validate",
    body: { action: "validate" },
    expect: {
      owner: OK("validate"), warehouseAdmin: OK("validate"),
      viewer: DENY(ACCESS_ERROR.PERMISSION_DENIED), restrictedAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
    },
  },
  {
    policy: CLICKHOUSE_SUMMARY_POLICY as FunctionPolicy<string>,
    label: "summary probe",
    body: {},
    expect: {
      owner: OK("summary"), viewer: OK("summary"), dashboardOnly: OK("summary"), diagnosticsAdmin: OK("summary"),
      reportsOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED), forecastOnly: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      warehouseAdmin: DENY(ACCESS_ERROR.PERMISSION_DENIED),
      // Phase 2: scopeReady without a snapshot (the member view makes no ClickHouse call).
      restrictedViewer: OK("summary"), noScopeViewer: OK("summary"), restrictedAdmin: OK("summary"),
    },
  },
];

describe("gate matrix (real handleWithAccess, fake dependencies)", () => {
  const cases = MATRIX.flatMap((row) =>
    Object.entries(row.expect).map(([persona, expected]) => [row.label, persona as PersonaName, row, expected as Expect] as const));

  it.each(cases)("%s as %s", async (_label, persona, row, [status, codeOrAction]) => {
    const result = await call(row.policy, persona, row.body);
    expect(result.status).toBe(status);
    if (status === 200) {
      expect(result.action).toBe(codeOrAction);
    } else {
      expect(result.body.error_code).toBe(codeOrAction);
      expect(result.action).toBeNull();
    }
  });

  const COHORTS = CLICKHOUSE_COHORTS_POLICY as FunctionPolicy<string>;
  const MEMBERSHIP = CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>;
  const SUMMARY = CLICKHOUSE_SUMMARY_POLICY as FunctionPolicy<string>;
  const RESTRICTED_PERSONAS = ["restrictedViewer", "noScopeViewer", "restrictedAdmin"] as const;

  it("restricted contexts: every non-scopeReady action is refused (403) before the handler", async () => {
    const bodies: Array<[FunctionPolicy<string>, Record<string, unknown>]> = [
      [COHORTS, { action: "list", fb_allocation_diagnostics: {} }],
      [MEMBERSHIP, { action: "status" }],
      [MEMBERSHIP, { action: "rebuild" }],
      [MEMBERSHIP, { action: "rebuild", force: true }],
      [MEMBERSHIP, { action: "validate" }],
    ];
    for (const persona of RESTRICTED_PERSONAS) {
      for (const [policy, body] of bodies) {
        const result = await call(policy, persona, body);
        expect(result.status, `${policy.fn} ${JSON.stringify(body)} as ${persona}`).toBe(403);
        expect([ACCESS_ERROR.SCOPE_NOT_SUPPORTED, ACCESS_ERROR.PERMISSION_DENIED]).toContain(result.body.error_code);
        expect(result.action).toBeNull();
      }
    }
  });

  it("restricted contexts: the scopeReady actions reach the handler with a restricted scope (snapshot only where required)", async () => {
    const bodies: Array<[FunctionPolicy<string>, Record<string, unknown>, string, boolean]> = [
      [COHORTS, { action: "list" }, "list", true],
      [COHORTS, { action: "details", cohort_key: { cohort_date: "2026-07-01", funnel: "f", campaign_path: "soulmate" } }, "details", true],
      [COHORTS, { action: "options" }, "options", true],
      [SUMMARY, {}, "summary", false],
    ];
    for (const persona of RESTRICTED_PERSONAS) {
      for (const [policy, body, action, needsSnapshot] of bodies) {
        const result = await call(policy, persona, body);
        expect(result.status, `${policy.fn} ${JSON.stringify(body)} as ${persona}`).toBe(200);
        expect(result.action).toBe(action);
        expect(result.scope?.restricted).toBe(true);
        expect(Boolean(result.scope?.snapshot), `${policy.fn}.${action}`).toBe(needsSnapshot);
      }
    }
    // Scope all keeps ALL_SCOPE_SQL.
    expect((await call(COHORTS, "viewer", { action: "list" })).scope?.restricted).toBe(false);
  });

  it("restricted contexts without a fresh, validated snapshot: 409 on the cohorts reads; the probe still answers", async () => {
    for (const state of [null, readySnapshotState({ fresh_verified_at: "2026-10-06T05:00:00.000Z" }), readySnapshotState({ active_validation: { status: "FAIL" } })]) {
      for (const body of [{ action: "list" }, { action: "details" }, { action: "options" }]) {
        const result = await call(COHORTS, "restrictedViewer", body, "POST", state);
        expect(result.status, JSON.stringify(body)).toBe(409);
        expect(result.body.error_code).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
        expect(result.action).toBeNull();
      }
      expect((await call(SUMMARY, "restrictedViewer", {}, "POST", state)).status).toBe(200);
    }
    // Scope all never consults the snapshot state.
    expect((await call(COHORTS, "viewer", { action: "list" }, "POST", null)).status).toBe(200);
  });

  it("rejects missing / unknown actions with 400 before resolving access", async () => {
    for (const [policy, body] of [
      [CLICKHOUSE_COHORTS_POLICY, {}],
      [CLICKHOUSE_COHORTS_POLICY, { action: "bundle" }],
      [CLICKHOUSE_COHORT_MEMBERSHIP_POLICY, {}],
      [CLICKHOUSE_COHORT_MEMBERSHIP_POLICY, { action: "repair" }],
      [CLICKHOUSE_SUMMARY_POLICY, { action: "kpis" }],
    ] as Array<[FunctionPolicy<string>, Record<string, unknown>]>) {
      const result = await call(policy, "owner", body);
      expect(result.status, `${policy.fn} ${JSON.stringify(body)}`).toBe(400);
      expect(result.body.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });

  it("methods: the probe keeps GET; cohorts and membership are POST-only", async () => {
    expect((await call(CLICKHOUSE_SUMMARY_POLICY as FunctionPolicy<string>, "viewer", null, "GET")).status).toBe(200);
    expect((await call(CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>, "viewer", null, "GET")).status).toBe(405);
    expect((await call(CLICKHOUSE_COHORTS_POLICY as FunctionPolicy<string>, "viewer", null, "GET")).status).toBe(405);
  });
});

describe("clickhouse-cohort-membership cron_tick (the freshness cron)", () => {
  const MEMBERSHIP = CLICKHOUSE_COHORT_MEMBERSHIP_POLICY as FunctionPolicy<string>;
  const cronCall = async (headers: Record<string, string>, body: unknown) => {
    let seen: { action: string; actor: string; restricted: boolean; tenant: string } | null = null;
    const handler = async (request: AccessRequest<string>) => {
      seen = { action: request.action, actor: request.ctx.actor.kind, restricted: request.scope.restricted, tenant: request.ctx.tenantKey };
      return { ok: true };
    };
    const req = new Request("https://edge.test/functions/v1/clickhouse-cohort-membership", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const response = await handleWithAccess(req, MEMBERSHIP, handler, gateDeps("owner"));
    return { status: response.status, body: (await response.json()) as Record<string, unknown>, seen };
  };

  it("the secret-authenticated tick reaches cron_tick for the workspace tenant, with the all scope", async () => {
    for (const body of [{}, { action: "cron_tick" }, { auth_user_id: DATA_KEY, action: "cron_tick" }]) {
      const result = await cronCall({ "x-cron-secret": CRON_SECRET }, body);
      expect(result.status, JSON.stringify(body)).toBe(200);
      expect(result.seen).toEqual({ action: "cron_tick", actor: "cron", restricted: false, tenant: DATA_KEY });
    }
  });

  it("a wrong secret is 401; the cron can name nothing else; a user can never name cron_tick", async () => {
    expect((await cronCall({ "x-cron-secret": "wrong" }, {})).status).toBe(401);
    expect((await cronCall({ "x-cron-secret": CRON_SECRET }, { auth_user_id: EMPLOYEE })).status).toBe(400);
    for (const body of [{ action: "rebuild", force: true }, { action: "validate" }, { action: "status" }]) {
      const other = await cronCall({ "x-cron-secret": CRON_SECRET }, body);
      expect(other.status, JSON.stringify(body)).toBe(400);
      expect(other.seen).toBeNull();
    }
    for (const persona of ["owner", "warehouseAdmin"] as const) {
      const user = await call(MEMBERSHIP, persona, { action: "cron_tick" });
      expect(user.status).toBe(400);
      expect(user.body.error_code).toBe(ACCESS_ERROR.UNKNOWN_ACTION);
    }
  });

  it("index.ts: an unforced tick-mode rebuild whose body is only the tick outcome; a held lease is in_progress", () => {
    const source = readFileSync("supabase/functions/clickhouse-cohort-membership/index.ts", "utf8");
    expect(source).toMatch(/if \(action === "cron_tick"\) \{[\s\S]*?rebuildCohortMembership\(\{[\s\S]*?force: false,\s*mode: "tick",[\s\S]*?\}\)/);
    expect(source).toContain('return { ok: true, action: "cron_tick", tick_status: result.tick_status, campaign_scope: result.campaign_scope };');
    expect(source).toContain('if (error instanceof CohortRebuildBusyError) return { ok: true, action: "cron_tick", tick_status: "in_progress" };');
  });
});

// ---- strip helpers ------------------------------------------------------------------

describe("FB allocation diagnostics are stripped without admin.diagnostics.view", () => {
  it("only the data owner and diagnostics holders get the payload", () => {
    expect(canServeFbAllocationDiagnostics(contextFor("owner"))).toBe(true);
    expect(canServeFbAllocationDiagnostics(contextFor("diagnosticsAdmin"))).toBe(true);
    expect(canServeFbAllocationDiagnostics(contextFor("viewer"))).toBe(false);
    expect(canServeFbAllocationDiagnostics(contextFor("warehouseAdmin"))).toBe(false);
    // Granted but not effective under a restricted scope (admin.* needs scope all).
    expect(canServeFbAllocationDiagnostics(contextFor("restrictedAdmin"))).toBe(false);
  });

  it("the index ANDs the permission into the env flag", () => {
    const source = readFileSync("supabase/functions/clickhouse-cohorts/index.ts", "utf8");
    expect(source).toMatch(/allocationDiagnosticsEnabled: fbAllocationDiagnosticsFeatureEnabled\([\s\S]*?\) && canServeFbAllocationDiagnostics\(ctx\)/);
  });
});

describe("details: warehouse error text inside a 200 body (T19)", () => {
  it("is the data owner's only; index.ts passes the decision to runCohortDetails", () => {
    expect(cohortDetailedErrorsVisible(contextFor("owner"))).toBe(true);
    expect(cohortDetailedErrorsVisible(contextFor("viewer"))).toBe(false);
    expect(cohortDetailedErrorsVisible(contextFor("diagnosticsAdmin"))).toBe(false);
    const source = readFileSync("supabase/functions/clickhouse-cohorts/index.ts", "utf8");
    expect(source).toMatch(/runCohortDetails\(\{[^}]*detailedErrors: cohortDetailedErrorsVisible\(ctx\)[^}]*\}\)/);
  });

  it("an employee's details body never carries ClickHouse exception text", async () => {
    const failingPlan: ClickHouseClientLike = {
      query: vi.fn(async ({ query }: { query: string }) => {
        if (query.includes("plankey")) throw new Error("ClickHouse HTTP 500: Code: 241. DB::Exception: Memory limit exceeded (user default)");
        return { json: async () => [] };
      }),
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
    } as unknown as ClickHouseClientLike;
    const request = { action: "details", cohort_key: { cohort_date: "2026-07-01", funnel: "palm", campaign_path: "palm" } } as never;
    const employee = await runCohortDetails({ authUserId: DATA_KEY, clickhouse: failingPlan, request, detailedErrors: cohortDetailedErrorsVisible(contextFor("viewer")) });
    expect(employee.error).toBe(PRICE_BREAKDOWN_FAILED);
    expect(JSON.stringify(employee)).not.toMatch(/ClickHouse HTTP|DB::Exception/);
    const owner = await runCohortDetails({ authUserId: DATA_KEY, clickhouse: failingPlan, request, detailedErrors: cohortDetailedErrorsVisible(contextFor("owner")) });
    expect(owner.error).toContain("DB::Exception");
  });
});

describe("cohort identity tokens (active_user_ids are customer emails)", () => {
  const secret = "test-service-role-key";

  it("raw identities are for the data owner only", () => {
    expect(cohortIdentitiesVisible(contextFor("owner"))).toBe(true);
    expect(cohortIdentitiesVisible(contextFor("viewer"))).toBe(false);
    expect(cohortIdentitiesVisible(contextFor("diagnosticsAdmin"))).toBe(false);
  });

  it("replaces emails and subscription ids with stable keyed tokens, keeping every union exact", async () => {
    const rows = [
      { cohort_date: "2026-07-01", active_users: 2, active_subscriptions: 3, active_user_ids: ["a@x.com", "b@x.com"], active_subscription_ids: ["s1", "s2", "s3"] },
      { cohort_date: "2026-07-02", active_users: 2, active_subscriptions: 2, active_user_ids: ["b@x.com", "c@x.com"], active_subscription_ids: ["s3", "s4"] },
      { cohort_date: "2026-07-03", active_users: 0, active_subscriptions: 0 },
    ];
    const before = JSON.parse(JSON.stringify(rows)) as typeof rows;
    await pseudonymizeActiveIdentities(rows, await createKeyedHasher(secret, cohortIdentityHashLabel(DATA_KEY)));

    const serialized = JSON.stringify(rows);
    for (const raw of ["a@x.com", "b@x.com", "c@x.com", "\"s1\"", "\"s4\""]) expect(serialized).not.toContain(raw);
    expect(rows[0].active_user_ids?.every((id) => /^u_[0-9a-f]{32}$/.test(id))).toBe(true);
    expect(rows[0].active_subscription_ids?.every((id) => /^s_[0-9a-f]{32}$/.test(id))).toBe(true);
    // Same identity → same token across rows, so the total row's union is unchanged.
    expect(rows[1].active_user_ids?.[0]).toBe(rows[0].active_user_ids?.[1]);
    expect(rows[1].active_subscription_ids?.[0]).toBe(rows[0].active_subscription_ids?.[2]);
    const unionUsers = new Set(rows.flatMap((row) => row.active_user_ids ?? []));
    const rawUnionUsers = new Set(before.flatMap((row) => row.active_user_ids ?? []));
    expect(unionUsers.size).toBe(rawUnionUsers.size);
    expect(new Set(rows.flatMap((row) => row.active_subscription_ids ?? [])).size).toBe(4);
    // Counts untouched; rows without identities stay without them.
    expect(rows.map((row) => [row.active_users, row.active_subscriptions])).toEqual(before.map((row) => [row.active_users, row.active_subscriptions]));
    expect(rows[2]).toEqual(before[2]);
  });

  it("tokens depend on the key and the label (not a bare hash of the email)", async () => {
    const tokenFor = async (key: string, label: string) => {
      const rows = [{ active_user_ids: ["a@x.com"] }];
      await pseudonymizeActiveIdentities(rows, await createKeyedHasher(key, label));
      return rows[0].active_user_ids[0];
    };
    const base = await tokenFor(secret, cohortIdentityHashLabel(DATA_KEY));
    expect(await tokenFor(secret, cohortIdentityHashLabel(DATA_KEY))).toBe(base);
    expect(await tokenFor("other-key", cohortIdentityHashLabel(DATA_KEY))).not.toBe(base);
    expect(await tokenFor(secret, cohortIdentityHashLabel(EMPLOYEE))).not.toBe(base);
    await expect(createKeyedHasher("", "label")).rejects.toThrow();
  });
});

describe("cohort snapshot state for viewers", () => {
  const state = {
    auth_user_id: DATA_KEY,
    snapshot_name: "fact_user_cohorts",
    status: "completed",
    active_warehouse_version: "wh_abc",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-01T00:00:00Z",
    building_warehouse_version: null,
    building_classification_version: null,
    build_token: "secret-build-token",
    lease_expires_at: "2026-10-01T00:05:00Z",
    started_at: "2026-10-01T00:00:00Z",
    finished_at: "2026-10-01T00:01:00Z",
    duration_ms: 60_000,
    users_classified: 7_145,
    rows_inserted: 7_145,
    duplicate_users: 0,
    removed_or_invalidated: 3,
    source_transactions: 28_885,
    source_unique_users: 10_031,
    last_error: "ClickHouse HTTP 500: SELECT ... FROM analytics_transactions",
    diagnostics: { warehouse: { transaction_count: 28_885, unique_users: 10_031 }, validation: { status: "PASS" } },
    updated_at: "2026-10-01T00:01:00Z",
  };

  it("keeps lifecycle and versions, drops the data key, totals, error text, diagnostics and the CAS token", () => {
    const projected = projectSnapshotStateForViewer(state)!;
    expect(projected).toEqual({
      snapshot_name: "fact_user_cohorts",
      status: "completed",
      active_warehouse_version: "wh_abc",
      active_classification_version: COHORT_CLASSIFICATION_VERSION,
      active_generated_at: "2026-10-01T00:00:00Z",
      building_warehouse_version: null,
      building_classification_version: null,
      started_at: "2026-10-01T00:00:00Z",
      finished_at: "2026-10-01T00:01:00Z",
      duration_ms: 60_000,
      updated_at: "2026-10-01T00:01:00Z",
    });
    const serialized = JSON.stringify(projected);
    for (const hidden of [DATA_KEY, "secret-build-token", "28885", "10031", "7145", "analytics_transactions"]) {
      expect(serialized).not.toContain(hidden);
    }
    expect(projectSnapshotStateForViewer(null)).toBeNull();
  });

  it("full detail for the data owner and warehouse / diagnostics admins only", () => {
    expect(snapshotStateDetailVisible(contextFor("owner"))).toBe(true);
    expect(snapshotStateDetailVisible(contextFor("warehouseAdmin"))).toBe(true);
    expect(snapshotStateDetailVisible(contextFor("diagnosticsAdmin"))).toBe(true);
    expect(snapshotStateDetailVisible(contextFor("viewer"))).toBe(false);
  });

  it("rebuilds today's error body and response action name", () => {
    expect(legacyMembershipAction("rebuild_force")).toBe("rebuild");
    expect(legacyMembershipAction("status")).toBe("status");
    expect(cohortMembershipErrorResponse(new CohortMembershipActionError("rebuild", new Error("A cohort snapshot rebuild is already in progress for this account.")))).toEqual({
      status: 502,
      body: { ok: false, action: "rebuild", error: "A cohort snapshot rebuild is already in progress for this account." },
    });
    expect(cohortMembershipErrorResponse(new CohortMembershipActionError("status", "boom"))).toEqual({
      status: 502,
      body: { ok: false, action: "status", error: "ClickHouse cohort membership action failed." },
    });
    expect(cohortMembershipErrorResponse(new Error("unwrapped"))).toBeNull();
  });
});

describe("clickhouse-cohorts error mapping (owner sees today's body)", () => {
  it("validation faults are 400, warehouse faults 502", () => {
    expect(cohortsErrorResponse(new CohortRequestError("Invalid date_from (expected YYYY-MM-DD): x"))).toEqual({
      status: 400,
      body: { ok: false, source: "clickhouse", error: "Invalid date_from (expected YYYY-MM-DD): x" },
    });
    expect(cohortsErrorResponse(new Error("ClickHouse cohort query timed out after 25000ms."))).toEqual({
      status: 502,
      body: { ok: false, source: "clickhouse", error: "ClickHouse cohort query timed out after 25000ms." },
    });
    expect(cohortsErrorResponse("weird")).toEqual({ status: 502, body: { ok: false, source: "clickhouse", error: "ClickHouse cohort query failed." } });
  });

  it("through the gate: the owner keeps the message, an employee gets the generic body", async () => {
    const thrower = async () => { throw new CohortRequestError("Filter funnel must be an array of strings."); };
    const run = async (persona: PersonaName) => {
      const req = new Request("https://edge.test/functions/v1/clickhouse-cohorts", {
        method: "POST",
        headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list" }),
      });
      const response = await handleWithAccess(req, CLICKHOUSE_COHORTS_POLICY, thrower, gateDeps(persona), { onError: cohortsErrorResponse });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    expect(await run("owner")).toEqual({
      status: 400,
      body: { ok: false, source: "clickhouse", error: "Filter funnel must be an array of strings.", request_id: "req-test" },
    });
    expect(await run("viewer")).toEqual({
      status: 400,
      body: { ok: false, error_code: ACCESS_ERROR.REQUEST_FAILED, error: "Request failed.", request_id: "req-test" },
    });
  });
});

// ---- summary ----------------------------------------------------------------------

describe("clickhouse-summary: KPIs stripped, version probe kept", () => {
  const syncState = {
    auth_user_id: DATA_KEY,
    sync_name: "analytics_transactions_backfill",
    status: "completed",
    cursor_transaction_id: "tx_secret_cursor_123",
    cursor_updated_at: "2026-10-04T10:00:00Z",
    clickhouse_total: 29_479,
    source_total: 29_480,
    rows_scanned: 100,
    last_error: "ClickHouse HTTP 400: syntax error",
  };
  const cohortSnapshotState = {
    auth_user_id: DATA_KEY,
    status: "completed",
    active_warehouse_version: "wh_abc",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-04T10:05:00Z",
    users_classified: 7_145,
    source_unique_users: 10_242,
    diagnostics: { warehouse: { unique_users: 10_242 } },
  };
  const supportSyncState = {
    auth_user_id: DATA_KEY,
    sync_name: "fact_support_requests_sync",
    status: "completed",
    cursor_transaction_id: "msg-cursor",
    cursor_updated_at: "2026-10-04T09:00:00Z",
    clickhouse_total: 5_120,
    diagnostics: { attribution: { attribution_version: "v2", funnel_matched: 4_000, unknown: 1_120 } },
  };

  const memberView = async (overrides: { sync?: Record<string, unknown>; support?: Record<string, unknown> } = {}) =>
    memberWarehouseSummary({
      hasher: await createKeyedHasher("test-service-role-key", summaryVersionHashLabel(DATA_KEY)),
      syncState: { ...syncState, ...(overrides.sync ?? {}) },
      cohortSnapshotState,
      supportSyncState: { ...supportSyncState, ...(overrides.support ?? {}) },
    });

  it("decides the view by raw access or admin.diagnostics.view", () => {
    expect(summaryKpisVisible(contextFor("owner"))).toBe(true);
    expect(summaryKpisVisible(contextFor("diagnosticsAdmin"))).toBe(true);
    expect(summaryKpisVisible(contextFor("viewer"))).toBe(false);
    expect(summaryKpisVisible(contextFor("warehouseAdmin"))).toBe(false);
  });

  it("the member view carries only lifecycle, timestamps and opaque versions", async () => {
    const view = await memberView();
    expect(view.redacted).toBe(true);
    expect(Object.keys(view).sort()).toEqual(["cohort_snapshot_state", "redacted", "support_sync_state", "sync_state"]);
    expect(view.sync_state).toEqual({ status: "completed", cursor_updated_at: "2026-10-04T10:00:00Z", cursor_transaction_id: expect.stringMatching(/^v_[0-9a-f]{32}$/) });
    expect(view.cohort_snapshot_state).toEqual({
      status: "completed",
      active_warehouse_version: "wh_abc",
      active_classification_version: COHORT_CLASSIFICATION_VERSION,
      active_generated_at: "2026-10-04T10:05:00Z",
    });
    expect(view.support_sync_state).toEqual({ status: "completed", cursor_updated_at: "2026-10-04T09:00:00Z", cursor_transaction_id: expect.stringMatching(/^v_[0-9a-f]{32}$/) });
    const serialized = JSON.stringify(view);
    for (const hidden of [DATA_KEY, "tx_secret_cursor_123", "msg-cursor", "29479", "29480", "7145", "10242", "5120", "4000", "1120", "syntax error", "gross", "net_revenue", "unique_users", "transaction_count"]) {
      expect(serialized, hidden).not.toContain(hidden);
    }
  });

  it("the version tokens still move with every count and cursor that fed the browser fingerprint", async () => {
    const base = await memberView();
    expect((await memberView()).sync_state).toEqual(base.sync_state);
    expect((await memberView({ sync: { clickhouse_total: 29_480 } })).sync_state?.cursor_transaction_id).not.toBe(base.sync_state?.cursor_transaction_id);
    expect((await memberView({ sync: { cursor_transaction_id: "tx_next" } })).sync_state?.cursor_transaction_id).not.toBe(base.sync_state?.cursor_transaction_id);
    expect((await memberView({ support: { diagnostics: { attribution: { attribution_version: "v2", funnel_matched: 4_001, unknown: 1_119 } } } })).support_sync_state?.cursor_transaction_id)
      .not.toBe(base.support_sync_state?.cursor_transaction_id);
    // The sync and support tokens never collide even on identical inputs.
    expect(base.sync_state?.cursor_transaction_id).not.toBe(base.support_sync_state?.cursor_transaction_id);
  });

  it("missing states stay null (the browser's *_unknown versions)", async () => {
    const view = await memberWarehouseSummary({
      hasher: await createKeyedHasher("k", "l"),
      syncState: null,
      cohortSnapshotState: null,
      supportSyncState: { status: "never_started" },
    });
    expect(view.sync_state).toBeNull();
    expect(view.cohort_snapshot_state).toBeNull();
    expect(view.support_sync_state).toEqual({ status: "never_started", cursor_updated_at: null, cursor_transaction_id: null });
  });

  it("state reads are filtered by the workspace tenant key", async () => {
    const filters: Array<[string, string, unknown]> = [];
    const pg = {
      from(table: string) {
        const builder = {
          select: () => builder,
          eq: (column: string, value: unknown) => {
            filters.push([table, column, value]);
            return builder;
          },
          maybeSingle: async () => ({ data: { table }, error: null }),
        };
        return builder as never;
      },
    } as SupabaseLikeClient;
    expect(await getTransactionSyncState(pg, DATA_KEY)).toEqual({ table: "clickhouse_transaction_sync_state" });
    await getCohortSnapshotStateRow(pg, DATA_KEY);
    await getSupportSyncState(pg, DATA_KEY);
    expect(filters).toEqual([
      ["clickhouse_transaction_sync_state", "auth_user_id", DATA_KEY],
      ["clickhouse_transaction_sync_state", "sync_name", "analytics_transactions_backfill"],
      ["clickhouse_cohort_snapshot_state", "auth_user_id", DATA_KEY],
      ["clickhouse_cohort_snapshot_state", "snapshot_name", "fact_user_cohorts"],
      ["clickhouse_transaction_sync_state", "auth_user_id", DATA_KEY],
      ["clickhouse_transaction_sync_state", "sync_name", "fact_support_requests_sync"],
    ]);
  });
});

// ---- Phase 0 runner fixes ------------------------------------------------------------

describe("Phase 0: tenant-scoped active-subscription RPC", () => {
  it("calls the p_data_key overload with the tenant key", async () => {
    const rpc = vi.fn(async () => ({ data: { "a@x.com": ["s1"] }, error: null }));
    const map = await activeSubscriptionsByEmail({ from: vi.fn(), rpc } as unknown as SupabaseLikeClient, DATA_KEY);
    expect(rpc).toHaveBeenCalledWith("active_funnelfox_subscription_emails", { p_data_key: DATA_KEY });
    expect(map.get("a@x.com")).toEqual(["s1"]);
  });

  it("the dynamic list overlay passes the tenant key too", async () => {
    const rpc = vi.fn(async () => ({ data: {}, error: null }));
    const clickhouse: ClickHouseClientLike = {
      query: async ({ query }) => ({ json: async () => (query.includes("system.tables") ? [{ c: 0 }] : []) }),
      command: async () => undefined,
      insert: async () => undefined,
    };
    await runCohortList({ authUserId: DATA_KEY, clickhouse, request: { action: "list" }, supabase: { from: vi.fn(), rpc } as unknown as SupabaseLikeClient });
    expect(rpc).toHaveBeenCalledWith("active_funnelfox_subscription_emails", { p_data_key: DATA_KEY });
  });
});

/** Routes the materialized list path's queries; records every statement. */
function routedWarehouse(options: { throwOn?: RegExp; error?: () => Error } = {}) {
  const statements: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
  const client: ClickHouseClientLike = {
    command: async () => undefined,
    insert: async () => undefined,
    query: async (input) => {
      statements.push(input);
      const { query } = input;
      if (options.throwOn?.test(query)) throw (options.error ?? (() => new Error("warehouse hiccup")))();
      return {
        json: async () => {
          if (query.includes("warehouse_hash")) return [{ transaction_count: 3, unique_users: 2, max_row_version: "9", max_source_updated_at: "2026-10-01 00:00:00", warehouse_hash: "abc" }];
          if (query.includes("system.tables")) return [{ c: 1 }];
          if (query.includes("AS support_requests")) return [{ support_requests: 0, support_unique_emails: 0 }];
          if (query.includes("INNER JOIN fact_user_cohorts AS fc FINAL")) {
            return [{ cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch", trial_users: 2, gross_raw: 10, refund_raw: 0 }];
          }
          if (/FROM normalized_email\)\) email/.test(query)) {
            return [
              { email: "a@x.com", cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch" },
              { email: "b@x.com", cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch" },
            ];
          }
          return [];
        },
      };
    },
  };
  return { client, statements };
}

function snapshotSupabase(rpcData: unknown = {}): SupabaseLikeClient & { rpc: ReturnType<typeof vi.fn> } {
  const state = {
    status: "completed",
    active_warehouse_version: "wh_abc",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: "2026-10-01T00:00:00Z",
    users_classified: 2,
    duplicate_users: 0,
    diagnostics: { validation: { status: "PASS" } },
  };
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: state, error: null }),
  };
  return {
    from: () => builder as never,
    rpc: vi.fn(async () => ({ data: rpcData, error: null })),
  };
}

describe("Phase 1: the materialized list runs cleanly through the ScopedReader for an employee", () => {
  it("binds the tenant key everywhere, records no violation, and serves pseudonymized identities", async () => {
    const ctx = contextFor("viewer");
    const { client, statements } = routedWarehouse();
    const reader = createScopedReader(ctx, client);
    const supabase = snapshotSupabase({ "a@x.com": ["sub-1"], "b@x.com": ["sub-2", "sub-3"] });
    const response = await runMaterializedCohortList({ authUserId: ctx.tenantKey, supabase, clickhouse: reader, request: { action: "list" } });
    expect(response).not.toBeNull();
    expect(ctx.violations).toEqual([]);
    expect(statements.length).toBeGreaterThan(5);
    for (const statement of statements) {
      if (statement.query.includes("{auth_user_id:String}")) expect(statement.query_params?.auth_user_id).toBe(DATA_KEY);
    }
    expect(supabase.rpc).toHaveBeenCalledWith("active_funnelfox_subscription_emails", { p_data_key: DATA_KEY });
    const row = response!.rows[0];
    expect(row.active_users).toBe(2);
    expect(row.active_subscriptions).toBe(3);
    await pseudonymizeActiveIdentities(response!.rows, await createKeyedHasher("k", cohortIdentityHashLabel(ctx.tenantKey)));
    expect(JSON.stringify(response)).not.toContain("@x.com");
    expect(JSON.stringify(response)).not.toContain("sub-1");
    expect(response!.rows[0].active_user_ids).toHaveLength(2);
  });
});

describe("Phase 0: best-effort catch sites rethrow ScopeViolation, keep defaults otherwise", () => {
  const violation = () => new ScopeViolation("restricted_protected_table", "analytics_transactions");

  it("subscriptionDataStatus / supportDataStatus", async () => {
    const throwing = (error: () => Error): ClickHouseClientLike => ({
      query: async () => { throw error(); },
      command: async () => undefined,
      insert: async () => undefined,
    });
    await expect(subscriptionDataStatus(throwing(violation), DATA_KEY)).rejects.toBeInstanceOf(ScopeViolation);
    await expect(supportDataStatus(throwing(violation), DATA_KEY)).rejects.toBeInstanceOf(ScopeViolation);
    await expect(subscriptionDataStatus(throwing(() => new Error("x")), DATA_KEY)).resolves.toBe("failed");
    await expect(supportDataStatus(throwing(() => new Error("x")), DATA_KEY)).resolves.toMatchObject({ support_data_status: "unavailable" });
  });

  it.each([
    ["scan diagnostics", /transactions_scanned/],
    ["fx diagnostics", /transactions_with_currency/],
    ["filter options", /'price_plan' dim/],
  ])("runCohortList: %s", async (_label, pattern) => {
    const viol = routedWarehouse({ throwOn: pattern, error: violation });
    await expect(runCohortList({ authUserId: DATA_KEY, clickhouse: viol.client, request: { action: "list" } })).rejects.toBeInstanceOf(ScopeViolation);
    const ordinary = routedWarehouse({ throwOn: pattern });
    await expect(runCohortList({ authUserId: DATA_KEY, clickhouse: ordinary.client, request: { action: "list" } })).resolves.toMatchObject({ ok: true });
  });

  it("runCohortList: the active-subscription overlay", async () => {
    const rpc = vi.fn(async () => ({ data: { "a@x.com": ["s1"] }, error: null }));
    const supabase = { from: vi.fn(), rpc } as unknown as SupabaseLikeClient;
    const pattern = /u_normalized_email != ''/;
    const viol = routedWarehouse({ throwOn: pattern, error: violation });
    await expect(runCohortList({ authUserId: DATA_KEY, clickhouse: viol.client, request: { action: "list" }, supabase })).rejects.toBeInstanceOf(ScopeViolation);
    const ordinary = routedWarehouse({ throwOn: pattern });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runCohortList({ authUserId: DATA_KEY, clickhouse: ordinary.client, request: { action: "list" }, supabase })).resolves.toMatchObject({ ok: true });
    spy.mockRestore();
  });

  it.each([
    ["summary", /net_revenue_1m/],
    ["currency", /gross_original/],
    ["token packs", /purchases, uniqExact\(uid\) buyers/],
    ["plan breakdown", /plankey AS/],
    ["support probe", /system\.tables/],
  ])("runCohortDetails: %s", async (_label, pattern) => {
    const request = { action: "details" as const, cohort_key: { cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch" } };
    const viol = routedWarehouse({ throwOn: pattern, error: violation });
    await expect(runCohortDetails({ authUserId: DATA_KEY, clickhouse: viol.client, request })).rejects.toBeInstanceOf(ScopeViolation);
    const ordinary = routedWarehouse({ throwOn: pattern });
    await expect(runCohortDetails({ authUserId: DATA_KEY, clickhouse: ordinary.client, request })).resolves.toMatchObject({ ok: true });
  });

  it.each([
    ["live fingerprint", /warehouse_hash/],
    ["filter options", /tutm AS/],
    ["fx diagnostics", /transactions_with_currency/],
    ["active-subscription overlay", /FROM normalized_email\)\) email/],
    ["FB allocation", /fact_facebook_stats/],
  ])("runMaterializedCohortList: %s", async (_label, pattern) => {
    const supabase = snapshotSupabase({ "a@x.com": ["s1"] });
    const viol = routedWarehouse({ throwOn: pattern, error: violation });
    await expect(runMaterializedCohortList({ authUserId: DATA_KEY, supabase, clickhouse: viol.client, request: { action: "list" } }))
      .rejects.toBeInstanceOf(ScopeViolation);
    const ordinary = routedWarehouse({ throwOn: pattern });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(runMaterializedCohortList({ authUserId: DATA_KEY, supabase, clickhouse: ordinary.client, request: { action: "list" } }))
      .resolves.toMatchObject({ ok: true });
    spy.mockRestore();
  });
});

// ---- the entry points ----------------------------------------------------------------

describe("index.ts files are thin serveWithAccess wrappers", () => {
  const FUNCTIONS = [
    ["clickhouse-cohorts", "CLICKHOUSE_COHORTS_POLICY"],
    ["clickhouse-cohort-membership", "CLICKHOUSE_COHORT_MEMBERSHIP_POLICY"],
    ["clickhouse-summary", "CLICKHOUSE_SUMMARY_POLICY"],
  ] as const;

  it.each(FUNCTIONS)("%s", (fn, policyName) => {
    const source = readFileSync(`supabase/functions/${fn}/index.ts`, "utf8");
    expect(source).toContain(`serveWithAccess(${policyName}`);
    expect(source).toContain(`from "../_shared/access/policies/${fn}.ts"`);
    expect(source).toContain("ctx.tenantKey");
    for (const banned of [/requireSupabaseUser/, /requireCronSecret/, /createClickHouseClient/, /clickhouse\/client\.ts/, /Deno\.serve\(/, /\bauth\.id\b/, /parseJsonBody/, /CLICKHOUSE_PASSWORD/]) {
      expect(source, String(banned)).not.toMatch(banned);
    }
  });
});
