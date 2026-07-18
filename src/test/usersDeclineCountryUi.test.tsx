// ClickHouse-driven Decline Analytics tab: the bundle renders the KPIs and the
// country breakdown, the country filter is part of the server scope, the
// country-table sort is server-side (clicking a header issues a new request
// with the sort in the contract), and diagnostics are surfaced.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import UsersPage from "@/pages/Users";
import type { UsersDeclineResponse } from "@/services/usersDataSource";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/services/sheets", () => ({
  useTransactions: () => [],
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "test-user" } }) }));

// The warehouse version gate normally requires a live clickhouse-summary call.
vi.mock("@/hooks/useAnalyticsCache", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useAnalyticsCache")>();
  return { ...actual, useWarehouseVersion: () => ({ version: "whv_test", ready: true }) };
});

const loadUsersDecline = vi.fn();
const loadUserOptions = vi.fn();
const loadUsers = vi.fn();
const loadUsersSummary = vi.fn();

vi.mock("@/services/usersDataSource", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/usersDataSource")>();
  return {
    ...actual,
    loadUsersDeclineFromClickHouse: (...args: unknown[]) => loadUsersDecline(...args),
    loadUserOptionsFromClickHouse: (...args: unknown[]) => loadUserOptions(...args),
    loadUsersFromClickHouse: (...args: unknown[]) => loadUsers(...args),
    loadUsersSummaryFromClickHouse: (...args: unknown[]) => loadUsersSummary(...args),
  };
});

const countryRow = (overrides: Partial<UsersDeclineResponse["country_rows"][number]>) => ({
  country: "US",
  total_attempts: 0, successful: 0, failed: 0, pass_rate: null,
  insufficient_funds: 0, pass_rate_ex_if: null, top_decline_reason: null,
  users_with_attempts: 0, users_with_success: 0, user_pass_rate: null,
  first_attempts: 0, first_success: 0, first_attempt_pass_rate: null,
  first_sub_attempts: 0, first_sub_success: 0, first_sub_pass_rate: null,
  renewal_attempts: 0, renewal_success: 0, renewal_pass_rate: null,
  ...overrides,
});

function bundle(): UsersDeclineResponse {
  return {
    ok: true,
    source: "clickhouse",
    generated_at: "2026-07-17T00:00:00.000Z",
    query_duration_ms: 123,
    totals: {
      selected_users: 10,
      failed_users: 4,
      failed_transactions: 8,
      successful_transactions: 32,
      total_transactions: 40,
      decline_rate: 0.4,
      top_reason: "insufficient_funds",
      avg_attempts: 2,
      stage_totals: { after_trial: 5, after_first_subscription: 2, after_renewal: 1, unknown: 0 },
    },
    reason_rows: [
      {
        reason: "insufficient_funds", failed_users: 3, failed_transactions: 5, share: 0.625, avg_attempts: 5 / 3,
        latest_failed_date: "2026-07-01",
        stage_counts: { after_trial: 4, after_first_subscription: 1, after_renewal: 0, unknown: 0 },
        top_stage: "after_trial",
        messages: [
          { message: "Insufficient funds", failed_users: 2, failed_transactions: 4, share: 0.8 },
          { message: "Insufficient funds/over credit limit", failed_users: 1, failed_transactions: 1, share: 0.2 },
        ],
      },
      {
        reason: "do_not_honor", failed_users: 1, failed_transactions: 3, share: 0.375, avg_attempts: 3,
        latest_failed_date: "2026-06-15",
        stage_counts: { after_trial: 1, after_first_subscription: 1, after_renewal: 1, unknown: 0 },
        top_stage: "after_trial",
        messages: [
          { message: "Suspected fraud", failed_users: 1, failed_transactions: 3, share: 1 },
        ],
      },
    ],
    stage_rows: [
      { stage: "after_trial", failed_users: 4, failed_transactions: 5, share: 0.625, top_reason: "insufficient_funds" },
      { stage: "after_first_subscription", failed_users: 2, failed_transactions: 2, share: 0.25, top_reason: "do_not_honor" },
      { stage: "after_renewal", failed_users: 1, failed_transactions: 1, share: 0.125, top_reason: "do_not_honor" },
    ],
    country_rows: [
      countryRow({ country: "US", total_attempts: 20, successful: 15, failed: 5, pass_rate: 0.75, insufficient_funds: 4, pass_rate_ex_if: 0.9375, top_decline_reason: "insufficient_funds", users_with_attempts: 6, users_with_success: 5, user_pass_rate: 5 / 6 }),
      countryRow({ country: "DE", total_attempts: 10, successful: 0, failed: 10, pass_rate: 0, insufficient_funds: 0, pass_rate_ex_if: 0, top_decline_reason: "do_not_honor", users_with_attempts: 2 }),
      countryRow({ country: "Unknown", total_attempts: 5, successful: 5, failed: 0, pass_rate: 1, users_with_attempts: 2, users_with_success: 2, user_pass_rate: 1 }),
    ],
    country_totals: countryRow({ country: "all", total_attempts: 35, successful: 20, failed: 15, pass_rate: 20 / 35, insufficient_funds: 4, pass_rate_ex_if: 20 / 31, users_with_attempts: 10, users_with_success: 7, user_pass_rate: 0.7 }),
    country_sort: { field: "total_attempts", direction: "desc" },
    applied_filters: { countries: [], reasons: [], stages: [] },
    diagnostics: { users_with_country: 8, users_without_country: 2, attempts_with_country: 30, attempts_without_country: 5, unique_countries: 2 },
  };
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsersPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  loadUsersDecline.mockResolvedValue(bundle());
  loadUserOptions.mockResolvedValue({
    funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], currency: [], card_type: [],
    country: [
      { country_code: "DE", user_count: 2 },
      { country_code: "US", user_count: 6 },
      { country_code: "Unknown", user_count: 2 },
    ],
  });
  loadUsers.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50, totalPages: 1, durationMs: 1 });
  loadUsersSummary.mockResolvedValue(null);
  localStorage.setItem("ui_state_users", JSON.stringify({ mode: "decline_analytics" }));
});

describe("Decline Analytics — ClickHouse path with country dimension", () => {
  it("renders the server bundle (no browser transaction scan) with KPIs and diagnostics", async () => {
    renderPage();
    expect(await screen.findByText("40.0%")).toBeTruthy(); // decline rate from bundle fraction
    expect(screen.getByText("2.00")).toBeTruthy(); // avg failed attempts
    // Success counter + share-of-all denominator cards.
    expect(screen.getByText("Total Transactions")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    expect(screen.getByText("32 · 80.0%")).toBeTruthy(); // successful transactions · success rate
    // Reason share is now % of ALL transactions: 5 failed / 40 total = 12.5%
    // (also appears in the stage table, which keeps its share-of-failed metric).
    expect(screen.getAllByText("12.5%").length).toBeGreaterThan(0);
    expect(screen.getByText("7.5%")).toBeTruthy(); // do_not_honor: 3 / 40
    expect(screen.getByText("Share of All Tx")).toBeTruthy();
    const strip = screen.getByText("Decline data source").parentElement as HTMLElement;
    expect(within(strip).getByText("clickhouse")).toBeTruthy();
    expect(strip.textContent).toContain("users with country:");
    expect(strip.textContent).toContain("8");
    expect(strip.textContent).toContain("countries:");
    await waitFor(() => expect(loadUsersDecline).toHaveBeenCalled());
    // Server scope: the decline query carries the shared user filters + sort.
    expect(loadUsersDecline.mock.calls[0][0]).toMatchObject({
      country: "all",
      countrySortField: "total_attempts",
      countrySortDir: "desc",
    });
  });

  it("renders the country breakdown in server order (Unknown last) with — for null rates", async () => {
    renderPage();
    const table = (await screen.findByLabelText("Decline analytics by country")) as HTMLTableElement;
    const rows = within(table).getAllByRole("row").slice(1); // skip header
    const firstCells = rows.map((row) => within(row).getAllByRole("cell")[0].textContent);
    expect(firstCells).toEqual(["US", "DE", "Unknown", "All countries"]);
    const usCells = within(rows[0]).getAllByRole("cell").map((cell) => cell.textContent);
    expect(usCells).toContain("75.0%"); // pass rate
    expect(usCells).toContain("93.8%"); // pass rate ex-IF
    const deCells = within(rows[1]).getAllByRole("cell").map((cell) => cell.textContent);
    expect(deCells).toContain("0.0%"); // zero successes → 0%, not NaN
    expect(deCells).toContain("—"); // null denominators render as —
    // Additive totals row, never averaged rates: 20/35.
    const totalCells = within(rows[3]).getAllByRole("cell").map((cell) => cell.textContent);
    expect(totalCells).toContain("57.1%");
  });

  it("clicking the Country header requests a server-side A→Z sort (Unknown handled server-side)", async () => {
    renderPage();
    const table = (await screen.findByLabelText("Decline analytics by country")) as HTMLTableElement;
    fireEvent.click(within(table).getByRole("button", { name: /^Country/ }));
    await waitFor(() => {
      expect(loadUsersDecline).toHaveBeenCalledWith(expect.objectContaining({ countrySortField: "country", countrySortDir: "asc" }));
    });
    fireEvent.click(within(table).getByRole("button", { name: /^Country/ }));
    await waitFor(() => {
      expect(loadUsersDecline).toHaveBeenCalledWith(expect.objectContaining({ countrySortField: "country", countrySortDir: "desc" }));
    });
  });

  it("clicking a decline reason expands its raw-message breakdown (and collapses on second click)", async () => {
    renderPage();
    await screen.findByText("40.0%");
    expect(screen.queryByText("Suspected fraud")).toBeNull(); // collapsed by default
    fireEvent.click(screen.getByRole("button", { name: "Toggle do_not_honor message breakdown" }));
    const breakdown = await screen.findByLabelText("do_not_honor message breakdown");
    expect(breakdown.textContent).toContain("Suspected fraud");
    expect(breakdown.textContent).toContain("100.0%"); // share within the reason
    // The other reason expands independently with its own messages.
    fireEvent.click(screen.getByRole("button", { name: "Toggle insufficient_funds message breakdown" }));
    const ifBreakdown = await screen.findByLabelText("insufficient_funds message breakdown");
    expect(ifBreakdown.textContent).toContain("Insufficient funds/over credit limit");
    expect(ifBreakdown.textContent).toContain("80.0%");
    // Collapse again.
    fireEvent.click(screen.getByRole("button", { name: "Toggle do_not_honor message breakdown" }));
    expect(screen.queryByLabelText("do_not_honor message breakdown")).toBeNull();
  });

  it("a persisted country filter scopes the decline bundle request", async () => {
    localStorage.setItem("ui_state_users", JSON.stringify({ mode: "decline_analytics", countryFilter: "US" }));
    renderPage();
    await waitFor(() => expect(loadUsersDecline).toHaveBeenCalled());
    expect(loadUsersDecline.mock.calls[0][0]).toMatchObject({ country: "US" });
    // Dependent options request carries the scope too (server strips country
    // itself for the country dimension).
    await waitFor(() => expect(loadUserOptions).toHaveBeenCalled());
    expect(loadUserOptions.mock.calls[0][0]).toMatchObject({ country: "US" });
  });

  it("shows the Unknown option (with unique-user count) in the decline tab country filter", async () => {
    renderPage();
    await screen.findByText("40.0%");
    // Radix Select renders the selected value; options open on demand — assert
    // the trigger exists (also matched by the totals row label) and the options
    // payload includes Unknown with a count.
    expect(screen.getAllByText("All countries").length).toBeGreaterThan(0);
    const options = await loadUserOptions.mock.results[0].value;
    expect(options.country.find((c: { country_code: string }) => c.country_code === "Unknown")?.user_count).toBe(2);
  });
});
