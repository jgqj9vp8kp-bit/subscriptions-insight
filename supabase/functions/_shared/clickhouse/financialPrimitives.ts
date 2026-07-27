// Shared low-level financial primitives (Forecasting redesign v3, phase P6).
//
// Extracted from the two forecast engines (paybackForecast = Actuals,
// funnelEconomicsEngine = Planning) so both use one definition. Behavior is
// verbatim-identical to the previous per-module copies — the extraction is gated
// on the full regression suite (incl. paybackForecast.test.ts) staying green.
// NOTE: many other modules still carry local `round2` copies; they migrate in a
// separate mechanical cleanup, not here.

/** Half-even cents rounding used across analytics: Math.round(n·100)/100. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Clamp a rate into [0, 1]; non-finite values collapse to 0 (defensive UI input). */
export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(n) ? n : 0));
}

/** Index of the first element of a cumulative series that reaches `threshold`
 * (payback-crossing detection). Returns null when the series never crosses. */
export function firstCrossingIndex(cumulative: readonly number[], threshold: number): number | null {
  for (let index = 0; index < cumulative.length; index += 1) {
    if (cumulative[index] >= threshold) return index;
  }
  return null;
}
