// What a funnel-restricted member's pages ask the server for (access Phase 2,
// spec §5.3 / §7 track H). Each restricted-ready page renders with its REAL
// hooks and services against a recording supabase client, as the plan's Media
// Buyer (ai.use included). Every Edge call must normalize — through the
// function's own policy normalizer — to a scopeReady action listed for that
// page in RESTRICTED_PAGE_ACTIONS, and each page calls exactly its listed
// actions: no AI pass-rate call, no diagnostics or legacy reads, no other
// function. The Funnels page reads the registry through PostgREST only.
// With the scoped snapshot not ready (409) the pages show the waiting state
// and re-ask only those same actions every SCOPE_PENDING_POLL_MS.
//
// UX evidence only — the Edge gate answers anything else 403 for them anyway.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: MockResizeObserver });

const sb = vi.hoisted(() => {
  const invokes: Array<{ fn: string; body: Record<string, unknown> }> = [];
  const tables: string[] = [];
  const state = {
    responder: (_fn: string, _body: Record<string, unknown>): { data: unknown; error: unknown } => ({ data: null, error: null }),
    rows: {} as Record<string, unknown[]>,
  };
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "neq", "in", "order", "limit", "range", "is", "gte", "lte"]) chain[method] = () => chain;
    const result = () => ({ data: state.rows[table] ?? [], error: null });
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.single = async () => ({ data: null, error: null });
    chain.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  return {
    invokes,
    tables,
    state,
    client: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: "token", user: { id: "user-buyer" } } }, error: null }),
        getUser: async () => ({ data: { user: { id: "user-buyer" } }, error: null }),
      },
      functions: {
        invoke: async (fn: string, options?: { body?: Record<string, unknown> }) => {
          const body = (options?.body ?? {}) as Record<string, unknown>;
          invokes.push({ fn, body: JSON.parse(JSON.stringify(body)) });
          return state.responder(fn, body);
        },
      },
      from: (table: string) => {
        tables.push(table);
        return builder(table);
      },
      rpc: async () => ({ data: null, error: null }),
    },
  };
});

vi.mock("@/services/supabaseClient", () => ({ supabase: sb.client, isSupabaseConfigured: true }));
// The app shell (sidebar prefetch, AI drawer) is covered by accessShell.test.tsx.
vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, actions, children }: { title: string; actions?: ReactNode; children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "app-layout" }, React.createElement("h1", null, title), actions, children),
  };
});

import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { principalPageStateKey } from "@/hooks/usePersistedPageState";
import { noteClickHouseReachable, resetClickHouseClientState } from "@/services/clickhouse";
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import { SCOPE_PENDING_POLL_MS } from "@/components/access/ScopeDataPending";
import { RESTRICTED_PAGE_ACTIONS, RESTRICTED_READY_ROUTES } from "../../supabase/functions/_shared/access/scopeReadiness";
import type { FunctionPolicy } from "../../supabase/functions/_shared/access/gate";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import Dashboard from "@/pages/Dashboard";
import CohortsPage from "@/pages/Cohorts";
import FBAnalyticsPage from "@/pages/FBAnalytics";
import FunnelsPage from "@/pages/Funnels";

// ---- the policy registry (one module per Edge function) ------------------------------

const POLICY_MODULES = import.meta.glob<Record<string, unknown>>("../../supabase/functions/_shared/access/policies/*.ts", { eager: true });
const POLICIES = new Map<string, FunctionPolicy<string>>(
  Object.entries(POLICY_MODULES).map(([path, module]) => {
    const fn = path.split("/").pop()!.replace(/\.ts$/, "");
    const policy = module[`${fn.replace(/-/g, "_").toUpperCase()}_POLICY`] as FunctionPolicy<string> | undefined;
    if (!policy) throw new Error(`policies/${fn}.ts exports no policy`);
    return [policy.fn, policy];
  }),
);

/** fn.action of one recorded call, normalized by its function's own policy. */
function canonicalAction(call: { fn: string; body: Record<string, unknown> }): string {
  const policy = POLICIES.get(call.fn);
  if (!policy) return `${call.fn}.<no policy>`;
  try {
    return `${call.fn}.${policy.normalizeAction({ method: "POST", body: call.body, url: new URL(`https://edge.test/functions/v1/${call.fn}`) })}`;
  } catch {
    return `${call.fn}.<rejected by the normalizer>`;
  }
}

function isScopeReady(key: string): boolean {
  const [fn, action] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
  return POLICIES.get(fn)?.actions[action]?.scopeReady === true;
}

const listed = (route: string) => (RESTRICTED_PAGE_ACTIONS[route] ?? []).map((entry) => `${entry.fn}.${entry.action}`).sort();
const recorded = () => [...new Set(sb.invokes.map(canonicalAction))].sort();

/** Every recorded call is scopeReady and listed for the page. */
function expectOnlyListedScopeReadyCalls(route: string) {
  const keys = sb.invokes.map(canonicalAction);
  for (const key of keys) {
    expect(isScopeReady(key), `${route}: ${key} must be scopeReady`).toBe(true);
    expect(listed(route), `${route}: ${key} must be in RESTRICTED_PAGE_ACTIONS`).toContain(key);
  }
  expect(sb.invokes.some((call) => call.fn === "ai-analytics" || call.fn === "clickhouse-payment-analytics")).toBe(false);
}

// ---- access fixtures ----------------------------------------------------------------

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
const PATH_A = "soulmate-sketch";

function buyerRow(): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-buyer-a",
    user_id: USER.id,
    email: USER.email,
    display_name: null,
    is_data_owner: false,
    raw_access: false,
    // The plan's Media Buyer role.
    role: {
      id: "role-mb", key: "media_buyer", name: "Media Buyer", is_owner: false,
      permissions: ["dashboard.view", "cohorts.view", "funnels.view", "facebook_analytics.view", "ai.use"],
    },
    funnel_scope: { mode: "selected", funnel_ids: ["f-a"], paths: [PATH_A] },
    access_version: "4",
    partition: "p-buyer-a",
  };
}
const BUYER_A = (): AccessContextValue => buildAccessValue({ status: "ok", access: buyerRow(), userId: USER.id });

function renderPage(ui: ReactNode) {
  const client = new QueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={AUTH}>
          <AccessContext.Provider value={BUYER_A()}>{ui}</AccessContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// ---- server fixtures (scoped responses, shaped like the restricted ones) ---------------

const ZERO_TYPES = { trial: 0, first_subscription: 0, renewals: 0, upsells: 0, tokens: 0 };

function bundle() {
  const row = {
    date: "2026-10-05", gross: 120, refunds: 0, net: 110, spend: 0, gross_new: 20, gross_existing: 100, gross_unattributed: 0,
    net_new: 18, net_existing: 92, net_unattributed: 0, by_type: { ...ZERO_TYPES, trial: 20, renewals: 100 }, paying_users: 3,
    new_paying_users: 1, profit: 0, cumulative_profit: 0, partial: false,
  };
  return {
    ok: true, source: "clickhouse", action: "bundle", generated_at: "2026-10-06T00:00:00Z", query_duration_ms: 5, bucket: "day",
    date_from: "2026-10-05", date_to: "2026-10-05", buckets: [row], totals: { ...row },
    by_funnel: [{ key: PATH_A, gross: 120, net: 110, gross_new: 20, gross_existing: 100 }], by_plan: [], by_age: [],
    diagnostics: { attributed_pct: 100, future_cohort_gross: 0, snapshot_warehouse_version: "wh", snapshot_classification_version: "cls", rows_scanned: 0, filters_active: true, note: "" },
    meta: { access: { scope: "restricted", dropped_filter_values: 0 } },
  };
}

function aggRow(): CohortAggregateRow {
  return {
    cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: PATH_A,
    trial_users: 10, upsell_users: 3, first_subscription_users: 8, renewal_users: 5,
    renewal_users_by_level: { 2: 5 }, refund_users: 1, support_users: 2, support_rate: 20,
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
    fb_spend: 50, fb_currency: "USD", fb_purchases: 2, fb_cpp: 25,
    fb_impressions: 100, fb_reach: 0, fb_clicks: 10, fb_link_clicks: 0,
    fb_ctr: 10, fb_cpc: 5, fb_cpm: 500, fb_purchase_value: 0, fb_roas: null,
    fb_campaigns_matched: 1, fb_match_status: "matched",
  } as CohortAggregateRow;
}

const COHORTS_LIST = {
  ok: true, source: "clickhouse", action: "list", query_duration_ms: 5,
  rows: [aggRow()],
  diagnostics: {
    snapshot_stale: false, active_snapshot_version: "snap-1", snapshot_generated_at: "2026-10-05T23:00:00Z",
    source_transactions: null, cohort_users: null, current_warehouse_transactions: null, report_complete: true,
    source_warehouse_version: "wh", current_warehouse_version: null, counts_redacted: true, subscription_data_status: "available",
    filters_applied: { country: true, card_type: true, platform: true, campaign_id: true, traffic_source: true, price_plan: true },
  },
  meta: { access: { scope: "restricted", dropped_filter_values: 0 } },
};

const FB_ROW = {
  key: "c1", campaign_id: "c1", campaign_name: "Campaign One", ad_account_id: "act-1", ad_account_name: "Account",
  buyer: "Ivan", adset_id: "", adset_name: "", ad_id: "", ad_name: "", spend: 10, fb_purchases: 1, cpp: 10,
  impressions: 100, clicks: 5, ctr: 5, cpc: 2, cpm: 100, outbound_clicks: 2, outbound_ctr: 2, days: 1,
  blended: { trial_users: 3, cac: 3.33, tx_gross_revenue: 30, tx_net_revenue: 27, roas: 2.7, revenue_per_trial: 9 },
};

const FB_REPORT = {
  ok: true, source: "clickhouse", level: "campaign", query_duration_ms: 3,
  rows: [FB_ROW], charts: [], filter_options: { buyers: [], accounts: [] },
  summary: { spend: 10, fb_purchases: 1, cpp: 10, impressions: 100, clicks: 5, ctr: 5, cpc: 2, cpm: 100, blended: FB_ROW.blended },
  diagnostics: { warehouse_rows: 1, warehouse_rows_in_scope: 1, warehouse_version: "fbv", report_complete: true },
};

const FB_STATUS = {
  ok: true,
  state: { sync_name: "fb", status: "completed", cursor_transaction_id: "x", cursor_updated_at: "2026-09-14T00:00:00Z", finished_at: "2026-09-14T00:00:00Z" },
  diagnostics: { warehouse_rows: 1, warehouse_version: "fbv" },
};

const SUMMARY = {
  connected: true,
  cohort_snapshot_state: { status: "completed", active_warehouse_version: "wh", active_classification_version: "cls", active_generated_at: "2026-10-05T23:00:00Z" },
};

function okResponder(fn: string, body: Record<string, unknown>): { data: unknown; error: unknown } {
  switch (`${fn}:${String(body.action ?? "")}`) {
    case "clickhouse-summary:":
      return { data: SUMMARY, error: null };
    case "clickhouse-revenue:bundle":
      return { data: bundle(), error: null };
    case "clickhouse-revenue:day_breakdown":
      return { data: { ok: true, source: "clickhouse", action: "day_breakdown", generated_at: "", query_duration_ms: 1, date: body.date, gross: 120, by_cohort: [], by_funnel: [] }, error: null };
    case "clickhouse-cohorts:list":
      return { data: COHORTS_LIST, error: null };
    case "clickhouse-cohorts:details":
      return { data: { ok: true, source: "clickhouse", action: "details", price_breakdown: [], currency_breakdown: [], token_pack_breakdown: [] }, error: null };
    case "clickhouse-facebook:status":
      return { data: FB_STATUS, error: null };
    case "clickhouse-facebook:report":
      return { data: FB_REPORT, error: null };
    default:
      // An unexpected call still gets a 403 like the real gate would give it.
      return edgeError(403, "scope_not_supported");
  }
}

function edgeError(status: number, code: string) {
  return {
    data: null,
    error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      name: "FunctionsHttpError",
      context: new Response(JSON.stringify({ ok: false, error_code: code, error: "Funnel-scoped data is being prepared. Please retry in a few minutes.", request_id: "req-1" }), { status }),
    }),
  };
}

/** The scoped snapshot is not ready: every action behind scopeSnapshot answers 409. */
function notReadyResponder(fn: string, body: Record<string, unknown>) {
  if (fn === "clickhouse-summary") return okResponder(fn, body);
  if (["clickhouse-revenue", "clickhouse-cohorts", "clickhouse-facebook"].includes(fn)) return edgeError(409, "scope_snapshot_not_ready");
  return okResponder(fn, body);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sb.invokes.length = 0;
  sb.tables.length = 0;
  sb.state.responder = okResponder;
  sb.state.rows = {
    funnels: [{ id: "f-a", funnel_path: PATH_A, display_name: "Soulmate Sketch", is_active: true, funnel_tags: [], funnel_paths: [{ id: 1, path_canonical: PATH_A, status: "active" }], created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z" }],
    tags: [],
  };
  resetClickHouseClientState();
  noteClickHouseReachable();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- the pages ------------------------------------------------------------------------

describe("restricted-ready pages call only their scopeReady actions (buyer A)", () => {
  it("the contract covers exactly the four restricted-ready pages", () => {
    expect(Object.keys(RESTRICTED_PAGE_ACTIONS).sort()).toEqual([...RESTRICTED_READY_ROUTES].sort());
    for (const route of RESTRICTED_READY_ROUTES) {
      for (const key of listed(route)) expect(isScopeReady(key), key).toBe(true);
    }
  });

  it("/ (Dashboard → Revenue Intelligence, incl. the day drilldown)", async () => {
    renderPage(<Dashboard />);
    await screen.findByTestId("revenue-restricted-note");
    fireEvent.click(screen.getAllByText("2026-10-05")[0]);
    await waitFor(() => expect(recorded()).toContain("clickhouse-revenue.day_breakdown"));
    await act(async () => {});
    expectOnlyListedScopeReadyCalls("/");
    expect(recorded()).toEqual(listed("/"));
    // The member's own (scope-intersected server-side) filters: none saved.
    const bundleCall = sb.invokes.find((call) => call.body.action === "bundle");
    expect(bundleCall?.body.filters).toEqual({ campaign_path: [], price_plan: [] });
  });

  it("/cohorts (list, FB status, the expanded row's details) — no AI pass rates even with ai.use", async () => {
    const row = mapAggregateToCohortRow(aggRow());
    localStorage.setItem(principalPageStateKey("ui_state_cohorts", USER.id), JSON.stringify({ expandedCohortIds: [row.cohort_id] }));
    renderPage(<CohortsPage />);
    await waitFor(() => expect(recorded()).toContain("clickhouse-cohorts.details"), { timeout: 10_000 });
    await act(async () => {});
    expectOnlyListedScopeReadyCalls("/cohorts");
    expect(recorded()).toEqual(listed("/cohorts"));
    // No tenant diagnostics request block, and the details key names the member's own path.
    const list = sb.invokes.find((call) => call.body.action === "list");
    expect(list?.body).not.toHaveProperty("fb_allocation_diagnostics");
    const details = sb.invokes.find((call) => call.body.action === "details");
    expect((details?.body.cohort_key as { campaign_path?: string }).campaign_path).toBe(PATH_A);
    expect(sb.tables).toContain("funnels");
  }, 30_000);

  it("/funnels reads the registry through PostgREST only", async () => {
    renderPage(<FunnelsPage />);
    expect(await screen.findByText("Soulmate Sketch")).toBeInTheDocument();
    await act(async () => {});
    expect(sb.invokes).toEqual([]);
    expect(listed("/funnels")).toEqual([]);
    expect(new Set(sb.tables)).toEqual(new Set(["funnels", "tags"]));
  });

  it("/fb-analytics (warehouse tab) — no AI pass rates even with ai.use and campaign rows", async () => {
    renderPage(<FBAnalyticsPage />);
    expect(await screen.findByText("Campaign One")).toBeInTheDocument();
    await act(async () => {});
    expectOnlyListedScopeReadyCalls("/fb-analytics");
    expect(recorded()).toEqual(listed("/fb-analytics"));
    expect(sb.invokes.find((call) => call.body.action === "report")?.body.level).toBe("campaign");
  });
});

describe("snapshot not ready: the waiting state polls only the same actions", () => {
  async function pollOnce(predicate: () => number) {
    const before = predicate();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCOPE_PENDING_POLL_MS + 1_000);
    });
    await waitFor(() => expect(predicate()).toBeGreaterThan(before));
  }
  const count = (action: string) => () => sb.invokes.filter((call) => call.body.action === action).length;

  it("/ shows the pending card and re-asks the bundle every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sb.state.responder = notReadyResponder;
    renderPage(<Dashboard />);
    expect(await screen.findByTestId("scope-data-pending")).toBeInTheDocument();
    await pollOnce(count("bundle"));
    expectOnlyListedScopeReadyCalls("/");
  });

  it("/cohorts shows the pending state and re-asks the list every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sb.state.responder = notReadyResponder;
    renderPage(<CohortsPage />);
    expect(await screen.findByTestId("scope-data-pending", undefined, { timeout: 10_000 })).toBeInTheDocument();
    await pollOnce(count("list"));
    expectOnlyListedScopeReadyCalls("/cohorts");
  }, 30_000);

  it("/fb-analytics shows the pending state and re-asks the report every minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    sb.state.responder = notReadyResponder;
    renderPage(<FBAnalyticsPage />);
    expect(await screen.findByTestId("scope-data-pending")).toBeInTheDocument();
    await pollOnce(count("report"));
    expectOnlyListedScopeReadyCalls("/fb-analytics");
  });
});
