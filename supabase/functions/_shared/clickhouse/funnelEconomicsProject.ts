// Project-level forecasting — domain contracts and resolver math (P1, rev. 3 spec).
//
// A ProjectForecast composes N per-funnel forecasts into one portfolio answer.
// This module is the "portfolio context" the engine's OverheadAllocation comment
// points at ("share pre-computed by the resolver — the pure engine has no
// portfolio context to derive it from"). It owns everything the engine
// deliberately cannot:
//
//   - the spend ledger: window-level reconciliation vs project-level scoping.
//     window_source_spend balances the whole date range; project_scoped_spend —
//     only what the operator selected — drives every P&L ratio. Deselecting a
//     funnel moves its spend to out_of_project (visible, never in the P&L).
//   - traffic cash outflow from SPEND GROUPS. Unresolved spend can span
//     accounts/currencies/channels with different traffic commissions, so a
//     single global default is forbidden: a group with an unknown commission
//     yields a null outflow that PROPAGATES (fully-loaded metrics become
//     unavailable) instead of being silently defaulted away.
//   - overhead shares across ALL spend-bearing rows — forecast and spend_only
//     alike — so Σ allocated overhead === the prorated pool exactly.
//   - spend-only row economics (a funnel with spend and zero trials cannot be an
//     engine scenario — the engine requires targetCpa > 0; it is a pure cost row
//     computed here, and the engine is never invoked for it).
//   - CPA re-basing: with full resolved spend as the budget, the CPA seed must
//     be re-based onto the SAME spend, or the engine would project MORE trials
//     from wasted spend (trials = budget / cpa).
//
// Everything here is pure, deterministic and JSON-serializable, matching the
// FrozenForecastInputs discipline: no Date.now, no I/O, no functions in state.
import type {
  AssumptionPatch,
  Cadence,
  DataCoverage,
  DataWarning,
  DateWindow,
  ExtraCostItem,
  ExtrapolationPolicyDescriptor,
  FrozenForecastInputs,
  RoundingPolicyDescriptor,
} from "./funnelEconomicsTypes.ts";
import { ForecastInputError } from "./funnelEconomicsTypes.ts";
import type { ManualSeedOverrides } from "./funnelEconomicsAssumptions.ts";
import { clamp01 } from "./financialPrimitives.ts";

export const PROJECT_FORECAST_SCHEMA_VERSION = 1;

/** v1 models every funnel from a common Day 0 (acquisition-cohort payback), NOT a
 * calendar-month P&L. A future calendar-stacked model is a DIFFERENT discriminant
 * value — never a silent reinterpretation of saved projects. */
export type ProjectForecastModel = "acquisition_cohort_day0";

export type SpendBasisMode = "full_funnel_spend" | "attributed_only";

// ---- Spend groups ----------------------------------------------------------------

export interface SpendGroup {
  /** "facebook" today; future channels UNION into the same ledger. */
  trafficChannel: string;
  adAccountId: string;
  currency: string;
  spend: number;
  /** null ⇒ unresolved. NEVER substituted with a global default. */
  trafficCommission: number | null;
  /** spend / (1 − commission); null when the commission is null. */
  trafficCashOutflow: number | null;
}

/** Stable identity for manual commission assignment. */
export function spendGroupKey(group: Pick<SpendGroup, "trafficChannel" | "adAccountId" | "currency">): string {
  return `${group.trafficChannel}:${group.adAccountId}:${group.currency}`;
}

export function groupTrafficCashOutflow(spend: number, trafficCommission: number | null): number | null {
  if (trafficCommission === null) return null;
  if (!Number.isFinite(trafficCommission) || trafficCommission < 0 || trafficCommission >= 1) {
    throw new ForecastInputError("spendGroup.trafficCommission", "must be a finite rate in [0, 1)");
  }
  return spend / (1 - trafficCommission);
}

/** Fill unresolved commissions from operator-supplied assumptions. Returns new
 * groups; never mutates. A key absent from `manual` stays unresolved. */
export function applyManualCommissions(
  groups: ReadonlyArray<SpendGroup>,
  manual: Record<string, number> | undefined,
): SpendGroup[] {
  return groups.map((group) => {
    if (group.trafficCommission !== null) return { ...group };
    const assumed = manual?.[spendGroupKey(group)];
    if (assumed === undefined) return { ...group };
    return {
      ...group,
      trafficCommission: assumed,
      trafficCashOutflow: groupTrafficCashOutflow(group.spend, assumed),
    };
  });
}

export interface SpendBucket {
  spend: number;
  groups: SpendGroup[];
  /** Σ group.trafficCashOutflow — null if ANY group's commission is unresolved. */
  trafficCashOutflow: number | null;
  /** Σ spend of unresolved groups — sized for the operator's call to action. */
  unresolvedCommissionSpend: number;
}

export function buildSpendBucket(groups: ReadonlyArray<SpendGroup>): SpendBucket {
  let spend = 0;
  let outflow: number | null = 0;
  let unresolved = 0;
  for (const group of groups) {
    spend += group.spend;
    const groupOutflow = group.trafficCommission === null
      ? null
      : group.trafficCashOutflow ?? groupTrafficCashOutflow(group.spend, group.trafficCommission);
    if (groupOutflow === null) {
      outflow = null;
      unresolved += group.spend;
    } else if (outflow !== null) {
      outflow += groupOutflow;
    }
  }
  return { spend, groups: groups.map((group) => ({ ...group })), trafficCashOutflow: outflow, unresolvedCommissionSpend: unresolved };
}

// ---- Ledgers ---------------------------------------------------------------------

export interface FunnelSpendLedger {
  /** All spend of campaigns resolved to this funnel, users or not. The P&L basis. */
  funnelResolvedSpend: number | null;
  /** Of that: campaigns with ≥1 authoritative trial user (Model 1). Diagnostic. */
  userAttributedSpend: number | null;
  /** Of that: campaigns resolved to this funnel with ZERO users. */
  noUserSpend: number | null;
  /** userAttributedSpend / funnelResolvedSpend. */
  spendCoverage: number | null;
  groups: SpendGroup[];
  trafficCashOutflow: number | null;
  resolutionBasis: "campaign_funnel_map" | "historical_campaign_path" | "user_attribution_only";
  currency: string | null;
  currencyMixed: boolean;
}

export interface KnownGapDay {
  date: string;
  reference: string;
  note: string;
}

/** WINDOW level — reconciles the whole date range under the global filters,
 * independent of which funnels the operator selected. */
export interface WindowSpendLedger {
  windowSourceSpend: number;
  funnelResolved: SpendBucket;
  userAttributed: SpendBucket;
  noUser: SpendBucket;
  unknownFunnel: SpendBucket;
  otherUnallocated: SpendBucket;
  knownGapDays: KnownGapDay[];
  /** true when knownGapDays overlaps the window — spend is structurally missing. */
  spendIncomplete: boolean;
}

export const SPEND_IDENTITY_TOLERANCE = 0.01;

export interface SpendIdentityCheck {
  ok: boolean;
  /** source − (attributed + noUser + unknown + otherUnallocated). */
  sourceDelta: number;
  /** funnelResolved − (attributed + noUser). */
  resolvedDelta: number;
}

/** The rev. 3 window reconciliation identity:
 *   window_source_spend = user_attributed + no_user + unknown_funnel + other_unallocated
 *   funnel_resolved     = user_attributed + no_user
 * Violation must surface as an error chip — never as a plausible wrong number. */
export function verifyWindowSpendIdentity(ledger: WindowSpendLedger): SpendIdentityCheck {
  const sourceDelta = ledger.windowSourceSpend -
    (ledger.userAttributed.spend + ledger.noUser.spend + ledger.unknownFunnel.spend + ledger.otherUnallocated.spend);
  const resolvedDelta = ledger.funnelResolved.spend - (ledger.userAttributed.spend + ledger.noUser.spend);
  return {
    ok: Math.abs(sourceDelta) < SPEND_IDENTITY_TOLERANCE && Math.abs(resolvedDelta) < SPEND_IDENTITY_TOLERANCE,
    sourceDelta,
    resolvedDelta,
  };
}

// ---- Project scoping -------------------------------------------------------------

/** PROJECT level — the scoped subset that drives every P&L ratio. Selection is
 * SCOPING, not filtering: it moves spend between in_project and out_of_project
 * without changing window_source_spend, so the panel always balances. */
export interface ProjectSpendScope {
  windowSourceSpend: number;
  inProjectResolvedSpend: number;
  /** Resolved to a funnel the operator deselected — visible, never in the P&L. */
  outOfProjectSpend: number;
  includedUnresolvedSpend: number;
  /** = inProjectResolvedSpend + includedUnresolvedSpend. Blended-CPA numerator. */
  projectScopedSpend: number;
  /** Outflow of the INCLUDED unresolved buckets only (forecast/spend-only rows carry
   * their own outflows); null when any included group's commission is unresolved. */
  includedUnresolvedOutflow: number | null;
  unresolvedCommissionSpend: number;
  /** projectScopedSpend / windowSourceSpend. */
  spendCoverage: number;
}

export function scopeProjectSpend(input: {
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  /** funnelIds of ENABLED entries (both kinds). */
  enabledFunnelIds: ReadonlyArray<string>;
  includeUnknownFunnelSpend: boolean;
  includeOtherUnallocatedSpend: boolean;
}): ProjectSpendScope {
  const { windowLedger } = input;
  let inProject = 0;
  for (const funnelId of input.enabledFunnelIds) {
    inProject += input.funnelLedgers[funnelId]?.funnelResolvedSpend ?? 0;
  }
  const outOfProject = windowLedger.funnelResolved.spend - inProject;

  let includedUnresolvedSpend = 0;
  let includedUnresolvedOutflow: number | null = 0;
  let unresolvedCommissionSpend = 0;
  for (const [bucket, included] of [
    [windowLedger.unknownFunnel, input.includeUnknownFunnelSpend],
    [windowLedger.otherUnallocated, input.includeOtherUnallocatedSpend],
  ] as Array<[SpendBucket, boolean]>) {
    if (!included) continue;
    includedUnresolvedSpend += bucket.spend;
    unresolvedCommissionSpend += bucket.unresolvedCommissionSpend;
    if (bucket.trafficCashOutflow === null) includedUnresolvedOutflow = null;
    else if (includedUnresolvedOutflow !== null) includedUnresolvedOutflow += bucket.trafficCashOutflow;
  }

  const projectScopedSpend = inProject + includedUnresolvedSpend;
  return {
    windowSourceSpend: windowLedger.windowSourceSpend,
    inProjectResolvedSpend: inProject,
    outOfProjectSpend: outOfProject,
    includedUnresolvedSpend,
    projectScopedSpend,
    includedUnresolvedOutflow,
    unresolvedCommissionSpend,
    spendCoverage: windowLedger.windowSourceSpend > 0 ? projectScopedSpend / windowLedger.windowSourceSpend : 0,
  };
}

// ---- Shared costs & proration ----------------------------------------------------

export interface SharedCostPool {
  monthly: { ffBilling: number; funnelConstructor: number; payroll: number };
  proration: { mode: "calendar_prorated" | "full_month" | "manual" | "excluded"; manualAmount?: number };
  extras: ExtraCostItem[];
}

const DAY_MS = 86_400_000;

function daysInUtcMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/** Months of pool charged for the window under calendar proration:
 *   Σ over calendar months overlapping the window of (window days in month / days in month).
 * A full July → 31/31 = 1. July 1–15 → 15/31. A 45-day July+August window →
 * 31/31 + 14/31. Bounds are inclusive dates, matching DateWindow semantics. */
export function calendarProrationMonths(window: DateWindow): number {
  const fromMs = Date.parse(`${window.from}T00:00:00Z`);
  const toMs = Date.parse(`${window.to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    throw new ForecastInputError("source.window", "invalid window for proration");
  }
  let months = 0;
  let cursor = new Date(fromMs);
  for (;;) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthDays = daysInUtcMonth(year, month);
    const monthStartMs = Date.UTC(year, month, 1);
    const monthEndMs = Date.UTC(year, month, monthDays);
    const overlapStart = Math.max(fromMs, monthStartMs);
    const overlapEnd = Math.min(toMs, monthEndMs);
    const overlapDays = Math.floor((overlapEnd - overlapStart) / DAY_MS) + 1;
    if (overlapDays > 0) months += overlapDays / monthDays;
    if (monthEndMs >= toMs) break;
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }
  return months;
}

export function prorateSharedCostPool(pool: SharedCostPool, window: DateWindow): number {
  const monthlySum = pool.monthly.ffBilling + pool.monthly.funnelConstructor + pool.monthly.payroll;
  switch (pool.proration.mode) {
    case "excluded": return 0;
    case "manual": return pool.proration.manualAmount ?? monthlySum;
    case "full_month": return monthlySum;
    case "calendar_prorated": return monthlySum * calendarProrationMonths(window);
  }
}

// ---- Bonus policy ----------------------------------------------------------------

/** v1 implements per_funnel only; the contract admits the rest so adding one later
 * is a strategy registration, not a schema migration. Unimplemented kinds throw an
 * explicit error — never a silent 0. */
export interface ProjectBonusPolicy {
  kind: "per_funnel" | "per_buyer" | "portfolio_wide" | "disabled";
  params?: Record<string, number>;
}

export type BonusIneligibilityReason = "ineligible_no_conversions" | "policy_disabled";

export function assertBonusPolicySupported(policy: ProjectBonusPolicy): void {
  if (policy.kind === "per_buyer" || policy.kind === "portfolio_wide") {
    throw new ForecastInputError("policy.bonus.kind", `${policy.kind} is not implemented in v1`);
  }
}

// ---- Aggregation policy ----------------------------------------------------------

export type ProjectAllocationBasis = "resolved_spend_share" | "trial_share" | "equal" | "manual";

export interface ProjectAggregationPolicy {
  spendBasis: SpendBasisMode;
  includeUnknownFunnelSpend: boolean;
  includeOtherUnallocatedSpend: boolean;
  /** Operator-supplied commissions for groups the backend could not resolve,
   * keyed by spendGroupKey(). Absence keeps the group unresolved. */
  manualCommissionByGroup?: Record<string, number>;
  allocation: {
    basis: ProjectAllocationBasis;
    manualShares?: Record<string, number>;
    /** Mandatory: disabling a funnel renormalizes shares over the remainder, or
     * its overhead slice would silently vanish and net profit improve for the
     * wrong reason. Recorded for audit. */
    renormalizeOverEnabled: true;
    /** rev. 3: spend-only rows participate in the overhead share. Recorded so a
     * saved project is auditable. */
    includeSpendOnlyRows: true;
  };
  /** Frozen because the engine credits payback at period END (paybackDay =
   * rows[i].dayEnd); changing the step convention breaks 1-funnel parity. */
  dayGridStep: "period_end";
  headlinePayback: "fully_loaded" | "traffic_only";
  bonus: ProjectBonusPolicy;
  assumedCadence: Cadence;
  rounding: RoundingPolicyDescriptor;
}

// ---- Entries ---------------------------------------------------------------------

/** A funnel that spent money but produced no trials cannot be an engine scenario
 * (the engine requires targetCpa > 0 and would divide by it). It is a pure cost
 * row computed in the project layer — the engine is never invoked for it. */
export type ProjectEntryKind = "forecast" | "spend_only";

export interface ProjectFunnelEntry {
  /** campaign_path — the row grain (NOT the 4-value brand `funnel` column). */
  funnelId: string;
  kind: ProjectEntryKind;
  enabled: boolean;
  cadence: Cadence;
  cadenceConfirmed: boolean;
  /** Media spend for the window (seeded from ledger.funnelResolvedSpend in
   * full_funnel_spend mode). The planning driver AND the share basis. */
  plannedBudget: number;
  targetCpaSeed: number | null;
  horizonPeriods: number;
  manualSeeds: ManualSeedOverrides;
  overrides: AssumptionPatch;
  extrapolation: ExtrapolationPolicyDescriptor;
  bonusEnabled: boolean;
  /** Funnel-specific one-offs — NEVER allocated across the project. */
  ownExtras: ExtraCostItem[];
  sourceScenarioId?: string;
  notes?: string;
  /** v2 calendar seam; always 0 in v1. */
  startDayOffset: 0;
}

// ---- CPA re-basing (§5a) ---------------------------------------------------------

/** The trap the full-spend correction creates: the engine computes
 * trials = plannedBudget / targetCpa. Raising the budget to FULL resolved spend
 * while leaving targetCpa on the ATTRIBUTED basis would project more trials from
 * wasted spend. Budget and CPA must share one basis, so trials reproduce the
 * observed count and the CPA honestly includes waste. */
export function rebaseCpaSeed(input: {
  mode: SpendBasisMode;
  ledger: Pick<FunnelSpendLedger, "funnelResolvedSpend" | "userAttributedSpend">;
  observedTrials: number;
  attributedTrials: number;
}): { plannedBudget: number; targetCpaSeed: number } | null {
  const spend = input.mode === "full_funnel_spend"
    ? input.ledger.funnelResolvedSpend
    : input.ledger.userAttributedSpend;
  const trials = input.mode === "full_funnel_spend" ? input.observedTrials : input.attributedTrials;
  if (spend === null || spend <= 0 || trials <= 0) return null;
  return { plannedBudget: spend, targetCpaSeed: spend / trials };
}

// ---- Overhead shares (§10.4) -----------------------------------------------------

export interface OverheadShareInput {
  funnelId: string;
  kind: ProjectEntryKind;
  /** resolved_spend_share basis value: plannedBudget for forecast rows (equals the
   * resolved spend until the operator edits it — the budget IS the forward spend),
   * funnelResolvedSpend for spend_only rows (they have no budget concept). */
  spendBasisValue: number;
  /** trial_share basis; ignored otherwise. 0 for spend_only rows. */
  projectedTrials: number;
}

/** Deterministic share vector over ALL enabled spend-bearing rows — forecast and
 * spend_only alike (rev. 3 correction 2). clamp01 is mandatory: the engine asserts
 * share ≤ 1 and float renormalization can produce 1.0000000000000002. The
 * largest-remainder step makes Σ shares === 1 to the last ulp, so
 * Σ (pool × share) === pool within a cent. */
export function computeOverheadShares(
  rows: ReadonlyArray<OverheadShareInput>,
  policy: Pick<ProjectAggregationPolicy, "allocation">,
): Record<string, number> {
  const ordered = [...rows].sort((a, b) => (a.funnelId < b.funnelId ? -1 : a.funnelId > b.funnelId ? 1 : 0));
  const raw = ordered.map((row) => {
    switch (policy.allocation.basis) {
      case "resolved_spend_share": return row.spendBasisValue;
      case "trial_share": return row.kind === "forecast" ? row.projectedTrials : 0;
      case "equal": return 1;
      case "manual": return policy.allocation.manualShares?.[row.funnelId] ?? 0;
    }
  });
  const denom = raw.reduce((sum, value) => sum + value, 0);
  if (!(denom > 0)) {
    throw new ForecastInputError("policy.allocation", "share denominator is zero — no allocable rows");
  }
  const shares = raw.map((value) => clamp01(value / denom));
  const residual = 1 - shares.reduce((sum, value) => sum + value, 0);
  if (residual !== 0 && shares.length > 0) {
    let largest = 0;
    for (let index = 1; index < shares.length; index += 1) {
      if (shares[index] > shares[largest]) largest = index;
    }
    shares[largest] = clamp01(shares[largest] + residual);
  }
  const result: Record<string, number> = {};
  ordered.forEach((row, index) => { result[row.funnelId] = shares[index]; });
  return result;
}

// ---- Provisional flags -----------------------------------------------------------

/** Why a spend-derived number cannot be taken at face value. Rendered as ᵖ markers
 * and named banners; persisted so a saved provisional project is visible as such
 * in the list without opening it. */
export interface ProvisionalFlags {
  spendIncomplete: boolean;
  attributedOnlyMode: boolean;
  unresolvedCommission: boolean;
  unconfirmedCadenceBudgetShare: number;
}

export function deriveProvisionalFlags(input: {
  windowLedger: WindowSpendLedger;
  scope: ProjectSpendScope;
  policy: Pick<ProjectAggregationPolicy, "spendBasis">;
  entries: ReadonlyArray<Pick<ProjectFunnelEntry, "enabled" | "cadenceConfirmed" | "plannedBudget">>;
}): ProvisionalFlags {
  const enabled = input.entries.filter((entry) => entry.enabled);
  const totalBudget = enabled.reduce((sum, entry) => sum + entry.plannedBudget, 0);
  const unconfirmedBudget = enabled
    .filter((entry) => !entry.cadenceConfirmed)
    .reduce((sum, entry) => sum + entry.plannedBudget, 0);
  return {
    spendIncomplete: input.windowLedger.spendIncomplete,
    attributedOnlyMode: input.policy.spendBasis === "attributed_only",
    unresolvedCommission: input.scope.unresolvedCommissionSpend > 0,
    unconfirmedCadenceBudgetShare: totalBudget > 0 ? unconfirmedBudget / totalBudget : 0,
  };
}

// ---- The saved entity ------------------------------------------------------------

export interface ProjectSeedEvidence {
  coverage: DataCoverage;
  warnings: DataWarning[];
  observedTrials: number;
  cpaBasis: "full_resolved" | "attributed" | "manual";
}

export interface ProjectForecast {
  schemaVersion: number;
  engineVersion: string;
  forecastModel: ProjectForecastModel;
  id: string;
  name: string;
  notes?: string;
  /** asOf is load-bearing: the actuals deriver's maturity gating depends on it,
   * and it is NOT part of FrozenForecastInputs — hence persisted here. */
  source: { window: DateWindow; asOf: string; dataSource: "clickhouse" | "legacy" };
  entries: ProjectFunnelEntry[];
  windowLedger: WindowSpendLedger;
  funnelLedgers: Record<string, FunnelSpendLedger>;
  sharedCosts: SharedCostPool;
  policy: ProjectAggregationPolicy;
  /** Replayable snapshot for forecast entries — shares and the prorated pool are
   * baked into each blob, so later config changes cannot move a saved project. */
  frozen: Record<string, FrozenForecastInputs>;
  seedEvidence: Record<string, ProjectSeedEvidence>;
  resolvedAt: string;
  createdAt: string;
  updatedAt: string;
}
