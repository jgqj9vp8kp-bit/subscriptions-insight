// The issuer classifier: bank identity from the Primer binData issuer name.
//
// Every case here is a way the dimension could lie: two spellings of one bank
// splitting its volume, two different banks merging into one row, the
// provider's literal "UNKNOWN" blending into "not reported", or a rule change
// that silently reshuffles keys between backfills.
import { describe, expect, it } from "vitest";
import {
  ISSUER_COUNTRY_FIELD_PATHS,
  ISSUER_NAME_FIELD_PATHS,
  ISSUER_UNKNOWN_KEY,
  issuerGroupLabel,
  issuerIdentityFromName,
  issuerIdentityFromTransaction,
  issuerCountryFromTransaction,
  issuerLabel,
  normalizeIssuerTokens,
  stripLegalSuffixes,
} from "@/services/cardIssuer";
import { GENERIC_HEADS, ISSUER_GROUPS, ISSUER_GROUP_LABELS, ISSUER_LEGAL_SUFFIXES } from "../../supabase/functions/_shared/clickhouse/cardIssuerGroups";
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

describe("production collisions collapse", () => {
  it("double space and single space are the same bank", () => {
    // The two largest live collisions: 1,680 + 1,503 attempts split over a
    // double space; 649 + 469 split over a comma.
    const a = issuerIdentityFromName("THE BANCORP BANK NATIONAL ASSOCIATION");
    const b = issuerIdentityFromName("THE BANCORP BANK  NATIONAL ASSOCIATION");
    expect(a?.key).toBe(b?.key);
    expect(a?.key).toBe("the_bancorp_bank");
  });

  it("comma and double space are the same bank", () => {
    const a = issuerIdentityFromName("BANK OF AMERICA, NATIONAL ASSOCIATION");
    const b = issuerIdentityFromName("BANK OF AMERICA  NATIONAL ASSOCIATION");
    expect(a?.key).toBe(b?.key);
    expect(a?.key).toBe("bank_of_america");
  });

  it("diacritics fold into their base letters", () => {
    expect(issuerIdentityFromName("BANCO POPULAR ESPAÑOL")?.key)
      .toBe(issuerIdentityFromName("BANCO POPULAR ESPANOL")?.key);
  });
});

describe("sub-brands stay separate", () => {
  it("Nequi is not Bancolombia, but they share a parent group", () => {
    const parent = issuerIdentityFromName("BANCOLOMBIA S.A.");
    const nequi = issuerIdentityFromName("BANCOLOMBIA S.A.- NEQUI");
    expect(parent?.key).toBe("bancolombia");
    expect(nequi?.key).toBe("bancolombia_s_a_nequi");
    expect(nequi?.key).not.toBe(parent?.key);
    expect(nequi?.group).toBe(parent?.group);
  });

  it("Chase DEBIT is its own issuer under the Chase group", () => {
    const debit = issuerIdentityFromName("JPMORGAN CHASE BANK N.A. - DEBIT");
    const plain = issuerIdentityFromName("JPMORGAN CHASE BANK N.A.");
    expect(debit?.key).toBe("jpmorgan_chase_bank_n_a_debit");
    expect(plain?.key).toBe("jpmorgan_chase_bank");
    expect(debit?.group).toBe(plain?.group);
  });
});

describe("the two kinds of missing are never merged", () => {
  it("the provider's literal UNKNOWN gets its own key", () => {
    const identity = issuerIdentityFromName("UNKNOWN");
    expect(identity?.key).toBe(ISSUER_UNKNOWN_KEY);
    expect(identity?.name).toBe("Reported as UNKNOWN");
  });

  it("an absent name is null, not 'unknown'", () => {
    expect(issuerIdentityFromName("")).toBeNull();
    expect(issuerIdentityFromName("   ")).toBeNull();
    expect(issuerIdentityFromName(null)).toBeNull();
    expect(issuerIdentityFromName(undefined)).toBeNull();
  });

  it("labels tell the two apart", () => {
    expect(issuerLabel("")).toBe("Not reported");
    expect(issuerLabel(ISSUER_UNKNOWN_KEY)).toBe("Reported as UNKNOWN");
  });
});

describe("suffix stripping guards", () => {
  it("BANCO S.A. does not become the slug that swallows Latin America", () => {
    // Stripping S.A. would leave the single generic token BANCO.
    expect(issuerIdentityFromName("BANCO S.A.")?.key).toBe("banco_s_a");
  });

  it("a name that IS only a suffix survives", () => {
    expect(issuerIdentityFromName("N.A.")?.key).toBe("n_a");
  });

  it("stacked suffixes strip repeatedly", () => {
    // "... S.A. DE C.V. SFP" strips SFP, then S A DE C V.
    expect(issuerIdentityFromName("AKALA S.A. DE C.V. SFP")?.key).toBe("akala");
  });

  it("strips only from the tail, never the middle", () => {
    // "NATIONAL ASSOCIATION" in the middle must survive.
    const identity = issuerIdentityFromName("STRIDE BANK  NATIONAL ASSOCIATION");
    expect(identity?.key).toBe("stride_bank");
    const middle = issuerIdentityFromName("FIRST NATIONAL BANK OF OMAHA");
    expect(middle?.key).toBe("first_national_bank_of_omaha");
  });
});

describe("determinism and hygiene", () => {
  const RAW_SAMPLES = [
    "SUTTON BANK", "GREEN DOT BANK DBA BONNEVILLE BANK", "BBVA MEXICO S.A.",
    "THE BANCORP BANK  NATIONAL ASSOCIATION", "BANCOLOMBIA S.A.", "DISCOVER",
    "WELLS FARGO BANK  NATIONAL ASSOCIATION", "JPMORGAN CHASE BANK N.A. - DEBIT",
    "GOLDMAN SACHS BANK USA", "NU PAGAMENTOS SA", "BANCO DAVIVIENDA, S.A.",
    "MERCADOLIBRE SA DE CV INSTITUCION DE FONDOS DE PAGO ELECTRONICO",
    "BANCO SANTANDER MEXICO SA INSTITUCION DE BANCA MULTIPLE GRUPO FINANC",
    "BANCOLOMBIA S.A.- NEQUI", "BANCO PLATA, S.A., INSTITUCION DE BANCA MULTIPLE",
    "STRIDE BANK  NATIONAL ASSOCIATION", "AKALA S.A. DE C.V. SFP", "CHASE BANK USA",
  ];

  it("normalization is idempotent: normalizing a display name changes nothing", () => {
    for (const raw of RAW_SAMPLES) {
      const first = issuerIdentityFromName(raw);
      expect(first).not.toBeNull();
      const second = issuerIdentityFromName(first?.name);
      expect(second?.key).toBe(first?.key);
    }
  });

  it("keys match the closed charset", () => {
    for (const raw of RAW_SAMPLES) {
      expect(issuerIdentityFromName(raw)?.key).toMatch(/^[a-z0-9_]{1,64}$/);
    }
  });

  it("a very long name truncates at a token boundary", () => {
    const long = Array.from({ length: 30 }, (_, i) => `TOKEN${i}`).join(" ");
    const key = issuerIdentityFromName(long)?.key ?? "";
    expect(key.length).toBeLessThanOrEqual(64);
    expect(key.endsWith("_")).toBe(false);
  });
});

describe("the curated group table is internally consistent", () => {
  it("every key in ISSUER_GROUPS is itself a valid normalized key", () => {
    for (const key of Object.keys(ISSUER_GROUPS)) {
      expect(key).toMatch(/^[a-z0-9_]{1,64}$/);
    }
  });

  it("every referenced group has a label or is a plain slug", () => {
    for (const group of new Set(Object.values(ISSUER_GROUPS))) {
      expect(typeof issuerGroupLabel(group)).toBe("string");
      expect(issuerGroupLabel(group).length).toBeGreaterThan(0);
    }
  });

  it("suffix list and generic heads stay uppercase token form", () => {
    for (const suffix of ISSUER_LEGAL_SUFFIXES) {
      for (const token of suffix) expect(token).toMatch(/^[A-Z0-9]+$/);
    }
    for (const head of GENERIC_HEADS) expect(head).toMatch(/^[A-Z]+$/);
  });

  it("group labels map only real group slugs", () => {
    const groups = new Set(Object.values(ISSUER_GROUPS));
    for (const slug of Object.keys(ISSUER_GROUP_LABELS)) {
      expect(groups.has(slug)).toBe(true);
    }
  });
});

describe("reading the transaction", () => {
  it("finds the issuer in tx.raw — where the untouched payload lives", () => {
    const identity = issuerIdentityFromTransaction(tx({
      paymentInstrumentBinDataIssuerName: "SUTTON BANK",
    }));
    expect(identity?.key).toBe("sutton_bank");
    expect(identity?.name).toBe("Sutton Bank");
  });

  it("reads the issuer country and validates its shape", () => {
    expect(issuerCountryFromTransaction(tx({ paymentInstrumentBinDataIssuerCountryCode: "us" }))).toBe("US");
    expect(issuerCountryFromTransaction(tx({ paymentInstrumentBinDataIssuerCountryCode: "not-a-code" }))).toBeNull();
    expect(issuerCountryFromTransaction(tx({}))).toBeNull();
  });
});

describe("PCI: the field paths are the whole read surface", () => {
  it("no path ever names cardholder data", () => {
    const forbidden = /last4|first6|cardholder|expiration|analyticsid/i;
    for (const path of [...ISSUER_NAME_FIELD_PATHS, ...ISSUER_COUNTRY_FIELD_PATHS]) {
      for (const segment of path) {
        expect(segment).not.toMatch(forbidden);
      }
    }
  });
});

describe("token pipeline internals", () => {
  it("normalizeIssuerTokens collapses punctuation and whitespace", () => {
    expect(normalizeIssuerTokens("BANCO DAVIVIENDA, S.A.")).toEqual(["BANCO", "DAVIVIENDA", "S", "A"]);
    expect(normalizeIssuerTokens("  a   b  ")).toEqual(["A", "B"]);
    expect(normalizeIssuerTokens("")).toEqual([]);
  });

  it("stripLegalSuffixes returns the input array when nothing matches", () => {
    expect(stripLegalSuffixes(["SUTTON", "BANK"])).toEqual(["SUTTON", "BANK"]);
  });
});
