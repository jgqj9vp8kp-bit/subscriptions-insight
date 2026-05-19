import type { CohortRow } from "@/services/types";
import { renewalUsersForColumn, trialCostForCohort } from "@/services/cohortReporting";

export type CohortSortDirection = "asc" | "desc";

export type CohortSortState = {
  sortColumn: string | null;
  sortDirection: CohortSortDirection | null;
};

export type CohortSortTraffic = {
  spend: number;
  cac: number;
  trial_count: number;
  clicks: number;
  cpc: number;
  cpm: number | null;
  ctr: number | null;
} | null;

export type CohortSortKind = "text" | "number" | "date";

const TEXT_COLUMNS = new Set(["__cohort__", "campaign_path", "funnel"]);
const DATE_COLUMNS = new Set(["cohort_date"]);

export function getCohortSortKind(columnId: string): CohortSortKind {
  if (DATE_COLUMNS.has(columnId)) return "date";
  if (TEXT_COLUMNS.has(columnId)) return "text";
  return "number";
}

export function defaultSortDirectionForColumn(columnId: string): CohortSortDirection {
  return getCohortSortKind(columnId) === "text" ? "asc" : "desc";
}

export function nextCohortSortState(current: CohortSortState, columnId: string): CohortSortState {
  if (current.sortColumn !== columnId) {
    return { sortColumn: columnId, sortDirection: defaultSortDirectionForColumn(columnId) };
  }

  if (current.sortDirection === "desc") return { sortColumn: columnId, sortDirection: "asc" };
  if (current.sortDirection === "asc") return { sortColumn: null, sortDirection: null };
  return { sortColumn: columnId, sortDirection: defaultSortDirectionForColumn(columnId) };
}

export function getCohortSortValue(
  cohort: CohortRow,
  columnId: string,
  traffic: CohortSortTraffic = null,
): string | number | null {
  const renewalUsers = renewalUsersForColumn(cohort, columnId);
  if (renewalUsers != null) return renewalUsers;

  switch (columnId) {
    case "__cohort__":
      return cohort.cohort_id;
    case "cohort_date": {
      const timestamp = Date.parse(cohort.cohort_date);
      return Number.isFinite(timestamp) ? timestamp : null;
    }
    case "campaign_path":
      return cohort.campaign_path;
    case "funnel":
      return cohort.funnel;
    case "traffic_spend":
      return traffic ? traffic.spend : null;
    case "trial_cost":
      return trialCostForCohort(cohort, traffic);
    case "profit":
      return traffic ? cohort.net_revenue - traffic.spend : null;
    case "profit_d7":
      return traffic ? cohort.revenue_d7 - traffic.spend : null;
    case "profit_1m":
      return traffic ? cohort.revenue_d30 - traffic.spend : null;
    case "profit_2m":
      return traffic ? cohort.revenue_d60 - traffic.spend : null;
    case "traffic_cac":
      return traffic ? traffic.cac : null;
    case "traffic_trial_count":
      return traffic ? traffic.trial_count : null;
    case "traffic_clicks":
      return traffic ? traffic.clicks : null;
    case "traffic_cpc":
      return traffic ? traffic.cpc : null;
    case "traffic_cpm":
      return traffic?.cpm ?? null;
    case "traffic_ctr":
      return traffic?.ctr ?? null;
    case "roas_d7":
      return traffic?.spend ? cohort.revenue_d7 / traffic.spend : null;
    case "roas_1m":
      return traffic?.spend ? cohort.revenue_d30 / traffic.spend : null;
    case "roas_2m":
      return traffic?.spend ? cohort.revenue_d60 / traffic.spend : null;
    default: {
      const value = (cohort as unknown as Record<string, unknown>)[columnId];
      if (typeof value === "number") return Number.isFinite(value) ? value : null;
      if (typeof value === "string") return value;
      return null;
    }
  }
}

export function compareCohortSortValues(
  left: string | number | null | undefined,
  right: string | number | null | undefined,
  direction: CohortSortDirection,
): number {
  const leftMissing = left == null || left === "";
  const rightMissing = right == null || right === "";

  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;

  let result = 0;
  if (typeof left === "number" && typeof right === "number") {
    result = left - right;
  } else {
    result = String(left).localeCompare(String(right), undefined, {
      numeric: true,
      sensitivity: "base",
    });
  }

  return direction === "asc" ? result : -result;
}

export function sortCohortRows<T extends CohortRow>(
  cohorts: T[],
  sort: CohortSortState,
  trafficForCohort: (cohort: T) => CohortSortTraffic = () => null,
): T[] {
  if (!sort.sortColumn || !sort.sortDirection) return [...cohorts];

  return cohorts
    .map((cohort, index) => ({ cohort, index }))
    .sort((left, right) => {
      const result = compareCohortSortValues(
        getCohortSortValue(left.cohort, sort.sortColumn!, trafficForCohort(left.cohort)),
        getCohortSortValue(right.cohort, sort.sortColumn!, trafficForCohort(right.cohort)),
        sort.sortDirection!,
      );
      return result || left.index - right.index;
    })
    .map(({ cohort }) => cohort);
}

export function sortCohortGroups<TGroup>(
  groups: TGroup[],
  sort: CohortSortState,
  cohortForGroup: (group: TGroup) => CohortRow | null,
  trafficForCohort: (cohort: CohortRow) => CohortSortTraffic = () => null,
): TGroup[] {
  if (!sort.sortColumn || !sort.sortDirection) return [...groups];

  const totalGroups = groups.filter((group) => !cohortForGroup(group));
  const cohortGroups = groups.filter((group) => cohortForGroup(group));

  return [
    ...cohortGroups
      .map((group, index) => ({ group, index, cohort: cohortForGroup(group)! }))
      .sort((left, right) => {
        const result = compareCohortSortValues(
          getCohortSortValue(left.cohort, sort.sortColumn!, trafficForCohort(left.cohort)),
          getCohortSortValue(right.cohort, sort.sortColumn!, trafficForCohort(right.cohort)),
          sort.sortDirection!,
        );
        return result || left.index - right.index;
      })
      .map(({ group }) => group),
    ...totalGroups,
  ];
}
