// Owner SQL golden corpus (access Phase 2, spec §6 "Step 0" / T20).
//
// Phase 2 threads a ScopeSql handle through every Cohorts / Revenue / FB read
// runner. In all-scope mode (the data owner, every scope-all member, cron) the
// helpers must render EXACTLY today's text, so the owner's numbers cannot move.
// This harness is the proof: it drives the public runners with
// createRecordingClickHouse (no network) and a fake service-role Supabase that
// serves a validated cohort snapshot, an FB sync state, one active subscription
// and an empty campaign-alias map, over a fixed matrix of requests, and returns
// every statement that reached "the warehouse":
//   { kind, query, query_params, format } per statement,
// as a sorted multiset per scenario (Promise.all fan-out order is not part of
// the contract; query text, every bound parameter and the statement count are).
//
// The recorded corpus generated from the UNMODIFIED base code (4b4057e) lives in
// src/test/fixtures/owner-sql-golden.json; ownerSqlGolden.test.ts re-records it
// and compares byte for byte. Query texts are stored once in `sql` keyed by a
// content hash (the corpus repeats the same CTE chains hundreds of times).
//
// Deterministic by construction: the clock is pinned (only Date is faked), the
// FB V2 read flag is set explicitly per scenario, the responder answers from the
// query text alone, and parameter keys are sorted.
//
// Pure: no network, no Deno, no secrets.

import { createHash } from "node:crypto";
import { vi } from "vitest";
import {
  createRecordingClickHouse,
  type ClickHouseResponder,
  type RecordedStatement,
} from "./recordingClickHouse.ts";
import { runMaterializedCohortList, runMaterializedCohortOptions } from "../../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { runCohortDetails, runCohortList, runCohortOptions } from "../../../supabase/functions/_shared/clickhouse/cohorts.ts";
import { runRevenueDayBreakdown, runRevenueIntelligence } from "../../../supabase/functions/_shared/clickhouse/revenueIntelligence.ts";
import {
  FB_SYNC_NAME,
  buildFbDiagnostics,
  normalizeFbFilters,
  normalizeFbLevel,
  runFbCharts,
  runFbFilterOptions,
  runFbList,
  runFbReport,
  type FbReadFilters,
  type FbReadRequest,
} from "../../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import type { CohortFilters, CohortRequest } from "../../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type {
  RevenueBucket,
  RevenueIntelligenceFilters,
  RevenueIntelligenceRequest,
} from "../../../supabase/functions/_shared/clickhouse/revenueIntelligenceContract.ts";
import type {
  ClickHouseClientLike,
  SupabaseLikeClient,
  SupabaseQueryBuilder,
  SupabaseQueryResult,
} from "../../../supabase/functions/_shared/clickhouse/types.ts";

export const OWNER_SQL_CORPUS_FORMAT = "owner-sql-golden/v1";
/** The commit the fixture was generated from (main 470a153 + the Users-Leads tab). */
export const OWNER_SQL_CORPUS_BASE_COMMIT = "4b4057e";
export const OWNER_SQL_CORPUS_NOW = "2026-10-06T00:00:00.000Z";
export const OWNER_SQL_TENANT = "owner-golden-tenant-0001";
export const OWNER_SQL_WAREHOUSE_VERSION = "wh_golden000000000001";
/** Literal on purpose: the corpus must not move when a constant is refactored. */
export const OWNER_SQL_CLASSIFICATION_VERSION = "cohort_classifier_v3_platform";
const FB_V2_READS_ENV = "FB_WAREHOUSE_V2_READS";

/** Every public runner the owner's Phase-2 surfaces reach (spec §6 Step 0),
 * plus the dynamic Cohorts fallback the owner still gets without a snapshot. */
export const OWNER_SQL_RUNNERS = [
  "runMaterializedCohortList",
  "runMaterializedCohortOptions",
  "runCohortList",
  "runCohortOptions",
  "runCohortDetails",
  "runRevenueIntelligence",
  "runRevenueDayBreakdown",
  "runFbReport",
  "runFbList",
  "runFbCharts",
  "runFbFilterOptions",
  "buildFbDiagnostics",
] as const;
export type OwnerSqlRunner = (typeof OWNER_SQL_RUNNERS)[number];

/** How the fake warehouse answers. `default` drives every response-dependent
 * branch (support ready, cohort rows → FB visible-row tuples, unique snapshot);
 * `support_unavailable` flips the support CTE; `empty` returns no rows at all
 * (no visible cohort rows → the FB `AND 0` branch). */
export type OwnerSqlResponderProfile = "default" | "support_unavailable" | "empty";

export interface OwnerSqlRunIo {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
}

export interface OwnerSqlScenario {
  readonly id: string;
  readonly runner: OwnerSqlRunner;
  /** Value of FB_WAREHOUSE_V2_READS for this scenario (off = "", on = "true"). */
  readonly v2Reads: boolean;
  readonly responder: OwnerSqlResponderProfile;
  run(io: OwnerSqlRunIo): Promise<unknown>;
}

/** One recorded statement. `query` is a key into OwnerSqlCorpus.sql. Optional
 * transport fields are present only when the runner (or transport) set them —
 * an owner statement never carries settings / query_id (spec §3.3 M14). */
export interface OwnerSqlStatement {
  kind: RecordedStatement["kind"];
  query: string;
  query_params: Record<string, unknown>;
  format?: string;
  settings?: unknown;
  query_id?: unknown;
  table?: string;
  values?: unknown;
}

export interface OwnerSqlScenarioRecord {
  runner: OwnerSqlRunner;
  /** "resolved" | "null" (a materialized runner found no snapshot) | "rejected:<ErrorName>". */
  outcome: string;
  statements: OwnerSqlStatement[];
}

export interface OwnerSqlCorpus {
  format: string;
  base_commit: string;
  now: string;
  tenant: string;
  scenarios: Record<string, OwnerSqlScenarioRecord>;
  /** Query text by content key (`q_` + first 16 hex chars of its sha256). */
  sql: Record<string, string>;
}

// ---- Canonical form ----------------------------------------------------------

export function ownerSqlTextKey(text: string): string {
  return `q_${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
}

/** Objects with sorted keys (recursively); arrays keep their order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonical(item);
    }
    return out;
  }
  return value;
}

function canonicalStatement(statement: RecordedStatement, sql: Record<string, string>): OwnerSqlStatement {
  const key = ownerSqlTextKey(statement.query);
  if (sql[key] !== undefined && sql[key] !== statement.query) {
    throw new Error(`owner SQL corpus: content key collision on ${key}`);
  }
  sql[key] = statement.query;
  const raw = statement as RecordedStatement & { settings?: unknown; query_id?: unknown };
  const out: OwnerSqlStatement = {
    kind: statement.kind,
    query: key,
    query_params: canonical(statement.params ?? {}) as Record<string, unknown>,
  };
  if (statement.format !== undefined) out.format = statement.format;
  if (raw.settings !== undefined) out.settings = canonical(raw.settings);
  if (raw.query_id !== undefined) out.query_id = raw.query_id;
  if (statement.table !== undefined) out.table = statement.table;
  if (statement.values !== undefined) out.values = canonical(statement.values);
  return out;
}

const statementSortKey = (statement: OwnerSqlStatement) => JSON.stringify(statement);

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(record).sort()) out[key] = record[key];
  return out;
}

// ---- Fake warehouse ----------------------------------------------------------

/** Two cohorts, so the FB allocation SQL carries real visible-row tuples. */
const COHORT_ROWS: ReadonlyArray<Record<string, unknown>> = [
  { cohort_date: "2026-09-01", funnel: "Soulmate", campaign_path: "soulmate-sketch", trial_users: 12, gross_raw: 240.5, refund_raw: 9.99, d30_raw: 180.25, token_purchases: 2, token_email_purchases: 1, support_users: 1 },
  { cohort_date: "2026-09-02", funnel: "Past Life", campaign_path: "past-life", trial_users: 7, gross_raw: 99.9, refund_raw: 0, d30_raw: 60, token_purchases: 0, token_email_purchases: 0, support_users: 0 },
];

export function ownerSqlResponder(profile: OwnerSqlResponderProfile): ClickHouseResponder {
  if (profile === "empty") return () => [];
  return (statement) => {
    const query = statement.query;
    if (query.includes("FROM system.tables")) return [{ c: profile === "support_unavailable" ? 0 : 1 }];
    if (query.includes("AS support_unique_emails")) return [{ support_requests: 5, support_unique_emails: 4 }];
    if (query.includes("FROM fact_subscriptions FINAL")) return [{ c: 3 }];
    if (query.includes("snapshot_unique_users")) return [{ snapshot_rows: 10, snapshot_unique_users: 10, snapshot_duplicate_users: 0 }];
    if (query.includes("agg AS (")) return COHORT_ROWS.map((row) => ({ ...row }));
    return [];
  };
}

// ---- Fake service-role Supabase ----------------------------------------------

const SNAPSHOT_VALIDATION = { status: "PASS", duplicate_users: 0, dynamic_users: 100, materialized_users: 100 };

/** A validated, current snapshot under today's rules AND the Phase-2 readiness
 * columns (spec §2.1 §10), so the same fixture stays "ready" after the wave. */
export const OWNER_SQL_SNAPSHOT_STATE: Readonly<Record<string, unknown>> = {
  auth_user_id: OWNER_SQL_TENANT,
  snapshot_name: "fact_user_cohorts",
  status: "completed",
  active_warehouse_version: OWNER_SQL_WAREHOUSE_VERSION,
  active_classification_version: OWNER_SQL_CLASSIFICATION_VERSION,
  active_generated_at: "2026-10-05T23:00:00.000Z",
  building_warehouse_version: null,
  building_classification_version: null,
  build_token: null,
  lease_expires_at: null,
  started_at: "2026-10-05T22:59:00.000Z",
  finished_at: "2026-10-05T23:00:00.000Z",
  duration_ms: 60000,
  users_classified: 100,
  rows_inserted: 100,
  duplicate_users: 0,
  removed_or_invalidated: 0,
  source_transactions: 500,
  source_unique_users: 120,
  last_error: null,
  diagnostics: { validation: SNAPSHOT_VALIDATION },
  updated_at: "2026-10-05T23:00:00.000Z",
  active_validation: SNAPSHOT_VALIDATION,
  active_validated_at: "2026-10-05T23:00:00.000Z",
  active_campaign_scope_version: "campaign_scope_v1",
  fresh_verified_at: OWNER_SQL_CORPUS_NOW,
  stale_since: null,
};

export const OWNER_SQL_FB_SYNC_STATE: Readonly<Record<string, unknown>> = {
  auth_user_id: OWNER_SQL_TENANT,
  sync_name: FB_SYNC_NAME,
  status: "completed",
  current_stage: null,
  stopped_reason: null,
  last_run_mode: "incremental",
  cursor_transaction_id: "fb:2026-10-05",
  cursor_updated_at: "2026-10-05T03:00:00.000Z",
  started_at: "2026-10-05T02:58:00.000Z",
  finished_at: "2026-10-05T03:00:00.000Z",
  duration_ms: 120000,
  updated_at: "2026-10-05T03:00:00.000Z",
  diagnostics: { mode: "incremental", fb_stats_to: "2026-10-05", warehouse_version: "fbwh_golden" },
};

/** Reads are answered from in-memory rows filtered by `.eq`; every other table
 * (e.g. the FB campaign-alias map) is empty. Read runners never write. */
export function createOwnerSqlSupabase(): SupabaseLikeClient {
  const tables: Record<string, ReadonlyArray<Readonly<Record<string, unknown>>>> = {
    clickhouse_cohort_snapshot_state: [OWNER_SQL_SNAPSHOT_STATE],
    clickhouse_transaction_sync_state: [OWNER_SQL_FB_SYNC_STATE],
  };
  const write = () => {
    throw new Error("owner SQL corpus: unexpected Supabase write from a read runner");
  };
  return {
    from(table: string) {
      const eqs: Array<[string, unknown]> = [];
      const rows = () => (tables[table] ?? [])
        .filter((row) => eqs.every(([column, value]) => row[column] === value))
        .map((row) => JSON.parse(JSON.stringify(row)) as Record<string, unknown>);
      const builder: SupabaseQueryBuilder = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          eqs.push([column, value]);
          return builder;
        },
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        or: () => builder,
        in: () => builder,
        lte: () => builder,
        gte: () => builder,
        neq: () => builder,
        range: () => builder,
        maybeSingle: async (): Promise<SupabaseQueryResult> => ({ data: rows()[0] ?? null, error: null }),
        single: async (): Promise<SupabaseQueryResult> => ({ data: rows()[0] ?? null, error: null }),
        upsert: write,
        insert: write,
        update: write,
        delete: write,
        then: (resolve: (value: SupabaseQueryResult) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: rows(), error: null }).then(resolve, reject),
      } as unknown as SupabaseQueryBuilder;
      return builder;
    },
    async rpc(functionName: string): Promise<SupabaseQueryResult> {
      // One active subscription, so the active-subscription overlay issues its
      // ClickHouse email query (materialized and dynamic paths alike).
      if (functionName === "active_funnelfox_subscription_emails") {
        return { data: { "golden.buyer@example.com": ["sub_golden_1"] }, error: null };
      }
      return { data: null, error: null };
    },
  };
}

// ---- Request matrix ----------------------------------------------------------

const DATE_FROM = "2026-08-01";
const DATE_TO = "2026-09-30";

const ALL_COHORT_FILTERS: Partial<CohortFilters> = {
  funnel: ["Soulmate", "Past Life"],
  campaign_path: ["soulmate-sketch", "past-life"],
  campaign_path_exclude: ["palm-reading"],
  campaign_id: ["120210000000001", "120210000000002"],
  traffic_source: ["facebook"],
  price_plan: ["$29.99"],
  media_buyer: ["Ivan", "utm:int1"],
  country: ["US"],
  card_type: ["credit"],
  platform: ["ios"],
  currency: ["USD"],
  transaction_type: ["trial"],
  refund_status: "has",
};

/** No filters, every filter dimension on its own, date ranges, `utm:` media
 * buyer selections, exclude lists, refund post-filters, hex-literal edge values
 * and everything at once. */
export const COHORT_REQUEST_CASES: ReadonlyArray<readonly [string, CohortRequest]> = [
  ["none", {}],
  ["date_from", { date_from: DATE_FROM }],
  ["date_to", { date_to: DATE_TO }],
  ["date_range", { date_from: DATE_FROM, date_to: DATE_TO }],
  ["funnel", { filters: { funnel: ["Soulmate", "Past Life"] } }],
  ["campaign_path", { filters: { campaign_path: ["soulmate-sketch", "past-life"] } }],
  ["campaign_path_exclude", { filters: { campaign_path_exclude: ["palm-reading", "unknown"] } }],
  ["campaign_path_include_exclude", { filters: { campaign_path: ["soulmate-sketch", "past-life"], campaign_path_exclude: ["palm-reading"] } }],
  ["campaign_id", { filters: { campaign_id: ["120210000000001", "120210000000002"] } }],
  ["traffic_source", { filters: { traffic_source: ["facebook", "tiktok"] } }],
  ["price_plan", { filters: { price_plan: ["$29.99", "Unknown"] } }],
  ["media_buyer", { filters: { media_buyer: ["Ivan", "Unknown"] } }],
  ["media_buyer_utm", { filters: { media_buyer: ["utm:int1", "utm:int2"] } }],
  ["media_buyer_mixed", { filters: { media_buyer: ["Ivan", "utm:int1", "utm:int2"] } }],
  ["country", { filters: { country: ["US", "DE"] } }],
  ["card_type", { filters: { card_type: ["credit", "debit"] } }],
  ["platform", { filters: { platform: ["ios", "android"] } }],
  ["currency", { filters: { currency: ["USD", "EUR"] } }],
  ["transaction_type", { filters: { transaction_type: ["trial", "upsell"] } }],
  ["refund_has", { filters: { refund_status: "has" } }],
  ["refund_none", { filters: { refund_status: "none" } }],
  ["special_chars", {
    filters: {
      campaign_id: ["o'brien-ü", " 120210000000001 "],
      campaign_path: ["soulmate-sketch", "soulmate-sketch"],
      media_buyer: ["utm:ü src"],
    },
  }],
  ["all", { date_from: DATE_FROM, date_to: DATE_TO, filters: ALL_COHORT_FILTERS }],
];

const COHORT_KEY = { cohort_date: "2026-09-01", funnel: "Soulmate", campaign_path: "soulmate-sketch" };
const FUNNEL_KEY = { campaign_path: "soulmate-sketch" };

export const COHORT_DETAILS_CASES: ReadonlyArray<readonly [string, CohortRequest]> = [
  ["cohort_key", { cohort_key: COHORT_KEY }],
  ...(["campaign_id", "traffic_source", "country", "card_type", "platform", "currency", "media_buyer", "media_buyer_utm", "media_buyer_mixed"] as const)
    .map((name): readonly [string, CohortRequest] => {
      const [, request] = COHORT_REQUEST_CASES.find(([id]) => id === name)!;
      return [`cohort_key+${name}`, { ...request, cohort_key: COHORT_KEY }];
    }),
  ["cohort_key+all", { date_from: DATE_FROM, date_to: DATE_TO, filters: ALL_COHORT_FILTERS, cohort_key: COHORT_KEY }],
  ["funnel_key", { funnel_key: FUNNEL_KEY }],
  ["funnel_key+date_from", { date_from: DATE_FROM, funnel_key: FUNNEL_KEY }],
  ["funnel_key+date_to", { date_to: DATE_TO, funnel_key: FUNNEL_KEY }],
  ["funnel_key+date_range", { date_from: DATE_FROM, date_to: DATE_TO, funnel_key: FUNNEL_KEY }],
  ["funnel_key+funnel", { filters: { funnel: ["Soulmate", "Past Life"] }, funnel_key: FUNNEL_KEY }],
  ["funnel_key+all", { date_from: DATE_FROM, date_to: DATE_TO, filters: ALL_COHORT_FILTERS, funnel_key: FUNNEL_KEY }],
  // cohort_key wins when both are present.
  ["both_keys", { cohort_key: COHORT_KEY, funnel_key: { campaign_path: "past-life" } }],
];

export const REVENUE_BUCKETS: readonly RevenueBucket[] = ["day", "week", "month"];

/** A mid-week, mid-month window: week/month grains widen it to whole buckets. */
const RI_FROM = "2026-09-03";
const RI_TO = "2026-09-17";
const RI_WINDOWS: ReadonlyArray<readonly [string, Pick<RevenueIntelligenceRequest, "date_from" | "date_to">]> = [
  ["none", {}],
  ["range", { date_from: RI_FROM, date_to: RI_TO }],
  ["from", { date_from: RI_FROM }],
  ["to", { date_to: RI_TO }],
];

const ALL_RI_FILTERS: Partial<RevenueIntelligenceFilters> = {
  funnel: ["Soulmate", "Past Life"],
  campaign_path: ["soulmate-sketch", "past-life"],
  campaign_id: ["120210000000001"],
  traffic_source: ["facebook"],
  media_buyer: ["Ivan", "utm:int1"],
  country: ["US"],
  card_type: ["credit"],
  platform: ["ios"],
  currency: ["USD"],
  price_plan: ["$29.99"],
};

export const REVENUE_FILTER_CASES: ReadonlyArray<readonly [string, Partial<RevenueIntelligenceFilters>]> = [
  ["funnel", { funnel: ["Soulmate", "Past Life"] }],
  ["funnel_unsorted_duplicates", { funnel: ["Soulmate", "Past Life", "Soulmate", " "] }],
  ["campaign_path", { campaign_path: ["soulmate-sketch", "past-life"] }],
  ["campaign_id", { campaign_id: ["120210000000001", "120210000000002"] }],
  ["traffic_source", { traffic_source: ["facebook", "tiktok"] }],
  ["media_buyer", { media_buyer: ["Ivan", "Unknown"] }],
  ["media_buyer_utm", { media_buyer: ["utm:int1", "utm:int2"] }],
  ["media_buyer_mixed", { media_buyer: ["Ivan", "utm:int1"] }],
  ["country", { country: ["US", "DE"] }],
  ["card_type", { card_type: ["credit", "debit"] }],
  ["platform", { platform: ["ios", "android"] }],
  ["currency", { currency: ["USD", "EUR"] }],
  ["price_plan", { price_plan: ["$29.99", "Unknown"] }],
  ["all", ALL_RI_FILTERS],
];

export const FB_LEVEL_CASES = ["account", "campaign", "adset", "ad", "day"] as const;

const FB_FROM = "2026-08-01";
const FB_TO = "2026-09-14";
export const FB_FILTER_CASES: ReadonlyArray<readonly [string, Partial<FbReadFilters>]> = [
  ["none", {}],
  ["date_range", { date_from: FB_FROM, date_to: FB_TO }],
  ["date_from", { date_from: FB_FROM }],
  ["date_to", { date_to: FB_TO }],
  ["buyer", { buyer: ["Ivan", "Olga"] }],
  ["ad_account_id", { ad_account_id: ["act_100", "act_200"] }],
  ["campaign_id", { campaign_id: ["120210000000001", "120210000000002"] }],
  ["all", { date_from: FB_FROM, date_to: FB_TO, buyer: ["Ivan"], ad_account_id: ["act_100"], campaign_id: ["120210000000001"] }],
];

const fbFilters = (name: string): Partial<FbReadFilters> => {
  const found = FB_FILTER_CASES.find(([id]) => id === name);
  if (!found) throw new Error(`owner SQL corpus: unknown FB filter case ${name}`);
  return found[1];
};

// ---- Scenarios ---------------------------------------------------------------

function buildScenarios(): OwnerSqlScenario[] {
  const scenarios: OwnerSqlScenario[] = [];
  const add = (
    id: string,
    runner: OwnerSqlRunner,
    run: OwnerSqlScenario["run"],
    options: { v2Reads?: boolean; responder?: OwnerSqlResponderProfile } = {},
  ) => {
    scenarios.push({ id, runner, run, v2Reads: options.v2Reads ?? false, responder: options.responder ?? "default" });
  };

  // Cohorts — materialized (the owner's normal path) and the dynamic fallback.
  for (const [name, request] of COHORT_REQUEST_CASES) {
    add(`cohorts.list.materialized/${name}`, "runMaterializedCohortList", (io) =>
      runMaterializedCohortList({ ...io, request: { ...request, action: "list" } }));
    add(`cohorts.options.materialized/${name}`, "runMaterializedCohortOptions", (io) =>
      runMaterializedCohortOptions({ ...io, request: { ...request, action: "options" } }));
    add(`cohorts.list.dynamic/${name}`, "runCohortList", (io) =>
      runCohortList({ ...io, request: { ...request, action: "list" } }));
    add(`cohorts.options.dynamic/${name}`, "runCohortOptions", (io) =>
      runCohortOptions({ authUserId: io.authUserId, clickhouse: io.clickhouse, request: { ...request, action: "options" } }));
  }
  for (const profile of ["support_unavailable", "empty"] as const) {
    add(`cohorts.list.materialized/none@${profile}`, "runMaterializedCohortList", (io) =>
      runMaterializedCohortList({ ...io, request: { action: "list" } }), { responder: profile });
    add(`cohorts.list.dynamic/none@${profile}`, "runCohortList", (io) =>
      runCohortList({ ...io, request: { action: "list" } }), { responder: profile });
  }
  add("cohorts.list.materialized/all@support_unavailable", "runMaterializedCohortList", (io) =>
    runMaterializedCohortList({ ...io, request: { date_from: DATE_FROM, date_to: DATE_TO, filters: ALL_COHORT_FILTERS, action: "list" } }),
  { responder: "support_unavailable" });

  for (const [name, request] of COHORT_DETAILS_CASES) {
    add(`cohorts.details/${name}`, "runCohortDetails", (io) =>
      runCohortDetails({ authUserId: io.authUserId, clickhouse: io.clickhouse, request: { ...request, action: "details" }, detailedErrors: true }));
  }
  add("cohorts.details/cohort_key@support_unavailable", "runCohortDetails", (io) =>
    runCohortDetails({ authUserId: io.authUserId, clickhouse: io.clickhouse, request: { cohort_key: COHORT_KEY, action: "details" } }),
  { responder: "support_unavailable" });

  // Revenue Intelligence — every bucket × window without filters (unattributed
  // and spend streams included), every filter dimension, day breakdown.
  for (const bucket of REVENUE_BUCKETS) {
    for (const [windowName, window] of RI_WINDOWS) {
      add(`revenue.bundle/bucket=${bucket}/window=${windowName}`, "runRevenueIntelligence", (io) =>
        runRevenueIntelligence({ ...io, request: { action: "bundle", bucket, ...window }, now: new Date(OWNER_SQL_CORPUS_NOW) }));
    }
  }
  for (const [name, filters] of REVENUE_FILTER_CASES) {
    add(`revenue.bundle/bucket=day/window=range/filter=${name}`, "runRevenueIntelligence", (io) =>
      runRevenueIntelligence({ ...io, request: { action: "bundle", bucket: "day", date_from: RI_FROM, date_to: RI_TO, filters }, now: new Date(OWNER_SQL_CORPUS_NOW) }));
  }
  for (const bucket of ["week", "month"] as const) {
    add(`revenue.bundle/bucket=${bucket}/window=range/filter=all`, "runRevenueIntelligence", (io) =>
      runRevenueIntelligence({ ...io, request: { action: "bundle", bucket, date_from: RI_FROM, date_to: RI_TO, filters: ALL_RI_FILTERS }, now: new Date(OWNER_SQL_CORPUS_NOW) }));
  }
  const dayBreakdownCases: ReadonlyArray<readonly [string, Partial<RevenueIntelligenceFilters>]> = [
    ["none", {}],
    ...REVENUE_FILTER_CASES.filter(([id]) => ["campaign_path", "media_buyer_utm", "media_buyer_mixed", "all"].includes(id)),
  ];
  for (const [name, filters] of dayBreakdownCases) {
    add(`revenue.day_breakdown/filter=${name}`, "runRevenueDayBreakdown", (io) =>
      runRevenueDayBreakdown({ ...io, request: { action: "day_breakdown", date: "2026-09-10", filters } }));
  }

  // FB Analytics warehouse reads — every level with the V2 read flag off and on.
  const fbRequest = (level: string, filterName: string, extra: Partial<FbReadRequest> = {}): FbReadRequest =>
    ({ level, filters: { ...fbFilters(filterName) }, ...extra });
  for (const v2Reads of [false, true]) {
    const v2 = v2Reads ? "on" : "off";
    for (const level of FB_LEVEL_CASES) {
      for (const filterName of ["none", "all"]) {
        add(`fb.report/level=${level}/v2=${v2}/filters=${filterName}`, "runFbReport", (io) =>
          runFbReport({ ...io, request: fbRequest(level, filterName, { action: "report" }) }), { v2Reads });
        add(`fb.list/level=${level}/v2=${v2}/filters=${filterName}`, "runFbList", (io) =>
          runFbList(io.clickhouse, io.authUserId, fbRequest(level, filterName, { action: "list" })), { v2Reads });
        add(`fb.status/level=${level}/v2=${v2}/filters=${filterName}`, "buildFbDiagnostics", (io) => {
          // Exactly the clickhouse-facebook `status` action's call.
          const request = fbRequest(level, filterName, { action: "status" });
          return buildFbDiagnostics({ ...io, level: normalizeFbLevel(request.level), filters: normalizeFbFilters(request) });
        }, { v2Reads });
      }
      for (const filterName of ["none", "date_range", "buyer", "all"]) {
        add(`fb.charts/level=${level}/v2=${v2}/filters=${filterName}`, "runFbCharts", (io) =>
          runFbCharts(io.clickhouse, io.authUserId, fbRequest(level, filterName, { action: "charts" })), { v2Reads });
      }
    }
    for (const [filterName] of FB_FILTER_CASES) {
      add(`fb.filters/v2=${v2}/filters=${filterName}`, "runFbFilterOptions", (io) =>
        runFbFilterOptions(io.clickhouse, io.authUserId, fbRequest("campaign", filterName, { action: "filters" })), { v2Reads });
      if (filterName === "none" || filterName === "all") continue;
      add(`fb.report/level=campaign/v2=${v2}/filters=${filterName}`, "runFbReport", (io) =>
        runFbReport({ ...io, request: fbRequest("campaign", filterName, { action: "report" }) }), { v2Reads });
      add(`fb.list/level=campaign/v2=${v2}/filters=${filterName}`, "runFbList", (io) =>
        runFbList(io.clickhouse, io.authUserId, fbRequest("campaign", filterName, { action: "list" })), { v2Reads });
      add(`fb.status/level=campaign/v2=${v2}/filters=${filterName}`, "buildFbDiagnostics", (io) => {
        const request = fbRequest("campaign", filterName, { action: "status" });
        return buildFbDiagnostics({ ...io, level: normalizeFbLevel(request.level), filters: normalizeFbFilters(request) });
      }, { v2Reads });
    }
  }
  // Per-request V2 read path (v2_preview) with the global flag off.
  for (const level of FB_LEVEL_CASES) {
    add(`fb.list/level=${level}/v2=preview/filters=none`, "runFbList", (io) =>
      runFbList(io.clickhouse, io.authUserId, fbRequest(level, "none", { action: "list", v2_preview: true })));
  }
  // LIMIT is interpolated into the list SQL: default, clamped low/high, explicit; sort is client-side.
  for (const [name, extra] of [
    ["limit=250/sort=cpp_asc", { limit: 250, sort: { field: "cpp", direction: "asc" } }],
    ["limit=0", { limit: 0 }],
    ["limit=99999", { limit: 99999 }],
    ["limit=2.7", { limit: 2.7 }],
  ] as const) {
    add(`fb.list/level=campaign/v2=off/filters=none/${name}`, "runFbList", (io) =>
      runFbList(io.clickhouse, io.authUserId, fbRequest("campaign", "none", { action: "list", ...extra })));
    add(`fb.report/level=campaign/v2=off/filters=none/${name}`, "runFbReport", (io) =>
      runFbReport({ ...io, request: fbRequest("campaign", "none", { action: "report", ...extra }) }));
  }
  // An unknown level falls back to campaign.
  add("fb.report/level=bogus/v2=off/filters=none", "runFbReport", (io) =>
    runFbReport({ ...io, request: fbRequest("bogus", "none", { action: "report" }) }));

  return scenarios;
}

export const OWNER_SQL_SCENARIOS: readonly OwnerSqlScenario[] = Object.freeze(buildScenarios());

// ---- Recording ---------------------------------------------------------------

/** Runs the scenarios sequentially, each on a fresh recording warehouse and a
 * fresh fake Supabase, with the clock pinned to OWNER_SQL_CORPUS_NOW. Restores
 * the real clock and FB_WAREHOUSE_V2_READS afterwards. */
export async function recordOwnerSqlCorpus(scenarios: readonly OwnerSqlScenario[] = OWNER_SQL_SCENARIOS): Promise<OwnerSqlCorpus> {
  const sql: Record<string, string> = {};
  const records: Record<string, OwnerSqlScenarioRecord> = {};
  const hadEnv = Object.prototype.hasOwnProperty.call(process.env, FB_V2_READS_ENV);
  const previousEnv = process.env[FB_V2_READS_ENV];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(OWNER_SQL_CORPUS_NOW));
  try {
    for (const scenario of scenarios) {
      if (records[scenario.id]) throw new Error(`owner SQL corpus: duplicate scenario id ${scenario.id}`);
      process.env[FB_V2_READS_ENV] = scenario.v2Reads ? "true" : "";
      const clickhouse = createRecordingClickHouse(ownerSqlResponder(scenario.responder));
      let outcome: string;
      try {
        const result = await scenario.run({ clickhouse, supabase: createOwnerSqlSupabase(), authUserId: OWNER_SQL_TENANT });
        outcome = result == null ? "null" : "resolved";
      } catch (error) {
        outcome = `rejected:${error instanceof Error ? error.name : typeof error}`;
      }
      const statements = clickhouse.statements
        .map((statement) => canonicalStatement(statement, sql))
        .sort((a, b) => {
          const left = statementSortKey(a);
          const right = statementSortKey(b);
          return left < right ? -1 : left > right ? 1 : 0;
        });
      records[scenario.id] = { runner: scenario.runner, outcome, statements };
    }
  } finally {
    if (hadEnv) process.env[FB_V2_READS_ENV] = previousEnv;
    else delete process.env[FB_V2_READS_ENV];
    vi.useRealTimers();
  }
  return {
    format: OWNER_SQL_CORPUS_FORMAT,
    base_commit: OWNER_SQL_CORPUS_BASE_COMMIT,
    now: OWNER_SQL_CORPUS_NOW,
    tenant: OWNER_SQL_TENANT,
    scenarios: records,
    sql: sortedRecord(sql),
  };
}

/** The fixture file's exact text (LF, two-space indent, trailing newline). */
export function serializeOwnerSqlCorpus(corpus: OwnerSqlCorpus): string {
  return `${JSON.stringify(corpus, null, 2)}\n`;
}

// ---- Comparison --------------------------------------------------------------

function expand(statement: OwnerSqlStatement, sql: Record<string, string>): { text: string; rest: string; full: string } {
  const text = sql[statement.query] ?? `<missing sql text ${statement.query}>`;
  const { query: _key, ...others } = statement;
  const rest = JSON.stringify(canonical(others));
  return { text, rest, full: JSON.stringify([text, rest]) };
}

function firstDifference(expected: string, actual: string): string {
  let index = 0;
  while (index < expected.length && index < actual.length && expected[index] === actual[index]) index += 1;
  const from = Math.max(0, index - 40);
  return `first difference at offset ${index}: expected ${JSON.stringify(expected.slice(from, index + 60))}, got ${JSON.stringify(actual.slice(from, index + 60))}`;
}

function commonPrefix(a: string, b: string): number {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/** Human-readable differences of one scenario (empty when byte-identical). */
export function diffOwnerSqlScenario(id: string, expected: OwnerSqlCorpus, actual: OwnerSqlCorpus): string[] {
  const want = expected.scenarios[id];
  const got = actual.scenarios[id];
  if (!want) return [`${id}: not in the golden fixture`];
  if (!got) return [`${id}: no longer recorded by the harness`];
  const problems: string[] = [];
  if (want.runner !== got.runner) problems.push(`${id}: runner ${want.runner} -> ${got.runner}`);
  if (want.outcome !== got.outcome) problems.push(`${id}: outcome ${want.outcome} -> ${got.outcome}`);
  if (want.statements.length !== got.statements.length) {
    problems.push(`${id}: ${want.statements.length} statements expected, ${got.statements.length} recorded`);
  }
  const unmatched = got.statements.map((statement) => expand(statement, actual.sql));
  const missing: Array<ReturnType<typeof expand>> = [];
  for (const statement of want.statements) {
    const wanted = expand(statement, expected.sql);
    const index = unmatched.findIndex((candidate) => candidate.full === wanted.full);
    if (index >= 0) unmatched.splice(index, 1);
    else missing.push(wanted);
  }
  for (const wanted of missing) {
    let best = -1;
    let bestPrefix = -1;
    unmatched.forEach((candidate, index) => {
      const prefix = commonPrefix(wanted.text, candidate.text);
      if (prefix > bestPrefix) {
        best = index;
        bestPrefix = prefix;
      }
    });
    if (best < 0) {
      problems.push(`${id}: statement no longer issued: ${JSON.stringify(wanted.text.slice(0, 160))}`);
      continue;
    }
    const candidate = unmatched.splice(best, 1)[0];
    if (candidate.text !== wanted.text) problems.push(`${id}: query text changed; ${firstDifference(wanted.text, candidate.text)}`);
    if (candidate.rest !== wanted.rest) problems.push(`${id}: params/transport changed; ${firstDifference(wanted.rest, candidate.rest)}`);
  }
  for (const extra of unmatched) problems.push(`${id}: new statement issued: ${JSON.stringify(extra.text.slice(0, 160))}`);
  return problems;
}

/** Every difference between two corpora (empty when byte-identical). */
export function diffOwnerSqlCorpus(expected: OwnerSqlCorpus, actual: OwnerSqlCorpus): string[] {
  const ids = [...new Set([...Object.keys(expected.scenarios), ...Object.keys(actual.scenarios)])];
  return ids.flatMap((id) => diffOwnerSqlScenario(id, expected, actual));
}
