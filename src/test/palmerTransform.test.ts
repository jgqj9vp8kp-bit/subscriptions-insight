import { describe, expect, it } from "vitest";
import { computeCohorts } from "@/services/analytics";
import {
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

  it("maps Palmer statuses explicitly", () => {
    expect(normalizeStatus("SETTLED")).toBe("success");
    expect(normalizeStatus("DECLINED")).toBe("failed");
    expect(normalizeStatus("REFUNDED")).toBe("refunded");
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
        created_at: "2026-01-08T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
      {
        id: "renewal",
        user_id: "u_1",
        email: "one@example.com",
        created_at: "2026-02-07T10:00:00Z",
        amount: "2999",
        status: "SETTLED",
        metadata: JSON.stringify({ utm_campaign: "past_life_a" }),
      },
    ]);

    expect(rows.find((row) => row.transaction_id === "trial")?.transaction_type).toBe("trial");
    expect(rows.find((row) => row.transaction_id === "upsell")?.transaction_type).toBe("upsell");
    expect(rows.find((row) => row.transaction_id === "sub")?.transaction_type).toBe("first_subscription");
    expect(rows.find((row) => row.transaction_id === "renewal")?.transaction_type).toBe("renewal");
    expect(rows.every((row) => row.cohort_id === "past_life_2026-01-01")).toBe(true);
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

    expect(cohort.cohort_id).toBe("soulmate_2026-01-01");
    expect(cohort.revenue_d0).toBe(15.98);
    expect(cohort.revenue_d7).toBe(15.98);
    expect(cohort.revenue_d30).toBe(45.97);
  });
});
