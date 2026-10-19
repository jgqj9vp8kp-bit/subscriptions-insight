import { describe, expect, it } from "vitest";
import {
  COHORT_DECLINE_GROUPS,
  DECLINE_CHECKOUT_WINDOW_MS,
  DECLINE_STAGES,
  DEFAULT_DECLINE_STAGE,
  declineGroupField,
  isDeclineStage,
  projectDeclineStage,
  COHORT_PAYMENT_FAILURE_FIELDS,
  paymentFailureCountsFromRaw,
  paymentFailureMeasuresSQL,
  presentPaymentFailureCounts,
  sumPresentPaymentFailureCounts,
} from "../../supabase/functions/_shared/clickhouse/cohortPaymentFailures.ts";
import { AGGREGATE_MEASURES, buildListQuery, normalizeCohortRequest } from "../../supabase/functions/_shared/clickhouse/cohorts.ts";
import { buildMaterializedCohortListQuery } from "../../supabase/functions/_shared/clickhouse/cohortMembership.ts";
import { TX_COLS } from "../../supabase/functions/_shared/clickhouse/scopeSql.ts";
import { DECLINE_REASON_VALUES } from "../../supabase/functions/_shared/clickhouse/paymentFailures.ts";
import { mapAggregateToCohortRow } from "@/services/cohortsDataSource";
import type { CohortAggregateRow } from "../../supabase/functions/_shared/clickhouse/cohortContract.ts";

describe("cohort payment-failure metrics", () => {
  it("measures declined charges after the trial by stage and reason group", () => {
    const sql = paymentFailureMeasuresSQL();
    for (const field of COHORT_PAYMENT_FAILURE_FIELDS) expect(sql).toContain(` ${field}`);
    expect(sql).toContain("uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl = 0) failed_after_trial_users");
    expect(sql).toContain("uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl >= 2) failed_after_renewal_users");
    expect(sql).toContain("dr IN ('do_not_honor', 'generic_decline')) decline_do_not_honor_users");
    expect(AGGREGATE_MEASURES).toContain(sql);
  });

  it("splits every reason group by stage; the bare column is the after-trial stage", () => {
    const sql = paymentFailureMeasuresSQL();
    const measures = sql.split(",\n  ");
    const measureOf = (field: string) => measures.find((measure) => measure.endsWith(` ${field}`)) ?? "";
    for (const group of COHORT_DECLINE_GROUPS) {
      expect(measureOf(group.column)).toContain("statusType = 'failed_payment' AND pre_lvl = 0 AND dr ");
      expect(measureOf(declineGroupField(group.column, "first_sub"))).toContain("AND pre_lvl = 1 AND dr ");
      expect(measureOf(declineGroupField(group.column, "renewal"))).toContain("AND pre_lvl >= 2 AND dr ");
      expect(measureOf(declineGroupField(group.column, "all"))).not.toContain("pre_lvl");
      expect(sql).toContain(`) ${declineGroupField(group.column, "first_sub")}`);
      expect(sql).toContain(`) ${declineGroupField(group.column, "renewal")}`);
      expect(sql).toContain(`) ${declineGroupField(group.column, "all")}`);
    }
    expect(sql).toContain("uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl = 0 AND dr IN ('insufficient_funds')) decline_insufficient_funds_users");
    expect(sql).toContain("uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl = 1 AND dr IN ('insufficient_funds')) decline_insufficient_funds_users_first_sub");
    expect(sql).toContain("uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl >= 2 AND dr IN ('insufficient_funds')) decline_insufficient_funds_users_renewal");
    expect(sql).toContain("uniqExactIf(uid, statusType = 'failed_payment' AND dr IN ('insufficient_funds')) decline_insufficient_funds_users_all");
    expect(COHORT_PAYMENT_FAILURE_FIELDS).toHaveLength(6 + COHORT_DECLINE_GROUPS.length * DECLINE_STAGES.length);
    expect(DECLINE_STAGES.map((entry) => entry.stage)).toEqual(["trial", "checkout", "first_charge", "first_sub", "renewal", "all"]);
    expect(DEFAULT_DECLINE_STAGE).toBe("trial");
  });

  it("splits the after-trial stage at the trial purchase + 2 h: checkout vs the first charge", () => {
    const sql = paymentFailureMeasuresSQL();
    const measures = sql.split(",\n  ");
    const measureOf = (field: string) => measures.find((measure) => measure.endsWith(` ${field}`)) ?? "";
    expect(DECLINE_CHECKOUT_WINDOW_MS).toBe(7_200_000);
    expect(measureOf("failed_at_checkout_users")).toBe(
      "uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl = 0 AND ets < trial_ts + 7200000) failed_at_checkout_users",
    );
    expect(measureOf("failed_first_charge_users")).toBe(
      "uniqExactIf(uid, statusType = 'failed_payment' AND pre_lvl = 0 AND ets >= trial_ts + 7200000) failed_first_charge_users",
    );
    for (const group of COHORT_DECLINE_GROUPS) {
      expect(measureOf(declineGroupField(group.column, "checkout"))).toContain("AND pre_lvl = 0 AND ets < trial_ts + 7200000 AND dr ");
      expect(measureOf(declineGroupField(group.column, "first_charge"))).toContain("AND pre_lvl = 0 AND ets >= trial_ts + 7200000 AND dr ");
    }
    expect(declineGroupField("decline_fraud_users", "checkout")).toBe("decline_fraud_users_checkout");
    expect(declineGroupField("decline_fraud_users", "first_charge")).toBe("decline_fraud_users_first_charge");
    // Both engines' finx rows carry the row and trial times the split reads.
    const request = { action: "list" as const, filters: {} };
    for (const query of [
      buildMaterializedCohortListQuery(request, { warehouse_version: "wh_1", classification_version: "cv_1" }, { auth_user_id: "u" }),
      buildListQuery(normalizeCohortRequest(request), { auth_user_id: "u" }),
    ]) {
      const finx = query.slice(query.indexOf("finx AS ("));
      expect(finx).toMatch(/SELECT [^\n]*\bets\b[^\n]*\btrial_ts\b/);
      expect(query).toContain("failed_at_checkout_users");
    }
  });

  it("projects a row onto the chosen stage for every reason column", () => {
    const row = {
      trial_users: 10,
      decline_fraud_users: 4, decline_fraud_users_first_sub: 1, decline_fraud_users_renewal: 0, decline_fraud_users_all: 5,
      decline_insufficient_funds_users: 2,
    };
    expect(projectDeclineStage(row, "trial")).toBe(row);
    expect(projectDeclineStage(row, "first_sub")).toMatchObject({ trial_users: 10, decline_fraud_users: 1 });
    expect(projectDeclineStage(row, "all").decline_fraud_users).toBe(5);
    expect(projectDeclineStage({ ...row, decline_fraud_users_checkout: 3, decline_fraud_users_first_charge: 2 }, "checkout").decline_fraud_users).toBe(3);
    expect(projectDeclineStage({ ...row, decline_fraud_users_checkout: 3, decline_fraud_users_first_charge: 2 }, "first_charge").decline_fraud_users).toBe(2);
    expect(isDeclineStage("checkout")).toBe(true);
    expect(isDeclineStage("first_charge")).toBe(true);
    // A stage the row does not carry (older cache) leaves the column absent → "—".
    expect("decline_insufficient_funds_users" in projectDeclineStage(row, "renewal")).toBe(false);
    expect(row.decline_fraud_users).toBe(4);
    expect(isDeclineStage("renewal")).toBe(true);
    expect(isDeclineStage("weekly")).toBe(false);
  });

  it("files every known decline reason into exactly one named group, the rest into Other", () => {
    const named = COHORT_DECLINE_GROUPS.flatMap((group) => group.reasons ?? []);
    expect(new Set(named).size).toBe(named.length);
    for (const reason of named) expect(DECLINE_REASON_VALUES).toContain(reason);
    expect(COHORT_DECLINE_GROUPS.filter((group) => group.reasons === null)).toHaveLength(1);
    const other = DECLINE_REASON_VALUES.filter((reason) => !named.includes(reason));
    expect(other).toEqual(expect.arrayContaining(["unknown", "issuer_unavailable", "card_velocity_exceeded", "processing_error"]));
  });

  it("exposes the reason and the pre-level on the materialized and dynamic cohort rows", () => {
    const request = { action: "list" as const, filters: {} };
    const materialized = buildMaterializedCohortListQuery(request, { warehouse_version: "wh_1", classification_version: "cv_1" }, { auth_user_id: "u" });
    expect(materialized).toContain("if(a.status = 'failed', if(a.decline_reason = '', 'unknown', a.decline_reason), '') dr");
    expect(materialized).toContain("p.dr dr, ifNull(max(if(p.is_success = 1, ifNull(li.lvl, 0), 0)) OVER (PARTITION BY p.uid ORDER BY p.ets, p.tprio, p.tid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) pre_lvl");
    expect(materialized).toContain("'' dr, 0 pre_lvl");
    expect(materialized).toContain("failed_payment_users");

    const dynamic = buildListQuery(normalizeCohortRequest(request), { auth_user_id: "u" });
    expect(dynamic).toContain("fdr AS (");
    expect(dynamic).toContain("FROM fin AS f LEFT JOIN fdr ON fdr.tid = f.tid");
    expect(dynamic).toContain("decline_other_users");
    // The shared classifier (snapshot rebuild, Users, Payment) stays untouched.
    expect(dynamic.slice(0, dynamic.indexOf("-- Payment-failure columns"))).not.toContain("decline_reason");
  });

  it("lets a funnel-restricted scope read the normalized decline token", () => {
    expect(TX_COLS).toContain("decline_reason");
    expect(TX_COLS).not.toContain("raw_payload");
    expect(TX_COLS).not.toContain("normalized_payload");
  });

  it("parses, keeps only present counts and sums them", () => {
    const parsed = paymentFailureCountsFromRaw({ failed_payment_users: "3", decline_fraud_users: 1 });
    expect(parsed.failed_payment_users).toBe(3);
    expect(parsed.decline_fraud_users).toBe(1);
    expect(parsed.decline_other_users).toBe(0);
    expect(presentPaymentFailureCounts({ failed_payment_users: 2, decline_fraud_users: "x" })).toEqual({ failed_payment_users: 2 });
    expect(sumPresentPaymentFailureCounts([{ failed_payment_users: 2 }, {}, { failed_payment_users: 3, decline_3ds_users: 1 }]))
      .toEqual({ failed_payment_users: 5, decline_3ds_users: 1 });
    expect(sumPresentPaymentFailureCounts([{}, {}])).toEqual({});
  });

  it("maps server counts onto the cohort row, and leaves them absent for an older response", () => {
    const base = {
      cohort_date: "2026-10-01", funnel: "unknown", campaign_path: "test-iq", trial_users: 10,
      upsell_users: 0, first_subscription_users: 4, renewal_users: 1, renewal_users_by_level: {}, refund_users: 1,
      support_users: 0, support_rate: 0, active_users: 0, active_subscriptions: 0, cancelled_users: 0,
      user_cancelled_users: 0, auto_cancelled_users: 0, cancelled_active_users: 0,
    } as unknown as CohortAggregateRow;
    const withCounts = mapAggregateToCohortRow({ ...base, failed_payment_users: 3, decline_insufficient_funds_users: 2 } as CohortAggregateRow);
    expect(withCounts.failed_payment_users).toBe(3);
    expect(withCounts.decline_insufficient_funds_users).toBe(2);
    expect(withCounts.decline_fraud_users).toBeUndefined();
    const older = mapAggregateToCohortRow(base);
    expect(older.failed_payment_users).toBeUndefined();
  });
});
