// Provenance badge — the shared "where did this number come from" chip.
//
// Extracted verbatim from PlanMode (P4 of the Project plan) so Plan mode and the
// Project tab render provenance identically; a second copy must never exist.
import { cn } from "@/lib/utils";
import type { Provenance } from "@/services/funnelEconomics";

export const PROVENANCE_META: Record<Provenance, { label: string; className: string }> = {
  actual: { label: "actual", className: "bg-success/15 text-success" },
  auto_derived: { label: "auto", className: "bg-primary/10 text-primary" },
  manual_override: { label: "manual", className: "bg-warning/15 text-warning" },
  config: { label: "config", className: "bg-muted text-muted-foreground" },
  extrapolated: { label: "extrapolated", className: "bg-accent/15 text-accent-foreground" },
  calculated: { label: "calculated", className: "bg-muted text-muted-foreground" },
};

export function ProvenanceBadge({ provenance }: { provenance: Provenance | undefined }) {
  if (!provenance) return null;
  const meta = PROVENANCE_META[provenance];
  return <span className={cn("inline-flex rounded-full px-1.5 py-0 text-[10px] font-medium", meta.className)}>{meta.label}</span>;
}
