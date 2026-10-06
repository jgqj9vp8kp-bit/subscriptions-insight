// "No access" UI (plan §14).
//
// Two shapes:
//   * variant "inline" (default) — a Card rendered inside AppLayout when the
//     member lacks the permission for one page; the sidebar stays, and a link
//     points to the first page they may open.
//   * full-page variants "no_membership" | "disabled" | "error" — rendered by
//     ProtectedRoute instead of the app shell when there is no usable
//     membership (or access could not be resolved), styled like the Login page,
//     with Sign out (and Check again / Retry).
//
// Pure presentation: it reads auth/access context only for the default
// Sign out and Retry handlers, and works without either provider or a router.

import { useContext, useState, type ReactNode } from "react";
import { Link, useInRouterContext, useLocation } from "react-router-dom";
import { Loader2, LogOut, RefreshCw, ShieldAlert, ShieldOff, UserX, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AuthContext } from "@/contexts/authContext";
import { useOptionalAccess } from "@/hooks/useAccess";
import { firstAllowedRoute, normalizeRoutePath } from "@/services/accessRoutes";

export type NoAccessVariant = "inline" | "no_membership" | "disabled" | "error";

export interface NoAccessProps {
  variant?: NoAccessVariant;
  title?: string;
  description?: ReactNode;
  /** Defaults to the access refresh (full-page variants only). */
  onRetry?: () => void | Promise<void>;
  /** Defaults to the auth signOut (full-page variants only). */
  onSignOut?: () => void | Promise<void>;
}

const COPY: Record<NoAccessVariant, { icon: LucideIcon; title: string; description: string; retryLabel: string }> = {
  inline: {
    icon: ShieldOff,
    title: "No access to this page",
    description: "Your role does not include this page. Ask a workspace admin if you need it.",
    retryLabel: "Retry",
  },
  no_membership: {
    icon: UserX,
    title: "No workspace access",
    description: "This account is not a member of the Subengine workspace. Ask the workspace owner to add you, then check again.",
    retryLabel: "Check again",
  },
  disabled: {
    icon: ShieldOff,
    title: "Access disabled",
    description: "Your workspace membership has been disabled. Contact the workspace owner if you think this is a mistake.",
    retryLabel: "Check again",
  },
  error: {
    icon: ShieldAlert,
    title: "Could not load your access",
    description: "Checking your workspace access failed. This is usually temporary, so please retry.",
    retryLabel: "Retry",
  },
};

export function NoAccess({ variant = "inline", title, description, onRetry, onSignOut }: NoAccessProps) {
  if (variant === "inline") {
    return <NoAccessPanel title={title} description={description} />;
  }
  return <NoAccessPage variant={variant} title={title} description={description} onRetry={onRetry} onSignOut={onSignOut} />;
}

function NoAccessPanel({ title, description }: { title?: string; description?: ReactNode }) {
  const inRouter = useInRouterContext();
  const copy = COPY.inline;
  const Icon = copy.icon;
  return (
    <Card className="mx-auto mt-6 max-w-xl p-5 shadow-card" role="status" data-testid="no-access">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">{title ?? copy.title}</h2>
          <p className="text-sm text-muted-foreground">{description ?? copy.description}</p>
          {inRouter && <AllowedPageLink />}
        </div>
      </div>
    </Card>
  );
}

/** "Go to an available page" — only when some other page is allowed. */
function AllowedPageLink() {
  const location = useLocation();
  const access = useOptionalAccess();
  const target = firstAllowedRoute(access);
  if (!target || normalizeRoutePath(target) === normalizeRoutePath(location.pathname)) return null;
  return (
    <div className="pt-2">
      <Button asChild variant="outline" size="sm">
        <Link to={target}>Go to an available page</Link>
      </Button>
    </div>
  );
}

function NoAccessPage({
  variant,
  title,
  description,
  onRetry,
  onSignOut,
}: Required<Pick<NoAccessProps, "variant">> & Omit<NoAccessProps, "variant">) {
  const auth = useContext(AuthContext);
  const access = useOptionalAccess();
  const [busy, setBusy] = useState<"retry" | "signout" | null>(null);
  const copy = COPY[variant];
  const Icon = copy.icon;
  const retry = onRetry ?? access?.refresh;
  const signOut = onSignOut ?? auth?.signOut;
  const email = auth?.user?.email;

  async function run(kind: "retry" | "signout", fn: (() => void | Promise<void>) | undefined) {
    if (!fn || busy) return;
    try {
      setBusy(kind);
      await fn();
    } catch (error) {
      console.warn(`[NoAccess] ${kind} failed:`, error instanceof Error ? error.message : error);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8" data-testid={`no-access-${variant}`}>
      <div className="w-full max-w-[420px]">
        <div className="mb-5 flex items-center justify-center gap-2">
          <div className="relative flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary via-primary-glow to-accent text-primary-foreground shadow-sm">
            <span className="text-base font-bold leading-none">S</span>
            <span className="absolute bottom-2 right-2 h-1 w-1 rounded-full bg-primary-foreground/90" />
            <span className="absolute bottom-2 right-4 h-2 w-1 rounded-full bg-primary-foreground/75" />
            <span className="absolute bottom-2 right-6 h-3 w-1 rounded-full bg-primary-foreground/60" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-none text-foreground">Subengine</h1>
            <p className="mt-1 text-xs text-muted-foreground">Analytics engine</p>
          </div>
        </div>

        <Card className="p-5 shadow-card" role="alert">
          <div className="mb-3 flex items-center gap-2">
            <Icon className={variant === "error" ? "h-4 w-4 text-destructive" : "h-4 w-4 text-muted-foreground"} />
            <h2 className="text-sm font-semibold text-foreground">{title ?? copy.title}</h2>
          </div>
          <p className="text-sm text-muted-foreground">{description ?? copy.description}</p>
          {email && (
            <p className="mt-3 truncate text-xs text-muted-foreground">
              Signed in as <span className="font-medium text-foreground">{email}</span>
            </p>
          )}
          <div className="mt-5 flex flex-wrap justify-end gap-2">
            {retry && (
              <Button type="button" variant="outline" size="sm" onClick={() => run("retry", retry)} disabled={busy !== null}>
                {busy === "retry" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {copy.retryLabel}
              </Button>
            )}
            {signOut && (
              <Button type="button" size="sm" onClick={() => run("signout", signOut)} disabled={busy !== null}>
                {busy === "signout" ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
                Sign out
              </Button>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
