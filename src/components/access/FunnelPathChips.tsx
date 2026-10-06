// The campaign paths of one funnel as chips (Phase 2, funnel_paths). Active
// and retired paths both grant funnel access, so both show by default; a
// retired path (the funnel's old URL) carries a muted "(old)" badge. Proposed
// and revoked rows grant nothing and appear only with showInactive (admin
// views). Shared by the Funnels page and the admin funnel picker.

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type FunnelPathChipStatus = "active" | "retired" | "proposed" | "revoked";

export interface FunnelPathChipsProps {
  paths: ReadonlyArray<{ path: string; status: FunnelPathChipStatus }>;
  /** Also show proposed and revoked rows (they grant no access). */
  showInactive?: boolean;
}

const STATUS_ORDER: Record<FunnelPathChipStatus, number> = { active: 0, retired: 1, proposed: 2, revoked: 3 };

const STATUS_TITLE: Record<FunnelPathChipStatus, string> = {
  active: "Current path of this funnel",
  retired: "Old path: customers acquired through it still count for this funnel",
  proposed: "Proposed path: grants no access until it is confirmed",
  revoked: "Revoked path: grants no access",
};

export function FunnelPathChips({ paths, showInactive = false }: FunnelPathChipsProps) {
  const visible = paths
    .filter((entry) => entry.status in STATUS_ORDER && (showInactive || entry.status === "active" || entry.status === "retired"))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.path.localeCompare(b.path));

  if (visible.length === 0) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  return (
    <div className="flex flex-wrap gap-1" data-testid="funnel-path-chips">
      {visible.map((entry) => (
        <Badge
          key={`${entry.status}:${entry.path}`}
          variant={entry.status === "active" ? "secondary" : "outline"}
          title={STATUS_TITLE[entry.status]}
          data-testid="funnel-path-chip"
          data-status={entry.status}
          className={cn(
            "gap-1 font-mono text-xs font-normal",
            entry.status === "retired" && "text-muted-foreground",
            entry.status === "proposed" && "border-dashed text-muted-foreground",
            entry.status === "revoked" && "text-muted-foreground",
          )}
        >
          <span className={entry.status === "revoked" ? "line-through" : undefined}>{entry.path}</span>
          {entry.status !== "active" && (
            <span className="font-sans text-[10px] text-muted-foreground">
              {entry.status === "retired" ? "(old)" : `(${entry.status})`}
            </span>
          )}
        </Badge>
      ))}
    </div>
  );
}
