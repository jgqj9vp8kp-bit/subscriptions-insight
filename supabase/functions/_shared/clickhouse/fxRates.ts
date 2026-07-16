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

export function fxRateToUsd(currency: string | null | undefined): number | null {
  const normalized = String(currency ?? "").trim().toUpperCase();
  if (!normalized) return null;
  return FX_RATES_TO_USD[normalized] ?? null;
}

export const SUPPORTED_CURRENCIES = Object.keys(FX_RATES_TO_USD);
