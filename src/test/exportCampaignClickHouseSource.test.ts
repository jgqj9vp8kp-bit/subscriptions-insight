// ClickHouse source for the Campaign Performance Export API.
//
// The export's compute (compute.ts / aggregate.ts / classify.ts, 31 pinned
// tests) is untouched by the restoration — only where its input rows come from
// changed. These tests guard that swap: the flat warehouse columns must produce
// the same transaction shape the Postgres JSON hydration produced, and the query
// must keep the two properties that silently corrupt totals if lost —
// FINAL (or a re-synced transaction is counted twice) and an explicit UTC
// timestamp (or every event_time shifts by the runtime's offset).
import { describe, expect, it, vi } from "vitest";
import {
  EXPORT_TRANSACTIONS_SELECT,
  buildExportTransactionsQuery,
  loadExportTransactions,
  mapExportSourceRow,
} from "../../supabase/functions/_shared/clickhouse/exportCampaignSource.ts";
import { buildCampaignPerformanceRows } from "../../supabase/functions/export-campaign-performance/compute.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

function warehouseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    transaction_id: "tx-1",
    user_id: "user-1",
    email: "buyer@example.com",
    event_time: "2026-07-01T10:00:00.000Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    net_amount_usd: 1,
    refund_amount_usd: 0,
    is_refund: 0,
    status: "success",
    transaction_type: "trial",
    funnel: "soulmate",
    campaign_path: "soulmate-1-sp",
    campaign_id: "120249372500580659",
    utm_source: "4",
    classification_reason: "first_paid",
    billing_reason: "subscription_create",
    product_name: "Trial",
    currency: "USD",
    source: "primer_csv",
    import_batch_id: "batch-1",
    ...overrides,
  };
}

function fakeClickHouse(pages: Record<string, unknown>[][]) {
  const queries: Array<{ query: string; params?: Record<string, unknown> }> = [];
  let call = 0;
  const client = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params });
      const page = pages[call] ?? [];
      call += 1;
      return { json: async () => page };
    }),
    command: vi.fn(async () => {}),
    insert: vi.fn(async () => {}),
  } as unknown as ClickHouseClientLike;
  return { client, queries };
}

describe("query shape", () => {
  it("never selects the JSON payload columns — that is the whole point of the change", () => {
    // raw_payload + normalized_payload were 86% of the old payload's bytes and
    // are read by nothing in the export's compute path.
    expect(EXPORT_TRANSACTIONS_SELECT).not.toMatch(/raw_payload/);
    expect(EXPORT_TRANSACTIONS_SELECT).not.toMatch(/normalized_payload/);
  });

  it("selects every column the compute reads", () => {
    for (const column of [
      "transaction_id", "user_id", "normalized_email", "event_time", "amount_usd",
      "gross_amount_usd", "net_amount_usd", "refund_amount_usd", "is_refund", "status",
      "transaction_type", "funnel", "campaign_path", "campaign_id", "utm_source",
      "classification_reason", "billing_reason", "product_name", "currency", "source", "import_batch_id",
    ]) {
      expect(EXPORT_TRANSACTIONS_SELECT).toContain(column);
    }
  });

  it("uses FINAL, so a re-synced transaction is not counted twice", () => {
    expect(buildExportTransactionsQuery(1000, 0)).toMatch(/analytics_transactions FINAL/);
  });

  it("emits an explicit UTC timestamp instead of ClickHouse's local-looking default", () => {
    // Bare toString() gives "YYYY-MM-DD hh:mm:ss.mmm", which new Date() parses in
    // the runtime's own zone — every event_time would shift.
    expect(EXPORT_TRANSACTIONS_SELECT).toContain("'UTC'");
    expect(EXPORT_TRANSACTIONS_SELECT).toContain("'Z'");
  });

  it("scopes to one account by bound parameter, never string interpolation", () => {
    const sql = buildExportTransactionsQuery(500, 1000);
    expect(sql).toContain("{auth_user_id:String}");
    expect(sql).toContain("LIMIT 500 OFFSET 1000");
  });

  it("keeps the Postgres read's ordering so tie-breaking is unchanged", () => {
    expect(buildExportTransactionsQuery(10, 0)).toMatch(/ORDER BY event_time ASC, transaction_id ASC/);
  });

  it("clamps a nonsense page size or offset instead of emitting invalid SQL", () => {
    expect(buildExportTransactionsQuery(0, -5)).toContain("LIMIT 1 OFFSET 0");
    expect(buildExportTransactionsQuery(10.7, 3.9)).toContain("LIMIT 10 OFFSET 3");
  });
});

describe("money comes from the warehouse's converted columns", () => {
  // The old Postgres path read normalized_payload.net_amount_usd, which — despite
  // the name — holds the amount in the PAYMENT's currency and never carries an
  // fx_status. 23.7% of the warehouse is non-USD, so COP 105000 was exported as
  // $105000 instead of $26.25. transactionMapper writes the ClickHouse columns
  // already converted (convertAmountToUsd), so reading those columns is what makes
  // net_revenue correct. If anyone reintroduces a payload read here, this fails.
  it("selects the ClickHouse money columns, never the payload's same-named fields", () => {
    for (const column of ["amount_usd", "gross_amount_usd", "net_amount_usd", "refund_amount_usd"]) {
      // Present as a bare column reference wrapped in toFloat64(...), not as JSON access.
      expect(EXPORT_TRANSACTIONS_SELECT).toContain(`toFloat64(${column})`);
    }
    expect(EXPORT_TRANSACTIONS_SELECT).not.toMatch(/normalized_payload\s*(->|\[)/);
    expect(EXPORT_TRANSACTIONS_SELECT).not.toMatch(/JSONExtract/i);
  });

  it("passes the converted amounts through untouched — no second conversion here", () => {
    // The mapper must not re-apply FX: the column is already USD. COP 105000 at
    // 0.00025 is $26.25 in ClickHouse; the export must report exactly that.
    const tx = mapExportSourceRow(warehouseRow({
      currency: "COP", gross_amount_usd: 26.25, net_amount_usd: 26.25, amount_usd: 26.25,
    }))!;
    expect(tx.gross_amount_usd).toBe(26.25);
    expect(tx.net_amount_usd).toBe(26.25);
    expect(tx.amount_usd).toBe(26.25);
    expect(tx.currency).toBe("COP");
  });
});

describe("mapExportSourceRow", () => {
  it("maps a warehouse row onto the compute's transaction shape", () => {
    const tx = mapExportSourceRow(warehouseRow())!;
    expect(tx).toMatchObject({
      transaction_id: "tx-1",
      user_id: "user-1",
      email: "buyer@example.com",
      event_time: "2026-07-01T10:00:00.000Z",
      status: "success",
      transaction_type: "trial",
      funnel: "soulmate",
      campaign_path: "soulmate-1-sp",
      campaign_id: "120249372500580659",
      utm_source: "4",
      product: "Trial",
      currency: "USD",
      source: "primer_csv",
      import_batch_id: "batch-1",
    });
    // The classifier never reads tx.raw, so it is not fetched.
    expect(tx.raw).toEqual({});
  });

  it("keeps the money fields numeric and derives is_refunded from either signal", () => {
    const refundFlag = mapExportSourceRow(warehouseRow({ is_refund: 1, refund_amount_usd: 0 }))!;
    expect(refundFlag.is_refunded).toBe(true);
    const refundAmount = mapExportSourceRow(warehouseRow({ is_refund: 0, refund_amount_usd: 29.99 }))!;
    expect(refundAmount.is_refunded).toBe(true);
    expect(refundAmount.refund_amount_usd).toBe(29.99);
    expect(mapExportSourceRow(warehouseRow())!.is_refunded).toBe(false);
  });

  it("accepts ClickHouse's string-typed decimals", () => {
    // Decimal columns arrive as strings in JSONEachRow unless cast.
    const tx = mapExportSourceRow(warehouseRow({ gross_amount_usd: "29.99", net_amount_usd: "27.50", amount_usd: "27.50" }))!;
    expect(tx.gross_amount_usd).toBe(29.99);
    expect(tx.net_amount_usd).toBe(27.5);
    expect(tx.amount_usd).toBe(27.5);
  });

  it("falls back the way the Postgres hydration did", () => {
    const noUser = mapExportSourceRow(warehouseRow({ user_id: "", email: "only@example.com" }))!;
    expect(noUser.user_id).toBe("only@example.com");
    const noEmailEither = mapExportSourceRow(warehouseRow({ user_id: "", email: "" }))!;
    expect(noEmailEither.user_id).toBe("tx-1");
    const blankDims = mapExportSourceRow(warehouseRow({ funnel: "", campaign_path: "" }))!;
    expect(blankDims.funnel).toBe("unknown");
    expect(blankDims.campaign_path).toBe("unknown");
    const blankOptionals = mapExportSourceRow(warehouseRow({ billing_reason: "", product_name: "", utm_source: "" }))!;
    expect(blankOptionals.billing_reason).toBeUndefined();
    expect(blankOptionals.product).toBeUndefined();
    expect(blankOptionals.utm_source).toBeNull();
  });

  it("drops a row with no id or no timestamp rather than inventing one", () => {
    expect(mapExportSourceRow(warehouseRow({ transaction_id: "" }))).toBeNull();
    expect(mapExportSourceRow(warehouseRow({ event_time: "" }))).toBeNull();
    expect(mapExportSourceRow({})).toBeNull();
  });
});

describe("loadExportTransactions", () => {
  it("pages until a short page and binds the account on every request", async () => {
    const { client, queries } = fakeClickHouse([
      [warehouseRow({ transaction_id: "a" }), warehouseRow({ transaction_id: "b" })],
      [warehouseRow({ transaction_id: "c" })],
    ]);
    const rows = await loadExportTransactions(client, "user-1", 2);
    expect(rows.map((row) => row.transaction_id)).toEqual(["a", "b", "c"]);
    expect(queries).toHaveLength(2);
    expect(queries[0].params).toEqual({ auth_user_id: "user-1" });
    expect(queries[1].query).toContain("OFFSET 2");
  });

  it("returns nothing for an account with no rows, without a second request", async () => {
    const { client, queries } = fakeClickHouse([[]]);
    await expect(loadExportTransactions(client, "user-1", 100)).resolves.toEqual([]);
    expect(queries).toHaveLength(1);
  });
});

describe("end to end through the untouched compute", () => {
  it("produces the documented row contract from warehouse rows", async () => {
    // One user: trial -> upsell -> first subscription, all successful.
    const { client } = fakeClickHouse([[
      warehouseRow({ transaction_id: "t1", transaction_type: "trial", event_time: "2026-07-01T10:00:00.000Z" }),
      warehouseRow({ transaction_id: "t2", transaction_type: "upsell", event_time: "2026-07-01T10:05:00.000Z", gross_amount_usd: 9.99, net_amount_usd: 9.99, amount_usd: 9.99 }),
      warehouseRow({ transaction_id: "t3", transaction_type: "first_subscription", event_time: "2026-07-08T10:00:00.000Z", gross_amount_usd: 29.99, net_amount_usd: 29.99, amount_usd: 29.99 }),
    ]]);
    const txs = await loadExportTransactions(client, "user-1", 1000);

    const rows = buildCampaignPerformanceRows({
      txs: txs as never,
      traffic: [],
      params: { date_from: null, date_to: null, campaign_path: null, media_buyer: null, campaign_id: null },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    // Exactly the fields API_EXPORT.md documents, and no fewer.
    expect(Object.keys(row).sort()).toEqual([
      "cac", "campaign_id", "campaign_path", "date_from", "date_to", "first_sub_users",
      "funnel", "net_revenue", "refund_users", "roas", "spend", "trial_to_first_sub_cr",
      "trial_users", "upsell_cr", "upsell_users",
    ]);
    expect(row.campaign_id).toBe("120249372500580659");
    expect(row.trial_users).toBe(1);
    expect(row.upsell_users).toBe(1);
    expect(row.first_sub_users).toBe(1);
    expect(row.refund_users).toBe(0);
    // Spend is no longer exported: the three traffic-derived fields stay null,
    // which is the value the contract already returned without a snapshot.
    expect(row.spend).toBeNull();
    expect(row.cac).toBeNull();
    expect(row.roas).toBeNull();
  });

  it("still honours the date window and the campaign filter", async () => {
    const { client } = fakeClickHouse([[
      warehouseRow({ transaction_id: "in", user_id: "u-in", transaction_type: "trial", event_time: "2026-07-05T10:00:00.000Z" }),
      warehouseRow({ transaction_id: "out", user_id: "u-out", transaction_type: "trial", event_time: "2026-06-01T10:00:00.000Z" }),
    ]]);
    const txs = await loadExportTransactions(client, "user-1", 1000);

    const windowed = buildCampaignPerformanceRows({
      txs: txs as never,
      traffic: [],
      params: { date_from: "2026-07-01", date_to: "2026-07-31", campaign_path: null, media_buyer: null, campaign_id: null },
    });
    expect(windowed.reduce((sum, row) => sum + row.trial_users, 0)).toBe(1);

    const otherCampaign = buildCampaignPerformanceRows({
      txs: txs as never,
      traffic: [],
      params: { date_from: null, date_to: null, campaign_path: "not-a-real-path", media_buyer: null, campaign_id: null },
    });
    expect(otherCampaign).toEqual([]);
  });
});
