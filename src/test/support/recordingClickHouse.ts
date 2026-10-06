// A ClickHouse transport double for the security suite (plan §29 "New helpers").
//
// It stands where the real FetchClickHouseClient sits — UNDER the ScopedReader
// (createScopedReader(ctx, recording)) — so every statement a handler issues
// has already passed the tenant / scope guard when it is recorded. Tests then
// assert on what actually reached "the warehouse":
//   * nothing at all for a refused request (403 / 503 / 400);
//   * the expected templates or counts for an admitted one, so an "allowed"
//     assertion can never pass vacuously because the handler ran no query;
//   * which tenant every {auth_user_id:String} was bound to.
//
// Pure: no network, no Deno, no secrets.

import type { ClickHouseClientLike, ClickHouseResultSet } from "../../../supabase/functions/_shared/clickhouse/types.ts";

export type RecordedKind = "query" | "command" | "insert";

export interface RecordedStatement {
  kind: RecordedKind;
  /** SQL text (query / command) or the synthetic "INSERT INTO <table>" (insert). */
  query: string;
  /** Bound parameters exactly as the transport received them. */
  params: Record<string, unknown>;
  format?: string;
  table?: string;
  values?: Record<string, unknown>[];
}

/** Rows returned for a query; a thrown error rejects the query (warehouse fault). */
export type ClickHouseResponder = (statement: RecordedStatement) => unknown[] | Promise<unknown[]>;

export interface RecordingClickHouse extends ClickHouseClientLike {
  readonly statements: RecordedStatement[];
  /** Number of close() calls (the gate closes the reader once per request). */
  readonly closed: number;
  /** Only the reads. */
  queries(): RecordedStatement[];
  /** Every distinct value bound to {auth_user_id:String} (and inserted rows' auth_user_id). */
  boundTenants(): string[];
  /** Replace the responder (default: every query returns []). */
  respondWith(responder: ClickHouseResponder): void;
  reset(): void;
}

export function createRecordingClickHouse(responder: ClickHouseResponder = () => []): RecordingClickHouse {
  const statements: RecordedStatement[] = [];
  let respond = responder;
  let closed = 0;

  const record = (statement: RecordedStatement) => {
    statements.push(statement);
    return statement;
  };

  const client: RecordingClickHouse = {
    statements,
    get closed() {
      return closed;
    },
    async query(input): Promise<ClickHouseResultSet> {
      const statement = record({ kind: "query", query: String(input.query ?? ""), params: { ...(input.query_params ?? {}) }, format: input.format });
      const rows = await respond(statement);
      return { json: async () => rows };
    },
    async command(input): Promise<void> {
      record({ kind: "command", query: String(input.query ?? ""), params: { ...(input.query_params ?? {}) } });
    },
    async insert(input): Promise<void> {
      record({
        kind: "insert",
        query: `INSERT INTO ${input.table}`,
        params: {},
        table: input.table,
        values: (input.values ?? []).map((row) => ({ ...row })),
        format: input.format,
      });
    },
    async close(): Promise<void> {
      closed += 1;
    },
    queries() {
      return statements.filter((statement) => statement.kind === "query");
    },
    boundTenants() {
      const tenants = new Set<string>();
      for (const statement of statements) {
        if (statement.params.auth_user_id !== undefined) tenants.add(String(statement.params.auth_user_id));
        for (const row of statement.values ?? []) {
          if (row && row.auth_user_id !== undefined) tenants.add(String(row.auth_user_id));
        }
      }
      return [...tenants].sort();
    },
    respondWith(next) {
      respond = next;
    },
    reset() {
      statements.length = 0;
      closed = 0;
    },
  };
  return client;
}

/** Asserts (by throwing, so it works inside and outside `expect`) that every
 * template matches at least one recorded statement, and returns how many
 * statements matched any template. Used to pin "this action really ran its SQL". */
export function assertStatementTemplates(recording: RecordingClickHouse, templates: readonly RegExp[]): number {
  const missing = templates.filter((template) => !recording.statements.some((statement) => template.test(statement.query)));
  if (missing.length) {
    const seen = recording.statements.map((statement) => statement.query.replace(/\s+/g, " ").slice(0, 160));
    throw new Error(`Expected ClickHouse statements matching ${missing.map(String).join(", ")}; saw: ${JSON.stringify(seen)}`);
  }
  return recording.statements.filter((statement) => templates.some((template) => template.test(statement.query))).length;
}

/** The SQL probe a test handler issues to prove which tenant the reader binds. */
export const TENANT_PROBE_SQL = "SELECT count() AS c FROM analytics_transactions FINAL WHERE auth_user_id = {auth_user_id:String}";
