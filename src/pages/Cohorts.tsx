import { useMemo, useState } from "react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  const [funnelFilter, setFunnelFilter] = useState("all");
  const [campaignPathFilter, setCampaignPathFilter] = useState("all");

  const allCohorts = useMemo(() => computeCohorts(txs), [txs]);
  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.funnel))).sort(), [allCohorts]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.campaign_path))).sort(), [allCohorts]);
  const cohorts = useMemo(
    () =>
      allCohorts.filter((c) => {
        if (funnelFilter !== "all" && c.funnel !== funnelFilter) return false;
        if (campaignPathFilter !== "all" && c.campaign_path !== campaignPathFilter) return false;
        return true;
      }),
    [allCohorts, funnelFilter, campaignPathFilter]
  );
  const hasUsers = useMemo(() => new Set(txs.map((t) => t.user_id)).size > 0, [txs]);

  const maxUpsellCR = Math.max(0, ...cohorts.map((c) => c.trial_to_upsell_cr));
  const maxSubCR = Math.max(0, ...cohorts.map((c) => c.trial_to_first_subscription_cr));
  const maxRenewal2CR = Math.max(0, ...cohorts.map((c) => c.first_subscription_to_renewal_2_cr));
  const maxRenewal3CR = Math.max(0, ...cohorts.map((c) => c.renewal_2_to_renewal_3_cr));

  return (
    <AppLayout title="Cohorts" description="Grouped by trial date">
      <Card className="p-4 shadow-card">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Select value={funnelFilter} onValueChange={setFunnelFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              {funnelOptions.map((f) => (
                <SelectItem key={f} value={f}>{f.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignPathFilter} onValueChange={setCampaignPathFilter}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card z-10">Cohort</TableHead>
                <TableHead>Campaign path</TableHead>
                <TableHead>Funnel</TableHead>
                <TableHead className="text-right">Trial</TableHead>
                <TableHead className="text-right">Upsell</TableHead>
                <TableHead className="text-right">First Sub</TableHead>
                <TableHead className="text-right">Renewal 2</TableHead>
                <TableHead className="text-right">Renewal 3</TableHead>
                <TableHead className="text-right">Total Renewals</TableHead>
                <TableHead className="text-right">→ Upsell CR</TableHead>
                <TableHead className="text-right">→ Sub CR</TableHead>
                <TableHead className="text-right">Sub → Renewal 2 CR</TableHead>
                <TableHead className="text-right">Renewal 2 → 3 CR</TableHead>
                <TableHead className="text-right">Rev D0</TableHead>
                <TableHead className="text-right">Rev D7</TableHead>
                <TableHead className="text-right">Rev D14</TableHead>
                <TableHead className="text-right">Rev D30</TableHead>
                <TableHead className="text-right">Rev D37</TableHead>
                <TableHead className="text-right">Rev D67</TableHead>
                <TableHead className="text-right">Rev Total</TableHead>
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
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{c.campaign_path}</TableCell>
                  <TableCell className="text-xs text-muted-foreground capitalize whitespace-nowrap">{c.funnel.replace("_", " ")}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.trial_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.upsell_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.first_subscription_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.renewal_2_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.renewal_3_users}</TableCell>
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
                  <TableCell
                    className="text-right tabular-nums text-sm font-medium"
                    style={heatStyle(c.first_subscription_to_renewal_2_cr, maxRenewal2CR)}
                  >
                    {formatPct(c.first_subscription_to_renewal_2_cr)}
                  </TableCell>
                  <TableCell
                    className="text-right tabular-nums text-sm font-medium"
                    style={heatStyle(c.renewal_2_to_renewal_3_cr, maxRenewal3CR)}
                  >
                    {formatPct(c.renewal_2_to_renewal_3_cr)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d0)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d7)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d14)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d30)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d37)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_d67)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.revenue_total)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.ltv_d7)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.ltv_d14)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.ltv_d30)}</TableCell>
                </TableRow>
              ))}
              {cohorts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={23} className="text-center text-sm text-muted-foreground py-10">
                    {hasUsers && allCohorts.length === 0
                      ? "No cohorts found. Check whether trial transactions were detected."
                      : "No cohorts to display."}
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
