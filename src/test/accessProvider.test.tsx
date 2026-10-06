import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";

// Controllable auth user (AccessProvider reads useAuth).
type TestUser = { id: string; email: string; provider: "supabase" | "local" };
let authState: { loading: boolean; user: TestUser | null } = { loading: false, user: null };
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => authState }));
// Never construct the real Supabase client in this suite; tests inject a fake.
vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
// The app shell pulls the sidebar, AI drawer and stores; a stub is enough here.
vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, children }: { title: string; children: ReactNode }) =>
      React.createElement("div", { "data-testid": "app-layout" }, React.createElement("span", null, title), children),
  };
});

// What App.tsx imports for its side effect: the page-UI-state purge handler.
import "@/hooks/usePersistedPageState";
import { AccessProvider } from "@/components/AccessProvider";
import { RequirePermission } from "@/components/RequirePermission";
import { NoAccess } from "@/components/NoAccess";
import { useAccess } from "@/hooks/useAccess";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import { notePrincipal, registerPurgeHandler, type PurgeReason } from "@/services/sessionPurge";
import type { MyAccess, MyAccessRpcClient } from "@/services/accessClient";

const USER_A: TestUser = { id: "user-a", email: "a@example.com", provider: "supabase" };
const USER_B: TestUser = { id: "user-b", email: "b@example.com", provider: "supabase" };

function okRow(overrides: Record<string, unknown> = {}) {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-a",
    user_id: "user-a",
    email: "a@example.com",
    display_name: null,
    is_data_owner: false,
    raw_access: false,
    role: { id: "role-viewer", key: "viewer", name: "Viewer", is_owner: false, permissions: ["dashboard.view", "cohorts.view", "funnels.view", "reports.view"] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p1",
    ...overrides,
  };
}

const ok = (row: Record<string, unknown>) => ({ data: row, error: null, status: 200 });
const missingRpc = { data: null, error: { code: "PGRST202", message: "Could not find the function public.my_access" }, status: 404 };
const rpcFailure = { data: null, error: { code: "57014", message: "canceling statement" }, status: 500 };

function fakeClient(initial: unknown) {
  const box = { response: initial };
  const client = { rpc: vi.fn(async () => box.response) } satisfies MyAccessRpcClient;
  return { client, respond: (response: unknown) => (box.response = response) };
}

let latest: AccessContextValue | null = null;
function Probe() {
  latest = useAccess();
  return <div data-testid="probe">{`${latest.status}|${latest.partition}`}</div>;
}

function tree(client: MyAccessRpcClient | null, children: ReactNode = <Probe />) {
  return (
    <AccessProvider client={client} refreshIntervalMs={0} focusRefreshMinGapMs={0} firstResolveRetryDelaysMs={[]}>
      {children}
    </AccessProvider>
  );
}

// Purge handlers registered by a test; the registry is module-global.
const purges: Array<{ reason: PurgeReason; partitionAtPurge: string | undefined }> = [];
let unregister: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  // A browser this user already used (principal marker present). The unmarked
  // (pre-access / cleared-storage) browser is covered by its own tests below.
  notePrincipal(USER_A.id);
  authState = { loading: false, user: USER_A };
  latest = null;
  purges.length = 0;
  unregister = registerPurgeHandler("test-recorder", (reason) => {
    purges.push({ reason, partitionAtPurge: latest?.partition });
  });
});

afterEach(() => {
  unregister?.();
  cleanup();
  vi.restoreAllMocks();
});

describe("buildAccessValue (effective permissions)", () => {
  function access(input: { permissions?: string[]; isOwner?: boolean; mode?: "all" | "selected" | "none"; userId?: string; raw?: boolean }): MyAccess {
    return {
      status: "ok",
      workspace_id: "ws-1",
      member_id: "m-1",
      user_id: input.userId ?? "user-a",
      email: null,
      display_name: null,
      is_data_owner: input.raw === true,
      raw_access: input.raw === true,
      role: { id: "r-1", key: "custom", name: "Custom", is_owner: input.isOwner === true, permissions: input.permissions ?? [] },
      funnel_scope: { mode: input.mode ?? "all", funnel_ids: [], paths: [] },
      access_version: "1",
      partition: "p1",
    };
  }
  const value = (row: MyAccess) => buildAccessValue({ status: "ok", access: row, userId: "user-a" });

  it("owner holds every enforced key implicitly, but never planned or unknown keys", () => {
    const owner = value(access({ isOwner: true, permissions: [] }));
    expect(owner.can("admin.users.manage")).toBe(true);
    expect(owner.can("api_export.use")).toBe(true);
    expect(owner.can("users.pii.view")).toBe(true);
    expect(owner.can("financials.revenue.view")).toBe(false);
    expect(owner.can("made.up")).toBe(false);
  });

  it("planned keys are never effective even when granted", () => {
    const v = value(access({ permissions: ["financials.revenue.view", "financials.spend.view", "dashboard.view"] }));
    expect(v.can("financials.revenue.view")).toBe(false);
    expect(v.can("financials.spend.view")).toBe(false);
    expect(v.can("dashboard.view")).toBe(true);
    expect(v.permissions.has("financials.revenue.view")).toBe(false);
  });

  it("requiresFullScope keys are effective only with funnel scope all", () => {
    const granted = ["funnels.view", "funnels.manage", "admin.users.view"];
    expect(value(access({ permissions: granted, mode: "all" })).can("funnels.manage")).toBe(true);
    expect(value(access({ permissions: granted, mode: "all" })).can("admin.users.view")).toBe(true);
    for (const mode of ["selected", "none"] as const) {
      const v = value(access({ permissions: granted, mode }));
      expect(v.can("funnels.manage"), mode).toBe(false);
      expect(v.can("admin.users.view"), mode).toBe(false);
      expect(v.can("funnels.view"), mode).toBe(true);
    }
  });

  it("a key whose requires are not granted is not effective", () => {
    const v = value(access({ permissions: ["cohorts.export", "support.export"] }));
    expect(v.can("cohorts.export")).toBe(false);
    expect(v.can("support.export")).toBe(false);
  });

  it("canAny is true when any key passes and false for an empty list", () => {
    const v = value(access({ permissions: ["cohorts.view"] }));
    expect(v.canAny(["users.view", "cohorts.view"])).toBe(true);
    expect(v.canAny(["users.view"])).toBe(false);
    expect(v.canAny([])).toBe(false);
  });

  it("rawAccess needs the server flag AND a row about the signed-in user", () => {
    expect(value(access({ raw: true })).rawAccess).toBe(true);
    expect(value(access({ raw: true, userId: "someone-else" })).rawAccess).toBe(false);
    expect(value(access({ raw: false })).rawAccess).toBe(false);
  });

  it("legacy ⇒ can() true for anything, raw access, legacy partition", () => {
    const legacy = buildAccessValue({ status: "legacy", access: null, userId: "user-a" });
    expect(legacy.legacy).toBe(true);
    expect(legacy.can("admin.users.manage")).toBe(true);
    expect(legacy.can("anything.at.all")).toBe(true);
    expect(legacy.canAny(["x"])).toBe(true);
    expect(legacy.rawAccess).toBe(true);
    expect(legacy.partition).toBe("legacy:user-a");
  });

  it("non-ok statuses grant nothing and expose no partition", () => {
    for (const status of ["loading", "signed_out", "no_membership", "disabled", "error"] as const) {
      const v = buildAccessValue({ status, access: null, userId: "user-a" });
      expect(v.can("dashboard.view"), status).toBe(false);
      expect(v.rawAccess, status).toBe(false);
      expect(v.partition, status).toBe("");
      expect(v.permissions.size, status).toBe(0);
    }
    expect(buildAccessValue({ status: "loading", access: null, userId: "u" }).loading).toBe(true);
  });
});

describe("AccessProvider", () => {
  it("is loading until my_access answers, then exposes effective permissions", async () => {
    let release: (value: unknown) => void = () => {};
    const client = { rpc: vi.fn(() => new Promise((resolve) => (release = resolve))) };
    render(tree(client));

    expect(latest?.loading).toBe(true);
    expect(latest?.can("dashboard.view")).toBe(false);
    await waitFor(() => expect(client.rpc).toHaveBeenCalled());
    expect(latest?.loading).toBe(true);

    await act(async () => release(ok(okRow())));
    await waitFor(() => expect(latest?.status).toBe("ok"));
    expect(latest?.loading).toBe(false);
    expect(latest?.partition).toBe("p1");
    expect(latest?.can("cohorts.view")).toBe(true);
    expect(latest?.can("users.view")).toBe(false);
    expect(latest?.rawAccess).toBe(false);
    expect(client.rpc).toHaveBeenCalledWith("my_access");
  });

  it("maps a missing RPC to legacy (everything allowed, as today)", async () => {
    const { client } = fakeClient(missingRpc);
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("legacy"));
    expect(latest?.legacy).toBe(true);
    expect(latest?.can("admin.data.import")).toBe(true);
    expect(latest?.rawAccess).toBe(true);
    expect(latest?.partition).toBe("legacy:user-a");
  });

  it("uses legacy without calling the RPC for the local dev user", async () => {
    authState = { loading: false, user: { id: "local-admin", email: "admin", provider: "local" } };
    const { client } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("legacy"));
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("purges with access_changed BEFORE publishing a new partition", async () => {
    const { client, respond } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.partition).toBe("p1"));
    expect(purges).toEqual([]);

    respond(ok(okRow({ partition: "p2", access_version: "2" })));
    await act(async () => {
      await latest?.refresh();
    });

    await waitFor(() => expect(latest?.partition).toBe("p2"));
    expect(purges).toEqual([{ reason: "access_changed", partitionAtPurge: "p1" }]);
  });

  it("purges when only access_version changes, and not when nothing changed", async () => {
    const { client, respond } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));

    await act(async () => {
      await latest?.refresh();
    });
    expect(purges).toEqual([]);

    respond(ok(okRow({ access_version: "7" })));
    await act(async () => {
      await latest?.refresh();
    });
    expect(purges.map((entry) => entry.reason)).toEqual(["access_changed"]);
  });

  it("refetches on window focus", async () => {
    const { client } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));
    const before = client.rpc.mock.calls.length;

    await act(async () => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(client.rpc.mock.calls.length).toBe(before + 1));
  });

  it("refetches on the interval", async () => {
    const { client } = fakeClient(ok(okRow()));
    render(
      <AccessProvider client={client} refreshIntervalMs={25} focusRefreshMinGapMs={0}>
        <Probe />
      </AccessProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ok"));
    await waitFor(() => expect(client.rpc.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it("revocation on refresh: ok → disabled purges and grants nothing", async () => {
    const { client, respond } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));

    respond(ok({ status: "disabled", user_id: "user-a", workspace_id: "ws-1" }));
    await act(async () => {
      await latest?.refresh();
    });
    await waitFor(() => expect(latest?.status).toBe("disabled"));
    expect(latest?.can("dashboard.view")).toBe(false);
    expect(latest?.partition).toBe("");
    expect(purges.map((entry) => entry.reason)).toEqual(["access_changed"]);
  });

  it("a failed background refresh keeps the last resolved access", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, respond } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));

    respond(rpcFailure);
    await act(async () => {
      await latest?.refresh();
    });
    expect(latest?.status).toBe("ok");
    expect(latest?.can("cohorts.view")).toBe(true);
    expect(purges).toEqual([]);
    warn.mockRestore();
  });

  it("a failed first resolution is an error state; refresh recovers", async () => {
    const { client, respond } = fakeClient(rpcFailure);
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("error"));
    expect(latest?.loading).toBe(false);
    expect(latest?.can("dashboard.view")).toBe(false);

    respond(ok(okRow()));
    await act(async () => {
      await latest?.refresh();
    });
    await waitFor(() => expect(latest?.status).toBe("ok"));
    expect(purges).toEqual([]);
  });

  it("never trusts an ok row about a different user", async () => {
    const { client } = fakeClient(ok(okRow({ user_id: "user-b" })));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("error"));
    expect(latest?.can("dashboard.view")).toBe(false);
  });

  it("purges principal_changed on an in-tab account switch and signed_out on sign-out", async () => {
    const { client, respond } = fakeClient(ok(okRow()));
    const view = render(tree(client));
    await waitFor(() => expect(latest?.partition).toBe("p1"));

    authState = { loading: false, user: USER_B };
    respond(ok(okRow({ user_id: "user-b", member_id: "member-b", partition: "p-b" })));
    view.rerender(tree(client));
    // The previous user's access is never exposed for the new user.
    expect(latest?.partition).not.toBe("p1");
    await waitFor(() => expect(latest?.partition).toBe("p-b"));
    expect(purges.map((entry) => entry.reason)).toEqual(["principal_changed"]);

    authState = { loading: false, user: null };
    view.rerender(tree(client));
    await waitFor(() => expect(latest?.status).toBe("signed_out"));
    expect(latest?.loading).toBe(false);
    expect(latest?.can("dashboard.view")).toBe(false);
    await waitFor(() => expect(purges.map((entry) => entry.reason)).toEqual(["principal_changed", "signed_out"]));
  });

  it("purges principal_changed at start when another user used this browser last, before fetching", async () => {
    notePrincipal("someone-else");
    const order: string[] = [];
    unregister?.();
    unregister = registerPurgeHandler("test-recorder", async (reason) => {
      order.push(`purge:${reason}`);
    });
    const client = {
      rpc: vi.fn(async () => {
        order.push("rpc");
        return ok(okRow());
      }),
    };
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));
    expect(order).toEqual(["purge:principal_changed", "rpc"]);
  });

  it("an unmarked browser (no principal marker): the data owner keeps what is on disk — no purge", async () => {
    localStorage.clear();
    const { client } = fakeClient(ok(okRow({ raw_access: true, is_data_owner: true })));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));
    expect(latest?.rawAccess).toBe(true);
    expect(purges).toEqual([]);
  });

  it("an unmarked browser: legacy mode (pre-bootstrap) behaves as today — no purge", async () => {
    localStorage.clear();
    const { client } = fakeClient(missingRpc);
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("legacy"));
    expect(purges).toEqual([]);
  });

  it("an unmarked browser: anyone else is purged (principal_changed) BEFORE their access is published", async () => {
    localStorage.clear();
    localStorage.setItem("ui_state_users", JSON.stringify({ search: "leftover@example.com" }));
    const { client } = fakeClient(ok(okRow()));
    render(tree(client));
    await waitFor(() => expect(latest?.status).toBe("ok"));
    // The recorder saw the purge while the provider still exposed no partition.
    expect(purges).toEqual([{ reason: "principal_changed", partitionAtPurge: "" }]);
    // The page-UI purge (registered at app start by App.tsx's side-effect import)
    // removed the unowned pre-suffix value.
    expect(localStorage.getItem("ui_state_users")).toBeNull();

    // Marked now: the next app start for the same user purges nothing more.
    cleanup();
    purges.length = 0;
    render(tree(fakeClient(ok(okRow())).client));
    await waitFor(() => expect(latest?.status).toBe("ok"));
    expect(purges).toEqual([]);
  });

  it("retries a failed FIRST resolution before showing the error state", async () => {
    const responses = [rpcFailure, rpcFailure, ok(okRow())];
    const client = { rpc: vi.fn(async () => responses.shift() ?? ok(okRow())) } satisfies MyAccessRpcClient;
    const seen: string[] = [];
    function Recorder() {
      const value = useAccess();
      seen.push(value.status);
      return null;
    }
    render(
      <AccessProvider client={client} refreshIntervalMs={0} focusRefreshMinGapMs={0} firstResolveRetryDelaysMs={[5, 5]}>
        <Recorder />
        <Probe />
      </AccessProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("ok"));
    expect(client.rpc).toHaveBeenCalledTimes(3);
    expect(seen).not.toContain("error");
  });

  it("shows the error state once the first-resolution retries are exhausted", async () => {
    const { client } = fakeClient(rpcFailure);
    render(
      <AccessProvider client={client} refreshIntervalMs={0} focusRefreshMinGapMs={0} firstResolveRetryDelaysMs={[5, 5]}>
        <Probe />
      </AccessProvider>,
    );
    await waitFor(() => expect(latest?.status).toBe("error"));
    expect(client.rpc).toHaveBeenCalledTimes(3);
  });
});

describe("RequirePermission", () => {
  function withValue(value: AccessContextValue, children: ReactNode) {
    return (
      <MemoryRouter initialEntries={["/users"]}>
        <AccessContext.Provider value={value}>{children}</AccessContext.Provider>
      </MemoryRouter>
    );
  }
  const viewerRow: MyAccess = {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "m",
    user_id: "user-a",
    email: null,
    display_name: null,
    is_data_owner: false,
    raw_access: false,
    role: { id: "r", key: "viewer", name: "Viewer", is_owner: false, permissions: ["dashboard.view", "cohorts.view"] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p1",
  };
  const viewer = buildAccessValue({ status: "ok", access: viewerRow, userId: "user-a" });

  it("renders children when allowed", () => {
    render(withValue(viewer, <RequirePermission anyOf={["cohorts.view"]}>cohorts page</RequirePermission>));
    expect(screen.getByText("cohorts page")).toBeInTheDocument();
  });

  it("renders NoAccess inside the app shell when denied, with a link to an allowed page", async () => {
    render(withValue(viewer, <RequirePermission route="/users">users page</RequirePermission>));
    expect(screen.queryByText("users page")).toBeNull();
    expect(await screen.findByTestId("app-layout")).toBeInTheDocument();
    expect(screen.getByTestId("no-access")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /available page/i })).toHaveAttribute("href", "/");
  });

  it("uses the fallback when given", () => {
    render(withValue(viewer, <RequirePermission allOf={["cohorts.view", "cohorts.export"]} fallback={<span>hidden</span>}>export</RequirePermission>));
    expect(screen.getByText("hidden")).toBeInTheDocument();
    expect(screen.queryByText("export")).toBeNull();
  });

  it("denies rawOnly for a non-owner and allows everything in legacy", () => {
    const { rerender } = render(withValue(viewer, <RequirePermission rawOnly fallback={<span>denied</span>}>raw</RequirePermission>));
    expect(screen.getByText("denied")).toBeInTheDocument();
    const legacy = buildAccessValue({ status: "legacy", access: null, userId: "user-a" });
    rerender(withValue(legacy, <RequirePermission route="/import" rawOnly fallback={<span>denied</span>}>raw</RequirePermission>));
    expect(screen.getByText("raw")).toBeInTheDocument();
  });

  it("shows a loader while access is loading", () => {
    render(withValue(buildAccessValue({ status: "loading", access: null, userId: "user-a" }), <RequirePermission anyOf={["cohorts.view"]}>x</RequirePermission>));
    expect(screen.getByText(/checking access/i)).toBeInTheDocument();
  });
});

describe("NoAccess full-page variants", () => {
  it("no_membership offers Sign out", async () => {
    const onSignOut = vi.fn(async () => {});
    render(<NoAccess variant="no_membership" onSignOut={onSignOut} />);
    expect(screen.getByText("No workspace access")).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign out/i }));
    });
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it("error offers Retry", async () => {
    const onRetry = vi.fn(async () => {});
    render(<NoAccess variant="error" onRetry={onRetry} onSignOut={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("copy never uses the word the breaker matches", () => {
    for (const variant of ["inline", "no_membership", "disabled", "error"] as const) {
      const { container, unmount } = render(<NoAccess variant={variant} onSignOut={() => {}} onRetry={() => {}} />);
      expect(container.textContent?.toLowerCase()).not.toContain("unavailable");
      unmount();
    }
  });
});
