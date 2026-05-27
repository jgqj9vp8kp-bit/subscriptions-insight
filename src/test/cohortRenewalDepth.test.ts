import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_RENEWAL_DEPTH, computeCohorts } from "@/services/analytics";
import { computeCohortReportTotals } from "@/services/cohortReporting";
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
    billing_reason: overrides.billing_reason,
    cohort_date: overrides.cohort_date,
    cohort_id: overrides.cohort_id,
    transaction_day: overrides.transaction_day,
  };
}

function cohortFor(rows: Transaction[]) {
  const cohort = computeCohorts(rows)[0];
  if (!cohort) throw new Error("Expected cohort");
  return cohort;
}

function weeklyRenewalRows(userId = "weekly") {
  return [
    tx(userId, "trial", "2026-03-01T00:00:00Z"),
    tx(userId, "first_subscription", "2026-03-08T00:00:00Z"),
    tx(userId, "renewal_2", "2026-03-15T00:00:00Z"),
    tx(userId, "renewal_3", "2026-03-22T00:00:00Z"),
    tx(userId, "renewal", "2026-03-29T00:00:00Z"),
    tx(userId, "renewal", "2026-04-05T00:00:00Z"),
    tx(userId, "renewal", "2026-04-12T00:00:00Z"),
    tx(userId, "renewal", "2026-04-19T00:00:00Z"),
    tx(userId, "renewal", "2026-04-26T00:00:00Z"),
    tx(userId, "renewal", "2026-05-03T00:00:00Z"),
    tx(userId, "renewal", "2026-05-10T00:00:00Z"),
    tx(userId, "renewal", "2026-05-17T00:00:00Z"),
    tx(userId, "renewal", "2026-05-24T00:00:00Z"),
  ];
}

describe("cohort renewal depth", () => {
  it("uses six tracked renewal levels by default", () => {
    expect(DEFAULT_MAX_RENEWAL_DEPTH).toBe(6);
  });

  it("tracks a weekly plan user through Renewal 6 by payment order", () => {
    const cohort = computeCohorts(weeklyRenewalRows(), [], { maxRenewalDepth: 6 })[0];

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_4_users).toBe(1);
    expect(cohort.renewal_5_users).toBe(1);
    expect(cohort.renewal_6_users).toBe(1);
    expect(cohort.renewal_users).toBe(1);
    expect(cohort.plan_breakdown[0]).toMatchObject({
      renewal_4_users: 1,
      renewal_5_users: 1,
      renewal_6_users: 1,
    });
  });

  it("respects max renewal columns of 3", () => {
    const cohort = computeCohorts(weeklyRenewalRows("max3"), [], { maxRenewalDepth: 3 })[0];

    expect(cohort.renewal_users_by_level).toEqual({ 2: 1, 3: 1 });
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_4_users).toBe(0);
  });

  it("respects max renewal columns of 6", () => {
    const cohort = computeCohorts(weeklyRenewalRows("max6"), [], { maxRenewalDepth: 6 })[0];

    expect(cohort.renewal_users_by_level?.[6]).toBe(1);
    expect(cohort.renewal_users_by_level?.[7]).toBeUndefined();
  });

  it("respects max renewal columns of 12", () => {
    const cohort = computeCohorts(weeklyRenewalRows("max12"), [], { maxRenewalDepth: 12 })[0];

    expect(cohort.renewal_users_by_level?.[12]).toBe(1);
    expect(cohort.plan_breakdown[0].renewal_users_by_level?.[12]).toBe(1);
  });

  it("sums dynamic renewal levels in totals", () => {
    const cohorts = computeCohorts([
      ...weeklyRenewalRows("weekly-a"),
      ...weeklyRenewalRows("weekly-b").map((row) => ({
        ...row,
        campaign_path: "other-campaign",
        cohort_id: "other-campaign_2026-03-01",
      })),
    ], [], { maxRenewalDepth: 12 });
    const totals = computeCohortReportTotals(cohorts);

    expect(totals.renewalTotalsByLevel[12]).toBe(2);
  });

  it("tracks a monthly plan user with fewer renewals", () => {
    const cohort = cohortFor([
      tx("monthly", "trial", "2026-03-01T00:00:00Z"),
      tx("monthly", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("monthly", "renewal", "2026-04-08T00:00:00Z"),
    ]);

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
    expect(cohort.renewal_4_users).toBe(0);
    expect(cohort.renewal_5_users).toBe(0);
    expect(cohort.renewal_6_users).toBe(0);
  });

  it("counts renewals after multiple partial imports are merged", () => {
    const cohort = cohortFor([
      tx("partial", "trial", "2026-03-01T00:00:00Z"),
      tx("partial", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("partial", "renewal_2", "2026-03-15T00:00:00Z"),
      tx("partial", "renewal_3", "2026-03-22T00:00:00Z"),
    ]);

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_4_users).toBe(0);
  });

  it("dedupes overlapping imports before renewal sequencing", () => {
    const cohort = cohortFor([
      tx("overlap", "trial", "2026-03-01T00:00:00Z"),
      tx("overlap", "first_subscription", "2026-03-08T00:00:00Z", { transaction_id: "overlap-first-sub" }),
      tx("overlap", "first_subscription", "2026-03-08T00:00:00Z", { transaction_id: "overlap-first-sub" }),
      tx("overlap", "renewal_2", "2026-03-15T00:00:00Z"),
      tx("overlap", "renewal_3", "2026-03-22T00:00:00Z"),
    ]);

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_4_users).toBe(0);
  });

  it("dedupes missing transaction ids by email, amount, and event time", () => {
    const cohort = cohortFor([
      tx("fallback-dupe", "trial", "2026-03-01T00:00:00Z"),
      tx("fallback-dupe", "first_subscription", "2026-03-08T00:00:00Z", { transaction_id: "" }),
      tx("fallback-dupe", "first_subscription", "2026-03-08T00:00:00Z", { transaction_id: "" }),
      tx("fallback-dupe", "renewal_2", "2026-03-15T00:00:00Z"),
    ]);

    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
  });

  it("excludes failed renewals from renewal order", () => {
    const cohort = cohortFor([
      tx("failed", "trial", "2026-03-01T00:00:00Z"),
      tx("failed", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("failed", "renewal", "2026-03-15T00:00:00Z", { status: "failed" }),
      tx("failed", "renewal", "2026-03-22T00:00:00Z"),
    ]);

    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
  });

  it("excludes upsells from renewal order", () => {
    const cohort = cohortFor([
      tx("upsell", "trial", "2026-03-01T00:00:00Z"),
      tx("upsell", "upsell", "2026-03-02T00:00:00Z"),
      tx("upsell", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("upsell", "renewal", "2026-03-15T00:00:00Z"),
    ]);

    expect(cohort.upsell_users).toBe(1);
    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
  });

  it("excludes refund-only rows from renewal order", () => {
    const cohort = cohortFor([
      tx("refund", "trial", "2026-03-01T00:00:00Z"),
      tx("refund", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("refund", "refund", "2026-03-10T00:00:00Z", {
        amount_usd: -9.99,
        gross_amount_usd: 0,
        refund_amount_usd: 9.99,
        net_amount_usd: -9.99,
      }),
      tx("refund", "renewal", "2026-03-15T00:00:00Z"),
    ]);

    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
  });

  it("counts each user once per renewal level", () => {
    const cohort = cohortFor([
      tx("dupe", "trial", "2026-03-01T00:00:00Z"),
      tx("dupe", "first_subscription", "2026-03-08T00:00:00Z"),
      tx("dupe", "renewal_2", "2026-03-15T00:00:00Z", { transaction_id: "dupe-r2-a" }),
      tx("dupe", "renewal_2", "2026-03-22T00:00:00Z", { transaction_id: "dupe-r2-b" }),
    ]);

    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_4_users).toBe(0);
    expect(cohort.renewal_users).toBe(1);
  });
});
