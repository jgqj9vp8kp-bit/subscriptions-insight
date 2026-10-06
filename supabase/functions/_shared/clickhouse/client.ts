/* global Deno */

// The ONLY ClickHouse transport (plan §13 layer 2). It holds the warehouse
// password and binds whatever auth_user_id it is given, so it must never be
// handed to request code directly: Edge functions receive a ScopedReader
// (scopedClient.ts) bound to the request's AccessContext through
// serveWithAccess, which forces {auth_user_id:String} = ctx.tenantKey.
//
// Export surface:
//   * internalCreateClickHouseClient — only scopedClient.ts may import it (the
//     transport unit tests — src/test/clickhouseClientRetry.test.ts,
//     fbCohortUserCostArchitecture.test.ts — call it with an explicit fake
//     `config`, so no Deno secret is read);
//   * clickHouseEnv / isClickHouseConfigured — config probes, no secret exposed.
//
// Reads may carry `settings` (a fixed allowlist, sent as plain URL params),
// `query_id` and an abort `signal`: the ScopedReader sets them on funnel-
// restricted reads only (access Phase 2, M14). Without them a request is
// byte-identical to before.

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

/** Server settings a caller may pass as URL params (no `param_` prefix) — only the
 * restricted-read capacity limits the ScopedReader sets (spec §3.3 M14). Anything
 * else is refused rather than forwarded. */
const ALLOWED_QUERY_SETTINGS: ReadonlySet<string> = new Set([
  "max_execution_time",
  "timeout_overflow_mode",
  "max_memory_usage",
  "readonly",
  "cancel_http_readonly_queries_on_client_close",
]);

function settingParams(settings: Record<string, string | number> | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(settings ?? {})) {
    if (!ALLOWED_QUERY_SETTINGS.has(name)) throw new Error(`ClickHouse setting "${name}" is not allowed.`);
    if (value == null) continue;
    out.push([name, String(value)]);
  }
  return out;
}

interface RequestOptions {
  settings?: Record<string, string | number>;
  queryId?: string;
  signal?: AbortSignal;
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
/** ClickHouse exception codes that are deterministic for the same query (a limit
 * or a cancellation, usually a 500): retrying only multiplies the load —
 * TIMEOUT_EXCEEDED 159, MEMORY_LIMIT_EXCEEDED 241, TOO_MANY_ROWS 158,
 * TOO_MANY_ROWS_OR_BYTES 396, QUERY_WAS_CANCELLED 394. Applied to restricted
 * reads only (the ones carrying settings: they hit their OWN fixed limits). A
 * read without settings — the owner's, the cron's — keeps the Phase-1 retry:
 * a total-memory 241 under a concurrent rebuild is transient for it. */
const NON_RETRYABLE_EXCEPTION_CODES = new Set(["159", "241", "158", "396", "394"]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

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

/** Transport class. Not exported: built only by internalCreateClickHouseClient —
 * Edge code must use the ScopedReader handed out by serveWithAccess. */
class FetchClickHouseClient implements ClickHouseClientLike {
  private readonly endpoint: string;
  private readonly authHeader: string;
  private readonly database: string;

  constructor(input: { host: string; username: string; password: string; database: string }) {
    this.endpoint = input.host.replace(/\/+$/, "");
    this.authHeader = encodeBasicAuth(input.username, input.password);
    this.database = input.database;
  }

  /** `attempts` > 1 only for reads — see the note above on write safety.
   * `options` carries the restricted-read settings / query_id / abort signal;
   * without it the request is exactly the pre-Phase-2 one. */
  private async request(query: string, params?: Record<string, unknown>, attempts = 1, options: RequestOptions = {}): Promise<string> {
    const url = new URL("/", this.endpoint);
    url.searchParams.set("database", this.database);
    const parameterSearch = queryParams(params);
    parameterSearch.forEach((value, key) => url.searchParams.set(key, value));
    for (const [name, value] of settingParams(options.settings)) url.searchParams.set(name, value);
    if (options.queryId) url.searchParams.set("query_id", options.queryId);
    const signal = options.signal;

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
          ...(signal ? { signal } : {}),
        });
        const text = await response.text();
        if (response.ok) return text;
        lastError = new ClickHouseHttpError(response.status, text);
        const exceptionCode = options.settings ? response.headers?.get?.("X-ClickHouse-Exception-Code")?.trim() ?? "" : "";
        retryable = RETRYABLE_STATUS.has(response.status) && !NON_RETRYABLE_EXCEPTION_CODES.has(exceptionCode);
      } catch (error) {
        if (isAbortError(error, signal)) {
          // The reader was closed (request finished or abandoned): never retried.
          const aborted = new Error("ClickHouse request aborted.");
          aborted.name = "AbortError";
          lastError = aborted;
          retryable = false;
        } else {
          // Never reached the server (DNS/TLS/connection reset) — always worth a retry.
          lastError = new Error(`ClickHouse unreachable: ${describeTransport(error)}`);
          retryable = true;
        }
      }
      if (!retryable || attempt === attempts || signal?.aborted) break;
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
    const failure = lastError instanceof Error ? lastError : new Error(String(lastError));
    if (attempts > 1 && failure.name !== "AbortError") failure.message = `${failure.message} (after ${attempts} attempts)`;
    throw failure;
  }

  async query(input: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: string;
    settings?: Record<string, string | number>;
    query_id?: string;
    signal?: AbortSignal;
  }): Promise<ClickHouseResultSet> {
    const query = appendFormat(input.query, input.format);
    // Reads are pure: retrying is safe and covers the idle-wake reset (except
    // deterministic limit / cancellation failures and aborts, see request()).
    const text = await this.request(query, input.query_params, READ_RETRY_ATTEMPTS, {
      settings: input.settings,
      queryId: input.query_id,
      signal: input.signal,
    });
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

/** @internal ONLY scopedClient.ts may import this. Everything else receives a
 * ScopedReader (request code via serveWithAccess's `clickhouse()`), so no code
 * path can bind a tenant other than ctx.tenantKey. `config` lets tests build a
 * client without Deno secrets. */
export function internalCreateClickHouseClient(
  config?: { host: string; username?: string; password: string; database?: string },
): ClickHouseClientLike {
  const host = config ? config.host : readSecret("CLICKHOUSE_HOST");
  const password = config ? config.password : readSecret("CLICKHOUSE_PASSWORD");
  if (!host) throw new Error("CLICKHOUSE_HOST is not configured in Supabase Secrets.");
  if (!password) throw new Error("CLICKHOUSE_PASSWORD is not configured in Supabase Secrets.");

  return new FetchClickHouseClient({
    host,
    username: (config ? config.username : readSecret("CLICKHOUSE_USERNAME")) || "default",
    password,
    database: (config ? config.database : readSecret("CLICKHOUSE_DATABASE")) || "default",
  });
}
