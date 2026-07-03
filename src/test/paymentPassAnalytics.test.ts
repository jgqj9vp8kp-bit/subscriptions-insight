import { describe, expect, it } from "vitest";
import {
  buildPaymentAttempts,
  declineReasonAnalytics,
  firstAttemptAttempts,
  groupPaymentAttempts,
  isFailedAttempt,
  isPaymentAttempt,
  isSuccessfulAttempt,
  paymentStageBreakdown,
  renewalBreakdown,
  summarizePaymentAttempts,
  INSUFFICIENT_FUNDS_REASON,
} from "@/services/paymentPassAnalytics";
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
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "soulmate-reading",
    product: "Product",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "campaign",
    classification_reason: overrides.classification_reason ?? "",
    cohort_date: overrides.cohort_date,
    cohort_id: overrides.cohort_id,
    transaction_day: overrides.transaction_day,
    normalized_decline_reason: overrides.normalized_decline_reason,
    country_code: overrides.country_code,
    card_type: overrides.card_type,
    metadata: overrides.metadata,
    raw: overrides.raw,
  } as Transaction;
}

const failed = (userId: string, type: TransactionType, time: string, overrides: Partial<Transaction> = {}) =>
  tx(userId, type, time, { status: "failed" as TransactionStatus, ...overrides });

describe("payment attempt detection", () => {
  it("counts successful payment transactions as attempts", () => {
    expect(isSuccessfulAttempt(tx("u", "trial", "2026-01-01T00:00:00Z"))).toBe(true);
    expect(isPaymentAttempt(tx("u", "first_subscription", "2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("detects failed/declined attempts", () => {
    expect(isFailedAttempt(failed("u", "failed_payment", "2026-01-01T00:00:00Z"))).toBe(true);
    expect(
      isFailedAttempt(tx("u", "renewal_2", "2026-01-01T00:00:00Z", { status: "failed" as TransactionStatus })),
    ).toBe(true);
  });

  it("excludes refunds and chargebacks from attempts", () => {
    const refund = tx("u", "refund", "2026-01-01T00:00:00Z", { status: "refunded" as TransactionStatus });
    const chargeback = tx("u", "chargeback", "2026-01-01T00:00:00Z", { status: "chargeback" as TransactionStatus });
    expect(isPaymentAttempt(refund)).toBe(false);
    expect(isPaymentAttempt(chargeback)).toBe(false);
    expect(isFailedAttempt(refund)).toBe(false);

    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      refund,
      chargeback,
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].stage).toBe("trial_or_entry");
  });
});

describe("First Subscription reconciles with Cohorts (canonical subscription levels)", () => {
  it("counts the first successful first_subscription/renewal payment as level 1 (First Subscription)", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      tx("u", "first_subscription", "2026-02-01T00:00:00Z"),
    ]);
    const fs = paymentStageBreakdown(attempts).find((r) => r.stage === "first_subscription")!;
    expect(fs.attempts).toBe(1);
    expect(fs.successful).toBe(1);
    expect(fs.pass_rate).toBe(1);
  });

  it("treats a no-trial user's first subscription charge as First Subscription, not entry", () => {
    // No 'trial'-typed row: the first first_subscription success is canonical level 1, matching
    // Cohorts (subscriptionLevelByPaymentForUser excludes trial type, not position).
    const attempts = buildPaymentAttempts([
      tx("u", "first_subscription", "2026-01-01T00:00:00Z"),
      tx("u", "renewal_2", "2026-02-01T00:00:00Z"),
    ]);
    const firstSub = attempts.find((a) => a.subscription_level === 1)!;
    expect(firstSub.stage).toBe("first_subscription");
    expect(firstSub.transaction_type).toBe("first_subscription");
    // The renewal is level 2, not mislabelled as First Subscription.
    expect(attempts.find((a) => a.transaction_type === "renewal_2")!.stage).toBe("renewal_2");
  });

  it("does not count a duplicate trial-typed success as a First Subscription", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      tx("u", "trial", "2026-01-02T00:00:00Z", { transaction_id: "u-trial-2" }),
      tx("u", "first_subscription", "2026-02-01T00:00:00Z"),
    ]);
    const fs = paymentStageBreakdown(attempts).find((r) => r.stage === "first_subscription")!;
    expect(fs.successful).toBe(1); // only the real first_subscription, not the second trial
    expect(attempts.filter((a) => a.stage === "trial_or_entry")).toHaveLength(2);
  });

  it("still counts a non-lifecycle successful charge toward the overall pass rate", () => {
    // Broad success detection: an 'unknown'-typed success is not bucketed into a sub stage, but it
    // must not be dropped from the overall numbers (that asymmetry is what cratered the pass rate).
    const attempts = buildPaymentAttempts([
      tx("u", "unknown" as TransactionType, "2026-01-01T00:00:00Z", { status: "success" }),
    ]);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].is_success).toBe(true);
    expect(summarizePaymentAttempts(attempts).pass_rate).toBe(1);
  });

  it("does not count refunds/chargebacks as successful attempts even with success status", () => {
    expect(isSuccessfulAttempt(tx("u", "refund", "2026-01-01T00:00:00Z", { status: "success" }))).toBe(false);
    expect(isSuccessfulAttempt(tx("u", "chargeback", "2026-01-01T00:00:00Z", { status: "success" }))).toBe(false);
  });

  it("attributes funnel/campaign at the user (cohort) level so rebills are not dropped by a funnel filter", () => {
    // Rebill rows often carry no funnel of their own; they must inherit the user's entry funnel,
    // otherwise a funnel filter keeps only the trial and craters First Subscription (the reported bug).
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z", { funnel: "soulmate", campaign_path: "soulmate-reading" }),
      tx("u", "first_subscription", "2026-02-01T00:00:00Z", { funnel: "unknown" as never, campaign_path: "" }),
    ]);
    expect(attempts.every((a) => a.funnel === "soulmate")).toBe(true);
    expect(attempts.every((a) => a.campaign_path === "soulmate-reading")).toBe(true);

    // Filtering by the entry funnel keeps the rebill, so First Subscription still counts.
    const inFunnel = attempts.filter((a) => a.funnel === "soulmate");
    const fs = paymentStageBreakdown(inFunnel).find((r) => r.stage === "first_subscription")!;
    expect(fs.successful).toBe(1);
  });
});

describe("first transaction analytics", () => {
  it("marks the very first attempt (not first success) and reports its decline reason", () => {
    const attempts = buildPaymentAttempts([
      failed("u", "failed_payment", "2026-01-01T00:00:00Z", { normalized_decline_reason: "insufficient_funds" }),
      tx("u", "trial", "2026-01-02T00:00:00Z"),
    ]);
    const first = attempts.find((a) => a.is_first_attempt)!;
    expect(first.event_time).toBe("2026-01-01T00:00:00Z");
    expect(first.is_success).toBe(false);
    expect(first.decline_reason).toBe("insufficient_funds");
    // only one first attempt per user
    expect(attempts.filter((a) => a.is_first_attempt)).toHaveLength(1);
  });

  it("first transaction success is detected", () => {
    const attempts = buildPaymentAttempts([tx("u", "trial", "2026-01-01T00:00:00Z")]);
    expect(firstAttemptAttempts(attempts)[0].is_success).toBe(true);
  });

  it("first transaction pass rate = first-success users / first-attempt users", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z"),
      failed("b", "failed_payment", "2026-01-01T00:00:00Z"),
      tx("b", "trial", "2026-01-03T00:00:00Z"),
      failed("c", "failed_payment", "2026-01-01T00:00:00Z"),
    ]);
    const summary = summarizePaymentAttempts(attempts);
    // 3 users have a first attempt; a succeeds on first, b & c fail on first => 1/3
    expect(summary.first_attempts).toBe(3);
    expect(summary.first_success).toBe(1);
    expect(summary.first_attempt_pass_rate).toBeCloseTo(1 / 3);
  });
});

describe("stage classification (user lifecycle)", () => {
  it("classifies a failed attempt after trial but before first sub as first_subscription", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      failed("u", "failed_payment", "2026-01-08T00:00:00Z"),
    ]);
    const failedAttempt = attempts.find((a) => a.is_failed)!;
    expect(failedAttempt.stage).toBe("first_subscription");
    expect(failedAttempt.subscription_level).toBe(1);
  });

  it("classifies a failed attempt after first sub as renewal 2", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      tx("u", "first_subscription", "2026-01-08T00:00:00Z"),
      failed("u", "failed_payment", "2026-01-15T00:00:00Z"),
    ]);
    const failedAttempt = attempts.find((a) => a.is_failed)!;
    expect(failedAttempt.stage).toBe("renewal_2");
    expect(failedAttempt.subscription_level).toBe(2);
  });

  it("classifies a failed attempt after renewal 2 as renewal 3", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      tx("u", "first_subscription", "2026-01-08T00:00:00Z"),
      tx("u", "renewal_2", "2026-01-15T00:00:00Z"),
      failed("u", "failed_payment", "2026-01-22T00:00:00Z"),
    ]);
    const failedAttempt = attempts.find((a) => a.is_failed)!;
    expect(failedAttempt.stage).toBe("renewal_3");
    expect(failedAttempt.subscription_level).toBe(3);
  });

  it("reports pass rate per stage", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      failed("u", "failed_payment", "2026-01-08T00:00:00Z"),
      tx("u", "first_subscription", "2026-01-09T00:00:00Z"),
    ]);
    const rows = paymentStageBreakdown(attempts);
    const firstSub = rows.find((r) => r.stage === "first_subscription")!;
    // one failed + one successful first-sub attempt => 50%
    expect(firstSub.attempts).toBe(2);
    expect(firstSub.successful).toBe(1);
    expect(firstSub.pass_rate).toBeCloseTo(0.5);
  });
});

describe("renewal analytics", () => {
  it("buckets subscription attempts by canonical level", () => {
    const attempts = buildPaymentAttempts([
      tx("u", "trial", "2026-01-01T00:00:00Z"),
      tx("u", "first_subscription", "2026-01-08T00:00:00Z"),
      tx("u", "renewal_2", "2026-01-15T00:00:00Z"),
      failed("u", "failed_payment", "2026-01-22T00:00:00Z"),
    ]);
    const rows = renewalBreakdown(attempts);
    expect(rows.map((r) => r.label)).toEqual(["First Subscription", "Renewal 2", "Renewal 3"]);
    const r3 = rows.find((r) => r.level === 3)!;
    expect(r3.attempts).toBe(1);
    expect(r3.successful).toBe(0);
    expect(r3.pass_rate).toBe(0);
  });
});

describe("segment breakdowns", () => {
  const sample = () =>
    buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z", { funnel: "soulmate", raw: { country_code: "US", card_type: "credit" } }),
      failed("b", "failed_payment", "2026-01-01T00:00:00Z", {
        funnel: "starseed",
        raw: { country_code: "DE", card_type: "prepaid" },
        normalized_decline_reason: "insufficient_funds",
      }),
      tx("b", "trial", "2026-01-02T00:00:00Z", { funnel: "starseed", raw: { country_code: "DE", card_type: "prepaid" } }),
    ]);

  it("computes funnel pass rate", () => {
    const rows = groupPaymentAttempts(sample(), "funnel");
    const starseed = rows.find((r) => r.key === "starseed")!;
    expect(starseed.attempts).toBe(2);
    expect(starseed.successful).toBe(1);
    expect(starseed.pass_rate).toBeCloseTo(0.5);
    expect(starseed.user_pass_rate).toBeCloseTo(1); // single user b eventually succeeds
  });

  it("computes GEO pass rate", () => {
    const rows = groupPaymentAttempts(sample(), "country");
    expect(rows.find((r) => r.key === "US")!.pass_rate).toBe(1);
    expect(rows.find((r) => r.key === "DE")!.pass_rate).toBeCloseTo(0.5);
  });

  it("computes card type pass rate", () => {
    const rows = groupPaymentAttempts(sample(), "card_type");
    expect(rows.find((r) => r.key === "prepaid")!.pass_rate).toBeCloseTo(0.5);
    expect(rows.find((r) => r.key === "credit")!.pass_rate).toBe(1);
  });

  it("computes media buyer pass rate", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z", { raw: { utm_source: "4" } }), // Ivan
      failed("b", "failed_payment", "2026-01-01T00:00:00Z", { raw: { utm_source: "22" } }), // Artem A
    ]);
    const rows = groupPaymentAttempts(attempts, "media_buyer");
    expect(rows.find((r) => r.key === "Ivan")!.pass_rate).toBe(1);
    expect(rows.find((r) => r.key === "Artem A")!.pass_rate).toBe(0);
  });

  it("breaks down decline reasons with stage / card / geo context", () => {
    const rows = declineReasonAnalytics(sample());
    const insufficient = rows.find((r) => r.reason === "insufficient_funds")!;
    expect(insufficient.failed_attempts).toBe(1);
    expect(insufficient.failed_users).toBe(1);
    expect(insufficient.share_of_failed).toBe(1);
    expect(insufficient.most_common_card_type).toBe("prepaid");
    expect(insufficient.most_common_country).toBe("DE");
    expect(insufficient.affected_funnels).toContain("starseed");
  });
});

describe("date basis filtering inputs", () => {
  // The page filters the attempt list; these assertions verify the two date anchors the page uses.
  const attempts = buildPaymentAttempts([
    tx("u", "trial", "2026-01-01T00:00:00Z"),
    tx("u", "first_subscription", "2026-02-01T00:00:00Z"),
  ]);

  it("transaction date basis exposes per-attempt event_date", () => {
    expect(attempts.map((a) => a.event_date).sort()).toEqual(["2026-01-01", "2026-02-01"]);
  });

  it("cohort date basis groups all attempts under the user cohort date", () => {
    // Both attempts share the user's cohort date (first successful trial = 2026-01-01).
    expect(new Set(attempts.map((a) => a.cohort_date))).toEqual(new Set(["2026-01-01"]));
    const inJanuaryCohort = attempts.filter((a) => a.cohort_date! >= "2026-01-01" && a.cohort_date! <= "2026-01-31");
    expect(inJanuaryCohort).toHaveLength(2); // cohort basis keeps the Feb rebill in the Jan cohort
  });
});

const ifFail = (userId: string, type: TransactionType, time: string, overrides: Partial<Transaction> = {}) =>
  failed(userId, type, time, { normalized_decline_reason: INSUFFICIENT_FUNDS_REASON, ...overrides });

describe("pass rate excluding insufficient funds", () => {
  it("excludes insufficient-funds failures from the denominator (overall)", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z"),
      ifFail("b", "failed_payment", "2026-01-01T00:00:00Z"),
      ifFail("c", "failed_payment", "2026-01-01T00:00:00Z"),
      failed("d", "failed_payment", "2026-01-01T00:00:00Z", { normalized_decline_reason: "do_not_honor" }),
    ]);
    const s = summarizePaymentAttempts(attempts);
    expect(s.attempts).toBe(4);
    expect(s.successful).toBe(1);
    expect(s.failed).toBe(3);
    expect(s.insufficient_funds_failures).toBe(2);
    expect(s.eligible_attempts_ex_if).toBe(2);
    expect(s.pass_rate).toBeCloseTo(0.25); // normal 1/4
    expect(s.pass_rate_ex_if).toBeCloseTo(0.5); // 1/(4-2)
  });

  it("does not change the successful count and keeps non-IF declines in the denominator", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z"),
      failed("b", "failed_payment", "2026-01-01T00:00:00Z", { normalized_decline_reason: "do_not_honor" }),
    ]);
    const s = summarizePaymentAttempts(attempts);
    expect(s.successful).toBe(1);
    expect(s.insufficient_funds_failures).toBe(0);
    expect(s.eligible_attempts_ex_if).toBe(2); // do_not_honor stays in the denominator
    expect(s.pass_rate_ex_if).toBeCloseTo(0.5);
  });

  it("reaches 100% when every failure is insufficient funds", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z"),
      ifFail("a", "failed_payment", "2026-01-08T00:00:00Z"),
      ifFail("a", "failed_payment", "2026-01-09T00:00:00Z"),
      ifFail("a", "failed_payment", "2026-01-10T00:00:00Z"),
    ]);
    const s = summarizePaymentAttempts(attempts);
    expect(s.successful).toBe(1);
    expect(s.insufficient_funds_failures).toBe(3);
    expect(s.eligible_attempts_ex_if).toBe(1);
    expect(s.pass_rate_ex_if).toBe(1);
  });

  it("returns 0 when there are no eligible attempts (project convention)", () => {
    const attempts = buildPaymentAttempts([
      ifFail("a", "failed_payment", "2026-01-01T00:00:00Z"),
      ifFail("b", "failed_payment", "2026-01-01T00:00:00Z"),
    ]);
    const s = summarizePaymentAttempts(attempts);
    expect(s.eligible_attempts_ex_if).toBe(0);
    expect(s.pass_rate_ex_if).toBe(0);
  });

  it("computes ex-IF pass rate at the stage level", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z"),
      tx("a", "first_subscription", "2026-02-01T00:00:00Z"),
      tx("b", "trial", "2026-01-01T00:00:00Z"),
      ifFail("b", "failed_payment", "2026-02-01T00:00:00Z"), // failed first-sub attempt, IF
    ]);
    const fs = paymentStageBreakdown(attempts).find((r) => r.stage === "first_subscription")!;
    expect(fs.attempts).toBe(2);
    expect(fs.successful).toBe(1);
    expect(fs.insufficient_funds_failures).toBe(1);
    expect(fs.pass_rate).toBeCloseTo(0.5);
    expect(fs.pass_rate_ex_if).toBe(1); // 1/(2-1)
  });

  it("computes ex-IF pass rate at the funnel level (scoped to the segment)", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z", { funnel: "soulmate" }),
      ifFail("a", "failed_payment", "2026-02-01T00:00:00Z"), // inherits soulmate (user-level funnel)
    ]);
    const row = groupPaymentAttempts(attempts, "funnel").find((r) => r.key === "soulmate")!;
    expect(row.attempts).toBe(2);
    expect(row.insufficient_funds_failures).toBe(1);
    expect(row.pass_rate).toBeCloseTo(0.5);
    expect(row.pass_rate_ex_if).toBe(1);
  });

  it("computes ex-IF pass rate at the renewal level", () => {
    const attempts = buildPaymentAttempts([
      tx("a", "trial", "2026-01-01T00:00:00Z"),
      tx("a", "first_subscription", "2026-02-01T00:00:00Z"),
      tx("a", "renewal_2", "2026-03-01T00:00:00Z"),
      tx("b", "trial", "2026-01-01T00:00:00Z"),
      tx("b", "first_subscription", "2026-02-01T00:00:00Z"),
      ifFail("b", "failed_payment", "2026-03-01T00:00:00Z"), // failed renewal-2 attempt, IF
    ]);
    const r2 = renewalBreakdown(attempts).find((r) => r.level === 2)!;
    expect(r2.attempts).toBe(2);
    expect(r2.successful).toBe(1);
    expect(r2.insufficient_funds_failures).toBe(1);
    expect(r2.pass_rate).toBeCloseTo(0.5);
    expect(r2.pass_rate_ex_if).toBe(1);
  });
});
