// Renewal 3→4 / 4→5 / 5→6 conversion columns. Same ordinal-payment algorithm as
// Renewal 1–2 / 2–3 in BOTH engines: the ClickHouse aggregate mapper and the
// legacy client compute. Zero denominators must yield 0 (the UI renders "—"),
// never Infinity or NaN.

import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import { getCohortSortValue } from "@/services/cohortSorting";
import type { Transaction, TransactionStatus, TransactionType } from "@/services/types";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract";

function tx(
  userId: string,
  transactionType: TransactionType,
  eventTime: string,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 10);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${eventTime}-${amount}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    product: "Product",
    traffic_source: "facebook",
    campaign_id: "campaign",
    classification_reason: "",
  };
}

/** Full successful lifecycle chain for one user: trial + N monthly payments. */
function lifecycle(userId: string, months: number): Transaction[] {
  const rows = [tx(userId, "trial", "2026-01-01T00:00:00Z")];
  const types: TransactionType[] = ["first_subscription", "renewal_2", "renewal_3", "renewal", "renewal", "renewal"];
  for (let i = 0; i < months; i += 1) {
    rows.push(tx(userId, types[Math.min(i, types.length - 1)], `2026-0${2 + i}-01T00:00:00Z`));
  }
  return rows;
}

describe("legacy engine: renewal 3→4 / 4→5 / 5→6 CR", () => {
  it("uses the same ordinal-payment chain as renewal 1–2 / 2–3", () => {
    // 8 users, payment depths after trial: renewal_N_users counts users whose
    // ordinal chain REACHED level N — depth>=2: 7, >=3: 6, >=4: 4, >=5: 2, >=6: 1.
    const depths = [6, 5, 4, 4, 3, 3, 2, 1];
    const rows = depths.flatMap((months, i) => lifecycle(`u${i}`, months));
    const cohort = computeCohorts(rows)[0];
    expect(cohort.renewal_3_users).toBe(6);
    expect(cohort.renewal_4_users).toBe(4);
    expect(cohort.renewal_5_users).toBe(2);
    expect(cohort.renewal_6_users).toBe(1);
    expect(cohort.renewal_3_to_renewal_4_cr).toBeCloseTo((4 / 6) * 100);
    expect(cohort.renewal_4_to_renewal_5_cr).toBeCloseTo((2 / 4) * 100);
    expect(cohort.renewal_5_to_renewal_6_cr).toBeCloseTo((1 / 2) * 100);
    // Existing metrics stay untouched by the new columns.
    expect(cohort.first_subscription_to_renewal_2_cr).toBeCloseTo((7 / 8) * 100);
    expect(cohort.renewal_2_to_renewal_3_cr).toBeCloseTo((6 / 7) * 100);
  });

  it("failed/refunded renewals do not advance the ordinal chain", () => {
    const rows = [
      ...lifecycle("u1", 4), // reaches lvl 4
      tx("u2", "trial", "2026-01-01T00:00:00Z"),
      tx("u2", "first_subscription", "2026-02-01T00:00:00Z"),
      tx("u2", "renewal_2", "2026-03-01T00:00:00Z"),
      tx("u2", "renewal_3", "2026-04-01T00:00:00Z"),
      // Failed 4th payment: u2 must NOT count as renewal_4.
      tx("u2", "renewal", "2026-05-01T00:00:00Z", { status: "failed" as TransactionStatus }),
    ];
    const cohort = computeCohorts(rows)[0];
    expect(cohort.renewal_3_users).toBe(2);
    expect(cohort.renewal_4_users).toBe(1);
    expect(cohort.renewal_3_to_renewal_4_cr).toBeCloseTo(50);
  });

  it("zero denominators produce 0 (rendered as —), never NaN/Infinity", () => {
    const cohort = computeCohorts(lifecycle("u1", 1))[0]; // only first_subscription
    expect(cohort.renewal_3_to_renewal_4_cr).toBe(0);
    expect(cohort.renewal_4_to_renewal_5_cr).toBe(0);
    expect(cohort.renewal_5_to_renewal_6_cr).toBe(0);
    expect(Number.isFinite(cohort.renewal_3_to_renewal_4_cr)).toBe(true);
  });
});

describe("ClickHouse engine: renewal 3→4 / 4→5 / 5→6 CR from the aggregate bundle", () => {
  const agg = (byLevel: Record<number, number>): CohortAggregateRow =>
    ({
      cohort_date: "2026-01-01",
      funnel: "soulmate",
      campaign_path: "soulmate-sketch",
      trial_users: 10,
      upsell_users: 0,
      first_subscription_users: 8,
      renewal_users: 0,
      renewal_users_by_level: byLevel,
      refund_users: 0,
      support_users: 0,
      support_rate: 0,
      active_users: 0, active_subscriptions: 0, cancelled_users: 0,
      user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
      trial_revenue: 0, upsell_revenue: 0, first_subscription_revenue: 0, renewal_revenue: 0,
      gross_revenue: 0, net_revenue: 0, amount_refunded: 0,
      revenue_d0: 0, revenue_d7: 0, revenue_d14: 0, revenue_d30: 0, revenue_d60: 0,
      net_revenue_1m: 0, ltv_1m_per_user: 0,
      upsell_1_users: 0, upsell_2_users: 0, upsell_3_users: 0, upsell_extra_users: 0,
      upsell_1_revenue: 0, upsell_2_revenue: 0, upsell_3_revenue: 0, upsell_extra_revenue: 0,
      funnel_upsell_users: 0, funnel_upsell_revenue: 0,
      token_buyers: 0, token_purchases: 0, token_gross_revenue: 0, token_net_revenue: 0, addon_revenue: 0,
      fx_missing_transactions: 0, fx_missing_amount: 0,
      dedup: {
        active_user_hashes: [], active_subscription_hashes: [], refunded_user_hashes: [],
        cancelled_user_hashes: [], user_cancelled_user_hashes: [], auto_cancelled_user_hashes: [],
        cancelled_active_user_hashes: [], token_buyer_hashes: [],
      },
    }) as CohortAggregateRow;

  it("derives the three new CRs from renewal_users_by_level exactly like 2→3", () => {
    const row = mapAggregateToCohortRow(agg({ 2: 10, 3: 8, 4: 4, 5: 3, 6: 1 }));
    expect(row.renewal_2_to_renewal_3_cr).toBeCloseTo(80);
    expect(row.renewal_3_to_renewal_4_cr).toBeCloseTo(50);
    expect(row.renewal_4_to_renewal_5_cr).toBeCloseTo(75);
    expect(row.renewal_5_to_renewal_6_cr).toBeCloseTo((1 / 3) * 100);
  });

  it("zero denominators yield 0 and the columns stay sortable", () => {
    const row = mapAggregateToCohortRow(agg({ 2: 5 }));
    expect(row.renewal_3_to_renewal_4_cr).toBe(0);
    expect(row.renewal_4_to_renewal_5_cr).toBe(0);
    expect(row.renewal_5_to_renewal_6_cr).toBe(0);
    // Generic sort resolver picks the new numeric fields up by column id.
    const sortable = mapAggregateToCohortRow(agg({ 2: 10, 3: 8, 4: 4 }));
    expect(getCohortSortValue(sortable, "renewal_3_to_renewal_4_cr")).toBeCloseTo(50);
    expect(getCohortSortValue(row, "renewal_4_to_renewal_5_cr")).toBe(0);
  });
});
