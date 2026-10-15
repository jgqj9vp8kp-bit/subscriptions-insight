// Row model of the Dashboard "Daily trials" card (services/trialsDailyView.ts):
// the fold keeps 8 rows + Other + Unknown and every sum, the change badge
// compares complete days only and colours only significant moves, the heat
// steps, the on-screen week fold (the server's week rule) and the country labels.
import { describe, expect, it } from "vitest";
import {
  buildTrialsMatrixView,
  foldAxisToWeeks,
  formatTrialsCell,
  formatTrialsCutoff,
  formatTrialsDay,
  formatTrialsRange,
  heatStep,
  trialsDayLeaders,
  trialsDelta,
  trialsMatrixCsv,
  trialsRowMax,
  trialsSpanDays,
  TRIALS_TOP_N,
} from "@/services/trialsDailyView";
import { countryLabel, isNonStandardCountryCode } from "@/services/countryNames";
import type { RevenueTrialsRow, TrialsBucketState } from "@/services/revenueIntelligence";

const COMPLETE3: TrialsBucketState[] = ["complete", "complete", "complete"];

function row(key: string, cells: number[], prev = 0): RevenueTrialsRow {
  return { key, trials: cells.reduce((sum, value) => sum + value, 0), prev_trials: prev, cells, mix: [], mix_unknown: 0 };
}

/** 12 funnels (trials 12..1 per day) and the Unknown row. */
const ROWS: RevenueTrialsRow[] = [
  ...Array.from({ length: 12 }, (_value, index) => row(`path-${String(index + 1).padStart(2, "0")}`, [12 - index, 12 - index, 12 - index], 30 - index)),
  row("Unknown", [2, 1, 0], 4),
];

const sumOf = (rows: readonly RevenueTrialsRow[], pick: (row: RevenueTrialsRow) => number) => rows.reduce((sum, entry) => sum + pick(entry), 0);

describe("buildTrialsMatrixView", () => {
  it("folds to the top 8 + Other + Unknown and keeps every sum", () => {
    const view = buildTrialsMatrixView(ROWS, COMPLETE3, "day", 3, { key: "trials", dir: "desc" }, false);
    expect(view.visible).toHaveLength(TRIALS_TOP_N);
    expect(view.visible.map((entry) => entry.key)).toEqual(["path-01", "path-02", "path-03", "path-04", "path-05", "path-06", "path-07", "path-08"]);
    expect(view.other).toMatchObject({ key: "Other", count: 4, cells: [10, 10, 10], trials: 30, prev_trials: 19 + 20 + 21 + 22, mix: [] });
    expect(view.pinned.map((entry) => entry.key)).toEqual(["Unknown"]);
    expect(view.count).toBe(12);
    const onScreen = [...view.visible, view.other!, ...view.pinned];
    expect(onScreen).toHaveLength(10);
    expect(sumOf(onScreen, (entry) => entry.trials)).toBe(sumOf(ROWS, (entry) => entry.trials));
    expect(sumOf(onScreen, (entry) => entry.prev_trials)).toBe(sumOf(ROWS, (entry) => entry.prev_trials));
    for (const index of [0, 1, 2]) expect(sumOf(onScreen, (entry) => entry.cells[index])).toBe(sumOf(ROWS, (entry) => entry.cells[index]));
  });

  it("expanded shows every row; Unknown is pinned last and never folded or ranked", () => {
    const view = buildTrialsMatrixView(ROWS, COMPLETE3, "day", 3, { key: "key", dir: "desc" }, true);
    expect(view.other).toBeNull();
    expect(view.visible).toHaveLength(12);
    expect(view.visible[0].key).toBe("path-12");
    expect(view.pinned.map((entry) => entry.key)).toEqual(["Unknown"]);
  });

  it("folding one row into Other saves nothing: 9 ranked rows stay unfolded", () => {
    const nine = ROWS.slice(0, 9);
    expect(buildTrialsMatrixView(nine, COMPLETE3, "day", 3, { key: "trials", dir: "desc" }, false).other).toBeNull();
    expect(buildTrialsMatrixView(ROWS.slice(0, 10), COMPLETE3, "day", 3, { key: "trials", dir: "desc" }, false).other?.count).toBe(2);
  });

  it("Δ sort: by percent, stopped counts as −100 %, new and — last in either direction, ties by key", () => {
    const rows = [
      row("up", [10, 10, 10], 15), // +100 %
      row("down", [2, 2, 2], 12), // −50 %
      row("stopped", [0, 0, 0], 30),
      row("new", [5, 0, 0], 0),
      row("flat-b", [3, 3, 3], 9),
      row("flat-a", [3, 3, 3], 9),
    ];
    const asc = buildTrialsMatrixView(rows, COMPLETE3, "day", 3, { key: "delta", dir: "asc" }, true).visible.map((entry) => entry.key);
    expect(asc).toEqual(["stopped", "down", "flat-a", "flat-b", "up", "new"]);
    const desc = buildTrialsMatrixView(rows, COMPLETE3, "day", 3, { key: "delta", dir: "desc" }, true).visible.map((entry) => entry.key);
    expect(desc).toEqual(["up", "flat-a", "flat-b", "down", "stopped", "new"]);
  });
});

describe("trialsDelta", () => {
  it("compares complete buckets only: a partial today is never a fake drop", () => {
    const delta = trialsDelta(row("a", [10, 10, 1]), ["complete", "complete", "partial"], "day", 3);
    expect(delta).toMatchObject({ completeDays: 2, actual: 20 });
    const withPrev = trialsDelta({ cells: [10, 10, 1], prev_trials: 30 }, ["complete", "complete", "partial"], "day", 3);
    expect(withPrev.expected).toBe(20);
    expect(withPrev).toMatchObject({ kind: "pct", pct: 0, significant: false });
  });

  it("none without a complete bucket; new / none without a previous window; stopped from expected ≥ 3", () => {
    expect(trialsDelta({ cells: [5], prev_trials: 9 }, ["partial"], "day", 1).kind).toBe("none");
    expect(trialsDelta({ cells: [5, 0], prev_trials: 0 }, ["complete", "complete"], "day", 2).kind).toBe("new");
    expect(trialsDelta({ cells: [0, 0], prev_trials: 0 }, ["complete", "complete"], "day", 2).kind).toBe("none");
    expect(trialsDelta({ cells: [0, 0, 0], prev_trials: 9 }, COMPLETE3, "day", 3)).toMatchObject({ kind: "stopped", pct: -1, expected: 9 });
    // Expected below 3: a plain percentage, not "stopped".
    expect(trialsDelta({ cells: [0, 0, 0], prev_trials: 2 }, COMPLETE3, "day", 3)).toMatchObject({ kind: "pct", pct: -1, significant: false });
  });

  it("significant only when |z| ≥ 2 and the gap is ≥ 3 trials", () => {
    // expected 9, actual 18: z = 3, gap 9 → significant.
    expect(trialsDelta({ cells: [6, 6, 6], prev_trials: 9 }, COMPLETE3, "day", 3)).toMatchObject({ pct: 1, z: 3, significant: true });
    // expected 1, actual 3: z = 2 but the gap is 2 → muted.
    expect(trialsDelta({ cells: [1, 1, 1], prev_trials: 1 }, COMPLETE3, "day", 3)).toMatchObject({ pct: 2, significant: false });
    // expected 100, actual 110: gap 10 but z = 1 → muted.
    expect(trialsDelta({ cells: [40, 40, 30], prev_trials: 100 }, COMPLETE3, "day", 3)).toMatchObject({ z: 1, significant: false });
  });

  it("week buckets count 7 days each against the previous window's daily rate", () => {
    const delta = trialsDelta({ cells: [70, 35], prev_trials: 140 }, ["complete", "partial"], "week", 14);
    expect(delta).toMatchObject({ completeDays: 7, actual: 70, expected: 70, kind: "pct", pct: 0 });
  });
});

describe("heat steps", () => {
  it("0 for an empty cell, else 1..5 of the row's busiest complete / partial bucket", () => {
    expect(heatStep(0, 10)).toBe(0);
    expect(heatStep(5, 0)).toBe(0);
    expect(heatStep(1, 100)).toBe(1);
    expect(heatStep(20, 100)).toBe(1);
    expect(heatStep(21, 100)).toBe(2);
    expect(heatStep(60, 100)).toBe(3);
    expect(heatStep(61, 100)).toBe(4);
    expect(heatStep(100, 100)).toBe(5);
    expect(heatStep(150, 100)).toBe(5);
    expect(trialsRowMax([3, 9, 50], ["complete", "partial", "no_data"])).toBe(9);
  });
});

describe("foldAxisToWeeks", () => {
  it("folds ISO weeks and sums every series; a week with a cut-off day is partial, as on the server", () => {
    // Sat 10-10 .. Thu 10-15: [Sat, Sun] | [Mon .. Thu].
    const axis = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
    const state: TrialsBucketState[] = ["complete", "complete", "complete", "partial", "no_data", "no_data"];
    const folded = foldAxisToWeeks(axis, state, [[1, 2, 3, 4, 0, 0], [0, 1, 0, 0, 0, 0]]);
    expect(folded.axis).toEqual(["2026-10-10", "2026-10-12"]);
    expect(folded.ends).toEqual(["2026-10-11", "2026-10-15"]);
    expect(folded.groups).toEqual([[0, 1], [2, 3, 4, 5]]);
    // Not no_data: the newest week holds real trials (the server's week rule says partial too).
    expect(folded.axisState).toEqual(["complete", "partial"]);
    // The heat / bar scale divides by the days with data: 2 and 2 (Mon, Tue).
    expect(folded.dataDays).toEqual([2, 2]);
    expect(folded.series).toEqual([[3, 7], [1, 0]]);
    expect(foldAxisToWeeks(axis.slice(0, 4), state.slice(0, 4), []).axisState).toEqual(["complete", "partial"]);
  });

  it("complete only when every day is, no_data only when no day has data, partial otherwise", () => {
    const week = ["2026-10-12", "2026-10-13", "2026-10-14"];
    const stateOf = (states: TrialsBucketState[]) => foldAxisToWeeks(week, states, []).axisState;
    expect(stateOf(["complete", "complete", "complete"])).toEqual(["complete"]);
    expect(stateOf(["complete", "complete", "no_data"])).toEqual(["partial"]);
    expect(stateOf(["partial", "no_data", "no_data"])).toEqual(["partial"]);
    expect(stateOf(["no_data", "no_data", "no_data"])).toEqual(["no_data"]);
    expect(foldAxisToWeeks(week, ["no_data", "no_data", "no_data"], []).dataDays).toEqual([1]);
  });
});

describe("pinned day, CSV and formatting", () => {
  it("names the rows with the most trials in the pinned column", () => {
    expect(trialsDayLeaders(ROWS, [0])).toEqual([{ key: "path-01", trials: 12 }, { key: "path-02", trials: 11 }, { key: "path-03", trials: 10 }]);
    expect(trialsDayLeaders([row("a", [0, 2]), row("b", [0, 2])], [1], 3)).toEqual([{ key: "a", trials: 2 }, { key: "b", trials: 2 }]);
  });

  it("CSV: Key, one column per bucket, Total, Previous, Δ %", () => {
    const view = buildTrialsMatrixView([row("path-a", [6, 6, 6], 9), row("path-b", [0, 0, 0], 9), row("path-new", [1, 0, 0])], COMPLETE3, "day", 3, { key: "trials", dir: "desc" }, true);
    const table = trialsMatrixCsv(view.visible, ["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(table.headers).toEqual(["Key", "2026-10-01", "2026-10-02", "2026-10-03", "Total", "Previous", "Δ %"]);
    expect(table.rows).toEqual([
      ["path-a", 6, 6, 6, 18, 9, 100],
      ["path-new", 1, 0, 0, 1, 0, "new"],
      ["path-b", 0, 0, 0, 0, 9, "stopped"],
    ]);
  });

  it("whole numbers, 1.2k from 1000, and never a raw YYYY-MM-DD", () => {
    expect(formatTrialsCell(37)).toBe("37");
    expect(formatTrialsCell(1234)).toBe("1.2k");
    expect(formatTrialsDay("2026-10-05")).toBe("Oct 5");
    expect(formatTrialsRange("2026-10-05", "2026-10-11")).toBe("Oct 5–11");
    expect(formatTrialsRange("2026-09-28", "2026-10-04")).toBe("Sep 28–Oct 4");
    expect(formatTrialsCutoff("2026-10-13T14:20:05.000Z")).toBe("Oct 13, 14:20 UTC");
    expect(trialsSpanDays("2026-09-16", "2026-10-15")).toBe(30);
  });
});

describe("countryLabel", () => {
  it("English names for upper-case alpha-2 codes; Unknown and non-standard codes unchanged", () => {
    expect(countryLabel("MX")).toBe("MX · Mexico");
    expect(countryLabel("US")).toBe("US · United States");
    expect(countryLabel("Unknown")).toBe("Unknown");
    expect(countryLabel("us")).toBe("us");
    expect(countryLabel("USA")).toBe("USA");
    expect(isNonStandardCountryCode("us")).toBe(true);
    expect(isNonStandardCountryCode("MX")).toBe(false);
    expect(isNonStandardCountryCode("Unknown")).toBe(false);
  });
});
