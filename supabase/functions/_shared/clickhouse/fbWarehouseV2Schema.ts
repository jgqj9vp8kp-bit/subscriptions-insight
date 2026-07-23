// Facebook Warehouse V2 — Phase 0 schema (FB_WAREHOUSE_V2_DESIGN.md §1, roadmap rev.2).
// Channel-SPECIFIC raw + normalized daily facts unified by a cross-channel contract
// view — not one generic mega-table. Zero readers/writers touch these until later
// phases; deploying this is risk-free by design.
//
// Amendments over the design doc, both deliberate:
//  - every table carries auth_user_id and ORDER BY leads with it — the design DDL
//    was implicitly single-owner, but this warehouse is multi-tenant everywhere;
//  - v_fb_campaign_period is deferred: a pre-aggregated view cannot receive the
//    reader's date range before grouping, so period aggregation stays in reader SQL
//    over the *_current views.
//
// Facts are append-only MergeTree (NOT Replacing): versions are resolved by the
// *_current views — latest published batch per business key, via the small
// facebook_batch_registry mirror (kept in ClickHouse so views never need a
// federated query to Postgres). Derived ratios (cpp/cpc/cpm/ctr/roas) are NEVER
// stored — storing ratios next to sums breaks every re-aggregation.

import type { ClickHouseClientLike } from "./types.ts";

export const RAW_FACEBOOK_API_RESPONSES_TABLE = "raw_facebook_api_responses";
export const FACT_FB_ACCOUNT_DAILY_TABLE = "fact_facebook_account_daily";
export const FACT_FB_CAMPAIGN_DAILY_TABLE = "fact_facebook_campaign_daily";
export const FACT_FB_ADSET_DAILY_TABLE = "fact_facebook_adset_daily";
export const FACT_FB_AD_DAILY_TABLE = "fact_facebook_ad_daily";
export const DIM_FB_ACCOUNT_TABLE = "dim_facebook_account";
export const DIM_FB_CAMPAIGN_TABLE = "dim_facebook_campaign";
export const FB_BATCH_REGISTRY_TABLE = "facebook_batch_registry";
export const FB_DQ_RESULTS_TABLE = "facebook_dq_results";
export const FB_RECON_SNAPSHOTS_TABLE = "facebook_recon_snapshots";

/** Source metrics only — never derived ratios. Shared by all four fact grains. */
const FACT_METRIC_COLUMNS = `
  spend Decimal(18, 4),
  impressions UInt64,
  reach UInt64,
  clicks UInt64,
  link_clicks UInt64,
  outbound_clicks UInt64,
  fb_purchases UInt64,
  purchase_value Decimal(18, 4),
  currency LowCardinality(String)`;

/** Versioning/lineage columns shared by all four fact grains. */
const FACT_TECH_COLUMNS = `
  import_batch_id UUID,
  sync_run_id UUID,
  source_version String,
  row_hash UInt64,
  ingested_at DateTime64(3, 'UTC')`;

const CREATE_RAW_FACEBOOK_API_RESPONSES_SQL = `
CREATE TABLE IF NOT EXISTS ${RAW_FACEBOOK_API_RESPONSES_TABLE} (
  auth_user_id String,
  response_id UUID,
  sync_run_id UUID,
  request_seq UInt32,
  level LowCardinality(String),
  request_date Date,
  request_params String,
  http_status UInt16,
  response_body String CODEC(ZSTD(6)),
  row_count UInt32,
  received_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (auth_user_id, sync_run_id, request_seq)
`;
// No TTL on the raw layer on purpose: the absence of raw payloads is exactly what
// made the 2026-05-08..06-14 gap unrecoverable.

function createFactSql(table: string, keyColumns: string, orderBy: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${table} (
  auth_user_id String,
  stat_date Date,
${keyColumns},
${FACT_METRIC_COLUMNS},
${FACT_TECH_COLUMNS}
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(stat_date)
ORDER BY (auth_user_id, ${orderBy}, stat_date, import_batch_id)
`;
}

const CREATE_FACT_FB_ACCOUNT_DAILY_SQL = createFactSql(
  FACT_FB_ACCOUNT_DAILY_TABLE,
  "  ad_account_id String",
  "ad_account_id",
);
const CREATE_FACT_FB_CAMPAIGN_DAILY_SQL = createFactSql(
  FACT_FB_CAMPAIGN_DAILY_TABLE,
  "  ad_account_id String,\n  campaign_id String",
  "campaign_id",
);
const CREATE_FACT_FB_ADSET_DAILY_SQL = createFactSql(
  FACT_FB_ADSET_DAILY_TABLE,
  "  ad_account_id String,\n  campaign_id String,\n  adset_id String",
  "adset_id",
);
const CREATE_FACT_FB_AD_DAILY_SQL = createFactSql(
  FACT_FB_AD_DAILY_TABLE,
  "  ad_account_id String,\n  campaign_id String,\n  adset_id String,\n  ad_id String",
  "ad_id",
);

// Names/attributes live in dimensions, never on fact rows (names drift on rename).
const CREATE_DIM_FB_ACCOUNT_SQL = `
CREATE TABLE IF NOT EXISTS ${DIM_FB_ACCOUNT_TABLE} (
  auth_user_id String,
  ad_account_id String,
  account_name String,
  buyer LowCardinality(String),
  currency LowCardinality(String),
  timezone String,
  valid_from DateTime64(3, 'UTC'),
  valid_to Nullable(DateTime64(3, 'UTC')),
  is_current UInt8,
  import_batch_id UUID
)
ENGINE = ReplacingMergeTree
ORDER BY (auth_user_id, ad_account_id, valid_from)
`;

const CREATE_DIM_FB_CAMPAIGN_SQL = `
CREATE TABLE IF NOT EXISTS ${DIM_FB_CAMPAIGN_TABLE} (
  auth_user_id String,
  campaign_id String,
  ad_account_id String,
  campaign_name String,
  first_seen_date Date,
  last_seen_date Date,
  valid_from DateTime64(3, 'UTC'),
  valid_to Nullable(DateTime64(3, 'UTC')),
  is_current UInt8,
  import_batch_id UUID
)
ENGINE = ReplacingMergeTree
ORDER BY (auth_user_id, campaign_id, valid_from)
`;
// The design doc keeps a parsed funnel on dim_facebook_campaign; rev.2 moved funnel
// resolution into the dedicated campaign->funnel mapping layer (Postgres,
// facebook_campaign_funnel_map), so the dim intentionally has no funnel column.

// Small mirror of Postgres facebook_import_batches, so the *_current views can
// filter published batches without a federated query.
const CREATE_FB_BATCH_REGISTRY_SQL = `
CREATE TABLE IF NOT EXISTS ${FB_BATCH_REGISTRY_TABLE} (
  auth_user_id String,
  batch_id UUID,
  status LowCardinality(String),
  version String,
  published_seq UInt64,
  updated_at DateTime64(3, 'UTC')
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (auth_user_id, batch_id)
`;

const CREATE_FB_DQ_RESULTS_SQL = `
CREATE TABLE IF NOT EXISTS ${FB_DQ_RESULTS_TABLE} (
  auth_user_id String,
  dq_id UUID,
  batch_id UUID,
  sync_run_id UUID,
  check_name LowCardinality(String),
  status LowCardinality(String),
  details String,
  computed_at DateTime64(3, 'UTC')
)
ENGINE = MergeTree
ORDER BY (auth_user_id, batch_id, check_name)
`;

// The six rev.2 spend buckets are FIRST-CLASS columns. The partition identity
// source_spend = allocated_campaign + no_user + unknown_funnel + unknown_campaign
// always holds by construction; user_allocated_spend (Model 1) is reported
// BESIDE the partition and is never forced to match anything.
const CREATE_FB_RECON_SNAPSHOTS_SQL = `
CREATE TABLE IF NOT EXISTS ${FB_RECON_SNAPSHOTS_TABLE} (
  auth_user_id String,
  snapshot_id UUID,
  computed_at DateTime64(3, 'UTC'),
  window_from Date,
  window_to Date,
  source_spend Decimal(18, 4),
  funnel_resolved_spend Decimal(18, 4),
  user_allocated_spend Decimal(18, 4),
  allocated_campaign_spend Decimal(18, 4),
  no_user_spend Decimal(18, 4),
  unknown_funnel_spend Decimal(18, 4),
  unknown_campaign_spend Decimal(18, 4),
  allocation_basis LowCardinality(String),
  campaigns_total UInt32,
  campaigns_allocated UInt32,
  campaigns_no_user UInt32,
  campaigns_unknown_funnel UInt32,
  campaigns_unknown UInt32,
  suggested_share_pct Float64,
  coverage_pct Float64,
  known_gap_days UInt32,
  dq_warn_count UInt32,
  dq_fail_count UInt32,
  health LowCardinality(String),
  details String
)
ENGINE = MergeTree
ORDER BY (auth_user_id, computed_at)
`;

const PUBLISHED_BATCHES_SUBQUERY = `SELECT batch_id FROM ${FB_BATCH_REGISTRY_TABLE} FINAL WHERE status = 'published'`;

function createCurrentViewSql(view: string, table: string, keyColumns: string[]): string {
  const keys = ["auth_user_id", ...keyColumns, "stat_date"];
  const metricNames = ["spend", "impressions", "reach", "clicks", "link_clicks", "outbound_clicks", "fb_purchases", "purchase_value", "currency"];
  const metrics = metricNames.map((name) => `  argMax(${name}, ingested_at) AS ${name}`).join(",\n");
  // The published filter lives in an inner subquery: ClickHouse substitutes
  // SELECT aliases into WHERE, so filtering on import_batch_id at the outer
  // level would reference the argMax alias and fail with ILLEGAL_AGGREGATION
  // (caught live on 26.2).
  return `
CREATE VIEW IF NOT EXISTS ${view} AS
SELECT
${keys.map((key) => `  ${key}`).join(",\n")},
${metrics},
  argMax(import_batch_id, ingested_at) AS import_batch_id,
  argMax(source_version, ingested_at) AS source_version
FROM (
  SELECT * FROM ${table}
  WHERE import_batch_id IN (${PUBLISHED_BATCHES_SUBQUERY})
)
GROUP BY ${keys.join(", ")}
`;
}

export const V_FB_ACCOUNT_DAILY_CURRENT = "v_fb_account_daily_current";
export const V_FB_CAMPAIGN_DAILY_CURRENT = "v_fb_campaign_daily_current";
export const V_FB_ADSET_DAILY_CURRENT = "v_fb_adset_daily_current";
export const V_FB_AD_DAILY_CURRENT = "v_fb_ad_daily_current";
export const V_CHANNEL_CAMPAIGN_DAILY = "v_channel_campaign_daily";

// Cross-channel reporting contract seed (roadmap rev.2): every future channel
// (tiktok, google, ...) UNIONs its own *_current view here with its own
// traffic_channel literal. Funnel / media_buyer / utm_source_raw dimensions join
// in the resolution wave — the contract deliberately starts with the channel
// dimension plus source metrics only.
const CREATE_V_CHANNEL_CAMPAIGN_DAILY_SQL = `
CREATE VIEW IF NOT EXISTS ${V_CHANNEL_CAMPAIGN_DAILY} AS
SELECT
  'facebook' AS traffic_channel,
  auth_user_id,
  ad_account_id,
  campaign_id,
  stat_date,
  spend,
  impressions,
  reach,
  clicks,
  link_clicks,
  outbound_clicks,
  fb_purchases AS channel_purchases,
  purchase_value,
  currency,
  import_batch_id,
  source_version
FROM ${V_FB_CAMPAIGN_DAILY_CURRENT}
`;

export const V_FB_STATS_V2_CAMPAIGN_COMPAT = "v_fb_stats_v2_campaign_compat";
export const V_FB_STATS_V2_ACCOUNT_COMPAT = "v_fb_stats_v2_account_compat";

// Read-cutover compatibility views: expose the V1 row shape (level literal +
// names/buyer) over V2 current facts + SCD2 dims, so the existing read SQL can
// swap its FROM clause behind FB_WAREHOUSE_V2_READS without rewriting queries.
// adset/ad grains keep reading V1 until their dims exist.
const DIM_CAMPAIGN_CURRENT_SUBQUERY = `
  SELECT auth_user_id, campaign_id, argMax(campaign_name, valid_from) AS campaign_name
  FROM ${DIM_FB_CAMPAIGN_TABLE} FINAL
  WHERE is_current = 1
  GROUP BY auth_user_id, campaign_id`;

const DIM_ACCOUNT_CURRENT_SUBQUERY = `
  SELECT auth_user_id, ad_account_id,
    argMax(account_name, valid_from) AS account_name,
    argMax(buyer, valid_from) AS buyer
  FROM ${DIM_FB_ACCOUNT_TABLE} FINAL
  WHERE is_current = 1
  GROUP BY auth_user_id, ad_account_id`;

const CREATE_V_FB_STATS_V2_CAMPAIGN_COMPAT_SQL = `
CREATE VIEW IF NOT EXISTS ${V_FB_STATS_V2_CAMPAIGN_COMPAT} AS
SELECT
  f.auth_user_id AS auth_user_id,
  'campaign' AS level,
  f.stat_date AS stat_date,
  f.ad_account_id AS ad_account_id,
  a.account_name AS ad_account_name,
  a.buyer AS buyer,
  f.campaign_id AS campaign_id,
  c.campaign_name AS campaign_name,
  '' AS adset_id,
  '' AS adset_name,
  '' AS ad_id,
  '' AS ad_name,
  f.spend AS spend,
  f.impressions AS impressions,
  f.reach AS reach,
  f.clicks AS clicks,
  f.link_clicks AS link_clicks,
  f.outbound_clicks AS outbound_clicks,
  f.fb_purchases AS fb_purchases,
  f.purchase_value AS purchase_value,
  f.currency AS currency
FROM ${V_FB_CAMPAIGN_DAILY_CURRENT} AS f
LEFT JOIN (${DIM_CAMPAIGN_CURRENT_SUBQUERY}) AS c
  ON c.auth_user_id = f.auth_user_id AND c.campaign_id = f.campaign_id
LEFT JOIN (${DIM_ACCOUNT_CURRENT_SUBQUERY}) AS a
  ON a.auth_user_id = f.auth_user_id AND a.ad_account_id = f.ad_account_id
`;

const CREATE_V_FB_STATS_V2_ACCOUNT_COMPAT_SQL = `
CREATE VIEW IF NOT EXISTS ${V_FB_STATS_V2_ACCOUNT_COMPAT} AS
SELECT
  f.auth_user_id AS auth_user_id,
  'account' AS level,
  f.stat_date AS stat_date,
  f.ad_account_id AS ad_account_id,
  a.account_name AS ad_account_name,
  a.buyer AS buyer,
  '' AS campaign_id,
  '' AS campaign_name,
  '' AS adset_id,
  '' AS adset_name,
  '' AS ad_id,
  '' AS ad_name,
  f.spend AS spend,
  f.impressions AS impressions,
  f.reach AS reach,
  f.clicks AS clicks,
  f.link_clicks AS link_clicks,
  f.outbound_clicks AS outbound_clicks,
  f.fb_purchases AS fb_purchases,
  f.purchase_value AS purchase_value,
  f.currency AS currency
FROM ${V_FB_ACCOUNT_DAILY_CURRENT} AS f
LEFT JOIN (${DIM_ACCOUNT_CURRENT_SUBQUERY}) AS a
  ON a.auth_user_id = f.auth_user_id AND a.ad_account_id = f.ad_account_id
`;

export const FB_WAREHOUSE_V2_DDL: readonly string[] = [
  CREATE_RAW_FACEBOOK_API_RESPONSES_SQL,
  CREATE_FACT_FB_ACCOUNT_DAILY_SQL,
  CREATE_FACT_FB_CAMPAIGN_DAILY_SQL,
  CREATE_FACT_FB_ADSET_DAILY_SQL,
  CREATE_FACT_FB_AD_DAILY_SQL,
  CREATE_DIM_FB_ACCOUNT_SQL,
  CREATE_DIM_FB_CAMPAIGN_SQL,
  CREATE_FB_BATCH_REGISTRY_SQL,
  CREATE_FB_DQ_RESULTS_SQL,
  CREATE_FB_RECON_SNAPSHOTS_SQL,
  createCurrentViewSql(V_FB_ACCOUNT_DAILY_CURRENT, FACT_FB_ACCOUNT_DAILY_TABLE, ["ad_account_id"]),
  createCurrentViewSql(V_FB_CAMPAIGN_DAILY_CURRENT, FACT_FB_CAMPAIGN_DAILY_TABLE, ["ad_account_id", "campaign_id"]),
  createCurrentViewSql(V_FB_ADSET_DAILY_CURRENT, FACT_FB_ADSET_DAILY_TABLE, ["ad_account_id", "campaign_id", "adset_id"]),
  createCurrentViewSql(V_FB_AD_DAILY_CURRENT, FACT_FB_AD_DAILY_TABLE, ["ad_account_id", "campaign_id", "adset_id", "ad_id"]),
  CREATE_V_CHANNEL_CAMPAIGN_DAILY_SQL,
  CREATE_V_FB_STATS_V2_CAMPAIGN_COMPAT_SQL,
  CREATE_V_FB_STATS_V2_ACCOUNT_COMPAT_SQL,
];

export async function ensureFbWarehouseV2Schema(client: ClickHouseClientLike): Promise<void> {
  for (const query of FB_WAREHOUSE_V2_DDL) {
    await client.command({ query });
  }
}
