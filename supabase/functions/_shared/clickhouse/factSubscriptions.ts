// ClickHouse fact table for FunnelFox subscriptions (Phase 4).
//
// Source of truth stays Supabase `public.funnelfox_subscriptions`; this table is a
// synchronized fact so Active Users / Active Subscriptions / cancelled metrics can
// be joined to transaction cohorts SERVER-SIDE (never loaded into the browser).
// Durable raw fields only — no raw_payload. Active/cancelled are computed at query
// time from an injected `now`, exactly mirroring `subscriptionTransform.ts`.

export const FACT_SUBSCRIPTIONS_TABLE = "fact_subscriptions";

export const CREATE_FACT_SUBSCRIPTIONS_SQL = `
CREATE TABLE IF NOT EXISTS ${FACT_SUBSCRIPTIONS_TABLE}
(
    auth_user_id String,
    subscription_id String,
    normalized_email String,
    email String,
    profile_id String,
    psp_id String,
    funnel String,
    campaign_path String,
    status String,
    renews UInt8,
    cancelled_at Nullable(DateTime64(3, 'UTC')),
    period_ends_at Nullable(DateTime64(3, 'UTC')),
    product_name String,
    product_id String,
    price Decimal(20, 6),
    currency String,
    synced_at DateTime64(3, 'UTC') DEFAULT now64(3),
    row_version UInt64
)
ENGINE = ReplacingMergeTree(row_version)
ORDER BY (auth_user_id, subscription_id)
`;

// INACTIVE_STATUS_TOKENS from subscriptionTransform.ts:4 — substring match.
export const SUBSCRIPTION_INACTIVE_TOKENS = ["expired", "unpaid", "failed", "cancel"] as const;

// isSubscriptionActiveNow (subscriptionTransform.ts:21-27), as a ClickHouse WHERE
// fragment. {now:DateTime64} is the one injected per-request timestamp. status
// match is case-insensitive substring, mirroring `status.includes(token)`.
export function activeSubscriptionWhereClause(): string {
  const notInactive = SUBSCRIPTION_INACTIVE_TOKENS
    .map((token) => `positionCaseInsensitive(status, '${token}') = 0`)
    .join(" AND ");
  return `
        renews = 1
        AND period_ends_at IS NOT NULL
        AND period_ends_at > {now:DateTime64(3, 'UTC')}
        AND ${notInactive}
  `;
}

// is_cancelled (subscriptionTransform.ts:271-272): status contains "cancel" OR renews=false.
export function cancelledSubscriptionExpr(): string {
  return `(positionCaseInsensitive(status, 'cancel') > 0 OR renews = 0)`;
}

export interface FactSubscriptionRow {
  auth_user_id: string;
  subscription_id: string;
  normalized_email: string;
  email: string;
  profile_id: string;
  psp_id: string;
  funnel: string;
  campaign_path: string;
  status: string;
  renews: 0 | 1;
  cancelled_at: string | null;
  period_ends_at: string | null;
  product_name: string;
  product_id: string;
  price: number;
  currency: string;
  row_version: string;
}

// Columns to read from Supabase public.funnelfox_subscriptions (durable source of
// truth). Raw payloads (raw_list/raw_detail/raw_profile) are deliberately NOT read.
export const FUNNELFOX_SUBSCRIPTION_SYNC_SELECT =
  "auth_user_id,subscription_id,profile_id,psp_id,email,normalized_email,funnel,campaign_path,status,renews,cancelled_at,period_ends_at,product_name,product_id,price,currency,updated_at";

export interface SupabaseSubscriptionSourceRow {
  auth_user_id?: string | null;
  subscription_id?: string | null;
  profile_id?: string | null;
  psp_id?: string | null;
  email?: string | null;
  normalized_email?: string | null;
  funnel?: string | null;
  campaign_path?: string | null;
  status?: string | null;
  renews?: boolean | null;
  cancelled_at?: string | null;
  period_ends_at?: string | null;
  product_name?: string | null;
  product_id?: string | null;
  price?: number | string | null;
  currency?: string | null;
  updated_at?: string | null;
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function dateTimeOrNull(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().replace("Z", "");
}

// Maps a Supabase funnelfox_subscriptions row -> ClickHouse fact row. Preserves
// status / renews / period_ends_at / email identity / timestamps. row_version is
// the source updated_at epoch (ms) so newer syncs win under ReplacingMergeTree;
// upsert/dedup is by the ORDER BY (auth_user_id, subscription_id).
export function normalizeSubscriptionForClickHouse(row: SupabaseSubscriptionSourceRow): FactSubscriptionRow | null {
  const authUserId = text(row.auth_user_id);
  const subscriptionId = text(row.subscription_id);
  if (!authUserId || !subscriptionId) return null;
  const email = text(row.email);
  const updatedMs = row.updated_at ? new Date(String(row.updated_at)).getTime() : Number.NaN;
  return {
    auth_user_id: authUserId,
    subscription_id: subscriptionId,
    normalized_email: text(row.normalized_email) || email.toLowerCase(),
    email,
    profile_id: text(row.profile_id),
    psp_id: text(row.psp_id),
    funnel: text(row.funnel),
    campaign_path: text(row.campaign_path),
    status: text(row.status),
    renews: row.renews === true ? 1 : 0,
    cancelled_at: dateTimeOrNull(row.cancelled_at),
    period_ends_at: dateTimeOrNull(row.period_ends_at),
    product_name: text(row.product_name),
    product_id: text(row.product_id),
    price: Number(row.price ?? 0) || 0,
    currency: text(row.currency).toUpperCase(),
    row_version: Number.isFinite(updatedMs) ? String(updatedMs) : "0",
  };
}

export interface SubscriptionSyncParity {
  source_total: number;
  clickhouse_total: number;
  clickhouse_unique_ids: number;
  missing_in_clickhouse: number;
  extra_in_clickhouse: number;
  duplicate_ids: number;
  active_users: number;
  active_subscriptions: number;
  cancelled_users: number;
  cancelled_subscriptions: number;
  status_distribution: Record<string, number>;
  renews_distribution: Record<string, number>;
  period_ends_at_coverage: number;
  parity_status: "PASS" | "FAIL";
}
