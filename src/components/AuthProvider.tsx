import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { AuthContext, type AuthContextValue, type AuthProviderName, type AuthUser } from "@/contexts/authContext";
import { isSupabaseConfigured, supabase } from "@/services/supabaseClient";

const LOCAL_AUTH_SESSION_KEY = "subengine_local_admin_session";
const LOCAL_ADMIN_USERNAME = "admin";
const LOCAL_ADMIN_PASSWORD = "Mobidima";

function isEnabled(value: unknown): boolean {
  return String(value ?? "").toLowerCase() === "true";
}

function localAuthEnabled(): boolean {
  return Boolean(import.meta.env.DEV) || isEnabled(import.meta.env.VITE_ENABLE_LOCAL_AUTH);
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
    if (isLocalAuthEnabled && sessionStorage.getItem(LOCAL_AUTH_SESSION_KEY) === "true") {
      setLocalUser(localAdminUser());
    }

    if (!supabase) {
      setLoading(false);
      return;
    }

    let mounted = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
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

        if (isLocalAuthEnabled && normalizedLogin === LOCAL_ADMIN_USERNAME && password === LOCAL_ADMIN_PASSWORD) {
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
