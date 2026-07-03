import { describe, expect, it } from "vitest";
import {
  buildLeadUpsertRow,
  deriveConversionState,
  emailFromListRow,
  emailFromProfileDetail,
  joinSessionsToProfiles,
  mediaBuyerFromUtmSource,
  parseOriginUrl,
  parseProfileListRow,
  parseSessionRow,
  selectLeadsSource,
  type LeadConversionContext,
  type ParsedSession,
} from "@/services/funnelfoxLeadsTransform";
import { buildConversionContext } from "@/services/funnelfoxLeads";
import type { Transaction } from "@/services/types";

function emptyContext(overrides: Partial<LeadConversionContext> = {}): LeadConversionContext {
  return {
    paidEmails: new Set(),
    activeSubEmails: new Set(),
    trialDatesByEmail: new Map(),
    firstSubDatesByEmail: new Map(),
    ...overrides,
  };
}

describe("1. profile list parsing", () => {
  it("extracts profile_id (from id), created_at, funnel_id", () => {
    const parsed = parseProfileListRow({ id: "pro_1", created_at: "2026-06-10T00:00:00Z", funnel_id: "fn_9" });
    expect(parsed.profile_id).toBe("pro_1");
    expect(parsed.created_at).toBe("2026-06-10T00:00:00Z");
    expect(parsed.funnel_id).toBe("fn_9");
    expect(parsed.email_from_list).toBeNull();
  });

  it("uses a list-row email when present, and finds one inside a preview string", () => {
    expect(emailFromListRow({ email: "A@Example.com" })).toBe("a@example.com");
    expect(emailFromListRow({ preview: "Lead: jane@example.com (US)" })).toBe("jane@example.com");
    expect(emailFromListRow({ preview: { email: "x@y.com" } })).toBe("x@y.com");
    expect(emailFromListRow({ preview: "no email here" })).toBeNull();
  });
});

describe("2. profile detail email extraction", () => {
  it("extracts email from known profile-detail paths", () => {
    expect(emailFromProfileDetail({ data: { email: "a@b.com" } })).toBe("a@b.com");
    expect(emailFromProfileDetail({ data: { replies: { email: "c@d.com" } } })).toBe("c@d.com");
    expect(emailFromProfileDetail({ nothing: true })).toBeNull();
  });
});

describe("3. session parsing", () => {
  it("extracts attribution fields and normalizes country", () => {
    const s = parseSessionRow({
      id: "sess_1",
      profile_id: "pro_1",
      country: "us",
      user_agent: "Mozilla/5.0",
      funnel_id: "fn_9",
      funnel_version: "v2",
      origin: "https://lp/x?utm_source=4",
      created_at: "2026-06-10T10:00:00Z",
      city: "Austin",
      postal: "78701",
    });
    expect(s).toMatchObject({
      session_id: "sess_1",
      profile_id: "pro_1",
      country_code: "US",
      user_agent: "Mozilla/5.0",
      funnel_version: "v2",
      city: "Austin",
      postal: "78701",
    });
  });
});

describe("4. session → profile join", () => {
  it("keeps the earliest session per profile_id and drops sessions without profile_id", () => {
    const sessions: ParsedSession[] = [
      parseSessionRow({ id: "s_late", profile_id: "pro_1", created_at: "2026-06-12T00:00:00Z", origin: "late" }),
      parseSessionRow({ id: "s_early", profile_id: "pro_1", created_at: "2026-06-10T00:00:00Z", origin: "early" }),
      parseSessionRow({ id: "s_orphan", profile_id: "", created_at: "2026-06-11T00:00:00Z" }),
    ];
    const joined = joinSessionsToProfiles(sessions);
    expect(joined.size).toBe(1);
    expect(joined.get("pro_1")?.session_id).toBe("s_early");
  });
});

describe("5. origin URL parsing", () => {
  it("extracts campaign_path, campaign_id and utm_source from a full URL", () => {
    const a = parseOriginUrl("https://lp.example.com/soulmate?utm_source=4&utm_campaign=soulmate-reading&campaign_id=cmp123");
    expect(a).toEqual({ campaign_path: "soulmate-reading", campaign_id: "cmp123", utm_source: "4" });
  });

  it("falls back to the first path segment and tolerates bare query strings", () => {
    expect(parseOriginUrl("https://lp.example.com/past-life/start").campaign_path).toBe("past-life");
    expect(parseOriginUrl("utm_source=22&utm_content=ad9").utm_source).toBe("22");
    expect(parseOriginUrl("utm_source=22&utm_content=ad9").campaign_id).toBe("ad9");
    expect(parseOriginUrl(null)).toEqual({ campaign_path: null, campaign_id: null, utm_source: null });
  });
});

describe("6. media buyer mapping", () => {
  it("maps numeric utm_source codes", () => {
    expect(mediaBuyerFromUtmSource("4")).toBe("Ivan");
    expect(mediaBuyerFromUtmSource("22")).toBe("Artem A");
    expect(mediaBuyerFromUtmSource("19")).toBe("Artem D");
    expect(mediaBuyerFromUtmSource("999")).toBe("Unknown");
  });
});

describe("7-9. lead definition + conversion exclusions", () => {
  it("is a lead when email exists and there is no payment and no active subscription", () => {
    const state = deriveConversionState("lead@example.com", emptyContext());
    expect(state.is_lead).toBe(true);
    expect(state.has_successful_payment).toBe(false);
    expect(state.has_active_subscription).toBe(false);
  });

  it("excludes a converted (paid) user", () => {
    const state = deriveConversionState("paid@example.com", emptyContext({ paidEmails: new Set(["paid@example.com"]) }));
    expect(state.has_successful_payment).toBe(true);
    expect(state.is_lead).toBe(false);
  });

  it("excludes a user with an active subscription", () => {
    const state = deriveConversionState("active@example.com", emptyContext({ activeSubEmails: new Set(["active@example.com"]) }));
    expect(state.has_active_subscription).toBe(true);
    expect(state.is_lead).toBe(false);
  });

  it("is not a lead without an email", () => {
    expect(deriveConversionState(null, emptyContext()).is_lead).toBe(false);
  });

  it("carries first trial / first sub dates from context", () => {
    const state = deriveConversionState("lead@example.com", emptyContext({
      trialDatesByEmail: new Map([["lead@example.com", "2026-06-15T00:00:00Z"]]),
    }));
    expect(state.first_trial_at).toBe("2026-06-15T00:00:00Z");
  });
});

describe("10. upsert row build (dedup key = profile_id)", () => {
  it("builds a stable row keyed on profile_id with joined attribution + media buyer", () => {
    const profile = parseProfileListRow({ id: "pro_1", created_at: "2026-06-10T00:00:00Z", funnel_id: "fn_9" });
    const session = parseSessionRow({
      id: "sess_1", profile_id: "pro_1", country: "us", user_agent: "UA",
      origin: "https://lp/x?utm_source=4&utm_campaign=soulmate-reading&campaign_id=cmp1", created_at: "2026-06-10T10:00:00Z",
    });
    const conversion = deriveConversionState("lead@example.com", emptyContext());
    const row = buildLeadUpsertRow(profile, session, "lead@example.com", conversion);

    expect(row.profile_id).toBe("pro_1"); // stable conflict key for upsert dedup
    expect(row.normalized_email).toBe("lead@example.com");
    expect(row.campaign_path).toBe("soulmate-reading");
    expect(row.campaign_id).toBe("cmp1");
    expect(row.utm_source).toBe("4");
    expect(row.media_buyer).toBe("Ivan");
    expect(row.country_code).toBe("US");
    expect(row.is_lead).toBe(true);

    // Re-building for the same profile yields the same conflict key (idempotent upsert).
    expect(buildLeadUpsertRow(profile, session, "lead@example.com", conversion).profile_id).toBe(row.profile_id);
  });
});

describe("12. Leads page source priority", () => {
  it("prefers FunnelFox leads and only falls back to warehouse when empty", () => {
    expect(selectLeadsSource([{ a: 1 }], [{ b: 2 }]).source).toBe("funnelfox");
    expect(selectLeadsSource([], [{ b: 2 }]).source).toBe("warehouse");
    expect(selectLeadsSource([], [{ b: 2 }]).warehouse).toHaveLength(1);
  });
});

describe("buildConversionContext (client → edge payload)", () => {
  function tx(o: Partial<Transaction>): Transaction {
    return {
      transaction_id: o.transaction_id ?? "t", user_id: "u", email: o.email ?? "x@y.com",
      event_time: o.event_time ?? "2026-06-01T00:00:00Z", amount_usd: 0, gross_amount_usd: 0, refund_amount_usd: 0,
      net_amount_usd: 0, is_refunded: false, currency: "USD", status: o.status ?? "failed",
      transaction_type: o.transaction_type ?? "failed_payment", funnel: "unknown", campaign_path: "", product: "",
      traffic_source: "unknown", campaign_id: "", classification_reason: "t",
    };
  }
  it("collects paid emails and trial/first-sub dates from successful transactions", () => {
    const ctx = buildConversionContext(
      [
        tx({ email: "paid@x.com", status: "success", transaction_type: "trial", event_time: "2026-06-02T00:00:00Z" }),
        tx({ email: "paid@x.com", status: "success", transaction_type: "first_subscription", event_time: "2026-06-05T00:00:00Z" }),
        tx({ email: "lead@x.com", status: "failed" }),
      ],
      [],
    );
    expect(ctx.paid_emails).toContain("paid@x.com");
    expect(ctx.paid_emails).not.toContain("lead@x.com");
    expect(ctx.trial_dates["paid@x.com"]).toBe("2026-06-02T00:00:00Z");
    expect(ctx.first_sub_dates["paid@x.com"]).toBe("2026-06-05T00:00:00Z");
  });
});
