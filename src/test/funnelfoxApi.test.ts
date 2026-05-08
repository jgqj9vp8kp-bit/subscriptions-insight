import { describe, expect, it } from "vitest";
import {
  dedupeFunnelFoxSubscriptions,
  isFunnelFoxDebugEnabled,
  isFunnelFoxTemporaryKeyInputEnabled,
  resolveFunnelFoxProxyUrl,
  sanitizeFunnelFoxDebugPayload,
} from "@/services/funnelfoxApi";

describe("FunnelFox API safety helpers", () => {
  it("removes duplicate subscriptions and keeps the latest updated record", () => {
    const result = dedupeFunnelFoxSubscriptions([
      { id: "sub_1", psp_id: "old", updated_at: "2026-04-01T00:00:00Z", status: "active" },
      { id: "sub_1", psp_id: "new", updated_at: "2026-04-02T00:00:00Z", status: "cancelled" },
      { subscription_id: "sub_2", updated_at: "2026-04-01T00:00:00Z", status: "active" },
      { psp_id: "psp_3", updated_at: "2026-04-01T00:00:00Z", status: "active" },
    ]);

    expect(result.rawCount).toBe(4);
    expect(result.dedupedCount).toBe(3);
    expect(result.duplicatesRemoved).toBe(1);
    expect(result.rows.find((row) => row.id === "sub_1")?.psp_id).toBe("new");
  });

  it("allows same-origin FunnelFox proxy paths", () => {
    const url = resolveFunnelFoxProxyUrl(
      "/api/funnelfox/subscriptions",
      "/api/funnelfox/subscriptions",
      { DEV: false },
      "https://example.com",
    );

    expect(url.toString()).toBe("https://example.com/api/funnelfox/subscriptions");
  });

  it("blocks direct browser calls to the public FunnelFox API", () => {
    expect(() =>
      resolveFunnelFoxProxyUrl(
        "https://api.funnelfox.io/public/v1/subscriptions",
        "/api/funnelfox/subscriptions",
        { DEV: false, VITE_ALLOW_EXTERNAL_FUNNELFOX_PROXY: "true" },
        "https://example.com",
      ),
    ).toThrow(/Direct browser calls/);
  });

  it("blocks external proxy URLs unless explicitly allowed", () => {
    expect(() =>
      resolveFunnelFoxProxyUrl(
        "https://proxy.example.com/api/funnelfox/subscriptions",
        "/api/funnelfox/subscriptions",
        { DEV: false },
        "https://example.com",
      ),
    ).toThrow(/External FunnelFox proxy URLs are disabled/);

    expect(
      resolveFunnelFoxProxyUrl(
        "https://proxy.example.com/api/funnelfox/subscriptions",
        "/api/funnelfox/subscriptions",
        { DEV: false, VITE_ALLOW_EXTERNAL_FUNNELFOX_PROXY: "true" },
        "https://example.com",
      ).origin,
    ).toBe("https://proxy.example.com");
  });

  it("allows Supabase Edge Functions base URL and maps to the requested function", () => {
    const url = resolveFunnelFoxProxyUrl(
      "https://wsjbpkderyhdefukppvb.supabase.co/functions/v1",
      "/api/funnelfox/subscriptions",
      { DEV: false },
      "https://example.com",
      "funnelfox-subscriptions",
    );

    expect(url.toString()).toBe("https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/funnelfox-subscriptions");
  });

  it("keeps Supabase Edge Function endpoint URLs unchanged", () => {
    const url = resolveFunnelFoxProxyUrl(
      "https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/funnelfox-subscription",
      "/api/funnelfox/subscription",
      { DEV: false },
      "https://example.com",
      "funnelfox-subscription",
    );

    expect(url.toString()).toBe("https://wsjbpkderyhdefukppvb.supabase.co/functions/v1/funnelfox-subscription");
  });

  it("keeps temporary key input disabled outside development", () => {
    expect(isFunnelFoxTemporaryKeyInputEnabled({ DEV: false })).toBe(false);
    expect(isFunnelFoxTemporaryKeyInputEnabled({ DEV: false, VITE_ENABLE_FUNNELFOX_KEY_INPUT: "true" })).toBe(false);
    expect(isFunnelFoxTemporaryKeyInputEnabled({ DEV: true })).toBe(true);
  });

  it("keeps raw debug disabled in production unless explicitly enabled", () => {
    expect(isFunnelFoxDebugEnabled({ DEV: false })).toBe(false);
    expect(isFunnelFoxDebugEnabled({ DEV: false, VITE_ENABLE_FUNNELFOX_DEBUG: "true" })).toBe(true);
    expect(isFunnelFoxDebugEnabled({ DEV: true })).toBe(true);
  });

  it("sanitizes sensitive debug payload fields", () => {
    const sanitized = sanitizeFunnelFoxDebugPayload({
      id: "sub_1",
      token: "secret-token",
      provider_metadata: { raw: "provider-private" },
      profile: {
        email: "user@example.com",
        card: { last4: "4242" },
      },
      nested: [{ payment_method: "pm_1" }],
    }) as Record<string, unknown>;

    expect(sanitized.id).toBe("sub_1");
    expect(sanitized.token).toBe("[redacted]");
    expect(sanitized.provider_metadata).toBe("[redacted]");
    expect((sanitized.profile as Record<string, unknown>).email).toBe("user@example.com");
    expect((sanitized.profile as Record<string, unknown>).card).toBe("[redacted]");
    expect(((sanitized.nested as Array<Record<string, unknown>>)[0]).payment_method).toBe("[redacted]");
  });
});
