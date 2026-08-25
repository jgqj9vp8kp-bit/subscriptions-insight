// CSV/XLSX export of the Cohorts table. Exports EXACTLY the visible columns in
// their current order; cell values resolve through getCohortSortValue — the
// same field/traffic resolver the table's sorting uses — so exported numbers
// can never diverge from what the table sorts on. FB columns ride the generic
// row-field path (fb_spend, fb_cpp, … live directly on CohortRow).

import { getCohortSortValue, type CohortSortTraffic } from "@/services/cohortSorting";
import type { CohortRow } from "@/services/types";

export interface CohortsExportTable {
  headers: string[];
  rows: Array<Array<string | number>>;
}

export function buildCohortsExportTable(input: {
  cohorts: CohortRow[];
  columnOrder: string[];
  columnLabel: (id: string) => string;
  trafficForCohort?: (cohort: CohortRow) => CohortSortTraffic;
  /** Extra identity column prepended to every row (the Funnels view exports
   * "Funnel" with the registry display name; the Cohorts view passes none). */
  leadingColumn?: { header: string; value: (cohort: CohortRow) => string | number };
}): CohortsExportTable {
  const traffic = input.trafficForCohort ?? (() => null);
  const headers = [
    ...(input.leadingColumn ? [input.leadingColumn.header] : []),
    ...input.columnOrder.map((id) => input.columnLabel(id)),
  ];
  const rows = input.cohorts.map((cohort) => [
    ...(input.leadingColumn ? [input.leadingColumn.value(cohort)] : []),
    ...input.columnOrder.map((id): string | number => {
      if (id === "cohort_date") return cohort.cohort_date;
      const value = getCohortSortValue(cohort, id, traffic(cohort));
      if (value == null) return "";
      return value;
    }),
  ]);
  return { headers, rows };
}

function csvEscape(value: string | number): string {
  const text = String(value);
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function cohortsTableToCsv(table: CohortsExportTable): string {
  return [table.headers.map(csvEscape).join(","), ...table.rows.map((row) => row.map(csvEscape).join(","))].join("\n");
}
