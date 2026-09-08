// AI Budget Planner (brief §20): a dialog that allocates ADDITIONAL budget
// across the engine's SCALE candidates and projects the impact. Everything is
// deterministic and instant — recompute on every keystroke, no model call.
import { useMemo, useState } from "react";
import { Calculator } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { planBudget, type BudgetCandidate, type BudgetGoal } from "@/services/aiBudgetPlanner";

const GOALS: Array<{ value: BudgetGoal; label: string; hint: string }> = [
  { value: "profit", label: "Maximize projected profit", hint: "highest net per dollar first" },
  { value: "payback", label: "Fastest payback", hint: "shortest observed payback first" },
  { value: "risk", label: "Lowest risk", hint: "highest engine confidence first" },
];

const usd = (v: number | null | undefined, digits = 0): string =>
  v == null ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: 0 });

export function AiBudgetPlanner({ candidates, totals }: {
  candidates: readonly BudgetCandidate[];
  /** Current-period totals of the visible set — the profit baseline. */
  totals?: { spend: number; netRevenue: number } | null;
}) {
  const [budgetInput, setBudgetInput] = useState("10000");
  const [goal, setGoal] = useState<BudgetGoal>("profit");
  const budget = Number(budgetInput.replace(/[^0-9.]/g, "")) || 0;
  const plan = useMemo(() => planBudget({ budget, goal, candidates, totals }), [budget, goal, candidates, totals]);

  if (!candidates.length) return null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs">
          <Calculator className="h-3.5 w-3.5 text-primary" />
          Budget Planner
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-auto">
        <DialogHeader>
          <DialogTitle>AI Budget Planner</DialogTitle>
          <DialogDescription>
            Allocates additional budget across the {candidates.length} campaigns the engine marked Scale.
            Deterministic — same rules as the AI column, no model involved.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-4">
          <div className="space-y-1">
            <Label htmlFor="ai-budget-amount">Additional budget</Label>
            <Input
              id="ai-budget-amount"
              value={budgetInput}
              onChange={(event) => setBudgetInput(event.target.value)}
              inputMode="numeric"
              className="h-9 w-36"
            />
          </div>
          <div className="space-y-1">
            <Label>Goal</Label>
            <div className="flex flex-wrap gap-1.5">
              {GOALS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setGoal(option.value)}
                  title={option.hint}
                  className={`rounded-md border px-2 py-1.5 text-xs transition-colors ${
                    goal === option.value
                      ? "border-primary bg-primary/10 font-medium text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/50"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Campaign</TableHead>
                <TableHead className="text-right">Allocation</TableHead>
                <TableHead className="text-right">Share</TableHead>
                <TableHead className="text-right">+Trials</TableHead>
                <TableHead className="text-right">+Net</TableHead>
                <TableHead className="text-right">Profit uplift</TableHead>
                <TableHead className="text-right">Net / Spend</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plan.allocations.map((allocation) => (
                <TableRow key={allocation.scopeKey}>
                  <TableCell className="max-w-64">
                    <div className="truncate text-xs font-medium" title={allocation.scopeLabel}>{allocation.scopeLabel}</div>
                    <div className="text-xs text-muted-foreground">Scale +{allocation.budgetDeltaPct}% · {allocation.confidence} confidence</div>
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">+{usd(allocation.amount)}</TableCell>
                  <TableCell className="text-right text-xs">{Math.round(allocation.share * 100)}%</TableCell>
                  <TableCell className="text-right font-mono text-xs">{allocation.expectedTrials ?? "—"}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{usd(allocation.expectedNet)}</TableCell>
                  <TableCell className={`text-right font-mono text-xs ${allocation.expectedProfitUplift != null && allocation.expectedProfitUplift < 0 ? "text-destructive" : ""}`}>
                    {usd(allocation.expectedProfitUplift)}
                  </TableCell>
                  <TableCell className="text-right text-xs">{allocation.ltvCpa == null ? "—" : `${allocation.ltvCpa.toFixed(2)}x`}</TableCell>
                </TableRow>
              ))}
              {plan.reserve > 0 && (
                <TableRow>
                  <TableCell className="text-xs text-muted-foreground">Reserve (unallocated)</TableCell>
                  <TableCell className="text-right font-mono text-xs text-muted-foreground">{usd(plan.reserve)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">{plan.budget > 0 ? Math.round((plan.reserve / plan.budget) * 100) : 0}%</TableCell>
                  <TableCell colSpan={4} />
                </TableRow>
              )}
              {!plan.allocations.length && (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-xs text-muted-foreground">
                    Enter a budget above — nothing could be allocated yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>

        <div className="grid gap-2 rounded-md border border-border bg-muted/10 p-3 text-xs sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">Projected profit</span>
            <div className="font-medium">
              {plan.projected.currentProfit != null
                ? <>{usd(plan.projected.currentProfit)} → {usd(plan.projected.newProfit)}</>
                : <>uplift {usd(plan.projected.profitUplift)}</>}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Projected payback</span>
            <div className="font-medium">
              {plan.projected.currentPaybackDays != null
                ? <>D{plan.projected.currentPaybackDays} → D{plan.projected.newPaybackDays}</>
                : "no observed payback among candidates"}
            </div>
          </div>
          <div>
            <span className="text-muted-foreground">Added trials</span>
            <div className="font-medium">{plan.projected.addedTrials}</div>
          </div>
          <div>
            <span className="text-muted-foreground">Added net revenue</span>
            <div className="font-medium">{usd(plan.projected.addedNet)}</div>
          </div>
        </div>

        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {plan.notes.map((note) => <li key={note}>· {note}</li>)}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
