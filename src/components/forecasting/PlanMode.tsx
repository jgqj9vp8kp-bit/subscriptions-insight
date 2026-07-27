// Plan mode — forward funnel-economics planning (Forecasting redesign v3, P4).
//
// Thin consumer of the FunnelEconomics platform module: it only seeds inputs
// (live actuals → AssumptionBuilder), collects manual overrides, freezes them and
// renders the engine result. Every formula lives in the engine; every displayed
// input carries a provenance badge (auto / manual / config / extrapolated).
import { useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { KpiCard } from "@/components/KpiCard";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { useTransactions } from "@/services/sheets";
import { useDataStore } from "@/store/dataStore";
import { computeCohorts, formatCurrency } from "@/services/analytics";
import { aggregateTrafficMetrics, cohortTrafficKey } from "@/services/cohortReporting";
import {
  ForecastInputError,
  buildForecastAssumptions,
  createFrozenForecastInputs,
  deriveFunnelActualsFromCohortRows,
  runFrozenForecast,
  workbookBonusPolicy,
  type AssumptionPatch,
  type Cadence,
  type CohortRowLike,
  type ExtrapolationMethod,
  type ForecastResult,
  type Provenance,
  type ProvenanceMap,
} from "@/services/funnelEconomics";
import { saveForecastScenario } from "@/services/forecastScenarios";
import { addCompareEntry } from "@/components/forecasting/compareStore";

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PLAN_UI_STATE = {
  funnel: "",
  windowDays: "180",
  cadence: "monthly" as Cadence,
  horizon: "",
  budget: "50000",
  // "" = seeded (auto/config); a value = manual override.
  cpa: "",
  trialPrice: "",
  periodPrice: "",
  refundPct: "",
  stripePct: "",
  providerPct: "",
  trafficPct: "",
  ffBilling: "",
  funnelConstructor: "",
  payroll: "",
  allocationMode: "fixed_amount" as "fixed_amount" | "exclude" | "manual",
  allocationAmount: "",
  bonusEnabled: true,
  tokenArpu: "",
  tokenHold: "",
  extrapolation: "geometric_last" as ExtrapolationMethod,
  survivalOverrides: {} as Record<string, string>,
};

type PlanUiState = typeof DEFAULT_PLAN_UI_STATE;

function parseNum(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parsePct(value: string): number | undefined {
  const parsed = parseNum(value);
  return parsed === undefined ? undefined : parsed / 100;
}

const PROVENANCE_META: Record<Provenance, { label: string; className: string }> = {
  actual: { label: "actual", className: "bg-success/15 text-success" },
  auto_derived: { label: "auto", className: "bg-primary/10 text-primary" },
  manual_override: { label: "manual", className: "bg-warning/15 text-warning" },
  config: { label: "config", className: "bg-muted text-muted-foreground" },
  extrapolated: { label: "extrapolated", className: "bg-accent/15 text-accent-foreground" },
  calculated: { label: "calculated", className: "bg-muted text-muted-foreground" },
};

function ProvenanceBadge({ provenance }: { provenance: Provenance | undefined }) {
  if (!provenance) return null;
  const meta = PROVENANCE_META[provenance];
  return <span className={cn("inline-flex rounded-full px-1.5 py-0 text-[10px] font-medium", meta.className)}>{meta.label}</span>;
}

function PlanInput({ label, value, seeded, provenance, onChange, suffix }: {
  label: string;
  value: string;
  seeded?: string;
  provenance?: Provenance;
  onChange: (value: string) => void;
  suffix?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs text-muted-foreground">{label}</Label>
        <ProvenanceBadge provenance={value.trim() ? "manual_override" : provenance} />
      </div>
      <div className="relative">
        <Input className="h-8" value={value} placeholder={seeded ?? ""} onChange={(event) => onChange(event.target.value)} />
        {suffix && <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

// Export the projection table (period rows + totals) as CSV/XLSX, mirroring the
// Cohorts-page export pattern (BOM for Excel, dynamic xlsx import).
function buildPlanExportTable(result: ForecastResult): { headers: string[]; rows: Array<Array<string | number>> } {
  const headers = [
    "Period", "Users", "Cumulative retention", "Trial revenue", "Subscription revenue", "Upsell revenue",
    "Token revenue", "Gross revenue", "Stripe", "Refunds", "Provider", "Payment-net", "Cumulative payment-net", "Cash flow",
  ];
  const rows = result.timeline.periods.map((row) => [
    row.label, row.users, row.cumulativeRetention, row.revenue.trial, row.revenue.subscription, row.revenue.upsell,
    row.revenue.token, row.revenue.gross, row.costs.stripe, row.costs.refund, row.costs.provider,
    row.paymentNetRevenue, row.cumulativePaymentNetRevenue, row.cashFlowBalance,
  ]);
  rows.push([
    "TOTAL", result.metrics.trials, "", result.revenue.trialTotal, result.revenue.subscriptionTotal, result.revenue.upsellTotal,
    result.revenue.tokenTotal, result.revenue.grossTotal, result.costs.stripeTotal, result.costs.refundTotal,
    result.costs.providerTotal, result.profitability.paymentNetRevenueTotal, result.profitability.paymentNetRevenueTotal,
    result.payback.finalCashFlowBalance,
  ]);
  return { headers, rows };
}

async function exportPlanTable(result: ForecastResult, format: "csv" | "xlsx"): Promise<void> {
  const table = buildPlanExportTable(result);
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "csv") {
    const escape = (value: string | number) => {
      const text = String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const csv = [table.headers, ...table.rows].map((row) => row.map(escape).join(",")).join("\n");
    const blob = new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `forecast-plan-${stamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    return;
  }
  const XLSX = await import("xlsx");
  const sheet = XLSX.utils.aoa_to_sheet([table.headers, ...table.rows]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Forecast");
  XLSX.writeFile(book, `forecast-plan-${stamp}.xlsx`);
}

const fmtMoney = (value: number | null | undefined) => (value == null ? "—" : formatCurrency(value));
const fmtInt = (value: number) => Math.round(value).toLocaleString("en-US");
const fmtPctValue = (value: number | null | undefined, digits = 1) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);
const fmtRatio = (value: number | null | undefined) => (value == null ? "—" : value.toFixed(2));

const CHART_CONFIG: ChartConfig = {
  cumulative: { label: "Cumulative payment-net", color: "hsl(var(--primary))" },
};

/** Save the frozen snapshot as a named scenario and/or push it into the Compare tab's
 * working set. The snapshot is fully serializable — what you save is what re-runs. */
function ScenarioActions({ frozen, funnel, defaultLabel }: {
  frozen: NonNullable<ReturnType<typeof createFrozenForecastInputs>>;
  funnel: string;
  defaultLabel: string;
}) {
  const [label, setLabel] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const effectiveLabel = label.trim() || defaultLabel;

  const handleAddToComparison = () => {
    addCompareEntry({
      id: `plan:${Date.now().toString(36)}`,
      label: effectiveLabel,
      frozen,
      addedAt: new Date().toISOString(),
    });
    setStatus(`Added "${effectiveLabel}" to Compare.`);
  };

  const handleSave = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await saveForecastScenario({
        name: effectiveLabel,
        funnelId: funnel,
        horizonPeriods: frozen.assumptions.pricing.schedule.periods.length,
        frozen,
      });
      setStatus(`Saved scenario "${effectiveLabel}".`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the scenario.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="p-4 shadow-card">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[260px] flex-1 space-y-1">
          <Label className="text-xs text-muted-foreground">Scenario name</Label>
          <Input className="h-8" placeholder={defaultLabel} value={label} onChange={(event) => setLabel(event.target.value)} />
        </div>
        <Button variant="outline" size="sm" onClick={handleAddToComparison}>Add to comparison</Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Save scenario"}</Button>
        {status && <span className="text-xs text-muted-foreground">{status}</span>}
      </div>
    </Card>
  );
}

export function PlanMode() {
  const txs = useTransactions();
  const subscriptions = useDataStore((state) => state.subscriptions);
  const trafficMetrics = useDataStore((state) => state.trafficMetrics);
  const [ui, setUi, resetUi] = usePersistedPageState<PlanUiState>("ui_state_forecasting_plan_v1", DEFAULT_PLAN_UI_STATE);
  const update = (patch: Partial<PlanUiState>) => setUi((current) => ({ ...current, ...patch }));
  // Stable reference instant for the session (deterministic seeding while mounted).
  const [asOf] = useState(() => new Date().toISOString());

  const cohorts = useMemo(() => computeCohorts(txs, subscriptions, {}), [txs, subscriptions]);
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);

  const funnelOptions = useMemo(
    () => Array.from(new Set(cohorts.map((cohort) => cohort.funnel).filter(Boolean))).sort(),
    [cohorts],
  );
  const funnel = ui.funnel && funnelOptions.includes(ui.funnel) ? ui.funnel : funnelOptions[0] ?? "";

  const seedRows = useMemo<CohortRowLike[]>(() => {
    const windowDays = parseNum(ui.windowDays);
    const fromMs = windowDays === undefined ? null : Date.parse(asOf) - windowDays * DAY_MS;
    return cohorts
      .filter((cohort) => cohort.funnel === funnel)
      .filter((cohort) => fromMs === null || Date.parse(`${cohort.cohort_date}T00:00:00Z`) >= fromMs)
      .map((cohort) => ({
        ...cohort,
        fb_spend: trafficByKey.get(cohortTrafficKey(cohort))?.spend ?? undefined,
      }));
  }, [cohorts, funnel, trafficByKey, ui.windowDays, asOf]);

  const seed = useMemo(
    () => deriveFunnelActualsFromCohortRows({
      funnelId: funnel || "(none)",
      rows: seedRows,
      asOf,
      periodDays: ui.cadence === "weekly" ? 7 : 30,
    }),
    [funnel, seedRows, asOf, ui.cadence],
  );

  const plan = useMemo(() => {
    const budget = parseNum(ui.budget);
    if (budget === undefined || budget <= 0) {
      return { error: "Enter a planned budget (USD) to run the projection.", result: null, provenance: {} as ProvenanceMap, assumptions: null, frozen: null, warnings: [] };
    }
    const overrides: AssumptionPatch = {};
    const stripePct = parsePct(ui.stripePct);
    const providerPct = parsePct(ui.providerPct);
    const refundPct = parsePct(ui.refundPct);
    const trafficPct = parsePct(ui.trafficPct);
    const ffBilling = parseNum(ui.ffBilling);
    const funnelConstructor = parseNum(ui.funnelConstructor);
    const payroll = parseNum(ui.payroll);
    const tokenArpu = parseNum(ui.tokenArpu);
    const tokenHold = parsePct(ui.tokenHold);
    if (stripePct !== undefined || providerPct !== undefined || refundPct !== undefined || ffBilling !== undefined || funnelConstructor !== undefined || payroll !== undefined) {
      overrides.costs = {
        ...(stripePct !== undefined ? { stripeCommission: stripePct } : {}),
        ...(providerPct !== undefined ? { providerCommission: providerPct } : {}),
        ...(refundPct !== undefined ? { refundRate: refundPct } : {}),
        ...((ffBilling !== undefined || funnelConstructor !== undefined || payroll !== undefined)
          ? {
            fixed: {
              ...(ffBilling !== undefined ? { ffBilling } : {}),
              ...(funnelConstructor !== undefined ? { funnelConstructor } : {}),
              ...(payroll !== undefined ? { payroll } : {}),
            },
          }
          : {}),
      };
    }
    if (trafficPct !== undefined) overrides.traffic = { trafficCommission: trafficPct };
    if (tokenArpu !== undefined || tokenHold !== undefined) {
      overrides.monetization = {
        ...(tokenArpu !== undefined ? { tokenArpuPerTrial: tokenArpu } : {}),
        ...(tokenHold !== undefined ? { tokenArpuHold: tokenHold } : {}),
      };
    }

    try {
      const built = buildForecastAssumptions({
        cadence: ui.cadence,
        plannedBudget: budget,
        horizonPeriods: parseNum(ui.horizon),
        actuals: seed.actuals,
        manual: {
          targetCpa: parseNum(ui.cpa),
          trialPrice: parseNum(ui.trialPrice),
          periodPrice: parseNum(ui.periodPrice),
        },
        extrapolation: { method: ui.extrapolation },
        overrides,
      });

      // Per-period survival overrides (retention panel).
      const survival = [...built.assumptions.retention.survival];
      for (const [indexKey, raw] of Object.entries(ui.survivalOverrides)) {
        const index = Number(indexKey);
        const value = parsePct(raw);
        if (value === undefined || !Number.isInteger(index) || index < 1 || index >= survival.length) continue;
        survival[index] = value;
        built.provenance[`retention.survival[${index}]`] = "manual_override";
      }
      built.assumptions.retention.survival = survival;

      // Overhead allocation mode from the panel.
      if (ui.allocationMode === "exclude") {
        built.assumptions.costs.overheadAllocation = { mode: "exclude" };
      } else if (ui.allocationMode === "manual") {
        built.assumptions.costs.overheadAllocation = { mode: "manual", amount: parseNum(ui.allocationAmount) ?? 0 };
      }

      const frozen = createFrozenForecastInputs({
        assumptions: built.assumptions,
        provenance: built.provenance,
        resolvedAt: asOf,
        policyDescriptors: {
          bonus: { ...workbookBonusPolicy(), enabled: ui.bonusEnabled },
          extrapolation: { method: ui.extrapolation },
          rounding: { mode: "full_precision" },
        },
      });
      const result = runFrozenForecast(frozen);
      return { error: null, result, provenance: built.provenance, assumptions: built.assumptions, frozen, warnings: [...seed.warnings, ...built.warnings, ...result.warnings.map((warning) => ({ code: warning.code, message: warning.message }))] };
    } catch (error) {
      if (error instanceof ForecastInputError) {
        return { error: error.message, result: null, provenance: {} as ProvenanceMap, assumptions: null, frozen: null, warnings: seed.warnings };
      }
      throw error;
    }
  }, [ui, seed, asOf]);

  const result: ForecastResult | null = plan.result;
  const assumptions = plan.assumptions;
  const provenance = plan.provenance;

  const chartData = useMemo(
    () => result
      ? result.timeline.periods.map((row) => ({ label: row.label, cumulative: row.cumulativePaymentNetRevenue }))
      : [],
    [result],
  );

  const seededCpa = seed.actuals?.cpaActual;
  const seededTrialPrice = seed.actuals?.trialPriceActual;
  const seededPeriodPrice = seed.actuals?.subPriceActual;

  return (
    <div className="space-y-4">
      {/* -------- Scenario setup -------- */}
      <Card className="p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Plan — funnel & seed</h3>
          <Button variant="ghost" size="sm" onClick={resetUi}><RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset plan</Button>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Funnel</Label>
            <Select value={funnel} onValueChange={(value) => update({ funnel: value })}>
              <SelectTrigger className="h-8"><SelectValue placeholder="Funnel" /></SelectTrigger>
              <SelectContent>
                {funnelOptions.map((option) => <SelectItem key={option} value={option}>{option}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Actuals window</Label>
            <Select value={ui.windowDays} onValueChange={(value) => update({ windowDays: value })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="60">Last 60 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="180">Last 180 days</SelectItem>
                <SelectItem value="365">Last 365 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Pricing cadence</Label>
            <Select value={ui.cadence} onValueChange={(value: Cadence) => update({ cadence: value })}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="monthly">Monthly (12 periods)</SelectItem>
                <SelectItem value="weekly">Weekly (24 periods)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <PlanInput label="Horizon (periods)" value={ui.horizon} seeded={ui.cadence === "weekly" ? "24" : "12"} provenance="config" onChange={(value) => update({ horizon: value })} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>Seed: {seed.coverage.cohorts} cohorts · {fmtInt(seed.coverage.trialUsers)} trials · maturity {seed.coverage.maturityDays}d · spend coverage {seed.coverage.spendCoverage == null ? "—" : fmtPctValue(seed.coverage.spendCoverage, 0)}</span>
          {plan.warnings.map((warning) => (
            <Badge key={warning.code + warning.message.slice(0, 12)} variant="outline" className="text-[10px] font-normal text-warning border-warning/40">{warning.code}</Badge>
          ))}
        </div>
      </Card>

      {/* -------- Primary drivers -------- */}
      <Card className="p-4 shadow-card">
        <h3 className="mb-3 text-sm font-semibold">Primary drivers</h3>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <PlanInput label="Planned budget (USD)" value={ui.budget} provenance="manual_override" onChange={(value) => update({ budget: value })} />
          <PlanInput label="Target CPA" value={ui.cpa} seeded={seededCpa != null ? seededCpa.toFixed(2) : undefined} provenance={provenance["traffic.targetCpa"] ?? (seededCpa != null ? "auto_derived" : undefined)} onChange={(value) => update({ cpa: value })} />
          <PlanInput label="Trial price" value={ui.trialPrice} seeded={seededTrialPrice != null ? seededTrialPrice.toFixed(2) : undefined} provenance={provenance["pricing.trialPrice"]} onChange={(value) => update({ trialPrice: value })} />
          <PlanInput label="Subscription price / period" value={ui.periodPrice} seeded={seededPeriodPrice != null ? seededPeriodPrice.toFixed(2) : undefined} provenance={provenance["pricing.periodPrice"]} onChange={(value) => update({ periodPrice: value })} />
        </div>
      </Card>

      {plan.error && (
        <Card className="border-warning/50 p-4 text-sm text-warning shadow-card">
          {plan.error}
        </Card>
      )}

      {plan.frozen && (
        <ScenarioActions
          frozen={plan.frozen}
          funnel={funnel}
          defaultLabel={`${funnel} · ${ui.cadence} · $${ui.budget}`}
        />
      )}

      {result && assumptions && (
        <>
          {/* -------- KPI grid -------- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <KpiCard label="Trials" value={fmtInt(result.metrics.trials)} />
            <KpiCard label="Traffic cash outflow" value={fmtMoney(result.costs.trafficCashOutflow)} />
            <KpiCard label="Gross revenue" value={fmtMoney(result.revenue.grossTotal)} />
            <KpiCard label="Payment-net revenue" value={fmtMoney(result.profitability.paymentNetRevenueTotal)} hint="Gross − Stripe − refunds − provider (workbook 'Gross Profit')." />
            <KpiCard label="Contribution profit" value={fmtMoney(result.profitability.contributionProfit)} hint="Payment-net − traffic cash outflow (pre-bonus, pre-overhead)." accent={result.profitability.contributionProfit >= 0 ? "success" : "warning"} />
            <KpiCard label="Net profit" value={fmtMoney(result.profitability.netProfit)} accent={result.profitability.netProfit >= 0 ? "success" : "warning"} hint="Contribution − performance bonus − allocated overhead." />
            <KpiCard label="Performance bonus" value={fmtMoney(result.costs.performanceBonus)} />
            <KpiCard label="Allocated overhead" value={fmtMoney(result.costs.allocatedOverhead)} />
            <KpiCard label="Gross LTV" value={fmtMoney(result.metrics.grossLtv)} />
            <KpiCard label="Contribution LTV" value={fmtMoney(result.metrics.contributionLtv)} hint="Payment-net per trial — compare against CAC." />
            <KpiCard label="CAC" value={fmtMoney(result.metrics.cac)} hint="Traffic cash outflow / trials (fully loaded)." />
            <KpiCard label="Payback" value={result.payback.paybackDay != null ? `day ${result.payback.paybackDay}` : "not in horizon"} accent={result.payback.paybackDay != null ? "success" : "warning"} />
            <KpiCard label="ROAS" value={fmtRatio(result.metrics.roas)} hint="Gross revenue / traffic cash outflow." />
            <KpiCard label="ROMI" value={fmtRatio(result.metrics.romi)} hint="Contribution profit / traffic cash outflow." />
            <KpiCard label="ROI" value={fmtRatio(result.metrics.roi)} hint="Net profit / (traffic + bonus + overhead)." />
            <KpiCard label="Contribution margin" value={fmtPctValue(result.metrics.contributionMargin)} />
          </div>

          {/* -------- Cash-flow chart -------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-1 text-sm font-semibold">Cumulative payment-net vs traffic cost</h3>
            <p className="mb-2 text-xs text-muted-foreground">Payback = the period where the cumulative line crosses the traffic-cost reference.</p>
            <ChartContainer config={CHART_CONFIG} className="h-64 w-full">
              <ComposedChart data={chartData} margin={{ left: 12, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value: number) => formatCurrency(value)} width={90} />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ReferenceLine y={result.costs.trafficCashOutflow} stroke="hsl(var(--destructive))" strokeDasharray="4 4" label={{ value: "traffic cost", fontSize: 10, position: "insideTopRight" }} />
                <Line type="monotone" dataKey="cumulative" stroke="var(--color-cumulative)" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ChartContainer>
          </Card>

          {/* -------- Assumption panels (progressive disclosure) -------- */}
          <Card className="p-4 shadow-card">
            <Accordion type="multiple" defaultValue={["retention"]}>
              <AccordionItem value="retention">
                <AccordionTrigger className="text-sm">Retention curve <span className="ml-2 text-xs font-normal text-muted-foreground">observed {assumptions.retention.observedDepth} of {assumptions.retention.survival.length} periods</span></AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-4 gap-2 md:grid-cols-6 xl:grid-cols-8">
                    {assumptions.retention.survival.map((value, index) => {
                      if (index === 0) return null;
                      const label = result.timeline.periods[index]?.label ?? `P${index}`;
                      const tag = provenance[`retention.survival[${index}]`];
                      return (
                        <div key={index} className="space-y-1">
                          <div className="flex items-center gap-1">
                            <Label className="text-[11px] text-muted-foreground">{label}</Label>
                            <ProvenanceBadge provenance={tag} />
                          </div>
                          <Input
                            className="h-7 text-xs"
                            placeholder={(value * 100).toFixed(1)}
                            value={ui.survivalOverrides[String(index)] ?? ""}
                            onChange={(event) => update({ survivalOverrides: { ...ui.survivalOverrides, [String(index)]: event.target.value } })}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">Per-period survival, % of the previous period. Empty = seeded value; extrapolation: {ui.extrapolation}.</p>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="monetization">
                <AccordionTrigger className="text-sm">Monetization</AccordionTrigger>
                <AccordionContent>
                  <div className="mb-2 text-xs text-muted-foreground">
                    Upsell tiers (seeded from actuals): {assumptions.monetization.upsells.length === 0 ? "none" : assumptions.monetization.upsells.map((tier) => `${(tier.takeRate * 100).toFixed(1)}% × ${formatCurrency(tier.price)}`).join(" · ")}
                  </div>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <PlanInput label="Token ARPU / trial" value={ui.tokenArpu} seeded={seed.actuals?.tokenArpuPerTrialActual != null ? seed.actuals.tokenArpuPerTrialActual.toFixed(2) : "0"} provenance={provenance["monetization.tokenArpuPerTrial"]} onChange={(value) => update({ tokenArpu: value })} />
                    <PlanInput label="Token hold per period" value={ui.tokenHold} seeded="0" suffix="%" provenance={provenance["monetization.tokenArpuHold"]} onChange={(value) => update({ tokenHold: value })} />
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="fees">
                <AccordionTrigger className="text-sm">Fees & refunds</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <PlanInput label="Traffic commission" value={ui.trafficPct} seeded="4" suffix="%" provenance={provenance["traffic.trafficCommission"]} onChange={(value) => update({ trafficPct: value })} />
                    <PlanInput label="Stripe commission" value={ui.stripePct} seeded="7" suffix="%" provenance={provenance["costs.stripeCommission"]} onChange={(value) => update({ stripePct: value })} />
                    <PlanInput label="Provider commission" value={ui.providerPct} seeded="5.9" suffix="%" provenance={provenance["costs.providerCommission"]} onChange={(value) => update({ providerPct: value })} />
                    <PlanInput label="Refund rate" value={ui.refundPct} seeded={seed.actuals?.refundRateActual != null ? (seed.actuals.refundRateActual * 100).toFixed(1) : "10"} suffix="%" provenance={provenance["costs.refundRate"]} onChange={(value) => update({ refundPct: value })} />
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="overhead">
                <AccordionTrigger className="text-sm">Overhead & allocation</AccordionTrigger>
                <AccordionContent>
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                    <PlanInput label="FF Billing" value={ui.ffBilling} seeded="5000" provenance={provenance["costs.fixed"]} onChange={(value) => update({ ffBilling: value })} />
                    <PlanInput label="Funnel constructor" value={ui.funnelConstructor} seeded="2271.36" provenance={provenance["costs.fixed"]} onChange={(value) => update({ funnelConstructor: value })} />
                    <PlanInput label="Payroll" value={ui.payroll} seeded="9000" provenance={provenance["costs.fixed"]} onChange={(value) => update({ payroll: value })} />
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Allocation mode</Label>
                      <Select value={ui.allocationMode} onValueChange={(value: PlanUiState["allocationMode"]) => update({ allocationMode: value })}>
                        <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="fixed_amount">Full fixed amount</SelectItem>
                          <SelectItem value="exclude">Exclude overhead</SelectItem>
                          <SelectItem value="manual">Manual amount</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {ui.allocationMode === "manual" && (
                      <PlanInput label="Allocated amount" value={ui.allocationAmount} provenance="manual_override" onChange={(value) => update({ allocationAmount: value })} />
                    )}
                  </div>
                </AccordionContent>
              </AccordionItem>

              <AccordionItem value="policies">
                <AccordionTrigger className="text-sm">Advanced policy</AccordionTrigger>
                <AccordionContent>
                  <div className="flex flex-wrap items-center gap-6">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch checked={ui.bonusEnabled} onCheckedChange={(checked) => update({ bonusEnabled: checked })} />
                      Media-buyer bonus policy (workbook v1)
                    </label>
                    <div className="space-y-1">
                      <Label className="text-xs text-muted-foreground">Survival tail extrapolation</Label>
                      <Select value={ui.extrapolation} onValueChange={(value: ExtrapolationMethod) => update({ extrapolation: value })}>
                        <SelectTrigger className="h-8 w-[220px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="geometric_last">Repeat last observed</SelectItem>
                          <SelectItem value="geometric_avg">Geometric mean of tail</SelectItem>
                          <SelectItem value="flat">No further churn (optimistic)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <span className="text-xs text-muted-foreground">Bonus = budget × max(0, 1% + (45 − CPA / first-paid conversion) × 0.4%)</span>
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Card>

          {/* -------- Revenue streams -------- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <KpiCard label="Trial revenue" value={fmtMoney(result.revenue.trialTotal)} />
            <KpiCard label="Subscription revenue" value={fmtMoney(result.revenue.subscriptionTotal)} />
            <KpiCard label="Upsell revenue" value={fmtMoney(result.revenue.upsellTotal)} />
            <KpiCard label="Token revenue" value={fmtMoney(result.revenue.tokenTotal)} />
          </div>

          {/* -------- Period table -------- */}
          <Card className="p-4 shadow-card">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Projection by period</h3>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => void exportPlanTable(result, "csv")}>Export CSV</Button>
                <Button variant="outline" size="sm" onClick={() => void exportPlanTable(result, "xlsx")}>Export XLSX</Button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Period</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">Retention</TableHead>
                    <TableHead className="text-right">Gross</TableHead>
                    <TableHead className="text-right">Payment costs</TableHead>
                    <TableHead className="text-right">Payment-net</TableHead>
                    <TableHead className="text-right">Cumulative</TableHead>
                    <TableHead className="text-right">Cash flow</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.timeline.periods.map((row) => (
                    <TableRow key={row.index}>
                      <TableCell className="font-medium">
                        {row.label}
                        {provenance[`retention.survival[${row.index}]`] === "extrapolated" && (
                          <span className="ml-1.5 align-middle"><ProvenanceBadge provenance="extrapolated" /></span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">{fmtInt(row.users)}</TableCell>
                      <TableCell className="text-right">{fmtPctValue(row.cumulativeRetention)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(row.revenue.gross)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(row.costs.paymentTotal)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(row.paymentNetRevenue)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(row.cumulativePaymentNetRevenue)}</TableCell>
                      <TableCell className={cn("text-right", row.cashFlowBalance >= 0 ? "text-success" : "text-destructive")}>{fmtMoney(row.cashFlowBalance)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
