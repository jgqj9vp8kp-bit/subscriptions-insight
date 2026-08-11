// Banks tab query-cache keys (mirrors paymentAnalyticsCache). One bundle per
// (user, warehouse version, normalized query); details cached per issuer on top
// of the same scope.
import { sortUniq } from "@/services/analyticsCache";
import type { BankAnalyticsQuery } from "@/services/bankAnalyticsDataSource";

// Rides the payment-analytics root so warehouse-sync invalidation reaches it
// without a new entry in WAREHOUSE_DEPENDENT_ROOTS.
export const BANK_QUERY_ROOT = "payment-analytics" as const;
export const BANK_ANALYTICS_RESPONSE_SCHEMA_VERSION = 1;

export interface NormalizedBankRequest {
  dateBasis: string;
  dateFrom: string | null;
  dateTo: string | null;
  funnel: string[];
  campaignPath: string[];
  issuer: string[];
  issuerGroup: string[];
  cardNetwork: string[];
  paymentMethod: string[];
  issuerCountry: string[];
  stage: string[];
  outcome: string;
}

export function normalizeBankRequest(q: BankAnalyticsQuery): NormalizedBankRequest {
  return {
    dateBasis: q.dateBasis,
    dateFrom: q.dateFrom || null,
    dateTo: q.dateTo || null,
    funnel: sortUniq(q.funnel),
    campaignPath: sortUniq(q.campaignPath),
    issuer: sortUniq(q.issuer),
    issuerGroup: sortUniq(q.issuerGroup),
    cardNetwork: sortUniq(q.cardNetwork),
    paymentMethod: sortUniq(q.paymentMethod),
    issuerCountry: sortUniq(q.issuerCountry),
    stage: sortUniq(q.stage),
    outcome: q.outcome,
  };
}

export function bankAnalyticsBundleKey(parts: {
  userScopeHash: string;
  warehouseVersion: string;
  request: BankAnalyticsQuery;
}): [string, "banks", number, string, string, NormalizedBankRequest] {
  return [
    BANK_QUERY_ROOT,
    "banks",
    BANK_ANALYTICS_RESPONSE_SCHEMA_VERSION,
    parts.userScopeHash,
    parts.warehouseVersion,
    normalizeBankRequest(parts.request),
  ];
}

export function bankDetailKey(parts: {
  userScopeHash: string;
  warehouseVersion: string;
  request: BankAnalyticsQuery;
  issuerKey: string;
}): [string, "bank-detail", number, string, string, string, NormalizedBankRequest] {
  return [
    BANK_QUERY_ROOT,
    "bank-detail",
    BANK_ANALYTICS_RESPONSE_SCHEMA_VERSION,
    parts.userScopeHash,
    parts.warehouseVersion,
    parts.issuerKey,
    normalizeBankRequest(parts.request),
  ];
}
