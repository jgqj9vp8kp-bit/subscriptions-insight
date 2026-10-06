import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type ComponentType, type ReactNode } from "react";

// Shared, hoisted state the module mocks below read at render time.
const shell = vi.hoisted(() => ({
  prefetchCohortsNav: vi.fn(),
  cohortsMode: "clickhouse" as "clickhouse" | "legacy",
  appQueryClient: null as unknown,
  stubPage:
    (label: string) =>
    async () => {
      const React = await import("react");
      return { default: () => React.createElement("div", { "data-testid": "page" }, label) };
    },
}));

vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/components/SavedDataAutoLoader", async () => {
  const React = await import("react");
  return { SavedDataAutoLoader: () => React.createElement("div", { "data-testid": "saved-data-auto-loader" }) };
});
vi.mock("@/components/ai/AiAssistantDrawer", async () => {
  const React = await import("react");
  return { AiAssistantDrawer: () => React.createElement("div", { "data-testid": "ai-drawer" }) };
});
vi.mock("@/hooks/useCohortsCache", () => ({ prefetchCohortsNav: shell.prefetchCohortsNav }));
vi.mock("@/services/cohortsDataSource", () => ({ cohortsDataSourceMode: () => shell.cohortsMode }));
// SHARED CONTRACT B (typed Edge errors) is implemented in parallel in
// src/services/clickhouse.ts. Use it when present; until then stand in with the
// documented shape so this suite still exercises the bridge.
vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  if (typeof actual.ClickHouseRequestError === "function" && typeof actual.isAccessError === "function") return actual;
  class ClickHouseRequestError extends Error {
    status = 0;
    errorCode: string | null = null;
    requestId: string | null = null;
  }
  const codes = new Set([
    "invalid_session", "no_membership", "membership_disabled", "permission_denied",
    "scope_not_supported", "raw_access_required", "owner_required", "full_scope_required",
  ]);
  const isAccessError = (error: unknown) =>
    error instanceof ClickHouseRequestError && [401, 403, 404, 409].includes(error.status) && codes.has(error.errorCode ?? "");
  return { ...actual, ClickHouseRequestError, isAccessError };
});

// App-level wiring: real App/ProtectedRoute/RequirePermission/AppLayout/
// AppSidebar/AccessErrorBridge; providers replaced by controllable contexts.
vi.mock("@/components/AuthProvider", async () => {
  const React = await import("react");
  const { AuthContext } = await import("@/contexts/authContext");
  return { AuthProvider: ({ children }: { children: ReactNode }) => React.createElement(AuthContext.Provider, { value: authValue }, children) };
});
vi.mock("@/components/AccessProvider", async () => {
  const React = await import("react");
  const { AccessContext } = await import("@/contexts/accessContext");
  return { AccessProvider: ({ children }: { children: ReactNode }) => React.createElement(AccessContext.Provider, { value: accessValue }, children) };
});
vi.mock("@/components/AnalyticsCacheGate", () => ({ AnalyticsCacheGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/pages/Dashboard.tsx", async () => {
  const React = await import("react");
  const { useQueryClient } = await import("@tanstack/react-query");
  return {
    default: function DashboardStub() {
      shell.appQueryClient = useQueryClient();
      return React.createElement("div", { "data-testid": "page" }, "dashboard page");
    },
  };
});
vi.mock("@/pages/Login.tsx", shell.stubPage("login page"));
vi.mock("@/pages/NotFound.tsx", shell.stubPage("not found page"));
vi.mock("@/pages/Cohorts.tsx", shell.stubPage("cohorts page"));
vi.mock("@/pages/Users.tsx", shell.stubPage("users page"));
vi.mock("@/pages/Leads.tsx", shell.stubPage("leads page"));
// Created in parallel by the admin UI track; stubbed here either way.
vi.mock("@/pages/admin/AdminMembers.tsx", shell.stubPage("admin members page"));
vi.mock("@/pages/admin/AdminRoles.tsx", shell.stubPage("admin roles page"));
vi.mock("@/pages/admin/AdminAudit.tsx", shell.stubPage("admin audit page"));
vi.mock("@/pages/admin/AdminFunnelCoverage.tsx", shell.stubPage("admin funnel coverage page"));
vi.mock("@/pages/Reports.tsx", shell.stubPage("reports page"));
vi.mock("@/pages/Funnels.tsx", shell.stubPage("funnels page"));
vi.mock("@/pages/FBAnalytics.tsx", shell.stubPage("fb analytics page"));

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AppSidebar } from "@/components/AppSidebar";
import { AppLayout } from "@/components/AppLayout";
import { AccessErrorBridge } from "@/components/AccessErrorBridge";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue, type AccessStatus } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import * as clickhouse from "@/services/clickhouse";
import { registeredPurgeHandlers, runPurge } from "@/services/sessionPurge";
import { useDataStore } from "@/store/dataStore";
import { RESTRICTED_SCOPE_DENIAL_COPY } from "@/components/NoAccess";
import { FunnelPathChips } from "@/components/access/FunnelPathChips";
import { ACCESS_ERROR_MESSAGES } from "../../supabase/functions/_shared/access/errors";

const USER: AuthUser = { id: "user-a", email: "a@example.com", provider: "supabase" };

function authFor(user: AuthUser | null, overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    configured: true,
    supabaseConfigured: true,
    localAuthEnabled: false,
    mode: "supabase",
    loading: false,
    session: null,
    user,
    signIn: async () => {},
    signOut: async () => {},
    ...overrides,
  };
}

type ScopeMode = "all" | "selected" | "none";

function okRow(input: { permissions?: string[]; isOwner?: boolean; raw?: boolean; partition?: string; mode?: ScopeMode }): MyAccess {
  const mode = input.mode ?? "all";
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-a",
    user_id: USER.id,
    email: USER.email,
    display_name: null,
    is_data_owner: input.raw === true,
    raw_access: input.raw === true,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: input.isOwner === true, permissions: input.permissions ?? [] },
    funnel_scope: mode === "selected" ? { mode, funnel_ids: ["funnel-a"], paths: ["soulmate-sketch"] } : { mode, funnel_ids: [], paths: [] },
    access_version: "1",
    partition: input.partition ?? "p-member",
  };
}

const refreshSpy = vi.fn(async () => {});

function member(permissions: string[], extra: { raw?: boolean; partition?: string; mode?: ScopeMode } = {}): AccessContextValue {
  return buildAccessValue({ status: "ok", access: okRow({ permissions, ...extra }), userId: USER.id, refresh: refreshSpy });
}

const OWNER = () => buildAccessValue({ status: "ok", access: okRow({ isOwner: true, raw: true, partition: "p-owner" }), userId: USER.id, refresh: refreshSpy });
const LEGACY = () => buildAccessValue({ status: "legacy", access: null, userId: USER.id, refresh: refreshSpy });
const VIEWER = () => member(["dashboard.view", "cohorts.view", "funnels.view", "reports.view"]);
// Phase 2: the Media Buyer template restricted to funnel A.
const MEDIA_BUYER_KEYS = ["dashboard.view", "cohorts.view", "funnels.view", "facebook_analytics.view", "ai.use"];
const BUYER_A = (partition = "p-buyer-a") => member(MEDIA_BUYER_KEYS, { mode: "selected", partition });
const status = (value: AccessStatus) => buildAccessValue({ status: value, access: null, userId: USER.id, refresh: refreshSpy });

// Read by the mocked providers in the App-level tests.
let authValue: AuthContextValue = authFor(USER);
let accessValue: AccessContextValue = OWNER();

beforeEach(() => {
  localStorage.clear();
  authValue = authFor(USER);
  accessValue = OWNER();
  shell.cohortsMode = "clickhouse";
  shell.prefetchCohortsNav.mockReset();
  refreshSpy.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function Where() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

describe("ProtectedRoute", () => {
  function renderAt(path: string, auth: AuthContextValue, access: AccessContextValue) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <AuthContext.Provider value={auth}>
          <AccessContext.Provider value={access}>
            <Routes>
              <Route path="/login" element={<div>login screen</div>} />
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<div>dashboard outlet</div>} />
                <Route path="/cohorts" element={<div>cohorts outlet</div>} />
                <Route path="/support" element={<div>support outlet</div>} />
              </Route>
            </Routes>
            <Where />
          </AccessContext.Provider>
        </AuthContext.Provider>
      </MemoryRouter>,
    );
  }

  it("shows the session loader while auth restores (before anything about access)", () => {
    renderAt("/", authFor(null, { loading: true }), status("loading"));
    expect(screen.getByText(/loading session/i)).toBeInTheDocument();
    expect(screen.queryByText(/checking access/i)).toBeNull();
  });

  it("redirects to /login without a user, whatever the access state says", () => {
    renderAt("/cohorts", authFor(null), OWNER());
    expect(screen.getByText("login screen")).toBeInTheDocument();
    expect(screen.queryByTestId("saved-data-auto-loader")).toBeNull();
  });

  it("redirects to /login when auth is not configured", () => {
    renderAt("/", authFor(USER, { configured: false }), OWNER());
    expect(screen.getByText("login screen")).toBeInTheDocument();
  });

  it("keeps a loader (and no page, no auto-loader) until access resolves", () => {
    renderAt("/", authFor(USER), status("loading"));
    expect(screen.getByText(/checking access/i)).toBeInTheDocument();
    expect(screen.queryByText("dashboard outlet")).toBeNull();
    expect(screen.queryByTestId("saved-data-auto-loader")).toBeNull();
  });

  it("treats a one-render signed_out lag like loading", () => {
    renderAt("/", authFor(USER), status("signed_out"));
    expect(screen.getByText(/checking access/i)).toBeInTheDocument();
  });

  it("shows the full-page NoAccess for no_membership and disabled", () => {
    const { unmount } = renderAt("/", authFor(USER), status("no_membership"));
    expect(screen.getByTestId("no-access-no_membership")).toBeInTheDocument();
    expect(screen.queryByText("dashboard outlet")).toBeNull();
    unmount();
    renderAt("/cohorts", authFor(USER), status("disabled"));
    expect(screen.getByTestId("no-access-disabled")).toBeInTheDocument();
    expect(screen.queryByText("cohorts outlet")).toBeNull();
  });

  it("shows the error NoAccess with a Retry that refreshes access", async () => {
    renderAt("/", authFor(USER), status("error"));
    expect(screen.getByTestId("no-access-error")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    });
    expect(refreshSpy).toHaveBeenCalledTimes(1);
  });

  it("fails closed on a status it does not know", () => {
    renderAt("/", authFor(USER), status("no_workspace"));
    expect(screen.getByTestId("no-access-error")).toBeInTheDocument();
  });

  it("redirects / to the first allowed page when the Dashboard is not allowed", () => {
    renderAt("/", authFor(USER), member(["support.view", "forecasting.view"]));
    expect(screen.getByText("support outlet")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/support");
  });

  it("stays on / when the Dashboard is allowed, and when nothing is allowed", () => {
    const { unmount } = renderAt("/", authFor(USER), VIEWER());
    expect(screen.getByText("dashboard outlet")).toBeInTheDocument();
    unmount();
    renderAt("/", authFor(USER), member(["ai.use"]));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/);
  });

  it("does not redirect other paths", () => {
    renderAt("/cohorts", authFor(USER), member(["support.view"]));
    expect(screen.getByTestId("location")).toHaveTextContent("/cohorts");
  });

  describe("outlet key (Phase 2)", () => {
    let mounts = 0;
    function Counted() {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <div>counted outlet</div>;
    }
    function tree(access: AccessContextValue) {
      return (
        <MemoryRouter initialEntries={["/cohorts"]}>
          <AuthContext.Provider value={authFor(USER)}>
            <AccessContext.Provider value={access}>
              <Routes>
                <Route element={<ProtectedRoute />}>
                  <Route path="/cohorts" element={<Counted />} />
                </Route>
              </Routes>
            </AccessContext.Provider>
          </AuthContext.Provider>
        </MemoryRouter>
      );
    }

    beforeEach(() => {
      mounts = 0;
    });

    it("remounts a restricted member's page when the access partition changes", () => {
      const view = render(tree(BUYER_A("p-buyer-1")));
      expect(screen.getByText("counted outlet")).toBeInTheDocument();
      view.rerender(tree(BUYER_A("p-buyer-1")));
      expect(mounts).toBe(1);
      view.rerender(tree(BUYER_A("p-buyer-2")));
      expect(mounts).toBe(2);
    });

    it("never remounts the page of an unrestricted member on a partition change", () => {
      const view = render(tree(member(["cohorts.view"], { partition: "p-1" })));
      view.rerender(tree(member(["cohorts.view"], { partition: "p-2" })));
      expect(mounts).toBe(1);
      expect(screen.getByText("counted outlet")).toBeInTheDocument();
    });
  });

  it("mounts SavedDataAutoLoader only with raw access (owner and legacy, never an employee)", () => {
    const { unmount } = renderAt("/", authFor(USER), OWNER());
    expect(screen.getByTestId("saved-data-auto-loader")).toBeInTheDocument();
    expect(screen.getByText("dashboard outlet")).toBeInTheDocument();
    unmount();

    const legacy = renderAt("/", authFor(USER), LEGACY());
    expect(screen.getByTestId("saved-data-auto-loader")).toBeInTheDocument();
    legacy.unmount();

    // Even an employee holding every page permission is not the data owner.
    renderAt("/", authFor(USER), member(["dashboard.view", "transactions.view", "leads.view", "subscriptions.view", "admin.data.import"]));
    expect(screen.getByText("dashboard outlet")).toBeInTheDocument();
    expect(screen.queryByTestId("saved-data-auto-loader")).toBeNull();
  });
});

describe("AppSidebar", () => {
  function renderSidebar(access: AccessContextValue, path = "/") {
    const client = new QueryClient();
    return render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <AuthContext.Provider value={authFor(USER)}>
            <AccessContext.Provider value={access}>
              <SidebarProvider>
                <AppSidebar />
              </SidebarProvider>
            </AccessContext.Provider>
          </AuthContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  const linkNames = () => screen.queryAllByRole("link").map((link) => link.textContent);
  const ALL_PAGES = ["Dashboard", "Transactions", "Users", "Cohorts", "Funnels", "Reports", "FB-Analytics", "Integrations", "Support", "Forecasting", "Subscriptions", "Import data"];

  it("owner sees every page plus the Administration group", () => {
    renderSidebar(OWNER());
    expect(linkNames()).toEqual([...ALL_PAGES, "Members", "Roles", "Audit log", "Funnel coverage"]);
    expect(screen.getByText("Administration")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Funnel coverage" })).toHaveAttribute("href", "/admin/funnels");
  });

  it("funnels.manage alone (scope all) opens the Administration group with Funnel coverage only", () => {
    renderSidebar(member(["funnels.view", "funnels.manage"]));
    expect(screen.getByText("Administration")).toBeInTheDocument();
    expect(linkNames()).toEqual(["Funnels", "Funnel coverage"]);
  });

  it("a restricted media buyer sees exactly the four media-buyer pages and no Administration", () => {
    renderSidebar(BUYER_A());
    expect(linkNames()).toEqual(["Dashboard", "Cohorts", "Funnels", "FB-Analytics"]);
    expect(screen.queryByText("Administration")).toBeNull();
  });

  it("a restricted member never sees a page outside the ready set, whatever the role grants", () => {
    renderSidebar(member(
      ["dashboard.view", "cohorts.view", "reports.view", "support.view", "forecasting.view", "transactions.view", "users.view", "users.pii.view", "funnels.manage", "admin.users.view"],
      { mode: "selected" },
    ));
    expect(linkNames()).toEqual(["Dashboard", "Cohorts"]);
    expect(screen.queryByText("Administration")).toBeNull();
    cleanup();
    renderSidebar(member(["reports.view", "support.view"], { mode: "none" }));
    expect(linkNames()).toEqual([]);
  });

  it("legacy keeps today's sidebar: every page, no Administration group", () => {
    renderSidebar(LEGACY());
    expect(linkNames()).toEqual(ALL_PAGES);
    expect(screen.queryByText("Administration")).toBeNull();
  });

  it("viewer sees only its pages and no Administration group", () => {
    renderSidebar(VIEWER());
    expect(linkNames()).toEqual(["Dashboard", "Cohorts", "Funnels", "Reports"]);
    expect(screen.queryByText("Administration")).toBeNull();
  });

  it("raw-only pages stay hidden for an employee holding their permissions", () => {
    renderSidebar(member(["leads.view", "subscriptions.view", "admin.data.import", "support.view"]));
    expect(linkNames()).toEqual(["Support"]);
  });

  it("shows only the admin pages the member may open", () => {
    renderSidebar(member(["admin.users.view", "dashboard.view"]));
    expect(screen.getByText("Administration")).toBeInTheDocument();
    // Funnel coverage opens with admin.users.view (read-only) or funnels.manage.
    expect(linkNames()).toEqual(["Dashboard", "Members", "Funnel coverage"]);
    cleanup();
    renderSidebar(member(["admin.audit.view"]));
    expect(linkNames()).toEqual(["Audit log"]);
  });

  it("hides everything for a member with no page permission", () => {
    renderSidebar(member(["ai.use"]));
    expect(linkNames()).toEqual([]);
    expect(screen.queryByText("Workspace")).toBeNull();
  });

  it("prefetches Cohorts on hover keyed by the access partition (data owner)", () => {
    renderSidebar(OWNER());
    fireEvent.mouseEnter(screen.getByRole("link", { name: "Cohorts" }));
    expect(shell.prefetchCohortsNav).toHaveBeenCalledTimes(1);
    expect(shell.prefetchCohortsNav).toHaveBeenCalledWith(expect.any(QueryClient), "p-owner", expect.any(Number));
  });

  it("prefetches Cohorts for a scope-all member too, keyed by their partition (pre-Phase-2 behaviour)", () => {
    renderSidebar(member(["cohorts.view"], { partition: "p-viewer" }));
    fireEvent.mouseEnter(screen.getByRole("link", { name: "Cohorts" }));
    expect(shell.prefetchCohortsNav).toHaveBeenCalledTimes(1);
    expect(shell.prefetchCohortsNav).toHaveBeenCalledWith(expect.any(QueryClient), "p-viewer", expect.any(Number));
  });

  it("never prefetches Cohorts for a funnel-restricted member (selected or none)", () => {
    for (const access of [BUYER_A(), member(["cohorts.view"], { mode: "none", partition: "p-none" })]) {
      expect(access.restricted).toBe(true);
      renderSidebar(access);
      fireEvent.mouseEnter(screen.getByRole("link", { name: "Cohorts" }));
      fireEvent.focus(screen.getByRole("link", { name: "Cohorts" }));
      cleanup();
    }
    expect(shell.prefetchCohortsNav).not.toHaveBeenCalled();
  });

  it("legacy prefetch uses the legacy partition", () => {
    renderSidebar(LEGACY());
    fireEvent.focus(screen.getByRole("link", { name: "Cohorts" }));
    expect(shell.prefetchCohortsNav).toHaveBeenCalledWith(expect.any(QueryClient), "legacy:user-a", expect.any(Number));
  });

  it("does not prefetch outside ClickHouse mode", () => {
    shell.cohortsMode = "legacy";
    renderSidebar(OWNER());
    fireEvent.mouseEnter(screen.getByRole("link", { name: "Cohorts" }));
    expect(shell.prefetchCohortsNav).not.toHaveBeenCalled();
  });
});

describe("AppLayout", () => {
  function renderLayout(access: AccessContextValue, path = "/") {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={new QueryClient()}>
          <AuthContext.Provider value={authFor(USER)}>
            <AccessContext.Provider value={access}>
              <AppLayout title="Page">content</AppLayout>
            </AccessContext.Provider>
          </AuthContext.Provider>
        </QueryClientProvider>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    expect(useDataStore.getState().meta.source).toBe("mock");
  });

  it("owner and legacy keep the AI button, the drawer and the sample-data banner", () => {
    for (const access of [OWNER(), LEGACY()]) {
      const { unmount } = renderLayout(access);
      expect(screen.getByRole("button", { name: /^ai$/i })).toBeInTheDocument();
      expect(screen.getByTestId("ai-drawer")).toBeInTheDocument();
      expect(screen.getByText(/sample data mode/i)).toBeInTheDocument();
      unmount();
    }
  });

  it("hides AI without ai.use and the sample-data banner without raw access", () => {
    renderLayout(VIEWER());
    expect(screen.queryByRole("button", { name: /^ai$/i })).toBeNull();
    expect(screen.queryByTestId("ai-drawer")).toBeNull();
    expect(screen.queryByText(/sample data mode/i)).toBeNull();
    expect(screen.getByText("content")).toBeInTheDocument();
  });

  it("shows AI to an employee with ai.use", () => {
    renderLayout(member(["dashboard.view", "ai.use"]));
    expect(screen.getByTestId("ai-drawer")).toBeInTheDocument();
    expect(screen.queryByText(/sample data mode/i)).toBeNull();
  });

  it("hides AI from a funnel-restricted member even with ai.use (Phase 2.4)", () => {
    const buyer = BUYER_A();
    expect(buyer.can("ai.use")).toBe(true);
    renderLayout(buyer);
    expect(screen.queryByRole("button", { name: /^ai$/i })).toBeNull();
    expect(screen.queryByTestId("ai-drawer")).toBeNull();
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});

describe("AccessErrorBridge", () => {
  const ClickHouseRequestError = clickhouse.ClickHouseRequestError;

  // Built through the prototype so the suite does not depend on the
  // constructor signature (only on the documented fields).
  function edgeError(status: number, errorCode: string | null): Error {
    const error = Object.create(ClickHouseRequestError.prototype) as Error & Record<string, unknown>;
    Object.assign(error, { name: "ClickHouseRequestError", message: `ClickHouse Edge Function failed: ${errorCode}`, status, errorCode, requestId: "req-1" });
    return error;
  }

  function renderBridge(options: { user?: AuthUser | null; minGapMs?: number } = {}) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const signOut = vi.fn(async () => {});
    const refresh = vi.fn(async () => {});
    const access = buildAccessValue({ status: "ok", access: okRow({ permissions: ["cohorts.view"] }), userId: USER.id, refresh });
    render(
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={authFor(options.user === undefined ? USER : options.user, { signOut })}>
          <AccessContext.Provider value={access}>
            <AccessErrorBridge refreshDebounceMs={10} refreshMinGapMs={options.minGapMs ?? 150} />
          </AccessContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>,
    );
    return { client, signOut, refresh };
  }

  let keySeq = 0;
  async function failQuery(client: QueryClient, error: unknown) {
    keySeq += 1;
    await client
      .fetchQuery({ queryKey: ["bridge-test", keySeq], queryFn: async () => { throw error; }, retry: false })
      .catch(() => undefined);
  }

  const settle = (ms = 60) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));

  it("signs out once on 401 invalid_session, even for a burst", async () => {
    const { client, signOut, refresh } = renderBridge();
    await failQuery(client, edgeError(401, "invalid_session"));
    await failQuery(client, edgeError(401, "invalid_session"));
    await failQuery(client, edgeError(401, "invalid_session"));
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1));
    await settle();
    expect(signOut).toHaveBeenCalledTimes(1);
    // This browser only: one rejected request must not revoke the user's
    // sessions on every other device (supabase-js defaults to "global").
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does not sign out when nobody is signed in", async () => {
    const { client, signOut } = renderBridge({ user: null });
    await failQuery(client, edgeError(401, "invalid_session"));
    await settle();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("refreshes access once (debounced) for a burst of 403 access errors", async () => {
    const { client, signOut, refresh } = renderBridge();
    await failQuery(client, edgeError(403, "permission_denied"));
    await failQuery(client, edgeError(403, "scope_not_supported"));
    await failQuery(client, edgeError(403, "membership_disabled"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await settle();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
  });

  it("covers every 403 access code of the contract", async () => {
    for (const code of ["no_membership", "membership_disabled", "permission_denied", "scope_not_supported", "raw_access_required", "funnel_out_of_scope"]) {
      const { client, refresh } = renderBridge();
      await failQuery(client, edgeError(403, code));
      await waitFor(() => expect(refresh, code).toHaveBeenCalledTimes(1));
      cleanup();
    }
  });

  it("spaces repeated refreshes by the minimum gap", async () => {
    const { client, refresh } = renderBridge({ minGapMs: 200 });
    await failQuery(client, edgeError(403, "permission_denied"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await failQuery(client, edgeError(403, "permission_denied"));
    await settle(60);
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2), { timeout: 1000 });
  });

  it("refreshes on a 403 from a mutation too", async () => {
    const { client, refresh } = renderBridge();
    const observer = new MutationObserver(client, { mutationFn: async () => { throw edgeError(403, "raw_access_required"); } });
    await observer.mutate().catch(() => undefined);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it("refreshes access on 403 funnel_out_of_scope (the funnel scope probably changed), never signs out", async () => {
    const { client, signOut, refresh } = renderBridge();
    await failQuery(client, edgeError(403, "funnel_out_of_scope"));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(signOut).not.toHaveBeenCalled();
  });

  it("does nothing for 409 scope_snapshot_not_ready (the page polls; never a sign-out or refresh)", async () => {
    const { client, signOut, refresh } = renderBridge();
    for (let i = 0; i < 3; i += 1) await failQuery(client, edgeError(409, "scope_snapshot_not_ready"));
    const observer = new MutationObserver(client, { mutationFn: async () => { throw edgeError(409, "scope_snapshot_not_ready"); } });
    await observer.mutate().catch(() => undefined);
    await settle();
    expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing for 503 auth/access service errors (never signs out)", async () => {
    const { client, signOut, refresh } = renderBridge();
    for (const code of ["auth_service_error", "access_service_error", "workspace_not_bootstrapped"]) {
      await failQuery(client, edgeError(503, code));
    }
    await settle();
    expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores untyped errors (never reads message text) and 401s without invalid_session", async () => {
    const { client, signOut, refresh } = renderBridge();
    await failQuery(client, new Error("ClickHouse Edge Function failed: invalid_session permission_denied"));
    await failQuery(client, edgeError(401, null));
    await failQuery(client, edgeError(500, "request_failed"));
    await settle();
    expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("ignores a late error of a query the purge already dropped", async () => {
    const { client, signOut, refresh } = renderBridge();
    let reject: (error: unknown) => void = () => {};
    const pending = client
      .fetchQuery({ queryKey: ["in-flight"], queryFn: () => new Promise((_, rej) => (reject = rej)), retry: false })
      .catch(() => undefined);
    await act(async () => {
      client.clear();
    });
    reject(edgeError(401, "invalid_session"));
    await pending;
    await settle();
    expect(signOut).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("FunnelPathChips", () => {
  const PATHS = [
    { path: "soulmate-sketch-v2", status: "proposed" },
    { path: "soulmate-sketch", status: "retired" },
    { path: "soulmate-1-tariff-month-veb", status: "active" },
    { path: "soulmate-old", status: "revoked" },
    { path: "soulmate-a", status: "active" },
  ] as const;
  const chips = () => screen.queryAllByTestId("funnel-path-chip").map((chip) => [chip.getAttribute("data-status"), chip.textContent]);

  it("shows the granting paths by default: active first, retired with a muted (old) badge", () => {
    render(<FunnelPathChips paths={PATHS} />);
    expect(chips()).toEqual([
      ["active", "soulmate-1-tariff-month-veb"],
      ["active", "soulmate-a"],
      ["retired", "soulmate-sketch(old)"],
    ]);
  });

  it("showInactive adds proposed and revoked rows after them", () => {
    render(<FunnelPathChips paths={PATHS} showInactive />);
    expect(chips().map(([status]) => status)).toEqual(["active", "active", "retired", "proposed", "revoked"]);
    expect(screen.getByText("(proposed)")).toBeInTheDocument();
    expect(screen.getByText("(revoked)")).toBeInTheDocument();
  });

  it("renders a dash when nothing grants access", () => {
    render(<FunnelPathChips paths={[{ path: "x-y", status: "proposed" }]} />);
    expect(chips()).toEqual([]);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("typed Edge errors: Phase-2 scope codes", () => {
  const PHASE2 = [
    { status: 409, code: "scope_snapshot_not_ready" },
    { status: 403, code: "funnel_out_of_scope" },
  ] as const;

  it("are access errors, so they are never retried and never fall back", () => {
    for (const { status, code } of PHASE2) {
      const error = new clickhouse.ClickHouseRequestError(`ClickHouse Edge Function failed: ${ACCESS_ERROR_MESSAGES[code]}`, { status, errorCode: code, requestId: "req-1" });
      expect(clickhouse.isAccessError(error), code).toBe(true);
      expect(clickhouse.isAccessErrorCode(code), code).toBe(true);
      expect(clickhouse.isAccessServiceError(error), code).toBe(false);
    }
  });

  it("never open the ClickHouse breaker, even with a transport-shaped message", () => {
    for (const { status, code } of PHASE2) {
      for (const message of [ACCESS_ERROR_MESSAGES[code], "upstream connect error: connection reset (timeout)"]) {
        expect(clickhouse.shouldOpenClickHouseCircuit({ status, errorCode: code, message }), `${code}: ${message}`).toBe(false);
      }
      // The gate's own copy for these codes is not breaker-shaped either.
      expect(clickhouse.isWarehouseDownError(ACCESS_ERROR_MESSAGES[code]), code).toBe(false);
    }
  });
});

describe("App.tsx routes (static)", () => {
  it("every protected route is wrapped in RequirePermission with its own path, admin routes included", () => {
    const source = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    const allRoutes = [...source.matchAll(/<Route\s+path="(\/[^"]*)"\s+element=\{(.*)\}\s*\/>/g)].filter((match) => match[1] !== "/login");
    // /leads is a pure redirect into the Users page tab (guarded there).
    const redirects = allRoutes.filter(([, , element]) => element.startsWith("<Navigate "));
    expect(redirects.map(([, path, element]) => [path, element])).toEqual([["/leads", '<Navigate to="/users?tab=leads" replace />']]);
    const routes = allRoutes.filter(([, , element]) => !element.startsWith("<Navigate "));
    expect(routes.length).toBeGreaterThanOrEqual(15);
    for (const [, path, element] of routes) {
      expect(element, path).toMatch(new RegExp(`^<RequirePermission route="${path.replace(/[/-]/g, "\\$&")}">`));
    }
    for (const path of ["/admin/members", "/admin/roles", "/admin/audit", "/admin/funnels"]) {
      expect(routes.map((match) => match[1])).toContain(path);
    }
    for (const page of ["AdminMembers", "AdminRoles", "AdminAudit", "AdminFunnelCoverage"]) {
      expect(source).toContain(`import("./pages/admin/${page}.tsx")`);
    }
  });

  it("nests the providers Auth → Access → AnalyticsCacheGate with the error bridge inside", () => {
    const source = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    const order = ["<AuthProvider>", "<AccessProvider>", "<AccessErrorBridge />", "<AnalyticsCacheGate>", "<Routes>", "</AnalyticsCacheGate>", "</AccessProvider>", "</AuthProvider>"];
    const positions = order.map((token) => source.indexOf(token));
    expect(positions.every((position) => position >= 0), JSON.stringify(positions)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

// The admin pages are created in parallel by the admin UI track; Vite cannot
// transform App.tsx (it resolves every lazy import) until they exist.
const ADMIN_PAGES_PRESENT = [
  ...new Set([
    "AdminMembers",
    "AdminRoles",
    "AdminAudit",
    ...[...readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8").matchAll(/import\("\.\/pages\/admin\/(\w+)\.tsx"\)/g)].map((match) => match[1]),
  ]),
].every((page) => existsSync(resolve(process.cwd(), `src/pages/admin/${page}.tsx`)));

describe.runIf(ADMIN_PAGES_PRESENT)("App", () => {
  let App: ComponentType;

  beforeAll(async () => {
    App = (await import("@/App")).default;
  });

  function renderApp(path: string) {
    window.history.replaceState(null, "", path);
    return render(<App />);
  }

  it("registers the page-UI-state purge at app start, although the hook lives only in lazy page chunks", () => {
    // Without the side-effect import the first principal_changed purge at app
    // start ran before any page chunk loaded, leaving bare ui_state_* keys.
    const app = readFileSync(resolve(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toMatch(/^import "@\/hooks\/usePersistedPageState";$/m);
    expect(registeredPurgeHandlers()).toContain("page-ui-state");
  });

  it("registers a purge handler that clears the React Query cache", async () => {
    expect(registeredPurgeHandlers()).toContain("react-query");
    renderApp("/");
    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    const client = shell.appQueryClient as QueryClient;
    client.setQueryData(["some", "partitioned", "entry"], { rows: 1 });
    expect(client.getQueryCache().getAll().length).toBeGreaterThan(0);
    await act(async () => {
      await runPurge("access_changed");
    });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it("owner opens every page, including the admin pages, with the auto-loader mounted", async () => {
    renderApp("/admin/members");
    expect(await screen.findByText(/admin members page/)).toBeInTheDocument();
    expect(screen.getByTestId("saved-data-auto-loader")).toBeInTheDocument();
    cleanup();
    // /leads now lands on the Users page (its Leads tab).
    renderApp("/leads");
    expect(await screen.findByText("users page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/users");
  });

  it("redirects / to the first allowed page for a member without the Dashboard", async () => {
    accessValue = member(["cohorts.view"]);
    renderApp("/");
    expect(await screen.findByText("cohorts page")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/cohorts");
    expect(screen.queryByTestId("saved-data-auto-loader")).toBeNull();
  });

  it("wraps each route in its guard: a denied page renders NoAccess inside the app shell", async () => {
    accessValue = VIEWER();
    renderApp("/users");
    // The sidebar stays (filtered) so the member can navigate away; the app
    // shell is lazy, so wait for it rather than for the Suspense fallback.
    expect(await screen.findByRole("link", { name: "Cohorts" })).toBeInTheDocument();
    expect(screen.getByTestId("no-access")).toBeInTheDocument();
    expect(screen.queryByText("users page")).toBeNull();
    const nav = screen.getAllByRole("link").map((link) => link.textContent);
    expect(nav).toEqual(expect.arrayContaining(["Dashboard", "Cohorts", "Funnels", "Reports"]));
    expect(nav).not.toContain("Users");
  });

  it("raw-only pages are denied to an employee even with the permission", async () => {
    accessValue = member(["leads.view", "dashboard.view"]);
    renderApp("/leads");
    expect(await screen.findByTestId("no-access")).toBeInTheDocument();
    expect(screen.queryByText("leads page")).toBeNull();
  });

  it("admin routes follow their own permissions", async () => {
    accessValue = member(["admin.roles.view"]);
    renderApp("/admin/roles");
    expect(await screen.findByText(/admin roles page/)).toBeInTheDocument();
    cleanup();
    renderApp("/admin/audit");
    expect(await screen.findByTestId("no-access")).toBeInTheDocument();
    expect(screen.queryByText(/admin audit page/)).toBeNull();
  });

  it("a restricted media buyer opens the four media-buyer pages; other granted pages show the scope copy", async () => {
    accessValue = member([...MEDIA_BUYER_KEYS, "reports.view"], { mode: "selected", partition: "p-buyer-a" });
    renderApp("/fb-analytics");
    expect(await screen.findByText("fb analytics page")).toBeInTheDocument();
    expect(screen.queryByTestId("saved-data-auto-loader")).toBeNull();
    cleanup();

    renderApp("/reports");
    // The denial renders inside the (lazy) app shell: wait for the sidebar.
    expect(await screen.findByRole("link", { name: "FB-Analytics" })).toBeInTheDocument();
    const panel = screen.getByTestId("no-access");
    expect(panel).toHaveAttribute("data-reason", "scope");
    expect(within(panel).getByText(RESTRICTED_SCOPE_DENIAL_COPY)).toBeInTheDocument();
    expect(screen.queryByText("reports page")).toBeNull();
    const nav = screen.getAllByRole("link").map((link) => link.textContent).filter((name) => name !== "Go to an available page");
    expect(nav).toEqual(["Dashboard", "Cohorts", "Funnels", "FB-Analytics"]);
    cleanup();

    renderApp("/admin/funnels");
    expect(await screen.findByTestId("no-access")).toBeInTheDocument();
    expect(screen.queryByText(/admin funnel coverage page/)).toBeNull();
  });

  it("owner opens the funnel coverage admin page", async () => {
    renderApp("/admin/funnels");
    expect(await screen.findByText(/admin funnel coverage page/)).toBeInTheDocument();
  });

  it("no membership replaces the whole app with the full-page NoAccess", async () => {
    accessValue = status("no_membership");
    renderApp("/cohorts");
    expect(await screen.findByTestId("no-access-no_membership")).toBeInTheDocument();
    expect(screen.queryByText("cohorts page")).toBeNull();
    expect(within(screen.getByTestId("no-access-no_membership")).getByRole("button", { name: /sign out/i })).toBeInTheDocument();
  });
});
