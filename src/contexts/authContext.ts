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
  /** Default scope "global" (the logout button: every device). "local" ends
   * only this browser's session — for automatic sign-outs, so one rejected
   * request never revokes the user's sessions on other devices. */
  signOut: (options?: { scope?: "global" | "local" }) => Promise<void>;
};

export const AuthContext = createContext<AuthContextValue | null>(null);
