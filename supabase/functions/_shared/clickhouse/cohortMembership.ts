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
  emailMatchedTokenPurchases,
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
  utmSourceOptionBranch,
  type FilterOptionsResult,
} from "./cohortFilterOptions.ts";
import { splitMediaBuyerSelections } from "./mediaBuyerSelection.ts";
import { computeFbCohortStats, fbCohortRowKey, unavailableFbCohortStats } from "./fbCohortStats.ts";
import type {
  CohortFilters,
  CohortRequest,
  CohortResponse,
} from "./cohortContract.ts";

export const COHORT_SNAPSHOT_NAME = "fact_user_cohorts";
// v2 makes the authoritative attribution columns explicit members of the
// per-user grain (no any(campaign_id) copy step). Bumping forces a validated
// snapshot rebuild on rollout instead of silently reusing the v1 materialization.
export const COHORT_CLASSIFICATION_VERSION = "cohort_classifier_v2_authoritative_attribution";

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
  build_token?: string | null;
  lease_expires_at?: string | null;
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
  if (!value || typeof value !== "object") return false;
  const validation = value as { status?: unknown; duplicate_users?: unknown; dynamic_users?: unknown; materialized_users?: unknown };
  if (validation.status !== "PASS") return false;
  if (validation.duplicate_users != null && n(validation.duplicate_users) !== 0) return false;
  if (validation.dynamic_users != null && validation.materialized_users != null
    && n(validation.dynamic_users) !== n(validation.materialized_users)) return false;
  return true;
}

export function isCompleteValidatedCohortSnapshot(state: CohortSnapshotState | null | undefined): state is CohortSnapshotState {
  return Boolean(
    state &&
      state.status === "completed" &&
      state.active_warehouse_version &&
      state.active_classification_version &&
      state.duplicate_users === 0 &&
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

async function snapshotBuildCas(
  supabase: SupabaseLikeClient,
  functionName:
    | "claim_clickhouse_cohort_snapshot_build"
    | "complete_clickhouse_cohort_snapshot_build"
    | "fail_clickhouse_cohort_snapshot_build",
  params: Record<string, unknown>,
): Promise<boolean> {
  if (!supabase.rpc) {
    throw new Error("Snapshot rebuild CAS functions are unavailable; apply the snapshot build CAS migration before rebuilding.");
  }
  const { data, error } = await supabase.rpc(functionName, params);
  if (error) throw new Error(`Could not update ClickHouse cohort snapshot lease: ${error.message}`);
  return data === true;
}

export function buildCohortMembershipInsertSql(): string {
  return `
INSERT INTO ${FACT_USER_COHORTS_TABLE}
WITH
${classifierSQL(`a.auth_user_id = {auth_user_id:String}`, "")}
, membership AS (
  SELECT
    uid canonical_user_id,
    c_date cohort_date,
    argMin(et, (ets, tprio, tid)) trial_event_time,
    argMin(tid, (ets, tprio, tid)) trial_transaction_id,
    u_normalized_email normalized_email,
    c_funnel funnel,
    c_camp campaign_path,
    c_campaign_id campaign_id,
    c_traffic_source traffic_source,
    u_media_buyer media_buyer,
    u_country country,
    u_card_type card_type,
    argMin(cur, (ets, tprio, tid)) currency,
    argMin(g, (ets, tprio, tid)) trial_amount_usd,
    max(u_source_updated_at) source_updated_at,
    countIf(is_success = 1 AND lt NOT IN ('upsell','token_purchase')) plan_candidates,
    argMinIf(round(g, 2), (ets, tprio, tid), is_success = 1 AND lt NOT IN ('upsell','token_purchase')) plan_price
  FROM fin
  GROUP BY uid, c_date, u_normalized_email, c_funnel, c_camp,
    c_campaign_id, c_traffic_source, u_media_buyer, u_country, u_card_type
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
  const buildToken = crypto.randomUUID();

  if (
    !input.force &&
    isCompleteValidatedCohortSnapshot(previousState) &&
    previousState.active_warehouse_version === fingerprint.warehouse_version &&
    previousState.active_classification_version === classificationVersion
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

  const claimed = await snapshotBuildCas(input.supabase, "claim_clickhouse_cohort_snapshot_build", {
    p_auth_user_id: input.authUserId,
    p_build_token: buildToken,
    p_warehouse_version: fingerprint.warehouse_version,
    p_classification_version: classificationVersion,
    p_started_at: generatedAt,
    p_lease_seconds: 300,
    p_source_transactions: fingerprint.transaction_count,
    p_source_unique_users: fingerprint.unique_users,
    p_diagnostics: { warehouse: fingerprint },
  });
  if (!claimed) {
    throw new Error("A cohort snapshot rebuild is already in progress for this account.");
  }

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
    const completed = await snapshotBuildCas(input.supabase, "complete_clickhouse_cohort_snapshot_build", {
      p_auth_user_id: input.authUserId,
      p_build_token: buildToken,
      p_warehouse_version: fingerprint.warehouse_version,
      p_classification_version: classificationVersion,
      p_generated_at: generatedAt,
      p_finished_at: new Date().toISOString(),
      p_duration_ms: durationMs,
      p_users_classified: rowsInserted,
      p_rows_inserted: rowsInserted,
      p_duplicate_users: duplicateUsers,
      p_removed_or_invalidated: versionDiff.removed_or_invalidated,
      p_source_transactions: fingerprint.transaction_count,
      p_source_unique_users: fingerprint.unique_users,
      p_diagnostics: diagnostics,
    });
    if (!completed) {
      throw new Error("Cohort snapshot rebuild was superseded; its result was not activated.");
    }
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
    await snapshotBuildCas(input.supabase, "fail_clickhouse_cohort_snapshot_build", {
      p_auth_user_id: input.authUserId,
      p_build_token: buildToken,
      p_finished_at: new Date().toISOString(),
      p_duration_ms: Date.now() - started,
      p_error: message,
      p_diagnostics: failedDiagnostics ? { ...failedDiagnostics, error: message } : { warehouse: fingerprint, error: message },
    }).catch(() => false);
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
  const bindList = (values: string[], prefix: string) => values.map((value, index) => {
    const key = `p_${prefix}_${index}`;
    params[key] = value;
    return `{${key}:String}`;
  });
  addIn("fc.funnel", filters.funnel, "mfn");
  addIn("fc.campaign_path", filters.campaign_path, "mcp");
  addIn("fc.campaign_id", filters.campaign_id, "mcid");
  addIn("fc.traffic_source", filters.traffic_source, "mtsrc");
  // Media Buyer dropdown: buyer names filter fc.media_buyer exactly as before;
  // "utm:<value>" selections additionally admit users whose authoritative
  // first-trial transaction carries that utm_source. Mixed selections are a
  // union — multi-select semantics of one dropdown.
  {
    const { buyers, utms } = splitMediaBuyerSelections(filters.media_buyer);
    const parts: string[] = [];
    if (buyers.length) parts.push(`fc.media_buyer IN (${bindList(buyers, "mmb").join(", ")})`);
    if (utms.length) {
      parts.push(
        `fc.trial_transaction_id IN (SELECT transaction_id FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL ` +
        `WHERE auth_user_id = {auth_user_id:String} AND utm_source IN (${bindList(utms, "mmbutm").join(", ")}))`,
      );
    }
    if (parts.length === 1) clauses.push(parts[0]);
    else if (parts.length > 1) clauses.push(`(${parts.join(" OR ")})`);
  }
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
-- TODO_MONETIZATION item 3 (signed off 2026-07-23): email-matched token rows,
-- mirrored from the dynamic engine's emailTokenSQL (cohorts.ts) onto the
-- snapshot. fcm = filter-passing members (email map source), fcall = ALL
-- snapshot members (exclusion set — a member's own rows are never re-attributed
-- by email, matching the client's cohortByUser.has() check even when filters
-- hide that member). etok re-keys non-member token transactions to the email's
-- member (earliest trial wins) with lvl = slot = 0, so lifecycle/upsell
-- sequences and the snapshot INSERT (which reads fin) are untouched.
fcall AS (
  SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
),
fcm AS (
  SELECT fc.canonical_user_id canonical_user_id, fc.cohort_date cohort_date,
    fc.trial_event_time trial_event_time, fc.funnel funnel, fc.campaign_path campaign_path,
    fc.normalized_email normalized_email
  FROM ${FACT_USER_COHORTS_TABLE} AS fc FINAL
  WHERE fc.auth_user_id = {auth_user_id:String}
    AND fc.warehouse_version = {warehouse_version:String}
    AND fc.classification_version = {classification_version:String}
    ${memberWhere}
),
cemail AS (
  SELECT normalized_email, argMin(cuid, (tts, cuid)) euid
  FROM (
    SELECT DISTINCT fcm.canonical_user_id cuid, a.normalized_email normalized_email,
      toUnixTimestamp64Milli(fcm.trial_event_time) tts
    FROM ${ANALYTICS_TRANSACTIONS_TABLE} AS a FINAL
    INNER JOIN fcm ON fcm.canonical_user_id = a.user_id
    WHERE a.auth_user_id = {auth_user_id:String} AND a.normalized_email != ''
  )
  GROUP BY normalized_email
),
etok AS (
  SELECT ce.euid uid, a.transaction_id tid, a.event_time et, toUnixTimestamp64Milli(a.event_time) ets,
    4 tprio, toUnixTimestamp64Milli(fcm.trial_event_time) trial_ts,
    a.is_success is_success, a.gross_amount_usd g,
    floor(a.net_amount_usd * 100 + 0.5) / 100 nn, floor(a.refund_amount_usd * 100 + 0.5) / 100 rr,
    floor((toUnixTimestamp64Milli(a.event_time) - toUnixTimestamp64Milli(fcm.trial_event_time)) / 86400000) d,
    multiIf(a.status = 'failed', 'failed_payment', a.status = 'refunded', 'refund', a.status = 'chargeback', 'chargeback', '') statusType,
    ((a.currency = 'USD' AND (abs(toFloat64(a.original_amount) - 4.99) < 0.005 OR abs(toFloat64(a.original_amount) - 9.99) < 0.005 OR abs(toFloat64(a.original_amount) - 24.99) < 0.005))
      OR (a.currency = 'EUR' AND abs(toFloat64(a.original_amount) - 4.99) < 0.005)
      OR (a.currency = 'COP' AND abs(toFloat64(a.original_amount) - 17199) < 0.005)) tokenAmt,
    a.currency cur, toFloat64(a.original_amount) amt, a.product_id pid, a.product_name pname,
    toString(fcm.cohort_date) c_date, fcm.funnel c_funnel, fcm.campaign_path c_camp,
    fcm.normalized_email u_normalized_email,
    0 lvl, 0 slot,
    multiIf(a.status = 'failed', 'failed_payment', a.status = 'refunded', 'refund', a.status = 'chargeback', 'chargeback', 'token_purchase') lt
  FROM ${ANALYTICS_TRANSACTIONS_TABLE} AS a FINAL
  INNER JOIN cemail ce ON ce.normalized_email = a.normalized_email
  INNER JOIN fcm ON fcm.canonical_user_id = ce.euid
  WHERE a.auth_user_id = {auth_user_id:String}
    AND a.user_id NOT IN (SELECT canonical_user_id FROM fcall)
    AND (a.transaction_type = 'token_purchase' OR (a.status IN ('refunded','chargeback') AND (
      (a.currency = 'USD' AND (abs(toFloat64(a.original_amount) - 4.99) < 0.005 OR abs(toFloat64(a.original_amount) - 9.99) < 0.005 OR abs(toFloat64(a.original_amount) - 24.99) < 0.005))
      OR (a.currency = 'EUR' AND abs(toFloat64(a.original_amount) - 4.99) < 0.005)
      OR (a.currency = 'COP' AND abs(toFloat64(a.original_amount) - 17199) < 0.005))))
    AND floor((toUnixTimestamp64Milli(a.event_time) - toUnixTimestamp64Milli(fcm.trial_event_time)) / 86400000) >= 0
),
finx AS (
  SELECT uid, tid, et, ets, tprio, trial_ts, is_success, g, nn, rr, d, statusType, tokenAmt,
    cur, amt, pid, pname, c_date, c_funnel, c_camp, u_normalized_email, lvl, slot, lt, 0 via_email
  FROM fin
  UNION ALL
  SELECT uid, tid, et, ets, tprio, trial_ts, is_success, g, nn, rr, d, statusType, tokenAmt,
    cur, amt, pid, pname, c_date, c_funnel, c_camp, u_normalized_email, lvl, slot, lt, 1 via_email
  FROM etok
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

  // The FINAL scans live in their own CTEs and are joined by CTE name — the
  // production ClickHouse build rejects FINAL modifiers inside a join list.
  // trial_utm is the authoritative first-trial utm_source (the utm_source of
  // the snapshot's trial_transaction_id row); it feeds the media_buyer pass
  // flag for "utm:<value>" selections and the extra utm_source option branch.
  return `WITH fcm AS (
  SELECT canonical_user_id, funnel, campaign_path, campaign_id, traffic_source,
    media_buyer, country, card_type, currency, price_plan, trial_transaction_id
  FROM ${FACT_USER_COHORTS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}${dateConds.length ? `\n    AND ${dateConds.join(" AND ")}` : ""}
),
tutm AS (
  SELECT transaction_id, utm_source
  FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String} AND utm_source != ''
),
members AS (
  SELECT fcm.canonical_user_id canonical_user_id, fcm.funnel funnel, fcm.campaign_path campaign_path,
    fcm.campaign_id campaign_id, fcm.traffic_source traffic_source, fcm.media_buyer media_buyer,
    fcm.country country, fcm.card_type card_type, fcm.currency currency, fcm.price_plan price_plan,
    ifNull(tutm.utm_source, '') trial_utm,
    ${optionFlagColumns(filters, params, "ifNull(tutm.utm_source, '')")}
  FROM fcm LEFT JOIN tutm ON tutm.transaction_id = fcm.trial_transaction_id
)
${optionBranches(filters)}
UNION ALL ${utmSourceOptionBranch(filters, params, "trial_utm")}
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
  allocationDiagnosticsEnabled?: boolean;
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

  // FB user-cost attribution is computed AFTER the cohort report so only users
  // belonging to rows that survived post-filters receive Campaign CPP. Campaign
  // Spend is never joined directly to a Cohorts row.
  const visibleKeys = new Set(rows.map((r) => fbCohortRowKey(r.cohort_date, r.funnel, r.campaign_path)));
  const visibleRows = rows.map((row) => ({
    cohort_date: row.cohort_date,
    funnel: row.funnel,
    campaign_path: row.campaign_path,
  }));
  const fbStats = await computeFbCohortStats({
    clickhouse: input.clickhouse,
    supabase: input.supabase,
    authUserId: input.authUserId,
    active,
    filters: nreq.filters,
    dateFrom: nreq.dateFrom,
    dateTo: nreq.dateTo,
    visibleKeys,
    visibleRows,
    allocationDiagnosticsEnabled: Boolean(input.allocationDiagnosticsEnabled),
    allocationDiagnosticsRequest: input.request.fb_allocation_diagnostics,
  }).catch((error) => {
    // The client only ever sees a sanitized message, which made a total FB
    // outage look like a transient warehouse hiccup — a ClickHouse
    // ILLEGAL_AGGREGATION went unnoticed until every Spend (FB) cell was
    // reported empty (2026-07-24). Keep the real cause in the function logs.
    console.error("[cohorts] FB allocation failed:", error instanceof Error ? error.message : error);
    return unavailableFbCohortStats(error, Boolean(input.allocationDiagnosticsEnabled));
  });
  for (const row of rows) {
    const fb = fbStats.perRow[fbCohortRowKey(row.cohort_date, row.funnel, row.campaign_path)];
    if (fb) Object.assign(row, fb);
    else Object.assign(row, { fb_spend: null, fb_purchases: null, fb_impressions: null, fb_reach: null, fb_clicks: null, fb_link_clicks: null, fb_purchase_value: null, fb_cpp: null, fb_cpc: null, fb_cpm: null, fb_ctr: null, fb_roas: null, fb_currency: null, fb_campaigns_matched: 0, fb_match_status: "missing_cohort_campaign_id", fb_reporting_date: null, fb_campaign_cpp: null, fb_user_cpp: null, fb_matched_users: 0, fb_unmatched_users: 0, fb_campaign_coverage: null, fb_cpp_source: "campaign_spend_div_fb_purchases", fb_timezone: null, coverage_rate: null });
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
    token_diagnostics: tokenDiagnosticsFromRows(rows, emailMatchedTokenPurchases(rawRows)),
    ...({
      fb_totals: fbStats.totals,
      fb_diagnostics: fbStats.diagnostics,
      ...(fbStats.allocationDiagnostics ? { fb_allocation_diagnostics: fbStats.allocationDiagnostics } : {}),
    }),
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
    c_date cohort_date,
    argMin(et, (ets, tprio, tid)) trial_event_time,
    argMin(tid, (ets, tprio, tid)) trial_transaction_id,
    c_funnel funnel,
    c_camp campaign_path,
    c_campaign_id campaign_id,
    c_traffic_source traffic_source,
    u_media_buyer media_buyer,
    u_country country,
    u_card_type card_type,
    argMin(cur, (ets, tprio, tid)) currency,
    if(
      countIf(is_success = 1 AND lt NOT IN ('upsell','token_purchase')) = 0,
      'Unknown',
      concat('$', toString(argMinIf(round(g, 2), (ets, tprio, tid), is_success = 1 AND lt NOT IN ('upsell','token_purchase'))))
    ) price_plan
  FROM fin
  GROUP BY uid, c_date, c_funnel, c_camp, c_campaign_id, c_traffic_source,
    u_media_buyer, u_country, u_card_type
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
