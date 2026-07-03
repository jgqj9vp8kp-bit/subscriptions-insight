import { useEffect, useMemo } from "react";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Check,
  ChevronDown,
  CreditCard,
  DollarSign,
  RotateCcw,
  Search,
  Target,
  TrendingUp,
  Users,
  X,
} from "lucide-react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { cn } from "@/lib/utils";
import { formatCurrency, formatPct } from "@/services/analytics";
import { aggregateTrafficMetrics } from "@/services/cohortReporting";
import {
  buildFbAnalytics,
  campaignDisplayName,
  fbAnalyticsCohortBaselineTotals,
  logFbReconciliationInDev,
  reconcileFbAnalyticsTotals,
  sortFbAnalyticsRows,
  type FbAnalyticsRow,
  type FbAnalyticsSortKey,
} from "@/services/fbAnalytics";
import { enrichTransactionDeclinesFromRawRows } from "@/services/paymentFailures";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { useTransactions } from "@/services/sheets";
import { CARD_TYPE_VALUES, cardTypeForUserTransactions, cardTypeLabel } from "@/services/userCardType";
import { countryCodeForUserTransactions, normalizeCountryCode } from "@/services/userCountry";
import { useDataStore } from "@/store/dataStore";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { CardType, Transaction } from "@/services/types";

// Wait this long after the last filter change before running the (heavy) analytics recompute.
const FILTER_DEBOUNCE_MS = 300;

const DEFAULT_FB_ANALYTICS_UI_STATE = {
  campaignPathFilter: "all",
  cohortDateFrom: "",
  cohortDateTo: "",
  selectedCountries: [] as string[],
  selectedCardTypes: [] as CardType[],
  campaignIdSearch: "",
  sortKey: "trial_users" as FbAnalyticsTableSortKey,
  sortDir: "desc" as "asc" | "desc",
};

type FbAnalyticsTableSortKey =
  | FbAnalyticsSortKey
  | "campaign_id"
  | "campaign_name"
  | "campaign_path"
  | "upsell_users"
  | "first_subscription_users"
  | "renewal_2_users"
  | "renewal_3_users"
  | "active_subscriptions"
  | "gross_revenue"
  | "refund_users";

interface MultiSelectOption<T extends string> {
  value: T;
  label: string;
  count?: number;
}

function groupTransactionsByUser(txs: Transaction[]): Map<string, Transaction[]> {
  const byUser = new Map<string, Transaction[]>();
  for (const tx of txs) {
    const userKey = tx.user_id || tx.email || tx.transaction_id;
    const list = byUser.get(userKey) ?? [];
    list.push(tx);
    byUser.set(userKey, list);
  }
  return byUser;
}

function successfulFacebookTrials(txs: Transaction[]): Transaction[] {
  return txs.filter((tx) => tx.status === "success" && tx.transaction_type === "trial" && tx.traffic_source === "facebook");
}

function successfulAttributionTrials(txs: Transaction[]): Transaction[] {
  const facebookTrials = successfulFacebookTrials(txs);
  return facebookTrials.length
    ? facebookTrials
    : txs.filter((tx) => tx.status === "success" && tx.transaction_type === "trial");
}

function buildCampaignPathOptions(txs: Transaction[]): string[] {
  return Array.from(
    new Set(
      successfulAttributionTrials(txs)
        .map((tx) => String(tx.campaign_path ?? "").trim())
        .filter(Boolean),
    ),
  ).sort((a, b) => a.localeCompare(b));
}

function buildCountryOptions(txs: Transaction[]): MultiSelectOption<string>[] {
  const counts = new Map<string, number>();
  const useFacebookOnly = successfulFacebookTrials(txs).length > 0;
  groupTransactionsByUser(txs).forEach((list) => {
    if (!list.some((tx) => tx.status === "success" && tx.transaction_type === "trial" && (!useFacebookOnly || tx.traffic_source === "facebook"))) return;
    const country = countryCodeForUserTransactions(list);
    if (!country) return;
    counts.set(country, (counts.get(country) ?? 0) + 1);
  });
  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: value, count }));
}

function buildCardTypeOptions(txs: Transaction[]): MultiSelectOption<CardType>[] {
  const counts = new Map<CardType, number>();
  const useFacebookOnly = successfulFacebookTrials(txs).length > 0;
  groupTransactionsByUser(txs).forEach((list) => {
    if (!list.some((tx) => tx.status === "success" && tx.transaction_type === "trial" && (!useFacebookOnly || tx.traffic_source === "facebook"))) return;
    const cardType = cardTypeForUserTransactions(list);
    counts.set(cardType, (counts.get(cardType) ?? 0) + 1);
  });
  return CARD_TYPE_VALUES.map((value) => ({ value, label: cardTypeLabel(value), count: counts.get(value) ?? 0 })).filter(
    (option) => option.count,
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function formatMaybeCurrency(value: number | null): string {
  return value == null ? "-" : formatCurrency(value);
}

function formatRoas(value: number | null): string {
  return value == null ? "-" : `${value.toFixed(2)}x`;
}

function sortIcon(active: boolean, dir: "asc" | "desc") {
  if (!active) return <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" />;
  return dir === "asc" ? <ArrowUp className="h-3.5 w-3.5" /> : <ArrowDown className="h-3.5 w-3.5" />;
}

function declineLabel(value: string | null): string {
  return value ? value.replace(/_/g, " ") : "-";
}

function shortCampaignLabel(row: FbAnalyticsRow): string {
  const label = row.campaign_name || row.campaign_id;
  return label.length > 18 ? `${label.slice(0, 16)}...` : label;
}

function compareNullableNumber(a: number | null, b: number | null, direction: 1 | -1): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (a === b) return 0;
  return a < b ? -direction : direction;
}

function sortRows(rows: FbAnalyticsRow[], sortKey: FbAnalyticsTableSortKey, sortDir: "asc" | "desc"): FbAnalyticsRow[] {
  const serviceSortKeys: FbAnalyticsSortKey[] = [
    "trial_users",
    "upsell_cr",
    "trial_to_sub_cr",
    "net_revenue",
    "spend",
    "cac",
    "roas",
    "refund_rate",
    "failed_payment_users",
  ];
  if (serviceSortKeys.includes(sortKey as FbAnalyticsSortKey)) {
    return sortFbAnalyticsRows(rows, sortKey as FbAnalyticsSortKey, sortDir);
  }

  const direction = sortDir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[sortKey];
    const bv = b[sortKey];
    if (typeof av === "number" || typeof bv === "number") {
      return compareNullableNumber(typeof av === "number" ? av : null, typeof bv === "number" ? bv : null, direction);
    }
    const result = String(av ?? "").localeCompare(String(bv ?? ""));
    if (result !== 0) return result * direction;
    return a.campaign_id.localeCompare(b.campaign_id);
  });
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="min-w-0">
      <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function MultiSelect<T extends string>({
  label,
  values,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  values: T[];
  options: MultiSelectOption<T>[];
  placeholder: string;
  onChange: (values: T[]) => void;
}) {
  const selected = new Set(values);
  const text = values.length ? `${values.length} selected` : placeholder;
  return (
    <div className="space-y-2">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Popover>
        <PopoverTrigger asChild>
          <Button type="button" variant="outline" className="h-10 w-full justify-between px-3 font-normal">
            <span className={cn("truncate", values.length ? "text-foreground" : "text-muted-foreground")}>{text}</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
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
              const checked = selected.has(option.value);
              return (
                <button
                  type="button"
                  key={option.value}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted"
                  onClick={() => onChange(checked ? values.filter((value) => value !== option.value) : [...values, option.value])}
                >
                  <Checkbox checked={checked} className="pointer-events-none" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.count != null && <span className="text-xs tabular-nums text-muted-foreground">{option.count}</span>}
                </button>
              );
            }) : (
              <div className="px-3 py-6 text-center text-sm text-muted-foreground">No options</div>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

const trialChartConfig = {
  trial_users: { label: "Trial Users", color: "hsl(var(--primary))" },
} satisfies ChartConfig;

const revenueChartConfig = {
  net_revenue: { label: "Net Rev", color: "hsl(var(--success))" },
} satisfies ChartConfig;

const roasChartConfig = {
  roas: { label: "ROAS", color: "hsl(var(--accent))" },
} satisfies ChartConfig;

export default function FBAnalyticsPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((state) => state.subscriptions);
  const trafficMetrics = useDataStore((state) => state.trafficMetrics);
  const rawPalmerRows = useDataStore((state) => state.rawPalmerRows);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_fb_analytics", DEFAULT_FB_ANALYTICS_UI_STATE);

  const enrichedTxs = useMemo(
    () => enrichTransactionDeclinesFromRawRows(backfillTransactionCardTypesFromRawRows(txs, rawPalmerRows), rawPalmerRows),
    [txs, rawPalmerRows],
  );
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);

  const selectedCountries = useMemo(
    () =>
      Array.isArray(uiState.selectedCountries)
        ? uiState.selectedCountries.flatMap((value) => {
          const normalized = normalizeCountryCode(value);
          return normalized ? [normalized] : [];
        })
        : [],
    [uiState.selectedCountries],
  );
  const selectedCardTypes = useMemo(
    () =>
      Array.isArray(uiState.selectedCardTypes)
        ? uiState.selectedCardTypes.filter((value): value is CardType => CARD_TYPE_VALUES.includes(value as CardType))
        : [],
    [uiState.selectedCardTypes],
  );

  const campaignPathOptions = useMemo(() => buildCampaignPathOptions(enrichedTxs), [enrichedTxs]);
  const countryOptions = useMemo(() => buildCountryOptions(enrichedTxs), [enrichedTxs]);
  const cardTypeOptions = useMemo(() => buildCardTypeOptions(enrichedTxs), [enrichedTxs]);

  const fbFilters = useMemo(
    () => ({
      campaignPathFilter: uiState.campaignPathFilter,
      cohortDateFrom: uiState.cohortDateFrom,
      cohortDateTo: uiState.cohortDateTo,
      selectedCountries,
      selectedCardTypes,
      campaignIdSearch: uiState.campaignIdSearch,
    }),
    [
      uiState.campaignPathFilter,
      uiState.cohortDateFrom,
      uiState.cohortDateTo,
      selectedCountries,
      selectedCardTypes,
      uiState.campaignIdSearch,
    ],
  );

  // buildFbAnalytics is the heaviest client computation on this page (it runs computeCohorts per
  // campaign and per trial user). The filter controls read the live `uiState`, so clicks update
  // instantly; the expensive recompute reads `appliedFbFilters`, which is the same object debounced
  // by FILTER_DEBOUNCE_MS and committed inside a transition. Rapid multi-select clicks collapse into
  // a single recompute and `isRecalculating` drives the loading affordance. The applied filters feed
  // every downstream derive (result, rows, charts, totals, the dev baseline) so the numbers stay
  // internally consistent — only the timing changes, never the formula.
  const [appliedFbFilters, isRecalculating] = useDebouncedValue(fbFilters, FILTER_DEBOUNCE_MS);

  const result = useMemo(
    () => buildFbAnalytics({ txs: enrichedTxs, subscriptions, trafficByKey, filters: appliedFbFilters }),
    [enrichedTxs, subscriptions, trafficByKey, appliedFbFilters],
  );

  // Dev-only guardrail (Phase 6): warn if FB Analytics totals drift from Cohorts for the same filters.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    logFbReconciliationInDev(
      reconcileFbAnalyticsTotals(
        result.summary,
        fbAnalyticsCohortBaselineTotals({ txs: enrichedTxs, subscriptions, filters: appliedFbFilters }),
      ),
    );
  }, [result.summary, enrichedTxs, subscriptions, appliedFbFilters]);

  const rows = useMemo(() => sortRows(result.rows, uiState.sortKey, uiState.sortDir), [result.rows, uiState.sortKey, uiState.sortDir]);
  const topTrials = useMemo(() => rows.slice(0, 10).map((row) => ({ ...row, label: shortCampaignLabel(row) })), [rows]);
  const topRevenue = useMemo(
    () => [...rows].sort((a, b) => b.net_revenue - a.net_revenue).slice(0, 10).map((row) => ({ ...row, label: shortCampaignLabel(row) })),
    [rows],
  );
  const topRoas = useMemo(
    () =>
      rows
        .filter((row) => row.roas != null)
        .sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0))
        .slice(0, 10)
        .map((row) => ({ ...row, label: shortCampaignLabel(row) })),
    [rows],
  );

  const updateUiState = (patch: Partial<typeof DEFAULT_FB_ANALYTICS_UI_STATE>) => {
    setUiState((current) => ({ ...current, ...patch }));
  };
  const toggleSort = (sortKey: FbAnalyticsTableSortKey) => {
    updateUiState({
      sortKey,
      sortDir: uiState.sortKey === sortKey && uiState.sortDir === "desc" ? "asc" : "desc",
    });
  };

  const columns: Array<{ key: FbAnalyticsTableSortKey; label: string; align?: "left" | "right"; render: (row: FbAnalyticsRow) => string }> = [
    { key: "campaign_id", label: "Campaign ID", render: (row) => row.campaign_id },
    { key: "campaign_name", label: "Campaign Name", render: (row) => row.campaign_name ?? "-" },
    { key: "campaign_path", label: "Funnel / Path", render: (row) => row.campaign_path },
    { key: "trial_users", label: "Trial Users", align: "right", render: (row) => formatNumber(row.trial_users) },
    { key: "upsell_users", label: "Upsell Users", align: "right", render: (row) => formatNumber(row.upsell_users) },
    { key: "upsell_cr", label: "Upsell CR", align: "right", render: (row) => formatPct(row.upsell_cr) },
    { key: "first_subscription_users", label: "First Sub", align: "right", render: (row) => formatNumber(row.first_subscription_users) },
    { key: "trial_to_sub_cr", label: "Trial -> Sub CR", align: "right", render: (row) => formatPct(row.trial_to_sub_cr) },
    { key: "renewal_2_users", label: "Renewal 2", align: "right", render: (row) => formatNumber(row.renewal_2_users) },
    { key: "renewal_3_users", label: "Renewal 3", align: "right", render: (row) => formatNumber(row.renewal_3_users) },
    { key: "active_subscriptions", label: "Active Subs", align: "right", render: (row) => formatNumber(row.active_subscriptions) },
    { key: "gross_revenue", label: "Gross Rev", align: "right", render: (row) => formatCurrency(row.gross_revenue) },
    { key: "net_revenue", label: "Net Rev", align: "right", render: (row) => formatCurrency(row.net_revenue) },
    { key: "spend", label: "Spend", align: "right", render: (row) => (row.spend != null ? formatMaybeCurrency(row.spend) : "Spend unavailable") },
    { key: "cac", label: "CAC", align: "right", render: (row) => formatMaybeCurrency(row.cac) },
    { key: "roas", label: "ROAS", align: "right", render: (row) => formatRoas(row.roas) },
    { key: "refund_users", label: "Refund Users", align: "right", render: (row) => formatNumber(row.refund_users) },
    { key: "refund_rate", label: "Refund Rate", align: "right", render: (row) => formatPct(row.refund_rate) },
    { key: "failed_payment_users", label: "Failed Pay Users", align: "right", render: (row) => formatNumber(row.failed_payment_users) },
  ];

  return (
    <AppLayout title="FB-Analytics" description="Facebook traffic performance by Campaign ID">
      <section className="space-y-4">
        <Card className="p-4 shadow-card">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(220px,1.4fr)_repeat(2,minmax(160px,1fr))_repeat(2,minmax(170px,1fr))_minmax(220px,1.3fr)_auto]">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Funnel / Campaign Path</Label>
              <Select value={uiState.campaignPathFilter} onValueChange={(value) => updateUiState({ campaignPathFilter: value })}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="All paths" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All paths</SelectItem>
                  {campaignPathOptions.map((path) => (
                    <SelectItem key={path} value={path}>{path}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Cohort date from</Label>
              <Input
                type="date"
                value={uiState.cohortDateFrom}
                onChange={(event) => updateUiState({ cohortDateFrom: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Cohort date to</Label>
              <Input
                type="date"
                value={uiState.cohortDateTo}
                onChange={(event) => updateUiState({ cohortDateTo: event.target.value })}
              />
            </div>
            <MultiSelect
              label="GEO"
              values={selectedCountries}
              options={countryOptions}
              placeholder="All countries"
              onChange={(values) => updateUiState({ selectedCountries: values })}
            />
            <MultiSelect
              label="Card Type"
              values={selectedCardTypes}
              options={cardTypeOptions}
              placeholder="All card types"
              onChange={(values) => updateUiState({ selectedCardTypes: values })}
            />
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Campaign ID</Label>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  className="h-10 pl-9 pr-9"
                  placeholder="Search ID or name"
                  value={uiState.campaignIdSearch}
                  onChange={(event) => updateUiState({ campaignIdSearch: event.target.value })}
                />
                {uiState.campaignIdSearch && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 h-8 w-8 -translate-y-1/2"
                    onClick={() => updateUiState({ campaignIdSearch: "" })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" className="h-10 w-full" onClick={resetUiState}>
                <RotateCcw className="h-4 w-4" />
                Reset
              </Button>
            </div>
          </div>
        </Card>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          <KpiCard label="Campaign IDs" value={formatNumber(result.summary.campaignIdsCount)} icon={<BarChart3 className="h-4 w-4" />} />
          <KpiCard label="Trial Users" value={formatNumber(result.summary.trialUsers)} icon={<Users className="h-4 w-4" />} />
          <KpiCard label="Upsell CR" value={formatPct(result.summary.upsellCr)} icon={<Target className="h-4 w-4" />} />
          <KpiCard label="Trial -> Sub CR" value={formatPct(result.summary.trialToSubCr)} icon={<CreditCard className="h-4 w-4" />} />
          <KpiCard label="Net Rev" value={formatCurrency(result.summary.netRevenue)} icon={<DollarSign className="h-4 w-4" />} accent="success" />
          <KpiCard label="Upsell Users" value={formatNumber(result.summary.upsellUsers)} icon={<Users className="h-4 w-4" />} />
          <KpiCard label="First Sub Users" value={formatNumber(result.summary.firstSubscriptionUsers)} icon={<CreditCard className="h-4 w-4" />} />
          <KpiCard
            label="Spend"
            value={formatMaybeCurrency(result.summary.spend)}
            hint="Totals campaigns whose path maps to a single Campaign ID; shared paths show 'Spend unavailable'"
            icon={<TrendingUp className="h-4 w-4" />}
          />
          <KpiCard label="CAC" value={formatMaybeCurrency(result.summary.cac)} icon={<Target className="h-4 w-4" />} />
          <KpiCard label="ROAS" value={formatRoas(result.summary.roas)} icon={<TrendingUp className="h-4 w-4" />} accent="accent" />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Card className="p-4 shadow-card">
            <SectionHeader title="Top Campaign IDs by Trials" />
            {topTrials.length ? (
              <ChartContainer config={trialChartConfig} className="mt-3 h-[260px] w-full">
                <BarChart data={topTrials} margin={{ left: 8, right: 16, top: 8, bottom: 38 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} angle={-18} textAnchor="end" height={58} />
                  <YAxis tickLine={false} axisLine={false} width={44} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="trial_users" fill="var(--color-trial_users)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : <EmptyState message="No Campaign IDs for current filters" />}
          </Card>
          <Card className="p-4 shadow-card">
            <SectionHeader title="Top Campaign IDs by Net Rev" />
            {topRevenue.length ? (
              <ChartContainer config={revenueChartConfig} className="mt-3 h-[260px] w-full">
                <BarChart data={topRevenue} margin={{ left: 8, right: 16, top: 8, bottom: 38 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} angle={-18} textAnchor="end" height={58} />
                  <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(value) => `$${Number(value).toLocaleString("en-US")}`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="net_revenue" fill="var(--color-net_revenue)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : <EmptyState message="No revenue for current filters" />}
          </Card>
          <Card className="p-4 shadow-card">
            <SectionHeader title="ROAS Comparison" description="Available only when spend is attributable safely." />
            {topRoas.length ? (
              <ChartContainer config={roasChartConfig} className="mt-3 h-[260px] w-full">
                <BarChart data={topRoas} margin={{ left: 8, right: 16, top: 8, bottom: 38 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval={0} angle={-18} textAnchor="end" height={58} />
                  <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(value) => `${value}x`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="roas" fill="var(--color-roas)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            ) : <EmptyState message="No Campaign ID-level spend for current filters" />}
          </Card>
        </div>

        <Card className="shadow-card">
          <div className="flex items-center justify-between gap-3 border-b border-border p-4">
            <SectionHeader
              title="Campaign ID Performance"
              description={`${formatNumber(rows.length)} Campaign IDs from filtered Facebook trial users`}
            />
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              {isRecalculating ? (
                <>
                  <RotateCcw className="h-3.5 w-3.5 animate-spin" />
                  Recalculating…
                </>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5" />
                  Cohort metrics use trial-user attribution
                </>
              )}
            </div>
          </div>
          <div className={cn("overflow-x-auto transition-opacity", isRecalculating && "pointer-events-none opacity-60")}>
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((column) => (
                    <TableHead key={column.key} className={cn("whitespace-nowrap", column.align === "right" && "text-right")}>
                      <button
                        type="button"
                        className={cn("inline-flex items-center gap-1 hover:text-foreground", column.align === "right" && "justify-end")}
                        onClick={() => toggleSort(column.key)}
                      >
                        {column.label}
                        {sortIcon(uiState.sortKey === column.key, uiState.sortDir)}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="whitespace-nowrap">Main Decline Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length ? rows.map((row) => (
                  <TableRow key={row.campaign_id}>
                    {columns.map((column) => (
                      <TableCell
                        key={column.key}
                        className={cn(
                          "whitespace-nowrap text-sm",
                          column.align === "right" && "text-right tabular-nums",
                          column.key === "campaign_id" && "font-medium",
                          column.key === "campaign_name" && "max-w-[260px] truncate text-muted-foreground",
                        )}
                        title={column.key === "campaign_id" || column.key === "campaign_name" ? campaignDisplayName(row) : undefined}
                      >
                        {column.render(row)}
                      </TableCell>
                    ))}
                    <TableCell className="whitespace-nowrap text-sm capitalize text-muted-foreground">
                      {declineLabel(row.main_decline_reason)}
                    </TableCell>
                  </TableRow>
                )) : (
                  <TableRow>
                    <TableCell colSpan={columns.length + 1} className="h-40 text-center text-sm text-muted-foreground">
                      No Campaign IDs for current filters
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Card>
      </section>
    </AppLayout>
  );
}
