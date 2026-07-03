import { describe, expect, it } from "vitest";
import { computeLeads, computeLeadSummary, filterLeads, sortLeads } from "@/services/leads";
import type { Transaction } from "@/services/types";
import type { SubscriptionClean } from "@/types/subscriptions";

function tx(overrides: Partial<Transaction> = {}): Transaction {
  return {
    transaction_id: overrides.transaction_id ?? "tx_1",
    user_id: overrides.user_id ?? "user_1",
    email: overrides.email ?? "lead@example.com",
    event_time: overrides.event_time ?? "2026-06-10T10:00:00.000Z",
    amount_usd: 0,
    gross_amount_usd: 0,
    refund_amount_usd: 0,
    net_amount_usd: 0,
    is_refunded: false,
    currency: "USD",
    status: overrides.status ?? "failed",
    transaction_type: overrides.transaction_type ?? "failed_payment",
    funnel: overrides.funnel ?? "soulmate",
    campaign_path: overrides.campaign_path ?? "soulmate-reading",
    product: "Trial",
    traffic_source: "facebook",
    campaign_id: overrides.campaign_id ?? "cmp_1",
    classification_reason: "test",
    metadata: overrides.metadata ?? { ff_country_code: "us", utm_source: "ivan" },
    ...overrides,
  };
}

function sub(overrides: Partial<SubscriptionClean> = {}): SubscriptionClean {
  return {
    subscription_id: overrides.subscription_id ?? "sub_1",
    psp_id: "",
    email: overrides.email ?? null,
    profile_id: overrides.profile_id ?? "pro_1",
    status: overrides.status ?? "active",
    renews: true,
    is_cancelled: overrides.is_cancelled ?? false,
    cancelled_at: null,
    cancellation_source: null,
    cancellation_reason: null,
    days_to_cancel: null,
    hours_before_period_end: null,
    cancellation_timing_bucket: "not_cancelled",
    cancellation_type: "not_cancelled",
    is_active_now: overrides.is_active_now ?? false,
    created_at: overrides.created_at ?? "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    period_starts_at: "2026-06-01T00:00:00.000Z",
    period_ends_at: "2026-07-01T00:00:00.000Z",
    billing_interval: "month",
    billing_interval_count: 1,
    price_usd: overrides.price_usd ?? 0,
    currency: "USD",
    payment_provider: "stripe",
    product_name: "Plan",
    product_id: "prod_1",
    funnel_title: overrides.funnel_title ?? "",
    funnel_alias: overrides.funnel_alias ?? "",
    session_id: "sess_1",
    raw: {},
  };
}

const NOW = new Date("2026-06-21T12:00:00.000Z").getTime();

describe("computeLeads — lead definition", () => {
  it("includes an email that only ever has failed payments", () => {
    const leads = computeLeads([tx()], [], NOW);
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe("lead@example.com");
    expect(leads[0].has_declines).toBe(true);
    expect(leads[0].source).toBe("warehouse");
  });

  it("excludes an email that has any successful payment", () => {
    const leads = computeLeads(
      [
        tx({ transaction_id: "a", status: "failed", transaction_type: "failed_payment" }),
        tx({ transaction_id: "b", status: "success", transaction_type: "trial" }),
      ],
      [],
      NOW,
    );
    expect(leads).toHaveLength(0);
  });

  it("excludes an email that has an active subscription even with no successful warehouse payment", () => {
    const leads = computeLeads(
      [tx()],
      [sub({ email: "lead@example.com", is_active_now: true })],
      NOW,
    );
    expect(leads).toHaveLength(0);
  });

  it("excludes rows without an email", () => {
    const leads = computeLeads([tx({ email: "" })], [], NOW);
    expect(leads).toHaveLength(0);
  });

  it("matches paid status across user_ids sharing the same email", () => {
    const leads = computeLeads(
      [
        tx({ transaction_id: "a", user_id: "u1", status: "failed", transaction_type: "failed_payment" }),
        tx({ transaction_id: "b", user_id: "u2", status: "success", transaction_type: "first_subscription" }),
      ],
      [],
      NOW,
    );
    expect(leads).toHaveLength(0);
  });
});

describe("computeLeads — field extraction & attribution", () => {
  it("extracts funnel, campaign, country, utm/media buyer and session date from first touch", () => {
    const leads = computeLeads(
      [
        tx({ transaction_id: "a", event_time: "2026-06-12T10:00:00.000Z", campaign_id: "late", metadata: { ff_country_code: "us", utm_source: "4" } }),
        tx({ transaction_id: "b", event_time: "2026-06-10T10:00:00.000Z", campaign_id: "first", metadata: { ff_country_code: "us", utm_source: "4" } }),
      ],
      [],
      NOW,
    );
    expect(leads).toHaveLength(1);
    const lead = leads[0];
    expect(lead.funnel).toBe("soulmate");
    expect(lead.campaign_path).toBe("soulmate-reading");
    expect(lead.campaign_id).toBe("first"); // earliest event wins
    expect(lead.country).toBe("US");
    expect(lead.media_buyer).toBe("Ivan"); // utm_source "4" → Ivan
    expect(lead.session_date).toBe("2026-06-10T10:00:00.000Z");
    expect(lead.days_since_visit).toBe(11);
  });

  it("surfaces the latest decline reason", () => {
    const leads = computeLeads(
      [
        tx({
          transaction_id: "a",
          event_time: "2026-06-10T10:00:00.000Z",
          metadata: { ff_country_code: "us", declineReasons: "[{'decline_reason': 'INSUFFICIENT_FUNDS'}]" },
        }),
        tx({
          transaction_id: "b",
          event_time: "2026-06-15T10:00:00.000Z",
          metadata: { ff_country_code: "us", declineReasons: "[{'decline_reason': 'DO_NOT_HONOR'}]" },
        }),
      ],
      [],
      NOW,
    );
    expect(leads[0].decline_reason).toBe("do_not_honor");
  });

  it("adds subscription-only leads for cancelled/non-active FunnelFox subs not in the warehouse", () => {
    const leads = computeLeads(
      [],
      [sub({ email: "subonly@example.com", is_active_now: false, is_cancelled: true, funnel_alias: "soulmate-v2" })],
      NOW,
    );
    expect(leads).toHaveLength(1);
    expect(leads[0].email).toBe("subonly@example.com");
    expect(leads[0].funnel).toBe("soulmate");
    expect(leads[0].source).toBe("funnelfox_subscription");
  });
});

describe("computeLeadSummary", () => {
  it("counts totals, today, last-7-days and conversion rates over the contact base", () => {
    const transactions = [
      tx({ transaction_id: "l1", user_id: "lead_user", email: "lead@example.com", status: "failed", event_time: "2026-06-20T10:00:00.000Z" }),
      tx({ transaction_id: "p1", user_id: "paid_user", email: "paid@example.com", status: "success", transaction_type: "trial", event_time: "2026-06-01T10:00:00.000Z" }),
      tx({ transaction_id: "p2", user_id: "paid_user", email: "paid@example.com", status: "success", transaction_type: "first_subscription", event_time: "2026-06-02T10:00:00.000Z" }),
    ];
    const leads = computeLeads(transactions, [], NOW);
    const summary = computeLeadSummary(leads, transactions, NOW);

    expect(summary.total_leads).toBe(1);
    expect(summary.leads_last_7_days).toBe(1);
    expect(summary.leads_today).toBe(0);
    // 2 distinct contacts; 1 trial, 1 first sub.
    expect(summary.lead_to_trial_cr).toBeCloseTo(0.5);
    expect(summary.lead_to_first_sub_cr).toBeCloseTo(0.5);
  });
});

describe("filterLeads & sortLeads", () => {
  const transactions = [
    tx({ transaction_id: "a", user_id: "u1", email: "a@example.com", funnel: "soulmate", event_time: "2026-06-10T10:00:00.000Z", metadata: { ff_country_code: "us" } }),
    tx({ transaction_id: "b", user_id: "u2", email: "b@example.com", funnel: "starseed", event_time: "2026-06-15T10:00:00.000Z", metadata: { ff_country_code: "gb" } }),
  ];

  it("filters by funnel", () => {
    const leads = computeLeads(transactions, [], NOW);
    const filtered = filterLeads(leads, { ...{ dateFrom: "", dateTo: "", funnel: "starseed", campaignPath: "all", campaignId: "all", mediaBuyer: "all", country: "all", hasDeclines: "all" } });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].email).toBe("b@example.com");
  });

  it("sorts newest and oldest by session date", () => {
    const leads = computeLeads(transactions, [], NOW);
    expect(sortLeads(leads, "newest")[0].email).toBe("b@example.com");
    expect(sortLeads(leads, "oldest")[0].email).toBe("a@example.com");
  });
});
