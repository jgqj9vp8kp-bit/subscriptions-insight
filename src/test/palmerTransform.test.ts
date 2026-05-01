import { describe, expect, it } from "vitest";
import { computeCohorts, computeKpis, computeUsers } from "@/services/analytics";
import {
  getPalmerImportDiagnostics,
  normalizeAmount,
  normalizeStatus,
  parseMetadata,
  transformPalmerRows,
} from "@/services/palmerTransform";

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
    expect(rows.every((row) => row.cohort_id === "unknown_2026-01-01")).toBe(true);
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
    expect(rows.find((row) => row.transaction_id === "intro_trial")?.cohort_id).toBe("soulmate-reading_2026-01-01");
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
      "soulmate-marriage_2026-04-26",
      "soulmate-reading_2026-04-26",
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
    expect(rows[0].cohort_id).toBe("soulmate-reading_2026-04-26");
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

  it("calculates cohort windows from trial timestamp, not calendar midnight", () => {
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

    expect(cohort.cohort_id).toBe("unknown_2026-01-01");
    expect(cohort.revenue_d0).toBe(15.98);
    expect(cohort.revenue_d7).toBe(15.98);
    expect(cohort.revenue_d30).toBe(45.97);
  });
});
