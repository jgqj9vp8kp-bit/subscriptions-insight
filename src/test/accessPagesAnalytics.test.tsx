// Access UX on the analytics pages (plan §14; Milestone A). Every gate here is
// UX only — the Edge gate / RLS are authoritative — so these tests prove two
// things per page: the owner / legacy render is unchanged (raw paths, admin
// controls, the same requests), and a member without raw access or without a
// permission neither sees the control nor fires the request behind it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: MockResizeObserver });

// Shared, hoisted state the module mocks read at call time.
const h = vi.hoisted(() => ({
  cohortsMode: "clickhouse" as "clickhouse" | "legacy",
  cohortsQuery: null as unknown,
  funnels: [] as unknown[],
  savedProjects: [] as unknown[],
  reportItems: [] as unknown[],
  report: null as unknown,
  tasks: [] as unknown[],
  fbReport: null as unknown,
  revenueError: null as string | null,
}));

const fns = vi.hoisted(() => ({
  autoLoadWarehouseIntoStore: vi.fn(async () => ({ status: "ok", count: 0 })),
  autoLoadWarehouseIntoStoreWithOptions: vi.fn(async () => ({ status: "ok" })),
  ensureCohortSnapshotRebuild: vi.fn(() => "started"),
  useCohortsListQuery: vi.fn(),
  useAiCohortSignals: vi.fn(),
  useAiCampaignSignals: vi.fn(),
  useFbReportQuery: vi.fn(),
  useRevenueBundle: vi.fn(),
  listCapsuledFacebookRows: vi.fn(async () => []),
  getFunnelFoxSubscriptionsSyncState: vi.fn(async () => null),
  loadCohortsFromClickHouse: vi.fn(async () => ({ cohorts: [], source: "clickhouse", durationMs: 1 })),
  loadCohortsUiSettingsCloud: vi.fn(async () => null),
}));

vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
// The app shell (sidebar, AI drawer, stores) is covered by accessShell.test.tsx.
vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "app-layout" }, React.createElement("h1", null, title), actions, children),
  };
});
vi.mock("@/components/RevenueIntelligenceSection", async () => {
  const React = await import("react");
  return { RevenueIntelligenceSection: () => React.createElement("div", { "data-testid": "revenue-intelligence" }) };
});
vi.mock("@/components/FbWarehouseAnalytics", async () => {
  const React = await import("react");
  return { FbWarehouseAnalytics: () => React.createElement("div", { "data-testid": "fb-warehouse-analytics" }) };
});
vi.mock("@/components/FbWarehouseHealth", async () => {
  const React = await import("react");
  return { FbWarehouseHealth: () => React.createElement("div", { "data-testid": "fb-warehouse-health" }) };
});
vi.mock("@/hooks/useAnalyticsCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWarehouseVersion: () => ({ version: "whv_test", ready: true }),
}));
vi.mock("@/hooks/useCohortsCache", () => ({
  useCohortsListQuery: fns.useCohortsListQuery,
  useWarehouseVersion: () => ({ version: "whv_test", ready: true }),
  prefetchCohortsNav: vi.fn(),
}));
vi.mock("@/hooks/useFbWarehouse", () => ({
  useFbWarehouseStatus: () => ({ status: { state: {} }, version: "fbv_test", ready: true, refetch: () => {} }),
  useFbReportQuery: fns.useFbReportQuery,
  useInvalidateFbWarehouse: () => async () => {},
}));
vi.mock("@/hooks/useAiCohortSignals", () => ({
  aiCohortKey: (row: { cohort_date: string; funnel: string; campaign_path: string }) => `${row.cohort_date}|${row.funnel}|${row.campaign_path}`,
  useAiCohortSignals: fns.useAiCohortSignals,
  useAiCampaignSignals: fns.useAiCampaignSignals,
}));
vi.mock("@/hooks/useRevenueIntelligence", () => ({
  useRevenueBundle: fns.useRevenueBundle,
  useRevenueDayBreakdown: () => ({ loading: false, error: null, breakdown: null }),
}));
vi.mock("@/services/analyticsAdapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  autoLoadWarehouseIntoStore: fns.autoLoadWarehouseIntoStore,
  autoLoadWarehouseIntoStoreWithOptions: fns.autoLoadWarehouseIntoStoreWithOptions,
}));
vi.mock("@/services/cohortSnapshotHealth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureCohortSnapshotRebuild: fns.ensureCohortSnapshotRebuild,
}));
vi.mock("@/services/cohortsDataSource", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cohortsDataSourceMode: () => h.cohortsMode,
  loadCohortsFromClickHouse: fns.loadCohortsFromClickHouse,
}));
vi.mock("@/services/clickhouse", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isClickHouseCircuitOpen: () => false,
}));
vi.mock("@/services/funnels", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listFunnels: vi.fn(async () => h.funnels),
  listTags: vi.fn(async () => []),
  listFunnelFoxFunnels: vi.fn(async () => []),
  setFunnelActive: vi.fn(async () => {}),
  recomputeFunnelActiveStatus: vi.fn(async () => ({ active_total: 0, activated: 0, deactivated: 0, window_days: 30 })),
}));
vi.mock("@/services/funnelfoxSubscriptionsSync", () => ({
  getFunnelFoxSubscriptionsSyncState: fns.getFunnelFoxSubscriptionsSyncState,
  subscriptionSyncCompletenessWarning: () => null,
}));
vi.mock("@/services/cohortsUiSettings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCohortsUiSettingsCloud: fns.loadCohortsUiSettingsCloud,
  saveCohortsUiSettingsCloud: vi.fn(async () => null),
}));
vi.mock("@/services/capsuledFacebook", () => ({
  listCapsuledFacebookRows: fns.listCapsuledFacebookRows,
  getCapsuledFacebookStatus: vi.fn(async () => null),
  syncCapsuledFacebookStats: vi.fn(),
}));
vi.mock("@/services/fbAnalyticsSummaryClient", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fbAnalyticsSource: () => "client",
}));
vi.mock("@/services/dashboardSummaryClient", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  dashboardSource: () => "client",
}));
vi.mock("@/services/forecastScenarios", () => ({
  listForecastScenarios: vi.fn(async () => []),
  loadForecastScenario: vi.fn(),
  saveForecastScenario: vi.fn(),
  deleteForecastScenario: vi.fn(),
}));
vi.mock("@/services/projectForecasts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listProjectForecasts: vi.fn(async () => h.savedProjects),
  loadProjectForecast: vi.fn(),
  saveProjectForecast: vi.fn(),
  deleteProjectForecast: vi.fn(),
  duplicateProjectForecast: vi.fn(),
}));
vi.mock("@/services/projectForecastSeeding", () => ({
  // Never settles: the saved-project controls render without a loaded window.
  loadProjectSeedData: vi.fn(() => new Promise(() => {})),
}));
vi.mock("@/services/reports", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listReports: vi.fn(async () => h.reportItems),
  loadReport: vi.fn(async () => h.report),
}));
vi.mock("@/services/reportWorkItems", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listReportTasks: vi.fn(async () => h.tasks),
  listReportNotes: vi.fn(async () => []),
  saveReportTask: vi.fn(async () => {}),
  deleteReportTask: vi.fn(async () => {}),
}));

import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { registeredPurgeHandlers, runPurge } from "@/services/sessionPurge";
import { newReport } from "@/services/reports";
import { emptyReportBindings, type ReportBlock, type ReportTask } from "@/services/reportContract";
import Dashboard from "@/pages/Dashboard";
import CohortsPage from "@/pages/Cohorts";
import FBAnalyticsPage from "@/pages/FBAnalytics";
import FunnelsPage from "@/pages/Funnels";
import ForecastingPage from "@/pages/Forecasting";
import ReportsPage from "@/pages/Reports";
import { ScenarioActions } from "@/components/forecasting/PlanMode";
import { ProjectMode } from "@/components/forecasting/ProjectMode";
import { BlockEditor } from "@/components/reports/BlockEditor";
import { PlanFactPanel } from "@/components/reports/PlanFactPanel";

// ---- access fixtures ---------------------------------------------------------

const USER: AuthUser = { id: "user-a", email: "a@example.com", provider: "supabase" };

const AUTH: AuthContextValue = {
  configured: true,
  supabaseConfigured: true,
  localAuthEnabled: false,
  mode: "supabase",
  loading: false,
  session: null,
  user: USER,
  signIn: async () => {},
  signOut: async () => {},
};

function okRow(input: { permissions?: string[]; isOwner?: boolean; raw?: boolean; partition?: string }): MyAccess {
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
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: input.partition ?? "p-member",
  };
}

const OWNER = () => buildAccessValue({ status: "ok", access: okRow({ isOwner: true, raw: true, partition: "p-owner" }), userId: USER.id });
const LEGACY = () => buildAccessValue({ status: "legacy", access: null, userId: USER.id });
/** An employee (no raw access) with exactly these role permissions. */
const member = (permissions: string[]) => buildAccessValue({ status: "ok", access: okRow({ permissions }), userId: USER.id });
/** The data owner on a custom (non-Owner) role: raw paths, limited controls. */
const rawMember = (permissions: string[]) =>
  buildAccessValue({ status: "ok", access: okRow({ permissions, raw: true, partition: "p-raw" }), userId: USER.id });

function renderWith(ui: ReactNode, access: AccessContextValue) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={AUTH}>
          <AccessContext.Provider value={access}>{ui}</AccessContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function cohortsQuery(input: { chResult?: unknown; error?: string | null; applicable?: boolean } = {}) {
  return {
    chResult: input.chResult ?? null,
    chStatus: {
      loading: false,
      error: input.error ?? null,
      durationMs: null,
      subStatus: null,
      applicable: input.applicable ?? true,
      unsupportedFilters: input.applicable === false ? ["country"] : [],
      fallbackReason: input.applicable === false ? "Active filters not reproduced server-side: country." : null,
      filtersApplied: null,
    },
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 0,
    dataUpdatedAt: 0,
    isStale: false,
    isFilterScopeCurrent: false,
  };
}

const STALE_RESULT = {
  cohorts: [],
  source: "clickhouse",
  durationMs: 5,
  diagnostics: {
    snapshot_stale: true,
    active_snapshot_version: "snap-1",
    source_transactions: 10,
    current_warehouse_transactions: 12,
    cohort_users: 4,
    report_complete: false,
    source_warehouse_version: "whv_a",
    current_warehouse_version: "whv_b",
    filters_applied: {},
  },
};

const lastCohortsParams = () => fns.useCohortsListQuery.mock.calls.at(-1)?.[0] as { request: Record<string, unknown>; userScopeHash: string };

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  h.cohortsMode = "clickhouse";
  h.cohortsQuery = cohortsQuery();
  h.funnels = [];
  h.savedProjects = [];
  h.reportItems = [];
  h.report = null;
  h.tasks = [];
  h.fbReport = null;
  h.revenueError = null;
  fns.useCohortsListQuery.mockImplementation(() => h.cohortsQuery);
  fns.useAiCohortSignals.mockImplementation(() => ({ output: null, byCohort: new Map(), byPath: new Map(), contextHash: null, paymentLoading: false }));
  fns.useAiCampaignSignals.mockImplementation(() => ({ output: null, byCampaign: new Map(), contextHash: null, paymentLoading: false }));
  fns.useFbReportQuery.mockImplementation(() => ({
    report: h.fbReport,
    loading: false,
    error: null,
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 0,
    dataUpdatedAt: 0,
  }));
  fns.useRevenueBundle.mockImplementation(() => ({ bundle: null, error: h.revenueError, isInitialLoading: false, isRefreshing: false }));
});

afterEach(() => {
  cleanup();
});

// ---- Dashboard ---------------------------------------------------------------

describe("Dashboard", () => {
  it("owner and legacy keep the client-compute body and its warehouse auto-load", async () => {
    for (const access of [OWNER(), LEGACY()]) {
      renderWith(<Dashboard />, access);
      expect(screen.getByText("Global Filters")).toBeInTheDocument();
      expect(screen.getByText("Project Metrics")).toBeInTheDocument();
      expect(screen.getByTestId("revenue-intelligence")).toBeInTheDocument();
      expect(screen.queryByTestId("dashboard-server-only-note")).toBeNull();
      await waitFor(() => expect(fns.autoLoadWarehouseIntoStoreWithOptions).toHaveBeenCalledTimes(1));
      cleanup();
      fns.autoLoadWarehouseIntoStoreWithOptions.mockClear();
    }
  });

  it("an employee gets Revenue Intelligence and a note — no client compute, no warehouse download", async () => {
    renderWith(<Dashboard />, member(["dashboard.view"]));
    expect(screen.getByTestId("revenue-intelligence")).toBeInTheDocument();
    expect(screen.getByTestId("dashboard-server-only-note")).toBeInTheDocument();
    expect(screen.queryByText("Global Filters")).toBeNull();
    expect(screen.queryByText("Project Metrics")).toBeNull();
    await act(async () => {});
    expect(fns.autoLoadWarehouseIntoStoreWithOptions).not.toHaveBeenCalled();
  });
});

describe("RevenueIntelligenceSection", () => {
  async function actualSection() {
    return (await vi.importActual<typeof import("@/components/RevenueIntelligenceSection")>("@/components/RevenueIntelligenceSection"))
      .RevenueIntelligenceSection;
  }

  it("keys its bundle by the access partition", async () => {
    const Section = await actualSection();
    renderWith(<Section />, member(["dashboard.view"]));
    expect(fns.useRevenueBundle).toHaveBeenCalled();
    expect(fns.useRevenueBundle.mock.calls.at(-1)?.[0]).toMatchObject({ userScopeHash: "p-member" });
  });

  it("links to Cohorts only where the member may open it", async () => {
    const Section = await actualSection();
    h.revenueError = "cohort_snapshot_not_ready";
    renderWith(<Section />, OWNER());
    expect(screen.getByRole("link", { name: /open the cohorts page/i })).toBeInTheDocument();
    cleanup();
    renderWith(<Section />, member(["dashboard.view"]));
    expect(screen.queryByRole("link", { name: /open the cohorts page/i })).toBeNull();
    expect(screen.getByText(/ask a workspace admin to rebuild it/i)).toBeInTheDocument();
    cleanup();
    renderWith(<Section />, member(["dashboard.view", "cohorts.view"]));
    expect(screen.getByRole("link", { name: /open the cohorts page/i })).toBeInTheDocument();
  });
});

// ---- Cohorts -----------------------------------------------------------------

describe("Cohorts", () => {
  it("owner falls back to the legacy engine on a ClickHouse error (unchanged)", async () => {
    h.cohortsQuery = cohortsQuery({ error: "boom" });
    renderWith(<CohortsPage />, OWNER());
    await waitFor(() => expect(fns.autoLoadWarehouseIntoStore).toHaveBeenCalledTimes(1));
    expect(fns.getFunnelFoxSubscriptionsSyncState).toHaveBeenCalledTimes(1);
  });

  it("an employee sees the server error instead of a silent legacy switch", async () => {
    h.cohortsQuery = cohortsQuery({ error: "boom" });
    renderWith(<CohortsPage />, member(["cohorts.view"]));
    expect(await screen.findByText(/cohorts could not be loaded from the server: boom/i)).toBeInTheDocument();
    await act(async () => {});
    expect(fns.autoLoadWarehouseIntoStore).not.toHaveBeenCalled();
    // The owner's FunnelFox sync state is a raw PostgREST read.
    expect(fns.getFunnelFoxSubscriptionsSyncState).not.toHaveBeenCalled();
  });

  it("an employee never sees rows the server could not filter, nor the legacy engine", async () => {
    h.cohortsQuery = cohortsQuery({ chResult: STALE_RESULT, applicable: false });
    renderWith(<CohortsPage />, member(["cohorts.view", "admin.warehouse.manage"]));
    expect(await screen.findByText(/the server cannot apply the active filters \(country\)/i)).toBeInTheDocument();
    await act(async () => {});
    expect(fns.autoLoadWarehouseIntoStore).not.toHaveBeenCalled();
    // Not driving ⇒ no snapshot-health side effects either.
    expect(fns.ensureCohortSnapshotRebuild).not.toHaveBeenCalled();
  });

  it("an employee gets a clear state when the deployment runs the legacy engine", async () => {
    h.cohortsMode = "legacy";
    renderWith(<CohortsPage />, member(["cohorts.view"]));
    expect(await screen.findByText(/computed in the browser in this deployment/i)).toBeInTheDocument();
    await act(async () => {});
    expect(fns.autoLoadWarehouseIntoStore).not.toHaveBeenCalled();
  });

  it("the stale-snapshot auto-rebuild needs admin.warehouse.manage", async () => {
    h.cohortsQuery = cohortsQuery({ chResult: STALE_RESULT });
    renderWith(<CohortsPage />, OWNER());
    await waitFor(() => expect(fns.ensureCohortSnapshotRebuild).toHaveBeenCalled());
    cleanup();
    fns.ensureCohortSnapshotRebuild.mockClear();

    renderWith(<CohortsPage />, member(["cohorts.view", "admin.warehouse.manage"]));
    await waitFor(() => expect(fns.ensureCohortSnapshotRebuild).toHaveBeenCalled());
    cleanup();
    fns.ensureCohortSnapshotRebuild.mockClear();

    renderWith(<CohortsPage />, member(["cohorts.view"]));
    await act(async () => {});
    expect(fns.ensureCohortSnapshotRebuild).not.toHaveBeenCalled();
  });

  it("CSV / XLSX export buttons need cohorts.export", () => {
    renderWith(<CohortsPage />, OWNER());
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export XLSX" })).toBeInTheDocument();
    cleanup();
    renderWith(<CohortsPage />, member(["cohorts.view"]));
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export XLSX" })).toBeNull();
    cleanup();
    renderWith(<CohortsPage />, member(["cohorts.view", "cohorts.export"]));
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeInTheDocument();
  });

  it("asks for the FB allocation diagnostics only with raw access or admin.diagnostics.view", () => {
    renderWith(<CohortsPage />, OWNER());
    expect(lastCohortsParams().request.fb_allocation_diagnostics).toMatchObject({ page: 1, page_size: 100 });
    cleanup();
    renderWith(<CohortsPage />, LEGACY());
    expect(lastCohortsParams().request.fb_allocation_diagnostics).toBeDefined();
    cleanup();
    renderWith(<CohortsPage />, member(["cohorts.view"]));
    expect(lastCohortsParams().request).not.toHaveProperty("fb_allocation_diagnostics");
    cleanup();
    renderWith(<CohortsPage />, member(["cohorts.view", "admin.diagnostics.view"]));
    expect(lastCohortsParams().request.fb_allocation_diagnostics).toBeDefined();
  });

  it("cloud copies of the Cohorts view (data_snapshots) are the data owner's only", async () => {
    renderWith(<CohortsPage />, OWNER());
    await waitFor(() => expect(fns.loadCohortsUiSettingsCloud).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("button", { name: /save settings to cloud/i })).toBeInTheDocument();
    cleanup();
    fns.loadCohortsUiSettingsCloud.mockClear();

    renderWith(<CohortsPage />, member(["cohorts.view"]));
    fireEvent.click(screen.getByRole("button", { name: "Columns" }));
    expect(await screen.findByRole("button", { name: /reset to default/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save settings to cloud/i })).toBeNull();
    expect(fns.loadCohortsUiSettingsCloud).not.toHaveBeenCalled();
    // Renders the full Cohorts page twice (~4.5 s alone): the default 5 s
    // timeout flakes under the parallel full-suite run.
  }, 20_000);

  it("keys the cohorts cache by the access partition (the sidebar prefetch key)", () => {
    renderWith(<CohortsPage />, member(["cohorts.view"]));
    expect(lastCohortsParams().userScopeHash).toBe("p-member");
    cleanup();
    renderWith(<CohortsPage />, LEGACY());
    expect(lastCohortsParams().userScopeHash).toBe("legacy:user-a");
  });
});

// ---- FB Analytics ------------------------------------------------------------

describe("FB Analytics", () => {
  it("owner keeps the Blended / Diagnostics tabs, the Capsuled load, health and sync", async () => {
    renderWith(<FBAnalyticsPage />, OWNER());
    expect(screen.getByRole("tab", { name: "Blended (legacy)" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Diagnostics" })).toBeInTheDocument();
    expect(screen.getByTestId("fb-warehouse-health")).toBeInTheDocument();
    expect(screen.getByTestId("fb-warehouse-analytics")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /sync facebook data/i }).length).toBeGreaterThan(0);
    await waitFor(() => expect(fns.listCapsuledFacebookRows).toHaveBeenCalledTimes(1));
  });

  it("sync buttons need admin.sync.run even with raw access", async () => {
    renderWith(<FBAnalyticsPage />, rawMember(["facebook_analytics.view"]));
    expect(screen.getByRole("tab", { name: "Blended (legacy)" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /sync facebook data/i })).toBeNull();
    expect(screen.queryByTestId("fb-warehouse-health")).toBeNull();
    await act(async () => {});
    // AI signals stay off without ai.use.
    expect(fns.useAiCampaignSignals.mock.calls.every(([params]) => params.enabled === false)).toBe(true);
  });

  it("an employee gets the warehouse tab only — no client compute, no Capsuled tables", async () => {
    renderWith(<FBAnalyticsPage />, member(["facebook_analytics.view"]));
    expect(screen.getByTestId("fb-warehouse-analytics")).toBeInTheDocument();
    expect(screen.getByTestId("fb-analytics-server-only-note")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Blended (legacy)" })).toBeNull();
    expect(screen.queryByText("FB Data Diagnostics")).toBeNull();
    expect(screen.queryByTestId("fb-warehouse-health")).toBeNull();
    await act(async () => {});
    expect(fns.listCapsuledFacebookRows).not.toHaveBeenCalled();
  });

  it("warehouse health (reconciliation history) needs admin.diagnostics.view", () => {
    renderWith(<FBAnalyticsPage />, member(["facebook_analytics.view", "admin.diagnostics.view"]));
    expect(screen.getByTestId("fb-warehouse-health")).toBeInTheDocument();
  });
});

describe("FbWarehouseAnalytics", () => {
  const CAMPAIGN_ROW = {
    key: "c1", campaign_id: "c1", campaign_name: "Campaign One", ad_account_id: "act-1", ad_account_name: "Account",
    buyer: "Ivan", adset_id: "", adset_name: "", ad_id: "", ad_name: "", spend: 10, fb_purchases: 1, cpp: 10,
    impressions: 100, clicks: 5, ctr: 5, cpc: 2, cpm: 100, outbound_clicks: 2, outbound_ctr: 2, days: 1, blended: null,
  };

  async function actualAnalytics() {
    return (await vi.importActual<typeof import("@/components/FbWarehouseAnalytics")>("@/components/FbWarehouseAnalytics"))
      .FbWarehouseAnalytics;
  }

  beforeEach(() => {
    h.fbReport = { rows: [CAMPAIGN_ROW], filter_options: { buyers: [], accounts: [] }, charts: [], summary: null, diagnostics: null, query_duration_ms: 3 };
  });

  it("sync buttons need admin.sync.run", async () => {
    const Analytics = await actualAnalytics();
    renderWith(<Analytics />, OWNER());
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /full sync/i })).toBeInTheDocument();
    cleanup();
    renderWith(<Analytics />, member(["facebook_analytics.view"]));
    expect(screen.queryByRole("button", { name: /sync now/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /full sync/i })).toBeNull();
    cleanup();
    renderWith(<Analytics />, member(["facebook_analytics.view", "admin.sync.run"]));
    expect(screen.getByRole("button", { name: /sync now/i })).toBeInTheDocument();
  });

  it("keys the report by the access partition and runs AI signals only with ai.use", async () => {
    const Analytics = await actualAnalytics();
    renderWith(<Analytics />, member(["facebook_analytics.view"]));
    expect(fns.useFbReportQuery.mock.calls.at(-1)?.[0]).toMatchObject({ userScopeHash: "p-member" });
    expect(fns.useAiCampaignSignals.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false, userScopeHash: "p-member" });
    cleanup();
    renderWith(<Analytics />, member(["facebook_analytics.view", "ai.use"]));
    expect(fns.useAiCampaignSignals.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true });
  });
});

// ---- Funnels -----------------------------------------------------------------

describe("Funnels", () => {
  beforeEach(() => {
    h.funnels = [{
      id: "f-1",
      funnel_path: "soulmate-1",
      display_name: "Soulmate",
      is_active: true,
      tags: [],
      created_at: "2026-09-01T00:00:00Z",
      updated_at: "2026-09-02T00:00:00Z",
    }];
  });

  it("a funnels.view member gets a read-only registry", async () => {
    renderWith(<FunnelsPage />, member(["funnels.view"]));
    const toggle = await screen.findByRole("switch", { name: /deactivate soulmate/i });
    expect(toggle).toBeDisabled();
    expect(screen.queryByRole("button", { name: /recompute active/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /import from funnelfox/i })).toBeNull();
    // The passport status is shown, but it does not open the editor.
    const row = toggle.closest("tr") as HTMLElement;
    expect(within(row).getByText(/заполнен/i)).toBeInTheDocument();
    expect(within(row).queryByRole("button")).toBeNull();
  });

  it("funnels.manage (and the owner) keep every registry control", async () => {
    for (const access of [OWNER(), member(["funnels.view", "funnels.manage"])]) {
      renderWith(<FunnelsPage />, access);
      const toggle = await screen.findByRole("switch", { name: /deactivate soulmate/i });
      expect(toggle).not.toBeDisabled();
      expect(screen.getByRole("button", { name: /recompute active/i })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /import from funnelfox/i })).toBeInTheDocument();
      const row = toggle.closest("tr") as HTMLElement;
      expect(within(row).getByRole("button", { name: /заполнен/i })).toBeInTheDocument();
      cleanup();
    }
  });
});

// ---- Forecasting ---------------------------------------------------------------

describe("Forecasting", () => {
  it("the Actuals tab (client compute) is the owner's only", async () => {
    renderWith(<ForecastingPage />, OWNER());
    expect(screen.getByRole("tab", { name: "Actuals" })).toBeInTheDocument();
    // Plan seeds from the in-memory cohorts when the warehouse returns none.
    expect(await screen.findByText("in-memory cohorts")).toBeInTheDocument();
    cleanup();

    renderWith(<ForecastingPage />, member(["forecasting.view"]));
    expect(screen.queryByRole("tab", { name: "Actuals" })).toBeNull();
    for (const name of ["Plan", "Compare", "Project"]) {
      expect(screen.getByRole("tab", { name })).toBeInTheDocument();
    }
    expect(await screen.findByText("no warehouse cohorts")).toBeInTheDocument();
    expect(fns.loadCohortsFromClickHouse).toHaveBeenCalled();
  });

  it("saving a Plan scenario needs forecasting.create", () => {
    const frozen = {} as Parameters<typeof ScenarioActions>[0]["frozen"];
    renderWith(<ScenarioActions frozen={frozen} funnel="soulmate-1" defaultLabel="plan" />, member(["forecasting.view"]));
    expect(screen.getByRole("button", { name: /add to comparison/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save scenario/i })).toBeNull();
    cleanup();
    renderWith(<ScenarioActions frozen={frozen} funnel="soulmate-1" defaultLabel="plan" />, member(["forecasting.view", "forecasting.create"]));
    expect(screen.getByRole("button", { name: /save scenario/i })).toBeInTheDocument();
    cleanup();
    renderWith(<ScenarioActions frozen={frozen} funnel="soulmate-1" defaultLabel="plan" />, OWNER());
    expect(screen.getByRole("button", { name: /save scenario/i })).toBeInTheDocument();
  });

  it("Project: duplicate needs forecasting.create, delete needs forecasting.delete", async () => {
    h.savedProjects = [{ id: "p-1", name: "July", source_window_from: "2026-07-01", source_window_to: "2026-07-31", provisional_reasons: [] }];
    renderWith(<ProjectMode />, member(["forecasting.view"]));
    expect(await screen.findByRole("button", { name: "Load" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    cleanup();

    renderWith(<ProjectMode />, member(["forecasting.view", "forecasting.create"]));
    expect(await screen.findByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    cleanup();

    renderWith(<ProjectMode />, member(["forecasting.view", "forecasting.delete"]));
    expect(await screen.findByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Duplicate" })).toBeNull();
    cleanup();

    renderWith(<ProjectMode />, OWNER());
    expect(await screen.findByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it("the Compare working set is dropped on every session purge", async () => {
    await import("@/components/forecasting/compareStore");
    expect(registeredPurgeHandlers()).toContain("forecasting-compare-entries");
    for (const reason of ["signed_out", "principal_changed", "access_changed"] as const) {
      localStorage.setItem("forecasting_compare_entries_v1", JSON.stringify([{ id: "plan:1", label: "x", frozen: {}, addedAt: "" }]));
      await runPurge(reason);
      expect(localStorage.getItem("forecasting_compare_entries_v1"), reason).toBeNull();
    }
  });
});

// ---- Reports -------------------------------------------------------------------

describe("Reports", () => {
  const PERIOD = { from: "2026-09-21", to: "2026-09-27" };

  beforeEach(() => {
    h.reportItems = [{
      id: "r-1",
      title: "Отчёт за неделю",
      dataIncomplete: false,
      periodFrom: PERIOD.from,
      periodTo: PERIOD.to,
      trials: 10,
      spend: "$100",
      blendedCpa: null,
      publishedVersionNo: null,
      updatedAt: "2026-09-28T00:00:00Z",
    }];
    h.report = {
      ...newReport({
        title: "Отчёт за неделю",
        bindings: emptyReportBindings(PERIOD, { from: "2026-09-14", to: "2026-09-20" }),
        engineVersions: {} as Parameters<typeof newReport>[0]["engineVersions"],
      }),
      id: "r-1",
    };
  });

  async function openReport(access: AccessContextValue) {
    renderWith(<ReportsPage />, access);
    fireEvent.click(await screen.findByText("Отчёт за неделю"));
    await screen.findByText(/данные ещё не собраны/i);
  }

  it("collecting a new report needs reports.create", async () => {
    renderWith(<ReportsPage />, member(["reports.view"]));
    await screen.findByText("Отчёт за неделю");
    expect(screen.queryByRole("button", { name: /собрать отчёт/i })).toBeNull();
    cleanup();
    renderWith(<ReportsPage />, member(["reports.view", "reports.create"]));
    expect(await screen.findByRole("button", { name: /собрать отчёт/i })).toBeInTheDocument();
  });

  it("a reports.view member opens a report read-only", async () => {
    await openReport(member(["reports.view"]));
    expect(screen.getByRole("button", { name: /к списку/i })).toBeInTheDocument();
    for (const name of [/пересобрать/i, /сформулировать/i, /опубликовать/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    for (const title of ["Скопировать для Google Docs", "Печать / PDF", "Скачать Markdown"]) {
      expect(screen.queryByTitle(title)).toBeNull();
    }
  });

  it("each control follows its own permission; AI prose needs reports.edit and ai.use", async () => {
    await openReport(member(["reports.view", "reports.edit"]));
    expect(screen.getByRole("button", { name: /пересобрать/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /сформулировать/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /опубликовать/i })).toBeNull();
    cleanup();

    await openReport(member(["reports.view", "reports.edit", "ai.use", "reports.publish", "reports.export"]));
    expect(screen.getByRole("button", { name: /сформулировать/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /опубликовать/i })).toBeInTheDocument();
    expect(screen.getByTitle("Печать / PDF")).toBeInTheDocument();
    cleanup();

    await openReport(OWNER());
    for (const name of [/пересобрать/i, /сформулировать/i, /опубликовать/i]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    for (const title of ["Скопировать для Google Docs", "Печать / PDF", "Скачать Markdown"]) {
      expect(screen.getByTitle(title)).toBeInTheDocument();
    }
  });

  it("BlockEditor read-only shows the visible blocks and no editing controls", () => {
    const block = (id: string, title: string, content: string, hidden = false): ReportBlock => ({
      id, type: "prose" as ReportBlock["type"], section: "executive_summary", title, content, hidden,
      pinned: false, generatedBy: "human", editedByHuman: false, evidence: [], updatedAt: "",
    });
    const blocks = [block("b-1", "Итог", "Выручка выросла."), block("b-2", "Черновик", "скрытый текст", true)];
    render(<BlockEditor blocks={blocks} onChange={() => {}} saveState={{ kind: "idle" }} readOnly />);
    expect(screen.getByTestId("report-blocks-readonly")).toBeInTheDocument();
    expect(screen.getByText("Выручка выросла.")).toBeInTheDocument();
    expect(screen.queryByText("скрытый текст")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    cleanup();
    render(<BlockEditor blocks={blocks} onChange={() => {}} saveState={{ kind: "idle" }} />);
    expect(screen.getByRole("button", { name: /добавить блок/i })).toBeInTheDocument();
  });

  it("PlanFactPanel read-only lists tasks without add / delete", async () => {
    const task: ReportTask = {
      id: "t-1", title: "Запустить креативы", direction: null, status: "planned", priority: "medium", owner: null,
      plannedDate: PERIOD.to, actualDate: null, comment: null, link: null, movedReason: null, result: null,
      firstReportId: "r-1", closedReportId: null, createdAt: "", updatedAt: "",
    };
    h.tasks = [task];
    render(<PlanFactPanel period={PERIOD} reportId="r-1" readOnly />);
    expect(await screen.findByText("Запустить креативы")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /добавить/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /удалить задачу/i })).toBeNull();
    cleanup();
    render(<PlanFactPanel period={PERIOD} reportId="r-1" />);
    expect(await screen.findByRole("button", { name: /удалить задачу/i })).toBeInTheDocument();
  });
});
