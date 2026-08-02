// Cumulative payment-net vs traffic cost — the per-funnel payback chart.
//
// Extracted verbatim from PlanMode (P4): one engine result in, the same Card,
// title, axes and reference line out. The Project tab reuses it inside expanded
// funnel rows; the project-level day-axis chart is a different component.
import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { formatCurrency } from "@/services/analytics";
import type { ForecastResult } from "@/services/funnelEconomics";

const CHART_CONFIG: ChartConfig = {
  cumulative: { label: "Cumulative payment-net", color: "hsl(var(--primary))" },
};

export function ForecastCashFlowChart({ result }: { result: ForecastResult }) {
  const chartData = useMemo(
    () => result.timeline.periods.map((row) => ({ label: row.label, cumulative: row.cumulativePaymentNetRevenue })),
    [result],
  );
  return (
    <Card className="p-4 shadow-card">
      <h3 className="mb-1 text-sm font-semibold">Cumulative payment-net vs traffic cost</h3>
      <p className="mb-2 text-xs text-muted-foreground">Payback = the period where the cumulative line crosses the traffic-cost reference.</p>
      <ChartContainer config={CHART_CONFIG} className="h-64 w-full">
        <ComposedChart data={chartData} margin={{ left: 12, right: 12, top: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
          <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value: number) => formatCurrency(value)} width={90} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <ReferenceLine y={result.costs.trafficCashOutflow} stroke="hsl(var(--destructive))" strokeDasharray="4 4" label={{ value: "traffic cost", fontSize: 10, position: "insideTopRight" }} />
          <Line type="monotone" dataKey="cumulative" stroke="var(--color-cumulative)" strokeWidth={2} dot={false} />
        </ComposedChart>
      </ChartContainer>
    </Card>
  );
}
