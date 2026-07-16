import { describe, expect, it } from "vitest";
import { readSourceBatch } from "../../supabase/functions/_shared/clickhouse/validation.ts";
import type { SupabaseTransactionRow } from "../../supabase/functions/_shared/clickhouse/transactionMapper.ts";
import type { SupabaseLikeClient, SupabaseQueryBuilder, SupabaseQueryResult } from "../../supabase/functions/_shared/clickhouse/types.ts";

// Regression coverage for the production cursor-boundary collation bug. At the
// shared upper-cursor timestamp, the validator's source scan must include only
// transaction_ids <= cursor by the DATABASE's en_US.UTF-8 collation (matching the
// backfill / ORDER BY), NOT by JavaScript UTF-16/bytewise ordering. The fake below
// models the database: it evaluates the compound .or() bounds with en_US collation
// and offers a coarse .lte() (the pre-fix path). The current server-side
// implementation passes; the old ".lte + JS bytewise filter" would admit the
// collation-after ids (ZZisMkVai, lXBzWUQJA) and fail these assertions.

const TS = "2026-05-26 20:05:06.603829+00";        // exact production upper-cursor timestamp
const TS_BEFORE = "2026-05-26 20:05:06.603828+00"; // one microsecond earlier
const CURSOR = "lvlBWj8XF";                          // exact production cursor transaction_id

function row(transaction_id: string, updated_at: string): SupabaseTransactionRow {
  return {
    auth_user_id: "auth",
    user_id: `u_${transaction_id}`,
    transaction_id,
    event_time: "2026-05-26T00:00:00.000Z",
    status: "success",
    transaction_type: "trial",
    amount_gross: 1,
    amount_net: 1,
    amount_refunded: 0,
    currency: "USD",
    normalized_payload: {},
    raw_payload: {},
    created_at: updated_at,
    updated_at,
    deleted_at: null,
  };
}

const collate = (a: string, b: string) => a.localeCompare(b, "en-US");

class TxFake implements SupabaseLikeClient {
  constructor(private readonly rows: SupabaseTransactionRow[]) {}

  from(): SupabaseQueryBuilder {
    const rows = this.rows;
    const state = { limit: 1000, ors: [] as string[], lte: null as string | null };
    const builder = {
      select: () => builder,
      eq: () => builder,
      is: () => builder,
      order: () => builder,
      in: () => builder,
      limit: (n: number) => { state.limit = n; return builder; },
      or: (f: string) => { state.ors.push(f); return builder; },
      lte: (_c: string, v: unknown) => { state.lte = String(v); return builder; },
      maybeSingle: () => Promise.resolve({ data: null, error: null } as SupabaseQueryResult),
      upsert: () => Promise.resolve({ data: null, error: null } as SupabaseQueryResult),
      then<R1 = SupabaseQueryResult, R2 = never>(
        onfulfilled?: ((value: SupabaseQueryResult) => R1 | PromiseLike<R1>) | undefined | null,
        onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | undefined | null,
      ): Promise<R1 | R2> {
        let data = [...rows].sort((a, b) => {
          const au = a.updated_at ?? "";
          const bu = b.updated_at ?? "";
          if (au !== bu) return au < bu ? -1 : 1;
          return collate(a.transaction_id, b.transaction_id);
        });
        if (state.lte) {
          const upper = state.lte;
          data = data.filter((r) => (r.updated_at ?? "") <= upper);
        }
        for (const clause of state.ors) {
          const gt = /updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),transaction_id\.gt\.([^)]+)\)/.exec(clause);
          if (gt) {
            const [, a, b, c] = gt;
            data = data.filter((r) => { const u = r.updated_at ?? ""; return u > a || (u === b && collate(r.transaction_id, c) > 0); });
          }
          const lt = /updated_at\.lt\.([^,]+),and\(updated_at\.eq\.([^,]+),transaction_id\.lte\.([^)]+)\)/.exec(clause);
          if (lt) {
            const [, a, b, c] = lt;
            data = data.filter((r) => { const u = r.updated_at ?? ""; return u < a || (u === b && collate(r.transaction_id, c) <= 0); });
          }
        }
        return Promise.resolve<SupabaseQueryResult>({ data: data.slice(0, state.limit), error: null }).then(onfulfilled, onrejected);
      },
    } as unknown as SupabaseQueryBuilder;
    return builder;
  }
}

describe("validator cursor-boundary collation (en_US.UTF-8, not JS bytewise)", () => {
  // Mixed-case ids sharing the exact cursor timestamp, plus one row before it.
  const atTs = ["Ab000", "ZZisMkVai", CURSOR, "lXBzWUQJA", "lvaaa", "zzzzz"].map((id) => row(id, TS));
  const before = row("zzzzz2", TS_BEFORE); // strictly before boundary -> always in range

  it("1-5. upper bound includes only collation<=cursor; excludes bytewise<= but collation> ids", async () => {
    const fake = new TxFake([...atTs, before]);
    const rows = await readSourceBatch({
      supabase: fake,
      authUserId: "auth",
      batchSize: 100,
      cursorUpdatedAt: null,
      cursorTransactionId: null,
      upperCursor: { cursor_updated_at: TS, cursor_transaction_id: CURSOR },
    });
    const got = rows.map((r) => r.transaction_id);

    // Included: cursor itself, collation<cursor rows, and the strictly-earlier row.
    expect(got).toContain(CURSOR);
    expect(got).toContain("Ab000");
    expect(got).toContain("lvaaa");
    expect(got).toContain("zzzzz2");
    // Excluded: sort AFTER cursor in en_US collation even though bytewise <= cursor.
    expect(got).not.toContain("ZZisMkVai");
    expect(got).not.toContain("lXBzWUQJA");
    expect(got).not.toContain("zzzzz");
    expect(got).toHaveLength(4);

    // Sanity: these two ARE bytewise<=cursor (why the old JS filter wrongly kept them)
    // but collation>cursor (why the DB / backfill correctly excludes them).
    expect("ZZisMkVai" <= CURSOR).toBe(true);
    expect("lXBzWUQJA" <= CURSOR).toBe(true);
    expect(collate("ZZisMkVai", CURSOR) > 0).toBe(true);
    expect(collate("lXBzWUQJA", CURSOR) > 0).toBe(true);
  });

  it("9. lower bound (server-side, unchanged) resumes strictly after the cursor by collation", async () => {
    const fake = new TxFake(atTs);
    const rows = await readSourceBatch({
      supabase: fake,
      authUserId: "auth",
      batchSize: 100,
      cursorUpdatedAt: TS,
      cursorTransactionId: CURSOR,
      upperCursor: null,
    });
    const got = rows.map((r) => r.transaction_id);
    expect(got).not.toContain(CURSOR);   // gt excludes the cursor row itself
    expect(got).not.toContain("Ab000");  // collation<cursor -> not "after"
    expect(got).not.toContain("lvaaa");
    expect(got).toContain("ZZisMkVai");  // collation>cursor -> after
    expect(got).toContain("lXBzWUQJA");
    expect(got).toContain("zzzzz");
  });

  it("10. paginates equal-timestamp rows across pages: every row exactly once, in collation order", async () => {
    const many = Array.from({ length: 12 }, (_, i) => row(`t${String(i).padStart(2, "0")}${i % 2 ? "A" : "z"}`, TS));
    const upper = { cursor_updated_at: TS, cursor_transaction_id: "zzzzzzzzzz" }; // covers all ids
    const seen: string[] = [];
    let curU: string | null = null;
    let curT: string | null = null;
    for (let i = 0; i < 20; i += 1) {
      const page = await readSourceBatch({
        supabase: new TxFake(many),
        authUserId: "auth",
        batchSize: 3,
        cursorUpdatedAt: curU,
        cursorTransactionId: curT,
        upperCursor: upper,
      });
      if (!page.length) break;
      for (const r of page) seen.push(r.transaction_id);
      const last = page[page.length - 1];
      curU = last.updated_at ?? null;
      curT = last.transaction_id;
      if (page.length < 3) break;
    }
    expect(seen.length).toBe(many.length);          // no rows skipped
    expect(new Set(seen).size).toBe(many.length);   // no rows duplicated
    const collationSorted = [...seen].sort((a, b) => collate(a, b));
    expect(seen).toEqual(collationSorted);          // strictly ascending across page boundaries
  });
});
