// Payment health P0 columns through the transaction mapper (plan T).
//
// Every fixture is synthetic (made-up ids, MIDs, descriptors, instrument keys).
// What matters: each column is read from the stored raw_payload (the Primer
// CSV row), the LAST declineReasons record is the final outcome, the record
// count survives, amount_authorized takes the amount's currency-aware
// minor-unit rule, and the new fields sit at the tail in the ALTER order.
import { describe, expect, it } from "vitest";
import {
  mapSupabaseTransactionsToClickHouse,
  paymentHealthColumns,
  type SupabaseTransactionRow,
} from "../../supabase/functions/_shared/clickhouse/transactionMapper";
import { ALTER_PAYMENT_HEALTH_COLUMNS_SQL, CREATE_ANALYTICS_TRANSACTIONS_SQL } from "../../supabase/functions/_shared/clickhouse/schema";
import { hydrateSupabaseTransactionRows } from "../../supabase/functions/_shared/clickhouse/transactionMapper";

const TWO_RECORDS =
  "[{'decline_reason': 'ISSUER_TEMPORARILY_UNAVAILABLE', 'message': 'Try again later', 'payment_method_result_code': '91', " +
  "'payment_method_result_message': 'Issuer unavailable', 'payment_method_advice_code': None, 'payment_method_advice_message': None, " +
  "'advised_action': 'RETRY_LATER', 'transaction_lifecycle_event': 'AUTHORIZATION_FAILED', 'transaction_type': 'SALE', 'created_at': None}, " +
  "{'decline_reason': 'LOST_OR_STOLEN_CARD', 'message': \"Card's been reported\", 'payment_method_result_code': '41', " +
  "'payment_method_result_message': 'Lost card', 'payment_method_advice_code': '21', 'payment_method_advice_message': 'Do not try again', " +
  "'advised_action': 'STOP_ALL_PAYMENTS', 'transaction_lifecycle_event': 'AUTHORIZATION_DECLINED', 'transaction_type': 'SALE', 'created_at': None}]";

function row(over: {
  transaction_id: string;
  status?: string;
  currency?: string;
  amount?: number;
  raw?: Record<string, unknown>;
  refund_observed_at?: string | null;
  payloadRaw?: Record<string, unknown>;
}): SupabaseTransactionRow {
  const raw = over.raw ?? {};
  const currency = over.currency ?? "USD";
  const amount = over.amount ?? 10;
  return {
    auth_user_id: "auth_1",
    user_id: "u1",
    transaction_id: over.transaction_id,
    import_batch_id: "batch_1",
    source: "palmer_csv",
    event_time: "2026-06-01T10:00:00.000Z",
    status: over.status ?? "success",
    transaction_type: "trial",
    amount_gross: amount,
    amount_net: amount,
    amount_refunded: 0,
    currency,
    email: "user@example.com",
    country_code: null,
    campaign_path: "campaign-path",
    funnel: "soulmate",
    source_name: "facebook",
    raw_payload: raw,
    normalized_payload: {
      user_id: "u1",
      transaction_id: over.transaction_id,
      email: "user@example.com",
      event_time: "2026-06-01T10:00:00.000Z",
      amount_usd: amount, gross_amount_usd: amount, refund_amount_usd: 0, net_amount_usd: amount,
      currency,
      status: over.status ?? "success",
      transaction_type: "trial",
      funnel: "soulmate", campaign_path: "campaign-path", campaign_id: "cmp_1",
      product: "Trial", traffic_source: "facebook",
      classification_reason: "test",
      metadata: { ff_initiation_type: "cit" },
      raw: over.payloadRaw ?? { metadata: { ff_initiation_type: "cit" } },
    },
    refund_observed_at: over.refund_observed_at ?? null,
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:00:00.000Z",
    deleted_at: null,
  } as SupabaseTransactionRow;
}

const DECLINED_RAW = {
  id: "t_declined",
  status: "DECLINED",
  processor: "ADYEN",
  processorMerchantId: "mid-synthetic-1",
  statementDescriptor: "SYNTH*DESCRIPTOR",
  declineReasons: TWO_RECORDS,
  amount: "2999",
  amountAuthorized: "2999",
  currency: "USD",
  customerBillingAddressCountryCode: "br",
  paymentInstrumentAnalyticsId: "pi_synthetic_abc",
  paymentInstrumentIsNetworkTokenized: "True",
  paymentInstrumentBinDataAccountNumberType: "DPAN",
  paymentInstrumentThreeDSecureAuthenticationResponseCode: "AUTH_FAILED",
  paymentInstrumentThreeDSecureAuthenticationChallengeIssued: "False",
  paymentInstrumentThreeDSecureAuthenticationProtocolVersion: "2.2.0",
  metadata: JSON.stringify({
    ff_initiation_type: "MIT",
    ff_billing_reason: "upsell",
    paymentType: "UNSCHEDULED",
    ff_price_point: "29.99",
    ff_price_id: "price_synthetic_1",
    ff_country_code: "BR",
  }),
};

describe("payment health P0 columns through the mapper", () => {
  it("fills every column from the raw payload; the LAST decline record is the outcome", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({ transaction_id: "t_declined", status: "failed", raw: DECLINED_RAW })],
    });
    expect(rows).toHaveLength(1);
    const [out] = rows;
    expect(out.raw_status).toBe("DECLINED");
    expect(out.processor).toBe("ADYEN");
    expect(out.processor_merchant_id).toBe("mid-synthetic-1");
    expect(out.statement_descriptor).toBe("SYNTH*DESCRIPTOR");
    expect(out.initiation_type).toBe("mit");
    expect(out.ff_billing_reason).toBe("upsell");
    expect(out.payment_type_flag).toBe("UNSCHEDULED");
    // final outcome = second record
    expect(out.primer_decline_code).toBe("LOST_OR_STOLEN_CARD");
    expect(out.issuer_result_code).toBe("41");
    expect(out.advice_code).toBe("21");
    expect(out.advised_action).toBe("STOP_ALL_PAYMENTS");
    expect(out.lifecycle_event).toBe("AUTHORIZATION_DECLINED");
    expect(out.decline_record_count).toBe(2);
    expect(out.decline_type).toBe("hard");
    expect(out.three_ds_response).toBe("AUTH_FAILED");
    expect(out.three_ds_challenge).toBe("false");
    expect(out.three_ds_version).toBe("2.2.0");
    expect(out.is_network_tokenized).toBe("true");
    expect(out.account_number_type).toBe("DPAN");
    expect(out.amount_authorized).toBe(29.99);
    expect(out.billing_country).toBe("BR");
    expect(out.payment_instrument_key).toBe("pi_synthetic_abc");
    expect(out.price_point).toBe("29.99");
    expect(out.price_id).toBe("price_synthetic_1");
    expect(out.refund_observed_at).toBeNull();
    // the existing decline_reason stays the normalized bucket of the first record (unchanged behaviour)
    expect(out.decline_reason).toBe("issuer_unavailable");
  });

  it("a settled row: raw_status SETTLED, no decline fields, '' for absent tri-states", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({ transaction_id: "t_ok", raw: { id: "t_ok", status: "SETTLED", declineReasons: "[]", amount: "100", currency: "USD", metadata: "{\"ff_initiation_type\":\"cit\"}" } })],
    });
    const [out] = rows;
    expect(out.raw_status).toBe("SETTLED");
    expect(out.initiation_type).toBe("cit");
    expect(out.primer_decline_code).toBe("");
    expect(out.advised_action).toBe("");
    expect(out.decline_record_count).toBe(0);
    expect(out.decline_type).toBe("");
    expect(out.three_ds_challenge).toBe("");
    expect(out.is_network_tokenized).toBe("");
    expect(out.amount_authorized).toBe(0);
    expect(out.billing_country).toBe("");
    expect(out.processor_merchant_id).toBe("");
  });

  it("CANCELLED / PENDING keep status 'failed' and are told apart only by raw_status", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [
        row({ transaction_id: "t_c", status: "failed", raw: { status: "CANCELLED", declineReasons: "[]" } }),
        row({ transaction_id: "t_p", status: "failed", raw: { status: "pending", declineReasons: "[]" } }),
      ],
    });
    const byId = new Map(rows.map((r) => [r.transaction_id, r]));
    expect(byId.get("t_c")?.status).toBe("failed");
    expect(byId.get("t_c")?.is_failed).toBe(1);
    expect(byId.get("t_c")?.raw_status).toBe("CANCELLED");
    expect(byId.get("t_p")?.raw_status).toBe("PENDING");
  });

  it("amount_authorized follows the amount's minor-unit rule per currency (JPY has none; decimals untouched)", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [
        row({ transaction_id: "t_jpy", currency: "JPY", amount: 6415, raw: { amountAuthorized: "6415", currency: "JPY", declineReasons: "[]" } }),
        row({ transaction_id: "t_brl", currency: "BRL", amount: 254.99, raw: { amountAuthorized: "25499", currency: "BRL", declineReasons: "[]" } }),
        row({ transaction_id: "t_dec", currency: "USD", amount: 29.99, raw: { amountAuthorized: "29.99", currency: "USD", declineReasons: "[]" } }),
      ],
    });
    const byId = new Map(rows.map((r) => [r.transaction_id, r]));
    expect(byId.get("t_jpy")?.amount_authorized).toBe(6415);
    expect(byId.get("t_brl")?.amount_authorized).toBe(254.99);
    expect(byId.get("t_dec")?.amount_authorized).toBe(29.99);
  });

  it("refund_observed_at rides from the Postgres column as a ClickHouse DateTime64 key", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [
        row({ transaction_id: "t_r", raw: { declineReasons: "[]" }, refund_observed_at: "2026-09-10T12:34:56.789Z" }),
        row({ transaction_id: "t_bad", raw: { declineReasons: "[]" }, refund_observed_at: "not a date" }),
      ],
    });
    const byId = new Map(rows.map((r) => [r.transaction_id, r]));
    expect(byId.get("t_r")?.refund_observed_at).toBe("2026-09-10T12:34:56.789");
    expect(byId.get("t_bad")?.refund_observed_at).toBeNull();
  });

  it("falls back to normalized_payload.raw when raw_payload lacks a key (legacy rows)", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({
        transaction_id: "t_legacy", status: "failed",
        raw: {},
        payloadRaw: { status: "DECLINED", declineReasons: "[{'decline_reason': 'DO_NOT_HONOR', 'advised_action': 'DO_NOT_RETRY'}]", metadata: { ff_initiation_type: "mit" } },
      })],
    });
    const [out] = rows;
    expect(out.raw_status).toBe("DECLINED");
    expect(out.primer_decline_code).toBe("DO_NOT_HONOR");
    expect(out.decline_type).toBe("hard");
    expect(out.initiation_type).toBe("mit");
  });

  it("paymentHealthColumns is pure over a hydrated transaction", () => {
    const [tx] = hydrateSupabaseTransactionRows([row({ transaction_id: "t_declined", status: "failed", raw: DECLINED_RAW })]);
    const columns = paymentHealthColumns({ tx, row: { refund_observed_at: null }, currency: "USD" });
    expect(columns.decline_record_count).toBe(2);
    expect(columns.payment_instrument_key).toBe("pi_synthetic_abc");
  });

  it("the new fields sit at the tail of the row in the ALTER order, and every one exists in CREATE", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({ authUserId: "auth_1", rows: [row({ transaction_id: "t1", raw: { declineReasons: "[]" } })] });
    const altered = ALTER_PAYMENT_HEALTH_COLUMNS_SQL.map((sql) => /ADD COLUMN IF NOT EXISTS ([a-z_]+)/.exec(sql)?.[1]);
    expect(altered).toHaveLength(24);
    const keys = Object.keys(rows[0]);
    expect(keys.slice(-altered.length)).toEqual(altered);
    for (const column of altered) expect(CREATE_ANALYTICS_TRANSACTIONS_SQL).toContain(`    ${column} `);
    expect(ALTER_PAYMENT_HEALTH_COLUMNS_SQL.every((sql) => sql.includes("IF NOT EXISTS"))).toBe(true);
  });
});
