import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

// Admin → Access UI (plan §15-§17, §24) against SHARED CONTRACT A. The Edge
// function is replaced by an in-memory fake behind supabase.functions.invoke,
// so the client, the hooks and the pages run for real.

type Json = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; body: Record<string, unknown>; headers: Record<string, string> }>,
  handler: null as null | ((action: string, body: Record<string, unknown>) => { status?: number; body: unknown }),
}));

vi.mock("@/services/supabaseClient", () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "token-1" } }, error: null }) },
    functions: {
      invoke: async (fn: string, options: { body: Record<string, unknown>; headers: Record<string, string> }) => {
        backend.calls.push({ fn, body: options.body, headers: options.headers });
        const result = backend.handler ? backend.handler(String(options.body.action), options.body) : { status: 500, body: { ok: false, error: "no handler" } };
        const status = result.status ?? 200;
        if (status >= 200 && status < 300) return { data: result.body, error: null };
        const error = Object.assign(new Error("Edge Function returned a non-2xx status code"), {
          context: new Response(JSON.stringify(result.body), { status, headers: { "content-type": "application/json" } }),
        });
        return { data: null, error };
      },
    },
  },
}));

vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) =>
      React.createElement(
        "div",
        null,
        React.createElement("h1", null, title),
        React.createElement("div", { "data-testid": "layout-actions" }, actions),
        children,
      ),
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { ROUTE_ACCESS } from "@/services/accessRoutes";
import { isAccessError } from "@/services/clickhouse";
import {
  AccessAdminRequestError,
  describeAccessAdminError,
  fetchMemberEffectiveAccess,
  listAccessFunnels,
  listAccessMembers,
  listAccessAudit,
  updateAccessRole,
  type AdminFunnelPath,
  type AdminMember,
  type AdminRole,
  type EffectiveAccess,
  type FunnelCoverage,
} from "@/services/accessAdminClient";
import {
  actorFromAccess,
  auditEventLabel,
  canonicalCampaignPath,
  computeScopeImpact,
  defaultRoleId,
  describeAuditChanges,
  formatLastActive,
  formatPct,
  funnelScopeLabel,
  grantableSubset,
  memberEditBlockReason,
  planMemberSave,
  previewPages,
  roleAssignBlockReason,
  roleDeleteBlockReason,
  roleEditBlockReason,
  scopeImpactSummary,
  scopeWithoutData,
  togglePermission,
  type AdminActor,
  type AuditLookups,
} from "@/components/admin/accessAdminModel";
import { EffectiveAccessPanel } from "@/components/admin/EffectiveAccessPanel";
import { FunnelScopePicker } from "@/components/admin/FunnelScopePicker";
import AdminMembersPage from "@/pages/admin/AdminMembers";
import AdminRolesPage from "@/pages/admin/AdminRoles";
import AdminAuditPage from "@/pages/admin/AdminAudit";
import {
  ENFORCED_PERMISSION_KEYS,
  PERMISSION_CATALOG,
  effectivePermissions,
} from "../../supabase/functions/_shared/access/permissions.ts";
import { ROLE_TEMPLATES } from "../../supabase/functions/_shared/access/roles.ts";

// jsdom gaps used by cmdk / Radix.
beforeAll(() => {
  if (!("ResizeObserver" in window)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.assign(window, { ResizeObserver: ResizeObserverStub });
    Object.assign(globalThis, { ResizeObserver: ResizeObserverStub });
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
});

// ---- fixtures ---------------------------------------------------------------------------

const VIEWER_KEYS = ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"];

function roleRow(overrides: Partial<AdminRole> & Pick<AdminRole, "id" | "key" | "name">): AdminRole {
  return {
    description: "",
    is_owner: false,
    is_system: false,
    template_key: null,
    permissions: [],
    member_count: 0,
    new_permissions_available: 0,
    new_permission_keys: [],
    ...overrides,
  };
}

const OWNER_ROLE = roleRow({ id: "r-owner", key: "owner", name: "Owner", is_owner: true, is_system: true, permissions: [...ENFORCED_PERMISSION_KEYS], member_count: 1 });
const ADMIN_ROLE = roleRow({ id: "r-admin", key: "admin", name: "Admin", template_key: "admin", permissions: [...ENFORCED_PERMISSION_KEYS], member_count: 1 });
const VIEWER_ROLE = roleRow({
  id: "r-viewer",
  key: "viewer",
  name: "Viewer",
  template_key: "viewer",
  permissions: ["dashboard.view", "cohorts.view", "funnels.view"],
  member_count: 2,
  new_permissions_available: 1,
  new_permission_keys: ["reports.view"],
});
const ANALYST_ROLE = roleRow({ id: "r-analyst", key: "analyst", name: "Analyst", permissions: ["dashboard.view", "cohorts.view", "cohorts.export"], member_count: 0 });

function memberRow(overrides: Partial<AdminMember> & Pick<AdminMember, "id" | "user_id" | "email">): AdminMember {
  return {
    display_name: "",
    status: "active",
    is_data_owner: false,
    role: { id: VIEWER_ROLE.id, key: VIEWER_ROLE.key, name: VIEWER_ROLE.name, is_owner: false },
    funnel_scope: { mode: "all", funnel_ids: [] },
    last_seen_at: null,
    access_version: "1",
    added_at: "2026-10-01T00:00:00Z",
    ...overrides,
  };
}

function funnelPath(id: string, funnelId: string, path: string, status: AdminFunnelPath["status"], source: AdminFunnelPath["source"] = "registry_seed"): AdminFunnelPath {
  const granted = status === "active" || status === "retired";
  return {
    id,
    funnel_id: funnelId,
    path,
    status,
    source,
    funnelfox_funnel_id: null,
    note: "",
    confirmed_at: granted ? "2026-10-06T00:00:00Z" : null,
    retired_at: status === "retired" ? "2026-09-01T00:00:00Z" : null,
    revoked_at: null,
  };
}

const FUNNELS = [
  {
    id: "f-1",
    funnel_path: "/soulmate-sketch",
    display_name: "Soulmate Sketch",
    is_active: true,
    tags: ["soulmate"],
    paths: [funnelPath("1", "f-1", "soulmate-sketch", "active"), funnelPath("2", "f-1", "soulmate-1-tariff-month-veb", "proposed", "funnelfox_alias_seed")],
  },
  {
    id: "f-2",
    funnel_path: "/past-life",
    display_name: "Past Life",
    is_active: true,
    tags: ["esoteric", "past-life"],
    paths: [funnelPath("3", "f-2", "past-life", "active"), funnelPath("4", "f-2", "past-life-old", "retired")],
  },
  { id: "f-3", funnel_path: "/palm-reading", display_name: "Palm Reading", is_active: true, tags: ["esoteric"], paths: [funnelPath("5", "f-3", "palm-reading", "active")] },
  { id: "f-4", funnel_path: "/old-quiz", display_name: "Old Quiz", is_active: false, tags: [], paths: [] },
];

/** paths.coverage of the fixture registry: 1,000 real users, 90% on granted paths. */
function coverageFixture(): FunnelCoverage {
  const row = (path: string, users: number, net: number, extra: Partial<FunnelCoverage["paths"][number]>): FunnelCoverage["paths"][number] => ({
    path,
    users,
    synthetic_users: 0,
    net_revenue: net,
    first_cohort_date: "2026-01-01",
    last_cohort_date: "2026-10-01",
    state: "unregistered",
    funnel_id: null,
    path_id: null,
    path_status: null,
    proposals: [],
    users_since_retired: null,
    ...extra,
  });
  return {
    ok: true,
    snapshot: { status: "current", warehouse_version: "wh-1", generated_at: "2026-10-06T00:00:00Z" },
    totals: { users: 1000, synthetic_users: 20, registered_users: 900, registered_pct: 90, net_revenue: 50000, registered_net_revenue: 45000 },
    paths: [
      row("soulmate-sketch", 500, 25000, { state: "granted", funnel_id: "f-1", path_id: "1", path_status: "active", synthetic_users: 20 }),
      row("past-life", 300, 15000, { state: "granted", funnel_id: "f-2", path_id: "3", path_status: "active" }),
      row("past-life-old", 100, 5000, { state: "granted", funnel_id: "f-2", path_id: "4", path_status: "retired", users_since_retired: 7 }),
      row("soulmate-1-tariff-month-veb", 60, 3000, { state: "proposed", path_status: "proposed", proposals: [{ path_id: "2", funnel_id: "f-1" }] }),
      row("new-quiz", 30, 1500, {}),
      row("unknown", 10, 500, { state: "unscopable" }),
    ],
    reuse_alerts: [{ path: "past-life-old", funnel_id: "f-2", path_id: "4", retired_at: "2026-09-01T00:00:00Z", users_since_retired: 7 }],
    funnels: [
      { funnel_id: "f-1", users: 500, net_revenue: 25000, granted_paths: 1 },
      { funnel_id: "f-2", users: 400, net_revenue: 20000, granted_paths: 2 },
      { funnel_id: "f-3", users: 0, net_revenue: 0, granted_paths: 1 },
      { funnel_id: "f-4", users: 0, net_revenue: 0, granted_paths: 0 },
    ],
    registry_without_data: ["f-3", "f-4"],
  };
}

function grantedPathsOf(funnelIds: readonly string[]): string[] {
  return [...new Set(FUNNELS.filter((f) => funnelIds.includes(f.id)).flatMap((f) => f.paths.filter((p) => p.status === "active" || p.status === "retired").map((p) => p.path)))].sort();
}

interface FakeState {
  members: AdminMember[];
  roles: AdminRole[];
  audit: Json[];
  /** null ⇒ paths.coverage answers 409 (no validated snapshot). */
  coverage: FunnelCoverage | null;
}

let state: FakeState;

function freshState(): FakeState {
  return {
    roles: [OWNER_ROLE, ADMIN_ROLE, VIEWER_ROLE, ANALYST_ROLE].map((role) => ({ ...role, permissions: [...role.permissions] })),
    members: [
      memberRow({
        id: "m-owner",
        user_id: "u-owner",
        email: "owner@example.com",
        display_name: "Olga Owner",
        is_data_owner: true,
        role: { id: OWNER_ROLE.id, key: "owner", name: "Owner", is_owner: true },
        last_seen_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
      memberRow({
        id: "m-ivan",
        user_id: "u-ivan",
        email: "ivan@example.com",
        display_name: "Ivan Petrov",
        funnel_scope: { mode: "selected", funnel_ids: ["f-1", "f-2", "f-3"] },
      }),
      memberRow({
        id: "m-dmitry",
        user_id: "u-dmitry",
        email: "dmitry@example.com",
        display_name: "Dmitry",
        role: { id: ADMIN_ROLE.id, key: "admin", name: "Admin", is_owner: false },
      }),
      memberRow({ id: "m-lena", user_id: "u-lena", email: "lena@example.com", status: "disabled", funnel_scope: { mode: "none", funnel_ids: [] } }),
    ],
    audit: [],
    coverage: coverageFixture(),
  };
}

function defaultHandler(action: string, body: Record<string, unknown>): { status?: number; body: unknown } {
  const ok = (extra: Json) => ({ body: { ok: true, ...extra } });
  switch (action) {
    case "catalog":
      return ok({ permissions: PERMISSION_CATALOG, templates: ROLE_TEMPLATES });
    case "members.list":
      return ok({ members: state.members });
    case "roles.list":
      return ok({ roles: state.roles });
    case "funnels.list":
      return ok({ funnels: FUNNELS });
    case "paths.coverage":
      return state.coverage ? ok({ ...state.coverage }) : { status: 409, body: { ok: false, error_code: "conflict", error: "The cohort snapshot is not ready." } };
    case "members.effective": {
      const member = state.members.find((entry) => entry.id === body.member_id);
      if (!member) return { status: 404, body: { ok: false, error_code: "not_found", error: "member not found" } };
      const role = state.roles.find((entry) => entry.id === member.role.id);
      const active = member.status === "active";
      const permissions = active && role
        ? [...effectivePermissions({ granted: role.permissions, isOwner: role.is_owner, funnelScopeAll: member.funnel_scope.mode === "all" })]
        : [];
      return ok({
        effective: {
          status: member.status,
          role: member.role,
          permissions,
          raw_access: member.is_data_owner && active,
          funnel_scope: {
            ...member.funnel_scope,
            names: member.funnel_scope.funnel_ids.map((id) => FUNNELS.find((f) => f.id === id)?.display_name ?? id),
            paths: grantedPathsOf(member.funnel_scope.funnel_ids),
          },
        },
      });
    }
    case "members.update": {
      const member = state.members.find((entry) => entry.id === body.member_id) as AdminMember;
      if (typeof body.status === "string") member.status = body.status;
      if (typeof body.display_name === "string") member.display_name = body.display_name;
      if (typeof body.role_id === "string") {
        const role = state.roles.find((entry) => entry.id === body.role_id) as AdminRole;
        member.role = { id: role.id, key: role.key, name: role.name, is_owner: role.is_owner };
      }
      return ok({ changed: true, member });
    }
    case "members.set_scope": {
      const member = state.members.find((entry) => entry.id === body.member_id) as AdminMember;
      member.funnel_scope = { mode: body.mode as AdminMember["funnel_scope"]["mode"], funnel_ids: (body.funnel_ids as string[]) ?? [] };
      return ok({ changed: true, member });
    }
    case "roles.update": {
      const role = state.roles.find((entry) => entry.id === body.role_id) as AdminRole;
      if (Array.isArray(body.permissions)) role.permissions = body.permissions as string[];
      return ok({ changed: true, role });
    }
    case "roles.seed_templates":
      return ok({ created: ["admin", "viewer"], skipped: [] });
    case "audit.list": {
      const before = typeof body.before_id === "number" ? body.before_id : Infinity;
      const rows = state.audit.filter((row) => (row.id as number) < before).sort((a, b) => (b.id as number) - (a.id as number));
      const limit = 2;
      const page = rows.slice(0, limit);
      return ok({ events: page, next_before_id: rows.length > limit ? (page[page.length - 1].id as number) : null });
    }
    default:
      return { status: 400, body: { ok: false, error_code: "unknown_action", error: "Unsupported action." } };
  }
}

// ---- access values ----------------------------------------------------------------------

function okRow(input: { permissions?: string[]; isOwner?: boolean; raw?: boolean; userId?: string; memberId?: string; roleId?: string }): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: input.memberId ?? "m-owner",
    user_id: input.userId ?? "u-owner",
    email: "owner@example.com",
    display_name: null,
    is_data_owner: input.raw === true,
    raw_access: input.raw === true,
    role: { id: input.roleId ?? "r-owner", key: input.isOwner ? "owner" : "custom", name: "Role", is_owner: input.isOwner === true, permissions: input.permissions ?? [] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p-1",
  };
}

const OWNER_ACCESS = () => buildAccessValue({ status: "ok", access: okRow({ isOwner: true, raw: true }), userId: "u-owner" });
const READONLY_ADMIN_ACCESS = () =>
  buildAccessValue({
    status: "ok",
    access: okRow({ permissions: ["admin.users.view", "admin.roles.view", "admin.audit.view"], userId: "u-auditor", memberId: "m-auditor", roleId: "r-auditor" }),
    userId: "u-auditor",
  });

function renderWithAccess(ui: ReactElement, access: AccessContextValue = OWNER_ACCESS(), path = "/admin/members") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AccessContext.Provider value={access}>
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </AccessContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function callsFor(action: string) {
  return backend.calls.filter((call) => call.body.action === action);
}

beforeEach(() => {
  state = freshState();
  backend.calls = [];
  backend.handler = defaultHandler;
});

afterEach(() => {
  cleanup();
});

// ---- client --------------------------------------------------------------------------------

describe("accessAdminClient", () => {
  it("posts {action, ...params} to the access function with the session bearer and parses the result", async () => {
    const members = await listAccessMembers();
    expect(backend.calls).toHaveLength(1);
    expect(backend.calls[0]).toMatchObject({ fn: "access", body: { action: "members.list" }, headers: { Authorization: "Bearer token-1" } });
    expect(members.map((member) => member.id)).toEqual(["m-owner", "m-ivan", "m-dmitry", "m-lena"]);
    expect(members[1].funnel_scope).toEqual({ mode: "selected", funnel_ids: ["f-1", "f-2", "f-3"] });
  });

  it("the action always wins over a same-named param", async () => {
    await listAccessAudit({ event: "member", outcome: "denied", before_id: 9 });
    expect(backend.calls[0].body).toEqual({ action: "audit.list", event: "member", outcome: "denied", before_id: 9 });
  });

  it("turns a non-2xx answer into a typed AccessAdminRequestError the access bridge recognizes", async () => {
    backend.handler = () => ({
      status: 403,
      body: { ok: false, error_code: "escalation_denied", error: "only the Owner may edit a role with privileged permissions", request_id: "req-7" },
    });
    const error = await updateAccessRole({ role_id: "r-admin", permissions: [] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AccessAdminRequestError);
    expect(error).toMatchObject({ status: 403, errorCode: "escalation_denied", requestId: "req-7" });
    expect(error.message).toBe("only the Owner may edit a role with privileged permissions");
    expect(isAccessError(error)).toBe(true);
  });

  it("keeps per-item reasons from `errors` for the toast", async () => {
    backend.handler = () => ({
      status: 400,
      body: { ok: false, error_code: "invalid", error: "The role contains unknown or not yet enforced permissions.", errors: ["unknown_permission: x.y"] },
    });
    const error = await updateAccessRole({ role_id: "r-viewer", permissions: ["x.y"] }).catch((caught) => caught);
    expect(error.details).toEqual(["unknown_permission: x.y"]);
    expect(describeAccessAdminError(error)).toBe("The role contains unknown or not yet enforced permissions. (unknown_permission: x.y)");
  });

  it("a 200 carrying ok:false is still an error (status 0, never an access denial)", async () => {
    backend.handler = () => ({ body: { ok: false, error_code: "request_failed", error: "Request failed." } });
    const error = await listAccessMembers().catch((caught) => caught);
    expect(error).toBeInstanceOf(AccessAdminRequestError);
    expect(error.status).toBe(0);
    expect(isAccessError(error)).toBe(false);
  });

  it("parses funnel_paths rows of funnels.list and drops rows with an unknown status", async () => {
    backend.handler = () => ({
      body: {
        ok: true,
        funnels: [
          {
            id: "f-9",
            funnel_path: "/x",
            display_name: "X",
            is_active: true,
            tags: [],
            paths: [
              { id: 7, path: "x", status: "active", source: "registry_seed", note: null },
              { id: "8", path_canonical: "x-old", status: "retired", source: "registry", retired_at: "2026-09-01T00:00:00Z" },
              { id: "9", path: "x-new", status: "granted", source: "registry" },
            ],
          },
          { id: "f-10", funnel_path: "/y", display_name: "Y", is_active: false, tags: [] },
        ],
      },
    });
    const funnels = await listAccessFunnels();
    expect(funnels[0].paths).toEqual([
      { id: "7", funnel_id: "f-9", path: "x", status: "active", source: "registry_seed", funnelfox_funnel_id: null, note: "", confirmed_at: null, retired_at: null, revoked_at: null },
      { id: "8", funnel_id: "f-9", path: "x-old", status: "retired", source: "registry", funnelfox_funnel_id: null, note: "", confirmed_at: null, retired_at: "2026-09-01T00:00:00Z", revoked_at: null },
    ]);
    expect(funnels[1].paths).toEqual([]);
  });

  it("reads the effective funnel_scope.paths (selected scopes only)", async () => {
    const effective = await fetchMemberEffectiveAccess("m-ivan");
    expect(effective.funnel_scope.paths).toEqual(["palm-reading", "past-life", "past-life-old", "soulmate-sketch"]);
    backend.handler = () => ({
      body: { ok: true, effective: { status: "active", role: {}, permissions: [], raw_access: false, funnel_scope: { mode: "all", funnel_ids: [], paths: ["x"] } } },
    });
    expect((await fetchMemberEffectiveAccess("m-x")).funnel_scope).toEqual({ mode: "all", funnel_ids: [], names: [], paths: [] });
  });
});

// ---- view model ------------------------------------------------------------------------------

const OWNER_ACTOR: AdminActor = { userId: "u-owner", memberId: "m-owner", roleId: "r-owner", isOwner: true, permissions: new Set(ENFORCED_PERMISSION_KEYS) };
const MANAGER_ACTOR: AdminActor = {
  userId: "u-manager",
  memberId: "m-manager",
  roleId: "r-manager",
  isOwner: false,
  permissions: new Set(["admin.users.view", "admin.users.manage", "admin.roles.view", "admin.roles.manage", ...VIEWER_KEYS, "cohorts.export"]),
};

describe("accessAdminModel", () => {
  it("checking a permission auto-checks its requires; unchecking cascades to dependants", () => {
    expect(togglePermission(PERMISSION_CATALOG, [], "support.export", true)).toEqual(["support.view", "support.messages.view", "support.export"]);
    expect(togglePermission(PERMISSION_CATALOG, ["dashboard.view"], "users.pii.view", true)).toEqual(["dashboard.view", "users.view", "users.pii.view"]);
    expect(togglePermission(PERMISSION_CATALOG, ["users.view", "users.details.view", "users.pii.view", "cohorts.view"], "users.view", false)).toEqual([
      "cohorts.view",
    ]);
    // reports.publish requires reports.edit requires reports.view (transitive).
    expect(togglePermission(PERMISSION_CATALOG, ["reports.view", "reports.edit", "reports.publish"], "reports.view", false)).toEqual([]);
  });

  it("grantableSubset drops keys the actor cannot grant and anything left without its prerequisites", () => {
    expect(grantableSubset(PERMISSION_CATALOG, [...ENFORCED_PERMISSION_KEYS], MANAGER_ACTOR)).toEqual(
      PERMISSION_CATALOG.filter((def) => [...VIEWER_KEYS, "cohorts.export"].includes(def.key)).map((def) => def.key),
    );
    expect(grantableSubset(PERMISSION_CATALOG, ["financials.revenue.view", "dashboard.view"], OWNER_ACTOR)).toEqual(["dashboard.view"]);
  });

  it("orders member saves so admin roles never meet a restricted scope", () => {
    const ivan = freshState().members[1];
    expect(planMemberSave(ivan, { roleId: "r-admin", displayName: ivan.display_name, scope: { mode: "all", funnel_ids: [] } })).toEqual([
      { kind: "scope", mode: "all", funnel_ids: [] },
      { kind: "update", role_id: "r-admin" },
    ]);
    const dmitry = freshState().members[2];
    expect(planMemberSave(dmitry, { roleId: "r-viewer", displayName: "Dima", scope: { mode: "selected", funnel_ids: ["f-1"] } })).toEqual([
      { kind: "update", role_id: "r-viewer", display_name: "Dima" },
      { kind: "scope", mode: "selected", funnel_ids: ["f-1"] },
    ]);
    // Same funnel set in another order is not a change.
    expect(planMemberSave(ivan, { roleId: ivan.role.id, displayName: ivan.display_name, scope: { mode: "selected", funnel_ids: ["f-3", "f-1", "f-2"] } })).toEqual([]);
  });

  it("labels funnel scopes like the members table", () => {
    expect(funnelScopeLabel({ mode: "all", funnel_ids: [] })).toBe("All funnels");
    expect(funnelScopeLabel({ mode: "selected", funnel_ids: ["a", "b", "c"] })).toBe("3 funnels");
    expect(funnelScopeLabel({ mode: "selected", funnel_ids: ["a"] })).toBe("1 funnel");
    expect(funnelScopeLabel({ mode: "none", funnel_ids: [] })).toBe("No data");
  });

  it("mirrors the server's anti-escalation rules as lock reasons", () => {
    const members = freshState().members;
    expect(roleAssignBlockReason(ADMIN_ROLE, MANAGER_ACTOR)).toMatch(/Only the Owner/);
    expect(roleAssignBlockReason(ADMIN_ROLE, OWNER_ACTOR)).toBeNull();
    expect(roleAssignBlockReason(ANALYST_ROLE, MANAGER_ACTOR)).toBeNull();
    expect(roleAssignBlockReason(roleRow({ id: "r-x", key: "x", name: "X", permissions: ["users.view", "users.pii.view"] }), MANAGER_ACTOR)).toMatch(/do not hold/);

    expect(memberEditBlockReason(members[0], OWNER_ROLE, OWNER_ACTOR)).toMatch(/your own membership/);
    expect(memberEditBlockReason(members[0], OWNER_ROLE, MANAGER_ACTOR)).toMatch(/data owner/);
    expect(memberEditBlockReason(members[2], ADMIN_ROLE, MANAGER_ACTOR)).toMatch(/Only the Owner/);
    expect(memberEditBlockReason(members[1], VIEWER_ROLE, MANAGER_ACTOR)).toBeNull();

    expect(roleEditBlockReason(OWNER_ROLE, OWNER_ACTOR)).toMatch(/cannot be edited/);
    expect(roleEditBlockReason(VIEWER_ROLE, { ...MANAGER_ACTOR, roleId: "r-viewer" })).toMatch(/assigned to yourself/);
    expect(roleDeleteBlockReason(VIEWER_ROLE, OWNER_ACTOR)).toMatch(/Assigned to 2 members/);
    expect(roleDeleteBlockReason(ANALYST_ROLE, OWNER_ACTOR)).toBeNull();
  });

  it("previews pages with the same route rules as the member's own app", () => {
    const ALL_SCOPE = { mode: "all" } as const;
    const viewer = previewPages({ status: "active", permissions: VIEWER_KEYS, raw_access: false, funnel_scope: ALL_SCOPE });
    expect(viewer.filter((page) => page.allowed).map((page) => page.path)).toEqual(["/", "/cohorts", "/funnels", "/reports"]);
    expect(viewer).toHaveLength(ROUTE_ACCESS.length);
    expect(viewer.find((page) => page.path === "/support")?.denial).toBe("permission");

    // /users needs users.pii.view in Phase 1; raw-only pages need the data owner.
    const users = previewPages({ status: "active", permissions: ["users.view", "leads.view"], raw_access: false, funnel_scope: ALL_SCOPE });
    expect(users.find((page) => page.path === "/users")?.allowed).toBe(false);
    expect(users.find((page) => page.path === "/leads")).toMatchObject({ allowed: false, denial: "raw" });
    const owner = previewPages({ status: "active", permissions: [...ENFORCED_PERMISSION_KEYS], raw_access: true, funnel_scope: ALL_SCOPE });
    expect(owner.every((page) => page.allowed && page.denial === null)).toBe(true);
    expect(owner.find((page) => page.path === "/admin/funnels")).toMatchObject({ title: "Funnel coverage", group: "admin" });

    expect(previewPages({ status: "disabled", permissions: VIEWER_KEYS, raw_access: false, funnel_scope: ALL_SCOPE }).some((page) => page.allowed)).toBe(false);
  });

  it("a funnel-restricted member opens only the media-buyer pages; the rest is hidden by scope", () => {
    const buyer = previewPages({ status: "active", permissions: VIEWER_KEYS, raw_access: false, funnel_scope: { mode: "selected" } });
    expect(buyer.filter((page) => page.allowed).map((page) => page.path)).toEqual(["/", "/cohorts", "/funnels"]);
    // The role grants Reports, the restricted scope does not.
    expect(buyer.find((page) => page.path === "/reports")?.denial).toBe("scope");
    // Pages the role never granted stay a permission denial.
    expect(buyer.find((page) => page.path === "/support")?.denial).toBe("permission");
    const none = previewPages({ status: "active", permissions: [...VIEWER_KEYS, "facebook_analytics.view"], raw_access: false, funnel_scope: { mode: "none" } });
    expect(none.filter((page) => page.allowed).map((page) => page.path)).toEqual(["/", "/cohorts", "/funnels", "/fb-analytics"]);
  });

  it("computes the scope impact preview from the registry and the snapshot coverage", () => {
    const impact = computeScopeImpact({ mode: "selected", funnel_ids: ["F-1", "f-2", "f-3"] }, FUNNELS, coverageFixture());
    expect(impact).toMatchObject({
      funnels: 3,
      paths: 4,
      retiredPaths: 1,
      users: 900,
      usersPct: "90%",
      netRevenue: 45000,
      netPct: "90%",
      funnelsWithoutData: [{ id: "f-3", label: "Palm Reading" }],
      unregisteredPaths: 3,
      unregisteredUsersPct: "10%",
    });
    expect(scopeImpactSummary(impact)).toBe("3 funnels · 4 paths (1 retired) · 900 users (90%) · $45,000 net (90%)");

    // Without coverage only the registry part is known; proposed rows never count.
    const registryOnly = computeScopeImpact({ mode: "selected", funnel_ids: ["f-1"] }, FUNNELS, undefined);
    expect(scopeImpactSummary(registryOnly)).toBe("1 funnel · 1 path");
    expect(registryOnly.users).toBeNull();
    // An id the registry does not know counts as a funnel without data.
    expect(computeScopeImpact({ mode: "selected", funnel_ids: ["f-gone"] }, FUNNELS, coverageFixture()).funnelsWithoutData).toEqual([
      { id: "f-gone", label: "Unknown funnel fgone" },
    ]);
    expect(computeScopeImpact({ mode: "all", funnel_ids: [] }, FUNNELS, coverageFixture())).toMatchObject({ funnels: 0, paths: 0, users: 0 });
  });

  it("flags selected scopes without data and formats shares without ever rounding up to 100%", () => {
    expect(scopeWithoutData({ mode: "selected", funnel_ids: ["f-3", "f-4"] }, coverageFixture())).toBe(true);
    expect(scopeWithoutData({ mode: "selected", funnel_ids: ["f-3", "f-1"] }, coverageFixture())).toBe(false);
    expect(scopeWithoutData({ mode: "none", funnel_ids: [] }, coverageFixture())).toBe(false);
    expect(scopeWithoutData({ mode: "selected", funnel_ids: ["f-3"] }, undefined)).toBe(false);
    expect(formatPct(9999, 10000)).toBe("99.9%");
    expect(formatPct(1, 100000)).toBe("<0.1%");
    expect(formatPct(0, 100)).toBe("0%");
    expect(formatPct(5, 0)).toBe("—");
  });

  it("mirrors the SQL canonicalizer for the funnel's own path", () => {
    expect(canonicalCampaignPath("/Soulmate-Sketch")).toBe("soulmate-sketch");
    expect(canonicalCampaignPath("https://example.com/Past_Life/?utm=1#x")).toBe("past-life");
    expect(canonicalCampaignPath(" /a--b/ ")).toBe("a-b");
    expect(canonicalCampaignPath("unknown")).toBeNull();
    expect(canonicalCampaignPath("тест")).toBeNull();
    expect(canonicalCampaignPath("")).toBeNull();
  });

  it("labels the Phase 2 registry audit events", () => {
    expect(auditEventLabel("registry.path_attached")).toBe("Funnel path attached");
    expect(auditEventLabel("registry.path_revoked")).toBe("Funnel path revoked");
    expect(auditEventLabel("registry.paths_seeded")).toBe("Funnel paths seeded");
    expect(describeAuditChanges({ event: "registry.path_repathed", before: { path: "old-quiz" }, after: { path: "new-quiz" }, context: {} }, {
      funnelLabel: (id) => id,
      roleLabel: (id) => id ?? "",
    })).toEqual(["Path: old-quiz → new-quiz"]);
  });

  it("renders audit before/after snapshots as readable change lines", () => {
    const lookups: AuditLookups = {
      funnelLabel: (id) => ({ "f-1": "soulmate-sketch", "f-2": "past-life" })[id] ?? id,
      roleLabel: (id, key) => ({ "r-viewer": "Viewer", "r-analyst": "Analyst" })[id ?? ""] ?? key ?? "?",
    };
    expect(
      describeAuditChanges(
        { event: "scope.updated", before: { mode: "selected", funnel_ids: ["f-2"] }, after: { mode: "selected", funnel_ids: ["f-1"] }, context: {} },
        lookups,
      ),
    ).toEqual(["Funnels: + soulmate-sketch − past-life"]);
    expect(
      describeAuditChanges(
        {
          event: "role.updated",
          before: { role_id: "r-viewer", name: "Viewer", permissions: ["cohorts.view"] },
          after: { role_id: "r-viewer", name: "Viewer", permissions: ["cohorts.export", "cohorts.view"] },
          context: { added_permissions: ["cohorts.export"], removed_permissions: [] },
        },
        lookups,
      ),
    ).toEqual(["Permissions: + cohorts.export"]);
    expect(
      describeAuditChanges(
        {
          event: "member.updated",
          before: { member_id: "m", role_id: "r-viewer", role_key: "viewer", status: "active", display_name: "Ivan", funnel_scope: { mode: "all", funnel_ids: [] } },
          after: { member_id: "m", role_id: "r-analyst", role_key: "analyst", status: "disabled", display_name: "Ivan", funnel_scope: { mode: "selected", funnel_ids: ["f-1"] } },
          context: {},
        },
        lookups,
      ),
    ).toEqual(["Role: Viewer → Analyst", "Status: active → disabled", "Funnels: All funnels → soulmate-sketch"]);
    expect(
      describeAuditChanges(
        { event: "member.added", before: null, after: { member_id: "m", role_id: "r-viewer", status: "active", funnel_scope: { mode: "all", funnel_ids: [] } }, context: {} },
        lookups,
      ),
    ).toEqual(["Role: Viewer", "Funnels: All funnels"]);
  });

  it("defaults new members to an assignable, non-admin role", () => {
    const roles = [OWNER_ROLE, ADMIN_ROLE, VIEWER_ROLE, ANALYST_ROLE];
    expect(defaultRoleId(roles, OWNER_ACTOR)).toBe("r-viewer");
    // A non-owner manager may assign Viewer (they hold its keys) but never Admin.
    expect(defaultRoleId(roles, MANAGER_ACTOR)).toBe("r-viewer");
    expect(defaultRoleId([OWNER_ROLE, ADMIN_ROLE], MANAGER_ACTOR)).toBe("");
  });

  it("formats last activity", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    expect(formatLastActive(null, now)).toBe("Never");
    expect(formatLastActive("2026-10-06T11:55:00Z", now)).toBe("5 minutes ago");
  });

  it("actorFromAccess reads the signed-in member", () => {
    const actor = actorFromAccess(OWNER_ACCESS());
    expect(actor).toMatchObject({ userId: "u-owner", memberId: "m-owner", roleId: "r-owner", isOwner: true });
    expect(actor.permissions.has("admin.users.manage")).toBe(true);
  });
});

// ---- funnel scope picker -----------------------------------------------------------------------

describe("FunnelScopePicker", () => {
  it("'select by tag' expands the tag into the funnel ids that carry it now", () => {
    const onChange = vi.fn();
    render(
      <FunnelScopePicker value={{ mode: "selected", funnel_ids: ["f-1"] }} onChange={onChange} funnels={FUNNELS} />,
    );
    expect(screen.getByTestId("scope-selection-count")).toHaveTextContent("1 of 4 funnels selected · 1 path");
    fireEvent.click(screen.getByRole("button", { name: /^esoteric/ }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", funnel_ids: ["f-1", "f-2", "f-3"] });
    // Phase 2: restricted scopes are live on the media-buyer pages.
    expect(screen.getByTestId("scope-restricted-notice")).toHaveTextContent(
      "Restricted members can open: Dashboard (Revenue Intelligence), Cohorts, Funnels, FB-Analytics",
    );
    expect(screen.queryByText(/not live yet/)).not.toBeInTheDocument();
  });

  it("counts granted paths (active and retired) and shows them as chips", () => {
    render(<FunnelScopePicker value={{ mode: "selected", funnel_ids: ["f-1", "f-2"] }} onChange={vi.fn()} funnels={FUNNELS} />);
    // f-1: soulmate-sketch (its proposal grants nothing); f-2: past-life + past-life-old.
    expect(screen.getByTestId("scope-selection-count")).toHaveTextContent("2 of 4 funnels selected · 3 paths");
    const pastLife = screen.getByTestId("scope-funnel-f-2");
    const chips = within(pastLife).getAllByTestId("funnel-path-chip");
    expect(chips.map((chip) => [chip.getAttribute("data-status"), chip.textContent])).toEqual([
      ["active", "past-life"],
      ["retired", "past-life-old(old)"],
    ]);
    expect(within(screen.getByTestId("scope-funnel-f-1")).queryByText("soulmate-1-tariff-month-veb")).not.toBeInTheDocument();
    expect(within(screen.getByTestId("scope-funnel-f-4")).getByText("no granted path")).toBeInTheDocument();
  });

  it("previews the impact of the selection from the snapshot coverage", () => {
    const { rerender } = render(
      <FunnelScopePicker value={{ mode: "selected", funnel_ids: ["f-1", "f-2", "f-3"] }} onChange={vi.fn()} funnels={FUNNELS} coverage={coverageFixture()} />,
    );
    expect(screen.getByTestId("scope-impact-summary")).toHaveTextContent("3 funnels · 4 paths (1 retired) · 900 users (90%) · $45,000 net (90%)");
    expect(screen.getByTestId("scope-impact-no-data")).toHaveTextContent("No users in the current snapshot: Palm Reading");
    expect(screen.getByTestId("scope-impact-unregistered")).toHaveTextContent("3 unregistered paths (10% of users) are invisible to this member.");
    expect(within(screen.getByTestId("scope-funnel-f-1")).getByText("500 users")).toBeInTheDocument();
    expect(within(screen.getByTestId("scope-funnel-f-3")).getByText("no data")).toBeInTheDocument();

    rerender(<FunnelScopePicker value={{ mode: "selected", funnel_ids: ["f-1"] }} onChange={vi.fn()} funnels={FUNNELS} coverageLoading />);
    expect(screen.getByTestId("scope-impact-summary")).toHaveTextContent("1 funnel · 1 path");
    expect(screen.getByText("Measuring coverage…")).toBeInTheDocument();

    rerender(<FunnelScopePicker value={{ mode: "all", funnel_ids: [] }} onChange={vi.fn()} funnels={FUNNELS} coverage={coverageFixture()} />);
    expect(screen.queryByTestId("scope-impact")).not.toBeInTheDocument();
    expect(screen.queryByTestId("scope-restricted-notice")).not.toBeInTheDocument();
  });

  it("toggles funnels from the searchable list and keeps the selection when switching modes", () => {
    const onChange = vi.fn();
    const { rerender } = render(<FunnelScopePicker value={{ mode: "selected", funnel_ids: ["f-1"] }} onChange={onChange} funnels={FUNNELS} />);
    fireEvent.click(screen.getByTestId("scope-funnel-f-4"));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", funnel_ids: ["f-1", "f-4"] });
    rerender(<FunnelScopePicker value={{ mode: "all", funnel_ids: [] }} onChange={onChange} funnels={FUNNELS} />);
    fireEvent.click(screen.getByRole("radio", { name: "Selected funnels" }));
    expect(onChange).toHaveBeenLastCalledWith({ mode: "selected", funnel_ids: ["f-1"] });
  });

  it("locks the restricted modes for roles with admin permissions", () => {
    const onChange = vi.fn();
    render(<FunnelScopePicker value={{ mode: "all", funnel_ids: [] }} onChange={onChange} funnels={FUNNELS} requireAll />);
    expect(screen.getByRole("radio", { name: "Selected funnels" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "No data access" })).toBeDisabled();
    expect(screen.getByText(/must have All funnels/)).toBeInTheDocument();
  });
});

// ---- effective access panel --------------------------------------------------------------------

describe("EffectiveAccessPanel", () => {
  function effectiveRow(overrides: Partial<EffectiveAccess>): EffectiveAccess {
    return {
      status: "active",
      role: { id: "r-viewer", key: "viewer", name: "Viewer", is_owner: false },
      permissions: VIEWER_KEYS,
      raw_access: false,
      funnel_scope: { mode: "all", funnel_ids: [], names: [], paths: [] },
      ...overrides,
    };
  }

  it("lists the granted paths and the pages hidden only by funnel-restricted access", () => {
    render(
      <EffectiveAccessPanel
        effective={effectiveRow({ funnel_scope: { mode: "selected", funnel_ids: ["f-2"], names: ["Past Life"], paths: ["past-life", "past-life-old"] } })}
      />,
    );
    expect(screen.getByTestId("effective-pages")).toHaveTextContent(`Pages 3/${ROUTE_ACCESS.length}`);
    expect(screen.getByTestId("effective-paths")).toHaveTextContent("Paths: past-life, past-life-old");
    expect(screen.getByText("Hidden by funnel-restricted access")).toBeInTheDocument();
    expect(screen.getByTestId("effective-scope-hidden")).toHaveTextContent(/^Reports$/);
    // The Milestone A warning is gone.
    expect(screen.queryByText(/not live yet/)).not.toBeInTheDocument();
  });

  it("says when the selected funnels grant no path; an all-scope member has no scope-hidden pages", () => {
    const { rerender } = render(<EffectiveAccessPanel effective={effectiveRow({ funnel_scope: { mode: "selected", funnel_ids: ["f-4"], names: ["Old Quiz"], paths: [] } })} />);
    expect(screen.getByTestId("effective-paths")).toHaveTextContent(/none granted/);
    rerender(<EffectiveAccessPanel effective={effectiveRow({})} />);
    expect(screen.getByTestId("effective-pages")).toHaveTextContent(`Pages 4/${ROUTE_ACCESS.length}`);
    expect(screen.queryByTestId("effective-scope-hidden")).not.toBeInTheDocument();
    expect(screen.queryByTestId("effective-paths")).not.toBeInTheDocument();
  });
});

// ---- members page ---------------------------------------------------------------------------

describe("AdminMembersPage", () => {
  it("lists members with role, funnel scope and status", async () => {
    renderWithAccess(<AdminMembersPage />);
    const ivan = await screen.findByTestId("member-row-m-ivan");
    expect(within(ivan).getByText("Ivan Petrov")).toBeInTheDocument();
    expect(within(ivan).getByText("Viewer")).toBeInTheDocument();
    expect(within(ivan).getByText("3 funnels")).toBeInTheDocument();
    expect(within(screen.getByTestId("member-row-m-dmitry")).getByText("All funnels")).toBeInTheDocument();
    expect(within(screen.getByTestId("member-row-m-lena")).getByText("No data")).toBeInTheDocument();
    expect(within(screen.getByTestId("member-row-m-lena")).getByText("Disabled")).toBeInTheDocument();
    const self = screen.getByTestId("member-row-m-owner");
    expect(within(self).getByText("You")).toBeInTheDocument();
    expect(within(self).getByText("5 minutes ago")).toBeInTheDocument();
    // Nobody edits their own membership.
    expect(within(self).getByRole("switch")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add member" })).toBeInTheDocument();
  });

  it("asks for confirmation before disabling a member, then calls members.update", async () => {
    renderWithAccess(<AdminMembersPage />);
    const ivan = await screen.findByTestId("member-row-m-ivan");
    fireEvent.click(within(ivan).getByRole("switch", { name: "Disable Ivan Petrov" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Disable Ivan Petrov?")).toBeInTheDocument();
    expect(callsFor("members.update")).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(callsFor("members.update")).toHaveLength(1));
    expect(callsFor("members.update")[0].body).toEqual({ action: "members.update", member_id: "m-ivan", status: "disabled" });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("opens the member sheet with effective access and saves a scope change", async () => {
    renderWithAccess(<AdminMembersPage />);
    fireEvent.click(await screen.findByTestId("member-row-m-ivan"));
    const sheet = await screen.findByTestId("member-sheet");
    // Ivan holds viewer keys minus reports.view; selected scope is restricted.
    expect(await within(sheet).findByTestId("effective-pages")).toHaveTextContent(`Pages 3/${ROUTE_ACCESS.length}`);
    expect(within(sheet).getByTestId("effective-funnels")).toHaveTextContent(`Funnels 3/${FUNNELS.length}`);
    expect(within(sheet).getByTestId("capability-export")).toHaveTextContent("Export off");
    expect(within(within(sheet).getByTestId("sidebar-preview")).getByText("Cohorts")).toBeInTheDocument();
    expect(within(sheet).getByTestId("effective-paths")).toHaveTextContent("Paths: palm-reading, past-life, past-life-old, soulmate-sketch");
    // The picker previews the selected scope against the shared coverage query.
    expect(await within(sheet).findByTestId("scope-impact-summary")).toHaveTextContent("3 funnels · 4 paths (1 retired) · 900 users (90%)");

    const save = within(sheet).getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    fireEvent.click(within(sheet).getByRole("radio", { name: "All funnels" }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(callsFor("members.set_scope")).toHaveLength(1));
    expect(callsFor("members.set_scope")[0].body).toEqual({ action: "members.set_scope", member_id: "m-ivan", mode: "all", funnel_ids: [] });
    expect(callsFor("members.update")).toHaveLength(0);
    // The save refreshes the admin queries but not the (ClickHouse) coverage.
    await waitFor(() => expect(callsFor("members.list").length).toBeGreaterThan(1));
    expect(callsFor("paths.coverage")).toHaveLength(1);
  });

  it("says that narrowing an All-funnels member leaves what they saved readable (Phase 4 gap, security review)", async () => {
    state.members.push(memberRow({ id: "m-anna", user_id: "u-anna", email: "anna@example.com", display_name: "Anna" }));
    renderWithAccess(<AdminMembersPage />);
    fireEvent.click(await screen.findByTestId("member-row-m-anna"));
    const sheet = await screen.findByTestId("member-sheet");
    const notice = () => within(sheet).queryByTestId("scope-narrowing-saved-objects");
    expect(notice()).not.toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("radio", { name: "Selected funnels" }));
    expect(notice()).toHaveTextContent("Reports, forecasts and AI history this member saved while on All funnels stay readable to them after this change.");
    fireEvent.click(within(sheet).getByRole("radio", { name: "No data access" }));
    expect(notice()).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("radio", { name: "All funnels" }));
    expect(notice()).not.toBeInTheDocument();
    cleanup();
    // A member who is already restricted saved nothing tenant-wide since: no notice.
    renderWithAccess(<AdminMembersPage />);
    fireEvent.click(await screen.findByTestId("member-row-m-ivan"));
    expect(within(await screen.findByTestId("member-sheet")).queryByTestId("scope-narrowing-saved-objects")).not.toBeInTheDocument();
  });

  it("warns about restricted members without data and about users no funnel holds", async () => {
    state.members.push(
      memberRow({ id: "m-olya", user_id: "u-olya", email: "olya@example.com", display_name: "Olya", funnel_scope: { mode: "selected", funnel_ids: ["f-3", "f-4"] } }),
    );
    renderWithAccess(<AdminMembersPage />);
    expect(await screen.findByTestId("member-no-data-m-olya")).toBeInTheDocument();
    expect(screen.queryByTestId("member-no-data-m-ivan")).not.toBeInTheDocument();
    const banner = screen.getByTestId("coverage-gap-notice");
    expect(banner).toHaveTextContent("10% of users (3 campaign paths) belong to no funnel: members with selected funnels never see them.");
    expect(within(banner).getByRole("link", { name: "Review funnel coverage" })).toHaveAttribute("href", "/admin/funnels");
    expect(callsFor("paths.coverage")).toHaveLength(1);
  });

  it("reads coverage only while an active member is funnel-restricted; a 409 just hides the warnings", async () => {
    state.members = state.members.filter((member) => member.id !== "m-ivan");
    renderWithAccess(<AdminMembersPage />);
    await screen.findByTestId("member-row-m-dmitry");
    await waitFor(() => expect(callsFor("roles.list")).toHaveLength(1));
    expect(callsFor("paths.coverage")).toHaveLength(0);
    expect(screen.queryByTestId("coverage-gap-notice")).not.toBeInTheDocument();
    cleanup();

    state = freshState();
    state.coverage = null;
    backend.calls = [];
    renderWithAccess(<AdminMembersPage />);
    await screen.findByTestId("member-row-m-ivan");
    await waitFor(() => expect(callsFor("paths.coverage")).toHaveLength(1));
    expect(screen.queryByTestId("coverage-gap-notice")).not.toBeInTheDocument();
    expect(screen.queryByTestId("member-no-data-m-ivan")).not.toBeInTheDocument();
  });

  it("adds an existing account with the default role and All funnels", async () => {
    renderWithAccess(<AdminMembersPage />);
    await screen.findByTestId("member-row-m-ivan");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add member" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getAllByRole("button", { name: "Add member" }).at(-1) as HTMLElement;
    expect(submit).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: " Anna@Example.com " } });
    fireEvent.click(submit);
    await waitFor(() => expect(callsFor("members.add")).toHaveLength(1));
    expect(callsFor("members.add")[0].body).toEqual({
      action: "members.add",
      email: "Anna@Example.com",
      role_id: "r-viewer",
      scope: { mode: "all", funnel_ids: [] },
    });
  });

  it("is read-only for an admin without admin.users.manage", async () => {
    renderWithAccess(<AdminMembersPage />, READONLY_ADMIN_ACCESS());
    const ivan = await screen.findByTestId("member-row-m-ivan");
    expect(screen.queryByRole("button", { name: "Add member" })).not.toBeInTheDocument();
    expect(within(ivan).getByRole("switch")).toBeDisabled();
    fireEvent.click(ivan);
    const sheet = await screen.findByTestId("member-sheet");
    expect(within(sheet).getByText("You can view members but not change them.")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("shows a load failure inline", async () => {
    backend.handler = (action, body) =>
      action === "members.list" ? { status: 403, body: { ok: false, error_code: "permission_denied", error: "You do not have permission for this action." } } : defaultHandler(action, body);
    renderWithAccess(<AdminMembersPage />);
    expect(await screen.findByText(/Could not load members: You do not have permission/)).toBeInTheDocument();
  });

  it("shows a notice instead of calling the API while access control is not set up (legacy)", () => {
    renderWithAccess(<AdminMembersPage />, buildAccessValue({ status: "legacy", access: null, userId: "u-owner" }));
    expect(screen.getByTestId("access-not-set-up")).toBeInTheDocument();
    expect(backend.calls).toHaveLength(0);
  });
});

// ---- roles page -------------------------------------------------------------------------------

describe("AdminRolesPage", () => {
  it("lists roles with type, member count and new template permissions", async () => {
    renderWithAccess(<AdminRolesPage />, OWNER_ACCESS(), "/admin/roles");
    const viewer = await screen.findByTestId("role-row-r-viewer");
    expect(within(viewer).getByText("Custom")).toBeInTheDocument();
    expect(within(viewer).getByText("2")).toBeInTheDocument();
    expect(within(viewer).getByText("1 new permission available")).toBeInTheDocument();
    const owner = screen.getByTestId("role-row-r-owner");
    expect(within(owner).getByText("System")).toBeInTheDocument();
    expect(within(owner).getByText("All")).toBeInTheDocument();
    // More than the Owner role exists: no seeding offer.
    expect(screen.queryByRole("button", { name: "Create default roles" })).not.toBeInTheDocument();
  });

  it("offers 'Create default roles' to the Owner when only the Owner role exists", async () => {
    state.roles = [state.roles[0]];
    renderWithAccess(<AdminRolesPage />, OWNER_ACCESS(), "/admin/roles");
    const seed = await screen.findByRole("button", { name: "Create default roles" });
    fireEvent.click(seed);
    await waitFor(() => expect(callsFor("roles.seed_templates")).toHaveLength(1));
  });

  it("saves a role through a diff + affected-members confirmation", async () => {
    renderWithAccess(<AdminRolesPage />, OWNER_ACCESS(), "/admin/roles");
    fireEvent.click(await screen.findByTestId("role-row-r-viewer"));
    const editor = await screen.findByTestId("role-editor");
    await within(editor).findByTestId("permission-matrix");
    // Delete is offered only for unused roles.
    expect(within(editor).getByRole("button", { name: "Delete" })).toBeDisabled();
    // The template's new permission is offered, never added automatically.
    expect(within(editor).getByText(/1 new permission available from the template/)).toBeInTheDocument();

    fireEvent.click(within(editor).getByRole("checkbox", { name: "Export cohorts" }));
    fireEvent.click(within(editor).getByRole("button", { name: "Save changes" }));
    const confirm = await screen.findByTestId("role-save-confirm");
    expect(within(confirm).getByText("Affects 2 members on their next request.")).toBeInTheDocument();
    expect(within(confirm).getByText(/\+ Export cohorts/)).toBeInTheDocument();
    expect(callsFor("roles.update")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Save role" }));
    await waitFor(() => expect(callsFor("roles.update")).toHaveLength(1));
    expect(callsFor("roles.update")[0].body).toEqual({
      action: "roles.update",
      role_id: "r-viewer",
      permissions: ["dashboard.view", "cohorts.view", "cohorts.export", "funnels.view"],
    });
  });

  it("locks the Owner role", async () => {
    renderWithAccess(<AdminRolesPage />, OWNER_ACCESS(), "/admin/roles");
    fireEvent.click(await screen.findByTestId("role-row-r-owner"));
    const editor = await screen.findByTestId("role-editor");
    expect(await within(editor).findByText("The Owner role always has every permission and cannot be edited.")).toBeInTheDocument();
    expect(within(editor).getByRole("checkbox", { name: "Dashboard" })).toBeDisabled();
    expect(within(editor).getByRole("checkbox", { name: "Dashboard" })).toBeChecked();
    expect(within(editor).queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("opens the role linked from the member sheet (?role=)", async () => {
    renderWithAccess(<AdminRolesPage />, OWNER_ACCESS(), "/admin/roles?role=r-analyst");
    const editor = await screen.findByTestId("role-editor");
    expect(within(editor).getByDisplayValue("Analyst")).toBeInTheDocument();
  });
});

// ---- audit page --------------------------------------------------------------------------------

describe("AdminAuditPage", () => {
  beforeEach(() => {
    state.audit = [
      {
        id: 3,
        occurred_at: "2026-10-05T10:00:00Z",
        actor_kind: "user",
        actor_user_id: "u-dmitry",
        actor_email: "dmitry@example.com",
        event: "scope.updated",
        target_type: "member",
        target_id: "m-ivan",
        target_label: "Ivan Petrov",
        outcome: "success",
        reason_code: null,
        before: { mode: "selected", funnel_ids: ["f-2"] },
        after: { mode: "selected", funnel_ids: ["f-1"] },
        context: { added_funnel_ids: ["f-1"], removed_funnel_ids: ["f-2"] },
      },
      {
        id: 2,
        occurred_at: "2026-10-05T09:00:00Z",
        actor_kind: "user",
        actor_user_id: "u-dmitry",
        actor_email: "dmitry@example.com",
        event: "role.updated",
        target_type: "role",
        target_id: "r-viewer",
        target_label: "Viewer",
        outcome: "success",
        reason_code: null,
        before: { role_id: "r-viewer", name: "Viewer", permissions: ["cohorts.view"] },
        after: { role_id: "r-viewer", name: "Viewer", permissions: ["cohorts.export", "cohorts.view"] },
        context: { added_permissions: ["cohorts.export"], removed_permissions: [] },
      },
      {
        id: 1,
        occurred_at: "2026-10-04T09:00:00Z",
        actor_kind: "cron",
        actor_user_id: null,
        actor_email: null,
        event: "member.disabled",
        target_type: "member",
        target_id: "m-lena",
        target_label: null,
        outcome: "error",
        reason_code: "auth_ban_failed",
        before: null,
        after: null,
        context: null,
      },
    ];
  });

  it("renders readable changes and pages older events with before_id", async () => {
    renderWithAccess(<AdminAuditPage />, OWNER_ACCESS(), "/admin/audit");
    const scopeRow = await screen.findByTestId("audit-row-3");
    expect(within(scopeRow).getByText("Funnel access changed")).toBeInTheDocument();
    expect(within(scopeRow).getByText("Ivan Petrov")).toBeInTheDocument();
    expect(await within(scopeRow).findByText("Funnels: + soulmate-sketch − past-life")).toBeInTheDocument();
    expect(within(screen.getByTestId("audit-row-2")).getByText("Permissions: + cohorts.export")).toBeInTheDocument();
    expect(screen.queryByTestId("audit-row-1")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load older events" }));
    const older = await screen.findByTestId("audit-row-1");
    expect(within(older).getByText("Scheduled job")).toBeInTheDocument();
    expect(within(older).getByText("auth_ban_failed")).toBeInTheDocument();
    expect(callsFor("audit.list").map((call) => call.body.before_id)).toEqual([undefined, 2]);
    expect(screen.queryByRole("button", { name: "Load older events" })).not.toBeInTheDocument();
  });

  it("an auditor without member/role access still gets the log (ids instead of names)", async () => {
    const auditor = buildAccessValue({
      status: "ok",
      access: okRow({ permissions: ["admin.audit.view"], userId: "u-a", memberId: "m-a", roleId: "r-a" }),
      userId: "u-a",
    });
    renderWithAccess(<AdminAuditPage />, auditor, "/admin/audit");
    expect(await screen.findByTestId("audit-row-3")).toBeInTheDocument();
    expect(callsFor("funnels.list")).toHaveLength(0);
    expect(callsFor("roles.list")).toHaveLength(0);
  });
});
