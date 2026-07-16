import type { CardType, Transaction } from "./serviceTypes.ts";

export const CARD_TYPE_VALUES: CardType[] = ["prepaid", "debit", "credit", "other", "unknown"];

export const CARD_TYPE_FIELD_PATHS = [
  ["paymentInstrumentBinDataAccountFundingType"],
  ["card_type"],
  ["card", "type"],
  ["payment_method", "card_type"],
  ["payment_method", "card", "type"],
  ["payment_method_details", "card", "funding"],
  ["funding"],
  ["card_funding"],
  ["issuer_card_type"],
  ["bin", "card_type"],
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueAtPath(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    const object = current as Record<string, unknown>;
    if (segment in object) {
      current = object[segment];
      continue;
    }

    const normalizedSegment = normalizeKey(segment);
    const matchingKey = Object.keys(object).find((key) => normalizeKey(key) === normalizedSegment);
    if (!matchingKey) return undefined;
    current = object[matchingKey];
  }
  return current;
}

export function normalizeCardType(value: unknown): CardType {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!normalized) return "unknown";
  if (normalized.includes("prepaid")) return "prepaid";
  if (normalized.includes("debit")) return "debit";
  if (normalized.includes("credit")) return "credit";
  return "other";
}

export function cardTypeFromSource(source: unknown): CardType | null {
  for (const path of CARD_TYPE_FIELD_PATHS) {
    const value = valueAtPath(source, path);
    if (value == null || String(value).trim() === "") continue;
    return normalizeCardType(value);
  }
  return null;
}

export function cardTypeFromTransaction(tx: Transaction): CardType | null {
  return (
    cardTypeFromSource(tx) ??
    cardTypeFromSource(tx.metadata) ??
    cardTypeFromSource(tx.raw) ??
    cardTypeFromSource(tx.raw?.metadata) ??
    null
  );
}

export function cardTypeForUserTransactions(txs: Transaction[]): CardType {
  const sorted = [...txs].sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));
  const firstSuccessful = sorted.find((tx) => tx.status === "success" && cardTypeFromTransaction(tx));
  if (firstSuccessful) return cardTypeFromTransaction(firstSuccessful) ?? "unknown";

  const firstAvailable = sorted.find((tx) => cardTypeFromTransaction(tx));
  return firstAvailable ? cardTypeFromTransaction(firstAvailable) ?? "unknown" : "unknown";
}

export function cardTypeLabel(cardType: CardType): string {
  if (cardType === "prepaid") return "Prepaid";
  if (cardType === "debit") return "Debit";
  if (cardType === "credit") return "Credit";
  if (cardType === "other") return "Other";
  return "Unknown";
}
