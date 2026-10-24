// Projection-by-period table with CSV/XLSX export.
//
// Extracted verbatim from PlanMode (P4): the table renders one engine result's
// timeline with per-period extrapolation badges, and the export mirrors the
// Cohorts-page pattern (BOM for Excel, dynamic xlsx import). Shared by Plan and
// the Project tab's expanded funnel rows — one definition, never a second copy.
// The download itself is the shared src/lib/tableExport.ts (Payback uses it too).
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { downloadTable, type ExportFormat } from "@/lib/tableExport";
import { ProvenanceBadge } from "@/components/forecasting/ProvenanceBadge";
import { fmtInt, fmtMoney, fmtPctValue } from "@/components/forecasting/forecastFormat";
import type { ForecastResult, ProvenanceMap } from "@/services/funnelEconomics";

// Export the projection table (period rows + totals) as CSV/XLSX.
export function buildPlanExportTable(result: ForecastResult): { headers: string[]; rows: Array<Array<string | number>> } {
  const headers = [
    "Period", "Users", "Cumulative retention", "Trial revenue", "Subscription revenue", "Upsell revenue",
    "Token revenue", "Gross revenue", "Stripe", "Refunds", "Provider", "Payment-net", "Cumulative payment-net", "Cash flow",
  ];
  const rows = result.timeline.periods.map((row) => [
    row.label, row.users, row.cumulativeRetention, row.revenue.trial, row.revenue.subscription, row.revenue.upsell,
    row.revenue.token, row.revenue.gross, row.costs.stripe, row.costs.refund, row.costs.provider,
    row.paymentNetRevenue, row.cumulativePaymentNetRevenue, row.cashFlowBalance,
  ]);
  rows.push([
    "TOTAL", result.metrics.trials, "", result.revenue.trialTotal, result.revenue.subscriptionTotal, result.revenue.upsellTotal,
    result.revenue.tokenTotal, result.revenue.grossTotal, result.costs.stripeTotal, result.costs.refundTotal,
    result.costs.providerTotal, result.profitability.paymentNetRevenueTotal, result.profitability.paymentNetRevenueTotal,
    result.payback.finalCashFlowBalance,
  ]);
  return { headers, rows };
}

export async function exportPlanTable(result: ForecastResult, format: ExportFormat): Promise<void> {
  await downloadTable(buildPlanExportTable(result), format, "forecast-plan", "Forecast");
}

export function ForecastPeriodTable({ result, provenance }: { result: ForecastResult; provenance: ProvenanceMap }) {
  return (
    <Card className="p-4 shadow-card">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Projection by period</h3>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void exportPlanTable(result, "csv")}>Export CSV</Button>
          <Button variant="outline" size="sm" onClick={() => void exportPlanTable(result, "xlsx")}>Export XLSX</Button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Period</TableHead>
              <TableHead className="text-right">Users</TableHead>
              <TableHead className="text-right">Retention</TableHead>
              <TableHead className="text-right">Gross</TableHead>
              <TableHead className="text-right">Payment costs</TableHead>
              <TableHead className="text-right">Payment-net</TableHead>
              <TableHead className="text-right">Cumulative</TableHead>
              <TableHead className="text-right">Cash flow</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.timeline.periods.map((row) => (
              <TableRow key={row.index}>
                <TableCell className="font-medium">
                  {row.label}
                  {provenance[`retention.survival[${row.index}]`] === "extrapolated" && (
                    <span className="ml-1.5 align-middle"><ProvenanceBadge provenance="extrapolated" /></span>
                  )}
                </TableCell>
                <TableCell className="text-right">{fmtInt(row.users)}</TableCell>
                <TableCell className="text-right">{fmtPctValue(row.cumulativeRetention)}</TableCell>
                <TableCell className="text-right">{fmtMoney(row.revenue.gross)}</TableCell>
                <TableCell className="text-right">{fmtMoney(row.costs.paymentTotal)}</TableCell>
                <TableCell className="text-right">{fmtMoney(row.paymentNetRevenue)}</TableCell>
                <TableCell className="text-right">{fmtMoney(row.cumulativePaymentNetRevenue)}</TableCell>
                <TableCell className={cn("text-right", row.cashFlowBalance >= 0 ? "text-success" : "text-destructive")}>{fmtMoney(row.cashFlowBalance)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
