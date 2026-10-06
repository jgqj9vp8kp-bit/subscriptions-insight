// fact_campaign_scope (access Phase 2, spec §3.7): which Facebook campaigns a
// funnel-restricted member may see.
//
// Built by the cohort snapshot rebuild right after it activates a snapshot (or
// by the tick for a current snapshot that lacks it), for the snapshot's
// (warehouse, classification) versions. The evidence is the anchor attribution itself: the
// non-synthetic users of fact_user_cohorts grouped by their authoritative
// campaign_id and campaign_path. Per campaign id:
//   * resolved   — every user (alias evidence included) sits on exactly ONE
//                  scopable path (P: canonical, not 'unknown', ≤ 200 chars) and
//                  there are at least PATH_EVIDENCE_MIN_USERS of them;
//   * mixed      — the users sit on two or more paths ('' and 'unknown' count);
//   * unresolved — anything else (thin evidence, one unscopable path).
// Restricted FB reads (scopeSql.ts fbFrom / campaignScopeVisibleFrom) see only
// `resolved` campaigns whose path is in the member's scope, so a campaign that
// spans several funnels is hidden from all of their buyers (owner decision 3).
//
// Alias evidence (Layer A: observed utm id → Meta spend-side id) is UNIONED into
// the spend-side id. resolveCampaignPaths (capsuledTraffic.ts) lets the
// spend-side id's own evidence win instead; a visibility rule must never
// resolve on part of the evidence, so this is the stricter of the two.
//
// A rebuild of versions that already have rows (rebuild_force, a refill after
// a FAIL) writes a newer 'unresolved' row for every id it no longer classifies,
// so a stale row can neither stay visible nor fail every later read-back.
//
// buildCampaignScope never fails its caller: any error except a ScopeViolation
// becomes status "FAIL". The owner's snapshot stays completed either way (R-17);
// only a PASS — a FINAL read-back that matches the TypeScript classification
// exactly — marks the scope usable (set_clickhouse_campaign_scope_version).

import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import { FACT_USER_COHORTS_TABLE } from "./schema.ts";
import { PATH_EVIDENCE_MIN_USERS } from "./capsuledTraffic.ts";
import { loadActiveCampaignAliasMap } from "./fbCampaignResolution.ts";
import { CAMPAIGN_SCOPE_VERSION } from "./cohortSnapshotState.ts";
import { SCOPE_PATH_RE } from "./scopeSql.ts";
import { ScopeViolation } from "./scopedClient.ts";

export const FACT_CAMPAIGN_SCOPE_TABLE = "fact_campaign_scope";

export const CREATE_FACT_CAMPAIGN_SCOPE_SQL = `
CREATE TABLE IF NOT EXISTS ${FACT_CAMPAIGN_SCOPE_TABLE}
(
    auth_user_id String,
    warehouse_version String,
    classification_version String,
    scope_version String,
    campaign_id String,
    campaign_path String,
    status LowCardinality(String),
    anchor_users UInt32,
    merged_users UInt32,
    distinct_paths UInt16,
    source LowCardinality(String),
    generated_at DateTime64(3, 'UTC'),
    row_version UInt64
)
ENGINE = ReplacingMergeTree(row_version)
ORDER BY
(
    auth_user_id,
    warehouse_version,
    classification_version,
    scope_version,
    campaign_id
)
`;

/** Anchor evidence: users of the snapshot per (authoritative campaign id, path).
 * The campaign expression is fbCohortStats.ts authoritativeCampaignExpr (the
 * id the Cohorts FB columns join on); synthetic unknown_user_ ids never count. */
export const CAMPAIGN_SCOPE_EVIDENCE_SQL = `SELECT if(lowerUTF8(trim(BOTH ' ' FROM fc.campaign_id)) IN ('', 'unknown', 'null', 'n/a', 'none'), '', trim(BOTH ' ' FROM fc.campaign_id)) AS cid,
    fc.campaign_path AS campaign_path,
    count() AS users
  FROM ${FACT_USER_COHORTS_TABLE} AS fc FINAL
  WHERE fc.auth_user_id = {auth_user_id:String}
    AND fc.warehouse_version = {warehouse_version:String}
    AND fc.classification_version = {classification_version:String}
    AND NOT startsWith(fc.canonical_user_id, 'unknown_user_')
  GROUP BY cid, campaign_path
  FORMAT JSONEachRow`;

/** Campaign ids already stored for these versions (FINAL): a rebuild of the
 * same versions (rebuild_force, the tick's refill after a FAIL) must retire the
 * ids its classification no longer has — e.g. an alias-only id after its
 * facebook_campaign_mapping row was deactivated. */
export const CAMPAIGN_SCOPE_EXISTING_IDS_SQL = `SELECT campaign_id
  FROM ${FACT_CAMPAIGN_SCOPE_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
    AND scope_version = {scope_version:String}
  FORMAT JSONEachRow`;

/** FINAL read-back of one build (validation step 6). No alias repeats a column
 * name: ClickHouse would substitute it into the sibling aggregates. */
export const CAMPAIGN_SCOPE_VALIDATION_SQL = `SELECT count() AS scope_rows,
    uniqExact(campaign_id) AS campaign_ids,
    countIf(status = 'resolved' AND (campaign_path = '' OR merged_users < ${PATH_EVIDENCE_MIN_USERS})) AS bad_resolved,
    countIf(status = 'mixed' AND distinct_paths < 2) AS bad_mixed,
    sum(anchor_users) AS anchor_total
  FROM ${FACT_CAMPAIGN_SCOPE_TABLE} FINAL
  WHERE auth_user_id = {auth_user_id:String}
    AND warehouse_version = {warehouse_version:String}
    AND classification_version = {classification_version:String}
    AND scope_version = {scope_version:String}
  FORMAT JSONEachRow`;

export interface CampaignEvidenceRow {
  campaign_id: string;
  campaign_path: string;
  users: number;
}

export interface CampaignScopeRow {
  campaign_id: string;
  campaign_path: string;
  status: "resolved" | "mixed" | "unresolved";
  anchor_users: number;
  merged_users: number;
  distinct_paths: number;
  source: "anchor" | "alias";
}

export interface CampaignScopeBuildResult {
  version: string;
  status: "PASS" | "FAIL";
  rows: number;
  resolved: number;
  mixed: number;
  unresolved: number;
  /** Distinct evidence paths outside P ('' and 'unknown' included): users on
   * them can never make a campaign visible to a restricted member. */
  noncanonical_paths: number;
  /** Ids an earlier build of these versions stored that this one retired
   * (counted in rows / unresolved too). Present only when > 0. */
  retired?: number;
  error?: string;
}

const SCOPE_PATH_MAX_LENGTH = 200;
const NON_CAMPAIGN_IDS: ReadonlySet<string> = new Set(["", "unknown", "null", "n/a", "none"]);

const n = (value: unknown): number => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const s = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));

/** The SQL evidence expression, mirrored: trimmed, placeholder ids → "". */
function campaignIdOf(value: unknown): string {
  const id = s(value).trim();
  return NON_CAMPAIGN_IDS.has(id.toLowerCase()) ? "" : id;
}

function evidenceUsers(value: unknown): number {
  return Math.max(0, Math.trunc(n(value)));
}

/** P of spec §2.1: the only paths a restricted member can hold. */
export function isScopableCampaignPath(path: string): boolean {
  return path !== "unknown" && path.length <= SCOPE_PATH_MAX_LENGTH && SCOPE_PATH_RE.test(path);
}

function sumUsers(paths: ReadonlyMap<string, number> | undefined): number {
  let total = 0;
  for (const users of paths?.values() ?? []) total += users;
  return total;
}

/** Evidence → one row per campaign id (anchor ids, plus alias targets that
 * received evidence). Paths are compared exactly as stored: no normalization,
 * so near-duplicates make a campaign mixed rather than resolved. */
export function classifyCampaignScope(
  evidence: readonly CampaignEvidenceRow[],
  aliases: Readonly<Record<string, string>>,
): CampaignScopeRow[] {
  const own = new Map<string, Map<string, number>>();
  for (const row of evidence) {
    const id = campaignIdOf(row.campaign_id);
    const users = evidenceUsers(row.users);
    if (!id || users <= 0) continue;
    const path = s(row.campaign_path);
    const paths = own.get(id) ?? new Map<string, number>();
    paths.set(path, (paths.get(path) ?? 0) + users);
    own.set(id, paths);
  }

  // Union, never override: the spend-side id keeps its own evidence AND gains
  // every observed alias's evidence.
  const merged = new Map<string, Map<string, number>>();
  for (const [id, paths] of own) merged.set(id, new Map(paths));
  for (const [rawObserved, rawFbId] of Object.entries(aliases ?? {})) {
    const observed = campaignIdOf(rawObserved);
    const fbId = campaignIdOf(rawFbId);
    const evidenceOfObserved = observed ? own.get(observed) : undefined;
    if (!fbId || observed === fbId || !evidenceOfObserved) continue;
    const target = merged.get(fbId) ?? new Map<string, number>();
    for (const [path, users] of evidenceOfObserved) target.set(path, (target.get(path) ?? 0) + users);
    merged.set(fbId, target);
  }

  return [...merged.keys()].sort().map((campaignId): CampaignScopeRow => {
    const paths = merged.get(campaignId) as Map<string, number>;
    const mergedUsers = sumUsers(paths);
    const [onlyPath] = paths.size === 1 ? [...paths.keys()] : [""];
    const status: CampaignScopeRow["status"] = paths.size >= 2
      ? "mixed"
      : paths.size === 1 && isScopableCampaignPath(onlyPath) && mergedUsers >= PATH_EVIDENCE_MIN_USERS
        ? "resolved"
        : "unresolved";
    return {
      campaign_id: campaignId,
      campaign_path: status === "resolved" ? onlyPath : "",
      status,
      anchor_users: sumUsers(own.get(campaignId)),
      merged_users: mergedUsers,
      distinct_paths: paths.size,
      source: own.has(campaignId) ? "anchor" : "alias",
    };
  });
}

/** ISO → the DateTime64 text JSONEachRow accepts under the default
 * date_time_input_format (no 'T' / 'Z'). */
function clickHouseTime(iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`campaign scope: invalid generatedAt ${iso}`);
  return parsed.toISOString().replace("T", " ").replace("Z", "");
}

function safeError(error: unknown): string {
  const message = error instanceof Error && error.message ? error.message : String(error ?? "campaign scope build failed");
  return message.split("\n")[0].slice(0, 300);
}

/** Builds and validates fact_campaign_scope for one snapshot. Never throws,
 * except a ScopeViolation (R7). */
export async function buildCampaignScope(input: {
  clickhouse: ClickHouseClientLike;
  supabase: SupabaseLikeClient;
  authUserId: string;
  warehouseVersion: string;
  classificationVersion: string;
  generatedAt: string;
}): Promise<CampaignScopeBuildResult> {
  const counts: Omit<CampaignScopeBuildResult, "version" | "status" | "error"> = { rows: 0, resolved: 0, mixed: 0, unresolved: 0, noncanonical_paths: 0 };
  try {
    if (!input.warehouseVersion || !input.classificationVersion) throw new Error("campaign scope needs the snapshot versions");
    const generatedAt = clickHouseTime(input.generatedAt);
    const rowVersion = Date.parse(input.generatedAt);
    const params = {
      auth_user_id: input.authUserId,
      warehouse_version: input.warehouseVersion,
      classification_version: input.classificationVersion,
    };

    await input.clickhouse.command({ query: CREATE_FACT_CAMPAIGN_SCOPE_SQL });
    const evidenceRs = await input.clickhouse.query({ query: CAMPAIGN_SCOPE_EVIDENCE_SQL, query_params: params, format: "JSONEachRow" });
    const evidence = ((await evidenceRs.json()) as Array<Record<string, unknown>>)
      .map((row): CampaignEvidenceRow => ({ campaign_id: campaignIdOf(row.cid), campaign_path: s(row.campaign_path), users: evidenceUsers(row.users) }))
      .filter((row) => row.campaign_id !== "" && row.users > 0);
    const evidenceTotal = evidence.reduce((total, row) => total + row.users, 0);
    counts.noncanonical_paths = new Set(evidence.map((row) => row.campaign_path).filter((path) => !isScopableCampaignPath(path))).size;

    const aliases = await loadActiveCampaignAliasMap(input.supabase, input.authUserId);
    const classified = classifyCampaignScope(evidence, aliases);
    // Ids a previous build of these versions stored and this one no longer
    // classifies get a newer 'unresolved' row (hidden, zero evidence):
    // otherwise they stay visible as they were, and every later read-back of
    // these versions FAILs on the row count.
    const existingRs = await input.clickhouse.query({
      query: CAMPAIGN_SCOPE_EXISTING_IDS_SQL,
      query_params: { ...params, scope_version: CAMPAIGN_SCOPE_VERSION },
      format: "JSONEachRow",
    });
    const classifiedIds = new Set(classified.map((row) => row.campaign_id));
    const retired = [...new Set(((await existingRs.json()) as Array<Record<string, unknown>>).map((row) => s(row.campaign_id)))]
      .filter((id) => id !== "" && !classifiedIds.has(id))
      .sort()
      .map((campaignId): CampaignScopeRow => ({
        campaign_id: campaignId, campaign_path: "", status: "unresolved", anchor_users: 0, merged_users: 0, distinct_paths: 0, source: "anchor",
      }));
    const rows = [...classified, ...retired];
    counts.rows = rows.length;
    counts.resolved = rows.filter((row) => row.status === "resolved").length;
    counts.mixed = rows.filter((row) => row.status === "mixed").length;
    counts.unresolved = rows.filter((row) => row.status === "unresolved").length;
    if (retired.length) counts.retired = retired.length;

    if (rows.length) {
      await input.clickhouse.insert({
        table: FACT_CAMPAIGN_SCOPE_TABLE,
        values: rows.map((row) => ({
          auth_user_id: input.authUserId,
          warehouse_version: input.warehouseVersion,
          classification_version: input.classificationVersion,
          scope_version: CAMPAIGN_SCOPE_VERSION,
          ...row,
          generated_at: generatedAt,
          row_version: rowVersion,
        })),
        format: "JSONEachRow",
      });
    }

    const checkRs = await input.clickhouse.query({
      query: CAMPAIGN_SCOPE_VALIDATION_SQL,
      query_params: { ...params, scope_version: CAMPAIGN_SCOPE_VERSION },
      format: "JSONEachRow",
    });
    const check = ((await checkRs.json()) as Array<Record<string, unknown>>)[0] ?? {};
    const failures: string[] = [];
    if (n(check.scope_rows) !== rows.length) failures.push(`rows ${n(check.scope_rows)} != ${rows.length}`);
    if (n(check.campaign_ids) !== rows.length) failures.push(`campaign ids ${n(check.campaign_ids)} != ${rows.length}`);
    if (n(check.bad_resolved) !== 0) failures.push(`${n(check.bad_resolved)} resolved rows without a path or with thin evidence`);
    if (n(check.bad_mixed) !== 0) failures.push(`${n(check.bad_mixed)} mixed rows with fewer than 2 paths`);
    if (n(check.anchor_total) !== evidenceTotal) failures.push(`anchor users ${n(check.anchor_total)} != evidence ${evidenceTotal}`);
    return failures.length
      ? { version: CAMPAIGN_SCOPE_VERSION, status: "FAIL", ...counts, error: `validation failed: ${failures.join("; ")}` }
      : { version: CAMPAIGN_SCOPE_VERSION, status: "PASS", ...counts };
  } catch (error) {
    if (error instanceof ScopeViolation) throw error;
    return { version: CAMPAIGN_SCOPE_VERSION, status: "FAIL", ...counts, error: safeError(error) };
  }
}
