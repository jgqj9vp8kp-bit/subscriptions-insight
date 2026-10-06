// Access UX of the operational pages (plan §14, §23; Milestone A): Transactions
// tabs, the Users / Payment Pass legacy fallbacks, Leads sync, Support,
// Integrations, Import and the AI drawer. UX only — every gated call is also
// refused by the Edge gate — so these tests pin two things: a member never sees
// (or fires) what their role does not include, and the data owner / legacy view
// is exactly today's.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import type { Transaction } from "@/services/types";
import type { SupportRequestSummaryRow } from "@/services/supportAnalytics";
import type { AiRecommendation } from "@/services/aiSignals";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: MockResizeObserver });
// jsdom has no layout: the drawer scrolls its log, Radix scrolls focused items.
Element.prototype.scrollTo = function scrollTo() {};
Element.prototype.scrollIntoView = function scrollIntoView() {};

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  txs: [] as unknown[],
  paymentMode: "clickhouse" as "clickhouse" | "legacy",
  paymentBundle: vi.fn(),
  usersMode: "clickhouse" as "clickhouse" | "legacy",
  usersData: vi.fn(),
  usersDecline: vi.fn(),
  autoLoad: vi.fn(async () => ({ status: "skipped" })),
  supportData: vi.fn(),
  getSupportMailStatus: vi.fn(),
  runSupportClassification: vi.fn(),
  listSupportImportBatches: vi.fn(),
  getAnsweredReplyForRequest: vi.fn(),
  loadSupportDetails: vi.fn(),
  listApiKeys: vi.fn(),
  listApiExportLogs: vi.fn(),
  getCapsuledStatus: vi.fn(),
  listCapsuledRows: vi.fn(),
  getClickHouseSummary: vi.fn(),
  getFfSyncState: vi.fn(),
  loadFunnelFoxLeads: vi.fn(),
  getFunnelFoxLeadsStats: vi.fn(),
  runFunnelFoxLeadsSync: vi.fn(),
  askAssistant: vi.fn(),
  loadAiActionHistory: vi.fn(),
}));

// No network and no Supabase in these tests: every PostgREST helper fails fast.
vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ title, description, actions, children }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {description && <p data-testid="page-description">{description}</p>}
      <div>{actions}</div>
      {children}
    </div>
  ),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-a" } }) }));
// Stable like the real hook's module-level toast (Integrations keys its refresh on it).
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/hooks/useAnalyticsCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAnalyticsCache")>();
  return {
    ...actual,
    useWarehouseVersion: () => ({ version: "whv_test", ready: true }),
    useSupportWarehouseVersion: () => ({ version: "swhv_test", ready: true }),
    invalidateSupportAnalyticsCache: vi.fn(() => Promise.resolve()),
  };
});
vi.mock("@/services/sheets", () => ({ useTransactions: () => mocks.txs }));
vi.mock("@/services/analyticsAdapters", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/analyticsAdapters")>();
  return { ...actual, autoLoadWarehouseIntoStore: mocks.autoLoad };
});
vi.mock("@/hooks/usePaymentAnalyticsCache", () => ({ usePaymentAnalyticsBundle: mocks.paymentBundle }));
vi.mock("@/services/paymentAnalyticsDataSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/paymentAnalyticsDataSource")>();
  return { ...actual, paymentAnalyticsMode: () => mocks.paymentMode };
});
vi.mock("@/services/paymentPassAnalytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/paymentPassAnalytics")>();
  return { ...actual, buildPaymentAttempts: vi.fn(actual.buildPaymentAttempts) };
});
vi.mock("@/hooks/useUsersCache", () => ({ useUsersData: mocks.usersData, useUsersDeclineData: mocks.usersDecline }));
vi.mock("@/services/usersDataSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/usersDataSource")>();
  return { ...actual, usersDataSourceMode: () => mocks.usersMode };
});
vi.mock("@/hooks/useSupportCache", () => ({ useSupportData: mocks.supportData }));
vi.mock("@/services/supportInbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/supportInbox")>();
  return { ...actual, getSupportMailStatus: mocks.getSupportMailStatus, syncSupportMail: vi.fn() };
});
vi.mock("@/services/supportClassification", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/supportClassification")>();
  return { ...actual, runSupportClassification: mocks.runSupportClassification };
});
vi.mock("@/services/supportAnalytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/supportAnalytics")>();
  return {
    ...actual,
    listSupportImportBatches: mocks.listSupportImportBatches,
    getAnsweredReplyForRequest: mocks.getAnsweredReplyForRequest,
    importSupportFile: vi.fn(),
    parseSupportFile: vi.fn(),
    updateSupportRequestManualClassification: vi.fn(),
    resetSupportRequestManualClassification: vi.fn(),
  };
});
vi.mock("@/services/supportDataSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/supportDataSource")>();
  return {
    ...actual,
    loadSupportDetails: mocks.loadSupportDetails,
    loadSupportExportPage: vi.fn(),
    loadSupportSyncStatus: vi.fn(),
    loadUnansweredContacts: vi.fn(),
    syncSupportToClickHouse: vi.fn(),
  };
});
vi.mock("@/services/integrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/integrations")>();
  return { ...actual, listApiKeys: mocks.listApiKeys, listApiExportLogs: mocks.listApiExportLogs, createApiKey: vi.fn(), revokeApiKey: vi.fn() };
});
vi.mock("@/services/capsuledFacebook", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/capsuledFacebook")>();
  return { ...actual, getCapsuledFacebookStatus: mocks.getCapsuledStatus, listCapsuledFacebookRows: mocks.listCapsuledRows, syncCapsuledFacebookStats: vi.fn() };
});
vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/clickhouse")>();
  return {
    ...actual,
    getClickHouseSummary: mocks.getClickHouseSummary,
    testClickHouseConnection: vi.fn(),
    initializeClickHouseSchema: vi.fn(),
    runClickHouseBackfill: vi.fn(),
    runClickHouseValidation: vi.fn(),
    invalidateClickHouseSummaryCache: vi.fn(),
    autoSyncClickHouseAfterImport: vi.fn(),
  };
});
vi.mock("@/components/ExportApiHealth", () => ({ ExportApiHealth: () => <div>export api health panel</div> }));
vi.mock("@/components/CampaignIdSplitDiagnostics", () => ({ CampaignIdSplitDiagnostics: () => <div>campaign split panel</div> }));
vi.mock("@/services/funnelfoxSubscriptionsSync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/funnelfoxSubscriptionsSync")>();
  return { ...actual, getFunnelFoxSubscriptionsSyncState: mocks.getFfSyncState };
});
vi.mock("@/services/funnelfoxLeads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/funnelfoxLeads")>();
  return {
    ...actual,
    loadFunnelFoxLeads: mocks.loadFunnelFoxLeads,
    getFunnelFoxLeadsStats: mocks.getFunnelFoxLeadsStats,
    runFunnelFoxLeadsSync: mocks.runFunnelFoxLeadsSync,
  };
});
vi.mock("@/services/aiAssistantClient", () => ({ askAssistant: mocks.askAssistant }));
vi.mock("@/services/aiRecommendationLog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/aiRecommendationLog")>();
  return { ...actual, loadAiActionHistory: mocks.loadAiActionHistory };
});

import TransactionsPage from "@/pages/Transactions";
import UsersPage from "@/pages/Users";
import LeadsPage from "@/pages/Leads";
import SupportPage from "@/pages/Support";
import IntegrationsPage from "@/pages/Integrations";
import ImportPage from "@/pages/Import";
import { PaymentPassAnalytics } from "@/components/PaymentPassAnalytics";
import { AiAssistantDrawer } from "@/components/ai/AiAssistantDrawer";
import { AiAnalysisPanel } from "@/components/ai/AiAnalysisPanel";
import { buildPaymentAttempts } from "@/services/paymentPassAnalytics";
import { registeredPurgeHandlers, runPurge } from "@/services/sessionPurge";
import { useAiAssistantStore, type AiAssistantContext } from "@/store/aiAssistantStore";

// ---- access fixtures -------------------------------------------------------------

const USER_ID = "user-a";

function row(permissions: string[], options: { raw?: boolean; owner?: boolean; partition?: string } = {}): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-a",
    user_id: USER_ID,
    email: "a@example.com",
    display_name: null,
    is_data_owner: options.raw === true,
    raw_access: options.raw === true,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: options.owner === true, permissions },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: options.partition ?? "p-member",
  };
}

function member(permissions: string[], options: { raw?: boolean; owner?: boolean; partition?: string } = {}): AccessContextValue {
  return buildAccessValue({ status: "ok", access: row(permissions, options), userId: USER_ID });
}

const LEGACY_OWNER = () => buildAccessValue({ status: "legacy", access: null, userId: USER_ID });

function renderWith(access: AccessContextValue, ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AccessContext.Provider value={access}>{ui}</AccessContext.Provider>
    </QueryClientProvider>,
  );
}

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "tx_1",
    user_id: "buyer_1",
    email: "buyer@example.com",
    event_time: "2026-06-01T10:00:00.000Z",
    amount_usd: 9.99,
    gross_amount_usd: 9.99,
    refund_amount_usd: 0,
    net_amount_usd: 9.99,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: "",
    classification_reason: "test",
    metadata: {},
    ...overrides,
  };
}

const idleBundle = () => ({
  chBundle: null,
  chStatus: { loading: false, error: null as string | null },
  isBackgroundRefreshing: false,
  isInitialLoading: false,
  progressPercent: 100,
  dataUpdatedAt: 0,
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.txs = [tx()];
  mocks.paymentMode = "clickhouse";
  mocks.usersMode = "clickhouse";
  mocks.paymentBundle.mockImplementation(idleBundle);
  mocks.usersData.mockReturnValue({
    chUsers: null, chSummary: null, chOptions: null, chStatus: { loading: false, error: null },
    isBackgroundRefreshing: false, isInitialLoading: false, progressPercent: 100, dataUpdatedAt: 0,
  });
  mocks.usersDecline.mockReturnValue({
    chDecline: null, chDeclineStatus: { loading: false, error: null },
    isBackgroundRefreshing: false, isInitialLoading: false, progressPercent: 100, dataUpdatedAt: 0,
  });
  mocks.getSupportMailStatus.mockResolvedValue(null);
  mocks.runSupportClassification.mockRejectedValue(new Error("not in tests"));
  mocks.listSupportImportBatches.mockResolvedValue([]);
  mocks.getAnsweredReplyForRequest.mockResolvedValue(null);
  mocks.listApiKeys.mockResolvedValue([]);
  mocks.listApiExportLogs.mockResolvedValue([]);
  mocks.getCapsuledStatus.mockResolvedValue(null);
  mocks.listCapsuledRows.mockResolvedValue([]);
  mocks.getClickHouseSummary.mockResolvedValue(null);
  mocks.getFfSyncState.mockResolvedValue(null);
  mocks.loadFunnelFoxLeads.mockResolvedValue([]);
  mocks.getFunnelFoxLeadsStats.mockResolvedValue(null);
  mocks.runFunnelFoxLeadsSync.mockResolvedValue({ status: "ok", dry_run: false, all_stages_completed: true });
  useAiAssistantStore.setState({ open: false, context: null });
});

afterEach(() => {
  cleanup();
});

// ---- Transactions ------------------------------------------------------------------

describe("Transactions tabs", () => {
  it("owner / legacy: all three tabs, the list by default, warehouse hydration requested", async () => {
    renderWith(LEGACY_OWNER(), <TransactionsPage />);

    expect(screen.getByRole("tab", { name: "Transaction List" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Payment Pass Analytics" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Banks" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Search by email…")).toBeInTheDocument();
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
    expect(screen.getByTestId("page-description")).toHaveTextContent("1 of 1 transactions");
    await waitFor(() => expect(mocks.autoLoad).toHaveBeenCalledTimes(1));
  });

  it("payment_pass.view only: the persisted list tab is coerced to Payment Pass, no list, no hydration", async () => {
    localStorage.setItem("ui_state_transactions", JSON.stringify({ mode: "list" }));
    renderWith(member(["payment_pass.view"]), <TransactionsPage />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Payment Pass Analytics"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByPlaceholderText("Search by email…")).not.toBeInTheDocument();
    expect(screen.queryByText("buyer@example.com")).not.toBeInTheDocument();
    expect(screen.queryByTestId("page-description")).not.toBeInTheDocument();
    expect(screen.getByText("Date basis")).toBeInTheDocument();
    await act(async () => {});
    expect(mocks.autoLoad).not.toHaveBeenCalled();
  });

  it("Banks needs payment_pass.banks.view; transactions.view without raw access opens no list", () => {
    renderWith(member(["transactions.view", "payment_pass.view", "payment_pass.banks.view"]), <TransactionsPage />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Payment Pass Analytics", "Banks"]);
  });

  it("transactions.view alone (not the data owner) grants no tab: inline NoAccess", () => {
    renderWith(member(["transactions.view"]), <TransactionsPage />);
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
    expect(screen.getByTestId("no-access")).toHaveTextContent("None of the Transactions tabs is available to your role.");
    expect(mocks.autoLoad).not.toHaveBeenCalled();
  });

  it("the data owner on a non-owner role keeps the list with transactions.view", () => {
    renderWith(member(["transactions.view"], { raw: true }), <TransactionsPage />);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Transaction List"]);
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
  });
});

// ---- Payment Pass legacy fallback ----------------------------------------------------

describe("Payment Pass legacy fallback", () => {
  const failed = () => ({ ...idleBundle(), chStatus: { loading: false, error: "boom" } });

  it("owner / legacy: an Edge error falls back to the browser recompute (today)", () => {
    mocks.paymentBundle.mockImplementation(failed);
    renderWith(LEGACY_OWNER(), <PaymentPassAnalytics txs={mocks.txs as Transaction[]} />);
    expect(vi.mocked(buildPaymentAttempts)).toHaveBeenCalled();
    expect(screen.getByText(/ClickHouse error — using legacy: boom/)).toBeInTheDocument();
  });

  it("member: an Edge error is shown, never recomputed from the browser store", () => {
    mocks.paymentBundle.mockImplementation(failed);
    renderWith(member(["payment_pass.view"]), <PaymentPassAnalytics txs={mocks.txs as Transaction[]} />);
    expect(vi.mocked(buildPaymentAttempts)).not.toHaveBeenCalled();
    expect(screen.getByText(/ClickHouse error: boom/)).toBeInTheDocument();
    expect(screen.queryByText(/using legacy/)).not.toBeInTheDocument();
    expect(screen.queryByText("legacy (fallback)")).not.toBeInTheDocument();
  });

  it("member: the legacy data-source flag is ignored — the Edge path is always enabled", () => {
    mocks.paymentMode = "legacy";
    renderWith(member(["payment_pass.view"]), <PaymentPassAnalytics txs={mocks.txs as Transaction[]} />);
    expect(mocks.paymentBundle.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true });
    expect(vi.mocked(buildPaymentAttempts)).not.toHaveBeenCalled();
  });

  it("owner / legacy: the legacy flag still selects the browser path", () => {
    mocks.paymentMode = "legacy";
    renderWith(LEGACY_OWNER(), <PaymentPassAnalytics txs={mocks.txs as Transaction[]} />);
    expect(mocks.paymentBundle.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    expect(vi.mocked(buildPaymentAttempts)).toHaveBeenCalled();
  });
});

// ---- Users legacy fallback -------------------------------------------------------------

describe("Users legacy fallback", () => {
  const USERS_PERMS = ["users.view", "users.pii.view"];

  it("owner / legacy with the legacy flag: computed from the browser store (today)", () => {
    mocks.usersMode = "legacy";
    renderWith(LEGACY_OWNER(), <UsersPage />);
    expect(mocks.usersData.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: false });
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
  });

  it("member: the legacy flag is ignored and the server path is enabled", () => {
    mocks.usersMode = "legacy";
    renderWith(member(USERS_PERMS), <UsersPage />);
    expect(mocks.usersData.mock.calls.at(-1)?.[0]).toMatchObject({ enabled: true });
    expect(screen.queryByText("buyer@example.com")).not.toBeInTheDocument();
  });

  it("member: a server error is shown, never recomputed from the browser store", () => {
    mocks.usersData.mockReturnValue({
      chUsers: null, chSummary: null, chOptions: null, chStatus: { loading: false, error: "boom" },
      isBackgroundRefreshing: false, isInitialLoading: false, progressPercent: 100, dataUpdatedAt: 0,
    });
    renderWith(member(USERS_PERMS), <UsersPage />);
    expect(screen.getByText(/ClickHouse error: boom/)).toBeInTheDocument();
    expect(screen.queryByText(/using legacy/)).not.toBeInTheDocument();
    expect(screen.queryByText("buyer@example.com")).not.toBeInTheDocument();
  });

  it("owner / legacy: a server error still falls back to the browser store (today)", () => {
    mocks.usersData.mockReturnValue({
      chUsers: null, chSummary: null, chOptions: null, chStatus: { loading: false, error: "boom" },
      isBackgroundRefreshing: false, isInitialLoading: false, progressPercent: 100, dataUpdatedAt: 0,
    });
    renderWith(LEGACY_OWNER(), <UsersPage />);
    expect(screen.getByText(/ClickHouse error — using legacy: boom/)).toBeInTheDocument();
    expect(screen.getByText("buyer@example.com")).toBeInTheDocument();
  });
});

// ---- Leads -------------------------------------------------------------------------------

describe("Leads sync", () => {
  it("owner / legacy: the manual sync buttons are there; nothing syncs on mount", async () => {
    renderWith(LEGACY_OWNER(), <LeadsPage />);
    expect(await screen.findByRole("button", { name: /Continue Sync/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Full Resync/ })).toBeInTheDocument();
    expect(mocks.runFunnelFoxLeadsSync).not.toHaveBeenCalled();
  });

  it("the data owner without admin.sync.run: no sync controls", async () => {
    renderWith(member(["leads.view"], { raw: true }), <LeadsPage />);
    await act(async () => {});
    expect(screen.getByText("FunnelFox Leads sync")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Continue Sync/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Full Resync/ })).not.toBeInTheDocument();
    expect(mocks.runFunnelFoxLeadsSync).not.toHaveBeenCalled();
  });
});

// ---- Support -----------------------------------------------------------------------------

function supportRow(overrides: Partial<SupportRequestSummaryRow> = {}): SupportRequestSummaryRow {
  return {
    id: "req_1",
    import_batch_id: "batch_1",
    source_row_number: 2,
    sender_name: "Refund User",
    subject: "Refund please",
    received_at: "2026-06-30T00:00:00.000Z",
    received_date_raw: "30 Jun",
    customer_email: "refund@example.com",
    normalized_email: "refund@example.com",
    matched_contact_name: "Refund User",
    funnel: "Soulmate",
    campaign_path: "soulmate/main",
    cohort_date: "2026-06-01",
    attribution_status: "matched",
    category: "Refund",
    subcategory: "refund_request",
    language: "en",
    sentiment: "neutral",
    urgency: "medium",
    requires_refund: true,
    requires_cancellation: false,
    payment_related: true,
    delivery_related: false,
    possible_unauthorized_charge: false,
    duplicate_charge: false,
    urgent: false,
    matched_customer: true,
    secondary_categories: [],
    classification_source: "rule",
    classification_model: null,
    classification_confidence: 0.92,
    classification_reason: "Matched refund_request keywords.",
    manual_category: null,
    manual_subcategory: null,
    manual_urgency: null,
    manual_changed_at: null,
    answered: true,
    answered_at: "2026-06-30T02:00:00.000Z",
    answer_source: "thread",
    reply_count: 1,
    first_response_minutes: 120,
    imported_at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  } as SupportRequestSummaryRow;
}

function supportResult(rows: SupportRequestSummaryRow[], error: string | null = null) {
  return {
    bundle: null,
    page: {
      ok: true,
      source: "clickhouse",
      generated_at: "2026-07-13T00:00:00.000Z",
      query_duration_ms: 5,
      pagination: { page: 1, page_size: 50, total_rows: rows.length, total_pages: 1 },
      rows,
    },
    status: { loading: false, error },
    isBackgroundRefreshing: false,
    isInitialLoading: false,
    progressPercent: 100,
    dataUpdatedAt: 0,
  };
}

describe("Support page access", () => {
  beforeEach(() => {
    mocks.supportData.mockReturnValue(supportResult([supportRow()]));
    mocks.loadSupportDetails.mockImplementation(async () => ({
      ok: true,
      source: "clickhouse",
      generated_at: "2026-07-13T00:00:00.000Z",
      query_duration_ms: 5,
      row: { ...supportRow(), message_body: "Please refund me.", automatic_category: "Refund", automatic_subcategory: "refund_request" },
    }));
  });

  it("owner / legacy: sync status and classification status load on mount, every section shows", async () => {
    renderWith(LEGACY_OWNER(), <SupportPage />);
    await waitFor(() => expect(mocks.getSupportMailStatus).toHaveBeenCalled());
    expect(mocks.runSupportClassification).toHaveBeenCalledWith("status");
    expect(mocks.listSupportImportBatches).toHaveBeenCalled();
    expect(screen.getByText("SpaceMail Support Sync")).toBeInTheDocument();
    expect(screen.getByText("Classification")).toBeInTheDocument();
    expect(screen.getByText("Support Requests Import")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Выгрузить XLSX/ })).toBeInTheDocument();
    expect(screen.getByText("refund@example.com")).toBeInTheDocument();
  });

  it("support.view only: no admin calls on mount, no messages, no search, no exports", async () => {
    localStorage.setItem("ui_state_support_analytics", JSON.stringify({ search: "refund@", importBatchId: "batch_1" }));
    renderWith(member(["support.view"]), <SupportPage />);
    await act(async () => {});

    expect(mocks.getSupportMailStatus).not.toHaveBeenCalled();
    expect(mocks.runSupportClassification).not.toHaveBeenCalled();
    expect(mocks.listSupportImportBatches).not.toHaveBeenCalled();
    expect(screen.queryByText("SpaceMail Support Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Support Requests Import")).not.toBeInTheDocument();
    expect(screen.queryByText("Search")).not.toBeInTheDocument();
    expect(screen.queryByText("Import batch")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Выгрузить XLSX/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /E-mail без ответа/ })).not.toBeInTheDocument();
    expect(screen.queryByText("refund@example.com")).not.toBeInTheDocument();
    expect(screen.getByText(/Individual requests \(senders, addresses and message text\) are not included in your role/)).toBeInTheDocument();
    // A persisted search term (a content oracle) and the hidden batch filter never reach the server.
    for (const [args] of mocks.supportData.mock.calls) {
      expect(args.query.filters.search).toBe("");
      expect(args.query.filters.importBatchId).toBe("");
    }
  });

  it("support.view only: the request list is never requested (listEnabled false)", () => {
    renderWith(member(["support.view"]), <SupportPage />);
    expect(mocks.supportData.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of mocks.supportData.mock.calls) expect(args.listEnabled).toBe(false);
  });

  it("support.messages.view: the request list loads next to the bundle", () => {
    renderWith(member(["support.view", "support.messages.view"]), <SupportPage />);
    for (const [args] of mocks.supportData.mock.calls) expect(args.listEnabled).toBe(true);
  });

  it("messages + export without admin.sync.run or raw access: rows and exports, no admin sections, read-only dialog", async () => {
    renderWith(member(["support.view", "support.messages.view", "support.export", "support.classification.edit"]), <SupportPage />);
    await act(async () => {});

    expect(mocks.getSupportMailStatus).not.toHaveBeenCalled();
    expect(mocks.runSupportClassification).not.toHaveBeenCalled();
    expect(screen.queryByText("SpaceMail Support Sync")).not.toBeInTheDocument();
    expect(screen.queryByText("Support Requests Import")).not.toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Выгрузить XLSX/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /E-mail без ответа/ })).toBeInTheDocument();

    fireEvent.click(screen.getByText("refund@example.com"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Please refund me.")).toBeInTheDocument();
    // Corrections write support_requests through PostgREST: data owner only in Phase 1.
    expect(within(dialog).queryByRole("button", { name: /Save correction/ })).not.toBeInTheDocument();
    expect(mocks.getAnsweredReplyForRequest).not.toHaveBeenCalled();
  });
});

// ---- Integrations --------------------------------------------------------------------------

describe("Integrations controls", () => {
  it("owner / legacy: every control, the API keys and the owner-data panels", async () => {
    renderWith(LEGACY_OWNER(), <IntegrationsPage />);
    await waitFor(() => expect(mocks.listApiKeys).toHaveBeenCalled());
    expect(mocks.getCapsuledStatus).toHaveBeenCalled();
    for (const name of ["Initialize Schema", "Run Controlled Backfill", "Continue Backfill", "Run Full Backfill", "Start Validation", "Reset Validation", "Repair Legacy Payloads", "Repair Zero-Decimal Amounts", "Sync", "Force Resync", "Create key"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.getByText("export api health panel")).toBeInTheDocument();
    expect(screen.getByText("campaign split panel")).toBeInTheDocument();
  });

  it("admin.integrations.view only: connection test and status, nothing that writes or reads owner rows", async () => {
    renderWith(member(["admin.integrations.view"]), <IntegrationsPage />);
    await waitFor(() => expect(mocks.getClickHouseSummary).toHaveBeenCalled());
    expect(mocks.listApiKeys).not.toHaveBeenCalled();
    expect(mocks.listApiExportLogs).not.toHaveBeenCalled();
    expect(mocks.getCapsuledStatus).not.toHaveBeenCalled();
    expect(mocks.listCapsuledRows).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh Status" })).toBeInTheDocument();
    for (const name of ["Initialize Schema", "Run Controlled Backfill", "Continue Backfill", "Start Validation", "Repair Legacy Payloads", "Sync", "Force Resync", "Create key"]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByText("Capsuled Facebook")).not.toBeInTheDocument();
    expect(screen.queryByText("API Keys")).not.toBeInTheDocument();
    expect(screen.queryByText("export api health panel")).not.toBeInTheDocument();
    expect(screen.queryByText("campaign split panel")).not.toBeInTheDocument();
  });

  it("warehouse + sync admin (not the owner): backfill, validation and Capsuled sync; no init, repairs or keys", async () => {
    renderWith(member(["admin.integrations.view", "admin.warehouse.manage", "admin.sync.run", "admin.api_keys.manage"]), <IntegrationsPage />);
    await waitFor(() => expect(mocks.getClickHouseSummary).toHaveBeenCalled());
    for (const name of ["Run Controlled Backfill", "Continue Backfill", "Run Full Backfill", "Start Validation", "Continue Validation", "Reset Validation", "Sync", "Force Resync"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "Initialize Schema" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Repair Legacy Payloads" })).not.toBeInTheDocument();
    // API keys are minted through PostgREST under the caller in Phase 1: data owner only.
    expect(screen.queryByRole("button", { name: "Create key" })).not.toBeInTheDocument();
    expect(mocks.listApiKeys).not.toHaveBeenCalled();
  });

  it("schema init is Owner-role + data owner: the data owner on an Admin role does not get it", async () => {
    renderWith(member(["admin.integrations.view", "admin.warehouse.manage"], { raw: true }), <IntegrationsPage />);
    await waitFor(() => expect(mocks.getClickHouseSummary).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Initialize Schema" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair Legacy Payloads" })).toBeInTheDocument();
  });

  it("schema init shows for the Owner role with raw access", async () => {
    renderWith(member([], { raw: true, owner: true }), <IntegrationsPage />);
    await waitFor(() => expect(mocks.listApiKeys).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Initialize Schema" })).toBeInTheDocument();
  });
});

// ---- Import --------------------------------------------------------------------------------

describe("Import page", () => {
  it("owner / legacy: the FunnelFox sync section and its state read on mount", async () => {
    renderWith(LEGACY_OWNER(), <ImportPage />);
    await waitFor(() => expect(mocks.getFfSyncState).toHaveBeenCalled());
    expect(screen.getByText("FunnelFox Subscriptions Sync")).toBeInTheDocument();
  });

  it("data owner without admin.sync.run: imports stay, the FunnelFox sync and its state read do not", async () => {
    renderWith(member(["admin.data.import"], { raw: true }), <ImportPage />);
    await act(async () => {});
    expect(screen.getByText("Palmer Transactions Import")).toBeInTheDocument();
    expect(screen.queryByText("FunnelFox Subscriptions Sync")).not.toBeInTheDocument();
    expect(mocks.getFfSyncState).not.toHaveBeenCalled();
  });
});

// ---- AI drawer -----------------------------------------------------------------------------

const PACK = { engineVersion: "test", asOfDate: "2026-07-01", items: [], inputStatusLines: [] };
const contextA: AiAssistantContext = { surface: "cohort", label: "Cohorts · 3 cohorts", contextPack: PACK };
// Same page (surface), new label: a refresh / filter change moved the row count.
const contextA2: AiAssistantContext = { surface: "cohort", label: "Cohorts · 1 cohorts · 2026-06-01 — …", contextPack: PACK };
// Another page.
const contextB: AiAssistantContext = { surface: "campaign", label: "FB Analytics · 18 campaigns", contextPack: PACK };

function okAnswer(conclusion: string) {
  return {
    kind: "ok" as const,
    answer: { conclusion, sections: [], cautions: [] },
    violations: [],
    model: "test-model",
    runId: "run-1",
    usage: { inputTokens: 1, outputTokens: 1, durationMs: 1 },
  };
}

async function askInDrawer(text: string) {
  const input = await screen.findByPlaceholderText("Ask about your data…");
  fireEvent.change(input, { target: { value: text } });
  fireEvent.submit(input.closest("form") as HTMLFormElement);
}

describe("AI assistant drawer", () => {
  it("without ai.use: renders nothing and closes a drawer something else opened", async () => {
    useAiAssistantStore.setState({ open: true, context: contextA });
    renderWith(member(["cohorts.view"]), <AiAssistantDrawer />);
    await waitFor(() => expect(useAiAssistantStore.getState().open).toBe(false));
    expect(screen.queryByText("AI Assistant")).not.toBeInTheDocument();
  });

  it("with ai.use: answers, and clears the exchanges when the page (surface) changes", async () => {
    mocks.askAssistant.mockResolvedValue(okAnswer("Scale the soulmate cohort."));
    useAiAssistantStore.setState({ open: true, context: contextA });
    renderWith(member(["ai.use"]), <AiAssistantDrawer />);

    await askInDrawer("Which cohort is strongest?");
    expect(await screen.findByText("Scale the soulmate cohort.")).toBeInTheDocument();

    act(() => useAiAssistantStore.getState().publishContext(contextB));
    await waitFor(() => expect(screen.queryByText("Scale the soulmate cohort.")).not.toBeInTheDocument());
    expect(screen.queryByText("Which cohort is strongest?")).not.toBeInTheDocument();
  });

  it("a label change on the same page (row count after a refresh) keeps the conversation, and a page unmount (null) too", async () => {
    mocks.askAssistant.mockResolvedValue(okAnswer("Scale the soulmate cohort."));
    useAiAssistantStore.setState({ open: true, context: contextA });
    renderWith(member(["ai.use"]), <AiAssistantDrawer />);
    await askInDrawer("Which cohort is strongest?");
    expect(await screen.findByText("Scale the soulmate cohort.")).toBeInTheDocument();

    act(() => useAiAssistantStore.getState().publishContext(contextA2));
    act(() => useAiAssistantStore.getState().publishContext(null));
    act(() => useAiAssistantStore.getState().publishContext(contextA));
    expect(screen.getByText("Scale the soulmate cohort.")).toBeInTheDocument();
    expect(screen.getByText("Which cohort is strongest?")).toBeInTheDocument();
  });

  it("an answer in flight while the same page's label changes still lands", async () => {
    let resolve: (value: ReturnType<typeof okAnswer>) => void = () => {};
    mocks.askAssistant.mockImplementation(() => new Promise((done) => { resolve = done; }));
    useAiAssistantStore.setState({ open: true, context: contextA });
    renderWith(member(["ai.use"]), <AiAssistantDrawer />);

    await askInDrawer("Which cohort is strongest?");
    expect(await screen.findByText("Analyzing the current context…")).toBeInTheDocument();
    act(() => useAiAssistantStore.getState().publishContext(contextA2));
    await act(async () => resolve(okAnswer("Answer that was already paid for.")));
    expect(await screen.findByText("Answer that was already paid for.")).toBeInTheDocument();
  });

  it("a row's Ask AI (same context plus a seed question) keeps the conversation", async () => {
    mocks.askAssistant.mockResolvedValue(okAnswer("Scale the soulmate cohort."));
    useAiAssistantStore.setState({ open: true, context: contextA });
    renderWith(member(["ai.use"]), <AiAssistantDrawer />);
    await askInDrawer("Which cohort is strongest?");
    expect(await screen.findByText("Scale the soulmate cohort.")).toBeInTheDocument();

    act(() => useAiAssistantStore.getState().openWith({ ...contextA, seedQuestion: "Why scale?" }));
    expect(screen.getByText("Scale the soulmate cohort.")).toBeInTheDocument();
  });

  it("an answer that lands after the context changed is dropped", async () => {
    let resolve: (value: ReturnType<typeof okAnswer>) => void = () => {};
    mocks.askAssistant.mockImplementation(() => new Promise((done) => { resolve = done; }));
    useAiAssistantStore.setState({ open: true, context: contextA });
    renderWith(member(["ai.use"]), <AiAssistantDrawer />);

    await askInDrawer("Which cohort is strongest?");
    expect(await screen.findByText("Analyzing the current context…")).toBeInTheDocument();
    act(() => useAiAssistantStore.getState().publishContext(contextB));
    await waitFor(() => expect(screen.queryByText("Analyzing the current context…")).not.toBeInTheDocument());

    await act(async () => resolve(okAnswer("Stale answer about context A.")));
    expect(screen.queryByText("Stale answer about context A.")).not.toBeInTheDocument();
    // Not stuck busy: the next question can be asked in the new context.
    expect(screen.getByPlaceholderText("Ask about your data…")).not.toBeDisabled();
  });

  it("a principal / access change (new partition) clears the exchanges", async () => {
    mocks.askAssistant.mockResolvedValue(okAnswer("Scale the soulmate cohort."));
    useAiAssistantStore.setState({ open: true, context: contextA });
    const client = new QueryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <AccessContext.Provider value={member(["ai.use"], { partition: "p-1" })}><AiAssistantDrawer /></AccessContext.Provider>
      </QueryClientProvider>,
    );
    await askInDrawer("Which cohort is strongest?");
    expect(await screen.findByText("Scale the soulmate cohort.")).toBeInTheDocument();

    view.rerender(
      <QueryClientProvider client={client}>
        <AccessContext.Provider value={member(["ai.use"], { partition: "p-2" })}><AiAssistantDrawer /></AccessContext.Provider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText("Scale the soulmate cohort.")).not.toBeInTheDocument());
  });

  it("the session purge drops the published context and closes the drawer", async () => {
    expect(registeredPurgeHandlers()).toContain("ai-assistant");
    useAiAssistantStore.setState({ open: true, context: contextA });
    await runPurge("signed_out");
    expect(useAiAssistantStore.getState()).toMatchObject({ open: false, context: null });
  });
});

// ---- AI analysis panel ---------------------------------------------------------------------

const REC: AiRecommendation = {
  action: "SCALE",
  budgetDeltaPct: 10,
  scope: { kind: "path", campaignPath: "soulmate-reading" },
  surface: "cohort",
  ruleId: "test_rule",
  claim: "Strong cohort.",
  because: [],
  primaryDomain: "conversion",
  contradictions: [],
  monitorAfter: [],
  dataNotes: [],
  signals: [],
  confidence: "high",
  confidenceScore: 0.9,
} as unknown as AiRecommendation;

describe("AI analysis panel", () => {
  beforeEach(() => {
    mocks.loadAiActionHistory.mockResolvedValue([]);
    useAiAssistantStore.setState({ open: false, context: contextA });
  });

  it("with ai.use and ai.history.view: Ask AI, feedback and the verdict history", async () => {
    renderWith(member(["ai.use", "ai.history.view"]), <AiAnalysisPanel rec={REC} history={{ surface: "cohort", contextHash: "ctx-1" }} />);
    expect(screen.getByRole("button", { name: /Ask AI about this/ })).toBeInTheDocument();
    expect(screen.getByText("Was this useful?")).toBeInTheDocument();
    await waitFor(() => expect(mocks.loadAiActionHistory).toHaveBeenCalled());
  });

  it("ai.use without ai.history.view: no history read", async () => {
    renderWith(member(["ai.use"]), <AiAnalysisPanel rec={REC} history={{ surface: "cohort", contextHash: "ctx-1" }} />);
    expect(screen.getByRole("button", { name: /Ask AI about this/ })).toBeInTheDocument();
    await act(async () => {});
    expect(mocks.loadAiActionHistory).not.toHaveBeenCalled();
  });

  it("without ai.use: no Ask AI and no feedback", async () => {
    renderWith(member(["cohorts.view"]), <AiAnalysisPanel rec={REC} history={{ surface: "cohort", contextHash: "ctx-1" }} />);
    expect(screen.queryByRole("button", { name: /Ask AI about this/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Was this useful?")).not.toBeInTheDocument();
    await act(async () => {});
    expect(mocks.loadAiActionHistory).not.toHaveBeenCalled();
  });
});
