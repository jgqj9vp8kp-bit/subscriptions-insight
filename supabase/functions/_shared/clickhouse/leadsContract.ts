// Shared request/response contract for the server-side Leads actions of the
// clickhouse-users Edge Function (leads plan §3): `leads_list` and
// `leads_overview`. Pure module (no Deno, no remote imports): the browser
// imports the types (src/services/clickhouse.ts runClickHouseLeads), the Edge
// imports normalizeLeadsRequest / LeadsRequestError, and vitest drives both.
//
// One row per lead. Sources (`source`):
//   warehouse               a ClickHouse user (analytics_transactions) with an
//                           email, no successful payment and no active
//                           subscription — exactly src/services/leads.ts
//                           computeLeads for the warehouse;
//   funnelfox_profile       a stored FunnelFox profile (email from the profile
//                           LIST, preview runs excluded) that is not paid, not
//                           active and matches no warehouse lead;
//   both                    a warehouse lead whose email also has a profile;
//   funnelfox_subscription  a FunnelFox subscription email that never reached
//                           the warehouse (computeLeads' subscription-only leads).
//
// The lead set is the newest diagnostics.lead_set_limit (1,000) leads by
// lead_date (owner decision 2026-10-07, for speed): rows, pages, search,
// filters, filter options and the lead counts cover only those; the
// emails_found / converted_excluded / active_subs_excluded KPIs are whole-base.
//
// Rows carry the customer email (the Leads tab displays it); the actions are
// data-owner only for now (policy: rawOnly + users.view + users.pii.view +
// leads.view). No raw payloads, SQL or credentials are ever returned.

import { UNKNOWN_COUNTRY } from "./usersContract.ts";

export { UNKNOWN_COUNTRY };

export type LeadsAction = "leads_list" | "leads_overview";
export const LEADS_ACTIONS: readonly LeadsAction[] = ["leads_list", "leads_overview"];

export type LeadSource = "warehouse" | "funnelfox_profile" | "both" | "funnelfox_subscription";
export const LEAD_SOURCES: readonly LeadSource[] = ["warehouse", "funnelfox_profile", "both", "funnelfox_subscription"];

/** "has" = at least one declined payment attempt, "none" = no declines. */
export type LeadsDeclineFilter = "all" | "has" | "none";
export type LeadsSortDirection = "asc" | "desc";

/** Sortable columns (allowlist). Default: lead_date desc. */
export type LeadsSortKey =
  | "lead_date"
  | "email"
  | "funnel"
  | "campaign_path"
  | "campaign_id"
  | "media_buyer"
  | "country"
  | "session_date"
  | "days_since_visit"
  | "customer_id"
  | "source"
  | "has_declines"
  | "decline_reason";

export const LEADS_SORT_KEYS: readonly LeadsSortKey[] = [
  "lead_date",
  "email",
  "funnel",
  "campaign_path",
  "campaign_id",
  "media_buyer",
  "country",
  "session_date",
  "days_since_visit",
  "customer_id",
  "source",
  "has_declines",
  "decline_reason",
];

export const LEADS_DEFAULT_PAGE_SIZE = 50;
export const LEADS_MAX_PAGE_SIZE = 200;
/** Upper bound for one multi-select filter list (same bound as the Users filters). */
export const LEADS_MAX_FILTER_VALUES = 500;
export const LEADS_MAX_SEARCH_LENGTH = 200;

export interface LeadsFiltersInput {
  /** Case-insensitive substring of the email or the customer id. */
  search?: string | null;
  /** Inclusive YYYY-MM-DD bounds on the UTC date of lead_date. */
  date_from?: string | null;
  date_to?: string | null;
  funnel?: string[] | null;
  campaign_path?: string[] | null;
  campaign_id?: string[] | null;
  media_buyer?: string[] | null;
  /** ISO codes; UNKNOWN_COUNTRY ("Unknown") selects leads without a country. */
  country?: string[] | null;
  /** One source, a list of sources, or "all" / empty for every source. */
  source?: LeadSource | "all" | LeadSource[] | null;
  /** "has" / "none" (also accepted: "yes" / "no" / true / false); default "all". */
  has_declines?: LeadsDeclineFilter | "yes" | "no" | boolean | null;
}

export interface LeadsRequest {
  action: LeadsAction;
  filters?: LeadsFiltersInput;
  sort?: { key?: LeadsSortKey; dir?: LeadsSortDirection };
  /** 1-based. Default 1. */
  page?: number;
  /** Default 50, max 200. */
  page_size?: number;
  /** Bypass the 60 s per-workspace server memo (e.g. right after a sync). */
  refresh?: boolean;
}

export interface LeadRow {
  /** Stable row key: "w:<user_id>" (warehouse / both), "p:<profile_id>", "s:<email>". */
  key: string;
  email: string;
  /** When the lead came in: the earliest known contact over every merged source (ISO, UTC). */
  lead_date: string | null;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  media_buyer: string;
  country: string | null;
  /** The row's own first contact: the warehouse first touch for warehouse / both
   * rows, the profile / subscription date otherwise (ISO, UTC). */
  session_date: string | null;
  /** Whole days from lead_date to the server clock. */
  days_since_visit: number | null;
  /** Warehouse user_id, FunnelFox profile id, or the subscription's profile/subscription id. */
  customer_id: string;
  user_agent: string | null;
  origin: string | null;
  source: LeadSource;
  has_declines: boolean;
  decline_reason: string | null;
}

export interface LeadsPagination {
  page: number;
  page_size: number;
  total_rows: number;
  total_pages: number;
}

export type LeadsMemoState = "miss" | "hit" | "coalesced" | "refresh";

export interface LeadsDiagnostics {
  warehouse_leads: number;
  profile_leads: number;
  both_leads: number;
  subscription_leads: number;
  /** How this request got the merged lead set. */
  memo: LeadsMemoState;
  /** Age of the merged lead set when this response was built. */
  dataset_age_ms: number;
  // The lead_set_* / candidates_* fields are always sent by this build; optional
  // so a page served before the Edge redeploy (or a test fixture) still types.
  /** The lead set holds at most this many leads: the newest by lead date
   * (owner decision 2026-10-07; LEADS_RECENT_LIMIT, 1,000). */
  lead_set_limit?: number;
  /** Older leads exist than the set holds: the list, search, filters, filter
   * options and the lead counts (total / today / last 7 days) cover the newest
   * lead_set_limit only. emails_found / converted_excluded /
   * active_subs_excluded stay whole-base. */
  lead_set_limited?: boolean;
  /** The oldest lead_date in the set (ISO, UTC) — "since" in the page's banner. */
  lead_set_oldest_date?: string | null;
  /** When Postgres computed the lead candidates (ISO, UTC; the cache is refreshed
   * every 5 minutes). Null when the server fell back to the uncached RPC. */
  candidates_computed_at?: string | null;
  /** The candidates came from the Postgres cache (not computed for this load). */
  candidates_cached?: boolean;
  /** leads_list only: the page's profile user_agent / origin could not be read
   * (the rows carry what the merge had). */
  profile_details_unavailable?: boolean;
}

export interface LeadsListResponse {
  ok: true;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  rows: LeadRow[];
  pagination: LeadsPagination;
  diagnostics: LeadsDiagnostics;
}

export interface LeadsSummary {
  /** Rows of the lead set (unfiltered): the newest diagnostics.lead_set_limit leads at most. */
  total_leads: number;
  /** Whole base: distinct emails over warehouse ∪ FunnelFox profiles ∪ FunnelFox subscriptions. */
  emails_found: number;
  /** Whole base: distinct emails with a successful payment. */
  converted_excluded: number;
  /** Whole base: distinct emails with an active subscription that are not paid. */
  active_subs_excluded: number;
  /** Leads of the set with lead_date on today's UTC date. */
  leads_today: number;
  /** Leads of the set with lead_date within the last 7 × 24 h. */
  leads_last_7_days: number;
}

export interface LeadsFilterOption {
  value: string;
  /** Leads of the (unfiltered) lead set carrying this value. */
  count: number;
}

export interface LeadsFilterOptions {
  funnel: LeadsFilterOption[];
  campaign_path: LeadsFilterOption[];
  campaign_id: LeadsFilterOption[];
  media_buyer: LeadsFilterOption[];
  /** Includes UNKNOWN_COUNTRY (pinned last) when some leads have no country. */
  country: LeadsFilterOption[];
  source: LeadsFilterOption[];
}

/** Scalar stats of funnelfox_leads_sync_state (nested objects and free text are dropped). */
export type LeadsSyncStats = Record<string, number | boolean | string | null>;

export interface LeadsSyncState {
  /** funnelfox_leads_sync_state.last_status (ok / partial / error / rate_limited / …), null before the first run. */
  status: string | null;
  current_stage: string | null;
  last_full_sync_at: string | null;
  stats: LeadsSyncStats;
  /** Set while FunnelFox throttles the crawl (stats.rate_limited_until), else null. */
  rate_limited_until: string | null;
  /** ISO estimate of the next background tick that does work: the end of a
   * rate-limit pause, else the next minute while the pipeline is unfinished,
   * else the next daily refresh (06:15 UTC). Null when nothing is known. */
  next_tick_hint: string | null;
  /** A sync call currently holds the lease. */
  running: boolean;
}

export interface LeadsOverviewResponse {
  ok: true;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  summary: LeadsSummary;
  filter_options: LeadsFilterOptions;
  sync_state: LeadsSyncState;
  diagnostics: LeadsDiagnostics;
}

/** A malformed leads request: answered 400 by clickhouse-users (onError). */
export class LeadsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadsRequestError";
  }
}

export interface NormalizedLeadsFilters {
  search: string;
  dateFrom: string | null;
  dateTo: string | null;
  funnel: string[];
  campaignPath: string[];
  campaignId: string[];
  mediaBuyer: string[];
  country: string[];
  /** Empty = every source. */
  source: LeadSource[];
  hasDeclines: LeadsDeclineFilter;
}

export interface NormalizedLeadsRequest {
  action: LeadsAction;
  filters: NormalizedLeadsFilters;
  sortKey: LeadsSortKey;
  sortDir: LeadsSortDirection;
  page: number;
  pageSize: number;
  refresh: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function validDate(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  const raw = text(value).trim();
  if (!DATE_RE.test(raw) || !Number.isFinite(Date.parse(`${raw}T00:00:00.000Z`))) {
    throw new LeadsRequestError(`Invalid ${field} (expected YYYY-MM-DD): ${raw.slice(0, 40)}`);
  }
  return raw;
}

function stringList(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new LeadsRequestError(`Filter ${field} must be an array.`);
  const out = Array.from(new Set(value.map((entry) => text(entry).trim()).filter(Boolean)));
  if (out.length > LEADS_MAX_FILTER_VALUES) throw new LeadsRequestError(`Filter ${field} too large (max ${LEADS_MAX_FILTER_VALUES}).`);
  return out;
}

// Country values are canonical upper-case ISO codes; the Unknown sentinel is
// folded case-insensitively (same rule as the Users country filter).
function countryList(value: unknown): string[] {
  return Array.from(new Set(
    stringList(value, "country").map((entry) => (entry.toLowerCase() === UNKNOWN_COUNTRY.toLowerCase() ? UNKNOWN_COUNTRY : entry.toUpperCase())),
  ));
}

function sourceList(value: unknown): LeadSource[] {
  if (value == null || value === "" || value === "all") return [];
  const values = Array.isArray(value) ? value : [value];
  const out = new Set<LeadSource>();
  for (const entry of values) {
    const source = text(entry).trim();
    if (!source || source === "all") continue;
    if (!(LEAD_SOURCES as readonly string[]).includes(source)) throw new LeadsRequestError(`Unsupported source filter: ${source.slice(0, 40)}`);
    out.add(source as LeadSource);
  }
  return out.size === LEAD_SOURCES.length ? [] : [...out];
}

function declineFilter(value: unknown): LeadsDeclineFilter {
  if (value === true || value === "has" || value === "yes") return "has";
  if (value === false || value === "none" || value === "no") return "none";
  return "all";
}

function positiveInt(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Validates a leads request body. Throws LeadsRequestError on anything malformed. */
export function normalizeLeadsRequest(body: unknown): NormalizedLeadsRequest {
  const request = isRecord(body) ? body : {};
  const action = request.action;
  if (action !== "leads_list" && action !== "leads_overview") throw new LeadsRequestError(`Unsupported leads action: ${text(action).slice(0, 40)}`);
  if (request.filters != null && !isRecord(request.filters)) throw new LeadsRequestError("filters must be an object.");
  if (request.sort != null && !isRecord(request.sort)) throw new LeadsRequestError("sort must be an object.");
  const filters = (request.filters ?? {}) as Record<string, unknown>;
  const sort = (request.sort ?? {}) as Record<string, unknown>;

  const sortKey = text(sort.key || "lead_date");
  if (!(LEADS_SORT_KEYS as readonly string[]).includes(sortKey)) throw new LeadsRequestError(`Unsupported sort key: ${sortKey.slice(0, 40)}`);
  const dateFrom = validDate(filters.date_from, "date_from");
  const dateTo = validDate(filters.date_to, "date_to");
  if (dateFrom && dateTo && dateFrom > dateTo) throw new LeadsRequestError("date_from must not be after date_to.");

  return {
    action,
    filters: {
      search: text(filters.search).trim().slice(0, LEADS_MAX_SEARCH_LENGTH),
      dateFrom,
      dateTo,
      funnel: stringList(filters.funnel, "funnel"),
      campaignPath: stringList(filters.campaign_path, "campaign_path"),
      campaignId: stringList(filters.campaign_id, "campaign_id"),
      mediaBuyer: stringList(filters.media_buyer, "media_buyer"),
      country: countryList(filters.country),
      source: sourceList(filters.source),
      hasDeclines: declineFilter(filters.has_declines),
    },
    sortKey: sortKey as LeadsSortKey,
    sortDir: sort.dir === "asc" ? "asc" : "desc",
    page: positiveInt(request.page, 1),
    pageSize: Math.min(LEADS_MAX_PAGE_SIZE, positiveInt(request.page_size, LEADS_DEFAULT_PAGE_SIZE)),
    refresh: request.refresh === true,
  };
}
