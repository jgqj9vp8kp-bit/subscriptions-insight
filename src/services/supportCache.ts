import { sortUniq } from "@/services/analyticsCache";
import type { SupportQuery } from "@/services/supportDataSource";

export const SUPPORT_QUERY_ROOT = "support";

export function normalizeSupportRequest(query: SupportQuery, options: { includePage: boolean } = { includePage: true }) {
  return {
    dateFrom: query.filters.dateFrom || "",
    dateTo: query.filters.dateTo || "",
    funnel: sortUniq(query.filters.funnel ?? []),
    campaignPath: sortUniq(query.filters.campaignPath ?? []),
    category: query.filters.category && query.filters.category !== "all" ? [query.filters.category] : [],
    subcategory: query.filters.subcategory ? [query.filters.subcategory] : [],
    language: query.filters.language && query.filters.language !== "all" ? [query.filters.language] : [],
    urgency: query.filters.urgency && query.filters.urgency !== "all" ? [query.filters.urgency] : [],
    matchStatus: query.filters.matchStatus ?? "all",
    requiresCancellation: query.filters.requiresCancellation ?? "all",
    requiresRefund: query.filters.requiresRefund ?? "all",
    paymentRelated: query.filters.paymentRelated ?? "all",
    deliveryRelated: query.filters.deliveryRelated ?? "all",
    manualStatus: query.filters.manualStatus ?? "all",
    importBatchId: sortUniq(query.filters.importBatchId ? [query.filters.importBatchId] : []),
    search: (query.filters.search ?? "").trim(),
    sortBy: query.sortBy,
    sortDir: query.sortDir,
    ...(options.includePage ? { page: query.page, pageSize: query.pageSize } : {}),
  };
}

export function supportBundleKey(parts: { userScopeHash: string; warehouseVersion: string; request: SupportQuery }) {
  return [SUPPORT_QUERY_ROOT, "bundle", parts.userScopeHash, parts.warehouseVersion, normalizeSupportRequest(parts.request, { includePage: false })] as const;
}

export function supportListKey(parts: { userScopeHash: string; warehouseVersion: string; request: SupportQuery }) {
  return [SUPPORT_QUERY_ROOT, "list", parts.userScopeHash, parts.warehouseVersion, normalizeSupportRequest(parts.request, { includePage: true })] as const;
}

export function supportDetailsKey(parts: { userScopeHash: string; warehouseVersion: string; requestId: string | null }) {
  return [SUPPORT_QUERY_ROOT, "details", parts.userScopeHash, parts.warehouseVersion, parts.requestId ?? "none"] as const;
}
