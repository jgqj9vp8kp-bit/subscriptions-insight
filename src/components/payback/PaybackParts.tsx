// Small building blocks shared by the Payback table, KPIs and drilldown: the
// verdict badge and the month cell ("≈" with a dotted underline, grey when the
// projection is rough, and a tooltip that says how much of it is projected and
// from what). The rules behind them are in paybackView.ts.
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { paybackStatusTone, type PaybackMonth, type PaybackStatus } from "@/services/ltvPayback";
import { paybackStatusInfo, paybackStatusLabel } from "@/components/payback/paybackCopy";
import { DASH } from "@/components/payback/paybackFormat";
import type { PaybackShow } from "@/components/payback/paybackState";
import { monthCellText, pointExplanation } from "@/components/payback/paybackView";

const TONE_CLASS: Readonly<Record<ReturnType<typeof paybackStatusTone>, string>> = {
  good: "bg-success/15 text-success",
  warn: "bg-warning/15 text-warning",
  bad: "bg-destructive/15 text-destructive",
  muted: "bg-muted text-muted-foreground",
};

/** A hover / focus tooltip around inline content (the table's cells). Inside a
 * TooltipProvider (the table and the sheet bring their own). */
export function HoverTip({ content, children, className }: { content: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <span className={cn("cursor-help", className)} tabIndex={0}>{children}</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[300px] text-xs leading-relaxed">{content}</TooltipContent>
    </Tooltip>
  );
}

export function VerdictBadge({ status, className }: { status: PaybackStatus; className?: string }) {
  const tone = paybackStatusTone(status);
  return (
    <HoverTip content={paybackStatusInfo(status)}>
      <span
        data-testid="payback-verdict"
        data-tone={tone}
        // rounded-lg, not a pill: a long verdict wraps to two lines in the narrow column.
        className={cn("inline-flex max-w-full items-center rounded-lg px-2 py-0.5 text-[11px] font-medium leading-tight", TONE_CLASS[tone], className)}
      >
        {paybackStatusLabel(status)}
      </span>
    </HoverTip>
  );
}

export function MonthCellValue({ month, show }: { month: PaybackMonth; show: PaybackShow }) {
  const text = monthCellText(month, show);
  // Nothing to explain without revenue; a "—" next to known revenue (no spend
  // to compare with) still says what the revenue was.
  if (text === DASH && month.ltv === null) return <span className="text-muted-foreground">{DASH}</span>;
  return (
    <HoverTip
      content={pointExplanation(month, month.roas).map((line) => <p key={line}>{line}</p>)}
      className={cn(
        month.approx && text !== DASH && "underline decoration-dotted decoration-muted-foreground underline-offset-2",
        month.rough && "text-muted-foreground",
      )}
    >
      <span data-testid="payback-month-value" data-approx={month.approx ? "true" : "false"} data-rough={month.rough ? "true" : "false"}>{text}</span>
    </HoverTip>
  );
}
