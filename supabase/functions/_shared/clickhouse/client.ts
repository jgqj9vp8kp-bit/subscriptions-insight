/* global Deno */

import type { ClickHouseClientLike, ClickHouseEnv, ClickHouseResultSet } from "./types.ts";

function readSecret(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

export function clickHouseEnv(): ClickHouseEnv {
  return {
    host: readSecret("CLICKHOUSE_HOST"),
    username: readSecret("CLICKHOUSE_USERNAME") || "default",
    database: readSecret("CLICKHOUSE_DATABASE") || "default",
    hasPassword: Boolean(readSecret("CLICKHOUSE_PASSWORD")),
  };
}

export function isClickHouseConfigured(): boolean {
  const env = clickHouseEnv();
  return Boolean(env.host) && env.hasPassword;
}

function encodeBasicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

function appendFormat(query: string, format?: string): string {
  if (!format || /\bFORMAT\s+\w+/i.test(query)) return query;
  return `${query.trim()}\nFORMAT ${format}`;
}

function parseJsonEachRow(text: string): unknown[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function queryParams(params: Record<string, unknown> | undefined): URLSearchParams {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value == null) continue;
    search.set(`param_${key}`, String(value));
  }
  return search;
}

// ---- transient-failure handling -------------------------------------------------
//
// ClickHouse Cloud idles a service and resets connections while it wakes, so a
// perfectly healthy warehouse regularly answers the first request with
// "Connection reset by peer (os error 104)". A single fetch turned that into a
// hard failure: every page dropped to the legacy client-side engine for the whole
// session. Reads are retried with backoff so the wake-up heals itself.
//
// WRITES ARE NOT RETRIED. A reset can arrive after the server already accepted the
// body, so re-sending an INSERT could duplicate rows (fact_support_requests in
// particular has a sorting key that does not collapse re-inserts). Sync callers
// already own resumable cursors — a failed write is safer surfaced than repeated.

const READ_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 400;
/** Statuses worth retrying: gateway/availability, never 4xx (auth, bad SQL). */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** HTTP-level failure — carries the status so the retry decision stays explicit. */
class ClickHouseHttpError extends Error {
  constructor(readonly status: number, body: string) {
    super(`ClickHouse HTTP ${status}: ${body.slice(0, 500)}`);
    this.name = "ClickHouseHttpError";
  }
}

/** The raw fetch error embeds the full endpoint URL — host, database and every
 * query parameter (including auth_user_id). Keep the cause, drop the URL. */
function describeTransport(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutUrl = raw.replace(/\s*for url \([^)]*\)/i, "").replace(/https?:\/\/\S+/g, "").trim();
  return withoutUrl || "connection failed";
}

class FetchClickHouseResultSet implements ClickHouseResultSet {
  constructor(private readonly responseText: string, private readonly format?: string) {}

  async json(): Promise<unknown> {
    if ((this.format ?? "").toLowerCase() === "jsoneachrow") return parseJsonEachRow(this.responseText);
    return this.responseText ? JSON.parse(this.responseText) : null;
  }
}

export class FetchClickHouseClient implements ClickHouseClientLike {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly database: string;

  constructor(input: { host: string; username: string; password: string; database: string }) {
    this.endpoint = input.host.replace(/\/+$/, "");
    this.authHeader = encodeBasicAuth(input.username, input.password);
    this.database = input.database;
  }

  /** `attempts` > 1 only for reads — see the note above on write safety. */
  private async request(query: string, params?: Record<string, unknown>, attempts = 1): Promise<string> {
    const url = new URL("/", this.endpoint);
    url.searchParams.set("database", this.database);
    const parameterSearch = queryParams(params);
    parameterSearch.forEach((value, key) => url.searchParams.set(key, value));

    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let retryable: boolean;
      try {
        const response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            Authorization: this.authHeader,
            "Content-Type": "text/plain; charset=utf-8",
          },
          body: query,
        });
        const text = await response.text();
        if (response.ok) return text;
        lastError = new ClickHouseHttpError(response.status, text);
        retryable = RETRYABLE_STATUS.has(response.status);
      } catch (error) {
        // Never reached the server (DNS/TLS/connection reset) — always worth a retry.
        lastError = new Error(`ClickHouse unreachable: ${describeTransport(error)}`);
        retryable = true;
      }
      if (!retryable || attempt === attempts) break;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
    const failure = lastError instanceof Error ? lastError : new Error(String(lastError));
    if (attempts > 1) failure.message = `${failure.message} (after ${attempts} attempts)`;
    throw failure;
  }

  async query(input: { query: string; query_params?: Record<string, unknown>; format?: string }): Promise<ClickHouseResultSet> {
    const query = appendFormat(input.query, input.format);
    // Reads are pure: retrying is always safe and covers the idle-wake reset.
    const text = await this.request(query, input.query_params, READ_RETRY_ATTEMPTS);
    return new FetchClickHouseResultSet(text, input.format);
  }

  async command(input: { query: string; query_params?: Record<string, unknown> }): Promise<void> {
    await this.request(input.query, input.query_params);
  }

  async insert(input: { table: string; values: Record<string, unknown>[]; format?: string }): Promise<void> {
    if (!input.values.length) return;
    const format = input.format || "JSONEachRow";
    const rows = input.values.map((row) => JSON.stringify(row)).join("\n");
    await this.request(`INSERT INTO ${input.table} FORMAT ${format}\n${rows}`);
  }

  async close(): Promise<void> {
    // Fetch has no persistent client state to close in Edge Runtime.
  }
}

export function createClickHouseClient(): ClickHouseClientLike {
  const host = readSecret("CLICKHOUSE_HOST");
  const password = readSecret("CLICKHOUSE_PASSWORD");
  if (!host) throw new Error("CLICKHOUSE_HOST is not configured in Supabase Secrets.");
  if (!password) throw new Error("CLICKHOUSE_PASSWORD is not configured in Supabase Secrets.");

  return new FetchClickHouseClient({
    host,
    username: readSecret("CLICKHOUSE_USERNAME") || "default",
    password,
    database: readSecret("CLICKHOUSE_DATABASE") || "default",
  });
}
