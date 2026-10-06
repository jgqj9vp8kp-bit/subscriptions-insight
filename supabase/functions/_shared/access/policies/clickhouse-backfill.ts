// clickhouse-backfill access policy (plan §7 row "Warehouse ops").
//
// The function copies the workspace's Postgres transactions into ClickHouse
// (analytics_transactions) under ctx.tenantKey. Every mode is warehouse
// administration — admin.warehouse.manage — and a full-scope-only permission,
// so it is never reachable under a funnel-restricted scope (no action is
// scopeReady). Callers in src/: Integrations → Continue / Full / Controlled
// backfill, and Import → post-import auto-sync (a data-owner-only page).
//
// The request has no `action`: its `mode` selects the run, so the normalizer
// maps the mode — and the cursor-reset flag — to the canonical action:
//   continue       — incremental keyset sync from the saved cursor;
//   full_backfill  — rewrite from the beginning: mode "full_backfill", or a
//                    "continue" with a truthy full_reset_cursor (the runner
//                    resets the cursor on the same truthiness);
//   validate_only  — counts only, no ClickHouse write;
//   dedup          — "repair": re-queues key-drift duplicate transactions by
//                    bumping their Postgres updated_at, then a continue run.
// The runner used to coerce a missing or unknown mode to "continue". Every
// src/ caller sends an explicit mode, so a missing or unknown mode is now
// rejected (400 unknown_action) instead of silently starting a write. Pure module.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseBackfillAction = "continue" | "full_backfill" | "validate_only" | "dedup";

export function normalizeClickHouseBackfillAction({ body }: NormalizeActionInput): ClickHouseBackfillAction {
  switch (body.mode) {
    case "continue":
      // Plain truthiness — the same test the runner applies (Boolean(full_reset_cursor)).
      return body.full_reset_cursor ? "full_backfill" : "continue";
    case "full_backfill":
      return "full_backfill";
    case "validate_only":
      return "validate_only";
    case "dedup":
      return "dedup";
    default:
      throw new ActionNormalizeError();
  }
}

const WAREHOUSE_MANAGE = { allOf: ["admin.warehouse.manage"], write: true };

export const CLICKHOUSE_BACKFILL_POLICY: FunctionPolicy<ClickHouseBackfillAction> = {
  fn: "clickhouse-backfill",
  methods: ["POST"],
  normalizeAction: normalizeClickHouseBackfillAction,
  actions: {
    continue: { ...WAREHOUSE_MANAGE },
    full_backfill: { ...WAREHOUSE_MANAGE },
    validate_only: { ...WAREHOUSE_MANAGE },
    dedup: { ...WAREHOUSE_MANAGE },
  },
};

const BACKFILL_FAILED_MESSAGE = "ClickHouse transaction backfill failed.";

/** onError: today's 502 { error } body (the run already recorded the failure
 * in its sync state). The gate sanitizes it for anyone but the data owner, and
 * a ScopeViolation still becomes a 500. */
export function clickHouseBackfillErrorResponse(error: unknown): { status: number; body: Record<string, unknown> } {
  return { status: 502, body: { error: error instanceof Error ? error.message : BACKFILL_FAILED_MESSAGE } };
}
