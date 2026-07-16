import { parseCSVText, type ParsedSheet } from "@/services/import";

export interface TrafficMetric {
  date: string;
  campaign_path: string;
  campaign_id?: string | null;
  campaign_name?: string | null;
  ad_account_id?: string | null;
  ad_account_name?: string | null;
  trial_count: number;
  cac: number;
  spend: number;
  fb_purchases?: number;
  cpp?: number | null;
  impressions?: number;
  clicks: number;
  outbound_clicks?: number;
  outbound_ctr?: number | null;
  cpc: number;
  cpm: number;
  ctr: number;
  currency?: string | null;
  last_import_at?: string;
  source: "facebook";
}

export interface GoogleSheetReference {
  sheetId: string;
  gid: string | null;
}

export interface GoogleSheetTab {
  name: string;
  gid: string;
}

export interface TrafficImportResult {
  rows: TrafficMetric[];
  sheetId: string;
  gid: string;
  tabName?: string;
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

function parseGoogleSheetGid(input: string): string | null {
  const gidMatch = input.match(/(?:[?#&]|^)gid=(\d+)/);
  return gidMatch ? gidMatch[1] : null;
}

function decodeGoogleSheetName(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
}

function uniqueTabs(tabs: GoogleSheetTab[]): GoogleSheetTab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    if (!tab.gid || seen.has(tab.gid)) return false;
    seen.add(tab.gid);
    return true;
  });
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

export function parseGoogleSheetReference(input: string): GoogleSheetReference | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = idMatch ? idMatch[1] : trimmed.match(/^[a-zA-Z0-9-_]{20,}$/) ? trimmed : null;
  if (!id) return null;

  return { sheetId: id, gid: parseGoogleSheetGid(trimmed) };
}

export function googleSheetTrafficCsvUrl(input: string, gidOverride?: string | null): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const explicitGid = gidOverride?.trim();
  if (explicitGid && !/^\d+$/.test(explicitGid)) {
    throw new Error("Invalid Google Sheet gid. Use the numeric gid from the sheet URL.");
  }

  const ref = parseGoogleSheetReference(trimmed);
  if (!ref) {
    if (!explicitGid && (trimmed.includes("/export?") || trimmed.endsWith(".csv"))) return trimmed;
    return null;
  }

  const gid = explicitGid || ref.gid || "0";
  return `https://docs.google.com/spreadsheets/d/${ref.sheetId}/export?format=csv&gid=${gid}`;
}

export function parseGoogleSheetTabsFromHtml(html: string): GoogleSheetTab[] {
  const tabs: GoogleSheetTab[] = [];
  const namedSheetPatterns = [
    /\{"id":(\d+),"name":"((?:[^"\\]|\\.)+)"/g,
    /"sheetId":(\d+),"title":"((?:[^"\\]|\\.)+)"/g,
  ];

  for (const pattern of namedSheetPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html))) {
      tabs.push({ gid: match[1], name: decodeGoogleSheetName(match[2]) });
    }
  }

  const anchorPattern = /gid=(\d+)[^>]*>([^<]+)</g;
  let anchorMatch: RegExpExecArray | null;
  while ((anchorMatch = anchorPattern.exec(html))) {
    const name = anchorMatch[2].trim();
    if (name) tabs.push({ gid: anchorMatch[1], name });
  }

  const gidPattern = /gid=(\d+)/g;
  let gidMatch: RegExpExecArray | null;
  while ((gidMatch = gidPattern.exec(html))) {
    tabs.push({ gid: gidMatch[1], name: `gid ${gidMatch[1]}` });
  }

  return uniqueTabs(tabs);
}

export async function fetchGoogleSheetTrafficTabs(input: string): Promise<GoogleSheetTab[]> {
  const ref = parseGoogleSheetReference(input);
  if (!ref) throw new Error("Could not parse Google Sheet URL.");

  const res = await fetch(`https://docs.google.com/spreadsheets/d/${ref.sheetId}/edit?usp=sharing`);
  if (!res.ok) {
    throw new Error(
      `Could not load Google Sheet tabs (HTTP ${res.status}). Make sure the sheet is shared as "Anyone with the link can view".`,
    );
  }

  const html = await res.text();
  const tabs = parseGoogleSheetTabsFromHtml(html);
  if (!tabs.length) {
    throw new Error("Could not detect tabs for this Google Sheet. Enter the tab gid manually.");
  }
  return tabs;
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

export async function fetchFacebookTrafficImportFromGoogleSheet(
  url: string,
  year: number,
  options: { gid?: string | null; tabName?: string } = {},
): Promise<TrafficImportResult> {
  const ref = parseGoogleSheetReference(url);
  if (!ref) throw new Error("Could not parse Google Sheet URL.");

  const gid = options.gid?.trim() || ref.gid || "0";
  if (!/^\d+$/.test(gid)) throw new Error("Invalid Google Sheet gid. Use the numeric gid from the sheet URL.");

  const csvUrl = googleSheetTrafficCsvUrl(url, gid);
  if (!csvUrl) throw new Error("Could not parse Google Sheet URL.");
  const res = await fetch(csvUrl);
  if (!res.ok) {
    throw new Error(
      `Could not load Facebook traffic sheet tab gid ${gid} (HTTP ${res.status}). Make sure the sheet and tab are shared as "Anyone with the link can view".`,
    );
  }
  const text = await res.text();
  if (!text.trim()) throw new Error(`Google Sheet tab gid ${gid} returned an empty CSV.`);

  const parsed = parseCSVText(text);
  if (!parsed.headers.length || !parsed.rows.length) {
    throw new Error(`Google Sheet tab gid ${gid} did not contain any traffic rows.`);
  }

  const rows = parseTrafficMetrics(parsed, year);
  if (!rows.length) {
    throw new Error(`Google Sheet tab gid ${gid} did not contain any usable traffic rows.`);
  }

  return {
    rows,
    sheetId: ref.sheetId,
    gid,
    tabName: options.tabName,
  };
}

export async function fetchTrafficMetricsFromGoogleSheet(url: string, year: number): Promise<TrafficMetric[]> {
  const result = await fetchFacebookTrafficImportFromGoogleSheet(url, year);
  return result.rows;
}
