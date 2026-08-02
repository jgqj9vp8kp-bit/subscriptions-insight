// Project mode (P5, read-only) — portfolio payback for one source window.
//
// Composition, not new math: two windowed fetches (cohorts list + spend ledger)
// → the pure resolver (P3) → the pure aggregator (P1) → this render. Funnel
// selection here is SCOPING — it moves spend between in-project and
// out-of-project without touching any assumption; editing (budgets, cadences,
// commissions, overrides) is the next phase. The window ledger is always
// reconciled in full; the P&L consumes only the scoped subset.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FunnelMultiSelect } from "@/components/forecasting/FunnelMultiSelect";
import { ProjectCashFlowChart } from "@/components/forecasting/ProjectCashFlowChart";
import { ProjectFunnelTable } from "@/components/forecasting/ProjectFunnelTable";
import { fmtInt, fmtMoney, fmtPctValue, fmtRatio } from "@/components/forecasting/forecastFormat";
import { loadProjectSeedData, type ProjectSeedData } from "@/services/projectForecastSeeding";
import {
  buildProjectEntries,
  resolveProject,
  runResolvedProject,
  workbookGlobalDefaults,
  type ProjectAggregationPolicy,
  type SharedCostPool,
} from "@/services/funnelEconomics";

/** Previous full calendar month — the natural "review the month that just ended". */
function previousMonthWindow(): { from: string; to: string } {
  const now = new Date();
  const firstOfThis = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const lastOfPrev = new Date(firstOfThis - 86_400_000);
  const firstOfPrev = Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1);
  return {
    from: new Date(firstOfPrev).toISOString().slice(0, 10),
    to: lastOfPrev.toISOString().slice(0, 10),
  };
}

const P5_POLICY: ProjectAggregationPolicy = {
  spendBasis: "full_funnel_spend",
  includeUnknownFunnelSpend: true,
  includeOtherUnallocatedSpend: true,
  allocation: { basis: "resolved_spend_share", renormalizeOverEnabled: true, includeSpendOnlyRows: true },
  dayGridStep: "period_end",
  headlinePayback: "fully_loaded",
  bonus: { kind: "per_funnel" },
  assumedCadence: "monthly",
  rounding: { mode: "full_precision" },
};

function defaultSharedCosts(): SharedCostPool {
  const defaults = workbookGlobalDefaults();
  return {
    monthly: { ...defaults.fixed },
    proration: { mode: "calendar_prorated" },
    extras: [],
  };
}

type SeedState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: ProjectSeedData };

export function ProjectMode() {
  const defaultWindow = useMemo(previousMonthWindow, []);
  const [fromInput, setFromInput] = useState(defaultWindow.from);
  const [toInput, setToInput] = useState(defaultWindow.to);
  // Pinned once per mount: the maturity gate depends on it, and it is what a
  // saved project will persist as source.asOf.
  const [asOf] = useState(() => new Date().toISOString());
  const [seed, setSeed] = useState<SeedState>({ kind: "idle" });
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  const loadGenRef = useRef(0);

  const load = useCallback((window: { from: string; to: string }) => {
    const generation = ++loadGenRef.current;
    setSeed({ kind: "loading" });
    setDeselected(new Set());
    loadProjectSeedData(window)
      .then((data) => {
        if (loadGenRef.current !== generation) return;
        setSeed({ kind: "ready", data });
      })
      .catch((error) => {
        if (loadGenRef.current !== generation) return;
        setSeed({ kind: "error", message: error instanceof Error ? error.message : String(error) });
      });
  }, []);

  useEffect(() => {
    load(defaultWindow);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only initial load
  }, []);

  const sharedCosts = useMemo(defaultSharedCosts, []);
  const project = useMemo(() => {
    if (seed.kind !== "ready") return null;
    const entries = buildProjectEntries({
      rows: seed.data.rows,
      funnelLedgers: seed.data.funnelLedgers,
      policy: P5_POLICY,
    }).map((entry) => (deselected.has(entry.funnelId) ? { ...entry, enabled: false } : entry));
    const resolved = resolveProject({
      window: seed.data.window,
      asOf,
      rows: seed.data.rows,
      windowLedger: seed.data.windowLedger,
      funnelLedgers: seed.data.funnelLedgers,
      entries,
      sharedCosts,
      policy: P5_POLICY,
    });
    return { resolved, run: runResolvedProject(resolved) };
  }, [seed, deselected, asOf, sharedCosts]);

  const toggleFunnel = useCallback((funnelId: string) => {
    setDeselected((current) => {
      const next = new Set(current);
      if (next.has(funnelId)) next.delete(funnelId);
      else next.add(funnelId);
      return next;
    });
  }, []);

  const funnelOptions = useMemo(() => {
    if (!project) return [];
    return project.resolved.resolutions.map((resolution) => ({
      id: resolution.entry.funnelId,
      label: resolution.entry.funnelId,
      hint: resolution.entry.kind === "spend_only"
        ? "spend only"
        : resolution.status.kind === "blocked" ? "blocked" : undefined,
    }));
  }, [project]);
  const selectedIds = useMemo(() => {
    if (!project) return new Set<string>();
    return new Set(project.resolved.resolutions.filter((r) => r.entry.enabled).map((r) => r.entry.funnelId));
  }, [project]);

  const blockedSummary = useMemo(() => {
    if (!project) return null;
    const blocked = project.resolved.resolutions.filter((r) => r.status.kind === "blocked" && r.entry.enabled);
    if (blocked.length === 0) return null;
    const excludedSpend = blocked.reduce((sum, r) => sum + (r.ledger?.funnelResolvedSpend ?? 0), 0);
    return { count: blocked.length, excludedSpend };
  }, [project]);

  const totals = project?.run.totals ?? null;
  const provisional = project?.resolved.provisional ?? null;
  // ᵖ marker: the value is displayable but rests on incomplete inputs.
  const provisionalMark = provisional && (provisional.spendIncomplete || provisional.attributedOnlyMode || provisional.unconfirmedCadenceBudgetShare > 0.5) ? "ᵖ" : "";

  return (
    <div className="space-y-4">
      {/* -------- Source window + selection -------- */}
      <Card className="p-4 shadow-card">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="project-from">Source period from</Label>
            <Input id="project-from" type="date" className="h-9 w-40" value={fromInput} onChange={(event) => setFromInput(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground" htmlFor="project-to">to</Label>
            <Input id="project-to" type="date" className="h-9 w-40" value={toInput} onChange={(event) => setToInput(event.target.value)} />
          </div>
          <Button className="h-9" variant="outline" disabled={seed.kind === "loading"} onClick={() => load({ from: fromInput, to: toInput })}>
            <RefreshCw className={seed.kind === "loading" ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            {seed.kind === "loading" ? "Loading…" : "Load window"}
          </Button>
          {project && (
            <FunnelMultiSelect
              label="Funnels"
              options={funnelOptions}
              selected={selectedIds}
              onToggle={toggleFunnel}
              onSelectAll={() => setDeselected(new Set())}
              onClear={() => setDeselected(new Set(funnelOptions.map((option) => option.id)))}
            />
          )}
        </div>
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          Acquisition-cohort payback from a common Day&nbsp;0 — not a calendar-month P&amp;L. Deselecting a funnel moves its spend to out-of-project; it never silently changes the remaining rows.
        </p>
      </Card>

      {seed.kind === "error" && (
        <Card className="border-destructive/50 p-4 text-sm">
          <p className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />{seed.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">ClickHouse may be waking from idle — retry usually succeeds.</p>
        </Card>
      )}
      {seed.kind === "loading" && !project && (
        <Card className="p-6 text-center text-sm text-muted-foreground">Loading window data…</Card>
      )}

      {project && totals && (
        <>
          {/* -------- Gates & provisional banners -------- */}
          {(totals.gates.length > 0 || blockedSummary) && (
            <div className="space-y-1.5">
              {blockedSummary && (
                <p className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  {blockedSummary.count} funnels need input before they can join the P&amp;L ({fmtMoney(blockedSummary.excludedSpend)} of resolved spend excluded) — see the row chips for what each needs.
                </p>
              )}
              {totals.gates.map((gate) => (
                <p key={gate.code} className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${gate.code === "window_reconciliation" || gate.code === "overhead_identity" ? "border-destructive/50 bg-destructive/10" : "border-warning/40 bg-warning/10"}`}>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {gate.message}
                </p>
              ))}
            </div>
          )}

          {/* -------- Window reconciliation -------- */}
          <Card className="p-4 shadow-card">
            <h3 className="mb-2 text-sm font-semibold">Window spend reconciliation</h3>
            <div className="grid gap-x-8 gap-y-1 text-xs sm:grid-cols-2">
              <ReconRow label="Window source spend" value={project.resolved.windowLedger.windowSourceSpend} bold />
              <ReconRow label="├ via users" value={project.resolved.windowLedger.userAttributed.spend} />
              <ReconRow label="Resolved to funnels" value={project.resolved.windowLedger.funnelResolved.spend} />
              <ReconRow label="├ no users (real cost, zero trials)" value={project.resolved.windowLedger.noUser.spend} />
              <ReconRow label="├ in project (drives the P&L)" value={project.resolved.scope.inProjectResolvedSpend} accent="text-primary" />
              <ReconRow label="Unknown funnel (in P&L by policy)" value={project.resolved.windowLedger.unknownFunnel.spend} />
              <ReconRow label="└ out of project (deselected / blocked)" value={project.resolved.scope.outOfProjectSpend} />
              <ReconRow label="Other unallocated" value={project.resolved.windowLedger.otherUnallocated.spend} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {project.resolved.windowIdentity.ok
                ? `✓ window reconciles ±$${Math.max(Math.abs(project.resolved.windowIdentity.sourceDelta), Math.abs(project.resolved.windowIdentity.resolvedDelta)).toFixed(2)}`
                : "⛔ window does NOT reconcile — spend figures are untrustworthy"}
              {" · "}project-scoped {fmtMoney(project.resolved.scope.projectScopedSpend)} · coverage {fmtPctValue(project.resolved.scope.spendCoverage, 1)}
              {project.resolved.windowLedger.spendIncomplete && ` · ⚠ known warehouse gaps overlap this window (${project.resolved.windowLedger.knownGapDays.length} days)`}
            </p>
          </Card>

          {/* -------- KPI strip -------- */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
            <KpiCard label="Scoped spend" value={fmtMoney(totals.projectScopedSpend) + provisionalMark} hint={`Coverage ${fmtPctValue(totals.spendCoverage, 1)} of window source spend.`} />
            <KpiCard label="Trials" value={fmtInt(totals.trials)} />
            <KpiCard label="Blended CPA" value={(totals.blendedCpa == null ? "—" : fmtMoney(totals.blendedCpa)) + provisionalMark} hint="Project-scoped spend / Σ trials — waste included." />
            <KpiCard label="Gross revenue" value={fmtMoney(totals.grossRevenue)} />
            <KpiCard label="Contribution" value={fmtMoney(totals.contributionProfit)} accent={totals.contributionProfit >= 0 ? "success" : "warning"} />
            <KpiCard label="Overhead pool" value={fmtMoney(totals.allocatedOverhead)} hint="Prorated shared costs, allocated by spend share across all rows." />
            <KpiCard label="Net profit" value={fmtMoney(totals.netProfit) + provisionalMark} accent={totals.netProfit >= 0 ? "success" : "warning"} />
            <KpiCard
              label="Payback (fully loaded)"
              value={totals.paybackFullyLoadedDay != null ? `D${totals.paybackFullyLoadedDay}${provisionalMark}` : totals.paybackSuppressed ? "suppressed" : "—"}
              hint={totals.paybackTrafficOnlyDay != null ? `Traffic-only: D${totals.paybackTrafficOnlyDay}.` : "Traffic-only: —."}
              accent={totals.paybackFullyLoadedDay != null ? "success" : "warning"}
            />
            <KpiCard label="ROMI" value={(totals.romi == null ? "—" : fmtRatio(totals.romi)) + provisionalMark} hint="Σ contribution / project traffic outflow." />
            <KpiCard label="ROI" value={(totals.roi == null ? "—" : fmtRatio(totals.roi)) + provisionalMark} hint="Σ net profit / (outflow + bonus + overhead + extras)." />
          </div>

          {/* -------- Combined curve + table -------- */}
          <ProjectCashFlowChart totals={totals} />
          <ProjectFunnelTable resolved={project.resolved} run={project.run} onToggle={toggleFunnel} />
        </>
      )}
    </div>
  );
}

function ReconRow({ label, value, bold, accent }: { label: string; value: number; bold?: boolean; accent?: string }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${bold ? "font-semibold" : ""}`}>
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${accent ?? ""}`}>{fmtMoney(value)}</span>
    </div>
  );
}
