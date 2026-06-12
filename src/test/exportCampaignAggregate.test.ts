import { describe, expect, it } from "vitest";
import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from "lz-string";
import {
  extractTrafficMetrics,
  grossRevenue,
  isFailedPaymentTransaction,
  netRevenue,
  refundsTotal,
  type AggregateTxn,
} from "../../supabase/functions/export-campaign-performance/aggregate";

// P0-4: these helpers are the ACTUAL logic the served export edge function runs (index.ts imports
// the same module), so testing them here pins the edge function's behavior to the dashboard's.

describe("export aggregate revenue (P0-4)", () => {
  it("excludes refunded/chargeback sales from gross and subtracts them from net", () => {
    const txs: AggregateTxn[] = [
      { status: "success", transaction_type: "trial", gross_amount_usd: 1, net_amount_usd: 1 },
      { status: "success", transaction_type: "first_subscription", gross_amount_usd: 30, net_amount_usd: 30 },
      { status: "refunded", transaction_type: "first_subscription", gross_amount_usd: 20, net_amount_usd: 0 },
      { status: "chargeback", transaction_type: "chargeback", gross_amount_usd: 10, net_amount_usd: 0 },
      { status: "failed", transaction_type: "failed_payment", gross_amount_usd: 50, net_amount_usd: 0 },
    ];

    expect(grossRevenue(txs)).toBe(31); // only the two successful sales (1 + 30)
    expect(refundsTotal(txs)).toBe(30); // refunded 20 + chargeback 10
    expect(netRevenue(txs)).toBe(1); // 31 - 30
  });

  it("subtracts a partial refund recorded on a successful sale", () => {
    const txs: AggregateTxn[] = [
      { status: "success", transaction_type: "first_subscription", gross_amount_usd: 30, refund_amount_usd: 12 },
    ];

    expect(grossRevenue(txs)).toBe(30);
    expect(refundsTotal(txs)).toBe(12);
    expect(netRevenue(txs)).toBe(18);
  });
});

describe("export aggregate failed-payment classification (P0-4)", () => {
  it("matches token-based declines that the naive status check missed", () => {
    expect(isFailedPaymentTransaction({ status: "failed" })).toBe(true);
    expect(isFailedPaymentTransaction({ status: "success", transaction_type: "failed_payment" })).toBe(true);
    expect(isFailedPaymentTransaction({ status: "success", classification_reason: "card DECLINED" })).toBe(true);
    expect(isFailedPaymentTransaction({ status: "success", billing_reason: "AUTHORIZATION_FAILED" })).toBe(true);
    expect(isFailedPaymentTransaction({ status: "success", raw: { status: "ERROR" } })).toBe(true);
  });

  it("excludes refunds, chargebacks, and clean successes", () => {
    expect(isFailedPaymentTransaction({ status: "refunded" })).toBe(false);
    expect(isFailedPaymentTransaction({ status: "chargeback" })).toBe(false);
    expect(isFailedPaymentTransaction({ status: "success", transaction_type: "refund" })).toBe(false);
    expect(isFailedPaymentTransaction({ status: "success", transaction_type: "trial" })).toBe(false);
  });
});

describe("export aggregate traffic snapshot (P0-4)", () => {
  const metrics = [
    { date: "2026-05-01", campaign_path: "soulmate-reading", trial_count: 10, spend: 50, campaign_id: "c1" },
  ];

  it("reads plain (uncompressed) traffic snapshots", () => {
    const rows = extractTrafficMetrics({ trafficMetrics: metrics });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ campaign_path: "soulmate-reading", spend: 50, campaign_id: "c1" });
  });

  it("decompresses lz-string-compressed traffic snapshots instead of dropping them", () => {
    const compressed = {
      __subengine_compressed: true,
      algorithm: "lz-string-uri-v1",
      data: compressToEncodedURIComponent(JSON.stringify({ trafficMetrics: metrics })),
    };

    // With the decompressor the rows come back.
    const rows = extractTrafficMetrics(compressed, decompressFromEncodedURIComponent);
    expect(rows).toHaveLength(1);
    expect(rows[0].spend).toBe(50);

    // Without a decompressor (the old edge behavior) the compressed snapshot was silently dropped.
    expect(extractTrafficMetrics(compressed)).toEqual([]);
  });
});
