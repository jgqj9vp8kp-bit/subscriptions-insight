import { parseCSVText, type ParsedSheet } from "@/services/import";

export interface TrafficMetric {
  date: string;
  campaign_path: string;
  trial_count: number;
  cac: number;
  spend: number;
  clicks: number;
  cpc: number;
  cpm: number;
  ctr: number;
  source: "facebook";
}

const HEADER_ALIASES = {
  date: ["date", "дата"],
  campaign_path: ["ff_campaign_path", "campaign_path", "campaign path", "ff campaign path"],
  trial_count: ["trial count", "trial_count", "trials", "trial"],
  cac: ["cac"],
  spend: ["spend", "cost", "amount spent"],
  clicks: ["clicks"],
  cpc: ["cpc"],
  cpm: ["cpm"],
  ctr: ["ctr"],
} as const;

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-zа-яё0-9]+/gi, "");
}

function columnFor(headers: string[], aliases: readonly string[]): string | null {
  const normalizedAliases = aliases.map(normalizeHeader);
  return headers.find((header) => normalizedAliases.includes(normalizeHeader(header))) ?? null;
}

export function normalizeCampaignPath(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase();
}

export function parseTrafficNumber(value: unknown): number {
  const raw = String(value ?? "").trim();
  if (!raw) return 0;
  const cleaned = raw
    .replace(/\s+/g, "")
    .replace(/[%$€]/g, "")
    .replace(",", ".")
    .replace(/[^0-9.-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeTrafficDate(value: unknown, year: number): string {
  const raw = String(value ?? "").trim();
  const withYear = raw.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (withYear) {
    const [, day, month, rawYear] = withYear;
    const fullYear = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
    return `${fullYear}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const dayMonth = raw.match(/^(\d{1,2})[./-](\d{1,2})$/);
  if (dayMonth) {
    const [, day, month] = dayMonth;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const yyyy = parsed.getFullYear();
    const mm = String(parsed.getMonth() + 1).padStart(2, "0");
    const dd = String(parsed.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  }

  return `${year}-01-01`;
}

export function googleSheetTrafficCsvUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes("/export?") || trimmed.endsWith(".csv")) return trimmed;

  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = idMatch ? idMatch[1] : trimmed.match(/^[a-zA-Z0-9-_]{20,}$/) ? trimmed : null;
  if (!id) return null;
  const gidMatch = trimmed.match(/[#?&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`;
}

export function parseTrafficMetrics(parsed: ParsedSheet, year: number): TrafficMetric[] {
  const headers = parsed.headers;
  const cols = {
    date: columnFor(headers, HEADER_ALIASES.date),
    campaign_path: columnFor(headers, HEADER_ALIASES.campaign_path),
    trial_count: columnFor(headers, HEADER_ALIASES.trial_count),
    cac: columnFor(headers, HEADER_ALIASES.cac),
    spend: columnFor(headers, HEADER_ALIASES.spend),
    clicks: columnFor(headers, HEADER_ALIASES.clicks),
    cpc: columnFor(headers, HEADER_ALIASES.cpc),
    cpm: columnFor(headers, HEADER_ALIASES.cpm),
    ctr: columnFor(headers, HEADER_ALIASES.ctr),
  };

  if (!cols.date || !cols.campaign_path) {
    throw new Error("Traffic sheet must include Date and ff_campaign_path columns.");
  }

  return parsed.rows
    .map((row) => ({
      date: normalizeTrafficDate(row[cols.date!] ?? "", year),
      campaign_path: normalizeCampaignPath(row[cols.campaign_path!] ?? ""),
      trial_count: parseTrafficNumber(cols.trial_count ? row[cols.trial_count] : 0),
      cac: parseTrafficNumber(cols.cac ? row[cols.cac] : 0),
      spend: parseTrafficNumber(cols.spend ? row[cols.spend] : 0),
      clicks: parseTrafficNumber(cols.clicks ? row[cols.clicks] : 0),
      cpc: parseTrafficNumber(cols.cpc ? row[cols.cpc] : 0),
      cpm: parseTrafficNumber(cols.cpm ? row[cols.cpm] : 0),
      ctr: parseTrafficNumber(cols.ctr ? row[cols.ctr] : 0),
      source: "facebook" as const,
    }))
    .filter((row) => row.date && row.campaign_path);
}

export async function fetchTrafficMetricsFromGoogleSheet(url: string, year: number): Promise<TrafficMetric[]> {
  const csvUrl = googleSheetTrafficCsvUrl(url);
  if (!csvUrl) throw new Error("Could not parse Google Sheet URL.");
  const res = await fetch(csvUrl);
  if (!res.ok) {
    throw new Error(`Could not load Facebook traffic sheet (HTTP ${res.status}).`);
  }
  const text = await res.text();
  return parseTrafficMetrics(parseCSVText(text), year);
}
