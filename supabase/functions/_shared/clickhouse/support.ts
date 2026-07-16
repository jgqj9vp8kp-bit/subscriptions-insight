import type { ClickHouseClientLike, SupabaseLikeClient } from "./types.ts";
import {
  ANALYTICS_TRANSACTIONS_TABLE,
  FACT_SUPPORT_REQUESTS_TABLE,
  FACT_USER_COHORTS_TABLE,
  ensureFactSupportRequestsSchema,
} from "./schema.ts";
import { activeCohortSnapshotVersion, getCohortSnapshotState } from "./cohortMembership.ts";
import {
  EMPTY_CAMPAIGN_PATH,
  type SupportAnalyticsBundle,
  type SupportDetailsResponse,
  type SupportFilterOptions,
  type SupportFilters,
  type SupportListResponse,
  type SupportOptionsResponse,
  type SupportRequest,
  type SupportRequestDetailRow,
  type SupportRequestRow,
  type SupportSyncResult,
  type SupportTriState,
} from "./supportContract.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;
const MAX_IN_VALUES = 500;
const SYNC_NAME = "fact_support_requests_sync";
const DEFAULT_SYNC_BATCH_SIZE = 2000;
const DEFAULT_SYNC_MAX_BATCHES = 10;
const DEFAULT_SYNC_TIMEOUT_MS = 45_000;
const SUPPORT_CLASSIFICATION_VERSION = "support_rules_v1_server";
const UNKNOWN_FUNNEL = "Unknown";

const SUPPORT_SELECT = [
  "id,auth_user_id,import_batch_id,source_row_number,sender_name,subject,message_body,received_at,received_date_raw",
  "customer_email,normalized_email,matched_contact_name,manual_category,manual_subcategory,manual_urgency,manual_changed_at",
  "source_hash,imported_at,updated_at",
].join(",");

type SupportAction = "bundle" | "list" | "details" | "options" | "sync" | "status";
type SortDirection = "asc" | "desc";

type NormalizedRequest = {
  action: SupportAction;
  dateFrom: string | null;
  dateTo: string | null;
  filters: SupportFilters;
  sortField: string;
  sortDir: SortDirection;
  page: number;
  pageSize: number;
  requestId: string | null;
};

type SupabaseSupportRow = {
  id: string;
  auth_user_id: string;
  import_batch_id: string | null;
  source_row_number: number | null;
  sender_name: string | null;
  subject: string | null;
  message_body: string | null;
  received_at: string | null;
  received_date_raw: string | null;
  customer_email: string | null;
  normalized_email: string | null;
  matched_contact_name: string | null;
  manual_category: string | null;
  manual_subcategory: string | null;
  manual_urgency: string | null;
  manual_changed_at: string | null;
  source_hash: string;
  imported_at: string | null;
  updated_at: string | null;
};

type Classification = {
  category: string;
  subcategory: string;
  language: string;
  sentiment: string;
  urgency: string;
  requires_refund: boolean;
  requires_cancellation: boolean;
  payment_related: boolean;
  delivery_related: boolean;
  possible_unauthorized_charge: boolean;
  duplicate_charge: boolean;
  urgent: boolean;
  classification_confidence: number;
  classification_reason: string;
};

export class SupportRequestError extends Error {}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pct(part: number, total: number): number {
  return total ? round1((part / total) * 100) : 0;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasAny(haystack: string, keywords: string[]): boolean {
  return keywords.some((keyword) => haystack.includes(normalizeForMatch(keyword)));
}

function detectLanguage(text: string): string {
  const normalized = normalizeForMatch(text);
  if (/[а-яё]/i.test(text)) return "ru";
  const spanish = [
    "cancelar", "cancelacion", "suscripcion", "reembolso", "devolucion", "devolver", "dinero",
    "no recibi", "no llego", "cobro", "tarjeta", "sin mi permiso", "no autorice", "dar de baja",
  ];
  if (/[ñ¿¡áéíóúü]/i.test(text) || spanish.some((signal) => normalized.includes(signal))) return "es";
  const english = ["refund", "cancel", "payment", "charged", "subscription", "receive", "order", "help", "account"];
  return english.some((signal) => normalized.includes(signal)) ? "en" : "unknown";
}

function sentimentFor(text: string): string {
  const normalized = normalizeForMatch(text);
  if (/(thank you|thanks|great|love|gracias|excelente|perfecto)/.test(normalized)) return "positive";
  if (/(robbed|fraud|scam|angry|terrible|unauthorized|no autorice|estafa|horrible)/.test(normalized)) return "negative";
  return "neutral";
}

const CATEGORY_RULES = [
  { category: "Duplicate charge", subcategory: "duplicate_charge", confidence: 0.96, keywords: ["duplicate charge", "charged twice", "double charged", "cobro doble", "me cobraron dos veces"] },
  { category: "Unauthorized or unexpected charge", subcategory: "unknown_charge", confidence: 0.94, keywords: ["unauthorized", "without my consent", "did not subscribe", "unknown charge", "fraud", "no autorice", "no autoricé", "sin mi permiso", "cobros no autorizados"] },
  { category: "Refund", subcategory: "refund_request", confidence: 0.92, keywords: ["refund", "money back", "return my money", "reimbursement", "reembolso", "devolucion", "devolución", "devolver el dinero"] },
  { category: "Cancellation", subcategory: "cancel_subscription", confidence: 0.9, keywords: ["cancel", "cancellation", "unsubscribe", "stop subscription", "cancel membership", "cancelar", "cancelacion", "cancelación", "dar de baja"] },
  { category: "Product/report not received", subcategory: "delayed_delivery", confidence: 0.88, keywords: ["did not receive", "haven't received", "missing order", "not arrived", "where is my report", "soulmate photo", "soulmate sketch", "no recibi", "no recibí", "no me enviaron", "no llego", "no llegó"] },
  { category: "Payment issue", subcategory: "charged_but_order_failed", confidence: 0.84, keywords: ["payment failed", "card declined", "charged but", "order failed", "payment pending", "declined", "invoice", "billing", "tarjeta rechazada", "pago fallido", "me cobraron"] },
  { category: "Technical issue", subcategory: "other_technical", confidence: 0.78, keywords: ["app not working", "technical issue", "download problem", "broken link", "link not working", "cannot open", "error", "no funciona", "problema tecnico", "problema técnico"] },
  { category: "Account/access issue", subcategory: "access_problem", confidence: 0.76, keywords: ["login", "password", "account access", "can't access", "cannot access", "contrasena", "contraseña", "acceder", "mi cuenta"] },
  { category: "Subscription question", subcategory: "subscription_question", confidence: 0.72, keywords: ["subscription", "membership", "renewal", "plan", "suscripcion", "suscripción", "renovacion", "renovación"] },
  { category: "Product/report question", subcategory: "delivery_timing_question", confidence: 0.68, keywords: ["question", "how does", "what is", "when will", "report", "reading", "soulmate", "pregunta", "cuando", "cuándo", "informe"] },
  { category: "Positive feedback", subcategory: "positive_feedback", confidence: 0.66, keywords: ["thank you", "thanks", "great", "love it", "gracias", "excelente", "perfecto"] },
  { category: "Spam/unrelated", subcategory: "spam", confidence: 0.64, keywords: ["seo services", "marketing proposal", "crypto", "loan", "viagra", "guest post"] },
  { category: "Complaint", subcategory: "general_complaint", confidence: 0.62, keywords: ["complaint", "angry", "terrible", "bad service", "scam", "queja", "estafa", "horrible"] },
];

export function classifySupportRequestServer(subject: string, body: string): Classification {
  const text = `${subject}\n${body}`;
  const haystack = normalizeForMatch(text);
  const rule = CATEGORY_RULES.find((candidate) => hasAny(haystack, candidate.keywords));
  const category = rule?.category ?? "Other/unclear";
  const subcategory = rule?.subcategory ?? "other_unclear";
  const requires_refund = category === "Refund" || hasAny(haystack, ["refund", "money back", "reembolso", "devolucion"]);
  const requires_cancellation = category === "Cancellation" || hasAny(haystack, ["cancel", "unsubscribe", "cancelar", "dar de baja"]);
  const duplicate_charge = category === "Duplicate charge";
  const possible_unauthorized_charge = category === "Unauthorized or unexpected charge";
  const payment_related = possible_unauthorized_charge || duplicate_charge || category === "Payment issue" || requires_refund || hasAny(haystack, ["charge", "charged", "payment", "billing", "card", "cobro", "pago", "tarjeta"]);
  const delivery_related = category === "Product/report not received" || hasAny(haystack, ["did not receive", "missing order", "not arrived", "no recibi", "no llego", "soulmate sketch", "soulmate photo"]);
  const high = possible_unauthorized_charge || duplicate_charge || hasAny(haystack, ["chargeback", "dispute", "legal", "lawyer", "police", "denuncia", "demanda", "charged again"]);
  const medium = requires_refund || requires_cancellation || delivery_related || category === "Payment issue";
  const urgency = high ? "high" : medium ? "medium" : "low";
  return {
    category,
    subcategory,
    language: detectLanguage(text),
    sentiment: sentimentFor(text),
    urgency,
    requires_refund,
    requires_cancellation,
    payment_related,
    delivery_related,
    possible_unauthorized_charge,
    duplicate_charge,
    urgent: urgency === "high",
    classification_confidence: rule?.confidence ?? 0.25,
    classification_reason: rule ? `Matched ${rule.subcategory} keywords.` : "No deterministic server rule matched.",
  };
}

function normalizeAction(action: unknown): SupportAction {
  switch (action) {
    case "list":
    case "details":
    case "options":
    case "sync":
    case "status":
    case "bundle": return action;
    case undefined:
    case null: return "bundle";
    default: throw new SupportRequestError(`Unsupported support action: ${s(action)}`);
  }
}

function date(value: unknown, field: string): string | null {
  if (value == null || value === "") return null;
  const raw = s(value).trim();
  if (!DATE_RE.test(raw)) throw new SupportRequestError(`Invalid ${field} (expected YYYY-MM-DD): ${raw}`);
  return raw;
}

function tri(value: unknown): SupportTriState {
  return value === "yes" || value === "no" ? value : "all";
}

function arr(value: unknown, field: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new SupportRequestError(`Filter ${field} must be an array.`);
  const out = Array.from(new Set(value.map((v) => s(v).trim()).filter(Boolean)));
  if (out.length > MAX_IN_VALUES) throw new SupportRequestError(`Filter ${field} too large (max ${MAX_IN_VALUES}).`);
  return out;
}

const SORT_ALLOWLIST: Record<string, string> = {
  received_at: "received_at",
  funnel: "funnel",
  campaign_path: "campaign_path",
  category: "category",
  urgency: "urgency",
  language: "language",
  matched_customer: "matched_customer",
};

export function normalizeSupportRequest(req: SupportRequest): NormalizedRequest {
  const f = req.filters ?? {};
  const sortKey = s(req.sort?.field || "received_at");
  const sortField = SORT_ALLOWLIST[sortKey];
  if (!sortField) throw new SupportRequestError(`Unsupported support sort field: ${sortKey}`);
  const page = Math.max(1, Math.floor(n(req.pagination?.page) || 1));
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(n(req.pagination?.page_size) || DEFAULT_PAGE_SIZE)));
  return {
    action: normalizeAction(req.action),
    dateFrom: date(req.date_from, "date_from"),
    dateTo: date(req.date_to, "date_to"),
    filters: {
      funnel: arr(f.funnel, "funnel"),
      campaign_path: arr(f.campaign_path, "campaign_path"),
      category: arr(f.category, "category"),
      subcategory: arr(f.subcategory, "subcategory"),
      language: arr(f.language, "language"),
      urgency: arr(f.urgency, "urgency"),
      matched: tri(f.matched),
      requires_cancellation: tri(f.requires_cancellation),
      requires_refund: tri(f.requires_refund),
      payment_related: tri(f.payment_related),
      delivery_related: tri(f.delivery_related),
      manual_status: f.manual_status === "manual" || f.manual_status === "automatic" ? f.manual_status : "all",
      import_batch_id: arr(f.import_batch_id, "import_batch_id"),
      search: s(f.search).trim().slice(0, 300),
    },
    sortField,
    sortDir: req.sort?.direction === "asc" ? "asc" : "desc",
    page,
    pageSize,
    requestId: req.request_id ? s(req.request_id) : null,
  };
}

async function jsonRows<T>(client: ClickHouseClientLike, query: string, params: Record<string, unknown> = {}): Promise<T[]> {
  const result = await client.query({ query, query_params: params, format: "JSONEachRow" });
  return (await result.json()) as T[];
}

function inClause(column: string, values: string[], prefix: string, params: Record<string, unknown>): string {
  if (!values.length) return "";
  const placeholders = values.map((value, index) => {
    const key = `${prefix}_${index}`;
    params[key] = value;
    return `{${key}:String}`;
  });
  return `${column} IN (${placeholders.join(", ")})`;
}

function campaignPathClause(values: string[], params: Record<string, unknown>): string {
  if (!values.length) return "";
  const includeEmpty = values.includes(EMPTY_CAMPAIGN_PATH);
  const concrete = values.filter((value) => value !== EMPTY_CAMPAIGN_PATH);
  const concreteClause = inClause("campaign_path", concrete, "campaign_path", params);
  if (includeEmpty && concreteClause) return `(${concreteClause} OR campaign_path = '')`;
  if (includeEmpty) return `campaign_path = ''`;
  return concreteClause;
}

function triClause(column: string, value: SupportTriState): string {
  if (value === "yes") return `${column} = 1`;
  if (value === "no") return `${column} = 0`;
  return "";
}

function whereClause(authUserId: string, req: NormalizedRequest, params: Record<string, unknown>): string {
  params.auth_user_id = authUserId;
  const clauses = [`auth_user_id = {auth_user_id:String}`];
  if (req.dateFrom) {
    params.date_from = req.dateFrom;
    clauses.push(`request_date >= toDate({date_from:String})`);
  }
  if (req.dateTo) {
    params.date_to = req.dateTo;
    clauses.push(`request_date <= toDate({date_to:String})`);
  }
  const f = req.filters;
  [
    inClause("funnel", f.funnel, "funnel", params),
    campaignPathClause(f.campaign_path, params),
    inClause("category", f.category, "category", params),
    inClause("subcategory", f.subcategory, "subcategory", params),
    inClause("language", f.language, "language", params),
    inClause("urgency", f.urgency, "urgency", params),
    inClause("import_batch_id", f.import_batch_id, "batch", params),
    f.matched === "yes" ? "attribution_status = 'matched'" : f.matched === "no" ? "attribution_status != 'matched'" : "",
    triClause("requires_cancellation", f.requires_cancellation),
    triClause("requires_refund", f.requires_refund),
    triClause("payment_related", f.payment_related),
    triClause("delivery_related", f.delivery_related),
  ].filter(Boolean).forEach((clause) => clauses.push(clause));
  if (f.manual_status === "manual") clauses.push(`manual_category != ''`);
  if (f.manual_status === "automatic") clauses.push(`manual_category = ''`);
  if (f.search) {
    params.search = f.search;
    clauses.push(`(
      positionCaseInsensitiveUTF8(sender, {search:String}) > 0 OR
      positionCaseInsensitiveUTF8(customer_email, {search:String}) > 0 OR
      positionCaseInsensitiveUTF8(normalized_email, {search:String}) > 0 OR
      positionCaseInsensitiveUTF8(subject, {search:String}) > 0 OR
      positionCaseInsensitiveUTF8(message_body, {search:String}) > 0 OR
      positionCaseInsensitiveUTF8(matched_contact_name, {search:String}) > 0
    )`);
  }
  return clauses.join(" AND ");
}

function row(r: Record<string, unknown>): SupportRequestRow {
  return {
    id: s(r.id),
    import_batch_id: s(r.import_batch_id) || null,
    source_row_number: n(r.source_row_number),
    sender_name: s(r.sender_name) || null,
    subject: s(r.subject) || null,
    received_at: s(r.received_at) || null,
    received_date_raw: s(r.received_date_raw) || null,
    customer_email: s(r.customer_email) || null,
    normalized_email: s(r.normalized_email) || null,
    matched_contact_name: s(r.matched_contact_name) || null,
    funnel: s(r.funnel) || UNKNOWN_FUNNEL,
    campaign_path: s(r.campaign_path) || null,
    cohort_date: s(r.cohort_date) || null,
    attribution_status: (s(r.attribution_status) || "unmatched_email") as SupportRequestRow["attribution_status"],
    category: s(r.category),
    subcategory: s(r.subcategory),
    automatic_category: s(r.automatic_category),
    automatic_subcategory: s(r.automatic_subcategory),
    language: s(r.language),
    sentiment: s(r.sentiment),
    urgency: s(r.urgency),
    requires_refund: bool(r.requires_refund),
    requires_cancellation: bool(r.requires_cancellation),
    payment_related: bool(r.payment_related),
    delivery_related: bool(r.delivery_related),
    possible_unauthorized_charge: bool(r.possible_unauthorized_charge),
    duplicate_charge: bool(r.duplicate_charge),
    urgent: bool(r.urgent),
    matched_customer: bool(r.matched_customer),
    classification_confidence: n(r.classification_confidence),
    classification_reason: s(r.classification_reason) || null,
    manual_category: s(r.manual_category) || null,
    manual_subcategory: s(r.manual_subcategory) || null,
    manual_urgency: s(r.manual_urgency) || null,
    imported_at: s(r.imported_at),
  };
}

const ROW_SELECT = `
  request_id AS id,
  nullIf(import_batch_id, '') AS import_batch_id,
  source_row_number,
  nullIf(sender, '') AS sender_name,
  nullIf(subject, '') AS subject,
  formatDateTime(received_at, '%Y-%m-%dT%H:%i:%S.000Z') AS received_at,
  nullIf(received_date_raw, '') AS received_date_raw,
  nullIf(customer_email, '') AS customer_email,
  nullIf(normalized_email, '') AS normalized_email,
  nullIf(matched_contact_name, '') AS matched_contact_name,
  if(funnel = '', '${UNKNOWN_FUNNEL}', funnel) AS funnel,
  campaign_path,
  ifNull(toString(cohort_date), '') AS cohort_date,
  attribution_status,
  category,
  subcategory,
  automatic_category,
  automatic_subcategory,
  language,
  sentiment,
  urgency,
  requires_refund,
  requires_cancellation,
  payment_related,
  delivery_related,
  possible_unauthorized_charge,
  duplicate_charge,
  urgent,
  matched_customer,
  classification_confidence,
  classification_reason,
  nullIf(manual_category, '') AS manual_category,
  nullIf(manual_subcategory, '') AS manual_subcategory,
  nullIf(manual_urgency, '') AS manual_urgency,
  formatDateTime(imported_at, '%Y-%m-%dT%H:%i:%S.000Z') AS imported_at
`;

export async function runSupportList(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: SupportRequest }): Promise<SupportListResponse> {
  const started = Date.now();
  const req = normalizeSupportRequest({ ...input.request, action: "list" });
  const params: Record<string, unknown> = {};
  const where = whereClause(input.authUserId, req, params);
  const offset = (req.page - 1) * req.pageSize;
  params.limit = req.pageSize;
  params.offset = offset;
  const [countRow] = await jsonRows<{ count?: number | string }>(input.clickhouse, `SELECT count() AS count FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE ${where}`, params);
  const total = n(countRow?.count);
  const direction = req.sortDir === "asc" ? "ASC" : "DESC";
  const order = req.sortField === "funnel"
    ? `if(funnel = '${UNKNOWN_FUNNEL}' OR funnel = '', 1, 0) ASC, lowerUTF8(funnel) ${direction}`
    : req.sortField === "campaign_path"
      ? `if(campaign_path = '', 1, 0) ASC, lowerUTF8(campaign_path) ${direction}`
      : `${req.sortField} ${direction}`;
  const rows = await jsonRows<Record<string, unknown>>(
    input.clickhouse,
    `SELECT ${ROW_SELECT}
     FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
     WHERE ${where}
     ORDER BY ${order}, request_id ASC
     LIMIT {limit:UInt32} OFFSET {offset:UInt32}`,
    params,
  );
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    pagination: { page: req.page, page_size: req.pageSize, total_rows: total, total_pages: Math.max(1, Math.ceil(total / req.pageSize)) },
    rows: rows.map(row),
  };
}

export async function runSupportDetails(input: { authUserId: string; clickhouse: ClickHouseClientLike; request: SupportRequest }): Promise<SupportDetailsResponse> {
  const started = Date.now();
  const req = normalizeSupportRequest({ ...input.request, action: "details" });
  if (!req.requestId) throw new SupportRequestError("request_id is required for support details.");
  const rows = await jsonRows<Record<string, unknown>>(
    input.clickhouse,
    `SELECT ${ROW_SELECT}, message_body
     FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
     WHERE auth_user_id = {auth_user_id:String} AND request_id = {request_id:String}
     LIMIT 1`,
    { auth_user_id: input.authUserId, request_id: req.requestId },
  );
  const mapped = rows[0] ? { ...row(rows[0]), message_body: s(rows[0].message_body) || null } as SupportRequestDetailRow : null;
  return { ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started, row: mapped };
}

async function runOptions(input: { authUserId: string; clickhouse: ClickHouseClientLike }): Promise<SupportFilterOptions> {
  const params = { auth_user_id: input.authUserId };
  const [funnels, campaignPaths, categories, subcategories, languages, urgencies, batches] = await Promise.all([
    jsonRows<{ funnel: string; requests: number }>(input.clickhouse, `SELECT if(funnel = '', '${UNKNOWN_FUNNEL}', funnel) funnel, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY funnel ORDER BY if(funnel = '${UNKNOWN_FUNNEL}', 1, 0) ASC, lowerUTF8(funnel) ASC`, params),
    jsonRows<{ campaign_path: string; requests: number }>(input.clickhouse, `SELECT if(campaign_path = '', '${EMPTY_CAMPAIGN_PATH}', campaign_path) campaign_path, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY campaign_path ORDER BY if(campaign_path = '', 1, 0) ASC, lowerUTF8(campaign_path) ASC`, params),
    jsonRows<{ category: string; requests: number }>(input.clickhouse, `SELECT category, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY category ORDER BY requests DESC, category ASC`, params),
    jsonRows<{ subcategory: string; requests: number }>(input.clickhouse, `SELECT subcategory, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY subcategory ORDER BY requests DESC, subcategory ASC LIMIT 500`, params),
    jsonRows<{ language: string; requests: number }>(input.clickhouse, `SELECT language, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY language ORDER BY requests DESC`, params),
    jsonRows<{ urgency: string; requests: number }>(input.clickhouse, `SELECT urgency, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} GROUP BY urgency ORDER BY requests DESC`, params),
    jsonRows<{ import_batch_id: string; requests: number }>(input.clickhouse, `SELECT import_batch_id, count() requests FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String} AND import_batch_id != '' GROUP BY import_batch_id ORDER BY requests DESC LIMIT 100`, params),
  ]);
  return { funnels, campaign_paths: campaignPaths, categories, subcategories, languages, urgencies, import_batches: batches };
}

export async function runSupportOptions(input: { authUserId: string; clickhouse: ClickHouseClientLike }): Promise<SupportOptionsResponse> {
  const started = Date.now();
  const filter_options = await runOptions(input);
  return { ok: true, source: "clickhouse", generated_at: new Date().toISOString(), query_duration_ms: Date.now() - started, filter_options };
}

export async function runSupportBundle(input: { authUserId: string; supabase: SupabaseLikeClient; clickhouse: ClickHouseClientLike; request: SupportRequest }): Promise<SupportAnalyticsBundle> {
  const started = Date.now();
  const req = normalizeSupportRequest({ ...input.request, action: "bundle" });
  const params: Record<string, unknown> = {};
  const where = whereClause(input.authUserId, req, params);
  const base = `FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE ${where}`;
  const snapshotState = await getCohortSnapshotState(input.supabase, input.authUserId).catch(() => null);
  const activeSnapshot = activeCohortSnapshotVersion(snapshotState);
  const denominatorParams = activeSnapshot ? {
    auth_user_id: input.authUserId,
    cohort_warehouse_version: activeSnapshot.warehouse_version,
    cohort_classification_version: activeSnapshot.classification_version,
  } : {};
  const [
    summaryRows,
    byDay,
    funnelTrend,
    categoryTrend,
    operationalTrend,
    languageDistribution,
    priorityDistribution,
    categoryRankingRows,
    subcategoryRows,
    matchingRows,
    duplicateEmailRows,
    multipleSenderRows,
    funnelRankingRows,
    campaignPathRankingRows,
    denominatorRows,
    filterOptions,
  ] = await Promise.all([
    jsonRows<Record<string, unknown>>(input.clickhouse, `
      SELECT
        count() total,
        uniqExact(if(normalized_email != '', normalized_email, sender)) unique_senders,
        countIf(attribution_status = 'matched') matched,
        countIf(category = 'Cancellation' OR requires_cancellation = 1) cancellation,
        countIf(category = 'Refund' OR requires_refund = 1) refund,
        countIf(category = 'Unauthorized or unexpected charge' OR possible_unauthorized_charge = 1) unauthorized,
        countIf(category = 'Product/report not received') missing_product,
        countIf(category = 'Payment issue') payment_issues,
        countIf(urgency = 'high') high,
        countIf(payment_related = 1) payment_related,
        uniqExact(request_date) active_days,
        countIf(funnel != '' AND funnel != '${UNKNOWN_FUNNEL}') requests_with_funnel,
        countIf(funnel = '' OR funnel = '${UNKNOWN_FUNNEL}') requests_without_funnel,
        uniqExactIf(matched_user_id, attribution_status = 'matched' AND matched_user_id != '') unique_matched_support_users,
        countIf(attribution_status = 'unmatched_email') unmatched_emails,
        countIf(attribution_status = 'user_without_trial') users_without_trial,
        countIf(attribution_status = 'ambiguous') ambiguous,
        argMax(attribution_version, row_version) attribution_version
      ${base}`, params),
    jsonRows<{ date: string; requests: number }>(input.clickhouse, `SELECT toString(request_date) date, count() requests ${base} GROUP BY request_date ORDER BY request_date ASC`, params),
    jsonRows<{ date: string; funnel: string; requests: number }>(input.clickhouse, `SELECT toString(request_date) date, if(funnel = '', '${UNKNOWN_FUNNEL}', funnel) funnel, count() requests ${base} GROUP BY request_date, funnel ORDER BY request_date ASC, funnel ASC`, params),
    jsonRows<{ date: string; category: string; requests: number }>(input.clickhouse, `SELECT toString(request_date) date, category, count() requests ${base} GROUP BY request_date, category ORDER BY request_date ASC, category ASC`, params),
    jsonRows<{ date: string; cancellation: number; refund: number; charge: number }>(input.clickhouse, `
      SELECT toString(request_date) date,
        countIf(category = 'Cancellation' OR requires_cancellation = 1) cancellation,
        countIf(category = 'Refund' OR requires_refund = 1) refund,
        countIf(category = 'Unauthorized or unexpected charge' OR possible_unauthorized_charge = 1 OR duplicate_charge = 1) charge
      ${base}
      GROUP BY request_date ORDER BY request_date ASC`, params),
    jsonRows<{ language: string; requests: number }>(input.clickhouse, `SELECT language, count() requests ${base} GROUP BY language ORDER BY requests DESC, language ASC`, params),
    jsonRows<{ urgency: string; requests: number }>(input.clickhouse, `SELECT urgency, count() requests ${base} GROUP BY urgency ORDER BY requests DESC, urgency ASC`, params),
    jsonRows<Record<string, unknown>>(input.clickhouse, `
      SELECT category, count() requests,
        uniqExact(if(normalized_email != '', normalized_email, sender)) uniqueSenders,
        countIf(attribution_status = 'matched') matchedCustomers,
        countIf(urgency = 'high') highPriority,
        max(received_at) latest
      ${base}
      GROUP BY category ORDER BY requests DESC, category ASC`, params),
    jsonRows<{ subcategory: string; requests: number }>(input.clickhouse, `SELECT subcategory, count() requests ${base} GROUP BY subcategory ORDER BY requests DESC, subcategory ASC LIMIT 500`, params),
    jsonRows<Record<string, unknown>>(input.clickhouse, `
      SELECT
        countIf(attribution_status = 'matched') matchedByEmail,
        toUInt64(0) matchedByName,
        countIf(attribution_status != 'matched') unmatched,
        countIf(normalized_email != '' AND matched_contact_name = '') emailPresentNoMatchedContact,
        countIf(normalized_email = '' AND matched_contact_name != '') matchedContactNoEmail
      ${base}`, params),
    jsonRows<{ duplicateNormalizedEmails: number }>(input.clickhouse, `
      SELECT count() duplicateNormalizedEmails FROM (
        SELECT normalized_email FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
        WHERE ${where} AND normalized_email != ''
        GROUP BY normalized_email HAVING count() > 1
      )`, params),
    jsonRows<{ multipleSenderNamesForOneEmail: number }>(input.clickhouse, `
      SELECT count() multipleSenderNamesForOneEmail FROM (
        SELECT normalized_email FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
        WHERE ${where} AND normalized_email != '' AND sender != ''
        GROUP BY normalized_email HAVING uniqExact(sender) > 1
      )`, params),
    jsonRows<Record<string, unknown>>(input.clickhouse, `
      SELECT
        if(funnel = '', '${UNKNOWN_FUNNEL}', funnel) funnel,
        count() requests,
        uniqExactIf(matched_user_id, attribution_status = 'matched' AND matched_user_id != '') uniqueSupportUsers,
        countIf(category = 'Cancellation' OR requires_cancellation = 1) cancellationRequests,
        countIf(category = 'Refund' OR requires_refund = 1) refundRequests,
        countIf(category = 'Unauthorized or unexpected charge' OR possible_unauthorized_charge = 1 OR duplicate_charge = 1) unauthorizedChargeRequests,
        countIf(urgency = 'high') highPriority,
        uniqExactIf(matched_user_id, attribution_status = 'matched' AND matched_user_id != '') matchedUsers,
        max(received_at) latestRequest
      ${base}
      GROUP BY funnel
      ORDER BY requests DESC, if(funnel = '${UNKNOWN_FUNNEL}', 1, 0) ASC, lowerUTF8(funnel) ASC`, params),
    jsonRows<Record<string, unknown>>(input.clickhouse, `
      SELECT
        if(campaign_path = '', '${EMPTY_CAMPAIGN_PATH}', campaign_path) campaignPath,
        count() requests,
        uniqExactIf(matched_user_id, attribution_status = 'matched' AND matched_user_id != '') uniqueSupportUsers,
        countIf(category = 'Cancellation' OR requires_cancellation = 1) cancellationRequests,
        countIf(category = 'Refund' OR requires_refund = 1) refundRequests,
        countIf(urgency = 'high') highPriority,
        max(received_at) latestRequest
      ${base}
      GROUP BY campaign_path
      ORDER BY requests DESC, if(campaign_path = '', 1, 0) ASC, lowerUTF8(campaign_path) ASC`, params),
    activeSnapshot
      ? jsonRows<{ funnel: string; campaign_path: string; trialUsers: number }>(input.clickhouse, `
          SELECT funnel, campaign_path, uniqExact(canonical_user_id) trialUsers
          FROM ${FACT_USER_COHORTS_TABLE} FINAL
          WHERE auth_user_id = {auth_user_id:String}
            AND warehouse_version = {cohort_warehouse_version:String}
            AND classification_version = {cohort_classification_version:String}
          GROUP BY funnel, campaign_path`, denominatorParams)
      : Promise.resolve([] as Array<{ funnel: string; campaign_path: string; trialUsers: number }>),
    runOptions(input),
  ]);

  const summary = summaryRows[0] ?? {};
  const total = n(summary.total);
  const matched = n(summary.matched);
  const cancellation = n(summary.cancellation);
  const refund = n(summary.refund);
  const unauthorized = n(summary.unauthorized);
  const high = n(summary.high);
  const paymentRelated = n(summary.payment_related);
  const activeDays = Math.max(1, n(summary.active_days));
  const categoryRanking = categoryRankingRows.map((r) => ({
    category: s(r.category),
    requests: n(r.requests),
    share: pct(n(r.requests), total),
    uniqueSenders: n(r.uniqueSenders),
    matchedCustomers: n(r.matchedCustomers),
    highPriority: n(r.highPriority),
    latestRequest: r.latest ? `${s(r.latest).replace(" ", "T").replace(/\\.\\d+$/, "")}.000Z` : null,
    trendVsPrevious: null,
  }));
  const subcategoryTotal = subcategoryRows.reduce((sum, item) => sum + n(item.requests), 0);
  const denominatorByFunnel = new Map<string, number>();
  const denominatorByCampaignPath = new Map<string, number>();
  denominatorRows.forEach((item) => {
    const trialUsers = n(item.trialUsers);
    const campaignPath = s(item.campaign_path) || EMPTY_CAMPAIGN_PATH;
    denominatorByFunnel.set(item.funnel, (denominatorByFunnel.get(item.funnel) ?? 0) + trialUsers);
    denominatorByCampaignPath.set(campaignPath, (denominatorByCampaignPath.get(campaignPath) ?? 0) + trialUsers);
  });
  const funnelRanking = funnelRankingRows.map((item) => {
    const funnel = s(item.funnel) || UNKNOWN_FUNNEL;
    const uniqueSupportUsers = n(item.uniqueSupportUsers);
    const denominator = activeSnapshot && funnel !== UNKNOWN_FUNNEL ? denominatorByFunnel.get(funnel) ?? 0 : 0;
    return {
      funnel,
      requests: n(item.requests),
      uniqueSupportUsers,
      share: pct(n(item.requests), total),
      cancellationRequests: n(item.cancellationRequests),
      refundRequests: n(item.refundRequests),
      unauthorizedChargeRequests: n(item.unauthorizedChargeRequests),
      highPriority: n(item.highPriority),
      matchedUsers: n(item.matchedUsers),
      latestRequest: item.latestRequest ? `${s(item.latestRequest).replace(" ", "T").replace(/\.\d+$/, "")}.000Z` : null,
      trialUsers: denominator > 0 ? denominator : null,
      supportRate: denominator > 0 ? pct(uniqueSupportUsers, denominator) : null,
    };
  });
  const campaignPathRanking = campaignPathRankingRows.map((item) => {
    const campaignPath = s(item.campaignPath) || EMPTY_CAMPAIGN_PATH;
    const uniqueSupportUsers = n(item.uniqueSupportUsers);
    const denominator = activeSnapshot ? denominatorByCampaignPath.get(campaignPath) ?? 0 : 0;
    return {
      campaignPath,
      requests: n(item.requests),
      uniqueSupportUsers,
      cancellationRequests: n(item.cancellationRequests),
      refundRequests: n(item.refundRequests),
      highPriority: n(item.highPriority),
      latestRequest: item.latestRequest ? `${s(item.latestRequest).replace(" ", "T").replace(/\.\d+$/, "")}.000Z` : null,
      trialUsers: denominator > 0 ? denominator : null,
      supportRate: denominator > 0 ? pct(uniqueSupportUsers, denominator) : null,
    };
  });
  const matching = matchingRows[0] ?? {};
  const topCategory = categoryRanking[0];
  const topLanguage = languageDistribution[0];
  const busiestDay = byDay.slice().sort((a, b) => n(b.requests) - n(a.requests))[0];
  return {
    ok: true,
    source: "clickhouse",
    generated_at: new Date().toISOString(),
    query_duration_ms: Date.now() - started,
    summary: {
      rows: [],
      kpis: {
        totalRequests: total,
        uniqueSenders: n(summary.unique_senders),
        matchedCustomers: matched,
        unmatchedRequests: total - matched,
        cancellationRequests: cancellation,
        refundRequests: refund,
        unauthorizedChargeRequests: unauthorized,
        productNotReceivedRequests: n(summary.missing_product),
        paymentIssues: n(summary.payment_issues),
        highPriorityRequests: high,
        requestsPerDay: round1(total / activeDays),
        matchedPct: pct(matched, total),
        cancellationPct: pct(cancellation, total),
        refundPct: pct(refund, total),
        paymentRelatedPct: pct(paymentRelated, total),
      },
      byDay,
      funnelTrend,
      categoryTrend,
      operationalTrend,
      languageDistribution,
      matchDistribution: [{ status: "matched", requests: matched }, { status: "unmatched", requests: total - matched }],
      priorityDistribution,
      categoryRanking,
      subcategoryRanking: subcategoryRows.map((r) => ({ subcategory: r.subcategory, requests: n(r.requests), share: pct(n(r.requests), subcategoryTotal) })),
      funnelRanking,
      campaignPathRanking,
      matching: {
        matchedByEmail: n(matching.matchedByEmail),
        matchedByName: n(matching.matchedByName),
        unmatched: n(matching.unmatched),
        emailPresentNoMatchedContact: n(matching.emailPresentNoMatchedContact),
        matchedContactNoEmail: n(matching.matchedContactNoEmail),
        duplicateNormalizedEmails: n(duplicateEmailRows[0]?.duplicateNormalizedEmails),
        multipleSenderNamesForOneEmail: n(multipleSenderRows[0]?.multipleSenderNamesForOneEmail),
      },
      insights: [
        topCategory ? `Most common reason: ${topCategory.category} (${topCategory.requests} requests).` : "No support requests in the selected range.",
        `Cancellation share: ${pct(cancellation, total)}%.`,
        `Refund share: ${pct(refund, total)}%.`,
        `Unexpected-charge share: ${pct(unauthorized, total)}%.`,
        topLanguage ? `Most common language: ${topLanguage.language}.` : "Language distribution is unavailable.",
        `Match rate: ${pct(matched, total)}%.`,
        busiestDay ? `Highest-volume day: ${busiestDay.date} (${busiestDay.requests} requests).` : "No daily trend available.",
      ],
    },
    filter_options: filterOptions,
    diagnostics: {
      rows_scanned: total,
      payload_kind: "aggregate_only",
      browser_aggregation: false,
      requests_with_funnel: n(summary.requests_with_funnel),
      requests_without_funnel: n(summary.requests_without_funnel),
      unique_matched_support_users: n(summary.unique_matched_support_users),
      unmatched_emails: n(summary.unmatched_emails),
      users_without_trial: n(summary.users_without_trial),
      ambiguous: n(summary.ambiguous),
      attribution_version: s(summary.attribution_version) || null,
      support_rate_denominator_available: Boolean(activeSnapshot),
      support_rate_diagnostic: activeSnapshot ? null : "No completed validated fact_user_cohorts snapshot is available.",
    },
  };
}

async function sourceTotal(supabase: SupabaseLikeClient, authUserId: string): Promise<number> {
  const { count, error } = await supabase.from("support_requests").select("id", { count: "exact", head: true }).eq("auth_user_id", authUserId);
  if (error) throw new Error(`Could not count support requests: ${error.message}`);
  return count ?? 0;
}

async function clickhouseTotal(client: ClickHouseClientLike, authUserId: string): Promise<number> {
  const rows = await jsonRows<{ count: number | string }>(client, `SELECT count() count FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL WHERE auth_user_id = {auth_user_id:String}`, { auth_user_id: authUserId });
  return n(rows[0]?.count);
}

async function getSyncState(supabase: SupabaseLikeClient, authUserId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("sync_name", SYNC_NAME)
    .maybeSingle();
  if (error) throw new Error(`Could not load support sync state: ${error.message}`);
  return (data ?? null) as Record<string, unknown> | null;
}

async function upsertSyncState(supabase: SupabaseLikeClient, patch: Record<string, unknown> & { auth_user_id: string }): Promise<void> {
  const { error } = await supabase
    .from("clickhouse_transaction_sync_state")
    .upsert({ sync_name: SYNC_NAME, ...patch, updated_at: new Date().toISOString() }, { onConflict: "auth_user_id,sync_name" });
  if (error) throw new Error(`Could not update support sync state: ${error.message}`);
}

async function readSupportBatch(input: {
  supabase: SupabaseLikeClient;
  authUserId: string;
  batchSize: number;
  cursorUpdatedAt: string | null;
  cursorRequestId: string | null;
}): Promise<SupabaseSupportRow[]> {
  let query = input.supabase
    .from("support_requests")
    .select(SUPPORT_SELECT)
    .eq("auth_user_id", input.authUserId)
    .order("updated_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(input.batchSize);
  if (input.cursorUpdatedAt && input.cursorRequestId) {
    query = query.or(`updated_at.gt.${input.cursorUpdatedAt},and(updated_at.eq.${input.cursorUpdatedAt},id.gt.${input.cursorRequestId})`);
  }
  const { data, error } = await query;
  if (error) throw new Error(`Could not read support request batch: ${error.message}`);
  return (data ?? []) as SupabaseSupportRow[];
}

function chTime(value: string | null | undefined): string {
  const dateValue = value ? new Date(value) : new Date(0);
  const date = Number.isNaN(dateValue.getTime()) ? new Date(0) : dateValue;
  return date.toISOString().replace("T", " ").replace("Z", "");
}

function dateKey(value: string | null | undefined): string {
  const dateValue = value ? new Date(value) : new Date(0);
  const date = Number.isNaN(dateValue.getTime()) ? new Date(0) : dateValue;
  return date.toISOString().slice(0, 10);
}

export function normalizeSupportAttributionEmail(value: string | null | undefined): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : "";
}

export function supportAttributionStatus(input: {
  normalizedEmail: string | null | undefined;
  cohortUserCount: number;
  transactionUserCount: number;
}): SupportRequestRow["attribution_status"] {
  if (!normalizeSupportAttributionEmail(input.normalizedEmail)) return "unmatched_email";
  if (input.cohortUserCount > 1 || input.transactionUserCount > 1) return "ambiguous";
  if (input.cohortUserCount === 1) return "matched";
  if (input.transactionUserCount === 1) return "user_without_trial";
  return "unmatched_email";
}

function mapSupportRow(row: SupabaseSupportRow, syncedAt: string): Record<string, unknown> | null {
  if (!row.received_at) return null;
  const c = classifySupportRequestServer(row.subject ?? "", row.message_body ?? "");
  const category = row.manual_category || c.category;
  const subcategory = row.manual_subcategory || c.subcategory;
  const urgency = row.manual_urgency || c.urgency;
  const normalizedEmail = normalizeSupportAttributionEmail(row.normalized_email || row.customer_email);
  return {
    auth_user_id: row.auth_user_id,
    request_id: row.id,
    import_batch_id: row.import_batch_id ?? "",
    source_row_number: row.source_row_number ?? 0,
    received_at: chTime(row.received_at),
    request_date: dateKey(row.received_at),
    received_date_raw: row.received_date_raw ?? "",
    customer_email: row.customer_email ?? "",
    normalized_email: normalizedEmail,
    matched_customer: row.normalized_email || row.matched_contact_name ? 1 : 0,
    matched_user_id: "",
    funnel: UNKNOWN_FUNNEL,
    campaign_path: "",
    cohort_date: null,
    attribution_status: "unmatched_email",
    attribution_version: "",
    sender: row.sender_name ?? "",
    matched_contact_name: row.matched_contact_name ?? "",
    language: c.language,
    category,
    subcategory,
    automatic_category: c.category,
    automatic_subcategory: c.subcategory,
    manual_category: row.manual_category ?? "",
    manual_subcategory: row.manual_subcategory ?? "",
    urgency,
    automatic_urgency: c.urgency,
    manual_urgency: row.manual_urgency ?? "",
    sentiment: c.sentiment,
    requires_refund: c.requires_refund ? 1 : 0,
    requires_cancellation: c.requires_cancellation ? 1 : 0,
    payment_related: c.payment_related ? 1 : 0,
    delivery_related: c.delivery_related ? 1 : 0,
    possible_unauthorized_charge: c.possible_unauthorized_charge ? 1 : 0,
    duplicate_charge: c.duplicate_charge ? 1 : 0,
    urgent: urgency === "high" ? 1 : 0,
    subject: row.subject ?? "",
    message_body: row.message_body ?? "",
    source_hash: row.source_hash,
    classification_version: SUPPORT_CLASSIFICATION_VERSION,
    classification_confidence: c.classification_confidence,
    classification_reason: c.classification_reason,
    imported_at: chTime(row.imported_at),
    source_updated_at: chTime(row.updated_at),
    clickhouse_synced_at: chTime(syncedAt),
    row_version: Date.now(),
  };
}

export interface SupportAttributionBackfillResult {
  rows_scanned: number;
  funnel_matched: number;
  unknown: number;
  users_without_trial: number;
  unmatched_email: number;
  ambiguous: number;
  attribution_version: string | null;
  duration_ms: number;
  denominator_available: boolean;
}

const SUPPORT_FACT_COLUMNS = [
  "auth_user_id", "request_id", "import_batch_id", "source_row_number", "received_at", "request_date", "received_date_raw",
  "customer_email", "normalized_email", "matched_customer", "matched_user_id", "funnel", "campaign_path", "cohort_date",
  "attribution_status", "attribution_version", "sender", "matched_contact_name", "language", "category", "subcategory",
  "automatic_category", "automatic_subcategory", "manual_category", "manual_subcategory", "urgency", "automatic_urgency",
  "manual_urgency", "sentiment", "requires_refund", "requires_cancellation", "payment_related", "delivery_related",
  "possible_unauthorized_charge", "duplicate_charge", "urgent", "subject", "message_body", "source_hash", "classification_version",
  "classification_confidence", "classification_reason", "imported_at", "source_updated_at", "clickhouse_synced_at", "row_version",
] as const;

export async function enrichSupportAttribution(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
}): Promise<SupportAttributionBackfillResult> {
  const started = Date.now();
  const snapshotState = await getCohortSnapshotState(input.supabase, input.authUserId).catch(() => null);
  const active = activeCohortSnapshotVersion(snapshotState);
  if (!active) {
    return {
      rows_scanned: 0,
      funnel_matched: 0,
      unknown: await clickhouseTotal(input.clickhouse, input.authUserId),
      users_without_trial: 0,
      unmatched_email: 0,
      ambiguous: 0,
      attribution_version: null,
      duration_ms: Date.now() - started,
      denominator_available: false,
    };
  }

  const attributionVersion = `${active.warehouse_version}|${active.classification_version}`;
  const params = {
    auth_user_id: input.authUserId,
    warehouse_version: active.warehouse_version,
    classification_version: active.classification_version,
    attribution_version: attributionVersion,
  };
  const [stale] = await jsonRows<{ rows_scanned: number }>(input.clickhouse, `
    SELECT count() rows_scanned
    FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
    WHERE auth_user_id = {auth_user_id:String}
      AND attribution_version != {attribution_version:String}`, params);
  const rowsScanned = n(stale?.rows_scanned);

  if (rowsScanned > 0) {
    const validEmail = "match(s.normalized_email, '^[^\\\\s@]+@[^\\\\s@]+\\\\.[^\\\\s@]+$')";
    const status = `multiIf(
      NOT ${validEmail}, 'unmatched_email',
      ifNull(c.user_count, 0) > 1 OR ifNull(u.user_count, 0) > 1, 'ambiguous',
      ifNull(c.user_count, 0) = 1, 'matched',
      ifNull(u.user_count, 0) = 1, 'user_without_trial',
      'unmatched_email'
    )`;
    await input.clickhouse.command({ query: `
      INSERT INTO ${FACT_SUPPORT_REQUESTS_TABLE} (${SUPPORT_FACT_COLUMNS.join(", ")})
      WITH cohort_by_email AS (
        SELECT
          normalized_email,
          uniqExact(canonical_user_id) user_count,
          argMin(canonical_user_id, (cohort_date, trial_event_time, trial_transaction_id)) matched_user_id,
          argMin(funnel, (cohort_date, trial_event_time, trial_transaction_id)) funnel,
          argMin(campaign_path, (cohort_date, trial_event_time, trial_transaction_id)) campaign_path,
          argMin(cohort_date, (cohort_date, trial_event_time, trial_transaction_id)) matched_cohort_date
        FROM ${FACT_USER_COHORTS_TABLE} FINAL
        WHERE auth_user_id = {auth_user_id:String}
          AND warehouse_version = {warehouse_version:String}
          AND classification_version = {classification_version:String}
          AND normalized_email != ''
        GROUP BY normalized_email
      ), transaction_users_by_email AS (
        SELECT normalized_email, uniqExact(user_id) user_count
        FROM ${ANALYTICS_TRANSACTIONS_TABLE} FINAL
        WHERE auth_user_id = {auth_user_id:String}
          AND normalized_email != ''
          AND user_id != ''
        GROUP BY normalized_email
      )
      SELECT
        s.auth_user_id, s.request_id, s.import_batch_id, s.source_row_number, s.received_at, s.request_date, s.received_date_raw,
        s.customer_email, s.normalized_email, s.matched_customer,
        if(${status} = 'matched', c.matched_user_id, '') matched_user_id,
        if(${status} = 'matched' AND c.funnel != '', c.funnel, '${UNKNOWN_FUNNEL}') funnel,
        if(${status} = 'matched', c.campaign_path, '') campaign_path,
        if(${status} = 'matched', toNullable(c.matched_cohort_date), NULL) cohort_date,
        ${status} attribution_status,
        {attribution_version:String} attribution_version,
        s.sender, s.matched_contact_name, s.language, s.category, s.subcategory, s.automatic_category, s.automatic_subcategory,
        s.manual_category, s.manual_subcategory, s.urgency, s.automatic_urgency, s.manual_urgency, s.sentiment,
        s.requires_refund, s.requires_cancellation, s.payment_related, s.delivery_related, s.possible_unauthorized_charge,
        s.duplicate_charge, s.urgent, s.subject, s.message_body, s.source_hash, s.classification_version,
        s.classification_confidence, s.classification_reason, s.imported_at, s.source_updated_at, now64(3) clickhouse_synced_at,
        greatest(s.row_version + 1, toUInt64(toUnixTimestamp64Milli(now64(3)))) row_version
      FROM ${FACT_SUPPORT_REQUESTS_TABLE} AS s FINAL
      LEFT JOIN cohort_by_email AS c ON c.normalized_email = s.normalized_email
      LEFT JOIN transaction_users_by_email AS u ON u.normalized_email = s.normalized_email
      WHERE s.auth_user_id = {auth_user_id:String}
        AND s.attribution_version != {attribution_version:String}
    `, query_params: params });
  }

  const [report] = await jsonRows<Record<string, unknown>>(input.clickhouse, `
    SELECT
      countIf(attribution_status = 'matched' AND funnel != '${UNKNOWN_FUNNEL}' AND funnel != '') funnel_matched,
      countIf(funnel = '${UNKNOWN_FUNNEL}' OR funnel = '') unknown,
      countIf(attribution_status = 'user_without_trial') users_without_trial,
      countIf(attribution_status = 'unmatched_email') unmatched_email,
      countIf(attribution_status = 'ambiguous') ambiguous
    FROM ${FACT_SUPPORT_REQUESTS_TABLE} FINAL
    WHERE auth_user_id = {auth_user_id:String}
      AND attribution_version = {attribution_version:String}`, params);
  return {
    rows_scanned: rowsScanned,
    funnel_matched: n(report?.funnel_matched),
    unknown: n(report?.unknown),
    users_without_trial: n(report?.users_without_trial),
    unmatched_email: n(report?.unmatched_email),
    ambiguous: n(report?.ambiguous),
    attribution_version: attributionVersion,
    duration_ms: Date.now() - started,
    denominator_available: true,
  };
}

export async function runSupportSync(input: {
  authUserId: string;
  supabase: SupabaseLikeClient;
  clickhouse: ClickHouseClientLike;
  request: SupportRequest;
}): Promise<SupportSyncResult> {
  const started = Date.now();
  await ensureFactSupportRequestsSchema(input.clickhouse);
  const batchSize = Math.max(1, Math.min(10_000, Math.floor(n(input.request.sync?.batch_size) || DEFAULT_SYNC_BATCH_SIZE)));
  const maxBatches = Math.max(1, Math.min(100, Math.floor(n(input.request.sync?.max_batches) || DEFAULT_SYNC_MAX_BATCHES)));
  const timeoutMs = Math.max(1000, Math.min(55_000, Math.floor(n(input.request.sync?.soft_timeout_ms) || DEFAULT_SYNC_TIMEOUT_MS)));
  const reset = Boolean(input.request.sync?.full_reset_cursor);
  const sourceRowsTotal = await sourceTotal(input.supabase, input.authUserId);
  const previous = await getSyncState(input.supabase, input.authUserId);
  let cursorUpdatedAt = reset ? null : s(previous?.cursor_updated_at) || null;
  let cursorRequestId = reset ? null : s(previous?.cursor_transaction_id) || null;
  let rowsScanned = 0;
  let rowsMapped = 0;
  let rowsInserted = 0;
  let rowsSkipped = 0;
  let batchesProcessed = 0;
  let stoppedReason: string | null = "completed";
  let status = "completed";
  const diagnostics: Record<string, unknown> = { failed_batches: [] };

  await upsertSyncState(input.supabase, {
    auth_user_id: input.authUserId,
    status: "running",
    current_stage: "support_sync",
    stopped_reason: null,
    started_at: new Date(started).toISOString(),
    finished_at: null,
    last_error: null,
    source_total: sourceRowsTotal,
    diagnostics,
  });

  try {
    for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
      if (Date.now() - started > timeoutMs) {
        stoppedReason = "soft_timeout";
        status = "partial";
        break;
      }
      const batch = await readSupportBatch({ supabase: input.supabase, authUserId: input.authUserId, batchSize, cursorUpdatedAt, cursorRequestId });
      if (!batch.length) {
        stoppedReason = "completed";
        status = "completed";
        break;
      }
      rowsScanned += batch.length;
      const syncedAt = new Date().toISOString();
      const mapped = batch.map((source) => mapSupportRow(source, syncedAt)).filter((value): value is Record<string, unknown> => Boolean(value));
      rowsMapped += mapped.length;
      rowsSkipped += batch.length - mapped.length;
      if (mapped.length) {
        await input.clickhouse.insert({ table: FACT_SUPPORT_REQUESTS_TABLE, values: mapped, format: "JSONEachRow" });
        rowsInserted += mapped.length;
      }
      const last = batch.at(-1);
      cursorUpdatedAt = last?.updated_at ?? cursorUpdatedAt;
      cursorRequestId = last?.id ?? cursorRequestId;
      batchesProcessed += 1;
      await upsertSyncState(input.supabase, {
        auth_user_id: input.authUserId,
        status: "partial",
        current_stage: "support_sync",
        cursor_updated_at: cursorUpdatedAt,
        cursor_transaction_id: cursorRequestId,
        rows_scanned: (n(previous?.rows_scanned) || 0) + rowsScanned,
        rows_mapped: (n(previous?.rows_mapped) || 0) + rowsMapped,
        rows_inserted: (n(previous?.rows_inserted) || 0) + rowsInserted,
        rows_skipped: (n(previous?.rows_skipped) || 0) + rowsSkipped,
        batches_processed: (n(previous?.batches_processed) || 0) + batchesProcessed,
        source_total: sourceRowsTotal,
        diagnostics,
      });
    }
    if (batchesProcessed >= maxBatches && status === "completed" && rowsScanned > 0) {
      stoppedReason = "max_batches_reached";
      status = "partial";
    }
    const attribution = await enrichSupportAttribution(input);
    diagnostics.attribution = attribution;
    const chTotal = await clickhouseTotal(input.clickhouse, input.authUserId);
    const duration = Date.now() - started;
    await upsertSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status,
      current_stage: "idle",
      stopped_reason: stoppedReason,
      cursor_updated_at: cursorUpdatedAt,
      cursor_transaction_id: cursorRequestId,
      finished_at: new Date().toISOString(),
      duration_ms: duration,
      rows_scanned: (n(previous?.rows_scanned) || 0) + rowsScanned,
      rows_mapped: (n(previous?.rows_mapped) || 0) + rowsMapped,
      rows_inserted: (n(previous?.rows_inserted) || 0) + rowsInserted,
      rows_skipped: (n(previous?.rows_skipped) || 0) + rowsSkipped,
      batches_processed: (n(previous?.batches_processed) || 0) + batchesProcessed,
      last_run_mode: "support_sync",
      source_total: sourceRowsTotal,
      clickhouse_total: chTotal,
      parity_status: sourceRowsTotal === chTotal ? "unknown_until_validation" : "needs_validation",
      diagnostics: { ...diagnostics, browser_classification: false, attribution },
    });
    return {
      ok: true,
      source: "clickhouse",
      action: "sync",
      status,
      stopped_reason: stoppedReason,
      rows_scanned: rowsScanned,
      rows_mapped: rowsMapped,
      rows_inserted: rowsInserted,
      rows_skipped: rowsSkipped,
      batches_processed: batchesProcessed,
      cursor_updated_at: cursorUpdatedAt,
      cursor_request_id: cursorRequestId,
      source_total: sourceRowsTotal,
      clickhouse_total: chTotal,
      duration_ms: duration,
      diagnostics: { ...diagnostics, browser_classification: false, attribution },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Support sync failed.";
    const duration = Date.now() - started;
    await upsertSyncState(input.supabase, {
      auth_user_id: input.authUserId,
      status: "failed",
      current_stage: "failed",
      stopped_reason: "support_sync_error",
      cursor_updated_at: cursorUpdatedAt,
      cursor_transaction_id: cursorRequestId,
      finished_at: new Date().toISOString(),
      duration_ms: duration,
      rows_scanned: rowsScanned,
      rows_mapped: rowsMapped,
      rows_inserted: rowsInserted,
      rows_skipped: rowsSkipped,
      batches_processed: batchesProcessed,
      last_error: message,
      source_total: sourceRowsTotal,
      diagnostics: { ...diagnostics, error: message },
    }).catch(() => undefined);
    throw error;
  }
}

export async function runSupportStatus(input: { authUserId: string; supabase: SupabaseLikeClient; clickhouse: ClickHouseClientLike }): Promise<SupportSyncResult> {
  const started = Date.now();
  const [state, sourceRowsTotal, chTotal] = await Promise.all([
    getSyncState(input.supabase, input.authUserId).catch(() => null),
    sourceTotal(input.supabase, input.authUserId).catch(() => 0),
    clickhouseTotal(input.clickhouse, input.authUserId).catch(() => 0),
  ]);
  return {
    ok: true,
    source: "clickhouse",
    action: "status",
    status: s(state?.status) || "never_started",
    stopped_reason: s(state?.stopped_reason) || null,
    rows_scanned: n(state?.rows_scanned),
    rows_mapped: n(state?.rows_mapped),
    rows_inserted: n(state?.rows_inserted),
    rows_skipped: n(state?.rows_skipped),
    batches_processed: n(state?.batches_processed),
    cursor_updated_at: s(state?.cursor_updated_at) || null,
    cursor_request_id: s(state?.cursor_transaction_id) || null,
    source_total: sourceRowsTotal,
    clickhouse_total: chTotal,
    duration_ms: Date.now() - started,
    diagnostics: (state?.diagnostics as Record<string, unknown>) ?? {},
  };
}
