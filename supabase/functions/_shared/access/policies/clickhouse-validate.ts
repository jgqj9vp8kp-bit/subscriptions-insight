// clickhouse-validate access policy (plan §7 row "Warehouse ops").
//
// Resumable Postgres ↔ ClickHouse parity validation of the workspace tenant
// (validationPipeline.ts). Every action is warehouse administration —
// admin.warehouse.manage, full-scope-only, never scopeReady:
//   start    — freeze bounds, create the scratch id table, snapshot ClickHouse;
//   continue — process the next bounded chunk / finalize;
//   status   — read the persisted validation state (tenant totals, parity);
//   reset    — delete the validation state.
// The only src/ caller is Integrations → Validation (start / continue / reset).
//
// src/services/clickhouse.ts validateClickHouseTransactions() still posts no
// action and relies on today's default, so a body WITHOUT an action is mapped
// explicitly to `start`. An unknown action value — which the old function also
// coerced to "start" — is now rejected (400 unknown_action). Pure module.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseValidateAction = "start" | "continue" | "status" | "reset";

export function normalizeClickHouseValidateAction({ body }: NormalizeActionInput): ClickHouseValidateAction {
  switch (body.action) {
    case undefined:
    case null:
    case "start":
      return "start";
    case "continue":
      return "continue";
    case "status":
      return "status";
    case "reset":
      return "reset";
    default:
      throw new ActionNormalizeError();
  }
}

export const CLICKHOUSE_VALIDATE_POLICY: FunctionPolicy<ClickHouseValidateAction> = {
  fn: "clickhouse-validate",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseValidateAction,
  actions: {
    start: { allOf: ["admin.warehouse.manage"], write: true },
    continue: { allOf: ["admin.warehouse.manage"], write: true },
    status: { allOf: ["admin.warehouse.manage"] },
    reset: { allOf: ["admin.warehouse.manage"], write: true },
  },
};

/** status / reset only read or delete the Postgres validation state. */
export function validationStateOnly(action: ClickHouseValidateAction): boolean {
  return action === "status" || action === "reset";
}

/** Today's per-path fallback text for a thrown non-Error value. */
export function validationFailureFallback(action: ClickHouseValidateAction): string {
  return validationStateOnly(action) ? "ClickHouse validation state request failed." : "ClickHouse transaction validation failed.";
}

/** onError: today's 502 { error } body. The handler turns a non-Error throw
 * into an Error carrying validationFailureFallback(action) first. The gate
 * sanitizes the body for anyone but the data owner, and a ScopeViolation
 * still becomes a 500. */
export function clickHouseValidateErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  return { status: 502, body: { error: error instanceof Error ? error.message : validationFailureFallback("start") } };
}
