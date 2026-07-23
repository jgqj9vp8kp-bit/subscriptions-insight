import { describe, expect, it } from "vitest";
import {
  computeCohorts,
  computeCohortsWithDiagnostics,
} from "@/services/analytics";
import { computeCohortReportTotals } from "@/services/cohortReporting";
import { filterCohorts, filterTransactionsByTrialAttribution } from "@/services/cohortFiltering";
import { transformPalmerRows } from "@/services/palmerTransform";
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
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : transactionType === "upsell" ? 14.98 : 29.99);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${eventTime}-${overrides.product ?? ""}-${amount}`,
    user_id: userId,
    email: overrides.email ?? `${userId}@example.com`,
    event_time: eventTime,
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount - (overrides.refund_amount_usd ?? 0),
    is_refunded: overrides.is_refunded ?? false,
    currency: overrides.currency ?? "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "soulmate-sketch",
    product: overrides.product ?? "Product",
    traffic_source: overrides.traffic_source ?? "facebook",
    campaign_id: "campaign",
    classification_reason: "",
    billing_reason: overrides.billing_reason,
    metadata: overrides.metadata,
    raw: overrides.raw,
  };
}

const cohortFor = (rows: Transaction[]) => {
  const cohort = computeCohorts(rows)[0];
  if (!cohort) throw new Error("Expected a cohort");
  return cohort;
};

describe("classification through the Palmer pipeline", () => {
  const meta = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ ff_funnel_id: "soulmate", ff_campaign_path: "soulmate-sketch", ...extra });
  const rawRows = [
    { id: "p1", customerId: "u1", email: "u1@example.com", created_at: "2026-07-05T10:00:00Z", amount: "100", status: "SETTLED", metadata: meta() },
    // Funnel upsells: detected by ff_billing_reason marker (audited real signal).
    { id: "p2", customerId: "u1", email: "u1@example.com", created_at: "2026-07-05T10:01:00Z", amount: "1498", status: "SETTLED", metadata: meta({ ff_billing_reason: "upsell" }) },
    { id: "p3", customerId: "u1", email: "u1@example.com", created_at: "2026-07-05T10:02:00Z", amount: "2626", status: "SETTLED", metadata: meta({ ff_billing_reason: "upsell" }) },
    // In-app token pack: unmarked $4.99 minutes later (audited pack price).
    { id: "p4", customerId: "u1", email: "u1@example.com", created_at: "2026-07-05T10:10:00Z", amount: "499", status: "SETTLED", metadata: meta() },
    // Weekly subscription conversion a week later.
    { id: "p5", customerId: "u1", email: "u1@example.com", created_at: "2026-07-12T10:00:00Z", amount: "1499", status: "SETTLED", metadata: meta() },
  ];

  it("detects funnel upsells by billing reason and token packs by known price", () => {
    const rows = transformPalmerRows(rawRows);
    const byId = new Map(rows.map((row) => [row.transaction_id, row]));
    expect(byId.get("p1")?.transaction_type).toBe("trial");
    expect(byId.get("p2")?.transaction_type).toBe("upsell");
    expect(byId.get("p3")?.transaction_type).toBe("upsell");
    expect(byId.get("p4")?.transaction_type).toBe("token_purchase");
    // The token purchase does not consume the subscription slot.
    expect(byId.get("p5")?.transaction_type).toBe("first_subscription");
  });

  it("classifies unmarked in-trial-window charges as token purchases even when the price is unmapped", () => {
    const rows = transformPalmerRows([
      { id: "w1", customerId: "u2", email: "u2@example.com", created_at: "2026-07-06T10:00:00Z", amount: "100", status: "SETTLED", metadata: meta() },
      // Unmapped $6.66 twenty minutes after trial: a 7-day trial cannot
      // convert this early — must NOT become first_subscription.
      { id: "w2", customerId: "u2", email: "u2@example.com", created_at: "2026-07-06T10:20:00Z", amount: "666", status: "SETTLED", metadata: meta() },
    ]);
    const byId = new Map(rows.map((row) => [row.transaction_id, row]));
    expect(byId.get("w2")?.transaction_type).toBe("token_purchase");
    expect(byId.get("w2")?.classification_reason).toContain("trial window");
  });

  it("keeps subscription auto-charges outside the 48h window as first_subscription", () => {
    const charge = (id: string, uid: string, hoursAfterTrial: number, cents: string) => [
      { id: `${id}-t`, customerId: uid, email: `${uid}@e.com`, created_at: "2026-07-01T00:00:00Z", amount: "100", status: "SETTLED", metadata: meta() },
      { id, customerId: uid, email: `${uid}@e.com`, created_at: new Date(Date.parse("2026-07-01T00:00:00Z") + hoursAfterTrial * 3600e3).toISOString(), amount: cents, status: "SETTLED", metadata: meta() },
    ];
    // 70h = the earliest observed billing horizon (3-day trial, $11.99).
    const shortTrial = transformPalmerRows(charge("s1", "u70", 70, "1199"));
    expect(shortTrial.find((r) => r.transaction_id === "s1")?.transaction_type).toBe("first_subscription");
    // 166h = the 7-day trial conversion.
    const weekTrial = transformPalmerRows(charge("s2", "u166", 166, "2999"));
    expect(weekTrial.find((r) => r.transaction_id === "s2")?.transaction_type).toBe("first_subscription");
  });

  it("flags window-classified tokens with unmapped prices in unknown-product diagnostics", () => {
    const rows = transformPalmerRows([
      { id: "d1", customerId: "u3", email: "u3@example.com", created_at: "2026-07-06T10:00:00Z", amount: "100", status: "SETTLED", metadata: meta() },
      { id: "d2", customerId: "u3", email: "u3@example.com", created_at: "2026-07-06T10:20:00Z", amount: "777", status: "SETTLED", metadata: meta() },
    ]);
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics(rows);
    // Counted as token revenue (in-app purchase)…
    expect(cohorts[0].token_purchases).toBe(1);
    // …but surfaced for mapping because $7.77 is not in monetizationProductMap.
    expect(tokenDiagnostics.unknown_products).toEqual([
      expect.objectContaining({ amount: 7.77, currency: "USD", suggested_category: "token_candidate" }),
    ]);
  });

  it("survives the warehouse round-trip re-classification", async () => {
    const rows = transformPalmerRows(rawRows);
    const records = await Promise.all(rows.map((row) => normalizeForWarehouse(row, undefined, "batch", "palmer_csv")));
    const hydrated = hydrateWarehouseTransactionsForAnalytics(
      records.map((record) => ({ source: "palmer_csv", normalized_payload: record.normalized_payload })),
    );
    expect(hydrated.find((row) => row.transaction_id === "p4")?.transaction_type).toBe("token_purchase");
  });

  it("does not count token purchases as renewals", () => {
    const cohort = cohortFor([
      tx("u", "trial", "2026-06-01T00:00:00Z"),
      tx("u", "first_subscription", "2026-06-08T00:00:00Z", { amount_usd: 29.99 }),
      tx("u", "token_purchase", "2026-06-09T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99 }),
      tx("u", "renewal", "2026-06-15T00:00:00Z", { amount_usd: 29.99 }),
    ]);
    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(0);
    expect(cohort.renewal_revenue).toBeCloseTo(29.99, 2);
    expect(cohort.token_purchases).toBe(1);
  });
});

describe("upsell slots by purchase order", () => {
  // The July 2026 audit: payments carry NO ordinal signal — Upsell 1/2/3 is
  // the 1st/2nd/3rd successful upsell purchase of the user, in time order.
  const rows = [
    tx("u1", "trial", "2026-07-05T00:00:00Z"),
    tx("u2", "trial", "2026-07-05T01:00:00Z"),
    tx("u3", "trial", "2026-07-05T02:00:00Z"),
    tx("u4", "trial", "2026-07-05T03:00:00Z"),
    // u1: full 3-step upsell chain + a 4th (extra). Same product label on all —
    // the slot comes from ORDER, not from the product.
    tx("u1", "upsell", "2026-07-05T00:01:00Z", { product: "Funnel Offer", amount_usd: 10, billing_reason: "upsell" }),
    tx("u1", "upsell", "2026-07-05T00:02:00Z", { product: "Funnel Offer", amount_usd: 15, billing_reason: "upsell" }),
    tx("u1", "upsell", "2026-07-05T00:03:00Z", { product: "Funnel Offer", amount_usd: 20, billing_reason: "upsell" }),
    tx("u1", "upsell", "2026-07-05T00:04:00Z", { product: "Funnel Offer", amount_usd: 5, billing_reason: "upsell" }),
    // u2: two upsells; a FAILED one in between must not consume a slot.
    tx("u2", "upsell", "2026-07-05T01:01:00Z", { amount_usd: 10, billing_reason: "upsell" }),
    tx("u2", "upsell", "2026-07-05T01:02:00Z", { amount_usd: 12, billing_reason: "upsell", status: "failed", transaction_type: "failed_payment" as TransactionType }),
    tx("u2", "upsell", "2026-07-05T01:03:00Z", { amount_usd: 15, billing_reason: "upsell" }),
    // u3: single upsell.
    tx("u3", "upsell", "2026-07-05T02:01:00Z", { amount_usd: 10, billing_reason: "upsell" }),
  ];
  const cohort = cohortFor(rows);

  it("assigns Upsell 1 to the first successful upsell purchase", () => {
    expect(cohort.upsell_1_users).toBe(3); // u1, u2, u3
    expect(cohort.upsell_1_revenue).toBeCloseTo(30, 2); // 10 + 10 + 10
  });

  it("assigns Upsell 2 to the second successful upsell purchase", () => {
    expect(cohort.upsell_2_users).toBe(2); // u1, u2 (u2's failed attempt does not count)
    expect(cohort.upsell_2_revenue).toBeCloseTo(30, 2); // 15 + 15
  });

  it("assigns Upsell 3 to the third successful upsell purchase", () => {
    expect(cohort.upsell_3_users).toBe(1); // u1
    expect(cohort.upsell_3_revenue).toBeCloseTo(20, 2);
  });

  it("assigns 4th+ purchases to the extra bucket and keeps funnel totals", () => {
    expect(cohort.upsell_extra_users).toBe(1); // u1's 4th
    expect(cohort.upsell_extra_revenue).toBeCloseTo(5, 2);
    expect(cohort.funnel_upsell_users).toBe(3);
    expect(cohort.funnel_upsell_revenue).toBeCloseTo(30 + 30 + 20 + 5, 2);
  });

  it("computes Upsell N CR against trial users", () => {
    expect(cohort.upsell_1_cr).toBeCloseTo(75, 5); // 3 / 4
    expect(cohort.upsell_2_cr).toBeCloseTo(50, 5); // 2 / 4
    expect(cohort.upsell_3_cr).toBeCloseTo(25, 5); // 1 / 4
  });
});

describe("token metrics", () => {
  const rows = [
    tx("u1", "trial", "2026-07-01T00:00:00Z"),
    tx("u2", "trial", "2026-07-01T01:00:00Z"),
    tx("u3", "trial", "2026-07-01T02:00:00Z"),
    tx("u4", "trial", "2026-07-01T03:00:00Z"),
    // u1 buys twice (one purchase carries a detectable $1 same-row refund).
    tx("u1", "token_purchase", "2026-07-02T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99 }),
    tx("u1", "token_purchase", "2026-07-03T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99, refund_amount_usd: 1 }),
    // u3 buys one bigger pack.
    tx("u3", "token_purchase", "2026-07-04T00:00:00Z", { product: "300 Tokens", amount_usd: 9.99 }),
  ];
  const cohort = cohortFor(rows);

  it("counts unique token buyers and the transaction count separately", () => {
    expect(cohort.token_buyers).toBe(2); // u1, u3 — unique users
    expect(cohort.token_purchases).toBe(3); // transactions
    expect(cohort.token_buyer_cr).toBeCloseTo(50, 5); // 2 / 4 trials
  });

  it("sums token revenue across multiple purchases of one user and applies refunds to net", () => {
    expect(cohort.token_gross_revenue).toBeCloseTo(19.97, 2);
    // $1 same-row refund is detectable → reduces Token Net Rev.
    expect(cohort.token_net_revenue).toBeCloseTo(18.97, 2);
    expect(cohort.avg_token_revenue_per_trial).toBe(4.74); // 18.97 / 4 → cents
    expect(cohort.avg_token_revenue_per_buyer).toBe(9.49); // 18.97 / 2 → cents
  });

  it("builds the per-cohort token pack breakdown", () => {
    expect(cohort.token_pack_breakdown).toEqual([
      expect.objectContaining({ product: "300 Tokens", price: 9.99, purchases: 1, buyers: 1, gross_revenue: 9.99 }),
      expect.objectContaining({ product: "100 Tokens", price: 4.99, purchases: 2, buyers: 1, gross_revenue: 9.98 }),
    ]);
    const shares = (cohort.token_pack_breakdown ?? []).map((pack) => pack.revenue_share);
    expect(shares.reduce((sum, share) => sum + share, 0)).toBeCloseTo(100, 5);
  });

  it("computes Total Add-on Revenue = Upsell1+2+3 Rev + Token Net Rev", () => {
    const withUpsells = cohortFor([
      ...rows,
      tx("u2", "upsell", "2026-07-01T01:01:00Z", { amount_usd: 10, billing_reason: "upsell" }),
      tx("u2", "upsell", "2026-07-01T01:02:00Z", { amount_usd: 15, billing_reason: "upsell" }),
    ]);
    expect(withUpsells.addon_revenue).toBeCloseTo(10 + 15 + 18.97, 2);
  });
});

describe("token purchase attribution", () => {
  it("matches token purchases to the cohort by user_id", () => {
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-06-01T00:00:00Z"),
      tx("u1", "token_purchase", "2026-06-02T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99 }),
    ]);
    expect(cohorts[0].token_buyers).toBe(1);
    expect(tokenDiagnostics).toMatchObject({
      token_purchases_total: 1,
      token_purchases_matched: 1,
      token_purchases_matched_by_email: 0,
      token_purchases_unmatched: 0,
      token_unmatched_amount: 0,
    });
  });

  it("falls back to email matching when the web-app customer id differs", () => {
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-06-01T00:00:00Z", { email: "shared@example.com" }),
      tx("web_9", "token_purchase", "2026-06-02T00:00:00Z", {
        email: "Shared@Example.com",
        product: "300 Tokens",
        amount_usd: 9.99,
      }),
    ]);
    expect(cohorts[0].token_buyers).toBe(1);
    expect(cohorts[0].token_gross_revenue).toBeCloseTo(9.99, 2);
    expect(cohorts[0].token_buyer_user_ids).toEqual(["u1"]);
    expect(tokenDiagnostics.token_purchases_matched_by_email).toBe(1);
    expect(tokenDiagnostics.token_purchases_unmatched).toBe(0);
  });

  it("email-matched token revenue joins gross/net/revenue_dN (item 3, signed off 2026-07-23)", () => {
    const base = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-06-01T00:00:00Z", { email: "shared@example.com", amount_usd: 1 }),
    ]).cohorts[0];
    const withToken = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-06-01T00:00:00Z", { email: "shared@example.com", amount_usd: 1 }),
      tx("web_9", "token_purchase", "2026-06-02T00:00:00Z", {
        email: "shared@example.com",
        product: "300 Tokens",
        amount_usd: 9.99,
      }),
    ]).cohorts[0];

    // The email-matched token behaves exactly like a uid-matched one: it joins
    // the cohort's revenue definitions, day-offset from the cohort date (day 1).
    expect(withToken.gross_revenue - base.gross_revenue).toBeCloseTo(9.99, 2);
    expect(withToken.net_revenue - base.net_revenue).toBeCloseTo(9.99, 2);
    expect(withToken.revenue_d7 - base.revenue_d7).toBeCloseTo(9.99, 2);
    expect(withToken.revenue_d0 - base.revenue_d0).toBeCloseTo(0, 2); // day 1, not day 0
    // Retention/renewal metrics stay untouched.
    expect(withToken.first_subscription_users).toBe(base.first_subscription_users);
    expect(withToken.renewal_2_users).toBe(base.renewal_2_users);
  });

  it("reports unmatched token purchases and excludes them from cohort metrics", () => {
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-06-01T00:00:00Z"),
      tx("web_ghost", "token_purchase", "2026-06-02T00:00:00Z", {
        email: "ghost@example.com",
        product: "300 Tokens",
        amount_usd: 9.99,
      }),
    ]);
    expect(cohorts[0].token_buyers).toBe(0);
    expect(tokenDiagnostics.token_purchases_unmatched).toBe(1);
    expect(tokenDiagnostics.token_unmatched_amount).toBeCloseTo(9.99, 2);
  });
});

describe("unknown product diagnostics", () => {
  it("reports unmarked early charges that no config rule classifies", () => {
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-07-01T00:00:00Z"),
      // Unmarked $7.77 five minutes after trial: inside the app-addon window,
      // matches no known pack → lifecycle classifies it, diagnostics flag it.
      tx("u1", "first_subscription", "2026-07-01T00:05:00Z", { product: "Palmer transaction", amount_usd: 7.77 }),
    ]);
    expect(cohorts[0].token_purchases).toBe(0);
    expect(tokenDiagnostics.unknown_products).toHaveLength(1);
    expect(tokenDiagnostics.unknown_products[0]).toMatchObject({
      product_name: "Palmer transaction",
      amount: 7.77,
      currency: "USD",
      count: 1,
      users: 1,
      suggested_category: "token_candidate",
    });
    expect(tokenDiagnostics.unknown_products[0].example_transaction_id).toBeTruthy();
  });

  it("reports explicit add-on rows as unknown addon revenue", () => {
    const { tokenDiagnostics } = computeCohortsWithDiagnostics([
      tx("u1", "trial", "2026-07-01T00:00:00Z"),
      tx("u1", "unknown", "2026-07-10T00:00:00Z", { billing_reason: "one_time", amount_usd: 3.33 }),
    ]);
    expect(tokenDiagnostics.unknown_addon_revenue).toBeCloseTo(3.33, 2);
    expect(tokenDiagnostics.unknown_products.some((p) => p.suggested_category === "addon_candidate")).toBe(true);
  });
});

describe("monetization totals (total row semantics)", () => {
  // Cohort A: 1 trial, that user converts on Upsell 1 and buys tokens (100% CR).
  // Cohort B: 3 trials, nobody converts (0% CR).
  const rows = [
    tx("a1", "trial", "2026-06-01T00:00:00Z"),
    tx("a1", "upsell", "2026-06-01T00:10:00Z", { amount_usd: 10, billing_reason: "upsell" }),
    tx("a1", "token_purchase", "2026-06-02T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99 }),
    tx("b1", "trial", "2026-06-05T00:00:00Z"),
    tx("b2", "trial", "2026-06-05T01:00:00Z"),
    tx("b3", "trial", "2026-06-05T02:00:00Z"),
  ];
  const cohorts = computeCohorts(rows);

  it("computes total CRs from summed totals, not averaged per-cohort CRs", () => {
    expect(cohorts).toHaveLength(2);
    const totals = computeCohortReportTotals(cohorts);
    // Averaging per-cohort CRs would give (100 + 0) / 2 = 50%.
    expect(totals.monetization.upsell1Cr).toBeCloseTo(25, 5);
    expect(totals.monetization.tokenBuyerCr).toBeCloseTo(25, 5);
    expect(totals.monetization.funnelUpsellUsers).toBe(1);
    expect(totals.monetization.funnelUpsellRevenue).toBeCloseTo(10, 2);
    expect(totals.monetization.tokenPurchases).toBe(1);
    expect(totals.monetization.avgTokenRevenuePerTrial).toBeCloseTo(4.99 / 4, 5);
  });

  it("keeps token metrics attached to cohort rows through cohort-level filters", () => {
    const filtered = filterCohorts(cohorts, { cohortDateFrom: "2026-06-05" });
    expect(filtered).toHaveLength(1);
    const totals = computeCohortReportTotals(filtered);
    expect(totals.monetization.tokenPurchases).toBe(0);
    expect(totals.monetization.upsell1Users).toBe(0);
  });
});

describe("filters apply to monetization metrics", () => {
  it("GEO filter keeps only token/upsell metrics of users from matching cohorts", () => {
    const geo = (countryCode: string) => ({
      metadata: { ff_country_code: countryCode },
      raw: { ff_country_code: countryCode },
    });
    const rows = [
      tx("us1", "trial", "2026-06-01T00:00:00Z", geo("US")),
      tx("us1", "upsell", "2026-06-01T00:01:00Z", { amount_usd: 10, billing_reason: "upsell", ...geo("US") }),
      tx("us1", "token_purchase", "2026-06-02T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99, ...geo("US") }),
      tx("ca1", "trial", "2026-06-01T01:00:00Z", geo("CA")),
      tx("ca1", "token_purchase", "2026-06-02T01:00:00Z", { product: "300 Tokens", amount_usd: 9.99, ...geo("CA") }),
    ];
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics(rows, [], { selectedCountries: ["US"] });
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].token_purchases).toBe(1);
    expect(cohorts[0].token_gross_revenue).toBeCloseTo(4.99, 2);
    expect(cohorts[0].upsell_1_users).toBe(1);
    expect(tokenDiagnostics.token_purchases_total).toBe(1);
  });

  it("trial-attribution filters (traffic source) exclude monetization of excluded users", () => {
    const rows = [
      tx("fb1", "trial", "2026-06-01T00:00:00Z", { traffic_source: "facebook" }),
      tx("fb1", "token_purchase", "2026-06-02T00:00:00Z", { product: "100 Tokens", amount_usd: 4.99 }),
      tx("tt1", "trial", "2026-06-01T01:00:00Z", { traffic_source: "tiktok" }),
      tx("tt1", "token_purchase", "2026-06-02T01:00:00Z", { product: "300 Tokens", amount_usd: 9.99 }),
    ];
    const filtered = filterTransactionsByTrialAttribution(rows, { trafficSourceFilter: "facebook" });
    const { cohorts, tokenDiagnostics } = computeCohortsWithDiagnostics(filtered);
    expect(cohorts).toHaveLength(1);
    expect(cohorts[0].token_purchases).toBe(1);
    expect(tokenDiagnostics.token_purchases_total).toBe(1);
  });
});
