// FB Analytics → Cohorts integration: server-side query builder + assembly.
// Sections A–G of the 100-test functional suite (70 tests here; H–J live in
// fbCohortCohortsUi.test.tsx). Fixtures are production-shaped: 18-digit Meta
// campaign ids, per-day campaign grain, USD envelope currency.

import { describe, expect, it } from "vitest";
import {
  assembleFbCohortStats,
  buildFbCohortJoinSql,
  deriveFbRatios,
  fbCampaignDailySql,
  fbCohortMembersSql,
  fbCohortRowKey,
  fbSourceStatsSql,
  normalizeFbCampaignId,
  type FbJoinPairRow,
} from "../../supabase/functions/_shared/clickhouse/fbCohortStats.ts";
import { mapCapsuledRow } from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import type { CohortFilters } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

const CAMPAIGN_A = "120249115818080040"; // real 18-digit Meta id shape
const CAMPAIGN_B = "120245324528670659";

const NO_FILTERS: CohortFilters = {
  funnel: [], campaign_path: [], campaign_id: [], traffic_source: [], price_plan: [],
  media_buyer: [], country: [], card_type: [], currency: [], transaction_type: [], refund_status: "all",
};

function pair(overrides: Partial<FbJoinPairRow> = {}): FbJoinPairRow {
  return {
    cohort_date: "2026-07-14",
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    campaign_id: CAMPAIGN_A,
    currency: "USD",
    matched: 1,
    spend: 249.27,
    purchases: 6,
    impressions: 2823,
    reach: 0,
    clicks: 318,
    link_clicks: 0,
    purchase_value: 0,
    ...overrides,
  };
}

const KEY_A = fbCohortRowKey("2026-07-14", "soulmate", "soulmate-sketch");
const visible = (...keys: string[]) => new Set(keys.length ? keys : [KEY_A]);

// =============================================================================
// A. Campaign ID normalization — 10 tests
// =============================================================================
describe("A. Campaign ID normalization", () => {
  it("A1: string campaign id matches its FB row", () => {
    const { perRow } = assembleFbCohortStats([pair()], visible());
    expect(perRow[KEY_A].fb_campaigns_matched).toBe(1);
    expect(perRow[KEY_A].fb_match_status).toBe("matched");
  });

  it("A2: numeric API campaign id converts safely to String", () => {
    expect(normalizeFbCampaignId(1234567)).toBe("1234567");
  });

  it("A3: large 18-digit campaign id keeps full precision", () => {
    expect(normalizeFbCampaignId(CAMPAIGN_A)).toBe(CAMPAIGN_A);
    expect(normalizeFbCampaignId(CAMPAIGN_A)).toHaveLength(18);
  });

  it("A4: leading/trailing spaces are trimmed on both sides of the join", () => {
    expect(normalizeFbCampaignId(`  ${CAMPAIGN_A}  `)).toBe(CAMPAIGN_A);
    expect(fbCampaignDailySql()).toContain("trim(BOTH ' ' FROM campaign_id)");
    const params: Record<string, unknown> = {};
    expect(fbCohortMembersSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params })).toContain("trim(BOTH ' ' FROM campaign_id)");
  });

  it("A5: empty campaign id is excluded from the join on both sides", () => {
    const params: Record<string, unknown> = {};
    const membersSql = fbCohortMembersSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params });
    expect(membersSql).toContain("trim(BOTH ' ' FROM campaign_id) != ''");
    expect(fbCampaignDailySql()).toContain("trim(BOTH ' ' FROM campaign_id) != ''");
  });

  it("A6: null campaign id normalizes to empty and cannot match", () => {
    expect(normalizeFbCampaignId(null)).toBe("");
    expect(normalizeFbCampaignId(undefined)).toBe("");
  });

  it("A7: malformed campaign id does not crash normalization", () => {
    expect(normalizeFbCampaignId("abc%$§ id")).toBe("abc%$§ id");
    expect(() => assembleFbCohortStats([pair({ campaign_id: "abc%$§" })], visible())).not.toThrow();
  });

  it("A8: different campaign ids never merge into one campaign count", () => {
    const { perRow } = assembleFbCohortStats(
      [pair({ campaign_id: CAMPAIGN_A }), pair({ campaign_id: CAMPAIGN_B, spend: 50 })],
      visible(),
    );
    expect(perRow[KEY_A].fb_campaigns_matched).toBe(2);
  });

  it("A9: the same id arriving as number and as string normalizes identically", () => {
    expect(normalizeFbCampaignId(52526323494764)).toBe(normalizeFbCampaignId("52526323494764"));
  });

  it("A10: leading zeros survive — ids never round-trip through JS Number", () => {
    expect(normalizeFbCampaignId("00120249115818080040")).toBe("00120249115818080040");
  });
});

// =============================================================================
// B. Date and timezone — 10 tests
// =============================================================================
describe("B. Date and timezone", () => {
  it("B11: same campaign id and same date match", () => {
    const { matchedPairs } = assembleFbCohortStats([pair()], visible());
    expect(matchedPairs).toBe(1);
  });

  it("B12: same campaign id on a different date arrives unmatched (LEFT JOIN miss)", () => {
    const { perRow, unmatchedPairs } = assembleFbCohortStats([pair({ matched: 0, spend: 0, purchases: 0, impressions: 0, clicks: 0 })], visible());
    expect(unmatchedPairs).toBe(1);
    expect(perRow[KEY_A].fb_match_status).toBe("no_fb_stats");
  });

  it("B13: consecutive dates stay separate cohort row keys", () => {
    const k15 = fbCohortRowKey("2026-07-15", "soulmate", "soulmate-sketch");
    const { perRow } = assembleFbCohortStats(
      [pair(), pair({ cohort_date: "2026-07-15", spend: 10 })],
      visible(KEY_A, k15),
    );
    expect(perRow[KEY_A].fb_spend).toBe(249.27);
    expect(perRow[k15].fb_spend).toBe(10);
  });

  it("B14: UTC day boundary — 23:59 vs 00:00 days never share a key", () => {
    expect(fbCohortRowKey("2026-07-14", "f", "p")).not.toBe(fbCohortRowKey("2026-07-15", "f", "p"));
  });

  it("B15: join compares literal dates — no timezone shifting functions in SQL", () => {
    const params: Record<string, unknown> = {};
    const sql = buildFbCohortJoinSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("f.stat_date = m.cohort_date");
    expect(sql).not.toMatch(/toTimeZone|addHours|INTERVAL/i);
  });

  it("B16: leap-day date binds as an exact parameter", () => {
    const params: Record<string, unknown> = {};
    buildFbCohortJoinSql({ filters: NO_FILTERS, dateFrom: "2024-02-29", dateTo: "2024-02-29", params });
    expect(params.fbj_date_from).toBe("2024-02-29");
    expect(params.fbj_date_to).toBe("2024-02-29");
  });

  it("B17: month boundary dates stay separate", () => {
    const kJun = fbCohortRowKey("2026-06-30", "f", "p");
    const kJul = fbCohortRowKey("2026-07-01", "f", "p");
    const { perRow } = assembleFbCohortStats(
      [pair({ cohort_date: "2026-06-30", funnel: "f", campaign_path: "p", spend: 1 }), pair({ cohort_date: "2026-07-01", funnel: "f", campaign_path: "p", spend: 2 })],
      visible(kJun, kJul),
    );
    expect(perRow[kJun].fb_spend).toBe(1);
    expect(perRow[kJul].fb_spend).toBe(2);
  });

  it("B18: year boundary dates stay separate", () => {
    expect(fbCohortRowKey("2025-12-31", "f", "p")).not.toBe(fbCohortRowKey("2026-01-01", "f", "p"));
  });

  it("B19: an invalid FB source date is rejected at warehouse mapping time", () => {
    const row = mapCapsuledRow({
      row: { dateFrom: "not-a-date", spend: 5 },
      level: "campaign",
      authUserId: "u",
      envelope: {},
      syncedAtIso: "2026-07-16T00:00:00.000Z",
      warehouseVersion: "v",
      rowVersion: 1,
    });
    expect(row).toBeNull();
  });

  it("B20: cohort date passes through the join key without any silent shift", () => {
    const { perRow } = assembleFbCohortStats([pair({ cohort_date: "2026-07-14" })], visible());
    expect(Object.keys(perRow)).toEqual([KEY_A]);
    expect(KEY_A.startsWith("2026-07-14|")).toBe(true);
  });
});

// =============================================================================
// C. Additive metrics — 10 tests
// =============================================================================
describe("C. Additive metrics", () => {
  const one = () => assembleFbCohortStats([pair()], visible()).perRow[KEY_A];

  it("C21: spend joins with its exact value", () => {
    expect(one().fb_spend).toBe(249.27);
  });

  it("C22: purchases join with their exact value", () => {
    expect(one().fb_purchases).toBe(6);
  });

  it("C23: impressions join with their exact value", () => {
    expect(one().fb_impressions).toBe(2823);
  });

  it("C24: clicks join with their exact value", () => {
    expect(one().fb_clicks).toBe(318);
  });

  it("C25: link clicks join with their exact value", () => {
    const { perRow } = assembleFbCohortStats([pair({ link_clicks: 42 })], visible());
    expect(perRow[KEY_A].fb_link_clicks).toBe(42);
  });

  it("C26: purchase value joins with its exact value", () => {
    const { perRow } = assembleFbCohortStats([pair({ purchase_value: 123.45 })], visible());
    expect(perRow[KEY_A].fb_purchase_value).toBe(123.45);
  });

  it("C27: multiple raw FB rows aggregate to campaign/day grain BEFORE the join (SQL GROUP BY + FINAL)", () => {
    const sql = fbCampaignDailySql();
    expect(sql).toContain("GROUP BY stat_date, campaign_id, currency");
    expect(sql).toContain("sum(spend)");
    expect(sql).toContain("FINAL");
  });

  it("C28: zero metric values are preserved as real zeros, not dropped", () => {
    const { perRow } = assembleFbCohortStats([pair({ spend: 0, purchases: 0, impressions: 0, clicks: 0 })], visible());
    expect(perRow[KEY_A].fb_spend).toBe(0);
    expect(perRow[KEY_A].fb_match_status).toBe("matched");
  });

  it("C29: negative spend (upstream anomaly) is excluded from sums", () => {
    const { perRow } = assembleFbCohortStats([pair(), pair({ campaign_id: CAMPAIGN_B, spend: -100 })], visible());
    expect(perRow[KEY_A].fb_spend).toBe(249.27);
  });

  it("C30: decimal spend keeps 2-decimal precision across additions", () => {
    const { perRow } = assembleFbCohortStats(
      [pair({ spend: 249.27 }), pair({ campaign_id: CAMPAIGN_B, spend: 52.24 })],
      visible(),
    );
    expect(perRow[KEY_A].fb_spend).toBe(301.51);
  });
});

// =============================================================================
// D. Derived metrics — 10 tests
// =============================================================================
describe("D. Derived metrics", () => {
  const additive = (over: Partial<Parameters<typeof deriveFbRatios>[0]> = {}) => ({
    fb_spend: 100, fb_purchases: 4, fb_impressions: 20000, fb_reach: 0,
    fb_clicks: 400, fb_link_clicks: 0, fb_purchase_value: 184, ...over,
  });

  it("D31: CPP = spend / purchases", () => {
    expect(deriveFbRatios(additive()).fb_cpp).toBe(25);
  });

  it("D32: CPP is null when purchases = 0 (renders —, never Infinity)", () => {
    expect(deriveFbRatios(additive({ fb_purchases: 0 })).fb_cpp).toBeNull();
  });

  it("D33: CPC = spend / clicks", () => {
    expect(deriveFbRatios(additive()).fb_cpc).toBe(0.25);
  });

  it("D34: CPC is null when clicks = 0", () => {
    expect(deriveFbRatios(additive({ fb_clicks: 0 })).fb_cpc).toBeNull();
  });

  it("D35: CPM = spend / impressions × 1000", () => {
    expect(deriveFbRatios(additive()).fb_cpm).toBe(5);
  });

  it("D36: CPM is null when impressions = 0", () => {
    expect(deriveFbRatios(additive({ fb_impressions: 0 })).fb_cpm).toBeNull();
  });

  it("D37: CTR = clicks / impressions × 100 (single ×100, canonical source is the sums)", () => {
    expect(deriveFbRatios(additive()).fb_ctr).toBe(2);
  });

  it("D38: CTR is null when impressions = 0", () => {
    expect(deriveFbRatios(additive({ fb_impressions: 0 })).fb_ctr).toBeNull();
  });

  it("D39: ROAS = purchase value / spend", () => {
    expect(deriveFbRatios(additive()).fb_roas).toBe(1.84);
  });

  it("D40: ROAS is null when spend = 0", () => {
    expect(deriveFbRatios(additive({ fb_spend: 0 })).fb_roas).toBeNull();
  });
});

// =============================================================================
// E. Join safety — 10 tests
// =============================================================================
describe("E. Join safety", () => {
  it("E41: a cohort row without FB data keeps its key with zeroed additive metrics", () => {
    const { perRow } = assembleFbCohortStats([pair({ matched: 0, spend: 0 })], visible());
    expect(perRow[KEY_A]).toBeDefined();
    expect(perRow[KEY_A].fb_spend).toBe(0);
    expect(perRow[KEY_A].fb_cpp).toBeNull();
  });

  it("E42: an FB row without a cohort never creates a cohort row (members drive the join)", () => {
    const params: Record<string, unknown> = {};
    const sql = buildFbCohortJoinSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params });
    expect(sql).toContain("FROM members m");
    expect(sql).toContain("LEFT JOIN fb f");
    expect(sql).not.toContain("RIGHT JOIN");
    expect(sql).not.toContain("FULL JOIN");
  });

  it("E43: pair rows never multiply cohort rows — assembly is keyed by the row key", () => {
    const { perRow } = assembleFbCohortStats(
      [pair(), pair({ campaign_id: CAMPAIGN_B, spend: 1 })],
      visible(),
    );
    expect(Object.keys(perRow)).toHaveLength(1);
  });

  it("E44: duplicate pairs of the same campaign/day dedupe inside totals", () => {
    const { totals } = assembleFbCohortStats(
      [pair(), pair()], // same (date, campaign, currency) delivered twice
      visible(),
    );
    expect(totals.fb_spend).toBe(249.27);
    expect(totals.fb_campaign_day_pairs).toBe(1);
  });

  it("E45: logical ReplacingMergeTree duplicates are collapsed by FINAL in the FB CTE", () => {
    expect(fbCampaignDailySql()).toContain(`FROM fact_facebook_stats FINAL`);
  });

  it("E46: the same campaign on multiple dates never mixes spends", () => {
    const k15 = fbCohortRowKey("2026-07-15", "soulmate", "soulmate-sketch");
    const { totals } = assembleFbCohortStats(
      [pair({ spend: 100 }), pair({ cohort_date: "2026-07-15", spend: 200 })],
      visible(KEY_A, k15),
    );
    expect(totals.fb_spend).toBe(300);
    expect(totals.fb_campaign_day_pairs).toBe(2);
  });

  it("E47: multiple campaigns on the same day stay separate pairs", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ spend: 100 }), pair({ campaign_id: CAMPAIGN_B, spend: 50 })],
      visible(),
    );
    expect(totals.fb_campaign_day_pairs).toBe(2);
    expect(totals.fb_spend).toBe(150);
  });

  it("E48: a row whose members all lack campaign ids is absent from pairs (missing_cohort_campaign_id by absence)", () => {
    const { perRow } = assembleFbCohortStats([], visible());
    expect(perRow[KEY_A]).toBeUndefined();
  });

  it("E49: campaign id present but no FB stats → no_fb_stats with zero spend and null ratios", () => {
    const { perRow } = assembleFbCohortStats([pair({ matched: 0, spend: 0, purchases: 0 })], visible());
    expect(perRow[KEY_A].fb_match_status).toBe("no_fb_stats");
    expect(perRow[KEY_A].fb_cpp).toBeNull();
  });

  it("E50: owner isolation — both join sides filter by the bound auth_user_id", () => {
    const params: Record<string, unknown> = {};
    const sql = buildFbCohortJoinSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params });
    const authClauses = sql.match(/auth_user_id = \{auth_user_id:String\}/g) ?? [];
    expect(authClauses.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// F. Totals and dedupe — 10 tests
// =============================================================================
describe("F. Totals and dedupe", () => {
  const KEY_B = fbCohortRowKey("2026-07-14", "palmistry", "palm-path");

  it("F51: total spend sums UNIQUE campaign/day keys even when a pair feeds two visible rows", () => {
    const { totals } = assembleFbCohortStats(
      [pair(), pair({ funnel: "palmistry", campaign_path: "palm-path" })],
      visible(KEY_A, KEY_B),
    );
    expect(totals.fb_spend).toBe(249.27); // once, not twice
    expect(totals.fb_campaign_day_pairs).toBe(1);
  });

  it("F52: total purchases sum across distinct pairs", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ purchases: 6 }), pair({ campaign_id: CAMPAIGN_B, purchases: 4 })],
      visible(),
    );
    expect(totals.fb_purchases).toBe(10);
  });

  it("F53: total CPP = total spend / total purchases", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ spend: 100, purchases: 2 }), pair({ campaign_id: CAMPAIGN_B, spend: 200, purchases: 8 })],
      visible(),
    );
    expect(totals.fb_cpp).toBe(30); // 300/10 — NOT avg(50, 25) = 37.5
  });

  it("F54: total CTR = total clicks / total impressions × 100", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ clicks: 100, impressions: 1000 }), pair({ campaign_id: CAMPAIGN_B, clicks: 100, impressions: 9000 })],
      visible(),
    );
    expect(totals.fb_ctr).toBe(2); // 200/10000 — NOT avg(10%, 1.11%)
  });

  it("F55: total CPC = total spend / total clicks", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ spend: 100, clicks: 100 }), pair({ campaign_id: CAMPAIGN_B, spend: 100, clicks: 300 })],
      visible(),
    );
    expect(totals.fb_cpc).toBe(0.5); // 200/400
  });

  it("F56: total CPM = total spend / total impressions × 1000", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ spend: 100, impressions: 10000 }), pair({ campaign_id: CAMPAIGN_B, spend: 100, impressions: 30000 })],
      visible(),
    );
    expect(totals.fb_cpm).toBe(5); // 200/40000*1000
  });

  it("F57: total ROAS = total purchase value / total spend", () => {
    const { totals } = assembleFbCohortStats(
      [pair({ spend: 100, purchase_value: 300 }), pair({ campaign_id: CAMPAIGN_B, spend: 100, purchase_value: 100 })],
      visible(),
    );
    expect(totals.fb_roas).toBe(2); // 400/200
  });

  it("F58: row-level ratios are never averaged into totals", () => {
    const { perRow, totals } = assembleFbCohortStats(
      [pair({ spend: 90, purchases: 1 }), pair({ campaign_id: CAMPAIGN_B, spend: 10, purchases: 9 })],
      visible(),
    );
    expect(perRow[KEY_A].fb_cpp).toBe(10); // row: 100/10
    expect(totals.fb_cpp).toBe(10); // totals from sums, coincides here…
    const skewed = assembleFbCohortStats(
      [pair({ spend: 100, purchases: 1 }), pair({ campaign_id: CAMPAIGN_B, spend: 100, purchases: 99 })],
      visible(),
    ).totals;
    expect(skewed.fb_cpp).toBe(2); // 200/100 — an average of (100, 1.01) would be ≈50.5
  });

  it("F59: duplicated cohort presentation of one pair does not duplicate totals spend", () => {
    const twoRows = assembleFbCohortStats(
      [pair(), pair({ funnel: "palmistry", campaign_path: "palm-path" })],
      visible(KEY_A, KEY_B),
    );
    const oneRow = assembleFbCohortStats([pair()], visible(KEY_A));
    expect(twoRows.totals.fb_spend).toBe(oneRow.totals.fb_spend);
  });

  it("F60: empty selection returns zero additive totals and null ratios", () => {
    const { totals } = assembleFbCohortStats([], new Set<string>());
    expect(totals.fb_spend).toBe(0);
    expect(totals.fb_purchases).toBe(0);
    expect(totals.fb_cpp).toBeNull();
    expect(totals.fb_ctr).toBeNull();
    expect(totals.fb_roas).toBeNull();
  });
});

// =============================================================================
// G. Currency — 10 tests
// =============================================================================
describe("G. Currency", () => {
  it("G61: native USD rows carry fb_currency USD", () => {
    const { perRow, totals } = assembleFbCohortStats([pair()], visible());
    expect(perRow[KEY_A].fb_currency).toBe("USD");
    expect(totals.fb_currency).toBe("USD");
  });

  it("G62: a single non-USD currency passes through labelled, converted at most once (no conversion applied here)", () => {
    const { perRow } = assembleFbCohortStats([pair({ currency: "EUR", spend: 100 })], visible());
    expect(perRow[KEY_A].fb_currency).toBe("EUR");
    expect(perRow[KEY_A].fb_spend).toBe(100); // value untouched — no hidden FX pass
  });

  it("G63: missing currency falls back to the envelope default (USD) without crashing", () => {
    const { perRow } = assembleFbCohortStats([pair({ currency: null })], visible());
    expect(perRow[KEY_A].fb_currency).toBe("USD");
  });

  it("G64: no FX rate lookup happens inside the FB join (single-currency contract)", () => {
    const params: Record<string, unknown> = {};
    const sql = buildFbCohortJoinSql({ filters: NO_FILTERS, dateFrom: null, dateTo: null, params });
    expect(sql).not.toMatch(/fx_rate|rates|convert/i);
  });

  it("G65: spend value is passed through exactly once — no double conversion", () => {
    const { perRow } = assembleFbCohortStats([pair({ spend: 52.24 })], visible());
    expect(perRow[KEY_A].fb_spend).toBe(52.24);
  });

  it("G66: two currencies inside one row → fb_match_status mixed_currency", () => {
    const { perRow } = assembleFbCohortStats(
      [pair({ currency: "USD" }), pair({ campaign_id: CAMPAIGN_B, currency: "EUR" })],
      visible(),
    );
    expect(perRow[KEY_A].fb_match_status).toBe("mixed_currency");
  });

  it("G67: mixed currencies are never silently summed into a USD figure", () => {
    const { perRow } = assembleFbCohortStats(
      [pair({ currency: "USD", spend: 100 }), pair({ campaign_id: CAMPAIGN_B, currency: "EUR", spend: 100 })],
      visible(),
    );
    expect(perRow[KEY_A].fb_spend).toBe(0);
    expect(perRow[KEY_A].fb_cpp).toBeNull();
    expect(perRow[KEY_A].fb_currency).toBeNull();
  });

  it("G68: decimal rounding is half-up to cents after summing", () => {
    const { perRow } = assembleFbCohortStats(
      [pair({ spend: 0.005 }), pair({ campaign_id: CAMPAIGN_B, spend: 0.004 })],
      visible(),
    );
    expect(perRow[KEY_A].fb_spend).toBe(0.01);
  });

  it("G69: the cohort currency filter scopes the member set via bound parameters", () => {
    const params: Record<string, unknown> = {};
    const sql = fbCohortMembersSql({
      filters: { ...NO_FILTERS, currency: ["USD"] },
      dateFrom: null, dateTo: null, params,
    });
    expect(sql).toContain("currency IN ({p_fbj_cur_0:String})");
    expect(params.p_fbj_cur_0).toBe("USD");
  });

  it("G70: mixed-currency diagnostics count reconciles with affected rows", () => {
    const KEY_B = fbCohortRowKey("2026-07-14", "palmistry", "palm-path");
    const { mixedCurrencyRows } = assembleFbCohortStats(
      [
        pair({ currency: "USD" }),
        pair({ campaign_id: CAMPAIGN_B, currency: "EUR" }),
        pair({ funnel: "palmistry", campaign_path: "palm-path", currency: "USD" }),
      ],
      visible(KEY_A, KEY_B),
    );
    expect(mixedCurrencyRows).toBe(1);
  });
});

// =============================================================================
// Shared SQL scaffolding sanity (counted outside the 100 — supports E/B tests)
// =============================================================================
describe("SQL scaffolding", () => {
  it("source stats query is scoped to campaign level and the bound owner", () => {
    const sql = fbSourceStatsSql();
    expect(sql).toContain("level = 'campaign'");
    expect(sql).toContain("auth_user_id = {auth_user_id:String}");
  });
});
