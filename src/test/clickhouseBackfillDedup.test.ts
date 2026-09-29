// analytics_transactions duplicates: the sorting key carries derived
// attribution, so a re-synced transaction whose derivation changed lands under
// a new key and ReplacingMergeTree keeps the old copy. Found live 2026-09-29 as
// "Sub → Renewal 2 CR 100%" three days after the trial: one 254.99 BRL payment
// stored twice, numbered lvl 1 and lvl 2 by the classifier. The backfill now
// evicts every copy before writing a batch, and mode=dedup re-queues the
// survivors for a clean rewrite.
import { describe, expect, it } from "vitest";
import {
  buildDuplicateTransactionIdsSql,
  buildStaleCopiesDeleteSql,
  normalizeBackfillParams,
} from "@/services/clickhouseBackfill";

describe("transactions backfill: key-drift duplicates", () => {
  it("evicts every copy of the batch's transaction_ids, scoped to the owner and key-agnostic", () => {
    const sql = buildStaleCopiesDeleteSql(["k14GXvbeM", "5utPbdugc", "k14GXvbeM"]);
    expect(sql.startsWith("DELETE FROM analytics_transactions WHERE auth_user_id = {auth_user_id:String}")).toBe(true);
    // Ids travel as unhex('…') body literals (the shared IN-list helper), deduplicated.
    expect(sql).toContain("transaction_id IN (unhex('");
    expect(sql.match(/unhex\('/g)).toHaveLength(2);
    // No sorting-key column may narrow the eviction — that is the whole point.
    for (const column of ["cohort_date", "funnel", "campaign_path", "campaign_id", "user_id", "event_time", "row_version"]) {
      expect(sql).not.toMatch(new RegExp(`(^|[^_a-z])${column}\\b`));
    }
  });

  it("escapes ids into the body instead of an Array param (the client cannot bind Array(String))", () => {
    const quoted = buildStaleCopiesDeleteSql(["it's"]);
    expect(quoted).not.toContain("it's");
    expect(quoted).toContain("unhex('");
    expect(buildStaleCopiesDeleteSql([])).toContain("IN (unhex(''))");
  });

  it("finds duplicates through FINAL, so only key-drift copies survive the count", () => {
    const sql = buildDuplicateTransactionIdsSql();
    expect(sql).toContain("FROM analytics_transactions FINAL");
    expect(sql).toContain("auth_user_id = {auth_user_id:String}");
    expect(sql).toContain("GROUP BY transaction_id HAVING copies > 1");
  });

  it("accepts mode=dedup and keeps every other mode intact", () => {
    expect(normalizeBackfillParams({ mode: "dedup" }).mode).toBe("dedup");
    expect(normalizeBackfillParams({ mode: "full_backfill" }).mode).toBe("full_backfill");
    expect(normalizeBackfillParams({ mode: "nonsense" as never }).mode).toBe("continue");
  });
});
