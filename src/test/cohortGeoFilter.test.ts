import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import { buildCohortGeoOptions } from "@/services/cohortGeo";
import { computeCohortReportTotals } from "@/services/cohortReporting";
import type { CardType, Transaction, TransactionType } from "@/services/types";

function tx(
  userId: string,
  transactionType: TransactionType,
  eventTime: string,
  countryCode: string | null,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 10);
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
    status: overrides.status ?? "success",
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    product: "Product",
    traffic_source: "facebook",
    campaign_id: "campaign",
    classification_reason: "",
    metadata: countryCode ? { ff_country_code: countryCode } : {},
    raw: countryCode ? { ff_country_code: countryCode } : {},
    ...overrides,
  };
}

function userRows(
  userId: string,
  countryCode: string | null,
  trialAmount: number,
  paymentAmount: number,
  cardType?: CardType,
): Transaction[] {
  return [
    tx(userId, "trial", "2026-05-01T00:00:00Z", countryCode, {
      amount_usd: trialAmount,
      gross_amount_usd: trialAmount,
      net_amount_usd: trialAmount,
      card_type: cardType,
    }),
    tx(userId, "upsell", "2026-05-01T00:10:00Z", countryCode, {
      amount_usd: 5,
      gross_amount_usd: 5,
      net_amount_usd: 5,
      card_type: cardType,
    }),
    tx(userId, "first_subscription", "2026-05-08T00:00:00Z", countryCode, {
      amount_usd: paymentAmount,
      gross_amount_usd: paymentAmount,
      net_amount_usd: paymentAmount,
      card_type: cardType,
    }),
    tx(userId, "renewal_2", "2026-05-15T00:00:00Z", countryCode, {
      amount_usd: paymentAmount,
      gross_amount_usd: paymentAmount,
      net_amount_usd: paymentAmount,
      card_type: cardType,
    }),
    tx(userId, "renewal_3", "2026-05-22T00:00:00Z", countryCode, {
      amount_usd: paymentAmount,
      gross_amount_usd: paymentAmount,
      net_amount_usd: paymentAmount,
      card_type: cardType,
    }),
  ];
}

const rows = [
  ...userRows("us_user", "us", 1, 10),
  ...userRows("ca_user", "ca", 2, 20),
  ...userRows("gb_user", "GB", 3, 30),
  ...userRows("missing_country_user", null, 4, 40),
];

const cardRows = [
  ...userRows("credit_user", "US", 1, 10, "credit"),
  ...userRows("debit_user", "CA", 2, 20, "debit"),
  ...userRows("prepaid_user", "US", 3, 30, "prepaid"),
  ...userRows("unknown_card_user", "GB", 4, 40, "unknown"),
];

describe("cohort GEO filter", () => {
  it("returns full cohort metrics when no country is selected", () => {
    const cohort = computeCohorts(rows)[0];

    expect(cohort.trial_users).toBe(4);
    expect(cohort.upsell_users).toBe(4);
    expect(cohort.first_subscription_users).toBe(4);
    expect(cohort.renewal_2_users).toBe(4);
    expect(cohort.renewal_3_users).toBe(4);
    expect(cohort.net_revenue).toBe(330);
  });

  it("filters one country at user level and recalculates revenue and renewals", () => {
    const cohort = computeCohorts(rows, [], { selectedCountries: ["US"] })[0];

    expect(cohort.trial_users).toBe(1);
    expect(cohort.upsell_users).toBe(1);
    expect(cohort.first_subscription_users).toBe(1);
    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.net_revenue).toBe(36);
  });

  it("filters multiple countries at user level", () => {
    const cohort = computeCohorts(rows, [], { selectedCountries: ["US", "CA"] })[0];

    expect(cohort.trial_users).toBe(2);
    expect(cohort.first_subscription_users).toBe(2);
    expect(cohort.renewal_2_users).toBe(2);
    expect(cohort.net_revenue).toBe(103);
  });

  it("recalculates totals from country-filtered cohort data", () => {
    const cohorts = computeCohorts(rows, [], { selectedCountries: ["CA", "GB"] });
    const totals = computeCohortReportTotals(cohorts);

    expect(totals.totalTrialUsers).toBe(2);
    expect(totals.totalFirstSubscriptionUsers).toBe(2);
    expect(totals.totalRenewal2Users).toBe(2);
    expect(totals.netRevenue).toBe(165);
  });

  it("applies country filtering to expanded price rows", () => {
    const cohort = computeCohorts(rows, [], { selectedCountries: ["CA"] })[0];

    expect(cohort.plan_breakdown).toHaveLength(1);
    expect(cohort.plan_breakdown[0]).toMatchObject({
      price: 2,
      trial_users: 1,
      first_subscription_users: 1,
      renewal_2_users: 1,
      renewal_3_users: 1,
      net_revenue: 67,
    });
  });

  it("excludes missing-country users only when the GEO filter is active", () => {
    expect(computeCohorts(rows)[0].trial_users).toBe(4);
    expect(computeCohorts(rows, [], { selectedCountries: ["US", "CA", "GB"] })[0].trial_users).toBe(3);
  });

  it("shows GEO option counts as current filtered Trial Users, not all transaction users", () => {
    const rowsWithNonCohortUser = [
      ...rows,
      tx("us_non_trial", "renewal_2", "2026-05-15T00:00:00Z", "US"),
      ...userRows("us_other_campaign", "US", 1, 10).map((row) => ({
        ...row,
        campaign_path: "other-campaign",
        cohort_id: `other-campaign_${row.cohort_date ?? row.event_time.slice(0, 10)}`,
      })),
    ];

    const options = buildCohortGeoOptions({
      txs: rowsWithNonCohortUser,
      filters: { campaignPathFilter: "soulmate-reading" },
    });

    expect(options.find((option) => option.country_code === "US")?.user_count).toBe(1);
    expect(computeCohorts(rowsWithNonCohortUser, [], { selectedCountries: ["US"] })
      .filter((cohort) => cohort.campaign_path === "soulmate-reading")
      .reduce((total, cohort) => total + cohort.trial_users, 0)).toBe(1);
  });
});

describe("cohort Card Type filter", () => {
  it("returns full cohort metrics when no card type is selected", () => {
    const cohort = computeCohorts(cardRows)[0];

    expect(cohort.trial_users).toBe(4);
    expect(cohort.upsell_users).toBe(4);
    expect(cohort.first_subscription_users).toBe(4);
    expect(cohort.renewal_2_users).toBe(4);
    expect(cohort.renewal_3_users).toBe(4);
    expect(cohort.net_revenue).toBe(330);
  });

  it("filters one card type at user level", () => {
    const cohort = computeCohorts(cardRows, [], { selectedCardTypes: ["credit"] })[0];

    expect(cohort.trial_users).toBe(1);
    expect(cohort.upsell_users).toBe(1);
    expect(cohort.first_subscription_users).toBe(1);
  });

  it("filters multiple card types at user level", () => {
    const cohort = computeCohorts(cardRows, [], { selectedCardTypes: ["credit", "debit"] })[0];

    expect(cohort.trial_users).toBe(2);
    expect(cohort.first_subscription_users).toBe(2);
    expect(cohort.net_revenue).toBe(103);
  });

  it("combines card type and GEO filters", () => {
    const cohort = computeCohorts(cardRows, [], {
      selectedCountries: ["US"],
      selectedCardTypes: ["credit"],
    })[0];

    expect(cohort.trial_users).toBe(1);
    expect(cohort.net_revenue).toBe(36);
  });

  it("recalculates revenue by card type", () => {
    const cohort = computeCohorts(cardRows, [], { selectedCardTypes: ["prepaid"] })[0];

    expect(cohort.gross_revenue).toBe(98);
    expect(cohort.net_revenue).toBe(98);
    expect(cohort.revenue_d0).toBe(8);
    expect(cohort.revenue_d7).toBe(38);
    expect(cohort.revenue_d30).toBe(98);
    expect(cohort.revenue_d60).toBe(98);
  });

  it("recalculates renewals by card type", () => {
    const cohort = computeCohorts(cardRows, [], { selectedCardTypes: ["debit"] })[0];

    expect(cohort.renewal_2_users).toBe(1);
    expect(cohort.renewal_3_users).toBe(1);
    expect(cohort.renewal_users).toBe(1);
  });

  it("recalculates totals from card type-filtered cohort data", () => {
    const cohorts = computeCohorts(cardRows, [], { selectedCardTypes: ["credit", "debit"] });
    const totals = computeCohortReportTotals(cohorts);

    expect(totals.totalTrialUsers).toBe(2);
    expect(totals.totalFirstSubscriptionUsers).toBe(2);
    expect(totals.totalRenewal2Users).toBe(2);
    expect(totals.netRevenue).toBe(103);
  });

  it("applies card type filtering to expanded price rows", () => {
    const cohort = computeCohorts(cardRows, [], { selectedCardTypes: ["debit"] })[0];

    expect(cohort.plan_breakdown).toHaveLength(1);
    expect(cohort.plan_breakdown[0]).toMatchObject({
      price: 2,
      trial_users: 1,
      first_subscription_users: 1,
      renewal_2_users: 1,
      net_revenue: 67,
    });
  });
});
