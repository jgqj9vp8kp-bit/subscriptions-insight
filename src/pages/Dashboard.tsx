import { useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  CreditCard,
  DollarSign,
  MousePointerClick,
  ShieldAlert,
  Sparkles,
  Target,
  TrendingUp,
  Users as UsersIcon,
  XCircle,
} from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { KpiCard } from "@/components/KpiCard";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTransactions } from "@/services/sheets";
import { computeCohorts, formatCurrency } from "@/services/analytics";
import { aggregateTrafficMetrics, computeCohortReportTotals } from "@/services/cohortReporting";
import { useDataStore } from "@/store/dataStore";

const formatRoas = (value: number) => (value ? `${value.toFixed(2)}x` : "—");

export default function Dashboard() {
  const txs = useTransactions();
  const subscriptions = useDataStore((s) => s.subscriptions);
  const trafficMetrics = useDataStore((s) => s.trafficMetrics);
  const [funnelFilter, setFunnelFilter] = useState("all");
  const [campaignPathFilter, setCampaignPathFilter] = useState("all");
  const [trafficSourceFilter, setTrafficSourceFilter] = useState("all");
  const [campaignIdFilter, setCampaignIdFilter] = useState("all");
  const [cohortDateFrom, setCohortDateFrom] = useState("");
  const [cohortDateTo, setCohortDateTo] = useState("");

  const trafficSourceOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.traffic_source))).sort(), [txs]);
  const campaignIdOptions = useMemo(() => Array.from(new Set(txs.map((t) => t.campaign_id || "unknown"))).sort(), [txs]);
  const sourceFilteredTxs = useMemo(
    () =>
      txs.filter((t) => {
        if (trafficSourceFilter !== "all" && t.traffic_source !== trafficSourceFilter) return false;
        if (campaignIdFilter !== "all" && (t.campaign_id || "unknown") !== campaignIdFilter) return false;
        return true;
      }),
    [txs, trafficSourceFilter, campaignIdFilter],
  );
  const allCohorts = useMemo(() => computeCohorts(sourceFilteredTxs, subscriptions), [sourceFilteredTxs, subscriptions]);
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);
  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.funnel))).sort(), [allCohorts]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.campaign_path))).sort(), [allCohorts]);
  const cohorts = useMemo(
    () =>
      allCohorts.filter((c) => {
        if (funnelFilter !== "all" && c.funnel !== funnelFilter) return false;
        if (campaignPathFilter !== "all" && c.campaign_path !== campaignPathFilter) return false;
        if (cohortDateFrom && c.cohort_date < cohortDateFrom) return false;
        if (cohortDateTo && c.cohort_date > cohortDateTo) return false;
        return true;
      }),
    [allCohorts, funnelFilter, campaignPathFilter, cohortDateFrom, cohortDateTo],
  );
  const totals = useMemo(() => computeCohortReportTotals(cohorts, trafficByKey), [cohorts, trafficByKey]);

  return (
    <AppLayout title="Dashboard" description="Cohort-based business overview">
      <Card className="mb-4 p-3 shadow-card">
        <div className="flex flex-wrap items-center gap-2">
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
          <div className="flex items-center gap-2">
            <Label htmlFor="dashboard-cohort-date-from" className="text-xs text-muted-foreground">Cohort date from</Label>
            <Input
              id="dashboard-cohort-date-from"
              type="date"
              value={cohortDateFrom}
              onChange={(e) => setCohortDateFrom(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="dashboard-cohort-date-to" className="text-xs text-muted-foreground">Cohort date to</Label>
            <Input
              id="dashboard-cohort-date-to"
              type="date"
              value={cohortDateTo}
              onChange={(e) => setCohortDateTo(e.target.value)}
              className="h-9 w-[150px]"
            />
          </div>
          <span className="text-xs text-muted-foreground">
            {cohorts.length} of {allCohorts.length} cohorts
          </span>
        </div>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Revenue</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Gross Rev" value={formatCurrency(totals.grossRevenue)} icon={<DollarSign className="h-4 w-4" />} accent="primary" />
          <KpiCard label="Net Rev" value={formatCurrency(totals.netRevenue)} icon={<DollarSign className="h-4 w-4" />} accent="success" />
          <KpiCard label="Rev D0" value={formatCurrency(totals.revenueD0)} icon={<Sparkles className="h-4 w-4" />} accent="accent" />
          <KpiCard label="Rev D7" value={formatCurrency(totals.revenueD7)} icon={<TrendingUp className="h-4 w-4" />} accent="primary" />
          <KpiCard label="Rev 1M" value={formatCurrency(totals.revenueD30)} icon={<TrendingUp className="h-4 w-4" />} accent="primary" />
          <KpiCard label="Rev 2M" value={formatCurrency(totals.revenueD60)} icon={<TrendingUp className="h-4 w-4" />} accent="primary" />
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Acquisition</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <KpiCard label="Trial" value={totals.totalTrialUsers.toLocaleString()} icon={<UsersIcon className="h-4 w-4" />} accent="accent" />
          <KpiCard label="Upsell" value={totals.totalUpsellUsers.toLocaleString()} icon={<ArrowUpRight className="h-4 w-4" />} accent="accent" />
          <KpiCard label="First Sub" value={totals.totalFirstSubscriptionUsers.toLocaleString()} icon={<CreditCard className="h-4 w-4" />} accent="success" />
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Subscription Health</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <KpiCard label="Active Subscriptions" value={totals.totalActiveSubscriptions.toLocaleString()} icon={<Activity className="h-4 w-4" />} accent="success" />
          <KpiCard label="Cancelled Users" value={totals.totalCancelledUsers.toLocaleString()} icon={<XCircle className="h-4 w-4" />} accent="primary" />
          <KpiCard label="User Cancelled" value={totals.totalUserCancelledUsers.toLocaleString()} icon={<UsersIcon className="h-4 w-4" />} accent="accent" />
          <KpiCard label="Auto Cancelled" value={totals.totalAutoCancelledUsers.toLocaleString()} icon={<ShieldAlert className="h-4 w-4" />} accent="primary" />
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Traffic</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <KpiCard label="Spend" value={totals.hasTrafficSpend ? formatCurrency(totals.trafficSpend) : "—"} icon={<DollarSign className="h-4 w-4" />} accent="primary" />
          <KpiCard label="CAC" value={totals.trafficTrials ? formatCurrency(totals.trafficCac) : "—"} icon={<Target className="h-4 w-4" />} accent="accent" />
          <KpiCard label="FB Trial Count" value={totals.trafficTrials ? totals.trafficTrials.toLocaleString() : "—"} icon={<UsersIcon className="h-4 w-4" />} accent="accent" />
          <KpiCard label="ROAS D7" value={totals.hasCompleteTrafficSpend ? formatRoas(totals.roasD7) : "—"} icon={<MousePointerClick className="h-4 w-4" />} accent="success" />
          <KpiCard label="ROAS 1M" value={totals.hasCompleteTrafficSpend ? formatRoas(totals.roas1m) : "—"} icon={<MousePointerClick className="h-4 w-4" />} accent="success" />
          <KpiCard label="ROAS 2M" value={totals.hasCompleteTrafficSpend ? formatRoas(totals.roas2m) : "—"} icon={<MousePointerClick className="h-4 w-4" />} accent="success" />
        </div>
      </section>
    </AppLayout>
  );
}
