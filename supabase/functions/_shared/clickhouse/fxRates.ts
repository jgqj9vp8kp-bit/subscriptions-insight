// Static MVP FX config — the ONLY place FX rates live. analytics.ts and the
// UI must never hardcode a rate; they go through currencyNormalization.ts.
//
// TODO: replace with a daily FX rates table / API feed (rates below are
// approximate mid-market rates as of FX_RATES_AS_OF and will drift, ARS
// especially).

/** 1 unit of currency = N USD. */
export const FX_RATES_TO_USD: Record<string, number> = {
  USD: 1,
  EUR: 1.15,
  MXN: 0.054,
  COP: 0.00025,
  PEN: 0.28,
  UYU: 0.024,
  ARS: 0.0008,
  // Seen in the warehouse since 2026-06-17 (not in the localization brief).
  JPY: 0.0066,
};

export const FX_RATES_AS_OF = "2026-07-01";
export const FX_SOURCE = "static-config";

/** ISO 4217 exponent-0 currencies: the amount's smallest unit IS the major
 * unit, so a processor's integer amount must NOT be divided by 100. The set is
 * the standard processor list (Stripe/Adyen); only JPY appears in the
 * warehouse today, but the rule is currency-driven so KRW/CLP/VND imports
 * would land correctly the day they show up. Found live: Palmer sent
 * amount "6415" JPY (= ¥6,415 ≈ $42) and the importer stored 64.15 —
 * every yen amount was 100× too small. */
export const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

/** How many minor units one major unit holds for import-time normalization. */
export function currencyMinorUnitFactor(currency: string | null | undefined): number {
  const normalized = String(currency ?? "").trim().toUpperCase();
  return ZERO_DECIMAL_CURRENCIES.has(normalized) ? 1 : 100;
}

export function fxRateToUsd(currency: string | null | undefined): number | null {
  const normalized = String(currency ?? "").trim().toUpperCase();
  if (!normalized) return null;
  return FX_RATES_TO_USD[normalized] ?? null;
}

export const SUPPORTED_CURRENCIES = Object.keys(FX_RATES_TO_USD);
