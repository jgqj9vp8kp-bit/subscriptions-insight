// IndexedDB delta cache for the warehouse startup load: warm starts must
// reproduce EXACTLY what the network load would return — the cache may only
// make startup faster, never wronger. Deps are injected; no real IndexedDB
// or Supabase is touched.
import { describe, expect, it, vi } from "vitest";
import {
  WAREHOUSE_CACHE_DELTA_RELOAD_THRESHOLD,
  WAREHOUSE_CACHE_SCHEMA_VERSION,
  applyWarehouseDelta,
  isWarehouseCachePayloadUsable,
  loadWarehouseTransactionsCached,
  maxUpdatedAt,
  type WarehouseCacheDeps,
  type WarehouseCachePayload,
  type WarehouseCacheStore,
  type WarehouseDeltaRow,
} from "@/services/transactionWarehouseCache";
import type { WarehouseRecord } from "@/services/transactionWarehouse";

function payload(txId: string): Record<string, unknown> {
  return {
    transaction_id: txId,
    user_id: `u-${txId}`,
    email: `${txId}@example.com`,
    event_time: "2026-07-01T00:00:00Z",
    amount_usd: 10,
    gross_amount_usd: 10,
    net_amount_usd: 10,
    refund_amount_usd: 0,
    is_refunded: false,
    currency: "USD",
    status: "success",
    transaction_type: "subscription",
    funnel: "soulmate",
    campaign_path: "soulmate-1-sp",
    product: "Subscription",
    traffic_source: "facebook",
  };
}

function record(id: string, updatedAt: string): WarehouseRecord {
  return { id, updated_at: updatedAt, source: "funnelfox_api", normalized_payload: payload(id) };
}

function deltaRow(id: string, updatedAt: string, deletedAt: string | null = null): WarehouseDeltaRow {
  return { ...record(id, updatedAt), deleted_at: deletedAt };
}

function cachePayload(records: WarehouseRecord[], overrides: Partial<WarehouseCachePayload> = {}): WarehouseCachePayload {
  return {
    schema_version: WAREHOUSE_CACHE_SCHEMA_VERSION,
    auth_user_id: "user-1",
    saved_at: "2026-07-28T00:00:00+00:00",
    max_updated_at: maxUpdatedAt(records) ?? "",
    row_count: records.length,
    records,
    ...overrides,
  };
}

function memStore(initial: unknown = null) {
  const state = { value: initial, writes: 0 };
  const store: WarehouseCacheStore = {
    async read() {
      return state.value;
    },
    async write(p) {
      state.writes += 1;
      state.value = p;
    },
    async clear() {
      state.value = null;
    },
  };
  return { store, state };
}

function makeDeps(overrides: Partial<WarehouseCacheDeps> & { store: WarehouseCacheStore }): WarehouseCacheDeps {
  return {
    currentUserId: async () => "user-1",
    loadRecords: vi.fn(async () => []),
    countDeltaRows: async () => 0,
    fetchDeltaRows: async () => [],
    countServerRows: async () => null,
    now: () => "2026-07-29T00:00:00+00:00",
    ...overrides,
  };
}

const flushBackgroundWrites = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("maxUpdatedAt", () => {
  it("returns the lexicographic (= chronological) max and null when absent", () => {
    expect(maxUpdatedAt([])).toBeNull();
    expect(
      maxUpdatedAt([{ updated_at: "2026-07-01T00:00:00+00:00" }, { updated_at: "2026-07-02T00:00:00+00:00" }, { updated_at: "2026-06-30T00:00:00+00:00" }]),
    ).toBe("2026-07-02T00:00:00+00:00");
    expect(maxUpdatedAt([{ updated_at: "" }])).toBeNull();
  });
});

describe("isWarehouseCachePayloadUsable", () => {
  const records = [record("a", "2026-07-01T00:00:00+00:00")];
  it("accepts a well-formed payload for the same user", () => {
    expect(isWarehouseCachePayloadUsable(cachePayload(records), "user-1")).toBe(true);
  });
  it("rejects other users, schema drift, count drift and empties", () => {
    expect(isWarehouseCachePayloadUsable(cachePayload(records), "user-2")).toBe(false);
    expect(isWarehouseCachePayloadUsable(cachePayload(records, { schema_version: 999 }), "user-1")).toBe(false);
    expect(isWarehouseCachePayloadUsable(cachePayload(records, { row_count: 5 }), "user-1")).toBe(false);
    expect(isWarehouseCachePayloadUsable(cachePayload([]), "user-1")).toBe(false);
    expect(isWarehouseCachePayloadUsable(null, "user-1")).toBe(false);
    expect(isWarehouseCachePayloadUsable("junk", "user-1")).toBe(false);
  });
});

describe("applyWarehouseDelta", () => {
  const base = [record("a", "2026-07-01T00:00:00+00:00"), record("b", "2026-07-02T00:00:00+00:00")];

  it("upserts new and changed rows, keyed by id", () => {
    const applied = applyWarehouseDelta(base, [
      deltaRow("b", "2026-07-03T00:00:00+00:00"), // changed
      deltaRow("c", "2026-07-04T00:00:00+00:00"), // new
    ]);
    expect(applied.changed).toBe(true);
    expect(applied.upserts).toBe(2);
    expect(applied.deletes).toBe(0);
    const ids = applied.records.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
    expect(applied.records.find((r) => r.id === "b")?.updated_at).toBe("2026-07-03T00:00:00+00:00");
  });

  it("re-reading the gte-cursor boundary row is a no-op (changed=false)", () => {
    const applied = applyWarehouseDelta(base, [deltaRow("b", "2026-07-02T00:00:00+00:00")]);
    expect(applied.changed).toBe(false);
    expect(applied.records).toEqual(base);
  });

  it("purges soft-deleted rows and rows whose payload vanished; tombstone field never leaks into the cache", () => {
    const applied = applyWarehouseDelta(base, [
      deltaRow("a", "2026-07-05T00:00:00+00:00", "2026-07-05T00:00:00+00:00"),
      { ...deltaRow("b", "2026-07-06T00:00:00+00:00"), normalized_payload: null },
      deltaRow("d", "2026-07-07T00:00:00+00:00"),
    ]);
    expect(applied.deletes).toBe(2);
    expect(applied.upserts).toBe(1);
    expect(applied.records.map((r) => r.id)).toEqual(["d"]);
    expect("deleted_at" in (applied.records[0] as unknown as Record<string, unknown>)).toBe(false);
  });

  it("deleting a row the cache never had counts nothing", () => {
    const applied = applyWarehouseDelta(base, [deltaRow("zzz", "2026-07-05T00:00:00+00:00", "2026-07-05T00:00:00+00:00")]);
    expect(applied.deletes).toBe(0);
    expect(applied.changed).toBe(false);
    expect(applied.records.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("loadWarehouseTransactionsCached", () => {
  const coldRecords = [record("a", "2026-07-01T00:00:00+00:00"), record("b", "2026-07-02T00:00:00+00:00")];

  it("cold start: loads over the network, returns hydrated rows and seeds the cache", async () => {
    const { store, state } = memStore();
    const loadRecords = vi.fn(async () => coldRecords);
    const deps = makeDeps({ store, loadRecords });

    const txs = await loadWarehouseTransactionsCached({ totalRowsExpected: 2 }, deps);
    await flushBackgroundWrites();

    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect(txs.map((t) => t.transaction_id).sort()).toEqual(["a", "b"]);
    expect(state.writes).toBe(1);
    const saved = state.value as WarehouseCachePayload;
    expect(saved.schema_version).toBe(WAREHOUSE_CACHE_SCHEMA_VERSION);
    expect(saved.auth_user_id).toBe("user-1");
    expect(saved.max_updated_at).toBe("2026-07-02T00:00:00+00:00");
    expect(saved.row_count).toBe(2);
  });

  it("warm start with no changes: serves from cache without the record loader and without rewriting", async () => {
    const { store, state } = memStore(cachePayload(coldRecords));
    const loadRecords = vi.fn(async () => coldRecords);
    const deps = makeDeps({
      store,
      loadRecords,
      countDeltaRows: async () => 1, // the gte-cursor boundary row itself
      fetchDeltaRows: async () => [deltaRow("b", "2026-07-02T00:00:00+00:00")],
      countServerRows: async () => 2,
    });

    const progress: number[] = [];
    const txs = await loadWarehouseTransactionsCached(
      { onProgress: (p) => progress.push(p.progress_percent ?? -1) },
      deps,
    );
    await flushBackgroundWrites();

    expect(loadRecords).not.toHaveBeenCalled();
    expect(txs.map((t) => t.transaction_id).sort()).toEqual(["a", "b"]);
    expect(state.writes).toBe(0);
    expect(progress).toEqual([100]);
  });

  it("warm start with a delta: merges new/deleted rows and persists the updated cache", async () => {
    const { store, state } = memStore(cachePayload(coldRecords));
    const deps = makeDeps({
      store,
      loadRecords: vi.fn(async () => coldRecords),
      countDeltaRows: async () => 2,
      fetchDeltaRows: async () => [
        deltaRow("a", "2026-07-03T00:00:00+00:00", "2026-07-03T00:00:00+00:00"), // soft delete
        deltaRow("c", "2026-07-04T00:00:00+00:00"), // new row
      ],
      countServerRows: async () => 2, // b + c
    });

    const txs = await loadWarehouseTransactionsCached({}, deps);
    await flushBackgroundWrites();

    expect(txs.map((t) => t.transaction_id).sort()).toEqual(["b", "c"]);
    expect(state.writes).toBe(1);
    expect((state.value as WarehouseCachePayload).max_updated_at).toBe("2026-07-04T00:00:00+00:00");
  });

  it("falls back to the full load when the merged count disagrees with the server (hard delete)", async () => {
    const fresh = [record("b", "2026-07-02T00:00:00+00:00")];
    const { store, state } = memStore(cachePayload(coldRecords));
    const loadRecords = vi.fn(async () => fresh);
    const deps = makeDeps({
      store,
      loadRecords,
      countDeltaRows: async () => 0,
      fetchDeltaRows: async () => [],
      countServerRows: async () => 1, // row "a" was hard-deleted — no tombstone in the delta
    });

    const txs = await loadWarehouseTransactionsCached({}, deps);
    await flushBackgroundWrites();

    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect(txs.map((t) => t.transaction_id)).toEqual(["b"]);
    expect((state.value as WarehouseCachePayload).row_count).toBe(1);
  });

  it("falls back to the full load when the delta is bulk-import sized", async () => {
    const { store } = memStore(cachePayload(coldRecords));
    const loadRecords = vi.fn(async () => coldRecords);
    const fetchDeltaRows = vi.fn(async () => []);
    const deps = makeDeps({
      store,
      loadRecords,
      fetchDeltaRows,
      countDeltaRows: async () => WAREHOUSE_CACHE_DELTA_RELOAD_THRESHOLD + 1,
    });

    await loadWarehouseTransactionsCached({}, deps);
    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect(fetchDeltaRows).not.toHaveBeenCalled();
  });

  it("cache stored for another user is ignored, and the reseeded cache belongs to the current user", async () => {
    const { store, state } = memStore(cachePayload(coldRecords, { auth_user_id: "someone-else" }));
    const loadRecords = vi.fn(async () => coldRecords);
    const deps = makeDeps({ store, loadRecords });

    await loadWarehouseTransactionsCached({}, deps);
    await flushBackgroundWrites();

    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect((state.value as WarehouseCachePayload).auth_user_id).toBe("user-1");
  });

  it("degrades to the plain network load when the store read or the delta fetch fails", async () => {
    const broken: WarehouseCacheStore = {
      read: async () => {
        throw new Error("idb exploded");
      },
      write: async () => {
        throw new Error("idb exploded");
      },
      clear: async () => {},
    };
    const loadRecords = vi.fn(async () => coldRecords);
    const txs = await loadWarehouseTransactionsCached({}, makeDeps({ store: broken, loadRecords }));
    expect(txs).toHaveLength(2);

    const { store } = memStore(cachePayload(coldRecords));
    const loadRecords2 = vi.fn(async () => coldRecords);
    const txs2 = await loadWarehouseTransactionsCached(
      {},
      makeDeps({
        store,
        loadRecords: loadRecords2,
        countDeltaRows: async () => {
          throw new Error("network down");
        },
      }),
    );
    expect(loadRecords2).toHaveBeenCalledTimes(1);
    expect(txs2).toHaveLength(2);
  });

  it("without a session the cache is neither read nor written", async () => {
    const { store, state } = memStore(cachePayload(coldRecords));
    const loadRecords = vi.fn(async () => coldRecords);
    const deps = makeDeps({ store, loadRecords, currentUserId: async () => null });

    const txs = await loadWarehouseTransactionsCached({}, deps);
    await flushBackgroundWrites();

    expect(loadRecords).toHaveBeenCalledTimes(1);
    expect(txs).toHaveLength(2);
    expect(state.writes).toBe(0);
  });
});
