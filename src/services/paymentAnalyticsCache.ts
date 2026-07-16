// Payment Pass Analytics query-cache key + normalization (mirrors cohortsCache).
// The Edge returns ONE consolidated bundle (summary, charts, tables, options), so
// there is a single cached entry per (user, warehouse version, filter+selectors).

import type { PaymentAnalyticsQuery } from "@/services/paymentAnalyticsDataSource";

export const PAYMENT_QUERY_ROOT = "payment-analytics" as const;
export const PAYMENT_ANALYTICS_RESPONSE_SCHEMA_VERSION = 2;

export interface NormalizedPaymentRequest {
  dateBasis: string;
  dateFrom: string | null;
  dateTo: string | null;
  funnel: string;
  campaignPath: string;
  campaignId: string;
  mediaBuyer: string;
  country: string;
  cardType: string;
  stage: string;
  declineReason: string;
  transactionType: string;
  outcome: string;
  groupBy: string;
  firstTxDimension: string;
  renewalDimension: string;
}

export function normalizePaymentRequest(q: PaymentAnalyticsQuery): NormalizedPaymentRequest {
  return {
    dateBasis: q.dateBasis,
    dateFrom: q.dateFrom || null,
    dateTo: q.dateTo || null,
    funnel: q.funnel,
    campaignPath: q.campaignPath,
    campaignId: q.campaignId,
    mediaBuyer: q.mediaBuyer,
    country: q.country,
    cardType: q.cardType,
    stage: q.stage,
    declineReason: q.declineReason,
    transactionType: q.transactionType,
    outcome: q.outcome,
    groupBy: q.groupBy,
    firstTxDimension: q.firstTxDimension,
    renewalDimension: q.renewalDimension,
  };
}

export function paymentAnalyticsBundleKey(parts: {
  userScopeHash: string;
  warehouseVersion: string;
  request: PaymentAnalyticsQuery;
}): [string, "bundle", number, string, string, NormalizedPaymentRequest] {
  return [
    PAYMENT_QUERY_ROOT,
    "bundle",
    PAYMENT_ANALYTICS_RESPONSE_SCHEMA_VERSION,
    parts.userScopeHash,
    parts.warehouseVersion,
    normalizePaymentRequest(parts.request),
  ];
}
