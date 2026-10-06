import { Fragment } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useAccess } from "@/hooks/useAccess";
import { NoAccess } from "@/components/NoAccess";
import { SavedDataAutoLoader } from "@/components/SavedDataAutoLoader";
import { canAccessRoute, firstAllowedRoute, normalizeRoutePath } from "@/services/accessRoutes";
import { shouldAutoLoadTransactionsForPath, useTransactionDemand } from "@/services/transactionAutoLoadPolicy";

function FullPageLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        {label}
      </div>
    </div>
  );
}

// Order (plan §14): session → login redirect → workspace access → page.
// Access gating here is UX only; the Edge gate re-resolves access per request.
export function ProtectedRoute() {
  const location = useLocation();
  const { configured, loading, user } = useAuth();
  const access = useAccess();
  // A mounted raw-warehouse view (the Users page's Leads tab) can request
  // hydration on a route the path policy defers.
  const transactionsDemanded = useTransactionDemand((state) => state.demand > 0);
  const loadTransactions = shouldAutoLoadTransactionsForPath(location.pathname) || transactionsDemanded;

  if (loading) {
    return <FullPageLoader label="Loading session..." />;
  }

  if (!configured || !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  // Keep the loading screen until the first my_access() answer for this user
  // ("signed_out" can only be a one-render lag behind the auth user here).
  if (access.loading || access.status === "loading" || access.status === "signed_out") {
    return <FullPageLoader label="Checking access..." />;
  }

  if (access.status === "no_membership" || access.status === "disabled") {
    return <NoAccess variant={access.status} />;
  }

  // Fail closed: anything that is neither a resolved membership nor legacy
  // (error, or a status this build does not know) shows Retry, never the app.
  if (!access.legacy && access.status !== "ok") {
    return <NoAccess variant="error" />;
  }

  // "/" is the Dashboard; members without it land on their first allowed page.
  // With no allowed page at all, the route guard shows the inline NoAccess.
  if (normalizeRoutePath(location.pathname) === "/" && !canAccessRoute("/", access)) {
    const target = firstAllowedRoute(access);
    if (target && target !== "/") return <Navigate to={target} replace />;
  }

  // The auto-loader downloads raw tables into the browser (warehouse, Palmer,
  // FunnelFox subscriptions, traffic): data owner only (D8). Legacy ⇒ rawAccess,
  // so the owner keeps today's behaviour.
  // A funnel-restricted member's page remounts when the access partition
  // changes (new funnels, re-pathed registry): pages that keep the registry or
  // filter options in useState must not carry the old scope across. Everyone
  // else keeps a stable key, so their pages never remount on a refresh.
  return (
    <>
      {access.rawAccess && <SavedDataAutoLoader loadTransactions={loadTransactions} />}
      <Fragment key={access.restricted ? access.partition : "stable"}>
        <Outlet />
      </Fragment>
    </>
  );
}
