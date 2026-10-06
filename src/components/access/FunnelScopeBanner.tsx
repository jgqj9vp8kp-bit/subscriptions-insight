// The funnel-scope banner of the media-buyer pages (access Phase 2): which
// funnels a funnel-restricted member sees, what the page counts for them, and
// how many of their saved filter values fall outside their funnels (the server
// ignores those; [Clear] removes them from the saved view). Renders nothing for
// everyone else. UX only — the Edge gate and the registry RLS are authoritative.
//
// Funnel names come from the registry, which the RLS already narrows to the
// member's own funnels; if it cannot be read, the canonical paths stand in.

import { useQuery } from "@tanstack/react-query";
import { Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useAccess } from "@/hooks/useAccess";
import { STALE_MS } from "@/hooks/useAnalyticsCache";
import { listFunnels } from "@/services/funnels";

export type FunnelScopeSurface = "dashboard" | "cohorts" | "fb";

export interface FunnelScopeBannerProps {
  surface: FunnelScopeSurface;
  /** Saved filter values outside the member's funnels (ignored by the server). */
  droppedFilterValues?: number;
  /** Removes those values from the saved filters. */
  onClearFilters?: () => void;
}

const SURFACE_COPY: Record<FunnelScopeSurface, string> = {
  dashboard:
    "Revenue Intelligence counts every payment of the customers acquired through your funnels. Facebook spend, profit and unattributed revenue are not included.",
  cohorts:
    "Cohorts of the customers acquired through your funnels. Facebook columns cover only campaigns whose trial users all belong to your funnels.",
  fb: "Campaigns whose trial users all belong to your funnels; campaigns shared with other funnels are hidden.",
};

const MAX_NAMES = 6;

export function FunnelScopeBanner({ surface, droppedFilterValues = 0, onClearFilters }: FunnelScopeBannerProps) {
  const access = useAccess();
  const scope = access.funnelScope;
  const funnelIds = access.restricted && scope?.mode === "selected" ? scope.funnelIds : [];
  const registry = useQuery({
    queryKey: ["funnel-scope-registry", access.partition],
    queryFn: listFunnels,
    enabled: funnelIds.length > 0 && access.partition !== "",
    staleTime: STALE_MS,
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (!access.restricted) return null;

  const idSet = new Set(funnelIds);
  const registryNames = (registry.data ?? [])
    .filter((funnel) => idSet.has(funnel.id))
    .map((funnel) => (funnel.display_name ?? "").trim() || funnel.funnel_path);
  const names = registryNames.length ? registryNames : [...(scope?.paths ?? [])];
  const shown = names.slice(0, MAX_NAMES).join(", ");
  const more = names.length > MAX_NAMES ? ` +${names.length - MAX_NAMES} more` : "";
  const dropped = Math.max(0, Math.trunc(droppedFilterValues));

  return (
    <Card className="p-3 text-xs text-muted-foreground shadow-card" data-testid="funnel-scope-banner" data-surface={surface}>
      <div className="flex items-start gap-2">
        <Filter className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <div className="min-w-0 space-y-1">
          {funnelIds.length === 0 ? (
            <p className="font-medium text-foreground">
              No funnels are assigned to you.{" "}
              <span className="font-normal text-muted-foreground">Ask a workspace admin to assign your funnels.</span>
            </p>
          ) : (
            <>
              <p>
                <span className="font-medium text-foreground">
                  Your funnels ({funnelIds.length}){shown ? ":" : ""}
                </span>
                {shown ? ` ${shown}${more}` : ""}
              </p>
              <p>
                {(scope?.paths.length ?? 0) === 0
                  ? "Your funnels have no campaign paths yet, so there is no data to show."
                  : SURFACE_COPY[surface]}
              </p>
            </>
          )}
          {dropped > 0 && (
            <p className="text-warning" data-testid="funnel-scope-dropped">
              {dropped === 1
                ? "1 saved filter value is outside your funnels and was ignored"
                : `${dropped} saved filter values are outside your funnels and were ignored`}
              {onClearFilters && (
                <>
                  {" "}
                  <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onClearFilters}>
                    Clear
                  </Button>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
