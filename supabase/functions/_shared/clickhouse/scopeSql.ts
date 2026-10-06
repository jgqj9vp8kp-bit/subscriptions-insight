// Funnel-scope SQL helpers (access Phase 2, spec §3.2). Pure: no I/O, no Deno.
//
// Every reference a Phase-2 read makes to a protected table (analytics_transactions,
// fact_user_cohorts, fact_facebook_stats, fact_support_requests, fact_subscriptions,
// fact_campaign_scope) is produced by one of the helpers below, handed a ScopeSql
// handle by the gate (AccessRequest.scope):
//   * ALL scope (data owner, scope-all members, cron): each helper returns EXACTLY
//     today's text (`analytics_transactions AS a FINAL`, ...). The owner SQL golden
//     corpus (src/test/ownerSqlGolden.test.ts) proves the bytes do not move.
//   * restricted scope: each helper returns a one-line subquery bound to the
//     member's users — anchor attribution (owner decision 2): users whose
//     fact_user_cohorts.campaign_path is one of the member's funnel paths, minus
//     synthetic `unknown_user_%` ids, with ALL of their transactions — and records
//     the fragment in a private per-context registry.
//
// The ScopedReader (scopedClient.ts) masks the registered fragments of ITS
// context out of every restricted statement; any protected identifier left over
// is a ScopeViolation → 500 (R7). The registry has no exported writer, so request
// code cannot "register" a hand-written unscoped string.
//
// Values are bound as unhex('<hex>') literals, never interpolated text, and every
// fragment is one line without comment or quote-identifier characters (checked at
// registration). An empty path set renders the predicate `0`: never "no
// predicate", never `IN (unhex(''))`.
//
// Every registered fragment is a CLOSED subquery — `(SELECT … )`, optionally
// followed by ` AS <alias>` — so text a builder puts before or after it can
// never reach its WHERE (a bare `SELECT … WHERE … AND <paths>` followed by
// ` OR status = 'mixed'` would widen it, and the masked statement would look
// clean). Statement-level helpers (presenceProbeSql) register only their closed
// inner subquery.

import { isIssuedAccessContext, type AccessContext } from "../access/accessContext.ts";
import { ACCESS_ERROR_MESSAGES } from "../access/errors.ts";
import { CAMPAIGN_SCOPE_VERSION, type ScopeReadinessFailure, type ScopeSnapshot } from "./cohortSnapshotState.ts";
import {
  ANALYTICS_TRANSACTIONS_TABLE,
  FACT_FACEBOOK_STATS_TABLE,
  FACT_SUPPORT_REQUESTS_TABLE,
  FACT_USER_COHORTS_TABLE,
} from "./schema.ts";

export type ScopeFbLevel = "account" | "campaign" | "adset" | "ad" | "day";

declare const scopeSqlBrand: unique symbol;

/** Per-request scope handle. Frozen; only this module creates one (ALL_SCOPE_SQL,
 * or createRestrictedScopeSql from the gate). */
export interface ScopeSql {
  readonly restricted: boolean;
  /** The member's scopable paths (restricted); null for all scope. */
  readonly paths: readonly string[] | null;
  /** The active snapshot the gate validated (restricted actions with scopeSnapshot). */
  readonly snapshot: ScopeSnapshot | null;
  readonly [scopeSqlBrand]: true;
}

/** Canonical campaign_path form (palmer rule A output; `P` in spec §2.1). */
export const SCOPE_PATH_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SCOPE_PATH_MAX_LENGTH = 200;
/** Bound in place of an include list whose values are all out of scope: it
 * matches nothing, so the filter can never silently widen to "no filter". */
export const OUT_OF_SCOPE_SENTINEL = "\u0001out_of_scope\u0001";

/** Column lists of the restricted subqueries (M15). Never raw_payload /
 * normalized_payload of analytics_transactions. */
export const TX_COLS: readonly string[] = Object.freeze([
  "auth_user_id", "transaction_id", "user_id", "normalized_email", "event_time", "transaction_date", "campaign_id",
  "campaign_path", "utm_source", "media_buyer", "status", "transaction_type", "is_success", "is_trial",
  "is_first_subscription", "currency", "original_amount", "gross_amount_usd", "net_amount_usd", "refund_amount_usd",
  "billing_reason", "product_id", "product_name", "fx_status", "source_updated_at", "clickhouse_synced_at", "row_version",
]);
/** Every column of fact_user_cohorts (schema.ts CREATE_FACT_USER_COHORTS_SQL). */
export const FC_COLS: readonly string[] = Object.freeze([
  "auth_user_id", "canonical_user_id", "cohort_date", "trial_event_time", "trial_transaction_id", "normalized_email",
  "funnel", "campaign_path", "campaign_id", "traffic_source", "media_buyer", "country", "card_type", "currency",
  "price_plan", "trial_amount_usd", "source_updated_at", "warehouse_version", "classification_version", "generated_at",
  "row_version", "platform",
]);
/** Every column of fact_facebook_stats (schema.ts CREATE_FACT_FACEBOOK_STATS_SQL),
 * raw_payload included (campaign JSON read by the Cohorts FB columns). */
export const FB_COLS: readonly string[] = Object.freeze([
  "auth_user_id", "stat_date", "level", "ad_account_id", "ad_account_name", "buyer", "campaign_id", "campaign_name",
  "adset_id", "adset_name", "ad_id", "ad_name", "geo", "currency", "spend", "impressions", "reach", "clicks",
  "link_clicks", "outbound_clicks", "fb_purchases", "purchase_value", "cpp", "cpc", "cpm", "ctr", "outbound_ctr",
  "frequency", "roas", "raw_payload", "fb_stats_to", "source_updated_at", "clickhouse_synced_at", "warehouse_version",
  "row_version",
]);

/** Built by campaignScope.ts inside the snapshot rebuild (spec §3.7). */
const FACT_CAMPAIGN_SCOPE_TABLE = "fact_campaign_scope";
const TENANT = "auth_user_id = {auth_user_id:String}";
const RESTRICTED_FB_LEVELS: ReadonlySet<string> = new Set(["campaign", "adset", "ad"]);

const ALIAS_RE = /^[a-z_][a-z0-9_]{0,30}$/;
const COLUMN_RE = /^[a-z_]\w*(\.[a-z_]\w*)?$/;
const PREFIX_RE = /^[a-z0-9_]+$/;
/** Comment / quoted-identifier / escape sequences a fragment may never contain. */
const FRAGMENT_FORBIDDEN = ["--", "#", "/*", "*/", "`", "\"", "\\"];

// ---- errors ---------------------------------------------------------------------------

/** No usable snapshot for a restricted read → the gate answers 409 scope_snapshot_not_ready. */
export class ScopeSnapshotNotReadyError extends Error {
  readonly reason: ScopeReadinessFailure | "snapshot_missing";

  constructor(reason: ScopeReadinessFailure | "snapshot_missing") {
    super(ACCESS_ERROR_MESSAGES.scope_snapshot_not_ready);
    this.name = "ScopeSnapshotNotReadyError";
    this.reason = reason;
  }
}

/** A restricted request names something outside its scope → the gate answers 403
 * with this code (before any SQL when raised by an assert helper). */
export class ScopeForbiddenError extends Error {
  readonly code: "funnel_out_of_scope" | "scope_not_supported";

  constructor(code: "funnel_out_of_scope" | "scope_not_supported") {
    super(ACCESS_ERROR_MESSAGES[code]);
    this.name = "ScopeForbiddenError";
    this.code = code;
  }
}

// ---- private registry (F4.1) ------------------------------------------------------------

const createdHandles = new WeakSet<object>();
const contextByHandle = new WeakMap<ScopeSql, AccessContext>();
const fragmentsByContext = new WeakMap<AccessContext, Set<string>>();

function handle(scope: ScopeSql): ScopeSql {
  if (typeof scope !== "object" || scope === null || !createdHandles.has(scope)) {
    throw new Error("ScopeSql handle was not created by scopeSql.ts.");
  }
  return scope;
}

/** Index of the `)` closing the `(` at index 0 (single-quoted literals skipped),
 * or -1 when it never closes. */
function closingParenOf(fragment: string): number {
  let depth = 0;
  for (let index = 0; index < fragment.length; index += 1) {
    const char = fragment[index];
    if (char === "'") {
      // Skip the literal ('' inside it is an escaped quote; backslashes never reach here).
      index += 1;
      while (index < fragment.length) {
        if (fragment[index] === "'") {
          if (fragment[index + 1] !== "'") break;
          index += 1;
        }
        index += 1;
      }
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function assertFragmentInvariants(fragment: string): void {
  if (/[\r\n]/.test(fragment)) throw new Error("scope fragment must be one line");
  for (const token of FRAGMENT_FORBIDDEN) {
    if (fragment.includes(token)) throw new Error(`scope fragment contains a forbidden sequence (${token})`);
  }
  // Closed: `(SELECT …)` whose first parenthesis closes at the end, or right
  // before ` AS <alias>`.
  const close = fragment.startsWith("(SELECT ") ? closingParenOf(fragment) : -1;
  const rest = close < 0 ? null : fragment.slice(close + 1);
  if (rest === null || (rest !== "" && !/^ AS [a-z_][a-z0-9_]{0,30}$/.test(rest))) {
    throw new Error("scope fragment must be a closed (SELECT …) subquery");
  }
}

function register(scope: ScopeSql, fragment: string): string {
  const ctx = contextByHandle.get(scope);
  const fragments = ctx ? fragmentsByContext.get(ctx) : undefined;
  if (!fragments) throw new Error("restricted ScopeSql handle has no registry.");
  assertFragmentInvariants(fragment);
  fragments.add(fragment);
  return fragment;
}

function freezeHandle(value: { restricted: boolean; paths: readonly string[] | null; snapshot: ScopeSnapshot | null }): ScopeSql {
  const scope = Object.freeze({ ...value }) as unknown as ScopeSql;
  createdHandles.add(scope);
  return scope;
}

/** Restricted=false; registers nothing; every helper returns today's text. */
export const ALL_SCOPE_SQL: ScopeSql = freezeHandle({ restricted: false, paths: null, snapshot: null });

function scopablePaths(ctx: AccessContext): string[] {
  const funnel = ctx.scope.funnel;
  if (funnel.mode !== "selected") return [];
  const out = new Set<string>();
  for (const path of funnel.paths) {
    if (typeof path === "string" && path !== "unknown" && path.length <= SCOPE_PATH_MAX_LENGTH && SCOPE_PATH_RE.test(path)) out.add(path);
  }
  return [...out].sort();
}

/** The gate's constructor of a restricted handle (importer allowlist: AC/gate.ts).
 * `snapshot` is null for scope-ready actions that need none; helpers that read
 * fact tables then throw ScopeSnapshotNotReadyError("snapshot_missing"). */
export function createRestrictedScopeSql(ctx: AccessContext, snapshot: ScopeSnapshot | null): ScopeSql {
  if (!isIssuedAccessContext(ctx)) throw new Error("createRestrictedScopeSql requires an issued AccessContext.");
  if (!ctx.restricted) throw new Error("createRestrictedScopeSql is for funnel-restricted contexts only.");
  const scope = freezeHandle({ restricted: true, paths: Object.freeze(scopablePaths(ctx)), snapshot: snapshot ?? null });
  contextByHandle.set(scope, ctx);
  if (!fragmentsByContext.has(ctx)) fragmentsByContext.set(ctx, new Set());
  return scope;
}

// ---- small public helpers ---------------------------------------------------------------

/** ctx.scope.funnel.paths ∩ P (≠ 'unknown', ≤ 200 chars), sorted; [] for none / all. */
export function scopePaths(scope: ScopeSql): readonly string[] {
  return handle(scope).paths ?? [];
}

/** SQL-body string literal: hex contains no executable characters and never enters the URL. */
export function sqlStringLiteral(v: string): string {
  const bytes = new TextEncoder().encode(String(v));
  return `unhex('${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}')`;
}

/** Include-list intersection (R11): restricted members keep only in-scope values;
 * a non-empty list with nothing left becomes the sentinel (matches nothing). */
export function intersectIncludePaths(scope: ScopeSql, values: readonly string[]): { values: string[]; dropped: number } {
  const input = Array.isArray(values) ? [...values] : [];
  if (!handle(scope).restricted) return { values: input, dropped: 0 };
  const allowed = new Set(scopePaths(scope));
  const kept = input.filter((value) => typeof value === "string" && allowed.has(value));
  const dropped = input.length - kept.length;
  if (input.length > 0 && kept.length === 0) return { values: [OUT_OF_SCOPE_SENTINEL], dropped };
  return { values: kept, dropped };
}

/** An explicit cohort_key / funnel_key path outside the member's scope → 403
 * funnel_out_of_scope, before any SQL. No-op for all scope. */
export function assertKeyPathInScope(scope: ScopeSql, path: unknown): void {
  if (!handle(scope).restricted) return;
  const value = typeof path === "string" ? path.trim() : "";
  if (!value || !scopePaths(scope).includes(value)) throw new ScopeForbiddenError("funnel_out_of_scope");
}

/** Restricted FB reads exist only at campaign / adset / ad level → 403
 * scope_not_supported for account, day (and anything unrecognized). */
export function assertFbLevelInScope(scope: ScopeSql, level: string): void {
  if (!handle(scope).restricted) return;
  if (!RESTRICTED_FB_LEVELS.has(String(level))) throw new ScopeForbiddenError("scope_not_supported");
}

// ---- fragment builders ------------------------------------------------------------------

function checkAlias(alias: string | undefined): void {
  if (alias !== undefined && !ALIAS_RE.test(alias)) throw new Error(`invalid scope alias: ${alias}`);
}

function requireSnapshot(scope: ScopeSql): ScopeSnapshot {
  const snapshot = scope.snapshot;
  if (!snapshot || !snapshot.warehouseVersion || !snapshot.classificationVersion) throw new ScopeSnapshotNotReadyError("snapshot_missing");
  return snapshot;
}

function pathsPredicate(scope: ScopeSql): string {
  const paths = scopePaths(scope);
  return paths.length ? `campaign_path IN (${paths.map(sqlStringLiteral).join(", ")})` : "0";
}

/** WHERE predicates of the member's scoped users in fact_user_cohorts (SU). */
function scopedUserPredicates(scope: ScopeSql): string {
  const snapshot = requireSnapshot(scope);
  return `${TENANT} AND warehouse_version = ${sqlStringLiteral(snapshot.warehouseVersion)}` +
    ` AND classification_version = ${sqlStringLiteral(snapshot.classificationVersion)}` +
    ` AND ${pathsPredicate(scope)} AND NOT startsWith(canonical_user_id, 'unknown_user_')`;
}

function scopedUsersSql(scope: ScopeSql): string {
  return `SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL WHERE ${scopedUserPredicates(scope)}`;
}

const as = (alias: string | undefined) => (alias ? ` AS ${alias}` : "");

/** analytics_transactions. All: `analytics_transactions[ AS a] FINAL`. Restricted:
 * the scoped users' transactions (every one of them, for life). */
export function txFrom(scope: ScopeSql, alias?: string): string {
  checkAlias(alias);
  if (!handle(scope).restricted) return alias ? `${ANALYTICS_TRANSACTIONS_TABLE} AS ${alias} FINAL` : `${ANALYTICS_TRANSACTIONS_TABLE} FINAL`;
  return register(scope,
    `(SELECT ${TX_COLS.join(", ")} FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE ${TENANT} AND user_id IN (${scopedUsersSql(scope)}))${as(alias)}`);
}

/** fact_user_cohorts. All: `fact_user_cohorts[ AS fc] FINAL`. Restricted: the
 * scoped users' rows of the active snapshot only. */
export function cohortsFrom(scope: ScopeSql, alias?: string): string {
  checkAlias(alias);
  if (!handle(scope).restricted) return alias ? `${FACT_USER_COHORTS_TABLE} AS ${alias} FINAL` : `${FACT_USER_COHORTS_TABLE} FINAL`;
  return register(scope, `(SELECT ${FC_COLS.join(", ")} FROM ${FACT_USER_COHORTS_TABLE} FINAL WHERE ${scopedUserPredicates(scope)})${as(alias)}`);
}

/** The email-matched token source of the materialized Cohorts list (etok). All:
 * `analytics_transactions AS a FINAL`. Restricted: non-member transactions whose
 * email belongs to a scoped user — the "NOT IN every snapshot member" set (fcall)
 * lives inside this one fragment, so the list needs no unscoped fcall CTE (R-2). */
export function txEmailMatchedFrom(scope: ScopeSql, alias: string): string {
  if (alias === undefined || alias === null || alias === "") throw new Error("txEmailMatchedFrom requires an alias");
  checkAlias(alias);
  if (!handle(scope).restricted) return `${ANALYTICS_TRANSACTIONS_TABLE} AS ${alias} FINAL`;
  const snapshot = requireSnapshot(scope);
  const members = `SELECT canonical_user_id FROM ${FACT_USER_COHORTS_TABLE} FINAL WHERE ${TENANT}` +
    ` AND warehouse_version = ${sqlStringLiteral(snapshot.warehouseVersion)}` +
    ` AND classification_version = ${sqlStringLiteral(snapshot.classificationVersion)}`;
  const scopedEmails = `SELECT normalized_email FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE ${TENANT}` +
    ` AND normalized_email != '' AND user_id IN (${scopedUsersSql(scope)})`;
  return register(scope,
    `(SELECT ${TX_COLS.join(", ")} FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL WHERE ${TENANT} AND normalized_email != ''` +
    ` AND user_id NOT IN (${members}) AND normalized_email IN (${scopedEmails})) AS ${alias}`);
}

/** VIS: campaign ids resolved to exactly one of the member's paths in the active
 * snapshot's fact_campaign_scope, as a closed `(SELECT campaign_id …)` — used as
 * `campaign_id IN ${VIS}` or `FROM ${VIS}`. Restricted only. */
export function campaignScopeVisibleFrom(scope: ScopeSql): string {
  if (!handle(scope).restricted) throw new Error("campaignScopeVisibleFrom is for restricted scope only.");
  const snapshot = requireSnapshot(scope);
  if (!snapshot.campaignScopeReady) throw new ScopeSnapshotNotReadyError("campaign_scope_missing");
  return register(scope,
    `(SELECT campaign_id FROM ${FACT_CAMPAIGN_SCOPE_TABLE} FINAL WHERE ${TENANT}` +
    ` AND warehouse_version = ${sqlStringLiteral(snapshot.warehouseVersion)}` +
    ` AND classification_version = ${sqlStringLiteral(snapshot.classificationVersion)}` +
    ` AND scope_version = ${sqlStringLiteral(CAMPAIGN_SCOPE_VERSION)} AND status = 'resolved' AND ${pathsPredicate(scope)})`);
}

/** fact_facebook_stats. All: `allModeText` when given (the caller's current FROM,
 * e.g. a V2 compat view), else `fact_facebook_stats[ AS f] FINAL`. Restricted:
 * V1 rows of visible campaigns at campaign / adset / ad level only. */
export function fbFrom(scope: ScopeSql, level: ScopeFbLevel, alias?: string, allModeText?: string): string {
  checkAlias(alias);
  if (!handle(scope).restricted) {
    if (allModeText !== undefined) return allModeText;
    return alias ? `${FACT_FACEBOOK_STATS_TABLE} AS ${alias} FINAL` : `${FACT_FACEBOOK_STATS_TABLE} FINAL`;
  }
  assertFbLevelInScope(scope, level);
  const visible = campaignScopeVisibleFrom(scope);
  return register(scope,
    `(SELECT ${FB_COLS.join(", ")} FROM ${FACT_FACEBOOK_STATS_TABLE} FINAL WHERE ${TENANT}` +
    ` AND level IN ('campaign','adset','ad') AND trim(BOTH ' ' FROM campaign_id) IN ${visible})${as(alias)}`);
}

/** Support requests of the scoped users' emails (replaces `fact_support_requests
 * FINAL WHERE auth_user_id = …` in support_emails). Restricted only. */
export function supportEmailsFrom(scope: ScopeSql): string {
  if (!handle(scope).restricted) throw new Error("supportEmailsFrom is for restricted scope only.");
  return register(scope,
    `(SELECT normalized_email FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE ${TENANT}` +
    ` AND lowerUTF8(trim(BOTH ' ' FROM normalized_email)) IN (SELECT lowerUTF8(trim(BOTH ' ' FROM normalized_email))` +
    ` FROM ${FACT_USER_COHORTS_TABLE} FINAL WHERE ${scopedUserPredicates(scope)}))`);
}

/** "Does the tenant have any rows" probe (0 / 1) — replaces the tenant-wide
 * counts the data-status probes return to the owner. A whole statement; only
 * its closed `(SELECT 1 … LIMIT 1)` part is registered, so reusing it anywhere
 * else yields at most one constant row. Restricted only. */
export function presenceProbeSql(scope: ScopeSql, table: "fact_subscriptions" | "fact_support_requests"): string {
  if (!handle(scope).restricted) throw new Error("presenceProbeSql is for restricted scope only.");
  if (table !== "fact_subscriptions" && table !== "fact_support_requests") throw new Error(`presenceProbeSql: unsupported table ${String(table)}`);
  requireSnapshot(scope);
  const presence = register(scope, `(SELECT 1 FROM ${table} FINAL WHERE ${TENANT} LIMIT 1)`);
  return `SELECT count() AS c FROM ${presence} FORMAT JSONEachRow`;
}

/** The Media Buyer "utm:<value>" member predicate (cohortMembership.ts
 * activeCohortMemberWhere): `column IN (first-trial transactions with that
 * utm_source)`. Binds p_<prefix>_<i> into `params` exactly like bindList. */
export function trialUtmIn(scope: ScopeSql, column: string, values: readonly string[], prefix: string, params: Record<string, unknown>): string {
  if (!COLUMN_RE.test(column)) throw new Error(`invalid trialUtmIn column: ${column}`);
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid trialUtmIn prefix: ${prefix}`);
  const restricted = handle(scope).restricted;
  const placeholders = (Array.isArray(values) ? values : []).map((value, index) => {
    const key = `p_${prefix}_${index}`;
    params[key] = value;
    return `{${key}:String}`;
  });
  if (!placeholders.length) return "0";
  const source = restricted ? txFrom(scope) : `${ANALYTICS_TRANSACTIONS_TABLE} FINAL`;
  return `${column} IN (SELECT transaction_id FROM ${source} WHERE ${TENANT} AND utm_source IN (${placeholders.join(", ")}))`;
}

// ---- masking (importer allowlist: SH/scopedClient.ts) --------------------------------------

/** Replaces every fragment registered for `ctx` (longest first, all occurrences)
 * with ` __sf__ `. What remains of a restricted statement is checked by the
 * ScopedReader; fragments registered for another context are NOT masked. */
export function maskScopeFragments(ctx: AccessContext, sql: string): string {
  const fragments = fragmentsByContext.get(ctx);
  let masked = String(sql ?? "");
  if (!fragments || !fragments.size) return masked;
  for (const fragment of [...fragments].sort((a, b) => b.length - a.length)) {
    if (masked.includes(fragment)) masked = masked.split(fragment).join(" __sf__ ");
  }
  return masked;
}
