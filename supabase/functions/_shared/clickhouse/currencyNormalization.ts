import type { Transaction } from "./serviceTypes.ts";
import { FX_RATES_AS_OF, FX_SOURCE, fxRateToUsd } from "./fxRates.ts";

// USD normalization for revenue analytics.
//
// Warehouse audit (July 2026): the `amount_usd` / `gross_amount_usd` fields on
// Transaction hold the amount in the CHARGE currency (the field name predates
// localized funnels), and `currency` is populated on 100% of rows. So an
// amount is only "reliably USD" when currency === USD; everything else must be
// converted, and anything unconvertible is EXCLUDED from USD metrics (never
// silently mixed in) and reported in the FX diagnostics.

export type ConversionStatus =
  | "native_usd"
  | "converted"
  | "missing_currency"
  | "missing_fx_rate"
  | "invalid_amount";

export interface CurrencyConversion {
  original_amount: number;
  original_currency: string | null;
  amount_usd: number | null;
  fx_rate: number | null;
  fx_source: string;
  fx_date: string;
  conversion_status: ConversionStatus;
}

export function convertAmountToUsd(amount: unknown, currency: string | null | undefined): CurrencyConversion {
  const normalizedCurrency = String(currency ?? "").trim().toUpperCase() || null;
  const base: Omit<CurrencyConversion, "amount_usd" | "fx_rate" | "conversion_status"> = {
    original_amount: typeof amount === "number" ? amount : Number(amount ?? Number.NaN),
    original_currency: normalizedCurrency,
    fx_source: FX_SOURCE,
    fx_date: FX_RATES_AS_OF,
  };

  if (typeof base.original_amount !== "number" || !Number.isFinite(base.original_amount)) {
    return { ...base, original_amount: 0, amount_usd: null, fx_rate: null, conversion_status: "invalid_amount" };
  }
  if (!normalizedCurrency) {
    return { ...base, amount_usd: null, fx_rate: null, conversion_status: "missing_currency" };
  }
  if (normalizedCurrency === "USD") {
    return { ...base, amount_usd: base.original_amount, fx_rate: 1, conversion_status: "native_usd" };
  }
  const rate = fxRateToUsd(normalizedCurrency);
  if (rate == null) {
    return { ...base, amount_usd: null, fx_rate: null, conversion_status: "missing_fx_rate" };
  }
  return {
    ...base,
    amount_usd: Math.round(base.original_amount * rate * 100) / 100,
    fx_rate: rate,
    conversion_status: "converted",
  };
}

export interface FxNormalizationDiagnostics {
  transactions_total: number;
  transactions_with_currency: number;
  transactions_without_currency: number;
  transactions_native_usd: number;
  transactions_converted: number;
  transactions_missing_fx_rate: number;
  transactions_invalid_amount: number;
  /** Successful-transaction gross (original currency units) excluded from USD metrics. */
  excluded_amount_original: number;
  excluded_transactions: number;
}

export function createFxDiagnostics(): FxNormalizationDiagnostics {
  return {
    transactions_total: 0,
    transactions_with_currency: 0,
    transactions_without_currency: 0,
    transactions_native_usd: 0,
    transactions_converted: 0,
    transactions_missing_fx_rate: 0,
    transactions_invalid_amount: 0,
    excluded_amount_original: 0,
    excluded_transactions: 0,
  };
}

export interface FxNormalizationResult {
  transactions: Transaction[];
  diagnostics: FxNormalizationDiagnostics;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Convert every money field of the transactions to USD, keeping the original
 * amount/currency on the row (`original_gross_amount`, `original_currency`,
 * `fx_rate`, `fx_status`). Unconvertible rows keep status/type/counts but
 * their money fields become 0 so USD metrics exclude them; the excluded gross
 * is reported in diagnostics. Idempotent: already-normalized rows pass through.
 */
export function normalizeTransactionsToUsd(txs: Transaction[]): FxNormalizationResult {
  const diagnostics = createFxDiagnostics();
  const transactions = txs.map((tx) => {
    if (tx.fx_status) {
      // Already normalized by an earlier pass — count it, don't convert twice.
      trackDiagnostics(diagnostics, tx.fx_status, tx.original_gross_amount ?? 0, tx.status === "success");
      return tx;
    }
    const gross = tx.gross_amount_usd ?? tx.amount_usd;
    const conversion = convertAmountToUsd(gross, tx.currency);
    trackDiagnostics(diagnostics, conversion.conversion_status, gross, tx.status === "success");

    if (conversion.conversion_status === "native_usd") {
      return { ...tx, fx_status: "native_usd" as const, fx_rate: 1, original_currency: "USD", original_gross_amount: gross };
    }
    const rate = conversion.fx_rate;
    const convert = (value: number | undefined) =>
      value == null ? value : rate == null ? 0 : round2(value * rate);
    return {
      ...tx,
      amount_usd: convert(tx.amount_usd) ?? 0,
      gross_amount_usd: convert(tx.gross_amount_usd),
      refund_amount_usd: convert(tx.refund_amount_usd),
      net_amount_usd: convert(tx.net_amount_usd),
      fx_status: conversion.conversion_status,
      fx_rate: rate,
      original_currency: conversion.original_currency,
      original_gross_amount: gross,
    };
  });
  diagnostics.excluded_amount_original = round2(diagnostics.excluded_amount_original);
  return { transactions, diagnostics };
}

function trackDiagnostics(
  diagnostics: FxNormalizationDiagnostics,
  status: ConversionStatus,
  gross: number,
  isSuccess: boolean,
): void {
  diagnostics.transactions_total += 1;
  if (status === "missing_currency") diagnostics.transactions_without_currency += 1;
  else diagnostics.transactions_with_currency += 1;
  if (status === "native_usd") diagnostics.transactions_native_usd += 1;
  if (status === "converted") diagnostics.transactions_converted += 1;
  if (status === "missing_fx_rate") diagnostics.transactions_missing_fx_rate += 1;
  if (status === "invalid_amount") diagnostics.transactions_invalid_amount += 1;
  if (status === "missing_currency" || status === "missing_fx_rate" || status === "invalid_amount") {
    diagnostics.excluded_transactions += 1;
    if (isSuccess && Number.isFinite(gross)) diagnostics.excluded_amount_original += gross;
  }
}
