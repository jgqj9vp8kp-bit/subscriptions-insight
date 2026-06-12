import type { CohortRow } from "@/services/types";
import type { Transaction } from "@/services/types";

export interface CohortFilters {
  funnelFilter?: string;
  campaignPathFilter?: string;
  refundFilter?: string;
  cohortDateFrom?: string;
  cohortDateTo?: string;
}

export interface CohortFilterDiagnostics {
  beforeFilters: number;
  afterDateFilter: number;
  afterFunnelFilter: number;
  afterCampaignFilter: number;
  afterRefundFilter: number;
}

export interface TrialAttributionFilters {
  trafficSourceFilter?: string;
  campaignIdFilter?: string;
  selectedCampaignIds?: readonly string[];
}

export const UNKNOWN_CAMPAIGN_ID = "unknown";

interface NormalizedDateRange {
  from: string | null;
  to: string | null;
  inverted: boolean;
  active: boolean;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function dateKey(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function normalizeCohortDateKey(value: unknown): string | null {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return null;

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/);
  if (isoMatch) {
    const [, yyyy, mm, dd] = isoMatch;
    const year = Number(yyyy);
    const month = Number(mm);
    const day = Number(dd);
    return isValidDateParts(year, month, day) ? dateKey(year, month, day) : null;
  }

  const dotMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (dotMatch) {
    const [, dd, mm, yyyy] = dotMatch;
    const year = Number(yyyy);
    const month = Number(mm);
    const day = Number(dd);
    return isValidDateParts(year, month, day) ? dateKey(year, month, day) : null;
  }

  return null;
}

function normalizeDateRange(from: unknown, to: unknown): NormalizedDateRange {
  const normalizedFrom = normalizeCohortDateKey(from);
  const normalizedTo = normalizeCohortDateKey(to);
  return {
    from: normalizedFrom,
    to: normalizedTo,
    inverted: Boolean(normalizedFrom && normalizedTo && normalizedFrom > normalizedTo),
    active: Boolean(normalizedFrom || normalizedTo),
  };
}

export function cohortMatchesDateRange(cohort: Pick<CohortRow, "cohort_date">, range: NormalizedDateRange): boolean {
  if (!range.active) return true;
  if (range.inverted) return false;

  const cohortDate = normalizeCohortDateKey(cohort.cohort_date);
  if (!cohortDate) return false;
  if (range.from && cohortDate < range.from) return false;
  if (range.to && cohortDate > range.to) return false;
  return true;
}

export function filterCohortsWithDiagnostics<T extends CohortRow>(
  cohorts: T[],
  filters: CohortFilters,
): { cohorts: T[]; diagnostics: CohortFilterDiagnostics } {
  const range = normalizeDateRange(filters.cohortDateFrom, filters.cohortDateTo);
  const dateFiltered = cohorts.filter((cohort) => cohortMatchesDateRange(cohort, range));
  const funnelFiltered =
    filters.funnelFilter && filters.funnelFilter !== "all"
      ? dateFiltered.filter((cohort) => cohort.funnel === filters.funnelFilter)
      : dateFiltered;
  const campaignFiltered =
    filters.campaignPathFilter && filters.campaignPathFilter !== "all"
      ? funnelFiltered.filter((cohort) => cohort.campaign_path === filters.campaignPathFilter)
      : funnelFiltered;
  const refundFiltered = campaignFiltered.filter((cohort) => {
    if (filters.refundFilter === "has") return cohort.refund_users > 0;
    if (filters.refundFilter === "none") return cohort.refund_users === 0;
    return true;
  });

  return {
    cohorts: refundFiltered,
    diagnostics: {
      beforeFilters: cohorts.length,
      afterDateFilter: dateFiltered.length,
      afterFunnelFilter: funnelFiltered.length,
      afterCampaignFilter: campaignFiltered.length,
      afterRefundFilter: refundFiltered.length,
    },
  };
}

export function filterCohorts<T extends CohortRow>(cohorts: T[], filters: CohortFilters): T[] {
  return filterCohortsWithDiagnostics(cohorts, filters).cohorts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeLookupKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueAtPath(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    const direct = current[segment];
    if (direct !== undefined) {
      current = direct;
      continue;
    }
    const normalizedSegment = normalizeLookupKey(segment);
    const matchingKey = Object.keys(current).find((key) => normalizeLookupKey(key) === normalizedSegment);
    if (!matchingKey) return undefined;
    current = current[matchingKey];
  }
  return current;
}

function firstStringValue(source: unknown, paths: readonly (readonly string[])[]): string | null {
  for (const path of paths) {
    const value = valueAtPath(source, path);
    if (value == null) continue;
    const normalized = String(value).trim();
    if (normalized) return normalized;
  }
  return null;
}

export function normalizeCampaignId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  return normalized || UNKNOWN_CAMPAIGN_ID;
}

export function campaignIdLabel(campaignId: string): string {
  return campaignId === UNKNOWN_CAMPAIGN_ID ? "Unknown" : campaignId;
}

export function campaignIdForTransaction(tx: Pick<Transaction, "campaign_id" | "metadata" | "raw">): string {
  return normalizeCampaignId(
    tx.campaign_id ||
      firstStringValue(tx, [["campaign_id"], ["campaign", "id"], ["normalized_payload", "campaign_id"], ["raw_payload", "campaign_id"], ["raw_payload", "campaign", "id"]]) ||
      firstStringValue(tx.metadata, [["campaign_id"], ["campaign", "id"], ["normalized_payload", "campaign_id"]]) ||
      firstStringValue(tx.raw, [["campaign_id"], ["campaign", "id"], ["raw_payload", "campaign_id"], ["raw_payload", "campaign", "id"], ["normalized_payload", "campaign_id"]]),
  );
}

export function campaignNameForTransaction(tx: Pick<Transaction, "metadata" | "raw">): string | null {
  return (
    firstStringValue(tx, [["campaign_name"], ["campaign", "name"], ["raw_payload", "campaign_name"], ["raw_payload", "campaign", "name"], ["normalized_payload", "campaign_name"]]) ||
    firstStringValue(tx.metadata, [["campaign_name"], ["campaign", "name"], ["normalized_payload", "campaign_name"]]) ||
    firstStringValue(tx.raw, [["campaign_name"], ["campaign", "name"], ["raw_payload", "campaign_name"], ["raw_payload", "campaign", "name"], ["normalized_payload", "campaign_name"]])
  );
}

export function filterTransactionsByTrialAttribution<
  T extends Pick<Transaction, "user_id" | "status" | "transaction_type" | "traffic_source" | "campaign_id"> &
    Partial<Pick<Transaction, "metadata" | "raw">>,
>(
  transactions: T[],
  filters: TrialAttributionFilters,
): T[] {
  const hasTrafficSourceFilter = Boolean(filters.trafficSourceFilter && filters.trafficSourceFilter !== "all");
  const selectedCampaignIds = new Set(
    [
      ...(filters.selectedCampaignIds ?? []),
      ...(filters.campaignIdFilter && filters.campaignIdFilter !== "all" ? [filters.campaignIdFilter] : []),
    ]
      .map(normalizeCampaignId)
      .filter(Boolean),
  );
  const hasCampaignIdFilter = selectedCampaignIds.size > 0;
  if (!hasTrafficSourceFilter && !hasCampaignIdFilter) return transactions;

  const matchingTrialUsers = new Set(
    transactions
      .filter((tx) => {
        if (tx.status !== "success" || tx.transaction_type !== "trial") return false;
        if (hasTrafficSourceFilter && tx.traffic_source !== filters.trafficSourceFilter) return false;
        if (hasCampaignIdFilter && !selectedCampaignIds.has(campaignIdForTransaction(tx))) return false;
        return true;
      })
      .map((tx) => tx.user_id),
  );

  return transactions.filter((tx) => matchingTrialUsers.has(tx.user_id));
}
