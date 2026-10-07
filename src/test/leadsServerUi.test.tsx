// Leads tab, server read path (leads plan §3 "Frontend"): the request / key
// normalization of useLeadsData, the one-shot server-memo bypass after a sync,
// the sync-state polling, and the funnelfox-leads-sync bridge (explicit
// limit / max_pages, no conversion context, the 10-step manual cap, Diagnose).

import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessContext, buildAccessValue } from "@/contexts/accessContext";

const mocks = vi.hoisted(() => ({
  runClickHouseLeads: vi.fn(),
  getSession: vi.fn(async () => ({ data: { session: { access_token: "token-1" } }, error: null })),
}));

vi.mock("@/services/supabaseClient", () => ({
  isSupabaseConfigured: true,
  supabase: { auth: { getSession: mocks.getSession } },
}));

vi.mock("@/services/clickhouse", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/clickhouse")>();
  return { ...actual, runClickHouseLeads: mocks.runClickHouseLeads };
});

vi.mock("@/services/funnelfoxLeads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/funnelfoxLeads")>();
  return { ...actual, getFunnelFoxLeadsStats: vi.fn(async () => null) };
});

import {
  buildLeadsListRequest,
  invalidateLeadsQueries,
  leadsListKey,
  leadsOverviewKey,
  leadsSyncStateKey,
  normalizeLeadsListQuery,
  resetLeadsRefreshState,
  useLeadsList,
  useLeadsOverview,
  useLeadsSyncState,
} from "@/hooks/useLeadsData";
import {
  buildFunnelFoxLeadsSyncBody,
  diagnoseFunnelFoxLeadsSync,
  getFunnelFoxLeadsStats,
  isLeadsSyncActive,
  isReconcileOverdue,
  isReconcileQueued,
  runFunnelFoxLeadsSync,
  LEADS_SYNC_POLL_MS,
  RECONCILE_QUEUE_POLL_WINDOW_MS,
  MANUAL_SYNC_MAX_STEPS,
  type FunnelFoxLeadsSyncState,
} from "@/services/funnelfoxLeads";
import { leadsQueryFromUi, type LeadsUiState } from "@/pages/Leads";
import type { LeadsListResponse, LeadsOverviewResponse } from "../../supabase/functions/_shared/clickhouse/leadsContract";

const mockedStats = vi.mocked(getFunnelFoxLeadsStats);

function listResponse(): LeadsListResponse {
  return {
    ok: true,
    source: "clickhouse",
    generated_at: "2026-10-06T00:00:00.000Z",
    query_duration_ms: 5,
    rows: [],
    pagination: { page: 1, page_size: 50, total_rows: 0, total_pages: 1 },
    diagnostics: { warehouse_leads: 0, profile_leads: 0, both_leads: 0, subscription_leads: 0, memo: "miss", dataset_age_ms: 0 },
  };
}

function overviewResponse(): LeadsOverviewResponse {
  return {
    ok: true,
    source: "clickhouse",
    generated_at: "2026-10-06T00:00:00.000Z",
    query_duration_ms: 5,
    summary: { total_leads: 0, emails_found: 0, converted_excluded: 0, active_subs_excluded: 0, leads_today: 0, leads_last_7_days: 0 },
    filter_options: { funnel: [], campaign_path: [], campaign_id: [], media_buyer: [], country: [], source: [] },
    sync_state: { status: null, current_stage: null, last_full_sync_at: null, stats: {}, rate_limited_until: null, next_tick_hint: null, running: false },
    diagnostics: { warehouse_leads: 0, profile_leads: 0, both_leads: 0, subscription_leads: 0, memo: "miss", dataset_age_ms: 0 },
  };
}

function syncState(overrides: Partial<FunnelFoxLeadsSyncState> = {}): FunnelFoxLeadsSyncState {
  return {
    auth_user_id: "owner",
    last_full_sync_at: null,
    last_profiles_synced_at: null,
    last_sessions_synced_at: null,
    last_status: "ok",
    last_error: null,
    current_stage: null,
    profiles_completed: true,
    details_completed: true,
    sessions_completed: true,
    reconcile_completed: true,
    last_profiles_cursor: null,
    last_sessions_cursor: null,
    lease_until: null,
    stats: {},
    updated_at: null,
    ...overrides,
  };
}

// The hooks key on the access partition ("" ⇒ disabled): the legacy owner's is "legacy:owner".
const OWNER = buildAccessValue({ status: "legacy", access: null, userId: "owner" });

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <AccessContext.Provider value={OWNER}>{children}</AccessContext.Provider>
    </QueryClientProvider>
  );
}

function newClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

const UI: LeadsUiState = {
  search: "",
  dateFrom: "",
  dateTo: "",
  funnel: "all",
  campaignPath: "all",
  campaignId: "all",
  mediaBuyer: "all",
  country: "all",
  source: "all",
  declines: "all",
  sortKey: "lead_date",
  sortDir: "desc",
};

beforeEach(() => {
  vi.clearAllMocks();
  resetLeadsRefreshState();
  mocks.runClickHouseLeads.mockImplementation(async (request: { action: string }) =>
    request.action === "leads_list" ? listResponse() : overviewResponse(),
  );
  mockedStats.mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("leads request normalization", () => {
  it("logically identical requests share one list key; the overview key is per partition only", () => {
    const a = leadsListKey("p1", { filters: { funnel: ["b", "a", "a"], search: "  x@y.z ", source: "all" }, page: 1, page_size: 50 });
    const b = leadsListKey("p1", { filters: { funnel: ["a", "b"], search: "x@y.z" }, page: 1, page_size: 50, sort: { key: "lead_date", dir: "desc" } });
    expect(a).toEqual(b);
    expect(a.slice(0, 3)).toEqual(["leads", "list", "p1"]);
    expect(leadsListKey("p2", { page: 1 })[2]).toBe("p2");
    expect(leadsOverviewKey("p1")).toEqual(["leads", "overview", "p1"]);
    expect(leadsSyncStateKey("p1")).toEqual(["leads", "sync_state", "p1"]);
  });

  it("swaps a reversed date range (the server refuses date_from > date_to) and defaults sort / paging", () => {
    const norm = normalizeLeadsListQuery({ filters: { date_from: "2026-06-30", date_to: "2026-06-01" } });
    expect(norm).toMatchObject({ date_from: "2026-06-01", date_to: "2026-06-30", page: 1, page_size: 50, sort: { key: "lead_date", dir: "desc" } });
  });

  it("builds the leads_list body: arrays, source 'all' when empty, refresh only on demand", () => {
    const norm = normalizeLeadsListQuery({ filters: { country: ["US"], source: "both", has_declines: "has" }, sort: { key: "email", dir: "asc" }, page: 2, page_size: 50 });
    const body = buildLeadsListRequest(norm);
    expect(body).toEqual({
      action: "leads_list",
      filters: {
        search: null,
        date_from: null,
        date_to: null,
        funnel: [],
        campaign_path: [],
        campaign_id: [],
        media_buyer: [],
        country: ["US"],
        source: ["both"],
        has_declines: "has",
      },
      sort: { key: "email", dir: "asc" },
      page: 2,
      page_size: 50,
    });
    expect(buildLeadsListRequest(normalizeLeadsListQuery({})).filters?.source).toBe("all");
    expect(buildLeadsListRequest(norm, true).refresh).toBe(true);
  });

  it("maps the panel's UI state: single selects become one-value lists, a stale source / sort / Email filter is dropped", () => {
    const legacy = { ...UI, hasEmail: "has", source: "bogus", sortKey: "user_agent" } as unknown as LeadsUiState;
    const query = leadsQueryFromUi(legacy, 3);
    expect(query.filters).toMatchObject({ source: "all", funnel: [], country: [], has_declines: "all" });
    expect(query.filters).not.toHaveProperty("hasEmail");
    expect(query.filters).not.toHaveProperty("has_email");
    expect(query.sort).toEqual({ key: "lead_date", dir: "desc" });
    expect(query).toMatchObject({ page: 3, page_size: 50 });

    const picked = leadsQueryFromUi({ ...UI, funnel: "soulmate", country: "Unknown", source: "funnelfox_profile", declines: "none", dateFrom: "2026-06-01" }, 1);
    expect(picked.filters).toMatchObject({ funnel: ["soulmate"], country: ["Unknown"], source: "funnelfox_profile", has_declines: "none", date_from: "2026-06-01", date_to: null });
  });
});

describe("useLeadsList / useLeadsOverview", () => {
  it("sends leads_list / leads_overview to the bridge, keyed by the partition", async () => {
    const client = newClient();
    const { result } = renderHook(
      () => ({
        list: useLeadsList({ filters: { search: "lead@" }, page: 1, page_size: 50 }, { enabled: true }),
        overview: useLeadsOverview({ enabled: true }),
      }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.list.isSuccess && result.current.overview.isSuccess).toBe(true));
    const actions = mocks.runClickHouseLeads.mock.calls.map(([request]) => request.action).sort();
    expect(actions).toEqual(["leads_list", "leads_overview"]);
    const listBody = mocks.runClickHouseLeads.mock.calls.find(([request]) => request.action === "leads_list")?.[0];
    expect(listBody).toMatchObject({ filters: { search: "lead@" }, page: 1, page_size: 50 });
    expect(listBody).not.toHaveProperty("refresh");
    expect(client.getQueryCache().findAll({ queryKey: ["leads", "list", "legacy:owner"] })).toHaveLength(1);
    expect(client.getQueryCache().find({ queryKey: ["leads", "overview", "legacy:owner"] })).toBeDefined();
  });

  it("stays idle when disabled (no access, no partition)", async () => {
    const client = newClient();
    renderHook(() => useLeadsList({ page: 1 }, { enabled: false }), { wrapper: wrapperFor(client) });
    await act(async () => {});
    expect(mocks.runClickHouseLeads).not.toHaveBeenCalled();
  });

  it("an embedded ok:false answer becomes a query error", async () => {
    // (an "invalid …" message is not retried by transientRetry, so the error settles at once)
    mocks.runClickHouseLeads.mockResolvedValue({ ok: false, error: "Invalid leads request" });
    const client = newClient();
    const { result } = renderHook(() => useLeadsList({ page: 1 }, { enabled: true }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect((result.current.error as Error).message).toBe("Invalid leads request");
  });

  it("after invalidateLeadsQueries the next list and overview requests bypass the server memo once", async () => {
    const client = newClient();
    const { result } = renderHook(
      () => ({ list: useLeadsList({ page: 1 }, { enabled: true }), overview: useLeadsOverview({ enabled: true }) }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => expect(result.current.list.isSuccess && result.current.overview.isSuccess).toBe(true));
    mocks.runClickHouseLeads.mockClear();

    await act(async () => {
      await invalidateLeadsQueries(client);
    });
    const afterSync = mocks.runClickHouseLeads.mock.calls.map(([request]) => request);
    expect(afterSync).toHaveLength(2);
    for (const request of afterSync) expect(request.refresh).toBe(true);

    mocks.runClickHouseLeads.mockClear();
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["leads"] });
    });
    for (const [request] of mocks.runClickHouseLeads.mock.calls) expect(request).not.toHaveProperty("refresh");
  });
});

describe("useLeadsSyncState polling", () => {
  it("re-reads the state every 30 s while the sync is partial, and not once it is complete", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockedStats.mockResolvedValue(syncState({ last_status: "partial", profiles_completed: false }));
    const client = newClient();
    const partial = renderHook(() => useLeadsSyncState({ enabled: true }), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(partial.result.current.isSuccess).toBe(true));
    expect(mockedStats).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LEADS_SYNC_POLL_MS);
    });
    await waitFor(() => expect(mockedStats).toHaveBeenCalledTimes(2));
    partial.unmount();

    mockedStats.mockClear();
    mockedStats.mockResolvedValue(syncState({ last_status: "ok" }));
    const done = renderHook(() => useLeadsSyncState({ enabled: true }), { wrapper: wrapperFor(newClient()) });
    await waitFor(() => expect(done.result.current.isSuccess).toBe(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LEADS_SYNC_POLL_MS * 2);
    });
    expect(mockedStats).toHaveBeenCalledTimes(1);
    done.unmount();
  });

  it("isLeadsSyncActive: partial, a held lease or a running rate-limit pause", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    expect(isLeadsSyncActive(null, now)).toBe(false);
    expect(isLeadsSyncActive(syncState({ last_status: "ok" }), now)).toBe(false);
    expect(isLeadsSyncActive(syncState({ last_status: "partial" }), now)).toBe(true);
    expect(isLeadsSyncActive(syncState({ lease_until: "2026-10-06T12:01:00.000Z" }), now)).toBe(true);
    expect(isLeadsSyncActive(syncState({ lease_until: "2026-10-06T11:59:00.000Z" }), now)).toBe(false);
    expect(isLeadsSyncActive(syncState({ stats: { rate_limited_until: "2026-10-06T12:00:30.000Z" } }), now)).toBe(true);
  });

  it("isReconcileQueued / isLeadsSyncActive: a reconcile requested after the last applied run is queued; the card polls for it a while", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    expect(isReconcileQueued(null)).toBe(false);
    expect(isReconcileQueued(syncState())).toBe(false); // before migration 202610070001: no columns
    expect(isReconcileQueued(syncState({ reconcile_requested_at: null, reconcile_applied_at: minutesAgo(5) }))).toBe(false);
    expect(isReconcileQueued(syncState({ reconcile_requested_at: minutesAgo(1), reconcile_applied_at: null }))).toBe(true);
    expect(isReconcileQueued(syncState({ reconcile_requested_at: minutesAgo(1), reconcile_applied_at: minutesAgo(2) }))).toBe(true);
    expect(isReconcileQueued(syncState({ reconcile_requested_at: minutesAgo(2), reconcile_applied_at: minutesAgo(1) }))).toBe(false);
    expect(isReconcileQueued(syncState({ reconcile_requested_at: "not a date", reconcile_applied_at: null }))).toBe(false);

    // Polls while the queued request is recent (pg_cron applies it within a minute), then gives up.
    expect(isLeadsSyncActive(syncState({ reconcile_requested_at: minutesAgo(1) }), now)).toBe(true);
    expect(isLeadsSyncActive(syncState({ reconcile_requested_at: minutesAgo(RECONCILE_QUEUE_POLL_WINDOW_MS / 60_000 + 1) }), now)).toBe(false);
    expect(isLeadsSyncActive(syncState({ reconcile_requested_at: minutesAgo(2), reconcile_applied_at: minutesAgo(1) }), now)).toBe(false);
  });

  it("isReconcileOverdue: queued for the whole poll window (the job is likely not running) or after a failed run; never once applied", () => {
    const now = Date.parse("2026-10-06T12:00:00.000Z");
    const msAgo = (ms: number) => new Date(now - ms).toISOString();
    const windowMs = RECONCILE_QUEUE_POLL_WINDOW_MS;
    expect(windowMs).toBe(15 * 60_000);
    // The window edge: still inside it 1 ms before, overdue exactly at it and after.
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(windowMs - 1), reconcile_applied_at: null }), now)).toBe(false);
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(windowMs), reconcile_applied_at: null }), now)).toBe(true);
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(windowMs + 60_000), reconcile_applied_at: msAgo(windowMs + 120_000) }), now)).toBe(true);
    // Polling stops exactly where the warning starts.
    expect(isLeadsSyncActive(syncState({ reconcile_requested_at: msAgo(windowMs) }), now)).toBe(false);
    expect(isLeadsSyncActive(syncState({ reconcile_requested_at: msAgo(windowMs - 1) }), now)).toBe(true);
    // Applied (however old the request): not overdue.
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(3 * windowMs), reconcile_applied_at: msAgo(3 * windowMs - 1_000) }), now)).toBe(false);
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(3 * windowMs), reconcile_applied_at: msAgo(3 * windowMs) }), now)).toBe(false);
    // Missing / invalid requested_at, no row, before the migration: never.
    expect(isReconcileOverdue(null, now)).toBe(false);
    expect(isReconcileOverdue(syncState(), now)).toBe(false);
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: null, reconcile_applied_at: null }), now)).toBe(false);
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: "not a date", reconcile_applied_at: null }), now)).toBe(false);
    // A failed run of a queued request (pg_cron backs off): overdue at once; an applied one with a stale failure: not.
    const failure = { failed_at: msAgo(30_000), error: "canceling statement due to statement timeout", failures: 1, retry_after: msAgo(-15 * 60_000) };
    expect(isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(60_000), reconcile_failure: failure }), now)).toBe(true);
    expect(
      isReconcileOverdue(syncState({ reconcile_requested_at: msAgo(60_000), reconcile_applied_at: msAgo(1_000), reconcile_failure: failure }), now),
    ).toBe(false);
  });
});

describe("funnelfox-leads-sync bridge", () => {
  it("always sends limit / max_pages explicitly and never a conversion context", async () => {
    expect(buildFunnelFoxLeadsSyncBody()).toEqual({ dry_run: false, full_reset: false, stage: undefined, limit: 100, max_pages: 200 });
    expect(buildFunnelFoxLeadsSyncBody({ fullReset: true })).toMatchObject({ full_reset: true, limit: 100, max_pages: 200 });
    expect(buildFunnelFoxLeadsSyncBody({ dryRun: true })).toMatchObject({ dry_run: true, limit: 100, max_pages: 2 });
    expect(buildFunnelFoxLeadsSyncBody()).not.toHaveProperty("conversion");
    // The browser no longer builds a conversion context nor reads funnelfox_leads rows itself.
    const actual = await vi.importActual<typeof import("@/services/funnelfoxLeads")>("@/services/funnelfoxLeads");
    expect(Object.keys(actual)).not.toContain("buildConversionContext");
    expect(Object.keys(actual)).not.toContain("loadFunnelFoxLeads");
  });

  function stubSyncFetch(responses: Array<Record<string, unknown>>) {
    const bodies: Array<Record<string, unknown>> = [];
    let call = 0;
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      const payload = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { ok: true, status: 200, json: async () => payload } as unknown as Response;
    });
    vi.stubGlobal("fetch", fetchMock);
    return { fetchMock, bodies };
  }

  it("a manual Continue stops after MANUAL_SYNC_MAX_STEPS (10) calls; only the first may reset", async () => {
    const { fetchMock, bodies } = stubSyncFetch([{ status: "partial", dry_run: false, made_progress: true, all_stages_completed: false, stage: "profiles" }]);
    const steps: number[] = [];
    const last = await runFunnelFoxLeadsSync({ fullReset: true, onProgress: (_res, step) => steps.push(step) });
    expect(MANUAL_SYNC_MAX_STEPS).toBe(10);
    expect(fetchMock).toHaveBeenCalledTimes(10);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(last.status).toBe("partial");
    expect(bodies[0]).toMatchObject({ full_reset: true, limit: 100, max_pages: 200, dry_run: false });
    for (const body of bodies.slice(1)) expect(body).toMatchObject({ full_reset: false, limit: 100, max_pages: 200 });
    for (const body of bodies) expect(body).not.toHaveProperty("conversion");
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/functions\/v1\/funnelfox-leads-sync$/);
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer token-1" });
  });

  it("stops at once when the call is busy (the cron holds the lease) or completes", async () => {
    const busy = stubSyncFetch([{ status: "busy", dry_run: false, busy: true, made_progress: false, all_stages_completed: false }]);
    expect((await runFunnelFoxLeadsSync()).status).toBe("busy");
    expect(busy.fetchMock).toHaveBeenCalledTimes(1);

    const done = stubSyncFetch([
      { status: "partial", dry_run: false, made_progress: true, all_stages_completed: false },
      { status: "ok", dry_run: false, made_progress: true, all_stages_completed: true },
    ]);
    expect((await runFunnelFoxLeadsSync()).all_stages_completed).toBe(true);
    expect(done.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("Diagnose is a dry run with limit 100 / max_pages 2 and returns the diagnostics as sent", async () => {
    const { bodies } = stubSyncFetch([{ status: "ok", dry_run: true, diagnostics: { list_rows_with_email: 38, sample_profile_keys: ["id", "email"] } }]);
    const res = await diagnoseFunnelFoxLeadsSync();
    expect(bodies).toEqual([{ dry_run: true, full_reset: false, limit: 100, max_pages: 2 }]);
    expect(res.diagnostics).toEqual({ list_rows_with_email: 38, sample_profile_keys: ["id", "email"] });
  });

  it("an HTTP error surfaces the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ error: "FunnelFox leads sync failed." }) }) as unknown as Response));
    await expect(runFunnelFoxLeadsSync()).rejects.toThrow("FunnelFox leads sync failed.");
  });
});
