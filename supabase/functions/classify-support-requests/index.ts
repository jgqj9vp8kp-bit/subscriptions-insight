/* global Deno */

// classify-support-requests: resumable, model-driven classification of support
// emails into taxonomy v2.
//
// One invocation processes a bounded chunk and returns "partial"; the client
// loops start -> continue -> ... until "completed". Progress lives in Postgres,
// so a page reload or an Edge Function timeout costs at most one batch.
//
// The classification is written to support_requests (the source of truth); the
// ClickHouse sync then copies it. Manual corrections are never touched.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { CLASSIFICATION_MODEL } from "../_shared/clickhouse/supportClassifier.ts";
import {
  runSupportClassificationJob,
  type ClassificationJobRequest,
} from "../_shared/clickhouse/supportClassificationJob.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";

/** Server-side entry for the hourly tick. Same shape as sync-support-mail's:
 * a shared secret instead of a user session, and the owner resolved from the
 * mailbox sync state — new mail must get classified without anyone opening the
 * app. */
async function internalCaller(
  req: Request,
  body: Record<string, unknown>,
): Promise<{ supabase: SupabaseLikeClient; authUserId: string } | { error: string; status: number }> {
  const secret = Deno.env.get("SUPPORT_MAIL_SYNC_INTERNAL_SECRET")?.trim();
  const provided = req.headers.get("x-support-mail-internal-secret")?.trim();
  if (!secret || provided !== secret) return { error: "Invalid internal secret.", status: 401 };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  ) as unknown as SupabaseLikeClient;

  const { data, error } = await supabase
    .from("support_mail_sync_state")
    .select("auth_user_id")
    .limit(1)
    .maybeSingle();
  if (error) return { error: "Could not resolve the mailbox owner.", status: 500 };
  const authUserId = (data as { auth_user_id?: string } | null)?.auth_user_id;
  if (!authUserId) return { error: "No mailbox owner configured.", status: 200 };
  return { supabase, authUserId: String(authUserId) };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  let request: ClassificationJobRequest & { internal?: boolean };
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as ClassificationJobRequest & { internal?: boolean };
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  let supabase: SupabaseLikeClient;
  let authUserId: string;
  if (request.internal === true) {
    const resolved = await internalCaller(req, request as Record<string, unknown>);
    if ("error" in resolved) return jsonResponse({ ok: false, error: resolved.error }, resolved.status);
    supabase = resolved.supabase;
    authUserId = resolved.authUserId;
  } else {
    const auth = await requireSupabaseUser(req);
    if ("status" in auth) return jsonResponse(auth.body, auth.status);
    supabase = auth.supabase;
    authUserId = auth.id;
  }

  const apiKey = anthropicApiKey();
  const model = typeof request.model === "string" && request.model.trim() ? request.model.trim() : CLASSIFICATION_MODEL;

  try {
    return jsonResponse(
      await runSupportClassificationJob({
        supabase,
        authUserId,
        request,
        // status/reset must work without a key, so the caller is built lazily.
        callModel: apiKey ? createAnthropicModelCaller(apiKey, model) : null,
        model,
      }),
    );
  } catch (error) {
    return jsonResponse(
      { ok: false, error: error instanceof Error ? error.message : "Support classification failed." },
      400,
    );
  }
});
