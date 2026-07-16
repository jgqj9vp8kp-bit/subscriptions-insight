import { Navigate, Outlet, useLocation } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { SavedDataAutoLoader } from "@/components/SavedDataAutoLoader";
import { shouldAutoLoadTransactionsForPath } from "@/services/transactionAutoLoadPolicy";

export function ProtectedRoute() {
  const location = useLocation();
  const { configured, loading, user } = useAuth();
  const loadTransactions = shouldAutoLoadTransactionsForPath(location.pathname);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading session...
        </div>
      </div>
    );
  }

  if (!configured || !user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return (
    <>
      <SavedDataAutoLoader loadTransactions={loadTransactions} />
      <Outlet />
    </>
  );
}
