// A service-role Supabase double that FAILS CLOSED (plan §29 "New helpers":
// "strictFakeSupabase.ts: throws on a tenant read without the owner predicate").
//
// Edge code talks to Postgres with the SERVICE-ROLE client, which bypasses RLS:
// the `.eq(<owner column>, <key>)` in the query is the ONLY tenant boundary. This
// fake knows, per table, which column owns a row and whose key must be there:
//   * "tenant" tables — the workspace data key (ctx.tenantKey);
//   * "actor"  tables — the calling member (ctx.actor.userId): saved objects,
//                       run ledgers, export logs;
//   * "global" tables — no owner predicate required (e.g. api_keys looked up by
//                       key hash, the singleton registry).
// A read / update / delete without the owner predicate, with a FOREIGN owner
// value, or widened by `.or(...)` — and an insert / upsert of a row owned by
// someone else — is a violation: it is recorded on `violations` and the query
// rejects with StrictSupabaseViolation (so a caller that swallows it still
// leaves a trace the test asserts on). Unknown tables and RPCs are violations
// too: a test must declare everything the code under test may touch.
//
// Reads are answered from in-memory rows filtered by the recorded eq / is / in
// predicates, so a handler that forgets a filter gets the wrong rows, not
// silently the right ones.

import type { SupabaseQueryResult } from "../../../supabase/functions/_shared/clickhouse/types.ts";

export type StrictTableScope = "tenant" | "actor" | "global";

export interface StrictTableSpec {
  scope: StrictTableScope;
  /** Owner column (required for tenant / actor tables). */
  owner?: string;
  rows?: Record<string, unknown>[];
}

export interface StrictRpcSpec {
  /** Parameter that must carry the tenant key (e.g. p_data_key). */
  tenantParam?: string;
  /** Parameter that must carry the actor key. */
  actorParam?: string;
  handler?(params: Record<string, unknown>): SupabaseQueryResult | Promise<SupabaseQueryResult>;
}

export interface StrictFakeSupabaseOptions {
  tenantKey: string;
  actorKey?: string | null;
  tables: Record<string, StrictTableSpec>;
  rpc?: Record<string, StrictRpcSpec>;
}

export type StrictOp = "select" | "insert" | "upsert" | "update" | "delete";

export interface StrictCall {
  table: string;
  op: StrictOp;
  columns: string | null;
  filters: Array<[string, string, unknown]>;
  values: unknown;
}

export class StrictSupabaseViolation extends Error {
  constructor(message: string) {
    super(`strictFakeSupabase: ${message}`);
    this.name = "StrictSupabaseViolation";
  }
}

const sameId = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && a.length > 0 && a.toLowerCase() === b.toLowerCase();

type Result = SupabaseQueryResult & { status?: number };

export interface StrictFakeSupabase {
  readonly calls: StrictCall[];
  readonly rpcCalls: Array<{ fn: string; params: Record<string, unknown> }>;
  readonly violations: string[];
  /** Rows written to `table` through insert / upsert. */
  inserted(table: string): Record<string, unknown>[];
  /** Calls to `table`. */
  callsTo(table: string): StrictCall[];
  from(table: string): StrictBuilder;
  rpc(fn: string, params?: Record<string, unknown>): Promise<SupabaseQueryResult>;
  auth: {
    getUser(token: string): Promise<{ data: { user: null }; error: { message: string } }>;
  };
}

export interface StrictBuilder extends PromiseLike<Result> {
  select(columns?: string, options?: Record<string, unknown>): StrictBuilder;
  eq(column: string, value: unknown): StrictBuilder;
  neq(column: string, value: unknown): StrictBuilder;
  is(column: string, value: unknown): StrictBuilder;
  in(column: string, values: unknown[]): StrictBuilder;
  lt(column: string, value: unknown): StrictBuilder;
  lte(column: string, value: unknown): StrictBuilder;
  gt(column: string, value: unknown): StrictBuilder;
  gte(column: string, value: unknown): StrictBuilder;
  like(column: string, pattern: string): StrictBuilder;
  or(filters: string): StrictBuilder;
  order(column: string, options?: Record<string, unknown>): StrictBuilder;
  limit(count: number): StrictBuilder;
  range(from: number, to: number): StrictBuilder;
  maybeSingle(): Promise<Result>;
  single(): Promise<Result>;
  insert(values: unknown, options?: Record<string, unknown>): StrictBuilder;
  upsert(values: unknown, options?: Record<string, unknown>): StrictBuilder;
  update(values: unknown): StrictBuilder;
  delete(): StrictBuilder;
}

export function createStrictFakeSupabase(options: StrictFakeSupabaseOptions): StrictFakeSupabase {
  const calls: StrictCall[] = [];
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const violations: string[] = [];
  const written = new Map<string, Record<string, unknown>[]>();
  const tables = new Map<string, StrictTableSpec>(
    Object.entries(options.tables).map(([name, spec]) => [name, { ...spec, rows: [...(spec.rows ?? [])] }]),
  );

  const violate = (message: string): StrictSupabaseViolation => {
    violations.push(message);
    return new StrictSupabaseViolation(message);
  };

  const expectedKey = (spec: StrictTableSpec): string | null => {
    if (spec.scope === "tenant") return options.tenantKey;
    if (spec.scope === "actor") return options.actorKey ?? null;
    return null;
  };

  const rowsOf = (value: unknown): Record<string, unknown>[] =>
    (Array.isArray(value) ? value : [value]).filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");

  function check(call: StrictCall): StrictSupabaseViolation | null {
    const spec = tables.get(call.table);
    if (!spec) return violate(`unknown table ${call.table} (${call.op})`);
    if (spec.scope === "global") return null;
    const owner = spec.owner ?? "";
    const expected = expectedKey(spec);
    if (!owner || !expected) return violate(`${call.table}: no ${spec.scope} key configured for ${call.op}`);

    if (call.op === "insert" || call.op === "upsert") {
      for (const row of rowsOf(call.values)) {
        if (!sameId(row[owner], expected)) return violate(`${call.table}: ${call.op} of a row owned by ${String(row[owner])} (expected ${spec.scope} key)`);
      }
      return null;
    }
    if (call.filters.some(([op]) => op === "or")) return violate(`${call.table}: .or() on a ${spec.scope}-owned table`);
    const ownerFilters = call.filters.filter(([op, column]) => (op === "eq" || op === "in") && column === owner);
    if (!ownerFilters.length) return violate(`${call.table}: ${call.op} without the ${owner} predicate`);
    for (const [op, , value] of ownerFilters) {
      const values = op === "in" ? (Array.isArray(value) ? value : [value]) : [value];
      if (!values.length || values.some((entry) => !sameId(entry, expected))) {
        return violate(`${call.table}: ${call.op} with a foreign ${owner} (${JSON.stringify(value)})`);
      }
    }
    return null;
  }

  function matches(row: Record<string, unknown>, filters: StrictCall["filters"]): boolean {
    return filters.every(([op, column, value]) => {
      const cell = row[column];
      switch (op) {
        case "eq":
          return typeof cell === "string" && typeof value === "string" ? cell.toLowerCase() === value.toLowerCase() : cell === value;
        case "neq":
          return cell !== value;
        case "is":
          return value === null ? cell === null || cell === undefined : cell === value;
        case "in":
          return Array.isArray(value) && value.some((entry) => entry === cell);
        default:
          return true;
      }
    });
  }

  function execute(call: StrictCall, mode: { limit: number | null; single: "maybe" | "one" | null }): Promise<Result> {
    calls.push(call);
    const failure = check(call);
    if (failure) return Promise.reject(failure);
    const spec = tables.get(call.table) as StrictTableSpec;
    const rows = spec.rows as Record<string, unknown>[];

    if (call.op === "insert" || call.op === "upsert") {
      const added = rowsOf(call.values).map((row) => ({ ...row }));
      rows.push(...added);
      written.set(call.table, [...(written.get(call.table) ?? []), ...added]);
      const data = mode.single ? added[0] ?? null : added;
      return Promise.resolve({ data, error: null });
    }
    const selected = rows.filter((row) => matches(row, call.filters));
    if (call.op === "update") {
      for (const row of selected) Object.assign(row, call.values as Record<string, unknown>);
      return Promise.resolve({ data: selected, error: null });
    }
    if (call.op === "delete") {
      for (const row of selected) rows.splice(rows.indexOf(row), 1);
      return Promise.resolve({ data: selected, error: null });
    }
    const limited = mode.limit === null ? selected : selected.slice(0, mode.limit);
    if (mode.single === "maybe") return Promise.resolve({ data: limited[0] ?? null, error: null });
    if (mode.single === "one") {
      return Promise.resolve(limited.length === 1 ? { data: limited[0], error: null } : { data: null, error: { message: `expected one row, got ${limited.length}` } });
    }
    return Promise.resolve({ data: limited.map((row) => ({ ...row })), error: null, count: selected.length });
  }

  function builder(table: string): StrictBuilder {
    const call: StrictCall = { table, op: "select", columns: null, filters: [], values: null };
    let limit: number | null = null;
    const filter = (op: string) => (column: string, value: unknown) => {
      call.filters.push([op, column, value]);
      return self;
    };
    const run = (single: "maybe" | "one" | null) => execute({ ...call, filters: [...call.filters] }, { limit, single });
    const self: StrictBuilder = {
      select(columns) {
        if (call.op === "select") call.columns = columns ?? "*";
        return self;
      },
      eq: filter("eq"),
      neq: filter("neq"),
      is: filter("is"),
      in: (column, values) => filter("in")(column, values),
      lt: filter("lt"),
      lte: filter("lte"),
      gt: filter("gt"),
      gte: filter("gte"),
      like: (column, pattern) => filter("like")(column, pattern),
      or(filters) {
        call.filters.push(["or", "", filters]);
        return self;
      },
      order: () => self,
      limit(count) {
        limit = count;
        return self;
      },
      range(from, to) {
        limit = to - from + 1;
        return self;
      },
      maybeSingle: () => run("maybe"),
      single: () => run("one"),
      insert(values) {
        call.op = "insert";
        call.values = values;
        return self;
      },
      upsert(values) {
        call.op = "upsert";
        call.values = values;
        return self;
      },
      update(values) {
        call.op = "update";
        call.values = values;
        return self;
      },
      delete() {
        call.op = "delete";
        return self;
      },
      then(onFulfilled, onRejected) {
        return run(null).then(onFulfilled, onRejected);
      },
    };
    return self;
  }

  return {
    calls,
    rpcCalls,
    violations,
    inserted: (table) => [...(written.get(table) ?? [])],
    callsTo: (table) => calls.filter((call) => call.table === table),
    from: (table) => builder(table),
    async rpc(fn, params = {}) {
      rpcCalls.push({ fn, params: { ...params } });
      const spec = options.rpc?.[fn];
      if (!spec) throw violate(`unknown rpc ${fn}`);
      if (spec.tenantParam && !sameId(params[spec.tenantParam], options.tenantKey)) {
        throw violate(`rpc ${fn}: ${spec.tenantParam} is not the tenant key (${JSON.stringify(params[spec.tenantParam])})`);
      }
      if (spec.actorParam && !sameId(params[spec.actorParam], options.actorKey)) {
        throw violate(`rpc ${fn}: ${spec.actorParam} is not the actor (${JSON.stringify(params[spec.actorParam])})`);
      }
      return spec.handler ? spec.handler(params) : { data: null, error: null };
    },
    auth: {
      // The gate never hands the service client's auth to handlers for user
      // lookups; a handler that tries gets "no user".
      getUser: async () => ({ data: { user: null }, error: { message: "strictFakeSupabase: auth.getUser is not available to handlers" } }),
    },
  };
}
