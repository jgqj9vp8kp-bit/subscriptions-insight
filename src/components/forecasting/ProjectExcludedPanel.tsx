// Excluded-funnels worklist (P8).
//
// The P3 live run showed most rows start blocked early in a month, so exclusion
// is a first-class state with real money attached — this panel is the worklist
// version of the row chips: every excluded funnel, why, how much spend it
// carries, and what would bring it into the P&L. Spend of excluded funnels sits
// in out-of-project — visible in the reconciliation, never silently dropped.
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { fmtMoney } from "@/components/forecasting/forecastFormat";
import type { ProjectEntryResolution } from "@/services/funnelEconomics";

const NEEDS: Record<string, string> = {
  "traffic.plannedBudget": "set a budget in the row editor",
  "traffic.targetCpa": "set a manual CPA in the row editor",
  "retention.survival": "set first-paid / renewal CR in the row editor",
  "pricing.periodPrice": "set a period price in the row editor",
  spend: "no resolved spend — nothing to cost",
  replay: "was blocked when this snapshot was saved",
};

export function ProjectExcludedPanel({ resolutions }: { resolutions: ReadonlyArray<ProjectEntryResolution> }) {
  const blocked = resolutions.filter((resolution) => resolution.status.kind === "blocked" && resolution.entry.enabled);
  const disabled = resolutions.filter((resolution) => resolution.status.kind === "disabled");
  if (blocked.length === 0 && disabled.length === 0) return null;

  return (
    <Card className="p-4 shadow-card">
      <h3 className="mb-2 text-sm font-semibold">Excluded from the P&L</h3>
      <div className="space-y-1.5 text-xs">
        {blocked.map((resolution) => {
          const { entry, status, ledger } = resolution;
          const path = status.kind === "blocked" ? status.path : "";
          return (
            <div key={entry.funnelId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-medium">{entry.funnelId}</span>
              <Badge variant="outline" className="h-4 px-1 text-[10px] text-destructive" title={status.kind === "blocked" ? status.message : ""}>{path}</Badge>
              <span className="text-muted-foreground">
                {ledger?.funnelResolvedSpend != null ? `${fmtMoney(ledger.funnelResolvedSpend)} resolved spend → out of project` : "no resolved spend"}
                {" · "}{NEEDS[path] ?? "see the row detail"}
              </span>
            </div>
          );
        })}
        {disabled.length > 0 && (
          <p className="pt-1 text-muted-foreground">
            Deselected: {disabled.map((resolution) => resolution.entry.funnelId).join(", ")} —
            {" "}{fmtMoney(disabled.reduce((sum, resolution) => sum + (resolution.ledger?.funnelResolvedSpend ?? 0), 0))} in out-of-project.
          </p>
        )}
      </div>
    </Card>
  );
}
