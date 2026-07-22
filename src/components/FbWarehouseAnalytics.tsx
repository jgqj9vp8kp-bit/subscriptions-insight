// Server-driven FB Analytics (ClickHouse warehouse). Every number on screen —
// KPI cards, chart, table, filter options, diagnostics — arrives pre-computed
// from the clickhouse-facebook Edge Function as ONE atomic report bundle.
// The browser performs no analytics and never sees the Capsuled token.

import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { hashUserScope } from "@/services/analyticsCache";
import { formatUpdatedAgo } from "@/services/analyticsProgress";
import { useFbReportQuery, useFbWarehouseStatus, useInvalidateFbWarehouse } from "@/hooks/useFbWarehouse";
import { runFbReconSnapshot, runFbSync, type FbLevel, type FbListRow, type FbReportQuery } from "@/services/fbWarehouse";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";

const LEVEL_TABS: Array<{ value: FbLevel; label: string }> = [
  { value: "account", label: "Accounts" },
  { value: "campaign", label: "Campaigns" },
  { value: "adset", label: "Ad Sets" },
  { value: "ad", label: "Ads" },
];

const RANGE_PRESETS = [
  { value: "7", label: "Last 7 days" },
  { value: "14", label: "Last 14 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All history" },
] as const;

const DEFAULT_UI_STATE = {
  level: "campaign" as FbLevel,
  range: "30" as (typeof RANGE_PRESETS)[number]["value"],
  buyer: "all",
  account: "all",
  sortKey: "spend" as string,
  sortDir: "desc" as "asc" | "desc",
  search: "",
};

const chartConfig = {
  spend: { label: "Spend", color: "hsl(var(--primary))" },
  fb_purchases: { label: "FB Purchases", color: "hsl(var(--success, 142 72% 40%))" },
} satisfies ChartConfig;

const usd = (v: number | null | undefined, digits = 2): string =>
  v == null ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits > 0 ? 2 : 0 });
const int = (v: number | null | undefined): string => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
const pct = (v: number | null | undefined): string => (v == null ? "—" : `${v.toFixed(2)}%`);

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

type FbColumn = { key: string; label: string; align?: "right"; blended?: boolean; render: (row: FbListRow) => string };

const FB_COLUMNS: FbColumn[] = [
  { key: "spend", label: "Spend", align: "right", render: (r) => usd(r.spend) },
  { key: "fb_purchases", label: "FB Purchases", align: "right", render: (r) => int(r.fb_purchases) },
  { key: "cpp", label: "CPP", align: "right", render: (r) => usd(r.cpp) },
  { key: "impressions", label: "Impressions", align: "right", render: (r) => int(r.impressions) },
  { key: "clicks", label: "Clicks", align: "right", render: (r) => int(r.clicks) },
  { key: "ctr", label: "CTR", align: "right", render: (r) => pct(r.ctr) },
  { key: "cpc", label: "CPC", align: "right", render: (r) => usd(r.cpc) },
  { key: "cpm", label: "CPM", align: "right", render: (r) => usd(r.cpm) },
  { key: "outbound_clicks", label: "Outbound", align: "right", render: (r) => int(r.outbound_clicks) },
  { key: "outbound_ctr", label: "Outbound CTR", align: "right", render: (r) => pct(r.outbound_ctr) },
  { key: "days", label: "Days", align: "right", render: (r) => int(r.days) },
  // Subengine metrics joined server-side BY CAMPAIGN_ID (campaign level only).
  { key: "blended.trial_users", label: "Trials", align: "right", blended: true, render: (r) => int(r.blended?.trial_users ?? null) },
  { key: "blended.cac", label: "CAC", align: "right", blended: true, render: (r) => usd(r.blended?.cac ?? null) },
  { key: "blended.tx_gross_revenue", label: "Gross Rev", align: "right", blended: true, render: (r) => usd(r.blended?.tx_gross_revenue ?? null) },
  { key: "blended.tx_net_revenue", label: "Net Rev", align: "right", blended: true, render: (r) => usd(r.blended?.tx_net_revenue ?? null) },
  { key: "blended.roas", label: "ROAS", align: "right", blended: true, render: (r) => (r.blended?.roas == null ? "—" : `${r.blended.roas.toFixed(2)}x`) },
  { key: "blended.revenue_per_trial", label: "Rev / Trial", align: "right", blended: true, render: (r) => usd(r.blended?.revenue_per_trial ?? null) },
];

function columnValue(row: FbListRow, key: string): number | string | null {
  if (key.startsWith("blended.")) {
    const field = key.slice("blended.".length) as keyof NonNullable<FbListRow["blended"]>;
    return row.blended?.[field] ?? null;
  }
  return (row as unknown as Record<string, number | string | null>)[key] ?? null;
}

function entityLabel(row: FbListRow, level: FbLevel): { title: string; subtitle: string } {
  if (level === "account") return { title: row.ad_account_name || row.ad_account_id, subtitle: `${row.buyer} · ${row.ad_account_id}` };
  if (level === "campaign") return { title: row.campaign_name || row.campaign_id, subtitle: `${row.ad_account_name} · ${row.campaign_id}` };
  if (level === "adset") return { title: row.adset_name || row.adset_id, subtitle: `${row.campaign_name} · ${row.adset_id}` };
  return { title: row.ad_name || row.ad_id, subtitle: `${row.adset_name} · ${row.ad_id}` };
}

export function FbWarehouseAnalytics(): JSX.Element {
  const { toast } = useToast();
  const { user } = useAuth();
  const userScopeHash = hashUserScope(user?.id);
  const [ui, setUi] = usePersistedPageState("ui_state_fb_warehouse", DEFAULT_UI_STATE);
  const [syncRunning, setSyncRunning] = useState<null | "incremental" | "full">(null);
  const invalidateFbWarehouse = useInvalidateFbWarehouse();

  const { status, version, ready } = useFbWarehouseStatus(Boolean(user));

  const query: FbReportQuery = useMemo(
    () => ({
      level: ui.level,
      date_from: ui.range === "all" ? null : daysAgo(Number(ui.range) - 1),
      date_to: ui.range === "all" ? null : utcToday(),
      buyer: ui.buyer !== "all" ? [ui.buyer] : [],
      ad_account_id: ui.account !== "all" ? [ui.account] : [],
      campaign_id: [],
    }),
    [ui.level, ui.range, ui.buyer, ui.account],
  );

  const { report, error, isBackgroundRefreshing, isInitialLoading, progressPercent, dataUpdatedAt } = useFbReportQuery({
    query,
    userScopeHash,
    warehouseVersion: version,
    enabled: Boolean(user) && ready,
  });

  const runSync = async (mode: "incremental" | "full") => {
    if (syncRunning) return;
    setSyncRunning(mode);
    try {
      const result = await runFbSync(mode);
      if (!result.ok) throw new Error(result.error || "Sync failed.");
      toast({
        title: `FB sync ${result.status}`,
        description: `${result.mode}: API ${int(result.api_rows)} rows → +${int(result.rows_inserted)} new, ${int(result.rows_updated)} updated · ${(result.duration_ms / 1000).toFixed(1)}s · ${result.api_requests} API calls`,
      });
      await invalidateFbWarehouse();
      // Wave 4: every publish leaves a stored reconciliation health snapshot.
      // Fire-and-forget — recon must never make a successful sync look failed.
      void runFbReconSnapshot().catch((reconError) =>
        console.warn("Recon snapshot after sync failed.", reconError),
      );
    } catch (err) {
      toast({
        title: "FB sync failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setSyncRunning(null);
    }
  };

  const columns = useMemo(
    () => FB_COLUMNS.filter((col) => !col.blended || ui.level === "campaign"),
    [ui.level],
  );

  const rows = useMemo(() => {
    const list = report?.rows ?? [];
    const q = ui.search.trim().toLowerCase();
    const filtered = q
      ? list.filter((r) =>
          `${r.ad_account_name} ${r.buyer} ${r.campaign_name} ${r.campaign_id} ${r.adset_name} ${r.ad_name}`.toLowerCase().includes(q),
        )
      : list;
    const dir = ui.sortDir === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = columnValue(a, ui.sortKey);
      const bv = columnValue(b, ui.sortKey);
      const an = av == null ? -Infinity : typeof av === "string" ? av : Number(av);
      const bn = bv == null ? -Infinity : typeof bv === "string" ? bv : Number(bv);
      return an < bn ? -dir : an > bn ? dir : 0;
    });
  }, [report, ui.search, ui.sortKey, ui.sortDir]);

  const toggleSort = (key: string) => {
    setUi((prev) => ({
      ...prev,
      sortKey: key,
      sortDir: prev.sortKey === key && prev.sortDir === "desc" ? "asc" : "desc",
    }));
  };

  const d = report?.diagnostics;
  const summary = report?.summary;

  return (
    <section className="space-y-4">
      {/* Diagnostics strip — Cohorts-style, one warehouse state per bundle */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          engine: <span className="font-mono text-foreground">ClickHouse</span>
        </span>
        {d && (
          <>
            <span>warehouse rows: {int(d.warehouse_rows)}</span>
            <span>in scope: {int(d.warehouse_rows_in_scope)}</span>
            {d.date_min && d.date_max && (
              <span>dates: {d.date_min} → {d.date_max}</span>
            )}
            {d.last_sync_finished_at && (
              <span>last sync {formatUpdatedAgo(Date.parse(d.last_sync_finished_at))} ({d.last_sync_mode ?? "—"}{d.last_sync_duration_ms != null ? ` · ${(d.last_sync_duration_ms / 1000).toFixed(1)}s` : ""})</span>
            )}
            {d.api_fb_stats_to && <span>API updated: {d.api_fb_stats_to}</span>}
            {d.mapping && (
              <span>
                mapping: <span className="font-mono text-foreground">{d.mapping.join_key}</span>
                {" · matched "}{int(d.mapping.matched_campaigns)}/{int(d.mapping.fb_campaigns)} FB campaigns
                {d.mapping.tx_only_campaigns > 0 && <> · {int(d.mapping.tx_only_campaigns)} tx-only</>}
              </span>
            )}
            <span>version: <span className="font-mono">{d.warehouse_version}</span></span>
            <span>
              report:{" "}
              <span className={d.report_complete ? "font-mono text-foreground" : "font-mono text-warning"}>
                {d.report_complete ? "complete" : "incomplete"}
              </span>
            </span>
          </>
        )}
        {report && <span>ClickHouse {report.query_duration_ms} ms</span>}
        {!isInitialLoading && !isBackgroundRefreshing && report != null && !error && (
          <span>updated {formatUpdatedAgo(dataUpdatedAt)}</span>
        )}
        {(isInitialLoading || isBackgroundRefreshing) && (
          <span className="flex items-center gap-2">
            Updating… {progressPercent}%
            <Progress value={progressPercent} className="h-1.5 w-24" />
          </span>
        )}
        {error && report != null && <span className="text-warning">refresh failed · showing cached data</span>}
        {error && report == null && <span className="text-destructive">ClickHouse error: {error}</span>}
      </div>

      {/* Controls */}
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Date range</Label>
            <Select value={ui.range} onValueChange={(value) => setUi((p) => ({ ...p, range: value as typeof p.range }))}>
              <SelectTrigger className="h-10 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGE_PRESETS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Buyer</Label>
            <Select value={ui.buyer} onValueChange={(value) => setUi((p) => ({ ...p, buyer: value }))}>
              <SelectTrigger className="h-10 w-40"><SelectValue placeholder="All buyers" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All buyers</SelectItem>
                {(report?.filter_options.buyers ?? []).map((b) => (
                  <SelectItem key={b.value} value={b.value}>{b.value} · {usd(b.spend, 0)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Ad account</Label>
            <Select value={ui.account} onValueChange={(value) => setUi((p) => ({ ...p, account: value }))}>
              <SelectTrigger className="h-10 w-56"><SelectValue placeholder="All accounts" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All accounts</SelectItem>
                {(report?.filter_options.accounts ?? []).map((a) => (
                  <SelectItem key={a.value} value={a.value}>{a.label} · {usd(a.spend, 0)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={syncRunning != null} onClick={() => void runSync("incremental")}>
              {syncRunning === "incremental" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              Sync now
            </Button>
            <Button variant="outline" size="sm" disabled={syncRunning != null} onClick={() => void runSync("full")}>
              {syncRunning === "full" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Full sync
            </Button>
          </div>
        </div>
      </Card>

      {/* KPI cards — server-computed totals; blended row joined by campaign_id */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 2xl:grid-cols-8">
        {[
          { label: "Spend", value: usd(summary?.spend ?? null, 0) },
          { label: "FB Purchases", value: int(summary?.fb_purchases ?? null) },
          { label: "CPP", value: usd(summary?.cpp ?? null) },
          { label: "Impressions", value: int(summary?.impressions ?? null) },
          { label: "Clicks", value: int(summary?.clicks ?? null) },
          { label: "CTR", value: pct(summary?.ctr ?? null) },
          { label: "CPC", value: usd(summary?.cpc ?? null) },
          { label: "CPM", value: usd(summary?.cpm ?? null) },
          { label: "Trials (by campaign id)", value: int(summary?.blended?.trial_users ?? null) },
          { label: "CAC", value: usd(summary?.blended?.cac ?? null) },
          { label: "Net Rev (Subengine)", value: usd(summary?.blended?.tx_net_revenue ?? null, 0) },
          { label: "ROAS", value: summary?.blended?.roas == null ? "—" : `${summary.blended.roas.toFixed(2)}x` },
        ].map((kpi) => (
          <Card key={kpi.label} className="p-4 shadow-card">
            <div className="text-xs text-muted-foreground">{kpi.label}</div>
            <div className="mt-1 text-xl font-semibold">{kpi.value}</div>
          </Card>
        ))}
      </div>

      {/* Daily chart — server-built series */}
      {(report?.charts.length ?? 0) > 0 && (
        <Card className="p-4 shadow-card">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-sm font-medium">Daily spend & FB purchases</div>
            <Badge variant="outline">{report?.charts.length} days</Badge>
          </div>
          <ChartContainer config={chartConfig} className="h-64 w-full">
            <AreaChart data={report?.charts ?? []} margin={{ left: 8, right: 8, top: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis dataKey="date" tickLine={false} axisLine={false} minTickGap={24} fontSize={11} />
              <YAxis yAxisId="spend" tickLine={false} axisLine={false} width={56} fontSize={11} />
              <YAxis yAxisId="purch" orientation="right" tickLine={false} axisLine={false} width={40} fontSize={11} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Area yAxisId="spend" dataKey="spend" type="monotone" fill="var(--color-spend)" fillOpacity={0.15} stroke="var(--color-spend)" strokeWidth={2} />
              <Area yAxisId="purch" dataKey="fb_purchases" type="monotone" fill="var(--color-fb_purchases)" fillOpacity={0.1} stroke="var(--color-fb_purchases)" strokeWidth={2} />
            </AreaChart>
          </ChartContainer>
        </Card>
      )}

      {/* Level tabs + entity table — rows aggregated server-side */}
      <Card className="p-4 shadow-card">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Tabs value={ui.level} onValueChange={(value) => setUi((p) => ({ ...p, level: value as FbLevel }))}>
            <TabsList>
              {LEVEL_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Input
            value={ui.search}
            onChange={(e) => setUi((p) => ({ ...p, search: e.target.value }))}
            placeholder="Search name / id…"
            className="h-9 w-64"
          />
          <div className="ml-auto text-xs text-muted-foreground">{int(rows.length)} rows</div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-64">{LEVEL_TABS.find((t) => t.value === ui.level)?.label ?? "Entity"}</TableHead>
                {columns.map((col) => (
                  <TableHead
                    key={col.key}
                    className="cursor-pointer select-none text-right whitespace-nowrap"
                    onClick={() => toggleSort(col.key)}
                  >
                    {col.label}
                    {ui.sortKey === col.key ? (ui.sortDir === "desc" ? " ↓" : " ↑") : ""}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const label = entityLabel(row, ui.level);
                return (
                  <TableRow key={row.key}>
                    <TableCell>
                      <div className="max-w-96 truncate font-medium" title={label.title}>{label.title}</div>
                      <div className="max-w-96 truncate text-xs text-muted-foreground" title={label.subtitle}>{label.subtitle}</div>
                    </TableCell>
                    {columns.map((col) => (
                      <TableCell key={col.key} className="text-right tabular-nums">{col.render(row)}</TableCell>
                    ))}
                  </TableRow>
                );
              })}
              {!rows.length && !isInitialLoading && (
                <TableRow>
                  <TableCell colSpan={columns.length + 1} className="py-8 text-center text-muted-foreground">
                    {status?.state ? "No rows in this scope. Try a wider date range or run a sync." : "Warehouse is empty — run Full sync to load Capsuled history."}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </Card>
    </section>
  );
}
