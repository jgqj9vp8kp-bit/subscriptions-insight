// Single source of truth for monetization product mapping.
//
// Audited reality (July 2026 warehouse audit): Palmer payment rows carry NO
// product_id / product_name — the only reliable signals are
// ff_billing_reason, amount, currency and timing. When the payment provider
// starts sending real product identifiers, add them HERE — analytics.ts and
// the classifier read only this config and never hardcode products.

export interface KnownTokenAmount {
  amount: number;
  /** ISO currency the amount is quoted in. Omit to match any currency. */
  currency?: string;
}

/** Product ids that are funnel upsells (empty until Palmer sends ids). */
export const knownUpsellProductIds: readonly string[] = [];

/** Product ids that are web-app token/minute packs (empty until Palmer sends ids). */
export const knownTokenProductIds: readonly string[] = [];

/** Product-name patterns marking a funnel upsell. */
export const knownUpsellProductNamePatterns: readonly RegExp[] = [/upsell/i];

/** Product-name patterns marking a token/minute pack. */
export const knownTokenProductNamePatterns: readonly RegExp[] = [
  /\b(tokens?|minutes?|coins?|credits?)\b/i,
];

// Audit 2026-07: in-app token packs observed as unmarked (no ff_billing_reason)
// charges minutes after the trial. Extend when new pack prices appear (see the
// "Unknown monetization products" diagnostics).
export const knownTokenAmounts: readonly KnownTokenAmount[] = [
  { amount: 4.99, currency: "USD" },
  { amount: 9.99, currency: "USD" },
  { amount: 24.99, currency: "USD" },
  { amount: 4.99, currency: "EUR" },
  { amount: 17199, currency: "COP" },
];

/**
 * A successful unmarked payment this close to the trial cannot be a
 * subscription charge, so the classifier treats it as an in-app (token)
 * purchase even when the price is not in the config yet; unmapped prices are
 * additionally reported in the unknown-products diagnostics.
 *
 * Boundary comes from the billing audit: subscription auto-charges fire at
 * N days − 2h after trial (observed exactly at 70h / 118h / 166h for the
 * 3/5/7-day trials), while real in-app purchases land within the first hour.
 * 48h stays safely below the earliest 70h billing horizon.
 */
export const APP_ADDON_WINDOW_HOURS = 48;

const AMOUNT_TOLERANCE = 0.005;

export function isKnownTokenAmount(amount: number, currency: string | null | undefined): boolean {
  const normalizedCurrency = String(currency ?? "").trim().toUpperCase();
  return knownTokenAmounts.some(
    (rule) =>
      Math.abs(rule.amount - amount) < AMOUNT_TOLERANCE &&
      (!rule.currency || rule.currency.toUpperCase() === normalizedCurrency || !normalizedCurrency),
  );
}

export function matchesKnownTokenProduct(productId: string | null, productName: string | null): boolean {
  if (productId && knownTokenProductIds.includes(productId)) return true;
  if (productName && knownTokenProductNamePatterns.some((pattern) => pattern.test(productName))) return true;
  return false;
}

export function matchesKnownUpsellProduct(productId: string | null, productName: string | null): boolean {
  if (productId && knownUpsellProductIds.includes(productId)) return true;
  if (productName && knownUpsellProductNamePatterns.some((pattern) => pattern.test(productName))) return true;
  return false;
}
