import { useDeferredValue, useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Info, RotateCcw, TrendingUp } from "lucide-react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { useTransactions } from "@/services/sheets";
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { computeCohorts, formatCurrency, DEFAULT_MAX_RENEWAL_DEPTH } from "@/services/analytics";
import { aggregateTrafficMetrics } from "@/services/cohortReporting";
import { filterCohortsWithDiagnostics, filterTransactionsByTrialAttribution, campaignIdForTransaction } from "@/services/cohortFiltering";
import { countryUserCountsForTransactions } from "@/services/userCountry";
import { CARD_TYPE_VALUES, cardTypeLabel } from "@/services/userCardType";
import { MEDIA_BUYER_VALUES } from "@/services/userMediaBuyer";
import {
  buildCohortPaybackRows,
  buildPaybackCurve,
  buildSelectedCohortDataset,
  calculateActualRevenueByDay,
  calculatePaybackSummary,
  calculateScenario,
  deriveAssumptionsFromCohorts,
  projectMonthlyNetRevenue,
  resolveSpendAndCac,
  type CohortPaybackRow,
  type ForecastAssumptions,
  type ForecastComputationInput,
  type PaybackStatus,
} from "@/services/paybackForecast";
import type { CardType, MediaBuyer } from "@/services/types";

const PROCESSING_FEE_DEFAULT_PCT = 3; // %
const FIXED_FEE_DEFAULT = 0.3; // $ per charge
const COHORT_PAGE_SIZE = 25;

type SortKey = "trialUsers" | "spend" | "cac" | "roas1M" | "paybackDay" | "profitPerUser";
type SortDir = "asc" | "desc";

const DEFAULT_FORECAST_UI_STATE = {
  funnelFilter: "all",
  campaignPathFilter: "all",
  countryFilter: "all",
  cardTypeFilter: "all",
  mediaBuyerFilter: "all",
  campaignIdFilter: "all",
  dateFrom: "",
  dateTo: "",
  selectedCohortIds: [] as string[],
  // Cost overrides ("" = use auto). Rate fields are entered as percentages.
  trialPrice: "",
  subscriptionPrice: "",
  upsellValue: "",
  upsellRate: "",
  firstRenewalRate: "",
  monthlyRetention: "",
  refundRate: "",
  processingFeePct: String(PROCESSING_FEE_DEFAULT_PCT),
  fixedFee: String(FIXED_FEE_DEFAULT),
  manualSpend: "",
  manualCac: "",
  marginTarget: "",
  // Scenario overrides ("" = use base).
  scCac: "",
  scTrialPrice: "",
  scSubscriptionPrice: "",
  scFirstRenewalRate: "",
  scMonthlyRetention: "",
  scUpsellRate: "",
  scUpsellValue: "",
  scRefundRate: "",
  sortKey: "trialUsers" as SortKey,
  sortDir: "desc" as SortDir,
  page: 1,
};

type UiState = typeof DEFAULT_FORECAST_UI_STATE;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const parseNum = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

const fmtRoas = (roas: number | null | undefined) => (roas == null ? "—" : `${roas.toFixed(2)}x`);
const fmtDay = (day: number | null | undefined) => (day == null ? "Never" : `Day ${day}`);
const fmtMoney = (n: number | null | undefined) => (n == null ? "—" : formatCurrency(n));
const fmtInt = (n: number) => Math.round(n).toLocaleString();

const STATUS_META: Record<PaybackStatus, { label: string; cls: string }> = {
  scale: { label: "Scale", cls: "bg-success/15 text-success" },
  watch: { label: "Watch", cls: "bg-warning/15 text-warning" },
  stop: { label: "Stop", cls: "bg-destructive/15 text-destructive" },
  unknown: { label: "Unknown", cls: "bg-muted text-muted-foreground" },
};

function StatusBadge({ status }: { status: PaybackStatus }) {
  const meta = STATUS_META[status];
  return <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium", meta.cls)}>{meta.label}</span>;
}

function Hint({ text }: { text: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-1 inline-flex cursor-help align-middle text-muted-foreground">
          <Info className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[240px] text-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

/** Cost input with an auto value, manual override, and reset-to-auto. */
function CostInput({
  label,
  autoValue,
  value,
  onChange,
  suffix,
  hint,
}: {
  label: string;
  autoValue: string;
  value: string;
  onChange: (next: string) => void;
  suffix?: string;
  hint?: string;
}) {
  const overridden = value.trim() !== "";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground">
          {label}
          {suffix ? ` (${suffix})` : ""}
          {hint && <Hint text={hint} />}
        </Label>
        {overridden && (
          <button type="button" className="text-[10px] text-primary hover:underline" onClick={() => onChange("")}>
            reset
          </button>
        )}
      </div>
      <Input className="h-8" value={value} placeholder={autoValue} onChange={(event) => onChange(event.target.value)} />
      <p className="text-[10px] text-muted-foreground">
        Auto: <span className="font-medium">{autoValue}</span> · {overridden ? "manual override" : "using auto"}
      </p>
    </div>
  );
}

export default function ForecastingPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((state) => state.subscriptions);
  const trafficMetrics = useDataStore((state) => state.trafficMetrics);
  const [ui, setUi, resetUi] = usePersistedPageState<UiState>("ui_state_forecasting_v2", DEFAULT_FORECAST_UI_STATE);
  const update = (patch: Partial<UiState>) => setUi((current) => ({ ...current, ...patch }));

  const deferredUi = useDeferredValue(ui);

  const selectedCountries = useMemo(
    () => (deferredUi.countryFilter === "all" ? [] : [deferredUi.countryFilter]),
    [deferredUi.countryFilter],
  );
  const selectedCardTypes = useMemo(
    () => (deferredUi.cardTypeFilter === "all" ? [] : [deferredUi.cardTypeFilter as CardType]),
    [deferredUi.cardTypeFilter],
  );
  const selectedMediaBuyers = useMemo(
    () => (deferredUi.mediaBuyerFilter === "all" ? [] : [deferredUi.mediaBuyerFilter as MediaBuyer]),
    [deferredUi.mediaBuyerFilter],
  );

  // Filter option lists (cheap: derived directly from transactions).
  const geoOptions = useMemo(() => countryUserCountsForTransactions(txs), [txs]);
  const campaignIdOptions = useMemo(() => {
    const set = new Set<string>();
    for (const t of txs) if (t.transaction_type === "trial") set.add(campaignIdForTransaction(t));
    return Array.from(set).filter(Boolean).sort();
  }, [txs]);

  // Campaign-id attribution then the single heavy cohort computation (memoized).
  const sourceFilteredTxs = useMemo(
    () =>
      deferredUi.campaignIdFilter === "all"
        ? txs
        : filterTransactionsByTrialAttribution(txs, { selectedCampaignIds: [deferredUi.campaignIdFilter] }),
    [txs, deferredUi.campaignIdFilter],
  );

  const allCohorts = useMemo(
    () =>
      computeCohorts(sourceFilteredTxs, subscriptions, {
        maxRenewalDepth: DEFAULT_MAX_RENEWAL_DEPTH,
        selectedCountries,
        selectedCardTypes,
        selectedMediaBuyers,
      }),
    [sourceFilteredTxs, subscriptions, selectedCountries, selectedCardTypes, selectedMediaBuyers],
  );

  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.funnel))).sort(), [allCohorts]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((c) => c.campaign_path))).sort(), [allCohorts]);

  const filteredCohorts = useMemo(
    () =>
      filterCohortsWithDiagnostics(allCohorts, {
        funnelFilter: deferredUi.funnelFilter,
        campaignPathFilter: deferredUi.campaignPathFilter,
        cohortDateFrom: deferredUi.dateFrom || undefined,
        cohortDateTo: deferredUi.dateTo || undefined,
      }).cohorts,
    [allCohorts, deferredUi.funnelFilter, deferredUi.campaignPathFilter, deferredUi.dateFrom, deferredUi.dateTo],
  );

  const selectedIds = useMemo(() => new Set(deferredUi.selectedCohortIds), [deferredUi.selectedCohortIds]);
  const selectedCohorts = useMemo(() => {
    const explicit = filteredCohorts.filter((c) => selectedIds.has(c.cohort_id));
    return explicit.length ? explicit : filteredCohorts;
  }, [filteredCohorts, selectedIds]);

  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);
  const dataset = useMemo(() => buildSelectedCohortDataset(selectedCohorts, trafficByKey), [selectedCohorts, trafficByKey]);
  const autoAssumptions = useMemo(() => deriveAssumptionsFromCohorts(selectedCohorts), [selectedCohorts]);

  // Merge auto values with manual overrides. Rate inputs are percentages -> fractions.
  const effectiveAssumptions: ForecastAssumptions = useMemo(() => {
    const pctOr = (raw: string, autoFraction: number) => {
      const n = parseNum(raw);
      return n == null ? autoFraction : n / 100;
    };
    const dollarsOr = (raw: string, auto: number) => parseNum(raw) ?? auto;
    const margin = parseNum(deferredUi.marginTarget);
    return {
      trialPrice: dollarsOr(deferredUi.trialPrice, autoAssumptions.trialPrice),
      subscriptionPrice: dollarsOr(deferredUi.subscriptionPrice, autoAssumptions.subscriptionPrice),
      upsellValue: dollarsOr(deferredUi.upsellValue, autoAssumptions.upsellValue),
      upsellRate: pctOr(deferredUi.upsellRate, autoAssumptions.upsellRate),
      firstRenewalRate: pctOr(deferredUi.firstRenewalRate, autoAssumptions.firstRenewalRate),
      monthlyRetention: pctOr(deferredUi.monthlyRetention, autoAssumptions.monthlyRetention),
      refundRate: pctOr(deferredUi.refundRate, autoAssumptions.refundRate),
      processingFeePct: (parseNum(deferredUi.processingFeePct) ?? PROCESSING_FEE_DEFAULT_PCT) / 100,
      fixedProcessingFee: parseNum(deferredUi.fixedFee) ?? FIXED_FEE_DEFAULT,
      cac: null,
      marginTarget: margin != null ? margin / 100 : undefined,
    };
  }, [autoAssumptions, deferredUi]);

  const spendResolution = useMemo(
    () =>
      resolveSpendAndCac({
        trialUsers: dataset.trialUsers,
        facebookSpend: dataset.facebookSpend,
        manualSpend: parseNum(deferredUi.manualSpend),
        manualCac: parseNum(deferredUi.manualCac),
      }),
    [dataset.trialUsers, dataset.facebookSpend, deferredUi.manualSpend, deferredUi.manualCac],
  );

  const actual = useMemo(
    () => calculateActualRevenueByDay(sourceFilteredTxs, dataset.cohortIds),
    [sourceFilteredTxs, dataset.cohortIds],
  );

  const baseInput: ForecastComputationInput = useMemo(
    () => ({
      actual,
      trialUsers: dataset.trialUsers,
      spend: spendResolution.spend,
      spendAvailable: spendResolution.spendAvailable,
      cac: spendResolution.cac,
      grossRevenue: dataset.grossRevenue,
      netRevenue: dataset.netRevenue,
      assumptions: { ...effectiveAssumptions, cac: spendResolution.cac },
    }),
    [actual, dataset, spendResolution, effectiveAssumptions],
  );

  const summary = useMemo(() => calculatePaybackSummary(baseInput), [baseInput]);
  const projection = useMemo(
    () => projectMonthlyNetRevenue(dataset.trialUsers, baseInput.assumptions, 12),
    [dataset.trialUsers, baseInput.assumptions],
  );
  const curve = useMemo(() => buildPaybackCurve(actual, projection), [actual, projection]);

  // Scenario: base assumptions with scenario overrides layered on top.
  const scenarioResult = useMemo(() => {
    const pctOr = (raw: string, base: number) => {
      const n = parseNum(raw);
      return n == null ? base : n / 100;
    };
    const scenarioAssumptions: ForecastAssumptions = {
      ...effectiveAssumptions,
      trialPrice: parseNum(deferredUi.scTrialPrice) ?? effectiveAssumptions.trialPrice,
      subscriptionPrice: parseNum(deferredUi.scSubscriptionPrice) ?? effectiveAssumptions.subscriptionPrice,
      firstRenewalRate: pctOr(deferredUi.scFirstRenewalRate, effectiveAssumptions.firstRenewalRate),
      monthlyRetention: pctOr(deferredUi.scMonthlyRetention, effectiveAssumptions.monthlyRetention),
      upsellRate: pctOr(deferredUi.scUpsellRate, effectiveAssumptions.upsellRate),
      upsellValue: parseNum(deferredUi.scUpsellValue) ?? effectiveAssumptions.upsellValue,
      refundRate: pctOr(deferredUi.scRefundRate, effectiveAssumptions.refundRate),
    };
    const scCac = parseNum(deferredUi.scCac);
    const scenarioSpend = resolveSpendAndCac({
      trialUsers: dataset.trialUsers,
      facebookSpend: dataset.facebookSpend,
      manualSpend: parseNum(deferredUi.manualSpend),
      manualCac: scCac ?? parseNum(deferredUi.manualCac),
    });
    const scenarioInput: ForecastComputationInput = {
      ...baseInput,
      spend: scenarioSpend.spend,
      spendAvailable: scenarioSpend.spendAvailable,
      cac: scenarioSpend.cac,
      assumptions: { ...scenarioAssumptions, cac: scenarioSpend.cac },
    };
    return calculateScenario(baseInput, scenarioInput);
  }, [baseInput, dataset, effectiveAssumptions, deferredUi]);

  // Per-cohort rows (heavy; batched internally). Manual CAC applies per cohort when set.
  const cohortRows = useMemo(
    () => buildCohortPaybackRows(filteredCohorts, sourceFilteredTxs, trafficByKey, { ...effectiveAssumptions, cac: parseNum(deferredUi.manualCac) }),
    [filteredCohorts, sourceFilteredTxs, trafficByKey, effectiveAssumptions, deferredUi.manualCac],
  );

  const sortedRows = useMemo(() => {
    const rows = [...cohortRows];
    const dir = deferredUi.sortDir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const av = (a[deferredUi.sortKey] ?? -Infinity) as number;
      const bv = (b[deferredUi.sortKey] ?? -Infinity) as number;
      return av < bv ? -dir : av > bv ? dir : 0;
    });
    return rows;
  }, [cohortRows, deferredUi.sortKey, deferredUi.sortDir]);

  const totalPages = Math.max(1, Math.ceil(sortedRows.length / COHORT_PAGE_SIZE));
  const safePage = Math.min(ui.page, totalPages);
  const pagedRows = sortedRows.slice((safePage - 1) * COHORT_PAGE_SIZE, safePage * COHORT_PAGE_SIZE);

  const isStale = deferredUi !== ui;
  const noData = allCohorts.length === 0;
  const noSelection = selectedCohorts.length === 0;

  const toggleSort = (key: SortKey) => {
    if (ui.sortKey === key) update({ sortDir: ui.sortDir === "asc" ? "desc" : "asc" });
    else update({ sortKey: key, sortDir: "desc", page: 1 });
  };
  const sortIcon = (key: SortKey): ReactNode =>
    ui.sortKey !== key ? <ArrowUpDown className="inline h-3 w-3 opacity-40" /> : ui.sortDir === "asc" ? <ArrowUp className="inline h-3 w-3" /> : <ArrowDown className="inline h-3 w-3" />;

  const toggleCohort = (id: string) => {
    const next = new Set(ui.selectedCohortIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update({ selectedCohortIds: Array.from(next), page: 1 });
  };

  const chartConfig = { cumulativeNet: { label: "Cumulative Net Revenue", color: "hsl(var(--chart-1))" } } satisfies ChartConfig;
  const overallStatus = summary.paybackDay != null ? "Paid Back" : "Not Paid Back Yet";

  return (
    <AppLayout
      title="Traffic Payback Forecast"
      description="Select cohorts and costs to see which traffic pays back, when, and how much CAC you can afford."
    >
      <TooltipProvider delayDuration={100}>
        <div className={cn("space-y-4", isStale && "opacity-70 transition-opacity")}>
          {/* -------- Section 1: Filters / cohort selection -------- */}
          <Card className="p-4 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Cohort Selection</h3>
              <Button variant="ghost" size="sm" onClick={resetUi}>
                <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset all
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <FilterSelect label="Funnel" value={ui.funnelFilter} onChange={(v) => update({ funnelFilter: v, page: 1 })} options={funnelOptions} allLabel="All funnels" />
              <FilterSelect label="Campaign Path" value={ui.campaignPathFilter} onChange={(v) => update({ campaignPathFilter: v, page: 1 })} options={campaignPathOptions} allLabel="All paths" />
              <FilterSelect label="Campaign ID" value={ui.campaignIdFilter} onChange={(v) => update({ campaignIdFilter: v, page: 1 })} options={campaignIdOptions} allLabel="All campaign IDs" />
              <FilterSelect label="Media Buyer" value={ui.mediaBuyerFilter} onChange={(v) => update({ mediaBuyerFilter: v, page: 1 })} options={MEDIA_BUYER_VALUES} allLabel="All buyers" />
              <FilterSelect label="GEO / Country" value={ui.countryFilter} onChange={(v) => update({ countryFilter: v, page: 1 })} options={geoOptions.map((g) => g.country_code)} allLabel="All countries" />
              <FilterSelect label="Card Type" value={ui.cardTypeFilter} onChange={(v) => update({ cardTypeFilter: v, page: 1 })} options={CARD_TYPE_VALUES} allLabel="All cards" format={(v) => cardTypeLabel(v as CardType)} />
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Cohort date from</Label>
                <Input type="date" className="h-8" value={ui.dateFrom} onChange={(e) => update({ dateFrom: e.target.value, page: 1 })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Cohort date to</Label>
                <Input type="date" className="h-8" value={ui.dateTo} onChange={(e) => update({ dateTo: e.target.value, page: 1 })} />
              </div>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Button variant="outline" size="sm" onClick={() => update({ selectedCohortIds: filteredCohorts.map((c) => c.cohort_id) })}>Select all filtered</Button>
              <Button variant="outline" size="sm" onClick={() => update({ selectedCohortIds: [] })}>Use all filtered</Button>
              <span className="text-muted-foreground">
                {fmtInt(selectedCohorts.length)} cohorts · {fmtInt(dataset.trialUsers)} trial users · Spend {spendResolution.spendAvailable ? fmtMoney(spendResolution.spend) : "unavailable"} · CAC {fmtMoney(spendResolution.cac)}
              </span>
            </div>

            {filteredCohorts.length > 0 && (
              <div className="mt-3 max-h-40 overflow-y-auto rounded-md border border-border p-2">
                <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredCohorts.slice(0, 300).map((cohort) => (
                    <label key={cohort.cohort_id} className="flex items-center gap-2 text-xs">
                      <input type="checkbox" checked={selectedIds.has(cohort.cohort_id)} onChange={() => toggleCohort(cohort.cohort_id)} />
                      <span className="truncate" title={cohort.cohort_id}>
                        {cohort.cohort_date} · {cohort.funnel} · {cohort.campaign_path} ({fmtInt(cohort.trial_users)})
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {noData ? (
            <Card className="p-10 text-center text-sm text-muted-foreground shadow-card">
              No cohorts available. Import transactions on the Import page to build a forecast.
            </Card>
          ) : (
            <>
              {/* -------- Section 3: Payback summary -------- */}
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", summary.paybackDay != null ? "bg-success/15 text-success" : "bg-warning/15 text-warning")}>
                  {overallStatus}
                </span>
                {!spendResolution.spendAvailable && (
                  <span className="text-xs text-warning">Spend unavailable — enter a manual Spend or CAC below for ROAS / payback.</span>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
                <KpiCard label="Trial Users" value={fmtInt(summary.trialUsers)} icon={<TrendingUp className="h-4 w-4" />} />
                <KpiCard label="Spend" value={summary.spendAvailable ? fmtMoney(summary.spend) : "—"} />
                <KpiCard label="CAC" value={fmtMoney(summary.cac)} />
                <KpiCard label="Gross Revenue" value={fmtMoney(summary.grossRevenue)} />
                <KpiCard label="Net Revenue" value={fmtMoney(summary.netRevenue)} accent="success" hint="Realized (actual) net revenue to date." />
                <KpiCard label="Profit / Loss" value={fmtMoney(summary.profit)} accent={summary.profit != null && summary.profit >= 0 ? "success" : "warning"} />
                <KpiCard label="Current ROAS" value={fmtRoas(summary.currentRoas)} hint="Actual net revenue / spend." />
                <KpiCard label="D7 ROAS" value={fmtRoas(summary.roasD7)} />
                <KpiCard label="1M ROAS" value={fmtRoas(summary.roas1M)} hint="Projected net revenue by day 30 / spend." />
                <KpiCard label="2M ROAS" value={fmtRoas(summary.roas2M)} />
                <KpiCard label="3M ROAS" value={fmtRoas(summary.roas3M)} />
                <KpiCard label="6M ROAS" value={fmtRoas(summary.roas6M)} />
                <KpiCard label="Payback Day" value={fmtDay(summary.paybackDay)} hint="First day cumulative net revenue ≥ spend." />
                <KpiCard label="Break-even CAC" value={fmtMoney(summary.breakEvenCac)} hint="Projected LTV at the 1M horizon." />
                <KpiCard label="Max Profitable CAC" value={fmtMoney(summary.maxProfitableCac)} hint="Break-even CAC minus your margin target." />
                <KpiCard label="Projected LTV" value={fmtMoney(summary.projectedLtv)} hint="Blended actual + projected net revenue per trial user at 1M." />
                <KpiCard label="Profit / User" value={fmtMoney(summary.profitPerUser)} accent={summary.profitPerUser != null && summary.profitPerUser >= 0 ? "success" : "warning"} />
              </div>

              {/* -------- Section 5: Payback curve -------- */}
              <Card className="p-4 shadow-card">
                <h3 className="mb-3 text-sm font-semibold">
                  Payback Curve — Cumulative Net Revenue vs Spend
                  <Hint text="Realized actuals up to cohort maturity, then projected months continue. The dashed red line is spend; the crossing point is payback." />
                </h3>
                {noSelection ? (
                  <p className="py-10 text-center text-sm text-muted-foreground">No cohorts selected.</p>
                ) : (
                  <ChartContainer config={chartConfig} className="h-[320px] w-full">
                    <ComposedChart data={curve} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="day" type="number" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v) => `D${v}`} />
                      <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(v) => `$${Math.round(Number(v) / 1000)}k`} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Line type="monotone" dataKey="cumulativeNet" stroke="var(--color-cumulativeNet)" strokeWidth={2} dot={false} />
                      {summary.spendAvailable && summary.spend != null && (
                        <ReferenceLine y={summary.spend} stroke="hsl(var(--destructive))" strokeDasharray="4 4" />
                      )}
                    </ComposedChart>
                  </ChartContainer>
                )}
              </Card>

              {/* -------- Section 2: Cost inputs -------- */}
              <Card className="p-4 shadow-card">
                <h3 className="mb-3 text-sm font-semibold">Cost & Assumption Inputs</h3>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
                  <CostInput label="Manual Spend" suffix="$" autoValue={dataset.facebookSpend != null ? fmtMoney(dataset.facebookSpend) : "unavailable"} value={ui.manualSpend} onChange={(v) => update({ manualSpend: v })} hint="Overrides Facebook spend. CAC = Spend / Trial Users." />
                  <CostInput label="Manual CAC" suffix="$" autoValue={fmtMoney(spendResolution.source === "facebook" ? spendResolution.cac : null)} value={ui.manualCac} onChange={(v) => update({ manualCac: v })} hint="Overrides spend: Spend = CAC × Trial Users." />
                  <CostInput label="Trial Price" suffix="$" autoValue={fmtMoney(autoAssumptions.trialPrice)} value={ui.trialPrice} onChange={(v) => update({ trialPrice: v })} />
                  <CostInput label="Subscription Price" suffix="$" autoValue={fmtMoney(autoAssumptions.subscriptionPrice)} value={ui.subscriptionPrice} onChange={(v) => update({ subscriptionPrice: v })} />
                  <CostInput label="Upsell Value" suffix="$" autoValue={fmtMoney(autoAssumptions.upsellValue)} value={ui.upsellValue} onChange={(v) => update({ upsellValue: v })} />
                  <CostInput label="Upsell Rate" suffix="%" autoValue={`${(autoAssumptions.upsellRate * 100).toFixed(1)}%`} value={ui.upsellRate} onChange={(v) => update({ upsellRate: v })} />
                  <CostInput label="First Renewal Rate" suffix="%" autoValue={`${(autoAssumptions.firstRenewalRate * 100).toFixed(1)}%`} value={ui.firstRenewalRate} onChange={(v) => update({ firstRenewalRate: v })} hint="Trial → first paid subscription month." />
                  <CostInput label="Monthly Retention" suffix="%" autoValue={`${(autoAssumptions.monthlyRetention * 100).toFixed(1)}%`} value={ui.monthlyRetention} onChange={(v) => update({ monthlyRetention: v })} hint="Month-over-month retention after the first paid month." />
                  <CostInput label="Refund Rate" suffix="%" autoValue={`${(autoAssumptions.refundRate * 100).toFixed(1)}%`} value={ui.refundRate} onChange={(v) => update({ refundRate: v })} />
                  <CostInput label="Processing Fee" suffix="%" autoValue={`${PROCESSING_FEE_DEFAULT_PCT}%`} value={ui.processingFeePct} onChange={(v) => update({ processingFeePct: v })} />
                  <CostInput label="Fixed Processing Fee" suffix="$/charge" autoValue={fmtMoney(FIXED_FEE_DEFAULT)} value={ui.fixedFee} onChange={(v) => update({ fixedFee: v })} />
                  <CostInput label="Margin Target" suffix="%" autoValue="0%" value={ui.marginTarget} onChange={(v) => update({ marginTarget: v })} hint="Desired profit margin for Max Profitable CAC." />
                </div>
              </Card>

              {/* -------- Section 4: Cohort payback table -------- */}
              <Card className="p-4 shadow-card">
                <h3 className="mb-3 text-sm font-semibold">Cohort Payback Table</h3>
                <div className="overflow-x-auto rounded-lg border border-border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Cohort</TableHead>
                        <TableHead>Funnel</TableHead>
                        <TableHead>Campaign Path</TableHead>
                        <SortableHead label="Trial Users" k="trialUsers" onSort={toggleSort} icon={sortIcon} />
                        <SortableHead label="Spend" k="spend" onSort={toggleSort} icon={sortIcon} />
                        <SortableHead label="CAC" k="cac" onSort={toggleSort} icon={sortIcon} />
                        <TableHead className="text-right">Gross</TableHead>
                        <TableHead className="text-right">Net</TableHead>
                        <TableHead className="text-right">Current</TableHead>
                        <TableHead className="text-right">D7</TableHead>
                        <SortableHead label="1M" k="roas1M" onSort={toggleSort} icon={sortIcon} />
                        <TableHead className="text-right">2M</TableHead>
                        <TableHead className="text-right">3M</TableHead>
                        <SortableHead label="Payback" k="paybackDay" onSort={toggleSort} icon={sortIcon} />
                        <TableHead className="text-right">LTV</TableHead>
                        <SortableHead label="Profit/User" k="profitPerUser" onSort={toggleSort} icon={sortIcon} />
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pagedRows.map((row: CohortPaybackRow) => (
                        <TableRow key={row.cohortId}>
                          <TableCell className="whitespace-nowrap text-xs tabular-nums">{row.cohortDate}</TableCell>
                          <TableCell className="text-xs">{row.funnel}</TableCell>
                          <TableCell className="max-w-[160px] truncate text-xs" title={row.campaignPath}>{row.campaignPath}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtInt(row.trialUsers)}</TableCell>
                          <TableCell className="text-right tabular-nums">{row.spendAvailable ? fmtMoney(row.spend) : "—"}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(row.cac)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(row.grossRevenue)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(row.netRevenue)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtRoas(row.currentRoas)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtRoas(row.roasD7)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtRoas(row.roas1M)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtRoas(row.roas2M)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtRoas(row.roas3M)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtDay(row.paybackDay)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(row.projectedLtv)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmtMoney(row.profitPerUser)}</TableCell>
                          <TableCell><StatusBadge status={row.status} /></TableCell>
                        </TableRow>
                      ))}
                      {pagedRows.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={17} className="py-8 text-center text-sm text-muted-foreground">No cohorts match the current filters.</TableCell>
                        </TableRow>
                      )}
                    </TableBody>
                  </Table>
                </div>
                <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                  <span>{fmtInt(sortedRows.length)} cohorts · page {safePage} of {totalPages}</span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => update({ page: Math.max(1, safePage - 1) })}>Previous</Button>
                    <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => update({ page: Math.min(totalPages, safePage + 1) })}>Next</Button>
                  </div>
                </div>
              </Card>

              {/* -------- Section 6: Scenario planner -------- */}
              <Card className="p-4 shadow-card">
                <h3 className="mb-3 text-sm font-semibold">Scenario Planner</h3>
                <p className="mb-3 text-xs text-muted-foreground">Leave a field blank to use the base value. Answer "what if CAC goes to $32?" or "what if first renewal improves to 40%?"</p>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                  <ScenarioInput label="CAC ($)" value={ui.scCac} onChange={(v) => update({ scCac: v })} />
                  <ScenarioInput label="Trial Price ($)" value={ui.scTrialPrice} onChange={(v) => update({ scTrialPrice: v })} />
                  <ScenarioInput label="Subscription Price ($)" value={ui.scSubscriptionPrice} onChange={(v) => update({ scSubscriptionPrice: v })} />
                  <ScenarioInput label="First Renewal (%)" value={ui.scFirstRenewalRate} onChange={(v) => update({ scFirstRenewalRate: v })} />
                  <ScenarioInput label="Monthly Retention (%)" value={ui.scMonthlyRetention} onChange={(v) => update({ scMonthlyRetention: v })} />
                  <ScenarioInput label="Upsell Rate (%)" value={ui.scUpsellRate} onChange={(v) => update({ scUpsellRate: v })} />
                  <ScenarioInput label="Upsell Value ($)" value={ui.scUpsellValue} onChange={(v) => update({ scUpsellValue: v })} />
                  <ScenarioInput label="Refund Rate (%)" value={ui.scRefundRate} onChange={(v) => update({ scRefundRate: v })} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                  <KpiCard label="Base ROAS 1M" value={fmtRoas(scenarioResult.base.roas1M)} />
                  <KpiCard label="Scenario ROAS 1M" value={fmtRoas(scenarioResult.scenario.roas1M)} accent="success" />
                  <KpiCard label="Base Payback Day" value={fmtDay(scenarioResult.base.paybackDay)} />
                  <KpiCard label="Scenario Payback Day" value={fmtDay(scenarioResult.scenario.paybackDay)} accent="success" />
                  <KpiCard label="Δ Profit" value={fmtMoney(scenarioResult.deltaProfit)} accent={scenarioResult.deltaProfit != null && scenarioResult.deltaProfit >= 0 ? "success" : "warning"} />
                </div>
              </Card>
            </>
          )}
        </div>
      </TooltipProvider>
    </AppLayout>
  );
}

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  format,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
  allLabel: string;
  format?: (v: string) => string;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>{format ? format(option) : option}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SortableHead({ label, k, onSort, icon }: { label: string; k: SortKey; onSort: (k: SortKey) => void; icon: (k: SortKey) => ReactNode }) {
  return (
    <TableHead className="text-right">
      <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-foreground">
        {label} {icon(k)}
      </button>
    </TableHead>
  );
}

function ScenarioInput({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input className="h-8" value={value} onChange={(e) => onChange(e.target.value)} placeholder="base" />
    </div>
  );
}
