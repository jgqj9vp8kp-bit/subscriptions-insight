import { describe, expect, it } from "vitest";
import {
  CohortRequestError,
  normalizeAction,
  normalizeCohortRequest,
  buildListQuery,
  toAggregateRow,
  computeTotals,
  supportDataStatus,
} from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

describe("clickhouse-cohorts request validation", () => {
  it("normalizes action names and legacy aliases", () => {
    expect(normalizeAction(undefined)).toBe("list");
    expect(normalizeAction("list")).toBe("list");
    expect(normalizeAction("cohorts")).toBe("list");
    expect(normalizeAction("details")).toBe("details");
    expect(normalizeAction("cohort_details")).toBe("details");
    expect(normalizeAction("options")).toBe("options");
    expect(normalizeAction("filter_options")).toBe("options");
  });

  it("rejects unknown actions", () => {
    expect(() => normalizeAction("drop_table")).toThrow(CohortRequestError);
  });

  it("rejects malformed dates", () => {
    expect(() => normalizeCohortRequest({ date_from: "2026/01/01" })).toThrow(CohortRequestError);
    expect(() => normalizeCohortRequest({ date_to: "not-a-date" })).toThrow(CohortRequestError);
    expect(normalizeCohortRequest({ date_from: "2026-01-01", date_to: "2026-02-01" }).dateFrom).toBe("2026-01-01");
  });

  it("sanitizes filter arrays (trim, dedupe, drop empties)", () => {
    const nreq = normalizeCohortRequest({ filters: { funnel: [" soulmate ", "soulmate", "", "past_life"] } });
    expect(nreq.filters.funnel).toEqual(["soulmate", "past_life"]);
  });

  it("normalizes refund_status", () => {
    expect(normalizeCohortRequest({ filters: { refund_status: "has" } }).filters.refund_status).toBe("has");
    expect(normalizeCohortRequest({ filters: { refund_status: "bogus" as never } }).filters.refund_status).toBe("all");
  });

  it("rejects non-array filters", () => {
    expect(() => normalizeCohortRequest({ filters: { funnel: "soulmate" as never } })).toThrow(CohortRequestError);
  });

  it("caps oversized filter lists", () => {
    const many = Array.from({ length: 501 }, (_, i) => `v${i}`);
    expect(() => normalizeCohortRequest({ filters: { campaign_id: many } })).toThrow(CohortRequestError);
  });
});

describe("clickhouse-cohorts SQL safety and scoping", () => {
  it("always scopes by auth_user_id via a bound parameter", () => {
    const nreq = normalizeCohortRequest({});
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("a.auth_user_id = {auth_user_id:String}");
    expect(params.auth_user_id).toBe("user-1");
  });

  it("keeps classifier columns unqualified after joining cohort identity", () => {
    const nreq = normalizeCohortRequest({});
    const sql = buildListQuery(nreq, { auth_user_id: "user-1" });
    expect(sql).not.toContain("SELECT e.*");
    expect(sql).toContain("SELECT e.uid uid, e.tid tid");
    expect(sql).toContain("FROM pretyped p LEFT JOIN lifeidx li USING(uid, tid)");
  });

  it("binds filter values as parameters — never interpolates raw input", () => {
    const malicious = "soulmate' OR '1'='1";
    const nreq = normalizeCohortRequest({ filters: { funnel: [malicious] } });
    const params: Record<string, unknown> = { auth_user_id: "user-1" };
    const sql = buildListQuery(nreq, params);
    // The raw value must appear ONLY in query_params, never in the SQL text.
    expect(sql).not.toContain(malicious);
    expect(sql).toMatch(/funnel IN \(\{p_fn_0:String\}\)/);
    expect(Object.values(params)).toContain(malicious);
  });

  it("never exposes raw payloads, emails, or transaction ids in the response shape", () => {
    const nreq = normalizeCohortRequest({ filters: { media_buyer: ["Ivan"], currency: ["USD"] } });
    const sql = buildListQuery(nreq, { auth_user_id: "user-1" });
    expect(sql).not.toMatch(/raw_payload/);
    // normalized_payload may be read internally for traffic_source attribution,
    // but it is never selected out of the aggregate response.
    expect(sql).toMatch(/JSONExtractString\(a\.normalized_payload, 'traffic_source'\)/);
    // The SELECT list exposes only aggregates — no email / transaction_id columns leak out.
    expect(sql).not.toMatch(/SELECT[^;]*\bemail\b/i);
  });

  it("applies media_buyer and currency filters with bound params", () => {
    const nreq = normalizeCohortRequest({ filters: { media_buyer: ["Ivan", "Artem A"], currency: ["MXN"] } });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("u_media_buyer IN ({p_mb_0:String}, {p_mb_1:String})");
    expect(sql).toContain("keep AS (");
    expect(params.p_mb_0).toBe("Ivan");
    expect(params.p_cur_0).toBe("MXN");
  });

  it("applies attributed campaign, traffic, country and card filters after classification", () => {
    const nreq = normalizeCohortRequest({
      filters: {
        campaign_id: ["cmp-1"],
        traffic_source: ["facebook"],
        country: ["US"],
        card_type: ["credit"],
      },
    });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("c_campaign_id IN ({p_cid_0:String})");
    expect(sql).toContain("c_traffic_source IN ({p_tsrc_0:String})");
    expect(sql).toContain("u_country IN ({p_country_0:String})");
    expect(sql).toContain("u_card_type IN ({p_card_0:String})");
    expect(sql).toContain("FROM fin\nWHERE");
    expect(params.p_cid_0).toBe("cmp-1");
    expect(params.p_tsrc_0).toBe("facebook");
    expect(params.p_country_0).toBe("US");
    expect(params.p_card_0).toBe("credit");
  });

  it("emits date/funnel/refund post-filters as HAVING", () => {
    const nreq = normalizeCohortRequest({ date_from: "2026-01-01", date_to: "2026-03-01", filters: { refund_status: "has" } });
    const params: Record<string, unknown> = { auth_user_id: "u" };
    const sql = buildListQuery(nreq, params);
    expect(sql).toContain("cohort_date >= {date_from:String}");
    expect(sql).toContain("cohort_date <= {date_to:String}");
    expect(sql).toContain("refund_raw > 0");
  });

  it("adds Support metrics with a deduped email semi-join, not a many-to-many join", () => {
    const nreq = normalizeCohortRequest({});
    const sql = buildListQuery(nreq, { auth_user_id: "u" });
    expect(sql).toContain("support_emails AS");
    expect(sql).toContain("SELECT DISTINCT lowerUTF8(trim(BOTH ' ' FROM normalized_email))");
    expect(sql).toContain("FROM fact_support_requests FINAL");
    expect(sql).toContain("uniqExactIf(");
    expect(sql).toContain("uid,");
    expect(sql).toContain("IN (SELECT normalized_email FROM support_emails)");
    expect(sql).not.toMatch(/JOIN\s+fact_support_requests/i);
  });

  it("keeps Cohorts on ClickHouse when Support data is empty or unavailable", () => {
    const nreq = normalizeCohortRequest({});
    const sql = buildListQuery(nreq, { auth_user_id: "u" }, "empty_source");
    expect(sql).toContain("support_emails AS (SELECT '' AS normalized_email WHERE 0)");
    expect(sql).not.toContain("FROM fact_support_requests FINAL");
    expect(sql).toContain("uniqExactIf(");
  });
});

function rawAgg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cohort_date: "2026-05-01", funnel: "soulmate", campaign_path: "unknown", trial_users: 100,
    gross_raw: 1000.005, refund_raw: 50, d0_raw: 200, d7_raw: 600, d14_raw: 700, d30_raw: 800, d60_raw: 900,
    trial_rev_raw: 80, first_sub_rev_raw: 500, renewal_rev_raw: 250, upsell_rev_raw: 120,
    first_subscription_users: 40, renewal_users: 12, r2: 8, r3: 3, r4: 1, r5: 0, r6: 0,
    upsell_users: 20, funnel_upsell_users: 20, funnel_upsell_rev_raw: 130,
    upsell_1_users: 18, upsell_2_users: 2, upsell_3_users: 0, upsell_extra_users: 0,
    u1_raw: 120, u2_raw: 10, u3_raw: 0, uextra_raw: 0,
    token_purchases: 5, token_buyers: 4, token_gross_raw: 30, token_refund_raw: 5,
    refund_users: 3, support_users: 8, ...over,
  };
}

describe("clickhouse-cohorts aggregate mapping + totals", () => {
  it("rounds money half-up and computes addon = u1+u2+u3+token_net", () => {
    const row = toAggregateRow(rawAgg() as never);
    expect(row.gross_revenue).toBe(1000.01); // 1000.005 -> half-up
    expect(row.net_revenue).toBe(950.01);
    expect(row.token_net_revenue).toBe(25); // 30 - 5
    expect(row.addon_revenue).toBe(155); // 120 + 10 + 0 + 25
    expect(row.renewal_users_by_level).toEqual({ 2: 8, 3: 3, 4: 1 });
    expect(row.support_users).toBe(8);
    expect(row.support_rate).toBe(8);
    // Subscription metrics stay 0 (deferred, not zero-proven).
    expect(row.active_users).toBe(0);
    expect(row.net_revenue_1m).toBe(row.revenue_d30);
  });

  it("recomputes totals additively (never averages rows)", () => {
    const a = toAggregateRow(rawAgg({ cohort_date: "2026-05-01" }) as never);
    const b = toAggregateRow(rawAgg({ cohort_date: "2026-05-02", trial_users: 50, r2: 2 }) as never);
    const totals = computeTotals([a, b] as CohortAggregateRow[]);
    expect(totals.trial_users).toBe(150);
    expect(totals.support_users).toBe(16);
    expect(totals.support_rate).toBeCloseTo((16 / 150) * 100, 8);
    expect(totals.renewal_users_by_level[2]).toBe(10); // 8 + 2
    expect(totals.gross_revenue).toBe(2000.02);
    // Weighted LTV = sum(d30) / sum(trial_users), not an average of per-row LTVs.
    expect(totals.ltv_1m_per_user).toBe(Math.floor((1600 / 150) * 100 + 0.5) / 100);
  });

  it("handles Support Users = 0 and Trial Users = 0 safely", () => {
    const row = toAggregateRow(rawAgg({ trial_users: 0, support_users: 4 }) as never);
    const zero = toAggregateRow(rawAgg({ trial_users: 50, support_users: 0 }) as never);
    const totals = computeTotals([row, zero] as CohortAggregateRow[]);
    expect(row.support_users).toBe(4);
    expect(row.support_rate).toBe(0);
    expect(zero.support_rate).toBe(0);
    expect(totals.support_users).toBe(4);
    expect(totals.support_rate).toBe(8);
  });
});

describe("clickhouse-cohorts support data status", () => {
  function clientFor(rowsByQuery: Array<unknown[]>): { query: () => Promise<{ json: () => Promise<unknown[]> }> } {
    let i = 0;
    return {
      query: async () => {
        const rows = rowsByQuery[i++] ?? [];
        return { json: async () => rows };
      },
    };
  }

  it("reports ready with support request and unique email counts", async () => {
    const status = await supportDataStatus(clientFor([[{ c: 1 }], [{ support_requests: 3, support_unique_emails: 2 }]]) as never, "u");
    expect(status).toEqual({ support_data_status: "ready", support_requests: 3, support_unique_emails: 2 });
  });

  it("reports empty_source, sync_pending, and unavailable without throwing", async () => {
    await expect(supportDataStatus(clientFor([[{ c: 1 }], [{ support_requests: 0, support_unique_emails: 0 }], [{ c: 0 }]]) as never, "u"))
      .resolves.toMatchObject({ support_data_status: "empty_source" });
    await expect(supportDataStatus(clientFor([[{ c: 1 }], [{ support_requests: 0, support_unique_emails: 0 }], [{ c: 9 }]]) as never, "u"))
      .resolves.toMatchObject({ support_data_status: "sync_pending" });
    await expect(supportDataStatus({ query: async () => { throw new Error("no table"); } } as never, "u"))
      .resolves.toMatchObject({ support_data_status: "unavailable" });
  });
});
