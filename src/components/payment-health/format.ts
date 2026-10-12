// Pure formatting for the Payment System Health page (plan sections G, O, P).
//
// Why a module of its own: every tab shows the same three kinds of numbers —
// counts, rates with a sample flag, and period comparisons — and the rules
// are easy to get subtly wrong in JSX: a rate whose denominator is 0 is "no
// data", never 0% (plan O); a comparison is "significant" only when the server
// says so (Wilson intervals + min sample + mature period), never from the size
// of the delta alone. Tests pin these rules here once.

import type { PeriodComparison, RateEstimate, SignificanceReason } from "../../../supabase/functions/_shared/clickhouse/paymentHealthMetrics";

export const NO_DATA = "no data";

/** 0.1234 → "12.3%"; null → "no data" (a rate without a denominator). */
export function fmtPct(rate: number | null | undefined, digits = 1): string {
  if (rate == null || !Number.isFinite(rate)) return NO_DATA;
  return `${(rate * 100).toFixed(digits)}%`;
}

/** A share already in [0, 1] shown with no decimals when it is whole. */
export function fmtShare(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return NO_DATA;
  const points = rate * 100;
  return `${Number.isInteger(points) ? points : points.toFixed(1)}%`;
}

export function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString("en-US");
}

export function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

/** Percentage-point delta: +1.2 pp / −0.8 pp / "—" without both periods. */
export function fmtPoints(delta: number | null | undefined, digits = 1): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return `${sign}${Math.abs(delta).toFixed(digits)} pp`;
}

/** Count delta: +12 / −3 / ±0. */
export function fmtCountDelta(delta: number | null | undefined): string {
  if (delta == null || !Number.isFinite(delta)) return "—";
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
  return `${sign}${Math.round(Math.abs(delta)).toLocaleString("en-US")}`;
}

/** numerator / denominator, or null without a denominator (never 0). */
export function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** An ISO timestamp as "YYYY-MM-DD HH:MM UTC"; a bare day stays a day. */
export function fmtDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return `${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)} UTC`;
}

export function fmtDay(value: string | null | undefined): string {
  if (!value) return "—";
  return value.length >= 10 ? value.slice(0, 10) : value;
}

/** "YYYY-MM-01" → "2026-09". */
export function fmtMonth(value: string): string {
  return value.length >= 7 ? value.slice(0, 7) : value;
}

/** An opaque instrument / account hash shortened for a table cell. */
export function shortHash(value: string | null | undefined, keep = 10): string {
  if (!value) return "—";
  return value.length > keep ? `${value.slice(0, keep)}…` : value;
}

export function titleCase(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

// ---- comparisons ------------------------------------------------------------

export type ComparisonTone = "good" | "bad" | "neutral";

export interface ComparisonSummary {
  /** The current rate text ("12.3%" or "no data"). */
  current: string;
  baseline: string;
  delta: string;
  direction: PeriodComparison["direction"];
  /** Which way the arrow is good for this metric (approval up = good, refunds up = bad). */
  tone: ComparisonTone;
  significant: boolean;
  smallSample: boolean;
  immature: boolean;
  /** Short badge texts in display order. */
  flags: string[];
  reason: string;
}

export const SIGNIFICANCE_LABELS: Readonly<Record<SignificanceReason, string>> = {
  intervals_do_not_overlap: "significant change (95% intervals do not overlap)",
  intervals_overlap: "not significant (95% intervals overlap)",
  small_sample: "small sample: fewer observations than the minimum",
  immature_period: "incomplete period: the current window is still receiving data (import lag, or refunds / complaints still maturing)",
  no_data: "no data in one of the periods",
};

/** What a table cell or KPI shows for one PeriodComparison. */
export function summarizeComparison(comparison: PeriodComparison | null | undefined, options: { higherIsBetter: boolean; digits?: number }): ComparisonSummary {
  if (!comparison) {
    return { current: NO_DATA, baseline: NO_DATA, delta: "—", direction: "unknown", tone: "neutral", significant: false, smallSample: false, immature: false, flags: [], reason: SIGNIFICANCE_LABELS.no_data };
  }
  const digits = options.digits ?? 1;
  const smallSample = comparison.current.small_sample || comparison.baseline.small_sample;
  let tone: ComparisonTone = "neutral";
  if (comparison.direction === "up") tone = options.higherIsBetter ? "good" : "bad";
  else if (comparison.direction === "down") tone = options.higherIsBetter ? "bad" : "good";
  const flags: string[] = [];
  if (comparison.significant) flags.push("significant");
  if (smallSample && comparison.current.rate != null) flags.push("small sample");
  if (comparison.immature_period) flags.push("incomplete period");
  return {
    current: fmtPct(comparison.current.rate, digits),
    baseline: fmtPct(comparison.baseline.rate, digits),
    delta: fmtPoints(comparison.delta_points, digits),
    direction: comparison.direction,
    tone,
    significant: comparison.significant,
    smallSample,
    immature: comparison.immature_period,
    flags,
    reason: SIGNIFICANCE_LABELS[comparison.significance_reason] ?? comparison.significance_reason,
  };
}

/** A RateEstimate as text plus its sample flag. */
export function summarizeRate(estimate: RateEstimate | null | undefined, digits = 1): { text: string; smallSample: boolean; interval: string | null; sample: string } {
  if (!estimate) return { text: NO_DATA, smallSample: false, interval: null, sample: "" };
  const interval = estimate.interval ? `${fmtPct(estimate.interval.low, digits)} – ${fmtPct(estimate.interval.high, digits)}` : null;
  return {
    text: fmtPct(estimate.rate, digits),
    smallSample: estimate.small_sample && estimate.rate != null,
    interval,
    sample: `${fmtNum(estimate.numerator)} / ${fmtNum(estimate.denominator)}`,
  };
}

/** Today's UTC day (the server also works in UTC days). */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** YYYY-MM-DD shifted by whole days (UTC arithmetic, no local-time drift). */
export function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
