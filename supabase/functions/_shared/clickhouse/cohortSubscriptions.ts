// Server-side active-subscription overlay for the Cohorts page.
//
// FunnelFox subscriptions live in Postgres (funnelfox_subscriptions), not in
// ClickHouse, so the cohort aggregate can't join them in SQL. Instead: pull the
// active subscriptions grouped by email (one RPC, jsonb), pull each cohort
// user's email from the ClickHouse snapshot, and count per cohort in JS. The
// "active now" definition lives in the RPC and matches isSubscriptionActiveNow
// (the definition the legacy client cohort compute uses), so the two agree.
import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { FACT_USER_COHORTS_TABLE } from "./schema.ts";

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

/** Active subscription ids grouped by normalized email (RLS-scoped to the caller). */
async function activeSubscriptionsByEmail(supabase: SupabaseLikeClient): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (!supabase.rpc) return map;
  const { data, error } = await supabase.rpc("active_funnelfox_subscription_emails");
  if (error) throw new Error(`Could not load active subscriptions: ${error.message}`);
  const obj = (data ?? {}) as Record<string, unknown>;
  for (const [email, ids] of Object.entries(obj)) {
    if (Array.isArray(ids)) map.set(email.trim().toLowerCase(), ids.map((value) => String(value)));
  }
  return map;
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
}): Promise<Map<string, CohortActiveSubs>> {
  const result = new Map<string, CohortActiveSubs>();
  const activeByEmail = await activeSubscriptionsByEmail(input.supabase);
  if (activeByEmail.size === 0) return result;

  const rs = await input.clickhouse.query({
    query: `SELECT lowerUTF8(trim(BOTH ' ' FROM normalized_email)) email,
        toString(cohort_date) cohort_date, funnel, campaign_path
      FROM ${FACT_USER_COHORTS_TABLE} FINAL
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
  const rows = (await rs.json()) as Array<{ email: string; cohort_date: string; funnel: string; campaign_path: string }>;

  const byCohort = new Map<string, { emails: Set<string>; subs: Set<string> }>();
  for (const row of rows) {
    const ids = activeByEmail.get(row.email);
    if (!ids || ids.length === 0) continue;
    const key = cohortKey(row.cohort_date, row.funnel, row.campaign_path);
    const bucket = byCohort.get(key) ?? { emails: new Set<string>(), subs: new Set<string>() };
    bucket.emails.add(row.email);
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
