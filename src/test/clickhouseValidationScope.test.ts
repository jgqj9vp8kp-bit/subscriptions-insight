import { describe, expect, it } from "vitest";
import { validateTransactions } from "../../supabase/functions/_shared/clickhouse/validation.ts";
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

// Regression coverage for the production validation FAIL where the source scan
// stopped after a single page. Supabase/PostgREST enforces a server-side
// `max-rows` cap, so `.limit(2000)` can return fewer rows than requested while
// more remain in the imported cursor range. The old `sourceSnapshot` treated a
// short page as "end of data", so it compared ~1,000 source rows against the
// full ClickHouse range and reported thousands of false extra_in_clickhouse ids
// plus a large phantom revenue difference. These tests simulate the page cap.

const AUTH_USER = "auth_user_scope";

function buildRows(count: number): SupabaseTransactionRow[] {
  const rows: SupabaseTransactionRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const seq = String(index).padStart(5, "0");
    const updated = new Date(Date.UTC(2026, 4, 1, 0, 0, 0, 0) + index * 1000).toISOString();
    rows.push({
      auth_user_id: AUTH_USER,
      user_id: `u_${seq}`,
      transaction_id: `tx_${seq}`,
      import_batch_id: "batch",
      source: "test",
      event_time: updated,
      status: "success",
      transaction_type: "trial",
      amount_gross: 10,
      amount_net: 10,
      amount_refunded: 0,
      currency: "USD",
      email: `x${seq}@example.com`,
      country_code: null,
      campaign_path: "path",
      funnel: "soulmate",
      source_name: "facebook",
      raw_payload: {},
      normalized_payload: {
        transaction_id: `tx_${seq}`,
        user_id: `u_${seq}`,
        event_time: updated,
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
      created_at: updated,
      updated_at: updated,
      deleted_at: null,
    });
  }
  return rows;
}

function sortRows(rows: SupabaseTransactionRow[]): SupabaseTransactionRow[] {
  return [...rows].sort((a, b) => {
    const au = a.updated_at ?? "";
    const bu = b.updated_at ?? "";
    if (au !== bu) return au < bu ? -1 : 1;
    return a.transaction_id.localeCompare(b.transaction_id);
  });
}

interface FakeOptions {
  rows: SupabaseTransactionRow[];
  pageCap: number;
  cursor: { cursor_updated_at: string; cursor_transaction_id: string };
  onPage: () => void;
}

class TransactionsBuilder implements SupabaseQueryBuilder {
  private limitValue = 1000;
  private ors: string[] = [];
  private upperLte: string | null = null;

  constructor(private readonly opts: FakeOptions, private readonly sorted: SupabaseTransactionRow[]) {}

  select(): SupabaseQueryBuilder {
    return this;
  }
  eq(): SupabaseQueryBuilder {
    return this;
  }
  is(): SupabaseQueryBuilder {
    return this;
  }
  order(): SupabaseQueryBuilder {
    return this;
  }
  in(): SupabaseQueryBuilder {
    return this;
  }
  limit(count: number): SupabaseQueryBuilder {
    this.limitValue = count;
    return this;
  }
  or(filters: string): SupabaseQueryBuilder {
    this.ors.push(filters);
    return this;
  }
  lte(_column: string, value: unknown): SupabaseQueryBuilder {
    this.upperLte = String(value);
    return this;
  }
  maybeSingle(): Promise<SupabaseQueryResult> {
    return Promise.resolve({ data: null, error: null });
  }
  upsert(): Promise<SupabaseQueryResult> {
    return Promise.resolve({ data: null, error: null });
  }

  private page(): SupabaseTransactionRow[] {
    let data = this.sorted;
    if (this.upperLte) {
      const upper = this.upperLte;
      data = data.filter((row) => (row.updated_at ?? "") <= upper);
    }
    const collate = (a: string, b: string) => a.localeCompare(b, "en-US");
    // Multiple .or() clauses are ANDed (PostgREST ANDs repeated top-level or=).
    for (const clause of this.ors) {
      const gt = /updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),transaction_id\.gt\.([^)]+)\)/.exec(clause);
      if (gt) {
        const [, greaterThan, equalTo, txGreaterThan] = gt;
        data = data.filter((row) => {
          const updated = row.updated_at ?? "";
          return updated > greaterThan || (updated === equalTo && collate(row.transaction_id, txGreaterThan) > 0);
        });
      }
      const lt = /updated_at\.lt\.([^,]+),and\(updated_at\.eq\.([^,]+),transaction_id\.lte\.([^)]+)\)/.exec(clause);
      if (lt) {
        const [, lessThan, equalTo, txLessEq] = lt;
        data = data.filter((row) => {
          const updated = row.updated_at ?? "";
          return updated < lessThan || (updated === equalTo && collate(row.transaction_id, txLessEq) <= 0);
        });
      }
    }
    this.opts.onPage();
    // Emulate the PostgREST server cap: never return more than `pageCap` rows,
    // even when the caller requested a larger `.limit()`.
    return data.slice(0, Math.min(this.limitValue, this.opts.pageCap));
  }

  then<TResult1 = SupabaseQueryResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve<SupabaseQueryResult>({ data: this.page(), error: null }).then(onfulfilled, onrejected);
  }
}

class SyncStateBuilder implements SupabaseQueryBuilder {
  constructor(private readonly cursor: { cursor_updated_at: string; cursor_transaction_id: string }) {}

  select(): SupabaseQueryBuilder {
    return this;
  }
  eq(): SupabaseQueryBuilder {
    return this;
  }
  is(): SupabaseQueryBuilder {
    return this;
  }
  order(): SupabaseQueryBuilder {
    return this;
  }
  in(): SupabaseQueryBuilder {
    return this;
  }
  limit(): SupabaseQueryBuilder {
    return this;
  }
  or(): SupabaseQueryBuilder {
    return this;
  }
  lte(): SupabaseQueryBuilder {
    return this;
  }
  maybeSingle(): Promise<SupabaseQueryResult> {
    return Promise.resolve({ data: this.cursor, error: null });
  }
  upsert(): Promise<SupabaseQueryResult> {
    return Promise.resolve({ data: null, error: null });
  }

  then<TResult1 = SupabaseQueryResult, TResult2 = never>(
    onfulfilled?: ((value: SupabaseQueryResult) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | undefined | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve<SupabaseQueryResult>({ data: null, error: null }).then(onfulfilled, onrejected);
  }
}

class FakeSupabase implements SupabaseLikeClient {
  private readonly sorted: SupabaseTransactionRow[];
  pages = 0;

  constructor(private readonly opts: Omit<FakeOptions, "onPage">) {
    this.sorted = sortRows(opts.rows);
  }

  from(table: string): SupabaseQueryBuilder {
    if (table === "transactions") {
      return new TransactionsBuilder({ ...this.opts, onPage: () => { this.pages += 1; } }, this.sorted);
    }
    return new SyncStateBuilder(this.opts.cursor);
  }
}

function aggregateMain(rows: ClickHouseTransactionRow[]): Record<string, number | string | null> {
  const sum = (project: (row: ClickHouseTransactionRow) => number) => rows.reduce((total, row) => total + project(row), 0);
  const eventTimes = rows.map((row) => row.event_time).sort();
  return {
    total_rows: rows.length,
    unique_transaction_ids: new Set(rows.map((row) => row.transaction_id)).size,
    unique_users: new Set(rows.map((row) => row.user_id)).size,
    min_event_time: eventTimes[0] ?? null,
    max_event_time: eventTimes[eventTimes.length - 1] ?? null,
    successful_payments: sum((row) => row.is_success),
    failed_payments: sum((row) => row.is_failed),
    trials: sum((row) => row.is_trial),
    first_subscriptions: sum((row) => row.is_first_subscription),
    renewals: sum((row) => row.is_renewal),
    upsells: sum((row) => row.is_upsell),
    token_purchases: sum((row) => row.is_token_purchase),
    refunds: sum((row) => row.is_refund),
    chargebacks: sum((row) => row.is_chargeback),
    gross_revenue_usd: sum((row) => Number(row.gross_amount_usd)),
    net_revenue_usd: sum((row) => Number(row.net_amount_usd)),
    refund_amount_usd: sum((row) => Number(row.refund_amount_usd)),
  };
}

function groupCount(rows: ClickHouseTransactionRow[], field: "currency" | "funnel" | "transaction_type") {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = String(row[field] || "unknown");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([key, value]) => ({ key, value }));
}

class FakeClickHouse implements ClickHouseClientLike {
  private readonly mapped: ClickHouseTransactionRow[];

  constructor(rows: SupabaseTransactionRow[]) {
    this.mapped = mapSupabaseTransactionsToClickHouse({ authUserId: AUTH_USER, rows }).rows;
  }

  query(input: { query: string }): Promise<ClickHouseResultSet> {
    const query = input.query;
    let out: unknown[];
    if (/GROUP BY currency/.test(query)) out = groupCount(this.mapped, "currency");
    else if (/GROUP BY funnel/.test(query)) out = groupCount(this.mapped, "funnel");
    else if (/GROUP BY transaction_type/.test(query)) out = groupCount(this.mapped, "transaction_type");
    else if (/GROUP BY transaction_id/.test(query)) out = this.mapped.map((row) => ({ transaction_id: row.transaction_id, count: 1 }));
    else out = [aggregateMain(this.mapped)];
    return Promise.resolve({ json: () => Promise.resolve(out) });
  }
  command(): Promise<void> {
    return Promise.resolve();
  }
  insert(): Promise<void> {
    return Promise.resolve();
  }
}

function cursorFor(rows: SupabaseTransactionRow[]) {
  const sorted = sortRows(rows);
  const last = sorted[sorted.length - 1];
  return { cursor_updated_at: last.updated_at as string, cursor_transaction_id: last.transaction_id };
}

describe("ClickHouse validation source scope (PostgREST max-rows regression)", () => {
  it("scans the full imported range even when the source page is capped below batch_size", async () => {
    const rows = buildRows(30);
    const supabase = new FakeSupabase({ rows, pageCap: 10, cursor: cursorFor(rows) });
    const clickhouse = new FakeClickHouse(rows);

    const result = await validateTransactions({
      authUserId: AUTH_USER,
      supabase,
      clickhouse,
      batchSize: 25, // larger than the 10-row server cap -> first page is short
      validationScope: "imported_cursor_range",
    });

    expect(result.source.total_rows).toBe(30);
    expect(result.clickhouse.total_rows).toBe(30);
    expect(result.reconciliation.missing_in_clickhouse).toHaveLength(0);
    expect(result.reconciliation.extra_in_clickhouse).toHaveLength(0);
    expect(result.reconciliation.duplicate_transaction_ids).toHaveLength(0);
    expect(result.status).toBe("PASS");
    // Proof the loop kept paging past the first short page instead of stopping.
    expect(supabase.pages).toBeGreaterThan(1);
  });

  it("does not fabricate extra_in_clickhouse ids or a revenue gap from an under-read source page", async () => {
    const rows = buildRows(40);
    const supabase = new FakeSupabase({ rows, pageCap: 10, cursor: cursorFor(rows) });
    const clickhouse = new FakeClickHouse(rows);

    const result = await validateTransactions({
      authUserId: AUTH_USER,
      supabase,
      clickhouse,
      batchSize: 2000, // the production default, far above the page cap
      validationScope: "imported_cursor_range",
    });

    expect(result.source.total_rows).toBe(40);
    expect(result.reconciliation.extra_in_clickhouse).toEqual([]);
    expect(result.source.gross_revenue_usd).toBe(result.clickhouse.gross_revenue_usd);
    expect(result.status).toBe("PASS");
  });

  it("still reconciles when the page cap is not hit (batch_size within the cap)", async () => {
    const rows = buildRows(12);
    const supabase = new FakeSupabase({ rows, pageCap: 1000, cursor: cursorFor(rows) });
    const clickhouse = new FakeClickHouse(rows);

    const result = await validateTransactions({
      authUserId: AUTH_USER,
      supabase,
      clickhouse,
      batchSize: 1000,
      validationScope: "imported_cursor_range",
    });

    expect(result.source.total_rows).toBe(12);
    expect(result.status).toBe("PASS");
  });
});
