// User platform (device OS) classification from payment-session evidence.
//
// Source precedence is a product decision (2026-08-03) and is load-bearing:
//   1. metadata.user_agent — the browser UA of the paying session;
//   2. ONLY when the UA is absent or unrecognizable, the wallet instrument:
//      APPLE_PAY → ios, GOOGLE_PAY → android (wallets are device-locked;
//      desktop share in this dataset is <1%, so the inference is safe);
//   3. otherwise "unknown".
// The wallet fallback must never override a UA-derived verdict — neither within
// one transaction nor across a user's history (platformForUserTransactions
// exhausts UA evidence over ALL transactions before consulting wallets).
import type { Transaction } from "./serviceTypes.ts";
import { valueAtPath } from "./userCardType.ts";

export type Platform = "ios" | "android" | "windows" | "macos" | "other" | "unknown";

export const PLATFORM_VALUES: Platform[] = ["ios", "android", "windows", "macos", "other", "unknown"];

/** Classify a raw User-Agent string. Returns null (not "unknown") when the UA
 * is empty or unrecognized, so the caller can fall through to the wallet. */
export function platformFromUserAgent(userAgent: unknown): Platform | null {
  const ua = String(userAgent ?? "").trim();
  if (!ua) return null;
  // Order matters: Android UAs contain "Linux"; iOS UAs contain "like Mac OS X".
  if (/android/i.test(ua)) return "android";
  if (/iphone|ipad|ipod/i.test(ua)) return "ios";
  if (/windows/i.test(ua)) return "windows";
  if (/macintosh|mac os x/i.test(ua)) return "macos";
  if (/linux|x11|cros/i.test(ua)) return "other";
  return null;
}

/** APPLE_PAY / GOOGLE_PAY → platform; anything else (cards, PayPal, …) → null. */
export function platformFromWallet(instrumentType: unknown): Platform | null {
  const value = String(instrumentType ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (value === "APPLE_PAY") return "ios";
  if (value === "GOOGLE_PAY") return "android";
  return null;
}

// Metadata may arrive as an object (normalized payload) or a JSON string
// (raw Palmer payload keeps it serialized). Collect every parseable shape.
function metadataObjects(tx: Transaction): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (value: unknown) => {
    if (!value) return;
    if (typeof value === "string") {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
      } catch { /* not JSON — ignore */ }
      return;
    }
    if (typeof value === "object" && !Array.isArray(value)) out.push(value as Record<string, unknown>);
  };
  push(tx.metadata);
  if (tx.raw && typeof tx.raw === "object") push((tx.raw as Record<string, unknown>).metadata);
  return out;
}

function userAgentPlatform(tx: Transaction): Platform | null {
  for (const meta of metadataObjects(tx)) {
    const platform = platformFromUserAgent(valueAtPath(meta, ["user_agent"]));
    if (platform) return platform;
  }
  return null;
}

function walletPlatform(tx: Transaction): Platform | null {
  return (
    platformFromWallet(valueAtPath(tx, ["paymentInstrumentType"])) ??
    platformFromWallet(valueAtPath(tx.raw, ["paymentInstrumentType"])) ??
    null
  );
}

export function platformFromTransaction(tx: Transaction): Platform | null {
  return userAgentPlatform(tx) ?? walletPlatform(tx);
}

/** User-level platform across a user's transactions. UA evidence from ANY
 * transaction outranks wallet evidence from any other (the no-override rule);
 * within a tier: earliest successful transaction first, then earliest overall —
 * the same ordering cardTypeForUserTransactions uses. */
export function platformForUserTransactions(txs: Transaction[]): Platform {
  const sorted = [...txs].sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));
  for (const derive of [userAgentPlatform, walletPlatform]) {
    const firstSuccessful = sorted.find((tx) => tx.status === "success" && derive(tx));
    if (firstSuccessful) return derive(firstSuccessful) ?? "unknown";
    const firstAvailable = sorted.find((tx) => derive(tx));
    if (firstAvailable) return derive(firstAvailable) ?? "unknown";
  }
  return "unknown";
}

export function platformLabel(platform: string): string {
  if (platform === "ios") return "iOS";
  if (platform === "android") return "Android";
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "other") return "Other";
  return "Unknown";
}
