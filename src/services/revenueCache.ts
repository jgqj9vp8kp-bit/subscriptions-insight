// Query-key composition for the Dashboard Revenue Intelligence root.
// Mirrors cohortsCache.ts: keys carry the non-reversible user scope, the
// warehouse-version fingerprint (so a sync re-keys everything), and a
// canonicalized request — logically identical requests are byte-identical.
import { sortUniq } from "@/services/analyticsCache";
import type { RevenueIntelligenceRequest } from "@/services/revenueIntelligence";

export const REVENUE_QUERY_ROOT = "revenue";

export function normalizeRevenueQueryKey(request: RevenueIntelligenceRequest) {
  const f = request.filters ?? {};
  return {
    action: request.action === "day_breakdown" ? "day_breakdown" : "bundle",
    dateFrom: request.date_from || "",
    dateTo: request.date_to || "",
    bucket: request.bucket === "week" || request.bucket === "month" ? request.bucket : "day",
    date: request.date || "",
    funnel: sortUniq(f.funnel),
    campaignPath: sortUniq(f.campaign_path),
    campaignId: sortUniq(f.campaign_id),
    trafficSource: sortUniq(f.traffic_source),
    mediaBuyer: sortUniq(f.media_buyer),
    country: sortUniq(f.country),
    cardType: sortUniq(f.card_type),
    platform: sortUniq(f.platform),
    currency: sortUniq(f.currency),
    pricePlan: sortUniq(f.price_plan),
  };
}

export function revenueBundleKey(parts: { userScopeHash: string; warehouseVersion: string; request: RevenueIntelligenceRequest }) {
  return [REVENUE_QUERY_ROOT, "bundle", parts.userScopeHash, parts.warehouseVersion, normalizeRevenueQueryKey(parts.request)] as const;
}

export function revenueDayKey(parts: { userScopeHash: string; warehouseVersion: string; request: RevenueIntelligenceRequest }) {
  return [REVENUE_QUERY_ROOT, "day", parts.userScopeHash, parts.warehouseVersion, normalizeRevenueQueryKey(parts.request)] as const;
}
