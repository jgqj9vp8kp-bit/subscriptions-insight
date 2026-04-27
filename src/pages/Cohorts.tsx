import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  const [trafficSourceFilter, setTrafficSourceFilter] = useState("all");
  const [campaignIdFilter, setCampaignIdFilter] = useState("all");
  const [refundFilter, setRefundFilter] = useState("all");
  const [cohortDateFrom, setCohortDateFrom] = useState("");
  const [cohortDateTo, setCohortDateTo] = useState("");
  const [dateSort, setDateSort] = useState<"desc" | "asc">("desc");

  const trafficSourceOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.traffic_source))).sort(), [txs]);
  const campaignIdOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.campaign_id || "unknown"))).sort(), [txs]);
  const sourceFilteredTxs = useMemo(
    () =>
      txs.filter((t) => {
        if (trafficSourceFilter !== "all" && t.traffic_source !== trafficSourceFilter) return false;
        if (campaignIdFilter !== "all" && (t.campaign_id || "unknown") !== campaignIdFilter) return false;
        return true;
      }),
    [txs, trafficSourceFilter, campaignIdFilter]
  );
  const allCohorts = useMemo(() => computeCohorts(sourceFilteredTxs), [sourceFilteredTxs]);
  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.funnel))).sort(), [allCohorts]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.campaign_path))).sort(), [allCohorts]);
  const cohorts = useMemo(
    () =>
      allCohorts.filter((c) => {
        if (funnelFilter !== "all" && c.funnel !== funnelFilter) return false;
        if (campaignPathFilter !== "all" && c.campaign_path !== campaignPathFilter) return false;
        if (refundFilter === "has" && c.refund_users === 0) return false;
        if (refundFilter === "none" && c.refund_users > 0) return false;
        if (cohortDateFrom && c.cohort_date < cohortDateFrom) return false;
        if (cohortDateTo && c.cohort_date > cohortDateTo) return false;
        return true;
      }).sort((a, b) => {
        const cmp = a.cohort_date < b.cohort_date ? -1 : a.cohort_date > b.cohort_date ? 1 : 0;
        return dateSort === "asc" ? cmp : -cmp;
      }),
    [allCohorts, funnelFilter, campaignPathFilter, refundFilter, cohortDateFrom, cohortDateTo, dateSort]
  );
  const hasUsers = useMemo(() => new Set(txs.map((t) => t.user_id)).size > 0, [txs]);

  const maxUpsellCR = Math.max(0, ...cohorts.map((c) => c.trial_to_upsell_cr));
  const maxSubCR = Math.max(0, ...cohorts.map((c) => c.trial_to_first_subscription_cr));
  const maxRenewal2CR = Math.max(0, ...cohorts.map((c) => c.first_subscription_to_renewal_2_cr));
  const maxRenewal3CR = Math.max(0, ...cohorts.map((c) => c.renewal_2_to_renewal_3_cr));
  const totals = useMemo(() => {
    const sum = (pick: (c: (typeof cohorts)[number]) => number) =>
      cohorts.reduce((total, cohort) => total + pick(cohort), 0);
    const totalTrialUsers = sum((c) => c.trial_users);
    const totalUpsellUsers = sum((c) => c.upsell_users);
    const totalFirstSubscriptionUsers = sum((c) => c.first_subscription_users);
    const totalRenewal2Users = sum((c) => c.renewal_2_users);
    const totalRenewal3Users = sum((c) => c.renewal_3_users);
    const totalRenewalUsers = sum((c) => c.renewal_users);
    const totalRefundUsers = new Set(cohorts.flatMap((c) => c.refunded_user_ids)).size;
    const totalRevenue = sum((c) => c.revenue_total);
    const amountRefunded = sum((c) => c.amount_refunded);
    const grossRevenue = sum((c) => c.gross_revenue);
    const netRevenue = sum((c) => c.net_revenue);
    const revenueD7 = sum((c) => c.revenue_d7);
    const revenueD14 = sum((c) => c.revenue_d14);
    const revenueD30 = sum((c) => c.revenue_d30);
    return {
      totalTrialUsers,
      totalUpsellUsers,
      totalFirstSubscriptionUsers,
      totalRenewal2Users,
      totalRenewal3Users,
      totalRenewalUsers,
      totalRefundUsers,
      trialRevenue: sum((c) => c.trial_revenue),
      upsellRevenue: sum((c) => c.upsell_revenue),
      firstSubscriptionRevenue: sum((c) => c.first_subscription_revenue),
      renewalRevenue: sum((c) => c.renewal_revenue),
      amountRefunded,
      refundRate: totalTrialUsers ? (totalRefundUsers / totalTrialUsers) * 100 : 0,
      grossRevenue,
      netRevenue,
      grossLtv: totalTrialUsers ? grossRevenue / totalTrialUsers : 0,
      netLtv: totalTrialUsers ? netRevenue / totalTrialUsers : 0,
      revenueD0: sum((c) => c.revenue_d0),
      revenueD7,
      revenueD14,
      revenueD30,
      revenueD37: sum((c) => c.revenue_d37),
      revenueD67: sum((c) => c.revenue_d67),
      totalRevenue,
      averageLtv: totalTrialUsers ? totalRevenue / totalTrialUsers : 0,
      ltvD7: totalTrialUsers ? revenueD7 / totalTrialUsers : 0,
      ltvD14: totalTrialUsers ? revenueD14 / totalTrialUsers : 0,
      ltvD30: totalTrialUsers ? revenueD30 / totalTrialUsers : 0,
      trialToUpsellCr: totalTrialUsers ? (totalUpsellUsers / totalTrialUsers) * 100 : 0,
      trialToFirstSubscriptionCr: totalTrialUsers ? (totalFirstSubscriptionUsers / totalTrialUsers) * 100 : 0,
      firstSubscriptionToRenewal2Cr: totalFirstSubscriptionUsers ? (totalRenewal2Users / totalFirstSubscriptionUsers) * 100 : 0,
      renewal2ToRenewal3Cr: totalRenewal2Users ? (totalRenewal3Users / totalRenewal2Users) * 100 : 0,
    };
  }, [cohorts]);

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
          <Select value={trafficSourceFilter} onValueChange={setTrafficSourceFilter}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Traffic source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All traffic</SelectItem>
              {trafficSourceOptions.map((source) => (
                <SelectItem key={source} value={source}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignIdFilter} onValueChange={setCampaignIdFilter}>
            <SelectTrigger className="h-9 w-[190px]"><SelectValue placeholder="Campaign ID" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign IDs</SelectItem>
              {campaignIdOptions.map((id) => (
                <SelectItem key={id} value={id}>{id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={refundFilter} onValueChange={setRefundFilter}>
            <SelectTrigger className="h-9 w-[150px]"><SelectValue placeholder="Refund" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All refunds</SelectItem>
              <SelectItem value="has">Has refunds</SelectItem>
              <SelectItem value="none">No refunds</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-date-from" className="text-xs text-muted-foreground">Cohort date from</Label>
            <Input
              id="cohort-date-from"
              type="date"
              value={cohortDateFrom}
              onChange={(e) => setCohortDateFrom(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="cohort-date-to" className="text-xs text-muted-foreground">Cohort date to</Label>
            <Input
              id="cohort-date-to"
              type="date"
              value={cohortDateTo}
              onChange={(e) => setCohortDateTo(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="sticky left-0 bg-card z-10">Cohort</TableHead>
                <TableHead className="whitespace-nowrap">
                  <button
                    onClick={() => setDateSort((s) => (s === "desc" ? "asc" : "desc"))}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Cohort date {dateSort === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                  </button>
                </TableHead>
                <TableHead>Campaign path</TableHead>
                <TableHead>Funnel</TableHead>
                <TableHead className="text-right">Trial</TableHead>
                <TableHead className="text-right">Upsell</TableHead>
                <TableHead className="text-right">First Sub</TableHead>
                <TableHead className="text-right">→ Upsell CR</TableHead>
                <TableHead className="text-right">→ Sub CR</TableHead>
                <TableHead className="text-right">Sub → Renewal 2 CR</TableHead>
                <TableHead className="text-right">Renewal 2 → 3 CR</TableHead>
                <TableHead className="text-right">Renewal 2</TableHead>
                <TableHead className="text-right">Renewal 3</TableHead>
                <TableHead className="text-right">Total Renewals</TableHead>
                <TableHead className="text-right">Refund Users</TableHead>
                <TableHead className="text-right">Amount Refunded</TableHead>
                <TableHead className="text-right">Refund Rate</TableHead>
                <TableHead className="text-right">Gross Revenue</TableHead>
                <TableHead className="text-right">Net Revenue</TableHead>
                <TableHead className="text-right">Gross LTV</TableHead>
                <TableHead className="text-right">Net LTV</TableHead>
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
                <TableHead className="text-right">LTV Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((c) => (
                <TableRow key={c.cohort_id}>
                  <TableCell className="sticky left-0 bg-card z-10 font-medium text-sm whitespace-nowrap">
                    {c.cohort_id}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">{c.cohort_date}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{c.campaign_path}</TableCell>
                  <TableCell className="text-xs text-muted-foreground capitalize whitespace-nowrap">{c.funnel.replace("_", " ")}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.trial_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.upsell_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.first_subscription_users}</TableCell>
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
                  <TableCell className="text-right tabular-nums text-sm">{c.renewal_2_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.renewal_3_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.renewal_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{c.refund_users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.amount_refunded)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatPct(c.refund_rate)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.gross_revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.net_revenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.gross_ltv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.net_ltv)}</TableCell>
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
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(c.trial_users ? c.revenue_total / c.trial_users : 0)}</TableCell>
                </TableRow>
              ))}
              {cohorts.length > 0 && (
                <TableRow className="border-t-2 border-border bg-muted/50 font-semibold">
                  <TableCell className="sticky left-0 bg-muted z-10 text-sm whitespace-nowrap">Total</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-xs text-muted-foreground">—</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalTrialUsers}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalUpsellUsers}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalFirstSubscriptionUsers}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatPct(totals.trialToUpsellCr)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatPct(totals.trialToFirstSubscriptionCr)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatPct(totals.firstSubscriptionToRenewal2Cr)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatPct(totals.renewal2ToRenewal3Cr)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalRenewal2Users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalRenewal3Users}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalRenewalUsers}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{totals.totalRefundUsers}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.amountRefunded)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatPct(totals.refundRate)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.grossRevenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.netRevenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.grossLtv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.netLtv)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.revenueD0)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.revenueD7)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.revenueD14)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.revenueD30)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.revenueD37)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.revenueD67)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.totalRevenue)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.ltvD7)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.ltvD14)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.ltvD30)}</TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{formatCurrency(totals.averageLtv)}</TableCell>
                </TableRow>
              )}
              {cohorts.length === 0 && (
                <TableRow>
                  <TableCell colSpan={32} className="text-center text-sm text-muted-foreground py-10">
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
