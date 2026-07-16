import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTransactionMappingContext,
  deterministicRowVersion,
  hydrateSupabaseTransactionRows,
  mapSupabaseTransactionsToClickHouse,
  type SupabaseTransactionRow,
} from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import { normalizeBackfillParams } from "../../supabase/functions/_shared/clickhouse/backfill.ts";
import { CLICKHOUSE_FINAL_QUERY_STRATEGY, clickHouseCursorWhereClause, compareMetric } from "../../supabase/functions/_shared/clickhouse/validation.ts";
import { CREATE_ANALYTICS_TRANSACTIONS_SQL } from "../../supabase/functions/_shared/clickhouse/schema.ts";

function row(overrides: Partial<SupabaseTransactionRow> & { normalized_payload?: Record<string, unknown> } = {}): SupabaseTransactionRow {
  const { normalized_payload: normalizedPayloadOverrides, ...rowOverrides } = overrides;
  const payload = {
    transaction_id: "tx_trial",
    user_id: "user_1",
    email: "User@Example.com",
    event_time: "2026-06-01T10:00:00.000Z",
    amount_usd: 10,
    gross_amount_usd: 10,
    refund_amount_usd: 0,
    net_amount_usd: 10,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "soulmate",
    campaign_path: "campaign-path",
    campaign_id: "cmp_1",
    product: "Trial",
    traffic_source: "facebook",
    classification_reason: "test",
    metadata: { utm_source: "4", ff_country_code: "us", paymentInstrumentBinDataAccountFundingType: "debit" },
    raw: { processor: "palmer", paymentInstrumentBinDataAccountFundingType: "debit" },
    ...normalizedPayloadOverrides,
  };
  return {
    auth_user_id: "auth_1",
    user_id: String(payload.user_id),
    transaction_id: String(payload.transaction_id),
    import_batch_id: "batch_1",
    source: "palmer_csv",
    event_time: String(payload.event_time),
    status: String(payload.status),
    transaction_type: String(payload.transaction_type),
    amount_gross: Number(payload.gross_amount_usd),
    amount_net: Number(payload.net_amount_usd),
    amount_refunded: Number(payload.refund_amount_usd),
    currency: String(payload.currency),
    email: String(payload.email),
    country_code: null,
    campaign_path: String(payload.campaign_path),
    funnel: String(payload.funnel),
    source_name: "facebook",
    raw_payload: payload.raw as Record<string, unknown>,
    normalized_payload: payload,
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:00:00.000Z",
    deleted_at: null,
    ...rowOverrides,
  };
}

describe("ClickHouse Phase 2 transaction mapper", () => {
  it("maps identity, attribution, USD money, media buyer, country and card type", () => {
    const sourceRows = [
      row({
        normalized_payload: {
          transaction_id: "tx_trial",
          gross_amount_usd: 100,
          net_amount_usd: 100,
          currency: "EUR",
          original_currency: undefined,
          fx_status: undefined,
        },
      }),
    ];
    const mapped = mapSupabaseTransactionsToClickHouse({ authUserId: "auth_1", rows: sourceRows });

    expect(mapped.rows).toHaveLength(1);
    expect(mapped.rows[0]).toMatchObject({
      auth_user_id: "auth_1",
      transaction_id: "tx_trial",
      normalized_email: "user@example.com",
      campaign_id: "cmp_1",
      media_buyer: "Ivan",
      country_code: "US",
      card_type: "debit",
      currency: "EUR",
      original_amount: 100,
      gross_amount_usd: 115,
      is_trial: 1,
      is_success: 1,
    });
  });

  it("derives lifecycle flags, renewal level, upsell ordinal and token purchase classification", () => {
    const rows = [
      row({ normalized_payload: { transaction_id: "t1", transaction_type: "trial", event_time: "2026-06-01T00:00:00Z", gross_amount_usd: 1 } }),
      row({ normalized_payload: { transaction_id: "u1", transaction_type: "upsell", event_time: "2026-06-01T00:10:00Z", gross_amount_usd: 14.98, billing_reason: "upsell" } }),
      row({ normalized_payload: { transaction_id: "u2", transaction_type: "upsell", event_time: "2026-06-01T00:20:00Z", gross_amount_usd: 14.98, billing_reason: "upsell" } }),
      row({ normalized_payload: { transaction_id: "s1", transaction_type: "first_subscription", event_time: "2026-06-05T00:00:00Z", gross_amount_usd: 29.99 } }),
      row({ normalized_payload: { transaction_id: "r2", transaction_type: "renewal_2", event_time: "2026-07-05T00:00:00Z", gross_amount_usd: 29.99 } }),
      row({ normalized_payload: { transaction_id: "tok", transaction_type: "token_purchase", event_time: "2026-06-01T01:00:00Z", gross_amount_usd: 4.99, product: "100 tokens" } }),
    ];
    const context = buildTransactionMappingContext(hydrateSupabaseTransactionRows(rows));
    const mapped = mapSupabaseTransactionsToClickHouse({ authUserId: "auth_1", rows, context }).rows;
    const byId = Object.fromEntries(mapped.map((entry) => [entry.transaction_id, entry]));

    expect(byId.s1.is_first_subscription).toBe(1);
    expect(byId.r2).toMatchObject({ is_renewal: 1, subscription_level: 2, payment_stage: "renewal" });
    expect(byId.u1.upsell_ordinal).toBe(1);
    expect(byId.u2.upsell_ordinal).toBe(2);
    expect(byId.tok.is_token_purchase).toBe(1);
  });

  it("sets failed, refund and chargeback flags and normalizes decline reason", () => {
    const rows = [
      row({
        normalized_payload: {
          transaction_id: "failed",
          status: "failed",
          transaction_type: "failed_payment",
          raw: { payment_method_result_code: "51", message: "insufficient funds" },
        },
      }),
      row({ normalized_payload: { transaction_id: "refund", status: "refunded", transaction_type: "refund", refund_amount_usd: 10 } }),
      row({ normalized_payload: { transaction_id: "chargeback", status: "chargeback", transaction_type: "chargeback" } }),
    ];
    const mapped = mapSupabaseTransactionsToClickHouse({ authUserId: "auth_1", rows }).rows;
    const byId = Object.fromEntries(mapped.map((entry) => [entry.transaction_id, entry]));

    expect(byId.failed).toMatchObject({ is_failed: 1, decline_reason: "insufficient_funds" });
    expect(byId.refund.is_refund).toBe(1);
    expect(byId.chargeback.is_chargeback).toBe(1);
  });

  it("skips malformed rows and reports missing FX/campaign diagnostics", () => {
    const mapped = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [
        row({ transaction_id: "", event_time: "not-a-date", normalized_payload: { transaction_id: "", event_time: "not-a-date" } }),
        row({ normalized_payload: { transaction_id: "fx", campaign_id: "", currency: "ZZZ", gross_amount_usd: 10 } }),
      ],
    });

    expect(mapped.rows).toHaveLength(1);
    expect(mapped.diagnostics.malformed_rows).toBe(1);
    expect(mapped.diagnostics.missing_campaign_id).toBe(1);
    expect(mapped.diagnostics.missing_fx_rate).toBe(1);
    expect(mapped.rows[0].gross_amount_usd).toBe(0);
  });

  it("uses deterministic row versions", () => {
    const basis = { transaction_id: "tx", updated_at: "2026-06-01T00:00:00Z", event_time: "2026-06-01T00:00:00Z" };
    expect(deterministicRowVersion(basis)).toBe(deterministicRowVersion(basis));
    expect(deterministicRowVersion({ ...basis, updated_at: "2026-06-02T00:00:00Z" })).not.toBe(deterministicRowVersion(basis));
  });
});

describe("ClickHouse Phase 2 controls and validation helpers", () => {
  it("clamps controlled backfill params", () => {
    expect(normalizeBackfillParams({ batch_size: 100_000, max_batches: 0, mode: "full_backfill" })).toMatchObject({
      mode: "full_backfill",
      batch_size: 10000,
      max_batches: 1,
    });
  });

  it("uses FINAL for ReplacingMergeTree validation", () => {
    expect(CLICKHOUSE_FINAL_QUERY_STRATEGY).toContain("FINAL");
  });

  it("supports scoped validation for the imported cursor range", () => {
    const clause = clickHouseCursorWhereClause({
      cursor_updated_at: "2026-06-01T00:00:00.000Z",
      cursor_transaction_id: "tx_100",
    });
    expect(clause).toContain("source_updated_at");
    expect(clause).toContain("cursor_transaction_id");
  });

  it("detects count mismatches exactly and revenue within tolerance", () => {
    expect(compareMetric("total_rows", 10, 11).status).toBe("FAIL");
    expect(compareMetric("net_revenue_usd", 1000, 1000.05).status).toBe("PASS");
    expect(compareMetric("net_revenue_usd", 1000, 1002).status).toBe("FAIL");
  });

  it("defines the required wide fact table fields", () => {
    for (const field of ["auth_user_id", "transaction_id", "raw_payload", "normalized_payload", "row_version"]) {
      expect(CREATE_ANALYTICS_TRANSACTIONS_SQL).toContain(field);
    }
    expect(CREATE_ANALYTICS_TRANSACTIONS_SQL).toContain("ReplacingMergeTree(row_version)");
  });

  it("keeps ClickHouse credentials out of the frontend bridge", () => {
    const service = readFileSync(resolve(process.cwd(), "src/services/clickhouse.ts"), "utf8");
    expect(service).not.toContain("CLICKHOUSE_PASSWORD");
    expect(service).not.toContain("CLICKHOUSE_HOST");
    expect(service).not.toContain(["", "api", "clickhouse"].join("/"));
    expect(service).toContain("clickhouse-health");
    expect(service).toContain("supabase.functions.invoke");
  });

  it("defines Supabase Edge Function entrypoints for every ClickHouse action", () => {
    for (const functionName of ["clickhouse-health", "clickhouse-init", "clickhouse-backfill", "clickhouse-validate", "clickhouse-summary"]) {
      const source = readFileSync(resolve(process.cwd(), `supabase/functions/${functionName}/index.ts`), "utf8");
      expect(source).toContain("requireSupabaseUser");
      expect(source).toContain("Deno.serve");
    }
  });
});
