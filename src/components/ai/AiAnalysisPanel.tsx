// Expanded AI analysis for one cohort/campaign row. Mirrors BankDetailPanel's
// skeleton: a dense metric grid, everything deterministic and instant — the
// numbers ARE the explanation, no model call involved.
import { AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import { AiActionChip } from "@/components/ai/AiActionChip";
import type { AiEvidence, AiMetricVerdict, AiRecommendation } from "@/services/aiSignals";

const VERDICT_STYLE: Record<AiMetricVerdict, string> = {
  good: "text-success border-success/40",
  bad: "text-destructive border-destructive/40",
  neutral: "text-muted-foreground border-border",
  inconclusive: "text-muted-foreground/70 border-dashed border-border",
};

const VERDICT_LABEL: Record<AiMetricVerdict, string> = {
  good: "Good",
  bad: "Poor",
  neutral: "Normal",
  inconclusive: "Inconclusive",
};

const DOMAIN_LABEL: Record<AiRecommendation["primaryDomain"], string> = {
  traffic: "Traffic",
  payment: "Payments",
  conversion: "Conversion",
  retention: "Retention",
  refund: "Refunds",
  data: "Data",
};

/** Which panel section each metric belongs to. */
const SECTION_OF: Record<string, string> = {
  cpa: "Acquisition",
  roas: "Acquisition",
  pass_rate: "Payments",
  trial_to_paid: "Conversion",
  refund_rate: "Conversion",
  retention_c2: "Retention",
  ltv_cpa: "Economics",
  payback: "Economics",
};

const SECTION_ORDER = ["Acquisition", "Payments", "Conversion", "Retention", "Economics"];

function EvidenceRow({ ev }: { ev: AiEvidence }) {
  const benchLine = ev.benchmark
    ? ev.benchmark.source === "threshold"
      ? `target ${ev.benchmark.rendered}`
      : `${ev.benchmark.source === "trend_previous" ? "prev" : "benchmark"} ${ev.benchmark.rendered}${ev.benchmark.peers ? ` · ${ev.benchmark.peers} peers` : ""}`
    : null;
  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <span className="min-w-0 truncate text-muted-foreground">{ev.label}</span>
      <span className="flex shrink-0 items-center gap-2">
        <span className="tabular-nums font-medium text-foreground">{ev.valueRendered}</span>
        {benchLine && <span className="tabular-nums text-muted-foreground/80">{benchLine}</span>}
        <span className={cn("inline-flex items-center rounded-md border px-1.5 py-0 text-[10px] font-medium", VERDICT_STYLE[ev.verdict])}>
          {VERDICT_LABEL[ev.verdict]}
        </span>
      </span>
    </div>
  );
}

export function AiAnalysisPanel({ rec, footer }: { rec: AiRecommendation; footer?: React.ReactNode }) {
  const sections = new Map<string, AiEvidence[]>();
  for (const ev of rec.because) {
    const section = SECTION_OF[ev.metric] ?? "Economics";
    sections.set(section, [...(sections.get(section) ?? []), ev]);
  }

  return (
    <div className="space-y-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <AiActionChip rec={rec} />
        <span className="text-xs text-muted-foreground">
          Main issue: <span className="font-medium text-foreground">{DOMAIN_LABEL[rec.primaryDomain]}</span>
        </span>
        <span className="text-xs text-muted-foreground">·</span>
        <span className="text-xs text-muted-foreground">{rec.claim}</span>
      </div>

      {rec.contradictions.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
          {rec.contradictions.map((c) => (
            <div key={c.flag} className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{c.claim}</span>
            </div>
          ))}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {SECTION_ORDER.filter((s) => sections.has(s)).map((section) => (
          <div key={section}>
            <h4 className="mb-1 text-xs font-semibold text-muted-foreground">{section}</h4>
            <div className="space-y-0.5">
              {sections.get(section)!.map((ev) => (
                <EvidenceRow key={ev.metric} ev={ev} />
              ))}
            </div>
          </div>
        ))}
        {(rec.monitorAfter.length > 0 || rec.dataNotes.length > 0) && (
          <div>
            {rec.monitorAfter.length > 0 && (
              <>
                <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Monitor after action</h4>
                <div className="text-xs text-muted-foreground">{rec.monitorAfter.join(" · ")}</div>
              </>
            )}
            {rec.dataNotes.length > 0 && (
              <>
                <h4 className={cn("mb-1 text-xs font-semibold text-muted-foreground", rec.monitorAfter.length > 0 && "mt-2")}>Data notes</h4>
                <ul className="space-y-0.5 text-xs text-muted-foreground/90">
                  {rec.dataNotes.map((note, i) => (
                    <li key={`${note.code}-${i}`}>{note.detail}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>

      {footer}
    </div>
  );
}
