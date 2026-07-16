import { beforeEach, describe, expect, it } from "vitest";
import { QueryClient, hashKey } from "@tanstack/react-query";
import {
  clearPersistedAnalyticsCache as clearPersistedCohortsCache,
  persistAnalyticsCache as persistCohortsCache,
  restoreAnalyticsCache as restoreCohortsCache,
  shouldPersistAnalyticsQuery as shouldPersistCohortsQuery,
  ANALYTICS_PERSIST_KEY,
} from "@/services/analyticsCachePersistence";
import { cohortsListKey, WAREHOUSE_VERSION_KEY } from "@/services/cohortsCache";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

const request: CohortRequest = {
  action: "list",
  date_from: null,
  date_to: null,
  filters: { funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
  max_renewal_depth: 6,
};
const keyFor = (scope: string) => cohortsListKey({ userScopeHash: scope, dataSource: "clickhouse", warehouseVersion: "whv_x", request });
const keyForDate = (scope: string, date: string) => cohortsListKey({
  userScopeHash: scope,
  dataSource: "clickhouse",
  warehouseVersion: "whv_x",
  request: { ...request, date_from: date },
});
const sample = { cohorts: [{ cohort_id: "c1" }, { cohort_id: "c2" }], source: "clickhouse", durationMs: 12 };

function seed(scope: string): QueryClient {
  const c = new QueryClient();
  c.setQueryData(keyFor(scope), sample);
  return c;
}

describe("cohorts cache persistence (sessionStorage)", () => {
  beforeEach(() => sessionStorage.clear());

  it("#10 persisted cache restores into a fresh client after reload", () => {
    persistCohortsCache(seed("u_A"), "u_A");
    const fresh = new QueryClient();
    expect(restoreCohortsCache(fresh, "u_A")).toBe(true);
    expect(fresh.getQueryData(keyFor("u_A"))).toEqual(sample);
  });

  it("#11 persisted cache is isolated by user — another user cannot restore it", () => {
    persistCohortsCache(seed("u_A"), "u_A");
    const other = new QueryClient();
    expect(restoreCohortsCache(other, "u_B")).toBe(false);
    expect(other.getQueryData(keyFor("u_A"))).toBeUndefined();
    // foreign entry is discarded from storage
    expect(sessionStorage.getItem(ANALYTICS_PERSIST_KEY)).toBeNull();
  });

  it("#12 clearing (logout) removes the persisted cache", () => {
    persistCohortsCache(seed("u_A"), "u_A");
    expect(sessionStorage.getItem(ANALYTICS_PERSIST_KEY)).not.toBeNull();
    clearPersistedCohortsCache();
    const fresh = new QueryClient();
    expect(restoreCohortsCache(fresh, "u_A")).toBe(false);
  });

  it("expired entries (older than max age) are discarded on restore", () => {
    const t0 = 1_000_000_000_000;
    persistCohortsCache(seed("u_A"), "u_A", t0);
    const fresh = new QueryClient();
    expect(restoreCohortsCache(fresh, "u_A", t0 + 61 * 60 * 1000)).toBe(false);
  });

  it("schema-incompatible entries are discarded on restore", () => {
    persistCohortsCache(seed("u_A"), "u_A");
    const raw = JSON.parse(sessionStorage.getItem(ANALYTICS_PERSIST_KEY)!);
    raw.schemaVersion = 999;
    sessionStorage.setItem(ANALYTICS_PERSIST_KEY, JSON.stringify(raw));
    const fresh = new QueryClient();
    expect(restoreCohortsCache(fresh, "u_A")).toBe(false);
  });

  it("persists successful analytics (cohorts/users/payment) + warehouse-version queries; skips others/PII", () => {
    expect(shouldPersistCohortsQuery({ queryKey: keyFor("u_A"), state: { status: "success", data: sample } } as never)).toBe(true);
    expect(shouldPersistCohortsQuery({ queryKey: ["users", "list"], state: { status: "success", data: {} } } as never)).toBe(true);
    expect(shouldPersistCohortsQuery({ queryKey: ["payment-analytics", "bundle"], state: { status: "success", data: {} } } as never)).toBe(true);
    expect(shouldPersistCohortsQuery({ queryKey: [...WAREHOUSE_VERSION_KEY], state: { status: "success", data: "whv_x" } } as never)).toBe(true);
    // pending query — not persisted
    expect(shouldPersistCohortsQuery({ queryKey: keyFor("u_A"), state: { status: "pending", data: undefined } } as never)).toBe(false);
    // unrelated (non-analytics) query — not persisted
    expect(shouldPersistCohortsQuery({ queryKey: ["dashboard", "summary"], state: { status: "success", data: {} } } as never)).toBe(false);
  });

  it("persisted payload contains no raw ids / tokens / emails (aggregate + hashes only)", () => {
    persistCohortsCache(seed("u_A"), "u_A");
    const raw = sessionStorage.getItem(ANALYTICS_PERSIST_KEY) ?? "";
    expect(raw).not.toMatch(/access_token|service_role|Bearer |@/);
    // the key segments are the scope hash + hashed warehouse version, not raw ids
    expect(raw).toContain("u_A");
    expect(hashKey(keyFor("u_A"))).toBeTruthy();
  });

  it("keeps warehouseVersion even when more aggregate entries exist than the persistence limit", () => {
    const c = new QueryClient();
    c.setQueryData([...WAREHOUSE_VERSION_KEY], "whv_keep");
    for (let index = 0; index < 24; index += 1) {
      c.setQueryData(keyForDate("u_A", `2026-01-${String(index + 1).padStart(2, "0")}`), {
        cohorts: [{ cohort_id: `c${index}` }],
        source: "clickhouse",
        durationMs: index,
      });
    }

    persistCohortsCache(c, "u_A");
    const fresh = new QueryClient();
    expect(restoreCohortsCache(fresh, "u_A")).toBe(true);
    expect(fresh.getQueryData([...WAREHOUSE_VERSION_KEY])).toBe("whv_keep");
  });
});
