// AssumptionBuilder — resolves layered defaults into a ForecastAssumptionsResolved
// tree with per-field provenance (v3 spec §6/§8).
//
// Precedence (field-level, not one blind rule):
//   global config defaults → FunnelProfile defaults → auto-derived actuals
//   → manual overrides (AssumptionPatch)
// autoSeed fields (volatile economics: prices, retention curve, upsell take rates,
// refund rate, token ARPU, CPA) let fresh actuals override profile defaults;
// structural fields (cadence, horizon, allocation mode, fee constants) are pinned
// by config/profile and never re-derived from data.
import {
  ForecastInputError,
  buildPeriodSchedule,
  defaultFeeApplicability,
  type AllocationMode,
  type AssumptionPatch,
  type Cadence,
  type DataWarning,
  type ExtrapolationPolicyDescriptor,
  type ForecastAssumptionsResolved,
  type FunnelActuals,
  type ProvenanceMap,
  type UpsellTier,
} from "./funnelEconomicsTypes.ts";
import { resolveSurvivalExtrapolator } from "./funnelEconomicsStrategies.ts";

/** Global configuration defaults (workbook constants). Every value is CONFIG-provenance. */
export interface GlobalForecastDefaults {
  trafficCommission: number;
  stripeCommission: number;
  providerCommission: number;
  refundRate: number;
  fixed: { ffBilling: number; funnelConstructor: number; payroll: number };
  overheadAllocationMode: AllocationMode;
  horizonByCadence: Partial<Record<Cadence, number>>;
  tokenArpuHold: number;
}

export function workbookGlobalDefaults(): GlobalForecastDefaults {
  return {
    trafficCommission: 0.04,
    stripeCommission: 0.07,
    providerCommission: 0.059,
    refundRate: 0.1,
    fixed: { ffBilling: 5000, funnelConstructor: 2271.36, payroll: 9000 },
    overheadAllocationMode: "fixed_amount",
    horizonByCadence: { monthly: 12, weekly: 24, quarterly: 4, annual: 3 },
    tokenArpuHold: 0,
  };
}

/** The subset of FunnelProfile defaults the builder consumes (already loaded/resolved). */
export interface ProfileSeedDefaults {
  horizonPeriods?: number;
  overheadAllocationMode?: AllocationMode;
  trialPrice?: number;
  periodPrice?: number;
  survival?: number[];
}

/** Scalar manual overrides for the seed-level drivers (what the UI edits field-by-field).
 * Applied with manual_override provenance BEFORE the schedule is built; the tree-level
 * `overrides` patch still applies afterwards for everything else. */
export interface ManualSeedOverrides {
  targetCpa?: number;
  trialPrice?: number;
  periodPrice?: number;
  survival?: number[];
}

export interface AssumptionSeedInput {
  cadence: Cadence;
  /** The planning driver — always supplied by the scenario (budget being planned). */
  plannedBudget: number;
  horizonPeriods?: number;
  defaults?: Partial<GlobalForecastDefaults>;
  profile?: ProfileSeedDefaults;
  actuals?: FunnelActuals | null;
  manual?: ManualSeedOverrides;
  extrapolation?: ExtrapolationPolicyDescriptor;
  overrides?: AssumptionPatch;
}

export interface BuiltAssumptions {
  assumptions: ForecastAssumptionsResolved;
  provenance: ProvenanceMap;
  warnings: DataWarning[];
}

function firstDefined<T>(...values: Array<T | null | undefined>): T | undefined {
  for (const value of values) if (value !== null && value !== undefined) return value;
  return undefined;
}

export function buildForecastAssumptions(input: AssumptionSeedInput): BuiltAssumptions {
  const defaults: GlobalForecastDefaults = { ...workbookGlobalDefaults(), ...input.defaults };
  const provenance: ProvenanceMap = {};
  const warnings: DataWarning[] = [];
  const actuals = input.actuals ?? null;

  const horizonPeriods = input.horizonPeriods
    ?? input.profile?.horizonPeriods
    ?? defaults.horizonByCadence[input.cadence]
    ?? 12;
  if (horizonPeriods < 1) throw new ForecastInputError("pricing.schedule", "horizon must contain at least the trial period");

  // ---- Traffic (CPA is autoSeed; budget is the plan driver) ----------------------
  const targetCpa = firstDefined(input.manual?.targetCpa, actuals?.cpaActual);
  provenance["traffic.plannedBudget"] = "manual_override";
  provenance["traffic.trafficCommission"] = "config";
  if (input.manual?.targetCpa !== undefined) provenance["traffic.targetCpa"] = "manual_override";
  else if (targetCpa !== undefined) provenance["traffic.targetCpa"] = "auto_derived";

  // ---- Pricing (autoSeed prices; structure from cadence/horizon) -----------------
  const trialPrice = firstDefined(input.manual?.trialPrice, actuals?.trialPriceActual, input.profile?.trialPrice);
  const periodPrice = firstDefined(input.manual?.periodPrice, actuals?.subPriceActual, input.profile?.periodPrice);
  provenance["pricing.trialPrice"] = input.manual?.trialPrice !== undefined
    ? "manual_override"
    : actuals?.trialPriceActual != null ? "auto_derived" : "config";
  provenance["pricing.periodPrice"] = input.manual?.periodPrice !== undefined
    ? "manual_override"
    : actuals?.subPriceActual != null ? "auto_derived" : "config";

  // ---- Retention (autoSeed curve, extrapolated to horizon) -----------------------
  let observed: number[] | undefined;
  let observedProvenance: "auto_derived" | "config" | "manual_override" | undefined;
  if (input.manual?.survival && input.manual.survival.length > 0) {
    observed = [...input.manual.survival];
    observedProvenance = "manual_override";
  } else if (actuals?.firstPaidConversion != null) {
    observed = [1, actuals.firstPaidConversion, ...actuals.renewalConversions];
    observedProvenance = "auto_derived";
  } else if (input.profile?.survival && input.profile.survival.length > 0) {
    observed = [...input.profile.survival];
    observedProvenance = "config";
  }

  // ---- Monetization (autoSeed) ---------------------------------------------------
  const upsells: UpsellTier[] = (actuals?.upsellTiersActual ?? []).map((tier, index) => ({
    key: `upsell_${index + 1}`,
    takeRate: tier.takeRate,
    price: tier.price,
  }));
  if (actuals?.upsellTiersActual?.length) provenance["monetization.upsells"] = "auto_derived";
  const tokenArpuPerTrial = actuals?.tokenArpuPerTrialActual ?? 0;
  provenance["monetization.tokenArpuPerTrial"] = actuals?.tokenArpuPerTrialActual != null ? "auto_derived" : "config";
  provenance["monetization.tokenArpuHold"] = "config";

  // ---- Costs (refund autoSeed; fee constants + fixed costs are config) -----------
  const refundRate = actuals?.refundRateActual ?? defaults.refundRate;
  provenance["costs.refundRate"] = actuals?.refundRateActual != null ? "auto_derived" : "config";
  for (const path of ["costs.stripeCommission", "costs.providerCommission", "costs.fixed", "costs.overheadAllocation"]) {
    provenance[path] = "config";
  }

  const draft: ForecastAssumptionsResolved = {
    traffic: {
      plannedBudget: input.plannedBudget,
      targetCpa: targetCpa ?? Number.NaN,
      trafficCommission: defaults.trafficCommission,
    },
    pricing: {
      schedule: buildPeriodSchedule({
        cadence: input.cadence,
        paidPeriods: horizonPeriods - 1,
        trialPrice: trialPrice ?? Number.NaN,
        periodPrice: periodPrice ?? Number.NaN,
      }),
    },
    retention: {
      survival: observed ?? [],
      observedDepth: observed?.length ?? 0,
    },
    monetization: { upsells, tokenArpuPerTrial, tokenArpuHold: defaults.tokenArpuHold },
    costs: {
      stripeCommission: defaults.stripeCommission,
      refundRate,
      providerCommission: defaults.providerCommission,
      feeApplicability: defaultFeeApplicability(),
      fixed: { ...defaults.fixed },
      overheadAllocation: { mode: input.profile?.overheadAllocationMode ?? defaults.overheadAllocationMode },
      extraCosts: [],
    },
  };

  // ---- Manual overrides (highest precedence, typed patch) ------------------------
  if (input.overrides) applyAssumptionPatch(draft, input.overrides, provenance);

  // ---- Post-override validation of required seeds (fail loud, no silent zeroes) --
  if (!Number.isFinite(draft.traffic.targetCpa)) {
    throw new ForecastInputError("traffic.targetCpa", "no CPA available — no attributed spend in actuals and no manual override");
  }
  if (!Number.isFinite(draft.pricing.schedule.periods[0]?.price)) {
    throw new ForecastInputError("pricing.trialPrice", "no trial price available — provide actuals, a profile default, or an override");
  }
  if (draft.pricing.schedule.periods.slice(1).some((period) => !Number.isFinite(period.price))) {
    throw new ForecastInputError("pricing.periodPrice", "no subscription price available — provide actuals, a profile default, or an override");
  }
  if (draft.retention.survival.length === 0) {
    throw new ForecastInputError("retention.survival", "no retention curve available — provide actuals, a profile curve, or an override");
  }

  // ---- Extrapolate the curve to the horizon and tag observed vs extrapolated -----
  const horizon = draft.pricing.schedule.periods.length;
  const observedLength = Math.min(draft.retention.survival.length, horizon);
  const extrapolate = resolveSurvivalExtrapolator(input.extrapolation ?? { method: "geometric_last" });
  draft.retention.survival = extrapolate(draft.retention.survival, horizon);
  draft.retention.observedDepth = observedLength;
  const curveProvenance = provenance["retention.survival"] === "manual_override"
    ? "manual_override"
    : observedProvenance ?? "config";
  provenance["retention.survival"] = curveProvenance;
  for (let index = 0; index < horizon; index += 1) {
    provenance[`retention.survival[${index}]`] = index < observedLength ? curveProvenance : "extrapolated";
  }
  if (observedLength < horizon) {
    warnings.push({
      code: "retention_tail_extrapolated",
      message: `Survival periods ${observedLength}..${horizon - 1} are extrapolated (${(input.extrapolation ?? { method: "geometric_last" }).method}).`,
    });
  }

  return { assumptions: draft, provenance, warnings };
}

/** Deep-apply a typed patch onto the resolved tree, tagging each touched leaf path
 * as manual_override. Arrays and schedule objects are replaced wholesale. */
export function applyAssumptionPatch(
  target: ForecastAssumptionsResolved,
  patch: AssumptionPatch,
  provenance: ProvenanceMap,
): void {
  const merge = (node: Record<string, unknown>, patchNode: Record<string, unknown>, path: string): void => {
    for (const [key, value] of Object.entries(patchNode)) {
      if (value === undefined) continue;
      const childPath = path ? `${path}.${key}` : key;
      const current = node[key];
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        current !== null &&
        typeof current === "object" &&
        !Array.isArray(current)
      ) {
        merge(current as Record<string, unknown>, value as Record<string, unknown>, childPath);
      } else {
        node[key] = Array.isArray(value) ? [...value] : value;
        provenance[childPath] = "manual_override";
      }
    }
  };
  merge(target as unknown as Record<string, unknown>, patch as Record<string, unknown>, "");
}
