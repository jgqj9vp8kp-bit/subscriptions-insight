import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import {
  isCompressedSnapshotEnvelope,
  resolveSnapshotEnvelope,
} from "../../supabase/functions/_shared/clickhouse/snapshotEnvelope.ts";
import {
  computeFbAnalyticsSummary,
  reconcileFbAnalyticsSummaries,
} from "../../supabase/functions/_shared/clickhouse/fbAnalyticsSummary.ts";
import { buildFbAnalytics } from "../../supabase/functions/_shared/clickhouse/fbAnalyticsCompute.ts";
import { backfillTransactionCardTypesFromRawRows } from "../../supabase/functions/_shared/clickhouse/palmerTransform.ts";
import { enrichTransactionDeclinesFromRawRows } from "../../supabase/functions/_shared/clickhouse/paymentFailures.ts";
import { aggregateTrafficMetrics } from "../../supabase/functions/_shared/clickhouse/cohortReporting.ts";
import type { CapsuledFacebookRow, TrafficMetric } from "../../supabase/functions/_shared/clickhouse/trafficMetric.ts";
import type { Transaction } from "../../supabase/functions/_shared/clickhouse/serviceTypes.ts";

function tx(userId: string, type: Transaction["transaction_type"], overrides: Partial<Transaction> = {}): Transaction {
  const amount = type === "trial" ? 1 : type === "upsell" ? 5 : 10;
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${type}-${overrides.event_time ?? "2026-05-01T00:00:00Z"}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: "2026-05-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: amount,
    refund_amount_usd: 0,
    net_amount_usd: amount,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: type,
    funnel: "soulmate",
    campaign_path: "path-a",
    product: "",
    traffic_source: "facebook",
    campaign_id: "120001",
    classification_reason: "",
    ...overrides,
  } as Transaction;
}

const transactions: Transaction[] = [
  tx("u1", "trial"),
  tx("u1", "upsell", { event_time: "2026-05-01T00:05:00Z" }),
  tx("u1", "first_subscription", { event_time: "2026-05-08T00:00:00Z" }),
  tx("u2", "trial", { campaign_id: "120002", campaign_path: "path-b" }),
  tx("u2", "failed_payment", {
    campaign_id: "120002",
    campaign_path: "path-b",
    event_time: "2026-05-09T00:00:00Z",
    status: "failed",
  }),
];

// Raw Palmer rows that fill u1's missing card type and decline details for u2.
const rawPalmerRows = [
  { transactionId: "u1-trial-2026-05-01T00:00:00Z", paymentInstrument: '{"binData":{"prepaidReloadable":"CREDIT"}}' },
  {
    transactionId: "u2-failed_payment-2026-05-09T00:00:00Z",
    metadata: '{"decline_reason":"insufficient_funds"}',
    status: "DECLINED",
  },
] as unknown as Parameters<typeof backfillTransactionCardTypesFromRawRows>[1];

const trafficRows: TrafficMetric[] = [
  { date: "2026-05-01", campaign_path: "path-a", trial_count: 1, cac: 12, spend: 12, clicks: 30, cpc: 0.4, cpm: 0, ctr: 0, source: "facebook" },
];

const capsuledRows: CapsuledFacebookRow[] = [
  {
    date_from: "2026-05-01",
    date_to: "2026-05-01",
    level: "campaign",
    campaign_id: "120002",
    campaign_name: "Beta",
    ad_account_id: "act_1",
    ad_account_name: "Acc",
    spend: 25,
    fb_purchases: 2,
    cpp: 12.5,
    impressions: 1000,
    clicks: 40,
    ctr: 4,
    cpc: 0.62,
    cpm: 25,
    outbound_clicks: 10,
    outbound_ctr: 1,
    currency: "USD",
    last_import_at: "2026-05-02T00:00:00Z",
    raw_payload: null,
  },
  {
    date_from: "2026-05-01",
    date_to: "2026-05-01",
    level: "day",
    campaign_id: null,
    campaign_name: null,
    ad_account_id: null,
    ad_account_name: null,
    spend: 25,
    fb_purchases: 2,
    cpp: null,
    impressions: 1000,
    clicks: 40,
    ctr: null,
    cpc: null,
    cpm: null,
    outbound_clicks: 10,
    outbound_ctr: null,
    currency: "USD",
    last_import_at: "2026-05-02T00:00:00Z",
    raw_payload: null,
  },
];

const palmerPayload = { payload_version: 1, transactions, rawPalmerRows };
const subscriptionsPayload = { subscriptions: [] };
const trafficPayload = { trafficMetrics: trafficRows };

describe("snapshot envelope", () => {
  it("passes plain payloads through and unwraps compressed envelopes", () => {
    expect(resolveSnapshotEnvelope<typeof trafficPayload>(trafficPayload, decompressFromEncodedURIComponent)).toEqual(trafficPayload);

    const envelope = {
      __subengine_compressed: true,
      algorithm: "lz-string-uri-v1",
      data: compressToEncodedURIComponent(JSON.stringify(palmerPayload)),
      original_size_kb: 1,
      compressed_size_kb: 1,
    };
    expect(isCompressedSnapshotEnvelope(envelope)).toBe(true);
    expect(resolveSnapshotEnvelope<typeof palmerPayload>(envelope, decompressFromEncodedURIComponent)).toEqual(palmerPayload);
  });

  it("returns null for corrupted envelope data", () => {
    const envelope = {
      __subengine_compressed: true,
      algorithm: "lz-string-uri-v1",
      data: "%%%not-lz%%%",
      original_size_kb: 1,
      compressed_size_kb: 1,
    };
    expect(resolveSnapshotEnvelope(envelope, decompressFromEncodedURIComponent)).toBeNull();
  });
});

describe("computeFbAnalyticsSummary", () => {
  it("reproduces the FBAnalytics page compute exactly (enrichment chain + campaign-level capsuled rows)", () => {
    const expected = buildFbAnalytics({
      txs: enrichTransactionDeclinesFromRawRows(
        backfillTransactionCardTypesFromRawRows(transactions, rawPalmerRows),
        rawPalmerRows,
      ),
      subscriptions: [],
      trafficByKey: aggregateTrafficMetrics(trafficRows),
      capsuledRows: capsuledRows.filter((row) => row.level === "campaign"),
      filters: {},
    });

    const actual = computeFbAnalyticsSummary({
      palmerPayload,
      subscriptionsPayload,
      trafficPayload,
      capsuledRows,
      filters: {},
    });

    expect(actual.rows).toEqual(expected.rows);
    expect(actual.summary).toEqual(expected.summary);
    // The enrichment chain must actually have fired: the imported-only capsuled campaign
    // row is present, and the raw-row card type made it into the compute.
    expect(actual.rows.some((row) => row.campaign_id === "120002" && row.spend === 25)).toBe(true);
  });

  it("survives a JSON serialization round-trip (what the Edge Function actually returns)", () => {
    const direct = computeFbAnalyticsSummary({ palmerPayload, subscriptionsPayload, trafficPayload, capsuledRows, filters: {} });
    const roundTripped = JSON.parse(JSON.stringify(direct)) as typeof direct;
    expect(reconcileFbAnalyticsSummaries(roundTripped.summary, direct.summary)).toEqual([]);
    expect(roundTripped.rows).toEqual(direct.rows);
  });

  it("reports input fingerprints and tolerates missing snapshots", () => {
    const full = computeFbAnalyticsSummary({
      palmerPayload,
      subscriptionsPayload,
      trafficPayload,
      capsuledRows,
      filters: {},
      snapshotUpdatedAt: { palmer: "2026-05-02T00:00:00Z", subscriptions: null, traffic: "2026-05-02T01:00:00Z" },
    });
    expect(full.meta).toMatchObject({
      transactions: transactions.length,
      raw_palmer_rows: 2,
      traffic_rows: 1,
      capsuled_rows: 2,
      capsuled_campaign_rows: 1,
      palmer_snapshot_updated_at: "2026-05-02T00:00:00Z",
      traffic_snapshot_updated_at: "2026-05-02T01:00:00Z",
    });

    const empty = computeFbAnalyticsSummary({
      palmerPayload: null,
      subscriptionsPayload: null,
      trafficPayload: null,
      capsuledRows: [],
      filters: {},
    });
    expect(empty.ok).toBe(true);
    expect(empty.rows).toEqual([]);
    expect(empty.meta.transactions).toBe(0);
  });

  it("applies filters through to the compute", () => {
    const filtered = computeFbAnalyticsSummary({
      palmerPayload,
      subscriptionsPayload,
      trafficPayload,
      capsuledRows,
      filters: { campaignPathFilter: "path-b" },
    });
    expect(filtered.rows.every((row) => row.campaign_id !== "120001" || row.trial_users === 0)).toBe(true);
  });
});

describe("reconcileFbAnalyticsSummaries", () => {
  it("accepts identical summaries and flags drifted metrics", () => {
    const { summary } = computeFbAnalyticsSummary({ palmerPayload, subscriptionsPayload, trafficPayload, capsuledRows, filters: {} });
    expect(reconcileFbAnalyticsSummaries(summary, summary)).toEqual([]);

    const drifted = { ...summary, netRevenue: summary.netRevenue + 1 };
    const mismatches = reconcileFbAnalyticsSummaries(drifted, summary);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].metric).toBe("netRevenue");
  });

  it("treats null-vs-number as a mismatch and null-vs-null as equal", () => {
    const { summary } = computeFbAnalyticsSummary({ palmerPayload, subscriptionsPayload, trafficPayload, capsuledRows, filters: {} });
    const withNullSpend = { ...summary, spend: null, cac: null, roas: null, profit: null };
    expect(reconcileFbAnalyticsSummaries(withNullSpend, withNullSpend)).toEqual([]);
    const mismatches = reconcileFbAnalyticsSummaries(withNullSpend, summary);
    expect(mismatches.map((m) => m.metric).sort()).toEqual(["cac", "profit", "roas", "spend"]);
  });
});
