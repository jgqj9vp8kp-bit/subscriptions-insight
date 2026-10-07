// Server-side Leads for clickhouse-users (leads plan §3): the actions
// `leads_list` and `leads_overview` replace the browser's computeLeads over the
// fully hydrated warehouse (src/services/leads.ts), which needed ~220 MB of raw
// transactions in the tab before it could show one row.
//
// One merged lead set per workspace, assembled from three reads run in parallel:
//   A. ClickHouse (analytics_transactions FINAL, tenant-bound by the
//      ScopedReader): one row per user_id with an email and no successful
//      payment — computeLeads' warehouse leads, field for field (see
//      buildWarehouseLeadsQuery);
//   B. Postgres RPC leads_profile_candidates(p_data_key, p_profile_limit):
//      stored FunnelFox profiles (list emails, preview runs excluded; light
//      columns only, newest first, at most LEADS_PROFILE_CANDIDATES_LIMIT) and
//      subscription-only emails, both already without paid / active emails,
//      plus the KPI counts;
//   C. activeSubscriptionsByEmail(pg, tenantKey): active emails (the Cohorts
//      definition) dropped from every source — computeLeads drops them too.
// mergeLeads (pure, exported) joins them; filtering, the sort allowlist and
// pagination run here in Edge over the merged set. The set is memoized per
// workspace for 60 s and concurrent requests share one in-flight load, so
// paging and filter changes cost no warehouse query.
//
// Size: the whole set lives in Edge memory, so the bulk read carries no
// profile user_agent / origin (the bulk of a row); leads_list reads those for
// the rows of the requested page only (hydrateProfileDetails). Past
// LEADS_PROFILE_CANDIDATES_LIMIT profile leads the newest ones are kept and the
// response says so (diagnostics.profile_candidates_truncated) — the signal to
// move the profile leads into ClickHouse (leads plan §4 step 7).
//
// Tenant: always ctx.tenantKey (the workspace data key) — the ScopedReader
// binds {auth_user_id:String} to it and the RPCs take it as p_data_key. A
// ScopeViolation is never swallowed.

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ANALYTICS_TRANSACTIONS_TABLE } from "./schema.ts";
import { ScopeViolation } from "./scopedClient.ts";
import { activeSubscriptionsByEmail } from "./cohortSubscriptions.ts";
import { MEDIA_BUYER_VALUES, mediaBuyerFromUtmSource } from "./userMediaBuyer.ts";
import { normalizeCountryCode } from "./userCountry.ts";
import {
  LEAD_SOURCES,
  UNKNOWN_COUNTRY,
  normalizeLeadsRequest,
  type LeadRow,
  type LeadsDiagnostics,
  type LeadsFilterOption,
  type LeadsFilterOptions,
  type LeadsListResponse,
  type LeadsMemoState,
  type LeadsOverviewResponse,
  type LeadsSortDirection,
  type LeadsSortKey,
  type LeadsSummary,
  type LeadsSyncState,
  type LeadsSyncStats,
  type NormalizedLeadsFilters,
} from "./leadsContract.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** How long a merged lead set is served from memory (per workspace). */
export const LEADS_MEMO_TTL_MS = 60_000;
/** Workspaces kept in the memo; the oldest entry is evicted beyond this. */
export const LEADS_MEMO_MAX_ENTRIES = 16;
/** Most FunnelFox profile leads one load takes into Edge memory (the newest; the
 * plan's scale trigger for the ClickHouse mirror). Beyond it the response is
 * flagged truncated instead of the isolate running out of memory / CPU. */
export const LEADS_PROFILE_CANDIDATES_LIMIT = 50_000;

// ---- A. ClickHouse warehouse lead candidates ----------------------------------------

/** computeLeads' isFailedPaymentTransaction over the stored columns. The import
 * mapper writes decline_reason exactly when the browser predicate holds for the
 * row (declineDetailsForTransaction), and is_failed for status 'failed' /
 * type 'failed_payment'; refunds and chargebacks are never declines. */
export const LEAD_FAILED_PAYMENT_SQL =
  "(status NOT IN ('refunded', 'chargeback') AND transaction_type NOT IN ('refund', 'chargeback') AND (is_failed = 1 OR decline_reason != ''))";

/** The keys computeLeads' readUserAgent tries, in order, on tx.metadata then tx.raw. */
const USER_AGENT_KEYS = ["user_agent", "userAgent", "ua", "browser_user_agent"] as const;

/** Per-row user agent, as computeLeads' readUserAgent reads it from the
 * hydrated transaction: metadata = normalized_payload.metadata (an object; a
 * JSON-string metadata is not read, like the browser), raw =
 * { ...normalized_payload.raw, ...raw_payload } (the stored raw payload wins
 * per key). Non-string values never count; '' when the row has none. */
export function leadUserAgentRowSql(): string {
  const metadata = "JSONExtractRaw(normalized_payload, 'metadata')";
  const payloadRaw = "JSONExtractRaw(normalized_payload, 'raw')";
  const branches: string[] = [];
  for (const key of USER_AGENT_KEYS) {
    const value = `trimBoth(JSONExtractString(${metadata}, '${key}'))`;
    branches.push(`${value} != '', ${value}`);
  }
  for (const key of USER_AGENT_KEYS) {
    const value = `trimBoth(if(JSONHas(raw_payload, '${key}'), JSONExtractString(raw_payload, '${key}'), JSONExtractString(${payloadRaw}, '${key}')))`;
    branches.push(`${value} != '', ${value}`);
  }
  return `multiIf(${branches.join(",\n      ")},\n      '')`;
}

const USER_AGENT_NEEDLES = `[${USER_AGENT_KEYS.map((key) => `'"${key}"'`).join(", ")}]`;

/**
 * Query A — computeLeads' warehouse leads, one row per user_id:
 *   email          the earliest non-empty normalized_email (the Users tab rule);
 *   lead           an email that never had a successful payment (any user_id);
 *   first touch    min(event_time) → session_date / lead_date;
 *   funnel, campaign_path, campaign_id   from the first-touch row;
 *   utm_source     mediaBuyerForUserTransactions: the first successful trial's,
 *                  else the first non-empty (the media buyer is mapped in Edge);
 *   country        the Users-tab expression (first successful row's country,
 *                  else the first non-empty);
 *   has_declines / decline_reason   any failed attempt / the latest one's reason;
 *   user_agent     the first row carrying one (payload read only for lead users).
 * Active-subscription emails are dropped in Edge (activeSubscriptionsByEmail).
 * Aliases are w_* so no aggregate shadows the column it reads.
 */
export function buildWarehouseLeadsQuery(): string {
  const TX = ANALYTICS_TRANSACTIONS_TABLE;
  const order = "(event_time, transaction_id)";
  return `WITH
paid AS (
  SELECT DISTINCT normalized_email AS email
  FROM ${TX} FINAL
  WHERE auth_user_id = {auth_user_id:String} AND is_success = 1 AND normalized_email != ''
),
per_user AS (
  SELECT
    user_id,
    argMinIf(normalized_email, ${order}, normalized_email != '') AS w_email,
    toUnixTimestamp64Milli(min(event_time)) AS w_first_touch_ms,
    argMin(funnel, ${order}) AS w_funnel,
    argMin(campaign_path, ${order}) AS w_campaign_path,
    argMin(campaign_id, ${order}) AS w_campaign_id,
    argMinIf(utm_source, ${order}, is_success = 1 AND transaction_type = 'trial') AS w_trial_utm,
    argMinIf(utm_source, ${order}, utm_source != '') AS w_first_utm,
    argMin(country_code, (multiIf(country_code = '', 2, is_success = 1, 0, 1), event_time)) AS w_country,
    countIf(${LEAD_FAILED_PAYMENT_SQL}) AS w_failed,
    argMaxIf(decline_reason, ${order}, ${LEAD_FAILED_PAYMENT_SQL}) AS w_decline_reason
  FROM ${TX} FINAL
  WHERE auth_user_id = {auth_user_id:String}
  GROUP BY user_id
),
leads AS (
  SELECT * FROM per_user
  WHERE w_email != '' AND w_email NOT IN (SELECT email FROM paid)
),
lead_ua AS (
  SELECT user_id, argMinIf(tx_ua, (event_time, transaction_id), tx_ua != '') AS w_user_agent
  FROM (
    SELECT user_id, event_time, transaction_id,
      ${leadUserAgentRowSql()} AS tx_ua
    FROM ${TX} FINAL
    WHERE auth_user_id = {auth_user_id:String}
      AND user_id IN (SELECT user_id FROM leads)
      AND (multiSearchAny(normalized_payload, ${USER_AGENT_NEEDLES}) OR multiSearchAny(raw_payload, ${USER_AGENT_NEEDLES}))
  )
  GROUP BY user_id
)
SELECT
  l.user_id AS customer_id,
  l.w_email AS email,
  l.w_first_touch_ms AS first_touch_ms,
  l.w_funnel AS funnel,
  l.w_campaign_path AS campaign_path,
  l.w_campaign_id AS campaign_id,
  if(l.w_trial_utm != '', l.w_trial_utm, l.w_first_utm) AS utm_source,
  l.w_country AS country,
  toUInt8(l.w_failed > 0) AS has_declines,
  l.w_decline_reason AS decline_reason,
  u.w_user_agent AS user_agent
FROM leads AS l
LEFT JOIN lead_ua AS u ON u.user_id = l.user_id
FORMAT JSONEachRow`;
}

/** One warehouse lead candidate (a Query A row, parsed). */
export interface WarehouseLeadCandidate {
  customer_id: string;
  email: string;
  /** First touch (ISO, UTC). */
  session_date: string | null;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  utm_source: string | null;
  country: string | null;
  user_agent: string | null;
  has_declines: boolean;
  decline_reason: string | null;
}

/** One stored FunnelFox profile lead (leads_profile_candidates.profile_leads[]).
 * The RPC no longer sends user_agent / origin (read per page, see
 * hydrateProfileDetails); they stay here for callers that have them. */
export interface ProfileLeadCandidate {
  profile_id: string;
  email: string;
  lead_date: string | null;
  funnel_id: string | null;
  campaign_path: string | null;
  campaign_id: string | null;
  utm_source: string | null;
  media_buyer: string | null;
  country: string | null;
  user_agent: string | null;
  origin: string | null;
}

/** One subscription-only lead (leads_profile_candidates.subscription_leads[]). */
export interface SubscriptionLeadCandidate {
  email: string;
  lead_date: string | null;
  funnel: string | null;
  /** The subscription's profile id, else its subscription id (computeLeads' customer_id). */
  customer_id?: string | null;
}

export interface LeadsCandidateKpis {
  emails_found: number;
  converted_excluded: number;
  active_subs_excluded: number;
}

export interface LeadsProfileCandidates {
  profile_leads: ProfileLeadCandidate[];
  /** Profile leads before the RPC's cap (>= profile_leads.length). */
  profile_leads_total: number;
  /** The cap cut the list: only the newest profile_leads.length are in the set. */
  profile_leads_truncated: boolean;
  subscription_leads: SubscriptionLeadCandidate[];
  kpis: LeadsCandidateKpis;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function b(value: unknown): boolean {
  return value === 1 || value === true || value === "1" || value === "true";
}

function textOrNull(value: unknown): string | null {
  const out = s(value).trim();
  return out || null;
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email || null;
}

/** Any parseable date → ISO (UTC, ms); null otherwise. */
function toIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  const ms = typeof value === "number" ? value : Date.parse(s(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function msOf(value: string | null): number {
  return value ? Date.parse(value) : Number.NaN;
}

function daysSince(value: string | null, now: number): number | null {
  const ms = msOf(value);
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return null;
  return Math.floor((now - ms) / DAY_MS);
}

/** A Query A JSONEachRow row → candidate. */
export function parseWarehouseLeadRow(raw: Record<string, unknown>): WarehouseLeadCandidate {
  const firstTouch = raw.first_touch_ms == null || raw.first_touch_ms === "" ? Number.NaN : Number(raw.first_touch_ms);
  return {
    customer_id: s(raw.customer_id),
    email: s(raw.email),
    session_date: Number.isFinite(firstTouch) ? new Date(firstTouch).toISOString() : null,
    funnel: s(raw.funnel),
    campaign_path: s(raw.campaign_path),
    campaign_id: s(raw.campaign_id),
    utm_source: textOrNull(raw.utm_source),
    country: textOrNull(raw.country),
    user_agent: textOrNull(raw.user_agent),
    has_declines: b(raw.has_declines),
    decline_reason: textOrNull(raw.decline_reason),
  };
}

export async function loadWarehouseLeadCandidates(clickhouse: ClickHouseClientLike, tenantKey: string): Promise<WarehouseLeadCandidate[]> {
  const rs = await clickhouse.query({
    query: buildWarehouseLeadsQuery(),
    query_params: { auth_user_id: tenantKey },
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as Array<Record<string, unknown>>;
  return (Array.isArray(rows) ? rows : []).filter(isRecord).map(parseWarehouseLeadRow);
}

// ---- B. Postgres lead candidates -----------------------------------------------------

function parseProfileLead(raw: unknown): ProfileLeadCandidate | null {
  if (!isRecord(raw)) return null;
  const email = s(raw.email);
  if (!normalizeEmail(email)) return null;
  return {
    profile_id: s(raw.profile_id),
    email,
    lead_date: toIso(raw.lead_date),
    funnel_id: textOrNull(raw.funnel_id),
    campaign_path: textOrNull(raw.campaign_path),
    campaign_id: textOrNull(raw.campaign_id),
    utm_source: textOrNull(raw.utm_source),
    media_buyer: textOrNull(raw.media_buyer),
    country: textOrNull(raw.country),
    user_agent: textOrNull(raw.user_agent),
    origin: textOrNull(raw.origin),
  };
}

function parseSubscriptionLead(raw: unknown): SubscriptionLeadCandidate | null {
  if (!isRecord(raw)) return null;
  const email = s(raw.email);
  if (!normalizeEmail(email)) return null;
  return { email, lead_date: toIso(raw.lead_date), funnel: textOrNull(raw.funnel), customer_id: textOrNull(raw.customer_id) };
}

/** The leads_profile_candidates jsonb (object or JSON text) → typed candidates. */
export function parseLeadsProfileCandidates(data: unknown): LeadsProfileCandidates {
  let value = data;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  const record = isRecord(value) ? value : {};
  const kpis = isRecord(record.kpis) ? record.kpis : {};
  const list = <T>(entries: unknown, parse: (raw: unknown) => T | null): T[] =>
    (Array.isArray(entries) ? entries : []).map(parse).filter((entry): entry is T => entry !== null);
  const profileLeads = list(record.profile_leads, parseProfileLead);
  return {
    profile_leads: profileLeads,
    profile_leads_total: Math.max(profileLeads.length, n(record.profile_leads_total)),
    profile_leads_truncated: b(record.profile_leads_truncated),
    subscription_leads: list(record.subscription_leads, parseSubscriptionLead),
    kpis: {
      emails_found: n(kpis.emails_found),
      converted_excluded: n(kpis.converted_excluded),
      active_subs_excluded: n(kpis.active_subs_excluded),
    },
  };
}

export async function loadLeadsProfileCandidates(
  pg: SupabaseLikeClient,
  tenantKey: string,
  profileLimit: number = LEADS_PROFILE_CANDIDATES_LIMIT,
): Promise<LeadsProfileCandidates> {
  if (typeof pg.rpc !== "function") throw new Error("Could not load FunnelFox lead candidates: rpc is not supported by this client.");
  const { data, error } = await pg.rpc("leads_profile_candidates", { p_data_key: tenantKey, p_profile_limit: profileLimit });
  if (error) throw new Error(`Could not load FunnelFox lead candidates: ${error.message}`);
  return parseLeadsProfileCandidates(data);
}

/** Profile ids per funnelfox_leads `.in()` read (one leads_list page is at most 200 rows). */
const PROFILE_DETAILS_BATCH = 200;

/**
 * user_agent / origin of the page's profile-backed rows (funnelfox_profile and
 * both), read from funnelfox_leads by (auth_user_id, profile_id) — the unique
 * key — so only the displayed rows pay for the two widest columns. Same rule as
 * the merge: origin is the profile's; the user agent is the profile's when it
 * has one, else the warehouse's stays. Best effort: a failed read leaves the two
 * columns as merged and answers false (a ScopeViolation is never swallowed).
 */
export async function hydrateProfileDetails(
  pg: SupabaseLikeClient,
  tenantKey: string,
  rows: LeadRow[],
  profileIdByKey: ReadonlyMap<string, string>,
): Promise<boolean> {
  const ids = [...new Set(rows.map((row) => profileIdByKey.get(row.key)).filter((id): id is string => Boolean(id)))];
  if (!ids.length) return true;
  const details = new Map<string, { user_agent: string | null; origin: string | null }>();
  try {
    for (let i = 0; i < ids.length; i += PROFILE_DETAILS_BATCH) {
      const { data, error } = await pg
        .from("funnelfox_leads")
        .select("profile_id,user_agent,origin")
        .eq("auth_user_id", tenantKey)
        .in("profile_id", ids.slice(i, i + PROFILE_DETAILS_BATCH));
      if (error) throw new Error(error.message);
      for (const raw of Array.isArray(data) ? data : []) {
        if (!isRecord(raw)) continue;
        details.set(s(raw.profile_id), { user_agent: textOrNull(raw.user_agent), origin: textOrNull(raw.origin) });
      }
    }
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    console.warn("leads: profile details unavailable", { rows: ids.length, error: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
    return false;
  }
  for (const row of rows) {
    const id = profileIdByKey.get(row.key);
    const found = id ? details.get(id) : undefined;
    if (!found) continue;
    row.origin = found.origin;
    row.user_agent = found.user_agent ?? row.user_agent;
  }
  return true;
}

// ---- merge (pure) ----------------------------------------------------------------------

/** The warehouse funnel classifier (palmerTransform detectFunnel) over the
 * profile's FunnelFox funnel id + campaign path, so profile-only rows share the
 * warehouse's funnel values. */
export function funnelFromProfile(...values: Array<string | null | undefined>): string {
  const haystack = values.filter(Boolean).join(" ").toLowerCase();
  if (haystack.includes("soulmate") || haystack.includes("soul_mate")) return "soulmate";
  if (haystack.includes("past_life") || haystack.includes("past-life") || haystack.includes("pastlife")) return "past_life";
  if (haystack.includes("starseed") || haystack.includes("star_seed")) return "starseed";
  return "unknown";
}

/** palmerTransform's normalizeCampaignPath (how the warehouse derives
 * campaign_path from ff_campaign_path / the landing URL), for profile values:
 * lower case, URL → its path, no query / fragment, runs of other characters →
 * "-", "unknown" when empty. Kept in lockstep with palmerTransform.ts. */
export function normalizeLeadCampaignPath(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "unknown";
  try {
    const parsed = value.startsWith("http://") || value.startsWith("https://") ? new URL(value).pathname : value;
    const cleaned = parsed
      .replace(/^https?:\/\/[^/]+/i, "")
      .split(/[?#]/)[0]
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return cleaned || "unknown";
  } catch {
    const cleaned = value.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned || "unknown";
  }
}

function profileMediaBuyer(candidate: ProfileLeadCandidate): string {
  const stored = candidate.media_buyer;
  if (stored && stored !== "Unknown" && (MEDIA_BUYER_VALUES as readonly string[]).includes(stored)) return stored;
  return mediaBuyerFromUtmSource(candidate.utm_source);
}

function earliestIso(a: string | null, b: string | null): string | null {
  const am = msOf(a);
  const bm = msOf(b);
  if (!Number.isFinite(am)) return Number.isFinite(bm) ? b : a;
  if (!Number.isFinite(bm)) return a;
  return bm < am ? b : a;
}

function warehouseRow(candidate: WarehouseLeadCandidate, email: string, now: number): LeadRow {
  const sessionDate = toIso(candidate.session_date);
  return {
    key: `w:${candidate.customer_id}`,
    email,
    lead_date: sessionDate,
    funnel: candidate.funnel || "unknown",
    campaign_path: candidate.campaign_path || "unknown",
    campaign_id: candidate.campaign_id || "",
    media_buyer: mediaBuyerFromUtmSource(candidate.utm_source),
    country: normalizeCountryCode(candidate.country),
    session_date: sessionDate,
    days_since_visit: daysSince(sessionDate, now),
    customer_id: candidate.customer_id,
    user_agent: candidate.user_agent,
    origin: null,
    source: "warehouse",
    has_declines: candidate.has_declines,
    decline_reason: candidate.decline_reason,
  };
}

function profileRow(candidate: ProfileLeadCandidate, email: string, now: number): LeadRow {
  return {
    key: `p:${candidate.profile_id || email}`,
    email,
    lead_date: candidate.lead_date,
    funnel: funnelFromProfile(candidate.funnel_id, candidate.campaign_path),
    campaign_path: normalizeLeadCampaignPath(candidate.campaign_path),
    campaign_id: candidate.campaign_id || "",
    media_buyer: profileMediaBuyer(candidate),
    country: normalizeCountryCode(candidate.country),
    session_date: candidate.lead_date,
    days_since_visit: daysSince(candidate.lead_date, now),
    customer_id: candidate.profile_id || email,
    user_agent: candidate.user_agent,
    origin: candidate.origin,
    source: "funnelfox_profile",
    has_declines: false,
    decline_reason: null,
  };
}

/** A warehouse lead whose email also has a FunnelFox profile (merge rule
 * "both"): lead_date = the earlier of the two; attribution stays the
 * warehouse's — the values the owner already sees and filters on (campaign
 * path = the normalized FunnelFox landing path, country = the transactions') — and
 * only a field the warehouse lacks ("unknown" / empty) is filled from the
 * profile (whose campaign path is the session's utm_campaign / URL, its country
 * the session geo: another vocabulary); declines stay the warehouse's; origin
 * and user agent are the profile's (the user agent falls back to the
 * warehouse's when the profile has none). The row keeps its warehouse identity
 * (key, customer_id, session_date). */
function enrichWithProfile(row: LeadRow, candidate: ProfileLeadCandidate, now: number): void {
  const profile = profileRow(candidate, row.email, now);
  row.source = "both";
  row.lead_date = earliestIso(row.lead_date, profile.lead_date);
  row.days_since_visit = daysSince(row.lead_date, now);
  if (row.funnel === "unknown" && profile.funnel !== "unknown") row.funnel = profile.funnel;
  if (row.campaign_path === "unknown" && profile.campaign_path !== "unknown") row.campaign_path = profile.campaign_path;
  if (!row.campaign_id && profile.campaign_id) row.campaign_id = profile.campaign_id;
  if (row.media_buyer === "Unknown" && profile.media_buyer !== "Unknown") row.media_buyer = profile.media_buyer;
  if (!row.country && profile.country) row.country = profile.country;
  row.origin = profile.origin;
  row.user_agent = profile.user_agent ?? row.user_agent;
}

function subscriptionRow(candidate: SubscriptionLeadCandidate, email: string, now: number): LeadRow {
  const leadDate = toIso(candidate.lead_date);
  const customerId = candidate.customer_id || email;
  return {
    key: `s:${email}`,
    email,
    lead_date: leadDate,
    funnel: candidate.funnel || "unknown",
    campaign_path: "unknown",
    campaign_id: "",
    media_buyer: "Unknown",
    country: null,
    session_date: leadDate,
    days_since_visit: daysSince(leadDate, now),
    customer_id: customerId,
    user_agent: null,
    origin: null,
    source: "funnelfox_subscription",
    has_declines: false,
    decline_reason: null,
  };
}

export interface MergeLeadsInput {
  warehouse: WarehouseLeadCandidate[];
  profiles?: ProfileLeadCandidate[];
  subscriptions?: SubscriptionLeadCandidate[];
  /** Emails with an active subscription; dropped from every source. */
  activeEmails?: Iterable<string> | ReadonlyMap<string, unknown>;
  /** Clock for days_since_visit. */
  now: number;
}

function emailSet(source: MergeLeadsInput["activeEmails"]): Set<string> {
  const out = new Set<string>();
  if (!source) return out;
  const keys = source instanceof Map ? source.keys() : (source as Iterable<string>);
  for (const value of keys) {
    const email = normalizeEmail(value);
    if (email) out.add(email);
  }
  return out;
}

/**
 * Merges the three candidate sources into the lead set (leads plan §3 merge rules):
 *   - every warehouse candidate is a row (source "warehouse") — for
 *     warehouse-only input this is computeLeads' row set, field for field;
 *   - a profile whose email matches warehouse rows enriches them ("both",
 *     see enrichWithProfile); any other profile is its own row
 *     ("funnelfox_profile"); duplicate profile emails keep the earliest;
 *   - a subscription-only candidate is added only when its email is not
 *     already present ("funnelfox_subscription");
 *   - an email with an active subscription is never a lead.
 * Row order is unspecified (the API sorts).
 */
export function mergeLeads(input: MergeLeadsInput): LeadRow[] {
  return mergeLeadsWithProfiles(input).rows;
}

/** mergeLeads plus, per row key, the FunnelFox profile id behind the row
 * (funnelfox_profile rows and the profile that enriched a "both" row) — what
 * hydrateProfileDetails reads the page's user_agent / origin by. */
export function mergeLeadsWithProfiles(input: MergeLeadsInput): { rows: LeadRow[]; profileIdByKey: Map<string, string> } {
  const now = input.now;
  const active = emailSet(input.activeEmails);
  const rows: LeadRow[] = [];
  const profileIdByKey = new Map<string, string>();
  const warehouseByEmail = new Map<string, LeadRow[]>();
  const seenCustomers = new Set<string>();

  for (const candidate of input.warehouse) {
    const email = normalizeEmail(candidate.email);
    if (!email || active.has(email) || seenCustomers.has(candidate.customer_id)) continue;
    seenCustomers.add(candidate.customer_id);
    const row = warehouseRow(candidate, email, now);
    rows.push(row);
    const list = warehouseByEmail.get(email);
    if (list) list.push(row);
    else warehouseByEmail.set(email, [row]);
  }

  // One profile per email: the earliest lead_date (undated last), then profile id.
  const profileByEmail = new Map<string, ProfileLeadCandidate>();
  for (const candidate of input.profiles ?? []) {
    const email = normalizeEmail(candidate.email);
    if (!email || active.has(email)) continue;
    const current = profileByEmail.get(email);
    if (!current) {
      profileByEmail.set(email, candidate);
      continue;
    }
    const cm = msOf(current.lead_date);
    const nm = msOf(candidate.lead_date);
    const earlier = Number.isFinite(nm) && (!Number.isFinite(cm) || nm < cm || (nm === cm && candidate.profile_id < current.profile_id));
    if (earlier) profileByEmail.set(email, candidate);
  }
  for (const [email, candidate] of profileByEmail) {
    const matches = warehouseByEmail.get(email);
    if (matches) {
      for (const row of matches) {
        enrichWithProfile(row, candidate, now);
        if (candidate.profile_id) profileIdByKey.set(row.key, candidate.profile_id);
      }
      continue;
    }
    const row = profileRow(candidate, email, now);
    rows.push(row);
    if (candidate.profile_id) profileIdByKey.set(row.key, candidate.profile_id);
  }

  const present = new Set(rows.map((row) => row.email));
  for (const candidate of input.subscriptions ?? []) {
    const email = normalizeEmail(candidate.email);
    if (!email || active.has(email) || present.has(email)) continue;
    present.add(email);
    rows.push(subscriptionRow(candidate, email, now));
  }
  return { rows, profileIdByKey };
}

// ---- filter / sort / paginate (pure) ---------------------------------------------------

function dateKey(value: string | null): string {
  return value ? value.slice(0, 10) : "";
}

export function filterLeadRows(rows: LeadRow[], filters: NormalizedLeadsFilters): LeadRow[] {
  const search = filters.search.toLowerCase();
  const inList = (list: string[], value: string) => list.length === 0 || list.includes(value);
  const wantsUnknownCountry = filters.country.includes(UNKNOWN_COUNTRY);
  const countryCodes = filters.country.filter((value) => value !== UNKNOWN_COUNTRY);
  return rows.filter((row) => {
    if (search && !row.email.toLowerCase().includes(search) && !row.customer_id.toLowerCase().includes(search)) return false;
    const key = dateKey(row.lead_date);
    if (filters.dateFrom && (!key || key < filters.dateFrom)) return false;
    if (filters.dateTo && (!key || key > filters.dateTo)) return false;
    if (!inList(filters.funnel, row.funnel)) return false;
    if (!inList(filters.campaignPath, row.campaign_path)) return false;
    if (!inList(filters.campaignId, row.campaign_id)) return false;
    if (!inList(filters.mediaBuyer, row.media_buyer)) return false;
    if (filters.country.length) {
      const matches = row.country ? countryCodes.includes(row.country) : wantsUnknownCountry;
      if (!matches) return false;
    }
    if (filters.source.length && !filters.source.includes(row.source)) return false;
    if (filters.hasDeclines === "has" && !row.has_declines) return false;
    if (filters.hasDeclines === "none" && row.has_declines) return false;
    return true;
  });
}

type SortValue = number | string | null;

function sortValue(row: LeadRow, key: LeadsSortKey): SortValue {
  switch (key) {
    case "lead_date":
    case "session_date": {
      const ms = msOf(row[key]);
      return Number.isFinite(ms) ? ms : null;
    }
    case "days_since_visit":
      return row.days_since_visit;
    case "has_declines":
      return row.has_declines ? 1 : 0;
    case "country":
      return row.country;
    case "decline_reason":
      return row.decline_reason;
    default:
      return row[key];
  }
}

function compareValues(a: SortValue, b: SortValue): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** Sorts a copy. Missing values (null) sort last in both directions; ties
 * break on the row key, so pages are stable. */
export function sortLeadRows(rows: LeadRow[], key: LeadsSortKey, dir: LeadsSortDirection): LeadRow[] {
  const sign = dir === "asc" ? 1 : -1;
  const keyed = rows.map((row) => ({ row, value: sortValue(row, key) }));
  keyed.sort((x, y) => {
    const xNull = x.value === null;
    const yNull = y.value === null;
    if (xNull !== yNull) return xNull ? 1 : -1;
    const cmp = xNull ? 0 : sign * compareValues(x.value, y.value);
    if (cmp !== 0) return cmp;
    return x.row.key < y.row.key ? -1 : x.row.key > y.row.key ? 1 : 0;
  });
  return keyed.map((entry) => entry.row);
}

export function paginateLeadRows(rows: LeadRow[], page: number, pageSize: number): { rows: LeadRow[]; pagination: { page: number; page_size: number; total_rows: number; total_pages: number } } {
  const totalRows = rows.length;
  const offset = (page - 1) * pageSize;
  return {
    rows: rows.slice(offset, offset + pageSize),
    pagination: { page, page_size: pageSize, total_rows: totalRows, total_pages: Math.max(1, Math.ceil(totalRows / pageSize)) },
  };
}

/** Filter options with counts over the merged (unfiltered) set; A→Z, the
 * Unknown country pinned last; empty campaign ids are not an option. */
export function leadsFilterOptions(rows: LeadRow[]): LeadsFilterOptions {
  const count = (pick: (row: LeadRow) => string | null): LeadsFilterOption[] => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const value = pick(row);
      if (!value) continue;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([value, total]) => ({ value, count: total }))
      .sort((x, y) => Number(x.value === UNKNOWN_COUNTRY) - Number(y.value === UNKNOWN_COUNTRY) || (x.value < y.value ? -1 : x.value > y.value ? 1 : 0));
  };
  const sourceCounts = count((row) => row.source);
  return {
    funnel: count((row) => row.funnel),
    campaign_path: count((row) => row.campaign_path),
    campaign_id: count((row) => row.campaign_id),
    media_buyer: count((row) => row.media_buyer),
    country: count((row) => row.country ?? UNKNOWN_COUNTRY),
    // Fixed source order (the merge precedence), not alphabetical.
    source: LEAD_SOURCES
      .map((source) => sourceCounts.find((entry) => entry.value === source))
      .filter((entry): entry is LeadsFilterOption => Boolean(entry)),
  };
}

/** KPIs: the merged set's counts plus the RPC's distinct-email counts. leads_today
 * / leads_last_7_days follow computeLeadSummary (UTC date; the last 7 × 24 h). */
export function leadsSummary(rows: LeadRow[], kpis: LeadsCandidateKpis, now: number): LeadsSummary {
  const todayKey = new Date(now).toISOString().slice(0, 10);
  const sevenDaysAgo = now - 7 * DAY_MS;
  let today = 0;
  let lastSeven = 0;
  for (const row of rows) {
    if (dateKey(row.lead_date) === todayKey) today += 1;
    const ms = msOf(row.lead_date);
    if (Number.isFinite(ms) && ms >= sevenDaysAgo && ms <= now) lastSeven += 1;
  }
  return {
    total_leads: rows.length,
    emails_found: kpis.emails_found,
    converted_excluded: kpis.converted_excluded,
    active_subs_excluded: kpis.active_subs_excluded,
    leads_today: today,
    leads_last_7_days: lastSeven,
  };
}

// ---- sync state (leads_overview) -------------------------------------------------------

/** String stats a client may see (stage names, timestamps, reason codes);
 * every other string — and every nested object (cursors live there) — is dropped. */
const SYNC_STATS_TEXT_KEYS: ReadonlySet<string> = new Set([
  "stage",
  "next_stage",
  "sync_stopped_reason",
  "rate_limited_until",
  "error_backoff_until",
  "checkpoint_at",
  "last_actor",
  "coverage_warning",
  "coverage_warning_message",
]);

export function sanitizeSyncStats(stats: unknown): LeadsSyncStats {
  const out: LeadsSyncStats = {};
  if (!isRecord(stats)) return out;
  for (const [key, value] of Object.entries(stats)) {
    if (value === null) out[key] = null;
    else if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number") {
      if (Number.isFinite(value)) out[key] = value;
    } else if (typeof value === "string" && SYNC_STATS_TEXT_KEYS.has(key)) out[key] = value.slice(0, 300);
  }
  return out;
}

/** The pg_cron schedule of funnelfox-leads-sync (migration 202610060011): an
 * advance tick every minute, a full refresh daily at 06:15 UTC. */
export const LEADS_SYNC_REFRESH_UTC = { hour: 6, minute: 15 };

function nextDailyRefresh(now: number): string {
  const date = new Date(now);
  const at = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), LEADS_SYNC_REFRESH_UTC.hour, LEADS_SYNC_REFRESH_UTC.minute);
  return new Date(at > now ? at : at + DAY_MS).toISOString();
}

function futureIso(value: unknown, now: number): string | null {
  const iso = toIso(value);
  return iso && Date.parse(iso) > now ? iso : null;
}

/** funnelfox_leads_sync_state row (or null) → the client-safe sync state. */
export function buildLeadsSyncState(row: Record<string, unknown> | null, now: number): LeadsSyncState {
  const stats = sanitizeSyncStats(row?.stats);
  const rateLimitedUntil = futureIso(stats.rate_limited_until, now);
  // The cron's backoff after FunnelFox errors (the advance tick skips until then).
  const errorBackoffUntil = futureIso(stats.error_backoff_until, now);
  const flagsComplete = Boolean(row && row.profiles_completed === true && row.sessions_completed === true && row.reconcile_completed === true);
  const complete = flagsComplete || stats.all_stages_completed === true;
  const nextMinute = new Date((Math.floor(now / MINUTE_MS) + 1) * MINUTE_MS).toISOString();
  return {
    status: textOrNull(row?.last_status),
    current_stage: textOrNull(row?.current_stage),
    last_full_sync_at: toIso(row?.last_full_sync_at),
    stats,
    rate_limited_until: rateLimitedUntil,
    next_tick_hint: rateLimitedUntil ?? errorBackoffUntil ?? (complete ? nextDailyRefresh(now) : nextMinute),
    running: futureIso(row?.lease_until, now) !== null,
  };
}

/** Best effort: a missing table / column or a read fault yields the empty state,
 * never a failed overview. */
export async function readLeadsSyncState(pg: SupabaseLikeClient, tenantKey: string, now: number): Promise<LeadsSyncState> {
  try {
    const { data, error } = await pg.from("funnelfox_leads_sync_state").select("*").eq("auth_user_id", tenantKey).maybeSingle();
    if (error) return buildLeadsSyncState(null, now);
    return buildLeadsSyncState(isRecord(data) ? data : null, now);
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    return buildLeadsSyncState(null, now);
  }
}

// ---- the merged set, memoized per workspace --------------------------------------------

export interface LeadsDataset {
  rows: LeadRow[];
  /** Row key → the FunnelFox profile id behind it (for the per-page user_agent / origin read). */
  profileIdByKey: Map<string, string>;
  kpis: LeadsCandidateKpis;
  counts: { warehouse: number; profile: number; both: number; subscription: number };
  /** The candidates RPC's profile-lead cap: the uncapped count and whether it cut the list. */
  profileCandidates: { total: number; loaded: number; truncated: boolean };
  /** Clock value when the load started. */
  computed_at: number;
}

export interface LeadsRunInput {
  /** ctx.tenantKey — the workspace data key. */
  tenantKey: string;
  /** The request's ScopedReader. */
  clickhouse: ClickHouseClientLike;
  /** The gate's service-role client. */
  pg: SupabaseLikeClient;
  /** The request body. */
  request: unknown;
  /** Injectable clock (tests). */
  clock?: () => number;
}

interface MemoEntry {
  startedAt: number;
  settled: boolean;
  /** Started by a refresh request (one that must see data newer than the request). */
  refresh: boolean;
  promise: Promise<LeadsDataset>;
}

const leadsMemo = new Map<string, MemoEntry>();

/** Test hook: forget every memoized lead set. */
export function resetLeadsMemo(): void {
  leadsMemo.clear();
}

export async function loadLeadsDataset(input: Pick<LeadsRunInput, "tenantKey" | "clickhouse" | "pg">, now: number): Promise<LeadsDataset> {
  const [warehouse, candidates, active] = await Promise.all([
    loadWarehouseLeadCandidates(input.clickhouse, input.tenantKey),
    loadLeadsProfileCandidates(input.pg, input.tenantKey),
    activeSubscriptionsByEmail(input.pg, input.tenantKey),
  ]);
  const { rows, profileIdByKey } = mergeLeadsWithProfiles({
    warehouse,
    profiles: candidates.profile_leads,
    subscriptions: candidates.subscription_leads,
    activeEmails: active,
    now,
  });
  const counts = { warehouse: 0, profile: 0, both: 0, subscription: 0 };
  for (const row of rows) {
    if (row.source === "warehouse") counts.warehouse += 1;
    else if (row.source === "funnelfox_profile") counts.profile += 1;
    else if (row.source === "both") counts.both += 1;
    else counts.subscription += 1;
  }
  const profileCandidates = {
    total: candidates.profile_leads_total,
    loaded: candidates.profile_leads.length,
    truncated: candidates.profile_leads_truncated,
  };
  if (profileCandidates.truncated) {
    console.warn("leads: profile lead cap reached — only the newest are merged; move profile leads to ClickHouse (leads plan §4 step 7)", {
      loaded: profileCandidates.loaded,
      total: profileCandidates.total,
    });
  }
  return { rows, profileIdByKey, kpis: candidates.kpis, counts, profileCandidates, computed_at: now };
}

/** The workspace's merged lead set: served from memory for LEADS_MEMO_TTL_MS
 * after its load started; concurrent requests share one in-flight load; a
 * failed load is never cached. A refresh request (sent right after a sync) must
 * see data newer than itself, so it never joins an in-flight load that a plain
 * request started (that load may predate the sync) — only one another refresh
 * request started (the list and the overview refresh together). */
async function leadsDataset(input: LeadsRunInput, refresh: boolean): Promise<{ dataset: LeadsDataset; memo: LeadsMemoState }> {
  const clock = input.clock ?? Date.now;
  const now = clock();
  const key = input.tenantKey;
  const existing = leadsMemo.get(key);
  if (existing && !existing.settled && (!refresh || existing.refresh)) return { dataset: await existing.promise, memo: "coalesced" };
  if (existing && existing.settled && !refresh && now - existing.startedAt < LEADS_MEMO_TTL_MS) return { dataset: await existing.promise, memo: "hit" };

  const entry: MemoEntry = { startedAt: now, settled: false, refresh, promise: Promise.resolve(null as unknown as LeadsDataset) };
  entry.promise = loadLeadsDataset(input, now).then(
    (dataset) => {
      entry.settled = true;
      return dataset;
    },
    (error) => {
      if (leadsMemo.get(key) === entry) leadsMemo.delete(key);
      throw error;
    },
  );
  leadsMemo.delete(key);
  leadsMemo.set(key, entry);
  while (leadsMemo.size > LEADS_MEMO_MAX_ENTRIES) {
    const oldest = leadsMemo.keys().next().value;
    if (oldest === undefined) break;
    leadsMemo.delete(oldest);
  }
  return { dataset: await entry.promise, memo: refresh && existing ? "refresh" : "miss" };
}

function diagnosticsFor(dataset: LeadsDataset, memo: LeadsMemoState, now: number): LeadsDiagnostics {
  return {
    warehouse_leads: dataset.counts.warehouse,
    profile_leads: dataset.counts.profile,
    both_leads: dataset.counts.both,
    subscription_leads: dataset.counts.subscription,
    memo,
    dataset_age_ms: Math.max(0, now - dataset.computed_at),
    profile_candidates_total: dataset.profileCandidates.total,
    profile_candidates_loaded: dataset.profileCandidates.loaded,
    profile_candidates_truncated: dataset.profileCandidates.truncated,
  };
}

// ---- entrypoints -----------------------------------------------------------------------

/** action=leads_list: one filtered, sorted page of the merged lead set (the
 * page's profile user_agent / origin read for those rows only). */
export async function runLeadsList(input: LeadsRunInput): Promise<LeadsListResponse> {
  const started = Date.now();
  const nreq = normalizeLeadsRequest(input.request);
  const { dataset, memo } = await leadsDataset(input, nreq.refresh);
  const now = (input.clock ?? Date.now)();
  const filtered = filterLeadRows(dataset.rows, nreq.filters);
  const sorted = sortLeadRows(filtered, nreq.sortKey, nreq.sortDir);
  const { rows, pagination } = paginateLeadRows(sorted, nreq.page, nreq.pageSize);
  // Copies: the memoized rows are shared by every request of the workspace.
  const pageRows = rows.map((row) => ({ ...row }));
  const detailsOk = await hydrateProfileDetails(input.pg, input.tenantKey, pageRows, dataset.profileIdByKey);
  const diagnostics = diagnosticsFor(dataset, memo, now);
  if (!detailsOk) diagnostics.profile_details_unavailable = true;
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date(now).toISOString(),
    query_duration_ms: Date.now() - started,
    rows: pageRows,
    pagination,
    diagnostics,
  };
}

/** action=leads_overview: KPIs, filter options with counts and the sanitized sync state. */
export async function runLeadsOverview(input: LeadsRunInput): Promise<LeadsOverviewResponse> {
  const started = Date.now();
  const nreq = normalizeLeadsRequest(input.request);
  const clock = input.clock ?? Date.now;
  const [{ dataset, memo }, syncState] = await Promise.all([
    leadsDataset(input, nreq.refresh),
    readLeadsSyncState(input.pg, input.tenantKey, clock()),
  ]);
  const now = clock();
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date(now).toISOString(),
    query_duration_ms: Date.now() - started,
    summary: leadsSummary(dataset.rows, dataset.kpis, now),
    filter_options: leadsFilterOptions(dataset.rows),
    sync_state: syncState,
    diagnostics: diagnosticsFor(dataset, memo, now),
  };
}
