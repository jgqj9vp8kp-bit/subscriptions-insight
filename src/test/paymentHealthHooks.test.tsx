// usePaymentHealthQuery: keyed by the access partition, stale-while-revalidate,
// typed errors, and a 4xx is never asked again (R12). The alert hooks (P2.5):
// the same rules for the list, and both mutations refetch every alert list.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/services/supabaseClient", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/services/paymentHealthDataSource", async (importActual) => {
  const actual = await importActual<typeof import("@/services/paymentHealthDataSource")>();
  return { ...actual, loadPaymentHealth: vi.fn(), loadPaymentAlerts: vi.fn(), updatePaymentAlert: vi.fn(), runPaymentAlerts: vi.fn() };
});

import { ClickHouseRequestError } from "@/services/clickhouse";
import {
  EMPTY_PAYMENT_HEALTH_QUERY,
  OPEN_ALERTS_FILTERS,
  loadPaymentAlerts,
  loadPaymentHealth,
  runPaymentAlerts,
  updatePaymentAlert,
  type PaymentHealthQuery,
} from "@/services/paymentHealthDataSource";
import { paymentHealthAlertsQueryKey, paymentHealthQueryKey } from "@/services/paymentHealthCache";
import { useAlertStatusMutation, usePaymentAlertsQuery, usePaymentHealthQuery, useRunAlertsMutation } from "@/hooks/usePaymentHealth";
import { AccessContext, buildAccessValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { overviewResponse } from "./support/paymentHealthResponses";
import { ALERT_IDS, alertsListResponse, runSummary, staleAlert } from "./support/paymentHealthAlertResponses";

const load = loadPaymentHealth as unknown as ReturnType<typeof vi.fn>;
const loadAlerts = loadPaymentAlerts as unknown as ReturnType<typeof vi.fn>;
const updateAlert = updatePaymentAlert as unknown as ReturnType<typeof vi.fn>;
const runAlerts = runPaymentAlerts as unknown as ReturnType<typeof vi.fn>;
const SCOPE = "p-test";
const WHV = "whv_test";
const query: PaymentHealthQuery = { ...EMPTY_PAYMENT_HEALTH_QUERY, dateFrom: "2026-09-13", dateTo: "2026-10-12" };
const keyFor = (partition = SCOPE) => paymentHealthQueryKey({ userScopeHash: partition, warehouseVersion: WHV, action: "overview", request: query });

let client: QueryClient;
function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}
function mount(enabled = true) {
  return renderHook(() => usePaymentHealthQuery({ action: "overview", query, userScopeHash: SCOPE, warehouseVersion: WHV, enabled }), { wrapper });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retryDelay: 1 } } });
  load.mockReset();
  loadAlerts.mockReset();
  updateAlert.mockReset();
  runAlerts.mockReset();
});
afterEach(() => client.clear());

describe("usePaymentHealthQuery", () => {
  it("loads once and exposes the typed response", async () => {
    load.mockResolvedValueOnce(overviewResponse());
    const { result } = mount();
    expect(result.current.isInitialLoading).toBe(true);
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.totals.current.attempts).toBe(1000);
    expect(result.current.error).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("overview", query);
    expect(client.getQueryData(keyFor())).toBeDefined();
  });

  it("serves a cached entry of the same partition and never one of another", async () => {
    client.setQueryData(keyFor(), overviewResponse());
    const { result } = mount();
    expect(result.current.data?.action).toBe("overview");
    expect(result.current.isInitialLoading).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(load).not.toHaveBeenCalled();
    client.clear();
    load.mockReset();
    client.setQueryData(keyFor("p-other"), overviewResponse());
    load.mockResolvedValueOnce(overviewResponse());
    const other = mount();
    expect(other.result.current.data).toBeNull();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
  });

  it("a 403 is never retried and becomes an access error", async () => {
    load.mockRejectedValue(new ClickHouseRequestError("ClickHouse Edge Function failed: scope_not_supported", { status: 403, errorCode: "scope_not_supported", requestId: "req-1" }));
    const { result } = mount();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error).toMatchObject({ kind: "access", status: 403, errorCode: "scope_not_supported", requestId: "req-1" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("a 400 is never retried either; a transport failure is retried", async () => {
    load.mockRejectedValue(new ClickHouseRequestError("ClickHouse Edge Function failed: date_from is after date_to", { status: 400, errorCode: "invalid_request" }));
    const bad = mount();
    await waitFor(() => expect(bad.result.current.error?.kind).toBe("request"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(load).toHaveBeenCalledTimes(1);
    bad.unmount();
    client.clear();
    load.mockReset();
    load.mockRejectedValue(new Error("Failed to fetch"));
    const down = mount();
    await waitFor(() => expect(down.result.current.error?.kind).toBe("transport"), { timeout: 3000 });
    expect(load.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps the last response visible when a refresh fails", async () => {
    client.setQueryData(keyFor(), overviewResponse());
    const entry = client.getQueryCache().find({ queryKey: keyFor() });
    if (entry) entry.state.dataUpdatedAt = Date.now() - 10 * 60 * 1000;
    load.mockRejectedValue(new ClickHouseRequestError("ClickHouse Edge Function failed: upstream_error", { status: 502, errorCode: "upstream_error" }));
    const { result } = mount();
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data?.action).toBe("overview");
    expect(result.current.error?.kind).toBe("upstream");
  });

  it("sends nothing while disabled or while the access partition is empty", async () => {
    const disabled = mount(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(load).not.toHaveBeenCalled();
    disabled.unmount();
    // Inside an AccessProvider the partition comes from the context: "" ⇒ no request.
    const row: MyAccess = {
      status: "ok", workspace_id: "ws", member_id: "m", user_id: "u", email: "m@example.com", display_name: null, is_data_owner: false, raw_access: false,
      role: { id: "r", key: "custom", name: "Custom", is_owner: false, permissions: ["payment_health.view"] },
      funnel_scope: { mode: "all", funnel_ids: [], paths: [] }, access_version: "1", partition: "p-ctx",
    };
    const loading = buildAccessValue({ status: "loading", access: null, userId: "u" });
    expect(loading.partition).toBe("");
    const withAccess = (value: typeof loading) => ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, createElement(AccessContext.Provider, { value }, children));
    const blocked = renderHook(() => usePaymentHealthQuery({ action: "overview", query, userScopeHash: "ignored", warehouseVersion: WHV, enabled: true }), { wrapper: withAccess(loading) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(load).not.toHaveBeenCalled();
    blocked.unmount();
    load.mockResolvedValueOnce(overviewResponse());
    const ok = buildAccessValue({ status: "ok", access: row, userId: "u" });
    renderHook(() => usePaymentHealthQuery({ action: "overview", query, userScopeHash: "ignored", warehouseVersion: WHV, enabled: true }), { wrapper: withAccess(ok) });
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    // Keyed by the context partition, not the caller's argument.
    expect(client.getQueryData(keyFor("p-ctx"))).toBeDefined();
    expect(client.getQueryData(keyFor("ignored"))).toBeUndefined();
  });
});

describe("payment alert hooks (P2.5)", () => {
  const alertsKey = (partition = SCOPE) => paymentHealthAlertsQueryKey({ userScopeHash: partition, filters: OPEN_ALERTS_FILTERS });
  const mountAlerts = () => renderHook(() => usePaymentAlertsQuery({ filters: OPEN_ALERTS_FILTERS, userScopeHash: SCOPE, enabled: true }), { wrapper });

  it("loads the list under the partition key; a 403 is never asked again, not even by a second observer of the same key", async () => {
    loadAlerts.mockResolvedValueOnce(alertsListResponse([staleAlert()]));
    const first = mountAlerts();
    await waitFor(() => expect(first.result.current.data?.counts.open).toBe(1));
    expect(loadAlerts).toHaveBeenCalledWith(OPEN_ALERTS_FILTERS);
    expect(client.getQueryData(alertsKey())).toBeDefined();
    first.unmount();
    client.clear();

    loadAlerts.mockReset();
    loadAlerts.mockRejectedValue(new ClickHouseRequestError("ClickHouse Edge Function failed: permission_denied", { status: 403, errorCode: "permission_denied" }));
    const badge = mountAlerts();
    await waitFor(() => expect(badge.result.current.error?.kind).toBe("access"));
    // The tab mounts the same key after the badge's refusal.
    const tab = mountAlerts();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tab.result.current.error?.kind).toBe("access");
    expect(loadAlerts).toHaveBeenCalledTimes(1);
  });

  it("a status change refetches every alert list (on success and on a refusal); a run does too", async () => {
    loadAlerts.mockResolvedValue(alertsListResponse([staleAlert()]));
    const list = mountAlerts();
    await waitFor(() => expect(list.result.current.data).not.toBeNull());
    expect(loadAlerts).toHaveBeenCalledTimes(1);

    updateAlert.mockResolvedValueOnce({ ok: true, action: "alert_update", alert: staleAlert({ status: "investigating" }) });
    const status = renderHook(() => useAlertStatusMutation(), { wrapper });
    await status.result.current.mutateAsync({ alertId: ALERT_IDS.stale, status: "investigating", note: "on it" });
    expect(updateAlert).toHaveBeenCalledWith({ alertId: ALERT_IDS.stale, status: "investigating", note: "on it" });
    await waitFor(() => expect(loadAlerts).toHaveBeenCalledTimes(2));

    updateAlert.mockRejectedValueOnce(new ClickHouseRequestError("ClickHouse Edge Function failed: invalid_transition", { status: 400, errorCode: "invalid_transition" }));
    await expect(status.result.current.mutateAsync({ alertId: ALERT_IDS.stale, status: "new" })).rejects.toThrow(/invalid_transition/);
    await waitFor(() => expect(loadAlerts).toHaveBeenCalledTimes(3));
    // A mutation is never retried.
    expect(updateAlert).toHaveBeenCalledTimes(2);

    runAlerts.mockResolvedValueOnce({ ok: true, action: "alerts_run", run: runSummary({ trigger: "manual" }), skipped: null });
    const run = renderHook(() => useRunAlertsMutation(), { wrapper });
    await run.result.current.mutateAsync();
    await waitFor(() => expect(loadAlerts).toHaveBeenCalledTimes(4));
  });
});
