// Day-axis stacking for cross-funnel cash-flow composition (Project Forecasting P1).
//
// WHY DAYS, NOT PERIOD INDICES. Cadences differ only by period duration
// (monthly 30, weekly 7, quarterly 90 — funnelEconomicsTypes.CADENCE_DAYS), so a
// weekly scenario's P4 ends on day 35 while a monthly P4 ends on day 150.
// buildScenarioComparison aligns by periodIndex, which is only correct within
// one cadence; summing across cadences must join on the day axis.
//
// SEMANTICS. Each funnel's cumulative payment-net is a RIGHT-CONTINUOUS STEP
// function that jumps at each period's dayEnd — matching the engine's own
// payback convention (paybackDay = rows[paybackPeriodIndex].dayEnd). Stepping at
// dayStart instead would make a 1-funnel project disagree with that funnel's own
// paybackDay, which is the identity the whole composition is anchored to.
// Between boundaries the value holds; past the last boundary it holds forever
// (a funnel whose horizon ended keeps its final balance — never null, never
// extrapolated; the caller renders the region past shortestHorizonDay dashed).
//
// This module is pure and knows nothing about scenarios, spend or overhead —
// only boundary series in, stacked grid out.
import type { ForecastPeriodRow } from "./funnelEconomicsTypes.ts";
import { firstCrossingIndex } from "./financialPrimitives.ts";

export interface DayGridBoundary {
  /** Day offset (from the series' own day 0) at which the cumulative value lands. */
  dayEnd: number;
  cumulative: number;
}

export interface DayGridSeries {
  id: string;
  /** Calendar phasing seam for the v2 calendar-stacked model. Always 0 in v1. */
  startDayOffset: number;
  /** Ascending by dayEnd. */
  boundaries: ReadonlyArray<DayGridBoundary>;
}

export interface StackedDayGridPoint {
  day: number;
  /** Σ over series of the right-continuous step value at `day`. */
  total: number;
  /** How many series still have a boundary at or after `day` (for dashed-region rendering). */
  contributing: number;
}

export interface StackedDayGrid {
  points: StackedDayGridPoint[];
  /** min over series of (offset + last boundary day); 0 when there are no series.
   *  Past this day the stack is understating growth (some funnel's horizon ended). */
  shortestHorizonDay: number;
  longestHorizonDay: number;
  endedSeries: Array<{ id: string; lastDay: number }>;
  /** Series whose cumulative ever decreases. Payback semantics are meaningless for
   *  them (s + r > 1 style inputs); the caller must suppress the verdict. */
  nonMonotoneSeries: string[];
}

/** Map an engine timeline onto a boundary series. The cumulative used for payback
 * composition is cumulativePaymentNetRevenue — the same series the engine tests
 * against trafficCashOutflow for its own payback. */
export function buildBoundarySeries(
  id: string,
  periods: ReadonlyArray<ForecastPeriodRow>,
  startDayOffset = 0,
): DayGridSeries {
  return {
    id,
    startDayOffset,
    boundaries: periods.map((period) => ({
      dayEnd: period.dayEnd,
      cumulative: period.cumulativePaymentNetRevenue,
    })),
  };
}

/** Stack N step functions on the union of their boundary days.
 *
 * Exact by construction: the union of boundaries is precisely the set of days on
 * which any series changes value, so evaluating at those days loses nothing and
 * interpolates nothing. Implemented as one merge walk — a cursor per series
 * advances as the day increases — O(Σ boundaries + grid). */
export function stackDayGrid(series: ReadonlyArray<DayGridSeries>): StackedDayGrid {
  const nonMonotoneSeries: string[] = [];
  const endedSeries: Array<{ id: string; lastDay: number }> = [];

  const daySet = new Set<number>([0]);
  for (const s of series) {
    let previous = -Infinity;
    for (const boundary of s.boundaries) {
      daySet.add(s.startDayOffset + boundary.dayEnd);
      if (boundary.cumulative < previous - 1e-9 && !nonMonotoneSeries.includes(s.id)) {
        nonMonotoneSeries.push(s.id);
      }
      previous = boundary.cumulative;
    }
  }
  const days = [...daySet].sort((a, b) => a - b);

  const lastDays = series.map((s) =>
    s.boundaries.length > 0 ? s.startDayOffset + s.boundaries[s.boundaries.length - 1].dayEnd : s.startDayOffset,
  );
  const shortestHorizonDay = series.length > 0 ? Math.min(...lastDays) : 0;
  const longestHorizonDay = series.length > 0 ? Math.max(...lastDays) : 0;
  for (let index = 0; index < series.length; index += 1) {
    if (lastDays[index] < longestHorizonDay) {
      endedSeries.push({ id: series[index].id, lastDay: lastDays[index] });
    }
  }

  const cursors = new Array<number>(series.length).fill(-1);
  const points: StackedDayGridPoint[] = days.map((day) => {
    let total = 0;
    let contributing = 0;
    for (let index = 0; index < series.length; index += 1) {
      const s = series[index];
      let cursor = cursors[index];
      while (
        cursor + 1 < s.boundaries.length &&
        s.startDayOffset + s.boundaries[cursor + 1].dayEnd <= day
      ) {
        cursor += 1;
      }
      cursors[index] = cursor;
      if (cursor >= 0) total += s.boundaries[cursor].cumulative;
      if (day <= lastDays[index]) contributing += 1;
    }
    return { day, total, contributing };
  });

  return { points, shortestHorizonDay, longestHorizonDay, endedSeries, nonMonotoneSeries };
}

/** First grid day whose stacked total reaches `threshold`; null when it never does
 * (or when the threshold itself is unknowable — the caller passes null through). */
export function stackedCrossingDay(grid: StackedDayGrid, threshold: number | null): number | null {
  if (threshold === null) return null;
  const index = firstCrossingIndex(grid.points.map((point) => point.total), threshold);
  return index === null ? null : grid.points[index].day;
}
