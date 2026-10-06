// Server-side active-subscription overlay for the Cohorts page.
//
// FunnelFox subscriptions live in Postgres (funnelfox_subscriptions), not in
// ClickHouse, so the cohort aggregate can't join them in SQL. Instead: pull the
// active subscriptions grouped by email (one RPC, jsonb), pull each cohort
// user's email from the ClickHouse snapshot, and count per cohort in JS. The
// "active now" definition lives in the RPC and matches isSubscriptionActiveNow
// (the definition the legacy client cohort compute uses), so the two agree.
//
// Tenant scope (Phase 0): the Edge caller is the SERVICE-ROLE client, which
// bypasses RLS, so the RPC must be told whose subscriptions to read — the
// p_data_key overload (202610050001_phase0_isolation_fixes.sql). The legacy
// no-arg form returned every account's subscriptions merged into one map.
//
// Funnel scope (access Phase 2): the cohort-email read takes the request's
// ScopeSql. A restricted member's overlay therefore joins only the emails of
// their scoped cohort users; the all-scope text is unchanged.
import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { ALL_SCOPE_SQL, cohortsFrom, type ScopeSql } from "./scopeSql.ts";

export interface CohortActiveSubs {
  active_users: number;
  active_subscriptions: number;
  // Identities behind the counts, so the client's total row can dedup across
  // cohorts (Cohorts.tsx unions active_subscription_ids / active_user_ids). The
  // materialized path has no per-user uid here, so the cohort user's normalized
  // email stands in as the active-user identity — distinct-count-equivalent.
  active_subscription_ids: string[];
  active_user_ids: string[];
}

const cohortKey = (cohortDate: string, funnel: string, campaignPath: string): string =>
  `${cohortDate}|${funnel}|${campaignPath}`;

/**
 * Active subscription ids grouped by normalized email, for ONE tenant: dataKey
 * is the workspace data key (ctx.tenantKey — the same value bound to
 * {auth_user_id:String}). The RPC already excludes FunnelFox sandbox/test
 * subscriptions, so the returned ids are live subscriptions only.
 */
export async function activeSubscriptionsByEmail(supabase: SupabaseLikeClient, dataKey: string): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!supabase.rpc) return map;
  const { data, error } = await supabase.rpc("active_funnelfox_subscription_emails", { p_data_key: dataKey });
  if (error) throw new Error(`Could not load active subscriptions: ${error.message}`);
  const obj = (data ?? {}) as Record<string, unknown>;
  for (const [email, ids] of Object.entries(obj)) {
    if (Array.isArray(ids)) map.set(email.trim().toLowerCase(), ids.map((value) => String(value)));
  }
  return map;
}

/** Cohort user with the email used to attribute active subscriptions. */
export interface CohortEmailRow {
  email: string;
  cohort_date: string;
  funnel: string;
  campaign_path: string;
}

/**
 * Fold active-subscription ids onto cohorts by joining each cohort user's email
 * to the active-by-email map. Shared by the materialized and dynamic paths so
 * both derive Active Users / Active Subscriptions identically.
 */
export function aggregateActiveSubscriptions(
  activeByEmail: Map<string, string[]>,
  rows: CohortEmailRow[],
): Map<string, CohortActiveSubs> {
  const result = new Map<string, CohortActiveSubs>();
  if (activeByEmail.size === 0) return result;
  const byCohort = new Map<string, { emails: Set<string>; subs: Set<string> }>();
  for (const row of rows) {
    const email = row.email?.trim().toLowerCase();
    if (!email) continue;
    const ids = activeByEmail.get(email);
    if (!ids || ids.length === 0) continue;
    const key = cohortKey(row.cohort_date, row.funnel, row.campaign_path);
    const bucket = byCohort.get(key) ?? { emails: new Set<string>(), subs: new Set<string>() };
    bucket.emails.add(email);
    for (const id of ids) bucket.subs.add(id);
    byCohort.set(key, bucket);
  }
  for (const [key, bucket] of byCohort) {
    result.set(key, {
      active_users: bucket.emails.size,
      active_subscriptions: bucket.subs.size,
      active_subscription_ids: [...bucket.subs],
      active_user_ids: [...bucket.emails],
    });
  }
  return result;
}

/**
 * Per-cohort active-subscription metrics keyed by `${cohort_date}|${funnel}|${campaign_path}`.
 * active_users  = distinct cohort users whose email has ≥1 active subscription.
 * active_subscriptions = distinct active subscription ids across those users.
 * Returns an empty map (no overlay) when there are no active subs — callers then
 * keep the rows' default 0.
 */
export async function activeSubscriptionMetricsByCohort(input: {
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  authUserId: string;
  warehouseVersion: string;
  classificationVersion: string;
  /** ALL_SCOPE_SQL unless the caller is funnel-restricted. */
  scope?: ScopeSql;
}): Promise<Map<string, CohortActiveSubs>> {
  const activeByEmail = await activeSubscriptionsByEmail(input.supabase, input.authUserId);
  if (activeByEmail.size === 0) return new Map();

  const rs = await input.clickhouse.query({
    query: `SELECT lowerUTF8(trim(BOTH ' ' FROM normalized_email)) email,
        toString(cohort_date) cohort_date, funnel, campaign_path
      FROM ${cohortsFrom(input.scope ?? ALL_SCOPE_SQL)}
      WHERE auth_user_id = {auth_user_id:String}
        AND warehouse_version = {warehouse_version:String}
        AND classification_version = {classification_version:String}
        AND normalized_email != ''
      FORMAT JSONEachRow`,
    query_params: {
      auth_user_id: input.authUserId,
      warehouse_version: input.warehouseVersion,
      classification_version: input.classificationVersion,
    },
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as CohortEmailRow[];
  return aggregateActiveSubscriptions(activeByEmail, rows);
}

/** Overlay the computed metrics onto cohort rows in place (by cohort key). */
export function mergeActiveSubscriptions(
  rows: Array<{
    cohort_date: string;
    funnel: string;
    campaign_path: string;
    active_users: number;
    active_subscriptions: number;
    active_subscription_ids?: string[];
    active_user_ids?: string[];
  }>,
  metrics: Map<string, CohortActiveSubs>,
): void {
  if (metrics.size === 0) return;
  for (const row of rows) {
    const metric = metrics.get(cohortKey(row.cohort_date, row.funnel, row.campaign_path));
    if (metric) {
      row.active_users = metric.active_users;
      row.active_subscriptions = metric.active_subscriptions;
      row.active_subscription_ids = metric.active_subscription_ids;
      row.active_user_ids = metric.active_user_ids;
    }
  }
}

// ---- Identity pseudonymization (responses for anyone but the data owner) ---
// active_user_ids are normalized customer EMAILS and active_subscription_ids are
// upstream FunnelFox ids. The browser only unions them (distinct counts for the
// total and funnel roll-up rows), so a caller without raw access gets keyed
// tokens instead: one identity always maps to the same token (unions and counts
// are unchanged), but a token can neither be reversed nor confirmed for a
// guessed email without the server key. The data owner keeps the raw values.

export type KeyedHasher = (value: string) => Promise<string>;

/** HMAC-SHA256(secret, `${label}|${value}`) as hex, memoized per hasher. The
 * label separates uses, so one secret never yields equal tokens across them. */
export async function createKeyedHasher(secret: string, label: string): Promise<KeyedHasher> {
  if (!secret) throw new Error("A keyed hasher needs a non-empty secret.");
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const memo = new Map<string, Promise<string>>();
  return (value: string) => {
    let digest = memo.get(value);
    if (!digest) {
      digest = crypto.subtle.sign("HMAC", key, encoder.encode(`${label}|${value}`))
        .then((bytes) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
      memo.set(value, digest);
    }
    return digest;
  };
}

/** Replaces active_user_ids / active_subscription_ids in place with keyed
 * tokens (`u_…` / `s_…`, 128-bit). Counts and every other field are untouched. */
export async function pseudonymizeActiveIdentities(
  rows: Array<{ active_user_ids?: string[]; active_subscription_ids?: string[] }>,
  hasher: KeyedHasher,
): Promise<void> {
  const tokens = (kind: "u" | "s", ids: string[]) =>
    Promise.all(ids.map(async (id) => `${kind}_${(await hasher(`${kind}|${id}`)).slice(0, 32)}`));
  for (const row of rows) {
    if (Array.isArray(row.active_user_ids)) row.active_user_ids = await tokens("u", row.active_user_ids);
    if (Array.isArray(row.active_subscription_ids)) row.active_subscription_ids = await tokens("s", row.active_subscription_ids);
  }
}
