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

  private async request(query: string, params?: Record<string, unknown>): Promise<string> {
    const url = new URL("/", this.endpoint);
    url.searchParams.set("database", this.database);
    const parameterSearch = queryParams(params);
    parameterSearch.forEach((value, key) => url.searchParams.set(key, value));

    const response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: this.authHeader,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: query,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`ClickHouse HTTP ${response.status}: ${text.slice(0, 500)}`);
    }
    return text;
  }

  async query(input: { query: string; query_params?: Record<string, unknown>; format?: string }): Promise<ClickHouseResultSet> {
    const query = appendFormat(input.query, input.format);
    const text = await this.request(query, input.query_params);
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
