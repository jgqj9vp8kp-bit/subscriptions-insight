import { describe, expect, it } from "vitest";
import { computeUsers } from "@/services/analytics";
import {
  classifyDeclineStagesForTransactions,
  declineRateByCardType,
  declineRateByGeo,
  normalizeDeclineReason,
  parseDeclineReasonRecords,
  topDeclineReasons,
} from "@/services/paymentFailures";
import type { Transaction } from "@/services/types";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? "tx_1",
    user_id: overrides.user_id ?? "user_1",
    email: overrides.email ?? "user@example.com",
    event_time: overrides.event_time ?? "2026-01-01T10:00:00.000Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "unknown",
    campaign_path: "soulmate-reading",
    product: "Trial",
    traffic_source: "unknown",
    campaign_id: "",
    classification_reason: "test",
    ...overrides,
  };
}

function failed(overrides: Partial<Transaction> = {}): Transaction {
  return tx({
    transaction_id: "failed_tx",
    status: "failed",
    transaction_type: "failed_payment",
    amount_usd: 0,
    gross_amount_usd: 0,
    net_amount_usd: 0,
    classification_reason: "failed Palmer status",
    ...overrides,
  });
}

describe("payment failure analytics", () => {
  it("normalizes audited decline reasons", () => {
    expect(normalizeDeclineReason({ decline_reason: "INSUFFICIENT_FUNDS", payment_method_result_code: "51" })).toBe("insufficient_funds");
    expect(normalizeDeclineReason({ decline_reason: "DO_NOT_HONOR" })).toBe("do_not_honor");
    expect(normalizeDeclineReason({ decline_reason: "AUTHENTICATION_REQUIRED", message: "The provided PaymentMethod has failed authentication." })).toBe("authentication_failed");
    expect(normalizeDeclineReason({ decline_reason: "ISSUER_TEMPORARILY_UNAVAILABLE", message: "try_again_later" })).toBe("issuer_unavailable");
    expect(normalizeDeclineReason({ message: "Your card does not support this type of purchase." })).toBe("card_not_supported");
    expect(normalizeDeclineReason({ message: "card_velocity_exceeded" })).toBe("card_velocity_exceeded");
    expect(normalizeDeclineReason({ payment_method_result_message: "System malfunction" })).toBe("processing_error");
  });

  it("parses Palmer raw declineReasons strings", () => {
    const records = parseDeclineReasonRecords(
      "[{'transaction_lifecycle_event': 'AUTHORIZATION_DECLINED', 'payment_method_result_code': '51', 'decline_reason': 'INSUFFICIENT_FUNDS', 'message': 'insufficient_funds', 'payment_method_result_message': 'Insufficient funds / Over credit limit'}]",
    );

    expect(records[0]).toMatchObject({
      decline_reason: "INSUFFICIENT_FUNDS",
      message: "insufficient_funds",
      payment_method_result_code: "51",
    });
    expect(normalizeDeclineReason(records[0])).toBe("insufficient_funds");
  });

  it("selects the latest failed transaction and counts multiple attempts", () => {
    const users = computeUsers([
      failed({
        transaction_id: "older_fail",
        event_time: "2026-01-01T10:00:00.000Z",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS', 'message': 'insufficient_funds'}]" },
      }),
      failed({
        transaction_id: "latest_fail",
        event_time: "2026-01-03T10:00:00.000Z",
        raw: { declineReasons: "[{'message': 'Your card does not support this type of purchase.'}]" },
      }),
    ]);

    expect(users[0].has_failed_payment).toBe(true);
    expect(users[0].failed_payment_count).toBe(2);
    expect(users[0].latest_decline_reason).toBe("card_not_supported");
    expect(users[0].latest_decline_stage).toBe("unknown");
    expect(users[0].latest_decline_date).toBe("2026-01-03T10:00:00.000Z");
  });

  it("keeps mixed successful and failed users as failed payment users without changing revenue", () => {
    const users = computeUsers([
      tx({ transaction_id: "trial", amount_usd: 10, gross_amount_usd: 10, net_amount_usd: 10 }),
      failed({
        transaction_id: "decline",
        event_time: "2026-01-02T10:00:00.000Z",
        raw: { declineReasons: "[{'decline_reason': 'EXPIRED_CARD', 'message': 'expired_card'}]" },
      }),
      tx({
        transaction_id: "refund",
        status: "refunded",
        transaction_type: "refund",
        amount_usd: -5,
        gross_amount_usd: 0,
        refund_amount_usd: 5,
        net_amount_usd: -5,
      }),
    ]);

    expect(users[0].has_failed_payment).toBe(true);
    expect(users[0].latest_decline_reason).toBe("expired_card");
    expect(users[0].latest_decline_stage).toBe("after_trial");
    expect(users[0].total_revenue).toBe(5);
    expect(users[0].failed_payment_count).toBe(1);
  });

  it("uses unknown for failed transactions without declineReasons", () => {
    const users = computeUsers([failed({ raw: { status: "DECLINED" } })]);

    expect(users[0].latest_decline_reason).toBe("unknown");
    expect(users[0].latest_decline_message).toBeNull();
  });

  it("falls back unmatched ERROR and plain card declined messages to generic_decline", () => {
    expect(normalizeDeclineReason({ decline_reason: "ERROR" })).toBe("generic_decline");
    expect(normalizeDeclineReason({ message: "Your card was declined." })).toBe("generic_decline");
  });

  it("builds decline aggregation helpers", () => {
    const users = computeUsers([
      failed({
        user_id: "u1",
        email: "u1@example.com",
        raw: { declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]", ff_country_code: "US" },
        card_type: "credit",
      }),
      tx({
        transaction_id: "success",
        user_id: "u2",
        email: "u2@example.com",
        raw: { ff_country_code: "CA" },
        card_type: "debit",
      }),
    ]);

    expect(topDeclineReasons(users)).toEqual([{ reason: "insufficient_funds", users: 1 }]);
    expect(declineRateByGeo(users).find((row) => row.key === "US")).toMatchObject({ users: 1, failed_users: 1, decline_rate: 100 });
    expect(declineRateByCardType(users).find((row) => row.key === "debit")).toMatchObject({ users: 1, failed_users: 0, decline_rate: 0 });
  });

  it("classifies failed payments after trial", () => {
    const stages = classifyDeclineStagesForTransactions([
      tx({ transaction_id: "trial", event_time: "2026-01-01T10:00:00.000Z" }),
      failed({ transaction_id: "fail", event_time: "2026-01-01T11:00:00.000Z" }),
    ]);

    expect(stages.get("fail")).toBe("after_trial");
  });

  it("classifies failed payments after first subscription", () => {
    const stages = classifyDeclineStagesForTransactions([
      tx({ transaction_id: "trial", event_time: "2026-01-01T10:00:00.000Z" }),
      tx({ transaction_id: "first_sub", transaction_type: "first_subscription", event_time: "2026-01-02T10:00:00.000Z" }),
      failed({ transaction_id: "fail", event_time: "2026-01-03T10:00:00.000Z" }),
    ]);

    expect(stages.get("fail")).toBe("after_first_subscription");
  });

  it("classifies failed payments after renewal", () => {
    const stages = classifyDeclineStagesForTransactions([
      tx({ transaction_id: "trial", event_time: "2026-01-01T10:00:00.000Z" }),
      tx({ transaction_id: "first_sub", transaction_type: "first_subscription", event_time: "2026-01-02T10:00:00.000Z" }),
      tx({ transaction_id: "renewal", transaction_type: "renewal_2", event_time: "2026-01-03T10:00:00.000Z" }),
      failed({ transaction_id: "fail", event_time: "2026-01-04T10:00:00.000Z" }),
    ]);

    expect(stages.get("fail")).toBe("after_renewal");
  });

  it("classifies failed payments before trial as unknown", () => {
    const stages = classifyDeclineStagesForTransactions([
      failed({ transaction_id: "fail", event_time: "2026-01-01T09:00:00.000Z" }),
      tx({ transaction_id: "trial", event_time: "2026-01-01T10:00:00.000Z" }),
    ]);

    expect(stages.get("fail")).toBe("unknown");
  });

  it("classifies multiple failed payments independently", () => {
    const stages = classifyDeclineStagesForTransactions([
      tx({ transaction_id: "trial", event_time: "2026-01-01T10:00:00.000Z" }),
      failed({ transaction_id: "fail_after_trial", event_time: "2026-01-01T11:00:00.000Z" }),
      tx({ transaction_id: "first_sub", transaction_type: "first_subscription", event_time: "2026-01-02T10:00:00.000Z" }),
      failed({ transaction_id: "fail_after_first_sub", event_time: "2026-01-02T11:00:00.000Z" }),
      tx({ transaction_id: "renewal", transaction_type: "renewal_2", event_time: "2026-01-03T10:00:00.000Z" }),
      failed({ transaction_id: "fail_after_renewal", event_time: "2026-01-03T11:00:00.000Z" }),
    ]);

    expect(stages.get("fail_after_trial")).toBe("after_trial");
    expect(stages.get("fail_after_first_sub")).toBe("after_first_subscription");
    expect(stages.get("fail_after_renewal")).toBe("after_renewal");
  });
});
