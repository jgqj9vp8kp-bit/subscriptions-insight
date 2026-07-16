import type { MediaBuyer, Transaction } from "./serviceTypes.ts";

export const MEDIA_BUYER_VALUES: MediaBuyer[] = ["Ivan", "Artem A", "Artem D", "Unknown"];

// Single source of truth for utm_source → media buyer attribution.
// The three Supabase Edge Functions (export-campaign-performance, sync-support-mail,
// funnelfox-leads-sync) cannot import browser code and keep local copies of this map —
// they must stay in sync with it (guarded by src/test/mediaBuyerMapping.test.ts).
export const MEDIA_BUYER_BY_UTM_SOURCE: Record<string, MediaBuyer> = {
  "4": "Ivan",
  "19": "Artem A",
  "22": "Artem D",
};

const UTM_SOURCE_PATHS = [
  ["utm_source"],
  ["user", "utm_source"],
  ["transaction", "utm_source"],
  ["metadata", "utm_source"],
  ["raw_payload", "utm_source"],
  ["normalized_payload", "utm_source"],
  ["raw_payload", "metadata", "utm_source"],
  ["normalized_payload", "metadata", "utm_source"],
] as const;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function objectFrom(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function valueAtPath(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const segment of path) {
    const object = objectFrom(current);
    if (!object) return undefined;
    if (segment in object) {
      current = object[segment];
      continue;
    }

    const normalizedSegment = normalizeKey(segment);
    const matchingKey = Object.keys(object).find((key) => normalizeKey(key) === normalizedSegment);
    if (!matchingKey) return undefined;
    current = object[matchingKey];
  }
  return current;
}

export function normalizeUtmSource(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function utmSourceFromSource(source: unknown): string | null {
  for (const path of UTM_SOURCE_PATHS) {
    const normalized = normalizeUtmSource(valueAtPath(source, path));
    if (normalized) return normalized;
  }
  return null;
}

export function utmSourceFromTransaction(tx: Transaction): string | null {
  return (
    utmSourceFromSource(tx) ??
    utmSourceFromSource(tx.metadata) ??
    utmSourceFromSource(tx.raw) ??
    utmSourceFromSource(tx.raw?.metadata) ??
    null
  );
}

export function mediaBuyerFromUtmSource(utmSource: unknown): MediaBuyer {
  const normalized = normalizeUtmSource(utmSource);
  return normalized ? MEDIA_BUYER_BY_UTM_SOURCE[normalized] ?? "Unknown" : "Unknown";
}

export function mediaBuyerForUserTransactions(txs: Transaction[]): { utm_source: string | null; media_buyer: MediaBuyer } {
  const sorted = [...txs].sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));
  const firstSuccessfulTrial = sorted.find((tx) => tx.status === "success" && tx.transaction_type === "trial");
  const trialUtmSource = firstSuccessfulTrial ? utmSourceFromTransaction(firstSuccessfulTrial) : null;
  if (trialUtmSource) {
    return {
      utm_source: trialUtmSource,
      media_buyer: mediaBuyerFromUtmSource(trialUtmSource),
    };
  }

  const firstAvailable = sorted.find((tx) => utmSourceFromTransaction(tx));
  const fallbackUtmSource = firstAvailable ? utmSourceFromTransaction(firstAvailable) : null;
  return {
    utm_source: fallbackUtmSource,
    media_buyer: mediaBuyerFromUtmSource(fallbackUtmSource),
  };
}

export function mediaBuyerLabel(mediaBuyer: MediaBuyer): string {
  return mediaBuyer;
}
