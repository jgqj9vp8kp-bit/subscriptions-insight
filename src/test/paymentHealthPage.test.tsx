// Payment System Health page (P2 frontend): renders every tab from the typed
// responses, sends the request the filters describe, persists the filters per
// principal, hides the PSP dimensions when the server says so (and never sends
// a persisted PSP selection without the key), shows "no data" for a rate
// without a denominator, shows the NoAccess shell on a 403, and never prints a
// raw MID, descriptor, instrument token, transaction id or e-mail.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", { writable: true, value: MockResizeObserver });
// Radix Select in jsdom.
Element.prototype.scrollIntoView = function scrollIntoView() {};
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

const fns = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/components/AppLayout", async () => {
  const React = await import("react");
  return {
    AppLayout: ({ title, children }: { title: string; children?: ReactNode }) =>
      React.createElement("div", { "data-testid": "app-layout" }, React.createElement("h1", null, title), children),
  };
});
vi.mock("@/hooks/useAnalyticsCache", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useWarehouseVersion: () => ({ version: "whv_test", ready: true }),
}));
vi.mock("@/services/clickhouse", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runClickHousePaymentHealth: fns.run,
}));

import { ClickHouseRequestError } from "@/services/clickhouse";
import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { principalPageStateKey } from "@/hooks/usePersistedPageState";
import { PAYMENT_HEALTH_UI_STATE_KEY } from "@/components/payment-health/pageState";
import { RESTRICTED_SCOPE_DENIAL_COPY } from "@/components/NoAccess";
import { scanForLeaks } from "./support/leakScan";
import { UI_SENTINELS, responseFor } from "./support/paymentHealthResponses";
import PaymentHealthPage from "@/pages/PaymentHealth";

const USER: AuthUser = { id: "user-ph", email: "ph@example.com", provider: "supabase" };
const AUTH: AuthContextValue = {
  configured: true, supabaseConfigured: true, localAuthEnabled: false, mode: "supabase", loading: false, session: null, user: USER,
  signIn: async () => {}, signOut: async () => {},
};

function okRow(input: { permissions?: string[]; isOwner?: boolean; raw?: boolean; partition?: string }): MyAccess {
  return {
    status: "ok", workspace_id: "ws-1", member_id: "member-ph", user_id: USER.id, email: USER.email, display_name: null,
    is_data_owner: input.raw === true, raw_access: input.raw === true,
    role: { id: "role-1", key: "custom", name: "Custom", is_owner: input.isOwner === true, permissions: input.permissions ?? [] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] }, access_version: "1", partition: input.partition ?? "p-member",
  };
}
const OWNER = () => buildAccessValue({ status: "ok", access: okRow({ isOwner: true, raw: true, partition: "p-owner" }), userId: USER.id });
const MEMBER = () => buildAccessValue({ status: "ok", access: okRow({ permissions: ["payment_health.view"], partition: "p-viewer" }), userId: USER.id });

function renderPage(access: AccessContextValue = OWNER()) {
  // The hook sets its own retry policy (transient only); only the backoff is shortened here.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 1 } } });
  return render(
    <MemoryRouter initialEntries={["/payment-health"]}>
      <QueryClientProvider client={client}>
        <AuthContext.Provider value={AUTH}>
          <AccessContext.Provider value={access}>
            <PaymentHealthPage />
          </AccessContext.Provider>
        </AuthContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

type Body = Record<string, unknown> & { action: string; filters?: Record<string, string[]>; dimension?: string };
const calls = (): Body[] => fns.run.mock.calls.map((call) => call[0] as Body);
const callsFor = (action: string) => calls().filter((body) => body.action === action);
const LEAK_EXTRA = [UI_SENTINELS.rawMid, UI_SENTINELS.rawDescriptor, UI_SENTINELS.instrumentToken, UI_SENTINELS.transactionId];
const expectNoLeak = () => expect(scanForLeaks(document.body.innerHTML, { extra: LEAK_EXTRA })).toEqual([]);
const today = new Date().toISOString().slice(0, 10);

// Radix Tabs activate on mousedown (and keyboard), not on click.
async function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }));
}

async function pickOption(selectLabel: string, option: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: selectLabel }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  localStorage.clear();
  fns.run.mockReset();
  fns.run.mockImplementation(async (body: Body) => responseFor(body.action, { dimension: body.dimension }));
});
afterEach(() => cleanup());

describe("PaymentHealth page", () => {
  it("renders the banner, the KPI comparisons, the PSP × MID table with registry labels, the placeholder, and no PII", async () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Payment System Health" })).toBeInTheDocument();
    expect(await screen.findByText("Stripe MID #1")).toBeInTheDocument();
    expect(screen.getByTestId("payment-health-banner")).toHaveTextContent("Estimates from the Primer export; data through 2026-10-10; network ratios need official reports.");

    // The overview request: the rolling 30-day window, no filters, no dimension.
    const overview = callsFor("overview");
    expect(overview).toHaveLength(1);
    expect(overview[0]).toEqual({ action: "overview", date_from: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), date_to: today });
    expect(callsFor("options")).toEqual([{ action: "options" }]);

    // KPIs with their comparison flags: the fixture window is incomplete (data through 2026-10-10,
    // range to 2026-10-12), so the server flags every comparison immature and none reads "significant".
    expect(screen.getByText("Approval rate")).toBeInTheDocument();
    expect(screen.getAllByText("82.0%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("incomplete period").length).toBeGreaterThan(0);
    expect(screen.queryByText("significant")).toBeNull();
    expect(screen.getByText("Issuer-suspected-fraud declines")).toBeInTheDocument();
    expect(screen.getByText("Unauthorized-charge complaints")).toBeInTheDocument();

    // PSP × MID: registry labels, the unlabelled marker, and "no data" for the account without attempts (never 0%).
    const table = screen.getByTestId("psp-mid-table");
    expect(within(table).getByText("Unlabelled MID")).toBeInTheDocument();
    expect(within(table).getByText("unlabelled")).toBeInTheDocument();
    expect(within(table).getAllByText("no data").length).toBeGreaterThanOrEqual(4);
    expect(within(table).queryByText(/^0\.0+%$/)).toBeNull();
    // The complaint cell is the server's rate over the account's UNFILTERED settled payments (3 / 820), never a browser division by the filtered successes.
    expect(within(table).getByText("0.37%")).toBeInTheDocument();

    // Decline classes use the taxonomy labels; what-changed groups by dimension.
    expect(screen.getByTestId("decline-class-mix")).toHaveTextContent("Issuer suspected fraud (decline, not fraud)");
    expect(screen.getByTestId("what-changed")).toHaveTextContent("Issuer country (BIN)");
    expect(screen.getByTestId("what-changed")).toHaveTextContent("Processor (PSP)");
    expect(screen.getByTestId("disputes-placeholder")).toHaveTextContent("Disputes & fraud reports: source not connected yet");
    // Estimates verbatim, the incomplete marker, the window pair.
    const notes = screen.getByTestId("meta-notes");
    expect(notes).toHaveTextContent("Attempt chains are a heuristic (Primer gives every retry a new orderId).");
    expect(within(notes).getByTestId("incomplete-period")).toHaveTextContent("data through 2026-10-10");
    expectNoLeak();
  });

  it("Approvals & Declines: requests the declines action, shows classes, the code mix with ban rows and soft / hard, and re-requests on a dimension change", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await openTab(/Approvals & Declines/);
    expect(await screen.findByTestId("code-mix")).toBeInTheDocument();
    expect(callsFor("declines")[0]).toEqual({ action: "declines", date_from: expect.any(String), date_to: today });
    expect(screen.getByTestId("declines-by-dimension")).toHaveTextContent("Approval by processor (psp)");
    expect(screen.getByTestId("decline-classes")).toHaveTextContent("Insufficient funds");
    const codeMix = screen.getByTestId("code-mix");
    expect(within(codeMix).getByText("DO_NOT_RETRY")).toBeInTheDocument();
    expect(within(codeMix).getByText("ban")).toBeInTheDocument();
    expect(within(codeMix).getByText("Hard")).toBeInTheDocument();
    expect(screen.getByText("Soft / hard declines")).toBeInTheDocument();
    expect(screen.getByText("120 / 40")).toBeInTheDocument();

    await pickOption("Break down by", /Issuer country \(BIN\)/);
    await waitFor(() => expect(callsFor("declines").at(-1)).toMatchObject({ action: "declines", dimension: "country" }));
    expect(await screen.findByText("Approval by issuer country (bin)")).toBeInTheDocument();
    expectNoLeak();
  });

  it("Retries & Network Rules: heuristic labels, the rules-unverified note, post-ban rows (CIT / MIT, same / switched) and the rolling flags", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await openTab(/Retries & Network Rules/);
    expect(await screen.findByTestId("rules-unverified")).toHaveTextContent("Rules unverified.");
    expect(callsFor("retries")).toHaveLength(1);
    expect(screen.getAllByText("heuristic").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText("Retry recovery")).toBeInTheDocument();
    expect(screen.getByText("Cascade recovery")).toBeInTheDocument();
    const postBan = screen.getByTestId("post-ban-attempts");
    expect(within(postBan).getByText("banned again")).toBeInTheDocument();
    expect(within(postBan).getByText("switched")).toBeInTheDocument();
    expect(within(postBan).getByText("MC MAC 03 / 21")).toBeInTheDocument();
    expect(within(postBan).getByText("a1b2c3d4e5…")).toBeInTheDocument();
    expect(screen.getByTestId("post-ban-summary")).toHaveTextContent("5 / 8");
    const rolling = screen.getByTestId("rolling-windows");
    expect(rolling).toHaveTextContent("17");
    expect(rolling).toHaveTextContent("/ 15");
    expect(rolling).toHaveTextContent("potential violations");
    expect(screen.getByTestId("meta-notes")).toHaveTextContent("Network re-attempt rules come from secondary sources (UNVERIFIED)");
    expectNoLeak();
  });

  it("Refunds & Complaints: refunds by month and dimension, timing, complaints with version breaks and by account, the placeholder", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await openTab(/Refunds & Complaints/);
    expect(await screen.findByTestId("refunds-by-month")).toHaveTextContent("2026-09");
    expect(callsFor("refunds_support")[0]).toEqual({ action: "refunds_support", date_from: expect.any(String), date_to: today });
    expect(screen.getByTestId("refund-timing")).toHaveTextContent("≤ 7 days");
    expect(screen.getByTestId("refunds-by-dimension")).toHaveTextContent("Refunds by processor (psp)");
    expect(screen.getByTestId("complaints-totals")).toHaveTextContent("Possible unauthorized charge");
    expect(within(screen.getByTestId("complaints-by-month")).getByText("version break")).toBeInTheDocument();
    expect(screen.getByTestId("complaints-by-account")).toHaveTextContent("Stripe MID #1");
    expect(screen.getByTestId("disputes-placeholder")).toBeInTheDocument();
    expectNoLeak();
  });

  it("Data Sources: coverage per column, data through, last import, sync state, classification breaks and the metric dictionary", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await openTab(/Data Sources/);
    expect(await screen.findByTestId("sources-coverage")).toHaveTextContent("refund_observed_at (of refunded)");
    expect(callsFor("sources")).toEqual([{ action: "sources" }]);
    expect(screen.getByTestId("sources-warehouse")).toHaveTextContent("48,210");
    expect(screen.getByTestId("sources-warehouse")).toHaveTextContent("2026-10-10");
    expect(screen.getByTestId("sources-last-import")).toHaveTextContent("completed");
    expect(screen.getByTestId("sources-sync-state")).toHaveTextContent("2026-10-10 21:15 UTC");
    expect(within(screen.getByTestId("sources-support")).getByText("version break")).toBeInTheDocument();
    const metrics = screen.getByTestId("sources-metrics");
    expect(within(metrics).getByText("not connected")).toBeInTheDocument();
    expect(within(metrics).getAllByText("measured").length).toBe(2);
    expectNoLeak();
  });

  it("a filter change is sent as a one-element list and survives a remount (persisted per principal)", async () => {
    const first = renderPage();
    await screen.findByText("Stripe MID #1");
    await pickOption("Issuer country (BIN)", /^DE$/);
    await waitFor(() => expect(callsFor("overview").at(-1)).toMatchObject({ filters: { country: ["DE"] } }));
    expect(callsFor("overview").at(-1)?.filters).toEqual({ country: ["DE"] });
    first.unmount();
    const stored = JSON.parse(localStorage.getItem(principalPageStateKey(PAYMENT_HEALTH_UI_STATE_KEY, USER.id)) ?? "null");
    expect(stored).toMatchObject({ country: "DE", tab: "overview" });
    expect(localStorage.getItem(PAYMENT_HEALTH_UI_STATE_KEY)).toBeNull();

    fns.run.mockClear();
    renderPage();
    await waitFor(() => expect(callsFor("overview")).toHaveLength(1));
    expect(callsFor("overview")[0].filters).toEqual({ country: ["DE"] });
  });

  it("without the PSP key: no PSP table, no registry filters, and a persisted PSP selection is never sent", async () => {
    fns.run.mockImplementation(async (body: Body) => responseFor(body.action, { pspVisible: false, dimension: body.dimension }));
    localStorage.setItem(
      principalPageStateKey(PAYMENT_HEALTH_UI_STATE_KEY, USER.id),
      JSON.stringify({ processor: "STRIPE", merchantAccount: "mid-x", dimension: "merchant_account", country: "US", tab: "declines" }),
    );
    renderPage(MEMBER());
    expect(await screen.findByTestId("decline-classes")).toBeInTheDocument();
    // The windowed request waited for the options answer, then went out without the PSP parts.
    expect(calls()[0].action).toBe("options");
    const declines = callsFor("declines");
    expect(declines).toHaveLength(1);
    expect(declines[0].filters).toEqual({ country: ["US"] });
    expect(declines[0]).not.toHaveProperty("dimension");
    for (const body of calls()) {
      expect(body.filters?.processor).toBeUndefined();
      expect(body.filters?.merchant_account).toBeUndefined();
      expect(body.dimension).not.toBe("merchant_account");
    }
    expect(screen.getByTestId("declines-by-dimension")).toHaveTextContent("Approval by funnel (acquisition anchor)");
    expect(screen.queryByTestId("filter-processor")).toBeNull();
    expect(screen.queryByTestId("filter-merchant-account")).toBeNull();
    expect(screen.queryByTestId("filter-descriptor")).toBeNull();
    // The dimension picker offers no PSP dimension.
    fireEvent.click(screen.getByRole("combobox", { name: "Break down by" }));
    expect(await screen.findByRole("option", { name: "Issuer country (BIN)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Merchant account/ })).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await openTab(/^Overview$/);
    await screen.findByTestId("decline-class-mix");
    expect(screen.queryByTestId("psp-mid-table")).toBeNull();
    expect(screen.getByTestId("what-changed")).not.toHaveTextContent("Processor (PSP)");
    expectNoLeak();
  });

  it("a 403 scope_not_supported renders the NoAccess shell with the scope copy and is never retried", async () => {
    fns.run.mockImplementation(async () => {
      throw new ClickHouseRequestError("ClickHouse Edge Function failed: scope_not_supported", { status: 403, errorCode: "scope_not_supported", requestId: "req-403" });
    });
    renderPage(MEMBER());
    const panel = await screen.findByTestId("no-access");
    expect(panel).toHaveAttribute("data-reason", "scope");
    expect(within(panel).getByText(RESTRICTED_SCOPE_DENIAL_COPY)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 30));
    // options + overview, once each.
    expect(fns.run).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId("payment-health-error")).toBeNull();
  });

  it("a 403 permission_denied renders the permission copy; an upstream failure shows the message with a retry", async () => {
    fns.run.mockImplementation(async () => {
      throw new ClickHouseRequestError("ClickHouse Edge Function failed: permission_denied", { status: 403, errorCode: "permission_denied", requestId: "req-1" });
    });
    renderPage(MEMBER());
    expect(await screen.findByTestId("no-access")).toHaveAttribute("data-reason", "permission");
    cleanup();

    fns.run.mockImplementation(async (body: Body) => {
      if (body.action === "options") return responseFor("options");
      throw new ClickHouseRequestError("ClickHouse Edge Function failed: upstream_error", { status: 502, errorCode: "upstream_error", requestId: "req-502" });
    });
    renderPage();
    const error = await screen.findByTestId("payment-health-error");
    expect(error).toHaveTextContent("Could not load the overview");
    expect(error).toHaveTextContent("req-502");
    expect(within(error).getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.queryByTestId("no-access")).toBeNull();
  });

  it("the period preset is re-resolved against today and the compare caption names both windows", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await pickOption("Period", /Last 7 days/);
    await waitFor(() => expect(callsFor("overview").at(-1)?.date_from).not.toBe(callsFor("overview")[0].date_from));
    const last = callsFor("overview").at(-1)!;
    expect(last.date_to).toBe(today);
    expect(screen.getByTestId("compare-caption")).toHaveTextContent(`${last.date_from} – ${last.date_to}`);
    expect(screen.getByTestId("compare-caption")).toHaveTextContent("(7 d)");
  });

  it("an options failure is said in the filter bar with a retry while the tabs still load; the retry restores the lists", async () => {
    let optionsDown = true;
    fns.run.mockImplementation(async (body: Body) => {
      if (body.action === "options" && optionsDown) {
        throw new ClickHouseRequestError("ClickHouse Edge Function failed: upstream_error", { status: 502, errorCode: "upstream_error", requestId: "req-opt" });
      }
      return responseFor(body.action, { dimension: body.dimension });
    });
    renderPage();
    // No PSP selection is remembered, so the overview does not wait for options.
    expect(await screen.findByTestId("decline-class-mix")).toBeInTheDocument();
    const note = await screen.findByTestId("options-error");
    expect(note).toHaveTextContent("Filter options could not be loaded");
    expect(screen.getByTestId("payment-health-banner")).toHaveTextContent("data through unknown");
    // Without the options answer the PSP parts stay hidden (the key is unknown), the generic filters stay usable.
    expect(screen.queryByTestId("psp-mid-table")).toBeNull();
    expect(screen.getByTestId("filter-country")).toBeInTheDocument();

    optionsDown = false;
    fireEvent.click(within(note).getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.queryByTestId("options-error")).toBeNull());
    expect(await screen.findByText("Stripe MID #1")).toBeInTheDocument();
    expect(screen.getByTestId("payment-health-banner")).toHaveTextContent("data through 2026-10-10");
    expect(screen.getByTestId("filter-processor")).toBeInTheDocument();
  });

  it("Clear resets the filters but keeps the open tab (and serves the unfiltered answer from the cache)", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await openTab(/Approvals & Declines/);
    await screen.findByTestId("code-mix");
    await pickOption("Issuer country (BIN)", /^DE$/);
    await waitFor(() => expect(callsFor("declines").at(-1)).toMatchObject({ filters: { country: ["DE"] } }));
    expect(callsFor("declines")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Issuer country (BIN)" })).toHaveTextContent("All countries"));
    expect(screen.getByRole("tab", { name: /Approvals & Declines/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("code-mix")).toBeInTheDocument();
    // The unfiltered declines key was fetched when the tab opened: no third request.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(callsFor("declines")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /clear/i })).toBeNull();
  });

  it("a custom window with From after To is held back with the reason, and is sent once fixed", async () => {
    renderPage();
    await screen.findByText("Stripe MID #1");
    await pickOption("Period", /Custom/);
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-09-10" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-01" } });
    expect(await screen.findByTestId("range-problem")).toHaveTextContent('"From" (2026-09-10) is after "To" (2026-09-01). The window is not sent until it is fixed.');
    expect(await screen.findByTestId("payment-health-idle")).toHaveTextContent("Fix the window in the filter bar.");
    expect(screen.queryByTestId("psp-mid-table")).toBeNull();
    expect(callsFor("overview").some((body) => body.date_to === "2026-09-01")).toBe(false);

    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-09-30" } });
    await waitFor(() => expect(callsFor("overview").at(-1)).toMatchObject({ date_from: "2026-09-10", date_to: "2026-09-30" }));
    expect(await screen.findByText("Stripe MID #1")).toBeInTheDocument();
    expect(screen.queryByTestId("range-problem")).toBeNull();
    expect(screen.queryByTestId("payment-health-idle")).toBeNull();
    expect(screen.getByTestId("compare-caption")).toHaveTextContent("2026-09-10 – 2026-09-30");
  });
});
