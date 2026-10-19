import type { ClickHouseClientLike } from "./types.ts";

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
    row_version UInt64,
    cancellation_reason String DEFAULT '',
    started_at Nullable(DateTime64(3, 'UTC'))
)
ENGINE = ReplacingMergeTree(row_version)
ORDER BY (auth_user_id, subscription_id)
`;

// The table predates its first writer (factSubscriptionsSync.ts, 2026-10-18) and
// production holds a copy created by an earlier build, so every non-key column
// is (re)asserted — a missing one is added, an existing one is left alone — and
// new columns are appended at the tail like every other additive change.
const FACT_SUBSCRIPTIONS_TAIL_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["normalized_email", "String DEFAULT ''"],
  ["email", "String DEFAULT ''"],
  ["profile_id", "String DEFAULT ''"],
  ["psp_id", "String DEFAULT ''"],
  ["funnel", "String DEFAULT ''"],
  ["campaign_path", "String DEFAULT ''"],
  ["status", "String DEFAULT ''"],
  ["renews", "UInt8 DEFAULT 0"],
  ["cancelled_at", "Nullable(DateTime64(3, 'UTC'))"],
  ["period_ends_at", "Nullable(DateTime64(3, 'UTC'))"],
  ["product_name", "String DEFAULT ''"],
  ["product_id", "String DEFAULT ''"],
  ["price", "Decimal(20, 6) DEFAULT 0"],
  ["currency", "String DEFAULT ''"],
  ["synced_at", "DateTime64(3, 'UTC') DEFAULT now64(3)"],
  ["cancellation_reason", "String DEFAULT ''"],
  ["started_at", "Nullable(DateTime64(3, 'UTC'))"],
];
export const ALTER_FACT_SUBSCRIPTIONS_COLUMNS_SQL: readonly string[] = FACT_SUBSCRIPTIONS_TAIL_COLUMNS.map(
  ([name, type]) => `ALTER TABLE ${FACT_SUBSCRIPTIONS_TABLE} ADD COLUMN IF NOT EXISTS ${name} ${type}`,
);

export async function ensureFactSubscriptionsSchema(client: Pick<ClickHouseClientLike, "command">): Promise<void> {
  await client.command({ query: CREATE_FACT_SUBSCRIPTIONS_SQL });
  for (const query of ALTER_FACT_SUBSCRIPTIONS_COLUMNS_SQL) await client.command({ query });
}

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
  cancellation_reason: string;
  /** Subscription start (the trial purchase) — bounds the cancellation decline window. */
  started_at: string | null;
}

// Columns to read from Supabase public.funnelfox_subscriptions (durable source of
// truth). Raw payloads are never read whole — only the FunnelFox detail fields
// the columns lack: the cancel date and reason (the cancelled_at COLUMN is empty
// on production: the sync never filled it), the sandbox flag and the fallbacks
// normalizeSubscription (subscriptionTransform.ts) uses. created_at is the
// FunnelFox subscription start (= period_starts_at of the first period).
export const FUNNELFOX_SUBSCRIPTION_SYNC_SELECT =
  "auth_user_id,subscription_id,profile_id,psp_id,normalized_email,funnel,campaign_path,status,renews,cancelled_at,period_ends_at,product_name,product_id,price,currency,updated_at,created_at," +
  "detail_cancelled_at:raw_detail->>cancelled_at,detail_cancellation_reason:raw_detail->>cancellation_reason," +
  "detail_sandbox:raw_detail->>sandbox,detail_updated_at:raw_detail->>updated_at,detail_period_ends_at:raw_detail->>period_ends_at," +
  "detail_status:raw_detail->>status,detail_renews:raw_detail->>renews,detail_created_at:raw_detail->>created_at";

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
  created_at?: string | null;
  detail_cancelled_at?: string | null;
  detail_cancellation_reason?: string | null;
  detail_sandbox?: string | boolean | null;
  detail_updated_at?: string | null;
  detail_period_ends_at?: string | null;
  detail_status?: string | null;
  detail_renews?: string | boolean | null;
  detail_created_at?: string | null;
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

function flag(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

// Maps a Supabase funnelfox_subscriptions row -> ClickHouse fact row, with the
// same rules as normalizeSubscription (subscriptionTransform.ts): cancelled =
// status contains "cancel" OR renews = false; the cancel time is the FunnelFox
// cancelled_at, else updated_at for a cancelled subscription. Sandbox (test)
// subscriptions are skipped (null), like the active-subscription overlay. The
// raw email is never stored — joins use normalized_email. row_version is the
// sync run's version when given (a full refresh supersedes every older row),
// else the source updated_at epoch (ms).
export function normalizeSubscriptionForClickHouse(row: SupabaseSubscriptionSourceRow, runVersion?: number): FactSubscriptionRow | null {
  const authUserId = text(row.auth_user_id);
  const subscriptionId = text(row.subscription_id);
  if (!authUserId || !subscriptionId) return null;
  if (flag(row.detail_sandbox) === true) return null;
  const status = (text(row.status) || text(row.detail_status)).toLowerCase();
  const renews = flag(row.renews) ?? flag(row.detail_renews);
  const isCancelled = status.includes("cancel") || renews === false;
  const updatedAt = text(row.detail_updated_at) || text(row.updated_at);
  const cancelledAt = text(row.detail_cancelled_at) || text(row.cancelled_at) || (isCancelled ? updatedAt : "");
  const updatedMs = row.updated_at ? new Date(String(row.updated_at)).getTime() : Number.NaN;
  return {
    auth_user_id: authUserId,
    subscription_id: subscriptionId,
    normalized_email: text(row.normalized_email).toLowerCase(),
    email: "",
    profile_id: text(row.profile_id),
    psp_id: text(row.psp_id),
    funnel: text(row.funnel),
    campaign_path: text(row.campaign_path),
    status,
    renews: renews === true ? 1 : 0,
    cancelled_at: dateTimeOrNull(cancelledAt),
    period_ends_at: dateTimeOrNull(text(row.period_ends_at) || text(row.detail_period_ends_at)),
    product_name: text(row.product_name),
    product_id: text(row.product_id),
    price: Number(row.price ?? 0) || 0,
    currency: text(row.currency).toUpperCase(),
    row_version: runVersion != null ? String(runVersion) : Number.isFinite(updatedMs) ? String(updatedMs) : "0",
    cancellation_reason: text(row.detail_cancellation_reason),
    started_at: dateTimeOrNull(text(row.detail_created_at) || text(row.created_at)),
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
