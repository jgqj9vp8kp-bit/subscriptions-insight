// Funnel path coverage (access Phase 2, spec §6 contract 8): how much of the
// ACTIVE cohort snapshot the funnel registry can attribute. A funnel-restricted
// member sees only users anchored to a granted path of their funnels, so every
// campaign_path no funnel holds is invisible to all of them (plan §5
// "unregistered"). Admin → Funnel coverage reads this through the `access`
// function (paths.coverage) before any restricted member is enabled.
//
//   * PATH_COVERAGE_SQL: one read-only statement per call — users, synthetic
//     users, net revenue (lifetime, by acquisition anchor) and cohort dates per
//     anchor campaign_path, plus users anchored after a path was retired.
//     It names the protected tables directly, so it runs in ALL-SCOPE mode only
//     (a restricted ScopedReader refuses it); the caller checks the scope first.
//   * buildFunnelCoverage: the pure diff of those rows against funnel_paths
//     (granted = active ∪ retired; unscopable = not canonical, '' or 'unknown',
//     never grantable).
//   * coverageSnapshot: which snapshot the numbers come from, and whether it is
//     current by the gate's own freshness rule (cohortSnapshotState.ts).
//
// Pure apart from the one query: no Deno APIs, no remote imports.

import type { ClickHouseClientLike } from "./types.ts";
import {
  activeSnapshotCurrent,
  restrictedSnapshotReadiness,
  SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT,
  type CohortSnapshotState,
} from "./cohortSnapshotState.ts";
import { SCOPE_PATH_RE } from "./scopeSql.ts";

export type FunnelPathStatus = "proposed" | "active" | "retired" | "revoked";
export type PathCoverageState = "granted" | "proposed" | "unregistered" | "unscopable";

/** Statuses that grant access (app.funnel_scope_paths). */
export const GRANTED_PATH_STATUSES: ReadonlySet<FunnelPathStatus> = new Set<FunnelPathStatus>(["active", "retired"]);

/** Max rows of PATH_COVERAGE_SQL (busiest paths first). */
export const PATH_COVERAGE_LIMIT = 5000;

/** Param value bound when no path is retired: transform() then maps nothing,
 * and this pair maps '' to the same never-reached date as the default. */
const NO_RETIRED_PATH = "";
const NEVER_DATE = "2149-06-06";

export const PATH_COVERAGE_SQL = `
SELECT fc.campaign_path path, uniqExactIf(fc.canonical_user_id, NOT startsWith(fc.canonical_user_id,'unknown_user_')) users,
  uniqExactIf(fc.canonical_user_id, startsWith(fc.canonical_user_id,'unknown_user_')) synthetic_users,
  min(fc.cohort_date) first_cohort, max(fc.cohort_date) last_cohort,
  sum(t.net) net_revenue,
  uniqExactIf(fc.canonical_user_id, fc.cohort_date >= transform(fc.campaign_path,{retired_paths:Array(String)},{retired_since:Array(Date)},toDate('${NEVER_DATE}'))) users_since_retired
FROM (SELECT canonical_user_id, campaign_path, cohort_date FROM fact_user_cohorts FINAL WHERE auth_user_id={auth_user_id:String}
      AND warehouse_version={warehouse_version:String} AND classification_version={classification_version:String}) fc
LEFT JOIN (SELECT user_id, sumIf(gross_amount_usd, is_success=1) - sum(refund_amount_usd) net FROM analytics_transactions FINAL
      WHERE auth_user_id={auth_user_id:String} GROUP BY user_id) t ON t.user_id = fc.canonical_user_id
GROUP BY path ORDER BY users DESC LIMIT ${PATH_COVERAGE_LIMIT} FORMAT JSONEachRow
`;

/** One anchor campaign_path of the active snapshot. */
export interface PathCoverageRow {
  path: string;
  /** Real (non-synthetic) users anchored to the path. */
  users: number;
  /** `unknown_user_%` ids: never visible to a restricted member. */
  synthetic_users: number;
  /** Lifetime net revenue (USD) of every user anchored here, synthetic included. */
  net_revenue: number;
  first_cohort_date: string | null;
  last_cohort_date: string | null;
  /** Users with cohort_date ≥ the path's retirement date (0 unless retired). */
  users_since_retired: number;
}

/** A funnel_paths row as the coverage diff needs it. */
export interface CoverageRegistryPath {
  id: string;
  funnel_id: string;
  path: string;
  status: FunnelPathStatus;
  retired_at: string | null;
}

export interface FunnelCoverageSnapshot {
  status: "current" | "stale";
  warehouse_version: string;
  generated_at: string | null;
}

export interface FunnelCoveragePath {
  path: string;
  users: number;
  synthetic_users: number;
  net_revenue: number;
  first_cohort_date: string | null;
  last_cohort_date: string | null;
  state: PathCoverageState;
  /** The granting row (state granted), else null. */
  funnel_id: string | null;
  path_id: string | null;
  /** The granting row's status, else "proposed" / "revoked" when only such rows exist. */
  path_status: FunnelPathStatus | null;
  /** Every proposed row for this path (a granted path may still have some). */
  proposals: Array<{ path_id: string; funnel_id: string }>;
  /** Only for a retired grant: users anchored since it was retired. */
  users_since_retired: number | null;
}

/** paths.coverage → 200 (SHARED CONTRACT 8). A type alias (not an interface)
 * so it is a plain JSON record for the handler. */
export type FunnelCoverage = {
  ok: true;
  snapshot: FunnelCoverageSnapshot;
  totals: {
    users: number;
    synthetic_users: number;
    registered_users: number;
    registered_pct: number;
    net_revenue: number;
    registered_net_revenue: number;
  };
  paths: FunnelCoveragePath[];
  /** Retired grants that still collect new users (the path may have been reused). */
  reuse_alerts: Array<{ path: string; funnel_id: string; path_id: string; retired_at: string; users_since_retired: number }>;
  funnels: Array<{ funnel_id: string; users: number; net_revenue: number; granted_paths: number }>;
  /** Funnel ids whose granted paths hold no user of the snapshot. */
  registry_without_data: string[];
};

// ---- helpers ------------------------------------------------------------------------

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** Share in percent, floored to 2 decimals so anything short of full coverage
 * never displays as 100; an empty snapshot has nothing unregistered (100). */
function percent(part: number, whole: number): number {
  if (whole <= 0) return 100;
  return Math.floor((part / whole) * 10_000) / 100;
}

/** A path a funnel can hold (funnel_paths CHECK): canonical, not 'unknown', ≤ 200. */
export function isScopablePath(path: string): boolean {
  return path !== "unknown" && path.length <= 200 && SCOPE_PATH_RE.test(path);
}

/** ClickHouse text form of an Array(String) / Array(Date) query parameter: the
 * transport sends every param as String(value), so arrays go pre-rendered. */
export function clickHouseArrayParam(values: readonly string[]): string {
  return `[${values.map((value) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`).join(",")}]`;
}

/** YYYY-MM-DD (UTC) of a timestamp or date, null when unparsable. */
function utcDate(value: string): string | null {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed).toISOString().slice(0, 10);
  return date > NEVER_DATE ? NEVER_DATE : date;
}

/** One entry per retired path (earliest date wins), sorted; never empty. */
function retiredParams(retired: ReadonlyArray<{ path: string; since: string }>): Array<{ path: string; since: string }> {
  const earliest = new Map<string, string>();
  for (const entry of retired) {
    const since = typeof entry?.since === "string" ? utcDate(entry.since) : null;
    if (typeof entry?.path !== "string" || !entry.path || !since) continue;
    const current = earliest.get(entry.path);
    if (!current || since < current) earliest.set(entry.path, since);
  }
  const list = [...earliest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, since]) => ({ path, since }));
  return list.length ? list : [{ path: NO_RETIRED_PATH, since: NEVER_DATE }];
}

function parseCoverageRow(raw: unknown): PathCoverageRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  return {
    path: typeof row.path === "string" ? row.path : String(row.path ?? ""),
    users: num(row.users),
    synthetic_users: num(row.synthetic_users),
    net_revenue: num(row.net_revenue),
    first_cohort_date: dateText(row.first_cohort),
    last_cohort_date: dateText(row.last_cohort),
    users_since_retired: num(row.users_since_retired),
  };
}

// ---- the query ------------------------------------------------------------------------

/** Runs PATH_COVERAGE_SQL over the active snapshot versions. `clickhouse` is the
 * request's ScopedReader in all-scope mode; errors (ScopeViolation included)
 * propagate to the caller. */
export async function runPathCoverage(input: {
  clickhouse: ClickHouseClientLike;
  authUserId: string;
  active: { warehouse_version: string; classification_version: string };
  retired: ReadonlyArray<{ path: string; since: string }>;
}): Promise<PathCoverageRow[]> {
  const retired = retiredParams(input.retired);
  const result = await input.clickhouse.query({
    query: PATH_COVERAGE_SQL,
    query_params: {
      auth_user_id: input.authUserId,
      warehouse_version: input.active.warehouse_version,
      classification_version: input.active.classification_version,
      retired_paths: clickHouseArrayParam(retired.map((entry) => entry.path)),
      retired_since: clickHouseArrayParam(retired.map((entry) => entry.since)),
    },
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return (Array.isArray(rows) ? rows : []).map(parseCoverageRow).filter((row): row is PathCoverageRow => row !== null);
}

// ---- snapshot --------------------------------------------------------------------------

/** SCOPE_SNAPSHOT_MAX_STALENESS_HOURS (the gate's freshness bound, not a
 * secret), default 6 h. Read through globalThis so vitest can import the module. */
export function coverageMaxStalenessMs(): number {
  const env = globalThis as { Deno?: { env?: { get?: (name: string) => string | undefined } }; process?: { env?: Record<string, string | undefined> } };
  const raw = env.Deno?.env?.get?.("SCOPE_SNAPSHOT_MAX_STALENESS_HOURS") ?? env.process?.env?.SCOPE_SNAPSHOT_MAX_STALENESS_HOURS;
  const hours = Number(raw ?? SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT);
  return (Number.isFinite(hours) && hours > 0 ? hours : SCOPE_SNAPSHOT_MAX_STALENESS_HOURS_DEFAULT) * 3_600_000;
}

/** The active snapshot coverage is computed from, or null when there is no
 * validated active snapshot (the caller answers 409 conflict). `current` means a
 * restricted read would be served right now (same rule as the gate) with no
 * newer warehouse version observed; anything else is `stale`. */
export function coverageSnapshot(
  state: CohortSnapshotState | null,
  o: { now: Date; maxStalenessMs: number },
): { active: { warehouse_version: string; classification_version: string }; snapshot: FunnelCoverageSnapshot } | null {
  if (!state?.active_warehouse_version || !state.active_classification_version) return null;
  const active = { warehouse_version: state.active_warehouse_version, classification_version: state.active_classification_version };
  if (!activeSnapshotCurrent(state, active)) return null;
  const readiness = restrictedSnapshotReadiness(state, { now: o.now, maxStalenessMs: o.maxStalenessMs, needsCampaignScope: false });
  const current = readiness.ok === true && readiness.snapshot.staleSince === null;
  return {
    active,
    snapshot: { status: current ? "current" : "stale", warehouse_version: active.warehouse_version, generated_at: state.active_generated_at ?? null },
  };
}

// ---- the registry diff ------------------------------------------------------------------

const STATUS_RANK: Readonly<Record<FunnelPathStatus, number>> = { active: 0, retired: 1, proposed: 2, revoked: 3 };

function byIdThenFunnel(a: { id: string; funnel_id: string }, b: { id: string; funnel_id: string }): number {
  return num(a.id) - num(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.funnel_id < b.funnel_id ? -1 : a.funnel_id > b.funnel_id ? 1 : 0);
}

/** Diffs the coverage rows against the registry (every funnel_paths row of every
 * funnel, any status). Paths are listed busiest first; funnels by users. */
export function buildFunnelCoverage(input: {
  rows: readonly PathCoverageRow[];
  funnels: ReadonlyArray<{ id: string; paths: readonly CoverageRegistryPath[] }>;
  snapshot: FunnelCoverageSnapshot;
}): FunnelCoverage {
  const registryByPath = new Map<string, CoverageRegistryPath[]>();
  for (const funnel of input.funnels) {
    for (const entry of funnel.paths ?? []) {
      const row = { ...entry, funnel_id: entry.funnel_id || funnel.id };
      const list = registryByPath.get(row.path) ?? [];
      list.push(row);
      registryByPath.set(row.path, list);
    }
  }
  for (const list of registryByPath.values()) list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byIdThenFunnel(a, b));

  const rows = [...input.rows].sort((a, b) => b.users - a.users || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const rowByPath = new Map<string, PathCoverageRow>();
  for (const row of rows) if (!rowByPath.has(row.path)) rowByPath.set(row.path, row);

  const paths: FunnelCoveragePath[] = [];
  const reuseAlerts: FunnelCoverage["reuse_alerts"] = [];
  let users = 0;
  let syntheticUsers = 0;
  let netRevenue = 0;
  let registeredUsers = 0;
  let registeredNet = 0;

  for (const row of rowByPath.values()) {
    const registry = isScopablePath(row.path) ? registryByPath.get(row.path) ?? [] : [];
    const grant = registry.find((entry) => GRANTED_PATH_STATUSES.has(entry.status)) ?? null;
    const proposals = registry.filter((entry) => entry.status === "proposed").map((entry) => ({ path_id: entry.id, funnel_id: entry.funnel_id }));
    const revoked = registry.some((entry) => entry.status === "revoked");
    const state: PathCoverageState = !isScopablePath(row.path) ? "unscopable" : grant ? "granted" : proposals.length ? "proposed" : "unregistered";
    const retiredGrant = grant?.status === "retired";

    users += row.users;
    syntheticUsers += row.synthetic_users;
    netRevenue += row.net_revenue;
    if (grant) {
      registeredUsers += row.users;
      registeredNet += row.net_revenue;
    }

    paths.push({
      path: row.path,
      users: row.users,
      synthetic_users: row.synthetic_users,
      net_revenue: cents(row.net_revenue),
      first_cohort_date: row.first_cohort_date,
      last_cohort_date: row.last_cohort_date,
      state,
      funnel_id: grant?.funnel_id ?? null,
      path_id: grant?.id ?? null,
      path_status: grant?.status ?? (proposals.length ? "proposed" : revoked ? "revoked" : null),
      proposals,
      users_since_retired: retiredGrant ? row.users_since_retired : null,
    });
    if (grant && retiredGrant && grant.retired_at && row.users_since_retired > 0) {
      reuseAlerts.push({ path: row.path, funnel_id: grant.funnel_id, path_id: grant.id, retired_at: grant.retired_at, users_since_retired: row.users_since_retired });
    }
  }

  const funnels = input.funnels
    .map((funnel) => {
      const granted = [...new Set((funnel.paths ?? []).filter((entry) => GRANTED_PATH_STATUSES.has(entry.status)).map((entry) => entry.path))];
      let funnelUsers = 0;
      let funnelNet = 0;
      for (const path of granted) {
        const row = rowByPath.get(path);
        if (!row) continue;
        funnelUsers += row.users;
        funnelNet += row.net_revenue;
      }
      return { funnel_id: funnel.id, users: funnelUsers, net_revenue: cents(funnelNet), granted_paths: granted.length };
    })
    .sort((a, b) => b.users - a.users || (a.funnel_id < b.funnel_id ? -1 : a.funnel_id > b.funnel_id ? 1 : 0));

  return {
    ok: true,
    snapshot: { ...input.snapshot },
    totals: {
      users,
      synthetic_users: syntheticUsers,
      registered_users: registeredUsers,
      registered_pct: percent(registeredUsers, users),
      net_revenue: cents(netRevenue),
      registered_net_revenue: cents(registeredNet),
    },
    paths,
    reuse_alerts: reuseAlerts,
    funnels,
    registry_without_data: funnels
      .filter((funnel) => funnel.users === 0)
      .map((funnel) => funnel.funnel_id)
      .sort(),
  };
}
