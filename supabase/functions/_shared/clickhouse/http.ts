/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export interface EdgeResult {
  status: number;
  body: unknown;
}

export interface AuthenticatedEdgeUser {
  id: string;
  email: string | null;
  token: string;
  supabase: ReturnType<typeof createClient>;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: "Method not allowed." }), {
    status: 405,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      Allow: allowed,
    },
  });
}

function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

export async function requireSupabaseUser(req: Request): Promise<AuthenticatedEdgeUser | EdgeResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return { status: 503, body: { error: "Supabase Edge authentication is not configured." } };
  }

  const token = bearerToken(req);
  if (!token) return { status: 401, body: { error: "Authentication required." } };

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.id) return { status: 401, body: { error: "Invalid or expired session." } };

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    token,
    supabase,
  };
}

export async function parseJsonBody<T extends Record<string, unknown>>(req: Request): Promise<T> {
  if (req.method === "GET") return {} as T;
  const text = await req.text().catch(() => "");
  if (!text.trim()) return {} as T;
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T;
}
