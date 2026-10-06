// fe-caches (plan §14 "Typed errors", §20 "Cache isolation", §27 R12):
//  A. SHARED CONTRACT B — ClickHouseRequestError / isAccessError and the 45 s
//     warehouse breaker (only transport failures and 502/504 open it);
//  B. transientRetry never retries 4xx or access-layer codes;
//  C. every React Query key carries the access partition (hooks resolve it);
//  D. sessionStorage persistence per partition, never PII bundles;
//  E. the purge registry handlers of every cache owner;
//  F. IndexedDB datasets: raw access only, partition-stamped;
//  G. usePersistedPageState keys are principal-suffixed;
//  H. SavedDataAutoLoader runs per partition and only with raw access;
//  I. the page hooks type a funnel-restricted 409 / 403 and poll only the 409.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const sb = vi.hoisted(() => {
  const inserted: unknown[] = [];
  const builder = () => {
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "limit"]) chain[method] = () => chain;
    chain.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
    return chain;
  };
  return {
    inserted,
    invoke: vi.fn(),
    client: {
      functions: { invoke: (...args: unknown[]) => sb.invoke(...args) },
      auth: {
        getSession: async () => ({ data: { session: { access_token: "token", user: { id: "user-a" } } }, error: null }),
        getUser: async () => ({ data: { user: { id: "user-a" } }, error: null }),
      },
      from: () => ({
        ...builder(),
        insert: async (row: unknown) => {
          inserted.push(row);
          return { error: null };
        },
      }),
    },
  };
});

vi.mock("@/services/supabaseClient", () => ({ supabase: sb.client, isSupabaseConfigured: true }));

const loader = vi.hoisted(() => ({
  autoLoadWarehouseIntoStore: vi.fn(async () => ({ status: "empty" as const, message: "No warehouse data found" })),
  loadLatestCloudSnapshot: vi.fn(async () => null),
  loadFunnelFoxSubscriptions: vi.fn(async () => []),
}));
vi.mock("@/services/analyticsAdapters", () => ({ autoLoadWarehouseIntoStore: loader.autoLoadWarehouseIntoStore }));
vi.mock("@/services/dataSnapshots", () => ({ loadLatestCloudSnapshot: loader.loadLatestCloudSnapshot }));
vi.mock("@/services/funnelfoxSubscriptionsSync", () => ({ loadFunnelFoxSubscriptions: loader.loadFunnelFoxSubscriptions }));

import {
  ClickHouseRequestError,
  getClickHouseSummary,
  isAccessError,
  isAccessServiceError,
  isClickHouseCircuitOpen,
  noteClickHouseReachable,
  runClickHouseCohorts,
  shouldOpenClickHouseCircuit,
} from "@/services/clickhouse";
import { transientRetry, useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { prefetchCohortsNav, useCohortsListQuery } from "@/hooks/useCohortsCache";
import { useRevenueBundle } from "@/hooks/useRevenueIntelligence";
import { useFbReportQuery } from "@/hooks/useFbWarehouse";
import type { RevenueIntelligenceRequest } from "@/services/revenueIntelligence";
import type { FbReportQuery } from "@/services/fbWarehouse";
import { useUsersData } from "@/hooks/useUsersCache";
import { AccessContext, buildAccessValue, type AccessContextValue } from "@/contexts/accessContext";
import type { MyAccess } from "@/services/accessClient";
import { AuthContext, type AuthContextValue } from "@/contexts/authContext";
import {
  ANALYTICS_CACHE_SCHEMA_VERSION,
  fnv,
  getActiveCacheAccess,
  setActiveCacheAccess,
  WAREHOUSE_VERSION_KEY,
} from "@/services/analyticsCache";
import {
  analyticsPersistKey,
  persistAnalyticsCache,
  restoreAnalyticsCache,
  shouldPersistAnalyticsQuery,
  startAnalyticsCachePersistence,
} from "@/services/analyticsCachePersistence";
import { cohortsListKey } from "@/services/cohortsCache";
import { registeredPurgeHandlers, runPurge } from "@/services/sessionPurge";
import { useDataStore } from "@/store/dataStore";
import { useAiAssistantStore } from "@/store/aiAssistantStore";
import { MOCK_TRANSACTIONS } from "@/services/mockTransactions";
import { AI_SCOPE_ALL, aiAccessScopeKey, computeAiContextHash, maybeWriteAiRecommendations, stableJson } from "@/services/aiRecommendationLog";
import { ensureCohortSnapshotRebuild, resetCohortSnapshotAutoRebuild, type CohortSnapshotHealth } from "@/services/cohortSnapshotHealth";
import { loadLastPalmerDatasetFromCache, PALMER_CACHE_DB_NAME, savePalmerDatasetToCache } from "@/services/palmerCache";
import { loadSubscriptionsFromCache, saveSubscriptionsToCache, SUBSCRIPTION_CACHE_DB_NAME } from "@/services/subscriptionCache";
import { loadLastTrafficDataFromCache, saveTrafficDataToCache, TRAFFIC_CACHE_DB_NAME } from "@/services/trafficCache";
import { WAREHOUSE_TRANSACTIONS_CACHE_DB_NAME } from "@/services/transactionWarehouse";
import { principalPageStateKey, usePersistedPageState } from "@/hooks/usePersistedPageState";
import { AnalyticsCacheGate } from "@/components/AnalyticsCacheGate";
import { SavedDataAutoLoader } from "@/components/SavedDataAutoLoader";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";
import type { UsersQuery } from "@/services/usersDataSource";

// ---- fixtures ---------------------------------------------------------------------------

function okRow(overrides: Partial<MyAccess> = {}): MyAccess {
  return {
    status: "ok",
    workspace_id: "ws-1",
    member_id: "member-b",
    user_id: "user-b",
    email: "b@example.test",
    display_name: "B",
    is_data_owner: false,
    raw_access: false,
    role: { id: "role-1", key: "viewer", name: "Viewer", is_owner: false, permissions: ["cohorts.view", "users.view", "users.pii.view"] },
    funnel_scope: { mode: "all", funnel_ids: [], paths: [] },
    access_version: "1",
    partition: "p-member",
    ...overrides,
  };
}

const memberAccess = (partition = "p-member"): AccessContextValue =>
  buildAccessValue({ status: "ok", access: okRow({ partition }), userId: "user-b" });
const legacyAccess = (userId = "user-a"): AccessContextValue => buildAccessValue({ status: "legacy", access: null, userId });
const loadingAccess = (): AccessContextValue => buildAccessValue({ status: "loading", access: null, userId: "user-b" });

function edgeHttpError(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    data: null,
    error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
      name: "FunctionsHttpError",
      context: new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers }),
    }),
  };
}

const cohortsRequest: CohortRequest = {
  action: "list", date_from: null, date_to: null,
  filters: { funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
  max_renewal_depth: 6,
};

// ---- a minimal in-memory IndexedDB (async callbacks, like the real one) -------------------

type Stores = Map<string, Map<string, unknown>>;
const idb = vi.hoisted(() => ({ databases: new Map<string, Map<string, Map<string, unknown>>>(), opens: 0, deletes: [] as string[] }));

class FakeRequest {
  result: unknown = undefined;
  error: unknown = null;
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  onblocked: (() => void) | null = null;
}

const clone = <T,>(value: T): T => (value === undefined ? value : JSON.parse(JSON.stringify(value)));

function fakeStore(map: Map<string, unknown>, tx: { oncomplete: (() => void) | null }) {
  const op = (fn: () => unknown) => {
    const request = new FakeRequest();
    setTimeout(() => {
      request.result = fn();
      request.onsuccess?.();
      tx.oncomplete?.();
    }, 0);
    return request;
  };
  return {
    get: (key: string) => op(() => clone(map.get(key))),
    put: (value: unknown, key: string) => op(() => { map.set(key, clone(value)); return key; }),
    delete: (key: string) => op(() => { map.delete(key); return undefined; }),
  };
}

function fakeDb(stores: Stores) {
  return {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string) => { stores.set(name, new Map()); },
    transaction: (name: string) => {
      const tx = { oncomplete: null as (() => void) | null, onerror: null, onabort: null, error: null, objectStore: () => fakeStore(stores.get(name)!, tx) };
      return tx;
    },
    close: () => {},
  };
}

const fakeIndexedDb = {
  open(name: string) {
    idb.opens += 1;
    const request = new FakeRequest();
    setTimeout(() => {
      let stores = idb.databases.get(name);
      const created = !stores;
      if (!stores) {
        stores = new Map();
        idb.databases.set(name, stores);
      }
      request.result = fakeDb(stores);
      if (created) request.onupgradeneeded?.();
      request.onsuccess?.();
    }, 0);
    return request;
  },
  deleteDatabase(name: string) {
    idb.deletes.push(name);
    const request = new FakeRequest();
    setTimeout(() => {
      idb.databases.delete(name);
      request.onsuccess?.();
    }, 0);
    return request;
  },
};

function storedEntry(dbName: string): unknown {
  const stores = idb.databases.get(dbName);
  if (!stores) return undefined;
  for (const store of stores.values()) return store.get("latest");
  return undefined;
}

// ---- lifecycle ----------------------------------------------------------------------------

beforeEach(() => {
  sb.invoke.mockReset();
  sb.inserted.length = 0;
  noteClickHouseReachable();
  sessionStorage.clear();
  localStorage.clear();
  setActiveCacheAccess(null);
  idb.databases.clear();
  idb.opens = 0;
  idb.deletes.length = 0;
  vi.stubGlobal("indexedDB", fakeIndexedDb);
  loader.autoLoadWarehouseIntoStore.mockClear();
  loader.loadLatestCloudSnapshot.mockClear();
  loader.loadFunnelFoxSubscriptions.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setActiveCacheAccess(null);
});

// =========================================================================================
// A. typed Edge errors + breaker
// =========================================================================================

describe("A. ClickHouseRequestError / isAccessError (SHARED CONTRACT B)", () => {
  it("a 403 denial is typed, keeps today's message text and never opens the breaker", async () => {
    sb.invoke.mockResolvedValueOnce(edgeHttpError(403, { ok: false, error_code: "scope_not_supported", error: "This action is not yet enabled for funnel-restricted access.", request_id: "req-body" }));
    const error = await runClickHouseCohorts(cohortsRequest).catch((caught) => caught);
    expect(error).toBeInstanceOf(ClickHouseRequestError);
    expect(error.message).toBe("ClickHouse Edge Function failed: This action is not yet enabled for funnel-restricted access.");
    expect(error).toMatchObject({ status: 403, errorCode: "scope_not_supported", requestId: "req-body" });
    expect(isAccessError(error)).toBe(true);
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("401 / 404 / 409 access codes are access errors; the request id falls back to the header", async () => {
    for (const [status, code] of [[401, "invalid_session"], [404, "not_found"], [409, "scope_snapshot_not_ready"]] as const) {
      sb.invoke.mockResolvedValueOnce(edgeHttpError(status, { ok: false, error_code: code, error: "Request refused." }, { "x-request-id": `hdr-${status}` }));
      const error = await runClickHouseCohorts(cohortsRequest).catch((caught) => caught);
      expect(isAccessError(error), code).toBe(true);
      expect(error.requestId).toBe(`hdr-${status}`);
      expect(isClickHouseCircuitOpen(), code).toBe(false);
    }
  });

  it("a 503 from the access layer never opens the breaker, even with a down-shaped message", async () => {
    sb.invoke.mockResolvedValueOnce(edgeHttpError(503, { ok: false, error_code: "access_service_error", error: "service unavailable (connection reset)" }));
    const error = await runClickHouseCohorts(cohortsRequest).catch((caught) => caught);
    expect(isAccessError(error)).toBe(false);
    expect(isAccessServiceError(error)).toBe(true);
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("a 403 whose prose looks transport-shaped still never opens the breaker", async () => {
    sb.invoke.mockResolvedValueOnce(edgeHttpError(403, { ok: false, error_code: "permission_denied", error: "connection refused for this account" }));
    await runClickHouseCohorts(cohortsRequest).catch(() => undefined);
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("502 / 504 with a warehouse-down message open the breaker; the error is typed but not an access error", async () => {
    sb.invoke.mockResolvedValueOnce(edgeHttpError(502, { ok: false, source: "clickhouse", error: "connection reset by peer" }));
    const error = await runClickHouseCohorts(cohortsRequest).catch((caught) => caught);
    expect(error).toBeInstanceOf(ClickHouseRequestError);
    expect(error.status).toBe(502);
    expect(isAccessError(error)).toBe(false);
    expect(isClickHouseCircuitOpen()).toBe(true);

    noteClickHouseReachable();
    sb.invoke.mockResolvedValueOnce(edgeHttpError(504, "upstream request timeout"));
    await runClickHouseCohorts(cohortsRequest).catch(() => undefined);
    expect(isClickHouseCircuitOpen()).toBe(true);
  });

  it("a sanitized employee 502 (upstream_error) and a 500 never open it", async () => {
    sb.invoke.mockResolvedValueOnce(edgeHttpError(502, { ok: false, error_code: "upstream_error", error: "Request failed.", request_id: "r" }));
    await runClickHouseCohorts(cohortsRequest).catch(() => undefined);
    expect(isClickHouseCircuitOpen()).toBe(false);
    sb.invoke.mockResolvedValueOnce(edgeHttpError(500, { error: "connection refused" }));
    await runClickHouseCohorts(cohortsRequest).catch(() => undefined);
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("a failure without any HTTP response stays a plain Error and opens on a transport message", async () => {
    sb.invoke.mockResolvedValueOnce({ data: null, error: new Error("Failed to fetch") });
    const error = await runClickHouseCohorts(cohortsRequest).catch((caught) => caught);
    expect(error).not.toBeInstanceOf(ClickHouseRequestError);
    expect(error.message).toBe("ClickHouse Edge Function failed: Failed to fetch");
    expect(isClickHouseCircuitOpen()).toBe(true);
  });

  it("an embedded 200 {ok:false} with an access code does not open the breaker", async () => {
    sb.invoke.mockResolvedValueOnce({ data: { ok: false, error_code: "scope_not_supported", error: "unavailable for restricted scope" }, error: null });
    await runClickHouseCohorts(cohortsRequest);
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("shouldOpenClickHouseCircuit: the status/code matrix", () => {
    const down = "connection reset by peer";
    expect(shouldOpenClickHouseCircuit({ status: null, message: down })).toBe(true);
    expect(shouldOpenClickHouseCircuit({ status: 502, message: down })).toBe(true);
    expect(shouldOpenClickHouseCircuit({ status: 504, message: down })).toBe(true);
    for (const status of [400, 401, 403, 404, 409, 500, 503]) {
      expect(shouldOpenClickHouseCircuit({ status, message: down }), String(status)).toBe(false);
    }
    expect(shouldOpenClickHouseCircuit({ status: 502, errorCode: "auth_service_error", message: down })).toBe(false);
    expect(shouldOpenClickHouseCircuit({ status: 502, message: "Unknown column fb_spend" })).toBe(false);
  });
});

// =========================================================================================
// B. retries
// =========================================================================================

describe("B. transientRetry", () => {
  const typed = (status: number, errorCode: string | null) =>
    new ClickHouseRequestError("ClickHouse Edge Function failed: x", { status, errorCode });

  it("never retries a 4xx or an access-layer code", () => {
    for (const status of [400, 401, 403, 404, 409, 422]) expect(transientRetry(0, typed(status, null)), String(status)).toBe(false);
    for (const code of ["auth_service_error", "access_service_error", "workspace_not_bootstrapped", "server_not_configured"]) {
      expect(transientRetry(0, typed(503, code)), code).toBe(false);
    }
  });

  it("still retries a warehouse 502 twice, and keeps the message rules", () => {
    expect(transientRetry(0, typed(502, "upstream_error"))).toBe(true);
    expect(transientRetry(2, typed(502, null))).toBe(false);
    expect(transientRetry(0, new Error("ClickHouse warehouse is unavailable right now"))).toBe(false);
    expect(transientRetry(0, new Error("fetch failed"))).toBe(true);
  });
});

// =========================================================================================
// C. partition in every key
// =========================================================================================

function hookWrapper(client: QueryClient, access: AccessContextValue | null) {
  return ({ children }: { children: ReactNode }) =>
    createElement(
      QueryClientProvider,
      { client },
      access ? createElement(AccessContext.Provider, { value: access }, children) : children,
    );
}

describe("C. query keys carry the access partition", () => {
  it("the cohorts list key uses the access partition, whatever scope the page passed", () => {
    const client = new QueryClient();
    renderHook(
      () => useCohortsListQuery({ request: cohortsRequest, dataSource: "clickhouse", userScopeHash: "u_oldfnv", warehouseVersion: "whv_x", enabled: false }),
      { wrapper: hookWrapper(client, memberAccess("p-member")) },
    );
    const keys = client.getQueryCache().findAll({ queryKey: ["cohorts"] }).map((query) => query.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0][2]).toBe("p-member");
  });

  it("users keys switch with the partition (no entry shared across principals or scopes)", () => {
    const client = new QueryClient();
    const query = { search: "", sortField: "first_trial_date", sortDir: "desc", page: 1, pageSize: 50 } as unknown as UsersQuery;
    const mount = (partition: string) => renderHook(
      () => useUsersData({ query, userScopeHash: "u_same_user", warehouseVersion: "whv_x", enabled: false }),
      { wrapper: hookWrapper(client, memberAccess(partition)) },
    );
    mount("p-one");
    mount("p-two");
    const scopes = new Set(client.getQueryCache().findAll({ queryKey: ["users"] }).map((entry) => entry.queryKey[2]));
    expect([...scopes].sort()).toEqual(["p-one", "p-two"]);
  });

  it("an empty partition (access unresolved / grants nothing) never fetches", async () => {
    const client = new QueryClient();
    renderHook(
      () => useCohortsListQuery({ request: cohortsRequest, dataSource: "clickhouse", userScopeHash: "u_x", warehouseVersion: "whv_x", enabled: true }),
      { wrapper: hookWrapper(client, loadingAccess()) },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sb.invoke).not.toHaveBeenCalled();
  });

  it("the warehouse-version key is partitioned; the nav prefetch is a no-op without a partition", async () => {
    const client = new QueryClient();
    renderHook(() => useWarehouseVersion(false), { wrapper: hookWrapper(client, legacyAccess("user-a")) });
    expect(client.getQueryCache().findAll({ queryKey: [...WAREHOUSE_VERSION_KEY] }).map((entry) => entry.queryKey))
      .toEqual([[...WAREHOUSE_VERSION_KEY, "legacy:user-a"]]);

    prefetchCohortsNav(client, "", 6);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sb.invoke).not.toHaveBeenCalled();
  });

  it("outside an AccessProvider the caller's scope is kept (unit-test / legacy wiring)", () => {
    const client = new QueryClient();
    renderHook(
      () => useCohortsListQuery({ request: cohortsRequest, dataSource: "clickhouse", userScopeHash: "u_1", warehouseVersion: "whv_x", enabled: false }),
      { wrapper: hookWrapper(client, null) },
    );
    expect(client.getQueryCache().findAll({ queryKey: ["cohorts"] })[0].queryKey[2]).toBe("u_1");
  });

  it("the AI context hash keys on the funnel scope, not the partition (scope all = the pre-access hash)", () => {
    const parts = { surface: "cohort" as const, dateFrom: null, dateTo: null, contextKey: "k" };
    // The exact hash written before access control (no scope component), so the
    // data owner's ai_recommendations history stays reachable after the deploy.
    const legacyHash = `c_${fnv(stableJson(["cohort", "", "", "k"]))}`;
    expect(computeAiContextHash(parts)).toBe(legacyHash);
    expect(computeAiContextHash({ ...parts, accessScope: AI_SCOPE_ALL })).toBe(legacyHash);
    // A partition change (role edit, legacy → ok) does not move it.
    setActiveCacheAccess({ partition: "p-a", rawAccess: false });
    expect(computeAiContextHash(parts)).toBe(legacyHash);
    // Restricted scopes are other contexts, and differ from each other.
    const scopeA = aiAccessScopeKey({ access: { funnel_scope: { mode: "selected", funnel_ids: ["f-b", "F-A"] } } });
    const scopeB = aiAccessScopeKey({ access: { funnel_scope: { mode: "selected", funnel_ids: ["f-c"] } } });
    expect(scopeA).toBe(aiAccessScopeKey({ access: { funnel_scope: { mode: "selected", funnel_ids: ["f-a", "f-b"] } } }));
    expect(computeAiContextHash({ ...parts, accessScope: scopeA })).not.toBe(legacyHash);
    expect(computeAiContextHash({ ...parts, accessScope: scopeA })).not.toBe(computeAiContextHash({ ...parts, accessScope: scopeB }));
    expect(aiAccessScopeKey({ access: { funnel_scope: { mode: "none", funnel_ids: [] } } })).toBe("none");
    expect(aiAccessScopeKey({ legacy: true, access: null })).toBe(AI_SCOPE_ALL);
    expect(aiAccessScopeKey(null)).toBe(AI_SCOPE_ALL);
    expect(aiAccessScopeKey({ access: { funnel_scope: { mode: "all", funnel_ids: [] } } })).toBe(AI_SCOPE_ALL);
  });
});

// =========================================================================================
// D. persisted query cache
// =========================================================================================

describe("D. sessionStorage persistence", () => {
  const cohortsKey = (partition: string) => cohortsListKey({ userScopeHash: partition, dataSource: "clickhouse", warehouseVersion: "whv_x", request: cohortsRequest });

  it("stores one envelope per partition under analytics.qcache.v3:<partition> (schema bumped)", () => {
    const client = new QueryClient();
    client.setQueryData(cohortsKey("p-a"), { cohorts: [] });
    persistAnalyticsCache(client, "p-a");
    const raw = JSON.parse(sessionStorage.getItem(analyticsPersistKey("p-a")) ?? "null");
    expect(analyticsPersistKey("p-a")).toBe("analytics.qcache.v3:p-a");
    expect(raw).toMatchObject({ schemaVersion: ANALYTICS_CACHE_SCHEMA_VERSION, partition: "p-a" });
    expect(ANALYTICS_CACHE_SCHEMA_VERSION).toBeGreaterThanOrEqual(16);

    // Another partition never restores it, and the foreign envelope is dropped.
    expect(restoreAnalyticsCache(new QueryClient(), "p-b")).toBe(false);
    expect(sessionStorage.getItem(analyticsPersistKey("p-a"))).toBeNull();
    // An empty partition never touches storage.
    persistAnalyticsCache(client, "");
    expect(sessionStorage.length).toBe(0);
  });

  it("never persists Users rows, Support messages or search-keyed entries", () => {
    const ok = (queryKey: unknown[]) => shouldPersistAnalyticsQuery({ queryKey, state: { status: "success", data: {} } } as never);
    expect(ok(["users", "list", "p", "whv", {}])).toBe(false);
    expect(ok(["users", "details", "p", "u1"])).toBe(false);
    expect(ok(["users", "summary", "p", "whv", { search: "" }])).toBe(true);
    expect(ok(["users", "summary", "p", "whv", { search: "someone@example.test" }])).toBe(false);
    expect(ok(["support", "list", "p", "whv", {}])).toBe(false);
    expect(ok(["support", "details", "p", "whv", "req-1"])).toBe(false);
    expect(ok(["support", "answered-reply", "req-1"])).toBe(false);
    expect(ok(["support", "bundle", "p", "whv", { search: "" }])).toBe(true);
    expect(ok(["cohorts", "list", "p", "clickhouse", "whv", "fbwhv", {}])).toBe(true);
  });

  it("restore re-applies the filter to an envelope written by a looser build", () => {
    sessionStorage.setItem(analyticsPersistKey("p-a"), JSON.stringify({
      schemaVersion: ANALYTICS_CACHE_SCHEMA_VERSION,
      partition: "p-a",
      savedAt: Date.now(),
      state: {
        mutations: [],
        queries: [
          { queryKey: ["users", "list", "p-a"], queryHash: "[\"users\",\"list\",\"p-a\"]", state: { status: "success", data: { rows: ["x@example.test"] }, dataUpdatedAt: 1 } },
          { queryKey: ["cohorts", "list", "p-a"], queryHash: "[\"cohorts\",\"list\",\"p-a\"]", state: { status: "success", data: { cohorts: [] }, dataUpdatedAt: 1 } },
        ],
      },
    }));
    const client = new QueryClient();
    expect(restoreAnalyticsCache(client, "p-a")).toBe(true);
    expect(client.getQueryData(["users", "list", "p-a"])).toBeUndefined();
    expect(client.getQueryData(["cohorts", "list", "p-a"])).toEqual({ cohorts: [] });
  });

  it("the purge drops every analytics.* key and a write that was already scheduled", async () => {
    const client = new QueryClient();
    const stop = startAnalyticsCachePersistence(client, () => "p-a", 40);
    client.setQueryData(cohortsKey("p-a"), { cohorts: [] }); // schedules a throttled write
    sessionStorage.setItem("analytics.qcache.v1", "{}");
    sessionStorage.setItem("analytics.other", "x");
    sessionStorage.setItem("unrelated", "keep");
    await runPurge("signed_out");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sessionStorage.getItem(analyticsPersistKey("p-a"))).toBeNull();
    expect(sessionStorage.getItem("analytics.qcache.v1")).toBeNull();
    expect(sessionStorage.getItem("analytics.other")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");

    // Later changes persist again under the live partition.
    client.setQueryData(cohortsKey("p-a"), { cohorts: [{ cohort_id: "after" }] });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sessionStorage.getItem(analyticsPersistKey("p-a"))).not.toBeNull();
    stop();
  });
});

// =========================================================================================
// E. purge handlers
// =========================================================================================

describe("E. session purge registry", () => {
  it("every cache owner registered a handler", () => {
    expect(registeredPurgeHandlers()).toEqual(expect.arrayContaining([
      "clickhouse-client-memos",
      "analytics-session-cache",
      "data-store",
      "ai-assistant-store",
      "ai-recommendation-log",
      "cohort-snapshot-auto-rebuild",
      "palmer-indexeddb",
      "subscriptions-indexeddb",
      "traffic-indexeddb",
      "warehouse-indexeddb",
      "page-ui-state",
    ]));
  });

  it("resets the summary memo and the breaker; an in-flight summary of the previous principal is not memoized", async () => {
    let release: (value: unknown) => void = () => {};
    sb.invoke.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const first = getClickHouseSummary();
    await Promise.resolve();
    await runPurge("principal_changed");
    release({ data: { connected: true, transaction_count: 1 }, error: null });
    await first;

    sb.invoke.mockResolvedValueOnce({ data: { connected: true, transaction_count: 2 }, error: null });
    expect((await getClickHouseSummary()).transaction_count).toBe(2);
    expect(sb.invoke).toHaveBeenCalledTimes(2);

    sb.invoke.mockResolvedValueOnce({ data: null, error: new Error("connection reset by peer") });
    await runClickHouseCohorts(cohortsRequest).catch(() => undefined);
    expect(isClickHouseCircuitOpen()).toBe(true);
    await runPurge("signed_out");
    expect(isClickHouseCircuitOpen()).toBe(false);
  });

  it("resets the zustand stores", async () => {
    useDataStore.getState().setSubscriptions([{ id: "s1" } as never]);
    useDataStore.getState().setImported([], { source: "palmer_raw", importMode: "palmer_raw" });
    useAiAssistantStore.setState({ open: true, context: { surface: "x", label: "x", contextPack: {} as never } });
    await runPurge("access_changed");
    const state = useDataStore.getState();
    expect(state.subscriptions).toEqual([]);
    expect(state.transactions).toBe(MOCK_TRANSACTIONS);
    expect(state.meta.source).toBe("mock");
    expect(useAiAssistantStore.getState()).toMatchObject({ open: false, context: null });
    expect(localStorage.getItem("subs-analytics-data")).toBeNull();
  });

  it("forgets the snapshot auto-rebuild bookkeeping", async () => {
    resetCohortSnapshotAutoRebuild();
    const health = { status: "stale", snapshotWarehouseVersion: "a", currentWarehouseVersion: "b", snapshotSourceTransactions: 1, warehouseTransactions: 2 } as CohortSnapshotHealth;
    const rebuild = vi.fn(async () => ({ ok: true, action: "rebuild" as const, status: "completed" }));
    expect(ensureCohortSnapshotRebuild(health, rebuild)).toBe("started");
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ensureCohortSnapshotRebuild(health, rebuild)).toBe("skipped");
    await runPurge("principal_changed");
    expect(ensureCohortSnapshotRebuild(health, rebuild)).toBe("started");
  });

  it("a recommendation snapshot queued before the purge is never written for the next principal", async () => {
    const output = { recommendations: [{ surface: "cohort", action: "SCALE", scope: { kind: "path", campaignPath: "a" } }], engineVersion: "1", thresholds: {}, opportunities: [], inputStatus: {} } as never;
    const queued = maybeWriteAiRecommendations({ contextHash: "c_1", warehouseVersion: null, output });
    await runPurge("signed_out");
    expect(await queued).toBe("skipped");
    expect(sb.inserted).toHaveLength(0);

    expect(await maybeWriteAiRecommendations({ contextHash: "c_1", warehouseVersion: null, output })).toBe("written");
    expect(sb.inserted).toHaveLength(1);
  });

  it("deletes every raw-dataset IndexedDB database", async () => {
    await runPurge("signed_out");
    expect(idb.deletes).toEqual(expect.arrayContaining([
      PALMER_CACHE_DB_NAME,
      SUBSCRIPTION_CACHE_DB_NAME,
      TRAFFIC_CACHE_DB_NAME,
      WAREHOUSE_TRANSACTIONS_CACHE_DB_NAME,
    ]));
  });
});

// =========================================================================================
// F. IndexedDB datasets
// =========================================================================================

describe("F. raw-dataset caches", () => {
  const meta = { file_name: "f.csv", imported_at: "2026-10-01T00:00:00Z", rows_count: 0, transactions_count: 0, cohorts_count: 0, users_count: 0, source: "palmer_import" as const };

  it("without raw access nothing is written or even opened", async () => {
    setActiveCacheAccess({ partition: "p-member", rawAccess: false });
    await savePalmerDatasetToCache({ transactions: [], users: [], cohorts: [] }, meta);
    await saveSubscriptionsToCache([], {});
    await saveTrafficDataToCache([], {});
    expect(await loadLastPalmerDatasetFromCache()).toBeNull();
    expect(await loadSubscriptionsFromCache()).toBeNull();
    expect(await loadLastTrafficDataFromCache()).toBeNull();
    expect(idb.opens).toBe(0);
  });

  it("entries are stamped with the partition and another partition's copy is deleted, not returned", async () => {
    setActiveCacheAccess({ partition: "p-owner-1", rawAccess: true });
    await savePalmerDatasetToCache({ transactions: [], users: [], cohorts: [] }, meta);
    expect(storedEntry(PALMER_CACHE_DB_NAME)).toMatchObject({ partition: "p-owner-1" });
    expect(await loadLastPalmerDatasetFromCache()).toMatchObject({ partition: "p-owner-1" });

    setActiveCacheAccess({ partition: "p-owner-2", rawAccess: true });
    expect(await loadLastPalmerDatasetFromCache()).toBeNull();
    expect(storedEntry(PALMER_CACHE_DB_NAME)).toBeUndefined();
  });

  it("an unstamped (pre-access-control) entry is never returned", async () => {
    idb.databases.set(SUBSCRIPTION_CACHE_DB_NAME, new Map([["funnelfox-subscriptions", new Map<string, unknown>([["latest", { subscriptions: [{ email: "x@example.test" }], metadata: {} }]])]]));
    setActiveCacheAccess({ partition: "p-owner", rawAccess: true });
    expect(await loadSubscriptionsFromCache()).toBeNull();
    expect(storedEntry(SUBSCRIPTION_CACHE_DB_NAME)).toBeUndefined();
  });

  it("a caller whose partition is no longer active neither reads nor writes", async () => {
    setActiveCacheAccess({ partition: "p-now", rawAccess: true });
    await saveTrafficDataToCache([], {}, { partition: "p-then" });
    expect(idb.opens).toBe(0);
    expect(await loadLastTrafficDataFromCache({ partition: "p-then" })).toBeNull();
    expect(idb.opens).toBe(0);
  });
});

// =========================================================================================
// G. page UI state
// =========================================================================================

function authFor(userId: string | null): AuthContextValue {
  return {
    configured: true,
    supabaseConfigured: true,
    localAuthEnabled: false,
    mode: "supabase",
    loading: false,
    session: null,
    user: userId ? { id: userId, email: `${userId}@example.test`, provider: "supabase" } : null,
    signIn: async () => {},
    signOut: async () => {},
  };
}

describe("G. usePersistedPageState", () => {
  const authWrapper = (userId: string | null) => ({ children }: { children: ReactNode }) =>
    createElement(AuthContext.Provider, { value: authFor(userId) }, children);

  it("writes under the principal-suffixed key and adopts (then removes) an unowned bare value", () => {
    localStorage.setItem("ui_state_test", JSON.stringify({ a: 2 }));
    const { result, unmount } = renderHook(() => usePersistedPageState("ui_state_test", { a: 1, b: 1 }), { wrapper: authWrapper("user-a") });
    expect(result.current[0]).toEqual({ a: 2, b: 1 });
    act(() => result.current[1]({ a: 3, b: 1 }));
    unmount();
    expect(JSON.parse(localStorage.getItem(principalPageStateKey("ui_state_test", "user-a")) ?? "null")).toEqual({ a: 3, b: 1 });
    expect(localStorage.getItem("ui_state_test")).toBeNull();
  });

  const accessWrapper = (userId: string, rawAccess: boolean) => ({ children }: { children: ReactNode }) =>
    createElement(
      AuthContext.Provider,
      { value: authFor(userId) },
      createElement(
        AccessContext.Provider,
        {
          value: buildAccessValue({
            status: "ok",
            userId,
            access: {
              status: "ok", workspace_id: "ws", member_id: "m", user_id: userId, email: null, display_name: null,
              is_data_owner: rawAccess, raw_access: rawAccess,
              role: { id: "r", key: rawAccess ? "owner" : "viewer", name: "R", is_owner: rawAccess, permissions: ["users.view"] },
              funnel_scope: { mode: "all", funnel_ids: [], paths: [] }, access_version: "1", partition: `p-${userId}`,
            },
          }),
        },
        children,
      ),
    );

  it("only the data owner adopts an unowned (pre-suffix) value; anyone else never reads it and deletes it", () => {
    localStorage.setItem("ui_state_test", JSON.stringify({ a: 2, search: "leftover@example.com" }));
    const employee = renderHook(() => usePersistedPageState("ui_state_test", { a: 1 }), { wrapper: accessWrapper("user-e", false) });
    expect(employee.result.current[0]).toEqual({ a: 1 });
    expect(localStorage.getItem("ui_state_test")).toBeNull();
    employee.unmount();

    localStorage.setItem("ui_state_test", JSON.stringify({ a: 2 }));
    const owner = renderHook(() => usePersistedPageState("ui_state_test", { a: 1 }), { wrapper: accessWrapper("user-o", true) });
    expect(owner.result.current[0]).toEqual({ a: 2 });
    owner.unmount();
    expect(localStorage.getItem("ui_state_test")).toBeNull();
    expect(JSON.parse(localStorage.getItem(principalPageStateKey("ui_state_test", "user-o")) ?? "null")).toEqual({ a: 2 });
  });

  it("another principal never starts from it", () => {
    localStorage.setItem(principalPageStateKey("ui_state_test", "user-a"), JSON.stringify({ a: 9 }));
    const { result } = renderHook(() => usePersistedPageState("ui_state_test", { a: 1 }), { wrapper: authWrapper("user-b") });
    expect(result.current[0]).toEqual({ a: 1 });
    expect(principalPageStateKey("ui_state_test", "user-a")).not.toContain("user-a");
  });

  it("sign-out / account switch purge unowned values only; an access change purges nothing", async () => {
    const owned = principalPageStateKey("ui_state_users", "user-a");
    localStorage.setItem(owned, "{}");
    localStorage.setItem("ui_state_users", "{}");
    await runPurge("access_changed");
    expect(localStorage.getItem("ui_state_users")).toBe("{}");
    await runPurge("principal_changed");
    expect(localStorage.getItem("ui_state_users")).toBeNull();
    expect(localStorage.getItem(owned)).toBe("{}");
  });
});

// =========================================================================================
// H. gate + auto-loader
// =========================================================================================

describe("H. AnalyticsCacheGate / SavedDataAutoLoader", () => {
  function renderWith(access: AccessContextValue, child: ReactNode = null) {
    const client = new QueryClient();
    const view = render(
      createElement(QueryClientProvider, { client },
        createElement(AccessContext.Provider, { value: access }, createElement(AnalyticsCacheGate, null, child))),
    );
    return { client, view };
  }

  it("publishes the resolved partition and raw-access flag for the dataset caches", () => {
    renderWith(legacyAccess("user-a"));
    expect(getActiveCacheAccess()).toEqual({ partition: "legacy:user-a", rawAccess: true });
    cleanup();
    renderWith(memberAccess("p-member"));
    expect(getActiveCacheAccess()).toEqual({ partition: "p-member", rawAccess: false });
    cleanup();
    renderWith(loadingAccess());
    expect(getActiveCacheAccess()).toEqual({ partition: "", rawAccess: false });
  });

  it("the auto-loader loads nothing without raw access", async () => {
    renderWith(memberAccess("p-member"), createElement(SavedDataAutoLoader, { loadTransactions: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loader.autoLoadWarehouseIntoStore).not.toHaveBeenCalled();
    expect(loader.loadFunnelFoxSubscriptions).not.toHaveBeenCalled();
  });

  it("runs once per partition for the data owner and again for a new partition", async () => {
    const client = new QueryClient();
    const tree = (access: AccessContextValue) =>
      createElement(QueryClientProvider, { client },
        createElement(AccessContext.Provider, { value: access },
          createElement(AnalyticsCacheGate, null, createElement(SavedDataAutoLoader, { loadTransactions: true }))));
    const view = render(tree(legacyAccess("user-a")));
    await waitFor(() => expect(loader.autoLoadWarehouseIntoStore).toHaveBeenCalledTimes(1));
    view.rerender(tree(legacyAccess("user-a")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loader.autoLoadWarehouseIntoStore).toHaveBeenCalledTimes(1);

    const owner = buildAccessValue({ status: "ok", access: okRow({ user_id: "user-a", raw_access: true, is_data_owner: true, partition: "p-owner" }), userId: "user-a" });
    view.rerender(tree(owner));
    await waitFor(() => expect(loader.autoLoadWarehouseIntoStore).toHaveBeenCalledTimes(2));
  });
});

// =========================================================================================
// I. funnel-restricted pending state (access Phase 2: 409 scope_snapshot_not_ready)
// =========================================================================================

describe("I. the page hooks on a funnel-restricted 409 / 403", () => {
  const restrictedAccess = () =>
    buildAccessValue({
      status: "ok",
      access: okRow({ funnel_scope: { mode: "selected", funnel_ids: ["f-a"], paths: ["soulmate-sketch"] }, partition: "p-buyer" }),
      userId: "user-b",
    });
  const refused = (status: number, code: string) =>
    edgeHttpError(status, { ok: false, error_code: code, error: `Request refused (${code}).`, request_id: "r-1" });
  const revenueRequest: RevenueIntelligenceRequest = { action: "bundle", bucket: "day", date_from: null, date_to: null, filters: { campaign_path: [], price_plan: [] } };
  const fbQuery: FbReportQuery = { level: "campaign", date_from: null, date_to: null, buyer: [], ad_account_id: [], campaign_id: [] };

  function mountHooks(client: QueryClient) {
    return renderHook(
      () => ({
        revenue: useRevenueBundle({ request: revenueRequest, userScopeHash: "x", warehouseVersion: "whv_x", enabled: true }),
        cohorts: useCohortsListQuery({ request: cohortsRequest, dataSource: "clickhouse", userScopeHash: "x", warehouseVersion: "whv_x", enabled: true }),
        fb: useFbReportQuery({ query: fbQuery, userScopeHash: "x", warehouseVersion: "fbv_x", enabled: true }),
      }),
      { wrapper: hookWrapper(client, restrictedAccess()) },
    );
  }

  /** The refetchInterval each hook's query resolves to right now. */
  function intervals(client: QueryClient) {
    return ["revenue", "cohorts", "fb-analytics"].map((root) => {
      const query = client.getQueryCache().findAll({ queryKey: [root] })[0];
      const option = query?.observers[0]?.options.refetchInterval;
      return typeof option === "function" ? option(query as never) : option;
    });
  }

  it("409 scope_snapshot_not_ready: typed code + status, the revenue card code, never retried or the breaker, polled every 60 s", async () => {
    sb.invoke.mockImplementation(async () => refused(409, "scope_snapshot_not_ready"));
    const client = new QueryClient();
    const { result } = mountHooks(client);
    await waitFor(() => {
      expect(result.current.revenue.errorCode).toBe("scope_snapshot_not_ready");
      expect(result.current.cohorts.chStatus.errorCode).toBe("scope_snapshot_not_ready");
      expect(result.current.fb.errorCode).toBe("scope_snapshot_not_ready");
    });
    expect(result.current.revenue).toMatchObject({ error: "cohort_snapshot_not_ready", errorStatus: 409 });
    expect(result.current.cohorts.chStatus.errorStatus).toBe(409);
    expect(result.current.fb.errorStatus).toBe(409);
    // One request per hook: a 409 is never retried per query, and never opens the breaker.
    expect(sb.invoke).toHaveBeenCalledTimes(3);
    expect(isClickHouseCircuitOpen()).toBe(false);
    expect(intervals(client)).toEqual([60_000, 60_000, 60_000]);
  });

  it("403 scope_not_supported is typed but never polled", async () => {
    sb.invoke.mockImplementation(async () => refused(403, "scope_not_supported"));
    const client = new QueryClient();
    const { result } = mountHooks(client);
    await waitFor(() => expect(result.current.cohorts.chStatus.errorCode).toBe("scope_not_supported"));
    await waitFor(() => expect(result.current.fb.errorStatus).toBe(403));
    expect(result.current.revenue.error).toMatch(/^ClickHouse Edge Function failed:/);
    expect(intervals(client)).toEqual([false, false, false]);
  });
});
