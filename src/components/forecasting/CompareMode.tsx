// Compare mode — side-by-side scenario comparison with baseline deltas (v3, P5).
//
// Entries come from the Plan tab ("Add to comparison") and from saved scenarios
// (Postgres). Every entry is a frozen snapshot; results are re-computed through the
// same engine on mount (deterministic), then diffed by the pure comparison module.
import { useEffect, useMemo, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import { CartesianGrid, ComposedChart, Line, ReferenceLine, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/services/analytics";
import {
  buildScenarioComparison,
  runFrozenForecast,
  type ComparisonCell,
  type ComparisonEntry,
  type ComparisonFormat,
} from "@/services/funnelEconomics";
import { listForecastScenarios, loadForecastScenario, type ForecastScenarioListItem } from "@/services/forecastScenarios";
import {
  addCompareEntry,
  clearCompareEntries,
  loadCompareEntries,
  removeCompareEntry,
  type CompareStoreEntry,
} from "@/components/forecasting/compareStore";

const LINE_COLORS = [1, 2, 3, 4, 5, 6].map((index) => `hsl(var(--chart-${index}))`);

function formatValue(value: number | null, format: ComparisonFormat): string {
  if (value === null) return "—";
  switch (format) {
    case "currency": return formatCurrency(value);
    case "percent": return `${(value * 100).toFixed(1)}%`;
    case "days": return `day ${Math.round(value)}`;
    case "ratio": return value.toFixed(2);
    default: return Math.round(value).toLocaleString("en-US");
  }
}

function DeltaBadge({ cell }: { cell: ComparisonCell }) {
  if (cell.deltaAbs === null || cell.deltaAbs === 0) return null;
  // Float noise (|Δ| < 0.05%) would render as a meaningless "±0.0%".
  if (cell.deltaPct !== null && Math.abs(cell.deltaPct) < 0.0005) return null;
  const pct = cell.deltaPct !== null ? `${cell.deltaPct > 0 ? "+" : ""}${(cell.deltaPct * 100).toFixed(1)}%` : `${cell.deltaAbs > 0 ? "+" : ""}${cell.deltaAbs.toFixed(1)}`;
  const tone = cell.better === true ? "text-success" : cell.better === false ? "text-destructive" : "text-muted-foreground";
  return <span className={cn("ml-1.5 text-[11px] font-medium", tone)}>{pct}</span>;
}

export function CompareMode() {
  const [entries, setEntries] = useState<CompareStoreEntry[]>(() => loadCompareEntries());
  const [baselineId, setBaselineId] = useState<string>("");
  const [saved, setSaved] = useState<ForecastScenarioListItem[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [loadingSavedId, setLoadingSavedId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    listForecastScenarios()
      .then((rows) => { if (mounted) setSaved(rows); })
      .catch((error) => { if (mounted) setSavedError(error instanceof Error ? error.message : String(error)); });
    return () => { mounted = false; };
  }, []);

  // Re-run each frozen snapshot through the engine; skip (with a note) any snapshot
  // a future schema version would refuse — never render half-numbers.
  const computed = useMemo(() => {
    const valid: ComparisonEntry[] = [];
    const failed: Array<{ id: string; label: string; message: string }> = [];
    for (const entry of entries) {
      try {
        valid.push({ id: entry.id, label: entry.label, frozen: entry.frozen, result: runFrozenForecast(entry.frozen) });
      } catch (error) {
        failed.push({ id: entry.id, label: entry.label, message: error instanceof Error ? error.message : String(error) });
      }
    }
    return { valid, failed };
  }, [entries]);

  const effectiveBaseline = computed.valid.some((entry) => entry.id === baselineId)
    ? baselineId
    : computed.valid[0]?.id ?? "";
  const view = useMemo(
    () => buildScenarioComparison(computed.valid, effectiveBaseline),
    [computed.valid, effectiveBaseline],
  );

  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    computed.valid.forEach((entry, index) => {
      config[entry.id] = { label: entry.label, color: LINE_COLORS[index % LINE_COLORS.length] };
    });
    return config;
  }, [computed.valid]);

  const cashFlowData = useMemo(
    () => view.cashFlowCurve.map((point) => ({ label: point.label, ...point.values })),
    [view],
  );

  const baselineEntry = computed.valid.find((entry) => entry.id === effectiveBaseline);

  const handleAddSaved = async (id: string) => {
    setLoadingSavedId(id);
    try {
      const record = await loadForecastScenario(id);
      setEntries(addCompareEntry({
        id: `saved:${record.id}`,
        label: record.name,
        frozen: record.frozen,
        addedAt: new Date().toISOString(),
      }));
    } catch (error) {
      setSavedError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingSavedId(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="p-4 shadow-card">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">Scenarios in comparison</h3>
          <Button variant="ghost" size="sm" onClick={() => { clearCompareEntries(); setEntries([]); }}>
            <RotateCcw className="mr-1 h-3.5 w-3.5" /> Clear all
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {entries.length === 0 && (
            <span className="text-sm text-muted-foreground">Nothing here yet — build a plan on the Plan tab and press “Add to comparison”, or load a saved scenario below.</span>
          )}
          {entries.map((entry) => (
            <Badge key={entry.id} variant={entry.id === effectiveBaseline ? "default" : "outline"} className="gap-1 py-1 pl-2 pr-1 text-xs font-normal">
              {entry.id === effectiveBaseline && <span className="font-semibold">baseline ·</span>}
              {entry.label}
              <button
                type="button"
                aria-label={`Remove ${entry.label}`}
                className="rounded-full p-0.5 hover:bg-background/40"
                onClick={() => setEntries(removeCompareEntry(entry.id))}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Baseline</Label>
            <Select value={effectiveBaseline} onValueChange={setBaselineId} disabled={computed.valid.length === 0}>
              <SelectTrigger className="h-8 w-[260px]"><SelectValue placeholder="Baseline scenario" /></SelectTrigger>
              <SelectContent>
                {computed.valid.map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Add saved scenario</Label>
            <Select value="" onValueChange={handleAddSaved} disabled={saved.length === 0 || loadingSavedId !== null}>
              <SelectTrigger className="h-8 w-[260px]">
                <SelectValue placeholder={loadingSavedId ? "Loading…" : saved.length === 0 ? "No saved scenarios" : "Pick a saved scenario"} />
              </SelectTrigger>
              <SelectContent>
                {saved.map((row) => (
                  <SelectItem key={row.id} value={row.id}>{row.name} · {row.funnel_id}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {savedError && <span className="text-xs text-warning">{savedError}</span>}
          {computed.failed.map((failure) => (
            <span key={failure.id} className="text-xs text-warning">“{failure.label}” skipped: {failure.message}</span>
          ))}
        </div>
      </Card>

      {computed.valid.length >= 1 && (
        <>
          <Card className="p-4 shadow-card">
            <h3 className="mb-1 text-sm font-semibold">Cumulative payment-net vs traffic cost</h3>
            <p className="mb-2 text-xs text-muted-foreground">
              Dashed line = baseline’s traffic cash outflow{baselineEntry ? ` (${formatCurrency(baselineEntry.result.costs.trafficCashOutflow)})` : ""}. Deltas in the matrix are against the baseline.
            </p>
            <ChartContainer config={chartConfig} className="h-72 w-full">
              <ComposedChart data={cashFlowData} margin={{ left: 12, right: 12, top: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis tickLine={false} axisLine={false} fontSize={11} tickFormatter={(value: number) => formatCurrency(value)} width={90} />
                <ChartTooltip content={<ChartTooltipContent />} />
                {baselineEntry && (
                  <ReferenceLine y={baselineEntry.result.costs.trafficCashOutflow} stroke="hsl(var(--destructive))" strokeDasharray="4 4" />
                )}
                {computed.valid.map((entry) => (
                  <Line key={entry.id} type="monotone" dataKey={entry.id} name={entry.label} stroke={`var(--color-${entry.id})`} strokeWidth={2} dot={false} connectNulls={false} />
                ))}
              </ComposedChart>
            </ChartContainer>
          </Card>

          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Comparison matrix</h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Metric</TableHead>
                    {computed.valid.map((entry) => (
                      <TableHead key={entry.id} className="text-right">
                        {entry.label}{entry.id === effectiveBaseline && <span className="ml-1 text-[10px] text-muted-foreground">(baseline)</span>}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {view.rows.map((row) => (
                    <TableRow key={row.key}>
                      <TableCell className="font-medium">{row.label}</TableCell>
                      {computed.valid.map((entry) => {
                        const cell = row.cells[entry.id];
                        return (
                          <TableCell key={entry.id} className="text-right">
                            {formatValue(cell?.value ?? null, row.format)}
                            {cell && <DeltaBadge cell={cell} />}
                          </TableCell>
                        );
                      })}
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
