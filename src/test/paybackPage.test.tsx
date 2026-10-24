// Payback by funnel — the page (/forecasting, spec 2026-10-24 §4, §5, §10),
// rendered with the data hooks mocked. The fixtures are the model test's: cohort
// days with a known per-trial curve, so every verdict below can be checked by
// hand (src/test/ltvPayback.test.ts proves the numbers; this file proves what
// the page shows from them).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: MockResizeObserver });

const h = vi.hoisted(() => ({
  ltv: null as unknown,
  ltvError: null as unknown,
  spendThrough: "2026-09-14" as string | null,
  spendByPath: {} as Record<string, number>,
  ledgerFails: false,
  names: new Map<string, string>(),
  products: null as unknown,
  ledgerWindows: [] as Array<{ from: string; to: string } | null>,
  trendEnabled: [] as boolean[],
  rebuilds: [] as unknown[],
}));

vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, description, actions, children }: { title: string; description?: string; actions?: ReactNode; children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "app-layout" }, React.createElement("h1", null, title), description ? React.createElement("p", null, description) : null, actions, children),
  };
});
vi.mock("@/hooks/useCohortProducts", () => ({ useCohortProducts: () => ({ products: h.products, settled: true }) }));
vi.mock("@/services/cohortSnapshotHealth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/cohortSnapshotHealth")>()),
  ensureCohortSnapshotRebuild: (health: unknown) => {
    h.rebuilds.push(health);
    return "started";
  },
}));
vi.mock("@/hooks/usePayback", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/usePayback")>();
  const ledger = (window: { from: string; to: string }) => ({
    ok: true,
    action: "spend_ledger",
    window,
    spendThrough: h.spendThrough,
    windowLedger: { unknownFunnel: { spend: 120 }, otherUnallocated: { spend: 30 }, knownGapDays: [] },
    funnelLedgers: Object.fromEntries(Object.entries(h.spendByPath).map(([path, spend]) => [path, { funnelResolvedSpend: spend, currency: "USD", currencyMixed: false }])),
  });
  return {
    ...actual,
    usePaybackWarehouseVersion: () => ({ version: "whv_test", ready: true }),
    usePaybackLtv: () => ({ data: h.ltvError ? null : h.ltv, loading: false, refreshing: false, error: h.ltvError, refetch: () => {} }),
    usePaybackLedger: (window: { from: string; to: string } | null) => {
      h.ledgerWindows.push(window);
      return {
        data: window && !h.ledgerFails ? ledger(window) : null,
        loading: false,
        refreshing: false,
        error: h.ledgerFails ? new Error("down") : null,
        refetch: () => {},
        settled: true,
      };
    },
    usePaybackTrendLedgers: (windows: Array<{ from: string; to: string } | null>, enabled: boolean) => {
      h.trendEnabled.push(enabled);
      return windows.map((window) => ({ data: enabled && window ? ledger(window) : null, loading: false, failed: false }));
    },
    usePaybackFunnelNames: () => h.names,
  };
});

import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { PAYBACK_CHECKPOINTS, computePayback, paybackLedgerWindow, paybackSpendFromLedger } from "@/services/ltvPayback";
import { buildPaybackExportTable, paybackExportFileName } from "@/components/payback/paybackView";
import { InfoTip } from "@/components/payback/InfoTip";
import { PAYBACK_ROAS_MARKS, fmtMoney, fmtRoas, fmtShare, thresholdSafePct } from "@/components/payback/paybackFormat";
import { paybackStatusInfo, paybackStatusLabel } from "@/components/payback/paybackCopy";
import { PaybackLtvError, PAYBACK_SNAPSHOT_NOT_READY } from "@/hooks/usePayback";
import { readPaybackUrl, writePaybackUrl, paybackPeriodWindow, paybackLtvRange } from "@/components/payback/paybackState";
import { tableToCsv } from "@/lib/tableExport";
import ForecastingPage from "@/pages/Forecasting";
import type { CohortLtvRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

// ---- fixtures ---------------------------------------------------------------------------

const DAY = 86_400_000;
const DT = "2026-10-20T12:00:00.000Z";
const C = PAYBACK_CHECKPOINTS;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY);

type Curve = (day: number) => number;
/** Monthly plan: $1 trial, $29.99 at day 3, renewals at days 33 and 63. */
const monthly: Curve = (day) => 1 + (day >= 3 ? 29.99 : 0) + (day >= 33 ? 29.99 : 0) + (day >= 63 ? 29.99 : 0);
/** Weekly plan: $1 trial, $6.99 at day 3 and every 7 days after. */
const weekly: Curve = (day) => 1 + (day >= 3 ? 6.99 * (Math.floor((day - 3) / 7) + 1) : 0);

function cohortRows(path: string, from: string, to: string, trials: number, curve: Curve): CohortLtvRow[] {
  const rows: CohortLtvRow[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const age = daysBetween(date, DT.slice(0, 10));
    rows.push({ cohort_date: date, campaign_path: path, trial_users: trials, rev: C.map((day) => trials * curve(Math.min(day, age))) });
  }
  return rows;
}

function ltvResponse(rows: CohortLtvRow[]) {
  return {
    ok: true,
    source: "clickhouse",
    action: "ltv",
    generated_at: DT,
    query_duration_ms: 1,
    checkpoints: [...C],
    data_through: DT,
    range: { from: "2026-01-01", to: "2026-10-31", requested_from: null, requested_to: null, capped: false },
    rows,
    diagnostics: { active_snapshot_version: "snap", snapshot_generated_at: null, rows: rows.length, trial_users: 0 },
  };
}

// July, with spend through Sep 14 (spec §10): every July trial is paired with spend.
//   alpha   20/day monthly, spend 15 000 → ×1.04 = 15 600; LTV d30 30.99 → 620 × 30.99 / 15 600 = 123 % → Month 1
//   epsilon 10/day monthly, spend 11 000 → 11 440;       310 × 30.99 / 11 440 = 84 % (amber), d60 165 % → Month 2
//   beta    10/day weekly,  spend 40 000 → 41 600;       d90 310 × 91.87 / 41 600 = 68 % → Not within 3 months
//   gamma   1/day monthly (31 trials < 50)                → the small-funnel fold
//   delta   20/day, October only (after spend_through)    → No spend data in an Aug–Oct period
const ROWS = [
  ...cohortRows("alpha", "2026-01-01", "2026-10-19", 20, monthly),
  ...cohortRows("epsilon", "2026-01-01", "2026-10-19", 10, monthly),
  ...cohortRows("beta", "2026-01-01", "2026-10-19", 10, weekly),
  ...cohortRows("gamma", "2026-07-01", "2026-07-31", 1, monthly),
  ...cohortRows("delta", "2026-10-01", "2026-10-19", 20, monthly),
];
const SPEND = { alpha: 15_000, epsilon: 11_000, beta: 40_000, gamma: 500 };
const JULY = "?period=custom&from=2026-07&to=2026-07";

/** The model's answer for July, as the page computes it (fee on unless said). */
function julyResult(agencyFee?: { enabled: boolean; rate: number }) {
  const window = { from: "2026-07-01", to: "2026-07-31" };
  const spend = paybackSpendFromLedger({
    window: paybackLedgerWindow(window, DT)!,
    windowLedger: { unknownFunnel: { spend: 0 }, otherUnallocated: { spend: 0 }, knownGapDays: [] } as never,
    funnelLedgers: Object.fromEntries(Object.entries(SPEND).map(([path, value]) => [path, { funnelResolvedSpend: value, currency: "USD", currencyMixed: false }])),
    spendThrough: "2026-09-14",
  });
  return computePayback({ ltv: ltvResponse(ROWS) as never, window, spend, agencyFee });
}

// ---- access + render ----------------------------------------------------------------------

const USER: AuthUser = { id: "user-a", email: "a@example.com", provider: "supabase" };
const AUTH: AuthContextValue = {
  configured: true, supabaseConfigured: true, localAuthEnabled: false, mode: "supabase", loading: false,
  session: null, user: USER, signIn: async () => {}, signOut: async () => {},
};

function okRow(permissions: string[], isOwner = false): MyAccess {
  return {
    status: "ok", workspace_id: "ws-1", member_id: "member-a", user_id: USER.id, email: USER.email, display_name: null,
    is_data_owner: isOwner, raw_access: isOwner,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: isOwner, permissions },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] }, access_version: "1", partition: isOwner ? "p-owner" : "p-member",
  };
}
const OWNER = () => buildAccessValue({ status: "ok", access: okRow([], true), userId: USER.id });
const member = (permissions: string[]) => buildAccessValue({ status: "ok", access: okRow(permissions), userId: USER.id });

let currentSearch = "";
function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

function renderPage(search: string, access: AccessContextValue = OWNER()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/forecasting${search}`]}>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={AUTH}>
          <AccessContext.Provider value={access}>
            <Routes>
              <Route path="/forecasting" element={<><ForecastingPage /><LocationProbe /></>} />
            </Routes>
          </AccessContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

const funnelRows = () => screen.getAllByTestId("payback-row-funnel");
const rowFor = (key: string) => screen.getAllByTestId(/^payback-row-/).find((row) => row.getAttribute("data-key") === key)!;
const verdictOf = (key: string) => within(rowFor(key)).getByTestId("payback-verdict");
const monthCell = (key: string, month: 1 | 2 | 3) => within(rowFor(key)).getByTestId(`payback-m${month}`);

beforeEach(() => {
  // Only Date is faked: "today" decides the presets, nothing else waits on timers.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-21T09:00:00.000Z"));
  h.ltv = ltvResponse(ROWS);
  h.ltvError = null;
  h.spendThrough = "2026-09-14";
  h.spendByPath = { ...SPEND };
  h.ledgerFails = false;
  h.names = new Map([["alpha", "Alpha quiz"]]);
  h.products = null;
  h.ledgerWindows = [];
  h.trendEnabled = [];
  h.rebuilds = [];
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---- URL state ------------------------------------------------------------------------------

describe("URL state", () => {
  it("round-trips every param and leaves the defaults out", () => {
    const state = readPaybackUrl(new URLSearchParams("product=p1&product=p2&funnel=a&funnel=b&period=custom&from=2026-05&to=2026-07&sort=m2-asc&open=a&show=ltv&fee=off&other=1"));
    expect(state).toEqual({
      products: ["p1", "p2"], funnels: ["a", "b"], period: "custom", fromMonth: "2026-05", toMonth: "2026-07",
      sort: { key: "m2", dir: "asc" }, open: "a", show: "ltv", agencyFee: false,
    });
    const written = writePaybackUrl(state, new URLSearchParams("other=1"));
    expect(readPaybackUrl(written)).toEqual(state);
    expect(written.get("other")).toBe("1");
    expect(writePaybackUrl(readPaybackUrl(new URLSearchParams())).toString()).toBe("");
    // One empty funnel value = no funnel picked (absent = every funnel).
    expect(readPaybackUrl(new URLSearchParams("funnel=")).funnels).toEqual([]);
    expect(writePaybackUrl({ ...readPaybackUrl(new URLSearchParams()), funnels: [] }).toString()).toBe("funnel=");
  });

  it("presets end today; custom months are whole months cut at today and capped at 12", () => {
    expect(paybackPeriodWindow({ period: "30d", fromMonth: null, toMonth: null }, "2026-10-21").window).toEqual({ from: "2026-09-22", to: "2026-10-21" });
    expect(paybackPeriodWindow({ period: "custom", fromMonth: "2026-08", toMonth: "2026-10" }, "2026-10-21").window).toEqual({ from: "2026-08-01", to: "2026-10-21" });
    expect(paybackPeriodWindow({ period: "custom", fromMonth: "2026-09", toMonth: "2026-08" }, "2026-10-21").problem).toBe("start_after_end");
    expect(paybackPeriodWindow({ period: "custom", fromMonth: "2025-01", toMonth: "2026-01" }, "2026-10-21").problem).toBe("too_long");
    // The server read is widened back to the first of the six trend months.
    expect(paybackLtvRange({ from: "2026-07-01", to: "2026-07-31" })).toEqual({ from: "2026-02-01", to: "2026-07-31" });
  });
});

// ---- table ---------------------------------------------------------------------------------

describe("Payback table", () => {
  it("one row per funnel by spend, verdicts and tints by spec §1, Total pinned, small funnels folded", () => {
    renderPage(JULY);
    expect(screen.getByRole("heading", { name: "Payback by funnel" })).toBeInTheDocument();
    expect(funnelRows().map((row) => row.getAttribute("data-key"))).toEqual(["beta", "alpha", "epsilon"]);

    expect(verdictOf("alpha")).toHaveTextContent(/^Month 1$/);
    expect(verdictOf("alpha")).toHaveAttribute("data-tone", "good");
    expect(verdictOf("epsilon")).toHaveTextContent(/^Month 2$/);
    expect(verdictOf("beta")).toHaveTextContent("Not within 3 months · 68% back");
    expect(verdictOf("beta")).toHaveAttribute("data-tone", "bad");

    expect(monthCell("alpha", 1)).toHaveAttribute("data-tint", "good");
    expect(monthCell("alpha", 1)).toHaveTextContent("123%");
    expect(monthCell("epsilon", 1)).toHaveAttribute("data-tint", "warn");
    expect(monthCell("epsilon", 1)).toHaveTextContent("84%");
    expect(monthCell("beta", 1)).toHaveAttribute("data-tint", "none");
    // Month 3: only the cohort days up to Jul 20 are 90 (+2) days old → "≈", dotted.
    const alphaM3 = within(monthCell("alpha", 3)).getByTestId("payback-month-value");
    expect(alphaM3).toHaveAttribute("data-approx", "true");
    expect(alphaM3.textContent).toMatch(/^≈ /);
    expect(within(monthCell("alpha", 1)).getByTestId("payback-month-value")).toHaveAttribute("data-approx", "false");

    // The registry name, the path in muted text; Total on top; the small fold last.
    expect(within(rowFor("alpha")).getByText("Alpha quiz")).toBeInTheDocument();
    expect(within(rowFor("alpha")).getByText("alpha")).toBeInTheDocument();
    const bodyRows = within(screen.getByTestId("payback-table")).getAllByRole("row").slice(1);
    expect(bodyRows[0]).toHaveAttribute("data-key", "__total__");
    expect(bodyRows.at(-1)).toHaveAttribute("data-key", "__small_funnels__");
    expect(screen.queryByTestId("payback-row-member")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show small funnels" }));
    expect(screen.getAllByTestId("payback-row-member").map((row) => row.getAttribute("data-key"))).toEqual(["gamma"]);

    // Spend no funnel claims is a line under the table, never a row (all funnels).
    expect(screen.getByTestId("payback-unlinked")).toHaveTextContent("+$150 Facebook spend not linked to a funnel");
    // No banner: July is fully inside the loaded Facebook spend.
    expect(screen.queryByTestId("payback-spend-banner")).toBeNull();
    expect(screen.getByText("Payments through Oct 20, 2026")).toBeInTheDocument();
    expect(screen.getByText("Facebook through Sep 14, 2026")).toBeInTheDocument();
  });

  it("KPIs are the Total row: spend with the 4% fee, trials, cost per trial, back by month 3", () => {
    renderPage(JULY);
    const kpis = screen.getByTestId("payback-kpis");
    // 15 600 + 11 440 + 41 600 + 520 (gamma 500 × 1.04)
    expect(within(kpis).getByText("$69,160")).toBeInTheDocument();
    expect(within(kpis).getByText("incl. 4% agency fee")).toBeInTheDocument();
    expect(within(kpis).getByText("1,271")).toBeInTheDocument();
    expect(within(kpis).getAllByRole("button", { name: /^About / })).toHaveLength(5);
  });

  it("Back by month 3 puts the real money next to a partly projected share: received so far, never the projection", () => {
    const { total } = julyResult();
    // Month 3 is partly projected in July (only days to Jul 20 are 90 + 2 days old)...
    expect(total.months[2].approx).toBe(true);
    // ...and the weekly funnel has not paid all of it yet.
    expect(total.collected).toBeLessThan(total.months[2].revenue!);
    renderPage(JULY);
    const kpis = screen.getByTestId("payback-kpis");
    expect(within(kpis).getByText(`${fmtMoney(total.collected)} received so far of $69,160`)).toBeInTheDocument();
    expect(within(kpis).queryByText(fmtMoney(total.months[2].revenue), { exact: false })).toBeNull();
    // The payback day is a drilldown figure (spec §1).
    expect(within(kpis).queryByText(/day \d+/)).toBeNull();
  });

  it("the agency fee switch and the sort live in the URL", () => {
    renderPage(JULY);
    fireEvent.click(screen.getByRole("switch", { name: "Agency fee 4%" }));
    expect(new URLSearchParams(currentSearch).get("fee")).toBe("off");
    expect(within(screen.getByTestId("payback-kpis")).getByText("$66,500")).toBeInTheDocument();
    expect(within(screen.getByTestId("payback-kpis")).getByText("no agency fee")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sort by Trials" }));
    expect(new URLSearchParams(currentSearch).get("sort")).toBe("trials-desc");
    // 620 first; the two 310s by path.
    expect(funnelRows().map((row) => row.getAttribute("data-key"))).toEqual(["alpha", "beta", "epsilon"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Payback" }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by Payback" }));
    expect(new URLSearchParams(currentSearch).get("sort")).toBe("payback-asc");
    expect(funnelRows().map((row) => row.getAttribute("data-key"))).toEqual(["alpha", "epsilon", "beta"]);
  });

  it("the revenue-per-trial view shows LTV per trial in the same cells", () => {
    renderPage(`${JULY}&show=ltv`);
    expect(monthCell("alpha", 1)).toHaveTextContent("$30.99");
    expect(monthCell("alpha", 1)).toHaveAttribute("data-tint", "good");
  });

  it("exports the visible table: Total, the funnels in the shown order, the fold, and its funnels once unfolded", () => {
    const window = { from: "2026-07-01", to: "2026-07-31" };
    const ledgerWindow = paybackLedgerWindow(window, DT)!;
    const spend = paybackSpendFromLedger({
      window: ledgerWindow,
      windowLedger: { unknownFunnel: { spend: 0 }, otherUnallocated: { spend: 0 }, knownGapDays: [] } as never,
      funnelLedgers: Object.fromEntries(Object.entries(SPEND).map(([path, value]) => [path, { funnelResolvedSpend: value, currency: "USD", currencyMixed: false }])),
      spendThrough: "2026-09-14",
    });
    const result = computePayback({ ltv: ltvResponse(ROWS) as never, window, spend });
    const names = new Map([["alpha", "Alpha quiz"]]);
    const folded = buildPaybackExportTable(result, { sort: { key: "spend", dir: "desc" }, show: "back", names, smallOpen: false });
    // The spend headers say whether the agency fee is in; no payback day column (drilldown only).
    expect(folded.headers.slice(0, 6)).toEqual(["Funnel", "Campaign path", "Trials", "Newer trials not evaluated", "Spend incl. 4% agency fee", "Cost per trial incl. 4% agency fee"]);
    expect(folded.headers.at(-1)).toBe("Payback");
    expect(folded.headers.some((header) => /day/i.test(header))).toBe(false);
    expect(folded.rows.map((row) => row[0])).toEqual(["Total", "beta", "Alpha quiz", "epsilon", "Small funnels"]);
    const alpha = folded.rows[2];
    expect(alpha.slice(1, 6)).toEqual(["alpha", 620, 0, 15600, 25.16]);
    // Month 1: revenue per trial, % of cost back, not projected; the verdict as on screen.
    expect(alpha.slice(6, 9)).toEqual([30.99, 123.2, ""]);
    expect(alpha.at(-1)).toBe("Month 1");
    const noFee = buildPaybackExportTable(julyResult({ enabled: false, rate: 0.04 }), { sort: { key: "spend", dir: "desc" }, show: "back", names, smallOpen: false });
    expect(noFee.headers.slice(4, 6)).toEqual(["Spend, no agency fee", "Cost per trial, no agency fee"]);
    // The file name carries the period.
    expect(paybackExportFileName(window)).toBe("payback-by-funnel-2026-07-01_2026-07-31");
    const unfolded = buildPaybackExportTable(result, { sort: { key: "spend", dir: "desc" }, show: "back", names, smallOpen: true });
    expect(unfolded.rows.map((row) => row[0])).toEqual(["Total", "beta", "Alpha quiz", "epsilon", "Small funnels", "gamma"]);
    // CSV quoting for the download.
    expect(tableToCsv({ headers: ["Funnel", "Spend"], rows: [["Total, all", 1]] })).toBe('Funnel,Spend\n"Total, all",1');

    renderPage(JULY);
    expect(screen.getByRole("button", { name: /Export/ })).toBeInTheDocument();
  });
});

// ---- spend_through (spec §10) -----------------------------------------------------------------

describe("Facebook spend coverage", () => {
  it("the 30-day preset after the last day of spend: the trials are shown as not evaluated, never as \"+N newer\" on top", () => {
    renderPage("?period=30d");
    const kpis = screen.getByTestId("payback-kpis");
    // Sep 22 – Oct 19 trials: alpha 560 + epsilon 280 + beta 280 + delta 380, all after Sep 14.
    expect(within(kpis).getByText("1,500")).toBeInTheDocument();
    expect(within(kpis).getByText("None evaluated yet: all after Sep 14, 2026")).toBeInTheDocument();
    expect(within(kpis).queryByText(/newer, not evaluated/)).toBeNull();
    expect(screen.getByTestId("payback-after-spend")).toHaveTextContent(
      "All 1,500 trials of these funnels are after Sep 14, 2026 (the last day of Facebook spend), so none can be evaluated yet.",
    );
    // An export does not count them a second time as newer trials.
    const window = { from: "2026-09-22", to: "2026-10-21" };
    const spend = paybackSpendFromLedger({
      window: paybackLedgerWindow(window, DT)!,
      windowLedger: { unknownFunnel: { spend: 0 }, otherUnallocated: { spend: 0 }, knownGapDays: [] } as never,
      funnelLedgers: {},
      spendThrough: "2026-09-14",
    });
    const table = buildPaybackExportTable(computePayback({ ltv: ltvResponse(ROWS) as never, window, spend }), { sort: { key: "spend", dir: "desc" }, show: "back", names: new Map(), smallOpen: false });
    expect(table.rows[0].slice(2, 4)).toEqual([1_500, ""]);
  });

  it("a mixed period: every trial after spend_through is counted once as newer, the funnels that only have later ones included", () => {
    renderPage("?period=custom&from=2026-08&to=2026-10");
    // Sep 15 – Oct 19 (35 days): alpha 700 + epsilon 350 + beta 350, and all 380 of delta.
    expect(within(screen.getByTestId("payback-kpis")).getByText("+1,780 newer, not evaluated")).toBeInTheDocument();
    expect(screen.getByTestId("payback-after-spend")).toHaveTextContent("1,780 newer trials of these funnels, after Sep 14, 2026");
  });

  it("a banner when spend ends before the payments; funnels after it are No spend data, never $0", () => {
    renderPage("?period=custom&from=2026-08&to=2026-10");
    expect(screen.getByTestId("payback-spend-banner")).toHaveTextContent(
      "Facebook spend is loaded only through Sep 14, 2026; newer funnels cannot be evaluated yet.",
    );
    expect(verdictOf("delta")).toHaveTextContent("No spend data");
    expect(verdictOf("delta")).toHaveAttribute("data-tone", "muted");
    expect(within(rowFor("delta")).getAllByText("—").length).toBeGreaterThan(0);
    // The ledger is read for [from, data_through], never for days without payments.
    expect(h.ledgerWindows.filter(Boolean).at(-1)).toEqual({ from: "2026-08-01", to: "2026-10-20" });
    // Trials after Sep 14 are counted apart, not paired with spend.
    expect(screen.getByTestId("payback-after-spend")).toHaveTextContent(/newer trials of these funnels, after Sep 14, 2026/);
  });

  it("no Facebook spend at all, or a failed ledger, says so instead of showing $0", () => {
    h.spendThrough = null;
    renderPage(JULY);
    expect(screen.getByTestId("payback-spend-banner")).toHaveTextContent("No Facebook spend is loaded yet");
    expect(verdictOf("alpha")).toHaveTextContent("No spend data");
    cleanup();

    h.spendThrough = "2026-09-14";
    h.ledgerFails = true;
    renderPage(JULY);
    expect(screen.getByTestId("payback-spend-banner")).toHaveTextContent("Facebook spend could not be loaded");
    expect(within(screen.getByTestId("payback-spend-banner")).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(verdictOf("beta")).toHaveTextContent("No spend data");
  });

  it("a trial with no spend linked is No spend data, not infinite payback", () => {
    h.spendByPath = { ...SPEND, alpha: 0 };
    renderPage(JULY);
    expect(verdictOf("alpha")).toHaveTextContent("No spend data");
  });
});

// ---- drilldown -------------------------------------------------------------------------------

describe("Payback drilldown", () => {
  it("opens from a row, keeps the open funnel in the URL, and shows break-even, months, trend and sources", async () => {
    renderPage(JULY);
    expect(h.trendEnabled.every((enabled) => !enabled)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Open details for Alpha quiz" }));
    expect(new URLSearchParams(currentSearch).get("open")).toBe("alpha");
    const sheet = await screen.findByTestId("payback-sheet");
    expect(within(sheet).getByText("Alpha quiz")).toBeInTheDocument();
    expect(within(sheet).getByTestId("payback-curve")).toBeInTheDocument();
    // Break-even cost per trial = revenue per trial by day 30 / 60 / 90.
    const breakEven = within(sheet).getByTestId("payback-break-even");
    expect(breakEven).toHaveTextContent("$30.99");
    expect(breakEven).toHaveTextContent("$60.98");
    // Six trial months, lazily paired with their own ledger once the sheet is open.
    expect(within(sheet).getAllByTestId("payback-trend-row")).toHaveLength(6);
    expect(h.trendEnabled.at(-1)).toBe(true);
    fireEvent.click(within(sheet).getByRole("button", { name: "Where these numbers come from" }));
    const sources = within(sheet).getByTestId("payback-sources");
    expect(sources).toHaveTextContent("Facebook spend $15,000, plus the 4% agency fee: $15,600.");
    expect(sources).toHaveTextContent("projected from this funnel's own older trials");
  });

  it("the what-if cost per trial is local and marked as not saved", async () => {
    renderPage(`${JULY}&open=alpha`);
    const sheet = await screen.findByTestId("payback-sheet");
    const whatIf = within(sheet).getByTestId("payback-what-if");
    expect(within(whatIf).queryByText("what-if, not saved")).toBeNull();
    fireEvent.change(within(whatIf).getByLabelText("What-if cost per trial in US dollars"), { target: { value: "40" } });
    // $40 a trial: 30.99 / 40 = 77 % by month 1, 152 % by month 2 → Month 2.
    expect(within(whatIf).getByText("what-if, not saved")).toBeInTheDocument();
    const outcome = within(whatIf).getByTestId("payback-what-if-result");
    expect(outcome).toHaveTextContent("Month 1: 77%");
    expect(within(outcome).getByTestId("payback-verdict")).toHaveTextContent(/^Month 2$/);
    // Nothing reaches the URL; the table keeps the real verdict.
    expect(currentSearch).not.toMatch(/40/);
    expect(verdictOf("alpha")).toHaveTextContent(/^Month 1$/);
  });

  it("opens with no tooltip showing and closes on one Escape", async () => {
    renderPage(`${JULY}&open=alpha`);
    const sheet = await screen.findByTestId("payback-sheet");
    expect(document.activeElement).toBe(sheet);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(new URLSearchParams(currentSearch).get("open")).toBeNull();
  });

  it("the subtitle: an unnamed funnel shows only the period, Total how many funnels", async () => {
    renderPage(`${JULY}&open=beta`);
    let sheet = await screen.findByTestId("payback-sheet");
    expect(within(sheet).getByText("Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
    expect(within(sheet).queryByText(/1 funnel/)).toBeNull();
    cleanup();
    renderPage(`${JULY}&open=__total__`);
    sheet = await screen.findByTestId("payback-sheet");
    expect(within(sheet).getByText("4 funnels · Jul 1, 2026 – Jul 31, 2026")).toBeInTheDocument();
  });

  it("the curve's key says what solid, dashed and the cost line are", async () => {
    renderPage(`${JULY}&open=alpha`);
    const legend = within(await screen.findByTestId("payback-sheet")).getByTestId("payback-curve-legend");
    expect(legend).toHaveTextContent("Revenue per trial");
    expect(legend).toHaveTextContent("Partly projected");
    expect(legend).toHaveTextContent("Cost per trial");
    expect(legend).not.toHaveTextContent("What-if cost");
  });

  it("a funnel with only trials after the spend shows its trials and why there is no verdict", async () => {
    renderPage("?period=custom&from=2026-08&to=2026-10&open=delta");
    const sheet = await screen.findByTestId("payback-sheet");
    expect(within(sheet).getByTestId("payback-no-spend")).toHaveTextContent("These trials started after the last day of loaded Facebook spend.");
  });
});

// ---- cohort snapshot freshness ----------------------------------------------------------------

describe("a stale cohort snapshot", () => {
  it("cuts trials and spend at the snapshot's newest trial, says so, and starts one background rebuild", () => {
    h.ltv = { ...ltvResponse(ROWS), members_through: "2026-10-17T09:00:00.000Z", snapshot_stale: true, diagnostics: { ...ltvResponse(ROWS).diagnostics, active_snapshot_version: "wh_old:cls", current_warehouse_version: "wh_new" } };
    h.spendThrough = "2026-10-19";
    renderPage("?period=30d");
    expect(screen.getByTestId("payback-refreshing")).toHaveTextContent("Cohort data is refreshing, so trials after Oct 17, 2026 are not counted yet.");
    // The ledger is read for the same days as the trials.
    expect(h.ledgerWindows.filter(Boolean).at(-1)).toEqual({ from: "2026-09-22", to: "2026-10-17" });
    expect(h.rebuilds.at(-1)).toMatchObject({ status: "stale", snapshotWarehouseVersion: "wh_old", currentWarehouseVersion: "wh_new" });
  });

  it("a current snapshot: no note, no rebuild, the ledger to data_through", () => {
    h.ltv = { ...ltvResponse(ROWS), members_through: "2026-10-17T09:00:00.000Z", snapshot_stale: false };
    renderPage("?period=30d");
    expect(screen.queryByTestId("payback-refreshing")).toBeNull();
    expect(h.ledgerWindows.filter(Boolean).at(-1)).toEqual({ from: "2026-09-22", to: "2026-10-20" });
    expect(h.rebuilds).toEqual([]);
  });
});

// ---- formatting and small parts ------------------------------------------------------------------

describe("decision percentages never round onto a threshold they are below", () => {
  it("ROAS at 100 % and 80 %, observed share at 50 %, 95 % and 100 %", () => {
    expect([fmtRoas(0.996), fmtRoas(1), fmtRoas(0.796), fmtRoas(0.8), fmtRoas(1.234), fmtRoas(null)]).toEqual(["99%", "100%", "79%", "80%", "123%", "—"]);
    expect(paybackStatusLabel({ kind: "not_within", roas: 0.996, approx: false })).toBe("Not within 3 months · 99% back");
    expect([fmtShare(0.497), fmtShare(0.5), fmtShare(0.949), fmtShare(0.95), fmtShare(0.996), fmtShare(1)]).toEqual(["49%", "50%", "94%", "95%", "99%", "100%"]);
    expect(paybackStatusInfo({ kind: "too_early", observedShare: 0.498 })).toBe("Only 49% of these trials are 30 days old. Check back later.");
    // The export keeps one decimal, with the same rule.
    expect([thresholdSafePct(0.99996, PAYBACK_ROAS_MARKS, 1), thresholdSafePct(0.79996, PAYBACK_ROAS_MARKS, 1), thresholdSafePct(1.2318, PAYBACK_ROAS_MARKS, 1)]).toEqual([99.9, 79.9, 123.2]);
  });
});

describe("InfoTip", () => {
  it("a tap opens it and a second tap closes it", () => {
    render(<InfoTip label="About spend">Facebook spend of these funnels.</InfoTip>);
    const button = screen.getByRole("button", { name: "About spend" });
    const tap = () => {
      fireEvent.pointerDown(button, { pointerType: "touch" });
      fireEvent.pointerUp(button, { pointerType: "touch" });
      fireEvent.click(button);
    };
    tap();
    expect(screen.getByRole("tooltip")).toHaveTextContent("Facebook spend of these funnels.");
    tap();
    expect(screen.queryByRole("tooltip")).toBeNull();
    tap();
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
  });
});

// ---- states ------------------------------------------------------------------------------------

describe("Payback states", () => {
  it("snapshot not ready, an empty period, and no funnel picked", () => {
    h.ltvError = new PaybackLtvError(PAYBACK_SNAPSHOT_NOT_READY);
    renderPage(JULY);
    expect(screen.getByText("Cohort data is still being prepared. Try again in a few minutes.")).toBeInTheDocument();
    cleanup();

    h.ltvError = null;
    h.ltv = ltvResponse([]);
    h.spendByPath = {};
    renderPage(JULY);
    expect(screen.getByText("No trials in this period.")).toBeInTheDocument();
    cleanup();

    h.ltv = ltvResponse(ROWS);
    h.spendByPath = { ...SPEND };
    renderPage(`${JULY}&funnel=`);
    expect(screen.getByText("No funnel is picked. Choose funnels above.")).toBeInTheDocument();
  });

  it("a funnel pick narrows rows and Total; the unlinked line is for all funnels only", () => {
    renderPage(`${JULY}&funnel=alpha&funnel=beta`);
    expect(funnelRows().map((row) => row.getAttribute("data-key"))).toEqual(["beta", "alpha"]);
    expect(within(rowFor("__total__")).getByText("2 funnels")).toBeInTheDocument();
    expect(screen.queryByTestId("payback-unlinked")).toBeNull();
  });

  it("the page never pulls the browser warehouse in (spec §4: no useTransactions, computeCohorts or traffic metrics)", () => {
    const sources = [
      "src/pages/Forecasting.tsx",
      "src/hooks/usePayback.ts",
      ...readdirSync(resolve(process.cwd(), "src/components/payback")).map((file) => `src/components/payback/${file}`),
    ];
    for (const file of sources) {
      // Code only: the header comments name what the page does not do.
      const text = readFileSync(resolve(process.cwd(), file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // Identifiers from a word start ("warehouseTransactions" is not useTransactions;
      // computeCohortsWithDiagnostics still is computeCohorts), module paths as written.
      for (const banned of ["useTransactions", "computeCohorts", "trafficMetrics"]) {
        expect(new RegExp(`\\b${banned}`).test(text), `${file} uses ${banned}`).toBe(false);
      }
      for (const banned of ["@/services/sheets", "@/store/dataStore", "@/services/analytics\""]) {
        expect(text.includes(banned), `${file} uses ${banned}`).toBe(false);
      }
    }
  });

  it("the Old planner link is there for forecasting.create only", () => {
    renderPage(JULY, member(["forecasting.view"]));
    expect(screen.queryByRole("link", { name: "Old planner" })).toBeNull();
    cleanup();
    renderPage(JULY, member(["forecasting.view", "forecasting.create"]));
    expect(screen.getByRole("link", { name: "Old planner" })).toHaveAttribute("href", "/forecasting/legacy");
  });
});

