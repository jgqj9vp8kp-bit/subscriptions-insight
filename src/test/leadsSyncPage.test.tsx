import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/services/sheets", () => ({ useTransactions: vi.fn(() => []) }));

vi.mock("@/services/supabaseClient", () => ({
  isSupabaseConfigured: true,
  supabase: {},
}));

vi.mock("@/services/funnelfoxLeads", () => ({
  runFunnelFoxLeadsSync: vi.fn(async () => ({ status: "ok", dry_run: false, all_stages_completed: true })),
  loadFunnelFoxLeads: vi.fn(async () => []),
  getFunnelFoxLeadsStats: vi.fn(async () => null),
}));

import LeadsPage from "@/pages/Leads";
import { useDataStore } from "@/store/dataStore";
import {
  getFunnelFoxLeadsStats,
  loadFunnelFoxLeads,
  runFunnelFoxLeadsSync,
  type FunnelFoxLeadsSyncState,
} from "@/services/funnelfoxLeads";

const mockedRun = vi.mocked(runFunnelFoxLeadsSync);
const mockedStats = vi.mocked(getFunnelFoxLeadsStats);
const mockedLoad = vi.mocked(loadFunnelFoxLeads);

function partialState(): FunnelFoxLeadsSyncState {
  return {
    auth_user_id: "u1",
    last_full_sync_at: null,
    last_profiles_synced_at: null,
    last_sessions_synced_at: null,
    last_status: "partial",
    last_error: null,
    current_stage: "profile_details",
    profiles_completed: true,
    details_completed: false,
    sessions_completed: false,
    reconcile_completed: false,
    last_profiles_cursor: "cursor_abc",
    last_sessions_cursor: null,
    stats: {
      stage: "profile_details",
      sync_stopped_reason: "soft_timeout",
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because soft timeout was reached during profile detail enrichment.",
      profiles_scanned_total: 5000,
      profiles_total_saved: 5000,
      profiles_with_email: 1787,
      profiles_without_email: 3213,
      profile_details_attempted: 1200,
      profile_details_failed: 12,
    },
    updated_at: null,
  };
}

describe("Leads page — resumable sync UI", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useDataStore.setState({ rawPalmerRows: [], subscriptions: [] });
    mockedLoad.mockResolvedValue([]);
    mockedStats.mockResolvedValue(null);
    mockedRun.mockResolvedValue({ status: "ok", dry_run: false, all_stages_completed: true });
  });

  it("9. shows the partial warning + diagnostics when the last sync was partial", async () => {
    mockedStats.mockResolvedValue(partialState());

    render(<LeadsPage />);

    expect(await screen.findByText(/Sync is partial\. Click/)).toBeInTheDocument();
    expect(screen.getByText(/soft timeout was reached during profile detail enrichment/)).toBeInTheDocument();
    // diagnostics surfaced
    expect(screen.getByText("Profiles scanned:").parentElement).toHaveTextContent("5,000");
    expect(screen.getByText("Without email:").parentElement).toHaveTextContent("3,213");
    expect(screen.getByText("Last cursor exists:").parentElement).toHaveTextContent("yes");
  });

  it("10. Continue Sync resumes without full_reset", async () => {
    render(<LeadsPage />);
    const button = await screen.findByRole("button", { name: /Continue Sync/i });
    fireEvent.click(button);
    await waitFor(() => expect(mockedRun).toHaveBeenCalled());
    expect(mockedRun.mock.calls[0][0]).toMatchObject({ fullReset: false });
  });

  it("11. Full Resync passes full_reset=true", async () => {
    render(<LeadsPage />);
    const button = await screen.findByRole("button", { name: /Full Resync/i });
    fireEvent.click(button);
    await waitFor(() => expect(mockedRun).toHaveBeenCalled());
    expect(mockedRun.mock.calls[0][0]).toMatchObject({ fullReset: true });
  });
});
