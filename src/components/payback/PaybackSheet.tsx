// The Payback drilldown (spec 2026-10-24 §4): one funnel (or Total / the small
// funnels) in a side sheet — the revenue-per-trial curve, solid while observed
// and dashed once partly projected, against the cost per trial with the month
// guides and the payback dot; the break-even cost per month; a what-if cost
// per trial (local, never saved); the same funnel by trial month; and where
// every number comes from.
import { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { ChartContainer, ChartTooltip, type ChartConfig } from "@/components/ui/chart";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  PAYBACK_SMALL_FUNNELS_KEY,
  PAYBACK_TOTAL_KEY,
  paybackRoasTint,
  paybackWhatIf,
  type PaybackMonthIndex,
  type PaybackResult,
  type PaybackRow,
  type PaybackSpendInput,
  type PaybackWindow,
} from "@/services/ltvPayback";
import { InfoTip } from "@/components/payback/InfoTip";
import { MonthCellValue, VerdictBadge } from "@/components/payback/PaybackParts";
import { PAYBACK_MONTHS, TINT_CLASS, monthTintClass, paybackChartData, type PaybackChartPoint } from "@/components/payback/paybackView";
import { PAYBACK_COPY } from "@/components/payback/paybackCopy";
import { DASH, approxPrefix, fmtDay, fmtInt, fmtMoney, fmtMoneyCents, fmtMonth, fmtRoas, fmtShare } from "@/components/payback/paybackFormat";

const COPY = PAYBACK_COPY.sheet;

const GUIDE_DAYS = [30, 60, 90] as const;

export interface PaybackTrendEntry {
  window: PaybackWindow;
  row: PaybackRow | null;
  loading: boolean;
}

export interface PaybackSheetProps {
  /** The row in the drilldown; null closes the sheet. */
  row: PaybackRow | null;
  label: string;
  result: PaybackResult;
  spend: PaybackSpendInput | null;
  trend: PaybackTrendEntry[];
  onClose: () => void;
}

const CHART_CONFIG: ChartConfig = {
  solid: { label: COPY.chartObserved, color: "hsl(var(--primary))" },
  dashed: { label: COPY.chartProjected, color: "hsl(var(--primary))" },
};

function Stat({ label, value, info }: { label: string; value: string; info?: string }) {
  return (
    <div className="min-w-0 rounded-md border border-border px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <span className="truncate">{label}</span>
        {info && <InfoTip label={PAYBACK_COPY.aria.about(label)}>{info}</InfoTip>}
      </div>
      <div className="truncate text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

/** One key entry: a short line in the series' colour and stroke, then its name. */
function LegendItem({ label, color, dashed }: { label: string; color: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden="true" className="shrink-0">
        <line x1="0" y1="3" x2="18" y2="3" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "4 3" : undefined} />
      </svg>
      {label}
    </span>
  );
}

function PaybackCurve({ row, whatIf }: { row: PaybackRow; whatIf: number | null }) {
  const data = useMemo(() => paybackChartData(row), [row]);
  const top = Math.max(0, ...data.map((point) => point.ltv ?? 0), row.cpt ?? 0, whatIf ?? 0) * 1.1 || 1;
  return (
    <ChartContainer config={CHART_CONFIG} className="h-56 w-full" data-testid="payback-curve">
      <ComposedChart data={data} margin={{ left: 4, right: 12, top: 12, bottom: 0 }}>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" type="number" domain={[0, 90]} ticks={[0, 7, 14, 30, 45, 60, 75, 90]} tickLine={false} axisLine={false} fontSize={11} />
        <YAxis domain={[0, top]} tickLine={false} axisLine={false} fontSize={11} width={52} tickFormatter={(value: number) => fmtMoney(value)} />
        <ChartTooltip
          content={({ active, payload }) => {
            const point = active ? (payload?.[0]?.payload as PaybackChartPoint | undefined) : undefined;
            if (!point) return null;
            return (
              <div className="rounded-md border bg-background px-2 py-1 text-xs shadow-md">
                <div className="font-medium">{COPY.chartDay(point.day)}</div>
                <div>{approxPrefix(point.approx)}{fmtMoneyCents(point.ltv)}</div>
              </div>
            );
          }}
        />
        {GUIDE_DAYS.map((day, index) => (
          <ReferenceLine key={day} x={day} stroke="hsl(var(--muted-foreground))" strokeOpacity={0.4} strokeDasharray="2 4" label={{ value: PAYBACK_COPY.table.month((index + 1) as PaybackMonthIndex), fontSize: 10, position: "insideTopLeft" }} />
        ))}
        {row.cpt !== null && (
          <ReferenceLine y={row.cpt} stroke="hsl(var(--destructive))" strokeDasharray="4 4" label={{ value: COPY.chartCpt, fontSize: 10, position: "insideBottomRight" }} />
        )}
        {whatIf !== null && (
          <ReferenceLine y={whatIf} stroke="hsl(var(--warning))" strokeDasharray="4 4" label={{ value: COPY.chartWhatIf, fontSize: 10, position: "insideTopRight" }} />
        )}
        <Line type="linear" dataKey="solid" stroke="var(--color-solid)" strokeWidth={2} dot={false} connectNulls={false} isAnimationActive={false} />
        <Line type="linear" dataKey="dashed" stroke="var(--color-dashed)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} />
        {row.paybackDay !== null && row.cpt !== null && <ReferenceDot x={row.paybackDay} y={row.cpt} r={4} fill="hsl(var(--primary))" stroke="hsl(var(--background))" />}
      </ComposedChart>
    </ChartContainer>
  );
}

/** What the strokes mean: solid is received, dashed is partly projected, and
 * the reference lines. Only the entries the chart draws. */
function PaybackCurveLegend({ row, whatIf }: { row: PaybackRow; whatIf: number | null }) {
  const projected = row.curve.some((point) => point.approx);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" aria-label={COPY.chartLegend} data-testid="payback-curve-legend">
      <LegendItem label={COPY.chartObserved} color="hsl(var(--primary))" />
      {projected && <LegendItem label={COPY.chartProjected} color="hsl(var(--primary))" dashed />}
      {row.cpt !== null && <LegendItem label={COPY.chartCpt} color="hsl(var(--destructive))" dashed />}
      {whatIf !== null && <LegendItem label={COPY.chartWhatIf} color="hsl(var(--warning))" dashed />}
    </div>
  );
}

function MonthsTable({ row }: { row: PaybackRow }) {
  return (
    <table className="w-full table-fixed text-xs" data-testid="payback-months">
      <thead>
        <tr className="text-muted-foreground">
          <th className="w-[40%] py-1 text-left font-medium" />
          {PAYBACK_MONTHS.map((month) => <th key={month} className="py-1 text-right font-medium">{PAYBACK_COPY.table.month(month)}</th>)}
        </tr>
      </thead>
      <tbody className="tabular-nums">
        <tr className="border-t border-border" data-testid="payback-break-even">
          <td className="py-1.5">
            <span className="inline-flex items-center gap-1">{COPY.breakEven}<InfoTip label={PAYBACK_COPY.aria.breakEven}>{COPY.breakEvenInfo}</InfoTip></span>
          </td>
          {row.months.map((month) => <td key={month.month} className="py-1.5 text-right font-medium">{month.ltv === null ? DASH : `${approxPrefix(month.approx)}${fmtMoneyCents(month.breakEvenCpt)}`}</td>)}
        </tr>
        <tr className="border-t border-border">
          <td className="py-1.5">{COPY.monthsHeaders[2]}</td>
          {row.months.map((month) => (
            <td key={month.month} className={cn("px-1 py-1.5 text-right", monthTintClass(month))}><MonthCellValue month={month} show="back" /></td>
          ))}
        </tr>
        <tr className="border-t border-border">
          <td className="py-1.5">{COPY.monthsHeaders[3]}</td>
          {row.months.map((month) => <td key={month.month} className="py-1.5 text-right text-muted-foreground">{fmtShare(month.observedShare)}</td>)}
        </tr>
      </tbody>
    </table>
  );
}

function WhatIf({ row, value, onChange }: { row: PaybackRow; value: string; onChange: (value: string) => void }) {
  const cpt = Number(value);
  const result = value.trim() === "" ? null : paybackWhatIf(row, cpt);
  return (
    <section className="space-y-2" data-testid="payback-what-if">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs font-medium" htmlFor="payback-what-if-input">{COPY.whatIf}</label>
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">$</span>
          <Input
            id="payback-what-if-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={value}
            placeholder={row.cpt === null ? "" : row.cpt.toFixed(2)}
            aria-label={COPY.whatIfLabel}
            onChange={(event) => onChange(event.target.value)}
            className="h-8 w-[110px] pl-5 text-xs"
          />
        </div>
        {result && <Badge variant="outline" className="text-[10px] font-normal">{COPY.whatIfBadge}</Badge>}
      </div>
      {result ? (
        <div className="flex flex-wrap items-center gap-2 text-xs" data-testid="payback-what-if-result">
          {result.months.map((month) => {
            const tint = paybackRoasTint(month.roas);
            return (
              <span key={month.month} className={cn("rounded-md border border-border px-2 py-1 tabular-nums", tint && TINT_CLASS[tint])}>
                {PAYBACK_COPY.table.month(month.month)}: {month.roas === null ? DASH : `${approxPrefix(month.approx)}${fmtRoas(month.roas)}`}
              </span>
            );
          })}
          <VerdictBadge status={result.status} />
          {result.paybackDay !== null && <span className="text-muted-foreground">{COPY.paybackDayValue(result.paybackDay)}</span>}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{COPY.whatIfHint}</p>
      )}
    </section>
  );
}

function TrendTable({ trend }: { trend: PaybackTrendEntry[] }) {
  return (
    <section className="space-y-1.5" data-testid="payback-trend">
      <h3 className="flex items-center gap-1 text-xs font-semibold">{COPY.trendTitle}<InfoTip label={PAYBACK_COPY.aria.trend}>{COPY.trendInfo}</InfoTip></h3>
      <table className="w-full table-fixed text-xs">
        <colgroup>
          <col className="w-[72px]" />
          <col className="w-[52px]" />
          <col className="w-[72px]" />
          <col className="w-[60px]" />
          <col className="w-[60px]" />
          <col className="w-[60px]" />
          {/* The verdict takes the rest: "Not within 3 months · 64% back" stays on one or two lines. */}
          <col />
        </colgroup>
        <thead>
          <tr className="text-muted-foreground">
            {COPY.trendHeaders.map((header, index) => <th key={header} className={cn("py-1 font-medium", index === 0 || index === 6 ? "text-left" : "text-right", index === 6 && "pl-2")}>{header}</th>)}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {trend.map((entry) => (
            <tr key={entry.window.from} className="border-t border-border" data-testid="payback-trend-row">
              <td className="py-1">{fmtMonth(entry.window.from)}</td>
              {entry.loading ? (
                <td colSpan={6} className="py-1 text-muted-foreground">{COPY.trendLoading}</td>
              ) : !entry.row || entry.row.trials === 0 ? (
                <td colSpan={6} className="py-1 text-muted-foreground">{COPY.trendNoTrials}</td>
              ) : (
                <>
                  <td className="py-1 text-right">{fmtInt(entry.row.trials)}</td>
                  <td className="py-1 text-right">{fmtMoneyCents(entry.row.cpt)}</td>
                  {entry.row.months.map((month) => (
                    <td key={month.month} className={cn("px-1 py-1 text-right", monthTintClass(month))}><MonthCellValue month={month} show="back" /></td>
                  ))}
                  <td className="py-1 pl-2"><VerdictBadge status={entry.row.status} /></td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Sources({ row, result, spend }: { row: PaybackRow; result: PaybackResult; spend: PaybackSpendInput | null }) {
  const [open, setOpen] = useState(false);
  const evaluated = result.evaluatedWindow;
  const gapDays = spend && evaluated ? spend.knownGapDays.filter((day) => day >= evaluated.from && day <= evaluated.to).length : 0;
  const lines: string[] = [];
  lines.push(row.spend !== null && row.spendRaw !== null ? COPY.spendLine(fmtMoney(row.spendRaw), fmtMoney(row.spend), result.agencyFee.enabled) : COPY.spendUnknown);
  if (row.key === PAYBACK_TOTAL_KEY && result.unlinkedSpend !== null && result.unlinkedSpend > 0) lines.push(COPY.unlinkedLine(fmtMoney(result.unlinkedSpend)));
  if (spend) lines.push(COPY.gapsLine(gapDays));
  if (!row.noSpendReasons.includes("mixed_currency") && !row.noSpendReasons.includes("non_usd_currency")) lines.push(COPY.currencyLine);
  // A row that is not evaluated has no trials a spend window covers.
  if (evaluated && row.evaluated) lines.push(COPY.trialsLine(fmtDay(evaluated.from), fmtDay(evaluated.to)));
  if (row.trialsAfterSpendThrough > 0 && result.spendThrough) lines.push(COPY.afterLine(row.trialsAfterSpendThrough, fmtDay(result.spendThrough)));
  if (result.dataThrough) lines.push(COPY.paymentsLine(fmtDay(result.dataThrough)));
  lines.push(COPY.revenueLine);
  for (const month of row.months) {
    let line = COPY.monthLine(month.month, fmtShare(month.observedShare));
    if (month.source !== null) line += COPY.sourceLine(PAYBACK_COPY.sources[month.source], month.poolTrials);
    if (month.rough) line += COPY.roughLine;
    lines.push(line);
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted/50">
        {COPY.sourcesTitle}
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-180")} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground" data-testid="payback-sources">
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function SheetBody({ row, label, result, spend, trend }: Omit<PaybackSheetProps, "onClose"> & { row: PaybackRow }) {
  const [whatIf, setWhatIf] = useState("");
  const whatIfCpt = Number(whatIf);
  const whatIfLine = whatIf.trim() !== "" && Number.isFinite(whatIfCpt) && whatIfCpt > 0 ? whatIfCpt : null;
  const isAggregate = row.key === PAYBACK_TOTAL_KEY || row.key === PAYBACK_SMALL_FUNNELS_KEY;
  // A funnel shows its path under a registry name (an unnamed one has the path
  // as its title already); Total and the small funnels say how many funnels.
  const subtitle = isAggregate ? PAYBACK_COPY.table.totalFunnels(row.paths.length) : label !== row.key ? row.key : "";
  return (
    <div className="space-y-4">
      <SheetHeader className="space-y-1 text-left">
        <SheetTitle className="flex flex-wrap items-center gap-2 pr-6 text-base">
          <span className="min-w-0 truncate">{label}</span>
          <VerdictBadge status={row.status} />
        </SheetTitle>
        <SheetDescription className="truncate text-xs">
          {subtitle}
          {result.revenueWindow ? `${subtitle ? " · " : ""}${fmtDay(result.revenueWindow.from)} – ${fmtDay(result.revenueWindow.to)}` : ""}
        </SheetDescription>
      </SheetHeader>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={COPY.trials} value={fmtInt(row.trials)} />
        <Stat label={COPY.spend} value={fmtMoney(row.spend)} />
        <Stat label={COPY.cpt} value={fmtMoneyCents(row.cpt)} />
        <Stat label={COPY.paybackDay} value={row.paybackDay !== null ? COPY.paybackDayValue(row.paybackDay) : row.cpt === null ? DASH : COPY.paybackDayNone} info={COPY.paybackDayInfo} />
      </div>

      {row.status.kind === "no_spend_data" && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs" data-testid="payback-no-spend">
          <div className="font-medium">{COPY.noSpendTitle}</div>
          <ul className="mt-1 list-disc pl-4">
            {row.status.reasons.map((reason) => <li key={reason}>{PAYBACK_COPY.reasons[reason]}</li>)}
          </ul>
        </div>
      )}

      <section className="space-y-1">
        <h3 className="text-xs font-semibold">{COPY.chartTitle}</h3>
        <PaybackCurve row={row} whatIf={whatIfLine} />
        <PaybackCurveLegend row={row} whatIf={whatIfLine} />
      </section>

      <MonthsTable row={row} />
      <WhatIf row={row} value={whatIf} onChange={setWhatIf} />
      <TrendTable trend={trend} />
      <Sources row={row} result={result} spend={spend} />
    </div>
  );
}

export function PaybackSheet({ row, label, result, spend, trend, onClose }: PaybackSheetProps) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto p-4 sm:max-w-2xl"
        data-testid="payback-sheet"
        // Radix would focus the first tabbable — the verdict badge's tooltip
        // trigger in the title — and open its tooltip, so the first Escape only
        // closed that. Focus the sheet itself instead.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        <TooltipProvider delayDuration={150}>
          {/* Keyed on the row: the what-if never carries over to another funnel. */}
          {row && <SheetBody key={row.key} row={row} label={label} result={result} spend={spend} trend={trend} />}
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
