// Decline taxonomy for Payment System Health (plan sections G, J and D).
//
// One pure module, one answer per decline: the mutually exclusive
// `decline_class`, the soft / hard severity, the retry guidance and the
// network re-attempt rules (Visa decline categories, Mastercard Merchant
// Advice Codes). Everything is keyed on the columns the P0 track extracts from
// the Primer `declineReasons` records into analytics_transactions
// (issuer_result_code, primer_decline_code, advice_code, advised_action,
// lifecycle_event, decline_type, decline_record_count); no JSON is read here.
//
// Why a separate module and not paymentFailures.ts: that normalizer tests
// "fraud" text before DO_NOT_HONOR and mixes Primer codes with issuer codes,
// which is fine for a UI label but wrong for risk (plan J: Stripe relays issuer
// code 59 "Suspected fraud" as Primer DO_NOT_HONOR, and 83 as
// REFER_TO_CARD_ISSUER / ISSUER_TEMPORARILY_UNAVAILABLE; Adyen relays both as
// SUSPECTED_FRAUD). Here the ISSUER code always wins and the Primer code is
// only a fallback when the issuer code is missing, so the same decline lands
// in the same class whichever processor relayed it.
//
// Class order (plan G `decline_class`, J): (1) an issuer result code -> one of
// the issuer classes; (2) AUTHENTICATION_REQUIRED (Primer) or 1A (issuer) ->
// authentication; (3) no processor -> cause_unverified (declined before
// routing, no decline record at all; possibly a Primer block, plan `psp_blocked`
// has no data before P5); (4) AUTHORIZATION_FAILED without an issuer code ->
// psp_integration; (5) the Primer code as a fallback; (6) AUTHORIZATION_DECLINED
// with no usable code -> other_issuer; (7) anything else -> cause_unverified.
// The plan lists (3) after (4); the two never overlap (an unrouted decline has
// no lifecycle event), and checking the processor first keeps "PSP /
// integration" a statement about a processor that exists.
//
// A decline is never called fraud (plan G): issuer_suspected_fraud is "the
// issuer declined with a fraud-suspicion code", nothing more.
//
// The flags issuer_fraud_decline / lost_stolen_decline follow the CLASS
// (issuer_suspected_fraud / lost_stolen), never the codes alone: a row the
// lifecycle puts under PSP / integration (AUTHORIZATION_FAILED without an
// issuer code; plan G step 3 comes before the Primer-code fallback) is not
// counted on the fraud-suspicion or lost / stolen lines even when its Primer
// code names one (production 2026-10-11: 7 LOST_OR_STOLEN_CARD and 0
// SUSPECTED_FRAUD rows under AUTHORIZATION_FAILED). The class and the flags
// can never disagree, so the decline_mix tables add up.
//
// advice_code (Primer payment_method_advice_code) is network-polymorphic: on
// a Visa response it is Visa's own decline category as ONE digit (1-4;
// production 2026-10-11: 20,356 records, never two digits), on a Mastercard
// response it is the TWO-digit Merchant Advice Code (11,824 records, never one
// digit), and no other network relays one. So the code is read by
// card_network: Visa -> the category itself (authoritative; the issuer-code
// table below is the fallback when no advice code was relayed), Mastercard ->
// the MAC table. A MAC rule or a MAC 03 / 21 ban never attaches to a Visa (or
// unknown-network) row and a Visa category never to a Mastercard row, and
// codes are never zero-padded ("3" is Visa category 3, not MAC 03).
//
// Network rules (plan D) come from SECONDARY sources (the Visa PDF could not be
// read), so every table row carries its source URL, the date it was read and
// `verified: false` ("НЕ ПРОВЕРЕНО"): confirm with the acquirer before alerting
// on penalties (plan AC, owner decision 8). Even the two sources disagree on
// the Visa category 2-4 limit (15 vs 20 re-attempts in 30 days); the plan's 15
// is kept and the disagreement is recorded on the rows.

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export const ISSUER_DECLINE_CLASSES = [
  "insufficient_funds",
  "issuer_suspected_fraud",
  "lost_stolen",
  "restricted_blocked",
  "closed_account",
  "policy",
  "issuer_temporarily_unavailable",
  "other_issuer",
] as const;

export type IssuerDeclineClass = (typeof ISSUER_DECLINE_CLASSES)[number];

export const DECLINE_CLASSES = [
  ...ISSUER_DECLINE_CLASSES,
  "authentication",
  "psp_integration",
  "cause_unverified",
  "not_a_decline",
] as const;

export type DeclineClass = (typeof DECLINE_CLASSES)[number];

/** The coarse grouping the "cause of deterioration" classifier (plan J) reads. */
export type DeclineClassGroup = "issuer" | "authentication" | "psp_integration" | "cause_unverified" | "none";

export type ClassBasis = "issuer_code" | "primer_code" | "lifecycle" | "unrouted" | "none" | "settled";
export type DeclineSeverity = "soft" | "hard" | "unknown";
export type SeverityBasis = "advised_action" | "advice_code" | "decline_type" | "visa_category" | "none";
export type RetryGuidance = "retry_later" | "update_data" | "do_not_retry" | "stop_all_payments" | "unknown";
export type BanSource = "advised_action" | "visa_category_1" | "mc_mac_03_21";
export type CardNetwork = "VISA" | "MASTERCARD" | "OTHER" | "UNKNOWN";

// ---------------------------------------------------------------------------
// Code sets — defined ONCE and reused by every consumer (plan G: "one set of
// codes in G, H, J and Q").
// ---------------------------------------------------------------------------

/** Issuer result codes that mean "the issuer suspects fraud" (59 suspected fraud, 63 security violation, 83 fraud / security). */
export const ISSUER_FRAUD_DECLINE_CODES: ReadonlySet<string> = new Set(["59", "63", "83"]);

/** Issuer result codes for a lost (41) or stolen (43) card: a separate line, never merged with the fraud set. */
export const LOST_STOLEN_CODES: ReadonlySet<string> = new Set(["41", "43"]);

/** Primer advised actions after which the same instrument must not be charged again. */
export const RETRY_BAN_ADVISED_ACTIONS: ReadonlySet<string> = new Set(["DO_NOT_RETRY", "STOP_ALL_PAYMENTS"]);

/** Mastercard Merchant Advice Codes that prohibit a re-attempt (03 do not try again, 21 payment cancellation). */
export const MC_MAC_BAN_CODES: ReadonlySet<string> = new Set(["03", "21"]);

/** A Visa response relays Visa's own decline category in payment_method_advice_code: one digit, 1-4. */
export const VISA_ADVICE_CATEGORY_PATTERN = /^[1-4]$/;

/** Primer decline codes that stand in for the fraud / lost-stolen sets when no issuer code was relayed. */
export const PRIMER_SUSPECTED_FRAUD_CODE = "SUSPECTED_FRAUD";
export const PRIMER_LOST_OR_STOLEN_CODE = "LOST_OR_STOLEN_CARD";
export const PRIMER_AUTHENTICATION_REQUIRED_CODE = "AUTHENTICATION_REQUIRED";

/** Primer transaction lifecycle events the classifier reads. */
export const LIFECYCLE_AUTHORIZATION_FAILED = "AUTHORIZATION_FAILED";
export const LIFECYCLE_AUTHORIZATION_DECLINED = "AUTHORIZATION_DECLINED";

/** Visa decline categories whose re-attempts are limited (plan D: more than 15 in 30 days is a potential violation). */
export const VISA_LIMITED_REATTEMPT_CATEGORIES: ReadonlySet<number> = new Set([2, 3, 4]);
export const VISA_REATTEMPT_LIMIT_PER_30_DAYS = 15;

// ---------------------------------------------------------------------------
// Network rule tables (plan D). Secondary sources, UNVERIFIED by the network's
// own rule book; one row per code with its source URL and the date it was read.
// ---------------------------------------------------------------------------

export type ReattemptRule = "prohibited" | "limited_per_30_days" | "retry_after" | "update_data_first" | "unknown";

/** What each Visa decline category allows (plan D): 1 never again, 2 and 3 at most 15 per 30 days (3 only after
 * updated data), 4 unstated by the sources. */
export const VISA_CATEGORY_REATTEMPT: Readonly<Record<1 | 2 | 3 | 4, ReattemptRule>> = {
  1: "prohibited",
  2: "limited_per_30_days",
  3: "update_data_first",
  4: "unknown",
};

export interface NetworkCodeRule {
  network: Extract<CardNetwork, "VISA" | "MASTERCARD">;
  kind: "visa_decline_category" | "mc_merchant_advice_code" | "mc_hard_decline";
  code: string;
  /** Visa decline category (1 = issuer will never approve, 2 = cannot approve now, 3 = fix the details, 4 = generic). */
  category: 1 | 2 | 3 | 4 | null;
  meaning: string;
  reattempt: ReattemptRule;
  /** For `retry_after` rules: the wait the network advises before the next attempt. */
  retry_after_hours: number | null;
  source_url: string;
  /** The day the source page was read. */
  read_at: string;
  /** false = UNVERIFIED (secondary source, not the network's rule book). */
  verified: boolean;
  notes: string;
}

const PAYPAL_RETRIES = "https://www.paypal.com/us/brc/article/avoid-excessive-retries-penalties";
const PAYWAY_REATTEMPTS = "https://www.payway.com/visa-excessive-reattempts-rule-fees";
const READ_AT = "2026-10-11";
const VISA_LIMIT_NOTE =
  "Limit per plan D: 15 re-attempts per card in 30 days (payway); the PayPal page says 20. Secondary sources only — confirm with the acquirer.";

function visaRows(category: 1 | 2 | 3, reattempt: ReattemptRule, codes: Array<[string, string]>, source: string, notes: string): NetworkCodeRule[] {
  return codes.map(([code, meaning]) => ({
    network: "VISA",
    kind: "visa_decline_category",
    code,
    category,
    meaning,
    reattempt,
    retry_after_hours: null,
    source_url: source,
    read_at: READ_AT,
    verified: false,
    notes,
  }));
}

/** Visa decline categories by issuer response code. Category 4 is "every other response code" (not enumerated by the source). */
export const VISA_DECLINE_CATEGORY_RULES: readonly NetworkCodeRule[] = [
  ...visaRows(1, "prohibited", [
    ["04", "Pick up card"],
    ["07", "Pick up card, special condition"],
    ["12", "Invalid transaction"],
    ["14", "Invalid account number"],
    ["15", "No such issuer"],
    ["41", "Lost card, pick up"],
    ["43", "Stolen card, pick up"],
    ["46", "Closed account"],
    ["57", "Transaction not permitted to cardholder"],
    ["R0", "Stop payment order"],
    ["R1", "Revocation of authorization order"],
    ["R3", "Revocation of all authorizations order"],
  ], PAYWAY_REATTEMPTS, "Category 1 'issuer will never approve': any re-attempt on the same credential is a violation. Listed identically by the PayPal page."),
  ...visaRows(2, "limited_per_30_days", [
    ["03", "Invalid merchant"],
    ["19", "Re-enter transaction"],
    ["39", "No credit account"],
    ["51", "Insufficient funds"],
    ["52", "No checking account"],
    ["53", "No savings account"],
    ["59", "Suspected fraud"],
    ["61", "Exceeds withdrawal amount limit"],
    ["62", "Restricted card"],
    ["65", "Exceeds withdrawal frequency limit"],
    ["75", "Allowable PIN tries exceeded"],
    ["78", "Blocked, first used"],
    ["83", "Fraud / security"],
    ["86", "Cannot verify PIN"],
    ["91", "Issuer or switch inoperative"],
    ["93", "Transaction cannot be completed, violation of law"],
    ["96", "System malfunction"],
    ["5C", "Meaning not stated by the source"],
    ["9G", "Meaning not stated by the source"],
    ["N3", "Cash service not available"],
    ["N4", "Cash request exceeds issuer or approved limit"],
    ["Z5", "Meaning not stated by the source"],
  ], PAYPAL_RETRIES, `Category 2 'issuer cannot approve at this time'. ${VISA_LIMIT_NOTE} payway lists the subset 03, 19, 51, 59, 61, 62, 65, 75, 86, 91, 93, 96, N3, N4.`),
  ...visaRows(3, "update_data_first", [
    ["54", "Expired card"],
    ["55", "Incorrect PIN"],
    ["70", "PIN data required"],
    ["82", "Negative CAM, dCVV, iCVV or CVV results"],
    ["6P", "Verification data failed"],
    ["1A", "Additional customer authentication required"],
    ["N7", "Decline for CVV2 failure"],
  ], PAYPAL_RETRIES, `Category 3 'issuer cannot approve based on the details provided': obtain updated data before the next attempt; the same 30-day limit applies. ${VISA_LIMIT_NOTE}`),
];

/** [code, meaning, re-attempt rule, wait in hours, notes] */
type AdviceRow = [string, string, ReattemptRule, number | null, string];

/** Mastercard Merchant Advice Codes (`payment_method_advice_code` in the Primer record). */
const MC_MERCHANT_ADVICE_ROWS: readonly AdviceRow[] = [
  ["01", "New account information available", "update_data_first", null, "Obtain new account information (e.g. through the account updater) before the next billing cycle."],
  ["02", "Cannot approve at this time, try again later", "retry_after", 72, "The source advises recycling the transaction 72 hours later."],
  ["03", "Do not try again", "prohibited", null, "Obtain another payment type from the customer. A fee applies when 03/21 is returned again within 30 days (plan D)."],
  ["04", "Token requirements not fulfilled for this token type", "update_data_first", null, "Action not stated by the source."],
  ["05", "Negotiated value not approved", "unknown", null, "Action not stated by the source."],
  ["21", "Payment cancellation (cardholder cancelled)", "prohibited", null, "Do not resubmit. A fee applies when 03/21 is returned again within 30 days (plan D)."],
  ["24", "Insufficient funds", "retry_after", 1, "Retry after 1 hour."],
  ["25", "Insufficient funds", "retry_after", 24, "Retry after 24 hours."],
  ["26", "Insufficient funds", "retry_after", 48, "Retry after 2 days."],
  ["27", "Insufficient funds", "retry_after", 96, "Retry after 4 days."],
  ["28", "Insufficient funds", "retry_after", 144, "Retry after 6 days."],
  ["29", "Insufficient funds", "retry_after", 192, "Retry after 8 days."],
  ["30", "Insufficient funds", "retry_after", 240, "Retry after 10 days."],
  ["40", "Non-reloadable prepaid card", "unknown", null, "Action not stated by the source."],
  ["41", "Single-use virtual card", "unknown", null, "Action not stated by the source."],
];

export const MC_MERCHANT_ADVICE_CODE_RULES: readonly NetworkCodeRule[] = MC_MERCHANT_ADVICE_ROWS.map(([code, meaning, reattempt, hours, notes]) => ({
  network: "MASTERCARD",
  kind: "mc_merchant_advice_code",
  code,
  category: null,
  meaning,
  reattempt,
  retry_after_hours: hours,
  source_url: PAYPAL_RETRIES,
  read_at: READ_AT,
  verified: false,
  notes,
}));

/** Mastercard card-not-present hard declines (same PAN + expiry must not be retried). Reference only: the
 * ban logic follows plan G (MAC 03/21), these rows wait for the acquirer's confirmation (owner decision 8). */
export const MC_HARD_DECLINE_RULES: readonly NetworkCodeRule[] = ["04", "14", "15", "41", "43", "54"].map((code) => ({
  network: "MASTERCARD" as const,
  kind: "mc_hard_decline" as const,
  code,
  category: null,
  meaning: "Mastercard hard decline (card-not-present)",
  reattempt: "prohibited" as const,
  retry_after_hours: null,
  source_url: PAYPAL_RETRIES,
  read_at: READ_AT,
  verified: false,
  notes: "No further authorization for the same PAN and expiry at any time (source). Not used for violations until confirmed (plan G names only MAC 03/21).",
}));

export const NETWORK_CODE_RULES: readonly NetworkCodeRule[] = [
  ...VISA_DECLINE_CATEGORY_RULES,
  ...MC_MERCHANT_ADVICE_CODE_RULES,
  ...MC_HARD_DECLINE_RULES,
];

const VISA_RULE_BY_CODE = new Map(VISA_DECLINE_CATEGORY_RULES.map((rule) => [rule.code, rule]));
const MAC_RULE_BY_CODE = new Map(MC_MERCHANT_ADVICE_CODE_RULES.map((rule) => [rule.code, rule]));

// ---------------------------------------------------------------------------
// Issuer result codes -> issuer class. ISO 8583 response codes as the
// processors relay them through Primer (`payment_method_result_code`).
// ---------------------------------------------------------------------------

export interface IssuerCodeEntry {
  class: IssuerDeclineClass | "authentication";
  meaning: string;
}

/** `65` is network-dependent: Mastercard repurposed it as the SCA soft decline ("authentication required"),
 * Visa keeps the ISO meaning (withdrawal frequency limit). Resolved in issuerClassForCode. */
export const ISSUER_RESULT_CODES: Readonly<Record<string, IssuerCodeEntry>> = {
  "51": { class: "insufficient_funds", meaning: "Insufficient funds" },
  "61": { class: "insufficient_funds", meaning: "Exceeds withdrawal amount limit" },
  "65": { class: "insufficient_funds", meaning: "Exceeds withdrawal frequency limit (Visa); authentication required (Mastercard)" },
  "59": { class: "issuer_suspected_fraud", meaning: "Suspected fraud" },
  "63": { class: "issuer_suspected_fraud", meaning: "Security violation" },
  "83": { class: "issuer_suspected_fraud", meaning: "Fraud / security" },
  "41": { class: "lost_stolen", meaning: "Lost card" },
  "43": { class: "lost_stolen", meaning: "Stolen card" },
  "04": { class: "restricted_blocked", meaning: "Pick up card" },
  "07": { class: "restricted_blocked", meaning: "Pick up card, special condition" },
  "36": { class: "restricted_blocked", meaning: "Restricted card" },
  "62": { class: "restricted_blocked", meaning: "Restricted card" },
  "78": { class: "restricted_blocked", meaning: "Blocked, first used" },
  "R0": { class: "restricted_blocked", meaning: "Stop payment order" },
  "R1": { class: "restricted_blocked", meaning: "Revocation of authorization order" },
  "R3": { class: "restricted_blocked", meaning: "Revocation of all authorizations order" },
  "46": { class: "closed_account", meaning: "Closed account" },
  "54": { class: "closed_account", meaning: "Expired card (account not usable)" },
  "14": { class: "closed_account", meaning: "Invalid account number (account not usable)" },
  "15": { class: "closed_account", meaning: "No such issuer (account not usable)" },
  "05": { class: "policy", meaning: "Do not honor" },
  "57": { class: "policy", meaning: "Transaction not permitted to cardholder" },
  "58": { class: "policy", meaning: "Transaction not permitted to terminal" },
  "03": { class: "policy", meaning: "Invalid merchant" },
  "12": { class: "policy", meaning: "Invalid transaction" },
  "13": { class: "policy", meaning: "Invalid amount" },
  "75": { class: "policy", meaning: "Allowable PIN tries exceeded" },
  "82": { class: "policy", meaning: "Negative CAM, dCVV, iCVV or CVV results" },
  "93": { class: "policy", meaning: "Transaction cannot be completed, violation of law" },
  "N7": { class: "policy", meaning: "Decline for CVV2 failure" },
  "6P": { class: "policy", meaning: "Verification data failed" },
  "19": { class: "issuer_temporarily_unavailable", meaning: "Re-enter transaction" },
  "68": { class: "issuer_temporarily_unavailable", meaning: "Response received too late" },
  "91": { class: "issuer_temporarily_unavailable", meaning: "Issuer or switch inoperative" },
  "96": { class: "issuer_temporarily_unavailable", meaning: "System malfunction" },
  "1A": { class: "authentication", meaning: "Additional customer authentication required" },
};

/** Primer decline codes used ONLY when no issuer result code was relayed (plan G). */
export const PRIMER_DECLINE_CODE_FALLBACK: Readonly<Record<string, IssuerDeclineClass | "authentication">> = {
  INSUFFICIENT_FUNDS: "insufficient_funds",
  WITHDRAWAL_LIMIT_EXCEEDED: "insufficient_funds",
  [PRIMER_SUSPECTED_FRAUD_CODE]: "issuer_suspected_fraud",
  [PRIMER_LOST_OR_STOLEN_CODE]: "lost_stolen",
  RESTRICTED_CARD: "restricted_blocked",
  EXPIRED_CARD: "closed_account",
  INVALID_CARD_NUMBER: "closed_account",
  DO_NOT_HONOR: "policy",
  ISSUER_TEMPORARILY_UNAVAILABLE: "issuer_temporarily_unavailable",
  REFER_TO_CARD_ISSUER: "other_issuer",
  [PRIMER_AUTHENTICATION_REQUIRED_CODE]: "authentication",
};

// ---------------------------------------------------------------------------
// Input and output shapes
// ---------------------------------------------------------------------------

/** The decline-related columns of one analytics_transactions row (plan T). Every field may be missing. */
export interface DeclineFields {
  raw_status?: string | null;
  is_success?: boolean | number | null;
  processor?: string | null;
  card_network?: string | null;
  primer_decline_code?: string | null;
  issuer_result_code?: string | null;
  advice_code?: string | null;
  advised_action?: string | null;
  lifecycle_event?: string | null;
  decline_type?: string | null;
  decline_record_count?: number | null;
}

export interface DeclineClassification {
  decline_class: DeclineClass;
  class_group: DeclineClassGroup;
  basis: ClassBasis;
  /** Normalized inputs (trimmed, upper-cased; empty -> null), so consumers never re-normalize. */
  processor: string | null;
  card_network: CardNetwork;
  issuer_result_code: string | null;
  primer_decline_code: string | null;
  advice_code: string | null;
  advised_action: string | null;
  lifecycle_event: string | null;
  severity: DeclineSeverity;
  severity_basis: SeverityBasis;
  retry_guidance: RetryGuidance;
  /** decline_class is issuer_suspected_fraud (issuer 59 / 63 / 83, or Primer SUSPECTED_FRAUD when no issuer code was
   * relayed and the lifecycle did not already decide). Not fraud. Follows the class, see the header. */
  issuer_fraud_decline: boolean;
  /** decline_class is lost_stolen (issuer 41 / 43, or Primer LOST_OR_STOLEN_CARD likewise). A separate line. */
  lost_stolen_decline: boolean;
  /** Visa decline category (Visa rows only): the category Visa relayed in the advice code, else the issuer-code table's. */
  visa_category: 1 | 2 | 3 | 4 | null;
  /** The Mastercard Merchant Advice Code rule (Mastercard rows only), when the relayed advice code is a known MAC. */
  merchant_advice: NetworkCodeRule | null;
  /** The same instrument must not be charged again after this decline (plan G retry_compliance (a)). */
  retry_ban: boolean;
  ban_sources: BanSource[];
  /** More than one decline record on the row: a cascade inside one Primer payment (plan G cascade_rows). */
  cascade_row: boolean;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function text(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === "None" || trimmed === "null" || trimmed === "undefined") return null;
  return trimmed;
}

/** Upper-cased token: spaces and hyphens become underscores (Primer codes, advised actions, lifecycle events). */
export function normalizeToken(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed ? trimmed.toUpperCase().replace(/[\s-]+/g, "_") : null;
}

/** Issuer result / advice codes keep their characters, upper-cased ("1a" -> "1A") and never zero-padded: a one-digit
 * advice code is a Visa decline category and a two-digit one a Mastercard MAC (issuer codes arrive as two characters). */
export function normalizeCode(value: unknown): string | null {
  const trimmed = text(value);
  return trimmed ? trimmed.toUpperCase() : null;
}

export function normalizeCardNetwork(value: unknown): CardNetwork {
  const token = normalizeToken(value);
  if (!token) return "UNKNOWN";
  if (token === "VISA" || token.startsWith("VISA_")) return "VISA";
  if (token === "MASTERCARD" || token === "MASTER_CARD" || token === "MC" || token.startsWith("MASTERCARD_")) return "MASTERCARD";
  return "OTHER";
}

/** Attempts (plan G `attempts`): SETTLED / DECLINED / FAILED by raw_status; CANCELLED and PENDING are not attempts. */
export const ATTEMPT_RAW_STATUSES: ReadonlySet<string> = new Set(["SETTLED", "DECLINED", "FAILED"]);

export type AttemptOutcome = "success" | "decline" | "not_an_attempt";

/** The outcome of a row. Without raw_status (rows mapped before P0) the is_success flag decides. */
export function attemptOutcome(fields: Pick<DeclineFields, "raw_status" | "is_success">): AttemptOutcome {
  const status = normalizeToken(fields.raw_status);
  if (status) {
    if (status === "SETTLED") return "success";
    return ATTEMPT_RAW_STATUSES.has(status) ? "decline" : "not_an_attempt";
  }
  if (fields.is_success == null) return "not_an_attempt";
  return fields.is_success === true || fields.is_success === 1 ? "success" : "decline";
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

/** Visa decline category of an issuer response code per the (secondary-source) table: 4 = every code not in
 * categories 1-3; null without a code. The fallback behind visaDeclineCategoryOf. */
export function visaDeclineCategory(issuerResultCode: unknown): 1 | 2 | 3 | 4 | null {
  const code = normalizeCode(issuerResultCode);
  if (!code) return null;
  return VISA_RULE_BY_CODE.get(code)?.category ?? 4;
}

export function visaDeclineRule(issuerResultCode: unknown): NetworkCodeRule | null {
  const code = normalizeCode(issuerResultCode);
  return code ? VISA_RULE_BY_CODE.get(code) ?? null : null;
}

/** The decline category a Visa response relays in payment_method_advice_code (one digit, 1-4); null for anything else. */
export function visaCategoryFromAdviceCode(adviceCode: unknown): 1 | 2 | 3 | 4 | null {
  const code = normalizeCode(adviceCode);
  return code && VISA_ADVICE_CATEGORY_PATTERN.test(code) ? (Number(code) as 1 | 2 | 3 | 4) : null;
}

/** The Visa decline category of a row: only when the card is Visa; the relayed category (authoritative) first, the
 * issuer-code table when no advice code was relayed. */
export function visaDeclineCategoryOf(fields: Pick<DeclineFields, "advice_code" | "issuer_result_code" | "card_network">): 1 | 2 | 3 | 4 | null {
  if (normalizeCardNetwork(fields.card_network) !== "VISA") return null;
  return visaCategoryFromAdviceCode(fields.advice_code) ?? visaDeclineCategory(fields.issuer_result_code);
}

/** The Mastercard Merchant Advice Code rule of a row: only when the card is Mastercard (on a Visa row the same field
 * holds the decline category, and an unknown network gets no network rule). A one-digit code is never a MAC. */
export function merchantAdviceRule(adviceCode: unknown, cardNetwork: unknown): NetworkCodeRule | null {
  if (normalizeCardNetwork(cardNetwork) !== "MASTERCARD") return null;
  const code = normalizeCode(adviceCode);
  return code ? MAC_RULE_BY_CODE.get(code) ?? null : null;
}

/** The issuer class of a result code; unknown codes are still issuer declines (other_issuer). */
export function issuerClassForCode(issuerResultCode: unknown, cardNetwork?: unknown): IssuerDeclineClass | "authentication" | null {
  const code = normalizeCode(issuerResultCode);
  if (!code) return null;
  if (code === "65" && normalizeCardNetwork(cardNetwork) === "MASTERCARD") return "authentication";
  return ISSUER_RESULT_CODES[code]?.class ?? "other_issuer";
}

/** The code-set test behind issuer_suspected_fraud (plan G, H, J, Q). classifyDecline's issuer_fraud_decline flag follows
 * the CLASS: a row the lifecycle puts under PSP / integration is not flagged even when its Primer code is SUSPECTED_FRAUD. */
export function isIssuerFraudDecline(fields: Pick<DeclineFields, "issuer_result_code" | "primer_decline_code">): boolean {
  const code = normalizeCode(fields.issuer_result_code);
  if (code) return ISSUER_FRAUD_DECLINE_CODES.has(code);
  return normalizeToken(fields.primer_decline_code) === PRIMER_SUSPECTED_FRAUD_CODE;
}

/** The code-set test behind lost_stolen; classifyDecline's lost_stolen_decline flag follows the class, as above. */
export function isLostStolenDecline(fields: Pick<DeclineFields, "issuer_result_code" | "primer_decline_code">): boolean {
  const code = normalizeCode(fields.issuer_result_code);
  if (code) return LOST_STOLEN_CODES.has(code);
  return normalizeToken(fields.primer_decline_code) === PRIMER_LOST_OR_STOLEN_CODE;
}

/** Why the same instrument must not be charged again after this decline (empty = no ban). */
export function retryBanSources(fields: Pick<DeclineFields, "advised_action" | "advice_code" | "issuer_result_code" | "card_network">): BanSource[] {
  const sources: BanSource[] = [];
  const action = normalizeToken(fields.advised_action);
  if (action && RETRY_BAN_ADVISED_ACTIONS.has(action)) sources.push("advised_action");
  // Visa categories are a Visa rule: applied only when the card is known to be Visa (the relayed category first).
  if (visaDeclineCategoryOf(fields) === 1) sources.push("visa_category_1");
  // Merchant Advice Codes are a Mastercard rule: applied only when the card is known to be Mastercard. On a Visa row the
  // same field holds the decline category ("3" is category 3, not MAC 03), and an unknown network gets no network rule.
  const advice = normalizeCode(fields.advice_code);
  if (advice && MC_MAC_BAN_CODES.has(advice) && normalizeCardNetwork(fields.card_network) === "MASTERCARD") sources.push("mc_mac_03_21");
  return sources;
}

export function isRetryBan(fields: Pick<DeclineFields, "advised_action" | "advice_code" | "issuer_result_code" | "card_network">): boolean {
  return retryBanSources(fields).length > 0;
}

const CLASS_GROUP: Readonly<Record<DeclineClass, DeclineClassGroup>> = {
  insufficient_funds: "issuer",
  issuer_suspected_fraud: "issuer",
  lost_stolen: "issuer",
  restricted_blocked: "issuer",
  closed_account: "issuer",
  policy: "issuer",
  issuer_temporarily_unavailable: "issuer",
  other_issuer: "issuer",
  authentication: "authentication",
  psp_integration: "psp_integration",
  cause_unverified: "cause_unverified",
  not_a_decline: "none",
};

export function declineClassGroup(declineClass: DeclineClass): DeclineClassGroup {
  return CLASS_GROUP[declineClass];
}

// ---------------------------------------------------------------------------
// Severity (soft / hard) and retry guidance: advised_action first, then the
// Mastercard advice code (Mastercard rows), then Primer's declineType, then
// the Visa category (Visa rows: the relayed category, else the issuer-code
// table).
// ---------------------------------------------------------------------------

function severityFromAdvisedAction(action: string | null): { severity: DeclineSeverity; guidance: RetryGuidance } | null {
  switch (action) {
    case "RETRY_LATER":
      return { severity: "soft", guidance: "retry_later" };
    // The same details will not be approved: hard for this data, even though another card may succeed.
    case "UPDATE_DATA":
      return { severity: "hard", guidance: "update_data" };
    case "DO_NOT_RETRY":
      return { severity: "hard", guidance: "do_not_retry" };
    case "STOP_ALL_PAYMENTS":
      return { severity: "hard", guidance: "stop_all_payments" };
    default:
      return null;
  }
}

function severityFromReattempt(reattempt: ReattemptRule | null): { severity: DeclineSeverity; guidance: RetryGuidance } | null {
  switch (reattempt) {
    case "prohibited":
      return { severity: "hard", guidance: "do_not_retry" };
    case "retry_after":
    case "limited_per_30_days":
      return { severity: "soft", guidance: "retry_later" };
    case "update_data_first":
      return { severity: "hard", guidance: "update_data" };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export function classifyDecline(fields: DeclineFields): DeclineClassification {
  const processor = normalizeToken(fields.processor);
  const cardNetwork = normalizeCardNetwork(fields.card_network);
  const issuerCode = normalizeCode(fields.issuer_result_code);
  const primerCode = normalizeToken(fields.primer_decline_code);
  const adviceCode = normalizeCode(fields.advice_code);
  const advisedAction = normalizeToken(fields.advised_action);
  const lifecycle = normalizeToken(fields.lifecycle_event);
  const declineType = normalizeToken(fields.decline_type);
  const recordCount = typeof fields.decline_record_count === "number" && Number.isFinite(fields.decline_record_count) ? fields.decline_record_count : null;

  let declineClass: DeclineClass;
  let basis: ClassBasis;
  if (attemptOutcome(fields) === "success") {
    declineClass = "not_a_decline";
    basis = "settled";
  } else if (issuerCode) {
    // (1) The issuer answered: its code decides, whatever Primer called it (ERROR, DO_NOT_HONOR, ...).
    declineClass = issuerClassForCode(issuerCode, cardNetwork) as DeclineClass;
    basis = "issuer_code";
  } else if (primerCode === PRIMER_AUTHENTICATION_REQUIRED_CODE) {
    // (2) Primer says authentication is required (1A is caught above as an issuer code).
    declineClass = "authentication";
    basis = "primer_code";
  } else if (!processor) {
    // (3) Declined before routing: no processor, no decline record. The cause cannot be verified.
    declineClass = "cause_unverified";
    basis = "unrouted";
  } else if (lifecycle === LIFECYCLE_AUTHORIZATION_FAILED) {
    // (4) The processor could not authorize and relayed no issuer code: PSP / integration.
    declineClass = "psp_integration";
    basis = "lifecycle";
  } else if (primerCode && PRIMER_DECLINE_CODE_FALLBACK[primerCode]) {
    // (5) No issuer code: the Primer code as a fallback.
    declineClass = PRIMER_DECLINE_CODE_FALLBACK[primerCode];
    basis = "primer_code";
  } else if (lifecycle === LIFECYCLE_AUTHORIZATION_DECLINED) {
    // (6) The issuer declined but relayed no reason we can place (ERROR / UNKNOWN / DECLINED without a code).
    declineClass = "other_issuer";
    basis = "lifecycle";
  } else {
    declineClass = "cause_unverified";
    basis = "none";
  }

  const merchantAdvice = merchantAdviceRule(adviceCode, cardNetwork);
  const visaCategory = visaDeclineCategoryOf({ advice_code: adviceCode, issuer_result_code: issuerCode, card_network: cardNetwork });

  let severity: DeclineSeverity = "unknown";
  let severityBasis: SeverityBasis = "none";
  let guidance: RetryGuidance = "unknown";
  if (declineClass !== "not_a_decline") {
    const fromAction = severityFromAdvisedAction(advisedAction);
    const fromAdvice = severityFromReattempt(merchantAdvice?.reattempt ?? null);
    const fromVisa = severityFromReattempt(visaCategory == null ? null : VISA_CATEGORY_REATTEMPT[visaCategory]);
    if (fromAction) {
      ({ severity, guidance } = fromAction);
      severityBasis = "advised_action";
    } else if (fromAdvice) {
      ({ severity, guidance } = fromAdvice);
      severityBasis = "advice_code";
    } else if (declineType === "SOFT" || declineType === "HARD") {
      severity = declineType === "SOFT" ? "soft" : "hard";
      guidance = severity === "soft" ? "retry_later" : "do_not_retry";
      severityBasis = "decline_type";
    } else if (fromVisa) {
      ({ severity, guidance } = fromVisa);
      severityBasis = "visa_category";
    }
  }

  const banSources = declineClass === "not_a_decline"
    ? []
    : retryBanSources({ advised_action: advisedAction, advice_code: adviceCode, issuer_result_code: issuerCode, card_network: cardNetwork });

  return {
    decline_class: declineClass,
    class_group: CLASS_GROUP[declineClass],
    basis,
    processor,
    card_network: cardNetwork,
    issuer_result_code: issuerCode,
    primer_decline_code: primerCode,
    advice_code: adviceCode,
    advised_action: advisedAction,
    lifecycle_event: lifecycle,
    severity,
    severity_basis: severityBasis,
    retry_guidance: guidance,
    // The flags follow the class (header): the code sets decide the class, the class decides the lines.
    issuer_fraud_decline: declineClass === "issuer_suspected_fraud",
    lost_stolen_decline: declineClass === "lost_stolen",
    visa_category: visaCategory,
    merchant_advice: merchantAdvice,
    retry_ban: banSources.length > 0,
    ban_sources: banSources,
    cascade_row: recordCount != null && recordCount > 1,
  };
}

/** Human labels for the UI (plan R): facts, never accusations. */
export const DECLINE_CLASS_LABELS: Readonly<Record<DeclineClass, string>> = {
  insufficient_funds: "Insufficient funds",
  issuer_suspected_fraud: "Issuer suspected fraud (decline, not fraud)",
  lost_stolen: "Lost or stolen card",
  restricted_blocked: "Restricted or blocked card",
  closed_account: "Closed or unusable account",
  policy: "Issuer policy",
  issuer_temporarily_unavailable: "Issuer temporarily unreachable",
  other_issuer: "Other issuer decline",
  authentication: "Authentication required",
  psp_integration: "PSP / integration",
  cause_unverified: "Cause not verified",
  not_a_decline: "Not a decline",
};
