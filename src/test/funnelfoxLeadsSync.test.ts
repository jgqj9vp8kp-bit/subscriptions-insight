import { describe, expect, it } from "vitest";
import {
  computeCoveragePercent,
  computeCoverageWarning,
  countEmailCoverage,
  crawlList,
  determineStopReason,
  detailsStopReason,
  enrichDetails,
  fullResetState,
  nextIncompleteStage,
  partitionByProfileId,
  parseProfileListRow,
  readReportedTotal,
  resolveStartCursor,
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
  });
});

describe("2. soft timeout during profile detail enrichment → partial", () => {
  it("stops cleanly when time expires mid-enrichment and reports the skipped remainder", async () => {
    let processed = 0;
    const candidates = Array.from({ length: 10 }, (_, i) => ({ profile_id: `p_${i}` }));
    const outcome = await enrichDetails(candidates, {
      concurrency: 1,
      isExpired: () => processed >= 3,
      fetchDetail: async () => {
        processed += 1;
        return { ok: true, email: "lead@example.com", raw: null };
      },
    });
    expect(outcome.attempted).toBe(3);
    expect(outcome.timeoutSkipped).toBe(7);
    const reason = detailsStopReason(outcome.timeoutSkipped);
    expect(reason).toBe("soft_timeout");
    expect(statusFromStopReason(reason)).toBe("partial");
  });

  it("completes when nothing is skipped", () => {
    expect(detailsStopReason(0)).toBe("completed");
    expect(statusFromStopReason(detailsStopReason(0))).toBe("ok");
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
  it("fullResetState zeroes cursors + completion flags and points at the first stage", () => {
    const reset = fullResetState();
    expect(reset.last_profiles_cursor).toBeNull();
    expect(reset.last_sessions_cursor).toBeNull();
    expect(reset.profiles_completed).toBe(false);
    expect(reset.details_completed).toBe(false);
    expect(reset.sessions_completed).toBe(false);
    expect(reset.reconcile_completed).toBe(false);
    expect(reset.current_stage).toBe("profiles");
  });

  it("a full reset ignores the saved cursor and restarts at the beginning", () => {
    expect(resolveStartCursor("cursor_abc", true)).toBeUndefined();
  });

  it("nextIncompleteStage walks the pipeline in order", () => {
    expect(nextIncompleteStage({ profiles_completed: false, details_completed: false, sessions_completed: false, reconcile_completed: false })).toBe("profiles");
    expect(nextIncompleteStage({ profiles_completed: true, details_completed: false, sessions_completed: false, reconcile_completed: false })).toBe("profile_details");
    expect(nextIncompleteStage({ profiles_completed: true, details_completed: true, sessions_completed: false, reconcile_completed: false })).toBe("sessions");
    expect(nextIncompleteStage({ profiles_completed: true, details_completed: true, sessions_completed: true, reconcile_completed: false })).toBe("reconcile");
    expect(nextIncompleteStage({ profiles_completed: true, details_completed: true, sessions_completed: true, reconcile_completed: true })).toBeNull();
  });
});

describe("5. profiles_without_email counted correctly", () => {
  it("splits the saved population into with/without email", () => {
    const counts = countEmailCoverage([
      { normalized_email: "a@x.com" },
      { normalized_email: null },
      { normalized_email: "b@x.com" },
      { normalized_email: null },
      { normalized_email: null },
    ]);
    expect(counts.profiles_with_email).toBe(2);
    expect(counts.profiles_without_email).toBe(3);
  });
});

describe("6. profile_details_failed counted correctly", () => {
  it("counts non-ok detail fetches as failures and leaves them unresolved", async () => {
    const candidates = Array.from({ length: 5 }, (_, i) => ({ profile_id: `p_${i}` }));
    const outcome = await enrichDetails(candidates, {
      concurrency: 5,
      isExpired: () => false,
      fetchDetail: async () => ({ ok: false, email: null, raw: null }),
    });
    expect(outcome.attempted).toBe(5);
    expect(outcome.failed).toBe(5);
    expect(outcome.fetched).toBe(0);
    expect(outcome.timeoutSkipped).toBe(0);
  });

  it("uses a list-row email without a network fetch (preResolve)", async () => {
    let fetchCalls = 0;
    const outcome = await enrichDetails([{ profile_id: "p_1" }], {
      concurrency: 1,
      isExpired: () => false,
      preResolve: () => "pre@example.com",
      fetchDetail: async () => {
        fetchCalls += 1;
        return { ok: true, email: null, raw: null };
      },
    });
    expect(fetchCalls).toBe(0);
    expect(outcome.results[0].email).toBe("pre@example.com");
    expect(outcome.fetched).toBe(1);
  });
});

describe("7. profiles_skipped_no_profile_id counted correctly", () => {
  it("drops rows that have no id and counts them", () => {
    const parsed = [
      parseProfileListRow({ id: "p_1" }),
      parseProfileListRow({ created_at: "2026-06-10T00:00:00Z" }), // no id
      parseProfileListRow({ profile_id: "p_2" }),
      parseProfileListRow({}), // no id
    ];
    const { kept, skipped_no_profile_id } = partitionByProfileId(parsed);
    expect(kept).toHaveLength(2);
    expect(skipped_no_profile_id).toBe(2);
  });
});

describe("8. diagnostics fields are derivable", () => {
  it("coverage warnings carry the right human message per stop reason", () => {
    expect(computeCoverageWarning({ stoppedReason: "max_pages_reached", stage: "profiles", hasPendingDetails: false })).toEqual({
      coverage_warning: true,
      coverage_warning_message: "Sync stopped because max_pages was reached while FunnelFox still had more profiles.",
    });
    expect(computeCoverageWarning({ stoppedReason: "soft_timeout", stage: "profile_details", hasPendingDetails: true }).coverage_warning_message).toBe(
      "Sync stopped because soft timeout was reached during profile detail enrichment.",
    );
    expect(computeCoverageWarning({ stoppedReason: "completed", stage: "reconcile", hasPendingDetails: true }).coverage_warning_message).toBe(
      "Profiles without email may be incomplete because detail enrichment did not finish.",
    );
    expect(computeCoverageWarning({ stoppedReason: "completed", stage: "reconcile", hasPendingDetails: false }).coverage_warning).toBe(false);
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
