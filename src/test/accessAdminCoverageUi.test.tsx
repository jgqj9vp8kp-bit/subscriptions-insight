import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";

// Admin → Funnel coverage (access Phase 2, spec §5.4) against SHARED CONTRACT 8.
// The `access` Edge function is an in-memory fake behind
// supabase.functions.invoke (and the browser registry read behind
// supabase.from), so the client, the hooks and the page run for real.

type Json = Record<string, unknown>;

const backend = vi.hoisted(() => ({
  calls: [] as Array<{ fn: string; body: Record<string, unknown> }>,
  registryReads: 0,
  handler: null as null | ((action: string, body: Record<string, unknown>) => { status?: number; body: unknown }),
}));

vi.mock("@/services/supabaseClient", () => ({
  isSupabaseConfigured: true,
  supabase: {
    auth: { getSession: async () => ({ data: { session: { access_token: "token-1" } }, error: null }) },
    functions: {
      invoke: async (fn: string, options: { body: Record<string, unknown> }) => {
        backend.calls.push({ fn, body: options.body });
        const result = backend.handler ? backend.handler(String(options.body.action), options.body) : { status: 500, body: { ok: false, error: "no handler" } };
        const status = result.status ?? 200;
        if (status >= 200 && status < 300) return { data: result.body, error: null };
        const error = Object.assign(new Error("Edge Function returned a non-2xx status code"), {
          context: new Response(JSON.stringify(result.body), { status, headers: { "content-type": "application/json" } }),
        });
        return { data: null, error };
      },
    },
    // The browser funnel registry (src/services/funnels.ts listFunnels).
    from: (table: string) => ({
      select: () => ({
        order: async () => {
          backend.registryReads += 1;
          if (table !== "funnels") return { data: [], error: null };
          return {
            data: REGISTRY.map((funnel) => ({
              id: funnel.id,
              funnel_path: funnel.funnel_path,
              display_name: funnel.display_name,
              is_active: funnel.is_active,
              funnel_tags: [],
            })),
            error: null,
          };
        },
      }),
    }),
  },
}));

vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) =>
      React.createElement("div", null, React.createElement("h1", null, title), React.createElement("div", { "data-testid": "layout-actions" }, actions), children),
  };
});

import { TooltipProvider } from "@/components/ui/tooltip";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { attachFunnelPath, fetchPathCoverage, setFunnelPathStatus, type AdminFunnelPath, type FunnelCoverage } from "@/services/accessAdminClient";
import { coveragePathActions, pathImpactText } from "@/components/admin/accessAdminModel";
import AdminFunnelCoveragePage from "@/pages/admin/AdminFunnelCoverage";

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

const REGISTRY = [
  {
    id: "f-1",
    funnel_path: "/Soulmate-Sketch",
    display_name: "Soulmate Sketch",
    is_active: true,
    tags: [],
    paths: [funnelPath("1", "f-1", "soulmate-sketch", "active"), funnelPath("2", "f-1", "soulmate-1-tariff-month-veb", "proposed", "funnelfox_alias_seed")],
  },
  {
    id: "f-2",
    funnel_path: "past-life",
    display_name: "Past Life",
    is_active: true,
    tags: [],
    paths: [
      funnelPath("3", "f-2", "past-life", "active"),
      funnelPath("6", "f-2", "past-life-v2", "active", "admin_alias"),
      funnelPath("4", "f-2", "past-life-old", "retired"),
    ],
  },
  { id: "f-3", funnel_path: "/palm-reading", display_name: "Palm Reading", is_active: true, tags: [], paths: [funnelPath("5", "f-3", "palm-reading", "active")] },
];

const MEMBERS = [
  { id: "m-1", user_id: "u-1", email: "a@example.com", display_name: "A", status: "active", is_data_owner: false, role: {}, funnel_scope: { mode: "selected", funnel_ids: ["f-1", "f-3"] } },
  { id: "m-2", user_id: "u-2", email: "b@example.com", display_name: "B", status: "active", is_data_owner: false, role: {}, funnel_scope: { mode: "selected", funnel_ids: ["F-1"] } },
  { id: "m-3", user_id: "u-3", email: "c@example.com", display_name: "C", status: "disabled", is_data_owner: false, role: {}, funnel_scope: { mode: "selected", funnel_ids: ["f-1", "f-3"] } },
  { id: "m-4", user_id: "u-4", email: "d@example.com", display_name: "D", status: "active", is_data_owner: false, role: {}, funnel_scope: { mode: "all", funnel_ids: [] } },
];

function coverageRow(path: string, users: number, net: number, extra: Partial<FunnelCoverage["paths"][number]> = {}): FunnelCoverage["paths"][number] {
  return {
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
  };
}

function coverageFixture(): Json {
  return {
    ok: true,
    snapshot: { status: "current", warehouse_version: "wh-20261006", generated_at: "2026-10-06T00:00:00Z" },
    totals: { users: 14837, synthetic_users: 240, registered_users: 14600, registered_pct: 98.4, net_revenue: 100000, registered_net_revenue: 98000 },
    paths: [
      coverageRow("soulmate-sketch", 9000, 60000, { state: "granted", funnel_id: "f-1", path_id: "1", path_status: "active", synthetic_users: 240 }),
      coverageRow("past-life", 4000, 25000, { state: "granted", funnel_id: "f-2", path_id: "3", path_status: "active" }),
      coverageRow("past-life-v2", 1000, 8000, { state: "granted", funnel_id: "f-2", path_id: "6", path_status: "active" }),
      coverageRow("past-life-old", 600, 5000, { state: "granted", funnel_id: "f-2", path_id: "4", path_status: "retired", users_since_retired: 12 }),
      coverageRow("soulmate-1-tariff-month-veb", 150, 1200, { state: "proposed", path_status: "proposed", proposals: [{ path_id: "2", funnel_id: "f-1" }] }),
      coverageRow("new-quiz", 80, 700, {}),
      coverageRow("unknown", 7, 100, { state: "unscopable" }),
    ],
    reuse_alerts: [{ path: "past-life-old", funnel_id: "f-2", path_id: "4", retired_at: "2026-09-01T00:00:00Z", users_since_retired: 12 }],
    funnels: [
      { funnel_id: "f-1", users: 9000, net_revenue: 60000, granted_paths: 1 },
      { funnel_id: "f-2", users: 5600, net_revenue: 38000, granted_paths: 3 },
      { funnel_id: "f-3", users: 0, net_revenue: 0, granted_paths: 1 },
    ],
    registry_without_data: ["f-3"],
  };
}

let coverageAnswer: () => { status?: number; body: unknown };

function mutationAnswer(body: Record<string, unknown>, status: AdminFunnelPath["status"]) {
  const pathId = String(body.path_id ?? "99");
  const funnelId = String(body.funnel_id ?? "f-1");
  return { body: { ok: true, changed: true, path: { ...funnelPath(pathId, funnelId, String(body.path ?? "x"), status) }, affected_members: 2 } };
}

function defaultHandler(action: string, body: Record<string, unknown>): { status?: number; body: unknown } {
  switch (action) {
    case "paths.coverage":
      return coverageAnswer();
    case "funnels.list":
      return { body: { ok: true, funnels: REGISTRY } };
    case "members.list":
      return { body: { ok: true, members: MEMBERS } };
    case "paths.attach":
      return mutationAnswer(body, "active");
    case "paths.set_status":
      return mutationAnswer(body, body.status as AdminFunnelPath["status"]);
    default:
      return { status: 400, body: { ok: false, error_code: "unknown_action", error: "Unsupported action." } };
  }
}

function accessWith(permissions: string[], options: { isOwner?: boolean } = {}): AccessContextValue {
  const row: MyAccess = {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "m-admin",
    user_id: "u-admin",
    email: "admin@example.com",
    display_name: null,
    is_data_owner: false,
    raw_access: false,
    role: { id: "r-admin", key: "custom", name: "Role", is_owner: options.isOwner === true, permissions },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p-1",
  };
  return buildAccessValue({ status: "ok", access: row, userId: "u-admin" });
}

const OWNER = () => accessWith([], { isOwner: true });
/** Members admin without funnels.manage: reads coverage, writes nothing. */
const VIEWER_ADMIN = () => accessWith(["admin.users.view"]);
/** funnels.manage without admin.users.view: funnels come from the browser registry. */
const FUNNEL_MANAGER = () => accessWith(["funnels.view", "funnels.manage"]);

function renderPage(access: AccessContextValue = OWNER()): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const ui: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AccessContext.Provider value={access}>
          <MemoryRouter initialEntries={["/admin/funnels"]}>
            <AdminFunnelCoveragePage />
          </MemoryRouter>
        </AccessContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>
  );
  render(ui);
}

function callsFor(action: string) {
  return backend.calls.filter((call) => call.body.action === action);
}

beforeEach(() => {
  backend.calls = [];
  backend.registryReads = 0;
  backend.handler = defaultHandler;
  coverageAnswer = () => ({ body: coverageFixture() });
});

afterEach(() => {
  cleanup();
});

// ---- client --------------------------------------------------------------------------------

describe("accessAdminClient path actions", () => {
  it("fetchPathCoverage parses the contract and fails closed on unknown states", async () => {
    coverageAnswer = () => ({
      body: { ...coverageFixture(), paths: [{ path: "weird", users: "5", net_revenue: "1.5", state: "mystery", proposals: [{ path_id: 3 }] }] },
    });
    const coverage = await fetchPathCoverage();
    expect(callsFor("paths.coverage")[0].body).toEqual({ action: "paths.coverage" });
    expect(coverage.totals).toEqual({ users: 14837, synthetic_users: 240, registered_users: 14600, registered_pct: 98.4, net_revenue: 100000, registered_net_revenue: 98000 });
    expect(coverage.paths).toEqual([
      expect.objectContaining({ path: "weird", users: 5, net_revenue: 1.5, state: "unscopable", proposals: [], users_since_retired: null }),
    ]);
    expect(coverage.snapshot).toEqual({ status: "current", warehouse_version: "wh-20261006", generated_at: "2026-10-06T00:00:00Z" });
  });

  it("attach and set_status post the contract bodies and parse PathMutationResult", async () => {
    const attached = await attachFunnelPath({ funnel_id: "f-3", path: "new-quiz" });
    expect(callsFor("paths.attach")[0].body).toEqual({ action: "paths.attach", funnel_id: "f-3", path: "new-quiz" });
    expect(attached).toMatchObject({ ok: true, changed: true, affected_members: 2, path: { id: "99", funnel_id: "f-3", path: "new-quiz", status: "active" } });

    await setFunnelPathStatus({ path_id: "4", status: "revoked", note: "reused by another funnel" });
    expect(callsFor("paths.set_status")[0].body).toEqual({ action: "paths.set_status", path_id: "4", status: "revoked", note: "reused by another funnel" });
  });

  it("a 409 conflict (no validated snapshot) is a typed error", async () => {
    coverageAnswer = () => ({ status: 409, body: { ok: false, error_code: "conflict", error: "The cohort snapshot is not ready." } });
    await expect(fetchPathCoverage()).rejects.toMatchObject({ status: 409, errorCode: "conflict", message: "The cohort snapshot is not ready." });
  });
});

// ---- view model ------------------------------------------------------------------------------

describe("coverage row actions", () => {
  const coverage = coverageFixture() as unknown as FunnelCoverage;
  const rowOf = (path: string) => coverage.paths.find((row) => row.path === path) as FunnelCoverage["paths"][number];

  it("offers each registry transition only where the server would accept it", () => {
    // The funnel's own path (canonical funnel_path) is never retired or revoked here.
    expect(coveragePathActions(rowOf("soulmate-sketch"), REGISTRY)).toMatchObject({ retire: false, reactivate: false, revoke: false, attach: false });
    expect(coveragePathActions(rowOf("soulmate-sketch"), REGISTRY).lockedReason).toMatch(/funnel's own path/);
    expect(coveragePathActions(rowOf("past-life-v2"), REGISTRY)).toMatchObject({ retire: true, reactivate: false, revoke: true, lockedReason: null });
    expect(coveragePathActions(rowOf("past-life-old"), REGISTRY)).toMatchObject({ retire: false, reactivate: true, revoke: true });
    expect(coveragePathActions(rowOf("soulmate-1-tariff-month-veb"), REGISTRY)).toMatchObject({
      attach: true,
      proposals: [{ path_id: "2", funnel_id: "f-1", canConfirm: true }],
    });
    expect(coveragePathActions(rowOf("new-quiz"), REGISTRY)).toMatchObject({ attach: true, proposals: [], retire: false, revoke: false });
    expect(coveragePathActions(rowOf("unknown"), REGISTRY)).toMatchObject({ attach: false, proposals: [], retire: false, revoke: false });
    // A proposal on a path another funnel already holds can only be rejected.
    const contested = { ...rowOf("past-life-v2"), proposals: [{ path_id: "7", funnel_id: "f-3" }] };
    expect(coveragePathActions(contested, REGISTRY).proposals).toEqual([{ path_id: "7", funnel_id: "f-3", canConfirm: false }]);
  });

  it("states the impact of a grant change", () => {
    expect(pathImpactText("add", { users: 1234, net_revenue: 5678.4 }, "Palm Reading", 1)).toBe(
      "+1,234 users / +$5,678 into Palm Reading; 1 member holding it will see this data",
    );
    expect(pathImpactText("remove", { users: 10, net_revenue: -80 }, "Past Life", null)).toBe(
      "−10 users / +$80 from Past Life; members holding it will lose this data",
    );
  });
});

// ---- page ----------------------------------------------------------------------------------

describe("AdminFunnelCoveragePage", () => {
  it("shows the summary, the alerts and every snapshot path with its registry state", async () => {
    renderPage();
    const summary = await screen.findByTestId("coverage-summary");
    expect(within(summary).getByTestId("coverage-users")).toHaveTextContent("14,837");
    expect(within(summary).getByTestId("coverage-registered")).toHaveTextContent("98.4%");
    expect(within(summary).getByTestId("coverage-synthetic")).toHaveTextContent("240");
    expect(within(summary).getByTestId("coverage-net")).toHaveTextContent("98%");
    expect(within(summary).getByTestId("coverage-net")).toHaveTextContent("$98,000 of $100,000");
    expect(within(summary).getByTestId("coverage-snapshot")).toHaveTextContent("Current");

    // Funnel names arrive with funnels.list (loaded next to the coverage).
    await waitFor(() =>
      expect(screen.getByTestId("reuse-alert-4")).toHaveTextContent(/past-life-old was retired from Past Life on .*, but 12 users were anchored to it since/),
    );
    expect(screen.getByTestId("funnels-without-data")).toHaveTextContent("1 funnel has no users in the snapshot");
    expect(screen.getByTestId("funnels-without-data")).toHaveTextContent("Palm Reading");

    const soulmate = screen.getByTestId("coverage-row-soulmate-sketch");
    expect(within(soulmate).getByText("Granted")).toBeInTheDocument();
    expect(within(soulmate).getByText("Soulmate Sketch")).toBeInTheDocument();
    expect(within(soulmate).getByText("+240 synthetic")).toBeInTheDocument();
    expect(within(soulmate).getByText("60.6%")).toBeInTheDocument();
    expect(within(screen.getByTestId("coverage-row-past-life-old")).getByText("retired")).toBeInTheDocument();
    expect(within(screen.getByTestId("coverage-row-soulmate-1-tariff-month-veb")).getByText("Proposed: Soulmate Sketch")).toBeInTheDocument();
    expect(within(screen.getByTestId("coverage-row-new-quiz")).getByText("Unregistered")).toBeInTheDocument();
    expect(within(screen.getByTestId("coverage-row-unknown")).getByText("Unscopable")).toBeInTheDocument();
    expect(screen.getByText("7 of 7 paths")).toBeInTheDocument();
    // Only the coverage read and the two name lookups; nothing is written.
    expect(callsFor("paths.attach")).toHaveLength(0);
    expect(callsFor("paths.set_status")).toHaveLength(0);
  });

  it("attaches an unregistered path to the picked funnel after stating the impact", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Attach new-quiz" }));
    const dialog = await screen.findByTestId("attach-path-dialog");
    const submit = within(dialog).getByRole("button", { name: "Attach path" });
    expect(submit).toBeDisabled();
    fireEvent.click(within(dialog).getByTestId("attach-funnel-f-3"));
    // m-1 (active, f-3) holds it; m-3 is disabled; m-4 has all funnels anyway.
    await waitFor(() => expect(within(dialog).getByTestId("attach-impact")).toHaveTextContent("+80 users / +$700 into Palm Reading; 1 member holding it will see this data."));
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: " quiz relaunch " } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(callsFor("paths.attach")).toHaveLength(1));
    expect(callsFor("paths.attach")[0].body).toEqual({ action: "paths.attach", funnel_id: "f-3", path: "new-quiz", note: "quiz relaunch" });
    await waitFor(() => expect(screen.queryByTestId("attach-path-dialog")).not.toBeInTheDocument());
    // A path change re-reads the coverage.
    await waitFor(() => expect(callsFor("paths.coverage")).toHaveLength(2));
  });

  it("the attach dialog pre-selects the funnel a proposal names", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Attach soulmate-1-tariff-month-veb" }));
    const dialog = await screen.findByTestId("attach-path-dialog");
    expect(within(dialog).getByTestId("attach-funnel-f-1")).toHaveAttribute("data-checked", "true");
    await waitFor(() =>
      expect(within(dialog).getByTestId("attach-impact")).toHaveTextContent("+150 users / +$1,200 into Soulmate Sketch; 2 members holding it will see this data."),
    );
  });

  it("confirms and rejects seeded proposals through paths.set_status", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm soulmate-1-tariff-month-veb for Soulmate Sketch" }));
    let confirm = await screen.findByTestId("path-status-confirm");
    expect(within(confirm).getByText("Confirm soulmate-1-tariff-month-veb for Soulmate Sketch?")).toBeInTheDocument();
    expect(await within(confirm).findByText("+150 users / +$1,200 into Soulmate Sketch; 2 members holding it will see this data.")).toBeInTheDocument();
    expect(callsFor("paths.set_status")).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(callsFor("paths.set_status")).toHaveLength(1));
    expect(callsFor("paths.set_status")[0].body).toEqual({ action: "paths.set_status", path_id: "2", status: "active" });
    await waitFor(() => expect(screen.queryByTestId("path-status-confirm")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Reject soulmate-1-tariff-month-veb for Soulmate Sketch" }));
    confirm = await screen.findByTestId("path-status-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(callsFor("paths.set_status")).toHaveLength(2));
    expect(callsFor("paths.set_status")[1].body).toEqual({ action: "paths.set_status", path_id: "2", status: "revoked" });
  });

  it("retires, reactivates and revokes granted paths, never the funnel's own path", async () => {
    renderPage();
    const own = await screen.findByTestId("coverage-row-past-life");
    expect(within(own).queryByRole("button", { name: /Retire|Revoke/ })).not.toBeInTheDocument();
    expect(within(own).getByText("Funnel's own path")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retire past-life-v2" }));
    let confirm = await screen.findByTestId("path-status-confirm");
    expect(within(confirm).getByText("Retire past-life-v2?")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Retire" }));
    await waitFor(() => expect(callsFor("paths.set_status")).toHaveLength(1));
    expect(callsFor("paths.set_status")[0].body).toEqual({ action: "paths.set_status", path_id: "6", status: "retired" });
    await waitFor(() => expect(screen.queryByTestId("path-status-confirm")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Revoke past-life-old" }));
    confirm = await screen.findByTestId("path-status-confirm");
    expect(within(confirm).getByText("Revoke past-life-old from Past Life?")).toBeInTheDocument();
    expect(await within(confirm).findByText("−600 users / −$5,000 from Past Life; 0 members holding it will lose this data.")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(callsFor("paths.set_status")).toHaveLength(2));
    expect(callsFor("paths.set_status")[1].body).toEqual({ action: "paths.set_status", path_id: "4", status: "revoked" });
    await waitFor(() => expect(screen.queryByTestId("path-status-confirm")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Reactivate past-life-old" }));
    confirm = await screen.findByTestId("path-status-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: "Reactivate" }));
    await waitFor(() => expect(callsFor("paths.set_status")).toHaveLength(3));
    expect(callsFor("paths.set_status")[2].body).toEqual({ action: "paths.set_status", path_id: "4", status: "active" });
  });

  it("a refused write keeps the dialog open and posts nothing else", async () => {
    backend.handler = (action, body) =>
      action === "paths.set_status"
        ? { status: 409, body: { ok: false, error_code: "conflict", error: "path is already part of another funnel; revoke it there first" } }
        : defaultHandler(action, body);
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Confirm soulmate-1-tariff-month-veb for Soulmate Sketch" }));
    const confirm = await screen.findByTestId("path-status-confirm");
    fireEvent.click(within(confirm).getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(callsFor("paths.set_status")).toHaveLength(1));
    expect(screen.getByTestId("path-status-confirm")).toBeInTheDocument();
  });

  it("hides every write control without funnels.manage", async () => {
    renderPage(VIEWER_ADMIN());
    const row = await screen.findByTestId("coverage-row-new-quiz");
    expect(within(row).getAllByRole("cell")).toHaveLength(7);
    expect(screen.queryByRole("columnheader", { name: "Actions" })).not.toBeInTheDocument();
    for (const name of [/^Attach/, /^Confirm/, /^Reject/, /^Retire/, /^Revoke/, /^Reactivate/]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.getByTestId("coverage-summary")).toBeInTheDocument();
  });

  it("a funnels.manage holder without admin.users.view reads funnel names from the registry, not funnels.list", async () => {
    renderPage(FUNNEL_MANAGER());
    const row = await screen.findByTestId("coverage-row-soulmate-sketch");
    expect(await within(row).findByText("Soulmate Sketch")).toBeInTheDocument();
    expect(backend.registryReads).toBe(1);
    expect(callsFor("funnels.list")).toHaveLength(0);
    expect(callsFor("members.list")).toHaveLength(0);
    // Without the member list the impact leaves the holder count out.
    fireEvent.click(screen.getByRole("button", { name: "Attach new-quiz" }));
    const dialog = await screen.findByTestId("attach-path-dialog");
    fireEvent.click(within(dialog).getByTestId("attach-funnel-f-3"));
    expect(within(dialog).getByTestId("attach-impact")).toHaveTextContent("+80 users / +$700 into Palm Reading; members holding it will see this data.");
  });

  it("explains a 409 (no validated snapshot yet) inline and retries on request", async () => {
    coverageAnswer = () => ({
      status: 409,
      body: { ok: false, error_code: "conflict", error: "The cohort snapshot is not ready: coverage is measured on the active validated snapshot. Retry after the next rebuild." },
    });
    renderPage();
    const empty = await screen.findByTestId("coverage-empty");
    await waitFor(() => expect(empty).toHaveTextContent("The cohort snapshot is not ready"));
    expect(empty).not.toHaveTextContent("Could not load funnel coverage");
    coverageAnswer = () => ({ body: coverageFixture() });
    fireEvent.click(within(empty).getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("coverage-summary")).toBeInTheDocument();
  });
});
