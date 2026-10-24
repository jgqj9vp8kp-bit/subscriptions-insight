// The Payback table (spec 2026-10-24 §1, §4): one row per funnel with at least
// 50 trials, Total pinned on top, the small funnels folded into one row at the
// bottom. Month cells show "% of cost back" (or revenue per trial), tinted
// green from 100 % and amber from 80 %; "≈" with a dotted underline when less
// than 95 % of the trials are old enough, grey when the projection is rough.
// Sortable; the default is spend, highest first. A row opens the drilldown.
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { paybackRoasTint, type PaybackAggregateRow, type PaybackResult, type PaybackRow } from "@/services/ltvPayback";
import { InfoTip } from "@/components/payback/InfoTip";
import { MonthCellValue, VerdictBadge } from "@/components/payback/PaybackParts";
import { PAYBACK_COPY } from "@/components/payback/paybackCopy";
import { fmtInt, fmtMoney, fmtMoneyCents } from "@/components/payback/paybackFormat";
import type { PaybackShow, PaybackSort, PaybackSortKey } from "@/components/payback/paybackState";
import { PAYBACK_MONTHS, monthTintClass, paybackRowLabel, sortPaybackRows } from "@/components/payback/paybackView";

const COPY = PAYBACK_COPY.table;

function SortHead({ label, k, sort, onSort, info, align = "right" }: {
  label: string;
  k: PaybackSortKey;
  sort: PaybackSort;
  onSort: (key: PaybackSortKey) => void;
  info?: string;
  align?: "left" | "right";
}) {
  const active = sort.key === k;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn("h-auto px-2 py-1.5 text-[11px] font-medium leading-tight", align === "right" ? "text-right" : "text-left")}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      {/* Narrow columns wrap their label to two lines instead of widening the table. */}
      <span className={cn("inline-flex items-center gap-1", align === "right" && "justify-end")}>
        <button type="button" onClick={() => onSort(k)} className={cn("inline-flex items-center gap-0.5 hover:text-foreground", align === "right" && "text-right")} aria-label={COPY.sortBy(label)}>
          <span>{label}</span>
          {/* Narrow screens show only the active column's arrow; every header still sorts. */}
          <Icon className={cn("h-3 w-3 shrink-0", !active && "hidden opacity-40 xl:inline")} />
        </button>
        {info && <InfoTip label={PAYBACK_COPY.aria.about(label)}>{info}</InfoTip>}
      </span>
    </TableHead>
  );
}

type RowKind = "total" | "funnel" | "small" | "member";

export interface PaybackTableProps {
  result: PaybackResult;
  show: PaybackShow;
  sort: PaybackSort;
  onSort: (key: PaybackSortKey) => void;
  names: ReadonlyMap<string, string>;
  openKey: string | null;
  onOpen: (key: string) => void;
  smallOpen: boolean;
  onToggleSmall: () => void;
  /** Shown under the table (legend, unlinked spend). */
  footer?: ReactNode;
}

export function PaybackTable({ result, show, sort, onSort, names, openKey, onOpen, smallOpen, onToggleSmall, footer }: PaybackTableProps) {
  const rows = sortPaybackRows(result.rows, sort, show, names);
  const smallRows = result.small ? sortPaybackRows(result.small.rows, sort, show, names) : [];

  const nameCell = (row: PaybackRow, kind: RowKind) => {
    const label = paybackRowLabel(row.key, names);
    if (kind === "total") {
      const total = row as PaybackAggregateRow;
      return (
        <span className="flex min-w-0 items-center gap-1.5">
          <button type="button" className="truncate text-left font-semibold hover:underline" aria-label={COPY.openDetails(label)} onClick={(event) => { event.stopPropagation(); onOpen(row.key); }}>
            {label}
          </button>
          <span className="shrink-0 text-[11px] text-muted-foreground">{COPY.totalFunnels(total.paths.length)}</span>
          {total.excludedFunnels > 0 && <InfoTip label={PAYBACK_COPY.aria.excluded}>{COPY.totalExcluded(total.excludedFunnels, total.excludedTrials)}</InfoTip>}
        </span>
      );
    }
    if (kind === "small") {
      const Chevron = smallOpen ? ChevronDown : ChevronRight;
      return (
        <span className="flex min-w-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted"
            aria-expanded={smallOpen}
            aria-label={smallOpen ? COPY.collapse(label.toLowerCase()) : COPY.expand(label.toLowerCase())}
            onClick={(event) => { event.stopPropagation(); onToggleSmall(); }}
          >
            <Chevron className="h-3.5 w-3.5" />
          </button>
          <button type="button" className="truncate text-left font-medium hover:underline" aria-label={COPY.openDetails(label)} onClick={(event) => { event.stopPropagation(); onOpen(row.key); }}>
            {label}
          </button>
          <span className="shrink-0 text-[11px] text-muted-foreground">{COPY.smallHint(result.small?.rows.length ?? 0)}</span>
        </span>
      );
    }
    const named = label !== row.key;
    return (
      <span className={cn("block min-w-0", kind === "member" && "pl-6")}>
        <button type="button" className="block max-w-full truncate text-left font-medium hover:underline" title={named ? `${label} · ${row.key}` : row.key} aria-label={COPY.openDetails(label)} onClick={(event) => { event.stopPropagation(); onOpen(row.key); }}>
          {label}
        </button>
        {named && <span className="block truncate text-[10px] leading-tight text-muted-foreground">{row.key}</span>}
      </span>
    );
  };

  const renderRow = (row: PaybackRow, kind: RowKind) => (
    <TableRow
      key={`${kind}:${row.key}`}
      data-testid={`payback-row-${kind}`}
      data-key={row.key}
      data-state={openKey === row.key ? "selected" : undefined}
      className={cn("cursor-pointer", kind === "total" && "bg-muted/40 hover:bg-muted/60", kind === "member" && "bg-muted/10")}
      onClick={() => onOpen(row.key)}
    >
      <TableCell className="overflow-hidden px-2 py-1.5">{nameCell(row, kind)}</TableCell>
      {/* Trials after the last day of Facebook spend are one line under the
          table and in the drilldown, not a second line in every row. */}
      <TableCell className="px-2 py-1.5 text-right tabular-nums">{fmtInt(row.trials)}</TableCell>
      <TableCell className="px-2 py-1.5 text-right tabular-nums">{fmtMoney(row.spend)}</TableCell>
      <TableCell className="px-2 py-1.5 text-right tabular-nums">{fmtMoneyCents(row.cpt)}</TableCell>
      {row.months.map((month) => (
        <TableCell key={month.month} className={cn("px-2 py-1.5 text-right tabular-nums", monthTintClass(month))} data-testid={`payback-m${month.month}`} data-tint={paybackRoasTint(month.roas) ?? "none"}>
          <MonthCellValue month={month} show={show} />
        </TableCell>
      ))}
      <TableCell className="px-2 py-1.5">
        <VerdictBadge status={row.status} />
      </TableCell>
    </TableRow>
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div className="min-w-0">
        <Table className="table-fixed text-xs" data-testid="payback-table">
          <colgroup>
            <col />
            <col className="w-[64px] xl:w-[72px]" />
            <col className="w-[76px] xl:w-[88px]" />
            <col className="w-[72px] xl:w-[92px]" />
            <col className="w-[66px] xl:w-[84px]" />
            <col className="w-[66px] xl:w-[84px]" />
            <col className="w-[66px] xl:w-[84px]" />
            <col className="w-[128px] xl:w-[176px]" />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <SortHead label={COPY.funnel} k="funnel" sort={sort} onSort={onSort} align="left" />
              <SortHead label={COPY.trials} k="trials" sort={sort} onSort={onSort} info={COPY.trialsInfo} />
              <SortHead label={COPY.spend} k="spend" sort={sort} onSort={onSort} info={COPY.spendInfo} />
              <SortHead label={COPY.cpt} k="cpt" sort={sort} onSort={onSort} info={COPY.cptInfo} />
              {PAYBACK_MONTHS.map((month) => (
                <SortHead key={month} label={COPY.month(month)} k={`m${month}` as PaybackSortKey} sort={sort} onSort={onSort} info={COPY.monthInfo(month, show)} />
              ))}
              <SortHead label={COPY.payback} k="payback" sort={sort} onSort={onSort} info={COPY.paybackInfo} align="left" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {renderRow(result.total, "total")}
            {rows.map((row) => renderRow(row, "funnel"))}
            {result.small && renderRow(result.small.aggregate, "small")}
            {result.small && smallOpen && smallRows.map((row) => renderRow(row, "member"))}
          </TableBody>
        </Table>
        {footer}
      </div>
    </TooltipProvider>
  );
}
