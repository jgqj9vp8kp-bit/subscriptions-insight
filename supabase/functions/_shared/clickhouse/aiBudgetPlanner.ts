// AI Budget Planner (brief §20): deterministic allocation of ADDITIONAL budget
// across the engine's SCALE candidates.
//
// Strictly downstream of the signal engine: only campaigns/funnels the ladder
// already marked SCALE are eligible (the planner never overrides a verdict),
// each candidate's intake is capped by its recommended step (budgetDeltaPct ×
// current spend × a 2x relaxation), and what cannot be placed goes to Reserve.
// Projection is a LINEAR extrapolation of observed economics — no saturation
// modelling — and says so in its notes. No model call anywhere.
//
// Pure module: no Deno, no fetch, no clock.

import type { AiConfidence, AiRecommendation } from "./aiSignals.ts";
import type { FbAnalyticsRow } from "./fbAnalyticsCompute.ts";

export type BudgetGoal = "profit" | "payback" | "risk";

export interface BudgetCandidate {
  scopeKey: string;
  scopeLabel: string;
  /** Recommended step from the engine (SCALE +10/+20). */
  budgetDeltaPct: number;
  confidence: AiConfidence;
  confidenceScore: number;
  /** Current spend over the analyzed period. */
  spend: number;
  /** Cost per trial (the ladder's CPA). */
  cpa: number | null;
  /** Observed net revenue per trial over the period. */
  netPerTrial: number | null;
  /** Observed net / spend — the profit-per-dollar axis. */
  ltvCpa: number | null;
  /** Days to recover CPA when known (path grain); campaigns usually null. */
  paybackDays: number | null;
}

export interface BudgetAllocation extends BudgetCandidate {
  amount: number;
  share: number;
  expectedTrials: number | null;
  expectedNet: number | null;
  expectedProfitUplift: number | null;
}

export interface BudgetPlan {
  goal: BudgetGoal;
  budget: number;
  allocations: BudgetAllocation[];
  reserve: number;
  projected: {
    addedTrials: number;
    addedNet: number;
    /** Σ(expectedNet − amount) over allocations with known economics. */
    profitUplift: number;
    currentProfit: number | null;
    newProfit: number | null;
    /** Spend-weighted mean payback over candidates that know theirs. */
    currentPaybackDays: number | null;
    newPaybackDays: number | null;
  };
  notes: string[];
}

const CAP_STEP_MULTIPLIER = 2; // at most double the engine's recommended step
const MIN_ALLOCATION = 250; // below this an allocation is noise, keep it in Reserve
const ROUND_TO = 100;

/** Campaign row + its engine verdict → planner candidate; null unless the
 * verdict is SCALE with usable spend (the planner never invents candidates). */
export function budgetCandidateFromCampaignRow(row: FbAnalyticsRow, rec: AiRecommendation | null | undefined): BudgetCandidate | null {
  if (!rec || rec.action !== "SCALE" || rec.budgetDeltaPct == null) return null;
  if (row.spend == null || !Number.isFinite(row.spend) || row.spend <= 0) return null;
  const trials = row.trial_users;
  const netPerTrial = trials > 0 ? row.net_revenue / trials : null;
  return {
    scopeKey: rec.scope.kind === "campaign" ? `campaign|${rec.scope.campaignId}` : `path|${row.campaign_path}`,
    scopeLabel: row.campaign_name || row.campaign_id,
    budgetDeltaPct: rec.budgetDeltaPct,
    confidence: rec.confidence,
    confidenceScore: rec.confidenceScore,
    spend: row.spend,
    cpa: row.cac,
    netPerTrial,
    ltvCpa: row.spend > 0 ? row.net_revenue / row.spend : null,
    paybackDays: null,
  };
}

function goalOrder(goal: BudgetGoal): (a: BudgetCandidate, b: BudgetCandidate) => number {
  if (goal === "payback") {
    return (a, b) =>
      (a.paybackDays ?? Infinity) - (b.paybackDays ?? Infinity) ||
      (b.ltvCpa ?? -Infinity) - (a.ltvCpa ?? -Infinity) ||
      a.scopeKey.localeCompare(b.scopeKey);
  }
  if (goal === "risk") {
    return (a, b) =>
      b.confidenceScore - a.confidenceScore ||
      (b.ltvCpa ?? -Infinity) - (a.ltvCpa ?? -Infinity) ||
      a.scopeKey.localeCompare(b.scopeKey);
  }
  return (a, b) =>
    (b.ltvCpa ?? -Infinity) - (a.ltvCpa ?? -Infinity) ||
    b.confidenceScore - a.confidenceScore ||
    a.scopeKey.localeCompare(b.scopeKey);
}

function roundDown(value: number): number {
  return Math.floor(value / ROUND_TO) * ROUND_TO;
}

export function planBudget(input: {
  budget: number;
  goal: BudgetGoal;
  candidates: readonly BudgetCandidate[];
  /** Current-period totals of the WHOLE visible set (profit baseline). */
  totals?: { spend: number; netRevenue: number } | null;
}): BudgetPlan {
  const notes: string[] = [
    "Linear extrapolation of observed economics — saturation and auction effects are not modelled.",
    "Only campaigns the engine already marked SCALE are eligible; everything else stays in Reserve.",
  ];
  const budget = Number.isFinite(input.budget) && input.budget > 0 ? input.budget : 0;
  const ordered = [...input.candidates].sort(goalOrder(input.goal));
  if (input.goal === "payback" && ordered.every((candidate) => candidate.paybackDays == null)) {
    notes.push("No candidate carries an observed payback — ranked by net/spend instead.");
  }

  let remaining = budget;
  const allocations: BudgetAllocation[] = [];
  for (const candidate of ordered) {
    if (remaining < MIN_ALLOCATION) break;
    const cap = roundDown(candidate.spend * (candidate.budgetDeltaPct / 100) * CAP_STEP_MULTIPLIER);
    const amount = Math.min(cap, roundDown(remaining));
    if (amount < MIN_ALLOCATION) continue;
    const expectedTrials = candidate.cpa != null && candidate.cpa > 0 ? amount / candidate.cpa : null;
    const expectedNet = expectedTrials != null && candidate.netPerTrial != null ? expectedTrials * candidate.netPerTrial : null;
    allocations.push({
      ...candidate,
      amount,
      share: budget > 0 ? amount / budget : 0,
      expectedTrials: expectedTrials != null ? Math.round(expectedTrials) : null,
      expectedNet: expectedNet != null ? Math.round(expectedNet * 100) / 100 : null,
      expectedProfitUplift: expectedNet != null ? Math.round((expectedNet - amount) * 100) / 100 : null,
    });
    remaining -= amount;
  }
  const reserve = Math.round(remaining * 100) / 100;
  if (reserve > 0 && allocations.length) {
    notes.push("Reserve is budget the SCALE caps could not absorb — raising steps beyond the engine's recommendation is not the planner's call.");
  }

  const addedTrials = allocations.reduce((sum, a) => sum + (a.expectedTrials ?? 0), 0);
  const addedNet = allocations.reduce((sum, a) => sum + (a.expectedNet ?? 0), 0);
  const profitUplift = allocations.reduce((sum, a) => sum + (a.expectedProfitUplift ?? 0), 0);
  const currentProfit = input.totals ? Math.round((input.totals.netRevenue - input.totals.spend) * 100) / 100 : null;

  const withPayback = input.candidates.filter((c) => c.paybackDays != null && c.spend > 0);
  const weighted = (extra: (c: BudgetCandidate) => number) => {
    const totalSpend = withPayback.reduce((sum, c) => sum + c.spend + extra(c), 0);
    if (totalSpend <= 0) return null;
    return Math.round(withPayback.reduce((sum, c) => sum + (c.paybackDays as number) * (c.spend + extra(c)), 0) / totalSpend);
  };
  const allocationByKey = new Map(allocations.map((a) => [a.scopeKey, a.amount]));

  return {
    goal: input.goal,
    budget,
    allocations,
    reserve,
    projected: {
      addedTrials,
      addedNet: Math.round(addedNet * 100) / 100,
      profitUplift: Math.round(profitUplift * 100) / 100,
      currentProfit,
      newProfit: currentProfit != null ? Math.round((currentProfit + profitUplift) * 100) / 100 : null,
      currentPaybackDays: weighted(() => 0),
      newPaybackDays: weighted((c) => allocationByKey.get(c.scopeKey) ?? 0),
    },
    notes,
  };
}
