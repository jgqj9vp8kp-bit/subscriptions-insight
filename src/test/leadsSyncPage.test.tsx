import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runClickHouseLeads: vi.fn(),
}));

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

// The page reads useAccess(); these tests cover the data owner's view (legacy
// access: every permission, raw access on — exactly today's behaviour).
vi.mock("@/hooks/useAccess", async () => {
  const { buildAccessValue } = await import("@/contexts/accessContext");
  const owner = buildAccessValue({ status: "legacy", access: null, userId: "u1" });
  return { useAccess: () => owner, useOptionalAccess: () => owner, useCan: (key: string) => owner.can(key) };
});

vi.mock("@/services/supabaseClient", () => ({
  isSupabaseConfigured: true,
  supabase: {},
}));

vi.mock("@/services/funnelfoxLeads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/funnelfoxLeads")>();
  return {
    ...actual,
    runFunnelFoxLeadsSync: vi.fn(async () => ({ status: "ok", dry_run: false, all_stages_completed: true })),
    getFunnelFoxLeadsStats: vi.fn(async () => null),
    diagnoseFunnelFoxLeadsSync: vi.fn(async () => ({ status: "ok", dry_run: true })),
  };
});

vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/clickhouse")>();
  return { ...actual, runClickHouseLeads: mocks.runClickHouseLeads };
});

import LeadsPage, { formatLeadDateTime } from "@/pages/Leads";
import {
  diagnoseFunnelFoxLeadsSync,
  getFunnelFoxLeadsStats,
  runFunnelFoxLeadsSync,
  type FunnelFoxLeadsSyncState,
} from "@/services/funnelfoxLeads";
import type { LeadsRequest } from "../../supabase/functions/_shared/clickhouse/leadsContract";

const mockedRun = vi.mocked(runFunnelFoxLeadsSync);
const mockedStats = vi.mocked(getFunnelFoxLeadsStats);
const mockedDiagnose = vi.mocked(diagnoseFunnelFoxLeadsSync);

const EMPTY_DIAGNOSTICS = { warehouse_leads: 0, profile_leads: 0, both_leads: 0, subscription_leads: 0, memo: "miss" as const, dataset_age_ms: 0 };

function serveEmptyLeads() {
  mocks.runClickHouseLeads.mockImplementation(async (request: LeadsRequest) =>
    request.action === "leads_list"
      ? {
          ok: true,
          source: "clickhouse",
          generated_at: "2026-10-06T00:00:00.000Z",
          query_duration_ms: 1,
          rows: [],
          pagination: { page: 1, page_size: 50, total_rows: 0, total_pages: 1 },
          diagnostics: EMPTY_DIAGNOSTICS,
        }
      : {
          ok: true,
          source: "clickhouse",
          generated_at: "2026-10-06T00:00:00.000Z",
          query_duration_ms: 1,
          summary: { total_leads: 0, emails_found: 0, converted_excluded: 0, active_subs_excluded: 0, leads_today: 0, leads_last_7_days: 0 },
          filter_options: { funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], source: [] },
          sync_state: { status: null, current_stage: null, last_full_sync_at: null, stats: {}, rate_limited_until: null, next_tick_hint: null, running: false },
          diagnostics: EMPTY_DIAGNOSTICS,
        },
  );
}

function partialState(overrides: Partial<FunnelFoxLeadsSyncState> = {}): FunnelFoxLeadsSyncState {
  return {
    auth_user_id: "u1",
    last_full_sync_at: null,
    last_profiles_synced_at: null,
    last_sessions_synced_at: null,
    last_status: "partial",
    last_error: null,
    current_stage: "profiles",
    profiles_completed: false,
    details_completed: true,
    sessions_completed: false,
    reconcile_completed: false,
    last_profiles_cursor: "cursor_abc",
    last_sessions_cursor: null,
    lease_until: null,
    stats: {
      stage: "profiles",
      sync_stopped_reason: "soft_timeout",
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because soft timeout was reached during the profile crawl.",
      profiles_scanned_total: 5000,
      profiles_total_saved: 1787,
      profiles_with_email: 1787,
      profiles_without_email: 3213,
      preview_excluded: 12,
    },
    updated_at: null,
    ...overrides,
  };
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LeadsPage />
    </QueryClientProvider>,
  );
}

function leadsRequests(action: LeadsRequest["action"]): LeadsRequest[] {
  return mocks.runClickHouseLeads.mock.calls.map(([request]) => request as LeadsRequest).filter((request) => request.action === action);
}

describe("Leads page — resumable sync UI", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    serveEmptyLeads();
    mockedStats.mockResolvedValue(null);
    mockedRun.mockResolvedValue({ status: "ok", dry_run: false, all_stages_completed: true });
  });

  it("9. shows the partial warning + diagnostics when the last sync was partial", async () => {
    mockedStats.mockResolvedValue(partialState());

    renderPage();

    expect(await screen.findByText(/Sync is partial\./)).toBeInTheDocument();
    expect(screen.getByText(/soft timeout was reached during the profile crawl/)).toBeInTheDocument();
    // diagnostics surfaced (digit grouping is locale-dependent: 5,000 / 5 000 / 5.000)
    expect(screen.getByText("Profiles scanned:")).toHaveTextContent(/\b5\D?000\b/);
    expect(screen.getByText("Without email:")).toHaveTextContent(/\b3\D?213\b/);
    expect(screen.getByText("Preview excluded:")).toHaveTextContent("12");
    expect(screen.getByText("Last cursor exists:")).toHaveTextContent("yes");
    expect(screen.getByText(/Background sync runs every minute/)).toBeInTheDocument();
    // The removed detail stage is no longer surfaced.
    expect(screen.queryByText("Detail remaining:")).not.toBeInTheDocument();
  });

  it("10. Continue Sync resumes without full_reset, with limit 100 / max_pages 200, capped at 10 steps", async () => {
    renderPage();
    const button = await screen.findByRole("button", { name: /Continue Sync/i });
    fireEvent.click(button);
    await waitFor(() => expect(mockedRun).toHaveBeenCalled());
    expect(mockedRun.mock.calls[0][0]).toMatchObject({ fullReset: false, limit: 100, maxPages: 200, maxSteps: 10 });
    expect(mockedRun.mock.calls[0][0]).not.toHaveProperty("transactions");
    expect(mockedRun.mock.calls[0][0]).not.toHaveProperty("subscriptions");
  });

  it("11. Full Resync passes full_reset=true", async () => {
    renderPage();
    const button = await screen.findByRole("button", { name: /Full Resync/i });
    fireEvent.click(button);
    await waitFor(() => expect(mockedRun).toHaveBeenCalled());
    expect(mockedRun.mock.calls[0][0]).toMatchObject({ fullReset: true, limit: 100, maxPages: 200, maxSteps: 10 });
  });

  it("12. a sync invalidates the leads queries: list + overview rebuild the server set, the state is re-read", async () => {
    renderPage();
    await waitFor(() => expect(leadsRequests("leads_list")).toHaveLength(1));
    await waitFor(() => expect(mockedStats).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole("button", { name: /Continue Sync/i }));
    await waitFor(() => expect(leadsRequests("leads_list")).toHaveLength(2));
    await waitFor(() => expect(leadsRequests("leads_overview")).toHaveLength(2));
    expect(leadsRequests("leads_list")[1]).toMatchObject({ refresh: true });
    expect(leadsRequests("leads_overview")[1]).toMatchObject({ refresh: true });
    await waitFor(() => expect(mockedStats.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Sync completed.")).toBeInTheDocument();
  });

  it("13. reports a busy answer (the background tick holds the lease)", async () => {
    mockedRun.mockResolvedValue({ status: "busy", dry_run: false, busy: true, made_progress: false, all_stages_completed: false });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Continue Sync/i }));
    expect(await screen.findByText(/Another sync call is running right now/)).toBeInTheDocument();
  });

  it("14. shows the FunnelFox rate-limit pause until its end", async () => {
    const until = new Date(Date.now() + 5 * 60_000).toISOString();
    mockedStats.mockResolvedValue(partialState({ stats: { ...partialState().stats, sync_stopped_reason: "rate_limited", rate_limited_until: until } }));
    renderPage();
    expect(await screen.findByText(new RegExp(`rate-limited the sync until ${formatLeadDateTime(until)}`))).toBeInTheDocument();
  });

  it("14b. after a FunnelFox error shows the failure and when the background sync retries (backoff)", async () => {
    const until = new Date(Date.now() + 4 * 60_000).toISOString();
    mockedStats.mockResolvedValue(
      partialState({
        last_status: "error",
        last_error: "FunnelFox /profiles HTTP 404: cursor expired",
        stats: { ...partialState().stats, sync_stopped_reason: "api_error", consecutive_api_errors: 3, error_backoff_until: until },
      }),
    );
    renderPage();
    expect(await screen.findByText(/The last sync call failed: FunnelFox \/profiles HTTP 404: cursor expired/)).toHaveTextContent(
      new RegExp(`retries after ${formatLeadDateTime(until)}; the daily refresh restarts the pipeline`),
    );
    expect(screen.getByText("failed")).toBeInTheDocument();
  });

  it("15. Diagnose (owner) renders the PII-free dry-run JSON", async () => {
    mockedDiagnose.mockResolvedValue({
      status: "ok",
      dry_run: true,
      diagnostics: { list_rows_with_email: 38, sample_profile_keys: ["id", "created_at", "funnel_id", "preview", "email"], profile_detail_endpoint: "not_called" },
    });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Diagnose/i }));
    const output = await screen.findByTestId("leads-diagnose-output");
    expect(mockedDiagnose).toHaveBeenCalledTimes(1);
    expect(output).toHaveTextContent('"list_rows_with_email": 38');
    expect(output).toHaveTextContent('"profile_detail_endpoint": "not_called"');
    expect(mockedRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close diagnostics" }));
    expect(screen.queryByTestId("leads-diagnose-output")).not.toBeInTheDocument();
  });
});
