// Dashboard "Daily trials" (below Revenue Intelligence): how many trials
// started per UTC day, by funnel or by GEO, as one compact matrix — the top 8
// rows, "Other" and "Unknown", a shade per day relative to the row's busiest
// day, and a first "All" row of daily bars that replaces a separate chart and
// a bottom Total row. Counts are the Cohorts "Trial" column's (one active-
// snapshot anchor per user; server: _shared/clickhouse/revenueTrials.ts); the
// row model is services/trialsDailyView.ts.
//
// Presentation rule (as in Revenue Intelligence): everything that DESCRIBES
// the displayed numbers — bucket, data-through, filters, restricted copy —
// comes from the DISPLAYED response, never from the controls: keepPreviousData
// keeps the previous response on screen while a new one loads.
//
// Layout: the day columns share what the fixed columns leave (table-fixed).
// One ResizeObserver on the card body sizes them: under 4 px a day axis folds
// into weeks on screen, and numbers appear only where they fit. Never a
// horizontal page scroll; "Show all" stays inside a bounded scroll area.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { AlertTriangle, Download, ExternalLink, Filter, Loader2, MapPin, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FilterMultiSelect } from "@/components/FilterMultiSelect";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScopeDataPending, SCOPE_SNAPSHOT_NOT_READY } from "@/components/access/ScopeDataPending";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { useAccess } from "@/hooks/useAccess";
import { useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useRevenueTrials } from "@/hooks/useRevenueTrials";
import { canAccessRoute } from "@/services/accessRoutes";
import { countryLabel, isNonStandardCountryCode } from "@/services/countryNames";
import { funnelScopeFilterPaths } from "@/services/funnels";
import { supportTableToCsv } from "@/services/supportExport";
import {
  addTrialsDays,
  buildTrialsMatrixView,
  foldAxisToWeeks,
  formatTrialsCell,
  formatTrialsCutoff,
  formatTrialsDay,
  formatTrialsRange,
  heatStep,
  trialsDayLeaders,
  trialsDaysBetween,
  trialsDelta,
  trialsMatrixCsv,
  trialsMonthLabel,
  trialsRowMax,
  trialsSpanDays,
  TRIALS_TOP_N,
  TRIALS_UNKNOWN_KEY,
  type TrialsDelta,
  type TrialsMatrixRow,
  type TrialsSort,
  type TrialsSortKey,
} from "@/services/trialsDailyView";
import type {
  RevenueIntelligenceRequest,
  RevenueTrialsDaily,
  RevenueTrialsMix,
  RevenueTrialsRow,
  TrialsBucket,
  TrialsBucketState,
} from "@/services/revenueIntelligence";

const RANGE_OPTIONS = [
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days (weekly)" },
] as const;
type TrialsRange = (typeof RANGE_OPTIONS)[number]["value"];
type TrialsView = "funnels" | "geo";

const DEFAULT_UI = {
  view: "funnels" as TrialsView,
  range: "30" as TrialsRange,
  // Cohort-grain member filters (Cohorts semantics: they narrow the set of users).
  funnels: [] as string[],
  countries: [] as string[],
  // Accumulated option dictionaries (persisted for the same reason as Revenue
  // Intelligence's: a filtered response only carries the selected keys).
  funnelDict: [] as string[],
  countryDict: [] as string[],
};

// Fixed column widths in px — the same values as their width classes below
// (w-28 sm:w-32 lg:w-44 xl:w-52 · hidden lg:w-16 xl:w-28 · w-14 · w-16).
type Breakpoint = "base" | "sm" | "lg" | "xl";
const LABEL_PX: Record<Breakpoint, number> = { base: 112, sm: 128, lg: 176, xl: 208 };
const MIX_PX: Record<Breakpoint, number> = { base: 0, sm: 0, lg: 64, xl: 112 };
const TOTAL_PX = 56;
const DELTA_PX = 64;
/** The expanded body scrolls vertically; its scrollbar takes width from the
 * days. Reserved whenever the list CAN expand (expanded or not), so expanding
 * never flips the week fold or the numbers. */
const SCROLLBAR_PX = 16;
/** Without a measurement (jsdom, first paint) the body is assumed this wide. */
const ASSUMED_WIDTH_PX = 1024;

const HEAT_PRIMARY = ["bg-muted/30", "bg-primary/10", "bg-primary/25", "bg-primary/45", "bg-primary/65", "bg-primary"];
const HEAT_MUTED = ["bg-muted/30", "bg-muted-foreground/10", "bg-muted-foreground/25", "bg-muted-foreground/45", "bg-muted-foreground/65", "bg-muted-foreground/85"];
// Cell numbers (10 px) stay ≥ 4.5:1 in both themes: the foreground text up to
// step 4 (dark theme: its primary is near-white, so step 4 takes the dark
// primary-foreground), primary-foreground only on the full bg-primary step 5;
// muted rows use the foreground at every step (dark: the background on step 5).
const HEAT_TEXT_PRIMARY = ["", "", "", "", "dark:text-primary-foreground", "text-primary-foreground"];
const HEAT_TEXT_MUTED = ["text-foreground", "text-foreground", "text-foreground", "text-foreground", "text-foreground", "text-foreground dark:text-background"];
const MIX_SHADES = ["bg-primary", "bg-primary/60", "bg-primary/35"];
/** "No data imported yet": a 135° hatch, never a 0. */
const HATCH: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.22) 0 1px, transparent 1px 4px)",
};

function breakpointOf(width: number): Breakpoint {
  return width >= 1280 ? "xl" : width >= 1024 ? "lg" : width >= 640 ? "sm" : "base";
}

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Width of the card body (one ResizeObserver) and the viewport breakpoint the
 * column classes resolve to. Neither depends on the table, so it cannot loop.
 * The first measure runs before paint (layout effect): a response restored
 * from the persisted cache is never drawn once with the assumed width. */
function useBodyWidth(): { ref: React.RefObject<HTMLDivElement>; width: number; bp: Breakpoint } {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(() => ({
    width: ASSUMED_WIDTH_PX,
    bp: breakpointOf(typeof window === "undefined" ? ASSUMED_WIDTH_PX : window.innerWidth),
  }));
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const width = element.clientWidth;
      const next = { width: width > 0 ? width : ASSUMED_WIDTH_PX, bp: breakpointOf(window.innerWidth) };
      setSize((prev) => (prev.width === next.width && prev.bp === next.bp ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

interface MatrixColumns {
  start: string[];
  end: string[];
  state: TrialsBucketState[];
  /** Response axis indices behind each column. */
  groups: number[][];
  /** Divisor of each column's heat / bar scale: the on-screen fold's days with
   * data (a short edge week is shaded by its per-day rate), else 1. */
  scaleDays: number[];
  /** A column is a week (server week grain, or the on-screen fold). */
  weekly: boolean;
  folded: boolean;
}

function columnsOf(data: RevenueTrialsDaily, foldWeeks: boolean): MatrixColumns {
  if (foldWeeks) {
    const folded = foldAxisToWeeks(data.axis, data.axis_state, []);
    return {
      start: folded.axis, end: folded.ends, state: folded.axisState, groups: folded.groups, scaleDays: folded.dataDays, weekly: true, folded: true,
    };
  }
  const week = data.bucket === "week";
  return {
    start: data.axis,
    end: data.axis.map((day) => (week ? addTrialsDays(day, 6) : day)),
    state: data.axis_state,
    groups: data.axis.map((_day, index) => [index]),
    scaleDays: data.axis.map(() => 1),
    weekly: week,
    folded: false,
  };
}

/** Column indices whose day-of-month is printed: every k-th counted back from
 * the newest column (always labelled), plus the oldest when it has room. */
function labelledColumns(count: number, k: number): Set<number> {
  const labelled = new Set<number>();
  for (let index = count - 1; index >= 0; index -= k) labelled.add(index);
  const nearest = Math.min(...[...labelled]);
  if (count > 0 && nearest >= k) labelled.add(0);
  return labelled;
}

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const grouped = (value: number) => value.toLocaleString("en-US");
const avg = (value: number) => (value > 0 && value < 1 ? "<1" : grouped(Math.round(value)));

function mixTitle(mix: readonly RevenueTrialsMix[], unknown: number, trials: number): string {
  if (trials <= 0) return "";
  const named = mix.reduce((sum, entry) => sum + entry.trials, 0);
  const rest = Math.max(0, trials - named - unknown);
  return [
    ...mix.map((entry) => `${entry.key} ${pct(entry.trials, trials)}%`),
    ...(rest > 0 ? [`other ${pct(rest, trials)}%`] : []),
    ...(unknown > 0 ? [`Unknown ${pct(unknown, trials)}%`] : []),
  ].join(" · ");
}

function MixBar({ mix, unknown, trials }: { mix: readonly RevenueTrialsMix[]; unknown: number; trials: number }): JSX.Element {
  if (trials <= 0) return <span className="text-xs text-muted-foreground">—</span>;
  const named = mix.reduce((sum, entry) => sum + entry.trials, 0);
  const rest = Math.max(0, trials - named - unknown);
  const top = mix[0];
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        {mix.map((entry, index) => (
          <div key={entry.key} className={cn("h-full", MIX_SHADES[index])} style={{ width: `${(entry.trials / trials) * 100}%` }} />
        ))}
        {rest > 0 && <div className="h-full bg-muted-foreground/30" style={{ width: `${(rest / trials) * 100}%` }} />}
        {unknown > 0 && <div className="h-full bg-muted-foreground/15" style={{ width: `${(unknown / trials) * 100}%` }} />}
      </div>
      {top && (
        <span className="hidden w-14 shrink-0 truncate text-[10px] tabular-nums text-muted-foreground xl:inline">
          {top.key} {pct(top.trials, trials)}%
        </span>
      )}
    </div>
  );
}

function DeltaBadge({ delta }: { delta: TrialsDelta }): JSX.Element {
  if (delta.kind === "new") return <span className="rounded border border-primary/60 px-1 text-[10px] text-primary">new</span>;
  if (delta.kind === "stopped") return <span className="text-[10px] font-medium text-destructive">stopped</span>;
  if (delta.kind === "none" || delta.pct === null) return <span className="text-muted-foreground">—</span>;
  const whole = Math.round(delta.pct * 100);
  if (whole === 0) return <span className="text-muted-foreground">0%</span>;
  const up = whole > 0;
  return (
    <span className={cn("whitespace-nowrap", delta.significant ? (up ? "text-success" : "text-destructive") : "text-muted-foreground")}>
      {up ? "▲" : "▼"} {Math.abs(whole)}%
    </span>
  );
}

/** Title of a Δ badge; `row` is the row's (or the totals') trials of the
 * whole window and of the previous one. */
function deltaTitle(delta: TrialsDelta, row: { trials: number; prev_trials: number }, data: RevenueTrialsDaily, spanDays: number): string {
  const previous = formatTrialsRange(data.prev_from, data.prev_to);
  if (delta.completeDays === 0) return "No complete day yet to compare";
  if (delta.kind === "new") return `New: no trials in ${previous}`;
  // "none" with trials: they all fall in the partial bucket (Δ reads complete ones only).
  if (delta.kind === "none" && row.trials > 0) return `Trials only in the partial ${data.bucket} — nothing complete to compare yet`;
  if (delta.kind === "none") return `No trials in this window or in ${previous}`;
  const rate = (value: number) => value.toFixed(1);
  const now = delta.actual / delta.completeDays;
  const before = spanDays > 0 ? row.prev_trials / spanDays : 0;
  return `Avg/day ${rate(now)} (complete days) vs ${rate(before)} in ${previous}${delta.z === null ? "" : ` · z ${delta.z.toFixed(1)}`}`;
}

function downloadTrialsCsv(rows: readonly TrialsMatrixRow[], axis: readonly string[], view: TrialsView, bucket: TrialsBucket): void {
  const blob = new Blob(["﻿", supportTableToCsv(trialsMatrixCsv(rows, axis))], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `trials-by-${view}-${bucket}-${utcToday()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export function TrialsDailySection(): JSX.Element {
  const { user } = useAuth();
  const access = useAccess();
  const canOpenCohorts = canAccessRoute("/cohorts", access);
  const canOpenImport = canAccessRoute("/import", access);
  const { version: warehouseVersion, ready } = useWarehouseVersion(Boolean(user));
  const [ui, setUi] = usePersistedPageState("ui_state_trials_daily", DEFAULT_UI);
  // A tampered / outdated persisted value never reaches the request.
  const range: TrialsRange = RANGE_OPTIONS.some((option) => option.value === ui.range) ? ui.range : DEFAULT_UI.range;
  const view: TrialsView = ui.view === "geo" ? "geo" : "funnels";

  // Local on purpose: a reload always opens the compact view.
  const [sort, setSort] = useState<TrialsSort>({ key: "trials", dir: "desc" });
  const [expanded, setExpanded] = useState(false);
  const [pinnedDay, setPinnedDay] = useState<string | null>(null);

  // The window rolls over at UTC midnight even if the page stays open.
  const [today, setToday] = useState(utcToday);
  useEffect(() => {
    const id = setInterval(() => {
      const next = utcToday();
      setToday((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const restricted = access.restricted;
  const scopePaths = useMemo(() => funnelScopeFilterPaths(access.funnelScope), [access.funnelScope]);
  const outOfScopeFunnels = useMemo(
    () => (restricted ? ui.funnels.filter((path) => !scopePaths.has(path)) : []),
    [restricted, ui.funnels, scopePaths],
  );
  const request = useMemo<RevenueIntelligenceRequest>(() => {
    const days = Number(range);
    return {
      action: "trials_daily",
      date_from: addTrialsDays(today, -(days - 1)),
      date_to: today,
      bucket: days === 180 ? "week" : "day",
      filters: { campaign_path: ui.funnels, country: ui.countries },
    };
  }, [range, today, ui.funnels, ui.countries]);

  const { data, error, errorCode, isInitialLoading, isRefreshing } = useRevenueTrials({
    request,
    userScopeHash: access.partition,
    warehouseVersion,
    enabled: Boolean(user) && ready,
  });
  const shown = data?.ok ? data : null;

  // Filter dictionaries accumulate from every response and persist.
  useEffect(() => {
    if (!shown) return;
    const keys = (rows: readonly RevenueTrialsRow[]) => rows.map((row) => row.key).filter((key) => key !== TRIALS_UNKNOWN_KEY);
    const funnelKeys = keys(shown.by_funnel);
    const countryKeys = keys(shown.by_country);
    setUi((prev) => {
      const funnelDict = [...new Set([...prev.funnelDict, ...funnelKeys])].sort();
      const countryDict = [...new Set([...prev.countryDict, ...countryKeys])].sort();
      if (funnelDict.length === prev.funnelDict.length && countryDict.length === prev.countryDict.length) return prev;
      return { ...prev, funnelDict, countryDict };
    });
  }, [shown, setUi]);
  // A restricted member is offered their funnels' paths only.
  const funnelOptions = useMemo(
    () => [...new Set([...ui.funnelDict, ...ui.funnels])].filter((path) => !restricted || scopePaths.has(path)).sort(),
    [ui.funnelDict, ui.funnels, restricted, scopePaths],
  );
  const countryOptions = useMemo(() => [...new Set([...ui.countryDict, ...ui.countries])].sort(), [ui.countryDict, ui.countries]);

  const { ref: bodyRef, width, bp } = useBodyWidth();

  // ---- presentation of the DISPLAYED response ----------------------------------
  const shownRestricted = shown ? Boolean(shown.meta) || shown.diagnostics.note !== "" : restricted;
  const spanDays = shown ? trialsSpanDays(shown.date_from, shown.date_to) : 0;
  const rowsAll = useMemo(() => (shown ? (view === "funnels" ? shown.by_funnel : shown.by_country) : []), [shown, view]);
  const matrix = useMemo(
    () => (shown ? buildTrialsMatrixView(rowsAll, shown.axis_state, shown.bucket, spanDays, sort, expanded) : null),
    [shown, rowsAll, spanDays, sort, expanded],
  );
  const totalsDelta = useMemo(
    () => (shown ? trialsDelta({ cells: shown.totals.daily, prev_trials: shown.totals.prev_trials }, shown.axis_state, shown.bucket, spanDays) : null),
    [shown, spanDays],
  );

  const canFold = Boolean(matrix && matrix.count > TRIALS_TOP_N + 1);
  const fixedPx = LABEL_PX[bp] + MIX_PX[bp] + TOTAL_PX + DELTA_PX + (canFold ? SCROLLBAR_PX : 0);
  const axisLength = shown?.axis.length ?? 0;
  // Deterministic: the width never depends on the fold, so it cannot oscillate.
  const foldWeeks = Boolean(shown && shown.bucket === "day" && axisLength > 0 && (width - fixedPx) / axisLength < 4);
  const columns = useMemo(() => (shown ? columnsOf(shown, foldWeeks) : null), [shown, foldWeeks]);
  const fold = (cells: readonly number[]) => (columns ? columns.groups.map((group) => group.reduce((sum, index) => sum + (cells[index] ?? 0), 0)) : []);
  // Heat and bar heights read the per-day rate of a folded week (sums stay the numbers).
  const scaled = (values: readonly number[]) => values.map((value, index) => value / (columns?.scaleDays[index] ?? 1));
  const columnCount = columns?.start.length ?? 0;
  const dayCellPx = columnCount ? Math.max(0, (width - fixedPx) / columnCount) : 0;
  const bodyRows: RevenueTrialsRow[] = matrix ? [...matrix.visible, ...(matrix.other ? [matrix.other] : []), ...matrix.pinned] : [];
  const digits = Math.max(1, ...bodyRows.flatMap((row) => fold(row.cells).filter((value) => value > 0).map((value) => formatTrialsCell(value).length)));
  const showNumbers = dayCellPx >= 6 * digits + 6;
  const labelEvery = dayCellPx > 0 ? Math.max(1, Math.ceil(18 / dayCellPx)) : 1;
  const labelled = labelledColumns(columnCount, labelEvery);

  const dailyCols = shown ? fold(shown.totals.daily) : [];
  const dailyScaled = scaled(dailyCols);
  const dailyMax = Math.max(0, ...dailyScaled);
  const unknownRow = rowsAll.find((row) => row.key === TRIALS_UNKNOWN_KEY);
  const unknownCols = unknownRow ? fold(unknownRow.cells) : [];
  // The column that holds the pinned day (a folded week holds seven).
  const pinnedIndex = shown && columns && pinnedDay ? columns.groups.findIndex((group) => group.some((index) => shown.axis[index] === pinnedDay)) : -1;

  const cutoff = shown?.data_through ?? null;
  const cutoffAgeDays = cutoff ? trialsDaysBetween(cutoff.slice(0, 10), today) : 0;
  const beforeWindow = Boolean(shown && cutoff && cutoff.slice(0, 10) < shown.date_from);
  const emptyResponse = Boolean(shown && shown.by_funnel.length === 0 && shown.by_country.length === 0);
  const userFiltered = ui.funnels.length > 0 || ui.countries.length > 0;
  const noun = view === "funnels" ? "funnels" : "countries";
  const columnUnit = columns?.weekly ? "week" : "day";

  const nameOf = (key: string) => (view === "geo" ? countryLabel(key) : key);
  const columnLabel = (index: number) => {
    if (!columns) return "";
    const range = formatTrialsRange(columns.start[index], columns.end[index]);
    // A folded edge week cut by the window says how short it is.
    const days = columns.groups[index]?.length ?? 0;
    return columns.folded && days < 7 ? `${range} (${days} ${days === 1 ? "day" : "days"})` : range;
  };
  const toggleSort = (key: TrialsSortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "key" ? "asc" : "desc" }));
  const sortMark = (key: TrialsSortKey) => (sort.key === key ? (sort.dir === "asc" ? " ↑" : " ↓") : "");
  const ariaSort = (key: TrialsSortKey) => (sort.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined);
  const clearFilters = () => setUi((prev) => ({ ...prev, funnels: [], countries: [] }));

  // ---- header ---------------------------------------------------------------------
  const dataThroughFragment: ReactNode = !shown ? null : shownRestricted ? (
    <span>updates after each Primer import</span>
  ) : !cutoff ? (
    <span>no import yet</span>
  ) : cutoffAgeDays >= 2 ? (
    <span className="inline-flex items-center gap-1 text-warning" title={`Data through ${formatTrialsCutoff(cutoff)}`}>
      <AlertTriangle className="h-3 w-3" />
      {canOpenImport ? (
        <Link to="/import" className="underline-offset-2 hover:underline">last import {cutoffAgeDays} days ago</Link>
      ) : (
        <>last import {cutoffAgeDays} days ago</>
      )}
    </span>
  ) : (
    <span>data through {formatTrialsCutoff(cutoff)}</span>
  );

  const statLine = shown && totalsDelta && !emptyResponse && !beforeWindow ? (
    <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-foreground">
      <span className="font-medium">{grouped(shown.totals.trials)} trials</span>
      {totalsDelta.completeDays > 0 && <span className="text-muted-foreground">· {avg(totalsDelta.actual / totalsDelta.completeDays)}/day</span>}
      <span className="text-muted-foreground">·</span>
      <span title={deltaTitle(totalsDelta, shown.totals, shown, spanDays)}>
        <DeltaBadge delta={totalsDelta} />
      </span>
      <span className="text-muted-foreground">vs previous {spanDays} days</span>
      {shown.totals.trials > 0 && (
        <span className="text-muted-foreground">· GEO known {100 - pct(shown.totals.unknown_geo, shown.totals.trials)}%</span>
      )}
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{dataThroughFragment}</span>
    </p>
  ) : null;

  // ---- matrix rows ------------------------------------------------------------------
  const cellTitle = (name: string, index: number, value: number, state: TrialsBucketState) => {
    const head = `${name}, ${columnLabel(index)}`;
    if (state === "no_data") return `${head}: no data imported yet`;
    const share = dailyCols[index] > 0 ? ` (${((value / dailyCols[index]) * 100).toFixed(1)}% of the ${columnUnit})` : "";
    return `${head}: ${grouped(value)} ${value === 1 ? "trial" : "trials"}${share}${state === "partial" ? " · partial" : ""}`;
  };
  const columnBorder = (index: number) =>
    columns && !columns.weekly && index > 0 && new Date(`${columns.start[index]}T00:00:00Z`).getUTCDay() === 1 ? "border-l border-border/60" : undefined;

  const renderRow = (row: TrialsMatrixRow, variant: "row" | "other" | "unknown") => {
    const muted = variant !== "row";
    const cells = fold(row.cells);
    const heatCells = scaled(cells);
    const rowMax = trialsRowMax(heatCells, columns?.state ?? []);
    const name = variant === "other" ? "Other" : nameOf(row.key);
    const mixText = variant === "other" ? "" : mixTitle(row.mix, row.mix_unknown, row.trials);
    const nonStandard = view === "geo" && variant === "row" && isNonStandardCountryCode(row.key);
    // The full displayed name (in GEO view "BA · Bosnia & Herzegovina", not just "BA").
    const labelTitle = [name, nonStandard ? "non-standard code" : "", bp === "base" || bp === "sm" ? mixText : ""].filter(Boolean).join(" · ");
    const heat = muted ? HEAT_MUTED : HEAT_PRIMARY;
    const heatText = muted ? HEAT_TEXT_MUTED : HEAT_TEXT_PRIMARY;
    return (
      <TableRow key={`${variant}:${row.key}`} className={cn("group hover:bg-muted/30", muted && "text-muted-foreground")}>
        <TableCell className="relative px-3 py-1.5 text-xs">
          <div className="flex min-w-0 items-center gap-1">
            <span className={cn("min-w-0 flex-1 truncate", muted ? "italic" : "font-medium text-foreground")} title={variant === "other" ? undefined : labelTitle}>
              {name}
              {variant === "other" && matrix?.other && <span className="ml-1 not-italic">· {matrix.other.count} {noun}</span>}
            </span>
            {/* With a pointer: laid over the name's end on hover / focus, so it
                takes no width from the narrow label column. Touch screens
                (no hover): in the row, always visible — never an invisible
                tap target. -my-1: the 24 px button must not stretch the 29 px row. */}
            {variant === "row" && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  "absolute inset-y-0 right-1 my-auto h-6 w-6 shrink-0 bg-card opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
                  "[@media(hover:none)]:static [@media(hover:none)]:-my-1 [@media(hover:none)]:bg-transparent [@media(hover:none)]:opacity-60",
                )}
                title={view === "funnels" ? "GEO of this funnel" : "Funnels of this GEO"}
                aria-label={view === "funnels" ? `GEO of this funnel: ${row.key}` : `Funnels of this GEO: ${row.key}`}
                onClick={() => setUi((prev) => (view === "funnels"
                  ? { ...prev, funnels: [row.key], view: "geo" }
                  : { ...prev, countries: [row.key], view: "funnels" }))}
              >
                {view === "funnels" ? <MapPin className="h-3.5 w-3.5" /> : <Filter className="h-3.5 w-3.5" />}
              </Button>
            )}
          </div>
        </TableCell>
        <TableCell className="hidden px-2 py-1.5 leading-4 lg:table-cell" title={mixText || undefined}>
          {variant === "other" ? <span className="text-xs">—</span> : <MixBar mix={row.mix} unknown={row.mix_unknown} trials={row.trials} />}
        </TableCell>
        {cells.map((value, index) => {
          const state = columns?.state[index] ?? "complete";
          const step = state === "no_data" ? 0 : heatStep(heatCells[index], rowMax);
          const title = cellTitle(name, index, value, state);
          return (
            <TableCell key={index} className={cn("p-0", columnBorder(index))} title={title} aria-label={title}>
              <div
                className={cn(
                  "m-px flex h-[17px] items-center justify-center overflow-hidden rounded-[2px] text-[10px] leading-none tabular-nums",
                  state === "no_data" ? undefined : heat[step],
                  heatText[step],
                  state === "partial" && "outline-dashed outline-1 -outline-offset-1 outline-muted-foreground/60",
                  pinnedIndex === index && "ring-1 ring-primary/60",
                )}
                style={state === "no_data" ? HATCH : undefined}
              >
                {showNumbers && state !== "no_data" && value > 0 ? formatTrialsCell(value) : null}
              </div>
            </TableCell>
          );
        })}
        <TableCell className="px-1.5 py-1.5 text-right font-mono text-xs font-medium text-foreground">{grouped(row.trials)}</TableCell>
        <TableCell
          className="px-2 py-1.5 text-right text-[11px] leading-4"
          title={shown ? deltaTitle(row.delta, row, shown, spanDays) : undefined}
        >
          <DeltaBadge delta={row.delta} />
        </TableCell>
      </TableRow>
    );
  };

  const allMix = useMemo(() => {
    if (!shown) return { mix: [] as RevenueTrialsMix[], unknown: 0 };
    const other = view === "funnels" ? shown.by_country : shown.by_funnel;
    return {
      mix: other.filter((row) => row.key !== TRIALS_UNKNOWN_KEY && row.trials > 0).slice(0, 3).map((row) => ({ key: row.key, trials: row.trials })),
      unknown: view === "funnels" ? shown.totals.unknown_geo : shown.totals.unknown_funnel,
    };
  }, [shown, view]);

  const partialTitle = shownRestricted
    ? "Partial: today (UTC) is not over"
    : cutoff ? `Partial: data through ${cutoff.slice(11, 16)} UTC` : "Partial";

  const matrixTable = shown && columns && matrix && totalsDelta ? (
    <div className={cn("w-full overflow-x-auto", expanded && "max-h-[420px] overflow-y-auto", isRefreshing && "opacity-60")}>
      <table className="w-full table-fixed caption-bottom text-sm" data-testid="trials-matrix">
        <TableHeader className={cn(expanded && "sticky top-0 z-10 bg-card")}>
          <TableRow className="hover:bg-transparent">
            <TableHead className="h-9 w-28 px-3 text-xs sm:w-32 lg:w-44 xl:w-52" aria-sort={ariaSort("key")}>
              <button type="button" className="select-none whitespace-nowrap" onClick={() => toggleSort("key")}>
                {view === "funnels" ? "Funnel" : "GEO"}{sortMark("key")}
              </button>
            </TableHead>
            <TableHead
              className="hidden h-9 whitespace-nowrap px-2 text-[10px] lg:table-cell lg:w-16 xl:w-28"
              title={view === "funnels" ? "Top GEOs of the row" : "Top funnels of the row"}
            >
              <span className="xl:hidden">Mix</span>
              <span className="hidden xl:inline">{view === "funnels" ? "GEO mix" : "Funnel mix"}</span>
            </TableHead>
            {columns.start.map((day, index) => {
              const state = columns.state[index];
              const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
              const weekend = !columns.weekly && (weekday === 0 || weekday === 6);
              const showMonth = index === 0 || trialsMonthLabel(day) !== trialsMonthLabel(columns.start[index - 1]);
              const notes = [
                columnLabel(index),
                state === "partial" ? partialTitle : state === "no_data" ? "No data imported yet" : "",
                pinnedIndex === index ? "click to unpin" : "click to pin",
              ].filter(Boolean).join(" · ");
              return (
                <TableHead key={day} className={cn("h-9 p-0 text-center align-bottom font-normal", columnBorder(index))}>
                  <button
                    type="button"
                    title={notes}
                    aria-label={notes}
                    aria-pressed={pinnedIndex === index}
                    onClick={() => setPinnedDay(pinnedIndex === index ? null : day)}
                    className={cn(
                      "flex h-9 w-full flex-col items-center justify-end pb-1 text-[10px] leading-3 tabular-nums text-foreground",
                      weekend && "text-muted-foreground/70",
                      state === "no_data" && "text-muted-foreground/50",
                      pinnedIndex === index && "rounded-sm bg-primary/10 text-primary",
                    )}
                  >
                    <span className="h-3 whitespace-nowrap text-muted-foreground">{showMonth ? trialsMonthLabel(day) : ""}</span>
                    <span className="h-3 whitespace-nowrap">
                      {labelled.has(index) ? Number(day.slice(8, 10)) : ""}
                      {state === "partial" ? "•" : ""}
                    </span>
                  </button>
                </TableHead>
              );
            })}
            <TableHead className="h-9 w-14 px-1.5 text-right text-xs" aria-sort={ariaSort("trials")}>
              <button type="button" className="select-none whitespace-nowrap" onClick={() => toggleSort("trials")}>Total{sortMark("trials")}</button>
            </TableHead>
            <TableHead className="h-9 w-16 px-2 text-right text-xs" aria-sort={ariaSort("delta")}>
              <button type="button" className="select-none whitespace-nowrap" onClick={() => toggleSort("delta")}>Δ{sortMark("delta")}</button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow className="hover:bg-transparent" data-testid="trials-all-row">
            <TableCell className="px-3 py-1 align-top text-xs">
              <div className="font-semibold text-foreground">All · trials/{columnUnit}</div>
              {/* The bar scale: a folded week's bar is its per-day rate. */}
              <div className="text-[10px] text-muted-foreground">max {columns.folded ? `${avg(dailyMax)}/day` : grouped(dailyMax)}</div>
            </TableCell>
            <TableCell className="hidden px-2 py-1 leading-4 lg:table-cell" title={mixTitle(allMix.mix, allMix.unknown, shown.totals.trials) || undefined}>
              <MixBar mix={allMix.mix} unknown={allMix.unknown} trials={shown.totals.trials} />
            </TableCell>
            {dailyCols.map((value, index) => {
              const state = columns.state[index];
              const unknownShare = value > 0 ? Math.min(100, ((unknownCols[index] ?? 0) / value) * 100) : 0;
              const title = state === "no_data"
                ? `${columnLabel(index)}: no data imported yet`
                : `${columnLabel(index)}: ${grouped(value)} trials${unknownCols[index] ? ` · Unknown ${grouped(unknownCols[index])}` : ""}${state === "partial" ? " · partial" : ""}`;
              return (
                <TableCell key={index} className={cn("p-0 align-bottom", columnBorder(index))} title={title} aria-label={title}>
                  <div className="mx-px flex h-14 flex-col justify-end" style={state === "no_data" ? HATCH : undefined}>
                    {state !== "no_data" && value > 0 && dailyMax > 0 && (
                      <div
                        className={cn("flex w-full flex-col overflow-hidden rounded-t-[2px]", state === "partial" && "border-t-2 border-dashed border-primary opacity-50")}
                        style={{ height: `${Math.max(2, (dailyScaled[index] / dailyMax) * 100)}%` }}
                      >
                        {unknownShare > 0 && <div className="w-full bg-muted-foreground/40" style={{ height: `${unknownShare}%` }} />}
                        <div className="w-full flex-1 bg-primary" />
                      </div>
                    )}
                  </div>
                </TableCell>
              );
            })}
            <TableCell className="px-1.5 py-1 text-right align-bottom font-mono text-xs font-semibold text-foreground">{grouped(shown.totals.trials)}</TableCell>
            <TableCell className="px-2 py-1 text-right align-bottom text-[11px] leading-4" title={deltaTitle(totalsDelta, shown.totals, shown, spanDays)}>
              <DeltaBadge delta={totalsDelta} />
            </TableCell>
          </TableRow>
          {matrix.visible.map((row) => renderRow(row, "row"))}
          {matrix.other && renderRow(matrix.other, "other")}
          {matrix.pinned.map((row) => renderRow(row, "unknown"))}
        </TableBody>
      </table>
    </div>
  ) : null;

  // ---- footer -----------------------------------------------------------------------
  const pinnedGroup = columns && pinnedIndex >= 0 ? columns.groups[pinnedIndex] : null;
  const pinnedLine = shown && columns && pinnedGroup ? (
    <span className="inline-flex flex-wrap items-center gap-x-1.5" data-testid="trials-pinned-day">
      <span className="font-medium text-foreground">{columnLabel(pinnedIndex)}</span>
      <span>· {grouped(dailyCols[pinnedIndex] ?? 0)} trials</span>
      {trialsDayLeaders(rowsAll, pinnedGroup).map((leader) => (
        <span key={leader.key}>· {nameOf(leader.key)} {grouped(leader.trials)}</span>
      ))}
      {canOpenCohorts && !columns.weekly && (
        <Link
          to={`/cohorts?cohort_date=${columns.start[pinnedIndex]}`}
          className="inline-flex items-center gap-1 font-medium text-primary underline-offset-2 hover:underline"
        >
          Open in Cohorts <ExternalLink className="h-3 w-3" />
        </Link>
      )}
      <Button type="button" variant="ghost" size="icon" className="h-5 w-5" aria-label="Unpin the day" onClick={() => setPinnedDay(null)}>
        <X className="h-3 w-3" />
      </Button>
    </span>
  ) : null;
  const legend = (
    <span>
      shade = share of the row's busiest {columnUnit} · <span aria-hidden="true">▨</span> no data yet · ┆ partial · UTC {columnUnit}s · past days can change after a re-import
    </span>
  );

  // ---- body state (one line each) ----------------------------------------------------
  let body: ReactNode;
  let matrixShown = false;
  if (error === "cohort_snapshot_not_ready" && errorCode === SCOPE_SNAPSHOT_NOT_READY) {
    body = <div className="px-4 py-3"><ScopeDataPending inline testId="trials-scope-pending" /></div>;
  } else if (error === "cohort_snapshot_not_ready") {
    body = <div className="px-4 py-3 text-sm text-muted-foreground">Daily trials need the cohort snapshot — see Revenue Intelligence above.</div>;
  } else if (error) {
    body = <div className="px-4 py-3 text-sm text-destructive">Daily trials request failed: {error}</div>;
  } else if (!shown) {
    // Initial load (or waiting for the warehouse version / access to resolve).
    body = (
      <div className="flex min-h-[120px] items-center justify-center gap-2 text-sm text-muted-foreground" aria-busy={isInitialLoading}>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading daily trials…
      </div>
    );
  } else if (beforeWindow && cutoff) {
    body = <div className="px-4 py-3 text-sm text-muted-foreground">Last import {formatTrialsCutoff(cutoff)} is before this window.</div>;
  } else if (emptyResponse || axisLength === 0) {
    body = shown.diagnostics.filters_active && (userFiltered || !shownRestricted) ? (
      <div className="px-4 py-3 text-sm text-muted-foreground">
        No trials match the filters ·{" "}
        <Button type="button" variant="link" size="sm" className="h-auto p-0 text-sm" onClick={clearFilters}>Clear filters</Button>
      </div>
    ) : (
      <div className="px-4 py-3 text-sm text-muted-foreground">No trials in this period · {dataThroughFragment}</div>
    );
  } else {
    body = matrixTable;
    matrixShown = Boolean(matrixTable);
  }

  return (
    <section className="my-5">
      <Card className="shadow-card" data-testid="trials-daily">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-foreground">{view === "geo" ? "Daily trials by GEO" : "Daily trials"}</h3>
            <p className="text-xs text-muted-foreground">
              Trials started per UTC day · first successful payment per user (same count as the Cohorts Trial column) ·{" "}
              {shownRestricted ? "only your funnels" : "project-wide"}
            </p>
            {statLine}
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {isRefreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
            <Tabs value={view} onValueChange={(value) => setUi((prev) => ({ ...prev, view: value === "geo" ? "geo" : "funnels" }))}>
              <TabsList className="h-8">
                <TabsTrigger value="funnels" className="text-xs">Funnels</TabsTrigger>
                <TabsTrigger value="geo" className="text-xs">GEO</TabsTrigger>
              </TabsList>
            </Tabs>
            <FilterMultiSelect label="Funnel" values={ui.funnels} options={funnelOptions}
              onChange={(values) => setUi((prev) => ({ ...prev, funnels: values }))} />
            <FilterMultiSelect label="GEO" values={ui.countries} options={countryOptions} formatOption={countryLabel}
              onChange={(values) => setUi((prev) => ({ ...prev, countries: values }))} />
            <Select
              value={range}
              onValueChange={(value) => {
                setPinnedDay(null);
                setUi((prev) => ({ ...prev, range: value as TrialsRange }));
              }}
            >
              <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {outOfScopeFunnels.length > 0 && (
          <div className="border-b border-border px-4 py-2 text-xs text-warning" data-testid="trials-out-of-scope-funnels">
            {outOfScopeFunnels.length === ui.funnels.length
              ? "Your saved funnel filter is outside your funnels, so nothing matches."
              : outOfScopeFunnels.length === 1
                ? "1 saved funnel filter is outside your funnels and was ignored."
                : `${outOfScopeFunnels.length} saved funnel filters are outside your funnels and were ignored.`}{" "}
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs"
              onClick={() => setUi((prev) => ({ ...prev, funnels: prev.funnels.filter((path) => scopePaths.has(path)) }))}>
              Clear
            </Button>
          </div>
        )}
        <div ref={bodyRef} className="min-w-0">{body}</div>
        {matrixShown && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
            <div className="min-w-0 text-xs text-muted-foreground">{pinnedLine ?? legend}</div>
            <div className="ml-auto flex items-center gap-2">
              {canFold && matrix && (
                <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setExpanded((prev) => !prev)}>
                  {expanded ? `Show top ${TRIALS_TOP_N}` : `Show all ${matrix.count} ${noun}`}
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={isRefreshing}
                title={isRefreshing ? "Waiting for the current selection to load" : undefined}
                onClick={() => {
                  if (!shown) return;
                  const all = buildTrialsMatrixView(rowsAll, shown.axis_state, shown.bucket, spanDays, sort, true);
                  downloadTrialsCsv([...all.visible, ...all.pinned], shown.axis, view, shown.bucket);
                }}
              >
                <Download className="h-3.5 w-3.5" /> CSV
              </Button>
            </div>
          </div>
        )}
      </Card>
    </section>
  );
}
