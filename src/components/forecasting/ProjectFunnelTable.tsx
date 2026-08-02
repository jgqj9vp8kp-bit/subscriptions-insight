// Project funnel table (P5, read-only) — one row per campaign_path.
//
// Cohorts-style dense table with the five totals disciplines: additive columns
// sum, ratios recompute from totals, unavailable renders "—" (never a fake 0).
// Blocked rows stay visible with their reason path — the P3 live run showed
// most rows need operator input early in a month, so the blocked state is a
// first-class row, not a hidden error. The checkbox is SCOPING (moves spend
// between in-project and out-of-project), never editing.
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { fmtInt, fmtMoney, fmtPctValue } from "@/components/forecasting/forecastFormat";
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

export function ProjectFunnelTable({ resolved, run, onToggle }: {
  resolved: ResolvedProject;
  run: ProjectRunResult;
  onToggle: (funnelId: string) => void;
}) {
  const economicsById = new Map<string, ProjectRowEconomics>(run.rows.map((row) => [row.funnelId, row]));
  const { totals } = run;
  const overheadGateBroken = totals.gates.some((gate) => gate.code === "overhead_identity");

  return (
    <Card className="p-0 shadow-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>Funnel</TableHead>
              <TableHead className="text-right">Spend</TableHead>
              <TableHead className="text-right" title="userAttributedSpend / funnelResolvedSpend — how much of this funnel's spend reached users">Cov.</TableHead>
              <TableHead className="text-right">Trials</TableHead>
              <TableHead className="text-right" title="Seeded on the project's spend basis — waste included (§5a)">CPA</TableHead>
              <TableHead className="text-right" title="Budget grossed up by traffic commission">Outflow</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Contribution</TableHead>
              <TableHead className="text-right" title="Prorated shared pool × this row's spend share">Overhead</TableHead>
              <TableHead className="text-right">Net profit</TableHead>
              <TableHead className="text-right" title="Per-funnel traffic-only payback (engine semantics)">Payback</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resolved.resolutions.map((resolution) => {
              const { entry, status, ledger } = resolution;
              const economics = economicsById.get(entry.funnelId);
              const excluded = status.kind !== "ok";
              const cpa = resolution.frozen?.assumptions.traffic.targetCpa ?? null;
              return (
                <TableRow key={entry.funnelId} className={cn(excluded && "opacity-60")}>
                  <TableCell className="py-1.5">
                    <Checkbox
                      checked={entry.enabled}
                      onCheckedChange={() => onToggle(entry.funnelId)}
                      title={entry.enabled ? "Deselect: spend moves to out-of-project, P&L untouched by this row" : "Include in the project"}
                    />
                  </TableCell>
                  <TableCell className="py-1.5 font-medium">
                    {entry.funnelId}
                    <RowChips resolution={resolution} />
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{money(ledger?.funnelResolvedSpend)}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{ledger?.spendCoverage == null ? dash : fmtPctValue(ledger.spendCoverage, 0)}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{economics ? fmtInt(economics.trials) : dash}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{economics && cpa != null ? fmtMoney(cpa) : dash}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{economics ? money(economics.trafficCashOutflow) : dash}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">{economics && entry.kind === "forecast" ? fmtMoney(economics.grossRevenue) : dash}</TableCell>
                  <TableCell className={cn("py-1.5 text-right tabular-nums", economics && economics.contributionProfit < 0 && "text-destructive")}>
                    {economics ? money(economics.trafficCashOutflow === null && entry.kind === "spend_only" ? null : economics.contributionProfit) : dash}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">
                    {economics ? (
                      <span title={`${fmtPctValue(economics.overheadShare, 1)} of the pool`}>
                        {fmtMoney(economics.allocatedOverhead)}
                        <span className="ml-1 text-[10px] text-muted-foreground">{fmtPctValue(economics.overheadShare, 0)}</span>
                      </span>
                    ) : dash}
                  </TableCell>
                  <TableCell className={cn("py-1.5 text-right tabular-nums", economics && economics.netProfit < 0 && "text-destructive")}>
                    {economics ? fmtMoney(economics.netProfit) : dash}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums">
                    {economics?.paybackDay != null ? `D${economics.paybackDay}` : dash}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <tfoot>
            <TableRow className="border-t-2 bg-muted font-semibold hover:bg-muted">
              <TableCell className="py-2" />
              <TableCell className="py-2">TOTAL ({totals.funnelsIncluded + totals.spendOnlyIncluded} rows{totals.spendOnlyIncluded > 0 ? `, ${totals.spendOnlyIncluded} spend-only` : ""})</TableCell>
              <TableCell className="py-2 text-right tabular-nums">{fmtMoney(totals.projectScopedSpend)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums">{fmtPctValue(totals.spendCoverage, 0)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums">{fmtInt(totals.trials)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums" title="Recomputed: project-scoped spend / Σ trials — never an average of row CPAs">{money(totals.blendedCpa)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums" title="Σ row outflows + included unresolved spend outflow">{money(totals.trafficCashOutflow)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums">{fmtMoney(totals.grossRevenue)}</TableCell>
              <TableCell className={cn("py-2 text-right tabular-nums", totals.contributionProfit < 0 && "text-destructive")}>{fmtMoney(totals.contributionProfit)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums">{overheadGateBroken ? dash : fmtMoney(totals.allocatedOverhead)}</TableCell>
              <TableCell className={cn("py-2 text-right tabular-nums", totals.netProfit < 0 && "text-destructive")}>{overheadGateBroken ? dash : fmtMoney(totals.netProfit)}</TableCell>
              <TableCell className="py-2 text-right tabular-nums" title="From the combined day-axis curve — never a min or a mean of row paybacks">
                {totals.headlinePaybackDay != null ? `D${totals.headlinePaybackDay}` : dash}
              </TableCell>
            </TableRow>
          </tfoot>
        </Table>
      </div>
    </Card>
  );
}
