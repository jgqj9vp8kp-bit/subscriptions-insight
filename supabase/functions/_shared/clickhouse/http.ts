/* global Deno */

// Edge HTTP plumbing shared by every function.
//
// New code: `serveWithAccess(POLICY, handler)` — the access gate (pure core in
// ../access/gate.ts) wired to the live service-role client, resolve_access, the
// cron secret and a ScopedReader per request. The handler never sees the raw
// ClickHouse transport and never binds the caller as tenant: it gets
// ctx.tenantKey (the workspace data key) via the AccessContext.
//
// The pre-access helpers that took the tenant from the caller or the request
// body (requireSupabaseUser, requireCronSecret, parseJsonBody) are gone: cron
// authentication lives in the gate (policy.cron, constant-time secret check,
// tenant from workspace_data_key()).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createScopedReader } from "./scopedClient.ts";
import type { SupabaseAuthClient } from "./types.ts";
import { buildCorsHeaders } from "../access/cors.ts";
import { BUILD_ID } from "../access/buildId.ts";
import {
  assertValidPolicy,
  auditRpcParams,
  denialRpcParams,
  handleWithAccess,
  type AccessGateDeps,
  type AccessHandler,
  type FunctionPolicy,
  type GateAuditEntry,
  type GateDenialEntry,
  type RpcResult,
  type ServeWithAccessOptions,
} from "../access/gate.ts";

export type {
  AccessRequest,
  AccessHandler,
  ActionPolicy,
  FunctionPolicy,
  ServeWithAccessOptions,
} from "../access/gate.ts";
export type { AccessContext } from "../access/accessContext.ts";
export { ActionNormalizeError } from "../access/errors.ts";

export const corsHeaders: Record<string, string> = buildCorsHeaders();

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "x-build-id": BUILD_ID,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function optionsResponse(): Response {
  return new Response(null, { status: 204, headers: { ...corsHeaders, "x-build-id": BUILD_ID } });
}

export function methodNotAllowed(allowed: string): Response {
  return new Response(JSON.stringify({ error: "Method not allowed." }), {
    status: 405,
    headers: {
      ...corsHeaders,
      "x-build-id": BUILD_ID,
      "Content-Type": "application/json",
      Allow: allowed,
    },
  });
}

// ---- live dependencies ------------------------------------------------------------

let serviceClient: SupabaseAuthClient | null = null;

/** One service-role client per isolate: it holds no session (persistSession off),
 * so sharing it across requests shares nothing user-specific. */
function serviceRoleClient(): { client: SupabaseAuthClient | null; error: string | null } {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim();
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (!supabaseUrl || !serviceRoleKey) return { client: null, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured." };
  serviceClient ??= createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseAuthClient;
  return { client: serviceClient, error: null };
}

async function callRpc(client: SupabaseAuthClient, fn: string, params?: Record<string, unknown>): Promise<RpcResult> {
  if (typeof client.rpc !== "function") return { data: null, error: { message: "rpc is not supported by this client" } };
  const result = await client.rpc(fn, params);
  return { data: result?.data ?? null, error: result?.error ?? null };
}

function liveAccessDeps(): AccessGateDeps {
  const { client, error } = serviceRoleClient();
  const missing = async (): Promise<never> => {
    throw new Error(error ?? "service client missing");
  };
  return {
    configError: error,
    pg: client,
    // getUser errors are classified in auth.ts: a rejected token → 401
    // invalid_session; network / 5xx / a throw → 503 auth_service_error.
    getUser: (token) => (client ? client.auth.getUser(token) : missing()),
    loadAccess: (userId) => (client ? callRpc(client, "resolve_access", { p_user_id: userId }) : missing()),
    workspaceDataKey: () => (client ? callRpc(client, "workspace_data_key") : missing()),
    readEnv: (name) => Deno.env.get(name),
    createClickHouse: (ctx) => createScopedReader(ctx),
    // §24 audit (best effort; the gate bounds and swallows both).
    writeAudit: (entry: GateAuditEntry) =>
      client ? callRpc(client, "access_write_audit", auditRpcParams(entry)) : missing(),
    recordDenial: (entry: GateDenialEntry) =>
      client ? callRpc(client, "access_record_denial", denialRpcParams(entry)) : missing(),
  };
}

/** Serves one Edge function behind the access gate. The policy is validated at
 * boot, so a malformed dispatch table fails the deploy smoke test. */
export function serveWithAccess<A extends string>(
  policy: FunctionPolicy<A>,
  handler: AccessHandler<A>,
  options?: ServeWithAccessOptions,
): void {
  assertValidPolicy(policy);
  Deno.serve((req: Request) => handleWithAccess(req, policy, handler, liveAccessDeps(), options));
}
