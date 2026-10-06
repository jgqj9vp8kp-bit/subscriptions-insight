// clickhouse-health access policy (plan §7 row "Warehouse ops").
//
//   health — the `SELECT 1` connectivity probe behind Integrations → ClickHouse
//            → Test connection (and the refresh after every warehouse action).
//            Callable with admin.integrations.view (the page) or
//            admin.diagnostics.view (warehouse health is a diagnostic). Both
//            are full-scope-only, and the action is not scopeReady.
//
// Strip, don't deny: the data owner gets exactly today's body. Everyone else
// gets the connectivity flags only — no warehouse `database` name and no raw
// ClickHouse error text (an authentication failure echoes the ClickHouse user
// name, a transport error the host). Host and username themselves are never in
// the body.
//
// GET and POST are both served (as before); the browser posts `{}`, so a body
// WITHOUT an action is mapped explicitly to `health`. Any other action value is
// rejected. Pure module.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseHealthAction = "health";

export const WAREHOUSE_HEALTH_VIEW_PERMISSIONS: readonly string[] = Object.freeze([
  "admin.integrations.view",
  "admin.diagnostics.view",
]);

export function normalizeClickHouseHealthAction({ body }: NormalizeActionInput): ClickHouseHealthAction {
  if (body.action === undefined || body.action === null || body.action === "health") return "health";
  throw new ActionNormalizeError();
}

export const CLICKHOUSE_HEALTH_POLICY: FunctionPolicy<ClickHouseHealthAction> = {
  fn: "clickhouse-health",
  methods: ["GET", "POST"],
  normalizeAction: normalizeClickHouseHealthAction,
  actions: {
    health: { anyOf: [...WAREHOUSE_HEALTH_VIEW_PERMISSIONS] },
  },
};

/** Full probe detail (database name, ClickHouse error text): the data owner only. */
export function healthDetailVisible(ctx: Pick<AccessContext, "rawAccess">): boolean {
  return ctx.rawAccess;
}

/** The static not-configured message names the secrets to set, never their values. */
export const CLICKHOUSE_NOT_CONFIGURED_MESSAGE =
  "ClickHouse is not configured in Supabase Secrets. Set CLICKHOUSE_HOST and CLICKHOUSE_PASSWORD.";

/** Replaces a probe's ClickHouse error text for members without detail access. */
export const CLICKHOUSE_HEALTH_FAILED_MESSAGE = "ClickHouse connection check failed.";

const VIEWER_HEALTH_FIELDS = ["connected", "configured", "host_configured", "password_configured", "result", "latency_ms"] as const;

/** The member view of a probe body: an allowlist, so a field added to the probe
 * later stays owner-only until it is listed here. */
export function projectHealthForViewer(health: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const field of VIEWER_HEALTH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(health, field)) projected[field] = health[field];
  }
  if (typeof health.error === "string" && health.error) {
    projected.error = health.error === CLICKHOUSE_NOT_CONFIGURED_MESSAGE ? health.error : CLICKHOUSE_HEALTH_FAILED_MESSAGE;
  }
  return projected;
}
