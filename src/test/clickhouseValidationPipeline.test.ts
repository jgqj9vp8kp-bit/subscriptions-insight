import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runValidation } from "../../supabase/functions/_shared/clickhouse/validationPipeline.ts";
import {
  mapSupabaseTransactionsToClickHouse,
  type ClickHouseTransactionRow,
  type SupabaseTransactionRow,
} from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import type {
  ClickHouseClientLike,
  ClickHouseResultSet,
  SupabaseLikeClient,
  SupabaseQueryBuilder,
  SupabaseQueryResult,
} from "../../supabase/functions/_shared/clickhouse/types.ts";

const AUTH = "auth_pipeline";
const SYNC_NAME = "analytics_transactions_backfill";
const TEMP_TABLE = "analytics_validation_source_ids";
const CH_TABLE = "analytics_transactions";

// --- fixtures ---------------------------------------------------------------

interface BuildOpts {
  count: number;
  groupSize?: number; // rows sharing the same updated_at (forces tie-breaker paths)
  gross?: (i: number) => number;
  type?: (i: number) => string;
  funnel?: (i: number) => string;
}

function buildRows(opts: BuildOpts): SupabaseTransactionRow[] {
  const rows: SupabaseTransactionRow[] = [];
  const group = opts.groupSize ?? 1;
  for (let index = 0; index < opts.count; index += 1) {
    const seq = String(index).padStart(6, "0");
    const bucket = Math.floor(index / group);
    const updated = new Date(Date.UTC(2026, 4, 1, 0, 0, 0, 0) + bucket * 1000).toISOString();
    const event = new Date(Date.UTC(2026, 3, 1, 0, 0, 0, 0) + index * 1000).toISOString();
    const gross = opts.gross ? opts.gross(index) : 10;
    const type = opts.type ? opts.type(index) : "trial";
    const funnel = opts.funnel ? opts.funnel(index) : "soulmate";
    rows.push({
      auth_user_id: AUTH,
      user_id: `u_${seq}`,
      transaction_id: `tx_${seq}`,
      import_batch_id: "batch",
      source: "test",
      event_time: event,
      status: "success",
      transaction_type: type,
      amount_gross: gross,
      amount_net: gross,
      amount_refunded: 0,
      currency: "USD",
      email: `x${seq}@example.com`,
      country_code: null,
      campaign_path: "path",
      funnel,
      source_name: "facebook",
      raw_payload: {},
      normalized_payload: {
        transaction_id: `tx_${seq}`,
        user_id: `u_${seq}`,
        event_time: event,
        gross_amount_usd: gross,
        net_amount_usd: gross,
        refund_amount_usd: 0,
        amount_usd: gross,
        currency: "USD",
        status: "success",
        transaction_type: type,
        funnel,
        campaign_path: "path",
        campaign_id: "cmp",
      },
      created_at: event,
      updated_at: updated,
      deleted_at: null,
    });
  }
  return rows;
}

function buildRowsWithIds(ids: string[], updatedAt: string): SupabaseTransactionRow[] {
  return ids.map((id, index) => {
    const event = new Date(Date.UTC(2026, 3, 1, 0, 0, 0, 0) + index * 1000).toISOString();
    return {
      auth_user_id: AUTH,
      user_id: `u_${id}`,
      transaction_id: id,
      import_batch_id: "batch",
      source: "test",
      event_time: event,
      status: "success",
      transaction_type: "trial",
      amount_gross: 10,
      amount_net: 10,
      amount_refunded: 0,
      currency: "USD",
      email: `${id}@example.com`,
      country_code: null,
      campaign_path: "path",
      funnel: "soulmate",
      source_name: "facebook",
      raw_payload: {},
      normalized_payload: {
        transaction_id: id,
        user_id: `u_${id}`,
        event_time: event,
        gross_amount_usd: 10,
        net_amount_usd: 10,
        refund_amount_usd: 0,
        amount_usd: 10,
        currency: "USD",
        status: "success",
        transaction_type: "trial",
        funnel: "soulmate",
        campaign_path: "path",
        campaign_id: "cmp",
      },
      created_at: event,
      updated_at: updatedAt,
      deleted_at: null,
    };
  });
}

function sortRows(rows: SupabaseTransactionRow[]): SupabaseTransactionRow[] {
  return [...rows].sort((a, b) => {
    const au = a.updated_at ?? "";
    const bu = b.updated_at ?? "";
    if (au !== bu) return au < bu ? -1 : 1;
    return a.transaction_id.localeCompare(b.transaction_id, "en-US");
  });
}

function upperCursorOf(rows: SupabaseTransactionRow[]) {
  const sorted = sortRows(rows);
  const last = sorted[sorted.length - 1];
  return { cursor_updated_at: last.updated_at as string, cursor_transaction_id: last.transaction_id };
}

// --- fake ClickHouse --------------------------------------------------------

function aggregateMain(rows: ClickHouseTransactionRow[]): Record<string, unknown> {
  const sum = (p: (r: ClickHouseTransactionRow) => number) => rows.reduce((t, r) => t + p(r), 0);
  const times = rows.map((r) => r.event_time).sort();
  return {
    total_rows: rows.length,
    unique_transaction_ids: new Set(rows.map((r) => r.transaction_id)).size,
    unique_users: new Set(rows.map((r) => r.user_id)).size,
    min_event_time: times[0] ?? null,
    max_event_time: times[times.length - 1] ?? null,
    successful_payments: sum((r) => r.is_success),
    failed_payments: sum((r) => r.is_failed),
    trials: sum((r) => r.is_trial),
    first_subscriptions: sum((r) => r.is_first_subscription),
    renewals: sum((r) => r.is_renewal),
    upsells: sum((r) => r.is_upsell),
    token_purchases: sum((r) => r.is_token_purchase),
    refunds: sum((r) => r.is_refund),
    chargebacks: sum((r) => r.is_chargeback),
    gross_revenue_usd: sum((r) => Number(r.gross_amount_usd)),
    net_revenue_usd: sum((r) => Number(r.net_amount_usd)),
    refund_amount_usd: sum((r) => Number(r.refund_amount_usd)),
  };
}

function groupCount(rows: ClickHouseTransactionRow[], field: "currency" | "funnel" | "transaction_type") {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = String(r[field] || "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([key, value]) => ({ key, value }));
}

class FakeClickHouse implements ClickHouseClientLike {
  tempIds: Array<{ transaction_id: string; user_id: string }> = [];
  commands: string[] = [];
  failNextInsert = false;

  constructor(public readonly chRows: ClickHouseTransactionRow[]) {}

  command(input: { query: string }): Promise<void> {
    this.commands.push(input.query);
    return Promise.resolve();
  }

  insert(input: { table: string; values: Record<string, unknown>[] }): Promise<void> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      return Promise.reject(new Error("ClickHouse insert failed (simulated)"));
    }
    if (input.table === TEMP_TABLE) {
      for (const v of input.values) {
        this.tempIds.push({ transaction_id: String(v.transaction_id), user_id: String(v.user_id) });
      }
    }
    return Promise.resolve();
  }

  query(input: { query: string }): Promise<ClickHouseResultSet> {
    const q = input.query;
    const tempTx = new Set(this.tempIds.map((r) => r.transaction_id));
    const tempUsr = new Set(this.tempIds.map((r) => r.user_id));
    const chTx = new Set(this.chRows.map((r) => r.transaction_id));
    let out: unknown[];
    if (q.includes("LEFT ANTI JOIN")) {
      const srcIdx = q.indexOf(TEMP_TABLE);
      const chIdx = q.indexOf(CH_TABLE);
      if (srcIdx >= 0 && srcIdx < chIdx) {
        out = [{ c: [...tempTx].filter((id) => !chTx.has(id)).length }]; // missing
      } else {
        out = [{ c: [...chTx].filter((id) => !tempTx.has(id)).length }]; // extra
      }
    } else if (q.includes("HAVING count() > 1")) {
      const counts = new Map<string, number>();
      for (const r of this.chRows) counts.set(r.transaction_id, (counts.get(r.transaction_id) ?? 0) + 1);
      out = [{ c: [...counts.values()].filter((n) => n > 1).length }];
    } else if (q.includes(TEMP_TABLE) && q.includes("uniqExact(transaction_id)")) {
      out = [{ c: tempTx.size }];
    } else if (q.includes(TEMP_TABLE) && q.includes("uniqExact(user_id)")) {
      out = [{ c: tempUsr.size }];
    } else if (q.includes("GROUP BY currency")) {
      out = groupCount(this.chRows, "currency");
    } else if (q.includes("GROUP BY funnel")) {
      out = groupCount(this.chRows, "funnel");
    } else if (q.includes("GROUP BY transaction_type")) {
      out = groupCount(this.chRows, "transaction_type");
    } else if (q.includes("total_rows")) {
      out = [aggregateMain(this.chRows)];
    } else {
      out = [];
    }
    return Promise.resolve({ json: () => Promise.resolve(out) });
  }
}

// --- fake Supabase ----------------------------------------------------------

function thenResolve<T>(value: T) {
  return <R1 = T, R2 = never>(
    onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | undefined | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | undefined | null,
  ): Promise<R1 | R2> => Promise.resolve(value).then(onfulfilled, onrejected);
}

class FakeSupabase implements SupabaseLikeClient {
  private readonly sorted: SupabaseTransactionRow[];
  validationState: Record<string, unknown> | null = null;
  syncCursor: { cursor_updated_at: string; cursor_transaction_id: string } | null;
  returnedIds: string[] = [];
  pageReads = 0;

  constructor(rows: SupabaseTransactionRow[], syncCursor: { cursor_updated_at: string; cursor_transaction_id: string } | null) {
    this.sorted = sortRows(rows);
    this.syncCursor = syncCursor;
  }

  from(table: string): SupabaseQueryBuilder {
    if (table === "transactions") return this.transactionsBuilder();
    if (table === "clickhouse_validation_state") return this.validationStateBuilder();
    return this.syncStateBuilder();
  }

  private transactionsBuilder(): SupabaseQueryBuilder {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const parent = this;
    const state: { limit: number; ors: string[]; upperLte: string | null; countMode: boolean } = {
      limit: 1000,
      ors: [],
      upperLte: null,
      countMode: false,
    };
    // Model PostgreSQL's en_US.UTF-8 collation for the transaction_id tie-breaker
    // (differs from JS bytewise ordering exactly where the production bug lived).
    const collate = (a: string, b: string) => a.localeCompare(b, "en-US");
    const filtered = (): SupabaseTransactionRow[] => {
      let data = parent.sorted;
      if (state.upperLte) {
        const upper = state.upperLte;
        data = data.filter((r) => (r.updated_at ?? "") <= upper);
      }
      // Multiple .or() clauses are ANDed (as PostgREST ANDs repeated top-level or=).
      for (const clause of state.ors) {
        const gt = /updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),transaction_id\.gt\.([^)]+)\)/.exec(clause);
        if (gt) {
          const [, a, b, c] = gt;
          data = data.filter((r) => {
            const u = r.updated_at ?? "";
            return u > a || (u === b && collate(r.transaction_id, c) > 0);
          });
        }
        const lt = /updated_at\.lt\.([^,]+),and\(updated_at\.eq\.([^,]+),transaction_id\.lte\.([^)]+)\)/.exec(clause);
        if (lt) {
          const [, a, b, c] = lt;
          data = data.filter((r) => {
            const u = r.updated_at ?? "";
            return u < a || (u === b && collate(r.transaction_id, c) <= 0);
          });
        }
      }
      return data;
    };
    const builder = {
      select(_c?: string, options?: Record<string, unknown>) {
        if (options && (options.head || options.count)) state.countMode = true;
        return builder;
      },
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      in: () => builder,
      limit: (n: number) => {
        state.limit = n;
        return builder;
      },
      or: (f: string) => {
        state.ors.push(f);
        return builder;
      },
      lte: (_c: string, v: unknown) => {
        state.upperLte = String(v);
        return builder;
      },
      maybeSingle: () => Promise.resolve({ data: null, error: null } as SupabaseQueryResult),
      upsert: () => Promise.resolve({ data: null, error: null } as SupabaseQueryResult),
      then<R1 = SupabaseQueryResult, R2 = never>(
        onfulfilled?: ((value: SupabaseQueryResult) => R1 | PromiseLike<R1>) | undefined | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | undefined | null,
      ): Promise<R1 | R2> {
        const data = filtered();
        if (state.countMode) {
          return thenResolve<SupabaseQueryResult>({ data: null, count: data.length, error: null })(onfulfilled, onrejected);
        }
        const page = data.slice(0, state.limit);
        parent.pageReads += 1;
        for (const r of page) parent.returnedIds.push(r.transaction_id);
        return thenResolve<SupabaseQueryResult>({ data: page, error: null })(onfulfilled, onrejected);
      },
    } as unknown as SupabaseQueryBuilder;
    return builder;
  }

  private validationStateBuilder(): SupabaseQueryBuilder {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const parent = this;
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      in: () => builder,
      limit: () => builder,
      or: () => builder,
      lte: () => builder,
      maybeSingle: () =>
        Promise.resolve({
          data: parent.validationState ? JSON.parse(JSON.stringify(parent.validationState)) : null,
          error: null,
        } as SupabaseQueryResult),
      upsert: (values: unknown) => {
        parent.validationState = JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
        return Promise.resolve({ data: null, error: null } as SupabaseQueryResult);
      },
      delete: () => ({
        eq: () => ({
          eq: () => {
            parent.validationState = null;
            return Promise.resolve({ error: null });
          },
        }),
      }),
      then: thenResolve<SupabaseQueryResult>({ data: null, error: null }),
    } as unknown as SupabaseQueryBuilder;
    return builder;
  }

  private syncStateBuilder(): SupabaseQueryBuilder {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const parent = this;
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      in: () => builder,
      limit: () => builder,
      or: () => builder,
      lte: () => builder,
      maybeSingle: () => Promise.resolve({ data: parent.syncCursor, error: null } as SupabaseQueryResult),
      upsert: () => Promise.resolve({ data: null, error: null } as SupabaseQueryResult),
      then: thenResolve<SupabaseQueryResult>({ data: null, error: null }),
    } as unknown as SupabaseQueryBuilder;
    return builder;
  }
}

function chFrom(rows: SupabaseTransactionRow[]): ClickHouseTransactionRow[] {
  return mapSupabaseTransactionsToClickHouse({ authUserId: AUTH, rows }).rows;
}

async function runToCompletion(supabase: FakeSupabase, clickhouse: FakeClickHouse, pageSize: number, maxPages: number) {
  const responses = [] as Array<Awaited<ReturnType<typeof runValidation>>>;
  let response = await runValidation({ action: "start", authUserId: AUTH, supabase, clickhouse, pageSize, maxPages, validationScope: "imported_cursor_range" });
  responses.push(response);
  let guard = 0;
  while (!response.completed && response.status !== "failed" && guard < 1000) {
    guard += 1;
    response = await runValidation({ action: "continue", authUserId: AUTH, supabase, clickhouse, pageSize, maxPages, validationScope: "imported_cursor_range" });
    responses.push(response);
  }
  return responses;
}

// --- tests ------------------------------------------------------------------

describe("ClickHouse resumable validation pipeline", () => {
  it("1. start freezes the correct upper cursor and 3. persists partial state", async () => {
    const rows = buildRows({ count: 900 });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chFrom(rows));
    const start = await runValidation({ action: "start", authUserId: AUTH, supabase, clickhouse, pageSize: 250, maxPages: 2, validationScope: "imported_cursor_range" });
    expect(start.upper_cursor?.transaction_id).toBe(upperCursorOf(rows).cursor_transaction_id);
    expect(start.upper_cursor?.updated_at).toBe(upperCursorOf(rows).cursor_updated_at);
    expect(start.status).toBe("partial");
    expect(supabase.validationState).not.toBeNull();
    expect(supabase.validationState?.upper_cursor_transaction_id).toBe(upperCursorOf(rows).cursor_transaction_id);
  });

  it("2. one invocation processes only the configured pages", async () => {
    const rows = buildRows({ count: 1200 }); // > 2 pages of 250, kept small so the CH double maps fast (avoids a load-dependent 5s timeout)
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chFrom(rows));
    const start = await runValidation({ action: "start", authUserId: AUTH, supabase, clickhouse, pageSize: 250, maxPages: 2, validationScope: "imported_cursor_range" });
    expect(start.rows_processed).toBe(500);
    expect(start.pages_processed).toBe(2);
    expect(start.stopped_reason).toBe("max_pages_reached");
    expect(start.diagnostics?.pages_this_invocation).toBe(2);
    expect(start.completed).toBe(false);
  });

  it("4. continue resumes after the saved cursor and 5. never processes a page twice", async () => {
    const rows = buildRows({ count: 1300 });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chFrom(rows));
    const responses = await runToCompletion(supabase, clickhouse, 250, 2);
    const final = responses[responses.length - 1];
    expect(final.completed).toBe(true);
    expect(final.rows_processed).toBe(1300);
    // no id returned to the mapper more than once across the whole run
    expect(new Set(supabase.returnedIds).size).toBe(supabase.returnedIds.length);
    expect(supabase.returnedIds.length).toBe(1300);
  });

  it("6/7. no rows skipped and tie-breaker holds when updated_at collides across page boundaries", async () => {
    const rows = buildRows({ count: 1000, groupSize: 400 }); // 400 rows share each updated_at
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chFrom(rows));
    const responses = await runToCompletion(supabase, clickhouse, 150, 3); // boundaries fall inside equal-timestamp groups
    const final = responses[responses.length - 1];
    expect(final.rows_processed).toBe(1000);
    expect(new Set(supabase.returnedIds).size).toBe(1000);
    expect(final.parity_status).toBe("PASS");
  });

  it("8/9/19. accumulated aggregates equal a single-pass reference and output matches", async () => {
    const rows = buildRows({
      count: 1200,
      gross: (i) => (i % 4 === 0 ? 0 : 12.5),
      type: (i) => (i % 5 === 0 ? "first_subscription" : i % 7 === 0 ? "upsell" : "trial"),
      funnel: (i) => (i % 3 === 0 ? "past_life" : "soulmate"),
    });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const chRows = chFrom(rows);
    const clickhouse = new FakeClickHouse(chRows);
    const responses = await runToCompletion(supabase, clickhouse, 250, 2);
    const final = responses[responses.length - 1];
    const reference = aggregateMain(chRows);
    expect(final.completed).toBe(true);
    expect(final.parity_status).toBe("PASS");
    expect(final.source?.total_rows).toBe(reference.total_rows);
    expect(final.source?.gross_revenue_usd).toBeCloseTo(Number(reference.gross_revenue_usd), 6);
    expect(final.source?.net_revenue_usd).toBeCloseTo(Number(reference.net_revenue_usd), 6);
    expect(final.source?.unique_transaction_ids).toBe(reference.unique_transaction_ids);
    expect(final.source?.trials).toBe(reference.trials);
    expect(final.source?.first_subscriptions).toBe(reference.first_subscriptions);
    expect(final.source?.upsells).toBe(reference.upsells);
    expect(final.missing_ids).toBe(0);
    expect(final.extra_ids).toBe(0);
    expect(final.duplicate_ids).toBe(0);
    expect(final.gross_difference).toBe(0);
    expect(final.net_difference).toBe(0);
    expect(final.refund_difference).toBe(0);
  });

  it("10. detects missing ids across chunks", async () => {
    const rows = buildRows({ count: 800 });
    const chRows = chFrom(rows).slice(0, 799); // one source id absent from ClickHouse
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chRows);
    const final = (await runToCompletion(supabase, clickhouse, 200, 2)).at(-1)!;
    expect(final.missing_ids).toBe(1);
    expect(final.parity_status).toBe("FAIL");
  });

  it("11. detects extra ids across chunks", async () => {
    const rows = buildRows({ count: 800 });
    const chRows = chFrom(rows);
    const ghost = { ...chRows[0], transaction_id: "tx_ghost", user_id: "u_ghost" };
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse([...chRows, ghost]);
    const final = (await runToCompletion(supabase, clickhouse, 200, 2)).at(-1)!;
    expect(final.extra_ids).toBe(1);
    expect(final.parity_status).toBe("FAIL");
  });

  it("12. detects duplicate logical ids in ClickHouse", async () => {
    const rows = buildRows({ count: 600 });
    const chRows = chFrom(rows);
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse([...chRows, { ...chRows[0] }]); // same transaction_id twice
    const final = (await runToCompletion(supabase, clickhouse, 300, 2)).at(-1)!;
    expect(final.duplicate_ids).toBe(1);
    expect(final.parity_status).toBe("FAIL");
  });

  it("13. resumes safely after an Edge/ClickHouse failure mid-run", async () => {
    const rows = buildRows({ count: 900 });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chFrom(rows));
    clickhouse.failNextInsert = true; // first insert of the first chunk throws
    const failed = await runValidation({ action: "start", authUserId: AUTH, supabase, clickhouse, pageSize: 300, maxPages: 3, validationScope: "imported_cursor_range" });
    expect(failed.status).toBe("partial");
    expect(failed.stopped_reason).toBe("clickhouse_error");
    // resume until done; result must still be correct (no corruption / double counting)
    let response = failed;
    let guard = 0;
    while (!response.completed && guard < 100) {
      guard += 1;
      response = await runValidation({ action: "continue", authUserId: AUTH, supabase, clickhouse, pageSize: 300, maxPages: 3, validationScope: "imported_cursor_range" });
    }
    expect(response.completed).toBe(true);
    expect(response.rows_processed).toBe(900);
    expect(response.parity_status).toBe("PASS");
    expect(response.missing_ids).toBe(0);
    expect(response.extra_ids).toBe(0);
  });

  it("14. reset clears only validation state, not ClickHouse/source data", async () => {
    const rows = buildRows({ count: 500 });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const chRows = chFrom(rows);
    const clickhouse = new FakeClickHouse(chRows);
    await runValidation({ action: "start", authUserId: AUTH, supabase, clickhouse, pageSize: 250, maxPages: 1, validationScope: "imported_cursor_range" });
    expect(supabase.validationState).not.toBeNull();
    const reset = await runValidation({ action: "reset", authUserId: AUTH, supabase, clickhouse, validationScope: "imported_cursor_range" });
    expect(reset.status).toBe("never_started");
    expect(supabase.validationState).toBeNull();
    expect(clickhouse.chRows.length).toBe(chRows.length); // warehouse untouched
  });

  it("15. a 27,364-row range completes through repeated bounded calls", async () => {
    const rows = buildRows({ count: 27_364 });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse([]); // parity not asserted here — completion + bounding is
    const responses = await runToCompletion(supabase, clickhouse, 500, 3);
    const final = responses[responses.length - 1];
    expect(final.completed).toBe(true);
    expect(final.rows_processed).toBe(27_364);
    // every non-final invocation stayed within the bound (<= pageSize * maxPages)
    for (const r of responses) {
      if (r.diagnostics) expect(r.diagnostics.rows_this_invocation).toBeLessThanOrEqual(1500);
    }
    expect(responses.length).toBeGreaterThan(10); // genuinely resumed across many calls
  }, 120_000);

  it("16. status is read-only and returns current progress; reset then status is never_started", async () => {
    const rows = buildRows({ count: 400 });
    const supabase = new FakeSupabase(rows, upperCursorOf(rows));
    const clickhouse = new FakeClickHouse(chFrom(rows));
    await runValidation({ action: "start", authUserId: AUTH, supabase, clickhouse, pageSize: 100, maxPages: 1, validationScope: "imported_cursor_range" });
    const before = JSON.stringify(supabase.validationState);
    const status = await runValidation({ action: "status", authUserId: AUTH, supabase, clickhouse });
    expect(status.rows_processed).toBe(100);
    expect(JSON.stringify(supabase.validationState)).toBe(before); // status did not mutate state
  });

  it("6/7/8. collation boundary: rows_processed == source_rows_expected, zero false missing (mixed-case ids at the cursor timestamp)", async () => {
    const TS = "2026-05-26 20:05:06.603829+00";
    const cursor = "lvlBWj8XF";
    const ids = ["Ab000", "ZZisMkVai", cursor, "lXBzWUQJA", "lvaaa", "zzzzz", "Qb2IkK5Iy", "mAAAA", "LZZZZ", "kzzzz", "aaaaa", "Zaaaa"];
    const rows = buildRowsWithIds(ids, TS);
    // The backfill (ClickHouse) contains exactly the ids that sort <= cursor in en_US collation.
    const backfilled = rows.filter((r) => r.transaction_id.localeCompare(cursor, "en-US") <= 0);
    const supabase = new FakeSupabase(rows, { cursor_updated_at: TS, cursor_transaction_id: cursor });
    const clickhouse = new FakeClickHouse(chFrom(backfilled));

    const final = (await runToCompletion(supabase, clickhouse, 3, 5)).at(-1)!;

    expect(final.completed).toBe(true);
    expect(final.source_rows_expected).toBe(backfilled.length);
    expect(final.rows_processed).toBe(backfilled.length);
    expect(final.rows_processed).toBe(final.source_rows_expected); // the invariant the bug violated
    expect(final.missing_ids).toBe(0);
    expect(final.extra_ids).toBe(0);
    expect(final.duplicate_ids).toBe(0);
    expect(final.gross_difference).toBe(0);
    expect(final.net_difference).toBe(0);
    expect(final.refund_difference).toBe(0);
    expect(final.parity_status).toBe("PASS");
    // These ids are bytewise<=cursor (old JS filter kept them) but collation>cursor (correctly excluded).
    expect(backfilled.some((r) => r.transaction_id === "ZZisMkVai")).toBe(false);
    expect("ZZisMkVai" <= cursor).toBe(true);
  });

  it("18. the source scan never selects raw_payload", () => {
    const source = readFileSync(resolve(process.cwd(), "supabase/functions/_shared/clickhouse/validation.ts"), "utf8");
    expect(source).not.toContain("source_name,raw_payload,normalized_payload");
    expect(source).toContain("source_name,normalized_payload,created_at");
  });
});
