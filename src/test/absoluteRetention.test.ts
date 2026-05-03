import { describe, expect, it } from "vitest";
import { computeAbsoluteRetention } from "@/services/analytics";
import type { Transaction } from "@/services/types";

function tx(overrides: Partial<Transaction>): Transaction {
  return {
    transaction_id: "tx",
    user_id: "user_1",
    email: "user@example.com",
    event_time: "2026-01-01T00:00:00Z",
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
    ...overrides,
  };
}

describe("absolute retention", () => {
  it("counts unique users by absolute 30-day month from first successful transaction", () => {
    const rows = computeAbsoluteRetention([
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-01-01T00:00:00Z", transaction_type: "trial" }),
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-01-10T00:00:00Z", transaction_type: "first_subscription" }),
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-02-05T00:00:00Z", transaction_type: "renewal_2" }),
      tx({ user_id: "u2", email: "two@example.com", event_time: "2026-01-03T00:00:00Z", transaction_type: "trial" }),
      tx({ user_id: "u2", email: "two@example.com", event_time: "2026-01-20T00:00:00Z", transaction_type: "first_subscription" }),
      tx({ user_id: "u2", email: "two@example.com", event_time: "2026-01-21T00:00:00Z", transaction_type: "first_subscription" }),
    ]);

    const jan1 = rows.find((row) => row.cohort === "2026-01-01");
    const jan3 = rows.find((row) => row.cohort === "2026-01-03");

    expect(jan1?.total_users).toBe(1);
    expect(jan1?.users_by_month[0]).toBe(1);
    expect(jan1?.users_by_month[1]).toBe(1);
    expect(jan1?.retention_by_month[0]).toBe(100);
    expect(jan3?.total_users).toBe(1);
    expect(jan3?.users_by_month[0]).toBe(1);
  });

  it("excludes failed, refunded, and non-subscription transactions from monthly retention", () => {
    const [row] = computeAbsoluteRetention([
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-01-01T00:00:00Z", transaction_type: "trial" }),
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-01-05T00:00:00Z", transaction_type: "failed_payment", status: "failed" }),
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-01-06T00:00:00Z", transaction_type: "refund", status: "refunded" }),
      tx({ user_id: "u1", email: "one@example.com", event_time: "2026-01-07T00:00:00Z", transaction_type: "upsell" }),
    ]);

    expect(row.total_users).toBe(1);
    expect(row.users_by_month[0]).toBe(0);
    expect(row.retention_by_month[0]).toBe(0);
  });
});
