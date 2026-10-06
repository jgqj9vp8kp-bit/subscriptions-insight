// Shared notices of the Admin → Access pages.

import { Info } from "lucide-react";
import { Card } from "@/components/ui/card";

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
            Members, roles and the audit log become available once the workspace has been bootstrapped on the server.
          </p>
        </div>
      </div>
    </Card>
  );
}
