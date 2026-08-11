// Card network (scheme) and payment method (wallet vs plain card) from the
// Primer payload.
//
// Network prefers paymentInstrumentBinDataNetwork over paymentInstrumentNetwork:
// the binData value is the scheme the BIN table says issued the card — which is
// what a bank analysis is about — while the other is what the processor routed
// on, and the two can differ for co-badged cards.
//
// paymentMethodFromTransaction reads the same paymentInstrumentType field that
// userPlatform.platformFromWallet reads, but the two must stay separate: there
// it is evidence of the user's DEVICE (Apple Pay → iOS), here it is the payment
// INSTRUMENT. A future edit to one must not be assumed to apply to the other.
import type { Transaction } from "./serviceTypes.ts";
import { valueAtPath } from "./userCardType.ts";

export type CardNetwork =
  | "visa" | "mastercard" | "amex" | "discover" | "maestro"
  | "diners_club" | "jcb" | "unionpay" | "other";
export const CARD_NETWORK_VALUES: CardNetwork[] = [
  "visa", "mastercard", "amex", "discover", "maestro", "diners_club", "jcb", "unionpay", "other",
];

export type PaymentMethod = "apple_pay" | "google_pay" | "card" | "other";
export const PAYMENT_METHOD_VALUES: PaymentMethod[] = ["apple_pay", "google_pay", "card", "other"];

// The ONLY payload paths these classifiers read (PCI-asserted by test).
export const CARD_NETWORK_FIELD_PATHS = [
  ["paymentInstrumentBinDataNetwork"],
  ["paymentInstrumentNetwork"],
] as const;
export const PAYMENT_METHOD_FIELD_PATHS = [["paymentInstrumentType"]] as const;

export function normalizeCardNetwork(value: unknown): CardNetwork {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "VISA") return "visa";
  if (normalized === "MASTERCARD") return "mastercard";
  if (normalized === "AMEX" || normalized === "AMERICAN_EXPRESS") return "amex";
  if (normalized === "DISCOVER") return "discover";
  if (normalized === "MAESTRO") return "maestro";
  if (normalized === "DINERS_CLUB" || normalized === "DINERS") return "diners_club";
  if (normalized === "JCB") return "jcb";
  if (normalized === "UNIONPAY" || normalized === "CHINA_UNION_PAY") return "unionpay";
  return "other";
}

export function normalizePaymentMethod(value: unknown): PaymentMethod {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "APPLE_PAY") return "apple_pay";
  if (normalized === "GOOGLE_PAY") return "google_pay";
  if (normalized === "PAYMENT_CARD" || normalized === "CARD") return "card";
  return "other";
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

/** Absent → null (not "other"), so a caller can tell "no data" from "present
 * but unrecognized" — the userCardType/userPlatform convention. */
export function cardNetworkFromTransaction(tx: Transaction): CardNetwork | null {
  const value = firstValueAt(tx, CARD_NETWORK_FIELD_PATHS);
  return value === undefined ? null : normalizeCardNetwork(value);
}

export function paymentMethodFromTransaction(tx: Transaction): PaymentMethod | null {
  const value = firstValueAt(tx, PAYMENT_METHOD_FIELD_PATHS);
  return value === undefined ? null : normalizePaymentMethod(value);
}

export function cardNetworkLabel(network: string): string {
  if (network === "visa") return "Visa";
  if (network === "mastercard") return "Mastercard";
  if (network === "amex") return "Amex";
  if (network === "discover") return "Discover";
  if (network === "maestro") return "Maestro";
  if (network === "diners_club") return "Diners Club";
  if (network === "jcb") return "JCB";
  if (network === "unionpay") return "UnionPay";
  if (network === "other") return "Other";
  return "Unknown";
}

export function paymentMethodLabel(method: string): string {
  if (method === "apple_pay") return "Apple Pay";
  if (method === "google_pay") return "Google Pay";
  if (method === "card") return "Card";
  if (method === "other") return "Other";
  return "Unknown";
}
