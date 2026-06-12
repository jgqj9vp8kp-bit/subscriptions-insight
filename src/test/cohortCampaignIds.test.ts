import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import { buildCampaignIdOptions } from "@/services/cohortCampaignIds";
import { filterCohorts } from "@/services/cohortFiltering";
import { computeCohortReportTotals } from "@/services/cohortReporting";
import { filterTransactionsByTrialAttribution } from "@/services/cohortFiltering";
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
    ...overrides,
  };
}

function userRows(
  userId: string,
  campaignId: string,
  options: { funnel?: Funnel; path?: string; country?: string; cardType?: CardType; trialAmount?: number } = {},
): Transaction[] {
  const metadata = options.country ? { ff_country_code: options.country } : undefined;
  const base = {
    funnel: options.funnel ?? "soulmate",
    campaign_path: options.path ?? "campaign-a",
    campaign_id: campaignId,
    metadata,
    card_type: options.cardType,
  };
  return [
    tx(userId, "trial", { ...base, amount_usd: options.trialAmount ?? 1 }),
    tx(userId, "upsell", { ...base, event_time: "2026-05-01T00:10:00Z", amount_usd: 5 }),
    tx(userId, "first_subscription", { ...base, event_time: "2026-05-08T00:00:00Z", amount_usd: 10 }),
    tx(userId, "renewal_2", { ...base, event_time: "2026-05-15T00:00:00Z", amount_usd: 10 }),
  ];
}

const rows = [
  ...userRows("a_us_credit", "120394857", { country: "US", cardType: "credit", trialAmount: 1 }),
  ...userRows("a_ca_debit", "120394857", { country: "CA", cardType: "debit", trialAmount: 2 }),
  ...userRows("b_us_credit", "120394858", { country: "US", cardType: "credit", trialAmount: 9 }),
  ...userRows("past_life", "120394859", { funnel: "past_life", path: "past-life-astrology", country: "US", cardType: "credit" }),
  ...userRows("missing_campaign", "", { country: "US", cardType: "credit" }),
  tx("a_us_credit", "renewal_3", {
    event_time: "2026-05-22T00:00:00Z",
    campaign_id: "120394857",
    campaign_path: "campaign-a",
    metadata: { ff_country_code: "US" },
    card_type: "credit",
  }),
];

describe("cohort Campaign ID options", () => {
  it("filters options by selected funnel and shows unique trial counts", () => {
    const options = buildCampaignIdOptions({
      txs: rows,
      filters: { funnelFilter: "soulmate" },
    });

    expect(options.map((option) => [option.campaign_id, option.trial_count])).toEqual([
      ["120394857", 2],
      ["120394858", 1],
      ["unknown", 1],
    ]);
  });

  it("filters options by campaign path batch", () => {
    const options = buildCampaignIdOptions({
      txs: rows,
      filters: { campaignPathFilter: "past-life-astrology" },
    });

    expect(options).toMatchObject([{ campaign_id: "120394859", trial_count: 1 }]);
  });

  it("updates option counts for date, GEO, and Card Type context", () => {
    expect(buildCampaignIdOptions({
      txs: rows,
      filters: { cohortDateFrom: "2026-05-01", cohortDateTo: "2026-05-01", campaignPathFilter: "campaign-a" },
      selectedCountries: ["US"],
      selectedCardTypes: ["credit"],
    }).map((option) => [option.campaign_id, option.trial_count])).toEqual([
      ["120394857", 1],
      ["120394858", 1],
      ["unknown", 1],
    ]);
  });

  it("does not let selected Campaign IDs limit options before option generation", () => {
    const optionsBeforeSelection = buildCampaignIdOptions({
      txs: rows,
      filters: { campaignPathFilter: "campaign-a" },
    });
    const selectedRows = filterTransactionsByTrialAttribution(rows, { selectedCampaignIds: ["120394857"] });
    const selectedCohorts = filterCohorts(computeCohorts(selectedRows), { campaignPathFilter: "campaign-a" });

    expect(optionsBeforeSelection.map((option) => option.campaign_id)).toEqual(["120394857", "120394858", "unknown"]);
    expect(selectedCohorts.reduce((total, cohort) => total + cohort.trial_users, 0)).toBe(2);
  });

  it("recalculates cohort metrics, totals, and expanded price rows for selected Campaign IDs", () => {
    const selectedRows = filterTransactionsByTrialAttribution(rows, { selectedCampaignIds: ["120394857"] });
    const cohorts = filterCohorts(computeCohorts(selectedRows), { campaignPathFilter: "campaign-a" });
    const cohort = cohorts[0];
    const totals = computeCohortReportTotals(cohorts);

    expect(cohort).toMatchObject({
      trial_users: 2,
      upsell_users: 2,
      first_subscription_users: 2,
      renewal_2_users: 2,
      gross_revenue: 63,
      net_revenue: 63,
    });
    expect(totals.totalTrialUsers).toBe(2);
    expect(totals.netRevenue).toBe(63);
    expect(cohort.plan_breakdown.map((plan) => [plan.price, plan.trial_users])).toEqual([[1, 1], [2, 1]]);
  });

  it("combines selected Campaign IDs with GEO and Card Type filters", () => {
    const selectedRows = filterTransactionsByTrialAttribution(rows, { selectedCampaignIds: ["120394857"] });

    expect(computeCohorts(selectedRows, [], { selectedCountries: ["US"] })[0].trial_users).toBe(1);
    expect(computeCohorts(selectedRows, [], { selectedCardTypes: ["debit"] })[0].trial_users).toBe(1);
  });

  it("extracts Campaign ID from raw payload and shows campaign names when available", () => {
    const rawRows = [
      tx("raw_campaign", "trial", {
        campaign_id: "",
        raw: { raw_payload: { campaign_id: "raw-123", campaign: { name: "Raw Campaign" } } },
      }),
    ];

    expect(buildCampaignIdOptions({ txs: rawRows })).toEqual([
      { campaign_id: "raw-123", campaign_name: "Raw Campaign", trial_count: 1 },
    ]);
  });
});
