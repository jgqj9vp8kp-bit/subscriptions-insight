import { describe, expect, it } from "vitest";
import {
  computeCoveragePercent,
  computeCoverageWarning,
  crawlList,
  determineStopReason,
  fullResetState,
  nextIncompleteStage,
  parseProfileListRow,
  readReportedTotal,
  resolveStartCursor,
  scanProfileRows,
  statusFromStopReason,
  type CrawlPageResult,
} from "@/services/funnelfoxLeadsTransform";

/** A fetchPage that always claims more data — used to drive the max_pages path. */
function endlessPages(): (cursor: string | undefined) => Promise<CrawlPageResult> {
  let n = 0;
  return async () => {
    n += 1;
    return { ok: true, rows: [{ id: `p_${n}` }], hasMore: true, nextCursor: `cursor_${n}`, totalReported: null };
  };
}

describe("1. max_pages reached while has_more=true → partial", () => {
  it("classifies a maxed-out crawl as max_pages_reached, not completed", async () => {
    const outcome = await crawlList(endlessPages(), { maxPages: 3, isExpired: () => false });
    expect(outcome.pages).toBe(3);
    expect(outcome.hasMoreOnLastPage).toBe(true);
    expect(outcome.stoppedReason).toBe("max_pages_reached");
    expect(statusFromStopReason(outcome.stoppedReason)).toBe("partial");
  });

  it("classifies a drained crawl as completed → ok", async () => {
    let n = 0;
    const outcome = await crawlList(
      async () => {
        n += 1;
        const more = n < 2;
        return { ok: true, rows: [{ id: `p_${n}` }], hasMore: more, nextCursor: more ? `c_${n}` : null, totalReported: null };
      },
      { maxPages: 50, isExpired: () => false },
    );
    expect(outcome.stoppedReason).toBe("completed");
    expect(statusFromStopReason(outcome.stoppedReason)).toBe("ok");
  });

  it("determineStopReason: max_pages only when has_more is still true", () => {
    expect(determineStopReason({ pages: 50, maxPages: 50, hasMoreOnLastPage: true, timedOut: false, apiError: false })).toBe("max_pages_reached");
    expect(determineStopReason({ pages: 50, maxPages: 50, hasMoreOnLastPage: false, timedOut: false, apiError: false })).toBe("completed");
    expect(determineStopReason({ pages: 2, maxPages: 50, hasMoreOnLastPage: true, timedOut: true, apiError: false })).toBe("soft_timeout");
    expect(determineStopReason({ pages: 1, maxPages: 50, hasMoreOnLastPage: true, timedOut: false, apiError: true })).toBe("api_error");
    expect(determineStopReason({ pages: 1, maxPages: 50, hasMoreOnLastPage: true, timedOut: false, apiError: false, rateLimited: true })).toBe("rate_limited");
  });
});

describe("2. soft timeout mid-crawl → partial, resumable from the last cursor", () => {
  it("stops cleanly when time expires and keeps the cursor of the next page", async () => {
    let fetched = 0;
    const outcome = await crawlList(
      async () => {
        fetched += 1;
        return { ok: true, rows: [{ id: `p_${fetched}` }], hasMore: true, nextCursor: `c_${fetched}` };
      },
      { maxPages: 50, isExpired: () => fetched >= 3 },
    );
    expect(outcome.pages).toBe(3);
    expect(outcome.lastCursor).toBe("c_3");
    expect(outcome.stoppedReason).toBe("soft_timeout");
    expect(statusFromStopReason(outcome.stoppedReason)).toBe("partial");
  });
});

describe("3. resume from saved cursor", () => {
  it("resolveStartCursor returns the saved cursor on a normal run", () => {
    expect(resolveStartCursor("cursor_abc", false)).toBe("cursor_abc");
    expect(resolveStartCursor(null, false)).toBeUndefined();
  });

  it("crawl starts paginating from the saved cursor", async () => {
    const seen: Array<string | undefined> = [];
    await crawlList(
      async (cursor) => {
        seen.push(cursor);
        return { ok: true, rows: [], hasMore: false, nextCursor: null, totalReported: null };
      },
      { startCursor: "cursor_abc", maxPages: 5, isExpired: () => false },
    );
    expect(seen[0]).toBe("cursor_abc");
  });
});

describe("4. full_reset clears cursors and restarts", () => {
  it("fullResetState zeroes cursors + stage flags and points at the first stage", () => {
    const reset = fullResetState();
    expect(reset.last_profiles_cursor).toBeNull();
    expect(reset.last_sessions_cursor).toBeNull();
    expect(reset.profiles_completed).toBe(false);
    expect(reset.sessions_completed).toBe(false);
    expect(reset.reconcile_completed).toBe(false);
    // The detail stage no longer exists: its flag stays true so nothing shows it as pending.
    expect(reset.details_completed).toBe(true);
    expect(reset.profiles_scanned_total).toBe(0);
    expect(reset.sessions_scanned_total).toBe(0);
    expect(reset.current_stage).toBe("profiles");
  });

  it("a full reset ignores the saved cursor and restarts at the beginning", () => {
    expect(resolveStartCursor("cursor_abc", true)).toBeUndefined();
  });

  it("nextIncompleteStage walks the three-stage pipeline in order", () => {
    expect(nextIncompleteStage({ profiles_completed: false, sessions_completed: false, reconcile_completed: false })).toBe("profiles");
    expect(nextIncompleteStage({ profiles_completed: true, sessions_completed: false, reconcile_completed: false })).toBe("sessions");
    expect(nextIncompleteStage({ profiles_completed: true, sessions_completed: true, reconcile_completed: false })).toBe("reconcile");
    expect(nextIncompleteStage({ profiles_completed: true, sessions_completed: true, reconcile_completed: true })).toBeNull();
  });
});

describe("5. profiles without email are counted, not stored", () => {
  it("splits a list page into stored (with email) and counted-only rows", () => {
    const scan = scanProfileRows([
      { id: "a", email: "a@x.com" },
      { id: "b" },
      { id: "c", email: "c@x.com" },
      { id: "d", email: "" },
      { id: "e", email: "not-an-email" },
    ]);
    expect(scan.with_email).toBe(2);
    expect(scan.without_email).toBe(3);
    expect(scan.store.map((p) => p.profile_id)).toEqual(["a", "c"]);
  });
});

describe("6. a FunnelFox 429 stops the crawl as rate_limited (partial), keeping the page cursor", () => {
  it("reports rate_limited with the Retry-After seconds and the cursor of the refused page", async () => {
    let n = 0;
    const outcome = await crawlList(
      async () => {
        n += 1;
        if (n === 3) return { ok: false, status: 429, rows: [], hasMore: false, nextCursor: null, retryAfterSeconds: 120, errorMessage: "FunnelFox /profiles HTTP 429" };
        return { ok: true, status: 200, rows: [{ id: `p_${n}` }], hasMore: true, nextCursor: `c_${n}` };
      },
      { maxPages: 50, isExpired: () => false },
    );
    expect(outcome.pages).toBe(2);
    expect(outcome.stoppedReason).toBe("rate_limited");
    expect(outcome.retryAfterSeconds).toBe(120);
    expect(outcome.lastCursor).toBe("c_2");
    expect(statusFromStopReason(outcome.stoppedReason)).toBe("partial");
  });
});

describe("7. profiles_skipped_no_profile_id counted correctly", () => {
  it("drops rows that have no id and counts them", () => {
    const scan = scanProfileRows([
      { id: "p_1", email: "one@x.com" },
      { created_at: "2026-06-10T00:00:00Z", email: "orphan@x.com" }, // no id
      { profile_id: "p_2" },
      {}, // no id
    ]);
    expect(scan.scanned).toBe(2);
    expect(scan.skipped_no_profile_id).toBe(2);
    expect(parseProfileListRow({}).profile_id).toBe("");
  });
});

describe("8. diagnostics fields are derivable", () => {
  it("coverage warnings carry the right human message per stop reason", () => {
    expect(computeCoverageWarning({ stoppedReason: "max_pages_reached", stage: "profiles" })).toEqual({
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because max_pages was reached while FunnelFox still had more profiles.",
    });
    expect(computeCoverageWarning({ stoppedReason: "max_pages_reached", stage: "sessions" }).coverage_warning_message).toBe(
      "Sync stopped because max_pages was reached while FunnelFox still had more sessions.",
    );
    expect(computeCoverageWarning({ stoppedReason: "soft_timeout", stage: "profiles" }).coverage_warning_message).toBe(
      "Sync stopped because soft timeout was reached before pagination finished.",
    );
    expect(computeCoverageWarning({ stoppedReason: "rate_limited", stage: "profiles" }).coverage_warning).toBe(true);
    expect(computeCoverageWarning({ stoppedReason: "completed", stage: "reconcile" }).coverage_warning).toBe(false);
  });

  it("coverage percent only computes when the API reports a total", () => {
    expect(computeCoveragePercent(50, 200)).toBe(25);
    expect(computeCoveragePercent(50, null)).toBeNull();
    expect(computeCoveragePercent(50, 0)).toBeNull();
    expect(computeCoveragePercent(500, 100)).toBe(100); // clamped
  });

  it("reads a reported total from a pagination object when present", () => {
    expect(readReportedTotal({ total: 1787 })).toBe(1787);
    expect(readReportedTotal({ total_count: "240" })).toBe(240);
    expect(readReportedTotal({ has_more: true, next_cursor: "x" })).toBeNull();
  });
});
