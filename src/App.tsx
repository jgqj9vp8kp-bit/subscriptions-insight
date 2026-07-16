import { lazy, Suspense, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { AuthProvider } from "@/components/AuthProvider";
import { AnalyticsCacheGate } from "@/components/AnalyticsCacheGate";
import { traceMark } from "@/services/performanceTrace";
import LoginPage from "./pages/Login.tsx";
import NotFound from "./pages/NotFound.tsx";

// Heavy analytics pages are code-split so the initial bundle stays small — each loads on first
// navigation instead of shipping in the main chunk. Login / NotFound stay eager (first paint).
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const Transactions = lazy(() => import("./pages/Transactions.tsx"));
const UsersPage = lazy(() => import("./pages/Users.tsx"));
const LeadsPage = lazy(() => import("./pages/Leads.tsx"));
const Cohorts = lazy(() => import("./pages/Cohorts.tsx"));
const FBAnalyticsPage = lazy(() => import("./pages/FBAnalytics.tsx"));
const ForecastingPage = lazy(() => import("./pages/Forecasting.tsx"));
const IntegrationsPage = lazy(() => import("./pages/Integrations.tsx"));
const ImportPage = lazy(() => import("./pages/Import.tsx"));
const SubscriptionsPage = lazy(() => import("./pages/Subscriptions.tsx"));
const SupportPage = lazy(() => import("./pages/Support.tsx"));

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

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <AppPerfMarks />
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <AuthProvider>
          <AnalyticsCacheGate>
            <Suspense fallback={<RouteFallback />}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<ProtectedRoute />}>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/transactions" element={<Transactions />} />
                  <Route path="/users" element={<UsersPage />} />
                  <Route path="/leads" element={<LeadsPage />} />
                  <Route path="/cohorts" element={<Cohorts />} />
                  <Route path="/fb-analytics" element={<FBAnalyticsPage />} />
                  <Route path="/integrations" element={<IntegrationsPage />} />
                  <Route path="/support" element={<SupportPage />} />
                  <Route path="/forecasting" element={<ForecastingPage />} />
                  <Route path="/subscriptions" element={<SubscriptionsPage />} />
                  <Route path="/import" element={<ImportPage />} />
                </Route>
                {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </AnalyticsCacheGate>
        </AuthProvider>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
