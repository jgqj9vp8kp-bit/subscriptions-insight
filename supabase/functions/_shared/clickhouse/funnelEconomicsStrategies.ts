// Closed typed strategy registry for the FunnelEconomics engine (v3 spec §12).
//
// Persisted snapshots store POLICY DESCRIPTORS (plain data: kind/version/params).
// This registry resolves a descriptor to a pure function immediately before the
// engine call. It is deliberately closed (no dynamic plugin loading): adding a
// policy kind = adding a branch here + its tests.
import {
  ENGINE_VERSION,
  FORECAST_SCHEMA_VERSION,
  ForecastInputError,
  type BonusPolicyDescriptor,
  type ExtrapolationPolicyDescriptor,
  type ForecastAssumptionsResolved,
  type FrozenForecastInputs,
  type PolicyDescriptors,
  type ProvenanceMap,
  type RoundingPolicyDescriptor,
} from "./funnelEconomicsTypes.ts";

export interface BonusContext {
  plannedBudget: number;
  trafficCashOutflow: number;
  targetCpa: number;
  firstPaidConversion: number;
}

export type BonusEvaluator = (ctx: BonusContext) => number;
export type SurvivalExtrapolator = (observed: number[], horizonPeriods: number) => number[];
export type PeriodRounder = (value: number) => number;

/** Runtime payload: the frozen snapshot plus its descriptors resolved to pure fns. */
export interface RuntimeForecastInputs {
  frozen: FrozenForecastInputs;
  bonusEvaluator: BonusEvaluator;
  roundPeriod: PeriodRounder;
}

// ---- Bonus -----------------------------------------------------------------------

export function resolveBonusEvaluator(descriptor: BonusPolicyDescriptor): BonusEvaluator {
  if (descriptor.kind === "none" || !descriptor.enabled) return () => 0;
  if (descriptor.kind === "media_buyer_v1") {
    const { base, target, slope, basis = "budget" } = descriptor.params;
    return (ctx) => {
      // No first-paid conversion → effective cost per first-paid subscriber is
      // infinite → the max(0, …) clamp yields no bonus. Explicit, not silent.
      if (!(ctx.firstPaidConversion > 0)) return 0;
      const effectiveCostPerFirstPaid = ctx.targetCpa / ctx.firstPaidConversion;
      const rate = Math.max(0, base + (target - effectiveCostPerFirstPaid) * slope);
      const baseAmount = basis === "traffic_cost" ? ctx.trafficCashOutflow : ctx.plannedBudget;
      return baseAmount * rate;
    };
  }
  throw new ForecastInputError("policyDescriptors.bonus.kind", `unknown bonus policy kind: ${String((descriptor as { kind: unknown }).kind)}`);
}

/** Workbook-parity bonus policy: budget · max(0, 1% + (45 − CPA/c1) · 0.4%). */
export function workbookBonusPolicy(): BonusPolicyDescriptor {
  return {
    kind: "media_buyer_v1",
    version: 1,
    enabled: true,
    params: { base: 0.01, target: 45, slope: 0.004, basis: "budget" },
  };
}

// ---- Survival-tail extrapolation -------------------------------------------------

export function resolveSurvivalExtrapolator(descriptor: ExtrapolationPolicyDescriptor): SurvivalExtrapolator {
  const method = descriptor.method;
  if (method === "manual") {
    return (observed, horizon) => {
      if (observed.length < horizon) {
        throw new ForecastInputError(
          "retention.survival",
          `manual extrapolation requires ${horizon} periods, got ${observed.length}`,
        );
      }
      return observed.slice(0, horizon);
    };
  }
  if (method === "geometric_last" || method === "geometric_avg" || method === "flat") {
    const window = Math.max(1, Math.floor(descriptor.params?.window ?? 3));
    return (observed, horizon) => {
      if (observed.length === 0) {
        throw new ForecastInputError("retention.survival", "cannot extrapolate an empty curve");
      }
      if (observed.length >= horizon) return observed.slice(0, horizon);
      let tail: number;
      if (method === "flat") {
        tail = 1;
      } else if (method === "geometric_last") {
        tail = observed[observed.length - 1];
      } else {
        const slice = observed.slice(Math.max(1, observed.length - window));
        const product = slice.reduce((acc, value) => acc * value, 1);
        tail = slice.length ? Math.pow(product, 1 / slice.length) : observed[observed.length - 1];
      }
      const extended = observed.slice();
      while (extended.length < horizon) extended.push(tail);
      return extended;
    };
  }
  throw new ForecastInputError("policyDescriptors.extrapolation.method", `unknown extrapolation method: ${String(method)}`);
}

// ---- Rounding --------------------------------------------------------------------

/** Workbook half-up 2-decimal normalization (floor(x·100 + 0.5)/100). */
function halfUp2dp(value: number): number {
  const sign = value < 0 ? -1 : 1;
  return sign * (Math.floor(Math.abs(value) * 100 + 0.5) / 100);
}

export function resolvePeriodRounder(descriptor: RoundingPolicyDescriptor): PeriodRounder {
  if (descriptor.mode === "full_precision") return (value) => value;
  if (descriptor.mode === "period_2dp") return halfUp2dp;
  throw new ForecastInputError("policyDescriptors.rounding.mode", `unknown rounding mode: ${String((descriptor as { mode: unknown }).mode)}`);
}

// ---- Defaults & preparation ------------------------------------------------------

export function defaultPolicyDescriptors(): PolicyDescriptors {
  return {
    bonus: workbookBonusPolicy(),
    extrapolation: { method: "geometric_last" },
    rounding: { mode: "full_precision" },
  };
}

/** Stamp a resolved assumption tree into a frozen, serializable snapshot. */
export function createFrozenForecastInputs(input: {
  assumptions: ForecastAssumptionsResolved;
  policyDescriptors?: Partial<PolicyDescriptors>;
  provenance?: ProvenanceMap;
  resolvedAt?: string;
}): FrozenForecastInputs {
  const defaults = defaultPolicyDescriptors();
  return {
    schemaVersion: FORECAST_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    resolvedAt: input.resolvedAt ?? new Date().toISOString(),
    assumptions: input.assumptions,
    provenance: input.provenance ?? {},
    policyDescriptors: {
      bonus: input.policyDescriptors?.bonus ?? defaults.bonus,
      extrapolation: input.policyDescriptors?.extrapolation ?? defaults.extrapolation,
      rounding: input.policyDescriptors?.rounding ?? defaults.rounding,
    },
  };
}

/** Resolve descriptors → pure fns. The ONLY place functions attach to inputs, and it
 * happens after deserialization, never before persistence. */
export function prepareRuntimeInputs(frozen: FrozenForecastInputs): RuntimeForecastInputs {
  if (frozen.schemaVersion !== FORECAST_SCHEMA_VERSION) {
    throw new ForecastInputError(
      "schemaVersion",
      `unsupported snapshot schema ${frozen.schemaVersion} (engine supports ${FORECAST_SCHEMA_VERSION}); migrate the scenario first`,
    );
  }
  return {
    frozen,
    bonusEvaluator: resolveBonusEvaluator(frozen.policyDescriptors.bonus),
    roundPeriod: resolvePeriodRounder(frozen.policyDescriptors.rounding),
  };
}
