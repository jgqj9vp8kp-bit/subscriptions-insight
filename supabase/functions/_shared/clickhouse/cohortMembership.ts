import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import {
  ANALYTICS_TRANSACTIONS_TABLE,
  CREATE_FACT_USER_COHORTS_SQL,
  FACT_USER_COHORTS_TABLE,
} from "./schema.ts";
import {
  aggregateSelect,
  classifierSQL,
  computeTotals,
  filtersApplied,
  fxDiagnostics,
  normalizeCohortRequest,
  subscriptionDataStatus,
  supportDataStatus,
  supportEmailsCTE,
  toAggregateRow,
  tokenDiagnosticsFromRows,
  type NormalizedCohortRequest,
  type RawCohortRow,
  type SupportDataProbe,
} from "./cohorts.ts";
import {
  filterOptionsFromRows,
  optionBranches,
  optionFiltersApplied,
  optionFlagColumns,
  optionsDiagnostics as buildOptionsDiagnostics,
  type FilterOptionsResult,
} from "./cohortFilterOptions.ts";
import { computeFbCohortStats, fbCohortRowKey } from "./fbCohortStats.ts";
import type {
  CohortFilters,
  CohortRequest,
  CohortResponse,
} from "./cohortContract.ts";

export const COHORT_SNAPSHOT_NAME = "fact_user_cohorts";
export const COHORT_CLASSIFICATION_VERSION = "cohort_classifier_v1_dynamic_sql";

export type CohortSnapshotStatus = "never_started" | "building" | "completed" | "failed";

export interface CohortSnapshotState {
  auth_user_id: string;
  snapshot_name: string;
  status: CohortSnapshotStatus;
  active_warehouse_version: string | null;
  active_classification_version: string | null;
  active_generated_at: string | null;
  building_warehouse_version: string | null;
  building_classification_version: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  users_classified: number;
  rows_inserted: number;
  duplicate_users: number;
  removed_or_invalidated: number;
  source_transactions: number | null;
  source_unique_users: number | null;
  last_error: string | null;
  diagnostics: Record<string, unknown>;
  updated_at?: string | null;
}

export interface CohortMembershipRebuildResult {
  status: "completed" | "failed";
  warehouse_version: string;
  classification_version: string;
  generated_at: string;
  users_classified: number;
  rows_inserted: number;
  inserted_users: number;
  updated_users: number;
  unchanged_users: number;
  removed_or_invalidated: number;
  duplicate_users: number;
  source_transactions: number;
  source_unique_users: number;
  duration_ms: number;
  state: CohortSnapshotState | null;
}

export interface CohortMembershipValidationResult {
  status: "PASS" | "FAIL";
  warehouse_version: string | null;
  classification_version: string | null;
  dynamic_users: number;
  materialized_users: number;
  missing_users: number;
  extra_users: number;
  duplicate_users: number;
  field_mismatches: Record<string, number>;
  duration_ms: number;
}

interface WarehouseFingerprint {
  warehouse_version: string;
  transaction_count: number;
  unique_users: number;
  max_row_version: string;
  max_source_updated_at: string;
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function validationPassed(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { status?: unknown }).status === "PASS");
}

export function isCompleteValidatedCohortSnapshot(state: CohortSnapshotState | null | undefined): state is CohortSnapshotState {
  return Boolean(
    state &&
      state.status === "completed" &&
      state.active_warehouse_version &&
      state.active_classification_version &&
      validationPassed(state.diagnostics?.validation),
  );
}

export function activeCohortSnapshotVersion(state: CohortSnapshotState | null | undefined): {
  warehouse_version: string;
  classification_version: string;
} | null {
  if (!isCompleteValidatedCohortSnapshot(state)) return null;
  return {
    warehouse_version: state.active_warehouse_version as string,
    classification_version: state.active_classification_version as string,
  };
}

async function jsonRows<T>(client: ClickHouseClientLike, query: string, query_params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await client.query({ query, query_params, format: "JSONEachRow" });
  return (await result.json()) as T[];
}

export async function ensureCohortMembershipSchema(client: ClickHouseClientLike): Promise<void> {
  await client.command({ query: CREATE_FACT_USER_COHORTS_SQL });
}

async function getWarehouseFingerprint(client: ClickHouseClientLike, authUserId: string): Promise<WarehouseFingerprint> {
  const [row] = await jsonRows<Record<string, unknown>>(
    client,
    `
      SELECT
        count() AS transaction_count,
        uniqExact(user_id) AS unique_users,
        toString(max(row_version)) AS max_row_version,
        toString(max(ifNull(source_updated_at, clickhouse_synced_at))) AS max_source_updated_at,
        lower(hex(cityHash64(
          toString(count()),
          toString(uniqExact(user_id)),
          toString(max(row_version)),
          toString(max(ifNull(source_updated_at, clickhouse_synced_at)))
        ))) AS warehouse_hash
      FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
      WHERE auth_user_id = {auth_user_id:String}
    `,
    { auth_user_id: authUserId },
  );
  const transactionCount = n(row?.transaction_count);
  const uniqueUsers = n(row?.unique_users);
  const hash = s(row?.warehouse_hash) || "empty";
  return {
    warehouse_version: `wh_${hash}`,
    transaction_count: transactionCount,
    unique_users: uniqueUsers,
    max_row_version: s(row?.max_row_version),
    max_source_updated_at: s(row?.max_source_updated_at),
  };
}

export async function getCohortSnapshotState(supabase: SupabaseLikeClient, authUserId: string): Promise<CohortSnapshotState | null> {
  const { data, error } = await supabase
    .from("clickhouse_cohort_snapshot_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("snapshot_name", COHORT_SNAPSHOT_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not load ClickHouse cohort snapshot state: ${error.message}`);
  return (data as CohortSnapshotState | null) ?? null;
}

async function upsertSnapshotState(
  supabase: SupabaseLikeClient,
  patch: Partial<CohortSnapshotState> & { auth_user_id: string },
): Promise<void> {
  const { error } = await supabase
    .from("clickhouse_cohort_snapshot_state")
    .upsert(
      {
        snapshot_name: COHORT_SNAPSHOT_NAME,
        ...patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "auth_user_id,snapshot_name" },
    );
  if (error) throw new Error(`Could not persist ClickHouse cohort snapshot state: ${error.message}`);
}

export function buildCohortMembershipInsertSql(): string {
  return `
INSERT INTO ${FACT_USER_COHORTS_TABLE}
WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")}
, membership AS (
  SELECT
    uid canonical_user_id,
    any(c_date) cohort_date,
    argMin(et, (ets, tprio, tid)) trial_event_time,
    argMin(tid, (ets, tprio, tid)) trial_transaction_id,
    any(u_normalized_email) normalized_email,
    any(c_funnel) funnel,
    any(c_camp) campaign_path,
    any(c_campaign_id) campaign_id,
    any(c_traffic_source) traffic_source,
    any(u_media_buyer) media_buyer,
    any(u_country) country,
    any(u_card_type) card_type,
    argMin(cur, (ets, tprio, tid)) currency,
    argMin(g, (ets, tprio, tid)) trial_amount_usd,
    max(u_source_updated_at) source_updated_at,
    countIf(is_success = 1 AND lt NOT IN ('upsell','token_purchase')) plan_candidates,
    argMinIf(round(g, 2), (ets, tprio, tid), is_success = 1 AND lt NOT IN ('upsell','token_purchase')) plan_price
  FROM fin
  GROUP BY uid
)
SELECT
  {auth_user_id:String} auth_user_id,
  canonical_user_id,
  toDate(cohort_date) cohort_date,
  trial_event_time,
  trial_transaction_id,
  normalized_email,
  funnel,
  campaign_path,
  campaign_id,
  traffic_source,
  media_buyer,
  country,
  card_type,
  currency,
  if(plan_candidates = 0, 'Unknown', concat('$', toString(plan_price))) price_plan,
  trial_amount_usd,
  source_updated_at,
  {warehouse_version:String} warehouse_version,
  {classification_version:String} classification_version,
  parseDateTime64BestEffort({generated_at:String}, 3, 'UTC') generated_at,
  toUInt64(toUnixTimestamp64Milli(parseDateTime64BestEffort({generated_at:String}, 3, 'UTC'))) row_version
FROM membership`;
}

async function countVersion(client: ClickHouseClientLike, authUserId: string, warehouseVersion: string, classificationVersion: string): Promise<number> {
  const [row] = await jsonRows<Record<string, unknown>>(
    client,
    `SELECT count() AS c FROM ${FACT_USER_COHORTS_TABLE} FINAL
     WHERE auth_user_id = {auth_user_id:String}
       AND warehouse_version = {warehouse_version:String}
       AND classification_version = {classification_version:String}`,
    { auth_user_id: authUserId, warehouse_version: warehouseVersion, classification_version: classificationVersion },
  );
  return n(row?.c);
}

async function countDuplicateUsers(client: ClickHouseClientLike, authUserId: string, warehouseVersion: string, classificationVersion: string): Promise<number> {
  const [row] = await jsonRows<Record<string, unknown>>(
    client,
    `SELECT count() - uniqExact(canonical_user_id) AS c FROM ${FACT_USER_COHORTS_TABLE} FINAL
     WHERE auth_user_id = {auth_user_id:String}
       AND warehouse_version = {warehouse_version:String}
       AND classification_version = {classification_version:String}`,
    { auth_user_id: authUserId, warehouse_version: warehouseVersion, classification_version: classificationVersion },
  );
  return n(row?.c);
}

async function compareVersions(input: {
  client: ClickHouseClientLike;
  authUserId: string;
  previousWarehouseVersion: string | null;
  previousClassificationVersion: string | null;
  warehouseVersion: string;
  classificationVersion: string;
}): Promise<{ inserted_users: number; updated_users: number; unchanged_users: number; removed_or_invalidated: number }> {
  if (!input.previousWarehouseVersion || !input.previousClassificationVersion) {
    const inserted = await countVersion(input.client, input.authUserId, input.warehouseVersion, input.classificationVersion);
    return { inserted_users: inserted, updated_users: 0, unchanged_users: 0, removed_or_invalidated: 0 };
  }
  const params = {
    auth_user_id: input.authUserId,
    old_wh: input.previousWarehouseVersion,
    old_cls: input.previousClassificationVersion,
    new_wh: input.warehouseVersion,
    new_cls: input.classificationVersion,
  };
  const [inserted, removed, joined] = await Promise.all([
    jsonRows<Record<string, unknown>>(
      input.client,
      `SELECT count() AS c FROM ${FACT_USER_COHORTS_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String}
         AND warehouse_version = {new_wh:String}
         AND classification_version = {new_cls:String}
         AND canonical_user_id NOT IN (
           SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL
           WHERE auth_user_id = {auth_user_id:String}
             AND warehouse_version = {old_wh:String}
             AND classification_version = {old_cls:String}
         )`,
      params,
    ),
    jsonRows<Record<string, unknown>>(
      input.client,
      `SELECT count() AS c FROM ${FACT_USER_COHORTS_TABLE} FINAL
       WHERE auth_user_id = {auth_user_id:String}
         AND warehouse_version = {old_wh:String}
         AND classification_version = {old_cls:String}
         AND canonical_user_id NOT IN (
           SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL
           WHERE auth_user_id = {auth_user_id:String}
             AND warehouse_version = {new_wh:String}
             AND classification_version = {new_cls:String}
         )`,
      params,
    ),
    jsonRows<Record<string, unknown>>(
      input.client,
      `SELECT
         count() AS common_users,
         countIf(
           old.cohort_date = neu.cohort_date
           AND old.trial_event_time = neu.trial_event_time
           AND old.trial_transaction_id = neu.trial_transaction_id
           AND old.funnel = neu.funnel
           AND old.campaign_path = neu.campaign_path
           AND old.campaign_id = neu.campaign_id
           AND old.traffic_source = neu.traffic_source
           AND old.media_buyer = neu.media_buyer
           AND old.country = neu.country
           AND old.card_type = neu.card_type
           AND old.currency = neu.currency
           AND old.price_plan = neu.price_plan
         ) AS unchanged_users
       FROM ${FACT_USER_COHORTS_TABLE} AS neu FINAL
       INNER JOIN ${FACT_USER_COHORTS_TABLE} AS old FINAL
         ON old.auth_user_id = neu.auth_user_id
        AND old.canonical_user_id = neu.canonical_user_id
       WHERE neu.auth_user_id = {auth_user_id:String}
         AND neu.warehouse_version = {new_wh:String}
         AND neu.classification_version = {new_cls:String}
         AND old.warehouse_version = {old_wh:String}
         AND old.classification_version = {old_cls:String}`,
      params,
    ),
  ]);
  const common = n(joined[0]?.common_users);
  const unchanged = n(joined[0]?.unchanged_users);
  return {
    inserted_users: n(inserted[0]?.c),
    updated_users: common - unchanged,
    unchanged_users: unchanged,
    removed_or_invalidated: n(removed[0]?.c),
  };
}

export async function rebuildCohortMembership(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  force?: boolean;
}): Promise<CohortMembershipRebuildResult> {
  const started = Date.now();
  await ensureCohortMembershipSchema(input.clickhouse);
  const previousState = await getCohortSnapshotState(input.supabase, input.authUserId).catch(() => null);
  const fingerprint = await getWarehouseFingerprint(input.clickhouse, input.authUserId);
  const classificationVersion = COHORT_CLASSIFICATION_VERSION;
  const generatedAt = new Date().toISOString();

  if (
    !input.force &&
    previousState?.status === "completed" &&
    previousState.active_warehouse_version === fingerprint.warehouse_version &&
    previousState.active_classification_version === classificationVersion &&
    validationPassed(previousState.diagnostics?.validation)
  ) {
    return {
      status: "completed",
      warehouse_version: fingerprint.warehouse_version,
      classification_version: classificationVersion,
      generated_at: previousState.active_generated_at ?? generatedAt,
      users_classified: previousState.users_classified,
      rows_inserted: 0,
      inserted_users: 0,
      updated_users: 0,
      unchanged_users: previousState.users_classified,
      removed_or_invalidated: 0,
      duplicate_users: previousState.duplicate_users,
      source_transactions: fingerprint.transaction_count,
      source_unique_users: fingerprint.unique_users,
      duration_ms: Date.now() - started,
      state: previousState,
    };
  }

  await upsertSnapshotState(input.supabase, {
    auth_user_id: input.authUserId,
    status: "building",
    building_warehouse_version: fingerprint.warehouse_version,
    building_classification_version: classificationVersion,
    started_at: generatedAt,
    finished_at: null,
    last_error: null,
    source_transactions: fingerprint.transaction_count,
    source_unique_users: fingerprint.unique_users,
    diagnostics: { warehouse: fingerprint },
  });

  let failedDiagnostics: Record<string, unknown> | null = null;
  try {
    await input.clickhouse.command({
      query: buildCohortMembershipInsertSql(),
      query_params: {
        auth_user_id: input.authUserId,
        warehouse_version: fingerprint.warehouse_version,
        classification_version: classificationVersion,
        generated_at: generatedAt,
      },
    });
    const rowsInserted = await countVersion(input.clickhouse, input.authUserId, fingerprint.warehouse_version, classificationVersion);
    const duplicateUsers = await countDuplicateUsers(input.clickhouse, input.authUserId, fingerprint.warehouse_version, classificationVersion);
    const versionDiff = await compareVersions({
      client: input.clickhouse,
      authUserId: input.authUserId,
      previousWarehouseVersion: previousState?.active_warehouse_version ?? null,
      previousClassificationVersion: previousState?.active_classification_version ?? null,
      warehouseVersion: fingerprint.warehouse_version,
      classificationVersion,
    });
    const validation = await validateCohortMembership({
      authUserId: input.authUserId,
      supabase: input.supabase,
      clickhouse: input.clickhouse,
      warehouseVersion: fingerprint.warehouse_version,
      classificationVersion,
    });
    if (validation.status !== "PASS") {
      failedDiagnostics = {
        warehouse: fingerprint,
        inserted_users: versionDiff.inserted_users,
        updated_users: versionDiff.updated_users,
        unchanged_users: versionDiff.unchanged_users,
        removed_or_invalidated: versionDiff.removed_or_invalidated,
        validation,
      };
      throw new Error("Cohort membership validation failed; active snapshot was not changed.");
    }
    const durationMs = Date.now() - started;
    const diagnostics = {
      warehouse: fingerprint,
      inserted_users: versionDiff.inserted_users,
      updated_users: versionDiff.updated_users,
      unchanged_users: versionDiff.unchanged_users,
      removed_or_invalidated: versionDiff.removed_or_invalidated,
      validation,
    };
    await upsertSnapshotState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "completed",
      active_warehouse_version: fingerprint.warehouse_version,
      active_classification_version: classificationVersion,
      active_generated_at: generatedAt,
      building_warehouse_version: null,
      building_classification_version: null,
      finished_at: new Date().toISOString(),
      duration_ms: durationMs,
      users_classified: rowsInserted,
      rows_inserted: rowsInserted,
      duplicate_users: duplicateUsers,
      removed_or_invalidated: versionDiff.removed_or_invalidated,
      source_transactions: fingerprint.transaction_count,
      source_unique_users: fingerprint.unique_users,
      diagnostics,
      last_error: null,
    });
    const nextState = await getCohortSnapshotState(input.supabase, input.authUserId).catch(() => null);
    return {
      status: "completed",
      warehouse_version: fingerprint.warehouse_version,
      classification_version: classificationVersion,
      generated_at: generatedAt,
      users_classified: rowsInserted,
      rows_inserted: rowsInserted,
      duplicate_users: duplicateUsers,
      source_transactions: fingerprint.transaction_count,
      source_unique_users: fingerprint.unique_users,
      duration_ms: durationMs,
      state: nextState,
      ...versionDiff,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown cohort membership rebuild error.";
    await upsertSnapshotState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "failed",
      building_warehouse_version: fingerprint.warehouse_version,
      building_classification_version: classificationVersion,
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      last_error: message,
      diagnostics: failedDiagnostics ? { ...failedDiagnostics, error: message } : { warehouse: fingerprint, error: message },
    }).catch(() => undefined);
    throw error;
  }
}

export function activeCohortMemberWhere(filters: CohortFilters, params: Record<string, unknown>): string {
  const clauses: string[] = [];
  const addIn = (column: string, values: string[], prefix: string) => {
    if (!values.length) return;
    const placeholders = values.map((value, index) => {
      const key = `p_${prefix}_${index}`;
      params[key] = value;
      return `{${key}:String}`;
    });
    clauses.push(`${column} IN (${placeholders.join(", ")})`);
  };
  addIn("fc.funnel", filters.funnel, "mfn");
  addIn("fc.campaign_path", filters.campaign_path, "mcp");
  addIn("fc.campaign_id", filters.campaign_id, "mcid");
  addIn("fc.traffic_source", filters.traffic_source, "mtsrc");
  addIn("fc.media_buyer", filters.media_buyer, "mmb");
  addIn("fc.country", filters.country, "mcountry");
  addIn("fc.card_type", filters.card_type, "mcard");
  addIn("fc.currency", filters.currency, "mcur");
  addIn("fc.price_plan", filters.price_plan, "mplan");
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

export function buildMaterializedCohortListQuery(request: CohortRequest, active: {
  warehouse_version: string;
  classification_version: string;
}, params: Record<string, unknown>, supportStatus: SupportDataProbe["support_data_status"] = "ready"): string {
  const nreq = normalizeCohortRequest(request);
  params.warehouse_version = active.warehouse_version;
  params.classification_version = active.classification_version;
  if (nreq.dateFrom) params.date_from = nreq.dateFrom;
  if (nreq.dateTo) params.date_to = nreq.dateTo;
  const memberWhere = activeCohortMemberWhere(nreq.filters, params);
  const post: string[] = [];
  if (nreq.dateFrom) post.push(`cohort_date >= {date_from:String}`);
  if (nreq.dateTo) post.push(`cohort_date <= {date_to:String}`);
  if (nreq.filters.refund_status === "has") post.push(`refund_raw > 0`);
  if (nreq.filters.refund_status === "none") post.push(`refund_raw = 0`);
  const postSql = post.length ? `HAVING ${post.join(" AND ")}` : "";

  return `WITH
${supportEmailsCTE(supportStatus)},
base AS (
  SELECT a.user_id uid, a.transaction_id tid, a.event_time et, toUnixTimestamp64Milli(a.event_time) ets,
    multiIf(a.transaction_type = 'trial', 0, a.transaction_type = 'upsell', 1, a.transaction_type = 'first_subscription', 2,
      a.transaction_type IN ('renewal_2','renewal_3','renewal'), 3, 4) tprio,
    a.status status, a.is_success is_success,
    positionCaseInsensitive(a.billing_reason, 'upsell') > 0 upmark,
    ((a.currency = 'USD' AND (abs(toFloat64(a.original_amount) - 4.99) < 0.005 OR abs(toFloat64(a.original_amount) - 9.99) < 0.005 OR abs(toFloat64(a.original_amount) - 24.99) < 0.005))
      OR (a.currency = 'EUR' AND abs(toFloat64(a.original_amount) - 4.99) < 0.005)
      OR (a.currency = 'COP' AND abs(toFloat64(a.original_amount) - 17199) < 0.005)) tokenAmt,
    abs(toFloat64(a.original_amount) - 14.98) < 0.01 commonUp,
    multiIf(a.status = 'failed', 'failed_payment', a.status = 'refunded', 'refund', a.status = 'chargeback', 'chargeback', '') statusType,
    a.gross_amount_usd g, floor(a.net_amount_usd * 100 + 0.5) / 100 nn, floor(a.refund_amount_usd * 100 + 0.5) / 100 rr,
    a.currency cur, toFloat64(a.original_amount) amt, a.product_id pid, a.product_name pname,
    toString(fc.cohort_date) c_date, fc.funnel c_funnel, fc.campaign_path c_camp,
    fc.normalized_email u_normalized_email,
    fc.trial_transaction_id trial_transaction_id,
    toUnixTimestamp64Milli(fc.trial_event_time) trial_ts
  FROM ${ANALYTICS_TRANSACTIONS_TABLE} AS a FINAL
  INNER JOIN ${FACT_USER_COHORTS_TABLE} AS fc FINAL
    ON fc.auth_user_id = a.auth_user_id
   AND fc.canonical_user_id = a.user_id
  WHERE a.auth_user_id = {auth_user_id:String}
    AND fc.auth_user_id = {auth_user_id:String}
    AND fc.warehouse_version = {warehouse_version:String}
    AND fc.classification_version = {classification_version:String}
    ${memberWhere}
    AND floor((toUnixTimestamp64Milli(a.event_time) - toUnixTimestamp64Milli(fc.trial_event_time)) / 86400000) >= 0
),
pretyped AS (
  SELECT *, floor((ets - trial_ts) / 86400000) d,
    multiIf(statusType != '', statusType, upmark, 'upsell', (NOT upmark) AND tokenAmt, 'token_purchase',
      tid = trial_transaction_id, 'trial',
      (statusType = '' AND NOT upmark AND NOT tokenAmt) AND (ets - trial_ts) <= 3600000 AND commonUp, 'upsell',
      (statusType = '' AND NOT upmark AND NOT tokenAmt) AND (ets - trial_ts) <= 172800000, 'token_purchase',
      (statusType = '' AND NOT upmark AND NOT tokenAmt), 'lifecycle', 'upsell') pretype
  FROM base
),
lifeidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) lvl FROM pretyped WHERE pretype = 'lifecycle' AND is_success = 1),
upsidx AS (SELECT uid, tid, row_number() OVER (PARTITION BY uid ORDER BY ets, tprio, tid) slot FROM pretyped WHERE pretype = 'upsell' AND is_success = 1),
fin AS (
  SELECT p.uid uid, p.tid tid, p.et et, p.ets ets, p.tprio tprio, p.trial_ts trial_ts,
    p.is_success is_success, p.g g, p.nn nn, p.rr rr, p.d d, p.statusType statusType, p.tokenAmt tokenAmt,
    p.cur cur, p.amt amt, p.pid pid, p.pname pname,
    p.c_date c_date, p.c_funnel c_funnel, p.c_camp c_camp,
    p.u_normalized_email u_normalized_email,
    ifNull(li.lvl, 0) lvl, ifNull(ui.slot, 0) slot,
    multiIf(p.pretype != 'lifecycle', p.pretype, li.lvl = 1, 'first_subscription', li.lvl = 2, 'renewal_2', li.lvl = 3, 'renewal_3', 'renewal') lt
  FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid) LEFT JOIN upsidx ui USING(uid, tid)
),
agg AS (${aggregateSelect()})
SELECT * FROM agg ${postSql}
FORMAT JSONEachRow`;
}

// ---- Cascading (dependent) filter options ---------------------------------
// The scoping rules, flag columns, branch SQL and row mapping are shared with the
// dynamic fallback — see cohortFilterOptions.ts. Here we only bind the snapshot's
// base WHERE (auth scope + active snapshot version + date range).

export function buildMaterializedFilterOptionsQuery(
  nreq: NormalizedCohortRequest,
  active: { warehouse_version: string; classification_version: string },
  params: Record<string, unknown>,
): string {
  params.warehouse_version = active.warehouse_version;
  params.classification_version = active.classification_version;
  const filters = nreq.filters;

  // Date range applies to EVERY dimension (it is not a dropdown of its own).
  // Compared as YYYY-MM-DD strings, exactly like the list query's cohort_date
  // post-filter, so option scope and result scope share one boundary rule.
  const dateConds: string[] = [];
  if (nreq.dateFrom) {
    params.o_date_from = nreq.dateFrom;
    dateConds.push(`toString(cohort_date) >= {o_date_from:String}`);
  }
  if (nreq.dateTo) {
    params.o_date_to = nreq.dateTo;
    dateConds.push(`toString(cohort_date) <= {o_date_to:String}`);
  }

  return `WITH members AS (
  SELECT canonical_user_id, funnel, campaign_path, campaign_id, traffic_source,
    media_buyer, country, card_type, currency, price_plan,
    ${optionFlagColumns(filters, params)}
  FROM ${FACT_USER_COHORTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}${dateConds.length ? `\n    AND ${dateConds.join(" AND ")}` : ""}
)
${optionBranches(filters)}
FORMAT JSONEachRow`;
}

function optionsDiagnostics(nreq: NormalizedCohortRequest, result: FilterOptionsResult, queryDurationMs: number) {
  return buildOptionsDiagnostics({
    filters: nreq.filters,
    dateFrom: nreq.dateFrom,
    dateTo: nreq.dateTo,
    result,
    queryDurationMs,
    source: "fact_user_cohorts",
  });
}

function materializedFiltersApplied(request: ReturnType<typeof normalizeCohortRequest>): CohortResponse["diagnostics"]["filters_applied"] {
  const applied = filtersApplied(request.filters, request.dateFrom, request.dateTo);
  return {
    ...applied,
    price_plan: request.filters.price_plan.length > 0,
  };
}

function snapshotDiagnostics(
  state: CohortSnapshotState,
  request: ReturnType<typeof normalizeCohortRequest>,
  subStatus: CohortResponse["diagnostics"]["subscription_data_status"],
  support?: SupportDataProbe,
  supportMatchedCohortUsers = 0,
  currentWarehouse?: WarehouseFingerprint | null,
): CohortResponse["diagnostics"] {
  // Freshness is a live comparison, never an assumption: the snapshot is
  // complete only when it was built on the warehouse version that exists NOW.
  // When the live fingerprint could not be read, freshness is honestly unknown
  // (snapshot_stale/report_complete absent) instead of claimed complete.
  const snapshotStale = currentWarehouse
    ? currentWarehouse.warehouse_version !== state.active_warehouse_version
    : undefined;
  return {
    transactions_scanned: state.source_transactions ?? 0,
    users_scanned: state.source_unique_users ?? 0,
    missing_identity: 0,
    missing_fx: 0,
    unknown_products: 0,
    subscription_data_status: subStatus,
    filters_applied: materializedFiltersApplied(request),
    active_snapshot_version: `${state.active_warehouse_version ?? ""}:${state.active_classification_version ?? ""}`,
    source_warehouse_version: state.active_warehouse_version,
    snapshot_generated_at: state.active_generated_at,
    snapshot_status: snapshotStale == null ? state.status : snapshotStale ? "stale" : "current",
    snapshot_complete: snapshotStale === false,
    source_transactions: state.source_transactions,
    cohort_users: state.users_classified,
    current_warehouse_version: currentWarehouse?.warehouse_version ?? null,
    current_warehouse_transactions: currentWarehouse?.transaction_count ?? null,
    snapshot_stale: snapshotStale,
    report_complete: snapshotStale == null ? undefined : !snapshotStale,
    support_data_status: support?.support_data_status ?? "unavailable",
    support_requests: support?.support_requests ?? 0,
    support_unique_emails: support?.support_unique_emails ?? 0,
    support_matched_cohort_users: supportMatchedCohortUsers,
  };
}

export async function runMaterializedCohortList(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: CohortRequest;
}): Promise<CohortResponse | null> {
  const state = await getCohortSnapshotState(input.supabase, input.authUserId).catch(() => null);
  const active = activeCohortSnapshotVersion(state);
  if (!state || !active) return null;

  const started = Date.now();
  const nreq = normalizeCohortRequest(input.request);
  const params: Record<string, unknown> = { auth_user_id: input.authUserId };
  const optionsParams: Record<string, unknown> = { auth_user_id: input.authUserId };
  const support = await supportDataStatus(input.clickhouse, input.authUserId);
  const optionsStarted = Date.now();
  const [rawRows, subStatus, optionRows, fx, currentWarehouse] = await Promise.all([
    jsonRows<RawCohortRow>(input.clickhouse, buildMaterializedCohortListQuery(input.request, active, params, support.support_data_status), params),
    subscriptionDataStatus(input.clickhouse, input.authUserId),
    // Options are scoped to the SAME active filters as the list (each dimension
    // minus its own predicate) — one extra scan of the snapshot, not 8 requests.
    jsonRows<Array<{ dim?: string; value?: string; cnt?: number | string }>[number]>(
      input.clickhouse,
      buildMaterializedFilterOptionsQuery(nreq, active, optionsParams),
      optionsParams,
    ).catch(() => []),
    fxDiagnostics(input.clickhouse, input.authUserId, nreq.filters.media_buyer).catch(() => undefined),
    // Live warehouse fingerprint from the SAME request, so snapshot freshness in
    // this response is a real comparison, never build-time metadata passed off
    // as current state.
    getWarehouseFingerprint(input.clickhouse, input.authUserId).catch(() => null),
  ]);
  const optionsDurationMs = Date.now() - optionsStarted;
  const rows = rawRows.map((row) => toAggregateRow(row));
  const totals = computeTotals(rows);
  const options = filterOptionsFromRows(optionRows, optionFiltersApplied(nreq.filters, nreq.dateFrom, nreq.dateTo));

  // FB Analytics join (campaign_id + cohort_date): computed AFTER the cohort
  // report so totals deduplicate campaign/day pairs over the rows that actually
  // survived post-filters. A failure here never degrades the cohort report —
  // FB fields are simply absent and the page renders "—".
  const visibleKeys = new Set(rows.map((r) => fbCohortRowKey(r.cohort_date, r.funnel, r.campaign_path)));
  const fbStats = await computeFbCohortStats({
    clickhouse: input.clickhouse,
    supabase: input.supabase,
    authUserId: input.authUserId,
    active,
    filters: nreq.filters,
    dateFrom: nreq.dateFrom,
    dateTo: nreq.dateTo,
    visibleKeys,
  }).catch(() => null);
  if (fbStats) {
    for (const row of rows) {
      const fb = fbStats.perRow[fbCohortRowKey(row.cohort_date, row.funnel, row.campaign_path)];
      if (fb) Object.assign(row, fb);
      else Object.assign(row, { fb_spend: 0, fb_purchases: 0, fb_impressions: 0, fb_reach: 0, fb_clicks: 0, fb_link_clicks: 0, fb_purchase_value: 0, fb_cpp: null, fb_cpc: null, fb_cpm: null, fb_ctr: null, fb_roas: null, fb_currency: null, fb_campaigns_matched: 0, fb_match_status: "missing_cohort_campaign_id" });
    }
  }

  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    rows,
    totals,
    filter_options: options.options,
    filter_options_diagnostics: optionsDiagnostics(nreq, options, optionsDurationMs),
    fx_diagnostics: fx,
    token_diagnostics: tokenDiagnosticsFromRows(rows),
    ...(fbStats ? { fb_totals: fbStats.totals, fb_diagnostics: fbStats.diagnostics } : {}),
    diagnostics: snapshotDiagnostics(state, nreq, subStatus, support, totals.support_users, currentWarehouse),
  };
}

export async function runMaterializedCohortOptions(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: CohortRequest;
}): Promise<CohortResponse | null> {
  const state = await getCohortSnapshotState(input.supabase, input.authUserId).catch(() => null);
  const active = activeCohortSnapshotVersion(state);
  if (!state || !active) return null;

  const started = Date.now();
  const nreq = normalizeCohortRequest(input.request);
  const params: Record<string, unknown> = { auth_user_id: input.authUserId };
  const [optionRows, subStatus, support, currentWarehouse] = await Promise.all([
    jsonRows<Array<{ dim?: string; value?: string; cnt?: number | string }>[number]>(
      input.clickhouse,
      buildMaterializedFilterOptionsQuery(nreq, active, params),
      params,
    ),
    subscriptionDataStatus(input.clickhouse, input.authUserId),
    supportDataStatus(input.clickhouse, input.authUserId),
    getWarehouseFingerprint(input.clickhouse, input.authUserId).catch(() => null),
  ]);
  const options = filterOptionsFromRows(optionRows, optionFiltersApplied(nreq.filters, nreq.dateFrom, nreq.dateTo));
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    rows: [],
    totals: {},
    filter_options: options.options,
    filter_options_diagnostics: optionsDiagnostics(nreq, options, Date.now() - started),
    diagnostics: snapshotDiagnostics(state, nreq, subStatus, support, 0, currentWarehouse),
  };
}

export async function validateCohortMembership(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  warehouseVersion?: string | null;
  classificationVersion?: string | null;
}): Promise<CohortMembershipValidationResult> {
  const started = Date.now();
  const state = input.warehouseVersion && input.classificationVersion
    ? null
    : await getCohortSnapshotState(input.supabase, input.authUserId);
  const warehouseVersion = input.warehouseVersion ?? state?.active_warehouse_version ?? null;
  const classificationVersion = input.classificationVersion ?? state?.active_classification_version ?? null;
  if (!warehouseVersion || !classificationVersion) {
    return {
      status: "FAIL",
      warehouse_version: warehouseVersion,
      classification_version: classificationVersion,
      dynamic_users: 0,
      materialized_users: 0,
      missing_users: 0,
      extra_users: 0,
      duplicate_users: 0,
      field_mismatches: {},
      duration_ms: Date.now() - started,
    };
  }
  const params = { auth_user_id: input.authUserId, warehouse_version: warehouseVersion, classification_version: classificationVersion };
  const [row] = await jsonRows<Record<string, unknown>>(
    input.clickhouse,
    `WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")}
, dynamic AS (
  SELECT
    uid canonical_user_id,
    any(c_date) cohort_date,
    argMin(et, (ets, tprio, tid)) trial_event_time,
    argMin(tid, (ets, tprio, tid)) trial_transaction_id,
    any(c_funnel) funnel,
    any(c_camp) campaign_path,
    any(c_campaign_id) campaign_id,
    any(c_traffic_source) traffic_source,
    any(u_media_buyer) media_buyer,
    any(u_country) country,
    any(u_card_type) card_type,
    argMin(cur, (ets, tprio, tid)) currency,
    if(
      countIf(is_success = 1 AND lt NOT IN ('upsell','token_purchase')) = 0,
      'Unknown',
      concat('$', toString(argMinIf(round(g, 2), (ets, tprio, tid), is_success = 1 AND lt NOT IN ('upsell','token_purchase'))))
    ) price_plan
  FROM fin GROUP BY uid
),
materialized AS (
  SELECT canonical_user_id, toString(cohort_date) cohort_date, trial_event_time, trial_transaction_id,
    funnel, campaign_path, campaign_id, traffic_source, media_buyer, country, card_type, currency, price_plan
  FROM ${FACT_USER_COHORTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
),
joined AS (
  SELECT d.*, m.canonical_user_id materialized_user_id,
    m.cohort_date m_cohort_date, m.trial_event_time m_trial_event_time, m.trial_transaction_id m_trial_transaction_id,
    m.funnel m_funnel, m.campaign_path m_campaign_path, m.campaign_id m_campaign_id, m.traffic_source m_traffic_source,
    m.media_buyer m_media_buyer, m.country m_country, m.card_type m_card_type, m.currency m_currency, m.price_plan m_price_plan
  FROM dynamic d LEFT JOIN materialized m USING(canonical_user_id)
)
SELECT
  (SELECT count() FROM dynamic) dynamic_users,
  (SELECT count() FROM materialized) materialized_users,
  (SELECT count() - uniqExact(canonical_user_id) FROM materialized) duplicate_users,
  countIf(materialized_user_id = '') missing_users,
  (SELECT count() FROM materialized WHERE canonical_user_id NOT IN (SELECT canonical_user_id FROM dynamic)) extra_users,
  countIf(toString(cohort_date) != m_cohort_date) cohort_date_mismatches,
  countIf(trial_event_time != m_trial_event_time) trial_event_time_mismatches,
  countIf(trial_transaction_id != m_trial_transaction_id) trial_transaction_id_mismatches,
  countIf(funnel != m_funnel) funnel_mismatches,
  countIf(campaign_path != m_campaign_path) campaign_path_mismatches,
  countIf(campaign_id != m_campaign_id) campaign_id_mismatches,
  countIf(traffic_source != m_traffic_source) traffic_source_mismatches,
  countIf(media_buyer != m_media_buyer) media_buyer_mismatches,
  countIf(country != m_country) country_mismatches,
  countIf(card_type != m_card_type) card_type_mismatches,
  countIf(currency != m_currency) currency_mismatches,
  countIf(price_plan != m_price_plan) price_plan_mismatches
FROM joined
FORMAT JSONEachRow`,
    params,
  );
  const field_mismatches = {
    cohort_date: n(row?.cohort_date_mismatches),
    trial_event_time: n(row?.trial_event_time_mismatches),
    trial_transaction_id: n(row?.trial_transaction_id_mismatches),
    funnel: n(row?.funnel_mismatches),
    campaign_path: n(row?.campaign_path_mismatches),
    campaign_id: n(row?.campaign_id_mismatches),
    traffic_source: n(row?.traffic_source_mismatches),
    media_buyer: n(row?.media_buyer_mismatches),
    country: n(row?.country_mismatches),
    card_type: n(row?.card_type_mismatches),
    currency: n(row?.currency_mismatches),
    price_plan: n(row?.price_plan_mismatches),
  };
  const bad =
    n(row?.dynamic_users) !== n(row?.materialized_users) ||
    n(row?.missing_users) > 0 ||
    n(row?.extra_users) > 0 ||
    n(row?.duplicate_users) > 0 ||
    Object.values(field_mismatches).some((count) => count > 0);
  return {
    status: bad ? "FAIL" : "PASS",
    warehouse_version: warehouseVersion,
    classification_version: classificationVersion,
    dynamic_users: n(row?.dynamic_users),
    materialized_users: n(row?.materialized_users),
    missing_users: n(row?.missing_users),
    extra_users: n(row?.extra_users),
    duplicate_users: n(row?.duplicate_users),
    field_mismatches,
    duration_ms: Date.now() - started,
  };
}
