// Platform classification: UA-first with a wallet fallback that must NEVER
// override a user_agent verdict — neither inside one transaction nor across a
// user's history (the 2026-08-03 product decision this filter ships under).
import { describe, expect, it } from "vitest";
import {
  PLATFORM_VALUES,
  platformForUserTransactions,
  platformFromTransaction,
  platformFromUserAgent,
  platformFromWallet,
  platformLabel,
} from "@/services/userPlatform";
import type { Transaction } from "@/services/types";

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";

function tx(over: Partial<Transaction>): Transaction {
  return {
    transaction_id: "t1",
    user_id: "u1",
    email: "a@b.c",
    event_time: "2026-07-01T10:00:00Z",
    amount_usd: 10,
    gross_amount_usd: 10,
    refund_amount_usd: 0,
    net_amount_usd: 10,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "trial",
    funnel: "soulmate",
    campaign_path: "soulmate-sketch",
    product: "p",
    traffic_source: "facebook",
    campaign_id: "c1",
    classification_reason: "",
    ...over,
  } as Transaction;
}

describe("platformFromUserAgent", () => {
  it("classifies the big four and the Android-contains-Linux / iOS-contains-Mac traps", () => {
    expect(platformFromUserAgent(IPHONE_UA)).toBe("ios");
    expect(platformFromUserAgent(ANDROID_UA)).toBe("android"); // contains "Linux" — android must win
    expect(platformFromUserAgent(WINDOWS_UA)).toBe("windows");
    expect(platformFromUserAgent(MAC_UA)).toBe("macos"); // iPhone UA contains "like Mac OS X" — checked above
    expect(platformFromUserAgent("Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X)")).toBe("ios");
    expect(platformFromUserAgent(LINUX_UA)).toBe("other");
  });

  it("returns null (not unknown) for empty or unrecognized UAs so the wallet may speak", () => {
    expect(platformFromUserAgent("")).toBeNull();
    expect(platformFromUserAgent(undefined)).toBeNull();
    expect(platformFromUserAgent("SomeBot/1.0")).toBeNull();
  });
});

describe("platformFromWallet", () => {
  it("maps device-locked wallets and nothing else", () => {
    expect(platformFromWallet("APPLE_PAY")).toBe("ios");
    expect(platformFromWallet("GOOGLE_PAY")).toBe("android");
    expect(platformFromWallet("google pay")).toBe("android");
    expect(platformFromWallet("PAYMENT_CARD")).toBeNull();
    expect(platformFromWallet("PAYPAL")).toBeNull();
    expect(platformFromWallet(null)).toBeNull();
  });
});

describe("platformFromTransaction precedence", () => {
  it("user_agent wins over a conflicting wallet in the same transaction", () => {
    const t = tx({ metadata: { user_agent: ANDROID_UA }, raw: { paymentInstrumentType: "APPLE_PAY" } });
    expect(platformFromTransaction(t)).toBe("android");
  });

  it("wallet fills in only when the UA is absent or unrecognizable", () => {
    expect(platformFromTransaction(tx({ raw: { paymentInstrumentType: "APPLE_PAY" } }))).toBe("ios");
    expect(platformFromTransaction(tx({ metadata: { user_agent: "SomeBot/1.0" }, raw: { paymentInstrumentType: "GOOGLE_PAY" } }))).toBe("android");
    expect(platformFromTransaction(tx({}))).toBeNull();
  });

  it("reads metadata whether it is an object, a JSON string, or nested under raw", () => {
    expect(platformFromTransaction(tx({ metadata: { user_agent: IPHONE_UA } }))).toBe("ios");
    expect(platformFromTransaction(tx({ raw: { metadata: JSON.stringify({ user_agent: IPHONE_UA }) } }))).toBe("ios");
    expect(platformFromTransaction(tx({ raw: { metadata: { user_agent: IPHONE_UA } } }))).toBe("ios");
  });
});

describe("platformForUserTransactions", () => {
  it("UA evidence from a later transaction outranks wallet evidence from an earlier successful one", () => {
    const walletFirst = tx({ transaction_id: "t1", event_time: "2026-07-01T00:00:00Z", raw: { paymentInstrumentType: "APPLE_PAY" } });
    const uaLater = tx({ transaction_id: "t2", event_time: "2026-07-20T00:00:00Z", metadata: { user_agent: ANDROID_UA } });
    expect(platformForUserTransactions([walletFirst, uaLater])).toBe("android");
  });

  it("within the UA tier the earliest successful transaction decides", () => {
    const failedEarly = tx({ transaction_id: "t1", event_time: "2026-07-01T00:00:00Z", status: "failed", metadata: { user_agent: ANDROID_UA } });
    const successLater = tx({ transaction_id: "t2", event_time: "2026-07-02T00:00:00Z", metadata: { user_agent: IPHONE_UA } });
    expect(platformForUserTransactions([failedEarly, successLater])).toBe("ios");
    // With no successful UA row at all, the earliest available UA decides.
    expect(platformForUserTransactions([failedEarly])).toBe("android");
  });

  it("returns unknown when no transaction carries any signal", () => {
    expect(platformForUserTransactions([tx({}), tx({ transaction_id: "t2" })])).toBe("unknown");
  });
});

describe("labels", () => {
  it("covers every normalized value with the approved UI label", () => {
    const labels = PLATFORM_VALUES.map(platformLabel);
    expect(labels).toEqual(["iOS", "Android", "Windows", "macOS", "Other", "Unknown"]);
  });
});
