/**
 * Import utilities for CSV files and public Google Sheets.
 *
 * Google Sheets are fetched via the gviz CSV export endpoint, which works for
 * any sheet that is shared as "Anyone with the link can view" — no API key
 * needed. The user pastes a normal sheet URL; we extract the spreadsheet ID
 * (and optional gid) and request the CSV.
 */
import Papa from "papaparse";
import type {
  Funnel,
  TrafficSource,
  Transaction,
  TransactionStatus,
  TransactionType,
} from "./types";
import { addCohortFields } from "./palmerTransform";

export const TARGET_FIELDS: { key: keyof Transaction; label: string; required: boolean }[] = [
  { key: "transaction_id", label: "Transaction ID", required: true },
  { key: "user_id", label: "User ID", required: true },
  { key: "email", label: "Email", required: true },
  { key: "event_time", label: "Event time", required: true },
  { key: "amount_usd", label: "Amount (USD)", required: true },
  { key: "currency", label: "Currency", required: false },
  { key: "status", label: "Status", required: true },
  { key: "transaction_type", label: "Transaction type", required: true },
  { key: "funnel", label: "Funnel", required: false },
  { key: "product", label: "Product", required: false },
  { key: "traffic_source", label: "Traffic source", required: false },
  { key: "campaign_id", label: "Campaign ID", required: false },
  { key: "classification_reason", label: "Classification reason", required: false },
];

export type ColumnMapping = Partial<Record<keyof Transaction, string>>;

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, string>[];
}

export interface MapResult {
  rows: Transaction[];
  errors: { row: number; message: string }[];
}

/** Loose normalization to match user-supplied headers to our schema. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Synonyms used during auto-mapping. Loose, additive — user can override in UI. */
const SYNONYMS: Record<keyof Transaction, string[]> = {
  transaction_id: ["transactionid", "txid", "id", "transaction"],
  user_id: ["userid", "uid", "customerid", "customer"],
  email: ["email", "useremail", "customeremail"],
  event_time: ["eventtime", "createdat", "timestamp", "time", "date", "datetime", "occurredat"],
  amount_usd: ["amount", "amountusd", "total", "price", "value", "revenue"],
  currency: ["currency", "ccy"],
  status: ["status", "state", "result"],
  transaction_type: ["transactiontype", "type", "eventtype", "kind"],
  funnel: ["funnel", "product_funnel", "productline"],
  product: ["product", "plan", "sku", "productname"],
  traffic_source: ["trafficsource", "source", "channel", "utmsource"],
  campaign_id: ["campaignid", "campaign", "utmcampaign"],
  classification_reason: ["classificationreason", "reason", "note", "comment"],
};

export function autoMap(headers: string[]): ColumnMapping {
  // Clean-template imports still go through user-controlled column mapping.
  // Palmer raw imports bypass this and use palmerTransform.ts instead.
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  const headerByNorm = new Map<string, string>();
  for (const h of headers) headerByNorm.set(norm(h), h);

  for (const field of TARGET_FIELDS) {
    const candidates = [field.key, ...(SYNONYMS[field.key] ?? [])];
    for (const c of candidates) {
      const hit = headerByNorm.get(norm(c));
      if (hit && !used.has(hit)) {
        mapping[field.key] = hit;
        used.add(hit);
        break;
      }
    }
  }
  return mapping;
}

const VALID_TYPES: TransactionType[] = [
  "trial",
  "upsell",
  "first_subscription",
  "renewal",
  "failed_payment",
  "refund",
  "chargeback",
  "unknown",
];
const VALID_STATUSES: TransactionStatus[] = ["success", "failed", "refunded", "chargeback"];
const VALID_FUNNELS: Funnel[] = ["past_life", "soulmate", "starseed", "unknown"];
const VALID_SOURCES: TrafficSource[] = ["facebook", "tiktok", "google", "unknown"];

function coerceType(raw: string): TransactionType {
  const v = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  return (VALID_TYPES as string[]).includes(v) ? (v as TransactionType) : "unknown";
}
function coerceStatus(raw: string): TransactionStatus {
  const v = raw.toLowerCase().trim();
  if ((VALID_STATUSES as string[]).includes(v)) return v as TransactionStatus;
  if (v === "ok" || v === "succeeded" || v === "paid") return "success";
  if (v === "refund") return "refunded";
  return "failed";
}
function coerceFunnel(raw: string): Funnel {
  const v = raw.toLowerCase().trim().replace(/[\s-]+/g, "_");
  // Unknown must remain unknown so analytics do not silently attribute rows
  // to a real funnel.
  return (VALID_FUNNELS as string[]).includes(v) ? (v as Funnel) : "unknown";
}
function coerceSource(raw: string): TrafficSource {
  const v = raw.toLowerCase().trim();
  return (VALID_SOURCES as string[]).includes(v) ? (v as TrafficSource) : "unknown";
}
function coerceISO(raw: string): string {
  if (!raw) return new Date().toISOString();
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // Try epoch seconds
  const n = Number(raw);
  if (!Number.isNaN(n) && n > 0) {
    const ms = n < 1e12 ? n * 1000 : n;
    return new Date(ms).toISOString();
  }
  return new Date().toISOString();
}
function coerceAmount(raw: string): number {
  if (raw == null) return 0;
  const cleaned = String(raw).replace(/[^0-9.-]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

export function applyMapping(parsed: ParsedSheet, mapping: ColumnMapping): MapResult {
  // Applies the clean-template mapping and then adds cohort fields so the UI
  // can use one Transaction shape regardless of import mode.
  const errors: MapResult["errors"] = [];
  const rows: Transaction[] = [];

  parsed.rows.forEach((src, i) => {
    const get = (k: keyof Transaction) => {
      const col = mapping[k];
      return col ? (src[col] ?? "") : "";
    };

    const tx: Transaction = {
      transaction_id: get("transaction_id") || `row-${i + 1}`,
      user_id: get("user_id") || `unknown-${i + 1}`,
      email: get("email") || "unknown@example.com",
      event_time: coerceISO(get("event_time")),
      amount_usd: coerceAmount(get("amount_usd")),
      currency: get("currency") || "USD",
      status: coerceStatus(get("status")),
      transaction_type: coerceType(get("transaction_type")),
      funnel: coerceFunnel(get("funnel")),
      product: get("product") || "—",
      traffic_source: coerceSource(get("traffic_source")),
      campaign_id: get("campaign_id") || "",
      classification_reason: get("classification_reason") || "",
    };

    for (const f of TARGET_FIELDS) {
      if (f.required && !mapping[f.key]) {
        errors.push({ row: i + 1, message: `Missing required mapping: ${f.label}` });
      }
    }
    rows.push(tx);
  });

  return { rows: addCohortFields(rows), errors };
}

export function parseCSVText(text: string): ParsedSheet {
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false,
  });
  const headers = result.meta.fields ?? [];
  return { headers, rows: result.data as Record<string, string>[] };
}

export function parseCSVFile(file: File): Promise<ParsedSheet> {
  return new Promise((resolve, reject) => {
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: (result) => {
        const headers = result.meta.fields ?? [];
        resolve({ headers, rows: result.data as Record<string, string>[] });
      },
      error: (err) => reject(err),
    });
  });
}

/**
 * Convert any Google Sheets URL into the public CSV export URL using the gviz
 * endpoint. Works for sheets shared as "Anyone with the link can view".
 */
export function googleSheetCsvUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const idMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  const id = idMatch ? idMatch[1] : trimmed.match(/^[a-zA-Z0-9-_]{20,}$/) ? trimmed : null;
  if (!id) return null;
  const gidMatch = trimmed.match(/[#?&]gid=(\d+)/);
  const gid = gidMatch ? gidMatch[1] : "0";
  return `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

export async function fetchGoogleSheetCsv(url: string): Promise<ParsedSheet> {
  const csvUrl = googleSheetCsvUrl(url);
  if (!csvUrl) throw new Error("Could not parse Google Sheet URL.");
  const res = await fetch(csvUrl);
  if (!res.ok) {
    throw new Error(
      `Could not load sheet (HTTP ${res.status}). Make sure it is shared as "Anyone with the link can view".`
    );
  }
  const text = await res.text();
  return parseCSVText(text);
}
