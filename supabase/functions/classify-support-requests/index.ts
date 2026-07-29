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

import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import { CLASSIFICATION_MODEL } from "../_shared/clickhouse/supportClassifier.ts";
import {
  runSupportClassificationJob,
  type ClassificationJobRequest,
} from "../_shared/clickhouse/supportClassificationJob.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let request: ClassificationJobRequest;
  try {
    request = (await parseJsonBody<Record<string, unknown>>(req)) as ClassificationJobRequest;
  } catch {
    return jsonResponse({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  const apiKey = anthropicApiKey();
  const model = typeof request.model === "string" && request.model.trim() ? request.model.trim() : CLASSIFICATION_MODEL;

  try {
    return jsonResponse(
      await runSupportClassificationJob({
        supabase: auth.supabase,
        authUserId: auth.id,
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
