import { runClickHouseSupport } from "@/services/clickhouse";
import type { SupportAnalyticsFilters } from "@/services/supportAnalytics";
import {
  EMPTY_CAMPAIGN_PATH,
  type SupportAnalyticsBundle,
  type SupportDetailsResponse,
  type SupportListResponse,
  type SupportOptionsResponse,
  type SupportRequest,
  type SupportSyncResult,
} from "../../supabase/functions/_shared/clickhouse/supportContract";

export interface SupportQuery {
  filters: SupportAnalyticsFilters;
  page: number;
  pageSize: number;
  sortBy: "received_at" | "funnel" | "campaign_path" | "category" | "urgency" | "language" | "matched_customer";
  sortDir: "asc" | "desc";
}

const tri = (value: boolean | "all" | undefined): "all" | "yes" | "no" =>
  value === true ? "yes" : value === false ? "no" : "all";

const matched = (value: SupportAnalyticsFilters["matchStatus"]): "all" | "yes" | "no" =>
  value === "matched" ? "yes" : value === "unmatched" ? "no" : "all";

export function buildSupportRequest(query: SupportQuery, action: SupportRequest["action"] = "bundle"): SupportRequest {
  const f = query.filters;
  return {
    action,
    date_from: f.dateFrom || null,
    date_to: f.dateTo || null,
    filters: {
      funnel: Array.from(new Set((f.funnel ?? []).map((value) => value.trim()).filter(Boolean))).sort(),
      campaign_path: Array.from(new Set((f.campaignPath ?? []).map((value) => value.trim()).filter(Boolean))).sort(),
      category: f.category && f.category !== "all" ? [f.category] : [],
      subcategory: f.subcategory ? [f.subcategory] : [],
      language: f.language && f.language !== "all" ? [f.language] : [],
      urgency: f.urgency && f.urgency !== "all" ? [f.urgency] : [],
      matched: matched(f.matchStatus),
      requires_cancellation: tri(f.requiresCancellation),
      requires_refund: tri(f.requiresRefund),
      payment_related: tri(f.paymentRelated),
      delivery_related: tri(f.deliveryRelated),
      manual_status: f.manualStatus ?? "all",
      import_batch_id: f.importBatchId ? [f.importBatchId] : [],
      search: f.search?.trim() ?? "",
    },
    sort: { field: query.sortBy, direction: query.sortDir },
    pagination: { page: query.page, page_size: query.pageSize },
  };
}

export async function loadSupportBundle(query: SupportQuery): Promise<SupportAnalyticsBundle> {
  const response = await runClickHouseSupport<SupportAnalyticsBundle>(buildSupportRequest(query, "bundle"));
  if (!response.ok) throw new Error(response.error || "ClickHouse support analytics failed.");
  return response;
}

export async function loadSupportPage(query: SupportQuery): Promise<SupportListResponse> {
  const response = await runClickHouseSupport<SupportListResponse>(buildSupportRequest(query, "list"));
  if (!response.ok) throw new Error(response.error || "ClickHouse support list failed.");
  return response;
}

export async function loadSupportDetails(requestId: string): Promise<SupportDetailsResponse> {
  const response = await runClickHouseSupport<SupportDetailsResponse>({ action: "details", request_id: requestId });
  if (!response.ok) throw new Error(response.error || "ClickHouse support details failed.");
  return response;
}

export async function loadSupportOptions(): Promise<SupportOptionsResponse> {
  const response = await runClickHouseSupport<SupportOptionsResponse>({ action: "options" });
  if (!response.ok) throw new Error(response.error || "ClickHouse support options failed.");
  return response;
}

export async function syncSupportToClickHouse(fullResetCursor = false): Promise<SupportSyncResult> {
  const response = await runClickHouseSupport<SupportSyncResult>({
    action: "sync",
    sync: {
      batch_size: 2000,
      max_batches: 20,
      full_reset_cursor: fullResetCursor,
    },
  });
  if (!response.ok) throw new Error(response.error || "ClickHouse support sync failed.");
  return response;
}

export type {
  SupportAnalyticsBundle,
  SupportDetailsResponse,
  SupportListResponse,
  SupportOptionsResponse,
  SupportSyncResult,
};
export { EMPTY_CAMPAIGN_PATH };
