// ScopedReader: the only ClickHouse client request code ever receives (plan §13
// layer 2, D5). It wraps the raw transport and enforces, per request, what
// ~185 hand-written query sites used to get right one by one.
//
// Rules:
//   1. Tenant binding. `{auth_user_id:String}` is ALWAYS ctx.tenantKey (the
//      workspace data_key). A caller that supplies any other auth_user_id —
//      e.g. a runner still passing the caller's own id — is a violation, not a
//      silent override, so a missed migration is loud instead of "working".
//   2. Restricted contexts (funnel scope ≠ all) may reference a protected table
//      only inside a fragment that a scopeSql.ts helper registered for THIS
//      context (Phase 2; every fragment is a closed `(SELECT …)` subquery). The
//      reader masks those fragments, then any protected identifier, forbidden
//      construct (system tables, table functions, dictGet/joinGet, SETTINGS,
//      INTO OUTFILE), quoted identifier, placeholder that is not a plain value
//      ({t:Identifier} would let a query_params VALUE name a table), function
//      call in a FROM / JOIN source (a table function, whatever its name) or
//      comma join left over is a violation. Restricted contexts never write
//      (command / insert).
//   3. Inserts: every row that carries auth_user_id must carry ctx.tenantKey.
//   4. Capacity (M14), restricted reads only: fixed per-query settings and a
//      query_id, at most 3 queries in flight per reader, and close() aborts
//      in-flight fetches. Owner and cron transport input stays byte-identical.
//
// A violation is RECORDED on ctx.violations before it is thrown. The serve
// wrapper turns a non-empty list into a 500 even when inner code swallows the
// throw (there are `.catch(() => [])` sites in the cohort runners) — rule R7.
// Runners must rethrow it: `if (error instanceof ScopeViolation) throw error`.

import type { ClickHouseClientLike, ClickHouseResultSet } from "./types.ts";
import { isIssuedAccessContext, type AccessContext } from "../access/accessContext.ts";
import { internalCreateClickHouseClient } from "./client.ts";
import { maskScopeFragments } from "./scopeSql.ts";

/** Protected tables (plan §13): every fact / Facebook / raw table, including
 * `_rebuild` / `_legacy` copies, staged FB tables and backticked or
 * `db.`-qualified forms. Matched case-insensitively — stricter than ClickHouse
 * itself, which is the safe side. */
export const PROTECTED_TABLE_PATTERN =
  /\b(analytics_transactions|fact_\w+|facebook_\w+|v_fb_\w+|v_channel_\w+|dim_facebook_\w+|raw_facebook_api_responses|analytics_validation_source_ids|pp_staged_\w+|ud_staged_\w+)\w*/i;

/** What a restricted statement may not contain outside its masked fragments.
 * The table-function list (with its *Cluster / engine-family variants) is
 * defense in depth: tableSourceViolation refuses ANY function call used as a
 * FROM / JOIN source, named here or not. */
export const FORBIDDEN_CONSTRUCTS: readonly RegExp[] = Object.freeze([
  /\b(system|information_schema)\s*\./i,
  /\b(merge|mergeTree\w*|remote\w*|cluster\w*|\w+Cluster|url\w*|s3\w*|gcs|azureBlobStorage\w*|hdfs\w*|file\w*|input|view\w*|executable\w*|jdbc|odbc|mysql\w*|postgresql|mongodb|redis|sqlite|iceberg\w*|deltaLake\w*|hudi\w*|paimon\w*|dictionary|loop|fuzz\w*|timeSeries\w*|prometheus\w*|arrowFlight\w*|ytsaurus|generateRandom\w*|generate_series|generateSeries)\s*\(/i,
  /\b(dictGet\w*|joinGet\w*)\s*\(/i,
  /\bSETTINGS\b/i,
  /\bINTO\s+OUTFILE\b/i,
]);

const QUOTED_IDENTIFIER = /[`"\\]/;

/** `{name:Type}` placeholders a restricted statement may carry: plain values.
 * An Identifier placeholder (or any type outside this list) is refused — the
 * guard reads the statement text, never the query_params values. */
const PLACEHOLDER = /\{\s*([A-Za-z_]\w*)\s*:\s*([^{}]*?)\s*\}/g;
const RESTRICTED_PLACEHOLDER_TYPE =
  /^(?:String|Date|Date32|DateTime|DateTime64(?:\(\s*\d\s*(?:,\s*'[A-Za-z0-9_/+-]+'\s*)?\))?|U?Int(?:8|16|32|64)|Float(?:32|64)|Bool|Array\((?:String|Date)\))$/;

/** Words that end a FROM list (the comma-join scan stops there). */
const FROM_LIST_END = /^(?:WHERE|PREWHERE|GROUP|ORDER|LIMIT|HAVING|UNION|INTERSECT|EXCEPT|FORMAT|WINDOW|QUALIFY|SETTINGS|SAMPLE|ARRAY|JOIN|INNER|LEFT|RIGHT|FULL|CROSS|ANY|ALL|SEMI|ANTI|ASOF|GLOBAL|PASTE|ON|USING)$/i;
const CALL_AT = /^([A-Za-z_][\w.]*)\s*\(/;

/** Single-quoted literals → '' so their text is never read as SQL ('' escapes;
 * a backslash is already a violation on its own). */
function withoutLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

function skipSpace(sql: string, index: number): number {
  let at = index;
  while (at < sql.length && /\s/.test(sql[at])) at += 1;
  return at;
}

/** A restricted statement's FROM / JOIN sources (masked fragments read as
 * ` __sf__ `) are fragments, CTE names or subqueries — never a function call
 * (a table function reads any table by name, through any spelling of that
 * name), and never a comma-joined list (which would hide one). Returns the
 * offending text, or null. */
export function tableSourceViolation(masked: string): string | null {
  const sql = withoutLiterals(masked);
  for (const match of sql.matchAll(/\b(FROM|JOIN)\b/gi)) {
    const keyword = match[1].toUpperCase();
    const before = sql.slice(0, match.index).trimEnd();
    if (keyword === "FROM") {
      // trim(BOTH ' ' FROM x), extract(DAY FROM x), IS [NOT] DISTINCT FROM x: an expression, not a source.
      if (before.endsWith("'") || /\bextract\s*\(\s*[A-Za-z]+$/i.test(before) || /\bDISTINCT$/i.test(before)) continue;
    } else if (/\bARRAY$/i.test(before)) {
      continue; // ARRAY JOIN takes an expression
    }
    const start = skipSpace(sql, (match.index ?? 0) + match[0].length);
    const head = sql[start] === "(" ? skipSpace(sql, start + 1) : start;
    const call = CALL_AT.exec(sql.slice(head));
    if (call && !/^(SELECT|WITH)$/i.test(call[1])) return `${keyword} ${call[0].replace(/\s+/g, "")}`;
    if (keyword !== "FROM") continue;
    let depth = 0;
    for (let at = start; at < sql.length; at += 1) {
      const char = sql[at];
      if (char === "(") depth += 1;
      else if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      } else if (depth === 0 && char === ",") {
        return "FROM list with a comma join";
      } else if (depth === 0 && /[A-Za-z_]/.test(char) && !/\w/.test(sql[at - 1] ?? "")) {
        const word = /^[A-Za-z_]\w*/.exec(sql.slice(at))?.[0] ?? char;
        if (FROM_LIST_END.test(word)) break;
        at += word.length - 1;
      }
    }
  }
  return null;
}

/** The first placeholder whose type is not a plain value, or null. */
export function restrictedPlaceholderViolation(masked: string): string | null {
  for (const match of masked.matchAll(PLACEHOLDER)) {
    if (!RESTRICTED_PLACEHOLDER_TYPE.test(match[2])) return `{${match[1]}:${match[2]}}`;
  }
  return null;
}

/** Capacity settings of every restricted read (fixed: request code cannot relax them). */
const RESTRICTED_MAX_EXECUTION_SECONDS = 20;
const RESTRICTED_MAX_MEMORY_DEFAULT = 4e9;
const RESTRICTED_MAX_CONCURRENT_QUERIES = 3;

const TENANT_PLACEHOLDER = "{auth_user_id:";

export type ScopeViolationCode =
  | "tenant_param_mismatch"
  | "tenant_row_mismatch"
  | "restricted_protected_table"
  | "restricted_forbidden_construct"
  | "restricted_quoted_identifier"
  | "restricted_write";

export class ScopeViolation extends Error {
  readonly code: ScopeViolationCode;

  constructor(code: ScopeViolationCode, detail?: string) {
    super(`Scope violation: ${code}${detail ? ` (${detail})` : ""}.`);
    this.name = "ScopeViolation";
    this.code = code;
  }
}

const scopedReaders = new WeakSet<object>();

/** True for clients produced by createScopedReader — lets runners and tests
 * assert they were handed the guarded client, not the raw transport. */
export function isScopedReader(client: unknown): boolean {
  return typeof client === "object" && client !== null && scopedReaders.has(client);
}

/** CLICKHOUSE_RESTRICTED_MAX_MEMORY_BYTES (not a secret), default 4e9. Read
 * through globalThis so the module stays importable under vitest. */
function restrictedMaxMemoryBytes(): number {
  const env = globalThis as { Deno?: { env?: { get?: (name: string) => string | undefined } }; process?: { env?: Record<string, string | undefined> } };
  let raw: string | undefined;
  try {
    raw = env.Deno?.env?.get?.("CLICKHOUSE_RESTRICTED_MAX_MEMORY_BYTES") ?? env.process?.env?.CLICKHOUSE_RESTRICTED_MAX_MEMORY_BYTES;
  } catch {
    raw = undefined; // Deno without --allow-env: keep the default
  }
  const value = Number(raw ?? RESTRICTED_MAX_MEMORY_DEFAULT);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : RESTRICTED_MAX_MEMORY_DEFAULT;
}

/** Counting semaphore for the restricted in-flight limit. */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  return {
    async acquire(): Promise<void> {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve, reject) => waiting.push({ resolve, reject }));
    },
    release(): void {
      const next = waiting.shift();
      if (next) next.resolve(); // the slot passes straight to the next waiter
      else active = Math.max(0, active - 1);
    },
    rejectAll(error: unknown): void {
      for (const entry of waiting.splice(0)) entry.reject(error);
    },
  };
}

export function createScopedReader(ctx: AccessContext, raw?: ClickHouseClientLike): ClickHouseClientLike {
  if (!isIssuedAccessContext(ctx)) throw new Error("createScopedReader requires an AccessContext issued by buildAccessContext / buildCronAccessContext.");
  // Captured once: the context is frozen, and the reader's mode never changes.
  const restricted = ctx.restricted === true;
  const requestId = ctx.requestId;
  let transport: ClickHouseClientLike | null = raw ?? null;
  // Lazily: building the reader must not require ClickHouse secrets (actions
  // that never query, unit tests); the first query does.
  const client = () => (transport ??= internalCreateClickHouseClient());

  // Restricted capacity state (unused for owner / cron readers).
  const abort = restricted ? new AbortController() : null;
  const semaphore = createSemaphore(RESTRICTED_MAX_CONCURRENT_QUERIES);
  let closed = false;
  let queryNumber = 0;

  const violate = (code: ScopeViolationCode, detail?: string): never => {
    ctx.violations.push(detail ? `${code}:${detail}` : code);
    throw new ScopeViolation(code, detail);
  };

  const guardStatement = (query: string, params: Record<string, unknown> | undefined): Record<string, unknown> | undefined => {
    const text = String(query ?? "");
    const bound: Record<string, unknown> | undefined = params ? { ...params } : undefined;
    if (bound && Object.prototype.hasOwnProperty.call(bound, "auth_user_id") && bound.auth_user_id !== undefined) {
      if (String(bound.auth_user_id) !== ctx.tenantKey) violate("tenant_param_mismatch");
    }
    if (restricted) {
      const masked = maskScopeFragments(ctx, text);
      const table = PROTECTED_TABLE_PATTERN.exec(masked);
      if (table) violate("restricted_protected_table", table[0]);
      for (const pattern of FORBIDDEN_CONSTRUCTS) {
        const construct = pattern.exec(masked);
        if (construct) violate("restricted_forbidden_construct", construct[0].replace(/\s+/g, " ").trim());
      }
      if (QUOTED_IDENTIFIER.test(masked)) violate("restricted_quoted_identifier");
      const placeholder = restrictedPlaceholderViolation(masked);
      if (placeholder) violate("restricted_forbidden_construct", placeholder);
      const source = tableSourceViolation(masked);
      if (source) violate("restricted_forbidden_construct", source);
    }
    if (text.includes(TENANT_PLACEHOLDER)) return { ...(bound ?? {}), auth_user_id: ctx.tenantKey };
    return bound;
  };

  const restrictedRead = async (input: Parameters<ClickHouseClientLike["query"]>[0], query_params: Record<string, unknown> | undefined) => {
    if (closed) throw new Error("ClickHouse reader is closed.");
    await semaphore.acquire();
    try {
      if (closed) throw new Error("ClickHouse reader is closed.");
      queryNumber += 1;
      return await client().query({
        ...input,
        ...(query_params ? { query_params } : {}),
        // Fixed, whatever the caller passed: request code cannot relax them.
        settings: {
          max_execution_time: RESTRICTED_MAX_EXECUTION_SECONDS,
          timeout_overflow_mode: "throw",
          max_memory_usage: restrictedMaxMemoryBytes(),
          readonly: 2,
          cancel_http_readonly_queries_on_client_close: 1,
        },
        query_id: `sub_${requestId}_${queryNumber}`,
        signal: abort?.signal,
      });
    } finally {
      semaphore.release();
    }
  };

  const reader: ClickHouseClientLike = {
    async query(input): Promise<ClickHouseResultSet> {
      const query_params = guardStatement(input.query, input.query_params);
      if (restricted) return restrictedRead(input, query_params);
      return client().query({ ...input, ...(query_params ? { query_params } : {}) });
    },
    async command(input): Promise<void> {
      if (restricted) violate("restricted_write");
      const query_params = guardStatement(input.query, input.query_params);
      await client().command({ ...input, ...(query_params ? { query_params } : {}) });
    },
    async insert(input): Promise<void> {
      if (restricted) {
        // A protected table keeps its Phase-1 code; any other target is still a write.
        const match = PROTECTED_TABLE_PATTERN.exec(String(input.table ?? ""));
        if (match) violate("restricted_protected_table", match[0]);
        violate("restricted_write", String(input.table ?? ""));
      }
      for (const row of input.values ?? []) {
        if (row && Object.prototype.hasOwnProperty.call(row, "auth_user_id") && String(row.auth_user_id) !== ctx.tenantKey) {
          violate("tenant_row_mismatch", String(input.table ?? ""));
        }
      }
      await client().insert(input);
    },
    async close(): Promise<void> {
      if (restricted && !closed) {
        closed = true;
        semaphore.rejectAll(new Error("ClickHouse reader is closed."));
        abort?.abort();
      }
      await transport?.close?.();
    },
  };
  scopedReaders.add(reader);
  return reader;
}
