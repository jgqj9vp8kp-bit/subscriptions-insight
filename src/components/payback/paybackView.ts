// Pure view helpers of the Payback page: row labels, sorting, the month cell
// text / tint / explanation, the drilldown chart series, the funnel options and
// the CSV / XLSX table. No React here, so the components stay components-only
// (fast refresh) and every rule is unit-testable.
import {
  PAYBACK_SMALL_FUNNELS_KEY,
  PAYBACK_TOTAL_KEY,
  paybackRoasTint,
  paybackTrialsThrough,
  type PaybackMonth,
  type PaybackMonthIndex,
  type PaybackPoint,
  type PaybackResult,
  type PaybackRow,
  type PaybackSpendInput,
  type PaybackStatus,
  type PaybackWindow,
} from "@/services/ltvPayback";
import type { ExportTable } from "@/lib/tableExport";
import type { FunnelMultiSelectOption } from "@/components/forecasting/FunnelMultiSelect";
import { PAYBACK_COPY, paybackStatusLabel } from "@/components/payback/paybackCopy";
import { DASH, PAYBACK_ROAS_MARKS, approxPrefix, fmtMoneyCents, fmtRoas, fmtShare, thresholdSafePct } from "@/components/payback/paybackFormat";
import type { PaybackShow, PaybackSort, PaybackSortKey } from "@/components/payback/paybackState";
import type { CohortLtvResponse } from "../../../supabase/functions/_shared/clickhouse/cohortContract.ts";

export const PAYBACK_MONTHS: readonly PaybackMonthIndex[] = [1, 2, 3];

export const TINT_CLASS: Readonly<Record<"good" | "warn", string>> = {
  good: "bg-success/15",
  warn: "bg-warning/15",
};

// ---- rows ---------------------------------------------------------------------------------

/** The label of a row: the funnel's display name, else its path. */
export function paybackRowLabel(key: string, names: ReadonlyMap<string, string>): string {
  if (key === PAYBACK_TOTAL_KEY) return PAYBACK_COPY.table.total;
  if (key === PAYBACK_SMALL_FUNNELS_KEY) return PAYBACK_COPY.table.smallFunnels;
  return names.get(key) ?? key;
}

/** The row the drilldown shows for a URL key (null when it is not on the page). */
export function findPaybackRow(result: PaybackResult, key: string | null): PaybackRow | null {
  if (!key) return null;
  if (key === PAYBACK_TOTAL_KEY) return result.total;
  if (key === PAYBACK_SMALL_FUNNELS_KEY) return result.small?.aggregate ?? null;
  return result.rows.find((row) => row.key === key) ?? result.small?.rows.find((row) => row.key === key) ?? null;
}

/** Best first: Month 1 < 2 < 3 < not within (more back first) < too early < low volume < no spend data. */
export function paybackVerdictRank(status: PaybackStatus): number {
  switch (status.kind) {
    case "month":
      return status.month;
    case "not_within":
      return 4 - Math.min(1, Math.max(0, status.roas ?? 0));
    case "too_early":
      return 5;
    case "low_volume":
      return 6;
    case "no_spend_data":
      return 7;
  }
}

function sortValue(row: PaybackRow, key: PaybackSortKey, show: PaybackShow, names: ReadonlyMap<string, string>): number | string | null {
  switch (key) {
    case "funnel":
      return paybackRowLabel(row.key, names).toLowerCase();
    case "trials":
      return row.trials;
    case "spend":
      return row.spend;
    case "cpt":
      return row.cpt;
    case "m1":
    case "m2":
    case "m3": {
      const month = row.months[Number(key.slice(1)) - 1];
      return show === "ltv" ? month.ltv : month.roas;
    }
    case "payback":
      return paybackVerdictRank(row.status);
  }
}

/** Rows in the chosen order; values the page cannot know sort last either way;
 * ties: more trials first, then the path. */
export function sortPaybackRows(rows: readonly PaybackRow[], sort: PaybackSort, show: PaybackShow, names: ReadonlyMap<string, string>): PaybackRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = sortValue(a, sort.key, show, names);
    const vb = sortValue(b, sort.key, show, names);
    if (va === null || vb === null) {
      if (va !== vb) return va === null ? 1 : -1;
    } else if (va !== vb) {
      return (va < vb ? -1 : 1) * sign;
    }
    return b.trials - a.trials || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

// ---- cells --------------------------------------------------------------------------------

/** Tooltip lines for one point of a row (a month cell or a curve checkpoint). */
export function pointExplanation(point: PaybackPoint, roas: number | null): string[] {
  const copy = PAYBACK_COPY.cell;
  const lines = [copy.revenuePerTrial(point.day, fmtMoneyCents(point.ltv))];
  lines.push(roas !== null ? copy.back(fmtRoas(roas)) : copy.noSpend);
  if (point.observedShare !== null) {
    if (point.observedShare >= 1 || point.source === null) lines.push(copy.observed(point.day));
    else lines.push(copy.projected(fmtShare(point.observedShare), point.day, PAYBACK_COPY.sources[point.source]));
  }
  if (point.poolTrials !== null && point.source !== null) lines.push(copy.pool(point.poolTrials));
  if (point.rough) lines.push(copy.rough);
  return lines;
}

/** The text of a month cell in the chosen view. */
export function monthCellText(month: PaybackMonth, show: PaybackShow): string {
  if (show === "ltv") return month.ltv === null ? DASH : `${approxPrefix(month.approx)}${fmtMoneyCents(month.ltv)}`;
  return month.roas === null ? DASH : `${approxPrefix(month.approx)}${fmtRoas(month.roas)}`;
}

/** The cell background for a month (spec §1 tints: from 100 % green, 80–99 % amber). */
export function monthTintClass(month: Pick<PaybackMonth, "roas">): string | undefined {
  const tint = paybackRoasTint(month.roas);
  return tint ? TINT_CLASS[tint] : undefined;
}

// ---- drilldown chart ------------------------------------------------------------------------

export interface PaybackChartPoint {
  day: number;
  ltv: number | null;
  approx: boolean;
  solid: number | null;
  dashed: number | null;
}

/** Solid up to the last fully observed checkpoint, dashed from there on (both
 * series share that point so the line is continuous). */
export function paybackChartData(row: Pick<PaybackRow, "curve">): PaybackChartPoint[] {
  const firstApprox = row.curve.findIndex((point) => point.approx);
  return row.curve.map((point, index) => ({
    day: point.day,
    ltv: point.ltv,
    approx: point.approx,
    solid: firstApprox < 0 || index <= firstApprox - 1 ? point.ltv : null,
    dashed: firstApprox >= 0 && index >= Math.max(firstApprox - 1, 0) ? point.ltv : null,
  }));
}

// ---- filters ------------------------------------------------------------------------------

/** Funnels the period can show: paths with trials up to the trials' last day
 * (paybackTrialsThrough), plus paths with spend (a funnel with spend and no
 * trials is still a row), most trials first; `within` = the selected products' paths. */
export function paybackFunnelOptions(
  ltv: (Pick<CohortLtvResponse, "rows" | "data_through"> & Partial<Pick<CohortLtvResponse, "members_through" | "snapshot_stale">>) | null,
  window: PaybackWindow | null,
  spend: PaybackSpendInput | null,
  within: ReadonlySet<string> | null,
  names: ReadonlyMap<string, string>,
): FunnelMultiSelectOption[] {
  if (!ltv || !window) return [];
  const newest = paybackTrialsThrough(ltv)?.slice(0, 10) ?? null;
  const end = newest && newest < window.to ? newest : newest ? window.to : null;
  const trials = new Map<string, number>();
  if (end) {
    for (const row of ltv.rows) {
      if (row.cohort_date < window.from || row.cohort_date > end || !(row.trial_users > 0)) continue;
      trials.set(row.campaign_path, (trials.get(row.campaign_path) ?? 0) + row.trial_users);
    }
  }
  for (const [path, entry] of Object.entries(spend?.byPath ?? {})) if ((entry.spend ?? 0) > 0 && !trials.has(path)) trials.set(path, 0);
  return [...trials.entries()]
    .filter(([path]) => !within || within.has(path))
    .sort(([a, ta], [b, tb]) => tb - ta || (a < b ? -1 : 1))
    .map(([path, count]) => ({ id: path, label: names.get(path) ?? path, hint: PAYBACK_COPY.filters.funnelHint(count) }));
}

// ---- export -------------------------------------------------------------------------------

/** The download's base name: the page's, plus the display window, so two
 * periods never export to the same name (the date of the export follows). */
export function paybackExportFileName(window: PaybackWindow | null): string {
  return window ? `${PAYBACK_COPY.export.fileName}-${window.from}_${window.to}` : PAYBACK_COPY.export.fileName;
}

/** The visible table (Total, the funnels in the current order, the small-funnel
 * row and, when unfolded, its funnels) as plain values for CSV / XLSX. Both
 * views' numbers are exported, whatever the cells show; the spend headers say
 * whether the agency fee is in. The payback day is a drilldown figure (spec §1)
 * and is not exported. */
export function buildPaybackExportTable(
  result: PaybackResult,
  options: { sort: PaybackSort; show: PaybackShow; names: ReadonlyMap<string, string>; smallOpen: boolean },
): ExportTable {
  const copy = PAYBACK_COPY.export;
  const fee = result.agencyFee.enabled;
  const headers = [
    copy.funnel, copy.path, copy.trials, copy.trialsAfter, copy.spend(fee), copy.cpt(fee),
    ...PAYBACK_MONTHS.flatMap((month) => [copy.revenuePerTrial(month), copy.back(month), copy.projected(month)]),
    copy.payback,
  ];
  const round = (value: number | null, digits = 2) => (value === null ? "" : Number(value.toFixed(digits)));
  const line = (row: PaybackRow) => [
    paybackRowLabel(row.key, options.names),
    row.key === PAYBACK_TOTAL_KEY || row.key === PAYBACK_SMALL_FUNNELS_KEY ? "" : row.key,
    row.trials,
    // Not evaluated: the later trials ARE the row's trials — no second count.
    row.evaluated ? row.trialsAfterSpendThrough : "",
    round(row.spend),
    round(row.cpt),
    // % of cost back to one decimal, never rounded up onto 80 % or 100 % (the verdict's thresholds).
    ...row.months.flatMap((month) => [round(month.ltv), month.roas === null ? "" : thresholdSafePct(month.roas, PAYBACK_ROAS_MARKS, 1), month.approx ? copy.yes : ""]),
    paybackStatusLabel(row.status),
  ];
  const rows = [line(result.total), ...sortPaybackRows(result.rows, options.sort, options.show, options.names).map(line)];
  if (result.small) {
    rows.push(line(result.small.aggregate));
    if (options.smallOpen) rows.push(...sortPaybackRows(result.small.rows, options.sort, options.show, options.names).map(line));
  }
  return { headers, rows };
}
