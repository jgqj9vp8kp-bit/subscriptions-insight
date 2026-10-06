/* global Deno */

// clickhouse-validate: resumable Postgres ↔ ClickHouse parity validation of the
// workspace tenant (ctx.tenantKey, never the caller).
//
// Access (policies/clickhouse-validate.ts): start / continue / status / reset
// all need admin.warehouse.manage.

import { serveWithAccess } from "../_shared/clickhouse/http.ts";
import { ScopeViolation } from "../_shared/clickhouse/scopedClient.ts";
import type { ValidationScope } from "../_shared/clickhouse/validation.ts";
import { runValidation } from "../_shared/clickhouse/validationPipeline.ts";
import {
  CLICKHOUSE_VALIDATE_POLICY,
  clickHouseValidateErrorResponse,
  validationFailureFallback,
  validationStateOnly,
} from "../_shared/access/policies/clickhouse-validate.ts";

function numberFromBody(body: Record<string, unknown>, key: string): number | undefined {
  const parsed = Number(body[key]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validationScopeFromBody(body: Record<string, unknown>): ValidationScope {
  return body.validation_scope === "full_dataset" ? "full_dataset" : "imported_cursor_range";
}

serveWithAccess(
  CLICKHOUSE_VALIDATE_POLICY,
  async ({ ctx, action, body, pg, clickhouse }) => {
    // status / reset never touch ClickHouse — and the reader opens no warehouse
    // transport until its first query, so handing it over costs nothing.
    const chunked = !validationStateOnly(action);
    try {
      return await runValidation({
        action,
        authUserId: ctx.tenantKey,
        supabase: pg,
        clickhouse: clickhouse(),
        validationScope: validationScopeFromBody(body),
        pageSize: chunked ? numberFromBody(body, "page_size") : undefined,
        maxPages: chunked ? numberFromBody(body, "max_pages") : undefined,
        softTimeoutMs: chunked ? numberFromBody(body, "soft_timeout_ms") : undefined,
      });
    } catch (error) {
      if (error instanceof ScopeViolation) throw error;
      // Today's per-path fallback text for a non-Error throw; onError rebuilds the 502 { error } body.
      throw error instanceof Error ? error : new Error(validationFailureFallback(action));
    }
  },
  { onError: clickHouseValidateErrorResponse },
);
