import { describe, expect, it } from "vitest";
import {
  CANCELLATION_FAILURE_WINDOW_MS,
  CANCELLATION_PURCHASE_WINDOW_MS,
  cancellationFlagsCTE,
  cancellationMeasuresSQL,
} from "../../supabase/functions/_shared/clickhouse/cohortCancellations.ts";
import { AGGREGATE_MEASURES, buildListQuery, normalizeCohortRequest } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import { buildMaterializedCohortListQuery } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { ALL_SCOPE_SQL, SUB_COLS, subscriptionsFrom } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

describe("cohort cancellation SQL", () => {
  it("classifies per subscription: the explicit user reason always wins, a period-end match next", () => {
    const cte = cancellationFlagsCTE(ALL_SCOPE_SQL);
    expect(cte).toContain("FROM fact_subscriptions AS s FINAL");
    expect(cte).toContain("(positionCaseInsensitive(s.status, 'cancel') > 0 OR s.renews = 0)");
    expect(cte).toContain(`- ${CANCELLATION_FAILURE_WINDOW_MS}`);
    expect(CANCELLATION_FAILURE_WINDOW_MS).toBe(172_800_000);
    expect(cte).toContain("FROM analytics_transactions AS f FINAL");
    expect(cte).toContain("max(c.user_requested) cf_user_requested");
    expect(cte).toContain("AND (c.user_requested OR (c.cancelled_at IS NOT NULL\n      AND c.period_ends_at IS NOT NULL AND c.cancelled_at < c.period_ends_at))) cf_user");
    expect(cte).toContain("AND NOT c.user_requested AND c.cancelled_at >= c.period_ends_at) cf_auto_period");
    expect(cte).not.toMatch(/\bemail\b/);
  });

  it("ignores checkout declines and never makes an explicit user request automatic", () => {
    const cte = cancellationFlagsCTE(ALL_SCOPE_SQL);
    const cauto = cte.slice(cte.indexOf("cauto AS ("), cte.indexOf("cflags AS ("));
    expect(cauto).toContain("WHERE c.cancelled_at IS NOT NULL AND NOT c.user_requested");
    expect(cauto).toContain("AND ft.fts <= toUnixTimestamp64Milli(c.cancelled_at)");
    // An upsell declined right after a 3-day trial purchase (or a first card
    // declined before it) is a checkout decline, not a failed charge.
    expect(cauto).toContain(`AND (c.started_at IS NULL OR ft.fts >= toUnixTimestamp64Milli(c.started_at) + ${CANCELLATION_PURCHASE_WINDOW_MS})`);
    expect(CANCELLATION_PURCHASE_WINDOW_MS).toBe(7_200_000);
    // period_ends_at does not bound it: FunnelFox moves it past a paid trial's first charge.
    expect(cauto).not.toContain("period_ends_at");
    expect(cte).toContain("s.started_at started_at");
    expect(SUB_COLS).toContain("started_at");
  });

  it("counts members by precedence: user reason > auto (failed) > user > auto (period end)", () => {
    const measures = cancellationMeasuresSQL();
    expect(measures).toContain("IN (SELECT sub_email FROM cflags)) cancelled_users");
    expect(measures).toContain("IN (SELECT sub_email FROM cflags WHERE cf_user_requested = 1 OR (cf_auto_failed = 0 AND cf_user = 1))) user_cancelled_users");
    expect(measures).toContain("IN (SELECT sub_email FROM cflags WHERE cf_user_requested = 0 AND (cf_auto_failed = 1 OR (cf_user = 0 AND cf_auto_period = 1)))) auto_cancelled_users");
    expect(measures).toContain("IN (SELECT sub_email FROM cflags WHERE cf_still_paid = 1)) cancelled_active_users");
    expect(AGGREGATE_MEASURES).toContain(measures);
  });

  it("puts the flags into both engines' list queries", () => {
    const request = { action: "list" as const, filters: {} };
    const cte = cancellationFlagsCTE(ALL_SCOPE_SQL);
    expect(buildMaterializedCohortListQuery(request, { warehouse_version: "wh_1", classification_version: "cv_1" }, { auth_user_id: "u" })).toContain(cte);
    expect(buildListQuery(normalizeCohortRequest(request), { auth_user_id: "u" })).toContain(cte);
  });

  it("reads fact_subscriptions through a scope helper that never exposes the raw email", () => {
    expect(subscriptionsFrom(ALL_SCOPE_SQL, "s")).toBe("fact_subscriptions AS s FINAL");
    expect(SUB_COLS).toContain("normalized_email");
    expect(SUB_COLS).not.toContain("email");
  });
});

describe("cohort cancellation counts on the client", () => {
  it("maps the server counts with rates and cohort-scoped ids for the Total row", () => {
    const row = mapAggregateToCohortRow({
      cohort_date: "2026-10-01", funnel: "unknown", campaign_path: "test-iq", trial_users: 10,
      upsell_users: 0, first_subscription_users: 4, renewal_users: 1, renewal_users_by_level: {}, refund_users: 0,
      support_users: 0, support_rate: 0, active_users: 2, active_subscriptions: 2,
      cancelled_users: 5, user_cancelled_users: 3, auto_cancelled_users: 2, cancelled_active_users: 1,
    } as unknown as CohortAggregateRow);
    expect(row).toMatchObject({
      cancelled_users: 5, cancellation_rate: 50,
      user_cancelled_users: 3, user_cancel_rate: 30,
      auto_cancelled_users: 2, auto_cancel_rate: 20,
      cancelled_active_users: 1,
    });
    expect(row.cancelled_user_ids).toHaveLength(5);
    expect(row.user_cancelled_user_ids).toHaveLength(3);
    expect(row.auto_cancelled_user_ids).toHaveLength(2);
    expect(new Set([...row.cancelled_user_ids, ...row.user_cancelled_user_ids]).size).toBe(8);
  });
});
