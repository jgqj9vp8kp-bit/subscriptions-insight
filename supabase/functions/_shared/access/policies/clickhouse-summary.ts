// clickhouse-summary access policy (plan §7 row "Warehouse probe", §25).
//
// The browser derives its warehouse cache versions (whv / swhv in
// src/services/analyticsCache.ts) from this one response, so it stays callable
// by every member who can open a page that runs the probe:
//   dashboard.view           — Dashboard → Revenue Intelligence section
//   cohorts.view             — Cohorts (+ the sidebar prefetch)
//   users.view               — Users
//   payment_pass.view        — Transactions → Payment Pass tab
//   payment_pass.banks.view  — Transactions → Banks tab
//   facebook_analytics.view  — FB Analytics (AI context version)
//   support.view             — Support (swhv)
//   admin.integrations.view  — Integrations → ClickHouse panel
//   admin.data.import        — Import → post-import auto-sync (data owner only)
//
// The tenant KPI numbers in it (transactions, users, payments, gross / net /
// refunds, date range, sync counters) are returned only with raw access or
// admin.diagnostics.view. Everyone else gets the version-only member view
// (summary.ts memberWarehouseSummary): strip, don't deny.
//
// Not scopeReady (Milestone A): restricted members get 403 scope_not_supported.

import type { FunctionPolicy, NormalizeActionInput } from "../gate.ts";
import type { AccessContext } from "../accessContext.ts";
import { ActionNormalizeError } from "../errors.ts";

export type ClickHouseSummaryAction = "summary";

export const WAREHOUSE_PROBE_VIEW_PERMISSIONS: readonly string[] = Object.freeze([
  "dashboard.view",
  "cohorts.view",
  "users.view",
  "payment_pass.view",
  "payment_pass.banks.view",
  "facebook_analytics.view",
  "support.view",
  "admin.integrations.view",
  "admin.data.import",
]);

/** The permission that unlocks the tenant KPI numbers (besides raw access). */
export const SUMMARY_KPI_PERMISSION = "admin.diagnostics.view";

/** getClickHouseSummary() posts `{}` and GET has no body: "no action" is
 * today's frontend contract, so it is mapped explicitly to `summary`. Any other
 * action is rejected. */
export function normalizeClickHouseSummaryAction({ body }: NormalizeActionInput): ClickHouseSummaryAction {
  if (body.action === undefined || body.action === null || body.action === "summary") return "summary";
  throw new ActionNormalizeError();
}

export const CLICKHOUSE_SUMMARY_POLICY: FunctionPolicy<ClickHouseSummaryAction> = {
  fn: "clickhouse-summary",
  methods: ["GET", "POST"],
  normalizeAction: normalizeClickHouseSummaryAction,
  actions: {
    summary: { anyOf: [...WAREHOUSE_PROBE_VIEW_PERMISSIONS] },
  },
};

export function summaryKpisVisible(ctx: Pick<AccessContext, "rawAccess" | "permissions">): boolean {
  return ctx.rawAccess || ctx.permissions.has(SUMMARY_KPI_PERMISSION);
}

/** HMAC label for the member view's opaque version tokens (tenant-bound). */
export function summaryVersionHashLabel(tenantKey: string): string {
  return `clickhouse-summary:version:${tenantKey}`;
}
