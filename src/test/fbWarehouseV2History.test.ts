// Facebook Warehouse V2 — Phase 1: append-only import history.
//
// Contract under test (spec §9):
// - append-only: runs/raw payloads/DQ are INSERT-only, no UPDATE, no DELETE;
// - every sync creates a NEW run row; every run creates a batch;
// - batch status machine staged → validated → published | rolled_back;
// - rollback never deletes data;
// - the history layer is fail-safe: the production sync completes identically
//   even when every history table is down (Phase 1 must not change behaviour).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runFacebookStatsSync,
  FacebookStatsValidationError,
  type CapsuledFetcher,
} from "../../supabase/functions/_shared/clickhouse/facebookStats.ts";
import {
  FB_BATCH_DQ_TABLE,
  FB_IMPORT_BATCHES_TABLE,
  FB_RAW_PAYLOADS_TABLE,
  FB_SYNC_RUNS_TABLE,
  computeFbBatchChecksum,
  computeFbBatchDq,
  createFbSyncHistoryRecorder,
  getFbBatchDq,
  listFbRawPayloads,
  listFbSyncRuns,
} from "../../supabase/functions/_shared/clickhouse/fbSyncHistory.ts";
import type { ClickHouseClientLike, SupabaseLikeClient } from "../../supabase/functions/_shared/clickhouse/types.ts";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/202607190001_create_facebook_warehouse_v2_history.sql",
);

const HISTORY_TABLES = [FB_SYNC_RUNS_TABLE, FB_IMPORT_BATCHES_TABLE, FB_RAW_PAYLOADS_TABLE, FB_BATCH_DQ_TABLE];

// ---- fakes -------------------------------------------------------------------

interface CapturedOp {
  table: string;
  op: "insert" | "update" | "upsert";
  values: unknown;
  filters: Array<[string, unknown]>;
}

interface QueryCapture {
  table: string;
  filters: Array<[string, unknown]>;
  order?: [string, Record<string, unknown> | undefined];
  limit?: number;
}

function fakeSupabaseV2(options: {
  state?: Record<string, unknown> | null;
  /** Tables whose writes hard-fail — simulates the history layer being down. */
  failTables?: string[];
  /** Rows returned by read queries. */
  readRows?: unknown[];
} = {}) {
  const ops: CapturedOp[] = [];
  const queries: QueryCapture[] = [];
  const failTables = new Set(options.failTables ?? []);
  const client: SupabaseLikeClient = {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const capture: QueryCapture = { table, filters };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (col: string, v: unknown) => {
          filters.push([col, v]);
          return builder;
        },
        order: (col: string, opts?: Record<string, unknown>) => {
          capture.order = [col, opts];
          return builder;
        },
        limit: async (count: number) => {
          capture.limit = count;
          queries.push(capture);
          return { data: options.readRows ?? [], error: null };
        },
        maybeSingle: async () => {
          queries.push(capture);
          return { data: options.state ?? null, error: null };
        },
        upsert: async (values: unknown) => {
          ops.push({ table, op: "upsert", values, filters: [...filters] });
          return { data: values, error: null };
        },
        insert: async (values: unknown) => {
          if (failTables.has(table)) throw new Error(`${table} is down`);
          ops.push({ table, op: "insert", values, filters: [...filters] });
          return { data: values, error: null };
        },
        update: (values: unknown) => {
          const thenable = {
            eq: (col: string, v: unknown) => {
              filters.push([col, v]);
              return thenable;
            },
            then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => {
              if (failTables.has(table)) return Promise.reject(new Error(`${table} is down`)).then(resolve, reject);
              ops.push({ table, op: "update", values, filters: [...filters] });
              return Promise.resolve({ data: values, error: null }).then(resolve, reject);
            },
          };
          return thenable;
        },
      };
      return builder as never;
    },
  };
  return { client, ops, queries };
}

function fakeClickHouse(options: { countSequence?: number[]; inserts?: unknown[] } = {}): ClickHouseClientLike {
  const counts = [...(options.countSequence ?? [0, 0])];
  return {
    command: async () => undefined,
    insert: async (input) => {
      options.inserts?.push(input);
    },
    query: async ({ query }) => ({
      json: async () => {
        if (query.includes("count() c FROM")) return [{ c: counts.length > 1 ? counts.shift() : counts[0] }];
        return [];
      },
    }),
  };
}

// Mimics the live-proven Capsuled behaviour (same fixture as fbWarehouse.test.ts):
// day level is per-date ground truth; entity levels are honest only for
// single-day windows.
const SAMPLE_ROW = {
  dateFrom: "2026-07-14",
  dateTo: "2026-07-14",
  adAccountId: "act_2486811861722169",
  adAccountName: "2-Soulmate-Reading-Ivan",
  buyer: "Ivan",
  campaignId: "120249115818080040",
  campaignName: "02,1 - Video Soulmate",
  spend: 100,
  fbPurchases: 5,
};
const ENVELOPE = {
  ok: true,
  currency: "USD",
  dataFreshness: { fbStatsTo: "2026-07-14", lastImportAt: "2026-07-15T09:38:45.048Z" },
};

function mergingFetcher(): CapsuledFetcher {
  return async (from, to, level) => {
    if (level === "day") {
      const rows = [
        { date: "2026-07-14", spend: 100, fbPurchases: 5 },
        { date: "2026-07-15", spend: 50, fbPurchases: 2 },
      ].filter((r) => r.date >= from && r.date <= to);
      return { envelope: { ...ENVELOPE, rows }, bytes: 300, latencyMs: 5 };
    }
    const spend = from === "2026-07-14" ? 100 : 50;
    return {
      envelope: { ...ENVELOPE, rows: [{ ...SAMPLE_ROW, dateFrom: from, dateTo: from, spend }] },
      bytes: 300,
      latencyMs: 5,
    };
  };
}

function syncInput(overrides: Partial<Parameters<typeof runFacebookStatsSync>[0]> = {}) {
  return {
    authUserId: "user-1",
    supabase: fakeSupabaseV2().client,
    clickhouse: fakeClickHouse({ countSequence: [0, 4] }),
    fetcher: mergingFetcher(),
    request: { mode: "incremental" as const, last_days: 2, levels: ["campaign", "day"] },
    now: new Date("2026-07-15T10:00:00.000Z"),
    ...overrides,
  };
}

const byTable = (ops: CapturedOp[], table: string) => ops.filter((op) => op.table === table);

// ---- sync integration: every run is recorded, pipeline unchanged ---------------

describe("append-only history: successful sync", () => {
  it("creates exactly one immutable run, one batch (staged→validated→published), raw payloads and a DQ report", async () => {
    const { client, ops } = fakeSupabaseV2();
    const chInserts: Array<{ values: unknown[] }> = [];
    const result = await runFacebookStatsSync(syncInput({
      supabase: client,
      clickhouse: fakeClickHouse({ countSequence: [0, 4], inserts: chInserts as unknown[] }),
    }));

    expect(result.status).toBe("completed");
    expect(result.history_errors).toBe(0);
    expect(result.history_run_id).toBeTruthy();
    expect(result.history_batch_id).toBeTruthy();

    // Runs: exactly ONE insert, never updated, never deleted.
    const runOps = byTable(ops, FB_SYNC_RUNS_TABLE);
    expect(runOps).toHaveLength(1);
    expect(runOps[0].op).toBe("insert");
    const run = runOps[0].values as Record<string, unknown>;
    expect(run.run_id).toBe(result.history_run_id);
    expect(run.batch_id).toBe(result.history_batch_id);
    expect(run.status).toBe("completed");
    expect(run.trigger_source).toBe("manual");
    expect(run.mode).toBe("incremental");
    expect(run.window_from).toBe("2026-07-14");
    expect(run.window_to).toBe("2026-07-15");
    expect(run.levels).toEqual(["campaign", "day"]);
    expect(run.api_requests).toBe(3); // 1 day scan + 2 single-day campaign fetches
    expect(run.api_failures).toBe(0);
    expect(run.rows_received).toBe(4);
    expect(run.warehouse_version).toBe(result.warehouse_version);
    expect(run.error_message).toBeNull();

    // Batch: one staged insert carrying the version BEFORE publish (spec §5),
    // then exactly the legal transitions as updates.
    const batchOps = byTable(ops, FB_IMPORT_BATCHES_TABLE);
    expect(batchOps.map((o) => o.op)).toEqual(["insert", "update", "update"]);
    const staged = batchOps[0].values as Record<string, unknown>;
    expect(staged.status).toBe("staged");
    expect(staged.version).toBe(result.warehouse_version);
    expect(staged.run_id).toBe(result.history_run_id);
    const validated = batchOps[1].values as Record<string, unknown>;
    expect(validated.status).toBe("validated");
    expect(validated.checksum).toMatch(/^fbck_/);
    const published = batchOps[2].values as Record<string, unknown>;
    expect(published.status).toBe("published");
    // Updates are scoped to this batch + user.
    expect(batchOps[1].filters).toEqual([["batch_id", result.history_batch_id], ["auth_user_id", "user-1"]]);

    // Raw payloads: verbatim envelope per API request.
    const rawOps = byTable(ops, FB_RAW_PAYLOADS_TABLE);
    expect(rawOps).toHaveLength(1);
    const rawRows = rawOps[0].values as Array<Record<string, unknown>>;
    expect(rawRows).toHaveLength(3);
    const dayRow = rawRows.find((r) => r.entity_level === "day")!;
    expect(dayRow.page).toBe(1);
    expect(dayRow.http_ok).toBe(true);
    expect((dayRow.payload_json as { rows: unknown[] }).rows).toHaveLength(2);
    const campaignPages = rawRows.filter((r) => r.entity_level === "campaign").map((r) => r.page).sort();
    expect(campaignPages).toEqual([1, 2]);
    expect(rawRows.every((r) => r.batch_id === result.history_batch_id)).toBe(true);

    // DQ report: computed automatically for the batch (spec §8).
    const dqOps = byTable(ops, FB_BATCH_DQ_TABLE);
    expect(dqOps).toHaveLength(1);
    const dq = dqOps[0].values as Record<string, unknown>;
    expect(dq.campaign_count).toBe(1);
    expect(dq.account_count).toBe(1);
    expect(dq.expected_days).toBe(2);
    expect(dq.covered_days).toBe(2);
    expect(dq.coverage_pct).toBe(100);
    expect(dq.duplicate_keys).toBe(0);
    expect(dq.missing_dates).toEqual([]);
    expect(dq.spend_total).toBe(150);
    expect(dq.purchases_total).toBe(7);

    // Append-only: no UPDATE/DELETE ever reaches runs, raw payloads or DQ.
    for (const table of [FB_SYNC_RUNS_TABLE, FB_RAW_PAYLOADS_TABLE, FB_BATCH_DQ_TABLE]) {
      expect(byTable(ops, table).every((op) => op.op === "insert")).toBe(true);
    }
    // No delete API exists in the recorder at all: only insert/update/upsert ops occur.
    expect(ops.every((op) => ["insert", "update", "upsert"].includes(op.op))).toBe(true);

    // The pipeline itself still wrote the V1 warehouse exactly once; the V2
    // dual-writer adds its own side-tables (registry/raw/facts/dq) beside it.
    expect(chInserts.filter((entry) => (entry as { table?: string }).table === "fact_facebook_stats")).toHaveLength(1);
  });

  it("every sync creates a NEW run and a NEW batch (no overwritten state)", async () => {
    const { client, ops } = fakeSupabaseV2();
    const first = await runFacebookStatsSync(syncInput({ supabase: client }));
    const second = await runFacebookStatsSync(syncInput({
      supabase: client,
      clickhouse: fakeClickHouse({ countSequence: [4, 4] }),
      now: new Date("2026-07-15T11:00:00.000Z"),
    }));

    expect(first.history_run_id).not.toBe(second.history_run_id);
    expect(first.history_batch_id).not.toBe(second.history_batch_id);
    expect(byTable(ops, FB_SYNC_RUNS_TABLE)).toHaveLength(2);
    expect(byTable(ops, FB_IMPORT_BATCHES_TABLE).filter((o) => o.op === "insert")).toHaveLength(2);
  });
});

describe("append-only history: failures are permanent records, not lost state", () => {
  it("validation failure → batch rolled_back (status change, nothing deleted), failed run inserted, no DQ", async () => {
    const { client, ops } = fakeSupabaseV2();
    const base = mergingFetcher();
    const lossy: CapsuledFetcher = async (from, to, level) => {
      const result = await base(from, to, level);
      if (level === "campaign" && from === "2026-07-15") return { ...result, envelope: { ...ENVELOPE, rows: [] } };
      return result;
    };
    const chInserts: unknown[] = [];
    await expect(runFacebookStatsSync(syncInput({
      supabase: client,
      clickhouse: fakeClickHouse({ countSequence: [0, 3], inserts: chInserts }),
      fetcher: lossy,
    }))).rejects.toBeInstanceOf(FacebookStatsValidationError);

    expect(chInserts.filter((entry) => (entry as { table?: string }).table === "fact_facebook_stats")).toHaveLength(0);
    const batchOps = byTable(ops, FB_IMPORT_BATCHES_TABLE);
    expect(batchOps.map((o) => o.op)).toEqual(["insert", "update"]);
    const rolledBack = batchOps[1].values as Record<string, unknown>;
    expect(rolledBack.status).toBe("rolled_back");
    expect(String(rolledBack.notes)).toContain("Spend mismatch");
    // Rollback deletes nothing: the staged insert and its raw payloads persist.
    expect(byTable(ops, FB_RAW_PAYLOADS_TABLE)).toHaveLength(1);
    expect(byTable(ops, FB_BATCH_DQ_TABLE)).toHaveLength(0);

    const runOps = byTable(ops, FB_SYNC_RUNS_TABLE);
    expect(runOps).toHaveLength(1);
    const run = runOps[0].values as Record<string, unknown>;
    expect(run.status).toBe("failed");
    expect(String(run.error_message)).toContain("Spend mismatch");
  });

  it("fetch failure → failed run recorded with the failing request captured (http_ok=false)", async () => {
    const { client, ops } = fakeSupabaseV2();
    const failing: CapsuledFetcher = async () => {
      throw new Error("Capsuled token rejected or expired.");
    };
    await expect(runFacebookStatsSync(syncInput({ supabase: client, fetcher: failing })))
      .rejects.toThrow("token rejected");

    const run = byTable(ops, FB_SYNC_RUNS_TABLE)[0].values as Record<string, unknown>;
    expect(run.status).toBe("failed");
    expect(run.api_failures).toBe(1);
    const rawRows = byTable(ops, FB_RAW_PAYLOADS_TABLE)[0].values as Array<Record<string, unknown>>;
    expect(rawRows[0].http_ok).toBe(false);
    expect(rawRows[0].payload_json).toEqual({ error: "Capsuled token rejected or expired." });
    const rolledBack = byTable(ops, FB_IMPORT_BATCHES_TABLE)[1].values as Record<string, unknown>;
    expect(rolledBack.status).toBe("rolled_back");
  });

  it("history layer completely down → the sync still completes identically (fail-safe contract)", async () => {
    const { client, ops } = fakeSupabaseV2({ failTables: HISTORY_TABLES });
    const chInserts: unknown[] = [];
    const result = await runFacebookStatsSync(syncInput({
      supabase: client,
      clickhouse: fakeClickHouse({ countSequence: [0, 4], inserts: chInserts }),
    }));

    expect(result.status).toBe("completed");
    expect(result.rows_inserted).toBe(4);
    expect(chInserts.filter((entry) => (entry as { table?: string }).table === "fact_facebook_stats")).toHaveLength(1);
    expect(result.history_errors).toBeGreaterThan(0);
    // The production state machine (upsert-based, pre-existing) still ran.
    const stateOps = byTable(ops, "clickhouse_transaction_sync_state");
    expect(stateOps.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(stateOps.at(-1)?.values)).toContain('"status":"completed"');
  });
});

// ---- recorder state machine -----------------------------------------------------

describe("recorder batch state machine", () => {
  function recorder(client: SupabaseLikeClient) {
    return createFbSyncHistoryRecorder({
      supabase: client,
      authUserId: "user-1",
      warehouseVersion: "fbwh_test",
      mode: "incremental",
      startedAtIso: "2026-07-15T10:00:00.000Z",
    });
  }

  it("rejects illegal transitions locally (publish before validate) — no UPDATE is issued", async () => {
    const { client, ops } = fakeSupabaseV2();
    const rec = recorder(client);
    await rec.stageBatch();
    await rec.markPublished();
    expect(byTable(ops, FB_IMPORT_BATCHES_TABLE).map((o) => o.op)).toEqual(["insert"]);
    expect(rec.errors.some((e) => e.includes("transition rejected"))).toBe(true);

    await rec.markValidated("fbck_x");
    await rec.markPublished();
    await rec.markRolledBack("manual rollback");
    const opsSeq = byTable(ops, FB_IMPORT_BATCHES_TABLE);
    expect(opsSeq.map((o) => o.op)).toEqual(["insert", "update", "update", "update"]);
    expect((opsSeq.at(-1)!.values as Record<string, unknown>).status).toBe("rolled_back");
    // Rollback is an update — the recorder has no delete path at all.
    expect(opsSeq.every((o) => o.op !== ("delete" as never))).toBe(true);
  });

  it("never transitions a batch that failed to stage", async () => {
    const { client, ops } = fakeSupabaseV2({ failTables: [FB_IMPORT_BATCHES_TABLE] });
    const rec = recorder(client);
    await rec.stageBatch();
    await rec.markValidated("fbck_x");
    await rec.markRolledBack("x");
    expect(byTable(ops, FB_IMPORT_BATCHES_TABLE)).toHaveLength(0);
    expect(rec.errors.length).toBeGreaterThan(0);
  });
});

// ---- DQ + checksum (pure) --------------------------------------------------------

describe("computeFbBatchDq", () => {
  const row = (patch: Partial<Parameters<typeof computeFbBatchDq>[0]["rows"][number]>) => ({
    level: "campaign" as const,
    stat_date: "2026-07-14",
    ad_account_id: "act_1",
    campaign_id: "c1",
    adset_id: "",
    ad_id: "",
    spend: 10,
    fb_purchases: 1,
    ...patch,
  });

  it("counts duplicates by business key and reports missing dates against the day scan", () => {
    const dq = computeFbBatchDq({
      rows: [row({}), row({}), row({ campaign_id: "c2" })],
      activeDays: ["2026-07-14", "2026-07-15", "2026-07-16"],
      daySpendTotal: 30,
    });
    expect(dq.duplicate_keys).toBe(1);
    expect(dq.duplicate_key_samples[0]).toContain("c1");
    expect(dq.campaign_count).toBe(2);
    expect(dq.expected_days).toBe(3);
    expect(dq.covered_days).toBe(1);
    expect(dq.coverage_pct).toBe(33.33);
    expect(dq.missing_dates).toEqual(["2026-07-15", "2026-07-16"]);
    expect(dq.spend_total).toBe(30);
    expect(dq.purchases_total).toBe(3); // no day level in rows → coverage level total
  });

  it("prefers day-level purchases as ground truth when present", () => {
    const dq = computeFbBatchDq({
      rows: [
        row({ level: "day", ad_account_id: "", campaign_id: "", fb_purchases: 7 }),
        row({ fb_purchases: 5 }),
      ],
      activeDays: ["2026-07-14"],
      daySpendTotal: 10,
    });
    expect(dq.purchases_total).toBe(7);
    expect(dq.coverage_pct).toBe(100);
  });
});

describe("computeFbBatchChecksum", () => {
  const a = { level: "campaign" as const, stat_date: "2026-07-14", ad_account_id: "act_1", campaign_id: "c1", adset_id: "", ad_id: "", spend: 10, fb_purchases: 1 };
  const b = { ...a, campaign_id: "c2", spend: 20 };

  it("is order-insensitive and metric-sensitive", () => {
    expect(computeFbBatchChecksum([a, b])).toBe(computeFbBatchChecksum([b, a]));
    expect(computeFbBatchChecksum([a, b])).not.toBe(computeFbBatchChecksum([a, { ...b, spend: 21 }]));
    expect(computeFbBatchChecksum([a])).toMatch(/^fbck_[0-9a-z]+_1$/);
  });
});

// ---- read-only API helpers --------------------------------------------------------

describe("history read API (read-only, scoped, clamped)", () => {
  it("listFbSyncRuns scopes by auth_user_id, orders by started_at desc and clamps limit", async () => {
    const { client, queries } = fakeSupabaseV2({ readRows: [] });
    await listFbSyncRuns(client, "user-1", { limit: 10_000, status: "failed" });
    const q = queries[0];
    expect(q.table).toBe(FB_SYNC_RUNS_TABLE);
    expect(q.filters).toContainEqual(["auth_user_id", "user-1"]);
    expect(q.filters).toContainEqual(["status", "failed"]);
    expect(q.order).toEqual(["started_at", { ascending: false }]);
    expect(q.limit).toBe(200);
  });

  it("raw payload access requires an explicit uuid — no unscoped dumps", async () => {
    const { client } = fakeSupabaseV2();
    await expect(listFbRawPayloads(client, "user-1", {})).rejects.toThrow("batch_id (uuid)");
    await expect(getFbBatchDq(client, "user-1", { batch_id: "not-a-uuid" })).rejects.toThrow("batch_id (uuid)");
  });

  it("payload_id path returns a single verbatim payload", async () => {
    const { client, queries } = fakeSupabaseV2({ state: { payload_id: "p", payload_json: { ok: true } } });
    const payload = await listFbRawPayloads(client, "user-1", { payload_id: "123e4567-e89b-42d3-a456-426614174000" });
    expect((payload as Record<string, unknown>).payload_json).toEqual({ ok: true });
    expect(queries[0].filters).toContainEqual(["auth_user_id", "user-1"]);
  });
});

// ---- migration DDL invariants -----------------------------------------------------

describe("migration DDL: append-only is enforced in the database, not by convention", () => {
  const sql = readFileSync(MIGRATION_PATH, "utf-8");

  it("creates all four history tables", () => {
    for (const table of HISTORY_TABLES) {
      expect(sql).toContain(`create table if not exists public.${table}`);
    }
  });

  it("blocks UPDATE and DELETE on runs, raw payloads and DQ for every role", () => {
    for (const table of [FB_SYNC_RUNS_TABLE, FB_RAW_PAYLOADS_TABLE, FB_BATCH_DQ_TABLE]) {
      expect(sql).toContain(`before update or delete on public.${table}`);
    }
    expect(sql).toContain("facebook_history_block_mutation");
    expect(sql).toContain("is append-only: % is not allowed");
  });

  it("protects batches: no DELETE, legal status transitions only, write-once fields, immutable identity", () => {
    expect(sql).toContain("before update or delete on public.facebook_import_batches");
    expect(sql).toContain("rollback is a status change, not a DELETE");
    expect(sql).toContain("illegal facebook_import_batches status transition");
    expect(sql).toContain("facebook_import_batches identity columns are immutable");
    expect(sql).toMatch(/status in \('staged', 'validated', 'published', 'rolled_back'\)/);
    expect(sql).toContain("checksum is write-once");
  });

  it("RLS: read-own only — no insert/update/delete policies exist for clients", () => {
    const policyCount = (sql.match(/create policy/g) ?? []).length;
    const selectPolicyCount = (sql.match(/for select/g) ?? []).length;
    expect(policyCount).toBe(4);
    expect(selectPolicyCount).toBe(4);
    expect(sql).not.toMatch(/for insert/);
    expect(sql).not.toMatch(/for update/i);
    expect(sql).not.toMatch(/create policy[^;]*for delete/);
  });
});
