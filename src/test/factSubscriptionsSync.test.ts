import { describe, expect, it } from "vitest";
import {
  ALTER_FACT_SUBSCRIPTIONS_COLUMNS_SQL,
  CREATE_FACT_SUBSCRIPTIONS_SQL,
  normalizeSubscriptionForClickHouse,
} from "../../supabase/functions/_shared/clickhouse/factSubscriptions.ts";
import { syncFactSubscriptions, type SubscriptionSourceClient } from "../../supabase/functions/_shared/clickhouse/factSubscriptionsSync.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

const TENANT = "tenant-0001";

const source = (over: Record<string, unknown> = {}) => ({
  auth_user_id: TENANT,
  subscription_id: "sub_1",
  profile_id: "prof_1",
  psp_id: "psp_1",
  normalized_email: "Buyer@Example.com",
  funnel: "test-iq",
  campaign_path: "test-iq",
  status: "cancelled",
  renews: false,
  cancelled_at: null,
  period_ends_at: "2026-10-20T10:00:00Z",
  product_name: "Monthly",
  product_id: "prod_1",
  price: "29.99",
  currency: "usd",
  updated_at: "2026-10-12T08:00:00Z",
  created_at: "2026-10-07T09:00:00Z",
  detail_cancelled_at: "2026-10-10T09:30:00Z",
  detail_cancellation_reason: "User requested cancellation",
  detail_sandbox: "false",
  detail_updated_at: "2026-10-11T08:00:00Z",
  ...over,
});

describe("fact_subscriptions rows", () => {
  it("takes the FunnelFox detail cancel date, never stores the raw email, skips sandbox", () => {
    const row = normalizeSubscriptionForClickHouse(source(), 1_700_000_000_000)!;
    expect(row).toMatchObject({
      normalized_email: "buyer@example.com",
      email: "",
      status: "cancelled",
      renews: 0,
      cancelled_at: "2026-10-10T09:30:00.000",
      period_ends_at: "2026-10-20T10:00:00.000",
      cancellation_reason: "User requested cancellation",
      started_at: "2026-10-07T09:00:00.000",
      currency: "USD",
      row_version: "1700000000000",
    });
    expect(normalizeSubscriptionForClickHouse(source({ detail_created_at: "2026-10-07T08:59:00Z" }))!.started_at).toBe("2026-10-07T08:59:00.000");
    expect(normalizeSubscriptionForClickHouse(source({ created_at: null }))!.started_at).toBeNull();
    expect(normalizeSubscriptionForClickHouse(source({ detail_sandbox: "true" }))).toBeNull();
    expect(normalizeSubscriptionForClickHouse(source({ subscription_id: "" }))).toBeNull();
  });

  it("falls back to updated_at for a cancelled subscription without a cancel date, like normalizeSubscription", () => {
    const cancelled = normalizeSubscriptionForClickHouse(source({ detail_cancelled_at: null }))!;
    expect(cancelled.cancelled_at).toBe("2026-10-11T08:00:00.000");
    const active = normalizeSubscriptionForClickHouse(source({ status: "active", renews: true, detail_cancelled_at: null }))!;
    expect(active.cancelled_at).toBeNull();
    expect(active.renews).toBe(1);
    const fromDetail = normalizeSubscriptionForClickHouse(source({ status: null, renews: null, detail_status: "Active", detail_renews: "true" }))!;
    expect(fromDetail).toMatchObject({ status: "active", renews: 1 });
  });

  it("adds the reason and start columns at the tail of the table", () => {
    expect(CREATE_FACT_SUBSCRIPTIONS_SQL.trim().endsWith("row_version UInt64,\n    cancellation_reason String DEFAULT '',\n    started_at Nullable(DateTime64(3, 'UTC'))\n)\nENGINE = ReplacingMergeTree(row_version)\nORDER BY (auth_user_id, subscription_id)")).toBe(true);
    expect(ALTER_FACT_SUBSCRIPTIONS_COLUMNS_SQL.slice(-2)).toEqual([
      "ALTER TABLE fact_subscriptions ADD COLUMN IF NOT EXISTS cancellation_reason String DEFAULT ''",
      "ALTER TABLE fact_subscriptions ADD COLUMN IF NOT EXISTS started_at Nullable(DateTime64(3, 'UTC'))",
    ]);
    // Key / version columns are never re-asserted (an ALTER cannot change them).
    expect(ALTER_FACT_SUBSCRIPTIONS_COLUMNS_SQL.join(" ")).not.toMatch(/IF NOT EXISTS (auth_user_id|subscription_id|row_version) /);
    expect(ALTER_FACT_SUBSCRIPTIONS_COLUMNS_SQL).toContain("ALTER TABLE fact_subscriptions ADD COLUMN IF NOT EXISTS normalized_email String DEFAULT ''");
  });
});

function fakePg(rows: Record<string, unknown>[], pageSize = 1000) {
  const ranges: Array<[number, number]> = [];
  const client: SubscriptionSourceClient = {
    from: () => ({
      select: () => ({
        eq: (_column: string, value: string) => ({
          order: () => ({
            range: async (from: number, to: number) => {
              ranges.push([from, to]);
              expect(value).toBe(TENANT);
              return { data: rows.slice(from, Math.min(to + 1, from + pageSize)), error: null };
            },
          }),
        }),
      }),
    }),
  };
  return { client, ranges };
}

function fakeClickHouse() {
  const commands: Array<{ query: string; query_params?: Record<string, unknown> }> = [];
  const inserts: Array<{ table: string; values: Record<string, unknown>[] }> = [];
  const client = {
    query: async () => ({ json: async () => [] }),
    command: async (input: { query: string; query_params?: Record<string, unknown> }) => {
      commands.push(input);
    },
    insert: async (input: { table: string; values: Record<string, unknown>[] }) => {
      inserts.push(input);
    },
  } as unknown as ClickHouseClientLike;
  return { client, commands, inserts };
}

describe("syncFactSubscriptions", () => {
  it("pages the tenant's subscriptions, writes them with the run version and drops older rows", async () => {
    const rows = Array.from({ length: 2501 }, (_, i) => source({ subscription_id: `sub_${i}`, detail_sandbox: i === 7 ? "true" : "false" }));
    const pg = fakePg(rows);
    const ch = fakeClickHouse();
    const result = await syncFactSubscriptions({ pg: pg.client, clickhouse: ch.client, authUserId: TENANT, nowMs: 1_800_000_000_000 });
    expect(pg.ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(result).toMatchObject({ source_rows: 2501, inserted: 2500, skipped: 1, cancelled: 2500, cancelled_with_date: 2500, run_version: 1_800_000_000_000 });
    expect(ch.inserts.reduce((n, insert) => n + insert.values.length, 0)).toBe(2500);
    expect(ch.inserts.every((insert) => insert.table === "fact_subscriptions")).toBe(true);
    expect(ch.inserts[0].values[0]).toMatchObject({ row_version: "1800000000000", email: "" });
    expect(ch.commands[0].query).toContain("CREATE TABLE IF NOT EXISTS fact_subscriptions");
    const deletion = ch.commands.at(-1)!;
    expect(deletion.query).toBe("DELETE FROM fact_subscriptions WHERE auth_user_id = {auth_user_id:String} AND row_version < {run_version:UInt64}");
    expect(deletion.query_params).toEqual({ auth_user_id: TENANT, run_version: 1_800_000_000_000 });
  });

  it("never deletes after a run that wrote nothing", async () => {
    const ch = fakeClickHouse();
    const result = await syncFactSubscriptions({ pg: fakePg([]).client, clickhouse: ch.client, authUserId: TENANT });
    expect(result.inserted).toBe(0);
    expect(ch.commands.some((command) => command.query.startsWith("DELETE"))).toBe(false);
  });
});

