// Users query-cache keys + filter normalization (mirrors cohortsCache). Shared
// analytics primitives come from analyticsCache. Two logically-identical filter
// sets produce the same key; the summary key excludes pagination so paging does
// not refetch the summary, and the options key carries the filter scope the
// dependent option branches are computed over.

import { sortUniq } from "@/services/analyticsCache";
import type { UsersDeclineQuery, UsersQuery } from "@/services/usersDataSource";

export const USERS_QUERY_ROOT = "users" as const;

export interface NormalizedUsersRequest {
  search: string;
  date_from: string | null;
  date_to: string | null;
  first_sub: string;
  refund: string;
  payment_failed: string;
  failed_attempts: string;
  active_subscription: string;
  campaign_path: string | null;
  country: string | null;
  card_type: string[];
  platform: string[];
  decline_reason: string[];
  cohort_ids: string[];
  funnel: string[];
  media_buyer: string[];
  currency: string[];
  sort: { field: string; direction: string };
  page: number | null;
  page_size: number;
}

const single = (v: string | null | undefined): string | null => (v && v !== "all" ? v : null);

export function normalizeUsersRequest(q: UsersQuery, opts: { includePage?: boolean } = {}): NormalizedUsersRequest {
  return {
    search: (q.search ?? "").trim(),
    date_from: q.firstTrialFrom || null,
    date_to: q.firstTrialTo || null,
    first_sub: q.firstSub ?? "all",
    refund: q.refund ?? "all",
    payment_failed: q.paymentFailed ?? "all",
    failed_attempts: q.failedAttempts ?? "all",
    active_subscription: q.activeSubscription ?? "all",
    campaign_path: single(q.campaignPath),
    country: single(q.country),
    card_type: sortUniq(q.cardTypes),
    platform: sortUniq(q.platform),
    decline_reason: sortUniq(q.declineReasons),
    cohort_ids: sortUniq(q.cohortIds),
    funnel: sortUniq(q.funnel),
    media_buyer: sortUniq(q.mediaBuyer),
    currency: sortUniq(q.currency),
    sort: { field: q.sortField, direction: q.sortDir },
    page: opts.includePage ? q.page : null,
    page_size: q.pageSize,
  };
}

interface UsersKeyParts {
  userScopeHash: string;
  warehouseVersion: string;
  request: UsersQuery;
}

// List includes pagination (server-side) so each page is its own entry.
export function usersListKey(parts: UsersKeyParts): [string, "list", string, string, NormalizedUsersRequest] {
  return [USERS_QUERY_ROOT, "list", parts.userScopeHash, parts.warehouseVersion, normalizeUsersRequest(parts.request, { includePage: true })];
}

// Summary excludes pagination — the same across pages of one filter set.
export function usersSummaryKey(parts: UsersKeyParts): [string, "summary", string, string, NormalizedUsersRequest] {
  return [USERS_QUERY_ROOT, "summary", parts.userScopeHash, parts.warehouseVersion, normalizeUsersRequest(parts.request, { includePage: false })];
}

// Options carry the filter scope, because two of the branches the server
// returns are DEPENDENT: the country list respects every filter except country,
// and the cohort list respects every filter except the cohort selection. Each
// branch excludes only ITSELF, so country still narrows the cohort list and the
// cohort selection still narrows the country list — which is why both belong in
// this key even though each is excluded from its own branch. Sort and pagination
// stay out: they cannot change what the lists contain.
export interface UsersOptionsScope {
  search: string;
  date_from: string | null;
  date_to: string | null;
  first_sub: string;
  refund: string;
  payment_failed: string;
  failed_attempts: string;
  active_subscription: string;
  campaign_path: string | null;
  country: string | null;
  cohort_ids: string[];
  card_type: string[];
  platform: string[];
  decline_reason: string[];
  funnel: string[];
  media_buyer: string[];
  currency: string[];
}

export function usersOptionsScope(q: UsersQuery): UsersOptionsScope {
  const norm = normalizeUsersRequest(q, { includePage: false });
  return {
    search: norm.search,
    date_from: norm.date_from,
    date_to: norm.date_to,
    first_sub: norm.first_sub,
    refund: norm.refund,
    payment_failed: norm.payment_failed,
    failed_attempts: norm.failed_attempts,
    active_subscription: norm.active_subscription,
    campaign_path: norm.campaign_path,
    country: norm.country,
    cohort_ids: norm.cohort_ids,
    card_type: norm.card_type,
    // In the options scope even though the Platform list itself is a fixed enum:
    // platform is part of userWhere, so it narrows the DEPENDENT branches
    // (country, cohort) of the same response.
    platform: norm.platform,
    decline_reason: norm.decline_reason,
    funnel: norm.funnel,
    media_buyer: norm.media_buyer,
    currency: norm.currency,
  };
}

export function usersOptionsKey(parts: { userScopeHash: string; warehouseVersion: string; request: UsersQuery }): [string, "options", string, string, UsersOptionsScope] {
  return [USERS_QUERY_ROOT, "options", parts.userScopeHash, parts.warehouseVersion, usersOptionsScope(parts.request)];
}

// Decline bundle: user-scope filters (incl. country, WITHOUT pagination/table
// sort) + the tab's reason/stage display filters + the country-breakdown sort.
export interface NormalizedUsersDeclineRequest extends Omit<NormalizedUsersRequest, "sort" | "page" | "page_size"> {
  analytics_reasons: string[];
  analytics_stages: string[];
  country_sort: { field: string; direction: string };
}

export function normalizeUsersDeclineRequest(q: UsersDeclineQuery): NormalizedUsersDeclineRequest {
  const { sort: _sort, page: _page, page_size: _pageSize, ...scope } = normalizeUsersRequest(
    { ...q, sortField: "first_trial_date", sortDir: "desc", page: 1, pageSize: 0 },
    { includePage: false },
  );
  return {
    ...scope,
    analytics_reasons: sortUniq(q.analyticsReasons),
    analytics_stages: sortUniq(q.analyticsStages),
    country_sort: { field: q.countrySortField, direction: q.countrySortDir },
  };
}

export function usersDeclineKey(parts: { userScopeHash: string; warehouseVersion: string; request: UsersDeclineQuery }): [string, "decline", string, string, NormalizedUsersDeclineRequest] {
  return [USERS_QUERY_ROOT, "decline", parts.userScopeHash, parts.warehouseVersion, normalizeUsersDeclineRequest(parts.request)];
}
