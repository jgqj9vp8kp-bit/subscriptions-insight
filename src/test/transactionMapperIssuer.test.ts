// Issuer/network/method columns through the transaction mapper.
//
// The one regression that matters most here: issuer attribution is
// PER-TRANSACTION. A user who fails on one bank's card and succeeds on
// another's must produce two rows with two different issuer keys — anyone who
// later routes the issuer through a user-level argMin (the uattr pattern) will
// turn this red, and that attribution would credit the successful bank with the
// failed bank's declines.
import { describe, expect, it } from "vitest";
import { mapSupabaseTransactionsToClickHouse } from "../../supabase/functions/_shared/clickhouse/transactionMapper";
import type { SupabaseTransactionRow } from "../../supabase/functions/_shared/clickhouse/transactionMapper";

function row(over: {
  transaction_id: string;
  status?: string;
  raw?: Record<string, unknown>;
  user_id?: string;
}): SupabaseTransactionRow {
  const raw = over.raw ?? {};
  return {
    auth_user_id: "auth_1",
    user_id: over.user_id ?? "u1",
    transaction_id: over.transaction_id,
    import_batch_id: "batch_1",
    source: "palmer_csv",
    event_time: "2026-06-01T10:00:00.000Z",
    status: over.status ?? "success",
    transaction_type: "trial",
    amount_gross: 10,
    amount_net: 10,
    amount_refunded: 0,
    currency: "USD",
    email: "user@example.com",
    country_code: null,
    campaign_path: "campaign-path",
    funnel: "soulmate",
    source_name: "facebook",
    raw_payload: raw,
    normalized_payload: {
      user_id: over.user_id ?? "u1",
      transaction_id: over.transaction_id,
      email: "user@example.com",
      event_time: "2026-06-01T10:00:00.000Z",
      amount_usd: 10, gross_amount_usd: 10, refund_amount_usd: 0, net_amount_usd: 10,
      currency: "USD",
      status: over.status ?? "success",
      transaction_type: "trial",
      funnel: "soulmate", campaign_path: "campaign-path", campaign_id: "cmp_1",
      product: "Trial", traffic_source: "facebook",
      classification_reason: "test",
      raw,
    },
    created_at: "2026-06-01T10:00:00.000Z",
    updated_at: "2026-06-01T10:00:00.000Z",
    deleted_at: null,
  } as SupabaseTransactionRow;
}

const SUTTON = {
  paymentInstrumentBinDataIssuerName: "SUTTON BANK",
  paymentInstrumentBinDataIssuerCountryCode: "US",
  paymentInstrumentBinDataNetwork: "VISA",
  paymentInstrumentType: "APPLE_PAY",
};
const CHASE = {
  paymentInstrumentBinDataIssuerName: "JPMORGAN CHASE BANK N.A.",
  paymentInstrumentBinDataIssuerCountryCode: "US",
  paymentInstrumentBinDataNetwork: "MASTERCARD",
  paymentInstrumentType: "PAYMENT_CARD",
};

describe("issuer columns through the mapper", () => {
  it("emits all six columns from the untouched raw payload", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({ transaction_id: "t1", raw: SUTTON })],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].issuer_key).toBe("sutton_bank");
    expect(rows[0].issuer_name).toBe("Sutton Bank");
    expect(rows[0].issuer_group).toBe("sutton_bank");
    expect(rows[0].issuer_country).toBe("US");
    expect(rows[0].card_network).toBe("visa");
    expect(rows[0].payment_method).toBe("apple_pay");
  });

  it("PER-TRANSACTION: one user, two cards, two different issuer keys", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [
        row({ transaction_id: "t_fail", status: "failed", raw: SUTTON }),
        row({ transaction_id: "t_ok", status: "success", raw: CHASE }),
      ],
    });
    const byId = new Map(rows.map((r) => [r.transaction_id, r]));
    // The failed attempt keeps ITS bank; the success does not absorb it.
    expect(byId.get("t_fail")?.issuer_key).toBe("sutton_bank");
    expect(byId.get("t_ok")?.issuer_key).toBe("jpmorgan_chase_bank");
    expect(byId.get("t_fail")?.payment_method).toBe("apple_pay");
    expect(byId.get("t_ok")?.payment_method).toBe("card");
  });

  it("absent binData stays '' — never 'unknown', which is the provider's word", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({ transaction_id: "t_empty", raw: { processor: "palmer" } })],
    });
    expect(rows[0].issuer_key).toBe("");
    expect(rows[0].issuer_name).toBe("");
    expect(rows[0].issuer_group).toBe("");
    expect(rows[0].issuer_country).toBe("");
    expect(rows[0].card_network).toBe("");
    expect(rows[0].payment_method).toBe("");
  });

  it("the provider's literal UNKNOWN maps to the 'unknown' key, distinct from absent", () => {
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({ transaction_id: "t_unk", raw: { paymentInstrumentBinDataIssuerName: "UNKNOWN" } })],
    });
    expect(rows[0].issuer_key).toBe("unknown");
  });

  it("the six new fields sit at the tail of the emitted row object", () => {
    // The ClickHouse INSERT relies on positional column order matching the
    // CREATE TABLE tail; the platform column comment documents this discipline.
    const { rows } = mapSupabaseTransactionsToClickHouse({
      authUserId: "auth_1",
      rows: [row({ transaction_id: "t1", raw: SUTTON })],
    });
    const keys = Object.keys(rows[0]);
    expect(keys.slice(-6)).toEqual([
      "issuer_key", "issuer_name", "issuer_group", "issuer_country", "card_network", "payment_method",
    ]);
  });
});
