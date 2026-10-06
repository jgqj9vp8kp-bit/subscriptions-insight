// Constant-time secret comparison (plan §12.7). The cron secret used to be
// compared with `!==`, which returns at the first differing character.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { timingSafeEqual } from "../../supabase/functions/_shared/access/timingSafe.ts";

describe("timingSafeEqual", () => {
  it("matches identical strings", () => {
    expect(timingSafeEqual("s3cret-value", "s3cret-value")).toBe(true);
    expect(timingSafeEqual("", "")).toBe(true);
    expect(timingSafeEqual("ключ-🔑", "ключ-🔑")).toBe(true);
  });

  it("rejects a difference at any position", () => {
    const secret = "abcdefghij";
    for (let index = 0; index < secret.length; index += 1) {
      const altered = `${secret.slice(0, index)}X${secret.slice(index + 1)}`;
      expect(timingSafeEqual(altered, secret), `position ${index}`).toBe(false);
    }
  });

  it("rejects length mismatches, including prefixes and the empty string", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
    expect(timingSafeEqual("abcd", "abc")).toBe(false);
    expect(timingSafeEqual("", "abc")).toBe(false);
    expect(timingSafeEqual("abc", "")).toBe(false);
  });

  it("does not equate a string with its NUL-padded form", () => {
    // Past-the-end reads fold to 0; the length term must still reject this.
    expect(timingSafeEqual("abc", "abc\u0000")).toBe(false);
  });

  it("treats non-string input as empty instead of throwing", () => {
    expect(timingSafeEqual(undefined as unknown as string, "x")).toBe(false);
    expect(timingSafeEqual(null as unknown as string, null as unknown as string)).toBe(true);
  });
});

describe("secret comparisons use it", () => {
  it("the legacy caller-as-tenant cron helper is gone; http.ts compares no secret itself", () => {
    // requireCronSecret took the tenant from the request body after the secret
    // check (plan R14). Cron authentication now lives only in the gate.
    const http = readFileSync("supabase/functions/_shared/clickhouse/http.ts", "utf8");
    expect(http).not.toMatch(/function\s+requireCronSecret\b/);
    expect(http).not.toMatch(/x-cron-secret|FB_CRON_SECRET/);
    expect(http).not.toMatch(/body\.auth_user_id/);
    expect(http).not.toMatch(/provided\s*[!=]==?\s*secret/);
  });

  it("the access gate compares the cron secret in constant time", () => {
    const gate = readFileSync("supabase/functions/_shared/access/gate.ts", "utf8");
    expect(gate).toContain("timingSafeEqual(provided, secret)");
    expect(gate).not.toMatch(/provided\s*[!=]==?\s*secret/);
  });
});
