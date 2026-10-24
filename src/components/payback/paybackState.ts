// Payback page state (spec 2026-10-24 §4): it lives in the URL only — product,
// funnels, period (+ custom months), sort, the open drilldown, the cell view and
// the agency fee switch — so a link reproduces the screen exactly. No
// localStorage overrides. Defaults are left out of the URL.
//
// URL params:
//   product=<key>      repeated; none = every product
//   funnel=<path>      repeated; none = every funnel, one empty value = no funnel
//   period=30d|90d|180d|custom (default 90d); from / to = YYYY-MM for custom
//   sort=<key>-<asc|desc> (default spend-desc)
//   open=<row key>     the funnel (or Total / small funnels) in the drilldown
//   show=ltv           cells show LTV per trial instead of % of cost back
//   fee=off            the 4 % agency fee switched off
import { paybackTrendMonths, type PaybackWindow } from "@/services/ltvPayback";

export const PAYBACK_PERIODS = ["30d", "90d", "180d", "custom"] as const;
export type PaybackPeriod = (typeof PAYBACK_PERIODS)[number];
export const PAYBACK_DEFAULT_PERIOD: PaybackPeriod = "90d";
const PERIOD_DAYS: Readonly<Record<Exclude<PaybackPeriod, "custom">, number>> = { "30d": 30, "90d": 90, "180d": 180 };
/** The longest custom period (the server reads at most 13 months back). */
export const PAYBACK_MAX_CUSTOM_MONTHS = 12;
/** The drilldown's trend: this many trial months, ending with the period's last. */
export const PAYBACK_TREND_MONTHS = 6;

export const PAYBACK_SORT_KEYS = ["funnel", "trials", "spend", "cpt", "m1", "m2", "m3", "payback"] as const;
export type PaybackSortKey = (typeof PAYBACK_SORT_KEYS)[number];
export type PaybackSortDir = "asc" | "desc";
export interface PaybackSort {
  key: PaybackSortKey;
  dir: PaybackSortDir;
}
export const PAYBACK_DEFAULT_SORT: Readonly<PaybackSort> = Object.freeze({ key: "spend", dir: "desc" });

/** "back": % of the cost returned; "ltv": revenue per trial. */
export type PaybackShow = "back" | "ltv";

export interface PaybackUrlState {
  products: string[];
  /** null = every funnel; [] = none picked. */
  funnels: string[] | null;
  period: PaybackPeriod;
  /** YYYY-MM, custom period only. */
  fromMonth: string | null;
  toMonth: string | null;
  sort: PaybackSort;
  open: string | null;
  show: PaybackShow;
  agencyFee: boolean;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const OWN_KEYS = ["product", "funnel", "period", "from", "to", "sort", "open", "show", "fee"] as const;

const uniq = (values: string[]) => [...new Set(values)];

export function readPaybackUrl(params: URLSearchParams): PaybackUrlState {
  const period = (PAYBACK_PERIODS as readonly string[]).includes(params.get("period") ?? "")
    ? (params.get("period") as PaybackPeriod)
    : PAYBACK_DEFAULT_PERIOD;
  const month = (key: string) => {
    const value = params.get(key);
    return value && MONTH_RE.test(value) ? value : null;
  };
  const [sortKey, sortDir] = (params.get("sort") ?? "").split("-");
  const sort: PaybackSort = (PAYBACK_SORT_KEYS as readonly string[]).includes(sortKey) && (sortDir === "asc" || sortDir === "desc")
    ? { key: sortKey as PaybackSortKey, dir: sortDir }
    : { ...PAYBACK_DEFAULT_SORT };
  return {
    products: uniq(params.getAll("product").filter(Boolean)),
    funnels: params.has("funnel") ? uniq(params.getAll("funnel").filter(Boolean)) : null,
    period,
    fromMonth: period === "custom" ? month("from") : null,
    toMonth: period === "custom" ? month("to") : null,
    sort,
    open: params.get("open") || null,
    show: params.get("show") === "ltv" ? "ltv" : "back",
    agencyFee: params.get("fee") !== "off",
  };
}

/** `current` with this page's params replaced by `state` (defaults left out). */
export function writePaybackUrl(state: PaybackUrlState, current?: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of OWN_KEYS) next.delete(key);
  for (const product of state.products) next.append("product", product);
  if (state.funnels !== null) {
    if (state.funnels.length === 0) next.append("funnel", "");
    for (const funnel of state.funnels) next.append("funnel", funnel);
  }
  if (state.period !== PAYBACK_DEFAULT_PERIOD) next.set("period", state.period);
  if (state.period === "custom") {
    if (state.fromMonth) next.set("from", state.fromMonth);
    if (state.toMonth) next.set("to", state.toMonth);
  }
  if (state.sort.key !== PAYBACK_DEFAULT_SORT.key || state.sort.dir !== PAYBACK_DEFAULT_SORT.dir) next.set("sort", `${state.sort.key}-${state.sort.dir}`);
  if (state.open) next.set("open", state.open);
  if (state.show === "ltv") next.set("show", "ltv");
  if (!state.agencyFee) next.set("fee", "off");
  return next;
}

// ---- period → window ----------------------------------------------------------------------

const DAY_MS = 86_400_000;

export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function lastDayOfMonth(month: string): string {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index, 0)).toISOString().slice(0, 10);
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}

/** The custom months a fresh "Custom" starts from: the last three calendar months. */
export function defaultCustomMonths(today: string): { fromMonth: string; toMonth: string } {
  const [year, month] = today.split("-").map(Number);
  const from = new Date(Date.UTC(year, month - 3, 1)).toISOString().slice(0, 7);
  return { fromMonth: from, toMonth: today.slice(0, 7) };
}

export type PaybackPeriodProblem = "start_after_end" | "too_long" | "in_future";

/** The display window of a period (presets end today, UTC; a custom period is
 * whole calendar months, cut at today), or why it cannot be shown. */
export function paybackPeriodWindow(
  state: Pick<PaybackUrlState, "period" | "fromMonth" | "toMonth">,
  today: string,
): { window: PaybackWindow | null; problem: PaybackPeriodProblem | null } {
  if (state.period !== "custom") {
    return { window: { from: addDays(today, -(PERIOD_DAYS[state.period] - 1)), to: today }, problem: null };
  }
  const fallback = defaultCustomMonths(today);
  const fromMonth = state.fromMonth ?? fallback.fromMonth;
  const toMonth = state.toMonth ?? fallback.toMonth;
  if (fromMonth > toMonth) return { window: null, problem: "start_after_end" };
  if (monthsBetween(fromMonth, toMonth) > PAYBACK_MAX_CUSTOM_MONTHS) return { window: null, problem: "too_long" };
  const from = `${fromMonth}-01`;
  if (from > today) return { window: null, problem: "in_future" };
  const end = lastDayOfMonth(toMonth);
  return { window: { from, to: end < today ? end : today }, problem: null };
}

/** The trial months of the drilldown trend for a display window. */
export function paybackTrendWindows(window: PaybackWindow): PaybackWindow[] {
  return paybackTrendMonths(window.to, PAYBACK_TREND_MONTHS);
}

/** The cohort range the page asks the server for: the display window, widened
 * back to the first trend month so the drilldown trend reads the same rows
 * (the server widens further for its reference pools on its own). */
export function paybackLtvRange(window: PaybackWindow): PaybackWindow {
  const trendFrom = paybackTrendWindows(window)[0]?.from ?? window.from;
  return { from: trendFrom < window.from ? trendFrom : window.from, to: window.to };
}
