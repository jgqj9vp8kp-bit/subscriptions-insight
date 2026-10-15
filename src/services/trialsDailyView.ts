// Row model of the Dashboard "Daily trials" card (pure). The server answers
// one trials_daily response per range / filter; everything here is display:
// the top rows by the sorted column with the long tail folded into "Other"
// until expanded, "Unknown" pinned last (a population, never ranked or
// folded), the change badge against the previous equal-length window, the heat
// steps, the on-screen week fold for narrow layouts and the CSV table. The
// rows on screen always add up to the response totals.
//
// The on-screen week fold follows the server's week rule (complete only when
// every day is, no_data only when no day has data, else partial), and a short
// edge week is shaded by its per-day rate, never by its smaller sum.
import { formatCell, type SupportExportTable } from "@/services/supportExport";
import type { RevenueTrialsRow, TrialsBucket, TrialsBucketState } from "@/services/revenueIntelligence";

export const TRIALS_TOP_N = 8;
export const TRIALS_UNKNOWN_KEY = "Unknown";
export const TRIALS_OTHER_KEY = "Other";

const DAY_MS = 86_400_000;

export function bucketDays(bucket: TrialsBucket): number {
  return bucket === "week" ? 7 : 1;
}

export function addTrialsDays(day: string, days: number): string {
  const dateObj = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(dateObj.getTime())) return day;
  dateObj.setUTCDate(dateObj.getUTCDate() + days);
  return dateObj.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function trialsDaysBetween(from: string, to: string): number {
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(days) ? days : 0;
}

/** Inclusive number of days in from..to (the response's effective window). */
export function trialsSpanDays(dateFrom: string, dateTo: string): number {
  const span = Math.round((Date.parse(`${dateTo}T00:00:00Z`) - Date.parse(`${dateFrom}T00:00:00Z`)) / DAY_MS) + 1;
  return Number.isFinite(span) && span > 0 ? span : 0;
}

// ---- change badge -------------------------------------------------------------

export type TrialsDeltaKind = "pct" | "new" | "stopped" | "none";

export interface TrialsDelta {
  kind: TrialsDeltaKind;
  /** actual / expected − 1 (kind "pct"; −1 for "stopped"); null otherwise. */
  pct: number | null;
  /** Trials of the complete buckets. */
  actual: number;
  /** The previous window's daily rate × the complete days. */
  expected: number;
  /** (actual − expected) / √max(expected, 1); null when nothing is compared. */
  z: number | null;
  /** |z| ≥ 2 and |actual − expected| ≥ 3: only then is the badge coloured. */
  significant: boolean;
  completeDays: number;
}

/** Δ over COMPLETE buckets only, so a partial today never shows as a fake drop. */
export function trialsDelta(
  row: Pick<RevenueTrialsRow, "cells" | "prev_trials">,
  axisState: readonly TrialsBucketState[],
  bucket: TrialsBucket,
  spanDays: number,
): TrialsDelta {
  let completeDays = 0;
  let actual = 0;
  axisState.forEach((state, index) => {
    if (state !== "complete") return;
    completeDays += bucketDays(bucket);
    actual += row.cells[index] ?? 0;
  });
  const expected = spanDays > 0 ? (row.prev_trials / spanDays) * completeDays : 0;
  const base = { actual, expected, completeDays };
  if (completeDays === 0) return { ...base, kind: "none", pct: null, z: null, significant: false };
  if (row.prev_trials === 0) return { ...base, kind: actual > 0 ? "new" : "none", pct: null, z: null, significant: false };
  const z = (actual - expected) / Math.sqrt(Math.max(expected, 1));
  if (actual === 0 && expected >= 3) return { ...base, kind: "stopped", pct: -1, z, significant: true };
  return { ...base, kind: "pct", pct: actual / expected - 1, z, significant: Math.abs(z) >= 2 && Math.abs(actual - expected) >= 3 };
}

// ---- matrix rows --------------------------------------------------------------

export type TrialsSortKey = "key" | "trials" | "delta";
export type TrialsSort = { key: TrialsSortKey; dir: "asc" | "desc" };

export type TrialsMatrixRow = RevenueTrialsRow & { delta: TrialsDelta };
export type TrialsOtherRow = TrialsMatrixRow & { count: number };

export interface TrialsMatrixView {
  /** Rows shown as their own rows, in sort order. */
  visible: TrialsMatrixRow[];
  /** The folded long tail (null when nothing is folded). */
  other: TrialsOtherRow | null;
  /** "Unknown", always last, never folded. */
  pinned: TrialsMatrixRow[];
  /** Ranked (non-pinned) rows in the response. */
  count: number;
}

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Δ order: stopped counts as −100 %; "new" and "—" go last in either direction. */
function deltaRank(delta: TrialsDelta): number | null {
  if (delta.kind === "pct") return delta.pct;
  if (delta.kind === "stopped") return -1;
  return null;
}

export function buildTrialsMatrixView(
  rows: readonly RevenueTrialsRow[],
  axisState: readonly TrialsBucketState[],
  bucket: TrialsBucket,
  spanDays: number,
  sort: TrialsSort,
  expanded: boolean,
  topN = TRIALS_TOP_N,
): TrialsMatrixView {
  const withDelta = (row: RevenueTrialsRow): TrialsMatrixRow => ({ ...row, delta: trialsDelta(row, axisState, bucket, spanDays) });
  const direction = sort.dir === "asc" ? 1 : -1;
  const ranked = rows
    .filter((row) => row.key !== TRIALS_UNKNOWN_KEY)
    .map(withDelta)
    .sort((a, b) => {
      if (sort.key === "key") return byKey(a.key, b.key) * direction;
      if (sort.key === "trials") return (a.trials - b.trials) * direction || byKey(a.key, b.key);
      const ra = deltaRank(a.delta);
      const rb = deltaRank(b.delta);
      if (ra === null || rb === null) return ra === rb ? byKey(a.key, b.key) : ra === null ? 1 : -1;
      return (ra - rb) * direction || byKey(a.key, b.key);
    });
  const pinned = rows.filter((row) => row.key === TRIALS_UNKNOWN_KEY).map(withDelta);
  // Folding a single row into "Other · 1" saves nothing — show it.
  const fold = !expanded && ranked.length > topN + 1;
  const visible = fold ? ranked.slice(0, topN) : ranked;
  const tail = fold ? ranked.slice(topN) : [];
  let other: TrialsOtherRow | null = null;
  if (tail.length) {
    const cells = tail[0].cells.map(() => 0);
    let trials = 0;
    let prevTrials = 0;
    for (const row of tail) {
      row.cells.forEach((value, index) => { cells[index] = (cells[index] ?? 0) + value; });
      trials += row.trials;
      prevTrials += row.prev_trials;
    }
    const folded = { key: TRIALS_OTHER_KEY, trials, prev_trials: prevTrials, cells, mix: [], mix_unknown: 0 };
    other = { ...folded, delta: trialsDelta(folded, axisState, bucket, spanDays), count: tail.length };
  }
  return { visible, other, pinned, count: ranked.length };
}

/** Largest cell of a row over its complete and partial buckets (the heat scale). */
export function trialsRowMax(cells: readonly number[], axisState: readonly TrialsBucketState[]): number {
  let max = 0;
  cells.forEach((value, index) => {
    if (axisState[index] !== "no_data" && value > max) max = value;
  });
  return max;
}

/** 0 for an empty cell, else 1..5 relative to the row's busiest bucket. */
export function heatStep(value: number, rowMax: number): number {
  if (!(value > 0) || !(rowMax > 0)) return 0;
  return Math.min(5, Math.max(1, Math.ceil((value / rowMax) * 5)));
}

// ---- on-screen week fold --------------------------------------------------------

export interface TrialsFoldedAxis {
  /** First day of each folded column (within the window). */
  axis: string[];
  /** Last day of each folded column (within the window). */
  ends: string[];
  axisState: TrialsBucketState[];
  /** Original axis indices per folded column. */
  groups: number[][];
  /** Days with data (not no_data) per folded column, at least 1: the heat and
   * bar scale divide by it, so a short edge week is not drawn as a drop. */
  dataDays: number[];
  series: number[][];
}

/** A folded week's state, by the server's week rule: no_data only when no day
 * has data yet, complete only when every day is complete, else partial. */
function foldedState(states: readonly TrialsBucketState[]): TrialsBucketState {
  if (states.every((state) => state === "no_data")) return "no_data";
  if (states.every((state) => state === "complete")) return "complete";
  return "partial";
}

/** Monday of the ISO week containing `day`. */
function isoWeekStart(day: string): string {
  const dateObj = new Date(`${day}T00:00:00Z`);
  dateObj.setUTCDate(dateObj.getUTCDate() - ((dateObj.getUTCDay() + 6) % 7));
  return dateObj.toISOString().slice(0, 10);
}

/** Folds a day axis into ISO weeks for display only (states: foldedState).
 * Each series is summed per week. */
export function foldAxisToWeeks(
  axis: readonly string[],
  axisState: readonly TrialsBucketState[],
  series: ReadonlyArray<readonly number[]>,
): TrialsFoldedAxis {
  const groups: number[][] = [];
  let current = "";
  axis.forEach((day, index) => {
    const week = isoWeekStart(day);
    if (week !== current || !groups.length) {
      groups.push([]);
      current = week;
    }
    groups[groups.length - 1].push(index);
  });
  const stateOf = (index: number): TrialsBucketState => axisState[index] ?? "complete";
  return {
    axis: groups.map((group) => axis[group[0]]),
    ends: groups.map((group) => axis[group[group.length - 1]]),
    axisState: groups.map((group) => foldedState(group.map(stateOf))),
    groups,
    dataDays: groups.map((group) => Math.max(1, group.filter((index) => stateOf(index) !== "no_data").length)),
    series: series.map((values) => groups.map((group) => group.reduce((sum, index) => sum + (values[index] ?? 0), 0))),
  };
}

// ---- pinned day, CSV ------------------------------------------------------------

/** The rows with the most trials in one axis column (all unfolded rows). */
export function trialsDayLeaders(rows: readonly RevenueTrialsRow[], indices: readonly number[], limit = 3): Array<{ key: string; trials: number }> {
  return rows
    .map((row) => ({ key: row.key, trials: indices.reduce((sum, index) => sum + (row.cells[index] ?? 0), 0) }))
    .filter((entry) => entry.trials > 0)
    .sort((a, b) => b.trials - a.trials || byKey(a.key, b.key))
    .slice(0, limit);
}

function deltaCsv(delta: TrialsDelta): string | number {
  if (delta.kind === "pct" && delta.pct !== null) return Math.round(delta.pct * 100);
  if (delta.kind === "new") return "new";
  if (delta.kind === "stopped") return "stopped";
  return "";
}

/** The unfolded current view as a table: Key, one column per axis bucket, Total, Previous, Δ %. */
export function trialsMatrixCsv(rows: readonly TrialsMatrixRow[], axis: readonly string[]): SupportExportTable {
  return {
    headers: ["Key", ...axis, "Total", "Previous", "Δ %"],
    rows: rows.map((row) => [row.key, ...row.cells, row.trials, row.prev_trials, deltaCsv(row.delta)].map(formatCell)),
    truncatedCells: 0,
  };
}

// ---- formatting -----------------------------------------------------------------

/** Whole numbers; "1.2k" from 1000 up (cells are narrow). */
export function formatTrialsCell(value: number): string {
  if (value >= 1000) return `${(Math.round(value / 100) / 10).toLocaleString("en-US")}k`;
  return String(Math.round(value));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 5" — the card never shows a raw YYYY-MM-DD. */
export function formatTrialsDay(day: string): string {
  const month = Number(day.slice(5, 7));
  const date = Number(day.slice(8, 10));
  return MONTHS[month - 1] && date ? `${MONTHS[month - 1]} ${date}` : day;
}

/** "Oct 6–12", "Sep 29–Oct 5", or one day. */
export function formatTrialsRange(from: string, to: string): string {
  if (from === to) return formatTrialsDay(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${formatTrialsDay(from)}–${Number(to.slice(8, 10))}`;
  return `${formatTrialsDay(from)}–${formatTrialsDay(to)}`;
}

/** "Oct 13, 14:20 UTC" of an ISO UTC timestamp (data_through). */
export function formatTrialsCutoff(iso: string): string {
  return `${formatTrialsDay(iso.slice(0, 10))}, ${iso.slice(11, 16)} UTC`;
}

export function trialsMonthLabel(day: string): string {
  return MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
}
