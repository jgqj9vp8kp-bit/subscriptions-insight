import { describe, expect, it } from "vitest";
import {
  UsersRequestError,
  normalizeUsersAction,
  normalizeUsersRequest,
  userAggCTE,
  userWhere,
  toRow,
  SORT_ALLOWLIST,
} from "../../supabase/functions/_shared/clickhouse/users.ts";

describe("clickhouse-users request validation", () => {
  it("normalizes actions and rejects unknown ones", () => {
    expect(normalizeUsersAction(undefined)).toBe("list");
    expect(normalizeUsersAction("summary")).toBe("summary");
    expect(normalizeUsersAction("details")).toBe("details");
    expect(normalizeUsersAction("options")).toBe("options");
    expect(() => normalizeUsersAction("delete_users")).toThrow(UsersRequestError);
  });

  it("rejects malformed dates", () => {
    expect(() => normalizeUsersRequest({ date_from: "07-2026" })).toThrow(UsersRequestError);
    expect(normalizeUsersRequest({ date_from: "2026-06-01" }).dateFrom).toBe("2026-06-01");
  });

  it("only allows sort fields on the allowlist (no arbitrary SQL columns)", () => {
    expect(normalizeUsersRequest({ sort: { field: "total_revenue", direction: "asc" } }).sortField).toBe("total_revenue");
    expect(normalizeUsersRequest({ sort: { field: "gross_revenue", direction: "desc" } }).sortField).toBe("gross_revenue_usd");
    expect(() => normalizeUsersRequest({ sort: { field: "user_id; DROP TABLE", direction: "desc" } })).toThrow(UsersRequestError);
    expect(SORT_ALLOWLIST.first_trial_date).toBe("first_trial_date");
  });

  it("clamps pagination (default 100, max 500)", () => {
    expect(normalizeUsersRequest({}).pageSize).toBe(100);
    expect(normalizeUsersRequest({ pagination: { page: 1, page_size: 5000 } }).pageSize).toBe(500);
    expect(normalizeUsersRequest({ pagination: { page: 0, page_size: 50 } }).page).toBe(1);
  });

  it("maps tri-state filters and failed-attempts threshold", () => {
    const nreq = normalizeUsersRequest({ filters: { first_sub: "yes", refund: "no", payment_failed: "bad" as never, failed_attempts_min: 3 } });
    expect(nreq.filters.first_sub).toBe("yes");
    expect(nreq.filters.refund).toBe("no");
    expect(nreq.filters.payment_failed).toBe("all");
    expect(nreq.filters.failed_attempts_min).toBe(3);
  });

  it("rejects non-array filters", () => {
    expect(() => normalizeUsersRequest({ filters: { funnel: "soulmate" as never } })).toThrow(UsersRequestError);
  });
});

describe("clickhouse-users SQL scoping + safety", () => {
  it("always scopes the aggregate by auth_user_id via a bound parameter", () => {
    const params: Record<string, unknown> = {};
    const sql = userAggCTE("user-42", params, "2026-07-11 00:00:00.000");
    expect(sql).toContain("auth_user_id = {auth_user_id:String}");
    expect(params.auth_user_id).toBe("user-42");
    expect(params.now).toBe("2026-07-11 00:00:00.000");
  });

  it("never selects raw payloads", () => {
    const sql = userAggCTE("u", {}, "2026-07-11 00:00:00.000");
    expect(sql).not.toMatch(/raw_payload/);
    expect(sql).not.toMatch(/normalized_payload/);
  });

  it("binds the search value as a parameter (no interpolation)", () => {
    const nreq = normalizeUsersRequest({ filters: { search: "a@b.com' OR 1=1" } });
    const params: Record<string, unknown> = {};
    const where = userWhere(nreq, params);
    expect(where).not.toContain("OR 1=1");
    expect(where).toContain("positionCaseInsensitive(email, {search:String})");
    expect(params.search).toBe("a@b.com' OR 1=1");
  });

  it("binds list filters as parameters and maps tri-states to predicates", () => {
    const nreq = normalizeUsersRequest({ filters: { first_sub: "yes", refund: "no", country: ["US", "MX"], failed_attempts_min: 5 } });
    const params: Record<string, unknown> = {};
    const where = userWhere(nreq, params);
    expect(where).toContain("has_first_subscription");
    expect(where).toContain("NOT has_refund");
    expect(where).toContain("country_code IN ({p_co_0:String}, {p_co_1:String})");
    expect(where).toContain("failed_payment_count >= {fa_min:UInt32}");
    expect(params.p_co_0).toBe("US");
    expect(params.fa_min).toBe(5);
  });

  it("reads the platform verdict from the materialized column, exactly as Cohorts does", () => {
    // The Users and Cohorts pages must never disagree about a user's OS. They
    // agree only because both read analytics_transactions.platform with the same
    // aggregate — the moment one of them re-derives the verdict from a user
    // agent, the two pages start answering the same question differently.
    const sql = userAggCTE("u", {}, "2026-07-11 00:00:00.000");
    expect(sql).toContain("argMin(if(platform = '', 'unknown', platform), (multiIf(platform = '', 2, is_success = 1, 0, 1), event_time, transaction_id)) pplatform");
    // Aliasing the aggregate `platform` would let ClickHouse substitute the
    // sibling alias for the source column — the trap that silently emptied
    // price_breakdown twice in this codebase.
    expect(sql).not.toMatch(/\)\s+platform,/);
    expect(sql).toContain("ar.pplatform platform,");
  });

  it("binds the platform filter and gives it its own placeholder prefix", () => {
    // runUsersOptions calls userWhere twice into ONE params object, so a prefix
    // shared with another filter would rebind that filter's values.
    const nreq = normalizeUsersRequest({ filters: { platform: ["ios", "android"], card_type: ["debit"] } });
    const params: Record<string, unknown> = {};
    const where = userWhere(nreq, params);
    expect(where).toContain("platform IN ({p_plt_0:String}, {p_plt_1:String})");
    expect(params.p_plt_0).toBe("ios");
    expect(params.p_plt_1).toBe("android");
    expect(params.p_ct_0).toBe("debit");
  });

  it("applies media_buyer over the same column the table displays", () => {
    const nreq = normalizeUsersRequest({ filters: { media_buyer: ["Ivan"] } });
    const params: Record<string, unknown> = {};
    expect(userWhere(nreq, params)).toContain("media_buyer IN ({p_mb_0:String})");
    expect(params.p_mb_0).toBe("Ivan");
  });

  it("validates the platform filter like every other list filter", () => {
    expect(() => normalizeUsersRequest({ filters: { platform: "ios" as never } })).toThrow(UsersRequestError);
    expect(normalizeUsersRequest({ filters: { platform: [" ios ", "ios"] } }).filters.platform).toEqual(["ios"]);
  });

  it("date filter excludes users without a first trial", () => {
    const nreq = normalizeUsersRequest({ date_from: "2026-06-01" });
    const where = userWhere(nreq, {});
    expect(where).toContain("first_trial_date IS NOT NULL AND first_trial_date >= {date_from:String}");
  });
});

describe("clickhouse-users toRow mapping", () => {
  it("maps aggregates and rounds money; empty dates become null", () => {
    const row = toRow({
      user_id: "u1", email: "x@y.com", country_code: "US", card_type: "debit", media_buyer: "Ivan", funnel: "soulmate",
      campaign_path: "path", cohort_funnel: "soulmate", cohort_date: "2026-05-01", first_trial_date: "2026-05-01",
      has_first_subscription: 1, renewal_count: 2, total_revenue: 10.005, gross_revenue_usd: 12.004, net_revenue_usd: 10.005,
      total_refund_usd: 0, has_refund: 0, failed_payment_count: 3, has_failed_payment: 1, latest_decline_date: "",
      token_purchase_count: 1, token_gross_revenue: 5, token_net_revenue: 5, addon_revenue: 5, has_upsell: 1,
      active_subscription: 0, cancelled: 0, plan_price: 30,
    });
    expect(row.user_id).toBe("u1");
    expect(row.has_first_subscription).toBe(true);
    expect(row.total_revenue).toBe(10.01); // half-up
    expect(row.gross_revenue_usd).toBe(12);
    expect(row.latest_decline_date).toBeNull(); // '' -> null
    expect(row.cohort_id).toBe("soulmate_path_2026-05-01");
    expect(row.plan_name).toBe("$30.00");
  });
});
