export const SUPPORT_INTENTS = [
  "refund_request",
  "cancel_subscription",
  "payment_problem",
  "access_problem",
  "general_support",
  "unknown",
] as const;

export type SupportIntent = (typeof SUPPORT_INTENTS)[number];

export type SyncSupportSummary = {
  synced: number;
  inserted: number;
  updated: number;
  skipped: number;
  matched_users: number;
  unmatched: number;
  latest_received_at: string | null;
};

export type ParsedMailMessage = {
  uid: string;
  message_id: string;
  normalized_message_id: string | null;
  thread_id: string | null;
  in_reply_to: string | null;
  references: string[];
  from_email: string | null;
  from_name: string | null;
  reply_to_email: string | null;
  to_email: string | null;
  cc_email: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  received_at: string | null;
  internal_date: string | null;
  size: number | null;
  flags: string[];
  has_attachments: boolean;
  attachment_count: number;
  attachment_metadata: Array<{ filename: string | null; mime_type: string | null; size: number | null }>;
  raw_headers: Record<string, string>;
  raw_payload: Record<string, unknown>;
};

export type WarehouseTxn = {
  transaction_id: string;
  user_id: string | null;
  email: string | null;
  event_time: string;
  status: string | null;
  transaction_type: string | null;
  amount_gross: number | null;
  amount_net: number | null;
  amount_refunded: number | null;
  country_code: string | null;
  campaign_path: string | null;
  funnel: string | null;
  campaign_id: string | null;
  normalized_payload: Record<string, unknown> | null;
  raw_payload: Record<string, unknown> | null;
};

export type SupportEnrichment = {
  matched_user_email: string | null;
  matched_user_id: string | null;
  cohort_id: string | null;
  cohort_date: string | null;
  campaign_path: string | null;
  campaign_id: string | null;
  media_buyer: string | null;
  country_code: string | null;
  card_type: string | null;
  subscription_status: string | null;
  refund_status: string | null;
  amount_paid: number | null;
  amount_refunded: number | null;
};

const INTENT_KEYWORDS: Array<{ intent: SupportIntent; keywords: string[] }> = [
  { intent: "refund_request", keywords: ["refund", "money back", "return my money", "chargeback", "refunded", "reimbursement"] },
  { intent: "cancel_subscription", keywords: ["cancel", "unsubscribe", "stop subscription", "cancel my plan", "end subscription"] },
  { intent: "payment_problem", keywords: ["charged", "billing", "payment", "card", "transaction", "declined", "invoice"] },
  { intent: "access_problem", keywords: ["login", "access", "account", "password", "app", "cannot open", "not received"] },
  { intent: "general_support", keywords: ["help", "question", "support"] },
];

// Must match MEDIA_BUYER_BY_UTM_SOURCE in src/services/userMediaBuyer.ts.
const MEDIA_BUYER_BY_UTM_SOURCE: Record<string, string> = {
  "4": "Ivan",
  "19": "Artem A",
  "22": "Artem D",
};

const CARD_TYPE_PATHS = [
  ["card_type"],
  ["paymentInstrumentBinDataAccountFundingType"],
  ["payment_method_details", "card", "funding"],
  ["payment_method", "card_type"],
  ["metadata", "card_type"],
] as const;

export function normalizeSupportEmail(email: string | null | undefined): string {
  return String(email ?? "").trim().toLowerCase();
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  return normalized || null;
}

export function classifySupportIntent(subject: string | null | undefined, body: string | null | undefined): SupportIntent {
  const haystack = `${subject ?? ""}\n${body ?? ""}`.toLowerCase();
  for (const rule of INTENT_KEYWORDS) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) return rule.intent;
  }
  return "unknown";
}

function objectFrom(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function valueAtPath(source: unknown, path: readonly string[]): unknown {
  let current = source;
  for (const segment of path) {
    const object = objectFrom(current);
    if (!(segment in object)) return undefined;
    current = object[segment];
  }
  return current;
}

function stringValue(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dateKey(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function buildCohortId(funnel: string | null | undefined, campaignPath: string | null | undefined, date: string): string {
  return `${String(funnel ?? "").trim() || "unknown"}_${String(campaignPath ?? "").trim() || "unknown"}_${date}`;
}

function userKey(tx: WarehouseTxn): string {
  return stringValue(tx.user_id) ?? normalizeSupportEmail(tx.email) ?? tx.transaction_id;
}

function cardTypeForTx(tx: WarehouseTxn): string | null {
  const sources = [tx.normalized_payload, tx.raw_payload, objectFrom(tx.raw_payload).metadata, objectFrom(tx.normalized_payload).metadata];
  for (const source of sources) {
    for (const path of CARD_TYPE_PATHS) {
      const value = stringValue(valueAtPath(source, path));
      if (!value) continue;
      const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
      if (normalized.includes("prepaid")) return "prepaid";
      if (normalized.includes("debit")) return "debit";
      if (normalized.includes("credit")) return "credit";
      return "other";
    }
  }
  return null;
}

function mediaBuyerForTx(tx: WarehouseTxn): string | null {
  const sources = [tx.normalized_payload, tx.raw_payload, objectFrom(tx.raw_payload).metadata, objectFrom(tx.normalized_payload).metadata];
  for (const source of sources) {
    const utm = stringValue(valueAtPath(source, ["utm_source"]));
    if (utm) return MEDIA_BUYER_BY_UTM_SOURCE[utm] ?? "Unknown";
  }
  return null;
}

function countryForTx(tx: WarehouseTxn): string | null {
  return (
    stringValue(tx.country_code)?.toUpperCase() ??
    stringValue(valueAtPath(tx.normalized_payload, ["ff_country_code"]))?.toUpperCase() ??
    stringValue(valueAtPath(tx.raw_payload, ["ff_country_code"]))?.toUpperCase() ??
    stringValue(valueAtPath(objectFrom(tx.raw_payload).metadata, ["ff_country_code"]))?.toUpperCase() ??
    null
  );
}

export function emptySupportEnrichment(): SupportEnrichment {
  return {
    matched_user_email: null,
    matched_user_id: null,
    cohort_id: null,
    cohort_date: null,
    campaign_path: null,
    campaign_id: null,
    media_buyer: null,
    country_code: null,
    card_type: null,
    subscription_status: null,
    refund_status: null,
    amount_paid: null,
    amount_refunded: null,
  };
}

export function enrichSupportMessage(fromEmail: string | null | undefined, txs: WarehouseTxn[]): SupportEnrichment {
  const normalizedEmail = normalizeSupportEmail(fromEmail);
  if (!normalizedEmail) return emptySupportEnrichment();
  const direct = txs.filter((tx) => normalizeSupportEmail(tx.email) === normalizedEmail || normalizeSupportEmail(stringValue(tx.normalized_payload?.email)) === normalizedEmail);
  if (!direct.length) return emptySupportEnrichment();
  const matchedUserId = userKey(direct[0]);
  const userTxs = txs
    .filter((tx) => userKey(tx) === matchedUserId || normalizeSupportEmail(tx.email) === normalizedEmail || normalizeSupportEmail(stringValue(tx.normalized_payload?.email)) === normalizedEmail)
    .sort((a, b) => (a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0));
  const trial = userTxs.find((tx) => tx.status === "success" && tx.transaction_type === "trial") ?? userTxs.find((tx) => tx.status === "success") ?? userTxs[0];
  const cohortDate = dateKey(stringValue(trial.normalized_payload?.cohort_date) ?? trial.event_time);
  const campaignPath = stringValue(trial.campaign_path) ?? userTxs.map((tx) => stringValue(tx.campaign_path)).find(Boolean) ?? null;
  const campaignId = stringValue(trial.campaign_id) ?? stringValue(trial.normalized_payload?.campaign_id) ?? userTxs.map((tx) => stringValue(tx.campaign_id) ?? stringValue(tx.normalized_payload?.campaign_id)).find(Boolean) ?? null;
  const amountRefunded = userTxs.reduce((sum, tx) => sum + num(tx.amount_refunded), 0);
  const amountPaid = userTxs.filter((tx) => tx.status !== "failed").reduce((sum, tx) => sum + Math.max(0, num(tx.amount_net || tx.amount_gross)), 0);
  const subscriptionStatus = userTxs.some((tx) => tx.status === "success" && ["first_subscription", "renewal_2", "renewal_3", "renewal"].includes(String(tx.transaction_type))) ? "has_subscription" : "no_subscription";
  const refundStatus = amountRefunded > 0 || userTxs.some((tx) => ["refunded", "chargeback"].includes(String(tx.status))) ? "refunded" : "not_refunded";

  return {
    matched_user_email: normalizedEmail,
    matched_user_id: matchedUserId,
    cohort_id: stringValue(trial.normalized_payload?.cohort_id) ?? (cohortDate ? buildCohortId(trial.funnel, campaignPath, cohortDate) : null),
    cohort_date: cohortDate,
    campaign_path: campaignPath,
    campaign_id: campaignId,
    media_buyer: userTxs.map(mediaBuyerForTx).find(Boolean) ?? "Unknown",
    country_code: userTxs.map(countryForTx).find(Boolean) ?? null,
    card_type: userTxs.map(cardTypeForTx).find(Boolean) ?? "unknown",
    subscription_status: subscriptionStatus,
    refund_status: refundStatus,
    amount_paid: round2(amountPaid),
    amount_refunded: round2(amountRefunded),
  };
}

export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const unfolded = raw.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function decodeQuotedPrintable(input: string): string {
  const normalized = input.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i] === "=" && /^[0-9A-Fa-f]{2}$/.test(normalized.slice(i + 1, i + 3))) {
      bytes.push(parseInt(normalized.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(normalized.charCodeAt(i));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeBase64(input: string): string {
  try {
    const binary = atob(input.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    return input;
  }
}

export function decodeMimeWords(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g, (_match, _charset, encoding, text) => {
    if (String(encoding).toUpperCase() === "B") return decodeBase64(text);
    return decodeQuotedPrintable(String(text).replace(/_/g, " "));
  });
}

function decodeBody(content: string, encoding: string | undefined): string {
  const normalized = String(encoding ?? "").toLowerCase();
  if (normalized.includes("base64")) return decodeBase64(content);
  if (normalized.includes("quoted-printable")) return decodeQuotedPrintable(content);
  return content.trim();
}

export function htmlToPlainText(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function parseEmailAddress(value: string | null | undefined): { email: string | null; name: string | null } {
  const decoded = decodeMimeWords(value) ?? "";
  const match = decoded.match(/^(.*?)<([^>]+)>/);
  if (match) {
    return {
      email: normalizeSupportEmail(match[2]) || null,
      name: match[1].replace(/^"|"$/g, "").trim() || null,
    };
  }
  const emailMatch = decoded.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return { email: normalizeSupportEmail(emailMatch?.[0]) || null, name: null };
}

function splitHeaderBody(raw: string): { headerRaw: string; bodyRaw: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const index = normalized.indexOf("\n\n");
  return index === -1
    ? { headerRaw: normalized, bodyRaw: "" }
    : { headerRaw: normalized.slice(0, index), bodyRaw: normalized.slice(index + 2) };
}

function attachmentName(headers: Record<string, string>): string | null {
  const source = `${headers["content-disposition"] ?? ""}; ${headers["content-type"] ?? ""}`;
  return decodeMimeWords(source.match(/(?:filename|name)\*?=(?:"([^"]+)"|([^;]+))/i)?.[1] ?? source.match(/(?:filename|name)\*?=(?:"([^"]+)"|([^;]+))/i)?.[2])?.trim() ?? null;
}

function parseBodies(headerRaw: string, bodyRaw: string): {
  text: string | null;
  html: string | null;
  attachments: Array<{ filename: string | null; mime_type: string | null; size: number | null }>;
} {
  const headers = parseHeaders(headerRaw);
  const contentType = headers["content-type"] ?? "";
  const encoding = headers["content-transfer-encoding"];
  const boundary = contentType.match(/boundary="?([^";]+)"?/i)?.[1];
  if (!boundary) {
    const body = decodeBody(bodyRaw, encoding);
    return contentType.toLowerCase().includes("text/html")
      ? { text: null, html: body, attachments: [] }
      : { text: body || null, html: null, attachments: [] };
  }

  let text: string | null = null;
  let html: string | null = null;
  const attachments: Array<{ filename: string | null; mime_type: string | null; size: number | null }> = [];
  const parts = bodyRaw.split(`--${boundary}`);
  for (const part of parts) {
    const trimmed = part.replace(/^--/, "").trim();
    if (!trimmed) continue;
    const split = splitHeaderBody(trimmed);
    const partHeaders = parseHeaders(split.headerRaw);
    const partType = (partHeaders["content-type"] ?? "").toLowerCase();
    const disposition = (partHeaders["content-disposition"] ?? "").toLowerCase();
    if (disposition.includes("attachment") || /;\s*name=/i.test(partHeaders["content-type"] ?? "")) {
      attachments.push({
        filename: attachmentName(partHeaders),
        mime_type: partType.split(";")[0]?.trim() || null,
        size: split.bodyRaw.length || null,
      });
      continue;
    }
    const decoded = decodeBody(split.bodyRaw, partHeaders["content-transfer-encoding"]);
    if (!text && partType.includes("text/plain")) text = decoded || null;
    if (!html && partType.includes("text/html")) html = decoded || null;
  }
  return { text, html, attachments };
}

export function parseRawEmail(raw: string, uid: string, meta: Partial<Pick<ParsedMailMessage, "internal_date" | "size" | "flags">> = {}): ParsedMailMessage {
  const { headerRaw, bodyRaw } = splitHeaderBody(raw);
  const headers = parseHeaders(headerRaw);
  const from = parseEmailAddress(headers.from);
  const replyTo = parseEmailAddress(headers["reply-to"]);
  const to = parseEmailAddress(headers.to);
  const cc = parseEmailAddress(headers.cc);
  const bodies = parseBodies(headerRaw, bodyRaw);
  const receivedAt = headers.date ? new Date(headers.date) : null;
  const messageId = headers["message-id"] || `imap:${uid}`;
  const normalizedMessageId = normalizeMessageId(messageId);
  const references = (headers.references ?? "").split(/\s+/).map(normalizeMessageId).filter((value): value is string => Boolean(value));
  const inReplyTo = normalizeMessageId(headers["in-reply-to"]);
  const safeText = bodies.text?.trim() || htmlToPlainText(bodies.html);

  return {
    uid,
    message_id: messageId,
    normalized_message_id: normalizedMessageId,
    thread_id: inReplyTo || references[0] || normalizedMessageId,
    in_reply_to: inReplyTo,
    references,
    from_email: from.email,
    from_name: from.name,
    reply_to_email: replyTo.email,
    to_email: to.email,
    cc_email: cc.email,
    subject: decodeMimeWords(headers.subject),
    body_text: safeText || null,
    body_html: bodies.html,
    received_at: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt.toISOString() : null,
    internal_date: meta.internal_date ?? null,
    size: meta.size ?? raw.length,
    flags: meta.flags ?? [],
    has_attachments: bodies.attachments.length > 0,
    attachment_count: bodies.attachments.length,
    attachment_metadata: bodies.attachments,
    raw_headers: headers,
    raw_payload: { uid, content_type: headers["content-type"] ?? null, size: meta.size ?? raw.length },
  };
}

export function extractEmailLiterals(fetchResponse: string): string[] {
  const literals: string[] = [];
  let cursor = 0;
  const pattern = /\{(\d+)\}\r?\n/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(fetchResponse)) !== null) {
    const length = Number(match[1]);
    const start = match.index + match[0].length;
    literals.push(fetchResponse.slice(start, start + length));
    cursor = start + length;
    pattern.lastIndex = cursor;
  }
  return literals;
}
