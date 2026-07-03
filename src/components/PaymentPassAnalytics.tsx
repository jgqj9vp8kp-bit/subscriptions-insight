import { useDeferredValue, useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, XAxis, YAxis } from "recharts";
import { CheckCircle2, CreditCard, Percent, Users, X, XCircle } from "lucide-react";
import type { Transaction } from "@/services/types";
import { KpiCard } from "@/components/KpiCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import {
  buildPaymentAttempts,
  declineReasonAnalytics,
  declineReasonLabel,
  firstAttemptAttempts,
  firstTransactionBreakdown,
  groupPaymentAttempts,
  PAYMENT_STAGE_LABELS,
  paymentStageBreakdown,
  renewalAttempts,
  renewalBreakdown,
  SEGMENT_DIMENSION_LABELS,
  summarizePaymentAttempts,
  passRateByDay,
  type SegmentDimension,
  type PaymentStage,
} from "@/services/paymentPassAnalytics";

const SEGMENT_PAGE_SIZE = 25;

const SEGMENT_DIMENSIONS: SegmentDimension[] = [
  "funnel",
  "campaign_path",
  "campaign_id",
  "media_buyer",
  "country",
  "card_type",
  "decline_reason",
  "stage",
];

// Phase 6 / Phase 7 only break down by these dimensions.
const ENTITY_DIMENSIONS: SegmentDimension[] = ["funnel", "country", "card_type", "media_buyer", "campaign_id"];

const STAGE_FILTER_VALUES: PaymentStage[] = [
  "trial_or_entry",
  "first_subscription",
  "renewal_2",
  "renewal_3",
  "renewal_n",
  "upsell",
  "unknown",
];

const DEFAULT_PASS_UI_STATE = {
  dateFrom: "",
  dateTo: "",
  dateBasis: "transaction" as "transaction" | "cohort",
  funnelFilter: "all",
  campaignPathFilter: "all",
  campaignIdFilter: "all",
  mediaBuyerFilter: "all",
  countryFilter: "all",
  cardTypeFilter: "all",
  stageFilter: "all",
  declineReasonFilter: "all",
  transactionTypeFilter: "all",
  outcomeFilter: "all" as "all" | "success" | "failed",
  groupBy: "campaign_path" as SegmentDimension,
  firstTxDimension: "funnel" as SegmentDimension,
  renewalDimension: "funnel" as SegmentDimension,
  segmentPage: 1,
  excludeInsufficientFunds: false,
};

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function num(value: number): string {
  return Math.round(value).toLocaleString();
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort();
}

const passRateConfig = {
  pass_rate: { label: "Pass Rate", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

const failedConfig = {
  failed_attempts: { label: "Failed Attempts", color: "hsl(var(--chart-4))" },
} satisfies ChartConfig;

const trialTrendConfig = {
  successful: { label: "Successful", color: "hsl(217 91% 60%)" },
  failed: { label: "Failed", color: "hsl(var(--chart-3))" },
  pass_rate: { label: "Pass Rate", color: "hsl(var(--chart-1))" },
} satisfies ChartConfig;

export function PaymentPassAnalytics({ txs }: { txs: Transaction[] }) {
  const [uiState, setUiState, resetUiState] = usePersistedPageState(
    "ui_state_transactions_pass",
    DEFAULT_PASS_UI_STATE,
  );
  const {
    dateFrom,
    dateTo,
    dateBasis,
    funnelFilter,
    campaignPathFilter,
    campaignIdFilter,
    mediaBuyerFilter,
    countryFilter,
    cardTypeFilter,
    stageFilter,
    declineReasonFilter,
    transactionTypeFilter,
    outcomeFilter,
    groupBy,
    firstTxDimension,
    renewalDimension,
    segmentPage,
    excludeInsufficientFunds,
  } = uiState;
  const update = (patch: Partial<typeof DEFAULT_PASS_UI_STATE>) =>
    setUiState((current) => ({ ...current, ...patch }));

  // When the toggle is ON the ex-IF column is emphasised and the normal Pass Rate is de-emphasised.
  const rateCls = excludeInsufficientFunds ? "text-right tabular-nums text-muted-foreground" : "text-right tabular-nums";
  const exIfCls = excludeInsufficientFunds
    ? "text-right tabular-nums font-semibold text-primary"
    : "text-right tabular-nums text-muted-foreground";

  // Heavy step: classify the full warehouse once per data load.
  const allAttempts = useMemo(() => buildPaymentAttempts(txs), [txs]);

  const options = useMemo(
    () => ({
      funnels: uniqueSorted(allAttempts.map((a) => a.funnel)),
      campaignPaths: uniqueSorted(allAttempts.map((a) => a.campaign_path)),
      campaignIds: uniqueSorted(allAttempts.map((a) => a.campaign_id)),
      mediaBuyers: uniqueSorted(allAttempts.map((a) => a.media_buyer)),
      cardTypes: uniqueSorted(allAttempts.map((a) => a.card_type)),
      transactionTypes: uniqueSorted(allAttempts.map((a) => a.transaction_type)),
      declineReasons: uniqueSorted(
        allAttempts.filter((a) => a.decline_reason).map((a) => a.decline_reason as string),
      ),
    }),
    [allAttempts],
  );

  // GEO options are CONTEXTUAL: only countries that still have data under the other active filters
  // (notably the selected funnel), each annotated with its trial count. The selected country is kept
  // in the list even if it drops to zero so the trigger always reflects the active selection.
  const geoOptions = useMemo(() => {
    const inContext = allAttempts.filter((a) => {
      const dateField = dateBasis === "cohort" ? a.cohort_date : a.event_date;
      if (dateFrom && (!dateField || dateField < dateFrom)) return false;
      if (dateTo && (!dateField || dateField > dateTo)) return false;
      if (funnelFilter !== "all" && a.funnel !== funnelFilter) return false;
      if (campaignPathFilter !== "all" && a.campaign_path !== campaignPathFilter) return false;
      if (campaignIdFilter !== "all" && a.campaign_id !== campaignIdFilter) return false;
      if (mediaBuyerFilter !== "all" && a.media_buyer !== mediaBuyerFilter) return false;
      if (cardTypeFilter !== "all" && a.card_type !== cardTypeFilter) return false;
      if (stageFilter !== "all" && a.stage !== stageFilter) return false;
      if (declineReasonFilter !== "all" && a.decline_reason !== declineReasonFilter) return false;
      if (transactionTypeFilter !== "all" && a.transaction_type !== transactionTypeFilter) return false;
      return true;
    });
    const trialsByCountry = new Map<string, number>();
    for (const a of inContext) {
      if (!trialsByCountry.has(a.country)) trialsByCountry.set(a.country, 0);
      if (a.transaction_type === "trial" && a.is_success) {
        trialsByCountry.set(a.country, (trialsByCountry.get(a.country) ?? 0) + 1);
      }
    }
    if (countryFilter !== "all" && !trialsByCountry.has(countryFilter)) trialsByCountry.set(countryFilter, 0);
    return Array.from(trialsByCountry.entries())
      .map(([code, trials]) => ({ code, trials }))
      .sort((a, b) => b.trials - a.trials || a.code.localeCompare(b.code));
  }, [
    allAttempts,
    dateBasis,
    dateFrom,
    dateTo,
    funnelFilter,
    campaignPathFilter,
    campaignIdFilter,
    mediaBuyerFilter,
    cardTypeFilter,
    stageFilter,
    declineReasonFilter,
    transactionTypeFilter,
    countryFilter,
  ]);

  const filtered = useMemo(() => {
    return allAttempts.filter((a) => {
      const dateField = dateBasis === "cohort" ? a.cohort_date : a.event_date;
      if (dateFrom && (!dateField || dateField < dateFrom)) return false;
      if (dateTo && (!dateField || dateField > dateTo)) return false;
      if (funnelFilter !== "all" && a.funnel !== funnelFilter) return false;
      if (campaignPathFilter !== "all" && a.campaign_path !== campaignPathFilter) return false;
      if (campaignIdFilter !== "all" && a.campaign_id !== campaignIdFilter) return false;
      if (mediaBuyerFilter !== "all" && a.media_buyer !== mediaBuyerFilter) return false;
      if (countryFilter !== "all" && a.country !== countryFilter) return false;
      if (cardTypeFilter !== "all" && a.card_type !== cardTypeFilter) return false;
      if (stageFilter !== "all" && a.stage !== stageFilter) return false;
      if (declineReasonFilter !== "all" && a.decline_reason !== declineReasonFilter) return false;
      if (transactionTypeFilter !== "all" && a.transaction_type !== transactionTypeFilter) return false;
      if (outcomeFilter === "success" && !a.is_success) return false;
      if (outcomeFilter === "failed" && !a.is_failed) return false;
      return true;
    });
  }, [
    allAttempts,
    dateBasis,
    dateFrom,
    dateTo,
    funnelFilter,
    campaignPathFilter,
    campaignIdFilter,
    mediaBuyerFilter,
    countryFilter,
    cardTypeFilter,
    stageFilter,
    declineReasonFilter,
    transactionTypeFilter,
    outcomeFilter,
  ]);

  // Defer the expensive aggregations so filter clicks stay responsive.
  const attempts = useDeferredValue(filtered);

  const summary = useMemo(() => summarizePaymentAttempts(attempts), [attempts]);
  const funnelRows = useMemo(() => groupPaymentAttempts(attempts, "funnel"), [attempts]);
  const stageRows = useMemo(() => paymentStageBreakdown(attempts), [attempts]);
  const segmentRows = useMemo(() => groupPaymentAttempts(attempts, groupBy), [attempts, groupBy]);
  const firstSummary = useMemo(
    () => summarizePaymentAttempts(firstAttemptAttempts(attempts)),
    [attempts],
  );
  const firstTxRows = useMemo(
    () => firstTransactionBreakdown(attempts, firstTxDimension),
    [attempts, firstTxDimension],
  );
  const renewalRows = useMemo(() => renewalBreakdown(attempts), [attempts]);
  const renewalSegmentRows = useMemo(
    () => groupPaymentAttempts(renewalAttempts(attempts), renewalDimension),
    [attempts, renewalDimension],
  );
  const declineRows = useMemo(() => declineReasonAnalytics(attempts), [attempts]);
  const timePoints = useMemo(() => passRateByDay(attempts), [attempts]);

  const firstAttemptDecline = useMemo(() => {
    const fails = firstAttemptAttempts(attempts).filter((a) => a.is_failed && a.decline_reason);
    const counts = new Map<string, number>();
    for (const a of fails) counts.set(a.decline_reason!, (counts.get(a.decline_reason!) ?? 0) + 1);
    return Array.from(counts.entries())
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 5);
  }, [attempts]);

  const segmentTotalPages = Math.max(1, Math.ceil(segmentRows.length / SEGMENT_PAGE_SIZE));
  const safeSegmentPage = Math.min(segmentPage, segmentTotalPages);
  const pagedSegmentRows = segmentRows.slice(
    (safeSegmentPage - 1) * SEGMENT_PAGE_SIZE,
    safeSegmentPage * SEGMENT_PAGE_SIZE,
  );

  const isStale = attempts !== filtered;
  const isLarge = allAttempts.length > 50000;

  const passByFunnelChart = useMemo(
    () => funnelRows.slice(0, 12).map((r) => ({ label: r.label, pass_rate: Number((r.pass_rate * 100).toFixed(1)) })),
    [funnelRows],
  );
  const failedByReasonChart = useMemo(
    () => declineRows.slice(0, 12).map((r) => ({ label: r.label, failed_attempts: r.failed_attempts })),
    [declineRows],
  );
  const passByStageChart = useMemo(
    () =>
      stageRows
        .filter((r) => r.stage !== "first_transaction" && r.attempts > 0)
        .map((r) => ({ label: r.label, pass_rate: Number((r.pass_rate * 100).toFixed(1)) })),
    [stageRows],
  );
  const passOverTimeChart = useMemo(
    () => timePoints.map((p) => ({ date: p.date, pass_rate: Number((p.pass_rate * 100).toFixed(1)) })),
    [timePoints],
  );
  // Trial-entry attempts per country, ranked by VOLUME descending (most transactions on top). All
  // countries are kept (the list scrolls) — rendered as volume-scaled stacked bars (success vs
  // failed), matching the decline-analytics style.
  const trialVolumeByCountry = useMemo(
    () =>
      groupPaymentAttempts(attempts.filter((a) => a.stage === "trial_or_entry"), "country")
        .slice()
        .sort((a, b) => b.attempts - a.attempts || b.successful - a.successful || a.label.localeCompare(b.label)),
    [attempts],
  );
  // Bar length scales to the busiest country in the shown set (order-independent).
  const maxTrialAttempts = useMemo(
    () => trialVolumeByCountry.reduce((max, r) => Math.max(max, r.attempts), 0),
    [trialVolumeByCountry],
  );
  // Same view excluding insufficient-funds declines: bar = eligible attempts (attempts − IF),
  // segments are success vs non-IF failures, ranked by eligible volume descending.
  const trialVolumeByCountryExIf = useMemo(
    () =>
      trialVolumeByCountry
        .filter((r) => r.eligible_attempts_ex_if > 0)
        .slice()
        .sort(
          (a, b) =>
            b.eligible_attempts_ex_if - a.eligible_attempts_ex_if ||
            b.successful - a.successful ||
            a.label.localeCompare(b.label),
        ),
    [trialVolumeByCountry],
  );
  const maxTrialEligible = useMemo(
    () => trialVolumeByCountryExIf.reduce((max, r) => Math.max(max, r.eligible_attempts_ex_if), 0),
    [trialVolumeByCountryExIf],
  );
  // Original line-chart view: pass rate per country, ordered alphabetically along the X axis.
  const trialPassByCountry = useMemo(
    () =>
      groupPaymentAttempts(attempts.filter((a) => a.stage === "trial_or_entry"), "country")
        .slice(0, 20)
        .map((r) => ({
          country: r.label,
          pass_rate: Number((r.pass_rate * 100).toFixed(1)),
          attempts: r.attempts,
          successful: r.successful,
          failed: r.failed,
        }))
        .sort((a, b) => a.country.localeCompare(b.country)),
    [attempts],
  );

  const hasFilters =
    dateFrom ||
    dateTo ||
    [
      funnelFilter,
      campaignPathFilter,
      campaignIdFilter,
      mediaBuyerFilter,
      countryFilter,
      cardTypeFilter,
      stageFilter,
      declineReasonFilter,
      transactionTypeFilter,
    ].some((v) => v !== "all") ||
    outcomeFilter !== "all" ||
    dateBasis !== "transaction";

  const renderOptions = (values: string[], format?: (v: string) => string) =>
    values.map((v) => (
      <SelectItem key={v} value={v}>
        {format ? format(v) : v}
      </SelectItem>
    ));

  return (
    <div className={`space-y-4 ${isStale ? "opacity-70 transition-opacity" : ""}`}>
      {/* ---------------- Filters (Phase 5) ---------------- */}
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Date basis</Label>
            <Select value={dateBasis} onValueChange={(v) => update({ dateBasis: v as "transaction" | "cohort", segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[170px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="transaction">Transaction Date</SelectItem>
                <SelectItem value="cohort">User Cohort Date</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input type="date" value={dateFrom} onChange={(e) => update({ dateFrom: e.target.value, segmentPage: 1 })} className="h-9 w-[150px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input type="date" value={dateTo} onChange={(e) => update({ dateTo: e.target.value, segmentPage: 1 })} className="h-9 w-[150px]" />
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Funnel</Label>
            <Select value={funnelFilter} onValueChange={(v) => update({ funnelFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All funnels</SelectItem>{renderOptions(options.funnels)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Campaign Path</Label>
            <Select value={campaignPathFilter} onValueChange={(v) => update({ campaignPathFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All paths</SelectItem>{renderOptions(options.campaignPaths)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Campaign ID</Label>
            <Select value={campaignIdFilter} onValueChange={(v) => update({ campaignIdFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All IDs</SelectItem>{renderOptions(options.campaignIds)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Media Buyer</Label>
            <Select value={mediaBuyerFilter} onValueChange={(v) => update({ mediaBuyerFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[140px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All buyers</SelectItem>{renderOptions(options.mediaBuyers)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">GEO / Country</Label>
            <Select value={countryFilter} onValueChange={(v) => update({ countryFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                {geoOptions.map(({ code, trials }) => (
                  <SelectItem key={code} value={code}>
                    <span className="flex w-full items-center justify-between gap-3">
                      <span>{code}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">{num(trials)} trials</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Card Type</Label>
            <Select value={cardTypeFilter} onValueChange={(v) => update({ cardTypeFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All cards</SelectItem>{renderOptions(options.cardTypes)}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Payment Stage</Label>
            <Select value={stageFilter} onValueChange={(v) => update({ stageFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All stages</SelectItem>
                {STAGE_FILTER_VALUES.map((s) => (
                  <SelectItem key={s} value={s}>{PAYMENT_STAGE_LABELS[s]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Decline Reason</Label>
            <Select value={declineReasonFilter} onValueChange={(v) => update({ declineReasonFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All reasons</SelectItem>
                {renderOptions(options.declineReasons, (v) => declineReasonLabel(v as never))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Transaction Type</Label>
            <Select value={transactionTypeFilter} onValueChange={(v) => update({ transactionTypeFilter: v, segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[150px]"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">All types</SelectItem>{renderOptions(options.transactionTypes, (v) => v.replace(/_/g, " "))}</SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label className="text-xs text-muted-foreground">Outcome</Label>
            <Select value={outcomeFilter} onValueChange={(v) => update({ outcomeFilter: v as "all" | "success" | "failed", segmentPage: 1 })}>
              <SelectTrigger className="h-9 w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="success">Success</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={resetUiState} className="h-9">
              <X className="mr-1 h-4 w-4" /> Clear
            </Button>
          )}
        </div>
        {isLarge && (
          <p className="mt-3 text-xs text-warning">
            Large dataset ({num(allAttempts.length)} attempts) — analytics may take a moment to recompute after filter changes.
          </p>
        )}
      </Card>

      {/* ---------------- A. Summary cards (Phase 4A) ---------------- */}
      <div className="flex items-center justify-end gap-2">
        <Label htmlFor="exclude-if-toggle" className="text-xs text-muted-foreground">
          Exclude Insufficient Funds from Pass Rate
        </Label>
        <Switch
          id="exclude-if-toggle"
          checked={excludeInsufficientFunds}
          onCheckedChange={(checked) => update({ excludeInsufficientFunds: checked })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <KpiCard label="Total Attempts" value={num(summary.attempts)} icon={<CreditCard className="h-4 w-4" />} />
        <KpiCard label="Successful" value={num(summary.successful)} accent="success" icon={<CheckCircle2 className="h-4 w-4" />} />
        <KpiCard label="Failed" value={num(summary.failed)} accent="warning" icon={<XCircle className="h-4 w-4" />} />
        <KpiCard label="Overall Pass Rate" value={pct(summary.pass_rate)} accent="success" icon={<Percent className="h-4 w-4" />} />
        <KpiCard
          label="Pass Rate excl. Insufficient Funds"
          value={pct(summary.pass_rate_ex_if)}
          accent="success"
          hint={`Excluded IF declines: ${num(summary.insufficient_funds_failures)}`}
          icon={<Percent className="h-4 w-4" />}
        />
        <KpiCard label="Users With Attempts" value={num(summary.users_with_attempts)} icon={<Users className="h-4 w-4" />} />
        <KpiCard label="Users With Success" value={num(summary.users_with_success)} accent="success" icon={<Users className="h-4 w-4" />} />
        <KpiCard label="User Pass Rate" value={pct(summary.user_pass_rate)} accent="success" icon={<Percent className="h-4 w-4" />} />
        <KpiCard label="First Attempt Pass Rate" value={pct(summary.first_attempt_pass_rate)} icon={<Percent className="h-4 w-4" />} />
        <KpiCard label="First Sub Pass Rate" value={pct(summary.first_sub_pass_rate)} icon={<Percent className="h-4 w-4" />} />
        <KpiCard label="Renewal Pass Rate" value={pct(summary.renewal_pass_rate)} icon={<Percent className="h-4 w-4" />} />
      </div>

      {attempts.length === 0 ? (
        <Card className="p-10 text-center text-sm text-muted-foreground shadow-card">
          No payment attempts match your filters.
        </Card>
      ) : (
        <>
          {/* ---------------- Charts (Phase 9) ---------------- */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <Card className="p-4 shadow-card">
              <h3 className="mb-3 text-sm font-semibold">Pass Rate by Funnel</h3>
              <ChartContainer config={passRateConfig} className="h-[260px] w-full">
                <BarChart data={passByFunnelChart} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} hide={passByFunnelChart.length > 8} />
                  <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="pass_rate" fill="var(--color-pass_rate)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </Card>
            <Card className="p-4 shadow-card">
              <h3 className="mb-3 text-sm font-semibold">Failed Attempts by Decline Reason</h3>
              <ChartContainer config={failedConfig} className="h-[260px] w-full">
                <BarChart data={failedByReasonChart} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} hide={failedByReasonChart.length > 6} />
                  <YAxis tickLine={false} axisLine={false} width={44} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="failed_attempts" fill="var(--color-failed_attempts)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </Card>
            <Card className="p-4 shadow-card">
              <h3 className="mb-3 text-sm font-semibold">Pass Rate by Payment Stage</h3>
              <ChartContainer config={passRateConfig} className="h-[260px] w-full">
                <BarChart data={passByStageChart} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} hide={passByStageChart.length > 7} />
                  <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="pass_rate" fill="var(--color-pass_rate)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ChartContainer>
            </Card>
            <Card className="p-4 shadow-card">
              <h3 className="mb-3 text-sm font-semibold">Pass Rate over Time</h3>
              <ChartContainer config={passRateConfig} className="h-[260px] w-full">
                <LineChart data={passOverTimeChart} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={8} hide={passOverTimeChart.length > 20} />
                  <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => `${v}%`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Line type="monotone" dataKey="pass_rate" stroke="var(--color-pass_rate)" strokeWidth={2} dot={false} />
                </LineChart>
              </ChartContainer>
            </Card>
          </div>

          {/* ---------------- Trial Pass Rate by Country (volume-scaled stacked bars) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Trial Payment Pass Rate by Country</h3>
            {trialVolumeByCountry.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No trial payment attempts in the current selection.</p>
            ) : (
              <>
                <div className="max-h-[440px] space-y-3 overflow-y-auto pr-1">
                  {trialVolumeByCountry.map((row) => (
                    <div key={row.key} className="grid grid-cols-[minmax(110px,160px)_1fr_auto] items-center gap-3 text-sm">
                      <span className="truncate text-xs text-muted-foreground">
                        {row.label} · <span className="font-medium text-foreground">{pct(row.pass_rate)}</span>
                      </span>
                      <div
                        className="h-2.5 overflow-hidden rounded-full bg-muted"
                        title={`${row.label}: ${num(row.attempts)} trial attempts · ${num(row.successful)} success / ${num(row.failed)} failed · ${pct(row.pass_rate)} pass rate`}
                      >
                        <div
                          className="flex h-full overflow-hidden rounded-full"
                          style={{ width: `${maxTrialAttempts ? (row.attempts / maxTrialAttempts) * 100 : 0}%` }}
                        >
                          <div className="bg-primary" style={{ width: `${row.attempts ? (row.successful / row.attempts) * 100 : 0}%` }} />
                          <div className="bg-warning" style={{ width: `${row.attempts ? (row.failed / row.attempts) * 100 : 0}%` }} />
                        </div>
                      </div>
                      <span className="text-xs font-medium tabular-nums">{num(row.attempts)}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" /> Successful</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" /> Failed</span>
                  <span className="ml-auto">Bar length = trial volume · number = total attempts</span>
                </div>
              </>
            )}
          </Card>

          {/* ---------------- Trial Pass Rate by Country excluding Insufficient Funds ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Trial Payment Pass Rate by Country (excl. Insufficient Funds)</h3>
            {trialVolumeByCountryExIf.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No eligible trial attempts in the current selection.</p>
            ) : (
              <>
                <div className="max-h-[440px] space-y-3 overflow-y-auto pr-1">
                  {trialVolumeByCountryExIf.map((row) => {
                    const eligible = row.eligible_attempts_ex_if;
                    const failedExIf = row.failed - row.insufficient_funds_failures;
                    return (
                      <div key={row.key} className="grid grid-cols-[minmax(110px,160px)_1fr_auto] items-center gap-3 text-sm">
                        <span className="truncate text-xs text-muted-foreground">
                          {row.label} · <span className="font-medium text-foreground">{pct(row.pass_rate_ex_if)}</span>
                        </span>
                        <div
                          className="h-2.5 overflow-hidden rounded-full bg-muted"
                          title={`${row.label}: ${num(eligible)} eligible attempts · ${num(row.successful)} success / ${num(failedExIf)} failed · ${num(row.insufficient_funds_failures)} insufficient-funds declines excluded · ${pct(row.pass_rate_ex_if)} pass rate`}
                        >
                          <div
                            className="flex h-full overflow-hidden rounded-full"
                            style={{ width: `${maxTrialEligible ? (eligible / maxTrialEligible) * 100 : 0}%` }}
                          >
                            <div className="bg-primary" style={{ width: `${eligible ? (row.successful / eligible) * 100 : 0}%` }} />
                            <div className="bg-warning" style={{ width: `${eligible ? (failedExIf / eligible) * 100 : 0}%` }} />
                          </div>
                        </div>
                        <span className="text-xs font-medium tabular-nums">{num(eligible)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-primary" /> Successful</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warning" /> Failed (excl. IF)</span>
                  <span className="ml-auto">Bar length = eligible attempts (insufficient-funds declines excluded)</span>
                </div>
              </>
            )}
          </Card>

          {/* ---------------- Trial Pass Rate by Country (line, original view) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Trial Payment Pass Rate by Country (trend)</h3>
            {trialPassByCountry.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">No trial payment attempts in the current selection.</p>
            ) : (
              <ChartContainer config={trialTrendConfig} className="h-[300px] w-full">
                <ComposedChart data={trialPassByCountry} margin={{ left: 8, right: 16, top: 8, bottom: 8 }}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="country" tickLine={false} axisLine={false} tickMargin={8} interval={0} />
                  <YAxis yAxisId="count" tickLine={false} axisLine={false} width={44} />
                  <YAxis yAxisId="rate" orientation="right" tickLine={false} axisLine={false} width={44} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar yAxisId="count" dataKey="successful" stackId="count" fill="var(--color-successful)" maxBarSize={28} />
                  <Bar yAxisId="count" dataKey="failed" stackId="count" fill="var(--color-failed)" radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Line yAxisId="rate" type="monotone" dataKey="pass_rate" stroke="var(--color-pass_rate)" strokeWidth={2} dot={{ r: 3 }} />
                </ComposedChart>
              </ChartContainer>
            )}
          </Card>

          {/* ---------------- B. Breakdown by Funnel (Phase 4B) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Breakdown by Funnel</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Funnel</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Pass Rate</TableHead>
                    <TableHead className="text-right">Pass Rate ex. IF</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Users w/ Success</TableHead>
                    <TableHead className="text-right">User Pass Rate</TableHead>
                    <TableHead className="text-right">First Attempt</TableHead>
                    <TableHead className="text-right">First Sub</TableHead>
                    <TableHead className="text-right">Renewal</TableHead>
                    <TableHead>Top Decline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {funnelRows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed)}</TableCell>
                      <TableCell className={rateCls}>{pct(r.pass_rate)}</TableCell>
                      <TableCell className={exIfCls}>{pct(r.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_success)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(r.user_pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(r.first_attempt_pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(r.first_sub_pass_rate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(r.renewal_pass_rate)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{declineReasonLabel(r.top_decline_reason)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* ---------------- C. Breakdown by Stage (Phase 4C) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Breakdown by Stage</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Stage</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Pass Rate</TableHead>
                    <TableHead className="text-right">Pass Rate ex. IF</TableHead>
                    <TableHead className="text-right">Failed Users</TableHead>
                    <TableHead>Top Decline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stageRows.map((r) => (
                    <TableRow key={r.stage}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed)}</TableCell>
                      <TableCell className={rateCls}>{pct(r.pass_rate)}</TableCell>
                      <TableCell className={exIfCls}>{pct(r.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed_users)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{declineReasonLabel(r.top_decline_reason)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* ---------------- D. Breakdown by Segment (Phase 4D) ---------------- */}
          <Card className="p-4 shadow-card">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Breakdown by Segment</h3>
              <div className="flex items-center gap-2">
                <Label className="text-xs text-muted-foreground">Group by</Label>
                <Select value={groupBy} onValueChange={(v) => update({ groupBy: v as SegmentDimension, segmentPage: 1 })}>
                  <SelectTrigger className="h-9 w-[200px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SEGMENT_DIMENSIONS.map((d) => (
                      <SelectItem key={d} value={d}>{SEGMENT_DIMENSION_LABELS[d]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{SEGMENT_DIMENSION_LABELS[groupBy]}</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Pass Rate</TableHead>
                    <TableHead className="text-right">Pass Rate ex. IF</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Users w/ Success</TableHead>
                    <TableHead className="text-right">User Pass Rate</TableHead>
                    <TableHead>Top Decline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedSegmentRows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed)}</TableCell>
                      <TableCell className={rateCls}>{pct(r.pass_rate)}</TableCell>
                      <TableCell className={exIfCls}>{pct(r.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_success)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(r.user_pass_rate)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{declineReasonLabel(r.top_decline_reason)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
              <span>{num(segmentRows.length)} segments · page {safeSegmentPage} of {segmentTotalPages}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={safeSegmentPage <= 1} onClick={() => update({ segmentPage: Math.max(1, safeSegmentPage - 1) })}>Previous</Button>
                <Button variant="outline" size="sm" disabled={safeSegmentPage >= segmentTotalPages} onClick={() => update({ segmentPage: Math.min(segmentTotalPages, safeSegmentPage + 1) })}>Next</Button>
              </div>
            </div>
          </Card>

          {/* ---------------- First Transaction Analytics (Phase 6) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">First Transaction Analytics</h3>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
              <KpiCard label="First Attempt Users" value={num(firstSummary.users_with_attempts)} />
              <KpiCard label="First Success Users" value={num(firstSummary.first_success)} accent="success" />
              <KpiCard label="First Failed Users" value={num(firstSummary.first_attempts - firstSummary.first_success)} accent="warning" />
              <KpiCard label="First Attempt Pass Rate" value={pct(firstSummary.first_attempt_pass_rate)} accent="success" />
              <KpiCard label="Top First Decline" value={firstAttemptDecline[0] ? declineReasonLabel(firstAttemptDecline[0].reason as never) : "—"} />
            </div>
            {firstAttemptDecline.length > 0 && (
              <p className="mt-3 text-xs text-muted-foreground">
                Top first-attempt declines:{" "}
                {firstAttemptDecline.map((d) => `${declineReasonLabel(d.reason as never)} (${num(d.n)})`).join(", ")}
              </p>
            )}
            <div className="mt-4 flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Segment</Label>
              <Select value={firstTxDimension} onValueChange={(v) => update({ firstTxDimension: v as SegmentDimension })}>
                <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ENTITY_DIMENSIONS.map((d) => (
                    <SelectItem key={d} value={d}>{SEGMENT_DIMENSION_LABELS[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{SEGMENT_DIMENSION_LABELS[firstTxDimension]}</TableHead>
                    <TableHead className="text-right">First Attempts</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Pass Rate</TableHead>
                    <TableHead className="text-right">Pass Rate ex. IF</TableHead>
                    <TableHead>Top Decline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {firstTxRows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed)}</TableCell>
                      <TableCell className={rateCls}>{pct(r.pass_rate)}</TableCell>
                      <TableCell className={exIfCls}>{pct(r.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{declineReasonLabel(r.top_decline_reason)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* ---------------- Renewal / Rebill Analytics (Phase 7) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Renewal Pass Analytics</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Renewal Stage</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Pass Rate</TableHead>
                    <TableHead className="text-right">Pass Rate ex. IF</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Users w/ Success</TableHead>
                    <TableHead>Top Decline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {renewalRows.map((r) => (
                    <TableRow key={r.level}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed)}</TableCell>
                      <TableCell className={rateCls}>{pct(r.pass_rate)}</TableCell>
                      <TableCell className={exIfCls}>{pct(r.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_success)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{declineReasonLabel(r.top_decline_reason)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <Label className="text-xs text-muted-foreground">Renewal breakdown by</Label>
              <Select value={renewalDimension} onValueChange={(v) => update({ renewalDimension: v as SegmentDimension })}>
                <SelectTrigger className="h-9 w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ENTITY_DIMENSIONS.map((d) => (
                    <SelectItem key={d} value={d}>{SEGMENT_DIMENSION_LABELS[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{SEGMENT_DIMENSION_LABELS[renewalDimension]}</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Success</TableHead>
                    <TableHead className="text-right">Failed</TableHead>
                    <TableHead className="text-right">Pass Rate</TableHead>
                    <TableHead className="text-right">Pass Rate ex. IF</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead>Top Decline</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {renewalSegmentRows.slice(0, 50).map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.successful)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed)}</TableCell>
                      <TableCell className={rateCls}>{pct(r.pass_rate)}</TableCell>
                      <TableCell className={exIfCls}>{pct(r.pass_rate_ex_if)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.users_with_attempts)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{declineReasonLabel(r.top_decline_reason)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>

          {/* ---------------- Decline Reason Analytics (Phase 8) ---------------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Decline Reason Analytics</h3>
            <div className="overflow-x-auto rounded-lg border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Decline Reason</TableHead>
                    <TableHead className="text-right">Failed Attempts</TableHead>
                    <TableHead className="text-right">Failed Users</TableHead>
                    <TableHead className="text-right">Share</TableHead>
                    <TableHead className="text-right">Affected Funnels</TableHead>
                    <TableHead>Most Common Stage</TableHead>
                    <TableHead>Most Common Card</TableHead>
                    <TableHead>Most Common GEO</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {declineRows.map((r) => (
                    <TableRow key={r.reason}>
                      <TableCell className="font-medium">{r.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed_attempts)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.failed_users)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(r.share_of_failed)}</TableCell>
                      <TableCell className="text-right tabular-nums">{num(r.affected_funnels.length)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.most_common_stage ? PAYMENT_STAGE_LABELS[r.most_common_stage] : "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.most_common_card_type ?? "—"}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{r.most_common_country ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                  {declineRows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                        No failed attempts in the current selection.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
