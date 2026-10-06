// The media-buyer pages for a funnel-restricted member (access Phase 2, spec
// §5.3): Dashboard → Revenue Intelligence, Cohorts, Funnels and the FB
// Analytics warehouse tab. UX only — the Edge gate, the scoped SQL and the
// registry RLS are authoritative — so these tests pin what the member SEES:
// the funnel-scope banner, the forced "filters active" presentation, options
// narrowed to their funnels, saved out-of-scope values named and clearable,
// the 409 "being prepared" state, the hidden account level and AI, and the
// path chips. The owner / all-scope renders stay as they were. Which Edge
// actions these pages call is pinned in accessRestrictedPageCalls.test.tsx.

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

const h = vi.hoisted(() => ({
  funnels: [] as unknown[],
  cohortsQuery: null as unknown,
  revenue: null as unknown,
  fbReport: null as unknown,
}));

const fns = vi.hoisted(() => ({
  useCohortsListQuery: vi.fn(),
  useRevenueBundle: vi.fn(),
  useFbReportQuery: vi.fn(),
  useAiCohortSignals: vi.fn(),
  useAiCampaignSignals: vi.fn(),
  loadCohortDetailsFromClickHouse: vi.fn(),
  listFunnels: vi.fn(),
  autoLoadWarehouseIntoStore: vi.fn(async () => ({ status: "ok", count: 0 })),
}));

vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "app-layout" }, React.createElement("h1", null, title), actions, children),
  };
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
  useRevenueDayBreakdown: () => ({ loading: false, error: null, errorCode: null, errorStatus: null, breakdown: null }),
}));
vi.mock("@/services/analyticsAdapters", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  autoLoadWarehouseIntoStore: fns.autoLoadWarehouseIntoStore,
  autoLoadWarehouseIntoStoreWithOptions: vi.fn(async () => ({ status: "ok" })),
}));
vi.mock("@/services/cohortSnapshotHealth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ensureCohortSnapshotRebuild: vi.fn(() => "started"),
}));
vi.mock("@/services/cohortsDataSource", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  cohortsDataSourceMode: () => "clickhouse",
  loadCohortDetailsFromClickHouse: fns.loadCohortDetailsFromClickHouse,
}));
vi.mock("@/services/clickhouse", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isClickHouseCircuitOpen: () => false,
}));
vi.mock("@/services/funnels", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listFunnels: fns.listFunnels,
  listTags: vi.fn(async () => []),
  listFunnelFoxFunnels: vi.fn(async () => []),
}));
vi.mock("@/services/funnelfoxSubscriptionsSync", () => ({
  getFunnelFoxSubscriptionsSyncState: vi.fn(async () => null),
  subscriptionSyncCompletenessWarning: () => null,
}));
vi.mock("@/services/cohortsUiSettings", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadCohortsUiSettingsCloud: vi.fn(async () => null),
  saveCohortsUiSettingsCloud: vi.fn(async () => null),
}));

import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { principalPageStateKey } from "@/hooks/usePersistedPageState";
import { ClickHouseRequestError } from "@/services/clickhouse";
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import { canonicalCampaignPath, funnelScopeFilterPaths } from "@/services/funnels";
import { SCOPE_PENDING_POLL_MS, SCOPE_SNAPSHOT_NOT_READY } from "@/components/access/ScopeDataPending";
import { ACCESS_ERROR } from "../../supabase/functions/_shared/access/errors";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import Dashboard from "@/pages/Dashboard";
import CohortsPage from "@/pages/Cohorts";
import FBAnalyticsPage from "@/pages/FBAnalytics";
import FunnelsPage from "@/pages/Funnels";
import { RevenueIntelligenceSection } from "@/components/RevenueIntelligenceSection";
import { FbWarehouseAnalytics } from "@/components/FbWarehouseAnalytics";

// ---- access fixtures -----------------------------------------------------------

const USER: AuthUser = { id: "user-buyer", email: "buyer@example.test", provider: "supabase" };
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

/** The plan's Media Buyer role (ai.use included: restricted members must still never see AI). */
const MEDIA_BUYER = ["dashboard.view", "cohorts.view", "funnels.view", "facebook_analytics.view", "ai.use"];
const PATH_A = "soulmate-sketch";
const PATH_B = "past-life";

function memberRow(input: {
  permissions?: string[];
  scope?: { mode: "all" | "selected" | "none"; funnel_ids: string[]; paths: string[] };
  raw?: boolean;
  partition?: string;
}): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-buyer",
    user_id: USER.id,
    email: USER.email,
    display_name: null,
    is_data_owner: input.raw === true,
    raw_access: input.raw === true,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: input.raw === true, permissions: input.permissions ?? MEDIA_BUYER },
    funnel_scope: input.scope ?? { mode: "all", funnel_ids: [], paths: [] },
    access_version: "3",
    partition: input.partition ?? "p-member",
  };
}

/** buyer A: one funnel, path soulmate-sketch. */
const BUYER_A = () =>
  buildAccessValue({
    status: "ok",
    access: memberRow({ scope: { mode: "selected", funnel_ids: ["f-a"], paths: [PATH_A] }, partition: "p-buyer-a" }),
    userId: USER.id,
  });
const BUYER_NONE = () =>
  buildAccessValue({ status: "ok", access: memberRow({ scope: { mode: "none", funnel_ids: [], paths: [] }, partition: "p-none" }), userId: USER.id });
const OWNER = () =>
  buildAccessValue({ status: "ok", access: memberRow({ raw: true, permissions: [], partition: "p-owner" }), userId: USER.id });
const ALL_SCOPE = (permissions: string[]) => buildAccessValue({ status: "ok", access: memberRow({ permissions }), userId: USER.id });

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

function persist(key: string, value: unknown) {
  localStorage.setItem(principalPageStateKey(key, USER.id), JSON.stringify(value));
}

// ---- data fixtures -------------------------------------------------------------

const REGISTRY_A = {
  id: "f-a",
  funnel_path: PATH_A,
  display_name: "Soulmate Sketch",
  is_active: true,
  tags: [],
  paths: [
    { id: "1", path: PATH_A, status: "active" },
    { id: "2", path: "soulmate-sketch-old", status: "retired" },
  ],
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-02T00:00:00Z",
};

const ZERO_TYPES = { trial: 0, first_subscription: 0, renewals: 0, upsells: 0, tokens: 0 };

function restrictedBundle() {
  const row = {
    date: "2026-10-05", gross: 120, refunds: 0, net: 110, spend: 0, gross_new: 20, gross_existing: 100, gross_unattributed: 0,
    net_new: 18, net_existing: 92, net_unattributed: 0, by_type: { ...ZERO_TYPES, trial: 20, renewals: 100 }, paying_users: 3,
    new_paying_users: 1, profit: 0, cumulative_profit: 0, partial: false,
  };
  return {
    ok: true, source: "clickhouse", action: "bundle", generated_at: "2026-10-06T00:00:00Z", query_duration_ms: 5, bucket: "day",
    date_from: "2026-10-05", date_to: "2026-10-05", buckets: [row],
    totals: { ...row, by_type: row.by_type },
    by_funnel: [{ key: PATH_A, gross: 120, net: 110, gross_new: 20, gross_existing: 100 }],
    by_plan: [], by_age: [],
    diagnostics: {
      attributed_pct: 100, future_cohort_gross: 0, snapshot_warehouse_version: "wh", snapshot_classification_version: "cls",
      rows_scanned: 0, filters_active: true, note: "Funnel-restricted view",
    },
  };
}

function aggRow(over: Partial<CohortAggregateRow> = {}): CohortAggregateRow {
  return {
    cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: PATH_A,
    trial_users: 10, upsell_users: 3, first_subscription_users: 8, renewal_users: 5,
    renewal_users_by_level: { 2: 5, 3: 4 }, refund_users: 1, support_users: 2, support_rate: 20,
    active_users: 0, active_subscriptions: 0, cancelled_users: 0,
    user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
    trial_revenue: 10, upsell_revenue: 30, first_subscription_revenue: 240, renewal_revenue: 150,
    gross_revenue: 500, net_revenue: 450, amount_refunded: 50,
    revenue_d0: 10, revenue_d7: 100, revenue_d14: 200, revenue_d30: 400, revenue_d60: 450,
    net_revenue_1m: 400, ltv_1m_per_user: 40,
    upsell_1_users: 0, upsell_2_users: 0, upsell_3_users: 0, upsell_extra_users: 0,
    upsell_1_revenue: 0, upsell_2_revenue: 0, upsell_3_revenue: 0, upsell_extra_revenue: 0,
    funnel_upsell_users: 0, funnel_upsell_revenue: 0,
    token_buyers: 0, token_purchases: 0, token_gross_revenue: 0, token_net_revenue: 0, addon_revenue: 0,
    fx_missing_transactions: 0, fx_missing_amount: 0,
    dedup: {
      active_user_hashes: [], active_subscription_hashes: [], refunded_user_hashes: [],
      cancelled_user_hashes: [], user_cancelled_user_hashes: [], auto_cancelled_user_hashes: [],
      cancelled_active_user_hashes: [], token_buyer_hashes: [],
    },
    fb_spend: null, fb_currency: null, fb_purchases: null, fb_cpp: null,
    fb_impressions: null, fb_reach: null, fb_clicks: null, fb_link_clicks: null,
    fb_ctr: null, fb_cpc: null, fb_cpm: null, fb_purchase_value: null, fb_roas: null,
    fb_campaigns_matched: 0, fb_match_status: "campaign_not_visible" as CohortAggregateRow["fb_match_status"],
    ...over,
  } as CohortAggregateRow;
}

/** The redacted restricted diagnostics (spec §4 cohorts list side channels). */
const RESTRICTED_DIAGNOSTICS = {
  snapshot_stale: false,
  snapshot_status: "current",
  active_snapshot_version: "snap-1",
  snapshot_generated_at: "2026-10-05T23:00:00Z",
  source_transactions: null,
  current_warehouse_transactions: null,
  cohort_users: null,
  report_complete: true,
  source_warehouse_version: "whv_a",
  current_warehouse_version: null,
  counts_redacted: true,
  subscription_data_status: "available",
  support_data_status: "available",
  filters_applied: { country: true, card_type: true, platform: true, campaign_id: true, traffic_source: true, price_plan: true },
};

function cohortsResult(rows: CohortAggregateRow[] = [aggRow()]) {
  return {
    cohorts: rows.map(mapAggregateToCohortRow),
    source: "clickhouse",
    durationMs: 5,
    subscriptionDataStatus: "available",
    diagnostics: RESTRICTED_DIAGNOSTICS,
  };
}

function cohortsQuery(input: { chResult?: unknown; error?: string | null; errorCode?: string | null; errorStatus?: number | null } = {}) {
  return {
    chResult: input.chResult ?? null,
    chStatus: {
      loading: false,
      error: input.error ?? null,
      errorCode: input.errorCode ?? null,
      errorStatus: input.errorStatus ?? null,
      durationMs: 5,
      subStatus: "available",
      applicable: true,
      unsupportedFilters: [],
      fallbackReason: null,
      filtersApplied: null,
    },
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 0,
    dataUpdatedAt: Date.now(),
    isStale: false,
    isFilterScopeCurrent: false,
  };
}

const FB_ROW = {
  key: "c1", campaign_id: "c1", campaign_name: "Campaign One", ad_account_id: "act-1", ad_account_name: "Account",
  buyer: "Ivan", adset_id: "", adset_name: "", ad_id: "", ad_name: "", spend: 10, fb_purchases: 1, cpp: 10,
  impressions: 100, clicks: 5, ctr: 5, cpc: 2, cpm: 100, outbound_clicks: 2, outbound_ctr: 2, days: 1, blended: null,
};

function fbQuery(input: { report?: unknown; error?: string | null; errorCode?: string | null } = {}) {
  return {
    report: input.report ?? null,
    loading: false,
    error: input.error ?? null,
    errorCode: input.errorCode ?? null,
    errorStatus: input.errorCode ? 409 : null,
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 0,
    dataUpdatedAt: 0,
  };
}

const lastRevenueRequest = () =>
  (fns.useRevenueBundle.mock.calls.at(-1)?.[0] as { request: { filters: { campaign_path: string[] } } }).request;
const lastCohortsRequest = () =>
  (fns.useCohortsListQuery.mock.calls.at(-1)?.[0] as { request: { filters: { campaign_path: string[] } } }).request;
const lastFbQuery = () => (fns.useFbReportQuery.mock.calls.at(-1)?.[0] as { query: { level: string } }).query;

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  h.funnels = [REGISTRY_A];
  h.cohortsQuery = cohortsQuery();
  h.revenue = { bundle: null, error: null, errorCode: null, errorStatus: null, isInitialLoading: false, isRefreshing: false };
  h.fbReport = fbQuery();
  fns.listFunnels.mockImplementation(async () => h.funnels);
  fns.useCohortsListQuery.mockImplementation(() => h.cohortsQuery);
  fns.useRevenueBundle.mockImplementation(() => h.revenue);
  fns.useFbReportQuery.mockImplementation(() => h.fbReport);
  fns.useAiCohortSignals.mockImplementation(() => ({ output: null, byCohort: new Map(), byPath: new Map(), contextHash: null, paymentLoading: false }));
  fns.useAiCampaignSignals.mockImplementation(() => ({ output: null, byCampaign: new Map(), contextHash: null, paymentLoading: false }));
  fns.loadCohortDetailsFromClickHouse.mockImplementation(() => new Promise(() => {}));
});

afterEach(() => {
  cleanup();
});

// ---- contract ------------------------------------------------------------------

describe("shared contract", () => {
  it("the pending code and poll interval match the gate's contract (spec §3.5, §5.3)", () => {
    expect(SCOPE_SNAPSHOT_NOT_READY).toBe(ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY);
    expect(SCOPE_PENDING_POLL_MS).toBe(60_000);
  });

  it("the member's filter paths follow the server's scope rule (canonical, ≤ 200, never unknown, selected only)", () => {
    const long = "a".repeat(201);
    expect([...funnelScopeFilterPaths({ mode: "selected", paths: [PATH_A, "Soulmate", "unknown", "/x", long, "a-b-1"] })])
      .toEqual([PATH_A, "a-b-1"]);
    expect(funnelScopeFilterPaths({ mode: "all", paths: [PATH_A] }).size).toBe(0);
    expect(funnelScopeFilterPaths({ mode: "none", paths: [PATH_A] }).size).toBe(0);
    expect(funnelScopeFilterPaths(null).size).toBe(0);
  });

  it("canonicalCampaignPath mirrors app.canonical_campaign_path", () => {
    expect(canonicalCampaignPath("/Soulmate-Sketch")).toBe("soulmate-sketch");
    expect(canonicalCampaignPath(" https://Example.com/Palm_Reading/?utm=1#x ")).toBe("palm-reading");
    expect(canonicalCampaignPath("a_b")).toBe("a-b");
    expect(canonicalCampaignPath("--a--b--")).toBe("a-b");
    expect(canonicalCampaignPath("unknown")).toBeNull();
    expect(canonicalCampaignPath("тест")).toBeNull();
    expect(canonicalCampaignPath("")).toBeNull();
    expect(canonicalCampaignPath("a".repeat(201))).toBeNull();
  });
});

// ---- Dashboard -----------------------------------------------------------------

describe("Dashboard (buyer A)", () => {
  it("shows the funnel-scope banner with the member's funnels instead of the server-only note", async () => {
    renderWith(<Dashboard />, BUYER_A());
    const banner = await screen.findByTestId("funnel-scope-banner");
    expect(banner).toHaveAttribute("data-surface", "dashboard");
    expect(await within(banner).findByText(/Soulmate Sketch/)).toBeInTheDocument();
    expect(within(banner).getByText(/Your funnels \(1\)/)).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-server-only-note")).toBeNull();
    expect(screen.queryByText("Global Filters")).toBeNull();
    // Revenue Intelligence names the member's scope, not the project.
    expect(screen.getByText(/your funnels · same/)).toBeInTheDocument();
  });

  it("a member with no funnels is told so", async () => {
    renderWith(<Dashboard />, BUYER_NONE());
    expect(await screen.findByText("No funnels are assigned to you.")).toBeInTheDocument();
    expect(fns.listFunnels).not.toHaveBeenCalled();
  });

  it("an all-scope member keeps the server-only note and no banner", () => {
    renderWith(<Dashboard />, ALL_SCOPE(["dashboard.view"]));
    expect(screen.getByTestId("dashboard-server-only-note")).toBeInTheDocument();
    expect(screen.queryByTestId("funnel-scope-banner")).toBeNull();
  });
});

describe("Revenue Intelligence (buyer A)", () => {
  it("presents the forced filters view: spend/profit/unattributed as —, restricted note, no project coverage footer", () => {
    h.revenue = { ...(h.revenue as object), bundle: restrictedBundle() };
    renderWith(<RevenueIntelligenceSection />, BUYER_A());
    expect(screen.getByTestId("revenue-restricted-note")).toHaveTextContent(/customers acquired through your funnels/);
    expect(screen.queryByText(/Cohort filters active/)).toBeNull();
    expect(screen.queryByText(/Attribution coverage/)).toBeNull();
    expect(screen.getAllByText("not in your funnel view").length).toBeGreaterThanOrEqual(3);
    // The controls agree with the server's filters_active, so the CSV is never "lagging".
    expect(screen.getByRole("button", { name: /csv/i })).not.toBeDisabled();
  });

  it("offers only the member's funnel paths and names saved values outside them, with Clear", async () => {
    persist("ui_state_revenue_intel", { funnelDict: [PATH_B, PATH_A], funnels: [PATH_B] });
    h.revenue = { ...(h.revenue as object), bundle: restrictedBundle() };
    renderWith(<RevenueIntelligenceSection />, BUYER_A());
    // The saved value is still sent (the server intersects it, R11) …
    expect(lastRevenueRequest().filters.campaign_path).toEqual([PATH_B]);
    expect(screen.getByTestId("revenue-out-of-scope-funnels")).toHaveTextContent("1 saved funnel filter is outside your funnels");

    fireEvent.click(screen.getByRole("button", { name: /^funnel/i }));
    const options = await screen.findByRole("dialog");
    expect(within(options).getByText(PATH_A)).toBeInTheDocument();
    expect(within(options).queryByText(PATH_B)).toBeNull();
    fireEvent.keyDown(options, { key: "Escape" });

    // … until the member clears it.
    fireEvent.click(within(screen.getByTestId("revenue-out-of-scope-funnels")).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lastRevenueRequest().filters.campaign_path).toEqual([]));
    expect(screen.queryByTestId("revenue-out-of-scope-funnels")).toBeNull();
  });

  it("409 scope_snapshot_not_ready shows the pending card, never the rebuild advice", () => {
    h.revenue = { ...(h.revenue as object), error: "cohort_snapshot_not_ready", errorCode: SCOPE_SNAPSHOT_NOT_READY, errorStatus: 409 };
    renderWith(<RevenueIntelligenceSection />, BUYER_A());
    expect(screen.getByTestId("scope-data-pending")).toHaveTextContent(/Funnel-scoped data is being prepared/);
    expect(screen.queryByText(/needs the cohort snapshot/i)).toBeNull();
    expect(screen.queryByText(/ClickHouse revenue request failed/)).toBeNull();
  });

  it("the owner's view is unchanged: project-wide, every option, coverage footer, embedded snapshot card", () => {
    persist("ui_state_revenue_intel", { funnelDict: [PATH_B, PATH_A], funnels: [] });
    h.revenue = { ...(h.revenue as object), bundle: { ...restrictedBundle(), diagnostics: { ...restrictedBundle().diagnostics, filters_active: false } } };
    renderWith(<RevenueIntelligenceSection />, OWNER());
    expect(screen.getByText(/project-wide · same/)).toBeInTheDocument();
    expect(screen.getByText(/Attribution coverage 100%/)).toBeInTheDocument();
    expect(screen.queryByTestId("revenue-restricted-note")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^funnel/i }));
    expect(within(screen.getByRole("dialog")).getByText(PATH_B)).toBeInTheDocument();
    cleanup();

    h.revenue = { ...(h.revenue as object), bundle: null, error: "cohort_snapshot_not_ready", errorCode: null };
    renderWith(<RevenueIntelligenceSection />, OWNER());
    expect(screen.getByText(/needs the cohort snapshot/i)).toBeInTheDocument();
    expect(screen.queryByTestId("scope-data-pending")).toBeNull();
  });
});

// ---- Cohorts -------------------------------------------------------------------

describe("Cohorts (buyer A)", () => {
  it("names saved campaign-path filters outside the member's funnels and clears them", async () => {
    persist("ui_state_cohorts", { selectedCampaignPaths: [PATH_B, PATH_A] });
    renderWith(<CohortsPage />, BUYER_A());
    const banner = await screen.findByTestId("funnel-scope-banner");
    expect(banner).toHaveAttribute("data-surface", "cohorts");
    expect(within(banner).getByTestId("funnel-scope-dropped")).toHaveTextContent("1 saved filter value is outside your funnels and was ignored");
    // Sent as saved: the server intersects the include list (R11).
    expect(lastCohortsRequest().filters.campaign_path).toEqual([PATH_B, PATH_A].sort());

    fireEvent.click(within(banner).getByRole("button", { name: "Clear" }));
    await waitFor(() => expect(lastCohortsRequest().filters.campaign_path).toEqual([PATH_A]));
    expect(screen.queryByTestId("funnel-scope-dropped")).toBeNull();
  }, 20_000);

  it("409 renders the being-prepared state; 403 scope_not_supported says restricted access is being enabled", async () => {
    h.cohortsQuery = cohortsQuery({ error: "ClickHouse Edge Function failed: Funnel-scoped data is being prepared.", errorCode: SCOPE_SNAPSHOT_NOT_READY, errorStatus: 409 });
    renderWith(<CohortsPage />, BUYER_A());
    expect(await screen.findByTestId("scope-data-pending")).toBeInTheDocument();
    expect(screen.queryByText(/could not be loaded from the server/i)).toBeNull();
    await act(async () => {});
    expect(fns.autoLoadWarehouseIntoStore).not.toHaveBeenCalled();
    cleanup();

    h.cohortsQuery = cohortsQuery({ error: "ClickHouse Edge Function failed: x", errorCode: ACCESS_ERROR.SCOPE_NOT_SUPPORTED, errorStatus: 403 });
    renderWith(<CohortsPage />, BUYER_A());
    expect(await screen.findByText(/Restricted access is being enabled/)).toBeInTheDocument();
  }, 20_000);

  it("keeps AI off even with ai.use; an all-scope member with ai.use keeps it", async () => {
    h.cohortsQuery = cohortsQuery({ chResult: cohortsResult() });
    renderWith(<CohortsPage />, BUYER_A());
    await act(async () => {});
    expect(fns.useAiCohortSignals).toHaveBeenCalled();
    expect(fns.useAiCohortSignals.mock.calls.every(([params]) => params.enabled === false)).toBe(true);
    cleanup();
    fns.useAiCohortSignals.mockClear();

    renderWith(<CohortsPage />, ALL_SCOPE(["cohorts.view", "ai.use"]));
    await act(async () => {});
    expect(fns.useAiCohortSignals.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true });
  }, 20_000);

  it("explains FB cells of a campaign shared with other funnels", async () => {
    h.cohortsQuery = cohortsQuery({ chResult: cohortsResult() });
    renderWith(<CohortsPage />, BUYER_A());
    await waitFor(() => expect(screen.getAllByTitle("Campaign shared with other funnels — hidden").length).toBeGreaterThan(0));
  }, 20_000);

  it("the diagnostics strip shows only when the snapshot was updated", async () => {
    h.cohortsQuery = cohortsQuery({ chResult: cohortsResult() });
    renderWith(<CohortsPage />, BUYER_A());
    fireEvent.click(screen.getByRole("button", { name: /diagnostics/i }));
    const strip = await screen.findByText(/Cohorts data source/);
    const diagnostics = strip.closest("div.rounded-md") as HTMLElement;
    expect(within(diagnostics).getByText(/snapshot updated/)).toBeInTheDocument();
    for (const hidden of [/cohort users/, /snapshot rows/, /subscriptions:/, /support:/]) {
      expect(within(diagnostics).queryByText(hidden)).toBeNull();
    }
    cleanup();

    renderWith(<CohortsPage />, ALL_SCOPE(["cohorts.view", "admin.diagnostics.view"]));
    fireEvent.click(screen.getByRole("button", { name: /diagnostics/i }));
    expect(await screen.findByText(/cohort users/)).toBeInTheDocument();
  }, 20_000);

  it("a details request refused as funnel_out_of_scope reads 'Not available for your funnel access'", async () => {
    const row = mapAggregateToCohortRow(aggRow());
    persist("ui_state_cohorts", { expandedCohortIds: [row.cohort_id] });
    fns.loadCohortDetailsFromClickHouse.mockRejectedValue(
      new ClickHouseRequestError("ClickHouse Edge Function failed: This funnel is outside your funnel access.", {
        status: 403,
        errorCode: ACCESS_ERROR.FUNNEL_OUT_OF_SCOPE,
      }),
    );
    h.cohortsQuery = cohortsQuery({ chResult: cohortsResult() });
    renderWith(<CohortsPage />, BUYER_A());
    expect(await screen.findByText("Not available for your funnel access")).toBeInTheDocument();
    expect(fns.loadCohortDetailsFromClickHouse).toHaveBeenCalledWith(
      { cohort_date: row.cohort_date, funnel: row.funnel, campaign_path: PATH_A },
      expect.any(Object),
    );
  }, 20_000);
});

// ---- FB Analytics ----------------------------------------------------------------

describe("FB Analytics (buyer A)", () => {
  it("the page shows the funnel-scope banner with the campaign rule instead of the server-only note", async () => {
    renderWith(<FBAnalyticsPage />, BUYER_A());
    const banner = await screen.findByTestId("funnel-scope-banner");
    expect(banner).toHaveAttribute("data-surface", "fb");
    expect(banner).toHaveTextContent("Campaigns whose trial users all belong to your funnels; campaigns shared with other funnels are hidden.");
    expect(screen.queryByTestId("fb-analytics-server-only-note")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Blended (legacy)" })).toBeNull();
  });

  it("hides the account level and reads a persisted 'account' as 'campaign' before the query", () => {
    persist("ui_state_fb_warehouse", { level: "account" });
    renderWith(<FbWarehouseAnalytics />, BUYER_A());
    expect(screen.queryByRole("tab", { name: "Accounts" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Campaigns" })).toHaveAttribute("data-state", "active");
    expect(fns.useFbReportQuery.mock.calls.every(([params]) => params.query.level !== "account")).toBe(true);
    expect(lastFbQuery().level).toBe("campaign");
    cleanup();

    // The owner keeps the account level (and the persisted choice).
    renderWith(<FbWarehouseAnalytics />, OWNER());
    expect(screen.getByRole("tab", { name: "Accounts" })).toBeInTheDocument();
    expect(lastFbQuery().level).toBe("account");
  });

  it("keeps AI off (no signals, no AI column) even with ai.use", () => {
    h.fbReport = fbQuery({ report: { rows: [FB_ROW], filter_options: { buyers: [], accounts: [] }, charts: [], summary: null, diagnostics: null, query_duration_ms: 3 } });
    renderWith(<FbWarehouseAnalytics />, BUYER_A());
    expect(fns.useAiCampaignSignals.mock.calls.every(([params]) => params.enabled === false)).toBe(true);
    expect(screen.queryByRole("columnheader", { name: "AI" })).toBeNull();
    cleanup();

    renderWith(<FbWarehouseAnalytics />, ALL_SCOPE(["facebook_analytics.view", "ai.use"]));
    expect(fns.useAiCampaignSignals.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true });
    expect(screen.getByRole("columnheader", { name: "AI" })).toBeInTheDocument();
  });

  it("empty and pending states speak the member's scope", () => {
    renderWith(<FbWarehouseAnalytics />, BUYER_A());
    expect(screen.getByText(/No campaigns of your funnels in this range/)).toBeInTheDocument();
    expect(screen.queryByText(/run a sync/i)).toBeNull();
    cleanup();

    h.fbReport = fbQuery({ error: "ClickHouse Edge Function failed: Funnel-scoped data is being prepared.", errorCode: SCOPE_SNAPSHOT_NOT_READY });
    renderWith(<FbWarehouseAnalytics />, BUYER_A());
    expect(screen.getByTestId("scope-data-pending")).toBeInTheDocument();
    expect(screen.queryByText(/ClickHouse error/)).toBeNull();
    expect(screen.queryByText(/No campaigns of your funnels/)).toBeNull();
  });
});

// ---- Funnels -----------------------------------------------------------------------

describe("Funnels (buyer A)", () => {
  it("renders the funnel's granted paths as chips, read-only", async () => {
    h.funnels = [{ ...REGISTRY_A, paths: [...REGISTRY_A.paths, { id: "3", path: "soulmate-proposal", status: "proposed" }] }];
    renderWith(<FunnelsPage />, BUYER_A());
    const toggle = await screen.findByRole("switch", { name: /deactivate soulmate sketch/i });
    expect(toggle).toBeDisabled();
    const row = toggle.closest("tr") as HTMLElement;
    const chips = within(row).getAllByTestId("funnel-path-chip");
    expect(chips.map((chip) => chip.getAttribute("data-status"))).toEqual(["active", "retired"]);
    expect(within(row).getByText("(old)")).toBeInTheDocument();
    expect(within(row).queryByText("soulmate-proposal")).toBeNull();
    expect(screen.queryByRole("button", { name: /import from funnelfox/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /recompute active/i })).toBeNull();
  });

  it("an empty registry tells the restricted member no funnels are assigned", async () => {
    h.funnels = [];
    renderWith(<FunnelsPage />, BUYER_A());
    expect(await screen.findByText("No funnels are assigned to you.")).toBeInTheDocument();
    cleanup();
    renderWith(<FunnelsPage />, ALL_SCOPE(["funnels.view"]));
    expect(await screen.findByText("No funnels registered yet")).toBeInTheDocument();
  });

  it("a funnel without a granted path shows its stored path, muted", async () => {
    h.funnels = [{ ...REGISTRY_A, funnel_path: "Legacy Path", paths: [] }];
    renderWith(<FunnelsPage />, ALL_SCOPE(["funnels.view"]));
    const cell = await screen.findByText("Legacy Path");
    expect(cell).toHaveAttribute("title", "No campaign path of this funnel grants access yet");
  });
});
