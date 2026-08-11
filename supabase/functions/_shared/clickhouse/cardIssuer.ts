// Card issuer (bank) identity from the Primer binData payload.
//
// The verdict is derived from the issuer NAME string alone. The BIN is never
// consulted and never stored: 390 of the 2,714 live BINs carry more than one
// issuer name, so a BIN is not an identity — and not touching it keeps the PCI
// surface flat (no column that could ever pair with a last-4 into a masked PAN).
//
// Normalization is deterministic and closed: an ordered token pipeline plus the
// data tables in cardIssuerGroups.ts. No fuzzy matching. A wrong merge is fixed
// by a data entry, never by loosening a rule. The rules run at INGESTION (the
// transaction mapper), so changing them requires a re-backfill — the price of
// having one value that every reader agrees on.
//
// Two kinds of "no issuer" exist and must never be merged: the provider
// literally answering "UNKNOWN" (key = "unknown") and the field being absent
// (classifier returns null, the mapper writes ''). The coverage block of the
// Banks tab reports them separately.
import type { Transaction } from "./serviceTypes.ts";
import { valueAtPath } from "./userCardType.ts";
import { GENERIC_HEADS, ISSUER_GROUP_LABELS, ISSUER_GROUPS, ISSUER_LEGAL_SUFFIXES } from "./cardIssuerGroups.ts";

export interface IssuerIdentity {
  /** Slug, /^[a-z0-9_]{1,64}$/, or "unknown" when the provider said UNKNOWN. */
  key: string;
  /** Display name, deterministically rebuilt from the tokens — never from data. */
  name: string;
  /** Parent group slug; equals key when the issuer has no curated parent. */
  group: string;
}

export const ISSUER_UNKNOWN_KEY = "unknown";
export const ISSUER_KEY_MAX = 64;

// The ONLY payload paths this module reads. A test asserts none of them ever
// names Last4 / First6 / Cardholder / Expiration / AnalyticsId — the PCI
// guarantee is a checked property, not a convention.
export const ISSUER_NAME_FIELD_PATHS = [["paymentInstrumentBinDataIssuerName"]] as const;
export const ISSUER_COUNTRY_FIELD_PATHS = [["paymentInstrumentBinDataIssuerCountryCode"]] as const;

/**
 * Steps 2–4 of the pipeline: fold, strip diacritics, uppercase, collapse
 * everything outside [A-Z0-9] into spaces, tokenize. Exported for tests.
 *
 * These steps alone resolve the live collisions: "THE BANCORP BANK NATIONAL
 * ASSOCIATION" with a double space and "BANK OF AMERICA, NATIONAL ASSOCIATION"
 * with a comma both come out as the same token array as their twins.
 */
export function normalizeIssuerTokens(value: unknown): string[] {
  const text = String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
  return text ? text.split(" ") : [];
}

function tailMatches(tokens: string[], suffix: readonly string[]): boolean {
  if (suffix.length > tokens.length) return false;
  const offset = tokens.length - suffix.length;
  for (let i = 0; i < suffix.length; i += 1) {
    if (tokens[offset + i] !== suffix[i]) return false;
  }
  return true;
}

/**
 * Strip legal suffixes from the tail, longest first, repeatedly.
 *
 * Tail-only, with two refusals that are both load-bearing: never leave an empty
 * name, and never leave a single generic token ("BANCO S.A." must NOT become
 * "banco" — that one slug would swallow unrelated banks). Sub-brands survive
 * because their distinguishing token sits at the tail where a suffix would be:
 * "... N A DEBIT" strips nothing, "... N A" strips down to the brand.
 */
export function stripLegalSuffixes(tokens: string[]): string[] {
  let current = tokens;
  for (;;) {
    const match = ISSUER_LEGAL_SUFFIXES.find((suffix) => tailMatches(current, suffix));
    if (!match) return current;
    const remainder = current.slice(0, current.length - match.length);
    if (remainder.length === 0) return current;
    if (remainder.length === 1 && GENERIC_HEADS.has(remainder[0])) return current;
    current = remainder;
  }
}

/** Small re-punctuation map applied when rebuilding the display name. */
const DISPLAY_REWRITES: Record<string, string> = {
  "N A": "N.A.",
  "S A": "S.A.",
  USA: "USA",
  DBA: "DBA",
};

function titleCaseToken(token: string): string {
  if (DISPLAY_REWRITES[token]) return DISPLAY_REWRITES[token];
  if (/^\d+$/.test(token)) return token;
  return token.charAt(0) + token.slice(1).toLowerCase();
}

/**
 * Display name from the FINAL tokens — never from the raw data. Picking "the
 * most common raw spelling" would make the name drift as data arrives and make
 * backfills non-idempotent.
 */
function displayNameFromTokens(tokens: string[]): string {
  return tokens.map(titleCaseToken).join(" ");
}

function keyFromTokens(tokens: string[]): string {
  let key = tokens.join("_").toLowerCase();
  if (key.length > ISSUER_KEY_MAX) {
    // Truncate at a token boundary so two long names cannot collide on a
    // mid-token cut.
    const parts = key.split("_");
    key = "";
    for (const part of parts) {
      const next = key ? `${key}_${part}` : part;
      if (next.length > ISSUER_KEY_MAX) break;
      key = next;
    }
  }
  return key;
}

/**
 * Raw provider string → identity, or null when nothing usable is present.
 *
 * null (absent) and { key: "unknown" } (the provider literally said UNKNOWN)
 * are different answers on purpose — see the module header.
 */
export function issuerIdentityFromName(value: unknown): IssuerIdentity | null {
  const tokens = normalizeIssuerTokens(value);
  if (tokens.length === 0) return null;
  if (tokens.length === 1 && tokens[0] === "UNKNOWN") {
    return { key: ISSUER_UNKNOWN_KEY, name: "Reported as UNKNOWN", group: ISSUER_UNKNOWN_KEY };
  }
  const stripped = stripLegalSuffixes(tokens);
  const key = keyFromTokens(stripped);
  if (!key) return null;
  return {
    key,
    name: displayNameFromTokens(stripped),
    group: ISSUER_GROUPS[key] ?? key,
  };
}

function firstValueAt(tx: Transaction, paths: readonly (readonly string[])[]): unknown {
  for (const source of [tx, tx.metadata, tx.raw, tx.raw?.metadata]) {
    if (!source) continue;
    for (const path of paths) {
      const value = valueAtPath(source, path);
      if (value != null && String(value).trim() !== "") return value;
    }
  }
  return undefined;
}

export function issuerIdentityFromTransaction(tx: Transaction): IssuerIdentity | null {
  const value = firstValueAt(tx, ISSUER_NAME_FIELD_PATHS);
  return value === undefined ? null : issuerIdentityFromName(value);
}

export function issuerCountryFromTransaction(tx: Transaction): string | null {
  const value = firstValueAt(tx, ISSUER_COUNTRY_FIELD_PATHS);
  if (value === undefined) return null;
  const code = String(value).trim().toUpperCase();
  return /^[A-Z]{2,3}$/.test(code) ? code : null;
}

export function issuerLabel(key: string, name?: string): string {
  if (!key) return "Not reported";
  if (key === ISSUER_UNKNOWN_KEY) return "Reported as UNKNOWN";
  return name || key;
}

export function issuerGroupLabel(group: string): string {
  if (!group) return "Not reported";
  if (group === ISSUER_UNKNOWN_KEY) return "Reported as UNKNOWN";
  return ISSUER_GROUP_LABELS[group] ?? group;
}
