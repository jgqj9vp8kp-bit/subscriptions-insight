// Users page cohort panel: the pure rules behind its product, funnel, period,
// grouping and selection controls. No React here — the page and the panel
// component only wire these together, and the tests pin them one by one.
//
// The panel's lists all derive from ONE cohort list (the clickhouse-users
// options branch, requested without campaign_path so every funnel and product
// keeps its count; the legacy engine's computeCohorts otherwise). The period is
// the users' first-trial date: on the server cohort_date and first_trial_date
// come from the same trial row, both as its UTC calendar day, so one range
// narrows the cohort list and the users alike.
import { productKey, type CohortProductOption } from "@/services/cohortProductFilter";
import { shiftDay } from "@/components/payment-health/format";
import { formatDateKey, toDateKey } from "@/services/dateKeys";

export type CohortExplorerSortKey = "date" | "trial_users" | "net_revenue";

/** What the cohort explorer needs from a cohort, whichever engine produced it —
 * the server option list and the legacy CohortRow both satisfy it. */
export interface CohortExplorerRow {
  cohort_id: string;
  cohort_date: string;
  funnel: string;
  campaign_path: string;
  trial_users: number;
  net_revenue: number;
}

export type PeriodPreset = "all" | "7d" | "14d" | "30d" | "month" | "custom";
export type CohortGroupBy = "funnel" | "date";

/** = the server's MAX_IN_VALUES (supabase/functions/_shared/clickhouse/users.ts):
 * a longer cohort_ids filter is a 400 on every clickhouse-users action. */
export const MAX_SELECTED_COHORTS = 500;

export const PERIOD_PRESETS: ReadonlyArray<{ key: Exclude<PeriodPreset, "custom">; button: string; chip: string | null; days: number | null }> = [
  { key: "all", button: "All", chip: null, days: null },
  { key: "7d", button: "7d", chip: "Last 7 days", days: 7 },
  { key: "14d", button: "14d", chip: "Last 14 days", days: 14 },
  { key: "30d", button: "30d", chip: "Last 30 days", days: 30 },
  { key: "month", button: "Month", chip: "This month", days: null },
];

/** The persisted period; from/to are read only for "custom". */
export interface PeriodSelection {
  preset: PeriodPreset;
  from: string;
  to: string;
}

/** The resolved first-trial window (YYYY-MM-DD, UTC days); null = open. */
export interface PeriodRange {
  from: string | null;
  to: string | null;
}

const PERIOD_PRESET_KEYS: readonly string[] = ["all", "7d", "14d", "30d", "month", "custom"];

export function isDay(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === "string" && PERIOD_PRESET_KEYS.includes(value);
}

/** A multi-select merged with its legacy single-select key, so a persisted
 * "campaignPathFilter: x" keeps working after the upgrade (Cohorts page rule). */
export function mergeLegacySelection(raw: unknown, legacy: unknown): string[] {
  const values = new Set<string>();
  if (Array.isArray(raw)) {
    raw.forEach((value) => {
      const item = String(value ?? "").trim();
      if (item && item !== "all") values.add(item);
    });
  }
  const legacyValue = String(legacy ?? "").trim();
  if (legacyValue && legacyValue !== "all") values.add(legacyValue);
  return Array.from(values).sort();
}

export interface PeriodState {
  periodPreset?: unknown;
  periodFrom?: unknown;
  periodTo?: unknown;
  firstTrialFrom?: unknown;
  firstTrialTo?: unknown;
  cohortDateFrom?: unknown;
  cohortDateTo?: unknown;
}

/** The saved period, read lazily from the new keys or, until the first period
 * write, from the two legacy pairs: the main row's first-trial range (it
 * scoped the users) wins over the panel's cohort-date range. */
export function migratePeriodSelection(state: PeriodState): PeriodSelection {
  if (isPeriodPreset(state.periodPreset)) {
    const custom = state.periodPreset === "custom";
    return {
      preset: state.periodPreset,
      from: custom && isDay(state.periodFrom) ? state.periodFrom : "",
      to: custom && isDay(state.periodTo) ? state.periodTo : "",
    };
  }
  for (const [from, to] of [[state.firstTrialFrom, state.firstTrialTo], [state.cohortDateFrom, state.cohortDateTo]]) {
    if (isDay(from) || isDay(to)) return { preset: "custom", from: isDay(from) ? from : "", to: isDay(to) ? to : "" };
  }
  return { preset: "all", from: "", to: "" };
}

/** The UI-state patch of a period write; it blanks the legacy keys, which ends
 * their migration. An empty custom range is stored as "all". */
export function periodPatch(selection: PeriodSelection) {
  const from = selection.preset === "custom" && isDay(selection.from) ? selection.from : "";
  const to = selection.preset === "custom" && isDay(selection.to) ? selection.to : "";
  const preset: PeriodPreset = selection.preset === "custom" && !from && !to ? "all" : selection.preset;
  return {
    periodPreset: preset,
    periodFrom: from,
    periodTo: to,
    firstTrialFrom: "",
    firstTrialTo: "",
    cohortDateFrom: "",
    cohortDateTo: "",
  };
}

/** `today` is the UTC day (todayUtc()); rolling presets end on it. */
export function resolvePeriodRange(selection: PeriodSelection, today: string): PeriodRange {
  if (selection.preset === "all") return { from: null, to: null };
  if (selection.preset === "custom") {
    return { from: isDay(selection.from) ? selection.from : null, to: isDay(selection.to) ? selection.to : null };
  }
  if (selection.preset === "month") return { from: `${today.slice(0, 8)}01`, to: today };
  const days = PERIOD_PRESETS.find((preset) => preset.key === selection.preset)?.days ?? 1;
  return { from: shiftDay(today, -(days - 1)), to: today };
}

export function periodProblem(range: PeriodRange): string | null {
  return range.from && range.to && range.from > range.to ? "Start date is after end date." : null;
}

export function periodLabel(selection: PeriodSelection, range: PeriodRange): string | null {
  if (selection.preset === "all") return null;
  if (selection.preset !== "custom") return PERIOD_PRESETS.find((preset) => preset.key === selection.preset)?.chip ?? null;
  if (range.from && range.to) return `${formatDateKey(range.from)} – ${formatDateKey(range.to)}`;
  if (range.from) return `from ${formatDateKey(range.from)}`;
  if (range.to) return `to ${formatDateKey(range.to)}`;
  return null;
}

/** A no-op on the server path (the options request already carries the
 * period); it narrows the legacy engine's full cohort list. */
export function filterRowsByPeriod<T extends Pick<CohortExplorerRow, "cohort_date">>(rows: readonly T[], range: PeriodRange): T[] {
  if (!range.from && !range.to) return [...rows];
  return rows.filter((row) => {
    const day = toDateKey(row.cohort_date);
    if (!day) return false;
    if (range.from && day < range.from) return false;
    if (range.to && day > range.to) return false;
    return true;
  });
}

/** null = no path filter. */
export function pathScope(paths: readonly string[]): Set<string> | null {
  return paths.length ? new Set(paths) : null;
}

export function filterRowsByPaths<T extends Pick<CohortExplorerRow, "campaign_path">>(rows: readonly T[], scope: Set<string> | null): T[] {
  if (!scope) return [...rows];
  return rows.filter((row) => scope.has(row.campaign_path));
}

function trialsByPath(rows: readonly Pick<CohortExplorerRow, "campaign_path" | "trial_users">[]): Map<string, number> {
  const byPath = new Map<string, number>();
  for (const row of rows) byPath.set(row.campaign_path, (byPath.get(row.campaign_path) ?? 0) + row.trial_users);
  return byPath;
}

/** Trial users per product over the given cohorts (already narrowed by the
 * period and every other filter). product.trial_count is all-time and ignores
 * the filters, so it is never used. A path listed under two products counts
 * under both; a path missing from the map counts only under "All". */
export function productTrialCounts(
  rows: readonly Pick<CohortExplorerRow, "campaign_path" | "trial_users">[],
  products: readonly CohortProductOption[],
): { all: number; byKey: Map<string, number> } {
  const byPath = trialsByPath(rows);
  let all = 0;
  byPath.forEach((count) => { all += count; });
  const byKey = new Map<string, number>();
  for (const product of products) {
    let sum = 0;
    new Set(product.campaign_paths).forEach((path) => { sum += byPath.get(path) ?? 0; });
    byKey.set(productKey(product), sum);
  }
  return { all, byKey };
}

export interface FunnelOption {
  path: string;
  trialUsers: number;
}

/** The funnel picker's options: the cohort paths (of the selected products),
 * busiest first. A selected path is always listed — at 0 when it has no
 * cohort here — so it can be unticked; selected paths are not pinned, so rows
 * do not jump while ticking. */
export function funnelOptions(
  rows: readonly Pick<CohortExplorerRow, "campaign_path" | "trial_users">[],
  productPaths: Set<string> | null,
  selected: readonly string[],
): FunnelOption[] {
  const byPath = trialsByPath(productPaths ? rows.filter((row) => productPaths.has(row.campaign_path)) : rows);
  for (const path of selected) if (!byPath.has(path)) byPath.set(path, 0);
  return Array.from(byPath.entries())
    .map(([path, trialUsers]) => ({ path, trialUsers }))
    .sort((a, b) => b.trialUsers - a.trialUsers || a.path.localeCompare(b.path));
}

export interface CohortGroupChild {
  cohort: CohortExplorerRow;
  label: string;
  /** The funnel family, shown only to tell apart two children of one group
   * that would otherwise read the same (same path and date). */
  note: string | null;
}

export interface CohortGroup {
  key: string;
  label: string;
  trialUsers: number;
  netRevenue: number;
  latestDate: string;
  children: CohortGroupChild[];
}

const familyLabel = (family: string) => (family || "unknown").replace("_", " ");

/** Funnel grouping groups by campaign path (not by the funnel family: one path
 * can show up under two families); date grouping by cohort day. */
export function groupCohorts(
  rows: readonly CohortExplorerRow[],
  groupBy: CohortGroupBy,
  sortKey: CohortExplorerSortKey,
  sortDir: "asc" | "desc",
): CohortGroup[] {
  const sign = sortDir === "asc" ? 1 : -1;
  const byKey = new Map<string, CohortExplorerRow[]>();
  for (const row of rows) {
    const key = groupBy === "funnel" ? row.campaign_path : toDateKey(row.cohort_date) || row.cohort_date;
    const list = byKey.get(key) ?? [];
    list.push(row);
    byKey.set(key, list);
  }

  const childValue = (row: CohortExplorerRow): string | number =>
    sortKey === "date" ? toDateKey(row.cohort_date) : row[sortKey];
  const compareChildren = (a: CohortExplorerRow, b: CohortExplorerRow) => {
    const av = childValue(a);
    const bv = childValue(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    if (cmp) return cmp * sign;
    return b.trial_users - a.trial_users
      || toDateKey(b.cohort_date).localeCompare(toDateKey(a.cohort_date))
      || a.campaign_path.localeCompare(b.campaign_path)
      || a.cohort_id.localeCompare(b.cohort_id);
  };

  const groups: CohortGroup[] = [];
  byKey.forEach((list, key) => {
    // What reads the same inside the group: the date (funnel grouping) or the
    // path (date grouping). Only those children get the family note.
    const sameLabel = new Map<string, number>();
    const labelKey = (row: CohortExplorerRow) => (groupBy === "funnel" ? toDateKey(row.cohort_date) : row.campaign_path);
    for (const row of list) sameLabel.set(labelKey(row), (sameLabel.get(labelKey(row)) ?? 0) + 1);
    const children = [...list].sort(compareChildren).map((cohort) => ({
      cohort,
      label: groupBy === "funnel" ? formatDateKey(cohort.cohort_date) : cohort.campaign_path,
      note: (sameLabel.get(labelKey(cohort)) ?? 0) > 1 ? familyLabel(cohort.funnel) : null,
    }));
    let trialUsers = 0;
    let netRevenue = 0;
    let latestDate = "";
    for (const row of list) {
      trialUsers += row.trial_users;
      netRevenue += row.net_revenue;
      const day = toDateKey(row.cohort_date);
      if (day > latestDate) latestDate = day;
    }
    groups.push({
      key,
      label: groupBy === "funnel" ? key : formatDateKey(key),
      trialUsers,
      netRevenue,
      latestDate,
      children,
    });
  });

  const groupValue = (group: CohortGroup): string | number =>
    sortKey === "date"
      ? (groupBy === "funnel" ? group.latestDate : group.key)
      : sortKey === "trial_users" ? group.trialUsers : group.netRevenue;
  return groups.sort((a, b) => {
    const av = groupValue(a);
    const bv = groupValue(b);
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    if (cmp) return cmp * sign;
    return groupBy === "funnel" ? a.label.localeCompare(b.label) : b.key.localeCompare(a.key);
  });
}

export function groupSelectionState(group: Pick<CohortGroup, "children">, selected: ReadonlySet<string>): boolean | "indeterminate" {
  const count = group.children.filter((child) => selected.has(child.cohort.cohort_id)).length;
  if (count === 0) return false;
  return count === group.children.length ? true : "indeterminate";
}

/** The union, unless it would pass MAX_SELECTED_COHORTS: then the selection is
 * returned unchanged with capped = true. */
export function addCohorts(selected: readonly string[], add: readonly string[]): { ids: string[]; capped: boolean } {
  const union = [...selected];
  const seen = new Set(selected);
  for (const id of add) {
    if (seen.has(id)) continue;
    seen.add(id);
    union.push(id);
  }
  if (union.length > MAX_SELECTED_COHORTS) return { ids: [...selected], capped: true };
  return { ids: union, capped: false };
}

export function removeCohorts(selected: readonly string[], remove: readonly string[]): string[] {
  const drop = new Set(remove);
  return selected.filter((id) => !drop.has(id));
}

const FAMILY_PREFIXES = ["past_life_", "soulmate_", "starseed_", "unknown_"];

/** The campaign path inside a cohort id: the server form
 * `${family}_${path}_${date}` and the legacy form `${path}_${date}`. */
export function cohortPathFromId(id: string): string | null {
  const match = String(id ?? "").match(/^(.*)_(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  let stem = match[1];
  const prefix = FAMILY_PREFIXES.find((value) => stem.startsWith(value));
  if (prefix) stem = stem.slice(prefix.length);
  return stem || null;
}

/** Drops the selected cohorts outside a narrowed path scope (product/funnel
 * change), so a stale selection cannot pin the users to cohorts the panel no
 * longer offers. An id whose path is unknown is kept. */
export function pruneCohortSelection(
  selected: readonly string[],
  scope: Set<string> | null,
  pathById: ReadonlyMap<string, string>,
): string[] {
  if (!scope) return [...selected];
  return selected.filter((id) => {
    const path = pathById.get(id) ?? cohortPathFromId(id);
    return path === null || scope.has(path);
  });
}

/** The users' campaign_path filter: a cohort selection wins over the panel's
 * product/funnel paths (the period still ANDs with it on the server). */
export function usersCampaignPaths(selectedCohortIds: readonly string[], panelPaths: readonly string[]): string[] {
  return selectedCohortIds.length > 0 ? [] : [...panelPaths];
}
