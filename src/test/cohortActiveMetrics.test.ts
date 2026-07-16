import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import { computeCohortReportTotals } from "@/services/cohortReporting";
import { isSubscriptionActiveNow, canonicalSubscriptionIdentity } from "@/services/subscriptionTransform";
import { subscriptionSyncCompletenessWarning, type FunnelFoxSubscriptionsSyncState } from "@/services/funnelfoxSubscriptionsSync";
import type { Transaction, TransactionType } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";

// Fixed "now" so every active-metric assertion is deterministic.
const NOW = Date.parse("2026-07-10T12:00:00Z");
const future = "2026-08-01T00:00:00Z"; // > NOW
const past = "2026-07-01T00:00:00Z"; // < NOW

function tx(userId: string, overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-trial`,
    user_id: userId,
    email: overrides.email ?? `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-07-01T00:00:00Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: (overrides.transaction_type ?? "trial") as TransactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: "campaign_1",
    classification_reason: "test",
    ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionClean> = {}): SubscriptionClean {
  return {
    subscription_id: overrides.subscription_id ?? "sub_1",
    psp_id: overrides.psp_id ?? "psp_1",
    email: overrides.email ?? "u1@example.com",
    profile_id: overrides.profile_id ?? "profile_1",
    status: overrides.status ?? "active",
    renews: overrides.renews ?? true,
    is_cancelled: overrides.is_cancelled ?? false,
    cancelled_at: overrides.cancelled_at ?? null,
    cancellation_source: null,
    cancellation_reason: null,
    days_to_cancel: null,
    hours_before_period_end: null,
    cancellation_timing_bucket: "not_cancelled",
    cancellation_type: "not_cancelled",
    is_active_now: overrides.is_active_now ?? true,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-01T00:00:00Z",
    period_starts_at: "2026-07-01T00:00:00Z",
    period_ends_at: overrides.period_ends_at ?? future,
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

const activeUsers = (subs: SubscriptionClean[], txs = [tx("u1")]) =>
  computeCohorts(txs, subs, { now: NOW })[0]?.active_users ?? 0;
const activeSubs = (subs: SubscriptionClean[], txs = [tx("u1")]) =>
  computeCohorts(txs, subs, { now: NOW })[0]?.active_subscriptions ?? 0;

describe("isSubscriptionActiveNow (single source of truth)", () => {
  it("1. active + future period + renews=true → active", () => {
    expect(isSubscriptionActiveNow({ status: "active", renews: true, period_ends_at: future }, NOW)).toBe(true);
    expect(isSubscriptionActiveNow({ status: "trialing", renews: true, period_ends_at: future }, NOW)).toBe(true);
  });

  it("2. active + future period + renews=false → not active", () => {
    expect(isSubscriptionActiveNow({ status: "active", renews: false, period_ends_at: future }, NOW)).toBe(false);
  });

  it("3. cancelled + future period + renews=false → not active", () => {
    expect(isSubscriptionActiveNow({ status: "cancelled", renews: false, period_ends_at: future }, NOW)).toBe(false);
    // even cancelled with renews true (degenerate) is excluded by the cancel token:
    expect(isSubscriptionActiveNow({ status: "cancelled", renews: true, period_ends_at: future }, NOW)).toBe(false);
  });

  it("4. expired status → not active", () => {
    expect(isSubscriptionActiveNow({ status: "expired", renews: true, period_ends_at: future }, NOW)).toBe(false);
  });

  it("5. future period but failed/unpaid → not active", () => {
    expect(isSubscriptionActiveNow({ status: "unpaid", renews: true, period_ends_at: future }, NOW)).toBe(false);
    expect(isSubscriptionActiveNow({ status: "failed", renews: true, period_ends_at: future }, NOW)).toBe(false);
  });

  it("6. past period → not active", () => {
    expect(isSubscriptionActiveNow({ status: "active", renews: true, period_ends_at: past }, NOW)).toBe(false);
  });

  it("12. invalid / empty period_ends_at → not active", () => {
    expect(isSubscriptionActiveNow({ status: "active", renews: true, period_ends_at: "" }, NOW)).toBe(false);
    expect(isSubscriptionActiveNow({ status: "active", renews: true, period_ends_at: "not-a-date" }, NOW)).toBe(false);
  });
});

describe("cohort active user / subscription counts", () => {
  it("7. one user, one active subscription → users 1 / subs 1", () => {
    const subs = [sub({ subscription_id: "s1", email: "u1@example.com" })];
    expect(activeUsers(subs)).toBe(1);
    expect(activeSubs(subs)).toBe(1);
  });

  it("8. one user, two active subscriptions → users 1 / subs 2", () => {
    const subs = [
      sub({ subscription_id: "s1", email: "u1@example.com" }),
      sub({ subscription_id: "s2", email: "u1@example.com" }),
    ];
    expect(activeUsers(subs)).toBe(1);
    expect(activeSubs(subs)).toBe(2);
  });

  it("9. two users, two active subscriptions → users 2 / subs 2", () => {
    const txs = [tx("u1"), tx("u2", { email: "u2@example.com" })];
    const subs = [
      sub({ subscription_id: "s1", email: "u1@example.com" }),
      sub({ subscription_id: "s2", email: "u2@example.com" }),
    ];
    expect(activeUsers(subs, txs)).toBe(2);
    expect(activeSubs(subs, txs)).toBe(2);
  });

  it("10. duplicate subscription_id does not inflate", () => {
    const subs = [
      sub({ subscription_id: "s1", email: "u1@example.com" }),
      sub({ subscription_id: "s1", email: "u1@example.com" }), // resync duplicate
    ];
    expect(activeUsers(subs)).toBe(1);
    expect(activeSubs(subs)).toBe(1);
  });

  it("11. email fallback matches user by normalized email", () => {
    const txs = [tx("u1", { email: "Mixed.Case@Example.com " })];
    const subs = [sub({ subscription_id: "s1", email: "mixed.case@example.com" })];
    expect(activeUsers(subs, txs)).toBe(1);
    expect(activeSubs(subs, txs)).toBe(1);
  });

  it("12b. invalid period_ends_at is safely excluded at cohort level", () => {
    const subs = [sub({ subscription_id: "s1", email: "u1@example.com", period_ends_at: "not-a-date" })];
    expect(activeUsers(subs)).toBe(0);
    expect(activeSubs(subs)).toBe(0);
  });

  it("13. cohort attribution uses the first successful trial", () => {
    // u1's first successful trial is on soulmate-sketch; a later renewal doesn't move the cohort.
    const txs = [
      tx("u1", { transaction_id: "t1", event_time: "2026-07-01T00:00:00Z" }),
      tx("u1", { transaction_id: "t2", transaction_type: "renewal", event_time: "2026-07-08T00:00:00Z", amount_usd: 29.99 }),
    ];
    const [cohort] = computeCohorts(txs, [sub({ email: "u1@example.com" })], { now: NOW });
    expect(cohort.cohort_date).toBe("2026-07-01");
    expect(cohort.active_users).toBe(1);
    expect(cohort.active_subscriptions).toBe(1);
  });

  it("mixed statuses: only renewing, in-period, non-inactive subs count", () => {
    const txs = [tx("u1"), tx("u2", { email: "u2@example.com" }), tx("u3", { email: "u3@example.com" })];
    const subs = [
      sub({ subscription_id: "s1", email: "u1@example.com", status: "active", renews: true, period_ends_at: future }), // active
      sub({ subscription_id: "s2", email: "u2@example.com", status: "cancelled", renews: false, is_cancelled: true, period_ends_at: future }), // cancelled-in-period → NOT active
      sub({ subscription_id: "s3", email: "u3@example.com", status: "unpaid", renews: true, period_ends_at: future }), // unpaid → NOT active
    ];
    const [cohort] = computeCohorts(txs, subs, { now: NOW });
    expect(cohort.active_users).toBe(1);
    expect(cohort.active_subscriptions).toBe(1);
  });
});

describe("14. total row dedups users and subscriptions", () => {
  it("totals count unique active user identities and unique active subscription_ids", () => {
    // Two cohorts (different dates); each has one active user with one active sub.
    const txs = [
      tx("u1", { event_time: "2026-06-24T00:00:00Z" }),
      tx("u2", { email: "u2@example.com", event_time: "2026-06-25T00:00:00Z" }),
    ];
    const subs = [
      sub({ subscription_id: "s1", email: "u1@example.com" }),
      sub({ subscription_id: "s2", email: "u2@example.com" }),
    ];
    const cohorts = computeCohorts(txs, subs, { now: NOW });
    expect(cohorts).toHaveLength(2);
    const totals = computeCohortReportTotals(cohorts);
    expect(totals.totalActiveUsers).toBe(2);
    expect(totals.totalActiveSubscriptions).toBe(2);
  });
});

describe("15. partial FunnelFox sync exposes a warning", () => {
  const state = (over: Partial<FunnelFoxSubscriptionsSyncState>): FunnelFoxSubscriptionsSyncState => ({
    auth_user_id: "u", last_list_cursor: null, current_stage: null,
    list_completed: false, details_completed: false, profiles_completed: false, finalize_completed: false,
    subscriptions_scanned_total: 0, subscriptions_total_reported_by_api: null,
    last_status: null, last_error: null, stopped_reason: null,
    started_at: null, finished_at: null, duration_ms: null, last_full_sync_at: null, stats: null, updated_at: null,
    ...over,
  });
  it("warns on partial status, stays silent on completed / unknown", () => {
    expect(subscriptionSyncCompletenessWarning(state({ last_status: "partial" }))).toMatch(/incomplete because FunnelFox sync is partial/);
    expect(subscriptionSyncCompletenessWarning(state({ last_status: "completed" }))).toBeNull();
    expect(subscriptionSyncCompletenessWarning(null)).toBeNull();
  });
});

describe("16. screenshot-range reconciliation fixture (2026-06-24 → 2026-07-10)", () => {
  it("reproduces the agreed active metrics: cancelled-in-period and trialing edge cases", () => {
    // Mirrors the real 2026-06-24 diagnostic sample: 1 active + 2 in-period-but-not-renewing
    // (a cancelled and a status=active&renews=false) + 2 unpaid. Agreed = 1 active user / 1 active sub.
    const txs = ["a", "b", "c", "d", "e"].map((u) => tx(u, { email: `${u}@x.com`, event_time: "2026-06-24T00:00:00Z" }));
    const subs = [
      sub({ subscription_id: "sa", email: "a@x.com", status: "active", renews: true, period_ends_at: future }), // active
      sub({ subscription_id: "sb", email: "b@x.com", status: "cancelled", renews: false, is_cancelled: true, is_active_now: true, period_ends_at: future }), // old code counted this
      sub({ subscription_id: "sc", email: "c@x.com", status: "active", renews: false, is_active_now: true, period_ends_at: future }), // old code counted this
      sub({ subscription_id: "sd", email: "d@x.com", status: "unpaid", renews: true, period_ends_at: past }),
      sub({ subscription_id: "se", email: "e@x.com", status: "unpaid", renews: true, period_ends_at: past }),
    ];
    const [cohort] = computeCohorts(txs, subs, { now: NOW });
    expect(cohort.trial_users).toBe(5);
    // Fixed: only the genuinely active+renewing sub counts (was 3 users / mixed before).
    expect(cohort.active_users).toBe(1);
    expect(cohort.active_subscriptions).toBe(1);
  });
});

describe("canonical identity", () => {
  it("prefers email, then profile_id, then psp id", () => {
    expect(canonicalSubscriptionIdentity({ email: "A@B.com", profile_id: "p", psp_id: "x" })).toBe("email:a@b.com");
    expect(canonicalSubscriptionIdentity({ email: null, profile_id: "p1", psp_id: "x" })).toBe("profile:p1");
    expect(canonicalSubscriptionIdentity({ email: "", profile_id: "", psp_id: "psp9" })).toBe("psp:psp9");
    expect(canonicalSubscriptionIdentity({ email: null, profile_id: null, psp_id: null })).toBeNull();
  });
});
