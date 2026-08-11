// Data for the issuer classifier — kept apart from the rules in cardIssuer.ts
// so tuning a group or adding a suffix never touches the rule engine or its
// tests.
//
// Everything here is a CLOSED vocabulary. There is no fuzzy matching anywhere
// in the issuer pipeline: a wrong merge is fixed by adding an entry to one of
// these tables, never by loosening a rule. Changing any of this requires a
// ClickHouse re-backfill (the columns are written at ingestion), so treat edits
// as schema changes, not copy tweaks.

/**
 * Legal suffixes stripped from the TAIL of the token list, longest sequence
 * first, repeatedly until nothing matches. Tail-only stripping is what keeps
 * sub-brands distinct: in "JPMORGAN CHASE BANK N A DEBIT" the tail token is
 * DEBIT, which is not a suffix, so nothing strips and the sub-brand survives.
 */
export const ISSUER_LEGAL_SUFFIXES: readonly (readonly string[])[] = [
  // Longest sequences first — the stripper takes the first match at the tail.
  ["SOCIEDAD", "ANONIMA", "DE", "CAPITAL", "VARIABLE"],
  ["INSTITUCION", "DE", "BANCA", "MULTIPLE"],
  ["PUBLIC", "LIMITED", "COMPANY"],
  ["LIMITED", "LIABILITY", "COMPANY"],
  ["NATIONAL", "ASSOCIATION"],
  ["S", "A", "DE", "C", "V"],
  ["SOCIEDAD", "ANONIMA"],
  ["S", "A"],
  ["N", "A"],
  ["C", "A"],
  ["PLC"],
  ["LTD"],
  ["LIMITED"],
  ["INC"],
  ["LLC"],
  ["CORP"],
  ["CORPORATION"],
  ["COMPANY"],
  ["GMBH"],
  ["AG"],
  ["NV"],
  ["BV"],
  ["SPA"],
  ["SAS"],
  ["SRL"],
  ["SFP"],
  ["PJSC"],
  ["JSC"],
  ["OJSC"],
  ["CJSC"],
  ["SE"],
  ["AB"],
  ["OY"],
  ["AS"],
  ["KFT"],
  ["ZRT"],
  ["DOO"],
  ["AD"],
  ["EAD"],
  ["TBK"],
  ["BHD"],
];

/**
 * If stripping would leave a single one of these tokens, the strip is refused.
 * Without this guard "BANCO S.A." would normalize to `banco` and swallow a
 * dozen unrelated Latin-American banks into one issuer.
 */
export const GENERIC_HEADS: ReadonlySet<string> = new Set([
  "BANK",
  "BANCO",
  "BANQUE",
  "BANCA",
  "THE",
  "CREDIT",
  "CAJA",
  "CARD",
]);

/**
 * Curated parent groups. Key = normalized issuer key, value = group slug.
 * Every issuer NOT listed here is its own group (group === key).
 *
 * Seeded from the live top of the volume distribution (issuers ≥100 attempts,
 * production measurement 2026-08-11). The map only names REAL parents — a bank
 * with one spelling and no sub-brands does not belong here.
 */
export const ISSUER_GROUPS: Record<string, string> = {
  // Bancolombia and its Nequi neobank product. Keys are what the tail-only
  // stripper actually produces: mid-name "S A" survives by design (stripping
  // mid-name sequences would be the start of fuzzy matching).
  bancolombia: "bancolombia",
  bancolombia_s_a_nequi: "bancolombia",
  // JPMorgan Chase and its product lines.
  jpmorgan_chase_bank: "jpmorgan_chase_bank",
  jpmorgan_chase_bank_n_a_debit: "jpmorgan_chase_bank",
  chase_bank_usa: "jpmorgan_chase_bank",
  // Bank of America.
  bank_of_america: "bank_of_america",
  // Wells Fargo.
  wells_fargo_bank: "wells_fargo_bank",
  // Citibank.
  citibank: "citibank",
  citibank_south_dakota: "citibank",
  // Capital One.
  capital_one: "capital_one",
  capital_one_bank_usa: "capital_one",
  // Santander's country entities stay separate issuers but share a group.
  // The Mexico key is the 64-char token-boundary truncation the normalizer
  // actually produces from the full legal name.
  banco_santander_mexico_sa_institucion_de_banca_multiple_grupo: "santander",
  banco_santander: "santander",
  santander_uk: "santander",
  // BBVA entities.
  bbva_mexico: "bbva",
  bbva_bancomer: "bbva",
  bbva_usa: "bbva",
};

/** Group slug → display label, only where the slug alone reads poorly. */
export const ISSUER_GROUP_LABELS: Record<string, string> = {
  bancolombia: "Bancolombia",
  jpmorgan_chase_bank: "JPMorgan Chase",
  bank_of_america: "Bank of America",
  wells_fargo_bank: "Wells Fargo",
  citibank: "Citibank",
  capital_one: "Capital One",
  santander: "Santander",
  bbva: "BBVA",
};
