import { describe, expect, it } from "vitest";
import { hashKey } from "@tanstack/react-query";
import {
  cohortDetailsKey,
  cohortsListKey,
  hashUserScope,
  normalizeCohortRequest,
  warehouseVersionFromSummary,
} from "@/services/cohortsCache";
import type { CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract";

const base: CohortRequest = {
  action: "list",
  date_from: "2026-01-01",
  date_to: "2026-02-01",
  filters: { funnel: ["past_life"], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [], media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all" },
  max_renewal_depth: 6,
};

describe("cohorts cache keys", () => {
  it("#7 logically identical filters (different array order / dupes) produce the SAME key", () => {
    const a: CohortRequest = { ...base, filters: { ...base.filters!, country: ["US", "DE", "US"], card_type: ["visa", "mc"] } };
    const b: CohortRequest = { ...base, filters: { ...base.filters!, country: ["DE", "US"], card_type: ["mc", "visa", "mc"] } };
    expect(normalizeCohortRequest(a)).toEqual(normalizeCohortRequest(b));
    const keyA = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: a });
    const keyB = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: b });
    expect(hashKey(keyA)).toBe(hashKey(keyB));
  });

  it("#6 different filter combinations produce DIFFERENT keys", () => {
    const k1 = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: base });
    const k2 = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: { ...base, filters: { ...base.filters!, funnel: ["soulmate"] } } });
    const k3 = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: { ...base, date_from: "2026-03-01" } });
    const k4 = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: { ...base, filters: { ...base.filters!, traffic_source: ["facebook"] } } });
    expect(hashKey(k1)).not.toBe(hashKey(k2));
    expect(hashKey(k1)).not.toBe(hashKey(k3));
    expect(hashKey(k1)).not.toBe(hashKey(k4));
  });

  it("#11 different authenticated users produce DIFFERENT keys (isolation)", () => {
    const kA = cohortsListKey({ userScopeHash: hashUserScope("user-a"), dataSource: "clickhouse", warehouseVersion: "whv_x", request: base });
    const kB = cohortsListKey({ userScopeHash: hashUserScope("user-b"), dataSource: "clickhouse", warehouseVersion: "whv_x", request: base });
    expect(hashKey(kA)).not.toBe(hashKey(kB));
  });

  it("#13 a warehouse-version change produces a DIFFERENT key (busts stale cache)", () => {
    const k1 = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_a", request: base });
    const k2 = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_b", request: base });
    expect(hashKey(k1)).not.toBe(hashKey(k2));
  });

  it("#16 details key is separate from the list key and keyed by cohort identity + filter", () => {
    const list = cohortsListKey({ userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_x", request: base });
    const details = cohortDetailsKey({
      userScopeHash: "u_1",
      warehouseVersion: "whv_x",
      cohortKey: { cohort_date: "2026-01-01", funnel: "past_life", campaign_path: "cp1" },
      request: base,
    });
    expect(hashKey(list)).not.toBe(hashKey(details));
    expect(details[1]).toBe("details");
    // a different cohort → different details key; same identity+filter → same key
    const details2 = cohortDetailsKey({
      userScopeHash: "u_1",
      warehouseVersion: "whv_x",
      cohortKey: { cohort_date: "2026-01-02", funnel: "past_life", campaign_path: "cp1" },
      request: base,
    });
    expect(hashKey(details)).not.toBe(hashKey(details2));
  });

  it("#17 reopening the same cohort+filter yields the SAME details key (cache hit, no refetch)", () => {
    const parts = {
      userScopeHash: "u_1",
      warehouseVersion: "whv_x",
      cohortKey: { cohort_date: "2026-01-01", funnel: "past_life", campaign_path: "cp1" },
      request: base,
    };
    expect(hashKey(cohortDetailsKey(parts))).toBe(hashKey(cohortDetailsKey({ ...parts })));
  });

  it("hashUserScope is stable, non-empty, and never contains the raw id", () => {
    expect(hashUserScope("278c1a16-b417")).toBe(hashUserScope("278c1a16-b417"));
    expect(hashUserScope("278c1a16-b417")).not.toContain("278c1a16");
    expect(hashUserScope(null)).toBe(hashUserScope(undefined));
  });

  it("warehouse version is a hash (no raw cursor id) and changes with warehouse state", () => {
    const v1 = warehouseVersionFromSummary({ sync_state: { cursor_transaction_id: "tx_1", clickhouse_total: 100 } } as never);
    const v2 = warehouseVersionFromSummary({ sync_state: { cursor_transaction_id: "tx_2", clickhouse_total: 200 } } as never);
    expect(v1).not.toBe(v2);
    expect(v1).not.toContain("tx_1");
    expect(warehouseVersionFromSummary(null)).toBe("whv_unknown");
  });

  it("warehouse version changes when the active cohort snapshot changes", () => {
    const baseSummary = {
      sync_state: { cursor_transaction_id: "tx_1", cursor_updated_at: "2026-07-12T00:00:00Z", clickhouse_total: 100 },
      cohort_snapshot_state: {
        status: "completed",
        active_warehouse_version: "wh_a",
        active_classification_version: "classifier_a",
        active_generated_at: "2026-07-12T00:00:00Z",
        users_classified: 10,
      },
    };
    const v1 = warehouseVersionFromSummary(baseSummary as never);
    const v2 = warehouseVersionFromSummary({
      ...baseSummary,
      cohort_snapshot_state: {
        ...baseSummary.cohort_snapshot_state,
        active_generated_at: "2026-07-12T00:05:00Z",
        users_classified: 11,
      },
    } as never);
    expect(v1).not.toBe(v2);
    expect(v1).not.toContain("wh_a");
  });
});
