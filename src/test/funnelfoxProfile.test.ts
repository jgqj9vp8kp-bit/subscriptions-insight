import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectProfileEmail,
  isFunnelFoxDebugEnabled,
  profileDebugBody,
  profileMinimalBody,
} from "../../supabase/functions/_shared/funnelfox";

// P0-5: the funnelfox-profile endpoint must NOT expose the full raw profile / detected customer
// email by default. These tests pin the building blocks the endpoint uses for that decision.

const samplePayload = {
  data: {
    email: "Person@Example.com",
    first_name: "Pat",
    secret_token: "shh-do-not-leak",
    metadata: { plan: "premium" },
  },
};

describe("funnelfox profile minimal body (P0-5)", () => {
  it("returns ONLY the profile id and resolved email — no raw profile or field enumeration", () => {
    const body = profileMinimalBody("profile-1", samplePayload);

    expect(Object.keys(body).sort()).toEqual(["email", "profile_id"]);
    expect(body).toEqual({ profile_id: "profile-1", email: "person@example.com" });
    // None of the PII-leaking debug fields are present.
    expect(body).not.toHaveProperty("raw_profile_keys");
    expect(body).not.toHaveProperty("profile");
    expect(body).not.toHaveProperty("email_like_fields_found");
    expect(body).not.toHaveProperty("detected_email");
  });

  it("resolves the email from a nested FunnelFox payload", () => {
    expect(detectProfileEmail(samplePayload)).toBe("person@example.com");
    expect(detectProfileEmail({})).toBeNull();
  });
});

describe("funnelfox profile debug body (P0-5)", () => {
  it("still exposes the rich diagnostic info (only used when debug is enabled server-side)", () => {
    const body = profileDebugBody("profile-1", samplePayload);

    expect(body.raw_profile_keys).toContain("email");
    expect(body.detected_email).toBe("person@example.com");
    // Sensitive keys remain redacted inside the profile dump.
    expect((body.profile as Record<string, unknown>).secret_token).toBe("[redacted]");
  });
});

describe("isFunnelFoxDebugEnabled (P0-5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const withDenoEnv = (value: string | undefined) => {
    vi.stubGlobal("Deno", { env: { get: (key: string) => (key === "FUNNELFOX_DEBUG" ? value : undefined) } });
  };

  it("is false in production (flag unset)", () => {
    withDenoEnv(undefined);
    expect(isFunnelFoxDebugEnabled()).toBe(false);
  });

  it("is false when the flag is explicitly off", () => {
    withDenoEnv("false");
    expect(isFunnelFoxDebugEnabled()).toBe(false);
  });

  it("is true only when explicitly enabled", () => {
    withDenoEnv("true");
    expect(isFunnelFoxDebugEnabled()).toBe(true);
    withDenoEnv("1");
    expect(isFunnelFoxDebugEnabled()).toBe(true);
  });
});
