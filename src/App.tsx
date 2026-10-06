import { lazy, Suspense, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AuthProvider } from "@/components/AuthProvider";
import { AccessProvider } from "@/components/AccessProvider";
import { AccessErrorBridge } from "@/components/AccessErrorBridge";
import { AnalyticsCacheGate } from "@/components/AnalyticsCacheGate";
import { RequirePermission } from "@/components/RequirePermission";
import { registerPurgeHandler } from "@/services/sessionPurge";
import { traceMark } from "@/services/performanceTrace";
// Side-effect import: registers the Forecasting compare working-set purge at app
// start (tiny module, no runtime deps) so an account switch purges another
// user's leftovers before the lazy Forecasting chunk is ever loaded.
import "@/components/forecasting/compareStore";
// Same for page UI state (ui_state_* keys): its purge handler must be registered
// before the first principal_changed / signed_out purge, but the hook itself is
// only reached from lazy page chunks.
import "@/hooks/usePersistedPageState";
import LoginPage from "./pages/Login.tsx";
import NotFound from "./pages/NotFound.tsx";

// Heavy analytics pages are code-split so the initial bundle stays small — each loads on first
// navigation instead of shipping in the main chunk. Login / NotFound stay eager (first paint).
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Transactions = lazy(() => import("./pages/Transactions.tsx"));
const UsersPage = lazy(() => import("./pages/Users.tsx"));
const Cohorts = lazy(() => import("./pages/Cohorts.tsx"));
const FunnelsPage = lazy(() => import("./pages/Funnels.tsx"));
const Reports = lazy(() => import("./pages/Reports.tsx"));
const FBAnalyticsPage = lazy(() => import("./pages/FBAnalytics.tsx"));
const ForecastingPage = lazy(() => import("./pages/Forecasting.tsx"));
const IntegrationsPage = lazy(() => import("./pages/Integrations.tsx"));
const ImportPage = lazy(() => import("./pages/Import.tsx"));
const SubscriptionsPage = lazy(() => import("./pages/Subscriptions.tsx"));
const SupportPage = lazy(() => import("./pages/Support.tsx"));
const AdminMembersPage = lazy(() => import("./pages/admin/AdminMembers.tsx"));
const AdminRolesPage = lazy(() => import("./pages/admin/AdminRoles.tsx"));
const AdminAuditPage = lazy(() => import("./pages/admin/AdminAudit.tsx"));

// Cache defaults for the Cohorts read path (and any future warehouse query):
// stale-while-revalidate with a 5-min freshness window, 60-min retention so the
// cache survives route unmount/remount, no refetch on window focus, refetch on
// reconnect, and bounded retries (per-query hooks refine transient-only retry).
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      gcTime: 60 * 60 * 1000,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      retry: 2,
    },
  },
});

// Every cached query/mutation result was fetched under one user's access
// partition. The access layer runs the purge registry on sign-out, account
// switch and access change (plan §20); drop the whole in-memory cache then.
registerPurgeHandler("react-query", () => {
  queryClient.clear();
});

function RouteFallback() {
  traceMark("router.route_chunk_fallback_rendered");
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading…
      </div>
    </div>
  );
}

function AppPerfMarks() {
  useEffect(() => {
    traceMark("app.react_mounted");
  }, []);
  return null;
}

// Every protected route element is wrapped in RequirePermission with its own
// path: the ROUTE_ACCESS rule (src/services/accessRoutes.ts) decides, and a
// denied page renders NoAccess inside the app shell. UX only — the Edge gate
// re-checks every request.
const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppPerfMarks />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <AccessProvider>
            <AccessErrorBridge />
            <AnalyticsCacheGate>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/login" element={<LoginPage />} />
                  <Route element={<ProtectedRoute />}>
                    <Route path="/" element={<RequirePermission route="/"><Dashboard /></RequirePermission>} />
                    <Route path="/transactions" element={<RequirePermission route="/transactions"><Transactions /></RequirePermission>} />
                    <Route path="/users" element={<RequirePermission route="/users"><UsersPage /></RequirePermission>} />
                    {/* Leads is now a tab of the Users page; keep old links working. */}
                    <Route path="/leads" element={<Navigate to="/users?tab=leads" replace />} />
                    <Route path="/cohorts" element={<RequirePermission route="/cohorts"><Cohorts /></RequirePermission>} />
                    <Route path="/funnels" element={<RequirePermission route="/funnels"><FunnelsPage /></RequirePermission>} />
                    <Route path="/reports" element={<RequirePermission route="/reports"><Reports /></RequirePermission>} />
                    <Route path="/fb-analytics" element={<RequirePermission route="/fb-analytics"><FBAnalyticsPage /></RequirePermission>} />
                    <Route path="/integrations" element={<RequirePermission route="/integrations"><IntegrationsPage /></RequirePermission>} />
                    <Route path="/support" element={<RequirePermission route="/support"><SupportPage /></RequirePermission>} />
                    <Route path="/forecasting" element={<RequirePermission route="/forecasting"><ForecastingPage /></RequirePermission>} />
                    <Route path="/subscriptions" element={<RequirePermission route="/subscriptions"><SubscriptionsPage /></RequirePermission>} />
                    <Route path="/import" element={<RequirePermission route="/import"><ImportPage /></RequirePermission>} />
                    <Route path="/admin/members" element={<RequirePermission route="/admin/members"><AdminMembersPage /></RequirePermission>} />
                    <Route path="/admin/roles" element={<RequirePermission route="/admin/roles"><AdminRolesPage /></RequirePermission>} />
                    <Route path="/admin/audit" element={<RequirePermission route="/admin/audit"><AdminAuditPage /></RequirePermission>} />
                  </Route>
                  {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </Suspense>
            </AnalyticsCacheGate>
          </AccessProvider>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
