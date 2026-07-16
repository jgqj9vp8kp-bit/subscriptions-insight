import { describe, expect, it } from "vitest";
import {
  countEmailCoverage,
  crawlList,
  determineStopReason,
  enrichPool,
  enrichStageComplete,
  enrichStopReason,
  finalSyncStatus,
  fullResetState,
  parityCheck,
  needsSubscriptionDetail,
  nextIncompleteStage,
  resolveStartCursor,
  shouldContinueSubscriptionSync,
  statusFromStopReason,
  subscriptionListColumns,
  uniqueProfileIds,
  type CrawlPageResult,
  type JsonRecord,
} from "@/services/funnelfoxSubscriptionsSyncCore";
import {
  subscriptionRowToClean,
  subscriptionSyncUiStatus,
  subscriptionSyncReport,
  subscriptionSyncCompletenessWarning,
  shouldShowPartialWarning,
  type FunnelFoxSubscriptionsSyncState,
} from "@/services/funnelfoxSubscriptionsSync";

// A paginated fixture: `total` pages of `perPage` rows. Optionally never stops
// (endless) to model an account bigger than max_pages.
function pagedFetcher(opts: { total: number; perPage: number; endless?: boolean }) {
  const seenCursors: Array<string | undefined> = [];
  let served = 0;
  const fetchPage = async (cursor: string | undefined): Promise<CrawlPageResult> => {
    seenCursors.push(cursor);
    const page = served;
    served += 1;
    const rows: JsonRecord[] = Array.from({ length: opts.perPage }, (_, i) => ({ id: `sub_${page}_${i}` }));
    const hasMore = opts.endless ? true : page + 1 < opts.total;
    return { ok: true, rows, hasMore, nextCursor: hasMore ? `cursor_${page + 1}` : null, totalReported: opts.endless ? null : opts.total * opts.perPage };
  };
  return { fetchPage, seenCursors };
}

const never = () => false;

describe("subscriptions crawl pagination", () => {
  it("1. continues through cursors until has_more=false → completed", async () => {
    const { fetchPage } = pagedFetcher({ total: 3, perPage: 2 });
    const out = await crawlList(fetchPage, { startCursor: undefined, maxPages: 50, isExpired: never });
    expect(out.pages).toBe(3);
    expect(out.rows).toHaveLength(6);
    expect(out.hasMoreOnLastPage).toBe(false);
    expect(out.stoppedReason).toBe("completed");
    expect(statusFromStopReason(out.stoppedReason)).toBe("ok");
  });

  it("2. stops at max_pages while has_more=true → partial", async () => {
    const { fetchPage } = pagedFetcher({ total: 99, perPage: 2, endless: true });
    const out = await crawlList(fetchPage, { startCursor: undefined, maxPages: 3, isExpired: never });
    expect(out.pages).toBe(3);
    expect(out.hasMoreOnLastPage).toBe(true);
    expect(out.stoppedReason).toBe("max_pages_reached");
    expect(statusFromStopReason(out.stoppedReason)).toBe("partial");
    // The stop-reason precedence: api_error > timeout > completed > max_pages.
    expect(determineStopReason({ pages: 3, maxPages: 3, hasMoreOnLastPage: true, timedOut: false, apiError: false })).toBe("max_pages_reached");
    expect(determineStopReason({ pages: 3, maxPages: 3, hasMoreOnLastPage: true, timedOut: true, apiError: false })).toBe("soft_timeout");
    expect(determineStopReason({ pages: 3, maxPages: 3, hasMoreOnLastPage: true, timedOut: true, apiError: true })).toBe("api_error");
  });

  it("3. soft timeout mid-crawl → partial", async () => {
    const { fetchPage } = pagedFetcher({ total: 99, perPage: 2, endless: true });
    let pages = 0;
    const isExpired = () => pages++ >= 2; // expire before the 3rd page
    const out = await crawlList(fetchPage, { startCursor: undefined, maxPages: 50, isExpired });
    expect(out.stoppedReason).toBe("soft_timeout");
    expect(statusFromStopReason(out.stoppedReason)).toBe("partial");
  });

  it("4. continue resumes from the saved cursor", async () => {
    const { fetchPage, seenCursors } = pagedFetcher({ total: 3, perPage: 2 });
    const start = resolveStartCursor("cursor_saved", false);
    expect(start).toBe("cursor_saved");
    await crawlList(fetchPage, { startCursor: start, maxPages: 1, isExpired: never });
    expect(seenCursors[0]).toBe("cursor_saved"); // pagination truly began at the saved cursor
  });

  it("5. force resync starts from the beginning (cursor cleared, flags reset)", () => {
    expect(resolveStartCursor("cursor_saved", true)).toBeUndefined();
    const reset = fullResetState();
    expect(reset).toMatchObject({
      list_completed: false, details_completed: false, profiles_completed: false, finalize_completed: false,
      current_stage: "subscriptions_list", last_list_cursor: null,
    });
    // Stage machine walks the full pipeline from a reset state.
    expect(nextIncompleteStage(reset)).toBe("subscriptions_list");
  });
});

describe("subscriptions detail stage", () => {
  it("6. fetches details only for rows missing detail fields", () => {
    const full = subscriptionListColumns({ id: "s1", email: "a@b.com", profile_id: "p1", product: { name: "Plan" }, period_ends_at: "2026-08-01" });
    const partial = subscriptionListColumns({ id: "s2", profile_id: "p2" });
    expect(needsSubscriptionDetail(full)).toBe(false); // complete list row → skip fetch
    expect(needsSubscriptionDetail(partial)).toBe(true); // missing email/product/period → fetch
  });

  it("10. detail API failure is counted but does not abort the run", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `s${i}` }));
    const out = await enrichPool(items, {
      concurrency: 2,
      isExpired: never,
      fetchOne: async () => ({ ok: false, status: 500, value: null }), // all transient failures
    });
    expect(out.attempted).toBe(5);
    expect(out.fetched).toBe(0);
    expect(out.failed).toBe(5);
    expect(out.timeoutSkipped).toBe(0);
    // Transient failures leave the stage incomplete so Continue Sync retries.
    expect(enrichStopReason(out.timeoutSkipped)).toBe("completed"); // no timeout this run
    expect(enrichStageComplete(0, /* remainingUnchecked */ 5)).toBe(false);
  });
});

describe("subscriptions profile stage", () => {
  it("7. fetches each shared profile exactly once", async () => {
    // 5 subscriptions, 2 distinct profile ids → only 2 profile fetches.
    const rows = [
      { profile_id: "p1" }, { profile_id: "p1" }, { profile_id: "p1" }, { profile_id: "p2" }, { profile_id: "p2" },
    ];
    const ids = uniqueProfileIds(rows);
    expect(ids.sort()).toEqual(["p1", "p2"]);
    let fetchCalls = 0;
    const out = await enrichPool(ids.map((id) => ({ id })), {
      concurrency: 5,
      isExpired: never,
      fetchOne: async () => { fetchCalls += 1; return { ok: true, status: 200, value: "x@y.com" }; },
    });
    expect(fetchCalls).toBe(2);
    expect(out.fetched).toBe(2);
  });

  it("11. profile API failure is counted but does not abort the run", async () => {
    const out = await enrichPool([{ id: "p1" }, { id: "p2" }], {
      concurrency: 2,
      isExpired: never,
      fetchOne: async (id) => (id === "p1" ? { ok: false, status: 500, value: null } : { ok: true, status: 200, value: "e@x.com" }),
    });
    expect(out.attempted).toBe(2);
    expect(out.fetched).toBe(1);
    expect(out.failed).toBe(1);
  });

  it("timeout during enrichment leaves the rest unchecked (soft_timeout)", async () => {
    let processed = 0;
    const out = await enrichPool(Array.from({ length: 10 }, (_, i) => ({ id: `p${i}` })), {
      concurrency: 1,
      isExpired: () => processed >= 3,
      fetchOne: async () => { processed += 1; return { ok: true, status: 200, value: "e@x.com" }; },
    });
    expect(out.attempted).toBe(3);
    expect(out.timeoutSkipped).toBe(7);
    expect(enrichStopReason(out.timeoutSkipped)).toBe("soft_timeout");
  });
});

describe("subscriptions row + coverage", () => {
  it("8. duplicate subscription_id maps to a stable dedup key (idempotent columns)", () => {
    const raw = { id: "sub_1", email: "A@B.com", status: "ACTIVE", product: { name: "Plan", id: "prod_1" }, price: 1498, currency: "USD" };
    const a = subscriptionListColumns(raw);
    const b = subscriptionListColumns({ ...raw, updated_at: "2026-07-08T00:00:00Z" });
    expect(a.subscription_id).toBe("sub_1");
    expect(b.subscription_id).toBe("sub_1"); // same upsert key → no duplicate row
    expect(a.email).toBe("a@b.com"); // normalized
    expect(a.price).toBe(14.98); // cents → dollars
  });

  it("9. counts missing email before and after enrichment", () => {
    const before = countEmailCoverage([{ email: "a@b.com" }, { email: null }, { email: null }]);
    expect(before).toEqual({ withEmail: 1, withoutEmail: 2 });
    // after profile enrichment recovered one email:
    const after = countEmailCoverage([{ email: "a@b.com" }, { normalized_email: "c@d.com" }, { email: null }]);
    expect(after).toEqual({ withEmail: 2, withoutEmail: 1 });
  });
});

describe("durable restore", () => {
  it("12. re-derives SubscriptionClean from a stored row (detail wins, recovered email injected)", () => {
    const clean = subscriptionRowToClean({
      subscription_id: "sub_1",
      email: "recovered@x.com", // came from the profile stage, not in either raw payload
      normalized_email: "recovered@x.com",
      raw_list: { id: "sub_1", status: "active", price: 1498, currency: "USD" },
      raw_detail: { id: "sub_1", status: "cancelled", renews: false, product: { name: "Premium" }, price: 1498, currency: "USD" },
    });
    expect(clean.subscription_id).toBe("sub_1");
    expect(clean.status).toBe("cancelled"); // detail payload wins over list
    expect(clean.email).toBe("recovered@x.com"); // profile-recovered email flows into normalizeSubscription
    expect(clean.product_name).toBe("Premium");
    expect(clean.price_usd).toBeCloseTo(14.98, 2);
  });
});

describe("UI status helpers", () => {
  const state = (over: Partial<FunnelFoxSubscriptionsSyncState>): FunnelFoxSubscriptionsSyncState => ({
    auth_user_id: "u", last_list_cursor: null, current_stage: null,
    list_completed: false, details_completed: false, profiles_completed: false, finalize_completed: false,
    subscriptions_scanned_total: 0, subscriptions_total_reported_by_api: null,
    last_status: null, last_error: null, stopped_reason: null,
    started_at: null, finished_at: null, duration_ms: null, last_full_sync_at: null, stats: null, updated_at: null,
    ...over,
  });

  it("13. shows the partial warning when the last run was partial", () => {
    expect(subscriptionSyncUiStatus(state({ last_status: "partial" }), false)).toBe("partial");
    expect(shouldShowPartialWarning(state({ last_status: "partial" }))).toBe(true);
  });

  it("14. shows the completed state when all stages finished", () => {
    const s = state({ last_status: "completed", list_completed: true, details_completed: true, profiles_completed: true, finalize_completed: true });
    expect(subscriptionSyncUiStatus(s, false)).toBe("completed");
    expect(shouldShowPartialWarning(s)).toBe(false);
    expect(subscriptionSyncUiStatus(state({}), false)).toBe("never_synced");
    expect(subscriptionSyncUiStatus(state({ last_status: "completed" }), true)).toBe("syncing");
    expect(subscriptionSyncUiStatus(state({ last_status: "failed" }), false)).toBe("failed");
  });
});

describe("integrity / parity check (Phase 4/5)", () => {
  it("parityCheck passes only when finished and stored equals FunnelFox total", () => {
    expect(parityCheck(6936, 6936, true)).toBe("pass");
    expect(parityCheck(6309, 6936, true)).toBe("fail");
    expect(parityCheck(6936, 6936, false)).toBe("unknown"); // not finished yet
    expect(parityCheck(6936, null, true)).toBe("unknown"); // no reported total
  });

  it("finalSyncStatus surfaces a count mismatch as completed_with_inconsistencies", () => {
    expect(finalSyncStatus(true, "ok", "pass")).toBe("completed");
    expect(finalSyncStatus(true, "ok", "fail")).toBe("completed_with_inconsistencies");
    expect(finalSyncStatus(false, "partial", "unknown")).toBe("partial");
    expect(finalSyncStatus(true, "error", "unknown")).toBe("failed");
  });

  const stateFull = (over: Partial<FunnelFoxSubscriptionsSyncState>): FunnelFoxSubscriptionsSyncState => ({
    auth_user_id: "u", last_list_cursor: null, current_stage: null,
    list_completed: true, details_completed: true, profiles_completed: true, finalize_completed: true,
    subscriptions_scanned_total: 6936, subscriptions_total_reported_by_api: 6936,
    last_status: null, last_error: null, stopped_reason: null,
    started_at: null, finished_at: null, duration_ms: null, last_full_sync_at: null, stats: null, updated_at: null,
    ...over,
  });

  it("UI maps completed_with_inconsistencies to the 'inconsistent' status + warning", () => {
    const s = stateFull({ last_status: "completed_with_inconsistencies", stats: { coverage_warning: true } as never });
    expect(subscriptionSyncUiStatus(s, false)).toBe("inconsistent");
    expect(subscriptionSyncCompletenessWarning(s)).toMatch(/stored fewer subscriptions than FunnelFox reports/);
    expect(subscriptionSyncUiStatus(stateFull({ last_status: "completed" }), false)).toBe("completed");
  });

  it("subscriptionSyncReport extracts the permanent report block", () => {
    const report = { started_at: "t0", completed_at: "t1", duration_ms: 1000, downloaded: 6936, inserted: 627, updated: 6309, skipped: 0, total_stored: 6936, total_in_funnelfox: 6936, parity_check: "PASS" };
    const s = stateFull({ stats: { sync_report: report } as never });
    expect(subscriptionSyncReport(s)).toEqual(report);
    expect(subscriptionSyncReport(stateFull({ stats: null }))).toBeNull();
  });
});

describe("driver control", () => {
  it("15. dry run never continues the driver (no writes, single call)", () => {
    expect(shouldContinueSubscriptionSync({ status: "ok", all_stages_completed: false, made_progress: true, dry_run: true })).toBe(false);
    // Normal continuation contract:
    expect(shouldContinueSubscriptionSync({ status: "partial", all_stages_completed: false, made_progress: true })).toBe(true);
    expect(shouldContinueSubscriptionSync({ status: "ok", all_stages_completed: true, made_progress: true })).toBe(false);
    expect(shouldContinueSubscriptionSync({ status: "error", all_stages_completed: false, made_progress: true })).toBe(false);
    expect(shouldContinueSubscriptionSync({ status: "partial", all_stages_completed: false, made_progress: false })).toBe(false);
  });
});
