import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthContext, type AuthContextValue, type AuthProviderName, type AuthUser } from "@/contexts/authContext";
import { isSupabaseConfigured, supabase } from "@/services/supabaseClient";
import { traceMark, traceMeasure, traceEvent } from "@/services/performanceTrace";

const LOCAL_AUTH_SESSION_KEY = "subengine_local_admin_session";

function isEnabled(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

function localAuthEnabled(): boolean {
  // Local-only dev fallback. NEVER enabled in production builds, regardless of env flags.
  if (!import.meta.env.DEV) return false;
  if (!isEnabled(import.meta.env.VITE_ENABLE_LOCAL_AUTH)) return false;
  // Require both credentials to be supplied via env vars; no defaults.
  const username = import.meta.env.VITE_LOCAL_ADMIN_USERNAME?.trim();
  const password = import.meta.env.VITE_LOCAL_ADMIN_PASSWORD;
  return Boolean(username && password);
}

function localAdminUser(): AuthUser {
  return {
    id: "local-admin",
    email: "admin",
    provider: "local",
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [localUser, setLocalUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const isLocalAuthEnabled = localAuthEnabled();

  useEffect(() => {
    traceMark("auth.restore_started", { provider: supabase ? "supabase" : isLocalAuthEnabled ? "local" : "unconfigured" });
    if (isLocalAuthEnabled && sessionStorage.getItem(LOCAL_AUTH_SESSION_KEY) === "true") {
      setLocalUser(localAdminUser());
    }

    if (!supabase) {
      setLoading(false);
      traceMark("auth.restore_completed", { provider: isLocalAuthEnabled ? "local" : "unconfigured", has_session: isLocalAuthEnabled });
      traceMeasure("auth.restore_duration", "auth.restore_started", "auth.restore_completed", { provider: isLocalAuthEnabled ? "local" : "unconfigured" });
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
      traceMark("auth.restore_completed", { provider: "supabase", has_session: Boolean(data.session) });
      traceMeasure("auth.restore_duration", "auth.restore_started", "auth.restore_completed", { provider: "supabase" });
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
      traceEvent("auth.state_changed", { event: _event, has_session: Boolean(nextSession) });
      if (nextSession) {
        sessionStorage.removeItem(LOCAL_AUTH_SESSION_KEY);
        setLocalUser(null);
      }
    });

    return () => {
      mounted = false;
      listener.subscription.unsubscribe();
    };
  }, [isLocalAuthEnabled]);

  const value = useMemo<AuthContextValue>(
    () => ({
      configured: isSupabaseConfigured || isLocalAuthEnabled,
      supabaseConfigured: isSupabaseConfigured,
      localAuthEnabled: isLocalAuthEnabled,
      mode: (isSupabaseConfigured ? "supabase" : isLocalAuthEnabled ? "local" : "unconfigured") as AuthProviderName | "unconfigured",
      loading,
      session,
      user: session?.user
        ? {
            id: session.user.id,
            email: session.user.email ?? "authenticated-user",
            provider: "supabase",
          }
        : localUser,
      async signIn(login: string, password: string) {
        const normalizedLogin = login.trim();

        if (supabase) {
          const { error } = await supabase.auth.signInWithPassword({ email: normalizedLogin, password });
          if (error) throw error;
          return;
        }

        const expectedUser = import.meta.env.VITE_LOCAL_ADMIN_USERNAME?.trim();
        const expectedPass = import.meta.env.VITE_LOCAL_ADMIN_PASSWORD;
        if (
          isLocalAuthEnabled &&
          expectedUser &&
          expectedPass &&
          normalizedLogin === expectedUser &&
          password === expectedPass
        ) {
          sessionStorage.setItem(LOCAL_AUTH_SESSION_KEY, "true");
          setLocalUser(localAdminUser());
          return;
        }

        if (isLocalAuthEnabled) {
          throw new Error("Invalid local admin credentials.");
        }

        throw new Error("Supabase is not configured.");
      },
      async signOut() {
        sessionStorage.removeItem(LOCAL_AUTH_SESSION_KEY);
        setLocalUser(null);
        if (supabase) {
          const { error } = await supabase.auth.signOut();
          if (error) throw error;
        }
      },
    }),
    [isLocalAuthEnabled, loading, localUser, session],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
