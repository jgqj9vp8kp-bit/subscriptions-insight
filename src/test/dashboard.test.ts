import { describe, expect, it } from "vitest";
import {
  buildCancellationBreakdown,
  buildCancellationsByDay,
  buildDashboardKpis,
  buildFunnelChart,
  buildRefundTrend,
  buildRefundsByDay,
  buildRevenueTrend,
  buildRoasTrend,
  buildTrialsByDay,
  buildTrialsUpsellsByDay,
  buildUpsellsByDay,
  type DashboardCohort,
} from "@/services/dashboard";
import type { Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";

function cohort(overrides: Partial<DashboardCohort>): DashboardCohort {
  return {
    cohort_id: "cohort",
    cohort_date: "2026-03-18",
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    trial_users: 0,
    active_users: 0,
    active_rate: 0,
    active_subscriptions: 0,
    active_subscriptions_rate: 0,
    active_subscription_user_ids: [],
    cancelled_users: 0,
    cancellation_rate: 0,
    user_cancelled_users: 0,
    user_cancel_rate: 0,
    auto_cancelled_users: 0,
    auto_cancel_rate: 0,
    cancelled_active_users: 0,
    active_user_ids: [],
    cancelled_user_ids: [],
    user_cancelled_user_ids: [],
    auto_cancelled_user_ids: [],
    cancelled_active_user_ids: [],
    upsell_users: 0,
    first_subscription_users: 0,
    renewal_2_users: 0,
    renewal_3_users: 0,
    renewal_4_users: 0,
    renewal_5_users: 0,
    renewal_6_users: 0,
    renewal_users: 0,
    refund_users: 0,
    refunded_user_ids: [],
    plan_breakdown: [],
    trial_revenue: 0,
    upsell_revenue: 0,
    first_subscription_revenue: 0,
    renewal_revenue: 0,
    amount_refunded: 0,
    refund_rate: 0,
    gross_revenue: 0,
    net_revenue: 0,
    gross_ltv: 0,
    net_ltv: 0,
    trial_to_upsell_cr: 0,
    trial_to_first_subscription_cr: 0,
    first_subscription_to_renewal_2_cr: 0,
    renewal_2_to_renewal_3_cr: 0,
    revenue_d0: 0,
    revenue_d7: 0,
    revenue_d14: 0,
    revenue_d30: 0,
    revenue_d60: 0,
    revenue_d37: 0,
    revenue_d67: 0,
    revenue_total: 0,
    ltv_d7: 0,
    ltv_d14: 0,
    ltv_d30: 0,
    ...overrides,
  };
}

function kpiValue(kpis: ReturnType<typeof buildDashboardKpis>, label: string): number | null {
  const row = kpis.find((kpi) => kpi.label === label);
  if (!row) throw new Error(`Missing KPI ${label}`);
  return row.value;
}

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? "tx",
    user_id: overrides.user_id ?? "user",
    email: overrides.email ?? "user@example.com",
    event_time: overrides.event_time ?? "2026-03-18T10:00:00Z",
    amount_usd: overrides.amount_usd ?? 0,
    gross_amount_usd: overrides.gross_amount_usd ?? overrides.amount_usd ?? 0,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? overrides.amount_usd ?? 0,
    is_refunded: overrides.is_refunded ?? false,
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? "success",
    transaction_type: overrides.transaction_type ?? "trial",
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "soulmate-reading",
    product: overrides.product ?? "Product",
    traffic_source: overrides.traffic_source ?? "facebook",
    campaign_id: overrides.campaign_id ?? "campaign",
    classification_reason: overrides.classification_reason ?? "",
    billing_reason: overrides.billing_reason,
    cohort_date: overrides.cohort_date,
    cohort_id: overrides.cohort_id,
    transaction_day: overrides.transaction_day,
  };
}

function subscription(overrides: Partial<SubscriptionClean>): SubscriptionClean {
  return {
    subscription_id: overrides.subscription_id ?? "sub",
    psp_id: overrides.psp_id ?? "psp",
    email: overrides.email ?? "user@example.com",
    profile_id: overrides.profile_id ?? "profile",
    status: overrides.status ?? "cancelled",
    renews: overrides.renews ?? false,
    is_cancelled: overrides.is_cancelled ?? true,
    cancelled_at: overrides.cancelled_at ?? "2026-03-18T10:00:00Z",
    cancellation_source: overrides.cancellation_source ?? "api_status_cancelled",
    cancellation_reason: overrides.cancellation_reason ?? null,
    days_to_cancel: overrides.days_to_cancel ?? null,
    hours_before_period_end: overrides.hours_before_period_end ?? null,
    cancellation_timing_bucket: overrides.cancellation_timing_bucket ?? "later",
    cancellation_type: overrides.cancellation_type ?? "cancelled_unknown_reason",
    is_active_now: overrides.is_active_now ?? false,
    created_at: overrides.created_at ?? "2026-03-01T10:00:00Z",
    updated_at: overrides.updated_at ?? "2026-03-18T10:00:00Z",
    period_starts_at: overrides.period_starts_at ?? "2026-03-01T10:00:00Z",
    period_ends_at: overrides.period_ends_at ?? "2026-03-20T10:00:00Z",
    billing_interval: overrides.billing_interval ?? "month",
    billing_interval_count: overrides.billing_interval_count ?? 1,
    price_usd: overrides.price_usd ?? 29.99,
    currency: overrides.currency ?? "USD",
    payment_provider: overrides.payment_provider ?? "stripe",
    product_name: overrides.product_name ?? "Product",
    product_id: overrides.product_id ?? "product",
    funnel_title: overrides.funnel_title ?? "Funnel",
    funnel_alias: overrides.funnel_alias ?? "soulmate",
    session_id: overrides.session_id ?? "session",
    raw: overrides.raw ?? {},
  };
}

describe("dashboard data builders", () => {
  const cohorts = [
    cohort({
      cohort_id: "a",
      cohort_date: "2026-03-18",
      trial_users: 100,
      upsell_users: 30,
      first_subscription_users: 50,
      active_subscriptions: 20,
      active_subscription_user_ids: ["a1", "a2"],
      cancelled_users: 10,
      cancelled_user_ids: ["c1", "c2", "c3"],
      user_cancelled_users: 4,
      user_cancelled_user_ids: ["u1", "u2"],
      auto_cancelled_users: 6,
      auto_cancelled_user_ids: ["a1"],
      cancelled_active_users: 3,
      cancelled_active_user_ids: ["ca1"],
      gross_revenue: 1000,
      amount_refunded: 100,
      net_revenue: 900,
      revenue_d7: 300,
      revenue_d30: 600,
      revenue_d60: 750,
      traffic_spend: 300,
    }),
    cohort({
      cohort_id: "b",
      cohort_date: "2026-03-19",
      trial_users: 50,
      upsell_users: 10,
      first_subscription_users: 25,
      active_subscriptions: 10,
      active_subscription_user_ids: ["a2", "a3"],
      cancelled_users: 5,
      cancelled_user_ids: ["c3", "c4"],
      user_cancelled_users: 1,
      user_cancelled_user_ids: ["u2", "u3"],
      auto_cancelled_users: 4,
      auto_cancelled_user_ids: ["a1", "a4"],
      cancelled_active_users: 1,
      cancelled_active_user_ids: ["ca2"],
      gross_revenue: 500,
      amount_refunded: 50,
      net_revenue: 450,
      revenue_d7: 150,
      revenue_d30: 300,
      revenue_d60: 375,
      traffic_spend: 150,
    }),
  ];

  it("builds KPI totals from cohort revenue fields", () => {
    const kpis = buildDashboardKpis(cohorts);

    expect(kpiValue(kpis, "Gross Rev")).toBe(1500);
    expect(kpiValue(kpis, "Net Rev")).toBe(1350);
    expect(kpiValue(kpis, "Trial Users")).toBe(150);
    expect(kpiValue(kpis, "First Sub")).toBe(75);
  });

  it("builds revenue and spend trend rows", () => {
    const kpis = buildDashboardKpis(cohorts);
    const trend = buildRevenueTrend(cohorts);

    expect(kpiValue(kpis, "Spend")).toBe(450);
    expect(trend).toEqual([
      { date: "2026-03-18", gross_rev: 1000, net_rev: 900, spend: 300 },
      { date: "2026-03-19", gross_rev: 500, net_rev: 450, spend: 150 },
    ]);
  });

  it("calculates ROAS as revenue divided by spend", () => {
    const kpis = buildDashboardKpis(cohorts);
    const trend = buildRoasTrend(cohorts);

    expect(kpiValue(kpis, "ROAS 1M")).toBe(2);
    expect(trend).toEqual([
      { date: "2026-03-18", roas_d7: 1, roas_1m: 2, roas_2m: 2.5 },
      { date: "2026-03-19", roas_d7: 1, roas_1m: 2, roas_2m: 2.5 },
    ]);
  });

  it("calculates cancellation rate from cancelled users divided by first subscriptions", () => {
    const kpis = buildDashboardKpis(cohorts);
    const breakdown = buildCancellationBreakdown(cohorts);

    expect(kpiValue(kpis, "Cancellation Rate")).toBeCloseTo((4 / 75) * 100);
    expect(kpiValue(kpis, "User Cancelled")).toBe(3);
    expect(kpiValue(kpis, "Auto Cancelled")).toBe(2);
    expect(breakdown).toEqual([
      { label: "User Cancelled", value: 3 },
      { label: "Auto Cancelled", value: 2 },
      { label: "Active Subs", value: 3 },
      { label: "Cancelled Active", value: 2 },
    ]);
  });

  it("calculates refund rate from refund amount divided by gross revenue", () => {
    const kpis = buildDashboardKpis(cohorts);
    const refundTrend = buildRefundTrend(cohorts);

    expect(kpiValue(kpis, "Refund Rate")).toBe(10);
    expect(refundTrend).toEqual([
      { date: "2026-03-18", refund_amount: 100, refund_rate: 10 },
      { date: "2026-03-19", refund_amount: 50, refund_rate: 10 },
    ]);
  });

  it("builds funnel chart data from aggregated cohort counts", () => {
    expect(buildFunnelChart(cohorts)).toEqual([
      { label: "Trial Users", value: 150 },
      { label: "Upsell Users", value: 40 },
      { label: "First Sub Users", value: 75 },
      { label: "Active Subs", value: 3 },
    ]);
  });

  it("returns null ROAS when spend denominator is zero", () => {
    expect(buildRoasTrend([cohort({ cohort_date: "2026-03-18", revenue_d30: 100, traffic_spend: 0 })])).toEqual([
      { date: "2026-03-18", roas_d7: null, roas_1m: null, roas_2m: null },
    ]);
    expect(kpiValue(buildDashboardKpis([cohort({ revenue_d30: 100, traffic_spend: 0 })]), "ROAS 1M")).toBeNull();
  });

  it("counts unique first successful non-upsell trial users by real event date", () => {
    const rows = [
      transaction({ transaction_id: "u1-t1", user_id: "u1", event_time: "2026-03-18T09:00:00Z", transaction_type: "trial" }),
      transaction({ transaction_id: "u1-sub", user_id: "u1", event_time: "2026-03-19T09:00:00Z", transaction_type: "first_subscription" }),
      transaction({ transaction_id: "u2-up", user_id: "u2", event_time: "2026-03-18T10:00:00Z", transaction_type: "upsell" }),
      transaction({ transaction_id: "u2-t1", user_id: "u2", event_time: "2026-03-20T10:00:00Z", transaction_type: "trial" }),
      transaction({ transaction_id: "u3-failed", user_id: "u3", event_time: "2026-03-18T11:00:00Z", transaction_type: "trial", status: "failed" }),
    ];

    expect(buildTrialsByDay(rows)).toEqual([
      { date: "2026-03-18", trial_users: 1 },
      { date: "2026-03-20", trial_users: 1 },
    ]);
  });

  it("groups successful upsells by real event date", () => {
    const rows = [
      transaction({ transaction_id: "a", user_id: "u1", event_time: "2026-03-18T09:00:00Z", transaction_type: "upsell", gross_amount_usd: 14.98 }),
      transaction({ transaction_id: "b", user_id: "u1", event_time: "2026-03-18T10:00:00Z", transaction_type: "upsell", gross_amount_usd: 19.99 }),
      transaction({ transaction_id: "c", user_id: "u2", event_time: "2026-03-18T11:00:00Z", transaction_type: "upsell", gross_amount_usd: 14.98 }),
      transaction({ transaction_id: "d", user_id: "u3", event_time: "2026-03-18T12:00:00Z", transaction_type: "upsell", gross_amount_usd: 14.98, status: "failed" }),
    ];

    expect(buildUpsellsByDay(rows)).toEqual([
      { date: "2026-03-18", upsell_users: 2, upsell_revenue: 49.95 },
    ]);
  });

  it("builds trial composition rows with upsells as a subset of trial users", () => {
    const rows = [
      transaction({ transaction_id: "u1-trial", user_id: "u1", event_time: "2026-03-18T09:00:00Z", transaction_type: "trial" }),
      transaction({ transaction_id: "u1-upsell", user_id: "u1", event_time: "2026-03-18T09:05:00Z", transaction_type: "upsell" }),
      transaction({ transaction_id: "u1-upsell-2", user_id: "u1", event_time: "2026-03-18T09:06:00Z", transaction_type: "upsell" }),
      transaction({ transaction_id: "u2-trial", user_id: "u2", event_time: "2026-03-18T10:00:00Z", transaction_type: "trial" }),
      transaction({ transaction_id: "u3-trial", user_id: "u3", event_time: "2026-03-19T10:00:00Z", transaction_type: "trial" }),
      transaction({ transaction_id: "u3-upsell-next-day", user_id: "u3", event_time: "2026-03-20T10:00:00Z", transaction_type: "upsell" }),
      transaction({ transaction_id: "u4-upsell-only", user_id: "u4", event_time: "2026-03-18T10:00:00Z", transaction_type: "upsell" }),
    ];

    expect(buildTrialsUpsellsByDay(rows)).toEqual([
      {
        date: "2026-03-18",
        trial_users: 2,
        upsell_users: 1,
        non_upsell_trial_users: 1,
        upsell_rate: 50,
      },
      {
        date: "2026-03-19",
        trial_users: 1,
        upsell_users: 0,
        non_upsell_trial_users: 1,
        upsell_rate: 0,
      },
    ]);
  });

  it("aggregates refund events and refund amounts by real event date", () => {
    const rows = [
      transaction({ transaction_id: "refund-a", event_time: "2026-03-18T09:00:00Z", refund_amount_usd: 20.99, is_refunded: true }),
      transaction({ transaction_id: "refund-b", event_time: "2026-03-18T10:00:00Z", transaction_type: "refund", gross_amount_usd: -5 }),
      transaction({ transaction_id: "failed", event_time: "2026-03-18T11:00:00Z", status: "failed", refund_amount_usd: 0 }),
    ];

    expect(buildRefundsByDay(rows)).toEqual([
      { date: "2026-03-18", refund_count: 2, refund_amount: 25.99 },
    ]);
  });

  it("groups subscription cancellations by cancelled_at day and classification", () => {
    const rows = [
      subscription({ subscription_id: "user", cancelled_at: "2026-03-18T09:00:00Z", hours_before_period_end: 12 }),
      subscription({ subscription_id: "auto", cancelled_at: "2026-03-18T10:00:00Z", hours_before_period_end: -1 }),
      subscription({ subscription_id: "manual", cancelled_at: "2026-03-19T10:00:00Z", cancellation_type: "user_or_manual_cancelled" }),
      subscription({ subscription_id: "active", is_cancelled: false, cancelled_at: null, cancellation_type: "not_cancelled" }),
    ];

    expect(buildCancellationsByDay(rows)).toEqual([
      { date: "2026-03-18", user_cancelled: 1, auto_cancelled: 1, total_cancelled: 2 },
      { date: "2026-03-19", user_cancelled: 1, auto_cancelled: 0, total_cancelled: 1 },
    ]);
  });
});
