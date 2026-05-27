import { describe, expect, it } from "vitest";
import { countryUserCountsForTransactions } from "@/services/userCountry";
import type { Transaction } from "@/services/types";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "tx_1",
    user_id: "user_1",
    email: "user@example.com",
    event_time: "2026-01-01T10:00:00.000Z",
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

describe("user country helpers", () => {
  it("counts unique users per country from transaction history", () => {
    const rows = [
      tx({ transaction_id: "us_trial", user_id: "us_1", metadata: { ff_country_code: "us" } }),
      tx({ transaction_id: "us_renewal", user_id: "us_1", metadata: { ff_country_code: "us" }, transaction_type: "renewal_2" }),
      tx({ transaction_id: "us_second", user_id: "us_2", raw: { ff_country_code: "US" } }),
      tx({ transaction_id: "ca_trial", user_id: "ca_1", metadata: { country_code: "ca" } }),
      tx({ transaction_id: "missing", user_id: "missing_1" }),
    ];

    expect(countryUserCountsForTransactions(rows)).toEqual([
      { country_code: "CA", user_count: 1 },
      { country_code: "US", user_count: 2 },
    ]);
  });
});
