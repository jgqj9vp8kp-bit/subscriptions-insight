import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import { buildCampaignIdOptions } from "@/services/cohortCampaignIds";
import { buildMediaBuyerOptions } from "@/services/cohortMediaBuyer";
import { filterCohorts } from "@/services/cohortFiltering";
import { computeCohortReportTotals } from "@/services/cohortReporting";
import { mediaBuyerForUserTransactions, utmSourceFromTransaction } from "@/services/userMediaBuyer";
import type { CardType, Funnel, Transaction, TransactionType } from "@/services/types";

function tx(
  userId: string,
  transactionType: TransactionType,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : transactionType === "upsell" ? 5 : 10);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${overrides.event_time ?? "2026-05-01T00:00:00Z"}`,
    user_id: userId,
    email: overrides.email ?? `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-05-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    is_refunded: overrides.is_refunded ?? false,
    currency: "USD",
    status: overrides.status ?? "success",
    transaction_type: transactionType,
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "campaign-a",
    product: "",
    traffic_source: overrides.traffic_source ?? "facebook",
    campaign_id: overrides.campaign_id ?? "campaign-a-id",
    classification_reason: "",
    metadata: overrides.metadata,
    raw: overrides.raw,
    card_type: overrides.card_type,
    utm_source: overrides.utm_source,
    ...overrides,
  };
}

function userRows(
  userId: string,
  utmSource: string | null,
  options: { funnel?: Funnel; path?: string; campaignId?: string; country?: string; cardType?: CardType; trialAmount?: number } = {},
): Transaction[] {
  const metadata = {
    ...(options.country ? { ff_country_code: options.country } : {}),
    ...(utmSource ? { utm_source: utmSource } : {}),
  };
  const base = {
    funnel: options.funnel ?? "soulmate",
    campaign_path: options.path ?? "campaign-a",
    campaign_id: options.campaignId ?? "campaign-a-id",
    metadata,
    card_type: options.cardType,
    utm_source: utmSource,
  };
  return [
    tx(userId, "trial", { ...base, amount_usd: options.trialAmount ?? 1 }),
    tx(userId, "upsell", { ...base, event_time: "2026-05-01T00:10:00Z", amount_usd: 5 }),
    tx(userId, "first_subscription", { ...base, event_time: "2026-05-08T00:00:00Z", amount_usd: 10 }),
    tx(userId, "renewal_2", { ...base, event_time: "2026-05-15T00:00:00Z", amount_usd: 10 }),
    tx(userId, "renewal_3", { ...base, event_time: "2026-05-22T00:00:00Z", amount_usd: 10 }),
  ];
}

const rows = [
  ...userRows("ivan_us_credit", "4", { country: "US", cardType: "credit", campaignId: "ivan-campaign", trialAmount: 1 }),
  ...userRows("ivan_ca_debit", "4", { country: "CA", cardType: "debit", campaignId: "ivan-campaign", trialAmount: 2 }),
  ...userRows("artem_a_us_credit", "19", { country: "US", cardType: "credit", campaignId: "artem-a-campaign", trialAmount: 3 }),
  ...userRows("artem_d_gb_prepaid", "22", { country: "GB", cardType: "prepaid", campaignId: "artem-d-campaign", trialAmount: 4 }),
  ...userRows("unknown_us_credit", null, { country: "US", cardType: "credit", campaignId: "unknown-campaign", trialAmount: 5 }),
];

describe("cohort Media Buyer attribution", () => {
  it("extracts utm_source from supported locations", () => {
    expect(utmSourceFromTransaction(tx("direct", "trial", { utm_source: " 4 " }))).toBe("4");
    expect(utmSourceFromTransaction(tx("metadata", "trial", { metadata: { utm_source: 22 } }))).toBe("22");
    expect(utmSourceFromTransaction(tx("raw", "trial", { raw: { raw_payload: { metadata: { utm_source: "19" } } } }))).toBe("19");
    expect(utmSourceFromTransaction(tx("normalized", "trial", { raw: { normalized_payload: { utm_source: "4" } } }))).toBe("4");
  });

  it("maps known utm_source values and defaults missing values to Unknown", () => {
    expect(mediaBuyerForUserTransactions(userRows("ivan", "4")).media_buyer).toBe("Ivan");
    expect(mediaBuyerForUserTransactions(userRows("artem_a", "19")).media_buyer).toBe("Artem A");
    expect(mediaBuyerForUserTransactions(userRows("artem_d", "22")).media_buyer).toBe("Artem D");
    expect(mediaBuyerForUserTransactions(userRows("unknown", null)).media_buyer).toBe("Unknown");
  });

  it("falls back to the first transaction with available utm_source when the trial has none", () => {
    const userTxs = [
      tx("fallback", "trial", { metadata: {} }),
      tx("fallback", "first_subscription", { event_time: "2026-05-08T00:00:00Z", metadata: { utm_source: "22" } }),
    ];

    expect(mediaBuyerForUserTransactions(userTxs)).toEqual({ utm_source: "22", media_buyer: "Artem D" });
  });
});

describe("cohort Media Buyer filter", () => {
  it("filters a single media buyer at user level", () => {
    const cohort = computeCohorts(rows, [], { selectedMediaBuyers: ["Ivan"] })[0];

    expect(cohort.trial_users).toBe(2);
    expect(cohort.upsell_users).toBe(2);
    expect(cohort.first_subscription_users).toBe(2);
    expect(cohort.renewal_2_users).toBe(2);
    expect(cohort.net_revenue).toBe(73);
  });

  it("filters multiple media buyers at user level", () => {
    const cohort = computeCohorts(rows, [], { selectedMediaBuyers: ["Artem A", "Artem D"] })[0];

    expect(cohort.trial_users).toBe(2);
    expect(cohort.first_subscription_users).toBe(2);
    expect(cohort.renewal_3_users).toBe(2);
    expect(cohort.net_revenue).toBe(77);
  });

  it("combines media buyer and GEO filters", () => {
    const cohort = computeCohorts(rows, [], { selectedMediaBuyers: ["Ivan"], selectedCountries: ["US"] })[0];

    expect(cohort.trial_users).toBe(1);
    expect(cohort.net_revenue).toBe(36);
  });

  it("combines media buyer and Card Type filters", () => {
    const cohort = computeCohorts(rows, [], { selectedMediaBuyers: ["Ivan"], selectedCardTypes: ["debit"] })[0];

    expect(cohort.trial_users).toBe(1);
    expect(cohort.net_revenue).toBe(37);
  });

  it("combines media buyer and Campaign ID filters", () => {
    const options = buildCampaignIdOptions({
      txs: rows,
      selectedMediaBuyers: ["Ivan"],
    });
    const selectedRows = rows.filter((row) => row.campaign_id === "ivan-campaign");
    const cohort = computeCohorts(selectedRows, [], { selectedMediaBuyers: ["Ivan"] })[0];

    expect(options.map((option) => [option.campaign_id, option.trial_count])).toEqual([["ivan-campaign", 2]]);
    expect(cohort.trial_users).toBe(2);
    expect(cohort.net_revenue).toBe(73);
  });

  it("updates media buyer option counts from current filter context", () => {
    const options = buildMediaBuyerOptions({
      txs: rows,
      filters: { campaignPathFilter: "campaign-a" },
      selectedCountries: ["US"],
      selectedCardTypes: ["credit"],
    });

    expect(options.map((option) => [option.media_buyer, option.trial_count])).toEqual([
      ["Ivan", 1],
      ["Artem A", 1],
      ["Unknown", 1],
    ]);
  });

  it("does not let selected Media Buyers limit media buyer options before option generation", () => {
    const optionsBeforeSelection = buildMediaBuyerOptions({
      txs: rows,
      filters: { campaignPathFilter: "campaign-a" },
    });
    const selectedCohorts = filterCohorts(
      computeCohorts(rows, [], { selectedMediaBuyers: ["Ivan"] }),
      { campaignPathFilter: "campaign-a" },
    );

    expect(optionsBeforeSelection.map((option) => option.media_buyer)).toEqual(["Ivan", "Artem A", "Artem D", "Unknown"]);
    expect(selectedCohorts.reduce((total, cohort) => total + cohort.trial_users, 0)).toBe(2);
  });

  it("recalculates totals from media-buyer-filtered cohort data", () => {
    const cohorts = computeCohorts(rows, [], { selectedMediaBuyers: ["Ivan"] });
    const totals = computeCohortReportTotals(cohorts);

    expect(totals.totalTrialUsers).toBe(2);
    expect(totals.totalFirstSubscriptionUsers).toBe(2);
    expect(totals.totalRenewal2Users).toBe(2);
    expect(totals.netRevenue).toBe(73);
  });

  it("applies media buyer filtering to expanded price rows", () => {
    const cohort = computeCohorts(rows, [], { selectedMediaBuyers: ["Ivan"] })[0];

    expect(cohort.plan_breakdown.map((plan) => [plan.price, plan.trial_users, plan.net_revenue])).toEqual([
      [1, 1, 36],
      [2, 1, 37],
    ]);
  });
});
