import { describe, expect, it } from "vitest";
import {
  computeCohorts,
  subscriptionLevelByPaymentForUser,
  subscriptionPaymentSequenceForUser,
} from "@/services/analytics";
import {
  hydrateWarehouseTransactionsForAnalytics,
  normalizeForWarehouse,
} from "@/services/transactionWarehouse";
import type { Transaction, TransactionStatus, TransactionType } from "@/services/types";

function tx(
  userId: string,
  transactionType: TransactionType,
  eventTime: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : transactionType === "upsell" ? 14.98 : 9.99);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${eventTime}`,
    user_id: userId,
    email: overrides.email ?? `${userId}@example.com`,
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    is_refunded: overrides.is_refunded ?? false,
    currency: "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    product: "Product",
    traffic_source: "facebook",
    campaign_id: "campaign",
    classification_reason: "",
    cohort_date: overrides.cohort_date,
    cohort_id: overrides.cohort_id,
    transaction_day: overrides.transaction_day,
  };
}

function cohortFor(rows: Transaction[]) {
  const cohort = computeCohorts(rows)[0];
  if (!cohort) throw new Error("Expected a cohort");
  return cohort;
}

describe("canonical subscription-payment sequence", () => {
  it("orders successful subscription payments by timestamp (First Sub, Renewal 2, 3, N)", () => {
    const rows = [
      tx("u", "trial", "2026-03-01T00:00:00Z"),
      tx("u", "upsell", "2026-03-01T01:00:00Z"),
      tx("u", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("u", "renewal_2", "2026-03-15T00:00:00Z"),
      tx("u", "renewal_3", "2026-03-22T00:00:00Z"),
      tx("u", "renewal", "2026-03-29T00:00:00Z"),
    ];

    const sequence = subscriptionPaymentSequenceForUser(rows);
    expect(sequence.map((t) => t.transaction_type)).toEqual([
      "first_subscription",
      "renewal_2",
      "renewal_3",
      "renewal",
    ]);
    const levels = subscriptionLevelByPaymentForUser(rows);
    expect(sequence.map((t) => levels.get(t))).toEqual([1, 2, 3, 4]);
  });

  it("levels by timestamp, NOT by transaction_type (a renewal-typed first payment is level 1)", () => {
    // A renewal-typed payment occurs BEFORE the first_subscription-typed payment.
    const rows = [
      tx("u", "trial", "2026-03-01T00:00:00Z"),
      tx("u", "renewal", "2026-03-08T00:00:00Z"),
      tx("u", "first_subscription", "2026-03-15T00:00:00Z"),
    ];
    const sequence = subscriptionPaymentSequenceForUser(rows);
    const levels = subscriptionLevelByPaymentForUser(rows);
    expect(sequence.map((t) => `${t.transaction_type}:${levels.get(t)}`)).toEqual([
      "renewal:1",
      "first_subscription:2",
    ]);
  });

  it("excludes failed subscription payments from the sequence", () => {
    const rows = [
      tx("u", "trial", "2026-03-01T00:00:00Z"),
      tx("u", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("u", "renewal", "2026-03-15T00:00:00Z", { status: "failed" }),
      tx("u", "renewal", "2026-03-22T00:00:00Z"),
    ];
    expect(subscriptionPaymentSequenceForUser(rows).map((t) => t.event_time)).toEqual([
      "2026-03-08T00:00:00Z",
      "2026-03-22T00:00:00Z",
    ]);
  });
});

describe("renewal revenue follows the canonical level (counts and revenue agree)", () => {
  it("splits first_subscription_revenue (level 1) vs renewal_revenue (levels 2+) by position", () => {
    const cohort = cohortFor([
      tx("u", "trial", "2026-03-01T00:00:00Z", { amount_usd: 1 }),
      tx("u", "first_subscription", "2026-03-08T00:00:00Z", { amount_usd: 30 }),
      tx("u", "renewal_2", "2026-03-15T00:00:00Z", { amount_usd: 20 }),
      tx("u", "renewal_3", "2026-03-22T00:00:00Z", { amount_usd: 20 }),
    ]);

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.first_subscription_revenue).toBe(30);
    expect(cohort.renewal_revenue).toBe(40);
    expect(cohort.gross_revenue).toBe(71);
  });

  it("attributes revenue by timestamp position even when transaction_type is mis-ordered", () => {
    // renewal-typed payment is FIRST by time ($25), first_subscription-typed is SECOND ($30).
    const cohort = cohortFor([
      tx("u", "trial", "2026-03-01T00:00:00Z", { amount_usd: 1 }),
      tx("u", "renewal", "2026-03-08T00:00:00Z", { amount_usd: 25 }),
      tx("u", "first_subscription", "2026-03-15T00:00:00Z", { amount_usd: 30 }),
    ]);

    // Counts: the user has a level-1 payment (First Sub) and a level-2 payment (Renewal 2).
    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    // Revenue matches those SAME positions: level 1 = $25 (First Sub), level 2 = $30 (Renewal).
    expect(cohort.first_subscription_revenue).toBe(25);
    expect(cohort.renewal_revenue).toBe(30);
  });

  it("does not inflate renewal depth or revenue from duplicate imports", () => {
    const cohort = cohortFor([
      tx("u", "trial", "2026-03-01T00:00:00Z", { amount_usd: 1 }),
      tx("u", "first_subscription", "2026-03-08T00:00:00Z", { amount_usd: 30, transaction_id: "fs" }),
      tx("u", "first_subscription", "2026-03-08T00:00:00Z", { amount_usd: 30, transaction_id: "fs" }),
      tx("u", "renewal_2", "2026-03-15T00:00:00Z", { amount_usd: 20 }),
    ]);

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
    expect(cohort.first_subscription_revenue).toBe(30); // counted once, not twice
    expect(cohort.renewal_revenue).toBe(20);
  });
});

describe("renewal sequencing from the full warehouse timeline", () => {
  it("reclassifies merged warehouse rows and splits renewal revenue by canonical position", async () => {
    // Two partial imports merged: the 3rd/4th subscription payments arrive labelled as
    // trial/first_subscription but the full timeline makes them Renewal 2 / Renewal 3.
    const rows = [
      tx("w", "trial", "2026-05-01T00:00:00Z", { amount_usd: 1 }),
      tx("w", "first_subscription", "2026-05-08T00:00:00Z", { amount_usd: 30 }),
      tx("w", "trial", "2026-05-15T00:00:00Z", { amount_usd: 30, transaction_id: "w-mid" }),
      tx("w", "first_subscription", "2026-05-22T00:00:00Z", { amount_usd: 30, transaction_id: "w-late" }),
    ];
    const records = await Promise.all(rows.map((row) => normalizeForWarehouse(row, undefined, "batch", "palmer_csv")));
    const hydrated = hydrateWarehouseTransactionsForAnalytics(
      records.map((record) => ({
        source: record.source,
        raw_payload: record.raw_payload,
        normalized_payload: record.normalized_payload,
      })),
    );

    const cohort = computeCohorts(hydrated, [], { maxRenewalDepth: 4 })[0];
    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_4_users).toBe(0);
    // Level 1 = $30 (First Sub); levels 2 + 3 = $30 + $30 = $60 (renewals).
    expect(cohort.first_subscription_revenue).toBe(30);
    expect(cohort.renewal_revenue).toBe(60);
  });
});
