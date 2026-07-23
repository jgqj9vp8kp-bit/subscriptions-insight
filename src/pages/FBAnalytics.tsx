import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Check,
  ChevronDown,
  CreditCard,
  Download,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { FbWarehouseAnalytics } from "@/components/FbWarehouseAnalytics";
import { useToast } from "@/hooks/use-toast";
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
import { fbAnalyticsSource, fetchFbAnalyticsSummary } from "@/services/fbAnalyticsSummaryClient";
import { FbWarehouseHealth } from "@/components/FbWarehouseHealth";
import { reconcileFbAnalyticsSummaries } from "../../supabase/functions/_shared/clickhouse/fbAnalyticsSummary.ts";
import { useQuery } from "@tanstack/react-query";
import {
  getCapsuledFacebookStatus,
  listCapsuledFacebookRows,
  syncCapsuledFacebookStats,
  type CapsuledFacebookSyncMetadata,
  type CapsuledFacebookRow,
} from "@/services/capsuledFacebook";
import {
  buildFbTrafficDiagnostics,
  exportMissingCampaignIdsCsv,
  fbTrafficStatusLabel,
  type FbTrafficDiagnosticCampaign,
  type FbTrafficMatchStatus,
} from "@/services/fbTrafficDiagnostics";
import { enrichTransactionDeclinesFromRawRows } from "@/services/paymentFailures";
import { backfillTransactionCardTypesFromRawRows } from "@/services/palmerTransform";
import { useTransactions } from "@/services/sheets";
import { CARD_TYPE_VALUES, cardTypeForUserTransactions, cardTypeLabel } from "@/services/userCardType";
import { countryCodeForUserTransactions, normalizeCountryCode } from "@/services/userCountry";
import { MEDIA_BUYER_VALUES } from "@/services/userMediaBuyer";
import { useDataStore } from "@/store/dataStore";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { CardType, Transaction } from "@/services/types";

// Wait this long after the last filter change before running the (heavy) analytics recompute.
const FILTER_DEBOUNCE_MS = 300;

const DEFAULT_FB_ANALYTICS_UI_STATE = {
  campaignPathFilter: "all",
  funnelFilter: "all",
  mediaBuyerFilter: "all",
  adAccountFilter: "all",
  cohortDateFrom: "",
  cohortDateTo: "",
  selectedCountries: [] as string[],
  selectedCardTypes: [] as CardType[],
  campaignIdSearch: "",
  campaignNameSearch: "",
  sortKey: "trial_users" as FbAnalyticsTableSortKey,
  sortDir: "desc" as "asc" | "desc",
};

const DIAGNOSTIC_STATUS_VALUES: FbTrafficMatchStatus[] = [
  "matched",
  "missing_in_capsuled",
  "capsuled_only",
  "missing_campaign_id",
  "duplicate_in_capsuled",
  "outside_date_range",
  "sync_not_run",
  "level_mismatch",
  "unknown",
];

const SYNC_STAGES = [
  { id: "fetching", label: "Fetching campaigns..." },
  { id: "downloading", label: "Downloading statistics..." },
  { id: "matching", label: "Matching Campaign IDs..." },
  { id: "refreshing", label: "Refreshing diagnostics..." },
] as const;

type SyncStageId = (typeof SYNC_STAGES)[number]["id"];
type SyncStatus = "idle" | "syncing" | "success" | "partial" | "failed";

interface FacebookSyncReport {
  status: SyncStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  rowsImported: number;
  campaignsImported: number;
  matchedCampaigns: number;
  unmatchedCampaigns: number;
  duplicates: number;
  totalSpend: number;
  fbPurchases: number;
  dateFrom: string;
  dateTo: string;
  lastSyncAt: string | null;
  apiLevel: string;
  warnings: string[];
  error: string | null;
}

interface FacebookSyncState {
  status: SyncStatus;
  stage: SyncStageId | null;
  report: FacebookSyncReport | null;
}

type FbAnalyticsTableSortKey =
  | FbAnalyticsSortKey
  | "campaign_id"
  | "campaign_name"
  | "campaign_path"
  | "ad_account_name"
  | "fb_purchases"
  | "cpp"
  | "impressions"
  | "clicks"
  | "ctr"
  | "cpc"
  | "cpm"
  | "outbound_ctr"
  | "upsell_users"
  | "upsell_1_users"
  | "upsell_2_users"
  | "upsell_3_users"
  | "token_buyers"
  | "token_revenue"
  | "first_subscription_users"
  | "renewal_2_users"
  | "renewal_3_users"
  | "active_subscriptions"
  | "gross_revenue"
  | "cost_per_first_sub"
  | "revenue_per_trial"
  | "revenue_per_purchase"
  | "profit"
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

function buildFunnelOptions(txs: Transaction[]): string[] {
  return Array.from(new Set(successfulAttributionTrials(txs).map((tx) => tx.funnel).filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function buildAdAccountOptions(rows: CapsuledFacebookRow[]): MultiSelectOption<string>[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const id = row.ad_account_id?.trim();
    if (!id) continue;
    const current = counts.get(id) ?? { label: row.ad_account_name ? `${row.ad_account_name} (${id})` : id, count: 0 };
    current.count += 1;
    counts.set(id, current);
  }
  return Array.from(counts.entries())
    .sort((a, b) => a[1].label.localeCompare(b[1].label))
    .map(([value, entry]) => ({ value, label: entry.label, count: entry.count }));
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

function formatMaybePct(value: number | null): string {
  return value == null ? "-" : formatPct(value);
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} seconds`;
}

function dateKey(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match) return match[1];
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function isoDateDaysAgo(days: number, fromDate = new Date()): string {
  const date = new Date(fromDate);
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function downloadTextFile(filename: string, text: string, mime = "text/csv;charset=utf-8"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function warningMessageClass() {
  return "rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive";
}

function DiagnosticDetail({ diagnostic }: { diagnostic: FbTrafficDiagnosticCampaign | undefined }) {
  if (!diagnostic) return null;
  return (
    <details className="mt-1 text-left text-xs text-muted-foreground">
      <summary className="cursor-pointer text-primary">Details</summary>
      <div className="mt-2 space-y-1 rounded-md border border-border bg-background p-2">
        <div>Campaign ID: <span className="font-mono text-foreground">{diagnostic.campaign_id}</span></div>
        <div>Warehouse: <span className="text-foreground">{diagnostic.warehouse_present ? "present" : "not present"}</span></div>
        <div>Capsuled: <span className="text-foreground">{diagnostic.capsuled_present ? "present" : "not present"}</span></div>
        <div>Last sync: <span className="text-foreground">{formatDateTime(diagnostic.last_sync_at)}</span></div>
        <div>Reason: <span className="text-foreground">{diagnostic.reason}</span></div>
      </div>
    </details>
  );
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
  const { toast } = useToast();
  const txs = useTransactions();
  const subscriptions = useDataStore((state) => state.subscriptions);
  const trafficMetrics = useDataStore((state) => state.trafficMetrics);
  const rawPalmerRows = useDataStore((state) => state.rawPalmerRows);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_fb_analytics", DEFAULT_FB_ANALYTICS_UI_STATE);
  const [capsuledRows, setCapsuledRows] = useState<CapsuledFacebookRow[]>([]);
  const [capsuledStatus, setCapsuledStatus] = useState<CapsuledFacebookSyncMetadata | null>(null);
  const [diagnosticStatusFilter, setDiagnosticStatusFilter] = useState<FbTrafficMatchStatus | "all">("all");
  const [diagnosticHasSpendFilter, setDiagnosticHasSpendFilter] = useState("all");
  const [diagnosticHasMatchFilter, setDiagnosticHasMatchFilter] = useState("all");
  const [diagnosticSearch, setDiagnosticSearch] = useState("");
  const [activeTab, setActiveTab] = useState("performance");
  const [syncState, setSyncState] = useState<FacebookSyncState>({
    status: "idle",
    stage: null,
    report: null,
  });

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
  const funnelOptions = useMemo(() => buildFunnelOptions(enrichedTxs), [enrichedTxs]);
  const countryOptions = useMemo(() => buildCountryOptions(enrichedTxs), [enrichedTxs]);
  const cardTypeOptions = useMemo(() => buildCardTypeOptions(enrichedTxs), [enrichedTxs]);
  const adAccountOptions = useMemo(() => buildAdAccountOptions(capsuledRows), [capsuledRows]);

  const loadCapsuledDiagnostics = async (showToast = false) => {
    try {
      const [rows, status] = await Promise.all([
        listCapsuledFacebookRows(),
        getCapsuledFacebookStatus().catch(() => null),
      ]);
      setCapsuledRows(rows);
      setCapsuledStatus(status);
      if (showToast) {
        toast({
          title: rows.length ? "FB diagnostics refreshed" : "No Capsuled data found",
          description: rows.length
            ? `Loaded ${rows.length.toLocaleString("en-US")} Capsuled rows.`
            : "Capsuled Facebook data is empty. Run Capsuled sync from Integrations.",
        });
      }
    } catch (error) {
      toast({
        title: "Could not refresh FB diagnostics",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  useEffect(() => {
    void loadCapsuledDiagnostics(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fbFilters = useMemo(
    () => ({
      campaignPathFilter: uiState.campaignPathFilter,
      funnelFilter: uiState.funnelFilter,
      mediaBuyerFilter: uiState.mediaBuyerFilter,
      adAccountFilter: uiState.adAccountFilter,
      cohortDateFrom: uiState.cohortDateFrom,
      cohortDateTo: uiState.cohortDateTo,
      selectedCountries,
      selectedCardTypes,
      campaignIdSearch: uiState.campaignIdSearch,
      campaignNameSearch: uiState.campaignNameSearch,
    }),
    [
      uiState.campaignPathFilter,
      uiState.funnelFilter,
      uiState.mediaBuyerFilter,
      uiState.adAccountFilter,
      uiState.cohortDateFrom,
      uiState.cohortDateTo,
      selectedCountries,
      selectedCardTypes,
      uiState.campaignIdSearch,
      uiState.campaignNameSearch,
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
  const campaignLevelCapsuledRows = useMemo(() => capsuledRows.filter((row) => row.level === "campaign"), [capsuledRows]);
  const syncDateRange = useMemo(() => {
    const selectedFrom = dateKey(appliedFbFilters.cohortDateFrom);
    const selectedTo = dateKey(appliedFbFilters.cohortDateTo);
    if (selectedFrom && selectedTo) return { dateFrom: selectedFrom, dateTo: selectedTo };
    if (selectedFrom) return { dateFrom: selectedFrom, dateTo: new Date().toISOString().slice(0, 10) };
    if (selectedTo) return { dateFrom: isoDateDaysAgo(30, new Date(`${selectedTo}T00:00:00Z`)), dateTo: selectedTo };
    return { dateFrom: isoDateDaysAgo(30), dateTo: new Date().toISOString().slice(0, 10) };
  }, [appliedFbFilters.cohortDateFrom, appliedFbFilters.cohortDateTo]);

  const clientResult = useMemo(
    () => buildFbAnalytics({ txs: enrichedTxs, subscriptions, trafficByKey, capsuledRows: campaignLevelCapsuledRows, filters: appliedFbFilters }),
    [enrichedTxs, subscriptions, trafficByKey, campaignLevelCapsuledRows, appliedFbFilters],
  );
  // Parity-first server path (VITE_FB_ANALYTICS_SOURCE=server): render the Edge Function
  // summary when available, keep the client compute as the always-on fallback, and in DEV
  // reconcile both so formula drift is caught before the client compute is ever gated off.
  const serverSummaryEnabled = fbAnalyticsSource() === "server";
  const serverSummaryQuery = useQuery({
    queryKey: ["fb-analytics-summary", appliedFbFilters],
    queryFn: () => fetchFbAnalyticsSummary(appliedFbFilters),
    enabled: serverSummaryEnabled,
    staleTime: 60_000,
  });
  const serverSummary = serverSummaryEnabled && serverSummaryQuery.data?.ok ? serverSummaryQuery.data : null;
  const result = useMemo(
    () => (serverSummary ? { rows: serverSummary.rows, summary: serverSummary.summary } : clientResult),
    [serverSummary, clientResult],
  );
  useEffect(() => {
    if (!import.meta.env.DEV || !serverSummary) return;
    const mismatches = reconcileFbAnalyticsSummaries(serverSummary.summary, clientResult.summary);
    if (mismatches.length) {
      console.warn("[FB Analytics] Server summary does not reconcile with the client compute", { mismatches, meta: serverSummary.meta });
    }
  }, [serverSummary, clientResult]);
  const warehouseCampaignIds = useMemo(
    () => result.rows.filter((row) => row.trial_users > 0).map((row) => row.campaign_id),
    [result.rows],
  );
  const trafficDiagnostics = useMemo(
    () =>
      buildFbTrafficDiagnostics({
        warehouseCampaignIds,
        capsuledRows,
        dateFrom: appliedFbFilters.cohortDateFrom,
        dateTo: appliedFbFilters.cohortDateTo,
        selectedLevel: "campaign",
        latestSyncMetadata: capsuledStatus,
      }),
    [warehouseCampaignIds, capsuledRows, appliedFbFilters.cohortDateFrom, appliedFbFilters.cohortDateTo, capsuledStatus],
  );
  const diagnosticsByCampaignId = useMemo(
    () => new Map(trafficDiagnostics.campaigns.map((campaign) => [campaign.campaign_id, campaign])),
    [trafficDiagnostics],
  );

  const runFacebookSync = async () => {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const baseReport: FacebookSyncReport = {
      status: "syncing",
      startedAt,
      finishedAt: null,
      durationMs: null,
      rowsImported: 0,
      campaignsImported: 0,
      matchedCampaigns: 0,
      unmatchedCampaigns: 0,
      duplicates: 0,
      totalSpend: 0,
      fbPurchases: 0,
      dateFrom: syncDateRange.dateFrom,
      dateTo: syncDateRange.dateTo,
      lastSyncAt: null,
      apiLevel: "campaign",
      warnings: [],
      error: null,
    };
    setSyncState({ status: "syncing", stage: "fetching", report: baseReport });

    try {
      await sleep(150);
      setSyncState((current) => ({ ...current, stage: "downloading" }));
      const syncResult = await syncCapsuledFacebookStats({
        dateFrom: syncDateRange.dateFrom,
        dateTo: syncDateRange.dateTo,
        level: "campaign",
      });

      setSyncState((current) => ({ ...current, stage: "matching" }));
      const [freshRows, freshStatus] = await Promise.all([
        listCapsuledFacebookRows(),
        getCapsuledFacebookStatus().catch(() => syncResult.metadata),
      ]);

      const nextDiagnostics = buildFbTrafficDiagnostics({
        warehouseCampaignIds,
        capsuledRows: freshRows,
        dateFrom: syncDateRange.dateFrom,
        dateTo: syncDateRange.dateTo,
        selectedLevel: "campaign",
        latestSyncMetadata: freshStatus,
      });

      setSyncState((current) => ({ ...current, stage: "refreshing" }));
      setCapsuledRows(freshRows);
      setCapsuledStatus(freshStatus);
      await sleep(150);

      const finishedAt = new Date().toISOString();
      const unmatched = nextDiagnostics.summary.unmatched_warehouse_campaign_ids_count;
      const duplicates = nextDiagnostics.summary.duplicate_capsuled_campaign_ids_count;
      const warnings = [
        ...(unmatched > 0 ? [`${unmatched.toLocaleString("en-US")} Campaign IDs were not found in Capsuled.`] : []),
        ...(duplicates > 0 ? [`${duplicates.toLocaleString("en-US")} duplicate Campaign IDs were returned by Capsuled.`] : []),
        ...(nextDiagnostics.summary.rows_without_spend_count > 0
          ? [`${nextDiagnostics.summary.rows_without_spend_count.toLocaleString("en-US")} rows have no spend.`]
          : []),
      ];
      const status: SyncStatus = unmatched > 0 || duplicates > 0 ? "partial" : "success";
      const report: FacebookSyncReport = {
        status,
        startedAt,
        finishedAt,
        durationMs: Date.now() - startedAtMs,
        rowsImported: freshStatus?.rowsImported ?? syncResult.metadata.rowsImported,
        campaignsImported: nextDiagnostics.summary.capsuled_unique_campaign_ids_count,
        matchedCampaigns: nextDiagnostics.summary.matched_campaign_ids_count,
        unmatchedCampaigns: unmatched,
        duplicates,
        totalSpend: nextDiagnostics.summary.total_spend,
        fbPurchases: nextDiagnostics.summary.total_fb_purchases,
        dateFrom: syncDateRange.dateFrom,
        dateTo: syncDateRange.dateTo,
        lastSyncAt: freshStatus?.lastSync ?? syncResult.metadata.lastSync,
        apiLevel: freshStatus?.level ?? "campaign",
        warnings,
        error: null,
      };

      setSyncState({ status, stage: null, report });
      toast({
        title: status === "success" ? "Facebook data synchronized" : "Facebook data synchronized with warnings",
        description: `${report.campaignsImported.toLocaleString("en-US")} campaigns imported, ${report.matchedCampaigns.toLocaleString("en-US")} matched.`,
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = error instanceof Error ? error.message : "Unknown synchronization error";
      const report: FacebookSyncReport = {
        ...baseReport,
        status: "failed",
        finishedAt,
        durationMs: Date.now() - startedAtMs,
        error: message,
      };
      setSyncState({ status: "failed", stage: null, report });
      toast({
        title: "Facebook synchronization failed",
        description: message,
        variant: "destructive",
      });
    }
  };

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

  const renderSpendCell = (row: FbAnalyticsRow): ReactNode => {
    const diagnostic = diagnosticsByCampaignId.get(row.campaign_id);
    if (row.spend != null && row.spend > 0) {
      return (
        <div>
          <div>{formatCurrency(row.spend)}</div>
          <DiagnosticDetail diagnostic={diagnostic} />
        </div>
      );
    }
    const label = diagnostic
      ? diagnostic.match_status === "matched"
        ? "Matched, no spend"
        : fbTrafficStatusLabel(diagnostic.match_status)
      : "Unknown";
    return (
      <div>
        <div className="font-medium text-muted-foreground">{label}</div>
        <DiagnosticDetail diagnostic={diagnostic} />
      </div>
    );
  };

  const columns: Array<{ key: FbAnalyticsTableSortKey; label: string; align?: "left" | "right"; render: (row: FbAnalyticsRow) => ReactNode }> = [
    { key: "campaign_id", label: "Campaign ID", render: (row) => row.campaign_id },
    { key: "campaign_name", label: "Campaign Name", render: (row) => row.campaign_name ?? "-" },
    { key: "ad_account_name", label: "Ad Account", render: (row) => row.ad_account_name ?? row.ad_account_id ?? "-" },
    { key: "spend", label: "Spend", align: "right", render: renderSpendCell },
    { key: "fb_purchases", label: "FB Purchases", align: "right", render: (row) => formatNumber(row.fb_purchases) },
    { key: "cpp", label: "CPP", align: "right", render: (row) => formatMaybeCurrency(row.cpp) },
    { key: "impressions", label: "Impressions", align: "right", render: (row) => formatNumber(row.impressions) },
    { key: "clicks", label: "Clicks", align: "right", render: (row) => formatNumber(row.clicks) },
    { key: "ctr", label: "CTR", align: "right", render: (row) => formatMaybePct(row.ctr) },
    { key: "cpc", label: "CPC", align: "right", render: (row) => formatMaybeCurrency(row.cpc) },
    { key: "cpm", label: "CPM", align: "right", render: (row) => formatMaybeCurrency(row.cpm) },
    { key: "outbound_ctr", label: "Outbound CTR", align: "right", render: (row) => formatMaybePct(row.outbound_ctr) },
    { key: "trial_users", label: "Trials", align: "right", render: (row) => formatNumber(row.trial_users) },
    { key: "first_subscription_users", label: "First Subs", align: "right", render: (row) => formatNumber(row.first_subscription_users) },
    { key: "trial_to_sub_cr", label: "Trial -> Sub CR", align: "right", render: (row) => formatPct(row.trial_to_sub_cr) },
    { key: "upsell_1_users", label: "Upsell 1", align: "right", render: (row) => formatNumber(row.upsell_1_users) },
    { key: "upsell_2_users", label: "Upsell 2", align: "right", render: (row) => formatNumber(row.upsell_2_users) },
    { key: "upsell_3_users", label: "Upsell 3", align: "right", render: (row) => formatNumber(row.upsell_3_users) },
    { key: "token_buyers", label: "Token Buyers", align: "right", render: (row) => formatNumber(row.token_buyers) },
    { key: "token_revenue", label: "Token Revenue", align: "right", render: (row) => formatCurrency(row.token_revenue) },
    { key: "refund_users", label: "Refund Users", align: "right", render: (row) => formatNumber(row.refund_users) },
    { key: "gross_revenue", label: "Gross Rev", align: "right", render: (row) => formatCurrency(row.gross_revenue) },
    { key: "net_revenue", label: "Net Rev", align: "right", render: (row) => formatCurrency(row.net_revenue) },
    { key: "cac", label: "CAC", align: "right", render: (row) => formatMaybeCurrency(row.cac) },
    { key: "cost_per_first_sub", label: "Cost / First Sub", align: "right", render: (row) => formatMaybeCurrency(row.cost_per_first_sub) },
    { key: "roas", label: "ROAS", align: "right", render: (row) => formatRoas(row.roas) },
    { key: "revenue_per_trial", label: "Revenue / Trial", align: "right", render: (row) => formatMaybeCurrency(row.revenue_per_trial) },
    { key: "revenue_per_purchase", label: "Revenue / Purchase", align: "right", render: (row) => formatMaybeCurrency(row.revenue_per_purchase) },
    { key: "profit", label: "Profit", align: "right", render: (row) => formatMaybeCurrency(row.profit) },
  ];

  const diagnosticRows = useMemo(() => {
    const query = diagnosticSearch.trim().toLowerCase();
    return trafficDiagnostics.campaigns.filter((campaign) => {
      if (diagnosticStatusFilter !== "all" && campaign.match_status !== diagnosticStatusFilter) return false;
      if (diagnosticHasSpendFilter === "yes" && !(campaign.spend != null && campaign.spend > 0)) return false;
      if (diagnosticHasSpendFilter === "no" && campaign.spend != null && campaign.spend > 0) return false;
      if (diagnosticHasMatchFilter === "yes" && campaign.match_status !== "matched") return false;
      if (diagnosticHasMatchFilter === "no" && campaign.match_status === "matched") return false;
      if (query && !`${campaign.campaign_id} ${campaign.campaign_name ?? ""} ${campaign.reason}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [trafficDiagnostics, diagnosticStatusFilter, diagnosticHasSpendFilter, diagnosticHasMatchFilter, diagnosticSearch]);

  return (
    <AppLayout title="FB-Analytics" description="Facebook traffic performance by Campaign ID">
      <section className="space-y-4">
        <Card className="p-4 shadow-card">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-6">
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Campaign Path</Label>
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
              <Label className="text-xs text-muted-foreground">Funnel</Label>
              <Select value={uiState.funnelFilter} onValueChange={(value) => updateUiState({ funnelFilter: value })}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="All funnels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All funnels</SelectItem>
                  {funnelOptions.map((funnel) => (
                    <SelectItem key={funnel} value={funnel}>{funnel}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Media Buyer</Label>
              <Select value={uiState.mediaBuyerFilter} onValueChange={(value) => updateUiState({ mediaBuyerFilter: value })}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="All buyers" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All buyers</SelectItem>
                  {MEDIA_BUYER_VALUES.map((buyer) => (
                    <SelectItem key={buyer} value={buyer}>{buyer}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Ad Account</Label>
              <Select value={uiState.adAccountFilter} onValueChange={(value) => updateUiState({ adAccountFilter: value })}>
                <SelectTrigger className="h-10">
                  <SelectValue placeholder="All accounts" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accounts</SelectItem>
                  {adAccountOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
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
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Campaign Name</Label>
              <Input
                className="h-10"
                placeholder="Search name"
                value={uiState.campaignNameSearch}
                onChange={(event) => updateUiState({ campaignNameSearch: event.target.value })}
              />
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
          <KpiCard label="FB Purchases" value={formatNumber(result.summary.fbPurchases)} icon={<CreditCard className="h-4 w-4" />} />
          <KpiCard label="Profit" value={formatMaybeCurrency(result.summary.profit)} icon={<DollarSign className="h-4 w-4" />} accent="success" />
        </div>

        <Card className="p-4 shadow-card">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SectionHeader title="FB Data Diagnostics" description="Campaign matching between Subengine warehouse and Capsuled Facebook data" />
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" onClick={runFacebookSync} disabled={syncState.status === "syncing"}>
                <RotateCcw className={cn("h-4 w-4", syncState.status === "syncing" && "animate-spin")} />
                {syncState.status === "syncing" ? "Syncing Facebook data..." : "Sync Facebook Data"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => downloadTextFile("missing-campaign-ids.csv", exportMissingCampaignIdsCsv(trafficDiagnostics))}
                disabled={trafficDiagnostics.summary.unmatched_warehouse_campaign_ids_count === 0}
              >
                <Download className="h-4 w-4" />
                Export Missing Campaign IDs
              </Button>
            </div>
          </div>

          <div className="mt-4 space-y-2">
            {!trafficDiagnostics.summary.latest_sync_at ? (
              <div className="rounded-md border border-dashed border-border bg-muted/30 p-4">
                <div className="text-sm font-semibold text-foreground">No Facebook data available.</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Click "Sync Facebook Data" to import the latest campaign statistics from Capsuled.
                </p>
                <Button type="button" className="mt-3" onClick={runFacebookSync} disabled={syncState.status === "syncing"}>
                  <RotateCcw className={cn("h-4 w-4", syncState.status === "syncing" && "animate-spin")} />
                  {syncState.status === "syncing" ? "Syncing Facebook data..." : "Sync Facebook Data"}
                </Button>
              </div>
            ) : null}
            {trafficDiagnostics.summary.latest_sync_at && trafficDiagnostics.summary.api_level !== "campaign" && (
              <div className={warningMessageClass()}>
                <AlertTriangle className="mr-2 inline h-4 w-4" />
                FB Analytics requires campaign-level data. Current sync level: {trafficDiagnostics.summary.api_level}.
              </div>
            )}
            {trafficDiagnostics.summary.latest_sync_at && trafficDiagnostics.summary.matched_campaign_ids_count === 0 && (
              <div className={warningMessageClass()}>
                <AlertTriangle className="mr-2 inline h-4 w-4" />
                No campaign IDs matched between Subengine and Capsuled. Check date range, level, and campaign_id format.
              </div>
            )}
            {trafficDiagnostics.summary.selected_range_outside_synced_range && (
              <div className={warningMessageClass()}>
                <AlertTriangle className="mr-2 inline h-4 w-4" />
                Selected date range is outside the synced Capsuled range.
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div><div className="text-xs text-muted-foreground">Capsuled Sync Status</div><div className="mt-1 text-sm font-semibold">{capsuledStatus?.status ?? "unknown"}</div></div>
            <div><div className="text-xs text-muted-foreground">Last Sync</div><div className="mt-1 text-sm font-semibold">{formatDateTime(trafficDiagnostics.summary.latest_sync_at)}</div></div>
            <div><div className="text-xs text-muted-foreground">Duration</div><div className="mt-1 text-sm font-semibold">{formatDuration(capsuledStatus?.syncDurationMs)}</div></div>
            <div><div className="text-xs text-muted-foreground">Rows Imported</div><div className="mt-1 text-sm font-semibold">{formatNumber(capsuledStatus?.rowsImported ?? 0)}</div></div>
            <div><div className="text-xs text-muted-foreground">API Level</div><div className="mt-1 text-sm font-semibold">{trafficDiagnostics.summary.api_level}</div></div>
            <div><div className="text-xs text-muted-foreground">API Date Range</div><div className="mt-1 text-sm font-semibold">{capsuledStatus?.dateFrom ?? "-"} to {capsuledStatus?.dateTo ?? "-"}</div></div>
            <div><div className="text-xs text-muted-foreground">Campaign IDs in Warehouse</div><div className="mt-1 text-sm font-semibold">{formatNumber(trafficDiagnostics.summary.warehouse_campaign_ids_count)}</div></div>
            <div><div className="text-xs text-muted-foreground">Campaigns Imported</div><div className="mt-1 text-sm font-semibold">{formatNumber(trafficDiagnostics.summary.capsuled_unique_campaign_ids_count)}</div></div>
            <div><div className="text-xs text-muted-foreground">Matched Campaigns</div><div className="mt-1 text-sm font-semibold">{formatNumber(trafficDiagnostics.summary.matched_campaign_ids_count)}</div></div>
            <div><div className="text-xs text-muted-foreground">Unmatched Campaigns</div><div className="mt-1 text-sm font-semibold">{formatNumber(trafficDiagnostics.summary.unmatched_warehouse_campaign_ids_count)}</div></div>
            <div><div className="text-xs text-muted-foreground">Duplicates</div><div className="mt-1 text-sm font-semibold">{formatNumber(trafficDiagnostics.summary.duplicate_capsuled_campaign_ids_count)}</div></div>
            <div><div className="text-xs text-muted-foreground">Total Spend</div><div className="mt-1 text-sm font-semibold">{formatCurrency(trafficDiagnostics.summary.total_spend)}</div></div>
            <div><div className="text-xs text-muted-foreground">FB Purchases</div><div className="mt-1 text-sm font-semibold">{formatNumber(trafficDiagnostics.summary.total_fb_purchases)}</div></div>
          </div>
        </Card>

        {syncState.status === "syncing" && (
          <Card className="p-4 shadow-card">
            <SectionHeader title="Sync Progress" description={`${syncDateRange.dateFrom} to ${syncDateRange.dateTo}`} />
            <div className="mt-4 grid gap-3 md:grid-cols-4">
              {SYNC_STAGES.map((stage, index) => {
                const activeIndex = SYNC_STAGES.findIndex((entry) => entry.id === syncState.stage);
                const completed = activeIndex > index;
                const active = syncState.stage === stage.id;
                return (
                  <div key={stage.id} className="rounded-md border border-border p-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {completed ? (
                        <Check className="h-4 w-4 text-success" />
                      ) : active ? (
                        <RotateCcw className="h-4 w-4 animate-spin text-primary" />
                      ) : (
                        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
                      )}
                      {stage.label}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {syncState.report && syncState.status !== "syncing" && (
          <Card
            className={cn(
              "p-4 shadow-card",
              syncState.status === "failed" && "border-destructive/40 bg-destructive/5",
              syncState.status === "partial" && "border-amber-500/40 bg-amber-500/10",
              syncState.status === "success" && "border-success/40 bg-success/10",
            )}
          >
            {syncState.status === "failed" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
                  <AlertTriangle className="h-4 w-4" />
                  Synchronization failed
                </div>
                <div className="text-sm">
                  Reason: <span className="font-medium">{syncState.report.error ?? "Unknown error"}</span>
                </div>
                <Button type="button" variant="outline" size="sm" onClick={runFacebookSync}>
                  <RotateCcw className="h-4 w-4" />
                  Retry
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className={cn("flex items-center gap-2 text-sm font-semibold", syncState.status === "partial" ? "text-amber-700" : "text-success")}>
                  {syncState.status === "partial" ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
                  {syncState.status === "partial" ? "Synchronization completed with warnings." : "Facebook data synchronized successfully"}
                </div>
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  <div><span className="text-xs text-muted-foreground">Imported</span><div className="font-semibold">{formatNumber(syncState.report.campaignsImported)} campaigns</div></div>
                  <div><span className="text-xs text-muted-foreground">Matched</span><div className="font-semibold">{formatNumber(syncState.report.matchedCampaigns)} Campaign IDs</div></div>
                  <div><span className="text-xs text-muted-foreground">Unmatched</span><div className="font-semibold">{formatNumber(syncState.report.unmatchedCampaigns)} Campaign IDs</div></div>
                  <div><span className="text-xs text-muted-foreground">Rows Imported</span><div className="font-semibold">{formatNumber(syncState.report.rowsImported)}</div></div>
                  <div><span className="text-xs text-muted-foreground">Spend</span><div className="font-semibold">{formatCurrency(syncState.report.totalSpend)}</div></div>
                  <div><span className="text-xs text-muted-foreground">FB Purchases</span><div className="font-semibold">{formatNumber(syncState.report.fbPurchases)}</div></div>
                  <div><span className="text-xs text-muted-foreground">Date Range</span><div className="font-semibold">{syncState.report.dateFrom} to {syncState.report.dateTo}</div></div>
                  <div><span className="text-xs text-muted-foreground">Duration</span><div className="font-semibold">{formatDuration(syncState.report.durationMs)}</div></div>
                  <div><span className="text-xs text-muted-foreground">Last Sync</span><div className="font-semibold">{formatDateTime(syncState.report.lastSyncAt)}</div></div>
                </div>
                {syncState.status === "partial" && (
                  <Button type="button" variant="outline" size="sm" onClick={() => setActiveTab("diagnostics")}>
                    View Diagnostics
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}

        {(syncState.report || capsuledStatus?.lastSync) && (
          <Card className="p-4 shadow-card">
            <details>
              <summary className="cursor-pointer text-sm font-semibold text-foreground">Latest Sync Details</summary>
              <div className="mt-4 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                <div><span className="text-xs text-muted-foreground">Start Time</span><div>{formatDateTime(syncState.report?.startedAt ?? capsuledStatus?.startedAt ?? null)}</div></div>
                <div><span className="text-xs text-muted-foreground">Finish Time</span><div>{formatDateTime(syncState.report?.finishedAt ?? capsuledStatus?.lastSync ?? null)}</div></div>
                <div><span className="text-xs text-muted-foreground">Duration</span><div>{formatDuration(syncState.report?.durationMs ?? capsuledStatus?.syncDurationMs)}</div></div>
                <div><span className="text-xs text-muted-foreground">Rows Imported</span><div>{formatNumber(syncState.report?.rowsImported ?? capsuledStatus?.rowsImported ?? 0)}</div></div>
                <div><span className="text-xs text-muted-foreground">Campaign IDs Found</span><div>{formatNumber(syncState.report?.campaignsImported ?? trafficDiagnostics.summary.capsuled_unique_campaign_ids_count)}</div></div>
                <div><span className="text-xs text-muted-foreground">Campaign IDs Matched</span><div>{formatNumber(syncState.report?.matchedCampaigns ?? trafficDiagnostics.summary.matched_campaign_ids_count)}</div></div>
                <div><span className="text-xs text-muted-foreground">Missing IDs</span><div>{formatNumber(syncState.report?.unmatchedCampaigns ?? trafficDiagnostics.summary.unmatched_warehouse_campaign_ids_count)}</div></div>
                <div><span className="text-xs text-muted-foreground">API Level</span><div>{syncState.report?.apiLevel ?? capsuledStatus?.level ?? trafficDiagnostics.summary.api_level}</div></div>
                <div><span className="text-xs text-muted-foreground">Date Range</span><div>{syncState.report?.dateFrom ?? capsuledStatus?.dateFrom ?? "-"} to {syncState.report?.dateTo ?? capsuledStatus?.dateTo ?? "-"}</div></div>
                <div className="md:col-span-2 xl:col-span-4">
                  <span className="text-xs text-muted-foreground">Warnings</span>
                  <div>{syncState.report?.warnings.length ? syncState.report.warnings.join(" ") : "-"}</div>
                </div>
                <div className="md:col-span-2 xl:col-span-4">
                  <span className="text-xs text-muted-foreground">Errors</span>
                  <div>{syncState.report?.error ?? capsuledStatus?.failedRequests.join(" ") ?? "-"}</div>
                </div>
              </div>
            </details>
          </Card>
        )}

        <Tabs defaultValue="warehouse" className="space-y-4">
          <TabsList>
            <TabsTrigger value="warehouse">FB Performance (ClickHouse)</TabsTrigger>
            <TabsTrigger value="performance">Blended (legacy)</TabsTrigger>
            <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
          </TabsList>

          {/* Server-driven FB warehouse analytics — no browser calculations. */}
          <TabsContent value="warehouse" className="space-y-4">
            <FbWarehouseHealth />
            <FbWarehouseAnalytics />
          </TabsContent>

          <TabsContent value="performance" className="space-y-4">
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
          </TabsContent>

          <TabsContent value="diagnostics" className="space-y-4">
            <Card className="p-4 shadow-card">
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(180px,1fr)_repeat(3,minmax(160px,0.7fr))]">
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Campaign ID search</Label>
                  <Input value={diagnosticSearch} onChange={(event) => setDiagnosticSearch(event.target.value)} placeholder="Search ID, name, reason" />
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Status</Label>
                  <Select value={diagnosticStatusFilter} onValueChange={(value) => setDiagnosticStatusFilter(value as FbTrafficMatchStatus | "all")}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All statuses</SelectItem>
                      {DIAGNOSTIC_STATUS_VALUES.map((status) => (
                        <SelectItem key={status} value={status}>{fbTrafficStatusLabel(status)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Has Spend</Label>
                  <Select value={diagnosticHasSpendFilter} onValueChange={setDiagnosticHasSpendFilter}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="yes">Has spend</SelectItem>
                      <SelectItem value="no">No spend</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">Has Match</Label>
                  <Select value={diagnosticHasMatchFilter} onValueChange={setDiagnosticHasMatchFilter}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All</SelectItem>
                      <SelectItem value="yes">Matched</SelectItem>
                      <SelectItem value="no">Not matched</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </Card>

            <Card className="shadow-card">
              <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                <SectionHeader title="Campaign Match Diagnostics" description={`${formatNumber(diagnosticRows.length)} diagnostic rows`} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => downloadTextFile("missing-campaign-ids.csv", exportMissingCampaignIdsCsv(trafficDiagnostics))}
                  disabled={trafficDiagnostics.summary.unmatched_warehouse_campaign_ids_count === 0}
                >
                  <Download className="h-4 w-4" />
                  Export Missing Campaign IDs
                </Button>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Campaign ID</TableHead>
                      <TableHead>Warehouse</TableHead>
                      <TableHead>Capsuled</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead>Campaign Name</TableHead>
                      <TableHead>Ad Account</TableHead>
                      <TableHead className="text-right">Spend</TableHead>
                      <TableHead className="text-right">FB Purchases</TableHead>
                      <TableHead>Last Sync</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {diagnosticRows.length ? diagnosticRows.map((row) => (
                      <TableRow key={`${row.match_status}-${row.campaign_id}`}>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{row.campaign_id}</TableCell>
                        <TableCell>{row.warehouse_present ? "present" : "not present"}</TableCell>
                        <TableCell>{row.capsuled_present ? "present" : "not present"}</TableCell>
                        <TableCell className="whitespace-nowrap">{fbTrafficStatusLabel(row.match_status)}</TableCell>
                        <TableCell className="min-w-[280px] text-sm text-muted-foreground">{row.reason}</TableCell>
                        <TableCell className="max-w-[240px] truncate">{row.campaign_name ?? "-"}</TableCell>
                        <TableCell className="max-w-[220px] truncate">{row.ad_account ?? "-"}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.spend == null ? "-" : formatCurrency(row.spend)}</TableCell>
                        <TableCell className="text-right tabular-nums">{row.fb_purchases == null ? "-" : formatNumber(row.fb_purchases)}</TableCell>
                        <TableCell className="whitespace-nowrap">{formatDateTime(row.last_sync_at)}</TableCell>
                      </TableRow>
                    )) : (
                      <TableRow>
                        <TableCell colSpan={10} className="h-32 text-center text-sm text-muted-foreground">
                          No diagnostics for current filters
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </Card>
          </TabsContent>
        </Tabs>
      </section>
    </AppLayout>
  );
}
