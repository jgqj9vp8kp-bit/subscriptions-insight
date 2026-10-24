// Number and date formatting for the Payback page: one definition of how a
// payback number renders, with "—" for a value the page cannot know (never a
// misleading zero). Copy (words) lives in paybackCopy.ts.
//
// Percentages are decision ratios: the tint, the verdict and "Too early" / "≈"
// compare the raw ratio with a threshold, so the printed number must never be
// rounded up onto a threshold the ratio is below (99.6 % is "99%", not "100%"
// next to "Not within 3 months").
import { PAYBACK_APPROX_BELOW, PAYBACK_ROAS_PAID_BACK, PAYBACK_ROAS_WARN_FROM, PAYBACK_TOO_EARLY_BELOW } from "@/services/ltvPayback";

export const DASH = "—";

/** ROAS thresholds: amber from 80 %, paid back from 100 %. */
export const PAYBACK_ROAS_MARKS: readonly number[] = Object.freeze([PAYBACK_ROAS_WARN_FROM, PAYBACK_ROAS_PAID_BACK]);
/** Observed-share thresholds: "Too early" below 50 %, "≈" below 95 %, fully observed at 100 %. */
export const PAYBACK_SHARE_MARKS: readonly number[] = Object.freeze([PAYBACK_TOO_EARLY_BELOW, PAYBACK_APPROX_BELOW, 1]);

const wholeDollars = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthYear = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** Spend and totals: whole dollars. */
export function fmtMoney(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? DASH : wholeDollars.format(value);
}

/** Per-trial values (cost per trial, revenue per trial): cents. */
export function fmtMoneyCents(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? DASH : cents.format(value);
}

export function fmtInt(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? DASH : integer.format(Math.round(value));
}

/** ratio × 100 rounded to `digits` decimals, never rounded up onto one of the
 * ascending `marks` the ratio is below (it then stops one step under it). */
export function thresholdSafePct(ratio: number, marks: readonly number[], digits = 0): number {
  const scale = 10 ** digits;
  let units = Math.round(ratio * 100 * scale);
  for (const mark of marks) {
    const at = Math.round(mark * 100 * scale);
    if (ratio < mark && units >= at) units = at - 1;
  }
  return units / scale;
}

function fmtRatio(value: number | null | undefined, marks: readonly number[]): string {
  return value == null || !Number.isFinite(value) ? DASH : `${integer.format(thresholdSafePct(value, marks))}%`;
}

/** ROAS ("% of cost back") as a whole percentage, threshold-safe at 80 % and 100 %. */
export function fmtRoas(value: number | null | undefined): string {
  return fmtRatio(value, PAYBACK_ROAS_MARKS);
}

/** An observed share as a whole percentage, threshold-safe at 50 %, 95 % and 100 %. */
export function fmtShare(value: number | null | undefined): string {
  return fmtRatio(value, PAYBACK_SHARE_MARKS);
}

/** "Oct 23, 2026" from YYYY-MM-DD or an ISO timestamp (UTC). */
export function fmtDay(value: string | null | undefined): string {
  if (!value) return DASH;
  const ms = Date.parse(value.length === 10 ? `${value}T00:00:00.000Z` : value);
  return Number.isFinite(ms) ? shortDate.format(new Date(ms)) : DASH;
}

/** "Jul 2026" from YYYY-MM-DD. */
export function fmtMonth(day: string): string {
  const ms = Date.parse(`${day.slice(0, 7)}-01T00:00:00.000Z`);
  return Number.isFinite(ms) ? monthYear.format(new Date(ms)) : day;
}

/** "≈ " in front of a partly projected value. */
export function approxPrefix(approx: boolean): string {
  return approx ? "≈ " : "";
}
