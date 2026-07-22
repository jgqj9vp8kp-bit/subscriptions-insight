import { describe, expect, it } from "vitest";
import {
  loadServerWarehouseTransactions,
  resolveServerTransactions,
} from "../../supabase/functions/_shared/clickhouse/serverTransactionsSource.ts";
import { hydrateWarehouseTransactionsForAnalytics } from "../../supabase/functions/_shared/clickhouse/warehouseHydration.ts";
import {
  computeDashboardSummary,
  reconcileNumericRecords,
} from "../../supabase/functions/_shared/clickhouse/dashboardSummary.ts";
import { computeCohorts } from "../../supabase/functions/_shared/clickhouse/cohortAnalytics.ts";
import { aggregateTrafficMetrics, trafficForCohort } from "../../supabase/functions/_shared/clickhouse/cohortReporting.ts";
import {
  buildDashboardKpis,
  buildTrialsUpsellsByDay,
  getCashRevenueByDateRange,
  normalizeDashboardTransactions,
} from "../../supabase/functions/_shared/clickhouse/dashboardCompute.ts";
import type { SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";
import type { TrafficMetric } from "../../supabase/functions/_shared/clickhouse/trafficMetric.ts";
import type { Transaction } from "../../supabase/functions/_shared/clickhouse/serviceTypes.ts";

function tx(userId: string, type: Transaction["transaction_type"], overrides: Partial<Transaction> = {}): Transaction {
  const amount = type === "trial" ? 1 : type === "upsell" ? 5 : 10;
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${type}-${overrides.event_time ?? "2026-05-01T00:00:00Z"}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: "2026-05-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: amount,
    refund_amount_usd: 0,
    net_amount_usd: amount,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: type,
    funnel: "soulmate",
    campaign_path: "path-a",
    product: "",
    traffic_source: "facebook",
    campaign_id: "120001",
    classification_reason: "",
    ...overrides,
  } as Transaction;
}

const transactions: Transaction[] = [
  tx("u1", "trial"),
  tx("u1", "upsell", { event_time: "2026-05-01T00:05:00Z" }),
  tx("u1", "first_subscription", { event_time: "2026-05-08T00:00:00Z" }),
  tx("u2", "trial", { funnel: "starseed", campaign_path: "path-b", event_time: "2026-05-03T00:00:00Z" }),
];

const trafficRows: TrafficMetric[] = [
  { date: "2026-05-01", campaign_path: "path-a", trial_count: 1, cac: 12, spend: 12, clicks: 30, cpc: 0.4, cpm: 0, ctr: 0, source: "facebook" },
];

// Warehouse records whose normalized_payload round-trips into the same transactions.
const warehouseRecords = transactions.map((transaction) => ({
  source: "palmer_csv",
  raw_payload: null,
  normalized_payload: transaction as unknown as Record<string, unknown>,
}));

function fakeWarehouseClient(rows: typeof warehouseRecords, options: { failFirstRange?: boolean } = {}): SupabaseLikeClient {
  let failNext = Boolean(options.failFirstRange);
  return {
    from(table: string) {
      if (table !== "transactions") throw new Error(`Unexpected table ${table}`);
      const builder = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        in: () => builder,
        or: () => builder,
        lte: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        upsert: () => Promise.resolve({ data: null, error: null }),
        then: undefined as never,
        range: (from: number, to: number) => {
          if (failNext) {
            failNext = false;
            return Promise.resolve({ data: null, error: { message: "boom" } });
          }
          return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
        },
      };
      return builder as unknown as ReturnType<SupabaseLikeClient["from"]>;
    },
  };
}

describe("serverTransactionsSource", () => {
  it("pages the warehouse with the client's select policy and hydrates identically", async () => {
    const loaded = await loadServerWarehouseTransactions(fakeWarehouseClient(warehouseRecords), "owner-1", 2);
    expect(loaded).toEqual(hydrateWarehouseTransactionsForAnalytics(warehouseRecords));
    expect(loaded.length).toBeGreaterThan(0);
  });

  it("prefers the warehouse and falls back to the backfilled palmer snapshot when it is empty", async () => {
    const fromWarehouse = await resolveServerTransactions({
      supabase: fakeWarehouseClient(warehouseRecords),
      authUserId: "owner-1",
      palmerPayload: { payload_version: 1, transactions: [transactions[0]] },
    });
    expect(fromWarehouse.source).toBe("transaction_warehouse");
    expect(fromWarehouse.transactions.length).toBe(hydrateWarehouseTransactionsForAnalytics(warehouseRecords).length);

    const fromSnapshot = await resolveServerTransactions({
      supabase: fakeWarehouseClient([]),
      authUserId: "owner-1",
      palmerPayload: { payload_version: 1, transactions },
    });
    expect(fromSnapshot.source).toBe("palmer_snapshot");
    expect(fromSnapshot.transactions.length).toBe(transactions.length);

    const empty = await resolveServerTransactions({
      supabase: fakeWarehouseClient([]),
      authUserId: "owner-1",
      palmerPayload: null,
    });
    expect(empty.source).toBe("empty");
    expect(empty.transactions).toEqual([]);
  });

  it("propagates warehouse read errors instead of silently falling back", async () => {
    await expect(
      resolveServerTransactions({
        supabase: fakeWarehouseClient(warehouseRecords, { failFirstRange: true }),
        authUserId: "owner-1",
        palmerPayload: { payload_version: 1, transactions },
      }),
    ).rejects.toThrow("Could not load warehouse transactions");
  });
});

describe("computeDashboardSummary", () => {
  const input = {
    transactions,
    transactionsSource: "palmer_snapshot",
    subscriptions: [],
    trafficMetrics: trafficRows,
    filters: {},
  };

  it("reproduces the Dashboard page chain exactly", () => {
    const dashboardTransactions = normalizeDashboardTransactions(transactions).transactions;
    const cohorts = computeCohorts(dashboardTransactions, []);
    const trafficByKey = aggregateTrafficMetrics(trafficRows);
    const dashboardCohorts = cohorts.map((cohort) => {
      const traffic = trafficForCohort(cohort, trafficByKey);
      return {
        ...cohort,
        traffic_spend: traffic?.spend ?? null,
        traffic_trial_count: traffic?.trial_count ?? 0,
        traffic_clicks: traffic?.clicks ?? 0,
      };
    });
    const expectedKpis = buildDashboardKpis(dashboardCohorts);
    const expectedCash = getCashRevenueByDateRange(dashboardTransactions, {
      dateFrom: "",
      dateTo: "",
      funnelFilter: "all",
      campaignPathFilter: "all",
      sourceFilter: "all",
    });

    const result = computeDashboardSummary(input);

    expect(result.kpis.slice(0, expectedKpis.length)).toEqual(expectedKpis);
    expect(result.kpis.map((kpi) => kpi.label)).toContain("Cash Revenue");
    expect(result.cashRevenueSummary).toEqual(expectedCash);
    expect(result.trialsUpsellsByDay).toEqual(buildTrialsUpsellsByDay(dashboardTransactions));
    expect(result.totals.trialUsers).toBe(2);
    expect(result.totals.upsellUsers).toBe(1);
    expect(result.totals.firstSubUsers).toBe(1);
    expect(result.cashCohortDifference).toBeCloseTo(result.cashRevenueSummary.cashRevenue - result.cohortGrossRevenue, 6);
    expect(result.meta).toMatchObject({
      transactions: transactions.length,
      transactions_source: "palmer_snapshot",
      traffic_rows: 1,
      cohorts: cohorts.length,
    });
  });

  it("applies funnel/path/date/source filters like the page", () => {
    const filtered = computeDashboardSummary({ ...input, filters: { funnelFilter: "starseed" } });
    expect(filtered.totals.trialUsers).toBe(1);
    expect(filtered.totals.upsellUsers).toBe(0);
    expect(filtered.meta.filtered_cohorts).toBeLessThan(filtered.meta.cohorts);

    const dateFiltered = computeDashboardSummary({ ...input, filters: { cohortDateFrom: "2026-05-02" } });
    expect(dateFiltered.totals.trialUsers).toBe(1);

    const sourceFiltered = computeDashboardSummary({ ...input, filters: { sourceFilter: "tiktok" } });
    expect(sourceFiltered.totals.spend).toBe(0);
  });

  it("survives a JSON round-trip with zero numeric drift", () => {
    const direct = computeDashboardSummary(input);
    const roundTripped = JSON.parse(JSON.stringify(direct)) as typeof direct;
    expect(
      reconcileNumericRecords("totals", roundTripped.totals as unknown as Record<string, unknown>, direct.totals as unknown as Record<string, unknown>),
    ).toEqual([]);
    expect(roundTripped).toEqual(direct);
  });
});

describe("reconcileNumericRecords", () => {
  it("flags numeric drift and null-vs-number, skips non-numeric fields", () => {
    const server = { a: 1, b: null, label: "x", nested: [1] };
    const client = { a: 1.5, b: 2, label: "y", nested: [2] };
    const mismatches = reconcileNumericRecords("scope", server, client);
    expect(mismatches.map((m) => m.metric).sort()).toEqual(["a", "b"]);
    expect(reconcileNumericRecords("scope", { a: 1.005 }, { a: 1 })).toEqual([]);
  });
});
