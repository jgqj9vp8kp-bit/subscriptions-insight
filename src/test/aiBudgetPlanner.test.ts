// Budget Planner (brief §20): deterministic allocation over SCALE candidates —
// goal ordering, per-candidate caps, Reserve, and the honest linear projection.
import { describe, expect, it } from "vitest";
import {
  budgetCandidateFromCampaignRow,
  planBudget,
  type BudgetCandidate,
} from "@/services/aiBudgetPlanner";
import type { AiRecommendation } from "@/services/aiSignals";

function candidate(over: Partial<BudgetCandidate> = {}): BudgetCandidate {
  return {
    scopeKey: over.scopeKey ?? "campaign|1",
    scopeLabel: over.scopeLabel ?? "Campaign A",
    budgetDeltaPct: 20,
    confidence: "high",
    confidenceScore: 0.8,
    spend: 10_000,
    cpa: 20,
    netPerTrial: 40,
    ltvCpa: 2,
    paybackDays: null,
    ...over,
  };
}

describe("planBudget", () => {
  it("goal=profit ranks by net/spend and caps each intake at 2x the recommended step", () => {
    const plan = planBudget({
      budget: 20_000,
      goal: "profit",
      candidates: [
        candidate({ scopeKey: "campaign|low", scopeLabel: "Low", ltvCpa: 1.2, spend: 50_000 }),
        candidate({ scopeKey: "campaign|high", scopeLabel: "High", ltvCpa: 2.5, spend: 10_000 }),
      ],
      totals: { spend: 60_000, netRevenue: 90_000 },
    });
    // High goes first but its cap is 10000*20%*2 = 4000; the rest flows to Low.
    expect(plan.allocations.map((a) => [a.scopeKey, a.amount])).toEqual([
      ["campaign|high", 4000],
      ["campaign|low", 16_000],
    ]);
    expect(plan.reserve).toBe(0);
    expect(plan.projected.currentProfit).toBe(30_000);
    // High: 4000/20=200 trials * 40 = 8000 net (+4000); Low: 16000/20=800*40=32000 (+16000).
    expect(plan.projected.profitUplift).toBe(20_000);
    expect(plan.projected.newProfit).toBe(50_000);
  });

  it("budget beyond every cap lands in Reserve, never in inflated steps", () => {
    const plan = planBudget({ budget: 50_000, goal: "profit", candidates: [candidate()] });
    expect(plan.allocations[0].amount).toBe(4000); // 10000 * 20% * 2
    expect(plan.reserve).toBe(46_000);
    expect(plan.notes.join(" ")).toContain("Reserve");
  });

  it("goal=payback prefers shorter observed payback and degrades honestly without one", () => {
    const withPayback = planBudget({
      budget: 4000,
      goal: "payback",
      candidates: [
        candidate({ scopeKey: "campaign|slow", paybackDays: 70, ltvCpa: 3 }),
        candidate({ scopeKey: "campaign|fast", paybackDays: 30, ltvCpa: 1.5 }),
      ],
    });
    expect(withPayback.allocations[0].scopeKey).toBe("campaign|fast");
    expect(withPayback.projected.currentPaybackDays).toBe(50); // equal spends
    // The allocation shifts weight to the fast one → weighted payback drops.
    expect(withPayback.projected.newPaybackDays).toBeLessThan(50);

    const without = planBudget({ budget: 4000, goal: "payback", candidates: [candidate()] });
    expect(without.notes.join(" ")).toContain("No candidate carries an observed payback");
  });

  it("goal=risk ranks by engine confidence", () => {
    const plan = planBudget({
      budget: 2000,
      goal: "risk",
      candidates: [
        candidate({ scopeKey: "campaign|bold", confidenceScore: 0.5, ltvCpa: 5 }),
        candidate({ scopeKey: "campaign|sure", confidenceScore: 0.9, ltvCpa: 1.5 }),
      ],
    });
    expect(plan.allocations[0].scopeKey).toBe("campaign|sure");
  });

  it("is deterministic and skips dust allocations", () => {
    const candidates = [candidate({ scopeKey: "campaign|a" }), candidate({ scopeKey: "campaign|b", spend: 500 })];
    const a = planBudget({ budget: 4100, goal: "profit", candidates });
    const b = planBudget({ budget: 4100, goal: "profit", candidates: [...candidates].reverse() });
    expect(b).toEqual(a);
    // b's cap is 500*20%*2 = 200 < MIN_ALLOCATION → skipped entirely.
    expect(a.allocations.find((x) => x.scopeKey === "campaign|b")).toBeUndefined();
  });
});

describe("budgetCandidateFromCampaignRow", () => {
  const rec = (over: Partial<AiRecommendation> = {}) => ({
    action: "SCALE",
    budgetDeltaPct: 20,
    scope: { kind: "campaign", campaignId: "1", campaignName: "A" },
    surface: "campaign",
    ruleId: "scale_strong",
    claim: "",
    because: [],
    primaryDomain: "traffic",
    contradictions: [],
    monitorAfter: [],
    dataNotes: [],
    signals: [],
    confidence: "high",
    confidenceScore: 0.8,
    ...over,
  }) as AiRecommendation;
  const rowBase = {
    campaign_id: "1", campaign_name: "A", campaign_path: "p", spend: 1000,
    trial_users: 50, net_revenue: 3000, cac: 20,
  };
  const row = rowBase as never;

  it("accepts only SCALE verdicts with usable spend", () => {
    expect(budgetCandidateFromCampaignRow(row, rec())).toMatchObject({
      scopeKey: "campaign|1", spend: 1000, cpa: 20, netPerTrial: 60, ltvCpa: 3,
    });
    expect(budgetCandidateFromCampaignRow(row, rec({ action: "HOLD", budgetDeltaPct: null }))).toBeNull();
    expect(budgetCandidateFromCampaignRow({ ...rowBase, spend: null } as never, rec())).toBeNull();
    expect(budgetCandidateFromCampaignRow(row, null)).toBeNull();
  });
});
