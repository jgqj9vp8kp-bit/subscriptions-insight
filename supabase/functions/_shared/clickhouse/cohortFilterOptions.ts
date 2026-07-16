// Cascading (dependent) filter options — shared by the materialized snapshot path
// (cohortMembership.ts) and the dynamic classifier fallback (cohorts.ts).
//
// RULE: every option list is scoped to the request's ACTIVE filters, with ONE
// exception per list — a dimension's own predicate is excluded from its own scope
// ("all active filters EXCEPT this one"). That lets the user switch values inside
// a dimension instead of locking the list to the currently selected value.
//
// One scan serves all dimensions: the caller supplies a per-user CTE (one row per
// cohort user, one value per dimension); `members` adds a pass flag per dimension
// and each UNION branch requires every OTHER dimension's flag.
//
// Counts are uniqExact(canonical_user_id) — distinct COHORT USERS, never
// transactions and never duplicated users.
//
// The date range is not a dimension (no dropdown of its own), so it applies to
// every list and belongs in the caller's base WHERE.
//
// NOT applied to option scope (reported in filters_ignored_for_options):
//   refund_status  — a cohort-GROUP-level HAVING over transaction aggregates
//                    (refund_raw of a cohort_date×funnel×campaign_path group),
//                    not a user attribute of the cohort-membership layer.
//   transaction_type — not a cohort-membership dimension.

import type {
  CohortFilterOptionDimensionDiagnostic,
  CohortFilterOptions,
  CohortFilterOptionsDiagnostics,
  CohortFilters,
  CohortOptionDimension,
} from "./cohortContract.ts";

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

interface OptionDimensionSpec {
  dim: CohortOptionDimension;
  /** Column name in the caller's per-user CTE. */
  column: string;
  values: (filters: CohortFilters) => string[];
}

// The dynamic fallback aliases its per-user CTE columns to these same names, so
// one spec list drives both engines.
export const OPTION_DIMENSIONS: OptionDimensionSpec[] = [
  { dim: "funnel", column: "funnel", values: (f) => f.funnel },
  { dim: "campaign_path", column: "campaign_path", values: (f) => f.campaign_path },
  { dim: "campaign_id", column: "campaign_id", values: (f) => f.campaign_id },
  { dim: "traffic_source", column: "traffic_source", values: (f) => f.traffic_source },
  { dim: "media_buyer", column: "media_buyer", values: (f) => f.media_buyer },
  { dim: "country", column: "country", values: (f) => f.country },
  { dim: "card_type", column: "card_type", values: (f) => f.card_type },
  { dim: "currency", column: "currency", values: (f) => f.currency },
  { dim: "price_plan", column: "price_plan", values: (f) => f.price_plan },
];

/** Row marker carrying the full-scope (ALL filters applied) distinct-user count. */
export const SCOPE_ROW_DIM = "_scope";

export function optionFiltersApplied(filters: CohortFilters, dateFrom: string | null, dateTo: string | null): string[] {
  const applied = OPTION_DIMENSIONS.filter((spec) => spec.values(filters).length > 0).map((spec) => spec.dim as string);
  if (dateFrom || dateTo) applied.push("date_range");
  return applied;
}

export function optionFiltersIgnored(filters: CohortFilters): string[] {
  const ignored: string[] = [];
  if (filters.refund_status !== "all") ignored.push("refund_status");
  if (filters.transaction_type.length > 0) ignored.push("transaction_type");
  return ignored;
}

/**
 * SELECT list for the `members` CTE: one UInt8 pass flag per dimension. Values are
 * bound as numbered {o_<dim>_<i>:String} params — never string-interpolated.
 */
export function optionFlagColumns(filters: CohortFilters, params: Record<string, unknown>): string {
  return OPTION_DIMENSIONS.map((spec) => {
    const values = spec.values(filters);
    if (!values.length) return `1 AS m_${spec.dim}`;
    const placeholders = values.map((value, index) => {
      const key = `o_${spec.dim}_${index}`;
      params[key] = value;
      return `{${key}:String}`;
    });
    return `(${spec.column} IN (${placeholders.join(", ")})) AS m_${spec.dim}`;
  }).join(",\n    ");
}

/** WHERE over the pass flags requiring every ACTIVE dimension except `self`. */
export function optionWhereExcept(filters: CohortFilters, self: CohortOptionDimension | null): string {
  const others = OPTION_DIMENSIONS
    .filter((spec) => spec.dim !== self && spec.values(filters).length > 0)
    .map((spec) => `m_${spec.dim} = 1`);
  return others.length ? `WHERE ${others.join(" AND ")}` : "";
}

/** One UNION ALL branch per dimension (self-excluded) + the full-scope count row. */
export function optionBranches(filters: CohortFilters, membersCte = "members"): string {
  const branches = OPTION_DIMENSIONS.map((spec) =>
    `SELECT '${spec.dim}' dim, ${spec.column} value, uniqExact(canonical_user_id) cnt ` +
    `FROM ${membersCte} ${optionWhereExcept(filters, spec.dim)} GROUP BY ${spec.column}`
  );
  branches.push(
    `SELECT '${SCOPE_ROW_DIM}' dim, '${SCOPE_ROW_DIM}' value, uniqExact(canonical_user_id) cnt ` +
    `FROM ${membersCte} ${optionWhereExcept(filters, null)}`,
  );
  return branches.join("\nUNION ALL ");
}

export interface FilterOptionsResult {
  options: CohortFilterOptions;
  scope_user_count: number;
  dimensions: CohortFilterOptionDimensionDiagnostic[];
}

export function emptyFilterOptions(): CohortFilterOptions {
  return {
    funnel: [],
    campaign_path: [],
    traffic_source: [],
    price_plan: [],
    currency: [],
    campaign_id: [],
    country: [],
    card_type: [],
    media_buyer: [],
  };
}

// Empty values are dropped from the option LISTS here (not in SQL), so each
// dimension's scope_user_count still counts every user in that scope. Each user
// has exactly one value per dimension, so the per-group uniqExact counts are
// disjoint and sum to the scope's distinct-user count.
export function filterOptionsFromRows(
  rows: Array<{ dim?: string; value?: string; cnt?: number | string }>,
  appliedFilters: string[] = [],
): FilterOptionsResult {
  const opts = emptyFilterOptions();
  const scopeCounts = new Map<string, number>();
  let scopeUserCount = 0;

  for (const row of rows) {
    const dim = s(row.dim);
    const value = s(row.value);
    const cnt = n(row.cnt);
    if (dim === SCOPE_ROW_DIM) {
      scopeUserCount = cnt;
      continue;
    }
    scopeCounts.set(dim, (scopeCounts.get(dim) ?? 0) + cnt);
    if (!value) continue;
    if (dim === "funnel") opts.funnel.push(value);
    else if (dim === "campaign_path") opts.campaign_path.push(value);
    else if (dim === "campaign_id") opts.campaign_id.push({ campaign_id: value, campaign_name: null, trial_count: cnt });
    else if (dim === "traffic_source") opts.traffic_source.push(value);
    else if (dim === "price_plan") opts.price_plan.push(value);
    else if (dim === "currency") opts.currency.push(value);
    else if (dim === "country") opts.country.push({ country_code: value, user_count: cnt });
    else if (dim === "card_type") opts.card_type.push({ card_type: value, trial_count: cnt });
    else if (dim === "media_buyer") opts.media_buyer.push({ media_buyer: value, trial_count: cnt });
  }

  opts.funnel.sort();
  opts.campaign_path.sort();
  opts.traffic_source.sort();
  opts.price_plan.sort();
  opts.currency.sort();
  opts.campaign_id.sort((a, b) => b.trial_count - a.trial_count);
  opts.country.sort((a, b) => a.country_code.localeCompare(b.country_code));
  opts.card_type.sort((a, b) => b.trial_count - a.trial_count);
  opts.media_buyer.sort((a, b) => b.trial_count - a.trial_count);

  const dimensions: CohortFilterOptionDimensionDiagnostic[] = OPTION_DIMENSIONS.map((spec) => ({
    dimension: spec.dim,
    excluded_dimension: spec.dim,
    filters_applied: appliedFilters.filter((name) => name !== spec.dim),
    option_count: (opts[spec.dim] as unknown[]).length,
    scope_user_count: scopeCounts.get(spec.dim) ?? 0,
  }));

  return { options: opts, scope_user_count: scopeUserCount, dimensions };
}

export function optionsDiagnostics(input: {
  filters: CohortFilters;
  dateFrom: string | null;
  dateTo: string | null;
  result: FilterOptionsResult;
  queryDurationMs: number;
  source: CohortFilterOptionsDiagnostics["source"];
}): CohortFilterOptionsDiagnostics {
  return {
    source: input.source,
    filters_applied_to_options: optionFiltersApplied(input.filters, input.dateFrom, input.dateTo),
    filters_ignored_for_options: optionFiltersIgnored(input.filters),
    option_scope_user_count: input.result.scope_user_count,
    query_duration_ms: input.queryDurationMs,
    dimensions: input.result.dimensions,
  };
}
