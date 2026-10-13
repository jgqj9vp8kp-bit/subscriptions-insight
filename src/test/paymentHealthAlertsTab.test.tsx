// Payment System Health — Alerts tab (P2.5, plan Q / P / X): renders the open
// alerts with severity, rule, scope labels, current vs previous, sample and
// confidence flags, window, first / last seen and status; the open count on the
// tab; filters sent as the server's filters; the expandable evidence and the
// four labelled explanation parts (hypothesis "unverified"); the deep link of
// evidence.reproduce; the status buttons and "Run checks now" only for
// payment_health.manage_alerts holders (and only when the server agrees); the
// mutation flow over an in-memory alerts server; low confidence never shown as
// a warning; PSP-scoped alerts never shown without the PSP key; and no PII,
// member id or opaque key on screen (leak scan), no banned recommendation.

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
Element.prototype.scrollIntoView = function scrollIntoView() {};
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

const fns = vi.hoisted(() => ({ run: vi.fn(), alerts: vi.fn() }));

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
  runClickHousePaymentHealthAlerts: fns.alerts,
}));

import { ClickHouseRequestError } from "@/services/clickhouse";
import { AuthContext, type AuthContextValue, type AuthUser } from "@/contexts/authContext";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { scanForLeaks } from "./support/leakScan";
import { UI_SENTINELS, responseFor } from "./support/paymentHealthResponses";
import {
  ALERT_IDS,
  ME,
  OPAQUE_ACCOUNT_KEY,
  TEAMMATE,
  alertsEdgeError,
  alertsListResponse,
  approvalAlert,
  createAlertsServer,
  defaultAlerts,
  fraudLowAlert,
  runSummary,
  staleAlert,
  type AlertsServer,
} from "./support/paymentHealthAlertResponses";
import { forbiddenRecommendationHits } from "../../supabase/functions/_shared/clickhouse/paymentRiskRecommendations";
import PaymentHealthPage from "@/pages/PaymentHealth";

const USER: AuthUser = { id: ME, email: "ph@example.com", provider: "supabase" };
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
const VIEWER = () => buildAccessValue({ status: "ok", access: okRow({ permissions: ["payment_health.view"], partition: "p-viewer" }), userId: USER.id });
const MANAGER = () =>
  buildAccessValue({ status: "ok", access: okRow({ permissions: ["payment_health.view", "payment_health.psp_global.view", "payment_health.manage_alerts"], partition: "p-manager" }), userId: USER.id });

let server: AlertsServer;

function renderPage(access: AccessContextValue = OWNER()) {
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

type Body = Record<string, unknown> & { action: string };
const pageCalls = (action: string) => fns.run.mock.calls.map((call) => call[0] as Body).filter((body) => body.action === action);
const alertCalls = (action: string) => fns.alerts.mock.calls.map((call) => call[0] as Body).filter((body) => body.action === action);

async function openAlertsTab() {
  fireEvent.mouseDown(screen.getByRole("tab", { name: /^Alerts/ }));
  return screen.findByTestId("alerts-list");
}

async function pickOption(selectLabel: string, option: RegExp) {
  fireEvent.click(screen.getByRole("combobox", { name: selectLabel }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

const row = (id: string) => screen.getByTestId(`alert-row-${id}`);
function expand(id: string) {
  fireEvent.click(within(row(id)).getByRole("button", { name: /^Details:/ }));
  return screen.getByTestId(`alert-details-${id}`);
}

function useServer(next: AlertsServer) {
  server = next;
  fns.alerts.mockImplementation((body: Body) => server.handle(body));
}

beforeEach(() => {
  localStorage.clear();
  fns.run.mockReset();
  fns.alerts.mockReset();
  fns.run.mockImplementation(async (body: Body) => responseFor(body.action, { dimension: body.dimension as string | undefined }));
  useServer(createAlertsServer());
});
afterEach(() => cleanup());

describe("Alerts tab", () => {
  it("lists the open alerts (severity, rule, scope labels, current vs previous, flags, window, seen, status) and counts them on the tab, with one request for both", async () => {
    renderPage();
    // The badge loads with the page, before the tab is opened.
    const badge = await screen.findByTestId("alerts-tab-count");
    expect(badge).toHaveTextContent("5");
    expect(badge.className).toContain("bg-destructive");
    const list = await openAlertsTab();

    // The default view is the open alerts: one alerts_list for the badge and the tab together.
    expect(alertCalls("alerts_list")).toEqual([{ action: "alerts_list", status: ["new", "investigating"] }]);
    // Alerts never touch the page's runner (the warehouse breaker path).
    expect(pageCalls("alerts_list")).toEqual([]);

    const rows = within(list).getAllByTestId(/^alert-row-/);
    expect(rows.map((entry) => entry.getAttribute("data-testid"))).toEqual([
      `alert-row-${ALERT_IDS.approval}`, // critical, newest
      `alert-row-${ALERT_IDS.stale}`,
      `alert-row-${ALERT_IDS.postBan}`,
      `alert-row-${ALERT_IDS.integrationTenant}`,
      `alert-row-${ALERT_IDS.fraudLow}`, // info
    ]);
    expect(within(list).queryByTestId(`alert-row-${ALERT_IDS.refundResolved}`)).toBeNull();

    const approval = row(ALERT_IDS.approval);
    expect(within(approval).getByTestId("alert-severity")).toHaveTextContent("Critical");
    expect(approval).toHaveTextContent("Approval drop");
    expect(approval).toHaveTextContent("Stripe MID #1");
    expect(approval).toHaveTextContent("Stripe · CIT");
    expect(approval).toHaveTextContent("Funnels: Astro quiz, Numerology quiz");
    expect(approval).toHaveTextContent("62.00%");
    expect(approval).toHaveTextContent("vs 75.00% · −13.00 pp");
    expect(approval).toHaveTextContent("n = 1,000");
    expect(within(approval).getByText("significant")).toBeInTheDocument();
    expect(approval).toHaveTextContent("2026-10-04 – 2026-10-10");
    expect(approval).toHaveTextContent("first 2026-10-11 07:41 UTC");
    expect(approval).toHaveTextContent("last 2026-10-12 07:41 UTC");
    expect(within(approval).getByTestId("alert-status")).toHaveTextContent("New");

    // Count and freshness rules: their own unit, no baseline.
    expect(row(ALERT_IDS.postBan)).toHaveTextContent("Whole workspace · Re-attempts after a do-not-retry decline · MIT");
    expect(row(ALERT_IDS.postBan)).toHaveTextContent("network re-attempt rules unverified");
    expect(row(ALERT_IDS.stale)).toHaveTextContent("15 d");
    expect(row(ALERT_IDS.stale)).toHaveTextContent("through 2026-09-28");
    // The last run, with its data-through day (plan N).
    expect(screen.getByTestId("alerts-last-run")).toHaveTextContent("Last scheduled check");
    expect(screen.getByTestId("alerts-last-run")).toHaveTextContent("data through 2026-10-10");
  });

  it("a low-confidence alert reads Info with a 'low confidence' badge, even if the stored severity says warning; issuer suspicion is a decline, not fraud", async () => {
    useServer(createAlertsServer([fraudLowAlert({ severity: "warning" }), approvalAlert()]));
    renderPage();
    await openAlertsTab();
    const fraud = row(ALERT_IDS.fraudLow);
    const severity = within(fraud).getByTestId("alert-severity");
    expect(severity).toHaveTextContent("Info");
    expect(severity).toHaveAttribute("data-severity", "info");
    expect(within(fraud).queryByText("Warning")).toBeNull();
    expect(within(fraud).getByTestId("low-confidence")).toHaveTextContent("low confidence");
    expect(within(fraud).getByText("small sample")).toBeInTheDocument();
    expect(fraud).toHaveTextContent("issuer suspicion codes — declines, not confirmed fraud");
    // Not significant: no badge saying so.
    expect(within(fraud).queryByText("significant")).toBeNull();
    // Its change is not painted as an alarm either.
    expect(within(fraud).getByText("+3.75 pp").className).toContain("text-muted-foreground");
    const details = expand(ALERT_IDS.fraudLow);
    expect(details).toHaveTextContent("Low confidence: the sample was small or the window was still incomplete, so this is information only — not a warning.");
    expect(details).toHaveTextContent("small sample: fewer observations than the minimum");
    // The investigating member is "you", never an id.
    expect(fraud).toHaveTextContent("assigned to you");
  });

  it("an expanded row shows the evidence numbers and the four labelled parts (hypothesis 'unverified'), and the deep link opens the tab with the alert's window and filters", async () => {
    renderPage();
    await openAlertsTab();
    const details = expand(ALERT_IDS.approval);

    const evidence = within(details).getByTestId("alert-rate-evidence");
    expect(within(evidence).getByText("Settled")).toBeInTheDocument();
    expect(within(evidence).getByText("Attempts")).toBeInTheDocument();
    expect(evidence).toHaveTextContent("620");
    expect(evidence).toHaveTextContent("1,040");
    expect(evidence).toHaveTextContent("2026-09-27 – 2026-10-03");
    expect(evidence).toHaveTextContent("59.00% – 65.00%");
    expect(evidence).toHaveTextContent("Change−13.00 pp");
    expect(evidence).toHaveTextContent("significant change (95% intervals do not overlap)");
    expect(evidence).toHaveTextContent("warning ≥ 5 pp · critical ≥ 10 pp");
    expect(evidence).toHaveTextContent("200 per window (looked at from 50, as info only)");
    expect(evidence).toHaveTextContent("Data through2026-10-10");
    expect(within(details).getByTestId("alert-funnels")).toHaveTextContent("Astro quiz, Numerology quiz");

    expect(within(details).getByTestId("explanation-fact")).toHaveTextContent("Approval of CIT attempts on Stripe MID #1 (Stripe) fell from 75.00% to 62.00%");
    expect(within(details).getByTestId("explanation-likely")).toHaveTextContent("Likely explanation");
    const hypothesis = within(details).getByTestId("explanation-hypothesis");
    expect(within(hypothesis).getByTestId("hypothesis-unverified")).toHaveTextContent("unverified");
    expect(hypothesis).toHaveTextContent("Unverified:");
    const actions = within(details).getByTestId("explanation-actions");
    expect(within(actions).getAllByRole("listitem").length).toBe(5);
    expect(actions).toHaveTextContent("Open the Declines tab for this account and window");
    expect(within(details).getByTestId("alert-history")).toHaveTextContent("Raised by the alert engine");

    fireEvent.click(within(details).getByTestId("alert-reproduce"));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Approvals & Declines/ })).toHaveAttribute("aria-selected", "true"));
    await waitFor(() =>
      expect(pageCalls("declines").at(-1)).toEqual({ action: "declines", date_from: "2026-10-04", date_to: "2026-10-10", filters: { initiation: ["cit"] }, dimension: "merchant_account" }),
    );
    expect(await screen.findByTestId("code-mix")).toBeInTheDocument();
  });

  it("status and severity filters go to the server; the empty states name the last run", async () => {
    renderPage();
    await openAlertsTab();
    await pickOption("Alert status", /All statuses/);
    await waitFor(() => expect(alertCalls("alerts_list").at(-1)).toEqual({ action: "alerts_list" }));
    expect(await screen.findByTestId(`alert-row-${ALERT_IDS.refundResolved}`)).toHaveTextContent("Resolved (auto)");

    await pickOption("Alert severity", /^Critical$/);
    await waitFor(() => expect(alertCalls("alerts_list").at(-1)).toEqual({ action: "alerts_list", severity: ["critical"] }));
    await waitFor(() => expect(screen.getAllByTestId(/^alert-row-/)).toHaveLength(2));
    for (const entry of screen.getAllByTestId("alert-severity")) expect(entry).toHaveTextContent("Critical");

    await pickOption("Alert status", /^Dismissed$/);
    await waitFor(() => expect(alertCalls("alerts_list").at(-1)).toEqual({ action: "alerts_list", status: ["dismissed"], severity: ["critical"] }));
    const lastRun = server.lastRun()!;
    expect(await screen.findByTestId("alerts-empty")).toHaveTextContent(`No alerts match these filters — last run at ${new Date(lastRun.finished_at!).toISOString().slice(0, 10)}`);
    cleanup();

    useServer(createAlertsServer([]));
    localStorage.clear();
    renderPage();
    await openAlertsTab();
    expect(screen.queryByTestId("alerts-tab-count")).toBeNull();
    expect(screen.getByTestId("alerts-empty")).toHaveTextContent(/^No open alerts — last run at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/);
    cleanup();

    useServer(createAlertsServer([], { lastRun: null }));
    renderPage();
    await openAlertsTab();
    expect(screen.getByTestId("alerts-empty")).toHaveTextContent("No open alerts — no check has run yet.");
  });

  it("status buttons and 'Run checks now' need payment_health.manage_alerts in the access context AND the server's can_manage", async () => {
    // A viewer: no buttons (the server also says can_manage false).
    useServer(createAlertsServer(defaultAlerts(), { canManage: false }));
    renderPage(VIEWER());
    await openAlertsTab();
    expect(screen.queryByTestId("alerts-run-now")).toBeNull();
    const details = expand(ALERT_IDS.postBan);
    expect(within(details).queryByTestId("alert-actions")).toBeNull();
    expect(within(details).queryByRole("button", { name: /Investigating|Resolve|Dismiss/ })).toBeNull();
    cleanup();

    // A manager (the privileged key): buttons by the transition table.
    useServer(createAlertsServer());
    renderPage(MANAGER());
    await openAlertsTab();
    expect(screen.getByTestId("alerts-run-now")).toHaveTextContent("Run checks now");
    const newOne = within(expand(ALERT_IDS.postBan)).getByTestId("alert-actions");
    expect(within(newOne).getAllByRole("button").map((button) => button.textContent)).toEqual(["Investigating", "Resolve", "Dismiss"]);
    const investigating = within(expand(ALERT_IDS.fraudLow)).getByTestId("alert-actions");
    expect(within(investigating).getAllByRole("button").map((button) => button.textContent)).toEqual(["Resolve", "Dismiss"]);
    cleanup();

    // The key in the access context but the server says no: the server's word wins.
    useServer(createAlertsServer(defaultAlerts(), { canManage: false }));
    renderPage(MANAGER());
    await openAlertsTab();
    expect(screen.queryByTestId("alerts-run-now")).toBeNull();
    expect(within(expand(ALERT_IDS.postBan)).queryByTestId("alert-actions")).toBeNull();
  });

  it("mutation flow: Investigating with a note, then Resolve; each refetches the list (and the badge); a refused transition is explained", async () => {
    renderPage();
    await openAlertsTab();
    const listCalls = () => alertCalls("alerts_list").length;
    const before = listCalls();
    let details = expand(ALERT_IDS.postBan);
    fireEvent.change(within(details).getByLabelText(/Note/), { target: { value: "  Checking the retry job  " } });
    fireEvent.click(within(details).getByRole("button", { name: "Investigating" }));

    await waitFor(() => expect(alertCalls("alert_update")).toHaveLength(1));
    // The note is trimmed by the contract's normalizer before it is sent.
    expect(alertCalls("alert_update")[0]).toEqual({ action: "alert_update", alert_id: ALERT_IDS.postBan, status: "investigating", note: "Checking the retry job" });
    expect(await screen.findByTestId("alerts-notice")).toHaveTextContent("Re-attempts after a do-not-retry decline (Whole workspace) is now Investigating.");
    expect(listCalls()).toBeGreaterThan(before);
    await waitFor(() => expect(within(row(ALERT_IDS.postBan)).getByTestId("alert-status")).toHaveTextContent("Investigating"));
    expect(row(ALERT_IDS.postBan)).toHaveTextContent("assigned to you");
    details = screen.getByTestId(`alert-details-${ALERT_IDS.postBan}`);
    expect(within(details).getByTestId("alert-history")).toHaveTextContent("New → Investigating by you");
    expect(within(details).getByTestId("alert-history")).toHaveTextContent("“Checking the retry job”");
    // The draft note was cleared with the status change; the buttons follow the new status.
    expect(within(details).getByLabelText(/Note/)).toHaveValue("");
    expect(within(within(details).getByTestId("alert-actions")).getAllByRole("button").map((button) => button.textContent)).toEqual(["Resolve", "Dismiss"]);

    fireEvent.click(within(details).getByRole("button", { name: "Resolve" }));
    await waitFor(() => expect(screen.queryByTestId(`alert-row-${ALERT_IDS.postBan}`)).toBeNull());
    expect(screen.getByTestId("alerts-notice")).toHaveTextContent("is now Resolved.");
    expect(alertCalls("alert_update")[1]).toEqual({ action: "alert_update", alert_id: ALERT_IDS.postBan, status: "resolved" });
    await waitFor(() => expect(screen.getByTestId("alerts-tab-count")).toHaveTextContent("4"));

    // Someone else moved it first: 400 invalid_transition → the message, and the list is asked again.
    server.failNext("alert_update", alertsEdgeError(400, "invalid_transition", "An alert cannot move from resolved to dismissed."));
    const beforeRefused = listCalls();
    details = expand(ALERT_IDS.stale);
    fireEvent.click(within(details).getByRole("button", { name: "Dismiss" }));
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The alert's status changed in the meantime; the list has been refreshed.");
    await waitFor(() => expect(listCalls()).toBeGreaterThan(beforeRefused));
    // A 4xx mutation is never retried.
    expect(alertCalls("alert_update")).toHaveLength(3);
  });

  it("Run checks now: sends alerts_run, says what the run found, refetches, then waits out the 5-minute interval; a 429 is explained", async () => {
    renderPage();
    await openAlertsTab();
    const button = screen.getByTestId("alerts-run-now");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(alertCalls("alerts_run")).toEqual([{ action: "alerts_run" }]));
    expect(await screen.findByTestId("alerts-notice")).toHaveTextContent("Checks finished. Last manual check");
    expect(screen.getByTestId("alerts-notice")).toHaveTextContent("5 condition(s) found: 2 new, 3 refreshed, 0 reopened, 1 resolved automatically.");
    // The refetched list carries the new run: the button waits for the interval.
    await waitFor(() => expect(screen.getByTestId("alerts-run-now")).toBeDisabled());
    expect(screen.getByTestId("alerts-run-cooldown")).toHaveTextContent("One check per 5 minutes: next after");
    cleanup();

    useServer(createAlertsServer(defaultAlerts(), { lastRun: runSummary({ startedAt: new Date(Date.now() - 10 * 60_000).toISOString() }) }));
    server.failNext("alerts_run", alertsEdgeError(429, "rate_limited", "An alert run started less than 5 minutes ago."));
    renderPage();
    await openAlertsTab();
    fireEvent.click(screen.getByTestId("alerts-run-now"));
    expect(await screen.findByRole("alert")).toHaveTextContent("A check started less than 5 minutes ago or is still running. Try again in a few minutes.");
    // Asked once: a 429 is never retried.
    expect(server.callsFor("alerts_run")).toHaveLength(1);
  });

  it("a run in flight keeps its pending state and its answer while the list body is replaced by an error card and comes back", async () => {
    let finishRun: () => void = () => {};
    let unfilteredFails = true;
    fns.alerts.mockImplementation((body: Body) => {
      // The unfiltered list fails first: its error card replaces the whole body (filters and buttons included).
      if (body.action === "alerts_list" && body.status === undefined && unfilteredFails) return Promise.reject(new Error("ClickHouse Edge Function failed: network down"));
      if (body.action !== "alerts_run") return server.handle(body);
      // The run takes a while (up to ~2 min live): answered only when the test says so.
      return new Promise((resolve, reject) => {
        finishRun = () => void server.handle(body).then(resolve, reject);
      });
    });
    renderPage();
    await openAlertsTab();
    fireEvent.click(screen.getByTestId("alerts-run-now"));
    await waitFor(() => expect(screen.getByTestId("alerts-run-now")).toHaveTextContent("Running checks…"));

    await pickOption("Alert status", /All statuses/);
    expect(await screen.findByTestId("payment-health-error", {}, { timeout: 4000 })).toHaveTextContent("Could not load alerts");
    expect(screen.queryByTestId("alerts-run-now")).toBeNull();

    // The list loads on Retry: the body remounts and the run is still the one in flight.
    unfilteredFails = false;
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByTestId("alerts-run-now")).toBeDisabled();
    expect(screen.getByTestId("alerts-run-now")).toHaveTextContent("Running checks…");
    expect(alertCalls("alerts_run")).toHaveLength(1);

    finishRun();
    expect(await screen.findByTestId("alerts-notice")).toHaveTextContent("Checks finished. Last manual check");
    await waitFor(() => expect(screen.getByTestId("alerts-run-now")).toHaveTextContent("Run checks now"));
    expect(alertCalls("alerts_run")).toHaveLength(1);
  });

  it("without the PSP key: PSP-scoped alerts are left out (and counted), account splits are not shown, and a PSP alert the server sent anyway is not rendered", async () => {
    useServer(createAlertsServer(defaultAlerts(), { pspVisible: false, canManage: false }));
    renderPage(VIEWER());
    await openAlertsTab();
    expect(screen.getByTestId("alerts-psp-not-shown")).toHaveTextContent("2 alert(s) about PSP accounts are not shown");
    expect(screen.queryByTestId(`alert-row-${ALERT_IDS.approval}`)).toBeNull();
    expect(screen.queryByTestId(`alert-row-${ALERT_IDS.fraudLow}`)).toBeNull();
    const details = expand(ALERT_IDS.postBan);
    expect(within(details).queryByTestId("alert-accounts")).toBeNull();
    expect(screen.queryByText(/Stripe MID #1/)).toBeNull();
    cleanup();

    // Defence in depth: a PSP-scoped alert in a body whose meta says the key is missing.
    fns.alerts.mockImplementation(async () => alertsListResponse([approvalAlert(), staleAlert()], { pspVisible: false, canManage: false }));
    renderPage(VIEWER());
    await openAlertsTab();
    expect(screen.queryByTestId(`alert-row-${ALERT_IDS.approval}`)).toBeNull();
    expect(screen.getByTestId(`alert-row-${ALERT_IDS.stale}`)).toBeInTheDocument();
    expect(screen.queryByText(/Stripe MID #1/)).toBeNull();
  });

  it("with the PSP key the retry alert shows its per-account split by registry label", async () => {
    renderPage(MANAGER());
    await openAlertsTab();
    const details = expand(ALERT_IDS.postBan);
    expect(within(details).getByTestId("alert-accounts")).toHaveTextContent("By merchant account: Stripe · Stripe MID #1 (3)");
    expect(within(details).getByTestId("alert-count-evidence")).toHaveTextContent("… after a processor change2");
    expect(within(details).getByTestId("alert-count-evidence")).toHaveTextContent("warning ≥ 1 · critical ≥ 10");
  });

  it("no PII, member id or opaque key reaches the screen, and no recommendation the plan Q ban flags is shown", async () => {
    const banned = approvalAlert({
      explanation: {
        ...approvalAlert().explanation,
        action: [...approvalAlert().explanation.action, "Split the volume across another MID to stay below the threshold."],
      },
      status_history: [
        { at: "2026-10-11T07:41:00.000Z", event: "raised", from: null, to: "new", by: null, auto: true, note: null },
        { at: "2026-10-11T08:00:00.000Z", event: "status", from: "new", to: "investigating", by: TEAMMATE, auto: false, note: null },
        { at: "2026-10-11T09:00:00.000Z", event: "status", from: "investigating", to: "new", by: ME, auto: false, note: null },
      ],
      status: "investigating",
      assignee: TEAMMATE,
    });
    useServer(createAlertsServer([banned, ...defaultAlerts().slice(1)]));
    renderPage();
    await openAlertsTab();
    await pickOption("Alert status", /All statuses/);
    await screen.findByTestId(`alert-row-${ALERT_IDS.refundResolved}`);
    for (const toggle of screen.getAllByRole("button", { name: /^Details:/ })) fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /Show rules/ }));

    const approval = screen.getByTestId(`alert-details-${ALERT_IDS.approval}`);
    expect(within(approval).getByTestId("actions-withheld")).toHaveTextContent("1 recommended action(s) not shown: they did not pass the compliance check.");
    expect(approval).not.toHaveTextContent("Split the volume");
    expect(row(ALERT_IDS.approval)).toHaveTextContent("assigned to a teammate");
    expect(within(approval).getByTestId("alert-history")).toHaveTextContent("Investigating → New by you");
    expect(within(approval).getByTestId("alert-history")).toHaveTextContent("New → Investigating by a teammate");

    for (const part of screen.getAllByTestId("alert-explanation")) {
      expect(forbiddenRecommendationHits(part.textContent ?? "")).toEqual([]);
    }
    const leaks = scanForLeaks(document.body.innerHTML, {
      extra: [UI_SENTINELS.rawMid, UI_SENTINELS.rawDescriptor, UI_SENTINELS.instrumentToken, UI_SENTINELS.transactionId, OPAQUE_ACCOUNT_KEY, TEAMMATE, ME],
    });
    expect(leaks).toEqual([]);
  });

  it("a 403 on alerts_list renders the NoAccess shell in the tab, with no badge, and is never retried", async () => {
    fns.alerts.mockImplementation(async () => {
      throw new ClickHouseRequestError("ClickHouse Edge Function failed: permission_denied", { status: 403, errorCode: "permission_denied", requestId: "req-403" });
    });
    renderPage(VIEWER());
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /^Alerts/ }));
    expect(await screen.findByTestId("no-access")).toHaveAttribute("data-reason", "permission");
    expect(screen.queryByTestId("alerts-tab-count")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fns.alerts).toHaveBeenCalledTimes(1);
  });

  it("a function deployed before P2.5 (400 unknown_action) reads 'not deployed yet', with no badge and no retry", async () => {
    fns.alerts.mockImplementation(async () => {
      throw new ClickHouseRequestError("ClickHouse Edge Function failed: Unsupported action.", { status: 400, errorCode: "unknown_action", requestId: "req-400" });
    });
    renderPage();
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /^Alerts/ }));
    expect(await screen.findByTestId("alerts-not-deployed")).toHaveTextContent("The alert checks are not deployed on the server yet");
    expect(screen.queryByTestId("payment-health-error")).toBeNull();
    expect(screen.queryByTestId("alerts-tab-count")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fns.alerts).toHaveBeenCalledTimes(1);
  });

  it("the open filters survive a remount and Clear (the bar's reset) leaves them alone", async () => {
    const first = renderPage();
    await openAlertsTab();
    await pickOption("Alert severity", /^Warning$/);
    await waitFor(() => expect(alertCalls("alerts_list").at(-1)).toEqual({ action: "alerts_list", status: ["new", "investigating"], severity: ["warning"] }));
    await pickOption("Issuer country (BIN)", /^DE$/);
    fireEvent.click(await screen.findByRole("button", { name: /clear/i }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /clear/i })).toBeNull());
    expect(screen.getByRole("combobox", { name: "Alert severity" })).toHaveTextContent("Warning");
    first.unmount();

    fns.alerts.mockClear();
    renderPage();
    await openAlertsTab();
    expect(screen.getByRole("combobox", { name: "Alert severity" })).toHaveTextContent("Warning");
    expect(alertCalls("alerts_list")).toContainEqual({ action: "alerts_list", status: ["new", "investigating"], severity: ["warning"] });
  });
});

