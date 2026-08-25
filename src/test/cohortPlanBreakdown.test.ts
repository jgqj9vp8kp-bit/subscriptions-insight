// Expanded-cohort price-plan breakdown (restored 2026-07-31).
//
// The original feature (May 2026) computed plan_breakdown in the client engine;
// the ClickHouse migration was designed to load it lazily via action=
// cohort_details but the page never wired the call, and the details plan query
// itself was broken: `scoped INNER JOIN pretyped ON uid` fanned every
// transaction out by the user's row count, multiplying revenue sums and picking
// the plan price nondeterministically among join ties. These tests pin the
// rebuilt query and the full-metric mapping so neither defect can return.
import { describe, expect, it, vi } from "vitest";
import {
  AGGREGATE_MEASURES,
  runCohortDetails,
  toAggregateRow,
} from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import { mapAggregateToCohortRow, mapDetailsPlanBreakdown } from "@/services/cohortsDataSource";
import type { CohortDetailsResponse } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const KEY = { cohort_date: "2026-07-01", funnel: "palm", campaign_path: "palm-reading-web" };

/** A raw plan aggregate row exactly as the plan query emits it (RawCohortRow
 * measures + plan identity). Values chosen so derived metrics are distinctive. */
function rawPlanRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    plan_name: "$7.49", price: 7.49,
    trial_users: 40, gross_raw: 1000, refund_raw: 100,
    d0_raw: 200, d7_raw: 500, d14_raw: 600, d30_raw: 800, d60_raw: 900,
    trial_rev_raw: 299.6, first_sub_rev_raw: 500, renewal_rev_raw: 150, upsell_rev_raw: 50,
    first_subscription_users: 16, renewal_users: 6,
    r2: 6, r3: 2, r4: 0, r5: 0, r6: 0,
    upsell_users: 8, funnel_upsell_users: 8, funnel_upsell_rev_raw: 50,
    upsell_1_users: 8, upsell_2_users: 0, upsell_3_users: 0, upsell_extra_users: 0,
    u1_raw: 50, u2_raw: 0, u3_raw: 0, uextra_raw: 0,
    token_purchases: 3, token_buyers: 2, token_gross_raw: 30, token_refund_raw: 5,
    token_email_purchases: 0,
    refund_users: 4, support_users: 5,
    ...over,
  };
}

function fakeClickHouse(planRows: Record<string, unknown>[], opts: { planRejects?: boolean } = {}) {
  const queries: Array<{ query: string; params?: Record<string, unknown> }> = [];
  const client = {
    query: vi.fn(async (input: { query: string; query_params?: Record<string, unknown> }) => {
      queries.push({ query: input.query, params: input.query_params });
      if (input.query.includes("system.tables")) return { json: async () => [{ c: 0 }] };
      if (input.query.includes("plankey")) {
        if (opts.planRejects) throw new Error("plan query exploded");
        return { json: async () => planRows };
      }
      return { json: async () => [] };
    }),
    command: vi.fn(async () => {}),
    insert: vi.fn(async () => {}),
  } as unknown as ClickHouseClientLike;
  return { client, queries };
}

async function runDetails(planRows: Record<string, unknown>[], filters: Record<string, unknown> = {}, opts: { planRejects?: boolean } = {}) {
  const { client, queries } = fakeClickHouse(planRows, opts);
  const response = await runCohortDetails({
    authUserId: "user-1",
    clickhouse: client,
    request: { action: "details", cohort_key: KEY, filters } as never,
  });
  const planQuery = queries.find((q) => q.query.includes("plankey"));
  return { response, queries, planQuery };
}

describe("plan query shape", () => {
  it("keys the plan by the membership snapshot's rule, not an ad-hoc one", async () => {
    const { planQuery } = await runDetails([]);
    expect(planQuery).toBeDefined();
    expect(planQuery!.query).toContain(
      "argMinIf(round(g, 2), (ets, tprio, tid), is_success = 1 AND lt NOT IN ('upsell','token_purchase'))",
    );
    expect(planQuery!.query).toContain("if(plan_candidates = 0, 'Unknown', concat('$', toString(plan_price)))");
  });

  it("joins one plankey row per user — the old pretyped join fanned revenue out", async () => {
    const { planQuery } = await runDetails([]);
    expect(planQuery!.query).toContain("INNER JOIN plankey pk ON pk.uid = s.uid");
    expect(planQuery!.query).not.toContain("INNER JOIN pretyped p ON p.uid = s.uid");
    // plankey collapses to one row per uid before the join.
    expect(planQuery!.query).toMatch(/plankey AS \([\s\S]*GROUP BY uid[\s\S]*\)/);
  });

  it("reuses the list aggregate's measure list verbatim", async () => {
    const { planQuery } = await runDetails([]);
    expect(planQuery!.query).toContain(AGGREGATE_MEASURES);
  });

  it("scopes every details query to the cohort AND the request's member filters", async () => {
    const { queries, planQuery } = await runDetails([], { country: ["US"], card_type: ["visa"] });
    expect(planQuery!.query).toContain("u_country IN ({p_country_0:String})");
    expect(planQuery!.query).toContain("u_card_type IN ({p_card_0:String})");
    expect(planQuery!.params).toMatchObject({ p_country_0: "US", p_card_0: "visa" });
    // The parent row honours these filters, so summary/currency/token must too
    // or the expanded panel would not reconcile with its own row.
    for (const q of queries.filter((q) => !q.query.includes("system.tables"))) {
      expect(q.query).toContain("u_country IN ({p_country_0:String})");
    }
  });

  it("funnel_key scopes to the whole path with the date window and funnel filter applied explicitly", async () => {
    // The list applies date range / funnel as cohort-level POST-filters
    // (HAVING); details has no HAVING, so the funnel scope must carry them in
    // WHERE or the breakdown would not reconcile with the funnel row.
    const { client, queries } = fakeClickHouse([]);
    const response = await runCohortDetails({
      authUserId: "user-1",
      clickhouse: client,
      request: {
        action: "details",
        funnel_key: { campaign_path: "soulmate-sketch" },
        date_from: "2026-07-01",
        date_to: "2026-07-31",
        filters: { funnel: ["soulmate"] },
      } as never,
    });
    const planQuery = queries.find((q) => q.query.includes("plankey"));
    expect(planQuery!.query).toContain("c_camp = {fk_camp:String}");
    expect(planQuery!.query).toContain("c_date >= {fk_from:String}");
    expect(planQuery!.query).toContain("c_date <= {fk_to:String}");
    expect(planQuery!.query).toContain("c_funnel IN ({p_fk_f_0:String})");
    expect(planQuery!.params).toMatchObject({
      fk_camp: "soulmate-sketch",
      fk_from: "2026-07-01",
      fk_to: "2026-07-31",
      p_fk_f_0: "soulmate",
    });
    expect(response.cohort_key.campaign_path).toBe("soulmate-sketch");
  });

  it("rejects a details request with neither cohort_key nor funnel_key", async () => {
    const { client } = fakeClickHouse([]);
    await expect(
      runCohortDetails({ authUserId: "user-1", clickhouse: client, request: { action: "details" } as never }),
    ).rejects.toThrow(/cohort_key .* or funnel_key/);
  });

  it("keeps auth scoping by bound parameter in the plan query", async () => {
    const { planQuery } = await runDetails([]);
    expect(planQuery!.query).toContain("a.auth_user_id = {auth_user_id:String}");
    expect(planQuery!.params?.auth_user_id).toBe("user-1");
  });
});

describe("plan rows in the details response", () => {
  it("ships the FULL metric set per plan through the same mapper as list rows", async () => {
    const { response } = await runDetails([rawPlanRow()]);
    expect(response.price_breakdown).toHaveLength(1);
    const plan = response.price_breakdown[0];
    expect(plan.price).toBe(7.49);
    expect(plan.plan_name).toBe("$7.49");
    // Field-for-field what toAggregateRow produces for the same raw measures.
    const viaListMapper = toAggregateRow({ ...rawPlanRow(), ...KEY } as never);
    expect(plan).toMatchObject(viaListMapper);
    expect(plan.gross_revenue).toBe(1000);
    expect(plan.net_revenue).toBe(900);
    expect(plan.renewal_users_by_level).toEqual({ 2: 6, 3: 2 });
    expect(plan.support_users).toBe(5);
  });

  it("keeps the Unknown bucket so plan rows always sum to the parent cohort", async () => {
    const { response } = await runDetails([
      rawPlanRow(),
      rawPlanRow({ plan_name: "Unknown", price: 0, trial_users: 3, gross_raw: 0, refund_raw: 0 }),
    ]);
    expect(response.price_breakdown.map((p) => p.plan_name)).toEqual(["$7.49", "Unknown"]);
  });

  it("surfaces a plan-query failure instead of silently showing no breakdown", async () => {
    const { response } = await runDetails([], {}, { planRejects: true });
    expect(response.ok).toBe(true);
    expect(response.price_breakdown).toEqual([]);
    expect(response.error).toContain("price_breakdown");
    expect(response.error).toContain("plan query exploded");
  });
});

describe("mapDetailsPlanBreakdown (client)", () => {
  function detailsWith(planRows: Record<string, unknown>[]): CohortDetailsResponse {
    return {
      ok: true, source: "clickhouse", generated_at: "", query_duration_ms: 1,
      cohort_key: KEY,
      price_breakdown: planRows.map((r) => ({
        price: Number(r.price), plan_name: String(r.plan_name),
        ...toAggregateRow({ ...r, ...KEY } as never),
      })),
      currency_breakdown: [], upsell: { upsell_1_users: 0, upsell_2_users: 0, upsell_3_users: 0, upsell_extra_users: 0, upsell_1_revenue: 0, upsell_2_revenue: 0, upsell_3_revenue: 0, upsell_extra_revenue: 0 },
      token_pack_breakdown: [],
      ltv_1m: { trial_users: 0, net_revenue_1m: 0, ltv_1m_per_user: 0, age_days: 60, matured: true, available_days: 30 },
      fx: { missing_transactions: 0, missing_amount: 0 },
    };
  }

  it("derives rates with the exact list-row formulas", () => {
    const [plan] = mapDetailsPlanBreakdown(detailsWith([rawPlanRow()]));
    const parent = mapAggregateToCohortRow(detailsWith([rawPlanRow()]).price_breakdown[0]);
    expect(plan.trial_to_first_subscription_cr).toBe(parent.trial_to_first_subscription_cr);
    expect(plan.trial_to_upsell_cr).toBe(parent.trial_to_upsell_cr);
    expect(plan.refund_rate).toBe(parent.refund_rate);
    expect(plan.first_subscription_to_renewal_2_cr).toBe(parent.first_subscription_to_renewal_2_cr);
    expect(plan.net_ltv).toBe(parent.net_ltv);
    expect(plan.plan_name).toBe("$7.49");
    expect(plan.support_users).toBe(5);
  });

  it("leaves subscription-state metrics undefined — the overlay is per cohort, not per plan", () => {
    const [plan] = mapDetailsPlanBreakdown(detailsWith([rawPlanRow()]));
    expect(plan.active_users).toBeUndefined();
    expect(plan.active_subscriptions).toBeUndefined();
    expect(plan.cancelled_users).toBeUndefined();
    expect(plan.cancellation_rate).toBeUndefined();
  });

  it("plan rows reconcile with the parent: users and money partition exactly", () => {
    const a = rawPlanRow();
    const b = rawPlanRow({ plan_name: "$19.99", price: 19.99, trial_users: 60, gross_raw: 3000, refund_raw: 200, first_subscription_users: 30, refund_users: 6, support_users: 1 });
    const parentRaw = {
      ...rawPlanRow({
        trial_users: 100, gross_raw: 4000, refund_raw: 300, first_subscription_users: 46,
        refund_users: 10, support_users: 6,
      }),
    };
    const plans = mapDetailsPlanBreakdown(detailsWith([a, b]));
    const parent = mapAggregateToCohortRow(toAggregateRow({ ...parentRaw, ...KEY } as never));
    expect(plans.reduce((s, p) => s + p.trial_users, 0)).toBe(parent.trial_users);
    expect(plans.reduce((s, p) => s + p.gross_revenue, 0)).toBe(parent.gross_revenue);
    expect(plans.reduce((s, p) => s + p.net_revenue, 0)).toBe(parent.net_revenue);
    expect(plans.reduce((s, p) => s + p.first_subscription_users, 0)).toBe(parent.first_subscription_users);
    expect(plans.reduce((s, p) => s + p.refund_users, 0)).toBe(parent.refund_users);
    expect(plans.reduce((s, p) => s + (p.support_users ?? 0), 0)).toBe(6);
  });
});
