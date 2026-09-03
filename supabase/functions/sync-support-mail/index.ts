/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createClickHouseClient } from "../_shared/clickhouse/client.ts";
import { runSupportSync } from "../_shared/clickhouse/support.ts";
import { classifySupportRequestServer } from "../_shared/clickhouse/support.ts";
import { runReplyMatching } from "../_shared/clickhouse/supportReplyMatching.ts";
import type { SupabaseLikeClient } from "../_shared/clickhouse/types.ts";
import {
  extractEmailLiterals,
  htmlToPlainText,
  normalizeMessageId,
  normalizeSupportEmail,
  parseRawEmail,
  type ParsedMailMessage,
} from "./support.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-support-mail-internal-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PROVIDER = "spacemail";
const DEFAULT_FOLDER = "INBOX";
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_BATCHES = 3;
const MAX_MESSAGES_PER_INVOCATION = 150;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const RUNNING_TTL_MS = 15 * 60 * 1000;

type SupabaseClient = ReturnType<typeof createClient>;
type MailAction =
  | "test_connection"
  | "status"
  | "list_folders"
  | "initial_sync"
  | "continue_sync"
  | "sync_new"
  | "stop"
  | "reset_cursor"
  | "sent_initial_sync"
  | "sent_continue_sync"
  | "sent_sync_new"
  | "rematch_replies";

type SyncStatus =
  | "idle"
  | "connecting"
  | "discovering"
  | "syncing"
  | "partial"
  | "completed"
  | "failed"
  | "stopped"
  | "credentials_error"
  | "cursor_invalidated";

type MailSyncState = {
  id?: string;
  auth_user_id: string;
  mailbox_key: string;
  provider: string;
  host: string;
  username: string;
  folder: string;
  status: SyncStatus;
  sync_mode?: string | null;
  uid_validity?: string | null;
  last_seen_uid?: number | null;
  highest_modseq?: string | null;
  mailbox_messages?: number | null;
  mailbox_uid_next?: number | null;
  history_first_uid?: number | null;
  history_last_uid?: number | null;
  history_total_messages?: number | null;
  history_imported_messages?: number | null;
  history_remaining_messages?: number | null;
  history_completed_at?: string | null;
  current_uid?: number | null;
  last_imported_uid?: number | null;
  current_batch_total?: number | null;
  current_batch_processed?: number | null;
  current_batch_started_at?: string | null;
  last_batch_duration_ms?: number | null;
  last_batch_messages_per_second?: number | null;
  last_sync_imported?: number | null;
  last_sync_new_messages?: number | null;
  messages_discovered?: number | null;
  messages_processed?: number | null;
  messages_inserted?: number | null;
  messages_updated?: number | null;
  messages_skipped?: number | null;
  messages_failed?: number | null;
  current_batch?: number | null;
  started_at?: string | null;
  completed_at?: string | null;
  last_success_at?: string | null;
  last_error_code?: string | null;
  last_error_message_sanitized?: string | null;
  updated_at?: string | null;
};

class SupportMailError extends Error {
  constructor(readonly code: string, message: string, readonly status = 500) {
    super(message);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function bearerToken(req: Request): string {
  return (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
}

function s(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boolEnv(value: string | undefined | null): boolean {
  return String(value ?? "").trim().toLowerCase() === "true";
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeError(error: unknown): { code: string; message: string; status: number } {
  if (error instanceof SupportMailError) return { code: error.code, message: error.message, status: error.status };
  const raw = error instanceof Error ? error.message : "Support mail sync failed.";
  const message = raw
    .replace(/LOGIN\s+"[^"]+"\s+"[^"]+"/gi, "LOGIN <redacted>")
    .replace(/password=[^\s&]+/gi, "password=<redacted>")
    .slice(0, 500);
  return { code: "SUPPORT_MAIL_SYNC_FAILED", message, status: 500 };
}

function dbErrorMessage(prefix: string, error: { code?: string; message?: string } | null | undefined): string {
  const code = error?.code ? ` (${error.code})` : "";
  const constraint = error?.message?.match(/constraint "([^"]+)"/i)?.[1];
  const column = error?.message?.match(/column "([^"]+)"/i)?.[1];
  const target = constraint ?? column;
  return `${prefix}${code}${target ? `: ${target}` : "."}`;
}

function requireSecret(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new SupportMailError("CONFIG_MISSING", `${name} is not configured.`, 503);
  return value;
}

function mailConfig() {
  const host = requireSecret("SPACEMAIL_IMAP_HOST");
  const port = Number(requireSecret("SPACEMAIL_IMAP_PORT"));
  const secure = boolEnv(requireSecret("SPACEMAIL_IMAP_SECURE"));
  const username = requireSecret("SPACEMAIL_IMAP_USERNAME");
  const password = requireSecret("SPACEMAIL_IMAP_PASSWORD");
  if (!Number.isInteger(port) || port <= 0) throw new SupportMailError("CONFIG_INVALID", "SPACEMAIL_IMAP_PORT is invalid.", 503);
  if (!secure) throw new SupportMailError("CONFIG_INVALID", "SPACEMAIL_IMAP_SECURE must be true for SpaceMail.", 503);
  return {
    provider: PROVIDER,
    host,
    port,
    secure,
    username,
    password,
    mailbox_key: `${PROVIDER}:${username.toLowerCase()}`,
    folder: Deno.env.get("SPACEMAIL_IMAP_FOLDER")?.trim() || DEFAULT_FOLDER,
  };
}

function configStatus() {
  const host = Deno.env.get("SPACEMAIL_IMAP_HOST")?.trim() || "mail.spacemail.com";
  const username = Deno.env.get("SPACEMAIL_IMAP_USERNAME")?.trim() || "support@azora-astro.com";
  return {
    provider: PROVIDER,
    host,
    port: Number(Deno.env.get("SPACEMAIL_IMAP_PORT")?.trim() || "993"),
    secure: boolEnv(Deno.env.get("SPACEMAIL_IMAP_SECURE") ?? "true"),
    username,
    mailbox_key: `${PROVIDER}:${username.toLowerCase()}`,
    folder: Deno.env.get("SPACEMAIL_IMAP_FOLDER")?.trim() || DEFAULT_FOLDER,
    configured: {
      host: Boolean(Deno.env.get("SPACEMAIL_IMAP_HOST")?.trim()),
      port: Boolean(Deno.env.get("SPACEMAIL_IMAP_PORT")?.trim()),
      secure: Boolean(Deno.env.get("SPACEMAIL_IMAP_SECURE")?.trim()),
      username: Boolean(Deno.env.get("SPACEMAIL_IMAP_USERNAME")?.trim()),
      password: Boolean(Deno.env.get("SPACEMAIL_IMAP_PASSWORD")?.trim()),
    },
  };
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function imapDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new SupportMailError("INVALID_DATE", "Invalid sync start date.", 400);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, code: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new SupportMailError(code, "IMAP request timed out.", 504)), ms);
      }),
    ]);
  } finally {
    if (timeout != null) clearTimeout(timeout);
  }
}

class ImapConnection {
  private conn: Deno.TlsConn | null = null;
  private counter = 0;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(private readonly host: string, private readonly port: number) {}

  async connect() {
    try {
      this.conn = await withTimeout(Deno.connectTls({ hostname: this.host, port: this.port }), 10_000, "IMAP_TLS_FAILED");
      const greeting = await this.readUntil(/\r?\n/, 10_000);
      if (!/\*\s+OK/i.test(greeting)) throw new SupportMailError("IMAP_CONNECTION_FAILED", "IMAP server did not return an OK greeting.", 502);
    } catch (error) {
      if (error instanceof SupportMailError) throw error;
      throw new SupportMailError("IMAP_CONNECTION_FAILED", "Could not connect to IMAP server.", 502);
    }
  }

  async login(username: string, password: string) {
    try {
      await this.command(`LOGIN ${quoteImap(username)} ${quoteImap(password)}`, "IMAP_AUTH_FAILED");
    } catch (error) {
      if (error instanceof SupportMailError) throw error;
      throw new SupportMailError("IMAP_AUTH_FAILED", "IMAP authentication failed.", 401);
    }
  }

  async listFolders(): Promise<string[]> {
    const response = await this.command(`LIST "" "*"`, "IMAP_CONNECTION_FAILED");
    return response
      .split(/\r?\n/)
      .map((line) => line.match(/\* LIST .* "([^"]+)"$/)?.[1] ?? line.match(/\* LIST .* ([^\\s]+)$/)?.[1])
      .filter((value): value is string => Boolean(value))
      .filter((value) => !/spam|trash|draft|sent/i.test(value));
  }

  /** The Sent mailbox: prefer the \Sent special-use attribute, fall back to a
   * name match on the UNFILTERED list (listFolders hides Sent on purpose —
   * request folders must never be picked from it). */
  async findSentFolder(): Promise<string | null> {
    const response = await this.command(`LIST "" "*"`, "IMAP_CONNECTION_FAILED");
    const lines = response.split(/\r?\n/).filter((line) => /^\* LIST /i.test(line));
    const nameOf = (line: string) => line.match(/\* LIST .* "([^"]+)"$/)?.[1] ?? line.match(/\* LIST .* ([^\s]+)$/)?.[1] ?? null;
    const bySpecialUse = lines.find((line) => /\(\s*[^)]*\\Sent[^)]*\)/i.test(line));
    if (bySpecialUse) return nameOf(bySpecialUse);
    const byName = lines.map(nameOf).filter((value): value is string => Boolean(value)).find((value) => /sent/i.test(value));
    return byName ?? null;
  }

  /** One UID FETCH over a range, flags only — no bodies. Used to refresh the
   * frozen \Answered flags of already-imported INBOX mail. */
  async fetchFlagsRange(fromUid: number, toUid: number | "*"): Promise<Map<number, string[]>> {
    const response = await this.command(`UID FETCH ${fromUid}:${toUid} (UID FLAGS)`, "IMAP_PARSE_FAILED", 25_000);
    const out = new Map<number, string[]>();
    for (const line of response.split(/\r?\n/)) {
      const uid = Number(line.match(/UID (\d+)/i)?.[1] ?? 0);
      const flagsRaw = line.match(/FLAGS \(([^)]*)\)/i)?.[1];
      if (!uid || flagsRaw === undefined) continue;
      out.set(uid, flagsRaw.split(/\s+/).map((value) => value.replace(/^\\/, "")).filter(Boolean));
    }
    return out;
  }

  /** Headers only, regardless of size — Sent-folder ingestion never needs
   * bodies and this keeps the retrospective backfill ~50x cheaper. */
  async fetchHeader(uid: number): Promise<{ raw: string | null; internalDate: string | null; flags: string[]; size: number | null }> {
    const meta = await this.command(`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE)`, "IMAP_PARSE_FAILED", 15_000);
    const internal = meta.match(/INTERNALDATE "([^"]+)"/i)?.[1] ?? null;
    const flags = (meta.match(/FLAGS \(([^)]*)\)/i)?.[1] ?? "").split(/\s+/).map((value) => value.replace(/^\\/, "")).filter(Boolean);
    const size = Number(meta.match(/RFC822\.SIZE\s+(\d+)/i)?.[1] ?? 0);
    const response = await this.command(`UID FETCH ${uid} (BODY.PEEK[HEADER])`, "IMAP_PARSE_FAILED", 20_000);
    return {
      raw: extractEmailLiterals(response)[0] ?? null,
      internalDate: internal ? new Date(internal).toISOString() : null,
      flags,
      size: Number.isFinite(size) && size > 0 ? size : null,
    };
  }

  async select(folder: string): Promise<{ uidValidity: string | null; highestModseq: string | null }> {
    const response = await this.command(`SELECT ${quoteImap(folder)}`, "IMAP_FOLDER_NOT_FOUND");
    return {
      uidValidity: response.match(/UIDVALIDITY\s+([^\]\s]+)/i)?.[1] ?? null,
      highestModseq: response.match(/HIGHESTMODSEQ\s+([^\]\s]+)/i)?.[1] ?? null,
    };
  }

  async status(folder: string) {
    const response = await this.command(`STATUS ${quoteImap(folder)} (MESSAGES UIDNEXT UIDVALIDITY HIGHESTMODSEQ)`, "IMAP_FOLDER_NOT_FOUND");
    const body = response.match(/\* STATUS[^(]*\(([^)]*)\)/i)?.[1] ?? "";
    const value = (key: string) => body.match(new RegExp(`${key}\\s+([^\\s]+)`, "i"))?.[1] ?? null;
    return {
      messages: n(value("MESSAGES")),
      uidNext: n(value("UIDNEXT")),
      uidValidity: value("UIDVALIDITY"),
      highestModseq: value("HIGHESTMODSEQ"),
    };
  }

  async searchAll(since: string | null = null): Promise<number[]> {
    const query = since ? `SINCE ${imapDate(since)}` : "ALL";
    const response = await this.command(`UID SEARCH ${query}`, "IMAP_CONNECTION_FAILED");
    return this.parseSearchResponse(response);
  }

  async searchNewerThan(lastSeenUid: number | null): Promise<number[]> {
    if (!lastSeenUid) return this.searchAll();
    const response = await this.command(`UID SEARCH UID ${lastSeenUid + 1}:*`, "IMAP_CONNECTION_FAILED");
    return this.parseSearchResponse(response).filter((uid) => uid > lastSeenUid);
  }

  private parseSearchResponse(response: string): number[] {
    const match = response.match(/\* SEARCH\s+([0-9\s]*)/i);
    return (match?.[1] ?? "")
      .trim()
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
      .sort((a, b) => a - b);
  }

  async fetchRaw(uid: number): Promise<{ raw: string | null; internalDate: string | null; flags: string[]; size: number | null }> {
    const meta = await this.command(`UID FETCH ${uid} (UID FLAGS INTERNALDATE RFC822.SIZE)`, "IMAP_PARSE_FAILED", 15_000);
    const internal = meta.match(/INTERNALDATE "([^"]+)"/i)?.[1] ?? null;
    const flags = (meta.match(/FLAGS \(([^)]*)\)/i)?.[1] ?? "").split(/\s+/).map((value) => value.replace(/^\\/, "")).filter(Boolean);
    const size = Number(meta.match(/RFC822\.SIZE\s+(\d+)/i)?.[1] ?? 0);
    const section = Number.isFinite(size) && size > MAX_MESSAGE_BYTES ? "BODY.PEEK[HEADER]" : "BODY.PEEK[]";
    const response = await this.command(`UID FETCH ${uid} (${section})`, "IMAP_PARSE_FAILED", 25_000);
    const raw = extractEmailLiterals(response)[0] ?? null;
    const safeRaw = section === "BODY.PEEK[HEADER]" && raw
      ? `${raw}\r\n\r\nMessage body omitted because the raw email exceeds ${MAX_MESSAGE_BYTES} bytes.`
      : raw;
    return {
      raw: safeRaw,
      internalDate: internal ? new Date(internal).toISOString() : null,
      flags,
      size: Number.isFinite(size) && size > 0 ? size : null,
    };
  }

  async logout() {
    try {
      if (this.conn) await this.command("LOGOUT", "IMAP_CONNECTION_FAILED", 5_000);
    } catch {
      // Best effort cleanup. Never return protocol transcripts.
    }
    try {
      this.conn?.close();
    } catch {
      // Ignore close failures.
    }
    this.conn = null;
  }

  private async command(command: string, errorCode: string, timeoutMs = 15_000): Promise<string> {
    if (!this.conn) throw new SupportMailError("IMAP_CONNECTION_FAILED", "IMAP connection is not open.", 502);
    const tag = `A${String(++this.counter).padStart(4, "0")}`;
    await this.conn.write(this.encoder.encode(`${tag} ${command}\r\n`));
    const taggedResponse = new RegExp(`(^|\\r?\\n)${tag} (OK|NO|BAD)`, "i");
    const response = await this.readUntil(taggedResponse, timeoutMs);
    if (!new RegExp(`(^|\\r?\\n)${tag} OK`, "i").test(response)) {
      if (command.startsWith("LOGIN")) throw new SupportMailError("IMAP_AUTH_FAILED", "IMAP authentication failed.", 401);
      if (command.startsWith("SELECT") || command.startsWith("STATUS")) throw new SupportMailError("IMAP_FOLDER_NOT_FOUND", "IMAP folder was not found.", 404);
      throw new SupportMailError(errorCode, "IMAP command failed.", 502);
    }
    return response;
  }

  private async readUntil(pattern: RegExp, timeoutMs: number): Promise<string> {
    if (!this.conn) throw new SupportMailError("IMAP_CONNECTION_FAILED", "IMAP connection is not open.", 502);
    const chunks: string[] = [];
    const buffer = new Uint8Array(64 * 1024);
    return await withTimeout((async () => {
      for (;;) {
        const read = await this.conn!.read(buffer);
        if (read == null) break;
        chunks.push(this.decoder.decode(buffer.slice(0, read), { stream: true }));
        const text = chunks.join("");
        if (pattern.test(text)) return text;
      }
      return chunks.join("");
    })(), timeoutMs, "IMAP_TIMEOUT");
  }
}

async function authenticatedUser(req: Request): Promise<{ authUserId: string; supabase: SupabaseClient }> {
  const supabaseUrl = requireSecret("SUPABASE_URL");
  const serviceRoleKey = requireSecret("SUPABASE_SERVICE_ROLE_KEY");
  const token = bearerToken(req);
  if (!token) throw new SupportMailError("AUTH_REQUIRED", "Authentication required.", 401);
  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user?.id) throw new SupportMailError("AUTH_INVALID", "Invalid or expired session.", 401);
  return { authUserId: data.user.id, supabase };
}

function serviceClient(): SupabaseClient {
  return createClient(requireSecret("SUPABASE_URL"), requireSecret("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function normalizeAction(value: unknown): MailAction {
  switch (value) {
    case "test_connection":
    case "status":
    case "list_folders":
    case "initial_sync":
    case "continue_sync":
    case "sync_new":
    case "stop":
    case "reset_cursor":
    case "sent_initial_sync":
    case "sent_continue_sync":
    case "sent_sync_new":
    case "rematch_replies":
      return value;
    case undefined:
    case null:
      return "sync_new";
    default:
      throw new SupportMailError("UNSUPPORTED_ACTION", `Unsupported support mail action: ${s(value)}`, 400);
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text().catch(() => "");
  if (!text.trim()) return {};
  const parsed = JSON.parse(text) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function stateFor(client: SupabaseClient, authUserId: string, cfg = configStatus()): Promise<MailSyncState | null> {
  const { data, error } = await client
    .from("support_mail_sync_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("mailbox_key", cfg.mailbox_key)
    .eq("folder", cfg.folder)
    .maybeSingle();
  if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not read support mail sync state.", 500);
  return data as MailSyncState | null;
}

async function upsertState(client: SupabaseClient, authUserId: string, patch: Partial<MailSyncState>, cfg = configStatus()): Promise<MailSyncState> {
  const row = {
    auth_user_id: authUserId,
    mailbox_key: cfg.mailbox_key,
    provider: PROVIDER,
    host: cfg.host,
    username: cfg.username,
    folder: cfg.folder,
    ...patch,
    updated_at: nowIso(),
  };
  const { data, error } = await client
    .from("support_mail_sync_state")
    .upsert(row, { onConflict: "auth_user_id,mailbox_key,folder" })
    .select("*")
    .single();
  if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not update support mail sync state.", 500);
  return data as MailSyncState;
}

function isRunning(state: MailSyncState | null): boolean {
  if (!state || !["connecting", "discovering", "syncing"].includes(state.status)) return false;
  const started = state.started_at ? new Date(state.started_at).getTime() : 0;
  return started > 0 && Date.now() - started < RUNNING_TTL_MS;
}

async function withConnection<T>(work: (imap: ImapConnection, cfg: ReturnType<typeof mailConfig>) => Promise<T>): Promise<T> {
  const cfg = mailConfig();
  const imap = new ImapConnection(cfg.host, cfg.port);
  try {
    await imap.connect();
    await imap.login(cfg.username, cfg.password);
    return await work(imap, cfg);
  } finally {
    await imap.logout();
  }
}

function dateKey(value: string | null | undefined): string {
  const date = value ? new Date(value) : new Date(0);
  return Number.isNaN(date.getTime()) ? "1970-01-01" : date.toISOString().slice(0, 10);
}

function normalizeForFingerprint(value: string | null | undefined): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `h${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function contentFingerprint(message: ParsedMailMessage, identity?: string): string {
  return fnv1a([
    identity ?? "",
    normalizeForFingerprint(message.from_name || message.from_email),
    normalizeForFingerprint(message.subject),
    normalizeForFingerprint(message.body_text || htmlToPlainText(message.body_html)),
    dateKey(message.received_at || message.internal_date),
    normalizeSupportEmail(message.from_email),
  ].join("\u001f"));
}

function supportRow(input: {
  authUserId: string;
  batchId: string;
  cfg: ReturnType<typeof configStatus>;
  uidValidity: string;
  message: ParsedMailMessage;
  ordinal: number;
}) {
  const body = (input.message.body_text || htmlToPlainText(input.message.body_html)).slice(0, 100_000);
  const received = input.message.received_at || input.message.internal_date || nowIso();
  const normalizedEmail = normalizeSupportEmail(input.message.from_email) || null;
  const classification = classifySupportRequestServer(input.message.subject ?? "", body);
  const classificationVersion = s((classification as Record<string, unknown>).classification_version) || "support_rules_v1";
  const imapIdentity = [input.cfg.mailbox_key, input.cfg.folder, input.uidValidity, input.message.uid].join("\u001f");
  return {
    auth_user_id: input.authUserId,
    import_batch_id: input.batchId,
    source_type: "imap",
    source_row_number: input.ordinal,
    sender_name: input.message.from_name || input.message.from_email || "",
    subject: input.message.subject || "",
    message_body: body,
    received_at: received,
    received_date_raw: input.message.received_at || input.message.internal_date || "",
    customer_email: input.message.from_email || "",
    normalized_email: normalizedEmail,
    matched_contact_name: normalizedEmail ?? "",
    matched_customer: Boolean(normalizedEmail),
    category: classification.category,
    subcategory: classification.subcategory,
    language: classification.language,
    sentiment: classification.sentiment,
    urgency: classification.urgency,
    requires_refund: classification.requires_refund,
    requires_cancellation: classification.requires_cancellation,
    payment_related: classification.payment_related,
    delivery_related: classification.delivery_related,
    possible_unauthorized_charge: classification.possible_unauthorized_charge,
    duplicate_charge: classification.duplicate_charge,
    urgent: classification.urgent,
    classification_source: "rule",
    classification_version: classificationVersion,
    classification_confidence: classification.classification_confidence,
    classification_reason: classification.classification_reason,
    source_hash: contentFingerprint(input.message, imapIdentity),
    mailbox_key: input.cfg.mailbox_key,
    imap_folder: input.cfg.folder,
    imap_uid_validity: input.uidValidity,
    imap_uid: Number(input.message.uid),
    message_id: input.message.message_id,
    normalized_message_id: input.message.normalized_message_id,
    in_reply_to: input.message.in_reply_to,
    references_json: input.message.references,
    internal_date: input.message.internal_date,
    has_attachments: input.message.has_attachments,
    attachment_count: input.message.attachment_count,
    attachment_metadata: input.message.attachment_metadata,
    raw_size_bytes: input.message.size,
    imap_flags: input.message.flags,
  };
}

async function createImportBatch(client: SupabaseClient, authUserId: string, cfg: ReturnType<typeof configStatus>, mode: string) {
  const label = `${cfg.username}/${cfg.folder}/${mode}/${new Date().toISOString()}`;
  const { data, error } = await client
    .from("support_import_batches")
    .insert({
      auth_user_id: authUserId,
      filename: label,
      source_type: "imap",
      source_label: label,
      checksum: fnv1a(label),
      import_year: new Date().getUTCFullYear(),
      status: "pending",
      diagnostics: { provider: PROVIDER, mailbox_key: cfg.mailbox_key, folder: cfg.folder, mode },
    })
    .select("id")
    .single();
  if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not create support import batch.", 500);
  return String(data.id);
}

async function existingDedupKeys(client: SupabaseClient, authUserId: string, hashes: string[], messageIds: string[]) {
  const existingHashes = new Set<string>();
  const existingMessageIds = new Set<string>();
  if (hashes.length) {
    const { data, error } = await client
      .from("support_requests")
      .select("source_hash")
      .eq("auth_user_id", authUserId)
      .in("source_hash", hashes);
    if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not check duplicate support requests.", 500);
    (data ?? []).forEach((row) => existingHashes.add(String(row.source_hash)));
  }
  if (messageIds.length) {
    const { data, error } = await client
      .from("support_requests")
      .select("normalized_message_id")
      .eq("auth_user_id", authUserId)
      .in("normalized_message_id", messageIds);
    if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not check duplicate message IDs.", 500);
    (data ?? []).forEach((row) => existingMessageIds.add(String(row.normalized_message_id)));
  }
  return { existingHashes, existingMessageIds };
}

async function insertSupportRows(client: SupabaseClient, authUserId: string, rows: Array<Record<string, unknown>>) {
  if (!rows.length) return { inserted: 0, skipped: 0 };
  const hashes = rows.map((row) => String(row.source_hash));
  const messageIds = rows.map((row) => s(row.normalized_message_id)).filter(Boolean);
  const { existingHashes, existingMessageIds } = await existingDedupKeys(client, authUserId, hashes, messageIds);
  const seenHashes = new Set<string>();
  const seenMessageIds = new Set<string>();
  const insertRows = rows.filter((row) => {
    const hash = String(row.source_hash);
    if (existingHashes.has(hash) || seenHashes.has(hash)) return false;
    seenHashes.add(hash);
    const messageId = s(row.normalized_message_id);
    if (messageId && (existingMessageIds.has(messageId) || seenMessageIds.has(messageId))) {
      row.normalized_message_id = null;
    } else if (messageId) {
      seenMessageIds.add(messageId);
    }
    return true;
  });
  if (insertRows.length) {
    const { error } = await client.from("support_requests").insert(insertRows);
    if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", dbErrorMessage("Could not insert support requests", error), 500);
  }
  return { inserted: insertRows.length, skipped: rows.length - insertRows.length };
}

async function updateImportBatch(client: SupabaseClient, batchId: string, patch: Record<string, unknown>) {
  const { error } = await client.from("support_import_batches").update(patch).eq("id", batchId);
  if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not update support import batch.", 500);
}

async function importedUidSet(input: {
  client: SupabaseClient;
  authUserId: string;
  cfg: ReturnType<typeof configStatus>;
  uidValidity: string;
  minUid?: number | null;
  maxUid?: number | null;
}): Promise<Set<number>> {
  let query = input.client
    .from("support_requests")
    .select("imap_uid")
    .eq("auth_user_id", input.authUserId)
    .eq("source_type", "imap")
    .eq("mailbox_key", input.cfg.mailbox_key)
    .eq("imap_folder", input.cfg.folder)
    .eq("imap_uid_validity", input.uidValidity)
    .not("imap_uid", "is", null);
  if (input.minUid != null) query = query.gte("imap_uid", input.minUid);
  if (input.maxUid != null) query = query.lte("imap_uid", input.maxUid);
  const { data, error } = await query;
  if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not read imported support mail UIDs.", 500);
  return new Set((data ?? []).map((row) => n(row.imap_uid)).filter((uid) => uid > 0));
}

function pctSpeed(processed: number, startedAt: number): number {
  const elapsedSeconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
  return Math.round((processed / elapsedSeconds) * 100) / 100;
}

async function syncClickHouse(input: { authUserId: string; supabase: SupabaseClient }) {
  const clickhouse = createClickHouseClient();
  try {
    return await runSupportSync({
      authUserId: input.authUserId,
      supabase: input.supabase,
      clickhouse,
      request: { action: "sync", sync: { batch_size: 2000, max_batches: 20, full_reset_cursor: false } },
    });
  } finally {
    await clickhouse.close?.().catch(() => undefined);
  }
}

function boundedSyncParams(body: Record<string, unknown>) {
  const requestedBatch = Math.max(1, Math.floor(n(body.batch_size) || DEFAULT_BATCH_SIZE));
  const requestedBatches = Math.max(1, Math.floor(n(body.max_batches_per_invocation) || n(body.max_batches) || DEFAULT_MAX_BATCHES));
  const batchSize = Math.min(DEFAULT_BATCH_SIZE, requestedBatch);
  const maxBatches = Math.min(DEFAULT_MAX_BATCHES, requestedBatches);
  return {
    batchSize,
    maxBatches,
    maxMessages: Math.min(MAX_MESSAGES_PER_INVOCATION, batchSize * maxBatches),
    since: s(body.date_from || body.since) || null,
    dryRun: body.dry_run === true,
  };
}

async function runMailSync(input: {
  action: Extract<MailAction, "initial_sync" | "continue_sync" | "sync_new">;
  authUserId: string;
  supabase: SupabaseClient;
  body: Record<string, unknown>;
}) {
  const cfg = configStatus();
  const existingState = await stateFor(input.supabase, input.authUserId, cfg);
  if (isRunning(existingState)) {
    return { ok: false, action: input.action, status: "already_running", error_code: "ALREADY_RUNNING", state: existingState };
  }

  const params = boundedSyncParams(input.body);
  const started = nowIso();
  const startedMs = Date.now();
  let activeBatchId: string | null = null;
  let activeBatchFinalized = false;
  await upsertState(input.supabase, input.authUserId, {
    status: "connecting",
    sync_mode: input.action,
    started_at: started,
    completed_at: null,
    last_error_code: null,
    last_error_message_sanitized: null,
    messages_discovered: 0,
    messages_processed: 0,
    messages_inserted: 0,
    messages_updated: 0,
    messages_skipped: 0,
    messages_failed: 0,
    current_batch: 0,
    current_batch_total: 0,
    current_batch_processed: 0,
    current_uid: null,
    last_sync_imported: 0,
    last_sync_new_messages: 0,
  }, cfg);

  try {
    const result = await withConnection(async (imap, secretCfg) => {
      await upsertState(input.supabase, input.authUserId, { status: "discovering" }, cfg);
      const selected = await imap.select(cfg.folder);
      const inbox = await imap.status(cfg.folder);
      const uidValidity = selected.uidValidity ?? "unknown";
      if (existingState?.uid_validity && existingState.uid_validity !== uidValidity && input.action !== "initial_sync") {
        await upsertState(input.supabase, input.authUserId, {
          status: "cursor_invalidated",
          uid_validity: uidValidity,
          last_error_code: "IMAP_UIDVALIDITY_CHANGED",
          last_error_message_sanitized: "IMAP UIDVALIDITY changed. Run a controlled initial sync to rediscover messages.",
          completed_at: nowIso(),
        }, cfg);
        throw new SupportMailError("IMAP_UIDVALIDITY_CHANGED", "IMAP UIDVALIDITY changed. Run initial sync.", 409);
      }
      const allHistoryUids = input.action === "sync_new" ? [] : await imap.searchAll(params.since);
      const historyFirstUid = allHistoryUids[0] ?? existingState?.history_first_uid ?? null;
      const historyLastUid = allHistoryUids.at(-1) ?? existingState?.history_last_uid ?? existingState?.last_seen_uid ?? null;
      const historyTotal = input.action === "sync_new"
        ? n(existingState?.history_total_messages)
        : allHistoryUids.length;
      const currentBatchTotal = Math.max(1, Math.ceil((historyTotal || params.maxMessages) / params.batchSize));

      let importedSet = new Set<number>();
      let importedBefore = n(existingState?.history_imported_messages);
      let missingHistoryUids: number[] = [];
      if (input.action !== "sync_new") {
        importedSet = await importedUidSet({
          client: input.supabase,
          authUserId: input.authUserId,
          cfg,
          uidValidity,
          minUid: historyFirstUid,
          maxUid: historyLastUid,
        });
        importedBefore = allHistoryUids.filter((uid) => importedSet.has(uid)).length;
        missingHistoryUids = allHistoryUids.filter((uid) => !importedSet.has(uid));
      }

      const historyComplete = input.action !== "sync_new" && historyTotal > 0 && missingHistoryUids.length === 0;
      const knownHistoryComplete = Boolean(existingState?.history_completed_at) || historyComplete;
      if (input.action === "sync_new" && !knownHistoryComplete) {
        throw new SupportMailError("HISTORY_IMPORT_REQUIRED", "Finish the initial Support mailbox import before syncing new mail.", 409);
      }

      const candidateUids = input.action === "sync_new"
        ? (await imap.searchNewerThan(existingState?.last_seen_uid ?? existingState?.history_last_uid ?? null))
        : missingHistoryUids;
      const selectedUids = candidateUids.slice(0, params.maxMessages);
      const discovered = input.action === "sync_new" ? candidateUids.length : historyTotal;
      const newMessages = input.action === "sync_new" ? candidateUids.length : 0;
      await upsertState(input.supabase, input.authUserId, {
        status: params.dryRun || selectedUids.length === 0 ? "completed" : "syncing",
        uid_validity: uidValidity,
        highest_modseq: selected.highestModseq ?? inbox.highestModseq,
        mailbox_messages: inbox.messages,
        mailbox_uid_next: inbox.uidNext,
        history_first_uid: historyFirstUid,
        history_last_uid: historyLastUid,
        history_total_messages: historyTotal,
        history_imported_messages: importedBefore,
        history_remaining_messages: Math.max(0, historyTotal - importedBefore),
        history_completed_at: historyComplete ? existingState?.history_completed_at ?? nowIso() : existingState?.history_completed_at ?? null,
        messages_discovered: discovered,
        messages_processed: input.action === "sync_new" ? 0 : importedBefore,
        current_batch_total: currentBatchTotal,
        last_sync_new_messages: newMessages,
      }, cfg);
      if (params.dryRun) {
        return {
          discovered,
          processed: input.action === "sync_new" ? 0 : importedBefore,
          inserted: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          lastSeenUid: existingState?.last_seen_uid ?? null,
          clickhouse: null,
          finalStatus: selectedUids.length ? "partial" as SyncStatus : "completed" as SyncStatus,
          pendingNewMessages: input.action === "sync_new" ? selectedUids.length : 0,
          historyFirstUid,
          historyLastUid,
          historyTotal,
          historyImported: importedBefore,
          historyRemaining: Math.max(0, historyTotal - importedBefore),
          historyCompletedAt: historyComplete ? existingState?.history_completed_at ?? nowIso() : existingState?.history_completed_at ?? null,
          mailboxMessages: inbox.messages,
          mailboxUidNext: inbox.uidNext,
          currentBatchTotal,
          lastSyncImported: 0,
          lastSyncNewMessages: newMessages,
        };
      }
      if (selectedUids.length === 0) {
        const clickhouse = importedBefore > 0 ? await syncClickHouse({ authUserId: input.authUserId, supabase: input.supabase }) : null;
        const completedAt = input.action === "sync_new" ? existingState?.history_completed_at ?? null : existingState?.history_completed_at ?? nowIso();
        return {
          discovered,
          processed: input.action === "sync_new" ? 0 : importedBefore,
          inserted: 0,
          updated: 0,
          skipped: 0,
          failed: 0,
          lastSeenUid: input.action === "sync_new" ? existingState?.last_seen_uid ?? historyLastUid : historyLastUid,
          clickhouse,
          finalStatus: "completed" as SyncStatus,
          pendingNewMessages: 0,
          historyFirstUid,
          historyLastUid,
          historyTotal,
          historyImported: input.action === "sync_new" ? n(existingState?.history_imported_messages) : importedBefore,
          historyRemaining: input.action === "sync_new" ? n(existingState?.history_remaining_messages) : 0,
          historyCompletedAt: completedAt,
          mailboxMessages: inbox.messages,
          mailboxUidNext: inbox.uidNext,
          currentBatchTotal,
          lastSyncImported: 0,
          lastSyncNewMessages: newMessages,
        };
      }

      let invocationProcessed = 0;
      let inserted = 0;
      let skipped = 0;
      let failed = 0;
      let lastSeenUid = existingState?.last_seen_uid ?? null;
      let clickhouse: unknown = null;
      for (let batch = 0; batch < params.maxBatches; batch += 1) {
        const batchUids = selectedUids.slice(batch * params.batchSize, (batch + 1) * params.batchSize);
        if (!batchUids.length) break;
        const batchStartedMs = Date.now();
        const completedBeforeBatch = input.action === "sync_new" ? invocationProcessed : importedBefore + invocationProcessed;
        const currentBatch = input.action === "sync_new"
          ? batch + 1
          : Math.floor(completedBeforeBatch / params.batchSize) + 1;
        await upsertState(input.supabase, input.authUserId, {
          status: "syncing",
          current_batch: currentBatch,
          current_batch_total: input.action === "sync_new" ? Math.max(1, Math.ceil(selectedUids.length / params.batchSize)) : currentBatchTotal,
          current_batch_processed: 0,
          current_batch_started_at: new Date(batchStartedMs).toISOString(),
          current_uid: batchUids[0],
        }, cfg);
        const latestState = await stateFor(input.supabase, input.authUserId, cfg).catch(() => null);
        if (latestState?.status === "stopped") throw new SupportMailError("SYNC_STOPPED", "Support mail sync stopped.", 409);
        const batchId = await createImportBatch(input.supabase, input.authUserId, cfg, input.action);
        activeBatchId = batchId;
        activeBatchFinalized = false;
        const rows: Array<Record<string, unknown>> = [];
        for (const uid of batchUids) {
          try {
            const fetched = await imap.fetchRaw(uid);
            if (!fetched.raw) {
              failed += 1;
              continue;
            }
            const message = parseRawEmail(fetched.raw, String(uid), {
              internal_date: fetched.internalDate,
              size: fetched.size,
              flags: fetched.flags,
            });
            rows.push(supportRow({ authUserId: input.authUserId, batchId, cfg, uidValidity, message, ordinal: invocationProcessed + rows.length + 1 }));
          } catch {
            failed += 1;
          }
        }
        if (failed > 0) {
          throw new SupportMailError("IMAP_BATCH_FETCH_FAILED", "Could not fetch every message in the current IMAP batch. Cursor was not advanced.", 502);
        }
        const saved = await insertSupportRows(input.supabase, input.authUserId, rows);
        inserted += saved.inserted;
        skipped += saved.skipped;
        const batchStatus = failed ? "completed_with_warnings" : "completed";
        await updateImportBatch(input.supabase, batchId, {
          total_rows: batchUids.length,
          inserted_rows: saved.inserted,
          updated_rows: 0,
          skipped_rows: saved.skipped,
          invalid_rows: failed,
          status: batchStatus,
          diagnostics: { provider: PROVIDER, mailbox_key: secretCfg.mailbox_key, folder: cfg.folder, uid_validity: uidValidity, first_uid: batchUids[0], last_uid: batchUids.at(-1), failed_messages: failed },
        });
        activeBatchFinalized = true;
        try {
          clickhouse = await syncClickHouse({ authUserId: input.authUserId, supabase: input.supabase });
        } catch {
          await upsertState(input.supabase, input.authUserId, {
            status: "partial",
            completed_at: nowIso(),
            last_error_code: "CLICKHOUSE_SYNC_FAILED",
            last_error_message_sanitized: "Raw support mail was saved, but ClickHouse support sync failed. Cursor was not advanced.",
          }, cfg);
          throw new SupportMailError("CLICKHOUSE_SYNC_FAILED", "Raw support mail was saved, but ClickHouse support sync failed. Cursor was not advanced.", 502);
        }
        invocationProcessed += batchUids.length;
        lastSeenUid = batchUids.at(-1) ?? lastSeenUid;
        const totalImported = input.action === "sync_new" ? n(existingState?.history_imported_messages) : importedBefore + invocationProcessed;
        const remaining = input.action === "sync_new" ? n(existingState?.history_remaining_messages) : Math.max(0, historyTotal - totalImported);
        const batchDuration = Date.now() - batchStartedMs;
        await upsertState(input.supabase, input.authUserId, {
          status: "syncing",
          current_batch: currentBatch,
          current_batch_processed: batchUids.length,
          messages_processed: input.action === "sync_new" ? invocationProcessed : totalImported,
          messages_inserted: inserted,
          messages_skipped: skipped,
          messages_failed: failed,
          history_imported_messages: totalImported,
          history_remaining_messages: remaining,
          last_sync_imported: invocationProcessed,
          last_sync_new_messages: newMessages,
          last_seen_uid: lastSeenUid,
          last_imported_uid: lastSeenUid,
          current_uid: lastSeenUid,
          last_batch_duration_ms: batchDuration,
          last_batch_messages_per_second: pctSpeed(batchUids.length, batchStartedMs),
        }, cfg);
      }
      const totalImported = input.action === "sync_new" ? n(existingState?.history_imported_messages) : importedBefore + invocationProcessed;
      const remainingAfterInvocation = input.action === "sync_new"
        ? Math.max(0, candidateUids.length - invocationProcessed)
        : Math.max(0, historyTotal - totalImported);
      const finalStatus: SyncStatus = remainingAfterInvocation === 0 ? "completed" : "partial";
      // sync_new reports the HISTORY remainder in history_remaining_messages, so its
      // own leftover (new mail that did not fit into this invocation) had no field to
      // live in: the run ended "partial" while every remaining-counter read 0, and the
      // client had nothing to resume from. Report it explicitly.
      const pendingNewMessages = input.action === "sync_new" ? remainingAfterInvocation : 0;
      const historyCompletedAt = input.action === "sync_new"
        ? existingState?.history_completed_at ?? null
        : finalStatus === "completed" ? existingState?.history_completed_at ?? nowIso() : null;
      return {
        discovered,
        processed: input.action === "sync_new" ? invocationProcessed : totalImported,
        inserted,
        updated: 0,
        skipped,
        failed,
        lastSeenUid,
        clickhouse,
        finalStatus,
        pendingNewMessages,
        historyFirstUid,
        historyLastUid,
        historyTotal,
        historyImported: totalImported,
        historyRemaining: input.action === "sync_new" ? n(existingState?.history_remaining_messages) : remainingAfterInvocation,
        historyCompletedAt,
        mailboxMessages: inbox.messages,
        mailboxUidNext: inbox.uidNext,
        currentBatchTotal: input.action === "sync_new" ? Math.max(1, Math.ceil(selectedUids.length / params.batchSize)) : currentBatchTotal,
        lastSyncImported: invocationProcessed,
        lastSyncNewMessages: newMessages,
      };
    });

    const state = await upsertState(input.supabase, input.authUserId, {
      status: result.finalStatus,
      completed_at: nowIso(),
      last_success_at: result.failed ? existingState?.last_success_at ?? null : nowIso(),
      messages_discovered: result.discovered,
      messages_processed: result.processed,
      messages_inserted: result.inserted,
      messages_updated: result.updated,
      messages_skipped: result.skipped,
      messages_failed: result.failed,
      last_seen_uid: result.lastSeenUid,
      last_imported_uid: result.lastSeenUid,
      mailbox_messages: result.mailboxMessages,
      mailbox_uid_next: result.mailboxUidNext,
      history_first_uid: result.historyFirstUid,
      history_last_uid: result.historyLastUid,
      history_total_messages: result.historyTotal,
      history_imported_messages: result.historyImported,
      history_remaining_messages: result.historyRemaining,
      history_completed_at: result.historyCompletedAt,
      current_batch_total: result.currentBatchTotal,
      current_batch_processed: 0,
      current_uid: result.lastSeenUid,
      last_batch_messages_per_second: pctSpeed(result.lastSyncImported, startedMs),
      last_sync_imported: result.lastSyncImported,
      last_sync_new_messages: result.lastSyncNewMessages,
    }, cfg);
    return {
      ok: true,
      action: input.action,
      provider: PROVIDER,
      mailbox: cfg.username,
      folder: cfg.folder,
      status: result.finalStatus,
      messages_discovered: result.discovered,
      messages_processed: result.processed,
      messages_inserted: result.inserted,
      messages_updated: result.updated,
      messages_skipped: result.skipped,
      messages_failed: result.failed,
      last_seen_uid: result.lastSeenUid,
      mailbox_messages: result.mailboxMessages,
      mailbox_uid_next: result.mailboxUidNext,
      history_first_uid: result.historyFirstUid,
      history_last_uid: result.historyLastUid,
      history_total_messages: result.historyTotal,
      history_imported_messages: result.historyImported,
      history_remaining_messages: result.historyRemaining,
      history_completed_at: result.historyCompletedAt,
      current_batch_total: result.currentBatchTotal,
      last_sync_imported: result.lastSyncImported,
      last_sync_new_messages: result.lastSyncNewMessages,
      /** New mail left over from THIS invocation (sync_new only). > 0 means the run
       * ended "partial" and must be resumed to import the newest messages. */
      pending_new_messages: result.pendingNewMessages,
      clickhouse: result.clickhouse,
      state,
      duration_ms: Date.now() - new Date(started).getTime(),
    };
  } catch (error) {
    const safe = sanitizeError(error);
    if (activeBatchId && !activeBatchFinalized) {
      await updateImportBatch(input.supabase, activeBatchId, {
        status: "failed",
        diagnostics: {
          provider: PROVIDER,
          mailbox_key: cfg.mailbox_key,
          folder: cfg.folder,
          error_code: safe.code,
          error_message: safe.message,
        },
      }).catch(() => undefined);
    }
    const status: SyncStatus = safe.code === "IMAP_AUTH_FAILED" || safe.code === "CONFIG_MISSING"
      ? "credentials_error"
      : safe.code === "IMAP_UIDVALIDITY_CHANGED"
        ? "cursor_invalidated"
        : safe.code === "SYNC_STOPPED"
          ? "stopped"
          : "failed";
    await upsertState(input.supabase, input.authUserId, {
      status,
      completed_at: nowIso(),
      last_error_code: safe.code,
      last_error_message_sanitized: safe.message,
    }, cfg).catch(() => undefined);
    throw error;
  }
}

// ---- Sent-folder ingestion (answered analytics) -----------------------------
//
// Outgoing mail is the source of truth for "we answered". Headers only, into
// support_replies (never support_requests — replies are not requests and must
// not enter classification or request analytics). Reuses the sync-state
// machine: the (auth_user_id, mailbox_key, folder) unique key gives the Sent
// folder its own state row.

const SENT_BATCH_SIZE = 50;
const SENT_MAX_BATCHES = 3;
const SENT_MAX_MESSAGES_PER_INVOCATION = 150;
/** How far back the INBOX \Answered flag refresh looks. Flags are frozen at
 * first sync (within an hour of arrival — before most answers), so recent mail
 * is re-checked; older mail keeps whatever tier the Sent history proves. */
const FLAG_REFRESH_WINDOW_MS = 30 * 86_400_000;
const FLAG_REFRESH_MAX_UPDATES = 500;
/** Post-stage budget: stages are skipped once the invocation runs this long
 * (pg_net gives the whole tick 150s; the INBOX import must never be starved). */
const POST_STAGE_DEADLINE_MS = 90_000;

async function resolveSentFolder(imap: ImapConnection): Promise<string> {
  const override = Deno.env.get("SPACEMAIL_IMAP_SENT_FOLDER")?.trim();
  if (override) return override;
  const discovered = await imap.findSentFolder();
  if (!discovered) {
    throw new SupportMailError("SENT_FOLDER_NOT_FOUND", "Could not locate the Sent folder. Set SPACEMAIL_IMAP_SENT_FOLDER.", 404);
  }
  return discovered;
}

function replyRow(input: {
  authUserId: string;
  cfg: ReturnType<typeof configStatus>;
  uidValidity: string;
  message: ParsedMailMessage;
}) {
  const m = input.message;
  return {
    auth_user_id: input.authUserId,
    mailbox_key: input.cfg.mailbox_key,
    folder: input.cfg.folder,
    imap_uid_validity: input.uidValidity,
    imap_uid: Number(m.uid),
    message_id: m.message_id,
    normalized_message_id: m.normalized_message_id,
    in_reply_to: m.in_reply_to,
    references_json: m.references,
    from_email: m.from_email,
    to_email: m.to_email,
    to_emails: m.to_emails,
    cc_email: m.cc_email,
    subject: m.subject,
    sent_at: m.received_at || m.internal_date,
    internal_date: m.internal_date,
    raw_size_bytes: m.size,
    imap_flags: m.flags,
  };
}

async function importedReplyUidSet(input: {
  client: SupabaseClient;
  authUserId: string;
  cfg: ReturnType<typeof configStatus>;
  uidValidity: string;
}): Promise<Set<number>> {
  const out = new Set<number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await input.client
      .from("support_replies")
      .select("imap_uid")
      .eq("auth_user_id", input.authUserId)
      .eq("mailbox_key", input.cfg.mailbox_key)
      .eq("folder", input.cfg.folder)
      .eq("imap_uid_validity", input.uidValidity)
      .order("imap_uid", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not read imported reply UIDs.", 500);
    const rows = data ?? [];
    rows.forEach((row) => out.add(n(row.imap_uid)));
    if (rows.length < 1000) return out;
  }
}

async function runReplySync(input: {
  action: Extract<MailAction, "sent_initial_sync" | "sent_continue_sync" | "sent_sync_new">;
  authUserId: string;
  supabase: SupabaseClient;
}) {
  return await withConnection(async (imap) => {
    const sentFolder = await resolveSentFolder(imap);
    const cfg = { ...configStatus(), folder: sentFolder };
    const existingState = await stateFor(input.supabase, input.authUserId, cfg);
    if (isRunning(existingState)) {
      return { ok: false, action: input.action, folder: sentFolder, status: "already_running", error_code: "ALREADY_RUNNING", state: existingState };
    }
    // The hourly tick calls sent_sync_new unconditionally; before the operator
    // finishes the Sent backfill that is a quiet no-op, not a failed state row.
    if (input.action === "sent_sync_new" && !existingState?.history_completed_at) {
      return { ok: false, action: input.action, folder: sentFolder, status: "history_required", error_code: "HISTORY_IMPORT_REQUIRED", state: existingState };
    }

    await upsertState(input.supabase, input.authUserId, {
      status: "connecting",
      sync_mode: input.action,
      started_at: nowIso(),
      completed_at: null,
      last_error_code: null,
      last_error_message_sanitized: null,
    }, cfg);

    try {
      const selected = await imap.select(sentFolder);
      const box = await imap.status(sentFolder);
      const uidValidity = selected.uidValidity ?? "unknown";
      if (existingState?.uid_validity && existingState.uid_validity !== uidValidity && input.action !== "sent_initial_sync") {
        await upsertState(input.supabase, input.authUserId, {
          status: "cursor_invalidated",
          uid_validity: uidValidity,
          last_error_code: "IMAP_UIDVALIDITY_CHANGED",
          last_error_message_sanitized: "Sent folder UIDVALIDITY changed. Run sent_initial_sync to rediscover replies.",
          completed_at: nowIso(),
        }, cfg);
        throw new SupportMailError("IMAP_UIDVALIDITY_CHANGED", "Sent folder UIDVALIDITY changed. Run sent_initial_sync.", 409);
      }

      const historyMode = input.action !== "sent_sync_new";
      const allUids = historyMode ? await imap.searchAll(null) : [];
      const imported = await importedReplyUidSet({ client: input.supabase, authUserId: input.authUserId, cfg, uidValidity });
      const candidateUids = historyMode
        ? allUids.filter((uid) => !imported.has(uid))
        : (await imap.searchNewerThan(existingState?.last_seen_uid ?? existingState?.history_last_uid ?? null)).filter((uid) => !imported.has(uid));
      const selectedUids = candidateUids.slice(0, SENT_MAX_MESSAGES_PER_INVOCATION);
      const historyTotal = historyMode ? allUids.length : n(existingState?.history_total_messages);
      const importedBefore = historyMode ? allUids.length - candidateUids.length : n(existingState?.history_imported_messages);

      await upsertState(input.supabase, input.authUserId, {
        status: selectedUids.length ? "syncing" : "completed",
        uid_validity: uidValidity,
        mailbox_messages: box.messages,
        mailbox_uid_next: box.uidNext,
        history_first_uid: historyMode ? allUids[0] ?? null : existingState?.history_first_uid ?? null,
        history_last_uid: historyMode ? allUids.at(-1) ?? null : existingState?.history_last_uid ?? null,
        history_total_messages: historyTotal,
        history_imported_messages: importedBefore,
        history_remaining_messages: Math.max(0, historyTotal - importedBefore),
        messages_discovered: candidateUids.length,
      }, cfg);

      let inserted = 0;
      let processed = 0;
      let lastSeenUid = existingState?.last_seen_uid ?? null;
      for (let batch = 0; batch < SENT_MAX_BATCHES; batch += 1) {
        const batchUids = selectedUids.slice(batch * SENT_BATCH_SIZE, (batch + 1) * SENT_BATCH_SIZE);
        if (!batchUids.length) break;
        const rows: Array<Record<string, unknown>> = [];
        for (const uid of batchUids) {
          const fetched = await imap.fetchHeader(uid);
          if (!fetched.raw) {
            throw new SupportMailError("IMAP_BATCH_FETCH_FAILED", "Could not fetch a Sent message header. Cursor was not advanced.", 502);
          }
          const message = parseRawEmail(fetched.raw, String(uid), {
            internal_date: fetched.internalDate,
            size: fetched.size,
            flags: fetched.flags,
          });
          rows.push(replyRow({ authUserId: input.authUserId, cfg, uidValidity, message }));
        }
        const { error } = await input.supabase
          .from("support_replies")
          .upsert(rows, { onConflict: "auth_user_id,mailbox_key,folder,imap_uid_validity,imap_uid", ignoreDuplicates: true });
        if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", dbErrorMessage("Could not insert support replies", error), 500);
        inserted += rows.length;
        processed += batchUids.length;
        lastSeenUid = batchUids.at(-1) ?? lastSeenUid;
        await upsertState(input.supabase, input.authUserId, {
          status: "syncing",
          messages_processed: importedBefore + processed,
          messages_inserted: inserted,
          history_imported_messages: importedBefore + processed,
          history_remaining_messages: Math.max(0, historyTotal - importedBefore - processed),
          last_seen_uid: lastSeenUid,
          last_imported_uid: lastSeenUid,
        }, cfg);
      }

      const remaining = candidateUids.length - selectedUids.length + (selectedUids.length - processed);
      const finalStatus: SyncStatus = remaining > 0 ? "partial" : "completed";
      const historyCompletedAt = historyMode
        ? (remaining === 0 ? existingState?.history_completed_at ?? nowIso() : null)
        : existingState?.history_completed_at ?? null;
      const state = await upsertState(input.supabase, input.authUserId, {
        status: finalStatus,
        completed_at: nowIso(),
        last_success_at: nowIso(),
        messages_processed: importedBefore + processed,
        messages_inserted: inserted,
        history_imported_messages: importedBefore + processed,
        history_remaining_messages: Math.max(0, historyTotal - importedBefore - processed),
        history_completed_at: historyCompletedAt,
        last_seen_uid: lastSeenUid ?? (historyMode ? allUids.at(-1) ?? null : existingState?.last_seen_uid ?? null),
        last_sync_imported: inserted,
      }, cfg);
      return {
        ok: true,
        action: input.action,
        folder: sentFolder,
        status: finalStatus,
        replies_discovered: candidateUids.length,
        replies_imported: inserted,
        replies_remaining: Math.max(0, remaining),
        history_completed_at: historyCompletedAt,
        state,
      };
    } catch (error) {
      const safe = sanitizeError(error);
      const status: SyncStatus = safe.code === "IMAP_UIDVALIDITY_CHANGED" ? "cursor_invalidated" : "failed";
      await upsertState(input.supabase, input.authUserId, {
        status,
        completed_at: nowIso(),
        last_error_code: safe.code,
        last_error_message_sanitized: safe.message,
      }, cfg).catch(() => undefined);
      throw error;
    }
  });
}

/** Re-reads INBOX flags of recent mail in ONE ranged UID FETCH and updates only
 * rows whose flag set actually changed — every UPDATE bumps updated_at and
 * re-syncs the row to ClickHouse, so the diff is load-bearing, not an
 * optimization. */
async function refreshInboxFlags(input: { authUserId: string; supabase: SupabaseClient }): Promise<{ checked: number; updated: number }> {
  const cfg = configStatus();
  const state = await stateFor(input.supabase, input.authUserId, cfg);
  if (!state?.uid_validity) return { checked: 0, updated: 0 };
  const sinceIso = new Date(Date.now() - FLAG_REFRESH_WINDOW_MS).toISOString();
  const rows: Array<{ id: string; imap_uid: number; imap_flags: string[] }> = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await input.supabase
      .from("support_requests")
      .select("id,imap_uid,imap_flags")
      .eq("auth_user_id", input.authUserId)
      .eq("source_type", "imap")
      .eq("mailbox_key", cfg.mailbox_key)
      .eq("imap_folder", cfg.folder)
      .eq("imap_uid_validity", state.uid_validity)
      .gte("received_at", sinceIso)
      .not("imap_uid", "is", null)
      .order("imap_uid", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not read INBOX flags window.", 500);
    const page = (data ?? []) as Array<{ id: string; imap_uid: number; imap_flags: string[] }>;
    rows.push(...page);
    if (page.length < 1000) break;
  }
  if (!rows.length) return { checked: 0, updated: 0 };

  const flagsByUid = await withConnection(async (imap) => {
    const selected = await imap.select(cfg.folder);
    // A validity change is the regular sync's problem, not the flag pass's.
    if ((selected.uidValidity ?? "unknown") !== state.uid_validity) return null;
    return await imap.fetchFlagsRange(Math.min(...rows.map((row) => row.imap_uid)), "*");
  });
  if (!flagsByUid) return { checked: 0, updated: 0 };

  const flagKey = (flags: readonly string[]) => [...flags].map((flag) => flag.toLowerCase()).sort().join("");
  const changed = rows
    .map((row) => ({ row, next: flagsByUid.get(row.imap_uid) }))
    .filter((entry): entry is { row: (typeof rows)[number]; next: string[] } =>
      entry.next !== undefined && flagKey(entry.next) !== flagKey(entry.row.imap_flags ?? []));
  let updated = 0;
  for (const entry of changed.slice(0, FLAG_REFRESH_MAX_UPDATES)) {
    const { error } = await input.supabase
      .from("support_requests")
      .update({ imap_flags: entry.next })
      .eq("id", entry.row.id)
      .eq("auth_user_id", input.authUserId);
    if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not update INBOX flags.", 500);
    updated += 1;
  }
  return { checked: rows.length, updated };
}

/** Stages appended to every sync_new run (cron tick and the manual button):
 * Sent delta → flag refresh → reply matching → one ClickHouse sync if anything
 * changed. Each stage is fenced: a Sent/flags/matching hiccup must never fail
 * the INBOX import whose cursor has already been committed. */
async function runPostStages(input: { authUserId: string; supabase: SupabaseClient; startedMs: number }) {
  const stages: Record<string, unknown> = {};
  const withinBudget = () => Date.now() - input.startedMs < POST_STAGE_DEADLINE_MS;
  let mutated = false;
  if (withinBudget()) {
    try {
      stages.sent = await runReplySync({ action: "sent_sync_new", authUserId: input.authUserId, supabase: input.supabase });
    } catch (error) {
      stages.sent = { ok: false, error_code: sanitizeError(error).code };
    }
  }
  if (withinBudget()) {
    try {
      const flags = await refreshInboxFlags({ authUserId: input.authUserId, supabase: input.supabase });
      stages.flags = flags;
      mutated = mutated || flags.updated > 0;
    } catch (error) {
      stages.flags = { ok: false, error_code: sanitizeError(error).code };
    }
  }
  if (withinBudget()) {
    try {
      const matching = await runReplyMatching({
        supabase: input.supabase as unknown as SupabaseLikeClient,
        authUserId: input.authUserId,
        mode: "incremental",
      });
      stages.matching = matching;
      mutated = mutated || matching.applied > 0;
    } catch (error) {
      stages.matching = { ok: false, error_code: sanitizeError(error).code };
    }
  }
  if (mutated) {
    try {
      stages.clickhouse = await syncClickHouse({ authUserId: input.authUserId, supabase: input.supabase });
    } catch (error) {
      stages.clickhouse = { ok: false, error_code: sanitizeError(error).code };
    }
  }
  return stages;
}

async function statusResponse(client: SupabaseClient, authUserId: string) {
  const cfg = configStatus();
  const state = await stateFor(client, authUserId, cfg).catch(() => null);
  // The Sent state row (any non-INBOX folder of this mailbox) drives the
  // backfill progress UI; folder discovery needs IMAP, so read what exists.
  const { data: sentRows } = await client
    .from("support_mail_sync_state")
    .select("*")
    .eq("auth_user_id", authUserId)
    .eq("mailbox_key", cfg.mailbox_key)
    .neq("folder", cfg.folder)
    .limit(1);
  return {
    ok: true,
    action: "status",
    provider: PROVIDER,
    mailbox: cfg.username,
    folder: cfg.folder,
    connection: "unknown",
    config: cfg.configured,
    state,
    sent_state: (sentRows ?? [])[0] ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ ok: false, error: "Method not allowed." }, 405);

  try {
    const body = await readBody(req);
    const action = normalizeAction(body.action);
    const internalSecret = Deno.env.get("SUPPORT_MAIL_SYNC_INTERNAL_SECRET")?.trim();
    const requestInternalSecret = req.headers.get("x-support-mail-internal-secret")?.trim();
    let authUserId: string;
    let supabase: SupabaseClient;

    if (body.internal === true) {
      if (!internalSecret || requestInternalSecret !== internalSecret) {
        throw new SupportMailError("AUTH_INVALID", "Invalid internal sync secret.", 401);
      }
      supabase = serviceClient();
      const cfg = configStatus();
      const { data, error } = await supabase
        .from("support_mail_sync_state")
        .select("auth_user_id")
        .eq("mailbox_key", cfg.mailbox_key)
        .eq("folder", cfg.folder)
        .limit(1)
        .maybeSingle();
      if (error) throw new SupportMailError("SUPABASE_WRITE_FAILED", "Could not resolve mailbox owner.", 500);
      if (!data?.auth_user_id) return jsonResponse({ ok: true, action, status: "no_mailbox_owner" });
      authUserId = String(data.auth_user_id);
    } else {
      const auth = await authenticatedUser(req);
      authUserId = auth.authUserId;
      supabase = auth.supabase;
    }

    if (action === "status") return jsonResponse(await statusResponse(supabase, authUserId));
    if (action === "stop") {
      const state = await upsertState(supabase, authUserId, { status: "stopped", completed_at: nowIso() });
      return jsonResponse({ ok: true, action, status: "stopped", state });
    }
    if (action === "reset_cursor") {
      const state = await upsertState(supabase, authUserId, {
        status: "idle",
        uid_validity: null,
        last_seen_uid: null,
        highest_modseq: null,
        mailbox_messages: 0,
        mailbox_uid_next: null,
        history_first_uid: null,
        history_last_uid: null,
        history_total_messages: 0,
        history_imported_messages: 0,
        history_remaining_messages: 0,
        history_completed_at: null,
        current_uid: null,
        last_imported_uid: null,
        current_batch_total: 0,
        current_batch_processed: 0,
        current_batch_started_at: null,
        last_batch_duration_ms: null,
        last_batch_messages_per_second: 0,
        last_sync_imported: 0,
        last_sync_new_messages: 0,
        messages_discovered: 0,
        messages_processed: 0,
        messages_inserted: 0,
        messages_updated: 0,
        messages_skipped: 0,
        messages_failed: 0,
        current_batch: 0,
        last_error_code: null,
        last_error_message_sanitized: null,
      });
      return jsonResponse({ ok: true, action, status: "idle", state });
    }
    if (action === "test_connection") {
      const result = await withConnection(async (imap, cfg) => {
        const selected = await imap.select(cfg.folder);
        const inbox = await imap.status(cfg.folder);
        return { uid_validity: selected.uidValidity ?? inbox.uidValidity, highest_modseq: selected.highestModseq ?? inbox.highestModseq, messages: inbox.messages, uid_next: inbox.uidNext };
      });
      const state = await upsertState(supabase, authUserId, {
        status: "idle",
        uid_validity: result.uid_validity,
        highest_modseq: result.highest_modseq,
        mailbox_messages: result.messages,
        mailbox_uid_next: result.uid_next,
        last_error_code: null,
        last_error_message_sanitized: null,
      });
      return jsonResponse({ ok: true, action, provider: PROVIDER, mailbox: configStatus().username, folder: configStatus().folder, connection: "connected", ...result, state });
    }
    if (action === "list_folders") {
      const folders = await withConnection(async (imap) => await imap.listFolders());
      return jsonResponse({ ok: true, action, provider: PROVIDER, folders });
    }
    if (action === "sent_initial_sync" || action === "sent_continue_sync" || action === "sent_sync_new") {
      return jsonResponse(await runReplySync({ action, authUserId, supabase }));
    }
    if (action === "rematch_replies") {
      const mode = body.mode === "incremental" ? "incremental" as const : "full" as const;
      const matching = await runReplyMatching({ supabase: supabase as unknown as SupabaseLikeClient, authUserId, mode });
      const clickhouse = matching.applied > 0
        ? await syncClickHouse({ authUserId, supabase }).catch((error) => ({ ok: false, error_code: sanitizeError(error).code }))
        : null;
      return jsonResponse({ ok: true, action, mode, ...matching, clickhouse });
    }
    const startedMs = Date.now();
    const syncResult = await runMailSync({ action, authUserId, supabase, body });
    // Answered-analytics stages ride every successful sync_new (cron + manual):
    // the INBOX cursor is already committed, these only ADD data.
    if (action === "sync_new" && (syncResult as { ok?: boolean }).ok !== false) {
      (syncResult as Record<string, unknown>).post_stages = await runPostStages({ authUserId, supabase, startedMs });
    }
    return jsonResponse(syncResult);
  } catch (error) {
    const safe = sanitizeError(error);
    return jsonResponse({ ok: false, error: safe.message, error_code: safe.code }, safe.status);
  }
});
