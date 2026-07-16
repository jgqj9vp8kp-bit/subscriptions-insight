import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SupportPage from "@/pages/Support";
import type {
  SupportImportBatch,
  SupportParseResult,
  SupportRequestDetailRow,
  SupportRequestSummaryRow,
} from "@/services/supportAnalytics";
import type {
  SupportAnalyticsBundle,
  SupportListResponse,
  SupportSyncResult,
} from "@/services/supportDataSource";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {description && <p>{description}</p>}
      <div>{actions}</div>
      {children}
    </div>
  ),
}));

vi.mock("recharts", () => ({
  Bar: () => null,
  BarChart: ({ children }: { children?: ReactNode }) => <div data-testid="bar-chart">{children}</div>,
  CartesianGrid: () => null,
  Cell: () => null,
  Legend: () => null,
  Line: () => null,
  LineChart: ({ children }: { children?: ReactNode }) => <div data-testid="line-chart">{children}</div>,
  Pie: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  PieChart: ({ children }: { children?: ReactNode }) => <div data-testid="pie-chart">{children}</div>,
  ResponsiveContainer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user_1" } }) }));
vi.mock("@/hooks/useAnalyticsCache", () => ({
  useSupportWarehouseVersion: () => ({ version: "whv_support", ready: true }),
  invalidateSupportAnalyticsCache: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/hooks/useSupportCache", () => ({ useSupportData: vi.fn() }));
vi.mock("@/services/supportDataSource", () => ({
  EMPTY_CAMPAIGN_PATH: "—",
  loadSupportDetails: vi.fn(),
  syncSupportToClickHouse: vi.fn(),
}));
vi.mock("@/services/supportInbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/supportInbox")>();
  return { ...actual, getSupportMailStatus: vi.fn(), syncSupportMail: vi.fn() };
});
vi.mock("@/services/supportAnalytics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/supportAnalytics")>();
  return {
    ...actual,
    importSupportFile: vi.fn(),
    listSupportImportBatches: vi.fn(),
    parseSupportFile: vi.fn(),
    resetSupportRequestManualClassification: vi.fn(),
    updateSupportRequestManualClassification: vi.fn(),
  };
});

import { useSupportData } from "@/hooks/useSupportCache";
import { loadSupportDetails, syncSupportToClickHouse } from "@/services/supportDataSource";
import { getSupportMailStatus, syncSupportMail } from "@/services/supportInbox";
import {
  importSupportFile,
  listSupportImportBatches,
  parseSupportFile,
  resetSupportRequestManualClassification,
  updateSupportRequestManualClassification,
} from "@/services/supportAnalytics";

function supportRow(overrides: Partial<SupportRequestSummaryRow> = {}): SupportRequestSummaryRow {
  return {
    id: "req_1",
    import_batch_id: "batch_1",
    source_row_number: 2,
    sender_name: "Refund User",
    subject: "Refund please",
    received_at: "2026-06-30T00:00:00.000Z",
    received_date_raw: "30 июн",
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
    classification_confidence: 0.92,
    classification_reason: "Matched refund_request keywords.",
    manual_category: null,
    manual_subcategory: null,
    manual_urgency: null,
    manual_changed_at: null,
    imported_at: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

const rows = [
  supportRow(),
  supportRow({
    id: "req_2",
    source_row_number: 3,
    sender_name: "Cancel User",
    subject: "Cancel my plan",
    customer_email: "cancel@example.com",
    normalized_email: "cancel@example.com",
    matched_contact_name: null,
    funnel: "Unknown",
    campaign_path: null,
    cohort_date: null,
    attribution_status: "unmatched_email",
    category: "Cancellation",
    subcategory: "cancel_subscription",
    language: "es",
    urgency: "high",
    requires_refund: false,
    requires_cancellation: true,
    matched_customer: false,
  }),
];

const batches: SupportImportBatch[] = [{
  id: "batch_1",
  filename: "support.xlsx",
  checksum: "h123",
  imported_at: "2026-07-13T00:00:00.000Z",
  import_year: 2026,
  total_rows: 2,
  inserted_rows: 2,
  updated_rows: 0,
  skipped_rows: 0,
  invalid_rows: 0,
  status: "completed",
  diagnostics: {},
}];

const previewRows = rows.map((row) => ({
  source_row_number: row.source_row_number,
  sender_name: row.sender_name ?? "",
  subject: row.subject ?? "",
  message_body: "Message body",
  received_date_raw: row.received_date_raw ?? "",
  customer_email: row.customer_email ?? "",
  matched_contact_name: row.matched_contact_name ?? "",
  category: row.category,
  subcategory: row.subcategory,
  language: row.language,
  sentiment: row.sentiment,
  urgency: row.urgency,
  requires_refund: row.requires_refund,
  requires_cancellation: row.requires_cancellation,
  payment_related: row.payment_related,
  delivery_related: row.delivery_related,
  possible_unauthorized_charge: row.possible_unauthorized_charge,
  duplicate_charge: row.duplicate_charge,
  urgent: row.urgent,
  classification_source: "rule" as const,
  classification_version: "support_rules_v1" as const,
  classification_confidence: row.classification_confidence,
  classification_reason: row.classification_reason ?? "",
  received_at: row.received_at,
  normalized_email: row.normalized_email,
  matched_customer: row.matched_customer,
  source_hash: `hash_${row.id}`,
}));

const preview: SupportParseResult = {
  rows: previewRows,
  invalidRows: [],
  diagnostics: {
    total_rows: 2,
    valid_rows: 2,
    invalid_rows: 0,
    invalid_date_rows: 0,
    missing_subject_rows: 0,
    missing_body_rows: 0,
    assumed_year_rows: 2,
    detected_headers: ["data", "data2", "data3", "data5", "email", "matched_contact_name"],
    missing_headers: [],
    sheet_name: "Unified data",
    sheet_names: ["Unified data"],
    import_year: 2026,
    warnings: [],
  },
  sample: previewRows,
};

function filteredRows(search?: string, funnels: string[] = [], campaignPaths: string[] = []): SupportRequestSummaryRow[] {
  const query = String(search ?? "").toLowerCase();
  return rows.filter((row) => {
    const matchesSearch = !query || [row.sender_name, row.customer_email, row.subject].some((value) => String(value ?? "").toLowerCase().includes(query));
    const campaignPath = row.campaign_path || "—";
    return matchesSearch
      && (!funnels.length || funnels.includes(row.funnel))
      && (!campaignPaths.length || campaignPaths.includes(campaignPath));
  });
}

function chRow(row: SupportRequestSummaryRow) {
  return {
    ...row,
    automatic_category: row.category,
    automatic_subcategory: row.subcategory,
  };
}

function bundleFor(pageRows: SupportRequestSummaryRow[]): SupportAnalyticsBundle {
  const matched = pageRows.filter((row) => row.matched_customer).length;
  return {
    ok: true,
    source: "clickhouse",
    generated_at: "2026-07-13T00:00:00.000Z",
    query_duration_ms: 12,
    diagnostics: {
      rows_scanned: pageRows.length,
      payload_kind: "aggregate_only",
      browser_aggregation: false,
      requests_with_funnel: pageRows.filter((row) => row.funnel !== "Unknown").length,
      requests_without_funnel: pageRows.filter((row) => row.funnel === "Unknown").length,
      unique_matched_support_users: pageRows.filter((row) => row.attribution_status === "matched").length,
      unmatched_emails: pageRows.filter((row) => row.attribution_status === "unmatched_email").length,
      users_without_trial: 0,
      ambiguous: 0,
      attribution_version: "wh_1|cohort_v1",
      support_rate_denominator_available: true,
      support_rate_diagnostic: null,
    },
    filter_options: {
      funnels: [{ funnel: "Soulmate", requests: 1 }, { funnel: "Unknown", requests: 1 }],
      campaign_paths: [{ campaign_path: "soulmate/main", requests: 1 }, { campaign_path: "—", requests: 1 }],
      categories: [], subcategories: [], languages: [], urgencies: [], import_batches: [],
    },
    summary: {
      rows: [],
      kpis: {
        totalRequests: pageRows.length,
        uniqueSenders: pageRows.length,
        matchedCustomers: matched,
        unmatchedRequests: pageRows.length - matched,
        cancellationRequests: pageRows.filter((row) => row.requires_cancellation || row.category === "Cancellation").length,
        refundRequests: pageRows.filter((row) => row.requires_refund || row.category === "Refund").length,
        unauthorizedChargeRequests: pageRows.filter((row) => row.possible_unauthorized_charge).length,
        productNotReceivedRequests: 0,
        paymentIssues: 0,
        highPriorityRequests: pageRows.filter((row) => row.urgency === "high").length,
        requestsPerDay: pageRows.length,
        matchedPct: 50,
        cancellationPct: 50,
        refundPct: 50,
        paymentRelatedPct: 50,
      },
      byDay: [{ date: "2026-06-30", requests: pageRows.length }],
      funnelTrend: pageRows.map((row) => ({ date: "2026-06-30", funnel: row.funnel, requests: 1 })),
      categoryTrend: pageRows.map((row) => ({ date: "2026-06-30", category: row.category, requests: 1 })),
      operationalTrend: [{ date: "2026-06-30", cancellation: 1, refund: 1, charge: 0 }],
      languageDistribution: [{ language: "en", requests: 1 }],
      matchDistribution: [{ status: "matched", requests: matched }, { status: "unmatched", requests: pageRows.length - matched }],
      priorityDistribution: [{ urgency: "medium", requests: 1 }, { urgency: "high", requests: 1 }],
      categoryRanking: pageRows.map((row) => ({
        category: row.category,
        requests: 1,
        share: 50,
        uniqueSenders: 1,
        matchedCustomers: row.matched_customer ? 1 : 0,
        highPriority: row.urgency === "high" ? 1 : 0,
        latestRequest: row.received_at,
        trendVsPrevious: null,
      })),
      subcategoryRanking: pageRows.map((row) => ({ subcategory: row.subcategory, requests: 1, share: 50 })),
      funnelRanking: pageRows.map((row) => ({
        funnel: row.funnel,
        requests: 1,
        uniqueSupportUsers: row.attribution_status === "matched" ? 1 : 0,
        share: pageRows.length ? 100 / pageRows.length : 0,
        cancellationRequests: row.requires_cancellation ? 1 : 0,
        refundRequests: row.requires_refund ? 1 : 0,
        unauthorizedChargeRequests: row.possible_unauthorized_charge ? 1 : 0,
        highPriority: row.urgency === "high" ? 1 : 0,
        matchedUsers: row.attribution_status === "matched" ? 1 : 0,
        latestRequest: row.received_at,
        trialUsers: row.funnel === "Unknown" ? null : 10,
        supportRate: row.funnel === "Unknown" ? null : 10,
      })),
      campaignPathRanking: pageRows.map((row) => ({
        campaignPath: row.campaign_path || "—",
        requests: 1,
        uniqueSupportUsers: row.attribution_status === "matched" ? 1 : 0,
        cancellationRequests: row.requires_cancellation ? 1 : 0,
        refundRequests: row.requires_refund ? 1 : 0,
        highPriority: row.urgency === "high" ? 1 : 0,
        latestRequest: row.received_at,
        trialUsers: row.campaign_path ? 10 : null,
        supportRate: row.campaign_path ? 10 : null,
      })),
      matching: {
        matchedByEmail: pageRows.filter((row) => row.normalized_email).length,
        matchedByName: 0,
        unmatched: pageRows.length - matched,
        emailPresentNoMatchedContact: 0,
        matchedContactNoEmail: 0,
        duplicateNormalizedEmails: 0,
        multipleSenderNamesForOneEmail: 0,
      },
      insights: ["Most common reason: Refund (1 requests)."],
    },
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SupportPage />
    </QueryClientProvider>,
  );
}

const syncResult: SupportSyncResult = {
  ok: true,
  source: "clickhouse",
  action: "sync",
  status: "completed",
  stopped_reason: "completed",
  rows_scanned: 2,
  rows_mapped: 2,
  rows_inserted: 2,
  rows_skipped: 0,
  batches_processed: 1,
  cursor_updated_at: "2026-07-13T00:00:00.000Z",
  cursor_request_id: "req_2",
  source_total: 2,
  clickhouse_total: 2,
  duration_ms: 10,
  diagnostics: {},
};

describe("Support page", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Element.prototype.scrollIntoView = vi.fn();
    vi.mocked(useSupportData).mockImplementation(({ query }) => {
      const pageRows = filteredRows(query.filters.search, query.filters.funnel, query.filters.campaignPath);
      const list: SupportListResponse = {
        ok: true,
        source: "clickhouse",
        generated_at: "2026-07-13T00:00:00.000Z",
        query_duration_ms: 8,
        pagination: { page: query.page, page_size: query.pageSize, total_rows: pageRows.length, total_pages: 1 },
        rows: pageRows.map(chRow) as never,
      };
      return {
        bundle: bundleFor(pageRows),
        page: list,
        status: { loading: false, error: null },
        isBackgroundRefreshing: false,
        isInitialLoading: false,
        progressPercent: 100,
        dataUpdatedAt: Date.now(),
      };
    });
    vi.mocked(listSupportImportBatches).mockResolvedValue(batches);
    vi.mocked(loadSupportDetails).mockImplementation((id) => {
      const row = rows.find((candidate) => candidate.id === id) ?? rows[0];
      return Promise.resolve({
        ok: true,
        source: "clickhouse",
        generated_at: "2026-07-13T00:00:00.000Z",
        query_duration_ms: 5,
        row: { ...chRow(row), message_body: `${row.subject} body text.` } as SupportRequestDetailRow & { automatic_category: string; automatic_subcategory: string },
      });
    });
    vi.mocked(parseSupportFile).mockResolvedValue(preview);
    vi.mocked(importSupportFile).mockResolvedValue({
      batch_id: "batch_2",
      filename: "support.csv",
      import_year: 2026,
      total_rows: 2,
      inserted_rows: 2,
      updated_rows: 0,
      skipped_rows: 0,
      invalid_rows: 0,
      invalid_date_rows: 0,
      matched_rows: 1,
      unmatched_rows: 1,
      date_range: { from: "2026-06-30", to: "2026-06-30" },
      category_distribution: [{ category: "Other/unclear", count: 2 }],
      language_distribution: [{ language: "unknown", count: 2 }],
      diagnostics: preview.diagnostics,
    });
    vi.mocked(syncSupportToClickHouse).mockResolvedValue(syncResult);
    vi.mocked(syncSupportMail).mockResolvedValue({
      ok: true,
      action: "sync_new",
      provider: "spacemail",
      mailbox: "support@azora-astro.com",
      folder: "INBOX",
	      status: "completed",
	      connection: "unknown",
	      mailbox_messages: 499,
	      history_total_messages: 499,
	      history_imported_messages: 499,
	      history_remaining_messages: 0,
	      history_completed_at: "2026-07-13T00:00:00.000Z",
	      last_sync_new_messages: 0,
	      last_sync_imported: 0,
	      synced: 2,
      inserted: 1,
      updated: 1,
      skipped: 0,
      matched_users: 1,
      unmatched: 1,
      latest_received_at: "2026-06-30T00:00:00.000Z",
    });
    vi.mocked(getSupportMailStatus).mockResolvedValue({
      ok: true,
      action: "status",
      provider: "spacemail",
      mailbox: "support@azora-astro.com",
      folder: "INBOX",
      status: "idle",
      connection: "unknown",
	      config: { host: true, port: true, secure: true, username: true, password: true },
	      state: {
	        status: "idle",
	        last_seen_uid: 500,
	        last_imported_uid: 500,
	        mailbox_messages: 499,
	        mailbox_uid_next: 501,
	        history_first_uid: 1,
	        history_last_uid: 500,
	        history_total_messages: 499,
	        history_imported_messages: 499,
	        history_remaining_messages: 0,
	        history_completed_at: "2026-07-13T00:00:00.000Z",
	        current_batch: 10,
	        current_batch_total: 10,
	        messages_processed: 499,
	        messages_inserted: 0,
	        messages_skipped: 0,
	        messages_failed: 0,
	        last_sync_new_messages: 0,
	        last_sync_imported: 0,
	      },
      synced: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      matched_users: 0,
      unmatched: 0,
      latest_received_at: null,
    });
    vi.mocked(updateSupportRequestManualClassification).mockResolvedValue();
    vi.mocked(resetSupportRequestManualClassification).mockResolvedValue();
  });

  it("renders support analytics KPIs, import controls, and request rows from ClickHouse data", async () => {
    renderPage();

    expect(await screen.findByText("Support Inbox")).toBeInTheDocument();
    expect(screen.getByText("Support requests, spreadsheet imports, matching quality, and customer issue analytics.")).toBeInTheDocument();
    expect(screen.getByText("Support Requests Import")).toBeInTheDocument();
    expect(screen.getByText("Total Requests")).toBeInTheDocument();
    expect(screen.getByText("Cancellation Requests")).toBeInTheDocument();
    expect(screen.getByText("Refund Requests")).toBeInTheDocument();
    expect(screen.getByText("Support by Funnel")).toBeInTheDocument();
    expect(screen.getByText("Support by Campaign Path")).toBeInTheDocument();
    expect(screen.getAllByText("Soulmate").length).toBeGreaterThan(0);
    expect(screen.getAllByText("soulmate/main").length).toBeGreaterThan(0);
    expect(screen.getByText("refund@example.com")).toBeInTheDocument();
    expect(screen.getByText("cancel@example.com")).toBeInTheDocument();
  });

  it("filters and sorts Funnel through the server query contract", async () => {
    renderPage();
    await screen.findByText("refund@example.com");

    const funnelLabel = screen.getByText("Funnel", { selector: "label" });
    const funnelTrigger = funnelLabel.parentElement?.querySelector('[role="combobox"]');
    expect(funnelTrigger).not.toBeNull();
    fireEvent.click(funnelTrigger!);
    fireEvent.click(await screen.findByRole("option", { name: /Unknown \(1\)/ }));

    await waitFor(() => expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ filters: expect.objectContaining({ funnel: ["Unknown"] }) }),
    })));
    expect(screen.getByText("cancel@example.com")).toBeInTheDocument();
    expect(screen.queryByText("refund@example.com")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Funnel$/ }));
    await waitFor(() => expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ sortBy: "funnel", sortDir: "asc" }),
    })));
  });

  it("filters and sorts Campaign Path through the server query contract", async () => {
    renderPage();
    await screen.findByText("refund@example.com");

    const campaignPathLabel = screen.getByText("Campaign Path", { selector: "label" });
    const campaignPathTrigger = campaignPathLabel.parentElement?.querySelector('[role="combobox"]');
    expect(campaignPathTrigger).not.toBeNull();
    fireEvent.click(campaignPathTrigger!);
    fireEvent.click(await screen.findByRole("option", { name: /— \(1\)/ }));

    await waitFor(() => expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ filters: expect.objectContaining({ campaignPath: ["—"] }) }),
    })));
    expect(screen.getByText("cancel@example.com")).toBeInTheDocument();
    expect(screen.queryByText("refund@example.com")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Campaign Path$/ }));
    await waitFor(() => expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ sortBy: "campaign_path", sortDir: "asc" }),
    })));
    fireEvent.click(screen.getByRole("button", { name: /^Campaign Path A→Z$/ }));
    await waitFor(() => expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ sortBy: "campaign_path", sortDir: "desc" }),
    })));
  });

  it("restores Campaign Path from persisted Support filters", async () => {
    localStorage.setItem("ui_state_support_analytics", JSON.stringify({ campaignPath: ["soulmate/main"] }));
    renderPage();

    await waitFor(() => expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ filters: expect.objectContaining({ campaignPath: ["soulmate/main"] }) }),
    })));
    expect(await screen.findByText("refund@example.com")).toBeInTheDocument();
    expect(screen.queryByText("cancel@example.com")).not.toBeInTheDocument();
  });

  it("filters the table by search text through the warehouse query", async () => {
    renderPage();
    await screen.findByText("refund@example.com");

    fireEvent.change(screen.getByPlaceholderText("Sender, email, subject, message"), { target: { value: "cancel" } });

    await waitFor(() => expect(screen.getByText("cancel@example.com")).toBeInTheDocument());
    expect(screen.queryByText("refund@example.com")).not.toBeInTheDocument();
    expect(useSupportData).toHaveBeenLastCalledWith(expect.objectContaining({
      query: expect.objectContaining({ filters: expect.objectContaining({ search: "cancel" }) }),
    }));
  });

  it("previews and imports a support spreadsheet, then automatically syncs ClickHouse", async () => {
    renderPage();
    await screen.findByText("Support Requests Import");

    const file = new File(["data,data2,data3,data5\nA,Refund,refund please,30 июн"], "support.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText("File"), { target: { files: [file] } });

    expect(await screen.findByText("Unified data")).toBeInTheDocument();
    expect(parseSupportFile).toHaveBeenCalledWith(file, expect.objectContaining({ importYear: expect.any(Number) }));

    fireEvent.click(screen.getByRole("button", { name: /import support file/i }));

    await waitFor(() => expect(importSupportFile).toHaveBeenCalledWith(file, expect.objectContaining({ importYear: expect.any(Number) })));
    await waitFor(() => expect(syncSupportToClickHouse).toHaveBeenCalledWith(false));
	    expect(syncSupportToClickHouse).toHaveBeenCalledWith(false);
  });

  it("opens a request detail dialog and syncs ClickHouse after manual correction", async () => {
    renderPage();
    const row = (await screen.findByText("Refund please")).closest("tr");
    expect(row).not.toBeNull();

    fireEvent.click(row!);

    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Message Body")).toBeInTheDocument();
    expect(await within(dialog).findByText("Refund please body text.")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: /save correction/i }));

    await waitFor(() => expect(updateSupportRequestManualClassification).toHaveBeenCalledWith("req_1", {
      category: "Refund",
      subcategory: "refund_request",
      urgency: "medium",
    }));
    expect(syncSupportToClickHouse).toHaveBeenCalledWith(false);
  });

  it("keeps the support mail sync action available", async () => {
    renderPage();
    await screen.findByText("refund@example.com");

    fireEvent.click(screen.getByRole("button", { name: /sync now/i }));

    await waitFor(() => expect(syncSupportMail).toHaveBeenCalledWith("sync_new", {}));
    expect(await screen.findByText("SpaceMail Support Sync")).toBeInTheDocument();
  });
});
