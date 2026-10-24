// Payback by funnel — the pure model (src/services/ltvPayback.ts, spec
// 2026-10-24 §1–§2 and the P0 spend_through facts §10).
//
// Fixtures are cohort days with a known per-trial revenue curve f(c): a row's
// raw rev_c is trials × f(min(c, age)) — what the warehouse would hold — so a
// stationary funnel must project exactly onto f, and every number below can be
// checked by hand.
import { describe, expect, it } from "vitest";
import {
  PAYBACK_AGENCY_FEE_DEFAULT,
  PAYBACK_CHECKPOINTS,
  PAYBACK_MIN_TRIALS,
  PAYBACK_SMALL_FUNNELS_KEY,
  PAYBACK_TOTAL_KEY,
  backtestPayback,
  computePayback,
  isCohortObserved,
  lastObservedIndex,
  paybackDayOf,
  paybackLedgerWindow,
  paybackProductGroups,
  paybackRoasTint,
  paybackSpendFromLedger,
  paybackStatusOf,
  paybackStatusTone,
  paybackTrend,
  paybackTrendMonths,
  paybackTrialsThrough,
  paybackWhatIf,
  type PaybackInput,
  type PaybackLtvInput,
  type PaybackPathSpend,
  type PaybackResult,
  type PaybackRow,
  type PaybackSpendInput,
  type PaybackWindow,
} from "@/services/ltvPayback";
import { LOW_VOLUME_TRIALS_THRESHOLD } from "@/services/funnelEconomics";
import type { CohortLtvRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const DAY = 86_400_000;
const DT = "2026-10-20T12:00:00.000Z";
const C = PAYBACK_CHECKPOINTS;
const at = (day: number) => C.indexOf(day);
const NO_FEE = { enabled: false, rate: 0.04 };

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY);
}

function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) out.push(day);
  return out;
}

type Curve = (day: number) => number;
/** Monthly plan: $1 trial, $29.99 at day 3, renewals at days 33 and 63. */
const monthly: Curve = (day) => 1 + (day >= 3 ? 29.99 : 0) + (day >= 33 ? 29.99 : 0) + (day >= 63 ? 29.99 : 0);
/** Weekly plan: $1 trial, $6.99 at day 3 and every 7 days after. */
const weekly: Curve = (day) => 1 + (day >= 3 ? 6.99 * (Math.floor((day - 3) / 7) + 1) : 0);

function cohortRows(path: string, from: string, to: string, trials: number, curve: Curve, dataThrough = DT): CohortLtvRow[] {
  const lastDay = dataThrough.slice(0, 10);
  return dates(from, to).map((date) => {
    const age = daysBetween(date, lastDay);
    return { cohort_date: date, campaign_path: path, trial_users: trials, rev: C.map((day) => trials * curve(Math.min(day, age))) };
  });
}

function ltvOf(rows: CohortLtvRow[], dataThrough = DT): PaybackLtvInput {
  return { checkpoints: [...C], data_through: dataThrough, rows };
}

function spendFor(window: PaybackWindow, byPath: Record<string, number | PaybackPathSpend>, over: Partial<PaybackSpendInput> = {}, dataThrough = DT): PaybackSpendInput {
  return {
    window: paybackLedgerWindow(window, dataThrough)!,
    byPath: Object.fromEntries(Object.entries(byPath).map(([path, value]) => [path, typeof value === "number" ? { spend: value, currency: "USD", currencyMixed: false } : value])),
    unlinkedSpend: 0,
    knownGapDays: [],
    spendThrough: "2026-10-19",
    ...over,
  };
}

function rowsOf(result: PaybackResult): PaybackRow[] {
  return [...result.rows, ...(result.small?.rows ?? [])];
}

function rowOf(result: PaybackResult, path: string): PaybackRow {
  const row = rowsOf(result).find((candidate) => candidate.key === path);
  if (!row) throw new Error(`no row for ${path}`);
  return row;
}

const JULY: PaybackWindow = { from: "2026-07-01", to: "2026-07-31" };
const LAST_30: PaybackWindow = { from: "2026-09-20", to: "2026-10-19" };
/** A funnel with a long stationary history: 10 trials a day since January. */
const BIG = cohortRows("big", "2026-01-01", "2026-10-19", 10, monthly);

// ---- definitions ------------------------------------------------------------------------

describe("constants", () => {
  it("low volume is the forecasting engine's threshold; the fee default is 4 % on", () => {
    expect(PAYBACK_MIN_TRIALS).toBe(LOW_VOLUME_TRIALS_THRESHOLD);
    expect(PAYBACK_AGENCY_FEE_DEFAULT).toEqual({ enabled: true, rate: 0.04 });
  });

  it("rejects a response without the month checkpoints or with misaligned rows", () => {
    expect(() => computePayback({ ltv: { checkpoints: [0, 30, 90], data_through: DT, rows: [] }, window: JULY, spend: null })).toThrow(/checkpoint 60/);
    expect(() => computePayback({ ltv: ltvOf([{ cohort_date: "2026-07-01", campaign_path: "x", trial_users: 1, rev: [1, 2] }]), window: JULY, spend: null })).toThrow(/2 values/);
  });
});

describe("maturity: the +2 day rule", () => {
  it("a cohort day is observed at c only from its midnight + (c + 2) days", () => {
    const midnight = Date.parse("2026-07-01T00:00:00.000Z");
    expect(isCohortObserved("2026-07-01", 30, midnight + 32 * DAY - 1)).toBe(false);
    expect(isCohortObserved("2026-07-01", 30, midnight + 32 * DAY)).toBe(true);
    // The "+1" rule would call it observed a day too early: a 23:59 trial has only 30 days then.
    expect(isCohortObserved("2026-07-01", 30, midnight + 31 * DAY)).toBe(false);
    expect(lastObservedIndex("2026-07-01", midnight + 2 * DAY - 1)).toBe(-1);
    expect(lastObservedIndex("2026-07-01", midnight + 2 * DAY)).toBe(at(0));
    expect(lastObservedIndex("2026-07-01", midnight + 92 * DAY)).toBe(at(90));
    expect(lastObservedIndex("2026-07-01", midnight + 91 * DAY)).toBe(at(75));
  });

  it("drives the observed share of a cell", () => {
    // Trials of 2026-07-01 only; data_through one millisecond before day 32 → d30 still projected.
    const rows = cohortRows("big", "2026-01-01", "2026-07-01", 10, monthly, "2026-08-02T00:00:00.000Z");
    const before = computePayback({ ltv: ltvOf(rows, "2026-08-01T23:59:59.999Z"), window: { from: "2026-07-01", to: "2026-07-01" }, spend: null });
    const after = computePayback({ ltv: ltvOf(rows, "2026-08-02T00:00:00.000Z"), window: { from: "2026-07-01", to: "2026-07-01" }, spend: null });
    expect(rowOf(before, "big").months[0].observedShare).toBe(0);
    expect(rowOf(after, "big").months[0].observedShare).toBe(1);
  });
});

describe("fully mature input equals observed", () => {
  it("every cell is Σ rev / Σ trials of the rows, unprojected", () => {
    const later = "2027-06-01T00:00:00.000Z";
    const rows = [
      { cohort_date: "2026-07-01", campaign_path: "big", trial_users: 40, rev: C.map((day, index) => 40 + index * 13.37 + day) },
      { cohort_date: "2026-07-02", campaign_path: "big", trial_users: 25, rev: C.map((day, index) => 10 + index * 7.5) },
      { cohort_date: "2026-07-03", campaign_path: "big", trial_users: 15, rev: C.map((_day, index) => index * 2) },
    ];
    const result = computePayback({ ltv: ltvOf(rows, later), window: JULY, spend: null });
    const row = rowOf(result, "big");
    expect(row.trials).toBe(80);
    row.curve.forEach((point, index) => {
      const revenue = rows.reduce((sum, cohort) => sum + cohort.rev[index], 0);
      expect(point.revenue).toBeCloseTo(revenue, 9);
      expect(point.ltv).toBeCloseTo(revenue / 80, 9);
      expect(point).toMatchObject({ observedShare: 1, approx: false, source: null, poolTrials: null, rough: false });
    });
    expect(row.months.map((month) => month.day)).toEqual([30, 60, 90]);
    expect(row.months[2].breakEvenCpt).toBeCloseTo(row.months[2].ltv!, 12);
    expect(row.collected).toBeCloseTo(rows.reduce((sum, cohort) => sum + cohort.rev[C.length - 1], 0), 9);
  });

  it("weights Σ/Σ, never the mean of per-day LTVs", () => {
    const later = "2027-06-01T00:00:00.000Z";
    const rows = [
      { cohort_date: "2026-07-01", campaign_path: "big", trial_users: 10, rev: C.map((day) => (day >= 30 ? 1000 : 0)) },
      { cohort_date: "2026-07-02", campaign_path: "big", trial_users: 90, rev: C.map(() => 0) },
    ];
    const row = rowOf(computePayback({ ltv: ltvOf(rows, later), window: JULY, spend: null }), "big");
    // The mean of per-day LTVs would be (100 + 0) / 2 = 50.
    expect(row.months[0].ltv).toBe(10);
  });
});

// ---- projection ---------------------------------------------------------------------------

describe("chain ladder", () => {
  it("projects a stationary funnel exactly onto its curve, from its own pool", () => {
    const result = computePayback({ ltv: ltvOf(BIG), window: LAST_30, spend: null });
    const row = rowOf(result, "big");
    expect(row.trials).toBe(300);
    expect(row.months[0].ltv).toBeCloseTo(monthly(30), 9);
    expect(row.months[1].ltv).toBeCloseTo(monthly(60), 9);
    expect(row.months[2].ltv).toBeCloseTo(monthly(90), 9);
    for (const point of row.curve) expect(point.ltv, `d${point.day}`).toBeCloseTo(monthly(point.day), 9);
    expect(row.months[0]).toMatchObject({ source: "funnel", rough: false, approx: true, observedShare: 0, poolTrials: 1800 });
  });

  it("a partly mature window: observed rows as they are, the rest projected, the share reported", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: null }), "big");
    // Observed at d90 through 2026-07-20 (2026-10-20 − 92 days): 20 of 31 days.
    expect(row.months[2].observedShare).toBeCloseTo(20 / 31, 12);
    expect(row.months[2]).toMatchObject({ approx: true, source: "funnel", rough: false });
    expect(row.months[2].ltv).toBeCloseTo(monthly(90), 9);
    expect(row.months[1]).toMatchObject({ observedShare: 1, approx: false, source: null });
  });

  it("weekly plan: every billing step between the checkpoints projects exactly", () => {
    const rows = cohortRows("weekly", "2026-02-01", "2026-10-19", 12, weekly);
    const row = rowOf(computePayback({ ltv: ltvOf(rows), window: { from: "2026-09-01", to: "2026-10-19" }, spend: null }), "weekly");
    for (const point of row.curve) expect(point.ltv, `d${point.day}`).toBeCloseTo(weekly(point.day), 9);
    // d37 / d45 sit on weekly steps the month targets do not show (charges on days 31, 38 and 45).
    expect(row.curve[at(37)].ltv! - row.curve[at(30)].ltv!).toBeCloseTo(6.99, 9);
    expect(row.curve[at(45)].ltv! - row.curve[at(37)].ltv!).toBeCloseTo(2 * 6.99, 9);
  });

  it("a day with no observed checkpoint gets trials × the pool's LTV and counts fully projected", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: { from: "2026-10-19", to: "2026-10-19" }, spend: null }), "big");
    expect(row.curve[at(0)]).toMatchObject({ observedShare: 0, source: "funnel" });
    expect(row.curve[at(0)].ltv).toBeCloseTo(1, 12);
    expect(row.months[2].ltv).toBeCloseTo(monthly(90), 9);
  });

  it("clamps factors at >= 1 and keeps the projected curve cumulative", () => {
    // Revenue that shrinks after day 3 in the pool (late refunds): F(3→c) < 1 is clamped.
    const shrinking: Curve = (day) => (day >= 3 ? 20 : 30);
    const rows = cohortRows("refunds", "2026-02-01", "2026-10-19", 10, shrinking);
    const row = rowOf(computePayback({ ltv: ltvOf(rows), window: { from: "2026-10-10", to: "2026-10-12" }, spend: null }), "refunds");
    // Ages 8..10: observed at 3 (rev 20 per trial), never projected below that.
    expect(row.months[0].ltv).toBeCloseTo(20, 9);

    // Pools differ per checkpoint: the d30 pool holds newer, richer cohorts the
    // d37 pool does not yet have, so F(14→37) < F(14→30). The curve still never dips.
    const old: Curve = (day) => (day >= 30 ? 20 : day >= 14 ? 10 : 5);
    const rich: Curve = (day) => (day >= 30 ? 40 : day >= 14 ? 10 : 5);
    const dip = [
      ...cohortRows("dip", "2026-04-01", "2026-09-11", 10, old),
      ...cohortRows("dip", "2026-09-12", "2026-09-18", 10, rich),
      ...cohortRows("dip", "2026-10-02", "2026-10-02", 10, old),
    ];
    const young = rowOf(computePayback({ ltv: ltvOf(dip), window: { from: "2026-10-02", to: "2026-10-02" }, spend: null }), "dip");
    expect(young.curve[at(30)].revenue!).toBeGreaterThan(100 * 2);
    expect(young.curve[at(37)].revenue).toBe(young.curve[at(30)].revenue);
    for (let index = 1; index < young.curve.length; index += 1) {
      expect(young.curve[index].revenue!).toBeGreaterThanOrEqual(young.curve[index - 1].revenue!);
    }
  });
});

describe("fallback ladder: funnel → product → all, with its markers", () => {
  const products = [{ key: "p1", paths: ["big", "tiny", "tiny2"] }];
  const tiny = cohortRows("tiny", "2026-09-20", "2026-10-19", 1, monthly);
  const tiny2 = cohortRows("tiny2", "2026-07-01", "2026-07-31", 1, monthly);
  const orphan = cohortRows("orphan", "2026-09-20", "2026-10-19", 2, monthly);
  const rows = [...BIG, ...tiny, ...tiny2, ...orphan];

  it("a funnel too thin for its own pool borrows its product's; fully projected → rough", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(rows), window: LAST_30, spend: null, products }), "tiny");
    // The d30 pool of the product: big (180 days × 10) + tiny2's July (31) — tiny has none observed.
    expect(row.months[0]).toMatchObject({ source: "product", rough: true, poolTrials: 1831, observedShare: 0 });
    expect(row.months[0].ltv).toBeCloseTo(monthly(30), 9);
  });

  it("product source on a mostly observed cell is not rough", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(rows), window: JULY, spend: null, products }), "tiny2");
    expect(row.months[2].observedShare).toBeCloseTo(20 / 31, 12);
    expect(row.months[2]).toMatchObject({ source: "product", rough: false, approx: true });
    expect(row.months[1]).toMatchObject({ source: null, rough: false });
  });

  it("without a product (or for restricted viewers: no product level) the all-paths pool is used, always rough", () => {
    const withProducts = rowOf(computePayback({ ltv: ltvOf(rows), window: LAST_30, spend: null, products }), "orphan");
    expect(withProducts.months[0]).toMatchObject({ source: "all", rough: true });
    expect(withProducts.months[0].poolTrials).toBeGreaterThan(1800);
    const noProducts = rowOf(computePayback({ ltv: ltvOf(rows), window: LAST_30, spend: null }), "tiny");
    expect(noProducts.months[0]).toMatchObject({ source: "all", rough: true });
    expect(noProducts.months[0].ltv).toBeCloseTo(monthly(30), 9);
  });

  it("aggregates report the weakest source and no pool size", () => {
    const result = computePayback({ ltv: ltvOf(rows), window: LAST_30, spend: null, products });
    expect(result.total.months[0].source).toBe("all");
    expect(result.total.months[0].poolTrials).toBeNull();
  });

  it("no pool anywhere: the cell is unknown and the funnel is too early", () => {
    const lonely = cohortRows("lonely", "2026-10-01", "2026-10-19", 2, monthly);
    const row = rowOf(computePayback({ ltv: ltvOf(lonely), window: LAST_30, spend: spendFor(LAST_30, { lonely: 100 }) }), "lonely");
    expect(row.months[0].ltv).toBeNull();
    expect(row.status).toEqual({ kind: "low_volume" });
    expect(paybackStatusOf({ reasons: [], trials: 60, months: row.months })).toMatchObject({ kind: "too_early" });
  });
});

// ---- spend --------------------------------------------------------------------------------

describe("spend, CPT, ROAS and the verdict", () => {
  it("CPT = spend / trials, ROAS = Σ rev / spend, break-even = LTV, payback by interpolation", () => {
    const result = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: 15_500 }), agencyFee: NO_FEE });
    const row = rowOf(result, "big");
    expect(row).toMatchObject({ trials: 310, spendRaw: 15_500, spend: 15_500, cpt: 50, evaluated: true, trialsAfterSpendThrough: 0, noSpendReasons: [] });
    expect(row.months[0].roas).toBeCloseTo((310 * monthly(30)) / 15_500, 12);
    expect(row.months[1].roas).toBeCloseTo((310 * monthly(60)) / 15_500, 12);
    expect(row.months[1].breakEvenCpt).toBeCloseTo(monthly(60), 9);
    expect(row.status).toEqual({ kind: "month", month: 2, approx: false });
    // 50 lies between d30 (30.99) and d37 (60.98): 30 + 19.01 / 29.99 × 7 = 34.4 → day 35.
    expect(row.paybackDay).toBe(35);
    expect(paybackStatusTone(row.status)).toBe("good");
  });

  it("adds the agency fee on top of the Facebook spend (4 % by default)", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: 10_000 }) }), "big");
    expect(row.spendRaw).toBe(10_000);
    expect(row.spend).toBeCloseTo(10_400, 9);
    expect(row.cpt).toBeCloseTo(10_400 / 310, 9);
  });

  it("not within 3 months: the share of the cost back by month 3, approximate when month 3 is projected", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: 310 * 150 }), agencyFee: NO_FEE }), "big");
    expect(row.status).toMatchObject({ kind: "not_within", approx: true });
    expect((row.status as { roas: number }).roas).toBeCloseTo(monthly(90) / 150, 12);
    expect(row.paybackDay).toBeNull();
    expect(paybackStatusTone(row.status)).toBe("bad");
  });

  it("zero spend with trials is No spend data, never an infinite ROAS", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, {}) }), "big");
    expect(row.status).toEqual({ kind: "no_spend_data", reasons: ["zero_spend"] });
    expect(row).toMatchObject({ spendRaw: 0, spend: null, cpt: null, paybackDay: null });
    expect(row.months.map((month) => month.roas)).toEqual([null, null, null]);
    // The revenue side is still shown.
    expect(row.months[0].ltv).toBeCloseTo(monthly(30), 9);
  });

  it("mixed or non-USD ledger currency is No spend data", () => {
    const mixed = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: { spend: 9_000, currency: null, currencyMixed: true } }) }), "big");
    expect(mixed.status).toEqual({ kind: "no_spend_data", reasons: ["mixed_currency"] });
    const euro = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: { spend: 9_000, currency: "EUR", currencyMixed: false } }) }), "big");
    expect(euro.status).toEqual({ kind: "no_spend_data", reasons: ["non_usd_currency"] });
  });

  it("a recorded gap inside the evaluated window makes every funnel No spend data; one outside does not", () => {
    const inside = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: 9_000 }, { knownGapDays: ["2026-07-15"] }) });
    expect(inside.windowReasons).toEqual(["known_gap"]);
    expect(rowOf(inside, "big").status).toEqual({ kind: "no_spend_data", reasons: ["known_gap"] });
    expect(inside.total.status).toEqual({ kind: "no_spend_data", reasons: ["known_gap"] });
    const outside = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: 9_000 }, { knownGapDays: ["2026-08-15"] }) });
    expect(rowOf(outside, "big").noSpendReasons).toEqual([]);
  });

  it("no ledger yet: every funnel is No spend data, the revenue side still shows", () => {
    const result = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: null });
    expect(result.windowReasons).toEqual(["spend_unavailable"]);
    expect(rowOf(result, "big")).toMatchObject({ evaluated: false, spendRaw: null, status: { kind: "no_spend_data", reasons: ["spend_unavailable"] } });
    expect(result.spendBanner).toBeNull();
    expect(result.unlinkedSpend).toBeNull();
  });

  it("a ledger read for another window is refused (spend days missing, or days after data_through with spend)", () => {
    const short = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: { ...spendFor(JULY, { big: 9_000 }), window: { from: "2026-07-01", to: "2026-07-30" } } });
    expect(short.windowReasons).toEqual(["spend_window_mismatch"]);
    const shifted = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: { ...spendFor(JULY, { big: 9_000 }), window: { from: "2026-07-02", to: "2026-07-31" } } });
    expect(shifted.windowReasons).toEqual(["spend_window_mismatch"]);
    const long = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: { ...spendFor(JULY, { big: 9_000 }), window: { from: "2026-07-01", to: "2026-08-15" } } });
    expect(long.windowReasons).toEqual(["spend_window_mismatch"]);
  });
});

describe("spend_through: trials after the last day with Facebook spend are never paired with $0", () => {
  const SEPT: PaybackWindow = { from: "2026-09-01", to: "2026-09-30" };
  const late = cohortRows("late", "2026-09-20", "2026-09-30", 10, monthly);
  const ledger = spendFor(SEPT, { big: 7_000 }, { spendThrough: "2026-09-14" });

  it("pairs only [from, spend_through]; later trials are counted apart; the banner names the date", () => {
    const result = computePayback({ ltv: ltvOf([...BIG, ...late]), window: SEPT, spend: ledger, agencyFee: NO_FEE });
    expect(result.revenueWindow).toEqual({ from: "2026-09-01", to: "2026-09-30" });
    expect(result.evaluatedWindow).toEqual({ from: "2026-09-01", to: "2026-09-14" });
    expect(result.windowReasons).toEqual([]);
    expect(result.spendBanner).toEqual({ through: "2026-09-14", lagDays: 16 });
    const big = rowOf(result, "big");
    expect(big).toMatchObject({ trials: 140, trialsAfterSpendThrough: 160, evaluated: true, spend: 7_000, cpt: 50, noSpendReasons: [] });
    const lateRow = rowOf(result, "late");
    expect(lateRow).toMatchObject({ trials: 110, trialsAfterSpendThrough: 110, evaluated: false, spend: null, status: { kind: "no_spend_data", reasons: ["after_spend_through"] } });
    // ...while its revenue curve is still there.
    expect(lateRow.months[0].ltv).toBeCloseTo(monthly(30), 9);
    // TOTAL pairs the funnels with spend only, and says what it left out:
    // late's trials are all after Sep 14, so they are newer trials (counted
    // once, with big's 160), not left-out trials.
    expect(result.total).toMatchObject({ key: PAYBACK_TOTAL_KEY, trials: 140, spend: 7_000, excludedFunnels: 1, excludedTrials: 0, trialsAfterSpendThrough: 270, evaluated: true });
  });

  it("each count has one meaning: trials, left-out trials and newer trials never overlap", () => {
    // big: 140 paired + 160 later; zero: 10/day all September with no spend
    // (140 paired, left out; 160 later); late: only later trials (110).
    const zero = cohortRows("zero", "2026-09-01", "2026-09-30", 10, monthly);
    const result = computePayback({ ltv: ltvOf([...BIG, ...zero, ...late]), window: SEPT, spend: ledger, agencyFee: NO_FEE });
    expect(rowOf(result, "zero")).toMatchObject({ trials: 140, trialsAfterSpendThrough: 160, evaluated: true, status: { kind: "no_spend_data", reasons: ["zero_spend"] } });
    expect(result.total).toMatchObject({ trials: 140, excludedFunnels: 2, excludedTrials: 140, trialsAfterSpendThrough: 160 + 160 + 110, evaluated: true });
    // Every trial of the window, exactly once.
    expect(result.total.trials + result.total.excludedTrials + result.total.trialsAfterSpendThrough).toBe(300 + 300 + 110);
  });

  it("no funnel usable: an evaluated aggregate keeps only trials a spend window covers", () => {
    // zero has paired trials (no spend), late only later ones: Total shows zero's
    // 140 as No spend data, and every later trial once as newer.
    const zero = cohortRows("zero", "2026-09-01", "2026-09-30", 10, monthly);
    const result = computePayback({ ltv: ltvOf([...zero, ...late]), window: SEPT, spend: spendFor(SEPT, {}, { spendThrough: "2026-09-14" }) });
    expect(result.total).toMatchObject({ trials: 140, trialsAfterSpendThrough: 160 + 110, evaluated: true, excludedFunnels: 0, paths: ["late", "zero"] });
    expect(result.total.status).toMatchObject({ kind: "no_spend_data" });
  });

  it("a window entirely after spend_through: every funnel is No spend data", () => {
    const window = { from: "2026-10-01", to: "2026-10-19" };
    const result = computePayback({ ltv: ltvOf(BIG), window, spend: spendFor(window, { big: 0 }, { spendThrough: "2026-09-14" }) });
    expect(result.windowReasons).toEqual(["after_spend_through"]);
    expect(result.evaluatedWindow).toBeNull();
    expect(rowOf(result, "big")).toMatchObject({ trials: 190, trialsAfterSpendThrough: 190, evaluated: false, status: { kind: "no_spend_data", reasons: ["after_spend_through"] } });
    expect(result.spendBanner).toEqual({ through: "2026-09-14", lagDays: 35 });
  });

  it("the 30-day preset after spend_through: Total's trials ARE the later ones (not evaluated), never counted twice as newer", () => {
    const dt = "2026-10-24T12:00:00.000Z";
    const window = { from: "2026-09-25", to: "2026-10-24" };
    const a = cohortRows("a", "2026-01-01", "2026-10-24", 100, monthly, dt);
    const result = computePayback({ ltv: ltvOf(a, dt), window, spend: spendFor(window, {}, { spendThrough: "2026-09-14" }, dt) });
    expect(result.windowReasons).toEqual(["after_spend_through"]);
    expect(result.total).toMatchObject({ trials: 3_000, trialsAfterSpendThrough: 3_000, evaluated: false, excludedFunnels: 0, excludedTrials: 0 });
    expect(result.total.status).toEqual({ kind: "no_spend_data", reasons: ["after_spend_through"] });
  });

  it("a mixed window: an older funnel and one that started after spend_through", () => {
    const dt = "2026-10-24T12:00:00.000Z";
    const window = { from: "2026-07-27", to: "2026-10-24" };
    // a: 100/day all along (50 days up to Sep 14, 40 after); b: 100/day from Sep 20 (35 days).
    const a = cohortRows("a", "2026-01-01", "2026-10-24", 100, monthly, dt);
    const b = cohortRows("b", "2026-09-20", "2026-10-24", 100, monthly, dt);
    const result = computePayback({ ltv: ltvOf([...a, ...b], dt), window, spend: spendFor(window, { a: 100_000 }, { spendThrough: "2026-09-14" }, dt) });
    expect(rowOf(result, "a")).toMatchObject({ trials: 5_000, trialsAfterSpendThrough: 4_000, evaluated: true });
    expect(rowOf(result, "b")).toMatchObject({ trials: 3_500, trialsAfterSpendThrough: 3_500, evaluated: false });
    // Every later trial reaches Total once: 4,000 of a and all 3,500 of b.
    expect(result.total).toMatchObject({ trials: 5_000, trialsAfterSpendThrough: 7_500, evaluated: true, excludedFunnels: 1, excludedTrials: 0 });
  });

  it("no Facebook spend loaded at all", () => {
    const result = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, { big: 0 }, { spendThrough: null }) });
    expect(result.windowReasons).toEqual(["no_spend_loaded"]);
    expect(result.spendBanner).toEqual({ through: null, lagDays: null });
  });

  it("the normal one-day Facebook lag clips the newest day without a banner", () => {
    const result = computePayback({ ltv: ltvOf(BIG), window: LAST_30, spend: spendFor(LAST_30, { big: 9_000 }, { spendThrough: "2026-10-18" }) });
    expect(result.spendBanner).toBeNull();
    expect(rowOf(result, "big")).toMatchObject({ trials: 290, trialsAfterSpendThrough: 10 });
  });

  it("a ledger read up to data_through is consistent with an earlier spend_through (no spend after it)", () => {
    expect(paybackLedgerWindow(SEPT, DT)).toEqual(SEPT);
    expect(paybackLedgerWindow({ from: "2026-10-01", to: "2026-10-31" }, DT)).toEqual({ from: "2026-10-01", to: "2026-10-20" });
    expect(paybackLedgerWindow({ from: "2026-11-01", to: "2026-11-30" }, DT)).toBeNull();
    expect(paybackLedgerWindow(SEPT, null)).toBeNull();
  });
});

describe("trial coverage: a stale cohort snapshot cuts the trials at its newest member", () => {
  const MEMBERS = "2026-10-17T09:00:00.000Z";

  it("the trials (and the ledger window) end at members_through while the snapshot is stale", () => {
    const ltv = { ...ltvOf(BIG), members_through: MEMBERS, snapshot_stale: true };
    expect(paybackTrialsThrough(ltv)).toBe(MEMBERS);
    expect(paybackLedgerWindow(LAST_30, paybackTrialsThrough(ltv))).toEqual({ from: "2026-09-20", to: "2026-10-17" });
    const result = computePayback({ ltv, window: LAST_30, spend: spendFor(LAST_30, { big: 9_000 }, { window: { from: "2026-09-20", to: "2026-10-17" }, spendThrough: "2026-10-18" }) });
    expect(result.trialsCutAt).toBe("2026-10-17");
    expect(result.revenueWindow).toEqual({ from: "2026-09-20", to: "2026-10-17" });
    expect(result.evaluatedWindow).toEqual({ from: "2026-09-20", to: "2026-10-17" });
    expect(result.windowReasons).toEqual([]);
    // 28 days × 10 trials paired with 28 days of spend — the missing days are not counted against it.
    expect(rowOf(result, "big")).toMatchObject({ trials: 280, spend: 9_360, trialsAfterSpendThrough: 0 });
    // Maturity still reads data_through: the same cohort days are as observed as before.
    const fresh = computePayback({ ltv: ltvOf(BIG), window: { from: "2026-09-20", to: "2026-10-17" }, spend: null });
    expect(rowOf(result, "big").months.map((month) => month.observedShare)).toEqual(rowOf(fresh, "big").months.map((month) => month.observedShare));
  });

  it("no cut when the snapshot is current, its freshness unknown, or its newest trial is not earlier", () => {
    expect(paybackTrialsThrough({ data_through: DT, members_through: MEMBERS, snapshot_stale: false })).toBe(DT);
    expect(paybackTrialsThrough({ data_through: DT, members_through: MEMBERS, snapshot_stale: null })).toBe(DT);
    expect(paybackTrialsThrough({ data_through: DT })).toBe(DT);
    expect(paybackTrialsThrough({ data_through: DT, members_through: "2026-10-20T13:00:00.000Z", snapshot_stale: true })).toBe(DT);
    expect(paybackTrialsThrough({ data_through: null, members_through: MEMBERS, snapshot_stale: true })).toBeNull();
    const result = computePayback({ ltv: { ...ltvOf(BIG), members_through: MEMBERS, snapshot_stale: false }, window: LAST_30, spend: null });
    expect(result.trialsCutAt).toBeNull();
    expect(result.revenueWindow).toEqual({ from: "2026-09-20", to: "2026-10-19" });
    // A window that ends before the cut is not cut.
    const july = computePayback({ ltv: { ...ltvOf(BIG), members_through: MEMBERS, snapshot_stale: true }, window: JULY, spend: null });
    expect(july.trialsCutAt).toBeNull();
  });
});

describe("funnels, unlinked spend, small-funnel fold and TOTAL", () => {
  const tiny2 = cohortRows("tiny2", "2026-07-01", "2026-07-31", 1, monthly);
  const ghostSpend = { big: 15_500, tiny2: 400, ghost: 500 };

  it("folds funnels under 50 trials into one row; TOTAL includes them and spend-only funnels", () => {
    const result = computePayback({ ltv: ltvOf([...BIG, ...tiny2]), window: JULY, spend: spendFor(JULY, ghostSpend, { unlinkedSpend: 321 }), agencyFee: NO_FEE });
    expect(result.rows.map((row) => row.key)).toEqual(["big"]);
    expect(result.small?.rows.map((row) => row.key)).toEqual(["ghost", "tiny2"]);
    expect(rowOf(result, "tiny2").status).toEqual({ kind: "low_volume" });
    expect(rowOf(result, "ghost")).toMatchObject({ trials: 0, spend: 500, cpt: null, status: { kind: "low_volume" } });
    expect(result.small?.aggregate).toMatchObject({ key: PAYBACK_SMALL_FUNNELS_KEY, paths: ["ghost", "tiny2"], trials: 31, spend: 900, excludedFunnels: 0 });
    expect(result.total).toMatchObject({ trials: 341, spend: 16_400, cpt: 16_400 / 341, excludedFunnels: 0 });
    // Σ/Σ across funnels.
    expect(result.total.months[0].ltv).toBeCloseTo(monthly(30), 9);
    expect(result.total.months[0].roas).toBeCloseTo((341 * monthly(30)) / 16_400, 12);
    // Unlinked spend is never added to a funnel; shown only when every funnel is selected.
    expect(result.unlinkedSpend).toBe(321);
    expect(computePayback({ ltv: ltvOf([...BIG, ...tiny2]), window: JULY, spend: spendFor(JULY, ghostSpend, { unlinkedSpend: 321 }), funnels: ["big"] }).unlinkedSpend).toBeNull();
  });

  it("the funnel filter narrows the rows and TOTAL, never the pools", () => {
    const products = [{ key: "p1", paths: ["big", "tiny2"] }];
    const all = computePayback({ ltv: ltvOf([...BIG, ...tiny2]), window: JULY, spend: spendFor(JULY, ghostSpend), products });
    const only = computePayback({ ltv: ltvOf([...BIG, ...tiny2]), window: JULY, spend: spendFor(JULY, ghostSpend), products, funnels: ["tiny2"] });
    expect(rowsOf(only).map((row) => row.key)).toEqual(["tiny2"]);
    expect(only.total.trials).toBe(31);
    expect(rowOf(only, "tiny2").months[2]).toEqual(rowOf(all, "tiny2").months[2]);
    expect(rowOf(only, "tiny2").months[2].source).toBe("product");
  });

  it("an empty selection or no data", () => {
    const none = computePayback({ ltv: ltvOf(BIG), window: JULY, spend: spendFor(JULY, ghostSpend), funnels: ["nothing"] });
    expect(none.rows).toEqual([]);
    expect(none.small).toBeNull();
    expect(none.total.trials).toBe(0);
    const empty = computePayback({ ltv: { checkpoints: [...C], data_through: null, rows: [] }, window: JULY, spend: null });
    expect(empty).toMatchObject({ revenueWindow: null, rows: [], small: null, total: { trials: 0 } });
  });
});

// ---- verdicts -----------------------------------------------------------------------------

describe("status precedence", () => {
  const months = (roas: Array<number | null>, share = 1, approx = [false, false, false]) =>
    roas.map((value, index) => ({ roas: value, approx: approx[index], observedShare: share, ltv: 10 }));

  it("No spend data > Low volume > Too early > the month verdict", () => {
    expect(paybackStatusOf({ reasons: ["zero_spend"], trials: 10, months: months([2, 2, 2], 0.1) })).toEqual({ kind: "no_spend_data", reasons: ["zero_spend"] });
    expect(paybackStatusOf({ reasons: [], trials: 49, months: months([2, 2, 2], 0.1) })).toEqual({ kind: "low_volume" });
    expect(paybackStatusOf({ reasons: [], trials: 50, months: months([2, 2, 2], 0.49) })).toEqual({ kind: "too_early", observedShare: 0.49 });
    expect(paybackStatusOf({ reasons: [], trials: 50, months: months([1, 2, 2], 0.5) })).toEqual({ kind: "month", month: 1, approx: false });
  });

  it("the first month with ROAS >= 100 %, approximate when that cell is", () => {
    expect(paybackStatusOf({ reasons: [], trials: 500, months: months([0.5, 0.99, 1.1], 1, [false, false, true]) })).toEqual({ kind: "month", month: 3, approx: true });
    expect(paybackStatusOf({ reasons: [], trials: 500, months: months([0.5, 1, 1.1], 1, [false, false, true]) })).toEqual({ kind: "month", month: 2, approx: false });
    expect(paybackStatusOf({ reasons: [], trials: 500, months: months([0.2, 0.4, 0.7], 1, [false, true, true]) })).toEqual({ kind: "not_within", roas: 0.7, approx: true });
  });

  it("an unknown cell is too early", () => {
    const withUnknown = months([0.5, 0.9, 1.2]).map((month, index) => (index === 2 ? { ...month, ltv: null } : month));
    expect(paybackStatusOf({ reasons: [], trials: 500, months: withUnknown })).toMatchObject({ kind: "too_early" });
  });

  it("an integrated young funnel is too early, whatever its projected ROAS", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: LAST_30, spend: spendFor(LAST_30, { big: 100 }) }), "big");
    expect(row.months[0].roas!).toBeGreaterThan(1);
    expect(row.status).toEqual({ kind: "too_early", observedShare: 0 });
  });

  it("tints and tones", () => {
    expect([paybackRoasTint(null), paybackRoasTint(0.79), paybackRoasTint(0.8), paybackRoasTint(0.99), paybackRoasTint(1)]).toEqual([null, null, "warn", "warn", "good"]);
    expect(paybackStatusTone({ kind: "month", month: 1, approx: false })).toBe("good");
    expect(paybackStatusTone({ kind: "month", month: 2, approx: true })).toBe("good");
    expect(paybackStatusTone({ kind: "month", month: 3, approx: false })).toBe("warn");
    expect(paybackStatusTone({ kind: "not_within", roas: 0.5, approx: false })).toBe("bad");
    expect(paybackStatusTone({ kind: "low_volume" })).toBe("muted");
    expect(paybackStatusTone({ kind: "no_spend_data", reasons: ["zero_spend"] })).toBe("muted");
  });
});

describe("payback day (drilldown)", () => {
  const curve = [
    { day: 0, ltv: 1 }, { day: 3, ltv: 31 }, { day: 7, ltv: 31 }, { day: 30, ltv: 31 }, { day: 37, ltv: 61 }, { day: 90, ltv: 91 },
  ];

  it("interpolates linearly between checkpoints and rounds up", () => {
    // 1 → 31 over days 0..3: 16 is reached at 1.5 → day 2.
    expect(paybackDayOf(curve, 16)).toBe(2);
    expect(paybackDayOf(curve, 31)).toBe(3);
    // 46 between d30 (31) and d37 (61): 30 + 3.5 → day 34.
    expect(paybackDayOf(curve, 46)).toBe(34);
    expect(paybackDayOf(curve, 0.5)).toBe(0);
    expect(paybackDayOf(curve, 91)).toBe(90);
  });

  it("is null when not reached by day 90, or without a cost", () => {
    expect(paybackDayOf(curve, 92)).toBeNull();
    expect(paybackDayOf(curve, null)).toBeNull();
    expect(paybackDayOf(curve, 0)).toBeNull();
    expect(paybackDayOf([{ day: 0, ltv: null }], 5)).toBeNull();
  });

  it("what-if: the row against a typed cost per trial, whatever its spend coverage", () => {
    const row = rowOf(computePayback({ ltv: ltvOf(BIG), window: JULY, spend: null }), "big");
    expect(row.status.kind).toBe("no_spend_data");
    const whatIf = paybackWhatIf(row, 20)!;
    expect(whatIf.months[0].roas).toBeCloseTo(monthly(30) / 20, 12);
    expect(whatIf.status).toEqual({ kind: "month", month: 1, approx: false });
    // 1 → 30.99 over days 0..3: 20 at 1.9 → day 2.
    expect(whatIf.paybackDay).toBe(2);
    expect(paybackWhatIf(row, 0)).toBeNull();
    expect(paybackWhatIf(row, Number.NaN)).toBeNull();
  });
});

// ---- adapters, trend, backtest -------------------------------------------------------------

describe("adapters", () => {
  it("spend_ledger → spend input: funnel-resolved spend, unlinked buckets, gap days, spend_through", () => {
    const bucket = (spend: number) => ({ spend, groups: [], trafficCashOutflow: null, unresolvedCommissionSpend: spend });
    const input = paybackSpendFromLedger({
      window: { from: "2026-09-01", to: "2026-09-30" },
      windowLedger: { unknownFunnel: bucket(120), otherUnallocated: bucket(30), knownGapDays: [{ date: "2026-09-03", reference: "g1", note: "outage" }] },
      funnelLedgers: { big: { funnelResolvedSpend: 900, currency: "USD", currencyMixed: false } },
      spendThrough: "2026-09-14",
    });
    expect(input).toEqual({
      window: { from: "2026-09-01", to: "2026-09-30" },
      byPath: { big: { spend: 900, currency: "USD", currencyMixed: false } },
      unlinkedSpend: 150,
      knownGapDays: ["2026-09-03"],
      spendThrough: "2026-09-14",
    });
  });

  it("product_paths → product groups, without the metadata-less bucket", () => {
    expect(paybackProductGroups(null)).toBeNull();
    expect(paybackProductGroups([{ project_id: "P1", campaign_paths: ["a", "b"] }, { project_id: "", campaign_paths: ["unknown"] }])).toEqual([{ key: "P1", paths: ["a", "b"] }]);
  });
});

describe("trend by trial month", () => {
  it("six calendar months ending with the window's month, the last one cut at `to`", () => {
    expect(paybackTrendMonths("2026-10-20")).toEqual([
      { from: "2026-05-01", to: "2026-05-31" }, { from: "2026-06-01", to: "2026-06-30" }, { from: "2026-07-01", to: "2026-07-31" },
      { from: "2026-08-01", to: "2026-08-31" }, { from: "2026-09-01", to: "2026-09-30" }, { from: "2026-10-01", to: "2026-10-20" },
    ]);
    expect(paybackTrendMonths("2026-03-31", 2)).toEqual([{ from: "2026-02-01", to: "2026-02-28" }, { from: "2026-03-01", to: "2026-03-31" }]);
  });

  it("one row per month, each paired with its own ledger", () => {
    const base: Omit<PaybackInput, "window" | "spend" | "funnels"> = { ltv: ltvOf(BIG), agencyFee: NO_FEE };
    const months = paybackTrendMonths("2026-09-30", 3).map((window) => ({
      window,
      spend: spendFor(window, { big: 50 * 10 * (daysBetween(window.from, window.to) + 1) }, { spendThrough: "2026-09-14" }),
    }));
    const trend = paybackTrend(base, "big", months);
    expect(trend.map((entry) => entry.row?.trials)).toEqual([310, 310, 140]);
    expect(trend.map((entry) => entry.row?.trialsAfterSpendThrough)).toEqual([0, 0, 160]);
    expect(trend[0].row?.cpt).toBe(50);
    expect(trend[2].spendBanner).toEqual({ through: "2026-09-14", lagDays: 16 });
  });
});

describe("backtest", () => {
  const history = cohortRows("big", "2025-09-01", "2026-10-19", 10, monthly);

  it("a stationary funnel projects today's actuals exactly from what was known 30 / 60 / 90 days ago", () => {
    const result = backtestPayback(ltvOf(history))!;
    expect(result.bySlice.map((slice) => [slice.shiftDays, slice.month, slice.funnels])).toEqual([
      [30, 2, 1], [30, 3, 1], [60, 2, 1], [60, 3, 1], [90, 2, 1], [90, 3, 1],
    ]);
    for (const slice of result.bySlice) expect(slice.mape!).toBeCloseTo(0, 9);
    // Only cohorts that were not observed then and are now: shift 30, month 3 → 30 cohort days.
    expect(result.entries.find((entry) => entry.shiftDays === 30 && entry.month === 3)?.trials).toBe(300);
    expect(result.byFunnel).toEqual([{ path: "big", month: 2, slices: 3, mape: expect.any(Number) }, { path: "big", month: 3, slices: 3, mape: expect.any(Number) }]);
  });

  it("a price rise after the reference window shows up as error, larger for the longer shift", () => {
    const pricier: Curve = (day) => 1 + (day >= 3 ? 39.99 : 0) + (day >= 33 ? 39.99 : 0) + (day >= 63 ? 39.99 : 0);
    const changed = [
      ...cohortRows("big", "2025-09-01", "2026-05-31", 10, monthly),
      // From June the renewals cost more while the first charge stays: pools of
      // older cohorts under-project the new ones.
      ...cohortRows("big", "2026-06-01", "2026-10-19", 10, (day) => (day < 33 ? monthly(day) : pricier(day) - 10)),
    ];
    const result = backtestPayback(ltvOf(changed))!;
    const mape = (shift: number) => result.bySlice.find((slice) => slice.shiftDays === shift && slice.month === 3)!.mape!;
    expect(mape(90)).toBeGreaterThan(0.01);
    expect(result.entries.every((entry) => entry.projected < entry.actual)).toBe(true);
  });

  it("skips a funnel whose evaluated cohorts have fewer than 50 trials, and returns null without data", () => {
    // 1 trial a day: 30 evaluated cohort days at shift 30 (skipped), 90 at shift 90 (kept).
    const thin = cohortRows("thin", "2025-09-01", "2026-10-19", 1, monthly);
    const result = backtestPayback(ltvOf([...history, ...thin]))!;
    expect(result.entries.filter((entry) => entry.path === "thin").map((entry) => entry.shiftDays)).not.toContain(30);
    expect(result.entries.some((entry) => entry.path === "thin" && entry.shiftDays === 90)).toBe(true);
    const strict = backtestPayback(ltvOf([...history, ...thin]), { minTrials: 100 })!;
    expect(new Set(strict.entries.map((entry) => entry.path))).toEqual(new Set(["big"]));
    expect(backtestPayback({ checkpoints: [...C], data_through: null, rows: [] })).toBeNull();
  });
});
