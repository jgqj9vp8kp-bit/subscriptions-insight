// clickhouse-init access policy (plan §7 row "Warehouse ops", §8 "Admin: all
// except owner-only (warehouse init)").
//
//   init — platform DDL: CREATE / ALTER of every warehouse table, plus the
//          one-time whole-table rebuilds (analytics_transactions row_version,
//          fact_support_requests sorting key) that rewrite EVERY tenant's rows
//          in place. The workspace Owner who is also the data owner only
//          (ownerOnly + rawOnly) — admin.warehouse.manage alone does not reach
//          it. The row counts in the response are the tenant's (schema.ts).
//
// The browser posts `{}` (src/services/clickhouse.ts initializeClickHouseSchema),
// so a body WITHOUT an action is mapped explicitly to `init` — the one default
// the frontend relies on. Any other action value is rejected. Not scopeReady:
// never callable under a funnel-restricted scope. Pure module.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseInitAction = "init";

export function normalizeClickHouseInitAction({ body }: NormalizeActionInput): ClickHouseInitAction {
  if (body.action === undefined || body.action === null || body.action === "init") return "init";
  throw new ActionNormalizeError();
}

export const CLICKHOUSE_INIT_POLICY: FunctionPolicy<ClickHouseInitAction> = {
  fn: "clickhouse-init",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseInitAction,
  actions: {
    init: { ownerOnly: true, rawOnly: true, write: true },
  },
};

const INIT_FAILED_MESSAGE = "Could not initialize ClickHouse schema.";

/** onError: today's 502 { error } body. The gate replaces it with the generic
 * { error_code, request_id } body for anyone but the data owner (who is the
 * only caller this policy admits), and a ScopeViolation still becomes a 500. */
export function clickHouseInitErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  return { status: 502, body: { error: error instanceof Error ? error.message : INIT_FAILED_MESSAGE } };
}
