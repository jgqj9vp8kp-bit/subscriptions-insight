// Cascading (dependent) Cohorts filter options.
//
// The regression these tests lock down: the options SQL took no filters at all, so
// every dropdown showed the project-wide list (selecting campaign_path=soulmate-sketch
// still listed every GEO in the project).
//
// These tests do NOT assert on SQL strings. They EVALUATE the SQL the builders
// actually emit: `evaluateOptionsSql` parses the per-dimension pass flags out of the
// generated `members` CTE, parses each UNION branch's WHERE/GROUP BY, and runs them
// over an in-memory cohort-membership fixture. So a builder that silently drops a
// predicate fails here exactly as it would against ClickHouse.

import { describe, expect, it } from "vitest";
import {
  buildMaterializedFilterOptionsQuery,
  runMaterializedCohortOptions,
} from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { buildFilterOptionsQuery } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import {
  filterOptionsFromRows,
  optionFiltersApplied,
  optionFiltersIgnored,
} from "../../supabase/functions/_shared/clickhouse/cohortFilterOptions.ts";
import { normalizeCohortRequest } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import type {
  CohortFilters,
  CohortRequest,
} from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

// ---- Fixture: one row per cohort user (the fact_user_cohorts shape) ---------

interface MemberRow {
  canonical_user_id: string;
  cohort_date: string;
  funnel: string;
  campaign_path: string;
  campaign_id: string;
  traffic_source: string;
  media_buyer: string;
  country: string;
  card_type: string;
  currency: string;
  price_plan: string;
}

function member(id: string, over: Partial<MemberRow> = {}): MemberRow {
  return {
    canonical_user_id: id,
    cohort_date: "2026-06-01",
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    campaign_id: "cid_1",
    traffic_source: "facebook",
    media_buyer: "Alex",
    country: "US",
    card_type: "visa",
    currency: "USD",
    price_plan: "$9.99",
    ...over,
  };
}

// soulmate/soulmate-sketch users are US+CA only. The other funnel/path carries the
// GEOs that must NOT appear once soulmate-sketch is selected.
const MEMBERS: MemberRow[] = [
  member("u1", { country: "US", card_type: "visa", media_buyer: "Alex" }),
  member("u2", { country: "US", card_type: "mastercard", media_buyer: "Alex" }),
  member("u3", { country: "CA", card_type: "visa", media_buyer: "Jamie", currency: "CAD" }),
  member("u4", { funnel: "soulmate", campaign_path: "soulmate-quiz", country: "DE", currency: "EUR" }),
  member("u5", { funnel: "soulmate", campaign_path: "soulmate-quiz", country: "BR" }),
  member("u6", { funnel: "astro", campaign_path: "astro-natal", country: "AE", campaign_id: "cid_9", media_buyer: "Sam" }),
  member("u7", { funnel: "astro", campaign_path: "astro-natal", country: "AR", campaign_id: "cid_9" }),
  member("u8", { funnel: "astro", campaign_path: "astro-natal", country: "AU", campaign_id: "cid_9" }),
  // Same user id must never be double-counted across its own row (uniqExact).
  member("u9", { country: "CA", cohort_date: "2026-06-20", card_type: "", media_buyer: "" }),
];

// ---- A tiny evaluator for the SQL the builders emit -------------------------

const DIMENSIONS = [
  "funnel", "campaign_path", "campaign_id", "traffic_source",
  "media_buyer", "country", "card_type", "currency", "price_plan",
] as const;

function resolveParams(list: string, params: Record<string, unknown>): string[] {
  return [...list.matchAll(/\{(\w+):String\}/g)].map(([, key]) => {
    if (!(key in params)) throw new Error(`SQL referenced unbound param {${key}:String}`);
    return String(params[key]);
  });
}

/** Parse + run the generated options SQL over the fixture. */
function evaluateOptionsSql(sql: string, params: Record<string, unknown>, rows: MemberRow[]) {
  // The dynamic fallback emits the classifier CTEs before `members`, so anchor on
  // the members CTE itself rather than the first closing paren in the statement.
  const [cteBlock, branchBlock] = (() => {
    const start = sql.indexOf("members AS (");
    if (start < 0) throw new Error("Could not locate the members CTE.");
    const end = sql.indexOf("\n)\n", start);
    if (end < 0) throw new Error("Could not locate the end of the members CTE.");
    return [sql.slice(start, end), sql.slice(end + 3)];
  })();

  // 1. Pass flags: `(<col> IN (<params>)) AS m_<dim>` or `1 AS m_<dim>`.
  const flags = new Map<string, (row: MemberRow) => boolean>();
  for (const [, column, values, dim] of cteBlock.matchAll(/\((\w+) IN \(([^)]*)\)\) AS m_(\w+)/g)) {
    const allowed = new Set(resolveParams(values, params));
    flags.set(dim, (row) => allowed.has(String(row[column as keyof MemberRow] ?? "")));
  }
  for (const [, dim] of cteBlock.matchAll(/\s1 AS m_(\w+)/g)) {
    if (!flags.has(dim)) flags.set(dim, () => true);
  }
  const missing = DIMENSIONS.filter((dim) => !flags.has(dim));
  if (missing.length) throw new Error(`members CTE is missing pass flags: ${missing.join(", ")}`);

  // 2. Base WHERE date range (applies to every dimension).
  const from = cteBlock.match(/(?:toString\()?cohort_date\)? >= \{(\w+):String\}/);
  const to = cteBlock.match(/(?:toString\()?cohort_date\)? <= \{(\w+):String\}/);
  const inDateRange = (row: MemberRow) =>
    (!from || row.cohort_date >= String(params[from[1]])) && (!to || row.cohort_date <= String(params[to[1]]));
  const base = rows.filter(inDateRange);

  // 3. One branch per dimension + the `_scope` row.
  const out: Array<{ dim: string; value: string; cnt: number }> = [];
  for (const chunk of branchBlock.split(/UNION ALL/)) {
    const head = chunk.match(/SELECT '(\w+)' dim, (?:'_scope'|(\w+)) value/);
    if (!head) continue;
    const dim = head[1];
    const column = head[2];
    const required = [...chunk.matchAll(/m_(\w+) = 1/g)].map(([, d]) => d);
    const scoped = base.filter((row) => required.every((d) => flags.get(d)!(row)));

    if (dim === "_scope") {
      out.push({ dim, value: "_scope", cnt: new Set(scoped.map((r) => r.canonical_user_id)).size });
      continue;
    }
    const groups = new Map<string, Set<string>>();
    for (const row of scoped) {
      const value = String(row[column as keyof MemberRow] ?? "");
      if (!groups.has(value)) groups.set(value, new Set());
      groups.get(value)!.add(row.canonical_user_id);
    }
    for (const [value, users] of groups) out.push({ dim, value, cnt: users.size });
  }
  return out;
}

const ACTIVE = { warehouse_version: "wh_1", classification_version: "cv_1" };

/** Run the materialized options path for a request and map to the API shape. */
function optionsFor(filters: Partial<CohortFilters> = {}, dates: { date_from?: string; date_to?: string } = {}) {
  const nreq = normalizeCohortRequest({ action: "options", ...dates, filters } as CohortRequest);
  const params: Record<string, unknown> = { auth_user_id: "auth_1" };
  const sql = buildMaterializedFilterOptionsQuery(nreq, ACTIVE, params);
  const rows = evaluateOptionsSql(sql, params, MEMBERS);
  return filterOptionsFromRows(rows, optionFiltersApplied(nreq.filters, nreq.dateFrom, nreq.dateTo));
}

const geo = (result: ReturnType<typeof optionsFor>) => result.options.country.map((c) => c.country_code);

// ---- The cascade -----------------------------------------------------------

describe("cohort filter options — cascading scope", () => {
  it("returns the project-wide lists when no filter is active", () => {
    const result = optionsFor();
    expect(geo(result)).toEqual(["AE", "AR", "AU", "BR", "CA", "DE", "US"]);
    expect(result.options.campaign_path).toEqual(["astro-natal", "soulmate-quiz", "soulmate-sketch"]);
    expect(result.options.funnel).toEqual(["astro", "soulmate"]);
    expect(result.scope_user_count).toBe(MEMBERS.length);
  });

  it("Funnel narrows Campaign Path", () => {
    expect(optionsFor({ funnel: ["soulmate"] }).options.campaign_path).toEqual(["soulmate-quiz", "soulmate-sketch"]);
  });

  it("Funnel narrows GEO to a subset of the project-wide list", () => {
    const all = geo(optionsFor());
    const scoped = geo(optionsFor({ funnel: ["soulmate"] }));
    expect(scoped).toEqual(["BR", "CA", "DE", "US"]);
    expect(scoped.every((code) => all.includes(code))).toBe(true);
    expect(scoped).not.toContain("AE");
  });

  it("Campaign Path narrows GEO to the countries that path's users actually have", () => {
    const funnelScoped = geo(optionsFor({ funnel: ["soulmate"] }));
    const pathScoped = geo(optionsFor({ campaign_path: ["soulmate-sketch"] }));
    // The reported regression: this used to be the full project-wide GEO list.
    expect(pathScoped).toEqual(["CA", "US"]);
    expect(pathScoped.every((code) => funnelScoped.includes(code))).toBe(true);
    for (const code of pathScoped) {
      expect(MEMBERS.some((m) => m.campaign_path === "soulmate-sketch" && m.country === code)).toBe(true);
    }
  });

  it("scopes the remaining dimensions once Campaign Path + Country are selected", () => {
    const result = optionsFor({ campaign_path: ["soulmate-sketch"], country: ["US"] });
    expect(result.options.card_type.map((o) => o.card_type)).toEqual(expect.arrayContaining(["visa", "mastercard"]));
    expect(result.options.media_buyer.map((o) => o.media_buyer)).toEqual(["Alex"]);
    expect(result.options.media_buyer.map((o) => o.media_buyer)).not.toContain("Jamie");
    expect(result.scope_user_count).toBe(2); // u1, u2
  });

  it("excludes a dimension's OWN predicate from its own list (country)", () => {
    // Country=US is active, but the GEO list must still offer CA — otherwise the
    // dropdown would lock to the single selected value.
    expect(geo(optionsFor({ campaign_path: ["soulmate-sketch"], country: ["US"] }))).toEqual(["CA", "US"]);
  });

  it("excludes a dimension's OWN predicate from its own list (card_type)", () => {
    const result = optionsFor({ campaign_path: ["soulmate-sketch"], card_type: ["visa"] });
    expect(result.options.card_type.map((o) => o.card_type)).toEqual(expect.arrayContaining(["visa", "mastercard"]));
  });

  it("clearing an upstream filter broadens the lists back", () => {
    expect(geo(optionsFor({ campaign_path: ["soulmate-sketch"] }))).toEqual(["CA", "US"]);
    expect(geo(optionsFor({ funnel: ["soulmate"] }))).toEqual(["BR", "CA", "DE", "US"]);
    expect(geo(optionsFor())).toEqual(["AE", "AR", "AU", "BR", "CA", "DE", "US"]);
  });

  it("applies the date range to every list", () => {
    // u9 (CA, 2026-06-20) is the only member outside this window.
    const result = optionsFor({}, { date_from: "2026-06-01", date_to: "2026-06-10" });
    expect(result.scope_user_count).toBe(8);
    expect(optionFiltersApplied(normalizeCohortRequest({ date_from: "2026-06-01" } as CohortRequest).filters, "2026-06-01", null))
      .toContain("date_range");
  });

  it("counts DISTINCT cohort users per option, not transactions or duplicated users", () => {
    const result = optionsFor({ campaign_path: ["soulmate-sketch"] });
    const us = result.options.country.find((c) => c.country_code === "US");
    const ca = result.options.country.find((c) => c.country_code === "CA");
    expect(us?.user_count).toBe(2); // u1, u2
    expect(ca?.user_count).toBe(2); // u3, u9
    // Counts must equal what selecting that option would yield.
    expect(optionsFor({ campaign_path: ["soulmate-sketch"], country: ["US"] }).scope_user_count).toBe(us?.user_count);
    expect(optionsFor({ campaign_path: ["soulmate-sketch"], country: ["CA"] }).scope_user_count).toBe(ca?.user_count);
  });

  it("option scope stays consistent with the Cohorts result scope", () => {
    // Every dimension's scope_user_count is the distinct users under the other
    // active filters; the full scope is what the Cohorts table aggregates.
    const result = optionsFor({ funnel: ["soulmate"] });
    const countryDim = result.dimensions.find((d) => d.dimension === "country");
    expect(countryDim?.scope_user_count).toBe(6); // u1..u5 + u9
    expect(result.scope_user_count).toBe(6);
    expect(countryDim?.excluded_dimension).toBe("country");
    expect(countryDim?.filters_applied).toEqual(["funnel"]);
  });

  it("drops empty option values but still counts those users in the scope", () => {
    // u9 has card_type='' / media_buyer='' — it must not appear as a blank option,
    // yet it is still a cohort user of the scope.
    const result = optionsFor({ campaign_path: ["soulmate-sketch"] });
    expect(result.options.card_type.map((o) => o.card_type)).not.toContain("");
    expect(result.options.media_buyer.map((o) => o.media_buyer)).not.toContain("");
    expect(result.dimensions.find((d) => d.dimension === "card_type")?.scope_user_count).toBe(4); // u1,u2,u3,u9
  });

  it("binds every filter value as a query param (no SQL interpolation)", () => {
    const nreq = normalizeCohortRequest({
      filters: { campaign_path: ["soulmate-sketch'; DROP TABLE x --"], country: ["US"] },
    } as CohortRequest);
    const params: Record<string, unknown> = { auth_user_id: "auth_1" };
    const sql = buildMaterializedFilterOptionsQuery(nreq, ACTIVE, params);
    expect(sql).not.toContain("DROP TABLE");
    expect(Object.values(params)).toContain("soulmate-sketch'; DROP TABLE x --");
    expect(sql).toContain("{o_campaign_path_0:String}");
  });

  it("reports which filters were applied to the options and which were not", () => {
    const filters = normalizeCohortRequest({
      filters: { campaign_path: ["soulmate-sketch"], country: ["US"], refund_status: "has" },
    } as CohortRequest).filters;
    expect(optionFiltersApplied(filters, null, null)).toEqual(["campaign_path", "country"]);
    // refund_status is a cohort-GROUP-level HAVING, not a user attribute — honestly
    // reported as not applied to the option scope rather than silently ignored.
    expect(optionFiltersIgnored(filters)).toEqual(["refund_status"]);
  });

  it("scopes the dynamic-classifier fallback with the SAME rules", () => {
    const nreq = normalizeCohortRequest({ filters: { campaign_path: ["soulmate-sketch"] } } as CohortRequest);
    const params: Record<string, unknown> = { auth_user_id: "auth_1" };
    const sql = buildFilterOptionsQuery(nreq, params);
    const result = filterOptionsFromRows(evaluateOptionsSql(sql, params, MEMBERS));
    expect(result.options.country.map((c) => c.country_code)).toEqual(["CA", "US"]);
  });
});

// ---- The Edge entrypoint carries the filters end to end --------------------

describe("runMaterializedCohortOptions", () => {
  const snapshot = {
    auth_user_id: "auth_1",
    snapshot_name: "fact_user_cohorts",
    status: "completed",
    active_warehouse_version: "wh_1",
    active_classification_version: "cv_1",
    active_generated_at: "2026-07-01T00:00:00.000Z",
    users_classified: MEMBERS.length,
    source_transactions: 100,
    source_unique_users: MEMBERS.length,
    diagnostics: { validation: { status: "PASS" } },
  };

  function fakeSupabase(): SupabaseLikeClient {
    return {
      from() {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: snapshot, error: null }),
          upsert: async () => ({ data: null, error: null }),
        };
        return builder as never;
      },
    };
  }

  function fakeClickHouse(seen: string[]): ClickHouseClientLike {
    return {
      command: async () => undefined,
      insert: async () => undefined,
      query: async ({ query, query_params }) => ({
        json: async () => {
          if (query.includes("dim, funnel value")) {
            seen.push(query);
            return evaluateOptionsSql(query, (query_params ?? {}) as Record<string, unknown>, MEMBERS);
          }
          if (query.includes("system.tables")) return [{ c: 1 }];
          return [{ c: 0 }];
        },
      }),
    } as ClickHouseClientLike;
  }

  it("passes the request's active filters into the options SQL and returns scoped lists", async () => {
    const seen: string[] = [];
    const response = await runMaterializedCohortOptions({
      authUserId: "auth_1",
      supabase: fakeSupabase(),
      clickhouse: fakeClickHouse(seen),
      request: { action: "options", filters: { campaign_path: ["soulmate-sketch"] } } as CohortRequest,
    });

    expect(response).not.toBeNull();
    const options = response!.filter_options as { country: Array<{ country_code: string }> };
    expect(options.country.map((c) => c.country_code)).toEqual(["CA", "US"]);
    // The filters really reached ClickHouse (this is what the regression lost).
    expect(seen[0]).toContain("m_campaign_path");
    expect(response!.filter_options_diagnostics?.filters_applied_to_options).toEqual(["campaign_path"]);
    expect(response!.filter_options_diagnostics?.option_scope_user_count).toBe(4);
    expect(response!.filter_options_diagnostics?.source).toBe("fact_user_cohorts");
    const countryDim = response!.filter_options_diagnostics?.dimensions.find((d) => d.dimension === "country");
    expect(countryDim?.excluded_dimension).toBe("country");
  });

  it("still returns the project-wide lists when no filter is active", async () => {
    const response = await runMaterializedCohortOptions({
      authUserId: "auth_1",
      supabase: fakeSupabase(),
      clickhouse: fakeClickHouse([]),
      request: { action: "options" } as CohortRequest,
    });
    const options = response!.filter_options as { country: Array<{ country_code: string }> };
    expect(options.country.map((c) => c.country_code)).toEqual(["AE", "AR", "AU", "BR", "CA", "DE", "US"]);
    expect(response!.filter_options_diagnostics?.filters_applied_to_options).toEqual([]);
  });
});
