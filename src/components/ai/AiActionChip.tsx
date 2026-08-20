// Compact AI recommendation chip for dense tables (Cohorts / FB Analytics).
// Communicates three things in one glance: action (icon + label + tone),
// confidence (dot triplet) and "there is an explanation" (it is a button).
// Tone follows StatusBadges (`bg-*/10 text-*` on semantic tokens) — icons keep
// actions distinguishable without color alone.
import { AlertTriangle, Ban, Database, Eye, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";
import { aiActionLabel, type AiAction, type AiConfidence, type AiRecommendation } from "@/services/aiSignals";

const ACTION_STYLE: Record<AiAction, { tone: string; Icon: typeof Minus }> = {
  SCALE: { tone: "bg-success/10 text-success", Icon: TrendingUp },
  HOLD: { tone: "bg-muted text-muted-foreground", Icon: Minus },
  WATCH: { tone: "bg-warning/15 text-warning", Icon: Eye },
  REDUCE: { tone: "bg-destructive/10 text-destructive", Icon: TrendingDown },
  STOP: { tone: "bg-destructive/15 text-destructive", Icon: Ban },
  INVESTIGATE: { tone: "bg-warning/15 text-warning", Icon: AlertTriangle },
  NOT_ENOUGH_DATA: { tone: "bg-muted text-muted-foreground/80", Icon: Database },
};

const CONFIDENCE_DOTS: Record<AiConfidence, number> = { high: 3, medium: 2, low: 1 };
const CONFIDENCE_LABEL: Record<AiConfidence, string> = { high: "High", medium: "Medium", low: "Low" };

function ConfidenceDots({ confidence }: { confidence: AiConfidence }) {
  const filled = CONFIDENCE_DOTS[confidence];
  return (
    <span className="ml-1 inline-flex items-center gap-px" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className={cn("h-1 w-1 rounded-full bg-current", i >= filled && "opacity-25")} />
      ))}
    </span>
  );
}

export function aiChipTitle(rec: AiRecommendation): string {
  const sample = rec.because.find((ev) => ev.sampleSize !== null)?.sampleSize;
  const parts = [
    `${CONFIDENCE_LABEL[rec.confidence]} confidence${sample ? ` · ${sample} trials` : ""}`,
    rec.claim,
  ];
  if (rec.dataNotes.length) parts.push(rec.dataNotes.map((n) => n.detail).join(" "));
  return parts.join("\n");
}

export function AiActionChip({ rec, onClick, expanded }: {
  rec: AiRecommendation;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const { tone, Icon } = ACTION_STYLE[rec.action];
  return (
    <button
      type="button"
      onClick={onClick}
      title={aiChipTitle(rec)}
      aria-expanded={expanded}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium",
        "transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        tone,
        expanded && "ring-1 ring-ring",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{aiActionLabel(rec.action, rec.budgetDeltaPct)}</span>
      <ConfidenceDots confidence={rec.confidence} />
    </button>
  );
}
