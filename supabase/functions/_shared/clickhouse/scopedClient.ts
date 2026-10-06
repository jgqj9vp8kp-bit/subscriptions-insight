// ScopedReader: the only ClickHouse client request code ever receives (plan §13
// layer 2, D5). It wraps the raw transport and enforces, per request, what
// ~185 hand-written query sites used to get right one by one.
//
// Phase 1 rules:
//   1. Tenant binding. `{auth_user_id:String}` is ALWAYS ctx.tenantKey (the
//      workspace data_key). A caller that supplies any other auth_user_id —
//      e.g. a runner still passing the caller's own id — is a violation, not a
//      silent override, so a missed migration is loud instead of "working".
//   2. Restricted contexts (funnel scope ≠ all) may not touch a protected table
//      at all yet: every reference is a violation. Phase 2 relaxes this to
//      "only inside a fragment registered by a scopeSql.ts helper".
//   3. Inserts: every row that carries auth_user_id must carry ctx.tenantKey.
//
// A violation is RECORDED on ctx.violations before it is thrown. The serve
// wrapper turns a non-empty list into a 500 even when inner code swallows the
// throw (there are `.catch(() => [])` sites in the cohort runners) — rule R7.
// Runners must rethrow it: `if (error instanceof ScopeViolation) throw error`.

import type { ClickHouseClientLike, ClickHouseResultSet } from "./types.ts";
import type { AccessContext } from "../access/accessContext.ts";
import { internalCreateClickHouseClient } from "./client.ts";

/** Protected tables (plan §13): every fact / Facebook / raw table, including
 * `_rebuild` / `_legacy` copies and backticked or `db.`-qualified forms. Matched
 * case-insensitively — stricter than ClickHouse itself, which is the safe side. */
export const PROTECTED_TABLE_PATTERN =
  /\b(analytics_transactions|fact_\w+|facebook_\w+|v_fb_\w+|v_channel_\w+|dim_facebook_\w+|raw_facebook_api_responses|analytics_validation_source_ids)\w*/i;

const TENANT_PLACEHOLDER = "{auth_user_id:";

export type ScopeViolationCode = "tenant_param_mismatch" | "tenant_row_mismatch" | "restricted_protected_table";

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

export function createScopedReader(ctx: AccessContext, raw?: ClickHouseClientLike): ClickHouseClientLike {
  let transport: ClickHouseClientLike | null = raw ?? null;
  // Lazily: building the reader must not require ClickHouse secrets (actions
  // that never query, unit tests); the first query does.
  const client = () => (transport ??= internalCreateClickHouseClient());

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
    if (ctx.restricted) {
      const match = PROTECTED_TABLE_PATTERN.exec(text);
      if (match) violate("restricted_protected_table", match[0]);
    }
    if (text.includes(TENANT_PLACEHOLDER)) return { ...(bound ?? {}), auth_user_id: ctx.tenantKey };
    return bound;
  };

  const reader: ClickHouseClientLike = {
    async query(input): Promise<ClickHouseResultSet> {
      const query_params = guardStatement(input.query, input.query_params);
      return client().query({ ...input, ...(query_params ? { query_params } : {}) });
    },
    async command(input): Promise<void> {
      const query_params = guardStatement(input.query, input.query_params);
      await client().command({ ...input, ...(query_params ? { query_params } : {}) });
    },
    async insert(input): Promise<void> {
      if (ctx.restricted) {
        const match = PROTECTED_TABLE_PATTERN.exec(String(input.table ?? ""));
        if (match) violate("restricted_protected_table", match[0]);
      }
      for (const row of input.values ?? []) {
        if (row && Object.prototype.hasOwnProperty.call(row, "auth_user_id") && String(row.auth_user_id) !== ctx.tenantKey) {
          violate("tenant_row_mismatch", String(input.table ?? ""));
        }
      }
      await client().insert(input);
    },
    async close(): Promise<void> {
      await transport?.close?.();
    },
  };
  scopedReaders.add(reader);
  return reader;
}
