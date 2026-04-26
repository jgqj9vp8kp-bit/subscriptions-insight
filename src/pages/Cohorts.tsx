import { useMemo } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTransactions } from "@/services/sheets";
import { computeCohorts, formatCurrency, formatPct } from "@/services/analytics";

function heatStyle(value: number, max: number): React.CSSProperties {
  if (max <= 0) return {};
  const intensity = Math.min(1, value / max);
  return {
    background: `hsl(var(--primary) / ${0.05 + intensity * 0.25})`,
    color: intensity > 0.55 ? "hsl(var(--primary))" : undefined,
  };
}

export default function CohortsPage() {
  const txs = useTransactions();

  const cohorts = useMemo(() => computeCohorts(txs), [txs]);

  const maxUpsellCR = Math.max(0, ...cohorts.map((c) => c.trial_to_upsell_cr));
  const maxSubCR = Math.max(0, ...cohorts.map((c) => c.trial_to_first_subscription_cr));

  return (
    <AppLayout title="Cohorts" description="Grouped by trial date">
      <Card className="p-4 shadow-card">
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card z-10">Cohort</TableHead>
                <TableHead className="text-right">Trial</TableHead>
                <TableHead className="text-right">Upsell</TableHead>
                <TableHead className="text-right">First Sub</TableHead>
                <TableHead className="text-right">Renewal</TableHead>
                <TableHead className="text-right">→ Upsell CR</TableHead>
                <TableHead className="text-right">→ Sub CR</TableHead>
                <TableHead className="text-right">Rev D0</TableHead>
                <TableHead className="text-right">Rev D7</TableHead>
                <TableHead className="text-right">Rev D14</TableHead>
                <TableHead className="text-right">Rev D30</TableHead>
                <TableHead className="text-right">LTV D7</TableHead>
                <TableHead className="text-right">LTV D14</TableHead>
                <TableHead className="text-right">LTV D30</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((c) => (
                <TableRow key={c.cohort_id}>
                  <TableCell className="sticky left-0 bg-card z-10 font-medium text-sm whitespace-nowrap">
                    {c.cohort_id}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.trial_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.upsell_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.first_subscription_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.renewal_users}</TableCell>
                  <TableCell
                    className="text-right tabular-nums text-sm font-medium"
                    style={heatStyle(c.trial_to_upsell_cr, maxUpsellCR)}
                  >
                    {formatPct(c.trial_to_upsell_cr)}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums text-sm font-medium"
                    style={heatStyle(c.trial_to_first_subscription_cr, maxSubCR)}
                  >
                    {formatPct(c.trial_to_first_subscription_cr)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d0)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d7)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d14)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d30)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.ltv_d7)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.ltv_d14)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.ltv_d30)}</TableCell>
                </TableRow>
              ))}
              {cohorts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={14} className="text-center text-sm text-muted-foreground py-10">
                    No cohorts to display.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </AppLayout>
  );
}
