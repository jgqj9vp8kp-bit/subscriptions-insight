// Domain contracts for the FunnelEconomics platform module (Forecasting redesign v3, P1).
//
// Every persisted or engine-facing shape here is plain JSON-serializable data: no
// functions, no class instances, no runtime Dates (ISO strings only). Policies enter
// the engine as serialized DESCRIPTORS resolved by the closed typed registry in
// funnelEconomicsStrategies.ts — never as functions stored in state.
//
// The engine (funnelEconomicsEngine.ts) is a platform module: Planning, Simulation,
// Compare and future consumers (budget planner, goal-seek, sensitivity) all run the
// same FrozenForecastInputs → engine → ForecastResult flow. It must never import
// Forecasting-page code, React, or data-source clients.

export const FORECAST_SCHEMA_VERSION = 1;
export const ENGINE_VERSION = "1.0.0";

// ---- Provenance ------------------------------------------------------------------

export type Provenance =
  | "actual"
  | "auto_derived"
  | "manual_override"
  | "config"
  | "extrapolated"
  | "calculated";

/** Field-path → provenance. Paths follow the assumption tree, e.g. "traffic.targetCpa". */
export type ProvenanceMap = Record<string, Provenance>;

export interface EntityRef {
  id: string;
  version?: number;
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

// ---- Pricing ---------------------------------------------------------------------

export type Cadence = "monthly" | "weekly" | "quarterly" | "annual" | "custom";

export interface PeriodSpec {
  /** 0 = trial period. */
  index: number;
  label: string;
  durationDays: number;
  /** "none" → no charge fires this period (users may still be tracked). */
  billingEvent: "on_period_start" | "none";
  /** Price billed for this period. Period 0 = trial price; later periods may step. */
  price: number;
}

export interface PeriodSchedule {
  cadence: Cadence;
  periods: PeriodSpec[];
}

/** Reusable pricing entity (persisted). Scenarios snapshot the resolved schedule. */
export interface PricingModel {
  id: string;
  name: string;
  cadence: Cadence;
  periodSchedule: PeriodSchedule;
  trial: { price: number; durationDays: number; paid: boolean };
  version: number;
  visibility: "personal" | "shared";
  createdAt: string;
  updatedAt: string;
}

const CADENCE_DAYS: Record<Cadence, number> = {
  monthly: 30,
  weekly: 7,
  quarterly: 90,
  annual: 365,
  custom: 30,
};

function periodLabel(cadence: Cadence, paidIndex: number): string {
  // Workbook labeling: monthly "M1..M11" for paid periods; weekly columns are
  // titled "W2..W24" (the trial column is week 1), preserved here for parity.
  switch (cadence) {
    case "monthly": return `M${paidIndex}`;
    case "weekly": return `W${paidIndex + 1}`;
    case "quarterly": return `Q${paidIndex}`;
    case "annual": return `Y${paidIndex}`;
    default: return `P${paidIndex}`;
  }
}

/** Build a Trial + N-paid-periods schedule (single recurring price or per-period prices). */
export function buildPeriodSchedule(input: {
  cadence: Cadence;
  paidPeriods: number;
  trialPrice: number;
  periodPrice: number | number[];
  periodDurationDays?: number;
  trialDurationDays?: number;
}): PeriodSchedule {
  const duration = input.periodDurationDays ?? CADENCE_DAYS[input.cadence];
  const prices = Array.isArray(input.periodPrice)
    ? input.periodPrice
    : Array.from({ length: input.paidPeriods }, () => input.periodPrice);
  const periods: PeriodSpec[] = [{
    index: 0,
    label: "Trial",
    durationDays: input.trialDurationDays ?? duration,
    billingEvent: "on_period_start",
    price: input.trialPrice,
  }];
  for (let paid = 1; paid <= input.paidPeriods; paid += 1) {
    periods.push({
      index: paid,
      label: periodLabel(input.cadence, paid),
      durationDays: duration,
      billingEvent: "on_period_start",
      price: prices[paid - 1] ?? prices[prices.length - 1] ?? 0,
    });
  }
  return { cadence: input.cadence, periods };
}

// ---- Retention -------------------------------------------------------------------

export type RetentionCurveSource =
  | "historical_actuals"
  | "manual"
  | "benchmark"
  | "scenario_override"
  | "cloned";

/** Reusable survival-curve entity (persisted). survival[t] pairs with schedule period t; survival[0] = 1. */
export interface RetentionCurve {
  id: string;
  name: string;
  cadence: Cadence;
  source: RetentionCurveSource;
  survival: number[];
  /** Number of leading periods backed by observed data (rest is extrapolated). */
  observedDepth: number;
  extrapolatedFrom: number;
  extrapolationMethod: ExtrapolationMethod;
  funnelId?: string;
  window?: DateWindow;
  version: number;
  clonedFromId?: string;
  createdAt: string;
  updatedAt: string;
}

// ---- Revenue streams & costs -----------------------------------------------------

export type RevenueStreamKey = "trial" | "subscription" | "upsell" | "token";

export interface UpsellTier {
  key: string;
  takeRate: number;
  price: number;
}

export interface FeeApplicability {
  stripe: boolean;
  refund: boolean;
  provider: boolean;
}

/** Which payment deductions hit which revenue stream. Workbook default: all fees on
 * trial+subscription+upsell. Token treatment is an UNRESOLVED business decision
 * (spec Q12): the provisional default mirrors subscription and the engine emits a
 * warning whenever token revenue is non-zero. */
export type FeeApplicabilityMatrix = Record<RevenueStreamKey, FeeApplicability>;

export function defaultFeeApplicability(): FeeApplicabilityMatrix {
  const all = (): FeeApplicability => ({ stripe: true, refund: true, provider: true });
  return { trial: all(), subscription: all(), upsell: all(), token: all() };
}

export type AllocationMode =
  | "exclude"
  | "fixed_amount"
  | "percentage"
  | "by_spend_share"
  | "by_trial_share"
  | "manual";

/** Share-based modes receive their share pre-computed by the resolver (the pure
 * engine has no portfolio context to derive it from). */
export interface OverheadAllocation {
  mode: AllocationMode;
  /** fixed_amount / manual: the allocated amount (fixed_amount defaults to the raw fixed sum). */
  amount?: number;
  /** percentage mode: fraction [0..1] of the raw fixed sum. */
  percentage?: number;
  /** by_spend_share / by_trial_share: fraction [0..1] resolved upstream. */
  share?: number;
}

export interface ExtraCostItem {
  key: string;
  label: string;
  amount: number;
}

/** Reusable cost/fee configuration entity (persisted). */
export interface CostModel {
  id: string;
  name: string;
  version: number;
  fees: {
    trafficCommission: number;
    stripeCommission: number;
    providerCommission: number;
    refundRate: number;
  };
  feeApplicability: FeeApplicabilityMatrix;
  fixed: { ffBilling: number; funnelConstructor: number; payroll: number };
  overheadAllocation: OverheadAllocation;
  bonusPolicyRef?: EntityRef;
  createdAt: string;
  updatedAt: string;
}

// ---- Policy descriptors (serialized; resolved by the strategy registry) ----------

export type BonusPolicyKind = "media_buyer_v1" | "none";

/** Media-buyer bonus is a company compensation policy, not engine math. Workbook
 * rule (media_buyer_v1): rate = max(0, base + (target − cpa/firstPaidConversion)·slope),
 * cost = basis_amount · rate. Defaults follow the workbook: basis = planned budget
 * (Q11 pending), inputs = the scenario's planned CPA / first-paid conversion (Q10 pending). */
export interface BonusPolicyDescriptor {
  kind: BonusPolicyKind;
  version: number;
  enabled: boolean;
  params: {
    base: number;
    target: number;
    slope: number;
    basis?: "budget" | "traffic_cost";
  };
}

export type ExtrapolationMethod = "geometric_last" | "geometric_avg" | "flat" | "manual";

/** Survival-tail extrapolation past the observed depth:
 *  - geometric_last: repeat the last observed survival multiplier;
 *  - geometric_avg: repeat the geometric mean of the last `window` observed multipliers;
 *  - flat: no further churn (multiplier 1) — optimistic bound;
 *  - manual: values must already cover the horizon (extrapolation is an error). */
export interface ExtrapolationPolicyDescriptor {
  method: ExtrapolationMethod;
  params?: { window?: number };
}

/** Engine computes at full precision by default; "period_2dp" applies the workbook's
 * half-up 2-decimal normalization per period line (documented parity mode only). */
export interface RoundingPolicyDescriptor {
  mode: "full_precision" | "period_2dp";
}

export interface PolicyDescriptors {
  bonus: BonusPolicyDescriptor;
  extrapolation: ExtrapolationPolicyDescriptor;
  rounding: RoundingPolicyDescriptor;
}

// ---- Assumption tree (resolved) --------------------------------------------------

export interface TrafficAssumptionsResolved {
  plannedBudget: number;
  targetCpa: number;
  trafficCommission: number;
}

export interface PricingAssumptionsResolved {
  schedule: PeriodSchedule;
}

export interface RetentionAssumptionsResolved {
  /** Index-aligned with schedule.periods; survival[0] must be 1 (trial period). */
  survival: number[];
  observedDepth: number;
}

export interface MonetizationAssumptionsResolved {
  /** Charged once, in the trial period (workbook model). */
  upsells: UpsellTier[];
  tokenArpuPerTrial: number;
  /** Per-period hold of token ARPU: token[t] = trials·arpu·hold^t (0 → one-shot at t=0). */
  tokenArpuHold: number;
}

export interface CostAssumptionsResolved {
  stripeCommission: number;
  refundRate: number;
  providerCommission: number;
  feeApplicability: FeeApplicabilityMatrix;
  fixed: { ffBilling: number; funnelConstructor: number; payroll: number };
  overheadAllocation: OverheadAllocation;
  extraCosts: ExtraCostItem[];
}

export interface ForecastAssumptionsResolved {
  traffic: TrafficAssumptionsResolved;
  pricing: PricingAssumptionsResolved;
  retention: RetentionAssumptionsResolved;
  monetization: MonetizationAssumptionsResolved;
  costs: CostAssumptionsResolved;
}

/** Typed override patch over the resolved tree (scenario bindings / manual edits). */
export type AssumptionPatch = DeepPartial<ForecastAssumptionsResolved>;

// ---- Frozen inputs (the serializable engine payload) -----------------------------

export interface FrozenForecastInputs {
  schemaVersion: number;
  engineVersion: string;
  resolvedAt: string;
  assumptions: ForecastAssumptionsResolved;
  provenance: ProvenanceMap;
  policyDescriptors: PolicyDescriptors;
}

// ---- Result subdomains -----------------------------------------------------------

export interface EngineWarning {
  code: string;
  message: string;
}

export interface ForecastPeriodRow {
  index: number;
  label: string;
  /** Day offsets from cohort start: [dayStart, dayEnd) by schedule durations. */
  dayStart: number;
  dayEnd: number;
  users: number;
  survival: number;
  cumulativeRetention: number;
  revenue: { trial: number; subscription: number; upsell: number; token: number; gross: number };
  costs: { stripe: number; refund: number; provider: number; paymentTotal: number };
  paymentNetRevenue: number;
  cumulativePaymentNetRevenue: number;
  cashFlowBalance: number;
}

export interface ForecastResult {
  timeline: { periods: ForecastPeriodRow[] };
  revenue: {
    trialTotal: number;
    subscriptionTotal: number;
    upsellByTier: Array<{ key: string; revenue: number }>;
    upsellTotal: number;
    tokenTotal: number;
    grossByPeriod: number[];
    grossTotal: number;
  };
  costs: {
    stripeTotal: number;
    refundTotal: number;
    providerTotal: number;
    paymentCostsTotal: number;
    trafficCashOutflow: number;
    performanceBonus: number;
    overheadRaw: { ffBilling: number; funnelConstructor: number; payroll: number };
    allocatedOverhead: number;
    extraTotal: number;
  };
  profitability: {
    paymentNetRevenueTotal: number;
    contributionProfit: number;
    netProfit: number;
  };
  payback: {
    paybackPeriodIndex: number | null;
    paybackDay: number | null;
    noPaybackWithinHorizon: boolean;
    cashFlowBalanceByPeriod: number[];
    finalCashFlowBalance: number;
  };
  metrics: {
    trials: number;
    grossLtv: number;
    contributionLtv: number;
    fullyLoadedLtv: number;
    roas: number;
    romi: number;
    roi: number;
    contributionMargin: number | null;
    cpa: number;
    cac: number;
  };
  provenance: ProvenanceMap;
  warnings: EngineWarning[];
}

// ---- Validation error ------------------------------------------------------------

/** Explicit input failure — the engine never substitutes silent zeroes. */
export class ForecastInputError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ForecastInputError";
    this.path = path;
  }
}

// ---- Historical facts & provider boundary (P3 contracts) -------------------------

export interface DateWindow {
  from: string;
  to: string;
}

export type HistoricalWindowPolicy =
  | { kind: "fixed"; window: DateWindow }
  | { kind: "last_days"; days: number }
  | { kind: "maturity_filtered"; minMaturityDays: number };

export type TrafficChannel = "facebook" | string;

/** Immutable observed facts for one funnel + window. Missing facts are null/omitted —
 * NEVER zero (a provider returning zeroed facts is a contract violation). */
export interface FunnelActuals {
  funnelId: string;
  window: DateWindow;
  maturityDays: number;
  trials: number;
  spend: number | null;
  cpaActual: number | null;
  trialPriceActual: number | null;
  subPriceActual: number | null;
  firstPaidConversion: number | null;
  /** Cycle conversion chain: [c1→2, c2→3, …], observed depth only. */
  renewalConversions: number[];
  observedRetentionDepth: number;
  upsellTiersActual: Array<{ takeRate: number; price: number; revenue: number }>;
  tokenArpuPerTrialActual: number | null;
  refundRateActual: number | null;
  realizedRevenueByDay: Array<{ day: number; cumulativeNet: number }>;
  realizedPaybackDay: number | null;
}

export interface DataCoverage {
  cohorts: number;
  trialUsers: number;
  spendCoverage: number | null;
  observedRetentionDepth: number;
  maturityDays: number;
}

export interface DataWarning {
  code: string;
  message: string;
}

export interface SourceMetadata {
  source: string;
  generatedAt: string;
  windowResolved: DateWindow | null;
}

export interface FunnelActualsRequest {
  funnelId: string;
  windowPolicy: HistoricalWindowPolicy;
  pricingCadence?: Cadence;
  trafficChannels?: TrafficChannel[];
}

export interface FunnelActualsResult {
  actuals: FunnelActuals | null;
  coverage: DataCoverage;
  warnings: DataWarning[];
  sourceMetadata: SourceMetadata;
}

export interface FunnelActualsProvider {
  getFunnelActuals(request: FunnelActualsRequest): Promise<FunnelActualsResult>;
}

// ---- FunnelProfile & scenario (persistence contracts) ----------------------------

/** Per-funnel default economics configuration — bridges the lightweight Funnels
 * Registry and Forecasting. Missing values fall through resolution precedence:
 * global config → FunnelProfile → auto-derived actuals → bindings → manual. */
export interface FunnelProfile {
  id: string;
  funnelId: string;
  pricingModelRef?: EntityRef;
  retentionCurveRef?: EntityRef;
  costModelRef?: EntityRef;
  bonusPolicyRef?: EntityRef;
  defaultHorizon?: number;
  historicalWindowPolicy?: HistoricalWindowPolicy;
  overheadAllocationMode?: AllocationMode;
  preferredBaselineScenarioId?: string;
  defaultTrafficChannels?: TrafficChannel[];
  notes?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ScenarioType {
  key: string;
  label: string;
}

export interface ScenarioBindings {
  funnelProfileRef?: EntityRef;
  pricingModelRef?: EntityRef;
  retentionCurveRef?: EntityRef;
  costModelRef?: EntityRef;
  bonusPolicyRef?: EntityRef;
  baseFunnelWindow?: DateWindow;
  overrides: AssumptionPatch;
}

/** Saved/temporary projection. `frozen` is the immutable snapshot the engine runs —
 * editing shared entities never silently rewrites it ("Refresh from sources" only). */
export interface ForecastScenario {
  id: string;
  name: string;
  notes?: string;
  funnelId: string;
  scenarioType: ScenarioType;
  horizon: { periods: number };
  bindings: ScenarioBindings;
  frozen: FrozenForecastInputs;
  sourceScenarioId?: string;
  ownerId: string;
  visibility: "personal" | "shared";
  createdAt: string;
  updatedAt: string;
}

// ---- Comparison (P5 contracts) ---------------------------------------------------

export type MetricDirection = "higher_is_better" | "lower_is_better" | "neutral";

export interface MetricSpec {
  key: string;
  label: string;
  direction: MetricDirection;
  format: "currency" | "percent" | "number" | "days" | "ratio";
}

export interface ScenarioComparison {
  baselineId: string;
  scenarios: Array<{ id: string; result: ForecastResult }>;
  metrics: MetricSpec[];
  deltas: Record<string, Record<string, { abs: number; pct: number | null }>>;
}
