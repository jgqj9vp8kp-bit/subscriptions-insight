// Dashboard "Daily trials" card (components/TrialsDailySection.tsx) with the
// query hook mocked: the compact default (All row + 8 rows + Other + Unknown),
// the view switch that never re-asks the server, the one-line states (owner
// not-ready, restricted 409 pending, errors, empty), the restricted copy, the
// pinned-day line and the rule that no raw YYYY-MM-DD is ever visible text.
// Also: the cut-off fragment against a fixed clock, the restricted-only paths
// (forced filters_active, out-of-scope saved funnels, scoped options), captions
// that follow the displayed response, and the week paths (server week grain,
// the on-screen fold at a narrow width).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/** The card's measure callbacks: a test re-measures after changing the width. */
const resizeCallbacks: Array<() => void> = [];
class MockResizeObserver {
  constructor(callback: () => void) {
    resizeCallbacks.push(callback);
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: MockResizeObserver });
// Radix Select in jsdom.
Element.prototype.scrollIntoView = function scrollIntoView() {};
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;

const h = vi.hoisted(() => ({
  result: null as unknown,
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/useRevenueTrials", () => ({
  useRevenueTrials: (params: { request: Record<string, unknown> }) => {
    h.requests.push(params.request);
    return h.result;
  },
}));
vi.mock("@/hooks/useAnalyticsCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWarehouseVersion: () => ({ version: "whv_test", ready: true }),
}));

import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { SCOPE_SNAPSHOT_NOT_READY } from "@/components/access/ScopeDataPending";
import { principalPageStateKey } from "@/hooks/usePersistedPageState";
import { TrialsDailySection } from "@/components/TrialsDailySection";
import type { RevenueTrialsDaily, RevenueTrialsRow, TrialsBucketState } from "@/services/revenueIntelligence";

const USER: AuthUser = { id: "user-trials", email: "trials@example.test", provider: "supabase" };
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

function accessRow(input: { raw?: boolean; scope?: { mode: "all" | "selected"; funnel_ids: string[]; paths: string[] } }): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-1",
    user_id: USER.id,
    email: USER.email,
    display_name: null,
    is_data_owner: input.raw === true,
    raw_access: input.raw === true,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: input.raw === true, permissions: ["dashboard.view", "cohorts.view"] },
    funnel_scope: input.scope ?? { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: input.raw ? "p-owner" : "p-member",
  };
}
const OWNER = () => buildAccessValue({ status: "ok", access: accessRow({ raw: true }), userId: USER.id });
/** All funnels, but no raw access (so no /import). */
const MEMBER = () => buildAccessValue({ status: "ok", access: accessRow({}), userId: USER.id });
const BUYER = () => buildAccessValue({ status: "ok", access: accessRow({ scope: { mode: "selected", funnel_ids: ["f-a"], paths: ["path-01"] } }), userId: USER.id });

function renderCard(access: AccessContextValue = OWNER()) {
  const client = new QueryClient();
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={AUTH}>
          <AccessContext.Provider value={access}>
            <TrialsDailySection />
          </AccessContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

// ---- fixture response -------------------------------------------------------------

function addDays(day: string, days: number): string {
  const dateObj = new Date(`${day}T00:00:00Z`);
  dateObj.setUTCDate(dateObj.getUTCDate() + days);
  return dateObj.toISOString().slice(0, 10);
}

const AXIS = Array.from({ length: 14 }, (_value, index) => addDays("2026-10-02", index));
const STATE: TrialsBucketState[] = AXIS.map((_day, index) => (index < 12 ? "complete" : index === 12 ? "partial" : "no_data"));

function rowOf(key: string, cells: number[], prev: number, mix: RevenueTrialsRow["mix"] = []): RevenueTrialsRow {
  return { key, trials: cells.reduce((sum, value) => sum + value, 0), prev_trials: prev, cells, mix, mix_unknown: 0 };
}

function perDay(value: number): number[] {
  return STATE.map((state) => (state === "no_data" ? 0 : value));
}

function response(overrides: Partial<RevenueTrialsDaily> = {}): RevenueTrialsDaily {
  const byFunnel = [
    ...Array.from({ length: 12 }, (_value, index) => {
      const cells = perDay(12 - index);
      return rowOf(`path-${String(index + 1).padStart(2, "0")}`, cells, 120 - index, [{ key: "MX", trials: cells.reduce((sum, value) => sum + value, 0) }]);
    }),
    rowOf("Unknown", perDay(1), 10),
  ];
  const daily = AXIS.map((_day, index) => byFunnel.reduce((sum, row) => sum + row.cells[index], 0));
  const us = AXIS.map((_day, index) => (index === 0 ? 1 : 0));
  const trials = daily.reduce((sum, value) => sum + value, 0);
  const prev = byFunnel.reduce((sum, row) => sum + row.prev_trials, 0);
  return {
    ok: true, source: "clickhouse", action: "trials_daily", generated_at: "2026-10-15T10:00:00.000Z", query_duration_ms: 12,
    bucket: "day", date_from: AXIS[0], date_to: AXIS[13], prev_from: addDays(AXIS[0], -14), prev_to: addDays(AXIS[0], -1),
    axis: AXIS, axis_state: STATE, data_through: "2026-10-14T10:30:00.000Z",
    totals: { trials, prev_trials: prev, daily, unknown_funnel: byFunnel[12].trials, unknown_geo: 0 },
    by_funnel: byFunnel,
    by_country: [rowOf("MX", daily.map((value, index) => value - us[index]), prev - 1), rowOf("us", us, 1)],
    diagnostics: { snapshot_warehouse_version: "wh", snapshot_classification_version: "cv", trials_scanned: trials + prev, filters_active: false, note: "" },
    ...overrides,
  };
}

const ok = (data: RevenueTrialsDaily | null = response()) => ({ data, error: null, errorCode: null, errorStatus: null, isInitialLoading: false, isRefreshing: false });

const RESTRICTED_META: RevenueTrialsDaily["meta"] = { access: { scope: "restricted", dropped_filter_values: 0 } };

/** A funnel-restricted body: meta, the note, filters_active forced, no cut-off. */
function restrictedResponse(overrides: Partial<RevenueTrialsDaily> = {}): RevenueTrialsDaily {
  const base = response({ ...overrides, data_through: null, meta: RESTRICTED_META });
  return { ...base, diagnostics: { ...base.diagnostics, filters_active: true, note: "restricted" } };
}

function emptyResponse(overrides: Partial<RevenueTrialsDaily> = {}): RevenueTrialsDaily {
  return response({ by_funnel: [], by_country: [], totals: { trials: 0, prev_trials: 0, daily: AXIS.map(() => 0), unknown_funnel: 0, unknown_geo: 0 }, ...overrides });
}

const JSDOM_INNER_WIDTH = window.innerWidth;

/** The card body's measured width and the viewport width (the breakpoint). */
function setWidths(body: number, viewport: number) {
  vi.spyOn(Element.prototype, "clientWidth", "get").mockReturnValue(body);
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: viewport });
}

beforeEach(() => {
  localStorage.clear();
  h.requests.length = 0;
  h.result = ok();
  resizeCallbacks.length = 0;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: JSDOM_INNER_WIDTH });
});

/** The header's column buttons (one per day / week column). */
function columnButtons() {
  return within(screen.getByTestId("trials-matrix")).getAllByRole("button", { name: /click to (un)?pin$/ });
}

/** Body rows of the matrix: the All row plus the data rows. */
function bodyRows() {
  const table = screen.getByTestId("trials-matrix");
  return within(table).getAllByRole("row").slice(1);
}

describe("TrialsDailySection", () => {
  it("compact by default: the All row, 8 rows, Other and Unknown", () => {
    renderCard();
    const rows = bodyRows();
    expect(rows).toHaveLength(11);
    expect(rows[0]).toHaveAttribute("data-testid", "trials-all-row");
    expect(within(rows[1]).getByText("path-01")).toBeInTheDocument();
    expect(within(rows[9]).getByText(/Other/)).toHaveTextContent("Other· 4 funnels");
    expect(within(rows[10]).getByText("Unknown")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Daily trials" })).toBeInTheDocument();
    // Expand on demand, inside the bounded scroll area.
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 funnels" }));
    expect(bodyRows()).toHaveLength(14);
    expect(screen.getByRole("button", { name: "Show top 8" })).toBeInTheDocument();
  });

  it("the request is the range, the day grain and the member filters; switching to GEO asks nothing new", () => {
    renderCard();
    const first = h.requests.at(-1)!;
    expect(first).toMatchObject({ action: "trials_daily", bucket: "day", filters: { campaign_path: [], country: [] } });
    const distinct = () => new Set(h.requests.map((request) => JSON.stringify(request))).size;
    expect(distinct()).toBe(1);
    fireEvent.mouseDown(screen.getByRole("tab", { name: "GEO" }));
    expect(screen.getByRole("heading", { name: "Daily trials by GEO" })).toBeInTheDocument();
    // The label's title is the full displayed name, not only the code.
    expect(screen.getByText("MX · Mexico")).toHaveAttribute("title", "MX · Mexico");
    expect(screen.getByText("us")).toHaveAttribute("title", "us · non-standard code");
    expect(distinct()).toBe(1);
  });

  it("'GEO of this funnel' filters the funnel and opens the GEO view", () => {
    renderCard();
    const action = screen.getByRole("button", { name: "GEO of this funnel: path-02" });
    // Laid over the name with a pointer (no label width); in the row and visible on touch screens.
    expect(action).toHaveClass("absolute", "opacity-0", "[@media(hover:none)]:static", "[@media(hover:none)]:opacity-60");
    fireEvent.click(action);
    expect(screen.getByRole("heading", { name: "Daily trials by GEO" })).toBeInTheDocument();
    expect(h.requests.at(-1)).toMatchObject({ filters: { campaign_path: ["path-02"], country: [] } });
  });

  it("states the totals: trials, average per complete day, Δ vs the previous window, GEO coverage and the cut-off", () => {
    renderCard();
    const total = response().totals.trials;
    expect(screen.getByText(`${total.toLocaleString("en-US")} trials`)).toBeInTheDocument();
    expect(screen.getByText("vs previous 14 days")).toBeInTheDocument();
    expect(screen.getByText(/GEO known 100%/)).toBeInTheDocument();
    expect(screen.getByText(/project-wide$/)).toBeInTheDocument();
  });

  it("restricted copy reads 'only your funnels' (never the Revenue Intelligence phrase) and never names the cut-off", () => {
    h.result = ok(restrictedResponse());
    renderCard(BUYER());
    expect(screen.getByText(/only your funnels/)).toBeInTheDocument();
    expect(screen.queryByText(/your funnels · same/)).toBeNull();
    expect(screen.queryByText(/project-wide/)).toBeNull();
    expect(screen.getByText("updates after each Primer import")).toBeInTheDocument();
    expect(screen.queryByText(/data through/)).toBeNull();
  });

  it("a restricted 409 waits with its own test id; the owner's not-ready line points to Revenue Intelligence", () => {
    h.result = { data: null, error: "cohort_snapshot_not_ready", errorCode: SCOPE_SNAPSHOT_NOT_READY, errorStatus: 409, isInitialLoading: false, isRefreshing: false };
    renderCard(BUYER());
    expect(screen.getByTestId("trials-scope-pending")).toHaveTextContent(/Funnel-scoped data is being prepared/);
    expect(screen.queryByTestId("scope-data-pending")).toBeNull();
    cleanup();

    h.result = { data: null, error: "cohort_snapshot_not_ready", errorCode: null, errorStatus: null, isInitialLoading: false, isRefreshing: false };
    renderCard();
    expect(screen.getByText("Daily trials need the cohort snapshot — see Revenue Intelligence above.")).toBeInTheDocument();
    expect(screen.queryByTestId("trials-scope-pending")).toBeNull();
    cleanup();

    h.result = { data: null, error: "boom", errorCode: null, errorStatus: 502, isInitialLoading: false, isRefreshing: false };
    renderCard();
    expect(screen.getByText("Daily trials request failed: boom")).toBeInTheDocument();
    cleanup();

    h.result = { data: null, error: null, errorCode: null, errorStatus: null, isInitialLoading: true, isRefreshing: false };
    renderCard();
    expect(screen.getByText(/Loading daily trials/)).toBeInTheDocument();
  });

  it("empty answers: one line, with Clear filters only under the member's own filters", () => {
    const empty = emptyResponse();
    h.result = ok(empty);
    renderCard();
    expect(screen.getByText(/No trials in this period/)).toBeInTheDocument();
    cleanup();

    localStorage.clear();
    h.result = ok({ ...empty, diagnostics: { ...empty.diagnostics, filters_active: true } });
    renderCard();
    expect(screen.getByText(/No trials match the filters/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeInTheDocument();
  });

  it("a cut-off before the window says so instead of drawing an empty matrix", () => {
    h.result = ok(response({ data_through: "2026-09-20T08:00:00.000Z" }));
    renderCard();
    expect(screen.getByText("Last import Sep 20, 08:00 UTC is before this window.")).toBeInTheDocument();
    expect(screen.queryByTestId("trials-matrix")).toBeNull();
  });

  it("pinning a day names its leaders and links to Cohorts; ✕ clears it", () => {
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /^Oct 3 · click to pin/ }));
    const pinned = screen.getByTestId("trials-pinned-day");
    expect(pinned).toHaveTextContent("Oct 3");
    expect(pinned).toHaveTextContent("path-01 12");
    expect(within(pinned).getByRole("link", { name: /Open in Cohorts/ })).toHaveAttribute("href", "/cohorts?cohort_date=2026-10-03");
    fireEvent.click(within(pinned).getByRole("button", { name: "Unpin the day" }));
    expect(screen.queryByTestId("trials-pinned-day")).toBeNull();
  });

  it("never renders a raw YYYY-MM-DD as visible text", () => {
    renderCard();
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    fireEvent.click(screen.getByRole("button", { name: /^Oct 3 · click to pin/ }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "GEO" }));
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("Δ of a row whose trials all fall in the partial day says so, never 'No trials'", () => {
    const launch = rowOf("path-launch", STATE.map((state) => (state === "partial" ? 5 : 0)), 0);
    h.result = ok(response({ by_funnel: [...response().by_funnel.slice(0, 2), launch] }));
    renderCard();
    const row = screen.getByText("path-launch").closest("tr")!;
    expect(within(row).getAllByRole("cell").at(-1)).toHaveAttribute("title", "Trials only in the partial day — nothing complete to compare yet");
  });

  it("cell numbers keep their contrast: white only on the full primary step, the foreground elsewhere and on muted rows", () => {
    const cells = STATE.map((state, index) => (state === "no_data" ? 0 : index === 0 ? 10 : index === 1 ? 7 : 2));
    h.result = ok(response({ by_funnel: [rowOf("path-x", cells, 10), rowOf("Unknown", cells, 10)] }));
    renderCard();
    const dayCells = (key: string) =>
      within(screen.getByText(key).closest("tr")!).getAllByRole("cell").slice(2, 2 + AXIS.length).map((cell) => cell.firstElementChild!);
    const [top, high] = dayCells("path-x");
    expect(top).toHaveClass("bg-primary", "text-primary-foreground");
    expect(top).toHaveTextContent("10");
    expect(high).toHaveClass("bg-primary/65");
    expect(high).not.toHaveClass("text-primary-foreground");
    expect(dayCells("Unknown")[0]).toHaveClass("bg-muted-foreground/85");
    for (const cell of dayCells("Unknown")) expect(cell).toHaveClass("text-foreground");
  });
});

describe("the cut-off fragment (non-restricted responses, fixed clock)", () => {
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  };

  it("a day after the import: 'data through' the cut-off", () => {
    at("2026-10-15T12:00:00.000Z");
    renderCard();
    expect(screen.getByText("data through Oct 14, 10:30 UTC")).toBeInTheDocument();
    expect(screen.queryByText(/last import/)).toBeNull();
  });

  it("two or more days after: a warning that links to /import for the data owner", () => {
    at("2026-10-17T12:00:00.000Z");
    renderCard();
    const warning = screen.getByText("last import 3 days ago");
    expect(warning.closest("a")).toHaveAttribute("href", "/import");
    expect(warning.closest(".text-warning")).toHaveAttribute("title", "Data through Oct 14, 10:30 UTC");
    expect(screen.queryByText(/data through Oct 14/)).toBeNull();
  });

  it("an all-funnels member without raw access sees the same warning, without the link", () => {
    at("2026-10-17T12:00:00.000Z");
    renderCard(MEMBER());
    const warning = screen.getByText("last import 3 days ago");
    expect(warning.closest(".text-warning")).not.toBeNull();
    expect(warning.closest("a")).toBeNull();
    expect(screen.queryByRole("link", { name: /last import/ })).toBeNull();
  });
});

describe("funnel-restricted paths", () => {
  const savedFunnels = (funnels: string[]) =>
    localStorage.setItem(principalPageStateKey("ui_state_trials_daily", USER.id), JSON.stringify({ funnels }));

  it("an empty answer under the forced filters_active alone is 'no trials', with no Clear filters", () => {
    h.result = ok(restrictedResponse(emptyResponse()));
    renderCard(BUYER());
    expect(screen.getByText(/No trials in this period/)).toBeInTheDocument();
    expect(screen.queryByText(/No trials match the filters/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
  });

  it("a saved funnel filter wholly outside the member's funnels: the notice says nothing matches, Clear drops it", () => {
    savedFunnels(["path-99"]);
    h.result = ok(restrictedResponse(emptyResponse()));
    renderCard(BUYER());
    const notice = screen.getByTestId("trials-out-of-scope-funnels");
    expect(notice).toHaveTextContent("Your saved funnel filter is outside your funnels, so nothing matches.");
    expect(h.requests.at(-1)).toMatchObject({ filters: { campaign_path: ["path-99"] } });
    fireEvent.click(within(notice).getByRole("button", { name: "Clear" }));
    expect(screen.queryByTestId("trials-out-of-scope-funnels")).toBeNull();
    expect(h.requests.at(-1)).toMatchObject({ filters: { campaign_path: [] } });
  });

  it("a mix keeps the in-scope funnel: the other 'was ignored', and only scoped paths are offered", () => {
    savedFunnels(["path-01", "path-99"]);
    h.result = ok(restrictedResponse());
    renderCard(BUYER());
    const notice = screen.getByTestId("trials-out-of-scope-funnels");
    expect(notice).toHaveTextContent("1 saved funnel filter is outside your funnels and was ignored.");
    fireEvent.click(within(notice).getByRole("button", { name: "Clear" }));
    expect(h.requests.at(-1)).toMatchObject({ filters: { campaign_path: ["path-01"] } });
    // The response names path-01..path-12; the member is offered path-01 only.
    fireEvent.click(screen.getByRole("button", { name: "Funnel: 1" }));
    const options = within(screen.getByRole("dialog")).getAllByRole("button").map((button) => button.textContent);
    expect(options.filter((text) => /^path-/.test(text ?? ""))).toEqual(["path-01"]);
  });
});

describe("captions come from the DISPLAYED response, never from the access", () => {
  it("owner access with a restricted-shaped response reads the restricted copy; restricted access with a project-wide one does not", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
    h.result = ok(restrictedResponse());
    renderCard(OWNER());
    expect(screen.getByText(/only your funnels/)).toBeInTheDocument();
    expect(screen.getByText("updates after each Primer import")).toBeInTheDocument();
    expect(screen.queryByText(/project-wide/)).toBeNull();
    cleanup();

    h.result = ok(response());
    renderCard(BUYER());
    expect(screen.getByText(/project-wide$/)).toBeInTheDocument();
    expect(screen.getByText("data through Oct 14, 10:30 UTC")).toBeInTheDocument();
    expect(screen.queryByText(/only your funnels/)).toBeNull();
    expect(screen.queryByText("updates after each Primer import")).toBeNull();
  });
});

// ---- week paths -------------------------------------------------------------------

/** Server week grain: three ISO weeks, the newest partial. */
function weekResponse(): RevenueTrialsDaily {
  const axis = ["2026-09-28", "2026-10-05", "2026-10-12"];
  const byFunnel = [rowOf("path-a", [70, 63, 30], 140), rowOf("Unknown", [7, 7, 3], 14)];
  const daily = axis.map((_day, index) => byFunnel.reduce((sum, row) => sum + row.cells[index], 0));
  return response({
    bucket: "week", date_from: "2026-09-28", date_to: "2026-10-18", prev_from: "2026-09-07", prev_to: "2026-09-27",
    axis, axis_state: ["complete", "complete", "partial"],
    totals: { trials: daily.reduce((sum, value) => sum + value, 0), prev_trials: 154, daily, unknown_funnel: 17, unknown_geo: 0 },
    by_funnel: byFunnel,
    by_country: [rowOf("MX", daily, 154)],
  });
}

/** 90 days to Thu 2026-10-15 (from Sat 07-18), cut-off Wed 10:00 UTC: Oct 14
 * partial, Oct 15 no_data. Flat funnels: path-a 10/day, path-b 5/day, Unknown 1/day. */
function ninetyDays(): RevenueTrialsDaily {
  const axis = Array.from({ length: 90 }, (_value, index) => addDays("2026-07-18", index));
  const state: TrialsBucketState[] = axis.map((day) => (day < "2026-10-14" ? "complete" : day === "2026-10-14" ? "partial" : "no_data"));
  const flat = (value: number) => state.map((entry) => (entry === "no_data" ? 0 : value));
  const byFunnel = [rowOf("path-a", flat(10), 890), rowOf("path-b", flat(5), 445), rowOf("Unknown", flat(1), 89)];
  const daily = axis.map((_day, index) => byFunnel.reduce((sum, row) => sum + row.cells[index], 0));
  const prev = byFunnel.reduce((sum, row) => sum + row.prev_trials, 0);
  return response({
    date_from: axis[0], date_to: axis[89], prev_from: addDays(axis[0], -90), prev_to: addDays(axis[0], -1),
    axis, axis_state: state, data_through: "2026-10-14T10:00:00.000Z",
    totals: { trials: daily.reduce((sum, value) => sum + value, 0), prev_trials: prev, daily, unknown_funnel: byFunnel[2].trials, unknown_geo: 0 },
    by_funnel: byFunnel,
    by_country: [rowOf("MX", daily, prev)],
  });
}

const dayCellsOf = (row: HTMLElement) => within(row).getAllByRole("cell").slice(2, -2);

describe("week paths", () => {
  it("'Last 180 days (weekly)' asks for week buckets and draws the week-grain answer", async () => {
    renderCard();
    h.result = ok(weekResponse());
    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByRole("option", { name: "Last 180 days (weekly)" }));
    const request = h.requests.at(-1)!;
    expect(request).toMatchObject({ action: "trials_daily", bucket: "week" });
    expect(request.date_from).toBe(addDays(String(request.date_to), -179));
    expect(screen.getByText("All · trials/week")).toBeInTheDocument();
    expect(columnButtons().map((button) => button.getAttribute("aria-label"))).toEqual([
      "Sep 28–Oct 4 · click to pin",
      "Oct 5–11 · click to pin",
      "Oct 12–18 · Partial: data through 10:30 UTC · click to pin",
    ]);
    // A pinned week names its leaders but never links to one Cohorts day.
    fireEvent.click(columnButtons()[1]);
    const pinned = screen.getByTestId("trials-pinned-day");
    expect(pinned).toHaveTextContent("Oct 5–11");
    expect(pinned).toHaveTextContent("path-a 63");
    expect(within(pinned).queryByRole("link")).toBeNull();
  });

  it("a narrow card folds 90 days into ISO weeks: short edge weeks are labelled, shaded by their per-day rate, the cut-off week is partial", () => {
    setWidths(343, 375);
    h.result = ok(ninetyDays());
    renderCard();
    const labels = columnButtons().map((button) => button.getAttribute("aria-label"));
    expect(labels).toHaveLength(14);
    expect(labels[0]).toBe("Jul 18–19 (2 days) · click to pin");
    expect(labels[1]).toBe("Jul 20–26 · click to pin");
    // Not no_data: the newest week holds real trials (Oct 12–14).
    expect(labels[13]).toBe("Oct 12–15 (4 days) · Partial: data through 10:00 UTC · click to pin");

    const all = screen.getByTestId("trials-all-row");
    expect(all).toHaveTextContent("All · trials/week");
    expect(all).toHaveTextContent("max 16/day");
    const bars = dayCellsOf(all);
    expect(bars.at(-1)).toHaveAttribute("title", "Oct 12–15 (4 days): 48 trials · Unknown 3 · partial");
    // A steady funnel draws steady bars and shades, edge weeks included.
    for (const cell of bars) expect((cell.firstElementChild!.firstElementChild as HTMLElement).style.height).toBe("100%");
    const pathA = dayCellsOf(screen.getByText("path-a").closest("tr")!);
    expect(pathA).toHaveLength(14);
    for (const cell of pathA) expect(cell.firstElementChild).toHaveClass("bg-primary");
    expect(pathA[0]).toHaveAttribute("title", "path-a, Jul 18–19 (2 days): 20 trials (62.5% of the week)");
  });

  it("a pinned day stays pinned when the card narrows and folds: its week is the pinned column, a click unpins it", () => {
    h.result = ok(ninetyDays());
    renderCard();
    expect(columnButtons()).toHaveLength(90);
    fireEvent.click(screen.getByRole("button", { name: "Oct 14 · Partial: data through 10:00 UTC · click to pin" }));
    expect(screen.getByTestId("trials-pinned-day")).toHaveTextContent("Oct 14");

    setWidths(343, 375);
    act(() => resizeCallbacks.forEach((callback) => callback()));
    expect(columnButtons()).toHaveLength(14);
    const pinned = screen.getByTestId("trials-pinned-day");
    expect(pinned).toHaveTextContent("Oct 12–15 (4 days)");
    expect(pinned).toHaveTextContent("48 trials");
    expect(within(pinned).queryByRole("link", { name: /Open in Cohorts/ })).toBeNull();
    const week = screen.getByRole("button", { name: "Oct 12–15 (4 days) · Partial: data through 10:00 UTC · click to unpin" });
    expect(week).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(week);
    expect(screen.queryByTestId("trials-pinned-day")).toBeNull();
  });

  it("'Show all' never flips the fold: the scrollbar allowance is the same expanded or not", () => {
    // 14 days at 296 px (phone): (296 − 248) / 14 < 4 px either way.
    setWidths(296, 375);
    renderCard();
    expect(columnButtons()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Show all 12 funnels" }));
    expect(columnButtons()).toHaveLength(3);
  });
});
