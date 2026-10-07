// Leads tab (server read path): rows, KPIs, options and pagination come from
// clickhouse-users leads_list / leads_overview (runClickHouseLeads); the panel
// never hydrates or scans the raw warehouse in the browser.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runClickHouseLeads: vi.fn(),
  requireRaw: vi.fn(),
  useTransactions: vi.fn(() => []),
}));

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The panel must not touch the browser warehouse any more: these spies stay at zero calls.
vi.mock("@/services/sheets", () => ({ useTransactions: mocks.useTransactions }));
vi.mock("@/services/transactionAutoLoadPolicy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/transactionAutoLoadPolicy")>();
  return { ...actual, useRequireRawTransactions: mocks.requireRaw };
});

// No Supabase here: the sync-state row read stays off; the leads bridge is mocked.
vi.mock("@/services/supabaseClient", () => ({ isSupabaseConfigured: false, supabase: null }));
vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/clickhouse")>();
  return { ...actual, runClickHouseLeads: mocks.runClickHouseLeads };
});

// The page reads useAccess(); these tests cover the data owner's view (legacy
// access: every permission, raw access on — exactly today's behaviour).
vi.mock("@/hooks/useAccess", async () => {
  const { buildAccessValue } = await import("@/contexts/accessContext");
  const owner = buildAccessValue({ status: "legacy", access: null, userId: "test-user" });
  return { useAccess: () => owner, useOptionalAccess: () => owner, useCan: (key: string) => owner.can(key) };
});

import LeadsPage, { formatLeadDateTime } from "@/pages/Leads";
import type {
  LeadRow,
  LeadsListResponse,
  LeadsOverviewResponse,
  LeadsRequest,
  LeadsSummary,
} from "../../supabase/functions/_shared/clickhouse/leadsContract";

function leadRow(overrides: Partial<LeadRow> = {}): LeadRow {
  return {
    key: "w:lead_user",
    email: "lead@example.com",
    lead_date: "2026-06-10T10:00:00.000Z",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    campaign_id: "cmp_1",
    media_buyer: "Ivan",
    country: "US",
    session_date: "2026-06-10T10:00:00.000Z",
    days_since_visit: 3,
    customer_id: "lead_user",
    user_agent: null,
    origin: null,
    source: "warehouse",
    has_declines: true,
    decline_reason: "insufficient_funds",
    ...overrides,
  };
}

const DIAGNOSTICS = { warehouse_leads: 0, profile_leads: 0, both_leads: 0, subscription_leads: 0, memo: "miss" as const, dataset_age_ms: 0 };

function listResponse(rows: LeadRow[], pagination: Partial<LeadsListResponse["pagination"]> = {}): LeadsListResponse {
  const total = pagination.total_rows ?? rows.length;
  return {
    ok: true,
    source: "clickhouse",
    generated_at: "2026-06-13T00:00:00.000Z",
    query_duration_ms: 4,
    rows,
    pagination: { page: 1, page_size: 50, total_rows: total, total_pages: Math.max(1, Math.ceil(total / 50)), ...pagination },
    diagnostics: DIAGNOSTICS,
  };
}

function overviewResponse(summary: Partial<LeadsSummary> = {}, filterOptions: Partial<LeadsOverviewResponse["filter_options"]> = {}): LeadsOverviewResponse {
  return {
    ok: true,
    source: "clickhouse",
    generated_at: "2026-06-13T00:00:00.000Z",
    query_duration_ms: 4,
    summary: { total_leads: 0, emails_found: 0, converted_excluded: 0, active_subs_excluded: 0, leads_today: 0, leads_last_7_days: 0, ...summary },
    filter_options: { funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], source: [], ...filterOptions },
    sync_state: { status: null, current_stage: null, last_full_sync_at: null, stats: {}, rate_limited_until: null, next_tick_hint: null, running: false },
    diagnostics: DIAGNOSTICS,
  };
}

function serve(list: (request: LeadsRequest) => LeadsListResponse, overview: LeadsOverviewResponse) {
  mocks.runClickHouseLeads.mockImplementation(async (request: LeadsRequest) => (request.action === "leads_list" ? list(request) : overview));
}

function listRequests(): LeadsRequest[] {
  return mocks.runClickHouseLeads.mock.calls.map(([request]) => request as LeadsRequest).filter((request) => request.action === "leads_list");
}

function renderPage(ui: ReactElement = <LeadsPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("Leads page (server read path)", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    serve(() => listResponse([]), overviewResponse());
  });

  it("lists the server's rows and never asks for the raw warehouse", async () => {
    serve(
      () => listResponse([leadRow(), leadRow({ key: "p:pro_1", email: "profile@example.com", source: "funnelfox_profile", has_declines: false, decline_reason: null, customer_id: "pro_1" })]),
      overviewResponse({ total_leads: 2 }),
    );

    renderPage();

    expect(await screen.findByText("lead@example.com")).toBeInTheDocument();
    expect(screen.getByText("profile@example.com")).toBeInTheDocument();
    expect(screen.getByText("FunnelFox profile")).toBeInTheDocument();
    expect(screen.getByText("Insufficient Funds")).toBeInTheDocument();
    expect(mocks.requireRaw).not.toHaveBeenCalled();
    expect(mocks.useTransactions).not.toHaveBeenCalled();
    expect(listRequests()[0]).toMatchObject({ action: "leads_list", page: 1, page_size: 50, sort: { key: "lead_date", dir: "desc" } });
  });

  it("renders the KPIs from leads_overview", async () => {
    serve(() => listResponse([leadRow()]), overviewResponse({ total_leads: 2, emails_found: 7, converted_excluded: 4, active_subs_excluded: 1, leads_today: 1, leads_last_7_days: 2 }));

    renderPage();

    await waitFor(() => expect(screen.getByText("Total Leads").parentElement).toHaveTextContent("2"));
    expect(screen.getByText("Emails Found").parentElement).toHaveTextContent("7");
    expect(screen.getByText("Converted Excluded").parentElement).toHaveTextContent("4");
    expect(screen.getByText("Active Subs Excluded").parentElement).toHaveTextContent("1");
    expect(screen.getByText(/1 of 2 leads/)).toBeInTheDocument();
  });

  it("shows the empty-set message when the server has no leads at all", async () => {
    renderPage();
    expect(await screen.findByText(/No leads found/)).toBeInTheDocument();
  });

  it("sends the persisted Source filter (the old Email any/has/none filter is gone)", async () => {
    localStorage.setItem("ui_state_leads", JSON.stringify({ source: "funnelfox_profile", hasEmail: "has", country: "US" }));
    renderPage();

    await waitFor(() => expect(listRequests().length).toBeGreaterThan(0));
    const request = listRequests()[0];
    expect(request.filters).toMatchObject({ source: ["funnelfox_profile"], country: ["US"] });
    expect(request.filters).not.toHaveProperty("has_email");
    expect(request.filters).not.toHaveProperty("hasEmail");
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent("FunnelFox profile");
    expect(screen.queryByText("Email: any")).not.toBeInTheDocument();
  });

  it("pages on the server: Next asks for page 2", async () => {
    serve((request) => listResponse([leadRow({ key: `w:${request.page}`, email: `page${request.page}@example.com` })], { page: request.page ?? 1, total_rows: 120, total_pages: 3 }), overviewResponse({ total_leads: 120 }));

    renderPage();

    expect(await screen.findByText("page1@example.com")).toBeInTheDocument();
    expect(screen.getByText(/Showing 1–50 of 120/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("page2@example.com")).toBeInTheDocument();
    expect(listRequests().at(-1)).toMatchObject({ page: 2 });
  });

  it("sorts on the server: clicking Email asks for email A→Z, again for Z→A", async () => {
    serve(() => listResponse([leadRow()]), overviewResponse({ total_leads: 1 }));
    renderPage();
    await screen.findByText("lead@example.com");

    const emailHeader = screen.getAllByRole("columnheader")[0];
    fireEvent.click(within(emailHeader).getByRole("button"));
    await waitFor(() => expect(listRequests().at(-1)).toMatchObject({ sort: { key: "email", dir: "asc" }, page: 1 }));
    fireEvent.click(within(emailHeader).getByRole("button"));
    await waitFor(() => expect(listRequests().at(-1)).toMatchObject({ sort: { key: "email", dir: "desc" } }));
  });

  it("debounces the search into the request (email or customer id)", async () => {
    renderPage();
    await waitFor(() => expect(listRequests().length).toBeGreaterThan(0));
    fireEvent.change(screen.getByPlaceholderText("Search email or ID…"), { target: { value: "lead@" } });
    await waitFor(() => expect(listRequests().at(-1)?.filters).toMatchObject({ search: "lead@" }));
  });

  it("shows a server error instead of rows", async () => {
    mocks.runClickHouseLeads.mockImplementation(async (request: LeadsRequest) => {
      if (request.action === "leads_list") throw new Error("Invalid sort key");
      return overviewResponse();
    });
    renderPage();
    expect(await screen.findByText(/Could not load leads: Invalid sort key/)).toBeInTheDocument();
  });

  it("says so when the server merged only the newest FunnelFox profile leads (the in-memory cap)", async () => {
    const capped = { ...DIAGNOSTICS, profile_candidates_total: 73_000, profile_candidates_loaded: 50_000, profile_candidates_truncated: true };
    serve(() => ({ ...listResponse([leadRow()]), diagnostics: capped }), { ...overviewResponse({ total_leads: 51_000 }), diagnostics: capped });
    renderPage();
    const banner = await screen.findByTestId("leads-profile-cap");
    // Locale-proof: the grouping separator may be a (narrow) no-break space, which the matcher folds to " ".
    const expected = `Showing the newest ${(50_000).toLocaleString()} of ${(73_000).toLocaleString()} FunnelFox profile leads`.replace(/\s/g, " ");
    expect(banner).toHaveTextContent(expected);
  });

  it("shows no cap notice while the profile leads fit", async () => {
    serve(() => listResponse([leadRow()]), { ...overviewResponse({ total_leads: 1 }), diagnostics: { ...DIAGNOSTICS, profile_candidates_total: 10, profile_candidates_loaded: 10, profile_candidates_truncated: false } });
    renderPage();
    await screen.findByText("lead@example.com");
    expect(screen.queryByTestId("leads-profile-cap")).not.toBeInTheDocument();
  });
});

describe("Leads — lead date column", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("shows when each lead came in (local date and time) right after the email", async () => {
    serve(() => listResponse([leadRow({ lead_date: "2026-06-10T10:00:00.000Z" })]), overviewResponse({ total_leads: 1 }));
    renderPage();
    await screen.findByText("lead@example.com");
    const headers = screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    expect(headers.slice(0, 2)).toEqual(["Email", "Lead Date"]);
    expect(headers).toContain("Source");
    expect(screen.getByText(formatLeadDateTime("2026-06-10T10:00:00.000Z"))).toBeInTheDocument();
  });

  it("formats as YYYY-MM-DD HH:mm in local time and tolerates missing values", () => {
    const local = new Date(2026, 9, 5, 7, 4);
    expect(formatLeadDateTime(local.toISOString())).toBe("2026-10-05 07:04");
    expect(formatLeadDateTime(null)).toBe("");
    expect(formatLeadDateTime("not a date")).toBe("");
  });
});
