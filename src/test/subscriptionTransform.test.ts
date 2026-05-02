import { describe, expect, it, vi } from "vitest";
import { extractProfileEmail, normalizeSubscription } from "@/services/subscriptionTransform";

describe("FunnelFox subscription normalization", () => {
  it("detects cancellation from cancelled status and keeps access active until period end", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));

    const row = normalizeSubscription({
      id: "sub_1",
      psp_id: "psp_1",
      status: "cancelled",
      renews: true,
      updated_at: "2026-04-30T10:00:00Z",
      period_ends_at: "2026-05-10T00:00:00Z",
      price_usd: 29.99,
      currency: "USD",
      profile: { id: "profile_1", email: "one@example.com" },
      product: { name: "Monthly" },
    });

    expect(row.is_cancelled).toBe(true);
    expect(row.cancelled_at).toBe("2026-04-30T10:00:00Z");
    expect(row.cancellation_source).toBe("api_status_cancelled");
    expect(row.is_active_now).toBe(true);
    expect(row.email).toBe("one@example.com");
    expect(row.product_name).toBe("Monthly");

    vi.useRealTimers();
  });

  it("detects cancellation from renews false and marks expired periods inactive", () => {
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));

    const row = normalizeSubscription({
      id: "sub_2",
      status: "active",
      renews: false,
      cancelled_at: "2026-04-15T10:00:00Z",
      updated_at: "2026-04-16T10:00:00Z",
      period_ends_at: "2026-04-30T00:00:00Z",
    });

    expect(row.is_cancelled).toBe(true);
    expect(row.cancelled_at).toBe("2026-04-15T10:00:00Z");
    expect(row.cancellation_source).toBe("api_renews_false");
    expect(row.is_active_now).toBe(false);

    vi.useRealTimers();
  });

  it("normalizes email from profile.email", () => {
    const row = normalizeSubscription({
      profile: { email: "  PROFILE@Example.COM " },
    });

    expect(row.email).toBe("profile@example.com");
  });

  it("normalizes email from raw.email", () => {
    const row = normalizeSubscription({
      email: " ROOT@Example.COM ",
    });

    expect(row.email).toBe("root@example.com");
  });

  it("normalizes email from metadata.email", () => {
    const row = normalizeSubscription({
      metadata: { email: " METADATA@Example.COM " },
    });

    expect(row.email).toBe("metadata@example.com");
  });

  it("returns null when email is missing", () => {
    const row = normalizeSubscription({
      id: "sub_missing_email",
    });

    expect(row.email).toBeNull();
  });

  it("extracts profile id from profileId and keeps missing email nullable", () => {
    const row = normalizeSubscription({
      profileId: "profile_camel",
    });

    expect(row.profile_id).toBe("profile_camel");
    expect(row.email).toBeNull();
  });

  it("extracts profile id from string profile", () => {
    const row = normalizeSubscription({
      profile: "01KPQ4M5FGR7KSJ9GB6D66AFF6",
    });

    expect(row.profile_id).toBe("01KPQ4M5FGR7KSJ9GB6D66AFF6");
  });

  it("extracts profile email from data.email", () => {
    expect(extractProfileEmail({ data: { email: " PROFILE@Example.COM " } })).toBe("profile@example.com");
  });

  it("extracts profile email from confirmed root email response", () => {
    expect(extractProfileEmail({
      email: " BATEY4LIFE052417@Yahoo.COM ",
      id: "pro_01KPQ4M5FGR7KSJ9GB6D66AFF6",
    })).toBe("batey4life052417@yahoo.com");
  });

  it("extracts profile email from metadata.email", () => {
    expect(extractProfileEmail({ data: { metadata: { email: " META@Example.COM " } } })).toBe("meta@example.com");
  });

  it("extracts profile email from fields.email", () => {
    expect(extractProfileEmail({ data: { fields: { email: " FIELDS@Example.COM " } } })).toBe("fields@example.com");
  });

  it("normalizes FunnelFox cents prices and detail fields", () => {
    const row = normalizeSubscription({
      id: "sub_detail",
      price_usd: 2999,
      currency: "USD",
      profile: { id: "pro_01KPQ4M5FGR7KSJ9GB6D66AFF6", email: " USER@Example.COM " },
      product: { id: "prod_1", name: "Monthly Plan" },
      funnel: { title: "Main Funnel", alias: "main" },
      session: { id: "sess_1" },
      cancellation_reason: "too_expensive",
    });

    expect(row.price_usd).toBe(29.99);
    expect(row.email).toBe("user@example.com");
    expect(row.profile_id).toBe("01KPQ4M5FGR7KSJ9GB6D66AFF6");
    expect(row.product_name).toBe("Monthly Plan");
    expect(row.product_id).toBe("prod_1");
    expect(row.funnel_title).toBe("Main Funnel");
    expect(row.funnel_alias).toBe("main");
    expect(row.session_id).toBe("sess_1");
    expect(row.cancellation_reason).toBe("too_expensive");
  });

  it("calculates cancellation timing when cancelled after the period ended", () => {
    const row = normalizeSubscription({
      id: "sub_cancelled_after_period",
      status: "cancelled",
      renews: false,
      cancellation_reason: "",
      created_at: "2026-03-31T12:02:01Z",
      period_ends_at: "2026-04-07T12:02:01Z",
      cancelled_at: "2026-04-14T10:07:56Z",
    });

    expect(row.cancellation_type).toBe("cancelled_unknown_reason");
    expect(row.cancellation_timing_bucket).toBe("after_period_end");
    expect(row.days_to_cancel).toBe(13);
    expect(row.hours_before_period_end).toBeLessThan(0);
  });

  it("classifies payment-related cancellations without overclaiming manual intent", () => {
    const row = normalizeSubscription({
      id: "sub_payment_failed",
      status: "past_due",
      renews: false,
      cancellation_reason: "card declined",
      created_at: "2026-04-01T00:00:00Z",
      period_ends_at: "2026-04-08T00:00:00Z",
      cancelled_at: "2026-04-07T12:00:00Z",
    });

    expect(row.cancellation_type).toBe("auto_payment_related");
    expect(row.cancellation_timing_bucket).toBe("before_renewal_48h");
    expect(row.hours_before_period_end).toBe(12);
  });
});
