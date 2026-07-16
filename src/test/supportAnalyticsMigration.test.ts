import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  join(process.cwd(), "supabase/migrations/202607130001_create_support_analytics.sql"),
  "utf8",
);

describe("support analytics migration", () => {
  it("creates import batches and request storage", () => {
    expect(migration).toContain("create table if not exists public.support_import_batches");
    expect(migration).toContain("create table if not exists public.support_requests");
    expect(migration).toContain("message_body text");
    expect(migration).toContain("manual_category text");
    expect(migration).toContain("source_hash text not null");
  });

  it("deduplicates imported source rows per owner", () => {
    expect(migration).toContain("constraint support_requests_unique_source_hash unique (auth_user_id, source_hash)");
    expect(migration).toContain("create index if not exists support_requests_auth_source_hash_idx");
  });

  it("enables owner-scoped RLS policies", () => {
    expect(migration).toContain("alter table public.support_import_batches enable row level security");
    expect(migration).toContain("alter table public.support_requests enable row level security");
    expect(migration).toContain("using (auth.uid() = auth_user_id)");
    expect(migration).toContain("with check (auth.uid() = auth_user_id)");
  });

  it("adds query indexes for analytics filters", () => {
    expect(migration).toContain("support_requests_auth_received_idx");
    expect(migration).toContain("support_requests_auth_category_idx");
    expect(migration).toContain("support_requests_auth_language_idx");
    expect(migration).toContain("support_requests_auth_urgency_idx");
    expect(migration).toContain("support_requests_auth_flags_idx");
  });
});
