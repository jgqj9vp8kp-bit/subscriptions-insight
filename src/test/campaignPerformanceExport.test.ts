import { describe, expect, it } from "vitest";
import { buildCampaignPerformanceExport } from "@/services/campaignPerformanceExport";
import type { Transaction, TransactionType } from "@/services/types";

function tx(
  userId: string,
  transactionType: TransactionType,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : transactionType === "upsell" ? 5 : 10);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}-${overrides.event_time ?? "2026-05-01T00:00:00Z"}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-05-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    is_refunded: overrides.is_refunded ?? false,
    currency: "USD",
    status: overrides.status ?? "success",
    transaction_type: transactionType,
    funnel: overrides.funnel ?? "past_life",
    campaign_path: overrides.campaign_path ?? "past-life-astrology",
    product: "",
    traffic_source: overrides.traffic_source ?? "unknown",
    campaign_id: overrides.campaign_id ?? "campaign-1",
    utm_source: overrides.utm_source,
    classification_reason: "",
    metadata: overrides.metadata,
    raw: overrides.raw,
    card_type: overrides.card_type,
    ...overrides,
  };
}

function userRows(
  userId: string,
  options: {
    campaignId?: string;
    campaignName?: string;
    path?: string;
    funnel?: Transaction["funnel"];
    utmSource?: string | null;
    trialAt?: string;
    upsell?: boolean;
    firstSub?: boolean;
    failed?: boolean;
  } = {},
): Transaction[] {
  const base = {
    campaign_id: options.campaignId ?? "campaign-1",
    campaign_path: options.path ?? "past-life-astrology",
    funnel: options.funnel ?? "past_life",
    utm_source: options.utmSource,
    raw: options.campaignName ? { campaign: { name: options.campaignName } } : undefined,
  };
  return [
    tx(userId, "trial", { ...base, event_time: options.trialAt ?? "2026-05-01T00:00:00Z" }),
    ...(options.upsell === false ? [] : [tx(userId, "upsell", { ...base, event_time: "2026-05-01T00:05:00Z" })]),
    ...(options.firstSub === false ? [] : [tx(userId, "first_subscription", { ...base, event_time: "2026-05-08T00:00:00Z" })]),
    ...(options.failed ? [tx(userId, "failed_payment", { ...base, status: "failed", event_time: "2026-05-09T00:00:00Z" })] : []),
  ];
}

const rows: Transaction[] = [
  ...userRows("ivan-1", { campaignName: "Ivan Alpha", utmSource: "4", failed: true }),
  ...userRows("ivan-2", { campaignName: "Ivan Alpha", utmSource: "4", upsell: false }),
  ...userRows("artem-a-1", { campaignId: "campaign-2", campaignName: "Artem A Beta", path: "soulmate", funnel: "soulmate", utmSource: "19" }),
  ...userRows("unknown-1", { campaignId: "campaign-3", campaignName: "Unknown Gamma", utmSource: null, trialAt: "2026-06-01T00:00:00Z", firstSub: false }),
];

describe("campaign performance export", () => {
  it("returns exactly the API contract fields and nothing else", () => {
    const [row] = buildCampaignPerformanceExport({ txs: rows, filters: { date_from: "2026-05-01", date_to: "2026-05-31" } });

    expect(Object.keys(row).sort()).toEqual(
      [
        "campaign_id",
        "campaign_path",
        "funnel",
        "date_from",
        "date_to",
        "trial_users",
        "upsell_users",
        "upsell_cr",
        "first_sub_users",
        "trial_to_first_sub_cr",
        "refund_users",
      ].sort(),
    );
  });

  it("groups campaign export rows by Campaign ID attribution", () => {
    const result = buildCampaignPerformanceExport({ txs: rows, filters: { date_from: "2026-05-01", date_to: "2026-05-31" } });

    expect(result).toMatchObject([
      {
        campaign_id: "campaign-1",
        campaign_path: "past-life-astrology",
        funnel: "past_life",
        date_from: "2026-05-01",
        date_to: "2026-05-31",
        trial_users: 2,
        upsell_users: 1,
        upsell_cr: 0.5,
        first_sub_users: 2,
        trial_to_first_sub_cr: 1,
      },
      {
        campaign_id: "campaign-2",
        campaign_path: "soulmate",
        trial_users: 1,
      },
    ]);
  });

  it("aggregates users from different media buyers into one campaign row", () => {
    const mixed = [
      ...userRows("buyer-ivan", { campaignId: "campaign-mixed", utmSource: "4" }),
      ...userRows("buyer-artem", { campaignId: "campaign-mixed", utmSource: "19" }),
    ];

    const result = buildCampaignPerformanceExport({ txs: mixed });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ campaign_id: "campaign-mixed", trial_users: 2 });
  });

  it("filters by media buyer", () => {
    const result = buildCampaignPerformanceExport({ txs: rows, filters: { media_buyer: "Artem A" } });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ campaign_id: "campaign-2", trial_users: 1 });
  });

  it("filters by funnel campaign path", () => {
    const result = buildCampaignPerformanceExport({ txs: rows, filters: { campaign_path: "soulmate" } });

    expect(result.map((row) => row.campaign_id)).toEqual(["campaign-2"]);
  });

  it("filters by date range using first trial attribution date", () => {
    const result = buildCampaignPerformanceExport({ txs: rows, filters: { date_from: "2026-06-01", date_to: "2026-06-30" } });

    expect(result).toMatchObject([
      {
        campaign_id: "campaign-3",
        trial_users: 1,
        first_sub_users: 0,
      },
    ]);
  });

  it("filters by Campaign ID", () => {
    const result = buildCampaignPerformanceExport({ txs: rows, filters: { campaign_id: "campaign-1" } });

    expect(result).toHaveLength(1);
    expect(result[0].campaign_id).toBe("campaign-1");
  });
});

describe("campaign performance export refund users", () => {
  it("counts users with refunded transactions", () => {
    const fixture = [
      tx("r-1", "trial", { campaign_id: "campaign-r", gross_amount_usd: 1, net_amount_usd: 1 }),
      tx("r-1", "first_subscription", {
        campaign_id: "campaign-r",
        event_time: "2026-05-08T00:00:00Z",
        gross_amount_usd: 30,
        net_amount_usd: 0,
        refund_amount_usd: 30,
        is_refunded: true,
      }),
      tx("r-2", "trial", { campaign_id: "campaign-r", gross_amount_usd: 1, net_amount_usd: 1 }),
    ];

    const [row] = buildCampaignPerformanceExport({ txs: fixture });
    expect(row.refund_users).toBe(1);
    expect(row.trial_users).toBe(2);
  });
});
