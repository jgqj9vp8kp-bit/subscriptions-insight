// Schema guards for support classification v2.
//
// The load-bearing one is the sorting key: ReplacingMergeTree collapses rows
// only when the WHOLE sorting key matches, so while category/urgency were part
// of it, re-classifying an email inserted a second row instead of replacing the
// first and the request was counted in two categories at once.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALTER_FACT_SUPPORT_REQUESTS_CLASSIFICATION_SQL,
  CREATE_FACT_SUPPORT_REQUESTS_SQL,
  ensureFactSupportRequestsSchema,
  rebuildFactSupportRequestsSortingKey,
  sortingKeyNeedsRebuild,
} from "../../supabase/functions/_shared/clickhouse/schema.ts";
import type { ClickHouseClientLike } from "../../supabase/functions/_shared/clickhouse/types.ts";

function fakeClient(sortingKey: string) {
  const commands: string[] = [];
  const client = {
    query: vi.fn(async () => ({ json: async () => (sortingKey ? [{ sorting_key: sortingKey }] : []) })),
    command: vi.fn(async ({ query }: { query: string }) => {
      commands.push(query.replace(/\s+/g, " ").trim());
    }),
    insert: vi.fn(async () => {}),
  } as unknown as ClickHouseClientLike;
  return { client, commands };
}

const LEGACY_KEY = "auth_user_id, request_date, category, urgency, matched_customer, request_id";
const FIXED_KEY = "auth_user_id, request_date, request_id";

describe("fact_support_requests DDL", () => {
  it("sorts by identity columns only — no mutable classification in the key", () => {
    const orderBy = /ORDER BY \(([^)]*)\)/.exec(CREATE_FACT_SUPPORT_REQUESTS_SQL)?.[1] ?? "";
    expect(orderBy).toContain("request_id");
    expect(orderBy).not.toContain("category");
    expect(orderBy).not.toContain("urgency");
  });

  it("declares the v2 classification columns", () => {
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("secondary_categories Array(LowCardinality(String))");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("classification_source");
    expect(CREATE_FACT_SUPPORT_REQUESTS_SQL).toContain("classification_model");
  });

  it("adds those columns to already-created tables too", () => {
    const sql = ALTER_FACT_SUPPORT_REQUESTS_CLASSIFICATION_SQL.join("\n");
    for (const column of ["secondary_categories", "classification_source", "classification_model"]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
  });
});

describe("sortingKeyNeedsRebuild", () => {
  it("flags the legacy key and passes the fixed one", () => {
    expect(sortingKeyNeedsRebuild(LEGACY_KEY)).toBe(true);
    expect(sortingKeyNeedsRebuild(FIXED_KEY)).toBe(false);
    expect(sortingKeyNeedsRebuild("")).toBe(false);
  });
});

describe("rebuildFactSupportRequestsSortingKey", () => {
  it("rebuilds through a swap and deduplicates history with FINAL", async () => {
    const { client, commands } = fakeClient(LEGACY_KEY);
    await expect(rebuildFactSupportRequestsSortingKey(client)).resolves.toBe(true);
    const script = commands.join("\n");
    expect(script).toContain("CREATE TABLE fact_support_requests_rebuild AS fact_support_requests");
    expect(script).toContain(`ORDER BY (${FIXED_KEY})`);
    // FINAL is what repairs the rows the old key already doubled.
    expect(script).toContain("SELECT * FROM fact_support_requests FINAL");
    expect(script).toContain("EXCHANGE TABLES fact_support_requests AND fact_support_requests_rebuild");
  });

  it("is a no-op once the key is already correct", async () => {
    const { client, commands } = fakeClient(FIXED_KEY);
    await expect(rebuildFactSupportRequestsSortingKey(client)).resolves.toBe(false);
    expect(commands).toHaveLength(0);
  });

  it("falls back to RENAME when EXCHANGE is unavailable", async () => {
    const { client, commands } = fakeClient(LEGACY_KEY);
    vi.mocked(client.command).mockImplementation(async ({ query }: { query: string }) => {
      if (query.includes("EXCHANGE TABLES")) throw new Error("EXCHANGE not supported");
      commands.push(query.replace(/\s+/g, " ").trim());
    });
    await expect(rebuildFactSupportRequestsSortingKey(client)).resolves.toBe(true);
    const script = commands.join("\n");
    expect(script).toContain("RENAME TABLE fact_support_requests TO fact_support_requests_legacy");
    expect(script).toContain("DROP TABLE IF EXISTS fact_support_requests_legacy");
  });

  it("adds columns before swapping, or the swap would drop them", async () => {
    const { client, commands } = fakeClient(LEGACY_KEY);
    await ensureFactSupportRequestsSchema(client);
    const addedAt = commands.findIndex((query) => query.includes("ADD COLUMN IF NOT EXISTS secondary_categories"));
    const clonedAt = commands.findIndex((query) => query.includes("CREATE TABLE fact_support_requests_rebuild"));
    expect(addedAt).toBeGreaterThanOrEqual(0);
    expect(clonedAt).toBeGreaterThan(addedAt);
  });
});

describe("Postgres migration 202607300001_support_classification_v2", () => {
  const sql = readFileSync(
    join(process.cwd(), "supabase/migrations/202607300001_support_classification_v2.sql"),
    "utf8",
  );

  it("adds the v2 columns additively and never touches manual overrides", () => {
    expect(sql).toContain("add column if not exists secondary_categories jsonb");
    expect(sql).toContain("add column if not exists classification_model text");
    expect(sql).not.toMatch(/drop column|alter column .* type/i);
    expect(sql).not.toMatch(/update public\.support_requests/i);
  });

  it("indexes the column the job scans on every tick", () => {
    expect(sql).toContain("support_requests_classification_version_idx");
  });

  it("creates a per-user resumable job state with RLS", () => {
    expect(sql).toContain("create table if not exists public.support_classification_state");
    expect(sql).toContain("primary key (auth_user_id, job_name)");
    expect(sql).toContain("enable row level security");
    for (const verb of ["select", "insert", "update", "delete"]) {
      expect(sql).toContain(`for ${verb}`);
    }
    expect(sql).toContain("auth.uid() = auth_user_id");
  });

  it("keeps a keyset cursor so a partial run resumes where it stopped", () => {
    expect(sql).toContain("cursor_received_at");
    expect(sql).toContain("cursor_request_id");
    expect(sql).toContain("'partial'");
  });
});
