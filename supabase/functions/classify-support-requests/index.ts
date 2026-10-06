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
//
// Access (policies/classify-support-requests.ts): every user call requires
// admin.sync.run; the hourly tick authenticates with the support-mail internal
// secret through the gate's cron branch (no session, `continue` only). Either
// way the job runs for the workspace data key (ctx.tenantKey) — new mail gets
// classified without anyone opening the app, and never under a caller's own id.

import { anthropicApiKey, createAnthropicModelCaller } from "../_shared/anthropic.ts";
import { resolveAllowedModel } from "../_shared/aiModels.ts";
import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import {
  CLASSIFY_SUPPORT_REQUESTS_POLICY,
  classifySupportRequestsErrorResponse,
} from "../_shared/access/policies/classify-support-requests.ts";
import { CLASSIFICATION_MODEL } from "../_shared/clickhouse/supportClassifier.ts";
import {
  runSupportClassificationJob,
  type ClassificationJobRequest,
} from "../_shared/clickhouse/supportClassificationJob.ts";

serveWithAccess(
  CLASSIFY_SUPPORT_REQUESTS_POLICY,
  async ({ ctx, action, body, pg }) => {
    // The job runs exactly the action the policy authorized.
    const request: ClassificationJobRequest = { ...(body as ClassificationJobRequest), action };
    const apiKey = anthropicApiKey();
    // Server-side allowlist: a requested model outside it falls back to the default.
    const model = resolveAllowedModel(request.model, CLASSIFICATION_MODEL);
    return await runSupportClassificationJob({
      supabase: pg,
      authUserId: ctx.tenantKey,
      request,
      // status/reset must work without a key, so the caller is built lazily.
      callModel: apiKey ? createAnthropicModelCaller(apiKey, model) : null,
      model,
    });
  },
  { onError: classifySupportRequestsErrorResponse },
);
