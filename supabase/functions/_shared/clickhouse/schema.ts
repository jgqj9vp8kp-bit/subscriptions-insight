import type { ClickHouseClientLike, ClickHouseEnv } from "./types.ts";
import { ensureFbWarehouseV2Schema } from "./fbWarehouseV2Schema.ts";

export const ANALYTICS_TRANSACTIONS_TABLE = "analytics_transactions";
export const FACT_USER_COHORTS_TABLE = "fact_user_cohorts";
export const FACT_SUPPORT_REQUESTS_TABLE = "fact_support_requests";
export const FACT_FACEBOOK_STATS_TABLE = "fact_facebook_stats";

export const CREATE_ANALYTICS_TRANSACTIONS_SQL = `
CREATE TABLE IF NOT EXISTS ${ANALYTICS_TRANSACTIONS_TABLE}
(
    auth_user_id String,
    transaction_id String,
    user_id String,
    normalized_email String,
    event_time DateTime64(3, 'UTC'),
    transaction_date Date,
    cohort_date Date,
    funnel LowCardinality(String),
    campaign_path String,
    campaign_id String,
    utm_source String,
    media_buyer LowCardinality(String),
    country_code LowCardinality(String),
    card_type LowCardinality(String),
    status LowCardinality(String),
    transaction_type LowCardinality(String),
    payment_stage LowCardinality(String),
    subscription_level UInt16,
    currency LowCardinality(String),
    original_amount Decimal(20, 6),
    gross_amount_usd Decimal(20, 6),
    net_amount_usd Decimal(20, 6),
    refund_amount_usd Decimal(20, 6),
    is_success UInt8,
    is_failed UInt8,
    is_refund UInt8,
    is_chargeback UInt8,
    is_trial UInt8,
    is_first_subscription UInt8,
    is_renewal UInt8,
    is_upsell UInt8,
    is_token_purchase UInt8,
    upsell_ordinal UInt8,
    decline_reason LowCardinality(String),
    processor LowCardinality(String),
    product_id String,
    product_name String,
    billing_reason String,
    import_batch_id String,
    source LowCardinality(String),
    raw_payload String,
    normalized_payload String,
    source_created_at Nullable(DateTime64(3, 'UTC')),
    source_updated_at Nullable(DateTime64(3, 'UTC')),
    clickhouse_synced_at DateTime64(3, 'UTC'),
    row_version UInt64,
    amount_usd Decimal(20, 6) DEFAULT 0,
    fx_status LowCardinality(String) DEFAULT '',
    classification_reason String DEFAULT '',
    platform LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(row_version)
PARTITION BY toYYYYMM(event_time)
ORDER BY
(
    auth_user_id,
    cohort_date,
    funnel,
    campaign_path,
    campaign_id,
    user_id,
    event_time,
    transaction_id
)
`;

export const CREATE_FACT_USER_COHORTS_SQL = `
CREATE TABLE IF NOT EXISTS ${FACT_USER_COHORTS_TABLE}
(
    auth_user_id String,
    canonical_user_id String,
    cohort_date Date,
    trial_event_time DateTime64(3, 'UTC'),
    trial_transaction_id String,
    normalized_email String,
    funnel LowCardinality(String),
    campaign_path String,
    campaign_id String,
    traffic_source LowCardinality(String),
    media_buyer LowCardinality(String),
    country LowCardinality(String),
    card_type LowCardinality(String),
    currency LowCardinality(String),
    price_plan String,
    trial_amount_usd Decimal(20, 6),
    source_updated_at DateTime64(3, 'UTC'),
    warehouse_version String,
    classification_version String,
    generated_at DateTime64(3, 'UTC'),
    row_version UInt64,
    platform LowCardinality(String) DEFAULT ''
)
ENGINE = ReplacingMergeTree(row_version)
PARTITION BY toYYYYMM(cohort_date)
ORDER BY
(
    auth_user_id,
    warehouse_version,
    classification_version,
    cohort_date,
    funnel,
    campaign_path,
    campaign_id,
    canonical_user_id
)
`;

// CREATE TABLE IF NOT EXISTS does not evolve an already-created production
// table. The platform dimension (Cohorts Platform filter, 2026-08-03) is
// appended at the tail — same discipline as amount_usd/fx_status above — so a
// bare ADD COLUMN lands existing tables in the same position as a fresh CREATE.
// The membership INSERT in cohortMembership.ts is positional and lists platform
// last for exactly this reason.
export const ALTER_PLATFORM_COLUMNS_SQL = [
  `ALTER TABLE ${ANALYTICS_TRANSACTIONS_TABLE} ADD COLUMN IF NOT EXISTS platform LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${FACT_USER_COHORTS_TABLE} ADD COLUMN IF NOT EXISTS platform LowCardinality(String) DEFAULT ''`,
];

// Sorting key note (load-bearing): it must contain ONLY stable identity
// columns. It used to include category/urgency, and ReplacingMergeTree collapses
// two rows only when their whole sorting key matches — so re-classifying an
// email (or a human correcting its category) produced a SECOND row instead of
// replacing the first, and the request was then counted once in each category.
// See rebuildFactSupportRequestsSortingKey below for the in-place repair.
const FACT_SUPPORT_REQUESTS_SORTING_KEY = "auth_user_id, request_date, request_id";

export const CREATE_FACT_SUPPORT_REQUESTS_SQL = `
CREATE TABLE IF NOT EXISTS ${FACT_SUPPORT_REQUESTS_TABLE}
(
    auth_user_id String,
    request_id String,
    import_batch_id String,
    source_row_number UInt32,
    received_at DateTime64(3, 'UTC'),
    request_date Date,
    received_date_raw String,
    customer_email String,
    normalized_email String,
    matched_customer UInt8,
    matched_user_id String,
    funnel LowCardinality(String) DEFAULT 'Unknown',
    campaign_path String,
    cohort_date Nullable(Date),
    attribution_status LowCardinality(String) DEFAULT 'unmatched_email',
    attribution_version String,
    sender String,
    matched_contact_name String,
    language LowCardinality(String),
    category LowCardinality(String),
    subcategory String,
    secondary_categories Array(LowCardinality(String)),
    automatic_category LowCardinality(String),
    automatic_subcategory String,
    manual_category String,
    manual_subcategory String,
    urgency LowCardinality(String),
    automatic_urgency LowCardinality(String),
    manual_urgency String,
    sentiment LowCardinality(String),
    requires_refund UInt8,
    requires_cancellation UInt8,
    payment_related UInt8,
    delivery_related UInt8,
    possible_unauthorized_charge UInt8,
    duplicate_charge UInt8,
    urgent UInt8,
    subject String,
    message_body String,
    source_hash String,
    classification_source LowCardinality(String) DEFAULT 'rule',
    classification_version String,
    classification_model LowCardinality(String),
    classification_confidence Float64,
    classification_reason String,
    imported_at DateTime64(3, 'UTC'),
    source_updated_at DateTime64(3, 'UTC'),
    clickhouse_synced_at DateTime64(3, 'UTC'),
    row_version UInt64
)
ENGINE = ReplacingMergeTree(row_version)
PARTITION BY toYYYYMM(request_date)
ORDER BY (${FACT_SUPPORT_REQUESTS_SORTING_KEY})
`;

// CREATE TABLE IF NOT EXISTS does not evolve an already-created production
// table. Keep attribution rollout additive so existing Support rows, raw fields,
// and manual classification overrides remain untouched.
export const ALTER_FACT_SUPPORT_REQUESTS_ATTRIBUTION_SQL = [
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS matched_user_id String AFTER matched_customer`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS funnel LowCardinality(String) DEFAULT 'Unknown' AFTER matched_user_id`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS campaign_path String AFTER funnel`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS cohort_date Nullable(Date) AFTER campaign_path`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS attribution_status LowCardinality(String) DEFAULT 'unmatched_email' AFTER cohort_date`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS attribution_version String AFTER attribution_status`,
];

// Classification v2 columns. Additive, same discipline as the attribution
// rollout above: existing rows and manual overrides stay untouched.
export const ALTER_FACT_SUPPORT_REQUESTS_CLASSIFICATION_SQL = [
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS secondary_categories Array(LowCardinality(String)) AFTER subcategory`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS classification_source LowCardinality(String) DEFAULT 'rule' AFTER source_hash`,
  `ALTER TABLE ${FACT_SUPPORT_REQUESTS_TABLE} ADD COLUMN IF NOT EXISTS classification_model LowCardinality(String) AFTER classification_version`,
];

const REBUILD_TABLE = `${FACT_SUPPORT_REQUESTS_TABLE}_rebuild`;

/** True when the live table still sorts by mutable classification columns. */
export function sortingKeyNeedsRebuild(sortingKey: string): boolean {
  const key = sortingKey.replace(/\s+/g, " ").toLowerCase();
  if (!key) return false;
  return /\bcategory\b/.test(key) || /\burgency\b/.test(key);
}

/** Repair the sorting key of an already-created table.
 *
 * ReplacingMergeTree deduplicates by the FULL sorting key, so while category and
 * urgency were part of it, changing an email's category inserted a second row
 * instead of replacing the first — the request then showed up in both the old
 * and the new category and every count above it was inflated. ALTER cannot
 * change a sorting key, so the table is rebuilt: copy the deduplicated rows
 * (FINAL) into a table keyed by identity only, then swap the two atomically.
 *
 * `CREATE TABLE ... AS <table>` clones the exact column list, which is what
 * makes the positional `SELECT *` copy safe here. */
export async function rebuildFactSupportRequestsSortingKey(client: ClickHouseClientLike): Promise<boolean> {
  const inspected = await client.query({
    query: `SELECT sorting_key FROM system.tables WHERE database = currentDatabase() AND name = '${FACT_SUPPORT_REQUESTS_TABLE}'`,
    format: "JSONEachRow",
  });
  const rows = (await inspected.json()) as Array<{ sorting_key?: string }>;
  const sortingKey = rows[0]?.sorting_key ?? "";
  if (!sortingKey || !sortingKeyNeedsRebuild(sortingKey)) return false;

  await client.command({ query: `DROP TABLE IF EXISTS ${REBUILD_TABLE}` });
  await client.command({
    query: `CREATE TABLE ${REBUILD_TABLE} AS ${FACT_SUPPORT_REQUESTS_TABLE}
      ENGINE = ReplacingMergeTree(row_version)
      PARTITION BY toYYYYMM(request_date)
      ORDER BY (${FACT_SUPPORT_REQUESTS_SORTING_KEY})`,
  });
  // FINAL collapses any duplicate-key rows the old key already produced, so the
  // rebuild also repairs history rather than carrying the double-counting over.
  await client.command({
    query: `INSERT INTO ${REBUILD_TABLE} SELECT * FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL`,
  });
  try {
    await client.command({ query: `EXCHANGE TABLES ${FACT_SUPPORT_REQUESTS_TABLE} AND ${REBUILD_TABLE}` });
  } catch {
    // EXCHANGE needs the Atomic database engine; fall back to a rename pair.
    await client.command({
      query: `RENAME TABLE ${FACT_SUPPORT_REQUESTS_TABLE} TO ${FACT_SUPPORT_REQUESTS_TABLE}_legacy, ${REBUILD_TABLE} TO ${FACT_SUPPORT_REQUESTS_TABLE}`,
    });
    await client.command({ query: `DROP TABLE IF EXISTS ${FACT_SUPPORT_REQUESTS_TABLE}_legacy` });
    return true;
  }
  await client.command({ query: `DROP TABLE IF EXISTS ${REBUILD_TABLE}` });
  return true;
}

// ---- analytics_transactions row_version migration --------------------------
//
// row_version used to be hash64(updated_at|event_time|transaction_id): unique,
// but randomly ORDERED — and ReplacingMergeTree keeps the largest version per
// key. A repaired transaction re-synced from Postgres therefore lost the merge
// to its own stale predecessor whenever the fresh hash came out smaller (~50%
// of rows; found while repairing the JPY minor-units defect, where the fix
// visibly did not take for half the rows). The mapper now emits updated_at
// millis (monotonic), and this rebuild moves already-written hash versions onto
// the same scale — hashes are uniform over ~[0, 1.8e19] while millis stay below
// ~2.5e14 until year 9999, so without the rebuild every new version would lose.

/** Any physical row_version above this is a legacy hash, never a timestamp. */
export const HASH_ROW_VERSION_THRESHOLD = 1_000_000_000_000_000; // 1e15

const TX_REBUILD_TABLE = `${ANALYTICS_TRANSACTIONS_TABLE}_rebuild`;
const TX_SORTING_KEY = "auth_user_id, cohort_date, funnel, campaign_path, campaign_id, user_id, event_time, transaction_id";

/** The copy that recomputes versions. Per sorting key the SOURCE's freshest row
 * wins by source_updated_at — deliberately NOT `FROM ... FINAL`, because FINAL
 * dedupes by the old hash versions and would keep exactly the stale rows this
 * rebuild exists to evict. */
export const TX_ROW_VERSION_REBUILD_SELECT = `
SELECT * REPLACE (toUInt64(toUnixTimestamp64Milli(ifNull(source_updated_at, clickhouse_synced_at))) AS row_version)
FROM (
  SELECT * EXCEPT (rn) FROM (
    SELECT *, row_number() OVER (
      PARTITION BY ${TX_SORTING_KEY}
      ORDER BY ifNull(source_updated_at, clickhouse_synced_at) DESC, row_version DESC
    ) rn
    FROM ${ANALYTICS_TRANSACTIONS_TABLE}
  ) WHERE rn = 1
)`.trim();

export async function rebuildAnalyticsTransactionsRowVersion(client: ClickHouseClientLike): Promise<boolean> {
  const inspected = await client.query({
    query: `SELECT max(row_version) AS max_version FROM ${ANALYTICS_TRANSACTIONS_TABLE}`,
    format: "JSONEachRow",
  });
  const rows = (await inspected.json()) as Array<{ max_version?: number | string }>;
  const maxVersion = Number(rows[0]?.max_version ?? 0);
  if (!Number.isFinite(maxVersion) || maxVersion <= HASH_ROW_VERSION_THRESHOLD) return false;

  await client.command({ query: `DROP TABLE IF EXISTS ${TX_REBUILD_TABLE}` });
  await client.command({ query: `CREATE TABLE ${TX_REBUILD_TABLE} AS ${ANALYTICS_TRANSACTIONS_TABLE}` });
  await client.command({ query: `INSERT INTO ${TX_REBUILD_TABLE} ${TX_ROW_VERSION_REBUILD_SELECT}` });
  try {
    await client.command({ query: `EXCHANGE TABLES ${ANALYTICS_TRANSACTIONS_TABLE} AND ${TX_REBUILD_TABLE}` });
  } catch {
    await client.command({
      query: `RENAME TABLE ${ANALYTICS_TRANSACTIONS_TABLE} TO ${ANALYTICS_TRANSACTIONS_TABLE}_legacy, ${TX_REBUILD_TABLE} TO ${ANALYTICS_TRANSACTIONS_TABLE}`,
    });
    await client.command({ query: `DROP TABLE IF EXISTS ${ANALYTICS_TRANSACTIONS_TABLE}_legacy` });
    return true;
  }
  await client.command({ query: `DROP TABLE IF EXISTS ${TX_REBUILD_TABLE}` });
  return true;
}

export async function ensureFactSupportRequestsSchema(client: ClickHouseClientLike): Promise<void> {
  await client.command({ query: CREATE_FACT_SUPPORT_REQUESTS_SQL });
  for (const query of [...ALTER_FACT_SUPPORT_REQUESTS_ATTRIBUTION_SQL, ...ALTER_FACT_SUPPORT_REQUESTS_CLASSIFICATION_SQL]) {
    await client.command({ query });
  }
  // Columns first: the rebuild clones the live structure, so it must run after
  // the ALTERs or the new columns would be dropped by the swap.
  await rebuildFactSupportRequestsSortingKey(client);
}

// Facebook ad performance warehouse, populated from the Capsuled fb-stats API by
// the clickhouse-facebook Edge Function. One logical row per
// (auth_user_id, level, stat_date, ad_account_id, campaign_id, adset_id, ad_id) —
// the row key proven unique against the live API. Metrics arrive daily and are
// restated retroactively (Meta attribution), so the engine is
// ReplacingMergeTree(row_version): each re-sync of a day replaces that day's rows.
//
// reach / frequency / link_clicks / purchase_value / roas / geo are declared for
// the contract's sake but the Capsuled v1 API does NOT return them — they stay
// NULL/0 until the API exposes them. raw_payload preserves every field verbatim.
export const CREATE_FACT_FACEBOOK_STATS_SQL = `
CREATE TABLE IF NOT EXISTS ${FACT_FACEBOOK_STATS_TABLE}
(
    auth_user_id String,
    stat_date Date,
    level LowCardinality(String),
    ad_account_id String,
    ad_account_name String,
    buyer LowCardinality(String),
    campaign_id String,
    campaign_name String,
    adset_id String,
    adset_name String,
    ad_id String,
    ad_name String,
    geo LowCardinality(String) DEFAULT '',
    currency LowCardinality(String),
    spend Float64,
    impressions UInt64,
    reach UInt64 DEFAULT 0,
    clicks UInt64,
    link_clicks UInt64 DEFAULT 0,
    outbound_clicks UInt64,
    fb_purchases UInt64,
    purchase_value Float64 DEFAULT 0,
    cpp Nullable(Float64),
    cpc Nullable(Float64),
    cpm Nullable(Float64),
    ctr Nullable(Float64),
    outbound_ctr Nullable(Float64),
    frequency Nullable(Float64),
    roas Nullable(Float64),
    raw_payload String,
    fb_stats_to Date,
    source_updated_at DateTime64(3, 'UTC'),
    clickhouse_synced_at DateTime64(3, 'UTC'),
    warehouse_version String,
    row_version UInt64
)
ENGINE = ReplacingMergeTree(row_version)
PARTITION BY toYYYYMM(stat_date)
ORDER BY
(
    auth_user_id,
    level,
    stat_date,
    ad_account_id,
    campaign_id,
    adset_id,
    ad_id
)
`;

export async function ensureFactFacebookStatsSchema(client: ClickHouseClientLike): Promise<void> {
  await client.command({ query: CREATE_FACT_FACEBOOK_STATS_SQL });
}

// Additive temp table for resumable validation ONLY. Source transaction ids are
// streamed here page-by-page during a validation run, then set-differenced against
// analytics_transactions server-side (SQL anti-joins) so the Edge Function never
// holds a full id Set in memory. Rows are scoped by validation_run and expire via
// TTL; this table never affects analytics_transactions or any analytics.
export const ANALYTICS_VALIDATION_SOURCE_IDS_TABLE = "analytics_validation_source_ids";

export const CREATE_VALIDATION_SOURCE_IDS_SQL = `
CREATE TABLE IF NOT EXISTS ${ANALYTICS_VALIDATION_SOURCE_IDS_TABLE}
(
    auth_user_id String,
    validation_run String,
    transaction_id String,
    user_id String,
    inserted_at DateTime64(3, 'UTC') DEFAULT now64(3)
)
ENGINE = ReplacingMergeTree
ORDER BY (auth_user_id, validation_run, transaction_id)
TTL toDateTime(inserted_at) + INTERVAL 2 DAY
`;

export interface ClickHouseInitResult {
  connected: boolean;
  database: string;
  table_created_or_exists: boolean;
  fact_user_cohorts_created_or_exists?: boolean;
  columns_count: number;
  engine: string;
  partition_key: string;
  order_key: string;
  current_row_count: number;
  fact_user_cohorts_row_count?: number;
  duration_ms: number;
}

type TableMetadataRow = {
  engine?: string;
  partition_key?: string;
  sorting_key?: string;
};

type CountRow = {
  count?: number | string;
  columns_count?: number | string;
};

async function jsonRows<T>(client: ClickHouseClientLike, query: string): Promise<T[]> {
  const resultSet = await client.query({ query, format: "JSONEachRow" });
  return (await resultSet.json()) as T[];
}

function quoteSql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function initializeClickHouseSchema(input: { client: ClickHouseClientLike; env: ClickHouseEnv }): Promise<ClickHouseInitResult> {
  const startedAt = Date.now();
  const client = input.client;

  await client.command({ query: CREATE_ANALYTICS_TRANSACTIONS_SQL });
  // One-time migration of legacy hash row_versions onto the monotonic
  // updated_at-millis scale; no-op once the table carries timestamp versions.
  await rebuildAnalyticsTransactionsRowVersion(client);
  await client.command({ query: CREATE_FACT_USER_COHORTS_SQL });
  for (const query of ALTER_PLATFORM_COLUMNS_SQL) {
    await client.command({ query });
  }
  await ensureFactSupportRequestsSchema(client);
  await ensureFactFacebookStatsSchema(client);
  // Warehouse V2 Phase 0: additive, idempotent, zero readers until later phases.
  await ensureFbWarehouseV2Schema(client);
  const database = input.env.database || "default";
  const table = ANALYTICS_TRANSACTIONS_TABLE;
  const [metadata] = await jsonRows<TableMetadataRow>(
    client,
    `
        SELECT engine, partition_key, sorting_key
        FROM system.tables
        WHERE database = ${quoteSql(database)}
          AND name = ${quoteSql(table)}
        LIMIT 1
      `,
  );
  const [columns] = await jsonRows<CountRow>(
    client,
    `
        SELECT count() AS columns_count
        FROM system.columns
        WHERE database = ${quoteSql(database)}
          AND table = ${quoteSql(table)}
      `,
  );
  const [rows] = await jsonRows<CountRow>(client, `SELECT count() AS count FROM ${table} FINAL`);
  const [cohortRows] = await jsonRows<CountRow>(client, `SELECT count() AS count FROM ${FACT_USER_COHORTS_TABLE} FINAL`);

  return {
    connected: true,
    database,
    table_created_or_exists: true,
    fact_user_cohorts_created_or_exists: true,
    columns_count: Number(columns?.columns_count ?? 0),
    engine: metadata?.engine ?? "unknown",
    partition_key: metadata?.partition_key ?? "",
    order_key: metadata?.sorting_key ?? "",
    current_row_count: Number(rows?.count ?? 0),
    fact_user_cohorts_row_count: Number(cohortRows?.count ?? 0),
    duration_ms: Date.now() - startedAt,
  };
}
