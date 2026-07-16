import { describe, expect, it } from "vitest";
import {
  cohortFilterReproductionStatus,
  compareCohortResults,
  filtersFullyReproduced,
  mapAggregateToCohortRow,
  type CohortsSourceResult,
} from "@/services/cohortsDataSource";
import type { CohortRow } from "@/services/types";
import type { CohortAggregateRow, CohortResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract";

function cohort(over: Partial<CohortRow> & { cohort_date: string; funnel?: string; campaign_path?: string }): CohortRow {
  return {
    cohort_id: `${over.funnel ?? "soulmate"}_${over.campaign_path ?? "unknown"}_${over.cohort_date}`,
    funnel: (over.funnel ?? "soulmate") as CohortRow["funnel"],
    campaign_path: over.campaign_path ?? "unknown",
    trial_users: 100,
    first_subscription_users: 40,
    renewal_users: 12,
    renewal_2_users: 8,
    renewal_3_users: 3,
    gross_revenue: 1000,
    net_revenue: 950,
    amount_refunded: 50,
    revenue_d0: 200, revenue_d7: 600, revenue_d14: 700, revenue_d30: 800, revenue_d60: 900,
    upsell_1_users: 18, upsell_2_users: 2, upsell_3_users: 0, upsell_extra_users: 0,
    funnel_upsell_users: 20, token_buyers: 4, token_purchases: 5,
    token_gross_revenue: 30, token_net_revenue: 25, addon_revenue: 155,
    refund_users: 3, trial_to_first_subscription_cr: 40, refund_rate: 3,
    net_revenue_1m: 800, ltv_1m_per_user: 8, gross_ltv: 10, net_ltv: 9.5,
    ...over,
  } as unknown as CohortRow;
}

function result(cohorts: CohortRow[], durationMs = 5): CohortsSourceResult {
  return { cohorts, source: "legacy", durationMs };
}

describe("compareCohortResults (Phase 7 shadow parity)", () => {
  it("PASS when both sources are identical", () => {
    const rows = [cohort({ cohort_date: "2026-05-01" }), cohort({ cohort_date: "2026-05-02" })];
    const report = compareCohortResults(result(rows), { ...result(rows.map((r) => ({ ...r }))), source: "clickhouse" });
    expect(report.status).toBe("PASS");
    expect(report.matched_rows).toBe(2);
    expect(report.mismatches).toHaveLength(0);
  });

  it("FAILs on an exact-count mismatch", () => {
    const legacy = [cohort({ cohort_date: "2026-05-01", trial_users: 100 })];
    const ch = [cohort({ cohort_date: "2026-05-01", trial_users: 101 })];
    const report = compareCohortResults(result(legacy), { ...result(ch), source: "clickhouse" });
    expect(report.status).toBe("FAIL");
    expect(report.mismatches.some((m) => m.metric === "trial_users" && m.kind === "count")).toBe(true);
  });

  it("tolerates money within max($0.01, 0.01%) but fails beyond it", () => {
    const legacy = [cohort({ cohort_date: "2026-05-01", gross_revenue: 1000 })];
    const within = [cohort({ cohort_date: "2026-05-01", gross_revenue: 1000.01 })];
    const beyond = [cohort({ cohort_date: "2026-05-01", gross_revenue: 1000.5 })];
    expect(compareCohortResults(result(legacy), { ...result(within), source: "clickhouse" }).status).toBe("PASS");
    expect(compareCohortResults(result(legacy), { ...result(beyond), source: "clickhouse" }).status).toBe("FAIL");
  });

  it("uses a 0.01% relative band for large money values", () => {
    const legacy = [cohort({ cohort_date: "2026-05-01", gross_revenue: 1_000_000 })];
    // 0.01% of 1,000,000 = 100 -> a $50 difference is within tolerance.
    const ch = [cohort({ cohort_date: "2026-05-01", gross_revenue: 1_000_050 })];
    expect(compareCohortResults(result(legacy), { ...result(ch), source: "clickhouse" }).status).toBe("PASS");
  });

  it("FAILs a rate difference beyond 0.0001", () => {
    const legacy = [cohort({ cohort_date: "2026-05-01", refund_rate: 3.0 })];
    const ch = [cohort({ cohort_date: "2026-05-01", refund_rate: 3.0002 })];
    const report = compareCohortResults(result(legacy), { ...result(ch), source: "clickhouse" });
    expect(report.status).toBe("FAIL");
    expect(report.mismatches.some((m) => m.metric === "refund_rate" && m.kind === "rate")).toBe(true);
  });

  it("detects missing and extra cohort rows", () => {
    const legacy = [cohort({ cohort_date: "2026-05-01" }), cohort({ cohort_date: "2026-05-02" })];
    const ch = [cohort({ cohort_date: "2026-05-01" }), cohort({ cohort_date: "2026-05-03" })];
    const report = compareCohortResults(result(legacy), { ...result(ch), source: "clickhouse" });
    expect(report.missing_in_clickhouse).toContain("soulmate_unknown_2026-05-02");
    expect(report.missing_in_legacy).toContain("soulmate_unknown_2026-05-03");
    expect(report.status).toBe("FAIL");
  });

  it("reports NOT_APPLICABLE when asked (unreproduced filter)", () => {
    const rows = [cohort({ cohort_date: "2026-05-01" })];
    const report = compareCohortResults(result(rows), { ...result(rows), source: "clickhouse" }, { notApplicable: true, note: "x" });
    expect(report.status).toBe("NOT_APPLICABLE");
  });

  it("carries both source durations and reports no PII in keys", () => {
    const rows = [cohort({ cohort_date: "2026-05-01" })];
    const report = compareCohortResults(result(rows, 12), { ...result(rows, 7), source: "clickhouse" });
    expect(report.legacy_duration_ms).toBe(12);
    expect(report.clickhouse_duration_ms).toBe(7);
    // cohort keys are funnel_campaign_date — never emails or ids.
    expect(report.missing_in_clickhouse.join()).not.toMatch(/@/);
  });
});

function agg(over: Partial<CohortAggregateRow> = {}): CohortAggregateRow {
  return {
    cohort_date: "2026-05-01", funnel: "soulmate", campaign_path: "unknown",
    trial_users: 100, upsell_users: 20, first_subscription_users: 40, renewal_users: 12,
    renewal_users_by_level: { 2: 8, 3: 3 }, refund_users: 3,
    support_users: 8, support_rate: 8,
    active_users: 0, active_subscriptions: 0, cancelled_users: 0, user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
    trial_revenue: 80, upsell_revenue: 120, first_subscription_revenue: 500, renewal_revenue: 250,
    gross_revenue: 1000, net_revenue: 950, amount_refunded: 50,
    revenue_d0: 200, revenue_d7: 600, revenue_d14: 700, revenue_d30: 800, revenue_d60: 900,
    net_revenue_1m: 800, ltv_1m_per_user: 8,
    upsell_1_users: 18, upsell_2_users: 2, upsell_3_users: 0, upsell_extra_users: 0,
    upsell_1_revenue: 120, upsell_2_revenue: 10, upsell_3_revenue: 0, upsell_extra_revenue: 0,
    funnel_upsell_users: 20, funnel_upsell_revenue: 130,
    token_buyers: 4, token_purchases: 5, token_gross_revenue: 30, token_net_revenue: 25, addon_revenue: 155,
    fx_missing_transactions: 0, fx_missing_amount: 0,
    dedup: { active_user_hashes: [], active_subscription_hashes: [], refunded_user_hashes: [], cancelled_user_hashes: [], user_cancelled_user_hashes: [], auto_cancelled_user_hashes: [], cancelled_active_user_hashes: [], token_buyer_hashes: [] },
    ...over,
  };
}

describe("mapAggregateToCohortRow", () => {
  it("derives rates/LTVs with the analytics.ts formulas", () => {
    const row = mapAggregateToCohortRow(agg());
    expect(row.cohort_id).toBe("soulmate_unknown_2026-05-01");
    expect(row.trial_to_first_subscription_cr).toBeCloseTo(40, 6); // 40/100*100
    expect(row.refund_rate).toBeCloseTo(3, 6);
    expect(row.support_users).toBe(8);
    expect(row.support_rate).toBe(8);
    expect(row.gross_ltv).toBe(10); // 1000/100
    expect(row.net_ltv).toBe(9.5);
    expect(row.ltv_1m_per_user).toBe(8);
    expect(row.renewal_2_users).toBe(8);
    expect(row.first_subscription_to_renewal_2_cr).toBeCloseTo(20, 6); // 8/40*100
    expect(row.addon_revenue).toBe(155);
    // deferred subscription metrics
    expect(row.active_users).toBe(0);
    expect(row.plan_breakdown).toEqual([]);
  });

  it("guards divide-by-zero for empty cohorts", () => {
    const row = mapAggregateToCohortRow(agg({ trial_users: 0, first_subscription_users: 0 }));
    expect(row.gross_ltv).toBe(0);
    expect(row.trial_to_first_subscription_cr).toBe(0);
  });

  it("emits synthetic id-sets sized to counts so cross-cohort totals dedup correctly", () => {
    const a = mapAggregateToCohortRow(agg({ cohort_date: "2026-05-01", refund_users: 3, token_buyers: 4 }));
    const b = mapAggregateToCohortRow(agg({ cohort_date: "2026-05-02", refund_users: 2, token_buyers: 1 }));
    expect(a.refunded_user_ids).toHaveLength(3);
    expect(a.token_buyer_user_ids).toHaveLength(4);
    // Each user is in exactly one cohort, so the page's cross-cohort dedup
    // (new Set(flatMap)) must equal the additive sum.
    const refundTotal = new Set([...a.refunded_user_ids, ...b.refunded_user_ids]).size;
    const buyerTotal = new Set([...(a.token_buyer_user_ids ?? []), ...(b.token_buyer_user_ids ?? [])]).size;
    expect(refundTotal).toBe(5); // 3 + 2
    expect(buyerTotal).toBe(5); // 4 + 1
    // synthetic ids carry no real user identity
    expect(a.refunded_user_ids.every((id) => id.startsWith(a.cohort_id))).toBe(true);
  });
});

describe("filtersFullyReproduced", () => {
  const fa = (over: Partial<CohortResponse["diagnostics"]["filters_applied"]>): CohortResponse["diagnostics"] => ({
    transactions_scanned: 0, users_scanned: 0, missing_identity: 0, missing_fx: 0, unknown_products: 0,
    subscription_data_status: "empty_source",
    filters_applied: { date_range: true, funnel: true, campaign_path: true, refund_status: true, media_buyer: true, currency: true, country: false, card_type: false, campaign_id: false, traffic_source: false, price_plan: false, ...over },
  });

  it("is true when no unreproduced filter is active", () => {
    expect(filtersFullyReproduced(fa({}), { country: false, card_type: false, campaign_id: false, traffic_source: false })).toBe(true);
  });

  it("is false when an active filter is not reproduced server-side", () => {
    expect(filtersFullyReproduced(fa({}), { country: true, card_type: false, campaign_id: false })).toBe(false);
    expect(filtersFullyReproduced(fa({}), { country: false, card_type: false, campaign_id: true })).toBe(false);
    expect(filtersFullyReproduced(fa({}), { country: false, card_type: false, campaign_id: false, traffic_source: true })).toBe(false);
    expect(filtersFullyReproduced(fa({}), { country: false, card_type: false, campaign_id: false, price_plan: true })).toBe(false);
  });

  it("is true when an unreproduced dimension is reproduced", () => {
    expect(filtersFullyReproduced(fa({ country: true, campaign_id: true, card_type: true, traffic_source: true, price_plan: true }), { country: true, card_type: true, campaign_id: true, traffic_source: true, price_plan: true })).toBe(true);
  });

  it("is false when diagnostics are missing", () => {
    expect(filtersFullyReproduced(undefined, { country: false, card_type: false, campaign_id: false })).toBe(false);
  });

  it("reports the exact unsupported active filters and reason", () => {
    const result = cohortFilterReproductionStatus(fa({}), { country: true, card_type: true, campaign_id: false, traffic_source: true, price_plan: true });
    expect(result.applicable).toBe(false);
    expect(result.unsupportedFilters).toEqual(["country", "card_type", "traffic_source", "price_plan"]);
    expect(result.reason).toContain("country, card_type, traffic_source, price_plan");
  });
});
