import { createContext } from "react";
import type { Session } from "@supabase/supabase-js";

export type AuthProviderName = "supabase" | "local";

export type AuthUser = {
  id: string;
  email: string;
  provider: AuthProviderName;
};

export type AuthContextValue = {
  configured: boolean;
  supabaseConfigured: boolean;
  localAuthEnabled: boolean;
  mode: AuthProviderName | "unconfigured";
  loading: boolean;
  session: Session | null;
  user: AuthUser | null;
  signIn: (login: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
