// Project seeding (P3, rev. 3): cohort rows + spend ledger → resolved project.
//
// This is the resolver the engine's OverheadAllocation comment points at ("the
// pure engine has no portfolio context"). It owns exactly the steps between raw
// window data and runnable frozen inputs:
//
//   GROUP rows by campaign_path → DERIVE actuals per funnel → re-base the CPA
//   seed onto the ledger basis (§5a) → SHARE the prorated pool across ALL
//   enabled spend-bearing rows → STAMP fixed pool + by_spend_share + shared
//   extras into each assumption tree → FREEZE → RUN → per-row economics.
//
// Design rules enforced here, each pinned by a test:
//   - budget and CPA share ONE basis (§5a): trials reproduce the observed count,
//     the CPA honestly includes waste — never more trials from wasted spend;
//   - a funnel with spend and zero trials becomes a spend_only cost row; the
//     engine is never invoked for it;
//   - one bad entry blocks THAT row, never the resolve (fixpoint re-share);
//   - mixed-currency spend kills the seeded CPA (a EUR+USD sum ÷ trials is not
//     a price); manual CPA remains the escape hatch;
//   - an implausible cadence is a loud warning, not a silent mis-seed;
//   - commissions come only from the ledger or the operator — never a default.
import {
  buildForecastAssumptions,
  workbookGlobalDefaults,
  type AssumptionSeedInput,
  type GlobalForecastDefaults,
} from "./funnelEconomicsAssumptions.ts";
import { deriveFunnelActualsFromCohortRows, type CohortRowLike } from "./funnelEconomicsActuals.ts";
import { createFrozenForecastInputs, defaultPolicyDescriptors, prepareRuntimeInputs } from "./funnelEconomicsStrategies.ts";
import { runFunnelEconomics } from "./funnelEconomicsEngine.ts";
import {
  applyManualCommissions,
  assertBonusPolicySupported,
  buildSpendBucket,
  computeOverheadShares,
  deriveProvisionalFlags,
  prorateSharedCostPool,
  rebaseCpaSeed,
  scopeProjectSpend,
  verifyWindowSpendIdentity,
  type FunnelSpendLedger,
  type OverheadShareInput,
  type ProjectAggregationPolicy,
  type ProjectFunnelEntry,
  type ProjectSeedEvidence,
  type ProjectSpendScope,
  type ProvisionalFlags,
  type SharedCostPool,
  type SpendIdentityCheck,
  type WindowSpendLedger,
} from "./funnelEconomicsProject.ts";
import {
  aggregateProject,
  buildForecastRowEconomics,
  buildSpendOnlyRowEconomics,
  type ProjectRowEconomics,
  type ProjectTotals,
} from "./funnelEconomicsProjectAggregate.ts";
import { buildBoundarySeries, type DayGridSeries } from "./funnelEconomicsDayGrid.ts";
import type {
  Cadence,
  DataWarning,
  DateWindow,
  ForecastResult,
  FrozenForecastInputs,
  FunnelActuals,
} from "./funnelEconomicsTypes.ts";
import { ForecastInputError } from "./funnelEconomicsTypes.ts";

/** Mirrors the (non-exported) schedule map in funnelEconomicsTypes — the days one
 * billing period spans, which also gates retention maturity in the deriver. */
export const CADENCE_PERIOD_DAYS: Record<Cadence, number> = {
  monthly: 30,
  weekly: 7,
  quarterly: 90,
  annual: 365,
  custom: 30,
};

// ---- Cadence plausibility (risk 18e) ---------------------------------------------

/** The maturity gate makes a WRONG cadence destructive, not cosmetic: a weekly
 * label on monthly billing reads a structural r2 = 0 among "mature" cohorts and
 * extrapolates survival [1, c1, 0] — all revenue past period 1 vanishes. The
 * signature is precise enough to detect: healthy first-paid conversion, a hard
 * zero at the FIRST renewal level, and cohorts old enough that the zero cannot
 * be youth. */
export function cadencePlausibilityWarnings(input: {
  actuals: FunnelActuals | null;
  maturityDays: number;
  periodDays: number;
}): DataWarning[] {
  const warnings: DataWarning[] = [];
  const actuals = input.actuals;
  if (!actuals) return warnings;
  const firstPaid = actuals.firstPaidConversion ?? 0;
  if (firstPaid > 0 && actuals.renewalConversions.length >= 1 && actuals.renewalConversions[0] === 0 && input.maturityDays >= 2 * input.periodDays) {
    warnings.push({
      code: "cadence_too_short",
      message: `First-paid conversion is ${(firstPaid * 100).toFixed(1)}% but renewal level 2 is zero among cohorts aged ≥ ${2 * input.periodDays}d — the billing period is probably LONGER than the selected cadence (survival would collapse to [1, c1, 0]).`,
    });
  }
  if (firstPaid > 0 && actuals.renewalConversions.length === 0 && input.periodDays >= 30 && input.maturityDays >= 14 && input.maturityDays < 2 * input.periodDays) {
    warnings.push({
      code: "cadence_unobservable",
      message: `No renewal cycle is observable at a ${input.periodDays}d cadence yet (window maturity ${input.maturityDays}d). If this funnel bills weekly, ~${Math.floor(input.maturityDays / 7)} cycles would already be visible — confirm the cadence.`,
    });
  }
  return warnings;
}

/** Mixed-currency spend cannot seed a CPA (the sum is not an amount in any
 * currency); single non-USD spend seeds but is flagged — revenue is USD and FB
 * spend is never FX-converted, so the ratio is cross-currency. */
export function currencyGateWarnings(ledger: FunnelSpendLedger | null): { warnings: DataWarning[]; cpaSeedBlocked: boolean } {
  if (!ledger) return { warnings: [], cpaSeedBlocked: false };
  if (ledger.currencyMixed) {
    return {
      cpaSeedBlocked: true,
      warnings: [{
        code: "spend_currency_mixed",
        message: "This funnel's spend spans multiple currencies — a summed CPA would be arithmetically invalid. Set a manual CPA to include the funnel.",
      }],
    };
  }
  if (ledger.currency && ledger.currency !== "USD") {
    return {
      cpaSeedBlocked: false,
      warnings: [{
        code: "spend_currency_non_usd",
        message: `Spend is in ${ledger.currency} while revenue is USD-normalized; the seeded CPA is cross-currency and provisional.`,
      }],
    };
  }
  return { warnings: [], cpaSeedBlocked: false };
}

// ---- Entry auto-construction -----------------------------------------------------

export interface BuildProjectEntriesInput {
  rows: ReadonlyArray<CohortRowLike>;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  policy: Pick<ProjectAggregationPolicy, "spendBasis" | "assumedCadence" | "bonus">;
  defaults?: Partial<GlobalForecastDefaults>;
}

const rowPath = (row: CohortRowLike): string => row.campaign_path || "unknown";

export function groupRowsByPath(rows: ReadonlyArray<CohortRowLike>): Map<string, CohortRowLike[]> {
  const grouped = new Map<string, CohortRowLike[]>();
  for (const row of rows) {
    const path = rowPath(row);
    const list = grouped.get(path) ?? [];
    list.push(row);
    grouped.set(path, list);
  }
  return grouped;
}

/** Auto-seed one entry per funnel: the union of paths with trials and paths with
 * resolved spend. Trials → forecast row; spend without trials → spend_only cost
 * row; a path with neither cannot occur by construction. plannedBudget starts on
 * the policy's spend basis (§5a) so budget and the CPA seed share it. */
export function buildProjectEntries(input: BuildProjectEntriesInput): ProjectFunnelEntry[] {
  const defaults = { ...workbookGlobalDefaults(), ...input.defaults };
  const grouped = groupRowsByPath(input.rows);
  const paths = new Set<string>([...grouped.keys(), ...Object.keys(input.funnelLedgers)]);
  const entries: ProjectFunnelEntry[] = [];

  for (const funnelId of [...paths].sort()) {
    const rows = grouped.get(funnelId) ?? [];
    const trials = rows.reduce((sum, row) => sum + row.trial_users, 0);
    const ledger = input.funnelLedgers[funnelId] ?? null;
    const basisSpend = input.policy.spendBasis === "full_funnel_spend"
      ? ledger?.funnelResolvedSpend ?? null
      : ledger?.userAttributedSpend ?? null;
    const kind: ProjectFunnelEntry["kind"] = trials > 0 ? "forecast" : "spend_only";
    if (kind === "spend_only" && !(basisSpend !== null && basisSpend > 0)) continue;

    const cadence = input.policy.assumedCadence;
    entries.push({
      funnelId,
      kind,
      enabled: true,
      cadence,
      cadenceConfirmed: false,
      plannedBudget: basisSpend ?? 0,
      targetCpaSeed: null,
      horizonPeriods: defaults.horizonByCadence[cadence] ?? 12,
      manualSeeds: {},
      overrides: {},
      extrapolation: defaultPolicyDescriptors().extrapolation,
      bonusEnabled: input.policy.bonus.kind !== "disabled",
      ownExtras: [],
      startDayOffset: 0,
    });
  }
  return entries;
}

// ---- Resolution ------------------------------------------------------------------

export type ProjectEntryStatus =
  | { kind: "ok" }
  | { kind: "disabled" }
  | { kind: "blocked"; path: string; message: string };

export interface ProjectEntryResolution {
  entry: ProjectFunnelEntry;
  status: ProjectEntryStatus;
  evidence: ProjectSeedEvidence;
  ledger: FunnelSpendLedger | null;
  frozen?: FrozenForecastInputs;
  result?: ForecastResult;
}

export interface ResolvedProject {
  window: DateWindow;
  asOf: string;
  resolutions: ProjectEntryResolution[];
  shares: Record<string, number>;
  proratedPool: number;
  scope: ProjectSpendScope;
  provisional: ProvisionalFlags;
  windowIdentity: SpendIdentityCheck;
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  sharedCosts: SharedCostPool;
  policy: ProjectAggregationPolicy;
}

export interface ResolveProjectInput {
  window: DateWindow;
  /** Pinned once per project and persisted — maturity gating depends on it. */
  asOf: string;
  rows: ReadonlyArray<CohortRowLike>;
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  entries: ReadonlyArray<ProjectFunnelEntry>;
  sharedCosts: SharedCostPool;
  policy: ProjectAggregationPolicy;
  defaults?: Partial<GlobalForecastDefaults>;
}

interface EntryWorkState {
  entry: ProjectFunnelEntry;
  ledger: FunnelSpendLedger | null;
  status: ProjectEntryStatus;
  actuals: FunnelActuals | null;
  evidence: ProjectSeedEvidence;
  projectedTrials: number;
  seedCpa: number | null;
  frozen?: FrozenForecastInputs;
  result?: ForecastResult;
}

function applyCommissionsToLedgers(input: {
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  manual: Record<string, number> | undefined;
}): { windowLedger: WindowSpendLedger; funnelLedgers: Record<string, FunnelSpendLedger> } {
  const rebuildBucket = (bucket: WindowSpendLedger["unknownFunnel"]) =>
    buildSpendBucket(applyManualCommissions(bucket.groups, input.manual));
  const windowLedger: WindowSpendLedger = {
    ...input.windowLedger,
    funnelResolved: rebuildBucket(input.windowLedger.funnelResolved),
    userAttributed: rebuildBucket(input.windowLedger.userAttributed),
    noUser: rebuildBucket(input.windowLedger.noUser),
    unknownFunnel: rebuildBucket(input.windowLedger.unknownFunnel),
    otherUnallocated: rebuildBucket(input.windowLedger.otherUnallocated),
  };
  const funnelLedgers: Record<string, FunnelSpendLedger> = {};
  for (const [funnelId, ledger] of Object.entries(input.funnelLedgers)) {
    const groups = applyManualCommissions(ledger.groups, input.manual);
    funnelLedgers[funnelId] = { ...ledger, groups, trafficCashOutflow: buildSpendBucket(groups).trafficCashOutflow };
  }
  return { windowLedger, funnelLedgers };
}

/** Resolve edited entries against window data. Pure and deterministic; every
 * failure is confined to its row. The share vector is a fixpoint: an entry that
 * fails to build or run is re-classified blocked and the shares renormalize over
 * the remainder (an engine throw after stamping must not leave a stale share). */
export function resolveProject(input: ResolveProjectInput): ResolvedProject {
  assertBonusPolicySupported(input.policy.bonus);
  const defaults = { ...workbookGlobalDefaults(), ...input.defaults };
  const { windowLedger, funnelLedgers } = applyCommissionsToLedgers({
    windowLedger: input.windowLedger,
    funnelLedgers: input.funnelLedgers,
    manual: input.policy.manualCommissionByGroup,
  });
  const windowIdentity = verifyWindowSpendIdentity(windowLedger);
  const grouped = groupRowsByPath(input.rows);
  const proratedPool = prorateSharedCostPool(input.sharedCosts, input.window);
  const monthlySum = input.sharedCosts.monthly.ffBilling + input.sharedCosts.monthly.funnelConstructor + input.sharedCosts.monthly.payroll;
  const poolFactor = monthlySum > 0 ? proratedPool / monthlySum : 0;
  const proratedFixed = {
    ffBilling: input.sharedCosts.monthly.ffBilling * poolFactor,
    funnelConstructor: input.sharedCosts.monthly.funnelConstructor * poolFactor,
    payroll: input.sharedCosts.monthly.payroll * poolFactor,
  };

  // ---- Pass 1: derive actuals, gate currency/cadence, resolve the CPA seed ----
  const work: EntryWorkState[] = [...input.entries]
    .sort((a, b) => (a.funnelId < b.funnelId ? -1 : a.funnelId > b.funnelId ? 1 : 0))
    .map((entry) => {
      const ledger = funnelLedgers[entry.funnelId] ?? null;
      const rows = grouped.get(entry.funnelId) ?? [];
      const periodDays = CADENCE_PERIOD_DAYS[entry.cadence];
      const derived = deriveFunnelActualsFromCohortRows({
        funnelId: entry.funnelId,
        rows,
        asOf: input.asOf,
        window: input.window,
        periodDays,
      });
      const currencyGate = currencyGateWarnings(ledger);
      const warnings: DataWarning[] = [
        ...derived.warnings,
        ...currencyGate.warnings,
        ...cadencePlausibilityWarnings({ actuals: derived.actuals, maturityDays: derived.coverage.maturityDays, periodDays }),
      ];

      const state: EntryWorkState = {
        entry,
        ledger,
        status: { kind: "ok" },
        actuals: derived.actuals,
        evidence: {
          coverage: derived.coverage,
          warnings,
          observedTrials: derived.coverage.trialUsers,
          cpaBasis: input.policy.spendBasis === "full_funnel_spend" ? "full_resolved" : "attributed",
        },
        projectedTrials: 0,
        seedCpa: null,
      };

      if (!entry.enabled) {
        state.status = { kind: "disabled" };
        return state;
      }
      if (entry.kind === "spend_only") {
        if (!(ledger && (ledger.funnelResolvedSpend ?? 0) > 0)) {
          state.status = { kind: "blocked", path: "spend", message: "No resolved spend for this funnel — nothing to cost." };
        }
        return state;
      }

      // Forecast rows: budget must be positive (typing 0 disables, never throws).
      if (!(entry.plannedBudget > 0)) {
        state.status = { kind: "blocked", path: "traffic.plannedBudget", message: "Planned budget must be > 0 — set a budget or disable the funnel." };
        return state;
      }

      // §5a CPA seed ladder: manual → ledger re-base → (attributed mode only)
      // the deriver's own attributed CPA → blocked. The mixed-currency gate
      // kills ledger-derived seeds; manual remains valid.
      const observedTrials = derived.coverage.trialUsers;
      const attributedTrials = derived.coverage.spendCoverage !== null
        ? derived.coverage.spendCoverage * observedTrials
        : 0;
      const rebased = ledger && !currencyGate.cpaSeedBlocked
        ? rebaseCpaSeed({ mode: input.policy.spendBasis, ledger, observedTrials, attributedTrials })
        : null;
      if (entry.manualSeeds.targetCpa !== undefined) {
        state.seedCpa = entry.manualSeeds.targetCpa;
        state.evidence = { ...state.evidence, cpaBasis: "manual" };
      } else if (rebased) {
        state.seedCpa = rebased.targetCpaSeed;
      } else if (input.policy.spendBasis === "attributed_only" && !currencyGate.cpaSeedBlocked && derived.actuals?.cpaActual != null) {
        state.seedCpa = derived.actuals.cpaActual;
      }
      if (state.seedCpa === null) {
        state.status = {
          kind: "blocked",
          path: "traffic.targetCpa",
          message: currencyGate.cpaSeedBlocked
            ? "Mixed-currency spend cannot seed a CPA — set a manual CPA to include this funnel."
            : "No CPA available: the funnel has no resolvable spend on the selected basis. Set a manual CPA.",
        };
        return state;
      }
      state.projectedTrials = entry.plannedBudget / state.seedCpa;
      return state;
    });

  // ---- Passes 2+3: share fixpoint — stamp, freeze, run; failures re-share ----
  for (;;) {
    const allocable = work.filter((state) => state.status.kind === "ok" && (
      state.entry.kind === "forecast" || state.entry.kind === "spend_only"
    ));
    let shares: Record<string, number> = {};
    if (allocable.length > 0) {
      shares = computeOverheadShares(
        allocable.map((state): OverheadShareInput => ({
          funnelId: state.entry.funnelId,
          kind: state.entry.kind,
          spendBasisValue: state.entry.kind === "forecast"
            ? state.entry.plannedBudget
            : state.ledger?.funnelResolvedSpend ?? 0,
          projectedTrials: state.projectedTrials,
        })),
        { allocation: input.policy.allocation },
      );
    }

    let failures = 0;
    for (const state of work) {
      if (state.status.kind !== "ok" || state.entry.kind !== "forecast") continue;
      const share = shares[state.entry.funnelId] ?? 0;
      try {
        const actualsForBuild = state.actuals
          ? { ...state.actuals, cpaActual: state.seedCpa }
          : null;
        const seedInput: AssumptionSeedInput = {
          cadence: state.entry.cadence,
          plannedBudget: state.entry.plannedBudget,
          horizonPeriods: state.entry.horizonPeriods,
          defaults: input.defaults,
          actuals: actualsForBuild,
          manual: state.entry.manualSeeds,
          extrapolation: state.entry.extrapolation,
          overrides: state.entry.overrides,
        };
        const built = buildForecastAssumptions(seedInput);
        // Project stamps: the prorated shared pool replaces the workbook fixed
        // costs (counted once across the project via the share), and shared
        // extras ride the same share. Own extras stay funnel-specific.
        built.assumptions.costs.fixed = { ...proratedFixed };
        built.assumptions.costs.overheadAllocation = { mode: "by_spend_share", share };
        built.provenance["costs.fixed"] = "config";
        built.provenance["costs.overheadAllocation"] = "calculated";
        built.assumptions.costs.extraCosts = [
          ...state.entry.ownExtras,
          ...input.sharedCosts.extras.map((item) => ({ ...item, key: `shared:${item.key}`, amount: item.amount * share })),
        ];
        const bonusDefaults = defaultPolicyDescriptors();
        const bonus = input.policy.bonus.kind === "disabled" || !state.entry.bonusEnabled
          ? { ...bonusDefaults.bonus, kind: "none" as const, enabled: false }
          : { ...bonusDefaults.bonus, enabled: true };
        const frozen = createFrozenForecastInputs({
          assumptions: built.assumptions,
          provenance: built.provenance,
          resolvedAt: input.asOf,
          policyDescriptors: { bonus, extrapolation: state.entry.extrapolation },
        });
        state.frozen = frozen;
        state.result = runFunnelEconomics(prepareRuntimeInputs(frozen));
        state.evidence = { ...state.evidence, warnings: [...state.evidence.warnings, ...built.warnings] };
      } catch (error) {
        const inputError = error instanceof ForecastInputError;
        state.status = {
          kind: "blocked",
          path: inputError ? (error as ForecastInputError).path : "engine",
          message: error instanceof Error ? error.message : String(error),
        };
        state.frozen = undefined;
        state.result = undefined;
        failures += 1;
      }
    }
    if (failures === 0) {
      const enabledOkIds = work
        .filter((state) => state.status.kind === "ok")
        .map((state) => state.entry.funnelId);
      const scope = scopeProjectSpend({
        windowLedger,
        funnelLedgers,
        enabledFunnelIds: enabledOkIds,
        includeUnknownFunnelSpend: input.policy.includeUnknownFunnelSpend,
        includeOtherUnallocatedSpend: input.policy.includeOtherUnallocatedSpend,
      });
      const provisional = deriveProvisionalFlags({
        windowLedger,
        scope,
        policy: input.policy,
        entries: work.filter((state) => state.status.kind === "ok").map((state) => state.entry),
      });
      return {
        window: input.window,
        asOf: input.asOf,
        resolutions: work.map((state) => ({
          entry: state.entry,
          status: state.status,
          evidence: state.evidence,
          ledger: state.ledger,
          frozen: state.frozen,
          result: state.result,
        })),
        shares,
        proratedPool,
        scope,
        provisional,
        windowIdentity,
        windowLedger,
        funnelLedgers,
        sharedCosts: input.sharedCosts,
        policy: input.policy,
      };
    }
  }
}

/** The plan's named convenience: auto-build entries from window data, then
 * resolve. The UI's first render and the "manual run on a real window" both go
 * through this. */
export function resolveProjectFromCohortRows(input: Omit<ResolveProjectInput, "entries">): ResolvedProject {
  const entries = buildProjectEntries({
    rows: input.rows,
    funnelLedgers: input.funnelLedgers,
    policy: input.policy,
    defaults: input.defaults,
  });
  return resolveProject({ ...input, entries });
}

// ---- Extrapolation exposure (P8) -------------------------------------------------

export interface ExtrapolationExposure {
  /** Gross revenue projected in periods whose survival is EXTRAPOLATED. */
  extrapolatedGross: number;
  grossTotal: number;
  /** extrapolatedGross / grossTotal; null when there is no gross at all. */
  share: number | null;
}

/** How much of a funnel's projected revenue rests on extrapolated retention.
 * A period is extrapolated when its survival provenance says so — the same tag
 * the period table renders as a badge. */
export function extrapolatedRevenueShare(resolution: Pick<ProjectEntryResolution, "frozen" | "result">): ExtrapolationExposure | null {
  if (!resolution.frozen || !resolution.result) return null;
  const provenance = resolution.frozen.provenance;
  let extrapolatedGross = 0;
  let grossTotal = 0;
  for (const period of resolution.result.timeline.periods) {
    grossTotal += period.revenue.gross;
    if (provenance[`retention.survival[${period.index}]`] === "extrapolated") {
      extrapolatedGross += period.revenue.gross;
    }
  }
  return { extrapolatedGross, grossTotal, share: grossTotal > 0 ? extrapolatedGross / grossTotal : null };
}

/** Project-level exposure: Σ extrapolated gross / Σ gross over ok forecast rows —
 * weighted by construction, never an average of shares. */
export function projectExtrapolationSummary(resolutions: ReadonlyArray<ProjectEntryResolution>): ExtrapolationExposure {
  let extrapolatedGross = 0;
  let grossTotal = 0;
  for (const resolution of resolutions) {
    if (resolution.status.kind !== "ok") continue;
    const exposure = extrapolatedRevenueShare(resolution);
    if (!exposure) continue;
    extrapolatedGross += exposure.extrapolatedGross;
    grossTotal += exposure.grossTotal;
  }
  return { extrapolatedGross, grossTotal, share: grossTotal > 0 ? extrapolatedGross / grossTotal : null };
}

// ---- Run: resolved project → rows, series, totals --------------------------------

export interface ProjectRunResult {
  rows: ProjectRowEconomics[];
  series: DayGridSeries[];
  totals: ProjectTotals;
}

export function runResolvedProject(resolved: ResolvedProject): ProjectRunResult {
  const rows: ProjectRowEconomics[] = [];
  const series: DayGridSeries[] = [];
  let refundCostTotal = 0;

  for (const resolution of resolved.resolutions) {
    if (resolution.status.kind !== "ok") continue;
    if (resolution.entry.kind === "forecast" && resolution.result) {
      rows.push(buildForecastRowEconomics({
        funnelId: resolution.entry.funnelId,
        result: resolution.result,
        overheadShare: resolved.shares[resolution.entry.funnelId] ?? 0,
      }));
      series.push(buildBoundarySeries(
        resolution.entry.funnelId,
        resolution.result.timeline.periods,
        resolution.entry.startDayOffset,
      ));
      refundCostTotal += resolution.result.costs.refundTotal;
    } else if (resolution.entry.kind === "spend_only" && resolution.ledger) {
      rows.push(buildSpendOnlyRowEconomics({
        funnelId: resolution.entry.funnelId,
        ledger: resolution.ledger,
        overheadShare: resolved.shares[resolution.entry.funnelId] ?? 0,
        proratedPool: resolved.proratedPool,
        ownExtras: resolution.entry.ownExtras,
        bonusPolicyKind: resolved.policy.bonus.kind,
      }));
    }
  }

  const totals = aggregateProject({
    rows,
    series,
    scope: resolved.scope,
    proratedPool: resolved.proratedPool,
    policy: resolved.policy,
    provisional: resolved.provisional,
    windowIdentity: resolved.windowIdentity,
    refundCostTotal,
  });
  return { rows, series, totals };
}
