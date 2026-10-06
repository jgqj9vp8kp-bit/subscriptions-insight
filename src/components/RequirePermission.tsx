// Route/section guard (plan §14). Renders children when the current access
// satisfies the requirement, otherwise the inline NoAccess panel inside the app
// shell (AppLayout), so the sidebar stays and the user can navigate away.
//
//   <RequirePermission route="/cohorts"><Cohorts /></RequirePermission>
//   <RequirePermission anyOf={["cohorts.export"]} fallback={null}>…</RequirePermission>
//
// `route` pulls the rule from ROUTE_ACCESS (single source with the sidebar and
// the "/" redirect); anyOf / allOf / rawOnly add explicit requirements and all
// given requirements must pass. Legacy access (server not bootstrapped) passes
// everything, exactly as today. A page the role grants but funnel-restricted
// access does not include renders the "scope" NoAccess copy, which names the
// pages that are available. UX only — the Edge gate is authoritative.

import { lazy, Suspense, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { NoAccess } from "@/components/NoAccess";
import { useAccess } from "@/hooks/useAccess";
import { accessRuleDenial, findRouteAccess, type AccessDenialReason } from "@/services/accessRoutes";

// Lazy so the app shell (sidebar, AI drawer, stores) stays out of the eagerly
// loaded route-guard chunk; pages load it anyway.
const AppLayout = lazy(() => import("@/components/AppLayout").then((module) => ({ default: module.AppLayout })));

export interface RequirePermissionProps {
  anyOf?: string[];
  allOf?: string[];
  rawOnly?: boolean;
  /** Also require the ROUTE_ACCESS rule of this path (unknown path ⇒ denied). */
  route?: string;
  children: ReactNode;
  /** Rendered instead of the default NoAccess-in-AppLayout when denied
   * (pass null to hide a section silently). */
  fallback?: ReactNode;
  /** Header title of the default denial layout. */
  title?: string;
}

export function RequirePermission({ anyOf, allOf, rawOnly, route, children, fallback, title = "No access" }: RequirePermissionProps) {
  const access = useAccess();

  if (access.loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking access...
        </div>
      </div>
    );
  }

  const routeRule = route === undefined ? null : findRouteAccess(route);
  const routeDenial: AccessDenialReason | null =
    route === undefined || access.legacy ? null : routeRule === null ? "permission" : accessRuleDenial(routeRule, access);
  const denial = routeDenial ?? accessRuleDenial({ anyOf, allOf, rawOnly }, access);
  if (denial === null) return <>{children}</>;

  if (fallback !== undefined) return <>{fallback}</>;
  return (
    <Suspense fallback={<NoAccess reason={denial} />}>
      <AppLayout title={title}>
        <NoAccess reason={denial} />
      </AppLayout>
    </Suspense>
  );
}
