import type { Transaction } from "@/services/types";

type ObjectMap = Record<string, unknown>;

function objectFrom(value: unknown): ObjectMap {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as ObjectMap;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ObjectMap;
    } catch {
      return {};
    }
  }
  return {};
}

export function normalizeCountryCode(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toUpperCase();
  return normalized || null;
}

function metadataForTransaction(tx: Transaction): ObjectMap {
  return objectFrom(tx.metadata);
}

function rawForTransaction(tx: Transaction): ObjectMap {
  return objectFrom(tx.raw);
}

function rawMetadataForTransaction(tx: Transaction): ObjectMap {
  return objectFrom(rawForTransaction(tx).metadata);
}

function firstCountryFromSources(tx: Transaction, keys: string[]): string | null {
  const metadata = metadataForTransaction(tx);
  const raw = rawForTransaction(tx);
  const rawMetadata = rawMetadataForTransaction(tx);

  for (const key of keys) {
    const value = normalizeCountryCode(metadata[key]);
    if (value) return value;
  }
  for (const key of keys) {
    const value = normalizeCountryCode(rawMetadata[key]);
    if (value) return value;
  }
  for (const key of keys) {
    const value = normalizeCountryCode(raw[key]);
    if (value) return value;
  }

  return null;
}

export function ffCountryCodeFromTransaction(tx: Transaction): string | null {
  return firstCountryFromSources(tx, ["ff_country_code"]);
}

export function countryCodeFromTransaction(tx: Transaction): string | null {
  return firstCountryFromSources(tx, ["ff_country_code", "country", "country_code", "ip_country"]);
}

export function countryCodeForUserTransactions(txs: Transaction[]): string | null {
  const sorted = [...txs].sort((a, b) => (a.event_time < b.event_time ? -1 : 1));
  const firstSuccessful = sorted.find((tx) => tx.status === "success");
  const firstSuccessfulFfCountry = firstSuccessful ? ffCountryCodeFromTransaction(firstSuccessful) : null;
  if (firstSuccessfulFfCountry) return firstSuccessfulFfCountry;

  for (const tx of sorted) {
    const country = ffCountryCodeFromTransaction(tx);
    if (country) return country;
  }

  for (const tx of sorted) {
    const country = countryCodeFromTransaction(tx);
    if (country) return country;
  }

  return null;
}
