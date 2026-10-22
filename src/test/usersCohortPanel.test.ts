import { describe, expect, it } from "vitest";
import { todayUtc } from "@/components/payment-health/format";
import { NO_PRODUCT_PATH, type CohortProductOption } from "@/services/cohortProductFilter";
import {
  MAX_SELECTED_COHORTS,
  addCohorts,
  cohortPathFromId,
  filterRowsByPaths,
  filterRowsByPeriod,
  funnelOptions,
  groupCohorts,
  groupSelectionState,
  isDay,
  isPeriodPreset,
  mergeLegacySelection,
  migratePeriodSelection,
  pathScope,
  periodLabel,
  periodPatch,
  periodProblem,
  productTrialCounts,
  pruneCohortSelection,
  removeCohorts,
  resolvePeriodRange,
  usersCampaignPaths,
  type CohortExplorerRow,
  type PeriodSelection,
} from "@/services/usersCohortPanel";

const TODAY = "2026-10-22";
const sel = (preset: PeriodSelection["preset"], from = "", to = ""): PeriodSelection => ({ preset, from, to });

function row(over: Partial<CohortExplorerRow> & Pick<CohortExplorerRow, "campaign_path" | "cohort_date">): CohortExplorerRow {
  const funnel = over.funnel ?? "soulmate";
  return {
    cohort_id: over.cohort_id ?? `${funnel}_${over.campaign_path}_${over.cohort_date}`,
    funnel,
    trial_users: 1,
    net_revenue: 0,
    ...over,
  };
}

function product(project_id: string, campaign_paths: string[], over: Partial<CohortProductOption> = {}): CohortProductOption {
  return { project_id, label: project_id || "Unknown", host: "", trial_count: 999, campaign_paths, ...over };
}

describe("period", () => {
  it("validates days and presets", () => {
    expect(isDay("2026-10-22")).toBe(true);
    expect(isDay("2026-10-2")).toBe(false);
    expect(isDay(null)).toBe(false);
    expect(isPeriodPreset("30d")).toBe(true);
    expect(isPeriodPreset("90d")).toBe(false);
    expect(isPeriodPreset("")).toBe(false);
  });

  it("resolves the presets as inclusive UTC windows ending today", () => {
    expect(resolvePeriodRange(sel("7d"), TODAY)).toEqual({ from: "2026-10-16", to: TODAY });
    expect(resolvePeriodRange(sel("14d"), TODAY)).toEqual({ from: "2026-10-09", to: TODAY });
    expect(resolvePeriodRange(sel("30d"), TODAY)).toEqual({ from: "2026-09-23", to: TODAY });
    expect(resolvePeriodRange(sel("month"), TODAY)).toEqual({ from: "2026-10-01", to: TODAY });
    expect(resolvePeriodRange(sel("all"), TODAY)).toEqual({ from: null, to: null });
    // A preset ignores stale custom days.
    expect(resolvePeriodRange(sel("7d", "2020-01-01", "2020-01-02"), TODAY)).toEqual({ from: "2026-10-16", to: TODAY });
  });

  it("resolves a custom range side by side, dropping invalid days", () => {
    expect(resolvePeriodRange(sel("custom", "2026-04-01", "2026-04-14"), TODAY)).toEqual({ from: "2026-04-01", to: "2026-04-14" });
    expect(resolvePeriodRange(sel("custom", "", "2026-04-14"), TODAY)).toEqual({ from: null, to: "2026-04-14" });
    expect(resolvePeriodRange(sel("custom", "14.04.2026", "nope"), TODAY)).toEqual({ from: null, to: null });
  });

  it("today is the UTC day, not the local one", () => {
    expect(todayUtc(new Date("2026-10-22T23:30:00-05:00"))).toBe("2026-10-23");
  });

  it("migrates the legacy ranges: first trial beats cohort date, an explicit preset beats both", () => {
    expect(migratePeriodSelection({ firstTrialTo: "2026-04-14" })).toEqual(sel("custom", "", "2026-04-14"));
    expect(migratePeriodSelection({ firstTrialFrom: "2026-04-01", cohortDateFrom: "2026-01-01", cohortDateTo: "2026-01-31" }))
      .toEqual(sel("custom", "2026-04-01", ""));
    expect(migratePeriodSelection({ periodPreset: "", cohortDateFrom: "2026-01-01", cohortDateTo: "2026-01-31" }))
      .toEqual(sel("custom", "2026-01-01", "2026-01-31"));
    expect(migratePeriodSelection({ periodPreset: "garbage", firstTrialFrom: "yesterday", cohortDateTo: 5 })).toEqual(sel("all"));
    expect(migratePeriodSelection({})).toEqual(sel("all"));
    expect(migratePeriodSelection({ periodPreset: "30d", periodFrom: "2026-01-01", firstTrialFrom: "2026-04-01" })).toEqual(sel("30d"));
    expect(migratePeriodSelection({ periodPreset: "custom", periodFrom: "2026-02-01", periodTo: "bad", firstTrialTo: "2026-04-01" }))
      .toEqual(sel("custom", "2026-02-01", ""));
  });

  it("a period write blanks the legacy keys; an empty custom range is stored as all", () => {
    const blanks = { firstTrialFrom: "", firstTrialTo: "", cohortDateFrom: "", cohortDateTo: "" };
    expect(periodPatch(sel("custom", "2026-04-01", ""))).toEqual({ periodPreset: "custom", periodFrom: "2026-04-01", periodTo: "", ...blanks });
    expect(periodPatch(sel("custom", "", ""))).toEqual({ periodPreset: "all", periodFrom: "", periodTo: "", ...blanks });
    expect(periodPatch(sel("7d", "2026-04-01", "2026-04-02"))).toEqual({ periodPreset: "7d", periodFrom: "", periodTo: "", ...blanks });
  });

  it("labels the period for its chip and flags an inverted range", () => {
    expect(periodLabel(sel("all"), { from: null, to: null })).toBeNull();
    expect(periodLabel(sel("7d"), resolvePeriodRange(sel("7d"), TODAY))).toBe("Last 7 days");
    expect(periodLabel(sel("month"), resolvePeriodRange(sel("month"), TODAY))).toBe("This month");
    expect(periodLabel(sel("custom"), { from: "2026-04-01", to: "2026-04-14" })).toBe("01.04.2026 – 14.04.2026");
    expect(periodLabel(sel("custom"), { from: "2026-04-01", to: null })).toBe("from 01.04.2026");
    expect(periodLabel(sel("custom"), { from: null, to: "2026-04-14" })).toBe("to 14.04.2026");
    expect(periodProblem({ from: "2026-04-15", to: "2026-04-14" })).toBe("Start date is after end date.");
    expect(periodProblem({ from: "2026-04-14", to: "2026-04-14" })).toBeNull();
    expect(periodProblem({ from: "2026-04-15", to: null })).toBeNull();
  });

  it("filters rows by the cohort day", () => {
    const rows = [row({ campaign_path: "a", cohort_date: "2026-04-01" }), row({ campaign_path: "a", cohort_date: "2026-04-10" })];
    expect(filterRowsByPeriod(rows, { from: null, to: null })).toHaveLength(2);
    expect(filterRowsByPeriod(rows, { from: "2026-04-02", to: null }).map((r) => r.cohort_date)).toEqual(["2026-04-10"]);
    expect(filterRowsByPeriod(rows, { from: null, to: "2026-04-01" }).map((r) => r.cohort_date)).toEqual(["2026-04-01"]);
  });
});

describe("selections", () => {
  it("merges a multi-select with its legacy single key", () => {
    expect(mergeLegacySelection([" b ", "a", "all", "", "a"], "c")).toEqual(["a", "b", "c"]);
    expect(mergeLegacySelection(undefined, "all")).toEqual([]);
    expect(mergeLegacySelection("not-an-array", null)).toEqual([]);
  });

  it("counts trial users per product from the filtered cohorts, never product.trial_count", () => {
    const rows = [
      row({ campaign_path: "a1", cohort_date: "2026-04-01", trial_users: 5 }),
      row({ campaign_path: "a2", cohort_date: "2026-04-01", trial_users: 3 }),
      row({ campaign_path: "shared", cohort_date: "2026-04-02", trial_users: 2 }),
      row({ campaign_path: "orphan", cohort_date: "2026-04-02", trial_users: 4 }),
    ];
    const products = [product("azora", ["a1", "a2", "a2", "shared"]), product("brainza", ["shared", "b1"]), product("", ["unknown"])];
    const counts = productTrialCounts(rows, products);
    expect(counts.all).toBe(14);
    expect(counts.byKey.get("azora")).toBe(10); // deduped paths; shared counted here…
    expect(counts.byKey.get("brainza")).toBe(2); // …and here too
    expect(counts.byKey.get("unknown")).toBe(0);
  });

  it("lists funnel options of the selected products, keeps a selected path at 0, busiest first", () => {
    const rows = [
      row({ campaign_path: "a1", cohort_date: "2026-04-01", trial_users: 2 }),
      row({ campaign_path: "a1", cohort_date: "2026-04-02", trial_users: 2 }),
      row({ campaign_path: "a2", cohort_date: "2026-04-01", trial_users: 4 }),
      row({ campaign_path: "a3", cohort_date: "2026-04-01", trial_users: 1 }),
      row({ campaign_path: "b1", cohort_date: "2026-04-01", trial_users: 9 }),
    ];
    expect(funnelOptions(rows, null, [])).toEqual([
      { path: "b1", trialUsers: 9 },
      { path: "a1", trialUsers: 4 },
      { path: "a2", trialUsers: 4 },
      { path: "a3", trialUsers: 1 },
    ]);
    expect(funnelOptions(rows, new Set(["a1", "a3"]), ["gone"])).toEqual([
      { path: "a1", trialUsers: 4 },
      { path: "a3", trialUsers: 1 },
      { path: "gone", trialUsers: 0 },
    ]);
  });

  it("filters rows by a path scope; the no-overlap sentinel matches nothing", () => {
    const rows = [row({ campaign_path: "a", cohort_date: "2026-04-01" }), row({ campaign_path: "b", cohort_date: "2026-04-01" })];
    expect(pathScope([])).toBeNull();
    expect(filterRowsByPaths(rows, null)).toHaveLength(2);
    expect(filterRowsByPaths(rows, pathScope(["b"])).map((r) => r.campaign_path)).toEqual(["b"]);
    expect(filterRowsByPaths(rows, pathScope([NO_PRODUCT_PATH]))).toEqual([]);
  });

  it("adds within the cap and refuses past it", () => {
    expect(addCohorts(["a", "b"], ["b", "c"])).toEqual({ ids: ["a", "b", "c"], capped: false });
    const many = Array.from({ length: MAX_SELECTED_COHORTS - 1 }, (_, i) => `c${i}`);
    expect(addCohorts(many, ["x"])).toEqual({ ids: [...many, "x"], capped: false }); // 500 ok
    expect(addCohorts(many, ["x", "y"])).toEqual({ ids: many, capped: true }); // 501 capped
    expect(removeCohorts(["a", "b", "c"], ["b", "z"])).toEqual(["a", "c"]);
  });

  it("reads the path from server and legacy cohort ids", () => {
    expect(cohortPathFromId("soulmate_brainza-quiz_2026-04-01")).toBe("brainza-quiz");
    expect(cohortPathFromId("past_life_p_x_2026-04-01")).toBe("p_x");
    expect(cohortPathFromId("unknown_unknown_2026-04-01")).toBe("unknown");
    expect(cohortPathFromId("campaign-a_2026-04-01")).toBe("campaign-a");
    expect(cohortPathFromId("no-date-here")).toBeNull();
    expect(cohortPathFromId("_2026-04-01")).toBeNull();
  });

  it("prunes a selection to the path scope, keeping ids it cannot place", () => {
    const pathById = new Map([["listed", "b1"]]);
    const selected = ["soulmate_a1_2026-04-01", "listed", "soulmate_a2_2026-04-01", "no-date"];
    expect(pruneCohortSelection(selected, null, pathById)).toEqual(selected);
    expect(pruneCohortSelection(selected, new Set(["a1"]), pathById)).toEqual(["soulmate_a1_2026-04-01", "no-date"]);
    expect(pruneCohortSelection(selected, new Set(["b1"]), pathById)).toEqual(["listed", "no-date"]);
  });

  it("a cohort selection wins over the panel paths for the users", () => {
    expect(usersCampaignPaths([], ["a", "b"])).toEqual(["a", "b"]);
    expect(usersCampaignPaths(["x_2026-04-01"], ["a", "b"])).toEqual([]);
  });
});

describe("groupCohorts", () => {
  const rows = [
    row({ campaign_path: "p1", cohort_date: "2026-04-01", trial_users: 3, net_revenue: 30 }),
    row({ campaign_path: "p1", cohort_date: "2026-04-03", trial_users: 1, net_revenue: 50 }),
    row({ campaign_path: "p2", cohort_date: "2026-04-02", trial_users: 5, net_revenue: 10 }),
    // Same path and date under a second family: one group, two children.
    row({ campaign_path: "p2", cohort_date: "2026-04-02", funnel: "past_life", trial_users: 2, net_revenue: 5 }),
  ];

  it("groups by path with sums, the latest date and family notes only where needed", () => {
    const groups = groupCohorts(rows, "funnel", "date", "desc");
    expect(groups.map((g) => g.key)).toEqual(["p1", "p2"]); // latest 04-03 before 04-02
    const [p1, p2] = groups;
    expect(p1).toMatchObject({ label: "p1", trialUsers: 4, netRevenue: 80, latestDate: "2026-04-03" });
    expect(p1.children.map((c) => [c.label, c.note])).toEqual([["03.04.2026", null], ["01.04.2026", null]]);
    expect(p2).toMatchObject({ trialUsers: 7, netRevenue: 15, latestDate: "2026-04-02" });
    expect(p2.children.map((c) => [c.label, c.note])).toEqual([["02.04.2026", "soulmate"], ["02.04.2026", "past life"]]);
  });

  it("sorts groups and children by each key in both directions", () => {
    expect(groupCohorts(rows, "funnel", "date", "asc").map((g) => g.key)).toEqual(["p2", "p1"]);
    expect(groupCohorts(rows, "funnel", "trial_users", "desc").map((g) => g.key)).toEqual(["p2", "p1"]);
    expect(groupCohorts(rows, "funnel", "trial_users", "asc").map((g) => g.key)).toEqual(["p1", "p2"]);
    expect(groupCohorts(rows, "funnel", "net_revenue", "desc").map((g) => g.key)).toEqual(["p1", "p2"]);
    const byRevenueAsc = groupCohorts(rows, "funnel", "net_revenue", "asc");
    expect(byRevenueAsc.map((g) => g.key)).toEqual(["p2", "p1"]);
    expect(byRevenueAsc[1].children.map((c) => c.cohort.net_revenue)).toEqual([30, 50]);
    expect(groupCohorts(rows, "funnel", "trial_users", "asc")[0].children.map((c) => c.cohort.trial_users)).toEqual([1, 3]);
    expect(groupCohorts(rows, "funnel", "date", "asc")[1].children.map((c) => c.cohort.cohort_date)).toEqual(["2026-04-01", "2026-04-03"]);
    // Tie on the sort value: label A→Z.
    const tied = [row({ campaign_path: "zz", cohort_date: "2026-04-01" }), row({ campaign_path: "aa", cohort_date: "2026-04-01" })];
    expect(groupCohorts(tied, "funnel", "trial_users", "desc").map((g) => g.key)).toEqual(["aa", "zz"]);
  });

  it("groups by date with the funnels as children", () => {
    const groups = groupCohorts(rows, "date", "date", "desc");
    expect(groups.map((g) => g.label)).toEqual(["03.04.2026", "02.04.2026", "01.04.2026"]);
    const day2 = groups[1];
    expect(day2).toMatchObject({ key: "2026-04-02", trialUsers: 7 });
    expect(day2.children.map((c) => [c.label, c.note])).toEqual([["p2", "soulmate"], ["p2", "past life"]]);
    expect(groupCohorts(rows, "date", "date", "asc").map((g) => g.key)).toEqual(["2026-04-01", "2026-04-02", "2026-04-03"]);
    expect(groupCohorts(rows, "date", "trial_users", "desc").map((g) => g.key)).toEqual(["2026-04-02", "2026-04-01", "2026-04-03"]);
  });

  it("reports the tri-state of a group", () => {
    const [group] = groupCohorts(rows, "funnel", "date", "desc");
    const ids = group.children.map((c) => c.cohort.cohort_id);
    expect(groupSelectionState(group, new Set())).toBe(false);
    expect(groupSelectionState(group, new Set([ids[0]]))).toBe("indeterminate");
    expect(groupSelectionState(group, new Set(ids))).toBe(true);
  });
});
