// Access policy of the clickhouse-revenue Edge function (plan §7 row "Revenue
// Intelligence"). Its only caller is the Dashboard's Revenue Intelligence
// section (src/hooks/useRevenueIntelligence.ts → RevenueIntelligenceSection on
// "/"), so both actions need dashboard.view.
//
// Funnel-restricted members (access Phase 2, spec §4): both actions are
// scopeReady behind the cohort-snapshot freshness gate (scopeSnapshot "cohort"
// → 409 scope_snapshot_not_ready until it is fresh and validated). The runners
// then read only the member's scoped users with filtersActive forced, so the
// unattributed and Facebook-spend streams never run for them;
// restrictRevenueRequest intersects the campaign_path include list (the only
// list the endpoint has — no exclude list) and withRestrictedMeta reports how
// many values were dropped. Pure module.

import type { FunctionPolicy } from "../gate.ts";
import { ActionNormalizeError } from "../errors.ts";
import { normalizeRevenueFilters } from "../../clickhouse/revenueIntelligence.ts";
import type { RevenueIntelligenceRequest } from "../../clickhouse/revenueIntelligenceContract.ts";
import { intersectIncludePaths, type ScopeSql } from "../../clickhouse/scopeSql.ts";

export type ClickHouseRevenueAction = "bundle" | "day_breakdown";

/** The browser always names its action ("bundle" / "day_breakdown"), so the
 * legacy "anything else ⇒ bundle" fallback is not carried over (rule R3). */
export function normalizeClickHouseRevenueAction(body: Record<string, unknown>): ClickHouseRevenueAction {
  if (body.action === "bundle") return "bundle";
  if (body.action === "day_breakdown") return "day_breakdown";
  throw new ActionNormalizeError();
}

export const CLICKHOUSE_REVENUE_POLICY: FunctionPolicy<ClickHouseRevenueAction> = {
  fn: "clickhouse-revenue",
  normalizeAction: ({ body }) => normalizeClickHouseRevenueAction(body),
  actions: {
    bundle: { anyOf: ["dashboard.view"], scopeReady: true, scopeSnapshot: "cohort" },
    day_breakdown: { anyOf: ["dashboard.view"], scopeReady: true, scopeSnapshot: "cohort" },
  },
};

/** meta.access of every restricted revenue response (spec §6 contract 4). */
export interface RestrictedRevenueMeta {
  access: { scope: "restricted"; dropped_filter_values: number };
}

/** A restricted member's request: the campaign_path include list (normalized
 * exactly as the runner does) keeps only their paths; a non-empty list left
 * empty becomes the sentinel that matches nothing. Every other filter passes
 * through — the scope itself is a base predicate of the attributed stream. */
export function restrictRevenueRequest(scope: ScopeSql, body: Record<string, unknown>): { request: RevenueIntelligenceRequest; dropped: number } {
  const request = body as unknown as RevenueIntelligenceRequest;
  const { values, dropped } = intersectIncludePaths(scope, normalizeRevenueFilters(request.filters).filters.campaign_path);
  return { request: { ...request, filters: { ...(request.filters ?? {}), campaign_path: values } }, dropped };
}

/** A restricted member's bundle / day_breakdown body plus meta.access. Pure. */
export function withRestrictedMeta<T extends object>(body: T, dropped: number): T & { meta: RestrictedRevenueMeta } {
  const count = Number(dropped);
  return {
    ...body,
    meta: { access: { scope: "restricted", dropped_filter_values: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0 } },
  };
}
