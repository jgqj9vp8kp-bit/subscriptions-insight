import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import type { Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    transaction_id: "tx",
    user_id: "user",
    email: "user@example.com",
    event_time: "2026-04-01T00:00:00Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "past_life",
    campaign_path: "campaign",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: "campaign_1",
    classification_reason: "test",
    cohort_date: "2026-04-01",
    cohort_id: "campaign_2026-04-01",
    transaction_day: 0,
    ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionClean>): SubscriptionClean {
  return {
    subscription_id: "sub",
    psp_id: "psp",
    email: "user@example.com",
    profile_id: "profile",
    status: "cancelled",
    renews: false,
    is_cancelled: true,
    cancelled_at: "2026-04-06T00:00:00Z",
    cancellation_source: "api_status_cancelled",
    cancellation_reason: null,
    days_to_cancel: 5,
    hours_before_period_end: 24,
    cancellation_timing_bucket: "before_renewal_48h",
    cancellation_type: "cancelled_unknown_reason",
    is_active_now: true,
    created_at: "2026-04-01T00:00:00Z",
    updated_at: "2026-04-06T00:00:00Z",
    period_starts_at: "2026-04-01T00:00:00Z",
    period_ends_at: "2026-04-07T00:00:00Z",
    billing_interval: "week",
    billing_interval_count: 1,
    price_usd: 29.99,
    currency: "USD",
    payment_provider: "stripe",
    product_name: "Plan",
    product_id: "product",
    funnel_title: "Funnel",
    funnel_alias: "funnel",
    session_id: "session",
    raw: {},
    ...overrides,
  };
}

describe("cohort cancellation classification", () => {
  it("classifies cancelled before period end without failed transaction as user cancelled", () => {
    const [cohort] = computeCohorts([tx({})], [sub({})]);

    expect(cohort.user_cancelled_users).toBe(1);
    expect(cohort.auto_cancelled_users).toBe(0);
  });

  it("classifies failed transaction within 48h before cancellation as auto cancelled", () => {
    const [cohort] = computeCohorts(
      [
        tx({}),
        tx({
          transaction_id: "failed_tx",
          event_time: "2026-04-05T12:00:00Z",
          status: "failed",
          transaction_type: "failed_payment",
          classification_reason: "failed Palmer status",
        }),
      ],
      [sub({})],
    );

    expect(cohort.user_cancelled_users).toBe(0);
    expect(cohort.auto_cancelled_users).toBe(1);
  });

  it("classifies cancellation after period end as auto cancelled", () => {
    const [cohort] = computeCohorts(
      [tx({})],
      [
        sub({
          cancelled_at: "2026-04-08T00:00:00Z",
          period_ends_at: "2026-04-07T00:00:00Z",
          hours_before_period_end: -24,
        }),
      ],
    );

    expect(cohort.user_cancelled_users).toBe(0);
    expect(cohort.auto_cancelled_users).toBe(1);
  });
});
