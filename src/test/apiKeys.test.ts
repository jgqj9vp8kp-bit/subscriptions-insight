import { describe, expect, it } from "vitest";
import {
  API_KEY_PREFIX,
  API_KEY_SCOPE_CAMPAIGN_PERFORMANCE,
  apiKeyMatchesHash,
  apiKeyPrefix,
  generateApiKey,
  hashApiKey,
  validateApiKeyRecord,
} from "@/services/apiKeys";

describe("API export keys", () => {
  it("generates Subengine live API keys", () => {
    const key = generateApiKey(new Uint8Array(32).fill(7));

    expect(key.startsWith(API_KEY_PREFIX)).toBe(true);
    expect(apiKeyPrefix(key)).toMatch(/^subengine_live_/);
  });

  it("hashes and validates API keys without storing the raw key", async () => {
    const rawKey = generateApiKey(new Uint8Array(32).fill(11));
    const keyHash = await hashApiKey(rawKey);

    expect(keyHash).not.toBe(rawKey);
    expect(await apiKeyMatchesHash(rawKey, keyHash)).toBe(true);
  });

  it("rejects revoked keys", async () => {
    const rawKey = generateApiKey(new Uint8Array(32).fill(13));
    const result = await validateApiKeyRecord(rawKey, {
      key_hash: await hashApiKey(rawKey),
      is_active: false,
      revoked_at: "2026-06-11T00:00:00Z",
      allowed_scopes: [API_KEY_SCOPE_CAMPAIGN_PERFORMANCE],
    });

    expect(result).toEqual({ ok: false, status: 401, reason: "revoked_key" });
  });

  it("returns 401 for invalid keys", async () => {
    const rawKey = generateApiKey(new Uint8Array(32).fill(17));
    const otherKey = generateApiKey(new Uint8Array(32).fill(19));
    const result = await validateApiKeyRecord(rawKey, {
      key_hash: await hashApiKey(otherKey),
      is_active: true,
      allowed_scopes: [API_KEY_SCOPE_CAMPAIGN_PERFORMANCE],
    });

    expect(result).toEqual({ ok: false, status: 401, reason: "invalid_key" });
  });
});
