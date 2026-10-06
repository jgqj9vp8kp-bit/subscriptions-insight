// Impact preview of a selected-funnels scope (plan §17): what the member would
// see in the active cohort snapshot — "N funnels · M paths (k retired) · U users
// (p%) · $X net (q%)" — plus a warning for every selected funnel without data
// and the share of users no funnel holds (invisible to every restricted
// member). Numbers come from paths.coverage; computeScopeImpact is pure.
//
// UX only: the server resolves the member's paths itself (app.funnel_scope_paths).

import { useMemo } from "react";
import { Loader2, TriangleAlert } from "lucide-react";
import { computeScopeImpact, listText, scopeImpactSummary } from "@/components/admin/accessAdminModel";
import { describeAccessAdminError, type AdminFunnelOption, type AdminFunnelScope, type FunnelCoverage } from "@/services/accessAdminClient";

export interface ScopeImpactPreviewProps {
  scope: AdminFunnelScope;
  funnels: readonly AdminFunnelOption[];
  coverage?: FunnelCoverage | null;
  loading?: boolean;
  error?: unknown;
}

export function ScopeImpactPreview({ scope, funnels, coverage, loading = false, error }: ScopeImpactPreviewProps) {
  const impact = useMemo(() => computeScopeImpact(scope, funnels, coverage), [scope, funnels, coverage]);
  if (scope.mode !== "selected") return null;

  return (
    <div className="space-y-1.5 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs" data-testid="scope-impact">
      <div className="font-medium text-foreground" data-testid="scope-impact-summary">
        {scopeImpactSummary(impact)}
      </div>
      {!coverage && loading && (
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          Measuring coverage…
        </div>
      )}
      {!coverage && !loading && Boolean(error) && (
        <div className="text-muted-foreground">Coverage could not be loaded: {describeAccessAdminError(error)}</div>
      )}
      {coverage && (
        <>
          {impact.funnelsWithoutData.length > 0 && (
            <div className="flex items-start gap-1.5 text-warning" data-testid="scope-impact-no-data">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                No users in the current snapshot: {listText(impact.funnelsWithoutData.map((funnel) => funnel.label), 4)}
              </span>
            </div>
          )}
          {(impact.unregisteredPaths ?? 0) > 0 && (
            <div className="text-muted-foreground" data-testid="scope-impact-unregistered">
              {impact.unregisteredPaths} unregistered path{impact.unregisteredPaths === 1 ? "" : "s"} ({impact.unregisteredUsersPct} of
              users) {impact.unregisteredPaths === 1 ? "is" : "are"} invisible to this member.
            </div>
          )}
          {coverage.snapshot.status === "stale" && (
            <div className="text-muted-foreground">Measured on the last validated snapshot; a newer import is not in it yet.</div>
          )}
        </>
      )}
    </div>
  );
}
