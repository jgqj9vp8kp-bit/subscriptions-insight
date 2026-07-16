import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEDIA_BUYER_BY_UTM_SOURCE,
  mediaBuyerFromUtmSource,
} from "@/services/userMediaBuyer";
import { computeCohorts } from "@/services/analytics";
import { buildFbAnalytics } from "@/services/fbAnalytics";
import { computeLeads } from "@/services/leads";
import { buildPaymentAttempts, groupPaymentAttempts } from "@/services/paymentPassAnalytics";
import type { Transaction, TransactionStatus, TransactionType } from "@/services/types";

function tx(
  userId: string,
  transactionType: TransactionType,
  utmSource: string | null,
  overrides: Partial<Transaction> = {},
): Transaction {
  const amount = overrides.amount_usd ?? (transactionType === "trial" ? 1 : 10);
  return {
    transaction_id: overrides.transaction_id ?? `${userId}-${transactionType}`,
    user_id: userId,
    email: `${userId}@example.com`,
    event_time: overrides.event_time ?? "2026-06-01T00:00:00Z",
    amount_usd: amount,
    gross_amount_usd: amount,
    refund_amount_usd: 0,
    net_amount_usd: amount,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? ("success" as TransactionStatus),
    transaction_type: transactionType,
    funnel: "soulmate",
    campaign_path: "soulmate-reading",
    product: "Product",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? `${userId}-campaign`,
    classification_reason: "",
    metadata: utmSource ? { utm_source: utmSource } : {},
    ...overrides,
  };
}

// The single source of truth: 4 → Ivan, 19 → Artem A, 22 → Artem D.
describe("media buyer mapping (single source of truth)", () => {
  it("exposes exactly the canonical utm_source map", () => {
    expect(MEDIA_BUYER_BY_UTM_SOURCE).toEqual({
      "4": "Ivan",
      "19": "Artem A",
      "22": "Artem D",
    });
  });

  it('maps utm_source = "4" to Ivan', () => {
    expect(mediaBuyerFromUtmSource("4")).toBe("Ivan");
  });

  it("maps numeric utm_source = 4 to Ivan", () => {
    expect(mediaBuyerFromUtmSource(4)).toBe("Ivan");
  });

  it('maps utm_source = "19" to Artem A', () => {
    expect(mediaBuyerFromUtmSource("19")).toBe("Artem A");
    expect(mediaBuyerFromUtmSource(19)).toBe("Artem A");
  });

  it('maps utm_source = "22" to Artem D', () => {
    expect(mediaBuyerFromUtmSource("22")).toBe("Artem D");
    expect(mediaBuyerFromUtmSource(22)).toBe("Artem D");
  });

  it("returns Unknown for null/undefined/empty", () => {
    expect(mediaBuyerFromUtmSource(null)).toBe("Unknown");
    expect(mediaBuyerFromUtmSource(undefined)).toBe("Unknown");
    expect(mediaBuyerFromUtmSource("  ")).toBe("Unknown");
  });

  it("returns Unknown for unmapped utm_source values", () => {
    expect(mediaBuyerFromUtmSource("999")).toBe("Unknown");
    expect(mediaBuyerFromUtmSource("ivan")).toBe("Unknown");
  });
});

describe("consumers use the shared mapping", () => {
  const artemATxs = [tx("artem-a-user", "trial", "19")];
  const artemDTxs = [tx("artem-d-user", "trial", "22")];

  it("Cohorts: media buyer filter resolves 19 → Artem A and 22 → Artem D", () => {
    const rows = [...artemATxs, ...artemDTxs];
    const artemACohorts = computeCohorts(rows, [], { selectedMediaBuyers: ["Artem A"] });
    expect(artemACohorts.reduce((total, cohort) => total + cohort.trial_users, 0)).toBe(1);

    const artemDCohorts = computeCohorts(rows, [], { selectedMediaBuyers: ["Artem D"] });
    expect(artemDCohorts.reduce((total, cohort) => total + cohort.trial_users, 0)).toBe(1);
  });

  it("FB Analytics: mediaBuyerFilter resolves through the shared helper", () => {
    const result = buildFbAnalytics({
      txs: [...artemATxs, ...artemDTxs],
      filters: { mediaBuyerFilter: "Artem A" },
    });
    // Campaign rows always exist; the media buyer filter empties non-matching ones.
    const trialsByCampaign = new Map(result.rows.map((row) => [row.campaign_id, row.trial_users]));
    expect(trialsByCampaign.get("artem-a-user-campaign")).toBe(1);
    expect(trialsByCampaign.get("artem-d-user-campaign") ?? 0).toBe(0);
  });

  it("Leads: lead media_buyer resolves through the shared helper", () => {
    const now = Date.parse("2026-06-10T00:00:00Z");
    const leads = computeLeads(
      [
        tx("lead-artem-a", "failed_payment", "19", { status: "failed" }),
        tx("lead-artem-d", "failed_payment", "22", { status: "failed" }),
        tx("lead-ivan", "failed_payment", "4", { status: "failed" }),
      ],
      [],
      now,
    );
    const byUser = new Map(leads.map((lead) => [lead.customer_id, lead.media_buyer]));
    expect(byUser.get("lead-artem-a")).toBe("Artem A");
    expect(byUser.get("lead-artem-d")).toBe("Artem D");
    expect(byUser.get("lead-ivan")).toBe("Ivan");
  });

  it("Payment Pass Analytics: media buyer grouping resolves through the shared helper", () => {
    const attempts = buildPaymentAttempts([
      tx("pp-ivan", "trial", "4"),
      tx("pp-artem-a", "trial", "19"),
      tx("pp-artem-d", "trial", "22"),
    ]);
    const rows = groupPaymentAttempts(attempts, "media_buyer");
    expect(rows.map((row) => row.key).sort()).toEqual(["Artem A", "Artem D", "Ivan"]);
  });
});

describe("Edge Functions carry the corrected mapping (no stale copies)", () => {
  // Deno Edge Functions cannot import browser code, so each keeps a local copy of
  // the map. This guard fails the suite if any copy drifts back to the old wrong
  // pairing (22 → Artem A / 19 → Artem D).
  const EDGE_FUNCTION_FILES = [
    "supabase/functions/export-campaign-performance/compute.ts",
    "supabase/functions/sync-support-mail/support.ts",
    "supabase/functions/funnelfox-leads-sync/index.ts",
  ];

  for (const file of EDGE_FUNCTION_FILES) {
    it(`${file} maps 19 → Artem A and 22 → Artem D`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      // Both mapping styles used in the functions: `"19": "Artem A"` and `=== "19") return "Artem A"`.
      const pair = (code: string, buyer: string) =>
        new RegExp(`"${code}"\\s*:\\s*"${buyer}"|"${code}"\\)\\s*return "${buyer}"`);
      // Old wrong pairing must not reappear.
      expect(source).not.toMatch(pair("22", "Artem A"));
      expect(source).not.toMatch(pair("19", "Artem D"));
      // Correct pairing must be present.
      expect(source).toMatch(pair("4", "Ivan"));
      expect(source).toMatch(pair("19", "Artem A"));
      expect(source).toMatch(pair("22", "Artem D"));
    });
  }
});
