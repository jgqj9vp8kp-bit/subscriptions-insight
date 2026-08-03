// Project mode (P5, read-only) — portfolio payback for one source window.
//
// Composition, not new math: two windowed fetches (cohorts list + spend ledger)
// → the pure resolver (P3) → the pure aggregator (P1) → this render. Funnel
// selection here is SCOPING — it moves spend between in-project and
// out-of-project without touching any assumption; editing (budgets, cadences,
// commissions, overrides) is the next phase. The window ledger is always
// reconciled in full; the P&L consumes only the scoped subset.
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Info, RefreshCw } from "lucide-react";
import { KpiCard } from "@/components/KpiCard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FunnelMultiSelect } from "@/components/forecasting/FunnelMultiSelect";
import { ProjectCashFlowChart } from "@/components/forecasting/ProjectCashFlowChart";
import { ProjectFunnelTable } from "@/components/forecasting/ProjectFunnelTable";
import { type ProjectEntryEdits } from "@/components/forecasting/ProjectFunnelRowDetail";
import { ProjectExcludedPanel } from "@/components/forecasting/ProjectExcludedPanel";
import { exportProjectTable } from "@/services/projectExport";
import { fmtInt, fmtMoney, fmtPctValue, fmtRatio } from "@/components/forecasting/forecastFormat";
import { loadProjectSeedData, type ProjectSeedData } from "@/services/projectForecastSeeding";
import {
  buildProjectEntries,
  buildProjectForecastSnapshot,
  diffProjectFrozen,
  projectExtrapolationSummary,
  replayProjectForecast,
  resolveProject,
  runResolvedProject,
  spendGroupKey,
  workbookGlobalDefaults,
  type ProjectAggregationPolicy,
  type ProjectFrozenDiff,
  type ProjectForecast,
  type ProjectFunnelEntry,
  type ResolvedProject,
  type SharedCostPool,
  type SpendBasisMode,
  type SpendGroup,
} from "@/services/funnelEconomics";
import {
  deleteProjectForecast,
  duplicateProjectForecast,
  listProjectForecasts,
  loadProjectForecast,
  saveProjectForecast,
  type ProjectForecastListItem,
} from "@/services/projectForecasts";

function parseNum(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(/[\s,]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

type ProrationMode = SharedCostPool["proration"]["mode"];

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

type ViewMode =
  | { kind: "live" }
  | { kind: "replay"; saved: ProjectForecast; resolved: ResolvedProject; shareDrift: string[] }
  | { kind: "archived"; saved: ProjectForecast; reason: string };

interface PendingRefresh {
  saved: ProjectForecast;
  freshData: ProjectSeedData;
  freshResolved: ResolvedProject;
  diff: ProjectFrozenDiff;
}

/** Map saved lineage entries back onto the edit-string model, so "Apply
 * refresh" drops the operator into live mode with every prior choice intact. */
function editsFromEntries(entries: ProjectFunnelEntry[]): { edits: Record<string, ProjectEntryEdits>; deselected: Set<string> } {
  const edits: Record<string, ProjectEntryEdits> = {};
  const deselected = new Set<string>();
  for (const entry of entries) {
    if (!entry.enabled) deselected.add(entry.funnelId);
    const seeds = entry.manualSeeds;
    const survival = seeds.survival;
    edits[entry.funnelId] = {
      plannedBudget: String(entry.plannedBudget),
      manualCpa: seeds.targetCpa !== undefined ? String(seeds.targetCpa) : undefined,
      cadence: entry.cadence,
      cadenceConfirmed: entry.cadenceConfirmed,
      bonusEnabled: entry.bonusEnabled,
      trialPrice: seeds.trialPrice !== undefined ? String(seeds.trialPrice) : undefined,
      periodPrice: seeds.periodPrice !== undefined ? String(seeds.periodPrice) : undefined,
      firstPaidCrPct: survival && survival.length >= 2 ? (survival[1] * 100).toFixed(2) : undefined,
      renewalCrPct: survival && survival.length >= 3 && survival[1] > 0 ? ((survival[2] / survival[1]) * 100).toFixed(2) : undefined,
    };
  }
  return { edits, deselected };
}

export function ProjectMode() {
  const defaultWindow = useMemo(previousMonthWindow, []);
  const [fromInput, setFromInput] = useState(defaultWindow.from);
  const [toInput, setToInput] = useState(defaultWindow.to);
  // Pinned once per mount: the maturity gate depends on it, and it is what a
  // saved project will persist as source.asOf.
  const [asOf] = useState(() => new Date().toISOString());
  const [seed, setSeed] = useState<SeedState>({ kind: "idle" });
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(new Set());
  // P6 edits — raw input strings, parsed at resolve time; reset on window reload.
  const [entryEdits, setEntryEdits] = useState<Record<string, ProjectEntryEdits>>({});
  const [spendBasis, setSpendBasis] = useState<SpendBasisMode>("full_funnel_spend");
  const [commissionByGroup, setCommissionByGroup] = useState<Record<string, string>>({});
  const [prorationMode, setProrationMode] = useState<ProrationMode>("calendar_prorated");
  const [prorationManual, setProrationManual] = useState("");
  // P7 persistence state.
  const [viewMode, setViewMode] = useState<ViewMode>({ kind: "live" });
  const [savedList, setSavedList] = useState<ProjectForecastListItem[]>([]);
  const [selectedSavedId, setSelectedSavedId] = useState("");
  const [saveName, setSaveName] = useState("");
  const [persistBusy, setPersistBusy] = useState(false);
  const [persistNote, setPersistNote] = useState<string | null>(null);
  const [pendingRefresh, setPendingRefresh] = useState<PendingRefresh | null>(null);
  const loadGenRef = useRef(0);

  const refreshSavedList = useCallback(() => {
    listProjectForecasts().then(setSavedList).catch(() => setSavedList([]));
  }, []);
  useEffect(() => { refreshSavedList(); }, [refreshSavedList]);

  const load = useCallback((window: { from: string; to: string }) => {
    const generation = ++loadGenRef.current;
    setSeed({ kind: "loading" });
    setDeselected(new Set());
    setEntryEdits({});
    setCommissionByGroup({});
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

  // Deferred so typing in a budget/CPA/commission field never janks the table —
  // the resolve re-runs against the settled value.
  const deferredEdits = useDeferredValue(entryEdits);
  const deferredCommissions = useDeferredValue(commissionByGroup);

  const policy = useMemo<ProjectAggregationPolicy>(() => {
    const manual: Record<string, number> = {};
    for (const [key, raw] of Object.entries(deferredCommissions)) {
      const pct = parseNum(raw);
      if (pct !== undefined && pct >= 0 && pct < 100) manual[key] = pct / 100;
    }
    return { ...P5_POLICY, spendBasis, manualCommissionByGroup: manual };
  }, [spendBasis, deferredCommissions]);

  const sharedCosts = useMemo<SharedCostPool>(() => ({
    ...defaultSharedCosts(),
    proration: prorationMode === "manual"
      ? { mode: "manual", manualAmount: parseNum(prorationManual) ?? 0 }
      : { mode: prorationMode },
  }), [prorationMode, prorationManual]);

  const project = useMemo(() => {
    if (seed.kind !== "ready") return null;
    const horizonByCadence = workbookGlobalDefaults().horizonByCadence;
    const entries = buildProjectEntries({
      rows: seed.data.rows,
      funnelLedgers: seed.data.funnelLedgers,
      policy,
    }).map((entry) => {
      const edits = deferredEdits[entry.funnelId] ?? {};
      const cadence = edits.cadence ?? entry.cadence;
      const budget = parseNum(edits.plannedBudget);
      const manualCpa = parseNum(edits.manualCpa);
      const trialPrice = parseNum(edits.trialPrice);
      const periodPrice = parseNum(edits.periodPrice);
      const firstPaidCr = parseNum(edits.firstPaidCrPct);
      const renewalCr = parseNum(edits.renewalCrPct);
      const manualSeeds = { ...entry.manualSeeds };
      if (manualCpa !== undefined) manualSeeds.targetCpa = manualCpa;
      if (trialPrice !== undefined) manualSeeds.trialPrice = trialPrice;
      if (periodPrice !== undefined) manualSeeds.periodPrice = periodPrice;
      // Retention escape hatch: [1, c1] or [1, c1, c1×c2]; the extrapolation
      // policy grows the tail. This is what unblocks young funnels whose
      // mature cohorts cannot show a first billing period yet.
      if (firstPaidCr !== undefined && firstPaidCr > 0) {
        const c1 = firstPaidCr / 100;
        manualSeeds.survival = renewalCr !== undefined && renewalCr > 0
          ? [1, c1, c1 * (renewalCr / 100)]
          : [1, c1];
      }
      return {
        ...entry,
        enabled: !deselected.has(entry.funnelId),
        cadence,
        // A cadence change re-derives the horizon, or weekly would keep the
        // monthly 12 periods (= 84 days) and silently truncate the forecast.
        horizonPeriods: cadence === entry.cadence ? entry.horizonPeriods : horizonByCadence[cadence] ?? entry.horizonPeriods,
        cadenceConfirmed: edits.cadenceConfirmed ?? entry.cadenceConfirmed,
        bonusEnabled: edits.bonusEnabled ?? entry.bonusEnabled,
        plannedBudget: budget ?? entry.plannedBudget,
        manualSeeds,
      };
    });
    const resolved = resolveProject({
      window: seed.data.window,
      asOf,
      rows: seed.data.rows,
      windowLedger: seed.data.windowLedger,
      funnelLedgers: seed.data.funnelLedgers,
      entries,
      sharedCosts,
      policy,
    });
    return { resolved, run: runResolvedProject(resolved) };
  }, [seed, deselected, deferredEdits, asOf, sharedCosts, policy]);

  const onEntryEdit = useCallback((funnelId: string, patch: Partial<ProjectEntryEdits>) => {
    setEntryEdits((current) => ({ ...current, [funnelId]: { ...current[funnelId], ...patch } }));
  }, []);

  /** Unresolved commission groups from the RAW seed (before manual assignment),
   * deduped by group key with summed spend — the operator's worklist. */
  const unresolvedGroups = useMemo(() => {
    if (seed.kind !== "ready") return [];
    const byKey = new Map<string, { key: string; group: SpendGroup; spend: number }>();
    const collect = (groups: ReadonlyArray<SpendGroup>) => {
      for (const group of groups) {
        if (group.trafficCommission !== null) continue;
        const key = spendGroupKey(group);
        const existing = byKey.get(key);
        if (existing) existing.spend += group.spend;
        else byKey.set(key, { key, group, spend: group.spend });
      }
    };
    for (const ledger of Object.values(seed.data.funnelLedgers)) collect(ledger.groups);
    collect(seed.data.windowLedger.unknownFunnel.groups);
    collect(seed.data.windowLedger.otherUnallocated.groups);
    return [...byKey.values()].sort((a, b) => b.spend - a.spend);
  }, [seed]);

  const toggleFunnel = useCallback((funnelId: string) => {
    setDeselected((current) => {
      const next = new Set(current);
      if (next.has(funnelId)) next.delete(funnelId);
      else next.add(funnelId);
      return next;
    });
  }, []);

  // ---- Persistence actions (P7) ----
  const replayActive = useMemo(
    () => (viewMode.kind === "replay" ? { resolved: viewMode.resolved, run: runResolvedProject(viewMode.resolved) } : null),
    [viewMode],
  );
  const active = viewMode.kind === "replay" ? replayActive : project;
  const isReplay = viewMode.kind === "replay";

  const onSave = useCallback(() => {
    if (!project || !saveName.trim()) return;
    setPersistBusy(true);
    setPersistNote(null);
    const snapshot = buildProjectForecastSnapshot({
      resolved: project.resolved,
      name: saveName.trim(),
      now: new Date().toISOString(),
    });
    saveProjectForecast(snapshot)
      .then((id) => {
        setPersistNote(`Saved "${snapshot.name}".`);
        setSelectedSavedId(id);
        setSaveName("");
        refreshSavedList();
      })
      .catch((error) => setPersistNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setPersistBusy(false));
  }, [project, saveName, refreshSavedList]);

  const onLoadSaved = useCallback((id: string) => {
    if (!id) return;
    setPersistBusy(true);
    setPersistNote(null);
    setPendingRefresh(null);
    loadProjectForecast(id)
      .then((saved) => {
        const replay = replayProjectForecast(saved);
        if (replay.kind === "archived") {
          setViewMode({ kind: "archived", saved, reason: replay.reason });
        } else {
          setViewMode({ kind: "replay", saved, resolved: replay.resolved, shareDrift: replay.shareDrift });
        }
      })
      .catch((error) => setPersistNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setPersistBusy(false));
  }, []);

  const onDeleteSaved = useCallback((id: string) => {
    if (!id) return;
    setPersistBusy(true);
    deleteProjectForecast(id)
      .then(() => {
        setPersistNote("Deleted.");
        setSelectedSavedId("");
        if (viewMode.kind !== "live") setViewMode({ kind: "live" });
        refreshSavedList();
      })
      .catch((error) => setPersistNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setPersistBusy(false));
  }, [refreshSavedList, viewMode.kind]);

  const onDuplicateSaved = useCallback((id: string) => {
    if (!id) return;
    setPersistBusy(true);
    duplicateProjectForecast(id, new Date().toISOString())
      .then(() => { setPersistNote("Duplicated."); refreshSavedList(); })
      .catch((error) => setPersistNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setPersistBusy(false));
  }, [refreshSavedList]);

  /** Re-fetch the saved window, re-resolve with the SAVED lineage, and stage the
   * field-level diff. Nothing is overwritten until Apply. */
  const onRefreshFromSources = useCallback(() => {
    if (viewMode.kind !== "replay") return;
    const { saved } = viewMode;
    setPersistBusy(true);
    setPersistNote(null);
    loadProjectSeedData(saved.source.window)
      .then((freshData) => {
        const freshResolved = resolveProject({
          window: saved.source.window,
          asOf: new Date().toISOString(),
          rows: freshData.rows,
          windowLedger: freshData.windowLedger,
          funnelLedgers: freshData.funnelLedgers,
          entries: saved.entries,
          sharedCosts: saved.sharedCosts,
          policy: saved.policy,
        });
        const frozenMap: ProjectForecast["frozen"] = {};
        for (const resolution of freshResolved.resolutions) {
          if (resolution.frozen) frozenMap[resolution.entry.funnelId] = resolution.frozen;
        }
        setPendingRefresh({ saved, freshData, freshResolved, diff: diffProjectFrozen(saved.frozen, frozenMap) });
      })
      .catch((error) => setPersistNote(error instanceof Error ? error.message : String(error)))
      .finally(() => setPersistBusy(false));
  }, [viewMode]);

  /** Apply = drop into LIVE mode with the fresh data and every saved choice
   * mapped back onto the editors. The saved row itself is untouched. */
  const onApplyRefresh = useCallback(() => {
    if (!pendingRefresh) return;
    const { saved, freshData } = pendingRefresh;
    const mapped = editsFromEntries(saved.entries);
    setFromInput(saved.source.window.from);
    setToInput(saved.source.window.to);
    setSpendBasis(saved.policy.spendBasis);
    setProrationMode(saved.sharedCosts.proration.mode);
    setProrationManual(saved.sharedCosts.proration.manualAmount != null ? String(saved.sharedCosts.proration.manualAmount) : "");
    setCommissionByGroup(Object.fromEntries(
      Object.entries(saved.policy.manualCommissionByGroup ?? {}).map(([key, value]) => [key, String(value * 100)]),
    ));
    setEntryEdits(mapped.edits);
    setDeselected(mapped.deselected);
    setSeed({ kind: "ready", data: freshData });
    setPendingRefresh(null);
    setViewMode({ kind: "live" });
    setPersistNote(`Refreshed "${saved.name}" against fresh data — now editing live; save under a new name to keep it.`);
  }, [pendingRefresh]);


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
    const source = viewMode.kind === "replay" ? replayActive : project;
    if (!source) return null;
    const blocked = source.resolved.resolutions.filter((r) => r.status.kind === "blocked" && r.entry.enabled);
    if (blocked.length === 0) return null;
    const excludedSpend = blocked.reduce((sum, r) => sum + (r.ledger?.funnelResolvedSpend ?? 0), 0);
    return { count: blocked.length, excludedSpend };
  }, [project, replayActive, viewMode.kind]);

  const totals = active?.run.totals ?? null;
  const provisional = active?.resolved.provisional ?? null;
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
          {project && viewMode.kind === "live" && (
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

        {/* -------- Saved projects (P7) -------- */}
        <div className="mt-3 flex flex-wrap items-end gap-2 border-t pt-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Saved projects</Label>
            <Select value={selectedSavedId} onValueChange={setSelectedSavedId}>
              <SelectTrigger className="h-8 w-72"><SelectValue placeholder={savedList.length ? "Choose…" : "None saved yet"} /></SelectTrigger>
              <SelectContent>
                {savedList.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name} · {item.source_window_from}…{item.source_window_to}
                    {item.provisional_reasons.length > 0 ? " ᵖ" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button variant="outline" size="sm" className="h-8" disabled={!selectedSavedId || persistBusy} onClick={() => onLoadSaved(selectedSavedId)}>Load</Button>
          <Button variant="outline" size="sm" className="h-8" disabled={!selectedSavedId || persistBusy} onClick={() => onDuplicateSaved(selectedSavedId)}>Duplicate</Button>
          <Button variant="outline" size="sm" className="h-8 text-destructive" disabled={!selectedSavedId || persistBusy} onClick={() => onDeleteSaved(selectedSavedId)}>Delete</Button>
          {viewMode.kind === "live" && project && (
            <>
              <div className="ml-4 space-y-1">
                <Label className="text-xs text-muted-foreground">Save current as</Label>
                <Input className="h-8 w-60" placeholder={`July acquisition cohort`} value={saveName} onChange={(event) => setSaveName(event.target.value)} />
              </div>
              <Button size="sm" className="h-8" disabled={!saveName.trim() || persistBusy} onClick={onSave}>Save</Button>
            </>
          )}
          {viewMode.kind !== "live" && (
            <Button variant="outline" size="sm" className="h-8" onClick={() => { setViewMode({ kind: "live" }); setPendingRefresh(null); }}>Back to live</Button>
          )}
          {persistNote && <span className="pb-1.5 text-xs text-muted-foreground">{persistNote}</span>}
        </div>
      </Card>

      {viewMode.kind === "archived" && (
        <Card className="border-warning/50 p-4 text-sm">
          <p className="font-medium">“{viewMode.saved.name}” is an archived snapshot.</p>
          <p className="mt-1 text-xs text-muted-foreground">{viewMode.reason} The numbers cannot be replayed by the current engine; re-resolve against fresh data to continue.</p>
        </Card>
      )}

      {viewMode.kind === "replay" && (
        <Card className="border-primary/40 bg-primary/5 p-4 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-medium">Saved snapshot “{viewMode.saved.name}”</span>
            <span className="text-muted-foreground">window {viewMode.saved.source.window.from}…{viewMode.saved.source.window.to} · resolved {viewMode.saved.resolvedAt.slice(0, 10)} · replayed with zero network</span>
            <Button variant="outline" size="sm" className="h-7" disabled={persistBusy} onClick={onRefreshFromSources}>
              <RefreshCw className={persistBusy ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
              Refresh from sources
            </Button>
          </div>
          {viewMode.shareDrift.length > 0 && (
            <p className="mt-2 text-destructive">⚠ Share drift detected — the saved row is internally inconsistent: {viewMode.shareDrift.join("; ")}</p>
          )}
        </Card>
      )}

      {pendingRefresh && (
        <Card className="border-warning/50 p-4">
          <h3 className="text-sm font-semibold">Refresh diff — nothing is overwritten until you apply</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Fresh resolve of “{pendingRefresh.saved.name}” against today’s data: {pendingRefresh.diff.unchangedCount} funnels unchanged, {pendingRefresh.diff.funnels.length} differ.
          </p>
          <div className="mt-2 max-h-56 space-y-1.5 overflow-auto text-xs">
            {pendingRefresh.diff.funnels.map((funnel) => (
              <div key={funnel.funnelId} className="rounded border border-border/60 px-2 py-1.5">
                <span className="font-medium">{funnel.funnelId}</span>
                <span className="ml-2 text-muted-foreground">{funnel.kind}</span>
                {funnel.headline.length > 0 && (
                  <span className="ml-2 text-muted-foreground">
                    {funnel.headline.map((change) => `${change.label}: ${change.before} → ${change.after}`).join(" · ")}
                  </span>
                )}
                {funnel.kind === "changed" && funnel.headline.length === 0 && (
                  <span className="ml-2 text-muted-foreground">{funnel.changedPaths.length} field(s) changed</span>
                )}
              </div>
            ))}
            {pendingRefresh.diff.funnels.length === 0 && <p className="text-muted-foreground">No differences — the saved snapshot matches fresh data.</p>}
          </div>
          <div className="mt-3 flex gap-2">
            <Button size="sm" className="h-8" onClick={onApplyRefresh}>Apply — edit live with fresh data</Button>
            <Button variant="outline" size="sm" className="h-8" onClick={() => setPendingRefresh(null)}>Keep the saved snapshot</Button>
          </div>
        </Card>
      )}

      {seed.kind === "error" && (
        <Card className="border-destructive/50 p-4 text-sm">
          <p className="flex items-center gap-2 text-destructive"><AlertTriangle className="h-4 w-4 shrink-0" />{seed.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">ClickHouse may be waking from idle — retry usually succeeds.</p>
        </Card>
      )}
      {seed.kind === "loading" && !project && (
        <Card className="p-6 text-center text-sm text-muted-foreground">Loading window data…</Card>
      )}

      {active && totals && (
        <>
          {/* -------- Project settings (P6; live mode only — a replayed snapshot
               is immutable, Refresh from sources is the editing path) -------- */}
          {!isReplay && (
          <Card className="p-4 shadow-card">
            <h3 className="mb-3 text-sm font-semibold">Project settings</h3>
            <div className="flex flex-wrap items-end gap-4">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Spend basis</Label>
                <Select value={spendBasis} onValueChange={(value) => setSpendBasis(value as SpendBasisMode)}>
                  <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="full_funnel_spend">Full funnel spend</SelectItem>
                    <SelectItem value="attributed_only">Attributed only (provisional)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Shared-cost pool ({fmtMoney(active.resolved.proratedPool)})</Label>
                <Select value={prorationMode} onValueChange={(value) => setProrationMode(value as ProrationMode)}>
                  <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="calendar_prorated">Prorated by window days</SelectItem>
                    <SelectItem value="full_month">Full month regardless</SelectItem>
                    <SelectItem value="manual">Manual amount</SelectItem>
                    <SelectItem value="excluded">Excluded</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {prorationMode === "manual" && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Pool amount (USD)</Label>
                  <Input className="h-8 w-32" value={prorationManual} placeholder="16271.36" onChange={(event) => setProrationManual(event.target.value)} />
                </div>
              )}
            </div>
            {spendBasis === "attributed_only" && (
              <p className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                Provisional: costs include only spend attributed through converting campaigns. This is not complete project profitability.
              </p>
            )}
            {unresolvedGroups.length > 0 && (
              <div className="mt-3 space-y-2">
                <div className="flex items-center gap-3">
                  <Label className="text-xs font-medium">Traffic commissions ({unresolvedGroups.length} unresolved groups)</Label>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => setCommissionByGroup((current) => {
                      const next = { ...current };
                      for (const item of unresolvedGroups) if (!next[item.key]) next[item.key] = "4";
                      return next;
                    })}
                  >
                    Set 4% for all
                  </Button>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-2">
                  {unresolvedGroups.map((item) => (
                    <div key={item.key} className="flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">{item.group.adAccountId} {item.group.currency} · {fmtMoney(item.spend)}</span>
                      <Input
                        className="h-7 w-16 text-right"
                        placeholder="%"
                        value={commissionByGroup[item.key] ?? ""}
                        onChange={(event) => setCommissionByGroup((current) => ({ ...current, [item.key]: event.target.value }))}
                      />
                      <span className="text-muted-foreground">%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
          )}

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
              <ReconRow label="Window source spend" value={active.resolved.windowLedger.windowSourceSpend} bold />
              <ReconRow label="├ via users" value={active.resolved.windowLedger.userAttributed.spend} />
              <ReconRow label="Resolved to funnels" value={active.resolved.windowLedger.funnelResolved.spend} />
              <ReconRow label="├ no users (real cost, zero trials)" value={active.resolved.windowLedger.noUser.spend} />
              <ReconRow label="├ in project (drives the P&L)" value={active.resolved.scope.inProjectResolvedSpend} accent="text-primary" />
              <ReconRow label="Unknown funnel (in P&L by policy)" value={active.resolved.windowLedger.unknownFunnel.spend} />
              <ReconRow label="└ out of project (deselected / blocked)" value={active.resolved.scope.outOfProjectSpend} />
              <ReconRow label="Other unallocated" value={active.resolved.windowLedger.otherUnallocated.spend} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {active.resolved.windowIdentity.ok
                ? `✓ window reconciles ±$${Math.max(Math.abs(active.resolved.windowIdentity.sourceDelta), Math.abs(active.resolved.windowIdentity.resolvedDelta)).toFixed(2)}`
                : "⛔ window does NOT reconcile — spend figures are untrustworthy"}
              {" · "}project-scoped {fmtMoney(active.resolved.scope.projectScopedSpend)} · coverage {fmtPctValue(active.resolved.scope.spendCoverage, 1)}
              {active.resolved.windowLedger.spendIncomplete && ` · ⚠ known warehouse gaps overlap this window (${active.resolved.windowLedger.knownGapDays.length} days)`}
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
            {(() => {
              const exposure = projectExtrapolationSummary(active.resolved.resolutions);
              return (
                <KpiCard
                  label="Extrapolated revenue"
                  value={exposure.share == null ? "—" : fmtPctValue(exposure.share, 1)}
                  hint={`${fmtMoney(exposure.extrapolatedGross)} of ${fmtMoney(exposure.grossTotal)} projected gross rests on extrapolated retention.`}
                  accent={exposure.share != null && exposure.share > 0.5 ? "warning" : "primary"}
                />
              );
            })()}
          </div>

          {/* -------- Excluded worklist (P8) -------- */}
          <ProjectExcludedPanel resolutions={active.resolved.resolutions} />

          {/* -------- Combined curve + table -------- */}
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => void exportProjectTable(active.resolved, active.run, "csv")}>Export CSV</Button>
            <Button variant="outline" size="sm" className="h-8" onClick={() => void exportProjectTable(active.resolved, active.run, "xlsx")}>Export XLSX</Button>
          </div>
          <ProjectCashFlowChart totals={totals} />
          <ProjectFunnelTable
            resolved={active.resolved}
            run={active.run}
            onToggle={isReplay ? () => undefined : toggleFunnel}
            edits={isReplay ? {} : entryEdits}
            onEdit={isReplay ? () => undefined : onEntryEdit}
          />
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
