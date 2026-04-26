import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
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

  it("classifies a user journey by explicit Palmer amount and timing rules", () => {
    const rows = transformPalmerRows([
      {
        id: "trial",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T10:00:00Z",
        amount: "100",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
      {
        id: "upsell",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-01-01T10:45:00Z",
        amount: "1498",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
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

  it("reports Palmer import diagnostics after transformation", () => {
    const rows = transformPalmerRows([
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
    ]);

    expect(getPalmerImportDiagnostics(rows, 2)).toEqual({
      totalRows: 2,
      rowsWithAmountUsd: 2,
      successRows: 2,
      trialRows: 1,
      upsellRows: 1,
      firstSubscriptionRows: 0,
      rowsWithCohortId: 2,
      unknownFunnelRows: 2,
      unclassifiedSuccessfulSubscriptionRows: 0,
    });
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

    expect(getPalmerImportDiagnostics(rows).unclassifiedSuccessfulSubscriptionRows).toBe(1);
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
