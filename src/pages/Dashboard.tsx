import { useMemo } from "react";
import {
  Activity,
  CreditCard,
  DollarSign,
  LineChart as LineChartIcon,
  Receipt,
  ShieldAlert,
  Target,
  TrendingUp,
  Users as UsersIcon,
  XCircle,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import { AppLayout } from "@/components/AppLayout";
import { Button } from "@/components/ui/button";
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
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { useTransactions } from "@/services/sheets";
import { computeCohorts, formatCurrency } from "@/services/analytics";
import { aggregateTrafficMetrics, trafficForCohort } from "@/services/cohortReporting";
import {
  buildCancellationBreakdown,
  buildCancellationsByDay,
  buildDashboardKpis,
  buildFunnelChart,
  buildRefundTrend,
  buildRefundsByDay,
  buildRevenueTrend,
  buildRoasTrend,
  buildTrialsUpsellsByDay,
  type DashboardKpi,
} from "@/services/dashboard";
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";

const DEFAULT_DASHBOARD_UI_STATE = {
  funnelFilter: "all",
  campaignPathFilter: "all",
  sourceFilter: "all",
  cohortDateFrom: "",
  cohortDateTo: "",
};

const EXECUTIVE_KPIS = [
  "Net Rev",
  "Spend",
  "ROAS 1M",
  "Trial Users",
  "Trial → Sub CR",
  "Active Subs",
  "Cancellation Rate",
];

const KPI_TOOLTIPS: Record<string, string> = {
  "Gross Rev": "Sum of cohort gross revenue.",
  "Net Rev": "Gross revenue minus refunds.",
  Spend: "Matched traffic spend for filtered cohorts.",
  "ROAS 1M": "Rev 1M divided by spend.",
  "Trial Users": "Trial users across filtered cohorts.",
  "First Sub": "Users with first_subscription across filtered cohorts.",
  "Trial → Sub CR": "First subscription users divided by trial users.",
  "Active Subs": "Users with active renewing FunnelFox subscriptions.",
  "Refund Rate": "Refund amount divided by gross revenue.",
  "Cancellation Rate": "Cancelled users divided by first subscription users.",
};

const KPI_ICONS: Record<string, JSX.Element> = {
  "Gross Rev": <DollarSign className="h-4 w-4" />,
  "Net Rev": <DollarSign className="h-4 w-4" />,
  Spend: <Receipt className="h-4 w-4" />,
  "ROAS 1M": <Target className="h-4 w-4" />,
  "Trial Users": <UsersIcon className="h-4 w-4" />,
  "First Sub": <CreditCard className="h-4 w-4" />,
  "Trial → Sub CR": <TrendingUp className="h-4 w-4" />,
  "Active Subs": <Activity className="h-4 w-4" />,
  "Refund Rate": <ShieldAlert className="h-4 w-4" />,
  "Cancellation Rate": <XCircle className="h-4 w-4" />,
};

const KPI_ACCENTS: Record<string, "primary" | "accent" | "warning" | "success"> = {
  "Gross Rev": "primary",
  "Net Rev": "success",
  Spend: "primary",
  "ROAS 1M": "success",
  "Trial Users": "accent",
  "First Sub": "success",
  "Trial → Sub CR": "success",
  "Active Subs": "success",
  "Refund Rate": "warning",
  "Cancellation Rate": "warning",
};

const revenueConfig = {
  gross_rev: { label: "Gross Rev", color: "hsl(var(--chart-1))" },
  net_rev: { label: "Net Rev", color: "hsl(var(--chart-2))" },
  spend: { label: "Spend", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig;

const roasConfig = {
  roas_d7: { label: "ROAS D7", color: "hsl(var(--chart-1))" },
  roas_1m: { label: "ROAS 1M", color: "hsl(var(--chart-2))" },
  roas_2m: { label: "ROAS 2M", color: "hsl(var(--chart-5))" },
} satisfies ChartConfig;

const refundConfig = {
  refund_amount: { label: "Refund Amount", color: "hsl(var(--chart-4))" },
  refund_rate: { label: "Refund Rate", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig;

const funnelConfig = {
  value: { label: "Users", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

const healthConfig = {
  value: { label: "Users", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

const trialsUpsellsConfig = {
  upsell_users: { label: "Upsell Users", color: "hsl(var(--chart-2))" },
  non_upsell_trial_users: { label: "Trials without Upsell", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

const dailyRefundsConfig = {
  refund_count: { label: "Refund Events", color: "hsl(var(--chart-4))" },
  refund_amount: { label: "Refund Amount", color: "hsl(var(--chart-3))" },
} satisfies ChartConfig;

const dailyCancellationsConfig = {
  user_cancelled: { label: "User Cancelled", color: "hsl(var(--chart-4))" },
  auto_cancelled: { label: "Auto Cancelled", color: "hsl(var(--chart-3))" },
  total_cancelled: { label: "Total Cancelled", color: "hsl(var(--chart-5))" },
} satisfies ChartConfig;

const cancellationColors = [
  "hsl(var(--chart-4))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-5))",
];

function formatKpiValue(kpi: DashboardKpi): string {
  if (kpi.value == null) return "—";
  if (kpi.type === "currency") return formatCurrency(kpi.value);
  if (kpi.type === "percent") return `${kpi.value.toFixed(1)}%`;
  if (kpi.type === "ratio") return `${kpi.value.toFixed(2)}x`;
  return Math.round(kpi.value).toLocaleString();
}

function compactNumber(value: number): string {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function compactCurrency(value: number): string {
  return `$${compactNumber(value)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatRoas(value: number | null | undefined): string {
  return value == null ? "—" : `${value.toFixed(2)}x`;
}

function sum<T>(rows: T[], pick: (row: T) => number | null | undefined): number {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

function uniqueCount<T>(rows: T[], pick: (row: T) => string[] | undefined): number {
  return new Set(rows.flatMap((row) => pick(row) ?? [])).size;
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const isoDate = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function ChartEmptyState({ message = "No cohort data to chart." }: { message?: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function MetricCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-3 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-2 text-xl font-semibold tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </Card>
  );
}

function TrialsUpsellsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    color?: string;
    dataKey?: string | number;
    value?: unknown;
    payload?: { trial_users?: number; upsell_users?: number; non_upsell_trial_users?: number; upsell_rate?: number };
  }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload ?? {};
  const trialUsers = row.trial_users ?? 0;
  const upsellUsers = row.upsell_users ?? 0;
  const upsellRate = trialUsers ? formatPercent(row.upsell_rate ?? (upsellUsers / trialUsers) * 100) : "—";
  const upsellColor = payload.find((item) => item.dataKey === "upsell_users")?.color;

  return (
    <div className="grid min-w-[10rem] gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{label}</div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Total Trial Users</span>
        <span className="font-mono font-medium tabular-nums text-foreground">{trialUsers.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-muted-foreground">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: upsellColor }} />
          <span>Upsell Users</span>
        </div>
        <span className="font-mono font-medium tabular-nums text-foreground">{upsellUsers.toLocaleString()}</span>
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-1.5">
        <span className="text-muted-foreground">Upsell Rate</span>
        <span className="font-mono font-medium tabular-nums text-foreground">{upsellRate}</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const txs = useTransactions();
  const subscriptions = useDataStore((s) => s.subscriptions);
  const trafficMetrics = useDataStore((s) => s.trafficMetrics);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_dashboard", DEFAULT_DASHBOARD_UI_STATE);
  const { funnelFilter, campaignPathFilter, sourceFilter, cohortDateFrom, cohortDateTo } = uiState;
  const updateUiState = (patch: Partial<typeof DEFAULT_DASHBOARD_UI_STATE>) => setUiState((current) => ({ ...current, ...patch }));

  const allCohorts = useMemo(() => computeCohorts(txs, subscriptions), [txs, subscriptions]);
  const filteredTrafficMetrics = useMemo(
    () => trafficMetrics.filter((row) => sourceFilter === "all" || row.source === sourceFilter),
    [sourceFilter, trafficMetrics],
  );
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(filteredTrafficMetrics), [filteredTrafficMetrics]);
  const sourceOptions = useMemo(() => Array.from(new Set(trafficMetrics.map((row) => row.source))).sort(), [trafficMetrics]);
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

  const dashboardCohorts = useMemo(
    () =>
      cohorts.map((cohort) => {
        const traffic = trafficForCohort(cohort, trafficByKey);
        return {
          ...cohort,
          traffic_spend: traffic?.spend ?? null,
          traffic_trial_count: traffic?.trial_count ?? 0,
          traffic_clicks: traffic?.clicks ?? 0,
        };
      }),
    [cohorts, trafficByKey],
  );

  const kpiMap = useMemo(() => {
    const map = new Map<string, DashboardKpi>();
    buildDashboardKpis(dashboardCohorts).forEach((kpi) => map.set(kpi.label, kpi));
    return map;
  }, [dashboardCohorts]);
  const revenueTrend = useMemo(() => buildRevenueTrend(dashboardCohorts), [dashboardCohorts]);
  const roasTrend = useMemo(() => buildRoasTrend(dashboardCohorts), [dashboardCohorts]);
  const baseFunnelChart = useMemo(() => buildFunnelChart(dashboardCohorts), [dashboardCohorts]);
  const cancellationBreakdown = useMemo(() => buildCancellationBreakdown(dashboardCohorts), [dashboardCohorts]);
  const refundTrend = useMemo(() => buildRefundTrend(dashboardCohorts), [dashboardCohorts]);
  const dailyTransactions = useMemo(
    () =>
      txs.filter((transaction) => {
        const eventDate = dateKey(transaction.event_time);
        if (!eventDate) return false;
        if (cohortDateFrom && eventDate < cohortDateFrom) return false;
        if (cohortDateTo && eventDate > cohortDateTo) return false;
        if (funnelFilter !== "all" && transaction.funnel !== funnelFilter) return false;
        if (campaignPathFilter !== "all" && transaction.campaign_path !== campaignPathFilter) return false;
        if (sourceFilter !== "all" && transaction.traffic_source !== sourceFilter) return false;
        return true;
      }),
    [txs, cohortDateFrom, cohortDateTo, funnelFilter, campaignPathFilter, sourceFilter],
  );
  const dailySubscriptions = useMemo(
    () =>
      subscriptions.filter((subscription) => {
        const cancelledDate = dateKey(subscription.cancelled_at);
        if (!cancelledDate) return false;
        if (cohortDateFrom && cancelledDate < cohortDateFrom) return false;
        if (cohortDateTo && cancelledDate > cohortDateTo) return false;
        return true;
      }),
    [subscriptions, cohortDateFrom, cohortDateTo],
  );
  const trialsUpsellsByDay = useMemo(() => buildTrialsUpsellsByDay(dailyTransactions), [dailyTransactions]);
  const refundsByDay = useMemo(() => buildRefundsByDay(dailyTransactions), [dailyTransactions]);
  const cancellationsByDay = useMemo(() => buildCancellationsByDay(dailySubscriptions), [dailySubscriptions]);
  const hasCohortData = dashboardCohorts.length > 0;

  const summary = useMemo(() => {
    const trialUsers = sum(dashboardCohorts, (c) => c.trial_users);
    const upsellUsers = sum(dashboardCohorts, (c) => c.upsell_users);
    const firstSubUsers = sum(dashboardCohorts, (c) => c.first_subscription_users);
    const renewal2Users = sum(dashboardCohorts, (c) => c.renewal_2_users);
    const renewal3Users = sum(dashboardCohorts, (c) => c.renewal_3_users);
    const activeSubs = uniqueCount(dashboardCohorts, (c) => c.active_subscription_user_ids);
    const cancelledUsers = uniqueCount(dashboardCohorts, (c) => c.cancelled_user_ids);
    const userCancelled = uniqueCount(dashboardCohorts, (c) => c.user_cancelled_user_ids);
    const autoCancelled = uniqueCount(dashboardCohorts, (c) => c.auto_cancelled_user_ids);
    const cancelledActive = uniqueCount(dashboardCohorts, (c) => c.cancelled_active_user_ids);
    const refundUsers = uniqueCount(dashboardCohorts, (c) => c.refunded_user_ids);
    const spend = sum(dashboardCohorts, (c) => c.traffic_spend);
    const fbTrialCount = sum(dashboardCohorts, (c) => c.traffic_trial_count);
    const clicks = sum(dashboardCohorts, (c) => c.traffic_clicks);
    const revenueD7 = sum(dashboardCohorts, (c) => c.revenue_d7);
    const revenueD30 = sum(dashboardCohorts, (c) => c.revenue_d30);
    const revenueD60 = sum(dashboardCohorts, (c) => c.revenue_d60);
    const amountRefunded = sum(dashboardCohorts, (c) => c.amount_refunded);
    return {
      trialUsers,
      upsellUsers,
      firstSubUsers,
      renewal2Users,
      renewal3Users,
      activeSubs,
      activeSubsRate: trialUsers ? (activeSubs / trialUsers) * 100 : 0,
      cancelledUsers,
      userCancelled,
      autoCancelled,
      cancelledActive,
      refundUsers,
      spend,
      fbTrialCount,
      clicks,
      cac: fbTrialCount ? spend / fbTrialCount : null,
      cpc: clicks ? spend / clicks : null,
      revenueD7,
      revenueD30,
      revenueD60,
      roasD7: spend ? revenueD7 / spend : null,
      roas1M: spend ? revenueD30 / spend : null,
      roas2M: spend ? revenueD60 / spend : null,
      amountRefunded,
      upsellCr: trialUsers ? (upsellUsers / trialUsers) * 100 : 0,
      subCr: trialUsers ? (firstSubUsers / trialUsers) * 100 : 0,
      renewal2Cr: firstSubUsers ? (renewal2Users / firstSubUsers) * 100 : 0,
      renewal3Cr: renewal2Users ? (renewal3Users / renewal2Users) * 100 : 0,
    };
  }, [dashboardCohorts]);

  const executiveKpis = useMemo(
    () => EXECUTIVE_KPIS.map((label) => kpiMap.get(label)).filter(Boolean) as DashboardKpi[],
    [kpiMap],
  );

  const funnelChart = useMemo(() => {
    const existing = new Map(baseFunnelChart.map((row) => [row.label, row.value]));
    return [
      { label: "Trial Users", value: existing.get("Trial Users") ?? summary.trialUsers },
      { label: "Upsell Users", value: existing.get("Upsell Users") ?? summary.upsellUsers },
      { label: "First Sub Users", value: existing.get("First Sub Users") ?? summary.firstSubUsers },
      { label: "Renewal 2", value: summary.renewal2Users },
      { label: "Renewal 3", value: summary.renewal3Users },
      { label: "Active Subs", value: existing.get("Active Subs") ?? summary.activeSubs },
    ];
  }, [baseFunnelChart, summary]);

  const subscriptionHealthChart = useMemo(
    () => [
      { label: "Active Subs", value: summary.activeSubs },
      { label: "User Cancelled", value: summary.userCancelled },
      { label: "Auto Cancelled", value: summary.autoCancelled },
    ],
    [summary],
  );

  return (
    <AppLayout title="Dashboard" description="Cohort-based business overview">
      <Card className="mb-4 p-3 shadow-card">
        <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Global Filters</div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={funnelFilter} onValueChange={(value) => updateUiState({ funnelFilter: value })}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Funnel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All funnels</SelectItem>
              {funnelOptions.map((f) => (
                <SelectItem key={f} value={f}>{f.replace("_", " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={campaignPathFilter} onValueChange={(value) => updateUiState({ campaignPathFilter: value })}>
            <SelectTrigger className="h-9 w-[220px]"><SelectValue placeholder="Campaign path" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All campaign paths</SelectItem>
              {campaignPathOptions.map((path) => (
                <SelectItem key={path} value={path}>{path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={sourceFilter} onValueChange={(value) => updateUiState({ sourceFilter: value })} disabled={sourceOptions.length === 0}>
            <SelectTrigger className="h-9 w-[160px]"><SelectValue placeholder="Source" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {sourceOptions.map((source) => (
                <SelectItem key={source} value={source}>{source}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2">
            <Label htmlFor="dashboard-cohort-date-from" className="text-xs text-muted-foreground">Date from</Label>
            <Input
              id="dashboard-cohort-date-from"
              type="date"
              value={cohortDateFrom}
              onChange={(e) => updateUiState({ cohortDateFrom: e.target.value })}
              className="h-9 w-[150px]"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="dashboard-cohort-date-to" className="text-xs text-muted-foreground">Date to</Label>
            <Input
              id="dashboard-cohort-date-to"
              type="date"
              value={cohortDateTo}
              onChange={(e) => updateUiState({ cohortDateTo: e.target.value })}
              className="h-9 w-[150px]"
            />
          </div>
          <Button type="button" variant="ghost" size="sm" className="h-9" onClick={resetUiState}>
            Reset filters
          </Button>
          <span className="text-xs text-muted-foreground">
            {cohorts.length} of {allCohorts.length} cohorts
          </span>
        </div>
      </Card>

      {!hasCohortData && (
        <Card className="mb-4 p-8 text-center shadow-card">
          <LineChartIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">No cohort data loaded</h2>
          <p className="mt-1 text-sm text-muted-foreground">Import Palmer data on the Import Data page to populate Dashboard charts.</p>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Executive Summary</h2>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {executiveKpis.map((kpi) => (
            <KpiCard
              key={kpi.label}
              label={kpi.label}
              value={formatKpiValue(kpi)}
              tooltip={KPI_TOOLTIPS[kpi.label]}
              delta="Δ —"
              icon={KPI_ICONS[kpi.label]}
              accent={KPI_ACCENTS[kpi.label] ?? "primary"}
            />
          ))}
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <SectionHeader title="Daily Activity" description="Operational events by real event date, separate from cohort-date reporting." />
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="p-4 shadow-card">
            <SectionHeader title="Trials & Upsells by Day" />
            {trialsUpsellsByDay.length ? (
              <ChartContainer config={trialsUpsellsConfig} className="h-[260px] w-full">
                <BarChart data={trialsUpsellsByDay} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={compactNumber} width={44} />
                  <ChartTooltip content={<TrialsUpsellsTooltip />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="upsell_users" stackId="activity" fill="var(--color-upsell_users)" radius={[0, 0, 4, 4]} />
                  <Bar dataKey="non_upsell_trial_users" stackId="activity" fill="var(--color-non_upsell_trial_users)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : <ChartEmptyState message="No daily trial or upsell events to chart." />}
          </Card>
          <Card className="p-4 shadow-card">
            <SectionHeader title="Refunds by Day" />
            {refundsByDay.length ? (
              <ChartContainer config={dailyRefundsConfig} className="h-[260px] w-full">
                <LineChart data={refundsByDay} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis yAxisId="events" tickLine={false} axisLine={false} tickFormatter={compactNumber} width={44} />
                  <YAxis yAxisId="amount" orientation="right" tickLine={false} axisLine={false} tickFormatter={compactCurrency} width={56} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line yAxisId="events" type="monotone" dataKey="refund_count" stroke="var(--color-refund_count)" strokeWidth={2} dot={false} />
                  <Line yAxisId="amount" type="monotone" dataKey="refund_amount" stroke="var(--color-refund_amount)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            ) : <ChartEmptyState message="No daily refund events to chart." />}
          </Card>
          <Card className="p-4 shadow-card">
            <SectionHeader title="Subscription Cancellations by Day" />
            {cancellationsByDay.length ? (
              <ChartContainer config={dailyCancellationsConfig} className="h-[260px] w-full">
                <BarChart data={cancellationsByDay} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={compactNumber} width={44} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="user_cancelled" fill="var(--color-user_cancelled)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="auto_cancelled" fill="var(--color-auto_cancelled)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="total_cancelled" fill="var(--color-total_cancelled)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : <ChartEmptyState message="No daily cancellation events to chart." />}
          </Card>
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <SectionHeader title="Revenue & Spend" description="Cohort revenue windows with matched traffic cost." />
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
          <Card className="p-4 shadow-card">
            {revenueTrend.length ? (
              <ChartContainer config={revenueConfig} className="h-[340px] w-full">
                <LineChart data={revenueTrend} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={compactCurrency} width={56} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line type="monotone" dataKey="gross_rev" stroke="var(--color-gross_rev)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="net_rev" stroke="var(--color-net_rev)" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="spend" stroke="var(--color-spend)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            ) : <ChartEmptyState />}
          </Card>
          <div className="grid gap-3">
            <MetricCard label="Rev D7" value={formatCurrency(summary.revenueD7)} />
            <MetricCard label="Rev 1M" value={formatCurrency(summary.revenueD30)} />
            <MetricCard label="Rev 2M" value={formatCurrency(summary.revenueD60)} />
          </div>
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <SectionHeader title="Acquisition Efficiency" description="Traffic efficiency and payback signals by cohort date." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
          <MetricCard label="CAC" value={summary.cac == null ? "—" : formatCurrency(summary.cac)} />
          <MetricCard label="FB Trial Count" value={summary.fbTrialCount ? summary.fbTrialCount.toLocaleString() : "—"} />
          <MetricCard label="Clicks" value={summary.clicks ? summary.clicks.toLocaleString() : "—"} />
          <MetricCard label="CPC" value={summary.cpc == null ? "—" : formatCurrency(summary.cpc)} />
          <MetricCard label="ROAS D7" value={formatRoas(summary.roasD7)} />
          <MetricCard label="ROAS 1M" value={formatRoas(summary.roas1M)} />
          <MetricCard label="ROAS 2M" value={formatRoas(summary.roas2M)} />
        </div>
        <Card className="p-4 shadow-card">
          {roasTrend.length ? (
            <ChartContainer config={roasConfig} className="h-[300px] w-full">
              <LineChart data={roasTrend} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis tickLine={false} axisLine={false} tickFormatter={(value) => `${value}x`} width={44} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line type="monotone" dataKey="roas_d7" stroke="var(--color-roas_d7)" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="roas_1m" stroke="var(--color-roas_1m)" strokeWidth={2} dot={false} connectNulls />
                <Line type="monotone" dataKey="roas_2m" stroke="var(--color-roas_2m)" strokeWidth={2} dot={false} connectNulls />
              </LineChart>
            </ChartContainer>
          ) : <ChartEmptyState />}
        </Card>
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="p-4 shadow-card">
          <SectionHeader title="Funnel Health" description="User counts through the observed payment lifecycle." />
          {funnelChart.length ? (
            <ChartContainer config={funnelConfig} className="h-[320px] w-full">
              <BarChart data={funnelChart} margin={{ left: 8, right: 16, top: 8, bottom: 28 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} angle={-12} textAnchor="end" height={54} />
                <YAxis tickLine={false} axisLine={false} tickFormatter={compactNumber} width={44} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ChartContainer>
          ) : <ChartEmptyState />}
        </Card>
        <div className="grid gap-3">
          <MetricCard label="Upsell CR" value={formatPercent(summary.upsellCr)} />
          <MetricCard label="Sub CR" value={formatPercent(summary.subCr)} />
          <MetricCard label="First Sub → Renewal 2 CR" value={formatPercent(summary.renewal2Cr)} />
          <MetricCard label="Renewal 2 → 3 CR" value={formatPercent(summary.renewal3Cr)} />
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <SectionHeader title="Subscription Health" description="FunnelFox subscription status joined to cohort users." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <MetricCard label="Active Subscriptions" value={summary.activeSubs.toLocaleString()} />
          <MetricCard label="Active Subscriptions Rate" value={formatPercent(summary.activeSubsRate)} />
          <MetricCard label="Cancelled Users" value={summary.cancelledUsers.toLocaleString()} />
          <MetricCard label="User Cancelled" value={summary.userCancelled.toLocaleString()} />
          <MetricCard label="Auto Cancelled" value={summary.autoCancelled.toLocaleString()} />
          <MetricCard label="Cancelled Active" value={summary.cancelledActive.toLocaleString()} />
        </div>
        <div className="grid gap-4 xl:grid-cols-2">
          <Card className="p-4 shadow-card">
            {subscriptionHealthChart.some((item) => item.value > 0) ? (
              <ChartContainer config={healthConfig} className="h-[280px] w-full">
                <BarChart data={subscriptionHealthChart} margin={{ left: 8, right: 16, top: 8, bottom: 18 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} />
                  <YAxis tickLine={false} axisLine={false} tickFormatter={compactNumber} width={44} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : <ChartEmptyState />}
          </Card>
          <Card className="p-4 shadow-card">
            {cancellationBreakdown.some((item) => item.value > 0) ? (
              <ChartContainer config={{ value: { label: "Users" } }} className="h-[280px] w-full">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent hideLabel />} />
                  <Legend />
                  <Pie data={cancellationBreakdown} dataKey="value" nameKey="label" innerRadius={58} outerRadius={92} paddingAngle={2}>
                    {cancellationBreakdown.map((entry, index) => (
                      <Cell key={entry.label} fill={cancellationColors[index % cancellationColors.length]} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            ) : <ChartEmptyState />}
          </Card>
        </div>
      </section>

      <section className="mt-5 space-y-3">
        <SectionHeader title="Risk / Refunds" description="Refund exposure by amount, users, and cohort date." />
        <div className="grid gap-3 md:grid-cols-3">
          <MetricCard label="Refund Amount" value={formatCurrency(summary.amountRefunded)} />
          <MetricCard label="Refund Rate" value={formatKpiValue(kpiMap.get("Refund Rate") ?? { label: "Refund Rate", value: 0, type: "percent" })} />
          <MetricCard label="Refund Users" value={summary.refundUsers.toLocaleString()} />
        </div>
        <Card className="p-4 shadow-card">
          {refundTrend.length ? (
            <ChartContainer config={refundConfig} className="h-[280px] w-full">
              <LineChart data={refundTrend} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} />
                <YAxis yAxisId="amount" tickLine={false} axisLine={false} tickFormatter={compactCurrency} width={52} />
                <YAxis yAxisId="rate" orientation="right" tickLine={false} axisLine={false} tickFormatter={(value) => `${value}%`} width={42} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Line yAxisId="amount" type="monotone" dataKey="refund_amount" stroke="var(--color-refund_amount)" strokeWidth={2} dot={false} />
                <Line yAxisId="rate" type="monotone" dataKey="refund_rate" stroke="var(--color-refund_rate)" strokeWidth={2} dot={false} />
              </LineChart>
            </ChartContainer>
          ) : <ChartEmptyState />}
        </Card>
      </section>

      <section className="mt-5 space-y-3">
        <SectionHeader title="Forecast Snapshot" description="Reserved for Forecasting scenario outputs." />
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          <MetricCard label="Forecast LTV 3M" value="—" hint="Coming soon" />
          <MetricCard label="Forecast LTV 6M" value="—" hint="Coming soon" />
          <MetricCard label="Forecast LTV 12M" value="—" hint="Coming soon" />
          <MetricCard label="Forecast ROAS 6M" value="—" hint="Coming soon" />
        </div>
      </section>
    </AppLayout>
  );
}
