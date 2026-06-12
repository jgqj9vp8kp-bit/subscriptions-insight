import { ReactNode, useEffect, useState } from "react";
import { LogOut, TriangleAlert } from "lucide-react";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useDataStore } from "@/store/dataStore";

interface AppLayoutProps {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function AppLayout({ title, description, actions, children }: AppLayoutProps) {
  const { signOut, user } = useAuth();
  const [signingOut, setSigningOut] = useState(false);
  const isSampleData = useDataStore((state) => state.meta.source === "mock");

  useEffect(() => {
    document.title = title ? `${title} • Subengine` : "Subengine";
  }, [title]);

  async function onLogout() {
    try {
      setSigningOut(true);
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full bg-background">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-14 flex items-center justify-between border-b border-border bg-card/60 backdrop-blur px-4 sticky top-0 z-10">
            <div className="flex items-center gap-3 min-w-0">
              <SidebarTrigger />
              <div className="min-w-0">
                <h1 className="text-sm font-semibold text-foreground truncate">{title}</h1>
                {description && (
                  <p className="text-xs text-muted-foreground truncate">{description}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {actions}
              {user?.email && (
                <div className="hidden max-w-[240px] truncate text-xs text-muted-foreground md:block">
                  {user.email}
                </div>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={onLogout} disabled={signingOut}>
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Logout</span>
              </Button>
            </div>
          </header>
          <main className="flex-1 p-4 md:p-6 max-w-[1600px] w-full">
            {isSampleData && (
              <div
                role="status"
                aria-live="polite"
                className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
              >
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <span className="font-semibold">Sample data mode.</span> These numbers are
                  generated demo data, not your real data. Import a Palmer or Primer file on the{" "}
                  <a href="/import" className="underline underline-offset-2">Import Data</a> page to
                  load your own transactions.
                </span>
              </div>
            )}
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
