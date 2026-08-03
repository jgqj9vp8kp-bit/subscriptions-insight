// Project table export (P8) — the visible funnel table + totals as CSV/XLSX.
//
// Mirrors the Cohorts/Plan export discipline: the builder is pure ({headers,
// rows}), unavailable values export as "" (never a fake 0), and the CSV rides
// the same generic serializer as Cohorts (cohortsTableToCsv), so Excel quirks
// (BOM, quoting) are solved in exactly one place.
import { cohortsTableToCsv, type CohortsExportTable } from "@/services/cohortsExport";
import {
  extrapolatedRevenueShare,
  type ProjectRowEconomics,
  type ProjectRunResult,
  type ResolvedProject,
} from "@/services/funnelEconomics";

const blank = "";

function cell(value: number | null | undefined, digits = 2): string | number {
  return value == null || Number.isNaN(value) ? blank : Number(value.toFixed(digits));
}

export function buildProjectExportTable(resolved: ResolvedProject, run: ProjectRunResult): CohortsExportTable {
  const headers = [
    "Funnel", "Status", "Kind", "Cadence", "Cadence confirmed",
    "Resolved spend", "Spend coverage", "Trials", "CPA", "Traffic cash outflow",
    "Gross revenue", "Payment-net revenue", "Contribution profit",
    "Overhead share", "Allocated overhead", "Net profit", "Payback day",
    "Extrapolated revenue share", "Warnings",
  ];
  const economicsById = new Map<string, ProjectRowEconomics>(run.rows.map((row) => [row.funnelId, row]));
  const rows: Array<Array<string | number>> = resolved.resolutions.map((resolution) => {
    const { entry, status, ledger } = resolution;
    const economics = economicsById.get(entry.funnelId);
    const exposure = extrapolatedRevenueShare(resolution);
    const cpa = resolution.frozen?.assumptions.traffic.targetCpa ?? null;
    return [
      entry.funnelId,
      status.kind === "blocked" ? `blocked: ${status.path}` : status.kind,
      entry.kind,
      entry.cadence,
      entry.cadenceConfirmed ? "yes" : "assumed",
      cell(ledger?.funnelResolvedSpend),
      cell(ledger?.spendCoverage, 4),
      economics ? cell(economics.trials) : blank,
      economics ? cell(cpa) : blank,
      economics ? cell(economics.trafficCashOutflow) : blank,
      economics && entry.kind === "forecast" ? cell(economics.grossRevenue) : blank,
      economics && entry.kind === "forecast" ? cell(economics.paymentNetRevenue) : blank,
      economics ? cell(economics.contributionProfit) : blank,
      economics ? cell(economics.overheadShare, 6) : blank,
      economics ? cell(economics.allocatedOverhead) : blank,
      economics ? cell(economics.netProfit) : blank,
      economics?.paybackDay ?? blank,
      exposure ? cell(exposure.share, 4) : blank,
      resolution.evidence.warnings.map((warning) => warning.code).join("; "),
    ];
  });

  const { totals } = run;
  rows.push([
    "TOTAL", blank, blank, blank, blank,
    cell(totals.projectScopedSpend),
    cell(totals.spendCoverage, 4),
    cell(totals.trials),
    cell(totals.blendedCpa),
    cell(totals.trafficCashOutflow),
    cell(totals.grossRevenue),
    cell(totals.paymentNetRevenue),
    cell(totals.contributionProfit),
    1,
    cell(totals.allocatedOverhead),
    cell(totals.netProfit),
    totals.headlinePaybackDay ?? blank,
    blank,
    totals.gates.map((gate) => gate.code).join("; "),
  ]);
  return { headers, rows };
}

export async function exportProjectTable(resolved: ResolvedProject, run: ProjectRunResult, format: "csv" | "xlsx"): Promise<void> {
  const table = buildProjectExportTable(resolved, run);
  const stamp = `${resolved.window.from}_${resolved.window.to}`;
  if (format === "csv") {
    const csv = cohortsTableToCsv(table);
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `project-forecast-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Project");
  XLSX.writeFile(book, `project-forecast-${stamp}.xlsx`);
}
