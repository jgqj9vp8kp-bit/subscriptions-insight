// Users query-cache keys + filter normalization (mirrors cohortsCache). Shared
// analytics primitives come from analyticsCache. Two logically-identical filter
// sets produce the same key; the summary key excludes pagination so paging does
// not refetch the summary, and options are keyed by version only (shared across
// all filters).

import { sortUniq } from "@/services/analyticsCache";
import type { UsersQuery } from "@/services/usersDataSource";

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
  decline_reason: string[];
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
    decline_reason: sortUniq(q.declineReasons),
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

// Options are request-independent — one entry per (user, warehouse version).
export function usersOptionsKey(parts: { userScopeHash: string; warehouseVersion: string }): [string, "options", string, string] {
  return [USERS_QUERY_ROOT, "options", parts.userScopeHash, parts.warehouseVersion];
}
