import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/202605260001_create_transaction_warehouse.sql"),
  "utf8",
);

describe("transaction warehouse migration", () => {
  it("creates the persistent warehouse and import versioning tables", () => {
    expect(migrationSql).toContain("create table if not exists public.transactions");
    expect(migrationSql).toContain("create table if not exists public.import_batches");
    expect(migrationSql).toContain("create table if not exists public.import_batch_files");
    expect(migrationSql).toContain("deleted_at timestamptz");
    expect(migrationSql).toContain("raw_payload jsonb");
    expect(migrationSql).toContain("normalized_payload jsonb");
  });

  it("enforces dedupe indexes and pagination-ready filters", () => {
    expect(migrationSql).toContain("transactions_transaction_id_key");
    expect(migrationSql).toContain("transactions_event_time_idx");
    expect(migrationSql).toContain("transactions_email_idx");
    expect(migrationSql).toContain("transactions_campaign_path_idx");
    expect(migrationSql).toContain("transactions_import_batch_id_idx");
    expect(migrationSql).toContain("import_batches_checksum_idx");
  });

  it("enables RLS for user-owned warehouse records", () => {
    expect(migrationSql).toContain("alter table public.transactions enable row level security");
    expect(migrationSql).toContain("alter table public.import_batches enable row level security");
    expect(migrationSql).toContain("alter table public.import_batch_files enable row level security");
    expect(migrationSql).toContain("auth.uid() = auth_user_id");
    expect(migrationSql).toContain("auth.uid() = user_id");
  });
});
