import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { BarChart3, Loader2, LockKeyhole } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";

type LocationState = {
  from?: {
    pathname?: string;
    search?: string;
  };
};

export default function LoginPage() {
  const location = useLocation();
  const { configured, loading, localAuthEnabled, mode, signIn, supabaseConfigured, user } = useAuth();
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLocalMode = mode === "local";

  useEffect(() => {
    document.title = "Login • Subengine";
  }, []);

  const redirectTo = useMemo(() => {
    const state = location.state as LocationState | null;
    const from = state?.from;
    return `${from?.pathname || "/"}${from?.search || ""}`;
  }, [location.state]);

  if (!loading && user) {
    return <Navigate to={redirectTo} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signIn(login.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to log in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
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

        <Card className="p-5 shadow-card">
          <div className="mb-4 flex items-center gap-2">
            <LockKeyhole className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">Sign in</h2>
              <p className="text-xs text-muted-foreground">
                {isLocalMode ? "Use local admin credentials for development." : "Use an existing Supabase Auth account."}
              </p>
            </div>
          </div>

          {!supabaseConfigured && localAuthEnabled && (
            <Alert className="mb-4">
              <BarChart3 className="h-4 w-4" />
              <AlertTitle>Local admin login</AlertTitle>
              <AlertDescription>
                Local admin login is for development only. Configure Supabase for production.
              </AlertDescription>
            </Alert>
          )}

          {!configured && (
            <Alert variant="destructive" className="mb-4">
              <BarChart3 className="h-4 w-4" />
              <AlertTitle>Supabase is not configured</AlertTitle>
              <AlertDescription>
                Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in the deployment environment.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" className="mb-4">
              <AlertTitle>Login failed</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <form className="space-y-4" onSubmit={onSubmit}>
            <div className="space-y-1.5">
              <Label htmlFor="login-email">{isLocalMode ? "Username" : "Email"}</Label>
              <Input
                id="login-email"
                type={isLocalMode ? "text" : "email"}
                value={login}
                onChange={(event) => setLogin(event.target.value)}
                placeholder={isLocalMode ? "admin" : "you@example.com"}
                autoComplete={isLocalMode ? "username" : "email"}
                disabled={!configured || submitting || loading}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="login-password">Password</Label>
              <Input
                id="login-password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                autoComplete="current-password"
                disabled={!configured || submitting || loading}
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={!configured || submitting || loading}>
              {submitting || loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Log in
            </Button>
          </form>

          <p className="mt-4 text-xs text-muted-foreground">
            Signup is disabled in Subengine. Create allowed users in Supabase Auth before deployment.
          </p>
        </Card>
      </div>
    </div>
  );
}
