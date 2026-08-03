// Project persistence (P7): snapshot ⇄ replay ⇄ refresh-diff, all pure.
//
// The saved entity carries BOTH lineage (entries + sharedCosts + policy — what
// the operator chose) and the frozen per-funnel snapshots (what the engine
// replays). Reproducibility contract:
//   - replay is a pure function of the saved row: zero network, bit-identical
//     numbers (runFrozenForecast is deterministic and JSON-round-trip safe);
//   - shares and the prorated pool are baked into each frozen blob, so later
//     config changes cannot move a saved project — replay RECOMPUTES the share
//     vector from lineage and cross-checks it against the baked values,
//     surfacing any drift as a hard gate instead of a silently wrong overhead;
//   - a schema/engine version mismatch DEGRADES to an archived read-only state
//     (prepareRuntimeInputs throws, and a project holds N blobs — a version
//     bump must not brick every saved project N times over);
//   - "Refresh from sources" produces a candidate frozen map and shows a
//     field-level diff BEFORE anything is overwritten — never auto-applied.
import {
  computeOverheadShares,
  deriveProvisionalFlags,
  prorateSharedCostPool,
  scopeProjectSpend,
  verifyWindowSpendIdentity,
  PROJECT_FORECAST_SCHEMA_VERSION,
  type OverheadShareInput,
  type ProjectForecast,
} from "./funnelEconomicsProject.ts";
import type { ProjectEntryResolution, ResolvedProject } from "./projectSeeding.ts";
import { prepareRuntimeInputs } from "./funnelEconomicsStrategies.ts";
import { runFunnelEconomics } from "./funnelEconomicsEngine.ts";
import { ENGINE_VERSION, FORECAST_SCHEMA_VERSION, type FrozenForecastInputs } from "./funnelEconomicsTypes.ts";

/** Baked-vs-recomputed share tolerance: anything past float noise is drift. */
export const SHARE_DRIFT_TOLERANCE = 1e-9;

// ---- Snapshot --------------------------------------------------------------------

export function buildProjectForecastSnapshot(input: {
  resolved: ResolvedProject;
  name: string;
  notes?: string;
  id?: string;
  createdAt?: string;
  /** Injected clock — persistence stamps, never engine math. */
  now: string;
  dataSource?: "clickhouse" | "legacy";
}): ProjectForecast {
  const { resolved } = input;
  const frozen: ProjectForecast["frozen"] = {};
  const seedEvidence: ProjectForecast["seedEvidence"] = {};
  for (const resolution of resolved.resolutions) {
    seedEvidence[resolution.entry.funnelId] = resolution.evidence;
    if (resolution.frozen) frozen[resolution.entry.funnelId] = resolution.frozen;
  }
  return {
    schemaVersion: PROJECT_FORECAST_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    forecastModel: "acquisition_cohort_day0",
    id: input.id ?? "",
    name: input.name,
    notes: input.notes,
    source: { window: resolved.window, asOf: resolved.asOf, dataSource: input.dataSource ?? "clickhouse" },
    entries: resolved.resolutions.map((resolution) => resolution.entry),
    windowLedger: resolved.windowLedger,
    funnelLedgers: resolved.funnelLedgers,
    sharedCosts: resolved.sharedCosts,
    policy: resolved.policy,
    frozen,
    seedEvidence,
    resolvedAt: input.now,
    createdAt: input.createdAt ?? input.now,
    updatedAt: input.now,
  };
}

// ---- Replay ----------------------------------------------------------------------

export type ProjectReplayResult =
  | { kind: "ok"; resolved: ResolvedProject; shareDrift: string[] }
  | { kind: "archived"; reason: string };

/** Rebuild a runnable ResolvedProject from a saved row — zero network.
 *
 * Statuses derive from what was saved: an enabled forecast entry WITHOUT a
 * frozen blob was blocked at save time and stays blocked (its reason lives in
 * the saved evidence warnings); replay never invents data a resolve would need. */
export function replayProjectForecast(saved: ProjectForecast): ProjectReplayResult {
  if (saved.schemaVersion !== PROJECT_FORECAST_SCHEMA_VERSION) {
    return { kind: "archived", reason: `Saved with project schema v${saved.schemaVersion}, current is v${PROJECT_FORECAST_SCHEMA_VERSION}.` };
  }
  for (const [funnelId, frozen] of Object.entries(saved.frozen)) {
    if (frozen.schemaVersion !== FORECAST_SCHEMA_VERSION) {
      return { kind: "archived", reason: `Funnel ${funnelId} was frozen with engine schema v${frozen.schemaVersion}, current is v${FORECAST_SCHEMA_VERSION}.` };
    }
  }

  const proratedPool = prorateSharedCostPool(saved.sharedCosts, saved.source.window);
  const windowIdentity = verifyWindowSpendIdentity(saved.windowLedger);

  // Recompute the share vector from lineage — deterministic, and the baked
  // frozen shares must agree with it (drift ⇒ the saved row is inconsistent).
  const allocable: OverheadShareInput[] = saved.entries
    .filter((entry) => entry.enabled && (
      entry.kind === "forecast" ? Boolean(saved.frozen[entry.funnelId]) : (saved.funnelLedgers[entry.funnelId]?.funnelResolvedSpend ?? 0) > 0
    ))
    .map((entry) => ({
      funnelId: entry.funnelId,
      kind: entry.kind,
      spendBasisValue: entry.kind === "forecast"
        ? entry.plannedBudget
        : saved.funnelLedgers[entry.funnelId]?.funnelResolvedSpend ?? 0,
      projectedTrials: 0,
    }));
  const shares = allocable.length > 0 ? computeOverheadShares(allocable, { allocation: saved.policy.allocation }) : {};

  const shareDrift: string[] = [];
  const resolutions: ProjectEntryResolution[] = saved.entries.map((entry) => {
    const frozen = saved.frozen[entry.funnelId];
    const ledger = saved.funnelLedgers[entry.funnelId] ?? null;
    const evidence = saved.seedEvidence[entry.funnelId] ?? {
      coverage: { cohorts: 0, trialUsers: 0, spendCoverage: null, observedRetentionDepth: 0, maturityDays: 0 },
      warnings: [], observedTrials: 0, cpaBasis: "manual" as const,
    };
    if (!entry.enabled) {
      return { entry, status: { kind: "disabled" as const }, evidence, ledger };
    }
    if (entry.kind === "spend_only") {
      const ok = (ledger?.funnelResolvedSpend ?? 0) > 0;
      return {
        entry,
        status: ok ? { kind: "ok" as const } : { kind: "blocked" as const, path: "spend", message: "No resolved spend in the saved ledger." },
        evidence,
        ledger,
      };
    }
    if (!frozen) {
      return { entry, status: { kind: "blocked" as const, path: "replay", message: "Blocked at save time — see the saved warnings." }, evidence, ledger };
    }
    const baked = frozen.assumptions.costs.overheadAllocation;
    const recomputed = shares[entry.funnelId] ?? 0;
    if (baked.mode === "by_spend_share" && Math.abs((baked.share ?? 0) - recomputed) > SHARE_DRIFT_TOLERANCE) {
      shareDrift.push(`${entry.funnelId}: baked ${(baked.share ?? 0).toFixed(12)} vs recomputed ${recomputed.toFixed(12)}`);
    }
    const result = runFunnelEconomics(prepareRuntimeInputs(frozen));
    return { entry, status: { kind: "ok" as const }, evidence, ledger, frozen, result };
  });

  const enabledOkIds = resolutions.filter((r) => r.status.kind === "ok").map((r) => r.entry.funnelId);
  const scope = scopeProjectSpend({
    windowLedger: saved.windowLedger,
    funnelLedgers: saved.funnelLedgers,
    enabledFunnelIds: enabledOkIds,
    includeUnknownFunnelSpend: saved.policy.includeUnknownFunnelSpend,
    includeOtherUnallocatedSpend: saved.policy.includeOtherUnallocatedSpend,
  });
  const provisional = deriveProvisionalFlags({
    windowLedger: saved.windowLedger,
    scope,
    policy: saved.policy,
    entries: resolutions.filter((r) => r.status.kind === "ok").map((r) => r.entry),
  });

  return {
    kind: "ok",
    shareDrift,
    resolved: {
      window: saved.source.window,
      asOf: saved.source.asOf,
      resolutions,
      shares,
      proratedPool,
      scope,
      provisional,
      windowIdentity,
      windowLedger: saved.windowLedger,
      funnelLedgers: saved.funnelLedgers,
      sharedCosts: saved.sharedCosts,
      policy: saved.policy,
    },
  };
}

// ---- Refresh diff ----------------------------------------------------------------

export interface ProjectFunnelDiff {
  funnelId: string;
  kind: "added" | "removed" | "changed";
  /** Changed leaf paths (capped) — e.g. "assumptions.traffic.targetCpa". */
  changedPaths: string[];
  headline: Array<{ label: string; before: string; after: string }>;
}

export interface ProjectFrozenDiff {
  funnels: ProjectFunnelDiff[];
  unchangedCount: number;
}

const MAX_PATHS_PER_FUNNEL = 40;

function flattenLeaves(value: unknown, prefix: string, out: Map<string, unknown>): void {
  if (value === null || typeof value !== "object") {
    out.set(prefix, value);
    return;
  }
  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, value.length);
    value.forEach((item, index) => flattenLeaves(item, `${prefix}[${index}]`, out));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flattenLeaves(child, prefix ? `${prefix}.${key}` : key, out);
  }
}

const fmt = (value: unknown): string => {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(4);
  return String(value);
};

function headlineFor(before: FrozenForecastInputs | undefined, after: FrozenForecastInputs | undefined): ProjectFunnelDiff["headline"] {
  const pick = (frozen: FrozenForecastInputs | undefined) => frozen === undefined ? undefined : {
    budget: frozen.assumptions.traffic.plannedBudget,
    cpa: frozen.assumptions.traffic.targetCpa,
    trialPrice: frozen.assumptions.pricing.schedule.periods[0]?.price,
    periods: frozen.assumptions.pricing.schedule.periods.length,
    observedDepth: frozen.assumptions.retention.observedDepth,
    refundRate: frozen.assumptions.costs.refundRate,
  };
  const a = pick(before);
  const b = pick(after);
  const labels: Array<[string, keyof NonNullable<typeof a>]> = [
    ["Budget", "budget"], ["Target CPA", "cpa"], ["Trial price", "trialPrice"],
    ["Periods", "periods"], ["Observed depth", "observedDepth"], ["Refund rate", "refundRate"],
  ];
  const rows: ProjectFunnelDiff["headline"] = [];
  for (const [label, key] of labels) {
    const beforeValue = a?.[key];
    const afterValue = b?.[key];
    if (fmt(beforeValue) !== fmt(afterValue)) rows.push({ label, before: fmt(beforeValue), after: fmt(afterValue) });
  }
  return rows;
}

/** Field-level diff between the saved frozen map and a freshly re-resolved one.
 * resolvedAt is excluded — it always differs and carries no economics. */
export function diffProjectFrozen(
  saved: Record<string, FrozenForecastInputs>,
  fresh: Record<string, FrozenForecastInputs>,
): ProjectFrozenDiff {
  const funnels: ProjectFunnelDiff[] = [];
  let unchangedCount = 0;
  const ids = [...new Set([...Object.keys(saved), ...Object.keys(fresh)])].sort();
  for (const funnelId of ids) {
    const before = saved[funnelId];
    const after = fresh[funnelId];
    if (!before) {
      funnels.push({ funnelId, kind: "added", changedPaths: [], headline: headlineFor(undefined, after) });
      continue;
    }
    if (!after) {
      funnels.push({ funnelId, kind: "removed", changedPaths: [], headline: headlineFor(before, undefined) });
      continue;
    }
    const beforeLeaves = new Map<string, unknown>();
    const afterLeaves = new Map<string, unknown>();
    flattenLeaves({ ...before, resolvedAt: undefined }, "", beforeLeaves);
    flattenLeaves({ ...after, resolvedAt: undefined }, "", afterLeaves);
    const changed: string[] = [];
    for (const [path, value] of afterLeaves) {
      if (!Object.is(beforeLeaves.get(path), value)) changed.push(path);
      if (changed.length >= MAX_PATHS_PER_FUNNEL) break;
    }
    if (changed.length < MAX_PATHS_PER_FUNNEL) {
      for (const path of beforeLeaves.keys()) {
        if (!afterLeaves.has(path)) {
          changed.push(path);
          if (changed.length >= MAX_PATHS_PER_FUNNEL) break;
        }
      }
    }
    if (changed.length === 0) {
      unchangedCount += 1;
      continue;
    }
    funnels.push({ funnelId, kind: "changed", changedPaths: changed, headline: headlineFor(before, after) });
  }
  return { funnels, unchangedCount };
}
