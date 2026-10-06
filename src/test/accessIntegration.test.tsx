// Cross-track contracts wired by the integration pass (Phase 0 + 1, Milestone A):
// the browser half of a server policy, and cache-isolation follow-ups that span
// two tracks. Each block names the server/client pair it keeps in agreement.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const sb = vi.hoisted(() => ({
  invoke: vi.fn(),
  client: {
    functions: { invoke: (...args: unknown[]) => sb.invoke(...args) },
    auth: {
      getSession: async () => ({ data: { session: { access_token: "token", user: { id: "user-a" } } }, error: null }),
    },
  },
}));
vi.mock("@/services/supabaseClient", () => ({ supabase: sb.client, isSupabaseConfigured: true }));

const support = vi.hoisted(() => ({ loadSupportBundle: vi.fn(), loadSupportPage: vi.fn() }));
vi.mock("@/services/supportDataSource", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadSupportBundle: support.loadSupportBundle,
  loadSupportPage: support.loadSupportPage,
}));

import { buildPaymentAnalyticsRequest, type PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";
import { normalizePaymentRequest, paymentAnalyticsBundleKey } from "@/services/paymentAnalyticsCache";
import { normalizeClickHousePaymentAnalyticsAction, PAYMENT_ANALYTICS_AI_PURPOSE } from "../../supabase/functions/_shared/access/policies/clickhouse-payment-analytics.ts";
import { useSupportData } from "@/hooks/useSupportCache";
import type { SupportQuery } from "@/services/supportDataSource";
import { askAssistant } from "@/services/aiAssistantClient";
import { generateNarrative } from "@/services/reportAi";
import { isUnavailableRefusal, readEdgeInvokeRefusal } from "@/services/edgeInvokeError";
import {
  COHORTS_UI_SETTINGS_OWNER_KEY,
  COHORTS_UI_STATE_STORAGE_KEY,
  buildCohortsUiSettingsPayload,
  loadCohortsUiSettingsLocal,
  saveCohortsUiSettingsLocal,
  type CohortsUiSettingsDefaults,
} from "@/services/cohortsUiSettings";
import { autoSyncClickHouseAfterImport, resetClickHouseClientState } from "@/services/clickhouse";
import type { AssistantInput } from "@/services/aiAssistant";
import type { NarrativeInput } from "@/services/reportNarrative";

function refusal(status: number, body: Record<string, unknown>) {
  return { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify(body), { status }) };
}

// ---- AI pass rates: client purpose ↔ server ai_pass_rates action -------------------

const AI_QUERY: PaymentAnalyticsQuery = {
  dateBasis: "cohort",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  funnel: "all", campaignPath: "all", campaignId: "all", mediaBuyer: "all",
  country: "all", cardType: "all", stage: "all", declineReason: "all",
  transactionType: "all", outcome: "all",
  groupBy: "campaign_path", firstTxDimension: "funnel", renewalDimension: "funnel",
};

describe("AI pass-rate call (useAiCohortSignals → clickhouse-payment-analytics)", () => {
  it("the purpose flag routes to ai_pass_rates; the Payment Pass request is unchanged", () => {
    const ai = buildPaymentAnalyticsRequest({ ...AI_QUERY, purpose: "ai_pass_rates" });
    expect(ai.purpose).toBe(PAYMENT_ANALYTICS_AI_PURPOSE);
    expect(normalizeClickHousePaymentAnalyticsAction(ai)).toBe("ai_pass_rates");

    const tab = buildPaymentAnalyticsRequest(AI_QUERY);
    expect("purpose" in tab).toBe(false);
    expect(normalizeClickHousePaymentAnalyticsAction(tab)).toBe("bundle");
  });

  it("a (possibly reduced) AI bundle never shares the Payment Pass tab's cache entry", () => {
    const parts = { userScopeHash: "p-1", warehouseVersion: "whv_1" };
    const ai = paymentAnalyticsBundleKey({ ...parts, request: { ...AI_QUERY, purpose: "ai_pass_rates" } });
    const tab = paymentAnalyticsBundleKey({ ...parts, request: AI_QUERY });
    expect(JSON.stringify(ai)).not.toBe(JSON.stringify(tab));
    // Existing keys keep their exact shape (no purpose field at all).
    expect("purpose" in normalizePaymentRequest(AI_QUERY)).toBe(false);
  });
});

// ---- Support list gated on support.messages.view -----------------------------------

const SUPPORT_QUERY: SupportQuery = {
  filters: {} as SupportQuery["filters"],
  page: 1,
  pageSize: 50,
  sortBy: "received_at",
  sortDir: "desc",
} as SupportQuery;

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useSupportData listEnabled (clickhouse-support list needs support.messages.view)", () => {
  beforeEach(() => {
    support.loadSupportBundle.mockReset().mockResolvedValue({ summary: null });
    support.loadSupportPage.mockReset().mockResolvedValue({ rows: [], total: 0 });
  });

  it("listEnabled false: only the bundle is requested and drives the loading flags", async () => {
    const { result } = renderHook(
      () => useSupportData({ query: SUPPORT_QUERY, userScopeHash: "p-1", warehouseVersion: "whv_1", enabled: true, listEnabled: false }),
      { wrapper: queryWrapper() },
    );
    await waitFor(() => expect(result.current.bundle).not.toBeNull());
    expect(support.loadSupportBundle).toHaveBeenCalledTimes(1);
    expect(support.loadSupportPage).not.toHaveBeenCalled();
    expect(result.current.isInitialLoading).toBe(false);
    expect(result.current.page).toBeNull();
  });

  it("default (owner, messages viewer): bundle and list both load, as before", async () => {
    const { result } = renderHook(
      () => useSupportData({ query: SUPPORT_QUERY, userScopeHash: "p-1", warehouseVersion: "whv_1", enabled: true }),
      { wrapper: queryWrapper() },
    );
    await waitFor(() => expect(result.current.page).not.toBeNull());
    expect(support.loadSupportBundle).toHaveBeenCalledTimes(1);
    expect(support.loadSupportPage).toHaveBeenCalledTimes(1);
  });
});

// ---- AI transports: gate refusals are a calm "unavailable" --------------------------

describe("AI transports read the gate's typed refusal", () => {
  beforeEach(() => sb.invoke.mockReset());

  it("readEdgeInvokeRefusal / isUnavailableRefusal", async () => {
    expect(await readEdgeInvokeRefusal(new Error("network"))).toBeNull();
    const denied = await readEdgeInvokeRefusal(refusal(403, { ok: false, error_code: "permission_denied", error: "Forbidden." }));
    expect(denied).toEqual({ status: 403, errorCode: "permission_denied", message: "Forbidden." });
    expect(isUnavailableRefusal(denied)).toBe(true);
    expect(isUnavailableRefusal(await readEdgeInvokeRefusal(refusal(503, { error_code: "access_service_error" })))).toBe(false);
    expect(isUnavailableRefusal(await readEdgeInvokeRefusal(refusal(500, { error: "boom" })))).toBe(false);
  });

  it("ai-analytics: 403 permission_denied → unavailable; a transport failure stays an error", async () => {
    const input = { question: "why?", contextPack: { items: [] } } as unknown as AssistantInput;
    sb.invoke.mockResolvedValueOnce({ data: null, error: refusal(403, { ok: false, error_code: "permission_denied", error: "Forbidden." }) });
    expect((await askAssistant(input)).kind).toBe("unavailable");
    sb.invoke.mockResolvedValueOnce({ data: null, error: new Error("Failed to send a request to the Edge Function") });
    expect(await askAssistant(input)).toEqual({ kind: "error", message: "Failed to send a request to the Edge Function" });
  });

  it("reports-generate: 403 scope_not_supported → unavailable; 404 report_not_found → error with the server text", async () => {
    const options = { input: {} as NarrativeInput, reportId: "11111111-1111-4111-8111-111111111111" };
    sb.invoke.mockResolvedValueOnce({ data: null, error: refusal(403, { ok: false, error_code: "scope_not_supported", error: "x" }) });
    expect((await generateNarrative(options)).kind).toBe("unavailable");
    sb.invoke.mockResolvedValueOnce({ data: null, error: refusal(404, { ok: false, error_code: "report_not_found", error: "Report not found." }) });
    expect(await generateNarrative(options)).toEqual({ kind: "error", message: "Report not found." });
  });
});

// ---- Cohorts local view copy: owner stamp + per-principal filters slot -------------

const DEFAULTS: CohortsUiSettingsDefaults = {
  defaultColumnOrder: ["a", "b"],
  defaultColumnWidths: { a: 100, b: 100 },
  defaultColumnVisibility: { a: true, b: true },
  defaultFilters: { funnel: "all" },
};

describe("Cohorts local view copy belongs to the signed-in user", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("another account's copy reads as null; the owner's own copy round-trips", () => {
    const payload = buildCohortsUiSettingsPayload(
      { columnOrder: ["b", "a"], columnWidths: { a: 120, b: 90 }, columnVisibility: { a: true, b: false }, selectedView: null, savedViews: [], filters: { funnel: "soulmate" } },
      DEFAULTS,
    );
    saveCohortsUiSettingsLocal(payload, { owner: "user-a", filtersKey: `${COHORTS_UI_STATE_STORAGE_KEY}@a` });
    expect(localStorage.getItem(COHORTS_UI_SETTINGS_OWNER_KEY)).toBeTruthy();
    expect(localStorage.getItem(COHORTS_UI_STATE_STORAGE_KEY)).toBeNull();

    expect(loadCohortsUiSettingsLocal(DEFAULTS, { owner: "user-b", filtersKey: `${COHORTS_UI_STATE_STORAGE_KEY}@b` })).toBeNull();
    const own = loadCohortsUiSettingsLocal(DEFAULTS, { owner: "user-a", filtersKey: `${COHORTS_UI_STATE_STORAGE_KEY}@a` });
    expect(own?.columnOrder).toEqual(["b", "a"]);
    expect(own?.filters.funnel).toBe("soulmate");
  });

  it("an unstamped (pre-access-control) copy is not adopted by a signed-in user", () => {
    const payload = buildCohortsUiSettingsPayload(
      { columnOrder: ["a", "b"], columnWidths: {}, columnVisibility: {}, selectedView: null, savedViews: [], filters: {} },
      DEFAULTS,
    );
    saveCohortsUiSettingsLocal(payload);
    expect(loadCohortsUiSettingsLocal(DEFAULTS)).not.toBeNull(); // unscoped callers: unchanged
    expect(loadCohortsUiSettingsLocal(DEFAULTS, { owner: "user-a" })).toBeNull();
  });

  it("the data owner (adoptUnstamped) adopts an unstamped copy as theirs — filters from the bare slot — and stamps it", () => {
    const payload = buildCohortsUiSettingsPayload(
      { columnOrder: ["b", "a"], columnWidths: {}, columnVisibility: {}, selectedView: null, savedViews: [], filters: { funnel: "palm" } },
      DEFAULTS,
    );
    saveCohortsUiSettingsLocal(payload); // pre-access-control write: no stamp, bare filters key
    const scope = { owner: "user-o", filtersKey: `${COHORTS_UI_STATE_STORAGE_KEY}@o`, adoptUnstamped: true };
    const adopted = loadCohortsUiSettingsLocal(DEFAULTS, scope);
    expect(adopted?.columnOrder).toEqual(["b", "a"]);
    expect(adopted?.filters.funnel).toBe("palm");
    expect(localStorage.getItem(COHORTS_UI_SETTINGS_OWNER_KEY)).toBeTruthy();
    // Stamped now: nobody else reads it, even if they could adopt unstamped copies.
    expect(loadCohortsUiSettingsLocal(DEFAULTS, { owner: "user-x", adoptUnstamped: true })).toBeNull();
    expect(loadCohortsUiSettingsLocal(DEFAULTS, scope)?.columnOrder).toEqual(["b", "a"]);
  });

  it("a copy stamped for another account is never adopted", () => {
    const payload = buildCohortsUiSettingsPayload(
      { columnOrder: ["a", "b"], columnWidths: {}, columnVisibility: {}, selectedView: null, savedViews: [], filters: {} },
      DEFAULTS,
    );
    saveCohortsUiSettingsLocal(payload, { owner: "user-a" });
    expect(loadCohortsUiSettingsLocal(DEFAULTS, { owner: "user-o", adoptUnstamped: true })).toBeNull();
    const source = readFileSync(resolve(process.cwd(), "src/pages/Cohorts.tsx"), "utf8");
    expect(source).toContain("adoptUnstamped: access.rawAccess");
  });
});

// ---- Auto-sync after import: the server's backfill lease ---------------------------

describe("autoSyncClickHouseAfterImport and the clickhouse-backfill run lease", () => {
  beforeEach(() => {
    sb.invoke.mockReset();
    resetClickHouseClientState();
  });

  it("a held lease (stopped_reason already_running) is reported as already_running_server", async () => {
    sb.invoke.mockImplementation(async (fn: string) => {
      if (fn === "clickhouse-summary") return { data: { sync_state: { status: "idle" } }, error: null };
      if (fn === "clickhouse-backfill") {
        return { data: { status: "running", stopped_reason: "already_running", batches_processed: 0, rows_inserted: 0, rows_scanned: 0 }, error: null };
      }
      throw new Error(`unexpected ${fn}`);
    });
    const result = await autoSyncClickHouseAfterImport();
    expect(result).toMatchObject({ triggered: false, skipped: true, skipReason: "already_running_server" });
    expect(sb.invoke.mock.calls.filter(([fn]) => fn === "clickhouse-backfill")).toHaveLength(1);
    expect(sb.invoke.mock.calls.some(([fn]) => fn === "clickhouse-cohort-membership")).toBe(false);
  });
});
