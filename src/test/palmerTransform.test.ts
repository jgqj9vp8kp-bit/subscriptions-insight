import { describe, expect, it } from "vitest";
import { computeCohorts, computeKpis, computeUsers } from "@/services/analytics";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyUserTransactions,
  getPalmerImportDiagnostics,
  normalizeAmount,
  normalizePalmerRows,
  normalizeStatus,
  parseMetadata,
  transformPalmerRows,
} from "@/services/palmerTransform";
import { isKnownTokenAmount, knownAppUpsellPriceIds, knownTokenPriceIds } from "@/services/monetizationProductMap";
import { classifyOneOff, priceSignal, pricePointForTransaction } from "../../supabase/functions/_shared/clickhouse/monetizationTyping.ts";
import { mapSupabaseTransactionToClickHouse } from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import type { Transaction } from "@/services/types";

describe("Palmer transformation", () => {
  it("converts Palmer cents into USD amounts", () => {
    expect(normalizeAmount("100")).toBe(1);
    expect(normalizeAmount("1498")).toBe(14.98);
    expect(normalizeAmount("2999")).toBe(29.99);
  });

  it("keeps already-decimal USD amounts unchanged", () => {
    expect(normalizeAmount("1.00")).toBe(1);
    expect(normalizeAmount("14.98")).toBe(14.98);
    expect(normalizeAmount("29.99")).toBe(29.99);
    expect(normalizeAmount("$29.99")).toBe(29.99);
  });

  it("does NOT divide zero-decimal currencies: an integer yen amount IS the amount", () => {
    // Found live: Palmer sent amount "6415" JPY (¥6,415 ≈ $42) and the importer
    // stored 64.15 — every palm-reading JPY cohort was 100× too small.
    expect(normalizeAmount("6415", "JPY")).toBe(6415);
    expect(normalizeAmount("160", "JPY")).toBe(160);
    expect(normalizeAmount("160", "jpy")).toBe(160);
    expect(normalizeAmount("1000", "KRW")).toBe(1000);
    // Two-decimal currencies keep the minor-units division.
    expect(normalizeAmount("160", "USD")).toBe(1.6);
    expect(normalizeAmount("160", "MXN")).toBe(1.6);
    expect(normalizeAmount("160")).toBe(1.6);
  });

  it("applies the same rule to JPY rows end to end, refunds included", () => {
    const [tx] = transformPalmerRows([{
      id: "jpy-1",
      customerId: "user-jpy",
      createdAt: "2026-07-15T12:25:44Z",
      status: "SETTLED",
      amount: "6415",
      amountRefunded: "6415",
      currencyCode: "JPY",
    }]);
    expect(tx.gross_amount_usd).toBe(6415);
    expect(tx.refund_amount_usd).toBe(6415);
    expect(tx.net_amount_usd).toBe(0);
    expect(tx.currency).toBe("JPY");
    expect(tx.is_refunded).toBe(true);
  });

  it("maps Palmer statuses explicitly", () => {
    expect(normalizeStatus("SETTLED")).toBe("success");
    expect(normalizeStatus("SUCCEEDED")).toBe("success");
    expect(normalizeStatus("PAID")).toBe("success");
    expect(normalizeStatus("SUCCESS")).toBe("success");
    expect(normalizeStatus("AUTHORIZED")).toBe("success");
    expect(normalizeStatus("AUTHORIZATION_FAILED")).toBe("failed");
    expect(normalizeStatus("AUTHORIZATION_DECLINED")).toBe("failed");
    expect(normalizeStatus("DECLINED")).toBe("failed");
    expect(normalizeStatus("FAILED")).toBe("failed");
    expect(normalizeStatus("ERROR")).toBe("failed");
    expect(normalizeStatus("REFUNDED")).toBe("refunded");
    expect(normalizeStatus("DISPUTE")).toBe("chargeback");
    expect(normalizeStatus("DISPUTED")).toBe("chargeback");
    expect(normalizeStatus("CHARGEBACK")).toBe("chargeback");
  });

  it("parses funnel metadata without defaulting unknown values to past_life", () => {
    const known = transformPalmerRows([
      {
        id: "tx_1",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/quiz/soulmate/start" }),
      },
    ]);
    const unknown = transformPalmerRows([
      {
        id: "tx_2",
        user_id: "u_2",
        email: "two@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/quiz/other/start" }),
      },
    ]);

    expect(parseMetadata({ metadata: "{\"utm_campaign\":\"starseed_launch\"}" }).utm_campaign).toBe("starseed_launch");
    expect(known[0].funnel).toBe("soulmate");
    expect(unknown[0].funnel).toBe("unknown");
  });

  it("classifies staged lifecycle payments after first subscription", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "3499",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
      {
        id: "upsell",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T10:45:00Z",
        amount: "4999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a", ff_billing_reason: "post_purchase_upsell" }),
      },
      {
        id: "sub",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-07T10:30:00Z",
        amount: "29.99",
        status: "PAID",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
      {
        id: "renewal_2",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-02-07T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
      {
        id: "renewal_3",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-03-09T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
      {
        id: "renewal",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-05-20T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
    ]);

    expect(rows.find((row) => row.transaction_id === "trial")?.transaction_type).toBe("trial");
    expect(rows.find((row) => row.transaction_id === "upsell")?.transaction_type).toBe("upsell");
    expect(rows.find((row) => row.transaction_id === "sub")?.transaction_type).toBe("first_subscription");
    expect(rows.find((row) => row.transaction_id === "renewal_2")?.transaction_type).toBe("renewal_2");
    expect(rows.find((row) => row.transaction_id === "renewal_3")?.transaction_type).toBe("renewal_3");
    expect(rows.find((row) => row.transaction_id === "renewal")?.transaction_type).toBe("renewal");
    expect(rows.every((row) => row.cohort_id === "past_life_unknown_2026-01-01")).toBe(true);
    expect(rows.find((row) => row.transaction_id === "trial")?.classification_reason).toBe("First successful non-upsell payment → trial");
    expect(rows.find((row) => row.transaction_id === "upsell")?.classification_reason).toBe("Metadata ff_billing_reason contains upsell");
    expect(rows.find((row) => row.transaction_id === "sub")?.classification_reason).toBe("Next successful non-upsell payment after trial → first_subscription");
    expect(rows.find((row) => row.transaction_id === "renewal_2")?.classification_reason).toBe("Second lifecycle payment after first_subscription → renewal_2");
    expect(rows.find((row) => row.transaction_id === "renewal_3")?.classification_reason).toBe("Third lifecycle payment after first_subscription → renewal_3");
    expect(rows.find((row) => row.transaction_id === "renewal")?.classification_reason).toBe("Later lifecycle payment → renewal");
  });

  it("classifies trial to first_subscription to renewal_2 to renewal_3 to renewal", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        user_id: "u_lifecycle",
        email: "lifecycle@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
      },
      {
        id: "first_subscription",
        user_id: "u_lifecycle",
        email: "lifecycle@example.com",
        created_at: "2026-01-08T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
      },
      {
        id: "renewal_2",
        user_id: "u_lifecycle",
        email: "lifecycle@example.com",
        created_at: "2026-02-08T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
      },
      {
        id: "renewal_3",
        user_id: "u_lifecycle",
        email: "lifecycle@example.com",
        created_at: "2026-03-08T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
      },
      {
        id: "renewal",
        user_id: "u_lifecycle",
        email: "lifecycle@example.com",
        created_at: "2026-04-08T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
      },
    ]);

    expect(rows.map((row) => [row.transaction_id, row.transaction_type])).toEqual([
      ["renewal", "renewal"],
      ["renewal_3", "renewal_3"],
      ["renewal_2", "renewal_2"],
      ["first_subscription", "first_subscription"],
      ["trial", "trial"],
    ]);
  });

  it("adds user plan price from the first successful non-upsell transaction and sorts cohort plan breakdown", () => {
    const rows = transformPalmerRows([
      {
        id: "trial_a",
        user_id: "u_plan_a",
        email: "plan-a@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "sub_a",
        user_id: "u_plan_a",
        email: "plan-a@example.com",
        created_at: "2026-01-08T10:00:00Z",
        amount: "5999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "trial_b",
        user_id: "u_plan_b",
        email: "plan-b@example.com",
        created_at: "2026-01-01T11:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "sub_b",
        user_id: "u_plan_b",
        email: "plan-b@example.com",
        created_at: "2026-01-08T11:00:00Z",
        amount: "749",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "trial_c",
        user_id: "u_plan_c",
        email: "plan-c@example.com",
        created_at: "2026-01-01T12:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "sub_c",
        user_id: "u_plan_c",
        email: "plan-c@example.com",
        created_at: "2026-01-08T12:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "trial_d",
        user_id: "u_plan_d",
        email: "plan-d@example.com",
        created_at: "2026-01-01T13:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "sub_d",
        user_id: "u_plan_d",
        email: "plan-d@example.com",
        created_at: "2026-01-08T13:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);

    const users = computeUsers(rows);
    const cohorts = computeCohorts(rows);

    expect(users.find((user) => user.user_id === "u_plan_a")?.plan_price).toBe(1);
    expect(users.find((user) => user.user_id === "u_plan_a")?.plan_name).toBe("$1.00");
    expect(users.find((user) => user.user_id === "u_plan_a")?.plan_assignment_reason).toBe("Plan assigned from first successful non-upsell transaction");
    expect(users.find((user) => user.user_id === "u_plan_b")?.plan_price).toBe(1);
    expect(cohorts[0].plan_breakdown).toEqual([
      expect.objectContaining({
        price: 1,
        trial_users: 4,
        first_subscription_users: 4,
        trial_to_first_subscription_cr: 100,
        gross_revenue: 131.46,
        amount_refunded: 0,
        net_revenue: 131.46,
        net_ltv: 32.87,
      }),
    ]);
  });

  it("skips an initial upsell when assigning plan price", () => {
    const rows = transformPalmerRows([
      {
        id: "upsell_first",
        user_id: "u_upsell_plan",
        email: "upsell-plan@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "1498",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_billing_reason: "upsell", ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "initial_non_upsell",
        user_id: "u_upsell_plan",
        email: "upsell-plan@example.com",
        created_at: "2026-01-01T10:05:00Z",
        amount: "749",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);

    const users = computeUsers(rows);
    const cohorts = computeCohorts(rows);

    expect(users[0].plan_price).toBe(7.49);
    expect(users[0].plan_name).toBe("$7.49");
    expect(cohorts[0].plan_breakdown).toEqual([
      expect.objectContaining({ price: 7.49, trial_users: 1 }),
    ]);
  });

  it("calculates plan-level cohort analytics from aggregated counts and revenue", () => {
    const rows = transformPalmerRows([
      {
        id: "u_a_trial",
        user_id: "u_plan_metrics_a",
        email: "plan-metrics-a@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "749",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "u_a_upsell",
        user_id: "u_plan_metrics_a",
        email: "plan-metrics-a@example.com",
        created_at: "2026-01-01T10:15:00Z",
        amount: "1498",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading", ff_billing_reason: "upsell" }),
      },
      {
        id: "u_a_sub",
        user_id: "u_plan_metrics_a",
        email: "plan-metrics-a@example.com",
        created_at: "2026-01-08T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "u_a_renewal_2",
        user_id: "u_plan_metrics_a",
        email: "plan-metrics-a@example.com",
        created_at: "2026-02-08T10:00:00Z",
        amount: "2999",
        amountRefunded: "999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "u_b_trial",
        user_id: "u_plan_metrics_b",
        email: "plan-metrics-b@example.com",
        created_at: "2026-01-01T11:00:00Z",
        amount: "749",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "u_b_sub",
        user_id: "u_plan_metrics_b",
        email: "plan-metrics-b@example.com",
        created_at: "2026-01-08T11:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
      {
        id: "u_c_trial",
        user_id: "u_plan_metrics_c",
        email: "plan-metrics-c@example.com",
        created_at: "2026-01-01T12:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);

    const breakdown = computeCohorts(rows)[0].plan_breakdown;

    expect(breakdown).toEqual([
      expect.objectContaining({
        price: 7.49,
        trial_users: 2,
        upsell_users: 1,
        first_subscription_users: 2,
        renewal_2_users: 1,
        renewal_3_users: 0,
        renewal_users: 1,
        refund_users: 1,
        trial_to_upsell_cr: 50,
        trial_to_first_subscription_cr: 100,
        first_subscription_to_renewal_2_cr: 50,
        renewal_2_to_renewal_3_cr: 0,
        refund_rate: 50,
        gross_revenue: 119.93,
        amount_refunded: 9.99,
        net_revenue: 109.94,
        net_ltv: 54.97,
      }),
      expect.objectContaining({
        price: 29.99,
        trial_users: 1,
        first_subscription_users: 0,
        gross_revenue: 29.99,
        amount_refunded: 0,
        net_revenue: 29.99,
        net_ltv: 29.99,
      }),
    ]);
  });

  it("uses unknown plan fields when a user has no successful non-upsell transaction", () => {
    const rows = transformPalmerRows([
      {
        id: "failed_only",
        user_id: "u_no_plan",
        email: "no-plan@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "DECLINED",
      },
    ]);

    const users = computeUsers(rows);

    expect(users[0].plan_price).toBeNull();
    expect(users[0].plan_name).toBe("Unknown");
    expect(users[0].plan_assignment_reason).toBeNull();
  });

  it("extracts and normalizes country from metadata.ff_country_code", () => {
    const rows = transformPalmerRows([
      {
        id: "country_trial",
        user_id: "u_country",
        email: "country@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_country_code: "us" }),
      },
    ]);

    expect(computeUsers(rows)[0].country_code).toBe("US");
  });

  it("falls back to direct ff_country_code column for user country", () => {
    const rows = transformPalmerRows([
      {
        id: "country_trial",
        user_id: "u_country",
        email: "country@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        ff_country_code: " ca ",
      },
    ]);

    expect(computeUsers(rows)[0].country_code).toBe("CA");
  });

  it("keeps missing user country as null", () => {
    const rows = transformPalmerRows([
      {
        id: "country_missing",
        user_id: "u_country_missing",
        email: "country-missing@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
      },
    ]);

    expect(computeUsers(rows)[0].country_code).toBeNull();
  });

  it("allows an upsell before the first non-upsell trial", () => {
    const rows = transformPalmerRows([
      {
        id: "first_upsell",
        user_id: "u_upsell_first",
        email: "upsell-first@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "1498",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_billing_reason: "upsell" }),
      },
      {
        id: "intro_trial",
        user_id: "u_upsell_first",
        email: "upsell-first@example.com",
        created_at: "2026-01-01T10:05:00Z",
        amount: "4999",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);

    expect(rows.find((row) => row.transaction_id === "first_upsell")?.transaction_type).toBe("upsell");
    expect(rows.find((row) => row.transaction_id === "intro_trial")?.transaction_type).toBe("trial");
    expect(rows.find((row) => row.transaction_id === "intro_trial")?.cohort_id).toBe("soulmate_soulmate-reading_2026-01-01");
  });

  it("groups cohorts by exact campaign_path instead of broad funnel", () => {
    const rows = transformPalmerRows([
      {
        id: "marriage_trial",
        user_id: "u_marriage",
        email: "marriage@example.com",
        created_at: "2026-04-26T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-marriage" }),
      },
      {
        id: "reading_trial",
        user_id: "u_reading",
        email: "reading@example.com",
        created_at: "2026-04-26T11:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);
    const cohorts = computeCohorts(rows);

    expect(rows.find((row) => row.user_id === "u_marriage")?.funnel).toBe("soulmate");
    expect(rows.find((row) => row.user_id === "u_marriage")?.campaign_path).toBe("soulmate-marriage");
    expect(rows.find((row) => row.user_id === "u_reading")?.campaign_path).toBe("soulmate-reading");
    expect(cohorts.map((cohort) => cohort.cohort_id).sort()).toEqual([
      "soulmate_soulmate-marriage_2026-04-26",
      "soulmate_soulmate-reading_2026-04-26",
    ]);
  });

  it("uses initialUrl as campaign_path fallback when ff_campaign_path is missing", () => {
    const rows = transformPalmerRows([
      {
        id: "initial_url_trial",
        user_id: "u_initial_url",
        email: "initial-url@example.com",
        created_at: "2026-04-26T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ initialUrl: "https://example.com/soulmate-reading?utm=abc" }),
      },
    ]);

    expect(rows[0].campaign_path).toBe("soulmate-reading");
    expect(rows[0].cohort_id).toBe("unknown_soulmate-reading_2026-04-26");
  });

  it("prefixes Brainza project paths so the same landing path on another project stays a separate cohort", () => {
    const BRAINZA = "01KKEGM9PVW291BKJKYNC7QPSV";
    const FOXIQ = "01M36MDN39CQYEKTPZ92PN2R33";
    const trial = (id: string, metadata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
      id,
      user_id: `u_${id}`,
      email: `${id}@example.com`,
      created_at: "2026-05-24T10:00:00Z",
      amount: "100",
      status: "SETTLED",
      metadata: JSON.stringify(metadata),
      ...extra,
    });
    const rows = transformPalmerRows([
      trial("brainza", { ff_campaign_path: "/test-iq", ff_project_id: BRAINZA, initialUrl: "https://quiz.brainza.app/test-iq" }),
      trial("brainza_default_domain", { ff_campaign_path: "/test-iq", ff_project_id: BRAINZA, initialUrl: "https://bell-them-complex.fnlfx.com/test-iq" }),
      trial("brainza_url_only", { ff_project_id: BRAINZA, initialUrl: "https://quiz.brainza.app/my-test-iq2?utm_source=fb" }),
      trial("brainza_column", { ff_campaign_path: "/test-iq" }, { ff_project_id: BRAINZA }),
      trial("brainza_no_path", { ff_project_id: BRAINZA }),
      trial("foxiq", { ff_campaign_path: "/test-iq", ff_project_id: FOXIQ, initialUrl: "https://f.foxiq.app/test-iq" }),
      trial("no_project", { ff_campaign_path: "/test-iq" }),
    ]);
    const byId = new Map(rows.map((row) => [row.transaction_id, row]));

    expect(byId.get("brainza")?.campaign_path).toBe("brainza-test-iq");
    expect(byId.get("brainza")?.cohort_id).toBe("unknown_brainza-test-iq_2026-05-24");
    expect(byId.get("brainza_default_domain")?.campaign_path).toBe("brainza-test-iq");
    expect(byId.get("brainza_url_only")?.campaign_path).toBe("brainza-my-test-iq2");
    expect(byId.get("brainza_column")?.campaign_path).toBe("brainza-test-iq");
    expect(byId.get("brainza_no_path")?.campaign_path).toBe("unknown");
    expect(byId.get("foxiq")?.campaign_path).toBe("test-iq");
    expect(byId.get("foxiq")?.cohort_id).toBe("unknown_test-iq_2026-05-24");
    expect(byId.get("no_project")?.campaign_path).toBe("test-iq");
    expect(new Set(computeCohorts(rows).map((cohort) => cohort.cohort_id))).toEqual(new Set([
      "unknown_brainza-test-iq_2026-05-24",
      "unknown_brainza-my-test-iq2_2026-05-24",
      "unknown_unknown_2026-05-24",
      "unknown_test-iq_2026-05-24",
    ]));
  });

  it("never prefixes a Brainza path twice", () => {
    const rows = transformPalmerRows([
      {
        id: "already_prefixed",
        user_id: "u_prefixed",
        created_at: "2026-05-24T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/brainza-test-iq", ff_project_id: "01KKEGM9PVW291BKJKYNC7QPSV" }),
      },
    ]);

    expect(rows[0].campaign_path).toBe("brainza-test-iq");
  });

  it("aggregates refunded amount from amountRefunded cents regardless of status", () => {
    const rows = transformPalmerRows([
      {
        id: "settled_refunded_tx",
        customerId: "customer_refund",
        customerEmailAddress: "refund@example.com",
        created_at: "2026-04-26T10:00:00Z",
        amount: "2999",
        amountRefunded: "2099",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);
    const users = computeUsers(rows);

    expect(rows[0].status).toBe("success");
    expect(rows[0].gross_amount_usd).toBe(29.99);
    expect(rows[0].refund_amount_usd).toBe(20.99);
    expect(rows[0].net_amount_usd).toBe(9);
    expect(rows[0].is_refunded).toBe(true);
    expect(users[0].has_refund).toBe(true);
    expect(users[0].total_refund_usd).toBe(20.99);

    const cohorts = computeCohorts(rows);
    expect(cohorts[0].refund_users).toBe(1);
    expect(cohorts[0].amount_refunded).toBe(20.99);
    expect(cohorts[0].refund_rate).toBe(100);
    expect(cohorts[0].gross_revenue).toBe(29.99);
    expect(cohorts[0].net_revenue).toBe(9);
    expect(cohorts[0].gross_ltv).toBe(29.99);
    expect(cohorts[0].net_ltv).toBe(9);
  });

  it("uses net revenue consistently for fully refunded Palmer rows", () => {
    const rows = transformPalmerRows([
      {
        id: "fully_refunded_tx",
        customerId: "customer_full_refund",
        customerEmailAddress: "full-refund@example.com",
        created_at: "2026-04-26T10:00:00Z",
        amount: "2099",
        amountRefunded: "2099",
        status: "SETTLED",
        metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading" }),
      },
    ]);

    const users = computeUsers(rows);
    const cohorts = computeCohorts(rows);
    const kpis = computeKpis(rows);

    expect(rows[0].gross_amount_usd).toBe(20.99);
    expect(rows[0].refund_amount_usd).toBe(20.99);
    expect(rows[0].net_amount_usd).toBe(0);
    expect(users[0].total_revenue).toBe(0);
    expect(cohorts[0].net_revenue).toBe(0);
    expect(kpis.totalRevenue).toBe(0);
  });

  it("reports Palmer import diagnostics after transformation", () => {
    const rawRows = [
      {
        id: "trial",
        customer_id: "u_1",
        customer_email: "one@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount_usd: "1.00",
        payment_status: "AUTHORIZED",
        metadata: JSON.stringify({ utm_campaign: "unknown_campaign" }),
      },
      {
        id: "upsell",
        customer_id: "u_1",
        customer_email: "one@example.com",
        created_at: "2026-01-01T10:30:00Z",
        amount_usd: "14.98",
        payment_status: "SUCCEEDED",
        metadata: JSON.stringify({ utm_campaign: "unknown_campaign" }),
      },
    ];
    const rows = transformPalmerRows(rawRows);

    expect(getPalmerImportDiagnostics(rows, 2, rawRows)).toEqual({
      totalRows: 2,
      rowsWithAmountUsd: 2,
      successRows: 2,
      trialRows: 1,
      upsellRows: 1,
      firstSubscriptionRows: 0,
      rowsWithCohortId: 2,
      unknownFunnelRows: 2,
      unclassifiedSuccessfulSubscriptionRows: 0,
      uniqueUserIdCount: 1,
      missingEmailCount: 0,
      missingCustomerIdCount: 0,
      fallbackUnknownUserCount: 0,
    });
  });

  it("uses customerId as user_id when email is missing", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        customerId: "customer_123",
        created_at: "2026-01-01T10:00:00Z",
        amount: "3499",
        status: "SETTLED",
      },
    ]);

    expect(rows[0].user_id).toBe("customer_123");
    expect(rows[0].email).toBe("");
  });

  it("uses metadata.email as user_id and email when customerId is missing", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        created_at: "2026-01-01T10:00:00Z",
        amount: "3499",
        status: "SETTLED",
        metadata: JSON.stringify({ email: "metadata@example.com" }),
      },
    ]);

    expect(rows[0].user_id).toBe("metadata@example.com");
    expect(rows[0].email).toBe("metadata@example.com");
  });

  it("assigns unique fallback user ids when identity is missing", () => {
    const rows = transformPalmerRows([
      {
        id: "row_1",
        created_at: "2026-01-01T10:00:00Z",
        amount: "3499",
        status: "SETTLED",
      },
      {
        id: "row_2",
        created_at: "2026-01-01T11:00:00Z",
        amount: "3499",
        status: "SETTLED",
      },
    ]);

    expect(rows.map((row) => row.user_id).sort()).toEqual(["unknown_user_1", "unknown_user_2"]);
    expect(new Set(rows.map((row) => row.user_id)).size).toBe(2);
    expect(rows.every((row) => row.email === "")).toBe(true);
  });

  it("counts unclassified successful $29.99 rows in diagnostics", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
      },
      {
        id: "too_early_sub",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-03T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
      },
    ]);

    expect(getPalmerImportDiagnostics(rows).unclassifiedSuccessfulSubscriptionRows).toBe(0);
  });

  it("calculates cohort revenue windows from transaction_day", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T18:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "soulmate_a" }),
      },
      {
        id: "upsell",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-02T17:30:00Z",
        amount: "1498",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "soulmate_a" }),
      },
      {
        id: "late",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-08T18:01:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "soulmate_a" }),
      },
    ]);
    const cohort = computeCohorts(rows)[0];

    expect(cohort.cohort_id).toBe("soulmate_unknown_2026-01-01");
    expect(cohort.revenue_d0).toBe(15.98);
    expect(cohort.revenue_d7).toBe(45.97);
    expect(cohort.revenue_d30).toBe(45.97);
    expect(cohort.revenue_d60).toBe(45.97);
  });
});

// ---- Read-time token / in-product / funnel upsell split (typing "price_point") ----

describe("classifyUserTransactions typing price_point (read-time split)", () => {
  const T0 = Date.parse("2026-09-29T10:00:00.000Z");
  const MIN = 60_000;
  const HOUR = 3_600_000;
  const APP_ID = knownAppUpsellPriceIds[0];
  const TOKEN_ID = knownTokenPriceIds[0];
  const MARKED_ID = "price_01M3BW7TT3TXZRHCRY4BFGS8M7";
  const UNKNOWN_ID = "price_01UNKNOWN0000000000000000";
  const row = (id: string, user: string, offsetMs: number, amount: string, currency: string, meta: Record<string, unknown> = {}, status = "SETTLED") => ({
    id,
    customerId: user,
    email: `${user}@example.com`,
    createdAt: new Date(T0 + offsetMs).toISOString(),
    amount,
    currencyCode: currency,
    status,
    metadata: JSON.stringify({ ff_campaign_path: "/soulmate-reading", ...meta }),
  });
  const RAW = [
    row("a01", "A", 0, "100", "USD", { ff_price_point: "price_trial_a" }),
    row("a02", "A", 30_000, "2400", "JPY", { ff_price_point: MARKED_ID, ff_billing_reason: "upsell" }),
    row("a03", "A", MIN, "299", "USD", { ff_price_point: APP_ID }),
    row("a04", "A", 5 * MIN, "499", "USD", { ff_price_point: TOKEN_ID }),
    row("a05", "A", 8 * MIN, "349", "USD", { ff_price_point: UNKNOWN_ID }),
    row("a06", "A", 70 * HOUR, "2999", "USD", { ff_price_point: "price_sub" }),
    row("b01", "B", 0, "99", "EUR", { ff_price_point: "price_trial_b" }),
    row("b02", "B", MIN, "199", "EUR", { ff_price_point: UNKNOWN_ID }),
    row("b03", "B", 90_000, "2400", "JPY", { ff_price_point: MARKED_ID }),
    row("b04", "B", 30 * HOUR, "2400", "JPY", { ff_price_point: MARKED_ID }),
    row("b05", "B", 49 * HOUR, "2400", "JPY", { ff_price_point: MARKED_ID }),
    row("c01", "C", 0, "50", "USD", { ff_price_point: "price_trial_c" }),
    row("c02", "C", MIN, "150", "USD"),
    row("c03", "C", 2 * MIN, "125", "USD", { ff_price_point: UNKNOWN_ID }),
    row("c04", "C", 2 * MIN + 1000, "125", "USD", { ff_price_point: UNKNOWN_ID }),
    row("c05", "C", 3 * MIN, "499", "USD", { ff_price_point: APP_ID }),
    row("c06", "C", 4 * MIN, "699", "USD", { ff_price_point: "price_web_tokens_100" }),
    row("c07", "C", 71 * HOUR, "2999", "USD", { ff_price_point: "price_sub" }),
    // An anchor that carries a listed token id stays the trial.
    row("d01", "D", 0, "399", "EUR", { ff_price_point: TOKEN_ID }),
    row("d02", "D", 70 * HOUR, "2999", "EUR", { ff_price_point: "price_sub" }),
  ];
  const normalized = normalizePalmerRows(RAW);
  const legacy = classifyUserTransactions(normalized);
  const split = classifyUserTransactions(normalized, { typing: "price_point" });
  const typeOf = (rows: Transaction[]) => Object.fromEntries(rows.map((tx) => [tx.transaction_id, tx.transaction_type]));

  it("the default (import) typing is unchanged and never emits app_upsell", () => {
    expect(typeOf(classifyUserTransactions(normalized, { typing: "legacy" }))).toEqual(typeOf(legacy));
    expect(typeOf(transformPalmerRows(RAW))).toEqual(typeOf(legacy));
    expect(legacy.some((tx) => tx.transaction_type === "app_upsell")).toBe(false);
    expect(typeOf(legacy)).toMatchObject({ a03: "token_purchase", b02: "token_purchase", b03: "token_purchase", b04: "token_purchase", c03: "token_purchase", c05: "token_purchase" });
  });

  it("re-types only the one-offs; trials, lifecycle levels and cohorts stay", () => {
    const types = typeOf(split);
    expect(types).toMatchObject({
      a01: "trial", a02: "upsell", a03: "app_upsell", a04: "token_purchase", a05: "token_purchase", a06: "first_subscription",
      b01: "trial", b02: "app_upsell", b03: "upsell", b04: "upsell", b05: "first_subscription",
      c01: "trial", c02: "token_purchase", c03: "app_upsell", c04: "token_purchase", c05: "app_upsell", c06: "token_purchase", c07: "first_subscription",
      d01: "trial", d02: "first_subscription",
    });
    const legacyTypes = typeOf(legacy);
    const moved = Object.keys(types).filter((id) => types[id] !== legacyTypes[id]).sort();
    expect(moved).toEqual(["a03", "b02", "b03", "b04", "c03", "c05"]);
    const cohortOf = (rows: Transaction[]) => Object.fromEntries(rows.map((tx) => [tx.transaction_id, tx.cohort_id]));
    expect(cohortOf(split)).toEqual(cohortOf(legacy));
  });

  it("mirrors the shared rule table (classifyOneOff) on every successful member row", () => {
    const marked = new Set(split.filter((tx) => /upsell/i.test(tx.billing_reason ?? "")).map((tx) => pricePointForTransaction(tx)).filter(Boolean));
    const trialAt = new Map(split.filter((tx) => tx.transaction_type === "trial").map((tx) => [tx.user_id, Date.parse(tx.event_time)]));
    const asCategory = (type: string) => (["first_subscription", "renewal_2", "renewal_3", "renewal"].includes(type) ? "lifecycle" : type);
    let checked = 0;
    for (const tx of split) {
      const trial = trialAt.get(tx.user_id);
      if (trial == null || tx.status !== "success") continue;
      const pricePoint = pricePointForTransaction(tx);
      const expected = classifyOneOff({
        upmark: /upsell/i.test(tx.billing_reason ?? ""),
        isAnchor: tx.transaction_type === "trial",
        ageMs: Date.parse(tx.event_time) - trial,
        pricePoint,
        psig: priceSignal(pricePoint, marked),
        tokenAmt: isKnownTokenAmount(tx.amount_usd, tx.currency),
        commonUp: Math.abs(tx.amount_usd - 14.98) < 0.01,
      }).category;
      expect(asCategory(tx.transaction_type), tx.transaction_id).toBe(expected);
      checked += 1;
    }
    expect(checked).toBe(RAW.length);
  });

  it("nothing outside the read-time path stores app_upsell (import VALID_TYPES map it to unknown)", () => {
    const mapped = mapSupabaseTransactionToClickHouse({
      authUserId: "owner-1",
      row: {
        transaction_id: "tx-app",
        event_time: new Date(T0).toISOString(),
        status: "success",
        transaction_type: "app_upsell",
        normalized_payload: { transaction_id: "tx-app", event_time: new Date(T0).toISOString(), status: "success", transaction_type: "app_upsell", user_id: "A", amount_usd: 2.99 },
      },
    });
    expect(mapped?.transaction_type).toBe("unknown");
    const importSource = readFileSync(resolve(process.cwd(), "src/services/import.ts"), "utf8");
    expect(importSource.slice(importSource.indexOf("const VALID_TYPES"), importSource.indexOf("];", importSource.indexOf("const VALID_TYPES")))).not.toContain("app_upsell");
  });
});
