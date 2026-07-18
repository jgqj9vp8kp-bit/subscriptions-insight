// FB Analytics → Cohorts integration: filters/sorting, UI/columns/cache, and
// diagnostics/regression. Sections H–J of the 100-test functional suite
// (30 tests here; A–G live in fbCohortStats.test.ts). Contract tests run the
// REAL runMaterializedCohortList / computeFbCohortStats against routed fakes.

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import {
  buildFbCohortJoinSql,
  computeFbCohortStats,
  fbCohortMembersSql,
  fbCohortRowKey,
  assembleFbCohortStats,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import { runMaterializedCohortList } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import type { CohortAggregateRow, CohortFilters, CohortRequest } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import { sortCohortRows, getCohortSortValue, compareCohortSortValues } from "@/services/cohortSorting";
import {
  FB_COHORT_COLUMNS,
  FB_COHORT_COLUMN_LABELS,
  FB_COHORT_DEFAULT_COLUMNS,
  FB_COHORT_OPTIONAL_COLUMNS,
  fbCohortCellText,
} from "@/services/fbCohortFormatting";
import { buildCohortsExportTable, cohortsTableToCsv } from "@/services/cohortsExport";
import { cohortsListKey } from "@/services/cohortsCache";
import { sanitizeColumnOrder, sanitizeColumnVisibility } from "@/services/cohortsUiSettings";
import { ANALYTICS_CACHE_SCHEMA_VERSION } from "@/services/analyticsCache";
import { persistAnalyticsCache, restoreAnalyticsCache, ANALYTICS_PERSIST_KEY } from "@/services/analyticsCachePersistence";
import { FB_WAREHOUSE_VERSION_KEY } from "@/services/fbWarehouse";
import { useInvalidateFbWarehouse } from "@/hooks/useFbWarehouse";

const CAMPAIGN_A = "120249115818080040";
const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

// ---- Production-shaped fixtures ---------------------------------------------

function aggRow(fb: Partial<CohortAggregateRow> = {}): CohortAggregateRow {
  return {
    cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: "soulmate-sketch",
    trial_users: 10, upsell_users: 3, first_subscription_users: 8, renewal_users: 5,
    renewal_users_by_level: { 2: 5, 3: 4 }, refund_users: 1, support_users: 2, support_rate: 20,
    active_users: 0, active_subscriptions: 0, cancelled_users: 0,
    user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
    trial_revenue: 10, upsell_revenue: 30, first_subscription_revenue: 240, renewal_revenue: 150,
    gross_revenue: 500, net_revenue: 450, amount_refunded: 50,
    revenue_d0: 10, revenue_d7: 100, revenue_d14: 200, revenue_d30: 400, revenue_d60: 450,
    net_revenue_1m: 400, ltv_1m_per_user: 40,
    upsell_1_users: 0, upsell_2_users: 0, upsell_3_users: 0, upsell_extra_users: 0,
    upsell_1_revenue: 0, upsell_2_revenue: 0, upsell_3_revenue: 0, upsell_extra_revenue: 0,
    funnel_upsell_users: 0, funnel_upsell_revenue: 0,
    token_buyers: 0, token_purchases: 0, token_gross_revenue: 0, token_net_revenue: 0, addon_revenue: 0,
    fx_missing_transactions: 0, fx_missing_amount: 0,
    dedup: {
      active_user_hashes: [], active_subscription_hashes: [], refunded_user_hashes: [],
      cancelled_user_hashes: [], user_cancelled_user_hashes: [], auto_cancelled_user_hashes: [],
      cancelled_active_user_hashes: [], token_buyer_hashes: [],
    },
    fb_spend: 249.27, fb_currency: "USD", fb_purchases: 6, fb_cpp: 41.55,
    fb_impressions: 2823, fb_reach: 0, fb_clicks: 318, fb_link_clicks: 0,
    fb_ctr: 11.26, fb_cpc: 0.78, fb_cpm: 88.3, fb_purchase_value: 0, fb_roas: null,
    fb_campaigns_matched: 1, fb_match_status: "matched",
    ...fb,
  };
}

// Routed fakes for the REAL materialized list path (incl. the FB join queries).
function fakeSupabaseTables(tables: Record<string, Record<string, unknown> | null>): SupabaseLikeClient {
  return {
    from(table: string) {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
        upsert: async (value: unknown) => ({ data: value, error: null }),
      };
      return builder as never;
    },
  };
}

const SNAPSHOT_STATE = {
  status: "completed",
  active_warehouse_version: "wh_live",
  active_classification_version: "cohort_classifier_v1_dynamic_sql",
  active_generated_at: "2026-07-16T00:00:00Z",
  users_classified: 10,
  duplicate_users: 0,
  source_transactions: 100,
  source_unique_users: 10,
  diagnostics: { validation: { status: "PASS" } },
};
const FB_SYNC_STATE = {
  status: "completed",
  finished_at: "2026-07-16T09:00:00Z",
  cursor_transaction_id: "2026-07-16",
  cursor_updated_at: "2026-07-16T08:59:00Z",
  diagnostics: { mode: "full", fb_stats_to: "2026-07-15" },
};

function fakeWarehouse(options: {
  listRows?: Array<Record<string, unknown>>;
  fbPairs?: Array<Record<string, unknown>>;
  fbSourceStats?: Record<string, unknown>;
  fbJoinFails?: boolean;
} = {}): ClickHouseClientLike {
  const listRows = options.listRows ?? [{
    cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: "soulmate-sketch",
    trial_users: 10, gross_raw: 500, refund_raw: 50, r2: 5, r3: 4,
    first_subscription_users: 8, support_users: 2,
  }];
  return {
    command: async () => undefined,
    insert: async () => undefined,
    query: async ({ query }) => ({
      json: async () => {
        if (query.includes("LEFT JOIN fb f")) {
          if (options.fbJoinFails) throw new Error("fb join unavailable");
          return options.fbPairs ?? [{
            cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: "soulmate-sketch",
            campaign_id: CAMPAIGN_A, currency: "USD", matched: 1,
            spend: 249.27, purchases: 6, impressions: 2823, reach: 0, clicks: 318, link_clicks: 0, purchase_value: 0,
          }];
        }
        if (query.includes("raw_rows")) {
          if (options.fbJoinFails) throw new Error("fb stats unavailable");
          const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
          return [options.fbSourceStats ?? { raw_rows: 1065, campaign_day_rows: 1065, currencies: 1, last_stat_date: yesterday }];
        }
        if (query.includes("warehouse_hash")) {
          return [{ transaction_count: 100, unique_users: 10, max_row_version: "9", max_source_updated_at: "2026-07-16 00:00:00", warehouse_hash: "live" }];
        }
        if (query.includes("system.tables")) return [{ c: 1 }];
        if (query.includes("INNER JOIN fact_user_cohorts")) return listRows;
        if (query.includes("AS support_requests")) return [{ support_requests: 3, support_unique_emails: 3 }];
        if (query.includes("fact_subscriptions")) return [{ c: 0 }];
        if (query.includes("transactions_with_currency")) {
          return [{ transactions_total: 100, transactions_with_currency: 100, transactions_without_currency: 0, transactions_native_usd: 90, transactions_converted: 10, transactions_missing_fx_rate: 0, transactions_invalid_amount: 0, excluded_amount_original: 0, excluded_transactions: 0 }];
        }
        if (query.includes("count() AS c")) return [{ c: 0 }];
        return [];
      },
    }),
  };
}

async function runList(options: Parameters<typeof fakeWarehouse>[0] = {}, request: CohortRequest = { action: "list" }) {
  const response = await runMaterializedCohortList({
    authUserId: "user-1",
    supabase: fakeSupabaseTables({
      clickhouse_cohort_snapshot_state: SNAPSHOT_STATE,
      clickhouse_transaction_sync_state: FB_SYNC_STATE,
    }),
    clickhouse: fakeWarehouse(options),
    request,
  });
  if (!response) throw new Error("materialized path unexpectedly unavailable");
  return response;
}

// =============================================================================
// H. Filters and sorting — 10 tests
// =============================================================================
describe("H. Filters and sorting", () => {
  it("H71: cohort date filter bounds the FB member scan with bound parameters", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({ filters: NO_FILTERS, dateFrom: "2026-07-01", dateTo: "2026-07-14", params });
    expect(sql).toContain("cohort_date) >= {fbj_date_from:String}");
    expect(sql).toContain("cohort_date) <= {fbj_date_to:String}");
    expect(params.fbj_date_from).toBe("2026-07-01");
  });

  it("H72: funnel filter scopes matched campaigns via bound parameters", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({ filters: { ...NO_FILTERS, funnel: ["soulmate"] }, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("funnel IN ({p_fbj_fn_0:String})");
    expect(params.p_fbj_fn_0).toBe("soulmate");
  });

  it("H73: campaign path filter scopes matched campaigns", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({ filters: { ...NO_FILTERS, campaign_path: ["soulmate-sketch"] }, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("campaign_path IN ({p_fbj_cp_0:String})");
    expect(params.p_fbj_cp_0).toBe("soulmate-sketch");
  });

  it("H74: campaign id filter scopes FB metrics to the selected campaigns", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({ filters: { ...NO_FILTERS, campaign_id: [CAMPAIGN_A] }, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("campaign_id IN ({p_fbj_cid_0:String})");
    expect(params.p_fbj_cid_0).toBe(CAMPAIGN_A);
  });

  it("H75: media buyer filter preserves member-attribution semantics (user-level scope, bound param)", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({ filters: { ...NO_FILTERS, media_buyer: ["Ivan"] }, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("media_buyer IN ({p_fbj_mb_0:String})");
    expect(params.p_fbj_mb_0).toBe("Ivan");
  });

  it("H76: a split filter (GEO) narrows members without duplicating spend — the pair still counts once", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({ filters: { ...NO_FILTERS, country: ["US"] }, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("country IN ({p_fbj_geo_0:String})");
    const KEY = fbCohortRowKey("2026-07-14", "soulmate", "soulmate-sketch");
    const { totals } = assembleFbCohortStats(
      [
        { cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: "soulmate-sketch", campaign_id: CAMPAIGN_A, currency: "USD", matched: 1, spend: 100, purchases: 1, impressions: 10, clicks: 1, link_clicks: 0, reach: 0, purchase_value: 0 },
        { cohort_date: "2026-07-14", funnel: "soulmate", campaign_path: "soulmate-sketch", campaign_id: CAMPAIGN_A, currency: "USD", matched: 1, spend: 100, purchases: 1, impressions: 10, clicks: 1, link_clicks: 0, reach: 0, purchase_value: 0 },
      ],
      new Set([KEY]),
    );
    expect(totals.fb_spend).toBe(100);
  });

  it("H77: sorting by Spend ascending orders the full row set", () => {
    const rows = [
      mapAggregateToCohortRow(aggRow({ fb_spend: 300, cohort_date: "2026-07-13" })),
      mapAggregateToCohortRow(aggRow({ fb_spend: 100 })),
    ];
    const sorted = sortCohortRows(rows, { sortColumn: "fb_spend", sortDirection: "asc" });
    expect(sorted.map((r) => r.fb_spend)).toEqual([100, 300]);
  });

  it("H78: sorting by Spend descending orders the full row set", () => {
    const rows = [
      mapAggregateToCohortRow(aggRow({ fb_spend: 100 })),
      mapAggregateToCohortRow(aggRow({ fb_spend: 300, cohort_date: "2026-07-13" })),
    ];
    const sorted = sortCohortRows(rows, { sortColumn: "fb_spend", sortDirection: "desc" });
    expect(sorted.map((r) => r.fb_spend)).toEqual([300, 100]);
  });

  it("H79: CPP ascending puts null (unavailable) rows last", () => {
    const withCpp = mapAggregateToCohortRow(aggRow({ fb_cpp: 10 }));
    const noCpp = mapAggregateToCohortRow(aggRow({ fb_cpp: null, cohort_date: "2026-07-13" }));
    const sorted = sortCohortRows([noCpp, withCpp], { sortColumn: "fb_cpp", sortDirection: "asc" });
    expect(sorted[0].fb_cpp).toBe(10);
    expect(sorted[1].fb_cpp).toBeNull();
  });

  it("H80: ROAS descending puts null rows last (missing-last comparator rule)", () => {
    expect(compareCohortSortValues(null, 2, "desc")).toBeGreaterThan(0);
    expect(compareCohortSortValues(2, null, "desc")).toBeLessThan(0);
    const withRoas = mapAggregateToCohortRow(aggRow({ fb_roas: 1.8 }));
    const noRoas = mapAggregateToCohortRow(aggRow({ fb_roas: null, cohort_date: "2026-07-13" }));
    const sorted = sortCohortRows([noRoas, withRoas], { sortColumn: "fb_roas", sortDirection: "desc" });
    expect(sorted[0].fb_roas).toBe(1.8);
  });
});

// =============================================================================
// I. UI, columns and cache — 10 tests
// =============================================================================
describe("I. UI, columns and cache", () => {
  const row = mapAggregateToCohortRow(aggRow());

  it("I81: Spend column renders the USD amount", () => {
    render(createElement("span", null, fbCohortCellText(row, "fb_spend")));
    expect(screen.getByText("$249.27")).toBeTruthy();
  });

  it("I82: FB Purchases column renders the integer count", () => {
    render(createElement("span", null, fbCohortCellText(row, "fb_purchases")));
    expect(screen.getByText("6")).toBeTruthy();
  });

  it("I83: CPP column renders — when purchases are zero", () => {
    const zero = mapAggregateToCohortRow(aggRow({ fb_purchases: 0, fb_cpp: null }));
    render(createElement("span", { "data-testid": "cpp" }, fbCohortCellText(zero, "fb_cpp")));
    expect(screen.getByTestId("cpp").textContent).toBe("—");
  });

  it("I84: the Columns selector inventory includes every FB field with a label", () => {
    expect(FB_COHORT_COLUMNS).toHaveLength(FB_COHORT_DEFAULT_COLUMNS.length + FB_COHORT_OPTIONAL_COLUMNS.length);
    for (const id of FB_COHORT_COLUMNS) {
      expect(FB_COHORT_COLUMN_LABELS[id], `label for ${id}`).toBeTruthy();
    }
    expect(FB_COHORT_DEFAULT_COLUMNS).toEqual(["fb_spend", "fb_purchases", "fb_cpp"]);
  });

  it("I85: drag-and-drop persistence keeps FB columns at their moved position", () => {
    const defaults = ["cohort_date", "fb_spend", "fb_purchases", "fb_cpp", "trial_users"];
    const moved = ["fb_cpp", "cohort_date", "fb_spend", "fb_purchases", "trial_users"];
    expect(sanitizeColumnOrder(moved, defaults)).toEqual(moved);
  });

  it("I86: saved-view visibility for FB columns survives sanitization; unknown stays default-hidden", () => {
    const visibility = sanitizeColumnVisibility(
      { fb_spend: false, fb_roas: true },
      { fb_spend: true, fb_purchases: true, fb_roas: false },
      ["fb_spend", "fb_purchases", "fb_roas"],
    );
    expect(visibility.fb_spend).toBe(false); // user's saved choice wins
    expect(visibility.fb_purchases).toBe(true); // default visible
    expect(visibility.fb_roas).toBe(true); // user opted in
  });

  it("I87: export contains FB columns with their values (CSV includes header + amount)", () => {
    const table = buildCohortsExportTable({
      cohorts: [row],
      columnOrder: ["cohort_date", "fb_spend", "fb_purchases", "fb_cpp"],
      columnLabel: (id) => FB_COHORT_COLUMN_LABELS[id] ?? id,
    });
    expect(table.headers).toContain("Spend (FB)");
    const csv = cohortsTableToCsv(table);
    expect(csv).toContain("249.27");
    expect(csv.split("\n")[1]).toContain("2026-07-14");
  });

  it("I88: the Cohorts query key includes the FB warehouse version as its own segment", () => {
    const request: CohortRequest = { action: "list", filters: NO_FILTERS };
    const key = cohortsListKey({
      userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_a",
      fbWarehouseVersion: "fbwhv_b", request,
    });
    expect(key[4]).toBe("whv_a");
    expect(key[5]).toBe("fbwhv_b");
    const other = cohortsListKey({
      userScopeHash: "u_1", dataSource: "clickhouse", warehouseVersion: "whv_a",
      fbWarehouseVersion: "fbwhv_c", request,
    });
    expect(JSON.stringify(key)).not.toBe(JSON.stringify(other));
  });

  it("I89: a persisted cache from the pre-FB schema version is rejected on restore", () => {
    sessionStorage.clear();
    const client = new QueryClient();
    client.setQueryData(["cohorts", "list", "u_1", "clickhouse", "whv", "fbwhv", {}], { cohorts: [] });
    persistAnalyticsCache(client, "u_1");
    const raw = JSON.parse(sessionStorage.getItem(ANALYTICS_PERSIST_KEY)!);
    raw.schemaVersion = ANALYTICS_CACHE_SCHEMA_VERSION - 1; // pre-FB bundle shape
    sessionStorage.setItem(ANALYTICS_PERSIST_KEY, JSON.stringify(raw));
    expect(restoreAnalyticsCache(new QueryClient(), "u_1")).toBe(false);
  });

  it("I90: an FB sync invalidates the FB version key AND every cohorts query", async () => {
    const client = new QueryClient();
    const cohortsKey = ["cohorts", "list", "u_1", "clickhouse", "whv", "fbwhv", {}];
    client.setQueryData(cohortsKey, { cohorts: [] });
    client.setQueryData([...FB_WAREHOUSE_VERSION_KEY], { ok: true });
    const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
    const { result } = renderHook(() => useInvalidateFbWarehouse(), { wrapper });
    await act(async () => { await result.current(); });
    expect(client.getQueryState(cohortsKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState([...FB_WAREHOUSE_VERSION_KEY])?.isInvalidated).toBe(true);
  });
});

// =============================================================================
// J. Diagnostics and regression — 10 tests
// =============================================================================
describe("J. Diagnostics and regression", () => {
  it("J91: fb_data_status is ready when rows exist and freshness covers yesterday", async () => {
    const response = await runList();
    expect(response.fb_diagnostics?.fb_data_status).toBe("ready");
    expect(response.fb_diagnostics?.fb_warehouse_version).toMatch(/^fbwh_/);
  });

  it("J92: fb_data_status is empty_source when the FB warehouse has zero rows", async () => {
    const response = await runList({
      fbPairs: [],
      fbSourceStats: { raw_rows: 0, campaign_day_rows: 0, currencies: 0, last_stat_date: "1970-01-01" },
    });
    expect(response.fb_diagnostics?.fb_data_status).toBe("empty_source");
  });

  it("J93: FB backend failure never degrades the cohort report (rows survive, fb block absent)", async () => {
    const response = await runList({ fbJoinFails: true });
    expect(response.ok).toBe(true);
    expect(response.rows).toHaveLength(1);
    expect(response.rows[0].trial_users).toBe(10);
    expect(response.fb_totals).toBeUndefined();
    expect(response.fb_diagnostics).toBeUndefined();
  });

  it("J94: fb_data_status is sync_pending while an FB sync is running", async () => {
    const response = await runMaterializedCohortList({
      authUserId: "user-1",
      supabase: fakeSupabaseTables({
        clickhouse_cohort_snapshot_state: SNAPSHOT_STATE,
        clickhouse_transaction_sync_state: { ...FB_SYNC_STATE, status: "running" },
      }),
      clickhouse: fakeWarehouse(),
      request: { action: "list" },
    });
    expect(response?.fb_diagnostics?.fb_data_status).toBe("sync_pending");
  });

  it("J95: match diagnostics reconcile — matched + unmatched equals visible rows", async () => {
    const response = await runList();
    const d = response.fb_diagnostics!;
    expect(d.fb_matched_cohort_rows + d.fb_unmatched_cohort_rows).toBe(response.rows.length);
    expect(d.fb_join_key).toBe("campaign_id+cohort_date");
  });

  it("J96: existing Trial metric is byte-identical with and without the FB join", async () => {
    const withFb = await runList();
    const withoutFb = await runList({ fbJoinFails: true });
    expect(withFb.rows[0].trial_users).toBe(withoutFb.rows[0].trial_users);
    expect(withFb.totals.trial_users).toBe(withoutFb.totals.trial_users);
  });

  it("J97: existing Revenue metrics are identical with and without the FB join", async () => {
    const withFb = await runList();
    const withoutFb = await runList({ fbJoinFails: true });
    expect(withFb.rows[0].gross_revenue).toBe(withoutFb.rows[0].gross_revenue);
    expect(withFb.rows[0].net_revenue).toBe(withoutFb.rows[0].net_revenue);
    expect(withFb.totals.net_revenue).toBe(withoutFb.totals.net_revenue);
  });

  it("J98: existing Renewal metrics are identical with and without the FB join", async () => {
    const withFb = await runList();
    const withoutFb = await runList({ fbJoinFails: true });
    expect(withFb.rows[0].renewal_users_by_level).toEqual(withoutFb.rows[0].renewal_users_by_level);
  });

  it("J99: Support Users and Support Rate are identical with and without the FB join", async () => {
    const withFb = await runList();
    const withoutFb = await runList({ fbJoinFails: true });
    expect(withFb.rows[0].support_users).toBe(withoutFb.rows[0].support_users);
    expect(withFb.rows[0].support_rate).toBe(withoutFb.rows[0].support_rate);
  });

  it("J100: the full report response contains no API token or raw payload secrets", async () => {
    const response = await runList();
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain("fbops_live");
    expect(serialized).not.toContain("CAPSULED_API_TOKEN");
    expect(serialized).not.toContain("raw_payload");
    expect(serialized).not.toContain("Bearer ");
  });
});

// =============================================================================
// Contract sanity for computeFbCohortStats (supports J-section; outside the 100)
// =============================================================================
describe("computeFbCohortStats contract", () => {
  beforeEach(() => sessionStorage.clear());

  it("returns per-row stats keyed by the cohort row key with ready diagnostics", async () => {
    const KEY = fbCohortRowKey("2026-07-14", "soulmate", "soulmate-sketch");
    const bundle = await computeFbCohortStats({
      clickhouse: fakeWarehouse(),
      supabase: fakeSupabaseTables({ clickhouse_transaction_sync_state: FB_SYNC_STATE }),
      authUserId: "user-1",
      active: { warehouse_version: "wh_live", classification_version: "v1" },
      filters: NO_FILTERS,
      dateFrom: null,
      dateTo: null,
      visibleKeys: new Set([KEY]),
      today: "2026-07-16",
    });
    expect(bundle.perRow[KEY].fb_spend).toBe(249.27);
    expect(bundle.totals.fb_campaign_day_pairs).toBe(1);
    expect(bundle.diagnostics.fb_data_status).toBe("ready");
  });

  it("binds the snapshot version so FB members always match the active cohort snapshot", () => {
    const params: Record<string, unknown> = {};
    const sql = buildFbCohortJoinSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("warehouse_version = {warehouse_version:String}");
    expect(sql).toContain("classification_version = {classification_version:String}");
  });
});
