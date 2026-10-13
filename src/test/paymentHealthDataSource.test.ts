// Payment System Health frontend, pure parts: the request builders, the
// response shape check, the typed error classification, the cache keys (access
// partition + schema version) and the page-state → query mapping (a persisted
// PSP selection is never sent without the key; preset windows roll). P2.5: the
// alert requests (against the contract normalizers), their shape check and
// transport, the alert cache keys, the Alerts tab state (filters, the
// evidence.reproduce deep link) and the alert view-model rules.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashKey } from "@tanstack/react-query";

const fns = vi.hoisted(() => ({ run: vi.fn(), alerts: vi.fn() }));
vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/services/clickhouse", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runClickHousePaymentHealth: fns.run,
  runClickHousePaymentHealthAlerts: fns.alerts,
}));

import { ClickHouseRequestError } from "@/services/clickhouse";
import {
  EMPTY_PAYMENT_HEALTH_FILTERS,
  EMPTY_PAYMENT_HEALTH_QUERY,
  OPEN_ALERTS_FILTERS,
  activeFilters,
  buildAlertUpdateRequest,
  buildAlertsListRequest,
  buildPaymentHealthRequest,
  describePaymentHealthError,
  isCompleteAlertsListResponse,
  isCompletePaymentHealthResponse,
  loadPaymentAlerts,
  loadPaymentHealth,
  missingAlertsFields,
  missingPaymentHealthFields,
  runPaymentAlerts,
  updatePaymentAlert,
  type PaymentHealthQuery,
} from "@/services/paymentHealthDataSource";
import {
  PAYMENT_HEALTH_ALERTS_QUERY_PREFIX,
  PAYMENT_HEALTH_ALERTS_QUERY_ROOT,
  PAYMENT_HEALTH_ALERTS_SCHEMA_VERSION,
  PAYMENT_HEALTH_QUERY_ROOT,
  PAYMENT_HEALTH_RESPONSE_SCHEMA_VERSION,
  normalizePaymentHealthRequest,
  paymentHealthAlertsQueryKey,
  paymentHealthQueryKey,
} from "@/services/paymentHealthCache";
import { WAREHOUSE_DEPENDENT_ROOTS } from "@/services/analyticsCache";
import {
  DEFAULT_PAYMENT_HEALTH_UI_STATE,
  alertsFilters,
  coerceAlertSeverityFilter,
  coerceAlertStatusFilter,
  coerceTab,
  customRangeProblem,
  effectiveQuery,
  hasActiveFilters,
  hasPspSelection,
  parseAlertReproduce,
  reproduceState,
  resolveRange,
} from "@/components/payment-health/pageState";
import { fmtPct, fmtPoints, ratio, summarizeComparison, summarizeRate } from "@/components/payment-health/format";
import { declineClassRows, dimensionOptions, groupWhatChanged, topDeclineClass } from "@/components/payment-health/model";
import {
  MANAGE_ALERTS_PERMISSION,
  accountCounts,
  actorText,
  alertActionErrorText,
  alertFlags,
  compliantActions,
  compliantText,
  countEvidenceRows,
  displaySeverity,
  fmtAlertChange,
  fmtAlertValue,
  nextManualRunAt,
  rateEvidence,
  scopeLabels,
  statusActions,
} from "@/components/payment-health/alertsModel";
import { UI_SENTINELS, comparison, declinesResponse, optionsResponse, overviewResponse, rate, retriesResponse, sourcesResponse } from "./support/paymentHealthResponses";
import { ALERT_IDS, alertsListResponse, approvalAlert, fraudLowAlert, postBanAlert, runSummary, staleAlert } from "./support/paymentHealthAlertResponses";
import { PAYMENT_HEALTH_ACTIONS, normalizePaymentHealthRequest as serverNormalize } from "../../supabase/functions/_shared/clickhouse/paymentHealthContract";
import {
  ALERT_NOTE_MAX_LENGTH,
  ALERT_STATUSES,
  isAllowedAlertTransition,
  normalizeAlertUpdateRequest,
  normalizeAlertsListRequest,
} from "../../supabase/functions/_shared/clickhouse/paymentRiskAlertsContract";
import { PAYMENT_HEALTH_MANAGE_ALERTS } from "../../supabase/functions/_shared/access/policies/clickhouse-payment-health";

const q = (over: Partial<PaymentHealthQuery> = {}): PaymentHealthQuery => ({
  dateFrom: "2026-09-13",
  dateTo: "2026-10-12",
  filters: { ...EMPTY_PAYMENT_HEALTH_FILTERS, country: ["DE"], processor: ["STRIPE"] },
  dimension: "country",
  ...over,
});

beforeEach(() => {
  fns.run.mockReset();
  fns.alerts.mockReset();
});

describe("buildPaymentHealthRequest", () => {
  it("sends the window, only the filters that carry values, and the dimension only where the server reads it", () => {
    expect(buildPaymentHealthRequest("overview", q())).toEqual({
      action: "overview",
      date_from: "2026-09-13",
      date_to: "2026-10-12",
      filters: { processor: ["STRIPE"], country: ["DE"] },
    });
    expect(buildPaymentHealthRequest("declines", q())).toMatchObject({ action: "declines", dimension: "country" });
    expect(buildPaymentHealthRequest("refunds_support", q())).toMatchObject({ action: "refunds_support", dimension: "country" });
    expect(buildPaymentHealthRequest("retries", q())).not.toHaveProperty("dimension");
    expect(buildPaymentHealthRequest("overview", q({ dimension: null, filters: EMPTY_PAYMENT_HEALTH_FILTERS, dateFrom: null, dateTo: null }))).toEqual({ action: "overview" });
  });

  it("window-free actions send the action alone whatever the page's filters are", () => {
    expect(buildPaymentHealthRequest("options", q())).toEqual({ action: "options" });
    expect(buildPaymentHealthRequest("sources", q())).toEqual({ action: "sources" });
  });

  it("cleans filter lists: trimmed, de-duplicated, sorted, empties dropped", () => {
    expect(activeFilters({ country: [" US", "DE", "US", "", "DE "], funnel: [] })).toEqual({ country: ["DE", "US"] });
  });

  it("every request it builds passes the server's normalizer", () => {
    for (const action of PAYMENT_HEALTH_ACTIONS) {
      const body = buildPaymentHealthRequest(action, q());
      const normalized = serverNormalize(body, { today: "2026-10-12", pspVisible: true });
      expect(normalized.action).toBe(action);
      if (action === "overview") {
        expect(normalized.range).toEqual({ from: "2026-09-13", to: "2026-10-12", days: 30 });
        expect(normalized.filters.country).toEqual(["DE"]);
        expect(normalized.filters.processor).toEqual(["STRIPE"]);
      }
    }
    // The same request without the PSP key is refused by the server, which is why effectiveQuery strips it first.
    expect(() => serverNormalize(buildPaymentHealthRequest("overview", q()), { today: "2026-10-12", pspVisible: false })).toThrow(/psp_global/);
  });
});

describe("response shape check", () => {
  it("accepts every fixture response for its own action and refuses it for another", () => {
    expect(isCompletePaymentHealthResponse("overview", overviewResponse())).toBe(true);
    expect(isCompletePaymentHealthResponse("declines", declinesResponse())).toBe(true);
    expect(isCompletePaymentHealthResponse("retries", retriesResponse())).toBe(true);
    expect(isCompletePaymentHealthResponse("sources", sourcesResponse())).toBe(true);
    expect(isCompletePaymentHealthResponse("options", optionsResponse())).toBe(true);
    expect(isCompletePaymentHealthResponse("declines", overviewResponse())).toBe(false);
  });

  it("names what is missing", () => {
    const { trend: _trend, ...partial } = overviewResponse();
    expect(missingPaymentHealthFields("overview", partial)).toEqual(["trend"]);
    expect(missingPaymentHealthFields("overview", { ok: false })).toEqual(["ok", "action", "meta", "totals", "trend", "psp_mid_rows", "what_changed"]);
    expect(missingPaymentHealthFields("overview", null)).toEqual(["body"]);
  });
});

describe("loadPaymentHealth", () => {
  it("returns the typed response and sends the built body", async () => {
    fns.run.mockResolvedValueOnce(overviewResponse());
    const res = await loadPaymentHealth("overview", q());
    expect(res.action).toBe("overview");
    expect(res.totals.current.attempts).toBe(1000);
    expect(fns.run).toHaveBeenCalledWith({ action: "overview", date_from: "2026-09-13", date_to: "2026-10-12", filters: { processor: ["STRIPE"], country: ["DE"] } });
  });

  it("throws on an embedded ok:false and on an incomplete body (never a table of zeros)", async () => {
    fns.run.mockResolvedValueOnce({ ok: false, error: "warehouse busy" });
    await expect(loadPaymentHealth("overview", q())).rejects.toThrow("warehouse busy");
    const { psp_mid_rows: _rows, ...partial } = overviewResponse();
    fns.run.mockResolvedValueOnce(partial);
    await expect(loadPaymentHealth("overview", q())).rejects.toThrow(/Incomplete ClickHouse payment health response \(overview\): missing psp_mid_rows/);
    fns.run.mockResolvedValueOnce(declinesResponse());
    await expect(loadPaymentHealth("overview", q())).rejects.toThrow(/missing action/);
  });

  it("rethrows the typed Edge error untouched", async () => {
    const error = new ClickHouseRequestError("ClickHouse Edge Function failed: permission_denied", { status: 403, errorCode: "permission_denied", requestId: "req-9" });
    fns.run.mockRejectedValueOnce(error);
    await expect(loadPaymentHealth("overview", q())).rejects.toBe(error);
  });
});

describe("describePaymentHealthError", () => {
  const edge = (status: number, errorCode: string | null) => new ClickHouseRequestError(`ClickHouse Edge Function failed: ${errorCode ?? "x"}`, { status, errorCode, requestId: "req-1" });

  it("classifies access denials, bad requests, upstream failures, transport and shape errors", () => {
    expect(describePaymentHealthError(edge(403, "permission_denied"))).toMatchObject({ kind: "access", status: 403, errorCode: "permission_denied", requestId: "req-1" });
    expect(describePaymentHealthError(edge(403, "scope_not_supported")).kind).toBe("access");
    expect(describePaymentHealthError(edge(401, "invalid_session")).kind).toBe("access");
    expect(describePaymentHealthError(edge(400, "invalid_request")).kind).toBe("request");
    expect(describePaymentHealthError(edge(400, "unknown_action")).kind).toBe("request");
    expect(describePaymentHealthError(edge(500, "scope_violation")).kind).toBe("upstream");
    expect(describePaymentHealthError(edge(502, "upstream_error")).kind).toBe("upstream");
    expect(describePaymentHealthError(new Error("Failed to fetch"))).toMatchObject({ kind: "transport", status: null, errorCode: null });
    expect(describePaymentHealthError(new Error("Incomplete ClickHouse payment health response (overview): missing trend.")).kind).toBe("shape");
  });
});

describe("cache keys", () => {
  const parts = (over: Partial<{ userScopeHash: string; warehouseVersion: string; action: "overview" | "declines" | "options" | "sources"; request: PaymentHealthQuery }> = {}) => ({
    userScopeHash: "p-owner",
    warehouseVersion: "whv_x",
    action: "overview" as const,
    request: q(),
    ...over,
  });

  it("carry the root, the action, the schema version, the partition and the warehouse version", () => {
    const key = paymentHealthQueryKey(parts());
    expect(key[0]).toBe(PAYMENT_HEALTH_QUERY_ROOT);
    expect(key[1]).toBe("overview");
    expect(key[2]).toBe(PAYMENT_HEALTH_RESPONSE_SCHEMA_VERSION);
    expect(key[3]).toBe("p-owner");
    expect(key[4]).toBe("whv_x");
    expect(WAREHOUSE_DEPENDENT_ROOTS).toContain(PAYMENT_HEALTH_QUERY_ROOT);
  });

  it("are stable for logically identical queries and differ by partition, version, action and filters", () => {
    const same = q({ filters: { ...EMPTY_PAYMENT_HEALTH_FILTERS, processor: ["STRIPE"], country: ["DE"] } });
    expect(hashKey(paymentHealthQueryKey(parts()))).toBe(hashKey(paymentHealthQueryKey(parts({ request: same }))));
    expect(hashKey(paymentHealthQueryKey(parts()))).not.toBe(hashKey(paymentHealthQueryKey(parts({ userScopeHash: "p-viewer" }))));
    expect(hashKey(paymentHealthQueryKey(parts()))).not.toBe(hashKey(paymentHealthQueryKey(parts({ warehouseVersion: "whv_y" }))));
    expect(hashKey(paymentHealthQueryKey(parts()))).not.toBe(hashKey(paymentHealthQueryKey(parts({ action: "declines" }))));
    expect(hashKey(paymentHealthQueryKey(parts()))).not.toBe(hashKey(paymentHealthQueryKey(parts({ request: q({ filters: { ...EMPTY_PAYMENT_HEALTH_FILTERS, country: ["US"] } }) }))));
  });

  it("ignore the dimension outside declines / refunds_support and everything but the action for window-free actions", () => {
    expect(normalizePaymentHealthRequest("overview", q({ dimension: "country" }))).toEqual(normalizePaymentHealthRequest("overview", q({ dimension: "funnel" })));
    expect(normalizePaymentHealthRequest("declines", q({ dimension: "country" }))).not.toEqual(normalizePaymentHealthRequest("declines", q({ dimension: "funnel" })));
    expect(normalizePaymentHealthRequest("options", q())).toEqual(normalizePaymentHealthRequest("options", EMPTY_PAYMENT_HEALTH_QUERY));
    expect(normalizePaymentHealthRequest("sources", q())).toEqual({ date_from: null, date_to: null, filters: {}, dimension: null });
  });
});

describe("page state → query", () => {
  const TODAY = "2026-10-12";

  it("presets roll with today's UTC day; custom uses the typed days", () => {
    expect(resolveRange({ rangePreset: "30d", dateFrom: "", dateTo: "" }, TODAY)).toEqual({ from: "2026-09-13", to: "2026-10-12" });
    expect(resolveRange({ rangePreset: "7d", dateFrom: "2020-01-01", dateTo: "2020-01-02" }, TODAY)).toEqual({ from: "2026-10-06", to: "2026-10-12" });
    expect(resolveRange({ rangePreset: "custom", dateFrom: "2026-08-01", dateTo: "2026-08-31" }, TODAY)).toEqual({ from: "2026-08-01", to: "2026-08-31" });
    expect(resolveRange({ rangePreset: "custom", dateFrom: "not-a-day", dateTo: "" }, TODAY)).toEqual({ from: null, to: null });
  });

  it("maps single selections to one-element lists and 'all' to none", () => {
    const query = effectiveQuery({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, country: "DE", initiation: "mit", transactionType: "trial", processor: "STRIPE", dimension: "merchant_account" }, true, TODAY);
    expect(query.filters).toEqual({ ...EMPTY_PAYMENT_HEALTH_FILTERS, country: ["DE"], initiation: ["mit"], transaction_type: ["trial"], processor: ["STRIPE"] });
    expect(query.dimension).toBe("merchant_account");
    expect(query.dateFrom).toBe("2026-09-13");
    expect(effectiveQuery(DEFAULT_PAYMENT_HEALTH_UI_STATE, true, TODAY).dimension).toBeNull();
  });

  it("drops a persisted PSP filter and PSP dimension when the server did not grant them", () => {
    const state = { ...DEFAULT_PAYMENT_HEALTH_UI_STATE, processor: "STRIPE", merchantAccount: "mid-1", descriptor: "d:abc", country: "DE", dimension: "descriptor" as const };
    expect(hasPspSelection(state)).toBe(true);
    expect(hasPspSelection({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, country: "DE" })).toBe(false);
    const query = effectiveQuery(state, false, TODAY);
    expect(query.filters.processor).toEqual([]);
    expect(query.filters.merchant_account).toEqual([]);
    expect(query.filters.descriptor).toEqual([]);
    expect(query.filters.country).toEqual(["DE"]);
    expect(query.dimension).toBeNull();
    // A non-PSP dimension survives.
    expect(effectiveQuery({ ...state, dimension: "country" }, false, TODAY).dimension).toBe("country");
  });

  it("knows when filters are active and coerces an unknown tab", () => {
    expect(hasActiveFilters(DEFAULT_PAYMENT_HEALTH_UI_STATE)).toBe(false);
    expect(hasActiveFilters({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, cardNetwork: "VISA" })).toBe(true);
    expect(hasActiveFilters({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, rangePreset: "7d" })).toBe(true);
    expect(coerceTab("retries")).toBe("retries");
    expect(coerceTab("disputes")).toBe("overview");
  });

  it("offers the PSP dimensions only with the key", () => {
    expect(dimensionOptions(false)).toEqual(["funnel", "country", "card_network", "payment_method", "initiation", "stage"]);
    expect(dimensionOptions(true)).toContain("merchant_account");
  });

  it("names a custom window the server would refuse (from after to, over 400 days) and nothing else", () => {
    expect(customRangeProblem({ rangePreset: "custom", dateFrom: "2026-09-10", dateTo: "2026-09-01" })).toBe('"From" (2026-09-10) is after "To" (2026-09-01).');
    expect(customRangeProblem({ rangePreset: "custom", dateFrom: "2025-01-01", dateTo: "2026-10-12" })).toBe("The window spans 650 days; the maximum is 400.");
    expect(customRangeProblem({ rangePreset: "custom", dateFrom: "2026-09-01", dateTo: "2026-09-30" })).toBeNull();
    // Half filled: the server defaults the other side. Presets: never a problem.
    expect(customRangeProblem({ rangePreset: "custom", dateFrom: "2026-09-10", dateTo: "" })).toBeNull();
    expect(customRangeProblem({ rangePreset: "30d", dateFrom: "2026-09-10", dateTo: "2026-09-01" })).toBeNull();
    // The server agrees on both refusals.
    expect(() => serverNormalize({ action: "overview", date_from: "2026-09-10", date_to: "2026-09-01" }, { today: "2026-10-12", pspVisible: true })).toThrow(/after/);
    expect(() => serverNormalize({ action: "overview", date_from: "2025-01-01", date_to: "2026-10-12" }, { today: "2026-10-12", pspVisible: true })).toThrow(/maximum is 400/);
  });
});

describe("formatting rules", () => {
  it("a rate without a denominator is 'no data', never 0%", () => {
    expect(fmtPct(null)).toBe("no data");
    expect(fmtPct(0)).toBe("0.0%");
    expect(fmtPct(0.8234)).toBe("82.3%");
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
    expect(summarizeRate(rate(0, 0)).text).toBe("no data");
    expect(summarizeRate(rate(10, 50))).toMatchObject({ text: "20.0%", smallSample: true });
  });

  it("comparison flags come from the server, the tone from the metric's direction", () => {
    const up = summarizeComparison(comparison([820, 1000], [760, 900], { significant: true }), { higherIsBetter: true });
    expect(up).toMatchObject({ current: "82.0%", baseline: "84.4%", direction: "down", tone: "bad", significant: true });
    expect(up.flags).toEqual(["significant"]);
    const refunds = summarizeComparison(comparison([24, 820], [20, 760]), { higherIsBetter: false });
    expect(refunds.tone).toBe("bad");
    expect(refunds.flags).toEqual([]);
    const small = summarizeComparison(comparison([3, 50], [2, 40]), { higherIsBetter: true });
    expect(small.flags).toContain("small sample");
    const immature = summarizeComparison(comparison([3, 500], [2, 400], { immature: true }), { higherIsBetter: true });
    expect(immature.flags).toContain("incomplete period");
    const none = summarizeComparison(comparison([0, 0], [0, 0]), { higherIsBetter: true });
    expect(none).toMatchObject({ current: "no data", delta: "—", direction: "unknown", tone: "neutral", flags: [] });
    expect(fmtPoints(-1.25)).toBe("−1.3 pp");
    expect(fmtPoints(null)).toBe("—");
  });

  it("view-model helpers", () => {
    const rows = declineClassRows({ insufficient_funds: 90, issuer_suspected_fraud: 12, not_a_decline: 0 }, 180);
    expect(rows.map((row) => row.key)).toEqual(["insufficient_funds", "issuer_suspected_fraud"]);
    expect(rows[1].label).toBe("Issuer suspected fraud (decline, not fraud)");
    expect(rows[0].share).toBeCloseTo(0.5);
    expect(topDeclineClass({ decline_classes: { insufficient_funds: 2, issuer_suspected_fraud: 5 } })).toEqual({ label: "Issuer suspected fraud (decline, not fraud)", count: 5 });
    expect(topDeclineClass({ decline_classes: {} })).toBeNull();
    const groups = groupWhatChanged(overviewResponse().what_changed);
    expect(groups.map((group) => group.dimension)).toEqual(["country", "processor"]);
  });
});

// =====================================================================================
// P2.5 — payment risk alerts
// =====================================================================================

describe("alert requests", () => {
  it("alerts_list: canonical filter lists (contract order, de-duplicated, unknown values dropped) that the server's normalizer accepts", () => {
    expect(buildAlertsListRequest({})).toEqual({ action: "alerts_list" });
    expect(buildAlertsListRequest({ status: ["investigating", "new", "new"], severity: ["critical"] })).toEqual({ action: "alerts_list", status: ["new", "investigating"], severity: ["critical"] });
    expect(buildAlertsListRequest({ status: ["bogus" as never], rule: ["data_stale"] })).toEqual({ action: "alerts_list", rule: ["data_stale"] });
    expect(OPEN_ALERTS_FILTERS).toEqual({ status: ["new", "investigating"], severity: [], rule: [] });
    const normalized = normalizeAlertsListRequest(buildAlertsListRequest({ status: ["resolved", "dismissed"], severity: ["warning", "info"], rule: ["approval_drop"] }));
    expect(normalized).toEqual({ status: ["resolved", "dismissed"], severity: ["info", "warning"], rule: ["approval_drop"], limit: 100 });
  });

  it("alert_update: validated by the contract's normalizer before anything is sent; the note is trimmed or left out", async () => {
    const id = "AAAA0000-0000-4000-8000-0000000000A1";
    expect(buildAlertUpdateRequest({ alertId: id, status: "investigating", note: "  looking  " })).toEqual({ action: "alert_update", alert_id: id.toLowerCase(), status: "investigating", note: "looking" });
    expect(buildAlertUpdateRequest({ alertId: id, status: "resolved", note: "   " })).toEqual({ action: "alert_update", alert_id: id.toLowerCase(), status: "resolved" });
    expect(normalizeAlertUpdateRequest(buildAlertUpdateRequest({ alertId: id, status: "dismissed", note: "dup" }))).toEqual({ alert_id: id.toLowerCase(), status: "dismissed", note: "dup" });
    await expect(updatePaymentAlert({ alertId: "not-a-uuid", status: "resolved" })).rejects.toThrow(/uuid/);
    await expect(updatePaymentAlert({ alertId: id, status: "resolved", note: "x".repeat(ALERT_NOTE_MAX_LENGTH + 1) })).rejects.toThrow(/longer than 1000/);
    expect(fns.alerts).not.toHaveBeenCalled();
  });

  it("goes through the alerts transport (never the breaker-gated page runner) and returns the typed answers", async () => {
    fns.alerts.mockResolvedValueOnce(alertsListResponse([approvalAlert()]));
    const list = await loadPaymentAlerts({ status: ["new"] });
    expect(list.alerts[0].id).toBe(ALERT_IDS.approval);
    expect(fns.alerts).toHaveBeenLastCalledWith({ action: "alerts_list", status: ["new"] });
    fns.alerts.mockResolvedValueOnce({ ok: true, action: "alert_update", alert: approvalAlert({ status: "investigating" }) });
    expect((await updatePaymentAlert({ alertId: ALERT_IDS.approval, status: "investigating" })).alert.status).toBe("investigating");
    fns.alerts.mockResolvedValueOnce({ ok: true, action: "alerts_run", run: runSummary({ trigger: "manual" }), skipped: null });
    expect((await runPaymentAlerts()).run?.trigger).toBe("manual");
    expect(fns.alerts).toHaveBeenLastCalledWith({ action: "alerts_run" });
    expect(fns.run).not.toHaveBeenCalled();
  });

  it("an embedded ok:false and an incomplete body throw (shape), never an empty list", async () => {
    fns.alerts.mockResolvedValueOnce({ ok: false, error: "alerts store busy" });
    await expect(loadPaymentAlerts({})).rejects.toThrow("alerts store busy");
    const { counts: _counts, ...partial } = alertsListResponse([]);
    fns.alerts.mockResolvedValueOnce(partial);
    const error = await loadPaymentAlerts({}).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/Incomplete ClickHouse payment health response \(alerts_list\): missing counts/);
    expect(describePaymentHealthError(error).kind).toBe("shape");
    expect(missingAlertsFields("alerts_list", { ...alertsListResponse([]), alerts: [null] })).toEqual(["alerts"]);
    expect(missingAlertsFields("alerts_run", { ok: true, action: "alerts_run" })).toEqual(["run"]);
    expect(isCompleteAlertsListResponse(alertsListResponse([staleAlert()]))).toBe(true);
    expect(isCompleteAlertsListResponse(overviewResponse())).toBe(false);
  });

  it("the alert refusals classify as request errors (shown, never retried), not as access denials", () => {
    const edge = (status: number, errorCode: string) => new ClickHouseRequestError(`ClickHouse Edge Function failed: ${errorCode}`, { status, errorCode, requestId: "req-a" });
    expect(describePaymentHealthError(edge(429, "rate_limited")).kind).toBe("request");
    expect(describePaymentHealthError(edge(404, "alert_not_found")).kind).toBe("request");
    expect(describePaymentHealthError(edge(400, "invalid_transition")).kind).toBe("request");
    expect(describePaymentHealthError(edge(403, "permission_denied")).kind).toBe("access");
  });
});

describe("alert cache keys", () => {
  it("own root, never persisted with the warehouse roots, keyed by partition and canonical filters", () => {
    const key = paymentHealthAlertsQueryKey({ userScopeHash: "p-owner", filters: { status: ["investigating", "new"] } });
    expect(key).toEqual([PAYMENT_HEALTH_ALERTS_QUERY_ROOT, "alerts_list", PAYMENT_HEALTH_ALERTS_SCHEMA_VERSION, "p-owner", { status: ["new", "investigating"], severity: [], rule: [] }]);
    expect(WAREHOUSE_DEPENDENT_ROOTS).not.toContain(PAYMENT_HEALTH_ALERTS_QUERY_ROOT);
    expect(PAYMENT_HEALTH_ALERTS_QUERY_PREFIX).toEqual([PAYMENT_HEALTH_ALERTS_QUERY_ROOT]);
    expect(hashKey(key)).toBe(hashKey(paymentHealthAlertsQueryKey({ userScopeHash: "p-owner", filters: OPEN_ALERTS_FILTERS })));
    expect(hashKey(key)).not.toBe(hashKey(paymentHealthAlertsQueryKey({ userScopeHash: "p-viewer", filters: OPEN_ALERTS_FILTERS })));
    expect(hashKey(key)).not.toBe(hashKey(paymentHealthAlertsQueryKey({ userScopeHash: "p-owner", filters: { status: ["new"] } })));
  });
});

describe("Alerts tab state", () => {
  it("the default view is the open alerts (the badge's key); persisted junk falls back to it", () => {
    expect(alertsFilters(DEFAULT_PAYMENT_HEALTH_UI_STATE)).toEqual(OPEN_ALERTS_FILTERS);
    expect(alertsFilters({ alertStatus: "all", alertSeverity: "critical" })).toEqual({ status: [], severity: ["critical"], rule: [] });
    expect(alertsFilters({ alertStatus: "dismissed", alertSeverity: "all" })).toEqual({ status: ["dismissed"], severity: [], rule: [] });
    expect(coerceAlertStatusFilter("archived")).toBe("open");
    expect(coerceAlertSeverityFilter(undefined)).toBe("all");
    expect(coerceTab("alerts")).toBe("alerts");
  });

  it("evidence.reproduce → the tab, the window as a custom range, exactly its filters, its dimension", () => {
    const reproduce = parseAlertReproduce((approvalAlert().evidence as Record<string, unknown>).reproduce);
    expect(reproduce).toEqual({ action: "declines", dateFrom: "2026-10-04", dateTo: "2026-10-10", filters: { initiation: ["cit"] }, dimension: "merchant_account" });
    const patch = reproduceState(reproduce!, true)!;
    expect(patch).toMatchObject({ tab: "declines", rangePreset: "custom", dateFrom: "2026-10-04", dateTo: "2026-10-10", initiation: "cit", country: "all", processor: "all", merchantAccount: "all", dimension: "merchant_account" });
    // The page then sends exactly the alert's request, whatever the filters were.
    const query = effectiveQuery({ ...DEFAULT_PAYMENT_HEALTH_UI_STATE, country: "DE", ...patch }, true, "2026-10-13");
    expect(buildPaymentHealthRequest("declines", query)).toEqual({ action: "declines", date_from: "2026-10-04", date_to: "2026-10-10", filters: { initiation: ["cit"] }, dimension: "merchant_account" });
    // A PSP dimension without the key would be a 403: no link at all.
    expect(reproduceState(reproduce!, false)).toBeNull();
    // Overview keeps the dimension as it is; sources only switches the tab.
    expect(reproduceState(parseAlertReproduce((fraudLowAlert().evidence as Record<string, unknown>).reproduce)!, false)).not.toHaveProperty("dimension");
    expect(reproduceState(parseAlertReproduce((staleAlert().evidence as Record<string, unknown>).reproduce)!, false)).toEqual({ tab: "sources" });
    // The single-select bar cannot show a multi-valued filter; unknown actions and malformed days are refused.
    expect(reproduceState({ action: "overview", dateFrom: null, dateTo: null, filters: { country: ["DE", "US"] }, dimension: null }, true)).toBeNull();
    expect(parseAlertReproduce({ action: "options" })).toBeNull();
    expect(parseAlertReproduce({ action: "alerts_list" })).toBeNull();
    expect(parseAlertReproduce({ action: "retries", date_from: "10/04/2026", filters: { initiation: "cit", country: ["", 7] } })).toEqual({ action: "retries", dateFrom: null, dateTo: null, filters: {}, dimension: null });
  });
});

describe("alert view model", () => {
  it("the status buttons are exactly the contract's transitions, behind the policy's key", () => {
    for (const from of ALERT_STATUSES) {
      const offered = statusActions(from).map((action) => action.to);
      expect(offered.sort()).toEqual(ALERT_STATUSES.filter((to) => isAllowedAlertTransition(from, to)).sort());
    }
    expect(statusActions("new").map((action) => action.label)).toEqual(["Investigating", "Resolve", "Dismiss"]);
    expect(statusActions("resolved").map((action) => action.label)).toEqual(["Reopen"]);
    expect(MANAGE_ALERTS_PERMISSION).toBe(PAYMENT_HEALTH_MANAGE_ALERTS);
  });

  it("low confidence is info whatever is stored; values and changes by unit; scope from labels only", () => {
    expect(displaySeverity({ severity: "critical", data_confidence: "low" })).toBe("info");
    expect(displaySeverity({ severity: "critical", data_confidence: "high" })).toBe("critical");
    expect(fmtAlertValue("rate", 0.0512)).toBe("5.12%");
    expect(fmtAlertValue("rate", null)).toBe("—");
    expect(fmtAlertValue("days", 15)).toBe("15 d");
    expect(fmtAlertValue("hours", 80.26)).toBe("80.3 h");
    expect(fmtAlertChange("rate", -13)).toBe("−13.00 pp");
    expect(fmtAlertChange("count", 3)).toBe("+3");
    expect(scopeLabels(approvalAlert().scope)).toEqual({ primary: "Stripe MID #1", details: ["Stripe", "CIT"], unlabelled: false });
    expect(scopeLabels({ kind: "tenant", subject: "post_ban", initiation: "mit" })).toEqual({ primary: "Whole workspace", details: ["Re-attempts after a do-not-retry decline", "MIT"], unlabelled: false });
    // approval_drop's PSP-wide line names the processor, not an account; the support pipeline has its own freshness line.
    expect(scopeLabels({ kind: "account", processor: { key: "STRIPE", label: "Stripe" }, initiation: "cit" })).toEqual({ primary: "All merchant accounts", details: ["Stripe", "CIT"], unlabelled: false });
    expect(scopeLabels({ kind: "tenant", subject: "support_sync" })).toEqual({ primary: "Whole workspace", details: ["Support requests sync"], unlabelled: false });
    expect(countEvidenceRows({ rule_key: "data_stale", unit: "hours", evidence: { stream: "support", last_synced_at: "2026-09-29T09:00:00.000Z", age_hours: 99, support_through: "2026-09-29" } }).map((row) => row.label)).toEqual([
      "Last support requests sync", "Age", "Support requests through",
    ]);
    expect(alertFlags(fraudLowAlert())).toEqual(["low confidence", "small sample"]);
    expect(alertFlags(approvalAlert())).toEqual(["significant"]);
  });

  it("evidence is read through known fields only", () => {
    const evidence = rateEvidence(approvalAlert().evidence)!;
    expect(evidence.current).toMatchObject({ from: "2026-10-04", to: "2026-10-10", numerator: 620, denominator: 1000 });
    expect(evidence.thresholds).toEqual({ warning: 5, critical: 10 });
    expect(rateEvidence(postBanAlert().evidence)).toBeNull();
    expect(countEvidenceRows(staleAlert())).toEqual([
      { label: "Data through", value: "2026-09-28" },
      { label: "Today (UTC)", value: "2026-10-13" },
      { label: "Lag", value: "15 d" },
      { label: "Last import", value: "2026-09-28 18:00 UTC" },
      { label: "Thresholds", value: "warning ≥ 7 d · critical ≥ 14 d" },
    ]);
    expect(JSON.stringify(countEvidenceRows(postBanAlert()))).not.toContain(UI_SENTINELS.instrumentToken);
    expect(accountCounts(postBanAlert().evidence)).toEqual([{ label: "Stripe MID #1", processor: "Stripe", count: 3 }]);
  });

  it("a recommendation the plan Q ban flags is withheld; the copy of the refusals; the run interval; who did it", () => {
    expect(compliantActions(["Refund quickly on request.", "Spread the volume across two MIDs.", "Use another descriptor."])).toEqual({ shown: ["Refund quickly on request."], withheld: 2 });
    expect(compliantText("Unverified: route traffic to a backup PSP.")).toBeNull();
    const error = (errorCode: string) => ({ kind: "request" as const, message: "raw", status: 400, errorCode, requestId: null });
    expect(alertActionErrorText(error("rate_limited"))).toMatch(/less than 5 minutes ago/);
    expect(alertActionErrorText(error("invalid_transition"))).toMatch(/changed in the meantime/);
    expect(alertActionErrorText(error("alert_not_found"))).toMatch(/no longer available/);
    expect(alertActionErrorText(error("other"))).toBe("raw");
    expect(nextManualRunAt({ started_at: "2026-10-13T07:40:00.000Z" }, 300)).toBe(Date.parse("2026-10-13T07:45:00.000Z"));
    expect(nextManualRunAt(null, 300)).toBeNull();
    expect(actorText(null, "u-1")).toBe("the alert engine");
    expect(actorText("U-1", "u-1")).toBe("you");
    expect(actorText("u-2", "u-1")).toBe("a teammate");
  });
});
