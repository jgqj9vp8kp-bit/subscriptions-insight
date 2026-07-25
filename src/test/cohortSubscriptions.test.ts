import { describe, expect, it } from "vitest";
import {
  activeSubscriptionMetricsByCohort,
  mergeActiveSubscriptions,
} from "../../supabase/functions/_shared/clickhouse/cohortSubscriptions";

// Fakes: the RPC returns the jsonb {email: [sub_ids]}; the ClickHouse query
// returns the snapshot's (email, cohort_date, funnel, campaign_path) rows.
function fakeSupabase(rpcData: unknown) {
  return {
    from: () => { throw new Error("unexpected .from()"); },
    rpc: async (fn: string) => {
      expect(fn).toBe("active_funnelfox_subscription_emails");
      return { data: rpcData, error: null };
    },
  } as never;
}

function fakeClickhouse(rows: unknown[]) {
  return {
    query: async () => ({ json: async () => rows }),
  } as never;
}

const metricsInput = (supabase: unknown, clickhouse: unknown) => ({
  supabase: supabase as never,
  clickhouse: clickhouse as never,
  authUserId: "u",
  warehouseVersion: "wh",
  classificationVersion: "cv",
});

describe("activeSubscriptionMetricsByCohort", () => {
  it("counts distinct active users and subscriptions per cohort by email", async () => {
    const supabase = fakeSupabase({
      "a@x.com": ["s1", "s2"], // 2 active subs, one email
      "b@x.com": ["s3"],
      "c@x.com": ["s4"], // in a different cohort
    });
    const clickhouse = fakeClickhouse([
      { email: "a@x.com", cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch" },
      { email: "b@x.com", cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch" },
      { email: "c@x.com", cohort_date: "2026-07-02", funnel: "palm", campaign_path: "reading" },
      { email: "nosub@x.com", cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch" },
    ]);

    const map = await activeSubscriptionMetricsByCohort(metricsInput(supabase, clickhouse));

    // Cohort 1: users a,b (2), subs s1,s2,s3 (3). Cohort 2: user c (1), sub s4 (1).
    expect(map.get("2026-07-01|soulmate|sketch")).toEqual({
      active_users: 2,
      active_subscriptions: 3,
      active_subscription_ids: ["s1", "s2", "s3"],
      active_user_ids: ["a@x.com", "b@x.com"],
    });
    expect(map.get("2026-07-02|palm|reading")).toEqual({
      active_users: 1,
      active_subscriptions: 1,
      active_subscription_ids: ["s4"],
      active_user_ids: ["c@x.com"],
    });
    // The email with no active subscription contributes nothing.
    expect(map.size).toBe(2);
  });

  it("short-circuits to an empty map when there are no active subscriptions", async () => {
    let clickhouseCalled = false;
    const clickhouse = { query: async () => { clickhouseCalled = true; return { json: async () => [] }; } } as never;
    const map = await activeSubscriptionMetricsByCohort(metricsInput(fakeSupabase({}), clickhouse));
    expect(map.size).toBe(0);
    expect(clickhouseCalled).toBe(false); // no snapshot scan when nothing is active
  });

  it("is case/whitespace-insensitive on the email join", async () => {
    const supabase = fakeSupabase({ "a@x.com": ["s1"] });
    const clickhouse = fakeClickhouse([
      { email: "a@x.com", cohort_date: "d", funnel: "f", campaign_path: "p" },
    ]);
    const map = await activeSubscriptionMetricsByCohort(metricsInput(supabase, clickhouse));
    expect(map.get("d|f|p")).toEqual({
      active_users: 1,
      active_subscriptions: 1,
      active_subscription_ids: ["s1"],
      active_user_ids: ["a@x.com"],
    });
  });
});

describe("mergeActiveSubscriptions", () => {
  it("overlays metrics onto matching rows by cohort key and leaves others at 0", () => {
    const rows = [
      { cohort_date: "2026-07-01", funnel: "soulmate", campaign_path: "sketch", active_users: 0, active_subscriptions: 0 },
      { cohort_date: "2026-07-09", funnel: "soulmate", campaign_path: "quiz", active_users: 0, active_subscriptions: 0 },
    ];
    mergeActiveSubscriptions(
      rows,
      new Map([["2026-07-01|soulmate|sketch", {
        active_users: 2,
        active_subscriptions: 3,
        active_subscription_ids: ["s1", "s2", "s3"],
        active_user_ids: ["a@x.com", "b@x.com"],
      }]]),
    );
    expect(rows[0]).toMatchObject({
      active_users: 2,
      active_subscriptions: 3,
      active_subscription_ids: ["s1", "s2", "s3"],
      active_user_ids: ["a@x.com", "b@x.com"],
    });
    expect(rows[1]).toMatchObject({ active_users: 0, active_subscriptions: 0 });
  });
});
