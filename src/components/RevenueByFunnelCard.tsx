// Dashboard Revenue Intelligence · "Revenue by funnel" (period). A compact
// ranked list (row model: services/revenueFunnelList.ts). A stacked bar per row
// shows the funnel's size against the largest row on screen and its New vs
// Existing cohort split, in the chart's colours.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { RevenueSliceRow } from "@/services/revenueIntelligence";
import { buildFunnelListView, FUNNEL_TOP_N, type FunnelSort, type FunnelSortKey } from "@/services/revenueFunnelList";

const COLUMNS: Array<{ key: FunnelSortKey; label: string; className?: string }> = [
  { key: "key", label: "Funnel" },
  { key: "gross", label: "Gross", className: "w-28 text-right" },
  { key: "gross_new", label: "New", className: "hidden w-28 text-right lg:table-cell" },
  { key: "gross_existing", label: "Existing", className: "hidden w-28 text-right lg:table-cell" },
  { key: "net", label: "Net", className: "w-28 text-right" },
];

const usd = (value: number): string =>
  value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const share = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

function SplitBar({ row, maxGross, muted }: { row: RevenueSliceRow; maxGross: number; muted?: boolean }): JSX.Element {
  const width = maxGross > 0 ? Math.max(0, (row.gross / maxGross) * 100) : 0;
  // New + Existing can fall short of Gross only for the Unattributed row (no
  // cohort): that remainder is drawn grey, never as Existing.
  const attributed = row.gross_new + row.gross_existing;
  const newPart = row.gross > 0 ? (row.gross_new / row.gross) * 100 : 0;
  const existingPart = row.gross > 0 ? (row.gross_existing / row.gross) * 100 : 0;
  const title = attributed > 0
    ? `New ${usd(row.gross_new)} (${share(row.gross_new, row.gross)}) · Existing ${usd(row.gross_existing)} (${share(row.gross_existing, row.gross)})`
    : "No cohort — not split into New / Existing";
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted" title={title}>
      <div className="flex h-full" style={{ width: `${width}%` }}>
        {muted || attributed <= 0 ? (
          <div className="h-full w-full bg-muted-foreground/40" />
        ) : (
          <>
            <div className="h-full" style={{ width: `${newPart}%`, background: "hsl(var(--primary))" }} />
            <div className="h-full" style={{ width: `${existingPart}%`, background: "hsl(210 60% 70%)" }} />
            <div className="h-full flex-1 bg-muted-foreground/40" />
          </>
        )}
      </div>
    </div>
  );
}

function FunnelRow({ row, label, sub, totalGross, maxGross, muted }: {
  row: RevenueSliceRow; label: string; sub?: string; totalGross: number; maxGross: number; muted?: boolean;
}): JSX.Element {
  return (
    <TableRow className={cn("hover:bg-muted/30", muted && "text-muted-foreground")}>
      <TableCell className="px-3 py-1.5">
        <div className="flex items-center gap-3">
          <span className={cn("w-36 shrink-0 truncate text-xs lg:w-44 xl:w-56", muted ? "italic" : "font-medium")} title={row.key}>
            {label}
            {sub && <span className="ml-1 not-italic text-muted-foreground">{sub}</span>}
          </span>
          <div className="min-w-16 flex-1"><SplitBar row={row} maxGross={maxGross} muted={muted && row.key !== "Other"} /></div>
          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{share(row.gross, totalGross)}</span>
        </div>
      </TableCell>
      <TableCell className="px-3 py-1.5 text-right font-mono text-xs font-medium">{usd(row.gross)}</TableCell>
      <TableCell className="hidden px-3 py-1.5 text-right font-mono text-xs text-muted-foreground lg:table-cell">{usd(row.gross_new)}</TableCell>
      <TableCell className="hidden px-3 py-1.5 text-right font-mono text-xs text-muted-foreground lg:table-cell">{usd(row.gross_existing)}</TableCell>
      <TableCell className="px-3 py-1.5 text-right font-mono text-xs">{usd(row.net)}</TableCell>
    </TableRow>
  );
}

export function RevenueByFunnelCard({ rows, totals, footer }: {
  rows: ReadonlyArray<RevenueSliceRow>;
  totals: { gross: number; net: number; gross_new: number; gross_existing: number };
  footer?: React.ReactNode;
}): JSX.Element {
  const [sort, setSort] = useState<FunnelSort>({ key: "gross", dir: "desc" });
  const [expanded, setExpanded] = useState(false);
  const view = useMemo(() => buildFunnelListView(rows, sort, expanded), [rows, sort, expanded]);
  const canFold = view.funnelCount > FUNNEL_TOP_N + 1;
  const toggleSort = (key: FunnelSortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "key" ? "asc" : "desc" }));

  return (
    <Card className="shadow-card" data-testid="revenue-by-funnel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Revenue by funnel</h3>
          <p className="text-xs text-muted-foreground">
            {view.funnelCount} {view.funnelCount === 1 ? "funnel" : "funnels"} · period · same funnel identity as Cohorts
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: "hsl(var(--primary))" }} /> New
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full" style={{ background: "hsl(210 60% 70%)" }} /> Existing
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((column) => (
                <TableHead
                  key={column.key}
                  className={cn("h-8 cursor-pointer select-none whitespace-nowrap px-3 text-xs", column.className)}
                  onClick={() => toggleSort(column.key)}
                  aria-sort={sort.key === column.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {column.key === "key" ? "Funnel · share of gross" : column.label}
                  {sort.key === column.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.visible.map((row) => (
              <FunnelRow key={row.key} row={row} label={row.key} totalGross={totals.gross} maxGross={view.maxGross} />
            ))}
            {view.other && (
              <FunnelRow row={view.other} label="Other" sub={`· ${view.other.count} funnels`}
                totalGross={totals.gross} maxGross={view.maxGross} muted />
            )}
            {view.pinned.map((row) => (
              <FunnelRow key={row.key} row={row} label={row.key} totalGross={totals.gross} maxGross={view.maxGross} muted />
            ))}
            <TableRow className="border-t-2 border-border bg-muted/20 hover:bg-muted/20">
              <TableCell className="px-3 py-1.5 text-xs font-semibold">Total</TableCell>
              <TableCell className="px-3 py-1.5 text-right font-mono text-xs font-semibold">{usd(totals.gross)}</TableCell>
              <TableCell className="hidden px-3 py-1.5 text-right font-mono text-xs lg:table-cell">{usd(totals.gross_new)}</TableCell>
              <TableCell className="hidden px-3 py-1.5 text-right font-mono text-xs lg:table-cell">{usd(totals.gross_existing)}</TableCell>
              <TableCell className="px-3 py-1.5 text-right font-mono text-xs font-semibold">{usd(totals.net)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      {(canFold || footer) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2">
          <div className="text-xs text-muted-foreground">{footer}</div>
          {canFold && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setExpanded((prev) => !prev)}>
              {expanded ? `Show top ${FUNNEL_TOP_N}` : `Show all ${view.funnelCount} funnels`}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
