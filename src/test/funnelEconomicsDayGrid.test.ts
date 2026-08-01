// Day-axis stacking (Project Forecasting P1).
//
// The grid is the foundation the 1-funnel parity invariant stands on: it steps at
// period END because the engine credits payback at rows[i].dayEnd — stepping at
// dayStart would make a 1-funnel project disagree with that funnel's own payback
// day. Cross-cadence sums join on days, never on period indices (a weekly P4 is
// day 35; a monthly P4 is day 150).
import { describe, expect, it } from "vitest";
import {
  buildBoundarySeries,
  stackDayGrid,
  stackedCrossingDay,
  type DayGridSeries,
} from "@/services/funnelEconomics";

function series(id: string, boundaries: Array<[day: number, cumulative: number]>, startDayOffset = 0): DayGridSeries {
  return { id, startDayOffset, boundaries: boundaries.map(([dayEnd, cumulative]) => ({ dayEnd, cumulative })) };
}

describe("stackDayGrid", () => {
  it("builds the union of boundary days plus day 0", () => {
    const grid = stackDayGrid([
      series("monthly", [[30, 100], [60, 180]]),
      series("weekly", [[7, 10], [14, 25], [21, 45], [28, 70]]),
    ]);
    expect(grid.points.map((point) => point.day)).toEqual([0, 7, 14, 21, 28, 30, 60]);
  });

  it("invariant 6: monthly contributes ZERO before its first boundary — no interpolation", () => {
    const monthly = series("m", [[30, 300], [60, 500]]);
    const weekly = series("w", [[7, 10], [14, 25], [21, 45], [28, 70], [35, 90]]);
    const grid = stackDayGrid([monthly, weekly]);
    const at = (day: number) => grid.points.find((point) => point.day === day)!.total;
    // Before day 30 the monthly step has not fired: the stack is the weekly value alone.
    expect(at(7)).toBe(10);
    expect(at(14)).toBe(25);
    expect(at(21)).toBe(45);
    // At day 30 the monthly first period lands; the weekly's last boundary ≤ 30 is day 28.
    expect(at(30)).toBe(300 + 70);
    // At day 35: monthly holds its day-30 value, weekly steps to 90.
    expect(at(35)).toBe(300 + 90);
    expect(at(60)).toBe(500 + 90);
  });

  it("holds the last value past a series' horizon instead of nulling or extrapolating", () => {
    const short = series("short", [[7, 40]]);
    const long = series("long", [[30, 100], [60, 200]]);
    const grid = stackDayGrid([short, long]);
    const last = grid.points[grid.points.length - 1];
    expect(last.day).toBe(60);
    expect(last.total).toBe(40 + 200);
    expect(grid.shortestHorizonDay).toBe(7);
    expect(grid.longestHorizonDay).toBe(60);
    expect(grid.endedSeries).toEqual([{ id: "short", lastDay: 7 }]);
  });

  it("flags a series whose cumulative decreases — payback semantics are meaningless there", () => {
    const bad = series("bad", [[30, 100], [60, 80]]);
    const good = series("good", [[30, 50]]);
    const grid = stackDayGrid([bad, good]);
    expect(grid.nonMonotoneSeries).toEqual(["bad"]);
  });

  it("applies startDayOffset to every boundary (v2 calendar seam, always 0 in v1)", () => {
    const offset = series("late", [[30, 100]], 15);
    const grid = stackDayGrid([offset]);
    expect(grid.points.map((point) => point.day)).toEqual([0, 45]);
    expect(grid.points[1].total).toBe(100);
  });

  it("is deterministic under series order", () => {
    const a = series("a", [[7, 10], [14, 30]]);
    const b = series("b", [[30, 200]]);
    expect(stackDayGrid([a, b])).toEqual(stackDayGrid([b, a]));
  });
});

describe("stackedCrossingDay", () => {
  it("returns the first grid day whose stacked total reaches the threshold", () => {
    const grid = stackDayGrid([
      series("m", [[30, 300], [60, 700]]),
      series("w", [[7, 100], [14, 260], [21, 380]]),
    ]);
    // Totals: d7=100, d14=260, d21=380, d30=680, d60=1080.
    expect(stackedCrossingDay(grid, 650)).toBe(30);
    expect(stackedCrossingDay(grid, 1080)).toBe(60);
    expect(stackedCrossingDay(grid, 2000)).toBeNull();
  });

  it("passes an unknowable (null) threshold through as null", () => {
    const grid = stackDayGrid([series("m", [[30, 300]])]);
    expect(stackedCrossingDay(grid, null)).toBeNull();
  });
});

describe("buildBoundarySeries", () => {
  it("maps timeline periods onto dayEnd boundaries carrying cumulativePaymentNetRevenue", () => {
    const built = buildBoundarySeries("f", [
      {
        index: 0, label: "Trial", dayStart: 0, dayEnd: 30, users: 100, survival: 1, cumulativeRetention: 1,
        revenue: { trial: 100, subscription: 0, upsell: 0, token: 0, gross: 100 },
        costs: { stripe: 7, refund: 10, provider: 5, paymentTotal: 22 },
        paymentNetRevenue: 78, cumulativePaymentNetRevenue: 78, cashFlowBalance: -922,
      },
      {
        index: 1, label: "M1", dayStart: 30, dayEnd: 60, users: 40, survival: 0.4, cumulativeRetention: 0.4,
        revenue: { trial: 0, subscription: 1200, upsell: 0, token: 0, gross: 1200 },
        costs: { stripe: 84, refund: 120, provider: 59, paymentTotal: 263 },
        paymentNetRevenue: 937, cumulativePaymentNetRevenue: 1015, cashFlowBalance: 15,
      },
    ]);
    expect(built.boundaries).toEqual([
      { dayEnd: 30, cumulative: 78 },
      { dayEnd: 60, cumulative: 1015 },
    ]);
  });
});
