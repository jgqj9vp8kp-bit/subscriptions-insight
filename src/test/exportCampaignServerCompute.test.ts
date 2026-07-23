import { describe, expect, it } from "vitest";
import {
  buildCampaignPerformanceRows,
  type ComputeTxn,
} from "../../supabase/functions/export-campaign-performance/compute";
import type { TrafficMetricLike } from "../../supabase/functions/export-campaign-performance/aggregate";

// These tests exercise the SAME pure module the served edge function (index.ts) calls. They take
// warehouse-shaped rows (as loaded from public.transactions) and never touch the Zustand store,
// IndexedDB, or any frontend cache — proving the Export API is self-sufficient server-side.

function wtx(overrides: Partial<ComputeTxn> & { user_id: string; transaction_id: string; event_time: string }): ComputeTxn {
  const amount = overrides.amount_usd ?? overrides.gross_amount_usd ?? 1;
  return {
    status: "success",
    transaction_type: "trial",
    amount_usd: amount,
    gross_amount_usd: overrides.gross_amount_usd ?? amount,
    net_amount_usd: overrides.net_amount_usd ?? amount,
    refund_amount_usd: overrides.refund_amount_usd ?? 0,
    is_refunded: overrides.is_refunded ?? false,
    campaign_id: overrides.campaign_id ?? "c1",
    campaign_path: overrides.campaign_path ?? "p1",
    funnel: overrides.funnel ?? "past_life",
    source: overrides.source ?? "palmer_csv",
    ...overrides,
  };
}

// A normal warehouse user: $1 trial, optional $14.98 upsell, optional $29 first subscription.
function userRows(userId: string, opts: { upsell?: boolean; sub?: boolean; campaignId?: string; path?: string } = {}): ComputeTxn[] {
  const base = { campaign_id: opts.campaignId ?? "c1", campaign_path: opts.path ?? "p1" };
  return [
    wtx({ ...base, user_id: userId, transaction_id: `${userId}-t`, event_time: "2026-05-01T10:00:00Z", gross_amount_usd: 1 }),
    ...(opts.upsell ? [wtx({ ...base, user_id: userId, transaction_id: `${userId}-u`, event_time: "2026-05-01T10:05:00Z", gross_amount_usd: 14.98 })] : []),
    ...(opts.sub ? [wtx({ ...base, user_id: userId, transaction_id: `${userId}-s`, event_time: "2026-05-08T10:00:00Z", gross_amount_usd: 29 })] : []),
  ];
}

describe("export campaign performance — server-side compute", () => {
  it("token packs classify as token_purchase via the SHARED classifier — never renewals (drift fix)", () => {
    // $4.99 "500 tokens" purchase inside the 72h add-on window after the first
    // subscription: the retired local port counted it as a renewal.
    const txs: ComputeTxn[] = [
      ...userRows("u1", { sub: true }),
      wtx({
        user_id: "u1",
        transaction_id: "u1-token",
        event_time: "2026-05-09T10:00:00Z",
        gross_amount_usd: 4.99,
        product: "500 tokens pack",
        currency: "USD",
      }),
    ];
    const [row] = buildCampaignPerformanceRows({ txs });
    // The token purchase must not occupy a renewal/first-sub slot...
    expect(row.first_sub_users).toBe(1);
    // ...and it is EXCLUDED from net_revenue: the export mirrors the dashboard's
    // cash-revenue type list, which does not include token_purchase yet
    // (TODO_MONETIZATION item 1 adds it to BOTH surfaces together). The retired
    // port used to leak it in as a fake renewal.
    expect(row.net_revenue).toBeCloseTo(1 + 29, 2);
  });

  it("1. computes metrics from warehouse rows alone (no frontend cache)", () => {
    const txs = [...userRows("u1", { upsell: true, sub: true }), ...userRows("u2")];
    const [row] = buildCampaignPerformanceRows({ txs });

    expect(row).toMatchObject({
      campaign_id: "c1",
      campaign_path: "p1",
      funnel: "past_life",
      trial_users: 2,
      upsell_users: 1,
      first_sub_users: 1,
      trial_to_first_sub_cr: 0.5,
    });
  });

  it("2. returns updated metrics after more rows are imported into the warehouse", () => {
    const before = buildCampaignPerformanceRows({ txs: [...userRows("u1", { sub: true }), ...userRows("u2")] });
    expect(before[0]).toMatchObject({ trial_users: 2, first_sub_users: 1 });

    // Simulate a later warehouse import adding a third converting user — no recalc step in between.
    const after = buildCampaignPerformanceRows({
      txs: [...userRows("u1", { sub: true }), ...userRows("u2"), ...userRows("u3", { sub: true })],
    });
    expect(after[0]).toMatchObject({ trial_users: 3, first_sub_users: 2 });
  });

  it("3. returns spend / CAC / ROAS from a saved traffic snapshot", () => {
    const txs = [...userRows("u1", { sub: true }), ...userRows("u2", { sub: true })];
    const traffic: TrafficMetricLike[] = [
      { date: "2026-05-02", campaign_path: "p1", trial_count: 50, spend: 300, campaign_id: null, media_buyer: null, utm_source: null },
    ];

    const [row] = buildCampaignPerformanceRows({ txs, traffic });

    // net revenue = 2 users * (1 trial + 29 sub) = 60; spend 300 over an exclusive path.
    expect(row.net_revenue).toBe(60);
    expect(row.spend).toBe(300);
    expect(row.cac).toBe(150); // 300 / 2 trial users
    expect(row.roas).toBe(0.2); // 60 / 300
  });

  it("3b. spend is null (unattributable) when two campaigns share a path", () => {
    const txs = [...userRows("u1", { campaignId: "c1", path: "shared" }), ...userRows("u2", { campaignId: "c2", path: "shared" })];
    const traffic: TrafficMetricLike[] = [
      { date: "2026-05-01", campaign_path: "shared", trial_count: 10, spend: 500, campaign_id: null, media_buyer: null, utm_source: null },
    ];

    const rows = buildCampaignPerformanceRows({ txs, traffic });
    expect(rows.every((row) => row.spend === null && row.cac === null && row.roas === null)).toBe(true);
  });

  it("4. works with an empty traffic snapshot (spend metrics null, conversions intact)", () => {
    const [row] = buildCampaignPerformanceRows({ txs: userRows("u1", { sub: true }), traffic: [] });
    expect(row).toMatchObject({ trial_users: 1, first_sub_users: 1, spend: null, cac: null, roas: null });
  });

  it("5. re-classifies stored types so output never depends on a frontend recalc", () => {
    // Warehouse holds the per-import-batch artifact: a June subscription was imported in its own CSV
    // (no trial in that batch) and stored as "trial". The frontend fixes this only in its local cache.
    const txs: ComputeTxn[] = [
      wtx({ user_id: "u1", transaction_id: "u1-t", event_time: "2026-05-01T10:00:00Z", gross_amount_usd: 1, transaction_type: "trial" }),
      wtx({ user_id: "u1", transaction_id: "u1-s", event_time: "2026-06-01T10:00:00Z", gross_amount_usd: 29, transaction_type: "trial" }), // WRONG stored type
    ];

    const [row] = buildCampaignPerformanceRows({ txs });

    // The Edge re-derives over full history: May = trial, June = first_subscription.
    expect(row.trial_users).toBe(1);
    expect(row.first_sub_users).toBe(1);

    // Deterministic: identical DB rows always yield identical output, regardless of any browser state.
    const again = buildCampaignPerformanceRows({ txs });
    expect(again).toEqual([row]);
  });
});
