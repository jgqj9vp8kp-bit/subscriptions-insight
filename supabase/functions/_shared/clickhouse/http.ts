/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyEdgeBearerSession } from "./auth.ts";

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

export async function requireSupabaseUser(req: Request): Promise<AuthenticatedEdgeUser | EdgeResult> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) {
    return { status: 503, body: { error: "Supabase Edge authentication is not configured." } };
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const decision = await verifyEdgeBearerSession({
    authorization: req.headers.get("Authorization"),
    getUser: (token) => supabase.auth.getUser(token),
  });
  if ("status" in decision) return decision;

  return {
    id: decision.id,
    email: decision.email,
    token: decision.token,
    supabase,
  };
}

/** Cron authentication (design §8: reconciliation runs daily by cron). pg_cron
 * cannot mint user JWTs, so the scheduled caller presents x-cron-secret matching
 * the FB_CRON_SECRET function secret plus the target auth_user_id in the body.
 * Returns the same authenticated shape as requireSupabaseUser (service client). */
export function requireCronSecret(req: Request, body: Record<string, unknown>): AuthenticatedEdgeUser | EdgeResult {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  const secret = Deno.env.get("FB_CRON_SECRET")?.trim();
  if (!supabaseUrl || !serviceRoleKey || !secret) {
    return { status: 503, body: { error: "Cron authentication is not configured." } };
  }
  const provided = req.headers.get("x-cron-secret")?.trim() ?? "";
  if (provided !== secret) {
    return { status: 401, body: { error: "Invalid cron secret." } };
  }
  const authUserId = String(body.auth_user_id ?? "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authUserId)) {
    return { status: 400, body: { error: "cron body requires a valid auth_user_id." } };
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return { id: authUserId, email: null, token: "", supabase };
}

export async function parseJsonBody<T extends Record<string, unknown>>(req: Request): Promise<T> {
  if (req.method === "GET") return {} as T;
  const text = await req.text().catch(() => "");
  if (!text.trim()) return {} as T;
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : {} as T;
}
