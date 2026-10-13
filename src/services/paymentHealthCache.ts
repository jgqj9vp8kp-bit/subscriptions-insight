// Payment System Health query-cache keys (mirrors paymentAnalyticsCache).
//
// One cached entry per (access partition, warehouse version, action, normalized
// request). The partition slot carries the server-issued access partition
// (plan §20): an answer fetched under one principal, role or funnel scope — or
// with the PSP key — is never served under another. The warehouse version
// re-keys everything after an import + sync; the schema version discards
// persisted entries whose layout this build no longer reads.

import {
  DIMENSION_ACTIONS,
  WINDOWED_ACTIONS,
  activeFilters,
  normalizeAlertsFilters,
  type PaymentAlertsFilters,
  type PaymentHealthAction,
  type PaymentHealthFilters,
  type PaymentHealthQuery,
} from "@/services/paymentHealthDataSource";

export const PAYMENT_HEALTH_QUERY_ROOT = "payment-health" as const;
/** v1: the P2 contract (paymentHealthContract.ts). */
export const PAYMENT_HEALTH_RESPONSE_SCHEMA_VERSION = 1;

export interface NormalizedPaymentHealthRequest {
  date_from: string | null;
  date_to: string | null;
  filters: Partial<PaymentHealthFilters>;
  dimension: string | null;
}

/** The part of a query the action reads: window-free actions normalize to the
 * same empty request whatever the page's filters are, and the dimension counts
 * only where the server breaks down by it. */
export function normalizePaymentHealthRequest(action: PaymentHealthAction, query: PaymentHealthQuery): NormalizedPaymentHealthRequest {
  if (!WINDOWED_ACTIONS.has(action)) return { date_from: null, date_to: null, filters: {}, dimension: null };
  return {
    date_from: query.dateFrom || null,
    date_to: query.dateTo || null,
    filters: activeFilters(query.filters),
    dimension: DIMENSION_ACTIONS.has(action) ? query.dimension || null : null,
  };
}

export type PaymentHealthQueryKey = [typeof PAYMENT_HEALTH_QUERY_ROOT, PaymentHealthAction, number, string, string, NormalizedPaymentHealthRequest];

export function paymentHealthQueryKey(parts: {
  userScopeHash: string;
  warehouseVersion: string;
  action: PaymentHealthAction;
  request: PaymentHealthQuery;
}): PaymentHealthQueryKey {
  return [
    PAYMENT_HEALTH_QUERY_ROOT,
    parts.action,
    PAYMENT_HEALTH_RESPONSE_SCHEMA_VERSION,
    parts.userScopeHash,
    parts.warehouseVersion,
    normalizePaymentHealthRequest(parts.action, parts.request),
  ];
}

// ---- payment risk alerts (P2.5) ----------------------------------------------
// A root of their own, deliberately NOT in WAREHOUSE_DEPENDENT_ROOTS: alerts are
// mutable shared state (people change statuses, the daily run raises and
// resolves them), so they are never persisted to sessionStorage — a reload
// reads them fresh — and they are not keyed by the warehouse version (an import
// changes no alert until the next run). The partition slot keeps one
// principal's list (PSP-scoped alerts included or not) from serving another.

export const PAYMENT_HEALTH_ALERTS_QUERY_ROOT = "payment-health-alerts" as const;
/** v1: paymentRiskAlertsContract.ts as of P2.5. */
export const PAYMENT_HEALTH_ALERTS_SCHEMA_VERSION = 1;

export type PaymentHealthAlertsQueryKey = [typeof PAYMENT_HEALTH_ALERTS_QUERY_ROOT, "alerts_list", number, string, PaymentAlertsFilters];

export function paymentHealthAlertsQueryKey(parts: { userScopeHash: string; filters: Partial<PaymentAlertsFilters> }): PaymentHealthAlertsQueryKey {
  return [PAYMENT_HEALTH_ALERTS_QUERY_ROOT, "alerts_list", PAYMENT_HEALTH_ALERTS_SCHEMA_VERSION, parts.userScopeHash, normalizeAlertsFilters(parts.filters)];
}

/** What a status change or a run invalidates: every alert list (any filter). */
export const PAYMENT_HEALTH_ALERTS_QUERY_PREFIX = [PAYMENT_HEALTH_ALERTS_QUERY_ROOT] as const;
