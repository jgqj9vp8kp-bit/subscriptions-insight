import Papa from "papaparse";
import { read, utils } from "xlsx";
import { supabase } from "@/services/supabaseClient";

export const SUPPORT_CLASSIFICATION_VERSION = "support_rules_v1";

export const SUPPORT_CATEGORIES = [
  "Cancellation",
  "Refund",
  "Unauthorized or unexpected charge",
  "Payment issue",
  "Product/report not received",
  "Product/report question",
  "Technical issue",
  "Subscription question",
  "Duplicate charge",
  "Account/access issue",
  "Complaint",
  "Positive feedback",
  "Spam/unrelated",
  "Other/unclear",
] as const;

export const SUPPORT_URGENCIES = ["low", "medium", "high"] as const;
export type SupportCategory = (typeof SUPPORT_CATEGORIES)[number];
export type SupportUrgency = (typeof SUPPORT_URGENCIES)[number];
export type SupportLanguage = "en" | "es" | "ru" | "unknown";
export type SupportSentiment = "negative" | "neutral" | "positive";

export interface SupportSourceRow {
  source_row_number: number;
  sender_name: string;
  subject: string;
  message_body: string;
  received_date_raw: string;
  customer_email: string;
  matched_contact_name: string;
}

export interface ParsedSupportDate {
  received_at: string | null;
  date_key: string | null;
  assumed_year: number | null;
  warning: string | null;
}

export interface SupportClassification {
  category: SupportCategory;
  subcategory: string;
  language: SupportLanguage;
  sentiment: SupportSentiment;
  urgency: SupportUrgency;
  requires_refund: boolean;
  requires_cancellation: boolean;
  payment_related: boolean;
  delivery_related: boolean;
  possible_unauthorized_charge: boolean;
  duplicate_charge: boolean;
  urgent: boolean;
  classification_source: "rule";
  classification_version: typeof SUPPORT_CLASSIFICATION_VERSION;
  classification_confidence: number;
  classification_reason: string;
}

export interface NormalizedSupportRequestInput extends SupportSourceRow, SupportClassification {
  received_at: string | null;
  normalized_email: string | null;
  matched_customer: boolean;
  source_hash: string;
}

export interface SupportParseDiagnostics {
  total_rows: number;
  valid_rows: number;
  invalid_rows: number;
  invalid_date_rows: number;
  missing_subject_rows: number;
  missing_body_rows: number;
  assumed_year_rows: number;
  detected_headers: string[];
  missing_headers: string[];
  sheet_name: string;
  sheet_names: string[];
  import_year: number;
  warnings: string[];
}

export interface SupportParseResult {
  rows: NormalizedSupportRequestInput[];
  invalidRows: Array<{ source_row_number: number; reason: string; raw: SupportSourceRow }>;
  diagnostics: SupportParseDiagnostics;
  sample: NormalizedSupportRequestInput[];
}

export interface SupportImportSummary {
  batch_id: string | null;
  filename: string;
  import_year: number;
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  skipped_rows: number;
  invalid_rows: number;
  invalid_date_rows: number;
  matched_rows: number;
  unmatched_rows: number;
  date_range: { from: string | null; to: string | null };
  category_distribution: Array<{ category: SupportCategory; count: number }>;
  language_distribution: Array<{ language: SupportLanguage; count: number }>;
  diagnostics: SupportParseDiagnostics;
}

export interface SupportImportOptions {
  importYear: number;
  sheetName?: string;
  filename?: string;
}

export interface SupportAnalyticsFilters {
  dateFrom?: string;
  dateTo?: string;
  category?: SupportCategory | "all";
  subcategory?: string;
  language?: SupportLanguage | "all";
  urgency?: SupportUrgency | "all";
  matchStatus?: "all" | "matched" | "unmatched";
  requiresCancellation?: boolean | "all";
  requiresRefund?: boolean | "all";
  paymentRelated?: boolean | "all";
  deliveryRelated?: boolean | "all";
  manualStatus?: "all" | "manual" | "automatic";
  search?: string;
  importBatchId?: string;
  funnel?: string[];
  campaignPath?: string[];
}

export interface SupportRequestSummaryRow {
  id: string;
  import_batch_id: string | null;
  source_row_number: number;
  sender_name: string | null;
  subject: string | null;
  received_at: string | null;
  received_date_raw: string | null;
  customer_email: string | null;
  normalized_email: string | null;
  matched_contact_name: string | null;
  funnel: string;
  campaign_path: string | null;
  cohort_date: string | null;
  attribution_status: "matched" | "unmatched_email" | "user_without_trial" | "ambiguous";
  category: SupportCategory;
  subcategory: string;
  language: SupportLanguage;
  sentiment: SupportSentiment;
  urgency: SupportUrgency;
  requires_refund: boolean;
  requires_cancellation: boolean;
  payment_related: boolean;
  delivery_related: boolean;
  possible_unauthorized_charge: boolean;
  duplicate_charge: boolean;
  urgent: boolean;
  matched_customer: boolean;
  classification_confidence: number;
  classification_reason: string | null;
  manual_category: SupportCategory | null;
  manual_subcategory: string | null;
  manual_urgency: SupportUrgency | null;
  manual_changed_at: string | null;
  imported_at: string;
}

export interface SupportRequestDetailRow extends SupportRequestSummaryRow {
  message_body: string | null;
}

export interface SupportRequestPage {
  rows: SupportRequestSummaryRow[];
  count: number;
  page: number;
  pageSize: number;
}

export interface SupportImportBatch {
  id: string;
  filename: string;
  checksum: string;
  imported_at: string;
  import_year: number;
  total_rows: number;
  inserted_rows: number;
  updated_rows: number;
  skipped_rows: number;
  invalid_rows: number;
  status: string;
  diagnostics: Record<string, unknown>;
}

export interface SupportDashboardData {
  rows: SupportRequestSummaryRow[];
  kpis: {
    totalRequests: number;
    uniqueSenders: number;
    matchedCustomers: number;
    unmatchedRequests: number;
    cancellationRequests: number;
    refundRequests: number;
    unauthorizedChargeRequests: number;
    productNotReceivedRequests: number;
    paymentIssues: number;
    highPriorityRequests: number;
    requestsPerDay: number;
    matchedPct: number;
    cancellationPct: number;
    refundPct: number;
    paymentRelatedPct: number;
  };
  byDay: Array<{ date: string; requests: number }>;
  categoryTrend: Array<{ date: string; category: SupportCategory; requests: number }>;
  operationalTrend: Array<{ date: string; cancellation: number; refund: number; charge: number }>;
  languageDistribution: Array<{ language: SupportLanguage; requests: number }>;
  matchDistribution: Array<{ status: "matched" | "unmatched"; requests: number }>;
  priorityDistribution: Array<{ urgency: SupportUrgency; requests: number }>;
  categoryRanking: Array<{
    category: SupportCategory;
    requests: number;
    share: number;
    uniqueSenders: number;
    matchedCustomers: number;
    highPriority: number;
    latestRequest: string | null;
    trendVsPrevious: number | null;
  }>;
  subcategoryRanking: Array<{ subcategory: string; requests: number; share: number }>;
  matching: {
    matchedByEmail: number;
    matchedByName: number;
    unmatched: number;
    emailPresentNoMatchedContact: number;
    matchedContactNoEmail: number;
    duplicateNormalizedEmails: number;
    multipleSenderNamesForOneEmail: number;
  };
  insights: string[];
}

const RUSSIAN_MONTHS: Record<string, number> = {
  янв: 1,
  января: 1,
  фев: 2,
  февраля: 2,
  мар: 3,
  марта: 3,
  апр: 4,
  апреля: 4,
  май: 5,
  мая: 5,
  июн: 6,
  июня: 6,
  июл: 7,
  июля: 7,
  авг: 8,
  августа: 8,
  сен: 9,
  сент: 9,
  сентября: 9,
  окт: 10,
  октября: 10,
  ноя: 11,
  ноября: 11,
  дек: 12,
  декабря: 12,
};

const HEADER_MAP: Record<string, keyof Omit<SupportSourceRow, "source_row_number">> = {
  data: "sender_name",
  data2: "subject",
  data3: "message_body",
  data5: "received_date_raw",
  email: "customer_email",
  matched_contact_name: "matched_contact_name",
};

const REQUIRED_HEADERS = ["data", "data2", "data3", "data5"] as const;

function ensureSupabase() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

function str(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeSupportEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

export function normalizeForSupportMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function dayKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function pct(part: number, total: number): number {
  return total ? Math.round((part / total) * 1000) / 10 : 0;
}

function fnv1aHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function parseSupportReceivedDate(raw: string | null | undefined, importYear: number): ParsedSupportDate {
  const value = str(raw);
  if (!value) return { received_at: null, date_key: null, assumed_year: null, warning: "missing_date" };

  const ruMatch = value.toLowerCase().match(/^(\d{1,2})\s+([а-яё.]+)(?:\s+(\d{4}))?$/i);
  if (ruMatch) {
    const day = Number(ruMatch[1]);
    const month = RUSSIAN_MONTHS[ruMatch[2].replace(/\.$/, "")];
    const year = ruMatch[3] ? Number(ruMatch[3]) : importYear;
    if (month && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
        return {
          received_at: date.toISOString(),
          date_key: date.toISOString().slice(0, 10),
          assumed_year: ruMatch[3] ? null : year,
          warning: ruMatch[3] ? null : "year_assumed_from_import_setting",
        };
      }
    }
  }

  const dotMatch = value.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/);
  if (dotMatch) {
    const day = Number(dotMatch[1]);
    const month = Number(dotMatch[2]);
    const rawYear = Number(dotMatch[3]);
    const year = dotMatch[3].length === 2 ? 2000 + rawYear : rawYear;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2100) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) {
        return {
          received_at: date.toISOString(),
          date_key: date.toISOString().slice(0, 10),
          assumed_year: null,
          warning: null,
        };
      }
    }
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return {
      received_at: parsed.toISOString(),
      date_key: parsed.toISOString().slice(0, 10),
      assumed_year: null,
      warning: null,
    };
  }

  return { received_at: null, date_key: null, assumed_year: null, warning: "unparsed_date" };
}

function detectLanguage(text: string): SupportLanguage {
  const normalized = normalizeForSupportMatch(text);
  if (/[а-яё]/i.test(text)) return "ru";
  const spanishSignals = [
    "cancelar", "cancelacion", "suscripcion", "reembolso", "devolucion", "devolver", "dinero",
    "no recibi", "no llego", "cobro", "cargos", "tarjeta", "sin mi permiso", "no autorice",
    "dar de baja", "ayuda", "hola", "buenas", "solicito",
  ];
  if (/[ñ¿¡áéíóúü]/i.test(text) || spanishSignals.some((signal) => normalized.includes(signal))) return "es";
  const englishSignals = ["refund", "cancel", "payment", "charged", "subscription", "receive", "order", "help", "account"];
  if (englishSignals.some((signal) => normalized.includes(signal))) return "en";
  return "unknown";
}

function sentimentFor(text: string): SupportSentiment {
  const normalized = normalizeForSupportMatch(text);
  if (/(thank you|thanks|great|love|gracias|excelente|perfecto)/.test(normalized)) return "positive";
  if (/(robbed|fraud|scam|angry|terrible|bull shit|unauthorized|no autorice|estafa|horrible)/.test(normalized)) return "negative";
  return "neutral";
}

type CategoryRule = {
  category: SupportCategory;
  subcategory: string;
  keywords: string[];
  confidence: number;
};

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "Duplicate charge",
    subcategory: "duplicate_charge",
    confidence: 0.96,
    keywords: ["duplicate charge", "charged twice", "double charged", "repeated charge", "charged again", "cobro doble", "me cobraron dos veces"],
  },
  {
    category: "Unauthorized or unexpected charge",
    subcategory: "unknown_charge",
    confidence: 0.94,
    keywords: ["unauthorized", "without my consent", "did not subscribe", "unknown charge", "fraud", "i was robbed", "no autorice", "no autoricé", "sin mi permiso", "cobros no autorizados", "no me suscribi", "no me suscribí"],
  },
  {
    category: "Refund",
    subcategory: "refund_request",
    confidence: 0.92,
    keywords: ["refund", "money back", "return my money", "reimbursement", "refund status", "reembolso", "devolucion", "devolución", "devolver el dinero", "devuelvan mi dinero"],
  },
  {
    category: "Cancellation",
    subcategory: "cancel_subscription",
    confidence: 0.9,
    keywords: ["cancel", "cancellation", "unsubscribe", "stop subscription", "end subscription", "cancel my plan", "cancel membership", "cancelar", "cancelacion", "cancelación", "dar de baja", "baja la suscripcion", "baja la suscripción"],
  },
  {
    category: "Product/report not received",
    subcategory: "delayed_delivery",
    confidence: 0.88,
    keywords: ["did not receive", "haven't received", "missing order", "not arrived", "when will i receive", "where is my report", "where is my soulmate", "soulmate photo", "soulmate sketch", "no recibi", "no recibí", "no me enviaron", "no llego", "no llegó", "pedido no llego"],
  },
  {
    category: "Payment issue",
    subcategory: "charged_but_order_failed",
    confidence: 0.84,
    keywords: ["payment failed", "card declined", "charged but", "order failed", "payment pending", "declined", "invoice", "billing", "tarjeta rechazada", "pago fallido", "pago pendiente", "me cobraron"],
  },
  {
    category: "Technical issue",
    subcategory: "other_technical",
    confidence: 0.78,
    keywords: ["app not working", "technical issue", "download problem", "broken link", "link not working", "cannot open", "error", "no funciona", "problema tecnico", "problema técnico", "enlace roto"],
  },
  {
    category: "Account/access issue",
    subcategory: "access_problem",
    confidence: 0.76,
    keywords: ["login", "password", "account access", "can't access", "cannot access", "access my account", "contrasena", "contraseña", "acceder", "mi cuenta"],
  },
  {
    category: "Subscription question",
    subcategory: "subscription_question",
    confidence: 0.72,
    keywords: ["subscription", "membership", "renewal", "plan", "suscripcion", "suscripción", "renovacion", "renovación"],
  },
  {
    category: "Product/report question",
    subcategory: "delivery_timing_question",
    confidence: 0.68,
    keywords: ["question", "how does", "what is", "when will", "report", "reading", "soulmate", "pregunta", "cuando", "cuándo", "informe"],
  },
  {
    category: "Positive feedback",
    subcategory: "positive_feedback",
    confidence: 0.66,
    keywords: ["thank you", "thanks", "great", "love it", "gracias", "excelente", "perfecto"],
  },
  {
    category: "Spam/unrelated",
    subcategory: "spam",
    confidence: 0.64,
    keywords: ["seo services", "marketing proposal", "crypto", "loan", "viagra", "guest post", "unsubscribe from newsletter"],
  },
  {
    category: "Complaint",
    subcategory: "general_complaint",
    confidence: 0.62,
    keywords: ["complaint", "angry", "terrible", "bad service", "scam", "queja", "estafa", "horrible"],
  },
];

function hasAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => haystack.includes(normalizeForSupportMatch(keyword)));
}

export function classifySupportRequest(subject: string | null | undefined, body: string | null | undefined): SupportClassification {
  const originalText = `${subject ?? ""}\n${body ?? ""}`;
  const haystack = normalizeForSupportMatch(originalText);
  const language = detectLanguage(originalText);
  const sentiment = sentimentFor(originalText);
  const matchedRule = CATEGORY_RULES.find((rule) => hasAny(haystack, rule.keywords));
  const category = matchedRule?.category ?? "Other/unclear";
  const subcategory = matchedRule?.subcategory ?? "other_unclear";

  const requires_refund = category === "Refund" || hasAny(haystack, ["refund", "money back", "reembolso", "devolucion"]);
  const requires_cancellation = category === "Cancellation" || hasAny(haystack, ["cancel", "unsubscribe", "cancelar", "dar de baja"]);
  const duplicate_charge = category === "Duplicate charge";
  const possible_unauthorized_charge = category === "Unauthorized or unexpected charge";
  const payment_related = possible_unauthorized_charge || duplicate_charge || category === "Payment issue" || requires_refund || hasAny(haystack, ["charge", "charged", "payment", "billing", "card", "cobro", "pago", "tarjeta"]);
  const delivery_related = category === "Product/report not received" || hasAny(haystack, ["did not receive", "missing order", "not arrived", "no recibi", "no llego", "soulmate sketch", "soulmate photo"]);
  const legalThreat = hasAny(haystack, ["chargeback", "dispute", "legal", "lawyer", "police", "denuncia", "demanda"]);
  const urgentRefund = requires_refund && hasAny(haystack, ["urgent", "asap", "immediately", "inmediato", "urgente"]);
  const high = possible_unauthorized_charge || duplicate_charge || legalThreat || urgentRefund || hasAny(haystack, ["continued billing", "charged again", "me siguen cobrando"]);
  const medium = requires_refund || requires_cancellation || delivery_related || category === "Payment issue";
  const urgency: SupportUrgency = high ? "high" : medium ? "medium" : "low";

  return {
    category,
    subcategory,
    language,
    sentiment,
    urgency,
    requires_refund,
    requires_cancellation,
    payment_related,
    delivery_related,
    possible_unauthorized_charge,
    duplicate_charge,
    urgent: urgency === "high",
    classification_source: "rule",
    classification_version: SUPPORT_CLASSIFICATION_VERSION,
    classification_confidence: matchedRule?.confidence ?? 0.25,
    classification_reason: matchedRule ? `Matched ${matchedRule.subcategory} keywords.` : "No deterministic rule matched.",
  };
}

function supportSourceHash(row: SupportSourceRow, parsedDate: ParsedSupportDate): string {
  const key = [
    normalizeForSupportMatch(row.sender_name),
    normalizeForSupportMatch(row.subject),
    normalizeForSupportMatch(row.message_body),
    parsedDate.date_key ?? normalizeForSupportMatch(row.received_date_raw),
    normalizeSupportEmail(row.customer_email),
  ].join("\u001f");
  return fnv1aHash(key);
}

function normalizeHeader(value: unknown): string {
  return str(value).toLowerCase().replace(/\s+/g, "_");
}

function mapRowsFromMatrix(matrix: unknown[][], importYear: number, sheetInfo: { sheetName: string; sheetNames: string[] }): SupportParseResult {
  const header = (matrix[0] ?? []).map(normalizeHeader);
  const missingHeaders = REQUIRED_HEADERS.filter((name) => !header.includes(name));
  const warnings: string[] = [];
  if (missingHeaders.length) warnings.push(`Missing expected headers: ${missingHeaders.join(", ")}`);

  const indexByField = new Map<keyof Omit<SupportSourceRow, "source_row_number">, number>();
  header.forEach((name, index) => {
    const field = HEADER_MAP[name];
    if (field) indexByField.set(field, index);
  });

  const rows: NormalizedSupportRequestInput[] = [];
  const invalidRows: SupportParseResult["invalidRows"] = [];
  let invalidDateRows = 0;
  let missingSubjectRows = 0;
  let missingBodyRows = 0;
  let assumedYearRows = 0;

  matrix.slice(1).forEach((source, offset) => {
    const sourceRow: SupportSourceRow = {
      source_row_number: offset + 2,
      sender_name: str(source[indexByField.get("sender_name") ?? -1]),
      subject: str(source[indexByField.get("subject") ?? -1]),
      message_body: str(source[indexByField.get("message_body") ?? -1]),
      received_date_raw: str(source[indexByField.get("received_date_raw") ?? -1]),
      customer_email: str(source[indexByField.get("customer_email") ?? -1]),
      matched_contact_name: str(source[indexByField.get("matched_contact_name") ?? -1]),
    };
    if (!Object.values(sourceRow).some(Boolean)) return;
    if (!sourceRow.subject) missingSubjectRows += 1;
    if (!sourceRow.message_body) missingBodyRows += 1;

    const parsedDate = parseSupportReceivedDate(sourceRow.received_date_raw, importYear);
    if (!parsedDate.received_at) {
      invalidDateRows += 1;
      invalidRows.push({ source_row_number: sourceRow.source_row_number, reason: parsedDate.warning ?? "invalid_date", raw: sourceRow });
      return;
    }
    if (parsedDate.assumed_year) assumedYearRows += 1;

    const classification: SupportClassification = {
      category: "Other/unclear",
      subcategory: "pending_server_classification",
      language: "unknown",
      sentiment: "neutral",
      urgency: "low",
      requires_refund: false,
      requires_cancellation: false,
      payment_related: false,
      delivery_related: false,
      possible_unauthorized_charge: false,
      duplicate_charge: false,
      urgent: false,
      classification_source: "rule",
      classification_version: SUPPORT_CLASSIFICATION_VERSION,
      classification_confidence: 0,
      classification_reason: "Pending server-side ClickHouse classification.",
    };
    const normalized_email = normalizeSupportEmail(sourceRow.customer_email) || null;
    rows.push({
      ...sourceRow,
      ...classification,
      received_at: parsedDate.received_at,
      normalized_email,
      matched_customer: Boolean(normalized_email || sourceRow.matched_contact_name),
      source_hash: supportSourceHash(sourceRow, parsedDate),
    });
  });

  const diagnostics: SupportParseDiagnostics = {
    total_rows: matrix.length ? matrix.length - 1 : 0,
    valid_rows: rows.length,
    invalid_rows: invalidRows.length,
    invalid_date_rows: invalidDateRows,
    missing_subject_rows: missingSubjectRows,
    missing_body_rows: missingBodyRows,
    assumed_year_rows: assumedYearRows,
    detected_headers: header.filter(Boolean),
    missing_headers: [...missingHeaders],
    sheet_name: sheetInfo.sheetName,
    sheet_names: sheetInfo.sheetNames,
    import_year: importYear,
    warnings,
  };

  return { rows, invalidRows, diagnostics, sample: rows.slice(0, 5) };
}

export function parseSupportCsvText(csvText: string, options: SupportImportOptions): SupportParseResult {
  const parsed = Papa.parse<unknown[]>(csvText, { skipEmptyLines: true });
  if (parsed.errors.length) {
    throw new Error(`Could not parse CSV: ${parsed.errors[0]?.message ?? "Unknown CSV error"}`);
  }
  return mapRowsFromMatrix(parsed.data as unknown[][], options.importYear, {
    sheetName: "CSV",
    sheetNames: ["CSV"],
  });
}

export function parseSupportWorkbookArrayBuffer(
  buffer: ArrayBuffer,
  options: SupportImportOptions,
): SupportParseResult {
  const workbook = read(buffer, { type: "array", raw: false, cellDates: false, dense: false });
  const sheetNames = workbook.SheetNames ?? [];
  if (!sheetNames.length) throw new Error("Workbook has no worksheets.");
  const preferred = options.sheetName && sheetNames.includes(options.sheetName)
    ? options.sheetName
    : sheetNames.includes("Unified data")
      ? "Unified data"
      : sheetNames[0];
  const sheet = workbook.Sheets[preferred];
  const matrix = utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: "" }) as unknown[][];
  return mapRowsFromMatrix(matrix, options.importYear, { sheetName: preferred, sheetNames });
}

export async function parseSupportFile(file: File, options: SupportImportOptions): Promise<SupportParseResult> {
  const filename = options.filename ?? file.name;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "csv") {
    return parseSupportCsvText(await file.text(), options);
  }
  if (ext === "xlsx" || ext === "xlsm") {
    return parseSupportWorkbookArrayBuffer(await file.arrayBuffer(), options);
  }
  throw new Error("Unsupported file type. Upload .xlsm, .xlsx, or .csv.");
}

function checksumForRows(rows: NormalizedSupportRequestInput[], filename: string): string {
  return fnv1aHash(`${filename}\n${rows.map((row) => row.source_hash).sort().join("\n")}`);
}

function distribution<T extends string>(rows: NormalizedSupportRequestInput[], pick: (row: NormalizedSupportRequestInput) => T): Array<{ label: T; count: number }> {
  const counts = new Map<T, number>();
  rows.forEach((row) => counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1));
  return Array.from(counts.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function summarizeParsedSupportImport(parse: SupportParseResult, filename = "support import"): SupportImportSummary {
  const dates = parse.rows.map((row) => row.received_at).filter((value): value is string => Boolean(value)).sort();
  return {
    batch_id: null,
    filename,
    import_year: parse.diagnostics.import_year,
    total_rows: parse.diagnostics.total_rows,
    inserted_rows: parse.rows.length,
    updated_rows: 0,
    skipped_rows: 0,
    invalid_rows: parse.invalidRows.length,
    invalid_date_rows: parse.diagnostics.invalid_date_rows,
    matched_rows: parse.rows.filter((row) => row.matched_customer).length,
    unmatched_rows: parse.rows.filter((row) => !row.matched_customer).length,
    date_range: { from: dates[0] ? dates[0].slice(0, 10) : null, to: dates.at(-1)?.slice(0, 10) ?? null },
    category_distribution: distribution(parse.rows, (row) => row.category).map((row) => ({ category: row.label, count: row.count })),
    language_distribution: distribution(parse.rows, (row) => row.language).map((row) => ({ language: row.label, count: row.count })),
    diagnostics: parse.diagnostics,
  };
}

async function currentUserId(): Promise<string> {
  const client = ensureSupabase();
  const { data, error } = await client.auth.getUser();
  if (error || !data.user?.id) throw new Error("Sign in before importing support requests.");
  return data.user.id;
}

export async function importSupportFile(file: File, options: SupportImportOptions): Promise<SupportImportSummary> {
  const filename = options.filename ?? file.name;
  const parse = await parseSupportFile(file, { ...options, filename });
  const userId = await currentUserId();
  const client = ensureSupabase();
  const checksum = checksumForRows(parse.rows, filename);

  const { data: batch, error: batchError } = await client
    .from("support_import_batches")
    .insert({
      auth_user_id: userId,
      filename,
      checksum,
      import_year: options.importYear,
      total_rows: parse.diagnostics.total_rows,
      invalid_rows: parse.invalidRows.length,
      status: "pending",
      diagnostics: parse.diagnostics,
    })
    .select("id")
    .single();
  if (batchError) throw new Error(`Could not create support import batch: ${batchError.message}`);

  const hashes = parse.rows.map((row) => row.source_hash);
  const existing = new Set<string>();
  for (let i = 0; i < hashes.length; i += 500) {
    const chunk = hashes.slice(i, i + 500);
    const { data, error } = await client
      .from("support_requests")
      .select("source_hash")
      .eq("auth_user_id", userId)
      .in("source_hash", chunk);
    if (error) throw new Error(`Could not check duplicate support requests: ${error.message}`);
    (data ?? []).forEach((row) => existing.add(String(row.source_hash)));
  }

  const seenInFile = new Set<string>();
  let duplicateRowsInFile = 0;
  const insertRows = parse.rows.flatMap((row) => {
    if (seenInFile.has(row.source_hash)) {
      duplicateRowsInFile += 1;
      return [];
    }
    seenInFile.add(row.source_hash);
    if (existing.has(row.source_hash)) return [];
    return [{
      ...row,
      auth_user_id: userId,
      import_batch_id: batch.id,
    }];
  });

  for (let i = 0; i < insertRows.length; i += 500) {
    const { error } = await client.from("support_requests").insert(insertRows.slice(i, i + 500));
    if (error) throw new Error(`Could not insert support requests: ${error.message}`);
  }

  const skipped = parse.rows.length - insertRows.length;
  const status = parse.invalidRows.length ? "completed_with_warnings" : "completed";
  const { error: updateError } = await client
    .from("support_import_batches")
    .update({
      inserted_rows: insertRows.length,
      updated_rows: 0,
      skipped_rows: skipped,
      invalid_rows: parse.invalidRows.length,
      status,
      diagnostics: {
        ...parse.diagnostics,
        duplicate_rows: skipped,
        duplicate_rows_in_file: duplicateRowsInFile,
        duplicate_rows_existing: skipped - duplicateRowsInFile,
      },
    })
    .eq("id", batch.id);
  if (updateError) throw new Error(`Could not update support import batch: ${updateError.message}`);

  return {
    ...summarizeParsedSupportImport(parse, filename),
    batch_id: batch.id,
    inserted_rows: insertRows.length,
    skipped_rows: skipped,
  };
}

const SUMMARY_SELECT = [
  "id",
  "import_batch_id",
  "source_row_number",
  "sender_name",
  "subject",
  "received_at",
  "received_date_raw",
  "customer_email",
  "normalized_email",
  "matched_contact_name",
  "category",
  "subcategory",
  "language",
  "sentiment",
  "urgency",
  "requires_refund",
  "requires_cancellation",
  "payment_related",
  "delivery_related",
  "possible_unauthorized_charge",
  "duplicate_charge",
  "urgent",
  "matched_customer",
  "classification_confidence",
  "classification_reason",
  "manual_category",
  "manual_subcategory",
  "manual_urgency",
  "manual_changed_at",
  "imported_at",
].join(",");

export const SUPPORT_REQUEST_SUMMARY_SELECT = SUMMARY_SELECT;

function effectiveCategory(row: SupportRequestSummaryRow): SupportCategory {
  return (row.manual_category ?? row.category) as SupportCategory;
}

function effectiveSubcategory(row: SupportRequestSummaryRow): string {
  return row.manual_subcategory ?? row.subcategory;
}

function effectiveUrgency(row: SupportRequestSummaryRow): SupportUrgency {
  return (row.manual_urgency ?? row.urgency) as SupportUrgency;
}

function applySupportFilters<T>(query: T, filters: SupportAnalyticsFilters): T {
  let next = query as unknown as {
    gte: (column: string, value: string) => typeof next;
    lte: (column: string, value: string) => typeof next;
    eq: (column: string, value: unknown) => typeof next;
    is: (column: string, value: null) => typeof next;
    not: (column: string, operator: string, value: unknown) => typeof next;
    or: (filters: string) => typeof next;
  };
  if (filters.dateFrom) next = next.gte("received_at", `${filters.dateFrom}T00:00:00.000Z`);
  if (filters.dateTo) next = next.lte("received_at", `${filters.dateTo}T23:59:59.999Z`);
  if (filters.category && filters.category !== "all") next = next.eq("category", filters.category);
  if (filters.subcategory) next = next.eq("subcategory", filters.subcategory);
  if (filters.language && filters.language !== "all") next = next.eq("language", filters.language);
  if (filters.urgency && filters.urgency !== "all") next = next.eq("urgency", filters.urgency);
  if (filters.matchStatus === "matched") next = next.eq("matched_customer", true);
  if (filters.matchStatus === "unmatched") next = next.eq("matched_customer", false);
  if (filters.requiresCancellation !== undefined && filters.requiresCancellation !== "all") next = next.eq("requires_cancellation", filters.requiresCancellation);
  if (filters.requiresRefund !== undefined && filters.requiresRefund !== "all") next = next.eq("requires_refund", filters.requiresRefund);
  if (filters.paymentRelated !== undefined && filters.paymentRelated !== "all") next = next.eq("payment_related", filters.paymentRelated);
  if (filters.deliveryRelated !== undefined && filters.deliveryRelated !== "all") next = next.eq("delivery_related", filters.deliveryRelated);
  if (filters.importBatchId) next = next.eq("import_batch_id", filters.importBatchId);
  if (filters.manualStatus === "manual") next = next.not("manual_category", "is", null);
  if (filters.manualStatus === "automatic") next = next.is("manual_category", null);
  const search = String(filters.search ?? "").replace(/[,%()]/g, " ").trim();
  if (search) {
    const escaped = search.replace(/[%_]/g, "\\$&");
    const pattern = `%${escaped}%`;
    next = next.or(`sender_name.ilike.${pattern},customer_email.ilike.${pattern},subject.ilike.${pattern},message_body.ilike.${pattern}`);
  }
  return next as unknown as T;
}

export async function listSupportImportBatches(): Promise<SupportImportBatch[]> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("support_import_batches")
    .select("*")
    .order("imported_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(`Could not load support import batches: ${error.message}`);
  return (data ?? []) as SupportImportBatch[];
}

export async function listSupportRequestPage(params: {
  filters: SupportAnalyticsFilters;
  page?: number;
  pageSize?: number;
  sortBy?: "received_at" | "category" | "urgency";
  sortDir?: "asc" | "desc";
}): Promise<SupportRequestPage> {
  const client = ensureSupabase();
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, params.pageSize ?? 50));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const sortBy = params.sortBy ?? "received_at";
  const sortDir = params.sortDir ?? "desc";
  let query = client
    .from("support_requests")
    .select(SUMMARY_SELECT, { count: "exact" });
  query = applySupportFilters(query, params.filters);
  const { data, error, count } = await query
    .order(sortBy, { ascending: sortDir === "asc", nullsFirst: false })
    .range(from, to);
  if (error) throw new Error(`Could not load support requests: ${error.message}`);
  return { rows: (data ?? []) as SupportRequestSummaryRow[], count: count ?? 0, page, pageSize };
}

export async function getSupportRequestDetails(id: string): Promise<SupportRequestDetailRow> {
  const client = ensureSupabase();
  const { data, error } = await client
    .from("support_requests")
    .select(`${SUMMARY_SELECT},message_body`)
    .eq("id", id)
    .single();
  if (error) throw new Error(`Could not load support request details: ${error.message}`);
  return data as SupportRequestDetailRow;
}

export async function listSupportDashboardRows(filters: SupportAnalyticsFilters): Promise<SupportRequestSummaryRow[]> {
  const client = ensureSupabase();
  const rows: SupportRequestSummaryRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = client
      .from("support_requests")
      .select(SUMMARY_SELECT)
      .order("received_at", { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1);
    query = applySupportFilters(query, filters);
    const { data, error } = await query;
    if (error) throw new Error(`Could not load support analytics: ${error.message}`);
    const pageRows = (data ?? []) as SupportRequestSummaryRow[];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) break;
  }
  return rows;
}

export async function updateSupportRequestManualClassification(
  id: string,
  input: { category: SupportCategory; subcategory: string; urgency: SupportUrgency },
): Promise<void> {
  const userId = await currentUserId();
  const client = ensureSupabase();
  const { error } = await client
    .from("support_requests")
    .update({
      manual_category: input.category,
      manual_subcategory: input.subcategory,
      manual_urgency: input.urgency,
      manual_changed_at: new Date().toISOString(),
      manual_changed_by: userId,
    })
    .eq("id", id);
  if (error) throw new Error(`Could not update support classification: ${error.message}`);
}

export async function resetSupportRequestManualClassification(id: string): Promise<void> {
  const client = ensureSupabase();
  const { error } = await client
    .from("support_requests")
    .update({
      manual_category: null,
      manual_subcategory: null,
      manual_urgency: null,
      manual_changed_at: null,
      manual_changed_by: null,
    })
    .eq("id", id);
  if (error) throw new Error(`Could not reset support classification: ${error.message}`);
}

function countByMap<T extends string>(rows: SupportRequestSummaryRow[], pick: (row: SupportRequestSummaryRow) => T): Map<T, number> {
  const counts = new Map<T, number>();
  rows.forEach((row) => counts.set(pick(row), (counts.get(pick(row)) ?? 0) + 1));
  return counts;
}

function topLabel<T extends string>(counts: Map<T, number>): T | null {
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

export function buildSupportDashboard(rows: SupportRequestSummaryRow[], selectedCategory: SupportCategory | "all" = "all"): SupportDashboardData {
  const total = rows.length;
  const senderKeys = new Set(rows.map((row) => row.normalized_email || normalizeForSupportMatch(row.sender_name ?? "")).filter(Boolean));
  const matchedCustomers = rows.filter((row) => row.matched_customer).length;
  const cancellation = rows.filter((row) => effectiveCategory(row) === "Cancellation" || row.requires_cancellation).length;
  const refund = rows.filter((row) => effectiveCategory(row) === "Refund" || row.requires_refund).length;
  const unauthorized = rows.filter((row) => effectiveCategory(row) === "Unauthorized or unexpected charge" || row.possible_unauthorized_charge).length;
  const missingProduct = rows.filter((row) => effectiveCategory(row) === "Product/report not received").length;
  const paymentIssues = rows.filter((row) => effectiveCategory(row) === "Payment issue").length;
  const high = rows.filter((row) => effectiveUrgency(row) === "high").length;
  const dates = Array.from(new Set(rows.map((row) => dayKey(row.received_at)).filter((value): value is string => Boolean(value)))).sort();
  const daySpan = dates.length || 1;

  const dayCounts = countByMap(rows, (row) => dayKey(row.received_at) ?? "Unknown");
  const byDay = Array.from(dayCounts.entries())
    .map(([date, requests]) => ({ date, requests }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const categoryTrendMap = new Map<string, { date: string; category: SupportCategory; requests: number }>();
  const operationalTrendMap = new Map<string, { date: string; cancellation: number; refund: number; charge: number }>();
  rows.forEach((row) => {
    const date = dayKey(row.received_at) ?? "Unknown";
    const category = effectiveCategory(row);
    const key = `${date}|${category}`;
    const current = categoryTrendMap.get(key) ?? { date, category, requests: 0 };
    current.requests += 1;
    categoryTrendMap.set(key, current);
    const op = operationalTrendMap.get(date) ?? { date, cancellation: 0, refund: 0, charge: 0 };
    if (category === "Cancellation" || row.requires_cancellation) op.cancellation += 1;
    if (category === "Refund" || row.requires_refund) op.refund += 1;
    if (category === "Unauthorized or unexpected charge" || row.possible_unauthorized_charge || row.duplicate_charge) op.charge += 1;
    operationalTrendMap.set(date, op);
  });

  const categoryCounts = countByMap(rows, effectiveCategory);
  const languageCounts = countByMap(rows, (row) => row.language);
  const urgencyCounts = countByMap(rows, effectiveUrgency);
  const subcategorySource = selectedCategory === "all" ? rows : rows.filter((row) => effectiveCategory(row) === selectedCategory);
  const subcategoryCounts = countByMap(subcategorySource, effectiveSubcategory);

  const midpoint = dates[Math.floor(dates.length / 2)] ?? null;
  const previousRows = midpoint ? rows.filter((row) => (dayKey(row.received_at) ?? "") < midpoint) : [];
  const currentRows = midpoint ? rows.filter((row) => (dayKey(row.received_at) ?? "") >= midpoint) : rows;

  const categoryRanking = Array.from(categoryCounts.entries()).map(([category, requests]) => {
    const categoryRows = rows.filter((row) => effectiveCategory(row) === category);
    const prev = previousRows.filter((row) => effectiveCategory(row) === category).length;
    const curr = currentRows.filter((row) => effectiveCategory(row) === category).length;
    return {
      category,
      requests,
      share: pct(requests, total),
      uniqueSenders: new Set(categoryRows.map((row) => row.normalized_email || row.sender_name || row.id)).size,
      matchedCustomers: categoryRows.filter((row) => row.matched_customer).length,
      highPriority: categoryRows.filter((row) => effectiveUrgency(row) === "high").length,
      latestRequest: categoryRows.map((row) => row.received_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
      trendVsPrevious: prev ? Math.round(((curr - prev) / prev) * 1000) / 10 : curr > 0 ? null : 0,
    };
  }).sort((a, b) => b.requests - a.requests || a.category.localeCompare(b.category));

  const byEmail = new Map<string, Set<string>>();
  rows.forEach((row) => {
    if (!row.normalized_email) return;
    const names = byEmail.get(row.normalized_email) ?? new Set<string>();
    if (row.sender_name) names.add(normalizeForSupportMatch(row.sender_name));
    byEmail.set(row.normalized_email, names);
  });

  const topCategory = topLabel(categoryCounts);
  const topLanguage = topLabel(languageCounts);
  const busiestDay = byDay.slice().sort((a, b) => b.requests - a.requests)[0];
  const insights = [
    topCategory ? `Most common reason: ${topCategory} (${categoryCounts.get(topCategory)} requests).` : "No support requests in the selected range.",
    `Cancellation share: ${pct(cancellation, total)}%.`,
    `Refund share: ${pct(refund, total)}%.`,
    `Unexpected-charge share: ${pct(unauthorized, total)}%.`,
    topLanguage ? `Most common language: ${topLanguage}.` : "Language distribution is unavailable.",
    `Match rate: ${pct(matchedCustomers, total)}%.`,
    busiestDay ? `Highest-volume day: ${busiestDay.date} (${busiestDay.requests} requests).` : "No daily trend available.",
  ];

  return {
    rows,
    kpis: {
      totalRequests: total,
      uniqueSenders: senderKeys.size,
      matchedCustomers,
      unmatchedRequests: total - matchedCustomers,
      cancellationRequests: cancellation,
      refundRequests: refund,
      unauthorizedChargeRequests: unauthorized,
      productNotReceivedRequests: missingProduct,
      paymentIssues,
      highPriorityRequests: high,
      requestsPerDay: Math.round((total / daySpan) * 10) / 10,
      matchedPct: pct(matchedCustomers, total),
      cancellationPct: pct(cancellation, total),
      refundPct: pct(refund, total),
      paymentRelatedPct: pct(rows.filter((row) => row.payment_related).length, total),
    },
    byDay,
    categoryTrend: Array.from(categoryTrendMap.values()).sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category)),
    operationalTrend: Array.from(operationalTrendMap.values()).sort((a, b) => a.date.localeCompare(b.date)),
    languageDistribution: Array.from(languageCounts.entries()).map(([language, requests]) => ({ language, requests })).sort((a, b) => b.requests - a.requests),
    matchDistribution: [
      { status: "matched", requests: matchedCustomers },
      { status: "unmatched", requests: total - matchedCustomers },
    ],
    priorityDistribution: SUPPORT_URGENCIES.map((urgency) => ({ urgency, requests: urgencyCounts.get(urgency) ?? 0 })),
    categoryRanking,
    subcategoryRanking: Array.from(subcategoryCounts.entries())
      .map(([subcategory, requests]) => ({ subcategory, requests, share: pct(requests, subcategorySource.length) }))
      .sort((a, b) => b.requests - a.requests || a.subcategory.localeCompare(b.subcategory)),
    matching: {
      matchedByEmail: rows.filter((row) => Boolean(row.normalized_email)).length,
      matchedByName: rows.filter((row) => !row.normalized_email && Boolean(row.matched_contact_name)).length,
      unmatched: rows.filter((row) => !row.matched_customer).length,
      emailPresentNoMatchedContact: rows.filter((row) => Boolean(row.normalized_email) && !row.matched_contact_name).length,
      matchedContactNoEmail: rows.filter((row) => !row.normalized_email && Boolean(row.matched_contact_name)).length,
      duplicateNormalizedEmails: Array.from(byEmail.keys()).filter((email) => rows.filter((row) => row.normalized_email === email).length > 1).length,
      multipleSenderNamesForOneEmail: Array.from(byEmail.values()).filter((names) => names.size > 1).length,
    },
    insights,
  };
}
