import { describe, expect, it } from "vitest";
import {
  backfillTransactionCardTypesFromRawRows,
} from "@/services/palmerTransform";
import {
  cardTypeForUserTransactions,
  cardTypeFromTransaction,
  normalizeCardType,
} from "@/services/userCardType";
import type { Transaction } from "@/services/types";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: "tx_1",
    user_id: "user_1",
    email: "user@example.com",
    event_time: "2026-01-01T10:00:00.000Z",
    amount_usd: 1,
    gross_amount_usd: 1,
    refund_amount_usd: 0,
    net_amount_usd: 1,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "unknown",
    campaign_path: "soulmate-reading",
    product: "Trial",
    traffic_source: "unknown",
    campaign_id: "",
    classification_reason: "test",
    ...overrides,
  };
}

describe("user card type helpers", () => {
  it("extracts card type from the Palmer raw funding field", () => {
    expect(
      cardTypeFromTransaction(tx({
        raw: { paymentInstrumentBinDataAccountFundingType: "prepaid" },
      })),
    ).toBe("prepaid");
  });

  it("extracts card type from nested raw fields", () => {
    expect(
      cardTypeFromTransaction(tx({
        raw: { payment_method_details: { card: { funding: "debit" } } },
      })),
    ).toBe("debit");
  });

  it("normalizes prepaid, debit, and credit", () => {
    expect(normalizeCardType("PREPAID")).toBe("prepaid");
    expect(normalizeCardType("debit")).toBe("debit");
    expect(normalizeCardType("credit")).toBe("credit");
  });

  it("falls back to unknown for empty values", () => {
    expect(normalizeCardType("")).toBe("unknown");
    expect(cardTypeForUserTransactions([tx({ raw: {} })])).toBe("unknown");
  });

  it("falls back to other for unsupported values", () => {
    expect(normalizeCardType("corporate")).toBe("other");
  });

  it("prefers the first successful payment card type", () => {
    expect(
      cardTypeForUserTransactions([
        tx({
          transaction_id: "failed",
          event_time: "2026-01-01T09:00:00.000Z",
          status: "failed",
          raw: { paymentInstrumentBinDataAccountFundingType: "debit" },
        }),
        tx({
          transaction_id: "success",
          event_time: "2026-01-01T10:00:00.000Z",
          status: "success",
          raw: { paymentInstrumentBinDataAccountFundingType: "credit" },
        }),
      ]),
    ).toBe("credit");
  });

  it("backfills old normalized Palmer transactions from raw rows", () => {
    const transactions = [
      tx({
        transaction_id: "palmer_tx",
        card_type: undefined,
      }),
    ];

    const enriched = backfillTransactionCardTypesFromRawRows(transactions, [
      {
        id: "palmer_tx",
        customerId: "user_1",
        created_at: "2026-01-01T10:00:00.000Z",
        amount: "100",
        paymentInstrumentBinDataAccountFundingType: "debit",
      },
    ]);

    expect(enriched[0].card_type).toBe("debit");
  });
});
