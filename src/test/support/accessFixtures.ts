// Shared fixtures of the security regression suite (plan §29 "New helpers":
// owner, admin-all, buyer-{A}, buyer-{A,B}, empty-grant, disabled, non-member,
// cron, api-key).
//
// Three layers, so every security test can pick the most real one it needs:
//   1. Personas → resolve_access rows → AccessContexts (pure, the gate's own
//      parser and builder).
//   2. A fake-dependency gate harness (handleWithAccess with injected getUser /
//      resolve_access / workspace_data_key / a ScopedReader over the recording
//      ClickHouse), plus the policy registry and ONE request fixture per
//      canonical action of every policy, so table-driven tests iterate every
//      policy × action and a new action without a fixture fails the suite.
//   3. A PGlite workspace (all migrations, bootstrap, real role templates, the
//      personas as real members, tenant rows, the RLS lockdown) and gate
//      dependencies backed by it: the REAL resolve_access feeds the REAL gate.
//   4. Access Phase 2: a restricted read end to end — router replicas of the
//      scopeReady functions over the REAL runners, and a fixture warehouse that
//      answers each statement by the funnel scope the statement carries.
//
// Never touches production: no network, no Supabase project, no ClickHouse.

import { createHash } from "node:crypto";
import { vi } from "vitest";
import { EXPORT_API_KEY_SCOPE } from "../../../supabase/functions/_shared/access/policies/export-campaign-performance.ts";
import {
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
  type ServeWithAccessOptions,
} from "../../../supabase/functions/_shared/access/gate.ts";
import {
  buildAccessContext,
  buildCronAccessContext,
  parseResolveAccessRow,
  type AccessContext,
  type ActionPolicy,
} from "../../../supabase/functions/_shared/access/accessContext.ts";
import {
  ENFORCED_PERMISSION_KEYS,
  closeUnderRequires,
  isPrivilegedPermission,
} from "../../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../../supabase/functions/_shared/access/roles.ts";
import { ACCESS_ERROR, type AccessErrorCode } from "../../../supabase/functions/_shared/access/errors.ts";
import { createScopedReader } from "../../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  CAMPAIGN_SCOPE_VERSION,
  COHORT_CLASSIFICATION_VERSION,
  type CohortSnapshotState,
} from "../../../supabase/functions/_shared/clickhouse/cohortSnapshotState.ts";
import type {
  AccessAdminStore,
  AuditRow,
  FunnelRow,
  MemberRow,
  RoleRow,
} from "../../../supabase/functions/_shared/access/adminApi.ts";
import { seedTemplatesPayload } from "../../../supabase/functions/_shared/access/adminApi.ts";
import {
  cohortDetailedErrorsVisible,
  cohortIdentitiesVisible,
  cohortIdentityHashLabel,
  cohortsErrorResponse,
  projectCohortsResponseForRestricted,
  restrictCohortRequest,
} from "../../../supabase/functions/_shared/access/policies/clickhouse-cohorts.ts";
import { restrictRevenueRequest, withRestrictedMeta } from "../../../supabase/functions/_shared/access/policies/clickhouse-revenue.ts";
import {
  FbActionError,
  clickHouseFacebookErrorResponse,
  fbResponseAction,
  fbStatusDetailVisible,
  projectFbSyncStateForRestricted,
  projectFbSyncStateForViewer,
} from "../../../supabase/functions/_shared/access/policies/clickhouse-facebook.ts";
import { summaryKpisVisible, summaryVersionHashLabel } from "../../../supabase/functions/_shared/access/policies/clickhouse-summary.ts";
import { ScopeViolation } from "../../../supabase/functions/_shared/clickhouse/scopedClient.ts";
import {
  ScopeForbiddenError,
  ScopeSnapshotNotReadyError,
  assertFbLevelInScope,
} from "../../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { classifyCampaignScope, type CampaignScopeRow } from "../../../supabase/functions/_shared/clickhouse/campaignScope.ts";
import {
  runMaterializedCohortDetails,
  runMaterializedCohortList,
  runMaterializedCohortOptions,
} from "../../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { runCohortDetails, runCohortList, runCohortOptions } from "../../../supabase/functions/_shared/clickhouse/cohorts.ts";
import { createKeyedHasher, pseudonymizeActiveIdentities } from "../../../supabase/functions/_shared/clickhouse/cohortSubscriptions.ts";
import {
  RevenueRequestError,
  runRevenueDayBreakdown,
  runRevenueIntelligence,
} from "../../../supabase/functions/_shared/clickhouse/revenueIntelligence.ts";
import {
  buildFbDiagnostics,
  fbWarehouseErrorResponse,
  getFbSyncState,
  normalizeFbFilters,
  normalizeFbLevel,
  runFbCharts,
  runFbFilterOptions,
  runFbList,
  runFbReport,
  type FbReadRequest,
} from "../../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import {
  getCohortSnapshotStateRow,
  getSupportSyncState,
  getTransactionSyncState,
  memberWarehouseSummary,
} from "../../../supabase/functions/_shared/clickhouse/summary.ts";
import type { CohortRequest } from "../../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { RevenueIntelligenceRequest } from "../../../supabase/functions/_shared/clickhouse/revenueIntelligenceContract.ts";
import type { SupabaseLikeClient } from "../../../supabase/functions/_shared/clickhouse/types.ts";
import { createRecordingClickHouse, type RecordedStatement, type RecordingClickHouse } from "./recordingClickHouse";
import { createStrictFakeSupabase, type StrictFakeSupabase } from "./strictFakeSupabase";
import {
  createSupabasePglite,
  listMigrations,
  type SqlRunner,
  type SupabasePglite,
} from "./pgliteSupabase";
import { SENTINEL_CLICKHOUSE_ERROR, SENTINEL_EMAILS, SENTINEL_SPEND, unhexLiterals } from "./leakScan";

// =====================================================================================
// 1. identities
// =====================================================================================

/** The workspace data key U: the data owner's auth uuid and every query's tenant. */
export const DATA_KEY = "11111111-1111-4111-8111-111111111111";
export const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
/** A tenant that is NOT the workspace (another account's private copy, a forged key). */
export const FOREIGN_TENANT = "99999999-9999-4999-8999-999999999999";

export const USER_IDS = {
  owner: DATA_KEY,
  admin: "a1a1a1a1-0000-4000-8000-000000000001",
  viewer: "b2b2b2b2-0000-4000-8000-000000000002",
  buyerA: "c3c3c3c3-0000-4000-8000-000000000003",
  buyerAB: "c4c4c4c4-0000-4000-8000-000000000004",
  emptyGrant: "d5d5d5d5-0000-4000-8000-000000000005",
  noRule: "d6d6d6d6-0000-4000-8000-000000000006",
  disabled: "e7e7e7e7-0000-4000-8000-000000000007",
  nonMember: "f8f8f8f8-0000-4000-8000-000000000008",
  newbie: "f9f9f9f9-0000-4000-8000-000000000009",
} as const;

export const FUNNELS = {
  A: { id: "aaaaaaaa-0000-4000-8000-0000000000aa", path: "soulmate-sketch", rawPath: "/Soulmate-Sketch", name: "Soulmate" },
  B: { id: "bbbbbbbb-0000-4000-8000-0000000000bb", path: "past-life", rawPath: "past-life", name: "Past life" },
  C: { id: "cccccccc-0000-4000-8000-0000000000cc", path: "palm-reading", rawPath: "palm-reading", name: "Palm" },
} as const;

const TEMPLATE = Object.fromEntries(ROLE_TEMPLATES.map((template) => [template.key, template.permissions])) as Record<string, string[]>;

export const TEMPLATE_PERMISSIONS = {
  admin: TEMPLATE.admin,
  viewer: TEMPLATE.viewer,
  mediaBuyer: TEMPLATE.media_buyer,
  analyst: TEMPLATE.analyst,
  headOfMarketing: TEMPLATE.head_of_marketing,
  productManager: TEMPLATE.product_manager,
};

/** Every enforced key that does NOT need funnel scope `all`. */
export const NON_PRIVILEGED_KEYS: readonly string[] = ENFORCED_PERMISSION_KEYS.filter((key) => !isPrivilegedPermission(key));

// =====================================================================================
// 2. personas → resolve_access rows → contexts
// =====================================================================================

export type ScopeMode = "all" | "selected" | "none";

export interface PersonaScope {
  mode: ScopeMode;
  funnelIds: string[];
  paths: string[];
}

export interface Persona {
  name: string;
  userId: string;
  status: "ok" | "disabled" | "no_membership" | "no_workspace";
  role: { id: string; key: string; name: string; isOwner: boolean; permissions: string[] };
  /** null = no rule row (resolve_access reports mode "none"). */
  scope: PersonaScope | null;
  accessVersion: string;
}

const ALL: PersonaScope = { mode: "all", funnelIds: [], paths: [] };
const selected = (...funnels: Array<(typeof FUNNELS)[keyof typeof FUNNELS]>): PersonaScope => ({
  mode: "selected",
  funnelIds: funnels.map((funnel) => funnel.id),
  paths: funnels.map((funnel) => funnel.path).sort(),
});

function persona(name: string, userId: string, role: Persona["role"], scope: PersonaScope | null, status: Persona["status"] = "ok"): Persona {
  return { name, userId, status, role, scope, accessVersion: "1" };
}

const role = (key: string, permissions: readonly string[], isOwner = false) => ({
  id: `role-${key}`,
  key,
  name: key,
  isOwner,
  permissions: [...permissions],
});

export const PERSONAS = {
  owner: persona("owner", USER_IDS.owner, role("owner", [], true), ALL),
  admin: persona("admin", USER_IDS.admin, role("admin", TEMPLATE_PERMISSIONS.admin), ALL),
  viewer: persona("viewer", USER_IDS.viewer, role("viewer", TEMPLATE_PERMISSIONS.viewer), ALL),
  buyerA: persona("buyerA", USER_IDS.buyerA, role("media_buyer", TEMPLATE_PERMISSIONS.mediaBuyer), selected(FUNNELS.A)),
  buyerAB: persona("buyerAB", USER_IDS.buyerAB, role("media_buyer", TEMPLATE_PERMISSIONS.mediaBuyer), selected(FUNNELS.A, FUNNELS.B)),
  emptyGrant: persona("emptyGrant", USER_IDS.emptyGrant, role("viewer", TEMPLATE_PERMISSIONS.viewer), { mode: "selected", funnelIds: [], paths: [] }),
  noRule: persona("noRule", USER_IDS.noRule, role("viewer", TEMPLATE_PERMISSIONS.viewer), null),
  disabled: persona("disabled", USER_IDS.disabled, role("viewer", TEMPLATE_PERMISSIONS.viewer), ALL, "disabled"),
  nonMember: persona("nonMember", USER_IDS.nonMember, role("none", []), null, "no_membership"),
} satisfies Record<string, Persona>;

export type PersonaName = keyof typeof PERSONAS;

/** Same persona, another role grant (role key "custom"). */
export function withGrant(base: Persona, permissions: readonly string[], options: { isOwner?: boolean; name?: string } = {}): Persona {
  return {
    ...base,
    name: options.name ?? `${base.name}+grant`,
    role: { ...base.role, id: "role-custom", key: "custom", isOwner: options.isOwner ?? false, permissions: [...permissions] },
  };
}

/** Same persona, another funnel scope. */
export function withScope(base: Persona, scope: PersonaScope | null, name?: string): Persona {
  return { ...base, name: name ?? `${base.name}@${scope?.mode ?? "none"}`, scope };
}

export const memberIdOf = (userId: string) => `${userId.slice(0, 8)}-1111-4111-8111-${userId.slice(-12)}`;

/** The JSON public.resolve_access(user) returns for a persona (same shape as the SQL). */
export function accessRow(p: Persona, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  if (p.status !== "ok") return { status: p.status, user_id: p.userId, workspace_id: p.status === "no_workspace" ? null : WORKSPACE_ID, ...overrides };
  const scope = p.scope ?? { mode: "none" as const, funnelIds: [], paths: [] };
  return {
    status: "ok",
    workspace_id: WORKSPACE_ID,
    data_key: DATA_KEY,
    member_id: memberIdOf(p.userId),
    user_id: p.userId,
    email: `${p.name.toLowerCase()}@example.test`,
    display_name: p.name,
    is_data_owner: p.userId === DATA_KEY,
    raw_access: p.userId === DATA_KEY,
    role: { id: p.role.id, key: p.role.key, name: p.role.name, is_owner: p.role.isOwner, permissions: [...p.role.permissions] },
    funnel_scope: { mode: scope.mode, funnel_ids: [...scope.funnelIds], paths: [...scope.paths] },
    access_version: p.accessVersion,
    partition: `partition-${p.name}-${scope.mode}-${p.accessVersion}`,
    ...overrides,
  };
}

/** The AccessContext the gate would build for the persona (the gate's own parser). */
export function contextFor(p: Persona, requestId = "req-fixture"): AccessContext {
  const row = parseResolveAccessRow(accessRow(p));
  if (!row) throw new Error(`fixture row for ${p.name} did not parse`);
  return buildAccessContext(row, { kind: "user", userId: p.userId, email: `${p.name}@example.test` }, requestId);
}

export function cronContext(requestId = "req-cron"): AccessContext {
  return buildCronAccessContext({ tenantKey: DATA_KEY, requestId });
}

/** An Export API key (the "api-key" persona): the raw bearer value and the
 * api_keys row the handler finds by its sha256. The actor is `creator`; the
 * handler must still read the workspace data key. */
export function apiKeyFixture(name: string, creator: string, extra: Record<string, unknown> = {}) {
  const raw = `subengine_live_${name}_key`;
  return {
    raw,
    row: {
      id: `key-${name}`,
      key_hash: createHash("sha256").update(raw, "utf8").digest("hex"),
      user_id: creator,
      prefix: raw.slice(0, 18),
      is_active: true,
      revoked_at: null,
      allowed_scopes: [EXPORT_API_KEY_SCOPE],
      ...extra,
    } as Record<string, unknown>,
  };
}

// =====================================================================================
// 3. the fake-dependency gate harness
// =====================================================================================

export const GOOD_TOKEN = "good-token";

export const CRON_SECRETS: Readonly<Record<string, string>> = Object.freeze({
  FB_CRON_SECRET: "fb-cron-secret-value",
  SUPPORT_MAIL_SYNC_INTERNAL_SECRET: "support-mail-secret-value",
});

export const READY_SNAPSHOT_PASS = Object.freeze({ status: "PASS", duplicate_users: 0 });

/** A cohort snapshot state the Phase-2 freshness gate admits for every
 * scopeSnapshot ("cohort" and "campaign"): validated active versions of the
 * current classifier, the campaign scope built, verified current just now. */
export function readySnapshotState(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  const now = new Date().toISOString();
  return {
    auth_user_id: DATA_KEY,
    snapshot_name: "fact_user_cohorts",
    status: "completed",
    active_warehouse_version: "wh_fixture",
    active_classification_version: COHORT_CLASSIFICATION_VERSION,
    active_generated_at: now,
    building_warehouse_version: null,
    building_classification_version: null,
    started_at: null,
    finished_at: now,
    duration_ms: 1,
    users_classified: 3,
    rows_inserted: 3,
    duplicate_users: 0,
    removed_or_invalidated: 0,
    source_transactions: 3,
    source_unique_users: 3,
    last_error: null,
    diagnostics: { validation: { ...READY_SNAPSHOT_PASS } },
    active_validation: { ...READY_SNAPSHOT_PASS },
    active_validated_at: now,
    active_campaign_scope_version: CAMPAIGN_SCOPE_VERSION,
    fresh_verified_at: now,
    stale_since: null,
    ...overrides,
  };
}

export interface FakeGateOptions {
  persona?: Persona;
  /** Override what resolve_access answers (data). */
  row?: unknown;
  loadAccess?: AccessGateDeps["loadAccess"];
  getUser?: AccessGateDeps["getUser"];
  workspaceDataKey?: AccessGateDeps["workspaceDataKey"];
  /** The cohort snapshot state restricted scopeSnapshot actions read (default:
   * readySnapshotState(); null = no snapshot row). */
  snapshotState?: CohortSnapshotState | null;
  loadCohortSnapshotState?: AccessGateDeps["loadCohortSnapshotState"];
  secrets?: Record<string, string | undefined>;
  clickhouse?: RecordingClickHouse;
  pg?: unknown;
  requestId?: string;
}

export interface FakeGate {
  deps: AccessGateDeps & {
    getUser: ReturnType<typeof vi.fn>;
    loadAccess: ReturnType<typeof vi.fn>;
    workspaceDataKey: ReturnType<typeof vi.fn>;
    loadCohortSnapshotState: ReturnType<typeof vi.fn>;
    createClickHouse: ReturnType<typeof vi.fn>;
    log: ReturnType<typeof vi.fn>;
  };
  clickhouse: RecordingClickHouse;
}

export function fakeGate(options: FakeGateOptions = {}): FakeGate {
  const p = options.persona ?? PERSONAS.viewer;
  const clickhouse = options.clickhouse ?? createRecordingClickHouse();
  const pg = options.pg ?? createStrictFakeSupabase({ tenantKey: DATA_KEY, actorKey: p.userId, tables: {} });
  const deps = {
    configError: null,
    pg: pg as AccessGateDeps["pg"],
    getUser: vi.fn(options.getUser ?? (async (token: string) =>
      token === GOOD_TOKEN
        ? { data: { user: { id: p.userId, email: `${p.name}@example.test` } }, error: null }
        : { data: { user: null }, error: { name: "AuthApiError", status: 401, message: "invalid JWT" } })),
    loadAccess: vi.fn(options.loadAccess ?? (async (_userId: string) => ({ data: options.row === undefined ? accessRow(p) : options.row, error: null }))),
    workspaceDataKey: vi.fn(options.workspaceDataKey ?? (async () => ({ data: DATA_KEY, error: null }))),
    loadCohortSnapshotState: vi.fn(options.loadCohortSnapshotState ?? (async (_tenantKey: string) =>
      options.snapshotState === undefined ? readySnapshotState() : options.snapshotState)),
    readEnv: vi.fn((name: string) => (options.secrets ?? CRON_SECRETS)[name]),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, clickhouse)),
    newRequestId: () => options.requestId ?? "req-security",
    log: vi.fn(),
  };
  return { deps, clickhouse };
}

export interface EdgeRequestInput {
  fn?: string;
  method?: string;
  body?: unknown;
  rawBody?: string;
  query?: string;
  /** null = no Authorization header. */
  token?: string | null;
  headers?: Record<string, string>;
}

export function edgeRequest(input: EdgeRequestInput = {}) {
  const method = (input.method ?? "POST").toUpperCase();
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(input.headers ?? {}) };
  if (input.token !== null) headers.Authorization = `Bearer ${input.token ?? GOOD_TOKEN}`;
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const req = new Request(`https://edge.test/functions/v1/${input.fn ?? "fn"}${input.query ?? ""}`, {
    method,
    headers,
    body: hasBody ? input.rawBody ?? JSON.stringify(input.body ?? {}) : undefined,
  });
  const textSpy = vi.spyOn(req, "text");
  return { req, textSpy };
}

export interface GateCallResult {
  response: Response;
  status: number;
  text: string;
  json: Record<string, unknown> | null;
}

export async function readResult(response: Response): Promise<GateCallResult> {
  const text = await response.clone().text();
  let json: Record<string, unknown> | null = null;
  try {
    const parsed = text ? JSON.parse(text) : null;
    json = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    json = null;
  }
  return { response, status: response.status, text, json };
}

export async function callGate<A extends string>(
  policy: FunctionPolicy<A>,
  handler: AccessHandler<A>,
  req: Request,
  deps: AccessGateDeps,
  options?: ServeWithAccessOptions,
): Promise<GateCallResult> {
  return readResult(await handleWithAccess(req, policy, handler, deps, options));
}

/** A handler that records how it was called and proves which tenant the
 * reader binds by issuing one tenant-bound query (TENANT_PROBE_SQL). */
export function probeHandler(options: { query?: boolean } = {}) {
  const seen: Array<{ action: string; ctx: AccessContext; body: Record<string, unknown> }> = [];
  const handler = vi.fn(async (request: { action: string; ctx: AccessContext; body: Record<string, unknown>; clickhouse(): { query(input: { query: string; query_params?: Record<string, unknown> }): Promise<unknown> } }) => {
    seen.push({ action: request.action, ctx: request.ctx, body: request.body });
    if (options.query !== false) {
      await request.clickhouse().query({ query: "SELECT count() AS c FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}" });
    }
    return { ok: true, action: request.action };
  });
  return { handler: handler as unknown as AccessHandler<string>, spy: handler, seen };
}

// =====================================================================================
// 4. the policy registry and one request per canonical action
// =====================================================================================

const POLICY_MODULES = import.meta.glob<Record<string, unknown>>("../../../supabase/functions/_shared/access/policies/*.ts", { eager: true });

export function policyConstName(fn: string): string {
  return `${fn.replace(/-/g, "_").toUpperCase()}_POLICY`;
}

export const ALL_POLICIES: ReadonlyArray<FunctionPolicy<string>> = Object.entries(POLICY_MODULES)
  .map(([path, module]) => {
    const fn = path.split("/").pop()!.replace(/\.ts$/, "");
    const policy = module[policyConstName(fn)] as FunctionPolicy<string> | undefined;
    if (!policy) throw new Error(`policies/${fn}.ts does not export ${policyConstName(fn)}`);
    return policy;
  })
  .sort((a, b) => a.fn.localeCompare(b.fn));

export function policyFor(fn: string): FunctionPolicy<string> {
  const policy = ALL_POLICIES.find((entry) => entry.fn === fn);
  if (!policy) throw new Error(`no policy for ${fn}`);
  return policy;
}

/** Functions that do not use the JWT gate (their entry point is tested directly). */
export const NOT_GATED: Readonly<Record<string, string>> = Object.freeze({
  "export-campaign-performance": "API-key auth: handleExportCampaignPerformance + decideApiKeyAccess",
});

export const GATED_POLICIES = ALL_POLICIES.filter((policy) => !NOT_GATED[policy.fn]);

/** Actions only the scheduler can reach (no user request normalizes to them). */
export const CRON_ONLY_ACTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "clickhouse-cohort-membership": ["cron_tick"],
  "clickhouse-facebook": ["cron_daily"],
});

/** Access Phase 2: exactly these actions serve a funnel-restricted context
 * (spec §6 contract 2). Every other action of every policy stays refused with
 * 403 scope_not_supported. */
export const SCOPE_READY_ACTIONS: readonly string[] = Object.freeze([
  "clickhouse-cohorts.details", "clickhouse-cohorts.list", "clickhouse-cohorts.options",
  "clickhouse-facebook.charts", "clickhouse-facebook.filters", "clickhouse-facebook.list", "clickhouse-facebook.report",
  "clickhouse-facebook.status", "clickhouse-facebook.summary",
  "clickhouse-revenue.bundle", "clickhouse-revenue.day_breakdown",
  "clickhouse-summary.summary",
]);

export interface ActionRequest {
  method?: "POST" | "GET";
  body?: Record<string, unknown>;
  query?: string;
}

const post = (body: Record<string, unknown>): ActionRequest => ({ method: "POST", body });
const named = (...actions: string[]) => Object.fromEntries(actions.map((action) => [action, post({ action })]));

/** One request per canonical USER action of every policy. The suite asserts
 * that each one normalizes to its action and that every non-cron-only action
 * has one — a new action without a fixture fails, never silently skipped. */
export const ACTION_REQUESTS: Readonly<Record<string, Readonly<Record<string, ActionRequest>>>> = Object.freeze({
  access: named(
    "catalog", "members.list", "members.add", "members.update", "members.set_scope", "members.effective",
    "roles.list", "roles.create", "roles.update", "roles.delete", "roles.seed_templates", "audit.list", "funnels.list",
    "paths.coverage", "paths.attach", "paths.set_status",
  ),
  "ai-analytics": { assistant_answer: post({ action: "assistant_answer", input: { question: "What should I scale?" } }) },
  "capsuled-facebook-sync": { sync: post({ dateFrom: "2026-09-01", dateTo: "2026-09-02", level: "campaign" }) },
  "classify-support-requests": named("status", "start", "continue", "reset"),
  "clickhouse-backfill": {
    continue: post({ mode: "continue" }),
    full_backfill: post({ mode: "full_backfill" }),
    validate_only: post({ mode: "validate_only" }),
    dedup: post({ mode: "dedup" }),
  },
  "clickhouse-cohort-membership": {
    status: post({ action: "status" }),
    rebuild: post({ action: "rebuild" }),
    rebuild_force: post({ action: "rebuild", force: true }),
    validate: post({ action: "validate" }),
  },
  "clickhouse-cohorts": {
    list: post({ action: "list", filters: {} }),
    list_fb_allocation_diagnostics: post({ action: "list", filters: {}, fb_allocation_diagnostics: { enabled: true } }),
    details: post({ action: "details", cohort_key: { cohort_date: "2026-09-01", funnel: FUNNELS.A.path, campaign_path: FUNNELS.A.path } }),
    options: post({ action: "options" }),
  },
  "clickhouse-facebook": {
    ...named(
      "report", "list", "charts", "filters", "summary", "status", "funnel_spend", "spend_ledger",
      "history_runs", "history_batches", "history_versions", "history_raw_payloads", "history_dq", "recon_history",
      "v2_parity", "v2_dims_status", "source_probe", "sync", "recon_snapshot", "v2_dims_backfill", "seed_campaign_aliases",
      "funnel_suggestions",
    ),
    v2_preview: post({ action: "list", v2_preview: true }),
    funnel_suggestions_apply: post({ action: "funnel_suggestions", apply: true }),
  },
  "clickhouse-health": { health: post({}) },
  "clickhouse-init": { init: post({}) },
  "clickhouse-payment-analytics": {
    bundle: post({ action: "analytics" }),
    banks: post({ action: "banks" }),
    bank_detail: post({ action: "bank_detail", bank: "Sentinel Bank" }),
    ai_pass_rates: post({ action: "analytics", purpose: "ai_pass_rates" }),
  },
  "clickhouse-revenue": named("bundle", "day_breakdown"),
  "clickhouse-summary": { summary: post({}) },
  "clickhouse-support": {
    ...named("bundle", "options", "status", "list", "unanswered_contacts", "export", "sync"),
    details: post({ action: "details", request_id: "req-1" }),
    bundle_search: post({ action: "bundle", filters: { search: "refund" } }),
    list_search: post({ action: "list", filters: { search: "refund" } }),
    unanswered_contacts_search: post({ action: "unanswered_contacts", filters: { search: "refund" } }),
    export_search: post({ action: "export", filters: { search: "refund" } }),
  },
  "clickhouse-users": {
    ...named("list", "summary", "options", "decline"),
    details: post({ action: "details", user_id: "customer-1" }),
    leads_list: post({ action: "leads_list" }),
    leads_overview: post({ action: "leads_overview" }),
  },
  "clickhouse-validate": named("start", "continue", "status", "reset"),
  "dashboard-summary": { summary: post({ filters: {} }) },
  "export-campaign-performance": {
    campaign_performance: { method: "GET", query: "" },
    campaign_performance_geo: { method: "GET", query: "?breakdown=country" },
  },
  "fb-analytics-summary": { summary: post({ filters: {} }) },
  "funnelfox-funnels": { list: post({}), inspect: post({ inspect: "1" }) },
  "funnelfox-leads-sync": { sync: post({}), sync_full_reset: post({ full_reset: true }), dry_run: post({ dry_run: true }) },
  "funnelfox-profile": { profile: post({ id: "profile-1" }), profile_debug: post({ id: "profile-1", debug: "1" }) },
  "funnelfox-subscription": { details: post({ id: "subscription-1" }) },
  "funnelfox-subscriptions": { list: post({}), connection_test: post({ debug: "1" }) },
  "funnelfox-subscriptions-sync": { sync: post({}), sync_full_reset: post({ full_reset: true }), dry_run: post({ dry_run: true }) },
  "reports-generate": {
    generate: post({ action: "generate", report_id: null }),
    regenerate_block: post({ action: "regenerate_block", report_id: null, block_id: "b1" }),
  },
  "sync-support-mail": named(
    "test_connection", "status", "list_folders", "initial_sync", "continue_sync", "sync_new", "stop", "reset_cursor",
    "sent_initial_sync", "sent_continue_sync", "sent_sync_new", "rematch_replies",
  ),
});

export function isCronOnly(policy: FunctionPolicy<string>, action: string): boolean {
  return Boolean(CRON_ONLY_ACTIONS[policy.fn]?.includes(action));
}

/** Every action a user request can reach. */
export function userActions(policy: FunctionPolicy<string>): string[] {
  return Object.keys(policy.actions).filter((action) => !isCronOnly(policy, action));
}

export interface ActionCase {
  fn: string;
  action: string;
  policy: FunctionPolicy<string>;
  rule: ActionPolicy;
  request: ActionRequest;
}

/** [fn, action] rows for it.each — every user action of every gated policy. */
export function gatedActionCases(): ActionCase[] {
  const cases: ActionCase[] = [];
  for (const policy of GATED_POLICIES) {
    for (const action of userActions(policy)) {
      const request = ACTION_REQUESTS[policy.fn]?.[action];
      if (!request) throw new Error(`no request fixture for ${policy.fn}.${action} (add one to ACTION_REQUESTS)`);
      cases.push({ fn: policy.fn, action, policy, rule: policy.actions[action], request });
    }
  }
  return cases;
}

/** The canonical action a fixture request normalizes to (through the policy's own normalizer). */
export function normalizedAction(policy: FunctionPolicy<string>, request: ActionRequest, cron = false): string | null {
  const method = request.method ?? "POST";
  try {
    return policy.normalizeAction({
      method,
      body: method === "GET" ? {} : { ...(request.body ?? {}) },
      url: new URL(`https://edge.test/functions/v1/${policy.fn}${request.query ?? ""}`),
      cron,
    });
  } catch {
    return null;
  }
}

/** True when no grant without a privileged (full-scope) key can satisfy the rule. */
export function needsPrivileged(rule: ActionPolicy): boolean {
  const privileged = (key: string) => closeUnderRequires([key]).some((entry) => isPrivilegedPermission(entry)) || isPrivilegedPermission(key);
  if ((rule.allOf ?? []).some(privileged)) return true;
  if (rule.anyOf) return rule.anyOf.length === 0 || rule.anyOf.every(privileged);
  return false;
}

/** A Milestone-A "data action": reachable by a non-owner, non-raw member with
 * non-privileged permissions — so for a restricted member the ONLY reason left
 * to refuse it is the funnel scope (403 scope_not_supported). */
export function isDataAction(rule: ActionPolicy): boolean {
  return !rule.ownerOnly && !rule.rawOnly && !rule.fullScopeOnly && !needsPrivileged(rule);
}

/** The 403 codes a restricted member may legitimately get for a non-data action. */
export const NON_SCOPE_DENIALS: ReadonlySet<AccessErrorCode> = new Set<AccessErrorCode>([
  ACCESS_ERROR.OWNER_REQUIRED,
  ACCESS_ERROR.RAW_ACCESS_REQUIRED,
  ACCESS_ERROR.PERMISSION_DENIED,
  ACCESS_ERROR.FULL_SCOPE_REQUIRED,
]);

/** The smallest grant that satisfies the rule's permissions (closed under requires). */
export function minimalGrant(rule: ActionPolicy): string[] {
  const keys = [...(rule.allOf ?? [])];
  if (rule.anyOf?.length) keys.push(rule.anyOf.find((key) => !isPrivilegedPermission(key)) ?? rule.anyOf[0]);
  return closeUnderRequires(keys);
}

/** Body keys a malicious caller adds to name another tenant. */
export const TAMPERED_TENANT_FIELDS = Object.freeze({
  auth_user_id: FOREIGN_TENANT,
  authUserId: FOREIGN_TENANT,
  tenant_key: FOREIGN_TENANT,
  tenantKey: FOREIGN_TENANT,
  data_key: FOREIGN_TENANT,
  workspace_id: FOREIGN_TENANT,
});

/** Body keys a restricted caller adds to name funnel B explicitly (#2 / #3). */
export function withExplicitFunnelB(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const base = body ?? {};
  const filters = base.filters && typeof base.filters === "object" ? (base.filters as Record<string, unknown>) : {};
  return {
    funnel_key: FUNNELS.B.path,
    cohort_key: `${FUNNELS.B.path}|2026-09-01`,
    campaign_path: FUNNELS.B.path,
    funnel_id: FUNNELS.B.id,
    ...base,
    filters: { campaign_path: [FUNNELS.A.path, FUNNELS.B.path], funnel: [FUNNELS.B.path], ...filters },
  };
}

// =====================================================================================
// 5. PGlite workspace: real migrations, real resolve_access, real RLS
// =====================================================================================

export const LOCKDOWN_MIGRATION = "202610050003_access_rls_lockdown.sql";

export interface SeededWorkspace {
  h: SupabasePglite;
  roles: Record<string, string>;
  members: Record<string, string>;
  /** Report ids per author (actor-owned saved objects). */
  reports: { owner: string; viewer: string };
}

export async function one<T = Record<string, unknown>>(tx: SqlRunner, expression: string, params: unknown[] = []): Promise<T> {
  const result = await tx.query<{ value: T }>(`select ${expression} as value`, params);
  return result.rows[0].value;
}

/** Runs `select <expression>` as service_role (what the Edge service client is). */
export function svc<T = Record<string, unknown>>(h: SupabasePglite, expression: string, params: unknown[] = []): Promise<T> {
  return h.asService((tx) => one<T>(tx, expression, params));
}

export const ADD_MEMBER_SQL = "public.access_add_member($1, $2, $3, $4, $5::uuid[], $6)";
export const UPDATE_MEMBER_SQL = "public.access_update_member($1, $2, $3, $4, $5)";
export const SET_SCOPE_SQL = "public.access_set_member_scope($1, $2, $3, $4::uuid[])";
export const CREATE_ROLE_SQL = "public.access_create_role($1, $2, $3, $4, $5::text[])";
export const UPDATE_ROLE_SQL = "public.access_update_role($1, $2, $3, $4, $5::text[])";

/** Tenant rows (one per account) planted before the lockdown, sentinel-valued.
 * Same INSERT shapes as accessRlsLockdown.test.ts. */
const TENANT_ROW_INSERTS: Record<string, string> = {
  transactions: "insert into public.transactions (auth_user_id, transaction_id, event_time) values ($1, $2, now())",
  support_requests: "insert into public.support_requests (auth_user_id, source_row_number, source_hash) values ($1, 1, $2)",
  funnelfox_subscriptions: "insert into public.funnelfox_subscriptions (auth_user_id, subscription_id) values ($1, $2)",
  clickhouse_transaction_sync_state: "insert into public.clickhouse_transaction_sync_state (auth_user_id, sync_name) values ($1, $2)",
  facebook_known_gaps: `insert into public.facebook_known_gaps (auth_user_id, gap_from, gap_to, level, reason)
                        values ($1, current_date, current_date, 'campaign', $2)`,
};

export const TENANT_ROW_TABLES = Object.keys(TENANT_ROW_INSERTS);

const REPORT_INSERT = `insert into public.reports (auth_user_id, title, period_from, period_to, schema_version, engine_version, bindings, snapshot)
                       values ($1, $2, current_date, current_date, 1, 'v1', '{}', '{"kpi": {"net": 1}}') returning id`;

const FORECAST_INSERT = `insert into public.project_forecasts (auth_user_id, name, schema_version, engine_version, source_window_from,
                           source_window_to, source_as_of, bindings, window_ledger, resolved_at)
                         values ($1, $2, 1, 'v1', current_date, current_date, now(), '{}', '{}', now())`;

/** Seeds the workspace through the REAL RPCs: bootstrap (owner = DATA_KEY), the
 * real role templates, and every persona as a member added by the admin. */
export async function seedWorkspace(h: SupabasePglite): Promise<Omit<SeededWorkspace, "h" | "reports">> {
  for (const [name, id] of Object.entries(USER_IDS)) {
    await h.createAuthUser(`${name.toLowerCase()}@example.test`, { id });
  }
  for (const funnel of Object.values(FUNNELS)) {
    await h.db.query("insert into public.funnels (id, funnel_path, display_name) values ($1, $2, $3)", [funnel.id, funnel.rawPath, funnel.name]);
  }
  await h.db.query("select public.bootstrap_workspace($1, 'SubEngine')", [DATA_KEY]);
  await svc(h, "public.access_seed_role_templates($1, $2::jsonb)", [DATA_KEY, JSON.stringify(seedTemplatesPayload())]);
  const roleRows = await h.db.query<{ id: string; key: string }>("select id::text, key from public.access_roles");
  const roles = Object.fromEntries(roleRows.rows.map((row) => [row.key, row.id]));

  const add = async (actor: string, user: string, roleKey: string, mode: ScopeMode, funnelIds: string[] = []) => {
    const email = `${Object.entries(USER_IDS).find(([, id]) => id === user)![0].toLowerCase()}@example.test`;
    const result = await svc<{ member_id: string }>(h, ADD_MEMBER_SQL, [actor, email, roles[roleKey], mode, funnelIds, null]);
    return result.member_id;
  };
  const ownerMember = (await h.db.query<{ id: string }>("select id::text from public.workspace_members where user_id = $1", [DATA_KEY])).rows[0].id;
  const members: Record<string, string> = { owner: ownerMember };
  members.admin = await add(DATA_KEY, USER_IDS.admin, "admin", "all");
  members.viewer = await add(USER_IDS.admin, USER_IDS.viewer, "viewer", "all");
  members.buyerA = await add(USER_IDS.admin, USER_IDS.buyerA, "media_buyer", "selected", [FUNNELS.A.id]);
  members.buyerAB = await add(USER_IDS.admin, USER_IDS.buyerAB, "media_buyer", "selected", [FUNNELS.A.id, FUNNELS.B.id]);
  members.emptyGrant = await add(USER_IDS.admin, USER_IDS.emptyGrant, "viewer", "selected", []);
  members.noRule = await add(USER_IDS.admin, USER_IDS.noRule, "viewer", "none");
  members.disabled = await add(USER_IDS.admin, USER_IDS.disabled, "viewer", "all");
  await svc(h, UPDATE_MEMBER_SQL, [USER_IDS.admin, members.disabled, null, "disabled", null]);
  return { roles, members };
}

/** Plants tenant rows under the data key AND under other accounts (the private
 * copies G1 produced), plus saved objects per author. Run as postgres BEFORE the
 * lockdown, like production data that already exists. */
export async function seedTenantRows(h: SupabasePglite): Promise<SeededWorkspace["reports"]> {
  const accounts = { owner: DATA_KEY, viewer: USER_IDS.viewer, disabled: USER_IDS.disabled, nonMember: USER_IDS.nonMember, buyerA: USER_IDS.buyerA };
  for (const [label, account] of Object.entries(accounts)) {
    for (const [table, insert] of Object.entries(TENANT_ROW_INSERTS)) {
      await h.db.query(insert, [account, `${table}-${label}-${SENTINEL_EMAILS[0]}-${SENTINEL_SPEND}`]);
    }
    await h.db.query(FORECAST_INSERT, [account, `forecast-${label}`]);
  }
  const ownerReport = await h.db.query<{ id: string }>(REPORT_INSERT, [DATA_KEY, "Owner weekly"]);
  const viewerReport = await h.db.query<{ id: string }>(REPORT_INSERT, [USER_IDS.viewer, "Viewer draft"]);
  return { owner: ownerReport.rows[0].id, viewer: viewerReport.rows[0].id };
}

/** The production end state: every migration before the lockdown, the
 * bootstrap + members + data the lockdown finds, the lockdown, and every
 * migration after it ("folded"). Slow (tens of seconds): build once per file. */
export async function createLockedWorkspace(): Promise<SeededWorkspace> {
  const h = await createSupabasePglite({ migrations: listMigrations({ before: LOCKDOWN_MIGRATION }), extensionStubs: true });
  const seeded = await seedWorkspace(h);
  const reports = await seedTenantRows(h);
  for (const name of listMigrations().filter((migration) => migration >= LOCKDOWN_MIGRATION)) {
    await h.applyMigration(name);
  }
  return { h, ...seeded, reports };
}

/** Bearer token understood by pgliteGateDeps: "user:<auth uuid>". */
export const userToken = (userId: string) => `user:${userId}`;

/** Gate dependencies backed by PGlite: getUser trusts "user:<id>" tokens, and
 * resolve_access / workspace_data_key are the REAL SQL functions, called as
 * service_role on every request (nothing is cached between requests). */
export function pgliteGateDeps(
  h: SupabasePglite,
  options: { clickhouse?: RecordingClickHouse; pg?: unknown; secrets?: Record<string, string | undefined>; snapshotState?: CohortSnapshotState | null } = {},
) {
  const clickhouse = options.clickhouse ?? createRecordingClickHouse();
  const rpc = async (expression: string, params: unknown[]) => {
    try {
      return { data: await svc<unknown>(h, expression, params), error: null };
    } catch (error) {
      return { data: null, error };
    }
  };
  const deps = {
    configError: null,
    pg: (options.pg ?? createStrictFakeSupabase({ tenantKey: DATA_KEY, tables: {} })) as AccessGateDeps["pg"],
    getUser: vi.fn(async (token: string) =>
      token.startsWith("user:")
        ? { data: { user: { id: token.slice(5), email: null } }, error: null }
        : { data: { user: null }, error: { name: "AuthApiError", status: 401, message: "invalid JWT" } }),
    loadAccess: vi.fn((userId: string) => rpc("public.resolve_access($1)", [userId])),
    workspaceDataKey: vi.fn(() => rpc("public.workspace_data_key()", [])),
    loadCohortSnapshotState: vi.fn(async (_tenantKey: string) => (options.snapshotState === undefined ? readySnapshotState() : options.snapshotState)),
    readEnv: vi.fn((name: string) => (options.secrets ?? CRON_SECRETS)[name]),
    createClickHouse: vi.fn((ctx: AccessContext) => createScopedReader(ctx, clickhouse)),
    newRequestId: () => "req-pglite",
    log: vi.fn(),
  };
  return { deps, clickhouse };
}

// ---- an AccessAdminStore over PGlite (the `access` handler end to end) --------------

const RPC_ARGS: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = Object.freeze({
  access_add_member: [["p_actor", "uuid"], ["p_email", "text"], ["p_role_id", "uuid"], ["p_scope_mode", "text"], ["p_funnel_ids", "uuid[]"], ["p_display_name", "text"]],
  access_update_member: [["p_actor", "uuid"], ["p_member_id", "uuid"], ["p_role_id", "uuid"], ["p_status", "text"], ["p_display_name", "text"]],
  access_set_member_scope: [["p_actor", "uuid"], ["p_member_id", "uuid"], ["p_mode", "text"], ["p_funnel_ids", "uuid[]"]],
  access_create_role: [["p_actor", "uuid"], ["p_key", "text"], ["p_name", "text"], ["p_description", "text"], ["p_permissions", "text[]"]],
  access_update_role: [["p_actor", "uuid"], ["p_role_id", "uuid"], ["p_name", "text"], ["p_description", "text"], ["p_permissions", "text[]"]],
  access_delete_role: [["p_actor", "uuid"], ["p_role_id", "uuid"]],
  access_seed_role_templates: [["p_actor", "uuid"], ["p_templates", "jsonb"]],
  access_attach_funnel_path: [["p_actor", "uuid"], ["p_funnel_id", "uuid"], ["p_path", "text"], ["p_note", "text"]],
  access_set_funnel_path_status: [["p_actor", "uuid"], ["p_funnel_path_id", "bigint"], ["p_status", "text"], ["p_note", "text"]],
  access_write_audit: [
    ["p_event", "text"], ["p_actor_kind", "text"], ["p_actor_user_id", "uuid"], ["p_target_type", "text"], ["p_target_id", "text"],
    ["p_outcome", "text"], ["p_reason_code", "text"], ["p_before", "jsonb"], ["p_after", "jsonb"], ["p_context", "jsonb"],
  ],
});

/** The production AccessAdminStore contract implemented with SQL as
 * service_role, so createAccessAdminHandler runs against the REAL mutation
 * RPCs (anti-escalation, self-edit, audit) instead of a mock. */
export function createPgliteAccessAdminStore(h: SupabasePglite): AccessAdminStore & { rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> } {
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.asService((tx) => tx.query<T>(sql, params))).rows;
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  return {
    rpcCalls,
    async listMembers(workspaceId, filter = {}) {
      return rows<MemberRow>(
        `select id::text, user_id::text, role_id::text, status, is_data_owner, email_snapshot, display_name,
                access_version::text, added_at::text, last_seen_at::text
         from public.workspace_members where workspace_id = $1 and ($2::uuid is null or id = $2::uuid) order by added_at, id`,
        [workspaceId, filter.memberId ?? null],
      );
    },
    async listRoles(workspaceId) {
      return rows<RoleRow>(
        `select id::text, key, name, description, is_owner, is_system, template_key, permissions
         from public.access_roles where workspace_id = $1 order by id`,
        [workspaceId],
      );
    },
    async listScopeRules(filter = {}) {
      return rows(`select member_id::text, mode from public.member_scope_rules where dimension = 'funnel' and ($1::uuid is null or member_id = $1::uuid)`, [filter.memberId ?? null]);
    },
    async listScopeValues(filter = {}) {
      return rows(
        `select member_id::text, funnel_id::text from public.member_scope_values
         where dimension = 'funnel' and funnel_id is not null and ($1::uuid is null or member_id = $1::uuid) order by id`,
        [filter.memberId ?? null],
      );
    },
    async listFunnels() {
      return rows<FunnelRow>(
        `select f.id::text, f.funnel_path, coalesce(f.display_name, '') as display_name, f.is_active,
                coalesce((select array_agg(t.name order by t.name) from public.funnel_tags ft join public.tags t on t.id = ft.tag_id where ft.funnel_id = f.id), '{}') as tags,
                coalesce((select jsonb_agg(jsonb_build_object(
                           'id', fp.id::text, 'funnel_id', fp.funnel_id::text, 'path', fp.path_canonical, 'status', fp.status, 'source', fp.source,
                           'funnelfox_funnel_id', fp.funnelfox_funnel_id, 'note', fp.note, 'confirmed_at', fp.confirmed_at,
                           'retired_at', fp.retired_at, 'revoked_at', fp.revoked_at) order by fp.id)
                          from public.funnel_paths fp where fp.funnel_id = f.id), '[]'::jsonb) as paths
         from public.funnels f order by f.funnel_path, f.id`,
      );
    },
    async listAuditEvents(query) {
      return rows<AuditRow>(
        `select id::int as id, occurred_at::text, actor_kind, actor_user_id::text, event, target_type, target_id, outcome,
                reason_code, before, after, context
         from public.access_audit_log
         where workspace_id = $1 and ($2::bigint is null or id < $2::bigint) and ($3::text is null or event = $3::text)
           and ($4::text is null or event like $4::text || '.%') and ($5::text is null or outcome = $5::text)
         order by id desc limit $6`,
        [query.workspaceId, query.beforeId, query.event, query.eventPrefix, query.outcome, query.limit + 1],
      );
    },
    async rpc(fn, params) {
      rpcCalls.push({ fn, params: { ...params } });
      const args = RPC_ARGS[fn];
      if (!args) return { data: null, error: { message: `unknown rpc ${fn}` } };
      const sql = `select public.${fn}(${args.map(([name, type], index) => `${name} => $${index + 1}::${type}`).join(", ")}) as value`;
      const values = args.map(([name, type]) => {
        const value = params[name];
        if (value === undefined || value === null) return null;
        return type === "jsonb" ? JSON.stringify(value) : value;
      });
      try {
        const result = await h.asService((tx) => tx.query<{ value: unknown }>(sql, values));
        return { data: result.rows[0]?.value ?? null, error: null };
      } catch (error) {
        const shaped = error as { code?: string; message?: string };
        return { data: null, error: { code: shaped.code ?? "", message: shaped.message ?? String(error) } };
      }
    },
    async setUserBan() {
      return { ok: true };
    },
  };
}

// =====================================================================================
// 6. access Phase 2: a restricted read end to end
// =====================================================================================
//
// The semantic Phase-2 tests (T01-T06, H1 / H2 / H4, the column lint) send a
// persona through the REAL gate, a replica of the function's router (index.ts
// imports esm.sh; each replica mirrors its router line for line, and
// securityMandatory pins the restricted lines of every router source), the REAL
// runners and the REAL restricted ScopedReader, down to a fixture warehouse that
// answers each statement by the funnel scope the statement CARRIES:
//   * the scoped-users predicate (txFrom / cohortsFrom / ... fragments) and the
//     visible-campaigns predicate (fbFrom / campaignScopeVisibleFrom) are decoded
//     from their unhex(...) literals; synthetic unknown_user_ ids never pass a
//     scoped-users predicate;
//   * a statement without a fragment (the owner's) sees every fixture row, and
//     its tenant-wide counters are TENANT_COUNT_SENTINEL, which no restricted
//     body may carry;
//   * the filter params the runners bind (p_mcp_* / p_mcpx_* include / exclude,
//     p_camp_* / p_buyer_* / p_acct_*) apply on top, as the real WHERE would.
// A runner that scoped the wrong paths, dropped a fragment or bound funnel B
// therefore serves funnel B here. Numeric parity with the real warehouse is
// proven live only (scripts/scope-parity-check.mjs, README runbook).

/** A tenant-wide counter only the owner may see ("987654" is a leak-scan form). */
export const TENANT_COUNT_SENTINEL = 987654;

export const SCOPE_DAYS = ["2026-09-01", "2026-09-02"] as const;
const [DAY_1, DAY_2] = SCOPE_DAYS;
const UNKNOWN_PATH = "unknown";
const FIXTURE_SERVICE_ROLE_KEY = "fixture-service-role-key";

export interface ScopeFixtureCustomer {
  id: string;
  email: string;
  /** Anchor campaign_path of fact_user_cohorts. */
  path: string;
  funnel: string;
  cohortDate: string;
  campaignId: string;
  gross: number;
  refund: number;
}

const FUNNEL_OF: Readonly<Record<string, string>> = { [FUNNELS.A.path]: "soulmate", [FUNNELS.B.path]: "past_life", [FUNNELS.C.path]: "palm", [UNKNOWN_PATH]: "Unknown" };

const customer = (id: string, path: string, campaignId: string, cohortDate: string, gross: number, extra: Partial<ScopeFixtureCustomer> = {}): ScopeFixtureCustomer => ({
  id, email: `${id}@scope-fixture.test`, path, funnel: FUNNEL_OF[path], cohortDate, campaignId, gross, refund: 0, ...extra,
});

/** The customers of the fixture warehouse (non-synthetic ones feed the campaign scope). */
export const SCOPE_CUSTOMERS: readonly ScopeFixtureCustomer[] = Object.freeze([
  // Funnel A: fb_a resolves to A; fb_mixed is shared with B; fb_thin has too little evidence.
  customer("cust-a1", FUNNELS.A.path, "fb_a", DAY_1, 10),
  customer("cust-a2", FUNNELS.A.path, "fb_a", DAY_1, 20, { refund: 5 }),
  customer("cust-a3", FUNNELS.A.path, "fb_a", DAY_2, 30),
  customer("cust-a4", FUNNELS.A.path, "fb_mixed", DAY_1, 40),
  customer("cust-a5", FUNNELS.A.path, "fb_mixed", DAY_2, 50),
  customer("cust-a6", FUNNELS.A.path, "fb_mixed", DAY_2, 60),
  customer("cust-a7", FUNNELS.A.path, "fb_thin", DAY_1, 70),
  customer("cust-a8", FUNNELS.A.path, "fb_thin", DAY_2, 80),
  // A synthetic palmer id anchored to A: scope all only (spec §3.2 SU).
  customer("unknown_user_1", FUNNELS.A.path, "fb_a", DAY_1, 5),
  // Funnel B: fb_b resolves to B; two B customers carry the e-mail sentinels.
  customer("cust-b1", FUNNELS.B.path, "fb_b", DAY_1, 100, { email: SENTINEL_EMAILS[0] }),
  customer("cust-b2", FUNNELS.B.path, "fb_b", DAY_1, 200, { email: SENTINEL_EMAILS[1] }),
  customer("cust-b3", FUNNELS.B.path, "fb_b", DAY_2, 300),
  customer("cust-b4", FUNNELS.B.path, "fb_mixed", DAY_1, 400),
  customer("cust-b5", FUNNELS.B.path, "fb_mixed", DAY_2, 500),
  customer("cust-b6", FUNNELS.B.path, "fb_mixed", DAY_2, 600),
  // Funnel C, and customers without a scopable anchor (path 'unknown').
  customer("cust-c1", FUNNELS.C.path, "fb_c", DAY_1, 1000),
  customer("cust-c2", FUNNELS.C.path, "fb_c", DAY_1, 1000),
  customer("cust-c3", FUNNELS.C.path, "fb_c", DAY_2, 1000),
  customer("cust-u1", UNKNOWN_PATH, "fb_unknown", DAY_1, 2000),
  customer("cust-u2", UNKNOWN_PATH, "fb_unknown", DAY_1, 2000),
  customer("cust-u3", UNKNOWN_PATH, "fb_unknown", DAY_2, 2000),
]);

export const isSyntheticCustomer = (entry: ScopeFixtureCustomer) => entry.id.startsWith("unknown_user_");

export interface ScopeFixtureCampaign {
  id: string;
  name: string;
  buyer: string;
  account: string;
  /** Spend per SCOPE_DAYS entry. */
  spend: readonly [number, number];
  /** The fact_campaign_scope row the REAL classifier derives from the anchors. */
  scope: CampaignScopeRow;
}

const CAMPAIGN_INFO: Record<string, Omit<ScopeFixtureCampaign, "id" | "scope" | "account">> = {
  fb_a: { name: "Soulmate prospecting", buyer: "Alice", spend: [100, 100] },
  fb_b: { name: "past-life prospecting", buyer: "Bob", spend: [200, 200] },
  // Shared by A and B (owner decision 3: hidden from every restricted member).
  fb_mixed: { name: "past_life_b_sentinel shared retargeting", buyer: "Mallory", spend: [SENTINEL_SPEND, 0] },
  fb_thin: { name: "Soulmate thin test", buyer: "Alice", spend: [5, 5] },
  fb_c: { name: "Palm prospecting", buyer: "Carol", spend: [300, 300] },
  fb_unknown: { name: "Unattributed traffic", buyer: "Dave", spend: [7, 7] },
};

/** fact_campaign_scope as buildCampaignScope would write it: the evidence query
 * (non-synthetic anchors, users per campaign × path) through classifyCampaignScope. */
const CAMPAIGN_SCOPE_ROWS = classifyCampaignScope(
  [...groupBy(SCOPE_CUSTOMERS.filter((entry) => !isSyntheticCustomer(entry)), (entry) => `${entry.campaignId}|${entry.path}`).values()]
    .map((list) => ({ campaign_id: list[0].campaignId, campaign_path: list[0].path, users: list.length })),
  {},
);

export const SCOPE_CAMPAIGNS: readonly ScopeFixtureCampaign[] = Object.freeze(CAMPAIGN_SCOPE_ROWS.map((row) => ({
  id: row.campaign_id,
  account: "act_shared",
  ...CAMPAIGN_INFO[row.campaign_id],
  scope: row,
})));

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return groups;
}

const sumOf = <T>(items: readonly T[], value: (item: T) => number) => items.reduce((total, item) => total + value(item), 0);

// ---- decoding the scope a statement carries -------------------------------------------

const UNHEX_LIST = String.raw`((?:unhex\('[0-9a-f]*'\)(?:, )?)+)`;
/** scopeSql.ts scopedUserPredicates: `AND <paths> AND NOT startsWith(canonical_user_id, 'unknown_user_')`. */
const SCOPED_USERS_PREDICATE = new RegExp(String.raw`AND (?:campaign_path IN \(${UNHEX_LIST}\)|0) AND NOT startsWith\(canonical_user_id, 'unknown_user_'\)`, "g");
/** scopeSql.ts campaignScopeVisibleFrom: `status = 'resolved' AND <paths>`. */
const VISIBLE_CAMPAIGNS_PREDICATE = new RegExp(String.raw`status = 'resolved' AND (?:campaign_path IN \(${UNHEX_LIST}\)|0)`, "g");

function predicatePaths(sql: string, pattern: RegExp): Set<string> | null {
  let found = false;
  const paths = new Set<string>();
  for (const match of sql.matchAll(pattern)) {
    found = true;
    for (const path of unhexLiterals(match[1] ?? "")) paths.add(path);
  }
  return found ? paths : null;
}

/** The anchor paths a statement's scoped-users fragments admit; null = no such
 * fragment (an owner statement). An empty set is the `0` predicate. */
export const scopedUserPathsOf = (sql: string): Set<string> | null => predicatePaths(sql, SCOPED_USERS_PREDICATE);
/** The paths a statement's visible-campaigns fragments admit (resolved campaigns only); null = none. */
export const visibleCampaignPathsOf = (sql: string): Set<string> | null => predicatePaths(sql, VISIBLE_CAMPAIGNS_PREDICATE);

/** The values bound as p_<prefix>_0, p_<prefix>_1, ... (null = not bound). */
export function boundList(params: Record<string, unknown>, prefix: string): string[] | null {
  const pattern = new RegExp(`^p_${prefix}_\\d+$`);
  const values = Object.entries(params).filter(([key]) => pattern.test(key)).map(([, value]) => String(value));
  return values.length ? values : null;
}

function customersOf(statement: RecordedStatement, applyFilters = true): ScopeFixtureCustomer[] {
  const scoped = scopedUserPathsOf(statement.query);
  let rows = SCOPE_CUSTOMERS.filter((entry) => scoped === null || (scoped.has(entry.path) && !isSyntheticCustomer(entry)));
  if (!applyFilters) return rows;
  const include = boundList(statement.params, "mcp");
  const exclude = boundList(statement.params, "mcpx");
  if (include) rows = rows.filter((entry) => include.includes(entry.path));
  if (exclude) rows = rows.filter((entry) => !exclude.includes(entry.path));
  return rows;
}

function campaignsOf(statement: RecordedStatement): ScopeFixtureCampaign[] {
  const visible = visibleCampaignPathsOf(statement.query);
  let rows = SCOPE_CAMPAIGNS.filter((campaign) => visible === null || (campaign.scope.status === "resolved" && visible.has(campaign.scope.campaign_path)));
  for (const [prefix, field] of [["camp", "id"], ["buyer", "buyer"], ["acct", "account"]] as const) {
    const bound = boundList(statement.params, prefix);
    if (bound) rows = rows.filter((campaign) => bound.includes(campaign[field]));
  }
  return rows;
}

const campaignSpend = (campaign: ScopeFixtureCampaign) => campaign.spend[0] + campaign.spend[1];

function metricSums(campaigns: readonly ScopeFixtureCampaign[], spend = sumOf(campaigns, campaignSpend)) {
  const n = campaigns.length;
  return { spend, impressions: 1000 * n, clicks: 10 * n, outbound_clicks: 5 * n, fb_purchases: 2 * n, purchase_value: 50 * n, reach: 800 * n, link_clicks: 8 * n };
}

function revenueDay(day: string, list: readonly ScopeFixtureCustomer[]) {
  const gross = sumOf(list, (entry) => entry.gross);
  const refunds = sumOf(list, (entry) => entry.refund);
  return {
    day, gross, refunds, gross_new_day: gross, gross_new_week: gross, gross_new_month: gross,
    refunds_new_day: refunds, refunds_new_week: refunds, refunds_new_month: refunds, future_cohort_gross: 0,
    type_trial: gross, type_first_sub: 0, type_renewals: 0, type_upsells: 0, type_tokens: 0,
    paying_users: list.length, new_paying_users_day: list.length, new_paying_users_week: list.length, new_paying_users_month: list.length,
    rows_scanned: list.length,
  };
}

function revenueSlice(key: string, list: readonly ScopeFixtureCustomer[]) {
  const gross = sumOf(list, (entry) => entry.gross);
  return { key, gross, net: gross - sumOf(list, (entry) => entry.refund), gross_new: gross, gross_existing: 0 };
}

const counted = (values: readonly string[]) => [...groupBy(values, (value) => value)].map(([value, list]) => ({ value, cnt: list.length }));

/** The fixture warehouse (a ClickHouseResponder): every statement answered by
 * the scope it carries — see the section comment. Statement shapes are matched
 * by the markers the runners' own tests use. */
export function scopeWarehouse(statement: RecordedStatement): unknown[] {
  const sql = statement.query;
  const unscoped = scopedUserPathsOf(sql) === null && visibleCampaignPathsOf(sql) === null;
  const level = String(statement.params.level ?? "campaign");

  // ---- Revenue Intelligence (revenueIntelligence.ts). The unattributed and spend
  // streams have no user grain: they answer the sentinels and must never run
  // for a restricted member.
  if (sql.includes("snapshot_users AS")) return [{ day: DAY_1, cohort: "unattributed", gross: SENTINEL_SPEND, refunds: 0, net: SENTINEL_SPEND, rows_scanned: 1 }];
  if (sql.includes("toString(stat_date) day, sum(spend) spend")) return [{ day: DAY_1, spend: SENTINEL_SPEND }];
  if (sql.includes("FROM fin") && sql.includes("GROUP BY day ORDER BY day")) {
    return [...groupBy(customersOf(statement), (entry) => entry.cohortDate)].map(([day, list]) => revenueDay(day, list));
  }
  if (sql.includes("SELECT c_camp key")) return [...groupBy(customersOf(statement), (entry) => entry.path)].map(([key, list]) => revenueSlice(key, list));
  if (sql.includes("SELECT c_plan key")) {
    const list = customersOf(statement);
    return list.length ? [revenueSlice("$4.99", list)] : [];
  }
  if (sql.includes(") bucket,")) {
    const slice = revenueSlice("d0", customersOf(statement));
    return slice.gross ? [{ bucket: "d0", gross: slice.gross, net: slice.net }] : [];
  }
  if (sql.includes("toString(c_d) cohort_date")) {
    return [...groupBy(customersOf(statement), (entry) => `${entry.cohortDate}|${entry.path}`)].map(([, list]) => ({
      cohort_date: list[0].cohortDate, campaign_path: list[0].path, ...revenueSlice(list[0].path, list),
      type_trial: sumOf(list, (entry) => entry.gross), type_first_sub: 0, type_renewals: 0, type_upsells: 0, type_tokens: 0,
    }));
  }

  // ---- Cohorts (cohortMembership.ts / cohorts.ts)
  if (sql.includes("scoped AS (SELECT * FROM finx WHERE")) return [];
  if (sql.includes("FROM agg")) {
    return [...groupBy(customersOf(statement), (entry) => `${entry.cohortDate}|${entry.funnel}|${entry.path}`)].map(([, list]) => ({
      cohort_date: list[0].cohortDate, funnel: list[0].funnel, campaign_path: list[0].path,
      trial_users: list.length, gross_raw: sumOf(list, (entry) => entry.gross), refund_raw: sumOf(list, (entry) => entry.refund), support_users: 0,
    }));
  }
  if (sql.includes("'price_plan' dim")) {
    // Options self-exclude their own dimension; the funnel scope is the base.
    const list = customersOf(statement, false);
    return [
      ...counted(list.map((entry) => entry.path)).map((row) => ({ dim: "campaign_path", ...row })),
      ...counted(list.map((entry) => entry.funnel)).map((row) => ({ dim: "funnel", ...row })),
      ...counted(list.map((entry) => entry.campaignId)).map((row) => ({ dim: "campaign_id", ...row })),
    ];
  }
  if (sql.includes("SELECT 1 FROM fact_support_requests FINAL") || sql.includes("SELECT 1 FROM fact_subscriptions FINAL")) return [{ c: 1 }];
  if (sql.includes("FROM system.tables")) return [{ c: 1 }];
  if (sql.includes("FROM fact_subscriptions FINAL WHERE auth_user_id")) return [{ c: TENANT_COUNT_SENTINEL }];
  if (sql.includes("transactions_with_currency")) {
    const total = unscoped ? TENANT_COUNT_SENTINEL : customersOf(statement, false).length;
    return [{
      transactions_total: total, transactions_with_currency: total, transactions_without_currency: 0, transactions_native_usd: total,
      transactions_converted: 0, transactions_missing_fx_rate: 0, transactions_invalid_amount: 0, excluded_amount_original: 0, excluded_transactions: 0,
    }];
  }
  if (sql.includes("FROM normalized_email)) email")) {
    return customersOf(statement, false).map((entry) => ({ email: entry.email, cohort_date: entry.cohortDate, funnel: entry.funnel, campaign_path: entry.path }));
  }
  if (sql.includes("FROM fact_support_requests FINAL") && sql.includes("support_unique_emails")) {
    return [{ support_requests: TENANT_COUNT_SENTINEL, support_unique_emails: TENANT_COUNT_SENTINEL }];
  }

  // ---- Cohorts FB columns (fbCohortStats.ts)
  if (sql.includes("authoritative_user_count")) {
    return [...groupBy(customersOf(statement), (entry) => `${entry.cohortDate}|${entry.funnel}|${entry.path}|${entry.campaignId}`)].map(([, list]) => ({
      cohort_date: list[0].cohortDate, funnel: list[0].funnel, campaign_path: list[0].path, campaign_id: list[0].campaignId, authoritative_user_count: String(list.length),
    }));
  }
  if (sql.includes("snapshot_rows")) {
    const rows = unscoped ? TENANT_COUNT_SENTINEL : customersOf(statement, false).length;
    return [{ snapshot_rows: String(rows), snapshot_unique_users: String(rows), snapshot_duplicate_users: "0" }];
  }
  if (sql.includes("invalid_metric_rows")) {
    return campaignsOf(statement).map((campaign) => ({
      campaign_id: campaign.id, ad_account_id: campaign.account, currency: "USD", currency_count: 1, ad_account_count: 1,
      period_date_from: DAY_1, period_date_to: DAY_2, spend: campaignSpend(campaign), purchases: 2,
    }));
  }
  if (sql.includes("raw_rows")) {
    const rows = unscoped ? TENANT_COUNT_SENTINEL : campaignsOf(statement).length * SCOPE_DAYS.length;
    return [{ raw_rows: String(rows), campaign_day_rows: String(rows), last_stat_date: DAY_2 }];
  }
  if (sql.startsWith("SELECT campaign_id FROM (SELECT campaign_id FROM fact_campaign_scope")) return campaignsOf(statement).map((campaign) => ({ campaign_id: campaign.id }));

  // ---- FB warehouse (facebookStats.ts)
  if (sql.includes("fbc AS (SELECT DISTINCT campaign_id")) {
    const fb = campaignsOf(statement);
    const users = customersOf(statement, false);
    const txCampaigns = new Set(users.map((entry) => entry.campaignId));
    const matched = new Set(fb.filter((campaign) => txCampaigns.has(campaign.id)).map((campaign) => campaign.id));
    const matchedUsers = users.filter((entry) => matched.has(entry.campaignId));
    return [{
      fb_campaigns: fb.length, tx_campaigns: txCampaigns.size, matched_campaigns: matched.size, trial_users: matchedUsers.length,
      tx_gross: sumOf(matchedUsers, (entry) => entry.gross), tx_refunds: sumOf(matchedUsers, (entry) => entry.refund),
    }];
  }
  if (sql.includes("argMax(adset_name, stat_date) adset_name")) {
    const users = customersOf(statement, false);
    return campaignsOf(statement).map((campaign) => {
      const own = users.filter((entry) => entry.campaignId === campaign.id);
      return {
        ad_account_id: campaign.account, campaign_id: campaign.id,
        ...(level === "adset" || level === "ad" ? { adset_id: `${campaign.id}_adset` } : {}),
        ...(level === "ad" ? { ad_id: `${campaign.id}_ad` } : {}),
        ad_account_name: "Shared account", buyer: campaign.buyer, campaign_name: campaign.name,
        adset_name: `${campaign.name} adset`, ad_name: `${campaign.name} ad`,
        first_date: DAY_1, last_date: DAY_2, days: SCOPE_DAYS.length, ...metricSums([campaign]),
        ...(level === "campaign" ? {
          trial_users: own.length, first_sub_users: 0, refund_users: own.filter((entry) => entry.refund > 0).length,
          tx_campaign_path: own[0]?.path ?? "", tx_gross: sumOf(own, (entry) => entry.gross), tx_refunds: sumOf(own, (entry) => entry.refund),
        } : {}),
      };
    });
  }
  if (sql.includes("SELECT toString(stat_date) date,")) {
    const campaigns = campaignsOf(statement);
    return campaigns.length ? SCOPE_DAYS.map((date, index) => ({ date, ...metricSums(campaigns, sumOf(campaigns, (campaign) => campaign.spend[index])) })) : [];
  }
  for (const [marker, field, label] of [["SELECT buyer value", "buyer", null], ["SELECT ad_account_id value", "account", "Shared account"], ["SELECT campaign_id value", "id", "name"]] as const) {
    if (!sql.startsWith(marker)) continue;
    return [...groupBy(campaignsOf(statement), (campaign) => campaign[field])].map(([value, list]) => ({
      value, ...(label ? { label: label === "name" ? list[0].name : label } : {}), spend: sumOf(list, campaignSpend), rows: list.length * SCOPE_DAYS.length,
    }));
  }
  if (sql.startsWith("SELECT toString(min(stat_date)) date_min, toString(max(stat_date)) date_max FROM")) {
    return campaignsOf(statement).length ? [{ date_min: DAY_1, date_max: DAY_2 }] : [];
  }
  if (sql.includes("uniqExact(campaign_id) campaigns")) {
    const campaigns = campaignsOf(statement);
    return [{ ...metricSums(campaigns), accounts: campaigns.length ? 1 : 0, campaigns: campaigns.length, active_days: campaigns.length ? SCOPE_DAYS.length : 0 }];
  }
  if (sql.startsWith("SELECT count() c, toString(min(stat_date))")) {
    const campaigns = campaignsOf(statement);
    return [{ c: unscoped ? TENANT_COUNT_SENTINEL : campaigns.length * SCOPE_DAYS.length, date_min: campaigns.length ? DAY_1 : null, date_max: campaigns.length ? DAY_2 : null }];
  }
  if (sql.startsWith("SELECT count() c FROM")) return [{ c: campaignsOf(statement).length * SCOPE_DAYS.length }];
  return [];
}

// ---- Postgres the runners read (service role) ------------------------------------------

/** Stored sync / snapshot state rows full of tenant-wide counters, raw errors and
 * spend sentinels: a restricted body must carry none of them. */
export const SCOPE_STATE_ROWS = Object.freeze({
  fbSync: {
    auth_user_id: DATA_KEY, sync_name: "fact_facebook_stats_sync", status: "completed", current_stage: "done", stopped_reason: null,
    last_run_mode: "incremental", cursor_transaction_id: DAY_2, cursor_updated_at: "2026-09-03T00:00:00.000Z",
    started_at: "2026-09-03T00:00:00.000Z", finished_at: "2026-09-03T00:01:00.000Z", duration_ms: 60_000, updated_at: "2026-09-03T00:01:00.000Z",
    clickhouse_total: TENANT_COUNT_SENTINEL, source_total: TENANT_COUNT_SENTINEL, last_error: SENTINEL_CLICKHOUSE_ERROR,
    diagnostics: {
      mode: "incremental", fb_stats_to: DAY_2, day_spend_total: SENTINEL_SPEND, spend_by_level: { campaign: SENTINEL_SPEND },
      spend_mismatch: { campaign: SENTINEL_SPEND }, validation_status: "PASSED", private_note: SENTINEL_EMAILS[0],
    },
  },
  transactionsBackfill: {
    auth_user_id: DATA_KEY, sync_name: "analytics_transactions_backfill", status: "completed", cursor_transaction_id: `tx-${SENTINEL_EMAILS[0]}`,
    cursor_updated_at: "2026-09-03T00:00:00.000Z", clickhouse_total: TENANT_COUNT_SENTINEL, source_total: TENANT_COUNT_SENTINEL, last_error: SENTINEL_CLICKHOUSE_ERROR,
  },
  supportSync: {
    auth_user_id: DATA_KEY, sync_name: "fact_support_requests_sync", status: "completed", cursor_transaction_id: "support-cursor",
    cursor_updated_at: "2026-09-03T00:00:00.000Z", clickhouse_total: TENANT_COUNT_SENTINEL,
    diagnostics: { attribution: { attribution_version: "v1", funnel_matched: TENANT_COUNT_SENTINEL, unknown: TENANT_COUNT_SENTINEL } },
  },
});

/** The validated, fresh snapshot of the fixture warehouse — carrying tenant-wide
 * build counters the restricted diagnostics must redact. */
export function scopeSnapshotState(overrides: Partial<CohortSnapshotState> = {}): CohortSnapshotState {
  return readySnapshotState({
    users_classified: TENANT_COUNT_SENTINEL,
    rows_inserted: TENANT_COUNT_SENTINEL,
    source_transactions: TENANT_COUNT_SENTINEL,
    source_unique_users: TENANT_COUNT_SENTINEL,
    diagnostics: { validation: { ...READY_SNAPSHOT_PASS }, warehouse: { transactions: TENANT_COUNT_SENTINEL } },
    ...overrides,
  });
}

/** The service-role Postgres of a fixture read: strict (every read keyed by the
 * data key), with the state rows above and the FunnelFox active-subscription
 * RPC answering every fixture customer (funnel B's sentinel e-mails included). */
export function scopeWarehousePg(actorKey: string): StrictFakeSupabase {
  return createStrictFakeSupabase({
    tenantKey: DATA_KEY,
    actorKey,
    tables: {
      clickhouse_cohort_snapshot_state: { scope: "tenant", owner: "auth_user_id", rows: [scopeSnapshotState() as unknown as Record<string, unknown>] },
      clickhouse_transaction_sync_state: { scope: "tenant", owner: "auth_user_id", rows: Object.values(SCOPE_STATE_ROWS).map((row) => ({ ...row })) },
      facebook_campaign_mapping: { scope: "tenant", owner: "auth_user_id", rows: [] },
    },
    rpc: {
      active_funnelfox_subscription_emails: {
        tenantParam: "p_data_key",
        handler: () => ({ data: Object.fromEntries(SCOPE_CUSTOMERS.map((entry) => [entry.email, [`sub-${entry.id}`]])), error: null }),
      },
    },
  });
}

// ---- router replicas ---------------------------------------------------------------------

const asSupabase = (pg: unknown) => pg as SupabaseLikeClient;

/** FN/clickhouse-cohorts/index.ts without Deno and the timeouts. The owner branch
 * keeps its dynamic fallbacks; FB_COHORT_ALLOCATION_DIAGNOSTICS_ENABLED is off. */
const cohortsRouter: AccessHandler<string> = async ({ ctx, action, body, pg, clickhouse, scope }) => {
  const authUserId = ctx.tenantKey;
  const ch = clickhouse();
  const supabase = asSupabase(pg);
  if (ctx.restricted) {
    const { request, dropped } = restrictCohortRequest(scope, body);
    if (action === "details") {
      return projectCohortsResponseForRestricted(await runMaterializedCohortDetails({ authUserId, clickhouse: ch, request, scope, detailedErrors: false }), dropped);
    }
    const result = action === "options"
      ? await runMaterializedCohortOptions({ authUserId, supabase, clickhouse: ch, request, scope })
      : await runMaterializedCohortList({ authUserId, supabase, clickhouse: ch, request, scope, allocationDiagnosticsEnabled: false });
    if (!result) throw new ScopeSnapshotNotReadyError("snapshot_missing");
    await pseudonymizeActiveIdentities(result.rows, await createKeyedHasher(FIXTURE_SERVICE_ROLE_KEY, cohortIdentityHashLabel(authUserId)));
    return projectCohortsResponseForRestricted(result, dropped);
  }
  const request = body as CohortRequest;
  if (action === "options") {
    return (await runMaterializedCohortOptions({ authUserId, supabase, clickhouse: ch, request })) ?? await runCohortOptions({ authUserId, clickhouse: ch, request });
  }
  if (action === "details") return runCohortDetails({ authUserId, clickhouse: ch, request, detailedErrors: cohortDetailedErrorsVisible(ctx) });
  const result = (await runMaterializedCohortList({ authUserId, supabase, clickhouse: ch, request, allocationDiagnosticsEnabled: false }))
    ?? await runCohortList({ authUserId, clickhouse: ch, request, supabase });
  if (!cohortIdentitiesVisible(ctx)) {
    await pseudonymizeActiveIdentities(result.rows, await createKeyedHasher(FIXTURE_SERVICE_ROLE_KEY, cohortIdentityHashLabel(authUserId)));
  }
  return result;
};

/** FN/clickhouse-revenue/index.ts without Deno and the timeouts. */
const revenueRouter: AccessHandler<string> = async ({ ctx, action, body, pg, clickhouse, scope }) => {
  const shaped = ctx.restricted ? restrictRevenueRequest(scope, body) : { request: body as RevenueIntelligenceRequest, dropped: 0 };
  const common = { authUserId: ctx.tenantKey, supabase: asSupabase(pg), clickhouse: clickhouse(), request: shaped.request, scope };
  const result = action === "day_breakdown" ? await runRevenueDayBreakdown(common) : await runRevenueIntelligence(common);
  return ctx.restricted ? withRestrictedMeta(result, shaped.dropped) : result;
};

/** The read actions of FN/clickhouse-facebook/index.ts (status, report, list,
 * charts, filters, summary) without Deno and the timeouts. */
const facebookRouter: AccessHandler<string> = async ({ ctx, action, body, pg, clickhouse, scope }) => {
  const authUserId = ctx.tenantKey;
  const ch = clickhouse();
  const supabase = asSupabase(pg);
  const responseAction = fbResponseAction(body);
  const request = body as FbReadRequest;
  try {
    if (action === "status") {
      const level = normalizeFbLevel(request.level);
      if (ctx.restricted) assertFbLevelInScope(scope, level);
      const [state, diagnostics] = await Promise.all([
        getFbSyncState(supabase, authUserId).catch((error) => {
          if (error instanceof ScopeViolation) throw error;
          return null;
        }),
        buildFbDiagnostics({ clickhouse: ch, supabase, authUserId, level, filters: normalizeFbFilters(request), scope }),
      ]);
      const visibleState = ctx.restricted
        ? projectFbSyncStateForRestricted(state)
        : fbStatusDetailVisible(ctx) ? state : projectFbSyncStateForViewer(state);
      return { ok: true, action: responseAction, state: visibleState, diagnostics };
    }
    if (ctx.restricted && action !== "filters") assertFbLevelInScope(scope, normalizeFbLevel(request.level));
    if (action === "report") return { ...(await runFbReport({ clickhouse: ch, supabase, authUserId, request, scope })), action: "report" };
    if (action === "list") return { ok: true, action: responseAction, ...(await runFbList(ch, authUserId, request, scope)) };
    if (action === "charts") return { ok: true, action: responseAction, charts: await runFbCharts(ch, authUserId, request, scope) };
    if (action === "filters") return { ok: true, action: responseAction, filter_options: await runFbFilterOptions(ch, authUserId, request, scope) };
    if (action === "summary") {
      const result = await runFbReport({ clickhouse: ch, supabase, authUserId, request, scope });
      return { ok: true, action: responseAction, summary: result.summary, diagnostics: result.diagnostics };
    }
    throw new FbActionError(400, { ok: false, error: `Unsupported action in the fixture router: ${responseAction}` });
  } catch (error) {
    if (error instanceof ScopeViolation || error instanceof FbActionError || error instanceof ScopeForbiddenError || error instanceof ScopeSnapshotNotReadyError) throw error;
    const mapped = fbWarehouseErrorResponse(error, responseAction);
    throw new FbActionError(mapped.status, mapped.body);
  }
};

/** The member branch of FN/clickhouse-summary/index.ts (no ClickHouse at all). */
const summaryRouter: AccessHandler<string> = async ({ ctx, pg }) => {
  if (summaryKpisVisible(ctx)) throw new Error("the KPI branch (raw access / admin.diagnostics.view) is outside the fixture router");
  const supabase = asSupabase(pg);
  const orNull = (error: unknown) => {
    if (error instanceof ScopeViolation) throw error;
    return null;
  };
  const [syncState, cohortSnapshotState, supportSyncState] = await Promise.all([
    getTransactionSyncState(supabase, ctx.tenantKey).catch(orNull),
    getCohortSnapshotStateRow(supabase, ctx.tenantKey).catch(orNull),
    getSupportSyncState(supabase, ctx.tenantKey).catch(orNull),
  ]);
  const hasher = await createKeyedHasher(FIXTURE_SERVICE_ROLE_KEY, summaryVersionHashLabel(ctx.tenantKey));
  return memberWarehouseSummary({ hasher, syncState, cohortSnapshotState, supportSyncState });
};

/** The router of every function with a scopeReady action, with its onError. */
export const ROUTER_REPLICAS: Readonly<Record<string, { handler: AccessHandler<string>; onError?: ServeWithAccessOptions["onError"] }>> = Object.freeze({
  "clickhouse-cohorts": { handler: cohortsRouter, onError: cohortsErrorResponse },
  "clickhouse-revenue": {
    handler: revenueRouter,
    onError: (error: unknown) => ({
      status: error instanceof RevenueRequestError ? 400 : 502,
      body: { ok: false, source: "clickhouse", error: error instanceof Error ? error.message : "ClickHouse revenue query failed." },
    }),
  },
  "clickhouse-facebook": { handler: facebookRouter, onError: clickHouseFacebookErrorResponse },
  "clickhouse-summary": { handler: summaryRouter },
});

/** One in-scope request (for buyer-{A}) per scopeReady action: the corpus of the
 * column lint and of the "every scopeReady action" side-channel scans. */
export const SCOPE_READY_REQUESTS: Readonly<Record<string, Record<string, unknown>>> = Object.freeze({
  "clickhouse-cohorts.list": {
    action: "list", date_from: DAY_1, date_to: DAY_2,
    filters: { campaign_path: [FUNNELS.A.path], country: ["US"], media_buyer: ["Alice", "utm:facebook"] },
  },
  "clickhouse-cohorts.options": { action: "options", date_from: DAY_1, date_to: DAY_2, filters: { country: ["US"] } },
  "clickhouse-cohorts.details": { action: "details", cohort_key: { cohort_date: DAY_1, funnel: FUNNEL_OF[FUNNELS.A.path], campaign_path: FUNNELS.A.path } },
  "clickhouse-revenue.bundle": { action: "bundle", date_from: DAY_1, date_to: "2026-09-30", filters: { media_buyer: ["utm:facebook"] } },
  "clickhouse-revenue.day_breakdown": { action: "day_breakdown", date: DAY_1 },
  "clickhouse-summary.summary": {},
  "clickhouse-facebook.report": { action: "report", level: "campaign", filters: { date_from: DAY_1, date_to: DAY_2 } },
  "clickhouse-facebook.list": { action: "list", level: "adset", filters: { date_from: DAY_1, date_to: DAY_2 } },
  "clickhouse-facebook.charts": { action: "charts", level: "ad" },
  "clickhouse-facebook.filters": { action: "filters", filters: { buyer: ["Alice"] } },
  "clickhouse-facebook.summary": { action: "summary", level: "campaign" },
  "clickhouse-facebook.status": { action: "status", level: "campaign" },
});

export interface RouterRead extends GateCallResult {
  clickhouse: RecordingClickHouse;
  pg: StrictFakeSupabase;
  deps: FakeGate["deps"];
}

/** A request of `persona` through the gate, the function's router replica, the
 * real runners and the fixture warehouse. */
export async function readThroughRouter(
  persona: Persona,
  fn: string,
  body: Record<string, unknown>,
  options: { snapshotState?: CohortSnapshotState | null } = {},
): Promise<RouterRead> {
  const replica = ROUTER_REPLICAS[fn];
  if (!replica) throw new Error(`no router replica for ${fn}`);
  const clickhouse = createRecordingClickHouse(scopeWarehouse);
  const pg = scopeWarehousePg(persona.userId);
  const { deps } = fakeGate({
    persona,
    clickhouse,
    pg,
    snapshotState: options.snapshotState === undefined ? scopeSnapshotState() : options.snapshotState,
  });
  const result = await callGate(policyFor(fn), replica.handler, edgeRequest({ fn, body }).req, deps, replica.onError ? { onError: replica.onError } : undefined);
  return { ...result, clickhouse, pg, deps };
}

/** Every statement the scopeReady actions send to the warehouse for `persona`
 * (one in-scope request each, SCOPE_READY_REQUESTS). Throws unless each is a 200. */
export async function restrictedStatementCorpus(persona: Persona = PERSONAS.buyerA): Promise<RecordedStatement[]> {
  const statements: RecordedStatement[] = [];
  for (const [key, body] of Object.entries(SCOPE_READY_REQUESTS)) {
    const fn = key.slice(0, key.lastIndexOf("."));
    const result = await readThroughRouter(persona, fn, body);
    if (result.status !== 200) throw new Error(`${key} for ${persona.name}: ${result.status} ${result.text.slice(0, 300)}`);
    statements.push(...result.clickhouse.statements);
  }
  return statements;
}
