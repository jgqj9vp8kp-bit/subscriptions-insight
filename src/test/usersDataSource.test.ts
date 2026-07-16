import { describe, expect, it } from "vitest";
import { buildUsersRequest, mapUsersRow, type UsersQuery } from "@/services/usersDataSource";
import type { UsersRow } from "../../supabase/functions/_shared/clickhouse/usersContract";

const baseQuery: UsersQuery = { sortField: "first_trial_date", sortDir: "desc", page: 1, pageSize: 50 };

describe("buildUsersRequest", () => {
  it("maps page has/none tri-states to yes/no and thresholds", () => {
    const req = buildUsersRequest({ ...baseQuery, firstSub: "has", refund: "none", paymentFailed: "has", failedAttempts: "gte3" });
    expect(req.filters?.first_sub).toBe("yes");
    expect(req.filters?.refund).toBe("no");
    expect(req.filters?.payment_failed).toBe("yes");
    expect(req.filters?.failed_attempts_min).toBe(3);
  });

  it("passes sort + pagination through", () => {
    const req = buildUsersRequest({ ...baseQuery, sortField: "total_revenue", sortDir: "asc", page: 3, pageSize: 50 });
    expect(req.sort).toEqual({ field: "total_revenue", direction: "asc" });
    expect(req.pagination).toEqual({ page: 3, page_size: 50 });
  });

  it("omits 'all' single-select filters and forwards multi-selects + search", () => {
    const req = buildUsersRequest({ ...baseQuery, campaignPath: "all", country: "US", cardTypes: ["debit"], search: " a@b.com " });
    expect(req.filters?.campaign_path).toEqual([]);
    expect(req.filters?.country).toEqual(["US"]);
    expect(req.filters?.card_type).toEqual(["debit"]);
    expect(req.filters?.search).toBe("a@b.com");
  });
});

describe("mapUsersRow", () => {
  it("maps a server UsersRow onto the explorer row shape", () => {
    const row = {
      user_id: "u1", email: "x@y.com", country_code: "US", card_type: "debit", media_buyer: "Ivan", funnel: "soulmate",
      campaign_path: "p", cohort_id: "soulmate_p_2026-05-01", cohort_date: "2026-05-01", cohort_funnel: "soulmate",
      first_trial_date: "2026-05-01", total_revenue: 10, has_upsell: true, has_first_subscription: true, has_refund: false,
      total_refund_usd: 0, renewal_count: 2, user_ltv: 10, has_failed_payment: true, latest_decline_reason: "generic_decline",
      latest_decline_stage: "processor", latest_decline_message: null, latest_decline_date: "2026-06-01", failed_payment_count: 3,
      active_subscription: false, cancelled: false, plan_price: 30, plan_name: "$30.00", utm_source: "fb",
      first_trial_amount_original: 1, first_trial_currency: "USD", first_trial_amount_usd: 1,
      first_subscription_date: null, first_subscription_amount_usd: 0, highest_subscription_level: 1, lifecycle_state: "first_subscription",
      gross_revenue_usd: 12, net_revenue_usd: 10, successful_payment_count: 4,
      upsell_1_count: 1, upsell_2_count: 0, upsell_3_count: 0, upsell_extra_count: 0, upsell_revenue: 5,
      token_purchase_count: 0, token_gross_revenue: 0, token_net_revenue: 0, addon_revenue: 5,
      active_subscription_count: 0, subscription_status: null, renews: null, period_ends_at: null, cancelled_at: null, cancellation_reason: null,
    } as UsersRow;
    const mapped = mapUsersRow(row);
    expect(mapped.user_id).toBe("u1");
    expect(mapped.campaign_path).toBe("p");
    expect(mapped.cohort_funnel).toBe("soulmate");
    expect(mapped.active_subscription).toBe(false);
    expect(mapped.renewal_count).toBe(2);
    expect(mapped.latest_decline_reason).toBe("generic_decline");
    expect(mapped.has_first_subscription).toBe(true);
  });
});
