import { describe, expect, it } from "vitest";
import {
  SYNC_STAGES,
  nextIncompleteStage,
  parseSyncStage,
  shouldContinueSync,
} from "@/services/funnelfoxLeadsTransform";

// The FunnelFox /profiles/{id} detail payload carries no email (live probe 2026-10-06: keys id,
// created_at, funnel_id, preview, integrations — no `@` in any of 37 stored payloads). The email
// enrichment stage that called it is gone; emails come only from the profile LIST row.

describe("no profile-detail enrichment stage", () => {
  it("the pipeline is profiles → sessions → reconcile", () => {
    expect(SYNC_STAGES).toEqual(["profiles", "sessions", "reconcile"]);
    const seen = new Set<string>();
    for (const profiles of [false, true]) {
      for (const sessions of [false, true]) {
        for (const reconcile of [false, true]) {
          const next = nextIncompleteStage({ profiles_completed: profiles, sessions_completed: sessions, reconcile_completed: reconcile });
          if (next) seen.add(next);
        }
      }
    }
    expect([...seen].sort()).toEqual(["profiles", "reconcile", "sessions"]);
  });

  it("an old client asking for stage=profile_details gets the next incomplete stage instead", () => {
    expect(parseSyncStage("profile_details")).toBeNull();
    expect(parseSyncStage(" Sessions ")).toBe("sessions");
    expect(parseSyncStage("reconcile")).toBe("reconcile");
    expect(parseSyncStage(undefined)).toBeNull();
  });
});

describe("Continue Sync keeps processing stages until the pipeline completes", () => {
  it("loops while progress is made and stops exactly when the pipeline completes", () => {
    // Simulated sequence of Edge responses across Continue Sync calls.
    const responses = [
      { status: "partial", all_stages_completed: false, made_progress: true, stage: "profiles" },
      { status: "partial", all_stages_completed: false, made_progress: true, stage: "sessions" },
      { status: "ok", all_stages_completed: true, made_progress: true, stage: "reconcile" },
    ];
    const consumed: string[] = [];
    for (const res of responses) {
      consumed.push(res.stage);
      if (!shouldContinueSync(res)) break;
    }
    expect(consumed).toEqual(["profiles", "sessions", "reconcile"]);
  });

  it("stops early when a run stalls (no progress) instead of hammering the API", () => {
    expect(shouldContinueSync({ status: "partial", all_stages_completed: false, made_progress: true })).toBe(true);
    expect(shouldContinueSync({ status: "partial", all_stages_completed: false, made_progress: false })).toBe(false);
    expect(shouldContinueSync({ status: "error", all_stages_completed: false, made_progress: true })).toBe(false);
    expect(shouldContinueSync({ status: "ok", all_stages_completed: true, made_progress: true })).toBe(false);
  });

  it("stops on the quiet answers: idle, busy (another call holds the lease) and rate-limited", () => {
    expect(shouldContinueSync({ status: "ok", all_stages_completed: true, made_progress: false })).toBe(false); // idle
    expect(shouldContinueSync({ status: "busy", all_stages_completed: false, made_progress: false })).toBe(false);
    expect(shouldContinueSync({ status: "partial", all_stages_completed: false, made_progress: false })).toBe(false); // 429 backoff
  });
});
