// Expanded funnel row (P6): seed evidence + the inputs that unblock or reshape
// this one funnel.
//
// The P3 live run showed most rows start blocked early in a month — so the
// expansion leads with exactly what the row needs (budget for no-spend funnels,
// manual CPA for mixed-currency or unresolved ones), then the seed evidence,
// then the full period table and payback chart for rows that already resolve
// (the P4-extracted components — one definition with Plan mode).
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ForecastCashFlowChart } from "@/components/forecasting/ForecastCashFlowChart";
import { ForecastPeriodTable } from "@/components/forecasting/ForecastPeriodTable";
import { fmtMoney, fmtPctValue } from "@/components/forecasting/forecastFormat";
import type { Cadence, ProjectEntryResolution } from "@/services/funnelEconomics";

export interface ProjectEntryEdits {
  plannedBudget?: string;
  manualCpa?: string;
  cadence?: Cadence;
  cadenceConfirmed?: boolean;
  bonusEnabled?: boolean;
  /** Manual seed escape hatches for blocked rows: young funnels have no
   * observable retention (the July run blocked 6 rows on retention.survival),
   * web funnels no subscription price. Percent strings, parsed at resolve. */
  trialPrice?: string;
  periodPrice?: string;
  firstPaidCrPct?: string;
  renewalCrPct?: string;
}

const CADENCE_OPTIONS: Array<{ value: Cadence; label: string }> = [
  { value: "monthly", label: "Monthly (30d)" },
  { value: "weekly", label: "Weekly (7d)" },
  { value: "quarterly", label: "Quarterly (90d)" },
];

export function ProjectFunnelRowDetail({ resolution, edits, onEdit }: {
  resolution: ProjectEntryResolution;
  edits: ProjectEntryEdits;
  onEdit: (patch: Partial<ProjectEntryEdits>) => void;
}) {
  const { entry, status, evidence, ledger } = resolution;
  const cadence = edits.cadence ?? entry.cadence;
  const seededBudget = ledger?.funnelResolvedSpend != null ? fmtMoney(ledger.funnelResolvedSpend) : "";
  const seededCpa = resolution.frozen?.assumptions.traffic.targetCpa;

  return (
    <div className="space-y-3 bg-muted/20 px-4 py-3">
      {status.kind === "blocked" && (
        <p className="text-xs text-destructive">{status.message}</p>
      )}

      {/* -------- Editors -------- */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Planned budget (USD)</Label>
          <Input
            className="h-8 w-36"
            placeholder={seededBudget || "0"}
            value={edits.plannedBudget ?? ""}
            onChange={(event) => onEdit({ plannedBudget: event.target.value })}
          />
        </div>
        {entry.kind === "forecast" && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Manual CPA (USD)</Label>
            <Input
              className="h-8 w-32"
              placeholder={seededCpa != null ? seededCpa.toFixed(2) : "—"}
              value={edits.manualCpa ?? ""}
              onChange={(event) => onEdit({ manualCpa: event.target.value })}
            />
          </div>
        )}
        {entry.kind === "forecast" && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cadence</Label>
            <Select value={cadence} onValueChange={(value) => onEdit({ cadence: value as Cadence })}>
              <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                {CADENCE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {entry.kind === "forecast" && (
          <label className="flex h-8 items-center gap-2 text-xs">
            <Switch
              checked={edits.cadenceConfirmed ?? entry.cadenceConfirmed}
              onCheckedChange={(checked) => onEdit({ cadenceConfirmed: checked })}
            />
            cadence confirmed
          </label>
        )}
        {entry.kind === "forecast" && (
          <label className="flex h-8 items-center gap-2 text-xs">
            <Switch
              checked={edits.bonusEnabled ?? entry.bonusEnabled}
              onCheckedChange={(checked) => onEdit({ bonusEnabled: checked })}
            />
            media-buyer bonus
          </label>
        )}
      </div>
      {entry.kind === "forecast" && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Trial price (USD)</Label>
            <Input className="h-8 w-28" placeholder={resolution.frozen?.assumptions.pricing.schedule.periods[0]?.price.toFixed(2) ?? "—"} value={edits.trialPrice ?? ""} onChange={(event) => onEdit({ trialPrice: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Period price (USD)</Label>
            <Input className="h-8 w-28" placeholder="—" value={edits.periodPrice ?? ""} onChange={(event) => onEdit({ periodPrice: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" title="Overrides the retention seed: survival = [1, c1, c1×c2, …] with the tail extrapolated">First-paid CR %</Label>
            <Input className="h-8 w-24" placeholder="—" value={edits.firstPaidCrPct ?? ""} onChange={(event) => onEdit({ firstPaidCrPct: event.target.value })} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Renewal CR %</Label>
            <Input className="h-8 w-24" placeholder="—" value={edits.renewalCrPct ?? ""} onChange={(event) => onEdit({ renewalCrPct: event.target.value })} />
          </div>
        </div>
      )}

      {/* -------- Seed evidence -------- */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Seed: {evidence.coverage.cohorts} cohorts · {evidence.observedTrials} trials · maturity {evidence.coverage.maturityDays}d · retention observed to c{evidence.coverage.observedRetentionDepth}</span>
        <span>CPA basis: {evidence.cpaBasis}</span>
        {ledger && (
          <span>
            Spend: resolved {fmtMoney(ledger.funnelResolvedSpend)} = users {fmtMoney(ledger.userAttributedSpend)} + no-users {fmtMoney(ledger.noUserSpend)}
            {ledger.spendCoverage != null && <> · coverage {fmtPctValue(ledger.spendCoverage, 0)}</>}
            {" · "}basis {ledger.resolutionBasis}
          </span>
        )}
      </div>
      {evidence.warnings.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {evidence.warnings.map((warning) => (
            <Badge key={warning.code} variant="outline" className="h-5 px-1.5 text-[10px] text-warning" title={warning.message}>{warning.code}</Badge>
          ))}
        </div>
      )}
      {ledger && ledger.groups.length > 0 && (
        <div className="text-xs text-muted-foreground">
          Groups: {ledger.groups.map((group) => `${group.adAccountId} ${group.currency} ${fmtMoney(group.spend)}${group.trafficCommission != null ? ` @ ${(group.trafficCommission * 100).toFixed(1)}%` : " (no commission)"}`).join(" · ")}
        </div>
      )}

      {/* -------- Full projection for resolvable rows (shared P4 components) -------- */}
      {status.kind === "ok" && resolution.result && resolution.frozen && (
        <div className="space-y-3 pt-1">
          <ForecastCashFlowChart result={resolution.result} />
          <ForecastPeriodTable result={resolution.result} provenance={resolution.frozen.provenance} />
        </div>
      )}
    </div>
  );
}
