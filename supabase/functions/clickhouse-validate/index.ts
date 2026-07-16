/* global Deno */

import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { jsonResponse, methodNotAllowed, optionsResponse, parseJsonBody, requireSupabaseUser } from "../_shared/clickhouse/http.ts";
import type { ValidationScope } from "../_shared/clickhouse/validation.ts";
import { runValidation, type ValidationAction } from "../_shared/clickhouse/validationPipeline.ts";

function numberFromBody(body: Record<string, unknown>, key: string): number | undefined {
  const parsed = Number(body[key]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function actionFromBody(body: Record<string, unknown>): ValidationAction {
  const action = body.action;
  return action === "continue" || action === "status" || action === "reset" ? action : "start";
}

function validationScopeFromBody(body: Record<string, unknown>): ValidationScope {
  return body.validation_scope === "full_dataset" ? "full_dataset" : "imported_cursor_range";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return optionsResponse();
  if (req.method !== "POST") return methodNotAllowed("POST");

  const auth = await requireSupabaseUser(req);
  if ("status" in auth) return jsonResponse(auth.body, auth.status);

  let body: Record<string, unknown>;
  try {
    body = await parseJsonBody<Record<string, unknown>>(req);
  } catch {
    return jsonResponse({ error: "Invalid JSON request body." }, 400);
  }

  const action = actionFromBody(body);

  // status / reset never touch ClickHouse — avoid opening a warehouse client.
  if (action === "status" || action === "reset") {
    try {
      const result = await runValidation({
        action,
        authUserId: auth.id,
        supabase: auth.supabase,
        clickhouse: undefined as never,
        validationScope: validationScopeFromBody(body),
      });
      return jsonResponse(result);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : "ClickHouse validation state request failed." }, 502);
    }
  }

  let client: ReturnType<typeof createClickHouseClient> | null = null;
  try {
    client = createClickHouseClient();
    const result = await runValidation({
      action,
      authUserId: auth.id,
      supabase: auth.supabase,
      clickhouse: client,
      validationScope: validationScopeFromBody(body),
      pageSize: numberFromBody(body, "page_size"),
      maxPages: numberFromBody(body, "max_pages"),
      softTimeoutMs: numberFromBody(body, "soft_timeout_ms"),
    });
    return jsonResponse(result);
  } catch (error) {
    return jsonResponse({
      error: error instanceof Error ? error.message : "ClickHouse transaction validation failed.",
    }, 502);
  } finally {
    await client?.close?.().catch(() => undefined);
  }
});
