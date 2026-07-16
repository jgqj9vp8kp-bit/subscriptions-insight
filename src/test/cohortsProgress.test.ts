import { describe, expect, it } from "vitest";
import {
  computeActivePercent,
  estimateWaitingProgress,
  INITIAL_PROGRESS,
  median,
  progressReducer,
  PROGRESS_WAIT_CAP,
  type ProgressState,
} from "@/services/analyticsProgress";

describe("cohorts progress — honest staged estimate", () => {
  it("#20 estimated waiting progress caps below completion, even on cold start", () => {
    expect(estimateWaitingProgress(0, 3000)).toBeCloseTo(15, 5);
    expect(estimateWaitingProgress(10_000, 3000)).toBeLessThan(PROGRESS_WAIT_CAP);
    // absurd cold start still never reaches the cap (or 100)
    expect(estimateWaitingProgress(10_000_000, 3000)).toBeLessThanOrEqual(PROGRESS_WAIT_CAP);
    expect(estimateWaitingProgress(10_000_000, 3000)).toBeLessThan(100);
  });

  it("#19 active percent is monotonic non-decreasing in elapsed time", () => {
    let prev = -1;
    for (let t = 0; t <= 20_000; t += 137) {
      const p = computeActivePercent(t, 3000);
      expect(p).toBeGreaterThanOrEqual(prev);
      expect(p).toBeLessThanOrEqual(PROGRESS_WAIT_CAP);
      prev = p;
    }
  });

  it("#18 reducer never reaches 100 while waiting; only a success for the active key completes", () => {
    let s: ProgressState = INITIAL_PROGRESS;
    s = progressReducer(s, { type: "start", key: "A", now: 0 });
    for (let t = 120; t <= 30_000; t += 120) s = progressReducer(s, { type: "tick", now: t, medianMs: 2000 });
    expect(s.percent).toBeLessThan(100);
    expect(s.percent).toBeLessThanOrEqual(PROGRESS_WAIT_CAP);
    s = progressReducer(s, { type: "success", key: "A" });
    expect(s.percent).toBe(100);
    expect(s.phase).toBe("done");
  });

  it("#19 reducer ticks never decrease the percent", () => {
    let s: ProgressState = progressReducer(INITIAL_PROGRESS, { type: "start", key: "A", now: 0 });
    let prev = s.percent;
    for (let t = 120; t <= 15_000; t += 120) {
      s = progressReducer(s, { type: "tick", now: t, medianMs: 2500 });
      expect(s.percent).toBeGreaterThanOrEqual(prev);
      prev = s.percent;
    }
  });

  it("#22 a cancelled/settled request does NOT complete the bar", () => {
    let s: ProgressState = progressReducer(INITIAL_PROGRESS, { type: "start", key: "A", now: 0 });
    s = progressReducer(s, { type: "tick", now: 1000, medianMs: 2000 });
    s = progressReducer(s, { type: "settle" });
    expect(s.percent).not.toBe(100);
    expect(s.phase).toBe("idle");
  });

  it("#22 a success for a SUPERSEDED key cannot complete the current bar", () => {
    let s: ProgressState = progressReducer(INITIAL_PROGRESS, { type: "start", key: "A", now: 0 });
    // request superseded → a new request B starts
    s = progressReducer(s, { type: "start", key: "B", now: 500 });
    // the stale A resolves — must be ignored
    s = progressReducer(s, { type: "success", key: "A" });
    expect(s.percent).not.toBe(100);
    expect(s.phase).toBe("loading");
    // the current B completing DOES finish the bar
    s = progressReducer(s, { type: "success", key: "B" });
    expect(s.percent).toBe(100);
  });

  it("start resets the ramp for a fresh request (not a backwards move within a request)", () => {
    let s: ProgressState = progressReducer(INITIAL_PROGRESS, { type: "start", key: "A", now: 0 });
    for (let t = 120; t <= 6000; t += 120) s = progressReducer(s, { type: "tick", now: t, medianMs: 2000 });
    const high = s.percent;
    expect(high).toBeGreaterThan(20);
    s = progressReducer(s, { type: "start", key: "B", now: 7000 });
    expect(s.percent).toBeLessThan(high); // fresh request restarts low
    expect(s.phase).toBe("loading");
  });

  it("median helper handles empty + odd + even sample sets", () => {
    expect(median([])).toBeGreaterThan(0); // default guess
    expect(median([1000])).toBe(1000);
    expect(median([3000, 1000, 2000])).toBe(2000);
    expect(median([1000, 2000, 3000, 5000])).toBe(2500);
  });
});
