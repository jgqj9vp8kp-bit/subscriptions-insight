// "Funnel-scoped data is being prepared" (access Phase 2). The Edge gate
// answers a funnel-restricted member 409 scope_snapshot_not_ready while the
// cohort snapshot (or, for Facebook reads, the campaign scope) is not fresh and
// validated — a cron tick rebuilds it within minutes. It is a waiting state,
// never an error: the hooks (useRevenueIntelligence / useCohortsCache /
// useFbWarehouse) poll every SCOPE_PENDING_POLL_MS until the data arrives, and
// AccessErrorBridge never treats the 409 as a reason to refresh access.

import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";

/** error_code of the 409 a restricted member gets until their scope is ready
 * (ACCESS_ERROR.SCOPE_SNAPSHOT_NOT_READY; a literal keeps this module
 * fast-refresh friendly, accessPagesRestricted.test.tsx pins the equality). */
export const SCOPE_SNAPSHOT_NOT_READY = "scope_snapshot_not_ready";

/** How often a page re-asks while its data answers scope_snapshot_not_ready. */
export const SCOPE_PENDING_POLL_MS = 60_000;

export function ScopeDataPending({ inline = false }: { inline?: boolean }) {
  const content = (
    <span className="inline-flex items-center gap-2">
      <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      <span>
        Funnel-scoped data is being prepared… This page checks again every minute; there is nothing you need to do.
      </span>
    </span>
  );
  if (inline) {
    return <span className="text-sm text-muted-foreground" data-testid="scope-data-pending">{content}</span>;
  }
  return (
    <Card className="p-4 text-sm text-muted-foreground shadow-card" data-testid="scope-data-pending">
      {content}
    </Card>
  );
}
