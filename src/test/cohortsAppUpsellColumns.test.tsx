// Cohorts page: the In-product Upsell columns of the token / in-product upsell
// split (2026-10-23). Hidden by default; the built-in Monetization view shows
// the buyers / CR / purchases / net revenue with the mapped values and the Total
// row; the built-in Users view does not. Harness (mocks) copied from
// accessPagesAnalytics.test.tsx, with a mocked ClickHouse result.

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
vi.mock("@/components/TrialsDailySection", async () => {
  const React = await import("react");
  return { TrialsDailySection: () => React.createElement("div", { "data-testid": "trials-daily" }) };
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
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import CohortsPage from "@/pages/Cohorts";

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

function ownerRow(): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-a",
    user_id: USER.id,
    email: USER.email,
    display_name: null,
    is_data_owner: true,
    raw_access: true,
    role: { id: "role-1", key: "owner", name: "Owner", is_owner: true, permissions: [] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p-owner",
  };
}

const OWNER = () => buildAccessValue({ status: "ok", access: ownerRow(), userId: USER.id });

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

function agg(over: Partial<CohortAggregateRow>): CohortAggregateRow {
  return {
    cohort_date: "2026-10-01", funnel: "soulmate", campaign_path: "soulmate-sketch",
    trial_users: 100, upsell_users: 20, first_subscription_users: 40, renewal_users: 12,
    renewal_users_by_level: { 2: 8, 3: 3 }, refund_users: 3, support_users: 0, support_rate: 0,
    active_users: 0, active_subscriptions: 0, cancelled_users: 0, user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
    trial_revenue: 80, upsell_revenue: 120, first_subscription_revenue: 500, renewal_revenue: 250,
    gross_revenue: 1000, net_revenue: 950, amount_refunded: 50,
    revenue_d0: 200, revenue_d7: 600, revenue_d14: 700, revenue_d30: 800, revenue_d60: 900,
    net_revenue_1m: 800, ltv_1m_per_user: 8,
    upsell_1_users: 18, upsell_2_users: 2, upsell_3_users: 0, upsell_extra_users: 0,
    upsell_1_revenue: 120, upsell_2_revenue: 10, upsell_3_revenue: 0, upsell_extra_revenue: 0,
    funnel_upsell_users: 20, funnel_upsell_revenue: 130,
    token_buyers: 4, token_purchases: 5, token_gross_revenue: 30, token_net_revenue: 25, addon_revenue: 155,
    fx_missing_transactions: 0, fx_missing_amount: 0,
    dedup: { active_user_hashes: [], active_subscription_hashes: [], refunded_user_hashes: [], cancelled_user_hashes: [], user_cancelled_user_hashes: [], auto_cancelled_user_hashes: [], cancelled_active_user_hashes: [], token_buyer_hashes: [] },
    ...over,
  };
}

const ROWS = [
  mapAggregateToCohortRow(agg({ cohort_date: "2026-10-02", app_upsell_buyers: 7, app_upsell_purchases: 9, app_upsell_gross_revenue: 26.91, app_upsell_net_revenue: 23.92 })),
  mapAggregateToCohortRow(agg({ cohort_date: "2026-10-01", trial_users: 50, app_upsell_buyers: 3, app_upsell_purchases: 3, app_upsell_gross_revenue: 8.97, app_upsell_net_revenue: 8.97 })),
];

const RESULT = {
  cohorts: ROWS,
  source: "clickhouse",
  durationMs: 5,
  diagnostics: {
    snapshot_stale: false,
    snapshot_complete: true,
    report_complete: true,
    active_snapshot_version: "snap-1",
    source_warehouse_version: "whv_test",
    current_warehouse_version: "whv_test",
    filters_applied: {},
  },
};

function cohortsQuery() {
  return {
    chResult: RESULT,
    chStatus: { loading: false, error: null, durationMs: 5, subStatus: null, applicable: true, unsupportedFilters: [], fallbackReason: null, filtersApplied: null },
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 100,
    dataUpdatedAt: 0,
    isStale: false,
    isFilterScopeCurrent: true,
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  h.cohortsMode = "clickhouse";
  h.cohortsQuery = cohortsQuery();
  fns.useCohortsListQuery.mockImplementation(() => h.cohortsQuery);
  fns.useAiCohortSignals.mockImplementation(() => ({ output: null, byCohort: new Map(), byPath: new Map(), contextHash: null, paymentLoading: false }));
  fns.useAiCampaignSignals.mockImplementation(() => ({ output: null, byCampaign: new Map(), contextHash: null, paymentLoading: false }));
});

afterEach(() => {
  cleanup();
});

const APP_HEADERS = ["In-product Upsell Buyers", "In-product Upsell CR", "In-product Upsell Purchases", "In-product Upsell Net Rev"];

function headerTexts(): string[] {
  return screen.getAllByRole("columnheader").map((cell) => (cell.textContent ?? "").trim());
}

/** The texts of one column, top to bottom (every body row of the table). */
function columnTexts(header: string): string[] {
  const headers = screen.getAllByRole("columnheader");
  const index = headers.findIndex((cell) => (cell.textContent ?? "").includes(header));
  expect(index, header).toBeGreaterThanOrEqual(0);
  const table = headers[index].closest("table")!;
  return [...table.querySelectorAll("tbody tr")].map((row) => (row.children[index]?.textContent ?? "").trim());
}

async function applyBuiltInView(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  const option = await screen.findByRole("button", { name: new RegExp(`^${name}\\s*built-in`, "i") });
  fireEvent.click(option);
  await waitFor(() => expect(screen.getByText((_, node) => node?.textContent === `View: ${name}`)).toBeInTheDocument());
}

describe("Cohorts: in-product upsell columns", () => {
  it("are hidden by default, shown by the built-in Monetization view with the mapped values and the totals", async () => {
    renderWith(<CohortsPage />, OWNER());
    expect(headerTexts().some((text) => APP_HEADERS.some((header) => text.includes(header)))).toBe(false);

    await applyBuiltInView("Monetization");
    const texts = headerTexts();
    for (const header of APP_HEADERS) expect(texts.some((text) => text.includes(header)), header).toBe(true);
    // Gross Rev is selectable but not part of the built-in view.
    expect(texts.some((text) => text.includes("In-product Upsell Gross Rev"))).toBe(false);

    const buyers = columnTexts("In-product Upsell Buyers");
    expect(buyers).toEqual(expect.arrayContaining(["7", "3"]));
    // The Total row: buyers deduped by synthetic id (7 + 3), CR from the summed trials.
    expect(buyers).toContain("10");
    expect(columnTexts("In-product Upsell Purchases")).toEqual(expect.arrayContaining(["9", "3", "12"]));
    const cr = columnTexts("In-product Upsell CR");
    expect(cr.some((text) => text.startsWith("7.0") || text.startsWith("7%"))).toBe(true);
    expect(cr.some((text) => text.startsWith("6.6") || text.startsWith("6.7"))).toBe(true); // 10 / 150
    const net = columnTexts("In-product Upsell Net Rev");
    expect(net.some((text) => text.includes("23.92"))).toBe(true);
    expect(net.some((text) => text.includes("32.89"))).toBe(true);
  }, 30_000);

  it("the built-in Users view does not show them", async () => {
    renderWith(<CohortsPage />, OWNER());
    await applyBuiltInView("Users");
    const texts = headerTexts();
    for (const header of APP_HEADERS) expect(texts.some((text) => text.includes(header)), header).toBe(false);
  }, 30_000);
});
