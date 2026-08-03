// Project funnel table (P5, read-only) — one row per campaign_path.
//
// Cohorts-style dense table with the five totals disciplines: additive columns
// sum, ratios recompute from totals, unavailable renders "—" (never a fake 0).
// Blocked rows stay visible with their reason path — the P3 live run showed
// most rows need operator input early in a month, so the blocked state is a
// first-class row, not a hidden error. The checkbox is SCOPING (moves spend
// between in-project and out-of-project), never editing.
import { Fragment, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtInt, fmtMoney, fmtPctValue } from "@/components/forecasting/forecastFormat";
import { ProjectFunnelRowDetail, type ProjectEntryEdits } from "@/components/forecasting/ProjectFunnelRowDetail";
import { PROJECT_COLUMNS } from "@/components/forecasting/projectTableColumns";
import type {
  ProjectEntryResolution,
  ProjectRowEconomics,
  ProjectRunResult,
  ResolvedProject,
} from "@/services/funnelEconomics";

const dash = <span className="text-muted-foreground/40">—</span>;

const CADENCE_SHORT: Record<string, string> = { monthly: "M", weekly: "W", quarterly: "Q", annual: "A", custom: "C" };

function money(value: number | null | undefined) {
  return value == null ? dash : fmtMoney(value);
}

function RowChips({ resolution }: { resolution: ProjectEntryResolution }) {
  const { entry, status } = resolution;
  return (
    <span className="ml-1.5 inline-flex flex-wrap gap-1 align-middle">
      <Badge variant="outline" className="h-4 px-1 text-[10px]" title={entry.cadenceConfirmed ? "cadence confirmed" : "cadence assumed — confirm before trusting retention"}>
        {CADENCE_SHORT[entry.cadence] ?? entry.cadence}{entry.cadenceConfirmed ? "" : "?"}
      </Badge>
      {entry.kind === "spend_only" && (
        <Badge variant="outline" className="h-4 px-1 text-[10px] text-warning" title="Resolved spend, zero trials — pure cost row; the engine is never invoked.">no users</Badge>
      )}
      {status.kind === "blocked" && (
        <Badge variant="outline" className="h-4 px-1 text-[10px] text-destructive" title={status.message}>{status.path}</Badge>
      )}
    </span>
  );
}

export function ProjectFunnelTable({ resolved, run, onToggle, edits, onEdit, visibleColumns }: {
  resolved: ResolvedProject;
  run: ProjectRunResult;
  onToggle: (funnelId: string) => void;
  edits: Record<string, ProjectEntryEdits>;
  onEdit: (funnelId: string, patch: Partial<ProjectEntryEdits>) => void;
  visibleColumns: ReadonlySet<string>;
}) {
  const economicsById = new Map<string, ProjectRowEconomics>(run.rows.map((row) => [row.funnelId, row]));
  const { totals } = run;
  const overheadGateBroken = totals.gates.some((gate) => gate.code === "overhead_identity");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const toggleExpanded = (funnelId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(funnelId)) next.delete(funnelId);
    else next.add(funnelId);
    return next;
  });

  // P9: canonical order filtered by the caller's visibility preferences.
  const columns = PROJECT_COLUMNS.filter((column) => visibleColumns.has(column.id));

  const rowCell = (columnId: string, resolution: ProjectEntryResolution): ReactNode => {
    const { entry, ledger } = resolution;
    const economics = economicsById.get(entry.funnelId);
    const cpa = resolution.frozen?.assumptions.traffic.targetCpa ?? null;
    switch (columnId) {
      case "spend": return money(ledger?.funnelResolvedSpend);
      case "coverage": return ledger?.spendCoverage == null ? dash : fmtPctValue(ledger.spendCoverage, 0);
      case "trials": return economics ? fmtInt(economics.trials) : dash;
      case "cpa": return economics && cpa != null ? fmtMoney(cpa) : dash;
      case "outflow": return economics ? money(economics.trafficCashOutflow) : dash;
      case "gross": return economics && entry.kind === "forecast" ? fmtMoney(economics.grossRevenue) : dash;
      case "contribution": return economics ? money(economics.trafficCashOutflow === null && entry.kind === "spend_only" ? null : economics.contributionProfit) : dash;
      case "overhead": return economics ? (
        <span title={`${fmtPctValue(economics.overheadShare, 1)} of the pool`}>
          {fmtMoney(economics.allocatedOverhead)}
          <span className="ml-1 text-[10px] text-muted-foreground">{fmtPctValue(economics.overheadShare, 0)}</span>
        </span>
      ) : dash;
      case "net": return economics ? fmtMoney(economics.netProfit) : dash;
      case "payback": return economics?.paybackDay != null ? `D${economics.paybackDay}` : dash;
      default: return dash;
    }
  };

  const rowCellClass = (columnId: string, resolution: ProjectEntryResolution): string => {
    const economics = economicsById.get(resolution.entry.funnelId);
    return cn(
      "py-1.5 text-right tabular-nums",
      columnId === "contribution" && economics && economics.contributionProfit < 0 && "text-destructive",
      columnId === "net" && economics && economics.netProfit < 0 && "text-destructive",
    );
  };

  const totalCell = (columnId: string): ReactNode => {
    switch (columnId) {
      case "spend": return fmtMoney(totals.projectScopedSpend);
      case "coverage": return fmtPctValue(totals.spendCoverage, 0);
      case "trials": return fmtInt(totals.trials);
      case "cpa": return <span title="Recomputed: project-scoped spend / Σ trials — never an average of row CPAs">{money(totals.blendedCpa)}</span>;
      case "outflow": return <span title="Σ row outflows + included unresolved spend outflow">{money(totals.trafficCashOutflow)}</span>;
      case "gross": return fmtMoney(totals.grossRevenue);
      case "contribution": return fmtMoney(totals.contributionProfit);
      case "overhead": return overheadGateBroken ? dash : fmtMoney(totals.allocatedOverhead);
      case "net": return overheadGateBroken ? dash : fmtMoney(totals.netProfit);
      case "payback": return <span title="From the combined day-axis curve — never a min or a mean of row paybacks">{totals.headlinePaybackDay != null ? `D${totals.headlinePaybackDay}` : dash}</span>;
      default: return dash;
    }
  };

  return (
    <Card className="p-0 shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Funnel</TableHead>
              {columns.map((column) => (
                <TableHead key={column.id} className="text-right" title={column.title}>{column.label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {resolved.resolutions.map((resolution) => {
              const { entry, status } = resolution;
              const excluded = status.kind !== "ok";
              const isExpanded = expanded.has(entry.funnelId);
              return (
                <Fragment key={entry.funnelId}>
                <TableRow className={cn(excluded && "opacity-60")}>
                  <TableCell className="py-1.5">
                    <Checkbox
                      checked={entry.enabled}
                      onCheckedChange={() => onToggle(entry.funnelId)}
                      title={entry.enabled ? "Deselect: spend moves to out-of-project, P&L untouched by this row" : "Include in the project"}
                    />
                  </TableCell>
                  <TableCell className="py-1.5 font-medium">
                    <button type="button" className="inline-flex items-center gap-1 hover:text-primary" onClick={() => toggleExpanded(entry.funnelId)} aria-expanded={isExpanded}>
                      {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                      {entry.funnelId}
                    </button>
                    <RowChips resolution={resolution} />
                  </TableCell>
                  {columns.map((column) => (
                    <TableCell key={column.id} className={rowCellClass(column.id, resolution)}>{rowCell(column.id, resolution)}</TableCell>
                  ))}
                </TableRow>
                {isExpanded && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={columns.length + 2} className="p-0">
                      <ProjectFunnelRowDetail
                        resolution={resolution}
                        edits={edits[entry.funnelId] ?? {}}
                        onEdit={(patch) => onEdit(entry.funnelId, patch)}
                      />
                    </TableCell>
                  </TableRow>
                )}
                </Fragment>
              );
            })}
          </TableBody>
          <tfoot>
            <TableRow className="border-t-2 bg-muted font-semibold hover:bg-muted">
              <TableCell className="py-2" />
              <TableCell className="py-2">TOTAL ({totals.funnelsIncluded + totals.spendOnlyIncluded} rows{totals.spendOnlyIncluded > 0 ? `, ${totals.spendOnlyIncluded} spend-only` : ""})</TableCell>
              {columns.map((column) => (
                <TableCell key={column.id} className={cn(
                  "py-2 text-right tabular-nums",
                  column.id === "contribution" && totals.contributionProfit < 0 && "text-destructive",
                  column.id === "net" && totals.netProfit < 0 && "text-destructive",
                )}>
                  {totalCell(column.id)}
                </TableCell>
              ))}
            </TableRow>
          </tfoot>
        </Table>
      </div>
    </Card>
  );
}
