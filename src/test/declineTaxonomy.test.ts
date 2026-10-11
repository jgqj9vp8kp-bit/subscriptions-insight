// Payment System Health P1: the decline taxonomy (plan G decline_class, J, D).
//
// Fixtures mirror the SHAPES of the production distributions in plan F (not
// the counts): Stripe relaying issuer 59 as DO_NOT_HONOR and 83 as
// REFER_TO_CARD_ISSUER / ISSUER_TEMPORARILY_UNAVAILABLE, Adyen relaying both
// as SUSPECTED_FRAUD, Primer ERROR carrying issuer codes 62 / 9G / 82 / 46,
// AUTHORIZATION_FAILED splitting into AUTHENTICATION_REQUIRED and the rest,
// 2,679 unrouted declines, the advised_action mix, 3DS-era 1A, lost / stolen.
// Every value is synthetic.
import { describe, expect, it } from "vitest";
import {
  ATTEMPT_RAW_STATUSES,
  DECLINE_CLASS_LABELS,
  DECLINE_CLASSES,
  ISSUER_DECLINE_CLASSES,
  ISSUER_FRAUD_DECLINE_CODES,
  ISSUER_RESULT_CODES,
  LOST_STOLEN_CODES,
  MC_HARD_DECLINE_RULES,
  MC_MAC_BAN_CODES,
  MC_MERCHANT_ADVICE_CODE_RULES,
  NETWORK_CODE_RULES,
  PRIMER_DECLINE_CODE_FALLBACK,
  RETRY_BAN_ADVISED_ACTIONS,
  VISA_CATEGORY_REATTEMPT,
  VISA_DECLINE_CATEGORY_RULES,
  VISA_REATTEMPT_LIMIT_PER_30_DAYS,
  attemptOutcome,
  classifyDecline,
  declineClassGroup,
  isIssuerFraudDecline,
  isLostStolenDecline,
  isRetryBan,
  issuerClassForCode,
  merchantAdviceRule,
  normalizeCardNetwork,
  normalizeCode,
  normalizeToken,
  retryBanSources,
  visaCategoryFromAdviceCode,
  visaDeclineCategory,
  visaDeclineCategoryOf,
  type DeclineClass,
  type DeclineFields,
} from "../../supabase/functions/_shared/clickhouse/declineTaxonomy.ts";

/** A routed, declined row with the common defaults; every field can be overridden (null included). */
function decline(overrides: DeclineFields = {}): DeclineFields {
  return {
    raw_status: "DECLINED",
    processor: "STRIPE",
    card_network: "VISA",
    primer_decline_code: null,
    issuer_result_code: null,
    advice_code: null,
    advised_action: "RETRY_LATER",
    lifecycle_event: "AUTHORIZATION_DECLINED",
    decline_type: null,
    decline_record_count: 1,
    ...overrides,
  };
}

interface Case {
  name: string;
  fields: DeclineFields;
  expect: DeclineClass;
  basis?: string;
}

/** The production shapes of plan F, one row each (synthetic). */
const CORPUS: Case[] = [
  // Issuer code first, whatever Primer called it.
  { name: "Stripe 51 INSUFFICIENT_FUNDS", fields: decline({ primer_decline_code: "INSUFFICIENT_FUNDS", issuer_result_code: "51" }), expect: "insufficient_funds", basis: "issuer_code" },
  { name: "Adyen 51 INSUFFICIENT_FUNDS", fields: decline({ processor: "ADYEN", primer_decline_code: "INSUFFICIENT_FUNDS", issuer_result_code: "51" }), expect: "insufficient_funds" },
  { name: "Stripe 59 relayed as DO_NOT_HONOR", fields: decline({ primer_decline_code: "DO_NOT_HONOR", issuer_result_code: "59" }), expect: "issuer_suspected_fraud", basis: "issuer_code" },
  { name: "Adyen 59 relayed as SUSPECTED_FRAUD", fields: decline({ processor: "ADYEN", primer_decline_code: "SUSPECTED_FRAUD", issuer_result_code: "59", advised_action: "DO_NOT_RETRY" }), expect: "issuer_suspected_fraud" },
  { name: "Stripe 83 relayed as REFER_TO_CARD_ISSUER", fields: decline({ primer_decline_code: "REFER_TO_CARD_ISSUER", issuer_result_code: "83" }), expect: "issuer_suspected_fraud", basis: "issuer_code" },
  { name: "Stripe 83 relayed as ISSUER_TEMPORARILY_UNAVAILABLE", fields: decline({ primer_decline_code: "ISSUER_TEMPORARILY_UNAVAILABLE", issuer_result_code: "83" }), expect: "issuer_suspected_fraud", basis: "issuer_code" },
  { name: "Adyen 83 relayed as SUSPECTED_FRAUD", fields: decline({ processor: "ADYEN", primer_decline_code: "SUSPECTED_FRAUD", issuer_result_code: "83" }), expect: "issuer_suspected_fraud" },
  { name: "63 security violation", fields: decline({ primer_decline_code: "DO_NOT_HONOR", issuer_result_code: "63" }), expect: "issuer_suspected_fraud" },
  { name: "Primer ERROR with issuer 62", fields: decline({ primer_decline_code: "ERROR", issuer_result_code: "62" }), expect: "restricted_blocked", basis: "issuer_code" },
  { name: "Primer ERROR with issuer 9G", fields: decline({ primer_decline_code: "ERROR", issuer_result_code: "9G" }), expect: "other_issuer", basis: "issuer_code" },
  { name: "Primer ERROR with issuer 82", fields: decline({ primer_decline_code: "ERROR", issuer_result_code: "82" }), expect: "policy", basis: "issuer_code" },
  { name: "Primer ERROR with issuer 46", fields: decline({ primer_decline_code: "ERROR", issuer_result_code: "46", advised_action: "DO_NOT_RETRY" }), expect: "closed_account", basis: "issuer_code" },
  { name: "05 do not honor", fields: decline({ primer_decline_code: "DO_NOT_HONOR", issuer_result_code: "05" }), expect: "policy" },
  { name: "AUTHORIZATION_FAILED with issuer 05 (the code wins over the lifecycle)", fields: decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "ERROR", issuer_result_code: "05" }), expect: "policy", basis: "issuer_code" },
  { name: "41 lost card", fields: decline({ primer_decline_code: "LOST_OR_STOLEN_CARD", issuer_result_code: "41", advised_action: "STOP_ALL_PAYMENTS" }), expect: "lost_stolen" },
  { name: "43 stolen card", fields: decline({ primer_decline_code: "LOST_OR_STOLEN_CARD", issuer_result_code: "43", advised_action: "STOP_ALL_PAYMENTS" }), expect: "lost_stolen" },
  { name: "91 issuer inoperative", fields: decline({ primer_decline_code: "ISSUER_TEMPORARILY_UNAVAILABLE", issuer_result_code: "91" }), expect: "issuer_temporarily_unavailable" },
  { name: "54 expired card", fields: decline({ primer_decline_code: "EXPIRED_CARD", issuer_result_code: "54", advised_action: "UPDATE_DATA" }), expect: "closed_account" },
  // The advice code is network-polymorphic: Visa's decline category (one digit) on a Visa row, a MAC (two digits) on a Mastercard row.
  { name: "Visa N7 with decline category 3 relayed as advice code 3 (UPDATE_DATA)", fields: decline({ primer_decline_code: "ERROR", issuer_result_code: "N7", advice_code: "3", advised_action: "UPDATE_DATA" }), expect: "policy", basis: "issuer_code" },
  { name: "Mastercard 05 with MAC 03 (DO_NOT_RETRY)", fields: decline({ card_network: "MASTERCARD", primer_decline_code: "DO_NOT_HONOR", issuer_result_code: "05", advice_code: "03", advised_action: "DO_NOT_RETRY" }), expect: "policy", basis: "issuer_code" },
  { name: "1A authentication required (issuer code)", fields: decline({ primer_decline_code: "AUTHENTICATION_REQUIRED", issuer_result_code: "1A", lifecycle_event: "AUTHORIZATION_FAILED" }), expect: "authentication", basis: "issuer_code" },
  { name: "Mastercard 65 is the SCA soft decline", fields: decline({ card_network: "MASTERCARD", issuer_result_code: "65" }), expect: "authentication", basis: "issuer_code" },
  { name: "Visa 65 is a frequency limit", fields: decline({ card_network: "VISA", issuer_result_code: "65" }), expect: "insufficient_funds", basis: "issuer_code" },
  // Authentication without an issuer code.
  { name: "Stripe AUTHORIZATION_FAILED AUTHENTICATION_REQUIRED", fields: decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "AUTHENTICATION_REQUIRED", advised_action: "UPDATE_DATA" }), expect: "authentication", basis: "primer_code" },
  // PSP / integration: AUTHORIZATION_FAILED, no issuer code, not authentication.
  { name: "Stripe AUTHORIZATION_FAILED ERROR without a code", fields: decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "ERROR" }), expect: "psp_integration", basis: "lifecycle" },
  { name: "Adyen AUTHORIZATION_FAILED with no codes at all", fields: decline({ processor: "ADYEN", lifecycle_event: "AUTHORIZATION_FAILED", advised_action: null }), expect: "psp_integration", basis: "lifecycle" },
  // AUTHORIZATION_FAILED with a Primer code that names an issuer reason but no issuer code: the lifecycle wins (plan G step 3
  // before the Primer fallback; production 2026-10-11: 519 INSUFFICIENT_FUNDS, 7 LOST_OR_STOLEN_CARD rows) and the flags follow the class.
  { name: "AUTHORIZATION_FAILED with Primer LOST_OR_STOLEN_CARD and no issuer code", fields: decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "LOST_OR_STOLEN_CARD", advised_action: "STOP_ALL_PAYMENTS" }), expect: "psp_integration", basis: "lifecycle" },
  { name: "AUTHORIZATION_FAILED with Primer INSUFFICIENT_FUNDS and no issuer code", fields: decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "INSUFFICIENT_FUNDS" }), expect: "psp_integration", basis: "lifecycle" },
  // Unrouted: declined before any processor, no decline record.
  { name: "unrouted decline", fields: decline({ processor: null, advised_action: null, lifecycle_event: null }), expect: "cause_unverified", basis: "unrouted" },
  { name: "unrouted decline with an empty processor string", fields: decline({ processor: "  ", advised_action: null, lifecycle_event: "AUTHORIZATION_FAILED" }), expect: "cause_unverified", basis: "unrouted" },
  // Primer code fallback (no issuer code).
  { name: "Adyen SUSPECTED_FRAUD without an issuer code", fields: decline({ processor: "ADYEN", primer_decline_code: "SUSPECTED_FRAUD" }), expect: "issuer_suspected_fraud", basis: "primer_code" },
  { name: "LOST_OR_STOLEN_CARD without an issuer code", fields: decline({ primer_decline_code: "LOST_OR_STOLEN_CARD", advised_action: "STOP_ALL_PAYMENTS" }), expect: "lost_stolen", basis: "primer_code" },
  { name: "INSUFFICIENT_FUNDS without an issuer code", fields: decline({ primer_decline_code: "INSUFFICIENT_FUNDS" }), expect: "insufficient_funds", basis: "primer_code" },
  { name: "DO_NOT_HONOR without an issuer code", fields: decline({ primer_decline_code: "DO_NOT_HONOR" }), expect: "policy", basis: "primer_code" },
  { name: "ISSUER_TEMPORARILY_UNAVAILABLE without an issuer code", fields: decline({ primer_decline_code: "ISSUER_TEMPORARILY_UNAVAILABLE" }), expect: "issuer_temporarily_unavailable", basis: "primer_code" },
  { name: "REFER_TO_CARD_ISSUER without an issuer code", fields: decline({ primer_decline_code: "REFER_TO_CARD_ISSUER" }), expect: "other_issuer", basis: "primer_code" },
  // Declined by the issuer, no usable code at all.
  { name: "ERROR + AUTHORIZATION_DECLINED without a code", fields: decline({ primer_decline_code: "ERROR" }), expect: "other_issuer", basis: "lifecycle" },
  { name: "routed decline with nothing at all", fields: decline({ advised_action: null, lifecycle_event: null }), expect: "cause_unverified", basis: "none" },
  // Not declines.
  { name: "SETTLED", fields: decline({ raw_status: "SETTLED", advised_action: null, lifecycle_event: "AUTHORIZATION_SUCCESS" }), expect: "not_a_decline", basis: "settled" },
  { name: "cascade row (two decline records)", fields: decline({ primer_decline_code: "ERROR", issuer_result_code: "62", decline_record_count: 2 }), expect: "restricted_blocked" },
];

describe("decline_class: mutually exclusive, issuer code before Primer code (plan G, J)", () => {
  for (const entry of CORPUS) {
    it(entry.name, () => {
      const result = classifyDecline(entry.fields);
      expect(result.decline_class).toBe(entry.expect);
      if (entry.basis) expect(result.basis).toBe(entry.basis);
      expect(result.class_group).toBe(declineClassGroup(entry.expect));
    });
  }

  it("gives every corpus row exactly one class from the closed list", () => {
    const classes = new Set<DeclineClass>(DECLINE_CLASSES);
    for (const entry of CORPUS) {
      const result = classifyDecline(entry.fields);
      expect(classes.has(result.decline_class), entry.name).toBe(true);
      expect(typeof result.decline_class).toBe("string");
    }
    // The corpus reaches every class.
    const reached = new Set(CORPUS.map((entry) => classifyDecline(entry.fields).decline_class));
    expect([...classes].filter((cls) => !reached.has(cls))).toEqual([]);
  });

  it("the issuer classes are a subset of the classes and the labels cover every class", () => {
    for (const cls of ISSUER_DECLINE_CLASSES) expect(DECLINE_CLASSES).toContain(cls);
    expect(Object.keys(DECLINE_CLASS_LABELS).sort()).toEqual([...DECLINE_CLASSES].sort());
    for (const cls of ISSUER_DECLINE_CLASSES) expect(declineClassGroup(cls)).toBe("issuer");
    expect(declineClassGroup("not_a_decline")).toBe("none");
    // The frontend breaker matches "unavailable" in error text; no label says it.
    for (const label of Object.values(DECLINE_CLASS_LABELS)) expect(label).not.toMatch(/unavailable/i);
  });

  it("Primer ERROR with an issuer code is an issuer decline, never PSP / integration (plan N)", () => {
    for (const code of ["62", "9G", "82", "46"]) {
      const result = classifyDecline(decline({ primer_decline_code: "ERROR", issuer_result_code: code, lifecycle_event: "AUTHORIZATION_DECLINED" }));
      expect(result.class_group, code).toBe("issuer");
    }
    const failed = classifyDecline(decline({ primer_decline_code: "ERROR", issuer_result_code: null, lifecycle_event: "AUTHORIZATION_FAILED" }));
    expect(failed.decline_class).toBe("psp_integration");
  });

  it("the fraud-suspicion and lost / stolen flags follow the class: never set on a PSP / integration row (plan G: one code set, the tables add up)", () => {
    for (const entry of CORPUS) {
      const result = classifyDecline(entry.fields);
      expect(result.issuer_fraud_decline, entry.name).toBe(result.decline_class === "issuer_suspected_fraud");
      expect(result.lost_stolen_decline, entry.name).toBe(result.decline_class === "lost_stolen");
    }
    // AUTHORIZATION_FAILED + a Primer issuer-reason code, no issuer code: PSP / integration, flags off, the advised_action ban stays.
    const lost = classifyDecline(decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "LOST_OR_STOLEN_CARD", advised_action: "STOP_ALL_PAYMENTS" }));
    expect(lost).toMatchObject({
      decline_class: "psp_integration", class_group: "psp_integration", lost_stolen_decline: false, issuer_fraud_decline: false, retry_ban: true, ban_sources: ["advised_action"],
    });
    // The code-set helper still says lost / stolen: the class, not the helper, drives the line.
    expect(isLostStolenDecline(lost)).toBe(true);
    const fraud = classifyDecline(decline({ processor: "ADYEN", lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "SUSPECTED_FRAUD" }));
    expect(fraud).toMatchObject({ decline_class: "psp_integration", issuer_fraud_decline: false });
    expect(isIssuerFraudDecline(fraud)).toBe(true);
    // With an issuer code the code wins over the lifecycle, and the flag comes with the class.
    const stolen = classifyDecline(decline({ lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "LOST_OR_STOLEN_CARD", issuer_result_code: "43" }));
    expect(stolen).toMatchObject({ decline_class: "lost_stolen", lost_stolen_decline: true, issuer_fraud_decline: false });
  });

  it("the unrouted check comes before the lifecycle check: no processor can never be PSP / integration", () => {
    const result = classifyDecline(decline({ processor: null, lifecycle_event: "AUTHORIZATION_FAILED", primer_decline_code: "ERROR" }));
    expect(result).toMatchObject({ decline_class: "cause_unverified", basis: "unrouted" });
  });

  it("normalizes case, whitespace, hyphens and Python None before deciding", () => {
    const result = classifyDecline({
      raw_status: " declined ",
      processor: " stripe",
      card_network: "visa",
      primer_decline_code: "do-not-honor",
      issuer_result_code: " 59 ",
      advised_action: "retry later",
      lifecycle_event: "authorization-declined",
      advice_code: "None",
      decline_type: "None",
    });
    expect(result).toMatchObject({
      decline_class: "issuer_suspected_fraud",
      processor: "STRIPE",
      card_network: "VISA",
      primer_decline_code: "DO_NOT_HONOR",
      issuer_result_code: "59",
      advised_action: "RETRY_LATER",
      lifecycle_event: "AUTHORIZATION_DECLINED",
      advice_code: null,
    });
    // Never zero-padded: "5" stays "5" (a one-digit advice code is a Visa category, not a MAC).
    expect(normalizeCode("5")).toBe("5");
    expect(normalizeCode(" 03 ")).toBe("03");
    expect(normalizeCode("1a")).toBe("1A");
    expect(normalizeCode("")).toBeNull();
    expect(normalizeToken("undefined")).toBeNull();
    expect(normalizeCardNetwork("mastercard")).toBe("MASTERCARD");
    expect(normalizeCardNetwork("MC")).toBe("MASTERCARD");
    expect(normalizeCardNetwork("AMEX")).toBe("OTHER");
    expect(normalizeCardNetwork(null)).toBe("UNKNOWN");
  });

  it("a settled row is not a decline: no severity, no ban, no fraud flag", () => {
    const result = classifyDecline(decline({ raw_status: "SETTLED", issuer_result_code: "59", advised_action: "DO_NOT_RETRY" }));
    expect(result).toMatchObject({
      decline_class: "not_a_decline",
      severity: "unknown",
      retry_guidance: "unknown",
      retry_ban: false,
      ban_sources: [],
      issuer_fraud_decline: false,
      lost_stolen_decline: false,
    });
  });

  it("falls back to is_success when raw_status is missing (rows mapped before P0)", () => {
    expect(attemptOutcome({ raw_status: null, is_success: 1 })).toBe("success");
    expect(attemptOutcome({ raw_status: null, is_success: false })).toBe("decline");
    expect(attemptOutcome({ raw_status: null, is_success: null })).toBe("not_an_attempt");
    expect(attemptOutcome({ raw_status: "CANCELLED", is_success: 0 })).toBe("not_an_attempt");
    expect(attemptOutcome({ raw_status: "PENDING" })).toBe("not_an_attempt");
    expect(attemptOutcome({ raw_status: "FAILED" })).toBe("decline");
    expect([...ATTEMPT_RAW_STATUSES].sort()).toEqual(["DECLINED", "FAILED", "SETTLED"]);
    expect(classifyDecline({ raw_status: null, is_success: 1, issuer_result_code: "51" }).decline_class).toBe("not_a_decline");
    expect(classifyDecline({ raw_status: null, is_success: 0, processor: "ADYEN", issuer_result_code: "51" }).decline_class).toBe("insufficient_funds");
  });

  it("flags cascade rows (decline_record_count > 1) and nothing else", () => {
    expect(classifyDecline(decline({ decline_record_count: 2 })).cascade_row).toBe(true);
    expect(classifyDecline(decline({ decline_record_count: 1 })).cascade_row).toBe(false);
    expect(classifyDecline(decline({ decline_record_count: null })).cascade_row).toBe(false);
    expect(classifyDecline(decline({ decline_record_count: Number.NaN })).cascade_row).toBe(false);
  });
});

describe("issuer fraud-suspicion and lost / stolen: one code set, reused everywhere (plan G, H, J, Q)", () => {
  it("59 / 63 / 83 are the fraud set and 41 / 43 the lost-stolen set, both exported once and matching the code table", () => {
    expect([...ISSUER_FRAUD_DECLINE_CODES].sort()).toEqual(["59", "63", "83"]);
    expect([...LOST_STOLEN_CODES].sort()).toEqual(["41", "43"]);
    const fraudInTable = Object.entries(ISSUER_RESULT_CODES).filter(([, entry]) => entry.class === "issuer_suspected_fraud").map(([code]) => code).sort();
    const lostInTable = Object.entries(ISSUER_RESULT_CODES).filter(([, entry]) => entry.class === "lost_stolen").map(([code]) => code).sort();
    expect(fraudInTable).toEqual([...ISSUER_FRAUD_DECLINE_CODES].sort());
    expect(lostInTable).toEqual([...LOST_STOLEN_CODES].sort());
    expect(PRIMER_DECLINE_CODE_FALLBACK.SUSPECTED_FRAUD).toBe("issuer_suspected_fraud");
    expect(PRIMER_DECLINE_CODE_FALLBACK.LOST_OR_STOLEN_CARD).toBe("lost_stolen");
  });

  it("the Stripe 83 case: whatever Primer called it, it is an issuer fraud-suspicion decline", () => {
    for (const primer of ["REFER_TO_CARD_ISSUER", "ISSUER_TEMPORARILY_UNAVAILABLE", "DO_NOT_HONOR", "ERROR"]) {
      const result = classifyDecline(decline({ primer_decline_code: primer, issuer_result_code: "83" }));
      expect(result.decline_class, primer).toBe("issuer_suspected_fraud");
      expect(result.issuer_fraud_decline, primer).toBe(true);
      expect(result.lost_stolen_decline, primer).toBe(false);
    }
  });

  it("falls back to Primer SUSPECTED_FRAUD / LOST_OR_STOLEN_CARD only when no issuer code was relayed", () => {
    expect(isIssuerFraudDecline({ issuer_result_code: null, primer_decline_code: "SUSPECTED_FRAUD" })).toBe(true);
    expect(isIssuerFraudDecline({ issuer_result_code: "51", primer_decline_code: "SUSPECTED_FRAUD" })).toBe(false);
    expect(isIssuerFraudDecline({ issuer_result_code: "59", primer_decline_code: "DO_NOT_HONOR" })).toBe(true);
    expect(isLostStolenDecline({ issuer_result_code: null, primer_decline_code: "LOST_OR_STOLEN_CARD" })).toBe(true);
    expect(isLostStolenDecline({ issuer_result_code: "05", primer_decline_code: "LOST_OR_STOLEN_CARD" })).toBe(false);
    expect(isLostStolenDecline({ issuer_result_code: "43", primer_decline_code: "ERROR" })).toBe(true);
    // Lost / stolen is a separate line, never merged into the fraud set.
    const lost = classifyDecline(decline({ issuer_result_code: "41" }));
    expect(lost.issuer_fraud_decline).toBe(false);
    expect(lost.lost_stolen_decline).toBe(true);
  });

  it("unknown issuer codes are still issuer declines", () => {
    expect(issuerClassForCode("ZZ")).toBe("other_issuer");
    expect(issuerClassForCode(null)).toBeNull();
    expect(issuerClassForCode("65", "MASTERCARD")).toBe("authentication");
    expect(issuerClassForCode("65", "VISA")).toBe("insufficient_funds");
    expect(issuerClassForCode("65")).toBe("insufficient_funds");
  });
});

describe("soft / hard and retry guidance: advised_action, then the advice code, then declineType, then the Visa category", () => {
  const severity = (fields: DeclineFields) => {
    const result = classifyDecline(fields);
    return [result.severity, result.retry_guidance, result.severity_basis];
  };

  it("advised_action decides first", () => {
    expect(severity(decline({ advised_action: "RETRY_LATER", advice_code: "03" }))).toEqual(["soft", "retry_later", "advised_action"]);
    expect(severity(decline({ advised_action: "UPDATE_DATA" }))).toEqual(["hard", "update_data", "advised_action"]);
    expect(severity(decline({ advised_action: "DO_NOT_RETRY" }))).toEqual(["hard", "do_not_retry", "advised_action"]);
    expect(severity(decline({ advised_action: "STOP_ALL_PAYMENTS" }))).toEqual(["hard", "stop_all_payments", "advised_action"]);
  });

  it("then the Mastercard advice code", () => {
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "02" }))).toEqual(["soft", "retry_later", "advice_code"]);
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "24" }))).toEqual(["soft", "retry_later", "advice_code"]);
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "01" }))).toEqual(["hard", "update_data", "advice_code"]);
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "03" }))).toEqual(["hard", "do_not_retry", "advice_code"]);
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "21" }))).toEqual(["hard", "do_not_retry", "advice_code"]);
    // An advice code with no stated action does not decide.
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "05" }))).toEqual(["unknown", "unknown", "none"]);
    // The MAC table is a Mastercard rule: the same digits on a Visa or unknown-network row decide nothing, and a one-digit code is never a MAC.
    expect(severity(decline({ advised_action: null, card_network: "VISA", advice_code: "03" }))).toEqual(["unknown", "unknown", "none"]);
    expect(severity(decline({ advised_action: null, card_network: null, advice_code: "03" }))).toEqual(["unknown", "unknown", "none"]);
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "3" }))).toEqual(["unknown", "unknown", "none"]);
  });

  it("then Primer's declineType, then the Visa category of the issuer code", () => {
    expect(severity(decline({ advised_action: null, decline_type: "SOFT" }))).toEqual(["soft", "retry_later", "decline_type"]);
    expect(severity(decline({ advised_action: null, decline_type: "hard" }))).toEqual(["hard", "do_not_retry", "decline_type"]);
    expect(severity(decline({ advised_action: null, issuer_result_code: "46" }))).toEqual(["hard", "do_not_retry", "visa_category"]);
    expect(severity(decline({ advised_action: null, issuer_result_code: "51" }))).toEqual(["soft", "retry_later", "visa_category"]);
    expect(severity(decline({ advised_action: null, issuer_result_code: "54" }))).toEqual(["hard", "update_data", "visa_category"]);
    // Category 4 (generic) says nothing about severity; a non-Visa card gets no Visa category at all.
    expect(severity(decline({ advised_action: null, issuer_result_code: "05" }))).toEqual(["unknown", "unknown", "none"]);
    expect(severity(decline({ advised_action: null, card_network: "MASTERCARD", issuer_result_code: "46" }))).toEqual(["unknown", "unknown", "none"]);
    // On a Visa row the relayed category (advice code 1-4) comes first; the issuer-code table is the fallback without one.
    expect(severity(decline({ advised_action: null, advice_code: "1", issuer_result_code: "ZZ" }))).toEqual(["hard", "do_not_retry", "visa_category"]);
    expect(severity(decline({ advised_action: null, advice_code: "2", issuer_result_code: "46" }))).toEqual(["soft", "retry_later", "visa_category"]);
    expect(severity(decline({ advised_action: null, advice_code: "3", issuer_result_code: null }))).toEqual(["hard", "update_data", "visa_category"]);
    expect(severity(decline({ advised_action: null, advice_code: "4", issuer_result_code: "51" }))).toEqual(["unknown", "unknown", "none"]);
  });
});

describe("re-attempt bans (plan G retry_compliance (a)): DO_NOT_RETRY / STOP_ALL_PAYMENTS, Visa category 1, MAC 03 / 21", () => {
  it("names every source that bans the instrument", () => {
    expect(retryBanSources(decline({ advised_action: "DO_NOT_RETRY" }))).toEqual(["advised_action"]);
    expect(retryBanSources(decline({ advised_action: "STOP_ALL_PAYMENTS" }))).toEqual(["advised_action"]);
    expect(retryBanSources(decline({ advised_action: "RETRY_LATER", card_network: "VISA", issuer_result_code: "41" }))).toEqual(["visa_category_1"]);
    expect(retryBanSources(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "03" }))).toEqual(["mc_mac_03_21"]);
    expect(retryBanSources(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "21" }))).toEqual(["mc_mac_03_21"]);
    expect(retryBanSources(decline({ advised_action: "STOP_ALL_PAYMENTS", card_network: "VISA", issuer_result_code: "43", advice_code: "1" }))).toEqual(["advised_action", "visa_category_1"]);
    expect(retryBanSources(decline({ advised_action: "STOP_ALL_PAYMENTS", card_network: "MASTERCARD", issuer_result_code: "43", advice_code: "21" }))).toEqual(["advised_action", "mc_mac_03_21"]);
    expect([...RETRY_BAN_ADVISED_ACTIONS].sort()).toEqual(["DO_NOT_RETRY", "STOP_ALL_PAYMENTS"]);
    expect([...MC_MAC_BAN_CODES].sort()).toEqual(["03", "21"]);
  });

  it("does not ban on RETRY_LATER / UPDATE_DATA, category 2-4 codes, other advice codes, or Visa rules on a non-Visa card", () => {
    expect(isRetryBan(decline({ advised_action: "RETRY_LATER", issuer_result_code: "51" }))).toBe(false);
    expect(isRetryBan(decline({ advised_action: "UPDATE_DATA", issuer_result_code: "54" }))).toBe(false);
    expect(isRetryBan(decline({ advised_action: null, issuer_result_code: "05" }))).toBe(false);
    expect(isRetryBan(decline({ advised_action: null, card_network: "MASTERCARD", advice_code: "02" }))).toBe(false);
    // Visa categories are a Visa rule: 41 on a Mastercard or an unknown network is not a Visa category 1 ban.
    expect(isRetryBan(decline({ advised_action: null, card_network: "MASTERCARD", issuer_result_code: "41" }))).toBe(false);
    expect(isRetryBan(decline({ advised_action: null, card_network: null, issuer_result_code: "41" }))).toBe(false);
    expect(classifyDecline(decline({ advised_action: null, card_network: null, issuer_result_code: "41" })).visa_category).toBeNull();
  });

  it("reads the advice code by network: Visa's category 1-4 on a Visa row, a MAC on a Mastercard row, never crossed", () => {
    // Visa category 3 relayed as "3" (N7 CVV2 failure, UPDATE_DATA; 307 records on production) is not MAC 03: the retry Visa asks for
    // after the data is fixed is not a ban and not a violation.
    const visa3 = classifyDecline(decline({ issuer_result_code: "N7", advice_code: "3", advised_action: "UPDATE_DATA" }));
    expect(visa3).toMatchObject({ advice_code: "3", visa_category: 3, merchant_advice: null, retry_ban: false, ban_sources: [], severity: "hard", retry_guidance: "update_data" });
    for (const [advice, category] of [["1", 1], ["2", 2], ["3", 3], ["4", 4]] as const) {
      const result = classifyDecline(decline({ card_network: "VISA", issuer_result_code: "ZZ", advice_code: advice, advised_action: null }));
      expect(result.visa_category, advice).toBe(category);
      expect(result.merchant_advice, advice).toBeNull();
      expect(result.ban_sources, advice).toEqual(category === 1 ? ["visa_category_1"] : []);
    }
    // The relayed category is authoritative; the issuer-code table only fills in when no advice code was relayed.
    expect(classifyDecline(decline({ issuer_result_code: "51", advice_code: "1" })).visa_category).toBe(1);
    expect(classifyDecline(decline({ issuer_result_code: "46", advice_code: "2" })).visa_category).toBe(2);
    expect(classifyDecline(decline({ issuer_result_code: "46", advice_code: null })).visa_category).toBe(1);
    expect(visaDeclineCategoryOf({ card_network: "VISA", advice_code: null, issuer_result_code: null })).toBeNull();
    expect(visaDeclineCategoryOf({ card_network: "MASTERCARD", advice_code: "1", issuer_result_code: "41" })).toBeNull();
    expect(visaDeclineCategoryOf({ card_network: null, advice_code: "1", issuer_result_code: "41" })).toBeNull();
    expect(visaCategoryFromAdviceCode("03")).toBeNull();
    expect(visaCategoryFromAdviceCode("5")).toBeNull();
    expect(visaCategoryFromAdviceCode(" 2 ")).toBe(2);
    // Mastercard: MAC 03 / 21 ban; a one-digit code is not a MAC; the MAC table never reaches a Visa or unknown-network row.
    const mac = classifyDecline(decline({ card_network: "MASTERCARD", issuer_result_code: "05", advice_code: "03", advised_action: "DO_NOT_RETRY" }));
    expect(mac).toMatchObject({ visa_category: null, merchant_advice: expect.objectContaining({ code: "03", reattempt: "prohibited" }), ban_sources: ["advised_action", "mc_mac_03_21"] });
    expect(classifyDecline(decline({ card_network: "MASTERCARD", advice_code: "21", advised_action: "RETRY_LATER" })).ban_sources).toEqual(["mc_mac_03_21"]);
    expect(classifyDecline(decline({ card_network: "MASTERCARD", advice_code: "3", advised_action: null }))).toMatchObject({ merchant_advice: null, ban_sources: [] });
    expect(classifyDecline(decline({ card_network: "VISA", advice_code: "03", advised_action: null }))).toMatchObject({ merchant_advice: null, visa_category: null, ban_sources: [] });
    expect(classifyDecline(decline({ card_network: null, advice_code: "03", advised_action: null }))).toMatchObject({ merchant_advice: null, ban_sources: [] });
    expect(merchantAdviceRule("03", "VISA")).toBeNull();
    expect(merchantAdviceRule("03", null)).toBeNull();
  });

  it("the classification carries the ban and the Visa category", () => {
    const result = classifyDecline(decline({ advised_action: "RETRY_LATER", issuer_result_code: "46" }));
    expect(result.retry_ban).toBe(true);
    expect(result.ban_sources).toEqual(["visa_category_1"]);
    expect(result.visa_category).toBe(1);
    const limited = classifyDecline(decline({ issuer_result_code: "51" }));
    expect(limited.retry_ban).toBe(false);
    expect(limited.visa_category).toBe(2);
  });
});

describe("network rule tables (plan D): secondary sources, every row with its URL, date and verified = false", () => {
  it("Visa categories: 1 = never, 2-3 = limited; every other code is category 4; none without a code", () => {
    expect(visaDeclineCategory("41")).toBe(1);
    expect(visaDeclineCategory("46")).toBe(1);
    expect(visaDeclineCategory("R1")).toBe(1);
    expect(visaDeclineCategory("51")).toBe(2);
    expect(visaDeclineCategory("59")).toBe(2);
    expect(visaDeclineCategory("83")).toBe(2);
    expect(visaDeclineCategory("9G")).toBe(2);
    expect(visaDeclineCategory("54")).toBe(3);
    expect(visaDeclineCategory("1A")).toBe(3);
    expect(visaDeclineCategory("05")).toBe(4);
    expect(visaDeclineCategory("5")).toBe(4);
    expect(visaDeclineCategory("ZZ")).toBe(4);
    expect(visaDeclineCategory(null)).toBeNull();
    expect(visaDeclineCategory("  ")).toBeNull();
    const category1 = VISA_DECLINE_CATEGORY_RULES.filter((rule) => rule.category === 1).map((rule) => rule.code).sort();
    expect(category1).toEqual(["04", "07", "12", "14", "15", "41", "43", "46", "57", "R0", "R1", "R3"]);
    for (const rule of VISA_DECLINE_CATEGORY_RULES) {
      expect(rule.reattempt, rule.code).toBe(rule.category === 1 ? "prohibited" : rule.category === 2 ? "limited_per_30_days" : "update_data_first");
      expect(rule.reattempt, rule.code).toBe(VISA_CATEGORY_REATTEMPT[rule.category!]);
    }
    expect(VISA_CATEGORY_REATTEMPT).toEqual({ 1: "prohibited", 2: "limited_per_30_days", 3: "update_data_first", 4: "unknown" });
    expect(VISA_REATTEMPT_LIMIT_PER_30_DAYS).toBe(15);
  });

  it("Mastercard advice codes: 03 / 21 prohibit, 24-30 carry a wait, 01 asks for new data", () => {
    expect(merchantAdviceRule("03", "MASTERCARD")).toMatchObject({ reattempt: "prohibited" });
    expect(merchantAdviceRule("21", "MASTERCARD")).toMatchObject({ reattempt: "prohibited" });
    expect(merchantAdviceRule("01", "MASTERCARD")).toMatchObject({ reattempt: "update_data_first" });
    expect(merchantAdviceRule("02", "MASTERCARD")).toMatchObject({ reattempt: "retry_after", retry_after_hours: 72 });
    expect(merchantAdviceRule("24", "mc")).toMatchObject({ reattempt: "retry_after", retry_after_hours: 1 });
    expect(merchantAdviceRule("30", "MASTERCARD")).toMatchObject({ reattempt: "retry_after", retry_after_hours: 240 });
    // Never zero-padded: a one-digit code is not a MAC (none was ever relayed on a Mastercard row), and the table is Mastercard-only.
    expect(merchantAdviceRule("3", "MASTERCARD")).toBeNull();
    expect(merchantAdviceRule("03", "VISA")).toBeNull();
    expect(merchantAdviceRule("99", "MASTERCARD")).toBeNull();
    expect(merchantAdviceRule(null, "MASTERCARD")).toBeNull();
    for (const code of MC_MAC_BAN_CODES) expect(merchantAdviceRule(code, "MASTERCARD")?.reattempt, code).toBe("prohibited");
    const waits = MC_MERCHANT_ADVICE_CODE_RULES.filter((rule) => rule.reattempt === "retry_after").map((rule) => rule.retry_after_hours);
    for (const hours of waits) expect(hours).toBeGreaterThan(0);
    expect(MC_HARD_DECLINE_RULES.map((rule) => rule.code)).toEqual(["04", "14", "15", "41", "43", "54"]);
  });

  it("every row has an https source, a read date and is flagged UNVERIFIED; codes are unique per table", () => {
    expect(NETWORK_CODE_RULES.length).toBeGreaterThan(40);
    for (const rule of NETWORK_CODE_RULES) {
      expect(rule.source_url, rule.code).toMatch(/^https:\/\//);
      expect(rule.read_at, rule.code).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rule.verified, rule.code).toBe(false);
      expect(rule.meaning.length, rule.code).toBeGreaterThan(0);
      expect(rule.notes.length, rule.code).toBeGreaterThan(0);
    }
    for (const table of [VISA_DECLINE_CATEGORY_RULES, MC_MERCHANT_ADVICE_CODE_RULES, MC_HARD_DECLINE_RULES]) {
      const codes = table.map((rule) => rule.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
    // The 15-vs-20 disagreement between the two sources is recorded on the limited rows.
    for (const rule of VISA_DECLINE_CATEGORY_RULES.filter((candidate) => candidate.category !== 1)) expect(rule.notes).toMatch(/15 re-attempts.*20/);
  });

  it("never holds a real MID, card digit run, email or token (synthetic tables only)", () => {
    const text = JSON.stringify(NETWORK_CODE_RULES) + JSON.stringify(ISSUER_RESULT_CODES);
    expect(text).not.toMatch(/\d{6,}/);
    expect(text).not.toMatch(/@/);
  });
});
