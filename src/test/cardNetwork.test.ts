// Card network and payment method classifiers.
import { describe, expect, it } from "vitest";
import {
  CARD_NETWORK_FIELD_PATHS,
  CARD_NETWORK_VALUES,
  PAYMENT_METHOD_FIELD_PATHS,
  PAYMENT_METHOD_VALUES,
  cardNetworkFromTransaction,
  cardNetworkLabel,
  normalizeCardNetwork,
  normalizePaymentMethod,
  paymentMethodFromTransaction,
  paymentMethodLabel,
} from "@/services/cardNetwork";
import type { Transaction } from "@/services/types";

function tx(raw: Record<string, unknown>): Transaction {
  return {
    transaction_id: "t1", user_id: "u1", email: "a@b.c",
    event_time: "2026-08-01T10:00:00.000Z",
    amount_usd: 1, gross_amount_usd: 1, refund_amount_usd: 0, net_amount_usd: 1,
    is_refunded: false, currency: "USD", status: "success",
    transaction_type: "trial", funnel: "unknown", campaign_path: "p",
    product: "Trial", traffic_source: "unknown", campaign_id: "",
    classification_reason: "test", raw,
  } as Transaction;
}

describe("normalizeCardNetwork", () => {
  it("maps all seven live networks", () => {
    // The seven values measured in production on 2026-08-11.
    expect(normalizeCardNetwork("VISA")).toBe("visa");
    expect(normalizeCardNetwork("MASTERCARD")).toBe("mastercard");
    expect(normalizeCardNetwork("AMEX")).toBe("amex");
    expect(normalizeCardNetwork("DISCOVER")).toBe("discover");
    expect(normalizeCardNetwork("MAESTRO")).toBe("maestro");
    expect(normalizeCardNetwork("DINERS_CLUB")).toBe("diners_club");
    expect(normalizeCardNetwork("JCB")).toBe("jcb");
  });

  it("present but unrecognized is 'other', so a new scheme cannot crash the enum", () => {
    expect(normalizeCardNetwork("SOME_FUTURE_SCHEME")).toBe("other");
  });
});

describe("normalizePaymentMethod", () => {
  it("maps the live instrument types", () => {
    expect(normalizePaymentMethod("APPLE_PAY")).toBe("apple_pay");
    expect(normalizePaymentMethod("GOOGLE_PAY")).toBe("google_pay");
    expect(normalizePaymentMethod("PAYMENT_CARD")).toBe("card");
  });

  it("unrecognized is 'other'", () => {
    expect(normalizePaymentMethod("PAYPAL_ORDER")).toBe("other");
  });
});

describe("transaction readers", () => {
  it("absent is null — 'no data' must stay distinct from 'other'", () => {
    expect(cardNetworkFromTransaction(tx({}))).toBeNull();
    expect(paymentMethodFromTransaction(tx({}))).toBeNull();
  });

  it("prefers the binData network over the routed network", () => {
    // binData says who issued the card; the other is what the processor routed
    // on — they differ for co-badged cards, and a bank analysis wants the former.
    expect(cardNetworkFromTransaction(tx({
      paymentInstrumentBinDataNetwork: "MAESTRO",
      paymentInstrumentNetwork: "MASTERCARD",
    }))).toBe("maestro");
  });

  it("reads from tx.raw where the untouched payload lives", () => {
    expect(cardNetworkFromTransaction(tx({ paymentInstrumentBinDataNetwork: "VISA" }))).toBe("visa");
    expect(paymentMethodFromTransaction(tx({ paymentInstrumentType: "APPLE_PAY" }))).toBe("apple_pay");
  });
});

describe("closed vocabularies and labels", () => {
  it("value arrays cover their unions", () => {
    expect(CARD_NETWORK_VALUES).toHaveLength(9);
    expect(PAYMENT_METHOD_VALUES).toHaveLength(4);
  });

  it("every value has a label", () => {
    for (const value of CARD_NETWORK_VALUES) {
      expect(cardNetworkLabel(value)).not.toBe("Unknown");
    }
    for (const value of PAYMENT_METHOD_VALUES) {
      expect(paymentMethodLabel(value)).not.toBe("Unknown");
    }
  });
});

describe("PCI: the field paths are the whole read surface", () => {
  it("no path ever names cardholder data", () => {
    const forbidden = /last4|first6|cardholder|expiration|analyticsid/i;
    for (const path of [...CARD_NETWORK_FIELD_PATHS, ...PAYMENT_METHOD_FIELD_PATHS]) {
      for (const segment of path) {
        expect(segment).not.toMatch(forbidden);
      }
    }
  });
});
