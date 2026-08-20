// Executive summary above an analytics table: the top-ranked AI opportunities.
// One component covers both the "AI Summary" line (collapsed state) and the
// card list (expanded) — brief §14 explicitly asks not to ship two blocks.
// Collapse pattern mirrors the Cohorts Diagnostics button.
import { useState } from "react";
import {
  AlertTriangle, Ban, ChevronDown, ChevronRight, CreditCard, Database, Eye,
  Loader2, Sparkles, Target, TrendingDown, TrendingUp, Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { aiActionLabel, type AiOpportunity, type AiRecommendation } from "@/services/aiSignals";

const MAX_VISIBLE = 5;

interface Category {
  label: string;
  Icon: typeof Sparkles;
  tone: string;
}

/** §9 of the brief: icon + label, never color alone. */
function categoryOf(rec: AiRecommendation): Category {
  if (rec.action === "SCALE") return { label: "Scale opportunity", Icon: TrendingUp, tone: "text-success" };
  if (rec.action === "STOP" && rec.primaryDomain === "refund") return { label: "Refund issue", Icon: Undo2, tone: "text-destructive" };
  if (rec.action === "STOP") return { label: "Budget risk", Icon: Ban, tone: "text-destructive" };
  if (rec.action === "REDUCE") return { label: "Budget risk", Icon: TrendingDown, tone: "text-destructive" };
  if (rec.action === "INVESTIGATE" && rec.primaryDomain === "payment") return { label: "Payment issue", Icon: CreditCard, tone: "text-warning" };
  if (rec.action === "INVESTIGATE") return { label: "Anomaly", Icon: AlertTriangle, tone: "text-warning" };
  if (rec.ruleId === "green_but_thin") return { label: "Emerging winner", Icon: Sparkles, tone: "text-primary" };
  if (rec.primaryDomain === "conversion") return { label: "Conversion issue", Icon: Target, tone: "text-warning" };
  if (rec.primaryDomain === "retention") return { label: "Retention issue", Icon: Eye, tone: "text-warning" };
  if (rec.action === "NOT_ENOUGH_DATA") return { label: "Data quality", Icon: Database, tone: "text-muted-foreground" };
  return { label: "Watch", Icon: Eye, tone: "text-muted-foreground" };
}

function scopeCaption(rec: AiRecommendation): string {
  if (rec.scope.kind === "cohort") return `${rec.scope.campaignPath} · ${rec.scope.cohortDate}`;
  if (rec.scope.kind === "path") return rec.scope.campaignPath;
  return rec.scope.campaignName ?? rec.scope.campaignId;
}

export function AiOpportunities({ opportunities, loading, onOpen, openLabel }: {
  opportunities: readonly AiOpportunity[];
  /** Auxiliary inputs (pass rates) still loading — summary shows it. */
  loading?: boolean;
  onOpen?: (opportunity: AiOpportunity) => void;
  openLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  // HOLD never makes the list (engine filters it); NOT_ENOUGH_DATA is noise at
  // the summary level too — the chips in the table already carry it.
  const actionable = opportunities.filter((o) => o.recommendation.action !== "NOT_ENOUGH_DATA");
  const visible = actionable.slice(0, MAX_VISIBLE);
  if (!actionable.length && !loading) return null;

  const counts = new Map<string, number>();
  for (const opp of actionable) {
    const label = categoryOf(opp.recommendation).label;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([label, n]) => `${n} ${label.toLowerCase()}`).join(" · ");

  return (
    <div className="mb-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-7 gap-1 px-2 text-xs"
          aria-expanded={open}
          aria-controls="ai-opportunities"
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          AI Opportunities
        </Button>
        <span className="text-xs text-muted-foreground">
          {actionable.length ? `${actionable.length} insights · ${summary}` : "analyzing…"}
        </span>
        {loading && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> payment data loading
          </span>
        )}
      </div>

      {open && visible.length > 0 && (
        <div id="ai-opportunities" className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((opp) => {
            const rec = opp.recommendation;
            const category = categoryOf(rec);
            const topEvidence = rec.because.slice(0, 3);
            return (
              <div key={opp.id} className="rounded-md border border-border bg-muted/10 px-3 py-2">
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <category.Icon className={cn("h-3.5 w-3.5 shrink-0", category.tone)} />
                  <span className={category.tone}>{category.label}</span>
                  <span className="ml-auto text-muted-foreground">{aiActionLabel(rec.action, rec.budgetDeltaPct)}</span>
                </div>
                <div className="mt-1 truncate text-xs font-medium text-foreground" title={scopeCaption(rec)}>
                  {scopeCaption(rec)}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {topEvidence.map((ev) => (
                    <span key={ev.metric} className="text-xs text-muted-foreground">
                      {ev.label} <span className="tabular-nums font-medium text-foreground">{ev.valueRendered}</span>
                    </span>
                  ))}
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-muted-foreground" title={rec.claim}>{rec.claim}</div>
                {onOpen && (
                  <button
                    type="button"
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                    onClick={() => onOpen(opp)}
                  >
                    {openLabel ?? "View row"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
