import { describe, expect, it } from "vitest";
import {
  detailOutcome,
  detailsStageComplete,
  detailsStopReason,
  emailFromProfileDetail,
  enrichDetails,
  isDetailCandidate,
  nextIncompleteStage,
  selectDetailCandidates,
  shouldContinueSync,
  statusFromStopReason,
} from "@/services/funnelfoxLeadsTransform";

describe("extractor finds email from nested paths", () => {
  it("resolves emails from customer / user / preview / nested containers", () => {
    expect(emailFromProfileDetail({ data: { customer: { email: "C@X.com" } } })).toBe("c@x.com");
    expect(emailFromProfileDetail({ customer: { email: "C@X.com" } })).toBe("c@x.com");
    expect(emailFromProfileDetail({ user: { email: "U@X.com" } })).toBe("u@x.com");
    expect(emailFromProfileDetail({ data: { preview: { email: "P@X.com" } } })).toBe("p@x.com");
    expect(emailFromProfileDetail({ contact: { email_address: "K@X.com" } })).toBe("k@x.com");
  });

  it("falls back to a bounded deep walk for unexpected nesting", () => {
    expect(emailFromProfileDetail({ data: { profile: { contact: { email_address: "D@X.com" } } } })).toBe("d@x.com");
  });

  it("returns null only when the payload truly has no email", () => {
    expect(emailFromProfileDetail({ data: { name: "no email here" } })).toBeNull();
    // does not pick up non-email-named fields
    expect(emailFromProfileDetail({ data: { note: "ping support@acme.com" } })).toBeNull();
  });
});

describe("detail candidate selection (rows without email and not yet checked)", () => {
  it("processes only rows with no email and detail_checked falsy", () => {
    const rows = [
      { profile_id: "a", normalized_email: null, detail_checked: false },
      { profile_id: "b", normalized_email: "b@x.com", detail_checked: true },
      { profile_id: "c", normalized_email: null, detail_checked: null }, // legacy null = not checked
      { profile_id: "d", normalized_email: null, detail_checked: true }, // already checked, no email
    ];
    const candidates = selectDetailCandidates(rows);
    expect(candidates.map((r) => r.profile_id)).toEqual(["a", "c"]);
    expect(isDetailCandidate({ normalized_email: null, detail_checked: false })).toBe(true);
    expect(isDetailCandidate({ normalized_email: null, detail_checked: true })).toBe(false);
  });
});

describe("detail outcome classification", () => {
  it("a successful (even email-less) fetch is terminal → marks detail_checked=true", () => {
    expect(detailOutcome(true, 200)).toBe("email_checked");
  });
  it("404/410 are terminal no-email → marks detail_checked=true", () => {
    expect(detailOutcome(false, 404)).toBe("gone_checked");
    expect(detailOutcome(false, 410)).toBe("gone_checked");
  });
  it("transient failures stay unchecked for retry (not permanently marked)", () => {
    expect(detailOutcome(false, 500)).toBe("transient_unchecked");
    expect(detailOutcome(false, 429)).toBe("transient_unchecked");
    expect(detailOutcome(false, 403)).toBe("transient_unchecked");
    expect(detailOutcome(false, 0)).toBe("transient_unchecked");
  });
});

describe("profile_details resumes after timeout (does not advance past unenriched rows)", () => {
  it("a timeout leaves the stage incomplete → next stage is profile_details again, not sessions", async () => {
    let processed = 0;
    const candidates = Array.from({ length: 10 }, (_, i) => ({ profile_id: `p_${i}` }));
    const outcome = await enrichDetails(candidates, {
      concurrency: 1,
      isExpired: () => processed >= 4,
      fetchDetail: async () => {
        processed += 1;
        return { ok: true, email: "lead@example.com", raw: null };
      },
    });
    expect(outcome.timeoutSkipped).toBe(6);
    expect(detailsStopReason(outcome.timeoutSkipped)).toBe("soft_timeout");
    expect(statusFromStopReason(detailsStopReason(outcome.timeoutSkipped))).toBe("partial");

    const remainingUnchecked = outcome.timeoutSkipped; // skipped rows are still unchecked
    expect(detailsStageComplete(outcome.timeoutSkipped, remainingUnchecked)).toBe(false);
    const next = nextIncompleteStage({
      profiles_completed: true,
      details_completed: false,
      sessions_completed: false,
      reconcile_completed: false,
    });
    expect(next).toBe("profile_details");
  });

  it("transient failures (no timeout) still keep the stage incomplete", () => {
    // 0 timed out, but 3 rows still unchecked because their fetches failed transiently
    expect(detailsStageComplete(0, 3)).toBe(false);
    // only a fully-drained queue completes
    expect(detailsStageComplete(0, 0)).toBe(true);
  });
});

describe("Continue Sync keeps processing the detail stage until remaining unchecked = 0", () => {
  it("loops while progress is made and stops exactly when the pipeline completes", () => {
    // Simulated sequence of Edge responses across Continue Sync calls.
    const responses = [
      { status: "partial", all_stages_completed: false, made_progress: true, summary: { remaining_detail_unchecked: 6 } },
      { status: "partial", all_stages_completed: false, made_progress: true, summary: { remaining_detail_unchecked: 2 } },
      { status: "ok", all_stages_completed: true, made_progress: true, summary: { remaining_detail_unchecked: 0 } },
    ];
    const consumed: number[] = [];
    for (const res of responses) {
      consumed.push(res.summary.remaining_detail_unchecked);
      if (!shouldContinueSync(res)) break;
    }
    expect(consumed).toEqual([6, 2, 0]); // ran every step, stopped at completion
  });

  it("stops early when a run stalls (no progress) instead of hammering the API", () => {
    expect(shouldContinueSync({ status: "partial", all_stages_completed: false, made_progress: true })).toBe(true);
    expect(shouldContinueSync({ status: "partial", all_stages_completed: false, made_progress: false })).toBe(false);
    expect(shouldContinueSync({ status: "error", all_stages_completed: false, made_progress: true })).toBe(false);
    expect(shouldContinueSync({ status: "ok", all_stages_completed: true, made_progress: true })).toBe(false);
  });
});
