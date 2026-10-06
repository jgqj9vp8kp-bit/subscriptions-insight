// Shared notices of the Admin → Access pages.

import { Link } from "react-router-dom";
import { Info, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { formatPct } from "@/components/admin/accessAdminModel";
import type { FunnelCoverage } from "@/services/accessAdminClient";

/** Shown instead of the admin pages while access control is not bootstrapped
 * ("legacy" access): there are no members or roles to manage yet, and the
 * access API answers 503 workspace_not_bootstrapped. */
export function AccessNotSetUpNotice() {
  return (
    <Card className="mx-auto mt-6 max-w-xl p-5 shadow-card" role="status" data-testid="access-not-set-up">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <Info className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">Access control is not set up yet</h2>
          <p className="text-sm text-muted-foreground">
            Members, roles, funnel coverage and the audit log become available once the workspace has been bootstrapped
            on the server.
          </p>
        </div>
      </div>
    </Card>
  );
}

/** Members page banner (access Phase 2): part of the active cohort snapshot is
 * anchored to campaign paths no funnel holds, and at least one member is
 * funnel-restricted, so those users are invisible to them. */
export function CoverageGapNotice({ coverage, showLink }: { coverage: FunnelCoverage; showLink: boolean }) {
  const unattributedUsers = Math.max(0, coverage.totals.users - coverage.totals.registered_users);
  const unattributedPaths = coverage.paths.filter((row) => row.state !== "granted").length;
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
      data-testid="coverage-gap-notice"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {formatPct(unattributedUsers, coverage.totals.users)} of users ({unattributedPaths} campaign path
        {unattributedPaths === 1 ? "" : "s"}) belong to no funnel: members with selected funnels never see them.
        {showLink && (
          <>
            {" "}
            <Link to="/admin/funnels" className="font-medium underline underline-offset-2">
              Review funnel coverage
            </Link>
          </>
        )}
      </span>
    </div>
  );
}
