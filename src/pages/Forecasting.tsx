import { useEffect, useMemo, useState } from "react";
import { Calculator, RotateCcw, Save, TrendingUp } from "lucide-react";
import { AppLayout } from "@/components/AppLayout";
import { KpiCard } from "@/components/KpiCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { computeCohorts, formatCurrency, formatPct } from "@/services/analytics";
import { useTransactions } from "@/services/sheets";
import { normalizeCampaignPath, type TrafficMetric } from "@/services/trafficImport";
import type { CohortRow } from "@/services/types";
import { useDataStore } from "@/store/dataStore";
import { usePersistedPageState } from "@/hooks/usePersistedPageState";
import { loadDefaultRetentionCurve } from "@/services/forecastingSettings";
import {
  buildForecastPriceOptions,
  defaultPriceSelection,
  fallbackRetentionForMonth,
  forecastProfit,
  forecastRoas,
  projectedSpendFromCac,
  priceSourceLabel,
  resolveSelectedPrice,
  resolveForecastCac,
  retentionPercentagesForCohorts,
  type ForecastPriceOption,
  type PriceSelection,
} from "@/services/forecasting";

type RetentionSource = "auto_actual" | "auto_fallback" | "manual";

type RetentionInput = {
  month: number;
  value: string;
  actualValue: number | null;
  fallbackValue: number;
  source: RetentionSource;
};

type ForecastInputs = {
  trialPrice: string;
  subscriptionPrice: string;
  upsellRate: string;
  upsellValue: string;
  refundRate: string;
  stripeFee: string;
  fbFee: string;
  cac: string;
};

type MonthlyForecastRow = {
  month: number;
  retention: number;
  payingUsers: number;
  subscriptionRevenue: number;
  cumulativeGrossRevenue: number;
  cumulativeNetRevenue: number;
  projectedSpend: number | null;
  cumulativeLtv: number;
  cumulativeProfit: number;
  roas: number | null;
};

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);
const SCENARIOS_STORAGE_KEY = "forecasting_scenarios_v1";
const DEFAULT_TRIAL_PRICE = 1;
const DEFAULT_SUBSCRIPTION_PRICE = 29.99;
const DEFAULT_UPSELL_VALUE = 14.98;

const DEFAULT_FORECAST_INPUTS: ForecastInputs = {
  trialPrice: "0",
  subscriptionPrice: "0",
  upsellRate: "0",
  upsellValue: "0",
  refundRate: "0",
  stripeFee: "0",
  fbFee: "0",
  cac: "",
};

const DEFAULT_FORECASTING_UI_STATE = {
  dateFrom: "",
  dateTo: "",
  campaignPathFilter: "all",
  funnelFilter: "all",
  selectedCohortIds: [] as string[],
  retentionInputs: [] as RetentionInput[],
  forecastInputs: DEFAULT_FORECAST_INPUTS,
  trialPriceSelection: "default" as PriceSelection,
  subscriptionPriceSelection: "default" as PriceSelection,
  upsellValueSelection: "default" as PriceSelection,
  cacSource: "actual" as "actual" | "manual",
  lastAutoFillKey: "",
};

type TrafficAggregate = TrafficMetric & { row_count: number };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function inputString(value: unknown): string {
  return value == null ? "" : String(value);
}

function parseNumberInput(value: unknown): number {
  const normalized = String(value ?? "").trim().replace(",", ".");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stripExtraLeadingZero(value: string): string {
  return value.replace(/^(-?)0+(?=\d)/, "$1");
}

function clampPercent(value: unknown): number {
  return Math.min(100, Math.max(0, parseNumberInput(value)));
}

function numericInputProps() {
  return {
    type: "text" as const,
    inputMode: "decimal" as const,
  };
}

function normalizeDate(date: string): string {
  const raw = String(date ?? "").trim();
  const isoMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}`;
}

function trafficKey(date: string, campaignPath: string): string {
  return `${normalizeDate(date)}__${normalizeCampaignPath(campaignPath)}`;
}

function cohortTrafficKey(row: CohortRow): string {
  return trafficKey(row.cohort_date, row.campaign_path);
}

function aggregateTrafficMetrics(rows: TrafficMetric[]): Map<string, TrafficAggregate> {
  const map = new Map<string, TrafficAggregate>();
  for (const row of rows) {
    const key = trafficKey(row.date, row.campaign_path);
    const current = map.get(key);
    if (!current) {
      map.set(key, { ...row, row_count: 1 });
      continue;
    }
    current.trial_count += row.trial_count;
    current.spend += row.spend;
    current.clicks += row.clicks;
    current.cac = current.trial_count ? current.spend / current.trial_count : 0;
    current.cpc = current.clicks ? current.spend / current.clicks : 0;
    current.row_count += 1;
  }
  return map;
}

// Retention helpers (cohortIdForTrial / retentionPercentagesForCohorts / fallbackRetentionForMonth)
// now live in @/services/forecasting so they share the SAME cohort-id derivation as the price
// options and are unit-tested. See P0-1.

function sourceLabel(source: RetentionSource): string {
  if (source === "auto_actual") return "Actual";
  if (source === "manual") return "Manual";
  return "Fallback";
}

function sourceClass(source: RetentionSource): string {
  if (source === "auto_actual") return "text-success";
  if (source === "manual") return "text-primary";
  return "text-warning";
}

function buildForecastRows(
  trialUsers: number,
  cac: number | null,
  retention: RetentionInput[],
  inputs: ForecastInputs,
): MonthlyForecastRow[] {
  const trialPrice = parseNumberInput(inputs.trialPrice);
  const subscriptionPrice = parseNumberInput(inputs.subscriptionPrice);
  const upsellRate = parseNumberInput(inputs.upsellRate);
  const upsellValue = parseNumberInput(inputs.upsellValue);
  const refundRate = parseNumberInput(inputs.refundRate);
  const stripeFee = parseNumberInput(inputs.stripeFee);
  const fbFee = parseNumberInput(inputs.fbFee);
  const trialRevenue = trialUsers * trialPrice;
  const upsellRevenue = trialUsers * (upsellRate / 100) * upsellValue;
  const feeMultiplier = Math.max(0, 1 - (refundRate + stripeFee + fbFee) / 100);
  const projectedSpend = projectedSpendFromCac(trialUsers, cac);

  let cumulativeSubscriptionRevenue = 0;
  return retention.map((month) => {
    const retentionValue = clampPercent(month.value);
    const payingUsers = trialUsers * (retentionValue / 100);
    const subscriptionRevenue = payingUsers * subscriptionPrice;
    cumulativeSubscriptionRevenue += subscriptionRevenue;
    const cumulativeGrossRevenue = trialRevenue + upsellRevenue + cumulativeSubscriptionRevenue;
    const cumulativeNetRevenue = cumulativeGrossRevenue * feeMultiplier;
    return {
      month: month.month,
      retention: retentionValue,
      payingUsers,
      subscriptionRevenue,
      cumulativeGrossRevenue,
      cumulativeNetRevenue,
      projectedSpend,
      cumulativeLtv: trialUsers ? cumulativeNetRevenue / trialUsers : 0,
      cumulativeProfit: forecastProfit(cumulativeNetRevenue, projectedSpend),
      roas: forecastRoas(cumulativeNetRevenue, projectedSpend),
    };
  });
}

function sum(numbers: number[]): number {
  return numbers.reduce((total, value) => total + value, 0);
}

export default function ForecastingPage() {
  const txs = useTransactions();
  const subscriptions = useDataStore((state) => state.subscriptions);
  const trafficMetrics = useDataStore((state) => state.trafficMetrics);
  const [uiState, setUiState, resetUiState] = usePersistedPageState("ui_state_forecasting", DEFAULT_FORECASTING_UI_STATE);
  const {
    dateFrom,
    dateTo,
    campaignPathFilter,
    funnelFilter,
    selectedCohortIds: selectedIdList,
    retentionInputs,
    forecastInputs,
    trialPriceSelection: rawTrialPriceSelection,
    subscriptionPriceSelection: rawSubscriptionPriceSelection,
    upsellValueSelection: rawUpsellValueSelection,
    cacSource: rawCacSource,
    lastAutoFillKey,
  } = uiState;
  const normalizedForecastInputs = useMemo<ForecastInputs>(
    () => ({ ...DEFAULT_FORECAST_INPUTS, ...forecastInputs }),
    [forecastInputs],
  );
  const trialPriceSelection = (rawTrialPriceSelection ?? "default") as PriceSelection;
  const subscriptionPriceSelection = (rawSubscriptionPriceSelection ?? "default") as PriceSelection;
  const upsellValueSelection = (rawUpsellValueSelection ?? "default") as PriceSelection;
  const cacSource = rawCacSource === "manual" ? "manual" : "actual";
  const selectedIds = useMemo(() => new Set(selectedIdList), [selectedIdList]);
  const updateUiState = (patch: Partial<typeof DEFAULT_FORECASTING_UI_STATE>) => setUiState((current) => ({ ...current, ...patch }));
  const [scenarioName, setScenarioName] = useState("");
  const [scenarioMessage, setScenarioMessage] = useState<string | null>(null);
  const defaultRetentionCurve = useMemo(() => loadDefaultRetentionCurve(), []);

  const allCohorts = useMemo(() => computeCohorts(txs, subscriptions), [txs, subscriptions]);
  const trafficByKey = useMemo(() => aggregateTrafficMetrics(trafficMetrics), [trafficMetrics]);
  const campaignPathOptions = useMemo(() => Array.from(new Set(allCohorts.map((cohort) => cohort.campaign_path))).sort(), [allCohorts]);
  const funnelOptions = useMemo(() => Array.from(new Set(allCohorts.map((cohort) => cohort.funnel))).sort(), [allCohorts]);

  const filteredCohorts = useMemo(
    () =>
      allCohorts.filter((cohort) => {
        if (dateFrom && cohort.cohort_date < dateFrom) return false;
        if (dateTo && cohort.cohort_date > dateTo) return false;
        if (campaignPathFilter !== "all" && cohort.campaign_path !== campaignPathFilter) return false;
        if (funnelFilter !== "all" && cohort.funnel !== funnelFilter) return false;
        return true;
      }),
    [allCohorts, dateFrom, dateTo, campaignPathFilter, funnelFilter],
  );

  const effectiveSelectedCohorts = useMemo(() => {
    const explicit = filteredCohorts.filter((cohort) => selectedIds.has(cohort.cohort_id));
    return explicit.length ? explicit : filteredCohorts;
  }, [filteredCohorts, selectedIds]);

  const selectedCohortIds = useMemo(
    () => new Set(effectiveSelectedCohorts.map((cohort) => cohort.cohort_id)),
    [effectiveSelectedCohorts],
  );

  const actualSummary = useMemo(() => {
    const trafficRows = effectiveSelectedCohorts.map((cohort) => trafficByKey.get(cohortTrafficKey(cohort))).filter(Boolean) as TrafficAggregate[];
    const spend = sum(trafficRows.map((traffic) => traffic.spend));
    const fbTrialCount = sum(trafficRows.map((traffic) => traffic.trial_count));
    const trialUsers = sum(effectiveSelectedCohorts.map((cohort) => cohort.trial_users));
    const grossRevenue = sum(effectiveSelectedCohorts.map((cohort) => cohort.gross_revenue));
    const netRevenue = sum(effectiveSelectedCohorts.map((cohort) => cohort.net_revenue));
    const amountRefunded = sum(effectiveSelectedCohorts.map((cohort) => cohort.amount_refunded));
    const upsellUsers = sum(effectiveSelectedCohorts.map((cohort) => cohort.upsell_users));
    return {
      trialUsers,
      spend,
      hasActualSpend: trafficRows.length > 0,
      fbTrialCount,
      grossRevenue,
      netRevenue,
      revD0: sum(effectiveSelectedCohorts.map((cohort) => cohort.revenue_d0)),
      revD7: sum(effectiveSelectedCohorts.map((cohort) => cohort.revenue_d7)),
      rev1M: sum(effectiveSelectedCohorts.map((cohort) => cohort.revenue_d30)),
      rev2M: sum(effectiveSelectedCohorts.map((cohort) => cohort.revenue_d60)),
      cac: trafficRows.length > 0 && trialUsers ? spend / trialUsers : null,
      campaignPaths: Array.from(new Set(effectiveSelectedCohorts.map((cohort) => cohort.campaign_path))).join(", "),
      cohortDates: effectiveSelectedCohorts.map((cohort) => cohort.cohort_date).sort(),
      upsellRate: trialUsers ? (upsellUsers / trialUsers) * 100 : 0,
      refundRate: grossRevenue ? (amountRefunded / grossRevenue) * 100 : 0,
    };
  }, [effectiveSelectedCohorts, trafficByKey]);

  const priceOptions = useMemo(
    () => buildForecastPriceOptions(txs, selectedCohortIds),
    [selectedCohortIds, txs],
  );

  const cacState = useMemo(
    () =>
      resolveForecastCac({
        actualSpend: actualSummary.hasActualSpend ? actualSummary.spend : null,
        trialUsers: actualSummary.trialUsers,
        manualCac: normalizedForecastInputs.cac,
        manualOverride: cacSource === "manual",
      }),
    [actualSummary.hasActualSpend, actualSummary.spend, actualSummary.trialUsers, cacSource, normalizedForecastInputs.cac],
  );
  const cacInputValue = cacSource === "manual"
    ? inputString(normalizedForecastInputs.cac)
    : cacState.actualCac == null
      ? ""
      : String(round2(cacState.actualCac));
  const forecastSpend = projectedSpendFromCac(actualSummary.trialUsers, cacState.cac);

  const autoRetention = useMemo(() => {
    const actual = retentionPercentagesForCohorts(txs, Array.from(selectedCohortIds));
    const selectedCampaignPaths = new Set(effectiveSelectedCohorts.map((cohort) => cohort.campaign_path));
    return MONTHS.map((month, index) => {
      const fallbackValue = fallbackRetentionForMonth(index, txs, allCohorts, selectedCohortIds, selectedCampaignPaths, defaultRetentionCurve);
      const actualValue = actual[index];
      return {
        month,
        value: String(round2(actualValue ?? fallbackValue)),
        actualValue: actualValue == null ? null : round2(actualValue),
        fallbackValue: round2(fallbackValue),
        source: actualValue == null ? "auto_fallback" as const : "auto_actual" as const,
      };
    });
  }, [allCohorts, defaultRetentionCurve, effectiveSelectedCohorts, selectedCohortIds, txs]);

  useEffect(() => {
    setUiState((current) => ({
      ...current,
      retentionInputs: autoRetention.map((autoMonth) => {
        const existing = current.retentionInputs.find((item) => item.month === autoMonth.month);
        return existing?.source === "manual"
          ? { ...autoMonth, value: inputString(existing.value), source: "manual" }
          : autoMonth;
      }),
    }));
  }, [autoRetention, setUiState]);

  useEffect(() => {
    const autoFillKey = Array.from(selectedCohortIds).sort().join("|");
    if (autoFillKey === lastAutoFillKey && rawTrialPriceSelection && rawSubscriptionPriceSelection && rawUpsellValueSelection) return;
    const nextTrialSelection = defaultPriceSelection(priceOptions.trialOptions);
    const nextSubscriptionSelection = defaultPriceSelection(priceOptions.subscriptionOptions);
    const nextUpsellSelection = defaultPriceSelection(priceOptions.upsellOptions);
    setUiState((current) => {
      const currentInputs = { ...DEFAULT_FORECAST_INPUTS, ...current.forecastInputs };
      const nextTrialPrice = resolveSelectedPrice(
        priceOptions.trialOptions,
        nextTrialSelection,
        parseNumberInput(currentInputs.trialPrice),
        DEFAULT_TRIAL_PRICE,
      );
      const nextSubscriptionPrice = resolveSelectedPrice(
        priceOptions.subscriptionOptions,
        nextSubscriptionSelection,
        parseNumberInput(currentInputs.subscriptionPrice),
        DEFAULT_SUBSCRIPTION_PRICE,
      );
      const nextUpsellValue = resolveSelectedPrice(
        priceOptions.upsellOptions,
        nextUpsellSelection,
        parseNumberInput(currentInputs.upsellValue),
        DEFAULT_UPSELL_VALUE,
        "transactions",
      );
      return {
        ...current,
        lastAutoFillKey: autoFillKey,
        trialPriceSelection: nextTrialSelection,
        subscriptionPriceSelection: nextSubscriptionSelection,
        upsellValueSelection: nextUpsellSelection,
        forecastInputs: {
          ...currentInputs,
          trialPrice: String(round2(nextTrialPrice)),
          subscriptionPrice: String(round2(nextSubscriptionPrice)),
          upsellRate: String(round2(actualSummary.upsellRate)),
          upsellValue: String(round2(nextUpsellValue)),
          refundRate: String(round2(actualSummary.refundRate)),
        },
      };
    });
  }, [
    actualSummary.upsellRate,
    actualSummary.refundRate,
    lastAutoFillKey,
    priceOptions.subscriptionOptions,
    priceOptions.trialOptions,
    priceOptions.upsellOptions,
    rawSubscriptionPriceSelection,
    rawTrialPriceSelection,
    rawUpsellValueSelection,
    selectedCohortIds,
    setUiState,
  ]);

  const forecastRows = useMemo(
    () => buildForecastRows(actualSummary.trialUsers, cacState.cac, retentionInputs, normalizedForecastInputs),
    [actualSummary.trialUsers, cacState.cac, normalizedForecastInputs, retentionInputs],
  );

  const forecastOutput = useMemo(() => {
    const row3 = forecastRows[2] ?? null;
    const row6 = forecastRows[5] ?? null;
    const row12 = forecastRows[11] ?? null;
    return { row3, row6, row12 };
  }, [forecastRows]);

  const setForecastInput = (key: keyof ForecastInputs, value: string) => {
    setUiState((current) => ({
      ...current,
      forecastInputs: { ...DEFAULT_FORECAST_INPUTS, ...current.forecastInputs, [key]: stripExtraLeadingZero(value) },
    }));
  };

  const commitForecastInput = (key: keyof ForecastInputs) => {
    setUiState((current) => {
      const currentInputs = { ...DEFAULT_FORECAST_INPUTS, ...current.forecastInputs };
      return {
        ...current,
        forecastInputs: {
          ...currentInputs,
          [key]: String(parseNumberInput(currentInputs[key])),
        },
      };
    });
  };

  const setCacInput = (value: string) => {
    setUiState((current) => ({
      ...current,
      cacSource: "manual",
      forecastInputs: { ...DEFAULT_FORECAST_INPUTS, ...current.forecastInputs, cac: stripExtraLeadingZero(value) },
    }));
  };

  const commitCacInput = () => {
    setUiState((current) => {
      const currentInputs = { ...DEFAULT_FORECAST_INPUTS, ...current.forecastInputs };
      return {
        ...current,
        cacSource: "manual",
        forecastInputs: {
          ...currentInputs,
          cac: currentInputs.cac.trim() ? String(parseNumberInput(currentInputs.cac)) : "",
        },
      };
    });
  };

  const resetCacToActual = () => {
    setUiState((current) => ({
      ...current,
      cacSource: "actual",
      forecastInputs: {
        ...DEFAULT_FORECAST_INPUTS,
        ...current.forecastInputs,
        cac: "",
      },
    }));
  };

  const setPriceSelection = (
    field: "trialPrice" | "subscriptionPrice" | "upsellValue",
    selectionKey: "trialPriceSelection" | "subscriptionPriceSelection" | "upsellValueSelection",
    selection: PriceSelection,
    options: ForecastPriceOption[],
    fallbackPrice: number,
    weightBy: "users" | "transactions" = "users",
  ) => {
    setUiState((current) => {
      const currentInputs = { ...DEFAULT_FORECAST_INPUTS, ...current.forecastInputs };
      const currentValue = inputString(currentInputs[field]);
      const resolvedPrice = resolveSelectedPrice(options, selection, parseNumberInput(currentValue), fallbackPrice, weightBy);
      return {
        ...current,
        [selectionKey]: selection,
        forecastInputs: {
          ...currentInputs,
          [field]: selection === "custom" ? currentValue : String(round2(resolvedPrice)),
        },
      };
    });
  };

  const resetForecastActuals = () => {
    const nextTrialSelection = defaultPriceSelection(priceOptions.trialOptions);
    const nextSubscriptionSelection = defaultPriceSelection(priceOptions.subscriptionOptions);
    const nextUpsellSelection = defaultPriceSelection(priceOptions.upsellOptions);
    updateUiState({
      trialPriceSelection: nextTrialSelection,
      subscriptionPriceSelection: nextSubscriptionSelection,
      upsellValueSelection: nextUpsellSelection,
      cacSource: "actual",
      forecastInputs: {
        ...normalizedForecastInputs,
        cac: "",
        trialPrice: String(round2(resolveSelectedPrice(priceOptions.trialOptions, nextTrialSelection, parseNumberInput(normalizedForecastInputs.trialPrice), DEFAULT_TRIAL_PRICE))),
        subscriptionPrice: String(round2(resolveSelectedPrice(priceOptions.subscriptionOptions, nextSubscriptionSelection, parseNumberInput(normalizedForecastInputs.subscriptionPrice), DEFAULT_SUBSCRIPTION_PRICE))),
        upsellValue: String(round2(resolveSelectedPrice(priceOptions.upsellOptions, nextUpsellSelection, parseNumberInput(normalizedForecastInputs.upsellValue), DEFAULT_UPSELL_VALUE, "transactions"))),
        upsellRate: String(round2(actualSummary.upsellRate)),
        refundRate: String(round2(actualSummary.refundRate)),
      },
    });
  };

  const updateRetention = (month: number, value: string) => {
    setUiState((current) => ({
      ...current,
      retentionInputs: current.retentionInputs.map((item) =>
        item.month === month ? { ...item, value: stripExtraLeadingZero(value), source: "manual" } : item,
      ),
    }));
  };

  const commitRetention = (month: number) => {
    setUiState((current) => ({
      ...current,
      retentionInputs: current.retentionInputs.map((item) =>
        item.month === month ? { ...item, value: String(clampPercent(item.value)), source: "manual" } : item,
      ),
    }));
  };

  const resetMonthToActual = (month: number) => {
    setUiState((current) => ({
      ...current,
      retentionInputs: current.retentionInputs.map((item) => {
        if (item.month !== month) return item;
        const value = String(item.actualValue ?? item.fallbackValue);
        return { ...item, value, source: item.actualValue == null ? "auto_fallback" : "auto_actual" };
      }),
    }));
  };

  const resetAllMonths = () => {
    updateUiState({ retentionInputs: autoRetention });
  };

  const saveScenario = () => {
    const name = scenarioName.trim() || `Scenario ${new Date().toLocaleString()}`;
    const payload = {
      id: `scenario_${Date.now()}`,
      name,
      saved_at: new Date().toISOString(),
      cohort_ids: Array.from(selectedCohortIds),
      inputs: normalizedForecastInputs,
      cac_source: cacState.source,
      actual_cac: cacState.actualCac,
      forecast_spend: forecastSpend,
      retention: retentionInputs,
      outputs: forecastOutput,
    };
    try {
      const existing = JSON.parse(localStorage.getItem(SCENARIOS_STORAGE_KEY) ?? "[]");
      const list = Array.isArray(existing) ? existing : [];
      localStorage.setItem(SCENARIOS_STORAGE_KEY, JSON.stringify([payload, ...list].slice(0, 20)));
      setScenarioName("");
      setScenarioMessage(`Saved scenario: ${name}`);
    } catch {
      setScenarioMessage("Could not save scenario in localStorage.");
    }
  };

  const toggleCohortSelection = (cohortId: string) => {
    setUiState((current) => {
      const next = new Set(current.selectedCohortIds);
      if (next.has(cohortId)) next.delete(cohortId);
      else next.add(cohortId);
      return { ...current, selectedCohortIds: Array.from(next), lastAutoFillKey: "" };
    });
  };

  const selectAllFiltered = () => {
    updateUiState({ selectedCohortIds: filteredCohorts.map((cohort) => cohort.cohort_id), lastAutoFillKey: "" });
  };

  const renderPriceSelector = (
    title: string,
    field: "trialPrice" | "subscriptionPrice" | "upsellValue",
    selectionKey: "trialPriceSelection" | "subscriptionPriceSelection" | "upsellValueSelection",
    selection: PriceSelection,
    options: ForecastPriceOption[],
    fallbackPrice: number,
    weightBy: "users" | "transactions" = "users",
  ) => {
    const hasMultiplePrices = options.length > 1;
    return (
      <div className="space-y-1.5 rounded-md border border-border p-3">
        <Label className="text-xs text-muted-foreground">{title}</Label>
        <Select
          value={selection}
          onValueChange={(value) => setPriceSelection(field, selectionKey, value as PriceSelection, options, fallbackPrice, weightBy)}
        >
          <SelectTrigger className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.length === 0 && (
              <SelectItem value="default">Default ({formatCurrency(fallbackPrice)})</SelectItem>
            )}
            {options.map((option) => (
              <SelectItem key={`price:${option.price}`} value={`price:${option.price}`}>
                {formatCurrency(option.price)} — {option.users} users
              </SelectItem>
            ))}
            {hasMultiplePrices && <SelectItem value="weighted_average">Weighted average</SelectItem>}
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>
        {selection === "custom" ? (
          <Input
            {...numericInputProps()}
            value={inputString(normalizedForecastInputs[field])}
            onChange={(event) => setForecastInput(field, event.target.value)}
            onBlur={() => commitForecastInput(field)}
            onFocus={(event) => event.currentTarget.select()}
            className="h-9"
          />
        ) : (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm tabular-nums text-foreground">
            {formatCurrency(parseNumberInput(normalizedForecastInputs[field]))}
          </div>
        )}
        <div className="text-[11px] text-muted-foreground">
          Source: {priceSourceLabel(selection, options)}
        </div>
      </div>
    );
  };

  const renderPriceDiagnostics = (title: string, options: ForecastPriceOption[]) => (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 text-xs font-medium text-foreground">{title}</div>
      {options.length ? (
        <div className="space-y-1">
          {options.map((option) => (
            <div key={`${title}-${option.price}`} className="flex justify-between gap-3 text-xs">
              <span className="tabular-nums text-foreground">{formatCurrency(option.price)}</span>
              <span className="text-muted-foreground">
                {option.transactions == null ? "" : `${option.transactions} tx · `}
                {option.users} users · {formatPct(option.percentage)}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">No detected prices.</div>
      )}
    </div>
  );

  const cacSourceLabel = cacState.source === "manual" ? "Manual" : cacState.source === "actual" ? "Actual" : "Missing";
  const cacSourceClass = cacState.source === "manual" ? "text-primary" : cacState.source === "actual" ? "text-success" : "text-warning";

  return (
    <AppLayout title="Forecasting" description="Editable LTV forecast from cohort retention">
      <div className="grid gap-4 xl:grid-cols-[360px_1fr]">
        <div className="space-y-4">
          <Card className="p-4 shadow-card">
            <div className="mb-3 flex items-center gap-2">
              <Calculator className="h-4 w-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold text-foreground">Cohort selection</h3>
            </div>
            <div className="grid gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="forecast-date-from" className="text-xs text-muted-foreground">Date from</Label>
                  <Input id="forecast-date-from" type="date" value={dateFrom} onChange={(event) => updateUiState({ dateFrom: event.target.value, lastAutoFillKey: "" })} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="forecast-date-to" className="text-xs text-muted-foreground">Date to</Label>
                  <Input id="forecast-date-to" type="date" value={dateTo} onChange={(event) => updateUiState({ dateTo: event.target.value, lastAutoFillKey: "" })} className="h-9" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Campaign path</Label>
                <Select value={campaignPathFilter} onValueChange={(value) => updateUiState({ campaignPathFilter: value, lastAutoFillKey: "" })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All campaign paths</SelectItem>
                    {campaignPathOptions.map((path) => <SelectItem key={path} value={path}>{path}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Funnel group</Label>
                <Select value={funnelFilter} onValueChange={(value) => updateUiState({ funnelFilter: value, lastAutoFillKey: "" })}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All funnels</SelectItem>
                    {funnelOptions.map((funnel) => <SelectItem key={funnel} value={funnel}>{funnel}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" size="sm" onClick={selectAllFiltered}>Select visible</Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => updateUiState({ selectedCohortIds: [], lastAutoFillKey: "" })}>Use filtered</Button>
                <Button type="button" variant="ghost" size="sm" onClick={resetUiState}>Reset filters</Button>
              </div>
              <div className="max-h-72 overflow-auto rounded-md border border-border">
                {filteredCohorts.map((cohort) => (
                  <label key={cohort.cohort_id} className="flex cursor-pointer items-start gap-2 border-b border-border/60 px-3 py-2 last:border-b-0 hover:bg-muted/30">
                    <Checkbox checked={selectedIds.has(cohort.cohort_id)} onCheckedChange={() => toggleCohortSelection(cohort.cohort_id)} />
                    <span className="min-w-0 text-xs">
                      <span className="block truncate font-medium text-foreground">{cohort.campaign_path}</span>
                      <span className="text-muted-foreground">{cohort.cohort_date} · {cohort.trial_users} trials</span>
                    </span>
                  </label>
                ))}
                {filteredCohorts.length === 0 && (
                  <div className="p-4 text-center text-sm text-muted-foreground">No cohorts match filters.</div>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                If no boxes are checked, the forecast uses all filtered cohorts.
              </p>
            </div>
          </Card>

          <Card className="p-4 shadow-card">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Forecast inputs</h3>
              <Button type="button" variant="ghost" size="sm" onClick={resetForecastActuals}>
                <RotateCcw className="h-3.5 w-3.5" />
                Reset actuals
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {renderPriceSelector(
                "Trial Price",
                "trialPrice",
                "trialPriceSelection",
                trialPriceSelection as PriceSelection,
                priceOptions.trialOptions,
                DEFAULT_TRIAL_PRICE,
              )}
              {renderPriceSelector(
                "Subscription Price",
                "subscriptionPrice",
                "subscriptionPriceSelection",
                subscriptionPriceSelection as PriceSelection,
                priceOptions.subscriptionOptions,
                DEFAULT_SUBSCRIPTION_PRICE,
              )}
              {renderPriceSelector(
                "Upsell Value",
                "upsellValue",
                "upsellValueSelection",
                upsellValueSelection as PriceSelection,
                priceOptions.upsellOptions,
                DEFAULT_UPSELL_VALUE,
                "transactions",
              )}
              <div className="rounded-md border border-border p-3 sm:col-span-2">
                <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
                  <div className="min-w-0 space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor="forecast-cac" className="text-xs text-muted-foreground">CAC</Label>
                      <span className={`rounded-full bg-muted/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${cacSourceClass}`}>
                        {cacSourceLabel}
                      </span>
                    </div>
                    <div className="relative">
                      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                      <Input
                        id="forecast-cac"
                        {...numericInputProps()}
                        value={cacInputValue}
                        onChange={(event) => setCacInput(event.target.value)}
                        onBlur={commitCacInput}
                        onFocus={(event) => event.currentTarget.select()}
                        placeholder="No CAC data from traffic"
                        className="h-9 pl-7 tabular-nums"
                      />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-9 w-full whitespace-nowrap px-3 text-xs md:w-auto"
                    onClick={resetCacToActual}
                  >
                    Reset to actual CAC
                  </Button>
                </div>
                <div className="mt-1.5 truncate text-[11px] text-muted-foreground">
                  {cacState.actualCac == null ? "No CAC data from traffic" : `Actual ${formatCurrency(cacState.actualCac)}`}
                </div>
              </div>
              {[
                ["upsellRate", "Upsell Rate %"],
                ["refundRate", "Refund Rate %"],
                ["stripeFee", "Stripe Fee %"],
                ["fbFee", "FB Fee %"],
              ].map(([key, label]) => (
                <div key={key} className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">{label}</Label>
                  <Input
                    {...numericInputProps()}
                    value={inputString(normalizedForecastInputs[key as keyof ForecastInputs])}
                    onChange={(event) => setForecastInput(key as keyof ForecastInputs, event.target.value)}
                    onBlur={() => commitForecastInput(key as keyof ForecastInputs)}
                    onFocus={(event) => event.currentTarget.select()}
                    className="h-9"
                  />
                </div>
              ))}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {renderPriceDiagnostics("Trial Price options", priceOptions.trialOptions)}
              {renderPriceDiagnostics("Subscription Price options", priceOptions.subscriptionOptions)}
              {renderPriceDiagnostics("Upsell Value options", priceOptions.upsellOptions)}
            </div>
          </Card>
        </div>

        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <KpiCard label="Trial Users" value={String(actualSummary.trialUsers)} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Actual Spend" value={actualSummary.hasActualSpend ? formatCurrency(actualSummary.spend) : "—"} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Forecast Spend" value={forecastSpend == null ? "—" : formatCurrency(forecastSpend)} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Net Rev" value={formatCurrency(actualSummary.netRevenue)} icon={<TrendingUp className="h-4 w-4" />} accent="success" />
            <KpiCard label="CAC" value={cacState.cac == null ? "—" : formatCurrency(cacState.cac)} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Gross Rev" value={formatCurrency(actualSummary.grossRevenue)} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Rev D7" value={formatCurrency(actualSummary.revD7)} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Rev 1M" value={formatCurrency(actualSummary.rev1M)} icon={<TrendingUp className="h-4 w-4" />} />
            <KpiCard label="Rev 2M" value={formatCurrency(actualSummary.rev2M)} icon={<TrendingUp className="h-4 w-4" />} />
          </div>

          <Card className="p-4 shadow-card">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-foreground">Retention curve editor</h3>
                <p className="text-xs text-muted-foreground">
                  Absolute retention from original trial users. Subscription and renewal payments only.
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={resetAllMonths}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset all months
                </Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {retentionInputs.map((month) => (
                <div key={month.month} className="rounded-md border border-border p-2">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <Label className="text-xs font-medium text-foreground">M{month.month}</Label>
                    <span className={`text-[11px] ${sourceClass(month.source)}`}>{sourceLabel(month.source)}</span>
                  </div>
                  <div className="flex gap-2">
                    <Input
                      {...numericInputProps()}
                      value={inputString(month.value)}
                      onChange={(event) => updateRetention(month.month, event.target.value)}
                      onBlur={() => commitRetention(month.month)}
                      onFocus={(event) => event.currentTarget.select()}
                      className="h-8"
                    />
                    <Button type="button" variant="ghost" size="sm" className="h-8 px-2" onClick={() => resetMonthToActual(month.month)}>
                      Reset
                    </Button>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Actual {month.actualValue == null ? "—" : formatPct(month.actualValue)} · fallback {formatPct(month.fallbackValue)}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card className="p-4 shadow-card">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">Forecast results</h3>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={scenarioName}
                  onChange={(event) => setScenarioName(event.target.value)}
                  placeholder="Scenario name"
                  className="h-8 w-[180px]"
                />
                <Button type="button" size="sm" onClick={saveScenario}>
                  <Save className="h-3.5 w-3.5" />
                  Save scenario
                </Button>
              </div>
            </div>
            {scenarioMessage && <div className="mb-3 text-xs text-primary">{scenarioMessage}</div>}
            <div className="grid gap-3 md:grid-cols-3">
              {[
                ["3M", forecastOutput.row3],
                ["6M", forecastOutput.row6],
                ["12M", forecastOutput.row12],
              ].map(([label, row]) => {
                const typedRow = row as MonthlyForecastRow | null;
                return (
                  <div key={label as string} className="rounded-md border border-border p-3">
                    <div className="text-xs font-medium text-muted-foreground">{label as string}</div>
                    <dl className="mt-2 space-y-1 text-sm">
                      <div className="flex justify-between gap-3"><dt>LTV</dt><dd className="tabular-nums">{formatCurrency(typedRow?.cumulativeLtv ?? 0)}</dd></div>
                      <div className="flex justify-between gap-3"><dt>Revenue</dt><dd className="tabular-nums">{formatCurrency(typedRow?.cumulativeNetRevenue ?? 0)}</dd></div>
                      <div className="flex justify-between gap-3"><dt>Profit</dt><dd className="tabular-nums">{formatCurrency(typedRow?.cumulativeProfit ?? 0)}</dd></div>
                      <div className="flex justify-between gap-3"><dt>ROAS</dt><dd className="tabular-nums">{typedRow?.roas == null ? "—" : `${typedRow.roas.toFixed(2)}x`}</dd></div>
                    </dl>
                  </div>
                );
              })}
            </div>
          </Card>

          <Card className="p-4 shadow-card">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-foreground">Monthly forecast table</h3>
              <p className="text-xs text-muted-foreground">
                Campaign path: {actualSummary.campaignPaths || "—"} · Cohorts selected: {effectiveSelectedCohorts.length}
              </p>
            </div>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Retention %</TableHead>
                    <TableHead className="text-right">Paying Users</TableHead>
                    <TableHead className="text-right">Subscription Revenue</TableHead>
                    <TableHead className="text-right">Cumulative Gross Revenue</TableHead>
                    <TableHead className="text-right">Cumulative Net Revenue</TableHead>
                    <TableHead className="text-right">Projected Spend</TableHead>
                    <TableHead className="text-right">Cumulative LTV</TableHead>
                    <TableHead className="text-right">Cumulative Profit</TableHead>
                    <TableHead className="text-right">ROAS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {forecastRows.map((row) => (
                    <TableRow key={row.month}>
                      <TableCell>M{row.month}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatPct(row.retention)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.payingUsers.toFixed(1)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(row.subscriptionRevenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(row.cumulativeGrossRevenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(row.cumulativeNetRevenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.projectedSpend == null ? "—" : formatCurrency(row.projectedSpend)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(row.cumulativeLtv)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatCurrency(row.cumulativeProfit)}</TableCell>
                      <TableCell className="text-right tabular-nums">{row.roas == null ? "—" : `${row.roas.toFixed(2)}x`}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
