// Cohorts "Product" filter (2026-10-18). A product is the FunnelFox project the
// cohort's funnel belongs to (metadata.ff_project_id: Azora, Brainza, FoxIQ, …).
//
// It is NOT a new cohort dimension: since the Brainza path prefix
// (palmerTransform.ts withProjectPathPrefix, migration 202610180001) every
// campaign_path belongs to exactly one project, so a product resolves to the
// set of its campaign paths and the browser filters by those paths through the
// existing campaign_path filter (snapshot, scope and fallback engines unchanged).
// This module only serves that path -> project map, read from the successful
// transactions that carry FunnelFox metadata. A path seen under two projects is
// listed under both (it then filters as a path, not as a project).
//
// Full scope only: the project lives in normalized_payload, which a restricted
// member's scoped subquery never exposes (scopeSql.ts TX_COLS), so the action is
// not scopeReady and the gate refuses restricted members before any SQL.

import type { ClickHouseClientLike } from "./types.ts";
import { txFrom, type ScopeSql } from "./scopeSql.ts";

export interface CohortProductOption {
  /** FunnelFox project id; "" groups the cohorts without FunnelFox metadata. */
  project_id: string;
  /** Display name derived from the project's landing domain. */
  label: string;
  /** The project's most used landing host ("" when unknown). */
  host: string;
  /** Distinct trial users across the project's paths. */
  trial_count: number;
  campaign_paths: string[];
}

export interface CohortProductsResponse {
  ok: true;
  source: "clickhouse";
  generated_at: string;
  query_duration_ms: number;
  products: CohortProductOption[];
}

export interface CohortProductPathRow {
  path?: string;
  project_id?: string;
  host?: string;
  trial_users?: number | string;
  tx_rows?: number | string;
}

export const UNKNOWN_PRODUCT_LABEL = "Unknown";
const FUNNELFOX_DEFAULT_DOMAIN = ".fnlfx.com";

export function buildCohortProductPathsQuery(scope: ScopeSql): string {
  if (scope.restricted) throw new Error("Cohort products are served for full scope only.");
  return `SELECT
  if(campaign_path = '', 'unknown', campaign_path) AS path,
  JSONExtractString(normalized_payload, 'metadata', 'ff_project_id') AS project_id,
  lower(domain(JSONExtractString(normalized_payload, 'metadata', 'initialUrl'))) AS host,
  uniqExactIf(user_id, is_trial = 1) AS trial_users,
  count() AS tx_rows
FROM ${txFrom(scope)}
WHERE auth_user_id = {auth_user_id:String} AND is_success = 1
GROUP BY path, project_id, host`;
}

/** "f.azora-astro.com" -> "azora-astro.com"; the FunnelFox default domain keeps
 * its full host (its first label is the only distinctive part). */
export function productLabelFromHost(host: string): string {
  const value = host.trim().toLowerCase();
  if (!value) return "";
  if (value.endsWith(FUNNELFOX_DEFAULT_DOMAIN)) return value;
  const parts = value.split(".").filter(Boolean);
  return parts.length >= 3 ? parts.slice(1).join(".") : value;
}

const num = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function productsFromRows(rows: CohortProductPathRow[]): CohortProductOption[] {
  // Paths that carry a project somewhere: their metadata-less rows (MIT
  // renewals, payments of an older import) must not drag them into "Unknown".
  const pathsWithProject = new Set(
    rows.filter((row) => String(row.project_id ?? "").trim()).map((row) => String(row.path ?? "").trim()),
  );
  const byProject = new Map<string, { paths: Set<string>; trials: number; hostRows: Map<string, number> }>();
  for (const row of rows) {
    const path = String(row.path ?? "").trim();
    const projectId = String(row.project_id ?? "").trim();
    if (!path || (!projectId && pathsWithProject.has(path))) continue;
    const entry = byProject.get(projectId) ?? { paths: new Set<string>(), trials: 0, hostRows: new Map<string, number>() };
    entry.paths.add(path);
    entry.trials += num(row.trial_users);
    const host = String(row.host ?? "").trim().toLowerCase();
    if (host) entry.hostRows.set(host, (entry.hostRows.get(host) ?? 0) + num(row.tx_rows));
    byProject.set(projectId, entry);
  }

  const products: CohortProductOption[] = [];
  for (const [projectId, entry] of byProject) {
    const hosts = [...entry.hostRows.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const preferred = hosts.find(([host]) => !host.endsWith(FUNNELFOX_DEFAULT_DOMAIN)) ?? hosts[0];
    const host = projectId ? preferred?.[0] ?? "" : "";
    const label = !projectId
      ? UNKNOWN_PRODUCT_LABEL
      : productLabelFromHost(host) || `Project ${projectId.slice(-6)}`;
    products.push({
      project_id: projectId,
      label,
      host,
      trial_count: entry.trials,
      campaign_paths: [...entry.paths].sort(),
    });
  }
  // Busiest first; the metadata-less bucket always last.
  return products.sort((a, b) =>
    Number(a.project_id === "") - Number(b.project_id === "") || b.trial_count - a.trial_count || a.label.localeCompare(b.label),
  );
}

export async function runCohortProducts(input: {
  authUserId: string;
  clickhouse: ClickHouseClientLike;
  scope: ScopeSql;
}): Promise<CohortProductsResponse> {
  const started = Date.now();
  const rs = await input.clickhouse.query({
    query: buildCohortProductPathsQuery(input.scope),
    query_params: { auth_user_id: input.authUserId },
    format: "JSONEachRow",
  });
  const rows = (await rs.json()) as CohortProductPathRow[];
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    products: productsFromRows(rows),
  };
}
