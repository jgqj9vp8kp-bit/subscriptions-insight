import { Fragment, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight } from "lucide-react";
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

// Visual-only helpers — no data/logic impact.
const HEAD_BASE =
  "sticky top-0 z-20 bg-card h-10 px-3 whitespace-nowrap border-b border-border text-xs font-semibold text-muted-foreground";
const HEAD_NUM = `${HEAD_BASE} text-right`;
const CELL_BASE = "py-2 px-3 align-middle";
const CELL_NUM = `${CELL_BASE} text-right tabular-nums whitespace-nowrap text-sm`;
const CELL_TXT = `${CELL_BASE} text-xs text-muted-foreground whitespace-nowrap`;
// Left border marks the start of a logical section (no column reorder).
const SECTION_DIVIDER = "border-l border-border/60";

function heatStyle(value: number, max: number): React.CSSProperties {
  if (max <= 0) return {};
  const intensity = Math.min(1, value / max);
  return {
    background: `hsl(var(--primary) / ${0.05 + intensity * 0.25})`,
    color: intensity > 0.5 ? "hsl(var(--primary))" : undefined,
    fontVariantNumeric: "tabular-nums",
  };
}

export default function CohortsPage() {
  const txs = useTransactions();
  const [expandedCohortIds, setExpandedCohortIds] = useState<Set<string>>(() => new Set());
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
  const toggleExpanded = (cohortId: string) => {
    setExpandedCohortIds((current) => {
      const next = new Set(current);
      if (next.has(cohortId)) next.delete(cohortId);
      else next.add(cohortId);
      return next;
    });
  };

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
        <div className="mb-3 flex flex-wrap items-center gap-2 pb-3 border-b border-border">
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

        <div className="rounded-lg border border-border [&>div]:max-h-[calc(100vh-280px)] [&>div]:overflow-auto [&>div]:rounded-lg">
          <Table className="border-separate border-spacing-0">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead
                  className={`${HEAD_BASE} sticky left-0 z-30 shadow-[1px_0_0_0_hsl(var(--border))] text-left`}
                  style={{ minWidth: 140 }}
                >
                  Cohort
                </TableHead>
                <TableHead className={`${HEAD_BASE} text-left`} style={{ minWidth: 120 }}>
                  <button
                    onClick={() => setDateSort((s) => (s === "desc" ? "asc" : "desc"))}
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    Cohort date {dateSort === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
                  </button>
                </TableHead>
                <TableHead className={`${HEAD_BASE} text-left`} style={{ minWidth: 160 }}>Campaign path</TableHead>
                <TableHead className={`${HEAD_BASE} text-left`} style={{ minWidth: 110 }}>Funnel</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 76 }}>Trial</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 84 }}>Upsell</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>First Sub</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 100 }}>→ Upsell CR</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>→ Sub CR</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 140 }}>Sub → Renewal 2 CR</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 130 }}>Renewal 2 → 3 CR</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 90 }}>Renewal 2</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>Renewal 3</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 110 }}>Total Renewals</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 100 }}>Refund Users</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 120 }}>Amount Refunded</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 100 }}>Refund Rate</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 110 }}>Gross Revenue</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 110 }}>Net Revenue</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 100 }}>Gross LTV</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 100 }}>Net LTV</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 90 }}>Rev D0</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>Rev D7</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>Rev D14</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>Rev D30</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>Rev D37</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>Rev D67</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 100 }}>Rev Total</TableHead>
                <TableHead className={`${HEAD_NUM} ${SECTION_DIVIDER}`} style={{ minWidth: 90 }}>LTV D7</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>LTV D14</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 90 }}>LTV D30</TableHead>
                <TableHead className={HEAD_NUM} style={{ minWidth: 100 }}>LTV Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cohorts.map((c) => {
                const expanded = expandedCohortIds.has(c.cohort_id);
                return (
                  <Fragment key={c.cohort_id}>
                    <TableRow
                      key={c.cohort_id}
                      className="even:bg-muted/20 hover:bg-muted/40 [&>td.sticky]:even:bg-[hsl(var(--card))] [&>td.sticky]:hover:bg-[hsl(var(--muted))]"
                    >
                      <TableCell
                        className={`${CELL_BASE} sticky left-0 bg-card z-10 font-medium text-sm whitespace-nowrap shadow-[1px_0_0_0_hsl(var(--border))]`}
                      >
                        <button
                          type="button"
                          onClick={() => toggleExpanded(c.cohort_id)}
                          className="inline-flex items-center gap-1.5 hover:text-primary"
                          aria-expanded={expanded}
                        >
                          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          {c.cohort_id}
                        </button>
                      </TableCell>
                      <TableCell className={`${CELL_TXT} tabular-nums`}>{c.cohort_date}</TableCell>
                      <TableCell className={CELL_TXT}>{c.campaign_path}</TableCell>
                      <TableCell className={`${CELL_TXT} capitalize`}>{c.funnel.replace("_", " ")}</TableCell>
                      <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{c.trial_users}</TableCell>
                      <TableCell className={CELL_NUM}>{c.upsell_users}</TableCell>
                      <TableCell className={CELL_NUM}>{c.first_subscription_users}</TableCell>
                      <TableCell
                        className={`${CELL_NUM} ${SECTION_DIVIDER} font-medium`}
                        style={heatStyle(c.trial_to_upsell_cr, maxUpsellCR)}
                      >
                        {formatPct(c.trial_to_upsell_cr)}
                      </TableCell>
                      <TableCell
                        className={`${CELL_NUM} font-medium`}
                        style={heatStyle(c.trial_to_first_subscription_cr, maxSubCR)}
                      >
                        {formatPct(c.trial_to_first_subscription_cr)}
                      </TableCell>
                      <TableCell
                        className={`${CELL_NUM} font-medium`}
                        style={heatStyle(c.first_subscription_to_renewal_2_cr, maxRenewal2CR)}
                      >
                        {formatPct(c.first_subscription_to_renewal_2_cr)}
                      </TableCell>
                      <TableCell
                        className={`${CELL_NUM} font-medium`}
                        style={heatStyle(c.renewal_2_to_renewal_3_cr, maxRenewal3CR)}
                      >
                        {formatPct(c.renewal_2_to_renewal_3_cr)}
                      </TableCell>
                      <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{c.renewal_2_users}</TableCell>
                      <TableCell className={CELL_NUM}>{c.renewal_3_users}</TableCell>
                      <TableCell className={CELL_NUM}>{c.renewal_users}</TableCell>
                      <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{c.refund_users}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.amount_refunded)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatPct(c.refund_rate)}</TableCell>
                      <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatCurrency(c.gross_revenue)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.net_revenue)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.gross_ltv)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.net_ltv)}</TableCell>
                      <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatCurrency(c.revenue_d0)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.revenue_d7)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.revenue_d14)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.revenue_d30)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.revenue_d37)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.revenue_d67)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.revenue_total)}</TableCell>
                      <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatCurrency(c.ltv_d7)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.ltv_d14)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.ltv_d30)}</TableCell>
                      <TableCell className={CELL_NUM}>{formatCurrency(c.trial_users ? c.revenue_total / c.trial_users : 0)}</TableCell>
                    </TableRow>
                    {expanded && c.plan_breakdown.length === 0 && (
                      <TableRow className="bg-muted/10 hover:bg-muted/10 [&>td.sticky]:bg-muted/10">
                        <TableCell
                          className={`${CELL_BASE} sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] text-xs italic text-muted-foreground whitespace-nowrap pl-8`}
                        >
                          No price breakdown
                        </TableCell>
                        {Array.from({ length: 31 }).map((_, i) => (
                          <TableCell key={i} className="py-1.5 px-3" />
                        ))}
                      </TableRow>
                    )}
                    {expanded &&
                      c.plan_breakdown.map((plan) => {
                        const CHILD_NUM =
                          "py-1.5 px-3 text-right text-xs text-muted-foreground tabular-nums whitespace-nowrap";
                        const CHILD_NUM_SECTION = `${CHILD_NUM} ${SECTION_DIVIDER}`;
                        const CHILD_TXT = "py-1.5 px-3 text-xs text-muted-foreground/60 whitespace-nowrap";
                        const dash = <span className="text-muted-foreground/40">—</span>;
                        return (
                          <TableRow
                            key={`${c.cohort_id}-plan-${plan.price}`}
                            className="bg-muted/10 hover:bg-muted/20 [&>td.sticky]:bg-muted/10 [&>td.sticky]:hover:bg-muted/20"
                          >
                            <TableCell
                              className={`${CELL_BASE} sticky left-0 z-10 shadow-[1px_0_0_0_hsl(var(--border))] text-xs font-medium text-muted-foreground whitespace-nowrap tabular-nums pl-8`}
                            >
                              {formatCurrency(plan.price)}
                            </TableCell>
                            <TableCell className={CHILD_TXT}>{dash}</TableCell>
                            <TableCell className={CHILD_TXT}>{dash}</TableCell>
                            <TableCell className={CHILD_TXT}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{plan.trial_users}</TableCell>
                            <TableCell className={CHILD_NUM}>{plan.upsell_users}</TableCell>
                            <TableCell className={CHILD_NUM}>{plan.first_subscription_users}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{formatPct(plan.trial_to_upsell_cr)}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatPct(plan.trial_to_first_subscription_cr)}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatPct(plan.first_subscription_to_renewal_2_cr)}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatPct(plan.renewal_2_to_renewal_3_cr)}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{plan.renewal_2_users}</TableCell>
                            <TableCell className={CHILD_NUM}>{plan.renewal_3_users}</TableCell>
                            <TableCell className={CHILD_NUM}>{plan.renewal_users}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{plan.refund_users}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatCurrency(plan.amount_refunded)}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatPct(plan.refund_rate)}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{formatCurrency(plan.gross_revenue)}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatCurrency(plan.net_revenue)}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{formatCurrency(plan.net_ltv)}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM_SECTION}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                            <TableCell className={CHILD_NUM}>{dash}</TableCell>
                          </TableRow>
                        );
                      })}
                  </Fragment>
                );
              })}
              {cohorts.length > 0 && (
                <TableRow className="sticky bottom-0 z-10 border-t-2 border-border bg-muted font-semibold hover:bg-muted">
                  <TableCell
                    className={`${CELL_BASE} sticky left-0 bg-muted z-20 text-sm whitespace-nowrap shadow-[1px_0_0_0_hsl(var(--border))]`}
                  >
                    Total
                  </TableCell>
                  <TableCell className={CELL_TXT}>—</TableCell>
                  <TableCell className={CELL_TXT}>—</TableCell>
                  <TableCell className={CELL_TXT}>—</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{totals.totalTrialUsers}</TableCell>
                  <TableCell className={CELL_NUM}>{totals.totalUpsellUsers}</TableCell>
                  <TableCell className={CELL_NUM}>{totals.totalFirstSubscriptionUsers}</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatPct(totals.trialToUpsellCr)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatPct(totals.trialToFirstSubscriptionCr)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatPct(totals.firstSubscriptionToRenewal2Cr)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatPct(totals.renewal2ToRenewal3Cr)}</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{totals.totalRenewal2Users}</TableCell>
                  <TableCell className={CELL_NUM}>{totals.totalRenewal3Users}</TableCell>
                  <TableCell className={CELL_NUM}>{totals.totalRenewalUsers}</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{totals.totalRefundUsers}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.amountRefunded)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatPct(totals.refundRate)}</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatCurrency(totals.grossRevenue)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.netRevenue)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.grossLtv)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.netLtv)}</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatCurrency(totals.revenueD0)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.revenueD7)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.revenueD14)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.revenueD30)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.revenueD37)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.revenueD67)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.totalRevenue)}</TableCell>
                  <TableCell className={`${CELL_NUM} ${SECTION_DIVIDER}`}>{formatCurrency(totals.ltvD7)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.ltvD14)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.ltvD30)}</TableCell>
                  <TableCell className={CELL_NUM}>{formatCurrency(totals.averageLtv)}</TableCell>
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
