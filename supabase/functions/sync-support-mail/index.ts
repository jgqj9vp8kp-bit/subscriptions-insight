/* global Deno */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  classifySupportIntent,
  enrichSupportMessage,
  extractEmailLiterals,
  parseRawEmail,
  type ParsedMailMessage,
  type SyncSupportSummary,
  type WarehouseTxn,
} from "./support.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type SupabaseClient = ReturnType<typeof createClient>;

type SupportRow = {
  message_id: string;
  from_email: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string | null;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function quoteImap(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function imapDate(value: string): string {
  const date = new Date(value);
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][date.getUTCMonth()];
  return `${day}-${month}-${date.getUTCFullYear()}`;
}

class ImapConnection {
  private conn: Deno.TlsConn | null = null;
  private counter = 0;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(private readonly host: string, private readonly port: number) {}

  async connect() {
    this.conn = await Deno.connectTls({ hostname: this.host, port: this.port });
    await this.readUntil(/\r?\n/);
  }

  async login(user: string, password: string) {
    await this.command(`LOGIN ${quoteImap(user)} ${quoteImap(password)}`);
  }

  async select(folder: string) {
    await this.command(`SELECT ${quoteImap(folder)}`);
  }

  async search(since: string | null): Promise<string[]> {
    const response = await this.command(`UID SEARCH ${since ? `SINCE ${imapDate(since)}` : "ALL"}`);
    const match = response.match(/\* SEARCH\s+([0-9\s]*)/i);
    return (match?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
  }

  async fetchRaw(uid: string): Promise<string | null> {
    const response = await this.command(`UID FETCH ${uid} (BODY.PEEK[])`);
    return extractEmailLiterals(response)[0] ?? null;
  }

  async logout() {
    try {
      await this.command("LOGOUT");
    } catch {
      // Best effort cleanup only; do not leak connection details in responses.
    }
    try {
      this.conn?.close();
    } catch {
      // Ignore close failures.
    }
    this.conn = null;
  }

  private async command(command: string): Promise<string> {
    if (!this.conn) throw new Error("IMAP connection is not open.");
    const tag = `A${String(++this.counter).padStart(4, "0")}`;
    await this.conn.write(this.encoder.encode(`${tag} ${command}\r\n`));
    const response = await this.readUntil(new RegExp(`\\r?\\n${tag} (OK|NO|BAD)`, "i"));
    if (!new RegExp(`\\r?\\n${tag} OK`, "i").test(response)) {
      throw new Error(`IMAP command failed: ${command.split(" ")[0]}`);
    }
    return response;
  }

  private async readUntil(pattern: RegExp): Promise<string> {
    if (!this.conn) throw new Error("IMAP connection is not open.");
    const chunks: string[] = [];
    const buffer = new Uint8Array(64 * 1024);
    for (;;) {
      const read = await this.conn.read(buffer);
      if (read == null) break;
      chunks.push(this.decoder.decode(buffer.slice(0, read), { stream: true }));
      const text = chunks.join("");
      if (pattern.test(text)) return text;
    }
    return chunks.join("");
  }
}

async function collectPages<T>(loader: (offset: number, limit: number) => Promise<T[]>, pageSize = 1000): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await loader(offset, pageSize);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function verifyUser(req: Request): Promise<string> {
  const supabaseUrl = requireEnv("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") || requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const token = bearerToken(req);
  if (!token) throw new Error("Missing authorization token.");
  const authClient = createClient(supabaseUrl, key, { auth: { persistSession: false } });
  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data.user?.id) throw new Error("Invalid authorization token.");
  return data.user.id;
}

function serviceClient(): SupabaseClient {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}

async function latestSyncedReceivedAt(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await client
    .from("support_messages")
    .select("received_at")
    .eq("auth_user_id", userId)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return (data as { received_at?: string | null }).received_at ?? null;
}

async function loadWarehouse(client: SupabaseClient, userId: string): Promise<WarehouseTxn[]> {
  return collectPages<WarehouseTxn>(async (offset, limit) => {
    const { data, error } = await client
      .from("transactions")
      .select("transaction_id,user_id,email,event_time,status,transaction_type,amount_gross,amount_net,amount_refunded,country_code,campaign_path,funnel,campaign_id,normalized_payload,raw_payload")
      .eq("auth_user_id", userId)
      .is("deleted_at", null)
      .order("event_time", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    return (data ?? []) as WarehouseTxn[];
  });
}

async function existingMessages(client: SupabaseClient, userId: string, messageIds: string[]): Promise<Set<string>> {
  if (!messageIds.length) return new Set();
  const rows = await collectPages<{ message_id: string }>(async (offset, limit) => {
    const pageIds = messageIds.slice(offset, offset + limit);
    if (!pageIds.length) return [];
    const { data, error } = await client
      .from("support_messages")
      .select("message_id")
      .eq("auth_user_id", userId)
      .in("message_id", pageIds);
    if (error) throw error;
    return (data ?? []) as { message_id: string }[];
  }, 1000);
  return new Set(rows.map((row) => row.message_id));
}

function supportRow(message: ParsedMailMessage, userId: string, mailbox: string, folder: string, txs: WarehouseTxn[]) {
  const enrichment = enrichSupportMessage(message.from_email, txs);
  const detectedIntent = classifySupportIntent(message.subject, message.body_text ?? message.body_html);
  return {
    auth_user_id: userId,
    message_id: message.message_id,
    thread_id: message.thread_id,
    mailbox,
    folder,
    from_email: message.from_email,
    from_name: message.from_name,
    to_email: message.to_email,
    subject: message.subject,
    body_text: message.body_text,
    body_html: message.body_html,
    received_at: message.received_at,
    synced_at: new Date().toISOString(),
    detected_intent: detectedIntent,
    ...enrichment,
    raw_headers: message.raw_headers,
    raw_payload: message.raw_payload,
  };
}

async function readMailruMessages(since: string | null): Promise<ParsedMailMessage[]> {
  const host = Deno.env.get("MAILRU_IMAP_HOST")?.trim() || "imap.mail.ru";
  const port = Number(Deno.env.get("MAILRU_IMAP_PORT")?.trim() || "993");
  const user = requireEnv("MAILRU_IMAP_USER");
  const password = requireEnv("MAILRU_IMAP_PASSWORD");
  const folder = Deno.env.get("MAILRU_IMAP_FOLDER")?.trim() || "INBOX";
  const maxMessages = Math.max(1, Math.min(250, Number(Deno.env.get("MAILRU_IMAP_MAX_MESSAGES") ?? "50")));
  const imap = new ImapConnection(host, port);
  try {
    await imap.connect();
    await imap.login(user, password);
    await imap.select(folder);
    const uids = (await imap.search(since)).slice(-maxMessages);
    const messages: ParsedMailMessage[] = [];
    for (const uid of uids) {
      const raw = await imap.fetchRaw(uid);
      if (!raw) continue;
      messages.push(parseRawEmail(raw, uid));
    }
    return messages;
  } finally {
    await imap.logout();
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed." }, 405);

  try {
    const userId = await verifyUser(req);
    const client = serviceClient();
    const mailbox = Deno.env.get("MAILRU_IMAP_USER")?.trim() || "support@azora-astro.com";
    const folder = Deno.env.get("MAILRU_IMAP_FOLDER")?.trim() || "INBOX";
    const since = await latestSyncedReceivedAt(client, userId);
    const [messages, txs] = await Promise.all([
      readMailruMessages(since),
      loadWarehouse(client, userId),
    ]);
    const rows = messages.map((message) => supportRow(message, userId, mailbox, folder, txs));
    const existing = await existingMessages(client, userId, rows.map((row) => row.message_id));
    let inserted = 0;
    let updated = 0;
    for (const row of rows) {
      if (existing.has(row.message_id)) updated += 1;
      else inserted += 1;
    }

    if (rows.length) {
      const { error } = await client
        .from("support_messages")
        .upsert(rows, { onConflict: "auth_user_id,message_id" });
      if (error) throw error;
    }

    const summary: SyncSupportSummary = {
      synced: rows.length,
      inserted,
      updated,
      skipped: Math.max(0, messages.length - rows.length),
      matched_users: rows.filter((row) => Boolean(row.matched_user_id)).length,
      unmatched: rows.filter((row) => !row.matched_user_id).length,
      latest_received_at: rows
        .map((row) => row.received_at)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? since,
    };
    return jsonResponse(summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Support mail sync failed.";
    const safeMessage = message.includes("MAILRU_IMAP_PASSWORD") ? "Mail.ru IMAP credentials are not configured." : message;
    return jsonResponse({ error: safeMessage }, safeMessage.includes("authorization") ? 401 : 500);
  }
});
