import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationSql = readFileSync(
  resolve(process.cwd(), "supabase/migrations/202606180001_create_support_messages.sql"),
  "utf8",
);

describe("support messages migration", () => {
  it("creates support_messages with mailbox, email, classification, matching, and audit fields", () => {
    expect(migrationSql).toContain("create table if not exists public.support_messages");
    expect(migrationSql).toContain("message_id text not null");
    expect(migrationSql).toContain("body_text text");
    expect(migrationSql).toContain("detected_intent text not null default 'unknown'");
    expect(migrationSql).toContain("matched_user_email text");
    expect(migrationSql).toContain("amount_refunded numeric(18,2)");
    expect(migrationSql).toContain("raw_headers jsonb");
  });

  it("deduplicates per authenticated user and indexes support filters", () => {
    expect(migrationSql).toContain("constraint support_messages_user_message_unique unique (auth_user_id, message_id)");
    expect(migrationSql).toContain("support_messages_received_at_idx");
    expect(migrationSql).toContain("support_messages_detected_intent_idx");
    expect(migrationSql).toContain("support_messages_campaign_id_idx");
    expect(migrationSql).toContain("support_messages_media_buyer_idx");
    expect(migrationSql).toContain("support_messages_card_type_idx");
  });

  it("enables RLS for user-owned support messages", () => {
    expect(migrationSql).toContain("alter table public.support_messages enable row level security");
    expect(migrationSql).toContain("Users can read own support messages");
    expect(migrationSql).toContain("Users can insert own support messages");
    expect(migrationSql).toContain("Users can update own support messages");
    expect(migrationSql).toContain("Users can delete own support messages");
    expect(migrationSql).toContain("auth.uid() = auth_user_id");
  });
});
