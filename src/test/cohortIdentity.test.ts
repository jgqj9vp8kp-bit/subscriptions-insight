import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import type { Funnel, Transaction } from "@/services/types";

function tx(userId: string, funnel: Funnel, overrides: Partial<Transaction> = {}): Transaction {
  const transactionType = overrides.transaction_type ?? "trial";
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 29.99);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-04-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: amount,
    refund_amount_usd: 0,
    net_amount_usd: amount,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? "success",
    transaction_type: transactionType,
    funnel,
    campaign_path: overrides.campaign_path ?? "shared-reading",
    product: "",
    traffic_source: "facebook",
    campaign_id: "",
    classification_reason: "",
    cohort_date: overrides.cohort_date,
    cohort_id: overrides.cohort_id,
    transaction_day: overrides.transaction_day,
  };
}

describe("cohort identity", () => {
  it("keeps same-day campaign paths split by funnel", () => {
    const cohorts = computeCohorts([
      tx("soulmate_user", "soulmate"),
      tx("past_life_user", "past_life"),
    ]);

    expect(cohorts.map((cohort) => cohort.cohort_id).sort()).toEqual([
      "past_life_shared-reading_2026-04-01",
      "soulmate_shared-reading_2026-04-01",
    ]);
    expect(cohorts.map((cohort) => cohort.trial_users).sort()).toEqual([1, 1]);
  });

  it("ignores stale stored cohort ids that do not include funnel", () => {
    const cohorts = computeCohorts([
      tx("soulmate_user", "soulmate", { cohort_id: "shared-reading_2026-04-01" }),
      tx("past_life_user", "past_life", { cohort_id: "shared-reading_2026-04-01" }),
    ]);

    expect(cohorts).toHaveLength(2);
  });
});
