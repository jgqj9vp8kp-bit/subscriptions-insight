// Dashboard Revenue Intelligence (plan §I): the calendar answer to "how much
// did the project make, and where did it come from" — New vs Existing cohort
// decomposition, daily table, and the per-day cohort drilldown. Everything on
// screen comes from ONE reconciled server bundle (clickhouse-revenue); shares
// cohort identity with the Cohorts page by construction.
//
// Presentation rule (review finding): everything that DESCRIBES the displayed
// numbers — the filter banner, spend/profit masking, the bucket named in
// headers, the CSV — derives from the DISPLAYED bundle, not from the controls.
// keepPreviousData keeps the previous bundle on screen while a new request is
// in flight, so control-derived presentation would caption stale numbers
// wrongly (e.g. a filtered bundle's spend=0 shown as a real project-wide $0).
import { Fragment, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import {
  ChevronDown,
  DollarSign,
  Download,
  ExternalLink,
  HelpCircle,
  Loader2,
  Megaphone,
  TrendingDown,
  TrendingUp,
  UserPlus,
  Users,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { KpiCard } from "@/components/KpiCard";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { hashUserScope } from "@/services/analyticsCache";
import { useWarehouseVersion } from "@/hooks/useAnalyticsCache";
import { useRevenueBundle, useRevenueDayBreakdown } from "@/hooks/useRevenueIntelligence";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { formatCell, supportTableToCsv } from "@/services/supportExport";
import type { RevenueBucket, RevenueBucketRow, RevenueIntelligenceRequest } from "@/services/revenueIntelligence";

const RANGE_OPTIONS = [
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "180", label: "Last 180 days" },
  { value: "all", label: "All history" },
] as const;

const DEFAULT_UI = {
  range: "90" as (typeof RANGE_OPTIONS)[number]["value"],
  bucket: "day" as RevenueBucket,
  basis: "gross" as "gross" | "net",
  // Cohort-grain member filters (Cohorts semantics: they narrow the SET OF
  // USERS; every payment of a matching user stays in).
  funnels: [] as string[],
  plans: [] as string[],
  // Accumulated option dictionaries. Persisted so a reload under an active
  // filter still offers the full lists — a filtered response only contains
  // the selected keys, so without persistence the dropdown would collapse to
  // the current selection until the user cleared it.
  funnelDict: [] as string[],
  planDict: [] as string[],
};

const AGE_LABELS: Record<string, string> = {
  d0: "New (D0)",
  d1_7: "D1–7",
  d8_30: "D8–30",
  d31_60: "D31–60",
  d61_90: "D61–90",
  d90_plus: "D90+",
  unattributed: "Unattributed",
};

const chartConfig = {
  new_rev: { label: "New Cohort Revenue", color: "hsl(var(--primary))" },
  existing_rev: { label: "Existing Cohort Revenue", color: "hsl(210 60% 70%)" },
  unatt_rev: { label: "Unattributed", color: "hsl(var(--muted-foreground))" },
  spend: { label: "Spend", color: "hsl(0 72% 51%)" },
  new_pct: { label: "New %", color: "hsl(var(--primary))" },
  existing_pct: { label: "Existing %", color: "hsl(210 60% 70%)" },
  unatt_pct: { label: "Unattributed %", color: "hsl(var(--muted-foreground))" },
} satisfies ChartConfig;

const usd = (value: number | null | undefined, digits = 0): string =>
  value == null ? "—" : value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: 0 });
const pct = (part: number, whole: number): string => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "—");

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(days: number, from: string): string {
  const date = new Date(`${from}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function downloadCsv(rows: RevenueBucketRow[], bucket: RevenueBucket, filtersActive: boolean): void {
  const headers = ["Date", "Spend", "Gross", "New", "Existing", "Unattributed", "New %", "Trial", "First Sub", "Renewals", "Upsells", "Tokens", "Refunds", "Net", "Profit", "Cumulative Profit"];
  const money = (value: number) => Math.round(value * 100) / 100;
  // Spend/profit/cumulative are project-wide streams — under cohort filters
  // they are not defined for the slice, so the file carries blanks, not zeros.
  const table = {
    headers,
    rows: rows.map((row) => [
      row.date, filtersActive ? "" : money(row.spend), money(row.gross), money(row.gross_new), money(row.gross_existing), money(row.gross_unattributed),
      row.gross > 0 ? Number(((row.gross_new / row.gross) * 100).toFixed(1)) : "",
      money(row.by_type.trial), money(row.by_type.first_subscription), money(row.by_type.renewals), money(row.by_type.upsells), money(row.by_type.tokens),
      money(row.refunds), money(row.net), filtersActive ? "" : money(row.profit), filtersActive ? "" : money(row.cumulative_profit),
    ].map(formatCell)),
    truncatedCells: 0,
  };
  const blob = new Blob(["﻿", supportTableToCsv(table)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `revenue-by-${bucket}-${utcToday()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function FilterMultiSelect({ label, values, options, onChange }: {
  label: string; values: string[]; options: string[]; onChange: (values: string[]) => void;
}): JSX.Element {
  const selected = new Set(values);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-8 justify-between px-3 text-xs font-normal">
          <span className={cn("truncate", values.length ? "text-foreground" : "text-muted-foreground")}>
            {values.length ? `${label}: ${values.length}` : label}
          </span>
          <ChevronDown className="ml-1 h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {values.length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
        <div className="max-h-72 overflow-auto p-1">
          {options.length ? options.map((option) => {
            const checked = selected.has(option);
            return (
              <button
                type="button"
                key={option}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted"
                onClick={() => onChange(checked ? values.filter((value) => value !== option) : [...values, option])}
              >
                <Checkbox checked={checked} className="pointer-events-none" />
                <span className="min-w-0 flex-1 truncate">{option}</span>
              </button>
            );
          }) : (
            <div className="px-3 py-6 text-center text-xs text-muted-foreground">No options yet</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// Sortable columns of the revenue table, keyed to accessors on the row.
const SORT_ACCESSORS = {
  date: (row: RevenueBucketRow) => row.date,
  spend: (row: RevenueBucketRow) => row.spend,
  gross: (row: RevenueBucketRow) => row.gross,
  gross_new: (row: RevenueBucketRow) => row.gross_new,
  gross_existing: (row: RevenueBucketRow) => row.gross_existing,
  new_pct: (row: RevenueBucketRow) => (row.gross > 0 ? row.gross_new / row.gross : 0),
  trial: (row: RevenueBucketRow) => row.by_type.trial,
  first_sub: (row: RevenueBucketRow) => row.by_type.first_subscription,
  renewals: (row: RevenueBucketRow) => row.by_type.renewals,
  upsells: (row: RevenueBucketRow) => row.by_type.upsells,
  tokens: (row: RevenueBucketRow) => row.by_type.tokens,
  refunds: (row: RevenueBucketRow) => row.refunds,
  net: (row: RevenueBucketRow) => row.net,
  profit: (row: RevenueBucketRow) => row.profit,
} as const;
type SortKey = keyof typeof SORT_ACCESSORS;

const TABLE_COLUMNS: Array<{ key: SortKey; label: string }> = [
  { key: "date", label: "Date" },
  { key: "spend", label: "Spend" },
  { key: "gross", label: "Gross" },
  { key: "gross_new", label: "New" },
  { key: "gross_existing", label: "Existing" },
  { key: "new_pct", label: "New %" },
  { key: "trial", label: "Trial" },
  { key: "first_sub", label: "First Sub" },
  { key: "renewals", label: "Renewals" },
  { key: "upsells", label: "Upsells" },
  { key: "tokens", label: "Tokens" },
  { key: "refunds", label: "Refunds" },
  { key: "net", label: "Net" },
  { key: "profit", label: "Profit" },
];

export function RevenueIntelligenceSection(): JSX.Element {
  const { user } = useAuth();
  const userScopeHash = useMemo(() => hashUserScope(user?.id), [user?.id]);
  const { version: warehouseVersion, ready } = useWarehouseVersion(Boolean(user));
  const [ui, setUi] = usePersistedPageState("ui_state_revenue_intel", DEFAULT_UI);

  // The window rolls over at UTC midnight even if the page stays open — the
  // request memo below re-derives from this state, so "Last N days" cannot
  // freeze at the mount date.
  const [today, setToday] = useState(utcToday);
  useEffect(() => {
    const id = setInterval(() => {
      const next = utcToday();
      setToday((prev) => (prev === next ? prev : next));
    }, 60_000);
    return () => clearInterval(id);
  }, []);

  const filtersActive = ui.funnels.length > 0 || ui.plans.length > 0;
  const request = useMemo<RevenueIntelligenceRequest>(() => ({
    action: "bundle",
    bucket: ui.bucket,
    date_from: ui.range === "all" ? null : daysAgo(Number(ui.range) - 1, today),
    date_to: ui.range === "all" ? null : today,
    filters: { campaign_path: ui.funnels, price_plan: ui.plans },
  }), [ui.bucket, ui.range, ui.funnels, ui.plans, today]);

  const { bundle, error, isInitialLoading, isRefreshing } = useRevenueBundle({
    request,
    userScopeHash,
    warehouseVersion,
    enabled: Boolean(user) && ready,
  });

  // Displayed-data-driven presentation (see the header comment).
  const displayFiltersActive = bundle?.ok ? bundle.diagnostics.filters_active : filtersActive;
  const displayBucket: RevenueBucket = bundle?.ok ? bundle.bucket : ui.bucket;
  const displayLags = Boolean(bundle?.ok && (bundle.bucket !== ui.bucket || bundle.diagnostics.filters_active !== filtersActive));

  const [expandedDay, setExpandedDay] = useState<string | null>(null);
  const dayBreakdown = useRevenueDayBreakdown({
    date: expandedDay,
    request,
    userScopeHash,
    warehouseVersion,
    enabled: Boolean(user) && ready && displayBucket === "day",
  });

  const basisKey = ui.basis;
  const chartData = useMemo(() => (bundle?.buckets ?? []).map((row) => ({
    date: row.date,
    new_rev: basisKey === "gross" ? row.gross_new : row.net_new,
    existing_rev: basisKey === "gross" ? row.gross_existing : row.net_existing,
    unatt_rev: basisKey === "gross" ? row.gross_unattributed : row.net_unattributed,
    spend: row.spend,
  })), [bundle, basisKey]);

  // Percentages are precomputed (recomputed from totals, never averaged) and
  // the three parts always sum to 100 for a non-zero bucket, so the areas are
  // stacked RAW on a fixed 0–100 axis. No stackOffset="expand": renormalizing
  // already-normalized parts would redraw New/Existing over the unattributed
  // share and disagree with the tooltip.
  const compositionData = useMemo(() => (bundle?.buckets ?? []).map((row) => {
    const total = basisKey === "gross" ? row.gross : row.net;
    const nw = basisKey === "gross" ? row.gross_new : row.net_new;
    const ex = basisKey === "gross" ? row.gross_existing : row.net_existing;
    const newPct = total > 0 ? Math.round((nw / total) * 1000) / 10 : 0;
    const existPct = total > 0 ? Math.round((ex / total) * 1000) / 10 : 0;
    return {
      date: row.date,
      new_pct: newPct,
      existing_pct: existPct,
      unatt_pct: total > 0 ? Math.max(0, Math.round((100 - newPct - existPct) * 10) / 10) : 0,
    };
  }), [bundle, basisKey]);

  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "date", dir: "desc" });
  const rows = useMemo(() => {
    const accessor = SORT_ACCESSORS[sort.key];
    const direction = sort.dir === "asc" ? 1 : -1;
    return [...(bundle?.buckets ?? [])].sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      return (typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number)) * direction;
    });
  }, [bundle, sort]);
  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: key === "date" ? "desc" : "desc" }));

  const totals = bundle?.totals;
  const ageTotal = useMemo(() => (bundle?.by_age ?? []).reduce((sum, row) => sum + row.gross, 0), [bundle]);

  // KPI values follow the Gross|Net toggle (plan: the toggle acts on chart AND
  // KPIs; the table shows both). Profit is always Net − Spend.
  const kNew = totals ? (basisKey === "gross" ? totals.gross_new : totals.net_new) : 0;
  const kExisting = totals ? (basisKey === "gross" ? totals.gross_existing : totals.net_existing) : 0;
  const kUnatt = totals ? (basisKey === "gross" ? totals.gross_unattributed : totals.net_unattributed) : 0;
  const kBasisTotal = totals ? (basisKey === "gross" ? totals.gross : totals.net) : 0;

  // Filter dictionaries accumulate from every response and persist (see
  // DEFAULT_UI). The merge is state-driven — a render-time ref would start
  // empty after a reload while the persisted filters are already active.
  useEffect(() => {
    if (!bundle?.ok) return;
    const fromSlices = (slices: ReadonlyArray<{ key: string }>) =>
      slices.map((row) => row.key).filter((key) => key !== "Unknown" && key !== "Unattributed");
    const funnelKeys = fromSlices(bundle.by_funnel);
    const planKeys = fromSlices(bundle.by_plan);
    setUi((prev) => {
      const funnelDict = [...new Set([...prev.funnelDict, ...funnelKeys])].sort();
      const planDict = [...new Set([...prev.planDict, ...planKeys])].sort();
      if (funnelDict.length === prev.funnelDict.length && planDict.length === prev.planDict.length) return prev;
      return { ...prev, funnelDict, planDict };
    });
  }, [bundle, setUi]);
  const funnelOptions = useMemo(() => [...new Set([...ui.funnelDict, ...ui.funnels])].sort(), [ui.funnelDict, ui.funnels]);
  const planOptions = useMemo(
    () => [...new Set([...ui.planDict, ...ui.plans])].sort((a, b) => (parseFloat(a.replace("$", "")) || 0) - (parseFloat(b.replace("$", "")) || 0)),
    [ui.planDict, ui.plans],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">Revenue Intelligence</h2>
          <p className="text-xs text-muted-foreground">
            When did the money arrive, and which cohorts produced it · project-wide · same cohort identity as the Cohorts page
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {isRefreshing && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          <FilterMultiSelect label="Funnel" values={ui.funnels} options={funnelOptions}
            onChange={(values) => setUi((prev) => ({ ...prev, funnels: values }))} />
          <FilterMultiSelect label="Price plan" values={ui.plans} options={planOptions}
            onChange={(values) => setUi((prev) => ({ ...prev, plans: values }))} />
          <Tabs value={ui.bucket} onValueChange={(value) => setUi((prev) => ({ ...prev, bucket: value as RevenueBucket }))}>
            <TabsList className="h-8">
              <TabsTrigger value="day" className="text-xs">Day</TabsTrigger>
              <TabsTrigger value="week" className="text-xs">Week</TabsTrigger>
              <TabsTrigger value="month" className="text-xs">Month</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={ui.basis} onValueChange={(value) => setUi((prev) => ({ ...prev, basis: value as "gross" | "net" }))}>
            <TabsList className="h-8">
              <TabsTrigger value="gross" className="text-xs">Gross</TabsTrigger>
              <TabsTrigger value="net" className="text-xs">Net</TabsTrigger>
            </TabsList>
          </Tabs>
          <Select value={ui.range} onValueChange={(value) => setUi((prev) => ({ ...prev, range: value as typeof prev.range }))}>
            <SelectTrigger className="h-8 w-36 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error === "cohort_snapshot_not_ready" && (
        <Card className="p-4 text-sm text-muted-foreground shadow-card">
          Revenue Intelligence needs the cohort snapshot.{" "}
          <Link to="/cohorts" className="font-medium text-primary underline-offset-2 hover:underline">
            Open the Cohorts page
          </Link>{" "}
          once (or rebuild the snapshot from Integrations) and come back.
        </Card>
      )}
      {error && error !== "cohort_snapshot_not_ready" && (
        <Card className="p-4 text-sm text-destructive shadow-card">ClickHouse revenue request failed: {error}</Card>
      )}
      {isInitialLoading && !bundle && (
        <Card className="flex items-center gap-2 p-4 text-sm text-muted-foreground shadow-card">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading revenue intelligence…
        </Card>
      )}

      {bundle?.ok && totals && (
        <>
          {displayFiltersActive && (
            <Card className="border-warning/40 p-3 text-xs text-muted-foreground shadow-card">
              Cohort filters active — showing attributed revenue of matching users only. Facebook spend, profit and the
              Unattributed stream have no user grain, so they are excluded from this slice (not silently kept project-wide).
            </Card>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-7">
            <KpiCard label="Gross Revenue" value={usd(totals.gross)} hint={`refunds ${usd(totals.refunds)}`}
              icon={<DollarSign className="h-4 w-4" />} />
            <KpiCard label="Net Revenue" value={usd(totals.net)} hint={`${pct(totals.net, totals.gross)} of gross`}
              icon={<Wallet className="h-4 w-4" />} accent="accent" />
            <KpiCard label={`New Cohort Revenue (${basisKey})`} value={usd(kNew)} hint={pct(kNew, kBasisTotal)}
              icon={<UserPlus className="h-4 w-4" />} accent="primary" />
            <KpiCard label={`Existing Cohort Revenue (${basisKey})`} value={usd(kExisting)} hint={pct(kExisting, kBasisTotal)}
              icon={<Users className="h-4 w-4" />} accent="accent" />
            <KpiCard label="Spend (Facebook)" value={displayFiltersActive ? "—" : usd(totals.spend)}
              hint={displayFiltersActive ? "excluded by filters" : undefined}
              icon={<Megaphone className="h-4 w-4" />} accent="warning" />
            <KpiCard label="Profit (Net − Spend)" value={displayFiltersActive ? "—" : usd(totals.profit)}
              hint={displayFiltersActive ? "excluded by filters" : undefined}
              icon={totals.profit < 0 && !displayFiltersActive ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
              accent={!displayFiltersActive && totals.profit < 0 ? "warning" : "success"} />
            <KpiCard
              label="Unattributed"
              value={displayFiltersActive ? "—" : usd(kUnatt, 2)}
              hint={displayFiltersActive ? "excluded by filters" : pct(kUnatt, kBasisTotal)}
              icon={<HelpCircle className="h-4 w-4" />} accent="warning"
              tooltip="Payments whose user has no row in the active cohort snapshot — shown explicitly, never merged into Existing."
            />
          </div>

          <div className="grid gap-3 xl:grid-cols-3">
            <Card className="p-4 shadow-card xl:col-span-2">
              <div className="mb-2 flex items-center justify-between">
                <div className="text-sm font-medium">
                  {basisKey === "gross" ? "Gross" : "Net"} revenue by {displayBucket} · New vs Existing
                </div>
                <div className="text-xs text-muted-foreground">
                  {displayFiltersActive ? "spend hidden under filters" : "line = Facebook spend"}
                  {displayBucket === "day" ? " · click a bar to inspect the day" : ""}
                </div>
              </div>
              <ChartContainer config={chartConfig} className="h-64 w-full">
                <ComposedChart
                  data={chartData}
                  margin={{ left: 8, right: 8, top: 8 }}
                  className={displayBucket === "day" ? "cursor-pointer" : undefined}
                  onClick={(state) => {
                    const day = state?.activeLabel;
                    if (displayBucket === "day" && typeof day === "string") {
                      setExpandedDay((prev) => (prev === day ? null : day));
                    }
                  }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} width={56} fontSize={11} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="new_rev" stackId="rev" fill="var(--color-new_rev)" />
                  <Bar dataKey="existing_rev" stackId="rev" fill="var(--color-existing_rev)" />
                  <Bar dataKey="unatt_rev" stackId="rev" fill="var(--color-unatt_rev)" />
                  {!displayFiltersActive && <Line dataKey="spend" type="monotone" stroke="var(--color-spend)" strokeWidth={1.5} dot={false} />}
                </ComposedChart>
              </ChartContainer>
            </Card>
            <Card className="p-4 shadow-card">
              <div className="mb-2 text-sm font-medium">Composition · New % vs Existing %</div>
              <ChartContainer config={chartConfig} className="h-40 w-full">
                <AreaChart data={compositionData} margin={{ left: 8, right: 8, top: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={28} fontSize={11} />
                  <YAxis domain={[0, 100]} tickFormatter={(value) => `${value}%`} tickLine={false} axisLine={false} width={40} fontSize={11} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area dataKey="new_pct" stackId="pct" fill="var(--color-new_pct)" stroke="var(--color-new_pct)" fillOpacity={0.5} />
                  <Area dataKey="existing_pct" stackId="pct" fill="var(--color-existing_pct)" stroke="var(--color-existing_pct)" fillOpacity={0.35} />
                  <Area dataKey="unatt_pct" stackId="pct" fill="var(--color-unatt_pct)" stroke="var(--color-unatt_pct)" fillOpacity={0.25} />
                </AreaChart>
              </ChartContainer>
              <div className="mt-3 space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Revenue by cohort age (period)</div>
                {(bundle.by_age ?? []).filter((row) => row.gross !== 0).map((row) => (
                  <div key={row.bucket} className="flex items-center gap-2 text-xs">
                    <span className="w-24 shrink-0 text-muted-foreground">{AGE_LABELS[row.bucket] ?? row.bucket}</span>
                    <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
                      <div className="h-full rounded bg-primary/70" style={{ width: `${ageTotal > 0 ? (row.gross / ageTotal) * 100 : 0}%` }} />
                    </div>
                    <span className="w-14 shrink-0 text-right tabular-nums">{pct(row.gross, ageTotal)}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card className="shadow-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border p-4">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Revenue by {displayBucket}</h3>
                <p className="text-xs text-muted-foreground">
                  {displayBucket === "day" ? "Click a row to see which cohorts produced that day's revenue. " : ""}
                  Refunds are restated onto the original payment day (the warehouse has no refund date).
                </p>
              </div>
              <Button type="button" variant="outline" size="sm"
                onClick={() => downloadCsv(rows, displayBucket, displayFiltersActive)}
                disabled={!rows.length || displayLags}
                title={displayLags ? "Waiting for the current selection to load" : undefined}>
                <Download className="h-4 w-4" /> CSV
              </Button>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    {TABLE_COLUMNS.map((column) => (
                      <TableHead
                        key={column.key}
                        className={cn("cursor-pointer select-none whitespace-nowrap", column.key !== "date" && "text-right")}
                        onClick={() => toggleSort(column.key)}
                        aria-sort={sort.key === column.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                      >
                        {column.label}
                        {sort.key === column.key ? (sort.dir === "asc" ? " ↑" : " ↓") : ""}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const expanded = displayBucket === "day" && expandedDay === row.date;
                    return (
                      <Fragment key={row.date}>
                        <TableRow
                          className={displayBucket === "day" ? "cursor-pointer" : undefined}
                          onClick={() => displayBucket === "day" && setExpandedDay(expanded ? null : row.date)}
                        >
                          <TableCell className="whitespace-nowrap text-xs font-medium">
                            {row.date}
                            {row.partial && <span className="ml-1.5 rounded border border-warning/50 px-1 text-[10px] text-warning">partial</span>}
                          </TableCell>
                          <TableCell className="text-right font-mono text-xs">{displayFiltersActive ? "—" : usd(row.spend)}</TableCell>
                          <TableCell className="text-right font-mono text-xs font-medium">{usd(row.gross, 2)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.gross_new, 2)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.gross_existing, 2)}</TableCell>
                          <TableCell className="text-right text-xs">{pct(row.gross_new, row.gross)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.by_type.trial)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.by_type.first_subscription)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.by_type.renewals)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.by_type.upsells)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.by_type.tokens)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.refunds, 2)}</TableCell>
                          <TableCell className="text-right font-mono text-xs">{usd(row.net, 2)}</TableCell>
                          <TableCell className={`text-right font-mono text-xs ${row.profit < 0 && !displayFiltersActive ? "text-destructive" : "text-success"}`}>
                            {displayFiltersActive ? "—" : usd(row.profit)}
                          </TableCell>
                        </TableRow>
                        {expanded && (
                          <TableRow className="bg-muted/10 hover:bg-muted/10">
                            <TableCell colSpan={TABLE_COLUMNS.length} className="px-4 py-3">
                              {dayBreakdown.loading && (
                                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading revenue sources…
                                </div>
                              )}
                              {dayBreakdown.error && <div className="text-xs text-destructive">{dayBreakdown.error}</div>}
                              {dayBreakdown.breakdown?.ok && (
                                <>
                                  <div className="mb-2 flex items-center justify-end">
                                    <Link
                                      to={`/cohorts?cohort_date=${row.date}`}
                                      onClick={(event) => event.stopPropagation()}
                                      className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                                    >
                                      Open in Cohorts <ExternalLink className="h-3 w-3" />
                                    </Link>
                                  </div>
                                  <div className="grid gap-4 lg:grid-cols-2">
                                    <div>
                                      <div className="mb-1 text-xs font-semibold text-muted-foreground">Revenue sources · by cohort</div>
                                      <div className="space-y-0.5">
                                        {dayBreakdown.breakdown.by_cohort.map((cohort) => (
                                          <div key={cohort.cohort} className="flex items-center gap-2 text-xs">
                                            <span className="w-28 shrink-0 font-medium">{cohort.cohort === row.date ? `${cohort.cohort} · new` : cohort.cohort}</span>
                                            <span className="w-20 shrink-0 text-right font-mono">{usd(cohort.gross, 2)}</span>
                                            <span className="w-12 shrink-0 text-right text-muted-foreground">{pct(cohort.gross, dayBreakdown.breakdown!.gross)}</span>
                                            <span className="truncate text-muted-foreground">
                                              {[
                                                cohort.by_type.trial > 0 ? `trial ${usd(cohort.by_type.trial)}` : null,
                                                cohort.by_type.first_subscription > 0 ? `first sub ${usd(cohort.by_type.first_subscription)}` : null,
                                                cohort.by_type.renewals > 0 ? `renewals ${usd(cohort.by_type.renewals)}` : null,
                                                cohort.by_type.upsells > 0 ? `upsells ${usd(cohort.by_type.upsells)}` : null,
                                                cohort.by_type.tokens > 0 ? `tokens ${usd(cohort.by_type.tokens)}` : null,
                                              ].filter(Boolean).join(" · ")}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="mb-1 text-xs font-semibold text-muted-foreground">By funnel</div>
                                      <div className="space-y-0.5">
                                        {dayBreakdown.breakdown.by_funnel.map((funnel) => (
                                          <div key={funnel.key} className="flex items-center gap-2 text-xs">
                                            <span className="min-w-0 flex-1 truncate font-medium" title={funnel.key}>{funnel.key}</span>
                                            <span className="w-20 shrink-0 text-right font-mono">{usd(funnel.gross, 2)}</span>
                                            <span className="w-24 shrink-0 text-right text-muted-foreground">
                                              new {usd(funnel.gross_new)} · exist {usd(funnel.gross_existing)}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                </>
                              )}
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    );
                  })}
                  <TableRow className="border-t-2 border-border bg-muted/20 font-medium hover:bg-muted/20">
                    <TableCell className="text-xs font-semibold">Total</TableCell>
                    <TableCell className="text-right font-mono text-xs">{displayFiltersActive ? "—" : usd(totals.spend)}</TableCell>
                    <TableCell className="text-right font-mono text-xs font-semibold">{usd(totals.gross, 2)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.gross_new, 2)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.gross_existing, 2)}</TableCell>
                    <TableCell className="text-right text-xs">{pct(totals.gross_new, totals.gross)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.by_type.trial)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.by_type.first_subscription)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.by_type.renewals)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.by_type.upsells)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.by_type.tokens)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.refunds, 2)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{usd(totals.net, 2)}</TableCell>
                    <TableCell className={`text-right font-mono text-xs ${totals.profit < 0 && !displayFiltersActive ? "text-destructive" : "text-success"}`}>
                      {displayFiltersActive ? "—" : usd(totals.profit)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          </Card>

          <Card className="p-4 shadow-card">
            <div className="mb-2 text-sm font-medium">By funnel (period) · same campaign_path identity as Cohorts</div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Funnel</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">New</TableHead>
                    <TableHead className="text-right">Existing</TableHead>
                    <TableHead className="text-right">Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bundle.by_funnel.map((funnel) => (
                    <TableRow key={funnel.key}>
                      <TableCell className="max-w-64 truncate text-xs font-medium" title={funnel.key}>{funnel.key}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{usd(funnel.gross, 2)}</TableCell>
                      <TableCell className="text-right text-xs">{pct(funnel.gross, totals.gross)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{usd(funnel.gross_new, 2)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{usd(funnel.gross_existing, 2)}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{usd(funnel.net, 2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Attribution coverage {bundle.diagnostics.attributed_pct}% · unattributed revenue is listed explicitly, never merged ·
              New/Existing here follow the selected {displayBucket} grain, same as the KPI cards.
            </p>
          </Card>
        </>
      )}
    </section>
  );
}
