// Project-level combined cash-flow chart (P5) — the DAY axis, not periods.
//
// Funnels with different cadences cannot share a period axis (weekly P4 = day
// 35, monthly P4 = day 150), so the project curve is the stacked day grid from
// the aggregator: Σ cumulative payment-net evaluated at every boundary day.
// Solid up to the shortest funnel horizon, dashed after (the stack understates
// growth once any funnel's timeline ends — a payback past that day is
// conservative-valid, a no-payback verdict is untrustworthy and says so in the
// aggregator's gates). Thresholds are the two payback lines: Σ traffic outflow
// and the fully-loaded total (+ bonus + overhead pool + extras).
import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatCurrency } from "@/services/analytics";
import type { ProjectTotals } from "@/services/funnelEconomics";

const CHART_CONFIG: ChartConfig = {
  solid: { label: "Cumulative payment-net", color: "hsl(var(--primary))" },
  dashed: { label: "Past shortest horizon", color: "hsl(var(--primary))" },
};

export function ProjectCashFlowChart({ totals }: { totals: ProjectTotals }) {
  const { grid } = totals;
  const data = useMemo(() => {
    const short = grid.shortestHorizonDay;
    return grid.points.map((point) => ({
      day: point.day,
      solid: point.day <= short ? point.total : null,
      dashed: point.day >= short ? point.total : null,
    }));
  }, [grid]);

  const trafficThreshold = totals.trafficCashOutflow;
  const fullThreshold = trafficThreshold === null
    ? null
    : trafficThreshold + totals.performanceBonus + totals.allocatedOverhead + totals.extraTotal;

  if (grid.points.length === 0) {
    return (
      <Card className="p-4 shadow-card">
        <h3 className="mb-1 text-sm font-semibold">Combined cumulative payment-net (day axis)</h3>
        <p className="text-xs text-muted-foreground">No forecastable funnels in the selection.</p>
      </Card>
    );
  }

  return (
    <Card className="p-4 shadow-card">
      <h3 className="mb-1 text-sm font-semibold">Combined cumulative payment-net (day axis)</h3>
      <p className="mb-2 text-xs text-muted-foreground">
        All funnels stacked from a common Day 0. Dashed past day {grid.shortestHorizonDay} — the shortest funnel horizon
        {grid.endedSeries.length > 0 ? ` (${grid.endedSeries.map((series) => series.id).join(", ")} end first)` : ""}.
      </p>
      <ChartContainer config={CHART_CONFIG} className="h-72 w-full">
        <ComposedChart data={data} margin={{ left: 12, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="day" type="number" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value: number) => `D${value}`} />
          <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value: number) => formatCurrency(value)} width={90} />
          <ChartTooltip content={<ChartTooltipContent />} />
          {trafficThreshold !== null && (
            <ReferenceLine y={trafficThreshold} stroke="hsl(var(--destructive))" strokeDasharray="4 4" label={{ value: "traffic", fontSize: 10, position: "insideTopRight" }} />
          )}
          {fullThreshold !== null && (
            <ReferenceLine y={fullThreshold} stroke="hsl(var(--warning))" strokeDasharray="4 4" label={{ value: "fully loaded", fontSize: 10, position: "insideBottomRight" }} />
          )}
          {totals.paybackTrafficOnlyDay !== null && (
            <ReferenceLine x={totals.paybackTrafficOnlyDay} stroke="hsl(var(--destructive))" strokeOpacity={0.5} label={{ value: `D${totals.paybackTrafficOnlyDay}`, fontSize: 10, position: "insideTop" }} />
          )}
          {totals.paybackFullyLoadedDay !== null && (
            <ReferenceLine x={totals.paybackFullyLoadedDay} stroke="hsl(var(--warning))" strokeOpacity={0.6} label={{ value: `D${totals.paybackFullyLoadedDay}`, fontSize: 10, position: "insideTopLeft" }} />
          )}
          <Line type="stepAfter" dataKey="solid" stroke="var(--color-solid)" strokeWidth={2} dot={false} connectNulls={false} />
          <Line type="stepAfter" dataKey="dashed" stroke="var(--color-dashed)" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
        </ComposedChart>
      </ChartContainer>
    </Card>
  );
}
