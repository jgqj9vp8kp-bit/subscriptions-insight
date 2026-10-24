// CSV / XLSX download of one plain table (headers + rows), the Cohorts-page
// pattern: a BOM so Excel reads the CSV as UTF-8, and a dynamic xlsx import so
// the library only loads when someone exports. Extracted from the Forecasting
// Plan table (ForecastPeriodTable) so the Payback page exports the same way —
// one definition, never a second copy.

export type ExportCell = string | number;

export interface ExportTable {
  headers: string[];
  rows: ExportCell[][];
}

export type ExportFormat = "csv" | "xlsx";

/** RFC 4180 quoting: only cells with a quote, comma or line break are quoted. */
export function tableToCsv(table: ExportTable): string {
  const escape = (value: ExportCell) => {
    const text = String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [table.headers, ...table.rows].map((row) => row.map(escape).join(",")).join("\n");
}

/** Saves `table` as `<baseName>-<YYYY-MM-DD>.<csv|xlsx>`. */
export async function downloadTable(table: ExportTable, format: ExportFormat, baseName: string, sheetName = "Sheet1"): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const blob = new Blob(["﻿", tableToCsv(table)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${baseName}-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, sheetName);
  XLSX.writeFile(book, `${baseName}-${stamp}.xlsx`);
}
