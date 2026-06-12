import { afterEach, describe, expect, it, vi } from "vitest";
import { bytesToHex, sha256BytesSync, sha256Hex } from "@/services/sha256";

const subtleDigest = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
};

const fallbackDigest = (value: string): string =>
  bytesToHex(sha256BytesSync(new TextEncoder().encode(value)));

describe("sha256 pure-JS fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("matches the NIST test vectors", () => {
    expect(fallbackDigest("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(fallbackDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(fallbackDigest("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches crypto.subtle across block-boundary lengths and unicode", async () => {
    const samples = [
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(63),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(1000),
      "пользователь@пример.рф|9.99|2026-06-12T00:00:00Z",
      "emoji \u{1F511} key material",
    ];
    for (const sample of samples) {
      expect(fallbackDigest(sample)).toBe(await subtleDigest(sample));
    }
  });

  it("sha256Hex falls back when crypto.subtle is unavailable (plain-HTTP LAN context)", async () => {
    const expected = await sha256Hex("abc");
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    expect(globalThis.crypto.subtle).toBeUndefined();
    expect(await sha256Hex("abc")).toBe(expected);
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
