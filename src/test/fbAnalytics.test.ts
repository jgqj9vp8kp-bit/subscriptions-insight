import { describe, expect, it } from "vitest";
import { aggregateTrafficMetrics } from "@/services/cohortReporting";
import {
  buildFbAnalytics,
  fbAnalyticsReconciliation,
  reconcileFbAnalyticsTotals,
} from "@/services/fbAnalytics";
import type { Transaction, TransactionType } from "@/services/types";
import type { TrafficMetric } from "@/services/trafficImport";

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
    campaign_path: overrides.campaign_path ?? "path-a",
    product: "",
    traffic_source: overrides.traffic_source ?? "facebook",
    campaign_id: overrides.campaign_id ?? "campaign-a",
    classification_reason: "",
    metadata: overrides.metadata,
    raw: overrides.raw,
    normalized_decline_reason: overrides.normalized_decline_reason,
    card_type: overrides.card_type,
    ...overrides,
  };
}

function userRows(
  userId: string,
  campaignId: string,
  options: { path?: string; campaignName?: string; upsell?: boolean; country?: string; cardType?: Transaction["card_type"] } = {},
): Transaction[] {
  const base = {
    campaign_id: campaignId,
    campaign_path: options.path ?? "path-a",
    raw: options.campaignName ? { campaign: { name: options.campaignName } } : undefined,
    metadata: options.country ? { ff_country_code: options.country } : undefined,
    card_type: options.cardType,
  };
  return [
    tx(userId, "trial", base),
    ...(options.upsell === false ? [] : [tx(userId, "upsell", { ...base, event_time: "2026-05-01T00:05:00Z" })]),
    tx(userId, "first_subscription", { ...base, event_time: "2026-05-08T00:00:00Z" }),
  ];
}

const rows: Transaction[] = [
  ...userRows("a1", "120394857", { campaignName: "Alpha", country: "US", cardType: "credit" }),
  ...userRows("a2", "120394857", { campaignName: "Alpha", country: "CA", cardType: "debit" }),
  ...userRows("b1", "120394858", { campaignName: "Beta", upsell: false, country: "US", cardType: "credit" }),
  ...userRows("other_path", "120394859", { path: "path-b", campaignName: "Other" }),
  tx("a1", "failed_payment", {
    campaign_id: "120394857",
    campaign_path: "path-a",
    event_time: "2026-05-09T00:00:00Z",
    status: "failed",
    normalized_decline_reason: "insufficient_funds",
  }),
  tx("a2", "failed_payment", {
    campaign_id: "120394857",
    campaign_path: "path-a",
    event_time: "2026-05-09T00:00:00Z",
    status: "failed",
    normalized_decline_reason: "insufficient_funds",
  }),
  tx("b1", "failed_payment", {
    campaign_id: "120394858",
    campaign_path: "path-a",
    event_time: "2026-05-09T00:00:00Z",
    status: "failed",
    normalized_decline_reason: "do_not_honor",
  }),
];

describe("FB Analytics", () => {
  it("builds rows from Facebook trial users and filters by campaign path", () => {
    const result = buildFbAnalytics({ txs: rows, filters: { campaignPathFilter: "path-b" } });

    expect(result.rows.map((row) => [row.campaign_id, row.trial_users])).toEqual([["120394859", 1]]);
  });

  it("uses weighted summary rates instead of averaging campaign rates", () => {
    const result = buildFbAnalytics({ txs: rows, filters: { campaignPathFilter: "path-a" } });

    expect(result.rows.map((row) => [row.campaign_id, row.trial_users, row.upsell_users])).toEqual([
      ["120394857", 2, 2],
      ["120394858", 1, 0],
    ]);
    expect(result.summary.trialUsers).toBe(3);
    expect(result.summary.upsellUsers).toBe(2);
    expect(result.summary.upsellCr).toBeCloseTo((2 / 3) * 100);
  });

  it("falls back to Campaign ID attribution when Facebook traffic source is missing", () => {
    const unattributedRows = rows.map((row) => ({
      ...row,
      traffic_source: "unknown" as const,
      utm_source: "4",
    }));

    const result = buildFbAnalytics({ txs: unattributedRows, filters: { campaignPathFilter: "path-a" } });

    expect(result.rows.map((row) => [row.campaign_id, row.trial_users, row.upsell_users])).toEqual([
      ["120394857", 2, 2],
      ["120394858", 1, 0],
    ]);
    expect(result.summary.trialUsers).toBe(3);
    expect(result.summary.netRevenue).toBeGreaterThan(0);
  });

  it("searches by Campaign ID and Campaign Name", () => {
    expect(buildFbAnalytics({ txs: rows, filters: { campaignIdSearch: "beta" } }).rows).toMatchObject([
      { campaign_id: "120394858", campaign_name: "Beta" },
    ]);
    expect(buildFbAnalytics({ txs: rows, filters: { campaignIdSearch: "120394857" } }).rows).toMatchObject([
      { campaign_id: "120394857", campaign_name: "Alpha" },
    ]);
  });

  it("respects GEO and Card Type filters together", () => {
    const result = buildFbAnalytics({
      txs: rows,
      filters: { campaignPathFilter: "path-a", selectedCountries: ["US"], selectedCardTypes: ["credit"] },
    });

    expect(result.rows.map((row) => [row.campaign_id, row.trial_users])).toEqual([
      ["120394857", 1],
      ["120394858", 1],
    ]);
  });

  it("keeps a user with successful trials in two campaigns inside both campaign rows, attributing the trial user to the first trial only", () => {
    const multi: Transaction[] = [
      tx("m1", "trial", { campaign_id: "111", event_time: "2026-05-01T00:00:00Z" }),
      tx("m1", "trial", { campaign_id: "222", event_time: "2026-05-03T00:00:00Z", transaction_id: "m1-second-trial" }),
      tx("m1", "first_subscription", { campaign_id: "111", event_time: "2026-05-08T00:00:00Z" }),
      tx("m2", "trial", { campaign_id: "222", event_time: "2026-05-01T00:00:00Z" }),
    ];

    const result = buildFbAnalytics({ txs: multi });
    const byId = new Map(result.rows.map((row) => [row.campaign_id, row]));

    // Campaign 222 is an option through m2's first trial; m1's full history joins that row too
    // (any-matching-trial attribution), while m1 counts as a trial USER only under campaign 111.
    expect(byId.get("111")).toMatchObject({ trial_users: 1, first_subscription_users: 1 });
    expect(byId.get("222")).toMatchObject({ trial_users: 2, first_subscription_users: 1 });
    expect(byId.get("222")?.failed_payment_users).toBe(0);
  });

  it("counts failed payment users and top decline reason inside trial-user campaign groups", () => {
    const result = buildFbAnalytics({ txs: rows, filters: { campaignIdSearch: "Alpha" } });

    expect(result.rows[0]).toMatchObject({
      campaign_id: "120394857",
      failed_payment_users: 2,
      main_decline_reason: "insufficient_funds",
    });
  });

  it("only assigns cohort-level spend when one Campaign ID remains in context", () => {
    const trafficRows: TrafficMetric[] = [
      { date: "2026-05-01", campaign_path: "path-b", trial_count: 1, cac: 12, spend: 12, clicks: 30, cpc: 0.4, cpm: 0, ctr: 0, source: "facebook" },
    ];

    const result = buildFbAnalytics({
      txs: rows,
      trafficByKey: aggregateTrafficMetrics(trafficRows),
      filters: { campaignPathFilter: "path-b" },
    });

    expect(result.rows).toMatchObject([{ campaign_id: "120394859", spend: 12, cac: 12, roas: expect.any(Number) }]);
    expect(result.summary.spend).toBe(12);
  });
});

describe("FB Analytics spend / CAC / ROAS (Phase 5)", () => {
  const trafficRows: TrafficMetric[] = [
    { date: "2026-05-01", campaign_path: "path-a", trial_count: 3, cac: 4, spend: 12, clicks: 30, cpc: 0.4, cpm: 0, ctr: 0, source: "facebook" },
    { date: "2026-05-01", campaign_path: "path-b", trial_count: 1, cac: 8, spend: 8, clicks: 10, cpc: 0.8, cpm: 0, ctr: 0, source: "facebook" },
  ];

  it("attributes spend to a Campaign ID with an exclusive path even when other campaigns are in scope", () => {
    const result = buildFbAnalytics({ txs: rows, trafficByKey: aggregateTrafficMetrics(trafficRows) });
    const byId = Object.fromEntries(result.rows.map((row) => [row.campaign_id, row]));

    // path-b is used by only one campaign -> spend/CAC/ROAS are computed.
    expect(byId["120394859"].spend).toBe(8);
    expect(byId["120394859"].spend_status).toBe("available");
    expect(byId["120394859"].cac).toBe(8); // 8 spend / 1 trial
    expect(byId["120394859"].roas).toBe(2); // 16 net / 8 spend

    // path-a is shared by 120394857 and 120394858 -> exact attribution impossible, surfaced explicitly.
    expect(byId["120394857"].spend).toBeNull();
    expect(byId["120394857"].spend_status).toBe("unavailable_shared_path");
    expect(byId["120394858"].spend_status).toBe("unavailable_shared_path");
  });

  it("marks spend unavailable (no traffic data) and never silently returns null without a reason", () => {
    const result = buildFbAnalytics({ txs: rows });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.spend === null && row.spend_status === "no_traffic_data")).toBe(true);
    expect(result.summary.spend).toBeNull();
  });
});

describe("FB Analytics funnel filtering and renewal metrics (Phase 4)", () => {
  it("filters Campaign IDs by funnel", () => {
    const starseed = userRows("p1", "888", { path: "path-p" }).map((row) => ({ ...row, funnel: "starseed" as const }));
    const result = buildFbAnalytics({ txs: [...rows, ...starseed], filters: { funnelFilter: "starseed" } });

    expect(result.rows.map((row) => row.campaign_id)).toEqual(["888"]);
    expect(result.rows[0].trial_users).toBe(1);
  });

  it("reports renewal metrics per Campaign ID using the canonical sequence", () => {
    const renewalRows = [
      ...userRows("r1", "999", { path: "path-r" }),
      tx("r1", "renewal_2", { campaign_id: "999", campaign_path: "path-r", event_time: "2026-05-15T00:00:00Z" }),
      tx("r1", "renewal_3", { campaign_id: "999", campaign_path: "path-r", event_time: "2026-05-22T00:00:00Z" }),
    ];
    const result = buildFbAnalytics({ txs: renewalRows });
    const row = result.rows.find((entry) => entry.campaign_id === "999");

    expect(row).toBeDefined();
    expect(row!.first_subscription_users).toBe(1);
    expect(row!.renewal_2_users).toBe(1);
    expect(row!.renewal_3_users).toBe(1);
  });
});

describe("FB Analytics reconciliation with Cohorts (Phase 6)", () => {
  it("FB Analytics totals match the Cohorts baseline for the same filters", () => {
    const comparisons = fbAnalyticsReconciliation({ txs: rows });
    for (const comparison of comparisons) {
      expect(comparison.mismatch, `${comparison.metric}: FB ${comparison.fbValue} vs Cohorts ${comparison.cohortValue}`).toBe(false);
    }
    expect(comparisons.find((row) => row.metric === "Trial Users")).toMatchObject({ fbValue: 4, cohortValue: 4 });
    expect(comparisons.find((row) => row.metric === "Gross Rev")?.fbValue).toBe(59);
  });

  it("flags a mismatch above the 0.1% tolerance", () => {
    const comparisons = reconcileFbAnalyticsTotals(
      { trialUsers: 100, upsellUsers: 10, firstSubscriptionUsers: 50, grossRevenue: 1000, netRevenue: 900 },
      { totalTrialUsers: 100, totalUpsellUsers: 10, totalFirstSubscriptionUsers: 50, grossRevenue: 1000, netRevenue: 800 },
    );

    expect(comparisons.find((row) => row.metric === "Net Rev")?.mismatch).toBe(true);
    expect(comparisons.find((row) => row.metric === "Trial Users")?.mismatch).toBe(false);
  });
});
