export interface ClickHouseResultSet {
  json(): Promise<unknown>;
}

export interface ClickHouseClientLike {
  query(input: {
    query: string;
    query_params?: Record<string, unknown>;
    format?: "JSONEachRow" | string;
  }): Promise<ClickHouseResultSet>;
  command(input: { query: string; query_params?: Record<string, unknown> }): Promise<void>;
  insert(input: {
    table: string;
    values: Record<string, unknown>[];
    format?: "JSONEachRow" | string;
  }): Promise<void>;
  close?(): Promise<void>;
}

export interface ClickHouseEnv {
  host: string;
  username: string;
  database: string;
  hasPassword: boolean;
}

export interface SupabaseQueryResult<T = unknown> {
  data?: T | null;
  count?: number | null;
  error?: { message: string } | null;
}

export interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  is(column: string, value: unknown): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  limit(count: number): SupabaseQueryBuilder;
  or(filters: string): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): SupabaseQueryBuilder;
  lte(column: string, value: unknown): SupabaseQueryBuilder;
  maybeSingle(): Promise<SupabaseQueryResult>;
  upsert(values: unknown, options?: Record<string, unknown>): Promise<SupabaseQueryResult>;
  /** Append-only history writes (Facebook Warehouse V2 Phase 1). Optional: fakes without them stay valid — the history layer is fail-safe. */
  insert?(values: unknown, options?: Record<string, unknown>): PromiseLike<SupabaseQueryResult>;
  update?(values: unknown): SupabaseQueryBuilder;
}

export interface SupabaseLikeClient {
  from(table: string): SupabaseQueryBuilder;
  rpc?(functionName: string, params?: Record<string, unknown>): Promise<SupabaseQueryResult>;
}

export interface SupabaseAuthClient extends SupabaseLikeClient {
  auth: {
    getUser(token: string): Promise<{
      data: { user?: { id?: string; email?: string | null } | null };
      error?: unknown;
    }>;
  };
}
